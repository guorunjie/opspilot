import fs from 'node:fs';
import path from 'node:path';

// Preflight against existing links; not protection against a hostile process
// changing paths between this check and SQLite opening them.
export function prepareDemoDatabasePath(dataDir) {
  if (!path.isAbsolute(dataDir) || path.basename(dataDir) !== 'offline-demo'
    || path.basename(path.dirname(dataDir)) !== 'opspilot-open-core') throw new Error('演示目录无效');
  const absolute = path.resolve(dataDir);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('演示目录存在链接或非目录项，已停止访问');
  }
  const database = path.join(absolute, 'pharmacy.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    let stat;
    try { stat = fs.lstatSync(database + suffix); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('演示存档存在链接或异常文件，已停止访问');
  }
  return database;
}
