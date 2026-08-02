import { ConflictError, ValidationError } from '../errors.js';
import type { CaerusLogger } from '../options.js';
import type { Reservation, ReservationWork } from '../types.js';

/**
 * The take/work/settle dance, in one place.
 *
 * Both the real client and the in-memory one run this. A mock whose error handling
 * differs from the real thing is worse than no mock: it teaches the wrong lesson and the
 * difference only shows up in production.
 */
export interface ReserveHooks {
  confirm: (reservationId: string) => Promise<unknown>;
  release: (reservationId: string) => Promise<unknown>;
  logger: CaerusLogger;
}

export async function runReserve<T>(
  reservation: Reservation,
  work: ReservationWork<T>,
  hooks: ReserveHooks,
): Promise<T> {
  if (typeof work !== 'function') {
    throw new ValidationError('reserve needs a function to run while the units are held');
  }

  // A queued reservation holds nothing yet. Running the work here would charge a card
  // for a seat the caller does not have. Anyone who wants to handle queueing can use
  // take directly and act on the status.
  if (reservation.status === 'QUEUED') {
    throw new ConflictError(
      `Reservation ${reservation.id} is queued and holds nothing yet, so the work was not run. ` +
        `Use take() if you want to handle queueing yourself.`,
    );
  }

  let result: T;
  try {
    result = await work(reservation);
  } catch (workError) {
    await releaseQuietly(reservation.id, workError, hooks);
    throw workError;
  }

  // Deliberately outside the try. If confirming fails there is nothing sensible to undo:
  // the work already happened, and if the confirm actually landed and only its response
  // was lost, the reservation is confirmed and no longer has a TTL — releasing would
  // destroy a valid confirmation. Doing nothing is right on both branches.
  await hooks.confirm(reservation.id);
  return result;
}

/**
 * Releases without ever throwing.
 *
 * If this fails while an error is already on its way out, the caller's error is the one
 * worth having: it says why the checkout failed. The release failing is an operational
 * detail, and the units lapse on their own when the TTL runs out.
 *
 * It still has to be visible somewhere, hence the log.
 */
async function releaseQuietly(
  reservationId: string,
  causeOfRelease: unknown,
  hooks: ReserveHooks,
): Promise<void> {
  try {
    await hooks.release(reservationId);
  } catch (releaseError) {
    hooks.logger.error(
      `Could not release reservation ${reservationId} after the reserved work failed. ` +
        `It will lapse when its TTL runs out.`,
      { releaseError, causeOfRelease },
    );
  }
}
