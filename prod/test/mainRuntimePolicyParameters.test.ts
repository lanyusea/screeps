import type { KernelRunOptions } from '../src/kernel/Kernel';
import type { KpiRegressionResult, KpiWindowHistory } from '../src/rl/kpiRolloutMonitor';
import type { StrategyRegistryEntry } from '../src/strategy/strategyRegistry';
import { DEFAULT_STRATEGY_REGISTRY } from '../src/strategy/strategyRegistry';
import {
  RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER,
  RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION,
  RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL,
  RUNTIME_POLICY_PARAMETERS_GLOBAL
} from '../src/strategy/runtimePolicyParameters';
import type { RuntimeSummary } from '../src/telemetry/runtimeSummary';

describe('main runtime policy parameter consumption', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    jest.resetModules();
    jest.dontMock('../src/kernel/Kernel');
    jest.dontMock('../src/rl/kpiRolloutMonitor');
    jest.dontMock('../src/rl/strategyRollback');
    jest.dontMock('../src/strategy/runtimePolicyParameters');
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL];
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL];
    delete (globalThis as { Memory?: unknown }).Memory;
    delete (globalThis as { Game?: unknown }).Game;
  });

  it('consumes a private-simulator payload that appears after module initialization', () => {
    installScreepsGlobals();
    const run = jest.fn((options: KernelRunOptions = {}) => {
      const entry = options.strategyRegistry?.find(
        (candidate) => candidate.id === 'construction-priority.incumbent.v1'
      );
      if (entry) {
        options.onStrategyRegistryRuntimeUse?.(entry);
      }
      return makeRuntimeSummary();
    });
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    installRuntimePolicyPayload();
    main?.loop();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeStrategyConstructionEnabled: true,
        strategyRegistry: expect.arrayContaining([
          expect.objectContaining({
            id: 'construction-priority.incumbent.v1',
            defaultValues: expect.objectContaining({ territorySignalWeight: 29 })
          })
        ])
      })
    );
    expect(
      (globalThis as { Memory?: { rlRuntimePolicyParameters?: unknown } }).Memory?.rlRuntimePolicyParameters
    ).toMatchObject({
      runtimeParameterInjection: true,
      consumed: true,
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      consumedStrategyVariantId: 'construction-priority.pg.territory-seed.v1',
      parametersSha256: 'runtime-use-sha',
      consumedParametersSha256: 'runtime-use-sha',
      appliedStrategyIds: ['construction-priority.incumbent.v1'],
      liveEffect: false,
      officialMmoWrites: false,
      officialMmoWritesAllowed: false,
      tick: 20
    });
  });

  it('records simulator tick consumption once the runtime registry applies the patched strategy', () => {
    installScreepsGlobals();
    const run = jest.fn((_options: KernelRunOptions = {}) => makeRuntimeSummary());
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    installRuntimePolicyPayload();
    main?.loop();

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeStrategyConstructionEnabled: true
      })
    );
    expect(
      (globalThis as { Memory?: { rlRuntimePolicyParameters?: unknown } }).Memory?.rlRuntimePolicyParameters
    ).toMatchObject({
      runtimeParameterInjection: true,
      consumed: true,
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      consumedStrategyVariantId: 'construction-priority.pg.territory-seed.v1',
      parametersSha256: 'runtime-use-sha',
      consumedParametersSha256: 'runtime-use-sha',
      appliedStrategyIds: ['construction-priority.incumbent.v1'],
      reason: 'runtime policy parameter payload was used by tick runtime strategy evaluation',
      liveEffect: false,
      officialMmoWrites: false,
      officialMmoWritesAllowed: false,
      tick: 20
    });
  });

  it('keeps runtime-injected registry patches ephemeral after the payload is removed', () => {
    installScreepsGlobals();
    const run = jest.fn((_options: KernelRunOptions = {}) => makeRuntimeSummary());
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    installRuntimePolicyPayload({ sourceStrategyId: 'construction-priority.territory-shadow.v1' });
    main?.loop();

    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL];
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 21;
    main?.loop();

    const firstTickOptions = run.mock.calls[0]?.[0];
    const secondTickOptions = run.mock.calls[1]?.[0];
    const firstTickIncumbent = firstTickOptions?.strategyRegistry?.find(
      (candidate) => candidate.id === 'construction-priority.incumbent.v1'
    );
    const firstTickShadowCandidate = firstTickOptions?.strategyRegistry?.find(
      (candidate) => candidate.id === 'construction-priority.territory-shadow.v1'
    );
    const secondTickIncumbent = secondTickOptions?.strategyRegistry?.find(
      (candidate) => candidate.id === 'construction-priority.incumbent.v1'
    );
    const secondTickShadowCandidate = secondTickOptions?.strategyRegistry?.find(
      (candidate) => candidate.id === 'construction-priority.territory-shadow.v1'
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(firstTickIncumbent).toMatchObject({
      rolloutStatus: 'shadow',
      defaultValues: expect.objectContaining({ territorySignalWeight: 6 })
    });
    expect(firstTickShadowCandidate).toMatchObject({
      rolloutStatus: 'incumbent',
      defaultValues: expect.objectContaining({ territorySignalWeight: 29 })
    });
    expect(secondTickOptions).not.toHaveProperty('runtimeStrategyConstructionEnabled');
    expect(secondTickIncumbent).toMatchObject({
      rolloutStatus: 'incumbent',
      defaultValues: expect.objectContaining({ territorySignalWeight: 6 })
    });
    expect(secondTickShadowCandidate).toMatchObject({
      rolloutStatus: 'shadow',
      defaultValues: expect.objectContaining({ territorySignalWeight: 22 })
    });
  });

  it('records runtime use when patched strategy ids exist without enabling runtime planning', () => {
    installScreepsGlobals();
    const sourceEntry = DEFAULT_STRATEGY_REGISTRY.find(
      (candidate) => candidate.id === 'construction-priority.incumbent.v1'
    );
    expect(sourceEntry).toBeDefined();
    const patchedEntry: StrategyRegistryEntry = {
      ...sourceEntry!,
      defaultValues: {
        ...sourceEntry!.defaultValues,
        territorySignalWeight: 29
      }
    };
    const registry = [patchedEntry];
    let consumed = false;
    const recordStrategyRuntimeUse = jest.fn((entry: StrategyRegistryEntry) => {
      consumed = entry.id === patchedEntry.id;
    });
    const buildEvidence = jest.fn(() => ({
      type: 'screeps-rl-runtime-policy-parameter-consumption' as const,
      consumerMarker: RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER,
      consumerVersion: RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION,
      runtimeParameterInjection: false,
      consumed,
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      family: 'construction-priority',
      parameters: { territorySignalWeight: 29 },
      parametersSha256: 'flagless-runtime-use-sha',
      ...(consumed
        ? {
            consumedStrategyVariantId: 'construction-priority.pg.territory-seed.v1',
            consumedParametersSha256: 'flagless-runtime-use-sha'
          }
        : {}),
      appliedStrategyIds: consumed ? [patchedEntry.id] : [],
      reason: consumed
        ? 'runtime policy parameter payload was used by tick runtime strategy evaluation'
        : 'runtime policy parameter payload was not used by tick runtime strategy evaluation',
      liveEffect: false as const,
      officialMmoWrites: false as const,
      officialMmoWritesAllowed: false as const
    }));
    const persistRuntimePolicyParameterConsumptionEvidence = jest.fn();
    jest.doMock('../src/strategy/runtimePolicyParameters', () => {
      const actual = jest.requireActual<typeof import('../src/strategy/runtimePolicyParameters')>(
        '../src/strategy/runtimePolicyParameters'
      );
      return {
        ...actual,
        applyRuntimePolicyParametersToRegistry: jest.fn(() => ({
          registry,
          evidence: {
            type: 'screeps-rl-runtime-policy-parameter-consumption',
            consumerMarker: RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER,
            consumerVersion: RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION,
            runtimeParameterInjection: false,
            consumed: false,
            strategyVariantId: 'construction-priority.pg.territory-seed.v1',
            candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
            family: 'construction-priority',
            parameters: { territorySignalWeight: 29 },
            parametersSha256: 'flagless-runtime-use-sha',
            appliedStrategyIds: [patchedEntry.id],
            reason: 'runtime policy parameter payload matched registry entries; awaiting tick runtime strategy evaluation',
            liveEffect: false,
            officialMmoWrites: false,
            officialMmoWritesAllowed: false
          }
        })),
        createRuntimePolicyParameterConsumptionRecorder: jest.fn(() => ({
          recordStrategyRuntimeUse,
          buildEvidence
        })),
        persistRuntimePolicyParameterConsumptionEvidence
      };
    });
    const run = jest.fn((options: KernelRunOptions = {}) => {
      const entry = options.strategyRegistry?.find((candidate) => candidate.id === patchedEntry.id);
      if (entry) {
        options.onStrategyRegistryRuntimeUse?.(entry);
      }
      return makeRuntimeSummary();
    });
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    main?.loop();

    const options = run.mock.calls[0]?.[0];
    expect(options).not.toHaveProperty('runtimeStrategyConstructionEnabled');
    expect(options?.onStrategyRegistryRuntimeUse).toBe(recordStrategyRuntimeUse);
    expect(recordStrategyRuntimeUse).toHaveBeenCalledWith(patchedEntry);
    expect(persistRuntimePolicyParameterConsumptionEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeParameterInjection: false,
        consumed: true,
        appliedStrategyIds: [patchedEntry.id],
        consumedParametersSha256: 'flagless-runtime-use-sha'
      })
    );
  });

  it('uses a post-kernel CPU sample for the rollout monitoring gate', () => {
    installScreepsGlobals();
    const getUsed = jest.fn().mockReturnValueOnce(1).mockReturnValue(71);
    (globalThis as unknown as { Game: Partial<Game> }).Game.cpu = {
      getUsed,
      limit: 70,
      bucket: 9_000,
      tickLimit: 500
    } as unknown as CPU;
    const run = jest.fn((_options: KernelRunOptions = {}) => {
      getUsed();
      return makeRuntimeSummary();
    });
    const checkKpiRegression = makeCheckKpiRegressionMock();
    jest.doMock('../src/rl/kpiRolloutMonitor', () => {
      const actual = jest.requireActual<typeof import('../src/rl/kpiRolloutMonitor')>(
        '../src/rl/kpiRolloutMonitor'
      );
      return {
        ...actual,
        checkKpiRegression
      };
    });
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    main?.loop();

    expect(run).toHaveBeenCalledTimes(1);
    expect(getUsed).toHaveBeenCalledTimes(2);
    expect(checkKpiRegression).not.toHaveBeenCalled();
  });

  it('does not monitor passive shadow strategies when no runtime policy was consumed', () => {
    installScreepsGlobals();
    const run = jest.fn((_options: KernelRunOptions = {}) => makeRuntimeSummary());
    const checkKpiRegression = makeCheckKpiRegressionMock();
    const applyPendingRollbacks = jest.fn((registry: StrategyRegistryEntry[]) => registry);
    jest.doMock('../src/rl/strategyRollback', () => {
      const actual = jest.requireActual<typeof import('../src/rl/strategyRollback')>(
        '../src/rl/strategyRollback'
      );
      return {
        ...actual,
        applyPendingRollbacks
      };
    });
    jest.doMock('../src/rl/kpiRolloutMonitor', () => {
      const actual = jest.requireActual<typeof import('../src/rl/kpiRolloutMonitor')>(
        '../src/rl/kpiRolloutMonitor'
      );
      return {
        ...actual,
        checkKpiRegression
      };
    });
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    main?.loop();

    expect(run).toHaveBeenCalledTimes(1);
    expect(applyPendingRollbacks).toHaveBeenCalledTimes(1);
    expect(checkKpiRegression).not.toHaveBeenCalled();
  });

  it('monitors only the strategy family whose runtime policy was consumed', () => {
    installScreepsGlobals();
    const run = jest.fn((options: KernelRunOptions = {}) => {
      const entry = options.strategyRegistry?.find(
        (candidate) => candidate.id === 'construction-priority.incumbent.v1'
      );
      if (entry) {
        options.onStrategyRegistryRuntimeUse?.(entry);
      }
      return makeRuntimeSummary();
    });
    const checkKpiRegression = makeCheckKpiRegressionMock();
    jest.doMock('../src/rl/kpiRolloutMonitor', () => {
      const actual = jest.requireActual<typeof import('../src/rl/kpiRolloutMonitor')>(
        '../src/rl/kpiRolloutMonitor'
      );
      return {
        ...actual,
        checkKpiRegression
      };
    });
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    installRuntimePolicyPayload();
    main?.loop();

    expect(run).toHaveBeenCalledTimes(1);
    expect(checkKpiRegression).toHaveBeenCalledTimes(1);
    const recentWindows = checkKpiRegression.mock.calls[0][0];
    expect(Object.keys(recentWindows)).toEqual(['construction-priority']);
  });

  it('does not monitor or roll back passive applied families outside consumed evidence', () => {
    installScreepsGlobals();
    const appliedStrategyIds = [
      'construction-priority.territory-shadow.v1',
      'expansion-remote.territory-shadow.v1'
    ];
    const runtimePolicyEvidence = {
      type: 'screeps-rl-runtime-policy-parameter-consumption' as const,
      consumerMarker: RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER,
      consumerVersion: RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION,
      runtimeParameterInjection: true,
      consumed: true,
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      family: 'construction-priority',
      parameters: { territorySignalWeight: 29 },
      parametersSha256: 'runtime-use-sha',
      consumedStrategyVariantId: 'construction-priority.pg.territory-seed.v1',
      consumedParametersSha256: 'runtime-use-sha',
      appliedStrategyIds,
      reason: 'runtime policy parameter payload was used by tick runtime strategy evaluation',
      liveEffect: false as const,
      officialMmoWrites: false as const,
      officialMmoWritesAllowed: false as const
    };
    const recordStrategyRuntimeUse = jest.fn();
    const buildEvidence = jest.fn(() => runtimePolicyEvidence);
    const persistRuntimePolicyParameterConsumptionEvidence = jest.fn();
    jest.doMock('../src/strategy/runtimePolicyParameters', () => {
      const actual = jest.requireActual<typeof import('../src/strategy/runtimePolicyParameters')>(
        '../src/strategy/runtimePolicyParameters'
      );
      return {
        ...actual,
        applyRuntimePolicyParametersToRegistry: jest.fn(() => ({
          registry: DEFAULT_STRATEGY_REGISTRY,
          evidence: {
            ...runtimePolicyEvidence,
            consumed: false,
            reason: 'runtime policy parameter payload matched registry entries; awaiting tick runtime strategy evaluation'
          }
        })),
        createRuntimePolicyParameterConsumptionRecorder: jest.fn(() => ({
          recordStrategyRuntimeUse,
          buildEvidence
        })),
        persistRuntimePolicyParameterConsumptionEvidence
      };
    });
    const checkKpiRegression = jest.fn(
      (_recentWindows: KpiWindowHistory, _baselineWindows: KpiWindowHistory): KpiRegressionResult => ({
        regression: true,
        regressedFamilies: ['construction-priority', 'expansion-remote-candidate'],
        details: 'simulated regression',
        metrics: {}
      })
    );
    jest.doMock('../src/rl/kpiRolloutMonitor', () => {
      const actual = jest.requireActual<typeof import('../src/rl/kpiRolloutMonitor')>(
        '../src/rl/kpiRolloutMonitor'
      );
      return {
        ...actual,
        checkKpiRegression
      };
    });
    const applyPendingRollbacks = jest.fn((registry: StrategyRegistryEntry[]) => registry);
    const executeRollback = jest.fn((family: string, _registry: StrategyRegistryEntry[], reason: string) => ({
      executed: true,
      disabledId: `${family}.shadow`,
      rollbackToId: `${family}.incumbent`,
      reason
    }));
    jest.doMock('../src/rl/strategyRollback', () => {
      const actual = jest.requireActual<typeof import('../src/rl/strategyRollback')>(
        '../src/rl/strategyRollback'
      );
      return {
        ...actual,
        applyPendingRollbacks,
        executeRollback
      };
    });
    const run = jest.fn((_options: KernelRunOptions = {}) => makeRuntimeSummary());
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    main?.loop();

    expect(recordStrategyRuntimeUse).toHaveBeenCalledTimes(2);
    expect(checkKpiRegression).toHaveBeenCalledTimes(1);
    const recentWindows = checkKpiRegression.mock.calls[0][0];
    expect(Object.keys(recentWindows)).toEqual(['construction-priority']);
    expect(executeRollback).toHaveBeenCalledTimes(1);
    expect(executeRollback.mock.calls[0][0]).toBe('construction-priority');
  });

  it('does not execute stale rollback checks for an unconsumed family', () => {
    installScreepsGlobals();
    installRegressionBaselines();
    const run = jest.fn((options: KernelRunOptions = {}) => {
      const strategyId =
        (globalThis as unknown as { Game: Partial<Game> }).Game.time === 20
          ? 'construction-priority.incumbent.v1'
          : 'expansion-remote.incumbent.v1';
      const entry = options.strategyRegistry?.find((candidate) => candidate.id === strategyId);
      if (entry) {
        options.onStrategyRegistryRuntimeUse?.(entry);
      }

      return makeRuntimeSummary((globalThis as unknown as { Game: Partial<Game> }).Game.time);
    });
    jest.doMock('../src/rl/kpiRolloutMonitor', () => {
      const actual = jest.requireActual<typeof import('../src/rl/kpiRolloutMonitor')>(
        '../src/rl/kpiRolloutMonitor'
      );
      return {
        ...actual,
        DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG: {
          ...actual.DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG,
          minWindowSize: 1
        }
      };
    });
    mockKernel(run);
    let main: typeof import('../src/main') | undefined;
    jest.isolateModules(() => {
      main = jest.requireActual<typeof import('../src/main')>('../src/main');
    });

    installRuntimePolicyPayload();
    main?.loop();
    expect(Memory.strategyRollback?.['construction-priority']).toMatchObject({
      disabledId: 'construction-priority.territory-shadow.v1',
      rollbackToId: 'construction-priority.incumbent.v1',
      timestamp: 20
    });

    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 21;
    installExpansionRuntimePolicyPayload();
    main?.loop();
    expect(Memory.strategyRollbackHistory).toBeUndefined();

    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 22;
    installExpansionRuntimePolicyPayload();
    main?.loop();

    expect(run).toHaveBeenCalledTimes(3);
    expect(Memory.strategyRollbackHistory).toEqual([
      {
        family: 'expansion-remote-candidate',
        disabledId: 'expansion-remote.territory-shadow.v1',
        rollbackToId: 'expansion-remote.incumbent.v1',
        timestamp: 22,
        reason: expect.stringContaining('expansion-remote-candidate:territory')
      }
    ]);
    expect(Memory.strategyRollbackHistory?.[0]?.reason).not.toContain('construction-priority');
  });
});

function mockKernel(run: jest.Mock<RuntimeSummary, [KernelRunOptions?]>): void {
  jest.doMock('../src/kernel/Kernel', () => ({
    Kernel: jest.fn().mockImplementation(() => ({ run }))
  }));
}

function makeCheckKpiRegressionMock(): jest.Mock<KpiRegressionResult, [KpiWindowHistory, KpiWindowHistory]> {
  return jest.fn((_recentWindows: KpiWindowHistory, _baselineWindows: KpiWindowHistory) => ({
    regression: false,
    regressedFamilies: [],
    details: '',
    metrics: {}
  }));
}

function installScreepsGlobals(): void {
  (globalThis as unknown as { Memory: Memory }).Memory = {} as Memory;
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    creeps: {},
    rooms: {},
    spawns: {},
    time: 20
  };
}

function installRuntimePolicyPayload(overrides: Record<string, unknown> = {}): void {
  (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
    runtimeParameterInjection: true,
    candidateParameterScope: 'runtime_injected',
    strategyVariantId: 'construction-priority.pg.territory-seed.v1',
    candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
    sourceStrategyId: 'construction-priority.incumbent.v1',
    family: 'construction-priority',
    parameters: {
      baseScoreWeight: 1,
      territorySignalWeight: 29,
      resourceSignalWeight: 3,
      killSignalWeight: 5,
      riskPenalty: 4
    },
    parametersSha256: 'runtime-use-sha',
    ...overrides
  };
}

function installExpansionRuntimePolicyPayload(): void {
  installRuntimePolicyPayload({
    strategyVariantId: 'expansion-remote.incumbent.v1',
    candidatePolicyId: 'expansion-remote.incumbent.v1',
    sourceStrategyId: 'expansion-remote.incumbent.v1',
    family: 'expansion-remote-candidate',
    parameters: {
      baseScoreWeight: 1,
      territorySignalWeight: 31,
      resourceSignalWeight: 4,
      killSignalWeight: 2,
      riskPenalty: 10
    },
    parametersSha256: 'expansion-runtime-use-sha'
  });
}

function installRegressionBaselines(): void {
  Memory.kpiBaseline = {
    'construction-priority': {
      timestamp: 1,
      metrics: {
        reliability: 1,
        territory: 1_000,
        resources: 0,
        kills: 0
      }
    },
    'expansion-remote-candidate': {
      timestamp: 1,
      metrics: {
        reliability: 1,
        territory: 1_000,
        resources: 0,
        kills: 0
      }
    }
  };
}

function makeRuntimeSummary(tick = 20): RuntimeSummary {
  return {
    type: 'runtime-summary',
    tick,
    rooms: []
  };
}
