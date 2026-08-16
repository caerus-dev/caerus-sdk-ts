import type {
  ConfirmOptions,
  CreateResourceOptions,
  GetResourcesByGroupOptions,
  ListResourceHoldersOptions,
  PooledResource,
  Resource,
  ResourceHolder,
  ResourceHolderPage,
  ResourcePage,
  UnitaryResource,
  UpdateResourceOptions,
} from './types.js';

/**
 * Everything the Shared Resource Engine can do, as a type.
 *
 * Both `CaerusClient` and `InMemoryCaerusClient` implement it, so a codebase can accept
 * this and be handed either one. That is the whole point of the in-memory version: tests
 * swap it in without the code under test knowing.
 *
 * ```typescript
 * function checkout(caerus: SharedResourceApi) { ... }
 *
 * checkout(new CaerusClient({ endpoint, apiKey }));   // production
 * checkout(new InMemoryCaerusClient({ ... }));        // tests
 * ```
 */
export interface SharedResourceApi {
  // --- Inventory ------------------------------------------------------------------

  /**
   * Declares a resource that holds exactly one unit. Takes no amount, because there is
   * only ever one.
   */
  createUnitary(
    templateName: string,
    key: string,
    options?: CreateResourceOptions,
  ): Promise<Resource>;

  /** Declares a resource with several interchangeable units. */
  createMultiple(
    templateName: string,
    key: string,
    availableAmount: number,
    options?: CreateResourceOptions,
  ): Promise<Resource>;

  /** Adjusts the stock of an existing resource by a delta (positive or negative). */
  updateResource(
    key: string,
    deltaAmount: number,
    options?: UpdateResourceOptions,
  ): Promise<Resource>;

  /** Removes a resource. Fails if it has active (pending) holders. */
  deleteResource(key: string): Promise<void>;

  // --- Handles --------------------------------------------------------------------

  /**
   * A handle on a single-unit resource. Only offers `take`.
   *
   * Nothing is fetched: this declares what you know the resource to be, so the type
   * system can hold you to it wherever the reserving actually happens.
   */
  unitary(key: string): UnitaryResource;

  /** A handle on a multi-unit resource. Offers `take` and `takeMany`. */
  pooled(key: string): PooledResource;

  // --- Holders --------------------------------------------------------------------

  /** Settles a holder for good. The units stay taken. */
  confirm(resourceHolderId: string, options?: ConfirmOptions): Promise<ResourceHolder>;

  /** Gives the units back before the holder lapses. */
  release(resourceHolderId: string): Promise<void>;

  /** Pushes the expiry further out, in milliseconds. */
  extend(resourceHolderId: string, extraMs: number): Promise<ResourceHolder>;

  /** Reads a holder as it stands. */
  getResourceHolder(resourceHolderId: string): Promise<ResourceHolder>;

  // --- Queries --------------------------------------------------------------------

  /** Reads a resource and its current stock. */
  getResource(key: string): Promise<Resource>;

  /** Reads one page of the resources sharing a group key. */
  getResourcesByGroup(
    groupKey: string,
    options?: GetResourcesByGroupOptions,
  ): Promise<ResourcePage>;

  /**
   * Reads one page of holders, newest first, narrowed by resource and state.
   *
   * Named apart from `getResourceHolder` on purpose: one letter of difference between a
   * method that fetches one and a method that lists many is a mistake waiting to happen.
   */
  listResourceHolders(options?: ListResourceHoldersOptions): Promise<ResourceHolderPage>;

  /** Releases whatever the implementation is holding on to. */
  close(): void;
}
