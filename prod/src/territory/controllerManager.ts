import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  getUpgraderCapacity,
  getWorkerCapacity,
  type RoleCounts
} from '../creeps/roleCounts';
import {
  getControllerUpgradePriority,
  isControllerProgressPressure,
  UPGRADER_ROLE,
  type ControllerUpgradePriority
} from '../creeps/upgraderRunner';
import { getBufferedSpawnEnergyBudget } from '../economy/spawnEnergyBuffer';
import { MIN_UPGRADER_BODY_COST } from '../spawn/bodyBuilder';
import { shouldSignOccupiedController } from './controllerSigning';

export interface ControllerManagementOptions {
  competingSpawnDemand?: boolean;
  constructionDemand?: boolean;
  defenseDemand?: boolean;
  desiredControllerLevel?: number;
  energyBufferHealthy?: boolean;
  hasEnergySurplus?: boolean;
  activeUpgraderCount?: number;
  allowReservedSpawnEnergy?: boolean;
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
  controllerLevel?: number;
  desiredControllerLevel?: number;
  signNeeded: boolean;
  upgradePriority: ControllerUpgradePriority;
  desiredUpgraderCount: number;
  activeUpgraderCount: number;
  progress?: number;
  progressTotal?: number;
  progressRemaining?: number;
  progressRatio?: number;
  ticksToDowngrade?: number;
  spawnDemand?: ControllerUpgradeSpawnDemand;
}

const CONTROLLER_UPGRADE_MIN_ENERGY_CAPACITY = MIN_UPGRADER_BODY_COST;
const MAX_CONTROLLER_LEVEL = 8;

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
    role: UPGRADER_ROLE,
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
  const controllerLevel = getControllerLevel(controller);
  const desiredControllerLevel = normalizeDesiredControllerLevel(options.desiredControllerLevel);
  const activeUpgraderCount =
    options.activeUpgraderCount ??
    Math.max(getUpgraderCapacity(roleCounts), countActiveControllerUpgraders(roomName, controllerId));
  const competingSpawnDemand = options.competingSpawnDemand ?? getWorkerCapacity(roleCounts) < workerTarget;
  const constructionDemand = options.constructionDemand ?? hasVisibleConstructionDemand(colony.room);
  const energyBufferHealthy = options.energyBufferHealthy ?? hasControllerUpgradeSpawnEnergy(colony);
  const upgradePriority = getControllerUpgradePriority(controller, {
    energyAvailable:
      options.allowReservedSpawnEnergy === true ? colony.energyCapacityAvailable : colony.energyAvailable,
    energyCapacityAvailable: colony.energyCapacityAvailable,
    competingSpawnDemand,
    constructionDemand,
    defenseDemand: options.defenseDemand,
    energyBufferHealthy,
    hasEnergySurplus: options.hasEnergySurplus ?? hasRecordedEnergySurplus(roomName)
  });
  const desiredUpgraderCount = getDesiredControllerUpgraderCount(
    upgradePriority,
    colony,
    desiredControllerLevel
  );
  const plan: ControllerManagementPlan = {
    roomName,
    updatedAt: gameTime,
    controllerId,
    controllerLevel,
    desiredControllerLevel,
    signNeeded: shouldSignOccupiedController(controller, gameTime),
    upgradePriority,
    desiredUpgraderCount,
    activeUpgraderCount,
    ...getControllerProgressFields(controller),
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
    isControllerUpgradeSpawnPriority(upgradePriority) &&
    desiredUpgraderCount > activeUpgraderCount &&
    options.competingSpawnDemand !== true &&
    getWorkerCapacity(roleCounts) >= workerTarget &&
    hasControllerUpgradeSpawnEnergy(colony)
  );
}

function hasControllerUpgradeSpawnEnergy(colony: ColonySnapshot): boolean {
  if (colony.energyCapacityAvailable < CONTROLLER_UPGRADE_MIN_ENERGY_CAPACITY) {
    return false;
  }

  return normalizeNonNegativeInteger(colony.energyAvailable) >= MIN_UPGRADER_BODY_COST ||
    getBufferedSpawnEnergyBudget(colony.room, colony.spawns, colony.energyAvailable) >= MIN_UPGRADER_BODY_COST;
}

function isControllerUpgradeSpawnPriority(priority: ControllerUpgradePriority): boolean {
  return (
    priority === 'rcl1Rush' ||
    priority === 'rclProgress' ||
    priority === 'energySurplus' ||
    priority === 'steady'
  );
}

function getDesiredControllerUpgraderCount(
  priority: ControllerUpgradePriority,
  colony: ColonySnapshot,
  desiredControllerLevel: number
): number {
  if (!canMaintainDedicatedControllerUpgrader(colony.room.controller, desiredControllerLevel)) {
    return 0;
  }

  switch (priority) {
    case 'rcl1Rush':
    case 'rclProgress':
    case 'energySurplus':
    case 'steady':
      return 1;
    case 'downgradeGuard':
    case 'fallback':
    case 'none':
      return 0;
  }
}

function canMaintainDedicatedControllerUpgrader(
  controller: StructureController | undefined,
  desiredControllerLevel: number
): boolean {
  return controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level < Math.min(MAX_CONTROLLER_LEVEL, desiredControllerLevel);
}

function countActiveControllerUpgraders(
  roomName: string,
  controllerId: Id<StructureController>
): number {
  const game = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game;
  if (!game?.creeps) {
    return 0;
  }

  return Object.values(game.creeps).filter((creep) =>
    canSatisfyControllerUpgradeDemand(creep, roomName, controllerId)
  ).length;
}

function canSatisfyControllerUpgradeDemand(
  creep: Creep,
  roomName: string,
  controllerId: Id<StructureController>
): boolean {
  if (creep.ticksToLive !== undefined && creep.ticksToLive <= 0) {
    return false;
  }

  const upgradeMemory = creep.memory.controllerUpgrade;
  if (
    (creep.memory.role === UPGRADER_ROLE || creep.memory.role === 'worker') &&
    upgradeMemory?.roomName === roomName &&
    upgradeMemory.controllerId === controllerId
  ) {
    return true;
  }

  if (hasMatchingControllerSustainAssignment(creep, roomName, controllerId)) {
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

function hasMatchingControllerSustainAssignment(
  creep: Creep,
  roomName: string,
  controllerId: Id<StructureController>
): boolean {
  const sustain = creep.memory.controllerSustain;
  const territory = creep.memory.territory;
  return (
    sustain?.role === 'upgrader' &&
    sustain.targetRoom === roomName &&
    territory?.targetRoom === roomName &&
    territory.controllerId === controllerId
  );
}

function hasVisibleConstructionDemand(room: Room): boolean {
  return (
    findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES').length > 0 ||
    findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES').filter((site) => site.my !== false).length > 0
  );
}

function findRoomObjects<T>(room: Room, globalName: string): T[] {
  const findConstant = (globalThis as Record<string, unknown>)[globalName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = (room.find as unknown as (type: number) => unknown[])(findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function hasRecordedEnergySurplus(roomName: string): boolean {
  return (
    (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.economy?.energySurplus?.rooms?.[roomName]
      ?.surplus === true
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
    ...(typeof plan.controllerLevel === 'number' ? { controllerLevel: plan.controllerLevel } : {}),
    ...(typeof plan.desiredControllerLevel === 'number'
      ? { desiredControllerLevel: plan.desiredControllerLevel }
      : {}),
    signNeeded: plan.signNeeded,
    upgradePriority: plan.upgradePriority,
    desiredUpgraderCount: plan.desiredUpgraderCount,
    activeUpgraderCount: plan.activeUpgraderCount,
    updatedAt: plan.updatedAt,
    ...(typeof plan.progress === 'number' ? { progress: plan.progress } : {}),
    ...(typeof plan.progressTotal === 'number' ? { progressTotal: plan.progressTotal } : {}),
    ...(typeof plan.progressRemaining === 'number' ? { progressRemaining: plan.progressRemaining } : {}),
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

function getControllerProgressFields(
  controller: StructureController
): Pick<ControllerManagementPlan, 'progress' | 'progressTotal' | 'progressRemaining' | 'progressRatio'> {
  const progress = controller.progress;
  const progressTotal = controller.progressTotal;
  if (
    typeof progress !== 'number' ||
    typeof progressTotal !== 'number' ||
    !Number.isFinite(progress) ||
    !Number.isFinite(progressTotal) ||
    progressTotal <= 0
  ) {
    return {};
  }

  const normalizedProgress = Math.max(0, progress);
  return {
    progress: normalizedProgress,
    progressTotal,
    progressRemaining: Math.max(0, progressTotal - normalizedProgress),
    progressRatio: normalizedProgress / progressTotal
  };
}

function getControllerLevel(controller: StructureController): number {
  return typeof controller.level === 'number' && Number.isFinite(controller.level)
    ? Math.max(0, Math.min(MAX_CONTROLLER_LEVEL, Math.floor(controller.level)))
    : 0;
}

function normalizeDesiredControllerLevel(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(MAX_CONTROLLER_LEVEL, Math.floor(value)))
    : MAX_CONTROLLER_LEVEL;
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

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
