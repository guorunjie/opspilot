import { createPageEvidence, pageEvidenceScope } from '../evidence/pageEvidence.js';

// Read-only CDP session on an application-supplied page, no URL attachment,
// arbitrary protocol send, Runtime.evaluate, navigation, input or writes.
export async function openPageCDP({ context, page, scope, simulated }) {
  const identity = pageEvidenceScope(scope);
  if (typeof simulated !== 'boolean' || page?.context?.() !== context || page.isClosed()
    || typeof context?.newCDPSession !== 'function') throw new TypeError('Owned open page context required');
  const session = await context.newCDPSession(page);
  let detached = false, busy = false;
  const run = async fn => {
    if (detached || page.isClosed() || busy) throw new Error('CDP unavailable or busy');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  };
  const artifact = (kind, bytes) => createPageEvidence({ scope: identity, kind, bytes, simulated });
  return Object.freeze({
    readDOM: selector => run(async () => {
      if (typeof selector !== 'string' || !selector.trim() || selector.length > 2048) throw new TypeError('Bounded selector required');
      const { root } = await session.send('DOM.getDocument', { depth: 0 });
      const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
      if (!Array.isArray(nodeIds)) throw new Error('Invalid DOM query response');
      if (nodeIds.length !== 1) return { status: nodeIds.length ? 'AMBIGUOUS' : 'MISSING', count: nodeIds.length, artifact: null };
      const { outerHTML } = await session.send('DOM.getOuterHTML', { nodeId: nodeIds[0] });
      if (typeof outerHTML !== 'string' || !outerHTML) throw new Error('DOM evidence unavailable');
      return { status: 'CAPTURED', count: 1, artifact: artifact('dom', Buffer.from(outerHTML, 'utf8')) };
    }),
    screenshot: () => run(async () => {
      const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (typeof data !== 'string' || data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Invalid screenshot response');
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot is not PNG');
      return artifact('screenshot', bytes);
    }),
    async detach() {
      if (detached) return;
      if (busy) throw new Error('CDP operation still pending');
      await session.detach(); detached = true;
    }
  });
}
