import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import { planSpawn } from '../../src/spawn/spawnPlanner';
import { planTerritoryIntent } from '../../src/territory/territoryPlanner';

describe('adjacent expansion reservation decisions', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 5;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  });

  it('spawns a reserver for a two-source adjacent room with neutral scout intel and no threats', () => {
    const { colony, spawn } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 100);
    installScoutIntel('W2N1', { updatedAt: 99 });

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 100)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-100',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'reserve',
          controllerId: 'controller-W2N1' as Id<StructureController>
        }
      }
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('reserves a one-source adjacent room only when no better scouted candidate exists', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 101);
    installScoutIntel('W2N1', { sourceCount: 1, updatedAt: 100 });

    const plan = planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 101);

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('does not reserve an adjacent room when scout intel reports hostiles', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 102);
    installScoutIntel('W2N1', { hostileCreepCount: 1, updatedAt: 101 });

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 102)).toBeNull();
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it('reserves viable scouted adjacent rooms even before claim-scale worker readiness', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 103);
    installScoutIntel('W2N1', { updatedAt: 102 });

    expect(planTerritoryIntent(colony, { worker: 2, claimer: 0, claimersByTargetRoom: {} }, 2, 103)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('reserves a scouted adjacent room while one claim claimer is active for the colony', () => {
    const { colony } = makeColony();
    installGame(colony, { '1': 'W2N1', '3': 'W3N1' }, 104);
    installScoutIntel('W2N1', { updatedAt: 103 });
    installScoutIntel('W3N1', { updatedAt: 103 });

    expect(
      planTerritoryIntent(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { claim: { W2N1: 1 } }
        },
        3,
        104
      )
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('does not let active reserve claimers for another room block a scouted reservation target', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 105);
    installScoutIntel('W2N1', { updatedAt: 104 });

    expect(
      planTerritoryIntent(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W3N1: 1 },
          claimersByTargetRoomAction: { reserve: { W3N1: 1 } }
        },
        3,
        105
      )
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('keeps reserving from scout intel instead of duplicating an existing live claim claimer for the same target', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 106);
    installScoutIntel('W2N1', { updatedAt: 105 });

    expect(
      planTerritoryIntent(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { claim: { W2N1: 1 } }
        },
        3,
        106
      )
    ).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('keeps a persisted occupation reserve recommendation as a reserve after scout intel confirms the room', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 107);
    installScoutIntel('W2N1', { updatedAt: 106 });
    Memory.territory = {
      ...(Memory.territory ?? {}),
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'reserve',
          createdBy: 'occupationRecommendation'
        }
      ]
    };

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 107)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      createdBy: 'occupationRecommendation',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 107,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('selects the best viable expansion reservation from scout intel', () => {
    const { colony } = makeColony();
    installGame(colony, { '1': 'W1N2', '3': 'W2N1', '5': 'W1N0', '7': 'W0N1' }, 108);
    installScoutIntel('W1N2', {
      updatedAt: 107,
      controller: { id: 'controller-W1N2' as Id<StructureController>, ownerUsername: 'enemy' }
    });
    installScoutIntel('W2N1', {
      updatedAt: 107,
      controller: {
        id: 'controller-W2N1' as Id<StructureController>,
        reservationUsername: 'enemy',
        reservationTicksToEnd: 3_000
      }
    });
    installScoutIntel('W1N0', {
      updatedAt: 107,
      hostileStructureCount: 0,
      hostileSpawnCount: 1
    });
    installScoutIntel('W0N1', { updatedAt: 107 });

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 108)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W0N1',
      action: 'reserve',
      controllerId: 'controller-W0N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W0N1',
        action: 'reserve',
        controllerId: 'controller-W0N1'
      }
    ]);
  });

  it('prefers two-source scout intel over a one-source adjacent room', () => {
    const { colony } = makeColony();
    installGame(colony, { '1': 'W1N2', '3': 'W2N1' }, 109);
    installScoutIntel('W1N2', { sourceCount: 1, sourceIds: ['source0'], updatedAt: 108 });
    installScoutIntel('W2N1', { updatedAt: 108 });

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 109)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
  });

  it('skips a scouted expansion reservation when route lookup reports no path', () => {
    const { colony } = makeColony();
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = -2 as ScreepsReturnCode;
    installGame(
      colony,
      { '1': 'W1N2', '3': 'W2N1' },
      110,
      jest.fn((_fromRoom: string, toRoom: string) =>
        toRoom === 'W1N2' ? (-2 as ScreepsReturnCode) : [{ exit: 3, room: toRoom }]
      )
    );
    installScoutIntel('W1N2', { updatedAt: 109 });
    installScoutIntel('W2N1', { updatedAt: 109 });

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 110)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
  });

  it('plans reservation renewal from scout intel when our reservation is nearly expired', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 111);
    installScoutIntel('W2N1', {
      updatedAt: 110,
      controller: {
        id: 'controller-W2N1' as Id<StructureController>,
        reservationUsername: 'me',
        reservationTicksToEnd: 500
      }
    });

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 111)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller-W2N1'
    });
  });
});

function makeColony(): { colony: ColonySnapshot; spawn: StructureSpawn } {
  const room = {
    name: 'W1N1',
    energyAvailable: 650,
    energyCapacityAvailable: 650,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case FIND_SOURCES:
          return [{ id: 'source0' }];
        case FIND_MY_CONSTRUCTION_SITES:
        case FIND_HOSTILE_CREEPS:
        case FIND_HOSTILE_STRUCTURES:
        case FIND_MY_STRUCTURES:
          return [];
        default:
          return [];
      }
    })
  } as unknown as Room;
  const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;

  return {
    spawn,
    colony: {
      room,
      spawns: [spawn],
      energyAvailable: 650,
      energyCapacityAvailable: 650
    }
  };
}

function installGame(
  colony: ColonySnapshot,
  exits: Record<string, string>,
  time: number,
  findRoute?: (fromRoom: string, toRoom: string) => unknown
): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    map: {
      describeExits: jest.fn(() => exits),
      ...(findRoute ? { findRoute } : {})
    } as unknown as GameMap,
    rooms: {
      [colony.room.name]: colony.room
    }
  };
}

function installScoutIntel(
  roomName: string,
  overrides: Partial<TerritoryScoutIntelMemory> = {}
): void {
  const controllerId = `controller-${roomName}` as Id<StructureController>;
  Memory.territory = {
    ...(Memory.territory ?? {}),
    scoutIntel: {
      ...(Memory.territory?.scoutIntel ?? {}),
      [`W1N1>${roomName}`]: {
        colony: 'W1N1',
        roomName,
        updatedAt: 0,
        controller: { id: controllerId, my: false },
        sourceIds: ['source0', 'source1'],
        sourceCount: 2,
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        hostileSpawnCount: 0,
        ...overrides
      }
    }
  };
}
