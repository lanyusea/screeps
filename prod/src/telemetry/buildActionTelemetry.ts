export interface RuntimeBuildActionResultCounts {
  succeeded: number;
  failed_no_energy: number;
  failed_no_work: number;
  failed_no_path: number;
  failed_site_invalid: number;
  suppressed_by_policy: number;
}

export interface RuntimeBuildActionWorkerSummary {
  name?: string;
  buildActionResult: WorkerBuildActionResult;
  actionCount: number;
  buildFailCount: number;
  suppressedCount: number;
  resultCounts: RuntimeBuildActionResultCounts;
  lastTargetId?: string;
  lastTick?: number;
}

export interface RuntimeBuildActionSummary {
  source: 'runtime-summary';
  buildActionResult: WorkerBuildActionResult;
  actionCount: number;
  buildFailCount: number;
  suppressedCount: number;
  resultCounts: RuntimeBuildActionResultCounts;
  workers: RuntimeBuildActionWorkerSummary[];
}

const BUILD_ACTION_RESULT_KEYS: WorkerBuildActionResult[] = [
  'succeeded',
  'failed_no_energy',
  'failed_no_work',
  'failed_no_path',
  'failed_site_invalid',
  'suppressed_by_policy'
];

const BUILD_ACTION_FAILURE_RESULTS = new Set<WorkerBuildActionResult>(
  BUILD_ACTION_RESULT_KEYS.filter((result) => result !== 'succeeded')
);

export function recordWorkerBuildActionResult(
  creep: Creep,
  result: WorkerBuildActionResult,
  context: { targetId?: string } = {}
): void {
  const telemetry = ensureWorkerBuildActionTelemetry(creep);
  const tick = getGameTime();
  const targetId = normalizeTargetId(context.targetId);

  if (
    tick !== null &&
    telemetry.lastTick === tick &&
    telemetry.lastResult === result &&
    normalizeTargetId(telemetry.lastTargetId) === targetId
  ) {
    return;
  }

  const resultCounts = telemetry.resultCounts ?? {};
  resultCounts[result] = getNonNegativeCounter(resultCounts[result]) + 1;
  telemetry.resultCounts = resultCounts;
  telemetry.lastResult = result;
  if (tick !== null) {
    telemetry.lastTick = tick;
  } else {
    delete telemetry.lastTick;
  }
  if (targetId) {
    telemetry.lastTargetId = targetId;
  } else {
    delete telemetry.lastTargetId;
  }
}

export function summarizeAndResetWorkerBuildActionTelemetry(
  workers: Creep[]
): { buildActionResults?: RuntimeBuildActionSummary } {
  const workerSummaries = workers
    .map(toRuntimeBuildActionWorkerSummary)
    .filter((summary): summary is RuntimeBuildActionWorkerSummary => summary !== null)
    .sort(compareRuntimeBuildActionWorkerSummaries);

  if (workerSummaries.length === 0) {
    return {};
  }

  const resultCounts = workerSummaries.reduce(
    (totals, worker) => mergeBuildActionResultCounts(totals, worker.resultCounts),
    createEmptyBuildActionResultCounts()
  );
  const actionCount = sumBuildActionResultCounts(resultCounts);
  const buildFailCount = sumBuildFailureResultCounts(resultCounts);

  for (const worker of workers) {
    delete worker.memory.buildActionTelemetry;
  }

  return {
    buildActionResults: {
      source: 'runtime-summary',
      buildActionResult: selectDominantBuildActionResult(resultCounts),
      actionCount,
      buildFailCount,
      suppressedCount: resultCounts.suppressed_by_policy,
      resultCounts,
      workers: workerSummaries
    }
  };
}

function ensureWorkerBuildActionTelemetry(creep: Creep): WorkerBuildActionTelemetryMemory {
  if (!creep.memory.buildActionTelemetry) {
    creep.memory.buildActionTelemetry = {};
  }

  return creep.memory.buildActionTelemetry;
}

function toRuntimeBuildActionWorkerSummary(worker: Creep): RuntimeBuildActionWorkerSummary | null {
  const telemetry = worker.memory?.buildActionTelemetry;
  if (!telemetry?.resultCounts) {
    return null;
  }

  const resultCounts = normalizeBuildActionResultCounts(telemetry.resultCounts);
  const actionCount = sumBuildActionResultCounts(resultCounts);
  if (actionCount <= 0) {
    return null;
  }

  const buildFailCount = sumBuildFailureResultCounts(resultCounts);
  return {
    ...(getCreepName(worker) ? { name: getCreepName(worker) } : {}),
    buildActionResult: isBuildActionResult(telemetry.lastResult)
      ? telemetry.lastResult
      : selectDominantBuildActionResult(resultCounts),
    actionCount,
    buildFailCount,
    suppressedCount: resultCounts.suppressed_by_policy,
    resultCounts,
    ...(normalizeTargetId(telemetry.lastTargetId) ? { lastTargetId: normalizeTargetId(telemetry.lastTargetId) } : {}),
    ...(isFiniteNumber(telemetry.lastTick) ? { lastTick: Math.floor(telemetry.lastTick) } : {})
  };
}

function normalizeBuildActionResultCounts(
  resultCounts: Partial<Record<WorkerBuildActionResult, number>>
): RuntimeBuildActionResultCounts {
  const normalized = createEmptyBuildActionResultCounts();
  for (const result of BUILD_ACTION_RESULT_KEYS) {
    normalized[result] = getNonNegativeCounter(resultCounts[result]);
  }
  return normalized;
}

function createEmptyBuildActionResultCounts(): RuntimeBuildActionResultCounts {
  return {
    succeeded: 0,
    failed_no_energy: 0,
    failed_no_work: 0,
    failed_no_path: 0,
    failed_site_invalid: 0,
    suppressed_by_policy: 0
  };
}

function mergeBuildActionResultCounts(
  totals: RuntimeBuildActionResultCounts,
  resultCounts: RuntimeBuildActionResultCounts
): RuntimeBuildActionResultCounts {
  for (const result of BUILD_ACTION_RESULT_KEYS) {
    totals[result] += resultCounts[result];
  }
  return totals;
}

function sumBuildActionResultCounts(resultCounts: RuntimeBuildActionResultCounts): number {
  return BUILD_ACTION_RESULT_KEYS.reduce((total, result) => total + resultCounts[result], 0);
}

function sumBuildFailureResultCounts(resultCounts: RuntimeBuildActionResultCounts): number {
  return BUILD_ACTION_RESULT_KEYS.reduce(
    (total, result) => total + (BUILD_ACTION_FAILURE_RESULTS.has(result) ? resultCounts[result] : 0),
    0
  );
}

function selectDominantBuildActionResult(resultCounts: RuntimeBuildActionResultCounts): WorkerBuildActionResult {
  return BUILD_ACTION_RESULT_KEYS.reduce((dominant, result) =>
    resultCounts[result] > resultCounts[dominant] ? result : dominant
  );
}

function compareRuntimeBuildActionWorkerSummaries(
  left: RuntimeBuildActionWorkerSummary,
  right: RuntimeBuildActionWorkerSummary
): number {
  return (
    right.buildFailCount - left.buildFailCount ||
    right.actionCount - left.actionCount ||
    left.buildActionResult.localeCompare(right.buildActionResult) ||
    (left.name ?? '').localeCompare(right.name ?? '')
  );
}

function isBuildActionResult(value: unknown): value is WorkerBuildActionResult {
  return typeof value === 'string' && BUILD_ACTION_RESULT_KEYS.includes(value as WorkerBuildActionResult);
}

function getNonNegativeCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getCreepName(creep: Creep): string | undefined {
  const name = (creep as Creep & { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function normalizeTargetId(targetId: unknown): string | undefined {
  return typeof targetId === 'string' && targetId.length > 0 ? targetId : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function getGameTime(): number | null {
  const gameTime = (globalThis as unknown as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? Math.max(0, Math.floor(gameTime)) : null;
}
