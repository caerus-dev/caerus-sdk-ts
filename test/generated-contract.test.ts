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
   * The contract fix that had to land before this package existed: the field used to be
   * extra_ms, and the engine rounded it up to whole seconds anyway, so extend(300) added
   * one second instead of 300.
   */
  it('takes the extension in seconds', () => {
    const request = ExtendRequest.fromPartial({ extraSeconds: 300 });

    expect(request).toHaveProperty('extraSeconds', 300);
    expect(request).not.toHaveProperty('extraMs');
  });
});
