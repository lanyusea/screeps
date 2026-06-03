import { TERRITORY_CONTROLLER_BODY_COST } from '../src/spawn/bodyTemplates';
import {
  TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY,
  getTerritoryAutoClaimPostClaimBootstrapReserveEnergy,
  getTerritoryAutoClaimRequiredEnergy,
  isTerritoryAutoClaimAllowedForController
} from '../src/territory/autoClaim';

describe('territory auto-claim readiness helpers', () => {
  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('caps RCL3 claim readiness at 800 energy while preserving the full default package', () => {
    expect(TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY).toBe(1_050);
    expect(getTerritoryAutoClaimRequiredEnergy(3)).toBe(800);
    expect(getTerritoryAutoClaimRequiredEnergy(5)).toBe(1_050);
    expect(getTerritoryAutoClaimRequiredEnergy(undefined)).toBe(1_050);
    expect(getTerritoryAutoClaimRequiredEnergy(Number.NaN)).toBe(1_050);

    expect(getTerritoryAutoClaimPostClaimBootstrapReserveEnergy(3)).toBe(800 - TERRITORY_CONTROLLER_BODY_COST);
    expect(getTerritoryAutoClaimPostClaimBootstrapReserveEnergy(5)).toBe(
      TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY - TERRITORY_CONTROLLER_BODY_COST
    );
    expect(getTerritoryAutoClaimPostClaimBootstrapReserveEnergy(undefined)).toBe(
      TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY - TERRITORY_CONTROLLER_BODY_COST
    );
  });

  it('keeps persistent RCL3 claim control gated while allowing Seasonal RCL3 controllers', () => {
    expect(isTerritoryAutoClaimAllowedForController({ my: true, level: 3 })).toBe(false);

    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      shard: { name: 'shardSeason', type: 'normal' } as Game['shard']
    };

    expect(isTerritoryAutoClaimAllowedForController({ my: true, level: 3 })).toBe(true);
    expect(isTerritoryAutoClaimAllowedForController({ my: true, level: 2 })).toBe(false);
  });
});
