import { ColonySnapshot } from '../colony/colonyRegistry';
import type { RoleCounts } from '../creeps/roleCounts';
import { buildEmergencyWorkerBody, buildWorkerBody, getBodyCost } from './bodyBuilder';

export interface SpawnRequest {
  spawn: StructureSpawn;
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}

const TARGET_WORKERS = 3;

export function planSpawn(colony: ColonySnapshot, roleCounts: RoleCounts, gameTime: number): SpawnRequest | null {
  if (roleCounts.worker >= TARGET_WORKERS) {
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
