import {
  Server,
  ServerCredentials,
  type Metadata,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';

import {
  ResourceResponse,
  SharedResourceEngineService,
  type GetResourceRequest,
} from '../../src/generated/sre_service.js';

/** A complete message: protobuf refuses to serialise one with missing numeric fields. */
export function aResourceResponse(key = 'seat_A12'): ResourceResponse {
  return ResourceResponse.fromPartial({ key, resourceId: 'res-1', templateId: 'tpl-1' });
}

/**
 * A real gRPC server, in process, standing in for the engine.
 *
 * Mocking the generated client would prove that the SDK calls a mock. This proves that
 * what leaves the SDK arrives on the wire — the metadata in particular, which is the one
 * thing a mock cannot vouch for.
 */
export interface FakeEngine {
  /** host:port to point a client at. */
  endpoint: string;
  /** Metadata of the most recent call the server received. */
  lastMetadata: Metadata | undefined;
  /** How the next getResource call should answer. */
  respondWith: (handler: GetResourceHandler) => void;
  stop: () => Promise<void>;
}

export type GetResourceHandler = (
  call: ServerUnaryCall<GetResourceRequest, ResourceResponse>,
  callback: sendUnaryData<ResourceResponse>,
) => void;

export async function startFakeEngine(): Promise<FakeEngine> {
  const server = new Server();

  const state: {
    lastMetadata: Metadata | undefined;
    handler: GetResourceHandler;
  } = {
    lastMetadata: undefined,
    handler: (_call, callback) => callback(null, aResourceResponse()),
  };

  server.addService(SharedResourceEngineService, {
    getResource: (
      call: ServerUnaryCall<GetResourceRequest, ResourceResponse>,
      callback: sendUnaryData<ResourceResponse>,
    ) => {
      state.lastMetadata = call.metadata;
      state.handler(call, callback);
    },
  });

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
    respondWith(handler: GetResourceHandler) {
      state.handler = handler;
    },
    stop() {
      return new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}
