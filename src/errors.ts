import { status as GrpcStatus } from '@grpc/grpc-js';

import { reasonOf } from './internal/error-details.js';

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
  /**
   * The engine's own name for what happened, when it sent one: OUT_OF_STOCK,
   * HOLDER_NOT_ACTIVE and so on. Stable across releases and safe to switch on, unlike
   * the message, which is written for people.
   */
  readonly reason?: string;

  constructor(
    message: string,
    code: CaerusErrorCode = 'UNKNOWN',
    options?: { cause?: unknown; reason?: string },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.reason = options?.reason;
    // Without this, `instanceof` breaks for anyone consuming the CommonJS build from a
    // project that targets ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The resource, template or holder does not exist. */
export class ResourceNotFoundError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'RESOURCE_NOT_FOUND', options);
  }
}

/**
 * The state does not allow the operation.
 *
 * This covers running out of stock, confirming a holder that was already confirmed,
 * and deleting a resource somebody is still holding. They all arrive as
 * FAILED_PRECONDITION, so the subclasses below exist to tell them apart: catching
 * ConflictError still catches every one of them.
 */
export class ConflictError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'CONFLICT', options);
  }
}

/** Nothing left to take: the resource has fewer units free than you asked for. */
export class OutOfStockError extends ConflictError {}

/**
 * The holder is no longer usable — released, confirmed or expired.
 *
 * The surprising way to get here is an idempotency key whose holder already finished:
 * the engine replays it, correctly, and there is nothing being held.
 */
export class HolderNotActiveError extends ConflictError {}

/** The resource cannot be deleted because somebody is still holding part of it. */
export class ResourceHasActiveHoldsError extends ConflictError {}

/** The resource cannot be deleted because somebody is still waiting in its queue. */
export class ResourceHasQueuedRequestsError extends ConflictError {}

/** The request itself was rejected: a bad key, a non-positive amount, and so on. */
export class ValidationError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'VALIDATION', options);
  }
}

/** The API Key is missing, malformed, unknown or revoked. */
export class AuthenticationError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'AUTHENTICATION', options);
  }
}

/** The call ran past its deadline. Whether the server did the work is unknown. */
export class TimeoutError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
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

type ConflictConstructor = new (
  message: string,
  options?: { cause?: unknown; reason?: string },
) => ConflictError;

const CONFLICT_BY_REASON: Record<string, ConflictConstructor | undefined> = {
  OUT_OF_STOCK: OutOfStockError,
  HOLDER_NOT_ACTIVE: HolderNotActiveError,
  RESOURCE_HAS_ACTIVE_HOLDS: ResourceHasActiveHoldsError,
  RESOURCE_HAS_QUEUED_REQUESTS: ResourceHasQueuedRequestsError,
};

export function toCaerusError(error: unknown): CaerusError {
  if (error instanceof CaerusError) {
    return error;
  }

  const grpcError = error as GrpcLikeError;
  // details carries the server's description; message prefixes it with the status name.
  const message = grpcError?.details || grpcError?.message || 'Caerus call failed';
  const reason = reasonOf(error);
  const options = { cause: error, reason };

  switch (grpcError?.code) {
    case GrpcStatus.NOT_FOUND:
      return new ResourceNotFoundError(message, options);
    case GrpcStatus.FAILED_PRECONDITION: {
      const Conflict = CONFLICT_BY_REASON[reason ?? ''] ?? ConflictError;
      return new Conflict(message, options);
    }
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
