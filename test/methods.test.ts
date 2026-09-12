import { status as GrpcStatus } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CaerusClient } from '../src/client.js';
import { CaerusError, ConflictError, ValidationError } from '../src/errors.js';
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
      await caerus.unitary('seat_A12').take();

      expect(engine.lastMethod).toBe('take');
      expect(engine.lastRequest.resourceKey).toBe('seat_A12');
      expect(engine.lastRequest.amount).toBe(1);
    });

    it('passes the options through', async () => {
      await caerus.unitary('seat_A12').take({
        idempotencyKey: 'order-99',
        ttlSeconds: 120,
        metadata: { orderId: '12345' },
      });

      expect(engine.lastRequest.settings).toMatchObject({
        idempotencyKey: 'order-99',
        customTtlSeconds: 120,
      });
    });

    /** The handle validates its key when it is built, so the mistake surfaces there. */
    it('refuses to build a handle without a key', () => {
      expect(() => caerus.unitary('  ')).toThrow(ValidationError);
      expect(() => caerus.pooled('')).toThrow(ValidationError);
    });

    it('rejects a non-positive ttl', async () => {
      await expect(caerus.unitary('seat_A12').take({ ttlSeconds: 0 })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('takeMany', () => {
    it('asks for the amount it was given', async () => {
      await caerus.pooled('general_admission').takeMany(4);

      expect(engine.lastRequest.resourceKey).toBe('general_admission');
      expect(engine.lastRequest.amount).toBe(4);
    });

    it.each([0, -1])('refuses an amount of %s', async (amount) => {
      await expect(caerus.pooled('general_admission').takeMany(amount)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  // --- Decision G: what each status does -----------------------------------------

  describe('the status of a holder', () => {
    /**
     * The trap this closes: no exception was thrown, so a caller assumes they hold the
     * seat. They do not.
     */
    it('throws when the engine reports EXPIRED', async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status: 4 })));

      const error = await caerus.unitary('seat_A12').take().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as CaerusError).message).toMatch(/EXPIRED/);
    });

    /** QUEUED is real, just not yours yet. The caller decides what to do about it. */
    it('returns a QUEUED holder with the status visible', async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status: 3 })));

      const holder = await caerus.unitary('seat_A12').take();

      expect(holder.status).toBe('QUEUED');
      expect(holder.id).toBe('hld-1');
    });

    it('returns PENDING on the happy path', async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status: 0 })));

      expect((await caerus.unitary('seat_A12').take()).status).toBe('PENDING');
    });

    /** Asking what state something is in and being told EXPIRED is an answer. */
    it('does not throw when a query finds an EXPIRED holder', async () => {
      engine.on('getResourceHolder', (_call, callback) =>
        callback(null, aHolderResponse({ status: 4 })),
      );

      expect((await caerus.getResourceHolder('hld-1')).status).toBe('EXPIRED');
    });

    it('refuses to guess at a status it does not know', async () => {
      // 99 is deliberately outside the enum: a newer server sending a status this
      // version has no name for.
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ status: 99 as never })),
      );

      await expect(caerus.unitary('seat_A12').take()).rejects.toThrow(/unknown status/i);
    });
  });

  // --- metadata as an object, both ways ------------------------------------------

  describe('metadata', () => {
    it('goes out as JSON text', async () => {
      await caerus.unitary('seat_A12').take({ metadata: { orderId: '12345', items: 2 } });

      expect(engine.lastRequest.settings.metadata).toBe('{"orderId":"12345","items":2}');
    });

    /** Not "{\"orderId\":\"12345\"}" as a string — an object. */
    it('comes back as an object', async () => {
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ metadata: '{"orderId":"12345","items":2}' })),
      );

      const holder = await caerus.unitary('seat_A12').take();

      expect(holder.metadata).toEqual({ orderId: '12345', items: 2 });
      expect(typeof holder.metadata).toBe('object');
    });

    it('survives a round trip unchanged', async () => {
      const sent = { orderId: '12345', nested: { seat: 'A12' }, count: 3 };
      engine.on('take', (call, callback) =>
        callback(null, aHolderResponse({ metadata: call.request.settings.metadata })),
      );

      const holder = await caerus.unitary('seat_A12').take({ metadata: sent });

      expect(holder.metadata).toEqual(sent);
    });

    it.each([undefined, ''])('reads %p as no metadata at all', async (raw) => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ metadata: raw })));

      expect((await caerus.unitary('seat_A12').take()).metadata).toBeUndefined();
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

      await expect(caerus.unitary('seat_A12').take()).rejects.toThrow(/not a JSON object/);
    });

    it('sends nothing when none was given', async () => {
      await caerus.unitary('seat_A12').take();

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

      const holder = await caerus.unitary('seat_A12').take();

      expect(holder.expiresAt).toBeInstanceOf(Date);
      expect(holder.expiresAt.toISOString()).toBe('2026-08-02T15:00:00.000Z');
    });

    it('does not land in 1970', async () => {
      engine.on('take', (_call, callback) =>
        callback(null, aHolderResponse({ expiresAt: 1_785_164_400 })),
      );

      const year = (await caerus.unitary('seat_A12').take()).expiresAt.getUTCFullYear();

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

      const resource = await caerus.createMultiple('seat', 'seat_A12', 5, {
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
      await expect(caerus.createMultiple('seat', 'seat_A12', amount)).rejects.toBeInstanceOf(
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
    /** Milliseconds, which is what the contract asks for — unlike ttlSeconds. */
    it('sends the extension in milliseconds', async () => {
      await caerus.extend('hld-1', 300_000);

      expect(engine.lastRequest).toMatchObject({ resourceHolderId: 'hld-1', extraMs: 300_000 });
    });

    it.each([0, -30])('refuses %s without calling', async (seconds) => {
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

    it('lists holders and says whether there is another page', async () => {
      engine.on('getResourceHoldersList', (_call, callback) =>
        callback(null, {
          resourceHolders: [
            aHolderResponse({ holderId: 'hld-1' }),
            aHolderResponse({ holderId: 'hld-2' }),
          ],
          nextPage: true,
        }),
      );

      const page = await caerus.listResourceHolders({
        resourceKey: 'seat_A12',
        status: 'PENDING',
        page: 1,
        pageSize: 5,
      });

      expect(engine.lastRequest).toMatchObject({
        resourceKey: 'seat_A12',
        page: 1,
        pageSize: 5,
        statusFilter: 0, // PENDING on the wire
      });
      expect(page.holders.map((holder) => holder.id)).toEqual(['hld-1', 'hld-2']);
      expect(page.hasNextPage).toBe(true);
    });

    it('lists newest first unless asked for the other order', async () => {
      await caerus.listResourceHolders();
      expect(engine.lastRequest).toMatchObject({ page: 0, createdAtSortDirection: 0 }); // DESCENDING

      await caerus.listResourceHolders({ sort: 'OLDEST_FIRST' });
      expect(engine.lastRequest.createdAtSortDirection).toBe(1); // ASCENDING
    });

    it('leaves the status filter out when none is asked for', async () => {
      await caerus.listResourceHolders({ resourceKey: 'seat_A12' });

      expect(engine.lastRequest.statusFilter).toBeUndefined();
    });

    it('reads a holder', async () => {
      engine.on('getResourceHolder', (_call, callback) =>
        callback(null, aHolderResponse({ holderId: 'hld-7', status: 1 })),
      );

      const holder = await caerus.getResourceHolder('hld-7');

      expect(engine.lastRequest.resourceHolderId).toBe('hld-7');
      expect(holder.status).toBe('CONFIRMED');
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
   * Found by running the SDK against a real engine: OutOfStockException extended
   * RuntimeException, so no handler caught it and the most important answer this product
   * gives — "there is none left" — reached the client as INTERNAL "Unexpected gRPC
   * error", with nothing to act on.
   *
   * It now extends IllegalStateException, so the engine answers FAILED_PRECONDITION.
   * That makes it a ConflictError here, indistinguishable from any other invalid state —
   * a known limitation, and still far better than an opaque internal failure.
   */
  describe('running out of stock', () => {
    function outOfStock(_call: unknown, callback: (error: unknown) => void): void {
      callback({
        code: GrpcStatus.FAILED_PRECONDITION,
        details: 'Out of stock for resource: seat_A12',
        metadata: undefined,
      });
    }

    it('arrives as a ConflictError carrying the engine message', async () => {
      engine.on('take', outOfStock as never);

      const error = await caerus.unitary('seat_A12').take().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as CaerusError).code).toBe('CONFLICT');
      expect((error as CaerusError).message).toBe('Out of stock for resource: seat_A12');
    });

    it('is no longer an opaque internal error', async () => {
      engine.on('take', outOfStock as never);

      const error = await caerus.unitary('seat_A12').take().catch((caught: unknown) => caught);

      expect((error as CaerusError).code).not.toBe('UNKNOWN');
      expect((error as CaerusError).message).not.toBe('Unexpected gRPC error');
    });

    it('reaches takeMany the same way', async () => {
      engine.on('take', outOfStock as never);

      await expect(caerus.pooled('general_admission').takeMany(4)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });
  });

  describe('updateResource and deleteResource', () => {
    it('sends updateResource request correctly', async () => {
      let receivedRequest: Record<string, unknown> | undefined;
      engine.on('updateResource', (call, callback) => {
        receivedRequest = call.request as Record<string, unknown>;
        callback(
          null,
          aResourceResponse({
            key: 'general_admission',
            availableAmount: 150,
            groupKey: 'main_hall',
            metadata: '',
          }),
        );
      });

      const resource = await caerus.updateResource('general_admission', 50, { groupKey: 'main_hall' });

      expect(receivedRequest).toMatchObject({
        resourceKey: 'general_admission',
        deltaAmount: 50,
        groupKey: 'main_hall',
      });
      expect(resource.availableAmount).toBe(150);
    });

    it('sends deleteResource request correctly', async () => {
      let receivedKey: string | undefined;
      engine.on('deleteResource', (call, callback) => {
        receivedKey = (call.request as { key: string }).key;
        callback(null, {});
      });

      await caerus.deleteResource('seat_A12');

      expect(receivedKey).toBe('seat_A12');
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5])(
      'refuses non-integer deltaAmount %s in updateResource',
      async (deltaAmount) => {
        await expect(
          caerus.updateResource('general_admission', deltaAmount),
        ).rejects.toBeInstanceOf(ValidationError);
      },
    );
  });
});
