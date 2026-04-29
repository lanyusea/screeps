export interface RoleCounts {
  worker: number;
  workerCapacity?: number;
  claimer?: number;
  claimersByTargetRoom?: Record<string, number>;
  claimersByTargetRoomAction?: Partial<Record<TerritoryControlAction, Record<string, number>>>;
  scout?: number;
  scoutsByTargetRoom?: Record<string, number>;
}

// Conservative worker pre-spawn window. A three-part worker takes 9 ticks to
// spawn, so 100 ticks leaves scheduling and travel buffer while only retiring
// the final small slice of a 1500 tick lifetime from steady-state capacity.
export const WORKER_REPLACEMENT_TICKS_TO_LIVE = 100;

export function countCreepsByRole(creeps: Creep[], colonyName: string): RoleCounts {
  const counts = creeps.reduce<RoleCounts>(
    (counts, creep) => {
      if (isColonyWorker(creep, colonyName)) {
        counts.worker += 1;
        if (canSatisfyRoleCapacity(creep)) {
          counts.workerCapacity = (counts.workerCapacity ?? 0) + 1;
        }
      }
      if (isColonyClaimer(creep, colonyName) && canSatisfyTerritoryControllerCapacity(creep)) {
        counts.claimer = (counts.claimer ?? 0) + 1;
        const targetRoom = creep.memory.territory?.targetRoom;
        if (targetRoom) {
          const claimersByTargetRoom = counts.claimersByTargetRoom ?? {};
          claimersByTargetRoom[targetRoom] = (claimersByTargetRoom[targetRoom] ?? 0) + 1;
          counts.claimersByTargetRoom = claimersByTargetRoom;
          incrementTargetRoomActionCount(counts, creep.memory.territory?.action, targetRoom);
        }
      }
      if (isColonyScout(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts.scout = (counts.scout ?? 0) + 1;
        const targetRoom = creep.memory.territory?.targetRoom;
        if (targetRoom) {
          const scoutsByTargetRoom = counts.scoutsByTargetRoom ?? {};
          scoutsByTargetRoom[targetRoom] = (scoutsByTargetRoom[targetRoom] ?? 0) + 1;
          counts.scoutsByTargetRoom = scoutsByTargetRoom;
        }
      }
      return counts;
    },
    { worker: 0, workerCapacity: 0, claimer: 0, claimersByTargetRoom: {} }
  );

  if (counts.workerCapacity === counts.worker) {
    delete counts.workerCapacity;
  }

  return counts;
}

export function getWorkerCapacity(roleCounts: RoleCounts): number {
  return roleCounts.workerCapacity ?? roleCounts.worker;
}

function incrementTargetRoomActionCount(
  counts: RoleCounts,
  action: TerritoryIntentAction | undefined,
  targetRoom: string
): void {
  if (action !== 'claim' && action !== 'reserve') {
    return;
  }

  const claimersByTargetRoomAction = counts.claimersByTargetRoomAction ?? {};
  const claimersForAction = claimersByTargetRoomAction[action] ?? {};
  claimersForAction[targetRoom] = (claimersForAction[targetRoom] ?? 0) + 1;
  claimersByTargetRoomAction[action] = claimersForAction;
  counts.claimersByTargetRoomAction = claimersByTargetRoomAction;
}

function isColonyWorker(creep: Creep, colonyName: string): boolean {
  return creep.memory.colony === colonyName && creep.memory.role === 'worker';
}

function isColonyClaimer(creep: Creep, colonyName: string): boolean {
  return creep.memory.colony === colonyName && creep.memory.role === 'claimer';
}

function isColonyScout(creep: Creep, colonyName: string): boolean {
  return creep.memory.colony === colonyName && creep.memory.role === 'scout';
}

function canSatisfyRoleCapacity(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}

function canSatisfyTerritoryControllerCapacity(creep: Creep): boolean {
  return canSatisfyRoleCapacity(creep) && hasActiveClaimPart(creep);
}

function hasActiveClaimPart(creep: Creep): boolean {
  const claimPart = getBodyPartConstant('CLAIM', 'claim');
  const activeClaimParts = creep.getActiveBodyparts?.(claimPart);
  if (typeof activeClaimParts === 'number') {
    return activeClaimParts > 0;
  }

  if (!Array.isArray(creep.body)) {
    return false;
  }

  return creep.body.some((part) => isActiveBodyPart(part, claimPart));
}

function isActiveBodyPart(part: unknown, bodyPartType: BodyPartConstant): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }

  const bodyPart = part as Partial<BodyPartDefinition>;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === 'number' && bodyPart.hits > 0;
}

function getBodyPartConstant(globalName: 'CLAIM', fallback: BodyPartConstant): BodyPartConstant {
  const constants = globalThis as unknown as Partial<Record<'CLAIM', BodyPartConstant>>;
  return constants[globalName] ?? fallback;
}
