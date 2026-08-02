import { Transport } from './internal/transport.js';
import { resolveOptions, type CaerusClientOptions, type ResolvedClientOptions } from './options.js';

/**
 * The entry point to Caerus.
 *
 * ```typescript
 * const caerus = new CaerusClient({ endpoint: 'caerus.example.com:9090', apiKey });
 * ```
 *
 * One instance is meant to live as long as the process does: it holds a gRPC channel
 * that multiplexes every call over a single connection. Building one per request throws
 * that away and opens a connection each time.
 *
 * The business methods arrive in the next phase.
 */
export class CaerusClient {
  // `#` and not `protected`: a protected field is still part of the published type, so
  // the declaration bundle would inline Transport and, through it, every type generated
  // from the .proto. Private this way, none of it reaches the .d.ts.
  //
  // The API Key is not stored here either. It goes to the transport, which also keeps it
  // in a `#` field, so logging a client cannot spill the credential.
  readonly #transport: Transport;
  readonly #endpoint: string;
  readonly #timeoutMs: number;

  constructor(options: CaerusClientOptions) {
    const resolved: ResolvedClientOptions = resolveOptions(options);

    this.#endpoint = resolved.endpoint;
    this.#timeoutMs = resolved.timeoutMs;
    this.#transport = new Transport(resolved);
  }

  /** Where this client is pointed. Useful in logs; the API Key is deliberately absent. */
  get endpoint(): string {
    return this.#endpoint;
  }

  /** The per-call deadline in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Releases the connection. Calls made afterwards reject.
   *
   * Node keeps the process alive while the channel is open, so a short-lived script that
   * never closes will appear to hang after its work is done.
   */
  close(): void {
    this.#transport.close();
  }

  /**
   * The business methods arrive in the next phase and go on this class, reaching the
   * wire through `this.#transport` directly.
   *
   * There is deliberately no protected accessor for it. Anything protected is part of
   * the published type, and a member typed as Transport would pull the generated gRPC
   * client into the .d.ts — which is exactly the leak this package must not have.
   */
}
