const WORKER_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move'];
const WORKER_PATTERN_COST = 200;
const MAX_CREEP_PARTS = 50;

export function buildWorkerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }

  const maxPatternCountByEnergy = Math.floor(energyAvailable / WORKER_PATTERN_COST);
  const maxPatternCountBySize = Math.floor(MAX_CREEP_PARTS / WORKER_PATTERN.length);
  const patternCount = Math.min(maxPatternCountByEnergy, maxPatternCountBySize);

  return Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
}
