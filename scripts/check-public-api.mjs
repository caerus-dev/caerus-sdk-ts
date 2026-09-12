// Fails the build if anything generated from the .proto reached the published types.
//
// This is not paranoia. It already happened twice while the client was being written:
// first a `protected transport: Transport` field, then a `protected get connection()`.
// Neither is exported, but both are part of the published type, so the declaration
// bundler pulled the whole generated tree in behind them — every request message, the
// gRPC client interface, protobuf's wire helpers. The .d.ts went from 5 KB to 22 KB and
// nothing complained.
//
// Anything a user can reach is API. If protobuf's shapes get in, they are ours to
// support and ours to break.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN = [
  // ts-proto's fingerprints
  'MessageFns',
  'protobufPackage',
  'DeepPartial',
  // The generated gRPC client and service descriptor (SRE & DLS)
  'SharedResourceEngineClient',
  'SharedResourceEngineService',
  'DistributedLockingEngineClient',
  'DistributedLockingEngineService',
  // Wire-shaped request and response messages (SRE)
  'CreateResourceRequest',
  'TakeRequest',
  'ResourceHolderResponse',
  'ResourceResponse',
  // Wire-shaped request and response messages (DLS)
  'AcquireLockRequest',
  'AcquireLockResponse',
  'BeginTransactionRequest',
  'LockHolderInfo',
  // The protobuf runtime
  '@bufbuild/protobuf',
  'BinaryWriter',
  'BinaryReader',
];

const declarations = ['dist/index.d.ts', 'dist/index.d.mts'];
const failures = [];

for (const relative of declarations) {
  const file = join(packageRoot, relative);
  if (!existsSync(file)) {
    failures.push(`${relative} is missing: did the build run?`);
    continue;
  }

  const contents = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (contents.includes(needle)) {
      failures.push(`${relative} exposes "${needle}"`);
    }
  }
}

if (failures.length > 0) {
  console.error('\n  the public API leaks code generated from the .proto:\n');
  for (const failure of failures) {
    console.error(`    - ${failure}`);
  }
  console.error(
    '\n  Anything protected or exported is part of the published type. Keep the transport\n' +
      '  behind an ECMAScript private field (#) and translate at the boundary.\n',
  );
  process.exit(1);
}

console.log('public API is clean: nothing generated from the .proto reaches the .d.ts');
