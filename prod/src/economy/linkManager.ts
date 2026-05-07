import {
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from './sourceContainers';
import { getStorageBalanceState } from './storageBalancer';

type LinkStructureConstantGlobal = 'STRUCTURE_LINK' | 'STRUCTURE_SPAWN' | 'STRUCTURE_STORAGE';

export const SOURCE_LINK_RANGE = 2;
export const CONTROLLER_LINK_RANGE = 3;
export const SPAWN_LINK_RANGE = 2;
export const STORAGE_LINK_RANGE = 2;
export const STORAGE_LINK_ROUTING_TARGET_RATIO = 0.3;
const OK_CODE = 0 as ScreepsReturnCode;

export type LinkDestinationRole = 'controller' | 'spawn' | 'storage';

export interface LinkNetwork {
  links: StructureLink[];
  sourceLinks: StructureLink[];
  controllerLink: StructureLink | null;
  spawnLink: StructureLink | null;
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

export interface InterRoomLinkTransferResult extends LinkTransferResult {
  plannedAmount: number;
  sourceRoom: string;
  targetRoom: string;
}

interface LinkDestination {
  link: StructureLink;
  priority: number;
  role: LinkDestinationRole;
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

  if (shouldSpawnLinkReceiveEnergy(room, network.spawnLink, projectedState)) {
    transferSourceLinksToDestination(
      sortSourceLinksByDistanceToDestination(network.sourceLinks, network.spawnLink),
      { link: network.spawnLink, role: 'spawn' },
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

export function transferInterRoomEnergy(rooms: Room[] = findVisibleOwnedRooms()): InterRoomLinkTransferResult[] {
  const ownedRoomsByName = new Map(
    rooms
      .filter((room) => room.controller?.my === true)
      .map((room) => [room.name, room] as const)
  );
  if (ownedRoomsByName.size < 2) {
    return [];
  }

  const storageBalance = getStorageBalanceState();
  const transferPlans = selectInterRoomLinkTransferPlans(storageBalance);
  if (transferPlans.length === 0) {
    return [];
  }

  const networksByRoom = new Map(
    [...ownedRoomsByName].map(([roomName, room]) => [roomName, classifyLinks(room)] as const)
  );
  const projectedState = createProjectedLinkState(
    [...networksByRoom.values()].flatMap((network) => network.links)
  );
  const remainingExportByRoom = createRemainingInterRoomExportByRoom(storageBalance);
  const remainingImportByRoom = createRemainingInterRoomImportByRoom(storageBalance);
  const spentSourceIds = new Set<string>();
  const results: InterRoomLinkTransferResult[] = [];

  for (const transfer of transferPlans) {
    const sourceRoom = ownedRoomsByName.get(transfer.sourceRoom);
    const targetRoom = ownedRoomsByName.get(transfer.targetRoom);
    const sourceNetwork = networksByRoom.get(transfer.sourceRoom);
    const targetNetwork = networksByRoom.get(transfer.targetRoom);
    if (!sourceRoom || !targetRoom || !sourceNetwork || !targetNetwork) {
      continue;
    }

    transferInterRoomEnergyForPlan(
      transfer,
      targetRoom,
      sourceNetwork,
      targetNetwork,
      projectedState,
      spentSourceIds,
      remainingExportByRoom,
      remainingImportByRoom,
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
  const spawnLink = selectSpawnLink(room, links, controllerLink, storageLink);
  const destinationIds = new Set(
    [controllerLink, spawnLink, storageLink]
      .filter((link): link is StructureLink => link !== null)
      .map((link) => getObjectId(link))
  );

  return {
    links,
    sourceLinks: selectSourceLinks(room, links, destinationIds),
    controllerLink,
    spawnLink,
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

function transferInterRoomEnergyForPlan(
  transfer: EconomyStorageTransferMemory,
  targetRoom: Room,
  sourceNetwork: LinkNetwork,
  targetNetwork: LinkNetwork,
  projectedState: ProjectedLinkState,
  spentSourceIds: Set<string>,
  remainingExportByRoom: Map<string, number>,
  remainingImportByRoom: Map<string, number>,
  results: InterRoomLinkTransferResult[]
): void {
  let remainingTransfer = Math.min(
    transfer.amount,
    remainingExportByRoom.get(transfer.sourceRoom) ?? transfer.amount,
    remainingImportByRoom.get(transfer.targetRoom) ?? transfer.amount
  );
  if (remainingTransfer <= 0) {
    return;
  }

  for (const destination of selectInterRoomDestinationLinks(targetRoom, targetNetwork, projectedState)) {
    let destinationFreeCapacity = projectedState.freeCapacityById.get(getObjectId(destination.link)) ?? 0;
    while (remainingTransfer > 0 && destinationFreeCapacity > 0) {
      const sourceLink = selectInterRoomSourceLink(sourceNetwork, projectedState, spentSourceIds);
      if (!sourceLink) {
        return;
      }

      const sourceId = getObjectId(sourceLink);
      const destinationId = getObjectId(destination.link);
      if (sourceId === destinationId) {
        spentSourceIds.add(sourceId);
        continue;
      }

      if (sourceLink.room.name !== destination.link.room.name) {
        spentSourceIds.add(sourceId);
        continue;
      }

      const amount = Math.min(
        remainingTransfer,
        projectedState.storedEnergyById.get(sourceId) ?? 0,
        destinationFreeCapacity
      );
      if (amount <= 0) {
        spentSourceIds.add(sourceId);
        continue;
      }

      const result = transferLinkEnergy(sourceLink, destination.link, amount);
      results.push({
        amount,
        destinationId,
        destinationRole: destination.role,
        plannedAmount: transfer.amount,
        result,
        sourceId,
        sourceRoom: transfer.sourceRoom,
        targetRoom: transfer.targetRoom
      });

      spentSourceIds.add(sourceId);
      if (result !== OK_CODE) {
        continue;
      }

      projectedState.storedEnergyById.set(
        sourceId,
        Math.max(0, (projectedState.storedEnergyById.get(sourceId) ?? 0) - amount)
      );
      projectedState.freeCapacityById.set(destinationId, Math.max(0, destinationFreeCapacity - amount));
      destinationFreeCapacity = projectedState.freeCapacityById.get(destinationId) ?? 0;
      remainingTransfer -= amount;
      remainingExportByRoom.set(
        transfer.sourceRoom,
        Math.max(0, (remainingExportByRoom.get(transfer.sourceRoom) ?? 0) - amount)
      );
      remainingImportByRoom.set(
        transfer.targetRoom,
        Math.max(0, (remainingImportByRoom.get(transfer.targetRoom) ?? 0) - amount)
      );
    }
  }
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

function shouldSpawnLinkReceiveEnergy(
  room: Room,
  spawnLink: StructureLink | null,
  projectedState: ProjectedLinkState
): spawnLink is StructureLink {
  if (!spawnLink) {
    return false;
  }

  if ((projectedState.freeCapacityById.get(getObjectId(spawnLink)) ?? 0) <= 0) {
    return false;
  }

  const energyAvailable = getKnownRoomEnergyAvailable(room);
  const energyCapacityAvailable = getKnownRoomEnergyCapacityAvailable(room);
  return (
    energyAvailable === null ||
    energyCapacityAvailable === null ||
    energyCapacityAvailable <= 0 ||
    energyAvailable < energyCapacityAvailable
  );
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

  if (shouldSpawnLinkReceiveEnergy(room, network.spawnLink, projectedState)) {
    reserveSourceLinksForDestination(
      sortSourceLinksByDistanceToDestination(network.sourceLinks, network.spawnLink),
      network.spawnLink,
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

function selectInterRoomLinkTransferPlans(
  storageBalance: EconomyStorageBalanceMemory
): EconomyStorageTransferMemory[] {
  return [...storageBalance.transfers]
    .filter((transfer) => transfer.amount > 0 && transfer.sourceRoom !== transfer.targetRoom)
    .filter((transfer) => isInterRoomLinkTransferPlanLive(storageBalance, transfer))
    .sort((left, right) => compareInterRoomLinkTransferPlans(storageBalance, left, right));
}

function isInterRoomLinkTransferPlanLive(
  storageBalance: EconomyStorageBalanceMemory,
  transfer: EconomyStorageTransferMemory
): boolean {
  const sourceState = storageBalance.rooms[transfer.sourceRoom];
  const targetState = storageBalance.rooms[transfer.targetRoom];
  if (sourceState && (sourceState.mode !== 'export' || sourceState.exportableEnergy <= 0)) {
    return false;
  }

  if (targetState && (targetState.mode !== 'import' || targetState.importDemand <= 0)) {
    return false;
  }

  return true;
}

function compareInterRoomLinkTransferPlans(
  storageBalance: EconomyStorageBalanceMemory,
  left: EconomyStorageTransferMemory,
  right: EconomyStorageTransferMemory
): number {
  return (
    getInterRoomImportDemand(storageBalance, right.targetRoom) -
      getInterRoomImportDemand(storageBalance, left.targetRoom) ||
    getInterRoomExportableEnergy(storageBalance, right.sourceRoom) -
      getInterRoomExportableEnergy(storageBalance, left.sourceRoom) ||
    right.amount - left.amount ||
    left.sourceRoom.localeCompare(right.sourceRoom) ||
    left.targetRoom.localeCompare(right.targetRoom)
  );
}

function createRemainingInterRoomExportByRoom(
  storageBalance: EconomyStorageBalanceMemory
): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const [roomName, roomState] of Object.entries(storageBalance.rooms)) {
    remaining.set(roomName, Math.max(0, roomState.exportableEnergy));
  }

  for (const transfer of storageBalance.transfers) {
    if (!remaining.has(transfer.sourceRoom)) {
      remaining.set(transfer.sourceRoom, Math.max(0, transfer.amount));
    }
  }

  return remaining;
}

function createRemainingInterRoomImportByRoom(
  storageBalance: EconomyStorageBalanceMemory
): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const [roomName, roomState] of Object.entries(storageBalance.rooms)) {
    remaining.set(roomName, Math.max(0, roomState.importDemand));
  }

  for (const transfer of storageBalance.transfers) {
    if (!remaining.has(transfer.targetRoom)) {
      remaining.set(transfer.targetRoom, Math.max(0, transfer.amount));
    }
  }

  return remaining;
}

function getInterRoomImportDemand(storageBalance: EconomyStorageBalanceMemory, roomName: string): number {
  return Math.max(0, storageBalance.rooms[roomName]?.importDemand ?? 0);
}

function getInterRoomExportableEnergy(storageBalance: EconomyStorageBalanceMemory, roomName: string): number {
  return Math.max(0, storageBalance.rooms[roomName]?.exportableEnergy ?? 0);
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

function selectInterRoomSourceLink(
  network: LinkNetwork,
  projectedState: ProjectedLinkState,
  spentSourceIds: Set<string>
): StructureLink | null {
  const sourceLinksById = new Map<string, StructureLink>();
  for (const link of [network.storageLink, ...network.sourceLinks]) {
    if (!link) {
      continue;
    }

    const linkId = getObjectId(link);
    if (linkId.length > 0) {
      sourceLinksById.set(linkId, link);
    }
  }

  return (
    [...sourceLinksById.values()]
      .filter((link) => !spentSourceIds.has(getObjectId(link)))
      .filter((link) => canLinkSendEnergy(link, projectedState))
      .sort(
        (left, right) =>
          getInterRoomSourcePriority(right, network) - getInterRoomSourcePriority(left, network) ||
          (projectedState.storedEnergyById.get(getObjectId(right)) ?? 0) -
            (projectedState.storedEnergyById.get(getObjectId(left)) ?? 0) ||
          getObjectId(left).localeCompare(getObjectId(right))
      )[0] ?? null
  );
}

function getInterRoomSourcePriority(link: StructureLink, network: LinkNetwork): number {
  if (getObjectId(link) === getObjectId(network.storageLink)) {
    return 2;
  }

  return network.sourceLinks.some((sourceLink) => getObjectId(sourceLink) === getObjectId(link)) ? 1 : 0;
}

function selectInterRoomDestinationLinks(
  room: Room,
  network: LinkNetwork,
  projectedState: ProjectedLinkState
): LinkDestination[] {
  const destinationsById = new Map<string, LinkDestination>();
  addInterRoomDestination(
    destinationsById,
    shouldSpawnLinkReceiveEnergy(room, network.spawnLink, projectedState)
      ? { link: network.spawnLink, priority: 3, role: 'spawn' }
      : null,
    projectedState
  );
  addInterRoomDestination(
    destinationsById,
    shouldControllerLinkReceiveEnergy(room, network.controllerLink, projectedState)
      ? { link: network.controllerLink, priority: 2, role: 'controller' }
      : null,
    projectedState
  );
  addInterRoomDestination(
    destinationsById,
    shouldStorageLinkReceiveInterRoomEnergy(network.storageLink, projectedState)
      ? { link: network.storageLink, priority: 1, role: 'storage' }
      : null,
    projectedState
  );

  return [...destinationsById.values()].sort(
    (left, right) =>
      right.priority - left.priority ||
      (projectedState.freeCapacityById.get(getObjectId(right.link)) ?? 0) -
        (projectedState.freeCapacityById.get(getObjectId(left.link)) ?? 0) ||
      getObjectId(left.link).localeCompare(getObjectId(right.link))
  );
}

function addInterRoomDestination(
  destinationsById: Map<string, LinkDestination>,
  destination: LinkDestination | null,
  projectedState: ProjectedLinkState
): void {
  if (!destination) {
    return;
  }

  const destinationId = getObjectId(destination.link);
  if (destinationId.length === 0 || destinationsById.has(destinationId)) {
    return;
  }

  if ((projectedState.freeCapacityById.get(destinationId) ?? 0) <= 0) {
    return;
  }

  destinationsById.set(destinationId, destination);
}

function shouldStorageLinkReceiveInterRoomEnergy(
  storageLink: StructureLink | null,
  projectedState: ProjectedLinkState
): storageLink is StructureLink {
  return !!storageLink && (projectedState.freeCapacityById.get(getObjectId(storageLink)) ?? 0) > 0;
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

function selectSpawnLink(
  room: Room,
  links: StructureLink[],
  controllerLink: StructureLink | null,
  storageLink: StructureLink | null
): StructureLink | null {
  const excludedIds = new Set(
    [controllerLink, storageLink].map((link) => getObjectId(link)).filter((id) => id.length > 0)
  );
  const sourceLinkCandidateIds = new Set(selectSourceLinks(room, links, new Set()).map((link) => getObjectId(link)));
  const spawns = findRoomSpawns(room);
  if (spawns.length === 0) {
    return null;
  }

  return (
    spawns
      .flatMap((spawn) => {
        const link = selectClosestLink(
          links.filter((candidate) => {
            const candidateId = getObjectId(candidate);
            return !excludedIds.has(candidateId) && !sourceLinkCandidateIds.has(candidateId);
          }),
          spawn,
          room.name,
          SPAWN_LINK_RANGE
        );
        return link ? [link] : [];
      })
      .sort(
        (left, right) =>
          compareClosestSpawnRange(room, left, right) ||
          getObjectId(left).localeCompare(getObjectId(right))
      )[0] ?? null
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

function findRoomSpawns(room: Room): StructureSpawn[] {
  const ownedStructureSpawns = findOwnedStructures(room).filter((structure): structure is StructureSpawn =>
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn')
  );
  const gameSpawns = (globalThis as { Game?: Partial<Pick<Game, 'spawns'>> }).Game?.spawns;
  const visibleSpawns = gameSpawns
    ? Object.values(gameSpawns).filter((spawn): spawn is StructureSpawn => spawn?.room?.name === room.name)
    : [];
  const spawnsById = new Map<string, StructureSpawn>();
  for (const spawn of [...ownedStructureSpawns, ...visibleSpawns]) {
    const id = getObjectId(spawn);
    if (id.length > 0) {
      spawnsById.set(id, spawn);
    }
  }
  return [...spawnsById.values()].sort(compareObjectIds);
}

function findVisibleOwnedRooms(): Room[] {
  const rooms = (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms;
  if (!rooms) {
    return [];
  }

  return Object.values(rooms)
    .filter((room): room is Room => room?.controller?.my === true)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function findSources(room: Room): Source[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = room.find(FIND_SOURCES);
  return Array.isArray(result) ? result : [];
}

function compareClosestSpawnRange(room: Room, left: StructureLink, right: StructureLink): number {
  const spawns = findRoomSpawns(room);
  if (spawns.length === 0) {
    return 0;
  }

  return (
    Math.min(...spawns.map((spawn) => getRangeBetweenRoomObjects(left, spawn, room.name))) -
    Math.min(...spawns.map((spawn) => getRangeBetweenRoomObjects(right, spawn, room.name)))
  );
}

function getRangeBetweenRoomObjects(left: RoomObject, right: RoomObject, roomName: string): number {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  return leftPosition !== null &&
    rightPosition !== null &&
    isSameRoomPosition(leftPosition, roomName) &&
    isSameRoomPosition(rightPosition, roomName)
    ? getRangeBetweenPositions(leftPosition, rightPosition)
    : Number.POSITIVE_INFINITY;
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

function getKnownRoomEnergyAvailable(room: Room): number | null {
  const energyAvailable = room.energyAvailable;
  return typeof energyAvailable === 'number' && Number.isFinite(energyAvailable) ? Math.max(0, energyAvailable) : null;
}

function getKnownRoomEnergyCapacityAvailable(room: Room): number | null {
  const energyCapacityAvailable = room.energyCapacityAvailable;
  return typeof energyCapacityAvailable === 'number' && Number.isFinite(energyCapacityAvailable)
    ? Math.max(0, energyCapacityAvailable)
    : null;
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

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  return typeof candidate.name === 'string' ? candidate.name : '';
}

function matchesStructureType(
  actual: string | undefined,
  globalName: LinkStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<LinkStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}
