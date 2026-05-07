import { getRoomSpawnEnergyReservationState } from './spawnEnergyReservation';
import { getRoomMinerThroughput } from './minerThroughput';

export const MINIMUM_SPAWN_ENERGY_BUFFER_PER_SPAWN = 300;
export const MINER_OUTPUT_BUFFER_CREDIT_TICKS = 20;
export const MINER_ADJUSTED_SPAWN_ENERGY_BUFFER_FLOOR = 200;

export const SPAWN_ENERGY_BUFFER_THRESHOLDS_BY_RCL: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, number> = {
  1: MINIMUM_SPAWN_ENERGY_BUFFER_PER_SPAWN,
  2: MINIMUM_SPAWN_ENERGY_BUFFER_PER_SPAWN,
  3: 400,
  4: 500,
  5: 600,
  6: 700,
  7: 800,
  8: 900
};

type SpawnStructureConstantGlobal = 'STRUCTURE_SPAWN';

export interface SpawnEnergyBufferSnapshot {
  baseThresholdPerSpawn: number;
  currentEnergy: number;
  healthy: boolean;
  minerOutputBufferCredit: number;
  minerOutputEnergyPerTick: number;
  roomName: string;
  spawnCount: number;
  reservedEnergy: number;
  threshold: number;
  thresholdPerSpawn: number;
  unmetReservedEnergy: number;
}

export interface RefreshSpawnEnergyBufferOptions {
  currentEnergy?: number;
}

export function refreshSpawnEnergyBufferState(
  room: Room,
  spawns: StructureSpawn[],
  gameTime: number,
  options: RefreshSpawnEnergyBufferOptions = {}
): SpawnEnergyBufferSnapshot {
  const snapshot = getSpawnEnergyBufferSnapshot(room, spawns, options.currentEnergy);
  const memory = getWritableEconomyMemory();
  const previous = memory.spawnEnergyBuffer;
  const previousRoom = previous?.rooms?.[snapshot.roomName];
  memory.spawnEnergyBuffer = {
    updatedAt: gameTime,
    rooms: {
      ...(previous?.rooms ?? {}),
      [snapshot.roomName]: {
        ...snapshot,
        ...(previousRoom?.minimumEnergyPerSpawn === undefined
          ? {}
          : { minimumEnergyPerSpawn: previousRoom.minimumEnergyPerSpawn }),
        rcl: getRoomRcl(room),
        spawns: Object.fromEntries(
          spawns.map((spawn) => [
            getSpawnStableKey(spawn),
            {
              id: getObjectId(spawn),
              name: getSpawnName(spawn),
              energy: getStoredEnergy(spawn),
              threshold: snapshot.thresholdPerSpawn,
              withdrawableEnergy: getSpawnEnergyAvailableForWithdrawal(room, spawn)
            }
          ])
        ),
        updatedAt: gameTime
      }
    }
  };

  return snapshot;
}

export function getSpawnEnergyBufferSnapshot(
  room: Room,
  spawns: StructureSpawn[],
  currentEnergy = getRoomEnergyAvailable(room)
): SpawnEnergyBufferSnapshot {
  const baseThresholdPerSpawn = getBaseSpawnEnergyBufferThreshold(room);
  const minerOutputEnergyPerTick = getRoomMinerThroughput(room).energyPerTick;
  const minerOutputBufferCredit = getMinerOutputBufferCredit(minerOutputEnergyPerTick);
  const thresholdPerSpawn = getSpawnEnergyBufferThreshold(room);
  const spawnCount = getSpawnBufferCount(spawns);
  const threshold = thresholdPerSpawn * spawnCount;
  const normalizedEnergy = normalizeEnergyAmount(currentEnergy);
  const reservation = getRoomSpawnEnergyReservationState(room);

  return {
    baseThresholdPerSpawn,
    currentEnergy: normalizedEnergy,
    healthy: normalizedEnergy >= threshold,
    minerOutputBufferCredit,
    minerOutputEnergyPerTick,
    roomName: getRoomName(room),
    spawnCount,
    reservedEnergy: reservation.reservedEnergy,
    threshold,
    thresholdPerSpawn,
    unmetReservedEnergy: reservation.unmetReservedEnergy
  };
}

export function getSpawnEnergyBufferThreshold(room: Room): number {
  const configured = getConfiguredSpawnEnergyBufferThreshold(room);
  if (configured !== null) {
    return configured;
  }

  return getMinerAdjustedSpawnEnergyBufferThreshold(room, getBaseSpawnEnergyBufferThreshold(room));
}

export function getBaseSpawnEnergyBufferThreshold(room: Room): number {
  return SPAWN_ENERGY_BUFFER_THRESHOLDS_BY_RCL[getRoomRcl(room)];
}

export function getSpawnEnergyBufferRequirement(room: Room, spawns: StructureSpawn[]): number {
  return getSpawnEnergyBufferThreshold(room) * getSpawnBufferCount(spawns);
}

export function getBufferedSpawnEnergyBudget(
  room: Room,
  spawns: StructureSpawn[],
  availableEnergy = getRoomEnergyAvailable(room)
): number {
  return Math.max(0, normalizeEnergyAmount(availableEnergy) - getSpawnEnergyBufferRequirement(room, spawns));
}

export function isSpawnEnergyBufferViolated(
  room: Room,
  spawns: StructureSpawn[],
  availableEnergy: number,
  spendAmount: number
): boolean {
  return (
    normalizeEnergyAmount(availableEnergy) - normalizeEnergyAmount(spendAmount) <
    getSpawnEnergyBufferRequirement(room, spawns)
  );
}

export function getSpawnEnergyAvailableForWithdrawal(
  room: Room,
  target: unknown,
  currentEnergy = getStoredEnergy(target)
): number {
  if (!isSpawnStructure(target)) {
    return normalizeEnergyAmount(currentEnergy);
  }

  const targetSpawnEnergy = normalizeEnergyAmount(currentEnergy);
  const spawns = ensureSpawnListIncludesTarget(getRoomSpawns(room), target);
  const roomTotalSpawnEnergy = spawns.reduce(
    (total, spawn) => total + (isSameSpawn(spawn, target) ? targetSpawnEnergy : getStoredEnergy(spawn)),
    0
  );
  const totalSpawnBuffer = getSpawnEnergyBufferThreshold(room) * spawns.length;
  const roomSurplus = Math.max(0, roomTotalSpawnEnergy - totalSpawnBuffer);
  return Math.min(targetSpawnEnergy, roomSurplus);
}

export function getSpawnEnergyWithdrawalAmount(
  room: Room,
  target: unknown,
  requestedAmount: number
): number {
  const requestedEnergy = normalizeEnergyAmount(requestedAmount);
  if (!isSpawnStructure(target)) {
    return requestedEnergy;
  }

  return Math.min(requestedEnergy, getSpawnEnergyAvailableForWithdrawal(room, target));
}

export function canWithdrawFromSpawnEnergyBuffer(
  room: Room,
  target: unknown,
  requestedAmount: number
): boolean {
  if (!isSpawnStructure(target)) {
    return true;
  }

  const requestedEnergy = normalizeEnergyAmount(requestedAmount);
  if (requestedEnergy <= 0) {
    return false;
  }

  return getSpawnEnergyAvailableForWithdrawal(room, target) >= requestedEnergy;
}

export function isSpawnEnergySource(target: unknown): target is StructureSpawn {
  return isSpawnStructure(target);
}

function getConfiguredSpawnEnergyBufferThreshold(room: Room): number | null {
  const roomMemory = (room as Room & { memory?: RoomMemory }).memory;
  const roomConfig = normalizeConfiguredThreshold(roomMemory?.spawnEnergyBuffer?.minimumEnergyPerSpawn);
  if (roomConfig !== null) {
    return roomConfig;
  }

  const memoryConfig = normalizeConfiguredThreshold(
    (globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.spawnEnergyBuffer?.rooms?.[getRoomName(room)]
      ?.minimumEnergyPerSpawn
  );
  return memoryConfig;
}

function getMinerAdjustedSpawnEnergyBufferThreshold(room: Room, baseThreshold: number): number {
  const minerOutputBufferCredit = getMinerOutputBufferCredit(getRoomMinerThroughput(room).energyPerTick);
  if (minerOutputBufferCredit <= 0) {
    return baseThreshold;
  }

  return Math.max(
    MINER_ADJUSTED_SPAWN_ENERGY_BUFFER_FLOOR,
    baseThreshold - minerOutputBufferCredit
  );
}

function getMinerOutputBufferCredit(minerOutputEnergyPerTick: number): number {
  return normalizeEnergyAmount(minerOutputEnergyPerTick * MINER_OUTPUT_BUFFER_CREDIT_TICKS);
}

function normalizeConfiguredThreshold(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.floor(value));
}

function getSpawnBufferCount(spawns: StructureSpawn[]): number {
  return spawns.length;
}

function getRoomSpawns(room: Room): StructureSpawn[] {
  const findMyStructures = (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
  const find = (room as {
    find?: (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => AnyOwnedStructure[];
  }).find;
  if (typeof findMyStructures === 'number' && typeof find === 'function') {
    return find
      .call(room, findMyStructures, { filter: (structure) => isSpawnStructure(structure) })
      .filter(isSpawnStructure);
  }

  return Object.values((globalThis as { Game?: Partial<Game> }).Game?.spawns ?? {}).filter(
    (spawn) => spawn.room?.name === getRoomName(room)
  );
}

function ensureSpawnListIncludesTarget(spawns: StructureSpawn[], target: StructureSpawn): StructureSpawn[] {
  return spawns.some((spawn) => isSameSpawn(spawn, target)) ? spawns : [...spawns, target];
}

function isSameSpawn(left: StructureSpawn, right: StructureSpawn): boolean {
  const leftKey = getSpawnStableKey(left);
  const rightKey = getSpawnStableKey(right);
  return leftKey.length > 0 && rightKey.length > 0 ? leftKey === rightKey : left === right;
}

function getRoomRcl(room: Room): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  const level = room.controller?.level;
  if (typeof level !== 'number' || !Number.isFinite(level)) {
    return 1;
  }

  return Math.min(8, Math.max(1, Math.floor(level))) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

function getRoomEnergyAvailable(room: Room): number {
  return normalizeEnergyAmount((room as Partial<Room>).energyAvailable);
}

function getWritableEconomyMemory(): EconomyMemory {
  const root = globalThis as { Memory?: Partial<Memory> };
  if (!root.Memory) {
    root.Memory = {};
  }

  if (!root.Memory.economy) {
    root.Memory.economy = {};
  }

  return root.Memory.economy;
}

function isSpawnStructure(target: unknown): target is StructureSpawn {
  const structureType = (target as Partial<Structure> | null)?.structureType;
  if (matchesStructureType(typeof structureType === 'string' ? structureType : undefined, 'STRUCTURE_SPAWN', 'spawn')) {
    return true;
  }

  return typeof (target as Partial<StructureSpawn> | null)?.spawnCreep === 'function';
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

function normalizeEnergyAmount(amount: unknown): number {
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
}

function getRoomName(room: Room): string {
  return typeof room.name === 'string' ? room.name : '';
}

function getSpawnStableKey(spawn: StructureSpawn): string {
  return getObjectId(spawn) || getSpawnName(spawn);
}

function getSpawnName(spawn: StructureSpawn): string {
  return typeof spawn.name === 'string' ? spawn.name : getObjectId(spawn);
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
  globalName: SpawnStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<SpawnStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}
