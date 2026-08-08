import type { SharedResourceApi } from './api.js';
import { ValidationError } from './errors.js';
import { pooledHandle, unitaryHandle } from './internal/handles.js';
import {
  assertUsable,
  encodeMetadata,
  toResource,
  toResourceHolder,
  toResourcePage,
} from './internal/mapping.js';
import { Transport } from './internal/transport.js';
import { resolveOptions, type CaerusClientOptions, type ResolvedClientOptions } from './options.js';
import type {
  ConfirmOptions,
  CreateResourceOptions,
  GetResourcesByGroupOptions,
  PooledResource,
  Resource,
  ResourceHolder,
  ResourcePage,
  TakeOptions,
  UnitaryResource,
  UpdateResourceOptions,
} from './types.js';

/**
 * The entry point to Caerus.
 *
 * ```typescript
 * const caerus = new CaerusClient({ endpoint: 'caerus.example.com:9090', apiKey });
 *
 * const seat = caerus.unitary('seat_A12');
 * const holder = await seat.take();
 * ```
 *
 * One instance is meant to live as long as the process does: it holds a gRPC channel
 * that multiplexes every call over a single connection. Building one per request throws
 * that away and opens a connection each time.
 *
 * No method takes an environment. The API Key identifies it.
 */
export class CaerusClient implements SharedResourceApi {
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
   * Declares a resource that holds exactly one unit: a numbered seat, a specific room.
   *
   * ```typescript
   * await caerus.createUnitary('seat', 'seat_A12', { groupKey: 'row_A' });
   * ```
   *
   * No amount, because a unitary resource always has one.
   *
   * Templates — hold duration, whether metadata is kept, what happens when stock runs
   * out — are created in the dashboard. The resources that follow them are created here.
   */
  async createUnitary(
    templateName: string,
    key: string,
    options: CreateResourceOptions = {},
  ): Promise<Resource> {
    return this.#createResource(templateName, key, 1, options);
  }

  /**
   * Declares a resource with several interchangeable units: general admission, licences.
   *
   * ```typescript
   * await caerus.createMultiple('ga_pool', 'general_admission', 500);
   * ```
   */
  async createMultiple(
    templateName: string,
    key: string,
    availableAmount: number,
    options: CreateResourceOptions = {},
  ): Promise<Resource> {
    requirePositive(availableAmount, 'availableAmount');
    return this.#createResource(templateName, key, availableAmount, options);
  }

  async #createResource(
    templateName: string,
    key: string,
    availableAmount: number,
    options: CreateResourceOptions,
  ): Promise<Resource> {
    requireText(templateName, 'templateName');
    requireText(key, 'key');

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

  /**
   * Adjusts the available stock of an existing resource by a delta (positive or negative).
   *
   * ```typescript
   * await caerus.updateResource('general_admission', 50); // add 50 units
   * ```
   */
  async updateResource(
    key: string,
    deltaAmount: number,
    options: UpdateResourceOptions = {},
  ): Promise<Resource> {
    requireText(key, 'key');
    requireInteger(deltaAmount, 'deltaAmount');

    const response = await this.#transport.unary(
      this.#transport.raw.updateResource.bind(this.#transport.raw),
      {
        resourceKey: key,
        deltaAmount,
        groupKey: options.groupKey,
        metadata: encodeMetadata(options.metadata),
        idempotencyKey: options.idempotencyKey,
      },
    );

    return toResource(response);
  }

  /**
   * Removes a resource. Fails if it has active (pending) holders.
   *
   * ```typescript
   * await caerus.deleteResource('seat_A12');
   * ```
   */
  async deleteResource(key: string): Promise<void> {
    requireText(key, 'key');

    await this.#transport.unary(
      this.#transport.raw.deleteResource.bind(this.#transport.raw),
      { key },
    );
  }

  // --- Handles -------------------------------------------------------------------

  /**
   * A handle on a single-unit resource.
   *
   * ```typescript
   * const holder = await caerus.unitary('seat_A12').take();
   * ```
   *
   * It offers only `take`, so asking for three of something there is one of does not
   * compile. Nothing is fetched here: the handle records what you know the resource to
   * be, which is what lets the type hold at the point of use — usually a different
   * service from the one that declared the inventory.
   *
   * Declaring it wrong is still possible. `pooled('seat_A12').takeMany(3)` compiles and
   * the engine refuses it at runtime, the same as before. This is a safety net, not a
   * guarantee.
   */
  unitary(key: string): UnitaryResource {
    return unitaryHandle(key, (resourceKey, amount, options) =>
      this.#take(resourceKey, amount, options),
    );
  }

  /** A handle on a multi-unit resource. Offers `take` and `takeMany`. */
  pooled(key: string): PooledResource {
    return pooledHandle(key, (resourceKey, amount, options) =>
      this.#take(resourceKey, amount, options),
    );
  }

  async #take(
    resourceKey: string,
    amount: number,
    options: TakeOptions,
  ): Promise<ResourceHolder> {
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

    return assertUsable(toResourceHolder(response));
  }

  // --- Holders -------------------------------------------------------------------

  /**
   * Settles a holder for good. The units stop being pending and stay taken.
   *
   * ```typescript
   * await caerus.confirm(holder.id, { metadata: { paymentId } });
   * ```
   */
  async confirm(resourceHolderId: string, options: ConfirmOptions = {}): Promise<ResourceHolder> {
    requireText(resourceHolderId, 'resourceHolderId');

    const response = await this.#transport.unary(
      this.#transport.raw.confirm.bind(this.#transport.raw),
      {
        resourceHolderId,
        metadataPatch: encodeMetadata(options.metadata),
      },
    );

    return assertUsable(toResourceHolder(response));
  }

  /**
   * Gives the units back before the holder lapses.
   *
   * Worth calling on every path that abandons a checkout: without it the stock stays
   * held until the TTL runs out.
   */
  async release(resourceHolderId: string): Promise<void> {
    requireText(resourceHolderId, 'resourceHolderId');

    await this.#transport.unary(this.#transport.raw.release.bind(this.#transport.raw), {
      resourceHolderId,
    });
  }

  /**
   * Pushes the expiry further out.
   *
   * ```typescript
   * await caerus.extend(holder.id, 300_000); // five more minutes
   * ```
   *
   * **Milliseconds**, unlike `ttlSeconds` — that is what the contract asks for. The
   * engine works in whole seconds and rounds up, so anything under 1000 buys exactly one
   * second.
   *
   * Never retried automatically: a repeated extend adds the time twice and says nothing
   * about it.
   */
  async extend(resourceHolderId: string, extraMs: number): Promise<ResourceHolder> {
    requireText(resourceHolderId, 'resourceHolderId');
    requirePositive(extraMs, 'extraMs');

    const response = await this.#transport.unary(
      this.#transport.raw.extend.bind(this.#transport.raw),
      { resourceHolderId, extraMs },
    );

    return assertUsable(toResourceHolder(response));
  }

  /**
   * Reads a holder as it stands.
   *
   * This is the one place an `EXPIRED` holder is returned rather than thrown: asking what
   * state something is in and being told EXPIRED is an answer, not a failure.
   */
  async getResourceHolder(resourceHolderId: string): Promise<ResourceHolder> {
    requireText(resourceHolderId, 'resourceHolderId');

    const response = await this.#transport.unary(
      this.#transport.raw.getResourceHolder.bind(this.#transport.raw),
      { resourceHolderId },
    );

    return toResourceHolder(response);
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

function requireInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${name} must be a finite integer`);
  }
}
