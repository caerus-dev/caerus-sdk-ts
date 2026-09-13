import { describe, expect, it } from 'vitest';
import { CaerusError, OutOfStockError, toCaerusError } from '../src/sre/errors.js';
import { DlsError, LockDeniedError, toDlsError } from '../src/dls/dls-errors.js';
import { requestIdOf } from '../src/internal/error-details.js';

describe('requestIdOf extraction from gRPC metadata', () => {
  it('extracts request ID when metadata.get returns a string', () => {
    const error = {
      metadata: {
        get: (key: string) => (key === 'x-request-id' ? 'req_abc-123' : undefined),
      },
    };
    expect(requestIdOf(error)).toBe('req_abc-123');
  });

  it('extracts request ID when metadata.get returns an array of strings', () => {
    const error = {
      metadata: {
        get: (key: string) => (key === 'x-request-id' ? ['req_from-array-456'] : []),
      },
    };
    expect(requestIdOf(error)).toBe('req_from-array-456');
  });

  it('extracts request ID when metadata.get returns a Uint8Array buffer', () => {
    const error = {
      metadata: {
        get: (key: string) =>
          key === 'x-request-id' ? [new TextEncoder().encode('req_from-bytes-789')] : [],
      },
    };
    expect(requestIdOf(error)).toBe('req_from-bytes-789');
  });

  it('returns undefined when metadata has no x-request-id', () => {
    const error = {
      metadata: {
        get: () => [],
      },
    };
    expect(requestIdOf(error)).toBeUndefined();
  });

  it('returns undefined when error has no metadata', () => {
    expect(requestIdOf(new Error('Simple error'))).toBeUndefined();
    expect(requestIdOf(null)).toBeUndefined();
  });
});

describe('CaerusError enriched messaging and docUrl', () => {
  it('enriches error message with Request ID and Discord support copy', () => {
    const error = new CaerusError('Stock exhausted', 'CONFLICT', {
      reason: 'OUT_OF_STOCK',
      requestId: 'req_3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(error.requestId).toBe('req_3fa85f64-5717-4562-b3fc-2c963f66afa6');
    expect(error.reason).toBe('OUT_OF_STOCK');
    expect(error.message).toContain('Stock exhausted');
    expect(error.message).toContain('(Request ID: req_3fa85f64-5717-4562-b3fc-2c963f66afa6)');
    expect(error.message).toContain('Contacta soporte en Discord con este ID.');
  });

  it('does not duplicate request ID if already in message', () => {
    const error = new CaerusError(
      'Failed (Request ID: req_123). Contacta soporte en Discord con este ID.',
      'UNKNOWN',
      { requestId: 'req_123' },
    );
    const count = (error.message.match(/req_123/g) || []).length;
    expect(count).toBe(1);
  });

  it('provides docUrl linking to the canonical docs/errores.md guide', () => {
    const sreError = new OutOfStockError('Out of stock', { reason: 'OUT_OF_STOCK' });
    expect(sreError.docUrl).toBe('https://github.com/caerus-dev/caerus-sdk-ts/blob/main/docs/errores.md');

    const genericError = new CaerusError('Something failed');
    expect(genericError.docUrl).toBe('https://github.com/caerus-dev/caerus-sdk-ts/blob/main/docs/errores.md');
  });
});

describe('toCaerusError and toDlsError request ID propagation', () => {
  it('propagates server trailer requestId to SRE error', () => {
    const grpcErr = {
      code: 9,
      details: 'Out of stock for resource: seats',
      metadata: {
        get: (key: string) => (key === 'x-request-id' ? ['req_server-trailer-001'] : []),
      },
    };

    const err = toCaerusError(grpcErr, 'req_client-fallback-999');
    expect(err.requestId).toBe('req_server-trailer-001');
    expect(err.message).toContain('req_server-trailer-001');
  });

  it('falls back to clientRequestId when server trailer is missing (e.g. timeout / network fault)', () => {
    const networkErr = {
      code: 4, // DEADLINE_EXCEEDED
      details: 'Deadline exceeded',
      metadata: {
        get: () => [],
      },
    };

    const err = toCaerusError(networkErr, 'req_client-timeout-123');
    expect(err.requestId).toBe('req_client-timeout-123');
    expect(err.message).toContain('req_client-timeout-123');
  });

  it('propagates server trailer requestId to DLS error', () => {
    const grpcErr = {
      code: 9,
      details: 'Lock denied: lock already held',
      metadata: {
        get: (key: string) => (key === 'x-request-id' ? 'req_dls-server-777' : undefined),
      },
    };

    const err = toDlsError(grpcErr, 'req_dls-client-fallback');
    expect(err).toBeInstanceOf(DlsError);
    expect(err.requestId).toBe('req_dls-server-777');
    expect(err.message).toContain('req_dls-server-777');
  });

  it('falls back to clientRequestId in DLS when server metadata is missing', () => {
    const networkErr = new Error('Connection refused');
    const err = toDlsError(networkErr, 'req_dls-client-timeout');
    expect(err.requestId).toBe('req_dls-client-timeout');
    expect(err.message).toContain('req_dls-client-timeout');
  });
});
