import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryDlsClient } from '../src/dls/dls-mock';
import { DlsNotFoundError } from '../src/dls/dls-errors';

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

  it('si la renovacion falla sin remedio, la transaccion se da por perdida', async () => {
    vi.useRealTimers();
    client.renewTransaction = async () => {
      throw new DlsNotFoundError('la transaccion ya no existe');
    };

    let avisado: Error | undefined;

    const corrida = client.withTransaction(
      async () => {
        await new Promise((r) => setTimeout(r, 1500));
        return 'el callback termino igual';
      },
      {
        timeoutMs: 2000,
        onTransactionLost: (error) => {
          avisado = error;
        },
      },
    );

    await expect(corrida).rejects.toThrow(DlsNotFoundError);
    expect(avisado).toBeInstanceOf(DlsNotFoundError);
  });

  it('perdida la transaccion, no deja tomar mas locks ni devolver un resultado bueno', async () => {
    vi.useRealTimers();
    client.renewTransaction = async () => {
      throw new DlsNotFoundError('la transaccion ya no existe');
    };

    let tomarFallo: unknown;
    let avisoDeAborto = false;

    const corrida = client.withTransaction(
      async (tx) => {
        tx.signal.addEventListener('abort', () => {
          avisoDeAborto = true;
        });
        await new Promise((r) => setTimeout(r, 1500));
        tomarFallo = await tx.acquireLock('ns', 'k', 'EXCLUSIVE').catch((e) => e);
        return 'no deberia llegar';
      },
      { timeoutMs: 2000 },
    );

    await expect(corrida).rejects.toThrow(DlsNotFoundError);
    expect(tomarFallo).toBeInstanceOf(DlsNotFoundError);
    expect(avisoDeAborto).toBe(true);
  });
});

