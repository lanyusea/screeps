import type { ColonySnapshot } from '../colony/colonyRegistry';
import { WORKER_REPLACEMENT_TICKS_TO_LIVE } from '../creeps/roleCounts';

const MAX_CONTROLLER_LEVEL = 8;
export const COLONY_UPGRADE_DOWNGRADE_RISK_TICKS = 5_000;

interface ColonyUpgradeCandidate {
  colony: ColonySnapshot;
  controllerTicksToDowngrade?: number;
  roomName: string;
  remainingProgress: number;
  progress: number;
  roleRank: number;
  workerCount: number;
}

export function selectColonyUpgradeTarget(colonies: ColonySnapshot[]): ColonySnapshot | null {
  return selectColonyUpgradeTargets(colonies)[0] ?? null;
}

export function selectColonyUpgradeTargets(colonies: ColonySnapshot[]): ColonySnapshot[] {
  const candidates = colonies.flatMap((colony) => {
    const candidate = buildColonyUpgradeCandidate(colony);
    return candidate && candidate.workerCount > 0 ? [candidate] : [];
  });
  if (candidates.length === 0) {
    return [];
  }

  const levelUpTarget = [...candidates].sort(compareColonyLevelUpgradeCandidates)[0];
  const downgradeRiskTargets = candidates
    .filter(isControllerDowngradeRiskCandidate)
    .sort(compareColonyDowngradeRiskCandidates);

  return uniqueColonyUpgradeCandidates([
    ...downgradeRiskTargets,
    ...(levelUpTarget ? [levelUpTarget] : [])
  ]).map((candidate) => candidate.colony);
}

function buildColonyUpgradeCandidate(colony: ColonySnapshot): ColonyUpgradeCandidate | null {
  const controller = colony.room.controller;
  if (!canUpgradeOwnedController(controller)) {
    return null;
  }

  return {
    colony,
    ...getControllerTicksToDowngradeField(controller),
    roomName: colony.room.name,
    remainingProgress: getControllerRemainingProgress(controller),
    progress: getControllerProgress(controller),
    roleRank: getColonyRoleRank(colony),
    workerCount: countAvailableWorkers(colony.room.name)
  };
}

function compareColonyDowngradeRiskCandidates(
  left: ColonyUpgradeCandidate,
  right: ColonyUpgradeCandidate
): number {
  return (
    compareOptionalNumbers(left.controllerTicksToDowngrade, right.controllerTicksToDowngrade) ||
    compareColonyLevelUpgradeCandidates(left, right)
  );
}

function compareColonyLevelUpgradeCandidates(
  left: ColonyUpgradeCandidate,
  right: ColonyUpgradeCandidate
): number {
  return (
    left.remainingProgress - right.remainingProgress ||
    right.progress - left.progress ||
    left.roleRank - right.roleRank ||
    right.workerCount - left.workerCount ||
    left.roomName.localeCompare(right.roomName)
  );
}

function uniqueColonyUpgradeCandidates(
  candidates: ColonyUpgradeCandidate[]
): ColonyUpgradeCandidate[] {
  const seenRooms = new Set<string>();
  const uniqueCandidates: ColonyUpgradeCandidate[] = [];

  for (const candidate of candidates) {
    if (seenRooms.has(candidate.roomName)) {
      continue;
    }

    seenRooms.add(candidate.roomName);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates;
}

function isControllerDowngradeRiskCandidate(candidate: ColonyUpgradeCandidate): boolean {
  return (
    typeof candidate.controllerTicksToDowngrade === 'number' &&
    candidate.controllerTicksToDowngrade <= COLONY_UPGRADE_DOWNGRADE_RISK_TICKS
  );
}

function canUpgradeOwnedController(
  controller: StructureController | undefined
): controller is StructureController {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level < MAX_CONTROLLER_LEVEL
  );
}

function getControllerRemainingProgress(controller: StructureController): number {
  const progressTotal = getControllerProgressTotal(controller);
  if (progressTotal <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, progressTotal - getControllerProgress(controller));
}

function getControllerProgress(controller: StructureController): number {
  return normalizeNonNegativeNumber(controller.progress);
}

function getControllerProgressTotal(controller: StructureController): number {
  return normalizeNonNegativeNumber(controller.progressTotal);
}

function getControllerTicksToDowngradeField(
  controller: StructureController
): Pick<ColonyUpgradeCandidate, 'controllerTicksToDowngrade'> {
  return typeof controller.ticksToDowngrade === 'number' && Number.isFinite(controller.ticksToDowngrade)
    ? { controllerTicksToDowngrade: Math.max(0, Math.floor(controller.ticksToDowngrade)) }
    : {};
}

function getColonyRoleRank(colony: ColonySnapshot): number {
  return hasOperationalSpawn(colony) ? 1 : 0;
}

function hasOperationalSpawn(colony: ColonySnapshot): boolean {
  return colony.spawns.some((spawn) => {
    if (!spawn) {
      return false;
    }

    if (typeof spawn.isActive === 'function') {
      return spawn.isActive();
    }

    return true;
  });
}

function countAvailableWorkers(roomName: string): number {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).filter((creep) => isAvailableWorkerForRoom(creep, roomName)).length;
}

function isAvailableWorkerForRoom(creep: Creep, roomName: string): boolean {
  if (
    creep.ticksToLive !== undefined &&
    creep.ticksToLive <= WORKER_REPLACEMENT_TICKS_TO_LIVE
  ) {
    return false;
  }

  if (creep.memory?.role !== 'worker') {
    return false;
  }

  return creep.memory.colony === roomName || creep.memory.controllerSustain?.targetRoom === roomName;
}

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}
