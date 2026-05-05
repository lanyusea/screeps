import {
  CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  selectWorkerPreHarvestTask,
  isUpgraderBoostActive,
  isWorkerRepairTargetComplete,
  selectWorkerTask,
  shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill
} from '../tasks/workerTasks';
import { signOccupiedControllerIfNeeded } from '../territory/controllerSigning';
import { canCreepPressureTerritoryController } from '../territory/territoryPlanner';
import { checkEnergyBufferForSpending } from '../economy/energyBuffer';
import { findSourceContainer } from '../economy/sourceContainers';
import {
  observeCreepBehaviorTick,
  recordCreepBehaviorContainerTransfer,
  recordCreepBehaviorIdle,
  recordCreepBehaviorMove,
  recordCreepBehaviorRepairTarget,
  recordCreepBehaviorWork
} from '../telemetry/behaviorTelemetry';

type TransferSinkStructureConstantGlobal =
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_LINK'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_TOWER';
type CapacityConstructionStructureConstantGlobal = 'STRUCTURE_SPAWN' | 'STRUCTURE_EXTENSION';

const MAX_IMMEDIATE_RESELECT_EXECUTIONS = 1;
const WORKER_NULL_LOOP_TICK_WINDOW = 10;
const WORKER_STANDBY_IDLE_TIMEOUT_TICKS = 8;
const WORKER_NULL_LOOP_FALLBACK_ATTEMPTS = 2;
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const MIN_HAULER_DROPPED_ENERGY = 25;

interface WorkerTaskSelectionNullLoopState {
  lastNullSelectionTick: number;
  nullSelectionCount: number;
  fallbackAttempts: number;
  idleStartTick: number;
}

interface TaskExecutionResult {
  result: ScreepsReturnCode;
  action?: 'move' | 'work';
  containerTransfer?: boolean;
}

export function runWorker(creep: Creep): void {
  if (runControllerSustainMovement(creep)) {
    return;
  }
  observeCreepBehaviorTick(creep);

  const selectedTask = selectWorkerTaskForRunner(creep);
  const currentTask = creep.memory.task;

  if (!currentTask) {
    assignSelectedTask(creep, selectedTask);
  } else if (shouldReplaceTask(creep, currentTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptForVisibleTerritoryControllerTask(currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptEnergyAcquisitionTaskForUrgentEnergySpending(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptTaskForUpgraderBoost(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptEnergyAcquisitionTaskForNearbyEnergyChoice(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptLowLoadReturnTaskForEnergyAcquisition(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptTransferTaskForControllerDowngradeGuard(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptTransferTaskForBetterEnergySink(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptSpendingTaskForNearTermSpawnExtensionRefill(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptSpendingTaskForEnergySink(currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptSpendingTaskForControllerPressure(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptUpgradeTask(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  }

  executeAssignedTask(creep, selectedTask);
}

function selectWorkerTaskForRunner(creep: Creep): CreepTaskMemory | null {
  const selectedTask = selectWorkerTask(creep);
  return fallbackToEnergyOnNullSelectionLoop(creep, selectedTask);
}

function fallbackToEnergyOnNullSelectionLoop(
  creep: Creep,
  selectedTask: CreepTaskMemory | null
): CreepTaskMemory | null {
  if (selectedTask) {
    delete creep.memory.workerTaskSelectionNullLoop;
    return selectedTask;
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

function clearAssignedTask(creep: Creep): void {
  delete creep.memory.task;
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
    selectControllerSustainStoredEnergyTask(creep) ??
    selectControllerSustainDroppedEnergyTask(creep) ??
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
    .sort((left, right) => compareRoomObjectsByRangeAndId(creep, left, right))[0];

  return source ? { type: 'withdraw', targetId: source.id as Id<AnyStoreStructure> } : null;
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

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
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

  let target = Game.getObjectById(task.targetId);
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

    target = Game.getObjectById(task.targetId);
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

    target = Game.getObjectById(task.targetId);
    if (!target || shouldReplaceTarget(creep, task, target)) {
      recordCreepBehaviorIdle(creep);
      return;
    }
  }

  const execution = executeTask(creep, task, target);
  recordTaskBehavior(creep, task, execution);
  if (shouldImmediatelyReselectAfterTaskResult(task, execution.result)) {
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
    creep.moveTo(target as RoomObject);
    recordCreepBehaviorMove(creep);
  }
}

function shouldImmediatelyReselectAfterTaskResult(task: CreepTaskMemory, result: ScreepsReturnCode): boolean {
  if (task.type === 'transfer') {
    return result === ERR_FULL_CODE;
  }

  return isEnergyAcquisitionTask(task) && isUnavailableEnergyAcquisitionResult(result);
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
    return null;
  }

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
    case 'upgrade':
      return typeof creep.upgradeController === 'function';
  }
}

function assignNextTask(creep: Creep): CreepTaskMemory | null {
  const task = selectWorkerTaskForRunner(creep);
  if (task) {
    creep.memory.task = task;
  }

  return task;
}

function shouldReplaceTask(creep: Creep, task: CreepTaskMemory): boolean {
  if (isTerritoryControlTask(task)) {
    return false;
  }

  if (!creep.store?.getUsedCapacity || !creep.store?.getFreeCapacity) {
    return false;
  }

  const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const freeEnergyCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);

  if (task.type === 'harvest' || task.type === 'pickup' || task.type === 'withdraw') {
    if (task.type === 'harvest') {
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

function shouldPreemptEnergyAcquisitionTaskForUrgentEnergySpending(
  creep: Creep,
  task: CreepTaskMemory,
  selectedTask: CreepTaskMemory | null
): boolean {
  if (!isEnergyAcquisitionTask(task)) {
    return false;
  }

  if (isDedicatedSourceContainerHarvestTask(creep, task)) {
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

  return isUrgentEnergySpendingTask(selectedTask) || isDowngradeGuardUpgradeTask(creep, selectedTask);
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
    isCurrentWorkerEfficiencySample(sample)
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
  return left.type === right.type && left.targetId === right.targetId;
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
    if (isSameCreep(worker, creep) || !isSameRoomWorkerWithEnergy(worker, creep.room)) {
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

  return task.type === 'build' && isCapacityEnablingConstructionSite(target);
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
    matchesCapacityConstructionStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesCapacityConstructionStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension')
  );
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

function isSameRoomWorkerWithEnergy(creep: Creep, room: Room): boolean {
  return creep.memory?.role === 'worker' && isInRoom(creep, room) && getUsedTransferEnergy(creep) > 0;
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

function matchesCapacityConstructionStructureType(
  actual: string,
  globalName: CapacityConstructionStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<CapacityConstructionStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function shouldReplaceTarget(
  creep: Creep,
  task: CreepTaskMemory,
  target: Source | Resource<ResourceConstant> | AnyStoreStructure | ConstructionSite | StructureController | Structure
): boolean {
  if (task.type === 'harvest' && isDepletedHarvestSource(target)) {
    return !findSourceContainer(creep.room, target);
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

  return task.type === 'repair' && 'hits' in target && isWorkerRepairTargetComplete(target);
}

function isDepletedHarvestSource(target: unknown): target is Source {
  const energy = (target as Partial<Source> | null)?.energy;
  return typeof energy === 'number' && energy <= 0;
}

function executeTask(
  creep: Creep,
  task: CreepTaskMemory,
  target: Source | Resource<ResourceConstant> | AnyStoreStructure | ConstructionSite | StructureController | Structure
): TaskExecutionResult {
  switch (task.type) {
    case 'harvest':
      return executeHarvestTask(creep, target as Source);
    case 'pickup':
      return toTaskExecutionResult(creep.pickup(target as Resource<ResourceConstant>), 'work');
    case 'withdraw':
      return toTaskExecutionResult(creep.withdraw(target as AnyStoreStructure, RESOURCE_ENERGY), 'work');
    case 'transfer':
      return toTaskExecutionResult(creep.transfer(target as AnyStoreStructure, RESOURCE_ENERGY), 'work', {
        containerTransfer: isContainerStructure(target)
      });
    case 'build':
      if (!checkEnergyBufferForSpending(creep.room, getCarriedEnergy(creep))) {
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
    case 'upgrade':
      signOccupiedControllerIfNeeded(creep, target as StructureController);
      return toTaskExecutionResult(creep.upgradeController(target as StructureController), 'work');
  }
}

function executeHarvestTask(creep: Creep, source: Source): TaskExecutionResult {
  const sourceContainer = findVisibleHarvestSourceContainer(creep, source);
  if (!sourceContainer) {
    return toTaskExecutionResult(creep.harvest(source), 'work');
  }

  if (!isInRangeToRoomObject(creep, source, 1)) {
    creep.moveTo(sourceContainer);
    return { result: OK_CODE, action: 'move' };
  }

  if (isDepletedHarvestSource(source)) {
    return getUsedTransferEnergy(creep) > 0
      ? transferDedicatedHarvestEnergy(creep, sourceContainer)
      : { result: OK_CODE };
  }

  if (getFreeTransferEnergyCapacity(creep) <= 0 && getUsedTransferEnergy(creep) > 0) {
    return transferDedicatedHarvestEnergy(creep, sourceContainer);
  }

  const result = creep.harvest(source);
  if (
    ((result as ScreepsReturnCode) === ERR_FULL_CODE || result === ERR_NOT_ENOUGH_RESOURCES_CODE) &&
    getUsedTransferEnergy(creep) > 0
  ) {
    return transferDedicatedHarvestEnergy(creep, sourceContainer);
  }

  return toTaskExecutionResult(result === ERR_NOT_ENOUGH_RESOURCES_CODE ? OK_CODE : result, 'work');
}

function transferDedicatedHarvestEnergy(creep: Creep, sourceContainer: StructureContainer): TaskExecutionResult {
  if (typeof creep.transfer !== 'function') {
    return { result: OK_CODE };
  }

  const result = creep.transfer(sourceContainer, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    creep.moveTo(sourceContainer);
    return { result: OK_CODE, action: 'move' };
  }

  return toTaskExecutionResult(result, 'work', { containerTransfer: true });
}

function toTaskExecutionResult(
  result: ScreepsReturnCode,
  successAction: 'move' | 'work',
  options: { containerTransfer?: boolean } = {}
): TaskExecutionResult {
  return {
    result,
    ...(result === OK_CODE ? { action: successAction } : {}),
    ...(result === OK_CODE && options.containerTransfer ? { containerTransfer: true } : {})
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
  } else if (execution.result !== ERR_NOT_IN_RANGE_CODE) {
    recordCreepBehaviorIdle(creep);
  }

  if (execution.containerTransfer) {
    recordCreepBehaviorContainerTransfer(creep);
  }
}

function isContainerStructure(target: unknown): boolean {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  return typeof structureType === 'string' && matchesContainerStructureType(structureType);
}

function matchesContainerStructureType(actual: string): boolean {
  const containerType = (globalThis as unknown as { STRUCTURE_CONTAINER?: string }).STRUCTURE_CONTAINER ?? 'container';
  return actual === containerType;
}

function isDedicatedSourceContainerHarvestTask(
  creep: Creep,
  task: CreepTaskMemory
): task is Extract<CreepTaskMemory, { type: 'harvest' }> {
  return task.type === 'harvest' && findHarvestTaskSourceContainer(creep, task) !== null;
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
