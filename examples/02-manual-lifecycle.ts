/**
 * The same cycle, spelled out.
 *
 * Use this when the hold has to outlive one function — a checkout that spans several
 * HTTP requests, say, where you take on one and confirm on another. Everywhere else
 * `reserve` is less code and cannot forget the release.
 */
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  endpoint: 'REPLACE_ME.caerus.example:9090',
  apiKey: process.env.CAERUS_API_KEY ?? '',
});

declare function chargeCard(amount: number): Promise<{ paymentId: string }>;

export async function checkout(): Promise<void> {
  const reservation = await caerus.take('seat_A12', {
    ttlSeconds: 300,
    metadata: { orderId: 'ord_1234' },
  });

  // A queued reservation is real, but it is not holding anything yet: the engine is
  // waiting for stock. Nothing has been taken on your behalf.
  if (reservation.status === 'QUEUED') {
    console.log('No stock right now. Caerus queued the request.');
    return;
  }

  try {
    const { paymentId } = await chargeCard(4500);
    await caerus.confirm(reservation.id, { metadata: { paymentId } });
  } catch (error) {
    // Without this the seat stays held until its TTL runs out.
    await caerus.release(reservation.id);
    throw error;
  }
}

/** Buying time when the customer is still typing their card number. */
export async function giveThemLonger(reservationId: string): Promise<void> {
  // Seconds, like every other duration in this SDK.
  const reservation = await caerus.extend(reservationId, 300);

  console.log(`now expires at ${reservation.expiresAt.toISOString()}`);
}

/** Checking on a hold you took earlier. */
export async function stillHeld(reservationId: string): Promise<boolean> {
  const reservation = await caerus.getReservation(reservationId);

  // A query reports the status rather than throwing on it, FAILED included.
  return reservation.status === 'PENDING';
}
