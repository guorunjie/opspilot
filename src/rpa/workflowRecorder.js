import { randomUUID } from 'node:crypto';
import { compileBrowserWorkflow } from './browserWorkflow.js';
const activePages = new WeakSet();

export function workflowFromRecording(record) {
  if (!record || record.kind !== 'WorkflowRecording' || record.version !== 1 || record.simulated !== true
    || Object.keys(record).some(key => !['kind', 'version', 'simulated', 'definition', 'digest', 'startedAt', 'endedAt'].includes(key))
    || typeof record.startedAt !== 'string' || typeof record.endedAt !== 'string'
    || !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.endedAt))
    || Date.parse(record.endedAt) < Date.parse(record.startedAt)) throw new TypeError('Invalid offline recording');
  const compiled = compileBrowserWorkflow(record.definition);
  if (compiled.digest !== record.digest) throw new Error('Recording digest mismatch');
  return compiled.definition; // No approval, run, or success state can be imported.
}

export async function startWorkflowRecorder({ runtime, workflowId, controls }) {
  const page = runtime?.page;
  if (!page || runtime.snapshot?.().offline !== true || page.isClosed() || activePages.has(page)
    || typeof workflowId !== 'string' || !workflowId.trim() || workflowId.length > 128
    || !Array.isArray(controls) || !controls.length || controls.length > 100)
    throw new TypeError('Open offline page and explicit recording controls required');
  const allowed = Array.from(controls, control => {
    if (!control || !['fill', 'click'].includes(control.type) || typeof control.selector !== 'string'
      || !control.selector.trim() || control.selector.length > 2048
      || Object.keys(control).some(key => !['type', 'selector'].includes(key))) throw new TypeError('Invalid recording control');
    return { type: control.type, selector: control.selector };
  });
  if (new Set(allowed.map(c => c.selector)).size !== allowed.length) throw new TypeError('Duplicate recording selector');
  const key = `__opspilot_recorder_${randomUUID().replaceAll('-', '')}`;
  const startedAt = new Date().toISOString();
  activePages.add(page);
  try {
    await page.evaluate(({ key, allowed }) => {
      // Selector validation occurs before installing either listener.
      for (const c of allowed) document.querySelectorAll(c.selector);
      const state = { steps: [], error: null };
      const capture = event => {
        if (state.error || !(event.target instanceof Element)) return;
        const type = event.type === 'input' ? 'fill' : 'click';
        const matches = allowed.filter(c => c.type === type && event.target.closest(c.selector));
        if (!matches.length) return;
        if (matches.length !== 1 || document.querySelectorAll(matches[0].selector).length !== 1) { state.error = 'Ambiguous recording target'; return; }
        const control = matches[0]; const target = event.target.closest(control.selector);
        if (type === 'fill' && (!(target instanceof HTMLInputElement) || !['text', 'number'].includes(target.type))) {
          state.error = 'Sensitive or unsupported recording input'; return;
        }
        const step = { id: `recorded-${state.steps.length + 1}`, type, selector: control.selector };
        if (type === 'fill') {
          if (target.value.length > 10000) { state.error = 'Recording input too large'; return; }
          step.value = target.value;
          const previous = state.steps.at(-1);
          if (previous?.type === 'fill' && previous.selector === step.selector) { previous.value = step.value; return; }
        }
        if (state.steps.length >= 100) { state.error = 'Recording step limit exceeded'; return; }
        state.steps.push(step);
      };
      const cleanup = () => { document.removeEventListener('input', capture, true); document.removeEventListener('click', capture, true); };
      window[key] = { state, cleanup };
      document.addEventListener('input', capture, true); document.addEventListener('click', capture, true);
    }, { key, allowed });
  } catch (error) { activePages.delete(page); throw error; }
  let stopped = false;
  const finish = async () => {
    if (stopped) throw new Error('Recorder already stopped');
    stopped = true;
    try {
      return await page.evaluate(key => {
        const recorder = window[key];
        if (!recorder) throw new Error('Recorder lost after page change');
        recorder.cleanup(); delete window[key]; return recorder.state;
      }, key);
    } finally { activePages.delete(page); }
  };
  return Object.freeze({
    cancel: async () => { await finish(); },
    async stop() {
      const result = await finish();
      if (result.error) throw new Error(result.error);
      const compiled = compileBrowserWorkflow({ version: 1, id: workflowId, steps: result.steps });
      return { kind: 'WorkflowRecording', version: 1, simulated: true, definition: compiled.definition,
        digest: compiled.digest, startedAt, endedAt: new Date().toISOString() };
    }
  });
}
