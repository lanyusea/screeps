import {
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from './sourceContainers';
import type {
  RuntimeLinkDistributionPath,
  RuntimeTelemetryEvent
} from '../telemetry/runtimeSummary';

type LinkStructureConstantGlobal =
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_LINK'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TOWER';

export const SOURCE_LINK_RANGE = 2;
export const CONTROLLER_LINK_RANGE = 3;
export const STORAGE_LINK_RANGE = 2;
export const LINK_DISTRIBUTION_IDLE_CHECK_INTERVAL = 5;
const LINK_DISTRIBUTION_ACTIVE_CHECK_INTERVAL = 1;
const TOWER_REFILL_THRESHOLD = 500;
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

export interface LinkDistributionAction {
  action: 'linkTransfer' | 'workerWithdraw' | 'workerTransfer' | 'cooldown';
  amount?: number;
  cooldownTicks?: number;
  destinationId?: string;
  path: RuntimeLinkDistributionPath;
  result?: ScreepsReturnCode;
  sourceId?: string;
  workerName?: string;
}

export interface LinkDistributionResult {
  actions: LinkDistributionAction[];
  assignedTasks: number;
  nextCheckAt?: number;
  transfers: LinkTransferResult[];
}

interface ProjectedLinkState {
  freeCapacityById: Map<string, number>;
  storedEnergyById: Map<string, number>;
}

interface LinkEnergyDemandTarget {
  freeCapacity: number;
  id: string;
  priority: number;
  target: StructureSpawn | StructureExtension | StructureTower | StructureStorage;
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

    const result = transferLinkEnergy(sourceLink, destination.link, amount);
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

export function distributeEnergy(
  room: Room,
  gameTime = getGameTime(),
  telemetryEvents: RuntimeTelemetryEvent[] = []
): LinkDistributionResult {
  const memory = getWritableLinkDistributionMemory(room);
  if (!isLinkDistributionDue(memory, room, gameTime)) {
    return { actions: [], assignedTasks: 0, nextCheckAt: memory.nextCheckAt, transfers: [] };
  }

  memory.lastCheckedAt = gameTime;
  const result: LinkDistributionResult = { actions: [], assignedTasks: 0, transfers: [] };
  const network = classifyLinks(room);
  const projectedState = createProjectedLinkState(network.links);

  if (network.sourceLinks.length === 0) {
    scheduleNextLinkDistributionCheck(memory, gameTime, LINK_DISTRIBUTION_IDLE_CHECK_INTERVAL, result);
    return result;
  }

  const spawnExtensionTargets = findSpawnExtensionDemandTargets(room);
  if (spawnExtensionTargets.length > 0) {
    assignLinkEnergyHauling(
      room,
      network.sourceLinks,
      spawnExtensionTargets,
      projectedState,
      'source->spawnExtension',
      result,
      telemetryEvents
    );
    finishLinkDistributionCheck(memory, gameTime, result);
    return result;
  }

  const towerTargets = findTowerDemandTargets(room);
  if (towerTargets.length > 0) {
    assignLinkEnergyHauling(
      room,
      network.sourceLinks,
      towerTargets,
      projectedState,
      'source->tower',
      result,
      telemetryEvents
    );
    finishLinkDistributionCheck(memory, gameTime, result);
    return result;
  }

  const controllerHandled = distributeSourceLinksToController(
    room,
    network,
    projectedState,
    result,
    telemetryEvents
  );
  if (controllerHandled) {
    finishLinkDistributionCheck(memory, gameTime, result);
    return result;
  }

  const storageTargets = findStorageDemandTargets(room);
  if (
    storageTargets.length > 0 &&
    !distributeSourceLinksToStorageLink(room, network, projectedState, result, telemetryEvents)
  ) {
    assignLinkEnergyHauling(
      room,
      network.sourceLinks,
      storageTargets,
      projectedState,
      'source->storage',
      result,
      telemetryEvents
    );
  }

  finishLinkDistributionCheck(memory, gameTime, result);
  return result;
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

export function isSourceLink(room: Room, link: StructureLink): boolean {
  const linkId = getObjectId(link);
  return linkId !== '' && classifyLinks(room).sourceLinks.some((sourceLink) => getObjectId(sourceLink) === linkId);
}

function distributeSourceLinksToController(
  room: Room,
  network: LinkNetwork,
  projectedState: ProjectedLinkState,
  distributionResult: LinkDistributionResult,
  telemetryEvents: RuntimeTelemetryEvent[]
): boolean {
  if (!network.controllerLink || !canUseControllerLinkForUpgrade(room)) {
    return false;
  }

  const controllerLinkId = getObjectId(network.controllerLink);
  const destinationFreeCapacity = projectedState.freeCapacityById.get(controllerLinkId) ?? 0;
  const controllerLinkEnergy = projectedState.storedEnergyById.get(controllerLinkId) ?? 0;
  let handled = destinationFreeCapacity > 0 || controllerLinkEnergy > 0;

  if (destinationFreeCapacity > 0) {
    const transferResults = transferSourceLinksToDestination(
      network.sourceLinks,
      { link: network.controllerLink, role: 'controller' },
      projectedState
    );
    for (const transferResult of transferResults.results) {
      distributionResult.transfers.push(transferResult);
      recordLinkDistributionAction(
        room.name,
        distributionResult,
        telemetryEvents,
        {
          action: 'linkTransfer',
          amount: transferResult.amount,
          destinationId: transferResult.destinationId,
          path: 'source->controllerLink',
          result: transferResult.result,
          sourceId: transferResult.sourceId
        }
      );
    }

    if (transferResults.cooldownTicks !== null && transferResults.results.length === 0) {
      recordLinkDistributionAction(
        room.name,
        distributionResult,
        telemetryEvents,
        {
          action: 'cooldown',
          cooldownTicks: transferResults.cooldownTicks,
          path: 'source->controllerLink'
        }
      );
      handled = true;
    }
  }

  assignControllerLinkUpgradeWithdrawals(
    room,
    network.controllerLink,
    projectedState,
    distributionResult,
    telemetryEvents
  );
  return handled || distributionResult.assignedTasks > 0;
}

function distributeSourceLinksToStorageLink(
  room: Room,
  network: LinkNetwork,
  projectedState: ProjectedLinkState,
  distributionResult: LinkDistributionResult,
  telemetryEvents: RuntimeTelemetryEvent[]
): boolean {
  if (!network.storageLink) {
    return false;
  }

  const storageLinkId = getObjectId(network.storageLink);
  if ((projectedState.freeCapacityById.get(storageLinkId) ?? 0) <= 0) {
    return false;
  }

  const transferResults = transferSourceLinksToDestination(
    network.sourceLinks,
    { link: network.storageLink, role: 'storage' },
    projectedState
  );
  for (const transferResult of transferResults.results) {
    distributionResult.transfers.push(transferResult);
    recordLinkDistributionAction(room.name, distributionResult, telemetryEvents, {
      action: 'linkTransfer',
      amount: transferResult.amount,
      destinationId: transferResult.destinationId,
      path: 'source->storage',
      result: transferResult.result,
      sourceId: transferResult.sourceId
    });
  }

  if (transferResults.cooldownTicks !== null && transferResults.results.length === 0) {
    recordLinkDistributionAction(room.name, distributionResult, telemetryEvents, {
      action: 'cooldown',
      cooldownTicks: transferResults.cooldownTicks,
      path: 'source->storage'
    });
  }

  return true;
}

function transferSourceLinksToDestination(
  sourceLinks: StructureLink[],
  destination: { link: StructureLink; role: LinkDestinationRole },
  projectedState: ProjectedLinkState
): { cooldownTicks: number | null; results: LinkTransferResult[] } {
  const results: LinkTransferResult[] = [];
  let minCooldownTicks: number | null = null;

  for (const sourceLink of sortLinksByEnergy(sourceLinks, projectedState)) {
    const sourceId = getObjectId(sourceLink);
    const destinationId = getObjectId(destination.link);
    if (sourceId === destinationId || (projectedState.freeCapacityById.get(destinationId) ?? 0) <= 0) {
      continue;
    }

    const sourceEnergy = projectedState.storedEnergyById.get(sourceId) ?? 0;
    if (sourceEnergy <= 0) {
      continue;
    }

    const cooldownTicks = getLinkCooldown(sourceLink);
    if (cooldownTicks > 0) {
      minCooldownTicks = minCooldownTicks === null ? cooldownTicks : Math.min(minCooldownTicks, cooldownTicks);
      continue;
    }

    const amount = Math.min(sourceEnergy, projectedState.freeCapacityById.get(destinationId) ?? 0);
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

    if (result === OK_CODE) {
      projectedState.storedEnergyById.set(sourceId, Math.max(0, sourceEnergy - amount));
      projectedState.freeCapacityById.set(
        destinationId,
        Math.max(0, (projectedState.freeCapacityById.get(destinationId) ?? 0) - amount)
      );
      projectedState.storedEnergyById.set(
        destinationId,
        (projectedState.storedEnergyById.get(destinationId) ?? 0) + amount
      );
    }
  }

  return { cooldownTicks: minCooldownTicks, results };
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

function transferLinkEnergy(sourceLink: StructureLink, destinationLink: StructureLink, amount: number): ScreepsReturnCode {
  return (sourceLink as StructureLink & {
    transfer: (target: StructureLink, amount?: number) => ScreepsReturnCode;
  }).transfer(destinationLink, amount);
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

function assignLinkEnergyHauling(
  room: Room,
  sourceLinks: StructureLink[],
  demandTargets: LinkEnergyDemandTarget[],
  projectedState: ProjectedLinkState,
  path: RuntimeLinkDistributionPath,
  distributionResult: LinkDistributionResult,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  const sourceLinkIds = new Set(sourceLinks.map(getObjectId));
  const targetIds = new Set(demandTargets.map((target) => target.id));
  const remainingDemandById = new Map(demandTargets.map((target) => [target.id, target.freeCapacity]));
  const workers = findLinkDistributionWorkers(room)
    .filter((worker) => isEligibleLinkDistributionWorker(worker, room.name))
    .filter((worker) => isAssignableLinkDistributionWorker(worker, sourceLinkIds, targetIds))
    .sort(compareWorkers);
  reserveExistingLinkHaulingAssignments(workers, sourceLinkIds, remainingDemandById, projectedState);

  for (const worker of workers) {
    const carriedEnergy = getStoredEnergy(worker);
    if (carriedEnergy <= 0 || isExistingDemandTransfer(worker, targetIds)) {
      continue;
    }

    const target = selectLinkDemandTarget(worker, demandTargets, remainingDemandById);
    if (!target) {
      continue;
    }

    const amount = Math.min(carriedEnergy, remainingDemandById.get(target.id) ?? 0);
    if (amount <= 0) {
      continue;
    }

    if (setWorkerTask(worker, { type: 'transfer', targetId: target.target.id as Id<AnyStoreStructure> })) {
      distributionResult.assignedTasks += 1;
    }
    reserveDemandCapacity(remainingDemandById, target.id, amount);
    recordLinkDistributionAction(room.name, distributionResult, telemetryEvents, {
      action: 'workerTransfer',
      amount,
      destinationId: target.id,
      path,
      workerName: getWorkerId(worker)
    });
  }

  for (const worker of workers) {
    if (getStoredEnergy(worker) > 0 || getFreeEnergyCapacity(worker) <= 0 || isExistingSourceWithdraw(worker, sourceLinkIds)) {
      continue;
    }

    const sourceLink = selectLinkEnergySource(worker, sourceLinks, projectedState);
    if (!sourceLink) {
      continue;
    }

    const sourceId = getObjectId(sourceLink);
    const plannedWithdrawal = Math.min(
      getFreeEnergyCapacity(worker),
      projectedState.storedEnergyById.get(sourceId) ?? 0,
      getTotalRemainingDemand(remainingDemandById)
    );
    if (plannedWithdrawal <= 0) {
      continue;
    }

    if (setWorkerTask(worker, { type: 'withdraw', targetId: sourceLink.id as Id<AnyStoreStructure> })) {
      distributionResult.assignedTasks += 1;
    }
    projectedState.storedEnergyById.set(
      sourceId,
      Math.max(0, (projectedState.storedEnergyById.get(sourceId) ?? 0) - plannedWithdrawal)
    );
    reserveAnyDemandCapacity(remainingDemandById, plannedWithdrawal);
    recordLinkDistributionAction(room.name, distributionResult, telemetryEvents, {
      action: 'workerWithdraw',
      amount: plannedWithdrawal,
      path,
      sourceId,
      workerName: getWorkerId(worker)
    });
  }
}

function assignControllerLinkUpgradeWithdrawals(
  room: Room,
  controllerLink: StructureLink,
  projectedState: ProjectedLinkState,
  distributionResult: LinkDistributionResult,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  const controller = room.controller;
  if (!controller) {
    return;
  }

  const controllerLinkId = getObjectId(controllerLink);
  const sourceLinkIds = new Set([controllerLinkId]);
  const workers = findLinkDistributionWorkers(room)
    .filter((worker) => isEligibleLinkDistributionWorker(worker, room.name))
    .filter((worker) => isControllerUpgradeLinkWorker(worker, controller, controllerLinkId))
    .sort(compareWorkers);

  for (const worker of workers) {
    if (getStoredEnergy(worker) > 0 || getFreeEnergyCapacity(worker) <= 0 || isExistingSourceWithdraw(worker, sourceLinkIds)) {
      continue;
    }

    const plannedWithdrawal = Math.min(
      getFreeEnergyCapacity(worker),
      projectedState.storedEnergyById.get(controllerLinkId) ?? 0
    );
    if (plannedWithdrawal <= 0) {
      continue;
    }

    if (setWorkerTask(worker, { type: 'withdraw', targetId: controllerLink.id as Id<AnyStoreStructure> })) {
      distributionResult.assignedTasks += 1;
    }
    projectedState.storedEnergyById.set(
      controllerLinkId,
      Math.max(0, (projectedState.storedEnergyById.get(controllerLinkId) ?? 0) - plannedWithdrawal)
    );
    recordLinkDistributionAction(room.name, distributionResult, telemetryEvents, {
      action: 'workerWithdraw',
      amount: plannedWithdrawal,
      path: 'controllerLink->upgrade',
      sourceId: controllerLinkId,
      workerName: getWorkerId(worker)
    });
  }
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

function findLinkDistributionWorkers(room: Room): Creep[] {
  if (typeof FIND_MY_CREEPS === 'number' && typeof room.find === 'function') {
    const result = room.find(FIND_MY_CREEPS);
    if (Array.isArray(result)) {
      return result;
    }
  }

  const gameCreeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return gameCreeps ? Object.values(gameCreeps).filter((creep) => creep.room?.name === room.name) : [];
}

function findSpawnExtensionDemandTargets(room: Room): LinkEnergyDemandTarget[] {
  const structures = findOwnedStructures(room).filter(
    (structure): structure is StructureSpawn | StructureExtension =>
      (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
        matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')) &&
      getFreeEnergyCapacity(structure) > 0
  );
  if (!isRoomSpawnExtensionEnergyLow(room, structures)) {
    return [];
  }

  return structures.map((target) => ({
    freeCapacity: getFreeEnergyCapacity(target),
    id: getObjectId(target),
    priority: 4,
    target
  }));
}

function findTowerDemandTargets(room: Room): LinkEnergyDemandTarget[] {
  return findOwnedStructures(room)
    .filter(
      (structure): structure is StructureTower =>
        matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower') &&
        getStoredEnergy(structure) < TOWER_REFILL_THRESHOLD &&
        getFreeEnergyCapacity(structure) > 0
    )
    .map((target) => ({
      freeCapacity: getFreeEnergyCapacity(target),
      id: getObjectId(target),
      priority: 3,
      target
    }));
}

function findStorageDemandTargets(room: Room): LinkEnergyDemandTarget[] {
  const storage = room.storage ?? findStorage(room);
  if (!storage || getFreeEnergyCapacity(storage) <= 0) {
    return [];
  }

  return [
    {
      freeCapacity: getFreeEnergyCapacity(storage),
      id: getObjectId(storage),
      priority: 1,
      target: storage
    }
  ];
}

function isRoomSpawnExtensionEnergyLow(
  room: Room,
  structures: Array<StructureSpawn | StructureExtension>
): boolean {
  if (structures.length === 0) {
    return false;
  }

  const energyAvailable = room.energyAvailable;
  const energyCapacityAvailable = room.energyCapacityAvailable;
  if (
    typeof energyAvailable === 'number' &&
    Number.isFinite(energyAvailable) &&
    typeof energyCapacityAvailable === 'number' &&
    Number.isFinite(energyCapacityAvailable)
  ) {
    return energyAvailable < energyCapacityAvailable;
  }

  return structures.some((structure) => getFreeEnergyCapacity(structure) > 0);
}

function canUseControllerLinkForUpgrade(room: Room): boolean {
  const controller = room.controller;
  return Boolean(controller && controller.my !== false && (controller.level === undefined || controller.level < 8));
}

function reserveExistingLinkHaulingAssignments(
  workers: Creep[],
  sourceLinkIds: Set<string>,
  remainingDemandById: Map<string, number>,
  projectedState: ProjectedLinkState
): void {
  for (const worker of workers) {
    const task = worker.memory.task;
    if (task?.type === 'transfer') {
      const targetId = String(task.targetId);
      if (remainingDemandById.has(targetId)) {
        reserveDemandCapacity(remainingDemandById, targetId, getStoredEnergy(worker));
      }
    }

    if (task?.type === 'withdraw') {
      const sourceId = String(task.targetId);
      if (sourceLinkIds.has(sourceId)) {
        const plannedWithdrawal = Math.min(
          getFreeEnergyCapacity(worker),
          projectedState.storedEnergyById.get(sourceId) ?? 0,
          getTotalRemainingDemand(remainingDemandById)
        );
        projectedState.storedEnergyById.set(
          sourceId,
          Math.max(0, (projectedState.storedEnergyById.get(sourceId) ?? 0) - plannedWithdrawal)
        );
        reserveAnyDemandCapacity(remainingDemandById, plannedWithdrawal);
      }
    }
  }
}

function isEligibleLinkDistributionWorker(creep: Creep, roomName: string): boolean {
  if (creep.memory.role !== 'worker' || creep.room?.name !== roomName) {
    return false;
  }

  if (creep.memory.colony && creep.memory.colony !== roomName) {
    return false;
  }

  return !creep.memory.controllerSustain && !creep.memory.territory;
}

function isAssignableLinkDistributionWorker(
  creep: Creep,
  sourceLinkIds: Set<string>,
  demandTargetIds: Set<string>
): boolean {
  const task = creep.memory.task;
  if (!task) {
    return true;
  }

  if (task.type === 'withdraw') {
    return sourceLinkIds.has(String(task.targetId));
  }

  return task.type === 'transfer' && demandTargetIds.has(String(task.targetId));
}

function isControllerUpgradeLinkWorker(
  worker: Creep,
  controller: StructureController,
  controllerLinkId: string
): boolean {
  const task = worker.memory.task;
  if (task?.type === 'withdraw') {
    return String(task.targetId) === controllerLinkId;
  }

  return task?.type === 'upgrade' && String(task.targetId) === String(controller.id);
}

function selectLinkDemandTarget(
  worker: Creep,
  targets: LinkEnergyDemandTarget[],
  remainingDemandById: Map<string, number>
): LinkEnergyDemandTarget | null {
  return (
    targets
      .filter((target) => (remainingDemandById.get(target.id) ?? 0) > 0)
      .sort((left, right) => compareLinkDemandTargetsForWorker(worker, left, right))[0] ?? null
  );
}

function selectLinkEnergySource(
  worker: Creep,
  sourceLinks: StructureLink[],
  projectedState: ProjectedLinkState
): StructureLink | null {
  return (
    sourceLinks
      .filter((sourceLink) => (projectedState.storedEnergyById.get(getObjectId(sourceLink)) ?? 0) > 0)
      .sort(
        (left, right) =>
          compareOptionalRange(worker, left, right) ||
          (projectedState.storedEnergyById.get(getObjectId(right)) ?? 0) -
            (projectedState.storedEnergyById.get(getObjectId(left)) ?? 0) ||
          getObjectId(left).localeCompare(getObjectId(right))
      )[0] ?? null
  );
}

function compareLinkDemandTargetsForWorker(
  worker: Creep,
  left: LinkEnergyDemandTarget,
  right: LinkEnergyDemandTarget
): number {
  return (
    right.priority - left.priority ||
    compareOptionalRange(worker, left.target, right.target) ||
    left.id.localeCompare(right.id)
  );
}

function compareOptionalRange(worker: Creep, left: RoomObject, right: RoomObject): number {
  const getRangeTo = worker.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return 0;
  }

  return normalizeRange(getRangeTo.call(worker.pos, left)) - normalizeRange(getRangeTo.call(worker.pos, right));
}

function normalizeRange(range: unknown): number {
  return typeof range === 'number' && Number.isFinite(range) ? range : Number.POSITIVE_INFINITY;
}

function reserveDemandCapacity(remainingDemandById: Map<string, number>, targetId: string, amount: number): void {
  remainingDemandById.set(targetId, Math.max(0, (remainingDemandById.get(targetId) ?? 0) - amount));
}

function reserveAnyDemandCapacity(remainingDemandById: Map<string, number>, amount: number): void {
  let remainingAmount = amount;
  for (const [targetId, capacity] of [...remainingDemandById.entries()].sort(([leftId], [rightId]) =>
    leftId.localeCompare(rightId)
  )) {
    if (remainingAmount <= 0) {
      return;
    }

    const reservedAmount = Math.min(capacity, remainingAmount);
    remainingDemandById.set(targetId, Math.max(0, capacity - reservedAmount));
    remainingAmount -= reservedAmount;
  }
}

function getTotalRemainingDemand(remainingDemandById: Map<string, number>): number {
  return [...remainingDemandById.values()].reduce((total, amount) => total + Math.max(0, amount), 0);
}

function isExistingDemandTransfer(worker: Creep, demandTargetIds: Set<string>): boolean {
  const task = worker.memory.task;
  return task?.type === 'transfer' && demandTargetIds.has(String(task.targetId));
}

function isExistingSourceWithdraw(worker: Creep, sourceLinkIds: Set<string>): boolean {
  const task = worker.memory.task;
  return task?.type === 'withdraw' && sourceLinkIds.has(String(task.targetId));
}

function setWorkerTask(worker: Creep, task: CreepTaskMemory): boolean {
  if (worker.memory.task?.type === task.type && String(worker.memory.task.targetId) === String(task.targetId)) {
    return false;
  }

  worker.memory.task = task;
  return true;
}

function compareWorkers(left: Creep, right: Creep): number {
  return getWorkerId(left).localeCompare(getWorkerId(right));
}

function getWorkerId(creep: Creep): string {
  const name = (creep as Creep & { name?: unknown }).name;
  if (typeof name === 'string' && name.length > 0) {
    return name;
  }

  const id = (creep as Creep & { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
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

function getStoredEnergy(structure: unknown): number {
  const storedEnergy = (structure as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null } })
    .store?.getUsedCapacity?.(getEnergyResource());
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getFreeEnergyCapacity(structure: unknown): number {
  const freeCapacity = (structure as { store?: { getFreeCapacity?: (resource?: ResourceConstant) => number | null } })
    .store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getLinkCooldown(link: StructureLink): number {
  return typeof link.cooldown === 'number' && Number.isFinite(link.cooldown) ? link.cooldown : 0;
}

function getGameTime(): number {
  const time = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : 0;
}

function getWritableLinkDistributionMemory(room: Room): RoomLinkDistributionMemory {
  const roomWithMemory = room as Room & { memory?: RoomMemory };
  const roomMemory = roomWithMemory.memory ?? getPersistentRoomMemory(room.name);

  if (!roomMemory.linkDistribution) {
    roomMemory.linkDistribution = {};
  }

  return roomMemory.linkDistribution;
}

function getPersistentRoomMemory(roomName: string): RoomMemory {
  const memory = (globalThis as { Memory?: { rooms?: Record<string, RoomMemory> } }).Memory;
  if (!memory) {
    return {};
  }

  if (!memory.rooms) {
    memory.rooms = {};
  }

  memory.rooms[roomName] ??= {};
  return memory.rooms[roomName];
}

function isLinkDistributionDue(
  memory: RoomLinkDistributionMemory,
  room: Room,
  gameTime: number
): boolean {
  const nextCheckAt = memory.nextCheckAt;
  if (typeof nextCheckAt !== 'number' || !Number.isFinite(nextCheckAt) || gameTime >= nextCheckAt) {
    return true;
  }

  return hasSpawnExtensionShortfall(room) || hasTowerRefillShortfall(room);
}

function hasSpawnExtensionShortfall(room: Room): boolean {
  const energyAvailable = room.energyAvailable;
  const energyCapacityAvailable = room.energyCapacityAvailable;
  return (
    typeof energyAvailable === 'number' &&
    Number.isFinite(energyAvailable) &&
    typeof energyCapacityAvailable === 'number' &&
    Number.isFinite(energyCapacityAvailable) &&
    energyAvailable < energyCapacityAvailable
  );
}

function hasTowerRefillShortfall(room: Room): boolean {
  return findOwnedStructures(room).some(
    (structure): structure is StructureTower =>
      matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower') &&
      getStoredEnergy(structure) < TOWER_REFILL_THRESHOLD &&
      getFreeEnergyCapacity(structure) > 0
  );
}

function finishLinkDistributionCheck(
  memory: RoomLinkDistributionMemory,
  gameTime: number,
  result: LinkDistributionResult
): void {
  const cooldownTicks = getMinimumActionCooldownTicks(result.actions);
  if (cooldownTicks !== null && result.transfers.length === 0 && result.assignedTasks === 0) {
    scheduleNextLinkDistributionCheck(memory, gameTime, cooldownTicks, result);
    return;
  }

  scheduleNextLinkDistributionCheck(
    memory,
    gameTime,
    result.transfers.length > 0 || result.assignedTasks > 0
      ? LINK_DISTRIBUTION_ACTIVE_CHECK_INTERVAL
      : LINK_DISTRIBUTION_IDLE_CHECK_INTERVAL,
    result
  );
}

function scheduleNextLinkDistributionCheck(
  memory: RoomLinkDistributionMemory,
  gameTime: number,
  interval: number,
  result: LinkDistributionResult
): void {
  const normalizedInterval = Math.max(1, Math.floor(interval));
  const nextCheckAt = gameTime + normalizedInterval;
  memory.nextCheckAt = nextCheckAt;
  result.nextCheckAt = nextCheckAt;
}

function getMinimumActionCooldownTicks(actions: LinkDistributionAction[]): number | null {
  const cooldownTicks = actions
    .map((action) => action.cooldownTicks)
    .filter((ticks): ticks is number => typeof ticks === 'number' && Number.isFinite(ticks) && ticks > 0);
  return cooldownTicks.length === 0 ? null : Math.min(...cooldownTicks);
}

function recordLinkDistributionAction(
  roomName: string,
  result: LinkDistributionResult,
  telemetryEvents: RuntimeTelemetryEvent[],
  action: LinkDistributionAction
): void {
  result.actions.push(action);
  telemetryEvents.push({
    type: 'linkDistribution',
    roomName,
    ...action
  });
  rememberLinkDistributionAction(roomName, action);
}

function rememberLinkDistributionAction(roomName: string, action: LinkDistributionAction): void {
  const room = (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
  const memory = room ? getWritableLinkDistributionMemory(room) : null;
  if (!memory) {
    return;
  }

  memory.lastPath = action.path;
  if (typeof action.amount === 'number') {
    memory.lastTransferAmount = action.amount;
  }
  if (typeof action.cooldownTicks === 'number') {
    memory.lastCooldownTicks = action.cooldownTicks;
  }
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
