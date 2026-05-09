import { getRoomSpawnEnergyReservationState } from './spawnEnergyReservation';

interface StoreLike {
  getUsedCapacity?: (resource?: ResourceConstant) => number | null;
  [resource: string]: unknown;
}

export interface EnergyReservationScore {
  roomName: string;
  spawnEnergy: number;
  storageEnergy: number;
  terminalEnergy: number;
  pendingHaulerDeliveryEnergy: number;
  confirmedReserveEnergy: number;
  reservedSpawnEnergy: number;
  reservedSpawnRefillEnergy: number;
  energyCapacityAvailable: number;
  reservationScore: number;
  unmetSpawnEnergyReservation: number;
}

export interface EnergyReservationScoreOptions {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
}

interface PendingHaulerDeliveryEnergyCache {
  gameTime: number;
  creeps: Partial<Game['creeps']>;
  energyByRoomName: Map<string, number>;
}

let pendingHaulerDeliveryEnergyCache: PendingHaulerDeliveryEnergyCache | undefined;

export function getEnergyReservationScore(
  room: Room,
  options: EnergyReservationScoreOptions = {}
): EnergyReservationScore {
  const roomName = getRoomName(room);
  const spawnEnergy = normalizeEnergyAmount(options.energyAvailable ?? room.energyAvailable);
  const energyCapacityAvailable = normalizeEnergyAmount(
    options.energyCapacityAvailable ?? room.energyCapacityAvailable
  );
  const storageEnergy = getRoomStorageEnergy(room);
  const terminalEnergy = getRoomTerminalEnergy(room);
  const pendingHaulerDeliveryEnergy = getPendingHaulerDeliveryEnergy(roomName);
  const spawnEnergyReservation = getRoomSpawnEnergyReservationState(room);
  const reserveAllocation = allocateReserveEnergyForSpawnReservation(
    spawnEnergyReservation.unmetReservedEnergy,
    storageEnergy + terminalEnergy + pendingHaulerDeliveryEnergy
  );
  const confirmedReserveEnergy =
    reserveAllocation.reservedSpawnRefillEnergy +
    getConfirmedStorageReserveEnergy(
      spawnEnergy + reserveAllocation.reservedSpawnRefillEnergy,
      reserveAllocation.remainingReserveEnergy,
      energyCapacityAvailable
    );
  const uncappedReservationScore = spawnEnergy + confirmedReserveEnergy;
  const reservationScore = energyCapacityAvailable > 0
    ? Math.min(energyCapacityAvailable, uncappedReservationScore)
    : uncappedReservationScore;

  return {
    roomName,
    spawnEnergy,
    storageEnergy,
    terminalEnergy,
    pendingHaulerDeliveryEnergy,
    confirmedReserveEnergy,
    reservedSpawnEnergy: spawnEnergyReservation.reservedEnergy,
    reservedSpawnRefillEnergy: reserveAllocation.reservedSpawnRefillEnergy,
    energyCapacityAvailable,
    reservationScore,
    unmetSpawnEnergyReservation: spawnEnergyReservation.unmetReservedEnergy
  };
}

function getRoomStorageEnergy(room: Room): number {
  return getStoredEnergy(room.storage);
}

function getRoomTerminalEnergy(room: Room): number {
  return getStoredEnergy(room.terminal);
}

function getConfirmedStorageReserveEnergy(
  spawnEnergy: number,
  storageEnergy: number,
  energyCapacityAvailable: number
): number {
  if (storageEnergy <= 0) {
    return 0;
  }

  const refillDeficit = Math.max(0, energyCapacityAvailable - spawnEnergy);
  return refillDeficit <= 0 || storageEnergy >= refillDeficit ? storageEnergy : 0;
}

function allocateReserveEnergyForSpawnReservation(
  unmetSpawnEnergyReservation: number,
  reserveEnergy: number
): { remainingReserveEnergy: number; reservedSpawnRefillEnergy: number } {
  const reservedSpawnRefillEnergy = Math.min(
    normalizeEnergyAmount(unmetSpawnEnergyReservation),
    normalizeEnergyAmount(reserveEnergy)
  );

  return {
    remainingReserveEnergy: Math.max(0, normalizeEnergyAmount(reserveEnergy) - reservedSpawnRefillEnergy),
    reservedSpawnRefillEnergy
  };
}

function getPendingHaulerDeliveryEnergy(roomName: string): number {
  const game = (globalThis as { Game?: Partial<Pick<Game, 'creeps' | 'time'>> }).Game;
  if (!game?.creeps) {
    return 0;
  }

  const gameTime = typeof game.time === 'number' && Number.isFinite(game.time) ? game.time : undefined;
  if (gameTime === undefined) {
    return getPendingHaulerDeliveryEnergyByRoomName(game.creeps).get(roomName) ?? 0;
  }

  if (
    pendingHaulerDeliveryEnergyCache?.gameTime !== gameTime ||
    pendingHaulerDeliveryEnergyCache.creeps !== game.creeps
  ) {
    pendingHaulerDeliveryEnergyCache = {
      gameTime,
      creeps: game.creeps,
      energyByRoomName: getPendingHaulerDeliveryEnergyByRoomName(game.creeps)
    };
  }

  return pendingHaulerDeliveryEnergyCache.energyByRoomName.get(roomName) ?? 0;
}

function getPendingHaulerDeliveryEnergyByRoomName(creeps: Partial<Game['creeps']>): Map<string, number> {
  const energyByRoomName = new Map<string, number>();
  for (const creep of Object.values(creeps)) {
    if (creep === undefined) {
      continue;
    }

    const roomName = getHaulerDeliveryRoomName(creep);
    if (roomName === undefined) {
      continue;
    }

    energyByRoomName.set(roomName, (energyByRoomName.get(roomName) ?? 0) + getStoredEnergy(creep));
  }

  return energyByRoomName;
}

function getHaulerDeliveryRoomName(creep: Creep): string | undefined {
  if (creep.memory?.role !== 'hauler' || isCollectingEnergyTask(creep.memory.task)) {
    return undefined;
  }

  const localRoomName = creep.memory.energyHauler?.roomName;
  if (
    isNonEmptyString(localRoomName) &&
    (creep.room?.name === undefined || creep.room.name === localRoomName || creep.memory.task?.type === 'transfer')
  ) {
    return localRoomName;
  }

  const remoteHomeRoom = creep.memory.remoteHauler?.homeRoom;
  return isNonEmptyString(remoteHomeRoom) ? remoteHomeRoom : undefined;
}

function isCollectingEnergyTask(task: CreepTaskMemory | undefined): boolean {
  return task?.type === 'harvest' || task?.type === 'pickup' || task?.type === 'withdraw';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { energy?: unknown; store?: StoreLike } | null)?.store;
  const energyResource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(energyResource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, Math.floor(usedCapacity));
  }

  const storedEnergy = store?.[energyResource];
  if (typeof storedEnergy === 'number' && Number.isFinite(storedEnergy)) {
    return Math.max(0, Math.floor(storedEnergy));
  }

  const legacyEnergy = (target as { energy?: unknown } | null)?.energy;
  return typeof legacyEnergy === 'number' && Number.isFinite(legacyEnergy)
    ? Math.max(0, Math.floor(legacyEnergy))
    : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function getRoomName(room: Room): string {
  return typeof room.name === 'string' ? room.name : '';
}

function normalizeEnergyAmount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
