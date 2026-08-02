import { status as GrpcStatus } from '@grpc/grpc-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  CaerusError,
  ConflictError,
  ResourceNotFoundError,
  TimeoutError,
  ValidationError,
} from '../src/errors.js';
import { Transport } from '../src/internal/transport.js';
import { resolveOptions } from '../src/options.js';
import { aResourceResponse, startFakeEngine, type FakeEngine } from './helpers/fake-engine.js';

const API_KEY = 'no-es-una-clave';

describe('the transport, against a real gRPC server', () => {
  let engine: FakeEngine;
  let transport: Transport;

  beforeAll(async () => {
    engine = await startFakeEngine();
  });

  afterAll(async () => {
    transport?.close();
    await engine.stop();
  });

  beforeEach(() => {
    transport?.close();
    transport = new Transport(
      resolveOptions({ endpoint: engine.endpoint, apiKey: API_KEY, tls: false }),
    );
  });

  function getResource() {
    return transport.unary(transport.raw.getResource.bind(transport.raw), { key: 'seat_A12' });
  }

  it('sends the API Key as a bearer token in the metadata', async () => {
    engine.respondWith((_call, callback) => callback(null, aResourceResponse()));

    await getResource();

    expect(engine.lastMetadata?.get('authorization')).toEqual([`Bearer ${API_KEY}`]);
  });

  /** The environment comes from the key, so nothing else should be identifying it. */
  it('sends no environment of its own', async () => {
    engine.respondWith((_call, callback) => callback(null, aResourceResponse()));

    await getResource();

    expect(engine.lastMetadata?.get('environment_id')).toEqual([]);
    expect(engine.lastMetadata?.get('environment')).toEqual([]);
  });

  it('turns a NOT_FOUND from the server into ResourceNotFoundError', async () => {
    engine.respondWith((_call, callback) =>
      callback({
        code: GrpcStatus.NOT_FOUND,
        details: 'Resource not found: seat_A12',
        metadata: undefined,
      } as never),
    );

    const error = await getResource().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect(error).toBeInstanceOf(CaerusError);
    expect((error as CaerusError).code).toBe('RESOURCE_NOT_FOUND');
    // The server's own wording survives, rather than being replaced by ours.
    expect((error as CaerusError).message).toBe('Resource not found: seat_A12');
  });

  /**
   * The table comes from the server's GrpcGlobalExceptionHandler, not from a generic
   * gRPC convention: FAILED_PRECONDITION is what Caerus returns for an invalid state,
   * running out of stock included.
   */
  it.each([
    [GrpcStatus.FAILED_PRECONDITION, ConflictError, 'CONFLICT'],
    [GrpcStatus.INVALID_ARGUMENT, ValidationError, 'VALIDATION'],
    [GrpcStatus.UNAUTHENTICATED, AuthenticationError, 'AUTHENTICATION'],
  ])('maps status %i to the matching error', async (code, expected, expectedCode) => {
    engine.respondWith((_call, callback) =>
      callback({ code, details: 'from the server', metadata: undefined } as never),
    );

    const error = await getResource().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(expected);
    expect((error as CaerusError).code).toBe(expectedCode);
    expect((error as CaerusError).message).toBe('from the server');
  });

  /** INTERNAL always arrives opaque: the server refuses to describe its own failures. */
  it('leaves anything else as the base error', async () => {
    engine.respondWith((_call, callback) =>
      callback({
        code: GrpcStatus.INTERNAL,
        details: 'Unexpected gRPC error',
        metadata: undefined,
      } as never),
    );

    const error = await getResource().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CaerusError);
    expect(error).not.toBeInstanceOf(ConflictError);
    expect((error as CaerusError).code).toBe('UNKNOWN');
  });

  it('gives up on a call that runs past its deadline', async () => {
    // Never answers, so only the deadline can end this call.
    engine.respondWith(() => {});

    const impatient = new Transport(
      resolveOptions({ endpoint: engine.endpoint, apiKey: API_KEY, tls: false, timeoutMs: 150 }),
    );

    const error = await impatient
      .unary(impatient.raw.getResource.bind(impatient.raw), { key: 'seat_A12' })
      .catch((caught: unknown) => caught);
    impatient.close();

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as CaerusError).code).toBe('TIMEOUT');
  });

  it('rejects calls made after it is closed', async () => {
    transport.close();

    const error = await getResource().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CaerusError);
  });
});
