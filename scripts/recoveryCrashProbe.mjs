// Test driver only; excluded from desktop packaging. It intercepts a completed
// SQLite write in the owned Electron process, without changing saved values.
export async function installRecoveryCrashProbe(app, point) {
  if (!['started', 'reserved', 'written', 'verify-started', 'verify-saved'].includes(point))
    throw new Error('Unknown recovery crash boundary');
  await app.evaluate((_electron, selected) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = original.call(this, sql);
      if (!sql.startsWith('UPDATE core_snapshots SET revision=revision+1,value=?')) return statement;
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        const result = run(...args);
        if (result.changes !== 1 || args[1] !== 'offline-demo') return result;
        const value = JSON.parse(args[0]), key = args[2];
        const hit = (selected === 'started' && key.startsWith('task:') && value.task?.status === 'EXECUTING')
          || (selected === 'reserved' && key.startsWith('async-price:') && value.scenario !== null && value.submissionCount === 0)
          || (selected === 'written' && key.startsWith('async-price:') && value.submissionCount === 1)
          || (selected === 'verify-started' && key.startsWith('task:') && value.task?.status === 'VERIFYING')
          || (selected === 'verify-saved' && key.startsWith('task:') && value.task?.status === 'VERIFIED');
        if (hit) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      return statement;
    };
  }, point);
}
