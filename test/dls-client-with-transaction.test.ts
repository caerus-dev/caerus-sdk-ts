import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryDlsClient } from '../src/dls/dls-mock';

describe('DLS withTransaction', () => {
  let client: InMemoryDlsClient;

  beforeEach(() => {
    client = new InMemoryDlsClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('automatically renews transaction and releases locks on completion', async () => {
    const renewSpy = vi.spyOn(client, 'renewTransaction');
    const releaseSpy = vi.spyOn(client, 'releaseTransactionLocks');

    let txId = '';
    
    // the callback returns a promise that resolves after some simulated time
    const result = await client.withTransaction(async (tx) => {
      txId = tx.transactionId;
      await tx.acquireLock('ns1', 'key1', 'EXCLUSIVE');
      
      // advance time to trigger heartbeat
      await vi.advanceTimersByTimeAsync(6000); 
      
      return 'done';
    }, { timeoutMs: 10000, autoRenew: true });

    expect(result).toBe('done');
    expect(renewSpy).toHaveBeenCalledWith(txId, 10000); // Heartbeat should have fired at least once
    expect(releaseSpy).toHaveBeenCalledWith(txId); // Released at the end
  });

  it('releases locks on error and rethrows', async () => {
    const releaseSpy = vi.spyOn(client, 'releaseTransactionLocks');

    await expect(client.withTransaction(async (tx) => {
      await tx.acquireLock('ns2', 'key2', 'EXCLUSIVE');
      throw new Error('Business logic failed');
    })).rejects.toThrow('Business logic failed');

    // Make sure releaseTransactionLocks was still called despite the error
    expect(releaseSpy).toHaveBeenCalled();
  });

  it('prevents acquireLock if context is already closed', async () => {
    let leakedTx: any = null;

    await client.withTransaction(async (tx) => {
      leakedTx = tx;
    });

    // Attempting to use the leaked tx after the block should fail synchronously
    await expect(leakedTx.acquireLock('ns', 'key', 'EXCLUSIVE')).rejects.toThrow('Transaction context already closed');
  });
  
  it('aborts acquireLock if AbortSignal is aborted', async () => {
    const ac = new AbortController();
    ac.abort(); // pre-abort for quick test

    await expect(client.withTransaction(async (tx) => {
      await tx.acquireLock('ns3', 'key3', 'EXCLUSIVE');
    }, { signal: ac.signal })).rejects.toThrow('AcquireLock aborted by user');
  });
});

