import {
  credentials,
  Metadata,
  type CallOptions,
  type ClientUnaryCall,
  type ServiceError,
  type ClientReadableStream,
} from '@grpc/grpc-js';

import { toDlsError, DlsError } from '../dls-errors';
import type { ResolvedDlsClientOptions } from '../dls-options';
import { DistributedLockingEngineClient } from '../../generated/dls/dls_service';
import type { AcquireLockRequest, AcquireLockResponse } from '../../generated/dls/dls_service';

export type UnaryMethod<Request, Response> = (
  request: Request,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: Response) => void,
) => ClientUnaryCall;

export class DlsTransport {
  readonly #client: DistributedLockingEngineClient;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #logger: any;
  #closed = false;

  constructor(options: ResolvedDlsClientOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#logger = options.logger;
    this.#client = new DistributedLockingEngineClient(
      options.endpoint,
      options.tls ? credentials.createSsl() : credentials.createInsecure(),
    );
  }

  get raw(): DistributedLockingEngineClient {
    return this.#client;
  }

  buildMetadata(): Metadata {
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${this.#apiKey}`);
    return metadata;
  }

  callOptions(): Partial<CallOptions> {
    return { deadline: new Date(Date.now() + this.#timeoutMs) };
  }

  unary<Request, Response>(
    method: UnaryMethod<Request, Response>,
    request: Request,
  ): Promise<Response> {
    if (this.#closed) {
      return Promise.reject(toDlsError(new Error('This DlsClient has been closed')));
    }

    return new Promise<Response>((resolve, reject) => {
      method.call(
        this.#client,
        request,
        this.buildMetadata(),
        this.callOptions(),
        (error: ServiceError | null, response: Response) => {
          if (error) {
            reject(toDlsError(error));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  acquireLockStream(
    request: AcquireLockRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<AcquireLockResponse> {
    if (this.#closed) {
      return Promise.reject(toDlsError(new Error('This DlsClient has been closed')));
    }

    if (options?.signal?.aborted) {
      return Promise.reject(toDlsError(new Error('AcquireLock aborted by user')));
    }

    return new Promise<AcquireLockResponse>((resolve, reject) => {
      const callOpts = options?.timeoutMs
        ? { deadline: new Date(Date.now() + options.timeoutMs) }
        : this.callOptions();

      const stream: ClientReadableStream<AcquireLockResponse> = this.#client.acquireLock(
        request,
        this.buildMetadata(),
        callOpts,
      );

      let terminalResponseReceived = false;

      const cleanupSignal = () => {
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      };

      const onAbort = () => {
        if (!terminalResponseReceived) {
          terminalResponseReceived = true;
          stream.cancel();
          cleanupSignal();
          reject(toDlsError(new Error('AcquireLock aborted by user')));
        }
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort);
      }

      stream.on('data', (response: AcquireLockResponse) => {
        if (response.status === 1 /* ACQUIRED */ || response.status === 2 /* DENIED */) {
          terminalResponseReceived = true;
          cleanupSignal();
          resolve(response);
          // Fundamental para evitar fugas de memoria y sockets colgados:
          stream.cancel();
        } else if (response.status === 3 /* QUEUED */) {
          // QUEUED, keep waiting
        } else {
          // UNSPECIFIED
          this.#logger.error('Received unspecified lock status in stream');
        }
      });

      stream.on('error', (error: ServiceError) => {
        if (!terminalResponseReceived) {
          cleanupSignal();
          reject(toDlsError(error));
        }
      });

      stream.on('end', () => {
        if (!terminalResponseReceived) {
          cleanupSignal();
          reject(toDlsError(new Error('Stream ended without terminal status')));
        }
      });
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#client.close();
  }
}
