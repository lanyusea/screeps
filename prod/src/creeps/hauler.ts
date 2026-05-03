import { selectRemoteHaulerDeliveryTask } from '../tasks/workerTasks';
import {
  getRemoteSourceAssignments,
  moveTowardRoom,
  REMOTE_CREEP_REPLACEMENT_TICKS,
  shouldRetreatFromRemote,
  type RemoteSourceAssignment
} from './remoteHarvester';
import { buildRemoteHaulerBody } from '../spawn/bodyBuilder';

export const HAULER_ROLE = 'hauler';
export const REMOTE_HAULER_DISPATCH_ENERGY_THRESHOLD = 500;

const MAX_REMOTE_HAULERS_PER_CONTAINER = 1;
const HAULER_MOVE_OPTS: MoveToOpts = { reusePath: 20, ignoreRoads: false };
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

export { buildRemoteHaulerBody };

export function selectRemoteHaulerAssignment(homeRoom: string): RemoteSourceAssignment | null {
  if (!hasRemoteHaulerDeliveryDemand(homeRoom)) {
    return null;
  }

  return (
    getRemoteSourceAssignments(homeRoom)
      .filter((assignment) => assignment.containerEnergy > REMOTE_HAULER_DISPATCH_ENERGY_THRESHOLD)
      .filter((assignment) => countRemoteHaulersForContainer(assignment) < MAX_REMOTE_HAULERS_PER_CONTAINER)
      .sort(compareRemoteHaulerAssignments)[0] ?? null
  );
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
  const container = getAssignedContainer(assignment);
  if (creep.room?.name !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.targetRoom, container);
    return;
  }

  if (!container) {
    delete creep.memory.task;
    return;
  }

  if (getStoredEnergy(container) <= 0) {
    delete creep.memory.task;
    moveTo(creep, container);
    return;
  }

  const task: Extract<CreepTaskMemory, { type: 'withdraw' }> = {
    type: 'withdraw',
    targetId: assignment.containerId as Id<AnyStoreStructure>
  };
  creep.memory.task = task;
  const result = creep.withdraw?.(container, getEnergyResource());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, container);
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
    const find = room?.find as ((type: number) => Creep[]) | undefined;
    const roomCreeps = find?.(findMyCreeps);
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

function getErrNotInRangeCode(): ScreepsReturnCode {
  return (globalThis as { ERR_NOT_IN_RANGE?: ScreepsReturnCode }).ERR_NOT_IN_RANGE ?? ERR_NOT_IN_RANGE_CODE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
