import {
  RUNTIME_POLICY_PARAMETER_CONSUMPTION_LOG_PREFIX,
  RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL,
  RUNTIME_POLICY_PARAMETERS_GLOBAL,
  applyRuntimePolicyParametersToRegistry,
  createRuntimePolicyParameterConsumptionRecorder,
  persistRuntimePolicyParameterConsumptionEvidence
} from '../src/strategy/runtimePolicyParameters';
import { DEFAULT_STRATEGY_REGISTRY } from '../src/strategy/strategyRegistry';

describe('runtime policy parameters', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL];
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL];
    delete (globalThis as { Memory?: unknown }).Memory;
    delete (globalThis as { Game?: unknown }).Game;
  });

  it('applies private-simulator payload parameters to matching strategy entries', () => {
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      sourceStrategyId: 'construction-priority.territory-shadow.v1',
      family: 'construction-priority',
      parameters: {
        baseScoreWeight: 1,
        territorySignalWeight: 29,
        resourceSignalWeight: 3,
        killSignalWeight: 5,
        riskPenalty: 4
      },
      parametersSha256: 'example-sha'
    };

    const result = applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY);
    const constructionEntries = result.registry.filter((entry) => entry.family === 'construction-priority');

    expect(result.evidence).toMatchObject({
      runtimeParameterInjection: true,
      consumed: false,
      family: 'construction-priority',
      parametersSha256: 'example-sha',
      reason: 'runtime policy parameter payload matched registry entries; awaiting tick runtime strategy evaluation'
    });
    expect(result.evidence.appliedStrategyIds).toEqual(['construction-priority.territory-shadow.v1']);
    expect(constructionEntries.length).toBeGreaterThan(0);
    expect(
      constructionEntries.find((entry) => entry.id === 'construction-priority.territory-shadow.v1')
    ).toMatchObject({
      rolloutStatus: 'incumbent',
      defaultValues: expect.objectContaining({ territorySignalWeight: 29 })
    });
    expect(
      constructionEntries.find((entry) => entry.id === 'construction-priority.incumbent.v1')
    ).toMatchObject({
      rolloutStatus: 'shadow',
      defaultValues: expect.objectContaining({ territorySignalWeight: 6 })
    });
    expect(
      (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL]
    ).toMatchObject(result.evidence);
    expect(
      DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.incumbent.v1')?.defaultValues
        .territorySignalWeight
    ).toBe(6);
  });

  it('preserves runtime-injected but non-consumed evidence for diagnostics', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'unknown-policy.v1',
      candidatePolicyId: 'unknown-policy.v1',
      family: 'unknown-family',
      parameters: {
        territorySignalWeight: 31
      },
      parametersSha256: 'miss-sha'
    };

    try {
      const result = applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY);
      persistRuntimePolicyParameterConsumptionEvidence(result.evidence);

      expect(result.evidence).toMatchObject({
        runtimeParameterInjection: true,
        consumed: false,
        reason: 'runtime policy parameter payload did not match any strategy registry entry',
        parametersSha256: 'miss-sha'
      });
      expect(
        (globalThis as { Memory?: { rlRuntimePolicyParameters?: unknown } }).Memory?.rlRuntimePolicyParameters
      ).toMatchObject(result.evidence);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('does not fan out explicit candidate payloads to every family sibling', () => {
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.resource-seed.v1',
      candidatePolicyId: 'construction-priority.pg.resource-seed.v1',
      family: 'construction-priority',
      parameters: {
        territorySignalWeight: 2
      },
      parametersSha256: 'candidate-only-sha'
    };

    const result = applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY);
    const constructionEntries = result.registry.filter((entry) => entry.family === 'construction-priority');

    expect(result.evidence).toMatchObject({
      runtimeParameterInjection: true,
      consumed: false,
      reason: 'runtime policy parameter payload did not match any strategy registry entry'
    });
    expect(result.evidence.appliedStrategyIds).toEqual([]);
    expect(
      constructionEntries.every((entry) => entry.defaultValues.territorySignalWeight !== 2)
    ).toBe(true);
  });

  it('marks consumption only after a patched strategy entry is used during a tick', () => {
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
      parametersSha256: 'runtime-use-sha'
    };
    const patched = applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY).registry;
    const usedEntry = patched.find((entry) => entry.id === 'construction-priority.incumbent.v1');
    const recorder = createRuntimePolicyParameterConsumptionRecorder();

    expect(recorder.buildEvidence()).toMatchObject({
      runtimeParameterInjection: true,
      consumed: false,
      reason: 'runtime policy parameter payload was not used by tick runtime strategy evaluation'
    });

    expect(usedEntry).toBeDefined();
    recorder.recordStrategyRuntimeUse(usedEntry!);

    expect(recorder.buildEvidence()).toMatchObject({
      runtimeParameterInjection: true,
      consumed: true,
      parametersSha256: 'runtime-use-sha',
      appliedStrategyIds: ['construction-priority.incumbent.v1'],
      parameters: {
        territorySignalWeight: 29
      }
    });
  });

  it('does not mark consumption when the tick uses an unpatched registry entry', () => {
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      sourceStrategyId: 'construction-priority.incumbent.v1',
      family: 'construction-priority',
      parameters: {
        territorySignalWeight: 29
      },
      parametersSha256: 'runtime-use-sha'
    };
    const originalEntry = DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.incumbent.v1');
    const recorder = createRuntimePolicyParameterConsumptionRecorder();

    expect(originalEntry).toBeDefined();
    recorder.recordStrategyRuntimeUse(originalEntry!);

    expect(recorder.buildEvidence()).toMatchObject({
      runtimeParameterInjection: true,
      consumed: false,
      appliedStrategyIds: [],
      reason: 'runtime policy parameter payload was not used by tick runtime strategy evaluation'
    });
  });

  it('keeps consumed evidence sticky across ticks for the same injected payload', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      sourceStrategyId: 'construction-priority.incumbent.v1',
      family: 'construction-priority',
      parameters: {
        territorySignalWeight: 29
      },
      parametersSha256: 'runtime-use-sha'
    };
    try {
      const patched = applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY).registry;
      const usedEntry = patched.find((entry) => entry.id === 'construction-priority.incumbent.v1');
      const consumedRecorder = createRuntimePolicyParameterConsumptionRecorder();

      expect(usedEntry).toBeDefined();
      consumedRecorder.recordStrategyRuntimeUse(usedEntry!);
      (globalThis as { Game?: Partial<Game> }).Game = { time: 10 };
      persistRuntimePolicyParameterConsumptionEvidence(consumedRecorder.buildEvidence());

      const missingTickRecorder = createRuntimePolicyParameterConsumptionRecorder();
      (globalThis as { Game?: Partial<Game> }).Game = { time: 11 };
      persistRuntimePolicyParameterConsumptionEvidence(missingTickRecorder.buildEvidence());

      expect(
        (globalThis as { Memory?: { rlRuntimePolicyParameters?: unknown } }).Memory?.rlRuntimePolicyParameters
      ).toMatchObject({
        runtimeParameterInjection: true,
        consumed: true,
        parametersSha256: 'runtime-use-sha',
        appliedStrategyIds: ['construction-priority.incumbent.v1'],
        tick: 11
      });
      expect(
        (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL]
      ).toMatchObject({
        consumed: true,
        parametersSha256: 'runtime-use-sha',
        appliedStrategyIds: ['construction-priority.incumbent.v1']
      });

      (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
        runtimeParameterInjection: true,
        candidateParameterScope: 'runtime_injected',
        strategyVariantId: 'construction-priority.pg.territory-seed.v1',
        candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
        sourceStrategyId: 'construction-priority.incumbent.v1',
        family: 'construction-priority',
        parameters: {
          territorySignalWeight: 30
        },
        parametersSha256: 'runtime-use-sha-2'
      };
      (globalThis as { Game?: Partial<Game> }).Game = { time: 12 };
      persistRuntimePolicyParameterConsumptionEvidence(createRuntimePolicyParameterConsumptionRecorder().buildEvidence());

      expect(
        (globalThis as { Memory?: { rlRuntimePolicyParameters?: unknown } }).Memory?.rlRuntimePolicyParameters
      ).toMatchObject({
        runtimeParameterInjection: true,
        consumed: false,
        parametersSha256: 'runtime-use-sha-2',
        appliedStrategyIds: [],
        tick: 12
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('emits tick-time consumption evidence only for runtime-injected payloads', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      persistRuntimePolicyParameterConsumptionEvidence({
        type: 'screeps-rl-runtime-policy-parameter-consumption',
        consumerMarker: 'screeps-rl-runtime-policy-parameters-consumer-v1',
        runtimeParameterInjection: false,
        consumed: false,
        appliedStrategyIds: [],
        liveEffect: false,
        officialMmoWrites: false,
        officialMmoWritesAllowed: false
      });
      expect(logSpy).not.toHaveBeenCalled();

      const evidence = {
        type: 'screeps-rl-runtime-policy-parameter-consumption' as const,
        consumerMarker: 'screeps-rl-runtime-policy-parameters-consumer-v1' as const,
        runtimeParameterInjection: true,
        consumed: true,
        strategyVariantId: 'construction-priority.pg.territory-seed.v1',
        candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
        family: 'construction-priority',
        parameters: { territorySignalWeight: 29 },
        parametersSha256: 'runtime-use-sha',
        appliedStrategyIds: ['construction-priority.incumbent.v1'],
        liveEffect: false as const,
        officialMmoWrites: false as const,
        officialMmoWritesAllowed: false as const
      };

      persistRuntimePolicyParameterConsumptionEvidence(evidence);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = String(logSpy.mock.calls[0][0]);
      expect(line.startsWith(RUNTIME_POLICY_PARAMETER_CONSUMPTION_LOG_PREFIX)).toBe(true);
      expect(JSON.parse(line.slice(RUNTIME_POLICY_PARAMETER_CONSUMPTION_LOG_PREFIX.length))).toMatchObject(
        evidence
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
