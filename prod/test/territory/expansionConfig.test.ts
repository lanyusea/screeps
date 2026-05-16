import {
  getCurrentRoomScoutOnlyAdjacentRoomNames,
  getRuntimeCurrentRoomScoutOnlyTargets,
  getTerritoryExpansionScoutTargets
} from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('derives current-room scout-only neighbors from E29N55 without static tactical literals', () => {
    expect(getCurrentRoomScoutOnlyAdjacentRoomNames('E29N55')).toEqual(['E29N56', 'E29N54', 'E28N55', 'E30N55']);
  });

  it('bounds the active official runtime scout-only target to E29N56', () => {
    const room = makeOwnedRoom('E29N55');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        E29N55: room
      },
      spawns: {
        Spawn1: makeSpawn('Spawn1', room)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      }
    };

    expect(getRuntimeCurrentRoomScoutOnlyTargets('E29N55')).toEqual([
      {
        colony: 'E29N55',
        roomName: 'E29N56',
        nearestOwnedRoom: 'E29N55',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      }
    ]);
  });

  it('derives current-room scout-only neighbors across quadrant edges', () => {
    expect(getCurrentRoomScoutOnlyAdjacentRoomNames('E0S0')).toEqual(['E0N0', 'E0S1', 'W0S0', 'E1S0']);
  });

  it('derives current-room scout-only neighbors from a different runtime room', () => {
    const room = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        W8N3: room
      },
      spawns: {
        Spawn1: makeSpawn('Spawn1', room)
      }
    };

    expect(getRuntimeCurrentRoomScoutOnlyTargets('W8N3')).toEqual(makeW8N3ScoutOnlyTargets());
  });

  it('does not include inferred current-room scout-only targets without runtime memory initialization', () => {
    const room = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {},
      spawns: {
        Spawn1: makeSpawn('Spawn1', room)
      }
    };

    expect(getTerritoryExpansionScoutTargets('W8N3')).toEqual([]);
  });

  it('does not include visible-room scout-only targets without runtime memory initialization', () => {
    const room = makeOwnedRoom('W8N3');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        W8N3: room
      },
      spawns: {}
    };

    expect(getTerritoryExpansionScoutTargets('W8N3')).toEqual([]);
  });

  it('merges explicit Memory scout targets with runtime current-room scout-only targets', () => {
    const room = makeOwnedRoom('E29N55');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        E29N55: room
      },
      spawns: {
        Spawn1: makeSpawn('Spawn1', room)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      },
      territory: {
        expansionScoutTargets: [
          {
            colony: 'E29N55',
            roomName: 'E31N55',
            nearestOwnedRoom: 'E29N55',
            nearestOwnedRoomDistance: 2,
            routeDistance: 2,
            adjacentToOwnedRoom: false
          }
        ]
      }
    };

    expect(getTerritoryExpansionScoutTargets('E29N55')).toEqual([
      {
        colony: 'E29N55',
        roomName: 'E31N55',
        nearestOwnedRoom: 'E29N55',
        nearestOwnedRoomDistance: 2,
        routeDistance: 2,
        adjacentToOwnedRoom: false
      },
      {
        colony: 'E29N55',
        roomName: 'E29N56',
        nearestOwnedRoom: 'E29N55',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      }
    ]);
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

function makeW8N3ScoutOnlyTargets(): ReturnType<typeof getTerritoryExpansionScoutTargets> {
  return [
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
  ];
}
