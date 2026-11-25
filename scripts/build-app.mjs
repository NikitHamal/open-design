// Builds the lean desktop payload consumed by the Tauri shell (src-tauri).
//
//   .stage/app/                      -> bundled as <install>/app
//     package.json                   version + app identity
//     apps/daemon/dist/cli.mjs       single-file daemon (esbuild)
//     apps/web/out/                  static web export served by the daemon
//     skills, design-systems, ...    read-only resources
//     node_modules/                  only the native / external packages
//   .stage/node/node.exe             Node runtime used to run the daemon
//
// Usage: node scripts/build-app.mjs [--skip-web] [--skip-modules]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.stage');
const app = join(stage, 'app');
const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';
const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: isWin, cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status})`);
}

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = process.env.VER || rootPkg.version;

// Packages that cannot be inlined into the daemon bundle.
const EXTERNALS = {
  'better-sqlite3': '12.10.0',
  'node-pty': '1.1.0',
  'blake3-wasm': '2.1.5',
  hyperframes: '0.8.1',
};

rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// 1. Static web export
if (!args.has('--skip-web')) {
  run(pnpm, ['--filter', '@open-design/web', 'exec', 'next', 'build'], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--max-old-space-size=3072' },
  });
}
const webOut = join(root, 'apps', 'web', 'out');
if (!existsSync(join(webOut, 'index.html'))) throw new Error('web export missing: apps/web/out/index.html');
cpSync(webOut, join(app, 'apps', 'web', 'out'), { recursive: true });

// 2. Daemon bundle
await build({
  entryPoints: [join(root, 'apps', 'daemon', 'src', 'cli.ts')],
  outfile: join(app, 'apps', 'daemon', 'dist', 'cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: Object.keys(EXTERNALS),
  alias: { '@ffmpeg-installer/ffmpeg': join(root, 'apps', 'daemon', 'src', 'media', 'ffmpeg-lazy.ts') },
  banner: { js: "import{createRequire as __odCreateRequire}from'node:module';const require=__odCreateRequire(import.meta.url);" },
  legalComments: 'none',
  minifySyntax: true,
  minifyWhitespace: true,
  logLevel: 'warning',
});

// 3. Read-only resources
const RESOURCE_DIRS = ['skills', 'design-systems', 'design-templates', 'plugins', 'assets', 'craft', 'data', 'templates', 'prompt-templates'];
for (const dir of RESOURCE_DIRS) {
  if (existsSync(join(root, dir))) cpSync(join(root, dir), join(app, dir), { recursive: true, dereference: true });
}
pruneResources(app);
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'opendesigns', version, private: true, type: 'module' }, null, 2));

// 4. External modules (native + hyperframes) installed flat for the host platform
if (!args.has('--skip-modules')) {
  const mods = join(stage, 'modules');
  mkdirSync(mods, { recursive: true });
  writeFileSync(
    join(mods, 'package.json'),
    JSON.stringify({
      name: 'od-externals',
      version: '0.0.0',
      private: true,
      dependencies: EXTERNALS,
      pnpm: {
        overrides: { 'onnxruntime-node': '-' },
        onlyBuiltDependencies: ['better-sqlite3', 'node-pty', 'esbuild', 'sharp'],
      },
    }),
  );
  writeFileSync(join(mods, '.npmrc'), 'node-linker=hoisted\nshamefully-hoist=true\nengine-strict=false\n');
  run(pnpm, ['install', '--prod', '--ignore-workspace', '--no-frozen-lockfile', '--ignore-scripts=false'], { cwd: mods });
  cpSync(join(mods, 'node_modules'), join(app, 'node_modules'), { recursive: true, dereference: true });
  pruneModules(join(app, 'node_modules'));
}

// 5. Node runtime
const nodeDir = join(stage, 'node');
mkdirSync(nodeDir, { recursive: true });
cpSync(process.execPath, join(nodeDir, isWin ? 'node.exe' : 'node'));

report();

function pruneResources(dir) {
  // Gallery previews, translated DESIGN-*.md copies, and verification output are not needed at runtime.
  const dropFile = /(^|[\\/])preview[^\\/]*\.(mp4|webm|gif)$|(^|[\\/])DESIGN-[a-z]{2}(-[a-z]{2})?\.md$/i;
  const dropDir = new Set(['verify-output', '__pycache__', 'node_modules']);
  (function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (dropDir.has(entry.name) || (entry.name === 'readme' && /docs$/.test(current))) rmSync(full, { recursive: true, force: true });
        else walk(full);
      } else if (dropFile.test(full) || /\.(pyc|map)$/i.test(entry.name)) {
        rmSync(full, { force: true });
      }
    }
  })(dir);
  rmSync(join(dir, 'apps', 'web', 'out', 'remixicon.ttf'), { force: true });
}

function pruneModules(dir) {
  // Conservative: docs/tests/maps/declarations plus known build-time and foreign-platform payloads.
  const junkDirs = new Set(['test', 'tests', '__tests__', 'docs', 'example', 'examples', '.github']);
  const junkFiles = /\.(d\.m?ts|d\.cts|md|markdown|map|gyp|gypi|lib|pdb|obj|exp|cc|cpp|hpp)$|^(LICENSE|LICENCE|CHANGELOG|HISTORY|README|NOTICE)(\.\w+)?$/i;
  const foreign = /(darwin|linux|android|freebsd|openbsd|musl|arm64|arm|ia32|riscv|s390x|ppc64|wasm32)/i;

  const dropPaths = [
    '@types',
    'better-sqlite3/deps',
    'better-sqlite3/src',
    'better-sqlite3/build/Release/obj',
    'better-sqlite3/build/Release/test_extension.node',
    'node-pty/src',
    'node-pty/deps',
    'node-pty/third_party',
    'node-pty/build',
    'node-pty/scripts',
    'prettier',
    '@google',
    'onnxruntime-node',
    'hyperframes/dist/docker',
    'hyperframes/dist/docs',
  ];
  for (const rel of dropPaths) rmSync(join(dir, rel), { recursive: true, force: true });

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const isPkgRoot = current === dir || (dirname(current) === dir && dirname(current) !== current && /^@/.test(current.split(/[\\/]/).pop()));
      if (entry.isDirectory()) {
        if (!isPkgRoot && junkDirs.has(entry.name)) rmSync(full, { recursive: true, force: true });
        else if (isWin && foreign.test(entry.name) && /(prebuilds|@img|@esbuild|@ffmpeg-installer|@rollup|@parcel|@next|@swc)/.test(full) && !/win32-x64/.test(entry.name)) rmSync(full, { recursive: true, force: true });
        else walk(full);
      } else if (junkFiles.test(entry.name)) {
        rmSync(full, { force: true });
      }
    }
  }
  walk(dir);
}

function dirSize(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((sum, n) => sum + dirSize(join(p, n)), 0);
}

function report() {
  const mb = (n) => (n / 1048576).toFixed(1).padStart(7);
  console.log('\n[build-app] payload sizes (MB)');
  for (const p of [app, nodeDir]) console.log(`${mb(dirSize(p))}  ${p.replace(root, '.')}`);
  for (const n of readdirSync(app)) console.log(`${mb(dirSize(join(app, n)))}    app/${n}`);
  const nm = join(app, 'node_modules');
  if (existsSync(nm)) {
    const rows = readdirSync(nm).map((n) => [n, dirSize(join(nm, n))]).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [n, s] of rows) console.log(`${mb(s)}      node_modules/${n}`);
  }
}
