/**
 * Anything a caller can attach to a holder or a resource.
 *
 * The wire carries this as a JSON string; the SDK takes and returns an object. Nobody
 * should have to call JSON.stringify to use a library.
 */
export type Metadata = Record<string, unknown>;

/**
 * Where a hold stands.
 *
 * `QUEUED` happens when the template resolves conflicts by queueing and there was no
 * stock: the engine parked the request and will settle it when something frees up. The
 * SDK does not wait for that — a call that hangs for an unbounded time is worse than a
 * status you can act on.
 */
export type ResourceHolderStatus = 'PENDING' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED' | 'QUEUED';

/**
 * A hold on some amount of a resource.
 *
 * Named after what the engine and the `.proto` call it. The word "reservation" is
 * deliberately absent from this API: the project's domain language says *resource* and
 * *resource holder*, and the SDK follows it.
 */
export interface ResourceHolder {
  /** Hand this back to confirm, release or extend. */
  id: string;
  /** The resource this came from. */
  resourceId: string;
  status: ResourceHolderStatus;
  /** How many units are held. */
  amount: number;
  /**
   * When the hold lapses on its own.
   *
   * The wire sends epoch seconds and JavaScript counts milliseconds, which is a
   * conversion that produces dates in 1970 or the year 55000 when it is missed. It
   * happens once, here, and callers get a Date.
   */
  expiresAt: Date;
  metadata?: Metadata;
}

/** Something with stock that holders are taken from. */
export interface Resource {
  id: string;
  /** The name you gave it, and what you pass to `unitary` or `pooled`. */
  key: string;
  /** The template it was created from. */
  templateId: string;
  /** Units free to be taken right now. */
  availableAmount: number;
  /** Units currently held by holders that are neither confirmed nor released. */
  pendingCount: number;
  groupKey?: string;
  metadata?: Metadata;
}

/** One page of resources sharing a group key. */
export interface ResourcePage {
  resources: Resource[];
  /** Whether asking for the next page would return anything. */
  hasNextPage: boolean;
}

/** Extras for taking a holder. */
export interface TakeOptions {
  /**
   * Makes the take repeatable: sending the same key twice returns the first holder
   * instead of taking a second one.
   *
   * Some templates require it. It is also the only safe way to retry a take yourself,
   * since the SDK never retries one on its own.
   */
  idempotencyKey?: string;

  /** Overrides the template's TTL, in seconds. */
  ttlSeconds?: number;

  metadata?: Metadata;
}

/** Extras for creating a resource. */
export interface CreateResourceOptions {
  /** Ties resources together so they can be queried as a set. */
  groupKey?: string;
  metadata?: Metadata;
}

/** Extras for updating an existing resource. */
export interface UpdateResourceOptions {
  /** Replaces the group key. */
  groupKey?: string;
  metadata?: Metadata;
  /**
   * Makes the update repeatable: sending the same key twice is a no-op.
   * Required when the template has useIdempotency enabled.
   */
  idempotencyKey?: string;
}

/** Extras for confirming a holder. */
export interface ConfirmOptions {
  /** Replaces the holder's metadata as it is confirmed, for a payment id and such. */
  metadata?: Metadata;
}

/** Which page of a group to read. */
export interface GetResourcesByGroupOptions {
  /** Zero-based. Defaults to the first page. */
  page?: number;
  pageSize?: number;
}

/** One page of holders. */
export interface ResourceHolderPage {
  holders: ResourceHolder[];
  /** Whether asking for the next page would return anything. */
  hasNextPage: boolean;
}

/** Which holders to list, and in what order. */
export interface ListResourceHoldersOptions {
  /** Narrow it to one resource. Left out, every resource in the environment counts. */
  resourceKey?: string;

  /** Narrow it to one state — `PENDING` to see what is being held right now, say. */
  status?: ResourceHolderStatus;

  /** By when they were taken. Newest first unless you say otherwise. */
  sort?: 'NEWEST_FIRST' | 'OLDEST_FIRST';

  /** Zero-based. Defaults to the first page. */
  page?: number;
  pageSize?: number;
}

/**
 * A resource that holds exactly one unit — a numbered seat, a specific room, a slot.
 *
 * There is no `takeMany` here, and that is the point: asking for three of something
 * there is one of does not compile.
 */
export interface UnitaryResource {
  /** The key this handle points at. */
  readonly key: string;

  /** Holds the unit. */
  take(options?: TakeOptions): Promise<ResourceHolder>;
}

/**
 * A resource that holds interchangeable units — general admission, licences, capacity.
 */
export interface PooledResource {
  /** The key this handle points at. */
  readonly key: string;

  /** Holds one unit. */
  take(options?: TakeOptions): Promise<ResourceHolder>;

  /** Holds several at once. */
  takeMany(amount: number, options?: TakeOptions): Promise<ResourceHolder>;
}
