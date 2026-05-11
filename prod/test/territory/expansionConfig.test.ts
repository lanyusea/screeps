import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  it('keeps the E24S49 expansion scout target configuration complete', () => {
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual([
      {
        colony: 'E24S49',
        roomName: 'E26S50',
        nearestOwnedRoom: 'E24S49',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true
      },
      {
        colony: 'E24S49',
        roomName: 'E26S47',
        nearestOwnedRoom: 'E26S48',
        nearestOwnedRoomDistance: 1,
        routeDistance: 2,
        adjacentToOwnedRoom: true
      }
    ]);
  });
});
