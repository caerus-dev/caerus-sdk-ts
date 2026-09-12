import { describe, expect, it } from 'vitest';

import { DlsClient } from '../src/dls/dls-client.js';
import { DEFAULT_DLS_ENDPOINT, DEFAULT_TIMEOUT_MS, resolveOptions } from '../src/dls/dls-options.js';

describe('DLS constructing a client', () => {
  it.each([
    ['no options at all', undefined],
    ['an empty object', {}],
    ['no apiKey', {}],
    ['a blank apiKey', { apiKey: '  ' }],
  ])('refuses %s', (_case, options) => {
    expect(() => new DlsClient(options as never)).toThrow(TypeError);
  });

  it('keeps the apiKey out of anything that gets serialised', () => {
    const client = new DlsClient({ endpoint: 'localhost:9090', apiKey: 'no-es-una-clave' });

    expect(JSON.stringify(client)).not.toContain('no-es-una-clave');

    client.close();
  });

  it('needs nothing but an apiKey to reach the hosted Caerus', () => {
    const original = process.env.CAERUS_DLS_ENDPOINT;
    delete process.env.CAERUS_DLS_ENDPOINT;

    try {
      const client = new DlsClient({ apiKey: 'no-es-una-clave' });
      // client.endpoint is not exposed directly like in CaerusClient but we can resolveOptions directly
      const resolved = resolveOptions({ apiKey: 'no-es-una-clave' });
      expect(resolved.endpoint).toBe(DEFAULT_DLS_ENDPOINT);
      client.close();
    } finally {
      if (original !== undefined) {
        process.env.CAERUS_DLS_ENDPOINT = original;
      }
    }
  });

  it.each([0, -1, Number.NaN])('refuses a timeout of %s', (timeoutMs) => {
    expect(
      () => new DlsClient({ apiKey: 'no-es-una-clave', timeoutMs }),
    ).toThrow(TypeError);
  });

  it('says what is missing when apiKey is absent', () => {
    expect(() => new DlsClient({ endpoint: 'localhost:9090' } as never)).toThrow(/apiKey/);
  });
});

describe('DLS the defaults', () => {
  const base = { endpoint: 'localhost:9090', apiKey: 'k' };

  it('encrypts the connection unless told otherwise', () => {
    expect(resolveOptions(base).tls).toBe(true);
    expect(resolveOptions({ ...base, tls: false }).tls).toBe(false);
  });

  it('puts a deadline on calls even when none is asked for', () => {
    expect(resolveOptions(base).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('prefers an explicit endpoint, then the environment, then the built-in one', () => {
    const original = process.env.CAERUS_DLS_ENDPOINT;

    try {
      process.env.CAERUS_DLS_ENDPOINT = 'del-entorno:9090';
      expect(resolveOptions({ apiKey: 'k', endpoint: 'explicito:9090' }).endpoint).toBe(
        'explicito:9090',
      );
      expect(resolveOptions({ apiKey: 'k' }).endpoint).toBe('del-entorno:9090');

      delete process.env.CAERUS_DLS_ENDPOINT;
      expect(resolveOptions({ apiKey: 'k' }).endpoint).toBe(DEFAULT_DLS_ENDPOINT);
    } finally {
      if (original === undefined) {
        delete process.env.CAERUS_DLS_ENDPOINT;
      } else {
        process.env.CAERUS_DLS_ENDPOINT = original;
      }
    }
  });

  it('refuses an explicit blank endpoint', () => {
    expect(() => new DlsClient({ endpoint: '   ', apiKey: 'no-es-una-clave' })).toThrow(
      TypeError,
    );
  });

  it('honors environment variable overrides for endpoint and tls', () => {
    const origEndpoint = process.env.CAERUS_DLS_ENDPOINT;
    const origTls = process.env.CAERUS_DLS_TLS;

    try {
      process.env.CAERUS_DLS_ENDPOINT = 'localhost:9090';
      process.env.CAERUS_DLS_TLS = 'false';

      const resolved = resolveOptions({ apiKey: 'k' });
      expect(resolved.endpoint).toBe('localhost:9090');
      expect(resolved.tls).toBe(false);
    } finally {
      if (origEndpoint === undefined) {
        delete process.env.CAERUS_DLS_ENDPOINT;
      } else {
        process.env.CAERUS_DLS_ENDPOINT = origEndpoint;
      }

      if (origTls === undefined) {
        delete process.env.CAERUS_DLS_TLS;
      } else {
        process.env.CAERUS_DLS_TLS = origTls;
      }
    }
  });

  it('only lets an explicit false or 0 disable encryption', () => {
    const original = process.env.CAERUS_DLS_TLS;
    const withEnv = (value: string) => {
      process.env.CAERUS_DLS_TLS = value;
      return resolveOptions(base).tls;
    };

    try {
      for (const off of ['false', 'FALSE', ' false ', '0']) {
        expect(withEnv(off), `${off} should disable TLS`).toBe(false);
      }
      for (const on of ['true', 'TRUE', 'True', '1', 'yes', 'on', '', 'flase']) {
        expect(withEnv(on), `${on} must not disable TLS`).toBe(true);
      }
      process.env.CAERUS_DLS_TLS = 'false';
      expect(resolveOptions({ ...base, tls: true }).tls).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.CAERUS_DLS_TLS;
      } else {
        process.env.CAERUS_DLS_TLS = original;
      }
    }
  });
});
