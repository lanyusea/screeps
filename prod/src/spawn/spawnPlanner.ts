import { ColonySnapshot } from '../colony/colonyRegistry';
import type { RoleCounts } from '../creeps/roleCounts';
import {
  buildEmergencyWorkerBody,
  buildTerritoryControllerBody,
  buildWorkerBody,
  getBodyCost
} from './bodyBuilder';
import {
  buildTerritoryCreepMemory,
  planTerritoryIntent,
  shouldSpawnTerritoryControllerCreep
} from '../territory/territoryPlanner';

export interface SpawnRequest {
  spawn: StructureSpawn;
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}

const MIN_WORKER_TARGET = 3;
const WORKERS_PER_SOURCE = 2;
const TERRITORY_SCOUT_BODY: BodyPartConstant[] = ['move'];
const TERRITORY_SCOUT_BODY_COST = 50;
// Keep source-aware scaling bounded so unusual source data cannot create runaway early-room spawn pressure.
const MAX_WORKER_TARGET = 6;
const sourceCountByRoomName = new Map<string, number>();

export function planSpawn(colony: ColonySnapshot, roleCounts: RoleCounts, gameTime: number): SpawnRequest | null {
  const workerTarget = getWorkerTarget(colony);
  if (roleCounts.worker < workerTarget) {
    return planWorkerSpawn(colony, roleCounts, gameTime);
  }

  const territoryIntent = planTerritoryIntent(colony, roleCounts, workerTarget, gameTime);
  if (!territoryIntent || !shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts)) {
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
    name: `${roleName}-${colony.room.name}-${territoryIntent.targetRoom}-${gameTime}`,
    memory: buildTerritoryCreepMemory(territoryIntent)
  };
}

function planWorkerSpawn(colony: ColonySnapshot, roleCounts: RoleCounts, gameTime: number): SpawnRequest | null {
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
    name: `worker-${colony.room.name}-${gameTime}`,
    memory: { role: 'worker', colony: colony.room.name }
  };
}

function selectWorkerBody(colony: ColonySnapshot, roleCounts: RoleCounts): BodyPartConstant[] {
  const normalBody = buildWorkerBody(colony.energyCapacityAvailable);
  if (canAffordBody(normalBody, colony.energyAvailable)) {
    return normalBody;
  }

  if (roleCounts.worker === 0) {
    return buildEmergencyWorkerBody(colony.energyAvailable);
  }

  return roleCounts.worker < MIN_WORKER_TARGET ? buildWorkerBody(colony.energyAvailable) : [];
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

function getWorkerTarget(colony: ColonySnapshot): number {
  const sourceCount = getSourceCount(colony.room);
  const sourceAwareTarget = sourceCount * WORKERS_PER_SOURCE;

  return Math.min(MAX_WORKER_TARGET, Math.max(MIN_WORKER_TARGET, sourceAwareTarget));
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
