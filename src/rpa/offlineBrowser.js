// Application-owned Playwright browser. Never attaches to a user's profile/CDP.
// This is defense in depth for trusted synthetic fixtures, not an OS sandbox.
export async function openOfflineBrowser({ browserType, headless = true, timeoutMs = 10000 }) {
  if (browserType?.name?.() !== 'chromium' || typeof browserType.launch !== 'function'
    || typeof headless !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new TypeError('Explicit Chromium launcher and bounded timeout required');
  const browser = await browserType.launch({ headless, timeout: timeoutMs,
    args: ['--disable-background-networking'] });
  let context, page, status = 'OPENING', closing, running = false;
  const close = () => {
    if (status === 'CLOSED') return Promise.resolve({ status: 'CLOSED' });
    if (closing) return closing;
    status = 'CLOSING';
    closing = (async () => {
      try {
        await browser.close();
        if (browser.isConnected() || (page && !page.isClosed())) throw new Error('Browser close not confirmed');
        status = 'CLOSED'; return { status };
      } catch (error) { status = 'UNKNOWN'; throw error; }
      finally { closing = null; }
    })();
    return closing;
  };
  try {
    context = await browser.newContext({ offline: true, serviceWorkers: 'block',
      acceptDownloads: false, permissions: [], viewport: { width: 1100, height: 800 } });
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    await context.route('**/*', route => route.abort('blockedbyclient'));
    await context.routeWebSocket(/.*/, socket => socket.close());
    page = await context.newPage();
    context.on('page', extra => { if (extra !== page) void extra.close().catch(() => {}); });
    status = 'OPEN';
    return Object.freeze({
      // Only trusted in-process Connector code receives this page handle.
      page,
      snapshot: () => ({ status, connected: browser.isConnected(), pageClosed: page.isClosed(), offline: true }),
      async run(operation, { signal } = {}) {
        if (typeof operation !== 'function' || (signal && !(signal instanceof AbortSignal)))
          throw new TypeError('Trusted operation and AbortSignal required');
        if (status !== 'OPEN' || page.isClosed() || running) throw new Error('Offline browser unavailable or busy');
        if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted before start');
        running = true;
        let cleanup;
        const aborted = () => {
          cleanup = close();
          // Observe rejection immediately, but still propagate it below.
          cleanup.catch(() => {});
        };
        signal?.addEventListener('abort', aborted, { once: true });
        try {
          let value, failure, failed = false;
          try { value = await operation(page); } catch (error) { failed = true; failure = error; }
          if (cleanup) {
            try { await cleanup; } catch (error) {
              throw Object.assign(new AggregateError(failed ? [failure, error] : [error], 'Browser cancellation close unconfirmed'), { executionMayContinue: true });
            }
          }
          if (signal?.aborted) throw signal.reason ?? new Error('Browser operation aborted');
          if (failed) throw failure;
          return value;
        } finally {
          signal?.removeEventListener('abort', aborted);
          running = false;
        }
      },
      async load(html) {
        if (status !== 'OPEN' || page.isClosed()) throw new Error('Offline browser is not open');
        if (typeof html !== 'string' || html.length > 1000000) throw new TypeError('Bounded synthetic HTML required');
        // No fixture scripts, navigation targets, external assets or forms.
        await page.setContent(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'">${html}`);
      },
      close
    });
  } catch (cause) {
    try { await close(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Offline browser setup and close failed; termination unknown'); }
    throw cause;
  }
}
