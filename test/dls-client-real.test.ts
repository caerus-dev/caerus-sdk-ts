import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeDlsEngine, startFakeDlsEngine } from './helpers/fake-dls-engine.js';
import { DlsClient } from '../src/dls/dls-client.js';
import { DlsError, DlsNotFoundError, LockDeniedError } from '../src/dls/dls-errors.js';

const ACQUIRED = 1;
const DENIED = 2;
const QUEUED = 3;

describe('DlsClient real: withTransaction', () => {
  let engine: FakeDlsEngine;
  let client: DlsClient;
  let llamadas: string[];

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
    llamadas = [];
    engine.on('beginTransaction', (_call, callback) => {
      llamadas.push('begin');
      callback(null, { transactionId: 'tx-1' });
    });
    engine.on('releaseTransactionLocks', (_call, callback) => {
      llamadas.push('releaseAll');
      callback(null, {});
    });
    engine.on('renewTransaction', (_call, callback) => {
      llamadas.push('renew');
      callback(null, { transactionId: 'tx-1', newExpiresAt: 0 });
    });
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: 'lock-1', fencingToken: 7, status: ACQUIRED });
      call.end();
    });
  });

  it('abre la transaccion, corre el callback y suelta los locks al final', async () => {
    const resultado = await client.withTransaction(async (tx) => {
      const lock = await tx.acquireLock('ns', 'k', 'EXCLUSIVE');
      return `${tx.transactionId}:${lock.status}:${lock.fencingToken}`;
    }, { autoRenew: false });

    expect(resultado).toBe('tx-1:ACQUIRED:7');
    expect(llamadas).toEqual(['begin', 'releaseAll']);
  });

  it('suelta los locks igual cuando el callback explota, y relanza', async () => {
    await expect(
      client.withTransaction(async () => {
        throw new Error('se rompio el trabajo');
      }, { autoRenew: false }),
    ).rejects.toThrow('se rompio el trabajo');

    expect(llamadas).toContain('releaseAll');
  });

  it('un lock denegado dentro de la transaccion la corta y suelta igual', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: DENIED });
      call.end();
    });

    await expect(
      client.withTransaction(async (tx) => tx.acquireLock('ns', 'k', 'EXCLUSIVE'), {
        autoRenew: false,
      }),
    ).rejects.toThrow(LockDeniedError);

    expect(llamadas).toContain('releaseAll');
  });

  it('renueva sola mientras el trabajo dura', async () => {
    await client.withTransaction(async () => {
      await new Promise((r) => setTimeout(r, 2300));
    }, { timeoutMs: 2000 });

    expect(llamadas.filter((l) => l === 'renew').length).toBeGreaterThanOrEqual(2);
    expect(llamadas).toContain('releaseAll');
  });

  it('con autoRenew apagado no manda ni un latido', async () => {
    await client.withTransaction(async () => {
      await new Promise((r) => setTimeout(r, 1600));
    }, { timeoutMs: 2000, autoRenew: false });

    expect(llamadas).not.toContain('renew');
  });

  it('si la renovacion falla sin remedio da la transaccion por perdida', async () => {
    engine.on('renewTransaction', (_call, callback) => {
      llamadas.push('renew');
      callback({ code: 5, details: 'la transaccion ya no existe' } as never, null);
    });

    let avisado: Error | undefined;
    let abortada = false;

    const corrida = client.withTransaction(
      async (tx) => {
        tx.signal.addEventListener('abort', () => {
          abortada = true;
        });
        await new Promise((r) => setTimeout(r, 1600));
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
    expect(abortada).toBe(true);
    expect(llamadas).toContain('releaseAll');
  });

  it('perdida la transaccion, no deja tomar mas locks', async () => {
    engine.on('renewTransaction', (_call, callback) => {
      callback({ code: 5, details: 'la transaccion ya no existe' } as never, null);
    });

    let alTomar: unknown;

    await expect(
      client.withTransaction(
        async (tx) => {
          await new Promise((r) => setTimeout(r, 1600));
          alTomar = await tx.acquireLock('ns', 'k', 'EXCLUSIVE').catch((e) => e);
          return 'no deberia valer';
        },
        { timeoutMs: 2000 },
      ),
    ).rejects.toThrow(DlsNotFoundError);

    expect(alTomar).toBeInstanceOf(DlsNotFoundError);
  });

  it('cerrado el contexto, no se puede seguir usando', async () => {
    let fugado: { acquireLock: (...a: never[]) => Promise<unknown> } | undefined;

    await client.withTransaction(async (tx) => {
      fugado = tx as never;
    }, { autoRenew: false });

    await expect(fugado!.acquireLock('ns' as never, 'k' as never, 'EXCLUSIVE' as never)).rejects.toThrow(
      'Transaction context already closed',
    );
  });
});

describe('DlsClient real: el stream de acquireLock', () => {
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

  it('espera en la cola y resuelve cuando el lock se concede', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: QUEUED });
      setTimeout(() => call.write({ lockId: '', fencingToken: 0, status: QUEUED }), 60);
      setTimeout(() => {
        call.write({ lockId: 'lock-9', fencingToken: 42, status: ACQUIRED });
        call.end();
      }, 120);
    });

    const lock = await client.acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', { timeoutMs: 5000 });

    expect(lock).toEqual({ lockId: 'lock-9', fencingToken: 42, status: 'ACQUIRED' });
  });

  it('un error a mitad del stream llega tipado y con su codigo', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: QUEUED });
      setTimeout(() => call.emit('error', { code: 10, details: 'la transaccion se aborto' }), 50);
    });

    const inicio = Date.now();
    const error = await client
      .acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', { timeoutMs: 5000 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(DlsError);
    expect(error.code).not.toBe('TIMEOUT');
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it('un stream que termina sin estado terminal no se da por concedido', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: QUEUED });
      setTimeout(() => call.end(), 50);
    });

    const error = await client
      .acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', { timeoutMs: 5000 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(Error);
  });

  it('el AbortSignal corta una espera en curso', async () => {
    engine.onStream('acquireLock', (call) => {
      call.write({ lockId: '', fencingToken: 0, status: QUEUED });
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);

    const error = await client
      .acquireLock('ns', 'k', 'tx-1', 'EXCLUSIVE', { signal: ac.signal, timeoutMs: 5000 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(Error);
  });

  it('el cliente cerrado rechaza en vez de colgarse', async () => {
    const suelto = new DlsClient({ endpoint: engine.endpoint, apiKey: 'k', tls: false });
    suelto.close();

    await expect(suelto.beginTransaction()).rejects.toThrow(DlsError);
  });
});
