import { selectWorkerTask } from '../tasks/workerTasks';

export function runWorker(creep: Creep): void {
  if (!creep.memory.task) {
    const task = selectWorkerTask(creep);
    if (!task) {
      return;
    }
    creep.memory.task = task;
    return;
  }

  const task = creep.memory.task;
  const target = Game.getObjectById(task.targetId);
  if (!target) {
    delete creep.memory.task;
    return;
  }

  const result = executeTask(creep, task, target);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(target as RoomObject);
  }
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
