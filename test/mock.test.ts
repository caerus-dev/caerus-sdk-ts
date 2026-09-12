import { describe, expect, it } from 'vitest';

import type { SharedResourceApi } from '../src/sre/api.js';
import { ConflictError, ResourceNotFoundError, ValidationError } from '../src/sre/errors.js';
import { InMemoryCaerusClient } from '../src/sre/mock.js';

function aMock(availableAmount = 1) {
  return new InMemoryCaerusClient({
    resources: [{ key: 'seat_A12', availableAmount, groupKey: 'row_A' }],
  });
}

describe('the in-memory client', () => {
  /** The point of the whole thing: code written against the API takes either one. */
  it('is usable wherever the real client is', async () => {
    async function checkout(caerus: SharedResourceApi): Promise<string> {
      const holder = await caerus.unitary('seat_A12').take();
      await caerus.confirm(holder.id);
      return holder.id;
    }

    expect(await checkout(aMock())).toMatch(/^hld-/);
  });

  // --- Stock is real ---------------------------------------------------------------

  describe('stock', () => {
    it('moves units from available to pending when taken', async () => {
      const caerus = aMock(5);

      await caerus.pooled('seat_A12').takeMany(2);
      const resource = await caerus.getResource('seat_A12');

      expect(resource.availableAmount).toBe(3);
      expect(resource.pendingCount).toBe(2);
    });

    it('gives them back on release', async () => {
      const caerus = aMock(5);

      const holder = await caerus.pooled('seat_A12').takeMany(2);
      await caerus.release(holder.id);

      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 5,
        pendingCount: 0,
      });
    });

    /** Confirming keeps them taken: they stop being pending, they do not come back. */
    it('keeps them taken on confirm', async () => {
      const caerus = aMock(5);

      const holder = await caerus.pooled('seat_A12').takeMany(2);
      await caerus.confirm(holder.id);

      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 3,
        pendingCount: 0,
      });
    });

    /** A test that over-reserves should fail here exactly as it would in production. */
    it('refuses to take more than exists', async () => {
      const caerus = aMock(1);

      await caerus.unitary('seat_A12').take();

      await expect(caerus.unitary('seat_A12').take()).rejects.toBeInstanceOf(ConflictError);
    });

    /**
     * The engine answers FAILED_PRECONDITION for this, which the SDK turns into
     * ConflictError. The mock has to produce the same thing, wording included, or a test
     * suite that passes here would still break against Caerus.
     */
    it('reports it as the engine does, down to the error type', async () => {
      const caerus = aMock(1);
      await caerus.unitary('seat_A12').take();

      const error = await caerus.unitary('seat_A12').take().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('CONFLICT');
      expect((error as ConflictError).message).toBe('Out of stock for resource: seat_A12');
    });

    it('applies the same rule to takeMany', async () => {
      const caerus = aMock(3);

      await expect(caerus.pooled('seat_A12').takeMany(4)).rejects.toBeInstanceOf(ConflictError);
    });

    it('does not know about resources nobody created', async () => {
      await expect(aMock().unitary('seat_ZZZ').take()).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('creates resources through the API too', async () => {
      const caerus = new InMemoryCaerusClient();

      const created = await caerus.createMultiple('seat', 'seat_B1', 3);
      const holder = await caerus.unitary('seat_B1').take();

      expect(created.availableAmount).toBe(3);
      expect(holder.status).toBe('PENDING');
    });

    it('refuses to create the same key twice', async () => {
      await expect(aMock().createMultiple('seat', 'seat_A12', 1)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });
  });

  // --- Time is an input ------------------------------------------------------------

  describe('expiry', () => {
    it('gives holders a real expiresAt', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take({ ttlSeconds: 600 });

      const secondsAway = (holder.expiresAt.getTime() - Date.now()) / 1000;
      expect(secondsAway).toBeGreaterThan(590);
      expect(secondsAway).toBeLessThan(610);
    });

    /** Nothing expires until the test says time passed. No timers, no waiting. */
    it('does not expire anything on its own', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take({ ttlSeconds: 1 });
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect((await caerus.getResourceHolder(holder.id)).status).toBe('PENDING');
    });

    it('expires what is past due when the clock moves', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take({ ttlSeconds: 300 });
      caerus.advanceTime(301);

      expect((await caerus.getResourceHolder(holder.id)).status).toBe('EXPIRED');
    });

    it('leaves alone what is not due yet', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take({ ttlSeconds: 300 });
      caerus.advanceTime(299);

      expect((await caerus.getResourceHolder(holder.id)).status).toBe('PENDING');
    });

    it('returns the units when a holder expires', async () => {
      const caerus = aMock(2);

      await caerus.pooled('seat_A12').takeMany(2);
      caerus.advanceTime(1000);

      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 2,
        pendingCount: 0,
      });
    });

    it('expires one holder on demand', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take();
      caerus.expire(holder.id);

      expect((await caerus.getResourceHolder(holder.id)).status).toBe('EXPIRED');
    });

    it('refuses to confirm one that expired', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take();
      caerus.expire(holder.id);

      await expect(caerus.confirm(holder.id)).rejects.toBeInstanceOf(ConflictError);
    });

    /** Milliseconds in, whole seconds applied, rounding up — the way the engine does it. */
    it('extends the expiry by the milliseconds it is given', async () => {
      const caerus = aMock();

      const taken = await caerus.unitary('seat_A12').take({ ttlSeconds: 300 });
      const extended = await caerus.extend(taken.id, 300_000);
      caerus.advanceTime(301);

      expect(extended.expiresAt.getTime() - taken.expiresAt.getTime()).toBe(300_000);
      expect((await caerus.getResourceHolder(taken.id)).status).toBe('PENDING');
    });

    it('rounds a sub-second extension up to one second', async () => {
      const caerus = aMock();

      const taken = await caerus.unitary('seat_A12').take({ ttlSeconds: 300 });
      const extended = await caerus.extend(taken.id, 300);

      expect(extended.expiresAt.getTime() - taken.expiresAt.getTime()).toBe(1_000);
    });

    it('refuses a negative jump', () => {
      expect(() => aMock().advanceTime(-1)).toThrow(ValidationError);
    });
  });

  // --- Forcing failures ------------------------------------------------------------

  describe('forced failures', () => {
    it('fails the next call to the named method', async () => {
      const caerus = aMock();
      caerus.failNext('take', new ConflictError('Out of stock for resource: seat_A12'));

      await expect(caerus.unitary('seat_A12').take()).rejects.toThrow('Out of stock');
      // and only that one
      await expect(caerus.unitary('seat_A12').take()).resolves.toMatchObject({ status: 'PENDING' });
    });

    it('queues one failure per call', async () => {
      const caerus = aMock(5);
      caerus.failNext('take', new ConflictError('first'));
      caerus.failNext('take', new ConflictError('second'));

      await expect(caerus.unitary('seat_A12').take()).rejects.toThrow('first');
      await expect(caerus.unitary('seat_A12').take()).rejects.toThrow('second');
      await expect(caerus.unitary('seat_A12').take()).resolves.toBeDefined();
    });

    it('forgets them when asked', async () => {
      const caerus = aMock();
      caerus.failNext('take', new ConflictError('nope'));
      caerus.clearFailures();

      await expect(caerus.unitary('seat_A12').take()).resolves.toBeDefined();
    });

    /**
     * The reason this control exists: letting a caller drive their own error path —
     * a release that does not land — without needing a broken server.
     */
    it('lets a caller exercise a release that fails', async () => {
      const caerus = aMock();
      const holder = await caerus.unitary('seat_A12').take();
      caerus.failNext('release', new ConflictError('release exploded'));

      await expect(caerus.release(holder.id)).rejects.toThrow('release exploded');
    });
  });

  // --- The same behaviour as the real client ---------------------------------------

  describe('behaves like the real client', () => {
    it('keeps the units taken after a confirm', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take();
      await caerus.confirm(holder.id);

      expect(await caerus.getResource('seat_A12')).toMatchObject({
        availableAmount: 0,
        pendingCount: 0,
      });
    });

    it('reports EXPIRED from a query rather than throwing', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take();
      caerus.expire(holder.id);

      await expect(caerus.getResourceHolder(holder.id)).resolves.toMatchObject({
        status: 'EXPIRED',
      });
    });

    it('gives back the first holder for a repeated idempotency key', async () => {
      const caerus = aMock(5);

      const first = await caerus.unitary('seat_A12').take({ idempotencyKey: 'order-1' });
      const again = await caerus.unitary('seat_A12').take({ idempotencyKey: 'order-1' });

      expect(again.id).toBe(first.id);
      expect(await caerus.getResource('seat_A12')).toMatchObject({ pendingCount: 1 });
    });

    it('keeps metadata as an object', async () => {
      const caerus = aMock();

      const holder = await caerus.unitary('seat_A12').take({ metadata: { orderId: '12345' } });

      expect(holder.metadata).toEqual({ orderId: '12345' });
    });

    it.each([
      ['a zero amount', (caerus: InMemoryCaerusClient) => caerus.pooled('seat_A12').takeMany(0)],
      ['a zero extension', (caerus: InMemoryCaerusClient) => caerus.extend('hld-1', 0)],
    ])('rejects %s the same way', async (_case, call) => {
      await expect(call(aMock())).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects calls after being closed', async () => {
      const caerus = aMock();
      caerus.close();

      await expect(caerus.unitary('seat_A12').take()).rejects.toThrow(/closed/);
    });
  });

  it('shows its state for assertions the API cannot make', async () => {
    const caerus = aMock(3);
    await caerus.unitary('seat_A12').take();

    const { resources, holders } = caerus.snapshot();

    expect(resources).toHaveLength(1);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.status).toBe('PENDING');
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

  describe('updateResource and deleteResource in mock', () => {
    it('updates resource available amount', async () => {
      const caerus = aMock(10);

      const updated = await caerus.updateResource('seat_A12', 5, { groupKey: 'row_X' });

      expect(updated.availableAmount).toBe(15);
      expect(updated.groupKey).toBe('row_X');
    });

    it('refuses update that results in negative stock', async () => {
      const caerus = aMock(5);

      await expect(caerus.updateResource('seat_A12', -10)).rejects.toBeInstanceOf(ConflictError);
    });

    it('deletes a resource with no active holds', async () => {
      const caerus = aMock(5);

      await caerus.deleteResource('seat_A12');

      await expect(caerus.getResource('seat_A12')).rejects.toThrow(/not found/);
    });

    it('refuses to delete a resource with pending holds', async () => {
      const caerus = aMock(5);
      await caerus.unitary('seat_A12').take();

      await expect(caerus.deleteResource('seat_A12')).rejects.toBeInstanceOf(ConflictError);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 2.5])(
      'refuses non-integer deltaAmount %s in updateResource',
      async (deltaAmount) => {
        const caerus = aMock(5);
        await expect(caerus.updateResource('seat_A12', deltaAmount)).rejects.toBeInstanceOf(
          ValidationError,
        );
      },
    );
  });

  describe('listResourceHolders in mock', () => {
    async function withThreeHolders() {
      const caerus = aMock(10);
      const first = await caerus.pooled('seat_A12').take();
      const second = await caerus.pooled('seat_A12').take();
      const third = await caerus.pooled('seat_A12').take();
      await caerus.confirm(second.id);
      return { caerus, first, second, third };
    }

    it('lists newest first by default', async () => {
      const { caerus, first, third } = await withThreeHolders();

      const page = await caerus.listResourceHolders();

      expect(page.holders).toHaveLength(3);
      expect(page.holders[0]!.id).toBe(third.id);
      expect(page.holders[2]!.id).toBe(first.id);
    });

    it('can be asked for the other order', async () => {
      const { caerus, first } = await withThreeHolders();

      const page = await caerus.listResourceHolders({ sort: 'OLDEST_FIRST' });

      expect(page.holders[0]!.id).toBe(first.id);
    });

    it('narrows by status', async () => {
      const { caerus, second } = await withThreeHolders();

      const confirmed = await caerus.listResourceHolders({ status: 'CONFIRMED' });

      expect(confirmed.holders.map((holder) => holder.id)).toEqual([second.id]);
    });

    it('narrows by resource', async () => {
      const { caerus } = await withThreeHolders();

      expect((await caerus.listResourceHolders({ resourceKey: 'seat_A12' })).holders).toHaveLength(
        3,
      );
      expect((await caerus.listResourceHolders({ resourceKey: 'otra' })).holders).toHaveLength(0);
    });

    it('pages, and says when there is more', async () => {
      const { caerus } = await withThreeHolders();

      const first = await caerus.listResourceHolders({ pageSize: 2 });
      expect(first.holders).toHaveLength(2);
      expect(first.hasNextPage).toBe(true);

      const second = await caerus.listResourceHolders({ pageSize: 2, page: 1 });
      expect(second.holders).toHaveLength(1);
      expect(second.hasNextPage).toBe(false);
    });
  });
});
