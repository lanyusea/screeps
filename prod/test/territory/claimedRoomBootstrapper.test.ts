import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../../src/telemetry/runtimeSummary';
import {
  refreshClaimedRoomBootstrapperOwnership,
  runClaimedRoomBootstrapper
} from '../../src/territory/claimedRoomBootstrapper';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_RCL_NOT_ENOUGH_CODE = -14 as ScreepsReturnCode;
const MAX_SPAWN_SITE_SCAN_WIDTH = 17;

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
  OK: OK_CODE,
  ERR_FULL: ERR_FULL_CODE,
  ERR_RCL_NOT_ENOUGH: ERR_RCL_NOT_ENOUGH_CODE
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

  it('transitions a newly owned E18S59 claim into post-claim bootstrap and places the first spawn', () => {
    const { room } = makeBootstrapRoom({
      roomName: 'E18S59',
      controllerLevel: 1,
      sources: [makeSource('e18s59-source-a', 21, 21, 'E18S59')]
    });
    (room as Room & { memory?: RoomMemory }).memory = {};
    const homeRoom = {
      name: 'E17S59',
      controller: { my: true },
      energyAvailable: 650,
      energyCapacityAvailable: 650
    } as Room;
    const homeSpawn = { name: 'Spawn1', room: homeRoom, spawning: null } as StructureSpawn;
    Memory.territory = {
      claimedRoomBootstrapper: {
        rooms: {
          E18S59: { roomName: 'E18S59', owned: false, updatedAt: 836 }
        }
      },
      targets: [
        {
          colony: 'E17S59',
          roomName: 'E18S59',
          action: 'claim',
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller1' as Id<StructureController>
        }
      ]
    };
    installGameRooms([homeRoom, room], 837);
    (globalThis as unknown as { Game: Partial<Game> }).Game.spawns = { Spawn1: homeSpawn };

    const events: RuntimeTelemetryEvent[] = [];
    const result = refreshClaimedRoomBootstrapperOwnership(events);

    expect(result.detectedRoomNames).toEqual(['E18S59']);
    expect(Memory.territory?.postClaimBootstraps?.E18S59).toMatchObject({
      colony: 'E17S59',
      roomName: 'E18S59',
      status: 'spawnSitePending',
      claimedAt: 837,
      updatedAt: 837,
      controllerId: 'controller1',
      spawnSite: { roomName: 'E18S59', x: 23, y: 23 },
      lastResult: OK_CODE
    });
    expect((room as Room & { memory: RoomMemory }).memory.colonyStage?.mode).toBe('BOOTSTRAP');
    expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, TEST_GLOBALS.STRUCTURE_SPAWN);
    const [[x, y]] = room.createConstructionSite.mock.calls;
    expect(x).toBeGreaterThanOrEqual(2);
    expect(y).toBeGreaterThanOrEqual(2);
    expect(x).toBeLessThanOrEqual(47);
    expect(y).toBeLessThanOrEqual(47);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'postClaimBootstrap',
          roomName: 'E18S59',
          colony: 'E17S59',
          phase: 'spawnSite'
        })
      ])
    );
  });

  it('recovers already-owned spawnless secondary rooms that missed post-claim bootstrap records', () => {
    const secondaryRooms = ['E17S58', 'E27S48', 'E27S49'].map((roomName) =>
      makeBootstrapRoom({
        roomName,
        controllerLevel: 1,
        sources: [makeSource(`${roomName}-source-a`, 21, 21, roomName)]
      })
    );
    const homeRoom = {
      name: 'E17S59',
      controller: { my: true, level: 4 },
      energyAvailable: 650,
      energyCapacityAvailable: 650
    } as Room;
    const homeSpawn = { name: 'Spawn1', room: homeRoom, spawning: null } as StructureSpawn;
    const previousRooms = {
      E17S58: { roomName: 'E17S58', owned: true, claimedAt: 786700, updatedAt: 786700 },
      E27S48: { roomName: 'E27S48', owned: true, claimedAt: 786701, updatedAt: 786701 },
      E27S49: { roomName: 'E27S49', owned: true, claimedAt: 786702, updatedAt: 786702 }
    } as const;
    Memory.territory = {
      claimedRoomBootstrapper: {
        rooms: { ...previousRooms }
      }
    };
    installGameRooms([homeRoom, ...secondaryRooms.map(({ room }) => room)], 786805);
    (globalThis as unknown as { Game: Partial<Game> }).Game.spawns = { Spawn1: homeSpawn };

    const events: RuntimeTelemetryEvent[] = [];
    const result = refreshClaimedRoomBootstrapperOwnership(events);

    expect(result.detectedRoomNames).toEqual(['E17S58', 'E27S48', 'E27S49']);
    for (const { room } of secondaryRooms) {
      const previousRoom = previousRooms[room.name as keyof typeof previousRooms];
      expect(Memory.territory?.postClaimBootstraps?.[room.name]).toMatchObject({
        colony: 'E17S59',
        roomName: room.name,
        status: 'spawnSitePending',
        claimedAt: previousRoom.claimedAt,
        updatedAt: 786805,
        controllerId: 'controller1',
        spawnSite: { roomName: room.name, x: 23, y: 23 },
        lastResult: OK_CODE
      });
      expect(Memory.territory?.claimedRoomBootstrapper?.rooms[room.name]).toEqual({
        roomName: room.name,
        owned: true,
        claimedAt: previousRoom.claimedAt,
        updatedAt: 786805
      });
      expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, TEST_GLOBALS.STRUCTURE_SPAWN);
    }
    expect(events).toEqual(
      expect.arrayContaining(
        secondaryRooms.map(({ room }) =>
          expect.objectContaining({
            type: 'spawnSitePlaced',
            roomName: room.name,
            colony: 'E17S59',
            spawnSite: { roomName: room.name, x: 23, y: 23 }
          })
        )
      )
    );
  });

  it('recovers an established spawnless dynamic claim without a preconfigured target', () => {
    const { room } = makeBootstrapRoom({
      roomName: 'E17S58',
      controllerLevel: 4,
      sources: [makeSource('e17s58-source-a', 21, 21, 'E17S58')]
    });
    const homeRoom = {
      name: 'E17S59',
      controller: { my: true, level: 4 },
      energyAvailable: 650,
      energyCapacityAvailable: 650
    } as Room;
    const homeSpawn = { name: 'Spawn1', room: homeRoom, spawning: null } as StructureSpawn;
    Memory.territory = {
      claimedRoomBootstrapper: {
        rooms: {
          E17S58: { roomName: 'E17S58', owned: true, claimedAt: 786700, updatedAt: 786700 }
        }
      }
    };
    installGameRooms([homeRoom, room], 786805);
    (globalThis as unknown as { Game: Partial<Game> }).Game.spawns = { Spawn1: homeSpawn };

    const result = refreshClaimedRoomBootstrapperOwnership();

    expect(result.detectedRoomNames).toEqual(['E17S58']);
    expect(Memory.territory?.postClaimBootstraps?.E17S58).toMatchObject({
      colony: 'E17S59',
      roomName: 'E17S58',
      status: 'spawnSitePending',
      claimedAt: 786700,
      updatedAt: 786805,
      spawnSite: { roomName: 'E17S58', x: 23, y: 23 },
      lastResult: OK_CODE
    });
    expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, TEST_GLOBALS.STRUCTURE_SPAWN);
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

  it.each([
    ['ERR_FULL', ERR_FULL_CODE],
    ['ERR_RCL_NOT_ENOUGH', ERR_RCL_NOT_ENOUGH_CODE]
  ])('stops spawn placement retries after fatal %s construction-site results', (_name, fatalResult) => {
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 1,
      sources: [makeSource('source1', 21, 21)]
    });
    room.createConstructionSite = jest.fn().mockReturnValue(fatalResult);
    installActiveBootstrapMemory(90, false);
    installGame(room, 101);

    const result = runClaimedRoomBootstrapper([colony]);

    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'spawn', result: fatalResult }]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
  });

  it('bounds spawn placement area lookups to a local scan window', () => {
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 1
    });
    installActiveBootstrapMemory();
    installGame(room);

    runClaimedRoomBootstrapper([colony]);

    expect(room.lookForAtArea).toHaveBeenCalled();
    for (const [, top, left, bottom, right] of room.lookForAtArea.mock.calls) {
      expect(bottom - top + 1).toBeLessThanOrEqual(MAX_SPAWN_SITE_SCAN_WIDTH);
      expect(right - left + 1).toBeLessThanOrEqual(MAX_SPAWN_SITE_SCAN_WIDTH);
    }
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

  it('gates tower placement until RCL3 and places it between controller and spawn anchors', () => {
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
    expect(rcl3.room.createConstructionSite).toHaveBeenCalledWith(23, 23, TEST_GLOBALS.STRUCTURE_TOWER);
  });

  it('ignores roads when choosing claimed-room tower anchors', () => {
    const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20);
    const distantRoads = Array.from({ length: 8 }, (_value, index) =>
      makeStructure(`road-${index}`, TEST_GLOBALS.STRUCTURE_ROAD, 40 + (index % 4), 42 + Math.floor(index / 4))
    );
    const distantRoadSites = Array.from({ length: 8 }, (_value, index) =>
      makeConstructionSite(`road-site-${index}`, TEST_GLOBALS.STRUCTURE_ROAD, 44 + (index % 4), 42 + Math.floor(index / 4))
    );
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 3,
      controllerPosition: { x: 20, y: 24 },
      sources: [],
      structures: [spawn, ...makeExtensions(10), ...distantRoads],
      constructionSites: distantRoadSites,
      spawns: [spawn as StructureSpawn]
    });
    installActiveBootstrapMemory();
    installGame(room);

    const result = runClaimedRoomBootstrapper([colony]);

    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'tower', result: OK_CODE }]);
    expect(room.createConstructionSite).toHaveBeenCalledWith(20, 22, TEST_GLOBALS.STRUCTURE_TOWER);
  });

  it('plans RCL3 claimed-room tower defense before adding more early roads', () => {
    const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 10, 10);
    const source = makeSource('source-a', 20, 10);
    const container = makeStructure('container-a', TEST_GLOBALS.STRUCTURE_CONTAINER, 20, 11);
    const { room, colony } = makeBootstrapRoom({
      controllerLevel: 3,
      controllerPosition: { x: 10, y: 20 },
      sources: [source],
      structures: [spawn, container, ...makeExtensions(10)],
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

    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'tower', result: OK_CODE }]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(15, 15, TEST_GLOBALS.STRUCTURE_TOWER);
  });

  it('skips blocked strategic tower positions when selecting claimed-room tower sites', () => {
    const rcl3 = makeTowerReadyRoom(3, new Set(['23,23']));
    installActiveBootstrapMemory();
    installGame(rcl3.room);

    const result = runClaimedRoomBootstrapper([rcl3.colony]);

    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'tower', result: OK_CODE }]);
    expect(rcl3.room.createConstructionSite).toHaveBeenCalledWith(22, 22, TEST_GLOBALS.STRUCTURE_TOWER);
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

  it('limits claimed-room bootstrap planning to the oldest active room', () => {
    const older = makeBootstrapRoom({ controllerLevel: 1 });
    const newer = makeBootstrapRoom({ controllerLevel: 1, roomName: 'W3N1' });
    Memory.territory = {
      claimedRoomBootstrapper: {
        rooms: {
          W3N1: { roomName: 'W3N1', owned: true, claimedAt: 90, updatedAt: 90 },
          W2N1: { roomName: 'W2N1', owned: true, claimedAt: 80, updatedAt: 90 }
        }
      }
    };
    installGameRooms([newer.room, older.room], 101);

    const result = runClaimedRoomBootstrapper([newer.colony, older.colony]);

    expect(result.activeRoomNames).toEqual(['W2N1']);
    expect(result.planned).toEqual([{ roomName: 'W2N1', phase: 'spawn', result: OK_CODE }]);
    expect(older.room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(newer.room.createConstructionSite).not.toHaveBeenCalled();
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
  roomName?: string;
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
  const roomName = options.roomName ?? 'W2N1';
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
    __pathsByTarget: options.pathsByTarget ?? {},
    __wallPositions: options.wallPositions ?? new Set<string>()
  } as unknown as MockRoom & {
    __pathsByTarget: Record<string, TestPosition[]>;
    __wallPositions: Set<string>;
  };

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

function makeTowerReadyRoom(
  controllerLevel: number,
  wallPositions: Set<string> = new Set()
): { room: MockRoom; colony: ColonySnapshot } {
  const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20);
  return makeBootstrapRoom({
    controllerLevel,
    sources: [],
    structures: [
      spawn,
      ...makeExtensions(controllerLevel >= 3 ? 10 : 5)
    ],
    spawns: [spawn as StructureSpawn],
    wallPositions
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
  installGameRooms([room], time);
}

function installGameRooms(rooms: Room[], time = 100): void {
  const roomsByName = Object.fromEntries(rooms.map((room) => [room.name, room]));
  const wallPositionsByRoom = new Map(
    rooms.map((room) => [
      room.name,
      (room as Room & { __wallPositions?: Set<string> }).__wallPositions ?? new Set<string>()
    ])
  );
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    rooms: roomsByName,
    map: {
      getRoomTerrain: jest.fn((roomName: string) => ({
        get: jest.fn((x: number, y: number) =>
          (wallPositionsByRoom.get(roomName) ?? new Set<string>()).has(`${x},${y}`)
            ? TEST_GLOBALS.TERRAIN_MASK_WALL
            : 0
        )
      }))
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

function makeSource(id: string, x: number, y: number, roomName = 'W2N1'): Source {
  return {
    id,
    pos: makeRoomPosition({ x, y }, roomName)
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
