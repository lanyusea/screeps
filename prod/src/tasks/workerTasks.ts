// Low-downgrade safety floor: enough buffer for worker travel/recovery without treating healthy controllers as urgent.
export const CONTROLLER_DOWNGRADE_GUARD_TICKS = 5_000;
export const CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO = 0.5;
export const IDLE_RAMPART_REPAIR_HITS_CEILING = 100_000;
const MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
const MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 2;

type RepairableWorkerStructure = StructureRoad | StructureContainer | StructureRampart;
type CriticalInfrastructureRepairTarget = StructureRoad | StructureContainer;
type StoredWorkerEnergySource = StructureContainer | StructureStorage | StructureTerminal;

interface StoredEnergySourceContext {
  creepOwnerUsername: string | null;
  hasHostilePresence: boolean;
  room: Room;
}

export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);

  if (carriedEnergy === 0) {
    if (getFreeEnergyCapacity(creep) > 0) {
      const droppedEnergy = selectDroppedEnergy(creep);
      if (droppedEnergy) {
        return { type: 'pickup', targetId: droppedEnergy.id };
      }

      const storedEnergy = selectStoredEnergySource(creep);
      if (storedEnergy) {
        return { type: 'withdraw', targetId: storedEnergy.id as Id<AnyStoreStructure> };
      }
    }

    const source = selectHarvestSource(creep);
    return source ? { type: 'harvest', targetId: source.id } : null;
  }

  const energySink = selectFillableEnergySink(creep);
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

  const roadOrContainerConstructionSite = constructionSites.find(isRoadOrContainerConstructionSite);
  if (roadOrContainerConstructionSite) {
    return { type: 'build', targetId: roadOrContainerConstructionSite.id };
  }

  if (controller && shouldSustainControllerProgress(creep, controller)) {
    return { type: 'upgrade', targetId: controller.id };
  }

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return { type: 'repair', targetId: criticalRepairTarget.id as Id<Structure> };
  }

  if (constructionSites[0]) {
    return { type: 'build', targetId: constructionSites[0].id };
  }

  const repairTarget = selectRepairTarget(creep);
  if (repairTarget) {
    return { type: 'repair', targetId: repairTarget.id as Id<Structure> };
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

function selectFillableEnergySink(creep: Creep): StructureSpawn | StructureExtension | null {
  const energySinks = creep.room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });

  if (energySinks.length === 0) {
    return null;
  }

  const closestEnergySink = findClosestByRange(creep, energySinks);
  return closestEnergySink ?? energySinks[0];
}

function isSpawnConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isExtensionConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_EXTENSION', 'extension');
}

function isRoadOrContainerConstructionSite(site: ConstructionSite): boolean {
  return (
    matchesStructureType(site.structureType, 'STRUCTURE_ROAD', 'road') ||
    matchesStructureType(site.structureType, 'STRUCTURE_CONTAINER', 'container')
  );
}

type StructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_ROAD'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL'
  | 'STRUCTURE_RAMPART';

function matchesStructureType(actual: string | undefined, globalName: StructureConstantGlobal, fallback: string): boolean {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function selectStoredEnergySource(creep: Creep): StoredWorkerEnergySource | null {
  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const storedEnergySources = findVisibleRoomStructures(creep.room).filter((structure): structure is StoredWorkerEnergySource =>
    isSafeStoredEnergySource(structure, context)
  );

  if (storedEnergySources.length === 0) {
    return null;
  }

  const closestStoredEnergy = findClosestByRange(creep, storedEnergySources);
  return closestStoredEnergy ?? storedEnergySources[0];
}

function isSafeStoredEnergySource(
  structure: AnyStructure,
  context: StoredEnergySourceContext
): structure is StoredWorkerEnergySource {
  return isStoredWorkerEnergySource(structure) && hasStoredEnergy(structure) && isFriendlyStoredEnergySource(structure, context);
}

function isStoredWorkerEnergySource(structure: AnyStructure): structure is StoredWorkerEnergySource {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_TERMINAL', 'terminal')
  );
}

function hasStoredEnergy(structure: StoredWorkerEnergySource): boolean {
  return (structure.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) > 0;
}

function isFriendlyStoredEnergySource(structure: StoredWorkerEnergySource, context: StoredEnergySourceContext): boolean {
  const ownership = (structure as StoredWorkerEnergySource & { my?: boolean }).my;
  if (typeof ownership === 'boolean') {
    return ownership;
  }

  if (context.room.controller?.my === true) {
    return true;
  }

  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') &&
    isRoomSafeForUnownedContainerWithdrawal(context)
  );
}

function isRoomSafeForUnownedContainerWithdrawal(context: StoredEnergySourceContext): boolean {
  if (context.hasHostilePresence) {
    return false;
  }

  const controller = context.room.controller;
  if (!controller) {
    return true;
  }

  if (controller.owner != null) {
    return false;
  }

  const reservationUsername = controller.reservation?.username;
  if (reservationUsername == null) {
    return true;
  }

  return reservationUsername === context.creepOwnerUsername;
}

function getCreepOwnerUsername(creep: Creep): string | null {
  const username = (creep as Creep & { owner?: { username?: string } }).owner?.username;
  return typeof username === 'string' && username.length > 0 ? username : null;
}

function hasVisibleHostilePresence(room: Room): boolean {
  return findHostileCreeps(room).length > 0 || findHostileStructures(room).length > 0;
}

function findHostileCreeps(room: Room): Creep[] {
  return typeof FIND_HOSTILE_CREEPS === 'number' ? room.find(FIND_HOSTILE_CREEPS) : [];
}

function findHostileStructures(room: Room): AnyStructure[] {
  return typeof FIND_HOSTILE_STRUCTURES === 'number' ? room.find(FIND_HOSTILE_STRUCTURES) : [];
}

function selectRepairTarget(creep: Creep): RepairableWorkerStructure | null {
  if (creep.room.controller?.my !== true) {
    return null;
  }

  const repairTargets = findVisibleRoomStructures(creep.room).filter(isSafeRepairTarget);
  if (repairTargets.length === 0) {
    return null;
  }

  return repairTargets.sort(compareRepairTargets)[0];
}

function selectCriticalInfrastructureRepairTarget(creep: Creep): CriticalInfrastructureRepairTarget | null {
  if (creep.room.controller?.my !== true) {
    return null;
  }

  const repairTargets = findVisibleRoomStructures(creep.room).filter(isCriticalInfrastructureRepairTarget);
  if (repairTargets.length === 0) {
    return null;
  }

  return repairTargets.sort(compareRepairTargets)[0];
}

function findVisibleRoomStructures(room: Room): AnyStructure[] {
  if (typeof FIND_STRUCTURES !== 'number') {
    return [];
  }

  return room.find(FIND_STRUCTURES);
}

function isSafeRepairTarget(structure: AnyStructure): structure is RepairableWorkerStructure {
  if (isWorkerRepairTargetComplete(structure)) {
    return false;
  }

  if (isRoadOrContainerRepairTarget(structure)) {
    return true;
  }

  return matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') && isOwnedRampart(structure);
}

function isCriticalInfrastructureRepairTarget(structure: AnyStructure): structure is CriticalInfrastructureRepairTarget {
  return (
    isSafeRepairTarget(structure) &&
    isRoadOrContainerRepairTarget(structure) &&
    getHitsRatio(structure) <= CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO
  );
}

function isRoadOrContainerRepairTarget(structure: AnyStructure): structure is StructureRoad | StructureContainer {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container')
  );
}

export function isWorkerRepairTargetComplete(structure: Structure): boolean {
  return structure.hits >= getWorkerRepairHitsCeiling(structure);
}

function getWorkerRepairHitsCeiling(structure: Structure): number {
  if (matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') && isOwnedRampart(structure)) {
    return Math.min(structure.hitsMax, IDLE_RAMPART_REPAIR_HITS_CEILING);
  }

  return structure.hitsMax;
}

function isOwnedRampart(structure: Structure): structure is StructureRampart {
  return (structure as Partial<StructureRampart>).my === true;
}

function compareRepairTargets(left: RepairableWorkerStructure, right: RepairableWorkerStructure): number {
  return (
    getRepairPriority(left) - getRepairPriority(right) ||
    getHitsRatio(left) - getHitsRatio(right) ||
    left.hits - right.hits ||
    String(left.id).localeCompare(String(right.id))
  );
}

function getRepairPriority(structure: RepairableWorkerStructure): number {
  if (matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road')) {
    return 0;
  }

  if (matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container')) {
    return 1;
  }

  return 2;
}

function getHitsRatio(structure: Structure): number {
  return structure.hitsMax > 0 ? structure.hits / structure.hitsMax : 1;
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

function findClosestByRange<T extends RoomObject>(creep: Creep, objects: T[]): T | null {
  if (objects.length === 0) {
    return null;
  }

  const position = (creep as Creep & {
    pos?: {
      findClosestByRange?: (objects: T[]) => T | null;
      getRangeTo?: (target: T) => number;
    };
  }).pos;

  if (typeof position?.getRangeTo === 'function') {
    return objects.reduce((closest, candidate) => {
      const closestRange = position.getRangeTo?.(closest) ?? Infinity;
      const candidateRange = position.getRangeTo?.(candidate) ?? Infinity;
      return candidateRange < closestRange ? candidate : closest;
    });
  }

  return typeof position?.findClosestByRange === 'function' ? position.findClosestByRange(objects) : null;
}

function selectHarvestSource(creep: Creep): Source | null {
  const sources = creep.room.find(FIND_SOURCES);
  if (sources.length === 0) {
    return null;
  }

  const viableSources = selectViableHarvestSources(sources);
  const assignmentCounts = countSameRoomWorkerHarvestAssignments(creep.room.name, viableSources);
  let selectedSource = viableSources[0];
  let selectedCount = assignmentCounts.get(selectedSource.id) ?? 0;

  // Ties intentionally keep room.find(FIND_SOURCES) order stable.
  for (const source of viableSources.slice(1)) {
    const count = assignmentCounts.get(source.id) ?? 0;
    if (count < selectedCount) {
      selectedSource = source;
      selectedCount = count;
    }
  }

  return selectedSource;
}

function selectViableHarvestSources(sources: Source[]): Source[] {
  const sourcesWithEnergy = sources.filter((source) => typeof source.energy === 'number' && source.energy > 0);
  return sourcesWithEnergy.length > 0 ? sourcesWithEnergy : sources;
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
