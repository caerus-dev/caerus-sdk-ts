/**
 * Testing your integration without running Caerus.
 *
 * `InMemoryCaerusClient` implements the same interface as the real one, so your code
 * cannot tell them apart. It keeps real stock: a test that reserves more than exists
 * fails here the way it would in production.
 */
import { ConflictError, InMemoryCaerusClient, type SharedResourceApi } from '@caerus-dev/sdk';

declare function chargeCard(amount: number): Promise<{ paymentId: string }>;

/**
 * Take the interface, not the class. That is the whole trick: production passes the real
 * client, tests pass the in-memory one, and this function never knows.
 */
export async function buySeat(caerus: SharedResourceApi, seat: string): Promise<string> {
  const holder = await caerus.unitary(seat).take();

  try {
    const { paymentId } = await chargeCard(4500);
    await caerus.confirm(holder.id, { metadata: { paymentId } });
    return paymentId;
  } catch (error) {
    await caerus.release(holder.id);
    throw error;
  }
}

export function aTestEngine(): InMemoryCaerusClient {
  return new InMemoryCaerusClient({
    resources: [
      { key: 'seat_A12', availableAmount: 1, groupKey: 'row_A' },
      { key: 'general_admission', availableAmount: 100 },
    ],
    defaultTtlSeconds: 300,
  });
}

/** The happy path. */
export async function testHappyPath(): Promise<void> {
  const caerus = aTestEngine();

  await buySeat(caerus, 'seat_A12');

  const seat = await caerus.getResource('seat_A12');
  console.assert(seat.availableAmount === 0, 'the seat should be taken');
  console.assert(seat.pendingCount === 0, 'and confirmed, so no longer pending');
}

/** Running out of stock, without needing to sell out a real venue. */
export async function testSoldOut(): Promise<void> {
  const caerus = aTestEngine();

  await buySeat(caerus, 'seat_A12');

  await buySeat(caerus, 'seat_A12').then(
    () => console.assert(false, 'should have failed'),
    (error: unknown) => console.assert(error instanceof ConflictError),
  );
}

/**
 * Your own error path: the payment fails, and you want to check the seat went back on
 * sale. `failNext` is there for the cases you cannot cause any other way.
 */
export async function testPaymentFails(): Promise<void> {
  const caerus = aTestEngine();

  caerus.failNext('confirm', new ConflictError('confirm exploded'));
  await buySeat(caerus, 'seat_A12').catch(() => undefined);

  const seat = await caerus.getResource('seat_A12');
  console.assert(seat.availableAmount === 1, 'the seat should be back on sale');
}

/**
 * Expiry.
 *
 * Time does not pass on its own here, on purpose: a mock that expired reservations on a
 * real clock would make your tests wait, and fail now and then depending on how busy the
 * machine was. You say when time passes, and the result is the same every run.
 */
export async function testExpiry(): Promise<void> {
  const caerus = aTestEngine();

  const reservation = await caerus.unitary('seat_A12').take({ ttlSeconds: 300 });

  caerus.advanceTime(301);

  const after = await caerus.getResourceHolder(reservation.id);
  console.assert(after.status === 'FAILED', 'it should have expired');

  const seat = await caerus.getResource('seat_A12');
  console.assert(seat.availableAmount === 1, 'and released its unit');
}

/** Forcing a failure the engine would only produce under conditions you cannot arrange. */
export async function testEngineMisbehaving(): Promise<void> {
  const caerus = aTestEngine();

  caerus.failNext('take', new ConflictError('Out of stock for resource: seat_A12'));

  await buySeat(caerus, 'seat_A12').then(
    () => console.assert(false, 'should have failed'),
    (error: unknown) => console.assert(error instanceof ConflictError),
  );
}
