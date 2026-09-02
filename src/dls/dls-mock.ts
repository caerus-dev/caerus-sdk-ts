import type {
  DlsApi,
} from './dls-api';
import type {
  Transaction,
  LockMode,
  LockHolder,
  BeginTransactionOptions,
  AcquireLockOptions,
  LockStatusResponse,
  TransactionStatusResponse,
} from './dls-types';
import {
  DlsNotFoundError,
  DlsConflictError,
  DlsValidationError,
} from './dls-errors';

interface MockLockState {
  lockId: string;
  transactionId: string;
  namespace: string;
  lockKey: string;
  mode: LockMode;
  expiresAt: number;
}

export class InMemoryDlsClient implements DlsApi {
  private activeTransactions = new Set<string>();
  private locks = new Map<string, MockLockState[]>();
  private txExpiration = new Map<string, number>();

  private nextLockId = 1;
  private nextFencingToken = 1000;

  async beginTransaction(options?: BeginTransactionOptions): Promise<Transaction> {
    const transactionId = `tx-mock-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.activeTransactions.add(transactionId);
    if (options?.timeoutMs) {
      this.txExpiration.set(transactionId, Date.now() + options.timeoutMs);
    } else {
      this.txExpiration.set(transactionId, Date.now() + 10000); // default mock TTL
    }
    return { transactionId };
  }

  async withTransaction<T>(
    callback: (tx: import('./dls-types').TransactionContext) => Promise<T>,
    options?: import('./dls-types').TransactionOptions
  ): Promise<T> {
    const tx = await this.beginTransaction({ timeoutMs: options?.timeoutMs });
    const txId = tx.transactionId;
    let isClosed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const autoRenew = options?.autoRenew ?? true;
    if (autoRenew) {
      const intervalMs = Math.max(1000, (options?.timeoutMs || 10000) / 2);
      heartbeatTimer = setInterval(() => {
        if (!isClosed) {
          this.renewTransaction(txId, options?.timeoutMs || 10000).catch(() => {});
        }
      }, intervalMs);
    }

    const context: import('./dls-types').TransactionContext = {
      transactionId: txId,
      acquireLock: async (namespace, lockKey, mode, acquireOpts) => {
        if (isClosed) {
          throw new Error('Transaction context already closed');
        }
        const signal = acquireOpts?.signal || options?.signal;
        const mergedOpts = { ...acquireOpts, signal };
        return this.acquireLock(namespace, lockKey, txId, mode, mergedOpts);
      },
      renewTransaction: async (extraMs) => {
        if (isClosed) {
          throw new Error('Transaction context already closed');
        }
        return this.renewTransaction(txId, extraMs);
      }
    };

    try {
      return await callback(context);
    } finally {
      isClosed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await this.releaseTransactionLocks(txId).catch(() => {});
    }
  }

  async acquireLock(
    namespace: string,
    lockKey: string,
    transactionId: string,
    mode: LockMode,
    options?: AcquireLockOptions
  ): Promise<LockHolder> {
    if (options?.signal?.aborted) {
      throw new Error('AcquireLock aborted by user');
    }

    if (!this.activeTransactions.has(transactionId)) {
      throw new DlsNotFoundError('Transaction not found or expired');
    }

    const key = `${namespace}:${lockKey}`;
    const holders = this.locks.get(key) || [];

    // Filter out expired locks
    const now = Date.now();
    const activeHolders = holders.filter(h => h.expiresAt > now);

    // Conflict detection
    if (activeHolders.length > 0) {
      if (mode === 'EXCLUSIVE' || activeHolders.some(h => h.mode === 'EXCLUSIVE')) {
        // Return DENIED instead of throwing ConflictError, based on the protocol
        return {
          lockId: '',
          fencingToken: 0,
          status: 'DENIED',
        };
      }
    }

    const lockId = `lock-mock-${this.nextLockId++}`;
    const fencingToken = this.nextFencingToken++;

    const newLock: MockLockState = {
      lockId,
      transactionId,
      namespace,
      lockKey,
      mode,
      expiresAt: this.txExpiration.get(transactionId) || (now + 10000),
    };

    activeHolders.push(newLock);
    this.locks.set(key, activeHolders);

    return {
      lockId,
      fencingToken,
      status: 'ACQUIRED',
    };
  }

  async renewTransaction(transactionId: string, extraMs: number): Promise<Transaction> {
    if (!this.activeTransactions.has(transactionId)) {
      throw new DlsNotFoundError('Transaction not found');
    }
    const currentExp = this.txExpiration.get(transactionId) || Date.now();
    this.txExpiration.set(transactionId, currentExp + extraMs);
    
    // Update expiration for all locks held by this transaction
    for (const [key, holders] of this.locks.entries()) {
      for (const h of holders) {
        if (h.transactionId === transactionId) {
          h.expiresAt += extraMs;
        }
      }
    }

    return { transactionId };
  }

  async releaseLock(lockId: string, transactionId: string): Promise<void> {
    if (!this.activeTransactions.has(transactionId)) {
      throw new DlsNotFoundError('Transaction not found');
    }

    let found = false;
    for (const [key, holders] of this.locks.entries()) {
      const idx = holders.findIndex(h => h.lockId === lockId && h.transactionId === transactionId);
      if (idx !== -1) {
        holders.splice(idx, 1);
        this.locks.set(key, holders);
        found = true;
        break;
      }
    }

    if (!found) {
      throw new DlsNotFoundError(`Lock ${lockId} not found for transaction ${transactionId}`);
    }
  }

  async releaseTransactionLocks(transactionId: string): Promise<void> {
    for (const [key, holders] of this.locks.entries()) {
      const remaining = holders.filter(h => h.transactionId !== transactionId);
      this.locks.set(key, remaining);
    }
    this.activeTransactions.delete(transactionId);
    this.txExpiration.delete(transactionId);
  }

  async getLockStatus(namespace: string, lockKey: string): Promise<LockStatusResponse> {
    const key = `${namespace}:${lockKey}`;
    const holders = this.locks.get(key) || [];
    const now = Date.now();
    const activeHolders = holders.filter(h => h.expiresAt > now);

    return {
      isHeld: activeHolders.length > 0,
      currentMode: activeHolders.length > 0 ? activeHolders[0]?.mode : undefined,
      activeHolders: activeHolders.map(h => ({
        lockId: h.lockId,
        expiresAt: h.expiresAt,
        fencingToken: 0, // Mock doesn't track fencing tokens fully
      })),
      pendingQueueSize: 0, // Mock doesn't queue
    };
  }

  async getTransactionStatus(transactionId: string): Promise<TransactionStatusResponse> {
    if (!this.activeTransactions.has(transactionId)) {
      throw new DlsNotFoundError('Transaction not found');
    }

    const txLocks = [];
    for (const holders of this.locks.values()) {
      for (const h of holders) {
        if (h.transactionId === transactionId) {
          txLocks.push({
            namespace: h.namespace,
            lockKey: h.lockKey,
            requestedMode: h.mode,
            status: 'ACQUIRED' as const,
          });
        }
      }
    }

    return {
      status: 'ACTIVE',
      locks: txLocks,
      expiresAt: this.txExpiration.get(transactionId) || 0,
    };
  }
}
