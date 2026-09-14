// Static configuration regression tests only: they compare the candidate
// package.json and electron-builder.json with the reviewed desktop packaging
// shape. They do not verify installer output, macOS packaging, signing,
// secret scanning, the full dependency graph, or runtime acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const builderJsonUrl = new URL('../electron-builder.json', import.meta.url);
const repoRoot = path.dirname(fileURLToPath(packageJsonUrl));
const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));

const EXPECTED_FILES = [
  'LICENSE',
  'package.json',
  'desktop/demo.cjs',
  'desktop/demoRuntime.cjs',
  'desktop/demo-preload.cjs',
  'desktop/demo/index.html',
  'desktop/demo/demo.js',
  'desktop/demo/demo.css',
  'src/demo/offlineStoreDemo.js',
  'src/demo/desktopDemoFactory.js',
  'src/demo/asyncStoreDemo.js',
  'src/demo/asyncPriceSession.js',
  'src/demo/asyncPriceView.js',
  'src/agent/asyncTaskAgent.js',
  'src/capability/asyncCapabilityRegistry.js',
  'src/storage/persistentTask.js',
  'src/storage/taskOwnership.js',
  'src/storage/localExecutorIdentity.js',
  'src/storage/executorPresence.js',
  'src/demo/supplementalOpportunities.js',
  'src/demo/validateDemoState.js',
  'src/verification/verifyTargetState.js',
  'src/task/taskState.js',
  'src/agent/localTaskAgent.js',
  'src/capability/capabilityRegistry.js',
  'src/connector/mockPriceConnector.js',
  'src/demo/demoPriceCapabilities.js',
  'src/domain/model/pricePlanning.js',
  'src/domain/model/operationPlanning.js',
  'src/domain/model/platformActionProtocol.js',
  'src/storage/sqliteStateStore.js',
  'src/storage/demoStoragePath.js',
];

const FORBIDDEN_KEYS = ['extraResources', 'extraFiles', 'extends', 'electronDist',
  'beforeBuild', 'afterPack', 'afterSign', 'afterAllArtifactBuild', 'beforePack'];

const assertLocalRelativePath = (entry) => {
  assert.equal(typeof entry, 'string', 'file entries must be strings');
  assert.ok(!path.isAbsolute(entry), `${entry} must be relative`);
  assert.ok(!/^[A-Za-z]:/.test(entry), `${entry} must not be a drive path`);
  assert.ok(!/[!*?\[\]{}]/.test(entry), `${entry} must not use globs`);
  assert.ok(!entry.split('/').includes('..'), `${entry} must not traverse`);
  assert.equal(path.posix.normalize(entry), entry, `${entry} must be normalized`);
};

test('packaging files are the exact reviewed set of existing regular files', async () => {
  const config = await readJson(builderJsonUrl);
  assert.ok(Array.isArray(config.files), 'config.files must be an array');
  assert.deepEqual([...config.files].sort(), [...EXPECTED_FILES].sort(), 'config.files must match exactly');
  assert.equal(new Set(config.files).size, config.files.length, 'no duplicate files');
  for (const key of FORBIDDEN_KEYS) {
    assert.equal(config[key], undefined, `config.${key} must stay undefined`);
  }
  for (const platform of ['win', 'mac', 'linux']) {
    for (const key of ['files', 'extraFiles', 'extraResources', 'publish']) assert.equal(config[platform]?.[key], undefined);
  }
  const canonicalRoot = await realpath(repoRoot);
  for (const entry of config.files) {
    assertLocalRelativePath(entry);
    const absolute = path.resolve(repoRoot, entry);
    assert.ok(absolute.startsWith(repoRoot + path.sep), `${entry} must stay inside the repo`);
    const info = await lstat(absolute);
    assert.ok(info.isFile(), `${entry} must be a regular file`);
    const relative = path.relative(canonicalRoot, await realpath(absolute));
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'Resolved file must stay within repo');
  }
});

test('electron-builder install identity fields stay pinned', async () => {
  const config = await readJson(builderJsonUrl);
  assert.equal(config.appId, 'com.opspilot.opencore.demo');
  assert.equal(config.productName, 'OpsPilot Open Core Demo');
  assert.equal(config.executableName, 'OpsPilot-Core-Demo');
  assert.equal(config.directories?.output, 'dist/core');
  assert.equal(config.asar, true);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.publish, null);
  const nsis = config.nsis;
  assert.ok(nsis && typeof nsis === 'object', 'config.nsis must be an object');
  assert.equal(nsis.oneClick, false);
  assert.equal(nsis.perMachine, false);
  assert.equal(nsis.allowElevation, false);
  assert.equal(nsis.allowToChangeInstallationDirectory, true);
  assert.equal(nsis.createDesktopShortcut, 'always');
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.shortcutName, 'OpsPilot Open Core Demo');
  assert.equal(nsis.deleteAppDataOnUninstall, false);
  assert.equal(nsis.runAfterFinish, false);
});

test('main entry, dependencies and desktop scripts stay pinned', async () => {
  const pkg = await readJson(packageJsonUrl);
  // license and private are intentionally not asserted; release may change them.
  assert.equal(pkg.main, 'desktop/demo.cjs');
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
  assert.equal(pkg.devDependencies?.electron, '42.7.0');
  assert.equal(pkg.devDependencies?.['electron-builder'], '26.8.1');
  assert.equal(Object.keys(pkg.optionalDependencies || {}).length, 0);
  const scripts = pkg.scripts || {};
  assert.equal(scripts.start, 'electron desktop/demo.cjs');
  const expectedCommands = {
    'desktop:pack': 'electron-builder --config electron-builder.json --dir --publish never',
    'desktop:dist:win': 'electron-builder --config electron-builder.json --win nsis --x64 --publish never',
    'desktop:dist:mac': 'electron-builder --config electron-builder.json --mac dmg --publish never'
  };
  for (const name of ['desktop:pack', 'desktop:dist:win', 'desktop:dist:mac']) {
    const command = scripts[name];
    assert.equal(command, expectedCommands[name], 'No appended options or command substitution');
    assert.equal(typeof command, 'string', `${name} script must be defined`);
    assert.ok(command.includes('--config electron-builder.json'), `${name} needs the config`);
    assert.ok(command.includes('--publish never'), `${name} must not publish`);
    assert.ok(!/[;&|]/.test(command), `${name} must not chain shell separators`);
    assert.equal(scripts[`pre${name}`], undefined, `${name} must have no pre hook`);
    assert.equal(scripts[`post${name}`], undefined, `${name} must have no post hook`);
  }
});
