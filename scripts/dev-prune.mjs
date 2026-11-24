// Dev-only codemod used while pruning the codebase.
// Usage: node scripts/dev-prune.mjs <package-dir>
// Removes imports that no longer resolve (TS2307) and JSX usages of identifiers
// that no longer exist (TS2304). Everything else is written to /tmp/prune-manual.log.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const pkgDir = path.resolve(process.argv[2] ?? 'apps/web');
const require = createRequire(path.join(pkgDir, 'package.json'));
const ts = require('typescript');

import { execSync } from 'node:child_process';

function runTsc() {
  let out = '';
  try {
    execSync('npx tsc -p tsconfig.json --noEmit --pretty false', { cwd: pkgDir, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const diags = [];
  const cache = new Map();
  for (const line of out.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    if (!m) continue;
    const file = path.resolve(pkgDir, m[1]);
    if (!cache.has(file)) cache.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
    const sf = cache.get(file);
    const start = sf.getPositionOfLineAndCharacter(Number(m[2]) - 1, Number(m[3]) - 1);
    diags.push({ file: sf, start, code: Number(m[4]), messageText: m[5] });
  }
  return diags;
}

let rounds = 0;
for (;;) {
  const diags = runTsc();
  const edits = new Map();
  const manual = [];
  const add = (f, e) => {
    if (!edits.has(f)) edits.set(f, []);
    edits.get(f).push(e);
  };
  for (const d of diags) {
    const sf = d.file;
    const pos = d.start ?? 0;
    if (d.code === 2307) {
      let found = null;
      const visit = (n) => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.pos <= pos && pos < n.end) found = n;
        if (!found) ts.forEachChild(n, visit);
      };
      visit(sf);
      if (found) add(sf.fileName, { start: found.getFullStart(), end: found.end, text: '' });
      else manual.push(d);
    } else if (d.code === 2304 || d.code === 2552) {
      let node = null;
      const visit = (n) => {
        if (n.getStart(sf) <= pos && pos < n.end) {
          node = n;
          ts.forEachChild(n, visit);
        }
      };
      visit(sf);
      const p = node?.parent;
      if (node && ts.isIdentifier(node) && p && (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node) {
        const el = ts.isJsxSelfClosingElement(p) ? p : p.parent;
        const parent = el.parent;
        if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) add(sf.fileName, { start: el.getFullStart(), end: el.end, text: '' });
        else add(sf.fileName, { start: el.getStart(sf), end: el.end, text: 'null' });
      } else manual.push(d);
    } else manual.push(d);
  }
  let changed = 0;
  for (const [file, list] of edits) {
    let text = fs.readFileSync(file, 'utf8');
    list.sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const e of list) {
      if (e.end > lastStart) continue;
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
      lastStart = e.start;
      changed++;
    }
    fs.writeFileSync(file, text);
  }
  rounds++;
  if (!changed || rounds > 12) {
    const out = manual
      .filter((d) => ![7006, 7031].includes(d.code))
      .map((d) => {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
        return `${path.relative(pkgDir, d.file.fileName)}(${line + 1},${character + 1}) TS${d.code}: ${String(d.messageText).slice(0, 160)}`;
      });
    fs.writeFileSync('/tmp/prune-manual.log', out.join('\n') + '\n');
    console.log(`rounds=${rounds} remaining(manual)=${out.length}`);
    break;
  }
}
