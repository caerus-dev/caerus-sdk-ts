import { describe, expect, it } from 'vitest';

import { CaerusClient } from '../src/client.js';
import { DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS, resolveOptions } from '../src/options.js';

describe('constructing a client', () => {
  it.each([
    ['no options at all', undefined],
    ['an empty object', {}],
    ['no apiKey', {}],
    ['a blank apiKey', { apiKey: '  ' }],
  ])('refuses %s', (_case, options) => {
    expect(() => new CaerusClient(options as never)).toThrow(TypeError);
  });

  it('allows constructing with only an apiKey using default endpoint', () => {
    const client = new CaerusClient({ apiKey: 'no-es-una-clave' });

    expect(client.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(JSON.stringify(client)).not.toContain('no-es-una-clave');

    client.close();
  });

  it.each([0, -1, Number.NaN])('refuses a timeout of %s', (timeoutMs) => {
    expect(
      () => new CaerusClient({ apiKey: 'no-es-una-clave', timeoutMs }),
    ).toThrow(TypeError);
  });

  it('says what is missing when apiKey is absent', () => {
    expect(() => new CaerusClient({ endpoint: 'localhost:9090' } as never)).toThrow(/apiKey/);
  });
});

describe('the defaults', () => {
  it('encrypts the connection unless told otherwise', () => {
    expect(resolveOptions({ apiKey: 'k' }).tls).toBe(true);
    expect(resolveOptions({ apiKey: 'k', tls: false }).tls).toBe(false);
  });

  it('puts a deadline on calls even when none is asked for', () => {
    expect(resolveOptions({ apiKey: 'k' }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
  });

  it('uses default endpoint when none is provided', () => {
    expect(resolveOptions({ apiKey: 'k' }).endpoint).toBe(DEFAULT_ENDPOINT);
  });

  it('honors environment variable overrides for endpoint and tls', () => {
    process.env.CAERUS_ENDPOINT = 'localhost:9090';
    process.env.CAERUS_TLS = 'false';

    const resolved = resolveOptions({ apiKey: 'k' });
    expect(resolved.endpoint).toBe('localhost:9090');
    expect(resolved.tls).toBe(false);

    delete process.env.CAERUS_ENDPOINT;
    delete process.env.CAERUS_TLS;
  });
});
