import {
  hasActiveTerritoryFollowUpPreparationDemand,
  selectUrgentVisibleReservationRenewalTask,
  selectVisibleTerritoryControllerTask
} from '../territory/territoryPlanner';
import { shouldSignOwnedRoomController } from '../territory/controllerSigning';
import {
  getControllerUpgradePriority
} from '../creeps/upgraderRunner';
import {
  getRecordedColonySurvivalAssessment,
  suppressesBootstrapNonCriticalWork,
  suppressesTerritoryWork,
  type ColonySurvivalAssessment
} from '../colony/colonyStage';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import {
  buildCriticalRoadLogisticsContext,
  isCriticalRoadLogisticsWork,
  isRemoteTerritoryLogisticsRoom,
  isSelfReservedRoom,
  type CriticalRoadLogisticsContext
} from '../construction/criticalRoads';
import { isColonyRoomThreatened } from '../defense/colonyThreats';
import {
  BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING,
  shouldGateTerritoryOnBootstrapDefenseFloor,
  shouldUseBootstrapDefenseFloorRepairCap
} from '../defense/defensePlanner';
import {
  CONSTRUCTION_SITE_IMPACT_PRIORITY,
  DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE,
  getConstructionSiteImpactPriority,
  isPostClaimConstructionRoom,
  shouldPrioritizeSourceLogisticsConstruction,
  type ConstructionSiteImpactPriorityContext
} from '../construction/constructionPriority';
import {
  checkEnergyBufferForCapacityEnablingConstruction,
  checkEnergyBufferForConstructionSpending,
  checkEnergyBufferForExtensionConstruction,
  checkEnergyBufferForStoredConstructionSpending,
  getEffectiveRoomEnergyBufferThreshold,
  getConstructionSpendingEnergyThreshold,
  getStorageEnergyAvailableForWithdrawal,
  getStorageEnergyReserveThreshold,
  hasMinimumWorkerSpawnEnergyForConstruction,
  MINIMUM_WORKER_SPAWN_ENERGY,
  withdrawFromStorage
} from '../economy/energyBuffer';
import {
  getSpawnEnergyAvailableForWithdrawal,
  isSpawnEnergySource
} from '../economy/spawnEnergyBuffer';
import {
  getReservableContainerEnergy,
  hasSubstantialContainerEnergy
} from '../economy/containerEnergy';
import {
  getRoomSpawnEnergyReservationState,
  getUnmetSpawnEnergyReservation
} from '../economy/spawnEnergyReservation';
import { CROSS_ROOM_HAULER_ROLE, isLiveTransferCandidate } from '../economy/crossRoomHauler';
import { selectEnergySurplusDeliverySink } from '../economy/energySurplus';
import { getStorageBalanceState } from '../economy/storageBalancer';
import { findSourceContainer } from '../economy/sourceContainers';
import {
  isControllerStagingContainer,
  isSpawnStagingContainer,
  type EnergyStagingContainerRole
} from '../economy/stagingContainers';
import {
  classifyLinks,
  getSourceLinkWorkerEnergyAvailable,
  isSourceLink,
  type LinkNetwork,
  SOURCE_LINK_RANGE
} from '../economy/linkManager';
import { SOURCE_HARVESTER_ROLE } from '../creeps/sourceHarvester';
import { recordWorkerTaskBehaviorTrace } from '../rl/workerTaskBehavior';
import { selectWorkerTaskWithBcFallback } from '../rl/workerTaskPolicy';
import { getRuntimeCpuBudget, shouldShedNonessentialCpuWork } from '../runtime/cpuBudget';
import { selectSeasonScoreCollectionTask } from '../season/scoreCollection';

// Low-downgrade safety floor: enough buffer for worker travel/recovery without treating healthy controllers as urgent.
export const CONTROLLER_DOWNGRADE_GUARD_TICKS = 5_000;
export const CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO = 0.5;
export const CRITICAL_SPAWN_REPAIR_HITS_RATIO = 0.25;
export const EMERGENCY_RAMPART_REPAIR_HITS_CEILING = 10_000;
export const ACTIVE_RAMPART_REPAIR_HITS_CEILING = 120_000;
// Keep routine barrier maintenance above the monitor's critical rampart damage band.
export const IDLE_RAMPART_REPAIR_HITS_CEILING = 150_000;
export const TOWER_REFILL_ENERGY_FLOOR = 500;
export const CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD = 200;
export const URGENT_SPAWN_REFILL_ENERGY_THRESHOLD = CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD;
export const WORKER_PRE_HARVEST_REGEN_THRESHOLD = 50;
export const NEAR_TERM_SPAWN_EXTENSION_REFILL_RESERVE_TICKS = 50;
export const MINIMUM_USEFUL_LOAD_RATIO = 0.3;
export const LOW_LOAD_CONTROLLER_DOWNGRADE_IMMINENT_TICKS = 1_000;
export const LOW_LOAD_NEARBY_ENERGY_RANGE = 3;
export const LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE = 6;
export const LOW_LOAD_SPAWN_EXTENSION_REFILL_CONTINUATION_MAX_RANGE = 12;
const LOW_LOAD_SOURCE_LOGISTICS_CONTINUATION_MAX_RANGE = LOW_LOAD_SPAWN_EXTENSION_REFILL_CONTINUATION_MAX_RANGE;
export const ROUTINE_REPAIR_MIN_HITS_DEFICIT = 500;
export const ROUTINE_REPAIR_MIN_HITS_DEFICIT_RATIO = 0.1;
export const ROUTINE_REPAIR_MAX_RANGE = 5;
export const BUILDER_STORAGE_WITHDRAW_MIN = 100;
export const BUILDER_DROPPED_PICKUP_RANGE = 5;
const DEFAULT_SPAWN_ENERGY_CAPACITY = 300;
const LOW_WORKER_THROUGHPUT_WORKER_COUNT = 3;
const MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
const MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE = 1;
const MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 25;
const MIN_SPAWN_RECOVERY_DROPPED_ENERGY_PICKUP_AMOUNT = 10;
const MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT = 2;
const MIN_NEARBY_LINK_REFILL_ENERGY = 1;
const COMPETITIVE_SOURCE_CONTAINER_WITHDRAW_MIN_ENERGY = 200;
const ENERGY_ACQUISITION_RANGE_COST = 50;
const ENERGY_ACQUISITION_ACTION_TICKS = 1;
const WORKER_ENERGY_SURPLUS_SCORE_RATIO = 0.4;
const HARVEST_ENERGY_PER_WORK_PART = 2;
const SPAWN_EXTENSION_THROUGHPUT_STORAGE_REFILL_EMPTY_CAPACITY_RATIO = 0.2;
const SPAWN_EXTENSION_REFILL_STORAGE_WITHDRAWAL_OPTIONS = { allowBelowReserve: true } as const;
const DEFAULT_BUILD_POWER = 5;
const NEARLY_COMPLETE_CONSTRUCTION_SITE_REMAINING_RATIO = 0.2;
const NEARLY_COMPLETE_CONSTRUCTION_SITE_FINISH_PRIORITY_MULTIPLIER = 2;
const FINISHABLE_CONSTRUCTION_SITE_PRIORITY_MULTIPLIER = 2;
const MAX_DROPPED_ENERGY_REACHABILITY_CHECKS = 5;
const DEFAULT_SOURCE_ENERGY_CAPACITY = 3_000;
const DEFAULT_SOURCE_ENERGY_REGEN_TICKS = 300;
const MAX_WORKER_PRE_HARVEST_WAITERS_PER_SOURCE = 1;
const MAX_CONTROLLER_LEVEL = 8;
const UPGRADER_BOOST_CONTROLLER_PROGRESS_RATIO = 0.9;
const UPGRADER_BOOST_LOW_ENERGY_RATIO = 0.5;
const SOURCE2_CONTROLLER_LANE_SOURCE_INDEX = 1;
const SOURCE2_CONTROLLER_LANE_MAX_RANGE = 6;
const MIN_LOADED_WORKERS_FOR_SECOND_SUSTAINED_CONTROLLER_PROGRESS = 4;
const MIN_LOADED_WORKERS_FOR_SURPLUS_CONTROLLER_PROGRESS = 5;
const MAX_SUSTAINED_CONTROLLER_PROGRESS_WORKERS = 2;
const MAX_SURPLUS_CONTROLLER_PROGRESS_WORKERS = 3;
const BASELINE_WORKER_THROUGHPUT_ENERGY_CAPACITY = 550;
const BUILDER_STORAGE_ACQUISITION_SITE_RANGE = BUILDER_DROPPED_PICKUP_RANGE;
const CONSTRUCTION_PREBUFFER_SITE_RANGE = 5;
const CONSTRUCTION_PREBUFFER_MIN_FREE_CAPACITY = 25;
const CONSTRUCTION_PREBUFFER_MIN_STORED_ENERGY = 25;
const SPAWN_RECOVERY_SOURCE_LOAD_BALANCE_ETA_TOLERANCE = 1;
const ROAD_TRAVEL_COST = 1;
const PLAIN_TRAVEL_COST = 2;
const SWAMP_TRAVEL_COST = 10;
const HARVEST_SOURCE_RANGE = 1;
const HARVEST_SOURCE_CONTAINER_RANGE = 0;
const MAX_HARVEST_PATH_OPS = 2_000;
const LOW_LOAD_YIELD_SWITCH_MIN_IMPROVEMENT_RATIO = 1.1;
const LOW_LOAD_YIELD_SWITCH_MIN_ABSOLUTE_GAIN = 0.25;
const SPAWN_RESERVATION_PRODUCTIVE_WORK_MIN_WORKERS = 2;

type RepairableWorkerStructure =
  | StructureRoad
  | StructureContainer
  | StructureRampart
  | StructureSpawn
  | StructureWall;
type CriticalInfrastructureRepairTarget = StructureRoad | StructureContainer | StructureSpawn;
type StoredWorkerEnergySource = StructureContainer | StructureStorage | StructureTerminal | StructureLink | StructureSpawn;
type UpgraderBoostStoredEnergySource = StructureContainer | StructureStorage;
type ConstructionPreBufferSink = StructureExtension | StructureStorage;
type BuilderStoredEnergySource = StoredWorkerEnergySource | StructureExtension;
type SalvageableWorkerEnergySource = Tombstone | Ruin;
type FillableEnergySink = StructureSpawn | StructureExtension | StructureTower;
type InterRoomEnergyStore = StructureStorage | StructureTerminal;
type InterRoomRecallEnergySink = FillableEnergySink | InterRoomEnergyStore;
type RemoteHaulerDeliverySink =
  | StructureSpawn
  | StructureExtension
  | StructureStorage
  | StructureTerminal
  | StructureTower;
type SpawnExtensionEnergyStructure = StructureSpawn | StructureExtension;
type WorkerEnergyAcquisitionSource =
  | StoredWorkerEnergySource
  | SalvageableWorkerEnergySource
  | Resource<ResourceConstant>;
type BuilderEnergyAcquisitionSource = BuilderStoredEnergySource | SalvageableWorkerEnergySource | Resource<ResourceConstant>;
type WorkerEnergyAcquisitionTask = Extract<CreepTaskMemory, { type: 'pickup' | 'withdraw' }>;
type LowLoadWorkerEnergyAcquisitionSource = WorkerEnergyAcquisitionSource | Source;
type LowLoadWorkerEnergyAcquisitionTask = Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }>;
type ProductiveEnergySinkTask = Extract<CreepTaskMemory, { type: 'build' | 'repair' }>;
type WorkerEnergyAcquisitionPriority = 0 | 1 | 2 | 3;
type WorkerEnergySpendingTask =
  | Extract<CreepTaskMemory, { type: 'transfer' }>
  | Extract<CreepTaskMemory, { type: 'build' }>
  | Extract<CreepTaskMemory, { type: 'repair' }>
  | Extract<CreepTaskMemory, { type: 'upgrade' }>;
type BuilderEnergyAcquisitionTask = Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }>;
type BuilderEnergyAcquisitionPriority = WorkerEnergyAcquisitionPriority;

interface BuilderEnergyAcquisitionCandidate {
  energy: number;
  priority: BuilderEnergyAcquisitionPriority;
  range: number | null;
  score: number;
  source: BuilderEnergyAcquisitionSource | Source;
  task: BuilderEnergyAcquisitionTask;
}

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

interface LiveTransferCandidateCache {
  game: Partial<Game> | undefined;
  resultsByRoomPair: Map<string, boolean>;
  tick: number;
}

interface InterRoomHaulReservation {
  energy: number;
  transferKey: string;
}

interface InterRoomHaulReservationCache {
  game: Partial<Game> | undefined;
  reservationsByCreep: Map<Creep, InterRoomHaulReservation>;
  reservationsByCreepKey: Map<string, InterRoomHaulReservation>;
  reservedEnergyByTransferKey: Map<string, number>;
  tick: number | null;
}

interface GameCreepsCache {
  creeps: Creep[];
  creepsRecord: Partial<Game>['creeps'];
  game: Partial<Game> | undefined;
  tick: number | null;
}

interface RoutineBarrierMaintenanceRepairTargetCacheEntry {
  room: Room;
  targets: Array<StructureRampart | StructureWall>;
}

interface RoutineBarrierMaintenanceRepairTargetCache {
  game: Partial<Game> | undefined;
  roomsByName: Map<string, RoutineBarrierMaintenanceRepairTargetCacheEntry>;
  tick: number;
}

interface ConstructionSiteSelectionOptions {
  priorityContext?: ConstructionSiteImpactPriorityContext | undefined;
  requireReasonableRange?: boolean;
}

interface ConstructionSiteFinishPriorityScore {
  remainingProgress: number;
  score: number;
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
  hasContainerAssignment: boolean;
}

export interface HarvestSourceSelectionOptions {
  allowPreHarvest?: boolean;
  ignoreHarvestAssignments?: boolean;
}

interface WorkerHarvestTaskOptions extends HarvestSourceSelectionOptions {
  assignSourceContainer?: boolean;
}

interface SourceContainerWithdrawalContext {
  assignmentLoads: Map<Id<Source>, HarvestSourceAssignmentLoad>;
  sources: Source[];
}

interface ControllerDowngradeGuardOptions {
  allowConstructionBacklogYield?: boolean;
}

let nearTermSpawnExtensionRefillReserveCache: NearTermSpawnExtensionRefillReserveCache | null = null;
let interRoomLiveTransferCandidateCache: LiveTransferCandidateCache | null = null;
let interRoomHaulReservationCache: InterRoomHaulReservationCache | null = null;
let gameCreepsCache: GameCreepsCache | null = null;
let routineBarrierMaintenanceRepairTargetCache: RoutineBarrierMaintenanceRepairTargetCache | null = null;
let workerTaskSelectionTelemetrySuppressionDepth = 0;

export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  clearWorkerTaskSelectionTelemetry(creep);
  const cpuBudget = getRuntimeCpuBudget();
  if (shouldShedNonessentialCpuWork(cpuBudget) && !hasActiveTerritoryControlAssignment(creep)) {
    const criticalTask = withWorkerTaskSelectionTelemetrySuppressed(true, () => selectCriticalCpuWorkerTask(creep));
    clearWorkerTaskShadowTelemetry(creep);
    return criticalTask;
  }

  const degraded = cpuBudget.degraded;
  const heuristicTask = withWorkerTaskSelectionTelemetrySuppressed(degraded, () => selectHeuristicWorkerTask(creep));
  if (degraded) {
    clearWorkerTaskShadowTelemetry(creep);
    return heuristicTask;
  }

  recordWorkerTaskBehaviorTrace(creep, heuristicTask);
  return selectWorkerTaskWithBcFallback(creep, heuristicTask);
}

function hasActiveTerritoryControlAssignment(creep: Creep): boolean {
  const task = creep.memory?.task;
  return task?.type === 'claim' || task?.type === 'reserve';
}

function selectCriticalCpuWorkerTask(creep: Creep): CreepTaskMemory | null {
  const carriedEnergy = getUsedEnergy(creep);
  if (carriedEnergy <= 0) {
    return selectCriticalCpuEnergyAcquisitionTask(creep);
  }

  const controller = creep.room.controller;
  if (
    controller &&
    shouldGuardControllerDowngradeForWorkerLoad(creep, controller, { allowConstructionBacklogYield: false }) &&
    canUpgradeController(controller)
  ) {
    return { type: 'upgrade', targetId: controller.id };
  }

  const criticalSpawnRepairTarget = selectCriticalOwnedSpawnRepairTarget(creep);
  if (criticalSpawnRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: criticalSpawnRepairTarget.id as Id<Structure>
    });
  }

  const spawnOrExtensionEnergySink = selectSpawnOrExtensionEnergySink(creep);
  const emergencySpawnOrExtensionRefillTask = selectEmergencySpawnExtensionRefillTask(
    creep,
    spawnOrExtensionEnergySink
  );
  if (emergencySpawnOrExtensionRefillTask) {
    return emergencySpawnOrExtensionRefillTask;
  }

  const emergencyRampartRepairTarget = selectEmergencyOwnedRampartRepairTarget(creep);
  if (emergencyRampartRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: emergencyRampartRepairTarget.id as Id<Structure>
    });
  }

  const threatenedBarrierRepairTarget = selectThreatenedBarrierRepairTarget(creep);
  if (threatenedBarrierRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: threatenedBarrierRepairTarget.id as Id<Structure>
    });
  }

  const missingSpawnConstructionSite = selectMissingSpawnRecoveryConstructionSite(creep);
  if (missingSpawnConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: missingSpawnConstructionSite.id });
  }

  const storedProtectedConstructionTask = selectStoredProtectedSourceContainerConstructionTask(creep);
  if (storedProtectedConstructionTask) {
    return applyMinimumUsefulLoadPolicy(creep, storedProtectedConstructionTask);
  }

  if (spawnOrExtensionEnergySink) {
    return {
      type: 'transfer',
      targetId: spawnOrExtensionEnergySink.id as Id<AnyStoreStructure>
    };
  }

  const priorityTowerEnergySink = selectPriorityTowerEnergySink(creep);
  if (priorityTowerEnergySink) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'transfer',
      targetId: priorityTowerEnergySink.id as Id<AnyStoreStructure>
    });
  }

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: criticalRepairTarget.id as Id<Structure>
    });
  }

  return null;
}

function selectStoredProtectedSourceContainerConstructionTask(
  creep: Creep,
  constructionSites?: ConstructionSite[],
  constructionReservationContext?: ConstructionReservationContext
): Extract<CreepTaskMemory, { type: 'build' }> | null {
  const constructionSite = selectStoredProtectedSourceContainerConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  return constructionSite ? { type: 'build', targetId: constructionSite.id } : null;
}

function selectStoredProtectedSourceContainerConstructionEnergyAcquisitionTask(
  creep: Creep
): BuilderEnergyAcquisitionTask | null {
  const constructionSite = selectStoredProtectedSourceContainerConstructionEnergyAcquisitionSite(creep);
  if (!constructionSite) {
    return null;
  }

  const candidates = findBuilderEnergyAcquisitionCandidates(creep, constructionSite);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareBuilderEnergyAcquisitionCandidates)[0].task;
}

function selectStoredProtectedSourceContainerConstructionEnergyAcquisitionSite(
  creep: Creep
): ConstructionSite | null {
  const constructionSites = findConstructionSites(creep.room);
  if (constructionSites.length === 0) {
    return null;
  }

  const constructionReservationContext = createConstructionReservationContext(creep.room);
  const priorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  const storedProtectedSourceContainerSites = constructionSites.filter((site) =>
    canSpendOnStoredProtectedSourceContainerConstruction(creep, site, priorityContext)
  );

  return selectUnreservedConstructionBacklogEnergyTarget(
    creep,
    storedProtectedSourceContainerSites,
    constructionReservationContext,
    priorityContext
  );
}

function selectStoredProtectedSourceContainerConstructionSite(
  creep: Creep,
  constructionSites?: ConstructionSite[],
  constructionReservationContext?: ConstructionReservationContext
): ConstructionSite | null {
  const sites = constructionSites ?? findConstructionSites(creep.room);
  if (sites.length === 0) {
    return null;
  }

  const reservations = constructionReservationContext ?? createConstructionReservationContext(creep.room);
  const priorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, sites);
  return selectUnreservedConstructionSite(
    creep,
    sites,
    reservations,
    (site) => canSpendOnStoredProtectedSourceContainerConstruction(creep, site, priorityContext),
    { priorityContext }
  );
}

function selectCriticalCpuEnergyAcquisitionTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }> | null {
  if (getFreeEnergyCapacity(creep) <= 0) {
    return null;
  }

  const spawnRecoveryEnergySink = selectFillableEnergySink(creep);
  if (spawnRecoveryEnergySink) {
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

  if (selectMissingSpawnRecoveryConstructionSite(creep)) {
    return selectWorkerEnergyCriticalAcquisitionTask(creep);
  }

  const controller = creep.room.controller;
  if (
    controller &&
    shouldGuardControllerDowngradeForWorkerLoad(creep, controller, { allowConstructionBacklogYield: false }) &&
    canUpgradeController(controller)
  ) {
    return selectWorkerEnergyCriticalAcquisitionTask(creep);
  }

  if (hasCriticalCpuRepairDemand(creep)) {
    return selectWorkerEnergyCriticalAcquisitionTask(creep);
  }

  return selectStoredProtectedSourceContainerConstructionEnergyAcquisitionTask(creep);
}

function hasCriticalCpuRepairDemand(creep: Creep): boolean {
  return (
    selectCriticalOwnedSpawnRepairTarget(creep) !== null ||
    selectEmergencyOwnedRampartRepairTarget(creep) !== null ||
    selectThreatenedBarrierRepairTarget(creep) !== null ||
    selectCriticalInfrastructureRepairTarget(creep) !== null
  );
}

function selectMissingSpawnRecoveryConstructionSite(creep: Creep): ConstructionSite | null {
  if (getOwnedSpawnCount(creep.room) !== 0) {
    return null;
  }

  const constructionSites = findConstructionSites(creep.room);
  return constructionSites.filter((site) => isMissingSpawnRecoveryConstructionSite(creep.room, site))[0] ?? null;
}

function findConstructionSites(room: Room): ConstructionSite[] {
  if (typeof FIND_CONSTRUCTION_SITES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    return Array.isArray(sites) ? (sites as ConstructionSite[]) : [];
  } catch {
    return [];
  }
}

function clearWorkerTaskShadowTelemetry(creep: Creep): void {
  const memory = creep.memory;
  if (!memory) {
    return;
  }

  delete memory.workerBehavior;
  delete memory.workerTaskPolicyShadow;
}

function withWorkerTaskSelectionTelemetrySuppressed<T>(suppressTelemetry: boolean, selectTask: () => T): T {
  if (!suppressTelemetry) {
    return selectTask();
  }

  workerTaskSelectionTelemetrySuppressionDepth += 1;
  try {
    return selectTask();
  } finally {
    workerTaskSelectionTelemetrySuppressionDepth -= 1;
  }
}

function isWorkerTaskSelectionTelemetrySuppressed(): boolean {
  return workerTaskSelectionTelemetrySuppressionDepth > 0;
}

function selectHeuristicWorkerTask(creep: Creep): CreepTaskMemory | null {
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
  const controllerSigningTask = selectOwnedRoomControllerSigningTask(creep);

  if (carriedEnergy === 0) {
    if (urgentReservationRenewalTask) {
      return urgentReservationRenewalTask;
    }

    if (isTerritoryControlTask(territoryControllerTask)) {
      return territoryControllerTask;
    }

    const interRoomRecallTask = selectInterRoomForeignRoomRecallTask(creep, carriedEnergy);
    if (interRoomRecallTask) {
      return interRoomRecallTask;
    }

    let hasPriorityEnergySink = false;
    if (getFreeEnergyCapacity(creep) > 0) {
      const storedProtectedConstructionEnergyAcquisitionTask =
        selectStoredProtectedSourceContainerConstructionEnergyAcquisitionTask(creep);
      if (storedProtectedConstructionEnergyAcquisitionTask) {
        return storedProtectedConstructionEnergyAcquisitionTask;
      }

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

      const controller = creep.room.controller;
      if (
        controller &&
        shouldGuardControllerDowngradeForWorkerLoad(creep, controller, { allowConstructionBacklogYield: false }) &&
        canUpgradeController(controller)
      ) {
        const controllerGuardEnergyTask = selectWorkerEnergyCriticalAcquisitionTask(creep);
        if (controllerGuardEnergyTask) {
          return controllerGuardEnergyTask;
        }
      }
    }

    const seasonScoreCollectionTask = selectSeasonScoreCollectionTask(creep);
    if (seasonScoreCollectionTask) {
      return seasonScoreCollectionTask;
    }

    if (getFreeEnergyCapacity(creep) > 0) {
      if (shouldStandbySurplusWorkerInsteadOfAcquiring(creep, creep.room.controller)) {
        return null;
      }

      const upgraderBoostEnergyAcquisitionTask = selectUpgraderBoostEnergyAcquisitionTask(creep, creep.room.controller);
      if (upgraderBoostEnergyAcquisitionTask) {
        return upgraderBoostEnergyAcquisitionTask;
      }

      const constructionPreBufferRecoveryTask = selectConstructionPreBufferRecoveryTask(creep);
      if (constructionPreBufferRecoveryTask) {
        return constructionPreBufferRecoveryTask;
      }

      const minimumHarvesterTask = selectMinimumHarvesterAllocationTask(creep);
      if (minimumHarvesterTask) {
        return minimumHarvesterTask;
      }

      if (controllerSigningTask && !bootstrapNonCriticalWorkSuppressed) {
        return controllerSigningTask;
      }

      const builderEnergyAcquisitionTask = selectBuilderEnergyAcquisitionTask(creep);
      if (builderEnergyAcquisitionTask) {
        return builderEnergyAcquisitionTask;
      }

      const constructionBacklogEnergyAcquisitionTask = selectConstructionBacklogEnergyAcquisitionTask(creep);
      if (constructionBacklogEnergyAcquisitionTask) {
        return constructionBacklogEnergyAcquisitionTask;
      }

      const activeRampartRepairEnergyAcquisitionTask = selectActiveRampartRepairEnergyAcquisitionTask(creep);
      if (activeRampartRepairEnergyAcquisitionTask) {
        return activeRampartRepairEnergyAcquisitionTask;
      }

      const nearbyWorkerEnergyAcquisitionTask = selectNearbyWorkerEnergyAcquisitionTask(creep);
      if (nearbyWorkerEnergyAcquisitionTask) {
        return nearbyWorkerEnergyAcquisitionTask;
      }

      const storageRefillAcquisitionTask = selectStorageToSpawnExtensionRefillAcquisitionTask(creep);
      if (storageRefillAcquisitionTask) {
        return storageRefillAcquisitionTask;
      }

      const competitiveWorkerEnergyAcquisitionTask = selectCompetitiveWorkerEnergyAcquisitionTask(creep);
      if (competitiveWorkerEnergyAcquisitionTask) {
        return competitiveWorkerEnergyAcquisitionTask;
      }

      const nearbyLinkRefillTask = selectNearbyWorkerLinkRefillTask(creep);
      if (nearbyLinkRefillTask) {
        return nearbyLinkRefillTask;
      }

      const source2ControllerLaneHarvestTask = selectSource2ControllerLaneHarvestTask(creep);
      if (source2ControllerLaneHarvestTask) {
        return source2ControllerLaneHarvestTask;
      }

      const sourceContainerHarvestTask = selectSourceContainerHarvestTask(creep);
      if (sourceContainerHarvestTask) {
        return sourceContainerHarvestTask;
      }

      const sourceContainerWithdrawTask = selectSourceContainerWithdrawTask(creep);
      if (sourceContainerWithdrawTask) {
        return sourceContainerWithdrawTask;
      }

      const interRoomEnergyHaulTask = selectInterRoomEnergyHaulingTask(creep, carriedEnergy);
      if (interRoomEnergyHaulTask) {
        return interRoomEnergyHaulTask;
      }

      if (!hasPriorityEnergySink) {
        const energyAcquisitionTask = selectWorkerEnergyAcquisitionTask(creep);
        if (energyAcquisitionTask) {
          return energyAcquisitionTask;
        }
      }

      const linkEnergyAcquisitionTask = selectEfficientWorkerLinkEnergyAcquisitionTask(creep);
      if (linkEnergyAcquisitionTask) {
        return linkEnergyAcquisitionTask;
      }
    }

    const source = selectHarvestSource(creep);
    if (source) {
      return createHarvestTaskForSource(creep, source);
    }

    if (getFreeEnergyCapacity(creep) > 0) {
      const linkFallbackTask = selectWorkerLinkEnergyFallbackTask(creep);
      if (linkFallbackTask) {
        return linkFallbackTask;
      }
    }

    if (controllerSigningTask && !bootstrapNonCriticalWorkSuppressed) {
      return controllerSigningTask;
    }

    return null;
  }

  if (urgentReservationRenewalTask) {
    return urgentReservationRenewalTask;
  }

  if (isTerritoryControlTask(territoryControllerTask)) {
    return territoryControllerTask;
  }

  const controller = creep.room.controller;
  if (
    controller &&
    shouldGuardControllerDowngradeForWorkerLoad(creep, controller) &&
    canUpgradeController(controller) &&
    !remoteProductiveSpendingSuppressed
  ) {
    const downgradeGuardTask: Extract<CreepTaskMemory, { type: 'upgrade' }> = {
      type: 'upgrade',
      targetId: controller.id
    };
    recordLowLoadReturnTelemetry(creep, downgradeGuardTask, 'controllerDowngradeGuard');
    return downgradeGuardTask;
  }

  const criticalSpawnRepairTarget = selectCriticalOwnedSpawnRepairTarget(creep);
  if (criticalSpawnRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: criticalSpawnRepairTarget.id as Id<Structure>
    });
  }

  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const constructionReservationContext =
    constructionSites.length > 0
      ? createConstructionReservationContext(creep.room)
      : createEmptyConstructionReservationContext();
  let cachedShouldYieldSpawnReservationToConstructionBacklog: boolean | undefined;
  const getShouldYieldSpawnReservationToConstructionBacklog = (): boolean => {
    if (cachedShouldYieldSpawnReservationToConstructionBacklog === undefined) {
      cachedShouldYieldSpawnReservationToConstructionBacklog = shouldYieldSpawnReservationToConstructionBacklog(
        creep,
        constructionSites,
        constructionReservationContext
      );
    }

    return cachedShouldYieldSpawnReservationToConstructionBacklog;
  };
  const spawnOrExtensionEnergySink = selectSpawnOrExtensionEnergySink(creep);
  const ownedSpawnCount = getOwnedSpawnCount(creep.room);
  const hasMissingSpawnRecoveryConstructionSite =
    ownedSpawnCount === 0 && constructionSites.some(isSpawnConstructionSite);
  const canPrioritizeEmergencyWorkBeforeBootstrapSpawnRecovery =
    !hasMissingSpawnRecoveryConstructionSite &&
    (!bootstrapNonCriticalWorkSuppressed || (ownedSpawnCount ?? 0) > 0);
  if (canPrioritizeEmergencyWorkBeforeBootstrapSpawnRecovery) {
    const emergencySpawnOrExtensionRefillTask = selectEmergencySpawnExtensionRefillTask(
      creep,
      spawnOrExtensionEnergySink
    );
    if (emergencySpawnOrExtensionRefillTask) {
      return emergencySpawnOrExtensionRefillTask;
    }

    const emergencyRampartRepairTarget = selectEmergencyOwnedRampartRepairTarget(creep);
    if (emergencyRampartRepairTarget) {
      return applyMinimumUsefulLoadPolicy(creep, {
        type: 'repair',
        targetId: emergencyRampartRepairTarget.id as Id<Structure>
      });
    }

    const threatenedBarrierRepairTarget = selectThreatenedBarrierRepairTarget(creep);
    if (threatenedBarrierRepairTarget) {
      return applyMinimumUsefulLoadPolicy(creep, {
        type: 'repair',
        targetId: threatenedBarrierRepairTarget.id as Id<Structure>
      });
    }
  }

  const storedProtectedConstructionTask = selectStoredProtectedSourceContainerConstructionTask(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (storedProtectedConstructionTask) {
    return applyMinimumUsefulLoadPolicy(creep, storedProtectedConstructionTask);
  }

  const bootstrapExtensionConstructionSite = selectBootstrapExtensionConstructionSiteBeforeRefill(
    creep,
    constructionSites,
    constructionReservationContext,
    survivalAssessment,
    controller
  );
  if (
    bootstrapExtensionConstructionSite &&
    !shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep) &&
    !shouldKeepSpawnExtensionRefillBeforeBootstrapExtension(creep, spawnOrExtensionEnergySink)
  ) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'build',
      targetId: bootstrapExtensionConstructionSite.id
    });
  }

  if (!bootstrapNonCriticalWorkSuppressed && !remoteProductiveSpendingSuppressed) {
    const productiveTaskBeforeIdleRefill = selectProductiveEnergySinkBeforeIdleSpawnExtensionRefill(
      creep,
      spawnOrExtensionEnergySink,
      constructionSites,
      constructionReservationContext,
      getShouldYieldSpawnReservationToConstructionBacklog
    );
    if (productiveTaskBeforeIdleRefill) {
      return applyMinimumUsefulLoadPolicy(creep, productiveTaskBeforeIdleRefill);
    }
  }

  if (spawnOrExtensionEnergySink && canPrioritizeEmergencyWorkBeforeBootstrapSpawnRecovery) {
    const spawnOrExtensionRefillTask: Extract<CreepTaskMemory, { type: 'transfer' }> = {
      type: 'transfer',
      targetId: spawnOrExtensionEnergySink.id as Id<AnyStoreStructure>
    };
    if (isCriticalSpawnEnergySink(spawnOrExtensionEnergySink)) {
      recordSpawnCriticalRefillTelemetry(creep, spawnOrExtensionEnergySink);
    }
    if (hasEmergencySpawnExtensionRefillDemand(creep)) {
      recordLowLoadReturnTelemetry(creep, spawnOrExtensionRefillTask, 'emergencySpawnExtensionRefill');
      return spawnOrExtensionRefillTask;
    }

    // Workers in this branch always have carriedEnergy > 0.
    return applyMinimumUsefulSpawnExtensionDeliveryPolicy(creep, spawnOrExtensionRefillTask);
  }

  const spawnStagingContainerSink = selectSpawnStagingContainerEnergySink(creep);
  if (spawnStagingContainerSink) {
    return {
      type: 'transfer',
      targetId: spawnStagingContainerSink.id as Id<AnyStoreStructure>
    };
  }

  if (remoteProductiveSpendingSuppressed) {
    const suppressedRemoteEnergyHandlingTask = selectSuppressedRemoteEnergyHandlingTask(creep);
    if (suppressedRemoteEnergyHandlingTask) {
      return suppressedRemoteEnergyHandlingTask;
    }

    return null;
  }

  const minimumHarvesterTask = selectMinimumHarvesterAllocationTask(creep);
  if (minimumHarvesterTask) {
    return minimumHarvesterTask;
  }

  const constructionPreBufferBuildTask = selectConstructionPreBufferBuildTask(creep);
  if (constructionPreBufferBuildTask) {
    return applyMinimumUsefulLoadPolicy(creep, constructionPreBufferBuildTask);
  }

  const capacityConstructionSite = selectCapacityEnablingConstructionSite(
    creep,
    constructionSites,
    controller,
    constructionReservationContext
  );
  const constructionPreBufferTask = selectConstructionEnergyPreBufferTask(
    creep,
    constructionSites,
    constructionReservationContext,
    capacityConstructionSite
  );
  if (constructionPreBufferTask) {
    return applyMinimumUsefulLoadPolicy(creep, constructionPreBufferTask);
  }

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

  if (capacityConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: capacityConstructionSite.id });
  }

  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: criticalRepairTarget.id as Id<Structure>
    });
  }

  const threatenedBarrierRepairTarget = selectThreatenedBarrierRepairTarget(creep);
  if (threatenedBarrierRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: threatenedBarrierRepairTarget.id as Id<Structure>
    });
  }

  const seasonScoreCollectionTask = selectSeasonScoreCollectionTask(creep);
  if (seasonScoreCollectionTask) {
    return seasonScoreCollectionTask;
  }

  const activeRampartRepairTarget =
    constructionSites.length === 0 ? selectActiveOwnedRampartRepairTarget(creep) : null;
  if (activeRampartRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: activeRampartRepairTarget.id as Id<Structure>
    });
  }

  const uncoveredRoutineRampartMaintenanceTask = selectUncoveredRoutineRampartMaintenanceTask(
    creep,
    constructionSites
  );
  if (uncoveredRoutineRampartMaintenanceTask) {
    return applyMinimumUsefulLoadPolicy(creep, uncoveredRoutineRampartMaintenanceTask);
  }

  if (
    shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep) &&
    !getShouldYieldSpawnReservationToConstructionBacklog()
  ) {
    return null;
  }

  const controllerSustainBarrierMaintenanceTask = selectControllerSustainBarrierMaintenanceTask(
    creep,
    constructionSites
  );
  if (controllerSustainBarrierMaintenanceTask) {
    return applyMinimumUsefulLoadPolicy(creep, controllerSustainBarrierMaintenanceTask);
  }

  const controllerSustainUpgradeTask = selectControllerSustainUpgradeTask(creep, controller);
  if (controllerSustainUpgradeTask) {
    return applyMinimumUsefulLoadPolicy(creep, controllerSustainUpgradeTask);
  }

  const rcl3DefenseUnlockUpgradeTask = selectRcl3DefenseUnlockUpgradeTask(creep, controller);
  if (rcl3DefenseUnlockUpgradeTask) {
    return applyMinimumUsefulLoadPolicy(creep, rcl3DefenseUnlockUpgradeTask);
  }

  const constructionPriorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  const highImpactConstructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    (site) => isHighImpactConstructionSite(site, constructionPriorityContext),
    {
      priorityContext: constructionPriorityContext,
      requireReasonableRange: true
    }
  );
  if (highImpactConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: highImpactConstructionSite.id });
  }

  const uncoveredProductiveBacklogTask = selectUncoveredProductiveBacklogTaskBeforeControllerProgress(
    creep,
    controller,
    constructionSites,
    constructionReservationContext
  );
  if (uncoveredProductiveBacklogTask) {
    return applyMinimumUsefulLoadPolicy(creep, uncoveredProductiveBacklogTask);
  }

  const constructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    () => true,
    { priorityContext: constructionPriorityContext }
  );
  if (constructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: constructionSite.id });
  }

  const routineBarrierMaintenanceTarget = selectRoutineBarrierMaintenanceRepairTarget(creep);
  if (
    routineBarrierMaintenanceTarget &&
    !shouldDeferRoutineRepairToCoveredRcl3ControllerProgress(
      creep,
      controller,
      constructionSites,
      routineBarrierMaintenanceTarget
    )
  ) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: routineBarrierMaintenanceTarget.id as Id<Structure>
    });
  }

  const source2ControllerLaneLoadedTask = controller
    ? selectSource2ControllerLaneLoadedTask(creep, controller, constructionSites, constructionReservationContext)
    : null;
  if (source2ControllerLaneLoadedTask) {
    return applyMinimumUsefulLoadPolicy(creep, source2ControllerLaneLoadedTask);
  }

  if (controller && shouldRushRcl1Controller(controller)) {
    return canLevelUpController(controller)
      ? applyMinimumUsefulLoadPolicy(creep, { type: 'upgrade', targetId: controller.id })
      : null;
  }

  const upgraderBoostUpgradeTask = selectUpgraderBoostUpgradeTask(creep, controller, carriedEnergy);
  if (upgraderBoostUpgradeTask) {
    return upgraderBoostUpgradeTask;
  }

  const managedControllerUpgradeTask = selectManagedControllerUpgradeTask(creep, controller, carriedEnergy);
  if (managedControllerUpgradeTask) {
    return applyMinimumUsefulLoadPolicy(creep, managedControllerUpgradeTask);
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

    return canLevelUpController(controller)
      ? applyMinimumUsefulLoadPolicy(creep, { type: 'upgrade', targetId: controller.id })
      : null;
  }

  const repairTarget = selectRepairTarget(creep);
  if (
    repairTarget &&
    !shouldDeferRoutineRepairToCoveredRcl3ControllerProgress(creep, controller, constructionSites, repairTarget)
  ) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'repair', targetId: repairTarget.id as Id<Structure> });
  }

  const interRoomEnergyHaulTask = selectInterRoomEnergyHaulingTask(creep, carriedEnergy);
  if (interRoomEnergyHaulTask) {
    return interRoomEnergyHaulTask;
  }

  if (controller?.my && canUpgradeController(controller)) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'upgrade', targetId: controller.id });
  }

  const energySurplusStorageTask = selectEnergySurplusStorageTask(creep, carriedEnergy);
  if (energySurplusStorageTask) {
    return energySurplusStorageTask;
  }

  if (
    shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep) &&
    !getShouldYieldSpawnReservationToConstructionBacklog()
  ) {
    return null;
  }

  if (controllerSigningTask && !bootstrapNonCriticalWorkSuppressed) {
    return controllerSigningTask;
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

function selectOwnedRoomControllerSigningTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'signController' }> | null {
  const controller = creep.room?.controller;
  if (
    creep.memory?.role !== 'worker' ||
    controller?.my !== true ||
    typeof controller.id !== 'string' ||
    typeof creep.signController !== 'function' ||
    !shouldSignOwnedRoomController(creep.room, controller) ||
    !hasManagedControllerSigningDemand(creep.room?.name, controller.id)
  ) {
    return null;
  }

  if (hasAssignedControllerSigningTask(controller.id, creep.name)) {
    return null;
  }

  return { type: 'signController', targetId: controller.id };
}

function hasManagedControllerSigningDemand(
  roomName: string | undefined,
  controllerId: Id<StructureController>
): boolean {
  if (!isNonEmptyString(roomName)) {
    return false;
  }

  const controllerMemory = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory?.controllers?.[
    roomName
  ];
  return controllerMemory?.signNeeded === true && controllerMemory.controllerId === controllerId;
}

function hasAssignedControllerSigningTask(
  controllerId: Id<StructureController>,
  currentCreepName: string | undefined
): boolean {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return false;
  }

  return Object.values(creeps).some((creep) => {
    if (isNonEmptyString(currentCreepName) && creep.name === currentCreepName) {
      return false;
    }

    const task = creep.memory?.task;
    return task?.type === 'signController' && task.targetId === controllerId;
  });
}

function selectMinimumHarvesterAllocationTask(creep: Creep): Extract<CreepTaskMemory, { type: 'harvest' }> | null {
  if (!shouldGuaranteeMinimumHarvesterAllocation(creep)) {
    return null;
  }

  const assignedHarvestTask = selectWorkerHarvestTask(creep, { allowPreHarvest: false, assignSourceContainer: true });
  if (assignedHarvestTask) {
    return assignedHarvestTask;
  }

  if (!shouldForceGenericHarvestForThroughputRecovery(creep)) {
    return null;
  }

  return selectWorkerHarvestTask(creep, { allowPreHarvest: false, ignoreHarvestAssignments: true });
}

function shouldGuaranteeMinimumHarvesterAllocation(creep: Creep): boolean {
  if (creep.memory?.role !== 'worker' || getFreeEnergyCapacity(creep) <= 0) {
    return false;
  }

  const roomCreeps = getSameRoomCreepsIncludingCurrent(creep);
  const workerCreeps = roomCreeps.filter(isWorkerCreep);
  const hasSpawnExtensionEnergyDeficit = hasRoomSpawnExtensionEnergyDeficit(creep.room);
  const hasWorkerHarvestCoverage = workerCreeps.some(isAssignedHarvestCreep);
  const hasDedicatedHarvestCoverage = roomCreeps.some(isDedicatedHarvestCreep);
  if (hasWorkerHarvestCoverage || (hasDedicatedHarvestCoverage && !hasSpawnExtensionEnergyDeficit)) {
    return false;
  }

  const hasBuildDeadlockSignal =
    (workerCreeps.length > 1 && roomCreeps.some(isZeroEnergyBuildWorker)) ||
    (workerCreeps.length > 1 && workerCreeps.every(isBuildAssignedWorker));
  const hasGenericDeadlockSignal =
    (workerCreeps.length > 1 && workerCreeps.every(isAssignedNonHarvestWorker)) ||
    (hasSpawnExtensionEnergyDeficit && workerCreeps.some(isAssignedNonHarvestWorker));

  return (
    hasBuildDeadlockSignal ||
    hasGenericDeadlockSignal ||
    (isBuildAssignedWorker(creep) && hasSpawnExtensionEnergyDeficit)
  );
}

function shouldForceGenericHarvestForThroughputRecovery(creep: Creep): boolean {
  return (
    hasLowWorkerThroughputRecoveryPressure(creep) &&
    !getSameRoomCreepsIncludingCurrent(creep).filter(isWorkerCreep).some(isAssignedHarvestCreep)
  );
}

function getSameRoomCreepsIncludingCurrent(creep: Creep): Creep[] {
  const roomCreeps = getGameCreeps().filter((candidate) => isInRoom(candidate, creep.room));
  if (!roomCreeps.some((candidate) => isSameCreep(candidate, creep))) {
    roomCreeps.push(creep);
  }

  return roomCreeps;
}

function hasRoomSpawnExtensionEnergyDeficit(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  return (
    energyAvailable !== null &&
    energyCapacityAvailable !== null &&
    Math.max(0, energyAvailable) < Math.max(0, energyCapacityAvailable)
  );
}

function isAssignedHarvestCreep(creep: Creep): boolean {
  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'harvest';
}

function isDedicatedHarvestCreep(creep: Creep): boolean {
  return (
    creep.memory?.role === SOURCE_HARVESTER_ROLE &&
    typeof creep.memory.sourceHarvester?.sourceId === 'string'
  );
}

function isWorkerCreep(creep: Creep): boolean {
  return creep.memory?.role === 'worker';
}

function isAssignedNonHarvestWorker(creep: Creep): boolean {
  return isWorkerCreep(creep) && creep.memory.task !== undefined && creep.memory.task.type !== 'harvest';
}

function isZeroEnergyBuildWorker(creep: Creep): boolean {
  return isBuildAssignedWorker(creep) && getUsedEnergy(creep) <= 0;
}

function isBuildAssignedWorker(creep: Creep): boolean {
  return creep.memory?.role === 'worker' && creep.memory.task?.type === 'build';
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
  if (!controller) {
    return null;
  }

  return canUpgradeController(controller) ? { type: 'upgrade', targetId: controller.id } : null;
}

function selectColonyRecallEnergySink(room: Room): FillableEnergySink | null {
  const energySinks = findFillableEnergySinksInRoom(room);
  return (
    selectFirstEnergySinkByStableId(energySinks.filter(isSpawnOrExtensionEnergySink)) ??
    selectFirstEnergySinkByStableId(energySinks.filter(isTowerEnergySink))
  );
}

function selectSpawnStagingContainerEnergySink(creep: Creep): StructureContainer | null {
  if (!isReturningFreshHarvestEnergy(creep)) {
    return null;
  }

  return findVisibleRoomStructures(creep.room)
    .filter((structure): structure is StructureContainer => isSpawnStagingContainer(creep.room, structure))
    .filter((container) => getFreeStoredEnergyCapacity(container) > 0)
    .sort((left, right) =>
      compareOptionalRanges(getRangeBetweenRoomObjects(creep, left), getRangeBetweenRoomObjects(creep, right)) ||
      String(left.id).localeCompare(String(right.id))
    )[0] ?? null;
}

function isReturningFreshHarvestEnergy(creep: Creep): boolean {
  const task = creep.memory?.task;
  return (
    task?.type === 'harvest' &&
    task.sourceContainerAssigned !== true &&
    getUsedEnergy(creep) > 0
  );
}

function selectControllerSustainUpgradeTask(
  creep: Creep,
  controller: StructureController | undefined
): Extract<CreepTaskMemory, { type: 'upgrade' }> | null {
  const sustain = creep.memory?.controllerSustain;
  if (
    sustain?.role !== 'upgrader' ||
    sustain.targetRoom !== creep.room?.name ||
    controller?.my !== true ||
    !canLevelUpController(controller) ||
    shouldYieldControllerSustainUpgradeToConstruction(creep, sustain)
  ) {
    return null;
  }

  return { type: 'upgrade', targetId: controller.id };
}

function selectControllerSustainBarrierMaintenanceTask(
  creep: Creep,
  constructionSites: ConstructionSite[]
): Extract<CreepTaskMemory, { type: 'repair' }> | null {
  const sustain = creep.memory?.controllerSustain;
  if (
    sustain?.role !== 'upgrader' ||
    sustain.targetRoom !== creep.room?.name ||
    constructionSites.length > 0 ||
    hasSameRoomWorkerAssignedToTask(creep.room, creep, 'repair')
  ) {
    return null;
  }

  const barrierMaintenanceTarget = selectRoutineBarrierMaintenanceRepairTarget(creep);
  return barrierMaintenanceTarget
    ? { type: 'repair', targetId: barrierMaintenanceTarget.id as Id<Structure> }
    : null;
}

function selectUncoveredRoutineRampartMaintenanceTask(
  creep: Creep,
  constructionSites: ConstructionSite[]
): Extract<CreepTaskMemory, { type: 'repair' }> | null {
  if (constructionSites.length > 0 || hasSameRoomWorkerAssignedToTask(creep.room, creep, 'repair')) {
    return null;
  }

  const rampartMaintenanceTarget = selectRoutineRampartMaintenanceRepairTarget(creep);
  if (!rampartMaintenanceTarget) {
    return null;
  }

  return { type: 'repair', targetId: rampartMaintenanceTarget.id as Id<Structure> };
}

function shouldYieldControllerSustainUpgradeToConstruction(
  creep: Creep,
  sustain: CreepControllerSustainMemory
): boolean {
  if (!hasVisibleOwnedConstructionDemand(creep.room)) {
    return false;
  }

  if (sustain.homeRoom !== sustain.targetRoom) {
    return true;
  }

  return shouldYieldLocalControllerSustainUpgradeToConstruction(creep);
}

function shouldYieldLocalControllerSustainUpgradeToConstruction(creep: Creep): boolean {
  return (
    creep.room.controller?.my === true &&
    !isControllerDowngradeImminentForLowLoadReturn(creep.room.controller) &&
    !hasVisibleHostilePresence(creep.room) &&
    !hasActiveSpawningSpawn(creep.room) &&
    !hasSameRoomWorkerAssignedToTask(creep.room, creep, 'build') &&
    hasMinimumProductiveWorkerCoverageForBoundedConstruction(creep) &&
    hasSpendableConstructionBacklog(creep)
  );
}

function hasVisibleOwnedConstructionDemand(room: Room | undefined): boolean {
  if (typeof FIND_CONSTRUCTION_SITES !== 'number' || typeof room?.find !== 'function') {
    return false;
  }

  const sites = room.find(FIND_CONSTRUCTION_SITES) as ConstructionSite[];
  return sites.some((site) => site.my !== false);
}

function selectManagedControllerUpgradeTask(
  creep: Creep,
  controller: StructureController | undefined,
  carriedEnergy: number
): Extract<CreepTaskMemory, { type: 'upgrade' }> | null {
  const upgrade = creep.memory?.controllerUpgrade;
  if (
    carriedEnergy <= 0 ||
    !upgrade ||
    upgrade.roomName !== creep.room?.name ||
    controller?.my !== true ||
    controller.id !== upgrade.controllerId ||
    !canUpgradeController(controller)
  ) {
    return null;
  }

  return { type: 'upgrade', targetId: controller.id };
}

function selectUpgraderBoostUpgradeTask(
  creep: Creep,
  controller: StructureController | undefined,
  carriedEnergy: number
): Extract<CreepTaskMemory, { type: 'upgrade' }> | null {
  if (carriedEnergy <= 0 || !isUpgraderBoostActive(creep, controller)) {
    return null;
  }

  return { type: 'upgrade', targetId: controller.id };
}

function selectUpgraderBoostEnergyAcquisitionTask(
  creep: Creep,
  controller: StructureController | undefined
): WorkerEnergyAcquisitionTask | null {
  if (
    !isUpgraderBoostActive(creep, controller) ||
    !hasLowEnergyForUpgraderBoost(creep) ||
    getFreeEnergyCapacity(creep) <= 0
  ) {
    return null;
  }

  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const candidates = findVisibleRoomStructures(creep.room)
    .filter(
      (structure): structure is UpgraderBoostStoredEnergySource =>
        isSafeStoredEnergySource(structure, context) && isUpgraderBoostStoredEnergySource(structure)
    )
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
    });

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}

export function isUpgraderBoostActive(
  creep: Creep,
  controller: StructureController | undefined
): controller is StructureController {
  return isUpgraderCreep(creep) && !hasVisibleHostilePresence(creep.room) && isControllerNearLevelUp(controller);
}

function isUpgraderCreep(creep: Creep): boolean {
  return (
    creep.memory?.role === 'upgrader' ||
    creep.memory?.controllerSustain?.role === 'upgrader' ||
    creep.memory?.controllerUpgrade !== undefined
  );
}

function isControllerNearLevelUp(controller: StructureController | undefined): controller is StructureController {
  if (!controller || !canLevelUpController(controller)) {
    return false;
  }

  const progress = controller.progress;
  const progressTotal = controller.progressTotal;
  return (
    typeof progress === 'number' &&
    Number.isFinite(progress) &&
    typeof progressTotal === 'number' &&
    Number.isFinite(progressTotal) &&
    progressTotal > 0 &&
    Math.max(0, progress) / progressTotal >= UPGRADER_BOOST_CONTROLLER_PROGRESS_RATIO
  );
}

function hasLowEnergyForUpgraderBoost(creep: Creep): boolean {
  const carriedEnergy = getUsedEnergy(creep);
  const freeCapacity = getFreeEnergyCapacity(creep);
  const capacity = getEnergyCapacity(creep, carriedEnergy, freeCapacity);
  return capacity > 0 && carriedEnergy < capacity * UPGRADER_BOOST_LOW_ENERGY_RATIO;
}

function isUpgraderBoostStoredEnergySource(
  source: StoredWorkerEnergySource
): source is UpgraderBoostStoredEnergySource {
  return (
    matchesStructureType(source.structureType, 'STRUCTURE_CONTAINER', 'container') ||
    matchesStructureType(source.structureType, 'STRUCTURE_STORAGE', 'storage')
  );
}

function selectFirstEnergySinkByStableId<T extends FillableEnergySink>(energySinks: T[]): T | null {
  return [...energySinks].sort(compareEnergySinkId)[0] ?? null;
}

function selectEmergencySpawnExtensionRefillTask(
  creep: Creep,
  spawnOrExtensionEnergySink: StructureSpawn | StructureExtension | null
): CreepTaskMemory | null {
  if (!spawnOrExtensionEnergySink || !hasEmergencySpawnExtensionRefillDemand(creep)) {
    return null;
  }

  const refillTask: Extract<CreepTaskMemory, { type: 'transfer' }> = {
    type: 'transfer',
    targetId: spawnOrExtensionEnergySink.id as Id<AnyStoreStructure>
  };
  if (isCriticalSpawnEnergySink(spawnOrExtensionEnergySink)) {
    recordSpawnCriticalRefillTelemetry(creep, spawnOrExtensionEnergySink);
  }
  recordLowLoadReturnTelemetry(creep, refillTask, 'emergencySpawnExtensionRefill');
  return refillTask;
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
    canLevelUpController(controller) &&
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

  const threatenedBarrierRepairTarget = selectThreatenedBarrierRepairTarget(creep);
  if (threatenedBarrierRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: 'repair',
      targetId: threatenedBarrierRepairTarget.id as Id<Structure>
    });
  }

  if (shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)) {
    return null;
  }

  const bootstrapConstructionSite = selectBootstrapSurvivalConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (bootstrapConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: bootstrapConstructionSite.id });
  }

  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (criticalRoadConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: criticalRoadConstructionSite.id });
  }

  const throughputRecoveryConstructionSite = selectLowWorkerThroughputRecoveryConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (throughputRecoveryConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: 'build', targetId: throughputRecoveryConstructionSite.id });
  }

  return null;
}

function selectBootstrapSurvivalConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ConstructionSite | null {
  if (getUsedEnergy(creep) <= 0 || hasOtherSameRoomLoadedBuildWorker(creep)) {
    return null;
  }

  const priorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    (site) => isBootstrapSurvivalConstructionSite(site, priorityContext),
    { priorityContext }
  );
}

function isBootstrapSurvivalConstructionSite(
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext
): boolean {
  return (
    isSpawnConstructionSite(site) ||
    isCapacityEnablingConstructionSite(site, priorityContext) ||
    isCriticalRoadLogisticsConstructionSite(site, priorityContext)
  );
}

function isCriticalRoadLogisticsConstructionSite(
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext
): boolean {
  return (
    isRoadConstructionSite(site) &&
    priorityContext.criticalRoadContext !== undefined &&
    isCriticalRoadLogisticsWork(site, priorityContext.criticalRoadContext)
  );
}

function hasOtherSameRoomLoadedBuildWorker(creep: Creep): boolean {
  return getGameCreeps().some(
    (worker) =>
      !isSameCreep(worker, creep) &&
      isSameRoomWorker(worker, creep.room) &&
      worker.memory?.task?.type === 'build' &&
      getUsedEnergy(worker) > 0
  );
}

function selectLowWorkerThroughputRecoveryConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ConstructionSite | null {
  if (!hasLowWorkerThroughputRecoveryPressure(creep) || hasOtherSameRoomLoadedBuildWorker(creep)) {
    return null;
  }

  const priorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    () => true,
    { priorityContext }
  );
}

function hasLowWorkerThroughputRecoveryPressure(creep: Creep): boolean {
  const room = creep.room;
  const controller = room.controller;
  if (
    creep.memory?.role !== 'worker' ||
    controller?.my !== true ||
    getControllerLevel(controller) > 2 ||
    shouldGuardControllerDowngrade(controller) ||
    hasVisibleHostilePresence(room)
  ) {
    return false;
  }

  const energyAvailable = getRoomEnergyAvailable(room);
  if (energyAvailable === null || energyAvailable >= getEffectiveRoomEnergyBufferThreshold(room)) {
    return false;
  }

  if (!hasVisibleOwnedConstructionDemand(room)) {
    return false;
  }

  return getSameRoomCreepsIncludingCurrent(creep).filter(isWorkerCreep).length <= LOW_WORKER_THROUGHPUT_WORKER_COUNT;
}

function getControllerLevel(controller: StructureController): number {
  return typeof controller.level === 'number' && Number.isFinite(controller.level)
    ? Math.max(0, Math.floor(controller.level))
    : 0;
}

function shouldPrioritizeRcl3TowerActivationRefill(
  controller: StructureController | undefined
): boolean {
  return controller?.my === true && getControllerLevel(controller) >= 3;
}

function shouldSuppressBootstrapControllerSpending(creep: Creep, recoveryOnlyWorkSuppressed: boolean): boolean {
  return recoveryOnlyWorkSuppressed && !isWorkerInColonyRoom(creep);
}

export function estimateNearTermSpawnExtensionRefillReserve(room: Room): number {
  const spawnExtensionEnergyStructures = findSpawnExtensionEnergyStructures(room);
  return estimateNearTermSpawnExtensionRefillReserveFromStructures(room, spawnExtensionEnergyStructures);
}

export function selectRemoteHaulerDeliveryTask(
  room: Room
): Extract<CreepTaskMemory, { type: 'transfer' }> | null {
  const sink = selectRemoteHaulerDeliverySink(room);
  return sink ? { type: 'transfer', targetId: sink.id as Id<AnyStoreStructure> } : null;
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
    estimateNearTermSpawnCompletionRefillReserve(room, spawnExtensionEnergyStructures),
    getUnmetSpawnEnergyReservation(room)
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
  if (energyAvailable !== null && energyAvailable >= URGENT_SPAWN_REFILL_ENERGY_THRESHOLD) {
    return false;
  }

  if (!getLowLoadWorkerEnergyContext(creep)) {
    return true;
  }

  return hasTrueLowLoadSpawnExtensionRefillEmergency(creep);
}

function hasTrueLowLoadSpawnExtensionRefillEmergency(creep: Creep): boolean {
  if (hasVisibleHostilePresence(creep.room)) {
    return true;
  }

  if (isControllerDowngradeImminentForLowLoadReturn(creep.room.controller)) {
    return true;
  }

  if (isNearTermSpawnCompletionBlockedWithoutLowLoadEnergy(creep)) {
    return true;
  }

  return selectLowLoadSpawnExtensionDeliveryContinuationCandidate(creep) === null;
}

function isNearTermSpawnCompletionBlockedWithoutLowLoadEnergy(creep: Creep): boolean {
  const spawnExtensionEnergyStructures = findSpawnExtensionEnergyStructures(creep.room);
  if (!spawnExtensionEnergyStructures.some(isNearTermSpawningSpawn)) {
    return false;
  }

  const energyAvailable = getRoomEnergyAvailable(creep.room);
  if (energyAvailable === null) {
    return true;
  }

  const otherRefillCoverageEnergy = getOtherNearTermSpawnExtensionRefillCoverageEnergy(
    creep,
    spawnExtensionEnergyStructures
  );
  return energyAvailable + otherRefillCoverageEnergy < MINIMUM_WORKER_SPAWN_ENERGY;
}

function getOtherNearTermSpawnExtensionRefillCoverageEnergy(
  creep: Creep,
  spawnExtensionEnergyStructures: SpawnExtensionEnergyStructure[]
): number {
  const spawnExtensionEnergyStructureIds = new Set(
    spawnExtensionEnergyStructures.map((structure) => String(structure.id))
  );

  return getSameRoomLoadedWorkersForRefillReservations(creep)
    .filter((worker) => !isSameCreep(worker, creep))
    .filter((worker) =>
      isWorkerRefillBoundOrReservableForSpawnExtensionDelivery(worker, spawnExtensionEnergyStructureIds)
    )
    .reduce((total, worker) => total + getUsedEnergy(worker), 0);
}

function isWorkerRefillBoundOrReservableForSpawnExtensionDelivery(
  worker: Creep,
  spawnExtensionEnergyStructureIds: ReadonlySet<string>
): boolean {
  const task = worker.memory?.task as Partial<CreepTaskMemory> | null | undefined;
  return task == null || (
    task?.type === 'transfer' &&
    task.targetId !== undefined &&
    spawnExtensionEnergyStructureIds.has(String(task.targetId))
  );
}

function shouldGuardControllerDowngradeForWorkerLoad(
  creep: Creep,
  controller: StructureController | undefined,
  options: ControllerDowngradeGuardOptions = {}
): boolean {
  if (!shouldGuardControllerDowngrade(controller)) {
    return false;
  }

  if (
    (options.allowConstructionBacklogYield ?? true) &&
    shouldYieldControllerDowngradeGuardToConstructionBacklog(creep, controller)
  ) {
    return false;
  }

  return !getLowLoadWorkerEnergyContext(creep) || isControllerDowngradeImminentForLowLoadReturn(controller);
}

function isControllerDowngradeImminentForLowLoadReturn(
  controller: StructureController | undefined
): boolean {
  return (
    controller?.my === true &&
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade < LOW_LOAD_CONTROLLER_DOWNGRADE_IMMINENT_TICKS
  );
}

function shouldYieldControllerDowngradeGuardToConstructionBacklog(
  creep: Creep,
  controller: StructureController | undefined
): boolean {
  if (
    controller?.my !== true ||
    isControllerDowngradeImminentForLowLoadReturn(controller) ||
    getUsedEnergy(creep) <= 0 ||
    getActiveWorkParts(creep) <= 0 ||
    hasSameRoomWorkerAssignedToTask(creep.room, creep, 'build') ||
    !hasSpendableConstructionBacklog(creep)
  ) {
    return false;
  }

  if (controller.level === 2) {
    return hasOtherLoadedWorkerUpgradingController(creep, controller);
  }

  return (
    controller.level >= 3 &&
    hasHealthyRoomEnergyBuffer(creep.room) &&
    hasMinimumProductiveWorkerCoverageForBoundedConstruction(creep)
  );
}

function hasOtherLoadedWorkerUpgradingController(creep: Creep, controller: StructureController): boolean {
  return getSameRoomLoadedWorkers(creep).some(
    (worker) =>
      !isSameCreep(worker, creep) &&
      getActiveWorkParts(worker) > 0 &&
      isUpgradingController(worker, controller)
  );
}

function hasSpendableConstructionBacklog(creep: Creep): boolean {
  if (typeof FIND_CONSTRUCTION_SITES !== 'number' || typeof creep.room?.find !== 'function') {
    return false;
  }

  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES) as ConstructionSite[];
  if (constructionSites.length === 0) {
    return false;
  }

  const constructionReservationContext = createConstructionReservationContext(creep.room);
  return hasSpendableConstructionBacklogFromSites(creep, constructionSites, constructionReservationContext);
}

function hasSpendableConstructionBacklogFromSites(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): boolean {
  const priorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  return constructionSites.some(
    (site) =>
      site.my !== false &&
      hasUnreservedConstructionProgress(creep, site, constructionReservationContext) &&
      canSpendCreepEnergyOnConstructionSite(creep, site, priorityContext)
  );
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

  const lowLoadEnergyContinuationTask = selectLowLoadWorkerEnergyContinuationTask(
    creep,
    getLowLoadWorkerEnergyContinuationRange(creep, task)
  );
  if (lowLoadEnergyContinuationTask) {
    return lowLoadEnergyContinuationTask;
  }

  recordLowLoadReturnTelemetry(creep, task, 'noReachableEnergy');
  return task;
}

function getLowLoadWorkerEnergyContinuationRange(creep: Creep, task: WorkerEnergySpendingTask): number {
  return shouldUseExtendedLowLoadSourceLogisticsContinuation(creep, task)
    ? LOW_LOAD_SOURCE_LOGISTICS_CONTINUATION_MAX_RANGE
    : LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE;
}

function shouldUseExtendedLowLoadSourceLogisticsContinuation(
  creep: Creep,
  task: WorkerEnergySpendingTask
): boolean {
  return (
    task.type === 'build' &&
    isSourceLogisticsConstructionTask(creep, task) &&
    hasHealthyRoomEnergyBuffer(creep.room) &&
    !hasEmergencySpawnExtensionRefillDemand(creep)
  );
}

function isSourceLogisticsConstructionTask(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'build' }>
): boolean {
  const site = getGameObjectById<ConstructionSite>(String(task.targetId));
  if (!site) {
    return false;
  }

  const priority = getConstructionSiteImpactPriority(
    site,
    buildWorkerConstructionSiteImpactPriorityContext(creep, [site])
  );
  return (
    priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.sourceContainer ||
    priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.energyStarvedSourceContainer ||
    priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.criticalRoad ||
    priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.energyStarvedCriticalRoad
  );
}

function applyMinimumUsefulSpawnExtensionDeliveryPolicy(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'transfer' }>
): Extract<CreepTaskMemory, { type: 'transfer' }> | LowLoadWorkerEnergyAcquisitionTask {
  if (!getLowLoadWorkerEnergyContext(creep)) {
    return task;
  }

  if (hasVisibleHostilePresence(creep.room)) {
    recordLowLoadReturnTelemetry(creep, task, 'hostileSafety');
    return task;
  }

  const shouldUseExtendedContinuation = hasKnownSpawnExtensionEnergyCapacity(creep.room);
  const lowLoadEnergyContinuationTask = shouldUseExtendedContinuation
    ? selectLowLoadSpawnExtensionDeliveryContinuationTask(creep)
    : selectLowLoadWorkerEnergyContinuationTask(creep);
  if (lowLoadEnergyContinuationTask) {
    return lowLoadEnergyContinuationTask;
  }

  recordLowLoadReturnTelemetry(creep, task, shouldUseExtendedContinuation ? 'noNearbyEnergy' : 'noReachableEnergy');
  return task;
}

function hasKnownSpawnExtensionEnergyCapacity(room: Room): boolean {
  return getRoomEnergyCapacityAvailable(room) !== null;
}

function clearWorkerTaskSelectionTelemetry(creep: Creep): void {
  const memory = creep.memory;
  if (memory) {
    delete memory.workerEfficiency;
    delete memory.spawnCriticalRefill;
  }
}

function recordSpawnCriticalRefillTelemetry(creep: Creep, spawn: StructureSpawn): void {
  if (isWorkerTaskSelectionTelemetrySuppressed()) {
    return;
  }

  const memory = creep.memory;
  if (!memory) {
    return;
  }

  memory.spawnCriticalRefill = {
    type: 'spawnCriticalRefill',
    tick: getGameTick() ?? 0,
    targetId: String(spawn.id),
    carriedEnergy: getUsedEnergy(creep),
    spawnEnergy: getKnownStoredEnergy(spawn) ?? 0,
    freeCapacity: getFreeStoredEnergyCapacity(spawn),
    threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
  };
}

function recordNearbyEnergyChoiceTelemetry(
  creep: Creep,
  candidate: LowLoadWorkerEnergyAcquisitionCandidate
): void {
  if (isWorkerTaskSelectionTelemetrySuppressed()) {
    return;
  }

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
  if (isWorkerTaskSelectionTelemetrySuppressed()) {
    return;
  }

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

function selectStorageToSpawnExtensionRefillAcquisitionTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'withdraw' }> | null {
  if (!isSpawnExtensionThroughputBottlenecked(creep.room) || getFreeEnergyCapacity(creep) <= 0) {
    return null;
  }

  const storage = selectStorageForSpawnExtensionRefill(creep);
  if (!storage) {
    return null;
  }

  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const storageEnergy = getStoredEnergy(storage);
  const reservedEnergy = getReservedWorkerEnergyAcquisitionAmount(storage, reservationContext);
  const projectedStorageEnergy = Math.max(0, storageEnergy - reservedEnergy);
  const plannedWithdrawal = Math.min(projectedStorageEnergy, creep.store.getFreeCapacity(RESOURCE_ENERGY));
  if (
    plannedWithdrawal <= 0 ||
    plannedWithdrawal >
      getStorageEnergyAvailableForWithdrawal(
        creep.room,
        storage,
        projectedStorageEnergy,
        SPAWN_EXTENSION_REFILL_STORAGE_WITHDRAWAL_OPTIONS
      ) ||
    !withdrawFromStorage(
      creep.room,
      plannedWithdrawal,
      storage,
      projectedStorageEnergy,
      SPAWN_EXTENSION_REFILL_STORAGE_WITHDRAWAL_OPTIONS
    )
  ) {
    return null;
  }

  return { type: 'withdraw', targetId: storage.id as Id<AnyStoreStructure> };
}

function isSpawnExtensionThroughputBottlenecked(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyAvailable === null || energyCapacityAvailable === null || energyCapacityAvailable <= 0) {
    return false;
  }

  const freeEnergyCapacity = Math.max(0, energyCapacityAvailable - energyAvailable);
  return freeEnergyCapacity > energyCapacityAvailable * SPAWN_EXTENSION_THROUGHPUT_STORAGE_REFILL_EMPTY_CAPACITY_RATIO;
}

function selectStorageForSpawnExtensionRefill(creep: Creep): StructureStorage | null {
  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const storageSources: StructureStorage[] = findVisibleRoomStructures(creep.room).filter(
    (structure): structure is StructureStorage =>
      isSafeStoredEnergySource(structure, context) &&
      structure.structureType === 'storage' &&
      getStorageEnergyAvailableForWithdrawal(
        creep.room,
        structure as StructureStorage,
        getStoredEnergy(structure as StructureStorage),
        SPAWN_EXTENSION_REFILL_STORAGE_WITHDRAWAL_OPTIONS
      ) > 0
  );

  if (storageSources.length === 0) {
    return null;
  }

  const scoredStorageSources = scoreStoredEnergySources(creep, storageSources);
  if (scoredStorageSources.length > 0) {
    return scoredStorageSources.sort(compareStoredEnergySourceScores)[0].source as StructureStorage;
  }

  const closestStorageEnergy = findClosestByRange(creep, storageSources);
  return closestStorageEnergy ? (closestStorageEnergy as StructureStorage) : storageSources[0];
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
    compareCriticalSpawnPriority(left, right) ||
    compareLowEnergySpawnPriority(left, right) ||
    compareAcceptedDeliveryEnergy(leftDeliveryCapacity, rightDeliveryCapacity, carriedEnergy) ||
    compareAssignedTransferTarget(left, right, assignedTransferTargetId) ||
    compareOptionalRanges(getRangeBetweenRoomObjects(creep, left), getRangeBetweenRoomObjects(creep, right)) ||
    compareEnergySinkId(left, right)
  );
}

function compareCriticalSpawnPriority(
  left: StructureSpawn | StructureExtension,
  right: StructureSpawn | StructureExtension
): number {
  if (isSpawnEnergySink(left) && isSpawnEnergySink(right)) {
    return 0;
  }

  const leftCriticalSpawn = isCriticalSpawnEnergySink(left);
  const rightCriticalSpawn = isCriticalSpawnEnergySink(right);
  if (leftCriticalSpawn === rightCriticalSpawn) {
    return 0;
  }

  return leftCriticalSpawn ? -1 : 1;
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

function isCriticalSpawnEnergySink(structure: StructureSpawn | StructureExtension): structure is StructureSpawn {
  const storedEnergy = getKnownStoredEnergy(structure);
  return (
    isSpawnEnergySink(structure) &&
    storedEnergy !== null &&
    storedEnergy < CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
  );
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
  if (!shouldPrioritizeRcl3TowerActivationRefill(creep.room.controller)) {
    return null;
  }

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

function selectEnergySurplusStorageTask(
  creep: Creep,
  carriedEnergy: number
): Extract<CreepTaskMemory, { type: 'transfer' }> | null {
  if (
    carriedEnergy <= 0 ||
    !isWorkerInColonyRoom(creep) ||
    creep.memory?.controllerSustain ||
    creep.memory?.territory
  ) {
    return null;
  }

  const sink = selectEnergySurplusDeliverySink(creep.room, carriedEnergy);
  return sink ? { type: 'transfer', targetId: sink.id as Id<AnyStoreStructure> } : null;
}

function selectInterRoomForeignRoomRecallTask(
  creep: Creep,
  carriedEnergy: number
): CreepTaskMemory | null {
  if (!isEligibleInterRoomEnergyHaulWorker(creep) || isWorkerInColonyRoom(creep)) {
    return null;
  }

  const existingTransfer = selectExistingInterRoomEnergyTransfer(creep);
  if (existingTransfer) {
    return carriedEnergy > 0
      ? selectInterRoomDeliveryTask(creep, existingTransfer, carriedEnergy)
      : selectInterRoomCollectionTask(creep, existingTransfer);
  }

  return carriedEnergy > 0
    ? selectInterRoomForeignRoomReturnTask(creep, carriedEnergy)
    : selectInterRoomHomeEnergyAcquisitionTask(creep);
}

function selectInterRoomEnergyHaulingTask(
  creep: Creep,
  carriedEnergy: number
): CreepTaskMemory | null {
  if (!isEligibleInterRoomEnergyHaulWorker(creep)) {
    clearInterRoomEnergyHaulAssignment(creep);
    return null;
  }

  const transfer =
    selectExistingInterRoomEnergyTransfer(creep) ??
    selectNewInterRoomEnergyTransfer(creep, carriedEnergy);
  if (!transfer) {
    clearInterRoomEnergyHaulAssignment(creep);
    return selectInterRoomForeignRoomRecallTask(creep, carriedEnergy);
  }

  return carriedEnergy > 0
    ? selectInterRoomDeliveryTask(creep, transfer, carriedEnergy)
    : selectInterRoomCollectionTask(creep, transfer);
}

function selectInterRoomCollectionTask(
  creep: Creep,
  transfer: EconomyStorageTransferMemory
): Extract<CreepTaskMemory, { type: 'withdraw' }> | null {
  if (getFreeEnergyCapacity(creep) <= 0) {
    return null;
  }

  const source = selectInterRoomEnergySource(transfer.sourceRoom, creep.memory.interRoomEnergyHaul?.sourceId);
  if (!source) {
    clearInterRoomEnergyHaulAssignment(creep);
    return null;
  }

  const task: Extract<CreepTaskMemory, { type: 'withdraw' }> = {
    type: 'withdraw',
    targetId: source.id as Id<AnyStoreStructure>
  };
  recordInterRoomEnergyHaulAssignment(creep, transfer, { sourceId: source.id as Id<AnyStoreStructure> });
  syncInterRoomHaulReservationCache(creep, task);
  return task;
}

function selectInterRoomDeliveryTask(
  creep: Creep,
  transfer: EconomyStorageTransferMemory,
  carriedEnergy: number
): Extract<CreepTaskMemory, { type: 'transfer' }> | null {
  const target = selectInterRoomEnergyTarget(transfer.targetRoom, creep.memory.interRoomEnergyHaul?.targetId);
  if (!target) {
    return selectInterRoomForeignRoomReturnTask(creep, carriedEnergy);
  }

  const task: Extract<CreepTaskMemory, { type: 'transfer' }> = {
    type: 'transfer',
    targetId: target.id as Id<AnyStoreStructure>
  };
  recordInterRoomEnergyHaulAssignment(creep, transfer, { targetId: target.id as Id<AnyStoreStructure> });
  syncInterRoomHaulReservationCache(creep, task);
  return task;
}

function selectExistingInterRoomEnergyTransfer(creep: Creep): EconomyStorageTransferMemory | null {
  const assignment = normalizeInterRoomEnergyHaulMemory(creep.memory?.interRoomEnergyHaul);
  if (!assignment) {
    clearInterRoomEnergyHaulAssignment(creep);
    return null;
  }

  const transfer = findInterRoomEnergyTransfer(assignment.sourceRoom, assignment.targetRoom);
  if (!transfer || !isWorkerAllowedForInterRoomTransfer(creep, transfer) || !isCachedLiveTransferCandidate(transfer)) {
    clearInterRoomEnergyHaulAssignment(creep);
    return null;
  }

  creep.memory.interRoomEnergyHaul = assignment;
  return transfer;
}

function selectNewInterRoomEnergyTransfer(
  creep: Creep,
  carriedEnergy: number
): EconomyStorageTransferMemory | null {
  const colonyName = getCreepColonyName(creep);
  if (!colonyName || !isWorkerInColonyRoom(creep)) {
    return null;
  }

  const minimumRemainingEnergy = Math.max(1, carriedEnergy || getFreeEnergyCapacity(creep));
  return (
    getStorageBalanceState().transfers
      .filter((transfer) => isWorkerAllowedForInterRoomTransfer(creep, transfer))
      .filter((transfer) => transfer.amount > 0)
      .filter(isCachedLiveTransferCandidate)
      .filter((transfer) => getRemainingInterRoomHaulEnergy(transfer, creep) >= minimumRemainingEnergy)
      .sort(compareInterRoomEnergyTransfersForWorker)[0] ?? null
  );
}

function isCachedLiveTransferCandidate(transfer: EconomyStorageTransferMemory): boolean {
  const gameTick = getGameTick();
  if (gameTick === null) {
    return isLiveTransferCandidate(transfer);
  }

  const game = getGameReference();
  if (
    !interRoomLiveTransferCandidateCache ||
    interRoomLiveTransferCandidateCache.tick !== gameTick ||
    interRoomLiveTransferCandidateCache.game !== game
  ) {
    interRoomLiveTransferCandidateCache = {
      game,
      resultsByRoomPair: new Map<string, boolean>(),
      tick: gameTick
    };
  }

  const transferKey = getInterRoomTransferKey(transfer.sourceRoom, transfer.targetRoom);
  const cachedResult = interRoomLiveTransferCandidateCache.resultsByRoomPair.get(transferKey);
  if (cachedResult !== undefined) {
    return cachedResult;
  }

  const result = isLiveTransferCandidate(transfer);
  interRoomLiveTransferCandidateCache.resultsByRoomPair.set(transferKey, result);
  return result;
}

function isWorkerAllowedForInterRoomTransfer(
  creep: Creep,
  transfer: EconomyStorageTransferMemory
): boolean {
  const colonyName = getCreepColonyName(creep);
  return colonyName !== null && transfer.sourceRoom === colonyName && transfer.targetRoom !== colonyName;
}

function findInterRoomEnergyTransfer(
  sourceRoom: string,
  targetRoom: string
): EconomyStorageTransferMemory | null {
  return (
    getStorageBalanceState().transfers.find(
      (transfer) =>
        transfer.sourceRoom === sourceRoom &&
        transfer.targetRoom === targetRoom &&
        transfer.amount > 0
    ) ?? null
  );
}

function compareInterRoomEnergyTransfersForWorker(
  left: EconomyStorageTransferMemory,
  right: EconomyStorageTransferMemory
): number {
  return (
    getRemainingInterRoomHaulEnergy(right) - getRemainingInterRoomHaulEnergy(left) ||
    right.amount - left.amount ||
    left.targetRoom.localeCompare(right.targetRoom) ||
    left.sourceRoom.localeCompare(right.sourceRoom)
  );
}

function getRemainingInterRoomHaulEnergy(
  transfer: EconomyStorageTransferMemory,
  excludedCreep?: Creep
): number {
  return Math.max(0, transfer.amount - getReservedInterRoomHaulEnergy(transfer, excludedCreep));
}

function getReservedInterRoomHaulEnergy(
  transfer: EconomyStorageTransferMemory,
  excludedCreep?: Creep
): number {
  const reservationCache = getInterRoomHaulReservationCache();
  const transferKey = getInterRoomTransferKey(transfer.sourceRoom, transfer.targetRoom);
  const reservedEnergy = reservationCache.reservedEnergyByTransferKey.get(transferKey) ?? 0;
  const excludedEnergy = excludedCreep
    ? getCachedInterRoomHaulReservationEnergy(reservationCache, excludedCreep, transferKey)
    : 0;
  return Math.max(0, reservedEnergy - excludedEnergy);
}

function getInterRoomHaulReservationCache(): InterRoomHaulReservationCache {
  const game = getGameReference();
  const gameTick = getGameTick();
  if (
    interRoomHaulReservationCache &&
    interRoomHaulReservationCache.game === game &&
    interRoomHaulReservationCache.tick === gameTick
  ) {
    return interRoomHaulReservationCache;
  }

  interRoomHaulReservationCache = {
    game,
    reservationsByCreep: new Map<Creep, InterRoomHaulReservation>(),
    reservationsByCreepKey: new Map<string, InterRoomHaulReservation>(),
    reservedEnergyByTransferKey: new Map<string, number>(),
    tick: gameTick
  };

  for (const creep of getGameCreeps()) {
    setCachedInterRoomHaulReservation(
      interRoomHaulReservationCache,
      creep,
      getInterRoomHaulReservation(creep)
    );
  }

  return interRoomHaulReservationCache;
}

function syncInterRoomHaulReservationCache(creep: Creep, selectedTask: CreepTaskMemory): void {
  const reservationCache = getActiveInterRoomHaulReservationCache();
  if (!reservationCache) {
    return;
  }

  setCachedInterRoomHaulReservation(
    reservationCache,
    creep,
    getInterRoomHaulReservation(creep, selectedTask)
  );
}

function clearCachedInterRoomHaulReservation(creep: Creep): void {
  const reservationCache = getActiveInterRoomHaulReservationCache();
  if (!reservationCache) {
    return;
  }

  removeCachedInterRoomHaulReservation(reservationCache, creep);
}

function getActiveInterRoomHaulReservationCache(): InterRoomHaulReservationCache | null {
  const game = getGameReference();
  const gameTick = getGameTick();
  return interRoomHaulReservationCache &&
    interRoomHaulReservationCache.game === game &&
    interRoomHaulReservationCache.tick === gameTick
    ? interRoomHaulReservationCache
    : null;
}

function setCachedInterRoomHaulReservation(
  reservationCache: InterRoomHaulReservationCache,
  creep: Creep,
  reservation: InterRoomHaulReservation | null
): void {
  removeCachedInterRoomHaulReservation(reservationCache, creep);
  if (!reservation || reservation.energy <= 0) {
    return;
  }

  reservationCache.reservedEnergyByTransferKey.set(
    reservation.transferKey,
    (reservationCache.reservedEnergyByTransferKey.get(reservation.transferKey) ?? 0) + reservation.energy
  );

  const creepKey = getCreepStableSortKey(creep);
  if (creepKey.length > 0) {
    reservationCache.reservationsByCreepKey.set(creepKey, reservation);
    return;
  }

  reservationCache.reservationsByCreep.set(creep, reservation);
}

function removeCachedInterRoomHaulReservation(
  reservationCache: InterRoomHaulReservationCache,
  creep: Creep
): void {
  const creepKey = getCreepStableSortKey(creep);
  if (creepKey.length > 0) {
    const keyedReservation = reservationCache.reservationsByCreepKey.get(creepKey);
    if (keyedReservation) {
      decrementCachedInterRoomHaulReservation(reservationCache, keyedReservation);
      reservationCache.reservationsByCreepKey.delete(creepKey);
    }
  }

  const objectReservation = reservationCache.reservationsByCreep.get(creep);
  if (objectReservation) {
    decrementCachedInterRoomHaulReservation(reservationCache, objectReservation);
    reservationCache.reservationsByCreep.delete(creep);
  }
}

function decrementCachedInterRoomHaulReservation(
  reservationCache: InterRoomHaulReservationCache,
  reservation: InterRoomHaulReservation
): void {
  const remainingEnergy = (reservationCache.reservedEnergyByTransferKey.get(reservation.transferKey) ?? 0) -
    reservation.energy;
  if (remainingEnergy > 0) {
    reservationCache.reservedEnergyByTransferKey.set(reservation.transferKey, remainingEnergy);
    return;
  }

  reservationCache.reservedEnergyByTransferKey.delete(reservation.transferKey);
}

function getCachedInterRoomHaulReservationEnergy(
  reservationCache: InterRoomHaulReservationCache,
  creep: Creep,
  transferKey: string
): number {
  const creepKey = getCreepStableSortKey(creep);
  const reservation = creepKey.length > 0
    ? reservationCache.reservationsByCreepKey.get(creepKey)
    : reservationCache.reservationsByCreep.get(creep);
  return reservation?.transferKey === transferKey ? reservation.energy : 0;
}

function getInterRoomHaulReservation(
  creep: Creep,
  selectedTask?: Partial<CreepTaskMemory>
): InterRoomHaulReservation | null {
  return getInterRoomWorkerHaulReservation(creep, selectedTask) ?? getDedicatedCrossRoomHaulReservation(creep);
}

function getInterRoomWorkerHaulReservation(
  creep: Creep,
  selectedTask?: Partial<CreepTaskMemory>
): InterRoomHaulReservation | null {
  if (creep.memory?.role !== 'worker') {
    return null;
  }

  const assignment = normalizeInterRoomEnergyHaulMemory(creep.memory?.interRoomEnergyHaul);
  if (!assignment) {
    return null;
  }

  return {
    energy: isOnInterRoomHaulLeg(creep, assignment, selectedTask)
      ? getEnergyCapacity(creep)
      : getUsedEnergy(creep),
    transferKey: getInterRoomTransferKey(assignment.sourceRoom, assignment.targetRoom)
  };
}

function getDedicatedCrossRoomHaulReservation(creep: Creep): InterRoomHaulReservation | null {
  if (creep.memory?.role !== CROSS_ROOM_HAULER_ROLE) {
    return null;
  }

  const assignment = creep.memory.crossRoomHauler;
  if (!assignment?.homeRoom || !assignment.targetRoom) {
    return null;
  }

  return {
    energy: Math.max(getUsedEnergy(creep), getFreeEnergyCapacity(creep)),
    transferKey: getInterRoomTransferKey(assignment.homeRoom, assignment.targetRoom)
  };
}

function isOnInterRoomHaulLeg(
  creep: Creep,
  assignment: CreepInterRoomEnergyHaulMemory,
  selectedTask?: Partial<CreepTaskMemory>
): boolean {
  const task = selectedTask ?? (creep.memory?.task as Partial<CreepTaskMemory> | undefined);
  if (task?.type === 'withdraw' && assignment.sourceId) {
    return String(task.targetId) === String(assignment.sourceId);
  }

  if (task?.type === 'transfer' && assignment.targetId) {
    return String(task.targetId) === String(assignment.targetId);
  }

  return false;
}

function getInterRoomTransferKey(sourceRoom: string, targetRoom: string): string {
  return `${sourceRoom}\0${targetRoom}`;
}

function selectInterRoomEnergySource(
  roomName: string,
  preferredSourceId?: Id<AnyStoreStructure>
): InterRoomEnergyStore | null {
  const room = getVisibleOwnedRoom(roomName);
  if (!room) {
    return null;
  }

  const sources = findInterRoomEnergyStores(room).filter((source) => getStoredEnergy(source) > 0);
  const preferredSource = sources.find((source) => String(source.id) === String(preferredSourceId));
  if (preferredSource) {
    return preferredSource;
  }

  return sources.sort(compareInterRoomEnergySources)[0] ?? null;
}

function selectInterRoomEnergyTarget(
  roomName: string,
  preferredTargetId?: Id<AnyStoreStructure>
): InterRoomEnergyStore | null {
  const room = getVisibleOwnedRoom(roomName);
  if (!room) {
    return null;
  }

  const targets = findInterRoomEnergyStores(room).filter((target) => getFreeStoredEnergyCapacity(target) > 0);
  const preferredTarget = targets.find((target) => String(target.id) === String(preferredTargetId));
  if (preferredTarget) {
    return preferredTarget;
  }

  return targets.sort(compareInterRoomEnergyTargets)[0] ?? null;
}

function selectInterRoomForeignRoomReturnTask(
  creep: Creep,
  carriedEnergy: number
): Extract<CreepTaskMemory, { type: 'transfer' }> | null {
  if (carriedEnergy <= 0 || isWorkerInColonyRoom(creep)) {
    return null;
  }

  const colonyRoom = getCreepColonyRoom(creep);
  if (!colonyRoom) {
    return null;
  }

  const sink = selectInterRoomRecallEnergySink(colonyRoom);
  return sink ? { type: 'transfer', targetId: sink.id as Id<AnyStoreStructure> } : null;
}

function selectInterRoomHomeEnergyAcquisitionTask(creep: Creep): CreepTaskMemory | null {
  const colonyRoom = getCreepColonyRoom(creep);
  if (!colonyRoom || getFreeEnergyCapacity(creep) <= 0) {
    return null;
  }

  const source = selectInterRoomEnergySource(colonyRoom.name);
  if (source) {
    return { type: 'withdraw', targetId: source.id as Id<AnyStoreStructure> };
  }

  const harvestSource = selectFirstColonyHarvestSource(colonyRoom);
  return harvestSource ? { type: 'harvest', targetId: harvestSource.id } : null;
}

function selectFirstColonyHarvestSource(room: Room): Source | null {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  const sources = room.find(FIND_SOURCES) as Source[];
  return sources
    .filter((source) => source.energy === undefined || source.energy > 0)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function selectInterRoomRecallEnergySink(room: Room): InterRoomRecallEnergySink | null {
  return [
    ...findFillableEnergySinksInRoom(room),
    ...findInterRoomEnergyStores(room)
  ]
    .filter((sink) => getFreeStoredEnergyCapacity(sink) > 0)
    .sort(compareInterRoomRecallEnergySinks)[0] ?? null;
}

function findInterRoomEnergyStores(room: Room): InterRoomEnergyStore[] {
  const stores = [room.storage, room.terminal].filter(
    (store): store is InterRoomEnergyStore => store !== undefined
  );
  const seenIds = new Set<string>();
  return stores.filter((store) => {
    const id = String(store.id);
    if (seenIds.has(id)) {
      return false;
    }

    seenIds.add(id);
    return true;
  });
}

function compareInterRoomEnergySources(
  left: InterRoomEnergyStore,
  right: InterRoomEnergyStore
): number {
  return (
    getStoredEnergy(right) - getStoredEnergy(left) ||
    getInterRoomEnergyStorePriority(right) - getInterRoomEnergyStorePriority(left) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareInterRoomEnergyTargets(
  left: InterRoomEnergyStore,
  right: InterRoomEnergyStore
): number {
  return (
    getInterRoomEnergyStorePriority(right) - getInterRoomEnergyStorePriority(left) ||
    getFreeStoredEnergyCapacity(right) - getFreeStoredEnergyCapacity(left) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareInterRoomRecallEnergySinks(
  left: InterRoomRecallEnergySink,
  right: InterRoomRecallEnergySink
): number {
  return (
    getInterRoomRecallSinkPriority(right) - getInterRoomRecallSinkPriority(left) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function getInterRoomEnergyStorePriority(store: InterRoomEnergyStore): number {
  return matchesStructureType(store.structureType, 'STRUCTURE_STORAGE', 'storage') ? 2 : 1;
}

function getInterRoomRecallSinkPriority(sink: InterRoomRecallEnergySink): number {
  if (matchesStructureType(sink.structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return 5;
  }

  if (matchesStructureType(sink.structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return 4;
  }

  if (matchesStructureType(sink.structureType, 'STRUCTURE_TOWER', 'tower')) {
    return 3;
  }

  if (matchesStructureType(sink.structureType, 'STRUCTURE_STORAGE', 'storage')) {
    return 2;
  }

  return 1;
}

function recordInterRoomEnergyHaulAssignment(
  creep: Creep,
  transfer: EconomyStorageTransferMemory,
  ids: Partial<Pick<CreepInterRoomEnergyHaulMemory, 'sourceId' | 'targetId'>>
): void {
  const gameTick = getGameTick();
  creep.memory.interRoomEnergyHaul = {
    ...creep.memory.interRoomEnergyHaul,
    sourceRoom: transfer.sourceRoom,
    targetRoom: transfer.targetRoom,
    ...ids,
    ...(gameTick === null ? {} : { updatedAt: gameTick })
  };
}

function normalizeInterRoomEnergyHaulMemory(value: unknown): CreepInterRoomEnergyHaulMemory | null {
  if (!isWorkerTaskRecord(value) || !isNonEmptyString(value.sourceRoom) || !isNonEmptyString(value.targetRoom)) {
    return null;
  }

  return {
    sourceRoom: value.sourceRoom,
    targetRoom: value.targetRoom,
    ...(isNonEmptyString(value.sourceId) ? { sourceId: value.sourceId as Id<AnyStoreStructure> } : {}),
    ...(isNonEmptyString(value.targetId) ? { targetId: value.targetId as Id<AnyStoreStructure> } : {}),
    ...(typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
      ? { updatedAt: value.updatedAt }
      : {})
  };
}

function isEligibleInterRoomEnergyHaulWorker(creep: Creep): boolean {
  return (
    creep.memory?.role === 'worker' &&
    getCreepColonyName(creep) !== null &&
    !creep.memory.controllerUpgrade &&
    !creep.memory.controllerSustain &&
    !creep.memory.territory &&
    !creep.memory.spawnSupport
  );
}

function clearInterRoomEnergyHaulAssignment(creep: Creep): void {
  if (creep.memory) {
    clearCachedInterRoomHaulReservation(creep);
    delete creep.memory.interRoomEnergyHaul;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function getVisibleOwnedRoom(roomName: string): Room | null {
  const room = (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
  return room?.controller?.my === true ? room : null;
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

function selectRemoteHaulerDeliverySink(room: Room): RemoteHaulerDeliverySink | null {
  const fillableSinks = findFillableEnergySinksInRoom(room);
  return (
    selectFirstEnergySinkByStableId(fillableSinks.filter(isSpawnOrExtensionEnergySink)) ??
    selectFirstRemoteHaulerStorageSinkByStableId(findRemoteHaulerStorageSinks(room)) ??
    selectFirstRemoteHaulerTerminalSinkByStableId(findRemoteHaulerTerminalSinks(room)) ??
    selectFirstEnergySinkByStableId(fillableSinks.filter(isTowerEnergySink))
  );
}

function findRemoteHaulerStorageSinks(room: Room): StructureStorage[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return room.find(FIND_MY_STRUCTURES, {
    filter: isRemoteHaulerStorageSink
  });
}

function findRemoteHaulerTerminalSinks(room: Room): StructureTerminal[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return room.find(FIND_MY_STRUCTURES, {
    filter: isRemoteHaulerTerminalSink
  });
}

function isRemoteHaulerStoredEnergySink(structure: AnyOwnedStructure): boolean {
  return 'store' in structure && getFreeStoredEnergyCapacity(structure) > 0;
}

function isRemoteHaulerStorageSink(structure: AnyOwnedStructure): structure is StructureStorage {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage') &&
    isRemoteHaulerStoredEnergySink(structure)
  );
}

function isRemoteHaulerTerminalSink(structure: AnyOwnedStructure): structure is StructureTerminal {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_TERMINAL', 'terminal') &&
    isRemoteHaulerStoredEnergySink(structure)
  );
}

function selectFirstRemoteHaulerStorageSinkByStableId(storageSinks: StructureStorage[]): StructureStorage | null {
  return [...storageSinks].sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function selectFirstRemoteHaulerTerminalSinkByStableId(terminalSinks: StructureTerminal[]): StructureTerminal | null {
  return [...terminalSinks].sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
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
  constructionReservationContext: ConstructionReservationContext = createEmptyConstructionReservationContext(),
  options: ConstructionSiteSelectionOptions = {}
): ConstructionSite | null {
  const priorityContext = {
    ...buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites),
    ...options.priorityContext
  };
  const candidates = constructionSites.filter(
    (site) =>
      predicate(site) &&
      !isConstructionSiteSuppressedForWorker(creep, site) &&
      canSpendCreepEnergyOnConstructionSite(creep, site, priorityContext) &&
      (!options.requireReasonableRange ||
        isConstructionSiteWithinReasonableRange(creep, site, DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE))
  );
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
      compareConstructionSiteCandidates(creep, left, right, constructionReservationContext, priorityContext)
    )[0];
  }

  const topImpactCandidates = selectTopImpactConstructionSiteCandidates(candidates, priorityContext);
  const finishPriorityConstructionSite = selectFinishPriorityConstructionSite(
    creep,
    topImpactCandidates,
    constructionReservationContext
  );
  if (finishPriorityConstructionSite) {
    return finishPriorityConstructionSite;
  }

  if (typeof position?.findClosestByRange === 'function') {
    const candidatesByStableId = [...topImpactCandidates].sort(compareConstructionSiteId);
    return position.findClosestByRange(candidatesByStableId) ?? candidatesByStableId[0];
  }

  return topImpactCandidates.sort(compareConstructionSiteId)[0];
}

function isConstructionSiteSuppressedForWorker(creep: Creep, site: ConstructionSite): boolean {
  const blockedBuildTarget = creep.memory?.blockedBuildTarget;
  if (!blockedBuildTarget) {
    return false;
  }

  const tick = getGameTick();
  if (tick !== null && blockedBuildTarget.until <= tick) {
    delete creep.memory.blockedBuildTarget;
    return false;
  }

  return String(blockedBuildTarget.targetId) === String(site.id);
}

function selectUnreservedConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  predicate: (site: ConstructionSite) => boolean = () => true,
  options: ConstructionSiteSelectionOptions = {}
): ConstructionSite | null {
  return selectConstructionSite(
    creep,
    constructionSites,
    (site) => predicate(site) && hasUnreservedConstructionProgress(creep, site, constructionReservationContext),
    constructionReservationContext,
    options
  );
}

function buildWorkerConstructionSiteImpactPriorityContext(
  creep: Creep,
  constructionSites: ConstructionSite[]
): ConstructionSiteImpactPriorityContext {
  const context: ConstructionSiteImpactPriorityContext =
    creep.room.controller?.my === true ? { claimedRoomName: creep.room.name } : {};
  if (isPostClaimConstructionRoom(creep.room.name)) {
    context.postClaimRoomName = creep.room.name;
  }
  if (shouldPrioritizeSourceLogisticsConstruction(creep.room)) {
    context.prioritizeSourceLogisticsForEnergyStarvation = true;
  }
  if (constructionSites.some(isRoadConstructionSite)) {
    context.criticalRoadContext = buildWorkerCriticalRoadLogisticsContext(creep);
  }

  if (constructionSites.some(isContainerConstructionSite)) {
    context.sources = findConstructionPrioritySources(creep.room);
  }

  if (constructionSites.some(isRampartConstructionSite)) {
    context.protectedRampartAnchors = findConstructionPriorityProtectedRampartAnchors(creep.room);
  }

  return context;
}

function findConstructionPrioritySources(room: Room): Source[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const sources = room.find(FIND_SOURCES);
    return Array.isArray(sources) ? sources : [];
  } catch {
    return [];
  }
}

function findConstructionPriorityProtectedRampartAnchors(room: Room): RoomPosition[] {
  const anchors: RoomPosition[] = [];
  if (room.controller?.pos && isPositionInRoom(room.controller.pos, room.name)) {
    anchors.push(room.controller.pos);
  }

  for (const structure of findConstructionPriorityOwnedStructures(room)) {
    if (
      matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') &&
      structure.pos &&
      isPositionInRoom(structure.pos, room.name)
    ) {
      anchors.push(structure.pos);
    }
  }

  return anchors;
}

function findConstructionPriorityOwnedStructures(room: Room): AnyOwnedStructure[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const structures = room.find(FIND_MY_STRUCTURES);
    return Array.isArray(structures) ? structures : [];
  } catch {
    return [];
  }
}

function isPositionInRoom(position: RoomPosition, roomName: string): boolean {
  return typeof position.roomName !== 'string' || position.roomName === roomName;
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

function selectFinishPriorityConstructionSite(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ConstructionSite | null {
  const candidates = constructionSites.filter(
    (site) => getConstructionSiteFinishPriorityScore(creep, site, constructionReservationContext) !== null
  );
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(
    (left, right) =>
      compareConstructionSiteFinishPriority(creep, left, right, constructionReservationContext) ||
      compareConstructionSiteId(left, right)
  )[0];
}

function compareConstructionSiteCandidates(
  creep: Creep,
  left: ConstructionSite,
  right: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext,
  priorityContext: ConstructionSiteImpactPriorityContext
): number {
  return (
    getConstructionSiteImpactPriority(right, priorityContext) -
      getConstructionSiteImpactPriority(left, priorityContext) ||
    compareConstructionSiteFinishPriority(creep, left, right, constructionReservationContext) ||
    compareConstructionSiteReasonableRange(creep, left, right) ||
    compareOptionalRanges(getRangeBetweenRoomObjects(creep, left), getRangeBetweenRoomObjects(creep, right)) ||
    compareConstructionSiteId(left, right)
  );
}

function compareConstructionSiteReasonableRange(
  creep: Creep,
  left: ConstructionSite,
  right: ConstructionSite
): number {
  const leftInRange = isConstructionSiteWithinReasonableRange(
    creep,
    left,
    DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE
  );
  const rightInRange = isConstructionSiteWithinReasonableRange(
    creep,
    right,
    DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE
  );
  if (leftInRange === rightInRange) {
    return 0;
  }

  return leftInRange ? -1 : 1;
}

function isConstructionSiteWithinReasonableRange(
  creep: Creep,
  site: ConstructionSite,
  rangeLimit: number
): boolean {
  const range = getRangeBetweenRoomObjects(creep, site);
  return range === null || range <= rangeLimit;
}

function selectTopImpactConstructionSiteCandidates(
  candidates: ConstructionSite[],
  priorityContext: ConstructionSiteImpactPriorityContext
): ConstructionSite[] {
  const highestPriority = Math.max(
    ...candidates.map((site) => getConstructionSiteImpactPriority(site, priorityContext))
  );
  return candidates.filter((site) => getConstructionSiteImpactPriority(site, priorityContext) === highestPriority);
}

function compareConstructionSiteFinishPriority(
  creep: Creep,
  left: ConstructionSite,
  right: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext
): number {
  const leftFinishPriority = getConstructionSiteFinishPriorityScore(
    creep,
    left,
    constructionReservationContext
  );
  const rightFinishPriority = getConstructionSiteFinishPriorityScore(
    creep,
    right,
    constructionReservationContext
  );
  if (leftFinishPriority === null && rightFinishPriority === null) {
    return 0;
  }

  if (leftFinishPriority === null) {
    return 1;
  }

  if (rightFinishPriority === null) {
    return -1;
  }

  return (
    rightFinishPriority.score - leftFinishPriority.score ||
    leftFinishPriority.remainingProgress - rightFinishPriority.remainingProgress
  );
}

function getConstructionSiteFinishPriorityScore(
  creep: Creep,
  site: ConstructionSite,
  constructionReservationContext: ConstructionReservationContext
): ConstructionSiteFinishPriorityScore | null {
  const remainingProgress = getUnreservedConstructionProgressForWorker(
    creep,
    site,
    constructionReservationContext
  );
  const progressTotal = getConstructionSiteProgressTotal(site);
  if (
    remainingProgress <= 0 ||
    !Number.isFinite(remainingProgress) ||
    progressTotal <= 0 ||
    !Number.isFinite(progressTotal)
  ) {
    return null;
  }

  const canComplete = remainingProgress <= getUsedEnergy(creep) * getBuildPower();
  const nearlyComplete =
    remainingProgress / progressTotal < NEARLY_COMPLETE_CONSTRUCTION_SITE_REMAINING_RATIO;
  if (!canComplete && !nearlyComplete) {
    return null;
  }

  const finishableMultiplier = canComplete ? FINISHABLE_CONSTRUCTION_SITE_PRIORITY_MULTIPLIER : 1;
  const nearlyCompleteMultiplier = nearlyComplete
    ? NEARLY_COMPLETE_CONSTRUCTION_SITE_FINISH_PRIORITY_MULTIPLIER
    : 1;

  return {
    remainingProgress,
    score:
      (finishableMultiplier * nearlyCompleteMultiplier) /
      Math.max(1, remainingProgress)
  };
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

export function canSpendWorkerEnergyOnConstructionSite(creep: Creep, site: ConstructionSite): boolean {
  return canSpendCreepEnergyOnConstructionSite(
    creep,
    site,
    buildWorkerConstructionSiteImpactPriorityContext(creep, [site])
  );
}

function canSpendCreepEnergyOnConstructionSite(
  creep: Creep,
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext
): boolean {
  const carriedEnergy = getUsedEnergy(creep);
  return (
    (carriedEnergy > 0 && isMissingSpawnRecoveryConstructionSite(creep.room, site)) ||
    (carriedEnergy > 0 && checkEnergyBufferForConstructionSpending(creep.room)) ||
    (carriedEnergy > 0 && checkEnergyBufferForStoredConstructionSpending(creep.room)) ||
    (carriedEnergy > 0 && canSpendCarriedSurplusOnBoundedConstruction(creep, site)) ||
    (carriedEnergy > 0 &&
      isExtensionConstructionSite(site) &&
      checkEnergyBufferForExtensionConstruction(creep.room, carriedEnergy)) ||
    (carriedEnergy > 0 &&
      !isExtensionConstructionSite(site) &&
      isCapacityEnablingConstructionSite(site, priorityContext) &&
      checkEnergyBufferForCapacityEnablingConstruction(creep.room, carriedEnergy)) ||
    (carriedEnergy > 0 && canCompleteConstructionSiteWithCarriedEnergy(creep, site)) ||
    (carriedEnergy > 0 && isLowWorkerThroughputRecoveryConstructionAllowed(creep, site)) ||
    (carriedEnergy > 0 &&
      hasMinimumWorkerSpawnEnergyForConstruction(creep.room) &&
      isEnergyStarvationSourceLogisticsConstructionSite(site, priorityContext))
  );
}

function canSpendCarriedSurplusOnBoundedConstruction(creep: Creep, site: ConstructionSite): boolean {
  const room = creep.room;
  const controller = room.controller;
  const survivalAssessment = getWorkerColonySurvivalAssessment(creep);
  const roomEnergy = getRoomEnergyAvailable(room);
  return (
    site.my !== false &&
    controller?.my === true &&
    roomEnergy !== null &&
    roomEnergy >= MINIMUM_WORKER_SPAWN_ENERGY &&
    !hasVisibleHostilePresence(room) &&
    !suppressesBootstrapNonCriticalWork(survivalAssessment) &&
    !suppressesTerritoryWork(survivalAssessment) &&
    !shouldGuardControllerDowngrade(controller) &&
    getActiveWorkParts(creep) > 0 &&
    hasMinimumProductiveWorkerCoverageForBoundedConstruction(creep) &&
    !hasOtherSameRoomBuildCoverageWorker(creep)
  );
}

function isLowWorkerThroughputRecoveryConstructionAllowed(creep: Creep, site: ConstructionSite): boolean {
  return site.my !== false && hasLowWorkerThroughputRecoveryPressure(creep);
}

function isMissingSpawnRecoveryConstructionSite(room: Room, site: ConstructionSite): boolean {
  return isSpawnConstructionSite(site) && getOwnedSpawnCount(room) === 0;
}

function getOwnedSpawnCount(room: Room): number | null {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  try {
    return room.find(FIND_MY_STRUCTURES).filter(isOwnedSpawnStructure).length;
  } catch {
    return null;
  }
}

function isOwnedSpawnStructure(structure: AnyOwnedStructure): structure is StructureSpawn {
  return matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isCapacityEnablingConstructionSite(
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext
): boolean {
  if (isExtensionConstructionSite(site)) {
    return true;
  }

  const priority = getConstructionSiteImpactPriority(site, priorityContext);
  if (isContainerConstructionSite(site)) {
    return (
      priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.sourceContainer ||
      priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.energyStarvedSourceContainer
    );
  }

  return false;
}

function isEnergyStarvationSourceLogisticsConstructionSite(
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext
): boolean {
  if (priorityContext.prioritizeSourceLogisticsForEnergyStarvation !== true) {
    return false;
  }

  const priority = getConstructionSiteImpactPriority(site, priorityContext);
  if (isContainerConstructionSite(site)) {
    return priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.energyStarvedSourceContainer;
  }

  return isRoadConstructionSite(site) && priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.energyStarvedCriticalRoad;
}

function canSpendOnStoredProtectedSourceContainerConstruction(
  creep: Creep,
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext
): boolean {
  return (
    isSourceContainerConstructionSite(site, priorityContext) &&
    !hasVisibleHostilePresence(creep.room) &&
    checkEnergyBufferForStoredConstructionSpending(creep.room) &&
    !hasSameRoomWorkerAssignedToTask(creep.room, creep, 'build')
  );
}

function isSourceContainerConstructionSite(
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext
): boolean {
  const priority = getConstructionSiteImpactPriority(site, priorityContext);
  return (
    isContainerConstructionSite(site) &&
    (priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.sourceContainer ||
      priority === CONSTRUCTION_SITE_IMPACT_PRIORITY.energyStarvedSourceContainer)
  );
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

function getConstructionSiteProgressTotal(site: ConstructionSite): number {
  const progressTotal = (site as ConstructionSite & { progressTotal?: number }).progressTotal;
  return typeof progressTotal === 'number' && Number.isFinite(progressTotal)
    ? Math.max(0, progressTotal)
    : Number.POSITIVE_INFINITY;
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
  constructionReservationContext: ConstructionReservationContext = createEmptyConstructionReservationContext(),
  priorityContext?: ConstructionSiteImpactPriorityContext
): ConstructionSite | null {
  if (!constructionSites.some(isRoadConstructionSite)) {
    return null;
  }

  const criticalRoadContext = buildWorkerCriticalRoadLogisticsContext(creep);
  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    (site) => isCriticalRoadLogisticsWork(site, criticalRoadContext),
    { priorityContext: priorityContext ?? { criticalRoadContext }, requireReasonableRange: true }
  );
}

function selectNearbyProductiveEnergySinkTask(
  creep: Creep,
  constructionSites: ConstructionSite[],
  controller: StructureController,
  constructionReservationContext: ConstructionReservationContext
): ProductiveEnergySinkTask | null {
  const criticalSpawnRepairTarget = selectCriticalOwnedSpawnRepairTarget(creep);
  if (criticalSpawnRepairTarget) {
    return { type: 'repair', targetId: criticalSpawnRepairTarget.id as Id<Structure> };
  }

  const controllerRange = getRangeBetweenRoomObjects(creep, controller);
  if (controllerRange === null) {
    return null;
  }

  const constructionPriorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  const shouldDeferCoveredRcl3RoutineRepair = shouldDeferCoveredRcl3RoutineRepairToControllerProgress(
    creep,
    controller,
    constructionSites
  );
  const candidates = [
    ...constructionSites
      .filter(
        (site) =>
          canSpendCreepEnergyOnConstructionSite(creep, site, constructionPriorityContext) &&
          hasUnreservedConstructionProgress(creep, site, constructionReservationContext)
      )
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
      .filter(
        (structure): structure is RepairableWorkerStructure =>
          isRoutineRepairTargetForWorker(creep, structure) &&
          (!shouldDeferCoveredRcl3RoutineRepair ||
            isUrgentRepairTargetForControllerProgressBudget(structure))
      )
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

function selectUncoveredProductiveBacklogTaskBeforeControllerProgress(
  creep: Creep,
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): ProductiveEnergySinkTask | null {
  if (!controller || !shouldReserveWorkerForUncoveredProductiveBacklog(creep, controller)) {
    return null;
  }

  const constructionPriorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  if (!hasSameRoomWorkerAssignedToTask(creep.room, creep, 'build')) {
    const constructionSite = selectUnreservedConstructionSite(
      creep,
      constructionSites,
      constructionReservationContext,
      () => true,
      { priorityContext: constructionPriorityContext }
    );
    if (constructionSite) {
      return { type: 'build', targetId: constructionSite.id };
    }
  }

  if (!hasSameRoomWorkerAssignedToTask(creep.room, creep, 'repair')) {
    const repairTarget = selectRepairTarget(creep);
    if (repairTarget) {
      return { type: 'repair', targetId: repairTarget.id as Id<Structure> };
    }
  }

  return null;
}

function shouldReserveWorkerForUncoveredProductiveBacklog(
  creep: Creep,
  controller: StructureController
): boolean {
  if (!hasControllerProgressDemand(creep, controller)) {
    return false;
  }

  if (hasLoadedWorkerAvailableForUncoveredProductiveBacklog(creep, controller)) {
    return false;
  }

  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  const controllerProgressWorkerLimit = Math.max(
    1,
    getControllerProgressWorkerLimit(
      creep,
      loadedWorkers.length,
      hasActiveTerritoryExpansionPressure(creep)
    )
  );
  const controllerProgressReserveLimit = Math.max(1, controllerProgressWorkerLimit - 1);
  const controllerUpgraders = loadedWorkers.filter((worker) => isUpgradingController(worker, controller)).length;
  return controllerUpgraders >= controllerProgressReserveLimit;
}

function hasControllerProgressDemand(creep: Creep, controller: StructureController): boolean {
  if (shouldApplyControllerPressureLane(creep, controller)) {
    return true;
  }

  const upgradePriority = getControllerUpgradePriority(controller, {
    energyAvailable: getRoomEnergyAvailable(creep.room) ?? undefined,
    energyCapacityAvailable: getRoomEnergyCapacityAvailable(creep.room) ?? undefined,
    hasEnergySurplus: hasRecoverableSurplusEnergy(creep)
  });
  return upgradePriority === 'rclProgress' || upgradePriority === 'energySurplus';
}

function hasLoadedWorkerAvailableForUncoveredProductiveBacklog(
  creep: Creep,
  controller: StructureController
): boolean {
  return getSameRoomLoadedWorkers(creep).some((worker) => {
    if (isSameCreep(worker, creep) || isUpgradingController(worker, controller) || getActiveWorkParts(worker) <= 0) {
      return false;
    }

    const taskType = worker.memory?.task?.type;
    return taskType === undefined || taskType === null;
  });
}

function hasSameRoomWorkerAssignedToTask(
  room: Room,
  currentCreep: Creep,
  taskType: 'build' | 'repair'
): boolean {
  return getGameCreeps().some(
    (worker) =>
      !isSameCreep(worker, currentCreep) &&
      isSameRoomWorker(worker, room) &&
      worker.memory?.task?.type === taskType
  );
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
  constructionReservationContext: ConstructionReservationContext,
  priorityContext?: ConstructionSiteImpactPriorityContext
): ConstructionSite | null {
  const spawnConstructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isSpawnConstructionSite,
    { priorityContext: priorityContext ?? {}, requireReasonableRange: true }
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
    isExtensionConstructionSite,
    { priorityContext: priorityContext ?? {}, requireReasonableRange: true }
  );
}

function selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(
  creep: Creep,
  capacityConstructionSite: ConstructionSite | null,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  priorityContext?: ConstructionSiteImpactPriorityContext
): ConstructionSite | null {
  if (
    !capacityConstructionSite ||
    !isExtensionConstructionSite(capacityConstructionSite) ||
    shouldPrioritizeExtensionCapacity(creep.room)
  ) {
    return null;
  }

  const logisticsPriorityContext = {
    ...buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites),
    ...priorityContext
  };
  if (shouldPrioritizeSourceLogisticsConstruction(creep.room)) {
    return (
      selectUnreservedConstructionSite(
        creep,
        constructionSites,
        constructionReservationContext,
        isContainerConstructionSite,
        { priorityContext: logisticsPriorityContext, requireReasonableRange: true }
      ) ??
      selectCriticalRoadConstructionSite(creep, constructionSites, constructionReservationContext, logisticsPriorityContext)
    );
  }

  return (
    selectCriticalRoadConstructionSite(creep, constructionSites, constructionReservationContext, logisticsPriorityContext) ??
    selectUnreservedConstructionSite(
      creep,
      constructionSites,
      constructionReservationContext,
      isContainerConstructionSite,
      { priorityContext: logisticsPriorityContext, requireReasonableRange: true }
    )
  );
}

function selectConstructionEnergyPreBufferTask(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  preferredConstructionSite: ConstructionSite | null
): Extract<CreepTaskMemory, { type: 'transfer' }> | null {
  if (
    getUsedEnergy(creep) <= 0 ||
    constructionSites.length === 0 ||
    creep.memory?.constructionPreBuffer ||
    creep.memory?.task?.type === 'build' ||
    hasEmergencySpawnExtensionRefillDemand(creep)
  ) {
    return null;
  }

  const site =
    preferredConstructionSite ??
    selectUnreservedConstructionSite(creep, constructionSites, constructionReservationContext, () => true, {
      priorityContext: buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites)
    });
  if (!site || !shouldPreBufferEnergyForConstructionSite(creep, site)) {
    return null;
  }

  const buffer = selectConstructionEnergyPreBufferSink(creep, site);
  if (!buffer) {
    return null;
  }

  creep.memory.constructionPreBuffer = {
    siteId: String(site.id),
    bufferId: String(buffer.id),
    tick: getGameTick() ?? 0
  };

  return { type: 'transfer', targetId: buffer.id as Id<AnyStoreStructure> };
}

function selectConstructionPreBufferRecoveryTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'withdraw' }> | null {
  const memory = creep.memory?.constructionPreBuffer;
  if (!memory) {
    return null;
  }

  const site = getGameObjectById<ConstructionSite>(memory.siteId);
  const buffer = getGameObjectById<ConstructionPreBufferSink>(memory.bufferId);
  if (!site || !buffer || !isConstructionPreBufferSource(creep, site, buffer)) {
    delete creep.memory.constructionPreBuffer;
    return null;
  }

  return { type: 'withdraw', targetId: buffer.id as Id<AnyStoreStructure> };
}

function selectConstructionPreBufferBuildTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'build' }> | null {
  const memory = creep.memory?.constructionPreBuffer;
  if (!memory) {
    return null;
  }

  const currentTask = creep.memory.task;
  if (currentTask?.type === 'transfer' && String(currentTask.targetId) === memory.bufferId) {
    return null;
  }

  const site = getGameObjectById<ConstructionSite>(memory.siteId);
  if (!site || !canSpendWorkerEnergyOnConstructionSite(creep, site)) {
    delete creep.memory.constructionPreBuffer;
    return null;
  }

  delete creep.memory.constructionPreBuffer;
  return { type: 'build', targetId: site.id };
}

function shouldPreBufferEnergyForConstructionSite(creep: Creep, site: ConstructionSite): boolean {
  if (!canSpendWorkerEnergyOnConstructionSite(creep, site)) {
    return false;
  }

  const range = getRangeBetweenRoomObjects(creep, site);
  return range === null || range > CONSTRUCTION_PREBUFFER_SITE_RANGE;
}

function selectConstructionEnergyPreBufferSink(
  creep: Creep,
  site: ConstructionSite
): ConstructionPreBufferSink | null {
  const sinks = findVisibleRoomStructures(creep.room)
    .filter((structure): structure is ConstructionPreBufferSink => isConstructionPreBufferSink(structure))
    .filter((sink) => isConstructionSiteNearSource(site, sink, CONSTRUCTION_PREBUFFER_SITE_RANGE));
  if (sinks.length === 0) {
    return null;
  }

  return sinks.sort((left, right) => compareConstructionPreBufferSinks(creep, site, left, right))[0];
}

function compareConstructionPreBufferSinks(
  creep: Creep,
  site: ConstructionSite,
  left: ConstructionPreBufferSink,
  right: ConstructionPreBufferSink
): number {
  return (
    compareOptionalRanges(getRangeBetweenRoomObjects(site, left), getRangeBetweenRoomObjects(site, right)) ||
    compareOptionalRanges(getRangeBetweenRoomObjects(creep, left), getRangeBetweenRoomObjects(creep, right)) ||
    getFreeStoredEnergyCapacity(right) - getFreeStoredEnergyCapacity(left) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function isConstructionPreBufferSink(structure: AnyStructure): structure is ConstructionPreBufferSink {
  if (!('store' in structure) || getFreeStoredEnergyCapacity(structure) < CONSTRUCTION_PREBUFFER_MIN_FREE_CAPACITY) {
    return false;
  }

  if (isExtensionEnergyBuffer(structure)) {
    return isOwnedRoomStructure(structure);
  }

  return isStorageEnergyBuffer(structure) && isOwnedRoomStructure(structure);
}

function isConstructionPreBufferSource(
  creep: Creep,
  site: ConstructionSite,
  structure: ConstructionPreBufferSink
): boolean {
  return (
    (isExtensionEnergyBuffer(structure) || isStorageEnergyBuffer(structure)) &&
    isOwnedRoomStructure(structure) &&
    isConstructionSiteNearSource(site, structure, CONSTRUCTION_PREBUFFER_SITE_RANGE) &&
    getStoredEnergy(structure) >= CONSTRUCTION_PREBUFFER_MIN_STORED_ENERGY
  );
}

function isExtensionEnergyBuffer(structure: AnyStructure): structure is StructureExtension {
  return matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension');
}

function isStorageEnergyBuffer(structure: AnyStructure): structure is StructureStorage {
  return matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage');
}

function isOwnedRoomStructure(structure: AnyStructure): boolean {
  const ownership = (structure as AnyStructure & { my?: boolean }).my;
  return ownership === true;
}

function shouldPrioritizeExtensionCapacity(room: Room): boolean {
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  return (
    !shouldPrioritizeSourceLogisticsConstruction(room) &&
    (energyCapacityAvailable === null ||
      energyCapacityAvailable < BASELINE_WORKER_THROUGHPUT_ENERGY_CAPACITY)
  );
}

function selectBootstrapExtensionConstructionSiteBeforeRefill(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  survivalAssessment: ColonySurvivalAssessment | null,
  controller: StructureController | undefined
): ConstructionSite | null {
  if (!shouldPrioritizeBootstrapExtensionConstructionBeforeRefill(creep, survivalAssessment, controller)) {
    return null;
  }

  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isExtensionConstructionSite,
    {
      priorityContext: buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites),
      requireReasonableRange: true
    }
  );
}

function shouldPrioritizeBootstrapExtensionConstructionBeforeRefill(
  creep: Creep,
  survivalAssessment: ColonySurvivalAssessment | null,
  controller: StructureController | undefined
): boolean {
  return (
    survivalAssessment?.mode === 'BOOTSTRAP' &&
    isWorkerInColonyRoom(creep) &&
    getUsedEnergy(creep) > 0 &&
    controller?.my === true &&
    typeof controller.level === 'number' &&
    controller.level >= 2 &&
    shouldPrioritizeExtensionCapacity(creep.room)
  );
}

function shouldKeepSpawnExtensionRefillBeforeBootstrapExtension(
  creep: Creep,
  spawnOrExtensionEnergySink: StructureSpawn | StructureExtension | null
): boolean {
  return (
    spawnOrExtensionEnergySink !== null &&
    (hasEmergencySpawnExtensionRefillDemand(creep) || isCriticalSpawnEnergySink(spawnOrExtensionEnergySink))
  );
}

function selectReadyFollowUpProductiveEnergySinkTask(
  creep: Creep,
  capacityConstructionSite: ConstructionSite | null,
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  priorityContext?: ConstructionSiteImpactPriorityContext
): ProductiveEnergySinkTask | null {
  if (!hasReadyTerritoryFollowUpEnergy(creep)) {
    return null;
  }

  const baselineLogisticsConstructionSite = selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(
    creep,
    capacityConstructionSite,
    constructionSites,
    constructionReservationContext,
    priorityContext
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
    constructionReservationContext,
    priorityContext
  );
  return criticalRoadConstructionSite ? { type: 'build', targetId: criticalRoadConstructionSite.id } : null;
}

function selectProductiveEnergySinkBeforeIdleSpawnExtensionRefill(
  creep: Creep,
  spawnOrExtensionEnergySink: StructureSpawn | StructureExtension | null,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  getShouldYieldSpawnReservationToConstructionBacklog: () => boolean
): ProductiveEnergySinkTask | null {
  const deferForHealthyBuffer = shouldDeferIdleSpawnExtensionRefillForHealthyBuffer(
    creep,
    spawnOrExtensionEnergySink
  );
  const deferForBoundedConstruction =
    !deferForHealthyBuffer &&
    shouldDeferIdleSpawnExtensionRefillForBoundedConstruction(
      spawnOrExtensionEnergySink,
      getShouldYieldSpawnReservationToConstructionBacklog
    );

  if (!deferForHealthyBuffer && !deferForBoundedConstruction) {
    return null;
  }

  const constructionPriorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  const constructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    () => true,
    { priorityContext: constructionPriorityContext }
  );
  if (constructionSite) {
    return { type: 'build', targetId: constructionSite.id };
  }

  if (!deferForHealthyBuffer) {
    return null;
  }

  const repairTarget = selectRepairTarget(creep);
  return repairTarget ? { type: 'repair', targetId: repairTarget.id as Id<Structure> } : null;
}

function shouldDeferIdleSpawnExtensionRefillForHealthyBuffer(
  creep: Creep,
  spawnOrExtensionEnergySink: StructureSpawn | StructureExtension | null
): boolean {
  return (
    spawnOrExtensionEnergySink !== null &&
    !hasActiveSpawningSpawn(creep.room) &&
    hasHealthyRoomEnergyBuffer(creep.room)
  );
}

function shouldDeferIdleSpawnExtensionRefillForBoundedConstruction(
  spawnOrExtensionEnergySink: StructureSpawn | StructureExtension | null,
  getShouldYieldSpawnReservationToConstructionBacklog: () => boolean
): boolean {
  return (
    spawnOrExtensionEnergySink !== null &&
    getShouldYieldSpawnReservationToConstructionBacklog()
  );
}

function shouldYieldSpawnReservationToConstructionBacklog(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext
): boolean {
  if (
    getUsedEnergy(creep) <= 0 ||
    getActiveWorkParts(creep) <= 0 ||
    constructionSites.length === 0 ||
    hasEmergencySpawnExtensionRefillDemand(creep)
  ) {
    return false;
  }

  if (!hasMinimumProductiveWorkerCoverageForBoundedConstruction(creep)) {
    return false;
  }

  if (hasOtherSameRoomBuildCoverageWorker(creep)) {
    return false;
  }

  return hasSpendableConstructionBacklogFromSites(creep, constructionSites, constructionReservationContext);
}

function hasOtherSameRoomBuildCoverageWorker(creep: Creep): boolean {
  return getSameRoomLoadedWorkers(creep).some(
    (worker) =>
      !isSameCreep(worker, creep) &&
      worker.memory?.task?.type === 'build' &&
      getActiveWorkParts(worker) > 0
  );
}

function hasMinimumProductiveWorkerCoverageForBoundedConstruction(creep: Creep): boolean {
  return (
    getRoomOwnedCreeps(creep.room).filter((worker) => isProductiveSameRoomWorker(worker, creep.room)).length >=
    SPAWN_RESERVATION_PRODUCTIVE_WORK_MIN_WORKERS
  );
}

function hasHealthyRoomEnergyBuffer(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  return energyAvailable !== null && energyAvailable >= getEffectiveRoomEnergyBufferThreshold(room);
}

function hasActiveSpawningSpawn(room: Room): boolean {
  return findSpawnExtensionEnergyStructures(room).some(
    (structure) => isSpawnEnergySink(structure) && Boolean(structure.spawning)
  );
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

function isRampartConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_RAMPART', 'rampart');
}

function isHighImpactConstructionSite(
  site: ConstructionSite,
  priorityContext: ConstructionSiteImpactPriorityContext | undefined
): boolean {
  return (
    isContainerConstructionSite(site) ||
    getConstructionSiteImpactPriority(site, priorityContext ?? {}) >= CONSTRUCTION_SITE_IMPACT_PRIORITY.criticalRoad
  );
}

type StructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_TOWER'
  | 'STRUCTURE_ROAD'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_LINK'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL'
  | 'STRUCTURE_WALL'
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
  return (
    isStoredWorkerEnergySource(structure, context.room) &&
    hasWithdrawableStoredEnergy(structure, context) &&
    isFriendlyStoredEnergySource(structure, context)
  );
}

function isStoredWorkerEnergySource(structure: AnyStructure, room: Room): structure is StoredWorkerEnergySource {
  if (matchesStructureType(structure.structureType, 'STRUCTURE_LINK', 'link')) {
    return isSourceLink(room, structure as StructureLink);
  }

  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_TERMINAL', 'terminal')
  );
}

function hasWithdrawableStoredEnergy(structure: StoredWorkerEnergySource, context: StoredEnergySourceContext): boolean {
  if (isSpawnEnergySource(structure)) {
    return getSpawnEnergyAvailableForWithdrawal(context.room, structure) > 0;
  }

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
  priority: WorkerEnergyAcquisitionPriority;
  priorityBeforeRange?: boolean;
  range: number | null;
  score: number;
  source: WorkerEnergyAcquisitionSource;
  stagingRole?: EnergyStagingContainerRole;
  task: WorkerEnergyAcquisitionTask;
}

interface LowLoadWorkerEnergyAcquisitionCandidate {
  energy: number;
  priority: WorkerEnergyAcquisitionPriority;
  priorityBeforeRange?: boolean;
  range: number | null;
  score: number;
  source: LowLoadWorkerEnergyAcquisitionSource;
  stagingRole?: EnergyStagingContainerRole;
  task: LowLoadWorkerEnergyAcquisitionTask;
}

interface SpawnRecoveryEnergyAcquisitionCandidate extends WorkerEnergyAcquisitionCandidate {
  deliveryEta: number;
}

interface SpawnRecoveryHarvestCandidate {
  availabilityPriority: number;
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
  constructionEnergyWithdrawn: number;
  reservedEnergyBySourceId: Map<string, number>;
}

interface WorkerEnergyAcquisitionSearchOptions {
  maximumRange?: number;
  minimumDroppedEnergy?: number;
  minimumLinkEnergy?: number;
}

function selectWorkerEnergyAcquisitionTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}

function selectBuilderEnergyAcquisitionTask(creep: Creep): BuilderEnergyAcquisitionTask | null {
  const buildTask = creep.memory?.task;
  if (buildTask?.type !== 'build' || buildTask.targetId == null) {
    return null;
  }

  const constructionSite = getGameObjectById<ConstructionSite>(buildTask.targetId);
  if (!constructionSite) {
    return null;
  }

  const candidates = findBuilderEnergyAcquisitionCandidates(creep, constructionSite);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareBuilderEnergyAcquisitionCandidates)[0].task;
}

function selectConstructionBacklogEnergyAcquisitionTask(creep: Creep): BuilderEnergyAcquisitionTask | null {
  if (getFreeEnergyCapacity(creep) <= 0 || getActiveWorkParts(creep) <= 0) {
    return null;
  }

  const constructionSites =
    typeof FIND_CONSTRUCTION_SITES === 'number' && typeof creep.room?.find === 'function'
      ? creep.room.find(FIND_CONSTRUCTION_SITES)
      : [];
  if (constructionSites.length === 0) {
    return null;
  }

  const constructionReservationContext = createConstructionReservationContext(creep.room);
  const constructionPriorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  const constructionSite = selectUnreservedConstructionBacklogEnergyTarget(
    creep,
    constructionSites,
    constructionReservationContext,
    constructionPriorityContext
  );
  if (!constructionSite) {
    return null;
  }

  const candidates = findBuilderEnergyAcquisitionCandidates(creep, constructionSite);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareBuilderEnergyAcquisitionCandidates)[0].task;
}

export function findBuilderEnergyAcquisitionCandidates(
  creep: Creep,
  constructionSite: ConstructionSite
): BuilderEnergyAcquisitionCandidate[] {
  const context: StoredEnergySourceContext = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);

  const storedEnergyCandidates = findVisibleRoomStructures(creep.room)
    .filter(
      (structure): structure is BuilderStoredEnergySource =>
        isSafeStoredEnergySource(structure, context) ||
        isBuilderConstructionBufferSpawnSource(creep, structure, context, reservationContext) ||
        isBuilderConstructionPreBufferExtension(creep, constructionSite, structure)
    )
    .filter((source) => isConstructionSiteNearSource(constructionSite, source, BUILDER_STORAGE_ACQUISITION_SITE_RANGE))
    .flatMap((source) => {
      const candidate = createUnreservedBuilderStoredEnergyAcquisitionCandidate(
        creep,
        source,
        getStoredEnergy(source),
        {
          type: 'withdraw',
          targetId: source.id as Id<AnyStoreStructure>
        },
        reservationContext,
        BUILDER_STORAGE_WITHDRAW_MIN,
        constructionSite
      );

      return candidate ? [candidate] : [];
    });

  const droppedEnergyCandidates = findDroppedResources(creep.room)
    .filter((resource): resource is Resource<ResourceConstant> =>
      isDroppedEnergy(resource, MIN_DROPPED_ENERGY_PICKUP_AMOUNT)
    )
    .filter((source) => isConstructionSiteNearSource(constructionSite, source, BUILDER_DROPPED_PICKUP_RANGE))
    .flatMap((resource) => {
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        resource,
        resource.amount,
        {
          type: 'pickup',
          targetId: resource.id
        },
        reservationContext,
        MIN_DROPPED_ENERGY_PICKUP_AMOUNT
      );

      return candidate ? [toBuilderEnergyAcquisitionCandidate(candidate)] : [];
    })
    .sort(compareBuilderEnergyAcquisitionCandidates)
    .slice(0, MAX_DROPPED_ENERGY_REACHABILITY_CHECKS)
    .filter((candidate) => isReachable(creep, candidate.source));

  return [...storedEnergyCandidates, ...droppedEnergyCandidates].sort(compareBuilderEnergyAcquisitionCandidates);
}

function selectUnreservedConstructionBacklogEnergyTarget(
  creep: Creep,
  constructionSites: ConstructionSite[],
  constructionReservationContext: ConstructionReservationContext,
  priorityContext: ConstructionSiteImpactPriorityContext
): ConstructionSite | null {
  const candidates = constructionSites.filter((site) =>
    hasUnreservedConstructionProgress(creep, site, constructionReservationContext)
  );
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) =>
    compareConstructionSiteCandidates(creep, left, right, constructionReservationContext, priorityContext)
  )[0];
}

function toBuilderEnergyAcquisitionCandidate(
  candidate: WorkerEnergyAcquisitionCandidate | LowLoadWorkerEnergyAcquisitionCandidate
): BuilderEnergyAcquisitionCandidate {
  return {
    ...candidate,
    source: candidate.source as BuilderEnergyAcquisitionCandidate['source'],
    task: candidate.task as BuilderEnergyAcquisitionCandidate['task']
  };
}

function createUnreservedBuilderStoredEnergyAcquisitionCandidate(
  creep: Creep,
  source: BuilderStoredEnergySource,
  energy: number,
  task: Extract<WorkerEnergyAcquisitionTask, { type: 'withdraw' }>,
  reservationContext: WorkerEnergyAcquisitionReservationContext,
  minimumEnergy: number,
  constructionSite: ConstructionSite
): BuilderEnergyAcquisitionCandidate | null {
  if (isExtensionEnergyBuffer(source)) {
    if (!isConstructionPreBufferExtensionSource(creep, source) || energy < CONSTRUCTION_PREBUFFER_MIN_STORED_ENERGY) {
      return null;
    }

    return createBuilderEnergyAcquisitionCandidate(creep, source, energy, task);
  }

  if (isSpawnEnergySource(source)) {
    const constructionEnergy = getSpawnConstructionEnergyAvailableForWithdrawal(
      creep,
      source,
      energy,
      reservationContext
    );
    if (constructionEnergy <= 0) {
      return null;
    }

    return createBuilderEnergyAcquisitionCandidate(creep, source, constructionEnergy, {
      ...task,
      constructionSiteId: constructionSite.id
    });
  }

  const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
    creep,
    source,
    energy,
    task,
    reservationContext,
    minimumEnergy
  );
  return candidate ? toBuilderEnergyAcquisitionCandidate(candidate) : null;
}

function isBuilderConstructionBufferSpawnSource(
  creep: Creep,
  structure: AnyStructure,
  context: StoredEnergySourceContext,
  reservationContext: WorkerEnergyAcquisitionReservationContext
): structure is StructureSpawn {
  return (
    isSpawnEnergySource(structure) &&
    isFriendlyStoredEnergySource(structure, context) &&
    getSpawnConstructionEnergyAvailableForWithdrawal(
      creep,
      structure,
      getStoredEnergy(structure),
      reservationContext
    ) > 0
  );
}

function getSpawnConstructionEnergyAvailableForWithdrawal(
  creep: Creep,
  source: StructureSpawn,
  energy: number,
  reservationContext: WorkerEnergyAcquisitionReservationContext
): number {
  const roomEnergyAvailable = getRoomEnergyAvailable(creep.room);
  if (roomEnergyAvailable === null) {
    return 0;
  }

  const reservedEnergy = getReservedWorkerEnergyAcquisitionAmount(source, reservationContext);
  const projectedSourceEnergy = Math.max(0, energy - reservedEnergy);
  const spawnReservationBudget = getConstructionEnergyAvailableAfterSpawnReservation(
    creep.room,
    roomEnergyAvailable,
    reservationContext.constructionEnergyWithdrawn
  );
  const constructionBudget = Math.max(
    0,
    roomEnergyAvailable -
      getConstructionSpendingEnergyThreshold(creep.room) -
      reservationContext.constructionEnergyWithdrawn
  );
  return Math.min(projectedSourceEnergy, constructionBudget, spawnReservationBudget);
}

function getConstructionEnergyAvailableAfterSpawnReservation(
  room: Room,
  roomEnergyAvailable: number,
  constructionEnergyWithdrawn: number
): number {
  const reservation = getRoomSpawnEnergyReservationState(room);
  if (!reservation.active) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, roomEnergyAvailable - reservation.reservedEnergy - constructionEnergyWithdrawn);
}

function createBuilderEnergyAcquisitionCandidate(
  creep: Creep,
  source: BuilderStoredEnergySource,
  energy: number,
  task: WorkerEnergyAcquisitionTask
): BuilderEnergyAcquisitionCandidate {
  const range = getRangeBetweenRoomObjects(creep, source);
  const energyScore = scoreWorkerEnergyAcquisitionAmount(energy, getFreeEnergyCapacity(creep));

  return {
    energy,
    priority: isExtensionEnergyBuffer(source) ? 1 : getWorkerEnergyAcquisitionPriority(creep, source, energy, range),
    range,
    score: range === null ? energyScore : energyScore - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task
  };
}

function isBuilderConstructionPreBufferExtension(
  creep: Creep,
  constructionSite: ConstructionSite,
  structure: AnyStructure
): structure is StructureExtension {
  return (
    isExtensionEnergyBuffer(structure) &&
    isConstructionPreBufferExtensionSource(creep, structure) &&
    isConstructionSiteNearSource(constructionSite, structure, CONSTRUCTION_PREBUFFER_SITE_RANGE)
  );
}

function isConstructionPreBufferExtensionSource(creep: Creep, structure: StructureExtension): boolean {
  const memory = creep.memory?.constructionPreBuffer;
  return (
    memory?.bufferId === String(structure.id) &&
    isOwnedRoomStructure(structure) &&
    getStoredEnergy(structure) >= CONSTRUCTION_PREBUFFER_MIN_STORED_ENERGY
  );
}

function isConstructionSiteNearSource(
  constructionSite: ConstructionSite,
  source: RoomObject,
  rangeLimit: number
): boolean {
  const rangeToSite = getRangeBetweenRoomObjects(constructionSite, source);
  return rangeToSite !== null && rangeToSite <= rangeLimit;
}

function compareBuilderEnergyAcquisitionCandidates(
  left: BuilderEnergyAcquisitionCandidate,
  right: BuilderEnergyAcquisitionCandidate
): number {
  return (
    compareOptionalRanges(left.range, right.range) ||
    left.priority - right.priority ||
    right.score - left.score ||
    right.energy - left.energy ||
    String(left.source.id).localeCompare(String(right.source.id)) ||
    left.task.type.localeCompare(right.task.type)
  );
}

function getGameObjectById<T extends RoomObject>(
  objectId: string
): T | null {
  const game = (globalThis as unknown as { Game?: Partial<Game> }).Game;
  if (!game?.getObjectById) {
    return null;
  }

  const object = game.getObjectById(objectId);
  return object ? ((object as unknown) as T) : null;
}

export function selectWorkerEnergyFallbackTask(
  creep: Creep,
  harvestOptions: HarvestSourceSelectionOptions = {}
): CreepTaskMemory | null {
  const sourceContainerWithdrawTask = selectSourceContainerWithdrawTask(creep);
  if (sourceContainerWithdrawTask) {
    return sourceContainerWithdrawTask;
  }

  const energyAcquisitionTask = selectWorkerEnergyAcquisitionTask(creep);
  if (energyAcquisitionTask) {
    return energyAcquisitionTask;
  }

  const linkEnergyAcquisitionTask = selectEfficientWorkerLinkEnergyAcquisitionTask(creep);
  if (linkEnergyAcquisitionTask) {
    return linkEnergyAcquisitionTask;
  }

  const nearbyLinkRefillTask = selectNearbyWorkerLinkRefillTask(creep);
  if (nearbyLinkRefillTask) {
    return nearbyLinkRefillTask;
  }

  const harvestTask = selectWorkerHarvestTask(creep, harvestOptions);
  if (harvestTask) {
    return harvestTask;
  }

  return selectWorkerLinkEnergyFallbackTask(creep);
}

export interface WorkerEnergyCriticalAcquisitionOptions {
  avoidStorageWithdrawal?: boolean;
}

export function selectWorkerEnergyCriticalAcquisitionTask(
  creep: Creep,
  options: WorkerEnergyCriticalAcquisitionOptions = {}
): Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }> | null {
  const fallbackTask = selectWorkerEnergyFallbackTask(creep, { allowPreHarvest: false });
  if (!fallbackTask) {
    return null;
  }

  if (options.avoidStorageWithdrawal && fallbackTask.type === 'withdraw') {
    const target = getGameObjectById<AnyStoreStructure>(String(fallbackTask.targetId));
    if (target && isStorageEnergySource(target as LowLoadWorkerEnergyAcquisitionSource)) {
      const harvestTask = selectWorkerHarvestTask(creep, { allowPreHarvest: false });
      if (harvestTask) {
        return harvestTask;
      }
    }
  }

  return fallbackTask as Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }>;
}

export function selectWorkerPreHarvestTask(creep: Creep): Extract<CreepTaskMemory, { type: 'harvest' }> | null {
  return selectWorkerHarvestTask(creep);
}

function selectWorkerHarvestTask(
  creep: Creep,
  options: WorkerHarvestTaskOptions = {}
): Extract<CreepTaskMemory, { type: 'harvest' }> | null {
  const source = selectHarvestSource(creep, options);
  return source ? createHarvestTaskForSource(creep, source, options) : null;
}

function createHarvestTaskForSource(
  creep: Creep,
  source: Source,
  options: Pick<WorkerHarvestTaskOptions, 'assignSourceContainer'> = {}
): Extract<CreepTaskMemory, { type: 'harvest' }> {
  const sourceContainerAssigned = options.assignSourceContainer === true && findVisibleSourceContainer(creep, source);
  return {
    type: 'harvest',
    targetId: source.id,
    // Ordinary harvest fallbacks stay preemptible for build/upgrade returns; only explicit source-container roles pin workers.
    ...(sourceContainerAssigned ? { sourceContainerAssigned: true as const } : {})
  };
}

function selectNearbyWorkerEnergyAcquisitionTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep, {
    maximumRange: LOW_LOAD_NEARBY_ENERGY_RANGE
  }).filter((candidate) => isPreferredNearbyWorkerEnergySource(candidate.source));
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareNearbyWorkerEnergyAcquisitionCandidates)[0].task;
}

function selectNearbyWorkerLinkRefillTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  return findNearestNearbyWorkerLinkRefillCandidate(creep)?.task ?? null;
}

function selectCompetitiveWorkerEnergyAcquisitionTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  const harvestCandidate = createPriorityHarvestEnergyAcquisitionCandidate(creep);
  if (!harvestCandidate || harvestCandidate.range === null) {
    return null;
  }

  const candidates = findWorkerEnergyAcquisitionCandidates(creep)
    .filter((candidate) => isPreferredWorkerEnergyAcquisitionSourceBeforeHarvest(candidate.source))
    .filter((candidate) => isWorkerEnergyAcquisitionCandidateCompetitiveWithHarvest(creep, candidate, harvestCandidate));
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareRecoverableWorkerEnergyAcquisitionCandidatesBeforeHarvest)[0].task;
}

function createPriorityHarvestEnergyAcquisitionCandidate(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  const source = selectSource2ControllerLaneHarvestSource(creep) ?? selectSourceContainerHarvestSource(creep);
  return source ? createCompetitiveHarvestEnergyAcquisitionCandidate(creep, source) : null;
}

function createCompetitiveHarvestEnergyAcquisitionCandidate(
  creep: Creep,
  source: Source
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  const range = getHarvestSourceTravelCost(creep, source);
  if (range === null) {
    return null;
  }

  const energy = Math.min(getHarvestSourceAvailableEnergy(source), getHarvestEnergyTarget(creep));
  if (energy <= 0) {
    return null;
  }

  const score = scoreWorkerEnergyAcquisitionAmount(energy, getFreeEnergyCapacity(creep));
  return {
    energy,
    priority: getWorkerEnergyAcquisitionPriority(creep, source, energy, range),
    range,
    score: score - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task: createHarvestTaskForSource(creep, source)
  };
}

function isWorkerEnergyAcquisitionCandidateCompetitiveWithHarvest(
  creep: Creep,
  candidate: WorkerEnergyAcquisitionCandidate,
  harvestCandidate: LowLoadWorkerEnergyAcquisitionCandidate
): boolean {
  if (candidate.range === null || harvestCandidate.range === null) {
    return false;
  }

  const harvestSource = harvestCandidate.source;
  if (isDroppedEnergySourceObject(candidate.source) && isHarvestSourceObject(harvestSource)) {
    const availabilityDelay = estimateHarvestSourceAvailabilityDelay(harvestSource);
    const candidateEta = candidate.range + ENERGY_ACQUISITION_ACTION_TICKS;
    const harvestEta =
      harvestCandidate.range +
      (availabilityDelay ?? 0) +
      estimateHarvestEnergyAcquisitionTicks(creep, harvestSource);
    if (candidateEta <= harvestEta) {
      return true;
    }
  }

  if (isSubstantialContainerMoreEfficientThanHarvest(creep, candidate, harvestCandidate)) {
    return true;
  }

  return (
    candidate.range < harvestCandidate.range ||
    isBufferedSourceContainerForHarvestCandidate(creep, candidate, harvestCandidate)
  );
}

function isSubstantialContainerMoreEfficientThanHarvest(
  creep: Creep,
  candidate: WorkerEnergyAcquisitionCandidate,
  harvestCandidate: LowLoadWorkerEnergyAcquisitionCandidate
): boolean {
  if (
    !isContainerEnergySource(candidate.source) ||
    !hasSubstantialContainerEnergy(candidate.source, getStoredEnergy(candidate.source)) ||
    !isHarvestSourceObject(harvestCandidate.source)
  ) {
    return false;
  }

  const containerTravelCost = estimateRoadAwareTravelCostBetweenRoomObjects(creep, candidate.source, 1);
  const harvestEta = estimateHarvestEnergyAcquisitionEta(creep, harvestCandidate.source);
  return (
    containerTravelCost !== null &&
    harvestEta !== null &&
    containerTravelCost + ENERGY_ACQUISITION_ACTION_TICKS < harvestEta
  );
}

function isBufferedSourceContainerForHarvestCandidate(
  creep: Creep,
  candidate: WorkerEnergyAcquisitionCandidate,
  harvestCandidate: LowLoadWorkerEnergyAcquisitionCandidate
): boolean {
  if (
    candidate.energy < COMPETITIVE_SOURCE_CONTAINER_WITHDRAW_MIN_ENERGY ||
    candidate.range !== harvestCandidate.range
  ) {
    return false;
  }

  const harvestSource = harvestCandidate.source;
  if (!isHarvestSourceObject(harvestSource)) {
    return false;
  }

  const sourceContainer = findVisibleSourceContainer(creep, harvestSource);
  return sourceContainer !== null && String(candidate.source.id) === String(sourceContainer.id);
}

function isHarvestSourceObject(source: LowLoadWorkerEnergyAcquisitionSource): source is Source {
  return 'energy' in source && !('resourceType' in source);
}

function isPreferredWorkerEnergyAcquisitionSourceBeforeHarvest(
  source: WorkerEnergyAcquisitionSource
): boolean {
  return isContainerEnergySource(source) || isStorageEnergySource(source) || isWorkerDroppedEnergySource(source);
}

function compareRecoverableWorkerEnergyAcquisitionCandidatesBeforeHarvest(
  left: WorkerEnergyAcquisitionCandidate,
  right: WorkerEnergyAcquisitionCandidate
): number {
  return (
    compareOptionalRanges(left.range, right.range) ||
    compareWorkerEnergyAcquisitionSourceTypePriority(left.source, right.source) ||
    right.score - left.score ||
    right.energy - left.energy ||
    String(left.source.id).localeCompare(String(right.source.id)) ||
    left.task.type.localeCompare(right.task.type)
  );
}

function compareWorkerEnergyAcquisitionSourceTypePriority(
  left: WorkerEnergyAcquisitionSource,
  right: WorkerEnergyAcquisitionSource
): number {
  return getWorkerEnergyAcquisitionSourceTypePriority(left) - getWorkerEnergyAcquisitionSourceTypePriority(right);
}

function getWorkerEnergyAcquisitionSourceTypePriority(source: WorkerEnergyAcquisitionSource): number {
  if (isWorkerDroppedEnergySource(source)) {
    return 0;
  }

  if (isContainerEnergySource(source)) {
    return 1;
  }

  if (isStorageEnergySource(source)) {
    return 2;
  }

  return 0;
}

function selectLowLoadWorkerEnergyAcquisitionCandidate(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  return selectLowLoadWorkerEnergyContinuationCandidate(creep);
}

export function shouldSwitchLowLoadWorkerEnergyAcquisitionTaskForYield(
  creep: Creep,
  currentTask: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (
    !isLowLoadWorkerEnergyAcquisitionTask(currentTask) ||
    !isLowLoadWorkerEnergyAcquisitionTask(selectedTask) ||
    isSameLowLoadWorkerEnergyAcquisitionTask(currentTask, selectedTask) ||
    getLowLoadWorkerEnergyContext(creep) === null ||
    !hasAbundantEnergyForLowLoadYieldSwitch(creep.room)
  ) {
    return false;
  }

  const currentCandidate = createLowLoadWorkerEnergyAcquisitionCandidateForTask(creep, currentTask);
  const selectedCandidate = createLowLoadWorkerEnergyAcquisitionCandidateForTask(creep, selectedTask);
  return (
    currentCandidate !== null &&
    selectedCandidate !== null &&
    isLowLoadWorkerEnergyYieldSwitchBetter(creep, currentCandidate, selectedCandidate)
  );
}

function selectLowLoadWorkerEnergyContinuationTask(
  creep: Creep,
  maximumRange = LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
): LowLoadWorkerEnergyAcquisitionTask | null {
  const candidate = selectLowLoadWorkerEnergyContinuationCandidate(creep, maximumRange);
  if (!candidate) {
    return null;
  }

  recordNearbyEnergyChoiceTelemetry(creep, candidate);
  return candidate.task;
}

function selectLowLoadSpawnExtensionDeliveryContinuationTask(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionTask | null {
  const candidate = selectLowLoadSpawnExtensionDeliveryContinuationCandidate(creep);
  if (!candidate) {
    return null;
  }

  recordNearbyEnergyChoiceTelemetry(creep, candidate);
  return candidate.task;
}

function selectLowLoadSpawnExtensionDeliveryContinuationCandidate(
  creep: Creep
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  const nearbyCandidate = selectLowLoadWorkerEnergyContinuationCandidate(creep);
  const extendedHarvestCandidates = findLowLoadHarvestEnergyAcquisitionCandidates(creep).filter((candidate) =>
    isLowLoadWorkerEnergyContinuationCandidateInRange(
      candidate,
      LOW_LOAD_SPAWN_EXTENSION_REFILL_CONTINUATION_MAX_RANGE
    )
  );
  const candidates = [
    ...(nearbyCandidate ? [nearbyCandidate] : []),
    ...extendedHarvestCandidates
  ];
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareLowLoadWorkerEnergyAcquisitionCandidates)[0];
}

function selectLowLoadWorkerEnergyContinuationCandidate(
  creep: Creep,
  maximumRange = LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  if (!shouldKeepLowLoadWorkerAcquiringEnergy(creep)) {
    return null;
  }

  const candidates = findLowLoadWorkerEnergyContinuationCandidates(creep, maximumRange)
    .filter((candidate) => isLowLoadWorkerEnergyContinuationCandidateInRange(candidate, maximumRange))
    .filter((candidate) => isLowLoadWorkerEnergyContinuationCandidateReachable(creep, candidate));
  if (candidates.length === 0) {
    return selectCurrentLowLoadWorkerEnergyAcquisitionCandidate(creep, maximumRange);
  }

  return selectLowLoadWorkerEnergyYieldAwareCandidate(
    creep,
    candidates,
    candidates.sort(compareLowLoadWorkerEnergyAcquisitionCandidates)[0],
    maximumRange
  );
}

function shouldKeepLowLoadWorkerAcquiringEnergy(creep: Creep): boolean {
  return getLowLoadWorkerEnergyContext(creep) !== null && !hasVisibleHostilePresence(creep.room);
}

function selectLowLoadWorkerEnergyYieldAwareCandidate(
  creep: Creep,
  candidates: LowLoadWorkerEnergyAcquisitionCandidate[],
  defaultCandidate: LowLoadWorkerEnergyAcquisitionCandidate,
  maximumRange: number
): LowLoadWorkerEnergyAcquisitionCandidate {
  const currentCandidate = selectCurrentLowLoadWorkerEnergyAcquisitionCandidate(creep, maximumRange);
  if (!currentCandidate) {
    return defaultCandidate;
  }

  if (!hasAbundantEnergyForLowLoadYieldSwitch(creep.room)) {
    return currentCandidate;
  }

  const bestYieldCandidate = selectBestLowLoadWorkerEnergyYieldCandidate(creep, [
    currentCandidate,
    ...candidates
  ]);
  if (
    bestYieldCandidate &&
    !isSameLowLoadWorkerEnergyAcquisitionTask(currentCandidate.task, bestYieldCandidate.task) &&
    isLowLoadWorkerEnergyYieldSwitchBetter(creep, currentCandidate, bestYieldCandidate)
  ) {
    return bestYieldCandidate;
  }

  return currentCandidate;
}

function selectCurrentLowLoadWorkerEnergyAcquisitionCandidate(
  creep: Creep,
  maximumRange: number
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  const task = creep.memory?.task;
  if (!isLowLoadWorkerEnergyAcquisitionTask(task)) {
    return null;
  }

  const candidate = createLowLoadWorkerEnergyAcquisitionCandidateForTask(creep, task);
  if (
    !candidate ||
    !isLowLoadWorkerEnergyContinuationCandidateInRange(candidate, maximumRange) ||
    !isLowLoadWorkerEnergyContinuationCandidateReachable(creep, candidate)
  ) {
    return null;
  }

  return candidate;
}

function selectBestLowLoadWorkerEnergyYieldCandidate(
  creep: Creep,
  candidates: LowLoadWorkerEnergyAcquisitionCandidate[]
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  const scoredCandidates = candidates
    .map((candidate) => ({
      candidate,
      energyPerTick: estimateLowLoadWorkerEnergyAcquisitionYield(creep, candidate)
    }))
    .filter(
      (entry): entry is { candidate: LowLoadWorkerEnergyAcquisitionCandidate; energyPerTick: number } =>
        entry.energyPerTick !== null
    );
  if (scoredCandidates.length === 0) {
    return null;
  }

  return scoredCandidates.sort((left, right) =>
    right.energyPerTick - left.energyPerTick ||
    compareLowLoadWorkerEnergyAcquisitionCandidates(left.candidate, right.candidate)
  )[0].candidate;
}

function isLowLoadWorkerEnergyYieldSwitchBetter(
  creep: Creep,
  currentCandidate: LowLoadWorkerEnergyAcquisitionCandidate,
  selectedCandidate: LowLoadWorkerEnergyAcquisitionCandidate
): boolean {
  const currentYield = estimateLowLoadWorkerEnergyAcquisitionYield(creep, currentCandidate);
  const selectedYield = estimateLowLoadWorkerEnergyAcquisitionYield(creep, selectedCandidate);
  return (
    currentYield !== null &&
    selectedYield !== null &&
    selectedYield - currentYield >= LOW_LOAD_YIELD_SWITCH_MIN_ABSOLUTE_GAIN &&
    selectedYield >= currentYield * LOW_LOAD_YIELD_SWITCH_MIN_IMPROVEMENT_RATIO
  );
}

function estimateLowLoadWorkerEnergyAcquisitionYield(
  creep: Creep,
  candidate: LowLoadWorkerEnergyAcquisitionCandidate
): number | null {
  const range = candidate.range;
  if (range === null) {
    return null;
  }

  const tripEnergy = Math.min(candidate.energy, getFreeEnergyCapacity(creep));
  if (tripEnergy <= 0) {
    return null;
  }

  const actionTicks =
    candidate.task.type === 'harvest' && isHarvestSourceObject(candidate.source)
      ? estimateHarvestEnergyAcquisitionTicks(creep, candidate.source)
      : ENERGY_ACQUISITION_ACTION_TICKS;
  if (!Number.isFinite(actionTicks) || actionTicks <= 0) {
    return null;
  }

  return tripEnergy / Math.max(1, range + actionTicks);
}

function hasAbundantEnergyForLowLoadYieldSwitch(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  if (energyAvailable === null) {
    return false;
  }

  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyCapacityAvailable !== null && energyCapacityAvailable <= 0) {
    return false;
  }

  const abundanceThreshold =
    energyCapacityAvailable === null
      ? URGENT_SPAWN_REFILL_ENERGY_THRESHOLD
      : Math.min(URGENT_SPAWN_REFILL_ENERGY_THRESHOLD, energyCapacityAvailable);
  return energyAvailable >= abundanceThreshold;
}

function createLowLoadWorkerEnergyAcquisitionCandidateForTask(
  creep: Creep,
  task: LowLoadWorkerEnergyAcquisitionTask
): LowLoadWorkerEnergyAcquisitionCandidate | null {
  const source = findLowLoadWorkerEnergyAcquisitionSourceForTask(creep, task);
  if (!source) {
    return null;
  }

  if (isHarvestSourceObject(source)) {
    if (getActiveWorkParts(creep) <= 0 || isSourceDepleted(source)) {
      return null;
    }

    return createLowLoadWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getHarvestCandidateEnergy(creep, source),
      task
    );
  }

  if (isDroppedEnergySourceObject(source)) {
    if (source.amount <= 0) {
      return null;
    }

    return createLowLoadWorkerEnergyAcquisitionCandidate(creep, source, source.amount, task);
  }

  const energy = getUnreservedWorkerEnergyAcquisitionAmount(
    source,
    getStoredEnergy(source),
    createWorkerEnergyAcquisitionReservationContext(creep),
    creep
  );
  return energy > 0 ? createLowLoadWorkerEnergyAcquisitionCandidate(creep, source, energy, task) : null;
}

function findLowLoadWorkerEnergyAcquisitionSourceForTask(
  creep: Creep,
  task: LowLoadWorkerEnergyAcquisitionTask
): LowLoadWorkerEnergyAcquisitionSource | null {
  const targetId = String(task.targetId);
  const gameObject = getGameObjectById<RoomObject>(targetId);
  return gameObject && isLowLoadWorkerEnergyAcquisitionSourceForTask(creep, gameObject, task) ? gameObject : null;
}

function isLowLoadWorkerEnergyAcquisitionSourceForTask(
  creep: Creep,
  source: RoomObject,
  task: LowLoadWorkerEnergyAcquisitionTask
): source is LowLoadWorkerEnergyAcquisitionSource {
  switch (task.type) {
    case 'harvest':
      return isHarvestSourceObject(source as LowLoadWorkerEnergyAcquisitionSource);
    case 'pickup':
      return isDroppedEnergySourceObject(source as LowLoadWorkerEnergyAcquisitionSource);
    case 'withdraw':
      return hasEnergyStore(source) && isSafePersistedLowLoadWorkerWithdrawSource(creep, source);
  }
}

function isSafePersistedLowLoadWorkerWithdrawSource(creep: Creep, source: WorkerEnergyAcquisitionSource): boolean {
  if (!isStructureEnergySourceObject(source)) {
    return true;
  }

  const room = ((source as RoomObject & { room?: Room }).room ?? creep.room) as Room;
  return isSafeStoredEnergySource(source as AnyStructure, {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(room),
    room
  });
}

function isStructureEnergySourceObject(source: WorkerEnergyAcquisitionSource): source is StoredWorkerEnergySource {
  return typeof (source as Partial<Structure> | null)?.structureType === 'string';
}

function hasEnergyStore(source: unknown): source is WorkerEnergyAcquisitionSource {
  return typeof (source as { store?: { getUsedCapacity?: unknown } } | null)?.store?.getUsedCapacity === 'function';
}

function isLowLoadWorkerEnergyAcquisitionTask(
  task: CreepTaskMemory | null | undefined
): task is LowLoadWorkerEnergyAcquisitionTask {
  return task?.type === 'harvest' || task?.type === 'pickup' || task?.type === 'withdraw';
}

function isSameLowLoadWorkerEnergyAcquisitionTask(
  left: LowLoadWorkerEnergyAcquisitionTask,
  right: LowLoadWorkerEnergyAcquisitionTask
): boolean {
  return left.type === right.type && String(left.targetId) === String(right.targetId);
}

function findLowLoadWorkerEnergyContinuationCandidates(
  creep: Creep,
  maximumRange = LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
): LowLoadWorkerEnergyAcquisitionCandidate[] {
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const nearbyLinkRefillCandidate = findNearestNearbyWorkerLinkRefillCandidate(creep, reservationContext);
  // Use the normal candidate set so continuation can take close energy beyond the nearby-only fast path.
  return [
    ...findWorkerEnergyAcquisitionCandidates(creep, {
      maximumRange
    }).map(toLowLoadWorkerEnergyAcquisitionCandidate),
    ...(nearbyLinkRefillCandidate ? [toNearbyWorkerLinkRefillCandidate(nearbyLinkRefillCandidate)] : []),
    ...findLowLoadHarvestEnergyAcquisitionCandidates(creep),
    ...findWorkerLinkEnergyAcquisitionCandidates(creep, reservationContext, {
      maximumRange
    }).map(toLowLoadWorkerEnergyAcquisitionCandidate)
  ];
}

function isLowLoadWorkerEnergyContinuationCandidateInRange(
  candidate: LowLoadWorkerEnergyAcquisitionCandidate,
  maximumRange = LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
): boolean {
  return candidate.range !== null && candidate.range <= maximumRange;
}

function isLowLoadWorkerEnergyContinuationCandidateReachable(
  creep: Creep,
  candidate: LowLoadWorkerEnergyAcquisitionCandidate
): boolean {
  return candidate.task.type !== 'withdraw' || isReachable(creep, candidate.source);
}

function toLowLoadWorkerEnergyAcquisitionCandidate(
  candidate: WorkerEnergyAcquisitionCandidate
): LowLoadWorkerEnergyAcquisitionCandidate {
  return candidate;
}

function toNearbyWorkerLinkRefillCandidate(
  candidate: WorkerEnergyAcquisitionCandidate
): LowLoadWorkerEnergyAcquisitionCandidate {
  return {
    ...candidate,
    priority: 1
  };
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
      createHarvestTaskForSource(creep, source)
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
  const stagingRole = getWorkerEnergyAcquisitionStagingRole(creep, source);

  return {
    energy,
    priority: getWorkerEnergyAcquisitionPriority(creep, source, energy, range),
    ...(shouldPrioritizeWorkerEnergyAcquisitionPriorityBeforeRange(creep, stagingRole)
      ? { priorityBeforeRange: true }
      : {}),
    range,
    score: range === null ? energy : energy - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    ...(stagingRole ? { stagingRole } : {}),
    task
  };
}

function compareLowLoadWorkerEnergyAcquisitionCandidates(
  left: LowLoadWorkerEnergyAcquisitionCandidate,
  right: LowLoadWorkerEnergyAcquisitionCandidate
): number {
  return (
    left.priority - right.priority ||
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
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const recoverableEnergyCandidates = [
    ...findWorkerEnergyAcquisitionCandidates(creep, {
      minimumDroppedEnergy: MIN_SPAWN_RECOVERY_DROPPED_ENERGY_PICKUP_AMOUNT
    }),
    ...findWorkerLinkEnergyAcquisitionCandidates(creep, reservationContext)
  ];
  const candidates = recoverableEnergyCandidates
    .map((candidate) => createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink))
    .filter((candidate): candidate is SpawnRecoveryEnergyAcquisitionCandidate => candidate !== null)
    .filter((candidate) => candidate.stagingRole === 'spawn' || harvestEta === null || candidate.deliveryEta <= harvestEta);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareSpawnRecoveryEnergyAcquisitionCandidates)[0].task;
}

function selectSpawnRecoveryHarvestCandidate(
  creep: Creep,
  energySink: FillableEnergySink
): SpawnRecoveryHarvestCandidate | null {
  const sources = findVisibleHarvestSourcesInRooms([creep.room]);
  if (sources.length === 0) {
    return null;
  }

  const viableSources = selectViableHarvestSources(
    sources,
    getSpawnRecoveryHarvestEnergyTarget(creep, energySink),
    creep
  );
  const assignmentLoads = getWorkerHarvestLoads(viableSources);
  const assignableSources = selectAssignableHarvestSources(creep, viableSources, assignmentLoads);
  const candidates = assignableSources
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
    availabilityPriority: getHarvestSourceAvailabilityPriority(
      creep,
      source,
      getSpawnRecoveryHarvestEnergyTarget(creep, energySink),
      {}
    ),
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
    .filter(
      (structure): structure is StoredWorkerEnergySource =>
        isSafeStoredEnergySource(structure, context) && !isLinkEnergySource(structure)
    )
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
  const sourceLinkEnergyCandidates = findWorkerSourceLinkEnergyAcquisitionCandidates(
    creep,
    reservationContext,
    options
  );

  return [
    ...sourceLinkEnergyCandidates,
    ...storedEnergyCandidates,
    ...salvageEnergyCandidates,
    ...droppedEnergyCandidates
  ].sort(compareWorkerEnergyAcquisitionCandidates);
}

function selectWorkerLinkEnergyFallbackTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  return findWorkerLinkEnergyAcquisitionCandidates(creep)[0]?.task ?? null;
}

function selectEfficientWorkerLinkEnergyAcquisitionTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  const linkCandidate = findWorkerLinkEnergyAcquisitionCandidates(creep)[0];
  if (!linkCandidate) {
    return null;
  }

  const harvestSource = selectHarvestSource(creep);
  if (!harvestSource) {
    return linkCandidate.task;
  }

  return isWorkerLinkEnergyMoreEfficientThanHarvest(creep, linkCandidate, harvestSource)
    ? linkCandidate.task
    : null;
}

function findWorkerLinkEnergyAcquisitionCandidates(
  creep: Creep,
  reservationContext = createWorkerEnergyAcquisitionReservationContext(creep),
  options: WorkerEnergyAcquisitionSearchOptions = {}
): WorkerEnergyAcquisitionCandidate[] {
  const minimumLinkEnergy = options.minimumLinkEnergy ?? getMinimumWorkerLinkWithdrawalEnergy(creep);
  const workerLinks = findOwnedWorkerEnergyLinks(creep.room);
  if (workerLinks.length === 0) {
    return [];
  }

  const network = classifyLinks(creep.room);
  return workerLinks
    .flatMap((source) => {
      const availableEnergy = getWorkerLinkEnergyAvailable(creep.room, source, network);
      const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
        creep,
        source,
        availableEnergy,
        {
          type: 'withdraw',
          targetId: source.id as Id<AnyStoreStructure>
        },
        reservationContext,
        minimumLinkEnergy
      );

      return candidate ? [candidate] : [];
    })
    .filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options))
    .sort(compareWorkerLinkEnergyAcquisitionCandidates);
}

function findNearestNearbyWorkerLinkRefillCandidate(
  creep: Creep,
  reservationContext = createWorkerEnergyAcquisitionReservationContext(creep)
): WorkerEnergyAcquisitionCandidate | null {
  if (!hasLowEnergyForNearbyLinkRefill(creep)) {
    return null;
  }

  return (
    findWorkerLinkEnergyAcquisitionCandidates(creep, reservationContext, {
      maximumRange: LOW_LOAD_NEARBY_ENERGY_RANGE,
      minimumLinkEnergy: MIN_NEARBY_LINK_REFILL_ENERGY
    })[0] ?? null
  );
}

function hasLowEnergyForNearbyLinkRefill(creep: Creep): boolean {
  const carriedEnergy = getUsedEnergy(creep);
  const freeCapacity = getFreeEnergyCapacity(creep);
  const capacity = getEnergyCapacity(creep, carriedEnergy, freeCapacity);
  return freeCapacity > 0 && capacity > 0 && carriedEnergy < capacity * MINIMUM_USEFUL_LOAD_RATIO;
}

function findOwnedWorkerEnergyLinks(room: Room): StructureLink[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const structures = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => isLinkEnergySource(structure) && getStoredEnergy(structure) > 0
  });
  return Array.isArray(structures) ? (structures as StructureLink[]) : [];
}

function findOwnedSourceWorkerEnergyLinks(room: Room, network?: LinkNetwork): StructureLink[] {
  const workerLinkIds = new Set(findOwnedWorkerEnergyLinks(room).map((link) => String(link.id)));
  if (workerLinkIds.size === 0) {
    return [];
  }

  return selectOwnedSourceWorkerEnergyLinks(network ?? classifyLinks(room), workerLinkIds);
}

function selectOwnedSourceWorkerEnergyLinks(network: LinkNetwork, workerLinkIds: Set<string>): StructureLink[] {
  const linksById = new Map<string, StructureLink>();
  for (const link of network.sourceLinks) {
    if (workerLinkIds.has(String(link.id))) {
      linksById.set(String(link.id), link);
    }
  }

  if (network.spawnLink && workerLinkIds.has(String(network.spawnLink.id))) {
    linksById.set(String(network.spawnLink.id), network.spawnLink);
  }

  return [...linksById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function getMinimumWorkerLinkWithdrawalEnergy(creep: Creep): number {
  return Math.max(1, getFreeEnergyCapacity(creep));
}

function getWorkerLinkEnergyAvailable(room: Room, link: StructureLink, network?: LinkNetwork): number {
  return getSourceLinkWorkerEnergyAvailable(room, link, network);
}

function isWorkerLinkEnergyMoreEfficientThanHarvest(
  creep: Creep,
  linkCandidate: WorkerEnergyAcquisitionCandidate,
  harvestSource: Source
): boolean {
  const linkEta = estimateWorkerLinkEnergyAcquisitionEta(linkCandidate);
  const harvestEta = estimateHarvestEnergyAcquisitionEta(creep, harvestSource);
  return linkEta !== null && harvestEta !== null && linkEta < harvestEta;
}

function estimateWorkerLinkEnergyAcquisitionEta(candidate: WorkerEnergyAcquisitionCandidate): number | null {
  return candidate.range === null ? null : candidate.range + ENERGY_ACQUISITION_ACTION_TICKS;
}

function estimateHarvestEnergyAcquisitionEta(creep: Creep, source: Source): number | null {
  const sourceAvailabilityDelay = estimateHarvestSourceAvailabilityDelay(source);
  const range = getHarvestSourceTravelCost(creep, source);
  if (sourceAvailabilityDelay === null || range === null) {
    return null;
  }

  return range + sourceAvailabilityDelay + estimateHarvestEnergyAcquisitionTicks(creep, source);
}

function estimateHarvestEnergyAcquisitionTicks(creep: Creep, source: Source): number {
  const energy = Math.min(getHarvestSourceAvailableEnergy(source), getHarvestEnergyTarget(creep));
  if (energy <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  const workParts = getActiveWorkParts(creep);
  if (workParts <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.ceil(energy / Math.max(HARVEST_ENERGY_PER_WORK_PART, workParts * HARVEST_ENERGY_PER_WORK_PART));
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

function findWorkerSourceLinkEnergyAcquisitionCandidates(
  creep: Creep,
  reservationContext: WorkerEnergyAcquisitionReservationContext,
  options: WorkerEnergyAcquisitionSearchOptions = {}
): WorkerEnergyAcquisitionCandidate[] {
  const workerLinkIds = new Set(findOwnedWorkerEnergyLinks(creep.room).map((link) => String(link.id)));
  if (workerLinkIds.size === 0) {
    return [];
  }

  const network = classifyLinks(creep.room);
  return selectOwnedSourceWorkerEnergyLinks(network, workerLinkIds)
    .flatMap((link) => {
      const candidate = createSourceLinkEnergyAcquisitionCandidate(creep, link, reservationContext, network);
      return candidate ? [candidate] : [];
    })
    .filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options));
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
  const unreservedEnergy = getUnreservedWorkerEnergyAcquisitionAmount(
    source,
    energy,
    reservationContext,
    creep
  );
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
  const stagingRole = getWorkerEnergyAcquisitionStagingRole(creep, source);

  return {
    energy,
    priority: getWorkerEnergyAcquisitionPriority(creep, source, energy, range),
    ...(shouldPrioritizeWorkerEnergyAcquisitionPriorityBeforeRange(creep, stagingRole)
      ? { priorityBeforeRange: true }
      : {}),
    range,
    score: range === null ? energyScore : energyScore - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    ...(stagingRole ? { stagingRole } : {}),
    task
  };
}

function getWorkerEnergyAcquisitionPriority(
  creep: Creep,
  source: LowLoadWorkerEnergyAcquisitionSource,
  _energy: number,
  _range: number | null
): WorkerEnergyAcquisitionPriority {
  if (isDroppedEnergySourceObject(source)) {
    return 0;
  }

  if (isContainerEnergySource(source)) {
    if (isRoomSpawnEnergyCriticalNow(creep.room) && isControllerStagingContainer(creep.room, source)) {
      return 2;
    }

    return 1;
  }

  if (isLinkEnergySource(source)) {
    return 1;
  }

  if (isDurableStoredEnergySource(source)) {
    return 2;
  }

  if (isSpawnEnergySource(source)) {
    return 3;
  }

  return isHarvestSourceObject(source) ? 3 : 0;
}

function getWorkerEnergyAcquisitionStagingRole(
  creep: Creep,
  source: LowLoadWorkerEnergyAcquisitionSource
): EnergyStagingContainerRole | null {
  if (!isContainerEnergySource(source)) {
    return null;
  }

  if (isSpawnStagingContainer(creep.room, source)) {
    return 'spawn';
  }

  return isControllerStagingContainer(creep.room, source) ? 'controller' : null;
}

function shouldPrioritizeWorkerEnergyAcquisitionPriorityBeforeRange(
  creep: Creep,
  stagingRole: EnergyStagingContainerRole | null
): boolean {
  return stagingRole !== null && isRoomSpawnEnergyCriticalNow(creep.room);
}

function isContainerEnergySource(source: LowLoadWorkerEnergyAcquisitionSource): source is StructureContainer {
  return isStructureEnergySourceType(source, 'STRUCTURE_CONTAINER', 'container');
}

function isStorageEnergySource(source: LowLoadWorkerEnergyAcquisitionSource): source is StructureStorage {
  return isStructureEnergySourceType(source, 'STRUCTURE_STORAGE', 'storage');
}

function isLinkEnergySource(source: unknown): source is StructureLink {
  const structureType = (source as Partial<Structure> | null)?.structureType;
  return matchesStructureType(typeof structureType === 'string' ? structureType : undefined, 'STRUCTURE_LINK', 'link');
}

function isPreferredNearbyWorkerEnergySource(source: WorkerEnergyAcquisitionSource): boolean {
  return (
    isContainerEnergySource(source) ||
    isStorageEnergySource(source) ||
    isWorkerDroppedEnergySource(source) ||
    'ticksToDecay' in source
  );
}

function isWorkerDroppedEnergySource(
  source: WorkerEnergyAcquisitionSource
): source is Resource<ResourceConstant> {
  return isDroppedEnergySourceObject(source) && isDroppedEnergy(source, MIN_DROPPED_ENERGY_PICKUP_AMOUNT);
}

function isDroppedEnergySourceObject(
  source: LowLoadWorkerEnergyAcquisitionSource
): source is Resource<ResourceConstant> {
  return 'resourceType' in source && source.resourceType === getWorkerEnergyResource();
}

function isDurableStoredEnergySource(
  source: LowLoadWorkerEnergyAcquisitionSource
): source is StructureStorage | StructureTerminal {
  return (
    isStructureEnergySourceType(source, 'STRUCTURE_STORAGE', 'storage') ||
    isStructureEnergySourceType(source, 'STRUCTURE_TERMINAL', 'terminal')
  );
}

function isStructureEnergySourceType(
  source: LowLoadWorkerEnergyAcquisitionSource,
  globalName: StructureConstantGlobal,
  fallback: string
): boolean {
  const structureType = (source as Partial<Structure>).structureType;
  return matchesStructureType(typeof structureType === 'string' ? structureType : undefined, globalName, fallback);
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
  return getReservedWorkerEnergyAcquisitions(creep);
}

function getReservedWorkerEnergyAcquisitions(creep: Creep): WorkerEnergyAcquisitionReservationContext {
  const reservedEnergyBySourceId = new Map<string, number>();
  let constructionEnergyWithdrawn = 0;
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
    if (isWorkerConstructionEnergyAcquisitionReservationTask(task)) {
      constructionEnergyWithdrawn += freeCapacity;
    }
  }

  return { constructionEnergyWithdrawn, reservedEnergyBySourceId };
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

function isWorkerConstructionEnergyAcquisitionReservationTask(
  task: WorkerEnergyAcquisitionTask
): task is Extract<WorkerEnergyAcquisitionTask, { type: 'withdraw' }> {
  return task.type === 'withdraw' && typeof task.constructionSiteId === 'string' && task.constructionSiteId.length > 0;
}

function getUnreservedWorkerEnergyAcquisitionAmount(
  source: WorkerEnergyAcquisitionSource,
  energy: number,
  reservationContext: WorkerEnergyAcquisitionReservationContext,
  creep?: Creep
): number {
  const reservedEnergy = getReservedWorkerEnergyAcquisitionAmount(source, reservationContext);
  if (isContainerEnergySource(source)) {
    return getReservableContainerEnergy(source, energy, reservedEnergy);
  }

  const projectedEnergy = Math.max(0, energy - reservedEnergy);
  if (creep && isSpawnEnergySource(source)) {
    return getSpawnEnergyAvailableForWithdrawal(creep.room, source, projectedEnergy);
  }

  if (!creep || !isStorageEnergySource(source)) {
    return projectedEnergy;
  }

  const plannedWithdrawal = Math.min(projectedEnergy, getFreeEnergyCapacity(creep));
  if (
    plannedWithdrawal <= 0 ||
    plannedWithdrawal > getStorageEnergyAvailableForWithdrawal(creep.room, source, projectedEnergy) ||
    !withdrawFromStorage(creep.room, plannedWithdrawal, source, projectedEnergy)
  ) {
    return 0;
  }

  return getStorageEnergyAvailableForWithdrawal(creep.room, source, projectedEnergy);
}

function getReservedWorkerEnergyAcquisitionAmount(
  source: WorkerEnergyAcquisitionSource,
  reservationContext: WorkerEnergyAcquisitionReservationContext
): number {
  return reservationContext.reservedEnergyBySourceId.get(String(source.id)) ?? 0;
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

  const creepToSourceRange = getHarvestSourceTravelCost(creep, source);
  const sourceToSinkRange = getHarvestSourceDeliveryTravelCost(creep, source, energySink);
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

  return getHarvestSourceRegenerationDelay(source);
}

function getHarvestSourceRegenerationDelay(source: Source): number | null {
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
  if (isHarvestSourceObject(source)) {
    return getHarvestSourceTravelCost(creep, source);
  }

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
  const priorityBeforeRangeComparison = comparePriorityBeforeRangeEnergyCandidates(left, right);
  if (priorityBeforeRangeComparison !== 0) {
    return priorityBeforeRangeComparison;
  }

  const rangeComparison = compareOptionalRanges(left.range, right.range);
  if (rangeComparison !== 0) {
    return rangeComparison;
  }

  const priorityComparison = left.priority - right.priority;
  if (priorityComparison !== 0) {
    return priorityComparison;
  }

  if (left.priority === 0) {
    return (
      right.energy - left.energy ||
      String(left.source.id).localeCompare(String(right.source.id)) ||
      left.task.type.localeCompare(right.task.type)
    );
  }

  if (left.priority === 1) {
    return (
      right.score - left.score ||
      right.energy - left.energy ||
      String(left.source.id).localeCompare(String(right.source.id)) ||
      left.task.type.localeCompare(right.task.type)
    );
  }

  return (
    right.score - left.score ||
    right.energy - left.energy ||
    String(left.source.id).localeCompare(String(right.source.id)) ||
    left.task.type.localeCompare(right.task.type)
  );
}

function comparePriorityBeforeRangeEnergyCandidates(
  left: Pick<WorkerEnergyAcquisitionCandidate, 'priority' | 'priorityBeforeRange'>,
  right: Pick<WorkerEnergyAcquisitionCandidate, 'priority' | 'priorityBeforeRange'>
): number {
  if (left.priorityBeforeRange !== true && right.priorityBeforeRange !== true) {
    return 0;
  }

  return left.priority - right.priority;
}

function compareNearbyWorkerEnergyAcquisitionCandidates(
  left: WorkerEnergyAcquisitionCandidate,
  right: WorkerEnergyAcquisitionCandidate
): number {
  return (
    compareOptionalRanges(left.range, right.range) ||
    left.priority - right.priority ||
    right.score - left.score ||
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

function compareWorkerLinkEnergyAcquisitionCandidates(
  left: WorkerEnergyAcquisitionCandidate,
  right: WorkerEnergyAcquisitionCandidate
): number {
  return (
    compareOptionalRanges(left.range, right.range) ||
    right.energy - left.energy ||
    String(left.source.id).localeCompare(String(right.source.id))
  );
}

function compareSpawnRecoveryEnergyAcquisitionCandidates(
  left: SpawnRecoveryEnergyAcquisitionCandidate,
  right: SpawnRecoveryEnergyAcquisitionCandidate
): number {
  return (
    comparePriorityBeforeRangeEnergyCandidates(left, right) ||
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
  const availabilityPriorityComparison = left.availabilityPriority - right.availabilityPriority;
  if (availabilityPriorityComparison !== 0) {
    return availabilityPriorityComparison;
  }

  const deliveryEtaComparison = left.deliveryEta - right.deliveryEta;
  if (Math.abs(deliveryEtaComparison) > SPAWN_RECOVERY_SOURCE_LOAD_BALANCE_ETA_TOLERANCE) {
    return deliveryEtaComparison;
  }

  return (
    compareHarvestSourceLoadRatio(left.load, right.load) ||
    left.load.assignmentCount - right.load.assignmentCount ||
    deliveryEtaComparison ||
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

  const repairTargets = findVisibleRoomStructures(creep.room).filter((structure) =>
    isRoutineRepairTargetForWorker(creep, structure)
  );
  if (repairTargets.length === 0) {
    return null;
  }

  return repairTargets.sort(compareRepairTargets)[0];
}

function selectThreatenedBarrierRepairTarget(creep: Creep): StructureRampart | StructureWall | null {
  if (creep.room.controller?.my !== true || !isColonyRoomThreatened(creep.room.name)) {
    return null;
  }

  const repairTargets = findVisibleRoomStructures(creep.room).filter(isThreatenedBarrierRepairTarget);
  if (repairTargets.length === 0) {
    return null;
  }

  return repairTargets.sort(compareRepairTargets)[0];
}

function selectRoutineBarrierMaintenanceRepairTarget(creep: Creep): StructureRampart | StructureWall | null {
  return selectAvailableRoutineRepairTarget(creep, getRoutineBarrierMaintenanceRepairTargets(creep.room));
}

function selectRoutineRampartMaintenanceRepairTarget(creep: Creep): StructureRampart | null {
  return selectAvailableRoutineRepairTarget(creep, computeRoutineRampartMaintenanceRepairTargets(creep.room));
}

export function selectActiveRampartRepairEnergyAcquisitionTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }> | null {
  if (
    getFreeEnergyCapacity(creep) <= 0 ||
    hasVisibleConstructionSites(creep.room) ||
    !selectActiveOwnedRampartRepairTarget(creep)
  ) {
    return null;
  }

  return selectWorkerEnergyCriticalAcquisitionTask(creep);
}

function hasVisibleConstructionSites(room: Room): boolean {
  return typeof FIND_CONSTRUCTION_SITES === 'number' && room.find(FIND_CONSTRUCTION_SITES).length > 0;
}

function selectActiveOwnedRampartRepairTarget(creep: Creep): StructureRampart | null {
  if (
    creep.room.controller?.my !== true ||
    hasVisibleHostilePresence(creep.room) ||
    !hasActiveRampartRepairEnergyReserve(creep.room)
  ) {
    return null;
  }

  const repairTargets = findVisibleRoomStructures(creep.room)
    .filter(isActiveOwnedRampartRepairTarget)
    .filter((structure) => hasActiveRampartRepairAssignmentCapacity(creep, structure));
  if (repairTargets.length === 0) {
    return null;
  }

  return repairTargets.sort(compareRepairTargets)[0];
}

function hasActiveRampartRepairEnergyReserve(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  return energyAvailable === null || energyAvailable >= CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD;
}

function getRoutineBarrierMaintenanceRepairTargets(room: Room): Array<StructureRampart | StructureWall> {
  const gameTick = getGameTick();
  const roomName = getRoomName(room);
  if (gameTick === null || roomName === null) {
    return computeRoutineBarrierMaintenanceRepairTargets(room);
  }

  const game = getGameReference();
  if (
    !routineBarrierMaintenanceRepairTargetCache ||
    routineBarrierMaintenanceRepairTargetCache.tick !== gameTick ||
    routineBarrierMaintenanceRepairTargetCache.game !== game
  ) {
    routineBarrierMaintenanceRepairTargetCache = {
      game,
      roomsByName: new Map<string, RoutineBarrierMaintenanceRepairTargetCacheEntry>(),
      tick: gameTick
    };
  }

  const cachedEntry = routineBarrierMaintenanceRepairTargetCache.roomsByName.get(roomName);
  if (cachedEntry?.room === room) {
    return cachedEntry.targets;
  }

  const targets = computeRoutineBarrierMaintenanceRepairTargets(room);
  routineBarrierMaintenanceRepairTargetCache.roomsByName.set(roomName, { room, targets });
  return targets;
}

function computeRoutineBarrierMaintenanceRepairTargets(room: Room): Array<StructureRampart | StructureWall> {
  if (!canSelectRoutineBarrierMaintenanceRepairTarget(room)) {
    return [];
  }

  const repairTargets = findVisibleRoomStructures(room).filter(isRoutineBarrierMaintenanceRepairTarget);
  if (repairTargets.length === 0) {
    return [];
  }

  return repairTargets.sort(compareRepairTargets);
}

function computeRoutineRampartMaintenanceRepairTargets(room: Room): StructureRampart[] {
  if (!canSelectRoutineBarrierMaintenanceRepairTarget(room)) {
    return [];
  }

  const repairTargets = findVisibleRoomStructures(room).filter(isRoutineRampartMaintenanceRepairTarget);
  if (repairTargets.length === 0) {
    return [];
  }

  return repairTargets.sort(compareRepairTargets);
}

function selectAvailableRoutineRepairTarget<T extends RepairableWorkerStructure>(
  creep: Creep,
  repairTargets: T[]
): T | null {
  return repairTargets.find((structure) => hasRoutineRepairAssignmentCapacity(creep, structure)) ?? null;
}

function shouldDeferRoutineRepairToCoveredRcl3ControllerProgress(
  creep: Creep,
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[],
  repairTarget: RepairableWorkerStructure
): boolean {
  return (
    !isUrgentRepairTargetForControllerProgressBudget(repairTarget) &&
    shouldDeferCoveredRcl3RoutineRepairToControllerProgress(creep, controller, constructionSites)
  );
}

function shouldDeferCoveredRcl3RoutineRepairToControllerProgress(
  creep: Creep,
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[]
): boolean {
  return (
    shouldBoundHealthyRcl3RoutineRepairs(creep, controller, constructionSites) &&
    hasSameRoomLoadedRepairCoverage(creep)
  );
}

function hasSameRoomLoadedRepairCoverage(creep: Creep): boolean {
  return getSameRoomLoadedWorkers(creep).some(
    (worker) =>
      !isSameCreep(worker, creep) &&
      worker.spawning !== true &&
      worker.memory?.task?.type === 'repair' &&
      getActiveWorkParts(worker) > 0
  );
}

function shouldBoundHealthyRcl3RoutineRepairs(
  creep: Creep,
  controller: StructureController | undefined,
  constructionSites: ConstructionSite[]
): boolean {
  return (
    controller?.my === true &&
    getControllerLevel(controller) === 3 &&
    canLevelUpController(controller) &&
    constructionSites.length === 0 &&
    !hasVisibleHostilePresence(creep.room) &&
    hasHealthyRoomEnergyBuffer(creep.room) &&
    getSameRoomLoadedWorkers(creep).length >= MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS
  );
}

function isUrgentRepairTargetForControllerProgressBudget(repairTarget: RepairableWorkerStructure): boolean {
  return (
    isUrgentBarrierRepairTarget(repairTarget) ||
    isCriticalOwnedSpawnRepairTarget(repairTarget) ||
    (isRoadOrContainerRepairTarget(repairTarget) &&
      getHitsRatio(repairTarget) <= CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO)
  );
}

function canSelectRoutineBarrierMaintenanceRepairTarget(room: Room): boolean {
  return (
    room.controller?.my === true &&
    !hasVisibleHostilePresence(room) &&
    checkEnergyBufferForConstructionSpending(room)
  );
}

function selectCriticalInfrastructureRepairTarget(creep: Creep): CriticalInfrastructureRepairTarget | null {
  const visibleStructures = findVisibleRoomStructures(creep.room);
  const criticalSpawnRepairTarget = selectCriticalOwnedSpawnRepairTarget(creep, visibleStructures);
  if (criticalSpawnRepairTarget) {
    return criticalSpawnRepairTarget;
  }

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

function selectCriticalOwnedSpawnRepairTarget(
  creep: Creep,
  visibleStructures = findVisibleRoomStructures(creep.room)
): StructureSpawn | null {
  if (creep.room.controller?.my !== true) {
    return null;
  }

  return visibleStructures.filter(isCriticalOwnedSpawnRepairTarget).sort(compareRepairTargets)[0] ?? null;
}

function selectEmergencyOwnedRampartRepairTarget(creep: Creep): StructureRampart | null {
  if (creep.room.controller?.my !== true) {
    return null;
  }

  return findVisibleRoomStructures(creep.room)
    .filter(isEmergencyOwnedRampartRepairTarget)
    .sort(compareRepairTargets)[0] ?? null;
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

  if (isOwnedSpawnRepairTarget(structure)) {
    return true;
  }

  if (isRoadOrContainerRepairTarget(structure)) {
    return true;
  }

  return matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') && isOwnedRampart(structure);
}

function isThreatenedBarrierRepairTarget(
  structure: AnyStructure
): structure is StructureRampart | StructureWall {
  return isBarrierRepairTarget(structure) && !isWorkerRepairTargetComplete(structure);
}

function isRoutineBarrierMaintenanceRepairTarget(
  structure: AnyStructure
): structure is StructureRampart | StructureWall {
  return isBarrierRepairTarget(structure) && !isWorkerRepairTargetComplete(structure);
}

function isRoutineRampartMaintenanceRepairTarget(structure: AnyStructure): structure is StructureRampart {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') &&
    isOwnedRampart(structure) &&
    !isWorkerRepairTargetComplete(structure)
  );
}

function isSafeRepairTargetForWorkerRoom(
  creep: Creep,
  structure: AnyStructure
): structure is RepairableWorkerStructure {
  return isSafeRepairTarget(structure) && (!isSpawnRepairTarget(structure) || creep.room.controller?.my === true);
}

function isRoutineRepairTargetForWorker(
  creep: Creep,
  structure: AnyStructure
): structure is RepairableWorkerStructure {
  if (!isSafeRepairTargetForWorkerRoom(creep, structure)) {
    return false;
  }

  if (isWorkerBarrierRepairStructure(structure)) {
    return isUrgentBarrierRepairTarget(structure) || hasRoutineRepairAssignmentCapacity(creep, structure);
  }

  return (
    hasMeaningfulRoutineRepairDeficit(structure) &&
    isRoutineRepairTargetWithinOpportunisticRange(creep, structure) &&
    hasRoutineRepairAssignmentCapacity(creep, structure)
  );
}

function hasMeaningfulRoutineRepairDeficit(structure: RepairableWorkerStructure): boolean {
  const repairCeiling = getWorkerRepairHitsCeiling(structure);
  const deficit = Math.max(0, repairCeiling - structure.hits);
  return (
    deficit >= ROUTINE_REPAIR_MIN_HITS_DEFICIT &&
    repairCeiling > 0 &&
    deficit / repairCeiling >= ROUTINE_REPAIR_MIN_HITS_DEFICIT_RATIO
  );
}

function isRoutineRepairTargetWithinOpportunisticRange(
  creep: Creep,
  structure: RepairableWorkerStructure
): boolean {
  const range = getRangeBetweenRoomObjects(creep, structure);
  return range === null || range <= ROUTINE_REPAIR_MAX_RANGE;
}

function hasRoutineRepairAssignmentCapacity(creep: Creep, structure: RepairableWorkerStructure): boolean {
  return (
    isUrgentBarrierRepairTarget(structure) ||
    isWorkerAssignedToRepairTarget(creep, structure) ||
    !hasOtherWorkerAssignedToRepairTarget(creep, structure)
  );
}

function hasActiveRampartRepairAssignmentCapacity(creep: Creep, structure: StructureRampart): boolean {
  return (
    isWorkerAssignedToRepairTarget(creep, structure) ||
    !hasOtherLoadedWorkerAssignedToRepairTarget(creep, structure)
  );
}

function isUrgentBarrierRepairTarget(structure: RepairableWorkerStructure): boolean {
  return (
    isWorkerBarrierRepairStructure(structure) &&
    structure.hits < Math.min(structure.hitsMax, BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING)
  );
}

function hasOtherWorkerAssignedToRepairTarget(creep: Creep, structure: RepairableWorkerStructure): boolean {
  return getRoomOwnedCreeps(creep.room).some(
    (worker) =>
      !isSameCreep(worker, creep) &&
      worker.memory?.role === 'worker' &&
      isWorkerAssignedToRepairTarget(worker, structure)
  );
}

function hasOtherLoadedWorkerAssignedToRepairTarget(creep: Creep, structure: RepairableWorkerStructure): boolean {
  return getRoomOwnedCreeps(creep.room).some(
    (worker) =>
      !isSameCreep(worker, creep) &&
      worker.memory?.role === 'worker' &&
      getUsedEnergy(worker) > 0 &&
      getActiveWorkParts(worker) > 0 &&
      isWorkerAssignedToRepairTarget(worker, structure)
  );
}

function isWorkerAssignedToRepairTarget(worker: Creep, structure: RepairableWorkerStructure): boolean {
  const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'repair' && String(task.targetId) === String(structure.id);
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

function isBarrierRepairTarget(structure: AnyStructure): structure is StructureRampart | StructureWall {
  return (
    (matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') && isOwnedRampart(structure)) ||
    isWallRepairTarget(structure)
  );
}

function isRoadRepairTarget(structure: AnyStructure): structure is StructureRoad {
  return matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road');
}

function isContainerRepairTarget(structure: AnyStructure): structure is StructureContainer {
  return matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container');
}

function isWallRepairTarget(structure: AnyStructure): structure is StructureWall {
  return matchesStructureType(structure.structureType, 'STRUCTURE_WALL', 'constructedWall');
}

function isCriticalOwnedSpawnRepairTarget(structure: AnyStructure): structure is StructureSpawn {
  return (
    isOwnedSpawnRepairTarget(structure) &&
    !isWorkerRepairTargetComplete(structure) &&
    getHitsRatio(structure) <= CRITICAL_SPAWN_REPAIR_HITS_RATIO
  );
}

function isEmergencyOwnedRampartRepairTarget(structure: AnyStructure): structure is StructureRampart {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') &&
    isOwnedRampart(structure) &&
    !isWorkerRepairTargetComplete(structure) &&
    structure.hits <= EMERGENCY_RAMPART_REPAIR_HITS_CEILING
  );
}

function isActiveOwnedRampartRepairTarget(structure: AnyStructure): structure is StructureRampart {
  const repairCeiling = Math.min(structure.hitsMax, ACTIVE_RAMPART_REPAIR_HITS_CEILING);
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') &&
    isOwnedRampart(structure) &&
    structure.hits < repairCeiling
  );
}

function isOwnedSpawnRepairTarget(structure: AnyStructure): structure is StructureSpawn {
  return isSpawnRepairTarget(structure) && (structure as Partial<StructureSpawn>).my === true;
}

function isSpawnRepairTarget(structure: AnyStructure): structure is StructureSpawn {
  return matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

export function isWorkerRepairTargetComplete(structure: Structure): boolean {
  return structure.hits >= getWorkerRepairHitsCeiling(structure);
}

function getWorkerRepairHitsCeiling(structure: Structure): number {
  if (isWorkerBarrierRepairStructure(structure)) {
    if (shouldUseBootstrapDefenseFloorRepairCap(getStructureRoom(structure))) {
      return Math.min(structure.hitsMax, BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING);
    }

    return Math.min(structure.hitsMax, IDLE_RAMPART_REPAIR_HITS_CEILING);
  }

  return structure.hitsMax;
}

function getStructureRoom(structure: Structure): Room {
  return (structure as Structure & { room?: Room }).room ?? ({} as Room);
}

function isWorkerBarrierRepairStructure(structure: Structure): boolean {
  return (
    (matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') && isOwnedRampart(structure)) ||
    matchesStructureType(structure.structureType, 'STRUCTURE_WALL', 'constructedWall')
  );
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
  if (isCriticalOwnedSpawnRepairTarget(structure)) {
    return 0;
  }

  if (matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road')) {
    return 1;
  }

  if (matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container')) {
    return 2;
  }

  if (isSpawnRepairTarget(structure)) {
    return 3;
  }

  return 4;
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

function selectRcl3DefenseUnlockUpgradeTask(
  creep: Creep,
  controller: StructureController | undefined
): Extract<CreepTaskMemory, { type: 'upgrade' }> | null {
  if (!shouldUpgradeForRcl3DefenseUnlock(creep, controller)) {
    return null;
  }

  return { type: 'upgrade', targetId: controller.id };
}

function shouldUpgradeForRcl3DefenseUnlock(
  creep: Creep,
  controller: StructureController | undefined
): controller is StructureController {
  return (
    controller?.my === true &&
    controller.level === 2 &&
    shouldGateTerritoryOnBootstrapDefenseFloor(creep.room) &&
    isWorkerInColonyRoom(creep) &&
    getUsedEnergy(creep) > 0 &&
    !hasVisibleHostilePresence(creep.room) &&
    !shouldGuardControllerDowngrade(controller) &&
    !isControllerUpgradeSaturated(creep, controller, { ignoreTerritoryExpansionPressure: true })
  );
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
  const time = getGameReference()?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function getGameReference(): Partial<Game> | undefined {
  return (globalThis as unknown as { Game?: Partial<Game> }).Game;
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
  if (isControllerUpgradeSaturated(creep, controller)) {
    return false;
  }

  if (shouldApplyControllerPressureLane(creep, controller)) {
    return true;
  }

  const hasRecoverableEnergySurplus = hasRecoverableSurplusEnergy(creep);
  const upgradePriority = getControllerUpgradePriority(controller, {
    energyAvailable: getRoomEnergyAvailable(creep.room) ?? undefined,
    energyCapacityAvailable: getRoomEnergyCapacityAvailable(creep.room) ?? undefined,
    hasEnergySurplus: hasRecoverableEnergySurplus
  });
  if (
    controller.my === true &&
    controller.level >= 2 &&
    (upgradePriority === 'rclProgress' || upgradePriority === 'energySurplus')
  ) {
    return true;
  }

  return false;
}

function shouldStandbySurplusWorkerInsteadOfAcquiring(
  creep: Creep,
  controller: StructureController | undefined
): boolean {
  if (controller?.my !== true || !isControllerUpgradeSaturated(creep, controller)) {
    return false;
  }

  if (hasNonControllerWorkerEnergyDemand(creep)) {
    return false;
  }

  return !hasPostConstructionControllerUpgradeEnergy(creep, controller);
}

function hasNonControllerWorkerEnergyDemand(creep: Creep): boolean {
  if (selectFillableEnergySink(creep)) {
    return true;
  }

  if (hasRoomSpawnExtensionEnergyDeficit(creep.room)) {
    return true;
  }

  const constructionSites =
    typeof FIND_CONSTRUCTION_SITES === 'number' && typeof creep.room?.find === 'function'
      ? creep.room.find(FIND_CONSTRUCTION_SITES)
      : [];
  if (constructionSites.length > 0) {
    return true;
  }

  return (
    selectCriticalInfrastructureRepairTarget(creep) !== null ||
    selectRepairTarget(creep) !== null ||
    selectRoutineBarrierMaintenanceRepairTarget(creep) !== null
  );
}

function hasPostConstructionControllerUpgradeEnergy(creep: Creep, controller: StructureController): boolean {
  return (
    isLowRclControllerProgressTarget(controller) &&
    !hasVisibleHostilePresence(creep.room) &&
    !hasVisibleOwnedConstructionDemand(creep.room) &&
    (findWorkerEnergyAcquisitionCandidates(creep).length > 0 ||
      hasFullRoomEnergyForControllerProgress(creep.room))
  );
}

function isLowRclControllerProgressTarget(controller: StructureController): boolean {
  return canLevelUpController(controller) && controller.level >= 2 && controller.level <= 3;
}

function isControllerUpgradeSaturated(
  creep: Creep,
  controller: StructureController,
  options: { ignoreTerritoryExpansionPressure?: boolean } = {}
): boolean {
  if (controller.my !== true || shouldGuardControllerDowngrade(controller)) {
    return false;
  }

  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  const otherControllerUpgraders = loadedWorkers.filter(
    (worker) => !isSameCreep(worker, creep) && isUpgradingController(worker, controller)
  ).length;
  if (otherControllerUpgraders === 0) {
    return false;
  }

  const controllerProgressWorkerLimit = Math.max(
    1,
    getControllerProgressWorkerLimit(
      creep,
      loadedWorkers.length,
      options.ignoreTerritoryExpansionPressure !== true && hasActiveTerritoryExpansionPressure(creep)
    )
  );

  return otherControllerUpgraders >= controllerProgressWorkerLimit;
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
  return productiveEnergySinkTask ?? (canUpgradeController(controller) ? { type: 'upgrade', targetId: controller.id } : null);
}

export function canUpgradeController(controller: StructureController | undefined): boolean {
  return controller?.my === true;
}

export function canLevelUpController(controller: StructureController | undefined): boolean {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level < MAX_CONTROLLER_LEVEL
  );
}

function selectSource2ControllerLaneHarvestTask(creep: Creep): Extract<CreepTaskMemory, { type: 'harvest' }> | null {
  const source = selectSource2ControllerLaneHarvestSource(creep);
  return source ? { type: 'harvest', targetId: source.id } : null;
}

function selectSource2ControllerLaneHarvestSource(creep: Creep): Source | null {
  const controller = creep.room.controller;
  if (!controller) {
    return null;
  }

  const topology = getSource2ControllerLaneTopology(creep.room, controller);
  if (!topology || isSourceDepleted(topology.source) || hasOtherSource2ControllerLaneWorker(creep, topology)) {
    return null;
  }

  return topology.source;
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

function isProductiveSameRoomWorker(creep: Creep, room: Room): boolean {
  return isSameRoomWorker(creep, room) && !willBypassNormalWorkerTaskSelectionThisTick(creep);
}

function willBypassNormalWorkerTaskSelectionThisTick(creep: Creep): boolean {
  return (
    willRunControllerSustainMovementBeforeNormalTaskSelection(creep) ||
    willRunSpawnSupportMovementBeforeNormalTaskSelection(creep)
  );
}

function willRunControllerSustainMovementBeforeNormalTaskSelection(creep: Creep): boolean {
  const sustain = creep.memory?.controllerSustain;
  if (!isControllerSustainMemory(sustain)) {
    return false;
  }

  const roomName = creep.room?.name;
  if (roomName !== sustain.targetRoom) {
    return true;
  }

  return sustain.role === 'hauler' && getUsedEnergy(creep) <= 0;
}

function willRunSpawnSupportMovementBeforeNormalTaskSelection(creep: Creep): boolean {
  const support = creep.memory?.spawnSupport;
  return isSpawnSupportMemory(support) && creep.room?.name !== support.targetRoom;
}

function isControllerSustainMemory(value: unknown): value is CreepControllerSustainMemory {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const memory = value as Partial<CreepControllerSustainMemory>;
  return (
    typeof memory.homeRoom === 'string' &&
    memory.homeRoom.length > 0 &&
    typeof memory.targetRoom === 'string' &&
    memory.targetRoom.length > 0 &&
    (memory.role === 'upgrader' || memory.role === 'hauler')
  );
}

function isSpawnSupportMemory(value: unknown): value is CreepSpawnSupportMemory {
  const support = value as Partial<CreepSpawnSupportMemory>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof support.originRoom === 'string' &&
    typeof support.targetRoom === 'string' &&
    support.originRoom.length > 0 &&
    support.targetRoom.length > 0
  );
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
  return getKnownStoredEnergy(object) ?? 0;
}

function getKnownStoredEnergy(object: unknown): number | null {
  const store = getStore(object);
  if (store) {
    const usedCapacity = store.getUsedCapacity?.(getWorkerEnergyResource());
    if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
      return usedCapacity;
    }

    const storedEnergy = store[getWorkerEnergyResource()];
    if (typeof storedEnergy === 'number' && Number.isFinite(storedEnergy)) {
      return storedEnergy;
    }
  }

  const legacyEnergy = (object as { energy?: unknown } | null)?.energy;
  return typeof legacyEnergy === 'number' && Number.isFinite(legacyEnergy) ? legacyEnergy : null;
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

function selectSourceContainerWithdrawTask(creep: Creep): WorkerEnergyAcquisitionTask | null {
  const candidates = findSourceContainerWithdrawCandidates(creep);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}

function findSourceContainerWithdrawCandidates(creep: Creep): WorkerEnergyAcquisitionCandidate[] {
  const harvestRooms = findVisibleHarvestRooms(creep);
  if (!harvestRooms.some(hasVisiblePositionedContainer)) {
    return [];
  }

  const context = createSourceContainerWithdrawalContext(creep, findVisibleHarvestSourcesInRooms(harvestRooms));
  if (context.sources.length === 0) {
    return [];
  }

  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const candidates: WorkerEnergyAcquisitionCandidate[] = [];
  const seenContainerIds = new Set<string>();
  const seenLinkIds = new Set<string>();
  const linkNetworksByRoomName = new Map<string, LinkNetwork>();

  for (const source of context.sources) {
    const sourceContainer = findVisibleSourceContainer(creep, source);
    if (!sourceContainer || seenContainerIds.has(String(sourceContainer.id))) {
      continue;
    }

    const sourceRoom = findVisibleSourceRoom(creep, source);
    if (!sourceRoom) {
      continue;
    }

    if (hasAssignableHarvestSourceInRoom(creep, sourceRoom, context.sources, context.assignmentLoads)) {
      continue;
    }

    if (
      !isSourceContainerWithdrawalSourceSaturated(
        creep,
        source,
        getHarvestSourceAssignmentLoad(context.assignmentLoads, source)
      )
    ) {
      continue;
    }

    const linkNetwork = getCachedLinkNetwork(sourceRoom, linkNetworksByRoomName);
    const sourceLink = findVisibleSourceLink(sourceRoom, source, linkNetwork);
    if (sourceLink && !seenLinkIds.has(String(sourceLink.id))) {
      const sourceLinkCandidate = createSourceLinkEnergyAcquisitionCandidate(
        creep,
        sourceLink,
        reservationContext,
        linkNetwork,
        sourceRoom
      );
      if (sourceLinkCandidate) {
        candidates.push(sourceLinkCandidate);
        seenLinkIds.add(String(sourceLink.id));
      }
    }

    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      sourceContainer,
      getStoredEnergy(sourceContainer),
      {
        type: 'withdraw',
        targetId: sourceContainer.id as Id<AnyStoreStructure>
      },
      reservationContext
    );

    if (
      candidate &&
      isSafeStoredEnergySource(sourceContainer as AnyStructure, {
        creepOwnerUsername: getCreepOwnerUsername(creep),
        hasHostilePresence: hasVisibleHostilePresence(sourceRoom),
        room: sourceRoom
      })
    ) {
      candidates.push(candidate);
      seenContainerIds.add(String(sourceContainer.id));
    }
  }

  return candidates;
}

function createSourceLinkEnergyAcquisitionCandidate(
  creep: Creep,
  sourceLink: StructureLink,
  reservationContext: WorkerEnergyAcquisitionReservationContext,
  network?: LinkNetwork,
  room = creep.room
): WorkerEnergyAcquisitionCandidate | null {
  const availableEnergy = getSourceLinkWorkerEnergyAvailable(room, sourceLink, network);
  const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
    creep,
    sourceLink,
    availableEnergy,
    {
      type: 'withdraw',
      targetId: sourceLink.id as Id<AnyStoreStructure>
    },
    reservationContext
  );

  return candidate && candidate.range !== null ? { ...candidate, priority: 1 } : null;
}

function selectSourceContainerHarvestTask(creep: Creep): Extract<CreepTaskMemory, { type: 'harvest' }> | null {
  const source = selectSourceContainerHarvestSource(creep);
  return source ? { type: 'harvest', targetId: source.id, sourceContainerAssigned: true } : null;
}

function selectSourceContainerHarvestSource(creep: Creep): Source | null {
  if (
    getActiveWorkParts(creep) <= 0 ||
    typeof FIND_SOURCES !== 'number'
  ) {
    return null;
  }

  const harvestRooms = findVisibleHarvestRooms(creep);
  if (!harvestRooms.some(hasVisiblePositionedContainer)) {
    return null;
  }

  const source = selectBestHarvestSource(
    creep,
    findVisibleHarvestSourcesInRooms(harvestRooms).filter((candidate) => hasVisibleSourceContainer(creep, candidate))
  );
  return source;
}

function hasVisibleSourceContainer(creep: Creep, source: Source): boolean {
  return findVisibleSourceContainer(creep, source) !== null;
}

function hasVisiblePositionedContainer(room: Room): boolean {
  if (typeof FIND_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return false;
  }

  return room.find(FIND_STRUCTURES).some((structure) => {
    const position = getRoomObjectPosition(structure);
    return (
      position !== null &&
      matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container')
    );
  });
}

function findVisibleHarvestSources(creep: Creep): Source[] {
  return findVisibleHarvestSourcesInRooms(findVisibleHarvestRooms(creep));
}

function findVisibleHarvestSourcesInRooms(rooms: Room[]): Source[] {
  if (typeof FIND_SOURCES !== 'number') {
    return [];
  }

  const sourcesById = new Map<string, Source>();
  for (const room of rooms) {
    if (typeof room.find !== 'function') {
      continue;
    }

    for (const source of room.find(FIND_SOURCES) as Source[]) {
      sourcesById.set(String(source.id), source);
    }
  }

  return [...sourcesById.values()];
}

function findVisibleHarvestRooms(creep: Creep): Room[] {
  const rooms: Room[] = [];
  if (creep.room) {
    rooms.push(creep.room);
  }

  for (const room of findVisibleAdjacentClaimedRooms(creep.room)) {
    if (rooms.some((candidate) => candidate.name === room.name)) {
      continue;
    }

    rooms.push(room);
  }

  return rooms;
}

function findVisibleAdjacentClaimedRooms(room: Room | undefined): Room[] {
  const roomName = room?.name;
  if (!roomName) {
    return [];
  }

  const game = (globalThis as unknown as { Game?: Partial<Pick<Game, 'map' | 'rooms'>> }).Game;
  const visibleRooms = game?.rooms;
  const adjacentRoomNames = getAdjacentRoomNames(roomName, game?.map);
  if (!visibleRooms || adjacentRoomNames.length === 0) {
    return [];
  }

  return adjacentRoomNames
    .map((adjacentRoomName) => visibleRooms[adjacentRoomName])
    .filter((candidate): candidate is Room => candidate?.controller?.my === true)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getAdjacentRoomNames(roomName: string, gameMap: Partial<GameMap> | undefined): string[] {
  if (typeof gameMap?.describeExits !== 'function') {
    return [];
  }

  const exits = gameMap.describeExits(roomName) as ExitsInformation | null;
  if (!exits || typeof exits !== 'object') {
    return [];
  }

  return Object.values(exits)
    .filter((adjacentRoomName): adjacentRoomName is string => typeof adjacentRoomName === 'string' && adjacentRoomName.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function findVisibleSourceContainer(creep: Creep, source: Source): StructureContainer | null {
  const sourceRoom = findVisibleSourceRoom(creep, source);
  return sourceRoom ? findSourceContainer(sourceRoom, source) : null;
}

function findVisibleSourceLink(sourceRoom: Room, source: Source, network?: LinkNetwork): StructureLink | null {
  return (
    findOwnedSourceWorkerEnergyLinks(sourceRoom, network)
      .filter((link) => isSourceLinkNearSource(source, link))
      .sort((left, right) => compareSourceLinksForSource(source, left, right))[0] ?? null
  );
}

function getCachedLinkNetwork(room: Room, networksByRoomName: Map<string, LinkNetwork>): LinkNetwork {
  const cached = networksByRoomName.get(room.name);
  if (cached) {
    return cached;
  }

  const network = classifyLinks(room);
  networksByRoomName.set(room.name, network);
  return network;
}

function isSourceLinkNearSource(source: Source, link: StructureLink): boolean {
  const range = getRangeBetweenRoomObjectPositions(source, link);
  return range !== null && range <= SOURCE_LINK_RANGE;
}

function compareSourceLinksForSource(source: Source, left: StructureLink, right: StructureLink): number {
  return (
    compareOptionalRanges(getRangeBetweenRoomObjectPositions(source, left), getRangeBetweenRoomObjectPositions(source, right)) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function createSourceContainerWithdrawalContext(
  creep: Creep,
  sources = findVisibleHarvestSources(creep)
): SourceContainerWithdrawalContext {
  const assignmentLoads = getWorkerHarvestLoads(sources);
  return {
    assignmentLoads,
    sources
  };
}

function hasAssignableHarvestSourceInRoom(
  creep: Creep,
  room: Room,
  sources: Source[],
  assignmentLoads: Map<Id<Source>, HarvestSourceAssignmentLoad>
): boolean {
  return hasAssignableHarvestSource(
    creep,
    sources.filter((source) => findVisibleSourceRoom(creep, source)?.name === room.name),
    assignmentLoads
  );
}

function hasAssignableHarvestSource(
  creep: Creep,
  sources: Source[],
  assignmentLoads: Map<Id<Source>, HarvestSourceAssignmentLoad>
): boolean {
  const viableSources = selectViableHarvestSources(sources, getHarvestEnergyTarget(creep), creep);
  if (viableSources.length === 0) {
    return false;
  }

  const assignableSources = selectReachableHarvestSources(
    creep,
    selectAssignableHarvestSources(creep, viableSources, assignmentLoads)
  );
  return assignableSources.length > 0;
}

function isSourceContainerWithdrawalSourceSaturated(
  creep: Creep,
  source: Source,
  assignmentLoad: HarvestSourceAssignmentLoad
): boolean {
  if (isWorkerAssignedToHarvestSource(creep, source) || assignmentLoad.assignmentCount <= 0) {
    return false;
  }

  return (
    assignmentLoad.assignmentCount >= getHarvestSourceAccessCapacity(source) ||
    hasOccupiedSourceContainerHarvestSlot(source, assignmentLoad)
  );
}

function hasOccupiedSourceContainerHarvestSlot(
  source: Source,
  assignmentLoad: HarvestSourceAssignmentLoad
): boolean {
  return assignmentLoad.hasContainerAssignment && getRoomObjectPosition(source) !== null;
}

function findVisibleSourceRoom(creep: Creep, source: Source): Room | null {
  const sourceRoomName = getPositionRoomName(source) ?? creep.room?.name;
  if (!sourceRoomName) {
    return null;
  }

  if (creep.room?.name === sourceRoomName) {
    return creep.room;
  }

  return (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[sourceRoomName] ?? null;
}

function selectHarvestSource(
  creep: Creep,
  options: HarvestSourceSelectionOptions = {}
): Source | null {
  const sources = findVisibleHarvestSources(creep);
  if (sources.length === 0) {
    return null;
  }

  return selectBestHarvestSource(creep, sources, options);
}

function selectBestHarvestSource(
  creep: Creep,
  sources: Source[],
  options: HarvestSourceSelectionOptions = {}
): Source | null {
  if (sources.length === 0) {
    return null;
  }

  const harvestEnergyTarget = getHarvestEnergyTarget(creep);
  const viableSources = selectViableHarvestSources(sources, harvestEnergyTarget, creep, options);
  const assignmentLoads = getWorkerHarvestLoads(viableSources);
  const assignableSources = selectReachableHarvestSources(
    creep,
    selectAssignableHarvestSources(creep, viableSources, assignmentLoads, options)
  );
  if (assignableSources.length === 0) {
    return null;
  }

  const sourceLoads = assignableSources.map((source) =>
    createHarvestSourceLoad(source, getHarvestSourceAssignmentLoad(assignmentLoads, source))
  );
  let selectedLoad = sourceLoads[0];

  for (const sourceLoad of sourceLoads.slice(1)) {
    if (compareHarvestSourceLoads(creep, sourceLoad, selectedLoad, harvestEnergyTarget, options) < 0) {
      selectedLoad = sourceLoad;
    }
  }

  return selectedLoad.source;
}

function selectAssignableHarvestSources(
  creep: Creep,
  sources: Source[],
  assignmentLoads: Map<Id<Source>, HarvestSourceAssignmentLoad>,
  options: HarvestSourceSelectionOptions = {}
): Source[] {
  return sources.filter((source) =>
    isAssignableHarvestSource(creep, source, getHarvestSourceAssignmentLoad(assignmentLoads, source), options)
  );
}

function selectReachableHarvestSources(creep: Creep, sources: Source[]): Source[] {
  if (!isPathFinderAvailable()) {
    return sources;
  }

  return sources.filter((source) => getHarvestSourceTravelCost(creep, source) !== null);
}

function isAssignableHarvestSource(
  creep: Creep,
  source: Source,
  assignmentLoad: HarvestSourceAssignmentLoad,
  options: HarvestSourceSelectionOptions = {}
): boolean {
  if (options.ignoreHarvestAssignments === true) {
    return true;
  }

  if (isWorkerPreHarvestSource(source)) {
    if (isWorkerAssignedToHarvestSource(creep, source)) {
      return true;
    }

    if (assignmentLoad.assignmentCount >= MAX_WORKER_PRE_HARVEST_WAITERS_PER_SOURCE) {
      return false;
    }
  }

  if (!findVisibleSourceContainer(creep, source)) {
    return true;
  }

  if (isWorkerAssignedToHarvestSource(creep, source)) {
    return true;
  }

  return assignmentLoad.assignmentCount === 0;
}

function isWorkerAssignedToHarvestSource(creep: Creep, source: Source): boolean {
  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return task?.type === 'harvest' && String(task.targetId) === String(source.id);
}

function compareHarvestSourceLoads(
  creep: Creep,
  left: HarvestSourceLoad,
  right: HarvestSourceLoad,
  harvestEnergyTarget = getHarvestEnergyTarget(creep),
  options: HarvestSourceSelectionOptions = {}
): number {
  const availabilityPriorityComparison = compareHarvestSourceAvailabilityPriority(
    creep,
    left.source,
    right.source,
    harvestEnergyTarget,
    options
  );
  if (availabilityPriorityComparison !== 0) {
    return availabilityPriorityComparison;
  }

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
  return { assignedWorkParts: 0, assignmentCount: 0, hasContainerAssignment: false };
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
  const candidateRange = getHarvestSourceTravelCost(creep, candidate);
  const selectedRange = getHarvestSourceTravelCost(creep, selected);
  return candidateRange !== null && selectedRange !== null && candidateRange < selectedRange;
}

function getHarvestSourceTravelCost(creep: Creep, source: Source): number | null {
  const target = findVisibleSourceContainer(creep, source) ?? source;
  const targetRange = target === source ? HARVEST_SOURCE_RANGE : HARVEST_SOURCE_CONTAINER_RANGE;
  return estimateRoadAwareTravelCostBetweenRoomObjects(creep, target, targetRange);
}

function getHarvestSourceDeliveryTravelCost(
  creep: Creep,
  source: Source,
  energySink: FillableEnergySink
): number | null {
  const harvestOrigin = findVisibleSourceContainer(creep, source) ?? source;
  return estimateRoadAwareTravelCostBetweenRoomObjects(harvestOrigin, energySink, HARVEST_SOURCE_RANGE);
}

function estimateRoadAwareTravelCostBetweenRoomObjects(
  origin: RoomObject,
  target: RoomObject,
  targetRange: number
): number | null {
  const originPosition = getRoomObjectPosition(origin);
  const targetPosition = getRoomObjectPosition(target);
  if (originPosition && targetPosition) {
    const pathCost = findRoadAwarePathCost(originPosition, targetPosition, targetRange);
    if (pathCost !== null) {
      return pathCost;
    }

    if (isPathFinderAvailable()) {
      return null;
    }
  }

  const range = getRangeBetweenRoomObjects(origin, target);
  if (range !== null) {
    return Math.max(0, range - Math.max(0, targetRange - 1));
  }

  if (originPosition && targetPosition && isSameRoomPosition(originPosition, targetPosition)) {
    return Math.max(
      0,
      Math.max(Math.abs(originPosition.x - targetPosition.x), Math.abs(originPosition.y - targetPosition.y)) -
        Math.max(0, targetRange - 1)
    );
  }

  return null;
}

function findRoadAwarePathCost(
  origin: RoomPosition,
  target: RoomPosition,
  targetRange: number
): number | null {
  if (!isPathFinderAvailable()) {
    return null;
  }

  const result = PathFinder.search(origin, { pos: target, range: Math.max(0, targetRange) }, {
    maxOps: MAX_HARVEST_PATH_OPS,
    maxRooms: origin.roomName === target.roomName ? 1 : 2,
    plainCost: PLAIN_TRAVEL_COST,
    roomCallback: createRoadAwareRoomCallback(new Set([origin.roomName, target.roomName])),
    swampCost: SWAMP_TRAVEL_COST
  });

  if (result.incomplete) {
    return null;
  }

  if (typeof result.cost === 'number' && Number.isFinite(result.cost)) {
    return Math.max(0, result.cost);
  }

  return Array.isArray(result.path) ? result.path.length : null;
}

function isPathFinderAvailable(): boolean {
  return typeof PathFinder !== 'undefined' && typeof PathFinder.search === 'function' && typeof PathFinder.CostMatrix === 'function';
}

function createRoadAwareRoomCallback(allowedRoomNames: Set<string>): (roomName: string) => boolean | CostMatrix {
  const matricesByRoomName = new Map<string, CostMatrix | false>();
  return (roomName: string): boolean | CostMatrix => {
    if (!allowedRoomNames.has(roomName)) {
      return false;
    }

    const cachedMatrix = matricesByRoomName.get(roomName);
    if (cachedMatrix !== undefined) {
      return cachedMatrix;
    }

    const room = (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
    if (!room || typeof FIND_STRUCTURES !== 'number' || typeof room.find !== 'function') {
      matricesByRoomName.set(roomName, false);
      return false;
    }

    const matrix = new PathFinder.CostMatrix();
    for (const structure of room.find(FIND_STRUCTURES) as Structure[]) {
      const position = getRoomObjectPosition(structure);
      if (!position) {
        continue;
      }

      if (isRoadStructure(structure)) {
        matrix.set(position.x, position.y, ROAD_TRAVEL_COST);
      } else if (isBlockingRoadAwareStructure(structure)) {
        matrix.set(position.x, position.y, 0xff);
      }
    }

    matricesByRoomName.set(roomName, matrix);
    return matrix;
  };
}

function isRoadStructure(structure: Structure): structure is StructureRoad {
  return matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road');
}

function isBlockingRoadAwareStructure(structure: Structure): boolean {
  return !isRoadStructure(structure) && !isContainerStructure(structure) && !isWalkableRampartStructure(structure);
}

function isContainerStructure(structure: Structure): structure is StructureContainer {
  return matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container');
}

function isWalkableRampartStructure(structure: Structure): boolean {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') &&
    ((structure as Partial<StructureRampart>).my === true || (structure as Partial<StructureRampart>).isPublic === true)
  );
}

function selectViableHarvestSources(
  sources: Source[],
  harvestEnergyTarget: number,
  creep: Creep,
  options: HarvestSourceSelectionOptions = {}
): Source[] {
  return sources.filter((source) =>
    getHarvestSourceAvailabilityPriority(creep, source, harvestEnergyTarget, options) <
    getFullyDepletedHarvestSourcePriority()
  );
}

export function isWorkerPreHarvestSource(source: Source): boolean {
  if (source.energy !== 0) {
    return false;
  }

  const ticksToRegeneration = getHarvestSourceRegenerationDelay(source);
  return (
    ticksToRegeneration !== null &&
    ticksToRegeneration <= WORKER_PRE_HARVEST_REGEN_THRESHOLD
  );
}

function compareHarvestSourceAvailabilityPriority(
  creep: Creep,
  left: Source,
  right: Source,
  harvestEnergyTarget: number,
  options: HarvestSourceSelectionOptions
): number {
  return (
    getHarvestSourceAvailabilityPriority(creep, left, harvestEnergyTarget, options) -
    getHarvestSourceAvailabilityPriority(creep, right, harvestEnergyTarget, options)
  );
}

function getHarvestSourceAvailabilityPriority(
  creep: Creep,
  source: Source,
  harvestEnergyTarget: number,
  options: HarvestSourceSelectionOptions
): number {
  const preHarvestAllowed = isWorkerPreHarvestAllowed(creep, options);
  const preHarvestSource = preHarvestAllowed && isWorkerPreHarvestSource(source);
  if (preHarvestSource) {
    return 0;
  }

  const availableEnergy = getHarvestSourceAvailableEnergy(source);
  if (availableEnergy <= 0) {
    return getFullyDepletedHarvestSourcePriority();
  }

  const targetEnergy = Math.max(1, Math.ceil(harvestEnergyTarget));
  return availableEnergy >= targetEnergy ? 1 : 2;
}

function getFullyDepletedHarvestSourcePriority(): number {
  return 3;
}

function isWorkerPreHarvestAllowed(creep: Creep, options: HarvestSourceSelectionOptions): boolean {
  return options.allowPreHarvest !== false && !isWorkerPreHarvestSuppressedByCriticalEnergy(creep);
}

function isWorkerPreHarvestSuppressedByCriticalEnergy(creep: Creep): boolean {
  if (creep.memory?.workerEnergyCriticalPolicy?.active === true) {
    return true;
  }

  return isRoomSpawnEnergyCriticalNow(creep.room) || isRoomStorageEnergyCriticalNow(creep.room);
}

function isRoomSpawnEnergyCriticalNow(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  return energyAvailable !== null && energyAvailable < CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD;
}

function isRoomStorageEnergyCriticalNow(room: Room): boolean {
  const storage = (room as Room & { storage?: StructureStorage }).storage;
  if (!storage || !matchesStructureType(storage.structureType, 'STRUCTURE_STORAGE', 'storage')) {
    return false;
  }

  const enterThreshold = getStorageEnergyReserveThreshold(room);
  return enterThreshold > 0 && getStoredEnergy(storage) < enterThreshold;
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

function getWorkerHarvestLoads(sources: Source[]): Map<Id<Source>, HarvestSourceAssignmentLoad> {
  const assignmentLoads = new Map<Id<Source>, HarvestSourceAssignmentLoad>();
  for (const source of sources) {
    assignmentLoads.set(source.id, createEmptyHarvestSourceAssignmentLoad());
  }

  const sourceIds = new Set(sources.map((source) => source.id as string));
  for (const assignedCreep of getGameCreeps()) {
    const task = assignedCreep.memory?.task as Partial<CreepTaskMemory> | undefined;
    const targetId = typeof task?.targetId === 'string' ? task.targetId : undefined;

    const sourceHarvesterTargetId =
      assignedCreep.memory?.role === SOURCE_HARVESTER_ROLE &&
      typeof assignedCreep.memory.sourceHarvester?.sourceId === 'string'
        ? assignedCreep.memory.sourceHarvester.sourceId
        : undefined;
    const assignedSourceId =
      assignedCreep.memory?.role === 'worker' &&
      task?.type === 'harvest' &&
      targetId &&
      sourceIds.has(targetId)
        ? targetId
        : sourceHarvesterTargetId;
    if (!assignedSourceId || !sourceIds.has(assignedSourceId)) {
      continue;
    }

    const sourceId = assignedSourceId as Id<Source>;
    const currentLoad = assignmentLoads.get(sourceId) ?? createEmptyHarvestSourceAssignmentLoad();
    assignmentLoads.set(sourceId, {
      assignedWorkParts: currentLoad.assignedWorkParts + getActiveWorkParts(assignedCreep),
      assignmentCount: currentLoad.assignmentCount + 1,
      hasContainerAssignment:
        currentLoad.hasContainerAssignment ||
        assignedCreep.memory?.role === SOURCE_HARVESTER_ROLE ||
        isSourceContainerHarvestAssignment(task)
    });
  }

  return assignmentLoads;
}

function isSourceContainerHarvestAssignment(task: Partial<CreepTaskMemory> | undefined): boolean {
  return (
    task?.type === 'harvest' &&
    (task as Partial<Extract<CreepTaskMemory, { type: 'harvest' }>>).sourceContainerAssigned === true
  );
}

function getGameCreeps(): Creep[] {
  const game = getGameReference();
  const creeps = game?.creeps;
  const gameTick = getGameTick();
  if (
    gameCreepsCache &&
    gameCreepsCache.game === game &&
    gameCreepsCache.creepsRecord === creeps &&
    gameCreepsCache.tick === gameTick
  ) {
    return gameCreepsCache.creeps;
  }

  gameCreepsCache = {
    creeps: creeps ? Object.values(creeps) : [],
    creepsRecord: creeps,
    game,
    tick: gameTick
  };
  return gameCreepsCache.creeps;
}
