import type { SharedResourceApi } from './api.js';
import { CaerusError, ConflictError, ResourceNotFoundError, ValidationError } from './errors.js';
import { runReserve } from './internal/reserve-flow.js';
import { DEFAULT_LOGGER, type CaerusLogger } from './options.js';
import type {
  ConfirmOptions,
  CreateResourceOptions,
  GetResourcesByGroupOptions,
  Metadata,
  Reservation,
  ReservationWork,
  Resource,
  ResourcePage,
  TakeOptions,
} from './types.js';

/** A resource the mock starts out knowing about. */
export interface MockResourceSeed {
  key: string;
  availableAmount: number;
  templateId?: string;
  groupKey?: string;
  metadata?: Metadata;
}

/** Which method to make fail. */
export type MockMethod =
  | 'createResource'
  | 'take'
  | 'takeMany'
  | 'confirm'
  | 'release'
  | 'extend'
  | 'getResource'
  | 'getResourcesByGroup'
  | 'getReservation';

export interface MockOptions {
  /** Stock to start with. Resources can also be created through the API. */
  resources?: MockResourceSeed[];
  /** TTL applied when a take does not ask for one. Defaults to 300 seconds. */
  defaultTtlSeconds?: number;
  /** Page size for group queries when none is asked for. Defaults to 25. */
  defaultPageSize?: number;
  logger?: CaerusLogger;
}

interface StoredResource {
  id: string;
  key: string;
  templateId: string;
  availableAmount: number;
  pendingCount: number;
  groupKey?: string;
  metadata?: Metadata;
}

interface StoredReservation {
  id: string;
  resourceKey: string;
  resourceId: string;
  amount: number;
  status: Reservation['status'];
  expiresAtSeconds: number;
  metadata?: Metadata;
}

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_PAGE_SIZE = 25;

/**
 * Caerus, in memory, for testing an integration without running anything.
 *
 * It implements {@link SharedResourceApi}, so it drops into wherever the real client
 * goes. Stock is tracked for real — taking decrements it, releasing gives it back — so a
 * test that reserves more than exists fails the way production would.
 *
 * ```typescript
 * const caerus = new InMemoryCaerusClient({
 *   resources: [{ key: 'seat_A12', availableAmount: 1 }],
 * });
 *
 * await caerus.reserve('seat_A12', async () => chargeCard());
 * ```
 *
 * ## Time does not pass on its own
 *
 * Reservations carry a real `expiresAt`, but nothing expires until you say so:
 *
 * ```typescript
 * caerus.advanceTime(600);   // ten minutes later
 * ```
 *
 * A mock that expired reservations on a wall clock would make its users' tests wait, and
 * then fail now and then depending on how busy the machine was. Tests are supposed to be
 * the deterministic part. Time is an input here, like the stock.
 */
export class InMemoryCaerusClient implements SharedResourceApi {
  readonly #resources = new Map<string, StoredResource>();
  readonly #reservations = new Map<string, StoredReservation>();
  readonly #idempotency = new Map<string, string>();
  readonly #failures = new Map<MockMethod, CaerusError[]>();
  readonly #defaultTtlSeconds: number;
  readonly #defaultPageSize: number;
  readonly #logger: CaerusLogger;

  #nowSeconds = Math.floor(Date.now() / 1000);
  #sequence = 0;
  #closed = false;

  constructor(options: MockOptions = {}) {
    this.#defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    this.#defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.#logger = options.logger ?? DEFAULT_LOGGER;

    for (const seed of options.resources ?? []) {
      this.#resources.set(seed.key, {
        id: this.#nextId('res'),
        key: seed.key,
        templateId: seed.templateId ?? 'tpl-mock',
        availableAmount: seed.availableAmount,
        pendingCount: 0,
        groupKey: seed.groupKey,
        metadata: seed.metadata,
      });
    }
  }

  // --- Controls, which only the mock has -------------------------------------------

  /**
   * Makes the next call to a method fail with this error.
   *
   * Queued, so calling it twice fails the next two. This is what lets a test drive its
   * own error paths — a declined payment after a successful take, a release that does
   * not land — without needing a broken server.
   */
  failNext(method: MockMethod, error: CaerusError): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(error);
    this.#failures.set(method, queue);
  }

  /** Forgets every queued failure. */
  clearFailures(): void {
    this.#failures.clear();
  }

  /**
   * Moves the clock forward and expires whatever is now past due.
   *
   * Expiring is not simulated in the background on purpose. Doing so would mean either
   * making tests sleep, or expiring on a timer that fires while a test is midway through
   * something — both turn a test suite into a source of intermittent failures. Here the
   * test says when time passes, and the result is the same every run.
   */
  advanceTime(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new ValidationError('advanceTime needs a number of seconds that is not negative');
    }

    this.#nowSeconds += seconds;

    for (const reservation of this.#reservations.values()) {
      if (reservation.status === 'PENDING' && reservation.expiresAtSeconds <= this.#nowSeconds) {
        this.#expire(reservation);
      }
    }
  }

  /** Expires one reservation regardless of its TTL. */
  expire(reservationId: string): void {
    const reservation = this.#requireReservation(reservationId);
    if (reservation.status !== 'PENDING') {
      throw new ConflictError(
        `Reservation ${reservationId} is ${reservation.status} and cannot expire.`,
      );
    }
    this.#expire(reservation);
  }

  /** What the mock currently believes, for assertions that go beyond the API. */
  snapshot(): { resources: Resource[]; reservations: Reservation[] } {
    return {
      resources: [...this.#resources.values()].map((resource) => this.#toResource(resource)),
      reservations: [...this.#reservations.values()].map((held) => this.#toReservation(held)),
    };
  }

  // --- The API ----------------------------------------------------------------------

  async createResource(
    templateName: string,
    key: string,
    availableAmount: number,
    options: CreateResourceOptions = {},
  ): Promise<Resource> {
    this.#guard('createResource');
    requireText(templateName, 'templateName');
    requireText(key, 'key');
    requirePositive(availableAmount, 'availableAmount');

    if (this.#resources.has(key)) {
      throw new ConflictError(`A resource with key ${key} already exists.`);
    }

    const resource: StoredResource = {
      id: this.#nextId('res'),
      key,
      templateId: `tpl-${templateName}`,
      availableAmount,
      pendingCount: 0,
      groupKey: options.groupKey,
      metadata: options.metadata,
    };
    this.#resources.set(key, resource);

    return this.#toResource(resource);
  }

  async take(resourceKey: string, options: TakeOptions = {}): Promise<Reservation> {
    this.#guard('take');
    return this.#take(resourceKey, 1, options);
  }

  async takeMany(
    resourceKey: string,
    amount: number,
    options: TakeOptions = {},
  ): Promise<Reservation> {
    this.#guard('takeMany');
    requirePositive(amount, 'amount');
    return this.#take(resourceKey, amount, options);
  }

  async confirm(reservationId: string, options: ConfirmOptions = {}): Promise<Reservation> {
    this.#guard('confirm');
    const reservation = this.#requireReservation(reservationId);

    if (reservation.status !== 'PENDING') {
      throw new ConflictError(
        `Reservation ${reservationId} is ${reservation.status} and cannot be confirmed.`,
      );
    }

    const resource = this.#requireResource(reservation.resourceKey);
    // Confirming keeps the units taken: they stop being pending, they do not come back.
    resource.pendingCount -= reservation.amount;
    reservation.status = 'CONFIRMED';
    if (options.metadata !== undefined) {
      reservation.metadata = options.metadata;
    }

    return this.#toReservation(reservation);
  }

  async release(reservationId: string): Promise<void> {
    this.#guard('release');
    const reservation = this.#requireReservation(reservationId);

    if (reservation.status !== 'PENDING') {
      throw new ConflictError(
        `Reservation ${reservationId} is ${reservation.status} and cannot be released.`,
      );
    }

    this.#giveBack(reservation, 'RELEASED');
  }

  async extend(reservationId: string, extraSeconds: number): Promise<Reservation> {
    this.#guard('extend');
    requirePositive(extraSeconds, 'extraSeconds');
    const reservation = this.#requireReservation(reservationId);

    if (reservation.status !== 'PENDING') {
      throw new ConflictError(
        `Reservation ${reservationId} is ${reservation.status} and cannot be extended.`,
      );
    }

    reservation.expiresAtSeconds += extraSeconds;
    return this.#toReservation(reservation);
  }

  async reserve<T>(
    resourceKey: string,
    work: ReservationWork<T>,
    options: TakeOptions = {},
  ): Promise<T> {
    return this.#reserve(await this.take(resourceKey, options), work);
  }

  async reserveMany<T>(
    resourceKey: string,
    amount: number,
    work: ReservationWork<T>,
    options: TakeOptions = {},
  ): Promise<T> {
    return this.#reserve(await this.takeMany(resourceKey, amount, options), work);
  }

  async getResource(key: string): Promise<Resource> {
    this.#guard('getResource');
    requireText(key, 'key');
    return this.#toResource(this.#requireResource(key));
  }

  async getResourcesByGroup(
    groupKey: string,
    options: GetResourcesByGroupOptions = {},
  ): Promise<ResourcePage> {
    this.#guard('getResourcesByGroup');
    requireText(groupKey, 'groupKey');

    const page = options.page ?? 0;
    const pageSize = options.pageSize ?? this.#defaultPageSize;
    const matching = [...this.#resources.values()].filter(
      (resource) => resource.groupKey === groupKey,
    );
    const start = page * pageSize;
    const slice = matching.slice(start, start + pageSize);

    return {
      resources: slice.map((resource) => this.#toResource(resource)),
      hasNextPage: start + pageSize < matching.length,
    };
  }

  async getReservation(reservationId: string): Promise<Reservation> {
    this.#guard('getReservation');
    // Like the real client, a query reports FAILED rather than throwing on it.
    return this.#toReservation(this.#requireReservation(reservationId));
  }

  close(): void {
    this.#closed = true;
  }

  // --- Internals --------------------------------------------------------------------

  #reserve<T>(reservation: Reservation, work: ReservationWork<T>): Promise<T> {
    // The same orchestration the real client runs, so the mock cannot drift from it.
    return runReserve(reservation, work, {
      confirm: (id) => this.confirm(id),
      release: (id) => this.release(id),
      logger: this.#logger,
    });
  }

  #take(resourceKey: string, amount: number, options: TakeOptions): Reservation {
    requireText(resourceKey, 'resourceKey');
    if (options.ttlSeconds !== undefined) {
      requirePositive(options.ttlSeconds, 'ttlSeconds');
    }

    // Repeating an idempotency key gives back the first reservation instead of taking
    // more stock, which is what the engine does and what makes a retry safe.
    if (options.idempotencyKey !== undefined) {
      const known = this.#idempotency.get(options.idempotencyKey);
      if (known !== undefined) {
        return this.#toReservation(this.#requireReservation(known));
      }
    }

    const resource = this.#requireResource(resourceKey);
    if (resource.availableAmount < amount) {
      throw new ConflictError(
        `Not enough stock for ${resourceKey}: asked for ${amount}, ${resource.availableAmount} available.`,
      );
    }

    resource.availableAmount -= amount;
    resource.pendingCount += amount;

    const reservation: StoredReservation = {
      id: this.#nextId('hld'),
      resourceKey,
      resourceId: resource.id,
      amount,
      status: 'PENDING',
      expiresAtSeconds: this.#nowSeconds + (options.ttlSeconds ?? this.#defaultTtlSeconds),
      metadata: options.metadata,
    };
    this.#reservations.set(reservation.id, reservation);

    if (options.idempotencyKey !== undefined) {
      this.#idempotency.set(options.idempotencyKey, reservation.id);
    }

    return this.#toReservation(reservation);
  }

  #expire(reservation: StoredReservation): void {
    this.#giveBack(reservation, 'FAILED');
  }

  /** Returns the units to the resource and marks the reservation with its new status. */
  #giveBack(reservation: StoredReservation, status: Reservation['status']): void {
    const resource = this.#requireResource(reservation.resourceKey);
    resource.availableAmount += reservation.amount;
    resource.pendingCount -= reservation.amount;
    reservation.status = status;
  }

  #guard(method: MockMethod): void {
    if (this.#closed) {
      throw new CaerusError('This InMemoryCaerusClient has been closed');
    }

    const queue = this.#failures.get(method);
    const failure = queue?.shift();
    if (failure) {
      throw failure;
    }
  }

  #requireResource(key: string): StoredResource {
    const resource = this.#resources.get(key);
    if (!resource) {
      throw new ResourceNotFoundError(`Resource not found: ${key}`);
    }
    return resource;
  }

  #requireReservation(id: string): StoredReservation {
    requireText(id, 'reservationId');
    const reservation = this.#reservations.get(id);
    if (!reservation) {
      throw new ResourceNotFoundError(`ResourceHolder not found: ${id}`);
    }
    return reservation;
  }

  #toResource(resource: StoredResource): Resource {
    return {
      id: resource.id,
      key: resource.key,
      templateId: resource.templateId,
      availableAmount: resource.availableAmount,
      pendingCount: resource.pendingCount,
      groupKey: resource.groupKey,
      metadata: resource.metadata,
    };
  }

  #toReservation(reservation: StoredReservation): Reservation {
    return {
      id: reservation.id,
      resourceId: reservation.resourceId,
      status: reservation.status,
      amount: reservation.amount,
      expiresAt: new Date(reservation.expiresAtSeconds * 1000),
      metadata: reservation.metadata,
    };
  }

  #nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }
}

function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${name} is required`);
  }
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${name} must be greater than zero`);
  }
}
