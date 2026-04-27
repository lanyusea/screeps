import { runEconomy } from '../src/economy/economyLoop';
import { RUNTIME_SUMMARY_PREFIX } from '../src/telemetry/runtimeSummary';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_BUSY_CODE = -4 as ScreepsReturnCode;

describe('runEconomy', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('spawns a worker request for an owned colony below target workers', () => {
    const room = { name: 'W1N1', energyAvailable: 300, energyCapacityAvailable: 300 } as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 123,
      rooms: {
        W1N1: { ...room, controller: { my: true } as StructureController } as Room
      },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-123', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('spawns an emergency worker when an owned colony has zero creeps and only basic worker energy', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 200,
      energyCapacityAvailable: 400,
      controller: { my: true } as StructureController
    } as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 125,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-125', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('waits through critical energy without invalid spawn attempts and recovers when an emergency body is affordable', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 199,
      energyCapacityAvailable: 400,
      controller: { my: true } as StructureController
    } as Room;
    const spawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 126,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();
    Game.time = 127;
    runEconomy();

    expect(spawn.spawnCreep).not.toHaveBeenCalled();

    room.energyAvailable = 200;
    Game.time = 128;
    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-128', {
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('retries another idle spawn when the planned spawn reports busy and emits both outcomes', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller: { my: true } as StructureController
    } as Room;
    const busySpawn = {
      name: 'Spawn1',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(-4)
    } as unknown as StructureSpawn;
    const retrySpawn = {
      name: 'Spawn2',
      room,
      spawning: null,
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 124,
      rooms: {
        W1N1: room
      },
      spawns: { Spawn1: busySpawn, Spawn2: retrySpawn },
      creeps: {}
    };

    runEconomy();

    const spawnArgs: Parameters<StructureSpawn['spawnCreep']> = [
      ['work', 'carry', 'move'],
      'worker-W1N1-124',
      {
        memory: { role: 'worker', colony: 'W1N1' }
      }
    ];
    expect(busySpawn.spawnCreep).toHaveBeenCalledWith(...spawnArgs);
    expect(retrySpawn.spawnCreep).toHaveBeenCalledWith(...spawnArgs);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(typeof message).toBe('string');
    expect((message as string).startsWith(RUNTIME_SUMMARY_PREFIX)).toBe(true);
    expect(JSON.parse((message as string).slice(RUNTIME_SUMMARY_PREFIX.length))).toMatchObject({
      events: [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-124',
          role: 'worker',
          result: -4
        },
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn2',
          creepName: 'worker-W1N1-124',
          role: 'worker',
          result: 0
        }
      ]
    });
  });

  it('does not attempt duplicate spawning while a successful spawn stays busy across ticks', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller: { my: true } as StructureController
    } as Room;
    const creeps: Record<string, Creep> = {};
    const spawn = createLifecycleSpawn(room, creeps, 3);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawning).toMatchObject({ name: 'worker-W1N1-200', remainingTime: 3 });

    Game.time = 201;
    spawn.advanceSpawnLifecycle();
    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawning).toMatchObject({ name: 'worker-W1N1-200', remainingTime: 2 });

    Game.time = 202;
    spawn.advanceSpawnLifecycle();
    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledTimes(1);
    expect(spawn.spawning).toMatchObject({ name: 'worker-W1N1-200', remainingTime: 1 });

    spawn.advanceSpawnLifecycle();

    expect(spawn.spawning).toBeNull();
    expect(creeps['worker-W1N1-200']?.memory).toEqual({ role: 'worker', colony: 'W1N1' });
  });

  it('runs existing worker creeps', () => {
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([{ id: 'source1' } as Source]) }
    } as unknown as Creep;
    (globalThis as unknown as { FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; RESOURCE_ENERGY: ResourceConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 123,
      rooms: {},
      spawns: {},
      creeps: { Worker1: creep }
    };

    runEconomy();

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
  });
});

interface LifecycleSpawn extends StructureSpawn {
  spawnCreep: jest.Mock<ScreepsReturnCode, Parameters<StructureSpawn['spawnCreep']>>;
  advanceSpawnLifecycle(): void;
}

function createLifecycleSpawn(room: Room, creeps: Record<string, Creep>, spawnTime: number): LifecycleSpawn {
  let spawning: Spawning | null = null;
  let pendingMemory: CreepMemory | undefined;

  const spawn = {
    name: 'Spawn1',
    room,
    get spawning(): Spawning | null {
      return spawning;
    },
    spawnCreep: jest.fn((body: BodyPartConstant[], name: string, options?: SpawnOptions) => {
      if (spawning) {
        return ERR_BUSY_CODE;
      }

      pendingMemory = options?.memory;
      spawning = { name, remainingTime: spawnTime } as Spawning;
      return OK_CODE;
    }),
    advanceSpawnLifecycle: () => {
      if (!spawning) {
        return;
      }

      spawning = { ...spawning, remainingTime: spawning.remainingTime - 1 } as Spawning;
      if (spawning.remainingTime > 0) {
        return;
      }

      creeps[spawning.name] = {
        name: spawning.name,
        memory: pendingMemory ?? {}
      } as Creep;
      spawning = null;
      pendingMemory = undefined;
    }
  };

  return spawn as unknown as LifecycleSpawn;
}
