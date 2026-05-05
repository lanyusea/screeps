import { runRemoteHarvester } from '../src/creeps/remoteHarvester';

const OK_CODE = 0 as ScreepsReturnCode;

describe('runRemoteHarvester', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 1;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { ERR_NOT_IN_RANGE: ScreepsReturnCode }).ERR_NOT_IN_RANGE = -9 as ScreepsReturnCode;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('deposits carried source energy into the assigned remote container', () => {
    const source = makeSource('source1');
    const container = makeContainer('container1');
    const room = makeRoom('W2N1', true, []);
    const creep = makeRemoteHarvester(room, {
      usedEnergy: 50,
      freeEnergy: 0,
      range: 1
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: room },
      getObjectById: jest.fn((id: string) => (id === source.id ? source : id === container.id ? container : null))
    };

    runRemoteHarvester(creep);

    expect(creep.transfer).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('retreats home when the assigned remote room is hostile owned', () => {
    const homeController = { id: 'controller1' } as StructureController;
    const homeRoom = { name: 'W1N1', controller: homeController } as Room;
    const remoteRoom = makeRoom('W2N1', false, [], { username: 'enemy' });
    const creep = makeRemoteHarvester(remoteRoom, {
      usedEnergy: 0,
      freeEnergy: 50,
      range: 1
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom, W2N1: remoteRoom },
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runRemoteHarvester(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(
      homeController,
      expect.objectContaining({ reusePath: 20, ignoreRoads: false })
    );
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('harvests the assigned remote source before its container is built', () => {
    const source = makeSource('source1');
    const remoteRoom = makeRoom('W2N1', true, []);
    const creep = makeRemoteHarvester(remoteRoom, {
      usedEnergy: 0,
      freeEnergy: 50,
      range: 1,
      containerId: null
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: remoteRoom },
      getObjectById: jest.fn((id: string) => (id === source.id ? source : null))
    };

    runRemoteHarvester(creep);

    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('harvests in neutral assigned remote rooms', () => {
    const source = makeSource('source1');
    const remoteRoom = makeRoom('W2N1', false, []);
    const creep = makeRemoteHarvester(remoteRoom, {
      usedEnergy: 0,
      freeEnergy: 50,
      range: 1
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: remoteRoom },
      getObjectById: jest.fn((id: string) => (id === source.id ? source : null))
    };

    runRemoteHarvester(creep);

    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('retreats home when hostiles threaten the remote room', () => {
    const homeController = { id: 'controller1' } as StructureController;
    const homeRoom = { name: 'W1N1', controller: homeController } as Room;
    const hostile = { id: 'hostile1' } as Creep;
    const remoteRoom = makeRoom('W2N1', true, [hostile]);
    const creep = makeRemoteHarvester(remoteRoom, {
      usedEnergy: 0,
      freeEnergy: 50,
      range: 1
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom, W2N1: remoteRoom },
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runRemoteHarvester(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(
      homeController,
      expect.objectContaining({ reusePath: 20, ignoreRoads: false })
    );
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('retreats home while in transit when hostiles threaten the visible target room', () => {
    const homeController = { id: 'controller1' } as StructureController;
    const homeRoom = { name: 'W1N1', controller: homeController } as Room;
    const hostile = { id: 'hostile1' } as Creep;
    const remoteRoom = makeRoom('W2N1', false, [hostile]);
    const creep = makeRemoteHarvester(homeRoom, {
      usedEnergy: 0,
      freeEnergy: 50,
      range: 20
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom, W2N1: remoteRoom },
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runRemoteHarvester(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(
      homeController,
      expect.objectContaining({ reusePath: 20, ignoreRoads: false })
    );
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('biases movement onto visible critical road logistics paths', () => {
    (globalThis as unknown as {
      FIND_SOURCES: number;
      FIND_STRUCTURES: number;
      FIND_CONSTRUCTION_SITES: number;
      FIND_MY_STRUCTURES: number;
      STRUCTURE_ROAD: StructureConstant;
    }).FIND_SOURCES = 2;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 3;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 4;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 5;
    (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
    const source = makeSource('source1', { x: 10, y: 10, roomName: 'W2N1' });
    const road = {
      id: 'critical-road',
      structureType: 'road',
      pos: { x: 11, y: 10, roomName: 'W2N1' }
    } as StructureRoad;
    const remoteRoom = makeRoom('W2N1', true, [], undefined, {
      sources: [source],
      structures: [road]
    });
    const homeRoom = makeRoom('W1N1', true, []);
    const spawn = {
      name: 'Spawn1',
      pos: { x: 25, y: 25, roomName: 'W1N1' },
      room: homeRoom
    } as StructureSpawn;
    const creep = makeRemoteHarvester(remoteRoom, {
      usedEnergy: 0,
      freeEnergy: 50,
      range: 5,
      containerId: null
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: homeRoom, W2N1: remoteRoom },
      spawns: { Spawn1: spawn },
      getObjectById: jest.fn((id: string) => (id === source.id ? source : null))
    };

    runRemoteHarvester(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(
      source,
      expect.objectContaining({ reusePath: 20, ignoreRoads: false, costCallback: expect.any(Function) })
    );
    const moveOptions = (creep.moveTo as jest.Mock).mock.calls[0][1] as MoveToOpts;
    const matrix = { set: jest.fn() } as unknown as CostMatrix;
    expect(moveOptions.costCallback?.('W2N1', matrix)).toBe(matrix);
    expect(matrix.set).toHaveBeenCalledWith(11, 10, 1);
  });
});

function makeRemoteHarvester(
  room: Room,
  {
    usedEnergy,
    freeEnergy,
    range,
    containerId
  }: {
    usedEnergy: number;
    freeEnergy: number;
    range: number;
    containerId?: Id<StructureContainer> | null;
  }
): Creep {
  const remoteHarvester: CreepRemoteHarvesterMemory = {
    homeRoom: 'W1N1',
    targetRoom: 'W2N1',
    sourceId: 'source1' as Id<Source>,
    ...(containerId === null ? {} : { containerId: containerId ?? ('container1' as Id<StructureContainer>) })
  };
  return {
    memory: {
      role: 'remoteHarvester',
      colony: 'W1N1',
      remoteHarvester
    },
    room,
    pos: { getRangeTo: jest.fn().mockReturnValue(range) } as unknown as RoomPosition,
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? usedEnergy : 0)),
      getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeEnergy : 0))
    },
    harvest: jest.fn().mockReturnValue(OK_CODE),
    transfer: jest.fn().mockReturnValue(OK_CODE),
    moveTo: jest.fn()
  } as unknown as Creep;
}

function makeRoom(
  roomName: string,
  owned: boolean,
  hostiles: Creep[],
  owner = owned ? { username: 'me' } : undefined,
  {
    sources = [],
    structures = [],
    constructionSites = []
  }: {
    sources?: Source[];
    structures?: Structure[];
    constructionSites?: ConstructionSite[];
  } = {}
): Room {
  const globals = globalThis as Record<string, unknown>;
  return {
    name: roomName,
    controller: {
      my: owned,
      pos: { x: 25, y: 25, roomName },
      ...(owner ? { owner } : {})
    } as StructureController,
    find: jest.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostiles;
      }

      if (type === globals.FIND_SOURCES) {
        return sources;
      }

      if (type === globals.FIND_STRUCTURES) {
        return structures;
      }

      if (type === globals.FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      return [];
    })
  } as unknown as Room;
}

function makeSource(id: string, pos = { x: 10, y: 10, roomName: 'W2N1' }): Source {
  return { id, energy: 300, pos } as Source;
}

function makeContainer(id: string): StructureContainer {
  return {
    id,
    structureType: 'container',
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(0)
    }
  } as unknown as StructureContainer;
}
