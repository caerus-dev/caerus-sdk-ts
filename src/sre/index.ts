export { CaerusClient, CaerusClient as SreClient } from './client.js';
export type { SharedResourceApi } from './api.js';

export {
  InMemoryCaerusClient,
  InMemoryCaerusClient as InMemorySreClient,
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
  ConflictError,
  HolderNotActiveError,
  OutOfStockError,
  ResourceHasActiveHoldsError,
  ResourceHasQueuedRequestsError,
  ResourceNotFoundError,
  TimeoutError,
  ValidationError,
} from './errors.js';
