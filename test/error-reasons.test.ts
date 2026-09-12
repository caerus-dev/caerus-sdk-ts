import { describe, expect, it } from 'vitest';

import {
  CaerusError,
  ConflictError,
  HolderNotActiveError,
  OutOfStockError,
  ResourceHasActiveHoldsError,
  ResourceNotFoundError,
  toCaerusError,
} from '../src/sre/errors.js';
import { decodeReason, reasonOf } from '../src/internal/error-details.js';

/**
 * Captured off the wire from the deployed engine, not written by hand. If the server
 * ever changes the shape of what it sends, these stop matching and the tests say so.
 */
const REALES = {
  OUT_OF_STOCK:
    'CAkSLk91dCBvZiBzdG9jayBmb3IgcmVzb3VyY2U6IGZ1bmNpb25ob3Jpem9udGVfRTgaRgoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIaCgxPVVRfT0ZfU1RPQ0sSCmNhZXJ1cy5kZXY=',
  HOLDER_NOT_ACTIVE:
    'CAkSNVJlc291cmNlSG9sZGVyIGlzIG5vdCBpbiBhIHZhbGlkIHN0YXRlIHRvIGJlIGV4dGVuZGVkGksKKHR5cGUuZ29vZ2xlYXBpcy5jb20vZ29vZ2xlLnJwYy5FcnJvckluZm8SHwoRSE9MREVSX05PVF9BQ1RJVkUSCmNhZXJ1cy5kZXY=',
  RESOURCE_NOT_FOUND:
    'CAUSLlJlc291cmNlIG5vdCBmb3VuZCB3aXRoIGlkOiBub19leGlzdGVfamFtYXNfenoaTAoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxIgChJSRVNPVVJDRV9OT1RfRk9VTkQSCmNhZXJ1cy5kZXY=',
  TEMPLATE_NOT_FOUND:
    'CAUSNlRlbXBsYXRlIG5vdCBmb3VuZCB3aXRoIG5hbWU6IHBsYW50aWxsYV9pbmV4aXN0ZW50ZV96ehpMCih0eXBlLmdvb2dsZWFwaXMuY29tL2dvb2dsZS5ycGMuRXJyb3JJbmZvEiAKElRFTVBMQVRFX05PVF9GT1VORBIKY2FlcnVzLmRldg==',
  RESOURCE_HAS_ACTIVE_HOLDS:
    'CAkSPUNhbm5vdCBkZWxldGUgcmVzb3VyY2Ugd2l0aCBhY3RpdmUgaG9sZHM6IGZ1bmNpb25ob3Jpem9udGVfRTcaUwoodHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUucnBjLkVycm9ySW5mbxInChlSRVNPVVJDRV9IQVNfQUNUSVZFX0hPTERTEgpjYWVydXMuZGV2',
} as const;

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

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

describe('reading the reason the engine sent', () => {
  for (const [esperado, payload] of Object.entries(REALES)) {
    it(`decodes ${esperado} from a real trailer`, () => {
      expect(decodeReason(bytes(payload))).toBe(esperado);
    });
  }

  it('pulls the reason out of a gRPC error', () => {
    expect(reasonOf(grpcError(9, 'nope', REALES.OUT_OF_STOCK))).toBe('OUT_OF_STOCK');
  });

  it('says nothing when there is no trailer', () => {
    expect(reasonOf(grpcError(9, 'nope'))).toBeUndefined();
  });
});

describe('the decoder refuses to become a second failure', () => {
  const basura: [string, Uint8Array][] = [
    ['empty', new Uint8Array()],
    ['a single stray byte', new Uint8Array([0x1a])],
    ['a length that runs past the end', new Uint8Array([0x1a, 0x7f, 0x01])],
    ['random noise', new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])],
    ['a truncated real trailer', bytes(REALES.OUT_OF_STOCK).subarray(0, 20)],
    ['every byte set', new Uint8Array(64).fill(0xff)],
  ];

  for (const [nombre, entrada] of basura) {
    it(`returns undefined for ${nombre}`, () => {
      expect(() => decodeReason(entrada)).not.toThrow();
      expect(decodeReason(entrada)).toBeUndefined();
    });
  }

  it('survives an error with no metadata at all', () => {
    expect(reasonOf({ code: 9 })).toBeUndefined();
    expect(reasonOf(null)).toBeUndefined();
    expect(reasonOf('not an error')).toBeUndefined();
  });
});

describe('the error you catch', () => {
  it('turns OUT_OF_STOCK into OutOfStockError', () => {
    const error = toCaerusError(grpcError(9, 'Out of stock', REALES.OUT_OF_STOCK));

    expect(error).toBeInstanceOf(OutOfStockError);
    expect(error.reason).toBe('OUT_OF_STOCK');
  });

  it('turns HOLDER_NOT_ACTIVE into HolderNotActiveError', () => {
    const error = toCaerusError(grpcError(9, 'not active', REALES.HOLDER_NOT_ACTIVE));

    expect(error).toBeInstanceOf(HolderNotActiveError);
    expect(error.reason).toBe('HOLDER_NOT_ACTIVE');
  });

  it('turns RESOURCE_HAS_ACTIVE_HOLDS into its own class', () => {
    const error = toCaerusError(grpcError(9, 'busy', REALES.RESOURCE_HAS_ACTIVE_HOLDS));

    expect(error).toBeInstanceOf(ResourceHasActiveHoldsError);
  });

  it('keeps catching every one of them as ConflictError', () => {
    for (const payload of [
      REALES.OUT_OF_STOCK,
      REALES.HOLDER_NOT_ACTIVE,
      REALES.RESOURCE_HAS_ACTIVE_HOLDS,
    ]) {
      const error = toCaerusError(grpcError(9, 'x', payload));
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toBeInstanceOf(CaerusError);
      expect(error.code).toBe('CONFLICT');
    }
  });

  it('falls back to a plain ConflictError when the reason is unknown', () => {
    const error = toCaerusError(grpcError(9, 'something new', REALES.OUT_OF_STOCK.slice(0, 12)));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(OutOfStockError);
  });

  it('falls back when the engine sends no reason at all', () => {
    const error = toCaerusError(grpcError(9, 'old engine'));

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(OutOfStockError);
    expect(error.reason).toBeUndefined();
  });

  it('carries the reason on statuses that have no subclass', () => {
    const error = toCaerusError(grpcError(5, 'no template', REALES.TEMPLATE_NOT_FOUND));

    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect(error.reason).toBe('TEMPLATE_NOT_FOUND');
  });

  it('keeps the message the engine wrote', () => {
    const error = toCaerusError(grpcError(9, 'Out of stock for resource: seat_A12', REALES.OUT_OF_STOCK));

    expect(error.message).toBe('Out of stock for resource: seat_A12');
  });
});
