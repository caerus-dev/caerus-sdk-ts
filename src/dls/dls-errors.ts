import { status as GrpcStatus } from '@grpc/grpc-js';

export type DlsErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'TIMEOUT'
  | 'UNKNOWN';

export class DlsError extends Error {
  readonly code: DlsErrorCode;

  constructor(message: string, code: DlsErrorCode = 'UNKNOWN', options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DlsNotFoundError extends DlsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'NOT_FOUND', options);
  }
}

export class DlsConflictError extends DlsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'CONFLICT', options);
  }
}

export class DlsValidationError extends DlsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'VALIDATION', options);
  }
}

export class DlsAuthenticationError extends DlsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'AUTHENTICATION', options);
  }
}

export class DlsTimeoutError extends DlsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'TIMEOUT', options);
  }
}

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
  const options = { cause: error };

  switch (grpcError?.code) {
    case GrpcStatus.NOT_FOUND:
      return new DlsNotFoundError(message, options);
    case GrpcStatus.FAILED_PRECONDITION:
      return new DlsConflictError(message, options);
    case GrpcStatus.INVALID_ARGUMENT:
      return new DlsValidationError(message, options);
    case GrpcStatus.UNAUTHENTICATED:
      return new DlsAuthenticationError(message, options);
    case GrpcStatus.DEADLINE_EXCEEDED:
      return new DlsTimeoutError(message, options);
    default:
      return new DlsError(message, 'UNKNOWN', options);
  }
}
