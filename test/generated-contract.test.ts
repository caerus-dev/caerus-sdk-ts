import { describe, expect, it } from 'vitest';

import { ExtendRequest, SharedResourceEngineService } from '../src/generated/sre_service.js';

/**
 * Guards the seam between the contract and this package. The generated code is not
 * committed, so nothing else would notice if a change to the .proto quietly removed a
 * method or renamed a field — the next build would just produce a different client.
 *
 * Importing from src/generated is fine here: tests are internal. Doing it from src/index
 * would be the leak the story forbids.
 */
describe('the client generated from sre_service.proto', () => {
  it('exposes every RPC the service declares', () => {
    expect(Object.keys(SharedResourceEngineService).sort()).toEqual([
      'confirm',
      'createResource',
      'deleteResource',
      'extend',
      'getResource',
      'getResourceHolder',
      'getResourceHoldersList',
      'getResourcesByGroupKey',
      'release',
      'take',
      'updateResource',
    ]);
  });

  it('points at the right package and path', () => {
    expect(SharedResourceEngineService.take.path).toBe('/caerus.sre.v1.SharedResourceEngine/Take');
  });

  /**
   * Milliseconds, unlike `custom_ttl_seconds`. The engine rounds up to whole seconds, so
   * anything under 1000 extends by exactly one — a quirk the SDK documents rather than
   * papers over, since the contract is the team's to change.
   */
  it('takes the extension in milliseconds', () => {
    const request = ExtendRequest.fromPartial({ extraMs: 60_000 });

    expect(request).toHaveProperty('extraMs', 60_000);
    expect(request).not.toHaveProperty('extraSeconds');
  });
});
