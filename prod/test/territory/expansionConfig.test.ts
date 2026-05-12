import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  it('keeps the E17S59 expansion scout target configuration complete', () => {
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual([
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
