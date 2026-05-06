import type { ColonySnapshot } from '../colony/colonyRegistry';
import { getWorkerCapacity, WORKER_REPLACEMENT_TICKS_TO_LIVE, type RoleCounts } from '../creeps/roleCounts';
import {
  getControllerUpgradePriority,
  isControllerProgressPressure,
  type ControllerUpgradePriority
} from '../creeps/upgraderRunner';
import { shouldSignOccupiedController } from './controllerSigning';

export interface ControllerManagementOptions {
  competingSpawnDemand?: boolean;
  activeUpgraderCount?: number;
}

export interface ControllerUpgradeSpawnDemand {
  roomName: string;
  controllerId: Id<StructureController>;
  priority: ControllerUpgradePriority;
  desiredUpgraderCount: number;
  activeUpgraderCount: number;
}

export interface ControllerManagementPlan {
  roomName: string;
  updatedAt: number;
  controllerId?: Id<StructureController>;
  signNeeded: boolean;
  upgradePriority: ControllerUpgradePriority;
  desiredUpgraderCount: number;
  activeUpgraderCount: number;
  progressRatio?: number;
  ticksToDowngrade?: number;
  spawnDemand?: ControllerUpgradeSpawnDemand;
}

const CONTROLLER_PROGRESS_DEMAND_UPGRADERS = 1;
const CONTROLLER_PROGRESS_DEMAND_MIN_ENERGY_CAPACITY = 550;

export function refreshControllerManagement(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number,
  options: ControllerManagementOptions = {}
): ControllerManagementPlan {
  const plan = buildControllerManagementPlan(colony, roleCounts, workerTarget, gameTime, options);
  persistControllerManagementPlan(plan);
  return plan;
}

export function selectControllerUpgradeSpawnDemand(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number,
  options: ControllerManagementOptions = {}
): ControllerUpgradeSpawnDemand | null {
  return buildControllerManagementPlan(colony, roleCounts, workerTarget, gameTime, options).spawnDemand ?? null;
}

export function buildControllerUpgradeCreepMemory(
  demand: ControllerUpgradeSpawnDemand,
  gameTime: number
): CreepMemory {
  return {
    role: 'worker',
    colony: demand.roomName,
    controllerUpgrade: {
      roomName: demand.roomName,
      controllerId: demand.controllerId,
      priority: demand.priority,
      assignedAt: gameTime
    }
  };
}

export function buildControllerManagementPlan(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number,
  options: ControllerManagementOptions = {}
): ControllerManagementPlan {
  const roomName = colony.room.name;
  const controller = colony.room.controller;
  if (controller?.my !== true || !isNonEmptyString(controller.id)) {
    return {
      roomName,
      updatedAt: gameTime,
      signNeeded: false,
      upgradePriority: 'none',
      desiredUpgraderCount: 0,
      activeUpgraderCount: 0
    };
  }

  const controllerId = controller.id;
  const activeUpgraderCount =
    options.activeUpgraderCount ?? countActiveControllerUpgraders(roomName, controllerId);
  const upgradePriority = getControllerUpgradePriority(controller, {
    energyAvailable: colony.energyAvailable,
    energyCapacityAvailable: colony.energyCapacityAvailable,
    competingSpawnDemand: options.competingSpawnDemand
  });
  const desiredUpgraderCount = getDesiredControllerUpgraderCount(upgradePriority);
  const plan: ControllerManagementPlan = {
    roomName,
    updatedAt: gameTime,
    controllerId,
    signNeeded: shouldSignOccupiedController(controller),
    upgradePriority,
    desiredUpgraderCount,
    activeUpgraderCount,
    ...getControllerProgressRatioField(controller),
    ...getControllerTicksToDowngradeField(controller)
  };

  if (
    shouldCreateControllerUpgradeSpawnDemand(
      colony,
      roleCounts,
      workerTarget,
      upgradePriority,
      desiredUpgraderCount,
      activeUpgraderCount,
      options
    )
  ) {
    plan.spawnDemand = {
      roomName,
      controllerId,
      priority: upgradePriority,
      desiredUpgraderCount,
      activeUpgraderCount
    };
  }

  return plan;
}

function shouldCreateControllerUpgradeSpawnDemand(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  upgradePriority: ControllerUpgradePriority,
  desiredUpgraderCount: number,
  activeUpgraderCount: number,
  options: ControllerManagementOptions
): boolean {
  return (
    upgradePriority === 'rclProgress' &&
    desiredUpgraderCount > activeUpgraderCount &&
    options.competingSpawnDemand !== true &&
    getWorkerCapacity(roleCounts) >= workerTarget &&
    colony.energyCapacityAvailable >= CONTROLLER_PROGRESS_DEMAND_MIN_ENERGY_CAPACITY &&
    colony.energyAvailable >= colony.energyCapacityAvailable
  );
}

function getDesiredControllerUpgraderCount(priority: ControllerUpgradePriority): number {
  return priority === 'rclProgress' ? CONTROLLER_PROGRESS_DEMAND_UPGRADERS : 0;
}

function countActiveControllerUpgraders(
  roomName: string,
  controllerId: Id<StructureController>
): number {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).filter((creep) =>
    canSatisfyControllerUpgradeDemand(creep, roomName, controllerId)
  ).length;
}

function canSatisfyControllerUpgradeDemand(
  creep: Creep,
  roomName: string,
  controllerId: Id<StructureController>
): boolean {
  if (creep.ticksToLive !== undefined && creep.ticksToLive <= WORKER_REPLACEMENT_TICKS_TO_LIVE) {
    return false;
  }

  const upgradeMemory = creep.memory.controllerUpgrade;
  if (
    creep.memory.role === 'worker' &&
    upgradeMemory?.roomName === roomName &&
    upgradeMemory.controllerId === controllerId
  ) {
    return true;
  }

  const task = creep.memory.task;
  return (
    creep.memory.role === 'worker' &&
    creep.memory.colony === roomName &&
    creep.room?.name === roomName &&
    task?.type === 'upgrade' &&
    task.targetId === controllerId
  );
}

function persistControllerManagementPlan(plan: ControllerManagementPlan): void {
  const memory = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return;
  }

  const territory = memory.territory ?? {};
  memory.territory = territory;
  const controllers = territory.controllers ?? {};
  territory.controllers = controllers;

  if (!plan.controllerId) {
    delete controllers[plan.roomName];
    return;
  }

  controllers[plan.roomName] = {
    roomName: plan.roomName,
    controllerId: plan.controllerId,
    signNeeded: plan.signNeeded,
    upgradePriority: plan.upgradePriority,
    desiredUpgraderCount: plan.desiredUpgraderCount,
    activeUpgraderCount: plan.activeUpgraderCount,
    updatedAt: plan.updatedAt,
    ...(typeof plan.progressRatio === 'number' ? { progressRatio: plan.progressRatio } : {}),
    ...(typeof plan.ticksToDowngrade === 'number' ? { ticksToDowngrade: plan.ticksToDowngrade } : {}),
    ...(plan.spawnDemand
      ? {
          spawnDemand: {
            controllerId: plan.spawnDemand.controllerId,
            priority: plan.spawnDemand.priority,
            desiredUpgraderCount: plan.spawnDemand.desiredUpgraderCount,
            activeUpgraderCount: plan.spawnDemand.activeUpgraderCount
          }
        }
      : {})
  };
}

function getControllerProgressRatioField(
  controller: StructureController
): Pick<ControllerManagementPlan, 'progressRatio'> {
  if (!isControllerProgressPressure(controller)) {
    return {};
  }

  const progress = controller.progress;
  const progressTotal = controller.progressTotal;
  return typeof progress === 'number' &&
    typeof progressTotal === 'number' &&
    Number.isFinite(progress) &&
    Number.isFinite(progressTotal) &&
    progressTotal > 0
    ? { progressRatio: Math.max(0, progress) / progressTotal }
    : {};
}

function getControllerTicksToDowngradeField(
  controller: StructureController
): Pick<ControllerManagementPlan, 'ticksToDowngrade'> {
  return typeof controller.ticksToDowngrade === 'number' &&
    Number.isFinite(controller.ticksToDowngrade)
    ? { ticksToDowngrade: controller.ticksToDowngrade }
    : {};
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
