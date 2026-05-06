import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planConstructionForColony } from '../src/construction/planner';

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
  STRUCTURE_TOWER: 'tower',
  TERRAIN_MASK_WALL: 1,
  OK: OK_CODE
} as const;

describe('owned room construction planner', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(TEST_GLOBALS)) {
      globals[key] = value;
    }
    globals.CONTROLLER_STRUCTURES = makeControllerStructures();
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }
    delete globals.CONTROLLER_STRUCTURES;
    delete globals.Game;
    delete globals.PathFinder;
  });

  it('queues essential sites in spawn, extension, road, container, tower priority order', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: 1_000,
      structures: [
        ...Array.from({ length: 9 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }],
        '25,25': [{ x: 10, y: 11 }]
      }
    });

    const result = planConstructionForColony(colony);

    expect(result.placements.map((placement) => placement.priority)).toEqual([
      'extension',
      'road',
      'container',
      'tower'
    ]);
    expect(room.createConstructionSite.mock.calls.map(([, , structureType]) => structureType)).toEqual([
      STRUCTURE_EXTENSION,
      STRUCTURE_ROAD,
      STRUCTURE_CONTAINER,
      STRUCTURE_TOWER
    ]);
    expect(result.energyBudget).toBe(500);
    expect(result.energyReserved).toBe(200);
  });

  it('keeps non-spawn construction site placement within half of available room energy', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: 100,
      structures: [
        ...Array.from({ length: 9 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony);

    expect(result.energyBudget).toBe(50);
    expect(result.energyReserved).toBe(50);
    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension']);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(9, 9, STRUCTURE_EXTENSION);
  });

  it('respects CONTROLLER_STRUCTURES counts before calling lower-level planners', () => {
    const controllerStructures = makeControllerStructures();
    controllerStructures.extension[2] = 1;
    controllerStructures.road[2] = 0;
    controllerStructures.container[2] = 0;
    controllerStructures.tower[2] = 0;
    (globalThis as unknown as { CONTROLLER_STRUCTURES: ReturnType<typeof makeControllerStructures> }).CONTROLLER_STRUCTURES =
      controllerStructures;
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 1_000,
      structures: [makeStructure('extension-existing', TEST_GLOBALS.STRUCTURE_EXTENSION, 30, 30)],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony);

    expect(result.placements).toEqual([]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places a missing spawn site even when a newly claimed room has no stored spawn energy', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 1,
      energyAvailable: 0,
      includeSpawn: false,
      sources: [makeSource('source-a', 21, 21)],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony);

    expect(result.placements).toEqual([
      {
        priority: 'spawn',
        roomName: 'W1N1',
        structureType: STRUCTURE_SPAWN,
        result: OK_CODE,
        energyReserved: 0,
        x: 23,
        y: 23
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, STRUCTURE_SPAWN);
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
  controllerLevel: number;
  energyAvailable: number;
  includeSpawn?: boolean;
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
  sources: Source[];
  pathsByTarget: Record<string, TestPosition[]>;
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
  const roomName = 'W1N1';
  const constructionSites = [...(options.constructionSites ?? [])];
  const controller = {
    id: 'controller1',
    my: true,
    level: options.controllerLevel,
    pos: makeRoomPosition(25, 25, roomName)
  } as unknown as StructureController;
  const room = {
    name: roomName,
    energyAvailable: options.energyAvailable,
    energyCapacityAvailable: options.energyAvailable,
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
    })
  } as unknown as MockRoom;
  const spawn = {
    id: 'spawn1',
    name: 'Spawn1',
    room,
    structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
    pos: makeRoomPosition(10, 10, roomName)
  } as unknown as StructureSpawn;
  const structures = [
    ...(options.includeSpawn === false ? [] : [spawn as unknown as Structure]),
    ...(options.structures ?? [])
  ];
  const pathFinderSearch = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => ({
    path: (
      options.pathsByTarget[getRouteKey(origin, goal)] ??
      options.pathsByTarget[getPositionKey(goal.pos)] ??
      []
    ).map((position) => makeRoomPosition(position.x, position.y, roomName)),
    ops: 1,
    cost: 1,
    incomplete: false
  }));

  (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
    CostMatrix: MockCostMatrix as unknown as typeof PathFinder.CostMatrix,
    search: pathFinderSearch as unknown as typeof PathFinder.search
  };

  return {
    room,
    colony: {
      room,
      spawns: options.includeSpawn === false ? [] : [spawn],
      energyAvailable: options.energyAvailable,
      energyCapacityAvailable: options.energyAvailable
    }
  };
}

function installOpenTerrain(): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(0)
      })
    } as unknown as GameMap
  };
}

function makeControllerStructures(): Record<string, number[]> {
  return {
    spawn: [0, 1, 1, 1, 1, 1, 1, 2, 3],
    extension: [0, 0, 5, 10, 20, 30, 40, 50, 60],
    road: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
    container: [0, 0, 5, 5, 5, 5, 5, 5, 5],
    tower: [0, 0, 0, 1, 1, 2, 2, 3, 6]
  };
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

function makeSource(id: string, x: number, y: number, roomName = 'W1N1'): Source {
  return {
    id,
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as Source;
}

function makeStructure(id: string, structureType: StructureConstant, x: number, y: number): Structure {
  return {
    id,
    structureType,
    pos: makeRoomPosition(x, y)
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
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as ConstructionSite;
}

function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function getRouteKey(origin: RoomPosition, goal: { pos: RoomPosition }): string {
  return `${getPositionKey(origin)}->${getPositionKey(goal.pos)}`;
}

function getPositionKey(position: { x: number; y: number }): string {
  return `${position.x},${position.y}`;
}
