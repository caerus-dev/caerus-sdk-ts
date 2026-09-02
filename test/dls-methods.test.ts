import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeDlsEngine, startFakeDlsEngine } from './helpers/fake-dls-engine.js';
import { DlsClient } from '../src/dls/dls-client.js';

describe('DlsClient methods', () => {
  let engine: FakeDlsEngine;
  let client: DlsClient;

  beforeAll(async () => {
    engine = await startFakeDlsEngine();
    client = new DlsClient({ endpoint: engine.endpoint, apiKey: 'test-key', tls: false });
  });

  afterAll(async () => {
    client.close();
    await engine.stop();
  });

  beforeEach(() => {
    engine.reset();
  });

  it('beginTransaction passes timeoutMs', async () => {
    const tx = await client.beginTransaction({ timeoutMs: 5000 });
    expect(tx.transactionId).toBe('tx-1');
    expect(engine.lastMethod).toBe('beginTransaction');
    expect(engine.lastRequest.timeoutMs).toBe(5000);
  });

  it('beginTransaction works without timeout', async () => {
    const tx = await client.beginTransaction();
    expect(tx.transactionId).toBe('tx-1');
    expect(engine.lastMethod).toBe('beginTransaction');
    expect(engine.lastRequest.timeoutMs).toBeUndefined();
  });

  it('acquireLock correctly maps mode and ignores QUEUED', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: 3 }); // QUEUED
      call.write({ lockId: 'l-1', fencingToken: 5, status: 1 }); // ACQUIRED
      call.end();
    });

    const lock = await client.acquireLock('ns1', 'k1', 'tx-1', 'EXCLUSIVE', { idempotencyKey: 'idem1' });
    
    expect(lock.lockId).toBe('l-1');
    expect(lock.fencingToken).toBe(5);
    expect(lock.status).toBe('ACQUIRED');
    expect(engine.lastRequest.namespace).toBe('ns1');
    expect(engine.lastRequest.lockKey).toBe('k1');
    expect(engine.lastRequest.transactionId).toBe('tx-1');
    expect(engine.lastRequest.requestedMode).toBe(1); // EXCLUSIVE
    expect(engine.lastRequest.idempotencyKey).toBe('idem1');
  });

  it('acquireLock returns DENIED correctly', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: 2 }); // DENIED
      call.end();
    });

    const lock = await client.acquireLock('ns1', 'k1', 'tx-1', 'SHARED_READ');
    
    expect(lock.status).toBe('DENIED');
    expect(engine.lastRequest.requestedMode).toBe(2); // SHARED_READ
  });

  it('renewTransaction correctly passes arguments', async () => {
    await client.renewTransaction('tx-1', 1000);
    expect(engine.lastMethod).toBe('renewTransaction');
    expect(engine.lastRequest.transactionId).toBe('tx-1');
    expect(engine.lastRequest.extraMs).toBe(1000);
  });

  it('releaseLock correctly passes arguments', async () => {
    await client.releaseLock('l-1', 'tx-1');
    expect(engine.lastMethod).toBe('releaseLock');
    expect(engine.lastRequest.lockId).toBe('l-1');
    expect(engine.lastRequest.transactionId).toBe('tx-1');
  });

  it('releaseTransactionLocks correctly passes arguments', async () => {
    await client.releaseTransactionLocks('tx-1');
    expect(engine.lastMethod).toBe('releaseTransactionLocks');
    expect(engine.lastRequest.transactionId).toBe('tx-1');
  });

  it('getLockStatus correctly maps response', async () => {
    const status = await client.getLockStatus('ns1', 'k1');
    expect(engine.lastMethod).toBe('getLockStatus');
    expect(engine.lastRequest.namespace).toBe('ns1');
    
    expect(status.isHeld).toBe(true);
    expect(status.currentMode).toBe('EXCLUSIVE');
    expect(status.activeHolders).toHaveLength(1);
    expect(status.activeHolders[0]!.lockId).toBe('l-1');
  });

  it('getTransactionStatus correctly maps response', async () => {
    engine.on('getTransactionStatus', (call, callback) => {
      callback(null, {
        status: 'ABORTED',
        abortReason: 'timeout',
        locks: [{ namespace: 'n1', lockKey: 'k1', requestedMode: 1, status: 1 }],
        expiresAt: 500
      });
    });

    const status = await client.getTransactionStatus('tx-1');
    expect(status.status).toBe('ABORTED');
    expect(status.abortReason).toBe('timeout');
    expect(status.locks).toHaveLength(1);
    expect(status.locks[0]!.requestedMode).toBe('EXCLUSIVE');
    expect(status.locks[0]!.status).toBe('ACQUIRED');
  });
});
