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
  energyCapacityAvailable: number;
  reservationScore: number;
}

export interface EnergyReservationScoreOptions {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
}

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
  const confirmedReserveEnergy =
    getConfirmedStorageReserveEnergy(spawnEnergy, storageEnergy, energyCapacityAvailable) +
    terminalEnergy +
    pendingHaulerDeliveryEnergy;
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
    energyCapacityAvailable,
    reservationScore
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

function getPendingHaulerDeliveryEnergy(roomName: string): number {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).reduce((total, creep) => {
    if (!isHaulerDeliveringEnergyToRoom(creep, roomName)) {
      return total;
    }

    return total + getStoredEnergy(creep);
  }, 0);
}

function isHaulerDeliveringEnergyToRoom(creep: Creep, roomName: string): boolean {
  if (creep.memory?.role !== 'hauler' || isCollectingEnergyTask(creep.memory.task)) {
    return false;
  }

  if (creep.memory.energyHauler?.roomName === roomName) {
    return creep.room?.name === undefined || creep.room.name === roomName || creep.memory.task?.type === 'transfer';
  }

  return creep.memory.remoteHauler?.homeRoom === roomName;
}

function isCollectingEnergyTask(task: CreepTaskMemory | undefined): boolean {
  return task?.type === 'harvest' || task?.type === 'pickup' || task?.type === 'withdraw';
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
