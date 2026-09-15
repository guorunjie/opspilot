# Consuming Open Core

The first supported library entry is `opspilot/platform-action-protocol`:

```js
export * from 'opspilot/platform-action-protocol';
```

An Enterprise compatibility module can re-export this entry to preserve its
existing callers without maintaining another protocol implementation. This entry
does not start Electron, connect to a platform, load credentials or enable writes.
Root imports and private implementation subpaths are intentionally not exported.
The explicit desktop entry remains `desktop/demo.cjs` for source startup and
Electron packaging.

This is a development integration interface, not a published npm registry package.
`private: true` remains enabled. Consumers must pin a reviewed Git commit that
contains this interface and commit their resolved dependency lockfile. Do not use
a floating main branch or assume the dev.6 release tag includes later interface
changes. Install consumer dependencies without Core development dependencies or
installation hooks. No registry publishing or unattended updates are configured.

The dependency archive has an explicit source/desktop/license allowlist. Local
evidence, SQLite stores, credentials, collaboration notes, release binaries and
test outputs are not distribution inputs. Desktop development still uses a full
repository checkout and `npm ci`; consuming the protocol is not a replacement for
installing the desktop application.

Current evidence: Core self-import and blocked-private-import tests pass. A local
read-only probe ran ten existing Enterprise protocol tests against Core. These
checks do not yet establish a committed Enterprise dependency, full downstream
compatibility, desktop packaging acceptance after this change, or real-platform
validation. Those gates must be checked before calling the integration complete.
