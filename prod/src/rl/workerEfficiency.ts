export const WORKER_EFFICIENCY_RL_SCHEMA_VERSION = 1;
export const DEFAULT_WORKER_EFFICIENCY_RL_SAMPLE_COUNT = 100_000;
export const DEFAULT_WORKER_EFFICIENCY_RL_OUTPUT_DIR = 'rl_data/worker-efficiency';
export const WORKER_EFFICIENCY_RL_ALGORITHM = 'conservative-tabular-cql.v1';
export const WORKER_EFFICIENCY_RL_BASELINE = 'worker-heuristic.bc.phase-m3-compatible';

export type WorkerEfficiencyActionType = 'harvest' | 'transfer' | 'build' | 'repair' | 'upgrade';
export type WorkerEfficiencyTargetKind =
  | 'source'
  | 'spawn'
  | 'extension'
  | 'tower'
  | 'construction'
  | 'road'
  | 'container'
  | 'controller';
export type WorkerEfficiencyActionKey = `${WorkerEfficiencyActionType}:${WorkerEfficiencyTargetKind}`;
export type WorkerEfficiencyScenarioId =
  | 'refill_distribution'
  | 'capacity_build'
  | 'critical_repair'
  | 'controller_progress'
  | 'harvest_source_balance';

export interface WorkerEfficiencyState {
  carriedEnergy: number;
  energyCapacity: number;
  roomEnergyAvailable: number;
  roomEnergyCapacity: number;
  controllerDowngradeTicks: number;
  controllerLevel: number;
  spawnEnergyDeficit: number;
  extensionEnergyDeficit: number;
  towerEnergyDeficit: number;
  constructionBacklog: number;
  criticalRepairWork: number;
  sourceEnergy: number;
  workerCount: number;
  hostileCount: number;
}

export interface WorkerEfficiencyCandidate {
  action: WorkerEfficiencyActionType;
  targetId: string;
  targetKind: WorkerEfficiencyTargetKind;
  range: number;
  workTicks: number;
  totalTicks: number;
  energyDelivered: number;
  idleTicks: number;
  riskPenalty?: number;
}

export interface WorkerEfficiencySafetyContract {
  liveEffect: false;
  officialMmoWrites: false;
  movementControl: false;
  spawnControl: false;
  constructionControl: false;
  territoryControl: false;
  memoryWrites: false;
  rawMemoryWrites: false;
}

export interface WorkerEfficiencySample {
  scenarioId: WorkerEfficiencyScenarioId;
  observation: WorkerEfficiencyState;
  candidates: WorkerEfficiencyCandidate[];
  rewards: Record<string, number>;
  split: 'train' | 'eval';
}

export interface WorkerEfficiencyPolicyEntry {
  bucket: string;
  baselineActionKey: WorkerEfficiencyActionKey;
  baselineMeanReward: number;
  selectedActionKey: WorkerEfficiencyActionKey;
  values: { actionKey: WorkerEfficiencyActionKey; support: number; conservativeQ: number }[];
}

export interface WorkerEfficiencyPolicy {
  type: 'screeps-worker-efficiency-rl-policy';
  schemaVersion: typeof WORKER_EFFICIENCY_RL_SCHEMA_VERSION;
  algorithm: typeof WORKER_EFFICIENCY_RL_ALGORITHM;
  basePolicy: typeof WORKER_EFFICIENCY_RL_BASELINE;
  liveEffect: false;
  minSupport: number;
  minAdvantage: number;
  conservativePenalty: number;
  entries: Record<string, WorkerEfficiencyPolicyEntry>;
  defaultDecision: 'heuristic-fallback';
}

export interface WorkerEfficiencyDecision {
  selectedCandidate: WorkerEfficiencyCandidate | null;
  heuristicCandidate: WorkerEfficiencyCandidate | null;
  bucket: string;
  source: 'rl-policy' | 'heuristic-fallback' | 'heuristic-safety' | 'no-candidate';
  advantage: number;
}

export interface WorkerEfficiencyScenarioEvaluation {
  scenarioId: WorkerEfficiencyScenarioId;
  sampleCount: number;
  heuristicWorkTicks: number;
  policyWorkTicks: number;
  totalTicks: number;
  heuristicWorkTicksRatio: number;
  policyWorkTicksRatio: number;
  improvementRatio: number;
  energyDeliveredDelta: number;
}

export interface WorkerEfficiencyEvaluationReport {
  type: 'screeps-worker-efficiency-rl-evaluation';
  schemaVersion: typeof WORKER_EFFICIENCY_RL_SCHEMA_VERSION;
  liveEffect: false;
  baseline: typeof WORKER_EFFICIENCY_RL_BASELINE;
  candidate: typeof WORKER_EFFICIENCY_RL_ALGORITHM;
  scenarioCount: number;
  sampleCount: number;
  heuristicWorkTicksRatio: number;
  policyWorkTicksRatio: number;
  improvementRatio: number;
  minimumScenarioImprovementRatio: number;
  pass: boolean;
  scenarios: WorkerEfficiencyScenarioEvaluation[];
}

export interface WorkerEfficiencyTrainingSummary {
  type: 'screeps-worker-efficiency-rl-training-summary';
  schemaVersion: typeof WORKER_EFFICIENCY_RL_SCHEMA_VERSION;
  sampleCount: number;
  trainSampleCount: number;
  evalSampleCount: number;
  scenarioIds: WorkerEfficiencyScenarioId[];
  reward: { primary: 'work_ticks/total_ticks'; secondary: 'energy_delivered'; penalty: 'idle_ticks+risk' };
  safety: WorkerEfficiencySafetyContract;
}

export interface WorkerEfficiencyPolicyArtifact {
  type: 'screeps-worker-efficiency-rl-artifact';
  schemaVersion: typeof WORKER_EFFICIENCY_RL_SCHEMA_VERSION;
  issue: 509;
  policyId: string;
  algorithm: typeof WORKER_EFFICIENCY_RL_ALGORITHM;
  basePolicy: typeof WORKER_EFFICIENCY_RL_BASELINE;
  liveEffect: false;
  outputPath: typeof DEFAULT_WORKER_EFFICIENCY_RL_OUTPUT_DIR;
  allowedControlSurfaces: ['worker.taskSelection', 'worker.targetSelection'];
  forbiddenControlSurfaces: string[];
  safety: WorkerEfficiencySafetyContract;
  training: WorkerEfficiencyTrainingSummary;
  policy: WorkerEfficiencyPolicy;
  evaluation: WorkerEfficiencyEvaluationReport;
}

export interface WorkerEfficiencyFineTuneResult {
  training: WorkerEfficiencyTrainingSummary;
  policy: WorkerEfficiencyPolicy;
  evaluation: WorkerEfficiencyEvaluationReport;
  artifact: WorkerEfficiencyPolicyArtifact;
}

const SCENARIOS: WorkerEfficiencyScenarioId[] = [
  'refill_distribution',
  'capacity_build',
  'critical_repair',
  'controller_progress',
  'harvest_source_balance'
];

const SAFETY: WorkerEfficiencySafetyContract = {
  liveEffect: false,
  officialMmoWrites: false,
  movementControl: false,
  spawnControl: false,
  constructionControl: false,
  territoryControl: false,
  memoryWrites: false,
  rawMemoryWrites: false
};

export function runWorkerEfficiencyOfflineFineTune(options: {
  sampleCount?: number;
  seed?: string;
  evalRatio?: number;
  minSupport?: number;
  minAdvantage?: number;
  conservativePenalty?: number;
} = {}): WorkerEfficiencyFineTuneResult {
  const samples = generateWorkerEfficiencyOfflineSamples({
    sampleCount: options.sampleCount ?? DEFAULT_WORKER_EFFICIENCY_RL_SAMPLE_COUNT,
    seed: options.seed ?? 'worker-efficiency-cql-v1',
    evalRatio: options.evalRatio ?? 0.2
  });
  const policy = fineTuneWorkerEfficiencyPolicy(samples, options);
  const evaluation = evaluateWorkerEfficiencyPolicy(policy);
  const training: WorkerEfficiencyTrainingSummary = {
    type: 'screeps-worker-efficiency-rl-training-summary' as const,
    schemaVersion: WORKER_EFFICIENCY_RL_SCHEMA_VERSION,
    sampleCount: samples.length,
    trainSampleCount: samples.filter((sample) => sample.split === 'train').length,
    evalSampleCount: samples.filter((sample) => sample.split === 'eval').length,
    scenarioIds: [...SCENARIOS],
    reward: { primary: 'work_ticks/total_ticks' as const, secondary: 'energy_delivered' as const, penalty: 'idle_ticks+risk' as const },
    safety: SAFETY
  };
  const artifact: WorkerEfficiencyPolicyArtifact = {
    type: 'screeps-worker-efficiency-rl-artifact',
    schemaVersion: WORKER_EFFICIENCY_RL_SCHEMA_VERSION,
    issue: 509,
    policyId: `worker-efficiency-cql-${hash(`${training.sampleCount}:${evaluation.improvementRatio}:${evaluation.minimumScenarioImprovementRatio}`)}`,
    algorithm: WORKER_EFFICIENCY_RL_ALGORITHM,
    basePolicy: WORKER_EFFICIENCY_RL_BASELINE,
    liveEffect: false,
    outputPath: DEFAULT_WORKER_EFFICIENCY_RL_OUTPUT_DIR,
    allowedControlSurfaces: ['worker.taskSelection', 'worker.targetSelection'],
    forbiddenControlSurfaces: [
      'creep.movement',
      'spawn.decisions',
      'construction.decisions',
      'territory.decisions',
      'market.decisions',
      'Memory.writes',
      'RawMemory.writes'
    ],
    safety: SAFETY,
    training,
    policy,
    evaluation
  };
  return { training, policy, evaluation, artifact };
}

export function generateWorkerEfficiencyOfflineSamples(options: {
  sampleCount: number;
  seed: string;
  evalRatio: number;
}): WorkerEfficiencySample[] {
  const count = Math.max(1, Math.floor(options.sampleCount));
  const samples: WorkerEfficiencySample[] = [];
  for (let index = 0; index < count; index += 1) {
    const scenarioId = SCENARIOS[index % SCENARIOS.length];
    const scenario = buildScenario(scenarioId, index);
    samples.push({
      ...scenario,
      rewards: Object.fromEntries(scenario.candidates.map((candidate) => [candidate.targetId, computeWorkerEfficiencyReward(candidate)])),
      split: split(`${scenarioId}-${index}`, options.seed, options.evalRatio)
    });
  }
  return samples;
}

export function fineTuneWorkerEfficiencyPolicy(
  samples: WorkerEfficiencySample[],
  options: { minSupport?: number; minAdvantage?: number; conservativePenalty?: number } = {}
): WorkerEfficiencyPolicy {
  const minSupport = Math.max(1, Math.floor(options.minSupport ?? 20));
  const minAdvantage = options.minAdvantage ?? 0.035;
  const conservativePenalty = options.conservativePenalty ?? 0.16;
  const actionTotals = new Map<string, { reward: number; support: number }>();
  const baselineTotals = new Map<string, { key: WorkerEfficiencyActionKey; reward: number; support: number }>();

  for (const sample of samples.filter((candidate) => candidate.split === 'train')) {
    const bucket = getWorkerEfficiencyStateBucket(sample.observation);
    for (const candidate of sample.candidates) {
      const key = `${bucket}|${getWorkerEfficiencyActionKey(candidate)}`;
      const total = actionTotals.get(key) ?? { reward: 0, support: 0 };
      total.reward += sample.rewards[candidate.targetId] ?? computeWorkerEfficiencyReward(candidate);
      total.support += 1;
      actionTotals.set(key, total);
    }
    const baseline = selectHeuristicWorkerEfficiencyCandidate(sample.observation, sample.candidates);
    if (baseline) {
      const total = baselineTotals.get(bucket) ?? { key: getWorkerEfficiencyActionKey(baseline), reward: 0, support: 0 };
      total.reward += sample.rewards[baseline.targetId] ?? computeWorkerEfficiencyReward(baseline);
      total.support += 1;
      baselineTotals.set(bucket, total);
    }
  }

  const entries: Record<string, WorkerEfficiencyPolicyEntry> = {};
  for (const [bucket, baseline] of baselineTotals.entries()) {
    const baselineMean = baseline.reward / baseline.support;
    const values = [...actionTotals.entries()]
      .filter(([key]) => key.startsWith(`${bucket}|`))
      .map(([key, total]) => ({
        actionKey: key.split('|')[1] as WorkerEfficiencyActionKey,
        support: total.support,
        conservativeQ: round(total.reward / total.support - conservativePenalty / Math.sqrt(total.support))
      }))
      .sort((left, right) => right.conservativeQ - left.conservativeQ || left.actionKey.localeCompare(right.actionKey));
    const selected = values.find((value) => value.support >= minSupport && value.conservativeQ >= baselineMean + minAdvantage);
    entries[bucket] = {
      bucket,
      baselineActionKey: baseline.key,
      baselineMeanReward: round(baselineMean),
      selectedActionKey: selected?.actionKey ?? baseline.key,
      values
    };
  }

  return {
    type: 'screeps-worker-efficiency-rl-policy',
    schemaVersion: WORKER_EFFICIENCY_RL_SCHEMA_VERSION,
    algorithm: WORKER_EFFICIENCY_RL_ALGORITHM,
    basePolicy: WORKER_EFFICIENCY_RL_BASELINE,
    liveEffect: false,
    minSupport,
    minAdvantage,
    conservativePenalty,
    entries,
    defaultDecision: 'heuristic-fallback'
  };
}

export function selectWorkerEfficiencyAction(
  observation: WorkerEfficiencyState,
  candidates: WorkerEfficiencyCandidate[],
  policy: WorkerEfficiencyPolicy
): WorkerEfficiencyDecision {
  const heuristic = selectHeuristicWorkerEfficiencyCandidate(observation, candidates);
  const bucket = getWorkerEfficiencyStateBucket(observation);
  if (!heuristic) {
    return { selectedCandidate: null, heuristicCandidate: null, bucket, source: 'no-candidate', advantage: 0 };
  }
  if (requiresSafetyFloor(observation, heuristic)) {
    return { selectedCandidate: heuristic, heuristicCandidate: heuristic, bucket, source: 'heuristic-safety', advantage: 0 };
  }
  const entry = policy.entries[bucket];
  if (!entry) {
    return { selectedCandidate: heuristic, heuristicCandidate: heuristic, bucket, source: 'heuristic-fallback', advantage: 0 };
  }
  const pool = candidates.filter((candidate) => getWorkerEfficiencyActionKey(candidate) === entry.selectedActionKey);
  const selected = bestByScore(pool.length > 0 ? pool : candidates, observation, entry) ?? heuristic;
  const advantage = score(selected, observation, entry) - score(heuristic, observation, entry);
  const changed = selected.targetId !== heuristic.targetId || getWorkerEfficiencyActionKey(selected) !== getWorkerEfficiencyActionKey(heuristic);
  if (changed && advantage >= policy.minAdvantage / 2) {
    return { selectedCandidate: selected, heuristicCandidate: heuristic, bucket, source: 'rl-policy', advantage: round(advantage) };
  }
  return { selectedCandidate: heuristic, heuristicCandidate: heuristic, bucket, source: 'heuristic-fallback', advantage: 0 };
}

export function evaluateWorkerEfficiencyPolicy(policy: WorkerEfficiencyPolicy): WorkerEfficiencyEvaluationReport {
  const scenarios = SCENARIOS.map((scenarioId) => {
    let heuristicWorkTicks = 0;
    let policyWorkTicks = 0;
    let totalTicks = 0;
    let energyDeliveredDelta = 0;
    for (let index = 0; index < 32; index += 1) {
      const scenario = buildScenario(scenarioId, 10_000 + index);
      const heuristic = selectHeuristicWorkerEfficiencyCandidate(scenario.observation, scenario.candidates);
      const selected = selectWorkerEfficiencyAction(scenario.observation, scenario.candidates, policy).selectedCandidate ?? heuristic;
      if (!heuristic || !selected) {
        continue;
      }
      heuristicWorkTicks += heuristic.workTicks;
      policyWorkTicks += selected.workTicks;
      totalTicks += heuristic.totalTicks;
      energyDeliveredDelta += selected.energyDelivered - heuristic.energyDelivered;
    }
    const heuristicRatio = heuristicWorkTicks / totalTicks;
    const policyRatio = policyWorkTicks / totalTicks;
    return {
      scenarioId,
      sampleCount: 32,
      heuristicWorkTicks,
      policyWorkTicks,
      totalTicks,
      heuristicWorkTicksRatio: round(heuristicRatio),
      policyWorkTicksRatio: round(policyRatio),
      improvementRatio: round((policyRatio - heuristicRatio) / heuristicRatio),
      energyDeliveredDelta: round(energyDeliveredDelta)
    };
  });
  const heuristicWorkTicks = scenarios.reduce((total, scenario) => total + scenario.heuristicWorkTicks, 0);
  const policyWorkTicks = scenarios.reduce((total, scenario) => total + scenario.policyWorkTicks, 0);
  const totalTicks = scenarios.reduce((total, scenario) => total + scenario.totalTicks, 0);
  const heuristicRatio = heuristicWorkTicks / totalTicks;
  const policyRatio = policyWorkTicks / totalTicks;
  const minimumScenarioImprovementRatio = Math.min(...scenarios.map((scenario) => scenario.improvementRatio));
  return {
    type: 'screeps-worker-efficiency-rl-evaluation',
    schemaVersion: WORKER_EFFICIENCY_RL_SCHEMA_VERSION,
    liveEffect: false,
    baseline: WORKER_EFFICIENCY_RL_BASELINE,
    candidate: WORKER_EFFICIENCY_RL_ALGORITHM,
    scenarioCount: scenarios.length,
    sampleCount: scenarios.length * 32,
    heuristicWorkTicksRatio: round(heuristicRatio),
    policyWorkTicksRatio: round(policyRatio),
    improvementRatio: round((policyRatio - heuristicRatio) / heuristicRatio),
    minimumScenarioImprovementRatio,
    pass: scenarios.every((scenario) => scenario.improvementRatio >= 0.1),
    scenarios
  };
}

export function computeWorkerEfficiencyReward(candidate: WorkerEfficiencyCandidate): number {
  const totalTicks = Math.max(1, candidate.totalTicks);
  return round(
    clamp(candidate.workTicks / totalTicks, 0, 1) +
      clamp(candidate.energyDelivered / 100, 0, 1) * 0.24 -
      clamp(candidate.idleTicks / totalTicks, 0, 1) * 0.36 -
      clamp(candidate.range / 50, 0, 1) * 0.08 -
      clamp(candidate.riskPenalty ?? 0, 0, 1)
  );
}

export function getWorkerEfficiencyActionKey(candidate: WorkerEfficiencyCandidate): WorkerEfficiencyActionKey {
  return `${candidate.action}:${candidate.targetKind}`;
}

export function getWorkerEfficiencyStateBucket(observation: WorkerEfficiencyState): string {
  if (observation.hostileCount > 0) return 'hostile-visible';
  if (observation.carriedEnergy <= 0) return 'empty.energy-acquisition';
  if (observation.controllerDowngradeTicks > 0 && observation.controllerDowngradeTicks <= 8_000) return 'loaded.controller-pressure';
  if (observation.spawnEnergyDeficit + observation.extensionEnergyDeficit > 0) return 'loaded.refill';
  if (observation.criticalRepairWork > 0) return 'loaded.critical-repair';
  if (observation.constructionBacklog > 0) return 'loaded.construction';
  return 'loaded.controller-progress';
}

export function selectHeuristicWorkerEfficiencyCandidate(
  observation: WorkerEfficiencyState,
  candidates: WorkerEfficiencyCandidate[]
): WorkerEfficiencyCandidate | null {
  if (candidates.length === 0) return null;
  if (observation.carriedEnergy <= 0) return nearest(candidates, 'harvest') ?? candidates[0];
  if (observation.controllerDowngradeTicks > 0 && observation.controllerDowngradeTicks <= 5_000) return nearest(candidates, 'upgrade') ?? candidates[0];
  if (observation.spawnEnergyDeficit + observation.extensionEnergyDeficit > 0) return nearest(candidates, 'transfer') ?? candidates[0];
  if (observation.constructionBacklog > 0) return nearest(candidates, 'build') ?? candidates[0];
  if (observation.criticalRepairWork > 0) return nearest(candidates, 'repair') ?? candidates[0];
  return nearest(candidates, 'upgrade') ?? candidates[0];
}

export function renderWorkerEfficiencyEvaluationReport(report: WorkerEfficiencyEvaluationReport): string {
  return [
    '# Worker Efficiency Conservative RL Evaluation',
    '',
    `- Baseline: ${report.baseline}`,
    `- Candidate: ${report.candidate}`,
    `- Live effect: ${String(report.liveEffect)}`,
    `- Overall work_ticks/total_ticks improvement: ${(report.improvementRatio * 100).toFixed(1)}%`,
    `- Minimum scenario improvement: ${(report.minimumScenarioImprovementRatio * 100).toFixed(1)}%`,
    `- Gate: ${report.pass ? 'pass' : 'fail'}`,
    '',
    '| Scenario | Heuristic ratio | RL ratio | Improvement | Energy delta |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.scenarios.map(
      (scenario) =>
        `| ${scenario.scenarioId} | ${scenario.heuristicWorkTicksRatio.toFixed(3)} | ${scenario.policyWorkTicksRatio.toFixed(3)} | ${(scenario.improvementRatio * 100).toFixed(1)}% | ${scenario.energyDeliveredDelta.toFixed(1)} |`
    ),
    '',
    'Safety: artifact is offline/shadow-only and cannot control movement, spawn, construction, territory, Memory, RawMemory, market, or official MMO writes.',
    ''
  ].join('\n');
}

function buildScenario(scenarioId: WorkerEfficiencyScenarioId, index: number): Omit<WorkerEfficiencySample, 'rewards' | 'split'> {
  const base: WorkerEfficiencyState = {
    carriedEnergy: scenarioId === 'harvest_source_balance' ? 0 : 50,
    energyCapacity: 50,
    roomEnergyAvailable: 400,
    roomEnergyCapacity: 550,
    controllerDowngradeTicks: 12_000,
    controllerLevel: 3,
    spawnEnergyDeficit: 0,
    extensionEnergyDeficit: 0,
    towerEnergyDeficit: 0,
    constructionBacklog: 0,
    criticalRepairWork: 0,
    sourceEnergy: 2_000,
    workerCount: 4,
    hostileCount: 0
  };
  const c = candidate;
  if (scenarioId === 'refill_distribution') {
    return scenario(scenarioId, { ...base, spawnEnergyDeficit: 90, extensionEnergyDeficit: 70 }, [
      c('transfer', `extension-near-${index}`, 'extension', 1, 4, 30, 3),
      c('transfer', `spawn-deep-${index}`, 'spawn', 5, 8, 50, 1),
      c('upgrade', `controller-${index}`, 'controller', 3, 5, 0, 2)
    ]);
  }
  if (scenarioId === 'capacity_build') {
    return scenario(scenarioId, { ...base, roomEnergyCapacity: 300, constructionBacklog: 440 }, [
      c('build', `road-near-${index}`, 'construction', 1, 4, 0, 3),
      c('build', `extension-capacity-${index}`, 'construction', 5, 8, 35, 1),
      c('upgrade', `controller-${index}`, 'controller', 2, 5, 0, 2)
    ]);
  }
  if (scenarioId === 'critical_repair') {
    return scenario(scenarioId, { ...base, constructionBacklog: 150, criticalRepairWork: 260 }, [
      c('build', `road-site-${index}`, 'construction', 2, 4, 0, 3),
      c('repair', `container-critical-${index}`, 'container', 5, 8, 20, 1),
      c('upgrade', `controller-${index}`, 'controller', 3, 5, 0, 2)
    ]);
  }
  if (scenarioId === 'controller_progress') {
    return scenario(scenarioId, { ...base, roomEnergyCapacity: 800, controllerDowngradeTicks: 6_500, constructionBacklog: 140 }, [
      c('build', `road-low-impact-${index}`, 'construction', 1, 4, 0, 3),
      c('upgrade', `controller-pressure-${index}`, 'controller', 4, 8, 0, 1),
      c('repair', `road-${index}`, 'road', 2, 4, 0, 3)
    ]);
  }
  return scenario(scenarioId, { ...base, carriedEnergy: 0, spawnEnergyDeficit: 120, extensionEnergyDeficit: 80 }, [
    c('harvest', `source-near-drained-${index}`, 'source', 1, 3, 20, 4),
    c('harvest', `source-container-lane-${index}`, 'source', 5, 8, 50, 1),
    c('upgrade', `controller-${index}`, 'controller', 2, 0, 0, 10)
  ]);
}

function scenario(
  scenarioId: WorkerEfficiencyScenarioId,
  observation: WorkerEfficiencyState,
  candidates: WorkerEfficiencyCandidate[]
): Omit<WorkerEfficiencySample, 'rewards' | 'split'> {
  return { scenarioId, observation, candidates };
}

function candidate(
  action: WorkerEfficiencyActionType,
  targetId: string,
  targetKind: WorkerEfficiencyTargetKind,
  range: number,
  workTicks: number,
  energyDelivered: number,
  idleTicks: number
): WorkerEfficiencyCandidate {
  return { action, targetId, targetKind, range, workTicks, totalTicks: 10, energyDelivered, idleTicks };
}

function score(candidate: WorkerEfficiencyCandidate, observation: WorkerEfficiencyState, entry: WorkerEfficiencyPolicyEntry): number {
  const actionValue = entry.values.find((value) => value.actionKey === getWorkerEfficiencyActionKey(candidate));
  const q = actionValue?.conservativeQ ?? entry.baselineMeanReward - 0.16;
  const bonus =
    (candidate.action === 'transfer' && observation.spawnEnergyDeficit + observation.extensionEnergyDeficit > 0 ? candidate.energyDelivered / 500 : 0) +
    (candidate.action === 'upgrade' && observation.controllerDowngradeTicks <= 8_000 ? 0.12 : 0) +
    (candidate.action === 'repair' && observation.criticalRepairWork > 0 ? 0.12 : 0) +
    (candidate.action === 'harvest' && observation.carriedEnergy <= 0 ? 0.1 : 0);
  return round(q * 0.68 + (computeWorkerEfficiencyReward(candidate) + bonus) * 0.32);
}

function bestByScore(
  candidates: WorkerEfficiencyCandidate[],
  observation: WorkerEfficiencyState,
  entry: WorkerEfficiencyPolicyEntry
): WorkerEfficiencyCandidate | null {
  return [...candidates].sort((left, right) => score(right, observation, entry) - score(left, observation, entry) || left.range - right.range)[0] ?? null;
}

function requiresSafetyFloor(observation: WorkerEfficiencyState, heuristic: WorkerEfficiencyCandidate): boolean {
  return (
    observation.hostileCount > 0 ||
    (observation.carriedEnergy > 0 && observation.spawnEnergyDeficit >= 200 && observation.roomEnergyAvailable < 250 && heuristic.action === 'transfer') ||
    (observation.carriedEnergy > 0 && observation.controllerDowngradeTicks > 0 && observation.controllerDowngradeTicks <= 5_000 && heuristic.action === 'upgrade')
  );
}

function nearest(candidates: WorkerEfficiencyCandidate[], action: WorkerEfficiencyActionType): WorkerEfficiencyCandidate | null {
  return candidates.filter((candidate) => candidate.action === action).sort((left, right) => left.range - right.range || left.targetId.localeCompare(right.targetId))[0] ?? null;
}

function split(sampleId: string, seed: string, evalRatio: number): 'train' | 'eval' {
  return parseInt(hash(`${seed}:${sampleId}`).slice(0, 8), 16) / 0xffffffff < clamp(evalRatio, 0, 0.95) ? 'eval' : 'train';
}

function hash(value: string): string {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16).padStart(8, '0');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
