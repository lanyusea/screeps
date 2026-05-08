import { getRangeBetweenPositions, getRoomObjectPosition } from './sourceContainers';
import { classifyLinks, getSourceLinkWorkerEnergyAvailable, type LinkNetwork } from './linkManager';

type EnergyHaulingSource = StructureContainer | StructureLink | StructureStorage | StructureTerminal;
type EnergyHaulingDeliveryTarget = StructureSpawn | StructureExtension | StructureTower | StructureStorage;
type EnergyHaulingBacklogSource = StructureContainer | StructureLink;
type EnergyHaulingStructureConstantGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_LINK'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL'
  | 'STRUCTURE_TOWER';
type EnergyHaulingOrigin = RoomObject | RoomPosition | null | undefined;
type EnergyHaulingDeliveryPriority = 'spawn' | 'extension' | 'tower' | 'storage';

export interface EnergyHaulingOptions {
  sourceEnergyThreshold?: number;
  backlogEnergyThreshold?: number;
  maxHaulers?: number;
  includeDurableSources?: boolean;
  minimumDeliveryFreeCapacity?: number;
}

export interface EnergyHaulerSpawnDemand {
  activeHaulers: number;
  backlogEnergy: number;
  maxHaulers: number;
  roomName: string;
}

interface EnergyHaulingCandidate<T extends RoomObject> {
  energy?: number;
  priority?: EnergyHaulingDeliveryPriority;
  range: number;
  structure: T;
}

export const DEFAULT_ENERGY_HAULING_SOURCE_THRESHOLD = 100;
export const DEFAULT_ENERGY_HAULING_BACKLOG_THRESHOLD = 500;
export const DEFAULT_ENERGY_HAULING_MAX_HAULERS = 2;
export const ENERGY_HAULER_REPLACEMENT_TICKS = 100;
const ENERGY_HAULER_CARRY_MOVE_PAIR_COST = 100;
const MAX_ENERGY_HAULER_CARRY_MOVE_PAIRS = 12;
const MAX_CREEP_PARTS = 50;
const STORAGE_DELIVERY_FREE_CAPACITY_FLOOR = 1;

export function selectEnergyHaulingSource(
  room: Room,
  origin: EnergyHaulingOrigin,
  options: EnergyHaulingOptions = {}
): EnergyHaulingSource | null {
  const sourceThreshold = getConfiguredEnergyThreshold(
    options.sourceEnergyThreshold,
    DEFAULT_ENERGY_HAULING_SOURCE_THRESHOLD
  );
  const network = getLinkNetwork(room);
  const sources = findEnergyHaulingSources(room, options)
    .map((structure): EnergyHaulingCandidate<EnergyHaulingSource> => ({
      structure,
      energy: getWithdrawableEnergy(room, structure, network),
      range: getRangeToRoomObject(origin, structure)
    }))
    .filter((candidate) => (candidate.energy ?? 0) > sourceThreshold);

  return sources.sort(compareSourceCandidates)[0]?.structure ?? null;
}

export function selectEnergyHaulingDeliveryTarget(
  room: Room,
  origin: EnergyHaulingOrigin,
  options: EnergyHaulingOptions = {}
): EnergyHaulingDeliveryTarget | null {
  const minimumFreeCapacity = getConfiguredEnergyThreshold(
    options.minimumDeliveryFreeCapacity,
    STORAGE_DELIVERY_FREE_CAPACITY_FLOOR
  );
  const targets = findEnergyHaulingDeliveryTargets(room)
    .map((structure): EnergyHaulingCandidate<EnergyHaulingDeliveryTarget> => ({
      structure,
      priority: getDeliveryPriority(structure),
      range: getRangeToRoomObject(origin, structure)
    }))
    .filter((candidate) => getFreeEnergyCapacity(candidate.structure) >= minimumFreeCapacity);

  return targets.sort(compareDeliveryCandidates)[0]?.structure ?? null;
}

export function hasPriorityEnergyHaulingDeliveryDemand(room: Room): boolean {
  return findEnergyHaulingDeliveryTargets(room).some(
    (target) => !isStorageStructure(target) && getFreeEnergyCapacity(target) > 0
  );
}

export function getEnergyHaulingBacklog(
  room: Room,
  options: EnergyHaulingOptions = {}
): number {
  const sourceThreshold = getConfiguredEnergyThreshold(
    options.sourceEnergyThreshold,
    DEFAULT_ENERGY_HAULING_SOURCE_THRESHOLD
  );
  const network = getLinkNetwork(room);

  return findEnergyHaulingBacklogSources(room).reduce((total, source) => {
    const energy = getWithdrawableEnergy(room, source, network);
    return energy > sourceThreshold ? total + energy : total;
  }, 0);
}

export function selectEnergyHaulerSpawnDemand(
  room: Room,
  options: EnergyHaulingOptions = {}
): EnergyHaulerSpawnDemand | null {
  if (room.controller?.my !== true) {
    return null;
  }

  const backlogThreshold = getConfiguredEnergyThreshold(
    options.backlogEnergyThreshold,
    DEFAULT_ENERGY_HAULING_BACKLOG_THRESHOLD
  );
  const backlogEnergy = getEnergyHaulingBacklog(room, options);
  if (backlogEnergy <= backlogThreshold || !hasEnergyHaulingDeliveryCapacity(room)) {
    return null;
  }

  const maxHaulers = getConfiguredPositiveInteger(options.maxHaulers, DEFAULT_ENERGY_HAULING_MAX_HAULERS);
  const activeHaulers = countActiveLocalEnergyHaulers(room.name);
  if (activeHaulers >= maxHaulers) {
    return null;
  }

  return {
    activeHaulers,
    backlogEnergy,
    maxHaulers,
    roomName: room.name
  };
}

export function buildEnergyHaulerBody(energyCapacityAvailable: number): BodyPartConstant[] {
  const energyBudget = normalizeNonNegativeInteger(energyCapacityAvailable);
  const pairCount = Math.min(
    MAX_ENERGY_HAULER_CARRY_MOVE_PAIRS,
    Math.floor(energyBudget / ENERGY_HAULER_CARRY_MOVE_PAIR_COST),
    Math.floor(MAX_CREEP_PARTS / 2)
  );

  if (pairCount <= 0) {
    return [];
  }

  return Array.from({ length: pairCount }).flatMap(() => ['carry', 'move'] as BodyPartConstant[]);
}

export function isLocalEnergyHauler(creep: Creep, roomName: string): boolean {
  return (
    creep.memory?.role === 'hauler' &&
    creep.memory.colony === roomName &&
    creep.memory.remoteHauler === undefined &&
    canSatisfyEnergyHaulerCapacity(creep)
  );
}

function findEnergyHaulingSources(room: Room, options: EnergyHaulingOptions): EnergyHaulingSource[] {
  const includeDurableSources = options.includeDurableSources !== false;
  return findRoomStructures(room).filter((structure): structure is EnergyHaulingSource => {
    if (isContainerStructure(structure)) {
      return true;
    }

    if (!isOwnedEnergyHaulingStructure(structure)) {
      return false;
    }

    if (isLinkStructure(structure)) {
      return true;
    }

    return includeDurableSources && (isStorageStructure(structure) || isTerminalStructure(structure));
  });
}

function findEnergyHaulingBacklogSources(room: Room): EnergyHaulingBacklogSource[] {
  return findRoomStructures(room).filter(
    (structure): structure is EnergyHaulingBacklogSource =>
      isContainerStructure(structure) || (isLinkStructure(structure) && isOwnedEnergyHaulingStructure(structure))
  );
}

function findEnergyHaulingDeliveryTargets(room: Room): EnergyHaulingDeliveryTarget[] {
  return includeRoomDurableStores(room, findOwnedStructures(room)).filter(
    (structure): structure is EnergyHaulingDeliveryTarget =>
      isSpawnStructure(structure) ||
      isExtensionStructure(structure) ||
      isTowerStructure(structure) ||
      isStorageStructure(structure)
  );
}

function hasEnergyHaulingDeliveryCapacity(room: Room): boolean {
  return findEnergyHaulingDeliveryTargets(room).some((target) => getFreeEnergyCapacity(target) > 0);
}

function countActiveLocalEnergyHaulers(roomName: string): number {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).filter((creep) => isLocalEnergyHauler(creep, roomName)).length;
}

function canSatisfyEnergyHaulerCapacity(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > ENERGY_HAULER_REPLACEMENT_TICKS;
}

function compareSourceCandidates(
  left: EnergyHaulingCandidate<EnergyHaulingSource>,
  right: EnergyHaulingCandidate<EnergyHaulingSource>
): number {
  return (
    left.range - right.range ||
    getSourceTypeRank(left.structure) - getSourceTypeRank(right.structure) ||
    (right.energy ?? 0) - (left.energy ?? 0) ||
    getObjectId(left.structure).localeCompare(getObjectId(right.structure))
  );
}

function compareDeliveryCandidates(
  left: EnergyHaulingCandidate<EnergyHaulingDeliveryTarget>,
  right: EnergyHaulingCandidate<EnergyHaulingDeliveryTarget>
): number {
  return (
    getDeliveryPriorityRank(left.priority) - getDeliveryPriorityRank(right.priority) ||
    left.range - right.range ||
    getObjectId(left.structure).localeCompare(getObjectId(right.structure))
  );
}

function getSourceTypeRank(source: EnergyHaulingSource): number {
  if (isContainerStructure(source)) {
    return 0;
  }

  if (isLinkStructure(source)) {
    return 1;
  }

  if (isStorageStructure(source)) {
    return 2;
  }

  return 3;
}

function getDeliveryPriority(structure: EnergyHaulingDeliveryTarget): EnergyHaulingDeliveryPriority {
  if (isSpawnStructure(structure)) {
    return 'spawn';
  }

  if (isExtensionStructure(structure)) {
    return 'extension';
  }

  if (isTowerStructure(structure)) {
    return 'tower';
  }

  return 'storage';
}

function getDeliveryPriorityRank(priority: EnergyHaulingDeliveryPriority | undefined): number {
  switch (priority) {
    case 'spawn':
      return 0;
    case 'extension':
      return 1;
    case 'tower':
      return 2;
    case 'storage':
      return 3;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function getWithdrawableEnergy(
  room: Room,
  source: EnergyHaulingSource,
  network: LinkNetwork | null
): number {
  if (isLinkStructure(source)) {
    return getSourceLinkWorkerEnergyAvailable(room, source, network ?? undefined);
  }

  return getStoredEnergy(source);
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { store?: StoreDefinition } | null)?.store;
  const usedCapacity = store?.getUsedCapacity?.(getEnergyResource());
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const storedEnergy = (store as Partial<Record<ResourceConstant, number>> | undefined)?.[getEnergyResource()];
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getFreeEnergyCapacity(target: unknown): number {
  const store = (target as { store?: StoreDefinition } | null)?.store;
  const freeCapacity = store?.getFreeCapacity?.(getEnergyResource());
  if (typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)) {
    return Math.max(0, freeCapacity);
  }

  const capacity = store?.getCapacity?.(getEnergyResource()) ?? store?.getCapacity?.();
  if (typeof capacity === 'number' && Number.isFinite(capacity)) {
    return Math.max(0, capacity - getStoredEnergy(target));
  }

  return 0;
}

function getRangeToRoomObject(origin: EnergyHaulingOrigin, target: RoomObject): number {
  const originPosition = getEnergyHaulingOriginPosition(origin);
  const targetPosition = getRoomObjectPosition(target);
  if (!originPosition || !targetPosition) {
    return Number.MAX_SAFE_INTEGER;
  }

  const rangeTo = (originPosition as { getRangeTo?: (target: RoomObject | RoomPosition) => number }).getRangeTo;
  if (typeof rangeTo === 'function') {
    const range = rangeTo.call(originPosition, target);
    if (typeof range === 'number' && Number.isFinite(range)) {
      return Math.max(0, range);
    }
  }

  if (originPosition.roomName !== targetPosition.roomName) {
    return 50;
  }

  return getRangeBetweenPositions(originPosition, targetPosition);
}

function getEnergyHaulingOriginPosition(origin: EnergyHaulingOrigin): RoomPosition | null {
  if (!origin) {
    return null;
  }

  const roomObjectPosition = getRoomObjectPosition(origin as RoomObject);
  if (roomObjectPosition) {
    return roomObjectPosition;
  }

  return isPositionLike(origin) ? (origin as RoomPosition) : null;
}

function isPositionLike(value: unknown): value is RoomPosition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { x?: unknown }).x === 'number' &&
    typeof (value as { y?: unknown }).y === 'number' &&
    Number.isFinite((value as { x: number }).x) &&
    Number.isFinite((value as { y: number }).y)
  );
}

function getLinkNetwork(room: Room): LinkNetwork | null {
  try {
    return classifyLinks(room);
  } catch {
    return null;
  }
}

function includeRoomDurableStores(room: Room, structures: AnyOwnedStructure[]): AnyOwnedStructure[] {
  const result = [...structures];
  for (const durableStore of [room.storage, room.terminal]) {
    if (durableStore && !result.some((structure) => getObjectId(structure) === getObjectId(durableStore))) {
      result.push(durableStore as AnyOwnedStructure);
    }
  }

  return result;
}

function findRoomStructures(room: Room): Structure[] {
  const findStructures = getGlobalNumber('FIND_STRUCTURES');
  if (findStructures === undefined || typeof room.find !== 'function') {
    return [];
  }

  const result = (room.find as unknown as (type: number) => unknown[])(findStructures);
  return Array.isArray(result) ? (result as Structure[]) : [];
}

function findOwnedStructures(room: Room): AnyOwnedStructure[] {
  const findMyStructures = getGlobalNumber('FIND_MY_STRUCTURES');
  if (findMyStructures === undefined || typeof room.find !== 'function') {
    return [];
  }

  const result = (room.find as unknown as (type: number) => unknown[])(findMyStructures);
  return Array.isArray(result) ? (result as AnyOwnedStructure[]) : [];
}

function isContainerStructure(structure: Structure): structure is StructureContainer {
  return matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container');
}

function isLinkStructure(structure: Structure): structure is StructureLink {
  return matchesStructureType(structure.structureType, 'STRUCTURE_LINK', 'link');
}

function isStorageStructure(structure: Structure): structure is StructureStorage {
  return matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage');
}

function isTerminalStructure(structure: Structure): structure is StructureTerminal {
  return matchesStructureType(structure.structureType, 'STRUCTURE_TERMINAL', 'terminal');
}

function isOwnedEnergyHaulingStructure(structure: Structure): boolean {
  return (structure as { my?: unknown }).my === true;
}

function isSpawnStructure(structure: Structure): structure is StructureSpawn {
  return matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isExtensionStructure(structure: Structure): structure is StructureExtension {
  return matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension');
}

function isTowerStructure(structure: Structure): structure is StructureTower {
  return matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower');
}

function matchesStructureType(
  actual: string | undefined,
  globalName: EnergyHaulingStructureConstantGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<EnergyHaulingStructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getConfiguredEnergyThreshold(value: number | undefined, fallback: number): number {
  return normalizeNonNegativeInteger(value ?? fallback);
}

function getConfiguredPositiveInteger(value: number | undefined, fallback: number): number {
  return Math.max(1, normalizeNonNegativeInteger(value ?? fallback));
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getObjectId(object: unknown): string {
  const id = (object as { id?: unknown; name?: unknown } | null)?.id;
  if (typeof id === 'string') {
    return id;
  }

  const name = (object as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

function getEnergyResource(): ResourceConstant {
  return (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy';
}
