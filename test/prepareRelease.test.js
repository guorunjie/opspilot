// DS-011 draft, reviewed and corrected. Non-executable synthetic installer
// bytes exercise artifact handling only, never actual installation acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { prepareRelease } from '../scripts/prepare-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRequire = createRequire(import.meta.url);
const asar = createRequire(localRequire.resolve('app-builder-lib/package.json'))('@electron/asar');
const COMMIT = createHash('sha1').update('ds-011').digest('hex');
const SYNTHETIC_INSTALLER = Buffer.from('Synthetic installer placeholder; never executed\n');
const FILES = JSON.parse(fs.readFileSync(path.join(repoRoot, 'electron-builder.json'), 'utf8')).files;
const MANIFESTS = ['package.json', 'package-lock.json', 'electron-builder.json'];
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function copyPath(fromRoot, toRoot, relative) {
  const destination = path.join(toRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(fromRoot, relative), destination);
}
const outputDir = fx => path.join(fx.root, 'release-assets', fx.platform === 'win32' ? 'windows' : 'macos');

async function fixture(t, opts = {}) {
  const platform = opts.platform ?? 'win32';
  const arch = opts.arch ?? 'x64';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opspilot-release-test-'));
  t.after(() => { asar.uncacheAll(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const relative of new Set([...MANIFESTS, ...FILES])) copyPath(repoRoot, root, relative);
  const staging = path.join(root, 'staging');
  for (const relative of FILES) copyPath(root, staging, relative);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  opts.mutate?.(root, staging);
  const unpacked = platform === 'win32' ? 'win-unpacked/resources/app.asar'
    : `${arch === 'arm64' ? 'mac-arm64' : 'mac'}/OpsPilot-Core-Demo.app/Contents/Resources/app.asar`;
  const archive = path.join(root, 'dist/core', unpacked);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  // Pinned ASAR resolves with out.end(), not with the destination's finish.
  // Reading immediately can observe a partial archive on Windows CI.
  const archiveStream = await asar.createPackage(staging, archive);
  await finished(archiveStream);
  assert.equal(archiveStream.writableFinished, true);
  const name = `OpsPilot-Core-Demo-${version}-${platform === 'win32' ? 'win' : 'mac'}-${arch}.${platform === 'win32' ? 'exe' : 'dmg'}`;
  const installer = path.join(root, 'dist/core', name);
  fs.writeFileSync(installer, opts.installerBytes ?? SYNTHETIC_INSTALLER);
  opts.mutateAfter?.(root, staging);
  return { root, archive, installer, version, platform, arch };
}
const run = (fx, overrides = {}) => prepareRelease({ root: fx.root, platform: fx.platform, arch: fx.arch, commit: COMMIT, ...overrides });
const rejected = fx => { assert.throws(() => run(fx)); assert.equal(fs.existsSync(outputDir(fx)), false); };

test('Windows synthetic artifact produces exactly three assets and correct hashes', async t => {
  const fx = await fixture(t);
  const p = run(fx);
  assert.equal(p.version, fx.version);
  assert.equal(p.commit, COMMIT);
  assert.equal(p.platform, 'win32');
  assert.equal(p.arch, 'x64');
  assert.equal(p.sha256, sha256(SYNTHETIC_INSTALLER));
  assert.equal(p.installer, path.basename(fx.installer));
  assert.equal(p.unpackedAsarSha256, sha256(fs.readFileSync(fx.archive)));
  assert.deepEqual(Object.keys(p.sourceHashes).sort(), [...FILES].sort());
  for (const relative of FILES) assert.equal(p.sourceHashes[relative], sha256(fs.readFileSync(path.join(fx.root, relative))));
  const out = outputDir(fx);
  assert.deepEqual(fs.readdirSync(out).sort(), [p.installer, 'SHA256SUMS-windows.txt', 'provenance-windows.json'].sort());
  assert.deepEqual(fs.readFileSync(path.join(out, p.installer)), SYNTHETIC_INSTALLER);
  assert.equal(fs.readFileSync(path.join(out, 'SHA256SUMS-windows.txt'), 'utf8'), `${p.sha256}  ${p.installer}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'provenance-windows.json'), 'utf8')), p);
  assert.match(p.scope, /Unpacked ASAR/);
  assert.match(p.scope, /installer hashed, not executed or extracted/);
  for (const relative of new Set([...MANIFESTS, ...FILES])) {
    assert.deepEqual(fs.readFileSync(path.join(fx.root, relative)), fs.readFileSync(path.join(repoRoot, relative)));
  }
});

for (const arch of ['arm64', 'x64']) {
  test(`macOS ${arch} synthetic layout and asset names`, async t => {
    const fx = await fixture(t, { platform: 'darwin', arch });
    const p = run(fx);
    assert.equal(p.platform, 'darwin');
    assert.equal(p.arch, arch);
    assert.equal(p.sha256, sha256(SYNTHETIC_INSTALLER));
    assert.equal(p.installer, `OpsPilot-Core-Demo-${fx.version}-mac-${arch}.dmg`);
    assert.deepEqual(fs.readdirSync(outputDir(fx)).sort(), [p.installer, 'SHA256SUMS-macos.txt', 'provenance-macos.json'].sort());
  });
}
test('extra ASAR file rejected without outputs', async t => {
  rejected(await fixture(t, { mutate: (_root, staging) => fs.writeFileSync(path.join(staging, 'extra.js'), 'extra') }));
});
test('changed source bytes rejected without outputs', async t => {
  rejected(await fixture(t, { mutateAfter: root => fs.appendFileSync(path.join(root, 'desktop/demo.cjs'), '\n// changed\n') }));
});
test('lock version mismatch rejected without outputs', async t => {
  rejected(await fixture(t, { mutate: root => {
    const file = path.join(root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    lock.version = '999.0.0';
    fs.writeFileSync(file, JSON.stringify(lock));
  } }));
});
test('empty installer rejected without outputs', async t => {
  rejected(await fixture(t, { installerBytes: Buffer.alloc(0) }));
});
test('existing candidate outputs never overwritten', async t => {
  const fx = await fixture(t);
  run(fx);
  const out = outputDir(fx);
  const before = new Map(fs.readdirSync(out).map(name => [name, fs.readFileSync(path.join(out, name))]));
  assert.throws(() => run(fx));
  assert.deepEqual(fs.readdirSync(out).sort(), [...before.keys()].sort());
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(out, name)), bytes);
});
test('invalid commit and unsupported platform rejected without outputs', async t => {
  const fx = await fixture(t);
  assert.throws(() => run(fx, { commit: 'not-a-commit' }));
  assert.throws(() => run(fx, { platform: 'linux' }));
  assert.equal(fs.existsSync(outputDir(fx)), false);
});
test('incorrect packaged license metadata rejected without outputs', async t => {
  rejected(await fixture(t, { mutate: (_root, staging) => {
    const file = path.join(staging, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.license = 'UNLICENSED';
    fs.writeFileSync(file, JSON.stringify(pkg));
  } }));
});
