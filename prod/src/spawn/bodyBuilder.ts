const WORKER_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move'];
const WORKER_PATTERN_COST = 200;
const WORKER_LOGISTICS_PAIR: BodyPartConstant[] = ['carry', 'move'];
const WORKER_LOGISTICS_PAIR_COST = 100;
const WORKER_SURPLUS_MOVE: BodyPartConstant[] = ['move'];
const WORKER_SURPLUS_MOVE_COST = 50;
const EMERGENCY_DEFENDER_BODY: BodyPartConstant[] = ['tough', 'attack', 'move'];
const EMERGENCY_DEFENDER_BODY_COST = 140;
import {
  buildTerritoryClaimerBody,
  TERRITORY_CONTROLLER_PRESSURE_BODY,
  TERRITORY_CONTROLLER_PRESSURE_BODY_COST
} from './bodyTemplates';
export {
  TERRITORY_CONTROLLER_BODY,
  TERRITORY_CONTROLLER_BODY_COST,
  TERRITORY_CONTROLLER_PRESSURE_BODY,
  TERRITORY_CONTROLLER_PRESSURE_BODY_COST,
  TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS
} from './bodyTemplates';
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
  const body = Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);

  if (shouldAddWorkerLogisticsPair(energyAvailable, patternCount, body.length)) {
    return [...body, ...WORKER_LOGISTICS_PAIR];
  }

  if (shouldAddWorkerSurplusMove(energyAvailable, patternCount, body.length)) {
    return [...body, ...WORKER_SURPLUS_MOVE];
  }

  return body;
}

function shouldAddWorkerLogisticsPair(
  energyAvailable: number,
  patternCount: number,
  bodyPartCount: number
): boolean {
  const remainingEnergy = energyAvailable - patternCount * WORKER_PATTERN_COST;

  return (
    patternCount >= 2 &&
    patternCount < MAX_WORKER_PATTERN_COUNT &&
    remainingEnergy >= WORKER_LOGISTICS_PAIR_COST &&
    bodyPartCount + WORKER_LOGISTICS_PAIR.length <= MAX_CREEP_PARTS
  );
}

function shouldAddWorkerSurplusMove(
  energyAvailable: number,
  patternCount: number,
  bodyPartCount: number
): boolean {
  const remainingEnergy = energyAvailable - patternCount * WORKER_PATTERN_COST;

  return (
    patternCount >= 2 &&
    patternCount < MAX_WORKER_PATTERN_COUNT &&
    remainingEnergy >= WORKER_SURPLUS_MOVE_COST &&
    bodyPartCount + WORKER_SURPLUS_MOVE.length <= MAX_CREEP_PARTS
  );
}

export function buildEmergencyWorkerBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }

  return [...WORKER_PATTERN];
}

export function buildEmergencyDefenderBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < EMERGENCY_DEFENDER_BODY_COST) {
    return [];
  }

  return [...EMERGENCY_DEFENDER_BODY];
}

export function buildTerritoryControllerBody(energyAvailable: number): BodyPartConstant[] {
  return buildTerritoryClaimerBody(energyAvailable);
}

export function buildTerritoryControllerPressureBody(energyAvailable: number): BodyPartConstant[] {
  if (energyAvailable < TERRITORY_CONTROLLER_PRESSURE_BODY_COST) {
    return [];
  }

  return [...TERRITORY_CONTROLLER_PRESSURE_BODY];
}

export function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((cost, part) => cost + BODY_PART_COSTS[part], 0);
}
