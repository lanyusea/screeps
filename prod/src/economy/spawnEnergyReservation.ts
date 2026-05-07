export const SPAWN_ENERGY_RESERVATION_IDLE_RELEASE_TICKS = 10;
export const SPAWN_ENERGY_RESERVATION_CRITICAL_ENERGY_THRESHOLD = 200;

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

  const hasIdleSpawn = spawns.some((spawn) => !spawn.spawning);
  const nextIdleSince = hasIdleSpawn ? getReservationIdleSince(reservation, gameTime) : undefined;
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
  const reservedAt = normalizeNonNegativeInteger(value.reservedAt);
  const updatedAt = normalizeNonNegativeInteger(value.updatedAt ?? reservedAt);
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

function getGameTime(): number {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
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

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
