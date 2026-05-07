import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { buildTerritorySpawnBody } from '../src/spawn/spawnPlanner';
import {
  evaluateExpansionRoomSuitability,
  prioritizeExpansionCandidates
} from '../src/territory/expansionPlanner';
import { planTerritoryIntent, type TerritoryIntentPlan } from '../src/territory/territoryPlanner';

describe('expansion planner', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('evaluates room suitability from source count, hostiles, and controller occupancy', () => {
    expect(evaluateExpansionRoomSuitability(makeExpansionRoom('W2N1'))).toMatchObject({
      suitable: true,
      sourceCount: 2,
      hostileCreepCount: 0,
      hostileStructureCount: 0,
      reasons: []
    });

    expect(evaluateExpansionRoomSuitability(makeExpansionRoom('W2N1', { sourceCount: 1 })).reasons).toContain(
      'sourceCountBelowMinimum'
    );
    expect(
      evaluateExpansionRoomSuitability(makeExpansionRoom('W2N1', { hostileCreepCount: 1 })).reasons
    ).toContain('hostilePresence');
    expect(
      evaluateExpansionRoomSuitability(
        makeExpansionRoom('W2N1', {
          controller: {
            id: 'controller-W2N1' as Id<StructureController>,
            my: false,
            owner: { username: 'enemy' }
          } as StructureController
        })
      ).reasons
    ).toContain('controllerOwned');
    expect(
      evaluateExpansionRoomSuitability(
        makeExpansionRoom('W2N1', {
          controller: {
            id: 'controller-W2N1' as Id<StructureController>,
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController
        })
      ).reasons
    ).toContain('controllerReserved');
  });

  it('prioritizes suitable candidates by source count, distance, and stable order', () => {
    const orderedCandidates = prioritizeExpansionCandidates([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 2,
        sourceCount: 2,
        controllerId: 'controller-W2N1' as Id<StructureController>,
        order: 0
      },
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        distance: 1,
        sourceCount: 2,
        controllerId: 'controller-W1N2' as Id<StructureController>,
        order: 1
      },
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        distance: 1,
        sourceCount: 1,
        controllerId: 'controller-W3N1' as Id<StructureController>,
        order: 2
      },
      {
        colony: 'W1N1',
        roomName: 'W4N1',
        distance: 2,
        sourceCount: 3,
        controllerId: 'controller-W4N1' as Id<StructureController>,
        order: 3
      }
    ]);

    expect(orderedCandidates.map((candidate) => candidate.roomName)).toEqual(['W4N1', 'W1N2', 'W2N1']);
  });

  it('creates expansion targets and intents through territory planning', () => {
    const { colony } = makeColony({ energyAvailable: 1_300, energyCapacityAvailable: 1_300 });
    installGame(colony, {
      gclLevel: 2,
      exits: { W1N1: { '3': 'W2N1' } },
      rooms: {
        W2N1: makeExpansionRoom('W2N1')
      }
    });

    const plan = planTerritoryIntent(
      colony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      100
    );

    expect(plan).toEqual({
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
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 100,
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('keeps claimer and reserver body selection distinct for expansion intents', () => {
    expect(buildTerritorySpawnBody(1_300, makeIntent('claim'))).toEqual([
      'claim',
      'move',
      'work',
      'carry',
      'move',
      'work',
      'carry',
      'move'
    ]);
    expect(buildTerritorySpawnBody(1_300, makeIntent('reserve'))).toEqual(['claim', 'claim', 'move', 'move']);
  });
});

function makeColony({
  energyAvailable = 650,
  energyCapacityAvailable = 650
}: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): { colony: ColonySnapshot } {
  const room = {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: 'controller-W1N1' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn((findType: number): unknown[] => {
      if (findType === FIND_SOURCES) {
        return [{ id: 'source-W1N1-0' }];
      }

      return [];
    })
  } as unknown as Room;

  return {
    colony: {
      room,
      spawns: [],
      energyAvailable,
      energyCapacityAvailable
    }
  };
}

function makeExpansionRoom(
  roomName: string,
  {
    sourceCount = 2,
    hostileCreepCount = 0,
    hostileStructureCount = 0,
    controller = {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false
    } as StructureController
  }: {
    sourceCount?: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
    controller?: StructureController;
  } = {}
): Room {
  return {
    name: roomName,
    controller,
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case FIND_SOURCES:
          return Array.from({ length: sourceCount }, (_value, index) => ({ id: `source-${roomName}-${index}` }));
        case FIND_HOSTILE_CREEPS:
          return Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile-${index}` }));
        case FIND_HOSTILE_STRUCTURES:
          return Array.from({ length: hostileStructureCount }, (_value, index) => ({
            id: `hostile-structure-${index}`
          }));
        default:
          return [];
      }
    })
  } as unknown as Room;
}

function installGame(
  colony: ColonySnapshot,
  {
    gclLevel,
    exits,
    rooms
  }: {
    gclLevel: number;
    exits: Record<string, Record<string, string>>;
    rooms: Record<string, Room>;
  }
): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 100,
    gcl: { level: gclLevel, progress: 0, progressTotal: 0 } as GlobalControlLevel,
    rooms: {
      [colony.room.name]: colony.room,
      ...rooms
    },
    map: {
      describeExits: jest.fn((roomName: string) => exits[roomName] ?? null),
      findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 3, room: toRoom }])
    } as unknown as GameMap
  };
}

function makeIntent(action: TerritoryControlAction): TerritoryIntentPlan {
  return {
    colony: 'W1N1',
    targetRoom: 'W2N1',
    action
  };
}
