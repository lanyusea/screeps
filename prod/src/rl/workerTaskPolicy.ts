import { WORKER_TASK_BC_MODEL } from './workerTaskBcModel';
import {
  WORKER_TASK_BC_ACTION_TYPES,
  WORKER_TASK_BEHAVIOR_SCHEMA_VERSION,
  type WorkerTaskBehaviorActionType,
  isWorkerTaskBehaviorActionType
} from './workerTaskBehavior';

export interface WorkerTaskBcModel {
  type: 'worker-task-bc-decision-tree';
  schemaVersion: 1;
  policyId: string;
  source: string;
  liveEffect: false;
  minConfidence: number;
  actionTypes: WorkerTaskBehaviorActionType[];
  features: string[];
  root: WorkerTaskBcNode | null;
  metadata?: {
    trainingSampleCount?: number;
    evaluationSampleCount?: number;
    evaluationMatchRate?: number | null;
    notes?: string;
  };
}

export type WorkerTaskBcNode = WorkerTaskBcLeafNode | WorkerTaskBcBranchNode;

export interface WorkerTaskBcLeafNode {
  type: 'leaf';
  action: WorkerTaskBehaviorActionType;
  confidence: number;
  sampleCount: number;
  distribution: Partial<Record<WorkerTaskBehaviorActionType, number>>;
}

export interface WorkerTaskBcBranchNode {
  type: 'branch';
  feature: keyof WorkerTaskBehaviorStateMemory | string;
  threshold: number;
  missing: 'left' | 'right';
  sampleCount: number;
  distribution: Partial<Record<WorkerTaskBehaviorActionType, number>>;
  left: WorkerTaskBcNode;
  right: WorkerTaskBcNode;
}

export interface WorkerTaskBcPrediction {
  policyId: string;
  action: WorkerTaskBehaviorActionType;
  confidence: number;
}

let testingModelOverride: WorkerTaskBcModel | null = null;

export function selectWorkerTaskWithBcFallback(
  creep: Creep,
  heuristicTask: CreepTaskMemory | null
): CreepTaskMemory | null {
  const memory = creep.memory;
  const model = getActiveWorkerTaskBcModel();
  const state = memory?.workerBehavior?.state;
  if (memory && !state) {
    delete memory.workerTaskPolicyShadow;
    return heuristicTask;
  }

  const prediction = state ? predictWorkerTaskAction(model, state) : null;
  const heuristicAction = isWorkerTaskBehaviorActionType(heuristicTask?.type) ? heuristicTask.type : undefined;

  if (memory) {
    memory.workerTaskPolicyShadow = {
      type: 'workerTaskPolicyShadow',
      schemaVersion: WORKER_TASK_BEHAVIOR_SCHEMA_VERSION,
      tick: getGameTick(),
      policyId: model.policyId,
      liveEffect: false,
      ...(prediction ? { predictedAction: prediction.action, confidence: prediction.confidence } : {}),
      ...(heuristicAction ? { heuristicAction } : {}),
      matched: Boolean(prediction && heuristicAction && prediction.action === heuristicAction),
      ...buildFallbackReason(model, prediction, heuristicAction)
    };
  }

  return heuristicTask;
}

export function predictWorkerTaskAction(
  model: WorkerTaskBcModel,
  state: WorkerTaskBehaviorStateMemory
): WorkerTaskBcPrediction | null {
  if (!isUsableModel(model)) {
    return null;
  }

  const leaf = evaluateNode(model.root, state);
  if (!leaf || leaf.confidence < model.minConfidence) {
    return null;
  }

  return {
    policyId: model.policyId,
    action: leaf.action,
    confidence: leaf.confidence
  };
}

export function setWorkerTaskBcModelForTesting(model: WorkerTaskBcModel): void {
  testingModelOverride = model;
}

export function resetWorkerTaskBcModelForTesting(): void {
  testingModelOverride = null;
}

function getActiveWorkerTaskBcModel(): WorkerTaskBcModel {
  return testingModelOverride ?? WORKER_TASK_BC_MODEL;
}

function isUsableModel(model: WorkerTaskBcModel): boolean {
  return (
    model.type === 'worker-task-bc-decision-tree' &&
    model.schemaVersion === 1 &&
    model.liveEffect === false &&
    model.root !== null &&
    model.actionTypes.every((action) => WORKER_TASK_BC_ACTION_TYPES.includes(action))
  );
}

function evaluateNode(
  node: WorkerTaskBcNode | null,
  state: WorkerTaskBehaviorStateMemory
): WorkerTaskBcLeafNode | null {
  if (!node) {
    return null;
  }

  if (node.type === 'leaf') {
    return node;
  }

  const featureValue = getFeatureValue(state, node.feature);
  if (featureValue === null) {
    return evaluateNode(node.missing === 'left' ? node.left : node.right, state);
  }

  return evaluateNode(featureValue <= node.threshold ? node.left : node.right, state);
}

function getFeatureValue(state: WorkerTaskBehaviorStateMemory, feature: string): number | null {
  const value = (state as unknown as Record<string, unknown>)[feature];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return null;
}

function buildFallbackReason(
  model: WorkerTaskBcModel,
  prediction: WorkerTaskBcPrediction | null,
  heuristicAction: WorkerTaskBehaviorActionType | undefined
): Pick<WorkerTaskPolicyShadowMemory, 'fallbackReason'> {
  if (!isUsableModel(model)) {
    return { fallbackReason: 'untrainedModel' };
  }

  if (!prediction) {
    return { fallbackReason: 'lowConfidence' };
  }

  if (!heuristicAction) {
    return { fallbackReason: 'unsupportedHeuristicAction' };
  }

  if (prediction.action !== heuristicAction) {
    return { fallbackReason: 'actionMismatch' };
  }

  return {};
}

function getGameTick(): number {
  const tick = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof tick === 'number' && Number.isFinite(tick) ? tick : 0;
}
