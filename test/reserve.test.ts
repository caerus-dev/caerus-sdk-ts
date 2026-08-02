import { status as GrpcStatus } from '@grpc/grpc-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaerusClient } from '../src/client.js';
import { CaerusError, ConflictError, ValidationError } from '../src/errors.js';
import { aHolderResponse, startFakeEngine, type FakeEngine } from './helpers/fake-engine.js';

describe('reserve', () => {
  let engine: FakeEngine;
  let caerus: CaerusClient;
  /** Which methods the engine saw, in order. */
  let seen: string[];

  beforeAll(async () => {
    engine = await startFakeEngine();
  });

  afterAll(async () => {
    caerus?.close();
    await engine.stop();
  });

  beforeEach(() => {
    engine.reset();
    seen = [];
    for (const method of ['take', 'confirm', 'release'] as const) {
      engine.on(method, (call, callback) => {
        seen.push(method);
        callback(null, method === 'release' ? {} : aHolderResponse());
      });
    }

    caerus?.close();
    caerus = new CaerusClient({
      endpoint: engine.endpoint,
      apiKey: 'no-es-una-clave',
      tls: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- The happy path --------------------------------------------------------------

  it('takes, runs the work, and confirms', async () => {
    const ran: string[] = [];

    await caerus.reserve('seat_A12', async () => {
      ran.push('work');
    });

    expect(seen).toEqual(['take', 'confirm']);
    expect(ran).toEqual(['work']);
  });

  it('runs the work only after the units are held', async () => {
    const order: string[] = [];
    engine.on('take', (_call, callback) => {
      order.push('take');
      callback(null, aHolderResponse());
    });

    await caerus.reserve('seat_A12', async () => {
      order.push('work');
    });

    expect(order).toEqual(['take', 'work']);
  });

  it('hands the reservation to the work', async () => {
    engine.on('take', (_call, callback) =>
      callback(null, aHolderResponse({ holderId: 'hld-42', amount: 1 })),
    );

    const id = await caerus.reserve('seat_A12', (reservation) => reservation.id);

    expect(id).toBe('hld-42');
  });

  it('returns whatever the work returned', async () => {
    const result = await caerus.reserve('seat_A12', async () => ({ ticket: 'T-1' }));

    expect(result).toEqual({ ticket: 'T-1' });
  });

  it('accepts work that is not asynchronous', async () => {
    expect(await caerus.reserve('seat_A12', () => 7)).toBe(7);
    expect(seen).toEqual(['take', 'confirm']);
  });

  it('asks for one unit', async () => {
    await caerus.reserve('seat_A12', () => undefined);

    expect(engine.lastMethod).toBe('confirm');
  });

  it('passes the take options through', async () => {
    let takeRequest: unknown;
    engine.on('take', (call, callback) => {
      takeRequest = call.request;
      callback(null, aHolderResponse());
    });

    await caerus.reserve('seat_A12', () => undefined, {
      idempotencyKey: 'order-1',
      ttlSeconds: 60,
    });

    expect(takeRequest).toMatchObject({
      amount: 1,
      settings: { idempotencyKey: 'order-1', customTtlSeconds: 60 },
    });
  });

  // --- The error path, which is the reason this method exists ----------------------

  it('releases when the work throws', async () => {
    const boom = new Error('card declined');

    await expect(
      caerus.reserve('seat_A12', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(seen).toEqual(['take', 'release']);
  });

  /** The caller's error is the one that explains what happened. It must survive. */
  it('propagates the original error, not one of its own', async () => {
    class PaymentDeclined extends Error {
      readonly reason = 'insufficient_funds';
    }
    const original = new PaymentDeclined('card declined');

    const thrown = await caerus
      .reserve('seat_A12', async () => {
        throw original;
      })
      .catch((error: unknown) => error);

    expect(thrown).toBe(original);
    expect(thrown).toBeInstanceOf(PaymentDeclined);
    expect((thrown as PaymentDeclined).reason).toBe('insufficient_funds');
  });

  it('never confirms a reservation whose work failed', async () => {
    await caerus.reserve('seat_A12', () => Promise.reject(new Error('nope'))).catch(() => {});

    expect(seen).not.toContain('confirm');
  });

  /**
   * The case the handoff calls out: if the release also fails, the caller still gets
   * their own error. Losing it would leave them staring at a message about bookkeeping.
   */
  it('keeps the original error when the release fails too', async () => {
    const original = new Error('card declined');
    engine.on('release', (_call, callback) =>
      callback({
        code: GrpcStatus.INTERNAL,
        details: 'Unexpected gRPC error',
        metadata: undefined,
      } as never),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const thrown = await caerus
      .reserve('seat_A12', async () => {
        throw original;
      })
      .catch((error: unknown) => error);

    expect(thrown).toBe(original);
    // and the release failure is not silent
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/could not release/i);
  });

  it('propagates a failure to confirm', async () => {
    engine.on('confirm', (_call, callback) =>
      callback({
        code: GrpcStatus.FAILED_PRECONDITION,
        details: 'Holder already released',
        metadata: undefined,
      } as never),
    );

    const thrown = await caerus.reserve('seat_A12', () => 'done').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as CaerusError).message).toBe('Holder already released');
  });

  it('does not swallow a failure to take', async () => {
    let ran = false;
    engine.on('take', (_call, callback) =>
      callback({
        code: GrpcStatus.FAILED_PRECONDITION,
        details: 'Not enough stock',
        metadata: undefined,
      } as never),
    );

    const thrown = await caerus
      .reserve('seat_A12', () => {
        ran = true;
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConflictError);
    expect(ran).toBe(false);
    expect(seen).not.toContain('release');
  });

  // --- Queued reservations hold nothing --------------------------------------------

  /**
   * Running the work here would charge a card for a seat the caller does not have.
   */
  it('refuses to run the work on a queued reservation', async () => {
    let ran = false;
    engine.on('take', (_call, callback) => {
      seen.push('take');
      callback(null, aHolderResponse({ status: 4 }));
    });

    const thrown = await caerus
      .reserve('seat_A12', () => {
        ran = true;
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as CaerusError).message).toMatch(/queued/i);
    expect(ran).toBe(false);
    expect(seen).toEqual(['take']);
  });

  it('points at take for anyone who wants to handle queueing', async () => {
    engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status: 4 })));

    await expect(caerus.reserve('seat_A12', () => undefined)).rejects.toThrow(/take\(\)/);
  });

  // --- reserveMany -----------------------------------------------------------------

  describe('reserveMany', () => {
    it('asks for the amount it was given', async () => {
      let takeRequest: { amount?: number } = {};
      engine.on('take', (call, callback) => {
        takeRequest = call.request;
        seen.push('take');
        callback(null, aHolderResponse({ amount: 4 }));
      });

      await caerus.reserveMany('general_admission', 4, () => undefined);

      expect(takeRequest.amount).toBe(4);
      expect(seen).toEqual(['take', 'confirm']);
    });

    it('releases on failure just the same', async () => {
      const boom = new Error('nope');

      await expect(
        caerus.reserveMany('general_admission', 4, () => Promise.reject(boom)),
      ).rejects.toBe(boom);

      expect(seen).toEqual(['take', 'release']);
    });

    it.each([0, -2])('refuses an amount of %s without taking anything', async (amount) => {
      await expect(
        caerus.reserveMany('general_admission', amount, () => undefined),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(seen).toEqual([]);
    });
  });

  it('says so when given something that is not a function', async () => {
    await expect(caerus.reserve('seat_A12', undefined as never)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
