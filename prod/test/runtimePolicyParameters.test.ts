import {
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
  });

  it('applies private-simulator payload parameters to matching strategy entries', () => {
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
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
      consumed: true,
      family: 'construction-priority',
      parametersSha256: 'example-sha'
    });
    expect(constructionEntries.length).toBeGreaterThan(0);
    expect(constructionEntries.every((entry) => entry.defaultValues.territorySignalWeight === 29)).toBe(true);
    expect(
      (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL]
    ).toMatchObject(result.evidence);
    expect(
      DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.incumbent.v1')?.defaultValues
        .territorySignalWeight
    ).toBe(6);
  });

  it('preserves runtime-injected but non-consumed evidence for diagnostics', () => {
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
  });

  it('marks consumption only after a patched strategy entry is used during a tick', () => {
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
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
});
