import {
  Server,
  ServerCredentials,
  type Metadata,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';

import {
  ResourceHolderResponse,
  ResourceResponse,
  SharedResourceEngineService,
} from '../../src/generated/sre_service.js';

/**
 * A real gRPC server, in process, standing in for the engine.
 *
 * Mocking the generated client would prove that the SDK calls a mock. This proves that
 * what leaves the SDK arrives on the wire — the metadata and the encoding in particular,
 * which is what a mock cannot vouch for.
 */

export type EngineMethod =
  | 'createResource'
  | 'updateResource'
  | 'deleteResource'
  | 'take'
  | 'confirm'
  | 'release'
  | 'extend'
  | 'getResource'
  | 'getResourcesByGroupKey'
  | 'getResourceHolder';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyCall = ServerUnaryCall<any, any>;
type AnyCallback = sendUnaryData<any>;
export type EngineHandler = (call: AnyCall, callback: AnyCallback) => void;

export interface FakeEngine {
  /** host:port to point a client at. */
  endpoint: string;
  /** Metadata of the most recent call the server received. */
  lastMetadata: Metadata | undefined;
  /** The most recent request, exactly as it arrived over the wire. */
  lastRequest: any;
  /** Which method the most recent call hit. */
  lastMethod: EngineMethod | undefined;
  /** Sets how a method answers from now on. */
  on: (method: EngineMethod, handler: EngineHandler) => void;
  /**
   * Forgets every scripted answer and everything recorded.
   *
   * The server outlives the individual tests, so without this a handler set in one test
   * keeps answering in the next — which looks exactly like a bug in the code under test.
   */
  reset: () => void;
  stop: () => Promise<void>;
}

/** A complete message: protobuf refuses to serialise one with missing numeric fields. */
export function aResourceResponse(overrides: Partial<ResourceResponse> = {}): ResourceResponse {
  return ResourceResponse.fromPartial({
    resourceId: 'res-1',
    key: 'seat_A12',
    templateId: 'tpl-1',
    availableAmount: 1,
    pendingCount: 0,
    ...overrides,
  });
}

export function aHolderResponse(
  overrides: Partial<ResourceHolderResponse> = {},
): ResourceHolderResponse {
  return ResourceHolderResponse.fromPartial({
    holderId: 'hld-1',
    resourceId: 'res-1',
    status: 0, // PENDING
    amount: 1,
    expiresAt: 1_785_164_400,
    ...overrides,
  });
}

const METHODS: EngineMethod[] = [
  'createResource',
  'updateResource',
  'deleteResource',
  'take',
  'confirm',
  'release',
  'extend',
  'getResource',
  'getResourcesByGroupKey',
  'getResourceHolder',
];

export async function startFakeEngine(): Promise<FakeEngine> {
  const server = new Server();

  const state: {
    lastMetadata: Metadata | undefined;
    lastRequest: any;
    lastMethod: EngineMethod | undefined;
    handlers: Partial<Record<EngineMethod, EngineHandler>>;
  } = {
    lastMetadata: undefined,
    lastRequest: undefined,
    lastMethod: undefined,
    handlers: {},
  };

  const implementation: Record<string, EngineHandler> = {};
  for (const method of METHODS) {
    implementation[method] = (call, callback) => {
      state.lastMetadata = call.metadata;
      state.lastRequest = call.request;
      state.lastMethod = method;

      const handler = state.handlers[method];
      if (handler) {
        handler(call, callback);
        return;
      }
      // Anything not scripted answers with something well formed, so a test that only
      // cares about what was sent does not have to set up a response first.
      callback(null, defaultResponseFor(method));
    };
  }

  server.addService(SharedResourceEngineService, implementation);

  const port = await new Promise<number>((resolve, reject) => {
    // Port 0 lets the OS pick, so tests never collide with something already listening.
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
    on(method: EngineMethod, handler: EngineHandler) {
      state.handlers[method] = handler;
    },
    reset() {
      state.handlers = {};
      state.lastMetadata = undefined;
      state.lastRequest = undefined;
      state.lastMethod = undefined;
    },
    stop() {
      return new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}

function defaultResponseFor(method: EngineMethod): unknown {
  switch (method) {
    case 'createResource':
    case 'updateResource':
    case 'getResource':
      return aResourceResponse();
    case 'take':
    case 'confirm':
    case 'extend':
    case 'getResourceHolder':
      return aHolderResponse();
    case 'getResourcesByGroupKey':
      return { resources: [aResourceResponse()], nextPage: false };
    case 'release':
    case 'deleteResource':
      return {};
  }
}
