export const SPAWN_ENERGY_RESERVATION_IDLE_RELEASE_TICKS = 10;
export const SPAWN_ENERGY_RESERVATION_CRITICAL_ENERGY_THRESHOLD = 200;
export const DEFAULT_SPAWN_ENERGY_RESERVATION_TRANSFER_THRESHOLD = 300;
export const SPAWN_ENERGY_RESERVATION_TRANSFER_MAX_RANGE = 3;

export interface SpawnEnergyReservationRequest {
  roomName: string;
  bodyCost: number;
  creepName: string;
  role: string;
  sourceCreepName?: string;
  sourceRole?: string;
}

export interface RoomSpawnEnergyReservationState {
  active: boolean;
  bodyCost: number;
  creepName?: string;
  idleSince?: number;
  idleTicks?: number;
  reservedAt?: number;
  reservedEnergy: number;
  role?: string;
  roomEnergyAvailable: number;
  roomName: string;
  sourceCreepName?: string;
  sourceRole?: string;
  unmetReservedEnergy: number;
  updatedAt?: number;
}

export interface SpawnEnergyReservationRefillTarget {
  range: number | null;
  spawn: StructureSpawn;
  spawnEnergy: number;
  threshold: number;
  unmetReservedEnergy: number;
}

export function reserveSpawnEnergyForNextRequest(
  request: SpawnEnergyReservationRequest | null,
  gameTime = getGameTime()
): EconomySpawnEnergyReservationRoomMemory | null {
  if (!request || request.bodyCost <= 0 || request.roomName.length === 0) {
    if (request?.roomName) {
      clearSpawnEnergyReservation(request.roomName, gameTime);
    }
    return null;
  }

  const memory = getWritableEconomyMemory();
  const reservationMemory = ensureSpawnEnergyReservationMemory(memory, gameTime);
  const reservedEnergy = normalizeNonNegativeInteger(request.bodyCost);
  const reservation: EconomySpawnEnergyReservationRoomMemory = {
    bodyCost: reservedEnergy,
    creepName: request.creepName,
    reservedAt: gameTime,
    reservedEnergy,
    role: request.role,
    roomName: request.roomName,
    ...(request.sourceCreepName ? { sourceCreepName: request.sourceCreepName } : {}),
    ...(request.sourceRole ? { sourceRole: request.sourceRole } : {}),
    updatedAt: gameTime
  };

  reservationMemory.updatedAt = gameTime;
  reservationMemory.rooms[request.roomName] = reservation;
  return reservation;
}

export function clearSpawnEnergyReservation(roomName: string, gameTime = getGameTime()): void {
  const memory = getWritableEconomyMemory();
  const reservationMemory = ensureSpawnEnergyReservationMemory(memory, gameTime);
  delete reservationMemory.rooms[roomName];
  reservationMemory.updatedAt = gameTime;
}

export function refreshSpawnEnergyReservationState(
  room: Room,
  spawns: StructureSpawn[],
  gameTime = getGameTime()
): RoomSpawnEnergyReservationState {
  const roomName = getRoomName(room);
  const reservation = getSpawnEnergyReservation(roomName);
  if (!reservation) {
    return buildInactiveReservationState(room);
  }

  if (isRoomEnergyCritical(room)) {
    clearSpawnEnergyReservation(roomName, gameTime);
    return buildInactiveReservationState(room);
  }

  const allSpawnsIdle = spawns.every((spawn) => !spawn.spawning);
  const nextIdleSince = allSpawnsIdle ? getReservationIdleSince(reservation, gameTime) : undefined;
  const idleTicks = nextIdleSince === undefined ? undefined : Math.max(0, gameTime - nextIdleSince);
  if (idleTicks !== undefined && idleTicks > SPAWN_ENERGY_RESERVATION_IDLE_RELEASE_TICKS) {
    clearSpawnEnergyReservation(roomName, gameTime);
    return buildInactiveReservationState(room);
  }

  const refreshed: EconomySpawnEnergyReservationRoomMemory = {
    ...reservation,
    ...(nextIdleSince === undefined ? {} : { idleSince: nextIdleSince, idleTicks }),
    updatedAt: gameTime
  };
  if (nextIdleSince === undefined) {
    delete refreshed.idleSince;
    delete refreshed.idleTicks;
  }

  writeSpawnEnergyReservation(refreshed, gameTime);
  return buildActiveReservationState(room, refreshed);
}

export function getRoomSpawnEnergyReservationState(room: Room): RoomSpawnEnergyReservationState {
  const reservation = getSpawnEnergyReservation(getRoomName(room));
  return reservation ? buildActiveReservationState(room, reservation) : buildInactiveReservationState(room);
}

export function getReservedSpawnEnergy(room: Room | string): number {
  return getSpawnEnergyReservation(typeof room === 'string' ? room : getRoomName(room))?.reservedEnergy ?? 0;
}

export function getUnmetSpawnEnergyReservation(room: Room): number {
  const state = getRoomSpawnEnergyReservationState(room);
  return state.unmetReservedEnergy;
}

export function getSpawnEnergyReservationTransferThreshold(room: Room): number {
  return (
    getConfiguredSpawnEnergyReservationNumber(room, 'transferThreshold') ??
    getConfiguredSpawnEnergyReservationNumber(room, 'energyTransferThreshold') ??
    DEFAULT_SPAWN_ENERGY_RESERVATION_TRANSFER_THRESHOLD
  );
}

export function selectSpawnEnergyReservationRefillTarget(
  creep: Creep
): SpawnEnergyReservationRefillTarget | null {
  if (getStoredEnergy(creep) <= 0) {
    return null;
  }

  const room = creep.room;
  if (!room) {
    return null;
  }

  const reservation = getRoomSpawnEnergyReservationState(room);
  if (!reservation.active || reservation.unmetReservedEnergy <= 0) {
    return null;
  }

  const threshold = getSpawnEnergyReservationTransferThreshold(room);
  if (threshold <= 0) {
    return null;
  }

  const candidates = findOwnedSpawns(room)
    .map((spawn) => toSpawnEnergyReservationRefillTarget(creep, spawn, threshold, reservation.unmetReservedEnergy))
    .filter((target): target is SpawnEnergyReservationRefillTarget => target !== null);

  return candidates.sort(compareSpawnEnergyReservationRefillTargets)[0] ?? null;
}

function getSpawnEnergyReservation(roomName: string): EconomySpawnEnergyReservationRoomMemory | null {
  const gameRooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (gameRooms && !gameRooms[roomName]) {
    return null;
  }

  const raw = (globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.spawnEnergyReservation?.rooms?.[roomName];
  const reservation = normalizeSpawnEnergyReservation(raw, roomName);
  if (!reservation) {
    return null;
  }

  const gameTime = getGameTime();
  return reservation.updatedAt <= gameTime && reservation.reservedAt <= gameTime ? reservation : null;
}

function writeSpawnEnergyReservation(
  reservation: EconomySpawnEnergyReservationRoomMemory,
  gameTime: number
): void {
  const memory = getWritableEconomyMemory();
  const reservationMemory = ensureSpawnEnergyReservationMemory(memory, gameTime);
  reservationMemory.updatedAt = gameTime;
  reservationMemory.rooms[reservation.roomName] = reservation;
}

function ensureSpawnEnergyReservationMemory(
  memory: EconomyMemory,
  gameTime: number
): EconomySpawnEnergyReservationMemory {
  if (!isPlainObject(memory.spawnEnergyReservation) || !isPlainObject(memory.spawnEnergyReservation.rooms)) {
    memory.spawnEnergyReservation = { updatedAt: gameTime, rooms: {} };
  }

  return memory.spawnEnergyReservation;
}

function normalizeSpawnEnergyReservation(
  value: unknown,
  fallbackRoomName: string
): EconomySpawnEnergyReservationRoomMemory | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const reservedEnergy = normalizeNonNegativeInteger(value.reservedEnergy ?? value.bodyCost);
  const bodyCost = normalizeNonNegativeInteger(value.bodyCost ?? reservedEnergy);
  const role = typeof value.role === 'string' && value.role.length > 0 ? value.role : undefined;
  const creepName = typeof value.creepName === 'string' && value.creepName.length > 0 ? value.creepName : undefined;
  if (reservedEnergy <= 0 || bodyCost <= 0 || !role || !creepName) {
    return null;
  }

  const roomName = typeof value.roomName === 'string' && value.roomName.length > 0
    ? value.roomName
    : fallbackRoomName;
  if (
    typeof value.reservedAt !== 'number' ||
    !Number.isFinite(value.reservedAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt)
  ) {
    return null;
  }

  const reservedAt = normalizeNonNegativeInteger(value.reservedAt);
  const updatedAt = normalizeNonNegativeInteger(value.updatedAt);
  const idleSince = normalizeOptionalNonNegativeInteger(value.idleSince);
  const idleTicks = normalizeOptionalNonNegativeInteger(value.idleTicks);
  const sourceCreepName = typeof value.sourceCreepName === 'string' && value.sourceCreepName.length > 0
    ? value.sourceCreepName
    : undefined;
  const sourceRole = typeof value.sourceRole === 'string' && value.sourceRole.length > 0
    ? value.sourceRole
    : undefined;

  return {
    bodyCost,
    creepName,
    ...(idleSince === undefined ? {} : { idleSince }),
    ...(idleTicks === undefined ? {} : { idleTicks }),
    reservedAt,
    reservedEnergy,
    role,
    roomName,
    ...(sourceCreepName ? { sourceCreepName } : {}),
    ...(sourceRole ? { sourceRole } : {}),
    updatedAt
  };
}

function buildActiveReservationState(
  room: Room,
  reservation: EconomySpawnEnergyReservationRoomMemory
): RoomSpawnEnergyReservationState {
  const roomEnergyAvailable = getRoomEnergyAvailable(room);
  return {
    active: true,
    bodyCost: reservation.bodyCost,
    creepName: reservation.creepName,
    ...(reservation.idleSince === undefined ? {} : { idleSince: reservation.idleSince }),
    ...(reservation.idleTicks === undefined ? {} : { idleTicks: reservation.idleTicks }),
    reservedAt: reservation.reservedAt,
    reservedEnergy: reservation.reservedEnergy,
    role: reservation.role,
    roomEnergyAvailable,
    roomName: getRoomName(room),
    ...(reservation.sourceCreepName ? { sourceCreepName: reservation.sourceCreepName } : {}),
    ...(reservation.sourceRole ? { sourceRole: reservation.sourceRole } : {}),
    unmetReservedEnergy: Math.max(0, reservation.reservedEnergy - roomEnergyAvailable),
    updatedAt: reservation.updatedAt
  };
}

function buildInactiveReservationState(room: Room): RoomSpawnEnergyReservationState {
  return {
    active: false,
    bodyCost: 0,
    reservedEnergy: 0,
    roomEnergyAvailable: getRoomEnergyAvailable(room),
    roomName: getRoomName(room),
    unmetReservedEnergy: 0
  };
}

function getReservationIdleSince(
  reservation: EconomySpawnEnergyReservationRoomMemory,
  gameTime: number
): number {
  if (
    typeof reservation.idleSince === 'number' &&
    Number.isFinite(reservation.idleSince) &&
    reservation.idleSince <= gameTime
  ) {
    return Math.max(0, Math.floor(reservation.idleSince));
  }

  return gameTime;
}

function isRoomEnergyCritical(room: Room): boolean {
  return getRoomEnergyAvailable(room) < SPAWN_ENERGY_RESERVATION_CRITICAL_ENERGY_THRESHOLD;
}

function getRoomName(room: Room): string {
  return typeof room.name === 'string' && room.name.length > 0 ? room.name : 'unknown';
}

function getRoomEnergyAvailable(room: Room): number {
  return normalizeNonNegativeInteger((room as Partial<Room>).energyAvailable);
}

function findOwnedSpawns(room: Room): StructureSpawn[] {
  const findMyStructures = (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
  const find = (room as {
    find?: (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => AnyOwnedStructure[];
  }).find;

  if (typeof findMyStructures === 'number' && typeof find === 'function') {
    return find
      .call(room, findMyStructures, { filter: isSpawnStructure })
      .filter(isSpawnStructure);
  }

  return Object.values((globalThis as { Game?: Partial<Game> }).Game?.spawns ?? {}).filter(
    (spawn) => spawn.room?.name === getRoomName(room)
  );
}

function toSpawnEnergyReservationRefillTarget(
  creep: Creep,
  spawn: StructureSpawn,
  threshold: number,
  unmetReservedEnergy: number
): SpawnEnergyReservationRefillTarget | null {
  if (spawn.spawning) {
    return null;
  }

  const spawnEnergy = getStoredEnergy(spawn);
  if (spawnEnergy >= threshold || getFreeEnergyCapacity(spawn) <= 0) {
    return null;
  }

  const range = getRangeToRoomObject(creep, spawn);
  if (range !== null && range > SPAWN_ENERGY_RESERVATION_TRANSFER_MAX_RANGE) {
    return null;
  }

  return {
    range,
    spawn,
    spawnEnergy,
    threshold,
    unmetReservedEnergy
  };
}

function compareSpawnEnergyReservationRefillTargets(
  left: SpawnEnergyReservationRefillTarget,
  right: SpawnEnergyReservationRefillTarget
): number {
  return (
    compareOptionalRanges(left.range, right.range) ||
    left.spawnEnergy - right.spawnEnergy ||
    getObjectId(left.spawn).localeCompare(getObjectId(right.spawn))
  );
}

function compareOptionalRanges(left: number | null, right: number | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

function getRangeToRoomObject(creep: Creep, target: RoomObject): number | null {
  const range = creep.pos?.getRangeTo?.(target);
  return typeof range === 'number' && Number.isFinite(range) ? Math.max(0, Math.floor(range)) : null;
}

function getFreeEnergyCapacity(target: unknown): number {
  const store = (
    target as {
      store?: {
        getFreeCapacity?: (resource?: ResourceConstant) => number | null;
        [resource: string]: unknown;
      };
    } | null
  )?.store;
  const freeCapacity = store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)
    ? Math.max(0, Math.floor(freeCapacity))
    : 0;
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

function isSpawnStructure(target: unknown): target is StructureSpawn {
  const structureType = (target as Partial<Structure> | null)?.structureType;
  const constants = globalThis as { STRUCTURE_SPAWN?: string };
  if (typeof structureType === 'string' && structureType === (constants.STRUCTURE_SPAWN ?? 'spawn')) {
    return true;
  }

  return typeof (target as Partial<StructureSpawn> | null)?.spawnCreep === 'function';
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

function getConfiguredSpawnEnergyReservationNumber(room: Room, field: string): number | null {
  const roomConfig = normalizeOptionalNonNegativeInteger(
    (room as Room & { memory?: { spawnEnergyReservation?: Record<string, unknown> } })
      .memory?.spawnEnergyReservation?.[field]
  );
  if (roomConfig !== undefined) {
    return roomConfig;
  }

  const economyConfig = normalizeOptionalNonNegativeInteger(
    ((globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.spawnEnergyReservation as unknown as
      | Record<string, unknown>
      | undefined)?.[field]
  );
  return economyConfig ?? null;
}

function getGameTime(): number {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function getWritableEconomyMemory(): EconomyMemory {
  const root = globalThis as { Memory?: Partial<Memory> };
  if (!root.Memory || typeof root.Memory !== 'object') {
    root.Memory = {};
  }

  if (!root.Memory.economy || typeof root.Memory.economy !== 'object') {
    root.Memory.economy = {};
  }

  return root.Memory.economy;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
