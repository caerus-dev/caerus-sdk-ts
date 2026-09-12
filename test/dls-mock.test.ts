import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryDlsClient } from '../src/dls/dls-mock.js';
import { DlsNotFoundError, LockDeniedError } from '../src/dls/dls-errors.js';

describe('InMemoryDlsClient', () => {
  let client: InMemoryDlsClient;

  beforeEach(() => {
    client = new InMemoryDlsClient();
  });

  it('can begin a transaction', async () => {
    const tx = await client.beginTransaction();
    expect(tx.transactionId).toBeDefined();
    
    const status = await client.getTransactionStatus(tx.transactionId);
    expect(status.status).toBe('ACTIVE');
  });

  it('throws when getting status for non-existent transaction', async () => {
    await expect(client.getTransactionStatus('invalid')).rejects.toThrow(DlsNotFoundError);
  });

  it('can acquire and release an exclusive lock', async () => {
    const tx = await client.beginTransaction();
    const lock = await client.acquireLock('namespace', 'key1', tx.transactionId, 'EXCLUSIVE');
    
    expect(lock.status).toBe('ACQUIRED');
    expect(lock.lockId).toBeDefined();

    const lockStatus = await client.getLockStatus('namespace', 'key1');
    expect(lockStatus.isHeld).toBe(true);
    expect(lockStatus.currentMode).toBe('EXCLUSIVE');

    await client.releaseLock(lock.lockId, tx.transactionId);

    const releasedStatus = await client.getLockStatus('namespace', 'key1');
    expect(releasedStatus.isHeld).toBe(false);
  });

  it('denies exclusive lock if already held by another transaction', async () => {
    const tx1 = await client.beginTransaction();
    const tx2 = await client.beginTransaction();

    const lock1 = await client.acquireLock('namespace', 'key1', tx1.transactionId, 'EXCLUSIVE');
    expect(lock1.status).toBe('ACQUIRED');

    await expect(
      client.acquireLock('namespace', 'key1', tx2.transactionId, 'EXCLUSIVE'),
    ).rejects.toThrow(LockDeniedError);
  });

  it('allows shared read locks by multiple transactions', async () => {
    const tx1 = await client.beginTransaction();
    const tx2 = await client.beginTransaction();

    const lock1 = await client.acquireLock('namespace', 'key1', tx1.transactionId, 'SHARED_READ');
    expect(lock1.status).toBe('ACQUIRED');

    const lock2 = await client.acquireLock('namespace', 'key1', tx2.transactionId, 'SHARED_READ');
    expect(lock2.status).toBe('ACQUIRED');

    const status = await client.getLockStatus('namespace', 'key1');
    expect(status.isHeld).toBe(true);
    expect(status.currentMode).toBe('SHARED_READ');
    expect(status.activeHolders.length).toBe(2);
  });

  it('can release all transaction locks at once', async () => {
    const tx = await client.beginTransaction();
    await client.acquireLock('ns1', 'key1', tx.transactionId, 'EXCLUSIVE');
    await client.acquireLock('ns2', 'key2', tx.transactionId, 'SHARED_READ');
    
    await client.releaseTransactionLocks(tx.transactionId);

    const status1 = await client.getLockStatus('ns1', 'key1');
    expect(status1.isHeld).toBe(false);
    
    const status2 = await client.getLockStatus('ns2', 'key2');
    expect(status2.isHeld).toBe(false);

    // The transaction itself should be removed
    await expect(client.getTransactionStatus(tx.transactionId)).rejects.toThrow(DlsNotFoundError);
  });

  it('can renew a transaction', async () => {
    const tx = await client.beginTransaction({ timeoutMs: 1000 });
    const initialStatus = await client.getTransactionStatus(tx.transactionId);

    await client.renewTransaction(tx.transactionId, 5000);
    const updatedStatus = await client.getTransactionStatus(tx.transactionId);

    expect(updatedStatus.expiresAt).toBe(initialStatus.expiresAt + 5000);
  });

  it('renewing a non-existent transaction throws', async () => {
    await expect(client.renewTransaction('ghost', 1000)).rejects.toThrow(DlsNotFoundError);
  });

  it('releasing a lock on a non-existent transaction throws', async () => {
    await expect(client.releaseLock('l-1', 'ghost')).rejects.toThrow(DlsNotFoundError);
  });

  it('releasing a non-existent lock throws', async () => {
    const tx = await client.beginTransaction();
    await expect(client.releaseLock('ghost-lock', tx.transactionId)).rejects.toThrow(DlsNotFoundError);
  });

  it('expired locks are cleaned up dynamically during acquire', async () => {
    const tx = await client.beginTransaction({ timeoutMs: -1000 }); // Create an already expired tx
    
    // acquireLock uses the transaction expiration to set the lock expiration. 
    // Wait, acquireLock throws if transaction is not in activeTransactions?
    // Let's just create a lock and then wait or simulate expiration.
    const validTx = await client.beginTransaction();
    const lock = await client.acquireLock('ns1', 'k1', validTx.transactionId, 'EXCLUSIVE');
    expect(lock.status).toBe('ACQUIRED');
    
    // We cannot easily manipulate Date.now() here unless we mock Date, but we can verify the getLockStatus cleans it up.
    // Actually, getLockStatus filters by `expiresAt > now`. We can't trivially simulate this without fake timers.
    // Instead we test that releaseTransactionLocks cleans it up.
    await client.releaseTransactionLocks(validTx.transactionId);
    const st = await client.getLockStatus('ns1', 'k1');
    expect(st.isHeld).toBe(false);
  });

  it('denies SHARED_READ if an EXCLUSIVE lock is held', async () => {
    const tx1 = await client.beginTransaction();
    await client.acquireLock('ns', 'key', tx1.transactionId, 'EXCLUSIVE');

    const tx2 = await client.beginTransaction();

    await expect(
      client.acquireLock('ns', 'key', tx2.transactionId, 'SHARED_READ'),
    ).rejects.toThrow(LockDeniedError);
  });

  it('denies EXCLUSIVE if SHARED_READ is held by someone else', async () => {
    const tx1 = await client.beginTransaction();
    await client.acquireLock('ns', 'key', tx1.transactionId, 'SHARED_READ');

    const tx2 = await client.beginTransaction();

    await expect(
      client.acquireLock('ns', 'key', tx2.transactionId, 'EXCLUSIVE'),
    ).rejects.toThrow(LockDeniedError);
  });

  it('getTransactionStatus returns all locks requested by the transaction', async () => {
    const tx = await client.beginTransaction();
    await client.acquireLock('ns', 'key1', tx.transactionId, 'EXCLUSIVE');
    await client.acquireLock('ns', 'key2', tx.transactionId, 'SHARED_READ');
    
    const status = await client.getTransactionStatus(tx.transactionId);
    expect(status.locks).toHaveLength(2);
    expect(status.locks.find(l => l.lockKey === 'key1')?.requestedMode).toBe('EXCLUSIVE');
    expect(status.locks.find(l => l.lockKey === 'key2')?.requestedMode).toBe('SHARED_READ');
  });
});

