import { ColonySnapshot } from '../colony/colonyRegistry';
import type { RoleCounts } from '../creeps/roleCounts';
import { buildEmergencyWorkerBody, buildWorkerBody, getBodyCost } from './bodyBuilder';

export interface SpawnRequest {
  spawn: StructureSpawn;
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}

const MIN_WORKER_TARGET = 3;
const WORKERS_PER_SOURCE = 2;
// Keep source-aware scaling bounded so unusual source data cannot create runaway early-room spawn pressure.
const MAX_WORKER_TARGET = 6;

export function planSpawn(colony: ColonySnapshot, roleCounts: RoleCounts, gameTime: number): SpawnRequest | null {
  if (roleCounts.worker >= getWorkerTarget(colony)) {
    return null;
  }

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

  return [];
}

function canAffordBody(body: BodyPartConstant[], energyAvailable: number): boolean {
  return body.length > 0 && getBodyCost(body) <= energyAvailable;
}

function getWorkerTarget(colony: ColonySnapshot): number {
  const sourceCount = getSourceCount(colony.room);
  const sourceAwareTarget = sourceCount * WORKERS_PER_SOURCE;

  return Math.min(MAX_WORKER_TARGET, Math.max(MIN_WORKER_TARGET, sourceAwareTarget));
}

function getSourceCount(room: Room): number {
  if (typeof FIND_SOURCES === 'undefined') {
    return 1;
  }

  return room.find(FIND_SOURCES).length;
}
