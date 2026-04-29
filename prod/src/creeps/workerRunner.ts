import {
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  isWorkerRepairTargetComplete,
  selectWorkerTask,
  shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill
} from '../tasks/workerTasks';
import { signOccupiedControllerIfNeeded } from '../territory/controllerSigning';

type TransferSinkStructureConstantGlobal = 'STRUCTURE_SPAWN' | 'STRUCTURE_EXTENSION' | 'STRUCTURE_TOWER';
type CapacityConstructionStructureConstantGlobal = 'STRUCTURE_SPAWN' | 'STRUCTURE_EXTENSION';

const MAX_IMMEDIATE_RESELECT_EXECUTIONS = 1;

export function runWorker(creep: Creep): void {
  const selectedTask = selectWorkerTask(creep);
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
  } else if (shouldPreemptEnergyAcquisitionTaskForNearbyEnergyChoice(creep, currentTask, selectedTask)) {
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

function executeAssignedTask(
  creep: Creep,
  selectedTask: CreepTaskMemory | null,
  immediateReselectExecutions = 0
): void {
  let task: CreepTaskMemory | null | undefined = creep.memory.task;
  if (!task || !canExecuteTask(creep, task)) {
    return;
  }

  let target = Game.getObjectById(task.targetId);
  if (!target) {
    if (selectedTask && isSameTask(task, selectedTask)) {
      return;
    }

    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      return;
    }

    target = Game.getObjectById(task.targetId);
    if (!target) {
      return;
    }
  }

  if (shouldReplaceTarget(task, target)) {
    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      return;
    }

    target = Game.getObjectById(task.targetId);
    if (!target || shouldReplaceTarget(task, target)) {
      return;
    }
  }

  const result = executeTask(creep, task, target);
  if (shouldImmediatelyReselectAfterTaskResult(task, result)) {
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

  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(target as RoomObject);
  }
}

function shouldImmediatelyReselectAfterTaskResult(task: CreepTaskMemory, result: ScreepsReturnCode): boolean {
  if (task.type === 'transfer') {
    return result === ERR_FULL;
  }

  return isEnergyAcquisitionTask(task) && isUnavailableEnergyAcquisitionResult(result);
}

function isUnavailableEnergyAcquisitionResult(result: ScreepsReturnCode): boolean {
  return result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET;
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
  const task = selectWorkerTask(creep);
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

  if (!selectedTask || isSameTask(task, selectedTask)) {
    return false;
  }

  if (!creep.store?.getUsedCapacity) {
    return false;
  }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
    return false;
  }

  return isUrgentEnergySpendingTask(selectedTask);
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
  return getTransferSinkPriority(selectedTarget) > getTransferSinkPriority(currentTarget);
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

function getTransferSinkPriority(target: unknown): number {
  const structureType = (target as { structureType?: unknown } | null)?.structureType;
  if (typeof structureType !== 'string') {
    return 0;
  }

  if (
    matchesTransferSinkStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesTransferSinkStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension')
  ) {
    return 2;
  }

  return matchesTransferSinkStructureType(structureType, 'STRUCTURE_TOWER', 'tower') ? 1 : 0;
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
  task: CreepTaskMemory,
  target: Source | Resource<ResourceConstant> | AnyStoreStructure | ConstructionSite | StructureController | Structure
): boolean {
  if (task.type === 'harvest' && isDepletedHarvestSource(target)) {
    return true;
  }

  if (task.type === 'transfer' && 'store' in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    return true;
  }

  if (task.type === 'withdraw' && 'store' in target && (target.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) === 0) {
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
): ScreepsReturnCode {
  switch (task.type) {
    case 'harvest':
      return creep.harvest(target as Source);
    case 'pickup':
      return creep.pickup(target as Resource<ResourceConstant>);
    case 'withdraw':
      return creep.withdraw(target as AnyStoreStructure, RESOURCE_ENERGY);
    case 'transfer':
      return creep.transfer(target as AnyStoreStructure, RESOURCE_ENERGY);
    case 'build':
      return creep.build(target as ConstructionSite);
    case 'repair':
      return creep.repair(target as Structure);
    case 'claim':
      return creep.claimController(target as StructureController);
    case 'reserve':
      return creep.reserveController(target as StructureController);
    case 'upgrade':
      signOccupiedControllerIfNeeded(creep, target as StructureController);
      return creep.upgradeController(target as StructureController);
  }
}
