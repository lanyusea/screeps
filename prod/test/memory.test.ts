import { cleanupDeadCreepMemory, initializeMemory } from '../src/memory/schema';

describe('memory schema initialization', () => {
  beforeEach(() => {
    (globalThis as unknown as { Memory: Memory }).Memory = {} as Memory;
  });

  it('initializes Memory.meta.version when missing', () => {
    initializeMemory();

    expect(Memory.meta.version).toBe(1);
  });

  it('preserves existing Memory values', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      meta: { version: 99 },
      creeps: { existing: { role: 'harvester' } as CreepMemory }
    };

    initializeMemory();

    expect(Memory.meta.version).toBe(99);
    expect(Memory.creeps.existing.role).toBe('harvester');
  });

  it('creates Memory.creeps when missing', () => {
    initializeMemory();

    expect(Memory.creeps).toEqual({});
  });

  it('removes memory for creeps no longer present in Game.creeps', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        alive: {} as Creep
      }
    };
    (globalThis as unknown as { Memory: Memory }).Memory = ({
      meta: { version: 1 },
      creeps: {
        alive: { role: 'harvester' } as CreepMemory,
        dead: { role: 'builder' } as CreepMemory
      }
    } as unknown) as Memory;

    cleanupDeadCreepMemory();

    expect(Memory.creeps.alive).toEqual({ role: 'harvester' });
    expect(Memory.creeps.dead).toBeUndefined();
  });
});
