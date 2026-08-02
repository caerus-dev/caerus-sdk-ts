import { describe, expect, it, vi } from 'vitest';

import type { SharedResourceApi } from '../src/api.js';
import {
  ConflictError,
  OutOfStockError,
  ResourceNotFoundError,
  ValidationError,
} from '../src/errors.js';
import { InMemoryCaerusClient } from '../src/mock.js';

function aMock(availableAmount = 1) {
  return new InMemoryCaerusClient({
    resources: [{ key: 'seat_A12', availableAmount, groupKey: 'row_A' }],
  });
}

describe('the in-memory client', () => {
  /** The point of the whole thing: code written against the API takes either one. */
  it('is usable wherever the real client is', async () => {
    async function checkout(caerus: SharedResourceApi): Promise<string> {
      return caerus.reserve('seat_A12', (reservation) => reservation.id);
    }

    expect(await checkout(aMock())).toMatch(/^hld-/);
  });

  // --- Stock is real ---------------------------------------------------------------

  describe('stock', () => {
    it('moves units from available to pending when taken', async () => {
      const caerus = aMock(5);

      await caerus.takeMany('seat_A12', 2);
      const resource = await caerus.getResource('seat_A12');

      expect(resource.availableAmount).toBe(3);
      expect(resource.pendingCount).toBe(2);
    });

    it('gives them back on release', async () => {
      const caerus = aMock(5);

      const reservation = await caerus.takeMany('seat_A12', 2);
      await caerus.release(reservation.id);

      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 5,
        pendingCount: 0,
      });
    });

    /** Confirming keeps them taken: they stop being pending, they do not come back. */
    it('keeps them taken on confirm', async () => {
      const caerus = aMock(5);

      const reservation = await caerus.takeMany('seat_A12', 2);
      await caerus.confirm(reservation.id);

      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 3,
        pendingCount: 0,
      });
    });

    /** A test that over-reserves should fail here exactly as it would in production. */
    it('refuses to take more than exists', async () => {
      const caerus = aMock(1);

      await caerus.take('seat_A12');

      await expect(caerus.take('seat_A12')).rejects.toBeInstanceOf(OutOfStockError);
    });

    /**
     * The engine answers RESOURCE_EXHAUSTED for this, which the SDK turns into
     * OutOfStockError. The mock has to produce the same thing, or a test suite that
     * passes here would still break against Caerus.
     */
    it('reports it as the engine does, down to the error type', async () => {
      const caerus = aMock(1);
      await caerus.take('seat_A12');

      const error = await caerus.take('seat_A12').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OutOfStockError);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as OutOfStockError).code).toBe('OUT_OF_STOCK');
      expect((error as OutOfStockError).message).toBe('Out of stock for resource: seat_A12');
    });

    it('applies the same rule to takeMany', async () => {
      const caerus = aMock(3);

      await expect(caerus.takeMany('seat_A12', 4)).rejects.toBeInstanceOf(OutOfStockError);
    });

    it('does not know about resources nobody created', async () => {
      await expect(aMock().take('seat_ZZZ')).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('creates resources through the API too', async () => {
      const caerus = new InMemoryCaerusClient();

      const created = await caerus.createResource('seat', 'seat_B1', 3);
      const reservation = await caerus.take('seat_B1');

      expect(created.availableAmount).toBe(3);
      expect(reservation.status).toBe('PENDING');
    });

    it('refuses to create the same key twice', async () => {
      await expect(aMock().createResource('seat', 'seat_A12', 1)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });
  });

  // --- Time is an input ------------------------------------------------------------

  describe('expiry', () => {
    it('gives reservations a real expiresAt', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12', { ttlSeconds: 600 });

      const secondsAway = (reservation.expiresAt.getTime() - Date.now()) / 1000;
      expect(secondsAway).toBeGreaterThan(590);
      expect(secondsAway).toBeLessThan(610);
    });

    /** Nothing expires until the test says time passed. No timers, no waiting. */
    it('does not expire anything on its own', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12', { ttlSeconds: 1 });
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect((await caerus.getReservation(reservation.id)).status).toBe('PENDING');
    });

    it('expires what is past due when the clock moves', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12', { ttlSeconds: 300 });
      caerus.advanceTime(301);

      expect((await caerus.getReservation(reservation.id)).status).toBe('FAILED');
    });

    it('leaves alone what is not due yet', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12', { ttlSeconds: 300 });
      caerus.advanceTime(299);

      expect((await caerus.getReservation(reservation.id)).status).toBe('PENDING');
    });

    it('returns the units when a reservation expires', async () => {
      const caerus = aMock(2);

      await caerus.takeMany('seat_A12', 2);
      caerus.advanceTime(1000);

      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 2,
        pendingCount: 0,
      });
    });

    it('expires one reservation on demand', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12');
      caerus.expire(reservation.id);

      expect((await caerus.getReservation(reservation.id)).status).toBe('FAILED');
    });

    it('refuses to confirm one that expired', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12');
      caerus.expire(reservation.id);

      await expect(caerus.confirm(reservation.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it('extends the expiry by the seconds it is given', async () => {
      const caerus = aMock();

      const taken = await caerus.take('seat_A12', { ttlSeconds: 300 });
      const extended = await caerus.extend(taken.id, 300);
      caerus.advanceTime(301);

      expect(extended.expiresAt.getTime() - taken.expiresAt.getTime()).toBe(300_000);
      expect((await caerus.getReservation(taken.id)).status).toBe('PENDING');
    });

    it('refuses a negative jump', () => {
      expect(() => aMock().advanceTime(-1)).toThrow(ValidationError);
    });
  });

  // --- Forcing failures ------------------------------------------------------------

  describe('forced failures', () => {
    it('fails the next call to the named method', async () => {
      const caerus = aMock();
      caerus.failNext('take', new OutOfStockError('Out of stock for resource: seat_A12'));

      await expect(caerus.take('seat_A12')).rejects.toThrow('Out of stock');
      // and only that one
      await expect(caerus.take('seat_A12')).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('queues one failure per call', async () => {
      const caerus = aMock(5);
      caerus.failNext('take', new ConflictError('first'));
      caerus.failNext('take', new ConflictError('second'));

      await expect(caerus.take('seat_A12')).rejects.toThrow('first');
      await expect(caerus.take('seat_A12')).rejects.toThrow('second');
      await expect(caerus.take('seat_A12')).resolves.toBeDefined();
    });

    it('forgets them when asked', async () => {
      const caerus = aMock();
      caerus.failNext('take', new ConflictError('nope'));
      caerus.clearFailures();

      await expect(caerus.take('seat_A12')).resolves.toBeDefined();
    });

    /**
     * The reason this control exists: letting a user drive reserve() down its error path
     * without needing a broken server.
     */
    it('lets a caller exercise the release path of reserve', async () => {
      const caerus = aMock();
      const boom = new Error('card declined');

      await expect(
        caerus.reserve('seat_A12', () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      // released, so the stock is back
      expect(await caerus.getResource('seat_A12')).toMatchObject({ availableAmount: 1 });
    });

    it('lets a caller exercise a release that itself fails', async () => {
      const logged = vi.fn();
      const caerus = new InMemoryCaerusClient({
        resources: [{ key: 'seat_A12', availableAmount: 1 }],
        logger: { error: logged },
      });
      const boom = new Error('card declined');
      caerus.failNext('release', new ConflictError('release exploded'));

      await expect(
        caerus.reserve('seat_A12', () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(logged).toHaveBeenCalledOnce();
    });
  });

  // --- The same behaviour as the real client ---------------------------------------

  describe('behaves like the real client', () => {
    it('confirms after successful work and returns its value', async () => {
      const caerus = aMock();

      const result = await caerus.reserve('seat_A12', async () => 'ticket-1');

      expect(result).toBe('ticket-1');
      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 0,
        pendingCount: 0,
      });
    });

    it('reports FAILED from a query rather than throwing', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12');
      caerus.expire(reservation.id);

      await expect(caerus.getReservation(reservation.id)).resolves.toMatchObject({
        status: 'FAILED',
      });
    });

    it('gives back the first reservation for a repeated idempotency key', async () => {
      const caerus = aMock(5);

      const first = await caerus.take('seat_A12', { idempotencyKey: 'order-1' });
      const again = await caerus.take('seat_A12', { idempotencyKey: 'order-1' });

      expect(again.id).toBe(first.id);
      expect(await caerus.getResource('seat_A12')).toMatchObject({ pendingCount: 1 });
    });

    it('keeps metadata as an object', async () => {
      const caerus = aMock();

      const reservation = await caerus.take('seat_A12', { metadata: { orderId: '12345' } });

      expect(reservation.metadata).toEqual({ orderId: '12345' });
    });

    it.each([
      ['an empty resource key', (caerus: InMemoryCaerusClient) => caerus.take('  ')],
      ['a zero amount', (caerus: InMemoryCaerusClient) => caerus.takeMany('seat_A12', 0)],
      ['a zero extension', (caerus: InMemoryCaerusClient) => caerus.extend('hld-1', 0)],
    ])('rejects %s the same way', async (_case, call) => {
      await expect(call(aMock())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects calls after being closed', async () => {
      const caerus = aMock();
      caerus.close();

      await expect(caerus.take('seat_A12')).rejects.toThrow(/closed/);
    });
  });

  it('shows its state for assertions the API cannot make', async () => {
    const caerus = aMock(3);
    await caerus.take('seat_A12');

    const { resources, reservations } = caerus.snapshot();

    expect(resources).toHaveLength(1);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe('PENDING');
  });

  it('pages a group', async () => {
    const caerus = new InMemoryCaerusClient({
      resources: [
        { key: 'a', availableAmount: 1, groupKey: 'row_A' },
        { key: 'b', availableAmount: 1, groupKey: 'row_A' },
        { key: 'c', availableAmount: 1, groupKey: 'row_B' },
      ],
    });

    const first = await caerus.getResourcesByGroup('row_A', { page: 0, pageSize: 1 });
    const second = await caerus.getResourcesByGroup('row_A', { page: 1, pageSize: 1 });

    expect(first.resources.map((r) => r.key)).toEqual(['a']);
    expect(first.hasNextPage).toBe(true);
    expect(second.resources.map((r) => r.key)).toEqual(['b']);
    expect(second.hasNextPage).toBe(false);
  });
});
