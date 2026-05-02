export const WORKER_TASK_BEHAVIOR_SCHEMA_VERSION = 1;
export const HEURISTIC_WORKER_TASK_POLICY_ID = 'heuristic.worker-task.v1';
export const WORKER_TASK_BC_ACTION_TYPES = ['harvest', 'transfer', 'build', 'repair', 'upgrade'] as const;

const NEARBY_STRUCTURE_RANGE = 3;
const NEARBY_TILE_COUNT = 49;
const CURRENT_TASK_CODE: Record<string, number> = {
  none: 0,
  harvest: 1,
  pickup: 2,
  withdraw: 3,
  transfer: 4,
  build: 5,
  repair: 6,
  claim: 7,
  reserve: 8,
  upgrade: 9
};

type StoreOwner = {
  store?: {
    getUsedCapacity?: (resource?: ResourceConstant) => number | null;
    getFreeCapacity?: (resource?: ResourceConstant) => number | null;
  };
};

export type WorkerTaskBehaviorActionType = (typeof WORKER_TASK_BC_ACTION_TYPES)[number];

export function isWorkerTaskBehaviorActionType(value: unknown): value is WorkerTaskBehaviorActionType {
  return WORKER_TASK_BC_ACTION_TYPES.includes(value as WorkerTaskBehaviorActionType);
}

export function recordWorkerTaskBehaviorTrace(
  creep: Creep,
  selectedTask: CreepTaskMemory | null
): WorkerTaskBehaviorSampleMemory | null {
  const memory = creep.memory;
  if (!memory) {
    return null;
  }

  if (!selectedTask || !isWorkerTaskBehaviorActionType(selectedTask.type)) {
    delete memory.workerBehavior;
    return null;
  }

  const sample: WorkerTaskBehaviorSampleMemory = {
    type: 'workerTaskBehavior',
    schemaVersion: WORKER_TASK_BEHAVIOR_SCHEMA_VERSION,
    tick: getGameTick(),
    policyId: HEURISTIC_WORKER_TASK_POLICY_ID,
    liveEffect: false,
    state: buildWorkerTaskBehaviorState(creep),
    action: {
      type: selectedTask.type,
      targetId: String(selectedTask.targetId)
    }
  };
  memory.workerBehavior = sample;
  return sample;
}

export function buildWorkerTaskBehaviorState(creep: Creep): WorkerTaskBehaviorStateMemory {
  const room = creep.room;
  const structures = findRoomObjects<AnyStructure>(room, getFindConstant('FIND_STRUCTURES'));
  const myStructures = findRoomObjects<AnyOwnedStructure>(room, getFindConstant('FIND_MY_STRUCTURES'));
  const constructionSites = findRoomObjects<ConstructionSite>(room, getFindConstant('FIND_CONSTRUCTION_SITES'));
  const droppedResources = findRoomObjects<Resource<ResourceConstant>>(room, getFindConstant('FIND_DROPPED_RESOURCES'));
  const sources = findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES'));
  const hostileCreeps = findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS'));
  const currentTask = creep.memory?.task?.type ?? 'none';
  const carriedEnergy = getUsedEnergy(creep);
  const freeCapacity = getFreeEnergyCapacity(creep);
  const energyCapacity = Math.max(0, carriedEnergy + freeCapacity);
  const controller = room?.controller;
  const nearbyStructures = structures.filter((structure) => getRangeBetweenRoomObjects(creep, structure) <= NEARBY_STRUCTURE_RANGE);
  const nearbyRoadCount = nearbyStructures.filter((structure) => isStructureType(structure, 'STRUCTURE_ROAD', 'road')).length;
  const nearbyContainerCount = nearbyStructures.filter((structure) =>
    isStructureType(structure, 'STRUCTURE_CONTAINER', 'container')
  ).length;
  const containerCount = structures.filter((structure) =>
    isStructureType(structure, 'STRUCTURE_CONTAINER', 'container')
  ).length;
  const droppedEnergyAvailable = sumDroppedEnergy(droppedResources);
  const spawnExtensionNeedCount = myStructures.filter(
    (structure) =>
      isStructureType(structure, 'STRUCTURE_SPAWN', 'spawn') ||
      isStructureType(structure, 'STRUCTURE_EXTENSION', 'extension')
  ).length;
  const towerNeedCount = myStructures.filter(
    (structure) => isStructureType(structure, 'STRUCTURE_TOWER', 'tower')
  ).length;

  return {
    roomName: room?.name ?? 'unknown',
    ...buildPositionState(creep.pos),
    carriedEnergy,
    freeCapacity,
    energyCapacity,
    energyLoadRatio: roundRatio(carriedEnergy, energyCapacity),
    currentTask,
    currentTaskCode: CURRENT_TASK_CODE[currentTask] ?? CURRENT_TASK_CODE.none,
    ...numberField('roomEnergyAvailable', room?.energyAvailable),
    ...numberField('roomEnergyCapacity', room?.energyCapacityAvailable),
    workerCount: 0,
    spawnExtensionNeedCount,
    towerNeedCount,
    constructionSiteCount: constructionSites.length,
    repairTargetCount: countRepairTargets(structures),
    sourceCount: sources.length,
    hasContainerEnergy: containerCount > 0,
    containerEnergyAvailable: 0,
    droppedEnergyAvailable,
    nearbyRoadCount,
    nearbyContainerCount,
    roadCoverage: roundRatio(nearbyRoadCount, NEARBY_TILE_COUNT),
    hostileCreepCount: hostileCreeps.length,
    ...buildControllerState(controller)
  };
}

function buildPositionState(position: RoomPosition | undefined): Pick<WorkerTaskBehaviorStateMemory, 'x' | 'y'> {
  if (!position) {
    return {};
  }

  return {
    x: finiteNumber(position.x),
    y: finiteNumber(position.y)
  };
}

function buildControllerState(
  controller: StructureController | undefined
): Pick<
  WorkerTaskBehaviorStateMemory,
  'controllerLevel' | 'controllerTicksToDowngrade' | 'controllerProgressRatio'
> {
  if (!controller?.my) {
    return {};
  }

  const progress = finiteNumber(controller.progress);
  const progressTotal = finiteNumber(controller.progressTotal);
  return {
    ...numberField('controllerLevel', controller.level),
    ...numberField('controllerTicksToDowngrade', controller.ticksToDowngrade),
    ...(progress !== undefined && progressTotal !== undefined && progressTotal > 0
      ? { controllerProgressRatio: roundRatio(progress, progressTotal) }
      : {})
  };
}

function countRepairTargets(structures: AnyStructure[]): number {
  return structures.filter((structure) => {
    const hits = finiteNumber((structure as { hits?: unknown }).hits);
    const hitsMax = finiteNumber((structure as { hitsMax?: unknown }).hitsMax);
    if (hits === undefined || hitsMax === undefined || hits >= hitsMax) {
      return false;
    }

    return (
      isStructureType(structure, 'STRUCTURE_ROAD', 'road') ||
      isStructureType(structure, 'STRUCTURE_CONTAINER', 'container') ||
      (isStructureType(structure, 'STRUCTURE_RAMPART', 'rampart') &&
        (structure as { my?: unknown }).my !== false)
    );
  }).length;
}

function findRoomObjects<T>(room: Room | undefined, findConstant: number | undefined): T[] {
  if (!room || typeof room.find !== 'function' || typeof findConstant !== 'number') {
    return [];
  }

  try {
    const objects = room.find(findConstant as FindConstant) as unknown;
    return Array.isArray(objects) ? (objects as T[]) : [];
  } catch (_error) {
    return [];
  }
}

function getFindConstant(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getUsedEnergy(target: StoreOwner): number {
  const value = target.store?.getUsedCapacity?.(getEnergyResourceConstant());
  return Math.max(0, finiteNumber(value) ?? 0);
}

function getFreeEnergyCapacity(target: StoreOwner): number {
  const value = target.store?.getFreeCapacity?.(getEnergyResourceConstant());
  return Math.max(0, finiteNumber(value) ?? 0);
}

function getEnergyResourceConstant(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function sumDroppedEnergy(resources: Array<Resource<ResourceConstant>>): number {
  return resources.reduce((total, resource) => {
    if (resource.resourceType !== getEnergyResourceConstant()) {
      return total;
    }

    return total + Math.max(0, finiteNumber(resource.amount) ?? 0);
  }, 0);
}

function isStructureType(structure: { structureType?: unknown }, globalName: string, fallback: string): boolean {
  const globalValue = (globalThis as Record<string, unknown>)[globalName];
  return structure.structureType === globalValue || structure.structureType === fallback;
}

function getRangeBetweenRoomObjects(left: RoomObject, right: RoomObject): number {
  const range = left.pos?.getRangeTo?.(right);
  if (typeof range === 'number' && Number.isFinite(range)) {
    return range;
  }

  const leftPosition = left.pos;
  const rightPosition = right.pos;
  if (
    leftPosition &&
    rightPosition &&
    leftPosition.roomName === rightPosition.roomName &&
    typeof leftPosition.x === 'number' &&
    typeof leftPosition.y === 'number' &&
    typeof rightPosition.x === 'number' &&
    typeof rightPosition.y === 'number'
  ) {
    return Math.max(Math.abs(leftPosition.x - rightPosition.x), Math.abs(leftPosition.y - rightPosition.y));
  }

  return Number.MAX_SAFE_INTEGER;
}

function getGameTick(): number {
  const tick = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof tick === 'number' && Number.isFinite(tick) ? tick : 0;
}

function numberField<Key extends keyof WorkerTaskBehaviorStateMemory>(
  key: Key,
  value: unknown
): Pick<WorkerTaskBehaviorStateMemory, Key> {
  const number = finiteNumber(value);
  if (number === undefined) {
    return {} as Pick<WorkerTaskBehaviorStateMemory, Key>;
  }

  return { [key]: number } as Pick<WorkerTaskBehaviorStateMemory, Key>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function roundRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 1_000) / 1_000;
}
