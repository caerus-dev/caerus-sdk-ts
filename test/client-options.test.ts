import { describe, expect, it } from 'vitest';

import { CaerusClient } from '../src/client.js';
import { DEFAULT_TIMEOUT_MS, resolveOptions } from '../src/options.js';

describe('constructing a client', () => {
  /**
   * A missing endpoint or key is a wiring mistake. Failing here points at the line that
   * made it, instead of at the first call minutes later.
   */
  it.each([
    ['no options at all', undefined],
    ['an empty object', {}],
    ['no endpoint', { apiKey: 'no-es-una-clave' }],
    ['a blank endpoint', { endpoint: '   ', apiKey: 'no-es-una-clave' }],
    ['no apiKey', { endpoint: 'localhost:9090' }],
    ['a blank apiKey', { endpoint: 'localhost:9090', apiKey: '  ' }],
  ])('refuses %s', (_case, options) => {
    expect(() => new CaerusClient(options as never)).toThrow(TypeError);
  });

  it.each([0, -1, Number.NaN])('refuses a timeout of %s', (timeoutMs) => {
    expect(
      () => new CaerusClient({ endpoint: 'localhost:9090', apiKey: 'no-es-una-clave', timeoutMs }),
    ).toThrow(TypeError);
  });

  it('says what is missing', () => {
    expect(() => new CaerusClient({ apiKey: 'no-es-una-clave' } as never)).toThrow(/endpoint/);
    expect(() => new CaerusClient({ endpoint: 'localhost:9090' } as never)).toThrow(/apiKey/);
  });

  it('keeps the endpoint readable and the key private', () => {
    const client = new CaerusClient({ endpoint: 'localhost:9090', apiKey: 'no-es-una-clave' });

    expect(client.endpoint).toBe('localhost:9090');
    expect(JSON.stringify(client)).not.toContain('no-es-una-clave');

    client.close();
  });
});

describe('the defaults', () => {
  /**
   * The API Key travels on every call, so plaintext would put a credential on the wire.
   * Getting this wrong in the insecure direction fails silently; in the secure direction
   * it fails at connection time, loudly.
   */
  it('encrypts the connection unless told otherwise', () => {
    expect(resolveOptions({ endpoint: 'localhost:9090', apiKey: 'k' }).tls).toBe(true);
    expect(resolveOptions({ endpoint: 'localhost:9090', apiKey: 'k', tls: false }).tls).toBe(false);
  });

  it('puts a deadline on calls even when none is asked for', () => {
    expect(resolveOptions({ endpoint: 'localhost:9090', apiKey: 'k' }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
  });

  /** No default endpoint, ever: a wrong one published in a package is undiagnosable. */
  it('never invents an endpoint', () => {
    expect(() => resolveOptions({ apiKey: 'k' } as never)).toThrow(TypeError);
  });
});
