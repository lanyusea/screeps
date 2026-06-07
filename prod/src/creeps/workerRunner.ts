import {
  CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO,
  CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
  CRITICAL_SPAWN_REPAIR_HITS_RATIO,
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  EMERGENCY_RAMPART_REPAIR_HITS_CEILING,
  MINIMUM_USEFUL_LOAD_RATIO,
  selectWorkerPreHarvestTask,
  isUpgraderBoostActive,
  isWorkerRepairTargetComplete,
  selectWorkerTask,
  canSpendWorkerEnergyOnConstructionSite,
  shouldSwitchLowLoadWorkerEnergyAcquisitionTaskForYield,
  shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill
} from '../tasks/workerTasks';
import {
  assessWorkerEnergyCriticalState,
  selectWorkerEnergyCriticalTask,
  shouldPreemptForWorkerEnergyCriticalTask
} from './workerTaskPolicy';
import { runUpgrader } from './upgraderRunner';
import { canCreepPressureTerritoryController } from '../territory/territoryPlanner';
import {
  CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY,
  getEffectiveRoomEnergyBufferThreshold,
  getRoomStoredEnergyAvailableForConstruction,
  MINIMUM_WORKER_SPAWN_ENERGY
} from '../economy/energyBuffer';
import { getSafeWorkerWithdrawEnergyAmount } from '../economy/workerConstructionWithdrawBudget';
import {
  selectSpawnEnergyReservationRefillTarget,
  type SpawnEnergyReservationRefillTarget
} from '../economy/spawnEnergyReservation';
import { BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING } from '../defense/defensePlanner';
import { findSourceContainer } from '../economy/sourceContainers';
import {
  isDurableEnergyDropoff,
  selectEnergyDropoffOptimizationTask
} from './energyDropoffOptimizer';
import {
  OCCUPIED_CONTROLLER_SIGN_TEXT,
  shouldSignControllerForCreep
} from '../territory/controllerSigning';
import {
  observeCreepBehaviorTick,
  recordCreepBehaviorContainerTransfer,
  recordCreepBehaviorEnergyAcquisition,
  recordCreepBehaviorIdle,
  recordCreepBehaviorMove,
  recordCreepBehaviorMoveTask,
  recordCreepBehaviorMoveToResult,
  recordCreepBehaviorRepairTarget,
  recordCreepBehaviorSourceContainerWithdrawal,
  recordCreepBehaviorWork,
  type RuntimeEnergyAcquisitionMethod
} from '../telemetry/behaviorTelemetry';
import { getRuntimeCpuBudget, isRuntimeCpuBucketLow, shouldShedNonessentialCpuWork } from '../runtime/cpuBudget';
import { isColonyRoomThreatened } from '../defense/colonyThreats';

type TransferSinkStructureConstantGlobal =
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_LINK'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_TOWER';
type ConstructionStructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_TOWER'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_ROAD';

const MAX_IMMEDIATE_RESELECT_EXECUTIONS = 1;
const WORKER_NULL_LOOP_TICK_WINDOW = 10;
const WORKER_STANDBY_IDLE_TIMEOUT_TICKS = 8;
const WORKER_NULL_LOOP_FALLBACK_ATTEMPTS = 2;
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ADJACENT_ACTION_MOVE_RANGE = 1;
const RANGED_WORK_MOVE_RANGE = 3;
const EXACT_POSITION_MOVE_RANGE = 0;
const BUILD_TARGET_STUCK_TICKS = 2;
const BUILD_TARGET_SUPPRESSION_TICKS = 15;
const DEFAULT_BUILD_POWER = 5;
const MIN_HAULER_DROPPED_ENERGY = 25;
const SPAWN_RESERVATION_PRODUCTIVE_WORK_MIN_WORKERS = 2;
const SPAWN_RESERVATION_PRODUCTIVE_WORK_MIN_STORED_SURPLUS = 300;

interface WorkerTaskSelectionNullLoopState {
  lastNullSelectionTick: number;
  nullSelectionCount: number;
  fallbackAttempts: number;
  idleStartTick: number;
}

interface TaskExecutionResult {
  result: ScreepsReturnCode;
  action?: 'move' | 'work';
  attemptedMoveTo?: boolean;
  containerTransfer?: boolean;
  energyAcquisitionMethod?: RuntimeEnergyAcquisitionMethod;
  sourceContainerWithdrawal?: boolean;
}

type MoveToResult = ReturnType<Creep['moveTo']>;

interface WorkerTaskSelectionContext {
  baseSelectedTask: CreepTaskMemory | null;
  energyCriticalTask: CreepTaskMemory | null;
  selectedTask: CreepTaskMemory | null;
  spawnReservationRefillTask: CreepTaskMemory | null;
}

interface CriticalCpuTaskRetentionDecision {
  retain: boolean;
  forceSelectedTask?: boolean;
  repairPreemptionTask?: Extract<CreepTaskMemory, { type: 'repair' }>;
  retainedTask?: CreepTaskMemory;
  selectionContext?: WorkerTaskSelectionContext;
}

type ScoreTaskTarget = RoomObject & _HasId;
type WorkerTaskTarget =
  | Source
  | Resource<ResourceConstant>
  | AnyStoreStructure
  | ConstructionSite
  | StructureController
  | Structure
  | ScoreTaskTarget;

export function runWorker(creep: Creep): void {
  if (runControllerSustainMovement(creep)) {
    return;
  }
  if (runSpawnSupportMovement(creep)) {
    return;
  }
  observeCreepBehaviorTick(creep);
  suppressCurrentBuildTargetIfWorkerIsStuck(creep);

  const currentTask = creep.memory.task;
  const criticalCpuTaskRetention = getCriticalCpuTaskRetentionDecision(creep, currentTask);
  if (criticalCpuTaskRetention.retain) {
    executeAssignedTask(creep, criticalCpuTaskRetention.retainedTask ?? null);
    return;
  }

  const initialSelectionContext =
    criticalCpuTaskRetention.selectionContext ?? selectWorkerTaskContext(creep, currentTask);
  const selectionContext = applyWorkerAssignmentGapRecoveryTask(
    creep,
    currentTask,
    initialSelectionContext
  );
  const { baseSelectedTask, energyCriticalTask, selectedTask, spawnReservationRefillTask } =
    selectionContext;
  let taskAssignedThisTick = false;

  if (!currentTask) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask) !== null;
  } else if (shouldReplaceTask(creep, currentTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldRetainAssignedEnergyDropoffOptimization(creep, currentTask, selectedTask)) {
    // Keep the optimized side task until it completes or a higher-priority selector result appears.
  } else if (shouldPreemptForVisibleTerritoryControllerTask(currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptForWorkerEnergyCriticalTask(currentTask, energyCriticalTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (criticalCpuTaskRetention.forceSelectedTask) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (
    shouldPreemptRepairTaskForCriticalCpuRepairPreemption(
      currentTask,
      criticalCpuTaskRetention.repairPreemptionTask
    )
  ) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptRepairTaskForSeasonScore(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptRepairTaskForConstructionBacklog(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPauseOptionalTaskForCriticalCpu(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptControllerSigningForRecovery(currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptForControllerSigning(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptEnergyAcquisitionTaskForSpawnReservationRefill(currentTask, spawnReservationRefillTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptEnergyAcquisitionTaskForNearFullConstruction(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptEnergyAcquisitionTaskForProductiveBacklog(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptEnergyAcquisitionTaskForUrgentEnergySpending(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptTaskForUrgentRepair(currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptEnergyAcquisitionTaskForSeasonScore(currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptSeasonScoreTask(currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptTaskForUpgraderBoost(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptEnergyAcquisitionTaskForNearbyEnergyChoice(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptLowLoadReturnTaskForEnergyAcquisition(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptTransferTaskForControllerDowngradeGuard(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptTransferTaskForConstructionBacklog(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptTransferTaskForBetterEnergySink(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptSpendingTaskForNearTermSpawnExtensionRefill(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptSpendingTaskForEnergySink(currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptSpendingTaskForControllerPressure(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  } else if (shouldPreemptUpgradeTask(creep, currentTask, selectedTask)) {
    taskAssignedThisTick = assignSelectedTask(creep, selectedTask, currentTask) !== null;
  }

  if (taskAssignedThisTick || isAssignedEnergyDropoffOptimizationTask(creep, creep.memory.task)) {
    optimizeAssignedEnergyDropoffTask(creep);
  }
  recordWorkerDispatchDiagnostic(creep, {
    baseSelectedTask,
    currentTask,
    energyCriticalTask,
    selectedTask,
    spawnReservationRefillTask,
    taskAssignedThisTick
  });
  executeAssignedTask(creep, selectedTask);
}

interface WorkerDispatchDiagnosticContext {
  baseSelectedTask: CreepTaskMemory | null;
  currentTask: CreepTaskMemory | null | undefined;
  energyCriticalTask: CreepTaskMemory | null;
  selectedTask: CreepTaskMemory | null;
  spawnReservationRefillTask: CreepTaskMemory | null;
  taskAssignedThisTick: boolean;
}

function recordWorkerDispatchDiagnostic(
  creep: Creep,
  context: WorkerDispatchDiagnosticContext
): void {
  if (isRuntimeCpuBucketLow()) {
    return;
  }

  const memory = creep.memory;
  if (!memory) {
    return;
  }

  const assignedTask = memory.task;
  const diagnostic: WorkerDispatchDiagnosticMemory = {
    tick: getGameTick(),
    reason: selectWorkerDispatchDiagnosticReason(creep, context, assignedTask),
    carriedEnergy: getUsedTransferEnergy(creep),
    freeCapacity: getFreeTransferEnergyCapacity(creep),
    ...formatDiagnosticTask('current', context.currentTask),
    ...formatDiagnosticTask('selected', context.selectedTask),
    ...formatDiagnosticTask('baseSelected', context.baseSelectedTask),
    ...formatDiagnosticTask('energyCritical', context.energyCriticalTask),
    ...formatDiagnosticTask('spawnReservation', context.spawnReservationRefillTask),
    ...formatDiagnosticTask('assigned', assignedTask)
  };

  memory.workerDispatchDiagnostic = diagnostic;
}

function selectWorkerDispatchDiagnosticReason(
  creep: Creep,
  context: WorkerDispatchDiagnosticContext,
  assignedTask: CreepTaskMemory | undefined
): WorkerDispatchDiagnosticReason {
  const currentTask = context.currentTask ?? null;
  const selectedTask = context.selectedTask;

  if (context.taskAssignedThisTick) {
    if (!currentTask) {
      return 'assigned_selected_task';
    }

    if (isSameOptionalTask(selectedTask, context.spawnReservationRefillTask)) {
      return 'preempted_for_spawn_reservation_refill';
    }

    if (isSameOptionalTask(selectedTask, context.energyCriticalTask)) {
      return 'preempted_for_energy_critical';
    }

    if (isTerritoryControlTask(selectedTask)) {
      return 'preempted_for_territory';
    }

    if (selectedTask?.type === 'collectScore') {
      return 'preempted_for_season_score';
    }

    if (selectedTask?.type === 'signController') {
      return 'preempted_for_controller_signing';
    }

    if (currentTask.type === 'upgrade' && (selectedTask?.type === 'build' || selectedTask?.type === 'repair')) {
      return 'preempted_for_productive_backlog';
    }

    if (isEnergyAcquisitionTask(currentTask) && selectedTask?.type === 'transfer') {
      return 'preempted_for_spawn_recovery';
    }

    if (isEnergyAcquisitionTask(currentTask) && selectedTask && isEnergySpendingTask(selectedTask)) {
      return 'preempted_for_urgent_spending';
    }

    if (isEnergyAcquisitionTask(currentTask) && selectedTask && isEnergyAcquisitionTask(selectedTask)) {
      return 'preempted_for_nearby_energy';
    }

    if (currentTask.type === 'transfer' && selectedTask?.type === 'upgrade') {
      return 'preempted_for_controller_progress';
    }

    if (selectedTask?.type === 'upgrade') {
      return 'preempted_for_upgrader_boost';
    }

    return 'preempted_for_new_task';
  }

  if (!selectedTask) {
    return currentTask ? 'selected_null_retained_current_task' : 'no_selected_task_idle';
  }

  if (!currentTask) {
    return assignedTask ? 'assigned_selected_task' : 'unreachable_state_task_not_assigned';
  }

  if (isSameTask(currentTask, selectedTask)) {
    return 'selected_same_as_current';
  }

  if (isEnergyAcquisitionTask(currentTask)) {
    if (isDedicatedSourceContainerHarvestTask(creep, currentTask)) {
      return 'retained_dedicated_source_container_harvest';
    }

    return hasLowWorkerEnergyLoad(creep)
      ? 'retained_low_load_energy_acquisition'
      : 'retained_energy_acquisition_until_full';
  }

  if (currentTask.type === 'transfer') {
    return 'retained_transfer_task';
  }

  if (currentTask.type === 'build') {
    return 'retained_build_task';
  }

  if (currentTask.type === 'repair') {
    return 'retained_repair_task';
  }

  if (currentTask.type === 'upgrade') {
    return 'retained_upgrade_task';
  }

  return 'retained_current_task';
}

function isSameOptionalTask(
  left: CreepTaskMemory | null,
  right: CreepTaskMemory | null
): boolean {
  return left !== null && right !== null && isSameTask(left, right);
}

function formatDiagnosticTask(
  prefix: 'assigned' | 'baseSelected' | 'current' | 'energyCritical' | 'selected' | 'spawnReservation',
  task: CreepTaskMemory | null | undefined
): Partial<WorkerDispatchDiagnosticMemory> {
  if (!task) {
    return {};
  }

  switch (prefix) {
    case 'assigned':
      return { assignedTask: task.type, assignedTargetId: String(task.targetId) };
    case 'baseSelected':
      return { baseSelectedTask: task.type, baseSelectedTargetId: String(task.targetId) };
    case 'current':
      return { currentTask: task.type, currentTargetId: String(task.targetId) };
    case 'energyCritical':
      return { energyCriticalTask: task.type, energyCriticalTargetId: String(task.targetId) };
    case 'selected':
      return { selectedTask: task.type, selectedTargetId: String(task.targetId) };
    case 'spawnReservation':
      return { spawnReservationTask: task.type, spawnReservationTargetId: String(task.targetId) };
  }
}

function getGameTick(): number {
  const gameTime = (globalThis as unknown as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? Math.max(0, Math.floor(gameTime)) : 0;
}

function selectWorkerTaskForRunner(creep: Creep): CreepTaskMemory | null {
  const selectedTask = selectWorkerTask(creep);
  return fallbackToEnergyOnNullSelectionLoop(creep, selectedTask);
}

function selectWorkerTaskContext(
  creep: Creep,
  currentTask: CreepTaskMemory | null | undefined
): WorkerTaskSelectionContext {
  const baseSelectedTask = selectWorkerTaskForRunner(creep);
  const energyCriticalTask = selectWorkerEnergyCriticalTask(creep, currentTask, baseSelectedTask);
  const effectiveEnergyCriticalTask = shouldYieldStorageCriticalAcquisitionToNearFullConstruction(
    creep,
    energyCriticalTask,
    baseSelectedTask
  )
    ? null
    : energyCriticalTask;
  const spawnReservationRefillTask = selectSpawnEnergyReservationRefillTask(
    creep,
    currentTask,
    effectiveEnergyCriticalTask ?? baseSelectedTask
  );
  const selectedTask = spawnReservationRefillTask ?? effectiveEnergyCriticalTask ?? baseSelectedTask;
  return {
    baseSelectedTask,
    energyCriticalTask: effectiveEnergyCriticalTask,
    selectedTask,
    spawnReservationRefillTask
  };
}

function applyWorkerAssignmentGapRecoveryTask(
  creep: Creep,
  currentTask: CreepTaskMemory | null | undefined,
  selectionContext: WorkerTaskSelectionContext
): WorkerTaskSelectionContext {
  const recoveryTask = selectWorkerAssignmentGapRecoveryTask(creep, currentTask, selectionContext);
  return recoveryTask ? { ...selectionContext, selectedTask: recoveryTask } : selectionContext;
}

function selectWorkerAssignmentGapRecoveryTask(
  creep: Creep,
  currentTask: CreepTaskMemory | null | undefined,
  selectionContext: WorkerTaskSelectionContext
): Extract<CreepTaskMemory, { type: 'build' }> | null {
  if (!isWorkerAssignmentGapRecoverySelection(creep, currentTask, selectionContext.selectedTask)) {
    return null;
  }

  if (
    getUsedTransferEnergy(creep) <= 0 ||
    getActiveWorkParts(creep) <= 0 ||
    !hasMinimumProductiveWorkerCoverageForSpawnReservationYield(creep) ||
    hasVisibleHostileCreeps(creep.room) ||
    (currentTask && isDedicatedSourceContainerHarvestTask(creep, currentTask))
  ) {
    return null;
  }

  const constructionSite = selectWorkerAssignmentGapRecoveryConstructionSite(creep);
  if (!constructionSite) {
    return null;
  }

  const recoveryTask: Extract<CreepTaskMemory, { type: 'build' }> = {
    type: 'build',
    targetId: constructionSite.id
  };
  if (
    !canExecuteTask(creep, recoveryTask) ||
    isCriticalSpawnRefillTask(currentTask) ||
    isCriticalSpawnRefillTask(selectionContext.selectedTask) ||
    !shouldAllowAssignmentGapRecoveryBuildWorker(creep, currentTask, selectionContext.selectedTask, constructionSite) ||
    !hasSafeAssignmentGapRecoveryConstructionEnergy(creep, recoveryTask)
  ) {
    return null;
  }

  return recoveryTask;
}

function isWorkerAssignmentGapRecoverySelection(
  creep: Creep,
  currentTask: CreepTaskMemory | null | undefined,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!currentTask && !selectedTask) {
    return true;
  }

  const allowUpgradeRecovery = !isControllerDowngradeGuardActive(creep.room);
  return isWorkerAssignmentGapRecoveryTask(currentTask, allowUpgradeRecovery) &&
    isWorkerAssignmentGapRecoveryTask(selectedTask, allowUpgradeRecovery);
}

function isWorkerAssignmentGapRecoveryTask(
  task: CreepTaskMemory | null | undefined,
  allowUpgradeRecovery: boolean
): boolean {
  return (
    task === undefined ||
    task === null ||
    isEnergyAcquisitionTask(task) ||
    task.type === 'transfer' ||
    (allowUpgradeRecovery && task.type === 'upgrade')
  );
}

function selectWorkerAssignmentGapRecoveryConstructionSite(creep: Creep): ConstructionSite | null {
  if (typeof FIND_CONSTRUCTION_SITES !== 'number' || typeof creep.room?.find !== 'function') {
    return null;
  }

  const sites = creep.room.find(FIND_CONSTRUCTION_SITES) as ConstructionSite[];
  return (
    sites
      .filter((site) => site.my !== false)
      .filter((site) => !isBuildTargetSuppressedForWorker(creep, site))
      .filter((site) => canSpendWorkerEnergyOnConstructionSite(creep, site))
      .sort((left, right) => compareRoomObjectsByRangeAndId(creep, left, right))[0] ?? null
  );
}

function shouldAllowAssignmentGapRecoveryBuildWorker(
  creep: Creep,
  currentTask: CreepTaskMemory | null | undefined,
  selectedTask: CreepTaskMemory | null,
  constructionSite: ConstructionSite
): boolean {
  if (!hasOtherSameRoomBuildAssignment(creep)) {
    return true;
  }

  if (hasUncoveredAssignmentGapConstructionProgress(creep, constructionSite)) {
    return true;
  }

  return !currentTask && selectedTask === null && getFreeTransferEnergyCapacity(creep) <= 0;
}

function hasUncoveredAssignmentGapConstructionProgress(creep: Creep, constructionSite: ConstructionSite): boolean {
  const pendingProgress = getRoomConstructionPendingProgress(creep.room);
  if (pendingProgress === null) {
    return false;
  }

  const reservedProgress = getOtherSameRoomBuildAssignmentProgress(creep);
  if (reservedProgress <= 0) {
    return true;
  }

  const carriedProgress = getUsedTransferEnergy(creep) * getBuildPower();
  if (reservedProgress + carriedProgress < pendingProgress) {
    return true;
  }

  const selectedSiteRemainingProgress = getConstructionSiteRemainingProgress(constructionSite);
  const selectedSiteCanUseWorkerEnergy =
    selectedSiteRemainingProgress === null ||
    reservedProgress < selectedSiteRemainingProgress ||
    carriedProgress <= selectedSiteRemainingProgress;
  return selectedSiteCanUseWorkerEnergy && reservedProgress < pendingProgress;
}

function getOtherSameRoomBuildAssignmentProgress(creep: Creep): number {
  return getRoomOwnedCreeps(creep.room).reduce((total, worker) => {
    if (isSameCreep(worker, creep) || !isProductiveSameRoomWorker(worker, creep.room)) {
      return total;
    }

    const task = worker.memory?.task;
    if (task?.type !== 'build' || getActiveWorkParts(worker) <= 0) {
      return total;
    }

    const carriedEnergy = getUsedTransferEnergy(worker);
    if (carriedEnergy <= 0) {
      return total;
    }

    const target = getTaskTarget(task);
    if (!isConstructionSite(target) || target.my === false) {
      return total;
    }

    const remainingProgress = getConstructionSiteRemainingProgress(target);
    const carriedProgress = carriedEnergy * getBuildPower();
    return total + (remainingProgress === null ? carriedProgress : Math.min(remainingProgress, carriedProgress));
  }, 0);
}

function getRoomConstructionPendingProgress(room: Room): number | null {
  if (typeof FIND_CONSTRUCTION_SITES !== 'number' || typeof room?.find !== 'function') {
    return null;
  }

  const sites = room.find(FIND_CONSTRUCTION_SITES) as ConstructionSite[];
  if (sites.length === 0) {
    return 0;
  }

  return sites
    .filter((site) => site.my !== false)
    .reduce<number | null>((total, site) => {
      if (total === null) {
        return null;
      }

      const remainingProgress = getConstructionSiteRemainingProgress(site);
      return remainingProgress === null ? null : total + remainingProgress;
    }, 0);
}

function getConstructionSiteRemainingProgress(site: ConstructionSite): number | null {
  const progress = (site as ConstructionSite & { progress?: unknown }).progress;
  const progressTotal = (site as ConstructionSite & { progressTotal?: unknown }).progressTotal;
  if (
    typeof progress !== 'number' ||
    typeof progressTotal !== 'number' ||
    !Number.isFinite(progress) ||
    !Number.isFinite(progressTotal)
  ) {
    return null;
  }

  return Math.max(0, Math.ceil(progressTotal - progress));
}

function isConstructionSite(target: unknown): target is ConstructionSite {
  return (
    typeof target === 'object' &&
    target !== null &&
    typeof (target as Partial<ConstructionSite>).structureType === 'string'
  );
}

function getBuildPower(): number {
  const buildPower = (globalThis as { BUILD_POWER?: unknown }).BUILD_POWER;
  return typeof buildPower === 'number' && Number.isFinite(buildPower) && buildPower > 0
    ? buildPower
    : DEFAULT_BUILD_POWER;
}

function hasSafeAssignmentGapRecoveryConstructionEnergy(
  creep: Creep,
  recoveryTask: Extract<CreepTaskMemory, { type: 'build' }>
): boolean {
  const spawnReservationTarget = selectSpawnEnergyReservationRefillTarget(creep);
  if (spawnReservationTarget) {
    return shouldDeferSpawnReservationRefillForProductiveWork(creep, recoveryTask, spawnReservationTarget);
  }

  return (
    !hasActiveSpawningSpawn(creep.room) &&
    (hasHealthyRoomEnergyBuffer(creep.room) || hasStoredEnergyForAssignmentGapRecoveryConstruction(creep.room))
  );
}

function hasStoredEnergyForAssignmentGapRecoveryConstruction(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  return (
    energyAvailable !== null &&
    energyAvailable >= MINIMUM_WORKER_SPAWN_ENERGY &&
    getRoomStoredEnergyAvailableForConstruction(room) >= CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY
  );
}

function isCriticalSpawnRefillTask(task: CreepTaskMemory | null | undefined): boolean {
  return task?.type === 'transfer' && getTransferSinkPriority(getTaskTarget(task)) >= 3;
}

function isBuildTargetSuppressedForWorker(creep: Creep, site: ConstructionSite): boolean {
  const blockedBuildTarget = creep.memory?.blockedBuildTarget;
  if (!blockedBuildTarget) {
    return false;
  }

  const tick = getGameTick();
  if (blockedBuildTarget.until <= tick) {
    delete creep.memory.blockedBuildTarget;
    return false;
  }

  return String(blockedBuildTarget.targetId) === String(site.id);
}

function hasVisibleHostileCreeps(room: Room): boolean {
  const findHostileCreeps = (globalThis as unknown as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
  if (typeof findHostileCreeps !== 'number' || typeof room?.find !== 'function') {
    return false;
  }

  try {
    const findRoomObjects = room.find as unknown as (type: number) => unknown[];
    return findRoomObjects(findHostileCreeps).length > 0;
  } catch {
    return false;
  }
}

function getCriticalCpuTaskRetentionDecision(
  creep: Creep,
  task: CreepTaskMemory | null | undefined
): CriticalCpuTaskRetentionDecision {
  if (!getRuntimeCpuBudget().critical || !task || !canExecuteTask(creep, task)) {
    return { retain: false };
  }

  if (isEnergyAcquisitionTask(task)) {
    return { retain: getFreeTransferEnergyCapacity(creep) > 0 && getUsedTransferEnergy(creep) <= 0 };
  }

  if (task.type === 'transfer') {
    return getCriticalCpuTransferRetentionDecision(creep, task);
  }

  if (isTerritoryControlTask(task)) {
    return getCriticalCpuTerritoryControlRetentionDecision(creep, task);
  }

  if (task.type === 'repair') {
    return getCriticalCpuRepairRetentionDecision(creep, task);
  }

  return { retain: false };
}

function getCriticalCpuRepairRetentionDecision(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'repair' }>
): CriticalCpuTaskRetentionDecision {
  if (!shouldRetainCriticalCpuRepairTask(creep)) {
    return { retain: false };
  }

  const preemptionTarget = selectCriticalCpuRepairPreemptionTarget(creep);
  if (preemptionTarget !== null) {
    const repairPreemptionTask: Extract<CreepTaskMemory, { type: 'repair' }> = {
      type: 'repair',
      targetId: preemptionTarget.id as Id<Structure>
    };
    const selectionContext = selectWorkerTaskContext(creep, task);
    if (!isSameOptionalTask(selectionContext.selectedTask, repairPreemptionTask)) {
      if (shouldCriticalCpuSelectedTaskPreemptRepairRetention(selectionContext.selectedTask)) {
        return {
          retain: false,
          forceSelectedTask: true,
          selectionContext
        };
      }

      if (String(preemptionTarget.id) === String(task.targetId)) {
        return { retain: true };
      }

      return {
        retain: false,
        repairPreemptionTask,
        selectionContext: createSingleTaskSelectionContext(repairPreemptionTask)
      };
    }

    if (String(preemptionTarget.id) === String(task.targetId)) {
      return { retain: true };
    }

    return {
      retain: false,
      repairPreemptionTask,
      selectionContext
    };
  }

  return { retain: true };
}

function createSingleTaskSelectionContext(task: CreepTaskMemory): WorkerTaskSelectionContext {
  return {
    baseSelectedTask: task,
    energyCriticalTask: null,
    selectedTask: task,
    spawnReservationRefillTask: null
  };
}

function shouldCriticalCpuSelectedTaskPreemptRepairRetention(selectedTask: CreepTaskMemory | null): boolean {
  return selectedTask?.type === 'build' && isSpawnConstructionTaskTarget(getTaskTarget(selectedTask));
}

function shouldRetainCriticalCpuRepairTask(creep: Creep): boolean {
  return (
    getUsedTransferEnergy(creep) > 0 &&
    !assessWorkerEnergyCriticalState(creep).active &&
    !isControllerDowngradeGuardActive(creep.room) &&
    !shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)
  );
}

function shouldPreemptRepairTaskForCriticalCpuRepairPreemption(
  task: CreepTaskMemory,
  repairPreemptionTask: Extract<CreepTaskMemory, { type: 'repair' }> | undefined
): boolean {
  return (
    task.type === 'repair' &&
    repairPreemptionTask !== undefined &&
    !isSameTask(task, repairPreemptionTask)
  );
}

function shouldPreemptRepairTaskForSeasonScore(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (task.type !== 'repair' || selectedTask?.type !== 'collectScore' || isSameTask(task, selectedTask)) {
    return false;
  }

  return !isProtectedRepairTargetForConstructionBacklog(creep, getTaskTarget(task));
}

function shouldPreemptRepairTaskForConstructionBacklog(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (task.type !== 'repair' || selectedTask?.type !== 'build' || isSameTask(task, selectedTask)) {
    return false;
  }

  return !isProtectedRepairTargetForConstructionBacklog(creep, getTaskTarget(task));
}

function isProtectedRepairTargetForConstructionBacklog(creep: Creep, target: unknown): boolean {
  if (!isRepairPreemptionStructure(target) || isWorkerRepairTargetComplete(target)) {
    return false;
  }

  if (isBuildPreemptionCriticalSpawnRepairTarget(target)) {
    return true;
  }

  if (isBuildPreemptionBarrierRepairTarget(target)) {
    if (isBuildPreemptionOwnedRampart(target) && target.hits <= EMERGENCY_RAMPART_REPAIR_HITS_CEILING) {
      return true;
    }

    if (target.hits <= BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING) {
      return true;
    }

    return isRoomThreatened(creep);
  }

  return (
    isBuildPreemptionCriticalRoadOrContainerRepairTarget(target) &&
    !hasOtherSameRoomRepairAssignmentForTarget(creep, target)
  );
}

function isRepairPreemptionStructure(target: unknown): target is Structure {
  const structure = target as Partial<Structure> | null;
  return (
    typeof structure?.structureType === 'string' &&
    typeof structure.hits === 'number' &&
    typeof structure.hitsMax === 'number'
  );
}

function isBuildPreemptionCriticalSpawnRepairTarget(structure: Structure): boolean {
  return (
    isBuildPreemptionRepairStructureType(structure, 'STRUCTURE_SPAWN', 'spawn') &&
    (structure as Partial<StructureSpawn>).my !== false &&
    getCriticalCpuRepairHitsRatio(structure) <= CRITICAL_SPAWN_REPAIR_HITS_RATIO
  );
}

function isBuildPreemptionBarrierRepairTarget(structure: Structure): structure is StructureRampart | StructureWall {
  return (
    isBuildPreemptionOwnedRampart(structure) ||
    isBuildPreemptionRepairStructureType(structure, 'STRUCTURE_WALL', 'constructedWall')
  );
}

function isBuildPreemptionOwnedRampart(structure: Structure): structure is StructureRampart {
  return (
    isBuildPreemptionRepairStructureType(structure, 'STRUCTURE_RAMPART', 'rampart') &&
    (structure as Partial<StructureRampart>).my !== false
  );
}

function isBuildPreemptionCriticalRoadOrContainerRepairTarget(structure: Structure): boolean {
  return (
    (isBuildPreemptionRepairStructureType(structure, 'STRUCTURE_ROAD', 'road') ||
      isBuildPreemptionRepairStructureType(structure, 'STRUCTURE_CONTAINER', 'container')) &&
    getCriticalCpuRepairHitsRatio(structure) <= CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO
  );
}

function hasOtherSameRoomRepairAssignmentForTarget(creep: Creep, target: Structure): boolean {
  const targetId = getObjectId(target);
  if (targetId.length === 0) {
    return false;
  }

  return getRoomOwnedCreeps(creep.room).some((worker) => {
    if (isSameCreep(worker, creep) || !isProductiveSameRoomWorker(worker, creep.room)) {
      return false;
    }

    const task = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
    return (
      task?.type === 'repair' &&
      String(task.targetId) === targetId &&
      getUsedTransferEnergy(worker) > 0 &&
      getActiveWorkParts(worker) > 0
    );
  });
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

function isBuildPreemptionRepairStructureType(
  structure: Structure,
  globalConstantName:
    | 'STRUCTURE_CONTAINER'
    | 'STRUCTURE_RAMPART'
    | 'STRUCTURE_ROAD'
    | 'STRUCTURE_SPAWN'
    | 'STRUCTURE_WALL',
  fallback: StructureConstant
): boolean {
  const globalConstant = (globalThis as unknown as Record<string, StructureConstant | undefined>)[
    globalConstantName
  ];
  return structure.structureType === (globalConstant ?? fallback);
}

function isRoomThreatened(creep: Creep): boolean {
  const roomName = creep.room?.name;
  return typeof roomName === 'string' && isColonyRoomThreatened(roomName);
}

function shouldPauseOptionalTaskForCriticalCpu(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!getRuntimeCpuBudget().critical || isSameOptionalTask(task, selectedTask)) {
    return false;
  }

  if (isEnergyAcquisitionTask(task)) {
    return getUsedTransferEnergy(creep) > 0;
  }

  if (task.type === 'upgrade') {
    return !isDowngradeGuardUpgradeTask(creep, task);
  }

  if (task.type === 'build') {
    return !isSpawnConstructionTaskTarget(getTaskTarget(task));
  }

  return task.type === 'signController' || task.type === 'collectScore';
}

function selectCriticalCpuRepairPreemptionTarget(creep: Creep): Structure | null {
  const visibleStructures = findVisibleStructuresForCriticalCpuRepairPreemption(creep.room);
  const criticalSpawnRepairTarget = visibleStructures
    .filter(isCriticalCpuOwnedSpawnRepairTarget)
    .sort(compareCriticalCpuRepairPreemptionTargets)[0];
  if (criticalSpawnRepairTarget) {
    return criticalSpawnRepairTarget;
  }

  const nearFloorRampartRepairTarget = visibleStructures
    .filter(isCriticalCpuNearFloorOwnedRampartRepairTarget)
    .sort(compareCriticalCpuRepairPreemptionTargets)[0];
  if (nearFloorRampartRepairTarget) {
    return nearFloorRampartRepairTarget;
  }

  if (creep.room.controller?.my !== true || !isColonyRoomThreatened(creep.room.name)) {
    return null;
  }

  return (
    visibleStructures
      .filter(isCriticalCpuThreatenedBarrierRepairTarget)
      .sort(compareCriticalCpuRepairPreemptionTargets)[0] ?? null
  );
}

function findVisibleStructuresForCriticalCpuRepairPreemption(room: Room): AnyStructure[] {
  const findStructures = (globalThis as unknown as { FIND_STRUCTURES?: number }).FIND_STRUCTURES;
  if (typeof findStructures !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const structures = (room as Room & { find: (type: number) => unknown[] }).find(findStructures);
  return Array.isArray(structures) ? (structures as AnyStructure[]) : [];
}

function isCriticalCpuOwnedSpawnRepairTarget(structure: AnyStructure): structure is StructureSpawn {
  return (
    isCriticalCpuRepairStructureType(structure, 'STRUCTURE_SPAWN', 'spawn') &&
    (structure as Partial<StructureSpawn>).my === true &&
    !isWorkerRepairTargetComplete(structure) &&
    getCriticalCpuRepairHitsRatio(structure) <= CRITICAL_SPAWN_REPAIR_HITS_RATIO
  );
}

function isCriticalCpuNearFloorOwnedRampartRepairTarget(structure: AnyStructure): structure is StructureRampart {
  return (
    isCriticalCpuOwnedRampart(structure) &&
    !isWorkerRepairTargetComplete(structure) &&
    structure.hits < BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING
  );
}

function isCriticalCpuThreatenedBarrierRepairTarget(
  structure: AnyStructure
): structure is StructureRampart | StructureWall {
  return isCriticalCpuBarrierRepairTarget(structure) && !isWorkerRepairTargetComplete(structure);
}

function isCriticalCpuBarrierRepairTarget(structure: AnyStructure): structure is StructureRampart | StructureWall {
  return (
    isCriticalCpuOwnedRampart(structure) ||
    isCriticalCpuRepairStructureType(structure, 'STRUCTURE_WALL', 'constructedWall')
  );
}

function isCriticalCpuOwnedRampart(structure: AnyStructure): structure is StructureRampart {
  return (
    isCriticalCpuRepairStructureType(structure, 'STRUCTURE_RAMPART', 'rampart') &&
    (structure as Partial<StructureRampart>).my === true
  );
}

function compareCriticalCpuRepairPreemptionTargets(left: Structure, right: Structure): number {
  return (
    getCriticalCpuRepairHitsRatio(left) - getCriticalCpuRepairHitsRatio(right) ||
    left.hits - right.hits ||
    String(left.id).localeCompare(String(right.id))
  );
}

function getCriticalCpuRepairHitsRatio(structure: Structure): number {
  return structure.hitsMax > 0 ? structure.hits / structure.hitsMax : 1;
}

function isCriticalCpuRepairStructureType(
  structure: AnyStructure,
  globalConstantName: 'STRUCTURE_RAMPART' | 'STRUCTURE_SPAWN' | 'STRUCTURE_WALL',
  fallback: StructureConstant
): boolean {
  const globalConstant = (globalThis as unknown as Record<string, StructureConstant | undefined>)[
    globalConstantName
  ];
  return structure.structureType === (globalConstant ?? fallback);
}

function getCriticalCpuTransferRetentionDecision(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'transfer' }>
): CriticalCpuTaskRetentionDecision {
  if (getUsedTransferEnergy(creep) <= 0) {
    return { retain: false };
  }

  const selectionContext = selectWorkerTaskContext(creep, task);
  const shouldPreempt =
    shouldPreemptForWorkerEnergyCriticalTask(task, selectionContext.energyCriticalTask) ||
    shouldPreemptTransferTaskForControllerDowngradeGuard(creep, task, selectionContext.selectedTask) ||
    shouldPreemptTransferTaskForBetterEnergySink(creep, task, selectionContext.selectedTask);
  return { retain: !shouldPreempt, selectionContext };
}

function getCriticalCpuTerritoryControlRetentionDecision(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'claim' | 'reserve' }>
): CriticalCpuTaskRetentionDecision {
  const selectionContext = selectWorkerTaskContext(creep, task);
  const retain = isSameOptionalTask(task, selectionContext.selectedTask);
  return { retain, ...(retain ? { retainedTask: task } : {}), selectionContext };
}

function selectSpawnEnergyReservationRefillTask(
  creep: Creep,
  currentTask: CreepTaskMemory | null | undefined,
  selectedTask: CreepTaskMemory | null
): Extract<CreepTaskMemory, { type: 'transfer' }> | null {
  const target = selectSpawnEnergyReservationRefillTarget(creep);
  if (!target) {
    return null;
  }

  if (shouldDeferSpawnReservationRefillForProductiveWork(creep, selectedTask, target)) {
    return null;
  }

  if (
    !isSoftSpawnReservationPreemptibleTask(creep, currentTask) ||
    !isSoftSpawnReservationPreemptibleTask(creep, selectedTask)
  ) {
    return null;
  }

  const targetId = getObjectId(target.spawn);
  return targetId.length > 0 ? { type: 'transfer', targetId: targetId as Id<AnyStoreStructure> } : null;
}

function shouldDeferSpawnReservationRefillForProductiveWork(
  creep: Creep,
  selectedTask: CreepTaskMemory | null,
  refillTarget: SpawnEnergyReservationRefillTarget | null = null
): boolean {
  return (
    (selectedTask?.type === 'build' || selectedTask?.type === 'repair') &&
    !hasActiveSpawningSpawn(creep.room) &&
    (hasHealthyRoomEnergyBuffer(creep.room) ||
      hasSafeStoredEnergyForBoundedConstruction(creep, selectedTask) ||
      hasOtherWorkerCoveringSpawnReservationRefill(creep, refillTarget))
  );
}

function hasOtherWorkerCoveringSpawnReservationRefill(
  creep: Creep,
  refillTarget: SpawnEnergyReservationRefillTarget | null
): boolean {
  if (refillTarget === null) {
    return false;
  }

  const coverageNeed = getSpawnReservationRefillCoverageNeed(refillTarget);
  if (coverageNeed <= 0) {
    return true;
  }

  let coverageEnergy = 0;
  for (const worker of getRoomOwnedCreeps(creep.room)) {
    if (isSameCreep(worker, creep) || !isProductiveSameRoomWorker(worker, creep.room)) {
      continue;
    }

    coverageEnergy += getSpawnReservationRefillCoverageEnergy(worker, refillTarget);
    if (coverageEnergy >= coverageNeed) {
      return true;
    }
  }

  return false;
}

function getSpawnReservationRefillCoverageNeed(
  refillTarget: SpawnEnergyReservationRefillTarget
): number {
  const thresholdGap = Math.max(0, refillTarget.threshold - refillTarget.spawnEnergy);
  return Math.min(
    Math.max(0, refillTarget.unmetReservedEnergy),
    getFreeTransferEnergyCapacity(refillTarget.spawn),
    thresholdGap
  );
}

function getSpawnReservationRefillCoverageEnergy(
  worker: Creep,
  refillTarget: SpawnEnergyReservationRefillTarget
): number {
  const task = worker.memory?.task;
  const carriedEnergy = getUsedTransferEnergy(worker);
  if (!task) {
    return carriedEnergy;
  }

  if (task.type === 'transfer') {
    return String(task.targetId) === String(refillTarget.spawn.id) ? carriedEnergy : 0;
  }

  if (!isEnergyAcquisitionTask(task) || isConstructionWithdrawReservationTask(task)) {
    return 0;
  }

  return carriedEnergy + getSpawnReservationRefillAcquisitionEnergy(worker, task);
}

function isConstructionWithdrawReservationTask(
  task: Partial<CreepTaskMemory> | undefined
): task is Extract<CreepTaskMemory, { type: 'withdraw' }> {
  return (
    task?.type === 'withdraw' &&
    typeof task.targetId === 'string' &&
    task.targetId.length > 0 &&
    typeof task.constructionSiteId === 'string' &&
    task.constructionSiteId.length > 0
  );
}

function getSpawnReservationRefillAcquisitionEnergy(
  worker: Creep,
  task: Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }>
): number {
  const freeCapacity = getFreeTransferEnergyCapacity(worker);
  if (freeCapacity <= 0) {
    return 0;
  }

  const availableEnergy =
    task.type === 'harvest'
      ? getVisibleHarvestSourceEnergy(worker.room, String(task.targetId))
      : task.type === 'pickup'
        ? getVisibleDroppedEnergy(worker.room, String(task.targetId))
        : getStoredEnergy(getTaskTarget(task));
  return Math.min(freeCapacity, availableEnergy);
}

function getVisibleHarvestSourceEnergy(room: Room, targetId: string): number {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return 0;
  }

  const source = (room.find(FIND_SOURCES) as Source[]).find((candidate) => String(candidate.id) === targetId);
  if (!source) {
    return 0;
  }

  return typeof source.energy === 'number' && Number.isFinite(source.energy)
    ? Math.max(0, source.energy)
    : Number.MAX_SAFE_INTEGER;
}

function getVisibleDroppedEnergy(room: Room, targetId: string): number {
  if (typeof FIND_DROPPED_RESOURCES !== 'number' || typeof room.find !== 'function') {
    return 0;
  }

  const resource = (room.find(FIND_DROPPED_RESOURCES) as Resource<ResourceConstant>[]).find(
    (candidate) => String(candidate.id) === targetId
  );
  if (!resource || resource.resourceType !== RESOURCE_ENERGY) {
    return 0;
  }

  return typeof resource.amount === 'number' && Number.isFinite(resource.amount)
    ? Math.max(0, resource.amount)
    : 0;
}

function hasSafeStoredEnergyForBoundedConstruction(
  creep: Creep,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (selectedTask?.type !== 'build') {
    return false;
  }

  const energyAvailable = getRoomEnergyAvailable(creep.room);
  if (energyAvailable === null || energyAvailable < MINIMUM_WORKER_SPAWN_ENERGY) {
    return false;
  }

  const storedEnergy = getRoomStoredEnergyAvailableForConstruction(creep.room);
  if (storedEnergy < CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY) {
    return false;
  }

  if (hasOtherSameRoomBuildAssignment(creep)) {
    const constructionSite = getTaskTarget(selectedTask);
    if (!isConstructionSite(constructionSite) || !hasUncoveredAssignmentGapConstructionProgress(creep, constructionSite)) {
      return false;
    }
  }

  return storedEnergy >= SPAWN_RESERVATION_PRODUCTIVE_WORK_MIN_STORED_SURPLUS;
}

function hasOtherSameRoomBuildAssignment(creep: Creep): boolean {
  return getRoomOwnedCreeps(creep.room).some((worker) => {
    if (isSameCreep(worker, creep) || !isProductiveSameRoomWorker(worker, creep.room)) {
      return false;
    }

    return worker.memory?.task?.type === 'build';
  });
}

function hasHealthyRoomEnergyBuffer(room: Room): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  return energyAvailable !== null && energyAvailable >= getEffectiveRoomEnergyBufferThreshold(room);
}

function isControllerDowngradeGuardActive(room: Room): boolean {
  const controller = room.controller;
  return (
    controller?.my === true &&
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS
  );
}

function hasActiveSpawningSpawn(room: Room): boolean {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room?.find !== 'function') {
    return false;
  }

  return room.find(FIND_MY_STRUCTURES).some((structure) => {
    const structureType = (structure as { structureType?: unknown }).structureType;
    return (
      typeof structureType === 'string' &&
      matchesTransferSinkStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') &&
      Boolean((structure as StructureSpawn).spawning)
    );
  });
}

function isSoftSpawnReservationPreemptibleTask(
  creep: Creep,
  task: CreepTaskMemory | null | undefined
): boolean {
  if (!task) {
    return true;
  }

  if (isEnergyAcquisitionTask(task)) {
    return true;
  }

  if (task.type === 'upgrade') {
    return !isDowngradeGuardUpgradeTask(creep, task);
  }

  if (task.type === 'build') {
    const target = getTaskTarget(task);
    if (!target) {
      return false;
    }

    return !isCapacityEnablingConstructionSite(target);
  }

  if (task.type === 'transfer') {
    return isStorageTransferTarget(getTaskTarget(task));
  }

  return false;
}

function fallbackToEnergyOnNullSelectionLoop(
  creep: Creep,
  selectedTask: CreepTaskMemory | null
): CreepTaskMemory | null {
  if (selectedTask) {
    delete creep.memory.workerTaskSelectionNullLoop;
    return selectedTask;
  }

  if (shouldShedNonessentialCpuWork(getRuntimeCpuBudget())) {
    return null;
  }

  const gameTime = (globalThis as unknown as { Game?: Partial<Game> }).Game?.time;
  if (typeof gameTime !== 'number') {
    return null;
  }

  const guardState = getWorkerTaskSelectionNullLoopState(creep, gameTime);
  const idleTicks = gameTime - guardState.idleStartTick + 1;
  if (idleTicks <= WORKER_STANDBY_IDLE_TIMEOUT_TICKS || guardState.fallbackAttempts >= WORKER_NULL_LOOP_FALLBACK_ATTEMPTS) {
    return null;
  }

  guardState.fallbackAttempts += 1;
  return selectWorkerPreHarvestTask(creep);
}

function getWorkerTaskSelectionNullLoopState(
  creep: Creep,
  gameTime: number
): WorkerTaskSelectionNullLoopState {
  const existing = creep.memory.workerTaskSelectionNullLoop;
  const isValidExistingState = Boolean(
    existing &&
      typeof existing.lastNullSelectionTick === 'number' &&
      Number.isFinite(existing.lastNullSelectionTick) &&
      typeof existing.nullSelectionCount === 'number' &&
      Number.isFinite(existing.nullSelectionCount) &&
      typeof existing.fallbackAttempts === 'number' &&
      Number.isFinite(existing.fallbackAttempts) &&
      typeof existing.idleStartTick === 'number' &&
      Number.isFinite(existing.idleStartTick)
  );
  const isInWindow =
    isValidExistingState && gameTime - (existing as WorkerTaskSelectionNullLoopState).lastNullSelectionTick <= WORKER_NULL_LOOP_TICK_WINDOW;

  if (!isInWindow) {
    const state = {
      lastNullSelectionTick: gameTime,
      nullSelectionCount: 1,
      fallbackAttempts: 0,
      idleStartTick: gameTime
    };
    creep.memory.workerTaskSelectionNullLoop = state;
    return state;
  }

  const typedExisting = existing as WorkerTaskSelectionNullLoopState;
  const state = {
    ...typedExisting,
    nullSelectionCount: typedExisting.nullSelectionCount + 1
  };
  creep.memory.workerTaskSelectionNullLoop = state;
  return state;
}

function runControllerSustainMovement(creep: Creep): boolean {
  const sustain = creep.memory.controllerSustain;
  if (!isControllerSustainMemory(sustain)) {
    return false;
  }

  const roomName = creep.room?.name;
  if (roomName === sustain.targetRoom) {
    if (sustain.role === 'hauler' && getCarriedEnergy(creep) <= 0) {
      clearAssignedTask(creep);
      moveTowardRoom(creep, sustain.homeRoom);
      return true;
    }

    return false;
  }

  if (sustain.role === 'hauler' && shouldControllerSustainHaulerLoadAtHome(creep, sustain, roomName)) {
    const energyTask = selectControllerSustainHaulerEnergyTask(creep);
    if (energyTask) {
      clearEnergyDropoffOptimizationMemory(creep);
      clearBuildTargetStuckTelemetry(creep);
      creep.memory.task = energyTask;
      executeAssignedTask(creep, energyTask);
      return true;
    }
  }

  clearAssignedTask(creep);
  moveTowardRoom(creep, selectControllerSustainDestinationRoom(creep, sustain, roomName));
  return true;
}

function shouldControllerSustainHaulerLoadAtHome(
  creep: Creep,
  sustain: CreepControllerSustainMemory,
  roomName: string | undefined
): boolean {
  return roomName === sustain.homeRoom && getFreeTransferEnergyCapacity(creep) > 0;
}

function selectControllerSustainDestinationRoom(
  creep: Creep,
  sustain: CreepControllerSustainMemory,
  roomName: string | undefined
): string {
  if (sustain.role !== 'hauler') {
    return sustain.targetRoom;
  }

  if (getCarriedEnergy(creep) > 0) {
    return sustain.targetRoom;
  }

  return roomName === sustain.homeRoom ? sustain.targetRoom : sustain.homeRoom;
}

function runSpawnSupportMovement(creep: Creep): boolean {
  const support = creep.memory.spawnSupport;
  if (!isSpawnSupportMemory(support)) {
    return false;
  }

  if (creep.room?.name === support.targetRoom) {
    return false;
  }

  clearAssignedTask(creep);
  moveTowardRoom(creep, support.targetRoom);
  return true;
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

function clearAssignedTask(creep: Creep): void {
  delete creep.memory.task;
  clearEnergyDropoffOptimizationMemory(creep);
  clearBuildTargetStuckTelemetry(creep);
}

function moveTowardRoom(creep: Creep, roomName: string): void {
  if (typeof creep.moveTo !== 'function') {
    return;
  }

  const visibleController = getVisibleRoomController(roomName);
  if (visibleController) {
    creep.moveTo(visibleController);
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: new (x: number, y: number, roomName: string) => RoomPosition })
    .RoomPosition;
  if (typeof RoomPositionCtor === 'function') {
    creep.moveTo(new RoomPositionCtor(25, 25, roomName));
  }
}

function getVisibleRoomController(roomName: string): StructureController | null {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName]?.controller ?? null;
}

function selectControllerSustainHaulerEnergyTask(creep: Creep): CreepTaskMemory | null {
  return (
    selectControllerSustainDroppedEnergyTask(creep) ??
    selectControllerSustainStoredEnergyTask(creep) ??
    selectControllerSustainHarvestTask(creep)
  );
}

function selectControllerSustainStoredEnergyTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'withdraw' }> | null {
  if (typeof creep.room?.find !== 'function') {
    return null;
  }

  const structures = creep.room.find(FIND_STRUCTURES) as Structure[];
  const source = structures
    .filter(isControllerSustainStoredEnergySource)
    .sort((left, right) => compareControllerSustainStoredEnergySources(creep, left, right))[0];

  return source ? { type: 'withdraw', targetId: source.id as Id<AnyStoreStructure> } : null;
}

function compareControllerSustainStoredEnergySources(
  creep: Creep,
  left: AnyStoreStructure,
  right: AnyStoreStructure
): number {
  return compareRoomObjectsByRangeAndId(creep, left, right) || getStoredEnergy(right) - getStoredEnergy(left);
}

function selectControllerSustainDroppedEnergyTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'pickup' }> | null {
  if (typeof creep.room?.find !== 'function') {
    return null;
  }

  const droppedEnergy = (creep.room.find(FIND_DROPPED_RESOURCES) as Resource<ResourceConstant>[])
    .filter((resource) => resource.resourceType === RESOURCE_ENERGY && resource.amount >= MIN_HAULER_DROPPED_ENERGY)
    .sort((left, right) => compareRoomObjectsByRangeAndId(creep, left, right))[0];

  return droppedEnergy ? { type: 'pickup', targetId: droppedEnergy.id } : null;
}

function selectControllerSustainHarvestTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'harvest' }> | null {
  if (typeof creep.room?.find !== 'function') {
    return null;
  }

  const source = (creep.room.find(FIND_SOURCES) as Source[])
    .filter((candidate) => candidate.energy === undefined || candidate.energy > 0)
    .sort((left, right) => compareRoomObjectsByRangeAndId(creep, left, right))[0];

  return source ? { type: 'harvest', targetId: source.id } : null;
}

function isControllerSustainStoredEnergySource(structure: Structure): structure is AnyStoreStructure {
  const structureType = (structure as { structureType?: unknown }).structureType;
  const ownedState = (structure as { my?: unknown }).my;
  return (
    (structureType === STRUCTURE_CONTAINER || ownedState !== false) &&
    (structureType === STRUCTURE_CONTAINER || structureType === STRUCTURE_STORAGE || structureType === STRUCTURE_TERMINAL) &&
    getStoredEnergy(structure) > 0
  );
}

function compareRoomObjectsByRangeAndId(creep: Creep, left: RoomObject, right: RoomObject): number {
  return (
    getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) ||
    getStableId(left).localeCompare(getStableId(right))
  );
}

function getRangeToRoomObject(creep: Creep, target: RoomObject): number {
  const range = creep.pos?.getRangeTo?.(target);
  return typeof range === 'number' ? range : Number.MAX_SAFE_INTEGER;
}

function getStableId(object: RoomObject): string {
  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function getStoredEnergy(target: unknown): number {
  const storedEnergy = (target as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null } })
    .store?.getUsedCapacity?.(RESOURCE_ENERGY);
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getRoomEnergyAvailable(room: Room): number | null {
  const energyAvailable = (room as Room & { energyAvailable?: unknown }).energyAvailable;
  return typeof energyAvailable === 'number' && Number.isFinite(energyAvailable)
    ? Math.max(0, energyAvailable)
    : null;
}

function getRoomEnergyCapacityAvailable(room: Room): number | null {
  const energyCapacityAvailable = (room as Room & { energyCapacityAvailable?: unknown }).energyCapacityAvailable;
  return typeof energyCapacityAvailable === 'number' && Number.isFinite(energyCapacityAvailable)
    ? Math.max(0, energyCapacityAvailable)
    : null;
}

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
}

function optimizeAssignedEnergyDropoffTask(creep: Creep): void {
  const task = creep.memory.task;
  if (task?.type !== 'transfer' || getUsedTransferEnergy(creep) <= 0) {
    return;
  }

  const dropoff = findVisibleAssignedDurableEnergyDropoff(creep, task);
  const optimizedTask = selectEnergyDropoffOptimizationTask(creep, dropoff);
  if (optimizedTask && !isSameTask(task, optimizedTask)) {
    rememberEnergyDropoffOptimization(creep, task, optimizedTask);
    creep.memory.task = optimizedTask;
    return;
  }

  clearEnergyDropoffOptimizationMemory(creep);
}

function shouldRetainAssignedEnergyDropoffOptimization(
  creep: Creep,
  currentTask: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isAssignedEnergyDropoffOptimizationTask(creep, currentTask) || !selectedTask) {
    return false;
  }

  const sourceTask = creep.memory.energyDropoffOptimization?.sourceTask;
  return sourceTask?.type === selectedTask.type && sourceTask.targetId === String(selectedTask.targetId);
}

function isAssignedEnergyDropoffOptimizationTask(
  creep: Creep,
  task: CreepTaskMemory | null | undefined
): task is CreepTaskMemory {
  const optimizedTask = creep.memory.energyDropoffOptimization?.optimizedTask;
  return Boolean(
    task && optimizedTask && optimizedTask.type === task.type && optimizedTask.targetId === String(task.targetId)
  );
}

function rememberEnergyDropoffOptimization(
  creep: Creep,
  sourceTask: Extract<CreepTaskMemory, { type: 'transfer' }>,
  optimizedTask: CreepTaskMemory
): void {
  creep.memory.energyDropoffOptimization = {
    sourceTask: {
      type: sourceTask.type,
      targetId: String(sourceTask.targetId)
    },
    optimizedTask: {
      type: optimizedTask.type,
      targetId: String(optimizedTask.targetId)
    }
  };
}

function clearEnergyDropoffOptimizationMemory(creep: Creep): void {
  delete creep.memory.energyDropoffOptimization;
}

function findVisibleAssignedDurableEnergyDropoff(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'transfer' }>
): StructureStorage | StructureTerminal | null {
  const targetId = String(task.targetId);
  const room = creep.room;
  const directDropoff = [room.storage, room.terminal].find(
    (dropoff): dropoff is StructureStorage | StructureTerminal =>
      isDurableEnergyDropoff(dropoff) && String(dropoff.id) === targetId
  );
  if (directDropoff) {
    return directDropoff;
  }

  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  const structures = room.find(FIND_MY_STRUCTURES);
  return (
    structures.find(
      (structure): structure is StructureStorage | StructureTerminal =>
        isDurableEnergyDropoff(structure) && String(structure.id) === targetId
    ) ?? null
  );
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

function executeAssignedTask(
  creep: Creep,
  selectedTask: CreepTaskMemory | null,
  immediateReselectExecutions = 0
): void {
  let task: CreepTaskMemory | null | undefined = creep.memory.task;
  if (!task || !canExecuteTask(creep, task)) {
    recordCreepBehaviorIdle(creep);
    return;
  }

  let target = Game.getObjectById(task.targetId) as WorkerTaskTarget | null;
  if (!target) {
    if (selectedTask && isSameTask(task, selectedTask)) {
      recordCreepBehaviorIdle(creep);
      return;
    }

    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      recordCreepBehaviorIdle(creep);
      return;
    }

    target = Game.getObjectById(task.targetId) as WorkerTaskTarget | null;
    if (!target) {
      recordCreepBehaviorIdle(creep);
      return;
    }
  }

  if (shouldReplaceTarget(creep, task, target)) {
    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      recordCreepBehaviorIdle(creep);
      return;
    }

    target = Game.getObjectById(task.targetId) as WorkerTaskTarget | null;
    if (!target || shouldReplaceTarget(creep, task, target)) {
      recordCreepBehaviorIdle(creep);
      return;
    }
  }

  const execution = executeTask(creep, task, target);
  recordTaskBehavior(creep, task, execution);
  if (
    shouldImmediatelyReselectAfterTaskResult(task, execution.result) ||
    shouldImmediatelyReselectAfterEmptySpendingTaskResult(creep, task)
  ) {
    delete creep.memory.task;
    const nextTask = assignNextTask(creep);
    if (
      nextTask &&
      !isSameTask(task, nextTask) &&
      immediateReselectExecutions < MAX_IMMEDIATE_RESELECT_EXECUTIONS
    ) {
      executeAssignedTask(creep, nextTask, immediateReselectExecutions + 1);
    }
    return;
  }

  if (execution.result === ERR_NOT_IN_RANGE_CODE) {
    const moveResult = moveToAssignedTaskTarget(creep, task, target as RoomObject);
    if (moveResult === OK_CODE) {
      recordCreepBehaviorMove(creep);
      recordCreepBehaviorMoveTask(creep, task);
    }
  }
}

function shouldImmediatelyReselectAfterTaskResult(task: CreepTaskMemory, result: ScreepsReturnCode): boolean {
  if (task.type === 'transfer') {
    return result === ERR_FULL_CODE;
  }

  return isEnergyAcquisitionTask(task) && isUnavailableEnergyAcquisitionResult(result);
}

function shouldImmediatelyReselectAfterEmptySpendingTaskResult(
  creep: Creep,
  task: CreepTaskMemory
): boolean {
  const usedEnergy = getObservedUsedTransferEnergy(creep);
  return isEnergySpendingMovementTask(task) && usedEnergy !== null && usedEnergy <= 0;
}

function isUnavailableEnergyAcquisitionResult(result: ScreepsReturnCode): boolean {
  return result === ERR_NOT_ENOUGH_RESOURCES_CODE || result === ERR_INVALID_TARGET_CODE;
}

function assignSelectedTask(
  creep: Creep,
  selectedTask: CreepTaskMemory | null,
  previousTask?: CreepTaskMemory
): CreepTaskMemory | null {
  if (!selectedTask || (previousTask && isSameTask(previousTask, selectedTask))) {
    delete creep.memory.task;
    clearEnergyDropoffOptimizationMemory(creep);
    clearBuildTargetStuckTelemetry(creep);
    return null;
  }

  clearEnergyDropoffOptimizationMemory(creep);
  clearBuildTargetStuckTelemetry(creep);
  creep.memory.task = selectedTask;
  return selectedTask;
}

function canExecuteTask(creep: Creep, task: CreepTaskMemory): boolean {
  switch (task.type) {
    case 'harvest':
      return typeof creep.harvest === 'function';
    case 'pickup':
      return typeof creep.pickup === 'function';
    case 'withdraw':
      return typeof creep.withdraw === 'function';
    case 'transfer':
      return typeof creep.transfer === 'function';
    case 'build':
      return typeof creep.build === 'function';
    case 'repair':
      return typeof creep.repair === 'function';
    case 'claim':
      return typeof creep.claimController === 'function';
    case 'reserve':
      return typeof creep.reserveController === 'function';
    case 'signController':
      return typeof creep.signController === 'function';
    case 'upgrade':
      return typeof creep.upgradeController === 'function';
    case 'collectScore':
      return typeof creep.moveTo === 'function';
  }
}

function assignNextTask(creep: Creep): CreepTaskMemory | null {
  const baseTask = selectWorkerTaskForRunner(creep);
  const task = selectWorkerEnergyCriticalTask(creep, creep.memory.task, baseTask) ?? baseTask;
  return assignSelectedTask(creep, task);
}

function shouldReplaceTask(creep: Creep, task: CreepTaskMemory): boolean {
  if (isTerritoryControlTask(task)) {
    return false;
  }

  if (task.type === 'signController') {
    return false;
  }

  if (task.type === 'collectScore') {
    return false;
  }

  if (!creep.store?.getUsedCapacity || !creep.store?.getFreeCapacity) {
    return false;
  }

  const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const freeEnergyCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);

  if (task.type === 'harvest' || task.type === 'pickup' || task.type === 'withdraw') {
    if (isSourceContainerAssignedHarvestTask(task)) {
      const sourceContainer = findHarvestTaskSourceContainer(creep, task);
      if (sourceContainer) {
        return freeEnergyCapacity === 0 || getFreeTransferEnergyCapacity(sourceContainer) <= 0;
      }
    }

    return freeEnergyCapacity === 0;
  }

  return usedEnergy === 0;
}

function shouldPreemptForVisibleTerritoryControllerTask(
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (isTerritoryControlTask(task)) {
    return !selectedTask || !isSameTask(task, selectedTask);
  }

  return isTerritoryControlTask(selectedTask);
}

function shouldPreemptForControllerSigning(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  return (
    selectedTask?.type === 'signController' &&
    !isSameTask(task, selectedTask) &&
    task.type === 'upgrade' &&
    isOwnedControllerUpgradeTask(creep, task)
  );
}

function shouldPreemptControllerSigningForRecovery(
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  return task.type === 'signController' && isWorkerRecoveryTask(selectedTask);
}

function isWorkerRecoveryTask(
  task: CreepTaskMemory | null
): task is Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' | 'transfer' | 'build' | 'repair' }> {
  return (
    task?.type === 'harvest' ||
    task?.type === 'pickup' ||
    task?.type === 'withdraw' ||
    task?.type === 'transfer' ||
    task?.type === 'build' ||
    task?.type === 'repair'
  );
}

function shouldPreemptSpendingTaskForEnergySink(
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isEnergySpendingTask(task)) {
    return false;
  }

  return selectedTask?.type === 'transfer' && !isSameTask(task, selectedTask);
}

function shouldPreemptSpendingTaskForNearTermSpawnExtensionRefill(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  return (
    selectedTask === null &&
    isEnergySpendingTask(task) &&
    shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)
  );
}

function shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isEnergyAcquisitionTask(task)) {
    return false;
  }

  if (!creep.store?.getUsedCapacity || !creep.store?.getFreeCapacity) {
    return false;
  }

  if (typeof creep.room?.find !== 'function') {
    return false;
  }

  const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const freeEnergyCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);
  if (usedEnergy !== 0 || freeEnergyCapacity <= 0) {
    return false;
  }

  return isRecoverableEnergyTask(selectedTask) && !isSameTask(task, selectedTask);
}

function shouldPreemptEnergyAcquisitionTaskForSpawnReservationRefill(
  task: CreepTaskMemory,
  spawnReservationRefillTask: CreepTaskMemory | null
): boolean {
  return (
    isEnergyAcquisitionTask(task) &&
    spawnReservationRefillTask?.type === 'transfer' &&
    !isSameTask(task, spawnReservationRefillTask)
  );
}

function shouldPreemptEnergyAcquisitionTaskForNearFullConstruction(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  return (
    isEnergyAcquisitionTask(task) &&
    selectedTask !== null &&
    !isSameTask(task, selectedTask) &&
    shouldYieldStorageCriticalAcquisitionToNearFullConstruction(creep, task, selectedTask)
  );
}

function shouldPreemptEnergyAcquisitionTaskForProductiveBacklog(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (
    !isEnergyAcquisitionTask(task) ||
    selectedTask === null ||
    isSameTask(task, selectedTask) ||
    !canExecuteTask(creep, selectedTask) ||
    getUsedTransferEnergy(creep) <= 0
  ) {
    return false;
  }

  if (isDedicatedSourceContainerHarvestTask(creep, task)) {
    return false;
  }

  if (selectedTask.type === 'build') {
    const constructionSite = getTaskTarget(selectedTask) as ConstructionSite | null;
    return Boolean(constructionSite && canSpendWorkerEnergyOnConstructionSite(creep, constructionSite));
  }

  if (selectedTask.type === 'repair') {
    const repairTarget = getTaskTarget(selectedTask);
    return isRepairPreemptionStructure(repairTarget) && !isWorkerRepairTargetComplete(repairTarget);
  }

  return false;
}

function shouldPreemptEnergyAcquisitionTaskForUrgentEnergySpending(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isEnergyAcquisitionTask(task)) {
    return false;
  }

  if (!selectedTask || isSameTask(task, selectedTask)) {
    return false;
  }

  if (!creep.store?.getUsedCapacity) {
    return false;
  }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
    return false;
  }

  if (isDedicatedSourceContainerHarvestTask(creep, task)) {
    return isUrgentEnergySpendingTask(selectedTask) || isDowngradeGuardUpgradeTask(creep, selectedTask);
  }

  if (hasLowWorkerEnergyLoad(creep)) {
    return isUrgentRepairTask(selectedTask) || shouldPreemptLowLoadEnergyAcquisitionForReturn(creep, selectedTask);
  }

  return isUrgentEnergySpendingTask(selectedTask) || isDowngradeGuardUpgradeTask(creep, selectedTask);
}

function shouldPreemptTaskForUrgentRepair(
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (task.type !== 'build' && task.type !== 'repair' && task.type !== 'transfer') {
    return false;
  }

  if (!selectedTask || isSameTask(task, selectedTask) || !isUrgentRepairTask(selectedTask)) {
    return false;
  }

  return true;
}

function shouldPreemptEnergyAcquisitionTaskForSeasonScore(
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  return isEnergyAcquisitionTask(task) && selectedTask?.type === 'collectScore' && !isSameTask(task, selectedTask);
}

function shouldPreemptSeasonScoreTask(
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  return task.type === 'collectScore' && selectedTask !== null && !isSameTask(task, selectedTask);
}

function shouldPreemptLowLoadEnergyAcquisitionForReturn(
  creep: Creep,
  selectedTask: CreepTaskMemory
): boolean {
  const sample = creep.memory?.workerEfficiency;
  return (
    sample?.type === 'lowLoadReturn' &&
    sample.selectedTask === selectedTask.type &&
    sample.targetId === String(selectedTask.targetId) &&
    isCurrentWorkerEfficiencySample(sample)
  );
}

function hasLowWorkerEnergyLoad(creep: Creep): boolean {
  const carriedEnergy = getUsedTransferEnergy(creep);
  const freeCapacity = getFreeCreepEnergyCapacity(creep);
  if (carriedEnergy <= 0 || freeCapacity <= 0) {
    return false;
  }

  const capacity = getCreepEnergyCapacity(creep, carriedEnergy, freeCapacity);
  return capacity > 0 && carriedEnergy < capacity * MINIMUM_USEFUL_LOAD_RATIO;
}

function getFreeCreepEnergyCapacity(creep: Creep): number {
  const freeCapacity = creep.store?.getFreeCapacity?.(RESOURCE_ENERGY);
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getCreepEnergyCapacity(creep: Creep, carriedEnergy: number, freeCapacity: number): number {
  const capacity = creep.store?.getCapacity?.(RESOURCE_ENERGY);
  return typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0
    ? capacity
    : carriedEnergy + freeCapacity;
}

function shouldPreemptTaskForUpgraderBoost(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isOwnedControllerUpgradeTask(creep, selectedTask) || isSameTask(task, selectedTask)) {
    return false;
  }

  if (!isUpgraderBoostActive(creep, creep.room?.controller)) {
    return false;
  }

  return getCarriedEnergy(creep) > 0;
}

function shouldPreemptEnergyAcquisitionTaskForNearbyEnergyChoice(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isEnergyAcquisitionTask(task) || !selectedTask || !isEnergyAcquisitionTask(selectedTask)) {
    return false;
  }

  if (isSameTask(task, selectedTask)) {
    return false;
  }

  const sample = creep.memory?.workerEfficiency;
  return (
    sample?.type === 'nearbyEnergyChoice' &&
    sample.selectedTask === selectedTask.type &&
    sample.targetId === String(selectedTask.targetId) &&
    isCurrentWorkerEfficiencySample(sample) &&
    shouldSwitchLowLoadWorkerEnergyAcquisitionTaskForYield(creep, task, selectedTask)
  );
}

function shouldPreemptLowLoadReturnTaskForEnergyAcquisition(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isLowLoadReturnTask(task) || !selectedTask || !isEnergyAcquisitionTask(selectedTask)) {
    return false;
  }

  if (isSameTask(task, selectedTask)) {
    return false;
  }

  const sample = creep.memory?.workerEfficiency;
  return (
    sample?.type === 'nearbyEnergyChoice' &&
    sample.selectedTask === selectedTask.type &&
    sample.targetId === String(selectedTask.targetId) &&
    isCurrentWorkerEfficiencySample(sample)
  );
}

function shouldPreemptTransferTaskForBetterEnergySink(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (task.type !== 'transfer') {
    return false;
  }

  if (selectedTask?.type !== 'transfer' || isSameTask(task, selectedTask)) {
    return false;
  }

  if (!creep.store?.getUsedCapacity) {
    return false;
  }

  if (typeof creep.room?.find !== 'function') {
    return false;
  }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
    return false;
  }

  const currentTarget = Game.getObjectById(task.targetId);
  if (!isValidTransferTarget(currentTarget)) {
    return true;
  }

  const selectedTarget = Game.getObjectById(selectedTask.targetId);
  const selectedPriority = getTransferSinkPriority(selectedTarget);
  const currentPriority = getTransferSinkPriority(currentTarget);
  if (selectedPriority > currentPriority) {
    return true;
  }

  return (
    isPrimaryTransferSink(currentTarget) &&
    selectedPriority > 0 &&
    isValidTransferTarget(selectedTarget) &&
    isCurrentTransferTargetCoveredByOtherLoadedWorkers(creep, task, currentTarget)
  );
}

function shouldPreemptTransferTaskForControllerDowngradeGuard(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (task.type !== 'transfer') {
    return false;
  }

  return isDowngradeGuardUpgradeTask(creep, selectedTask);
}

function shouldPreemptTransferTaskForConstructionBacklog(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (task.type !== 'transfer' || selectedTask?.type !== 'build' || isSameTask(task, selectedTask)) {
    return false;
  }

  if (getUsedTransferEnergy(creep) <= 0 || !hasMinimumProductiveWorkerCoverageForSpawnReservationYield(creep)) {
    return false;
  }

  const currentTarget = getTaskTarget(task);
  if (
    !isNonCriticalSpawnExtensionTransferTarget(currentTarget) &&
    !isNonCriticalTowerRefillTransferTarget(creep, currentTarget)
  ) {
    return false;
  }

  if (!shouldDeferSpawnReservationRefillForProductiveWork(
    creep,
    selectedTask,
    selectSpawnEnergyReservationRefillTarget(creep)
  )) {
    return false;
  }

  const constructionSite = getTaskTarget(selectedTask) as ConstructionSite | null;
  return Boolean(constructionSite && canSpendWorkerEnergyOnConstructionSite(creep, constructionSite));
}

function hasMinimumProductiveWorkerCoverageForSpawnReservationYield(creep: Creep): boolean {
  return (
    getRoomOwnedCreeps(creep.room).filter((worker) => isProductiveSameRoomWorker(worker, creep.room)).length >=
    SPAWN_RESERVATION_PRODUCTIVE_WORK_MIN_WORKERS
  );
}

function isNonCriticalSpawnExtensionTransferTarget(target: unknown): boolean {
  return getTransferSinkPriority(target) === 2;
}

function isNonCriticalTowerRefillTransferTarget(creep: Creep, target: unknown): boolean {
  return getTransferSinkPriority(target) === 1 && !isRoomThreatened(creep);
}

function shouldPreemptSpendingTaskForControllerPressure(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isEnergySpendingTask(task) || task.type === 'upgrade') {
    return false;
  }

  if (typeof creep.room?.find !== 'function') {
    return false;
  }

  return isOwnedControllerUpgradeTask(creep, selectedTask) && !isSameTask(task, selectedTask);
}

function shouldPreemptUpgradeTask(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (task.type !== 'upgrade') {
    return false;
  }

  const controller = creep.room?.controller;
  if (controller?.my !== true) {
    return false;
  }

  if (selectedTask === null || isSameTask(task, selectedTask)) {
    return false;
  }

  return true;
}

function isOwnedControllerUpgradeTask(
  creep: Creep,
  task: CreepTaskMemory | null
): task is Extract<CreepTaskMemory, { type: 'upgrade' }> {
  return (
    task?.type === 'upgrade' &&
    creep.room?.controller?.my === true &&
    task.targetId === creep.room.controller.id
  );
}

function isDowngradeGuardUpgradeTask(
  creep: Creep,
  task: CreepTaskMemory | null
): task is Extract<CreepTaskMemory, { type: 'upgrade' }> {
  if (!isOwnedControllerUpgradeTask(creep, task)) {
    return false;
  }

  const ticksToDowngrade = creep.room.controller?.ticksToDowngrade;
  return typeof ticksToDowngrade === 'number' && ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS;
}

function isSameTask(left: CreepTaskMemory, right: CreepTaskMemory): boolean {
  if (left.type !== right.type || left.targetId !== right.targetId) {
    return false;
  }

  if (left.type === 'withdraw' && right.type === 'withdraw') {
    return getWithdrawConstructionSiteId(left) === getWithdrawConstructionSiteId(right);
  }

  return true;
}

function getWithdrawConstructionSiteId(task: Extract<CreepTaskMemory, { type: 'withdraw' }>): string {
  const constructionSiteId = task.constructionSiteId;
  return typeof constructionSiteId === 'string' ? constructionSiteId : '';
}

function isEnergySpendingTask(task: CreepTaskMemory): task is Extract<
  CreepTaskMemory,
  { type: 'build' | 'repair' | 'upgrade' }
> {
  return task.type === 'build' || task.type === 'repair' || task.type === 'upgrade';
}

function isEnergyAcquisitionTask(task: CreepTaskMemory): task is Extract<
  CreepTaskMemory,
  { type: 'harvest' | 'pickup' | 'withdraw' }
> {
  return task.type === 'harvest' || task.type === 'pickup' || task.type === 'withdraw';
}

function isLowLoadReturnTask(
  task: CreepTaskMemory
): task is Extract<CreepTaskMemory, { type: 'transfer' | 'build' | 'repair' | 'upgrade' }> {
  return task.type === 'transfer' || task.type === 'build' || task.type === 'repair' || task.type === 'upgrade';
}

function isEnergySpendingMovementTask(
  task: CreepTaskMemory
): task is Extract<CreepTaskMemory, { type: 'transfer' | 'build' | 'repair' | 'upgrade' }> {
  return task.type === 'transfer' || task.type === 'build' || task.type === 'repair' || task.type === 'upgrade';
}

function isRecoverableEnergyTask(
  task: CreepTaskMemory | null
): task is Extract<CreepTaskMemory, { type: 'pickup' | 'withdraw' }> {
  return task?.type === 'pickup' || task?.type === 'withdraw';
}

function isCurrentWorkerEfficiencySample(sample: WorkerEfficiencySampleMemory): boolean {
  const gameTime = (globalThis as unknown as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime !== 'number' || sample.tick === gameTime;
}

function isTerritoryControlTask(
  task: CreepTaskMemory | null
): task is Extract<CreepTaskMemory, { type: 'claim' | 'reserve' }> {
  return task?.type === 'claim' || task?.type === 'reserve';
}

function isValidTransferTarget(target: unknown): target is AnyStoreStructure {
  return getFreeTransferEnergyCapacity(target) > 0;
}

function isStorageTransferTarget(target: unknown): target is StructureStorage {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  const storageType = (globalThis as unknown as { STRUCTURE_STORAGE?: string }).STRUCTURE_STORAGE ?? 'storage';
  return typeof structureType === 'string' && structureType === storageType;
}

function isPrimaryTransferSink(target: unknown): target is StructureSpawn | StructureExtension {
  return getTransferSinkPriority(target) >= 2;
}

function isCurrentTransferTargetCoveredByOtherLoadedWorkers(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'transfer' }>,
  target: AnyStoreStructure
): boolean {
  const targetId = String(task.targetId);
  const freeCapacity = getFreeTransferEnergyCapacity(target);
  if (freeCapacity <= 0) {
    return false;
  }

  let reservedEnergy = 0;
  for (const worker of creep.room.find(FIND_MY_CREEPS)) {
    if (isSameCreep(worker, creep) || !isProductiveSameRoomWorkerWithEnergy(worker, creep.room)) {
      continue;
    }

    const workerTask = worker.memory?.task as Partial<CreepTaskMemory> | undefined;
    if (workerTask?.type !== 'transfer' || String(workerTask.targetId) !== targetId) {
      continue;
    }

    reservedEnergy += getUsedTransferEnergy(worker);
    if (reservedEnergy >= freeCapacity) {
      return true;
    }
  }

  return false;
}

function isUrgentEnergySpendingTask(task: CreepTaskMemory): boolean {
  const target = getTaskTarget(task);
  if (task.type === 'transfer') {
    return getTransferSinkPriority(target) >= 2;
  }

  if (task.type === 'repair') {
    return isUrgentRepairTarget(target);
  }

  return task.type === 'build' && isCapacityEnablingConstructionSite(target);
}

function isUrgentRepairTask(task: CreepTaskMemory): boolean {
  return task.type === 'repair' && isUrgentRepairTarget(getTaskTarget(task));
}

function isUrgentRepairTarget(target: unknown): boolean {
  if (!isRepairPreemptionStructure(target) || isWorkerRepairTargetComplete(target)) {
    return false;
  }

  if (isBuildPreemptionCriticalSpawnRepairTarget(target)) {
    return true;
  }

  if (isBuildPreemptionBarrierRepairTarget(target)) {
    return (
      (isBuildPreemptionOwnedRampart(target) && target.hits <= EMERGENCY_RAMPART_REPAIR_HITS_CEILING) ||
      target.hits <= BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING
    );
  }

  return isBuildPreemptionCriticalRoadOrContainerRepairTarget(target);
}

function getTaskTarget(task: CreepTaskMemory): unknown {
  const game = (globalThis as unknown as { Game?: Partial<Pick<Game, 'getObjectById'>> }).Game;
  const getObjectById = game?.getObjectById as ((id: string) => unknown) | undefined;
  return typeof getObjectById === 'function' ? getObjectById(String(task.targetId)) : null;
}

function isCapacityEnablingConstructionSite(target: unknown): target is ConstructionSite {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  if (typeof structureType !== 'string') {
    return false;
  }

  return (
    matchesConstructionStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesConstructionStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension')
  );
}

function shouldYieldStorageCriticalAcquisitionToNearFullConstruction(
  creep: Creep,
  acquisitionTask: CreepTaskMemory | null,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (
    acquisitionTask === null ||
    !isEnergyAcquisitionTask(acquisitionTask) ||
    selectedTask?.type !== 'build' ||
    creep.memory?.workerEnergyCriticalPolicy?.reason !== 'storage'
  ) {
    return false;
  }

  const carriedEnergy = getUsedTransferEnergy(creep);
  const constructionSite = getTaskTarget(selectedTask);
  return (
    carriedEnergy > 0 &&
    isRoomEnergyFullOrCoveredByCarriedEnergy(creep.room, carriedEnergy) &&
    isCriticalConstructionSite(constructionSite) &&
    canSpendWorkerEnergyOnConstructionSite(creep, constructionSite)
  );
}

function isCriticalConstructionSite(target: unknown): target is ConstructionSite {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  if (typeof structureType !== 'string') {
    return false;
  }

  return (
    matchesConstructionStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesConstructionStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension') ||
    matchesConstructionStructureType(structureType, 'STRUCTURE_TOWER', 'tower') ||
    matchesConstructionStructureType(structureType, 'STRUCTURE_CONTAINER', 'container') ||
    matchesConstructionStructureType(structureType, 'STRUCTURE_ROAD', 'road')
  );
}

function isRoomEnergyFullOrCoveredByCarriedEnergy(room: Room, carriedEnergy: number): boolean {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (
    carriedEnergy <= 0 ||
    energyAvailable === null ||
    energyCapacityAvailable === null ||
    energyCapacityAvailable <= 0
  ) {
    return false;
  }

  return Math.max(0, energyCapacityAvailable - energyAvailable) <= carriedEnergy;
}

function isSpawnConstructionTaskTarget(target: unknown): target is ConstructionSite {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  if (typeof structureType !== 'string') {
    return false;
  }

  return matchesConstructionStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function getFreeTransferEnergyCapacity(target: unknown): number {
  const store = (target as { store?: { getFreeCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store;
  const freeCapacity = store?.getFreeCapacity?.(RESOURCE_ENERGY);
  return typeof freeCapacity === 'number' ? freeCapacity : 0;
}

function getUsedTransferEnergy(creep: Creep): number {
  const usedCapacity = creep.store?.getUsedCapacity?.(RESOURCE_ENERGY);
  return typeof usedCapacity === 'number' && Number.isFinite(usedCapacity) ? Math.max(0, usedCapacity) : 0;
}

function getObservedUsedTransferEnergy(creep: Creep): number | null {
  const usedCapacity = creep.store?.getUsedCapacity?.(RESOURCE_ENERGY);
  return typeof usedCapacity === 'number' && Number.isFinite(usedCapacity) ? Math.max(0, usedCapacity) : null;
}

function isSameRoomWorkerWithEnergy(creep: Creep, room: Room): boolean {
  return creep.memory?.role === 'worker' && isInRoom(creep, room) && getUsedTransferEnergy(creep) > 0;
}

function isProductiveSameRoomWorkerWithEnergy(creep: Creep, room: Room): boolean {
  return isSameRoomWorkerWithEnergy(creep, room) && !willBypassNormalWorkerTaskSelectionThisTick(creep);
}

function isProductiveSameRoomWorker(creep: Creep, room: Room): boolean {
  return isSameRoomWorker(creep, room) && !willBypassNormalWorkerTaskSelectionThisTick(creep);
}

function isSameRoomWorker(creep: Creep, room: Room): boolean {
  return creep.memory?.role === 'worker' && isInRoom(creep, room);
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

  return sustain.role === 'hauler' && getCarriedEnergy(creep) <= 0;
}

function willRunSpawnSupportMovementBeforeNormalTaskSelection(creep: Creep): boolean {
  const support = creep.memory?.spawnSupport;
  return isSpawnSupportMemory(support) && creep.room?.name !== support.targetRoom;
}

function isInRoom(creep: Creep, room: Room): boolean {
  if (typeof room.name === 'string' && room.name.length > 0) {
    return creep.room?.name === room.name;
  }

  return creep.room === room;
}

function isSameCreep(left: Creep, right: Creep): boolean {
  if (left === right) {
    return true;
  }

  const leftKey = getCreepStableKey(left);
  return leftKey.length > 0 && leftKey === getCreepStableKey(right);
}

function getCreepStableKey(creep: Creep): string {
  const name = (creep as Creep & { name?: unknown }).name;
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }

  const id = (creep as Creep & { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : '';
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  return typeof candidate.name === 'string' ? candidate.name : '';
}

function getTransferSinkPriority(target: unknown): number {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  if (typeof structureType !== 'string') {
    return 0;
  }

  if (matchesTransferSinkStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return isCriticalSpawnRefillTarget(target) ? 3 : 2;
  }

  if (matchesTransferSinkStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return 2;
  }

  if (matchesTransferSinkStructureType(structureType, 'STRUCTURE_LINK', 'link')) {
    return 0.5;
  }

  return matchesTransferSinkStructureType(structureType, 'STRUCTURE_TOWER', 'tower') ? 1 : 0;
}

function isCriticalSpawnRefillTarget(target: unknown): boolean {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  const storedEnergy = getKnownStoredTransferEnergy(target);
  return (
    typeof structureType === 'string' &&
    matchesTransferSinkStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') &&
    storedEnergy !== null &&
    storedEnergy < CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
  );
}

function getKnownStoredTransferEnergy(target: unknown): number | null {
  const store = (
    target as {
      store?: {
        getUsedCapacity?: (resource?: ResourceConstant) => number | null;
        [resource: string]: unknown;
      };
    } | null
  )?.store;
  const usedCapacity = store?.getUsedCapacity?.(RESOURCE_ENERGY);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return usedCapacity;
  }

  const storedEnergy = store?.[RESOURCE_ENERGY];
  if (typeof storedEnergy === 'number' && Number.isFinite(storedEnergy)) {
    return storedEnergy;
  }

  const legacyEnergy = (target as { energy?: unknown } | null)?.energy;
  return typeof legacyEnergy === 'number' && Number.isFinite(legacyEnergy) ? legacyEnergy : null;
}

function matchesTransferSinkStructureType(
  actual: string,
  globalName: TransferSinkStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<TransferSinkStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function matchesConstructionStructureType(
  actual: string,
  globalName: ConstructionStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<ConstructionStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function shouldReplaceTarget(
  creep: Creep,
  task: CreepTaskMemory,
  target: WorkerTaskTarget
): boolean {
  if (task.type === 'harvest' && isDepletedHarvestSource(target)) {
    return !(isSourceContainerAssignedHarvestTask(task) && findVisibleHarvestSourceContainer(creep, target));
  }

  if (task.type === 'transfer' && 'store' in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    return true;
  }

  if (task.type === 'withdraw' && 'store' in target && (target.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) === 0) {
    return true;
  }

  if (task.type === 'pickup' && 'amount' in target && typeof target.amount === 'number' && target.amount <= 0) {
    return true;
  }

  if (task.type === 'signController') {
    return !shouldSignControllerForCreep(creep, target as StructureController);
  }

  return task.type === 'repair' && 'hits' in target && isWorkerRepairTargetComplete(target);
}

function isDepletedHarvestSource(target: unknown): target is Source {
  const energy = (target as Partial<Source> | null)?.energy;
  return typeof energy === 'number' && energy <= 0;
}

function executeTask(
  creep: Creep,
  task: CreepTaskMemory,
  target: WorkerTaskTarget
): TaskExecutionResult {
  switch (task.type) {
    case 'harvest':
      return executeHarvestTask(creep, task, target as Source);
    case 'pickup':
      return toTaskExecutionResult(creep.pickup(target as Resource<ResourceConstant>), 'work', {
        energyAcquisitionMethod: 'pickedUp'
      });
    case 'withdraw': {
      const withdrawTarget = target as AnyStoreStructure;
      const requestedAmount = getFreeTransferEnergyCapacity(creep);
      const safeAmount = getSafeWorkerWithdrawEnergyAmount(creep, withdrawTarget, requestedAmount, task);
      if (safeAmount <= 0) {
        return { result: ERR_NOT_ENOUGH_RESOURCES_CODE };
      }

      const result = creep.withdraw(withdrawTarget, RESOURCE_ENERGY, safeAmount);
      return toTaskExecutionResult(result, 'work', {
        energyAcquisitionMethod: 'withdrawn',
        sourceContainerWithdrawal: isVisibleSourceContainer(creep, withdrawTarget)
      });
    }
    case 'transfer':
      return toTaskExecutionResult(creep.transfer(target as AnyStoreStructure, RESOURCE_ENERGY), 'work', {
        containerTransfer: isContainerStructure(target)
      });
    case 'build':
      if (!canSpendWorkerEnergyOnConstructionSite(creep, target as ConstructionSite)) {
        return { result: ERR_NOT_ENOUGH_RESOURCES_CODE };
      }

      return toTaskExecutionResult(creep.build(target as ConstructionSite), 'work');
    case 'repair':
      return toTaskExecutionResult(creep.repair(target as Structure), 'work');
    case 'claim':
      if (
        typeof creep.attackController === 'function' &&
        canCreepPressureTerritoryController(creep, target as StructureController, creep.memory.colony)
      ) {
        return toTaskExecutionResult(creep.attackController(target as StructureController), 'work');
      }

      return toTaskExecutionResult(creep.claimController(target as StructureController), 'work');
    case 'reserve':
      if (
        typeof creep.attackController === 'function' &&
        canCreepPressureTerritoryController(creep, target as StructureController, creep.memory.colony)
      ) {
        return toTaskExecutionResult(creep.attackController(target as StructureController), 'work');
      }

      return toTaskExecutionResult(creep.reserveController(target as StructureController), 'work');
    case 'signController':
      return toTaskExecutionResult(
        creep.signController(target as StructureController, OCCUPIED_CONTROLLER_SIGN_TEXT),
        'work'
      );
    case 'upgrade':
      return toTaskExecutionResult(runUpgrader(creep, target as StructureController), 'work');
    case 'collectScore':
      return executeCollectScoreTask(creep, target as RoomObject);
  }
}

function executeCollectScoreTask(creep: Creep, target: RoomObject): TaskExecutionResult {
  if (!isInRangeToRoomObject(creep, target, EXACT_POSITION_MOVE_RANGE)) {
    return { result: ERR_NOT_IN_RANGE_CODE };
  }

  return { result: OK_CODE };
}

function getRoomOwnedCreeps(room: Room): Creep[] {
  const findMyCreeps = (globalThis as unknown as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
  const roomFind = (room as Room & { find?: (type: number) => Creep[] }).find;
  if (typeof findMyCreeps === 'number' && typeof roomFind === 'function') {
    try {
      const creeps = roomFind.call(room, findMyCreeps);
      if (Array.isArray(creeps)) {
        return creeps;
      }
    } catch {
      return [];
    }
  }

  const gameCreeps = (globalThis as unknown as { Game?: Partial<Game> }).Game?.creeps;
  return gameCreeps ? Object.values(gameCreeps) : [];
}

function executeHarvestTask(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'harvest' }>,
  source: Source
): TaskExecutionResult {
  const sourceContainer = isSourceContainerAssignedHarvestTask(task)
    ? findVisibleHarvestSourceContainer(creep, source)
    : null;
  if (!sourceContainer) {
    return toTaskExecutionResult(creep.harvest(source), 'work', { energyAcquisitionMethod: 'harvested' });
  }

  if (!isInRangeToRoomObject(creep, sourceContainer, 0)) {
    const moveResult = moveToTaskTarget(creep, task.type, sourceContainer, EXACT_POSITION_MOVE_RANGE);
    return toTaskExecutionResult(moveResult, 'move');
  }

  let transferResult: TaskExecutionResult | null = null;
  if (getUsedTransferEnergy(creep) > 0) {
    transferResult = transferDedicatedHarvestEnergy(creep, sourceContainer, task.type);
    if (transferResult.action === 'move') {
      return transferResult;
    }
  }

  if (isDepletedHarvestSource(source)) {
    return transferResult ?? { result: OK_CODE };
  }

  if (getFreeTransferEnergyCapacity(creep) <= 0) {
    return transferResult ?? { result: OK_CODE };
  }

  const result = creep.harvest(source);
  if (
    ((result as ScreepsReturnCode) === ERR_FULL_CODE || result === ERR_NOT_ENOUGH_RESOURCES_CODE) &&
    getUsedTransferEnergy(creep) > 0
  ) {
    return transferDedicatedHarvestEnergy(creep, sourceContainer, task.type);
  }

  return toTaskExecutionResult(result === ERR_NOT_ENOUGH_RESOURCES_CODE ? OK_CODE : result, 'work', {
    ...(result === OK_CODE ? { energyAcquisitionMethod: 'harvested' as const } : {})
  });
}

function transferDedicatedHarvestEnergy(
  creep: Creep,
  sourceContainer: StructureContainer,
  taskType: CreepTaskMemory['type']
): TaskExecutionResult {
  if (typeof creep.transfer !== 'function') {
    return { result: OK_CODE };
  }

  const result = creep.transfer(sourceContainer, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    const moveResult = moveToTaskTarget(creep, taskType, sourceContainer, EXACT_POSITION_MOVE_RANGE);
    return toTaskExecutionResult(moveResult, 'move');
  }

  return toTaskExecutionResult(result, 'work', { containerTransfer: true });
}

function toTaskExecutionResult(
  result: ScreepsReturnCode,
  successAction: 'move' | 'work',
  options: {
    containerTransfer?: boolean;
    energyAcquisitionMethod?: RuntimeEnergyAcquisitionMethod;
    sourceContainerWithdrawal?: boolean;
  } = {}
): TaskExecutionResult {
  return {
    result,
    ...(successAction === 'move' ? { attemptedMoveTo: true } : {}),
    ...(result === OK_CODE ? { action: successAction } : {}),
    ...(result === OK_CODE && options.containerTransfer ? { containerTransfer: true } : {}),
    ...(result === OK_CODE && options.energyAcquisitionMethod
      ? { energyAcquisitionMethod: options.energyAcquisitionMethod }
      : {}),
    ...(result === OK_CODE && options.sourceContainerWithdrawal ? { sourceContainerWithdrawal: true } : {})
  };
}

function recordTaskBehavior(
  creep: Creep,
  task: CreepTaskMemory,
  execution: TaskExecutionResult
): void {
  if (task.type === 'repair') {
    recordCreepBehaviorRepairTarget(creep, String(task.targetId));
  }

  if (execution.action === 'move') {
    recordCreepBehaviorMove(creep);
  } else if (execution.action === 'work') {
    recordCreepBehaviorWork(creep);
    if (task.type === 'build') {
      clearBuildTargetStuckTelemetry(creep);
    }
  } else if (execution.result !== ERR_NOT_IN_RANGE_CODE && !execution.attemptedMoveTo) {
    recordCreepBehaviorIdle(creep);
  }

  if (execution.containerTransfer) {
    recordCreepBehaviorContainerTransfer(creep);
  }

  if (execution.energyAcquisitionMethod) {
    recordCreepBehaviorEnergyAcquisition(creep, execution.energyAcquisitionMethod);
  }

  if (execution.sourceContainerWithdrawal) {
    recordCreepBehaviorSourceContainerWithdrawal(creep);
  }
}

function moveToAssignedTaskTarget(creep: Creep, task: CreepTaskMemory, target: RoomObject): MoveToResult {
  const range = getAssignedTaskMoveRange(task);
  const result = creep.moveTo(target, getAssignedTaskMoveOptions(task, range));
  recordCreepBehaviorMoveToResult(creep, result, {
    taskType: task.type,
    targetId: getMoveTargetId(target),
    range
  });
  if (task.type === 'build' && result === getErrNoPathCode()) {
    suppressBuildTarget(creep, task, 'noPath');
  }
  return result;
}

function getAssignedTaskMoveOptions(task: CreepTaskMemory, range: number): MoveToOpts {
  return task.type === 'build' ? { range, ignoreCreeps: true } : { range };
}

function moveToTaskTarget(
  creep: Creep,
  taskType: CreepTaskMemory['type'],
  target: RoomObject,
  range: number
): MoveToResult {
  const result = creep.moveTo(target, { range });
  recordCreepBehaviorMoveToResult(creep, result, {
    taskType,
    targetId: getMoveTargetId(target),
    range
  });
  return result;
}

function getMoveTargetId(target: RoomObject): string | undefined {
  const id = (target as RoomObject & { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function getAssignedTaskMoveRange(task: CreepTaskMemory): number {
  switch (task.type) {
    case 'build':
    case 'repair':
    case 'upgrade':
      return RANGED_WORK_MOVE_RANGE;
    case 'harvest':
    case 'pickup':
    case 'withdraw':
    case 'transfer':
    case 'claim':
    case 'reserve':
    case 'signController':
      return ADJACENT_ACTION_MOVE_RANGE;
    case 'collectScore':
      return EXACT_POSITION_MOVE_RANGE;
  }
}

function suppressCurrentBuildTargetIfWorkerIsStuck(creep: Creep): void {
  const task = creep.memory.task;
  if (task?.type !== 'build') {
    return;
  }

  const telemetry = creep.memory.behaviorTelemetry;
  if (
    (telemetry?.buildTargetStuckTicks ?? 0) < BUILD_TARGET_STUCK_TICKS ||
    telemetry?.buildTargetStuckTargetId !== String(task.targetId)
  ) {
    return;
  }

  suppressBuildTarget(creep, task, 'stuck');
  if (telemetry) {
    clearBuildTargetStuckTelemetry(creep);
  }
}

function clearBuildTargetStuckTelemetry(creep: Creep): void {
  const telemetry = creep.memory.behaviorTelemetry;
  if (!telemetry) {
    return;
  }

  delete telemetry.buildTargetStuckTicks;
  delete telemetry.buildTargetStuckTargetId;
  delete telemetry.lastMoveBuildTargetId;
}

function suppressBuildTarget(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'build' }>,
  reason: WorkerBlockedBuildTargetMemory['reason']
): void {
  const tick = getGameTick();
  creep.memory.blockedBuildTarget = {
    targetId: String(task.targetId),
    blockedAt: tick,
    until: tick + BUILD_TARGET_SUPPRESSION_TICKS,
    reason
  };
  delete creep.memory.task;
}

function getErrNoPathCode(): ScreepsReturnCode {
  const errNoPath = (globalThis as unknown as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  return typeof errNoPath === 'number' ? errNoPath : ERR_NO_PATH_CODE;
}

function isContainerStructure(target: unknown): boolean {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  return typeof structureType === 'string' && matchesContainerStructureType(structureType);
}

function matchesContainerStructureType(actual: string): boolean {
  const containerType = (globalThis as unknown as { STRUCTURE_CONTAINER?: string }).STRUCTURE_CONTAINER ?? 'container';
  return actual === containerType;
}

function isVisibleSourceContainer(creep: Creep, target: unknown): target is StructureContainer {
  if (!isContainerStructure(target)) {
    return false;
  }

  const container = target as StructureContainer;
  const targetRoom = findVisibleRoomForObject(creep, container);
  if (!targetRoom || typeof FIND_SOURCES !== 'number' || typeof targetRoom.find !== 'function') {
    return false;
  }

  return (targetRoom.find(FIND_SOURCES) as Source[]).some((source) => {
    const sourceContainer = findSourceContainer(targetRoom, source);
    return sourceContainer !== null && String(sourceContainer.id) === String(container.id);
  });
}

function findVisibleRoomForObject(creep: Creep, object: RoomObject): Room | null {
  const roomName = getRoomObjectRoomName(object);
  if (!roomName || creep.room?.name === roomName) {
    return creep.room ?? null;
  }

  return (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName] ?? null;
}

function getRoomObjectRoomName(object: RoomObject): string | null {
  const roomName = (object as RoomObject & { pos?: { roomName?: unknown } }).pos?.roomName;
  return typeof roomName === 'string' && roomName.length > 0 ? roomName : null;
}

function isDedicatedSourceContainerHarvestTask(
  creep: Creep,
  task: CreepTaskMemory
): task is Extract<CreepTaskMemory, { type: 'harvest' }> {
  return isSourceContainerAssignedHarvestTask(task) && findHarvestTaskSourceContainer(creep, task) !== null;
}

function isSourceContainerAssignedHarvestTask(
  task: CreepTaskMemory
): task is Extract<CreepTaskMemory, { type: 'harvest' }> {
  return task.type === 'harvest' && task.sourceContainerAssigned === true;
}

function findHarvestTaskSourceContainer(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'harvest' }>
): StructureContainer | null {
  const source = findHarvestTaskSource(creep, task);
  return source === null ? null : findVisibleHarvestSourceContainer(creep, source);
}

function findHarvestTaskSource(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'harvest' }>
): Source | null {
  if (typeof FIND_SOURCES === 'number' && typeof creep.room?.find === 'function') {
    const visibleSource = creep.room
      .find(FIND_SOURCES)
      .find((source) => String(source.id) === String(task.targetId));
    if (visibleSource) {
      return visibleSource;
    }
  }

  const target = getTaskTarget(task) as Source | null;
  return target && String((target as { id?: unknown }).id) === String(task.targetId) ? target : null;
}

function findVisibleHarvestSourceContainer(creep: Creep, source: Source): StructureContainer | null {
  const sourceRoom = findVisibleSourceRoom(creep, source);
  return sourceRoom ? findSourceContainer(sourceRoom, source) : null;
}

function findVisibleSourceRoom(creep: Creep, source: Source): Room | null {
  const sourceRoomName = getSourceRoomName(source) ?? creep.room?.name;
  if (!sourceRoomName) {
    return null;
  }

  if (creep.room?.name === sourceRoomName) {
    return creep.room;
  }

  return (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[sourceRoomName] ?? null;
}

function getSourceRoomName(source: Source): string | null {
  const roomName = (source as Source & { pos?: { roomName?: unknown } }).pos?.roomName;
  return typeof roomName === 'string' && roomName.length > 0 ? roomName : null;
}

function isInRangeToRoomObject(creep: Creep, target: RoomObject, range: number): boolean {
  const position = (creep as Creep & { pos?: { getRangeTo?: (target: RoomObject) => number } }).pos;
  if (typeof position?.getRangeTo !== 'function') {
    return true;
  }

  const actualRange = position.getRangeTo(target);
  return Number.isFinite(actualRange) && actualRange <= range;
}
