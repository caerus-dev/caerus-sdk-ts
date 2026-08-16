import type { SharedResourceApi } from './api.js';
import { CaerusError, ConflictError, ResourceNotFoundError, ValidationError } from './errors.js';
import { pooledHandle, unitaryHandle } from './internal/handles.js';
import type {
  ConfirmOptions,
  CreateResourceOptions,
  GetResourcesByGroupOptions,
  ListResourceHoldersOptions,
  Metadata,
  PooledResource,
  Resource,
  ResourceHolder,
  ResourceHolderPage,
  ResourcePage,
  TakeOptions,
  UnitaryResource,
  UpdateResourceOptions,
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
  | 'createUnitary'
  | 'createMultiple'
  | 'updateResource'
  | 'deleteResource'
  | 'take'
  | 'takeMany'
  | 'confirm'
  | 'release'
  | 'extend'
  | 'getResource'
  | 'getResourcesByGroup'
  | 'getResourceHolder'
  | 'listResourceHolders';

export interface MockOptions {
  /** Stock to start with. Resources can also be created through the API. */
  resources?: MockResourceSeed[];
  /** TTL applied when a take does not ask for one. Defaults to 300 seconds. */
  defaultTtlSeconds?: number;
  /** Page size for group queries when none is asked for. Defaults to 25. */
  defaultPageSize?: number;
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

interface StoredHolder {
  id: string;
  resourceKey: string;
  resourceId: string;
  amount: number;
  status: ResourceHolderStatusValue;
  expiresAtSeconds: number;
  metadata?: Metadata;
}

type ResourceHolderStatusValue = ResourceHolder['status'];

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_PAGE_SIZE = 25;

/**
 * Caerus, in memory, for testing an integration without running anything.
 *
 * It implements {@link SharedResourceApi}, handles included, so it drops into wherever
 * the real client goes. Stock is tracked for real — taking decrements it, releasing gives
 * it back — so a test that takes more than exists fails the way production would.
 *
 * ```typescript
 * const caerus = new InMemoryCaerusClient({
 *   resources: [{ key: 'seat_A12', availableAmount: 1 }],
 * });
 *
 * const holder = await caerus.unitary('seat_A12').take();
 * await caerus.confirm(holder.id);
 * ```
 *
 * ## Time does not pass on its own
 *
 * Holders carry a real `expiresAt`, but nothing expires until you say so:
 *
 * ```typescript
 * caerus.advanceTime(600);   // ten minutes later
 * ```
 *
 * A mock that expired holders on a wall clock would make its users' tests wait, and then
 * fail now and then depending on how busy the machine was. Tests are supposed to be the
 * deterministic part. Time is an input here, like the stock.
 */
export class InMemoryCaerusClient implements SharedResourceApi {
  readonly #resources = new Map<string, StoredResource>();
  readonly #holders = new Map<string, StoredHolder>();
  readonly #idempotency = new Map<string, string>();
  readonly #failures = new Map<MockMethod, CaerusError[]>();
  readonly #defaultTtlSeconds: number;
  readonly #defaultPageSize: number;

  #nowSeconds = Math.floor(Date.now() / 1000);
  #sequence = 0;
  #closed = false;

  constructor(options: MockOptions = {}) {
    this.#defaultTtlSeconds = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    this.#defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;

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

    for (const holder of this.#holders.values()) {
      if (holder.status === 'PENDING' && holder.expiresAtSeconds <= this.#nowSeconds) {
        this.#expire(holder);
      }
    }
  }

  /** Expires one holder regardless of its TTL. */
  expire(resourceHolderId: string): void {
    const holder = this.#requireHolder(resourceHolderId);
    if (holder.status !== 'PENDING') {
      throw new ConflictError(`Holder ${resourceHolderId} is ${holder.status} and cannot expire.`);
    }
    this.#expire(holder);
  }

  /** What the mock currently believes, for assertions that go beyond the API. */
  snapshot(): { resources: Resource[]; holders: ResourceHolder[] } {
    return {
      resources: [...this.#resources.values()].map((resource) => this.#toResource(resource)),
      holders: [...this.#holders.values()].map((held) => this.#toHolder(held)),
    };
  }

  // --- Inventory --------------------------------------------------------------------

  async createUnitary(
    templateName: string,
    key: string,
    options: CreateResourceOptions = {},
  ): Promise<Resource> {
    this.#guard('createUnitary');
    return this.#createResource(templateName, key, 1, options);
  }

  async createMultiple(
    templateName: string,
    key: string,
    availableAmount: number,
    options: CreateResourceOptions = {},
  ): Promise<Resource> {
    this.#guard('createMultiple');
    requirePositive(availableAmount, 'availableAmount');
    return this.#createResource(templateName, key, availableAmount, options);
  }

  #createResource(
    templateName: string,
    key: string,
    availableAmount: number,
    options: CreateResourceOptions,
  ): Resource {
    requireText(templateName, 'templateName');
    requireText(key, 'key');

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

  async updateResource(
    key: string,
    deltaAmount: number,
    options: UpdateResourceOptions = {},
  ): Promise<Resource> {
    this.#guard('updateResource');
    requireText(key, 'key');
    requireInteger(deltaAmount, 'deltaAmount');

    const resource = this.#requireResource(key);

    if (resource.availableAmount + deltaAmount < 0) {
      throw new ConflictError(
        `Available amount cannot be negative for resource: ${key}`,
      );
    }

    resource.availableAmount += deltaAmount;
    if (options.groupKey !== undefined) {
      resource.groupKey = options.groupKey;
    }
    if (options.metadata !== undefined) {
      resource.metadata = options.metadata;
    }

    return this.#toResource(resource);
  }

  async deleteResource(key: string): Promise<void> {
    this.#guard('deleteResource');
    requireText(key, 'key');

    const resource = this.#requireResource(key);

    if (resource.pendingCount > 0) {
      throw new ConflictError(
        `Cannot delete resource with active holds: ${key}`,
      );
    }

    this.#resources.delete(key);
  }

  // --- Handles ----------------------------------------------------------------------

  unitary(key: string): UnitaryResource {
    // async, so a refusal comes back as a rejected promise rather than a synchronous
    // throw — which is how the real client behaves and therefore how this must too.
    return unitaryHandle(key, async (resourceKey, amount, options) => {
      this.#guard('take');
      return this.#take(resourceKey, amount, options);
    });
  }

  pooled(key: string): PooledResource {
    return pooledHandle(key, async (resourceKey, amount, options) => {
      this.#guard(amount === 1 ? 'take' : 'takeMany');
      return this.#take(resourceKey, amount, options);
    });
  }

  // --- Holders ----------------------------------------------------------------------

  async confirm(
    resourceHolderId: string,
    options: ConfirmOptions = {},
  ): Promise<ResourceHolder> {
    this.#guard('confirm');
    const holder = this.#requireHolder(resourceHolderId);

    if (holder.status !== 'PENDING') {
      throw new ConflictError(
        `Holder ${resourceHolderId} is ${holder.status} and cannot be confirmed.`,
      );
    }

    const resource = this.#requireResource(holder.resourceKey);
    // Confirming keeps the units taken: they stop being pending, they do not come back.
    resource.pendingCount -= holder.amount;
    holder.status = 'CONFIRMED';
    if (options.metadata !== undefined) {
      holder.metadata = options.metadata;
    }

    return this.#toHolder(holder);
  }

  async release(resourceHolderId: string): Promise<void> {
    this.#guard('release');
    const holder = this.#requireHolder(resourceHolderId);

    if (holder.status !== 'PENDING') {
      throw new ConflictError(
        `Holder ${resourceHolderId} is ${holder.status} and cannot be released.`,
      );
    }

    this.#giveBack(holder, 'RELEASED');
  }

  async extend(resourceHolderId: string, extraMs: number): Promise<ResourceHolder> {
    this.#guard('extend');
    requirePositive(extraMs, 'extraMs');
    const holder = this.#requireHolder(resourceHolderId);

    if (holder.status !== 'PENDING') {
      throw new ConflictError(
        `Holder ${resourceHolderId} is ${holder.status} and cannot be extended.`,
      );
    }

    // Rounding up, the way the engine does: anything under a second buys one second.
    holder.expiresAtSeconds += Math.ceil(extraMs / 1000);
    return this.#toHolder(holder);
  }

  async getResourceHolder(resourceHolderId: string): Promise<ResourceHolder> {
    this.#guard('getResourceHolder');
    // Like the real client, a query reports EXPIRED rather than throwing on it.
    return this.#toHolder(this.#requireHolder(resourceHolderId));
  }

  // --- Queries ----------------------------------------------------------------------

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

  async listResourceHolders(
    options: ListResourceHoldersOptions = {},
  ): Promise<ResourceHolderPage> {
    this.#guard('listResourceHolders');

    // There is no created-at here, but a Map keeps insertion order, and holders are only
    // ever appended — so insertion order *is* creation order.
    let matching = [...this.#holders.values()];
    if (options.resourceKey !== undefined) {
      matching = matching.filter((held) => held.resourceKey === options.resourceKey);
    }
    if (options.status !== undefined) {
      matching = matching.filter((held) => held.status === options.status);
    }
    if (options.sort !== 'OLDEST_FIRST') {
      matching.reverse();
    }

    const page = options.page ?? 0;
    const pageSize = options.pageSize ?? this.#defaultPageSize;
    const start = page * pageSize;
    const slice = matching.slice(start, start + pageSize);

    return {
      holders: slice.map((held) => this.#toHolder(held)),
      hasNextPage: start + pageSize < matching.length,
    };
  }

  close(): void {
    this.#closed = true;
  }

  // --- Internals --------------------------------------------------------------------

  #take(resourceKey: string, amount: number, options: TakeOptions): ResourceHolder {
    if (options.ttlSeconds !== undefined) {
      requirePositive(options.ttlSeconds, 'ttlSeconds');
    }

    // Repeating an idempotency key gives back the first holder instead of taking more
    // stock, which is what the engine does and what makes a retry safe.
    if (options.idempotencyKey !== undefined) {
      const known = this.#idempotency.get(options.idempotencyKey);
      if (known !== undefined) {
        return this.#toHolder(this.#requireHolder(known));
      }
    }

    const resource = this.#requireResource(resourceKey);
    if (resource.availableAmount < amount) {
      // The same type and wording the engine produces. A mock that reported this
      // differently would teach a lesson that only breaks in production.
      throw new ConflictError(`Out of stock for resource: ${resourceKey}`);
    }

    resource.availableAmount -= amount;
    resource.pendingCount += amount;

    const holder: StoredHolder = {
      id: this.#nextId('hld'),
      resourceKey,
      resourceId: resource.id,
      amount,
      status: 'PENDING',
      expiresAtSeconds: this.#nowSeconds + (options.ttlSeconds ?? this.#defaultTtlSeconds),
      metadata: options.metadata,
    };
    this.#holders.set(holder.id, holder);

    if (options.idempotencyKey !== undefined) {
      this.#idempotency.set(options.idempotencyKey, holder.id);
    }

    return this.#toHolder(holder);
  }

  #expire(holder: StoredHolder): void {
    this.#giveBack(holder, 'EXPIRED');
  }

  /** Returns the units to the resource and marks the holder with its new status. */
  #giveBack(holder: StoredHolder, status: ResourceHolderStatusValue): void {
    const resource = this.#requireResource(holder.resourceKey);
    resource.availableAmount += holder.amount;
    resource.pendingCount -= holder.amount;
    holder.status = status;
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

  #requireHolder(id: string): StoredHolder {
    requireText(id, 'resourceHolderId');
    const holder = this.#holders.get(id);
    if (!holder) {
      throw new ResourceNotFoundError(`ResourceHolder not found: ${id}`);
    }
    return holder;
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

  #toHolder(holder: StoredHolder): ResourceHolder {
    return {
      id: holder.id,
      resourceId: holder.resourceId,
      status: holder.status,
      amount: holder.amount,
      expiresAt: new Date(holder.expiresAtSeconds * 1000),
      metadata: holder.metadata,
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

function requireInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${name} must be a finite integer`);
  }
}
