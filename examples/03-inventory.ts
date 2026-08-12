/**
 * Declaring what there is to reserve, and reading how much is left.
 *
 * Templates — the rules: how long a hold lasts, whether metadata is kept, what happens
 * when stock runs out — are created in the Caerus dashboard. The concrete resources that
 * follow those rules are created here.
 */
import { CaerusClient } from '@caerus-dev/sdk';

const caerus = new CaerusClient({
  apiKey: process.env.CAERUS_API_KEY ?? '',
});

/** One row of a theatre, from a template called "seat". */
export async function openRowA(): Promise<void> {
  for (const number of [1, 2, 3, 4]) {
    // createUnitary takes no amount: a unitary resource always has exactly one.
    await caerus.createUnitary('seat', `seat_A${number}`, {
      // Lets you read the whole row back in one call.
      groupKey: 'row_A',
      metadata: { zone: 'stalls', row: 'A' },
    });
  }
}

/** A pool of interchangeable units rather than named seats. */
export async function openGeneralAdmission(): Promise<void> {
  await caerus.createMultiple('ga_pool', 'general_admission', 500);
}

export async function howManyLeft(): Promise<number> {
  const resource = await caerus.getResource('seat_A1');

  console.log(`${resource.availableAmount} free, ${resource.pendingCount} being paid for`);
  return resource.availableAmount;
}

/** Reading a whole group, one page at a time. */
export async function freeSeatsInRowA(): Promise<string[]> {
  const free: string[] = [];
  let page = 0;

  for (;;) {
    const result = await caerus.getResourcesByGroup('row_A', { page, pageSize: 50 });

    for (const resource of result.resources) {
      if (resource.availableAmount > 0) {
        free.push(resource.key);
      }
    }

    if (!result.hasNextPage) {
      return free;
    }
    page += 1;
  }
}
