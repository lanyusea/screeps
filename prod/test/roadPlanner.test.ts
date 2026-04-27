import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planEarlyRoadConstruction } from '../src/construction/roadPlanner';

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_MY_CONSTRUCTION_SITES: 2,
  STRUCTURE_ROAD: 'road',
  STRUCTURE_EXTENSION: 'extension',
  TERRAIN_MASK_WALL: 1,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  OK: OK_CODE
} as const;

describe('early road planner', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(TEST_GLOBALS)) {
      globals[key] = value;
    }
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }

    delete globals.Game;
    delete globals.PathFinder;
  });

  it('places the shared route segment first in deterministic target order', () => {
    const { room, colony, pathFinderSearch } = makeColony({
      sources: [
        makeSource('source-b', { x: 20, y: 11 }),
        makeSource('source-a', { x: 20, y: 10 })
      ],
      controllerPosition: { x: 10, y: 20 },
      pathsByTarget: {
        '20,10': [
          { x: 11, y: 10 },
          { x: 12, y: 10 },
          { x: 13, y: 10 }
        ],
        '20,11': [
          { x: 11, y: 10 },
          { x: 12, y: 10 },
          { x: 12, y: 11 }
        ],
        '10,20': [
          { x: 10, y: 11 },
          { x: 10, y: 12 }
        ]
      }
    });

    expect(planEarlyRoadConstruction(colony)).toEqual([OK_CODE]);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 10, STRUCTURE_ROAD);
    expect(pathFinderSearch.mock.calls.map(([, goal]) => getGoalPositionKey(goal))).toEqual(['20,10', '20,11', '10,20']);
  });

  it('skips walls, occupied structures, existing roads, and construction sites', () => {
    const { room, colony } = makeColony({
      sources: [makeSource('source-a', { x: 20, y: 10 })],
      structures: [
        makeStructure('existing-road', TEST_GLOBALS.STRUCTURE_ROAD, { x: 11, y: 10 }),
        makeStructure('occupied-extension', TEST_GLOBALS.STRUCTURE_EXTENSION, { x: 14, y: 10 })
      ],
      constructionSites: [
        makeConstructionSite('pending-road', TEST_GLOBALS.STRUCTURE_ROAD, { x: 12, y: 10 }),
        makeConstructionSite('pending-extension', TEST_GLOBALS.STRUCTURE_EXTENSION, { x: 13, y: 10 })
      ],
      wallPositions: new Set(['15,10']),
      pathsByTarget: {
        '20,10': [
          { x: 11, y: 10 },
          { x: 12, y: 10 },
          { x: 13, y: 10 },
          { x: 14, y: 10 },
          { x: 15, y: 10 },
          { x: 16, y: 10 }
        ]
      }
    });

    expect(planEarlyRoadConstruction(colony)).toEqual([OK_CODE]);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(16, 10, STRUCTURE_ROAD);
  });

  it('caps created sites by per-tick and pending road budgets', () => {
    const { room, colony, pathFinderSearch } = makeColony({
      sources: [makeSource('source-a', { x: 20, y: 10 })],
      pathsByTarget: {
        '20,10': [
          { x: 11, y: 10 },
          { x: 12, y: 10 },
          { x: 13, y: 10 },
          { x: 14, y: 10 }
        ]
      }
    });

    expect(planEarlyRoadConstruction(colony, { maxSitesPerTick: 5, maxPendingRoadSites: 2 })).toEqual([
      OK_CODE,
      OK_CODE
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(2);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 11, 10, STRUCTURE_ROAD);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 12, 10, STRUCTURE_ROAD);

    pathFinderSearch.mockClear();
    expect(planEarlyRoadConstruction(colony, { maxSitesPerTick: 5, maxPendingRoadSites: 2 })).toEqual([]);
    expect(pathFinderSearch).not.toHaveBeenCalled();
  });
});

interface MockRoom extends Room {
  find: jest.Mock;
  createConstructionSite: jest.Mock;
  lookForAtArea: jest.Mock;
}

interface TestPosition {
  x: number;
  y: number;
}

interface MakeColonyOptions {
  sources: Source[];
  controllerPosition?: TestPosition;
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
  wallPositions?: Set<string>;
  pathsByTarget: Record<string, TestPosition[]>;
}

class MockCostMatrix {
  private readonly costs = new Map<string, number>();

  set(x: number, y: number, cost: number): void {
    this.costs.set(`${x},${y}`, cost);
  }

  get(x: number, y: number): number {
    return this.costs.get(`${x},${y}`) ?? 0;
  }

  clone(): CostMatrix {
    const clone = new MockCostMatrix();
    for (const [key, cost] of this.costs.entries()) {
      const [x, y] = key.split(',').map(Number);
      clone.set(x, y, cost);
    }

    return clone as unknown as CostMatrix;
  }

  serialize(): number[] {
    return [];
  }
}

function makeColony(options: MakeColonyOptions): { room: MockRoom; colony: ColonySnapshot; pathFinderSearch: jest.Mock } {
  const structures = options.structures ?? [];
  const constructionSites = [...(options.constructionSites ?? [])];
  const wallPositions = options.wallPositions ?? new Set<string>();
  const roomName = 'W1N1';
  const controller = {
    id: 'controller1',
    my: true,
    level: 2,
    pos: makeRoomPosition(options.controllerPosition ?? { x: 25, y: 25 }, roomName)
  } as unknown as StructureController;
  const room = {
    name: roomName,
    controller,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: jest.fn((findType: number, findOptions?: { filter?: (target: Source | ConstructionSite) => boolean }) => {
      const targets =
        findType === TEST_GLOBALS.FIND_SOURCES
          ? options.sources
          : findType === TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES
            ? constructionSites
            : [];

      return findOptions?.filter ? targets.filter(findOptions.filter) : targets;
    }),
    lookForAtArea: jest.fn((lookType: string, top: number, left: number, bottom: number, right: number) => {
      if (lookType === TEST_GLOBALS.LOOK_STRUCTURES) {
        return getStructureLookResults(structures, top, left, bottom, right);
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return getConstructionSiteLookResults(constructionSites, top, left, bottom, right);
      }

      return [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
      constructionSites.push(makeConstructionSite(`site-${x}-${y}`, structureType, { x, y }));
      return OK_CODE;
    })
  } as unknown as MockRoom;
  const spawn = {
    name: 'Spawn1',
    room,
    pos: makeRoomPosition({ x: 10, y: 10 }, roomName)
  } as unknown as StructureSpawn;
  const pathFinderSearch = jest.fn((_origin: RoomPosition, goal: { pos: RoomPosition }) => ({
    path: (options.pathsByTarget[getPositionKey(goal.pos)] ?? []).map((position) => makeRoomPosition(position, roomName)),
    ops: 1,
    cost: 1,
    incomplete: false
  }));

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: (x: number, y: number) => (wallPositions.has(`${x},${y}`) ? TEST_GLOBALS.TERRAIN_MASK_WALL : 0)
      })
    } as unknown as Game['map']
  };
  (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
    CostMatrix: MockCostMatrix as unknown as CostMatrix,
    search: pathFinderSearch as unknown as PathFinder['search']
  };

  return {
    room,
    colony: {
      room,
      spawns: [spawn],
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    },
    pathFinderSearch
  };
}

function makeSource(id: string, position: TestPosition): Source {
  return {
    id,
    pos: makeRoomPosition(position, 'W1N1')
  } as unknown as Source;
}

function makeStructure(id: string, structureType: StructureConstant, position: TestPosition): Structure {
  return {
    id,
    structureType,
    pos: makeRoomPosition(position, 'W1N1')
  } as unknown as Structure;
}

function makeConstructionSite(id: string, structureType: StructureConstant, position: TestPosition): ConstructionSite {
  return {
    id,
    structureType,
    pos: makeRoomPosition(position, 'W1N1')
  } as unknown as ConstructionSite;
}

function makeRoomPosition(position: TestPosition, roomName: string): RoomPosition {
  return { ...position, roomName } as RoomPosition;
}

function getStructureLookResults(structures: Structure[], top: number, left: number, bottom: number, right: number): LookAtResultWithPos[] {
  return structures.flatMap((structure) => {
    const position = (structure as { pos?: RoomPosition }).pos;
    return position && isWithinBounds(position, top, left, bottom, right)
      ? [{ x: position.x, y: position.y, structure } as LookAtResultWithPos]
      : [];
  });
}

function getConstructionSiteLookResults(
  constructionSites: ConstructionSite[],
  top: number,
  left: number,
  bottom: number,
  right: number
): LookAtResultWithPos[] {
  return constructionSites.flatMap((constructionSite) => {
    const position = (constructionSite as { pos?: RoomPosition }).pos;
    return position && isWithinBounds(position, top, left, bottom, right)
      ? [{ x: position.x, y: position.y, constructionSite } as LookAtResultWithPos]
      : [];
  });
}

function isWithinBounds(position: TestPosition, top: number, left: number, bottom: number, right: number): boolean {
  return position.x >= left && position.x <= right && position.y >= top && position.y <= bottom;
}

function getPositionKey(position: TestPosition): string {
  return `${position.x},${position.y}`;
}

function getGoalPositionKey(goal: unknown): string {
  const pathGoal = goal as { pos: TestPosition };
  return getPositionKey(pathGoal.pos);
}
