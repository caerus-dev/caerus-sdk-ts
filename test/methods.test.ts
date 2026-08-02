import { status as GrpcStatus } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CaerusClient } from '../src/client.js';
import {
  CaerusError,
  ConflictError,
  OutOfStockError,
  ValidationError,
} from '../src/errors.js';
import {
  aHolderResponse,
  aResourceResponse,
  startFakeEngine,
  type FakeEngine,
} from './helpers/fake-engine.js';

describe('the business methods', () => {
  let engine: FakeEngine;
  let caerus: CaerusClient;

  beforeAll(async () => {
    engine = await startFakeEngine();
  });

  afterAll(async () => {
    caerus?.close();
    await engine.stop();
  });

  beforeEach(() => {
    engine.reset();
    caerus?.close();
    caerus = new CaerusClient({
      endpoint: engine.endpoint,
      apiKey: 'no-es-una-clave',
      tls: false,
    });
  });

  // --- take and takeMany ---------------------------------------------------------

  describe('take', () => {
    it('asks for exactly one unit', async () => {
      await caerus.take('seat_A12');

      expect(engine.lastMethod).toBe('take');
      expect(engine.lastRequest.resourceKey).toBe('seat_A12');
      expect(engine.lastRequest.amount).toBe(1);
    });

    it('passes the options through', async () => {
      await caerus.take('seat_A12', {
        idempotencyKey: 'order-99',
        ttlSeconds: 120,
        metadata: { orderId: '12345' },
      });

      expect(engine.lastRequest.settings).toMatchObject({
        idempotencyKey: 'order-99',
        customTtlSeconds: 120,
      });
    });

    it('rejects an empty resource key before calling', async () => {
      await expect(caerus.take('  ')).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a non-positive ttl', async () => {
      await expect(caerus.take('seat_A12', { ttlSeconds: 0 })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('takeMany', () => {
    it('asks for the amount it was given', async () => {
      await caerus.takeMany('general_admission', 4);

      expect(engine.lastRequest.resourceKey).toBe('general_admission');
      expect(engine.lastRequest.amount).toBe(4);
    });

    it.each([0, -1])('refuses an amount of %s', async (amount) => {
      await expect(caerus.takeMany('general_admission', amount)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  // --- Decision G: what each status does -----------------------------------------

  describe('the status of a reservation', () => {
    /**
     * The trap this closes: no exception was thrown, so a caller assumes they hold the
     * seat. They do not.
     */
    it('throws when the engine reports FAILED', async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status: 3 })));

      const error = await caerus.take('seat_A12').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as CaerusError).message).toMatch(/FAILED/);
    });

    /** QUEUED is real, just not yours yet. The caller decides what to do about it. */
    it('returns a QUEUED reservation with the status visible', async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status: 4 })));

      const reservation = await caerus.take('seat_A12');

      expect(reservation.status).toBe('QUEUED');
      expect(reservation.id).toBe('hld-1');
    });

    it('returns PENDING on the happy path', async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status: 0 })));

      expect((await caerus.take('seat_A12')).status).toBe('PENDING');
    });

    /** Asking what state something is in and being told FAILED is an answer. */
    it('does not throw when a query finds a FAILED reservation', async () => {
      engine.on('getResourceHolder', (_call, callback) =>
        callback(null, aHolderResponse({ status: 3 })),
      );

      expect((await caerus.getReservation('hld-1')).status).toBe('FAILED');
    });

    it('refuses to guess at a status it does not know', async () => {
      // 99 is deliberately outside the enum: a newer server sending a status this
      // version has no name for.
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ status: 99 as never })),
      );

      await expect(caerus.take('seat_A12')).rejects.toThrow(/unknown status/i);
    });
  });

  // --- metadata as an object, both ways ------------------------------------------

  describe('metadata', () => {
    it('goes out as JSON text', async () => {
      await caerus.take('seat_A12', { metadata: { orderId: '12345', items: 2 } });

      expect(engine.lastRequest.settings.metadata).toBe('{"orderId":"12345","items":2}');
    });

    /** Not "{\"orderId\":\"12345\"}" as a string — an object. */
    it('comes back as an object', async () => {
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ metadata: '{"orderId":"12345","items":2}' })),
      );

      const reservation = await caerus.take('seat_A12');

      expect(reservation.metadata).toEqual({ orderId: '12345', items: 2 });
      expect(typeof reservation.metadata).toBe('object');
    });

    it('survives a round trip unchanged', async () => {
      const sent = { orderId: '12345', nested: { seat: 'A12' }, count: 3 };
      engine.on('take', (call, callback) =>
        callback(null, aHolderResponse({ metadata: call.request.settings.metadata })),
      );

      const reservation = await caerus.take('seat_A12', { metadata: sent });

      expect(reservation.metadata).toEqual(sent);
    });

    it.each([undefined, ''])('reads %p as no metadata at all', async (raw) => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ metadata: raw })));

      expect((await caerus.take('seat_A12')).metadata).toBeUndefined();
    });

    /**
     * The engine does not check that metadata is JSON, only whether the template allows
     * any. Another client can store plain text. Returning undefined would read as "there
     * was none", which is the more expensive mistake.
     */
    it('complains loudly about metadata that is not JSON', async () => {
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ metadata: 'not json at all' })),
      );

      await expect(caerus.take('seat_A12')).rejects.toThrow(/not a JSON object/);
    });

    it('sends nothing when none was given', async () => {
      await caerus.take('seat_A12');

      expect(engine.lastRequest.settings.metadata).toBeUndefined();
    });
  });

  // --- expiresAt: seconds on the wire, Date in the API ---------------------------

  describe('expiresAt', () => {
    /** 1970 and the year 55000 are the two symptoms of getting this wrong. */
    it('turns epoch seconds into the matching Date', async () => {
      const epochSeconds = Math.floor(Date.parse('2026-08-02T15:00:00Z') / 1000);
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ expiresAt: epochSeconds })),
      );

      const reservation = await caerus.take('seat_A12');

      expect(reservation.expiresAt).toBeInstanceOf(Date);
      expect(reservation.expiresAt.toISOString()).toBe('2026-08-02T15:00:00.000Z');
    });

    it('does not land in 1970', async () => {
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ expiresAt: 1_785_164_400 })),
      );

      const year = (await caerus.take('seat_A12')).expiresAt.getUTCFullYear();

      expect(year).toBeGreaterThan(2020);
      expect(year).toBeLessThan(2100);
    });
  });

  // --- The rest of the methods ---------------------------------------------------

  describe('createResource', () => {
    it('sends what the engine needs and returns a resource', async () => {
      engine.on('createResource', (_call, callback) =>
        callback(null, aResourceResponse({ key: 'seat_A12', availableAmount: 5 })),
      );

      const resource = await caerus.createResource('seat', 'seat_A12', 5, {
        groupKey: 'row_A',
        metadata: { zone: 'platea' },
      });

      expect(engine.lastRequest).toMatchObject({
        templateName: 'seat',
        key: 'seat_A12',
        availableAmount: 5,
        groupKey: 'row_A',
        metadata: '{"zone":"platea"}',
      });
      expect(resource.key).toBe('seat_A12');
      expect(resource.availableAmount).toBe(5);
      expect(resource.templateId).toBe('tpl-1');
    });

    it.each([0, -3])('refuses an amount of %s', async (amount) => {
      await expect(caerus.createResource('seat', 'seat_A12', amount)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('confirm', () => {
    it('sends the metadata patch as JSON text', async () => {
      await caerus.confirm('hld-1', { metadata: { paymentId: 'pay_9' } });

      expect(engine.lastMethod).toBe('confirm');
      expect(engine.lastRequest).toMatchObject({
        resourceHolderId: 'hld-1',
        metadataPatch: '{"paymentId":"pay_9"}',
      });
    });
  });

  describe('release', () => {
    it('resolves with nothing', async () => {
      const result = await caerus.release('hld-1');

      expect(result).toBeUndefined();
      expect(engine.lastRequest.resourceHolderId).toBe('hld-1');
    });
  });

  describe('extend', () => {
    /** Seconds, after the contract fix. Sending 300 used to add one second. */
    it('sends the extension in seconds', async () => {
      await caerus.extend('hld-1', 300);

      expect(engine.lastRequest).toMatchObject({ resourceHolderId: 'hld-1', extraSeconds: 300 });
    });

    it.each([0, -30])('refuses %s seconds without calling', async (seconds) => {
      engine.on('extend', () => {
        throw new Error('should not have been called');
      });

      await expect(caerus.extend('hld-1', seconds)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('the queries', () => {
    it('reads a resource', async () => {
      engine.on('getResource', (_call, callback) =>
        callback(null, aResourceResponse({ key: 'seat_A12', pendingCount: 2 })),
      );

      const resource = await caerus.getResource('seat_A12');

      expect(engine.lastRequest.key).toBe('seat_A12');
      expect(resource.pendingCount).toBe(2);
    });

    it('reads a page of a group and says whether there is another', async () => {
      engine.on('getResourcesByGroupKey', (_call, callback) =>
        callback(null, {
          resources: [aResourceResponse({ key: 'seat_A12' }), aResourceResponse({ key: 'seat_A13' })],
          nextPage: true,
        }),
      );

      const page = await caerus.getResourcesByGroup('row_A', { page: 2, pageSize: 10 });

      expect(engine.lastRequest).toMatchObject({ groupKey: 'row_A', page: 2, pageSize: 10 });
      expect(page.resources.map((resource) => resource.key)).toEqual(['seat_A12', 'seat_A13']);
      expect(page.hasNextPage).toBe(true);
    });

    it('starts at the first page when none is asked for', async () => {
      await caerus.getResourcesByGroup('row_A');

      expect(engine.lastRequest.page).toBe(0);
    });

    it('reads a reservation', async () => {
      engine.on('getResourceHolder', (_call, callback) =>
        callback(null, aHolderResponse({ holderId: 'hld-7', status: 1 })),
      );

      const reservation = await caerus.getReservation('hld-7');

      expect(engine.lastRequest.resourceHolderId).toBe('hld-7');
      expect(reservation.status).toBe('CONFIRMED');
    });
  });

  // --- Errors still arrive translated --------------------------------------------

  it('translates a server error the same way through a business method', async () => {
    engine.on('getResource', (_call, callback) =>
      callback({
        code: GrpcStatus.FAILED_PRECONDITION,
        details: 'Holder already confirmed',
        metadata: undefined,
      } as never),
    );

    const error = await caerus.getResource('seat_A12').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as CaerusError).message).toBe('Holder already confirmed');
  });

  /**
   * Found by running the SDK against a real engine: OutOfStockException had no handler
   * in GrpcGlobalExceptionHandler, so the most important answer this product gives —
   * "there is none left" — reached the client as INTERNAL "Unexpected gRPC error".
   *
   * The engine now answers RESOURCE_EXHAUSTED, and this is the SDK side of that.
   */
  describe('running out of stock', () => {
    function outOfStock(_call: unknown, callback: (error: unknown) => void): void {
      callback({
        code: GrpcStatus.RESOURCE_EXHAUSTED,
        details: 'Out of stock for resource: seat_A12',
        metadata: undefined,
      });
    }

    it('arrives as OutOfStockError', async () => {
      engine.on('take', outOfStock as never);

      const error = await caerus.take('seat_A12').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OutOfStockError);
      expect((error as CaerusError).code).toBe('OUT_OF_STOCK');
      expect((error as CaerusError).message).toBe('Out of stock for resource: seat_A12');
    });

    /** Additive by design: code that only knew about ConflictError keeps working. */
    it('is still a ConflictError', async () => {
      engine.on('take', outOfStock as never);

      const error = await caerus.take('seat_A12').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toBeInstanceOf(CaerusError);
    });

    it('reaches takeMany the same way', async () => {
      engine.on('take', outOfStock as never);

      await expect(caerus.takeMany('general_admission', 4)).rejects.toBeInstanceOf(
        OutOfStockError,
      );
    });

    it('is no longer an opaque internal error', async () => {
      engine.on('take', outOfStock as never);

      const error = await caerus.take('seat_A12').catch((caught: unknown) => caught);

      expect((error as CaerusError).code).not.toBe('UNKNOWN');
      expect((error as CaerusError).message).not.toBe('Unexpected gRPC error');
    });
  });
});
