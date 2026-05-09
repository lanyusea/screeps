import {
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isContainerStructure,
  isSameRoomPosition
} from './sourceContainers';

type StagingContainerStructureGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_SPAWN';

export type EnergyStagingContainerRole = 'spawn' | 'controller';

export const SPAWN_STAGING_CONTAINER_RANGE = 1;
export const CONTROLLER_STAGING_CONTAINER_RANGE = 1;

export function getEnergyStagingContainerRole(
  room: Room,
  structure: AnyStructure
): EnergyStagingContainerRole | null {
  if (!isContainerStructure(structure)) {
    return null;
  }

  const position = getRoomObjectPosition(structure);
  if (!position || !isSameRoomPosition(position, room.name)) {
    return null;
  }

  if (hasNearbySpawnOrExtension(room, position)) {
    return 'spawn';
  }

  const controllerPosition = room.controller ? getRoomObjectPosition(room.controller) : null;
  if (
    controllerPosition &&
    isSameRoomPosition(controllerPosition, room.name) &&
    getRangeBetweenPositions(position, controllerPosition) <= CONTROLLER_STAGING_CONTAINER_RANGE
  ) {
    return 'controller';
  }

  return null;
}

export function isSpawnStagingContainer(room: Room, structure: AnyStructure): structure is StructureContainer {
  return getEnergyStagingContainerRole(room, structure) === 'spawn';
}

export function isControllerStagingContainer(room: Room, structure: AnyStructure): structure is StructureContainer {
  return getEnergyStagingContainerRole(room, structure) === 'controller';
}

function hasNearbySpawnOrExtension(room: Room, position: RoomPosition): boolean {
  return getUniqueRoomStructures(room).some((structure) => {
    if (!isSpawnOrExtensionStructure(structure)) {
      return false;
    }

    const structurePosition = getRoomObjectPosition(structure);
    return (
      structurePosition !== null &&
      isSameRoomPosition(structurePosition, room.name) &&
      getRangeBetweenPositions(position, structurePosition) <= SPAWN_STAGING_CONTAINER_RANGE
    );
  });
}

function getUniqueRoomStructures(room: Room): AnyStructure[] {
  const structures = [
    ...findRoomStructures(room, 'FIND_MY_STRUCTURES'),
    ...findRoomStructures(room, 'FIND_STRUCTURES')
  ];
  const seen = new Set<string>();
  const uniqueStructures: AnyStructure[] = [];

  for (const structure of structures) {
    const key = getStructureStableKey(structure, uniqueStructures.length);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueStructures.push(structure);
  }

  return uniqueStructures;
}

function findRoomStructures(room: Room, globalName: string): AnyStructure[] {
  const findConstant = (globalThis as Record<string, unknown>)[globalName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const found = (room.find as unknown as (type: number) => unknown[])(findConstant);
    return Array.isArray(found) ? (found as AnyStructure[]) : [];
  } catch {
    return [];
  }
}

function getStructureStableKey(structure: AnyStructure, index: number): string {
  const id = (structure as { id?: unknown }).id;
  if (typeof id === 'string' && id.length > 0) {
    return id;
  }

  const position = getRoomObjectPosition(structure);
  return position ? `${structure.structureType}:${position.roomName}:${position.x},${position.y}` : `${index}`;
}

function isSpawnOrExtensionStructure(structure: AnyStructure): boolean {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')
  );
}

function matchesStructureType(
  actual: string | undefined,
  globalName: StagingContainerStructureGlobal,
  fallback: string
): boolean {
  return actual === ((globalThis as Partial<Record<StagingContainerStructureGlobal, string>>)[globalName] ?? fallback);
}
