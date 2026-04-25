import { runEconomy } from '../src/economy/economyLoop';

describe('MVP economy lifecycle', () => {
  beforeEach(() => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_CONSTRUCTION_SITES: number;
      FIND_MY_STRUCTURES: number;
      RESOURCE_ENERGY: ResourceConstant;
      STRUCTURE_SPAWN: StructureConstant;
      STRUCTURE_EXTENSION: StructureConstant;
      ERR_NOT_IN_RANGE: number;
    }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { ERR_NOT_IN_RANGE: number }).ERR_NOT_IN_RANGE = -9;
  });

  it('covers spawn planning, harvest assignment, transfer transition, and transfer execution', () => {
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller: { my: true, id: 'controller1' } as StructureController,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      room,
      structureType: 'spawn',
      spawning: null,
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) },
      spawnCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1,
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      creeps: {}
    };

    runEconomy();

    expect(spawn.spawnCreep).toHaveBeenCalledWith(['work', 'carry', 'move'], 'worker-W1N1-1', {
      memory: { role: 'worker', colony: 'W1N1' }
    });

    const source = { id: 'source1' } as Source;
    const worker = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { ...room, find: jest.fn().mockReturnValue([source]) }
    } as unknown as Creep;

    Game.creeps = { Worker1: worker };
    Game.rooms = {};
    Game.spawns = {};

    runEconomy();

    expect(worker.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });

    const fullWorker = worker as unknown as {
      memory: CreepMemory;
      store: { getUsedCapacity: jest.Mock; getFreeCapacity: jest.Mock };
      room: Room;
      transfer: jest.Mock;
      moveTo: jest.Mock;
    };
    fullWorker.store.getUsedCapacity.mockReturnValue(50);
    fullWorker.store.getFreeCapacity.mockReturnValue(0);
    fullWorker.room = {
      ...room,
      find: jest.fn((type) => (type === 3 ? [spawn] : []))
    } as unknown as Room;

    runEconomy();

    expect(worker.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });

    fullWorker.transfer = jest.fn().mockReturnValue(0);
    fullWorker.moveTo = jest.fn();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 4,
      rooms: {},
      spawns: {},
      creeps: { Worker1: worker },
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runEconomy();

    expect(fullWorker.transfer).toHaveBeenCalledWith(spawn, 'energy');
  });
});
