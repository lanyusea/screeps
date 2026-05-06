import {
  ensureRemoteSourceContainersForAssignedHarvesters,
  ensureSourceContainersForOwnedRooms,
  summarizeSourceContainerCoverage
} from '../../src/economy/sourceContainerPlanner';

const OK_CODE = 0 as ScreepsReturnCode;

describe('economy source container planner', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 3;
    (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { OK: ScreepsReturnCode }).OK = OK_CODE;
  });

  afterEach(() => {
    delete (globalThis as unknown as { Game?: Partial<Game> }).Game;
    delete (globalThis as unknown as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as unknown as { FIND_STRUCTURES?: number }).FIND_STRUCTURES;
    delete (globalThis as unknown as { FIND_CONSTRUCTION_SITES?: number }).FIND_CONSTRUCTION_SITES;
    delete (globalThis as unknown as { FIND_DROPPED_RESOURCES?: number }).FIND_DROPPED_RESOURCES;
    delete (globalThis as unknown as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    delete (globalThis as unknown as { STRUCTURE_CONTAINER?: StructureConstant }).STRUCTURE_CONTAINER;
    delete (globalThis as unknown as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as unknown as { OK?: ScreepsReturnCode }).OK;
  });

  it('detects sources missing built or pending source containers', () => {
    const room = makeRoom({
      sources: [makeSource('source1', 10, 10, 'W1N1')]
    });
    installGame([room]);

    expect(summarizeSourceContainerCoverage(room)).toEqual({
      sourceCount: 1,
      sourcesWithContainers: 0,
      sourcesWithContainerSites: 0,
      sourcesMissingContainers: 1
    });
  });

  it('places a missing source container construction site on the best open source-adjacent tile', () => {
    const room = makeRoom({
      sources: [makeSource('source1', 10, 10, 'W1N1')],
      spawnPosition: { x: 5, y: 10 },
      wallPositions: new Set(['9,9', '9,11', '10,9', '10,11', '11,9', '11,10', '11,11'])
    });
    installGame([room]);

    const result = ensureSourceContainersForOwnedRooms([room]);

    expect(result.placedSiteCount).toBe(1);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(9, 10, STRUCTURE_CONTAINER);
  });

  it('skips sources that already have adjacent containers', () => {
    const room = makeRoom({
      sources: [makeSource('source1', 10, 10, 'W1N1')],
      structures: [makeStructure('container1', 'container', 10, 11, 'W1N1')]
    });
    installGame([room]);

    const result = ensureSourceContainersForOwnedRooms([room]);

    expect(result).toMatchObject({
      placedSiteCount: 0,
      sourcesWithContainers: 1,
      sourcesMissingContainers: 0
    });
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('re-places a source container site after the previous container disappears', () => {
    const structures = [makeStructure('container1', 'container', 10, 11, 'W1N1')];
    const room = makeRoom({
      sources: [makeSource('source1', 10, 10, 'W1N1')],
      structures
    });
    installGame([room]);

    expect(ensureSourceContainersForOwnedRooms([room]).placedSiteCount).toBe(0);
    structures.length = 0;

    const result = ensureSourceContainersForOwnedRooms([room]);

    expect(result.placedSiteCount).toBe(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 11, STRUCTURE_CONTAINER);
  });

  it('scans multiple owned rooms in RCL and source-count priority order', () => {
    const rcl3DualSource = makeRoom({
      roomName: 'W1N1',
      rcl: 3,
      sources: [makeSource('a-source1', 10, 10, 'W1N1'), makeSource('a-source2', 30, 10, 'W1N1')]
    });
    const rcl5SingleSource = makeRoom({
      roomName: 'W2N1',
      rcl: 5,
      sources: [makeSource('b-source1', 10, 20, 'W2N1')]
    });
    const rcl5DualSource = makeRoom({
      roomName: 'W3N1',
      rcl: 5,
      sources: [makeSource('c-source1', 10, 30, 'W3N1'), makeSource('c-source2', 30, 30, 'W3N1')]
    });
    installGame([rcl3DualSource, rcl5SingleSource, rcl5DualSource]);

    const result = ensureSourceContainersForOwnedRooms();

    expect(result.placedSiteCount).toBe(5);
    expect(result.rooms.map((room) => room.roomName)).toEqual(['W3N1', 'W2N1', 'W1N1']);
    expect(result.rooms.flatMap((room) => room.placements.map((placement) => placement.roomName))).toEqual([
      'W3N1',
      'W3N1',
      'W2N1',
      'W1N1',
      'W1N1'
    ]);
  });

  it('is idempotent once a pending source container site exists', () => {
    const room = makeRoom({
      sources: [makeSource('source1', 10, 10, 'W1N1')]
    });
    installGame([room]);

    expect(ensureSourceContainersForOwnedRooms([room]).placedSiteCount).toBe(1);
    room.createConstructionSite.mockClear();

    expect(ensureSourceContainersForOwnedRooms([room]).placedSiteCount).toBe(0);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('plans a remote source container when an assigned remote harvester is filling up without storage', () => {
    const room = makeRoom({
      roomName: 'W2N1',
      sources: [makeSource('remote-source', 10, 10, 'W2N1')]
    });
    installGame([room]);
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {
      RemoteHarvester: makeRemoteHarvester(room, 'remote-source' as Id<Source>, {
        usedEnergy: 50,
        freeEnergy: 0
      })
    };

    const result = ensureRemoteSourceContainersForAssignedHarvesters();

    expect(result).toMatchObject({
      placedSiteCount: 1,
      sourceCount: 1,
      sourcesMissingContainers: 1
    });
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 11, STRUCTURE_CONTAINER);
  });

  it('uses dropped energy decay at an assigned remote source as a container planning signal', () => {
    const room = makeRoom({
      roomName: 'W2N1',
      sources: [makeSource('remote-source', 10, 10, 'W2N1')],
      droppedResources: [makeDroppedEnergy('dropped-energy', 9, 9, 'W2N1')]
    });
    installGame([room]);
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {
      RemoteHarvester: makeRemoteHarvester(room, 'remote-source' as Id<Source>, {
        usedEnergy: 0,
        freeEnergy: 50
      })
    };

    const result = ensureRemoteSourceContainersForAssignedHarvesters();

    expect(result.placedSiteCount).toBe(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 11, STRUCTURE_CONTAINER);
  });
});

interface MockRoom extends Room {
  createConstructionSite: jest.Mock;
  find: jest.Mock;
}

interface MakeRoomOptions {
  roomName?: string;
  rcl?: number;
  sources: Source[];
  structures?: AnyStructure[];
  constructionSites?: ConstructionSite[];
  droppedResources?: Resource<ResourceConstant>[];
  wallPositions?: Set<string>;
  spawnPosition?: { x: number; y: number };
}

function makeRoom({
  roomName = 'W1N1',
  rcl = 2,
  sources,
  structures = [],
  constructionSites = [],
  droppedResources = [],
  wallPositions = new Set<string>(),
  spawnPosition = { x: 25, y: 25 }
}: MakeRoomOptions): MockRoom {
  const room = {
    name: roomName,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    controller: {
      my: true,
      level: rcl,
      pos: { x: 25, y: 25, roomName } as RoomPosition
    } as StructureController,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      return type === FIND_DROPPED_RESOURCES ? droppedResources : [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
      constructionSites.push(makeConstructionSite(`site-${roomName}-${x}-${y}`, structureType, x, y, roomName));
      return OK_CODE;
    }),
    _sourceContainerPlannerTest: {
      wallPositions,
      spawnPosition
    }
  } as unknown as MockRoom & {
    _sourceContainerPlannerTest: {
      wallPositions: Set<string>;
      spawnPosition: { x: number; y: number };
    };
  };

  return room;
}

function installGame(rooms: MockRoom[]): void {
  const spawns = Object.fromEntries(
    rooms.map((room) => {
      const { spawnPosition } = (
        room as MockRoom & {
          _sourceContainerPlannerTest: { spawnPosition: { x: number; y: number } };
        }
      )._sourceContainerPlannerTest;
      const spawn = {
        name: `Spawn-${room.name}`,
        room,
        pos: { ...spawnPosition, roomName: room.name } as RoomPosition
      } as unknown as StructureSpawn;
      return [spawn.name, spawn];
    })
  ) as Record<string, StructureSpawn>;

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    rooms: Object.fromEntries(rooms.map((room) => [room.name, room])) as Record<string, Room>,
    spawns,
    creeps: {},
    map: {
      getRoomTerrain: jest.fn((roomName: string) => {
        const room = rooms.find((candidate) => candidate.name === roomName) as MockRoom & {
          _sourceContainerPlannerTest?: { wallPositions: Set<string> };
        };
        const wallPositions = room?._sourceContainerPlannerTest?.wallPositions ?? new Set<string>();
        return {
          get: jest.fn((x: number, y: number) => (wallPositions.has(`${x},${y}`) ? TERRAIN_MASK_WALL : 0))
        };
      })
    } as unknown as GameMap
  };
}

function makeSource(id: string, x: number, y: number, roomName: string): Source {
  return {
    id,
    pos: { x, y, roomName } as RoomPosition
  } as unknown as Source;
}

function makeStructure(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  roomName: string
): AnyStructure {
  return {
    id,
    structureType,
    pos: { x, y, roomName } as RoomPosition
  } as unknown as AnyStructure;
}

function makeConstructionSite(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  roomName: string
): ConstructionSite {
  return {
    id,
    structureType,
    pos: { x, y, roomName } as RoomPosition
  } as ConstructionSite;
}

function makeDroppedEnergy(
  id: string,
  x: number,
  y: number,
  roomName: string
): Resource<ResourceConstant> {
  return {
    id,
    resourceType: 'energy',
    amount: 50,
    ticksToDecay: 100,
    pos: { x, y, roomName } as RoomPosition
  } as unknown as Resource<ResourceConstant>;
}

function makeRemoteHarvester(
  room: Room,
  sourceId: Id<Source>,
  {
    usedEnergy,
    freeEnergy
  }: {
    usedEnergy: number;
    freeEnergy: number;
  }
): Creep {
  return {
    memory: {
      role: 'remoteHarvester',
      colony: 'W1N1',
      remoteHarvester: {
        homeRoom: 'W1N1',
        targetRoom: room.name,
        sourceId
      }
    },
    room,
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? usedEnergy : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeEnergy : 0))
    }
  } as unknown as Creep;
}
