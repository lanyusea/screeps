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

    expect(creep.moveTo).toHaveBeenCalledWith(homeController, { reusePath: 20, ignoreRoads: false });
    expect(creep.harvest).not.toHaveBeenCalled();
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

    expect(creep.moveTo).toHaveBeenCalledWith(homeController, { reusePath: 20, ignoreRoads: false });
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

    expect(creep.moveTo).toHaveBeenCalledWith(homeController, { reusePath: 20, ignoreRoads: false });
    expect(creep.harvest).not.toHaveBeenCalled();
  });
});

function makeRemoteHarvester(
  room: Room,
  {
    usedEnergy,
    freeEnergy,
    range
  }: {
    usedEnergy: number;
    freeEnergy: number;
    range: number;
  }
): Creep {
  return {
    memory: {
      role: 'remoteHarvester',
      colony: 'W1N1',
      remoteHarvester: {
        homeRoom: 'W1N1',
        targetRoom: 'W2N1',
        sourceId: 'source1' as Id<Source>,
        containerId: 'container1' as Id<StructureContainer>
      }
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
  owner = owned ? { username: 'me' } : undefined
): Room {
  return {
    name: roomName,
    controller: { my: owned, ...(owner ? { owner } : {}) } as StructureController,
    find: jest.fn((type: number) => (type === FIND_HOSTILE_CREEPS ? hostiles : []))
  } as unknown as Room;
}

function makeSource(id: string): Source {
  return { id, energy: 300 } as Source;
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
