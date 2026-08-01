// Generates the gRPC client from the .proto that lives in data-plane-service.
//
// The contract is NOT copied into this package: it is read from its one home, so a
// change to the service and the SDK that wraps it always land in the same commit.
//
// The output is not committed either. It is regenerated before every build, which is
// what keeps it from drifting away from the contract.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const protoDir = resolve(packageRoot, '..', 'data-plane-service', 'src', 'main', 'proto');
const protoFile = join(protoDir, 'sre_service.proto');
const outDir = join(packageRoot, 'src', 'generated');

const isWindows = process.platform === 'win32';

// The protoc binary that grpc-tools ships, invoked directly rather than through its npm
// shim: the shim goes via a shell, and this repository lives under a path with a space
// in it, which the shell splits.
const protocDir = join(packageRoot, 'node_modules', 'grpc-tools', 'bin');
const protoc = join(protocDir, `protoc${isWindows ? '.exe' : ''}`);

// Where that same package keeps google/protobuf/empty.proto, which our contract imports.
const wellKnownTypesDir = protocDir;

// npm bin shims are .cmd on Windows; protoc has to be handed the runnable one.
const tsProtoPlugin = join(
  packageRoot,
  'node_modules',
  '.bin',
  `protoc-gen-ts_proto${isWindows ? '.cmd' : ''}`,
);

function fail(message) {
  console.error(`\n  proto generation failed: ${message}\n`);
  process.exit(1);
}

if (!existsSync(protoFile)) {
  fail(`the contract is not where it should be: ${protoFile}`);
}
if (!existsSync(protoc)) {
  fail('grpc-tools is not installed. Run npm install first.');
}
if (!existsSync(tsProtoPlugin)) {
  fail('ts-proto is not installed. Run npm install first.');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const options = [
  // Client stubs for @grpc/grpc-js, which is what the SDK talks to.
  'outputServices=grpc-js',
  'esModuleInterop=true',
  // No server-side scaffolding: this package is a client.
  'outputServerImpl=false',
  // Keeps the generated tree free of runtime helpers we do not use.
  'useOptionals=messages',
].join(',');

try {
  execFileSync(
    protoc,
    [
      `--plugin=protoc-gen-ts_proto=${tsProtoPlugin}`,
      `--ts_proto_out=${outDir}`,
      `--ts_proto_opt=${options}`,
      `--proto_path=${protoDir}`,
      protoFile,
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
} catch (error) {
  fail(error.message);
}

console.log(`generated the gRPC client into src/generated from ${protoFile}`);
