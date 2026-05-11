import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planSpawn } from '../src/spawn/spawnPlanner';
import { refreshExpansionExecutorIntent } from '../src/territory/expansionExecutor';
import { planTerritoryIntent } from '../src/territory/territoryPlanner';

describe('E26S47 claim pipeline', () => {
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

  it('plans a direct E26S47 claim from viable territory scout intel', () => {
    const colony = makeColony();
    setGame(colony, 850);
    setSafeHomeThreat('E24S49', 850);
    setE26S47ScoutIntel(makeScoutIntel());

    expect(refreshExpansionExecutorIntent(colony, 850)).toMatchObject({
      status: 'planned',
      colony: 'E24S49',
      targetRoom: 'E26S47',
      controllerId: 'controller-e26s47'
    });
    expect(Memory.territory?.expansionPipelines?.E24S49).toMatchObject({
      colony: 'E24S49',
      targetRoom: 'E26S47',
      status: 'active',
      stage: 'claiming',
      claimState: 'scouted',
      controllerId: 'controller-e26s47'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'E24S49',
        roomName: 'E26S47',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e26s47',
        postClaimBootstrapReserveEnergy: 400
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'E24S49',
        targetRoom: 'E26S47',
        action: 'claim',
        status: 'planned',
        updatedAt: 850,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller-e26s47',
        postClaimBootstrapReserveEnergy: 400
      }
    ]);
  });

  it('does not claim E26S47 when scout intel reports hostile presence', () => {
    const colony = makeColony();
    setGame(colony, 851);
    setSafeHomeThreat('E24S49', 851);
    setE26S47ScoutIntel(makeScoutIntel({ hostileCreepCount: 1 }));
    setE26S50UnavailableScoutIntel(851);

    expect(refreshExpansionExecutorIntent(colony, 851)).toMatchObject({
      status: 'skipped',
      colony: 'E24S49',
      reason: 'unavailable'
    });
    expect(Memory.territory?.expansionPipelines?.E24S49).toBeUndefined();
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('does not claim E26S47 when scout intel reports the controller already claimed', () => {
    const colony = makeColony();
    setGame(colony, 852);
    setSafeHomeThreat('E24S49', 852);
    setE26S47ScoutIntel(
      makeScoutIntel({
        controller: { id: 'controller-e26s47' as Id<StructureController>, ownerUsername: 'enemy' }
      })
    );
    setE26S50UnavailableScoutIntel(852);

    expect(refreshExpansionExecutorIntent(colony, 852)).toMatchObject({
      status: 'skipped',
      colony: 'E24S49',
      reason: 'unavailable'
    });
    expect(Memory.territory?.expansionPipelines?.E24S49).toBeUndefined();
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('plans an E26S47 claim when the controller is already reserved by the colony account', () => {
    const colony = makeColony();
    setGame(colony, 853);
    setSafeHomeThreat('E24S49', 853);
    setE26S47ScoutIntel(
      makeScoutIntel({
        controller: {
          id: 'controller-e26s47' as Id<StructureController>,
          my: false,
          reservationUsername: 'me',
          reservationTicksToEnd: 4_500
        }
      })
    );

    expect(refreshExpansionExecutorIntent(colony, 853)).toMatchObject({
      status: 'planned',
      colony: 'E24S49',
      targetRoom: 'E26S47',
      controllerId: 'controller-e26s47'
    });
    expect(Memory.territory?.targets?.[0]).toMatchObject({
      colony: 'E24S49',
      roomName: 'E26S47',
      action: 'claim',
      controllerId: 'controller-e26s47'
    });
  });

  it('spawns a CLAIM/MOVE claimer and advances E26S47 pipeline state once a claimer is active', () => {
    const colony = makeColony();
    setGame(colony, 854);
    setE26S47ScoutIntel(makeScoutIntel());
    Memory.territory = {
      scoutIntel: Memory.territory?.scoutIntel,
      expansionPipelines: {
        E24S49: {
          colony: 'E24S49',
          targetRoom: 'E26S47',
          status: 'active',
          stage: 'claiming',
          claimState: 'scouted',
          score: 1_100,
          threshold: 700,
          startedAt: 850,
          updatedAt: 850,
          controllerId: 'controller-e26s47' as Id<StructureController>
        }
      },
      targets: [
        {
          colony: 'E24S49',
          roomName: 'E26S47',
          action: 'claim',
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller-e26s47' as Id<StructureController>
        }
      ],
      intents: [
        {
          colony: 'E24S49',
          targetRoom: 'E26S47',
          action: 'claim',
          status: 'planned',
          updatedAt: 853,
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller-e26s47' as Id<StructureController>
        }
      ]
    };

    expect(planSpawn(colony, { worker: 6, claimer: 0, claimersByTargetRoom: {} }, 854)).toEqual({
      spawn: colony.spawns[0],
      body: ['claim', 'move'],
      name: 'claimer-E24S49-E26S47-854',
      memory: {
        role: 'claimer',
        colony: 'E24S49',
        territory: {
          targetRoom: 'E26S47',
          action: 'claim',
          controllerId: 'controller-e26s47'
        }
      }
    });

    expect(
      planTerritoryIntent(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { E26S47: 1 },
          claimersByTargetRoomAction: { claim: { E26S47: 1 } }
        },
        3,
        855
      )
    ).toMatchObject({
      colony: 'E24S49',
      targetRoom: 'E26S47',
      action: 'claim',
      controllerId: 'controller-e26s47'
    });
    expect(Memory.territory?.expansionPipelines?.E24S49).toMatchObject({
      stage: 'claiming',
      claimState: 'claiming',
      updatedAt: 855
    });
  });
});

function makeColony(): ColonySnapshot {
  const room = makeOwnedRoom('E24S49');
  const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;

  return {
    room,
    spawns: [spawn],
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300,
    spawnEnergyBudget: 1_300,
    memory: room.memory
  };
}

function makeOwnedRoom(roomName: string): Room & { memory: RoomMemory } {
  return {
    name: roomName,
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300,
    controller: {
      id: `controller-${roomName.toLowerCase()}` as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 4,
      ticksToDowngrade: 10_000
    } as StructureController,
    storage: {
      store: {
        getUsedCapacity: jest.fn(() => 0)
      }
    },
    find: jest.fn((findType: number) => (findType === FIND_SOURCES ? makeSources(roomName) : [])),
    memory: {}
  } as unknown as Room & { memory: RoomMemory };
}

function setGame(colony: ColonySnapshot, gameTime: number): void {
  const e26s48 = makeOwnedRoom('E26S48');
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: gameTime,
    rooms: {
      E24S49: colony.room,
      E26S48: e26s48
    },
    map: {
      describeExits: jest.fn((roomName: string) => {
        if (roomName === 'E24S49') {
          return { '5': 'E26S50', '7': 'E26S48' };
        }

        if (roomName === 'E26S48') {
          return { '3': 'E24S49', '7': 'E26S47' };
        }

        return {};
      }),
      findRoute: jest.fn((fromRoom: string, toRoom: string) => {
        if (fromRoom === 'E24S49' && toRoom === 'E26S50') {
          return [{ exit: 5, room: 'E26S50' }];
        }

        if (fromRoom === 'E24S49' && toRoom === 'E26S47') {
          return [
            { exit: 7, room: 'E26S48' },
            { exit: 7, room: 'E26S47' }
          ];
        }

        if (fromRoom === 'E26S48' && toRoom === 'E26S47') {
          return [{ exit: 7, room: 'E26S47' }];
        }

        return [];
      })
    } as unknown as GameMap
  };
}

function setE26S47ScoutIntel(intel: TerritoryScoutIntelMemory): void {
  Memory.territory = {
    ...(Memory.territory ?? {}),
    scoutIntel: {
      ...(Memory.territory?.scoutIntel ?? {}),
      'E24S49>E26S47': intel
    }
  };
}

function setE26S50UnavailableScoutIntel(updatedAt: number): void {
  Memory.territory = {
    ...(Memory.territory ?? {}),
    scoutIntel: {
      ...(Memory.territory?.scoutIntel ?? {}),
      'E24S49>E26S50': {
        colony: 'E24S49',
        roomName: 'E26S50',
        updatedAt,
        controller: { id: 'controller-e26s50' as Id<StructureController>, ownerUsername: 'enemy' },
        sourceIds: ['source-e26s50-a', 'source-e26s50-b'],
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

function makeScoutIntel(overrides: Partial<TerritoryScoutIntelMemory> = {}): TerritoryScoutIntelMemory {
  return {
    colony: 'E24S49',
    roomName: 'E26S47',
    updatedAt: 849,
    controller: { id: 'controller-e26s47' as Id<StructureController>, my: false },
    sourceIds: ['source-e26s47-a', 'source-e26s47-b'],
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
