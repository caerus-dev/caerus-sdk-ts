import { ConflictError, ValidationError } from './errors.js';
import {
  assertUsable,
  encodeMetadata,
  toReservation,
  toResource,
  toResourcePage,
} from './internal/mapping.js';
import { Transport } from './internal/transport.js';
import { resolveOptions, type CaerusClientOptions, type ResolvedClientOptions } from './options.js';
import type {
  ConfirmOptions,
  CreateResourceOptions,
  GetResourcesByGroupOptions,
  Reservation,
  ReservationWork,
  Resource,
  ResourcePage,
  TakeOptions,
} from './types.js';

/**
 * The entry point to Caerus.
 *
 * ```typescript
 * const caerus = new CaerusClient({ endpoint: 'caerus.example.com:9090', apiKey });
 * const reservation = await caerus.take('seat_A12');
 * ```
 *
 * One instance is meant to live as long as the process does: it holds a gRPC channel
 * that multiplexes every call over a single connection. Building one per request throws
 * that away and opens a connection each time.
 *
 * No method takes an environment. The API Key identifies it.
 */
export class CaerusClient {
  // `#` and not `protected`: a protected field is still part of the published type, so
  // the declaration bundle would inline Transport and, through it, every type generated
  // from the .proto. Private this way, none of it reaches the .d.ts.
  //
  // The API Key is not stored here either. It goes to the transport, which also keeps it
  // in a `#` field, so logging a client cannot spill the credential.
  readonly #transport: Transport;
  readonly #endpoint: string;
  readonly #timeoutMs: number;

  constructor(options: CaerusClientOptions) {
    const resolved: ResolvedClientOptions = resolveOptions(options);

    this.#endpoint = resolved.endpoint;
    this.#timeoutMs = resolved.timeoutMs;
    this.#transport = new Transport(resolved);
  }

  /** Where this client is pointed. Useful in logs; the API Key is deliberately absent. */
  get endpoint(): string {
    return this.#endpoint;
  }

  /** The per-call deadline in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  // --- Inventory -----------------------------------------------------------------

  /**
   * Declares something that can be reserved.
   *
   * Templates are created in the dashboard; the concrete resources that follow their
   * rules are created here, and nowhere else.
   *
   * ```typescript
   * await caerus.createResource('seat', 'seat_A12', 1, { groupKey: 'row_A' });
   * ```
   */
  async createResource(
    templateName: string,
    key: string,
    availableAmount: number,
    options: CreateResourceOptions = {},
  ): Promise<Resource> {
    requireText(templateName, 'templateName');
    requireText(key, 'key');
    requirePositive(availableAmount, 'availableAmount');

    const response = await this.#transport.unary(
      this.#transport.raw.createResource.bind(this.#transport.raw),
      {
        templateName,
        key,
        availableAmount,
        groupKey: options.groupKey,
        metadata: encodeMetadata(options.metadata),
      },
    );

    return toResource(response);
  }

  // --- Reservations --------------------------------------------------------------

  /**
   * Holds one unit of a resource.
   *
   * ```typescript
   * const reservation = await caerus.take('seat_A12');
   * ```
   *
   * Throws when there is nothing to hold. A reservation that comes back `QUEUED` is
   * real but not yours yet: the engine is waiting for stock, and you decide whether to
   * poll for it or give up.
   */
  async take(resourceKey: string, options: TakeOptions = {}): Promise<Reservation> {
    return this.#take(resourceKey, 1, options);
  }

  /**
   * Holds several units at once.
   *
   * ```typescript
   * const reservation = await caerus.takeMany('general_admission', 4);
   * ```
   *
   * A separate method rather than an optional amount on `take`, because the SDKs coming
   * for other languages have to look the same and Go has no overloading.
   */
  async takeMany(
    resourceKey: string,
    amount: number,
    options: TakeOptions = {},
  ): Promise<Reservation> {
    requirePositive(amount, 'amount');
    return this.#take(resourceKey, amount, options);
  }

  async #take(
    resourceKey: string,
    amount: number,
    options: TakeOptions,
  ): Promise<Reservation> {
    requireText(resourceKey, 'resourceKey');
    if (options.ttlSeconds !== undefined) {
      requirePositive(options.ttlSeconds, 'ttlSeconds');
    }

    const response = await this.#transport.unary(
      this.#transport.raw.take.bind(this.#transport.raw),
      {
        resourceKey,
        amount,
        settings: {
          idempotencyKey: options.idempotencyKey,
          customTtlSeconds: options.ttlSeconds,
          metadata: encodeMetadata(options.metadata),
        },
      },
    );

    return assertUsable(toReservation(response));
  }

  /**
   * Settles a reservation for good. The units stop being pending and stay taken.
   *
   * ```typescript
   * await caerus.confirm(reservation.id, { metadata: { paymentId } });
   * ```
   */
  async confirm(reservationId: string, options: ConfirmOptions = {}): Promise<Reservation> {
    requireText(reservationId, 'reservationId');

    const response = await this.#transport.unary(
      this.#transport.raw.confirm.bind(this.#transport.raw),
      {
        resourceHolderId: reservationId,
        metadataPatch: encodeMetadata(options.metadata),
      },
    );

    return assertUsable(toReservation(response));
  }

  /**
   * Gives the units back before the reservation lapses.
   *
   * Worth calling on every path that abandons a checkout: without it the stock stays
   * held until the TTL runs out.
   */
  async release(reservationId: string): Promise<void> {
    requireText(reservationId, 'reservationId');

    await this.#transport.unary(this.#transport.raw.release.bind(this.#transport.raw), {
      resourceHolderId: reservationId,
    });
  }

  /**
   * Pushes the expiry further out.
   *
   * ```typescript
   * await caerus.extend(reservation.id, 300); // five more minutes
   * ```
   *
   * Seconds, like every other duration here. Never retried automatically: a repeated
   * extend adds the time twice and says nothing about it.
   */
  async extend(reservationId: string, extraSeconds: number): Promise<Reservation> {
    requireText(reservationId, 'reservationId');
    requirePositive(extraSeconds, 'extraSeconds');

    const response = await this.#transport.unary(
      this.#transport.raw.extend.bind(this.#transport.raw),
      { resourceHolderId: reservationId, extraSeconds },
    );

    return assertUsable(toReservation(response));
  }

  // --- The whole cycle in one call -------------------------------------------------

  /**
   * Holds one unit, runs your work, and settles the reservation either way.
   *
   * ```typescript
   * await caerus.reserve('seat_A12', async () => {
   *   await chargeCard();
   * });
   * ```
   *
   * If your block returns, the reservation is confirmed. If it throws, the reservation
   * is released and **your** error is what comes out — the release is bookkeeping, and
   * replacing your error with one about bookkeeping would hide what actually happened.
   *
   * This exists because forgetting the release on the error path is the integration
   * mistake everyone makes, and the stock stays held until the TTL runs out.
   *
   * Whatever your block returns is what this returns.
   */
  async reserve<T>(
    resourceKey: string,
    work: ReservationWork<T>,
    options: TakeOptions = {},
  ): Promise<T> {
    return this.#reserve(await this.take(resourceKey, options), work);
  }

  /**
   * The same, for several units at once.
   *
   * A second method rather than an optional amount, for the same reason `takeMany` is
   * one: the SDKs coming for other languages have to look the same, and Go has no
   * overloading. Someone who learned `take` and `takeMany` already knows this pair.
   */
  async reserveMany<T>(
    resourceKey: string,
    amount: number,
    work: ReservationWork<T>,
    options: TakeOptions = {},
  ): Promise<T> {
    return this.#reserve(await this.takeMany(resourceKey, amount, options), work);
  }

  async #reserve<T>(reservation: Reservation, work: ReservationWork<T>): Promise<T> {
    if (typeof work !== 'function') {
      throw new ValidationError('reserve needs a function to run while the units are held');
    }

    // A queued reservation holds nothing yet. Running the block here would charge a card
    // for a seat the caller does not have. Anyone who wants to handle queueing can use
    // take directly and act on the status.
    if (reservation.status === 'QUEUED') {
      throw new ConflictError(
        `Reservation ${reservation.id} is queued and holds nothing yet, so the work was not run. ` +
          `Use take() if you want to handle queueing yourself.`,
      );
    }

    let result: T;
    try {
      result = await work(reservation);
    } catch (workError) {
      await this.#releaseQuietly(reservation.id, workError);
      throw workError;
    }

    // Deliberately outside the try: a failure to confirm is not the caller's error to
    // handle by releasing, and the units are better left to lapse than released on a
    // state we could not read.
    await this.confirm(reservation.id);
    return result;
  }

  /**
   * Releases without ever throwing.
   *
   * If this fails while an error is already on its way out, the caller's error is the
   * one worth having: it says why the checkout failed. The release failing is an
   * operational detail, and the units lapse on their own when the TTL runs out.
   *
   * It still has to be visible somewhere, hence the log.
   */
  async #releaseQuietly(reservationId: string, causeOfRelease: unknown): Promise<void> {
    try {
      await this.release(reservationId);
    } catch (releaseError) {
      console.error(
        `[caerus] Could not release reservation ${reservationId} after the reserved work failed. ` +
          `It will lapse when its TTL runs out. Release error:`,
        releaseError,
        `Original error:`,
        causeOfRelease,
      );
    }
  }

  // --- Queries -------------------------------------------------------------------

  /** Reads a resource and its current stock. */
  async getResource(key: string): Promise<Resource> {
    requireText(key, 'key');

    const response = await this.#transport.unary(
      this.#transport.raw.getResource.bind(this.#transport.raw),
      { key },
    );

    return toResource(response);
  }

  /** Reads one page of the resources sharing a group key. */
  async getResourcesByGroup(
    groupKey: string,
    options: GetResourcesByGroupOptions = {},
  ): Promise<ResourcePage> {
    requireText(groupKey, 'groupKey');

    const response = await this.#transport.unary(
      this.#transport.raw.getResourcesByGroupKey.bind(this.#transport.raw),
      { groupKey, page: options.page ?? 0, pageSize: options.pageSize },
    );

    return toResourcePage(response);
  }

  /**
   * Reads a reservation as it stands.
   *
   * This is the one place a `FAILED` reservation is returned rather than thrown: asking
   * what state something is in and being told FAILED is an answer, not a failure.
   */
  async getReservation(reservationId: string): Promise<Reservation> {
    requireText(reservationId, 'reservationId');

    const response = await this.#transport.unary(
      this.#transport.raw.getResourceHolder.bind(this.#transport.raw),
      { resourceHolderId: reservationId },
    );

    return toReservation(response);
  }

  /**
   * Releases the connection. Calls made afterwards reject.
   *
   * Node keeps the process alive while the channel is open, so a short-lived script that
   * never closes will appear to hang after its work is done.
   */
  close(): void {
    this.#transport.close();
  }
}

/**
 * Caught here rather than on the server, so the error names the argument instead of
 * arriving as a rejected call after a round trip.
 */
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
