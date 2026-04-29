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
  return {
    anchorPositions: findOwnedSpawnPositions(room),
    targetPositions: findLogisticsTargetPositions(room)
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

function matchesStructureType(
  actual: string | undefined,
  globalName: StructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

type FindConstantName = 'FIND_MY_STRUCTURES' | 'FIND_SOURCES';
