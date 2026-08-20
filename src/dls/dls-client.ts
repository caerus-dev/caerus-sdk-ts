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
  type DlsClientOptions,
  resolveOptions,
} from './dls-options';
import { DlsTransport } from './internal/dls-transport';
import {
  mapLockModeToGrpc,
  mapGrpcToLockStatus,
  mapGrpcToLockMode,
} from './internal/dls-mapping';

export class DlsClient implements DlsApi {
  readonly #transport: DlsTransport;

  constructor(options: DlsClientOptions) {
    this.#transport = new DlsTransport(resolveOptions(options));
  }

  async beginTransaction(options?: BeginTransactionOptions): Promise<Transaction> {
    const request = {
      timeoutMs: options?.timeoutMs,
    };
    const response = await this.#transport.unary(
      this.#transport.raw.beginTransaction,
      request
    );
    return {
      transactionId: response.transactionId,
    };
  }

  async acquireLock(
    namespace: string,
    lockKey: string,
    transactionId: string,
    mode: LockMode,
    options?: AcquireLockOptions
  ): Promise<LockHolder> {
    const request = {
      namespace,
      lockKey,
      idempotencyKey: options?.idempotencyKey,
      requestedMode: mapLockModeToGrpc(mode),
      transactionId,
    };

    const response = await this.#transport.acquireLockStream(request);

    return {
      lockId: response.lockId,
      fencingToken: Number(response.fencingToken),
      status: mapGrpcToLockStatus(response.status),
    };
  }

  async renewTransaction(transactionId: string, extraMs: number): Promise<Transaction> {
    const request = {
      transactionId,
      extraMs,
    };
    const response = await this.#transport.unary(
      this.#transport.raw.renewTransaction,
      request
    );
    // The response returns newExpiresAt but our domain currently models Transaction as { transactionId }
    // We could extend the domain type if needed, but for now we return the transaction ID.
    return {
      transactionId: response.transactionId,
    };
  }

  async releaseLock(lockId: string, transactionId: string): Promise<void> {
    const request = {
      lockId,
      transactionId,
    };
    await this.#transport.unary(this.#transport.raw.releaseLock, request);
  }

  async releaseTransactionLocks(transactionId: string): Promise<void> {
    const request = {
      transactionId,
    };
    await this.#transport.unary(this.#transport.raw.releaseTransactionLocks, request);
  }

  async getLockStatus(namespace: string, lockKey: string): Promise<LockStatusResponse> {
    const request = {
      namespace,
      lockKey,
    };
    const response = await this.#transport.unary(this.#transport.raw.getLockStatus, request);

    return {
      isHeld: response.isHeld,
      currentMode: mapGrpcToLockMode(response.currentMode),
      activeHolders: response.activeHolders.map(h => ({
        lockId: h.lockId,
        expiresAt: Number(h.expiresAt),
        fencingToken: Number(h.fencingToken),
      })),
      pendingQueueSize: response.pendingQueueSize,
    };
  }

  async getTransactionStatus(transactionId: string): Promise<TransactionStatusResponse> {
    const request = {
      transactionId,
    };
    const response = await this.#transport.unary(this.#transport.raw.getTransactionStatus, request);

    return {
      status: response.status,
      abortReason: response.abortReason,
      locks: response.locks.map(l => ({
        namespace: l.namespace,
        lockKey: l.lockKey,
        requestedMode: mapGrpcToLockMode(l.requestedMode) || 'EXCLUSIVE', // fallback if undefined
        status: mapGrpcToLockStatus(l.status),
      })),
      expiresAt: Number(response.expiresAt),
    };
  }

  close(): void {
    this.#transport.close();
  }
}
