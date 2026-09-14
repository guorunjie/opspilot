import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validExecutorIdentity } from './taskOwnership.js';

// Host-local installation identity, not hardware attestation. Do not export
// this file with portable Demo databases. Caller creates the trusted directory.
export function loadLocalExecutorIdentity(runtimeDir) {
  if (!path.isAbsolute(runtimeDir) || path.basename(runtimeDir) !== 'desktop-runtime'
    || path.basename(path.dirname(runtimeDir)) !== 'opspilot-open-core') throw new Error('Invalid executor identity directory');
  let current = path.parse(runtimeDir).root;
  for (const part of runtimeDir.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked executor identity directory');
  }
  const file = path.join(runtimeDir, 'host-identity.json');
  const read = () => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512)
      throw new Error('Invalid executor identity file; preserve it');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.keys(value).sort().join(',') !== 'hostId,version' || value.version !== 1
      || !validExecutorIdentity({ hostId: value.hostId, instanceId: value.hostId, pid: process.pid }))
      throw new Error('Invalid executor identity; preserve it');
    return value.hostId;
  };
  let hostId;
  try { hostId = read(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, hostId: randomUUID() }) + '\n');
      fs.fsyncSync(fd);
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    // An incomplete concurrent creation fails closed; never overwrite it.
    hostId = read();
  }
  return Object.freeze({ hostId, pid: process.pid, instanceId: randomUUID() });
}
