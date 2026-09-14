import { DatabaseSync } from 'node:sqlite';

// Storage only: a saved status is not proof of execution or verification.
// Callers own schema validation, namespace selection and safe execution recovery.
export function openStateStore(file, namespace) {
  const validKey = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
  if (!validKey(namespace)) throw new TypeError('Explicit namespace required');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec(`CREATE TABLE IF NOT EXISTS core_snapshots (
      namespace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
      value TEXT NOT NULL, PRIMARY KEY(namespace, key)
    ) STRICT`);
  } catch (error) { db.close(); throw error; }
  return {
    read(key) {
      if (!validKey(key)) throw new TypeError('Explicit key required');
      const row = db.prepare('SELECT revision, value FROM core_snapshots WHERE namespace=? AND key=?').get(namespace, key);
      return row ? { revision: row.revision, value: JSON.parse(row.value) } : null;
    },
    save(key, value, expectedRevision) {
      if (!validKey(key)) throw new TypeError('Explicit key required');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Invalid expected revision');
      }
      const json = JSON.stringify(value);
      if (json === undefined) throw new TypeError('JSON value required');
      // A single conditional SQL write is atomic across connections/processes.
      const result = expectedRevision === 0
        ? db.prepare('INSERT INTO core_snapshots(namespace,key,revision,value) VALUES(?,?,1,?) ON CONFLICT(namespace,key) DO NOTHING').run(namespace, key, json)
        : db.prepare('UPDATE core_snapshots SET revision=revision+1,value=? WHERE namespace=? AND key=? AND revision=?').run(json, namespace, key, expectedRevision);
      if (result.changes !== 1) throw new Error('State revision conflict: reload before continuing');
      return expectedRevision + 1;
    },
    close() { db.close(); }
  };
}
