import type { KernelRunOptions } from '../src/kernel/Kernel';
import {
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

  it('keeps injected runtime evidence unconsumed when the tick does not use the patched strategy', () => {
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
      consumed: false,
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      parametersSha256: 'runtime-use-sha',
      appliedStrategyIds: [],
      reason: 'runtime policy parameter payload was not used by tick runtime strategy evaluation',
      liveEffect: false,
      officialMmoWrites: false,
      officialMmoWritesAllowed: false,
      tick: 20
    });
  });
});

function mockKernel(run: jest.Mock<RuntimeSummary, [KernelRunOptions?]>): void {
  jest.doMock('../src/kernel/Kernel', () => ({
    Kernel: jest.fn().mockImplementation(() => ({ run }))
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

function installRuntimePolicyPayload(): void {
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
}

function makeRuntimeSummary(): RuntimeSummary {
  return {
    type: 'runtime-summary',
    tick: 20,
    rooms: []
  };
}
