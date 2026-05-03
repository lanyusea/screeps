type SourceContainerStructureConstantGlobal = 'STRUCTURE_CONTAINER';

interface Positioned {
  x: number;
  y: number;
  roomName?: string;
}

export function findSourceContainer(room: Room, source: Source): StructureContainer | null {
  if (typeof FIND_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition || !isSameRoomPosition(sourcePosition, room.name)) {
    return null;
  }

  const containers = room
    .find(FIND_STRUCTURES)
    .filter((structure): structure is StructureContainer => isContainerStructure(structure))
    .filter((container) => {
      const containerPosition = getRoomObjectPosition(container);
      return (
        containerPosition !== null &&
        isSameRoomPosition(containerPosition, room.name) &&
        getRangeBetweenPositions(sourcePosition, containerPosition) <= 1
      );
    });

  return containers.sort((left, right) => compareSourceContainers(sourcePosition, left, right))[0] ?? null;
}

export function findSourceContainerConstructionSite(room: Room, source: Source): ConstructionSite | null {
  if (typeof FIND_CONSTRUCTION_SITES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition || !isSameRoomPosition(sourcePosition, room.name)) {
    return null;
  }

  const sites = room
    .find(FIND_CONSTRUCTION_SITES)
    .filter((site): site is ConstructionSite => isContainerConstructionSite(site))
    .filter((site) => {
      const sitePosition = getRoomObjectPosition(site);
      return (
        sitePosition !== null &&
        isSameRoomPosition(sitePosition, room.name) &&
        getRangeBetweenPositions(sourcePosition, sitePosition) <= 1
      );
    });

  return sites.sort((left, right) => compareSourceContainerSites(sourcePosition, left, right))[0] ?? null;
}

export function isContainerStructure(structure: AnyStructure): structure is StructureContainer {
  return matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container');
}

export function getRangeBetweenPositions(left: Positioned, right: Positioned): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

export function getRoomObjectPosition(object: RoomObject): RoomPosition | null {
  const position = (object as RoomObject & { pos?: RoomPosition }).pos;
  return isRoomPosition(position) ? position : null;
}

export function isSameRoomPosition(position: Positioned, roomName: string): boolean {
  return typeof position.roomName !== 'string' || position.roomName === roomName;
}

export function getPositionKey(position: Positioned): string {
  return `${position.x},${position.y}`;
}

function compareSourceContainers(sourcePosition: RoomPosition, left: StructureContainer, right: StructureContainer): number {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);

  return (
    compareNumbers(
      leftPosition ? getRangeBetweenPositions(sourcePosition, leftPosition) : Number.POSITIVE_INFINITY,
      rightPosition ? getRangeBetweenPositions(sourcePosition, rightPosition) : Number.POSITIVE_INFINITY
    ) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareSourceContainerSites(
  sourcePosition: RoomPosition,
  left: ConstructionSite,
  right: ConstructionSite
): number {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);

  return (
    compareNumbers(
      leftPosition ? getRangeBetweenPositions(sourcePosition, leftPosition) : Number.POSITIVE_INFINITY,
      rightPosition ? getRangeBetweenPositions(sourcePosition, rightPosition) : Number.POSITIVE_INFINITY
    ) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function isRoomPosition(value: unknown): value is RoomPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Positioned).x === 'number' &&
    typeof (value as Positioned).y === 'number' &&
    Number.isFinite((value as Positioned).x) &&
    Number.isFinite((value as Positioned).y)
  );
}

function matchesStructureType(
  actual: string | undefined,
  globalName: SourceContainerStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<SourceContainerStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function isContainerConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_CONTAINER', 'container');
}
