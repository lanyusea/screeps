import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import {
  buildRuntimeExpansionCandidateReport,
  scoreExpansionCandidates,
  selectExpansionScoutTargets
} from '../../src/territory/expansionScoring';
import { installLegacyE17S59ExpansionScoutTargets } from '../helpers/runtimeRoomConfig';

describe('configured territory expansion scoring', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 10;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    installLegacyE17S59ExpansionScoutTargets();
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
  });

  it('scores E18S59 as the nearest configured expansion candidate for E17S59', () => {
    const colony = makeColony('E17S59');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 840,
      rooms: {
        E17S59: colony.room,
        E17S58: makeOwnedRoom('E17S58')
      },
      map: {
        describeExits: jest.fn(() => ({})),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    const report = buildRuntimeExpansionCandidateReport(colony);
    const candidate = getCandidate(report, 'E18S59');

    expect(report.candidates[0]).toMatchObject({
      roomName: 'E18S59',
      evidenceStatus: 'insufficient-evidence',
      visible: false,
      adjacentToOwnedRoom: true,
      nearestOwnedRoom: 'E17S59',
      nearestOwnedRoomDistance: 1,
      routeDistance: 1
    });
    expect(candidate).toBe(report.candidates[0]);
    expect(selectExpansionScoutTargets(report, 2, 840).map((target) => target.roomName)).toEqual([
      'E18S59',
      'E17S60'
    ]);
  });

  it('scores E17S60 for scouting once E17S58 is owned', () => {
    const colony = makeColony('E17S59');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 841,
      rooms: {
        E17S59: colony.room,
        E17S58: makeOwnedRoom('E17S58')
      },
      map: {
        describeExits: jest.fn(() => ({})),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    const report = buildRuntimeExpansionCandidateReport(colony);
    const candidate = getCandidate(report, 'E17S60');

    expect(candidate).toMatchObject({
      roomName: 'E17S60',
      visible: false,
      evidenceStatus: 'insufficient-evidence',
      adjacentToOwnedRoom: true,
      nearestOwnedRoom: 'E17S58',
      nearestOwnedRoomDistance: 1,
      routeDistance: 2,
      risks: expect.arrayContaining([
        'controller evidence missing until scout',
        'source count evidence missing until scout',
        'hostile evidence missing until scout'
      ])
    });
    expect(selectExpansionScoutTargets(report, 2, 841)).toEqual(
      expect.arrayContaining([expect.objectContaining({ roomName: 'E17S60', distance: 1 })])
    );
  });

  it('keeps E17S60 out of runtime scoring before E17S58 is owned', () => {
    const colony = makeColony('E17S59');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 841,
      rooms: {
        E17S59: colony.room
      },
      map: {
        describeExits: jest.fn(() => ({})),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.candidates.map((candidate) => candidate.roomName)).not.toContain('E17S60');
  });

  it('includes configured E34N49 for E29N55 despite long-range route distance', () => {
    const colony = makeColony('E29N55');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1746986,
      rooms: {
        E29N55: colony.room
      },
      map: makeMap()
    };

    const report = buildRuntimeExpansionCandidateReport(colony);
    const candidate = getCandidate(report, 'E34N49');

    expect(candidate).toMatchObject({
      roomName: 'E34N49',
      visible: false,
      evidenceStatus: 'insufficient-evidence',
      adjacentToOwnedRoom: false,
      nearestOwnedRoom: 'E29N55',
      nearestOwnedRoomDistance: 11,
      routeDistance: 11,
      allowLongRange: true,
      risks: expect.arrayContaining([
        'controller evidence missing until scout',
        'source count evidence missing until scout',
        'hostile evidence missing until scout'
      ])
    });
    expect(selectExpansionScoutTargets(report, 10, 1746986)).toEqual(
      expect.arrayContaining([expect.objectContaining({ roomName: 'E34N49', distance: 11 })])
    );
  });

  it('keeps unconfigured far runtime rooms excluded by the nearby expansion filter', () => {
    const colony = makeColony('E29N55');
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1746986,
      rooms: {
        E29N55: colony.room,
        E40N40: makeNeutralRoom('E40N40')
      },
      map: makeMap()
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.candidates.map((candidate) => candidate.roomName)).not.toContain('E40N40');
  });

  it.each([
    [
      'foreign-owned controller',
      {
        controller: {
          id: 'controller-E34N49' as Id<StructureController>,
          my: false,
          ownerUsername: 'enemy'
        }
      },
      ['enemy-owned controller cannot be claimed safely']
    ],
    [
      'hostile presence',
      {
        hostileCreepCount: 1
      },
      ['hostile presence scouted']
    ]
  ])('keeps configured E34N49 unavailable with %s scout intel', (_caseName, intelOverrides, expectedRisks) => {
    const colony = makeColony('E29N55');
    Memory.territory = {
      ...(Memory.territory ?? {}),
      scoutIntel: {
        'E29N55>E34N49': makeScoutIntel('E29N55', 'E34N49', intelOverrides)
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1746986,
      rooms: {
        E29N55: colony.room
      },
      map: makeMap()
    };

    const report = buildRuntimeExpansionCandidateReport(colony);
    const candidate = getCandidate(report, 'E34N49');

    expect(candidate).toMatchObject({
      roomName: 'E34N49',
      evidenceStatus: 'unavailable',
      allowLongRange: true,
      risks: expect.arrayContaining(expectedRisks)
    });
    expect(selectExpansionScoutTargets(report, 10, 1746986).map((target) => target.roomName)).not.toContain(
      'E34N49'
    );
  });
});

function makeColony(roomName: string): ColonySnapshot {
  const room = makeOwnedRoom(roomName);
  const colony = {
    room,
    spawns: [],
    energyAvailable: 1_300,
    energyCapacityAvailable: 1_300
  };
  (room as Room & { memory?: RoomMemory }).memory = {};
  return colony;
}

function makeOwnedRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: 4,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn((findType: number): unknown[] => {
      if (findType === FIND_SOURCES) {
        return [
          { id: `${roomName}-source-a` },
          { id: `${roomName}-source-b` }
        ];
      }
      return [];
    })
  } as unknown as Room;
}

function makeNeutralRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false,
      pos: { x: 25, y: 25, roomName } as RoomPosition
    } as StructureController,
    find: jest.fn((findType: number): unknown[] => {
      if (findType === FIND_SOURCES) {
        return [
          { id: `${roomName}-source-a`, pos: { x: 10, y: 20, roomName } },
          { id: `${roomName}-source-b`, pos: { x: 35, y: 40, roomName } }
        ];
      }
      return [];
    })
  } as unknown as Room;
}

function makeTerrain(mask: number): RoomTerrain {
  return {
    get: jest.fn(() => mask)
  } as unknown as RoomTerrain;
}

function makeMap(): GameMap {
  return {
    describeExits: jest.fn(() => ({})),
    getRoomTerrain: jest.fn(() => makeTerrain(0)),
    getRoomLinearDistance: jest.fn((fromRoom: string, targetRoom: string) =>
      getTestRouteDistance(fromRoom, targetRoom)
    ),
    findRoute: jest.fn((fromRoom: string, targetRoom: string) =>
      Array.from({ length: getTestRouteDistance(fromRoom, targetRoom) }, (_value, index) => ({
        exit: 1,
        room: `${targetRoom}-${index}`
      }))
    )
  } as unknown as GameMap;
}

function getTestRouteDistance(fromRoom: string, targetRoom: string): number {
  if (fromRoom === targetRoom) {
    return 0;
  }

  if (targetRoom === 'E34N49') {
    return 11;
  }

  if (targetRoom === 'E40N40') {
    return 30;
  }

  return 1;
}

function makeScoutIntel(
  colony: string,
  roomName: string,
  overrides: Partial<TerritoryScoutIntelMemory> = {}
): TerritoryScoutIntelMemory {
  return {
    colony,
    roomName,
    updatedAt: 1746986,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false
    },
    sourceIds: [`${roomName}-source-a`, `${roomName}-source-b`],
    sourceCount: 2,
    sourceAccessPoints: 8,
    controllerSourceRange: 23,
    terrain: { walkableRatio: 0.9, swampRatio: 0.04, wallRatio: 0.1 },
    mineral: { id: `${roomName}-mineral`, mineralType: 'U' },
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    hostileSpawnCount: 0,
    ...overrides
  };
}

function getCandidate(
  report: ReturnType<typeof scoreExpansionCandidates>,
  roomName: string
): ReturnType<typeof scoreExpansionCandidates>['candidates'][number] {
  const candidate = report.candidates.find((entry) => entry.roomName === roomName);
  if (!candidate) {
    throw new Error(`Missing expansion candidate ${roomName}`);
  }
  return candidate;
}
