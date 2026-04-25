import { Kernel } from '../src/kernel/Kernel';

describe('Kernel', () => {
  it('calls memory initialization and cleanup once per tick', () => {
    const initializeMemory = jest.fn();
    const cleanupDeadCreepMemory = jest.fn();
    const runEconomy = jest.fn();
    const kernel = new Kernel({ initializeMemory, cleanupDeadCreepMemory, runEconomy });

    kernel.run();

    expect(initializeMemory).toHaveBeenCalledTimes(1);
    expect(cleanupDeadCreepMemory).toHaveBeenCalledTimes(1);
    expect(runEconomy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no rooms or spawns exist', () => {
    const kernel = new Kernel({
      initializeMemory: jest.fn(),
      cleanupDeadCreepMemory: jest.fn(),
      runEconomy: jest.fn()
    });

    expect(() => kernel.run()).not.toThrow();
  });
});
