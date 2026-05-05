import { getRecordedColonySurvivalAssessment } from '../colony/survivalMode';

export const ENERGY_BUFFER_THRESHOLDS_BY_RCL: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, number> = {
  1: 300,
  2: 300,
  3: 500,
  4: 500,
  5: 800,
  6: 800,
  7: 1_000,
  8: 1_000
};

export const SURVIVAL_ENERGY_BUFFER_MULTIPLIER = 1.5;
export const STORAGE_EMERGENCY_RESERVE = 1_000;

const MINIMUM_WORKER_SPAWN_ENERGY = 200;

export interface EnergyBufferHealth {
  currentEnergy: number;
  threshold: number;
  room: string;
  healthy: boolean;
}

export interface StorageWithdrawalOptions {
  allowBelowReserve?: boolean;
}

type StructureConstantGlobal = 'STRUCTURE_EXTENSION' | 'STRUCTURE_SPAWN' | 'STRUCTURE_STORAGE';
type FindConstantGlobal = 'FIND_MY_STRUCTURES' | 'FIND_STRUCTURES';

interface EnergyObservation {
  currentEnergy: number;
  known: boolean;
}

export function getRoomEnergyBufferThreshold(room: Room): number {
  return ENERGY_BUFFER_THRESHOLDS_BY_RCL[getRoomRcl(room)];
}

export function getEffectiveRoomEnergyBufferThreshold(room: Room): number {
  const threshold = getRoomEnergyBufferThreshold(room);
  return isSurvivalBufferMode(room) ? Math.ceil(threshold * SURVIVAL_ENERGY_BUFFER_MULTIPLIER) : threshold;
}

export function checkEnergyBufferForSpending(room: Room, amount: number): boolean {
  const observation = getRoomSpawnExtensionEnergyObservation(room);
  if (!observation.known) {
    return true;
  }

  return observation.currentEnergy - normalizeEnergyAmount(amount) >= getEffectiveRoomEnergyBufferThreshold(room);
}

export function withdrawFromStorage(
  room: Room,
  amount: number,
  storage: StructureStorage | null = getRoomStorage(room),
  currentStorageEnergy = storage ? getStoredEnergy(storage) : 0,
  options: StorageWithdrawalOptions = {}
): boolean {
  if (!storage) {
    return false;
  }

  const requestedEnergy = normalizeEnergyAmount(amount);
  const storedEnergy = normalizeEnergyAmount(currentStorageEnergy);
  if (requestedEnergy > storedEnergy) {
    return false;
  }

  if (canWithdrawBelowStorageReserve(room, options)) {
    return storedEnergy > 0;
  }

  return storedEnergy - requestedEnergy >= getStorageEnergyReserve(room);
}

export function getStorageEnergyAvailableForWithdrawal(
  room: Room,
  storage: StructureStorage | null = getRoomStorage(room),
  currentStorageEnergy = storage ? getStoredEnergy(storage) : 0,
  options: StorageWithdrawalOptions = {}
): number {
  if (!storage) {
    return 0;
  }

  const storedEnergy = normalizeEnergyAmount(currentStorageEnergy);
  if (canWithdrawBelowStorageReserve(room, options)) {
    return storedEnergy;
  }

  return Math.max(0, storedEnergy - getStorageEnergyReserve(room));
}

export function getRoomEnergyBufferHealth(room: Room): EnergyBufferHealth {
  const observation = getRoomSpawnExtensionEnergyObservation(room);
  const currentEnergy = observation.currentEnergy;
  const threshold = getEffectiveRoomEnergyBufferThreshold(room);
  return {
    currentEnergy,
    threshold,
    room: getRoomName(room),
    healthy: currentEnergy >= threshold
  };
}

function getRoomRcl(room: Room): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  const level = room.controller?.level;
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    return 1;
  }

  return Math.min(8, Math.max(1, Math.floor(level))) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

function isSurvivalBufferMode(room: Room): boolean {
  const mode = getRecordedColonySurvivalAssessment(getRoomName(room))?.mode;
  return mode === 'BOOTSTRAP' || mode === 'DEFENSE';
}

function getStorageEnergyReserve(room: Room): number {
  return Math.min(getEffectiveRoomEnergyBufferThreshold(room), STORAGE_EMERGENCY_RESERVE);
}

function canWithdrawBelowStorageReserve(room: Room, options: StorageWithdrawalOptions): boolean {
  return options.allowBelowReserve === true || isRoomEnergyCriticalForStorageWithdrawal(room);
}

function isRoomEnergyCriticalForStorageWithdrawal(room: Room): boolean {
  const observation = getRoomSpawnExtensionEnergyObservation(room);
  return observation.known && observation.currentEnergy < MINIMUM_WORKER_SPAWN_ENERGY;
}

function getRoomSpawnExtensionEnergyObservation(room: Room): EnergyObservation {
  const energyAvailable = (room as Partial<Room>).energyAvailable;
  if (typeof energyAvailable === 'number' && Number.isFinite(energyAvailable)) {
    return { currentEnergy: Math.max(0, energyAvailable), known: true };
  }

  return { currentEnergy: 0, known: false };
}

function getRoomStorage(room: Room): StructureStorage | null {
  if (room.storage) {
    return room.storage;
  }

  return (
    findRoomStructures(room).filter(
      (structure): structure is StructureStorage =>
        matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage')
    )[0] ?? null
  );
}

function findRoomStructures(room: Room): AnyStructure[] {
  const seenIds = new Set<string>();
  const structures: AnyStructure[] = [];
  for (const structure of [
    ...findRoomObjects<AnyStructure>(room, 'FIND_MY_STRUCTURES'),
    ...findRoomObjects<AnyStructure>(room, 'FIND_STRUCTURES')
  ]) {
    const stableId = getObjectId(structure);
    if (stableId && seenIds.has(stableId)) {
      continue;
    }

    if (stableId) {
      seenIds.add(stableId);
    }
    structures.push(structure);
  }

  return structures;
}

function findRoomObjects<T>(room: Room, globalName: FindConstantGlobal): T[] {
  const findConstant = (globalThis as unknown as Partial<Record<FindConstantGlobal, number>>)[globalName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const findRoomObjectsByNumber = room.find as unknown as (type: number) => unknown[];
    const result = findRoomObjectsByNumber(findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getStoredEnergy(target: unknown): number {
  const store = (
    target as {
      energy?: unknown;
      store?: {
        getUsedCapacity?: (resource?: ResourceConstant) => number | null;
        [resource: string]: unknown;
      };
    } | null
  )?.store;
  const energyResource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(energyResource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const storedEnergy = store?.[energyResource];
  if (typeof storedEnergy === 'number' && Number.isFinite(storedEnergy)) {
    return Math.max(0, storedEnergy);
  }

  const legacyEnergy = (target as { energy?: unknown } | null)?.energy;
  return typeof legacyEnergy === 'number' && Number.isFinite(legacyEnergy) ? Math.max(0, legacyEnergy) : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function normalizeEnergyAmount(amount: number): number {
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function getRoomName(room: Room): string {
  return typeof room.name === 'string' ? room.name : '';
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
  globalName: StructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}
