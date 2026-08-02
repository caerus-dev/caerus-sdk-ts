/**
 * What can go wrong, and how to tell the cases apart.
 *
 * Every error this SDK throws extends `CaerusError`, so one catch takes them all, and
 * each carries the message the engine sent.
 */
import {
  AuthenticationError,
  CaerusClient,
  CaerusError,
  ConflictError,
  OutOfStockError,
  ResourceNotFoundError,
  TimeoutError,
  ValidationError,
} from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  endpoint: 'REPLACE_ME.caerus.example:9090',
  apiKey: process.env.CAERUS_API_KEY ?? '',
});

declare function chargeCard(amount: number): Promise<{ paymentId: string }>;

export async function buyWithGoodErrors(): Promise<string> {
  try {
    return await caerus.reserve('seat_A12', async () => {
      const { paymentId } = await chargeCard(4500);
      return paymentId;
    });
  } catch (error) {
    if (error instanceof ResourceNotFoundError) {
      // No resource with that key. Usually a typo or something never created.
      throw new Error('That seat does not exist');
    }

    // Before ConflictError, which it extends. The other way round this branch would
    // never run.
    if (error instanceof OutOfStockError) {
      throw new Error('That seat is sold out');
    }

    if (error instanceof ConflictError) {
      // Some other invalid state: a reservation already confirmed, one that expired.
      throw new Error('That seat is no longer available');
    }

    if (error instanceof ValidationError) {
      throw new Error('Caerus rejected the request');
    }

    if (error instanceof AuthenticationError) {
      // Missing, unknown or revoked API Key.
      throw new Error('Caerus credentials are wrong');
    }

    if (error instanceof TimeoutError) {
      // The call ran past its deadline. Whether the engine did the work is unknown, so
      // do not simply retry a take: use an idempotency key if you need to.
      throw new Error('Caerus did not answer in time');
    }

    if (error instanceof CaerusError) {
      throw new Error(`Caerus failed: ${error.message}`);
    }

    // Not a Caerus error at all — this is chargeCard's. reserve released the seat and
    // handed the original error back untouched.
    throw error;
  }
}

/** Switching on the code instead of the class, when that reads better. */
export async function describeFailure(): Promise<string> {
  try {
    await caerus.take('seat_A12');
    return 'held';
  } catch (error) {
    if (!(error instanceof CaerusError)) {
      throw error;
    }

    switch (error.code) {
      case 'RESOURCE_NOT_FOUND':
        return 'no such seat';
      // OUT_OF_STOCK is its own code, so switching on `code` needs both branches even
      // though OutOfStockError extends ConflictError.
      case 'OUT_OF_STOCK':
        return 'sold out';
      case 'CONFLICT':
        return 'unavailable';
      case 'TIMEOUT':
        return 'no answer in time';
      default:
        return `unexpected: ${error.message}`;
    }
  }
}

/**
 * Retrying a take safely.
 *
 * The SDK never retries anything that changes state, because after a network failure it
 * cannot know whether the engine processed the request — and retrying could hold the
 * seat twice. With an idempotency key the engine gives back the first reservation
 * instead of taking more, which makes the retry yours to make and safe to make.
 */
export async function takeWithRetry(orderId: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const reservation = await caerus.take('seat_A12', { idempotencyKey: orderId });
      return reservation.id;
    } catch (error) {
      if (!(error instanceof TimeoutError) || attempt === 3) {
        throw error;
      }
    }
  }

  throw new Error('unreachable');
}
