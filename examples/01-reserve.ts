/**
 * The whole point of Caerus, in one call.
 *
 * `reserve` holds the stock, runs your work, and settles the reservation either way:
 * confirmed if your work returns, released if it throws. You never write the release.
 */
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  // Replace with your engine's address. See the README.
  endpoint: 'REPLACE_ME.caerus.example:9090',
  apiKey: process.env.CAERUS_API_KEY ?? '',
});

declare function chargeCard(amount: number): Promise<{ paymentId: string }>;
declare function issueTicket(paymentId: string): Promise<string>;

export async function buySeat(): Promise<string> {
  // If chargeCard throws, seat_A12 goes back on sale before this function returns.
  // If it succeeds, the seat is confirmed and stays taken.
  return caerus.reserve('seat_A12', async () => {
    const { paymentId } = await chargeCard(4500);
    return issueTicket(paymentId);
  });
}

/** Several units of the same resource. */
export async function buyFourTickets(): Promise<string> {
  return caerus.reserveMany('general_admission', 4, async () => {
    const { paymentId } = await chargeCard(18000);
    return issueTicket(paymentId);
  });
}

/** The reservation is there if you need it — its id, its expiry, its metadata. */
export async function buySeatWithOptions(): Promise<string> {
  return caerus.reserve(
    'seat_A12',
    async (reservation) => {
      console.log(`holding ${reservation.amount} until ${reservation.expiresAt.toISOString()}`);
      const { paymentId } = await chargeCard(4500);
      return issueTicket(paymentId);
    },
    {
      // Two minutes to pay, whatever the template's default is.
      ttlSeconds: 120,
      // Travels with the reservation and comes back on every read of it.
      metadata: { orderId: 'ord_1234', channel: 'web' },
    },
  );
}
