// Registration and staged invocation separated from production defaults.
// This synchronous local gateway is not a plugin sandbox or a remote executor.
export class CapabilityRegistry {
  #capabilities = new Map();

  constructor(capabilities = []) {
    for (const capability of capabilities) this.register(capability);
  }

  register(capability) {
    if (!capability || typeof capability.id !== 'string' || !capability.id.trim()
      || !['readonly', 'simulated_write', 'real_write'].includes(capability.riskLevel)
      || typeof capability.run !== 'function' || typeof capability.preconditions !== 'function'
      || (capability.riskLevel !== 'readonly' && typeof capability.authorize !== 'function')) {
      throw new TypeError('Explicit capability, preconditions and write authorizer required');
    }
    for (const hook of [capability.run, capability.preconditions, capability.authorize]) {
      if (hook?.constructor?.name === 'AsyncFunction') throw new TypeError('Local capabilities must be synchronous');
    }
    if (this.#capabilities.has(capability.id)) throw new Error('Capability already registered');
    this.#capabilities.set(capability.id, Object.freeze({ id: capability.id, riskLevel: capability.riskLevel,
      run: capability.run, preconditions: capability.preconditions, authorize: capability.authorize }));
    return this.get(capability.id);
  }

  get(id) {
    const capability = this.#capabilities.get(id);
    return capability ? { id: capability.id, riskLevel: capability.riskLevel } : null;
  }

  list() { return [...this.#capabilities.keys()].map(id => this.get(id)); }

  invoke(id, inputs, context = {}) {
    const capability = this.#capabilities.get(id);
    if (!capability) throw new Error('Unknown capability');
    // No context flag can turn this local executor into a production gateway.
    if (capability.riskLevel === 'real_write') throw new Error('Real writes are disabled in the local gateway');
    const payload = structuredClone(inputs);
    const ctx = structuredClone(context);
    const sync = hook => {
      const result = hook(structuredClone(payload), structuredClone(ctx));
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('Asynchronous execution requires a durable async runtime');
      }
      return result;
    };
    if (sync(capability.preconditions) !== true) {
      throw new Error('Capability preconditions not satisfied');
    }
    if (capability.riskLevel !== 'readonly'
      && sync(capability.authorize) !== true) {
      throw new Error('Capability lacks current scoped approval');
    }
    const result = sync(capability.run);
    return structuredClone(result); // Submission is not verification.
  }
}
