import { createHash, randomUUID } from 'node:crypto';
export function pageEvidenceScope(input) {
  const result = {};
  for (const key of ['namespace', 'taskId', 'planId', 'runId', 'connectorId', 'storeId']) {
    if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > 256)
      throw new TypeError('Complete evidence scope required');
    result[key] = input[key];
  }
  return result;
}
export function createPageEvidence({ scope, kind, bytes, simulated, capturedAt = new Date().toISOString() }) {
  const identity = pageEvidenceScope(scope);
  if (!['dom', 'screenshot'].includes(kind) || !(bytes instanceof Uint8Array) || !bytes.byteLength
    || bytes.byteLength > 20 * 1024 * 1024 || typeof simulated !== 'boolean'
    || typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt)))
    throw new TypeError('Valid bounded page evidence required');
  const content = Buffer.from(bytes);
  return { record: { kind: 'PageEvidence', version: 1, id: randomUUID(), scope: identity,
    artifactType: kind, mediaType: kind === 'dom' ? 'text/html; charset=utf-8' : 'image/png',
    source: 'page-cdp', capturedAt, simulated, byteLength: content.length,
    sha256: createHash('sha256').update(content).digest('hex') }, bytes: content };
}
