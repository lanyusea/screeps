import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planSpawn } from '../src/spawn/spawnPlanner';
import { refreshReserveExecutionTargets } from '../src/territory/reserveExecutor';

describe('reserve executor', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {},
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('dispatches action-hint reserve targets into reserver spawn planning', () => {
    const colony = makeColony();
    const spawn = { name: 'Spawn1', room: colony.room, spawning: null } as StructureSpawn;
    colony.spawns = [spawn];
    const targetRoom = makeTargetRoom('W2N1', 'controller2' as Id<StructureController>);
    (Game.rooms as Record<string, Room>).W1N1 = colony.room;
    (Game.rooms as Record<string, Room>).W2N1 = targetRoom;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            actionHint: 'reserve',
            createdBy: 'expansionPlanner',
            controllerId: 'controller2' as Id<StructureController>
          } as unknown as TerritoryTargetMemory
        ]
      }
    };

    expect(refreshReserveExecutionTargets({ colony: 'W1N1', gameTime: 201 })).toEqual({
      action: 'reserve',
      targetCount: 1,
      intentCount: 1
    });

    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 201,
        createdBy: 'expansionPlanner',
        controllerId: 'controller2'
      }
    ]);
    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 202)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-202',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'reserve',
          controllerId: 'controller2'
        }
      }
    });
  });

  it('does not revive suppressed reserve intents while canonicalizing the target', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            actionHint: 'reserve'
          } as unknown as TerritoryTargetMemory
        ],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: 190
          }
        ]
      }
    };

    expect(refreshReserveExecutionTargets({ colony: 'W1N1', gameTime: 201 })).toEqual({
      action: 'reserve',
      targetCount: 1,
      intentCount: 0
    });
    expect(Memory.territory?.targets?.[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      action: 'reserve',
      actionHint: 'reserve'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 190
      }
    ]);
  });
});

function makeColony(): ColonySnapshot {
  const room = {
    name: 'W1N1',
    energyAvailable: 650,
    energyCapacityAvailable: 650,
    controller: {
      id: 'controller1' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 6,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: 'source1' } as Source] : []))
  } as unknown as Room;

  return {
    room,
    spawns: [],
    energyAvailable: 650,
    energyCapacityAvailable: 650
  };
}

function makeTargetRoom(roomName: string, controllerId: Id<StructureController>): Room {
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false
    } as StructureController,
    find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: `${roomName}-source` } as Source] : []))
  } as unknown as Room;
}
