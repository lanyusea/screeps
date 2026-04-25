import { RoleCounts } from '../spawn/spawnPlanner';

export function countCreepsByRole(creeps: Creep[], colonyName: string): RoleCounts {
  return creeps.reduce<RoleCounts>(
    (counts, creep) => {
      if (creep.memory.colony === colonyName && creep.memory.role === 'worker') {
        counts.worker += 1;
      }
      return counts;
    },
    { worker: 0 }
  );
}
