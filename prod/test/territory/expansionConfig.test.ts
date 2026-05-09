import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  it('includes E26S47 as an E26S49 scout target adjacent to E26S48', () => {
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual(
      expect.arrayContaining([
        {
          colony: 'E26S49',
          roomName: 'E26S47',
          nearestOwnedRoom: 'E26S48',
          nearestOwnedRoomDistance: 1,
          routeDistance: 2,
          adjacentToOwnedRoom: true
        }
      ])
    );
  });
});
