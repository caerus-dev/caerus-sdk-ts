import {
  credentials,
  Metadata,
  type CallOptions,
  type ClientUnaryCall,
  type ServiceError,
} from '@grpc/grpc-js';

import { toCaerusError } from '../errors.js';
import type { ResolvedClientOptions } from '../options.js';
import { SharedResourceEngineClient } from '../../generated/sre_service.js';

/**
 * The shape of every unary method on the generated client: request, metadata, options,
 * callback. Phase 3 hands one of these in along with an already-built request.
 */
export type UnaryMethod<Request, Response> = (
  request: Request,
  metadata: Metadata,
  options: Partial<CallOptions>,
  callback: (error: ServiceError | null, response: Response) => void,
) => ClientUnaryCall;

/**
 * Everything about talking to Caerus that is not about what the calls mean.
 *
 * This is where gRPC stops. Above it there are promises, plain objects and named errors;
 * below it there are channels, metadata and status codes. Keeping the boundary here is
 * what lets the public API stay free of anything generated from the .proto.
 */
export class Transport {
  // ECMAScript private fields, not TypeScript's `private`. The difference matters: the
  // API Key lives here, and `#` keeps it out of JSON.stringify, console.log and
  // Object.keys. TypeScript's `private` is a compile-time fiction that would put the
  // credential straight into any log line that dumps the client.
  readonly #client: SharedResourceEngineClient;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  #closed = false;

  constructor(options: ResolvedClientOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs;
    this.#client = new SharedResourceEngineClient(
      options.endpoint,
      options.tls ? credentials.createSsl() : credentials.createInsecure(),
    );
  }

  /** The generated client, for the business methods to pick a method off. */
  get raw(): SharedResourceEngineClient {
    return this.#client;
  }

  /**
   * The API Key on every call, which is also how the server knows which environment it
   * is working in — hence no environment parameter anywhere in this package.
   *
   * A fresh Metadata per call: gRPC may mutate what it is given, and sharing one
   * instance across concurrent calls invites leaking state between them.
   */
  buildMetadata(): Metadata {
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${this.#apiKey}`);
    return metadata;
  }

  callOptions(): Partial<CallOptions> {
    return { deadline: new Date(Date.now() + this.#timeoutMs) };
  }

  /**
   * Runs one unary call and resolves with its response.
   *
   * There is no retry here, and that is deliberate: on a network failure the SDK cannot
   * know whether the server processed the request, and resending a take or an extend
   * would reserve twice or extend twice with nothing to show for it. Only the read-only
   * methods retry, and they arrange it themselves.
   */
  unary<Request, Response>(
    method: UnaryMethod<Request, Response>,
    request: Request,
  ): Promise<Response> {
    if (this.#closed) {
      return Promise.reject(toCaerusError(new Error('This CaerusClient has been closed')));
    }

    return new Promise<Response>((resolve, reject) => {
      method.call(
        this.#client,
        request,
        this.buildMetadata(),
        this.callOptions(),
        (error: ServiceError | null, response: Response) => {
          if (error) {
            reject(toCaerusError(error));
            return;
          }
          resolve(response);
        },
      );
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
