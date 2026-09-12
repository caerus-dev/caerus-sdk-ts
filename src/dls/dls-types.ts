export type LockMode = 'EXCLUSIVE' | 'SHARED_READ';

export type LockStatus = 'ACQUIRED' | 'DENIED' | 'QUEUED';

export interface Transaction {
  transactionId: string;
}

export interface LockHolder {
  lockId: string;
  fencingToken?: number;
  status: LockStatus;
}

export interface ActiveLockHolder {
  lockId: string;
  expiresAt: number;
  fencingToken: number;
}

export interface LockStatusResponse {
  isHeld: boolean;
  currentMode?: LockMode;
  activeHolders: ActiveLockHolder[];
  pendingQueueSize: number;
}

export interface TransactionLockInfo {
  namespace: string;
  lockKey: string;
  requestedMode: LockMode;
  status: LockStatus;
}

export interface TransactionStatusResponse {
  status: string;
  abortReason?: string;
  locks: TransactionLockInfo[];
  expiresAt: number;
}

export interface BeginTransactionOptions {
  timeoutMs?: number;
}

export interface AcquireLockOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TransactionOptions {
  timeoutMs?: number;
  autoRenew?: boolean;
  signal?: AbortSignal;
  onTransactionLost?: (error: Error) => void;
}

export interface TransactionContext {
  readonly transactionId: string;
  readonly signal: AbortSignal;
  acquireLock(
    namespace: string,
    lockKey: string,
    mode: LockMode,
    options?: AcquireLockOptions,
  ): Promise<LockHolder>;
  renewTransaction(extraMs: number): Promise<Transaction>;
}
