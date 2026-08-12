/**
 * Where the SDK reports things it handled but that you should still know about.
 *
 * Only one level, and only used when something went wrong in a place where throwing
 * would do more harm than good — a release that failed while another error was already
 * on its way out, for instance.
 *
 * Any structured logger fits: pass `(message, ...rest) => log.warn({ rest }, message)`.
 */
export interface CaerusLogger {
  error: (message: string, ...details: unknown[]) => void;
}

/** How to reach Caerus. */
export interface CaerusClientOptions {
  /**
   * Host and port of the Caerus engine, for example `api.caerus.dev:443`.
   *
   * Optional. Defaults to `api.caerus.dev:443` (or `process.env.CAERUS_ENDPOINT` if set).
   */
  endpoint?: string;

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

  /**
   * Where to send the few messages the SDK emits. Defaults to `console.error`.
   *
   * A library that writes to the console with no way to redirect it is a nuisance in any
   * service with structured logging, and silence would be worse than either.
   */
  logger?: CaerusLogger;
}

export const DEFAULT_ENDPOINT = 'api.caerus.dev:443';
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Prefixed so a line from the SDK is recognisable in someone else's log. */
export const DEFAULT_LOGGER: CaerusLogger = {
  error: (message: string, ...details: unknown[]) => console.error(`[caerus] ${message}`, ...details),
};

/** Options with the defaults filled in. */
export interface ResolvedClientOptions {
  endpoint: string;
  apiKey: string;
  tls: boolean;
  timeoutMs: number;
  logger: CaerusLogger;
}

/**
 * Reads `CAERUS_TLS`, and only ever turns encryption *off* on an explicit `false` or `0`.
 *
 * The two mistakes are not symmetric. Leaving TLS on when you meant to disable it fails
 * loudly at connection time, with an OpenSSL error you cannot miss. Disabling it when you
 * meant to leave it on says nothing at all, and the API Key — which travels on every
 * call — goes out in the clear.
 *
 * So anything that is not clearly "off" is treated as "on": `TRUE`, `yes`, an empty
 * string, a typo. Someone who writes `CAERUS_TLS=TRUE` meaning to enable encryption gets
 * encryption.
 */
function readEnvTls(): boolean | undefined {
  const raw = typeof process !== 'undefined' ? process.env?.CAERUS_TLS : undefined;
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  return value === 'false' || value === '0' ? false : true;
}

/**
 * Fails at construction rather than on the first call. A missing key is a
 * wiring mistake, and it should surface where it was made.
 */
export function resolveOptions(options: CaerusClientOptions): ResolvedClientOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('CaerusClient requires an options object with an apiKey');
  }

  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) {
    throw new TypeError('CaerusClient requires an apiKey. Create one in the Caerus dashboard');
  }

  let endpoint = DEFAULT_ENDPOINT;
  if (options.endpoint !== undefined) {
    if (typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
      throw new TypeError('endpoint cannot be blank');
    }
    endpoint = options.endpoint.trim();
  } else {
    const envEndpoint = typeof process !== 'undefined' ? process.env?.CAERUS_ENDPOINT : undefined;
    if (envEndpoint && envEndpoint.trim() !== '') {
      endpoint = envEndpoint.trim();
    }
  }

  const envTls = readEnvTls();

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number of milliseconds');
  }

  const logger = options.logger ?? DEFAULT_LOGGER;
  if (typeof logger.error !== 'function') {
    throw new TypeError('logger must have an error(message, ...details) function');
  }

  return {
    endpoint,
    apiKey,
    tls: options.tls ?? envTls ?? true,
    timeoutMs,
    logger,
  };
}
