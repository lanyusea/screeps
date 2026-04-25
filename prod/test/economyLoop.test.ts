import { runEconomy } from '../src/economy/economyLoop';
import { RUNTIME_SUMMARY_PREFIX } from '../src/telemetry/runtimeSummary';

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
