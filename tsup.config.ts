import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Plenty of consumers are still on CommonJS; breaking them buys nothing.
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  // grpc-js has native bindings, so it stays a real dependency rather than being inlined.
  external: ['@grpc/grpc-js'],
});
