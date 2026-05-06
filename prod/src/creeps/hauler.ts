import { selectRemoteHaulerDeliveryTask } from '../tasks/workerTasks';
import { recordCreepBehaviorEnergyAcquisition } from '../telemetry/behaviorTelemetry';
import {
  getRemoteSourceAssignments,
  moveTowardRoom,
  REMOTE_CREEP_REPLACEMENT_TICKS,
  shouldRetreatFromRemote,
  type RemoteContainerAssignment,
  type RemoteSourceAssignment
} from './remoteHarvester';
import { buildRemoteHaulerBody } from '../spawn/bodyBuilder';

export const HAULER_ROLE = 'hauler';
export const REMOTE_HAULER_DISPATCH_ENERGY_THRESHOLD = 500;

const MAX_REMOTE_HAULERS_PER_CONTAINER = 1;
const HAULER_MOVE_OPTS: MoveToOpts = { reusePath: 20, ignoreRoads: false };
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

type RemoteHaulerEnergySource = StructureContainer | StructureStorage | StructureTerminal;
type RemoteHaulerEnergySourceStructureGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL';

export { buildRemoteHaulerBody };

export function selectRemoteHaulerAssignment(homeRoom: string): RemoteContainerAssignment | null {
  if (!hasRemoteHaulerDeliveryDemand(homeRoom)) {
    return null;
  }

  return (
    getRemoteSourceAssignments(homeRoom)
      .filter(hasRemoteContainerAssignment)
      .filter((assignment) => assignment.containerEnergy > REMOTE_HAULER_DISPATCH_ENERGY_THRESHOLD)
      .filter((assignment) => countRemoteHaulersForContainer(assignment) < MAX_REMOTE_HAULERS_PER_CONTAINER)
      .sort(compareRemoteHaulerAssignments)[0] ?? null
  );
}

function hasRemoteContainerAssignment(assignment: RemoteSourceAssignment): assignment is RemoteContainerAssignment {
  return isNonEmptyString(assignment.containerId);
}

function hasRemoteHaulerDeliveryDemand(homeRoom: string): boolean {
  const room = getVisibleRoom(homeRoom);
  return room !== undefined && selectRemoteHaulerDeliveryTask(room) !== null;
}

export function runHauler(creep: Creep): void {
  const assignment = normalizeRemoteHaulerMemory(creep.memory?.remoteHauler);
  if (!assignment) {
    return;
  }

  if (shouldRetreatFromRemote(creep, assignment)) {
    delete creep.memory.task;
    if (getCarriedEnergy(creep) > 0 && creep.room?.name === assignment.homeRoom) {
      deliverEnergy(creep, assignment);
    } else if (creep.room?.name !== assignment.homeRoom || getCarriedEnergy(creep) > 0) {
      moveTowardRoom(creep, assignment.homeRoom);
    }
    return;
  }

  if (getCarriedEnergy(creep) > 0) {
    deliverEnergy(creep, assignment);
    return;
  }

  collectRemoteEnergy(creep, assignment);
}

function collectRemoteEnergy(creep: Creep, assignment: CreepRemoteHaulerMemory): void {
  const assignedContainer = getAssignedContainer(assignment);
  if (creep.room?.name !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.targetRoom, assignedContainer);
    return;
  }

  const source = selectRemoteHaulerEnergySource(creep, assignedContainer);
  if (!source) {
    delete creep.memory.task;
    if (assignedContainer) {
      moveTo(creep, assignedContainer);
    }
    return;
  }

  const task: Extract<CreepTaskMemory, { type: 'withdraw' }> = {
    type: 'withdraw',
    targetId: source.id as Id<AnyStoreStructure>
  };
  creep.memory.task = task;
  const result = creep.withdraw?.(source, getEnergyResource());
  if (result === OK_CODE) {
    recordCreepBehaviorEnergyAcquisition(creep, 'withdrawn');
  }
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, source);
  }
}

function deliverEnergy(creep: Creep, assignment: CreepRemoteHaulerMemory): void {
  if (creep.room?.name !== assignment.homeRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.homeRoom);
    return;
  }

  const task = selectRemoteHaulerDeliveryTask(creep.room);
  if (!task) {
    delete creep.memory.task;
    return;
  }

  creep.memory.task = task;
  const target = getObjectById<AnyStoreStructure>(task.targetId);
  if (!target) {
    delete creep.memory.task;
    return;
  }

  const result = creep.transfer?.(target, getEnergyResource());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, target);
  }
}

function compareRemoteHaulerAssignments(left: RemoteSourceAssignment, right: RemoteSourceAssignment): number {
  return (
    right.containerEnergy - left.containerEnergy ||
    left.targetRoom.localeCompare(right.targetRoom) ||
    String(left.sourceId).localeCompare(String(right.sourceId))
  );
}

function countRemoteHaulersForContainer(assignment: RemoteSourceAssignment): number {
  return getRemoteOperationCreeps(assignment.homeRoom, assignment.targetRoom).filter(
    (creep) =>
      creep.memory?.role === HAULER_ROLE &&
      canSatisfyRemoteCreepCapacity(creep) &&
      creep.memory.remoteHauler?.homeRoom === assignment.homeRoom &&
      creep.memory.remoteHauler?.targetRoom === assignment.targetRoom &&
      String(creep.memory.remoteHauler?.containerId) === String(assignment.containerId)
  ).length;
}

function canSatisfyRemoteCreepCapacity(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > REMOTE_CREEP_REPLACEMENT_TICKS;
}

function normalizeRemoteHaulerMemory(value: unknown): CreepRemoteHaulerMemory | null {
  if (!isRecord(value)) {
    return null;
  }

  return isNonEmptyString(value.homeRoom) &&
    isNonEmptyString(value.targetRoom) &&
    isNonEmptyString(value.sourceId) &&
    isNonEmptyString(value.containerId)
    ? {
        homeRoom: value.homeRoom,
        targetRoom: value.targetRoom,
        sourceId: value.sourceId as Id<Source>,
        containerId: value.containerId as Id<StructureContainer>
      }
    : null;
}

function getAssignedContainer(assignment: CreepRemoteHaulerMemory): StructureContainer | null {
  return getObjectById<StructureContainer>(assignment.containerId);
}

function selectRemoteHaulerEnergySource(
  creep: Creep,
  assignedContainer: StructureContainer | null
): RemoteHaulerEnergySource | null {
  const seenSourceIds = new Set<string>();
  const sources: RemoteHaulerEnergySource[] = [];

  for (const source of [assignedContainer, ...findVisibleRemoteHaulerEnergySources(creep.room)]) {
    if (!source || getStoredEnergy(source) <= 0) {
      continue;
    }

    const sourceId = getObjectId(source);
    if (seenSourceIds.has(sourceId)) {
      continue;
    }

    seenSourceIds.add(sourceId);
    sources.push(source);
  }

  return sources.sort((left, right) => compareRemoteHaulerEnergySources(creep, left, right))[0] ?? null;
}

function findVisibleRemoteHaulerEnergySources(room: Room | undefined): RemoteHaulerEnergySource[] {
  if (typeof FIND_STRUCTURES !== 'number' || typeof room?.find !== 'function') {
    return [];
  }

  const structures = room.find(FIND_STRUCTURES);
  return Array.isArray(structures) ? structures.filter(isRemoteHaulerEnergySource) : [];
}

function isRemoteHaulerEnergySource(structure: Structure): structure is RemoteHaulerEnergySource {
  const structureType = structure.structureType;
  if (matchesStructureType(structureType, 'STRUCTURE_CONTAINER', 'container')) {
    return true;
  }

  if (
    matchesStructureType(structureType, 'STRUCTURE_STORAGE', 'storage') ||
    matchesStructureType(structureType, 'STRUCTURE_TERMINAL', 'terminal')
  ) {
    return (structure as { my?: unknown }).my !== false;
  }

  return false;
}

function compareRemoteHaulerEnergySources(
  creep: Creep,
  left: RemoteHaulerEnergySource,
  right: RemoteHaulerEnergySource
): number {
  return (
    getStoredEnergy(right) - getStoredEnergy(left) ||
    getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) ||
    getObjectId(left).localeCompare(getObjectId(right))
  );
}

function getRangeToRoomObject(creep: Creep, target: RoomObject): number {
  const range = creep.pos?.getRangeTo?.(target);
  return typeof range === 'number' && Number.isFinite(range) ? Math.max(0, range) : Number.MAX_SAFE_INTEGER;
}

function moveTo(creep: Creep, target: RoomObject): void {
  creep.moveTo?.(target, HAULER_MOVE_OPTS);
}

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
}

function getStoredEnergy(target: unknown): number {
  const store = (target as any)?.store;
  const usedCapacity = store?.getUsedCapacity?.(getEnergyResource());
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const storedEnergy = store?.[getEnergyResource()];
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getEnergyResource(): ResourceConstant {
  return (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy';
}

function getObjectById<T>(id: string): T | null {
  const getObjectById = (globalThis as { Game?: Partial<Pick<Game, 'getObjectById'>> }).Game?.getObjectById as
    | ((id: string) => T | null)
    | undefined;
  return typeof getObjectById === 'function' ? getObjectById(String(id)) : null;
}

function getRemoteOperationCreeps(homeRoom: string, targetRoom: string): Creep[] {
  const findMyCreeps = (globalThis as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
  if (typeof findMyCreeps !== 'number') {
    return [];
  }

  const seen = new Set<string>();
  const creeps: Creep[] = [];
  for (const roomName of [homeRoom, targetRoom]) {
    const room = getVisibleRoom(roomName);
    const roomCreeps =
      typeof room?.find === 'function' ? (room.find(findMyCreeps as FindConstant) as Creep[]) : undefined;
    if (!Array.isArray(roomCreeps)) {
      continue;
    }

    for (const creep of roomCreeps) {
      const key = getCreepStableKey(creep);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      creeps.push(creep);
    }
  }

  return creeps;
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function getCreepStableKey(creep: Creep): string {
  return creep.name ?? `${creep.memory?.role ?? 'creep'}:${creep.memory?.colony ?? ''}:${creep.ticksToLive ?? ''}`;
}

function getObjectId(object: unknown): string {
  const id = (object as { id?: unknown; name?: unknown } | null)?.id;
  if (typeof id === 'string') {
    return id;
  }

  const name = (object as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

function matchesStructureType(
  actual: string | undefined,
  globalName: RemoteHaulerEnergySourceStructureGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<RemoteHaulerEnergySourceStructureGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function getErrNotInRangeCode(): ScreepsReturnCode {
  return (globalThis as { ERR_NOT_IN_RANGE?: ScreepsReturnCode }).ERR_NOT_IN_RANGE ?? ERR_NOT_IN_RANGE_CODE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
