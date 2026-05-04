import { runHauler } from '../src/creeps/hauler';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

describe('runHauler', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 1;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 2;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
    (globalThis as unknown as { ERR_NOT_IN_RANGE: ScreepsReturnCode }).ERR_NOT_IN_RANGE = ERR_NOT_IN_RANGE_CODE;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('withdraws energy from the assigned remote container', () => {
    const container = makeStoreStructure('container1', 'container' as StructureConstant, 700, 0);
    const remoteRoom = makeRoom('W2N1', true, [], []);
    const creep = makeHauler(remoteRoom, 0);
    creep.withdraw = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE_CODE);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: remoteRoom },
      getObjectById: jest.fn((id: string) => (id === 'container1' ? container : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'container1' });
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(creep.moveTo).toHaveBeenCalledWith(container, { reusePath: 20, ignoreRoads: false });
  });

  it('delivers carried remote energy to spawn and extension sinks before storage', () => {
    const spawn = makeStoreStructure('spawn1', STRUCTURE_SPAWN, 100, 200);
    const storage = makeStoreStructure('storage1', STRUCTURE_STORAGE, 1_000, 5_000);
    const homeRoom = makeRoom('W1N1', true, [storage, spawn], []);
    const creep = makeHauler(homeRoom, 100);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom },
      getObjectById: jest.fn((id: string) => (id === 'spawn1' ? spawn : id === 'storage1' ? storage : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
  });

  it('uses tower capacity when spawn, extension, and storage sinks are unavailable', () => {
    const tower = makeStoreStructure('tower1', STRUCTURE_TOWER, 200, 800);
    const homeRoom = makeRoom('W1N1', true, [tower], []);
    const creep = makeHauler(homeRoom, 100);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom },
      getObjectById: jest.fn((id: string) => (id === 'tower1' ? tower : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'tower1' });
    expect(creep.transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
  });

  it('delivers to terminal capacity when storage is unavailable', () => {
    const terminal = makeStoreStructure('terminal1', STRUCTURE_TERMINAL, 2_000, 10_000);
    const homeRoom = makeRoom('W1N1', true, [terminal], []);
    const creep = makeHauler(homeRoom, 100);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom },
      getObjectById: jest.fn((id: string) => (id === 'terminal1' ? terminal : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'terminal1' });
    expect(creep.transfer).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it('delivers carried energy after a remote room becomes unclaimed', () => {
    const spawn = makeStoreStructure('spawn1', STRUCTURE_SPAWN, 100, 200);
    const homeRoom = makeRoom('W1N1', true, [spawn], []);
    const unclaimedRemoteRoom = makeRoom('W2N1', false, [], []);
    const creep = makeHauler(homeRoom, 100);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom, W2N1: unclaimedRemoteRoom },
      getObjectById: jest.fn((id: string) => (id === 'spawn1' ? spawn : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });
});

function makeHauler(room: Room, carriedEnergy: number): Creep {
  return {
    memory: {
      role: 'hauler',
      colony: 'W1N1',
      remoteHauler: {
        homeRoom: 'W1N1',
        targetRoom: 'W2N1',
        sourceId: 'source1' as Id<Source>,
        containerId: 'container1' as Id<StructureContainer>
      }
    },
    room,
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? carriedEnergy : 0))
    },
    withdraw: jest.fn().mockReturnValue(OK_CODE),
    transfer: jest.fn().mockReturnValue(OK_CODE),
    moveTo: jest.fn()
  } as unknown as Creep;
}

function makeRoom(
  roomName: string,
  owned: boolean,
  structures: AnyOwnedStructure[],
  hostiles: Creep[]
): Room {
  return {
    name: roomName,
    controller: { my: owned } as StructureController,
    find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      if (type === FIND_MY_STRUCTURES) {
        return options?.filter ? structures.filter(options.filter) : structures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeStoreStructure(
  id: string,
  structureType: StructureConstant,
  usedEnergy: number,
  freeEnergy: number
): AnyOwnedStructure {
  return {
    id,
    structureType,
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? usedEnergy : 0)),
      getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeEnergy : 0))
    }
  } as unknown as AnyOwnedStructure;
}
