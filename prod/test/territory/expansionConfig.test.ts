import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  it('keeps the W3N9 expansion scout targets scout-only and the legacy E17S59 config complete', () => {
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual([
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
      },
      {
        colony: 'E17S59',
        roomName: 'E18S59',
        nearestOwnedRoom: 'E17S59',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true
      },
      {
        colony: 'E17S59',
        roomName: 'E17S60',
        nearestOwnedRoom: 'E17S58',
        nearestOwnedRoomDistance: 1,
        routeDistance: 2,
        adjacentToOwnedRoom: true
      }
    ]);
  });
});
