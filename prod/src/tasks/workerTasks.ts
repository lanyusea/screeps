import {
  hasActiveTerritoryFollowUpPreparationDemand,
  selectUrgentVisibleReservationRenewalTask,
  selectVisibleTerritoryControllerTask
} from '../territory/territoryPlanner';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import {
  buildCriticalRoadLogisticsContext,
  isCriticalRoadLogisticsWork,
  isRemoteTerritoryLogisticsRoom,
  isSelfReservedRoom,
  type CriticalRoadLogisticsContext
} from '../construction/criticalRoads';

// Low-downgrade safety floor: enough buffer for worker travel/recovery without treating healthy controllers as urgent.
export const CONTROLLER_DOWNGRADE_GUARD_TICKS = 5_000;
export const CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO = 0.5;
export const IDLE_RAMPART_REPAIR_HITS_CEILING = 100_000;
export const TOWER_REFILL_ENERGY_FLOOR = 500;
export const URGENT_SPAWN_REFILL_ENERGY_THRESHOLD = 200;
export const NEAR_TERM_SPAWN_EXTENSION_REFILL_RESERVE_TICKS = 50;
export const LOW_LOAD_WORKER_ENERGY_RATIO = 0.25;
export const LOW_LOAD_WORKER_ENERGY_CEILING = 25;
export const LOW_LOAD_NEARBY_ENERGY_RANGE = 3;
const MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
const MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE = 1;
const MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 25;
const MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT = 2;
const ENERGY_ACQUISITION_RANGE_COST = 50;
const ENERGY_ACQUISITION_ACTION_TICKS = 1;
const HARVEST_ENERGY_PER_WORK_PART = 2;
const MAX_DROPPED_ENERGY_REACHABILITY_CHECKS = 5;
const SOURCE2_CONTROLLER_LANE_SOURCE_INDEX = 1;
const SOURCE2_CONTROLLER_LANE_MAX_RANGE = 6;
const MIN_LOADED_WORKERS_FOR_SECOND_SUSTAINED_CONTROLLER_PROGRESS = 4;
const MAX_SUSTAINED_CONTROLLER_PROGRESS_WORKERS = 2;

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
type LowLoadWorkerEnergyAcquisitionSource = WorkerEnergyAcquisitionSource | Source;
type LowLoadWorkerEnergyAcquisitionTask = Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }>;
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

interface Source2ControllerLaneTopology {
  controller: StructureController;
  source: Source;
}

let nearTermSpawnExtensionRefillReserveCache: NearTermSpawnExtensionRefillReserveCache | null = null;

export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  clearWorkerEfficiencyTelemetry(creep);

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

    let hasPriorityEnergySink = false;
    if (getFreeEnergyCapacity(creep) > 0) {
      const spawnRecoveryEnergySink = selectFillableEnergySink(creep);
      if (spawnRecoveryEnergySink) {
        hasPriorityEnergySink = true;
        const spawnRecoveryTask = selectSpawnRecoveryEnergyAcquisitionTask(creep, spawnRecoveryEnergySink);
        if (spawnRecoveryTask) {
          return spawnRecoveryTask;
        }
      }

      const source2ControllerLaneHarvestTask = selectSource2ControllerLaneHarvestTask(creep);
      if (source2ControllerLaneHarvestTask) {
        return source2ControllerLaneHarvestTask;
      }

      if (!hasPriorityEnergySink) {
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
    const spawnOrExtensionRefillTask: Extract<CreepTaskMemory, { type: 'transfer' }> = {
      type: 'transfer',
      targetId: spawnOrExtensionEnergySink.id as Id<AnyStoreStructure>
    };
    if (shouldPrioritizeSpawnOrExtensionRefill(creep)) {
      recordLowLoadReturnTelemetry(creep, spawnOrExtensionRefillTask, 'urgentSpawnExtensionRefill');
      return spawnOrExtensionRefillTask;
    }

    const lowLoadEnergyAcquisitionCandidate = selectLowLoadWorkerEnergyAcquisitionCandidate(creep);
    if (lowLoadEnergyAcquisitionCandidate) {
      recordNearbyEnergyChoiceTelemetry(creep, lowLoadEnergyAcquisitionCandidate);
      return lowLoadEnergyAcquisitionCandidate.task;
    }

    recordLowLoadReturnTelemetry(creep, spawnOrExtensionRefillTask, 'noNearbyEnergy');
    return spawnOrExtensionRefillTask;
  }

  const lowLoadEnergyAcquisitionCandidate = selectLowLoadWorkerEnergyAcquisitionCandidate(creep);
  if (lowLoadEnergyAcquisitionCandidate) {
    recordNearbyEnergyChoiceTelemetry(creep, lowLoadEnergyAcquisitionCandidate);
    return lowLoadEnergyAcquisitionCandidate.task;
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
    controller,
    constructionSites
  );
  if (readyFollowUpProductiveEnergySinkTask) {
    return readyFollowUpProductiveEnergySinkTask;
  }

  if (territoryControllerTask) {
    return territoryControllerTask;
  }

  const source2ControllerLaneLoadedTask = controller
    ? selectSource2ControllerLaneLoadedTask(creep, controller, constructionSites)
    : null;
  if (source2ControllerLaneLoadedTask) {
    return source2ControllerLaneLoadedTask;
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

  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(creep, constructionSites);
  if (criticalRoadConstructionSite) {
    return { type: 'build', targetId: criticalRoadConstructionSite.id };
  }

  const containerConstructionSite = selectConstructionSite(creep, constructionSites, isContainerConstructionSite);
  if (containerConstructionSite) {
    return { type: 'build', targetId: containerConstructionSite.id };
  }

  if (controller && shouldUseSurplusForControllerProgress(creep, controller)) {
    const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(creep, constructionSites, controller);
    if (productiveEnergySinkTask) {
      return productiveEnergySinkTask;
    }

    return { type: 'upgrade', targetId: controller.id };
  }

  const roadConstructionSite = selectConstructionSite(creep, constructionSites, isRoadConstructionSite);
  if (roadConstructionSite) {
    return { type: 'build', targetId: roadConstructionSite.id };
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

function shouldPrioritizeSpawnOrExtensionRefill(creep: Creep): boolean {
  const energyAvailable = getRoomEnergyAvailable(creep.room);
  if (energyAvailable === null || energyAvailable < URGENT_SPAWN_REFILL_ENERGY_THRESHOLD) {
    return true;
  }

  if (hasReservedTerritoryFollowUpRefillCapacity(creep) && !hasReadyTerritoryFollowUpEnergy(creep)) {
    return true;
  }

  return hasNearTermSpawnCompletionRefillDemand(creep.room);
}

function hasNearTermSpawnCompletionRefillDemand(room: Room): boolean {
  return findSpawnExtensionEnergyStructures(room).some(isNearTermSpawningSpawn);
}

interface LowLoadWorkerEnergyContext {
  carriedEnergy: number;
  freeCapacity: number;
}

function getLowLoadWorkerEnergyContext(creep: Creep): LowLoadWorkerEnergyContext | null {
  const carriedEnergy = getUsedEnergy(creep);
  const freeCapacity = getFreeEnergyCapacity(creep);
  if (carriedEnergy <= 0 || freeCapacity <= 0) {
    return null;
  }

  const capacity = carriedEnergy + freeCapacity;
  const lowLoadEnergyLimit = Math.min(
    LOW_LOAD_WORKER_ENERGY_CEILING,
    Math.max(1, Math.floor(capacity * LOW_LOAD_WORKER_ENERGY_RATIO))
  );
  return carriedEnergy <= lowLoadEnergyLimit ? { carriedEnergy, freeCapacity } : null;
}

function clearWorkerEfficiencyTelemetry(creep: Creep): void {
  const memory = creep.memory;
  if (memory) {
    delete memory.workerEfficiency;
  }
}

function recordNearbyEnergyChoiceTelemetry(
  creep: Creep,
  candidate: LowLoadWorkerEnergyAcquisitionCandidate
): void {
  const context = getLowLoadWorkerEnergyContext(creep);
  const memory = creep.memory;
  if (!context || !memory) {
    return;
  }

  memory.workerEfficiency = {
    type: 'nearbyEnergyChoice',
    tick: getGameTick() ?? 0,
    carriedEnergy: context.carriedEnergy,
    freeCapacity: context.freeCapacity,
    selectedTask: candidate.task.type,
    targetId: String(candidate.task.targetId),
    energy: Math.max(0, Math.floor(candidate.energy)),
    ...(candidate.range === null ? {} : { range: candidate.range })
  };
}

function recordLowLoadReturnTelemetry(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'transfer' }>,
  reason: WorkerEfficiencyLowLoadReturnReason
): void {
  const context = getLowLoadWorkerEnergyContext(creep);
  const memory = creep.memory;
  if (!context || !memory) {
    return;
  }

  memory.workerEfficiency = {
    type: 'lowLoadReturn',
    tick: getGameTick() ?? 0,
    carriedEnergy: context.carriedEnergy,
    freeCapacity: context.freeCapacity,
    selectedTask: task.type,
    targetId: String(task.targetId),
    reason
  };
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
  const reservedEnergyDeliveries = getReservedEnergyDeliveriesBySinkId(creep, loadedWorkers);
  const assignedTransferTargetId = getAssignedTransferTargetId(creep);
  return selectClosestEnergySink(
    energySinks.filter(
      (energySink) =>
        isAssignedTransferTarget(energySink, assignedTransferTargetId) ||
        hasUnreservedEnergySinkCapacity(energySink, reservedEnergyDeliveries)
    ),
    creep
  );
}

function selectPriorityTowerEnergySink(creep: Creep): StructureTower | null {
  return selectClosestEnergySink(findFillableEnergySinks(creep).filter(isPriorityTowerEnergySink), creep);
}

function hasUnreservedEnergySinkCapacity(
  energySink: SpawnExtensionEnergyStructure,
  reservedEnergyDeliveries: Map<string, number>
): boolean {
  return getReservedEnergyDelivery(energySink, reservedEnergyDeliveries) < getFreeStoredEnergyCapacity(energySink);
}

function getReservedEnergyDeliveriesBySinkId(
  creep: Creep,
  loadedWorkers: Creep[]
): Map<string, number> {
  const reservedEnergyDeliveries = new Map<string, number>();
  for (const worker of loadedWorkers) {
    if (isSameCreep(worker, creep)) {
      continue;
    }

    const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
    if (task?.type !== 'transfer' || typeof task.targetId !== 'string') {
      continue;
    }

    const energySinkId = String(task.targetId);
    reservedEnergyDeliveries.set(energySinkId, (reservedEnergyDeliveries.get(energySinkId) ?? 0) + getUsedEnergy(worker));
  }

  return reservedEnergyDeliveries;
}

function getReservedEnergyDelivery(
  energySink: SpawnExtensionEnergyStructure,
  reservedEnergyDeliveries: Map<string, number>
): number {
  return reservedEnergyDeliveries.get(String(energySink.id)) ?? 0;
}

function getAssignedTransferTargetId(creep: Creep): string | null {
  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'transfer' && typeof task.targetId === 'string' ? String(task.targetId) : null;
}

function isAssignedTransferTarget(
  energySink: SpawnExtensionEnergyStructure,
  assignedTransferTargetId: string | null
): boolean {
  return assignedTransferTargetId !== null && String(energySink.id) === assignedTransferTargetId;
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

function selectCriticalRoadConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[]
): ConstructionSite | null {
  const roadConstructionSites = constructionSites.filter(isRoadConstructionSite);
  if (roadConstructionSites.length === 0) {
    return null;
  }

  const criticalRoadContext = buildWorkerCriticalRoadLogisticsContext(creep);
  return selectConstructionSite(
    creep,
    roadConstructionSites,
    (site) => isCriticalRoadLogisticsWork(site, criticalRoadContext)
  );
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
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[]
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
  if (criticalRepairTarget) {
    return { type: 'repair', targetId: criticalRepairTarget.id as Id<Structure> };
  }

  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(creep, constructionSites);
  return criticalRoadConstructionSite ? { type: 'build', targetId: criticalRoadConstructionSite.id } : null;
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

interface LowLoadWorkerEnergyAcquisitionCandidate {
  energy: number;
  range: number | null;
  score: number;
  source: LowLoadWorkerEnergyAcquisitionSource;
  task: LowLoadWorkerEnergyAcquisitionTask;
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

function selectLowLoadWorkerEnergyAcquisitionCandidate(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  if (!shouldKeepLowLoadWorkerAcquiringEnergy(creep)) {
    return null;
  }

  const nearbyCandidates = findLowLoadWorkerEnergyAcquisitionCandidates(creep).filter(
    (candidate) => candidate.range !== null && candidate.range <= LOW_LOAD_NEARBY_ENERGY_RANGE
  );
  if (nearbyCandidates.length === 0) {
    return null;
  }

  return nearbyCandidates.sort(compareLowLoadWorkerEnergyAcquisitionCandidates)[0];
}

function shouldKeepLowLoadWorkerAcquiringEnergy(creep: Creep): boolean {
  return getLowLoadWorkerEnergyContext(creep) !== null && !hasVisibleHostilePresence(creep.room);
}

function findLowLoadWorkerEnergyAcquisitionCandidates(creep: Creep): LowLoadWorkerEnergyAcquisitionCandidate[] {
  return [
    ...findNearbyLowLoadStoredEnergyAcquisitionCandidates(creep),
    ...findNearbyLowLoadSalvageEnergyAcquisitionCandidates(creep),
    ...findNearbyLowLoadDroppedEnergyAcquisitionCandidates(creep),
    ...findLowLoadHarvestEnergyAcquisitionCandidates(creep)
  ];
}

function findNearbyLowLoadStoredEnergyAcquisitionCandidates(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };

  return findVisibleRoomStructures(creep.room)
    .filter((structure): structure is StoredWorkerEnergySource => isSafeStoredEnergySource(structure, context))
    .filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source))
    .map((source) =>
      toLowLoadWorkerEnergyAcquisitionCandidate(
        createWorkerEnergyAcquisitionCandidate(creep, source, getStoredEnergy(source), {
          type: 'withdraw',
          targetId: source.id as Id<AnyStoreStructure>
        })
      )
    );
}

function findNearbyLowLoadSalvageEnergyAcquisitionCandidates(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  return [...findTombstones(creep.room), ...findRuins(creep.room)]
    .filter(hasSalvageableEnergy)
    .filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source))
    .map((source) =>
      toLowLoadWorkerEnergyAcquisitionCandidate(
        createWorkerEnergyAcquisitionCandidate(creep, source, getStoredEnergy(source), {
          type: 'withdraw',
          targetId: source.id as unknown as Id<AnyStoreStructure>
        })
      )
    );
}

function findNearbyLowLoadDroppedEnergyAcquisitionCandidates(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  return findDroppedResources(creep.room)
    .filter(isUsefulDroppedEnergy)
    .filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source))
    .filter((source) => isReachable(creep, source))
    .map((source) =>
      toLowLoadWorkerEnergyAcquisitionCandidate(
        createWorkerEnergyAcquisitionCandidate(creep, source, source.amount, {
          type: 'pickup',
          targetId: source.id
        })
      )
    );
}

function isNearbyLowLoadWorkerEnergyAcquisitionSource(
  creep: Creep,
  source: LowLoadWorkerEnergyAcquisitionSource
): boolean {
  const range = getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source);
  return range !== null && range <= LOW_LOAD_NEARBY_ENERGY_RANGE;
}

function toLowLoadWorkerEnergyAcquisitionCandidate(
  candidate: WorkerEnergyAcquisitionCandidate
): LowLoadWorkerEnergyAcquisitionCandidate {
  return candidate;
}

function findLowLoadHarvestEnergyAcquisitionCandidates(creep: Creep): LowLoadWorkerEnergyAcquisitionCandidate[] {
  if (getActiveWorkParts(creep) <= 0) {
    return [];
  }

  const source = selectHarvestSource(creep);
  if (!source || isSourceDepleted(source)) {
    return [];
  }

  return [
    createLowLoadWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getHarvestCandidateEnergy(creep, source),
      { type: 'harvest', targetId: source.id }
    )
  ];
}

function getHarvestCandidateEnergy(creep: Creep, source: Source): number {
  return typeof source.energy === 'number' && Number.isFinite(source.energy)
    ? source.energy
    : getFreeEnergyCapacity(creep);
}

function createLowLoadWorkerEnergyAcquisitionCandidate(
  creep: Creep,
  source: LowLoadWorkerEnergyAcquisitionSource,
  energy: number,
  task: LowLoadWorkerEnergyAcquisitionTask
): LowLoadWorkerEnergyAcquisitionCandidate {
  const range = getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source);

  return {
    energy,
    range,
    score: range === null ? energy : energy - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task
  };
}

function compareLowLoadWorkerEnergyAcquisitionCandidates(
  left: LowLoadWorkerEnergyAcquisitionCandidate,
  right: LowLoadWorkerEnergyAcquisitionCandidate
): number {
  return (
    compareOptionalRanges(left.range, right.range) ||
    right.score - left.score ||
    right.energy - left.energy ||
    String(left.source.id).localeCompare(String(right.source.id)) ||
    left.task.type.localeCompare(right.task.type)
  );
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
  return getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source);
}

function getRangeToLowLoadWorkerEnergyAcquisitionSource(
  creep: Creep,
  source: LowLoadWorkerEnergyAcquisitionSource
): number | null {
  const position = (creep as Creep & {
    pos?: {
      getRangeTo?: (target: LowLoadWorkerEnergyAcquisitionSource) => number;
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
  const visibleStructures = findVisibleRoomStructures(creep.room);
  const criticalRoadContext = visibleStructures.some(isCriticalRoadRepairCandidate)
    ? buildWorkerCriticalRoadLogisticsContext(creep)
    : null;
  const canRepairOwnedInfrastructure = creep.room.controller?.my === true;
  const canRepairRemoteCriticalRoads =
    !canRepairOwnedInfrastructure &&
    criticalRoadContext !== null &&
    canRepairRemoteCriticalRoadInfrastructure(creep);

  if (!canRepairOwnedInfrastructure && !canRepairRemoteCriticalRoads) {
    return null;
  }

  const repairTargets = visibleStructures.filter((structure) =>
    isCriticalInfrastructureRepairTarget(structure, criticalRoadContext, {
      repairContainers: canRepairOwnedInfrastructure,
      repairCriticalRoads: canRepairOwnedInfrastructure || canRepairRemoteCriticalRoads
    })
  );
  if (repairTargets.length === 0) {
    return null;
  }

  return repairTargets.sort(compareRepairTargets)[0];
}

function canRepairRemoteCriticalRoadInfrastructure(creep: Creep): boolean {
  if (!isRemoteTerritoryLogisticsRoom(creep.room) || hasVisibleHostilePresence(creep.room)) {
    return false;
  }

  const controller = creep.room.controller;
  if (!controller) {
    return true;
  }

  if (controller.owner != null) {
    return false;
  }

  const reservationUsername = controller.reservation?.username;
  return (
    reservationUsername == null ||
    reservationUsername === getCreepOwnerUsername(creep) ||
    isSelfReservedRoom(creep.room)
  );
}

function buildWorkerCriticalRoadLogisticsContext(creep: Creep): CriticalRoadLogisticsContext {
  return buildCriticalRoadLogisticsContext(creep.room, { colonyRoomName: getCreepColonyName(creep) });
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

function isCriticalInfrastructureRepairTarget(
  structure: AnyStructure,
  criticalRoadContext: CriticalRoadLogisticsContext | null,
  options: { repairContainers: boolean; repairCriticalRoads: boolean }
): structure is CriticalInfrastructureRepairTarget {
  if (
    !isSafeRepairTarget(structure) ||
    !isRoadOrContainerRepairTarget(structure) ||
    getHitsRatio(structure) > CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO
  ) {
    return false;
  }

  return (
    (options.repairContainers && isContainerRepairTarget(structure)) ||
    (options.repairCriticalRoads &&
      !!criticalRoadContext &&
      isCriticalRoadLogisticsWork(structure, criticalRoadContext))
  );
}

function isCriticalRoadRepairCandidate(structure: AnyStructure): structure is StructureRoad {
  return (
    isSafeRepairTarget(structure) &&
    isRoadRepairTarget(structure) &&
    getHitsRatio(structure) <= CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO
  );
}

function isRoadOrContainerRepairTarget(structure: AnyStructure): structure is StructureRoad | StructureContainer {
  return isRoadRepairTarget(structure) || isContainerRepairTarget(structure);
}

function isRoadRepairTarget(structure: AnyStructure): structure is StructureRoad {
  return matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road');
}

function isContainerRepairTarget(structure: AnyStructure): structure is StructureContainer {
  return matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container');
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
  const hasTerritoryPressure = hasActiveTerritoryPressure(creep);
  if (
    loadedWorkers.length < MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS &&
    !(loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE && hasTerritoryPressure)
  ) {
    return false;
  }

  const controllerProgressWorkers =
    loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_SECOND_SUSTAINED_CONTROLLER_PROGRESS && !hasTerritoryPressure
      ? MAX_SUSTAINED_CONTROLLER_PROGRESS_WORKERS
      : 1;
  const otherControllerUpgraders = loadedWorkers.filter(
    (worker) => !isSameCreep(worker, creep) && isUpgradingController(worker, controller)
  ).length;
  return otherControllerUpgraders < controllerProgressWorkers;
}

function shouldUseSurplusForControllerProgress(creep: Creep, controller: StructureController): boolean {
  if (shouldApplyControllerPressureLane(creep, controller)) {
    return true;
  }

  if (controller.my === true && controller.level >= 2 && hasRecoverableSurplusEnergy(creep)) {
    return true;
  }

  return false;
}

function shouldApplySource2ControllerLane(creep: Creep, controller: StructureController): boolean {
  const topology = getSource2ControllerLaneTopology(creep.room, controller);
  if (!topology) {
    return false;
  }

  return !hasOtherSource2ControllerLaneWorker(creep, topology);
}

function selectSource2ControllerLaneLoadedTask(
  creep: Creep,
  controller: StructureController,
  constructionSites: ConstructionSite[]
): ProductiveEnergySinkTask | Extract<CreepTaskMemory, { type: 'upgrade' }> | null {
  if (!shouldApplySource2ControllerLane(creep, controller)) {
    return null;
  }

  const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(creep, constructionSites, controller);
  return productiveEnergySinkTask ?? { type: 'upgrade', targetId: controller.id };
}

function selectSource2ControllerLaneHarvestTask(creep: Creep): Extract<CreepTaskMemory, { type: 'harvest' }> | null {
  const controller = creep.room.controller;
  if (!controller) {
    return null;
  }

  const topology = getSource2ControllerLaneTopology(creep.room, controller);
  if (!topology || isSourceDepleted(topology.source) || hasOtherSource2ControllerLaneWorker(creep, topology)) {
    return null;
  }

  return { type: 'harvest', targetId: topology.source.id };
}

function getSource2ControllerLaneTopology(
  room: Room,
  controller: StructureController
): Source2ControllerLaneTopology | null {
  if (
    controller.my !== true ||
    typeof controller.level !== 'number' ||
    controller.level < 2 ||
    getRoomObjectPosition(controller) === null ||
    !isHomeRoomName(room, controller) ||
    hasVisibleHostilePresence(room)
  ) {
    return null;
  }

  const source = getSource2(room);
  if (!source) {
    return null;
  }

  const range = getRangeBetweenRoomObjectPositions(source, controller);
  if (range === null || range > SOURCE2_CONTROLLER_LANE_MAX_RANGE) {
    return null;
  }

  return { controller, source };
}

function getSource2(room: Room): Source | null {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  return room.find(FIND_SOURCES)[SOURCE2_CONTROLLER_LANE_SOURCE_INDEX] ?? null;
}

function isHomeRoomName(room: Room, controller: StructureController): boolean {
  const roomName = getRoomName(room);
  const controllerRoomName = getPositionRoomName(controller);
  return roomName === null || controllerRoomName === null || roomName === controllerRoomName;
}

function isSourceDepleted(source: Source): boolean {
  return typeof source.energy === 'number' && source.energy <= 0;
}

function hasOtherSource2ControllerLaneWorker(creep: Creep, topology: Source2ControllerLaneTopology): boolean {
  return getGameCreeps().some(
    (candidate) =>
      !isSameCreep(candidate, creep) &&
      isSameRoomWorker(candidate, creep.room) &&
      isSource2ControllerLaneTask(candidate, topology)
  );
}

function isSameRoomWorker(creep: Creep, room: Room): boolean {
  return creep.memory?.role === 'worker' && isInRoom(creep, room);
}

function isSource2ControllerLaneTask(creep: Creep, topology: Source2ControllerLaneTopology): boolean {
  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return (
    (task?.type === 'harvest' && task.targetId === topology.source.id) ||
    (task?.type === 'upgrade' && task.targetId === topology.controller.id)
  );
}

function getRangeBetweenRoomObjectPositions(left: RoomObject, right: RoomObject): number | null {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  if (!leftPosition || !rightPosition || !isSameRoomPosition(leftPosition, rightPosition)) {
    return null;
  }

  const rangeFromApi = getRangeBetweenRoomObjects(left, right);
  if (rangeFromApi !== null) {
    return rangeFromApi;
  }

  return Math.max(Math.abs(leftPosition.x - rightPosition.x), Math.abs(leftPosition.y - rightPosition.y));
}

function getRoomObjectPosition(object: RoomObject): RoomPosition | null {
  const position = (object as RoomObject & { pos?: RoomPosition }).pos;
  return isRoomPosition(position) ? position : null;
}

function getPositionRoomName(object: RoomObject): string | null {
  return getRoomObjectPosition(object)?.roomName ?? null;
}

function isSameRoomPosition(left: RoomPosition, right: RoomPosition): boolean {
  if (typeof left.roomName === 'string' && typeof right.roomName === 'string') {
    return left.roomName === right.roomName;
  }

  return true;
}

function isRoomPosition(value: unknown): value is RoomPosition {
  return (
    isWorkerTaskRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.roomName === 'string' &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    value.roomName.length > 0
  );
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
