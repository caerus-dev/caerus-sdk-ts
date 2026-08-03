import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Above vitest's 5 second default because a good part of this suite talks to a real
     * gRPC server over a loopback socket rather than to a mock.
     *
     * Those tests finish in milliseconds when the machine is idle, but the first run
     * after the client is regenerated has to transform ~1900 lines of generated code in
     * every worker at once, and on a busy machine — a local Caerus stack running
     * alongside, say — establishing the connection has been seen to cross five seconds.
     * That produced whole runs of timeouts that passed again on a retry, which is the
     * worst kind of test failure: it teaches people to re-run instead of to look.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
