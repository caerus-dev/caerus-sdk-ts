/**
 * Caerus Webhook Event Envelope & Typed Payloads.
 *
 * All domain events emitted across Caerus (Shared Resource Engine & Distributed Lock Service)
 * are mapped here into strongly typed payloads and unified under the `CaerusEvent` discriminated union.
 */

// ============================================================================
// 1. BASE DOMAIN PAYLOAD INTERFACE
// ============================================================================

/**
 * Common domain metadata included in all event data payloads.
 */
export interface BaseDomainEventData {
  /** Unique identifier of this event instance. */
  eventId: string;
  /** ISO 8601 UTC timestamp when the domain event occurred. */
  occurredOn: string;
  /** The Caerus environment ID where the event took place. */
  environmentId?: string;
  /** The API Key ID that triggered the operation, if applicable. */
  apiKeyId?: string | null;
  /** The actor (user or service) identifier who initiated the action. */
  actorId?: string | null;
}

// ============================================================================
// 2. SRE (SHARED RESOURCE ENGINE) PAYLOADS
// ============================================================================

/**
 * Emitted when a new shared resource is declared in the inventory.
 */
export interface ResourceCreatedData extends BaseDomainEventData {
  /** The unique business key identifying the resource (e.g., 'seat_A12', 'general_admission'). */
  resourceKey: string;
  /** The template ID this resource derives its configuration from. */
  templateId?: string;
  /** Initial available stock/capacity. */
  availableAmount: number;
  /** Grouping key for partitioned inventory (e.g., 'flight_102', 'concert_madrid'). */
  groupKey?: string | null;
  /** JSON-encoded metadata attached to the resource. */
  metadata?: string | null;
  /** Unix epoch timestamp in milliseconds when the resource was created. */
  createdAtMs: number;
}

/**
 * Emitted when units of a resource are reserved (held) by a client.
 */
export interface ResourceTakenData extends BaseDomainEventData {
  /** The unique ID of the newly created resource holder. */
  holderId: string;
  /** The resource key that was held. */
  resourceKey: string;
  /** The number of units held. */
  amount: number;
  /** Unix epoch timestamp in seconds when the hold will automatically expire if not confirmed. */
  expiresAt: number;
  /** Unix epoch timestamp in milliseconds when the hold was created. */
  createdAtMs: number;
  /** Optional custom metadata attached at reservation time. */
  metadata?: string | null;
  /** Idempotency key supplied by the client during the take operation, if any. */
  idempotencyKey?: string | null;
}

/**
 * Emitted when a pending hold is confirmed and the units become permanently claimed.
 */
export interface ResourceConfirmedData extends BaseDomainEventData {
  /** The ID of the confirmed holder. */
  holderId: string;
  /** The resource key associated with the holder. */
  resourceKey: string;
  /** The number of units confirmed. */
  amount: number;
  /** Expiration timestamp in seconds at confirmation time. */
  expiresAt: number;
  /** Unix epoch timestamp in milliseconds when the hold was initially created. */
  createdAtMs: number;
  /** Optional metadata patch applied during confirmation (e.g. payment reference). */
  metadataPatch?: string | null;
}

/**
 * Emitted when a hold is explicitly released before expiring, returning units to stock.
 */
export interface ResourceReleasedData extends BaseDomainEventData {
  /** The ID of the released holder. */
  holderId: string;
  /** The resource key associated with the holder. */
  resourceKey: string;
  /** The number of units returned to available stock. */
  amount: number;
  /** Expiration timestamp in seconds when released. */
  expiresAt: number;
  /** Unix epoch timestamp in milliseconds when the hold was created. */
  createdAtMs: number;
}

/**
 * Emitted when the TTL of an active hold is extended.
 */
export interface ResourceExtendedData extends BaseDomainEventData {
  /** The ID of the holder whose TTL was extended. */
  holderId: string;
  /** The new Unix epoch expiration timestamp in seconds. */
  expiresAt: number;
}

/**
 * Emitted when a hold runs past its TTL without being confirmed, automatically releasing units.
 */
export interface ResourceExpiredData extends BaseDomainEventData {
  /** The ID of the expired holder. */
  holderId: string;
  /** The resource key associated with the expired holder. */
  resourceKey: string;
  /** The number of units returned to stock due to expiry. */
  amount: number;
  /** Expiration timestamp in seconds when it lapsed. */
  expiresAt: number;
  /** Unix epoch timestamp in milliseconds when the hold was created. */
  createdAtMs: number;
}

/**
 * Emitted when the available capacity or metadata of an existing resource is updated.
 */
export interface ResourceUpdatedData extends BaseDomainEventData {
  /** The unique key of the updated resource. */
  resourceKey: string;
  /** The delta change applied to available units (+/-). */
  deltaAmount?: number;
  /** Updated group key, if changed. */
  groupKey?: string | null;
  /** Updated JSON metadata, if changed. */
  metadata?: string | null;
  /** Unix epoch timestamp in milliseconds when the update took place. */
  updatedAtMs: number;
}

/**
 * Emitted when a resource is permanently deleted from the inventory.
 */
export interface ResourceDeletedData extends BaseDomainEventData {
  /** The key of the deleted resource. */
  resourceKey: string;
}

/**
 * Emitted when a take request cannot be satisfied immediately and enters the FIFO wait queue.
 */
export interface ResourceQueuedData extends BaseDomainEventData {
  /** The ID assigned to the queued hold request. */
  holderId: string;
  /** The resource key requested. */
  resourceKey: string;
  /** The number of units waiting in queue. */
  amount: number;
  /** Expected expiration timestamp in seconds. */
  expiresAt: number;
  /** Unix epoch timestamp in milliseconds when queued. */
  createdAtMs: number;
  /** Optional metadata attached to the queued request. */
  metadata?: string | null;
  /** Client-provided idempotency key for the request. */
  idempotencyKey?: string | null;
}

/**
 * Emitted when an attempt to reserve stock fails immediately (e.g. out of stock without queuing).
 */
export interface ResourceTakeFailedData extends BaseDomainEventData {
  /** The internal resource ID, if resolved. */
  resourceId?: string;
  /** The resource key requested. */
  resourceKey: string;
  /** The number of units that were requested. */
  amount: number;
  /** Human-readable or error code reason for the failure (e.g. 'OUT_OF_STOCK'). */
  reason?: string;
  /** Unix epoch timestamp in milliseconds when the failure occurred. */
  createdAtMs: number;
}

// ============================================================================
// 3. DLS (DISTRIBUTED LOCK SERVICE) PAYLOADS
// ============================================================================

/**
 * Emitted when a distributed lock is successfully acquired.
 */
export interface LockAcquiredData extends BaseDomainEventData {
  /** The namespace partition for the lock. */
  namespace: string;
  /** The business resource key that was locked. */
  lockKey: string;
  /** Unique identifier of the lock lease. */
  lockId: string;
  /** The transaction ID holding the lock. */
  transactionId: string;
  /** Monotonically increasing fencing token to prevent split-brain writes. */
  fencingToken: number;
  /** Lock mode, typically 'EXCLUSIVE' or 'SHARED'. */
  mode: string;
}

/**
 * Emitted when a distributed lock is released.
 */
export interface LockReleasedData extends BaseDomainEventData {
  /** The namespace of the released lock. */
  namespace: string;
  /** The lock key that was freed. */
  lockKey: string;
  /** Unique identifier of the lock lease. */
  lockId: string;
  /** The transaction ID that released the lock. */
  transactionId: string;
}

/**
 * Emitted when a lock acquisition attempt fails (e.g. contested or timed out).
 */
export interface LockAcquireFailedData extends BaseDomainEventData {
  /** The namespace of the requested lock. */
  namespace: string;
  /** The key that could not be acquired. */
  lockKey: string;
  /** The transaction ID that attempted the acquisition. */
  transactionId: string;
  /** Reason for the acquisition failure (e.g. 'LOCK_HELD_BY_ANOTHER_TRANSACTION'). */
  reason?: string;
}

/**
 * Emitted when a circular dependency (deadlock) between distributed lock transactions is detected.
 */
export interface DeadlockDetectedData extends BaseDomainEventData {
  /**
   * The transaction ID chosen or recommended as the victim to break the cycle.
   */
  victimTransactionId: string;
  /**
   * All transaction IDs involved in the dependency cycle.
   */
  cycleTransactionIds: string[];
  /**
   * Resolution strategy applied: 'ABORT' if the engine aborted the victim automatically,
   * or 'ALERT' if it is advisory.
   */
  resolutionStrategy: 'ALERT' | 'ABORT' | string;
  /** Additional diagnostic detail regarding the detected cycle. */
  reason?: string;
}

/**
 * Emitted when locks are abandoned due to client inactivity or disconnect.
 */
export interface LockAbandonedData extends BaseDomainEventData {
  /** The transaction ID whose locks were abandoned. */
  transactionId: string;
  /** The list of lock IDs that were abandoned. */
  lockIds: string[];
  /** Reason why the locks were marked as abandoned. */
  reason?: string;
}

/**
 * Emitted when a new distributed lock transaction begins.
 */
export interface TransactionStartedData extends BaseDomainEventData {
  /** Unique identifier for the transaction. */
  transactionId: string;
  /** Maximum transaction lifetime in milliseconds before timeout. */
  transactionTimeoutMs: number;
}

/**
 * Emitted when a distributed lock transaction successfully commits and closes.
 */
export interface TransactionCompletedData extends BaseDomainEventData {
  /** The completed transaction ID. */
  transactionId: string;
}

/**
 * Emitted when a distributed lock transaction is aborted and its locks are rolled back.
 */
export interface TransactionAbortedData extends BaseDomainEventData {
  /** The aborted transaction ID. */
  transactionId: string;
  /** Reason for abortion (e.g. 'DEADLOCK_VICTIM', 'MANUAL_ABORT'). */
  reason?: string;
}

/**
 * Emitted when a transaction's active lease is renewed to prevent timeout.
 */
export interface TransactionRenewedData extends BaseDomainEventData {
  /** The renewed transaction ID. */
  transactionId: string;
  /** The new remaining lifetime granted in milliseconds. */
  newLifetimeMs: number;
}

/**
 * Emitted when a transaction expires due to exceeding its maximum lifetime.
 */
export interface TransactionExpiredData extends BaseDomainEventData {
  /** The expired transaction ID. */
  transactionId: string;
  /** Reason for expiration. */
  reason?: string;
}

// ============================================================================
// 4. CAERUS EVENT ENVELOPE (DISCRIMINATED UNIONS)
// ============================================================================

/**
 * Common outer envelope structure present on every Caerus webhook event.
 */
export interface BaseCaerusEventEnvelope {
  /** Unique ID of this webhook delivery envelope. */
  id: string;
  /** Unique ID of the underlying domain event. */
  eventId: string;
  /** Caerus product origin ('SRE' | 'DLS' | string). */
  product: 'SRE' | 'DLS' | string;
  /** The domain object category affected (e.g. 'RESOURCE_HOLDER', 'SHARED_RESOURCE', 'DISTRIBUTED_LOCK'). */
  objectType: string;
  /** Primary identifier of the affected domain entity. */
  objectId: string;
  /** The environment where the event was produced. */
  environmentId: string;
  /** ISO 8601 UTC timestamp of the event. */
  occurredAt: string;
}

/**
 * Strongly-typed webhook event envelope with Discriminated Unions based on `eventType`.
 *
 * Switching on `event.eventType` narrows `event.data` to the exact payload interface.
 *
 * ```typescript
 * switch (event.eventType) {
 *   case 'resource.taken':
 *     // event.data is typed as ResourceTakenData
 *     console.log(event.data.holderId, event.data.amount);
 *     break;
 *   case 'lock.deadlock_detected':
 *     // event.data is typed as DeadlockDetectedData
 *     console.log(event.data.victimTransactionId);
 *     break;
 * }
 * ```
 */
export type CaerusEvent =
  // SRE Events (10)
  | (BaseCaerusEventEnvelope & { eventType: 'resource.created'; data: ResourceCreatedData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.taken'; data: ResourceTakenData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.confirmed'; data: ResourceConfirmedData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.released'; data: ResourceReleasedData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.extended'; data: ResourceExtendedData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.expired'; data: ResourceExpiredData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.updated'; data: ResourceUpdatedData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.deleted'; data: ResourceDeletedData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.queued'; data: ResourceQueuedData })
  | (BaseCaerusEventEnvelope & { eventType: 'resource.take_failed'; data: ResourceTakeFailedData })

  // DLS Events (10)
  | (BaseCaerusEventEnvelope & { eventType: 'lock.acquired'; data: LockAcquiredData })
  | (BaseCaerusEventEnvelope & { eventType: 'lock.released'; data: LockReleasedData })
  | (BaseCaerusEventEnvelope & { eventType: 'lock.acquire_failed'; data: LockAcquireFailedData })
  | (BaseCaerusEventEnvelope & { eventType: 'lock.deadlock_detected'; data: DeadlockDetectedData })
  | (BaseCaerusEventEnvelope & { eventType: 'lock.abandoned'; data: LockAbandonedData })
  | (BaseCaerusEventEnvelope & { eventType: 'transaction.started'; data: TransactionStartedData })
  | (BaseCaerusEventEnvelope & { eventType: 'transaction.completed'; data: TransactionCompletedData })
  | (BaseCaerusEventEnvelope & { eventType: 'transaction.aborted'; data: TransactionAbortedData })
  | (BaseCaerusEventEnvelope & { eventType: 'transaction.renewed'; data: TransactionRenewedData })
  | (BaseCaerusEventEnvelope & { eventType: 'transaction.expired'; data: TransactionExpiredData })

  // Fallback (Future events)
  | (BaseCaerusEventEnvelope & { eventType: string; data: any });
