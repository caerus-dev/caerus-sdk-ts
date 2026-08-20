import {
  LockMode as GrpcLockMode,
  LockStatus as GrpcLockStatus,
} from '../../generated/dls/dls_service';
import type {
  LockMode,
  LockStatus,
} from '../dls-types';

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
