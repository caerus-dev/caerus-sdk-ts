import {
  LockMode as GrpcLockMode,
  LockStatus as GrpcLockStatus,
} from '../../generated/dls/dls_service';
import type {
  LockHolder,
  LockMode,
  LockStatus,
} from '../dls-types';
import { DlsConflictError, LockDeniedError } from '../dls-errors.js';

export function mapLockModeToGrpc(mode: LockMode): GrpcLockMode {
  switch (mode) {
    case 'EXCLUSIVE':
      return GrpcLockMode.EXCLUSIVE;
    case 'SHARED_READ':
      return GrpcLockMode.SHARED_READ;
    default:
      return GrpcLockMode.MODE_UNSPECIFIED;
  }
}

export function mapGrpcToLockMode(mode: GrpcLockMode): LockMode | undefined {
  switch (mode) {
    case GrpcLockMode.EXCLUSIVE:
      return 'EXCLUSIVE';
    case GrpcLockMode.SHARED_READ:
      return 'SHARED_READ';
    default:
      return undefined;
  }
}

export function mapGrpcToLockStatus(status: GrpcLockStatus): LockStatus {
  switch (status) {
    case GrpcLockStatus.ACQUIRED:
      return 'ACQUIRED';
    case GrpcLockStatus.DENIED:
      return 'DENIED';
    case GrpcLockStatus.QUEUED:
      return 'QUEUED';
    default:
      // Assuming DENIED for unexpected values to err on the side of safety
      return 'DENIED';
  }
}

export function decodeFencingToken(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

export function assertAcquired(
  holder: LockHolder,
  namespace: string,
  lockKey: string,
): LockHolder {
  if (holder.status === 'ACQUIRED') return holder;
  if (holder.status === 'DENIED') {
    throw new LockDeniedError(
      `Caerus denied the lock on ${namespace}/${lockKey}: it is already held by another transaction.`,
      { reason: 'LOCK_DENIED' },
    );
  }
  throw new DlsConflictError(
    `Caerus returned the lock on ${namespace}/${lockKey} as ${holder.status}, which this call cannot use.`,
  );
}
