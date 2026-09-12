import { status as GrpcStatus } from '@grpc/grpc-js';
import { CaerusError, type CaerusErrorCode } from '../errors.js';
import { reasonOf } from '../internal/error-details.js';

export type DlsErrorCode = CaerusErrorCode;

export class DlsError extends CaerusError {}

export class DlsNotFoundError extends DlsError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'RESOURCE_NOT_FOUND', options);
  }
}

export class DlsConflictError extends DlsError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'CONFLICT', options);
  }
}

export class DlsValidationError extends DlsError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'VALIDATION', options);
  }
}

export class DlsAuthenticationError extends DlsError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'AUTHENTICATION', options);
  }
}

export class DlsTimeoutError extends DlsError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'TIMEOUT', options);
  }
}

export class DeadlockAbortedError extends DlsConflictError {}

export class LockDeniedError extends DlsConflictError {}

export class LockAlreadyHeldError extends DlsConflictError {}

export class TransactionNotActiveError extends DlsConflictError {}

export class LockModeMismatchError extends DlsValidationError {}

export class LockAcquisitionCancelledError extends DlsError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'UNKNOWN', options);
  }
}

type DlsErrorConstructor = new (
  message: string,
  options?: { cause?: unknown; reason?: string },
) => DlsError;

const BY_REASON: Record<string, DlsErrorConstructor | undefined> = {
  DEADLOCK_DETECTED: DeadlockAbortedError,
  LOCK_DENIED: LockDeniedError,
  LOCK_ALREADY_HELD_EXCLUSIVELY: LockAlreadyHeldError,
  LOCK_MODE_MISMATCH: LockModeMismatchError,
  TRANSACTION_NOT_ACTIVE: TransactionNotActiveError,
  LOCK_ACQUISITION_CANCELLED: LockAcquisitionCancelledError,
};

interface GrpcLikeError {
  code?: number;
  details?: string;
  message?: string;
}

export function toDlsError(error: unknown): DlsError {
  if (error instanceof DlsError) {
    return error;
  }

  const grpcError = error as GrpcLikeError;
  const message = grpcError?.details || grpcError?.message || 'DLS call failed';
  const reason = reasonOf(error);
  const options = { cause: error, reason };

  const ByReason = reason ? BY_REASON[reason] : undefined;
  if (ByReason) {
    return new ByReason(message, options);
  }

  switch (grpcError?.code) {
    case GrpcStatus.NOT_FOUND:
      return new DlsNotFoundError(message, options);
    case GrpcStatus.ALREADY_EXISTS:
      return new LockAlreadyHeldError(message, options);
    case GrpcStatus.ABORTED:
    case GrpcStatus.FAILED_PRECONDITION:
      return new DlsConflictError(message, options);
    case GrpcStatus.INVALID_ARGUMENT:
      return new DlsValidationError(message, options);
    case GrpcStatus.UNAUTHENTICATED:
      return new DlsAuthenticationError(message, options);
    case GrpcStatus.DEADLINE_EXCEEDED:
      return new DlsTimeoutError(message, options);
    case GrpcStatus.CANCELLED:
      return new LockAcquisitionCancelledError(message, options);
    default:
      return new DlsError(message, 'UNKNOWN', options);
  }
}
