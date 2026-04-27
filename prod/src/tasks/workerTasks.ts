// Low-downgrade safety floor: enough buffer for worker travel/recovery without treating healthy controllers as urgent.
export const CONTROLLER_DOWNGRADE_GUARD_TICKS = 5_000;
const MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
const MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 2;

export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);

  if (carriedEnergy === 0) {
    if (getFreeEnergyCapacity(creep) > 0) {
      const droppedEnergy = selectDroppedEnergy(creep);
      if (droppedEnergy) {
        return { type: 'pickup', targetId: droppedEnergy.id };
      }
    }

    const source = selectHarvestSource(creep);
    return source ? { type: 'harvest', targetId: source.id } : null;
  }

  const [energySink] = creep.room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });
  if (energySink) {
    return { type: 'transfer', targetId: energySink.id as Id<AnyStoreStructure> };
  }

  const controller = creep.room.controller;
  if (controller && shouldGuardControllerDowngrade(controller)) {
    return { type: 'upgrade', targetId: controller.id };
  }

  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const spawnConstructionSite = constructionSites.find(isSpawnConstructionSite);
  if (spawnConstructionSite) {
    return { type: 'build', targetId: spawnConstructionSite.id };
  }

  if (controller && shouldRushRcl1Controller(controller)) {
    return { type: 'upgrade', targetId: controller.id };
  }

  const extensionConstructionSite = constructionSites.find(isExtensionConstructionSite);
  if (extensionConstructionSite) {
    return { type: 'build', targetId: extensionConstructionSite.id };
  }

  if (controller && shouldSustainControllerProgress(creep, controller)) {
    return { type: 'upgrade', targetId: controller.id };
  }

  if (constructionSites[0]) {
    return { type: 'build', targetId: constructionSites[0].id };
  }

  if (controller?.my) {
    return { type: 'upgrade', targetId: controller.id };
  }

  return null;
}

function isFillableEnergySink(structure: AnyOwnedStructure): structure is StructureSpawn | StructureExtension {
  return (
    (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')) &&
    'store' in structure &&
    structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
  );
}

function isSpawnConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isExtensionConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_EXTENSION', 'extension');
}

type StructureConstantGlobal = 'STRUCTURE_SPAWN' | 'STRUCTURE_EXTENSION';

function matchesStructureType(actual: string | undefined, globalName: StructureConstantGlobal, fallback: string): boolean {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function shouldGuardControllerDowngrade(controller: StructureController | undefined): boolean {
  return (
    controller?.my === true &&
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS
  );
}

function shouldRushRcl1Controller(controller: StructureController): boolean {
  return controller.my === true && controller.level === 1;
}

function shouldSustainControllerProgress(creep: Creep, controller: StructureController): boolean {
  if (controller.my !== true || controller.level < 2) {
    return false;
  }

  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  return (
    loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS &&
    !loadedWorkers.some((worker) => worker !== creep && isUpgradingController(worker, controller))
  );
}

function getSameRoomLoadedWorkers(creep: Creep): Creep[] {
  const loadedWorkers = getGameCreeps().filter((candidate) => isSameRoomWorkerWithEnergy(candidate, creep.room));

  if (!loadedWorkers.includes(creep) && getUsedEnergy(creep) > 0) {
    loadedWorkers.push(creep);
  }

  return loadedWorkers;
}

function isSameRoomWorkerWithEnergy(creep: Creep, room: Room): boolean {
  return creep.memory?.role === 'worker' && isInRoom(creep, room) && getUsedEnergy(creep) > 0;
}

function isInRoom(creep: Creep, room: Room): boolean {
  if (typeof room.name === 'string' && room.name.length > 0) {
    return creep.room?.name === room.name;
  }

  return creep.room === room;
}

function getUsedEnergy(creep: Creep): number {
  return creep.store?.getUsedCapacity?.(RESOURCE_ENERGY) ?? 0;
}

function getFreeEnergyCapacity(creep: Creep): number {
  return creep.store?.getFreeCapacity?.(RESOURCE_ENERGY) ?? 0;
}

function isUpgradingController(creep: Creep, controller: StructureController): boolean {
  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'upgrade' && task.targetId === controller.id;
}

function selectDroppedEnergy(creep: Creep): Resource<RESOURCE_ENERGY> | null {
  const droppedEnergy = findDroppedResources(creep.room).filter(isUsefulDroppedEnergy);
  if (droppedEnergy.length === 0) {
    return null;
  }

  const closestDroppedEnergy = findClosestByRange(creep, droppedEnergy);
  return closestDroppedEnergy ?? droppedEnergy[0];
}

function findDroppedResources(room: Room): Resource[] {
  if (typeof FIND_DROPPED_RESOURCES !== 'number') {
    return [];
  }

  return room.find(FIND_DROPPED_RESOURCES);
}

function isUsefulDroppedEnergy(resource: Resource): resource is Resource<RESOURCE_ENERGY> {
  return resource.resourceType === RESOURCE_ENERGY && resource.amount >= MIN_DROPPED_ENERGY_PICKUP_AMOUNT;
}

function findClosestByRange(creep: Creep, resources: Resource<RESOURCE_ENERGY>[]): Resource<RESOURCE_ENERGY> | null {
  const position = (creep as Creep & {
    pos?: {
      findClosestByRange?: (objects: Resource<RESOURCE_ENERGY>[]) => Resource<RESOURCE_ENERGY> | null;
    };
  }).pos;

  return position?.findClosestByRange?.(resources) ?? null;
}

function selectHarvestSource(creep: Creep): Source | null {
  const sources = creep.room.find(FIND_SOURCES);
  if (sources.length === 0) {
    return null;
  }

  const assignmentCounts = countSameRoomWorkerHarvestAssignments(creep.room.name, sources);
  let selectedSource = sources[0];
  let selectedCount = assignmentCounts.get(selectedSource.id) ?? 0;

  // Ties intentionally keep room.find(FIND_SOURCES) order stable.
  for (const source of sources.slice(1)) {
    const count = assignmentCounts.get(source.id) ?? 0;
    if (count < selectedCount) {
      selectedSource = source;
      selectedCount = count;
    }
  }

  return selectedSource;
}

function countSameRoomWorkerHarvestAssignments(roomName: string | undefined, sources: Source[]): Map<Id<Source>, number> {
  const assignmentCounts = new Map<Id<Source>, number>();
  for (const source of sources) {
    assignmentCounts.set(source.id, 0);
  }

  if (!roomName) {
    return assignmentCounts;
  }

  const sourceIds = new Set(sources.map((source) => source.id as string));
  for (const assignedCreep of getGameCreeps()) {
    const task = assignedCreep.memory?.task as Partial<CreepTaskMemory> | undefined;
    const targetId = typeof task?.targetId === 'string' ? task.targetId : undefined;

    if (
      assignedCreep.memory?.role !== 'worker' ||
      assignedCreep.room?.name !== roomName ||
      task?.type !== 'harvest' ||
      !targetId ||
      !sourceIds.has(targetId)
    ) {
      continue;
    }

    const sourceId = targetId as Id<Source>;
    assignmentCounts.set(sourceId, (assignmentCounts.get(sourceId) ?? 0) + 1);
  }

  return assignmentCounts;
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return creeps ? Object.values(creeps) : [];
}
