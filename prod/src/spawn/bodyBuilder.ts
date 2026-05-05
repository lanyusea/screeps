const WORKER_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move'];
const WORKER_PATTERN_COST = 200;
const WORKER_LOGISTICS_PAIR: BodyPartConstant[] = ['carry', 'move'];
const WORKER_LOGISTICS_PAIR_COST = 100;
const WORKER_WORK_MOVE_PAIR: BodyPartConstant[] = ['work', 'move'];
const WORKER_WORK_MOVE_PAIR_COST = 150;
const WORKER_SURPLUS_MOVE: BodyPartConstant[] = ['move'];
const WORKER_SURPLUS_MOVE_COST = 50;
const MID_RCL_WORKER_PATTERN: BodyPartConstant[] = ['work', 'work', 'carry', 'move', 'move'];
const MID_RCL_WORKER_PATTERN_COST = 350;
const HIGH_RCL_WORKER_PATTERN: BodyPartConstant[] = ['work', 'work', 'work', 'carry', 'move', 'move'];
const HIGH_RCL_WORKER_PATTERN_COST = 450;
const EMERGENCY_DEFENDER_BODY: BodyPartConstant[] = ['tough', 'attack', 'move'];
const EMERGENCY_DEFENDER_BODY_COST = 140;
export const TERRITORY_SCOUT_BODY: BodyPartConstant[] = ['move'];
export const TERRITORY_SCOUT_BODY_COST = 50;
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
const MAX_REMOTE_HARVESTER_WORK_PARTS = 5;
const MAX_REMOTE_HAULER_CARRY_MOVE_PAIRS = 10;
const MIN_REMOTE_HAULER_CARRY_MOVE_PAIRS = 6;
// General workers cover harvest, haul, build, and upgrade duties. Cap them at
// four 200-energy patterns (800 energy) so early rooms do not sink capacity into
// oversized unspecialized bodies before dedicated roles exist.
const MAX_WORKER_PATTERN_COUNT = 4;
const MIN_MID_RCL = 4;
const MIN_HIGH_RCL = 7;
const MAX_MID_RCL_WORKER_PATTERN_COUNT = 5;
const MAX_HIGH_RCL_WORKER_PATTERN_COUNT = 8;
const MID_RCL_WORKER_MAX_COST = 1800;
const HIGH_RCL_WORKER_MAX_COST = 3750;
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

interface WorkerBodyProfile {
  pattern: BodyPartConstant[];
  patternCost: number;
  maxCost: number;
  maxPatternCount: number;
}

const MID_RCL_WORKER_PROFILE: WorkerBodyProfile = {
  pattern: MID_RCL_WORKER_PATTERN,
  patternCost: MID_RCL_WORKER_PATTERN_COST,
  maxCost: MID_RCL_WORKER_MAX_COST,
  maxPatternCount: MAX_MID_RCL_WORKER_PATTERN_COUNT
};

const HIGH_RCL_WORKER_PROFILE: WorkerBodyProfile = {
  pattern: HIGH_RCL_WORKER_PATTERN,
  patternCost: HIGH_RCL_WORKER_PATTERN_COST,
  maxCost: HIGH_RCL_WORKER_MAX_COST,
  maxPatternCount: MAX_HIGH_RCL_WORKER_PATTERN_COUNT
};

export function buildWorkerBody(
  energyAvailable: number,
  controllerLevel?: number
): BodyPartConstant[] {
  if (isHighRcl(controllerLevel)) {
    return buildProfileWorkerBody(energyAvailable, HIGH_RCL_WORKER_PROFILE);
  }

  if (isMidRcl(controllerLevel)) {
    return buildProfileWorkerBody(energyAvailable, MID_RCL_WORKER_PROFILE);
  }

  return buildLowRclWorkerBody(energyAvailable);
}

function buildLowRclWorkerBody(energyAvailable: number): BodyPartConstant[] {
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

function buildProfileWorkerBody(
  energyAvailable: number,
  profile: WorkerBodyProfile
): BodyPartConstant[] {
  if (energyAvailable < profile.patternCost) {
    return buildLowRclWorkerBody(energyAvailable);
  }

  const energyBudget = Math.min(energyAvailable, profile.maxCost);
  const maxPatternCountByEnergy = Math.floor(energyBudget / profile.patternCost);
  const maxPatternCountBySize = Math.floor(MAX_CREEP_PARTS / profile.pattern.length);
  const patternCount = Math.min(
    maxPatternCountByEnergy,
    maxPatternCountBySize,
    profile.maxPatternCount
  );
  const body = Array.from({ length: patternCount }).flatMap(() => profile.pattern);

  return addProfileWorkerRemainderParts(body, energyBudget, patternCount * profile.patternCost);
}

function addProfileWorkerRemainderParts(
  body: BodyPartConstant[],
  energyBudget: number,
  bodyCost: number
): BodyPartConstant[] {
  const additions = [
    { parts: WORKER_WORK_MOVE_PAIR, cost: WORKER_WORK_MOVE_PAIR_COST },
    { parts: WORKER_LOGISTICS_PAIR, cost: WORKER_LOGISTICS_PAIR_COST },
    { parts: WORKER_SURPLUS_MOVE, cost: WORKER_SURPLUS_MOVE_COST }
  ];
  let nextBody = [...body];
  let nextCost = bodyCost;

  for (const addition of additions) {
    if (
      nextCost + addition.cost <= energyBudget &&
      nextBody.length + addition.parts.length <= MAX_CREEP_PARTS
    ) {
      nextBody = [...nextBody, ...addition.parts];
      nextCost += addition.cost;
    }
  }

  return nextBody;
}

function isMidRcl(controllerLevel: number | undefined): boolean {
  return typeof controllerLevel === 'number' && controllerLevel >= MIN_MID_RCL;
}

function isHighRcl(controllerLevel: number | undefined): boolean {
  return typeof controllerLevel === 'number' && controllerLevel >= MIN_HIGH_RCL;
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

export function buildRemoteHarvesterBody(energyAvailable: number): BodyPartConstant[] {
  const workParts = Math.min(
    MAX_REMOTE_HARVESTER_WORK_PARTS,
    Math.floor(
      (Math.max(0, energyAvailable) - getBodyPartCost('carry') - getBodyPartCost('move')) /
        getBodyPartCost('work')
    )
  );
  if (workParts <= 0) {
    return [];
  }

  return [...Array.from({ length: workParts }, () => 'work' as BodyPartConstant), 'carry', 'move'];
}

export function buildRemoteHaulerBody(energyAvailable: number, routeDistance = 1): BodyPartConstant[] {
  const pairCount = Math.min(
    getRemoteHaulerCarryMovePairLimit(routeDistance),
    Math.floor(Math.max(0, energyAvailable) / (getBodyPartCost('carry') + getBodyPartCost('move'))),
    Math.floor(MAX_CREEP_PARTS / 2)
  );
  if (pairCount <= 0) {
    return [];
  }

  return Array.from({ length: pairCount }).flatMap(() => ['carry', 'move'] as BodyPartConstant[]);
}

export function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((cost, part) => cost + BODY_PART_COSTS[part], 0);
}

function getRemoteHaulerCarryMovePairLimit(routeDistance: number): number {
  if (!Number.isFinite(routeDistance) || routeDistance <= 0) {
    return MIN_REMOTE_HAULER_CARRY_MOVE_PAIRS;
  }

  return Math.min(
    MAX_REMOTE_HAULER_CARRY_MOVE_PAIRS,
    Math.max(MIN_REMOTE_HAULER_CARRY_MOVE_PAIRS, Math.ceil(routeDistance) * 2)
  );
}

function getBodyPartCost(part: BodyPartConstant): number {
  return BODY_PART_COSTS[part];
}
