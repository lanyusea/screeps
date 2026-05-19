import {
  RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL,
  RUNTIME_POLICY_PARAMETERS_GLOBAL,
  applyRuntimePolicyParametersToRegistry
} from '../src/strategy/runtimePolicyParameters';
import { DEFAULT_STRATEGY_REGISTRY } from '../src/strategy/strategyRegistry';

describe('runtime policy parameters', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL];
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL];
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
});
