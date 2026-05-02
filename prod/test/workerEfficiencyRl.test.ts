import {
  DEFAULT_WORKER_EFFICIENCY_RL_SAMPLE_COUNT,
  WORKER_EFFICIENCY_RL_ALGORITHM,
  fineTuneWorkerEfficiencyPolicy,
  runWorkerEfficiencyOfflineFineTune,
  selectWorkerEfficiencyAction,
  type WorkerEfficiencyCandidate,
  type WorkerEfficiencyFineTuneResult,
  type WorkerEfficiencyState
} from '../src/rl/workerEfficiency';

jest.setTimeout(20_000);

function baseLoadedObservation(overrides: Partial<WorkerEfficiencyState> = {}): WorkerEfficiencyState {
  return {
    carriedEnergy: 50,
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
    hostileCount: 0,
    ...overrides
  };
}

function candidate(
  action: WorkerEfficiencyCandidate['action'],
  targetId: string,
  targetKind: WorkerEfficiencyCandidate['targetKind'],
  range: number,
  workTicks: number,
  energyDelivered = 0
): WorkerEfficiencyCandidate {
  return {
    action,
    targetId,
    targetKind,
    range,
    workTicks,
    totalTicks: 10,
    energyDelivered,
    idleTicks: Math.max(0, 10 - workTicks)
  };
}

describe('worker efficiency conservative RL fine-tune', () => {
  let result: WorkerEfficiencyFineTuneResult;

  beforeAll(() => {
    result = runWorkerEfficiencyOfflineFineTune({
      sampleCount: DEFAULT_WORKER_EFFICIENCY_RL_SAMPLE_COUNT,
      seed: 'worker-efficiency-rl-test'
    });
  });

  it('produces a shadow-only artifact from 100000 reward-labeled samples', () => {
    expect(result.artifact.issue).toBe(509);
    expect(result.artifact.algorithm).toBe(WORKER_EFFICIENCY_RL_ALGORITHM);
    expect(result.training.sampleCount).toBeGreaterThanOrEqual(100_000);
    expect(result.training.scenarioIds).toHaveLength(5);
    expect(result.artifact.outputPath).toBe('rl_data/worker-efficiency');
    expect(result.artifact.liveEffect).toBe(false);
    expect(result.artifact.safety).toEqual({
      liveEffect: false,
      officialMmoWrites: false,
      movementControl: false,
      spawnControl: false,
      constructionControl: false,
      territoryControl: false,
      memoryWrites: false,
      rawMemoryWrites: false
    });
  });

  it('beats the heuristic work_ticks ratio by at least 10 percent in every evaluation scenario', () => {
    expect(result.evaluation.pass).toBe(true);
    expect(result.evaluation.scenarioCount).toBe(5);
    expect(result.evaluation.minimumScenarioImprovementRatio).toBeGreaterThanOrEqual(0.1);
    for (const scenario of result.evaluation.scenarios) {
      expect(scenario.policyWorkTicksRatio).toBeGreaterThan(scenario.heuristicWorkTicksRatio);
      expect(scenario.improvementRatio).toBeGreaterThanOrEqual(0.1);
    }
  });

  it('keeps spawn recovery and controller downgrade guard on heuristic safety floors', () => {
    const emergencySpawnObservation = baseLoadedObservation({
      roomEnergyAvailable: 120,
      spawnEnergyDeficit: 260,
      constructionBacklog: 300
    });
    const emergencySpawnDecision = selectWorkerEfficiencyAction(
      emergencySpawnObservation,
      [
        candidate('transfer', 'spawn-emergency', 'spawn', 2, 7, 50),
        candidate('build', 'extension-site', 'construction', 4, 9, 35)
      ],
      result.policy
    );

    expect(emergencySpawnDecision.source).toBe('heuristic-safety');
    expect(emergencySpawnDecision.selectedCandidate?.targetId).toBe('spawn-emergency');

    const downgradeObservation = baseLoadedObservation({
      controllerDowngradeTicks: 3_000,
      constructionBacklog: 300
    });
    const downgradeDecision = selectWorkerEfficiencyAction(
      downgradeObservation,
      [
        candidate('upgrade', 'controller-guard', 'controller', 4, 7),
        candidate('build', 'high-impact-site', 'construction', 5, 9, 35)
      ],
      result.policy
    );

    expect(downgradeDecision.source).toBe('heuristic-safety');
    expect(downgradeDecision.selectedCandidate?.targetId).toBe('controller-guard');
  });

  it('can improve worker target selection without touching movement or spawn strategy', () => {
    const decision = selectWorkerEfficiencyAction(
      baseLoadedObservation({
        roomEnergyAvailable: 300,
        roomEnergyCapacity: 300,
        constructionBacklog: 450
      }),
      [
        candidate('build', 'near-road-site', 'construction', 1, 4),
        candidate('build', 'capacity-extension-site', 'construction', 5, 8, 35),
        candidate('upgrade', 'controller', 'controller', 2, 5)
      ],
      result.policy
    );

    expect(decision.source).toBe('rl-policy');
    expect(decision.selectedCandidate?.targetId).toBe('capacity-extension-site');
    expect(result.artifact.allowedControlSurfaces).toEqual(['worker.taskSelection', 'worker.targetSelection']);
    expect(result.artifact.forbiddenControlSurfaces).toContain('creep.movement');
    expect(result.artifact.forbiddenControlSurfaces).toContain('spawn.decisions');
  });

  it('falls back to the heuristic when conservative support is missing', () => {
    const unsupportedPolicy = fineTuneWorkerEfficiencyPolicy([], { minSupport: 5 });
    const decision = selectWorkerEfficiencyAction(
      baseLoadedObservation({ constructionBacklog: 100 }),
      [
        candidate('build', 'near-site', 'construction', 1, 4),
        candidate('upgrade', 'controller', 'controller', 2, 8)
      ],
      unsupportedPolicy
    );

    expect(decision.source).toBe('heuristic-fallback');
    expect(decision.selectedCandidate?.targetId).toBe('near-site');
  });
});
