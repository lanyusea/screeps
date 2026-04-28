import { ColonySnapshot } from '../colony/colonyRegistry';
import { getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import {
  buildEmergencyWorkerBody,
  buildTerritoryControllerBody,
  buildWorkerBody,
  getBodyCost
} from './bodyBuilder';
import {
  buildTerritoryCreepMemory,
  planTerritoryIntent,
  shouldSpawnTerritoryControllerCreep,
  TERRITORY_DOWNGRADE_GUARD_TICKS
} from '../territory/territoryPlanner';

export interface SpawnRequest {
  spawn: StructureSpawn;
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}

export interface SpawnPlanningOptions {
  nameSuffix?: string;
  workersOnly?: boolean;
}

const MIN_WORKER_TARGET = 3;
const WORKERS_PER_SOURCE = 2;
const CONSTRUCTION_BACKLOG_WORKER_BONUS = 1;
const SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT = 5;
const TERRITORY_SCOUT_BODY: BodyPartConstant[] = ['move'];
const TERRITORY_SCOUT_BODY_COST = 50;
// Keep source-aware scaling bounded so unusual source data cannot create runaway early-room spawn pressure.
const MAX_WORKER_TARGET = 6;
const sourceCountByRoomName = new Map<string, number>();

export function planSpawn(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions = {}
): SpawnRequest | null {
  const workerTarget = getWorkerTarget(colony, roleCounts);
  if (getWorkerCapacity(roleCounts) < workerTarget) {
    return planWorkerSpawn(colony, roleCounts, gameTime, options);
  }

  if (options.workersOnly) {
    return null;
  }

  const territoryIntent = planTerritoryIntent(colony, roleCounts, workerTarget, gameTime);
  if (!territoryIntent || !shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts, gameTime)) {
    return null;
  }

  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = buildTerritorySpawnBody(colony.energyAvailable, territoryIntent.action);
  if (body.length === 0) {
    return null;
  }

  const roleName = territoryIntent.action === 'scout' ? 'scout' : 'claimer';
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`${roleName}-${colony.room.name}-${territoryIntent.targetRoom}-${gameTime}`, options),
    memory: buildTerritoryCreepMemory(territoryIntent)
  };
}

function planWorkerSpawn(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions
): SpawnRequest | null {
  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = selectWorkerBody(colony, roleCounts);
  if (body.length === 0) {
    return null;
  }

  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`worker-${colony.room.name}-${gameTime}`, options),
    memory: { role: 'worker', colony: colony.room.name }
  };
}

function appendSpawnNameSuffix(baseName: string, options: SpawnPlanningOptions): string {
  return options.nameSuffix ? `${baseName}-${options.nameSuffix}` : baseName;
}

function selectWorkerBody(colony: ColonySnapshot, roleCounts: RoleCounts): BodyPartConstant[] {
  const normalBody = buildWorkerBody(colony.energyCapacityAvailable);
  if (canAffordBody(normalBody, colony.energyAvailable)) {
    return normalBody;
  }

  if (roleCounts.worker === 0) {
    return buildEmergencyWorkerBody(colony.energyAvailable);
  }

  return buildWorkerBody(colony.energyAvailable);
}

function canAffordBody(body: BodyPartConstant[], energyAvailable: number): boolean {
  return body.length > 0 && getBodyCost(body) <= energyAvailable;
}

function buildTerritorySpawnBody(energyAvailable: number, action: TerritoryIntentAction): BodyPartConstant[] {
  if (action === 'scout') {
    return energyAvailable >= TERRITORY_SCOUT_BODY_COST ? [...TERRITORY_SCOUT_BODY] : [];
  }

  return buildTerritoryControllerBody(energyAvailable);
}

function getWorkerTarget(colony: ColonySnapshot, roleCounts: RoleCounts): number {
  const sourceCount = getSourceCount(colony.room);
  const sourceAwareTarget = sourceCount * WORKERS_PER_SOURCE;
  const baseTarget = Math.min(MAX_WORKER_TARGET, Math.max(MIN_WORKER_TARGET, sourceAwareTarget));
  const workerCapacity = getWorkerCapacity(roleCounts);

  if (workerCapacity < baseTarget || !isConstructionBonusHomeSafe(colony.room.controller)) {
    return baseTarget;
  }

  const constructionBacklogSiteCount = getConstructionBacklogSiteCount(colony.room);
  if (constructionBacklogSiteCount === 0) {
    return baseTarget;
  }

  const firstBonusTarget = Math.min(MAX_WORKER_TARGET, baseTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS);
  if (
    workerCapacity < firstBonusTarget ||
    constructionBacklogSiteCount < SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT
  ) {
    return firstBonusTarget;
  }

  return Math.min(MAX_WORKER_TARGET, firstBonusTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS);
}

function isConstructionBonusHomeSafe(controller: StructureController | undefined): boolean {
  return (
    controller?.my === true &&
    (typeof controller.ticksToDowngrade !== 'number' ||
      controller.ticksToDowngrade > TERRITORY_DOWNGRADE_GUARD_TICKS)
  );
}

function getConstructionBacklogSiteCount(room: Room): number {
  if (typeof room.find !== 'function' || typeof FIND_MY_CONSTRUCTION_SITES !== 'number') {
    return 0;
  }

  return room.find(FIND_MY_CONSTRUCTION_SITES).length;
}

function getSourceCount(room: Room): number {
  const roomName = typeof room.name === 'string' && room.name.length > 0 ? room.name : undefined;
  if (roomName) {
    const cachedSourceCount = sourceCountByRoomName.get(roomName);
    if (cachedSourceCount !== undefined) {
      return cachedSourceCount;
    }
  }

  const sourceCount = findSourceCount(room);
  if (roomName) {
    sourceCountByRoomName.set(roomName, sourceCount);
  }

  return sourceCount;
}

function findSourceCount(room: Room): number {
  if (typeof FIND_SOURCES === 'undefined' || typeof room.find !== 'function') {
    return 1;
  }

  return room.find(FIND_SOURCES).length;
}
