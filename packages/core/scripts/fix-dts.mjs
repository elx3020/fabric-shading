// tsc rewrites relative `.ts` imports to `.js` in emitted JavaScript but not in declaration
// files; do the same for the .d.ts files so consumers on any module resolution can load them.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith('.d.ts')) {
      const text = readFileSync(path, 'utf8');
      const fixed = text.replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2').replace(/(import\(['"]\.{1,2}\/[^'"]+)\.ts(['"]\))/g, '$1.js$2');
      if (fixed !== text) writeFileSync(path, fixed);
    }
  }
}
walk(new URL('../dist', import.meta.url).pathname);
