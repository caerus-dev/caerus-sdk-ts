import { CaerusError } from '../errors.js';

/**
 * Thrown when a webhook's signature is missing, malformed, or does not match.
 */
export class CaerusSignatureError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'VALIDATION', options);
  }
}

/**
 * Thrown when a webhook's timestamp is outside the allowable tolerance window.
 */
export class CaerusWebhookExpiredError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'VALIDATION', options);
  }
}

/**
 * Thrown when a webhook's body carries a valid signature but is not valid JSON.
 */
export class CaerusWebhookPayloadError extends CaerusError {
  constructor(message: string, options?: { cause?: unknown; reason?: string }) {
    super(message, 'VALIDATION', options);
  }
}
