import { classifyLinks } from '../economy/linkManager';
import { findSourceContainer, getRangeBetweenPositions, getRoomObjectPosition } from '../economy/sourceContainers';
import { buildRemoteHarvesterBody } from '../spawn/bodyBuilder';
import { WORKER_REPLACEMENT_TICKS_TO_LIVE } from './roleCounts';

export const SOURCE_HARVESTER_ROLE = 'sourceHarvester';

const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const SOURCE_LINK_DEPOSIT_RANGE = 1;

type MobileFallbackEnergySink = StructureSpawn | StructureExtension | StructureTower;

export interface SourceHarvesterAssignment {
  roomName: string;
  sourceId: Id<Source>;
  containerId: Id<StructureContainer>;
}

export { buildRemoteHarvesterBody as buildSourceHarvesterBody };

export function selectSourceHarvesterAssignment(room: Room): SourceHarvesterAssignment | null {
  return (
    getSourceHarvesterAssignments(room).find(
      (assignment) => countAssignedSourceHarvesters(assignment) < 1
    ) ?? null
  );
}

export function getSourceHarvesterAssignments(room: Room): SourceHarvesterAssignment[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return (room.find(FIND_SOURCES) as Source[])
    .flatMap((source) => {
      const container = findSourceContainer(room, source);
      return container
        ? [
            {
              roomName: room.name,
              sourceId: source.id,
              containerId: container.id
            }
          ]
        : [];
    })
    .sort(compareAssignments);
}

export function runSourceHarvester(creep: Creep): void {
  const assignment = normalizeSourceHarvesterMemory(creep.memory?.sourceHarvester);
  if (!assignment) {
    return;
  }

  creep.memory.task = {
    type: 'harvest',
    targetId: assignment.sourceId,
    sourceContainerAssigned: true
  };

  if (creep.room?.name !== assignment.roomName) {
    moveTowardRoom(creep, assignment.roomName);
    return;
  }

  const source = getAssignedSource(assignment);
  if (!source) {
    moveTowardRoom(creep, assignment.roomName);
    return;
  }

  const container = getAssignedContainer(assignment) ?? findSourceContainer(creep.room, source);
  if (!container) {
    runMobileFallback(creep, source);
    return;
  }

  if (!isInRangeTo(creep, container, 0)) {
    moveTo(creep, container);
    return;
  }

  if (isSourceDepleted(source)) {
    if (getCarriedEnergy(creep) > 0) {
      transferHarvestedEnergy(creep, source, container);
    }
    return;
  }

  if (getFreeEnergyCapacity(creep) <= 0 && getCarriedEnergy(creep) > 0) {
    transferHarvestedEnergy(creep, source, container);
    return;
  }

  const result = creep.harvest?.(source);
  if (
    (result === getErrFullCode() || result === getErrNotEnoughResourcesCode()) &&
    getCarriedEnergy(creep) > 0
  ) {
    transferHarvestedEnergy(creep, source, container);
  }
}

function runMobileFallback(creep: Creep, source: Source): void {
  if (getCarriedEnergy(creep) > 0 && getFreeEnergyCapacity(creep) <= 0) {
    const sink = selectMobileFallbackEnergySink(creep);
    if (sink) {
      const result = creep.transfer?.(sink, getEnergyResource());
      if (result === getErrNotInRangeCode()) {
        moveTo(creep, sink);
      }
      return;
    }
  }

  if (!isInRangeTo(creep, source, 1)) {
    moveTo(creep, source);
    return;
  }

  creep.harvest?.(source);
}

function transferHarvestedEnergy(
  creep: Creep,
  source: Source,
  container: StructureContainer
): ScreepsReturnCode | undefined {
  const link = selectSourceLinkDeposit(creep.room, source, container);
  const target = link ?? container;
  const result = creep.transfer?.(target, getEnergyResource());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, target);
  }
  return result;
}

function selectSourceLinkDeposit(
  room: Room,
  source: Source,
  container: StructureContainer
): StructureLink | null {
  return (
    classifyLinks(room).sourceLinks
      .filter((link) => getFreeEnergyCapacity(link) > 0)
      .filter((link) => isNearRoomObject(source, link, 2))
      .filter((link) => isNearRoomObject(container, link, SOURCE_LINK_DEPOSIT_RANGE))
      .sort((left, right) => compareSourceLinkDeposits(container, left, right))[0] ?? null
  );
}

function compareSourceLinkDeposits(
  container: StructureContainer,
  left: StructureLink,
  right: StructureLink
): number {
  const containerPosition = getRoomObjectPosition(container);
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  return (
    (containerPosition && leftPosition ? getRangeBetweenPositions(containerPosition, leftPosition) : 99) -
      (containerPosition && rightPosition ? getRangeBetweenPositions(containerPosition, rightPosition) : 99) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function selectMobileFallbackEnergySink(creep: Creep): AnyStoreStructure | null {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof creep.room?.find !== 'function') {
    return null;
  }

  const sinks = (creep.room.find(FIND_MY_STRUCTURES) as AnyOwnedStructure[])
    .filter((structure): structure is MobileFallbackEnergySink => isMobileFallbackEnergySink(structure))
    .sort((left, right) => compareRangeToCreep(creep, left, right) || String(left.id).localeCompare(String(right.id)));
  return sinks[0] ?? null;
}

function isMobileFallbackEnergySink(structure: AnyOwnedStructure): structure is MobileFallbackEnergySink {
  const structureType = structure.structureType;
  return (
    (matchesStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn') ||
      matchesStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension') ||
      matchesStructureType(structureType, 'STRUCTURE_TOWER', 'tower')) &&
    getFreeEnergyCapacity(structure) > 0
  );
}

function countAssignedSourceHarvesters(assignment: SourceHarvesterAssignment): number {
  return getGameCreeps().filter((creep) => isAssignedToSourceHarvesterSlot(creep, assignment)).length;
}

function isAssignedToSourceHarvesterSlot(creep: Creep, assignment: SourceHarvesterAssignment): boolean {
  if (!canSatisfySourceHarvesterCapacity(creep)) {
    return false;
  }

  if (
    creep.memory?.role === SOURCE_HARVESTER_ROLE &&
    creep.memory.sourceHarvester?.roomName === assignment.roomName &&
    String(creep.memory.sourceHarvester?.sourceId) === String(assignment.sourceId)
  ) {
    return true;
  }

  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  return (
    creep.memory?.role === 'worker' &&
    creep.room?.name === assignment.roomName &&
    task?.type === 'harvest' &&
    task.sourceContainerAssigned === true &&
    String(task.targetId) === String(assignment.sourceId)
  );
}

function canSatisfySourceHarvesterCapacity(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}

function getAssignedSource(assignment: SourceHarvesterAssignment): Source | null {
  const source = getObjectById<Source>(assignment.sourceId);
  if (source) {
    return source;
  }

  const room = getVisibleRoom(assignment.roomName);
  if (!room || typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  return (
    (room.find(FIND_SOURCES) as Source[]).find((candidate) => String(candidate.id) === String(assignment.sourceId)) ??
    null
  );
}

function getAssignedContainer(assignment: SourceHarvesterAssignment): StructureContainer | null {
  const container = getObjectById<StructureContainer>(assignment.containerId);
  return container ?? null;
}

function normalizeSourceHarvesterMemory(value: unknown): SourceHarvesterAssignment | null {
  if (!isRecord(value)) {
    return null;
  }

  return isNonEmptyString(value.roomName) &&
    isNonEmptyString(value.sourceId) &&
    isNonEmptyString(value.containerId)
    ? {
        roomName: value.roomName,
        sourceId: value.sourceId as Id<Source>,
        containerId: value.containerId as Id<StructureContainer>
      }
    : null;
}

function moveTowardRoom(creep: Creep, roomName: string): void {
  const visibleController = getVisibleRoom(roomName)?.controller;
  if (visibleController) {
    moveTo(creep, visibleController);
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: new (x: number, y: number, roomName: string) => RoomPosition })
    .RoomPosition;
  if (typeof RoomPositionCtor === 'function') {
    moveTo(creep, new RoomPositionCtor(25, 25, roomName));
  }
}

function moveTo(creep: Creep, target: RoomObject | RoomPosition): void {
  creep.moveTo?.(target);
}

function isInRangeTo(creep: Creep, target: RoomObject, range: number): boolean {
  const actualRange = creep.pos?.getRangeTo?.(target);
  return typeof actualRange !== 'number' || actualRange <= range;
}

function isNearRoomObject(left: RoomObject, right: RoomObject, range: number): boolean {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  return (
    leftPosition !== null &&
    rightPosition !== null &&
    (typeof leftPosition.roomName !== 'string' ||
      typeof rightPosition.roomName !== 'string' ||
      leftPosition.roomName === rightPosition.roomName) &&
    getRangeBetweenPositions(leftPosition, rightPosition) <= range
  );
}

function compareRangeToCreep(creep: Creep, left: RoomObject, right: RoomObject): number {
  const getRangeTo = creep.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return 0;
  }

  return normalizeRange(getRangeTo.call(creep.pos, left)) - normalizeRange(getRangeTo.call(creep.pos, right));
}

function normalizeRange(range: unknown): number {
  return typeof range === 'number' && Number.isFinite(range) ? range : Number.POSITIVE_INFINITY;
}

function isSourceDepleted(source: Source): boolean {
  return typeof source.energy === 'number' && source.energy <= 0;
}

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
}

function getStoredEnergy(target: unknown): number {
  const usedCapacity = (target as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store?.getUsedCapacity?.(getEnergyResource());
  return typeof usedCapacity === 'number' && Number.isFinite(usedCapacity) ? Math.max(0, usedCapacity) : 0;
}

function getFreeEnergyCapacity(target: unknown): number {
  const freeCapacity = (target as { store?: { getFreeCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function getErrFullCode(): ScreepsReturnCode {
  return ((globalThis as { ERR_FULL?: ScreepsReturnCode }).ERR_FULL ?? ERR_FULL_CODE) as ScreepsReturnCode;
}

function getErrNotEnoughResourcesCode(): ScreepsReturnCode {
  return ((globalThis as { ERR_NOT_ENOUGH_RESOURCES?: ScreepsReturnCode }).ERR_NOT_ENOUGH_RESOURCES ??
    ERR_NOT_ENOUGH_RESOURCES_CODE) as ScreepsReturnCode;
}

function getErrNotInRangeCode(): ScreepsReturnCode {
  return ((globalThis as { ERR_NOT_IN_RANGE?: ScreepsReturnCode }).ERR_NOT_IN_RANGE ??
    ERR_NOT_IN_RANGE_CODE) as ScreepsReturnCode;
}

function getObjectById<T>(id: string): T | null {
  const getObjectById = (globalThis as { Game?: Partial<Game> }).Game?.getObjectById;
  if (typeof getObjectById !== 'function') {
    return null;
  }

  try {
    return getObjectById(id) as T | null;
  } catch {
    return null;
  }
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return creeps ? Object.values(creeps).filter((creep): creep is Creep => creep !== undefined) : [];
}

function compareAssignments(left: SourceHarvesterAssignment, right: SourceHarvesterAssignment): number {
  return left.roomName.localeCompare(right.roomName) || String(left.sourceId).localeCompare(String(right.sourceId));
}

function matchesStructureType(
  actual: string | undefined,
  globalName: 'STRUCTURE_EXTENSION' | 'STRUCTURE_SPAWN' | 'STRUCTURE_TOWER',
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<typeof globalName, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
