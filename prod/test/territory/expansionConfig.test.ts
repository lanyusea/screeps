import { ACTIVE_OFFICIAL_ROOM, STATIC_EXPANSION_SCOUT_TARGETS } from '../../src/config/roomConfig';
import { TERRITORY_EXPANSION_SCOUT_TARGETS } from '../../src/territory/expansionConfig';

describe('territory expansion config', () => {
  it('exports the central static expansion scout targets', () => {
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS).toEqual(STATIC_EXPANSION_SCOUT_TARGETS);
    expect(TERRITORY_EXPANSION_SCOUT_TARGETS.filter((target) => target.colony === ACTIVE_OFFICIAL_ROOM)).toEqual(
      STATIC_EXPANSION_SCOUT_TARGETS.filter((target) => target.colony === ACTIVE_OFFICIAL_ROOM)
    );
  });
});
