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
    expect(getCurrentRoomScoutOnlyAdjacentRoomNames('W3N9')).toEqual(['W3N8', 'W2N9']);
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

    expect(getRuntimeCurrentRoomScoutOnlyTargets('W8N3')).toEqual([
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
        roomName: 'W7N3',
        nearestOwnedRoom: 'W8N3',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true,
        scoutOnly: true
      }
    ]);
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
            roomName: 'W4N9',
            nearestOwnedRoom: 'W3N9',
            nearestOwnedRoomDistance: 1,
            routeDistance: 1,
            adjacentToOwnedRoom: true
          }
        ]
      }
    };

    expect(getTerritoryExpansionScoutTargets('W3N9')).toEqual([
      {
        colony: 'W3N9',
        roomName: 'W4N9',
        nearestOwnedRoom: 'W3N9',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true
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
