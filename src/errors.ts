import { status as GrpcStatus } from '@grpc/grpc-js';

/**
 * What went wrong, as a value you can switch on.
 *
 * These are strings rather than gRPC's numeric codes on purpose: a user of this package
 * should never need to learn gRPC to handle an error, and the same names carry over to
 * the SDKs coming in other languages.
 */
export type CaerusErrorCode =
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'TIMEOUT'
  | 'UNKNOWN';

/** Every error this package throws extends this one, so `catch` can take them together. */
export class CaerusError extends Error {
  readonly code: CaerusErrorCode;

  constructor(message: string, code: CaerusErrorCode = 'UNKNOWN', options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    // Without this, `instanceof` breaks for anyone consuming the CommonJS build from a
    // project that targets ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The resource, template or holder does not exist. */
export class ResourceNotFoundError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'RESOURCE_NOT_FOUND', options);
  }
}

/**
 * The state does not allow the operation.
 *
 * This covers running out of stock, and also confirming a holder that was already
 * confirmed or releasing one that expired. The engine reports all of them as
 * FAILED_PRECONDITION, so the SDK cannot tell them apart without reading the message
 * text, which would break the first time the wording changes.
 */
export class ConflictError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'CONFLICT', options);
  }
}

/** The request itself was rejected: a bad key, a non-positive amount, and so on. */
export class ValidationError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'VALIDATION', options);
  }
}

/** The API Key is missing, malformed, unknown or revoked. */
export class AuthenticationError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'AUTHENTICATION', options);
  }
}

/** The call ran past its deadline. Whether the server did the work is unknown. */
export class TimeoutError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'TIMEOUT', options);
  }
}

/**
 * Anything that reaches the client carrying a gRPC status.
 *
 * Not a general gRPC convention: this mirrors what the server actually does in
 * GrpcGlobalExceptionHandler. Every other status, INTERNAL included, lands on the base
 * class, and INTERNAL always arrives with the same opaque "Unexpected gRPC error"
 * because the server refuses to leak its internals.
 */
interface GrpcLikeError {
  code?: number;
  details?: string;
  message?: string;
}

export function toCaerusError(error: unknown): CaerusError {
  if (error instanceof CaerusError) {
    return error;
  }

  const grpcError = error as GrpcLikeError;
  // details carries the server's description; message prefixes it with the status name.
  const message = grpcError?.details || grpcError?.message || 'Caerus call failed';
  const options = { cause: error };

  switch (grpcError?.code) {
    case GrpcStatus.NOT_FOUND:
      return new ResourceNotFoundError(message, options);
    case GrpcStatus.FAILED_PRECONDITION:
      return new ConflictError(message, options);
    case GrpcStatus.INVALID_ARGUMENT:
      return new ValidationError(message, options);
    case GrpcStatus.UNAUTHENTICATED:
      return new AuthenticationError(message, options);
    case GrpcStatus.DEADLINE_EXCEEDED:
      return new TimeoutError(message, options);
    default:
      return new CaerusError(message, 'UNKNOWN', options);
  }
}
