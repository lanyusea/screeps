import { cleanupDeadCreepMemory, initializeMemory } from '../src/memory/schema';
import { getTerritoryExpansionScoutTargets } from '../src/territory/expansionConfig';

describe('memory schema initialization', () => {
  beforeEach(() => {
    (globalThis as unknown as { Memory: Memory }).Memory = {} as Memory;
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('initializes Memory.meta.version when missing', () => {
    initializeMemory();

    expect(Memory.meta.version).toBe(1);
  });

  it('preserves existing Memory values', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      meta: { version: 99 },
      creeps: { existing: { role: 'harvester' } as CreepMemory }
    };

    initializeMemory();

    expect(Memory.meta.version).toBe(99);
    expect(Memory.creeps.existing.role).toBe('harvester');
  });

  it('creates Memory.creeps when missing', () => {
    initializeMemory();

    expect(Memory.creeps).toEqual({});
  });

  it('writes Memory.runtime.currentRoomName from an owned spawn during initialization', () => {
    const room = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {},
      spawns: {
        Spawn1: makeSpawn('Spawn1', room)
      }
    };

    initializeMemory();

    expect(Memory.runtime?.currentRoomName).toBe('W8N3');
    expect(Memory.runtime?.ownedRoomNames).toEqual(['W8N3']);
  });

  it('writes Memory.runtime.currentRoomName from a visible owned room during initialization', () => {
    const room = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        W8N3: room
      },
      spawns: {}
    };

    initializeMemory();

    expect(Memory.runtime?.currentRoomName).toBe('W8N3');
    expect(Memory.runtime?.ownedRoomNames).toEqual(['W8N3']);
  });

  it('overwrites stale Memory.runtime room state when live ownership changes', () => {
    const room = makeOwnedRoom('W8N3');
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'W5N5',
        ownedRoomNames: ['W5N5']
      }
    };
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        W8N3: room
      },
      spawns: {}
    };

    initializeMemory();

    expect(Memory.runtime?.currentRoomName).toBe('W8N3');
    expect(Memory.runtime?.ownedRoomNames).toEqual(['W8N3']);
  });

  it('enables current-room scout-only targets after production memory initialization', () => {
    const room = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {},
      spawns: {
        Spawn1: makeSpawn('Spawn1', room)
      }
    };

    initializeMemory();

    expect(getTerritoryExpansionScoutTargets('W8N3')).toEqual([
      {
        colony: 'W8N3',
        roomName: 'W8N4',
        nearestOwnedRoom: 'W8N3',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      },
      {
        colony: 'W8N3',
        roomName: 'W8N2',
        nearestOwnedRoom: 'W8N3',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      },
      {
        colony: 'W8N3',
        roomName: 'W9N3',
        nearestOwnedRoom: 'W8N3',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      },
      {
        colony: 'W8N3',
        roomName: 'W7N3',
        nearestOwnedRoom: 'W8N3',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      }
    ]);
  });

  it.each([17, ['bad-runtime']])(
    'sanitizes non-object Memory.runtime during initialization',
    (runtime) => {
      const room = makeOwnedRoom('W8N3');
      (globalThis as unknown as { Memory: Memory }).Memory = ({ runtime } as unknown) as Memory;
      (globalThis as { Game: Partial<Game> }).Game = {
        rooms: {},
        spawns: {
          Spawn1: makeSpawn('Spawn1', room)
        }
      };

      initializeMemory();

      expect(Memory.runtime?.currentRoomName).toBe('W8N3');
      expect(Memory.runtime?.ownedRoomNames).toEqual(['W8N3']);
    }
  );

  it('removes memory for creeps no longer present in Game.creeps', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        alive: {} as Creep
      }
    };
    (globalThis as unknown as { Memory: Memory }).Memory = ({
      meta: { version: 1 },
      creeps: {
        alive: { role: 'harvester' } as CreepMemory,
        dead: { role: 'builder' } as CreepMemory
      }
    } as unknown) as Memory;

    cleanupDeadCreepMemory();

    expect(Memory.creeps.alive).toEqual({ role: 'harvester' });
    expect(Memory.creeps.dead).toBeUndefined();
  });
});

function makeOwnedRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: { my: true }
  } as Room;
}

function makeSpawn(name: string, room: Room): StructureSpawn {
  return {
    name,
    my: true,
    room
  } as StructureSpawn;
}
