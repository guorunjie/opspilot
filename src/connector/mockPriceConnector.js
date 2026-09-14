// Pure local synthetic target. No I/O, credentials, scheduling or production
// defaults. Caller owns approval and atomic persistence with task deduplication.
export function createMockPriceConnector({ storeId, prices }) {
  const id = value => typeof value === 'string' && value.trim().length > 0;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const require = (condition, message) => { if (!condition) throw new Error(`Mock connector: ${message}`); };
  require(id(storeId) && Array.isArray(prices) && prices.length > 0
    && Array.from(prices).every(row => Array.isArray(row) && row.length === 2 && id(row[0]) && integer(row[1]))
    && new Set(prices.map(row => row[0])).size === prices.length, 'invalid initial target');
  const target = new Map(prices.map(row => [...row]));
  const checkRequest = request => {
    require(id(request?.planId) && request.storeId === storeId && Array.isArray(request.items)
      && request.items.length > 0 && Array.from(request.items).every(item => id(item?.targetId))
      && new Set(request.items.map(item => item.targetId)).size === request.items.length, 'invalid scope or target list');
  };
  const checkWrite = request => {
    checkRequest(request);
    require(request.items.every(item => target.has(item.targetId) && integer(item.before) && integer(item.value)
      && target.get(item.targetId) === item.before), 'missing, invalid or stale target value');
    return true;
  };
  return Object.freeze({
    snapshot: () => [...target].map(row => [...row]),
    checkWrite,
    apply(request, { mismatch = false } = {}) {
      require(typeof mismatch === 'boolean', 'invalid simulation option');
      checkWrite(request); // Validate the whole batch before touching any item.
      for (const item of request.items) target.set(item.targetId, mismatch ? item.before : item.value);
      return { status: 'SUBMITTED', simulated: true, realPlatformVerified: false };
    },
    read(request) {
      checkRequest(request);
      return { planId: request.planId, connectorId: 'offline_demo', storeId,
        items: request.items.map(item => ({ targetId: item.targetId, value: target.get(item.targetId) ?? null })) };
    }
  });
}
