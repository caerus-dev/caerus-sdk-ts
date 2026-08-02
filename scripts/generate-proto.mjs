// Generates the gRPC client from the .proto that lives in data-plane-service.
//
// The contract is NOT copied into this package: it is read from its one home, so a
// change to the service and the SDK that wraps it always land in the same commit.
//
// The output is not committed either. It is regenerated before every build, which is
// what keeps it from drifting away from the contract.
//
// ts-proto does the generating; buf only supplies the compiler. See buf.gen.yaml.

import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const protoDir = resolve(packageRoot, '..', 'data-plane-service', 'src', 'main', 'proto');
const protoFile = join(protoDir, 'sre_service.proto');
const outDir = join(packageRoot, 'src', 'generated');

const binDir = join(packageRoot, 'node_modules', '.bin');

// The package entry point rather than the .bin shim: on Windows the shim is a .cmd,
// which Node refuses to spawn without a shell, and a shell would split the repository
// path on its space. This file is plain Node, so it runs the same everywhere.
const buf = join(packageRoot, 'node_modules', '@bufbuild', 'buf', 'bin', 'buf');

function fail(message) {
  console.error(`\n  proto generation failed: ${message}\n`);
  process.exit(1);
}

if (!existsSync(protoFile)) {
  fail(`the contract is not where it should be: ${protoFile}`);
}
if (!existsSync(buf)) {
  fail('dependencies are missing. Run npm install first.');
}

rmSync(outDir, { recursive: true, force: true });

try {
  execFileSync(process.execPath, [buf, 'generate', protoDir], {
    cwd: packageRoot,
    stdio: 'inherit',
    // buf resolves the ts-proto plugin by name, so its shim has to be findable.
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
  });
} catch (error) {
  fail(error.message);
}

if (!existsSync(join(outDir, 'sre_service.ts'))) {
  fail('buf reported success but produced no client');
}

console.log(`generated the gRPC client into src/generated from ${protoFile}`);
