// Syntax-checks every server and shared module (used by `npm run lint`).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [path.join(root, 'src'), path.join(root, 'test'), path.join(root, '..', 'shared')];
let count = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) { execFileSync(process.execPath, ['--check', p], { stdio: 'inherit' }); count += 1; }
  }
};
for (const d of dirs) if (fs.existsSync(d)) walk(d);
console.log(`Syntax OK: ${count} files`);
