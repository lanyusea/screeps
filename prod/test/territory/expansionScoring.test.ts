import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import {
  buildRuntimeExpansionCandidateReport,
  scoreExpansionCandidates,
  selectExpansionScoutTargets
} from '../../src/territory/expansionScoring';

describe('configured territory expansion scoring', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 10;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
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

function makeTerrain(mask: number): RoomTerrain {
  return {
    get: jest.fn(() => mask)
  } as unknown as RoomTerrain;
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
