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

  it('derives current-room scout-only neighbors from W3N9 without static tactical literals', () => {
    expect(getCurrentRoomScoutOnlyAdjacentRoomNames('W3N9')).toEqual(['W3N10', 'W3N8', 'W4N9', 'W2N9']);
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
    const room = makeOwnedRoom('W3N9');
    (globalThis as { Game: Partial<Game> }).Game = {
      rooms: {
        W3N9: room
      },
      spawns: {
        Spawn1: makeSpawn('Spawn1', room)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'W3N9'
      },
      territory: {
        expansionScoutTargets: [
          {
            colony: 'W3N9',
            roomName: 'W5N9',
            nearestOwnedRoom: 'W3N9',
            nearestOwnedRoomDistance: 2,
            routeDistance: 2,
            adjacentToOwnedRoom: false
          }
        ]
      }
    };

    expect(getTerritoryExpansionScoutTargets('W3N9')).toEqual([
      {
        colony: 'W3N9',
        roomName: 'W5N9',
        nearestOwnedRoom: 'W3N9',
        nearestOwnedRoomDistance: 2,
        routeDistance: 2,
        adjacentToOwnedRoom: false
      },
      {
        colony: 'W3N9',
        roomName: 'W3N10',
        nearestOwnedRoom: 'W3N9',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      },
      {
        colony: 'W3N9',
        roomName: 'W3N8',
        nearestOwnedRoom: 'W3N9',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      },
      {
        colony: 'W3N9',
        roomName: 'W4N9',
        nearestOwnedRoom: 'W3N9',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      },
      {
        colony: 'W3N9',
        roomName: 'W2N9',
        nearestOwnedRoom: 'W3N9',
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
