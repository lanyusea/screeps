import { getTerminalEnergyTarget } from './energySurplus';
import { shouldAllowLocalFirstEnergyImport } from './localEnergyStrategy';
import { getRoomSpawnEnergyReservationState } from './spawnEnergyReservation';

export const STORAGE_BALANCE_EXPORT_RATIO = 0.8;
export const STORAGE_BALANCE_IMPORT_RATIO = 0.3;
export const STORAGE_BALANCE_REFRESH_INTERVAL = 25;

export interface RoomStoredEnergyState {
  roomName: string;
  energy: number;
  capacity: number;
  ratio: number;
  exportableEnergy: number;
  importDemand: number;
  storageEnergy: number;
  storageCapacity: number;
  storageFreeCapacity: number;
  terminalEnergy: number;
  terminalCapacity: number;
  terminalFreeCapacity: number;
  terminalTargetEnergy: number;
  terminalEnergyDeficit: number;
  terminalEnergySurplus: number;
  reservedSpawnEnergy: number;
  unmetSpawnEnergyReservation: number;
  mode: EconomyStorageBalanceMode;
}

interface RoomEnergyStore {
  store?: {
    getUsedCapacity?: (resource?: ResourceConstant) => number | null;
    getCapacity?: (resource?: ResourceConstant) => number | null;
    getFreeCapacity?: (resource?: ResourceConstant) => number | null;
    [resource: string]: unknown;
  };
}

export function balanceStorage(): void {
  const memory = getEconomyMemory();
  const gameTime = getGameTime();
  const existing = memory.storageBalance;
  if (existing && isStorageBalanceFresh(existing, gameTime)) {
    return;
  }

  memory.storageBalance = buildStorageBalanceState(gameTime);
}

export function getStorageBalanceState(): EconomyStorageBalanceMemory {
  const memory = getEconomyMemory();
  const gameTime = getGameTime();
  const existing = memory.storageBalance;
  if (existing && isStorageBalanceFresh(existing, gameTime)) {
    return existing;
  }

  const state = buildStorageBalanceState(gameTime);
  memory.storageBalance = state;
  return state;
}

export function getRoomStoredEnergyState(room: Room): RoomStoredEnergyState {
  const stores = getRoomEnergyStores(room);
  const storage = room.storage as unknown as RoomEnergyStore | undefined;
  const terminal = room.terminal as unknown as RoomEnergyStore | undefined;
  const storageEnergy = storage ? getStoredEnergy(storage) : 0;
  const storageCapacity = storage ? getEnergyCapacity(storage) : 0;
  const storageFreeCapacity = storage ? getEnergyFreeCapacity(storage) : 0;
  const terminalEnergy = terminal ? getStoredEnergy(terminal) : 0;
  const terminalCapacity = terminal ? getEnergyCapacity(terminal) : 0;
  const terminalFreeCapacity = terminal ? getEnergyFreeCapacity(terminal) : 0;
  const terminalTargetEnergy = getTerminalEnergyTarget(room.terminal);
  const terminalEnergyDeficit = Math.max(0, terminalTargetEnergy - terminalEnergy);
  const terminalEnergySurplus = Math.max(0, terminalEnergy - terminalTargetEnergy);
  const energy = stores.reduce((total, structure) => total + getStoredEnergy(structure), 0);
  const capacity = stores.reduce((total, structure) => total + getEnergyCapacity(structure), 0);
  const ratio = capacity > 0 ? energy / capacity : 0;
  const spawnEnergyReservation = getRoomSpawnEnergyReservationState(room);
  const rawExportableEnergy =
    capacity > 0 && ratio > STORAGE_BALANCE_EXPORT_RATIO
      ? Math.floor(energy - capacity * STORAGE_BALANCE_EXPORT_RATIO)
      : 0;
  const exportableEnergy = Math.max(0, rawExportableEnergy - spawnEnergyReservation.unmetReservedEnergy);
  const importDemand =
    capacity > 0 && ratio < STORAGE_BALANCE_IMPORT_RATIO
      ? Math.ceil(capacity * STORAGE_BALANCE_IMPORT_RATIO - energy)
      : 0;

  return {
    roomName: room.name,
    energy,
    capacity,
    ratio,
    exportableEnergy: Math.max(0, exportableEnergy),
    importDemand: Math.max(0, importDemand),
    storageEnergy,
    storageCapacity,
    storageFreeCapacity,
    terminalEnergy,
    terminalCapacity,
    terminalFreeCapacity,
    terminalTargetEnergy,
    terminalEnergyDeficit,
    terminalEnergySurplus,
    reservedSpawnEnergy: spawnEnergyReservation.reservedEnergy,
    unmetSpawnEnergyReservation: spawnEnergyReservation.unmetReservedEnergy,
    mode: selectStorageBalanceMode(capacity, ratio)
  };
}

function buildStorageBalanceState(gameTime: number): EconomyStorageBalanceMemory {
  const roomStates = getOwnedRooms()
    .map(getRoomStoredEnergyState)
    .filter((state) => state.capacity > 0);

  return {
    updatedAt: gameTime,
    rooms: Object.fromEntries(
      roomStates.map((state) => [
        state.roomName,
        {
          roomName: state.roomName,
          mode: state.mode,
          energy: state.energy,
          capacity: state.capacity,
          ratio: state.ratio,
          exportableEnergy: state.exportableEnergy,
          importDemand: state.importDemand,
          storageEnergy: state.storageEnergy,
          storageCapacity: state.storageCapacity,
          storageFreeCapacity: state.storageFreeCapacity,
          terminalEnergy: state.terminalEnergy,
          terminalCapacity: state.terminalCapacity,
          terminalFreeCapacity: state.terminalFreeCapacity,
          terminalTargetEnergy: state.terminalTargetEnergy,
          terminalEnergyDeficit: state.terminalEnergyDeficit,
          terminalEnergySurplus: state.terminalEnergySurplus,
          reservedSpawnEnergy: state.reservedSpawnEnergy,
          unmetSpawnEnergyReservation: state.unmetSpawnEnergyReservation,
          updatedAt: gameTime
        }
      ])
    ),
    transfers: buildStorageTransfers(roomStates, gameTime)
  };
}

function buildStorageTransfers(
  roomStates: RoomStoredEnergyState[],
  gameTime: number
): EconomyStorageTransferMemory[] {
  const exporters = roomStates
    .filter((state) => state.mode === 'export' && state.exportableEnergy > 0)
    .sort(compareExportRooms);
  const importers = roomStates
    .filter((state) => state.mode === 'import' && state.importDemand > 0)
    .sort(compareImportRooms);

  const remainingExport = new Map(exporters.map((state) => [state.roomName, state.exportableEnergy]));
  const transfers: EconomyStorageTransferMemory[] = [];

  for (const importer of importers) {
    let remainingDemand = importer.importDemand;
    for (const exporter of exporters) {
      if (remainingDemand <= 0) {
        break;
      }

      const exportableEnergy = remainingExport.get(exporter.roomName) ?? 0;
      if (
        !shouldAllowStorageTransferForLocalEnergyStrategy(importer, exporter.roomName)
      ) {
        continue;
      }

      const amount = Math.min(exportableEnergy, remainingDemand);
      if (amount <= 0) {
        continue;
      }

      transfers.push({
        sourceRoom: exporter.roomName,
        targetRoom: importer.roomName,
        amount,
        updatedAt: gameTime
      });
      remainingExport.set(exporter.roomName, exportableEnergy - amount);
      remainingDemand -= amount;
    }
  }

  return transfers;
}

function shouldAllowStorageTransferForLocalEnergyStrategy(
  importer: RoomStoredEnergyState,
  sourceRoom: string
): boolean {
  const targetRoom = getVisibleRoom(importer.roomName);
  if (!targetRoom) {
    return true;
  }

  return shouldAllowLocalFirstEnergyImport(targetRoom, {
    sourceRoom,
    storedEnergy: importer.energy
  });
}

function compareExportRooms(left: RoomStoredEnergyState, right: RoomStoredEnergyState): number {
  return (
    right.exportableEnergy - left.exportableEnergy ||
    right.ratio - left.ratio ||
    left.roomName.localeCompare(right.roomName)
  );
}

function compareImportRooms(left: RoomStoredEnergyState, right: RoomStoredEnergyState): number {
  return (
    right.importDemand - left.importDemand ||
    left.ratio - right.ratio ||
    left.roomName.localeCompare(right.roomName)
  );
}

function selectStorageBalanceMode(
  capacity: number,
  ratio: number
): EconomyStorageBalanceMode {
  if (capacity <= 0) {
    return 'balanced';
  }

  if (ratio > STORAGE_BALANCE_EXPORT_RATIO) {
    return 'export';
  }

  if (ratio < STORAGE_BALANCE_IMPORT_RATIO) {
    return 'import';
  }

  return 'balanced';
}

function getRoomEnergyStores(room: Room): RoomEnergyStore[] {
  const stores = [
    room.storage as unknown as RoomEnergyStore | undefined,
    room.terminal as unknown as RoomEnergyStore | undefined
  ];
  return stores.filter(
    (structure): structure is RoomEnergyStore => structure !== undefined
  );
}

function getStoredEnergy(target: RoomEnergyStore): number {
  const store = target.store;
  const resource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(resource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const directEnergy = store?.[resource];
  return typeof directEnergy === 'number' && Number.isFinite(directEnergy)
    ? Math.max(0, directEnergy)
    : 0;
}

function getEnergyCapacity(target: RoomEnergyStore): number {
  const store = target.store;
  const resource = getEnergyResource();
  const capacity = store?.getCapacity?.(resource);
  if (typeof capacity === 'number' && Number.isFinite(capacity)) {
    return Math.max(0, capacity);
  }

  const genericCapacity = store?.getCapacity?.();
  if (typeof genericCapacity === 'number' && Number.isFinite(genericCapacity)) {
    return Math.max(0, genericCapacity);
  }

  const freeCapacity = store?.getFreeCapacity?.(resource);
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)
    ? getStoredEnergy(target) + Math.max(0, freeCapacity)
    : 0;
}

function getEnergyFreeCapacity(target: RoomEnergyStore): number {
  const store = target.store;
  const resource = getEnergyResource();
  const freeCapacity = store?.getFreeCapacity?.(resource);
  if (typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)) {
    return Math.max(0, freeCapacity);
  }

  const capacity = getEnergyCapacity(target);
  return capacity > 0 ? Math.max(0, capacity - getStoredEnergy(target)) : 0;
}

function isStorageBalanceFresh(
  state: EconomyStorageBalanceMemory,
  gameTime: number
): boolean {
  return (
    typeof state.updatedAt === 'number' &&
    Number.isFinite(state.updatedAt) &&
    gameTime >= state.updatedAt &&
    gameTime - state.updatedAt < STORAGE_BALANCE_REFRESH_INTERVAL
  );
}

function getOwnedRooms(): Room[] {
  const rooms = (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms;
  if (!rooms) {
    return [];
  }

  return Object.values(rooms).filter((room): room is Room => room?.controller?.my === true);
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function getEconomyMemory(): EconomyMemory {
  const memory = getMemory();
  if (!memory.economy) {
    memory.economy = {};
  }

  return memory.economy;
}

function getMemory(): Partial<Memory> {
  const global = globalThis as unknown as { Memory?: Partial<Memory> };
  if (!global.Memory) {
    global.Memory = {};
  }

  return global.Memory;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}
