import { TERRITORY_EXPANSION_ROOM_SELECTION } from '../../src/config/roomSelection';
import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  it('loads static scout targets from the centralized room-selection config', () => {
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual(TERRITORY_EXPANSION_ROOM_SELECTION.scoutTargets);
  });
});
