/**
 * `@caerus-dev/sdk` — the Caerus client for Node.js.
 *
 * Everything exported from this file is public API. Nothing generated from the .proto
 * belongs here: that code has protobuf's shape, not a shape anyone would design, and
 * exporting it would make the wire format part of the contract with our users.
 */

export { CaerusClient } from './client.js';
export type { SharedResourceApi } from './api.js';

export {
  InMemoryCaerusClient,
  type MockMethod,
  type MockOptions,
  type MockResourceSeed,
} from './mock.js';
export { DEFAULT_TIMEOUT_MS, type CaerusClientOptions, type CaerusLogger } from './options.js';

export type {
  ConfirmOptions,
  CreateResourceOptions,
  GetResourcesByGroupOptions,
  Metadata,
  Reservation,
  ReservationStatus,
  ReservationWork,
  Resource,
  ResourcePage,
  TakeOptions,
} from './types.js';

export {
  AuthenticationError,
  CaerusError,
  ConflictError,
  OutOfStockError,
  ResourceNotFoundError,
  TimeoutError,
  ValidationError,
  type CaerusErrorCode,
} from './errors.js';

export { VERSION } from './version.js';
