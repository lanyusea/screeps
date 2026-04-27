import { selectWorkerTask } from '../tasks/workerTasks';

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

  if (shouldPreemptRcl2UpgradeTask(creep, creep.memory.task)) {
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
  if (!creep.store?.getUsedCapacity || !creep.store?.getFreeCapacity) {
    return false;
  }

  const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const freeEnergyCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);

  if (task.type === 'harvest' || task.type === 'pickup') {
    return freeEnergyCapacity === 0;
  }

  return usedEnergy === 0;
}

function shouldPreemptRcl2UpgradeTask(creep: Creep, task: CreepTaskMemory): boolean {
  if (task.type !== 'upgrade') {
    return false;
  }

  const controller = creep.room?.controller;
  if (controller?.my !== true || controller.level !== 2) {
    return false;
  }

  const nextTask = selectWorkerTask(creep);
  return nextTask !== null && (nextTask.type !== task.type || nextTask.targetId !== task.targetId);
}

function shouldReplaceTarget(
  task: CreepTaskMemory,
  target: Source | Resource<ResourceConstant> | AnyStoreStructure | ConstructionSite | StructureController
): boolean {
  return task.type === 'transfer' && 'store' in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
}

function executeTask(
  creep: Creep,
  task: CreepTaskMemory,
  target: Source | Resource<ResourceConstant> | AnyStoreStructure | ConstructionSite | StructureController
): ScreepsReturnCode {
  switch (task.type) {
    case 'harvest':
      return creep.harvest(target as Source);
    case 'pickup':
      return creep.pickup(target as Resource<ResourceConstant>);
    case 'transfer':
      return creep.transfer(target as AnyStoreStructure, RESOURCE_ENERGY);
    case 'build':
      return creep.build(target as ConstructionSite);
    case 'upgrade':
      return creep.upgradeController(target as StructureController);
  }
}
