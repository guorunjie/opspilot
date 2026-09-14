import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Use the ASAR reader shipped with the pinned builder dependency tree.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const asar = builderRequire('@electron/asar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function regularFile(root, relative) {
  const absolute = path.resolve(root, relative);
  const canonicalRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(absolute);
  const inside = path.relative(canonicalRoot, resolved);
  assert.ok(inside && !path.isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + path.sep), 'File outside root');
  const stat = fs.lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Expected independent regular file');
  return absolute;
}

// Audits the unpacked application produced alongside the installer. This is
// not installer execution, signing validation, a secret scan or an attestation.
export function prepareRelease({ root, platform, arch, commit }) {
  root = fs.realpathSync(root);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.ok(platform === 'win32' || platform === 'darwin', 'Unsupported release platform');
  assert.ok(platform === 'win32' ? arch === 'x64' : ['x64', 'arm64'].includes(arch), 'Unsupported architecture');
  const pkg = json(regularFile(root, 'package.json'));
  const lock = json(regularFile(root, 'package-lock.json'));
  const config = json(regularFile(root, 'electron-builder.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  assert.equal(pkg.name, 'opspilot');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.main, 'desktop/demo.cjs');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.packages[''].license, pkg.license);
  assert.equal(config.productName, 'OpsPilot Open Core Demo');
  assert.equal(config.executableName, 'OpsPilot-Core-Demo');
  assert.equal(config.directories.output, 'dist/core');
  const expected = config.files;
  assert.ok(Array.isArray(expected) && expected.includes('LICENSE') && expected.includes('package.json'));
  assert.equal(new Set(expected).size, expected.length);
  for (const entry of expected) {
    assert.ok(typeof entry === 'string' && !entry.includes('\\') && !entry.split('/').includes('..') && !/[!*?\[\]{}:]/.test(entry));
    regularFile(root, entry);
  }
  const label = platform === 'win32' ? 'windows' : 'macos';
  const osName = platform === 'win32' ? 'win' : 'mac';
  const extension = platform === 'win32' ? 'exe' : 'dmg';
  const name = `OpsPilot-Core-Demo-${pkg.version}-${osName}-${arch}.${extension}`;
  const installer = regularFile(root, `dist/core/${name}`);
  assert.ok(fs.statSync(installer).size > 0, 'Empty installer');
  const unpacked = platform === 'win32' ? 'win-unpacked/resources/app.asar'
    : `${arch === 'arm64' ? 'mac-arm64' : 'mac'}/${config.executableName}.app/Contents/Resources/app.asar`;
  const archive = regularFile(root, `dist/core/${unpacked}`);
  asar.uncache(archive);
  const actual = [];
  for (const raw of asar.listPackage(archive)) {
    const entry = raw.slice(1);
    const stat = asar.statFile(archive, entry, false);
    assert.ok(!stat.link && !stat.unpacked, 'Linked/unpacked ASAR entry refused');
    if (!stat.files) actual.push(entry.split(path.sep).join('/'));
  }
  assert.deepEqual(actual.sort(), [...expected].sort(), 'Unexpected ASAR file set');
  const sourceHashes = {};
  for (const entry of expected) {
    const source = fs.readFileSync(regularFile(root, entry));
    const packed = asar.extractFile(archive, entry.split('/').join(path.sep));
    sourceHashes[entry] = hash(source);
    if (entry === 'package.json') {
      const metadata = JSON.parse(packed.toString('utf8'));
      for (const key of ['name', 'version', 'license', 'main']) assert.equal(metadata[key], pkg[key]);
      assert.equal(Object.keys(metadata.dependencies || {}).length, 0);
    } else assert.ok(source.equals(packed), `Packed bytes differ: ${entry}`);
  }
  const license = fs.readFileSync(regularFile(root, 'LICENSE'), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0, January 2004/);
  const bytes = fs.readFileSync(installer);
  const sha256 = hash(bytes);
  const parent = path.join(root, 'release-assets');
  if (fs.existsSync(parent)) assert.ok(fs.lstatSync(parent).isDirectory() && !fs.lstatSync(parent).isSymbolicLink());
  else fs.mkdirSync(parent);
  const destination = path.join(parent, label);
  // Fail on existing outputs instead of clobbering another candidate's evidence.
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, name), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(destination, `SHA256SUMS-${label}.txt`), `${sha256}  ${name}\n`, { flag: 'wx' });
  const provenance = { version: pkg.version, commit, platform, arch, installer: name, sha256,
    unpackedAsarSha256: hash(fs.readFileSync(archive)), sourceHashes,
    scope: 'Unpacked ASAR compared with checkout; installer hashed, not executed or extracted. Unsigned candidate; no installation, notarization or real-platform acceptance.' };
  fs.writeFileSync(path.join(destination, `provenance-${label}.json`), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
  return provenance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  if (process.env.GITHUB_SHA) assert.equal(process.env.GITHUB_SHA, commit);
  assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'Tracked checkout must be clean');
  console.log(JSON.stringify(prepareRelease({ root, platform: process.platform, arch: process.arch, commit }), null, 2));
}
