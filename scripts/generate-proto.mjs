// Generates the gRPC client from the .proto in proto/.
//
// That file is a copy. The contract itself lives in the caerus-back repository, in
// data-plane-service. It is copied rather than read from there because that repository
// is private and this one is public: anyone who clones this has to be able to build it.
// proto/README.md records which revision the copy came from and how to refresh it.
//
// The generated client is not committed. It is rebuilt before every build and every
// test run, so it cannot drift from the contract as vendored here.
//
// ts-proto does the generating; buf only supplies the compiler. See buf.gen.yaml.

import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const protoDir = resolve(packageRoot, 'proto');
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
