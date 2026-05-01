import { normalizeTerritoryIntents } from '../src/territory/territoryMemoryUtils';

describe('normalizeTerritoryIntents', () => {
  it('rejects intents with non-finite updatedAt values', () => {
    expect(
      normalizeTerritoryIntents([
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'reserve',
          status: 'planned',
          updatedAt: Number.NaN
        },
        {
          colony: 'W1N1',
          targetRoom: 'W3N1',
          action: 'claim',
          status: 'planned',
          updatedAt: Number.POSITIVE_INFINITY
        },
        {
          colony: 'W1N1',
          targetRoom: 'W4N1',
          action: 'scout',
          status: 'planned',
          updatedAt: 701
        }
      ])
    ).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W4N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 701
      }
    ]);
  });
});
