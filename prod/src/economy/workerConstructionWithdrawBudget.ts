import { getConstructionSpendingEnergyThreshold } from './energyBuffer';
import { getSpawnEnergyWithdrawalAmount, isSpawnEnergySource } from './spawnEnergyBuffer';
import { getRoomSpawnEnergyReservationState } from './spawnEnergyReservation';

type WithdrawTaskMemory = Extract<CreepTaskMemory, { type: 'withdraw' }>;
type WorkerEnergyAcquisitionTaskMemory = Extract<CreepTaskMemory, { type: 'pickup' | 'withdraw' }>;

export interface WorkerConstructionWithdrawReservationContext {
  constructionEnergyWithdrawn: number;
  reservedEnergyBySourceId: Map<string, number>;
}

export function getSafeWorkerWithdrawEnergyAmount(
  creep: Creep,
  target: AnyStoreStructure,
  requestedAmount: number,
  task: WithdrawTaskMemory
): number {
  if (!isConstructionWithdrawTask(task) || !isSpawnEnergySource(target)) {
    return getSpawnEnergyWithdrawalAmount(creep.room, target, requestedAmount);
  }

  const availableEnergy = getSpawnConstructionEnergyAvailableForWithdrawal(
    creep.room,
    target,
    getStoredEnergy(target),
    createWorkerConstructionWithdrawReservationContext(creep.room, creep)
  );
  return Math.min(normalizeEnergyAmount(requestedAmount), availableEnergy);
}

export function createWorkerConstructionWithdrawReservationContext(
  room: Room,
  currentCreep?: Creep
): WorkerConstructionWithdrawReservationContext {
  const context: WorkerConstructionWithdrawReservationContext = {
    constructionEnergyWithdrawn: 0,
    reservedEnergyBySourceId: new Map<string, number>()
  };

  for (const worker of getRoomOwnedCreeps(room)) {
    if ((currentCreep && isSameCreep(worker, currentCreep)) || !isInRoom(worker, room)) {
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
    context.reservedEnergyBySourceId.set(
      sourceId,
      (context.reservedEnergyBySourceId.get(sourceId) ?? 0) + freeCapacity
    );

    if (isRoomEnergyConstructionWithdrawTask(room, task)) {
      context.constructionEnergyWithdrawn += freeCapacity;
    }
  }

  return context;
}

export function getSpawnConstructionEnergyAvailableForWithdrawal(
  room: Room,
  source: StructureSpawn,
  energy: number,
  reservationContext: WorkerConstructionWithdrawReservationContext
): number {
  const roomEnergyAvailable = getRoomEnergyAvailable(room);
  if (roomEnergyAvailable === null) {
    return 0;
  }

  const reservedEnergy = getReservedWorkerEnergyAcquisitionAmount(source, reservationContext);
  const projectedSourceEnergy = Math.max(0, energy - reservedEnergy);
  const spawnReservationBudget = getConstructionEnergyAvailableAfterSpawnReservation(
    room,
    roomEnergyAvailable,
    reservationContext.constructionEnergyWithdrawn
  );
  const constructionBudget = Math.max(
    0,
    roomEnergyAvailable - getConstructionSpendingEnergyThreshold(room) - reservationContext.constructionEnergyWithdrawn
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

function getReservedWorkerEnergyAcquisitionAmount(
  source: { id?: unknown },
  reservationContext: WorkerConstructionWithdrawReservationContext
): number {
  return reservationContext.reservedEnergyBySourceId.get(String(source.id)) ?? 0;
}

function isWorkerEnergyAcquisitionReservationTask(
  task: Partial<CreepTaskMemory> | undefined
): task is WorkerEnergyAcquisitionTaskMemory {
  return (
    (task?.type === 'pickup' || task?.type === 'withdraw') &&
    typeof task.targetId === 'string' &&
    task.targetId.length > 0
  );
}

function isRoomEnergyConstructionWithdrawTask(
  room: Room,
  task: WorkerEnergyAcquisitionTaskMemory
): task is WithdrawTaskMemory {
  return isConstructionWithdrawTask(task) && isRoomEnergyConstructionWithdrawSource(room, String(task.targetId));
}

function isConstructionWithdrawTask(task: WorkerEnergyAcquisitionTaskMemory): task is WithdrawTaskMemory {
  return task.type === 'withdraw' && typeof task.constructionSiteId === 'string' && task.constructionSiteId.length > 0;
}

function isRoomEnergyConstructionWithdrawSource(room: Room, targetId: string): boolean {
  const source = getRoomObjectById<AnyStoreStructure>(room, targetId);
  return Boolean(source && (isSpawnEnergySource(source) || isExtensionEnergySource(source)));
}

function getRoomObjectById<T extends RoomObject>(room: Room, id: string): T | null {
  const gameObject = getGameObjectById<T>(id);
  if (gameObject) {
    return gameObject;
  }

  return findRoomStructures(room).find((structure) => String(structure.id) === id) as T | undefined ?? null;
}

function findRoomStructures(room: Room): AnyStructure[] {
  const findStructures = (globalThis as unknown as { FIND_STRUCTURES?: number }).FIND_STRUCTURES;
  const roomFind = (room as Room & { find?: (type: number) => unknown[] }).find;
  if (typeof findStructures !== 'number' || typeof roomFind !== 'function') {
    return [];
  }

  try {
    const structures = roomFind.call(room, findStructures);
    return Array.isArray(structures) ? (structures as AnyStructure[]) : [];
  } catch {
    return [];
  }
}

function getRoomOwnedCreeps(room: Room): Creep[] {
  const creeps: Creep[] = [];
  const findMyCreeps = (globalThis as unknown as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
  const roomFind = (room as Room & { find?: (type: number) => unknown[] }).find;
  if (typeof findMyCreeps === 'number' && typeof roomFind === 'function') {
    try {
      const foundCreeps = roomFind.call(room, findMyCreeps);
      if (Array.isArray(foundCreeps)) {
        creeps.push(...(foundCreeps as Creep[]));
      }
    } catch {
      return [];
    }
  }

  creeps.push(...getGameCreeps().filter((creep) => isInRoom(creep, room)));
  return dedupeCreeps(creeps).filter((creep) => isInRoom(creep, room));
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as unknown as { Game?: Partial<Game> }).Game?.creeps;
  return creeps ? Object.values(creeps) : [];
}

function dedupeCreeps(creeps: Creep[]): Creep[] {
  const deduped: Creep[] = [];
  for (const creep of creeps) {
    if (!deduped.some((existing) => isSameCreep(existing, creep))) {
      deduped.push(creep);
    }
  }

  return deduped;
}

function getGameObjectById<T>(id: string): T | null {
  const object = (globalThis as unknown as { Game?: Partial<Pick<Game, 'getObjectById'>> }).Game?.getObjectById?.(id);
  return object ? (object as unknown as T) : null;
}

function isSameCreep(left: Creep, right: Creep): boolean {
  return left === right || (typeof left.name === 'string' && left.name === right.name);
}

function isInRoom(creep: Creep, room: Room): boolean {
  return creep.room === room || (typeof creep.room?.name === 'string' && creep.room.name === room.name);
}

function getRoomEnergyAvailable(room: Room): number | null {
  return normalizeNullableEnergyAmount((room as Room & { energyAvailable?: unknown }).energyAvailable);
}

function getStoredEnergy(target: { store?: StoreDefinition }): number {
  return normalizeEnergyAmount(target.store?.getUsedCapacity?.(RESOURCE_ENERGY));
}

function getFreeEnergyCapacity(target: { store?: StoreDefinition }): number {
  return normalizeEnergyAmount(target.store?.getFreeCapacity?.(RESOURCE_ENERGY));
}

function normalizeNullableEnergyAmount(amount: unknown): number | null {
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, amount) : null;
}

function normalizeEnergyAmount(amount: unknown): number {
  return normalizeNullableEnergyAmount(amount) ?? 0;
}

function isExtensionEnergySource(target: unknown): target is StructureExtension {
  const structureType = (target as Partial<Structure> | null)?.structureType;
  const constants = globalThis as unknown as { STRUCTURE_EXTENSION?: string };
  return structureType === (constants.STRUCTURE_EXTENSION ?? 'extension');
}
