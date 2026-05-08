import { runHauler } from '../src/creeps/hauler';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

describe('runHauler', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 1;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 2;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 3;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_LINK: StructureConstant }).STRUCTURE_LINK = 'link';
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

  it('withdraws from the richest visible remote container or storage source', () => {
    const assignedContainer = makeStoreStructure('container1', STRUCTURE_CONTAINER, 100, 0);
    const richContainer = makeStoreStructure('container-rich', STRUCTURE_CONTAINER, 800, 0);
    const storage = makeStoreStructure('storage1', STRUCTURE_STORAGE, 500, 0);
    const remoteRoom = makeRoom('W2N1', true, [], [], [
      assignedContainer as unknown as Structure,
      richContainer as unknown as Structure,
      storage as unknown as Structure
    ]);
    const creep = makeHauler(remoteRoom, 0);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: remoteRoom },
      getObjectById: jest.fn((id: string) => (id === 'container1' ? assignedContainer : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'container-rich' });
    expect(creep.withdraw).toHaveBeenCalledWith(richContainer, RESOURCE_ENERGY);
    expect(creep.memory.behaviorTelemetry).toMatchObject({ energyAcquisitionWithdrawn: 1 });
  });

  it('withdraws from an overflow-risk container before richer durable storage', () => {
    const assignedContainer = makeStoreStructure('container1', STRUCTURE_CONTAINER, 100, 1_900, 2_000);
    const overflowContainer = makeStoreStructure('container-overflow', STRUCTURE_CONTAINER, 1_700, 300, 2_000);
    const storage = makeStoreStructure('storage-rich', STRUCTURE_STORAGE, 5_000, 5_000, 10_000);
    const remoteRoom = makeRoom('W2N1', true, [], [], [
      assignedContainer as unknown as Structure,
      overflowContainer as unknown as Structure,
      storage as unknown as Structure
    ]);
    const creep = makeHauler(remoteRoom, 0);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: remoteRoom },
      getObjectById: jest.fn((id: string) => (id === 'container1' ? assignedContainer : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'container-overflow' });
    expect(creep.withdraw).toHaveBeenCalledWith(overflowContainer, RESOURCE_ENERGY);
  });

  it('keeps durable storage ahead of containers below the overflow threshold', () => {
    const assignedContainer = makeStoreStructure('container1', STRUCTURE_CONTAINER, 100, 1_900, 2_000);
    const bufferedContainer = makeStoreStructure('container-buffered', STRUCTURE_CONTAINER, 1_500, 500, 2_000);
    const storage = makeStoreStructure('storage-rich', STRUCTURE_STORAGE, 5_000, 5_000, 10_000);
    const remoteRoom = makeRoom('W2N1', true, [], [], [
      assignedContainer as unknown as Structure,
      bufferedContainer as unknown as Structure,
      storage as unknown as Structure
    ]);
    const creep = makeHauler(remoteRoom, 0);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: remoteRoom },
      getObjectById: jest.fn((id: string) => (id === 'container1' ? assignedContainer : null))
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'storage-rich' });
    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
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
    const storage = makeStoreStructure('storage1', STRUCTURE_STORAGE, 1_000, 0);
    const terminal = makeStoreStructure('terminal1', STRUCTURE_TERMINAL, 2_000, 10_000);
    const homeRoom = makeRoom('W1N1', true, [storage, terminal], []);
    const creep = makeHauler(homeRoom, 100);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom },
      getObjectById: jest.fn((id: string) =>
        id === 'storage1' ? storage : id === 'terminal1' ? terminal : null
      )
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'terminal1' });
    expect(creep.transfer).toHaveBeenCalledWith(terminal, RESOURCE_ENERGY);
  });

  it('delivers to storage before terminal even when the terminal id sorts first', () => {
    const terminal = makeStoreStructure('aaa-terminal', STRUCTURE_TERMINAL, 2_000, 10_000);
    const storage = makeStoreStructure('storage-z', STRUCTURE_STORAGE, 1_000, 5_000);
    const homeRoom = makeRoom('W1N1', true, [terminal, storage], []);
    const creep = makeHauler(homeRoom, 100);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom },
      getObjectById: jest.fn((id: string) =>
        id === 'storage-z' ? storage : id === 'aaa-terminal' ? terminal : null
      )
    };

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'storage-z' });
    expect(creep.transfer).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
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

  it('withdraws local energy from the nearest eligible hauling source', () => {
    const lowContainer = makeStoreStructure('container-low', STRUCTURE_CONTAINER, 50, 1_950, 2_000, 3, 3);
    const farContainer = makeStoreStructure('container-far', STRUCTURE_CONTAINER, 800, 1_200, 2_000, 20, 20);
    const storage = makeStoreStructure('storage-near', STRUCTURE_STORAGE, 300, 9_700, 10_000, 6, 6);
    const spawn = makeStoreStructure('spawn1', STRUCTURE_SPAWN, 100, 200, 300, 10, 10);
    const room = makeRoom('W1N1', true, [spawn], [], [
      lowContainer as unknown as Structure,
      farContainer as unknown as Structure,
      storage as unknown as Structure
    ]);
    const creep = makeLocalHauler(room, 0);

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'storage-near' });
    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
  });

  it('delivers local energy by priority before distance', () => {
    const spawn = makeStoreStructure('spawn1', STRUCTURE_SPAWN, 100, 200, 300, 20, 20);
    const extension = makeStoreStructure('extension1', STRUCTURE_EXTENSION, 0, 50, 50, 3, 3);
    const tower = makeStoreStructure('tower1', STRUCTURE_TOWER, 200, 800, 1_000, 2, 2);
    const room = makeRoom('W1N1', true, [tower, extension, spawn], []);
    const creep = makeLocalHauler(room, 100);

    runHauler(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
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

function makeLocalHauler(room: Room, carriedEnergy: number): Creep {
  return {
    memory: {
      role: 'hauler',
      colony: room.name,
      energyHauler: { roomName: room.name }
    },
    pos: makeRoomPosition(1, 1, room.name),
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
  hostiles: Creep[],
  roomStructures: Structure[] = []
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

      if (type === FIND_STRUCTURES) {
        return roomStructures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeStoreStructure(
  id: string,
  structureType: StructureConstant,
  usedEnergy: number,
  freeEnergy: number,
  capacity = usedEnergy + freeEnergy,
  x = 10,
  y = 10
): AnyOwnedStructure {
  return {
    id,
    structureType,
    ...(structureType === STRUCTURE_CONTAINER ? {} : { my: true }),
    pos: makeRoomPosition(x, y),
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? usedEnergy : 0)),
      getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeEnergy : 0)),
      getCapacity: jest.fn((resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? capacity : 0))
    }
  } as unknown as AnyOwnedStructure;
}

function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: jest.fn((target: RoomObject | RoomPosition) => {
      const position = 'pos' in target ? target.pos : target;
      return Math.max(Math.abs(x - position.x), Math.abs(y - position.y));
    })
  } as unknown as RoomPosition;
}
