// Trusted application hooks, not a plugin sandbox. Task owns persistence,
// idempotency and the lifetime of any outstanding operation.
export class AsyncCapabilityRegistry {
  #capabilities = new Map();

  constructor(capabilities = []) {
    for (const capability of capabilities) this.register(capability);
  }

  register(capability) {
    if (!capability || typeof capability.id !== 'string' || !capability.id.trim()
      || !['readonly', 'simulated_write', 'real_write'].includes(capability.riskLevel)
      || typeof capability.preconditions !== 'function' || typeof capability.run !== 'function'
      || typeof capability.validateCurrent !== 'function'
      || capability.validateCurrent.constructor?.name === 'AsyncFunction'
      || (capability.riskLevel !== 'readonly' && typeof capability.authorize !== 'function'))
      throw new TypeError('Capability hooks and synchronous current-state guard required');
    if (this.#capabilities.has(capability.id)) throw new Error('Capability already registered');
    this.#capabilities.set(capability.id, Object.freeze({ id: capability.id, riskLevel: capability.riskLevel,
      preconditions: capability.preconditions, authorize: capability.authorize,
      validateCurrent: capability.validateCurrent, run: capability.run }));
    return this.get(capability.id);
  }

  get(id) {
    const capability = this.#capabilities.get(id);
    return capability ? { id: capability.id, riskLevel: capability.riskLevel } : null;
  }

  list() { return [...this.#capabilities.keys()].map(id => this.get(id)); }

  async invoke(id, inputs, context = {}) {
    const capability = this.#capabilities.get(id);
    if (!capability) throw new Error('Unknown capability');
    if (capability.riskLevel === 'real_write') throw new Error('Real writes are disabled in the local gateway');
    const { signal, ...rest } = context;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('AbortSignal required');
    const payload = structuredClone(inputs), ctx = structuredClone(rest);
    const args = () => [structuredClone(payload), { ...structuredClone(ctx), signal }];
    signal?.throwIfAborted();
    if (await capability.preconditions(...args()) !== true) throw new Error('Capability preconditions not satisfied');
    signal?.throwIfAborted();
    if (capability.riskLevel !== 'readonly') {
      if (await capability.authorize(...args()) !== true) throw new Error('Capability lacks current scoped approval');
      signal?.throwIfAborted();
    }
    // No await between this final guard and invocation. The hook must check
    // current Task scope/status/approval, not just an earlier async snapshot.
    const valid = capability.validateCurrent(...args());
    if (valid && typeof valid.then === 'function') {
      Promise.resolve(valid).catch(() => {});
      throw new TypeError('Current-state guard must be synchronous');
    }
    if (valid !== true) throw new Error('Capability current-state guard rejected');
    signal?.throwIfAborted();
    // Deliberately await the original operation: abort is not proof it stopped.
    // Preserve rejection identity (including executionMayContinue).
    const result = await capability.run(...args());
    signal?.throwIfAborted();
    return structuredClone(result); // Never promote a submission to VERIFIED.
  }
}
