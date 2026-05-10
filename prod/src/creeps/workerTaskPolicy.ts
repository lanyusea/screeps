import { getStorageEnergyReserveThreshold } from '../economy/energyBuffer';
import {
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
  selectWorkerEnergyCriticalAcquisitionTask
} from '../tasks/workerTasks';

export const WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD =
  CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 100;
export const WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN = 250;

type EnergyCriticalReason = WorkerEnergyCriticalPolicyReason;
type EnergyCriticalTask =
  | Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }>
  | Extract<CreepTaskMemory, { type: 'transfer' }>;

export interface WorkerEnergyCriticalAssessment {
  active: boolean;
  reason: EnergyCriticalReason | null;
  spawnEnergy: number | null;
  spawnEnterThreshold: number;
  spawnExitThreshold: number;
  storageEnergy: number | null;
  storageEnterThreshold: number | null;
  storageExitThreshold: number | null;
}

interface EnergyCriticalActivation {
  active: boolean;
  energy: number | null;
  enterThreshold: number;
  exitThreshold: number;
}

export function selectWorkerEnergyCriticalTask(
  creep: Creep,
  currentTask: CreepTaskMemory | null | undefined,
  selectedTask: CreepTaskMemory | null
): EnergyCriticalTask | null {
  const assessment = assessWorkerEnergyCriticalState(creep);
  if (!assessment.active) {
    return null;
  }

  if (selectedTask?.type === 'transfer') {
    return null;
  }

  const avoidStorageWithdrawal = isStorageCritical(assessment);
  const freeCapacity = getFreeEnergyCapacity(creep);
  const shouldPreemptStorageWithdrawal =
    avoidStorageWithdrawal && freeCapacity > 0 && isRoomStorageWithdrawTask(creep, currentTask);

  if (isEnergyAcquisitionTask(currentTask) && freeCapacity > 0 && !shouldPreemptStorageWithdrawal) {
    return currentTask;
  }

  if (!shouldPreemptStorageWithdrawal && !shouldReassignWorkerTaskForEnergyCriticalState(creep, currentTask)) {
    return null;
  }

  const carriedEnergy = getCarriedEnergy(creep);
  if (freeCapacity > 0) {
    const acquisitionTask = selectWorkerEnergyCriticalAcquisitionTask(creep, {
      avoidStorageWithdrawal
    });
    if (acquisitionTask) {
      return acquisitionTask;
    }
  }

  if (carriedEnergy > 0 && avoidStorageWithdrawal) {
    const storageTask = selectStorageEnergyCriticalDeliveryTask(creep, carriedEnergy);
    if (storageTask && !isSameTask(storageTask, selectedTask)) {
      return storageTask;
    }
  }

  return null;
}

export function shouldPreemptForWorkerEnergyCriticalTask(
  currentTask: CreepTaskMemory,
  energyCriticalTask: CreepTaskMemory | null
): boolean {
  return energyCriticalTask !== null && !isSameTask(currentTask, energyCriticalTask);
}

export function assessWorkerEnergyCriticalState(creep: Creep): WorkerEnergyCriticalAssessment {
  const previousMemory = creep.memory?.workerEnergyCriticalPolicy;
  const previousReason = previousMemory?.reason;
  const spawn = assessSpawnEnergyCriticalState(
    creep.room,
    previousReason === 'spawn' || previousReason === 'spawnAndStorage'
  );
  const storage = assessStorageEnergyCriticalState(
    creep.room,
    previousReason === 'storage' || previousReason === 'spawnAndStorage'
  );
  const active = spawn.active || storage.active;
  const reason = getEnergyCriticalReason(spawn.active, storage.active);
  const assessment: WorkerEnergyCriticalAssessment = {
    active,
    reason,
    spawnEnergy: spawn.energy,
    spawnEnterThreshold: spawn.enterThreshold,
    spawnExitThreshold: spawn.exitThreshold,
    storageEnergy: storage.energy,
    storageEnterThreshold: storage.enterThreshold,
    storageExitThreshold: storage.exitThreshold
  };

  updateEnergyCriticalPolicyMemory(creep, assessment, previousMemory);
  return assessment;
}

function assessSpawnEnergyCriticalState(room: Room, wasActive: boolean): EnergyCriticalActivation {
  const energy = getRoomEnergyAvailable(room);
  const enterThreshold = CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD;
  const exitThreshold = WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD;
  if (energy === null) {
    return { active: false, energy, enterThreshold, exitThreshold };
  }

  return {
    active: wasActive ? energy < exitThreshold : energy < enterThreshold,
    energy,
    enterThreshold,
    exitThreshold
  };
}

function assessStorageEnergyCriticalState(room: Room, wasActive: boolean): EnergyCriticalActivation {
  const storage = getRoomStorage(room);
  const enterThreshold = getStorageEnterThreshold(room, storage);
  const exitThreshold = enterThreshold + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN;
  const energy = storage ? getStoredEnergy(storage) : null;
  if (!storage || energy === null || enterThreshold <= 0) {
    return { active: false, energy, enterThreshold, exitThreshold };
  }

  return {
    active: wasActive ? energy < exitThreshold : energy < enterThreshold,
    energy,
    enterThreshold,
    exitThreshold
  };
}

function updateEnergyCriticalPolicyMemory(
  creep: Creep,
  assessment: WorkerEnergyCriticalAssessment,
  previousMemory: WorkerEnergyCriticalPolicyMemory | undefined
): void {
  if (!creep.memory) {
    return;
  }

  if (!assessment.active || !assessment.reason) {
    delete creep.memory.workerEnergyCriticalPolicy;
    return;
  }

  const gameTime = getGameTime();
  creep.memory.workerEnergyCriticalPolicy = {
    type: 'workerEnergyCriticalPolicy',
    schemaVersion: 1,
    active: true,
    reason: assessment.reason,
    enteredAt: previousMemory?.enteredAt ?? gameTime,
    updatedAt: gameTime,
    ...(assessment.spawnEnergy === null
      ? {}
      : {
        spawnEnergy: assessment.spawnEnergy,
        spawnEnterThreshold: assessment.spawnEnterThreshold,
        spawnExitThreshold: assessment.spawnExitThreshold
      }),
    ...(assessment.storageEnergy === null ||
      assessment.storageEnterThreshold === null ||
      assessment.storageExitThreshold === null
      ? {}
      : {
        storageEnergy: assessment.storageEnergy,
        storageEnterThreshold: assessment.storageEnterThreshold,
        storageExitThreshold: assessment.storageExitThreshold
      })
  };
}

function shouldReassignWorkerTaskForEnergyCriticalState(
  creep: Creep,
  task: CreepTaskMemory | null | undefined
): boolean {
  if (!task) {
    return true;
  }

  if (isEnergyAcquisitionTask(task) || isTransferTask(task)) {
    return false;
  }

  if (task.type === 'upgrade') {
    return !isControllerDowngradeGuardTask(creep, task);
  }

  if (task.type === 'repair') {
    // Colony-wide energy failure takes priority over ongoing repairs.
    return true;
  }

  return task.type === 'build' && isNonCriticalConstructionTask(task);
}

function isControllerDowngradeGuardTask(
  creep: Creep,
  task: Extract<CreepTaskMemory, { type: 'upgrade' }>
): boolean {
  const controller = creep.room?.controller;
  return (
    controller?.id === task.targetId &&
    controller.my === true &&
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS
  );
}

function isNonCriticalConstructionTask(task: Extract<CreepTaskMemory, { type: 'build' }>): boolean {
  const site = getGameObjectById<ConstructionSite>(String(task.targetId));
  if (!site) {
    return true;
  }

  return !isCriticalConstructionStructureType(site.structureType);
}

function isCriticalConstructionStructureType(structureType: string): boolean {
  return (
    matchesStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension') ||
    matchesStructureType(structureType, 'STRUCTURE_TOWER', 'tower') ||
    matchesStructureType(structureType, 'STRUCTURE_CONTAINER', 'container') ||
    matchesStructureType(structureType, 'STRUCTURE_ROAD', 'road')
  );
}

function selectStorageEnergyCriticalDeliveryTask(
  creep: Creep,
  carriedEnergy: number
): Extract<CreepTaskMemory, { type: 'transfer' }> | null {
  const storage = getRoomStorage(creep.room);
  if (!storage || getFreeEnergyCapacity(storage) <= 0 || carriedEnergy <= 0) {
    return null;
  }

  return { type: 'transfer', targetId: storage.id as Id<AnyStoreStructure> };
}

function isStorageCritical(assessment: WorkerEnergyCriticalAssessment): boolean {
  return assessment.reason === 'storage' || assessment.reason === 'spawnAndStorage';
}

function isRoomStorageWithdrawTask(
  creep: Creep,
  task: CreepTaskMemory | null | undefined
): task is Extract<CreepTaskMemory, { type: 'withdraw' }> {
  if (task?.type !== 'withdraw') {
    return false;
  }

  const storage = getRoomStorage(creep.room);
  return Boolean(storage && String(task.targetId) === String(storage.id));
}

function getEnergyCriticalReason(spawnActive: boolean, storageActive: boolean): EnergyCriticalReason | null {
  if (spawnActive && storageActive) {
    return 'spawnAndStorage';
  }

  if (spawnActive) {
    return 'spawn';
  }

  return storageActive ? 'storage' : null;
}

function getStorageEnterThreshold(room: Room, storage: StructureStorage | null): number {
  if (!storage) {
    return 0;
  }

  return getStorageEnergyReserveThreshold(room);
}

function getRoomStorage(room: Room): StructureStorage | null {
  const storage = (room as Room & { storage?: StructureStorage }).storage;
  return storage && matchesStructureType(storage.structureType, 'STRUCTURE_STORAGE', 'storage') ? storage : null;
}

function isEnergyAcquisitionTask(
  task: CreepTaskMemory | null | undefined
): task is Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }> {
  return task?.type === 'harvest' || task?.type === 'pickup' || task?.type === 'withdraw';
}

function isTransferTask(
  task: CreepTaskMemory | null | undefined
): task is Extract<CreepTaskMemory, { type: 'transfer' }> {
  return task?.type === 'transfer';
}

function getRoomEnergyAvailable(room: Room): number | null {
  const energyAvailable = (room as Room & { energyAvailable?: unknown }).energyAvailable;
  return typeof energyAvailable === 'number' && Number.isFinite(energyAvailable)
    ? Math.max(0, energyAvailable)
    : null;
}

function getCarriedEnergy(creep: Creep): number {
  const carriedEnergy = creep.store?.getUsedCapacity?.(RESOURCE_ENERGY);
  return typeof carriedEnergy === 'number' && Number.isFinite(carriedEnergy) ? Math.max(0, carriedEnergy) : 0;
}

function getFreeEnergyCapacity(target: { store?: StoreDefinition } | Creep | AnyStoreStructure): number {
  const freeCapacity = target.store?.getFreeCapacity?.(RESOURCE_ENERGY);
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getStoredEnergy(target: { store?: StoreDefinition }): number | null {
  const storedEnergy = target.store?.getUsedCapacity?.(RESOURCE_ENERGY);
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : null;
}

function isSameTask(left: CreepTaskMemory | null | undefined, right: CreepTaskMemory | null | undefined): boolean {
  return Boolean(left && right && left.type === right.type && left.targetId === right.targetId);
}

function getGameObjectById<T>(id: string): T | null {
  const game = (globalThis as unknown as { Game?: Partial<Pick<Game, 'getObjectById'>> }).Game;
  const object = game?.getObjectById?.(id);
  return object ? (object as unknown as T) : null;
}

function getGameTime(): number {
  const time = (globalThis as unknown as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : 0;
}

function matchesStructureType(
  actual: string | undefined,
  globalName:
    | 'STRUCTURE_CONTAINER'
    | 'STRUCTURE_EXTENSION'
    | 'STRUCTURE_ROAD'
    | 'STRUCTURE_SPAWN'
    | 'STRUCTURE_STORAGE'
    | 'STRUCTURE_TOWER',
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<typeof globalName, string>>;
  return actual === (constants[globalName] ?? fallback);
}
