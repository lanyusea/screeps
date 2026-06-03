import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { runClaimer } from '../src/creeps/claimerRunner';
import { planSpawn } from '../src/spawn/spawnPlanner';
import { refreshExpansionExecutorIntent } from '../src/territory/expansionExecutor';
import { getExpansionTriggerRequiredEnergy } from '../src/territory/expansionTrigger';
import { planTerritoryIntent } from '../src/territory/territoryPlanner';
import { installE18S59ExpansionScoutTarget } from './helpers/runtimeRoomConfig';

describe('E18S59 claim pipeline', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { BODYPART_COST: Record<BodyPartConstant, number> }).BODYPART_COST = {
      move: 50,
      work: 100,
      carry: 50,
      attack: 80,
      ranged_attack: 150,
      heal: 250,
      claim: 600,
      tough: 10
    };
    (globalThis as unknown as { RoomPosition: typeof RoomPosition }).RoomPosition = jest.fn(
      (x: number, y: number, roomName: string) => ({ x, y, roomName }) as RoomPosition
    ) as unknown as typeof RoomPosition;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    installE18S59ExpansionScoutTarget();
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_MINERALS?: number }).FIND_MINERALS;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
    delete (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    delete (globalThis as { BODYPART_COST?: Record<BodyPartConstant, number> }).BODYPART_COST;
    delete (globalThis as { RoomPosition?: typeof RoomPosition }).RoomPosition;
    delete (globalThis as { TERRITORY_EXPANSION_TRIGGER_MIN_RCL?: number }).TERRITORY_EXPANSION_TRIGGER_MIN_RCL;
  });

  it('plans a direct E18S59 claim from viable legacy scout evidence', () => {
    const colony = makeColony();
    setGame(colony, 822);
    setSafeHomeThreat('E17S59', 822);
    Memory.scout = {
      E18S59: makeLegacyScoutIntel()
    };

    expect(refreshExpansionExecutorIntent(colony, 822)).toMatchObject({
      status: 'planned',
      colony: 'E17S59',
      targetRoom: 'E18S59',
      controllerId: 'controller-e18s59'
    });
    expect(Memory.territory?.expansionPipelines?.E17S59).toMatchObject({
      colony: 'E17S59',
      targetRoom: 'E18S59',
      status: 'active',
      stage: 'claiming',
      claimState: 'scouted',
      controllerId: 'controller-e18s59'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'E17S59',
        roomName: 'E18S59',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e18s59',
        postClaimBootstrapReserveEnergy: 400
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'E17S59',
        targetRoom: 'E18S59',
        action: 'claim',
        status: 'planned',
        updatedAt: 822,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e18s59',
        postClaimBootstrapReserveEnergy: 400
      }
    ]);
  });

  it('does not trigger an E18S59 claim before RCL5 even when GCL capacity and claim energy are ready', () => {
    (globalThis as { TERRITORY_EXPANSION_TRIGGER_MIN_RCL?: number }).TERRITORY_EXPANSION_TRIGGER_MIN_RCL = 4;
    const threshold = getExpansionTriggerRequiredEnergy(5);
    const colony = makeColony({
      controllerLevel: 4,
      energyAvailable: threshold,
      energyCapacityAvailable: 1_800
    });
    setGame(colony, 827, { includeE17S58: true, gclLevel: 3 });
    setSafeHomeThreat('E17S59', 827);
    Memory.scout = {
      E18S59: makeLegacyScoutIntel()
    };

    expect(refreshExpansionExecutorIntent(colony, 827)).toEqual({
      status: 'skipped',
      colony: 'E17S59',
      reason: 'unmetPreconditions'
    });
    const e18s59Candidate = Memory.territory?.expansionCandidates?.find((candidate) => candidate.roomName === 'E18S59');
    expect(e18s59Candidate).toMatchObject({
      colony: 'E17S59',
      roomName: 'E18S59',
      evidenceStatus: 'sufficient',
      recommendedAction: 'claim',
      nearestOwnedRoom: 'E17S59',
      nearestOwnedRoomDistance: 1,
      routeDistance: 1
    });
    expect(e18s59Candidate).not.toHaveProperty('preconditions');
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it('skips the E18S59 trigger when current energy is below RCL5 expansion readiness', () => {
    const threshold = getExpansionTriggerRequiredEnergy(5);
    const colony = makeColony({
      controllerLevel: 5,
      energyAvailable: threshold - 1,
      energyCapacityAvailable: 1_800
    });
    setGame(colony, 828, { includeE17S58: true, gclLevel: 3 });
    setSafeHomeThreat('E17S59', 828);
    Memory.scout = {
      E18S59: makeLegacyScoutIntel()
    };

    expect(refreshExpansionExecutorIntent(colony, 828)).toEqual({
      status: 'skipped',
      colony: 'E17S59',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines?.E17S59).toBeUndefined();
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it.each([
    ['hostile scout evidence', { hostileCreepCount: 1 }],
    [
      'occupied controller evidence',
      { controller: { id: 'controller-e18s59' as Id<StructureController>, ownerUsername: 'enemy' } }
    ]
  ])('does not claim E18S59 from %s', (_label, overrides: Partial<TerritoryScoutIntelMemory>) => {
    const colony = makeColony();
    setGame(colony, 823);
    setSafeHomeThreat('E17S59', 823);
    Memory.scout = {
      E18S59: makeLegacyScoutIntel(overrides)
    };

    expect(refreshExpansionExecutorIntent(colony, 823)).toEqual({
      status: 'skipped',
      colony: 'E17S59',
      reason: 'unavailable'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('spawns a CLAIM/MOVE claimer and advances pipeline state once a claimer is active', () => {
    const colony = makeColony();
    setGame(colony, 824);
    Memory.scout = {
      E18S59: makeLegacyScoutIntel()
    };
    Memory.territory = {
      expansionPipelines: {
        E17S59: {
          colony: 'E17S59',
          targetRoom: 'E18S59',
          status: 'active',
          stage: 'claiming',
          claimState: 'scouted',
          score: 1_100,
          threshold: 700,
          startedAt: 822,
          updatedAt: 822,
          controllerId: 'controller-e18s59' as Id<StructureController>
        }
      },
      targets: [
        {
          colony: 'E17S59',
          roomName: 'E18S59',
          action: 'claim',
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller-e18s59' as Id<StructureController>
        }
      ],
      intents: [
        {
          colony: 'E17S59',
          targetRoom: 'E18S59',
          action: 'claim',
          status: 'planned',
          updatedAt: 823,
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller-e18s59' as Id<StructureController>
        }
      ]
    };

    expect(planSpawn(colony, { worker: 6, claimer: 0, claimersByTargetRoom: {} }, 824)).toEqual({
      spawn: colony.spawns[0],
      body: ['claim', 'move'],
      name: 'claimer-E17S59-E18S59-824',
      memory: {
        role: 'claimer',
        colony: 'E17S59',
        territory: {
          targetRoom: 'E18S59',
          action: 'claim',
          controllerId: 'controller-e18s59'
        }
      }
    });

    expect(
      planTerritoryIntent(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { E18S59: 1 },
          claimersByTargetRoomAction: { claim: { E18S59: 1 } }
        },
        3,
        825
      )
    ).toMatchObject({
      colony: 'E17S59',
      targetRoom: 'E18S59',
      action: 'claim',
      controllerId: 'controller-e18s59'
    });
    expect(Memory.territory?.expansionPipelines?.E17S59).toMatchObject({
      stage: 'claiming',
      claimState: 'claiming',
      updatedAt: 825
    });
  });

  it('routes an E18S59 claimer to the visible target controller before claiming', () => {
    const controller = { id: 'controller-e18s59', my: false } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 826,
      rooms: {
        E17S59: {
          name: 'E17S59',
          controller: { my: true, level: 6 } as StructureController
        } as Room,
        E18S59: { name: 'E18S59', controller } as Room
      },
      getObjectById: jest.fn().mockReturnValue(controller)
    };
    const creep = {
      name: 'claimer-E17S59-E18S59-826',
      memory: {
        role: 'claimer',
        colony: 'E17S59',
        territory: {
          targetRoom: 'E18S59',
          action: 'claim',
          controllerId: 'controller-e18s59' as Id<StructureController>
        }
      },
      room: { name: 'E17S59' },
      moveTo: jest.fn(),
      claimController: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.claimController).not.toHaveBeenCalled();
  });

  it('dispatches a dedicated E18S59 post-claim upgrader from E17S59 once the spawn site is pending', () => {
    const colony = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    setGame(colony, 839);
    const claimedRoom = {
      name: 'E18S59',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: {
        id: 'controller-e18s59',
        my: true,
        level: 1,
        ticksToDowngrade: 20_000
      } as StructureController,
      find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources('E18S59') : []))
    } as unknown as Room;
    (Game.rooms as Record<string, Room>).E18S59 = claimedRoom;
    (globalThis as unknown as { Game: Partial<Game> }).Game.spawns = { Spawn1: colony.spawns[0] };
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {};
    Memory.territory = {
      postClaimBootstraps: {
        E18S59: {
          colony: 'E17S59',
          roomName: 'E18S59',
          status: 'spawnSitePending',
          claimedAt: 837,
          updatedAt: 838,
          workerTarget: 2,
          controllerId: 'controller-e18s59' as Id<StructureController>,
          spawnSite: { roomName: 'E18S59', x: 23, y: 23 },
          lastResult: 0 as ScreepsReturnCode
        }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 839)).toMatchObject({
      spawn: colony.spawns[0],
      name: 'worker-E17S59-E18S59-upgrader-839',
      memory: {
        role: 'worker',
        colony: 'E18S59',
        territory: { targetRoom: 'E18S59', action: 'claim', controllerId: 'controller-e18s59' },
        controllerSustain: { homeRoom: 'E17S59', targetRoom: 'E18S59', role: 'upgrader' }
      }
    });
  });
});

function makeColony({
  controllerLevel = 6,
  energyAvailable = 1_300,
  energyCapacityAvailable = 1_300
}: {
  controllerLevel?: number;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): ColonySnapshot {
  const room = {
    name: 'E17S59',
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: 'controller-e17s59' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: controllerLevel,
      ticksToDowngrade: 10_000
    } as StructureController,
    storage: {
      store: {
        getUsedCapacity: jest.fn(() => 0)
      }
    },
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources('E17S59') : [])),
    memory: {}
  } as unknown as Room & { memory: RoomMemory };
  const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;

  return {
    room,
    spawns: [spawn],
    energyAvailable,
    energyCapacityAvailable,
    spawnEnergyBudget: energyCapacityAvailable,
    memory: room.memory
  };
}

function setGame(
  colony: ColonySnapshot,
  gameTime: number,
  {
    includeE17S58 = false,
    gclLevel
  }: {
    includeE17S58?: boolean;
    gclLevel?: number;
  } = {}
): void {
  const rooms: Record<string, Room> = {
    E17S59: colony.room
  };
  if (includeE17S58) {
    rooms.E17S58 = makeOwnedRoom('E17S58');
  }

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: gameTime,
    rooms,
    ...(gclLevel !== undefined ? { gcl: { level: gclLevel, progress: 0, progressTotal: 1 } } : {}),
    map: {
      describeExits: jest.fn((roomName: string) => (roomName === 'E17S59' ? { '5': 'E18S59' } : {}))
    } as unknown as GameMap
  };
}

function makeOwnedRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: {
      id: `controller-${roomName.toLowerCase()}` as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300,
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources(roomName) : []))
  } as unknown as Room;
}

function makeLegacyScoutIntel(overrides: Partial<TerritoryScoutIntelMemory> = {}): Record<string, unknown> {
  return {
    updatedAt: 821,
    controller: { id: 'controller-e18s59', my: false },
    sourceIds: ['source-e18s59-a', 'source-e18s59-b'],
    sourceCount: 2,
    sourceAccessPoints: 7,
    controllerSourceRange: 9,
    terrain: { walkableRatio: 0.92, swampRatio: 0.03, wallRatio: 0.08 },
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    hostileSpawnCount: 0,
    ...overrides
  };
}

function makeSources(roomName: string): Source[] {
  return [
    { id: `${roomName}-source-a` as Id<Source>, pos: { x: 10, y: 10, roomName } as RoomPosition },
    { id: `${roomName}-source-b` as Id<Source>, pos: { x: 40, y: 40, roomName } as RoomPosition }
  ] as Source[];
}

function setSafeHomeThreat(roomName: string, updatedAt: number): void {
  Memory.defense = {
    ...(Memory.defense ?? {}),
    colonyThreats: {
      updatedAt,
      rooms: {
        ...(Memory.defense?.colonyThreats?.rooms ?? {}),
        [roomName]: {
          roomName,
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
