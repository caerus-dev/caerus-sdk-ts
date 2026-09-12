import {
  Server,
  ServerCredentials,
  type Metadata,
  type ServerUnaryCall,
  type ServerWritableStream,
  type sendUnaryData,
} from '@grpc/grpc-js';

import {
  DistributedLockingEngineService,
} from '../../src/generated/dls/dls_service.js';

export type DlsMethod =
  | 'beginTransaction'
  | 'releaseTransactionLocks'
  | 'renewTransaction'
  | 'releaseLock'
  | 'getLockStatus'
  | 'getTransactionStatus';

export type DlsStreamMethod = 'acquireLock';

type AnyCall = ServerUnaryCall<any, any>;
type AnyCallback = sendUnaryData<any>;
export type DlsHandler = (call: AnyCall, callback: AnyCallback) => void;
export type DlsStreamHandler = (call: ServerWritableStream<any, any>) => void;

export interface FakeDlsEngine {
  endpoint: string;
  lastMetadata: Metadata | undefined;
  lastRequest: any;
  lastMethod: DlsMethod | DlsStreamMethod | undefined;
  on: (method: DlsMethod, handler: DlsHandler) => void;
  onStream: (method: DlsStreamMethod, handler: DlsStreamHandler) => void;
  reset: () => void;
  stop: () => Promise<void>;
}

const METHODS: DlsMethod[] = [
  'beginTransaction',
  'releaseTransactionLocks',
  'renewTransaction',
  'releaseLock',
  'getLockStatus',
  'getTransactionStatus',
];

export async function startFakeDlsEngine(): Promise<FakeDlsEngine> {
  const server = new Server();

  const state: {
    lastMetadata: Metadata | undefined;
    lastRequest: any;
    lastMethod: DlsMethod | DlsStreamMethod | undefined;
    handlers: Partial<Record<DlsMethod, DlsHandler>>;
    streamHandlers: Partial<Record<DlsStreamMethod, DlsStreamHandler>>;
  } = {
    lastMetadata: undefined,
    lastRequest: undefined,
    lastMethod: undefined,
    handlers: {},
    streamHandlers: {},
  };

  const implementation: any = {};
  for (const method of METHODS) {
    implementation[method] = (call: AnyCall, callback: AnyCallback) => {
      state.lastMetadata = call.metadata;
      state.lastRequest = call.request;
      state.lastMethod = method;

      const handler = state.handlers[method];
      if (handler) {
        handler(call, callback);
        return;
      }
      callback(null, defaultResponseFor(method));
    };
  }

  implementation.acquireLock = (call: ServerWritableStream<any, any>) => {
    state.lastMetadata = call.metadata;
    state.lastRequest = call.request;
    state.lastMethod = 'acquireLock';

    const handler = state.streamHandlers['acquireLock'];
    if (handler) {
      handler(call);
      return;
    }
    call.write({ lockId: 'lock-1', fencingToken: 1234, status: 1 });
    call.end();
  };

  server.addService(DistributedLockingEngineService, implementation);

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(boundPort);
    });
  });

  return {
    endpoint: `127.0.0.1:${port}`,
    get lastMetadata() {
      return state.lastMetadata;
    },
    get lastRequest() {
      return state.lastRequest;
    },
    get lastMethod() {
      return state.lastMethod;
    },
    on(method: DlsMethod, handler: DlsHandler) {
      state.handlers[method] = handler;
    },
    onStream(method: DlsStreamMethod, handler: DlsStreamHandler) {
      state.streamHandlers[method] = handler;
    },
    reset() {
      state.handlers = {};
      state.streamHandlers = {};
      state.lastMetadata = undefined;
      state.lastRequest = undefined;
      state.lastMethod = undefined;
    },
    stop() {
      return new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}

function defaultResponseFor(method: DlsMethod): unknown {
  switch (method) {
    case 'beginTransaction':
      return { transactionId: 'tx-1' };
    case 'releaseTransactionLocks':
    case 'releaseLock':
      return {};
    case 'renewTransaction':
      return { transactionId: 'tx-1', newExpiresAt: 1234567890 };
    case 'getLockStatus':
      return {
        isHeld: true,
        currentMode: 1, // EXCLUSIVE
        activeHolders: [{ lockId: 'l-1', expiresAt: 1000, fencingToken: 5 }],
        pendingQueueSize: 0,
      };
    case 'getTransactionStatus':
      return {
        status: 'ACTIVE',
        abortReason: '',
        locks: [],
        expiresAt: 1000,
      };
  }
}
