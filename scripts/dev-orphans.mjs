// Dev-only: list (or delete with --rm) source files unreachable from the app entry points.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? 'apps/web');
const rm = process.argv.includes('--rm');
const roots = (process.argv.find((a) => a.startsWith('--roots=')) ?? '--roots=app').slice(8).split(',');
const SRC = /\.(ts|tsx|mts|cts|js|mjs|jsx)$/;
const all = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist', '.turbo'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else all.push(p);
  }
})(root);
const exists = new Set(all);
function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  const cands = [base, ...['.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.json'].map((x) => base + x), ...['.ts', '.tsx', '.js'].map((x) => path.join(base, 'index' + x)), base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')];
  return cands.find((c) => exists.has(c)) ?? null;
}
const re = /(?:from\s*|import\s*\(\s*|import\s+|require\(\s*|url\(\s*)['"]([^'"]+)['"]/g;
const seen = new Set();
const stack = all.filter((f) => roots.some((r) => path.relative(root, f).startsWith(r + path.sep)) && SRC.test(f) && !/\.test\./.test(f));
for (const f of stack) seen.add(f);
while (stack.length) {
  const f = stack.pop();
  if (!/\.(ts|tsx|js|mjs|jsx|css)$/.test(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const r = resolve(f, m[1]);
    if (r && !seen.has(r)) { seen.add(r); stack.push(r); }
  }
}
const srcDir = path.join(root, 'src');
const orphans = all.filter((f) => f.startsWith(srcDir + path.sep) && /\.(ts|tsx|css)$/.test(f) && !/\.d\.ts$/.test(f) && !seen.has(f));
let bytes = 0;
for (const f of orphans) bytes += fs.statSync(f).size;
console.log(`orphans=${orphans.length} bytes=${bytes}`);
fs.writeFileSync('/tmp/orphans.txt', orphans.map((f) => path.relative(root, f)).join('\n') + '\n');
if (rm) for (const f of orphans) fs.rmSync(f);
