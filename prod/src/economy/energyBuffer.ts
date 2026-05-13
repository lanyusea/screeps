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
export const NON_CRISIS_ENERGY_BUFFER_CAPACITY_RATIO = 0.65;
export const STORAGE_EMERGENCY_RESERVE = 1_000;
export const CAPACITY_ENABLING_CONSTRUCTION_HEALTHY_ENERGY_CAPACITY = 550;
export const CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY = 300;
export const MINIMUM_WORKER_SPAWN_ENERGY = 200;
export const BOOTSTRAP_EXTENSION_CONSTRUCTION_RESERVE_MARGIN = 50;

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

const FALLBACK_SPAWN_ENERGY_CAPACITY = 300;
const FALLBACK_EXTENSION_LIMITS_BY_RCL: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, number> = {
  1: 0,
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60
};
const FALLBACK_EXTENSION_ENERGY_CAPACITY_BY_RCL: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, number> = {
  1: 0,
  2: 50,
  3: 50,
  4: 50,
  5: 50,
  6: 50,
  7: 100,
  8: 200
};

export function getRoomEnergyBufferThreshold(room: Room): number {
  return getConfiguredRoomEnergyBufferThreshold(room);
}

export function getEffectiveRoomEnergyBufferThreshold(room: Room): number {
  const threshold = getRoomEnergyBufferThreshold(room);
  const survivalBufferMode = isSurvivalBufferMode(room);
  const effectiveThreshold = survivalBufferMode
    ? Math.ceil(threshold * SURVIVAL_ENERGY_BUFFER_MULTIPLIER)
    : threshold;
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyCapacityAvailable === null) {
    return effectiveThreshold;
  }

  const capacityLimitedThreshold = Math.min(effectiveThreshold, energyCapacityAvailable);
  if (survivalBufferMode) {
    return capacityLimitedThreshold;
  }

  return Math.min(capacityLimitedThreshold, getNonCrisisEnergyBufferCapacityCap(energyCapacityAvailable));
}

export function getStorageEnergyReserveThreshold(room: Room): number {
  return Math.min(getEffectiveConfiguredRoomEnergyBufferThreshold(room), STORAGE_EMERGENCY_RESERVE);
}

export function checkEnergyBufferForSpending(room: Room, amount: number): boolean {
  const observation = getRoomSpawnExtensionEnergyObservation(room);
  if (!observation.known) {
    return true;
  }

  return observation.currentEnergy - normalizeEnergyAmount(amount) >= getEffectiveRoomEnergyBufferThreshold(room);
}

export function checkEnergyBufferForCapacityEnablingConstruction(room: Room, amount: number): boolean {
  if (checkEnergyBufferForSpending(room, amount)) {
    return true;
  }

  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyCapacityAvailable === null) {
    return false;
  }

  // Keep capacity-enabling construction live until the room reaches the worker-throughput target,
  // while still preserving enough spawn energy for recovery workers.
  return (
    hasMinimumWorkerSpawnEnergyReserveForConstruction(room, amount) &&
    energyCapacityAvailable < CAPACITY_ENABLING_CONSTRUCTION_HEALTHY_ENERGY_CAPACITY
  );
}

export function checkEnergyBufferForExtensionConstruction(room: Room, amount: number): boolean {
  if (checkEnergyBufferForCapacityEnablingConstruction(room, amount)) {
    return true;
  }

  return hasBootstrapExtensionConstructionEnergyReserve(room, amount);
}

export function hasMinimumWorkerSpawnEnergyForConstruction(room: Room): boolean {
  const observation = getRoomSpawnExtensionEnergyObservation(room);
  return !observation.known || observation.currentEnergy >= CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY;
}

function hasMinimumWorkerSpawnEnergyReserveForConstruction(room: Room, amount: number): boolean {
  const observation = getRoomSpawnExtensionEnergyObservation(room);
  return (
    !observation.known ||
    observation.currentEnergy - normalizeEnergyAmount(amount) >= MINIMUM_WORKER_SPAWN_ENERGY
  );
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

function getConfiguredRoomEnergyBufferThreshold(room: Room): number {
  return ENERGY_BUFFER_THRESHOLDS_BY_RCL[getRoomRcl(room)];
}

function getEffectiveConfiguredRoomEnergyBufferThreshold(room: Room): number {
  const threshold = getConfiguredRoomEnergyBufferThreshold(room);
  return isSurvivalBufferMode(room) ? Math.ceil(threshold * SURVIVAL_ENERGY_BUFFER_MULTIPLIER) : threshold;
}

function getNonCrisisEnergyBufferCapacityCap(energyCapacityAvailable: number): number {
  return Math.max(
    MINIMUM_WORKER_SPAWN_ENERGY,
    Math.floor(energyCapacityAvailable * NON_CRISIS_ENERGY_BUFFER_CAPACITY_RATIO)
  );
}

function isSurvivalBufferMode(room: Room): boolean {
  const mode = getRecordedColonySurvivalAssessment(getRoomName(room))?.mode;
  return mode === 'BOOTSTRAP' || mode === 'DEFENSE';
}

function hasBootstrapExtensionConstructionEnergyReserve(room: Room, amount: number): boolean {
  if (getRecordedColonySurvivalAssessment(getRoomName(room))?.mode !== 'BOOTSTRAP') {
    return false;
  }

  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyCapacityAvailable === null || energyCapacityAvailable <= 0) {
    return false;
  }

  if (!hasBuildableExtensionCapacity(room, energyCapacityAvailable)) {
    return false;
  }

  const observation = getRoomSpawnExtensionEnergyObservation(room);
  const requestedEnergy = normalizeEnergyAmount(amount);
  return (
    observation.known &&
    observation.currentEnergy >= getBootstrapExtensionConstructionReserve(energyCapacityAvailable) &&
    observation.currentEnergy - requestedEnergy >= MINIMUM_WORKER_SPAWN_ENERGY
  );
}

function hasBuildableExtensionCapacity(room: Room, energyCapacityAvailable: number): boolean {
  const rcl = getRoomRcl(room);
  const extensionLimit = getRoomExtensionLimit(room, rcl);
  if (extensionLimit <= 0 || countExistingExtensions(room) >= extensionLimit) {
    return false;
  }

  return energyCapacityAvailable < getTargetExtensionEnergyCapacity(rcl, extensionLimit);
}

function getBootstrapExtensionConstructionReserve(energyCapacityAvailable: number): number {
  return Math.min(
    energyCapacityAvailable,
    getSpawnEnergyCapacity() + BOOTSTRAP_EXTENSION_CONSTRUCTION_RESERVE_MARGIN
  );
}

function getTargetExtensionEnergyCapacity(rcl: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, extensionLimit: number): number {
  return getSpawnEnergyCapacity() + extensionLimit * getExtensionEnergyCapacityForRcl(rcl);
}

function getSpawnEnergyCapacity(): number {
  const value = (globalThis as { SPAWN_ENERGY_CAPACITY?: unknown }).SPAWN_ENERGY_CAPACITY;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : FALLBACK_SPAWN_ENERGY_CAPACITY;
}

function getExtensionEnergyCapacityForRcl(rcl: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): number {
  const value = (globalThis as { EXTENSION_ENERGY_CAPACITY?: unknown }).EXTENSION_ENERGY_CAPACITY;
  const capacity = getIndexedNumber(value, rcl);
  return capacity ?? FALLBACK_EXTENSION_ENERGY_CAPACITY_BY_RCL[rcl];
}

function getRoomExtensionLimit(room: Room, rcl: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): number {
  const controllerStructures = (globalThis as { CONTROLLER_STRUCTURES?: unknown }).CONTROLLER_STRUCTURES;
  const extensionLimits = isRecord(controllerStructures)
    ? controllerStructures[getStructureConstant('STRUCTURE_EXTENSION', 'extension')]
    : undefined;
  return getIndexedNumber(extensionLimits, rcl) ?? FALLBACK_EXTENSION_LIMITS_BY_RCL[rcl];
}

function getIndexedNumber(value: unknown, index: number): number | null {
  const indexedValue = isRecord(value) || Array.isArray(value) ? value[index] : undefined;
  return typeof indexedValue === 'number' && Number.isFinite(indexedValue)
    ? Math.max(0, Math.floor(indexedValue))
    : null;
}

function countExistingExtensions(room: Room): number {
  return findRoomStructures(room).filter((structure) =>
    matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')
  ).length;
}

function getStorageEnergyReserve(room: Room): number {
  return getStorageEnergyReserveThreshold(room);
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

function getRoomEnergyCapacityAvailable(room: Room): number | null {
  const energyCapacityAvailable = (room as Partial<Room>).energyCapacityAvailable;
  return typeof energyCapacityAvailable === 'number' && Number.isFinite(energyCapacityAvailable)
    ? Math.max(0, energyCapacityAvailable)
    : null;
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

function getStructureConstant(globalName: StructureConstantGlobal, fallback: string): string {
  return (globalThis as unknown as Partial<Record<StructureConstantGlobal, string>>)[globalName] ?? fallback;
}

function matchesStructureType(
  actual: string | undefined,
  globalName: StructureConstantGlobal,
  fallback: string
): boolean {
  return actual === getStructureConstant(globalName, fallback);
}

function isRecord(value: unknown): value is Record<string | number, unknown> {
  return typeof value === 'object' && value !== null;
}
