import { signOccupiedControllerIfNeeded } from '../territory/controllerSigning';

export type ControllerUpgradePriority =
  | 'none'
  | 'downgradeGuard'
  | 'rcl1Rush'
  | 'rclProgress'
  | 'energySurplus'
  | 'fallback';

export interface ControllerUpgradePriorityContext {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  competingSpawnDemand?: boolean;
  hasEnergySurplus?: boolean;
}

export const CONTROLLER_UPGRADE_PROGRESS_PRESSURE_RATIO = 0.85;
export const CONTROLLER_UPGRADE_DOWNGRADE_GUARD_TICKS = 5_000;

const MAX_CONTROLLER_LEVEL = 8;

export function runUpgrader(creep: Creep, controller: StructureController): ScreepsReturnCode {
  signOccupiedControllerIfNeeded(creep, controller);
  return creep.upgradeController(controller);
}

export function getControllerUpgradePriority(
  controller: StructureController | undefined,
  context: ControllerUpgradePriorityContext = {}
): ControllerUpgradePriority {
  if (controller?.my !== true) {
    return 'none';
  }

  if (shouldGuardControllerDowngrade(controller)) {
    return 'downgradeGuard';
  }

  if (!canLevelUpController(controller)) {
    return 'fallback';
  }

  if (controller.level === 1) {
    return 'rcl1Rush';
  }

  if (
    isControllerProgressPressure(controller) &&
    hasFullRoomSpawnEnergy(context) &&
    context.competingSpawnDemand !== true
  ) {
    return 'rclProgress';
  }

  if (context.hasEnergySurplus === true && context.competingSpawnDemand !== true) {
    return 'energySurplus';
  }

  return 'fallback';
}

export function isControllerProgressPressure(controller: StructureController | undefined): boolean {
  if (!canLevelUpController(controller)) {
    return false;
  }

  const progress = controller.progress;
  const progressTotal = controller.progressTotal;
  return (
    typeof progress === 'number' &&
    Number.isFinite(progress) &&
    typeof progressTotal === 'number' &&
    Number.isFinite(progressTotal) &&
    progressTotal > 0 &&
    Math.max(0, progress) / progressTotal >= CONTROLLER_UPGRADE_PROGRESS_PRESSURE_RATIO
  );
}

export function canLevelUpController(controller: StructureController | undefined): controller is StructureController {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level < MAX_CONTROLLER_LEVEL
  );
}

function shouldGuardControllerDowngrade(controller: StructureController): boolean {
  return (
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade <= CONTROLLER_UPGRADE_DOWNGRADE_GUARD_TICKS
  );
}

function hasFullRoomSpawnEnergy(context: ControllerUpgradePriorityContext): boolean {
  const energyAvailable = context.energyAvailable;
  const energyCapacityAvailable = context.energyCapacityAvailable;
  return (
    typeof energyAvailable === 'number' &&
    Number.isFinite(energyAvailable) &&
    typeof energyCapacityAvailable === 'number' &&
    Number.isFinite(energyCapacityAvailable) &&
    energyCapacityAvailable > 0 &&
    energyAvailable >= energyCapacityAvailable
  );
}
