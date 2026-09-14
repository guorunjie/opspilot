import { validExecutorIdentity } from './taskOwnership.js';

// Presence only, NOT release authorization. Caller must obtain hostId from a
// trusted host-local identity outside the portable task database. This is for
// same-process offline work, not children, remote jobs or production browsers.
export function inspectExecutorPresence(executor, hostId, probe = (pid, signal) => process.kill(pid, signal)) {
  if (!validExecutorIdentity(executor) || executor.hostId !== hostId)
    return { status: 'UNKNOWN', reason: 'UNBOUND_HOST_OR_EXECUTOR' };
  try {
    const result = probe(executor.pid, 0);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      return { status: 'UNKNOWN', reason: 'ASYNC_PROBE_UNSUPPORTED' };
    }
    return result === true ? { status: 'PRESENT', reason: 'PID_PRESENT' }
      : { status: 'UNKNOWN', reason: 'PROBE_UNCONFIRMED' };
  } catch (error) {
    return error?.code === 'ESRCH' ? { status: 'ABSENT', reason: 'PID_NOT_FOUND' }
      : { status: 'UNKNOWN', reason: 'PROBE_FAILED' };
  }
}
