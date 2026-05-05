import type { RoleCounts } from '../creeps/roleCounts';
import { getWorkerCapacity } from '../creeps/roleCounts';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import type { ColonySnapshot } from './colonyRegistry';

export type ColonyStage = 'BOOTSTRAP' | 'LOCAL_STABLE' | 'TERRITORY_READY' | 'DEFENSE';
export type ColonyMode = ColonyStage;

export type ColonyStageSuppressionReason =
  | 'bootstrapWorkerFloor'
  | 'spawnEnergyCritical'
  | 'bootstrapRecovery'
  | 'localWorkerRecovery'
  | 'controllerDowngradeGuard'
  | 'territoryEnergyCapacity'
  | 'controllerLevel'
  | 'defense';
export type ColonySuppressionReason = ColonyStageSuppressionReason;

export type ColonySpawnPriorityTier =
  | 'emergencyBootstrap'
  | 'localRefillSurvival'
  | 'controllerDowngradeGuard'
  | 'defense'
  | 'territoryRemote';

export interface ColonyStageInput {
  roomName: string;
  totalCreeps?: number;
  workerCapacity: number;
  workerTarget: number;
  energyAvailable?: number;
  energyCapacityAvailable: number;
  spawnEnergyAvailable?: number;
  previousMode?: ColonyStage;
  controller?: {
    my?: boolean;
    level?: number;
    ticksToDowngrade?: number;
  };
  hostileCreepCount?: number;
  hostileStructureCount?: number;
}
export type ColonySurvivalInput = ColonyStageInput;

export interface ColonyStageAssessment {
  mode: ColonyStage;
  stage: ColonyStage;
  roomName: string;
  totalCreeps: number;
  spawnEnergyAvailable: number;
  workerCapacity: number;
  workerTarget: number;
  survivalWorkerFloor: number;
  bootstrapRecovery: boolean;
  controllerDowngradeGuard: boolean;
  hostilePresence: boolean;
  territoryReady: boolean;
  suppressionReasons: ColonyStageSuppressionReason[];
}
export type ColonySurvivalAssessment = ColonyStageAssessment;

interface CachedColonyStageAssessment {
  assessment: ColonyStageAssessment;
  tick: number;
}

interface CachedRoomSources {
  sources: Source[];
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
export const BOOTSTRAP_MIN_CREEPS = 3;
export const BOOTSTRAP_EXIT_CREEPS = 5;
export const BOOTSTRAP_MIN_SPAWN_ENERGY = 300;
export const BOOTSTRAP_EXIT_SPAWN_ENERGY = 800;
export const CONTROLLER_DOWNGRADE_GUARD_SPAWN_TICKS = 2_000;
export const CONTROLLER_DOWNGRADE_CRITICAL_TICKS = 1_000;
export const EMERGENCY_BOOTSTRAP_WORKER_BODY: BodyPartConstant[] = ['work', 'carry', 'move'];
export const COLONY_SPAWN_PRIORITY_TIERS: ColonySpawnPriorityTier[] = [
  'emergencyBootstrap',
  'localRefillSurvival',
  'controllerDowngradeGuard',
  'defense',
  'territoryRemote'
];

const sourcesByRoomName = new Map<string, CachedRoomSources>();
const stageAssessmentByColony = new Map<string, CachedColonyStageAssessment>();

export function assessColonyStage(input: ColonyStageInput): ColonyStageAssessment {
  const workerCapacity = normalizeNonNegativeInteger(input.workerCapacity);
  const workerTarget = normalizeNonNegativeInteger(input.workerTarget);
  const totalCreeps = normalizeNonNegativeInteger(input.totalCreeps ?? workerCapacity);
  const spawnEnergyAvailable = normalizeNonNegativeInteger(
    input.spawnEnergyAvailable ?? input.energyAvailable ?? input.energyCapacityAvailable
  );
  const survivalWorkerFloor = Math.max(1, Math.min(BOOTSTRAP_WORKER_FLOOR, Math.max(workerTarget, 1)));
  const hostilePresence = (input.hostileCreepCount ?? 0) > 0 || (input.hostileStructureCount ?? 0) > 0;
  const controllerDowngradeGuard = isControllerDowngradeGuardActive(input.controller);
  const bootstrapCreepFloor = totalCreeps < BOOTSTRAP_MIN_CREEPS;
  const bootstrapSpawnEnergy = spawnEnergyAvailable < BOOTSTRAP_MIN_SPAWN_ENERGY;
  const bootstrapRecovery =
    input.previousMode === 'BOOTSTRAP' &&
    !bootstrapCreepFloor &&
    !bootstrapSpawnEnergy &&
    !hasBootstrapExitStability(totalCreeps, spawnEnergyAvailable);
  const bootstrap = bootstrapCreepFloor || bootstrapSpawnEnergy || bootstrapRecovery;
  const territoryReady =
    !bootstrap &&
    !hostilePresence &&
    workerCapacity >= workerTarget &&
    input.energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST &&
    isControllerTerritoryReady(input.controller) &&
    !controllerDowngradeGuard;
  const mode = selectColonyMode({ bootstrap, hostilePresence, territoryReady });

  return {
    mode,
    stage: mode,
    roomName: input.roomName,
    totalCreeps,
    spawnEnergyAvailable,
    workerCapacity,
    workerTarget,
    survivalWorkerFloor,
    bootstrapRecovery,
    controllerDowngradeGuard,
    hostilePresence,
    territoryReady,
    suppressionReasons: getSuppressionReasons({
      bootstrapCreepFloor,
      bootstrapRecovery,
      bootstrapSpawnEnergy,
      controller: input.controller,
      controllerDowngradeGuard,
      energyCapacityAvailable: input.energyCapacityAvailable,
      hostilePresence,
      mode,
      workerCapacity,
      workerTarget
    })
  };
}

export function assessColonySurvival(input: ColonySurvivalInput): ColonySurvivalAssessment {
  return assessColonyStage(input);
}

export function assessColonySnapshotStage(
  colony: ColonySnapshot,
  roleCounts: RoleCounts
): ColonyStageAssessment {
  const previousMode = getPersistedColonyStageMode(colony);
  return assessColonyStage({
    roomName: getRoomName(colony.room) ?? '',
    totalCreeps: getColonyCreepTotal(roleCounts),
    workerCapacity: getWorkerCapacity(roleCounts),
    workerTarget: getWorkerTarget(colony, roleCounts),
    energyAvailable: colony.energyAvailable,
    energyCapacityAvailable: colony.energyCapacityAvailable,
    spawnEnergyAvailable: colony.energyAvailable,
    previousMode,
    controller: getControllerSurvivalState(colony.room.controller),
    hostileCreepCount: countRoomFind(colony.room, 'FIND_HOSTILE_CREEPS'),
    hostileStructureCount: countRoomFind(colony.room, 'FIND_HOSTILE_STRUCTURES')
  });
}

export function assessColonySnapshotSurvival(
  colony: ColonySnapshot,
  roleCounts: RoleCounts
): ColonySurvivalAssessment {
  return assessColonySnapshotStage(colony, roleCounts);
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

  stageAssessmentByColony.set(colonyName, { assessment, tick });
}

export function recordColonyStageAssessment(
  colonyName: string,
  assessment: ColonyStageAssessment,
  tick = getGameTime()
): void {
  recordColonySurvivalAssessment(colonyName, assessment, tick);
}

export function persistColonyStageAssessment(
  colony: ColonySnapshot,
  assessment: ColonyStageAssessment,
  tick = getGameTime()
): void {
  if (tick === null) {
    return;
  }

  const memory = getWritableColonyMemory(colony);
  memory.colonyStage = {
    mode: assessment.mode,
    updatedAt: tick,
    ...(assessment.suppressionReasons.length > 0 ? { suppressionReasons: assessment.suppressionReasons } : {})
  };
}

export function getRecordedColonySurvivalAssessment(
  colonyName: string | null | undefined,
  tick = getGameTime()
): ColonySurvivalAssessment | null {
  if (!isNonEmptyString(colonyName) || tick === null) {
    return null;
  }

  const cached = stageAssessmentByColony.get(colonyName);
  return cached?.tick === tick ? cached.assessment : null;
}

export function getRecordedColonyStageAssessment(
  colonyName: string | null | undefined,
  tick = getGameTime()
): ColonyStageAssessment | null {
  return getRecordedColonySurvivalAssessment(colonyName, tick);
}

export function clearColonySurvivalAssessmentCache(): void {
  stageAssessmentByColony.clear();
}

export function clearColonyStageAssessmentCache(): void {
  clearColonySurvivalAssessmentCache();
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

export function getColonySpawnPriorityTiers(): ColonySpawnPriorityTier[] {
  return [...COLONY_SPAWN_PRIORITY_TIERS];
}

export function hasEmergencyBootstrapCreepShortfall(assessment: ColonyStageAssessment): boolean {
  return assessment.totalCreeps < BOOTSTRAP_MIN_CREEPS;
}

function selectColonyMode(input: {
  bootstrap: boolean;
  hostilePresence: boolean;
  territoryReady: boolean;
}): ColonyStage {
  if (input.bootstrap) {
    return 'BOOTSTRAP';
  }

  if (input.hostilePresence) {
    return 'DEFENSE';
  }

  return input.territoryReady ? 'TERRITORY_READY' : 'LOCAL_STABLE';
}

function getSuppressionReasons(input: {
  bootstrapCreepFloor: boolean;
  bootstrapRecovery: boolean;
  bootstrapSpawnEnergy: boolean;
  controller?: ColonyStageInput['controller'];
  controllerDowngradeGuard: boolean;
  energyCapacityAvailable: number;
  hostilePresence: boolean;
  mode: ColonyStage;
  workerCapacity: number;
  workerTarget: number;
}): ColonyStageSuppressionReason[] {
  const reasons: ColonyStageSuppressionReason[] = [];
  if (input.bootstrapCreepFloor) {
    reasons.push('bootstrapWorkerFloor');
  }

  if (input.bootstrapSpawnEnergy) {
    reasons.push('spawnEnergyCritical');
  }

  if (input.bootstrapRecovery) {
    reasons.push('bootstrapRecovery');
  }

  if (input.mode === 'BOOTSTRAP') {
    return reasons;
  }

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

function hasBootstrapExitStability(totalCreeps: number, spawnEnergyAvailable: number): boolean {
  return totalCreeps >= BOOTSTRAP_EXIT_CREEPS && spawnEnergyAvailable >= BOOTSTRAP_EXIT_SPAWN_ENERGY;
}

function isControllerTerritoryReady(controller: ColonyStageInput['controller']): boolean {
  return controller?.my === true && typeof controller.level === 'number' && controller.level >= 2;
}

function isControllerDowngradeGuardActive(controller: ColonyStageInput['controller']): boolean {
  return (
    controller?.my === true &&
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade < CONTROLLER_DOWNGRADE_GUARD_SPAWN_TICKS
  );
}

function getControllerSurvivalState(
  controller: StructureController | undefined
): ColonyStageInput['controller'] {
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
      controller.ticksToDowngrade >= CONTROLLER_DOWNGRADE_GUARD_SPAWN_TICKS)
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

export function getSourceCount(room: Room): number {
  return getRoomSources(room).length;
}

export function getRoomSources(room: Room): Source[] {
  const roomName = getRoomName(room);
  if (roomName) {
    const cachedSources = sourcesByRoomName.get(roomName);
    if (cachedSources?.room === room) {
      return cachedSources.sources;
    }
  }

  const sources = findSources(room);
  if (roomName) {
    sourcesByRoomName.set(roomName, { sources, room });
  }

  return sources;
}

function findSources(room: Room): Source[] {
  if (typeof room.find !== 'function') {
    return [{} as Source];
  }

  const sourceFindConstant = getGlobalNumber('FIND_SOURCES');
  if (sourceFindConstant === undefined) {
    return [{} as Source];
  }

  return room.find(sourceFindConstant as FindConstant) as Source[];
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

function getColonyCreepTotal(roleCounts: RoleCounts): number {
  return normalizeNonNegativeInteger(roleCounts.worker) +
    normalizeNonNegativeInteger(roleCounts.defender ?? 0) +
    normalizeNonNegativeInteger(roleCounts.claimer ?? 0) +
    normalizeNonNegativeInteger(roleCounts.scout ?? 0);
}

function getPersistedColonyStageMode(colony: ColonySnapshot): ColonyStage | undefined {
  const mode = getReadableColonyMemory(colony)?.colonyStage?.mode;
  return isColonyStage(mode) ? mode : undefined;
}

function getReadableColonyMemory(colony: ColonySnapshot): RoomMemory | undefined {
  return colony.memory ?? (colony.room as Room & { memory?: RoomMemory }).memory;
}

function getWritableColonyMemory(colony: ColonySnapshot): RoomMemory {
  const roomWithMemory = colony.room as Room & { memory?: RoomMemory };
  const memory = colony.memory ?? roomWithMemory.memory ?? {};
  if (!colony.memory) {
    colony.memory = memory;
  }
  if (!roomWithMemory.memory) {
    roomWithMemory.memory = memory;
  }
  return memory;
}

function isColonyStage(value: unknown): value is ColonyStage {
  return value === 'BOOTSTRAP' || value === 'LOCAL_STABLE' || value === 'TERRITORY_READY' || value === 'DEFENSE';
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
