const WORKER_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move'];
const WORKER_PATTERN_COST = 200;
const TERRITORY_CONTROLLER_BODY: BodyPartConstant[] = ['claim', 'move'];
export const TERRITORY_CONTROLLER_BODY_COST = 650;
const MAX_CREEP_PARTS = 50;
// General workers cover harvest, haul, build, and upgrade duties. Cap them at
// four 200-energy patterns (800 energy) so early rooms do not sink capacity into
// oversized unspecialized bodies before dedicated roles exist.
const MAX_WORKER_PATTERN_COUNT = 4;
const BODY_PART_COSTS: Record<BodyPartConstant, number> = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10
};

export function buildWorkerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }

  const maxPatternCountByEnergy = Math.floor(energyAvailable / WORKER_PATTERN_COST);
  const maxPatternCountBySize = Math.floor(MAX_CREEP_PARTS / WORKER_PATTERN.length);
  const patternCount = Math.min(maxPatternCountByEnergy, maxPatternCountBySize, MAX_WORKER_PATTERN_COUNT);

  return Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
}

export function buildEmergencyWorkerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }

  return [...WORKER_PATTERN];
}

export function buildTerritoryControllerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return [];
  }

  return [...TERRITORY_CONTROLLER_BODY];
}

export function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((cost, part) => cost + BODY_PART_COSTS[part], 0);
}
