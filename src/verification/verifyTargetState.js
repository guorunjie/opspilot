// Compares caller-retrieved target state; does not authenticate a connector or
// prove a real platform write. Missing observations are never numeric zero.
export function verifyTargetState({ planId, connectorId, storeId, expected, readback }) {
  const id = value => typeof value === 'string' && value.trim().length > 0;
  const value = number => Number.isSafeInteger(number) && number >= 0;
  if (![planId, connectorId, storeId].every(id) || !Array.isArray(expected)
    || expected.length === 0 || Array.from(expected).some(item => !id(item?.targetId) || !value(item.value))
    || new Set(expected.map(item => item.targetId)).size !== expected.length) {
    throw new TypeError('A scoped plan with unique targets and integer expected values is required');
  }
  const targets = new Set(expected.map(item => item.targetId));
  const valid = readback?.planId === planId && readback?.connectorId === connectorId
    && readback?.storeId === storeId && Array.isArray(readback.items)
    && Array.from(readback.items).every(item => id(item?.targetId) && targets.has(item.targetId))
    && new Set(readback.items.map(item => item.targetId)).size === readback.items.length;
  const observations = new Map(valid ? readback.items.map(item => [item.targetId, item.value]) : []);
  const items = expected.map(item => {
    const observation = observations.get(item.targetId);
    const observed = value(observation) ? observation : null;
    return { targetId: item.targetId, expected: item.value, observed,
      status: observed === null ? 'UNKNOWN' : observed === item.value ? 'VERIFIED' : 'FAILED' };
  });
  const matched = items.filter(item => item.status === 'VERIFIED').length;
  const exact = matched === items.length;
  const status = exact ? 'VERIFIED' : matched > 0 ? 'PARTIALLY_VERIFIED'
    : items.some(item => item.status === 'UNKNOWN') ? 'UNKNOWN' : 'FAILED';
  return { status, exact, items };
}
