import type { ColonySnapshot } from '../colony/colonyRegistry';
import { WORKER_REPLACEMENT_TICKS_TO_LIVE } from '../creeps/roleCounts';

const MAX_CONTROLLER_LEVEL = 8;

interface ColonyUpgradeCandidate {
  colony: ColonySnapshot;
  roomName: string;
  remainingProgress: number;
  progress: number;
  roleRank: number;
  workerCount: number;
}

export function selectColonyUpgradeTarget(colonies: ColonySnapshot[]): ColonySnapshot | null {
  const candidates = colonies.flatMap((colony) => {
    const candidate = buildColonyUpgradeCandidate(colony);
    return candidate && candidate.workerCount > 0 ? [candidate] : [];
  });

  return candidates.sort(compareColonyUpgradeCandidates)[0]?.colony ?? null;
}

function buildColonyUpgradeCandidate(colony: ColonySnapshot): ColonyUpgradeCandidate | null {
  const controller = colony.room.controller;
  if (!canUpgradeOwnedController(controller)) {
    return null;
  }

  return {
    colony,
    roomName: colony.room.name,
    remainingProgress: getControllerRemainingProgress(controller),
    progress: getControllerProgress(controller),
    roleRank: getColonyRoleRank(colony),
    workerCount: countAvailableWorkers(colony.room.name)
  };
}

function compareColonyUpgradeCandidates(
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
