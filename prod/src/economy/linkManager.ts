import {
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from './sourceContainers';

type LinkStructureConstantGlobal = 'STRUCTURE_LINK' | 'STRUCTURE_STORAGE';

export const SOURCE_LINK_RANGE = 2;
export const CONTROLLER_LINK_RANGE = 3;
export const STORAGE_LINK_RANGE = 2;
export const STORAGE_LINK_ROUTING_TARGET_RATIO = 0.3;
const OK_CODE = 0 as ScreepsReturnCode;

export type LinkDestinationRole = 'controller' | 'storage';

export interface LinkNetwork {
  links: StructureLink[];
  sourceLinks: StructureLink[];
  controllerLink: StructureLink | null;
  storageLink: StructureLink | null;
  storage: StructureStorage | null;
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

  const projectedState = createProjectedLinkState(network.links);
  const results: LinkTransferResult[] = [];
  const spentSourceIds = new Set<string>();

  if (shouldControllerLinkReceiveEnergy(room, network.controllerLink, projectedState)) {
    transferSourceLinksToDestination(
      sortSourceLinksByDistanceToDestination(network.sourceLinks, network.controllerLink),
      { link: network.controllerLink, role: 'controller' },
      projectedState,
      spentSourceIds,
      results
    );
  }

  if (shouldStorageLinkReceiveSurplus(network, projectedState)) {
    transferSourceLinksToDestination(
      sortSourceLinksBySurplusPriority(network.sourceLinks, network.storageLink, projectedState),
      { link: network.storageLink, role: 'storage' },
      projectedState,
      spentSourceIds,
      results
    );
  }

  return results;
}

export function classifyLinks(room: Room): LinkNetwork {
  const links = findOwnedLinks(room);
  const controllerLink = selectControllerLink(room, links);
  const storage = room.storage ?? findStorage(room);
  const storageLink = selectStorageLink(room, links, controllerLink, storage);
  const destinationIds = new Set(
    [controllerLink, storageLink]
      .filter((link): link is StructureLink => link !== null)
      .map((link) => getObjectId(link))
  );

  return {
    links,
    sourceLinks: selectSourceLinks(room, links, destinationIds),
    controllerLink,
    storageLink,
    storage
  };
}

export function isSourceLink(room: Room, link: StructureLink): boolean {
  const linkId = getObjectId(link);
  return linkId !== '' && classifyLinks(room).sourceLinks.some((sourceLink) => getObjectId(sourceLink) === linkId);
}

export function getSourceLinkWorkerEnergyAvailable(room: Room, link: StructureLink, network?: LinkNetwork): number {
  const linkId = getObjectId(link);
  const linkNetwork = network ?? classifyLinks(room);
  const sourceLink = linkNetwork.sourceLinks.find((candidate) => getObjectId(candidate) === linkId);
  if (!sourceLink) {
    return getStoredEnergy(link);
  }

  const projectedState = createProjectedLinkState(linkNetwork.links);
  const routingReserve = createSourceLinkRoutingReserve(room, linkNetwork, projectedState).get(linkId) ?? 0;
  return Math.max(0, getStoredEnergy(sourceLink) - routingReserve);
}

function transferLinkEnergy(sourceLink: StructureLink, destinationLink: StructureLink, amount: number): ScreepsReturnCode {
  return sourceLink.transferEnergy(destinationLink, amount);
}

function transferSourceLinksToDestination(
  sourceLinks: StructureLink[],
  destination: { link: StructureLink; role: LinkDestinationRole },
  projectedState: ProjectedLinkState,
  spentSourceIds: Set<string>,
  results: LinkTransferResult[]
): void {
  const destinationId = getObjectId(destination.link);

  for (const sourceLink of sourceLinks) {
    const sourceId = getObjectId(sourceLink);
    if (spentSourceIds.has(sourceId) || !canLinkSendEnergy(sourceLink, projectedState)) {
      continue;
    }

    if (destinationId === sourceId || (projectedState.freeCapacityById.get(destinationId) ?? 0) <= 0) {
      continue;
    }

    const amount = Math.min(
      projectedState.storedEnergyById.get(sourceId) ?? 0,
      projectedState.freeCapacityById.get(destinationId) ?? 0
    );
    if (amount <= 0) {
      continue;
    }

    const result = transferLinkEnergy(sourceLink, destination.link, amount);
    results.push({
      amount,
      destinationId,
      destinationRole: destination.role,
      result,
      sourceId
    });

    spentSourceIds.add(sourceId);
    if (result === OK_CODE) {
      projectedState.storedEnergyById.set(
        sourceId,
        Math.max(0, (projectedState.storedEnergyById.get(sourceId) ?? 0) - amount)
      );
      projectedState.freeCapacityById.set(
        destinationId,
        Math.max(0, (projectedState.freeCapacityById.get(destinationId) ?? 0) - amount)
      );
    }
  }
}

function shouldControllerLinkReceiveEnergy(
  room: Room,
  controllerLink: StructureLink | null,
  projectedState: ProjectedLinkState
): controllerLink is StructureLink {
  if (!controllerLink || room.controller?.my !== true) {
    return false;
  }

  return (projectedState.freeCapacityById.get(getObjectId(controllerLink)) ?? 0) > 0;
}

function shouldStorageLinkReceiveSurplus(
  network: LinkNetwork,
  projectedState: ProjectedLinkState
): network is LinkNetwork & { storageLink: StructureLink } {
  if (!network.storageLink || getObjectId(network.storageLink) === getObjectId(network.controllerLink)) {
    return false;
  }

  return (
    (projectedState.freeCapacityById.get(getObjectId(network.storageLink)) ?? 0) > 0 &&
    shouldStorageReceiveLinkEnergy(network.storage)
  );
}

function shouldStorageReceiveLinkEnergy(storage: StructureStorage | null): boolean {
  if (!storage) {
    return false;
  }

  const freeCapacity = getKnownFreeEnergyCapacity(storage);
  if (freeCapacity !== null && freeCapacity <= 0) {
    return false;
  }

  const capacity = getKnownEnergyCapacity(storage);
  const storedEnergy = getKnownStoredEnergy(storage);
  if (capacity !== null && storedEnergy !== null && capacity > 0) {
    return storedEnergy < Math.ceil(capacity * STORAGE_LINK_ROUTING_TARGET_RATIO);
  }

  return true;
}

function createSourceLinkRoutingReserve(
  room: Room,
  network: LinkNetwork,
  projectedState: ProjectedLinkState
): Map<string, number> {
  const reserveById = new Map<string, number>();
  const spentSourceIds = new Set<string>();

  if (shouldControllerLinkReceiveEnergy(room, network.controllerLink, projectedState)) {
    reserveSourceLinksForDestination(
      sortSourceLinksByDistanceToDestination(network.sourceLinks, network.controllerLink),
      network.controllerLink,
      projectedState,
      spentSourceIds,
      reserveById
    );
  }

  if (shouldStorageLinkReceiveSurplus(network, projectedState)) {
    reserveSourceLinksForDestination(
      sortSourceLinksBySurplusPriority(network.sourceLinks, network.storageLink, projectedState),
      network.storageLink,
      projectedState,
      spentSourceIds,
      reserveById
    );
  }

  return reserveById;
}

function reserveSourceLinksForDestination(
  sourceLinks: StructureLink[],
  destinationLink: StructureLink,
  projectedState: ProjectedLinkState,
  spentSourceIds: Set<string>,
  reserveById: Map<string, number>
): void {
  const destinationId = getObjectId(destinationLink);

  for (const sourceLink of sourceLinks) {
    const sourceId = getObjectId(sourceLink);
    const destinationFreeCapacity = projectedState.freeCapacityById.get(destinationId) ?? 0;
    const sourceEnergy = projectedState.storedEnergyById.get(sourceId) ?? 0;
    if (
      spentSourceIds.has(sourceId) ||
      !canLinkSendEnergy(sourceLink, projectedState) ||
      destinationId === sourceId ||
      destinationFreeCapacity <= 0 ||
      sourceEnergy <= 0
    ) {
      continue;
    }

    const amount = Math.min(sourceEnergy, destinationFreeCapacity);
    if (amount <= 0) {
      continue;
    }

    reserveById.set(sourceId, (reserveById.get(sourceId) ?? 0) + amount);
    spentSourceIds.add(sourceId);
    projectedState.storedEnergyById.set(sourceId, sourceEnergy - amount);
    projectedState.freeCapacityById.set(destinationId, destinationFreeCapacity - amount);
  }
}

function getKnownStoredEnergy(structure: StructureLink | StructureStorage): number | null {
  const storedEnergy = structure.store?.getUsedCapacity?.(getEnergyResource());
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : null;
}

function getKnownFreeEnergyCapacity(structure: StructureLink | StructureStorage): number | null {
  const freeCapacity =
    structure.store?.getFreeCapacity?.(getEnergyResource()) ?? structure.store?.getFreeCapacity?.();
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : null;
}

function getKnownEnergyCapacity(structure: StructureLink | StructureStorage): number | null {
  const capacity =
    structure.store?.getCapacity?.(getEnergyResource()) ?? structure.store?.getCapacity?.();
  return typeof capacity === 'number' && Number.isFinite(capacity) ? Math.max(0, capacity) : null;
}

function sortSourceLinksByDistanceToDestination(
  links: StructureLink[],
  destinationLink: StructureLink
): StructureLink[] {
  const destinationPosition = getRoomObjectPosition(destinationLink);
  return [...links].sort(
    (left, right) =>
      compareRangeToPosition(destinationPosition, left, right) ||
      getObjectId(left).localeCompare(getObjectId(right))
  );
}

function sortSourceLinksBySurplusPriority(
  links: StructureLink[],
  destinationLink: StructureLink,
  projectedState: ProjectedLinkState
): StructureLink[] {
  const destinationPosition = getRoomObjectPosition(destinationLink);
  return [...links].sort(
    (left, right) =>
      compareRangeToPosition(destinationPosition, left, right) ||
      (projectedState.storedEnergyById.get(getObjectId(right)) ?? 0) -
        (projectedState.storedEnergyById.get(getObjectId(left)) ?? 0) ||
      getObjectId(left).localeCompare(getObjectId(right))
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
  controllerLink: StructureLink | null,
  storage: StructureStorage | null
): StructureLink | null {
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

function compareRangeToPosition(position: RoomPosition | null, left: RoomObject, right: RoomObject): number {
  if (!position) {
    return 0;
  }

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
  return getKnownStoredEnergy(structure) ?? 0;
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
