// Writes src/version.ts from package.json.
//
// The version has one home, the manifest. Keeping a second copy by hand is the kind of
// thing that stays right until the day someone bumps one and not the other, and nothing
// fails — the package just reports a version it is not.
//
// Reading the manifest at runtime instead would be worse: it breaks bundlers and forces
// the published package to ship package.json at a path the code can find.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(packageRoot, 'package.json');
const outFile = join(packageRoot, 'src', 'version.ts');

const { version } = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (!version) {
  console.error('\n  version generation failed: package.json has no version\n');
  process.exit(1);
}

const contents = `// Generated from package.json by scripts/generate-version.mjs. Do not edit.
export const VERSION = ${JSON.stringify(version)};
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, contents, 'utf8');

console.log(`generated src/version.ts as ${version}`);
