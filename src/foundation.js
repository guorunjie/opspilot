// Explicit public entry. Importing does not execute a task or open a database.
export { createSourceReader } from './connector/sourceReader.js';
export { prepareSourceOpportunityTask } from './task/sourceOpportunityTask.js';
export { prepareCompensationPreview } from './task/compensationPreview.js';
export { createConnectorWorkflowCapability } from './rpa/connectorWorkflow.js';
export { AsyncCapabilityRegistry } from './capability/asyncCapabilityRegistry.js';
export { createTask, advanceTask } from './task/taskState.js';
export { openPersistentTask } from './storage/persistentTask.js';
export { openStateStore } from './storage/sqliteStateStore.js';
export { compileBrowserWorkflow } from './rpa/browserWorkflow.js';
export { workflowFromRecording, startWorkflowRecorder } from './rpa/workflowRecorder.js';
