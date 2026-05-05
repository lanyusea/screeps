import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import {
  refreshClaimedRoomBootstrapperOwnership,
  runClaimedRoomBootstrapper
} from '../../src/territory/claimedRoomBootstrapper';

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_MY_STRUCTURES: 2,
  FIND_MY_CONSTRUCTION_SITES: 3,
  FIND_STRUCTURES: 4,
  FIND_CONSTRUCTION_SITES: 5,
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_TOWER: 'tower',
  TERRAIN_MASK_WALL: 1,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  LOOK_MINERALS: 'mineral',
  OK: OK_CODE
} as const;

describe('claimed room bootstrapper', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(TEST_GLOBALS)) {
      globals[key] = value;
    }

    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }

    delete globals.Game;
    delete globals.Memory;
    delete globals.PathFinder;
  });

  it('detects controller ownership transitions from previously unowned visible rooms', () => {
    const { room } = makeBootstrapRoom({ controllerLevel: 1 });
    Memory.territory = {
      claimedRoomBootstrapper: {
        rooms: {
          W2N1: { roomName: 'W2N1', owned: false, updatedAt: 99 }
        }
      }
    };
    installGame(room, 100);

    expect(refreshClaimedRoomBootstrapperOwnership()).toEqual({ detectedRoomNames: ['W2N1'] });
    expect(Memory.territory?.claimedRoomBootstrapper?.rooms.W2N1).toEqual({
      roomName: 'W2N1',
      owned: true,
      claimedAt: 100,
      updatedAt: 100
    });
  });

  it('places the initial spawn site before other infrastructure', () => {
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 1,
      sources: [makeSource('source1', 21, 21)]
    });
    installActiveBootstrapMemory(90, false);
    installGame(room, 101);

    const result = runClaimedRoomBootstrapper([colony]);

    expect(result.detectedRoomNames).toEqual(['W2N1']);
    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'spawn', result: OK_CODE }]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, TEST_GLOBALS.STRUCTURE_SPAWN);
  });

  it('places extensions up to the current RCL limit after a spawn exists', () => {
    const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 25, 25);
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 2,
      structures: [spawn],
      spawns: [spawn as StructureSpawn]
    });
    installActiveBootstrapMemory();
    installGame(room);

    const result = runClaimedRoomBootstrapper([colony]);

    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'extension', result: OK_CODE }]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 24, TEST_GLOBALS.STRUCTURE_EXTENSION);
  });

  it('places one source container site per uncovered source after extension capacity is planned', () => {
    const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 25, 25);
    const extensions = makeExtensions(5);
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 2,
      sources: [makeSource('source-a', 10, 10), makeSource('source-b', 30, 10)],
      structures: [spawn, ...extensions],
      spawns: [spawn as StructureSpawn]
    });
    installActiveBootstrapMemory();
    installGame(room);

    const result = runClaimedRoomBootstrapper([colony]);

    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'sourceContainer', results: [OK_CODE, OK_CODE] }]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(2);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 11, 11, TEST_GLOBALS.STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 29, 11, TEST_GLOBALS.STRUCTURE_CONTAINER);
  });

  it('places source-to-spawn and spawn-to-controller roads after containers are covered', () => {
    const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 10, 10);
    const source = makeSource('source-a', 20, 10);
    const container = makeStructure('container-a', TEST_GLOBALS.STRUCTURE_CONTAINER, 20, 11);
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 2,
      controllerPosition: { x: 10, y: 20 },
      sources: [source],
      structures: [spawn, container, ...makeExtensions(5)],
      spawns: [spawn as StructureSpawn],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }],
        '10,20': [{ x: 10, y: 11 }]
      }
    });
    installActiveBootstrapMemory();
    installGame(room);
    installPathFinder(room);

    const result = runClaimedRoomBootstrapper([colony]);

    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'road', results: [OK_CODE] }]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 10, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('gates tower placement until RCL3', () => {
    const rcl2 = makeTowerReadyRoom(2);
    installActiveBootstrapMemory();
    installGame(rcl2.room);

    expect(runClaimedRoomBootstrapper([rcl2.colony]).planned).toEqual([]);
    expect(rcl2.room.createConstructionSite).not.toHaveBeenCalled();

    const rcl3 = makeTowerReadyRoom(3);
    installActiveBootstrapMemory();
    installGame(rcl3.room);

    expect(runClaimedRoomBootstrapper([rcl3.colony]).planned).toEqual([
      { roomName: 'W2N1', phase: 'tower', result: OK_CODE }
    ]);
    expect(rcl3.room.createConstructionSite).toHaveBeenCalledWith(19, 19, TEST_GLOBALS.STRUCTURE_TOWER);
  });

  it('does not re-place construction sites that already exist', () => {
    const spawnSite = makeConstructionSite('spawn-site', TEST_GLOBALS.STRUCTURE_SPAWN, 23, 23);
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 1,
      constructionSites: [spawnSite],
      sources: [makeSource('source1', 21, 21)]
    });
    installActiveBootstrapMemory();
    installGame(room);

    const result = runClaimedRoomBootstrapper([colony]);

    expect(result.planned).toEqual([]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});

interface MockRoom extends Room {
  find: jest.Mock;
  lookForAtArea: jest.Mock;
  createConstructionSite: jest.Mock;
}

interface TestPosition {
  x: number;
  y: number;
}

interface BootstrapRoomOptions {
  controllerLevel: number;
  controllerPosition?: TestPosition;
  sources?: Source[];
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
  spawns?: StructureSpawn[];
  wallPositions?: Set<string>;
  pathsByTarget?: Record<string, TestPosition[]>;
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

function makeBootstrapRoom(options: BootstrapRoomOptions): { room: MockRoom; colony: ColonySnapshot } {
  const constructionSites = [...(options.constructionSites ?? [])];
  const structures = [...(options.structures ?? [])];
  const sources = options.sources ?? [];
  const roomName = 'W2N1';
  const controller = {
    id: 'controller1',
    my: true,
    level: options.controllerLevel,
    pos: makeRoomPosition(options.controllerPosition ?? { x: 25, y: 25 }, roomName)
  } as unknown as StructureController;
  const room = {
    name: roomName,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    controller,
    find: jest.fn((findType: number, findOptions?: { filter?: (target: Source | Structure | ConstructionSite) => boolean }) => {
      const targets =
        findType === TEST_GLOBALS.FIND_SOURCES
          ? sources
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
        return structures.flatMap((structure) => toLookResult('structure', structure, top, left, bottom, right));
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return constructionSites.flatMap((site) => toLookResult('constructionSite', site, top, left, bottom, right));
      }

      return [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
      constructionSites.push(makeConstructionSite(`site-${x}-${y}`, structureType, x, y));
      return OK_CODE;
    }),
    __pathsByTarget: options.pathsByTarget ?? {}
  } as unknown as MockRoom & { __pathsByTarget: Record<string, TestPosition[]> };

  for (const structure of structures) {
    (structure as Structure & { room?: Room }).room = room;
  }

  return {
    room,
    colony: {
      room,
      spawns: options.spawns ?? [],
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    }
  };
}

function makeTowerReadyRoom(controllerLevel: number): { room: MockRoom; colony: ColonySnapshot } {
  const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20);
  return makeBootstrapRoom({
    controllerLevel,
    sources: [],
    structures: [
      spawn,
      ...makeExtensions(controllerLevel >= 3 ? 10 : 5)
    ],
    spawns: [spawn as StructureSpawn]
  });
}

function installActiveBootstrapMemory(updatedAt = 90, owned = true): void {
  Memory.territory = {
    claimedRoomBootstrapper: {
      rooms: {
        W2N1: {
          roomName: 'W2N1',
          owned,
          claimedAt: owned ? updatedAt : undefined,
          updatedAt
        }
      }
    }
  };
}

function installGame(room: Room, time = 100): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    rooms: { [room.name]: room },
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
    path: (pathsByTarget[getRouteKey(origin, goal)] ?? pathsByTarget[getPositionKey(goal.pos)] ?? []).map((position) =>
      makeRoomPosition(position, room.name)
    ),
    ops: 1,
    cost: 1,
    incomplete: false
  }));
  (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
    CostMatrix: MockCostMatrix as unknown as CostMatrix,
    search: pathFinderSearch as unknown as PathFinder['search']
  };
}

function makeExtensions(count: number): Structure[] {
  return Array.from({ length: count }, (_, index) =>
    makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 35 + (index % 5), 35 + Math.floor(index / 5))
  );
}

function makeSource(id: string, x: number, y: number): Source {
  return {
    id,
    pos: makeRoomPosition({ x, y }, 'W2N1')
  } as unknown as Source;
}

function makeStructure(id: string, structureType: StructureConstant, x: number, y: number): Structure {
  return {
    id,
    name: id,
    structureType,
    pos: makeRoomPosition({ x, y }, 'W2N1')
  } as unknown as Structure;
}

function makeConstructionSite(id: string, structureType: StructureConstant, x: number, y: number): ConstructionSite {
  return {
    id,
    structureType,
    pos: makeRoomPosition({ x, y }, 'W2N1')
  } as unknown as ConstructionSite;
}

function makeRoomPosition(position: TestPosition, roomName: string): RoomPosition {
  return { ...position, roomName } as RoomPosition;
}

function toLookResult(
  key: 'structure' | 'constructionSite',
  object: Structure | ConstructionSite,
  top: number,
  left: number,
  bottom: number,
  right: number
): LookAtResultWithPos[] {
  const position = object.pos;
  if (position.x < left || position.x > right || position.y < top || position.y > bottom) {
    return [];
  }

  return [{ x: position.x, y: position.y, [key]: object } as unknown as LookAtResultWithPos];
}

function getPositionKey(position: TestPosition): string {
  return `${position.x},${position.y}`;
}

function getRouteKey(origin: unknown, goal: unknown): string {
  return `${getPositionKey(origin as TestPosition)}->${getPositionKey((goal as { pos: TestPosition }).pos)}`;
}
