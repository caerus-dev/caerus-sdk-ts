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
  PooledResource,
  Resource,
  ResourceHolder,
  ResourceHolderStatus,
  ResourcePage,
  TakeOptions,
  UnitaryResource,
} from './types.js';

export {
  AuthenticationError,
  CaerusError,
  ConflictError,
  ResourceNotFoundError,
  TimeoutError,
  ValidationError,
  type CaerusErrorCode,
} from './errors.js';

export { VERSION } from './version.js';
