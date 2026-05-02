import type { WorkerTaskBcModel } from './workerTaskPolicy';

export const WORKER_TASK_BC_MODEL: WorkerTaskBcModel = {
  type: 'worker-task-bc-decision-tree',
  schemaVersion: 1,
  policyId: 'worker-task-bc.untrained.v1',
  source: 'placeholder',
  liveEffect: false,
  minConfidence: 0.9,
  actionTypes: ['harvest', 'transfer', 'build', 'repair', 'upgrade'],
  features: [],
  root: null,
  metadata: {
    trainingSampleCount: 0,
    evaluationSampleCount: 0,
    evaluationMatchRate: null,
    notes: 'No trained artifact is bundled yet; runtime remains heuristic-only.'
  }
};
