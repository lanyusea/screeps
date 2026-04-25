import { getOwnedColonies } from '../colony/colonyRegistry';
import { countCreepsByRole } from '../creeps/roleCounts';
import { runWorker } from '../creeps/workerRunner';
import { planSpawn } from '../spawn/spawnPlanner';

export function runEconomy(): void {
  const creeps = Object.values(Game.creeps);

  for (const colony of getOwnedColonies()) {
    const roleCounts = countCreepsByRole(creeps, colony.room.name);
    const spawnRequest = planSpawn(colony, roleCounts, Game.time);

    if (spawnRequest) {
      spawnRequest.spawn.spawnCreep(spawnRequest.body, spawnRequest.name, {
        memory: spawnRequest.memory
      });
    }
  }

  for (const creep of creeps) {
    if (creep.memory.role === 'worker') {
      runWorker(creep);
    }
  }
}
