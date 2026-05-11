import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { runClaimer } from '../src/creeps/claimerRunner';
import { planSpawn } from '../src/spawn/spawnPlanner';
import { refreshExpansionExecutorIntent } from '../src/territory/expansionExecutor';
import { getExpansionTriggerRequiredEnergy } from '../src/territory/expansionTrigger';
import { planTerritoryIntent } from '../src/territory/territoryPlanner';

describe('E24S50 claim pipeline', () => {
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
  });

  it('plans a direct E24S50 claim from viable legacy scout evidence', () => {
    const colony = makeColony();
    setGame(colony, 822);
    setSafeHomeThreat('E24S49', 822);
    Memory.scout = {
      E24S50: makeLegacyScoutIntel()
    };

    expect(refreshExpansionExecutorIntent(colony, 822)).toMatchObject({
      status: 'planned',
      colony: 'E24S49',
      targetRoom: 'E24S50',
      controllerId: 'controller-e24s50'
    });
    expect(Memory.territory?.expansionPipelines?.E24S49).toMatchObject({
      colony: 'E24S49',
      targetRoom: 'E24S50',
      status: 'active',
      stage: 'claiming',
      claimState: 'scouted',
      controllerId: 'controller-e24s50'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'E24S49',
        roomName: 'E24S50',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e24s50',
        postClaimBootstrapReserveEnergy: 400
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'E24S49',
        targetRoom: 'E24S50',
        action: 'claim',
        status: 'planned',
        updatedAt: 822,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e24s50',
        postClaimBootstrapReserveEnergy: 400
      }
    ]);
  });

  it('triggers an E24S50 claim at RCL 3 when GCL capacity and claim energy are ready', () => {
    const colony = makeColony({ controllerLevel: 3 });
    setGame(colony, 827, { includeE24S48: true, gclLevel: 3 });
    setSafeHomeThreat('E24S49', 827);
    Memory.scout = {
      E24S50: makeLegacyScoutIntel()
    };

    expect(refreshExpansionExecutorIntent(colony, 827)).toMatchObject({
      status: 'planned',
      colony: 'E24S49',
      targetRoom: 'E24S50',
      controllerId: 'controller-e24s50'
    });
    expect(Memory.territory?.expansionCandidates?.[0]).toMatchObject({
      colony: 'E24S49',
      roomName: 'E24S50',
      evidenceStatus: 'sufficient',
      recommendedAction: 'claim',
      nearestOwnedRoom: 'E24S49',
      nearestOwnedRoomDistance: 1,
      routeDistance: 1
    });
    expect(Memory.territory?.expansionCandidates?.[0]).not.toHaveProperty('preconditions');
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'E24S49',
        roomName: 'E24S50',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e24s50',
        postClaimBootstrapReserveEnergy: 400
      }
    ]);
  });

  it('skips the E24S50 trigger when current energy is below RCL 3 expansion readiness', () => {
    const threshold = getExpansionTriggerRequiredEnergy(3);
    const colony = makeColony({
      controllerLevel: 3,
      energyAvailable: threshold - 1,
      energyCapacityAvailable: 800
    });
    setGame(colony, 828, { includeE24S48: true, gclLevel: 3 });
    setSafeHomeThreat('E24S49', 828);
    Memory.scout = {
      E24S50: makeLegacyScoutIntel()
    };

    expect(refreshExpansionExecutorIntent(colony, 828)).toEqual({
      status: 'skipped',
      colony: 'E24S49',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.expansionPipelines?.E24S49).toBeUndefined();
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it.each([
    ['hostile scout evidence', { hostileCreepCount: 1 }],
    [
      'occupied controller evidence',
      { controller: { id: 'controller-e24s50' as Id<StructureController>, ownerUsername: 'enemy' } }
    ]
  ])('does not claim E24S50 from %s', (_label, overrides: Partial<TerritoryScoutIntelMemory>) => {
    const colony = makeColony();
    setGame(colony, 823);
    setSafeHomeThreat('E24S49', 823);
    Memory.scout = {
      E24S50: makeLegacyScoutIntel(overrides)
    };

    expect(refreshExpansionExecutorIntent(colony, 823)).toEqual({
      status: 'skipped',
      colony: 'E24S49',
      reason: 'unavailable'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('spawns a CLAIM/MOVE claimer and advances pipeline state once a claimer is active', () => {
    const colony = makeColony();
    setGame(colony, 824);
    Memory.scout = {
      E24S50: makeLegacyScoutIntel()
    };
    Memory.territory = {
      expansionPipelines: {
        E24S49: {
          colony: 'E24S49',
          targetRoom: 'E24S50',
          status: 'active',
          stage: 'claiming',
          claimState: 'scouted',
          score: 1_100,
          threshold: 700,
          startedAt: 822,
          updatedAt: 822,
          controllerId: 'controller-e24s50' as Id<StructureController>
        }
      },
      targets: [
        {
          colony: 'E24S49',
          roomName: 'E24S50',
          action: 'claim',
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller-e24s50' as Id<StructureController>
        }
      ],
      intents: [
        {
          colony: 'E24S49',
          targetRoom: 'E24S50',
          action: 'claim',
          status: 'planned',
          updatedAt: 823,
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller-e24s50' as Id<StructureController>
        }
      ]
    };

    expect(planSpawn(colony, { worker: 6, claimer: 0, claimersByTargetRoom: {} }, 824)).toEqual({
      spawn: colony.spawns[0],
      body: ['claim', 'move'],
      name: 'claimer-E24S49-E24S50-824',
      memory: {
        role: 'claimer',
        colony: 'E24S49',
        territory: {
          targetRoom: 'E24S50',
          action: 'claim',
          controllerId: 'controller-e24s50'
        }
      }
    });

    expect(
      planTerritoryIntent(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { E24S50: 1 },
          claimersByTargetRoomAction: { claim: { E24S50: 1 } }
        },
        3,
        825
      )
    ).toMatchObject({
      colony: 'E24S49',
      targetRoom: 'E24S50',
      action: 'claim',
      controllerId: 'controller-e24s50'
    });
    expect(Memory.territory?.expansionPipelines?.E24S49).toMatchObject({
      stage: 'claiming',
      claimState: 'claiming',
      updatedAt: 825
    });
  });

  it('routes an E24S50 claimer to the visible target controller before claiming', () => {
    const controller = { id: 'controller-e24s50', my: false } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 826,
      rooms: {
        E24S50: { name: 'E24S50', controller } as Room
      },
      getObjectById: jest.fn().mockReturnValue(controller)
    };
    const creep = {
      name: 'claimer-E24S49-E24S50-826',
      memory: {
        role: 'claimer',
        colony: 'E24S49',
        territory: {
          targetRoom: 'E24S50',
          action: 'claim',
          controllerId: 'controller-e24s50' as Id<StructureController>
        }
      },
      room: { name: 'E24S49' },
      moveTo: jest.fn(),
      claimController: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.claimController).not.toHaveBeenCalled();
  });

  it('dispatches a dedicated E24S50 post-claim upgrader from E24S49 once the spawn site is pending', () => {
    const colony = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    setGame(colony, 839);
    const claimedRoom = {
      name: 'E24S50',
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller: {
        id: 'controller-e24s50',
        my: true,
        level: 1,
        ticksToDowngrade: 20_000
      } as StructureController,
      find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources('E24S50') : []))
    } as unknown as Room;
    (Game.rooms as Record<string, Room>).E24S50 = claimedRoom;
    (globalThis as unknown as { Game: Partial<Game> }).Game.spawns = { Spawn1: colony.spawns[0] };
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {};
    Memory.territory = {
      postClaimBootstraps: {
        E24S50: {
          colony: 'E24S49',
          roomName: 'E24S50',
          status: 'spawnSitePending',
          claimedAt: 837,
          updatedAt: 838,
          workerTarget: 2,
          controllerId: 'controller-e24s50' as Id<StructureController>,
          spawnSite: { roomName: 'E24S50', x: 23, y: 23 },
          lastResult: 0 as ScreepsReturnCode
        }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 839)).toMatchObject({
      spawn: colony.spawns[0],
      name: 'worker-E24S49-E24S50-upgrader-839',
      memory: {
        role: 'worker',
        colony: 'E24S50',
        territory: { targetRoom: 'E24S50', action: 'claim', controllerId: 'controller-e24s50' },
        controllerSustain: { homeRoom: 'E24S49', targetRoom: 'E24S50', role: 'upgrader' }
      }
    });
  });
});

function makeColony({
  controllerLevel = 4,
  energyAvailable = 1_300,
  energyCapacityAvailable = 1_300
}: {
  controllerLevel?: number;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): ColonySnapshot {
  const room = {
    name: 'E24S49',
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: 'controller-e24s49' as Id<StructureController>,
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
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources('E24S49') : [])),
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
    includeE24S48 = false,
    gclLevel
  }: {
    includeE24S48?: boolean;
    gclLevel?: number;
  } = {}
): void {
  const rooms: Record<string, Room> = {
    E24S49: colony.room
  };
  if (includeE24S48) {
    rooms.E24S48 = makeOwnedRoom('E24S48');
  }

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: gameTime,
    rooms,
    ...(gclLevel !== undefined ? { gcl: { level: gclLevel, progress: 0, progressTotal: 1 } } : {}),
    map: {
      describeExits: jest.fn((roomName: string) => (roomName === 'E24S49' ? { '5': 'E24S50' } : {}))
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
    controller: { id: 'controller-e24s50', my: false },
    sourceIds: ['source-e24s50-a', 'source-e24s50-b'],
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
