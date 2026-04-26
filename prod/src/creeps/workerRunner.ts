import { selectWorkerTask } from '../tasks/workerTasks';

const ERR_FULL_RESULT: ScreepsReturnCode = -8;

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
  if (task.type === 'transfer' && result === ERR_FULL_RESULT) {
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

  if (task.type === 'harvest') {
    return freeEnergyCapacity === 0;
  }

  return usedEnergy === 0;
}

function shouldReplaceTarget(task: CreepTaskMemory, target: Source | AnyStoreStructure | ConstructionSite | StructureController): boolean {
  return task.type === 'transfer' && 'store' in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
}

function executeTask(creep: Creep, task: CreepTaskMemory, target: Source | AnyStoreStructure | ConstructionSite | StructureController): ScreepsReturnCode {
  switch (task.type) {
    case 'harvest':
      return creep.harvest(target as Source);
    case 'transfer':
      return creep.transfer(target as AnyStoreStructure, RESOURCE_ENERGY);
    case 'build':
      return creep.build(target as ConstructionSite);
    case 'upgrade':
      return creep.upgradeController(target as StructureController);
  }
}
