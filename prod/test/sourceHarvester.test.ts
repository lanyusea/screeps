import {
  runSourceHarvester,
  selectSourceHarvesterAssignment
} from '../src/creeps/sourceHarvester';

const OK_CODE = 0 as ScreepsReturnCode;

describe('sourceHarvester', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      FIND_SOURCES: 2,
      FIND_STRUCTURES: 3,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_CONTAINER: 'container',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_LINK: 'link',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_TOWER: 'tower'
    });
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('selects only sources with built source-adjacent containers', () => {
    const sourceWithContainer = makeSource('source1', 10, 10);
    const sourceWithoutContainer = makeSource('source2', 20, 20);
    const container = makeContainer('container1', 10, 11);
    const room = makeRoom({
      sources: [sourceWithoutContainer, sourceWithContainer],
      structures: [container]
    });

    expect(selectSourceHarvesterAssignment(room)).toEqual({
      roomName: 'W1N1',
      sourceId: 'source1',
      containerId: 'container1'
    });
  });

  it('moves onto the assigned container before harvesting', () => {
    const source = makeSource('source1', 10, 10);
    const container = makeContainer('container1', 10, 11);
    const room = makeRoom({ sources: [source], structures: [container] });
    const creep = makeSourceHarvester(room, {
      usedEnergy: 0,
      freeEnergy: 50,
      ranges: { source1: 1, container1: 1 }
    });
    installGame(room, { source, container });

    runSourceHarvester(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(container);
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('transfers full carried energy into an adjacent source link before the container', () => {
    const source = makeSource('source1', 10, 10);
    const container = makeContainer('container1', 10, 11);
    const link = makeLink('link-source', 10, 12, 0, 800);
    const controllerLink = makeLink('link-controller', 25, 24, 0, 800);
    const room = makeRoom({
      controller: makeController(25, 25),
      sources: [source],
      structures: [container],
      myStructures: [link, controllerLink]
    });
    const creep = makeSourceHarvester(room, {
      usedEnergy: 50,
      freeEnergy: 0,
      ranges: { source1: 1, container1: 0, 'link-source': 1 }
    });
    installGame(room, { source, container, link });

    runSourceHarvester(creep);

    expect(creep.transfer).toHaveBeenCalledWith(link, RESOURCE_ENERGY);
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('falls back to mobile source harvesting when the container is destroyed', () => {
    const source = makeSource('source1', 10, 10);
    const room = makeRoom({ sources: [source], structures: [] });
    const creep = makeSourceHarvester(room, {
      usedEnergy: 0,
      freeEnergy: 50,
      ranges: { source1: 1 }
    });
    installGame(room, { source });

    runSourceHarvester(creep);

    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });
});

function makeSourceHarvester(
  room: Room,
  {
    usedEnergy,
    freeEnergy,
    ranges
  }: {
    usedEnergy: number;
    freeEnergy: number;
    ranges: Record<string, number>;
  }
): Creep {
  return {
    memory: {
      role: 'sourceHarvester',
      colony: 'W1N1',
      sourceHarvester: {
        roomName: 'W1N1',
        sourceId: 'source1' as Id<Source>,
        containerId: 'container1' as Id<StructureContainer>
      }
    },
    room,
    pos: {
      getRangeTo: jest.fn((target: { id?: string }) => ranges[String(target.id)] ?? 99)
    } as unknown as RoomPosition,
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? usedEnergy : 0)),
      getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeEnergy : 0))
    },
    harvest: jest.fn().mockReturnValue(OK_CODE),
    transfer: jest.fn().mockReturnValue(OK_CODE),
    moveTo: jest.fn()
  } as unknown as Creep;
}

function installGame(
  room: Room,
  objects: {
    source?: Source;
    container?: StructureContainer;
    link?: StructureLink;
  }
): void {
  (globalThis as { Game?: Partial<Game> }).Game = {
    rooms: { W1N1: room },
    creeps: {},
    getObjectById: jest.fn((id: string) => {
      if (id === objects.source?.id) {
        return objects.source;
      }

      if (id === objects.container?.id) {
        return objects.container;
      }

      if (id === objects.link?.id) {
        return objects.link;
      }

      return null;
    })
  };
}

function makeRoom({
  controller = makeController(25, 25),
  sources = [],
  structures = [],
  myStructures = []
}: {
  controller?: StructureController;
  sources?: Source[];
  structures?: AnyStructure[];
  myStructures?: AnyOwnedStructure[];
} = {}): Room {
  return {
    name: 'W1N1',
    controller,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      if (type === FIND_MY_STRUCTURES) {
        return myStructures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeSource(id: string, x: number, y: number): Source {
  return { id, energy: 300, pos: makeRoomPosition(x, y) } as unknown as Source;
}

function makeContainer(id: string, x: number, y: number): StructureContainer {
  return {
    id,
    structureType: 'container',
    pos: makeRoomPosition(x, y),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(2_000),
      getUsedCapacity: jest.fn().mockReturnValue(0)
    }
  } as unknown as StructureContainer;
}

function makeLink(id: string, x: number, y: number, energy: number, freeCapacity: number): StructureLink {
  return {
    id,
    cooldown: 0,
    my: true,
    structureType: 'link',
    pos: makeRoomPosition(x, y),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    }
  } as unknown as StructureLink;
}

function makeController(x: number, y: number): StructureController {
  return { id: 'controller1', my: true, pos: makeRoomPosition(x, y) } as unknown as StructureController;
}

function makeRoomPosition(x: number, y: number): RoomPosition {
  return { x, y, roomName: 'W1N1' } as RoomPosition;
}
