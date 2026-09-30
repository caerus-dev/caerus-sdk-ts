export type LockMode = 'EXCLUSIVE' | 'SHARED_READ';

export type LockStatus = 'ACQUIRED' | 'DENIED' | 'QUEUED' | 'UNKNOWN';

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
  fencingToken?: number;
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
  /**
   * Optional idempotency key for safe retries.
   * Required if the template was configured with `fencingTokenRequired = true`.
   */
  idempotencyKey?: string;

  /**
   * AbortSignal to cancel waiting for the lock before it is granted.
   */
  signal?: AbortSignal;

  /**
   * Maximum deadline in milliseconds to wait for this specific acquisition.
   */
  timeoutMs?: number;

  /**
   * Callback opcional que se invoca cuando la solicitud entra efectivamente a la cola de espera de ZooKeeper.
   *
   * Solo con estrategia `QUEUE`; no se dispara en `FAIL` ni `RETRY`. Avisa una sola vez y nunca después
   * de conceder el lock. Con `QUEUE` el motor encola todo pedido, así que también avisa cuando el lock
   * estaba libre y se concede enseguida.
   */
  onQueued?: () => void;
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
