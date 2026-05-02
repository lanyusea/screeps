import {
  hasActiveTerritoryFollowUpPreparationDemand,
  selectUrgentVisibleReservationRenewalTask,
  selectVisibleTerritoryControllerTask
} from '../territory/territoryPlanner';
import {
  getRecordedColonySurvivalAssessment,
  suppressesBootstrapNonCriticalWork,
  suppressesTerritoryWork,
  type ColonySurvivalAssessment
} from '../colony/survivalMode';
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
export const MINIMUM_USEFUL_LOAD_RATIO = 0.4;
export const LOW_LOAD_NEARBY_ENERGY_RANGE = 3;
export const LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE = 6;
const DEFAULT_SPAWN_ENERGY_CAPACITY = 300;
const MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
const MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE = 1;
const MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 25;
const MIN_SPAWN_RECOVERY_DROPPED_ENERGY_PICKUP_AMOUNT = 10;
const MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT = 2;
const ENERGY_ACQUISITION_RANGE_COST = 50;
const ENERGY_ACQUISITION_ACTION_TICKS = 1;
const WORKER_ENERGY_SURPLUS_SCORE_RATIO = 0.4;
const HARVEST_ENERGY_PER_WORK_PART = 2;
const DEFAULT_BUILD_POWER = 5;
const MAX_DROPPED_ENERGY_REACHABILITY_CHECKS = 5;
const DEFAULT_SOURCE_ENERGY_CAPACITY = 3_000;
const DEFAULT_SOURCE_ENERGY_REGEN_TICKS = 300;
const SOURCE2_CONTROLLER_LANE_SOURCE_INDEX = 1;
const SOURCE2_CONTROLLER_LANE_MAX_RANGE = 6;
const MIN_LOADED_WORKERS_FOR_SECOND_SUSTAINED_CONTROLLER_PROGRESS = 4;
const MIN_LOADED_WORKERS_FOR_SURPLUS_CONTROLLER_PROGRESS = 5;
const MAX_SUSTAINED_CONTROLLER_PROGRESS_WORKERS = 2;
const MAX_SURPLUS_CONTROLLER_PROGRESS_WORKERS = 3;
const BASELINE_WORKER_THROUGHPUT_ENERGY_CAPACITY = 550;

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
type WorkerEnergySpendingTask =
  | Extract<CreepTaskMemory, { type: 'transfer' }>
  | Extract<CreepTaskMemory, { type: 'build' }>
  | Extract<CreepTaskMemory, { type: 'repair' }>
  | Extract<CreepTaskMemory, { type: 'upgrade' }>;

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

interface ConstructionReservationContext {
  reservedProgressBySiteId: Map<string, number>;
}

interface Source2ControllerLaneTopology {
  controller: StructureController;
  source: Source;
}

interface HarvestSourceLoad {
  assignedWorkParts: number;
  assignmentCount: number;
  accessCapacity: number;
  workCapacity: number;
  source: Source;
}

interface HarvestSourceAssignmentLoad {
  assignedWorkParts: number;
  assignmentCount: number;
}

let nearTermSpawnExtensionRefillReserveCache: NearTermSpawnExtensionRefillReserveCache | null = null;

export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  clearWorkerEfficiencyTelemetry(creep);

  const survivalAssessment = getWorkerColonySurvivalAssessment(creep);
  const territoryWorkSuppressed = suppressesTerritoryWork(survivalAssessment);
  const bootstrapNonCriticalWorkSuppressed = suppressesBootstrapNonCriticalWork(survivalAssessment);
  const recoveryOnlyWorkSuppressed = bootstrapNonCriticalWorkSuppressed || territoryWorkSuppressed;
  const remoteProductiveSpendingSuppressed =
    recoveryOnlyWorkSuppressed && !isWorkerInColonyRoom(creep);
  const carriedEnergy = getUsedEnergy(creep);
  const urgentReservationRenewalTask = territoryWorkSuppressed
    ? null
    : selectUrgentVisibleReservationRenewalTask(creep);
  const territoryControllerTask = territoryWorkSuppressed ? null : selectVisibleTerritoryControllerTask(creep);

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
        const spawnRecoveryHarvestCandidate = selectSpawnRecoveryHarvestCandidate(creep, spawnRecoveryEnergySink);
        const spawnRecoveryTask = selectSpawnRecoveryEnergyAcquisitionTask(
          creep,
          spawnRecoveryEnergySink,
          spawnRecoveryHarvestCandidate?.deliveryEta ?? null
        );
        if (spawnRecoveryTask) {
          return spawnRecoveryTask;
        }

        if (spawnRecoveryHarvestCandidate) {
          return { type: 'harvest', targetId: spawnRecoveryHarvestCandidate.source.id };
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
  if (controller && shouldGuardControllerDowngrade(controller) && !remoteProductiveSpendingSuppressed) {
    const downgradeGuardTask: Extract<CreepTaskMemory, { type: 'upgrade' }> = {
      type: 'upgrade',
      targetId: controller.id
    };
    recordLowLoadReturnTelemetry(creep, downgradeGuardTask, 'controllerDowngradeGuard');
    return downgradeGuardTask;
  }

  const spawnOrExtensionEnergySink = selectSpawnOrExtensionEnergySink(creep);
  if (spawnOrExtensionEnergySink) {
    const spawnOrExtensionRefillTask: Extract<CreepTaskMemory, { type: 'transfer' }> = {
      type: 'transfer',
      targetId: spawnOrExtensionEnergySink.id as Id<AnyStoreStructure>
    };
    if (hasEmergencySpawnExtensionRefillDemand(creep)) {
      recordLowLoadReturnTelemetry(creep, spawnOrExtensionRefillTask, 'emergencySpawnExtensionRefill');
      return spawnOrExtensionRefillTask;
    }

    return applyMinimumUsefulLoadPolicy(creep, spawnOrExtensionRefillTask);
  }

  if (remoteProductiveSpendingSuppressed) {
    const suppressedRemoteEnergyHandlingTask = selectSuppressedRemoteEnergyHandlingTask(creep);
    if (suppressedRemoteEnergyHandlingTask) {
      return suppressedRemoteEnergyHandlingTask;
    }

    return null;
  }

  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const constructionReservationContext =
    constructionSites.length > 0
      ? createConstructionReservationContext(creep.room)
      : createEmptyConstructionReservationContext();
  const capacityConstructionSite = selectCapacityEnablingConstructionSite(
    creep,
    constructionSites,
    controller,
    constructionReservationContext
  );
  if (territoryControllerTask && capacityConstructionSite && isSpawnConstructionSite(capacityConstructionSite)) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: capacityConstructionSite.id });
  }

  if (!territoryControllerTask) {
    const baselineLogisticsConstructionSite = selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(
      creep,
      capacityConstructionSite,
      constructionSites,
      constructionReservationContext
    );
    if (baselineLogisticsConstructionSite) {
      return applyMinimumUsefulLoadPolicy(creep, {
        type: 'build',
        targetId: baselineLogisticsConstructionSite.id
      });
    }

    if (capacityConstructionSite) {
      return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: capacityConstructionSite.id });
    }
  }

  const priorityTowerEnergySink = selectPriorityTowerEnergySink(creep);
  if (priorityTowerEnergySink) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'transfer',
      targetId: priorityTowerEnergySink.id as Id<AnyStoreStructure>
    });
  }

  if (!remoteProductiveSpendingSuppressed) {
    const lowLoadEnergyAcquisitionCandidate = selectLowLoadWorkerEnergyAcquisitionCandidate(creep);
    if (lowLoadEnergyAcquisitionCandidate) {
      recordNearbyEnergyChoiceTelemetry(creep, lowLoadEnergyAcquisitionCandidate);
      return lowLoadEnergyAcquisitionCandidate.task;
    }
  }

  if (bootstrapNonCriticalWorkSuppressed) {
    return selectBootstrapSurvivalSpendingTask(
      creep,
      controller,
      constructionSites,
      constructionReservationContext,
      recoveryOnlyWorkSuppressed
    );
  }

  const readyFollowUpProductiveEnergySinkTask = selectReadyFollowUpProductiveEnergySinkTask(
    creep,
    capacityConstructionSite,
    controller,
    constructionSites,
    constructionReservationContext
  );
  if (readyFollowUpProductiveEnergySinkTask) {
    return applyMinimumUsefulLoadPolicy(creep, readyFollowUpProductiveEnergySinkTask);
  }

  if (territoryControllerTask) {
    return territoryControllerTask;
  }

  const source2ControllerLaneLoadedTask = controller
    ? selectSource2ControllerLaneLoadedTask(creep, controller, constructionSites, constructionReservationContext)
    : null;
  if (source2ControllerLaneLoadedTask) {
    return applyMinimumUsefulLoadPolicy(creep, source2ControllerLaneLoadedTask);
  }

  if (capacityConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: capacityConstructionSite.id });
  }

  if (controller && shouldRushRcl1Controller(controller)) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'upgrade', targetId: controller.id });
  }

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: criticalRepairTarget.id as Id<Structure>
    });
  }

  if (shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)) {
    return null;
  }

  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (criticalRoadConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: criticalRoadConstructionSite.id });
  }

  const containerConstructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isContainerConstructionSite
  );
  if (containerConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: containerConstructionSite.id });
  }

  if (controller && shouldUseSurplusForControllerProgress(creep, controller)) {
    const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(
      creep,
      constructionSites,
      controller,
      constructionReservationContext
    );
    if (productiveEnergySinkTask) {
      return applyMinimumUsefulLoadPolicy(creep, productiveEnergySinkTask);
    }

    return applyMinimumUsefulLoadPolicy(creep, { type: 'upgrade', targetId: controller.id });
  }

  const roadConstructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isRoadConstructionSite
  );
  if (roadConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: roadConstructionSite.id });
  }

  const constructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (constructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: constructionSite.id });
  }

  const repairTarget = selectRepairTarget(creep);
  if (repairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'repair', targetId: repairTarget.id as Id<Structure> });
  }

  if (controller?.my) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'upgrade', targetId: controller.id });
  }

  return null;
}

function getWorkerColonySurvivalAssessment(creep: Creep): ColonySurvivalAssessment | null {
  return getRecordedColonySurvivalAssessment(getCreepColonyName(creep));
}

function isWorkerInColonyRoom(creep: Creep): boolean {
  const colonyName = getCreepColonyName(creep);
  return colonyName !== null && getRoomName(creep.room) === colonyName;
}

function selectSuppressedRemoteEnergyHandlingTask(creep: Creep): CreepTaskMemory | null {
  const priorityTowerEnergySink = selectPriorityTowerEnergySink(creep);
  if (priorityTowerEnergySink) {
    return { type: 'transfer', targetId: priorityTowerEnergySink.id as Id<AnyStoreStructure> };
  }

  return selectColonyRecallEnergySpendingTask(creep);
}

function selectColonyRecallEnergySpendingTask(creep: Creep): CreepTaskMemory | null {
  const colonyRoom = getCreepColonyRoom(creep);
  if (!colonyRoom || isInRoom(creep, colonyRoom)) {
    return null;
  }

  const energySink = selectColonyRecallEnergySink(colonyRoom);
  if (energySink) {
    return { type: 'transfer', targetId: energySink.id as Id<AnyStoreStructure> };
  }

  const controller = colonyRoom.controller;
  return controller?.my === true ? { type: 'upgrade', targetId: controller.id } : null;
}

function selectColonyRecallEnergySink(room: Room): FillableEnergySink | null {
  const energySinks = findFillableEnergySinksInRoom(room);
  return (
    selectFirstEnergySinkByStableId(energySinks.filter(isSpawnOrExtensionEnergySink)) ??
    selectFirstEnergySinkByStableId(energySinks.filter(isTowerEnergySink))
  );
}

function selectFirstEnergySinkByStableId<T extends FillableEnergySink>(energySinks: T[]): T | null {
  return [...energySinks].sort(compareEnergySinkId)[0] ?? null;
}

function selectBootstrapSurvivalSpendingTask(
  creep: Creep,
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  recoveryOnlyWorkSuppressed: boolean
): CreepTaskMemory | null {
  if (
    controller &&
    shouldRushRcl1Controller(controller) &&
    !shouldSuppressBootstrapControllerSpending(creep, recoveryOnlyWorkSuppressed)
  ) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'upgrade', targetId: controller.id });
  }

  if (recoveryOnlyWorkSuppressed && !isWorkerInColonyRoom(creep)) {
    return null;
  }

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: criticalRepairTarget.id as Id<Structure>
    });
  }

  if (shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)) {
    return null;
  }

  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (criticalRoadConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: criticalRoadConstructionSite.id });
  }

  return null;
}

function shouldSuppressBootstrapControllerSpending(creep: Creep, recoveryOnlyWorkSuppressed: boolean): boolean {
  return recoveryOnlyWorkSuppressed && !isWorkerInColonyRoom(creep);
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

function hasEmergencySpawnExtensionRefillDemand(creep: Creep): boolean {
  const energyAvailable = getRoomEnergyAvailable(creep.room);
  return energyAvailable === null || energyAvailable < URGENT_SPAWN_REFILL_ENERGY_THRESHOLD;
}

interface LowLoadWorkerEnergyContext {
  carriedEnergy: number;
  capacity: number;
  freeCapacity: number;
}

function getLowLoadWorkerEnergyContext(creep: Creep): LowLoadWorkerEnergyContext | null {
  const carriedEnergy = getUsedEnergy(creep);
  const freeCapacity = getFreeEnergyCapacity(creep);
  if (carriedEnergy <= 0 || freeCapacity <= 0) {
    return null;
  }

  const capacity = getEnergyCapacity(creep, carriedEnergy, freeCapacity);
  return capacity > 0 && carriedEnergy < capacity * MINIMUM_USEFUL_LOAD_RATIO
    ? { carriedEnergy, capacity, freeCapacity }
    : null;
}

function applyMinimumUsefulLoadPolicy(
  creep: Creep,
  task: WorkerEnergySpendingTask
): WorkerEnergySpendingTask | LowLoadWorkerEnergyAcquisitionTask {
  if (!getLowLoadWorkerEnergyContext(creep)) {
    return task;
  }

  if (hasVisibleHostilePresence(creep.room)) {
    recordLowLoadReturnTelemetry(creep, task, 'hostileSafety');
    return task;
  }

  const lowLoadEnergyContinuationTask = selectLowLoadWorkerEnergyContinuationTask(creep);
  if (lowLoadEnergyContinuationTask) {
    return lowLoadEnergyContinuationTask;
  }

  recordLowLoadReturnTelemetry(creep, task, 'noReachableEnergy');
  return task;
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
  task: WorkerEnergySpendingTask,
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

  const loadedWorkers = getSameRoomLoadedWorkersForRefillReservations(creep);
  const reservedEnergyDeliveries = getReservedEnergyDeliveriesBySinkId(creep, loadedWorkers);
  const assignedTransferTargetId = getAssignedTransferTargetId(creep);
  const unreservedEnergySink = selectSpawnExtensionRecoveryEnergySink(
    energySinks.filter((energySink) => hasUnreservedEnergySinkCapacity(energySink, reservedEnergyDeliveries)),
    creep,
    reservedEnergyDeliveries,
    assignedTransferTargetId
  );
  return (
    unreservedEnergySink ??
    selectCloserReservedEnergySinkFallback(energySinks, creep, loadedWorkers, reservedEnergyDeliveries)
  );
}

function selectSpawnExtensionRecoveryEnergySink<T extends StructureSpawn | StructureExtension>(
  energySinks: T[],
  creep: Creep,
  reservedEnergyDeliveries: Map<string, number>,
  assignedTransferTargetId: string | null
): T | null {
  if (energySinks.length === 0) {
    return null;
  }

  return [...energySinks].sort((left, right) =>
    compareSpawnExtensionRecoveryEnergySinks(
      left,
      right,
      creep,
      reservedEnergyDeliveries,
      assignedTransferTargetId
    )
  )[0];
}

function compareSpawnExtensionRecoveryEnergySinks(
  left: StructureSpawn | StructureExtension,
  right: StructureSpawn | StructureExtension,
  creep: Creep,
  reservedEnergyDeliveries: Map<string, number>,
  assignedTransferTargetId: string | null
): number {
  const carriedEnergy = getUsedEnergy(creep);
  const leftDeliveryCapacity = getUnreservedEnergySinkDeliveryCapacity(left, reservedEnergyDeliveries);
  const rightDeliveryCapacity = getUnreservedEnergySinkDeliveryCapacity(right, reservedEnergyDeliveries);

  return (
    compareLowEnergySpawnPriority(left, right) ||
    compareAcceptedDeliveryEnergy(leftDeliveryCapacity, rightDeliveryCapacity, carriedEnergy) ||
    compareAssignedTransferTarget(left, right, assignedTransferTargetId) ||
    compareOptionalRanges(getRangeBetweenRoomObjects(creep, left), getRangeBetweenRoomObjects(creep, right)) ||
    compareEnergySinkId(left, right)
  );
}

function compareLowEnergySpawnPriority(
  left: StructureSpawn | StructureExtension,
  right: StructureSpawn | StructureExtension
): number {
  const leftLowEnergySpawn = isLowEnergySpawn(left);
  const rightLowEnergySpawn = isLowEnergySpawn(right);
  if (leftLowEnergySpawn === rightLowEnergySpawn) {
    return 0;
  }

  return leftLowEnergySpawn ? -1 : 1;
}

function isLowEnergySpawn(structure: StructureSpawn | StructureExtension): structure is StructureSpawn {
  return isSpawnEnergySink(structure) && getStoredEnergy(structure) < getSpawnEnergyCapacity();
}

function getSpawnEnergyCapacity(): number {
  const spawnEnergyCapacity = (globalThis as unknown as { SPAWN_ENERGY_CAPACITY?: number }).SPAWN_ENERGY_CAPACITY;
  return typeof spawnEnergyCapacity === 'number' && Number.isFinite(spawnEnergyCapacity) && spawnEnergyCapacity > 0
    ? spawnEnergyCapacity
    : DEFAULT_SPAWN_ENERGY_CAPACITY;
}

function compareAcceptedDeliveryEnergy(leftCapacity: number, rightCapacity: number, carriedEnergy: number): number {
  if (carriedEnergy <= 0) {
    return 0;
  }

  const leftAcceptedEnergy = Math.min(leftCapacity, carriedEnergy);
  const rightAcceptedEnergy = Math.min(rightCapacity, carriedEnergy);
  return rightAcceptedEnergy - leftAcceptedEnergy;
}

function getUnreservedEnergySinkDeliveryCapacity(
  energySink: FillableEnergySink,
  reservedEnergyDeliveries: Map<string, number>
): number {
  return Math.max(
    0,
    getFreeStoredEnergyCapacity(energySink) - getReservedEnergyDelivery(energySink, reservedEnergyDeliveries)
  );
}

function compareAssignedTransferTarget(
  left: FillableEnergySink,
  right: FillableEnergySink,
  assignedTransferTargetId: string | null
): number {
  const leftAssigned = isAssignedTransferTarget(left, assignedTransferTargetId);
  const rightAssigned = isAssignedTransferTarget(right, assignedTransferTargetId);
  if (leftAssigned === rightAssigned) {
    return 0;
  }

  return leftAssigned ? -1 : 1;
}

function selectPriorityTowerEnergySink(creep: Creep): StructureTower | null {
  const priorityTowerEnergySinks = findFillableEnergySinks(creep).filter(isPriorityTowerEnergySink);
  if (priorityTowerEnergySinks.length === 0) {
    return null;
  }

  const loadedWorkers = getSameRoomLoadedWorkersForRefillReservations(creep);
  const reservedEnergyDeliveries = getReservedEnergyDeliveriesBySinkId(creep, loadedWorkers);
  return selectClosestEnergySink(
    priorityTowerEnergySinks.filter((energySink) =>
      hasUnreservedEnergySinkCapacity(energySink, reservedEnergyDeliveries)
    ),
    creep
  );
}

function hasUnreservedEnergySinkCapacity(
  energySink: FillableEnergySink,
  reservedEnergyDeliveries: Map<string, number>
): boolean {
  return getReservedEnergyDelivery(energySink, reservedEnergyDeliveries) < getFreeStoredEnergyCapacity(energySink);
}

function selectCloserReservedEnergySinkFallback<T extends FillableEnergySink>(
  energySinks: T[],
  creep: Creep,
  loadedWorkers: Creep[],
  reservedEnergyDeliveries: Map<string, number>
): T | null {
  return selectClosestEnergySink(
    energySinks.filter(
      (energySink) =>
        getReservedEnergyDelivery(energySink, reservedEnergyDeliveries) >=
          getFreeStoredEnergyCapacity(energySink) &&
        isCloserThanReservedEnergyDelivery(creep, energySink, loadedWorkers)
    ),
    creep
  );
}

function isCloserThanReservedEnergyDelivery(
  creep: Creep,
  energySink: FillableEnergySink,
  loadedWorkers: Creep[]
): boolean {
  const creepRange = getRangeBetweenRoomObjects(creep, energySink);
  if (creepRange === null) {
    return false;
  }

  let closestReservedDeliveryRange: number | null = null;
  let hasReservedDelivery = false;
  for (const worker of loadedWorkers) {
    if (isSameCreep(worker, creep) || !isWorkerAssignedToEnergySink(worker, energySink)) {
      continue;
    }

    hasReservedDelivery = true;
    const workerRange = getRangeBetweenRoomObjects(worker, energySink);
    if (workerRange === null) {
      continue;
    }

    closestReservedDeliveryRange =
      closestReservedDeliveryRange === null ? workerRange : Math.min(closestReservedDeliveryRange, workerRange);
  }

  if (!hasReservedDelivery) {
    return false;
  }

  return closestReservedDeliveryRange === null ? creepRange <= 1 : creepRange < closestReservedDeliveryRange;
}

function isWorkerAssignedToEnergySink(worker: Creep, energySink: FillableEnergySink): boolean {
  const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'transfer' && String(task.targetId) === String(energySink.id);
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
  energySink: FillableEnergySink,
  reservedEnergyDeliveries: Map<string, number>
): number {
  return reservedEnergyDeliveries.get(String(energySink.id)) ?? 0;
}

function getAssignedTransferTargetId(creep: Creep): string | null {
  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'transfer' && typeof task.targetId === 'string' ? String(task.targetId) : null;
}

function isAssignedTransferTarget(
  energySink: FillableEnergySink,
  assignedTransferTargetId: string | null
): boolean {
  return assignedTransferTargetId !== null && String(energySink.id) === assignedTransferTargetId;
}

function findFillableEnergySinks(creep: Creep): FillableEnergySink[] {
  return findFillableEnergySinksInRoom(creep.room);
}

function findFillableEnergySinksInRoom(room: Room): FillableEnergySink[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const energySinks = room.find(FIND_MY_STRUCTURES, {
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
  predicate: (site: ConstructionSite) => boolean = () => true,
  constructionReservationContext: ConstructionReservationContext = createEmptyConstructionReservationContext()
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
    return [...candidates].sort((left, right) =>
      compareConstructionSiteCandidates(creep, left, right, constructionReservationContext)
    )[0];
  }

  const completableConstructionSite = selectNearTermCompletableConstructionSite(
    creep,
    candidates,
    constructionReservationContext
  );
  if (completableConstructionSite) {
    return completableConstructionSite;
  }

  if (typeof position?.findClosestByRange === 'function') {
    const candidatesByStableId = [...candidates].sort(compareConstructionSiteId);
    return position.findClosestByRange(candidatesByStableId) ?? candidatesByStableId[0];
  }

  return candidates[0];
}

function selectUnreservedConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  predicate: (site: ConstructionSite) => boolean = () => true
): ConstructionSite | null {
  return selectConstructionSite(
    creep,
    constructionSites,
    (site) => predicate(site) && hasUnreservedConstructionProgress(creep, site, constructionReservationContext),
    constructionReservationContext
  );
}

function hasUnreservedConstructionProgress(
  creep: Creep,
  site: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext
): boolean {
  if (isWorkerAssignedToConstructionSite(creep, site)) {
    return true;
  }

  const remainingProgress = getConstructionSiteRemainingProgress(site);
  if (!Number.isFinite(remainingProgress)) {
    return true;
  }

  return remainingProgress > getReservedConstructionProgress(site, constructionReservationContext);
}

function getReservedConstructionProgress(
  site: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext
): number {
  return constructionReservationContext.reservedProgressBySiteId.get(String(site.id)) ?? 0;
}

function createEmptyConstructionReservationContext(): ConstructionReservationContext {
  return { reservedProgressBySiteId: new Map<string, number>() };
}

function createConstructionReservationContext(room: Room): ConstructionReservationContext {
  const reservedProgressBySiteId = new Map<string, number>();
  for (const worker of getRoomOwnedCreeps(room)) {
    if (!isSameRoomWorker(worker, room)) {
      continue;
    }

    const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
    if (task?.type !== 'build' || task.targetId === undefined) {
      continue;
    }

    const siteId = String(task.targetId);
    reservedProgressBySiteId.set(
      siteId,
      (reservedProgressBySiteId.get(siteId) ?? 0) + getUsedEnergy(worker) * getBuildPower()
    );
  }

  return { reservedProgressBySiteId };
}

function getRoomOwnedCreeps(room: Room): Creep[] {
  const findMyCreeps = (globalThis as unknown as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
  if (typeof findMyCreeps === 'number') {
    const roomCreeps = (room as Room & { find?: (type: number) => Creep[] }).find?.(findMyCreeps);
    if (Array.isArray(roomCreeps)) {
      return roomCreeps;
    }
  }

  return getGameCreeps().filter((worker) => isSameRoomWorker(worker, room));
}

function isWorkerAssignedToConstructionSite(worker: Creep, site: ConstructionSite): boolean {
  const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'build' && String(task.targetId) === String(site.id);
}

function selectNearTermCompletableConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ConstructionSite | null {
  const candidates = constructionSites.filter((site) =>
    canCompleteConstructionSiteWithCarriedEnergy(creep, site, constructionReservationContext)
  );
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareNearTermCompletableConstructionSites)[0];
}

function compareConstructionSiteCandidates(
  creep: Creep,
  left: ConstructionSite,
  right: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext
): number {
  return (
    compareConstructionSiteCompletion(creep, left, right, constructionReservationContext) ||
    compareOptionalRanges(getRangeBetweenRoomObjects(creep, left), getRangeBetweenRoomObjects(creep, right)) ||
    compareConstructionSiteId(left, right)
  );
}

function compareConstructionSiteCompletion(
  creep: Creep,
  left: ConstructionSite,
  right: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext
): number {
  const leftCompletable = canCompleteConstructionSiteWithCarriedEnergy(
    creep,
    left,
    constructionReservationContext
  );
  const rightCompletable = canCompleteConstructionSiteWithCarriedEnergy(
    creep,
    right,
    constructionReservationContext
  );
  if (leftCompletable !== rightCompletable) {
    return leftCompletable ? -1 : 1;
  }

  return leftCompletable && rightCompletable ? compareNearTermCompletableConstructionSites(left, right) : 0;
}

function compareNearTermCompletableConstructionSites(left: ConstructionSite, right: ConstructionSite): number {
  return (
    getConstructionSiteRemainingProgress(left) -
      getConstructionSiteRemainingProgress(right) ||
    compareConstructionSiteId(left, right)
  );
}

function canCompleteConstructionSiteWithCarriedEnergy(
  creep: Creep,
  site: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext = createEmptyConstructionReservationContext()
): boolean {
  const remainingProgress = getUnreservedConstructionProgressForWorker(
    creep,
    site,
    constructionReservationContext
  );
  return remainingProgress > 0 && remainingProgress <= getUsedEnergy(creep) * getBuildPower();
}

function getUnreservedConstructionProgressForWorker(
  creep: Creep,
  site: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext
): number {
  const remainingProgress = getConstructionSiteRemainingProgress(site);
  if (!Number.isFinite(remainingProgress)) {
    return remainingProgress;
  }

  const reservedProgress = getReservedConstructionProgress(site, constructionReservationContext);
  const workerReservedProgress = isWorkerAssignedToConstructionSite(creep, site)
    ? getUsedEnergy(creep) * getBuildPower()
    : 0;

  return Math.max(0, remainingProgress - Math.max(0, reservedProgress - workerReservedProgress));
}

function getConstructionSiteRemainingProgress(site: ConstructionSite): number {
  const progress = (site as ConstructionSite & { progress?: number }).progress;
  const progressTotal = (site as ConstructionSite & { progressTotal?: number }).progressTotal;
  if (
    typeof progress !== 'number' ||
    typeof progressTotal !== 'number' ||
    !Number.isFinite(progress) ||
    !Number.isFinite(progressTotal)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Math.ceil(progressTotal - progress));
}

function getBuildPower(): number {
  return typeof BUILD_POWER === 'number' && Number.isFinite(BUILD_POWER) && BUILD_POWER > 0
    ? BUILD_POWER
    : DEFAULT_BUILD_POWER;
}

function compareConstructionSiteId(left: ConstructionSite, right: ConstructionSite): number {
  return String(left.id).localeCompare(String(right.id));
}

function selectCriticalRoadConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext = createEmptyConstructionReservationContext()
): ConstructionSite | null {
  if (!constructionSites.some(isRoadConstructionSite)) {
    return null;
  }

  const criticalRoadContext = buildWorkerCriticalRoadLogisticsContext(creep);
  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    (site) => isCriticalRoadLogisticsWork(site, criticalRoadContext)
  );
}

function selectNearbyProductiveEnergySinkTask(
  creep: Creep,
  constructionSites: ConstructionSite[],
  controller: StructureController,
  constructionReservationContext: ConstructionReservationContext
): ProductiveEnergySinkTask | null {
  const controllerRange = getRangeBetweenRoomObjects(creep, controller);
  if (controllerRange === null) {
    return null;
  }

  const candidates = [
    ...constructionSites
      .filter((site) => hasUnreservedConstructionProgress(creep, site, constructionReservationContext))
      .map((site) =>
        createProductiveEnergySinkCandidate(
          creep,
          site,
          { type: 'build', targetId: site.id },
          0,
          canCompleteConstructionSiteWithCarriedEnergy(creep, site, constructionReservationContext)
        )
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
  taskPriority: number,
  canCompleteConstruction = false
): ProductiveEnergySinkCandidate | null {
  const range = getRangeBetweenRoomObjects(creep, target);
  if (range === null) {
    return null;
  }

  return { canCompleteConstruction, range, task, taskPriority };
}

function compareProductiveEnergySinkCandidates(
  left: ProductiveEnergySinkCandidate,
  right: ProductiveEnergySinkCandidate
): number {
  return (
    compareProductiveEnergySinkCompletion(left, right) ||
    left.range - right.range ||
    left.taskPriority - right.taskPriority ||
    String(left.task.targetId).localeCompare(String(right.task.targetId))
  );
}

function compareProductiveEnergySinkCompletion(
  left: ProductiveEnergySinkCandidate,
  right: ProductiveEnergySinkCandidate
): number {
  if (left.canCompleteConstruction === right.canCompleteConstruction) {
    return 0;
  }

  return left.canCompleteConstruction ? -1 : 1;
}

function selectCapacityEnablingConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  controller: StructureController | undefined,
  constructionReservationContext: ConstructionReservationContext
): ConstructionSite | null {
  const spawnConstructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isSpawnConstructionSite
  );
  if (spawnConstructionSite) {
    return spawnConstructionSite;
  }

  if (controller && shouldRushRcl1Controller(controller)) {
    return null;
  }

  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isExtensionConstructionSite
  );
}

function selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(
  creep: Creep,
  capacityConstructionSite: ConstructionSite | null,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ConstructionSite | null {
  if (
    !capacityConstructionSite ||
    !isExtensionConstructionSite(capacityConstructionSite) ||
    shouldPrioritizeExtensionCapacity(creep.room)
  ) {
    return null;
  }

  return (
    selectCriticalRoadConstructionSite(creep, constructionSites, constructionReservationContext) ??
    selectUnreservedConstructionSite(
      creep,
      constructionSites,
      constructionReservationContext,
      isContainerConstructionSite
    )
  );
}

function shouldPrioritizeExtensionCapacity(room: Room): boolean {
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  return (
    energyCapacityAvailable === null ||
    energyCapacityAvailable < BASELINE_WORKER_THROUGHPUT_ENERGY_CAPACITY
  );
}

function selectReadyFollowUpProductiveEnergySinkTask(
  creep: Creep,
  capacityConstructionSite: ConstructionSite | null,
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ProductiveEnergySinkTask | null {
  if (!hasReadyTerritoryFollowUpEnergy(creep)) {
    return null;
  }

  const baselineLogisticsConstructionSite = selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(
    creep,
    capacityConstructionSite,
    constructionSites,
    constructionReservationContext
  );
  if (baselineLogisticsConstructionSite) {
    return { type: 'build', targetId: baselineLogisticsConstructionSite.id };
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

  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
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

interface SpawnRecoveryHarvestCandidate {
  deliveryEta: number;
  load: HarvestSourceLoad;
  source: Source;
}

interface ProductiveEnergySinkCandidate {
  canCompleteConstruction: boolean;
  range: number;
  task: ProductiveEnergySinkTask;
  taskPriority: number;
}

interface WorkerEnergyAcquisitionReservationContext {
  reservedEnergyBySourceId: Map<string, number>;
}

interface WorkerEnergyAcquisitionSearchOptions {
  maximumRange?: number;
  minimumDroppedEnergy?: number;
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

function selectLowLoadWorkerEnergyContinuationTask(creep: Creep): LowLoadWorkerEnergyAcquisitionTask | null {
  const candidate = selectLowLoadWorkerEnergyContinuationCandidate(creep);
  if (!candidate) {
    return null;
  }

  recordNearbyEnergyChoiceTelemetry(creep, candidate);
  return candidate.task;
}

function selectLowLoadWorkerEnergyContinuationCandidate(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  if (!shouldKeepLowLoadWorkerAcquiringEnergy(creep)) {
    return null;
  }

  const candidates = findLowLoadWorkerEnergyContinuationCandidates(creep).filter(
    isLowLoadWorkerEnergyContinuationCandidateInRange
  );
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareLowLoadWorkerEnergyAcquisitionCandidates)[0];
}

function shouldKeepLowLoadWorkerAcquiringEnergy(creep: Creep): boolean {
  return getLowLoadWorkerEnergyContext(creep) !== null && !hasVisibleHostilePresence(creep.room);
}

function findLowLoadWorkerEnergyContinuationCandidates(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  // Use the normal candidate set so continuation can take close energy beyond the nearby-only fast path.
  return [
    ...findWorkerEnergyAcquisitionCandidates(creep, {
      maximumRange: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
    }).map(toLowLoadWorkerEnergyAcquisitionCandidate),
    ...findLowLoadHarvestEnergyAcquisitionCandidates(creep)
  ];
}

function findLowLoadWorkerEnergyAcquisitionCandidates(creep: Creep): LowLoadWorkerEnergyAcquisitionCandidate[] {
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);

  return [
    ...findNearbyLowLoadStoredEnergyAcquisitionCandidates(creep, reservationContext),
    ...findNearbyLowLoadSalvageEnergyAcquisitionCandidates(creep, reservationContext),
    ...findNearbyLowLoadDroppedEnergyAcquisitionCandidates(creep, reservationContext),
    ...findLowLoadHarvestEnergyAcquisitionCandidates(creep)
  ];
}

function findNearbyLowLoadStoredEnergyAcquisitionCandidates(
  creep: Creep,
  reservationContext: WorkerEnergyAcquisitionReservationContext
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };

  return findVisibleRoomStructures(creep.room)
    .filter((structure): structure is StoredWorkerEnergySource => isSafeStoredEnergySource(structure, context))
    .filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source))
    .flatMap((source) => {
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        source,
        getStoredEnergy(source),
        {
          type: 'withdraw',
          targetId: source.id as Id<AnyStoreStructure>
        },
        reservationContext
      );

      return candidate ? [toLowLoadWorkerEnergyAcquisitionCandidate(candidate)] : [];
    });
}

function findNearbyLowLoadSalvageEnergyAcquisitionCandidates(
  creep: Creep,
  reservationContext: WorkerEnergyAcquisitionReservationContext
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  return [...findTombstones(creep.room), ...findRuins(creep.room)]
    .filter(hasSalvageableEnergy)
    .filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source))
    .flatMap((source) => {
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        source,
        getStoredEnergy(source),
        {
          type: 'withdraw',
          targetId: source.id as unknown as Id<AnyStoreStructure>
        },
        reservationContext,
        MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT
      );

      return candidate ? [toLowLoadWorkerEnergyAcquisitionCandidate(candidate)] : [];
    });
}

function findNearbyLowLoadDroppedEnergyAcquisitionCandidates(
  creep: Creep,
  reservationContext: WorkerEnergyAcquisitionReservationContext
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  return findDroppedResources(creep.room)
    .filter(isUsefulDroppedEnergy)
    .filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source))
    .flatMap((source) => {
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        source,
        source.amount,
        {
          type: 'pickup',
          targetId: source.id
        },
        reservationContext,
        MIN_DROPPED_ENERGY_PICKUP_AMOUNT
      );

      return candidate ? [toLowLoadWorkerEnergyAcquisitionCandidate(candidate)] : [];
    })
    .filter((candidate) => isReachable(creep, candidate.source));
}

function isNearbyLowLoadWorkerEnergyAcquisitionSource(
  creep: Creep,
  source: LowLoadWorkerEnergyAcquisitionSource
): boolean {
  const range = getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source);
  return range !== null && range <= LOW_LOAD_NEARBY_ENERGY_RANGE;
}

function isLowLoadWorkerEnergyContinuationCandidateInRange(
  candidate: LowLoadWorkerEnergyAcquisitionCandidate
): boolean {
  return candidate.range !== null && candidate.range <= LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE;
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
  energySink: FillableEnergySink,
  harvestEta: number | null = estimateHarvestDeliveryEta(creep, energySink)
): WorkerEnergyAcquisitionTask | null {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep, {
    minimumDroppedEnergy: MIN_SPAWN_RECOVERY_DROPPED_ENERGY_PICKUP_AMOUNT
  })
    .map((candidate) => createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink))
    .filter((candidate): candidate is SpawnRecoveryEnergyAcquisitionCandidate => candidate !== null)
    .filter((candidate) => harvestEta === null || candidate.deliveryEta <= harvestEta);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareSpawnRecoveryEnergyAcquisitionCandidates)[0].task;
}

function selectSpawnRecoveryHarvestCandidate(
  creep: Creep,
  energySink: FillableEnergySink
): SpawnRecoveryHarvestCandidate | null {
  const sources = creep.room.find(FIND_SOURCES);
  if (sources.length === 0) {
    return null;
  }

  const viableSources = selectViableHarvestSources(
    sources,
    getSpawnRecoveryHarvestEnergyTarget(creep, energySink)
  );
  const assignmentLoads = getSameRoomWorkerHarvestLoads(creep.room.name, viableSources);
  const candidates = viableSources
    .map((source) =>
      createSpawnRecoveryHarvestCandidate(
        creep,
        source,
        energySink,
        getHarvestSourceAssignmentLoad(assignmentLoads, source)
      )
    )
    .filter((candidate): candidate is SpawnRecoveryHarvestCandidate => candidate !== null);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareSpawnRecoveryHarvestCandidates)[0];
}

function createSpawnRecoveryHarvestCandidate(
  creep: Creep,
  source: Source,
  energySink: FillableEnergySink,
  assignmentLoad: HarvestSourceAssignmentLoad
): SpawnRecoveryHarvestCandidate | null {
  const deliveryEta = estimateHarvestDeliveryEtaFromSource(creep, source, energySink);
  if (deliveryEta === null || !Number.isFinite(deliveryEta)) {
    return null;
  }

  return {
    deliveryEta,
    load: createHarvestSourceLoad(source, assignmentLoad),
    source
  };
}

function findWorkerEnergyAcquisitionCandidates(
  creep: Creep,
  options: WorkerEnergyAcquisitionSearchOptions = {}
): WorkerEnergyAcquisitionCandidate[] {
  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const storedEnergyCandidates = findVisibleRoomStructures(creep.room)
    .filter((structure): structure is StoredWorkerEnergySource => isSafeStoredEnergySource(structure, context))
    .flatMap((source) => {
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        source,
        getStoredEnergy(source),
        {
          type: 'withdraw',
          targetId: source.id as Id<AnyStoreStructure>
        },
        reservationContext
      );

      return candidate ? [candidate] : [];
    })
    .filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options));
  const salvageEnergyCandidates = [...findTombstones(creep.room), ...findRuins(creep.room)]
    .filter(hasSalvageableEnergy)
    .flatMap((source) => {
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        source,
        getStoredEnergy(source),
        {
          type: 'withdraw',
          targetId: source.id as unknown as Id<AnyStoreStructure>
        },
        reservationContext,
        MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT
      );

      return candidate ? [candidate] : [];
    })
    .filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options));
  const droppedEnergyCandidates = findDroppedEnergyAcquisitionCandidates(creep, reservationContext, options);

  return [...storedEnergyCandidates, ...salvageEnergyCandidates, ...droppedEnergyCandidates];
}

function findDroppedEnergyAcquisitionCandidates(
  creep: Creep,
  reservationContext: WorkerEnergyAcquisitionReservationContext,
  options: WorkerEnergyAcquisitionSearchOptions = {}
): WorkerEnergyAcquisitionCandidate[] {
  const minimumEnergy = options.minimumDroppedEnergy ?? MIN_DROPPED_ENERGY_PICKUP_AMOUNT;

  return findDroppedResources(creep.room)
    .filter((resource): resource is Resource<ResourceConstant> => isDroppedEnergy(resource, minimumEnergy))
    .flatMap((source) => {
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        source,
        source.amount,
        {
          type: 'pickup',
          targetId: source.id
        },
        reservationContext,
        minimumEnergy
      );

      return candidate ? [candidate] : [];
    })
    .filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options))
    .sort(compareDroppedEnergyReachabilityPriority)
    .slice(0, MAX_DROPPED_ENERGY_REACHABILITY_CHECKS)
    .filter((candidate) => isReachable(creep, candidate.source));
}

function isWorkerEnergyAcquisitionCandidateWithinSearchRange(
  candidate: WorkerEnergyAcquisitionCandidate,
  options: WorkerEnergyAcquisitionSearchOptions
): boolean {
  return options.maximumRange === undefined || (candidate.range !== null && candidate.range <= options.maximumRange);
}

function createUnreservedWorkerEnergyAcquisitionCandidate(
  creep: Creep,
  source: WorkerEnergyAcquisitionSource,
  energy: number,
  task: WorkerEnergyAcquisitionTask,
  reservationContext: WorkerEnergyAcquisitionReservationContext,
  minimumEnergy = 1
): WorkerEnergyAcquisitionCandidate | null {
  const unreservedEnergy = getUnreservedWorkerEnergyAcquisitionAmount(source, energy, reservationContext);
  if (unreservedEnergy < minimumEnergy) {
    return null;
  }

  return createWorkerEnergyAcquisitionCandidate(creep, source, unreservedEnergy, task);
}

function createWorkerEnergyAcquisitionCandidate(
  creep: Creep,
  source: WorkerEnergyAcquisitionSource,
  energy: number,
  task: WorkerEnergyAcquisitionTask
): WorkerEnergyAcquisitionCandidate {
  const range = getRangeToWorkerEnergyAcquisitionSource(creep, source);
  const energyScore = scoreWorkerEnergyAcquisitionAmount(energy, getFreeEnergyCapacity(creep));

  return {
    energy,
    range,
    score: range === null ? energyScore : energyScore - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task
  };
}

function scoreWorkerEnergyAcquisitionAmount(energy: number, freeCapacity: number): number {
  if (freeCapacity <= 0) {
    return energy;
  }

  const immediateTripEnergy = Math.min(energy, freeCapacity);
  const surplusEnergy = Math.max(0, energy - immediateTripEnergy);
  return immediateTripEnergy + surplusEnergy * WORKER_ENERGY_SURPLUS_SCORE_RATIO;
}

function createWorkerEnergyAcquisitionReservationContext(creep: Creep): WorkerEnergyAcquisitionReservationContext {
  return {
    reservedEnergyBySourceId: getReservedWorkerEnergyAcquisitionsBySourceId(creep)
  };
}

function getReservedWorkerEnergyAcquisitionsBySourceId(creep: Creep): Map<string, number> {
  const reservedEnergyBySourceId = new Map<string, number>();
  for (const worker of getGameCreeps()) {
    if (isSameCreep(worker, creep) || !isSameRoomWorker(worker, creep.room)) {
      continue;
    }

    const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
    if (!isWorkerEnergyAcquisitionReservationTask(task)) {
      continue;
    }

    const freeCapacity = getFreeEnergyCapacity(worker);
    if (freeCapacity <= 0) {
      continue;
    }

    const sourceId = String(task.targetId);
    reservedEnergyBySourceId.set(sourceId, (reservedEnergyBySourceId.get(sourceId) ?? 0) + freeCapacity);
  }

  return reservedEnergyBySourceId;
}

function isWorkerEnergyAcquisitionReservationTask(
  task: Partial<CreepTaskMemory> | undefined
): task is WorkerEnergyAcquisitionTask {
  return (
    (task?.type === 'pickup' || task?.type === 'withdraw') &&
    typeof task.targetId === 'string' &&
    task.targetId.length > 0
  );
}

function getUnreservedWorkerEnergyAcquisitionAmount(
  source: WorkerEnergyAcquisitionSource,
  energy: number,
  reservationContext: WorkerEnergyAcquisitionReservationContext
): number {
  return Math.max(0, energy - (reservationContext.reservedEnergyBySourceId.get(String(source.id)) ?? 0));
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

  return estimateHarvestDeliveryEtaFromSource(creep, source, energySink);
}

function estimateHarvestDeliveryEtaFromSource(
  creep: Creep,
  source: Source,
  energySink: FillableEnergySink
): number | null {
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
  const energyNeeded = getSpawnRecoveryHarvestEnergyTarget(creep, energySink);
  const workParts = getActiveWorkParts(creep);
  if (workParts === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.ceil(energyNeeded / Math.max(HARVEST_ENERGY_PER_WORK_PART, workParts * HARVEST_ENERGY_PER_WORK_PART));
}

function getSpawnRecoveryHarvestEnergyTarget(creep: Creep, energySink: FillableEnergySink): number {
  return Math.max(1, Math.min(getFreeEnergyCapacity(creep), getFreeStoredEnergyCapacity(energySink)));
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
  const workPart = getBodyPartConstant('WORK', 'work');
  const activeWorkParts = creep.getActiveBodyparts?.(workPart);
  if (typeof activeWorkParts === 'number' && Number.isFinite(activeWorkParts)) {
    return Math.max(0, Math.floor(activeWorkParts));
  }

  const bodyWorkParts = countActiveBodyParts(creep.body, workPart);
  return bodyWorkParts ?? 1;
}

function countActiveBodyParts(body: unknown, bodyPartType: BodyPartConstant): number | null {
  if (!Array.isArray(body)) {
    return null;
  }

  return body.filter((part) => isActiveBodyPart(part, bodyPartType)).length;
}

function isActiveBodyPart(part: unknown, bodyPartType: BodyPartConstant): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }

  const bodyPart = part as Partial<BodyPartDefinition>;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === 'number' && bodyPart.hits > 0;
}

function getBodyPartConstant(globalName: 'WORK', fallback: BodyPartConstant): BodyPartConstant {
  const constants = globalThis as unknown as Partial<Record<'WORK', BodyPartConstant>>;
  return constants[globalName] ?? fallback;
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

function compareSpawnRecoveryHarvestCandidates(
  left: SpawnRecoveryHarvestCandidate,
  right: SpawnRecoveryHarvestCandidate
): number {
  return (
    compareHarvestSourceLoadRatio(left.load, right.load) ||
    left.load.assignmentCount - right.load.assignmentCount ||
    left.deliveryEta - right.deliveryEta ||
    String(left.source.id).localeCompare(String(right.source.id))
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
  const hasControllerProgressPressure = hasActiveControllerProgressPressure(creep);
  const hasTerritoryExpansionPressure = hasActiveTerritoryExpansionPressure(creep);
  if (
    loadedWorkers.length < MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS &&
    !(loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE && hasControllerProgressPressure)
  ) {
    return false;
  }

  const controllerProgressWorkers = getControllerProgressWorkerLimit(
    creep,
    loadedWorkers.length,
    hasTerritoryExpansionPressure
  );
  const otherControllerUpgraders = loadedWorkers.filter(
    (worker) => !isSameCreep(worker, creep) && isUpgradingController(worker, controller)
  ).length;
  return otherControllerUpgraders < controllerProgressWorkers;
}

function getControllerProgressWorkerLimit(
  creep: Creep,
  loadedWorkerCount: number,
  hasTerritoryExpansionPressure: boolean
): number {
  if (hasTerritoryExpansionPressure) {
    return 1;
  }

  if (
    loadedWorkerCount >= MIN_LOADED_WORKERS_FOR_SURPLUS_CONTROLLER_PROGRESS &&
    hasControllerUpgradeEnergySurplus(creep)
  ) {
    return MAX_SURPLUS_CONTROLLER_PROGRESS_WORKERS;
  }

  return loadedWorkerCount >= MIN_LOADED_WORKERS_FOR_SECOND_SUSTAINED_CONTROLLER_PROGRESS
    ? MAX_SUSTAINED_CONTROLLER_PROGRESS_WORKERS
    : 1;
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
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ProductiveEnergySinkTask | Extract<CreepTaskMemory, { type: 'upgrade' }> | null {
  if (!shouldApplySource2ControllerLane(creep, controller)) {
    return null;
  }

  const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(
    creep,
    constructionSites,
    controller,
    constructionReservationContext
  );
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

function hasActiveControllerProgressPressure(creep: Creep): boolean {
  const colonyName = getCreepColonyName(creep);
  if (!colonyName) {
    return false;
  }

  if (getRecordedColonySurvivalAssessment(colonyName)?.mode === 'TERRITORY_READY') {
    return true;
  }

  return hasActiveTerritoryExpansionPressure(creep);
}

function hasActiveTerritoryExpansionPressure(creep: Creep): boolean {
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

function hasControllerUpgradeEnergySurplus(creep: Creep): boolean {
  return hasRecoverableSurplusEnergy(creep) || hasFullRoomEnergyForControllerProgress(creep.room);
}

function hasFullRoomEnergyForControllerProgress(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  return (
    energyAvailable !== null &&
    energyCapacityAvailable !== null &&
    energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST &&
    energyAvailable >= energyCapacityAvailable
  );
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

function getCreepColonyRoom(creep: Creep): Room | null {
  const colonyName = getCreepColonyName(creep);
  if (!colonyName) {
    return null;
  }

  return (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[colonyName] ?? null;
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
  return getSameRoomLoadedWorkersFromCandidates(creep, getGameCreeps());
}

function getSameRoomLoadedWorkersForRefillReservations(creep: Creep): Creep[] {
  return getSameRoomLoadedWorkersFromCandidates(creep, getRoomOwnedCreeps(creep.room));
}

function getSameRoomLoadedWorkersFromCandidates(creep: Creep, candidates: Creep[]): Creep[] {
  const loadedWorkers = candidates.filter((candidate) => isSameRoomWorkerWithEnergy(candidate, creep.room));

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
  getCapacity?: (resource?: ResourceConstant) => number | null;
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

function getEnergyCapacity(
  creep: Creep,
  carriedEnergy = getUsedEnergy(creep),
  freeCapacity = getFreeEnergyCapacity(creep)
): number {
  const store = getStore(creep);
  const capacity = store?.getCapacity?.(getWorkerEnergyResource());
  if (typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0) {
    return capacity;
  }

  return Math.max(0, carriedEnergy + freeCapacity);
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
  return isDroppedEnergy(resource, MIN_DROPPED_ENERGY_PICKUP_AMOUNT);
}

function isDroppedEnergy(resource: Resource, minimumEnergy: number): resource is Resource<ResourceConstant> {
  return resource.resourceType === getWorkerEnergyResource() && resource.amount >= minimumEnergy;
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

  const viableSources = selectViableHarvestSources(sources, getHarvestEnergyTarget(creep));
  const assignmentLoads = getSameRoomWorkerHarvestLoads(creep.room.name, viableSources);
  const sourceLoads = viableSources.map((source) =>
    createHarvestSourceLoad(source, getHarvestSourceAssignmentLoad(assignmentLoads, source))
  );
  let selectedLoad = sourceLoads[0];

  for (const sourceLoad of sourceLoads.slice(1)) {
    if (compareHarvestSourceLoads(creep, sourceLoad, selectedLoad) < 0) {
      selectedLoad = sourceLoad;
    }
  }

  return selectedLoad.source;
}

function compareHarvestSourceLoads(creep: Creep, left: HarvestSourceLoad, right: HarvestSourceLoad): number {
  const workLoadRatioComparison = compareHarvestSourceWorkLoadRatio(left, right);
  if (workLoadRatioComparison !== 0) {
    return workLoadRatioComparison;
  }

  const accessLoadRatioComparison = compareHarvestSourceAccessLoadRatio(left, right);
  if (accessLoadRatioComparison !== 0) {
    return accessLoadRatioComparison;
  }

  const assignmentComparison = left.assignmentCount - right.assignmentCount;
  if (assignmentComparison !== 0) {
    return assignmentComparison;
  }

  const assignedWorkComparison = left.assignedWorkParts - right.assignedWorkParts;
  if (assignedWorkComparison !== 0) {
    return assignedWorkComparison;
  }

  if (isCloserHarvestSource(creep, left.source, right.source)) {
    return -1;
  }

  if (isCloserHarvestSource(creep, right.source, left.source)) {
    return 1;
  }

  return 0;
}

function compareHarvestSourceLoadRatio(left: HarvestSourceLoad, right: HarvestSourceLoad): number {
  return compareHarvestSourceWorkLoadRatio(left, right) || compareHarvestSourceAccessLoadRatio(left, right);
}

function compareHarvestSourceWorkLoadRatio(left: HarvestSourceLoad, right: HarvestSourceLoad): number {
  return left.assignedWorkParts * right.workCapacity - right.assignedWorkParts * left.workCapacity;
}

function compareHarvestSourceAccessLoadRatio(left: HarvestSourceLoad, right: HarvestSourceLoad): number {
  return left.assignmentCount * right.accessCapacity - right.assignmentCount * left.accessCapacity;
}

function createHarvestSourceLoad(
  source: Source,
  assignmentLoad: HarvestSourceAssignmentLoad
): HarvestSourceLoad {
  return {
    ...assignmentLoad,
    accessCapacity: getHarvestSourceAccessCapacity(source),
    workCapacity: getHarvestSourceWorkCapacity(source),
    source
  };
}

function getHarvestSourceAssignmentLoad(
  assignmentLoads: Map<Id<Source>, HarvestSourceAssignmentLoad>,
  source: Source
): HarvestSourceAssignmentLoad {
  return assignmentLoads.get(source.id) ?? createEmptyHarvestSourceAssignmentLoad();
}

function createEmptyHarvestSourceAssignmentLoad(): HarvestSourceAssignmentLoad {
  return { assignedWorkParts: 0, assignmentCount: 0 };
}

function getHarvestSourceAccessCapacity(source: Source): number {
  const position = getRoomObjectPosition(source);
  if (!position) {
    return 1;
  }

  const terrain = getRoomTerrain(position.roomName);
  if (!terrain) {
    return 1;
  }

  const wallMask = getTerrainWallMask();
  let capacity = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      const x = position.x + dx;
      const y = position.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) {
        continue;
      }

      if ((terrain.get(x, y) & wallMask) === 0) {
        capacity += 1;
      }
    }
  }

  return Math.max(1, capacity);
}

function getHarvestSourceWorkCapacity(source: Source): number {
  const energyCapacity = getHarvestSourceEnergyCapacity(source);
  const regenTicks = getSourceEnergyRegenTicks();
  return Math.max(1, Math.ceil(energyCapacity / regenTicks / HARVEST_ENERGY_PER_WORK_PART));
}

function getHarvestSourceEnergyCapacity(source: Source): number {
  const sourceEnergyCapacity = source.energyCapacity;
  if (typeof sourceEnergyCapacity === 'number' && Number.isFinite(sourceEnergyCapacity) && sourceEnergyCapacity > 0) {
    return sourceEnergyCapacity;
  }

  const defaultSourceEnergyCapacity = (globalThis as unknown as { SOURCE_ENERGY_CAPACITY?: number })
    .SOURCE_ENERGY_CAPACITY;
  return typeof defaultSourceEnergyCapacity === 'number' &&
    Number.isFinite(defaultSourceEnergyCapacity) &&
    defaultSourceEnergyCapacity > 0
    ? defaultSourceEnergyCapacity
    : DEFAULT_SOURCE_ENERGY_CAPACITY;
}

function getSourceEnergyRegenTicks(): number {
  const regenTicks = (globalThis as unknown as { ENERGY_REGEN_TIME?: number }).ENERGY_REGEN_TIME;
  return typeof regenTicks === 'number' && Number.isFinite(regenTicks) && regenTicks > 0
    ? regenTicks
    : DEFAULT_SOURCE_ENERGY_REGEN_TICKS;
}

function getRoomTerrain(roomName: string): RoomTerrain | null {
  const map = (globalThis as unknown as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map;
  if (typeof map?.getRoomTerrain !== 'function') {
    return null;
  }

  return map.getRoomTerrain(roomName);
}

function getTerrainWallMask(): number {
  const terrainWallMask = (globalThis as unknown as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof terrainWallMask === 'number' ? terrainWallMask : 1;
}

function isCloserHarvestSource(creep: Creep, candidate: Source, selected: Source): boolean {
  const candidateRange = getRangeBetweenRoomObjects(creep, candidate);
  const selectedRange = getRangeBetweenRoomObjects(creep, selected);
  return candidateRange !== null && selectedRange !== null && candidateRange < selectedRange;
}

function selectViableHarvestSources(sources: Source[], harvestEnergyTarget: number): Source[] {
  const sourcesWithEnergy = sources.filter(hasHarvestableEnergy);
  if (sourcesWithEnergy.length === 0) {
    return sources;
  }

  const targetEnergy = Math.max(1, Math.ceil(harvestEnergyTarget));
  const loadReadySources = sourcesWithEnergy.filter(
    (source) => getHarvestSourceAvailableEnergy(source) >= targetEnergy
  );
  return loadReadySources.length > 0 ? loadReadySources : sourcesWithEnergy;
}

function hasHarvestableEnergy(source: Source): boolean {
  return getHarvestSourceAvailableEnergy(source) > 0;
}

function getHarvestSourceAvailableEnergy(source: Source): number {
  const energy = source.energy;
  if (typeof energy === 'number' && Number.isFinite(energy)) {
    return Math.max(0, energy);
  }

  return getHarvestSourceEnergyCapacity(source);
}

function getHarvestEnergyTarget(creep: Creep): number {
  return Math.max(1, getFreeEnergyCapacity(creep));
}

function getSameRoomWorkerHarvestLoads(
  roomName: string | undefined,
  sources: Source[]
): Map<Id<Source>, HarvestSourceAssignmentLoad> {
  const assignmentLoads = new Map<Id<Source>, HarvestSourceAssignmentLoad>();
  for (const source of sources) {
    assignmentLoads.set(source.id, createEmptyHarvestSourceAssignmentLoad());
  }

  if (!roomName) {
    return assignmentLoads;
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
    const currentLoad = assignmentLoads.get(sourceId) ?? createEmptyHarvestSourceAssignmentLoad();
    assignmentLoads.set(sourceId, {
      assignedWorkParts: currentLoad.assignedWorkParts + getActiveWorkParts(assignedCreep),
      assignmentCount: currentLoad.assignmentCount + 1
    });
  }

  return assignmentLoads;
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return creeps ? Object.values(creeps) : [];
}
