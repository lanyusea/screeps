import { isWorkerRepairTargetComplete, selectWorkerTask } from '../tasks/workerTasks';
import { selectVisibleTerritoryControllerTask } from '../territory/territoryPlanner';

export function runWorker(creep: Creep): void {
  if (!creep.memory.task) {
    assignNextTask(creep);
    return;
  }

  if (shouldReplaceTask(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  if (shouldPreemptForVisibleTerritoryControllerTask(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  if (shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  if (shouldPreemptSpendingTaskForEnergySink(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  if (shouldPreemptSpendingTaskForControllerPressure(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  if (shouldPreemptUpgradeTask(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  const task = creep.memory.task;
  const target = Game.getObjectById(task.targetId);
  if (!target) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  if (shouldReplaceTarget(task, target)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  const result = executeTask(creep, task, target);
  if (task.type === 'transfer' && result === ERR_FULL) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }

  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(target as RoomObject);
  }
}

function assignNextTask(creep: Creep): void {
  const task = selectWorkerTask(creep);
  if (task) {
    creep.memory.task = task;
  }
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

function shouldPreemptForVisibleTerritoryControllerTask(creep: Creep, task: CreepTaskMemory): boolean {
  const controllerTask = selectVisibleTerritoryControllerTask(creep);
  if (!controllerTask) {
    return isTerritoryControlTask(task);
  }

  const selectedTask = selectWorkerTask(creep);
  if (!selectedTask || !isSameTask(selectedTask, controllerTask)) {
    return false;
  }

  return !isSameTask(task, controllerTask);
}

function shouldPreemptSpendingTaskForEnergySink(creep: Creep, task: CreepTaskMemory): boolean {
  if (!isEnergySpendingTask(task)) {
    return false;
  }

  if (!creep.room) {
    return false;
  }

  const nextTask = selectWorkerTask(creep);
  return nextTask?.type === 'transfer' && !isSameTask(task, nextTask);
}

function shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep: Creep, task: CreepTaskMemory): boolean {
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

  const nextTask = selectWorkerTask(creep);
  return isRecoverableEnergyTask(nextTask) && !isSameTask(task, nextTask);
}

function shouldPreemptSpendingTaskForControllerPressure(creep: Creep, task: CreepTaskMemory): boolean {
  if (!isEnergySpendingTask(task) || task.type === 'upgrade') {
    return false;
  }

  if (typeof creep.room?.find !== 'function') {
    return false;
  }

  const nextTask = selectWorkerTask(creep);
  return isOwnedControllerUpgradeTask(creep, nextTask) && !isSameTask(task, nextTask);
}

function shouldPreemptUpgradeTask(creep: Creep, task: CreepTaskMemory): boolean {
  if (task.type !== 'upgrade') {
    return false;
  }

  const controller = creep.room?.controller;
  if (controller?.my !== true) {
    return false;
  }

  const nextTask = selectWorkerTask(creep);
  if (nextTask === null || (nextTask.type === task.type && nextTask.targetId === task.targetId)) {
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

function isTerritoryControlTask(task: CreepTaskMemory): task is Extract<CreepTaskMemory, { type: 'claim' | 'reserve' }> {
  return task.type === 'claim' || task.type === 'reserve';
}

function shouldReplaceTarget(
  task: CreepTaskMemory,
  target: Source | Resource<ResourceConstant> | AnyStoreStructure | ConstructionSite | StructureController | Structure
): boolean {
  if (task.type === 'transfer' && 'store' in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    return true;
  }

  if (task.type === 'withdraw' && 'store' in target && (target.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) === 0) {
    return true;
  }

  return task.type === 'repair' && 'hits' in target && isWorkerRepairTargetComplete(target);
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
      return creep.upgradeController(target as StructureController);
  }
}
