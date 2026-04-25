import { getOwnedColonies } from '../colony/colonyRegistry';
import { countCreepsByRole } from '../creeps/roleCounts';
import { runWorker } from '../creeps/workerRunner';
import { planSpawn } from '../spawn/spawnPlanner';
import { emitRuntimeSummary, type RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export function runEconomy(): void {
  const creeps = Object.values(Game.creeps);
  const colonies = getOwnedColonies();
  const telemetryEvents: RuntimeTelemetryEvent[] = [];

  for (const colony of colonies) {
    const roleCounts = countCreepsByRole(creeps, colony.room.name);
    const spawnRequest = planSpawn(colony, roleCounts, Game.time);

    if (spawnRequest) {
      const result = spawnRequest.spawn.spawnCreep(spawnRequest.body, spawnRequest.name, {
        memory: spawnRequest.memory
      });
      telemetryEvents.push({
        type: 'spawn',
        roomName: colony.room.name,
        spawnName: spawnRequest.spawn.name,
        creepName: spawnRequest.name,
        role: spawnRequest.memory.role,
        result
      });
    }
  }

  for (const creep of creeps) {
    if (creep.memory.role === 'worker') {
      runWorker(creep);
    }
  }

  emitRuntimeSummary(colonies, creeps, telemetryEvents);
}
