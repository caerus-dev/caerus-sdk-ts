import { describe, expect, it } from 'vitest';
import {
  assertAcquired,
  decodeFencingToken,
  mapGrpcToLockMode,
  mapGrpcToLockStatus,
  mapLockModeToGrpc,
} from '../src/dls/internal/dls-mapping.js';
import { DlsConflictError, DlsError, LockDeniedError } from '../src/dls/dls-errors.js';

describe('traduccion de modos', () => {
  it('va y vuelve sin perder nada', () => {
    expect(mapGrpcToLockMode(mapLockModeToGrpc('EXCLUSIVE'))).toBe('EXCLUSIVE');
    expect(mapGrpcToLockMode(mapLockModeToGrpc('SHARED_READ'))).toBe('SHARED_READ');
  });

  it('un modo que no existe no se hace pasar por uno valido', () => {
    expect(mapLockModeToGrpc('INVENTADO' as never)).toBe(0);
    expect(mapGrpcToLockMode(99 as never)).toBeUndefined();
  });
});

describe('traduccion de estados', () => {
  it('traduce los tres estados que el motor define', () => {
    expect(mapGrpcToLockStatus(1 as never)).toBe('ACQUIRED');
    expect(mapGrpcToLockStatus(2 as never)).toBe('DENIED');
    expect(mapGrpcToLockStatus(3 as never)).toBe('QUEUED');
  });

  it('lo que no reconoce es UNKNOWN, nunca DENIED', () => {
    expect(mapGrpcToLockStatus(0 as never)).toBe('UNKNOWN');
    expect(mapGrpcToLockStatus(77 as never)).toBe('UNKNOWN');
  });
});

describe('fencing token', () => {
  it('un token real pasa tal cual', () => {
    expect(decodeFencingToken(42)).toBe(42);
    expect(decodeFencingToken('865')).toBe(865);
  });

  it('la ausencia no se convierte en cero', () => {
    expect(decodeFencingToken(0)).toBeUndefined();
    expect(decodeFencingToken('0')).toBeUndefined();
    expect(decodeFencingToken(undefined)).toBeUndefined();
    expect(decodeFencingToken(null)).toBeUndefined();
    expect(decodeFencingToken('no es un numero')).toBeUndefined();
    expect(decodeFencingToken(-1)).toBeUndefined();
  });
});

describe('guarda de lock concedido', () => {
  const holder = (status: string) => ({ lockId: 'l1', status } as never);

  it('deja pasar un lock concedido', () => {
    const concedido = { lockId: 'l1', fencingToken: 3, status: 'ACQUIRED' as const };
    expect(assertAcquired(concedido, 'ns', 'k')).toBe(concedido);
  });

  it('un lock denegado lanza con su codigo', () => {
    const error = (() => {
      try {
        assertAcquired(holder('DENIED'), 'ns', 'k');
      } catch (e) {
        return e as LockDeniedError;
      }
    })();

    expect(error).toBeInstanceOf(LockDeniedError);
    expect(error!.reason).toBe('LOCK_DENIED');
    expect(error!.message).toContain('ns/k');
  });

  it('un estado desconocido dice que no se sabe, no que lo tiene otro', () => {
    const error = (() => {
      try {
        assertAcquired(holder('UNKNOWN'), 'ns', 'k');
      } catch (e) {
        return e as DlsError;
      }
    })();

    expect(error).toBeInstanceOf(DlsError);
    expect(error).not.toBeInstanceOf(LockDeniedError);
    expect(error!.code).toBe('UNKNOWN');
  });

  it('un estado que esta bien pero esta llamada no puede usar tambien corta', () => {
    expect(() => assertAcquired(holder('QUEUED'), 'ns', 'k')).toThrow(DlsConflictError);
  });
});
