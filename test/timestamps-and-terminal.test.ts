import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CaerusClient } from '../src/client.js';
import { ConflictError } from '../src/errors.js';
import { InMemoryCaerusClient } from '../src/mock.js';
import {
  aHolderResponse,
  aResourceResponse,
  startFakeEngine,
  type FakeEngine,
} from './helpers/fake-engine.js';

const PENDING = 0;
const CONFIRMED = 1;
const RELEASED = 2;
const QUEUED = 3;
const EXPIRED = 4;

describe('timestamps coming off the wire', () => {
  let engine: FakeEngine;
  let caerus: CaerusClient;

  beforeAll(async () => {
    engine = await startFakeEngine();
    caerus = new CaerusClient({ apiKey: 'caer_test_key', endpoint: engine.endpoint, tls: false });
  });

  afterAll(async () => {
    caerus.close();
    await engine.stop();
  });

  beforeEach(() => {
    engine.reset();
  });

  it('reads a resource created and updated at as Dates', async () => {
    engine.on('getResource', (_call, callback) =>
      callback(null, aResourceResponse({ createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_060_000 })),
    );

    const resource = await caerus.getResource('seat_A12');

    expect(resource.createdAt).toEqual(new Date(1_700_000_000_000));
    expect(resource.updatedAt).toEqual(new Date(1_700_000_060_000));
  });

  it('reads a holder created at as a Date', async () => {
    engine.on('getResourceHolder', (_call, callback) =>
      callback(null, aHolderResponse({ createdAtMs: 1_700_000_000_000 })),
    );

    const holder = await caerus.getResourceHolder('hld-1');

    expect(holder.createdAt).toEqual(new Date(1_700_000_000_000));
  });

  it('leaves the timestamps undefined when the engine sends none', async () => {
    engine.on('getResource', (_call, callback) => callback(null, aResourceResponse()));
    engine.on('getResourceHolder', (_call, callback) => callback(null, aHolderResponse()));

    const resource = await caerus.getResource('seat_A12');
    const holder = await caerus.getResourceHolder('hld-1');

    expect(resource.createdAt).toBeUndefined();
    expect(resource.updatedAt).toBeUndefined();
    expect(holder.createdAt).toBeUndefined();
  });

  it('never turns a missing timestamp into 1970', async () => {
    engine.on('getResource', (_call, callback) =>
      callback(null, aResourceResponse({ createdAtMs: 0, updatedAtMs: 0 })),
    );

    const resource = await caerus.getResource('seat_A12');

    expect(resource.createdAt).toBeUndefined();
    expect(resource.updatedAt).toBeUndefined();
  });
});

describe('a holder that comes back finished', () => {
  let engine: FakeEngine;
  let caerus: CaerusClient;

  beforeAll(async () => {
    engine = await startFakeEngine();
    caerus = new CaerusClient({ apiKey: 'caer_test_key', endpoint: engine.endpoint, tls: false });
  });

  afterAll(async () => {
    caerus.close();
    await engine.stop();
  });

  beforeEach(() => {
    engine.reset();
  });

  for (const [name, status] of [
    ['RELEASED', RELEASED],
    ['EXPIRED', EXPIRED],
    ['CONFIRMED', CONFIRMED],
  ] as const) {
    it(`take refuses a ${name} holder`, async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status })));

      await expect(caerus.unitary('seat_A12').take()).rejects.toBeInstanceOf(ConflictError);
      await expect(caerus.unitary('seat_A12').take()).rejects.toThrow(name);
    });
  }

  for (const [name, status] of [
    ['PENDING', PENDING],
    ['QUEUED', QUEUED],
  ] as const) {
    it(`take accepts a ${name} holder`, async () => {
      engine.on('take', (_call, callback) => callback(null, aHolderResponse({ status })));

      const holder = await caerus.unitary('seat_A12').take();

      expect(holder.status).toBe(name);
    });
  }

  it('confirm accepts the CONFIRMED holder it is meant to produce', async () => {
    engine.on('confirm', (_call, callback) => callback(null, aHolderResponse({ status: CONFIRMED })));

    const holder = await caerus.confirm('hld-1');

    expect(holder.status).toBe('CONFIRMED');
  });

  it('confirm refuses a RELEASED holder', async () => {
    engine.on('confirm', (_call, callback) => callback(null, aHolderResponse({ status: RELEASED })));

    await expect(caerus.confirm('hld-1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('extend refuses a RELEASED holder', async () => {
    engine.on('extend', (_call, callback) => callback(null, aHolderResponse({ status: RELEASED })));

    await expect(caerus.extend('hld-1', 60_000)).rejects.toBeInstanceOf(ConflictError);
  });

  it('a query still answers with the finished holder instead of throwing', async () => {
    engine.on('getResourceHolder', (_call, callback) =>
      callback(null, aHolderResponse({ status: RELEASED })),
    );

    const holder = await caerus.getResourceHolder('hld-1');

    expect(holder.status).toBe('RELEASED');
  });
});

describe('the mock keeps the same promises', () => {
  it('stamps createdAt and updatedAt on a resource', async () => {
    const mock = new InMemoryCaerusClient();
    const created = await mock.createUnitary('butaca', 'seat_A12');

    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('moves updatedAt when the resource changes', async () => {
    const mock = new InMemoryCaerusClient();
    const created = await mock.createMultiple('entrada', 'general', 10);

    mock.advanceTime(60);
    const updated = await mock.updateResource('general', 5);

    expect(updated.updatedAt!.getTime()).toBeGreaterThan(created.updatedAt!.getTime());
    expect(updated.createdAt!.getTime()).toBe(created.createdAt!.getTime());
  });

  it('stamps createdAt on a holder', async () => {
    const mock = new InMemoryCaerusClient();
    await mock.createUnitary('butaca', 'seat_A12');
    const holder = await mock.unitary('seat_A12').take();

    expect(holder.createdAt).toBeInstanceOf(Date);
  });

  it('refuses to replay an idempotency key whose holder was released', async () => {
    const mock = new InMemoryCaerusClient();
    await mock.createUnitary('butaca', 'seat_A12');

    const first = await mock.unitary('seat_A12').take({ idempotencyKey: 'k1' });
    await mock.release(first.id);

    await expect(mock.unitary('seat_A12').take({ idempotencyKey: 'k1' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('still replays an idempotency key whose holder is alive', async () => {
    const mock = new InMemoryCaerusClient();
    await mock.createUnitary('butaca', 'seat_A12');

    const first = await mock.unitary('seat_A12').take({ idempotencyKey: 'k1' });
    const again = await mock.unitary('seat_A12').take({ idempotencyKey: 'k1' });

    expect(again.id).toBe(first.id);
  });
});
