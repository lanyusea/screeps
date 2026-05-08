import { TERRITORY_CONTROLLER_BODY, TERRITORY_CONTROLLER_BODY_COST } from './creepBodies';
export { TERRITORY_CONTROLLER_BODY, TERRITORY_CONTROLLER_BODY_COST };
const MAX_CREEP_PARTS = 50;
const MAX_TERRITORY_CLAIMER_CLAIM_PARTS = 5;

export const TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS = 5;
export const TERRITORY_CONTROLLER_PRESSURE_BODY: BodyPartConstant[] = Array.from(
  { length: TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS },
  () => TERRITORY_CONTROLLER_BODY
).flat();
export const TERRITORY_CONTROLLER_PRESSURE_BODY_COST =
  TERRITORY_CONTROLLER_BODY_COST * TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS;

export function buildTerritoryClaimerBody(
  energyAvailable: number,
  routeDistance = 1
): BodyPartConstant[] {
  if (energyAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return [];
  }

  const maxClaimPartsByEnergy = Math.floor(energyAvailable / TERRITORY_CONTROLLER_BODY_COST);
  const maxClaimPartsBySize = Math.floor(MAX_CREEP_PARTS / TERRITORY_CONTROLLER_BODY.length);
  const claimParts = Math.min(
    getDesiredTerritoryClaimerClaimParts(routeDistance),
    maxClaimPartsByEnergy,
    maxClaimPartsBySize
  );

  if (claimParts <= 0) {
    return [];
  }

  return Array.from({ length: claimParts }).flatMap(() => TERRITORY_CONTROLLER_BODY);
}

function getDesiredTerritoryClaimerClaimParts(routeDistance: number): number {
  const normalizedDistance = normalizePositiveInteger(routeDistance, 1);
  if (normalizedDistance <= 1) {
    return 1;
  }

  return Math.min(
    MAX_TERRITORY_CLAIMER_CLAIM_PARTS,
    1 + Math.ceil(normalizedDistance / 10)
  );
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
