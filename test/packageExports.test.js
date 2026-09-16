import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('consumer protocol import resolves without launching the desktop shell', async () => {
  const api = await import('opspilot/platform-action-protocol');
  const direct = await import('../src/domain/model/platformActionProtocol.js');
  assert.equal(api.createPlatformAction, direct.createPlatformAction);
  assert.deepEqual(Object.keys(api).sort(), Object.keys(direct).sort());
});

test('package root and private desktop paths cannot be imported by consumers', async () => {
  for (const path of ['opspilot', 'opspilot/desktop/demo.cjs', 'opspilot/src/demo/offlineStoreDemo.js']) {
    await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('host binding consumer uses the same pure Core implementation', async () => {
  const api = await import('opspilot/host-execution-binding');
  const direct = await import('../src/connector/hostExecutionBinding.js');
  assert.deepEqual(Object.keys(api).sort(), ['createHostExecutionBinding', 'matchesHostExecutionBinding']);
  assert.equal(api.createHostExecutionBinding, direct.createHostExecutionBinding);
  assert.equal(api.matchesHostExecutionBinding, direct.matchesHostExecutionBinding);
});

test('dependency packaging excludes local evidence and keeps explicit desktop entry', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.main, 'desktop/demo.cjs');
  assert.equal(pkg.private, true); // Git dependency only; no npm registry publication.
  assert.deepEqual(pkg.exports, {
    './platform-action-protocol': './src/domain/model/platformActionProtocol.js',
    './host-execution-binding': './src/connector/hostExecutionBinding.js',
    './connector-manifest': './src/connector/connectorManifest.js',
    './connector-registry': './src/connector/connectorRegistry.js',
    './source-observation': './src/domain/model/sourceObservation.js',
    './source-opportunities': './src/domain/model/sourceOpportunities.js',
    './foundation': './src/foundation.js'
  });
  assert.deepEqual(pkg.files, ['src/', 'desktop/', 'electron-builder.json', 'LICENSE', 'docs/source-observations.md', 'docs/foundation-api.md', 'docs/compensation-preview.md', 'README.md']);
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[name], undefined);
  assert.equal(pkg.dependencies, undefined);
});

test('connector manifest consumer exposes metadata only', async () => {
  const api = await import('opspilot/connector-manifest');
  const direct = await import('../src/connector/connectorManifest.js');
  assert.deepEqual(Object.keys(api).sort(), ['assessConnectorReadiness', 'createConnectorManifest']);
  assert.equal(api.createConnectorManifest, direct.createConnectorManifest);
});

test('connector registry consumer exposes only explicit trusted registration', async () => {
  const api = await import('opspilot/connector-registry');
  assert.deepEqual(Object.keys(api), ['createConnectorRegistry']);
  assert.deepEqual(api.createConnectorRegistry().list(), []);
});

test('source-observation consumer exposes the same normalization function', async () => {
  const api = await import('opspilot/source-observation');
  const direct = await import('../src/domain/model/sourceObservation.js');
  assert.deepEqual(Object.keys(api), ['normalizeSourceObservation']);
  assert.equal(api.normalizeSourceObservation, direct.normalizeSourceObservation);
});

test('source-opportunities consumer exposes the same advisory planner', async () => {
  const api = await import('opspilot/source-opportunities');
  const direct = await import('../src/domain/model/sourceOpportunities.js');
  assert.deepEqual(Object.keys(api), ['buildSourceOpportunities']);
  assert.equal(api.buildSourceOpportunities, direct.buildSourceOpportunities);
});
