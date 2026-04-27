import { getOwnedColonies } from '../colony/colonyRegistry';
import { planExtensionConstruction } from '../construction/extensionPlanner';
import { countCreepsByRole } from '../creeps/roleCounts';
import { runWorker } from '../creeps/workerRunner';
import { planSpawn, type SpawnRequest } from '../spawn/spawnPlanner';
import { emitRuntimeSummary, type RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

const ERR_BUSY_CODE = -4 as ScreepsReturnCode;

export function runEconomy(): void {
  const creeps = Object.values(Game.creeps);
  const colonies = getOwnedColonies();
  const telemetryEvents: RuntimeTelemetryEvent[] = [];

  for (const colony of colonies) {
    planExtensionConstruction(colony);

    const roleCounts = countCreepsByRole(creeps, colony.room.name);
    const spawnRequest = planSpawn(colony, roleCounts, Game.time);

    if (spawnRequest) {
      for (const spawn of getSpawnAttemptOrder(spawnRequest, colony.spawns)) {
        const result = attemptSpawn({ ...spawnRequest, spawn }, colony.room.name, telemetryEvents);
        if (result !== ERR_BUSY_CODE) {
          break;
        }
      }
    }
  }

  for (const creep of creeps) {
    if (creep.memory.role === 'worker') {
      runWorker(creep);
    }
  }

  emitRuntimeSummary(colonies, creeps, telemetryEvents);
}

function getSpawnAttemptOrder(spawnRequest: SpawnRequest, spawns: StructureSpawn[]): StructureSpawn[] {
  return [spawnRequest.spawn, ...spawns.filter((spawn) => spawn !== spawnRequest.spawn && !spawn.spawning)];
}

function attemptSpawn(spawnRequest: SpawnRequest, roomName: string, telemetryEvents: RuntimeTelemetryEvent[]): ScreepsReturnCode {
  const result = spawnRequest.spawn.spawnCreep(spawnRequest.body, spawnRequest.name, {
    memory: spawnRequest.memory
  });
  telemetryEvents.push({
    type: 'spawn',
    roomName,
    spawnName: spawnRequest.spawn.name,
    creepName: spawnRequest.name,
    role: spawnRequest.memory.role,
    result
  });

  return result;
}
