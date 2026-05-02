import type { RoleCounts } from '../creeps/roleCounts';
import { getWorkerCapacity } from '../creeps/roleCounts';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import type { ColonySnapshot } from './colonyRegistry';

export type ColonyMode = 'BOOTSTRAP' | 'LOCAL_STABLE' | 'TERRITORY_READY' | 'DEFENSE';

export type ColonySuppressionReason =
  | 'bootstrapWorkerFloor'
  | 'localWorkerRecovery'
  | 'controllerDowngradeGuard'
  | 'territoryEnergyCapacity'
  | 'controllerLevel'
  | 'defense';

export interface ColonySurvivalInput {
  roomName: string;
  workerCapacity: number;
  workerTarget: number;
  energyCapacityAvailable: number;
  controller?: {
    my?: boolean;
    level?: number;
    ticksToDowngrade?: number;
  };
  hostileCreepCount?: number;
  hostileStructureCount?: number;
}

export interface ColonySurvivalAssessment {
  mode: ColonyMode;
  roomName: string;
  workerCapacity: number;
  workerTarget: number;
  survivalWorkerFloor: number;
  controllerDowngradeGuard: boolean;
  hostilePresence: boolean;
  territoryReady: boolean;
  suppressionReasons: ColonySuppressionReason[];
}

interface CachedColonySurvivalAssessment {
  assessment: ColonySurvivalAssessment;
  tick: number;
}

interface CachedSourceCount {
  count: number;
  room: Room;
}

const MIN_WORKER_TARGET = 3;
const WORKERS_PER_SOURCE = 2;
const CONSTRUCTION_BACKLOG_WORKER_BONUS = 1;
const SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT = 5;
const SPAWN_EXTENSION_REFILL_WORKER_BONUS = 1;
const MIN_PRODUCTIVE_WORKER_BODY_ENERGY = 200;
const SPAWN_EXTENSION_REFILL_PRESSURE_RATIO = 0.75;
const MAX_WORKER_TARGET = 6;
const BOOTSTRAP_WORKER_FLOOR = 3;
const CONTROLLER_DOWNGRADE_GUARD_TICKS = 5_000;

const sourceCountByRoomName = new Map<string, CachedSourceCount>();
const survivalAssessmentByColony = new Map<string, CachedColonySurvivalAssessment>();

export function assessColonySurvival(input: ColonySurvivalInput): ColonySurvivalAssessment {
  const workerCapacity = normalizeNonNegativeInteger(input.workerCapacity);
  const workerTarget = normalizeNonNegativeInteger(input.workerTarget);
  const survivalWorkerFloor = Math.max(1, Math.min(BOOTSTRAP_WORKER_FLOOR, Math.max(workerTarget, 1)));
  const hostilePresence = (input.hostileCreepCount ?? 0) > 0 || (input.hostileStructureCount ?? 0) > 0;
  const controllerDowngradeGuard = isControllerDowngradeGuardActive(input.controller);
  const bootstrap = workerCapacity < survivalWorkerFloor;
  const territoryReady =
    !bootstrap &&
    !hostilePresence &&
    workerCapacity >= workerTarget &&
    input.energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST &&
    isControllerTerritoryReady(input.controller) &&
    !controllerDowngradeGuard;

  return {
    mode: selectColonyMode({ bootstrap, hostilePresence, territoryReady }),
    roomName: input.roomName,
    workerCapacity,
    workerTarget,
    survivalWorkerFloor,
    controllerDowngradeGuard,
    hostilePresence,
    territoryReady,
    suppressionReasons: getSuppressionReasons({
      bootstrap,
      controller: input.controller,
      controllerDowngradeGuard,
      energyCapacityAvailable: input.energyCapacityAvailable,
      hostilePresence,
      workerCapacity,
      workerTarget
    })
  };
}

export function assessColonySnapshotSurvival(
  colony: ColonySnapshot,
  roleCounts: RoleCounts
): ColonySurvivalAssessment {
  return assessColonySurvival({
    roomName: getRoomName(colony.room) ?? '',
    workerCapacity: getWorkerCapacity(roleCounts),
    workerTarget: getWorkerTarget(colony, roleCounts),
    energyCapacityAvailable: colony.energyCapacityAvailable,
    controller: getControllerSurvivalState(colony.room.controller),
    hostileCreepCount: countRoomFind(colony.room, 'FIND_HOSTILE_CREEPS'),
    hostileStructureCount: countRoomFind(colony.room, 'FIND_HOSTILE_STRUCTURES')
  });
}

export function getWorkerTarget(colony: ColonySnapshot, roleCounts: RoleCounts): number {
  const sourceCount = getSourceCount(colony.room);
  const sourceAwareTarget = sourceCount * WORKERS_PER_SOURCE;
  const baseTarget = Math.min(MAX_WORKER_TARGET, Math.max(MIN_WORKER_TARGET, sourceAwareTarget));
  const workerCapacity = getWorkerCapacity(roleCounts);

  if (workerCapacity < baseTarget || !isConstructionBonusHomeSafe(colony.room.controller)) {
    return baseTarget;
  }

  const refillPressureTarget = shouldAddSpawnExtensionRefillWorker(colony)
    ? Math.min(MAX_WORKER_TARGET, baseTarget + SPAWN_EXTENSION_REFILL_WORKER_BONUS)
    : baseTarget;
  if (workerCapacity < refillPressureTarget) {
    return refillPressureTarget;
  }

  const constructionBacklogSiteCount = getConstructionBacklogSiteCount(colony.room);
  if (constructionBacklogSiteCount === 0) {
    return refillPressureTarget;
  }

  const firstBonusTarget = Math.min(
    MAX_WORKER_TARGET,
    refillPressureTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS
  );
  if (
    workerCapacity < firstBonusTarget ||
    constructionBacklogSiteCount < SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT
  ) {
    return firstBonusTarget;
  }

  return Math.min(MAX_WORKER_TARGET, firstBonusTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS);
}

export function recordColonySurvivalAssessment(
  colonyName: string,
  assessment: ColonySurvivalAssessment,
  tick = getGameTime()
): void {
  if (!isNonEmptyString(colonyName) || tick === null) {
    return;
  }

  survivalAssessmentByColony.set(colonyName, { assessment, tick });
}

export function getRecordedColonySurvivalAssessment(
  colonyName: string | null | undefined,
  tick = getGameTime()
): ColonySurvivalAssessment | null {
  if (!isNonEmptyString(colonyName) || tick === null) {
    return null;
  }

  const cached = survivalAssessmentByColony.get(colonyName);
  return cached?.tick === tick ? cached.assessment : null;
}

export function clearColonySurvivalAssessmentCache(): void {
  survivalAssessmentByColony.clear();
}

export function suppressesTerritoryWork(assessment: ColonySurvivalAssessment | null): boolean {
  return (
    assessment !== null &&
    (assessment.mode === 'BOOTSTRAP' || assessment.mode === 'LOCAL_STABLE' || assessment.mode === 'DEFENSE')
  );
}

export function suppressesBootstrapNonCriticalWork(assessment: ColonySurvivalAssessment | null): boolean {
  return assessment?.mode === 'BOOTSTRAP';
}

function selectColonyMode(input: {
  bootstrap: boolean;
  hostilePresence: boolean;
  territoryReady: boolean;
}): ColonyMode {
  if (input.bootstrap) {
    return 'BOOTSTRAP';
  }

  if (input.hostilePresence) {
    return 'DEFENSE';
  }

  return input.territoryReady ? 'TERRITORY_READY' : 'LOCAL_STABLE';
}

function getSuppressionReasons(input: {
  bootstrap: boolean;
  controller?: ColonySurvivalInput['controller'];
  controllerDowngradeGuard: boolean;
  energyCapacityAvailable: number;
  hostilePresence: boolean;
  workerCapacity: number;
  workerTarget: number;
}): ColonySuppressionReason[] {
  if (input.bootstrap) {
    return ['bootstrapWorkerFloor'];
  }

  const reasons: ColonySuppressionReason[] = [];
  if (input.workerCapacity < input.workerTarget) {
    reasons.push('localWorkerRecovery');
  }

  if (input.controllerDowngradeGuard) {
    reasons.push('controllerDowngradeGuard');
  }

  if (input.hostilePresence) {
    reasons.push('defense');
  }

  if (input.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    reasons.push('territoryEnergyCapacity');
  }

  if (!isControllerTerritoryReady(input.controller)) {
    reasons.push('controllerLevel');
  }

  return reasons;
}

function isControllerTerritoryReady(controller: ColonySurvivalInput['controller']): boolean {
  return controller?.my === true && typeof controller.level === 'number' && controller.level >= 2;
}

function isControllerDowngradeGuardActive(controller: ColonySurvivalInput['controller']): boolean {
  return (
    controller?.my === true &&
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS
  );
}

function getControllerSurvivalState(
  controller: StructureController | undefined
): ColonySurvivalInput['controller'] {
  if (!controller) {
    return undefined;
  }

  return {
    my: controller.my,
    level: controller.level,
    ticksToDowngrade: controller.ticksToDowngrade
  };
}

function isConstructionBonusHomeSafe(controller: StructureController | undefined): boolean {
  return (
    controller?.my === true &&
    (typeof controller.ticksToDowngrade !== 'number' ||
      controller.ticksToDowngrade > CONTROLLER_DOWNGRADE_GUARD_TICKS)
  );
}

function shouldAddSpawnExtensionRefillWorker(colony: ColonySnapshot): boolean {
  return (
    colony.spawns.length > 0 &&
    colony.energyAvailable >= MIN_PRODUCTIVE_WORKER_BODY_ENERGY &&
    colony.energyAvailable < TERRITORY_CONTROLLER_BODY_COST &&
    colony.energyCapacityAvailable > 0 &&
    colony.energyAvailable < colony.energyCapacityAvailable * SPAWN_EXTENSION_REFILL_PRESSURE_RATIO
  );
}

function getConstructionBacklogSiteCount(room: Room): number {
  return countRoomFind(room, 'FIND_MY_CONSTRUCTION_SITES');
}

function getSourceCount(room: Room): number {
  const roomName = getRoomName(room);
  if (roomName) {
    const cachedSourceCount = sourceCountByRoomName.get(roomName);
    if (cachedSourceCount?.room === room) {
      return cachedSourceCount.count;
    }
  }

  const sourceCount = findSourceCount(room);
  if (roomName) {
    sourceCountByRoomName.set(roomName, { count: sourceCount, room });
  }

  return sourceCount;
}

function findSourceCount(room: Room): number {
  if (typeof room.find !== 'function') {
    return 1;
  }

  const sourceFindConstant = getGlobalNumber('FIND_SOURCES');
  if (sourceFindConstant === undefined) {
    return 1;
  }

  return room.find(sourceFindConstant as FindConstant).length;
}

function countRoomFind(room: Room, constantName: string): number {
  if (typeof room.find !== 'function') {
    return 0;
  }

  const findConstant = getGlobalNumber(constantName);
  if (findConstant === undefined) {
    return 0;
  }

  return room.find(findConstant as FindConstant).length;
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getRoomName(room: Room): string | null {
  return typeof room.name === 'string' && room.name.length > 0 ? room.name : null;
}

function getGameTime(): number | null {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : null;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
