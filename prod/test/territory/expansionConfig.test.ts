import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  it('keeps the E26S49 expansion scout target configuration complete', () => {
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual([
      {
        colony: 'E26S49',
        roomName: 'E26S50',
        nearestOwnedRoom: 'E26S49',
        nearestOwnedRoomDistance: 1,
        routeDistance: 1,
        adjacentToOwnedRoom: true
      },
      {
        colony: 'E26S49',
        roomName: 'E26S47',
        nearestOwnedRoom: 'E26S48',
        nearestOwnedRoomDistance: 1,
        routeDistance: 2,
        adjacentToOwnedRoom: true
      }
    ]);
  });
});
