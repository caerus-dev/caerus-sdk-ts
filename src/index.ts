/**
 * `@caerus-dev/sdk` — the Caerus client for Node.js.
 *
 * Everything exported from this file is public API. Nothing generated from the .proto
 * belongs here: that code has protobuf's shape, not a shape anyone would design, and
 * exporting it would make the wire format part of the contract with our users.
 */

export { CaerusClient } from './client.js';
export { DEFAULT_TIMEOUT_MS, type CaerusClientOptions } from './options.js';

export {
  CaerusError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
  AuthenticationError,
  TimeoutError,
  type CaerusErrorCode,
} from './errors.js';

export { VERSION } from './version.js';
