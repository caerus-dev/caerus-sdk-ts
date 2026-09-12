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

/** Every error this package throws extends this one, so `catch` can take them together. */
export class CaerusError extends Error {
  readonly code: CaerusErrorCode;
  /**
   * The engine's own name for what happened, when it sent one: OUT_OF_STOCK,
   * HOLDER_NOT_ACTIVE and so on. Stable across releases and safe to switch on, unlike
   * the message, which is written for people.
   */
  readonly reason?: string;

  constructor(
    message: string,
    code: CaerusErrorCode = 'UNKNOWN',
    options?: { cause?: unknown; reason?: string },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.reason = options?.reason;
    // Without this, `instanceof` breaks for anyone consuming the CommonJS build from a
    // project that targets ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
