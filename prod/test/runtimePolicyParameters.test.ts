import {
  RUNTIME_POLICY_PARAMETER_CONSUMPTION_LOG_PREFIX,
  RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL,
  RUNTIME_POLICY_PARAMETERS_GLOBAL,
  RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION,
  applyRuntimePolicyParametersToRegistry,
  createRuntimePolicyParameterConsumptionRecorder,
  persistRuntimePolicyParameterConsumptionEvidence,
  selectRuntimePolicyObjectiveActivationTarget,
  selectRuntimePolicyObjectiveDefenseTarget
} from '../src/strategy/runtimePolicyParameters';
import { DEFAULT_STRATEGY_REGISTRY } from '../src/strategy/strategyRegistry';

describe('runtime policy parameters', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL];
    delete (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL];
    delete (globalThis as Record<string, unknown>).self;
    delete (globalThis as { Memory?: unknown }).Memory;
    delete (globalThis as { Game?: unknown }).Game;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
  });

  function installRuntimeConstructionPriorityPayload(): void {
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      sourceStrategyId: 'construction-priority.incumbent.v1',
      family: 'construction-priority',
      parameters: {
        baseScoreWeight: 1,
        territorySignalWeight: 22,
        resourceSignalWeight: 3,
        killSignalWeight: 5,
        riskPenalty: 4
      },
      parametersSha256: 'runtime-objective-sha'
    };
  }

  function installRuntimeConstructionPriorityPayloadWithObjectiveTarget(): void {
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      sourceStrategyId: 'construction-priority.incumbent.v1',
      family: 'construction-priority',
      parameters: {
        baseScoreWeight: 1,
        territorySignalWeight: 22,
        resourceSignalWeight: 3,
        killSignalWeight: 5,
        riskPenalty: 4
      },
      parametersSha256: 'runtime-objective-sha',
      objectiveAnchorRoom: 'E0N0',
      objectiveTargetRoom: 'E1N0',
      objectiveHostileCreepCount: 2,
      objectiveHostileStructureCount: 1
    };
  }

  function installHostileFindGlobals(): void {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
  }

  function makeRuntimeRoom(roomName: string, hostileCreepCount = 0, hostileStructureCount = 0): Room {
    return {
      name: roomName,
      find: jest.fn((type: number) => {
        if (type === FIND_HOSTILE_CREEPS) {
          return Array.from({ length: hostileCreepCount }, (_, index) => ({ id: `${roomName}-hostile-${index}` }));
        }

        if (type === FIND_HOSTILE_STRUCTURES) {
          return Array.from({ length: hostileStructureCount }, (_, index) => ({
            id: `${roomName}-structure-${index}`
          }));
        }

        return [];
      })
    } as unknown as Room;
  }

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

  it('reads private-simulator payloads from alternate Screeps global roots', () => {
    (globalThis as Record<string, unknown>).self = {
      [RUNTIME_POLICY_PARAMETERS_GLOBAL]: {
        runtimeParameterInjection: true,
        candidateParameterScope: 'runtime_injected',
        strategyVariantId: 'construction-priority.pg.territory-seed.v1',
        candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
        sourceStrategyId: 'construction-priority.territory-shadow.v1',
        family: 'construction-priority',
        parameters: {
          territorySignalWeight: 29
        },
        parametersSha256: 'alternate-root-sha'
      }
    };

    const result = applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY);

    expect(result.evidence).toMatchObject({
      runtimeParameterInjection: true,
      consumed: false,
      parametersSha256: 'alternate-root-sha',
      appliedStrategyIds: ['construction-priority.territory-shadow.v1']
    });
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

  it('marks consumption after tick-time planning uses runtime-injected parameters', () => {
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
      reason: 'runtime policy parameter payload was not used by tick runtime strategy evaluation',
      parametersSha256: 'runtime-use-sha',
      appliedStrategyIds: [],
      parameters: {
        territorySignalWeight: 29
      }
    });

    expect(usedEntry).toBeDefined();
    recorder.recordStrategyRuntimeUse(usedEntry!);

    expect(recorder.buildEvidence()).toMatchObject({
      runtimeParameterInjection: true,
      consumed: true,
      reason: 'runtime policy parameter payload was used by tick runtime strategy evaluation',
      consumerVersion: RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION,
      parametersSha256: 'runtime-use-sha',
      consumedParametersSha256: 'runtime-use-sha',
      consumedStrategyVariantId: 'construction-priority.pg.territory-seed.v1',
      appliedStrategyIds: ['construction-priority.incumbent.v1'],
      parameters: {
        territorySignalWeight: 29
      }
    });
  });

  it('does not infer consumption from a different injected payload', () => {
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
    applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY);

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

    expect(createRuntimePolicyParameterConsumptionRecorder().buildEvidence()).toMatchObject({
      runtimeParameterInjection: true,
      consumed: false,
      appliedStrategyIds: [],
      parametersSha256: 'runtime-use-sha-2',
      reason: 'runtime policy parameter payload was not used by tick runtime strategy evaluation'
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

  it('uses describeExits as authoritative for runtime objective adjacency', () => {
    installHostileFindGlobals();
    installRuntimeConstructionPriorityPayload();
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'E0N0' ? { 1: 'E0N1', 3: 'E1N0' } : {}
    );
    (globalThis as { Game?: Partial<Game> }).Game = {
      rooms: {
        E0N0: makeRuntimeRoom('E0N0'),
        E1N1: makeRuntimeRoom('E1N1', 2, 1)
      },
      map: { describeExits } as unknown as GameMap
    };

    expect(selectRuntimePolicyObjectiveActivationTarget('E0N0')).toBeNull();
    expect(describeExits).toHaveBeenCalledWith('E0N0');
  });

  it('does not treat diagonal rooms as adjacent without map exit data', () => {
    installHostileFindGlobals();
    installRuntimeConstructionPriorityPayload();
    (globalThis as { Game?: Partial<Game> }).Game = {
      rooms: {
        E0N0: makeRuntimeRoom('E0N0'),
        E1N1: makeRuntimeRoom('E1N1', 2, 1)
      }
    };

    expect(selectRuntimePolicyObjectiveActivationTarget('E0N0')).toBeNull();
  });

  it('selects an unobserved adjacent defense target when runtime objective weights need reconnaissance', () => {
    installRuntimeConstructionPriorityPayload();
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'E0N0' ? { 1: 'E0N1', 3: 'E1N0' } : {}
    );
    (globalThis as { Game?: Partial<Game> }).Game = {
      rooms: {
        E0N0: makeRuntimeRoom('E0N0'),
        E0N1: makeRuntimeRoom('E0N1')
      },
      map: { describeExits } as unknown as GameMap
    };

    expect(selectRuntimePolicyObjectiveActivationTarget('E0N0')).toBeNull();
    expect(selectRuntimePolicyObjectiveDefenseTarget('E0N0')).toEqual({
      colony: 'E0N0',
      targetRoom: 'E1N0',
      hostileCreepCount: 2,
      hostileStructureCount: 0,
      activationScore: 22.25,
      visibility: 'unobserved'
    });
    expect(describeExits).toHaveBeenCalledWith('E0N0');
  });

  it('uses injected multi-tier objective target metadata before generic map reconnaissance', () => {
    installRuntimeConstructionPriorityPayloadWithObjectiveTarget();
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'E0N0' ? { 1: 'E0N1', 3: 'E1N0' } : {}
    );
    (globalThis as { Game?: Partial<Game> }).Game = {
      rooms: {
        E0N0: makeRuntimeRoom('E0N0')
      },
      map: { describeExits } as unknown as GameMap
    };

    expect(selectRuntimePolicyObjectiveDefenseTarget('E0N0')).toEqual({
      colony: 'E0N0',
      targetRoom: 'E1N0',
      hostileCreepCount: 2,
      hostileStructureCount: 1,
      activationScore: 22.25,
      visibility: 'unobserved'
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
        consumerVersion: 'v1',
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
        consumerVersion: 'v1' as const,
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
