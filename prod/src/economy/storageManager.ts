import { classifyLinks } from './linkManager';

type ManagedEnergyStructure = StructureSpawn | StructureExtension | StructureTower | StructureLink;
type StorageStructureConstantGlobal =
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_LINK'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TOWER';

export const STORAGE_EMERGENCY_BUFFER = 1_000;
export const TOWER_REFILL_THRESHOLD = 500;

export interface StorageLinkTransferResult {
  amount: number;
  destinationId: string;
  result: ScreepsReturnCode;
  sourceId: string;
}

export interface StorageManagementResult {
  assignedTasks: number;
  linkTransfers: StorageLinkTransferResult[];
}

interface EnergyDemandTarget {
  freeCapacity: number;
  id: string;
  priority: number;
  target: ManagedEnergyStructure;
}

interface EnergyDemandState {
  remainingCapacityById: Map<string, number>;
  targets: EnergyDemandTarget[];
}

export function manageStorage(room: Room): StorageManagementResult {
  const storage = getRoomStorage(room);
  if (!storage) {
    return { assignedTasks: 0, linkTransfers: [] };
  }

  const linkTransfers = transferStorageLinkEnergy(room);
  const storageEnergy = getStoredEnergy(storage);
  if (storageEnergy <= 0) {
    return { assignedTasks: 0, linkTransfers };
  }

  const demandState = buildEnergyDemandState(room);
  if (!hasRemainingDemand(demandState)) {
    return { assignedTasks: 0, linkTransfers };
  }

  const workers = findStorageManagementWorkers(room, storage, demandState);
  const projectedStorageEnergy = reserveExistingAssignments(workers, storage, demandState, storageEnergy);
  const assignedTasks =
    assignLoadedWorkers(workers, demandState) +
    assignStorageWithdrawals(workers, storage, demandState, projectedStorageEnergy);

  return { assignedTasks, linkTransfers };
}

function transferStorageLinkEnergy(room: Room): StorageLinkTransferResult[] {
  const { controllerLink, storageLink } = classifyLinks(room);
  if (!controllerLink || !storageLink || getObjectId(controllerLink) === getObjectId(storageLink)) {
    return [];
  }

  if (hasPriorityEnergyDemandBeforeControllerLink(room)) {
    return [];
  }

  if (getLinkCooldown(storageLink) > 0) {
    return [];
  }

  const storedEnergy = getStoredEnergy(storageLink);
  const destinationFreeCapacity = getFreeEnergyCapacity(controllerLink);
  const amount = Math.min(storedEnergy, destinationFreeCapacity);
  if (amount <= 0) {
    return [];
  }

  return [
    {
      amount,
      destinationId: getObjectId(controllerLink),
      result: transferLinkEnergy(storageLink, controllerLink, amount),
      sourceId: getObjectId(storageLink)
    }
  ];
}

function hasPriorityEnergyDemandBeforeControllerLink(room: Room): boolean {
  return findSpawnExtensionRefillTargets(room).length > 0 || findTowerRefillTargets(room).length > 0;
}

function transferLinkEnergy(sourceLink: StructureLink, destinationLink: StructureLink, amount: number): ScreepsReturnCode {
  return (sourceLink as StructureLink & {
    transfer: (target: StructureLink, amount?: number) => ScreepsReturnCode;
  }).transfer(destinationLink, amount);
}

function buildEnergyDemandState(room: Room): EnergyDemandState {
  const targets = [
    ...findSpawnExtensionRefillTargets(room),
    ...findTowerRefillTargets(room),
    ...findStorageLinkRefillTargets(room)
  ].sort(compareDemandTargets);

  return {
    remainingCapacityById: new Map(targets.map((target) => [target.id, target.freeCapacity])),
    targets
  };
}

function findSpawnExtensionRefillTargets(room: Room): EnergyDemandTarget[] {
  const structures = findOwnedStructures(room).filter(
    (structure): structure is StructureSpawn | StructureExtension =>
      (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
        matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')) &&
      getFreeEnergyCapacity(structure) > 0
  );
  if (!isRoomSpawnExtensionEnergyLow(room, structures)) {
    return [];
  }

  return structures.map((target) => ({
    freeCapacity: getFreeEnergyCapacity(target),
    id: getObjectId(target),
    priority: 3,
    target
  }));
}

function findTowerRefillTargets(room: Room): EnergyDemandTarget[] {
  return findOwnedStructures(room)
    .filter(
      (structure): structure is StructureTower =>
        matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower') &&
        getStoredEnergy(structure) < TOWER_REFILL_THRESHOLD &&
        getFreeEnergyCapacity(structure) > 0
    )
    .map((target) => ({
      freeCapacity: getFreeEnergyCapacity(target),
      id: getObjectId(target),
      priority: 2,
      target
    }));
}

function findStorageLinkRefillTargets(room: Room): EnergyDemandTarget[] {
  const { controllerLink, storageLink } = classifyLinks(room);
  if (!controllerLink || !storageLink || getObjectId(controllerLink) === getObjectId(storageLink)) {
    return [];
  }

  if (getFreeEnergyCapacity(controllerLink) <= 0 || getFreeEnergyCapacity(storageLink) <= 0) {
    return [];
  }

  return [
    {
      freeCapacity: getFreeEnergyCapacity(storageLink),
      id: getObjectId(storageLink),
      priority: 1,
      target: storageLink
    }
  ];
}

function isRoomSpawnExtensionEnergyLow(
  room: Room,
  structures: Array<StructureSpawn | StructureExtension>
): boolean {
  if (structures.length === 0) {
    return false;
  }

  const energyAvailable = room.energyAvailable;
  const energyCapacityAvailable = room.energyCapacityAvailable;
  if (
    typeof energyAvailable === 'number' &&
    Number.isFinite(energyAvailable) &&
    typeof energyCapacityAvailable === 'number' &&
    Number.isFinite(energyCapacityAvailable)
  ) {
    return energyAvailable < energyCapacityAvailable;
  }

  return structures.some((structure) => getFreeEnergyCapacity(structure) > 0);
}

function findStorageManagementWorkers(
  room: Room,
  storage: StructureStorage,
  demandState: EnergyDemandState
): Creep[] {
  const storageId = getObjectId(storage);
  const demandTargetIds = new Set(demandState.targets.map((target) => target.id));
  return findMyCreeps(room)
    .filter((creep) => isEligibleStorageManagementWorker(creep, room.name))
    .filter((creep) => isAssignableStorageManagementWorker(creep, storageId, demandTargetIds))
    .sort(compareWorkers);
}

function reserveExistingAssignments(
  workers: Creep[],
  storage: StructureStorage,
  demandState: EnergyDemandState,
  storageEnergy: number
): number {
  let projectedStorageEnergy = storageEnergy;
  const storageId = getObjectId(storage);

  for (const worker of workers) {
    const task = worker.memory.task;
    if (task?.type === 'transfer') {
      const targetId = String(task.targetId);
      const remainingCapacity = demandState.remainingCapacityById.get(targetId);
      if (typeof remainingCapacity === 'number') {
        demandState.remainingCapacityById.set(
          targetId,
          Math.max(0, remainingCapacity - getCarriedEnergy(worker))
        );
      }
    }

    if (task?.type === 'withdraw' && String(task.targetId) === storageId) {
      projectedStorageEnergy -= getFreeEnergyCapacity(worker);
    }
  }

  return Math.max(0, projectedStorageEnergy);
}

function assignLoadedWorkers(workers: Creep[], demandState: EnergyDemandState): number {
  let assignedTasks = 0;
  for (const worker of workers) {
    const carriedEnergy = getCarriedEnergy(worker);
    if (carriedEnergy <= 0) {
      continue;
    }

    if (isExistingDemandTransfer(worker, demandState)) {
      continue;
    }

    const target = selectDemandTarget(worker, demandState);
    if (!target) {
      continue;
    }

    if (setWorkerTask(worker, { type: 'transfer', targetId: target.target.id as Id<AnyStoreStructure> })) {
      assignedTasks += 1;
    }
    reserveDemandCapacity(demandState, target.id, carriedEnergy);
  }

  return assignedTasks;
}

function assignStorageWithdrawals(
  workers: Creep[],
  storage: StructureStorage,
  demandState: EnergyDemandState,
  initialProjectedStorageEnergy: number
): number {
  let assignedTasks = 0;
  let projectedStorageEnergy = initialProjectedStorageEnergy;

  for (const worker of workers) {
    if (!hasRemainingDemand(demandState) || getCarriedEnergy(worker) > 0) {
      continue;
    }

    if (worker.memory.task?.type === 'withdraw' && String(worker.memory.task.targetId) === String(storage.id)) {
      continue;
    }

    const freeCapacity = getFreeEnergyCapacity(worker);
    const plannedWithdrawal = Math.min(freeCapacity, projectedStorageEnergy);
    if (plannedWithdrawal <= 0 || projectedStorageEnergy - plannedWithdrawal <= STORAGE_EMERGENCY_BUFFER) {
      continue;
    }

    if (setWorkerTask(worker, { type: 'withdraw', targetId: storage.id as Id<AnyStoreStructure> })) {
      assignedTasks += 1;
    }
    projectedStorageEnergy -= plannedWithdrawal;
  }

  return assignedTasks;
}

function isExistingDemandTransfer(worker: Creep, demandState: EnergyDemandState): boolean {
  const task = worker.memory.task;
  return task?.type === 'transfer' && demandState.remainingCapacityById.has(String(task.targetId));
}

function selectDemandTarget(worker: Creep, demandState: EnergyDemandState): EnergyDemandTarget | null {
  const availableTargets = demandState.targets.filter(
    (target) => (demandState.remainingCapacityById.get(target.id) ?? 0) > 0
  );
  if (availableTargets.length === 0) {
    return null;
  }

  return [...availableTargets].sort((left, right) => compareDemandTargetsForWorker(worker, left, right))[0] ?? null;
}

function reserveDemandCapacity(demandState: EnergyDemandState, targetId: string, amount: number): void {
  demandState.remainingCapacityById.set(
    targetId,
    Math.max(0, (demandState.remainingCapacityById.get(targetId) ?? 0) - amount)
  );
}

function hasRemainingDemand(demandState: EnergyDemandState): boolean {
  return [...demandState.remainingCapacityById.values()].some((capacity) => capacity > 0);
}

function setWorkerTask(worker: Creep, task: CreepTaskMemory): boolean {
  if (worker.memory.task?.type === task.type && String(worker.memory.task.targetId) === String(task.targetId)) {
    return false;
  }

  worker.memory.task = task;
  return true;
}

function isEligibleStorageManagementWorker(creep: Creep, roomName: string): boolean {
  if (creep.memory.role !== 'worker' || creep.room?.name !== roomName) {
    return false;
  }

  if (creep.memory.colony && creep.memory.colony !== roomName) {
    return false;
  }

  return !creep.memory.controllerSustain && !creep.memory.territory;
}

function isAssignableStorageManagementWorker(
  creep: Creep,
  storageId: string,
  demandTargetIds: Set<string>
): boolean {
  const task = creep.memory.task;
  if (!task) {
    return true;
  }

  if (task.type === 'claim' || task.type === 'reserve') {
    return false;
  }

  if (task.type === 'withdraw') {
    return String(task.targetId) === storageId;
  }

  return task.type === 'transfer' && demandTargetIds.has(String(task.targetId));
}

function compareDemandTargetsForWorker(
  worker: Creep,
  left: EnergyDemandTarget,
  right: EnergyDemandTarget
): number {
  return (
    right.priority - left.priority ||
    compareOptionalRange(worker, left.target, right.target) ||
    left.id.localeCompare(right.id)
  );
}

function compareDemandTargets(left: EnergyDemandTarget, right: EnergyDemandTarget): number {
  return right.priority - left.priority || left.id.localeCompare(right.id);
}

function compareOptionalRange(worker: Creep, left: RoomObject, right: RoomObject): number {
  const getRangeTo = worker.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return 0;
  }

  const leftRange = getRangeTo.call(worker.pos, left);
  const rightRange = getRangeTo.call(worker.pos, right);
  return normalizeRange(leftRange) - normalizeRange(rightRange);
}

function normalizeRange(range: unknown): number {
  return typeof range === 'number' && Number.isFinite(range) ? range : Number.POSITIVE_INFINITY;
}

function compareWorkers(left: Creep, right: Creep): number {
  return getWorkerId(left).localeCompare(getWorkerId(right));
}

function getWorkerId(creep: Creep): string {
  const name = (creep as Creep & { name?: unknown }).name;
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }

  const id = (creep as Creep & { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function getRoomStorage(room: Room): StructureStorage | null {
  if (room.storage) {
    return room.storage;
  }

  return (
    findOwnedStructures(room).filter((structure): structure is StructureStorage =>
      matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage')
    )[0] ?? null
  );
}

function findOwnedStructures(room: Room): AnyOwnedStructure[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = room.find(FIND_MY_STRUCTURES);
  return Array.isArray(result) ? result : [];
}

function findMyCreeps(room: Room): Creep[] {
  if (typeof FIND_MY_CREEPS !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = room.find(FIND_MY_CREEPS);
  return Array.isArray(result) ? result : [];
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store;
  const storedEnergy = store?.getUsedCapacity?.(getEnergyResource());
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getFreeEnergyCapacity(target: unknown): number {
  const store = (target as { store?: { getFreeCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store;
  const freeCapacity = store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
}

function getLinkCooldown(link: StructureLink): number {
  return typeof link.cooldown === 'number' && Number.isFinite(link.cooldown) ? link.cooldown : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
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

function matchesStructureType(
  actual: string | undefined,
  globalName: StorageStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<StorageStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}
