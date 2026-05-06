import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import { planSpawn } from '../../src/spawn/spawnPlanner';
import { planTerritoryIntent } from '../../src/territory/territoryPlanner';

describe('adjacent expansion claim decisions', () => {
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
  });

  it('spawns a claimer for a two-source adjacent room with neutral scout intel and no threats', () => {
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
          action: 'claim',
          controllerId: 'controller-W2N1' as Id<StructureController>
        }
      }
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('does not claim a one-source adjacent room', () => {
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

  it('does not claim an adjacent room when scout intel reports hostiles', () => {
    const { colony } = makeColony();
    installGame(colony, { '3': 'W2N1' }, 102);
    installScoutIntel('W2N1', { hostileCreepCount: 1, updatedAt: 101 });

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 102)).toBeNull();
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it('falls back to reserve scoring for a viable adjacent claim until the colony has at least three workers', () => {
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

  it('falls back to reserve scoring while one claim claimer is active for the colony', () => {
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

  it('ignores active reserve claimers when deciding whether an adjacent claim claimer is active', () => {
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
      action: 'claim',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('falls back to reserve scoring instead of duplicating an existing live claim claimer for the same target', () => {
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

  it('lets auto-claim override a persisted occupation reserve recommendation for the same room', () => {
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
      action: 'claim',
      createdBy: 'occupationRecommendation',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 107,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller-W2N1'
      }
    ]);
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

function installGame(colony: ColonySnapshot, exits: Record<string, string>, time: number): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    map: {
      describeExits: jest.fn(() => exits)
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
