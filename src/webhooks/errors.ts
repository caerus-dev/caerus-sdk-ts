/**
 * Thrown when a webhook's signature is missing, malformed, or does not match.
 */
export class CaerusSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaerusSignatureError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a webhook's timestamp is outside the allowable tolerance window.
 */
export class CaerusWebhookExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaerusWebhookExpiredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
