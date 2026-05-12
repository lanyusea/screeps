import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import { planSpawn } from '../../src/spawn/spawnPlanner';
import { runRecommendedExpansionClaimExecutor } from '../../src/territory/claimExecutor';
import { runClaimedRoomBootstrapper } from '../../src/territory/claimedRoomBootstrapper';
import { refreshExpansionExecutorIntent } from '../../src/territory/expansionExecutor';
import { recordPostClaimBootstrapClaimSuccess } from '../../src/territory/postClaimBootstrap';
import type { RuntimeTelemetryEvent } from '../../src/telemetry/runtimeSummary';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_MY_STRUCTURES: 2,
  FIND_MY_CONSTRUCTION_SITES: 3,
  FIND_STRUCTURES: 4,
  FIND_CONSTRUCTION_SITES: 5,
  FIND_HOSTILE_CREEPS: 6,
  FIND_HOSTILE_STRUCTURES: 7,
  FIND_MINERALS: 8,
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_STORAGE: 'storage',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_WALL: 'constructedWall',
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  LOOK_MINERALS: 'mineral',
  TERRAIN_MASK_WALL: 1,
  TERRAIN_MASK_SWAMP: 2,
  RESOURCE_ENERGY: 'energy',
  OK: OK_CODE
} as const;

interface TestRoomOptions {
  roomName: string;
  controllerLevel: number;
  owned?: boolean;
  sources?: Source[];
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
  spawns?: StructureSpawn[];
  controllerPosition?: TestPosition;
  pathsByTarget?: Record<string, TestPosition[]>;
}

interface TestPosition {
  x: number;
  y: number;
}

type MockRoom = Room & {
  createConstructionSite: jest.Mock<ScreepsReturnCode, [number, number, BuildableStructureConstant]>;
  lookForAtArea: jest.Mock;
  __pathsByTarget?: Record<string, TestPosition[]>;
  __structures: Structure[];
  __constructionSites: ConstructionSite[];
};

describe('E17S60 claimer dispatch and buildout', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(TEST_GLOBALS)) {
      globals[key] = value;
    }
    globals.BODYPART_COST = {
      move: 50,
      work: 100,
      carry: 50,
      attack: 80,
      ranged_attack: 150,
      heal: 250,
      claim: 600,
      tough: 10
    };
    globals.RoomPosition = jest.fn(
      (x: number, y: number, roomName: string) => ({ x, y, roomName }) as RoomPosition
    );
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }
    delete globals.BODYPART_COST;
    delete globals.RoomPosition;
    delete globals.Game;
    delete globals.Memory;
    delete globals.PathFinder;
  });

  it('dispatches a CLAIM/MOVE claimer for E17S60 after viable scout intel confirms the claim target', () => {
    const home = makeHomeColony();
    installExpansionGame(home, 900);
    installSafeHomeThreat(900);
    installE17S60ScoutIntel(899);

    expect(refreshExpansionExecutorIntent(home, 900)).toMatchObject({
      status: 'planned',
      colony: 'E17S59',
      targetRoom: 'E17S60',
      controllerId: 'controller-e17s60'
    });

    expect(planSpawn(home, { worker: 6, claimer: 0, claimersByTargetRoom: {} }, 901)).toEqual({
      spawn: home.spawns[0],
      body: ['claim', 'move'],
      name: 'claimer-E17S59-E17S60-901',
      memory: {
        role: 'claimer',
        colony: 'E17S59',
        territory: {
          targetRoom: 'E17S60',
          action: 'claim',
          controllerId: 'controller-e17s60'
        }
      }
    });
  });

  it('keeps E17S60 claim assignments retryable until the controller claim succeeds', () => {
    const home = makeHomeColony();
    const target = makeRoom({
      roomName: 'E17S60',
      controllerLevel: 1,
      owned: false,
      sources: [makeSource('source-e17s60-a', 21, 21, 'E17S60')]
    });
    installClaimGame(home, target, 910);
    installRecommendedClaimMemory(909);
    const controller = target.controller as StructureController & { my: boolean };
    const retryEvents: RuntimeTelemetryEvent[] = [];
    const retryingClaimer = makeClaimCreep(
      target,
      jest.fn((_controller: StructureController) => ERR_NOT_IN_RANGE_CODE)
    );

    expect(runRecommendedExpansionClaimExecutor(retryingClaimer, retryEvents)).toBe(true);

    expect(retryingClaimer.moveTo).toHaveBeenCalledWith(controller);
    expect(retryingClaimer.memory.territory).toMatchObject({
      targetRoom: 'E17S60',
      action: 'claim',
      claimAttemptCount: 1,
      lastClaimAttemptAt: 910
    });
    expect(Memory.territory?.intents?.[0]).toMatchObject({
      targetRoom: 'E17S60',
      action: 'claim',
      status: 'planned'
    });

    (Game as { time: number }).time = 911;
    const successEvents: RuntimeTelemetryEvent[] = [];
    const successfulClaimer = makeClaimCreep(
      target,
      jest.fn((_controller: StructureController) => {
        controller.my = true;
        return OK_CODE;
      })
    );

    expect(runRecommendedExpansionClaimExecutor(successfulClaimer, successEvents)).toBe(true);

    expect(successfulClaimer.memory.territory).toBeUndefined();
    expect(Memory.territory?.targets).toEqual([]);
    expect(Memory.territory?.intents).toEqual([]);
    expect(Memory.territory?.postClaimBootstraps?.E17S60).toMatchObject({
      colony: 'E17S59',
      roomName: 'E17S60',
      status: 'spawnSitePending',
      claimedAt: 911,
      updatedAt: 911,
      controllerId: 'controller-e17s60'
    });
    expect(successEvents).toContainEqual({
      type: 'territoryClaim',
      roomName: 'E17S59',
      colony: 'E17S59',
      phase: 'claim',
      targetRoom: 'E17S60',
      controllerId: 'controller-e17s60',
      creepName: 'claimer-E17S59-E17S60',
      result: OK_CODE
    });
    expect(successEvents).toContainEqual(
      expect.objectContaining({
        type: 'postClaimBootstrap',
        roomName: 'E17S60',
        colony: 'E17S59',
        phase: 'spawnSite',
        result: OK_CODE
      })
    );
  });

  it('preserves active E17S60 post-claim buildout state across repeated claim-success refreshes', () => {
    const spawn = makeStructure('spawn-e17s60', TEST_GLOBALS.STRUCTURE_SPAWN, 25, 25, 'E17S60');
    const target = makeRoom({
      roomName: 'E17S60',
      controllerLevel: 1,
      owned: true,
      sources: [makeSource('source-e17s60-a', 21, 21, 'E17S60')],
      structures: [spawn],
      spawns: [spawn as StructureSpawn]
    });
    installClaimGame(makeHomeColony(), target, 920);
    Memory.territory = {
      postClaimBootstraps: {
        E17S60: {
          colony: 'E17S59',
          roomName: 'E17S60',
          status: 'spawningWorkers',
          claimedAt: 910,
          updatedAt: 919,
          workerTarget: 3,
          controllerId: 'controller-e17s60' as Id<StructureController>,
          spawnSite: { roomName: 'E17S60', x: 23, y: 23 },
          lastResult: OK_CODE
        }
      }
    };

    const telemetryEvents: RuntimeTelemetryEvent[] = [];
    recordPostClaimBootstrapClaimSuccess({
      colony: 'E17S59',
      roomName: 'E17S60',
      controllerId: 'controller-e17s60' as Id<StructureController>
    }, telemetryEvents);

    expect(Memory.territory.postClaimBootstraps?.E17S60).toEqual({
      colony: 'E17S59',
      roomName: 'E17S60',
      status: 'spawningWorkers',
      claimedAt: 910,
      updatedAt: 920,
      workerTarget: 3,
      controllerId: 'controller-e17s60',
      spawnSite: { roomName: 'E17S60', x: 23, y: 23 },
      lastResult: OK_CODE
    });
    expect(telemetryEvents).toContainEqual({
      type: 'postClaimBootstrap',
      roomName: 'E17S60',
      colony: 'E17S59',
      phase: 'spawningWorkers',
      controllerId: 'controller-e17s60',
      workerTarget: 3
    });
  });

  it('starts E17S60 claimed-room buildout with spawn, extension, and road construction phases', () => {
    const spawnlessRoom = makeRoom({
      roomName: 'E17S60',
      controllerLevel: 1,
      sources: [makeSource('source-e17s60-a', 21, 21, 'E17S60')]
    });
    installGameRooms([spawnlessRoom], 930);
    installActiveBuildoutMemory(930);

    expect(runClaimedRoomBootstrapper([makeColonySnapshot(spawnlessRoom)]).planned).toEqual([
      { roomName: 'E17S60', phase: 'spawn', result: OK_CODE }
    ]);
    expect(spawnlessRoom.createConstructionSite).toHaveBeenCalledWith(23, 23, TEST_GLOBALS.STRUCTURE_SPAWN);

    const spawn = makeStructure('spawn-e17s60', TEST_GLOBALS.STRUCTURE_SPAWN, 25, 25, 'E17S60');
    const extensionRoom = makeRoom({
      roomName: 'E17S60',
      controllerLevel: 2,
      sources: [makeSource('source-e17s60-a', 21, 21, 'E17S60')],
      structures: [spawn],
      spawns: [spawn as StructureSpawn]
    });
    installGameRooms([extensionRoom], 931);
    installActiveBuildoutMemory(930);

    expect(runClaimedRoomBootstrapper([makeColonySnapshot(extensionRoom, [spawn as StructureSpawn])]).planned).toEqual([
      { roomName: 'E17S60', phase: 'extension', result: OK_CODE }
    ]);
    expect(extensionRoom.createConstructionSite).toHaveBeenCalledWith(24, 24, TEST_GLOBALS.STRUCTURE_EXTENSION);

    const roadSpawn = makeStructure('spawn-e17s60', TEST_GLOBALS.STRUCTURE_SPAWN, 10, 10, 'E17S60');
    const source = makeSource('source-e17s60-a', 20, 10, 'E17S60');
    const roadRoom = makeRoom({
      roomName: 'E17S60',
      controllerLevel: 2,
      controllerPosition: { x: 10, y: 20 },
      sources: [source],
      structures: [
        roadSpawn,
        makeStructure('container-e17s60', TEST_GLOBALS.STRUCTURE_CONTAINER, 20, 11, 'E17S60'),
        ...makeExtensions(5, 'E17S60')
      ],
      spawns: [roadSpawn as StructureSpawn],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }],
        '10,20': [{ x: 10, y: 11 }]
      }
    });
    installGameRooms([roadRoom], 932);
    installPathFinder(roadRoom);
    installActiveBuildoutMemory(930);

    expect(runClaimedRoomBootstrapper([makeColonySnapshot(roadRoom, [roadSpawn as StructureSpawn])]).planned).toEqual([
      { roomName: 'E17S60', phase: 'road', results: [OK_CODE] }
    ]);
    expect(roadRoom.createConstructionSite).toHaveBeenCalledWith(11, 10, TEST_GLOBALS.STRUCTURE_ROAD);
  });
});

function makeHomeColony(): ColonySnapshot {
  const room = makeRoom({
    roomName: 'E17S59',
    controllerLevel: 4,
    sources: [
      makeSource('source-e17s59-a', 10, 10, 'E17S59'),
      makeSource('source-e17s59-b', 40, 40, 'E17S59')
    ]
  });
  const spawn = makeSpawn('Spawn1', room, 25, 25);
  room.__structures.push(spawn as unknown as Structure);

  return {
    room,
    spawns: [spawn],
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300,
    spawnEnergyBudget: 1_300,
    memory: (room as Room & { memory?: RoomMemory }).memory
  };
}

function makeColonySnapshot(room: MockRoom, spawns: StructureSpawn[] = []): ColonySnapshot {
  return {
    room,
    spawns,
    energyAvailable: room.energyAvailable,
    energyCapacityAvailable: room.energyCapacityAvailable
  };
}

function makeRoom(options: TestRoomOptions): MockRoom {
  const constructionSites = [...(options.constructionSites ?? [])];
  const structures = [...(options.structures ?? [])];
  const sources = options.sources ?? [];
  const controller = {
    id: `controller-${options.roomName.toLowerCase()}` as Id<StructureController>,
    my: options.owned ?? true,
    owner: options.owned === false ? undefined : { username: 'me' },
    level: options.controllerLevel,
    ticksToDowngrade: 10_000,
    pos: makeRoomPosition(options.controllerPosition ?? { x: 25, y: 25 }, options.roomName)
  } as StructureController;
  const room = {
    name: options.roomName,
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300,
    controller,
    storage: {
      store: {
        getUsedCapacity: jest.fn(() => 0)
      }
    },
    memory: {},
    find: jest.fn(
      (
        findType: number,
        findOptions?: { filter?: (target: Source | Structure | ConstructionSite) => boolean }
      ) => {
        const targets =
          findType === TEST_GLOBALS.FIND_SOURCES || findType === TEST_GLOBALS.FIND_MINERALS
            ? sources
            : findType === TEST_GLOBALS.FIND_MY_STRUCTURES || findType === TEST_GLOBALS.FIND_STRUCTURES
              ? structures
              : findType === TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES ||
                  findType === TEST_GLOBALS.FIND_CONSTRUCTION_SITES
                ? constructionSites
                : [];

        return findOptions?.filter ? targets.filter(findOptions.filter) : targets;
      }
    ),
    lookForAtArea: jest.fn((lookType: LookConstant, top: number, left: number, bottom: number, right: number) => {
      if (lookType === TEST_GLOBALS.LOOK_STRUCTURES) {
        return structures.flatMap((structure) => toLookResult('structure', structure, top, left, bottom, right));
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return constructionSites.flatMap((site) => toLookResult('constructionSite', site, top, left, bottom, right));
      }

      return [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: BuildableStructureConstant) => {
      constructionSites.push(makeConstructionSite(`site-${x}-${y}`, structureType, x, y, options.roomName));
      return OK_CODE;
    }),
    __pathsByTarget: options.pathsByTarget ?? {},
    __structures: structures,
    __constructionSites: constructionSites
  } as unknown as MockRoom;
  (controller as StructureController & { room: Room }).room = room;
  for (const structure of structures) {
    (structure as Structure & { room?: Room }).room = room;
  }
  for (const spawn of options.spawns ?? []) {
    (spawn as StructureSpawn & { room: Room }).room = room;
  }

  return room;
}

function installExpansionGame(home: ColonySnapshot, gameTime: number): void {
  const e17s58 = makeRoom({
    roomName: 'E17S58',
    controllerLevel: 3,
    sources: [makeSource('source-e17s58-a', 20, 20, 'E17S58')]
  });
  installGameRooms([home.room as MockRoom, e17s58], gameTime);
  (Game as Partial<Game>).map = {
    ...Game.map,
    describeExits: jest.fn((roomName: string) => {
      if (roomName === 'E17S59') {
        return { '5': 'E18S59', '7': 'E17S58' };
      }

      if (roomName === 'E17S58') {
        return { '3': 'E17S59', '7': 'E17S60' };
      }

      return {};
    }),
    findRoute: jest.fn((fromRoom: string, toRoom: string) => {
      if (fromRoom === 'E17S59' && toRoom === 'E17S60') {
        return [
          { exit: 7, room: 'E17S58' },
          { exit: 7, room: 'E17S60' }
        ];
      }

      return [{ exit: 5, room: toRoom }];
    }),
    getRoomTerrain: Game.map?.getRoomTerrain
  } as unknown as GameMap;
}

function installClaimGame(home: ColonySnapshot, target: MockRoom, gameTime: number): void {
  installGameRooms([home.room as MockRoom, target], gameTime);
  (Game as Partial<Game>).getObjectById = jest.fn((id: Id<StructureController>) =>
    id === target.controller?.id ? target.controller : null
  ) as Game['getObjectById'];
}

function installGameRooms(rooms: MockRoom[], gameTime: number): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: gameTime,
    rooms: Object.fromEntries(rooms.map((room) => [room.name, room])),
    spawns: Object.fromEntries(
      rooms.flatMap((room) =>
        (room.__structures.filter((structure) => structure.structureType === TEST_GLOBALS.STRUCTURE_SPAWN) as Structure[])
          .map((structure) => [String((structure as StructureSpawn).name), structure])
      )
    ) as Record<string, StructureSpawn>,
    creeps: {},
    map: {
      getRoomTerrain: jest.fn(() => ({
        get: jest.fn(() => 0)
      }))
    } as unknown as GameMap
  };
}

function installE17S60ScoutIntel(updatedAt: number): void {
  Memory.territory = {
    ...(Memory.territory ?? {}),
    scoutIntel: {
      ...(Memory.territory?.scoutIntel ?? {}),
      'E17S59>E17S60': {
        colony: 'E17S59',
        roomName: 'E17S60',
        updatedAt,
        controller: { id: 'controller-e17s60' as Id<StructureController>, my: false },
        sourceIds: ['source-e17s60-a', 'source-e17s60-b'],
        sourceCount: 2,
        sourceAccessPoints: 7,
        controllerSourceRange: 9,
        terrain: { walkableRatio: 0.92, swampRatio: 0.03, wallRatio: 0.08 },
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        hostileSpawnCount: 0
      }
    }
  };
}

function installRecommendedClaimMemory(updatedAt: number): void {
  Memory.territory = {
    expansionPipelines: {
      E17S59: {
        colony: 'E17S59',
        targetRoom: 'E17S60',
        status: 'active',
        stage: 'claiming',
        claimState: 'scouted',
        score: 1_100,
        threshold: 700,
        startedAt: updatedAt,
        updatedAt,
        controllerId: 'controller-e17s60' as Id<StructureController>
      }
    },
    targets: [
      {
        colony: 'E17S59',
        roomName: 'E17S60',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e17s60' as Id<StructureController>
      }
    ],
    intents: [
      {
        colony: 'E17S59',
        targetRoom: 'E17S60',
        action: 'claim',
        status: 'planned',
        updatedAt,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e17s60' as Id<StructureController>
      }
    ]
  };
}

function installActiveBuildoutMemory(claimedAt: number): void {
  Memory.territory = {
    claimedRoomBootstrapper: {
      rooms: {
        E17S60: {
          roomName: 'E17S60',
          owned: true,
          claimedAt,
          updatedAt: claimedAt
        }
      }
    }
  };
}

function installSafeHomeThreat(updatedAt: number): void {
  Memory.defense = {
    colonyThreats: {
      updatedAt,
      rooms: {
        E17S59: {
          roomName: 'E17S59',
          level: 'none',
          updatedAt,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          damagedCriticalStructureCount: 0
        }
      }
    }
  };
}

function installPathFinder(room: MockRoom): void {
  const pathsByTarget = room.__pathsByTarget ?? {};
  (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
    CostMatrix: class {
      set(): void {}
      get(): number {
        return 0;
      }
      clone(): CostMatrix {
        return this as unknown as CostMatrix;
      }
      serialize(): number[] {
        return [];
      }
    } as unknown as CostMatrix,
    search: jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => ({
      path: (pathsByTarget[getPositionKey(goal.pos)] ?? pathsByTarget[getRouteKey(origin, goal)] ?? []).map((position) =>
        makeRoomPosition(position, room.name)
      ),
      ops: 1,
      cost: 1,
      incomplete: false
    })) as unknown as PathFinder['search']
  };
}

function makeClaimCreep(
  room: MockRoom,
  claimController: jest.Mock<ScreepsReturnCode, [StructureController]>
): Creep & { moveTo: jest.Mock } {
  return {
    name: 'claimer-E17S59-E17S60',
    memory: {
      role: 'claimer',
      colony: 'E17S59',
      territory: {
        targetRoom: 'E17S60',
        action: 'claim',
        controllerId: 'controller-e17s60' as Id<StructureController>
      }
    },
    room,
    claimController,
    moveTo: jest.fn()
  } as unknown as Creep & { moveTo: jest.Mock };
}

function makeSpawn(name: string, room: Room, x: number, y: number): StructureSpawn {
  return {
    id: name as Id<StructureSpawn>,
    name,
    structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
    room,
    pos: makeRoomPosition({ x, y }, room.name),
    spawning: null
  } as unknown as StructureSpawn;
}

function makeSource(id: string, x: number, y: number, roomName: string): Source {
  return {
    id: id as Id<Source>,
    pos: makeRoomPosition({ x, y }, roomName)
  } as unknown as Source;
}

function makeStructure(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  roomName: string
): Structure {
  return {
    id: id as Id<Structure>,
    name: id,
    structureType,
    pos: makeRoomPosition({ x, y }, roomName)
  } as unknown as Structure;
}

function makeExtensions(count: number, roomName: string): Structure[] {
  return Array.from({ length: count }, (_value, index) =>
    makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 35 + (index % 5), 35 + Math.floor(index / 5), roomName)
  );
}

function makeConstructionSite(
  id: string,
  structureType: BuildableStructureConstant,
  x: number,
  y: number,
  roomName: string
): ConstructionSite {
  return {
    id: id as Id<ConstructionSite>,
    structureType,
    pos: makeRoomPosition({ x, y }, roomName)
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

  return [{ type: key as LookConstant, [key]: object, x: position.x, y: position.y } as unknown as LookAtResultWithPos];
}

function getPositionKey(position: RoomPosition): string {
  return `${position.x},${position.y}`;
}

function getRouteKey(origin: RoomPosition, goal: { pos: RoomPosition }): string {
  return `${origin.x},${origin.y}->${goal.pos.x},${goal.pos.y}`;
}
