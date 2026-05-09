import type { RoomStoredEnergyState } from './storageBalancer';

export const MULTI_ROOM_ENERGY_CORRIDOR_ROOMS = ['E26S48', 'E26S49', 'E26S50'] as const;
export const MULTI_ROOM_ENERGY_SOURCE_WORKLOAD_MAX_AGE = 50;

export type MultiRoomEnergyTransferAuditStatus = 'planned' | 'suppressed' | 'blocked';
export type MultiRoomEnergyTransferAuditReason =
  | 'storage-balance'
  | 'spawn-energy-buffer'
  | 'local-first-sufficient'
  | 'local-first-policy'
  | 'insufficient-exportable-energy'
  | 'no-path'
  | 'no-exporter';

export interface MultiRoomEnergyTransferAudit {
  sourceRoom?: string;
  targetRoom: string;
  amount: number;
  status: MultiRoomEnergyTransferAuditStatus;
  reason: MultiRoomEnergyTransferAuditReason;
  updatedAt: number;
}

export interface MultiRoomEnergyRoomInput {
  roomState: RoomStoredEnergyState;
  plannedImports: number;
  plannedExports: number;
  auditEntries: MultiRoomEnergyTransferAudit[];
  gameTime: number;
}

export function buildMultiRoomEnergyState(
  roomStates: RoomStoredEnergyState[],
  transfers: EconomyStorageTransferMemory[],
  auditEntries: MultiRoomEnergyTransferAudit[],
  gameTime: number
): EconomyMultiRoomEnergyMemory {
  const importsByRoom = sumTransfersByRoom(transfers, 'targetRoom');
  const exportsByRoom = sumTransfersByRoom(transfers, 'sourceRoom');
  const auditsByRoom = groupAuditEntriesByTargetRoom(auditEntries);

  return {
    updatedAt: gameTime,
    corridor: [...MULTI_ROOM_ENERGY_CORRIDOR_ROOMS],
    rooms: Object.fromEntries(
      roomStates.map((roomState) => {
        const roomName = roomState.roomName;
        const roomMemory = buildMultiRoomEnergyRoom({
          roomState,
          plannedImports: importsByRoom.get(roomName) ?? 0,
          plannedExports: exportsByRoom.get(roomName) ?? 0,
          auditEntries: auditsByRoom.get(roomName) ?? [],
          gameTime
        });
        return [roomName, roomMemory];
      })
    ),
    transfers: auditEntries
  };
}

export function getMultiRoomEnergyRoomState(
  roomName: string
): EconomyMultiRoomEnergyRoomMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.multiRoomEnergy?.rooms?.[roomName];
}

export function getRoomLocalProductionEnergyPerTick(roomName: string): number {
  const workload = getRecentSourceWorkload(roomName);
  if (!workload) {
    return 0;
  }

  return Object.values(workload.sources).reduce(
    (total, source) => total + normalizeNonNegativeNumber(source.harvestEnergyPerTick),
    0
  );
}

export function getRoomLocalHarvestCapacityEnergyPerTick(roomName: string): number {
  const workload = getRecentSourceWorkload(roomName);
  if (!workload) {
    return 0;
  }

  return Object.values(workload.sources).reduce(
    (total, source) => total + normalizeNonNegativeNumber(source.regenEnergyPerTick),
    0
  );
}

function buildMultiRoomEnergyRoom(input: MultiRoomEnergyRoomInput): EconomyMultiRoomEnergyRoomMemory {
  const { roomState, plannedImports, plannedExports, auditEntries, gameTime } = input;
  const localProductionEnergyPerTick = getRoomLocalProductionEnergyPerTick(roomState.roomName);
  const localHarvestCapacityEnergyPerTick = getRoomLocalHarvestCapacityEnergyPerTick(roomState.roomName);
  const localConsumptionEnergyPerTick = estimateRoomLocalConsumptionEnergyPerTick(roomState.roomName);
  const spawnEnergy = getRoomSpawnEnergyState(roomState.roomName);
  const storageDeficit = Math.max(0, roomState.importDemand - plannedImports);
  const surplusEnergy = Math.max(0, roomState.exportableEnergy - plannedExports);
  const blockedImportEnergy = auditEntries
    .filter((entry) => entry.status === 'blocked')
    .reduce((total, entry) => total + normalizeNonNegativeInteger(entry.amount), 0);
  const suppressedImportEnergy = auditEntries
    .filter((entry) => entry.status === 'suppressed')
    .reduce((total, entry) => total + normalizeNonNegativeInteger(entry.amount), 0);
  const bottleneck = selectRoomEnergyBottleneck(storageDeficit, blockedImportEnergy, auditEntries);

  return {
    roomName: roomState.roomName,
    mode: roomState.mode,
    storedEnergy: roomState.energy,
    storageCapacity: roomState.capacity,
    storageRatio: roomState.ratio,
    importDemand: roomState.importDemand,
    exportableEnergy: roomState.exportableEnergy,
    plannedImportEnergy: plannedImports,
    plannedExportEnergy: plannedExports,
    localProductionEnergyPerTick,
    localHarvestCapacityEnergyPerTick,
    localHarvestCoverageRatio: roundRatio(localProductionEnergyPerTick, localHarvestCapacityEnergyPerTick),
    localConsumptionEnergyPerTick,
    netLocalEnergyPerTick: localProductionEnergyPerTick - localConsumptionEnergyPerTick,
    spawnEnergyAvailable: spawnEnergy.available,
    spawnEnergyCapacity: spawnEnergy.capacity,
    spawnEnergyDeficit: spawnEnergy.deficit,
    spawnEnergyBufferThreshold: roomState.spawnEnergyBufferThreshold,
    spawnEnergyBufferDeficit: roomState.spawnEnergyBufferDeficit,
    criticalSpawnEnergyDeficit: roomState.criticalSpawnEnergyDeficit,
    storageDeficit,
    deficitEnergy: storageDeficit,
    surplusEnergy,
    suppressedImportEnergy,
    blockedImportEnergy,
    ...(bottleneck ? { bottleneck } : {}),
    updatedAt: gameTime
  };
}

function selectRoomEnergyBottleneck(
  storageDeficit: number,
  blockedImportEnergy: number,
  auditEntries: MultiRoomEnergyTransferAudit[]
): EconomyMultiRoomEnergyBottleneck | undefined {
  if (auditEntries.some((entry) => entry.reason === 'no-exporter')) {
    return 'no-exporter';
  }

  if (auditEntries.some((entry) => entry.reason === 'no-path')) {
    return 'no-path';
  }

  if (
    storageDeficit > 0 &&
    auditEntries.some((entry) => entry.reason === 'insufficient-exportable-energy')
  ) {
    return 'insufficient-exportable-energy';
  }

  if (
    auditEntries.some(
      (entry) => entry.status === 'suppressed' && entry.reason === 'local-first-sufficient'
    )
  ) {
    return 'local-first-sufficient';
  }

  return undefined;
}

function estimateRoomLocalConsumptionEnergyPerTick(roomName: string): number {
  const room = getVisibleRoom(roomName);
  if (!room) {
    return 0;
  }

  return findMyCreeps(room).reduce(
    (total, creep) => total + estimateCreepEnergyUsePerTick(creep),
    0
  );
}

function estimateCreepEnergyUsePerTick(creep: Creep): number {
  const workParts = getActiveWorkParts(creep);
  if (workParts <= 0) {
    return 0;
  }

  switch (creep.memory?.task?.type) {
    case 'build':
      return workParts * getGlobalNumber('BUILD_POWER', 5);
    case 'repair':
      return workParts;
    case 'upgrade':
      return workParts * getGlobalNumber('UPGRADE_CONTROLLER_POWER', 1);
    default:
      return 0;
  }
}

function getActiveWorkParts(creep: Creep): number {
  const workPart = getWorkPartConstant();
  const activeParts = creep.getActiveBodyparts?.(workPart);
  if (typeof activeParts === 'number' && Number.isFinite(activeParts)) {
    return Math.max(0, Math.floor(activeParts));
  }

  if (!Array.isArray(creep.body)) {
    return 0;
  }

  return creep.body.filter((part) => part.type === workPart && part.hits > 0).length;
}

function getRoomSpawnEnergyState(roomName: string): {
  available: number;
  capacity: number;
  deficit: number;
} {
  const room = getVisibleRoom(roomName);
  const available = normalizeNonNegativeInteger(room?.energyAvailable);
  const capacity = normalizeNonNegativeInteger(room?.energyCapacityAvailable);
  return {
    available,
    capacity,
    deficit: Math.max(0, capacity - available)
  };
}

function getRecentSourceWorkload(roomName: string): EconomyRoomSourceWorkloadMemory | null {
  const workload = (globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.sourceWorkloads?.[roomName];
  if (!workload || typeof workload.updatedAt !== 'number' || !Number.isFinite(workload.updatedAt)) {
    return null;
  }

  const gameTime = getGameTime();
  if (gameTime < workload.updatedAt || gameTime - workload.updatedAt > MULTI_ROOM_ENERGY_SOURCE_WORKLOAD_MAX_AGE) {
    return null;
  }

  return workload;
}

function sumTransfersByRoom(
  transfers: EconomyStorageTransferMemory[],
  key: 'sourceRoom' | 'targetRoom'
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const transfer of transfers) {
    const roomName = transfer[key];
    totals.set(roomName, (totals.get(roomName) ?? 0) + normalizeNonNegativeInteger(transfer.amount));
  }

  return totals;
}

function groupAuditEntriesByTargetRoom(
  auditEntries: MultiRoomEnergyTransferAudit[]
): Map<string, MultiRoomEnergyTransferAudit[]> {
  const entriesByRoom = new Map<string, MultiRoomEnergyTransferAudit[]>();
  for (const entry of auditEntries) {
    const entries = entriesByRoom.get(entry.targetRoom) ?? [];
    entries.push(entry);
    entriesByRoom.set(entry.targetRoom, entries);
  }

  return entriesByRoom;
}

function findMyCreeps(room: Room): Creep[] {
  const findMyCreeps = (globalThis as Record<string, unknown>).FIND_MY_CREEPS;
  if (typeof findMyCreeps !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = (room.find as unknown as (type: number) => unknown[])(findMyCreeps);
  return Array.isArray(result) ? (result as Creep[]) : [];
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function getWorkPartConstant(): BodyPartConstant {
  return ((globalThis as { WORK?: BodyPartConstant }).WORK ?? 'work') as BodyPartConstant;
}

function getGlobalNumber(name: string, fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 1_000) / 1_000;
}
