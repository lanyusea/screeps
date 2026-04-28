import {
  selectUrgentVisibleReservationRenewalTask,
  selectVisibleTerritoryControllerTask
} from '../territory/territoryPlanner';

// Low-downgrade safety floor: enough buffer for worker travel/recovery without treating healthy controllers as urgent.
export const CONTROLLER_DOWNGRADE_GUARD_TICKS = 5_000;
export const CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO = 0.5;
export const IDLE_RAMPART_REPAIR_HITS_CEILING = 100_000;
const MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
const MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 25;
const MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT = 2;
const ENERGY_ACQUISITION_RANGE_COST = 50;

type RepairableWorkerStructure = StructureRoad | StructureContainer | StructureRampart;
type CriticalInfrastructureRepairTarget = StructureRoad | StructureContainer;
type StoredWorkerEnergySource = StructureContainer | StructureStorage | StructureTerminal;
type SalvageableWorkerEnergySource = Tombstone | Ruin;
type FillableEnergySink = StructureSpawn | StructureExtension;
type WorkerEnergyAcquisitionSource =
  | StoredWorkerEnergySource
  | SalvageableWorkerEnergySource
  | Resource<ResourceConstant>;
type WorkerEnergyAcquisitionTask = Extract<CreepTaskMemory, { type: 'pickup' | 'withdraw' }>;

interface StoredEnergySourceContext {
  creepOwnerUsername: string | null;
  hasHostilePresence: boolean;
  room: Room;
}

export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  const carriedEnergy = getUsedEnergy(creep);
  const urgentReservationRenewalTask = selectUrgentVisibleReservationRenewalTask(creep);
  const territoryControllerTask = selectVisibleTerritoryControllerTask(creep);

  if (carriedEnergy === 0) {
    if (urgentReservationRenewalTask) {
      return urgentReservationRenewalTask;
    }

    if (isTerritoryControlTask(territoryControllerTask)) {
      return territoryControllerTask;
    }

    if (getFreeEnergyCapacity(creep) > 0) {
      const energyAcquisitionTask = selectWorkerEnergyAcquisitionTask(creep);
      if (energyAcquisitionTask) {
        return energyAcquisitionTask;
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

  if (urgentReservationRenewalTask) {
    return urgentReservationRenewalTask;
  }

  if (territoryControllerTask) {
    return territoryControllerTask;
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

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return { type: 'repair', targetId: criticalRepairTarget.id as Id<Structure> };
  }

  const roadOrContainerConstructionSite = constructionSites.find(isRoadOrContainerConstructionSite);
  if (roadOrContainerConstructionSite) {
    return { type: 'build', targetId: roadOrContainerConstructionSite.id };
  }

  if (controller && shouldUseSurplusForControllerProgress(creep, controller)) {
    return { type: 'upgrade', targetId: controller.id };
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

function isTerritoryControlTask(task: CreepTaskMemory | null): task is Extract<CreepTaskMemory, { type: 'claim' | 'reserve' }> {
  return task?.type === 'claim' || task?.type === 'reserve';
}

function isFillableEnergySink(structure: AnyOwnedStructure): structure is FillableEnergySink {
  return (
    (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')) &&
    'store' in structure &&
    getFreeStoredEnergyCapacity(structure) > 0
  );
}

function selectFillableEnergySink(creep: Creep): FillableEnergySink | null {
  const energySinks = creep.room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });

  const spawn = selectClosestEnergySink(creep, energySinks.filter(isSpawnEnergySink));
  if (spawn) {
    return spawn;
  }

  return selectClosestEnergySink(creep, energySinks.filter(isExtensionEnergySink));
}

function isSpawnEnergySink(structure: FillableEnergySink): structure is StructureSpawn {
  return matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isExtensionEnergySink(structure: FillableEnergySink): structure is StructureExtension {
  return matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension');
}

function selectClosestEnergySink<T extends FillableEnergySink>(creep: Creep, energySinks: T[]): T | null {
  if (energySinks.length === 0) {
    return null;
  }

  const energySinksByStableId = [...energySinks].sort(compareEnergySinkId);
  const position = (creep as Creep & {
    pos?: {
      findClosestByRange?: (objects: T[]) => T | null;
      getRangeTo?: (target: T) => number;
    };
  }).pos;

  if (typeof position?.getRangeTo === 'function') {
    return energySinksByStableId.reduce((closest, candidate) => {
      const closestRange = position.getRangeTo?.(closest) ?? Infinity;
      const candidateRange = position.getRangeTo?.(candidate) ?? Infinity;
      return candidateRange < closestRange ||
        (candidateRange === closestRange && compareEnergySinkId(candidate, closest) < 0)
        ? candidate
        : closest;
    });
  }

  if (typeof position?.findClosestByRange === 'function') {
    return position.findClosestByRange(energySinksByStableId) ?? energySinksByStableId[0];
  }

  return energySinksByStableId[0];
}

function compareEnergySinkId(left: FillableEnergySink, right: FillableEnergySink): number {
  return String(left.id).localeCompare(String(right.id));
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

  const scoredStoredEnergy = scoreStoredEnergySources(creep, storedEnergySources);
  if (scoredStoredEnergy.length > 0) {
    return scoredStoredEnergy.sort(compareStoredEnergySourceScores)[0].source;
  }

  const closestStoredEnergy = findClosestByRange(creep, storedEnergySources);
  return closestStoredEnergy ?? storedEnergySources[0];
}

interface StoredEnergySourceScore {
  energy: number;
  range: number;
  score: number;
  source: StoredWorkerEnergySource;
}

function scoreStoredEnergySources(
  creep: Creep,
  sources: StoredWorkerEnergySource[]
): StoredEnergySourceScore[] {
  const position = (creep as Creep & { pos?: { getRangeTo?: (target: StoredWorkerEnergySource) => number } }).pos;
  if (typeof position?.getRangeTo !== 'function') {
    return [];
  }

  return sources.map((source) => {
    const energy = getStoredEnergy(source);
    const range = Math.max(0, position.getRangeTo?.(source) ?? 0);

    return {
      energy,
      range,
      score: energy - range * ENERGY_ACQUISITION_RANGE_COST,
      source
    };
  });
}

function compareStoredEnergySourceScores(left: StoredEnergySourceScore, right: StoredEnergySourceScore): number {
  return (
    right.score - left.score ||
    left.range - right.range ||
    right.energy - left.energy ||
    String(left.source.id).localeCompare(String(right.source.id))
  );
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
  return getStoredEnergy(structure) > 0;
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

interface WorkerEnergyAcquisitionCandidate {
  energy: number;
  range: number | null;
  score: number;
  source: WorkerEnergyAcquisitionSource;
  task: WorkerEnergyAcquisitionTask;
}

function selectWorkerEnergyAcquisitionTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}

function findWorkerEnergyAcquisitionCandidates(creep: Creep): WorkerEnergyAcquisitionCandidate[] {
  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const storedEnergyCandidates = findVisibleRoomStructures(creep.room)
    .filter((structure): structure is StoredWorkerEnergySource => isSafeStoredEnergySource(structure, context))
    .map((source) =>
      createWorkerEnergyAcquisitionCandidate(creep, source, getStoredEnergy(source), {
        type: 'withdraw',
        targetId: source.id as Id<AnyStoreStructure>
      })
    );
  const salvageEnergyCandidates = [...findTombstones(creep.room), ...findRuins(creep.room)]
    .filter(hasSalvageableEnergy)
    .map((source) =>
      createWorkerEnergyAcquisitionCandidate(creep, source, getStoredEnergy(source), {
        type: 'withdraw',
        targetId: source.id as unknown as Id<AnyStoreStructure>
      })
    );
  const droppedEnergyCandidates = findDroppedResources(creep.room)
    .filter(isUsefulDroppedEnergy)
    .map((source) =>
      createWorkerEnergyAcquisitionCandidate(creep, source, source.amount, {
        type: 'pickup',
        targetId: source.id
      })
    );

  return [...storedEnergyCandidates, ...salvageEnergyCandidates, ...droppedEnergyCandidates];
}

function createWorkerEnergyAcquisitionCandidate(
  creep: Creep,
  source: WorkerEnergyAcquisitionSource,
  energy: number,
  task: WorkerEnergyAcquisitionTask
): WorkerEnergyAcquisitionCandidate {
  const range = getRangeToWorkerEnergyAcquisitionSource(creep, source);

  return {
    energy,
    range,
    score: range === null ? energy : energy - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task
  };
}

function getRangeToWorkerEnergyAcquisitionSource(
  creep: Creep,
  source: WorkerEnergyAcquisitionSource
): number | null {
  const position = (creep as Creep & {
    pos?: {
      getRangeTo?: (target: WorkerEnergyAcquisitionSource) => number;
    };
  }).pos;
  if (typeof position?.getRangeTo !== 'function') {
    return null;
  }

  const range = position.getRangeTo(source);
  return Number.isFinite(range) ? Math.max(0, range) : null;
}

function compareWorkerEnergyAcquisitionCandidates(
  left: WorkerEnergyAcquisitionCandidate,
  right: WorkerEnergyAcquisitionCandidate
): number {
  return (
    right.score - left.score ||
    compareOptionalRanges(left.range, right.range) ||
    right.energy - left.energy ||
    String(left.source.id).localeCompare(String(right.source.id)) ||
    left.task.type.localeCompare(right.task.type)
  );
}

function compareOptionalRanges(left: number | null, right: number | null): number {
  if (left !== null && right !== null) {
    return left - right;
  }

  if (left !== null) {
    return -1;
  }

  if (right !== null) {
    return 1;
  }

  return 0;
}

function selectSalvageEnergySource(creep: Creep): SalvageableWorkerEnergySource | null {
  const salvageEnergySources = [...findTombstones(creep.room), ...findRuins(creep.room)].filter(hasSalvageableEnergy);
  if (salvageEnergySources.length === 0) {
    return null;
  }

  const closestSalvageEnergy = findClosestByRange(creep, salvageEnergySources);
  return closestSalvageEnergy ?? salvageEnergySources[0];
}

function findTombstones(room: Room): Tombstone[] {
  if (typeof FIND_TOMBSTONES !== 'number') {
    return [];
  }

  return room.find(FIND_TOMBSTONES);
}

function findRuins(room: Room): Ruin[] {
  if (typeof FIND_RUINS !== 'number') {
    return [];
  }

  return room.find(FIND_RUINS);
}

function hasSalvageableEnergy(source: SalvageableWorkerEnergySource): boolean {
  return getStoredEnergy(source) >= MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT;
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

function shouldUseSurplusForControllerProgress(creep: Creep, controller: StructureController): boolean {
  if (shouldSustainControllerProgress(creep, controller)) {
    return true;
  }

  return controller.my === true && controller.level >= 2 && hasWithdrawableSurplusEnergy(creep);
}

function hasWithdrawableSurplusEnergy(creep: Creep): boolean {
  return selectStoredEnergySource(creep) !== null || selectSalvageEnergySource(creep) !== null;
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
  return getStoredEnergy(creep);
}

function getFreeEnergyCapacity(creep: Creep): number {
  return getFreeStoredEnergyCapacity(creep);
}

interface StoreLike {
  getUsedCapacity?: (resource?: ResourceConstant) => number | null;
  getFreeCapacity?: (resource?: ResourceConstant) => number | null;
  [resource: string]: unknown;
}

function getStoredEnergy(object: unknown): number {
  const store = getStore(object);
  if (!store) {
    return 0;
  }

  const usedCapacity = store.getUsedCapacity?.(getWorkerEnergyResource());
  if (typeof usedCapacity === 'number') {
    return usedCapacity;
  }

  const storedEnergy = store[getWorkerEnergyResource()];
  return typeof storedEnergy === 'number' ? storedEnergy : 0;
}

function getFreeStoredEnergyCapacity(object: unknown): number {
  const store = getStore(object);
  if (!store) {
    return 0;
  }

  const freeCapacity = store.getFreeCapacity?.(getWorkerEnergyResource());
  return typeof freeCapacity === 'number' ? freeCapacity : 0;
}

function getStore(object: unknown): StoreLike | null {
  if (!isWorkerTaskRecord(object) || !isWorkerTaskRecord(object.store)) {
    return null;
  }

  return object.store as StoreLike;
}

function getWorkerEnergyResource(): ResourceConstant {
  const value = (globalThis as unknown as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
  return (typeof value === 'string' ? value : 'energy') as ResourceConstant;
}

function isWorkerTaskRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUpgradingController(creep: Creep, controller: StructureController): boolean {
  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'upgrade' && task.targetId === controller.id;
}

function findDroppedResources(room: Room): Resource[] {
  if (typeof FIND_DROPPED_RESOURCES !== 'number') {
    return [];
  }

  return room.find(FIND_DROPPED_RESOURCES);
}

function isUsefulDroppedEnergy(resource: Resource): resource is Resource<ResourceConstant> {
  return resource.resourceType === getWorkerEnergyResource() && resource.amount >= MIN_DROPPED_ENERGY_PICKUP_AMOUNT;
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
