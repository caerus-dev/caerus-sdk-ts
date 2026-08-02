/** How to reach Caerus. */
export interface CaerusClientOptions {
  /**
   * Host and port of the Caerus engine, for example `caerus.example.com:9090`.
   *
   * There is deliberately no default. A wrong address baked into a published package
   * would reach whoever installed it as a connection error with nothing to suggest it
   * was a placeholder.
   */
  endpoint: string;

  /**
   * The API Key from the Caerus dashboard.
   *
   * It identifies the environment too, which is why no method here takes one: the
   * environment is whatever the key belongs to.
   *
   * This is a server credential. Anything running in a browser would expose it.
   */
  apiKey: string;

  /**
   * Encrypt the connection. On by default.
   *
   * Turn it off only against a local engine. The API Key travels on every call, so
   * plaintext puts a credential on the wire — and a mistake in that direction fails
   * silently, while a mistake in the other fails loudly at connection time.
   */
  tls?: boolean;

  /**
   * How long any single call may take before it is abandoned, in milliseconds.
   * Defaults to 10 seconds.
   *
   * Every call gets one. Without a deadline a stalled connection leaves a promise that
   * never settles, which is far harder to diagnose than a timeout.
   */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Options with the defaults filled in. */
export interface ResolvedClientOptions {
  endpoint: string;
  apiKey: string;
  tls: boolean;
  timeoutMs: number;
}

/**
 * Fails at construction rather than on the first call. A missing endpoint or key is a
 * wiring mistake, and it should surface where it was made.
 */
export function resolveOptions(options: CaerusClientOptions): ResolvedClientOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('CaerusClient requires an options object with endpoint and apiKey');
  }

  const endpoint = typeof options.endpoint === 'string' ? options.endpoint.trim() : '';
  if (!endpoint) {
    throw new TypeError('CaerusClient requires an endpoint, for example "caerus.example.com:9090"');
  }

  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) {
    throw new TypeError('CaerusClient requires an apiKey. Create one in the Caerus dashboard');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number of milliseconds');
  }

  return {
    endpoint,
    apiKey,
    tls: options.tls ?? true,
    timeoutMs,
  };
}
