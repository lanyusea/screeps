import {
  hasActiveTerritoryFollowUpPreparationDemand,
  selectUrgentVisibleReservationRenewalTask,
  selectVisibleTerritoryControllerTask
} from '../territory/territoryPlanner';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';

// Low-downgrade safety floor: enough buffer for worker travel/recovery without treating healthy controllers as urgent.
export const CONTROLLER_DOWNGRADE_GUARD_TICKS = 5_000;
export const CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO = 0.5;
export const IDLE_RAMPART_REPAIR_HITS_CEILING = 100_000;
export const TOWER_REFILL_ENERGY_FLOOR = 500;
export const URGENT_SPAWN_REFILL_ENERGY_THRESHOLD = 200;
export const NEAR_TERM_SPAWN_EXTENSION_REFILL_RESERVE_TICKS = 50;
const MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
const MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE = 1;
const MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 25;
const MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT = 2;
const ENERGY_ACQUISITION_RANGE_COST = 50;
const ENERGY_ACQUISITION_ACTION_TICKS = 1;
const HARVEST_ENERGY_PER_WORK_PART = 2;
const MAX_DROPPED_ENERGY_REACHABILITY_CHECKS = 5;

type RepairableWorkerStructure = StructureRoad | StructureContainer | StructureRampart;
type CriticalInfrastructureRepairTarget = StructureRoad | StructureContainer;
type StoredWorkerEnergySource = StructureContainer | StructureStorage | StructureTerminal;
type SalvageableWorkerEnergySource = Tombstone | Ruin;
type FillableEnergySink = StructureSpawn | StructureExtension | StructureTower;
type SpawnExtensionEnergyStructure = StructureSpawn | StructureExtension;
type WorkerEnergyAcquisitionSource =
  | StoredWorkerEnergySource
  | SalvageableWorkerEnergySource
  | Resource<ResourceConstant>;
type WorkerEnergyAcquisitionTask = Extract<CreepTaskMemory, { type: 'pickup' | 'withdraw' }>;
type ProductiveEnergySinkTask = Extract<CreepTaskMemory, { type: 'build' | 'repair' }>;

interface StoredEnergySourceContext {
  creepOwnerUsername: string | null;
  hasHostilePresence: boolean;
  room: Room;
}

interface NearTermSpawnExtensionRefillReserveContext {
  refillReserve: number;
  room: Room;
  sortedLoadedWorkers: Creep[];
  spawnExtensionEnergyStructures: SpawnExtensionEnergyStructure[];
}

interface NearTermSpawnExtensionRefillReserveCache {
  roomsByName: Map<string, NearTermSpawnExtensionRefillReserveContext>;
  tick: number;
}

let nearTermSpawnExtensionRefillReserveCache: NearTermSpawnExtensionRefillReserveCache | null = null;

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
      const spawnRecoveryEnergySink = selectFillableEnergySink(creep);
      if (spawnRecoveryEnergySink) {
        const spawnRecoveryTask = selectSpawnRecoveryEnergyAcquisitionTask(creep, spawnRecoveryEnergySink);
        if (spawnRecoveryTask) {
          return spawnRecoveryTask;
        }
      } else {
        const energyAcquisitionTask = selectWorkerEnergyAcquisitionTask(creep);
        if (energyAcquisitionTask) {
          return energyAcquisitionTask;
        }
      }
    }

    const source = selectHarvestSource(creep);
    return source ? { type: 'harvest', targetId: source.id } : null;
  }

  if (urgentReservationRenewalTask) {
    return urgentReservationRenewalTask;
  }

  if (isTerritoryControlTask(territoryControllerTask)) {
    return territoryControllerTask;
  }

  const controller = creep.room.controller;
  if (controller && shouldGuardControllerDowngrade(controller)) {
    return { type: 'upgrade', targetId: controller.id };
  }

  const spawnOrExtensionEnergySink = selectSpawnOrExtensionEnergySink(creep);
  if (spawnOrExtensionEnergySink) {
    return { type: 'transfer', targetId: spawnOrExtensionEnergySink.id as Id<AnyStoreStructure> };
  }

  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const capacityConstructionSite = selectCapacityEnablingConstructionSite(creep, constructionSites, controller);
  if (capacityConstructionSite && !territoryControllerTask) {
    return { type: 'build', targetId: capacityConstructionSite.id };
  }

  const priorityTowerEnergySink = selectPriorityTowerEnergySink(creep);
  if (priorityTowerEnergySink) {
    return { type: 'transfer', targetId: priorityTowerEnergySink.id as Id<AnyStoreStructure> };
  }

  const readyFollowUpProductiveEnergySinkTask = selectReadyFollowUpProductiveEnergySinkTask(
    creep,
    capacityConstructionSite,
    controller
  );
  if (readyFollowUpProductiveEnergySinkTask) {
    return readyFollowUpProductiveEnergySinkTask;
  }

  if (territoryControllerTask) {
    return territoryControllerTask;
  }

  if (capacityConstructionSite) {
    return { type: 'build', targetId: capacityConstructionSite.id };
  }

  if (controller && shouldRushRcl1Controller(controller)) {
    return { type: 'upgrade', targetId: controller.id };
  }

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return { type: 'repair', targetId: criticalRepairTarget.id as Id<Structure> };
  }

  if (shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)) {
    return null;
  }

  const containerConstructionSite = selectConstructionSite(creep, constructionSites, isContainerConstructionSite);
  if (containerConstructionSite) {
    return { type: 'build', targetId: containerConstructionSite.id };
  }

  const roadConstructionSite = selectConstructionSite(creep, constructionSites, isRoadConstructionSite);
  if (roadConstructionSite) {
    return { type: 'build', targetId: roadConstructionSite.id };
  }

  if (controller && shouldUseSurplusForControllerProgress(creep, controller)) {
    const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(creep, constructionSites, controller);
    if (productiveEnergySinkTask) {
      return productiveEnergySinkTask;
    }

    return { type: 'upgrade', targetId: controller.id };
  }

  const constructionSite = selectConstructionSite(creep, constructionSites);
  if (constructionSite) {
    return { type: 'build', targetId: constructionSite.id };
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

export function estimateNearTermSpawnExtensionRefillReserve(room: Room): number {
  const spawnExtensionEnergyStructures = findSpawnExtensionEnergyStructures(room);
  return estimateNearTermSpawnExtensionRefillReserveFromStructures(room, spawnExtensionEnergyStructures);
}

function estimateNearTermSpawnExtensionRefillReserveFromStructures(
  room: Room,
  spawnExtensionEnergyStructures: SpawnExtensionEnergyStructure[]
): number {
  if (spawnExtensionEnergyStructures.length === 0) {
    return 0;
  }

  const roomRefillShortfall = estimateRoomEnergyRefillShortfall(room);
  const immediateRefillCapacity = spawnExtensionEnergyStructures.reduce(
    (total, structure) => total + getFreeStoredEnergyCapacity(structure),
    0
  );
  const immediateRefillReserve =
    roomRefillShortfall === null ? immediateRefillCapacity : Math.min(immediateRefillCapacity, roomRefillShortfall);

  return Math.max(
    immediateRefillReserve,
    estimateNearTermSpawnCompletionRefillReserve(room, spawnExtensionEnergyStructures)
  );
}

function estimateNearTermSpawnCompletionRefillReserve(
  room: Room,
  spawnExtensionEnergyStructures: SpawnExtensionEnergyStructure[]
): number {
  if (!spawnExtensionEnergyStructures.some(isNearTermSpawningSpawn)) {
    return 0;
  }

  return Math.max(0, getRoomEnergyCapacityAvailable(room) ?? 0);
}

function isTerritoryControlTask(task: CreepTaskMemory | null): task is Extract<CreepTaskMemory, { type: 'claim' | 'reserve' }> {
  return task?.type === 'claim' || task?.type === 'reserve';
}

function isFillableEnergySink(structure: AnyOwnedStructure): structure is FillableEnergySink {
  return (
    (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower')) &&
    'store' in structure &&
    getFreeStoredEnergyCapacity(structure) > 0
  );
}

function selectFillableEnergySink(creep: Creep): FillableEnergySink | null {
  return selectSpawnOrExtensionEnergySink(creep) ?? selectPriorityTowerEnergySink(creep);
}

function selectSpawnOrExtensionEnergySink(creep: Creep): StructureSpawn | StructureExtension | null {
  const energySinks = findFillableEnergySinks(creep).filter(isSpawnOrExtensionEnergySink);
  if (energySinks.length === 0) {
    return null;
  }

  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  return selectClosestEnergySink(
    energySinks.filter((energySink) => hasUnreservedEnergySinkCapacity(energySink, creep, loadedWorkers)),
    creep
  );
}

function selectPriorityTowerEnergySink(creep: Creep): StructureTower | null {
  return selectClosestEnergySink(findFillableEnergySinks(creep).filter(isPriorityTowerEnergySink), creep);
}

function hasUnreservedEnergySinkCapacity(
  energySink: SpawnExtensionEnergyStructure,
  creep: Creep,
  loadedWorkers: Creep[]
): boolean {
  return getReservedEnergyDelivery(energySink, creep, loadedWorkers) < getFreeStoredEnergyCapacity(energySink);
}

function getReservedEnergyDelivery(
  energySink: SpawnExtensionEnergyStructure,
  creep: Creep,
  loadedWorkers: Creep[]
): number {
  const energySinkId = String(energySink.id);
  return loadedWorkers
    .filter((candidate) => !isSameCreep(candidate, creep))
    .reduce((reservedEnergy, worker) => {
      const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
      return task?.type === 'transfer' && String(task.targetId) === energySinkId
        ? reservedEnergy + getUsedEnergy(worker)
        : reservedEnergy;
    }, 0);
}

function findFillableEnergySinks(creep: Creep): FillableEnergySink[] {
  const energySinks = creep.room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });

  return energySinks;
}

function findSpawnExtensionEnergyStructures(room: Room): SpawnExtensionEnergyStructure[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return room
    .find(FIND_MY_STRUCTURES)
    .filter((structure): structure is SpawnExtensionEnergyStructure => isSpawnExtensionEnergyStructure(structure));
}

function isSpawnExtensionEnergyStructure(structure: AnyOwnedStructure): structure is SpawnExtensionEnergyStructure {
  return (
    (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')) &&
    'store' in structure
  );
}

function isSpawnEnergySink(structure: FillableEnergySink): structure is StructureSpawn {
  return matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isNearTermSpawningSpawn(structure: SpawnExtensionEnergyStructure): structure is StructureSpawn {
  if (!matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return false;
  }

  const remainingTime = ((structure as StructureSpawn).spawning as Spawning | null | undefined)?.remainingTime;
  return (
    typeof remainingTime === 'number' &&
    remainingTime > 0 &&
    remainingTime <= NEAR_TERM_SPAWN_EXTENSION_REFILL_RESERVE_TICKS
  );
}

function isSpawnOrExtensionEnergySink(structure: FillableEnergySink): structure is StructureSpawn | StructureExtension {
  return isSpawnEnergySink(structure) || isExtensionEnergySink(structure);
}

function isExtensionEnergySink(structure: FillableEnergySink): structure is StructureExtension {
  return matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension');
}

function isTowerEnergySink(structure: FillableEnergySink): structure is StructureTower {
  return matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower');
}

function isPriorityTowerEnergySink(structure: FillableEnergySink): structure is StructureTower {
  return isTowerEnergySink(structure) && getStoredEnergy(structure) < TOWER_REFILL_ENERGY_FLOOR;
}

function selectClosestEnergySink<T extends FillableEnergySink>(energySinks: T[], creep: Creep): T | null {
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

function selectConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  predicate: (site: ConstructionSite) => boolean = () => true
): ConstructionSite | null {
  const candidates = constructionSites.filter(predicate);
  if (candidates.length === 0) {
    return null;
  }

  const position = (creep as Creep & {
    pos?: {
      findClosestByRange?: (objects: ConstructionSite[]) => ConstructionSite | null;
      getRangeTo?: (target: ConstructionSite) => number;
    };
  }).pos;

  if (typeof position?.getRangeTo === 'function') {
    return [...candidates].sort(compareConstructionSiteId).reduce((closest, candidate) => {
      const closestRange = position.getRangeTo?.(closest) ?? Infinity;
      const candidateRange = position.getRangeTo?.(candidate) ?? Infinity;
      return candidateRange < closestRange ||
        (candidateRange === closestRange && compareConstructionSiteId(candidate, closest) < 0)
        ? candidate
        : closest;
    });
  }

  if (typeof position?.findClosestByRange === 'function') {
    const candidatesByStableId = [...candidates].sort(compareConstructionSiteId);
    return position.findClosestByRange(candidatesByStableId) ?? candidatesByStableId[0];
  }

  return candidates[0];
}

function compareConstructionSiteId(left: ConstructionSite, right: ConstructionSite): number {
  return String(left.id).localeCompare(String(right.id));
}

function selectNearbyProductiveEnergySinkTask(
  creep: Creep,
  constructionSites: ConstructionSite[],
  controller: StructureController
): ProductiveEnergySinkTask | null {
  const controllerRange = getRangeBetweenRoomObjects(creep, controller);
  if (controllerRange === null) {
    return null;
  }

  const candidates = [
    ...constructionSites.map((site) =>
      createProductiveEnergySinkCandidate(creep, site, { type: 'build', targetId: site.id }, 0)
    ),
    ...findVisibleRoomStructures(creep.room)
      .filter(isSafeRepairTarget)
      .map((structure) =>
        createProductiveEnergySinkCandidate(
          creep,
          structure,
          { type: 'repair', targetId: structure.id as Id<Structure> },
          1
        )
      )
  ].filter(
    (candidate): candidate is ProductiveEnergySinkCandidate =>
      candidate !== null && candidate.range <= controllerRange
  );

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareProductiveEnergySinkCandidates)[0].task;
}

function createProductiveEnergySinkCandidate(
  creep: Creep,
  target: ConstructionSite | RepairableWorkerStructure,
  task: ProductiveEnergySinkTask,
  taskPriority: number
): ProductiveEnergySinkCandidate | null {
  const range = getRangeBetweenRoomObjects(creep, target);
  if (range === null) {
    return null;
  }

  return { range, task, taskPriority };
}

function compareProductiveEnergySinkCandidates(
  left: ProductiveEnergySinkCandidate,
  right: ProductiveEnergySinkCandidate
): number {
  return (
    left.range - right.range ||
    left.taskPriority - right.taskPriority ||
    String(left.task.targetId).localeCompare(String(right.task.targetId))
  );
}

function selectCapacityEnablingConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  controller: StructureController | undefined
): ConstructionSite | null {
  const spawnConstructionSite = selectConstructionSite(creep, constructionSites, isSpawnConstructionSite);
  if (spawnConstructionSite) {
    return spawnConstructionSite;
  }

  if (controller && shouldRushRcl1Controller(controller)) {
    return null;
  }

  return selectConstructionSite(creep, constructionSites, isExtensionConstructionSite);
}

function selectReadyFollowUpProductiveEnergySinkTask(
  creep: Creep,
  capacityConstructionSite: ConstructionSite | null,
  controller: StructureController | undefined
): ProductiveEnergySinkTask | null {
  if (!hasReadyTerritoryFollowUpEnergy(creep)) {
    return null;
  }

  if (capacityConstructionSite) {
    return { type: 'build', targetId: capacityConstructionSite.id };
  }

  if (controller && shouldRushRcl1Controller(controller)) {
    return null;
  }

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  return criticalRepairTarget ? { type: 'repair', targetId: criticalRepairTarget.id as Id<Structure> } : null;
}

function isSpawnConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isExtensionConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_EXTENSION', 'extension');
}

function isContainerConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_CONTAINER', 'container');
}

function isRoadConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_ROAD', 'road');
}

type StructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_TOWER'
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

interface SpawnRecoveryEnergyAcquisitionCandidate extends WorkerEnergyAcquisitionCandidate {
  deliveryEta: number;
}

interface ProductiveEnergySinkCandidate {
  range: number;
  task: ProductiveEnergySinkTask;
  taskPriority: number;
}

function selectWorkerEnergyAcquisitionTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}

function selectSpawnRecoveryEnergyAcquisitionTask(
  creep: Creep,
  energySink: FillableEnergySink
): WorkerEnergyAcquisitionTask | null {
  const harvestEta = estimateHarvestDeliveryEta(creep, energySink);
  const candidates = findWorkerEnergyAcquisitionCandidates(creep)
    .map((candidate) => createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink))
    .filter((candidate): candidate is SpawnRecoveryEnergyAcquisitionCandidate => candidate !== null)
    .filter((candidate) => harvestEta === null || candidate.deliveryEta <= harvestEta);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareSpawnRecoveryEnergyAcquisitionCandidates)[0].task;
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
  const droppedEnergyCandidates = findDroppedEnergyAcquisitionCandidates(creep);

  return [...storedEnergyCandidates, ...salvageEnergyCandidates, ...droppedEnergyCandidates];
}

function findDroppedEnergyAcquisitionCandidates(creep: Creep): WorkerEnergyAcquisitionCandidate[] {
  return findDroppedResources(creep.room)
    .filter(isUsefulDroppedEnergy)
    .map((source) =>
      createWorkerEnergyAcquisitionCandidate(creep, source, source.amount, {
        type: 'pickup',
        targetId: source.id
      })
    )
    .sort(compareDroppedEnergyReachabilityPriority)
    .slice(0, MAX_DROPPED_ENERGY_REACHABILITY_CHECKS)
    .filter((candidate) => isReachable(creep, candidate.source));
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

function createSpawnRecoveryEnergyAcquisitionCandidate(
  candidate: WorkerEnergyAcquisitionCandidate,
  energySink: FillableEnergySink
): SpawnRecoveryEnergyAcquisitionCandidate | null {
  if (candidate.range === null) {
    return null;
  }

  const sourceToSinkRange = getRangeBetweenRoomObjects(candidate.source, energySink);
  if (sourceToSinkRange === null) {
    return null;
  }

  return {
    ...candidate,
    deliveryEta: candidate.range + ENERGY_ACQUISITION_ACTION_TICKS + sourceToSinkRange
  };
}

function estimateHarvestDeliveryEta(creep: Creep, energySink: FillableEnergySink): number | null {
  const source = selectHarvestSource(creep);
  if (!source) {
    return null;
  }

  const sourceAvailabilityDelay = estimateHarvestSourceAvailabilityDelay(source);
  if (sourceAvailabilityDelay === null) {
    return null;
  }

  const creepToSourceRange = getRangeBetweenRoomObjects(creep, source);
  const sourceToSinkRange = getRangeBetweenRoomObjects(source, energySink);
  if (creepToSourceRange === null || sourceToSinkRange === null) {
    return null;
  }

  return creepToSourceRange + sourceAvailabilityDelay + estimateHarvestTicks(creep, energySink) + sourceToSinkRange;
}

function estimateHarvestTicks(creep: Creep, energySink: FillableEnergySink): number {
  const energyNeeded = Math.max(1, Math.min(getFreeEnergyCapacity(creep), getFreeStoredEnergyCapacity(energySink)));
  const workParts = getActiveWorkParts(creep);
  if (workParts === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.ceil(energyNeeded / Math.max(HARVEST_ENERGY_PER_WORK_PART, workParts * HARVEST_ENERGY_PER_WORK_PART));
}

function estimateHarvestSourceAvailabilityDelay(source: Source): number | null {
  if (typeof source.energy !== 'number') {
    return 0;
  }

  if (source.energy > 0) {
    return 0;
  }

  const ticksToRegeneration = source.ticksToRegeneration;
  return Number.isFinite(ticksToRegeneration) && ticksToRegeneration > 0 ? Math.ceil(ticksToRegeneration) : null;
}

function getActiveWorkParts(creep: Creep): number {
  const workPart = (globalThis as unknown as { WORK?: BodyPartConstant }).WORK;
  if (typeof workPart !== 'string' || typeof creep.getActiveBodyparts !== 'function') {
    return 1;
  }

  const activeWorkParts = creep.getActiveBodyparts(workPart);
  if (activeWorkParts === 0) {
    return 0;
  }

  return Number.isFinite(activeWorkParts) && activeWorkParts > 0 ? activeWorkParts : 1;
}

function getRangeBetweenRoomObjects(left: RoomObject, right: RoomObject): number | null {
  const position = (left as RoomObject & {
    pos?: {
      getRangeTo?: (target: RoomObject) => number;
    };
  }).pos;
  if (typeof position?.getRangeTo !== 'function') {
    return null;
  }

  const range = position.getRangeTo(right);
  return Number.isFinite(range) ? Math.max(0, range) : null;
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

function isReachable(creep: Creep, target: RoomObject): boolean {
  const position = (creep as Creep & {
    pos?: {
      findPathTo?: (target: RoomObject, opts?: { ignoreCreeps?: boolean }) => unknown[];
    };
  }).pos;
  if (typeof position?.findPathTo !== 'function') {
    return true;
  }

  const range = getRangeBetweenRoomObjects(creep, target);
  if (range !== null && range <= 1) {
    return true;
  }

  const path = position.findPathTo(target, { ignoreCreeps: true });
  return Array.isArray(path) && path.length > 0;
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

function compareDroppedEnergyReachabilityPriority(
  left: WorkerEnergyAcquisitionCandidate,
  right: WorkerEnergyAcquisitionCandidate
): number {
  return (
    compareOptionalRanges(left.range, right.range) ||
    right.energy - left.energy ||
    right.score - left.score ||
    String(left.source.id).localeCompare(String(right.source.id))
  );
}

function compareSpawnRecoveryEnergyAcquisitionCandidates(
  left: SpawnRecoveryEnergyAcquisitionCandidate,
  right: SpawnRecoveryEnergyAcquisitionCandidate
): number {
  return (
    left.deliveryEta - right.deliveryEta ||
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

export function shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep: Creep): boolean {
  const carriedEnergy = getUsedEnergy(creep);
  if (carriedEnergy <= 0) {
    return false;
  }

  const reserveContext = getNearTermSpawnExtensionRefillReserveContext(creep.room);
  return (
    reserveContext.refillReserve > 0 &&
    isWorkerEnergyNeededForNearTermSpawnExtensionRefillReserve(creep, reserveContext)
  );
}

function getNearTermSpawnExtensionRefillReserveContext(room: Room): NearTermSpawnExtensionRefillReserveContext {
  const gameTick = getGameTick();
  const roomName = getRoomName(room);
  if (gameTick === null || roomName === null) {
    return createNearTermSpawnExtensionRefillReserveContext(room);
  }

  if (!nearTermSpawnExtensionRefillReserveCache || nearTermSpawnExtensionRefillReserveCache.tick !== gameTick) {
    nearTermSpawnExtensionRefillReserveCache = {
      roomsByName: new Map<string, NearTermSpawnExtensionRefillReserveContext>(),
      tick: gameTick
    };
  }

  const cachedContext = nearTermSpawnExtensionRefillReserveCache.roomsByName.get(roomName);
  if (cachedContext?.room === room) {
    return cachedContext;
  }

  const context = createNearTermSpawnExtensionRefillReserveContext(room);
  nearTermSpawnExtensionRefillReserveCache.roomsByName.set(roomName, context);
  return context;
}

function createNearTermSpawnExtensionRefillReserveContext(
  room: Room
): NearTermSpawnExtensionRefillReserveContext {
  const spawnExtensionEnergyStructures = findSpawnExtensionEnergyStructures(room);
  const refillReserve = estimateNearTermSpawnExtensionRefillReserveFromStructures(
    room,
    spawnExtensionEnergyStructures
  );
  const sortedLoadedWorkers =
    refillReserve > 0
      ? dedupeCreepsByStableKey(getGameCreeps().filter((candidate) => isSameRoomWorkerWithEnergy(candidate, room)))
          .sort((left, right) =>
            compareNearTermRefillReserveWorkers(left, right, spawnExtensionEnergyStructures)
          )
      : [];

  return {
    refillReserve,
    room,
    sortedLoadedWorkers,
    spawnExtensionEnergyStructures
  };
}

function getGameTick(): number | null {
  const time = (globalThis as unknown as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function getRoomName(room: Room): string | null {
  return typeof room.name === 'string' && room.name.length > 0 ? room.name : null;
}

function isWorkerEnergyNeededForNearTermSpawnExtensionRefillReserve(
  creep: Creep,
  reserveContext: NearTermSpawnExtensionRefillReserveContext
): boolean {
  const loadedWorkers = getNearTermRefillReserveLoadedWorkers(creep, reserveContext);
  let reservedEnergy = 0;

  for (const worker of loadedWorkers) {
    if (isSameCreep(worker, creep)) {
      return reservedEnergy < reserveContext.refillReserve;
    }

    reservedEnergy += getUsedEnergy(worker);
  }

  return true;
}

function getNearTermRefillReserveLoadedWorkers(
  creep: Creep,
  reserveContext: NearTermSpawnExtensionRefillReserveContext
): Creep[] {
  if (reserveContext.sortedLoadedWorkers.some((worker) => isSameCreep(worker, creep))) {
    return reserveContext.sortedLoadedWorkers;
  }

  return dedupeCreepsByStableKey([...reserveContext.sortedLoadedWorkers, creep])
    .sort((left, right) =>
      compareNearTermRefillReserveWorkers(left, right, reserveContext.spawnExtensionEnergyStructures)
    );
}

function compareNearTermRefillReserveWorkers(
  left: Creep,
  right: Creep,
  spawnExtensionEnergyStructures: SpawnExtensionEnergyStructure[]
): number {
  return (
    getUsedEnergy(right) - getUsedEnergy(left) ||
    compareOptionalRanges(
      getClosestNearTermRefillRange(left, spawnExtensionEnergyStructures),
      getClosestNearTermRefillRange(right, spawnExtensionEnergyStructures)
    ) ||
    getCreepStableSortKey(left).localeCompare(getCreepStableSortKey(right))
  );
}

function dedupeCreepsByStableKey(creeps: Creep[]): Creep[] {
  const seenStableKeys = new Set<string>();
  const seenCreeps = new Set<Creep>();
  const uniqueCreeps: Creep[] = [];

  for (const creep of creeps) {
    if (seenCreeps.has(creep)) {
      continue;
    }

    seenCreeps.add(creep);

    const stableKey = getCreepStableSortKey(creep);
    if (stableKey.length > 0) {
      if (seenStableKeys.has(stableKey)) {
        continue;
      }

      seenStableKeys.add(stableKey);
    }

    uniqueCreeps.push(creep);
  }

  return uniqueCreeps;
}

function getClosestNearTermRefillRange(
  creep: Creep,
  spawnExtensionEnergyStructures: SpawnExtensionEnergyStructure[]
): number | null {
  let closestRange: number | null = null;

  for (const structure of spawnExtensionEnergyStructures) {
    const range = getRangeBetweenRoomObjects(creep, structure);
    if (range === null) {
      continue;
    }

    closestRange = closestRange === null ? range : Math.min(closestRange, range);
  }

  return closestRange;
}

function isSameCreep(left: Creep, right: Creep): boolean {
  if (left === right) {
    return true;
  }

  const leftKey = getCreepStableSortKey(left);
  return leftKey.length > 0 && leftKey === getCreepStableSortKey(right);
}

function getCreepStableSortKey(creep: Creep): string {
  const name = (creep as Creep & { name?: unknown }).name;
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }

  const id = (creep as Creep & { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : '';
}

function shouldApplyControllerPressureLane(creep: Creep, controller: StructureController): boolean {
  if (controller.my !== true || controller.level < 2) {
    return false;
  }

  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  return (
    (loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS ||
      (loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE && hasActiveTerritoryPressure(creep))) &&
    !loadedWorkers.some((worker) => worker !== creep && isUpgradingController(worker, controller))
  );
}

function shouldUseSurplusForControllerProgress(creep: Creep, controller: StructureController): boolean {
  if (shouldApplyControllerPressureLane(creep, controller)) {
    return true;
  }

  return controller.my === true && controller.level >= 2 && hasRecoverableSurplusEnergy(creep);
}

function hasRecoverableSurplusEnergy(creep: Creep): boolean {
  return (
    selectStoredEnergySource(creep) !== null ||
    selectSalvageEnergySource(creep) !== null ||
    findDroppedResources(creep.room).some(isUsefulDroppedEnergy)
  );
}

function hasActiveTerritoryPressure(creep: Creep): boolean {
  const colonyName = getCreepColonyName(creep);
  if (!colonyName) {
    return false;
  }

  if (hasReadyTerritoryFollowUpEnergy(creep)) {
    return true;
  }

  const territoryMemory = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory;
  if (!territoryMemory || !Array.isArray(territoryMemory.intents)) {
    return false;
  }

  return territoryMemory.intents.some((intent) => isActiveTerritoryPressureIntent(intent, colonyName));
}

function hasReservedTerritoryFollowUpRefillCapacity(creep: Creep): boolean {
  return hasActiveTerritoryFollowUpPreparationDemand(getCreepColonyName(creep));
}

function hasReadyTerritoryFollowUpEnergy(creep: Creep): boolean {
  if (!hasReservedTerritoryFollowUpRefillCapacity(creep)) {
    return false;
  }

  const energyAvailable = getRoomEnergyAvailable(creep.room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(creep.room);
  if (energyAvailable === null || energyCapacityAvailable === null) {
    return false;
  }

  const followUpEnergyTarget = Math.min(TERRITORY_CONTROLLER_BODY_COST, energyCapacityAvailable);
  return energyAvailable >= followUpEnergyTarget;
}

function getRoomEnergyAvailable(room: Room): number | null {
  const energyAvailable = (room as Room & { energyAvailable?: number }).energyAvailable;
  return typeof energyAvailable === 'number' && Number.isFinite(energyAvailable) ? energyAvailable : null;
}

function getRoomEnergyCapacityAvailable(room: Room): number | null {
  const energyCapacityAvailable = (room as Room & { energyCapacityAvailable?: number }).energyCapacityAvailable;
  return typeof energyCapacityAvailable === 'number' && Number.isFinite(energyCapacityAvailable)
    ? energyCapacityAvailable
    : null;
}

function estimateRoomEnergyRefillShortfall(room: Room): number | null {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyAvailable === null || energyCapacityAvailable === null) {
    return null;
  }

  return Math.max(0, Math.ceil(Math.max(0, energyCapacityAvailable) - Math.max(0, energyAvailable)));
}

function getCreepColonyName(creep: Creep): string | null {
  const colony = creep.memory?.colony;
  if (typeof colony === 'string' && colony.length > 0) {
    return colony;
  }

  return null;
}

function isActiveTerritoryPressureIntent(intent: unknown, colonyName: string): boolean {
  if (!isWorkerTaskRecord(intent)) {
    return false;
  }

  return (
    intent.colony === colonyName &&
    intent.targetRoom !== colonyName &&
    (intent.status === 'planned' || intent.status === 'active') &&
    (intent.action === 'claim' || intent.action === 'reserve' || intent.action === 'scout')
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
