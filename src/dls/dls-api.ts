import type {
  Transaction,
  LockMode,
  LockHolder,
  BeginTransactionOptions,
  AcquireLockOptions,
  LockStatusResponse,
  TransactionStatusResponse,
} from './dls-types';

export interface DlsApi {
  /**
   * Begins a transaction and returns a unique transaction_id.
   * A transaction serves as the boundary for holding multiple locks.
   */
  beginTransaction(options?: BeginTransactionOptions): Promise<Transaction>;

  /**
   * Acquires a distributed lock.
   * In a queued mode, this method waits until the lock is acquired, denied, or timeouts.
   */
  acquireLock(
    namespace: string,
    lockKey: string,
    transactionId: string,
    mode: LockMode,
    options?: AcquireLockOptions,
  ): Promise<LockHolder>;

  /**
   * Renews an active transaction to extend its time-to-live.
   */
  renewTransaction(transactionId: string, extraMs: number): Promise<Transaction>;

  /**
   * Releases a lock so others can acquire it.
   */
  releaseLock(lockId: string, transactionId: string): Promise<void>;

  /**
   * Releases all locks held or requested by a specific transaction.
   */
  releaseTransactionLocks(transactionId: string): Promise<void>;

  /**
   * Gets the current status of a lock.
   */
  getLockStatus(namespace: string, lockKey: string): Promise<LockStatusResponse>;

  /**
   * Gets the current status of a transaction and its associated locks.
   */
  getTransactionStatus(transactionId: string): Promise<TransactionStatusResponse>;
}
