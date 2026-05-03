import {
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from './sourceContainers';

type LinkStructureConstantGlobal = 'STRUCTURE_LINK' | 'STRUCTURE_STORAGE';

export const SOURCE_LINK_RANGE = 2;
export const CONTROLLER_LINK_RANGE = 3;
export const STORAGE_LINK_RANGE = 2;
const OK_CODE = 0 as ScreepsReturnCode;

export type LinkDestinationRole = 'controller' | 'storage';

export interface LinkNetwork {
  links: StructureLink[];
  sourceLinks: StructureLink[];
  controllerLink: StructureLink | null;
  storageLink: StructureLink | null;
}

export interface LinkTransferResult {
  amount: number;
  destinationId: string;
  destinationRole: LinkDestinationRole;
  result: ScreepsReturnCode;
  sourceId: string;
}

interface ProjectedLinkState {
  freeCapacityById: Map<string, number>;
  storedEnergyById: Map<string, number>;
}

export function transferEnergy(room: Room): LinkTransferResult[] {
  const network = classifyLinks(room);
  if (network.sourceLinks.length === 0) {
    return [];
  }

  const destinationLinks = getDestinationLinks(network);
  if (destinationLinks.length === 0) {
    return [];
  }

  const projectedState = createProjectedLinkState(network.links);
  const results: LinkTransferResult[] = [];

  for (const sourceLink of sortLinksByEnergy(network.sourceLinks, projectedState)) {
    if (!canLinkSendEnergy(sourceLink, projectedState)) {
      continue;
    }

    const destination = selectDestinationLink(sourceLink, destinationLinks, projectedState);
    if (!destination) {
      continue;
    }

    const sourceId = getObjectId(sourceLink);
    const destinationId = getObjectId(destination.link);
    const amount = Math.min(
      projectedState.storedEnergyById.get(sourceId) ?? 0,
      projectedState.freeCapacityById.get(destinationId) ?? 0
    );
    if (amount <= 0) {
      continue;
    }

    const result = sourceLink.transferEnergy(destination.link, amount);
    results.push({
      amount,
      destinationId,
      destinationRole: destination.role,
      result,
      sourceId
    });

    if (result === OK_CODE) {
      projectedState.storedEnergyById.set(sourceId, Math.max(0, (projectedState.storedEnergyById.get(sourceId) ?? 0) - amount));
      projectedState.freeCapacityById.set(
        destinationId,
        Math.max(0, (projectedState.freeCapacityById.get(destinationId) ?? 0) - amount)
      );
    }
  }

  return results;
}

export function classifyLinks(room: Room): LinkNetwork {
  const links = findOwnedLinks(room);
  const controllerLink = selectControllerLink(room, links);
  const storageLink = selectStorageLink(room, links, controllerLink);
  const destinationIds = new Set(
    [controllerLink, storageLink]
      .filter((link): link is StructureLink => link !== null)
      .map((link) => getObjectId(link))
  );

  return {
    links,
    sourceLinks: selectSourceLinks(room, links, destinationIds),
    controllerLink,
    storageLink
  };
}

function getDestinationLinks(
  network: LinkNetwork
): Array<{ link: StructureLink; role: LinkDestinationRole }> {
  const destinations: Array<{ link: StructureLink; role: LinkDestinationRole }> = [];
  if (network.controllerLink) {
    destinations.push({ link: network.controllerLink, role: 'controller' });
  }
  if (network.storageLink && getObjectId(network.storageLink) !== getObjectId(network.controllerLink)) {
    destinations.push({ link: network.storageLink, role: 'storage' });
  }

  return destinations;
}

function selectDestinationLink(
  sourceLink: StructureLink,
  destinationLinks: Array<{ link: StructureLink; role: LinkDestinationRole }>,
  projectedState: ProjectedLinkState
): { link: StructureLink; role: LinkDestinationRole } | null {
  const sourceId = getObjectId(sourceLink);
  return (
    destinationLinks.find((destination) => {
      const destinationId = getObjectId(destination.link);
      return destinationId !== sourceId && (projectedState.freeCapacityById.get(destinationId) ?? 0) > 0;
    }) ?? null
  );
}

function canLinkSendEnergy(link: StructureLink, projectedState: ProjectedLinkState): boolean {
  return getLinkCooldown(link) <= 0 && (projectedState.storedEnergyById.get(getObjectId(link)) ?? 0) > 0;
}

function createProjectedLinkState(links: StructureLink[]): ProjectedLinkState {
  return {
    freeCapacityById: new Map(links.map((link) => [getObjectId(link), getFreeEnergyCapacity(link)])),
    storedEnergyById: new Map(links.map((link) => [getObjectId(link), getStoredEnergy(link)]))
  };
}

function sortLinksByEnergy(links: StructureLink[], projectedState: ProjectedLinkState): StructureLink[] {
  return [...links].sort(
    (left, right) =>
      (projectedState.storedEnergyById.get(getObjectId(right)) ?? 0) -
        (projectedState.storedEnergyById.get(getObjectId(left)) ?? 0) ||
      getObjectId(left).localeCompare(getObjectId(right))
  );
}

function selectSourceLinks(room: Room, links: StructureLink[], destinationIds: Set<string>): StructureLink[] {
  const sources = findSources(room);
  if (sources.length === 0) {
    return [];
  }

  return links
    .filter((link) => !destinationIds.has(getObjectId(link)))
    .filter((link) => sources.some((source) => isNearRoomObject(link, source, room.name, SOURCE_LINK_RANGE)))
    .sort(compareObjectIds);
}

function selectControllerLink(room: Room, links: StructureLink[]): StructureLink | null {
  const controller = room.controller;
  if (!controller) {
    return null;
  }

  return selectClosestLink(links, controller, room.name, CONTROLLER_LINK_RANGE);
}

function selectStorageLink(
  room: Room,
  links: StructureLink[],
  controllerLink: StructureLink | null
): StructureLink | null {
  const storage = room.storage ?? findStorage(room);
  if (!storage) {
    return null;
  }

  return selectClosestLink(
    links.filter((link) => getObjectId(link) !== getObjectId(controllerLink)),
    storage,
    room.name,
    STORAGE_LINK_RANGE
  );
}

function selectClosestLink(
  links: StructureLink[],
  target: RoomObject,
  roomName: string,
  range: number
): StructureLink | null {
  const targetPosition = getRoomObjectPosition(target);
  if (!targetPosition || !isSameRoomPosition(targetPosition, roomName)) {
    return null;
  }

  return (
    links
      .filter((link) => isNearRoomObject(link, target, roomName, range))
      .sort(
        (left, right) =>
          compareRangeToPosition(targetPosition, left, right) || getObjectId(left).localeCompare(getObjectId(right))
      )[0] ?? null
  );
}

function isNearRoomObject(left: RoomObject, right: RoomObject, roomName: string, range: number): boolean {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  return (
    leftPosition !== null &&
    rightPosition !== null &&
    isSameRoomPosition(leftPosition, roomName) &&
    isSameRoomPosition(rightPosition, roomName) &&
    getRangeBetweenPositions(leftPosition, rightPosition) <= range
  );
}

function compareRangeToPosition(position: RoomPosition, left: RoomObject, right: RoomObject): number {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  return (
    (leftPosition ? getRangeBetweenPositions(position, leftPosition) : Number.POSITIVE_INFINITY) -
    (rightPosition ? getRangeBetweenPositions(position, rightPosition) : Number.POSITIVE_INFINITY)
  );
}

function findOwnedLinks(room: Room): StructureLink[] {
  return findOwnedStructures(room)
    .filter((structure): structure is StructureLink => matchesStructureType(structure.structureType, 'STRUCTURE_LINK', 'link'))
    .sort(compareObjectIds);
}

function findOwnedStructures(room: Room): AnyOwnedStructure[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = room.find(FIND_MY_STRUCTURES);
  return Array.isArray(result) ? result : [];
}

function findStorage(room: Room): StructureStorage | null {
  return (
    findOwnedStructures(room).filter((structure): structure is StructureStorage =>
      matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage')
    )[0] ?? null
  );
}

function findSources(room: Room): Source[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = room.find(FIND_SOURCES);
  return Array.isArray(result) ? result : [];
}

function getStoredEnergy(structure: StructureLink): number {
  const storedEnergy = structure.store?.getUsedCapacity?.(getEnergyResource());
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getFreeEnergyCapacity(structure: StructureLink): number {
  const freeCapacity = structure.store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getLinkCooldown(link: StructureLink): number {
  return typeof link.cooldown === 'number' && Number.isFinite(link.cooldown) ? link.cooldown : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function compareObjectIds(left: unknown, right: unknown): number {
  return getObjectId(left).localeCompare(getObjectId(right));
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function matchesStructureType(
  actual: string | undefined,
  globalName: LinkStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<LinkStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}
