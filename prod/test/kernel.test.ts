import { Kernel } from '../src/kernel/Kernel';

describe('Kernel', () => {
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
