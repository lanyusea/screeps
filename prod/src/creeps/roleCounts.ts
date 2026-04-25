export interface RoleCounts {
  worker: number;
}

export const WORKER_REPLACEMENT_TICKS_TO_LIVE = 100;

export function countCreepsByRole(creeps: Creep[], colonyName: string): RoleCounts {
  return creeps.reduce<RoleCounts>(
    (counts, creep) => {
      if (isColonyWorker(creep, colonyName) && canSatisfyWorkerCapacity(creep)) {
        counts.worker += 1;
      }
      return counts;
    },
    { worker: 0 }
  );
}

function isColonyWorker(creep: Creep, colonyName: string): boolean {
  return creep.memory.colony === colonyName && creep.memory.role === 'worker';
}

function canSatisfyWorkerCapacity(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}
