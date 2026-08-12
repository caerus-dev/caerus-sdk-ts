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

  it('keeps the apiKey out of anything that gets serialised', () => {
    const client = new CaerusClient({ endpoint: 'localhost:9090', apiKey: 'no-es-una-clave' });

    expect(JSON.stringify(client)).not.toContain('no-es-una-clave');

    client.close();
  });

  it('needs nothing but an apiKey to reach the hosted Caerus', () => {
    const original = process.env.CAERUS_ENDPOINT;
    delete process.env.CAERUS_ENDPOINT;

    try {
      const client = new CaerusClient({ apiKey: 'no-es-una-clave' });
      expect(client.endpoint).toBe(DEFAULT_ENDPOINT);
      client.close();
    } finally {
      if (original !== undefined) {
        process.env.CAERUS_ENDPOINT = original;
      }
    }
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
  const base = { endpoint: 'localhost:9090', apiKey: 'k' };

  it('encrypts the connection unless told otherwise', () => {
    expect(resolveOptions(base).tls).toBe(true);
    expect(resolveOptions({ ...base, tls: false }).tls).toBe(false);
  });

  it('puts a deadline on calls even when none is asked for', () => {
    expect(resolveOptions(base).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  // Explicit beats the environment beats the built-in address. A value written in code
  // must never be overruled by a variable someone else set on the machine.
  it('prefers an explicit endpoint, then the environment, then the built-in one', () => {
    const original = process.env.CAERUS_ENDPOINT;

    try {
      process.env.CAERUS_ENDPOINT = 'del-entorno:9090';
      expect(resolveOptions({ apiKey: 'k', endpoint: 'explicito:9090' }).endpoint).toBe(
        'explicito:9090',
      );
      expect(resolveOptions({ apiKey: 'k' }).endpoint).toBe('del-entorno:9090');

      delete process.env.CAERUS_ENDPOINT;
      expect(resolveOptions({ apiKey: 'k' }).endpoint).toBe(DEFAULT_ENDPOINT);
    } finally {
      if (original === undefined) {
        delete process.env.CAERUS_ENDPOINT;
      } else {
        process.env.CAERUS_ENDPOINT = original;
      }
    }
  });

  it('refuses an explicit blank endpoint', () => {
    expect(() => new CaerusClient({ endpoint: '   ', apiKey: 'no-es-una-clave' })).toThrow(
      TypeError,
    );
  });

  it('honors environment variable overrides for endpoint and tls', () => {
    const origEndpoint = process.env.CAERUS_ENDPOINT;
    const origTls = process.env.CAERUS_TLS;

    try {
      process.env.CAERUS_ENDPOINT = 'localhost:9090';
      process.env.CAERUS_TLS = 'false';

      const resolved = resolveOptions({ apiKey: 'k' });
      expect(resolved.endpoint).toBe('localhost:9090');
      expect(resolved.tls).toBe(false);
    } finally {
      if (origEndpoint === undefined) {
        delete process.env.CAERUS_ENDPOINT;
      } else {
        process.env.CAERUS_ENDPOINT = origEndpoint;
      }

      if (origTls === undefined) {
        delete process.env.CAERUS_TLS;
      } else {
        process.env.CAERUS_TLS = origTls;
      }
    }
  });

  // The two mistakes are not symmetric: leaving TLS on by accident fails loudly at
  // connection time, while turning it off by accident puts the API Key on the wire and
  // says nothing. So only an unmistakable "off" is allowed to disable it.
  it('only lets an explicit false or 0 disable encryption', () => {
    const original = process.env.CAERUS_TLS;
    const withEnv = (value: string) => {
      process.env.CAERUS_TLS = value;
      return resolveOptions(base).tls;
    };

    try {
      for (const off of ['false', 'FALSE', ' false ', '0']) {
        expect(withEnv(off), `${off} should disable TLS`).toBe(false);
      }
      // Anything else, including someone trying to *enable* it in the wrong case.
      for (const on of ['true', 'TRUE', 'True', '1', 'yes', 'on', '', 'flase']) {
        expect(withEnv(on), `${on} must not disable TLS`).toBe(true);
      }
      // An explicit option still wins over the environment.
      process.env.CAERUS_TLS = 'false';
      expect(resolveOptions({ ...base, tls: true }).tls).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.CAERUS_TLS;
      } else {
        process.env.CAERUS_TLS = original;
      }
    }
  });
});
