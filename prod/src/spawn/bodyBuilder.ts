const WORKER_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move'];
const WORKER_PATTERN_COST = 200;
const MAX_CREEP_PARTS = 50;
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
  const patternCount = Math.min(maxPatternCountByEnergy, maxPatternCountBySize);

  return Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
}

export function buildEmergencyWorkerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }

  return [...WORKER_PATTERN];
}

export function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((cost, part) => cost + BODY_PART_COSTS[part], 0);
}
