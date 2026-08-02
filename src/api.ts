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
  /** Declares something that can be reserved. */
  createResource(
    templateName: string,
    key: string,
    availableAmount: number,
    options?: CreateResourceOptions,
  ): Promise<Resource>;

  /** Holds one unit. */
  take(resourceKey: string, options?: TakeOptions): Promise<Reservation>;

  /** Holds several units at once. */
  takeMany(resourceKey: string, amount: number, options?: TakeOptions): Promise<Reservation>;

  /** Settles a reservation for good. */
  confirm(reservationId: string, options?: ConfirmOptions): Promise<Reservation>;

  /** Gives the units back before the reservation lapses. */
  release(reservationId: string): Promise<void>;

  /** Pushes the expiry further out, in seconds. */
  extend(reservationId: string, extraSeconds: number): Promise<Reservation>;

  /** Holds one unit, runs the work, and confirms or releases. */
  reserve<T>(
    resourceKey: string,
    work: ReservationWork<T>,
    options?: TakeOptions,
  ): Promise<T>;

  /** The same, for several units. */
  reserveMany<T>(
    resourceKey: string,
    amount: number,
    work: ReservationWork<T>,
    options?: TakeOptions,
  ): Promise<T>;

  /** Reads a resource and its current stock. */
  getResource(key: string): Promise<Resource>;

  /** Reads one page of the resources sharing a group key. */
  getResourcesByGroup(
    groupKey: string,
    options?: GetResourcesByGroupOptions,
  ): Promise<ResourcePage>;

  /** Reads a reservation as it stands. */
  getReservation(reservationId: string): Promise<Reservation>;

  /** Releases whatever the implementation is holding on to. */
  close(): void;
}
