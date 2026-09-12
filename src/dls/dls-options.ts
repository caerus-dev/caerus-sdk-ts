export interface DlsLogger {
  error: (message: string, ...details: unknown[]) => void;
}

export interface DlsClientOptions {
  endpoint?: string;
  apiKey: string;
  tls?: boolean;
  timeoutMs?: number;
  logger?: DlsLogger;
}

export const DEFAULT_DLS_ENDPOINT = 'caerus.dev.ar.sdk.apps.disilab.ar:443';
export const DEFAULT_TIMEOUT_MS = 10_000;

export const DEFAULT_LOGGER: DlsLogger = {
  error: (message: string, ...details: unknown[]) => console.error(`[caerus-dls] ${message}`, ...details),
};

export interface ResolvedDlsClientOptions {
  endpoint: string;
  apiKey: string;
  tls: boolean;
  timeoutMs: number;
  logger: DlsLogger;
}

function readEnvTls(): boolean | undefined {
  const raw = typeof process !== 'undefined' ? process.env?.CAERUS_DLS_TLS : undefined;
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  return value === 'false' || value === '0' ? false : true;
}

export function resolveOptions(options: DlsClientOptions): ResolvedDlsClientOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('DlsClient requires an options object with an apiKey');
  }

  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) {
    throw new TypeError('DlsClient requires an apiKey');
  }

  let endpoint: string;
  if (options.endpoint !== undefined) {
    if (typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
      throw new TypeError('endpoint cannot be blank');
    }
    endpoint = options.endpoint.trim();
  } else {
    const fromEnv =
      typeof process !== 'undefined' ? process.env?.CAERUS_DLS_ENDPOINT?.trim() : undefined;
    endpoint = fromEnv || DEFAULT_DLS_ENDPOINT;
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
