import { getOwnedColonies } from '../src/colony/colonyRegistry';

describe('getOwnedColonies', () => {
  it('returns owned rooms with their spawns', () => {
    const ownedRoom = {
      name: 'W1N1',
      controller: { my: true },
      energyAvailable: 300,
      energyCapacityAvailable: 300
    } as Room;
    const neutralRoom = {
      name: 'W2N2',
      controller: { my: false },
      energyAvailable: 300,
      energyCapacityAvailable: 300
    } as Room;
    const spawn = { name: 'Spawn1', room: ownedRoom, spawning: null } as StructureSpawn;

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: ownedRoom,
        W2N2: neutralRoom
      },
      spawns: {
        Spawn1: spawn
      }
    };

    expect(getOwnedColonies()).toEqual([
      {
        room: ownedRoom,
        spawns: [spawn],
        energyAvailable: 300,
        energyCapacityAvailable: 300
      }
    ]);
  });

  it('ignores rooms without owned controllers', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W3N3: { name: 'W3N3' } as Room
      },
      spawns: {}
    };

    expect(getOwnedColonies()).toEqual([]);
  });

  it('includes a newly claimed room that becomes owned', () => {
    const oldRoom = {
      name: 'W1N1',
      controller: { my: true },
      energyAvailable: 300,
      energyCapacityAvailable: 300
    } as Room;
    const claimedRoom = {
      name: 'W2N2',
      controller: { my: true },
      energyAvailable: 300,
      energyCapacityAvailable: 300
    } as Room;
    const oldSpawn = { name: 'Spawn1', room: oldRoom, spawning: null } as StructureSpawn;
    const claimedSpawn = { name: 'Spawn2', room: claimedRoom, spawning: null } as StructureSpawn;

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: oldRoom,
        W2N2: claimedRoom
      },
      spawns: {
        Spawn1: oldSpawn,
        Spawn2: claimedSpawn
      }
    };

    expect(getOwnedColonies()).toEqual([
      {
        room: oldRoom,
        spawns: [oldSpawn],
        energyAvailable: 300,
        energyCapacityAvailable: 300
      },
      {
        room: claimedRoom,
        spawns: [claimedSpawn],
        energyAvailable: 300,
        energyCapacityAvailable: 300
      }
    ]);
  });

  it('discovers owned spawn rooms from Game.spawns even when the room map is incomplete', () => {
    const spawnedRoom = {
      name: 'W4N4',
      controller: { my: true },
      energyAvailable: 300,
      energyCapacityAvailable: 300
    } as Room;
    const spawn = { name: 'Spawn4', room: spawnedRoom, spawning: null } as StructureSpawn;

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {},
      spawns: {
        Spawn4: spawn
      }
    };

    expect(getOwnedColonies()).toEqual([
      {
        room: spawnedRoom,
        spawns: [spawn],
        energyAvailable: 300,
        energyCapacityAvailable: 300
      }
    ]);
  });

  it('discovers a fresh simulator room from an owned spawn before controller ownership is visible', () => {
    const simulatorRoom = {
      name: 'E1S1',
      controller: { my: false },
      energyAvailable: 0,
      energyCapacityAvailable: 0
    } as Room;
    const spawn = {
      name: 'Spawn1',
      my: true,
      room: simulatorRoom,
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(300),
        getCapacity: jest.fn().mockReturnValue(300)
      }
    } as unknown as StructureSpawn;

    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        E1S1: simulatorRoom
      },
      spawns: {
        Spawn1: spawn
      }
    };

    expect(getOwnedColonies()).toEqual([
      {
        room: simulatorRoom,
        spawns: [spawn],
        energyAvailable: 300,
        energyCapacityAvailable: 300
      }
    ]);
  });
});
