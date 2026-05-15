import { getRoomSpawnEnergyReservationState } from './spawnEnergyReservation';

export const DEFAULT_LOCAL_FIRST_ENERGY_ROOM: string | undefined = undefined;
export const DEFAULT_E18S59_LOCAL_FIRST_ENERGY_ROOM: string | undefined = undefined;
export const DEFAULT_LOCAL_FIRST_SOURCE_ROOM: string | undefined = undefined;
export const DEFAULT_LOCAL_FIRST_ENERGY_ROOMS: readonly string[] = [];
export const DEFAULT_LOCAL_ENERGY_IMPORT_THRESHOLD = 500;
export const DEFAULT_LOCAL_HARVEST_COVERAGE_RATIO = 0.8;
export const DEFAULT_SOURCE_WORKLOAD_FRESH_TICKS = 50;
export const DEFAULT_SPAWN_COLLAPSE_ENERGY_THRESHOLD = 200;

type LocalEnergyStructureGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_LINK'
  | 'STRUCTURE_SPAWN';

export interface LocalEnergyImportAudit {
  enabled: boolean;
  roomName: string;
  sourceRoom?: string;
  sourceRoomAllowed: boolean;
  localEnergy: number;
  importThreshold: number;
  localEnergyDeficit: number;
  localHarvestEnergyPerTick: number;
  localRegenEnergyPerTick: number;
  harvestCoverageRatio: number;
  localHarvestSufficient: boolean;
  sourceWorkloadFresh: boolean;
  spawnCollapseRisk: boolean;
  spawnEnergyAvailable: number;
  spawnEnergyCapacity: number;
  shouldImport: boolean;
  reason:
    | 'not-managed'
    | 'source-room-not-managed'
    | 'spawn-collapse-risk'
    | 'local-energy-deficit'
    | 'local-harvest-sufficient'
    | 'local-harvest-insufficient';
}

interface LocalEnergyRoomConfig {
  enabled: boolean;
  importThreshold: number;
  sourceRooms: string[];
  harvestCoverageRatio: number;
  sourceWorkloadFreshTicks: number;
  spawnCollapseEnergyThreshold: number;
}

interface LocalEnergyImportAuditOptions {
  sourceRoom?: string;
  storedEnergy?: number;
}

const DEFAULT_ROOM_CONFIGS: Record<string, Omit<LocalEnergyRoomConfig, 'enabled'>> = Object.fromEntries(
  DEFAULT_LOCAL_FIRST_ENERGY_ROOMS.map((roomName) => [
    roomName,
    {
      importThreshold: DEFAULT_LOCAL_ENERGY_IMPORT_THRESHOLD,
      sourceRooms: DEFAULT_LOCAL_FIRST_SOURCE_ROOM ? [DEFAULT_LOCAL_FIRST_SOURCE_ROOM] : [roomName],
      harvestCoverageRatio: DEFAULT_LOCAL_HARVEST_COVERAGE_RATIO,
      sourceWorkloadFreshTicks: DEFAULT_SOURCE_WORKLOAD_FRESH_TICKS,
      spawnCollapseEnergyThreshold: DEFAULT_SPAWN_COLLAPSE_ENERGY_THRESHOLD
    }
  ])
);

export function auditLocalEnergyImport(
  room: Room,
  options: LocalEnergyImportAuditOptions = {}
): LocalEnergyImportAudit {
  const roomName = room.name;
  const config = getLocalEnergyRoomConfig(roomName);
  const storedEnergy = normalizeNonNegativeInteger(options.storedEnergy ?? getRoomStorageAndTerminalEnergy(room));
  const spawnEnergyAvailable = normalizeNonNegativeInteger(room.energyAvailable);
  const spawnEnergyCapacity = normalizeNonNegativeInteger(room.energyCapacityAvailable);

  if (!config) {
    return {
      enabled: false,
      roomName,
      ...(options.sourceRoom ? { sourceRoom: options.sourceRoom } : {}),
      sourceRoomAllowed: false,
      localEnergy: storedEnergy,
      importThreshold: 0,
      localEnergyDeficit: 0,
      localHarvestEnergyPerTick: 0,
      localRegenEnergyPerTick: 0,
      harvestCoverageRatio: 0,
      localHarvestSufficient: false,
      sourceWorkloadFresh: false,
      spawnCollapseRisk: false,
      spawnEnergyAvailable,
      spawnEnergyCapacity,
      shouldImport: true,
      reason: 'not-managed'
    };
  }

  const localEnergy = storedEnergy + getRoomLooseStoredEnergy(room);
  const sourceRoomAllowed = isSourceRoomAllowed(config, options.sourceRoom);
  if (!sourceRoomAllowed) {
    return {
      enabled: true,
      roomName,
      ...(options.sourceRoom ? { sourceRoom: options.sourceRoom } : {}),
      sourceRoomAllowed,
      localEnergy,
      importThreshold: config.importThreshold,
      localEnergyDeficit: Math.max(0, config.importThreshold - localEnergy),
      localHarvestEnergyPerTick: 0,
      localRegenEnergyPerTick: 0,
      harvestCoverageRatio: config.harvestCoverageRatio,
      localHarvestSufficient: false,
      sourceWorkloadFresh: false,
      spawnCollapseRisk: false,
      spawnEnergyAvailable,
      spawnEnergyCapacity,
      shouldImport: true,
      reason: 'source-room-not-managed'
    };
  }

  const sourceWorkload = getLocalSourceWorkload(roomName);
  const sourceWorkloadFresh = isSourceWorkloadFresh(sourceWorkload, config.sourceWorkloadFreshTicks);
  const sourceRecords = sourceWorkloadFresh ? Object.values(sourceWorkload?.sources ?? {}) : [];
  const localHarvestEnergyPerTick = sourceRecords.reduce(
    (total, source) => total + normalizeNonNegativeNumber(source.harvestEnergyPerTick),
    0
  );
  const localRegenEnergyPerTick = sourceRecords.reduce(
    (total, source) => total + normalizeNonNegativeNumber(source.regenEnergyPerTick),
    0
  );
  const localHarvestSufficient =
    sourceRecords.length > 0 &&
    sourceRecords.every((source) =>
      isSourceHarvestSufficient(source, config.harvestCoverageRatio)
    );
  const localEnergyDeficit = Math.max(0, config.importThreshold - localEnergy);
  const spawnCollapseRisk =
    hasSpawnCollapseRisk(room, config.spawnCollapseEnergyThreshold) ||
    hasUnmetSpawnEnergyReservation(room);
  const shouldImport =
    spawnCollapseRisk ||
    localEnergyDeficit > 0 ||
    !localHarvestSufficient;

  return {
    enabled: true,
    roomName,
    ...(options.sourceRoom ? { sourceRoom: options.sourceRoom } : {}),
    sourceRoomAllowed,
    localEnergy,
    importThreshold: config.importThreshold,
    localEnergyDeficit,
    localHarvestEnergyPerTick,
    localRegenEnergyPerTick,
    harvestCoverageRatio: config.harvestCoverageRatio,
    localHarvestSufficient,
    sourceWorkloadFresh,
    spawnCollapseRisk,
    spawnEnergyAvailable,
    spawnEnergyCapacity,
    shouldImport,
    reason: spawnCollapseRisk
      ? 'spawn-collapse-risk'
      : localEnergyDeficit > 0
        ? 'local-energy-deficit'
        : localHarvestSufficient
          ? 'local-harvest-sufficient'
          : 'local-harvest-insufficient'
  };
}

export function shouldAllowLocalFirstEnergyImport(
  room: Room,
  options: LocalEnergyImportAuditOptions = {}
): boolean {
  return auditLocalEnergyImport(room, options).shouldImport;
}

export function shouldApplyLocalFirstEnergyImportPolicy(roomName: string, sourceRoom: string | undefined): boolean {
  if (!sourceRoom) {
    return false;
  }

  const config = getLocalEnergyRoomConfig(roomName);
  return config !== null && isSourceRoomAllowed(config, sourceRoom);
}

function getLocalEnergyRoomConfig(roomName: string): LocalEnergyRoomConfig | null {
  const configured = getConfiguredRoomMemory(roomName);
  const defaults = DEFAULT_ROOM_CONFIGS[roomName];
  if (configured?.enabled === false) {
    return null;
  }

  if (!defaults && configured?.enabled !== true) {
    return null;
  }

  return {
    enabled: true,
    importThreshold: normalizeNonNegativeInteger(
      configured?.importThreshold ?? defaults?.importThreshold ?? DEFAULT_LOCAL_ENERGY_IMPORT_THRESHOLD
    ),
    sourceRooms: normalizeStringList(configured?.sourceRooms ?? defaults?.sourceRooms ?? []),
    harvestCoverageRatio: normalizeRatio(
      configured?.harvestCoverageRatio ?? defaults?.harvestCoverageRatio ?? DEFAULT_LOCAL_HARVEST_COVERAGE_RATIO
    ),
    sourceWorkloadFreshTicks: Math.max(
      1,
      normalizeNonNegativeInteger(
        configured?.sourceWorkloadFreshTicks ??
          defaults?.sourceWorkloadFreshTicks ??
          DEFAULT_SOURCE_WORKLOAD_FRESH_TICKS
      )
    ),
    spawnCollapseEnergyThreshold: normalizeNonNegativeInteger(
      configured?.spawnCollapseEnergyThreshold ??
        defaults?.spawnCollapseEnergyThreshold ??
        DEFAULT_SPAWN_COLLAPSE_ENERGY_THRESHOLD
    )
  };
}

function getConfiguredRoomMemory(roomName: string): EconomyEnergyIndependenceRoomMemory | undefined {
  return (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.economy?.energyIndependence?.rooms?.[roomName];
}

function isSourceRoomAllowed(config: LocalEnergyRoomConfig, sourceRoom: string | undefined): boolean {
  return !sourceRoom || config.sourceRooms.length === 0 || config.sourceRooms.includes(sourceRoom);
}

function getLocalSourceWorkload(roomName: string): EconomyRoomSourceWorkloadMemory | undefined {
  return (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.economy?.sourceWorkloads?.[roomName];
}

function isSourceWorkloadFresh(
  workload: EconomyRoomSourceWorkloadMemory | undefined,
  freshTicks: number
): workload is EconomyRoomSourceWorkloadMemory {
  if (!workload || typeof workload.updatedAt !== 'number' || !Number.isFinite(workload.updatedAt)) {
    return false;
  }

  const gameTime = getGameTime();
  return gameTime >= workload.updatedAt && gameTime - workload.updatedAt <= freshTicks;
}

function isSourceHarvestSufficient(
  source: EconomySourceWorkloadMemory,
  harvestCoverageRatio: number
): boolean {
  const regenEnergyPerTick = normalizeNonNegativeNumber(source.regenEnergyPerTick);
  if (regenEnergyPerTick <= 0) {
    return false;
  }

  return normalizeNonNegativeNumber(source.harvestEnergyPerTick) >= regenEnergyPerTick * harvestCoverageRatio;
}

function hasSpawnCollapseRisk(room: Room, threshold: number): boolean {
  if (threshold <= 0 || !hasOwnedSpawn(room)) {
    return false;
  }

  const energyCapacity = normalizeNonNegativeInteger(room.energyCapacityAvailable);
  const effectiveThreshold = energyCapacity > 0 ? Math.min(threshold, energyCapacity) : threshold;
  return normalizeNonNegativeInteger(room.energyAvailable) < effectiveThreshold;
}

function hasUnmetSpawnEnergyReservation(room: Room): boolean {
  return getRoomSpawnEnergyReservationState(room).unmetReservedEnergy > 0;
}

function hasOwnedSpawn(room: Room): boolean {
  return findOwnedRoomStructures(room).some((structure) =>
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn')
  );
}

function getRoomLooseStoredEnergy(room: Room): number {
  return findRoomStructures(room)
    .filter((structure) =>
      matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_LINK', 'link')
    )
    .reduce((total, structure) => total + getStoredEnergy(structure), 0);
}

function getRoomStorageAndTerminalEnergy(room: Room): number {
  return getStoredEnergy(room.storage) + getStoredEnergy(room.terminal);
}

function findRoomStructures(room: Room): Structure[] {
  const findStructures = getGlobalNumber('FIND_STRUCTURES');
  if (findStructures === undefined || typeof room.find !== 'function') {
    return [];
  }

  const result = (room.find as unknown as (type: number) => unknown[])(findStructures);
  return Array.isArray(result) ? (result as Structure[]) : [];
}

function findOwnedRoomStructures(room: Room): AnyOwnedStructure[] {
  const findMyStructures = getGlobalNumber('FIND_MY_STRUCTURES');
  if (findMyStructures === undefined || typeof room.find !== 'function') {
    return [];
  }

  const result = (room.find as unknown as (type: number) => unknown[])(findMyStructures);
  return Array.isArray(result) ? (result as AnyOwnedStructure[]) : [];
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { store?: StoreDefinition } | null)?.store;
  const resource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(resource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const storedEnergy = (store as Partial<Record<ResourceConstant, number>> | undefined)?.[resource];
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function normalizeRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_LOCAL_HARVEST_COVERAGE_RATIO;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeNonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function matchesStructureType(
  actual: string | undefined,
  globalName: LocalEnergyStructureGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<LocalEnergyStructureGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}
