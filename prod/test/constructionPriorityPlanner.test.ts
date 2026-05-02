import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  planPriorityConstructionSites,
  planSourceContainerConstruction
} from '../src/construction/constructionPriority';

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_STRUCTURES: 2,
  FIND_CONSTRUCTION_SITES: 3,
  FIND_MY_STRUCTURES: 4,
  FIND_MY_CONSTRUCTION_SITES: 5,
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_ROAD: 'road',
  TERRAIN_MASK_WALL: 1,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  OK: OK_CODE
} as const;

describe('construction priority placement loop', () => {
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

  it('skips automated construction below RCL2', () => {
    const { room, colony } = makeColony({
      controllerLevel: 1,
      sources: [makeSource('source-a', { x: 20, y: 20 })]
    });

    expect(planPriorityConstructionSites(colony)).toEqual({
      sourceContainerResults: [],
      extensionResult: null,
      roadResults: []
    });
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places source container and extension sites at RCL2 without road planning', () => {
    const { room, colony, pathFinderSearch } = makeColony({
      controllerLevel: 2,
      sources: [makeSource('source-a', { x: 20, y: 20 })],
      pathsByTarget: {
        '20,20': [{ x: 21, y: 20 }]
      }
    });

    expect(planPriorityConstructionSites(colony)).toEqual({
      sourceContainerResults: [OK_CODE],
      extensionResult: OK_CODE,
      roadResults: []
    });

    expect(room.createConstructionSite).toHaveBeenCalledTimes(2);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 21, 21, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 24, 24, STRUCTURE_EXTENSION);
    expect(pathFinderSearch).not.toHaveBeenCalled();
  });

  it('continues placing one source container per tick until each source has coverage', () => {
    const { room, colony } = makeColony({
      controllerLevel: 2,
      sources: [
        makeSource('source-a', { x: 20, y: 20 }),
        makeSource('source-b', { x: 30, y: 30 })
      ]
    });

    expect(planSourceContainerConstruction(colony)).toEqual([OK_CODE]);
    expect(planSourceContainerConstruction(colony)).toEqual([OK_CODE]);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(2);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 21, 21, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 29, 29, STRUCTURE_CONTAINER);
  });

  it('adds road planning at RCL4 while deferring roads at RCL3', () => {
    const rcl3 = makeColony({
      controllerLevel: 3,
      sources: [makeSource('source-a', { x: 20, y: 10 })],
      structures: [makeStructure('container-a', STRUCTURE_CONTAINER, { x: 20, y: 9 })],
      extensionCount: 10,
      spawnPosition: { x: 10, y: 10 },
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    expect(planPriorityConstructionSites(rcl3.colony)).toEqual({
      sourceContainerResults: [],
      extensionResult: null,
      roadResults: []
    });
    expect(rcl3.pathFinderSearch).not.toHaveBeenCalled();
    expect(rcl3.room.createConstructionSite).not.toHaveBeenCalled();

    const rcl4 = makeColony({
      controllerLevel: 4,
      sources: [makeSource('source-a', { x: 20, y: 10 })],
      structures: [makeStructure('container-a', STRUCTURE_CONTAINER, { x: 20, y: 9 })],
      extensionCount: 20,
      spawnPosition: { x: 10, y: 10 },
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    expect(planPriorityConstructionSites(rcl4.colony)).toEqual({
      sourceContainerResults: [],
      extensionResult: null,
      roadResults: [OK_CODE]
    });
    expect(rcl4.pathFinderSearch).toHaveBeenCalled();
    expect(rcl4.room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(rcl4.room.createConstructionSite).toHaveBeenCalledWith(11, 10, STRUCTURE_ROAD);
  });
});

interface MockRoom extends Room {
  createConstructionSite: jest.Mock;
  find: jest.Mock;
  lookForAtArea: jest.Mock;
}

interface TestPosition {
  x: number;
  y: number;
}

interface MakeColonyOptions {
  constructionSites?: ConstructionSite[];
  controllerLevel: number;
  controllerPosition?: TestPosition;
  extensionCount?: number;
  pathsByTarget?: Record<string, TestPosition[]>;
  sources: Source[];
  spawnPosition?: TestPosition;
  structures?: Structure[];
  wallPositions?: Set<string>;
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

function makeColony(options: MakeColonyOptions): {
  colony: ColonySnapshot;
  pathFinderSearch: jest.Mock;
  room: MockRoom;
} {
  const roomName = 'W1N1';
  const wallPositions = options.wallPositions ?? new Set<string>();
  const constructionSites = [...(options.constructionSites ?? [])];
  const structures = [
    ...(options.structures ?? []),
    ...Array.from({ length: options.extensionCount ?? 0 }, (_, index) =>
      makeStructure(`extension-${index}`, STRUCTURE_EXTENSION, {
        x: 40 + (index % 5),
        y: 40 + Math.floor(index / 5)
      })
    )
  ];
  const controller = {
    id: 'controller1',
    my: true,
    level: options.controllerLevel,
    pos: makeRoomPosition(options.controllerPosition ?? { x: 25, y: 25 }, roomName)
  } as unknown as StructureController;
  const room = {
    name: roomName,
    controller,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: jest.fn((findType: number, findOptions?: { filter?: (target: Source | Structure | ConstructionSite) => boolean }) => {
      const targets =
        findType === TEST_GLOBALS.FIND_SOURCES
          ? options.sources
          : findType === TEST_GLOBALS.FIND_STRUCTURES || findType === TEST_GLOBALS.FIND_MY_STRUCTURES
            ? structures
            : findType === TEST_GLOBALS.FIND_CONSTRUCTION_SITES ||
                findType === TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES
              ? constructionSites
              : [];

      return findOptions?.filter ? targets.filter(findOptions.filter) : targets;
    }),
    lookForAtArea: jest.fn((lookType: string, top: number, left: number, bottom: number, right: number) => {
      if (lookType === TEST_GLOBALS.LOOK_STRUCTURES) {
        return getLookResults(structures, top, left, bottom, right, 'structure');
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return getLookResults(constructionSites, top, left, bottom, right, 'constructionSite');
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
    pos: makeRoomPosition(options.spawnPosition ?? { x: 25, y: 25 }, roomName)
  } as unknown as StructureSpawn;
  const pathFinderSearch = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => ({
    cost: 1,
    incomplete: false,
    ops: 1,
    path: (options.pathsByTarget?.[getRouteKey(origin, goal)] ??
      options.pathsByTarget?.[getPositionKey(goal.pos)] ??
      []).map((position) => makeRoomPosition(position, roomName))
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
    colony: {
      room,
      spawns: [spawn],
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    },
    pathFinderSearch,
    room
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

function getLookResults<T extends Structure | ConstructionSite>(
  objects: T[],
  top: number,
  left: number,
  bottom: number,
  right: number,
  property: 'structure' | 'constructionSite'
): LookAtResultWithPos[] {
  return objects.flatMap((object) => {
    const position = (object as { pos?: RoomPosition }).pos;
    return position && position.x >= left && position.x <= right && position.y >= top && position.y <= bottom
      ? [{ x: position.x, y: position.y, [property]: object } as unknown as LookAtResultWithPos]
      : [];
  });
}

function getPositionKey(position: TestPosition): string {
  return `${position.x},${position.y}`;
}

function getRouteKey(origin: unknown, goal: unknown): string {
  return `${getPositionKey(origin as TestPosition)}->${getPositionKey((goal as { pos: TestPosition }).pos)}`;
}
