import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planSpawn } from '../src/spawn/spawnPlanner';
import {
  ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART,
  ADJACENT_ROOM_RESERVATION_TARGET_CREATOR,
  refreshAdjacentRoomReservationIntent
} from '../src/territory/reservationPlanner';

describe('adjacent room reservation planner', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 4;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 5;
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 6;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { FIND_MY_CONSTRUCTION_SITES?: number }).FIND_MY_CONSTRUCTION_SITES;
    delete (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
    delete (globalThis as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
  });

  it('selects the highest-priority scouted adjacent room when GCL blocks claiming', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W2N1: makeReservationRoom('W2N1', { sourceCount: 1 }),
        W1N2: makeReservationRoom('W1N2', { sourceCount: 2 })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });

    const evaluation = refreshAdjacentRoomReservationIntent(colony, 100);

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      claimBlocker: 'gclInsufficient',
      targetRoom: 'W1N2'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve',
        createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR,
        controllerId: 'controller-W1N2'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 100,
        createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR,
        controllerId: 'controller-W1N2'
      }
    ]);
  });

  it('prefers an unscouted adjacent room before low-priority scouted rooms', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', { sourceCount: 1 })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });

    const evaluation = refreshAdjacentRoomReservationIntent(colony, 100);

    expect(evaluation).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      claimBlocker: 'gclInsufficient',
      targetRoom: 'W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 100,
        createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
      }
    ]);
  });

  it('uses persisted expansion ranking to choose the top-ranked scouted room', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', { sourceCount: 1 }),
        W2N1: makeReservationRoom('W2N1', { sourceCount: 2 })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });
    Memory.territory = {
      expansionCandidates: [
        {
          colony: 'W1N1',
          roomName: 'W1N2',
          rank: 1,
          score: 150,
          evidenceStatus: 'sufficient',
          visible: true,
          updatedAt: 99,
          adjacentToOwnedRoom: true
        },
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          rank: 2,
          score: 600,
          evidenceStatus: 'sufficient',
          visible: true,
          updatedAt: 99,
          adjacentToOwnedRoom: true
        }
      ]
    };

    expect(refreshAdjacentRoomReservationIntent(colony, 100)).toMatchObject({
      status: 'planned',
      targetRoom: 'W1N2'
    });
  });

  it('uses persisted expansion score when scouted expansion ranks tie', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', { sourceCount: 2 }),
        W2N1: makeReservationRoom('W2N1', { sourceCount: 1 })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });
    Memory.territory = {
      expansionCandidates: [
        {
          colony: 'W1N1',
          roomName: 'W1N2',
          rank: 1,
          score: 150,
          evidenceStatus: 'sufficient',
          visible: true,
          updatedAt: 99,
          adjacentToOwnedRoom: true
        },
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          rank: 1,
          score: 600,
          evidenceStatus: 'sufficient',
          visible: true,
          updatedAt: 99,
          adjacentToOwnedRoom: true
        }
      ]
    };

    expect(refreshAdjacentRoomReservationIntent(colony, 100)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });
  });

  it('plans reservations when the RCL room limit blocks another claim', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      gclLevel: 5,
      rooms: {
        W3N1: makeOwnedRoom('W3N1'),
        W1N2: makeReservationRoom('W1N2', { sourceCount: 2 })
      },
      exits: { W1N1: { '1': 'W1N2' } }
    });

    expect(refreshAdjacentRoomReservationIntent(colony, 101)).toMatchObject({
      status: 'planned',
      claimBlocker: 'rclRoomLimitReached',
      targetRoom: 'W1N2'
    });
  });

  it('does not reserve when the colony can claim the adjacent room', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W1N2',
            action: 'reserve',
            createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
          }
        ],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'planned',
            updatedAt: 99,
            createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
          }
        ]
      }
    };
    installGame(colony, {
      gclLevel: 5,
      rooms: {
        W1N2: makeReservationRoom('W1N2', { sourceCount: 2 })
      },
      exits: { W1N1: { '1': 'W1N2' } }
    });

    expect(refreshAdjacentRoomReservationIntent(colony, 102)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'claimAllowed'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('avoids rooms with hostile reservations', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', {
          sourceCount: 2,
          controller: {
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          }
        })
      },
      exits: { W1N1: { '1': 'W1N2' } }
    });

    expect(refreshAdjacentRoomReservationIntent(colony, 103)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'noCandidate',
      claimBlocker: 'gclInsufficient'
    });
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it('renews own reservations at the single-claim renewal window', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    const controller = {
      reservation: {
        username: 'me',
        ticksToEnd: ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART + 1
      }
    };
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', { sourceCount: 2, controller })
      },
      exits: { W1N1: { '1': 'W1N2' } }
    });

    expect(refreshAdjacentRoomReservationIntent(colony, 104)).toMatchObject({
      status: 'skipped',
      reason: 'reservationHealthy',
      targetRoom: 'W1N2',
      reservationTicksToEnd: ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART + 1
    });
    expect(Memory.territory?.targets).toBeUndefined();

    controller.reservation.ticksToEnd = ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART;

    expect(refreshAdjacentRoomReservationIntent(colony, 105)).toMatchObject({
      status: 'planned',
      targetRoom: 'W1N2',
      reservationTicksToEnd: ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART
    });
    expect(Memory.territory?.targets).toEqual([
      expect.objectContaining({
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve',
        createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
      })
    ]);
  });

  it('renews a due own reservation before reserving an unscouted room', () => {
    const { colony } = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', {
          sourceCount: 2,
          controller: {
            reservation: {
              username: 'me',
              ticksToEnd: ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART
            }
          }
        })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });

    expect(refreshAdjacentRoomReservationIntent(colony, 106)).toMatchObject({
      status: 'planned',
      targetRoom: 'W1N2',
      reservationTicksToEnd: ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART
    });
  });

  it('dispatches a scaled reserver body for a planned reservation', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 1300, energyCapacityAvailable: 1300 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', { sourceCount: 2 })
      },
      exits: { W1N1: { '1': 'W1N2' } }
    });
    refreshAdjacentRoomReservationIntent(colony, 106);

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 107)).toEqual({
      spawn,
      body: ['claim', 'claim', 'move', 'move'],
      name: 'claimer-W1N1-W1N2-107',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W1N2',
          action: 'reserve',
          controllerId: 'controller-W1N2' as Id<StructureController>
        }
      }
    });
  });

  it('dispatches a reserver body rather than a scout for unscouted reservation targets', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 1300, energyCapacityAvailable: 1300 });
    installGame(colony, {
      gclLevel: 1,
      rooms: {
        W1N2: makeReservationRoom('W1N2', { sourceCount: 1 })
      },
      exits: { W1N1: { '1': 'W1N2', '3': 'W2N1' } }
    });
    refreshAdjacentRoomReservationIntent(colony, 107);

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 108)).toEqual({
      spawn,
      body: ['claim', 'claim', 'move', 'move'],
      name: 'claimer-W1N1-W2N1-108',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'reserve'
        }
      }
    });
  });
});

function makeColony({
  roomName = 'W1N1',
  energyAvailable,
  energyCapacityAvailable,
  controller = makeOwnedController(roomName)
}: {
  roomName?: string;
  energyAvailable: number;
  energyCapacityAvailable: number;
  controller?: StructureController;
}): { colony: ColonySnapshot; spawn: StructureSpawn } {
  const room = {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return [makeSource(`source-${roomName}`, 10, 10, roomName)];
      }

      return [];
    })
  } as unknown as Room;
  const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
  return {
    colony: { room, spawns: [spawn], energyAvailable, energyCapacityAvailable },
    spawn
  };
}

function installGame(
  colony: ColonySnapshot,
  {
    gclLevel,
    rooms,
    exits
  }: {
    gclLevel: number;
    rooms: Record<string, Room>;
    exits: Record<string, Partial<Record<'1' | '3' | '5' | '7', string>>>;
  }
): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 100,
    gcl: { level: gclLevel, progress: 0, progressTotal: 0 } as GlobalControlLevel,
    rooms: { [colony.room.name]: colony.room, ...rooms },
    spawns: {},
    creeps: {},
    getObjectById: jest.fn().mockReturnValue(null),
    map: makeMap(exits)
  };
}

function makeOwnedRoom(roomName: string): Room {
  return makeReservationRoom(roomName, {
    sourceCount: 1,
    controller: { my: true, owner: { username: 'me' } }
  });
}

function makeReservationRoom(
  roomName: string,
  options: {
    sourceCount: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
    controller?: Partial<StructureController> | null;
  }
): Room {
  const sources = Array.from({ length: options.sourceCount }, (_value, index) =>
    makeSource(`source-${roomName}-${index}`, 20 + index * 10, 20 + index * 10, roomName)
  );
  const hostileCreeps = Array.from({ length: options.hostileCreepCount ?? 0 }, (_value, index) => ({
    id: `hostile-creep-${index}`
  })) as Creep[];
  const hostileStructures = Array.from({ length: options.hostileStructureCount ?? 0 }, (_value, index) => ({
    id: `hostile-structure-${index}`
  })) as Structure[];

  return {
    name: roomName,
    controller: options.controller === null ? undefined : makeController(roomName, options.controller),
    find: jest.fn((findType: number) => {
      if (findType === FIND_SOURCES) {
        return sources;
      }

      if (findType === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      if (findType === FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeOwnedController(roomName: string): StructureController {
  return {
    id: `controller-${roomName}` as Id<StructureController>,
    my: true,
    level: 3,
    ticksToDowngrade: 10_000,
    owner: { username: 'me' }
  } as StructureController;
}

function makeController(
  roomName: string,
  overrides: Partial<StructureController> = {}
): StructureController {
  return {
    id: `controller-${roomName}` as Id<StructureController>,
    my: false,
    pos: makeRoomPosition(25, 25, roomName),
    ...overrides
  } as StructureController;
}

function makeSource(id: string, x: number, y: number, roomName: string): Source {
  return {
    id: id as Id<Source>,
    pos: makeRoomPosition(x, y, roomName)
  } as Source;
}

function makeRoomPosition(x: number, y: number, roomName: string): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: (target: RoomPosition) => Math.max(Math.abs(x - target.x), Math.abs(y - target.y))
  } as RoomPosition;
}

function makeMap(exits: Record<string, Partial<Record<'1' | '3' | '5' | '7', string>>>): GameMap {
  return {
    describeExits: jest.fn((roomName: string) => exits[roomName] ?? {}),
    findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 3, room: toRoom }]),
    getRoomLinearDistance: jest.fn((_fromRoom: string, _toRoom: string) => 1),
    getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) } as unknown as RoomTerrain))
  } as unknown as GameMap;
}
