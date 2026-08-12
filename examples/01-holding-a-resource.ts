/**
 * Taking a resource, paying for it, and settling either way.
 *
 * The cycle is always the same: take, do your work, then confirm or release. Caerus
 * holds the stock in between, and if your process dies the hold expires on its own.
 */
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  // Replace with your engine's address. See the README.
  endpoint: process.env.CAERUS_ENDPOINT!,
  apiKey: process.env.CAERUS_API_KEY ?? '',
});

declare function chargeCard(amount: number): Promise<{ paymentId: string }>;
declare function issueTicket(paymentId: string): Promise<string>;

/**
 * A numbered seat: one of it, so `unitary`.
 *
 * The handle offers only `take`. Asking for three of a seat does not compile.
 */
export async function buySeat(): Promise<string> {
  const seat = caerus.unitary('seat_A12');
  const holder = await seat.take({ ttlSeconds: 120, metadata: { orderId: 'ord_1234' } });

  try {
    const { paymentId } = await chargeCard(4500);
    await caerus.confirm(holder.id, { metadata: { paymentId } });
    return issueTicket(paymentId);
  } catch (error) {
    // Without this the seat stays held until its TTL runs out.
    await caerus.release(holder.id);
    throw error;
  }
}

/**
 * Interchangeable units: `pooled`, which adds `takeMany`.
 */
export async function buyFourTickets(): Promise<string> {
  const pool = caerus.pooled('general_admission');
  const holder = await pool.takeMany(4);

  try {
    const { paymentId } = await chargeCard(18000);
    await caerus.confirm(holder.id, { metadata: { paymentId } });
    return issueTicket(paymentId);
  } catch (error) {
    await caerus.release(holder.id);
    throw error;
  }
}

/**
 * The handle is just a name and a type — nothing is fetched when you make one.
 *
 * That is what lets the service doing the reserving declare what it expects, even though
 * the inventory was created somewhere else entirely.
 */
export function seatsInThisService() {
  return {
    seatA12: caerus.unitary('seat_A12'),
    generalAdmission: caerus.pooled('general_admission'),
  };
}
