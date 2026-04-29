export interface CriticalRoadLogisticsContext {
  anchorPositions: RoomPosition[];
  targetPositions: RoomPosition[];
}

interface RoadWorkTarget {
  pos?: RoomPosition;
  structureType?: string;
}

type StructureConstantGlobal = 'STRUCTURE_ROAD' | 'STRUCTURE_SPAWN';

const CRITICAL_ROAD_ROUTE_RANGE = 2;

export function buildCriticalRoadLogisticsContext(room: Room): CriticalRoadLogisticsContext {
  const anchorPositions = findOwnedSpawnPositions(room);
  const targetPositions = findLogisticsTargetPositions(room);

  return {
    anchorPositions:
      anchorPositions.length > 0 ? anchorPositions : findRemoteTerritoryLogisticsAnchorPositions(room, targetPositions),
    targetPositions
  };
}

export function isCriticalRoadLogisticsWork(
  target: RoadWorkTarget,
  context: CriticalRoadLogisticsContext
): boolean {
  if (
    !isRoadWorkTarget(target) ||
    !target.pos ||
    context.anchorPositions.length === 0 ||
    context.targetPositions.length === 0
  ) {
    return false;
  }

  const position = target.pos;
  return context.anchorPositions.some((anchor) =>
    context.targetPositions.some((destination) => isNearLogisticsRoute(position, anchor, destination))
  );
}

function findOwnedSpawnPositions(room: Room): RoomPosition[] {
  return findRoomObjects<AnyOwnedStructure>(room, 'FIND_MY_STRUCTURES')
    .filter((structure): structure is StructureSpawn =>
      matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn')
    )
    .map((spawn) => spawn.pos)
    .filter((position): position is RoomPosition => isSameRoomPosition(position, room.name));
}

function findLogisticsTargetPositions(room: Room): RoomPosition[] {
  const sourcePositions = findRoomObjects<Source>(room, 'FIND_SOURCES')
    .map((source) => source.pos)
    .filter((position): position is RoomPosition => isSameRoomPosition(position, room.name));
  const controllerPosition = isSameRoomPosition(room.controller?.pos, room.name) ? [room.controller.pos] : [];

  return [...sourcePositions, ...controllerPosition];
}

function findRemoteTerritoryLogisticsAnchorPositions(room: Room, targetPositions: RoomPosition[]): RoomPosition[] {
  if (targetPositions.length === 0 || !isRemoteTerritoryLogisticsRoom(room)) {
    return [];
  }

  if (isSameRoomPosition(room.controller?.pos, room.name)) {
    return [room.controller.pos];
  }

  return targetPositions.slice(0, 1);
}

function findRoomObjects<T>(room: Room, constantName: FindConstantName): T[] {
  const findConstant = (globalThis as unknown as Partial<Record<FindConstantName, number>>)[constantName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function isRoadWorkTarget(target: RoadWorkTarget): boolean {
  return matchesStructureType(target.structureType, 'STRUCTURE_ROAD', 'road');
}

function isRemoteTerritoryLogisticsRoom(room: Room): boolean {
  return isReferencedRemoteTerritoryRoom(room.name) || (room.controller?.my !== true && isSelfReservedRoom(room));
}

function isReferencedRemoteTerritoryRoom(roomName: string): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  return (
    hasRemoteTerritoryReference(territoryMemory.targets, roomName, 'roomName') ||
    hasRemoteTerritoryReference(territoryMemory.intents, roomName, 'targetRoom') ||
    hasRemoteTerritoryReference(territoryMemory.demands, roomName, 'targetRoom') ||
    hasRemoteTerritoryReference(territoryMemory.executionHints, roomName, 'targetRoom')
  );
}

function hasRemoteTerritoryReference(value: unknown, roomName: string, roomKey: 'roomName' | 'targetRoom'): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }

    return (
      entry[roomKey] === roomName &&
      isNonEmptyString(entry.colony) &&
      entry.colony !== roomName &&
      isTerritoryControlAction(entry.action) &&
      entry.status !== 'suppressed' &&
      entry.enabled !== false
    );
  });
}

function isSelfReservedRoom(room: Room): boolean {
  const reservationUsername = (room.controller as (StructureController & { reservation?: { username?: string } }) | undefined)
    ?.reservation?.username;
  return isNonEmptyString(reservationUsername) && getOwnedUsernames().has(reservationUsername);
}

function getTerritoryMemoryRecord(): Record<string, unknown> | null {
  const memory = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory;
  return memory && isRecord(memory.territory) ? memory.territory : null;
}

function getOwnedUsernames(): Set<string> {
  const usernames = new Set<string>();
  const game = (globalThis as {
    Game?: {
      creeps?: Record<string, { owner?: { username?: string } }>;
      rooms?: Record<string, { controller?: { my?: boolean; owner?: { username?: string } } }>;
      spawns?: Record<string, { owner?: { username?: string } }>;
    };
  }).Game;

  for (const spawn of Object.values(game?.spawns ?? {})) {
    addOwnedUsername(usernames, spawn);
  }

  for (const creep of Object.values(game?.creeps ?? {})) {
    addOwnedUsername(usernames, creep);
  }

  for (const visibleRoom of Object.values(game?.rooms ?? {})) {
    if (visibleRoom.controller?.my === true) {
      addOwnedUsername(usernames, visibleRoom.controller);
    }
  }

  return usernames;
}

function addOwnedUsername(usernames: Set<string>, object: { owner?: { username?: string } } | undefined): void {
  const username = object?.owner?.username;
  if (isNonEmptyString(username)) {
    usernames.add(username);
  }
}

function isTerritoryControlAction(action: unknown): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
}

function isNearLogisticsRoute(position: RoomPosition, anchor: RoomPosition, destination: RoomPosition): boolean {
  if (!isSameRoomPosition(position, anchor.roomName) || !isSameRoomPosition(position, destination.roomName)) {
    return false;
  }

  return getSquaredDistanceToSegment(position, anchor, destination) <= CRITICAL_ROAD_ROUTE_RANGE ** 2;
}

function getSquaredDistanceToSegment(position: RoomPosition, start: RoomPosition, end: RoomPosition): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;

  if (lengthSquared === 0) {
    return getSquaredDistance(position, start);
  }

  const projection = ((position.x - start.x) * deltaX + (position.y - start.y) * deltaY) / lengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));
  const closestX = start.x + clampedProjection * deltaX;
  const closestY = start.y + clampedProjection * deltaY;
  const distanceX = position.x - closestX;
  const distanceY = position.y - closestY;

  return distanceX * distanceX + distanceY * distanceY;
}

function getSquaredDistance(left: RoomPosition, right: RoomPosition): number {
  const distanceX = left.x - right.x;
  const distanceY = left.y - right.y;
  return distanceX * distanceX + distanceY * distanceY;
}

function isSameRoomPosition(position: RoomPosition | undefined, roomName: string | undefined): position is RoomPosition {
  return !!position && (!position.roomName || !roomName || position.roomName === roomName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function matchesStructureType(
  actual: string | undefined,
  globalName: StructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

type FindConstantName = 'FIND_MY_STRUCTURES' | 'FIND_SOURCES';
