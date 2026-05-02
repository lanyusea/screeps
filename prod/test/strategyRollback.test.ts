import { DEFAULT_STRATEGY_REGISTRY, type StrategyRegistryEntry } from '../src/strategy/strategyRegistry';

type StrategyRollbackModule = typeof import('../src/rl/strategyRollback');

describe('strategy rollback executor', () => {
  let executeRollback: StrategyRollbackModule['executeRollback'];
  let applyPendingRollbacks: StrategyRollbackModule['applyPendingRollbacks'];

  beforeEach(async () => {
    jest.resetModules();
    const rollbackModule = (await import('../src/rl/strategyRollback')) as StrategyRollbackModule;
    executeRollback = rollbackModule.executeRollback;
    applyPendingRollbacks = rollbackModule.applyPendingRollbacks;

    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      creeps: {},
      rooms: {},
      spawns: {}
    };
  });

  it('sets pending rollback flags in memory when a regression is first detected', () => {
    const registry = makeShadowOnlyRegistry();
    const result = executeRollback('construction-priority', registry, 'reliability regression');

    expect(result.executed).toBe(false);
    expect(result.disabledId).toBe('construction-priority.territory-shadow.v1');
    expect(result.rollbackToId).toBe('construction-priority.incumbent.v1');
    expect(result.reason).toBe('reliability regression');
    expect(Memory.strategyRollback?.['construction-priority']).toEqual({
      disabledId: 'construction-priority.territory-shadow.v1',
      rollbackToId: 'construction-priority.incumbent.v1',
      timestamp: 100,
      reason: 'reliability regression'
    });
  });

  it('applies rollback on the second consecutive tick', () => {
    const registry = makeShadowOnlyRegistry();
    const first = executeRollback('construction-priority', registry, 'first tick');
    expect(first.executed).toBe(false);

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      ...(globalThis as unknown as { Game: Partial<Game> }).Game,
      time: 101
    };
    const second = executeRollback('construction-priority', registry, 'second tick');
    expect(second.executed).toBe(true);

    const updated = applyPendingRollbacks(registry);
    expect(updated).not.toBe(registry);

    const byId = Object.fromEntries(updated.map((entry) => [entry.id, entry.rolloutStatus]));
    expect(byId['construction-priority.territory-shadow.v1']).toBe('disabled');
    expect(byId['construction-priority.incumbent.v1']).toBe('incumbent');
  });

  it('is a no-op when there are no pending rollbacks', () => {
    const registry = makeShadowOnlyRegistry();

    const updated = applyPendingRollbacks(registry);

    expect(updated).toBe(registry);
    expect(Memory.strategyRollback).toEqual({});
  });

  it('records rollback history entries', () => {
    const registry = makeShadowOnlyRegistry();
    executeRollback('construction-priority', registry, 'history reason');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      ...(globalThis as unknown as { Game: Partial<Game> }).Game,
      time: 101
    };
    executeRollback('construction-priority', registry, 'history reason');
    applyPendingRollbacks(registry);

    expect(Memory.strategyRollbackHistory).toEqual([
      {
        family: 'construction-priority',
        disabledId: 'construction-priority.territory-shadow.v1',
        rollbackToId: 'construction-priority.incumbent.v1',
        timestamp: 101,
        reason: 'history reason'
      }
    ]);
  });

  it('rolls back multiple families in sequence', () => {
    const registry = makeMultiFamilyRegistry();

    executeRollback('construction-priority', registry, 'first family');
    executeRollback('expansion-remote-candidate', registry, 'second family');

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      ...(globalThis as unknown as { Game: Partial<Game> }).Game,
      time: 101
    };

    executeRollback('construction-priority', registry, 'first family');
    executeRollback('expansion-remote-candidate', registry, 'second family');

    const updated = applyPendingRollbacks(registry);
    const byFamily = Object.fromEntries(updated.map((entry) => [entry.id, entry.rolloutStatus]));

    expect(updated).not.toBe(registry);
    expect(byFamily['construction-priority.territory-shadow.v1']).toBe('disabled');
    expect(byFamily['construction-priority.incumbent.v1']).toBe('incumbent');
    expect(byFamily['expansion-remote.territory-shadow.v1']).toBe('disabled');
    expect(byFamily['expansion-remote.incumbent.v1']).toBe('incumbent');
    expect(Memory.strategyRollbackHistory).toEqual([
      {
        family: 'construction-priority',
        disabledId: 'construction-priority.territory-shadow.v1',
        rollbackToId: 'construction-priority.incumbent.v1',
        timestamp: 101,
        reason: 'first family'
      },
      {
        family: 'expansion-remote-candidate',
        disabledId: 'expansion-remote.territory-shadow.v1',
        rollbackToId: 'expansion-remote.incumbent.v1',
        timestamp: 101,
        reason: 'second family'
      }
    ]);
  });
});

function makeShadowOnlyRegistry(): StrategyRegistryEntry[] {
  return [
    cloneStrategyRegistryEntry(
      DEFAULT_STRATEGY_REGISTRY.find(
        (entry) => entry.id === 'construction-priority.incumbent.v1'
      ) as StrategyRegistryEntry
    ),
    cloneStrategyRegistryEntry(
      DEFAULT_STRATEGY_REGISTRY.find(
        (entry) => entry.id === 'construction-priority.territory-shadow.v1'
      ) as StrategyRegistryEntry
    )
  ];
}

function makeMultiFamilyRegistry(): StrategyRegistryEntry[] {
  return [
    ...makeShadowOnlyRegistry(),
    cloneStrategyRegistryEntry(
      DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'expansion-remote.incumbent.v1') as StrategyRegistryEntry
    ),
    cloneStrategyRegistryEntry(
      DEFAULT_STRATEGY_REGISTRY.find(
        (entry) => entry.id === 'expansion-remote.territory-shadow.v1'
      ) as StrategyRegistryEntry
    )
  ];
}

function cloneStrategyRegistryEntry(entry: StrategyRegistryEntry): StrategyRegistryEntry {
  return {
    ...entry,
    supportedContext: { ...entry.supportedContext },
    knobBounds: entry.knobBounds.map((knob) => ({ ...knob })),
    defaultValues: { ...entry.defaultValues },
    evidenceLinks: entry.evidenceLinks.map((link) => ({ ...link })),
    rollback: { ...entry.rollback }
  };
}
