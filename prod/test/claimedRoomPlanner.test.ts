import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planClaimedRoomConstruction } from '../src/construction/claimed-room-planner';

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_MY_STRUCTURES: 2,
  FIND_MY_CONSTRUCTION_SITES: 3,
  FIND_STRUCTURES: 4,
  FIND_CONSTRUCTION_SITES: 5,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  LOOK_MINERALS: 'mineral',
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_STORAGE: 'storage',
  STRUCTURE_WALL: 'constructedWall',
  TERRAIN_MASK_WALL: 1,
  OK: OK_CODE
} as const;

describe('claimed room construction planner', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(TEST_GLOBALS)) {
      globals[key] = value;
    }
    globals.CONTROLLER_STRUCTURES = makeControllerStructures();
    installOpenTerrain();
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }
    delete globals.CONTROLLER_STRUCTURES;
    delete globals.Game;
    delete globals.Memory;
    delete globals.PathFinder;
  });

  it('yields without placing sites when no room energy or assigned builders are available', () => {
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 0,
      sources: [makeSource('source-a', 20, 10)]
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {};

    const result = planClaimedRoomConstruction(colony);

    expect(result).toMatchObject({
      roomName: 'W2N1',
      active: true,
      yielded: true,
      yieldReason: 'noEnergyOrCreeps',
      placements: []
    });
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('plans claimed-room extensions once build resources are available', () => {
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 100,
      sources: []
    });

    const result = planClaimedRoomConstruction(colony, { respectRoomEnergyBuffer: false });

    expect(result.yielded).toBe(false);
    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension']);
    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 24, STRUCTURE_EXTENSION);
  });

  it('continues E29N55 RCL2 extension buildout from four extensions to the fifth while preserving recovery energy', () => {
    const { room, colony } = makeColony({
      roomName: 'E29N55',
      controllerLevel: 2,
      energyAvailable: 250,
      energyCapacityAvailable: 500,
      spawnPosition: { x: 35, y: 23 },
      structures: [
        makeStructure('extension-1', TEST_GLOBALS.STRUCTURE_EXTENSION, 34, 22, 'E29N55'),
        makeStructure('extension-2', TEST_GLOBALS.STRUCTURE_EXTENSION, 36, 22, 'E29N55'),
        makeStructure('extension-3', TEST_GLOBALS.STRUCTURE_EXTENSION, 34, 24, 'E29N55'),
        makeStructure('extension-4', TEST_GLOBALS.STRUCTURE_EXTENSION, 36, 24, 'E29N55')
      ],
      sources: []
    });

    const result = planClaimedRoomConstruction(colony);

    expect(result.yielded).toBe(false);
    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension']);
    expect(result.energyReserved).toBe(50);
    expect(result.energyAvailable - result.energyReserved).toBe(200);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(33, 21, STRUCTURE_EXTENSION);
  });

  it('plans source containers before source-to-spawn roads in claimed rooms', () => {
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 1_000,
      controllerPosition: { x: 10, y: 20 },
      sources: [makeSource('source-a', 20, 10)],
      structures: makeExtensions(5),
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }],
        '10,20': [{ x: 10, y: 11 }]
      }
    });
    installPathFinder(room);

    const result = planClaimedRoomConstruction(colony);

    expect(result.placements.map((placement) => placement.priority)).toEqual([
      'container',
      'road',
      'rampart',
      'wall'
    ]);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 19, 11, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(10, 11, STRUCTURE_ROAD);
  });

  it('places both E17S59 RCL2 source containers before roads while preserving the energy buffer', () => {
    const { room, colony } = makeColony({
      roomName: 'E17S59',
      controllerLevel: 2,
      energyAvailable: 350,
      energyCapacityAvailable: 350,
      controllerPosition: { x: 25, y: 25 },
      sources: [
        makeSource('e17s59-source-a', 20, 10, 'E17S59'),
        makeSource('e17s59-source-b', 30, 30, 'E17S59')
      ],
      structures: makeExtensions(5, 'E17S59'),
      pathsByTarget: {
        '20,10': [{ x: 24, y: 24 }],
        '30,30': [{ x: 26, y: 26 }]
      }
    });
    installPathFinder(room);

    const result = planClaimedRoomConstruction(colony);

    expect(result.placements.map((placement) => placement.priority)).toEqual(['container', 'container']);
    expect(result.energyReserved).toBe(100);
    expect(result.energyAvailable - result.energyReserved).toBeGreaterThanOrEqual(200);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 19, 11, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 29, 29, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(24, 24, STRUCTURE_ROAD);
  });

  it('plans post-claim spawn construction before follow-up sites when the room has no spawn', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'spawnSitePending',
            claimedAt: 813,
            updatedAt: 813,
            workerTarget: 2
          }
        }
      }
    };
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_000,
      controllerPosition: { x: 25, y: 25 },
      includeSpawn: false,
      sources: [makeSource('source-a', 20, 10)],
      structures: makeExtensions(19),
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });
    installPathFinder(room);

    const result = planClaimedRoomConstruction(colony, {
      maxContainerSitesPerTick: 1,
      respectRoomEnergyBuffer: false
    });

    expect(result.placements.map((placement) => placement.priority)).toEqual([
      'spawn',
      'extension',
      'container',
      'tower',
      'rampart',
      'storage'
    ]);
    expect(room.createConstructionSite.mock.calls.map(([, , structureType]) => structureType)).toEqual([
      STRUCTURE_SPAWN,
      STRUCTURE_EXTENSION,
      STRUCTURE_CONTAINER,
      STRUCTURE_TOWER,
      STRUCTURE_RAMPART,
      STRUCTURE_STORAGE
    ]);
  });

  it('uses the E18S59 post-claim construction order after the first spawn exists', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          E18S59: {
            colony: 'E17S59',
            roomName: 'E18S59',
            status: 'spawningWorkers',
            claimedAt: 837,
            updatedAt: 838,
            workerTarget: 2,
            controllerId: 'controller-e18s59' as Id<StructureController>
          }
        }
      }
    };
    const { room, colony } = makeColony({
      roomName: 'E18S59',
      controllerLevel: 4,
      energyAvailable: 2_000,
      energyCapacityAvailable: 2_000,
      controllerPosition: { x: 25, y: 25 },
      sources: [makeSource('e18s59-source-a', 20, 10, 'E18S59')],
      structures: makeExtensions(19, 'E18S59'),
      pathsByTarget: {
        '20,10': [{ x: 23, y: 25 }]
      }
    });
    installPathFinder(room);

    const result = planClaimedRoomConstruction(colony, {
      maxContainerSitesPerTick: 1,
      respectRoomEnergyBuffer: false
    });

    expect(result.placements.map((placement) => placement.priority)).toEqual([
      'extension',
      'container',
      'road',
      'tower',
      'rampart',
      'storage'
    ]);
    expect(room.createConstructionSite.mock.calls.map(([, , structureType]) => structureType)).toEqual([
      STRUCTURE_EXTENSION,
      STRUCTURE_CONTAINER,
      STRUCTURE_ROAD,
      STRUCTURE_TOWER,
      STRUCTURE_RAMPART,
      STRUCTURE_STORAGE
    ]);
  });
});

interface TestPosition {
  x: number;
  y: number;
}

interface MockRoom extends Room {
  createConstructionSite: jest.Mock;
}

interface MakeColonyOptions {
  controllerLevel: number;
  energyAvailable: number;
  energyCapacityAvailable?: number;
  roomName?: string;
  controllerPosition?: TestPosition;
  spawnPosition?: TestPosition;
  includeSpawn?: boolean;
  sources: Source[];
  structures?: Structure[];
  pathsByTarget?: Record<string, TestPosition[]>;
}

class MockCostMatrix {
  set(): void {}
  get(): number {
    return 0;
  }
  clone(): CostMatrix {
    return new MockCostMatrix() as unknown as CostMatrix;
  }
  serialize(): number[] {
    return [];
  }
}

function makeColony(options: MakeColonyOptions): { room: MockRoom; colony: ColonySnapshot } {
  const constructionSites: ConstructionSite[] = [];
  const roomName = options.roomName ?? 'W2N1';
  const controller = {
    id: 'controller1',
    my: true,
    level: options.controllerLevel,
    pos: makeRoomPosition(options.controllerPosition ?? { x: 25, y: 25 }, roomName)
  } as unknown as StructureController;
  const room = {
    name: roomName,
    energyAvailable: options.energyAvailable,
    energyCapacityAvailable: options.energyCapacityAvailable ?? Math.max(300, options.energyAvailable),
    controller,
    find: jest.fn((findType: number, findOptions?: { filter?: (target: unknown) => boolean }) => {
      const targets =
        findType === TEST_GLOBALS.FIND_SOURCES
          ? options.sources
          : findType === TEST_GLOBALS.FIND_MY_STRUCTURES || findType === TEST_GLOBALS.FIND_STRUCTURES
            ? structures
            : findType === TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES ||
                findType === TEST_GLOBALS.FIND_CONSTRUCTION_SITES
              ? constructionSites
              : [];

      return findOptions?.filter ? targets.filter(findOptions.filter) : targets;
    }),
    lookForAtArea: jest.fn((lookType: LookConstant, top: number, left: number, bottom: number, right: number) => {
      if (lookType === TEST_GLOBALS.LOOK_STRUCTURES) {
        return getAreaLookResults(structures, top, left, bottom, right, 'structure');
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return getAreaLookResults(constructionSites, top, left, bottom, right, 'constructionSite');
      }

      return [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
      constructionSites.push(makeConstructionSite(`site-${x}-${y}`, structureType, x, y, roomName));
      return OK_CODE;
    }),
    __pathsByTarget: options.pathsByTarget ?? {}
  } as unknown as MockRoom & { __pathsByTarget: Record<string, TestPosition[]> };
  const spawn = {
    id: 'spawn1',
    name: 'Spawn1',
    room,
    structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
    pos: makeRoomPosition(options.spawnPosition ?? { x: 25, y: 25 }, roomName)
  } as unknown as StructureSpawn;
  const structures = [
    ...(options.includeSpawn === false ? [] : [spawn as unknown as Structure]),
    ...(options.structures ?? [])
  ];

  return {
    room,
    colony: {
      room,
      spawns: options.includeSpawn === false ? [] : [spawn],
      energyAvailable: options.energyAvailable,
      energyCapacityAvailable: options.energyCapacityAvailable ?? Math.max(300, options.energyAvailable)
    }
  };
}

function makeControllerStructures(): Record<string, number[]> {
  return {
    spawn: [0, 1, 1, 1, 1, 1, 1, 2, 3],
    extension: [0, 0, 5, 10, 20, 30, 40, 50, 60],
    road: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
    container: [0, 0, 5, 5, 5, 5, 5, 5, 5],
    rampart: [0, 0, 300, 300, 300, 300, 300, 300, 300],
    tower: [0, 0, 0, 1, 1, 2, 2, 3, 6],
    storage: [0, 0, 0, 0, 1, 1, 1, 1, 1]
  };
}

function installOpenTerrain(): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    creeps: {},
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(0)
      })
    } as unknown as GameMap
  };
}

function installPathFinder(room: MockRoom): void {
  const pathsByTarget = (room as MockRoom & { __pathsByTarget?: Record<string, TestPosition[]> }).__pathsByTarget ?? {};
  const pathFinderSearch = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => ({
    path: (
      pathsByTarget[getRouteKey(origin, goal)] ??
      pathsByTarget[getPositionKey(goal.pos)] ??
      []
    ).map((position) => makeRoomPosition(position, room.name)),
    ops: 1,
    cost: 1,
    incomplete: false
  }));

  (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
    CostMatrix: MockCostMatrix as unknown as typeof PathFinder.CostMatrix,
    search: pathFinderSearch as unknown as typeof PathFinder.search
  };
}

function makeExtensions(count: number, roomName = 'W2N1'): Structure[] {
  return Array.from({ length: count }, (_, index) =>
    makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 35 + index, 35, roomName)
  );
}

function makeSource(id: string, x: number, y: number, roomName = 'W2N1'): Source {
  return {
    id,
    pos: makeRoomPosition({ x, y }, roomName)
  } as unknown as Source;
}

function makeStructure(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  roomName = 'W2N1'
): Structure {
  return {
    id,
    structureType,
    pos: makeRoomPosition({ x, y }, roomName)
  } as unknown as Structure;
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
    pos: makeRoomPosition({ x, y }, roomName)
  } as unknown as ConstructionSite;
}

function getAreaLookResults(
  objects: Array<Structure | ConstructionSite>,
  top: number,
  left: number,
  bottom: number,
  right: number,
  nestedKey: 'structure' | 'constructionSite'
): unknown[] {
  return objects.flatMap((object) => {
    const position = object.pos;
    if (position.x < left || position.x > right || position.y < top || position.y > bottom) {
      return [];
    }

    return [{ x: position.x, y: position.y, [nestedKey]: object }];
  });
}

function makeRoomPosition(position: TestPosition, roomName: string): RoomPosition {
  return { ...position, roomName } as RoomPosition;
}

function getRouteKey(origin: RoomPosition, goal: { pos: RoomPosition }): string {
  return `${getPositionKey(origin)}->${getPositionKey(goal.pos)}`;
}

function getPositionKey(position: { x: number; y: number }): string {
  return `${position.x},${position.y}`;
}
