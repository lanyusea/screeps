import { Kernel } from '../src/kernel/Kernel';
import type { RuntimeTelemetryEvent } from '../src/telemetry/runtimeSummary';

describe('Kernel', () => {
  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('calls memory initialization and cleanup once per tick', () => {
    const initializeMemory = jest.fn();
    const cleanupDeadCreepMemory = jest.fn();
    const defenseEvents = [
      {
        type: 'defense' as const,
        action: 'workerFallback' as const,
        roomName: 'W1N1',
        reason: 'workerEmergencyFallback',
        hostileCreepCount: 1,
        hostileStructureCount: 0,
        damagedCriticalStructureCount: 0
      }
    ];
    const runDefense = jest.fn().mockReturnValue(defenseEvents);
    const runEconomy = jest.fn();
    const kernel = new Kernel({ initializeMemory, cleanupDeadCreepMemory, runDefense, runEconomy });

    kernel.run();

    expect(initializeMemory).toHaveBeenCalledTimes(1);
    expect(cleanupDeadCreepMemory).toHaveBeenCalledTimes(1);
    expect(runDefense).toHaveBeenCalledTimes(1);
    expect(runEconomy).toHaveBeenCalledTimes(1);
    expect(runEconomy).toHaveBeenCalledWith(defenseEvents);
    expect(initializeMemory.mock.invocationCallOrder[0]).toBeLessThan(cleanupDeadCreepMemory.mock.invocationCallOrder[0]);
    expect(cleanupDeadCreepMemory.mock.invocationCallOrder[0]).toBeLessThan(runDefense.mock.invocationCallOrder[0]);
    expect(runDefense.mock.invocationCallOrder[0]).toBeLessThan(runEconomy.mock.invocationCallOrder[0]);
  });

  it('throttles repeated defense events between runtime summary cadence ticks', () => {
    const defenseEvent = makeDefenseEvent({
      action: 'defenderMove',
      structureId: 'Defender1',
      targetId: 'hostile1'
    });
    const runEconomy = jest.fn();
    const kernel = new Kernel({
      initializeMemory: jest.fn(),
      cleanupDeadCreepMemory: jest.fn(),
      runDefense: jest.fn().mockReturnValue([defenseEvent]),
      runEconomy
    });

    setGameTime(101);
    kernel.run();
    setGameTime(102);
    kernel.run();
    setGameTime(121);
    kernel.run();

    expect(runEconomy).toHaveBeenNthCalledWith(1, [defenseEvent]);
    expect(runEconomy).toHaveBeenNthCalledWith(2, []);
    expect(runEconomy).toHaveBeenNthCalledWith(3, [defenseEvent]);
  });

  it('aggregates duplicate defense actions before forwarding runtime summary events', () => {
    const firstTowerAttack = makeDefenseEvent({
      action: 'towerAttack',
      structureId: 'tower1',
      targetId: 'hostile1'
    });
    const duplicateTowerAttack = makeDefenseEvent({
      action: 'towerAttack',
      structureId: 'tower2',
      targetId: 'hostile1'
    });
    const runEconomy = jest.fn();
    const kernel = new Kernel({
      initializeMemory: jest.fn(),
      cleanupDeadCreepMemory: jest.fn(),
      runDefense: jest.fn().mockReturnValue([firstTowerAttack, duplicateTowerAttack]),
      runEconomy
    });

    setGameTime(201);
    kernel.run();

    expect(runEconomy).toHaveBeenCalledWith([firstTowerAttack]);
  });

  it('keeps safe-mode defense events immediate despite defense event throttling', () => {
    const safeModeEvent = makeDefenseEvent({
      action: 'safeMode',
      reason: 'safeModeEarlyRoomThreat',
      targetId: 'controller1'
    });
    const runEconomy = jest.fn();
    const kernel = new Kernel({
      initializeMemory: jest.fn(),
      cleanupDeadCreepMemory: jest.fn(),
      runDefense: jest.fn().mockReturnValue([safeModeEvent]),
      runEconomy
    });

    setGameTime(301);
    kernel.run();
    setGameTime(302);
    kernel.run();

    expect(runEconomy).toHaveBeenNthCalledWith(1, [safeModeEvent]);
    expect(runEconomy).toHaveBeenNthCalledWith(2, [safeModeEvent]);
  });

  it('does not throw when no rooms or spawns exist', () => {
    const kernel = new Kernel({
      initializeMemory: jest.fn(),
      cleanupDeadCreepMemory: jest.fn(),
      runDefense: jest.fn().mockReturnValue([]),
      runEconomy: jest.fn()
    });

    expect(() => kernel.run()).not.toThrow();
  });
});

function makeDefenseEvent(
  overrides: Partial<Extract<RuntimeTelemetryEvent, { type: 'defense' }>> = {}
): Extract<RuntimeTelemetryEvent, { type: 'defense' }> {
  return {
    type: 'defense',
    action: 'towerAttack',
    roomName: 'W1N1',
    reason: 'hostileVisible',
    hostileCreepCount: 1,
    hostileStructureCount: 0,
    damagedCriticalStructureCount: 0,
    result: 0 as ScreepsReturnCode,
    ...overrides
  };
}

function setGameTime(time: number): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = { time };
}
