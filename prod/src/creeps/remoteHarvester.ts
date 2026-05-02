import { hasSafeRouteAvoidingDeadZones, isKnownDeadZoneRoom } from '../defense/deadZone';
import { findSourceContainer } from '../economy/sourceContainers';

export const REMOTE_HARVESTER_ROLE = 'remoteHarvester';
export const REMOTE_CREEP_REPLACEMENT_TICKS = 100;

const MAX_REMOTE_HARVESTERS_PER_SOURCE = 1;
const MAX_REMOTE_HARVESTER_WORK_PARTS = 5;
const REMOTE_MOVE_OPTS: MoveToOpts = { reusePath: 20, ignoreRoads: false };
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

export interface RemoteSourceAssignment {
  homeRoom: string;
  targetRoom: string;
  sourceId: Id<Source>;
  containerId: Id<StructureContainer>;
  containerEnergy: number;
}

export function buildRemoteHarvesterBody(energyAvailable: number): BodyPartConstant[] {
  const workParts = Math.min(
    MAX_REMOTE_HARVESTER_WORK_PARTS,
    Math.floor((Math.max(0, energyAvailable) - 100) / 100)
  );
  if (workParts <= 0) {
    return [];
  }

  return [...Array.from({ length: workParts }, () => 'work' as BodyPartConstant), 'carry', 'move'];
}

export function selectRemoteHarvesterAssignment(homeRoom: string): RemoteSourceAssignment | null {
  return (
    getRemoteSourceAssignments(homeRoom).find(
      (assignment) => countRemoteHarvestersForSource(assignment) < MAX_REMOTE_HARVESTERS_PER_SOURCE
    ) ?? null
  );
}

export function getRemoteSourceAssignments(homeRoom: string): RemoteSourceAssignment[] {
  if (!isNonEmptyString(homeRoom)) {
    return [];
  }

  const records = getRemoteBootstrapRecords(homeRoom);
  const assignments: RemoteSourceAssignment[] = [];
  for (const record of records) {
    if (
      record.roomName === homeRoom ||
      !isAdjacentRoomOrUnknown(homeRoom, record.roomName) ||
      isRemoteOperationSuspended(homeRoom, record.roomName)
    ) {
      continue;
    }

    const room = getVisibleRoom(record.roomName);
    if (!isUsableRemoteRoom(room)) {
      continue;
    }

    assignments.push(...getRemoteSourceAssignmentsInRoom(homeRoom, room));
  }

  return assignments.sort(compareRemoteSourceAssignments);
}

export function isRemoteOperationSuspended(homeRoom: string, targetRoom: string): boolean {
  if (isKnownDeadZoneRoom(targetRoom)) {
    return true;
  }

  if (hasHostileSuspendedTerritoryIntent(homeRoom, targetRoom)) {
    return true;
  }

  return hasSafeRouteAvoidingDeadZones(homeRoom, targetRoom) === false;
}

export function runRemoteHarvester(creep: Creep): void {
  const assignment = normalizeRemoteHarvesterMemory(creep.memory?.remoteHarvester);
  if (!assignment) {
    return;
  }

  if (isRemoteOperationSuspended(assignment.homeRoom, assignment.targetRoom)) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.homeRoom);
    return;
  }

  if (creep.room?.name !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.targetRoom, getAssignedContainer(assignment) ?? getAssignedSource(assignment));
    return;
  }

  const source = getAssignedSource(assignment);
  const container = getAssignedContainer(assignment);
  if (!source) {
    if (container) {
      moveTo(creep, container);
    }
    return;
  }

  if (!isInRangeTo(creep, source, 1)) {
    moveTo(creep, container ?? source);
    return;
  }

  if (isSourceDepleted(source)) {
    if (container && getCarriedEnergy(creep) > 0) {
      transferToContainer(creep, container);
    }
    return;
  }

  if (container && getFreeEnergyCapacity(creep) <= 0 && getCarriedEnergy(creep) > 0) {
    transferToContainer(creep, container);
    return;
  }

  const result = creep.harvest?.(source);
  if (
    container &&
    (result === getErrFullCode() || result === getErrNotEnoughResourcesCode()) &&
    getCarriedEnergy(creep) > 0
  ) {
    transferToContainer(creep, container);
  }
}

export function moveTowardRoom(creep: Creep, roomName: string, target?: RoomObject | RoomPosition | null): void {
  if (target) {
    moveTo(creep, target);
    return;
  }

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

function getRemoteSourceAssignmentsInRoom(homeRoom: string, room: Room): RemoteSourceAssignment[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return (room.find(FIND_SOURCES) as Source[])
    .map((source) => {
      const container = findSourceContainer(room, source);
      return container
        ? {
            homeRoom,
            targetRoom: room.name,
            sourceId: source.id,
            containerId: container.id,
            containerEnergy: getStoredEnergy(container)
          }
        : null;
    })
    .filter((assignment): assignment is RemoteSourceAssignment => assignment !== null);
}

function getRemoteBootstrapRecords(homeRoom: string): TerritoryPostClaimBootstrapMemory[] {
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isRecord(records)) {
    return [];
  }

  return Object.values(records)
    .filter((record): record is TerritoryPostClaimBootstrapMemory => isRemoteBootstrapRecord(record, homeRoom))
    .sort(compareRemoteBootstrapRecords);
}

function isRemoteBootstrapRecord(record: unknown, homeRoom: string): record is TerritoryPostClaimBootstrapMemory {
  return (
    isRecord(record) &&
    record.colony === homeRoom &&
    isNonEmptyString(record.roomName) &&
    record.roomName !== homeRoom &&
    (record.status === 'detected' ||
      record.status === 'spawnSitePending' ||
      record.status === 'spawnSiteBlocked' ||
      record.status === 'spawningWorkers' ||
      record.status === 'ready')
  );
}

function compareRemoteBootstrapRecords(
  left: TerritoryPostClaimBootstrapMemory,
  right: TerritoryPostClaimBootstrapMemory
): number {
  return left.claimedAt - right.claimedAt || left.roomName.localeCompare(right.roomName);
}

function compareRemoteSourceAssignments(left: RemoteSourceAssignment, right: RemoteSourceAssignment): number {
  return left.targetRoom.localeCompare(right.targetRoom) || String(left.sourceId).localeCompare(String(right.sourceId));
}

function isUsableRemoteRoom(room: Room | undefined): room is Room {
  return room?.controller?.my === true && typeof room.find === 'function';
}

function countRemoteHarvestersForSource(assignment: RemoteSourceAssignment): number {
  return getGameCreeps().filter(
    (creep) =>
      creep.memory?.role === REMOTE_HARVESTER_ROLE &&
      canSatisfyRemoteCreepCapacity(creep) &&
      creep.memory.remoteHarvester?.homeRoom === assignment.homeRoom &&
      creep.memory.remoteHarvester?.targetRoom === assignment.targetRoom &&
      String(creep.memory.remoteHarvester?.sourceId) === String(assignment.sourceId)
  ).length;
}

function canSatisfyRemoteCreepCapacity(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > REMOTE_CREEP_REPLACEMENT_TICKS;
}

function hasHostileSuspendedTerritoryIntent(homeRoom: string, targetRoom: string): boolean {
  const intents = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.intents;
  if (!Array.isArray(intents)) {
    return false;
  }

  return intents.some(
    (intent) =>
      isRecord(intent) &&
      intent.colony === homeRoom &&
      intent.targetRoom === targetRoom &&
      intent.suspended !== undefined &&
      isRecord(intent.suspended) &&
      intent.suspended.reason === 'hostile_presence'
  );
}

function normalizeRemoteHarvesterMemory(value: unknown): CreepRemoteHarvesterMemory | null {
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

function getAssignedSource(assignment: CreepRemoteHarvesterMemory): Source | null {
  const source = getObjectById<Source>(assignment.sourceId);
  if (source) {
    return source;
  }

  const room = getVisibleRoom(assignment.targetRoom);
  if (!room || typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return null;
  }

  return (
    (room.find(FIND_SOURCES) as Source[]).find((candidate) => String(candidate.id) === String(assignment.sourceId)) ??
    null
  );
}

function getAssignedContainer(assignment: CreepRemoteHarvesterMemory): StructureContainer | null {
  return getObjectById<StructureContainer>(assignment.containerId);
}

function transferToContainer(creep: Creep, container: StructureContainer): void {
  const result = creep.transfer?.(container, getEnergyResource());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, container);
  }
}

function moveTo(creep: Creep, target: RoomObject | RoomPosition): void {
  creep.moveTo?.(target, REMOTE_MOVE_OPTS);
}

function isInRangeTo(creep: Creep, target: RoomObject, range: number): boolean {
  const actualRange = creep.pos?.getRangeTo?.(target);
  return typeof actualRange !== 'number' || actualRange <= range;
}

function isSourceDepleted(source: Source): boolean {
  return typeof source.energy === 'number' && source.energy <= 0;
}

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
}

function getFreeEnergyCapacity(creep: Creep): number {
  const freeCapacity = creep.store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null; [resource: string]: unknown } })
    .store;
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

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return creeps ? Object.values(creeps) : [];
}

function isAdjacentRoomOrUnknown(homeRoom: string, targetRoom: string): boolean {
  const home = parseRoomCoordinates(homeRoom);
  const target = parseRoomCoordinates(targetRoom);
  if (!home || !target) {
    return true;
  }

  const distance = Math.max(Math.abs(home.x - target.x), Math.abs(home.y - target.y));
  return distance === 1;
}

function parseRoomCoordinates(roomName: string): { x: number; y: number } | null {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) {
    return null;
  }

  const horizontalValue = Number(match[2]);
  const verticalValue = Number(match[4]);
  if (!Number.isFinite(horizontalValue) || !Number.isFinite(verticalValue)) {
    return null;
  }

  return {
    x: match[1] === 'E' ? horizontalValue : -horizontalValue - 1,
    y: match[3] === 'S' ? verticalValue : -verticalValue - 1
  };
}

function getErrFullCode(): ScreepsReturnCode {
  return (globalThis as { ERR_FULL?: ScreepsReturnCode }).ERR_FULL ?? ERR_FULL_CODE;
}

function getErrNotEnoughResourcesCode(): ScreepsReturnCode {
  return (globalThis as { ERR_NOT_ENOUGH_RESOURCES?: ScreepsReturnCode }).ERR_NOT_ENOUGH_RESOURCES ?? ERR_NOT_ENOUGH_RESOURCES_CODE;
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
