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
export {
  DEFAULT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  type CaerusClientOptions,
  type CaerusLogger,
} from './options.js';

export type {
  ConfirmOptions,
  CreateResourceOptions,
  GetResourcesByGroupOptions,
  ListResourceHoldersOptions,
  Metadata,
  PooledResource,
  Resource,
  ResourceHolder,
  ResourceHolderStatus,
  ResourceHolderPage,
  ResourcePage,
  TakeOptions,
  UnitaryResource,
  UpdateResourceOptions,
} from './types.js';

export {
  AuthenticationError,
  CaerusError,
  ConflictError,
  HolderNotActiveError,
  OutOfStockError,
  ResourceHasActiveHoldsError,
  ResourceHasQueuedRequestsError,
  ResourceNotFoundError,
  TimeoutError,
  ValidationError,
  type CaerusErrorCode,
} from './errors.js';

export { VERSION } from './version.js';
