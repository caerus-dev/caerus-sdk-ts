/**
 * What went wrong, as a value you can switch on.
 *
 * These are strings rather than gRPC's numeric codes on purpose: a user of this package
 * should never need to learn gRPC to handle an error, and the same names carry over to
 * the SDKs coming in other languages.
 */
export type CaerusErrorCode =
  | 'RESOURCE_NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'AUTHENTICATION'
  | 'TIMEOUT'
  | 'UNKNOWN';

/**
 * Machine-readable error reasons sent by the Caerus data plane via google.rpc.ErrorInfo.
 */
export type CaerusErrorReason =
  // SRE (Shared Resource Engine)
  | 'OUT_OF_STOCK'
  | 'HOLDER_NOT_ACTIVE'
  | 'RESOURCE_HAS_ACTIVE_HOLDS'
  | 'RESOURCE_HAS_QUEUED_REQUESTS'
  | 'TEMPLATE_NOT_FOUND'
  // DLS (Distributed Lock Service)
  | 'DEADLOCK_DETECTED'
  | 'TRANSACTION_NOT_ACTIVE'
  | 'LOCK_ALREADY_HELD_EXCLUSIVELY'
  | 'LOCK_MODE_MISMATCH'
  | 'LOCK_ACQUISITION_CANCELLED'
  | 'LOCK_DENIED'
  // Common
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'RESOURCE_NOT_FOUND';

/**
 * Options passed when creating any CaerusError.
 */
export interface CaerusErrorOptions {
  cause?: unknown;
  reason?: CaerusErrorReason | string;
  requestId?: string;
}

/** Every error this package throws extends this one, so `catch` can take them together. */
export class CaerusError extends Error {
  readonly code: CaerusErrorCode;
  /**
   * The engine's own name for what happened, when it sent one: OUT_OF_STOCK,
   * HOLDER_NOT_ACTIVE and so on. Stable across releases and safe to switch on, unlike
   * the message, which is written for people.
   */
  readonly reason?: CaerusErrorReason | string;
  /**
   * Correlation ID of the request (e.g. req_3fa85f64-5717-4562-b3fc-2c963f66afa6).
   * Share this ID when contacting support or troubleshooting in Discord.
   */
  readonly requestId?: string;

  constructor(
    message: string,
    code: CaerusErrorCode = 'UNKNOWN',
    options?: CaerusErrorOptions,
  ) {
    const enrichedMessage =
      options?.requestId && !message.includes(options.requestId)
        ? `${message} (Request ID: ${options.requestId}). Contacta soporte en Discord con este ID.`
        : message;
    super(enrichedMessage, options);
    this.name = new.target.name;
    this.code = code;
    this.reason = options?.reason;
    this.requestId = options?.requestId;
    // Without this, `instanceof` breaks for anyone consuming the CommonJS build from a
    // project that targets ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Direct documentation URL explaining error handling and resolutions.
   */
  get docUrl(): string {
    return 'https://github.com/caerus-dev/caerus-sdk-ts/blob/main/docs/errores.md';
  }
}
