import * as crypto from 'crypto';
import { CaerusSignatureError, CaerusWebhookExpiredError } from './errors.js';
import type { CaerusEvent } from './types.js';

export class Webhooks {
  /**
   * Verifies and constructs a strongly typed CaerusEvent from a raw request.
   *
   * @param payload The raw request body as string or Buffer.
   * @param signatureHeader The `caerus-signature` header value.
   * @param secret The webhook signing secret.
   * @param toleranceSeconds Time tolerance in seconds to prevent replay attacks (default 300s / 5m).
   */
  constructEvent(
    payload: string | Buffer,
    signatureHeader: string,
    secret: string,
    toleranceSeconds: number = 300
  ): CaerusEvent {
    if (!signatureHeader) {
      throw new CaerusSignatureError('No signature header provided.');
    }

    const headerParts = signatureHeader.split(',').map((p) => p.trim());
    const timestampStr = headerParts.find((p) => p.startsWith('t='))?.substring(2);
    const signatures = headerParts
      .filter((p) => p.startsWith('v1='))
      .map((p) => p.substring(3));

    if (!timestampStr || signatures.length === 0) {
      throw new CaerusSignatureError('Invalid signature format.');
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      throw new CaerusSignatureError('Invalid signature format.');
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTimestamp - timestamp) > toleranceSeconds) {
      throw new CaerusWebhookExpiredError('Webhook timestamp is outside of the tolerance zone.');
    }

    const rawPayload = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;

    const contentToSign = `${timestampStr}.${rawPayload}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(contentToSign, 'utf8')
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'ascii');

    const isValid = signatures.some((sig) => {
      const sigBuffer = Buffer.from(sig, 'ascii');
      if (sigBuffer.length !== expectedBuffer.length) {
        return false;
      }
      return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    });

    if (!isValid) {
      throw new CaerusSignatureError('No matching signature found.');
    }

    return JSON.parse(rawPayload) as CaerusEvent;
  }
}
