/**
 * Anything a caller can attach to a reservation or a resource.
 *
 * The wire carries this as a JSON string; the SDK takes and returns an object. Nobody
 * should have to call JSON.stringify to use a library.
 */
export type Metadata = Record<string, unknown>;

/**
 * Where a reservation stands.
 *
 * `QUEUED` happens when the template resolves conflicts by queueing and there was no
 * stock: the engine parked the request and will settle it when something frees up. The
 * SDK does not wait for that — a call that hangs for an unbounded time is worse than a
 * status you can act on.
 */
export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'RELEASED' | 'FAILED' | 'QUEUED';

/** A hold on some amount of a resource. */
export interface Reservation {
  /** Hand this back to confirm, release or extend. */
  id: string;
  /** The resource this came from. */
  resourceId: string;
  status: ReservationStatus;
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

/** Something with stock that reservations are taken from. */
export interface Resource {
  id: string;
  /** The name you gave it, and what you pass to take. */
  key: string;
  /** The template it was created from. */
  templateId: string;
  /** Units free to be taken right now. */
  availableAmount: number;
  /** Units currently held by reservations that are neither confirmed nor released. */
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

/**
 * The work to run while the units are held.
 *
 * Whatever it returns becomes the result of `reserve`. If it throws, the reservation is
 * released and the same error comes back out.
 */
export type ReservationWork<T> = (reservation: Reservation) => T | Promise<T>;

/** Extras for taking a reservation. */
export interface TakeOptions {
  /**
   * Makes the take repeatable: sending the same key twice returns the first
   * reservation instead of taking a second one.
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

/** Extras for confirming a reservation. */
export interface ConfirmOptions {
  /** Replaces the reservation's metadata as it is confirmed, for a payment id and such. */
  metadata?: Metadata;
}

/** Which page of a group to read. */
export interface GetResourcesByGroupOptions {
  /** Zero-based. Defaults to the first page. */
  page?: number;
  pageSize?: number;
}
