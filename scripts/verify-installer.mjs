import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Destructive installation lifecycle checks are restricted to ephemeral CI.
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.CI, 'true');
assert.ok(['win32', 'darwin'].includes(process.platform));
const runnerRoot = fs.realpathSync(process.env.RUNNER_TEMP);
const root = fs.mkdtempSync(path.join(runnerRoot, 'opspilot-installer-'));
const within = file => {
  const relative = path.relative(root, fs.realpathSync(file));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  assert.ok(!fs.lstatSync(file).isSymbolicLink());
  return file;
};
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const win = process.platform === 'win32';
const arch = win ? 'x64' : process.arch;
const name = `OpsPilot-Core-Demo-${pkg.version}-${win ? 'win' : 'mac'}-${arch}.${win ? 'exe' : 'dmg'}`;
const installer = path.resolve('dist/core', name);
const output = path.resolve('output/playwright/packaged-ci');
fs.mkdirSync(output, { recursive: true });
const run = (command, args, timeout = 180000) => execFileSync(command, args, { stdio: 'inherit', timeout, windowsHide: true });
const destination = path.join(root, win ? 'OpsPilot-Core-Demo' : 'OpsPilot-Core-Demo.app');
const mount = path.join(root, 'mounted');
let mounted = false;
let installed = false;
let passed = false;
try {
  if (win) run(installer, ['/S', `/D=${destination}`]);
  else {
    fs.mkdirSync(mount);
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installer]);
    mounted = true;
    run('ditto', [path.join(mount, 'OpsPilot-Core-Demo.app'), destination]);
  }
  installed = true;
  within(destination);
  const archive = within(path.join(destination, win ? 'resources/app.asar' : 'Contents/Resources/app.asar'));
  const unpacked = path.resolve('dist/core', win ? 'win-unpacked/resources/app.asar'
    : `${arch === 'arm64' ? 'mac-arm64' : 'mac'}/OpsPilot-Core-Demo.app/Contents/Resources/app.asar`);
  assert.equal(sha(archive), sha(unpacked), 'Installed archive must match audited build archive');
  const executable = within(path.join(destination, win ? 'OpsPilot-Core-Demo.exe' : 'Contents/MacOS/OpsPilot-Core-Demo'));
  run(process.execPath, [path.resolve('scripts/verify-packaged-demo.mjs'), executable], 600000);
  const evidence = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
  assert.equal(evidence.version, pkg.version);
  assert.equal(evidence.scenarios.length, 4);
  assert.equal(evidence.supplementalResetRepeat, true);
  assert.deepEqual(evidence.recovery.map(({ point, status, submissionCount }) => ({ point, status, submissionCount })),
    ['started', 'reserved', 'written', 'verify-started', 'verify-saved'].map(point => ({ point,
      status: ['started', 'reserved'].includes(point) ? 'FAILED' : 'VERIFIED',
      submissionCount: ['started', 'reserved'].includes(point) ? 0 : 1 })));
  const expectedSupplemental = ['inventory', 'campaign'].flatMap(kind =>
    ['normal', 'response_lost', 'mismatch', 'readback_unavailable'].map(scenario => ({
      kind, scenario, submissionCount: 1, status: scenario === 'mismatch' ? 'FAILED' : 'VERIFIED'
    })));
  const byIdentity = (a, b) => `${a.kind}:${a.scenario}`.localeCompare(`${b.kind}:${b.scenario}`);
  assert.deepEqual([...evidence.supplemental].sort(byIdentity), expectedSupplemental.sort(byIdentity));
  const archiveSha256 = sha(archive);
  if (win) {
    const uninstaller = within(path.join(destination, 'Uninstall OpsPilot-Core-Demo.exe'));
    run(uninstaller, ['/S', '/currentuser']);
    // NSIS starts a temporary child so it can remove the original uninstaller.
    // Observe removal; parent exit alone is not uninstall completion.
    const deadline = Date.now() + 30000;
    while ([executable, uninstaller, archive].some(file => fs.existsSync(file)) && Date.now() < deadline) await delay(250);
    assert.equal(fs.existsSync(executable), false, 'Uninstaller must remove test executable');
    assert.equal(fs.existsSync(uninstaller), false, 'Uninstaller must remove its original file');
    assert.equal(fs.existsSync(archive), false, 'Uninstaller must remove application archive');
  } else {
    // Remove only the freshly copied test app inside the owned temporary root.
    within(destination);
    assert.equal(path.basename(destination), 'OpsPilot-Core-Demo.app');
    fs.rmSync(destination, { recursive: true });
    assert.equal(fs.existsSync(destination), false);
  }
  installed = false;
  fs.writeFileSync(path.join(output, 'install.json'), JSON.stringify({ version: pkg.version,
    commit: process.env.GITHUB_SHA, platform: process.platform, arch, installer: name,
    installerSha256: sha(installer), installedAsarSha256: archiveSha256, uiScenarios: 12,
    opportunityKinds: ['price', 'inventory', 'campaign'], supplementalResetRepeat: true,
    uninstallPassed: true,
    recoveryBoundaries: evidence.recovery.map(item => item.point),
    scope: 'Ephemeral CI: Windows silent NSIS installation or macOS read-only DMG mount/app copy, actual packaged UI, app removal. Not interactive wizard, end-user quarantine/Gatekeeper, Developer ID/notarization or real-platform acceptance.' }, null, 2) + '\n');
  passed = true;
} finally {
  // Never erase a failed install or a user's profile to make checks pass.
  if (mounted) run('hdiutil', ['detach', mount]);
  if (!passed) console.error(`Installer verification failed; temporary evidence retained. Installed=${installed}`);
}
