import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  buildDefenseTelemetryContext,
  compareObjectIds,
  findMyCreeps,
  getEnergyResource,
  getObjectId,
  getOwnedTowers,
  isDamagedStructure,
  recordDefenseAction,
  type DefenseTelemetryContext
} from './defenseTelemetry';

export interface TowerRunResult {
  events: RuntimeTelemetryEvent[];
  attackSucceeded: boolean;
  attackingTowerIds: Set<string>;
  actedTowerIds: Set<string>;
}

export const TOWER_RECOVERY_ENERGY_RESERVE = 250;

const OK_CODE = 0 as ScreepsReturnCode;

export function runTowers(room: Room): RuntimeTelemetryEvent[] {
  return runTowersWithResult(room).events;
}

export function runTowersWithResult(room: Room): TowerRunResult {
  const context = buildDefenseTelemetryContext(room);
  const events: RuntimeTelemetryEvent[] = [];
  const result: TowerRunResult = {
    events,
    attackSucceeded: false,
    attackingTowerIds: new Set<string>(),
    actedTowerIds: new Set<string>()
  };

  for (const tower of getUsableTowers(room)) {
    if (runTowerHeal(tower, context, result)) {
      continue;
    }

    if (hasHostileTarget(context) && runTowerAttack(tower, context, result)) {
      continue;
    }

    runTowerRepair(tower, context, result);
  }

  return result;
}

function runTowerHeal(
  tower: StructureTower,
  context: DefenseTelemetryContext,
  result: TowerRunResult
): boolean {
  if (!canSpendTowerEnergyOnRecovery(tower) || typeof tower.heal !== 'function') {
    return false;
  }

  const target = selectClosestTarget(tower, findMyCreeps(context.room).filter(isWoundedCreep));
  if (!target) {
    return false;
  }

  const healResult = tower.heal(target);
  recordDefenseAction(
    {
      action: 'towerHeal',
      context,
      reason: 'criticalStructureDamaged',
      result: healResult,
      structureId: getObjectId(tower),
      targetId: getObjectId(target)
    },
    result.events
  );
  result.actedTowerIds.add(getObjectId(tower));
  return healResult === OK_CODE;
}

function runTowerAttack(
  tower: StructureTower,
  context: DefenseTelemetryContext,
  result: TowerRunResult
): boolean {
  if (typeof tower.attack !== 'function') {
    return false;
  }

  const target =
    selectClosestTarget(tower, context.hostileCreeps) ??
    selectClosestTarget(tower, context.hostileStructures);
  if (!target) {
    return false;
  }

  const attackResult = tower.attack(target);
  recordDefenseAction(
    {
      action: 'towerAttack',
      context,
      reason: 'hostileVisible',
      result: attackResult,
      structureId: getObjectId(tower),
      targetId: getObjectId(target)
    },
    result.events
  );
  result.actedTowerIds.add(getObjectId(tower));

  if (attackResult !== OK_CODE) {
    return false;
  }

  result.attackSucceeded = true;
  result.attackingTowerIds.add(getObjectId(tower));
  return true;
}

function runTowerRepair(
  tower: StructureTower,
  context: DefenseTelemetryContext,
  result: TowerRunResult
): boolean {
  if (!canSpendTowerEnergyOnRecovery(tower) || typeof tower.repair !== 'function') {
    return false;
  }

  const target = selectClosestTarget(tower, context.damagedCriticalStructures.filter(isDamagedStructure));
  if (!target) {
    return false;
  }

  const repairResult = tower.repair(target);
  recordDefenseAction(
    {
      action: 'towerRepair',
      context,
      reason: 'criticalStructureDamaged',
      result: repairResult,
      structureId: getObjectId(tower),
      targetId: getObjectId(target)
    },
    result.events
  );
  result.actedTowerIds.add(getObjectId(tower));
  return repairResult === OK_CODE;
}

function hasHostileTarget(context: DefenseTelemetryContext): boolean {
  return context.hostileCreeps.length > 0 || context.hostileStructures.length > 0;
}

function getUsableTowers(room: Room): StructureTower[] {
  return getOwnedTowers(room).filter(hasStoredEnergy).sort(compareObjectIds);
}

function hasStoredEnergy(structure: {
  store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null };
}): boolean {
  const usedCapacity = getStoredTowerEnergy(structure);
  return usedCapacity === null || usedCapacity > 0;
}

function canSpendTowerEnergyOnRecovery(structure: {
  store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null };
}): boolean {
  const usedCapacity = getStoredTowerEnergy(structure);
  return usedCapacity === null || usedCapacity >= TOWER_RECOVERY_ENERGY_RESERVE;
}

function getStoredTowerEnergy(structure: {
  store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null };
}): number | null {
  const store = structure.store;
  if (!store || typeof store.getUsedCapacity !== 'function') {
    return null;
  }

  const usedCapacity = store.getUsedCapacity(getEnergyResource());
  return typeof usedCapacity === 'number' ? usedCapacity : null;
}

function selectClosestTarget<T extends { pos?: RoomPosition }>(
  origin: { pos?: RoomPosition },
  targets: T[]
): T | null {
  const targetsInRange = targets.filter((target) => isTargetInTowerRoom(origin, target));
  if (targetsInRange.length === 0) {
    return null;
  }

  return [...targetsInRange].sort(
    (left, right) => compareRange(origin, left, right) || compareObjectIds(left, right)
  )[0];
}

function isTargetInTowerRoom(
  origin: { pos?: RoomPosition },
  target: { pos?: RoomPosition }
): boolean {
  if (!origin.pos || !target.pos) {
    return true;
  }

  return origin.pos.roomName === target.pos.roomName;
}

function compareRange(
  origin: { pos?: RoomPosition },
  left: { pos?: RoomPosition },
  right: { pos?: RoomPosition }
): number {
  const getRangeTo = origin.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return 0;
  }

  const leftRange = left.pos ? getRangeTo.call(origin.pos, left.pos) : Infinity;
  const rightRange = right.pos ? getRangeTo.call(origin.pos, right.pos) : Infinity;
  return leftRange - rightRange;
}

function isWoundedCreep(creep: Creep): boolean {
  return typeof creep.hits === 'number' && typeof creep.hitsMax === 'number' && creep.hits < creep.hitsMax;
}
