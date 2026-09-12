import { describe, expect, it } from 'vitest';

import { CaerusError } from '../src/errors.js';
import {
  DeadlockAbortedError,
  DlsConflictError,
  DlsError,
  LockDeniedError,
  toDlsError,
} from '../src/dls/dls-errors.js';
import { reasonOf } from '../src/internal/error-details.js';

const REALES = {
  DEADLOCK_DETECTED:
    'CAoSR1RyYW5zYWN0aW9uIGYzZDIzOWY2LWFiNWItNDkzNi05NDc3LThhYzQ5ZDMyZDA2YyBtYXJrZWQgQUJPUlRfUkVRVUVTVEVEGksKKHR5cGUuZ29vZ2xlYXBpcy5jb20vZ29vZ2xlLnJwYy5FcnJvckluZm8SHwoRREVBRExPQ0tfREVURUNURUQSCmNhZXJ1cy5kZXY=',
} as const;

function grpcError(code: number, message: string, detalle?: string) {
  return {
    code,
    details: message,
    message: `${code} ${message}`,
    metadata: {
      get: (key: string) =>
        key === 'grpc-status-details-bin' && detalle ? [Buffer.from(detalle, 'base64')] : [],
    },
  };
}

describe('errores del DLS', () => {
  it('un aborto por deadlock del motor real llega tipado y con su codigo', () => {
    const crudo = grpcError(
      10,
      'Transaction f3d239f6-ab5b-4936-9477-8ac49d32d06c marked ABORT_REQUESTED',
      REALES.DEADLOCK_DETECTED,
    );

    const error = toDlsError(crudo);

    expect(error).toBeInstanceOf(DeadlockAbortedError);
    expect(error.reason).toBe('DEADLOCK_DETECTED');
    expect(error.code).toBe('CONFLICT');
  });

  it('el trailer capturado del motor sigue decodificando', () => {
    expect(reasonOf(grpcError(10, 'x', REALES.DEADLOCK_DETECTED))).toBe('DEADLOCK_DETECTED');
  });

  it('todo error del DLS se puede atrapar como CaerusError', () => {
    const errores = [
      toDlsError(grpcError(10, 'abortada', REALES.DEADLOCK_DETECTED)),
      toDlsError(grpcError(5, 'no existe')),
      toDlsError(grpcError(3, 'argumento malo')),
      toDlsError(grpcError(16, 'sin credenciales')),
      toDlsError(grpcError(4, 'se paso el tiempo')),
      toDlsError(grpcError(6, 'ya tomado')),
      new LockDeniedError('denegado'),
    ];

    for (const error of errores) {
      expect(error).toBeInstanceOf(CaerusError);
      expect(error).toBeInstanceOf(DlsError);
    }
  });

  it('un ABORTED sin reason cae en el conflicto generico y no se pierde', () => {
    const error = toDlsError(grpcError(10, 'algo pasó'));

    expect(error).toBeInstanceOf(DlsConflictError);
    expect(error).not.toBeInstanceOf(DeadlockAbortedError);
    expect(error.reason).toBeUndefined();
  });

  it('un error que ya es del DLS pasa sin envolverse de nuevo', () => {
    const original = new DeadlockAbortedError('victima', { reason: 'DEADLOCK_DETECTED' });

    expect(toDlsError(original)).toBe(original);
  });
});
