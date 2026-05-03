import { TERRITORY_CONTROLLER_BODY, TERRITORY_CONTROLLER_BODY_COST } from './creepBodies';
export { TERRITORY_CONTROLLER_BODY, TERRITORY_CONTROLLER_BODY_COST };
const TERRITORY_CLAIMER_UPGRADE_PARTS: BodyPartConstant[] = ['work', 'carry', 'move'];
const TERRITORY_CLAIMER_UPGRADE_PART_COST = 250;
const MAX_CREEP_PARTS = 50;

export const TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS = 5;
export const TERRITORY_CONTROLLER_PRESSURE_BODY: BodyPartConstant[] = Array.from(
  { length: TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS },
  () => TERRITORY_CONTROLLER_BODY
).flat();
export const TERRITORY_CONTROLLER_PRESSURE_BODY_COST =
  TERRITORY_CONTROLLER_BODY_COST * TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS;

export function buildTerritoryClaimerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return [];
  }

  const upgradeEnergy = energyAvailable - TERRITORY_CONTROLLER_BODY_COST;
  const maxUpgradePairsByEnergy = Math.floor(upgradeEnergy / TERRITORY_CLAIMER_UPGRADE_PART_COST);
  const maxUpgradePairsByCapacity = Math.floor(
    (MAX_CREEP_PARTS - TERRITORY_CONTROLLER_BODY.length) / TERRITORY_CLAIMER_UPGRADE_PARTS.length
  );
  const upgradePairs = Math.min(maxUpgradePairsByEnergy, maxUpgradePairsByCapacity);

  if (upgradePairs <= 0) {
    return [...TERRITORY_CONTROLLER_BODY];
  }

  return [
    ...TERRITORY_CONTROLLER_BODY,
    ...Array.from({ length: upgradePairs }).flatMap(() => TERRITORY_CLAIMER_UPGRADE_PARTS)
  ];
}
