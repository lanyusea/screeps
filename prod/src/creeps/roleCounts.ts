export interface RoleCounts {
  worker: number;
  claimer?: number;
  claimersByTargetRoom?: Record<string, number>;
}

export const WORKER_REPLACEMENT_TICKS_TO_LIVE = 100;

export function countCreepsByRole(creeps: Creep[], colonyName: string): RoleCounts {
  return creeps.reduce<RoleCounts>(
    (counts, creep) => {
      if (isColonyWorker(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts.worker += 1;
      }
      if (isColonyClaimer(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts.claimer = (counts.claimer ?? 0) + 1;
        const targetRoom = creep.memory.territory?.targetRoom;
        if (targetRoom) {
          const claimersByTargetRoom = counts.claimersByTargetRoom ?? {};
          claimersByTargetRoom[targetRoom] = (claimersByTargetRoom[targetRoom] ?? 0) + 1;
          counts.claimersByTargetRoom = claimersByTargetRoom;
        }
      }
      return counts;
    },
    { worker: 0, claimer: 0, claimersByTargetRoom: {} }
  );
}

function isColonyWorker(creep: Creep, colonyName: string): boolean {
  return creep.memory.colony === colonyName && creep.memory.role === 'worker';
}

function isColonyClaimer(creep: Creep, colonyName: string): boolean {
  return creep.memory.colony === colonyName && creep.memory.role === 'claimer';
}

function canSatisfyRoleCapacity(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}
