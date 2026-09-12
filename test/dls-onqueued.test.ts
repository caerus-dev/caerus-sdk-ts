import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeDlsEngine, startFakeDlsEngine } from './helpers/fake-dls-engine.js';
import { DlsClient } from '../src/dls/dls-client.js';
import { InMemoryDlsClient } from '../src/dls/dls-mock.js';

const ACQUIRED = 1;
const QUEUED = 3;

describe('onQueued', () => {
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

  beforeEach(() => engine.reset());

  const colaYDespuesConcede = () =>
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: QUEUED });
      setTimeout(() => call.write({ lockId: '', fencingToken: 0, status: QUEUED }), 30);
      setTimeout(() => call.write({ lockId: '', fencingToken: 0, status: QUEUED }), 60);
      setTimeout(() => {
        call.write({ lockId: 'lock-1', fencingToken: 5, status: ACQUIRED });
        call.end();
      }, 90);
    });

  it('avisa una sola vez aunque el motor mande varios QUEUED de keep-alive', async () => {
    colaYDespuesConcede();
    let avisos = 0;

    const lock = await client.acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', {
      timeoutMs: 5000,
      onQueued: () => {
        avisos += 1;
      },
    });

    expect(avisos).toBe(1);
    expect(lock).toEqual({ lockId: 'lock-1', fencingToken: 5, status: 'ACQUIRED' });
  });

  it('el aviso llega antes de que se conceda, nunca despues', async () => {
    colaYDespuesConcede();
    const orden: string[] = [];

    await client.acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', {
      timeoutMs: 5000,
      onQueued: () => orden.push('en cola'),
    });
    orden.push('concedido');

    expect(orden).toEqual(['en cola', 'concedido']);
  });

  it('no avisa si el lock se concede de entrada', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: 'lock-1', fencingToken: 5, status: ACQUIRED });
      call.end();
    });
    let avisos = 0;

    await client.acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', {
      onQueued: () => {
        avisos += 1;
      },
    });

    expect(avisos).toBe(0);
  });

  it('si el callback lanza, la adquisicion sigue igual', async () => {
    colaYDespuesConcede();

    const lock = await client.acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', {
      timeoutMs: 5000,
      onQueued: () => {
        throw new Error('la interfaz se rompio');
      },
    });

    expect(lock.status).toBe('ACQUIRED');
  });

  it('funciona igual dentro de withTransaction', async () => {
    engine.on('beginTransaction', (_call, callback) => callback(null, { transactionId: 'tx-9' }));
    engine.on('releaseTransactionLocks', (_call, callback) => callback(null, {}));
    colaYDespuesConcede();
    let avisos = 0;

    const estado = await client.withTransaction(
      async (tx) => {
        const lock = await tx.acquireLock('ns', 'k', 'EXCLUSIVE', {
          timeoutMs: 5000,
          onQueued: () => {
            avisos += 1;
          },
        });
        return lock.status;
      },
      { autoRenew: false },
    );

    expect(estado).toBe('ACQUIRED');
    expect(avisos).toBe(1);
  });

  it('el cliente en memoria acepta la opcion sin romperse', async () => {
    const memoria = new InMemoryDlsClient();
    const tx = await memoria.beginTransaction();

    const lock = await memoria.acquireLock('ns', 'k', tx.transactionId, 'EXCLUSIVE', {
      onQueued: () => {},
    });

    expect(lock.status).toBe('ACQUIRED');
  });
});
