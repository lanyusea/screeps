import { isKnownDeadZoneRoom } from '../defense/deadZone';

export interface LogisticsRoute {
  distance: number;
  rooms: string[];
}

export const safeTransitAllowlist = new Set<string>();

export function canFindOwnedLogisticsRoute(): boolean {
  return typeof getGameMap()?.findRoute === 'function';
}

export function findOwnedLogisticsRoute(fromRoom: string, targetRoom: string): LogisticsRoute | null {
  if (!isSafeOwnedRoom(fromRoom) || !isSafeOwnedRoom(targetRoom)) {
    return null;
  }

  if (fromRoom === targetRoom) {
    return { distance: 0, rooms: [] };
  }

  const gameMap = getGameMap();
  if (typeof gameMap?.findRoute !== 'function') {
    return null;
  }

  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName: string) => (isSafeLogisticsTransitRoom(roomName) ? 1 : Infinity)
  });
  if (route === getNoPathResultCode() || !Array.isArray(route)) {
    return null;
  }

  const rooms = route
    .map((step) => (isRecord(step) && typeof step.room === 'string' ? step.room : null))
    .filter((roomName): roomName is string => typeof roomName === 'string');
  if (rooms.length !== route.length || !rooms.every(isSafeLogisticsTransitRoom)) {
    return null;
  }

  return { distance: rooms.length, rooms };
}

export function isSafeOwnedRoom(roomName: string): boolean {
  const room = getVisibleRoom(roomName);
  return room?.controller?.my === true && !hasHostilePresence(room);
}

export function isSafeLogisticsTransitRoom(roomName: string): boolean {
  const room = getVisibleRoom(roomName);
  if (!room) {
    return isConfiguredSafeTransitRoom(roomName) || !isKnownDeadZoneRoom(roomName);
  }

  return !hasHostilePresence(room);
}

function isConfiguredSafeTransitRoom(roomName: string): boolean {
  return (
    safeTransitAllowlist.has(roomName) ||
    normalizeStringList((globalThis as { Memory?: Partial<Memory> }).Memory?.economy?.safeTransitAllowlist)
      .includes(roomName)
  );
}

function hasHostilePresence(room: Room): boolean {
  const hostileCreepFind = getGlobalNumber('FIND_HOSTILE_CREEPS');
  if (typeof hostileCreepFind === 'number' && typeof room.find === 'function') {
    const hostiles = room.find(hostileCreepFind as FindConstant);
    if (Array.isArray(hostiles) && hostiles.length > 0) {
      return true;
    }
  }

  const hostileStructureFind = getGlobalNumber('FIND_HOSTILE_STRUCTURES');
  if (typeof hostileStructureFind === 'number' && typeof room.find === 'function') {
    const hostiles = room.find(hostileStructureFind as FindConstant);
    if (Array.isArray(hostiles) && hostiles.length > 0) {
      return true;
    }
  }

  return false;
}

function getGameMap():
  | (Partial<GameMap> & {
      findRoute?: (
        fromRoom: string,
        toRoom: string,
        opts?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
      ) => unknown;
    })
  | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map as
    | (Partial<GameMap> & {
        findRoute?: (
          fromRoom: string,
          toRoom: string,
          opts?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
        ) => unknown;
      })
    | undefined;
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function getNoPathResultCode(): ScreepsReturnCode {
  return (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH ?? (-2 as ScreepsReturnCode);
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}
