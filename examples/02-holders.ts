/**
 * Working with a holder that outlives one function.
 *
 * A checkout spanning several HTTP requests takes on one and confirms on another, so the
 * holder id is what travels between them.
 */
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  endpoint: 'REPLACE_ME.caerus.example:9090',
  apiKey: process.env.CAERUS_API_KEY ?? '',
});

declare function chargeCard(amount: number): Promise<{ paymentId: string }>;

/** First request: hold the seat and hand the id back to the browser. */
export async function startCheckout(): Promise<string | null> {
  const holder = await caerus.unitary('seat_A12').take({
    ttlSeconds: 300,
    metadata: { orderId: 'ord_1234' },
  });

  // A queued holder is real, but it is not holding anything yet: the engine is waiting
  // for stock. Nothing has been taken on your behalf.
  if (holder.status === 'QUEUED') {
    console.log('No stock right now. Caerus queued the request.');
    return null;
  }

  return holder.id;
}

/** Second request: the customer paid. */
export async function finishCheckout(resourceHolderId: string): Promise<void> {
  try {
    const { paymentId } = await chargeCard(4500);
    await caerus.confirm(resourceHolderId, { metadata: { paymentId } });
  } catch (error) {
    await caerus.release(resourceHolderId);
    throw error;
  }
}

/**
 * Buying time while the customer is still typing their card number.
 *
 * Milliseconds — unlike `ttlSeconds`, which is in seconds. The mismatch comes from the
 * contract, not from this SDK.
 */
export async function giveThemLonger(resourceHolderId: string): Promise<void> {
  const holder = await caerus.extend(resourceHolderId, 300_000);

  console.log(`now expires at ${holder.expiresAt.toISOString()}`);
}

/** Checking on a holder you took earlier. */
export async function stillHeld(resourceHolderId: string): Promise<boolean> {
  const holder = await caerus.getResourceHolder(resourceHolderId);

  // A query reports the status rather than throwing on it, EXPIRED included.
  return holder.status === 'PENDING';
}
