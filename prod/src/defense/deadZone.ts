interface DeadZoneAssessment {
  unsafe: boolean;
  hostileCreepCount: number;
  hostileStructureCount: number;
  hostileTowerCount: number;
  reason?: DefenseUnsafeRoomReason;
}

const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;

export function refreshVisibleDeadZoneMemory(gameTime = getGameTime()): void {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return;
  }

  for (const room of Object.values(rooms)) {
    refreshVisibleRoomDeadZoneMemory(room, gameTime);
  }
}

export function refreshVisibleRoomDeadZoneMemory(room: Room, gameTime = getGameTime()): boolean {
  const assessment = assessVisibleRoomDeadZone(room);
  if (!assessment.unsafe || !assessment.reason) {
    clearKnownDeadZoneRoom(room.name);
    return false;
  }

  const defenseMemory = getWritableDefenseMemory();
  if (!defenseMemory) {
    return true;
  }

  const unsafeRooms = defenseMemory.unsafeRooms ?? {};
  unsafeRooms[room.name] = {
    roomName: room.name,
    unsafe: true,
    reason: assessment.reason,
    updatedAt: gameTime,
    hostileCreepCount: assessment.hostileCreepCount,
    hostileStructureCount: assessment.hostileStructureCount,
    hostileTowerCount: assessment.hostileTowerCount
  };
  defenseMemory.unsafeRooms = unsafeRooms;
  return true;
}

export function isKnownDeadZoneRoom(roomName: string): boolean {
  const visibleRoom = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
  if (visibleRoom) {
    return refreshVisibleRoomDeadZoneMemory(visibleRoom);
  }

  return getKnownDeadZoneRoom(roomName) !== null;
}

export function getKnownDeadZoneRoom(roomName: string): DefenseUnsafeRoomMemory | null {
  const roomMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense?.unsafeRooms?.[roomName];
  return isDefenseUnsafeRoomMemory(roomMemory) ? roomMemory : null;
}

export function clearKnownDeadZoneRoom(roomName: string): void {
  const defenseMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense;
  const unsafeRooms = defenseMemory?.unsafeRooms;
  if (!unsafeRooms || unsafeRooms[roomName] === undefined) {
    return;
  }

  delete unsafeRooms[roomName];
  if (Object.keys(unsafeRooms).length === 0) {
    delete defenseMemory.unsafeRooms;
  }
}

export function hasSafeRouteAvoidingDeadZones(fromRoom: string, targetRoom: string): boolean | null {
  if (fromRoom === targetRoom) {
    return true;
  }

  const gameMap = getGameMapWithFindRoute();
  if (!gameMap) {
    return null;
  }

  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName: string) => (isKnownDeadZoneRoom(roomName) ? Infinity : 1)
  });

  if (route === getNoPathResultCode()) {
    return false;
  }

  return Array.isArray(route) ? true : null;
}

export function isRouteBlockedByKnownDeadZone(fromRoom: string, targetRoom: string): boolean {
  if (fromRoom === targetRoom || !hasAnyKnownDeadZoneRoom()) {
    return false;
  }

  const gameMap = getGameMapWithFindRoute();
  if (!gameMap) {
    return false;
  }

  let touchedDeadZone = false;
  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName: string) => {
      const deadZone = isKnownDeadZoneRoom(roomName);
      touchedDeadZone ||= deadZone;
      return deadZone ? Infinity : 1;
    }
  });

  return touchedDeadZone && route === getNoPathResultCode();
}

function assessVisibleRoomDeadZone(room: Room): DeadZoneAssessment {
  const hostileCreeps = findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS');
  const hostileStructures = findRoomObjects<Structure>(room, 'FIND_HOSTILE_STRUCTURES');
  const hostileTowerCount = hostileStructures.filter(isTowerStructure).length;
  const hostileStructureCount = hostileStructures.length;
  const hostileCreepCount = hostileCreeps.length;

  if (hostileTowerCount > 0) {
    return {
      unsafe: true,
      reason: 'enemyTower',
      hostileCreepCount,
      hostileStructureCount,
      hostileTowerCount
    };
  }

  if (hostileCreepCount > 0 || hostileStructureCount > 0) {
    return {
      unsafe: true,
      reason: 'hostilePresence',
      hostileCreepCount,
      hostileStructureCount,
      hostileTowerCount
    };
  }

  return {
    unsafe: false,
    hostileCreepCount,
    hostileStructureCount,
    hostileTowerCount
  };
}

function findRoomObjects<T>(room: Room, constantName: 'FIND_HOSTILE_CREEPS' | 'FIND_HOSTILE_STRUCTURES'): T[] {
  const findConstant = (globalThis as Record<string, unknown>)[constantName];
  const find = (room as Room & { find?: unknown }).find;
  if (typeof findConstant !== 'number' || typeof find !== 'function') {
    return [];
  }

  try {
    const result = (find as (type: number) => unknown).call(room, findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function isTowerStructure(structure: Structure): boolean {
  const towerType = (globalThis as { STRUCTURE_TOWER?: StructureConstant }).STRUCTURE_TOWER ?? 'tower';
  return structure.structureType === towerType;
}

function hasAnyKnownDeadZoneRoom(): boolean {
  const unsafeRooms = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense?.unsafeRooms;
  return unsafeRooms !== undefined && Object.keys(unsafeRooms).length > 0;
}

function isDefenseUnsafeRoomMemory(value: unknown): value is DefenseUnsafeRoomMemory {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<DefenseUnsafeRoomMemory>;
  return (
    typeof candidate.roomName === 'string' &&
    candidate.unsafe === true &&
    (candidate.reason === 'enemyTower' || candidate.reason === 'hostilePresence') &&
    typeof candidate.updatedAt === 'number'
  );
}

function getWritableDefenseMemory(): DefenseMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  const defenseMemory = memory.defense ?? {};
  memory.defense = defenseMemory;
  return defenseMemory;
}

function getGameMapWithFindRoute():
  | (Partial<GameMap> & {
      findRoute: (
        fromRoom: string,
        toRoom: string,
        opts?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
      ) => unknown;
    })
  | null {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & {
        findRoute?: (
          fromRoom: string,
          toRoom: string,
          opts?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
        ) => unknown;
      })
    | undefined;

  return typeof gameMap?.findRoute === 'function'
    ? (gameMap as Partial<GameMap> & {
        findRoute: (
          fromRoom: string,
          toRoom: string,
          opts?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
        ) => unknown;
      })
    : null;
}

function getNoPathResultCode(): ScreepsReturnCode {
  const noPathCode = (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  return typeof noPathCode === 'number' ? noPathCode : ERR_NO_PATH_CODE;
}

function getGameTime(): number {
  return typeof (globalThis as { Game?: Partial<Game> }).Game?.time === 'number'
    ? (globalThis as { Game: Partial<Game> }).Game.time ?? 0
    : 0;
}
