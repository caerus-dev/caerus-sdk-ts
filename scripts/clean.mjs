import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of ['dist', join('src', 'generated')]) {
  rmSync(join(packageRoot, target), { recursive: true, force: true });
}
