import { hasSafeRouteAvoidingDeadZones, isKnownDeadZoneRoom } from '../defense/deadZone';
import {
  buildCriticalRoadLogisticsContext,
  isCriticalRoadLogisticsWork
} from '../construction/criticalRoads';
import { findSourceContainer } from '../economy/sourceContainers';
import { buildRemoteHarvesterBody } from '../spawn/bodyBuilder';

export const REMOTE_HARVESTER_ROLE = 'remoteHarvester';
export const REMOTE_CREEP_REPLACEMENT_TICKS = 100;

const MAX_REMOTE_HARVESTERS_PER_SOURCE = 1;
const REMOTE_MOVE_OPTS: MoveToOpts = { reusePath: 20, ignoreRoads: false };
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const DEFAULT_REMOTE_ROOM_DISTANCE = 1;
const CRITICAL_ROAD_MOVE_COST = 1;

export interface RemoteSourceAssignment {
  homeRoom: string;
  targetRoom: string;
  sourceId: Id<Source>;
  containerId?: Id<StructureContainer>;
  containerEnergy: number;
  routeDistance: number;
}

export interface RemoteContainerAssignment extends RemoteSourceAssignment {
  containerId: Id<StructureContainer>;
}

export { buildRemoteHarvesterBody };

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

  if (shouldRetreatFromRemote(creep, assignment)) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.homeRoom, undefined, assignment);
    return;
  }

  if (creep.room?.name !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom(
      creep,
      assignment.targetRoom,
      getAssignedContainer(assignment) ?? getAssignedSource(assignment),
      assignment
    );
    return;
  }

  const source = getAssignedSource(assignment);
  const container = getAssignedContainer(assignment);
  if (!container) {
    delete creep.memory.task;
    if (getCarriedEnergy(creep) > 0) {
      creep.drop?.(getEnergyResource());
      return;
    }
  }

  if (!source) {
    if (container) {
      moveTo(creep, container, assignment);
    }
    return;
  }

  if (!isInRangeTo(creep, source, 1)) {
    moveTo(creep, container ?? source, assignment);
    return;
  }

  if (isSourceDepleted(source)) {
    if (container && getCarriedEnergy(creep) > 0) {
      transferToContainer(creep, container, assignment);
    }
    return;
  }

  if (container && getFreeEnergyCapacity(creep) <= 0 && getCarriedEnergy(creep) > 0) {
    transferToContainer(creep, container, assignment);
    return;
  }

  const result = creep.harvest?.(source);
  if (
    container &&
    (result === getErrFullCode() || result === getErrNotEnoughResourcesCode()) &&
    getCarriedEnergy(creep) > 0
  ) {
    transferToContainer(creep, container, assignment);
  }
}

export function moveTowardRoom(
  creep: Creep,
  roomName: string,
  target?: RoomObject | RoomPosition | null,
  assignment?: CreepRemoteHarvesterMemory | CreepRemoteHaulerMemory
): void {
  if (target) {
    moveTo(creep, target, assignment);
    return;
  }

  const visibleController = getVisibleRoom(roomName)?.controller;
  if (visibleController) {
    moveTo(creep, visibleController, assignment);
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: new (x: number, y: number, roomName: string) => RoomPosition })
    .RoomPosition;
  if (typeof RoomPositionCtor === 'function') {
    moveTo(creep, new RoomPositionCtor(25, 25, roomName), assignment);
  }
}

export function shouldRetreatFromRemote(
  creep: Creep,
  assignment: CreepRemoteHarvesterMemory | CreepRemoteHaulerMemory
): boolean {
  if (isRemoteOperationSuspended(assignment.homeRoom, assignment.targetRoom)) {
    return true;
  }

  const targetRoom = getVisibleRoom(assignment.targetRoom);
  if (isForeignOwnedRemoteController(targetRoom?.controller)) {
    return true;
  }

  return isVisibleRemoteThreatened(targetRoom, assignment.targetRoom);
}

function getRemoteSourceAssignmentsInRoom(homeRoom: string, room: Room): RemoteSourceAssignment[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return (room.find(FIND_SOURCES) as Source[])
    .map((source) => {
      const container = findSourceContainer(room, source);
      return {
        homeRoom,
        targetRoom: room.name,
        sourceId: source.id,
        ...(container ? { containerId: container.id } : {}),
        containerEnergy: container ? getStoredEnergy(container) : 0,
        routeDistance: estimateRemoteRoomDistance(homeRoom, room.name)
      };
    });
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
  return room != null && !isForeignOwnedRemoteController(room.controller) && typeof room.find === 'function';
}

function isForeignOwnedRemoteController(controller: StructureController | undefined): boolean {
  if (controller?.owner == null) {
    return false;
  }

  return controller.my !== true;
}

function countRemoteHarvestersForSource(assignment: RemoteSourceAssignment): number {
  return getRemoteOperationCreeps(assignment.homeRoom, assignment.targetRoom).filter(
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
    (value.containerId == null || isNonEmptyString(value.containerId))
    ? {
        homeRoom: value.homeRoom,
        targetRoom: value.targetRoom,
        sourceId: value.sourceId as Id<Source>,
        ...(isNonEmptyString(value.containerId) ? { containerId: value.containerId as Id<StructureContainer> } : {})
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
  if (isNonEmptyString(assignment.containerId)) {
    const container = getObjectById<StructureContainer>(assignment.containerId);
    if (container) {
      return container;
    }
  }

  const source = getAssignedSource(assignment);
  const room = getVisibleRoom(assignment.targetRoom);
  return source && room ? findSourceContainer(room, source) : null;
}

function transferToContainer(
  creep: Creep,
  container: StructureContainer,
  assignment: CreepRemoteHarvesterMemory
): void {
  const result = creep.transfer?.(container, getEnergyResource());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, container, assignment);
  }
}

function moveTo(
  creep: Creep,
  target: RoomObject | RoomPosition,
  assignment?: CreepRemoteHarvesterMemory | CreepRemoteHaulerMemory
): void {
  creep.moveTo?.(target, getRemoteMoveOpts(assignment));
}

function getRemoteMoveOpts(
  assignment: CreepRemoteHarvesterMemory | CreepRemoteHaulerMemory | undefined
): MoveToOpts {
  const costCallback = assignment ? buildCriticalRoadMoveCostCallback(assignment) : undefined;
  return costCallback ? { ...REMOTE_MOVE_OPTS, costCallback } : REMOTE_MOVE_OPTS;
}

function buildCriticalRoadMoveCostCallback(
  assignment: CreepRemoteHarvesterMemory | CreepRemoteHaulerMemory
): NonNullable<MoveToOpts['costCallback']> {
  return (roomName, costMatrix) => {
    const room = getVisibleRoom(roomName);
    if (!room || !isRemoteMoveRoom(roomName, assignment)) {
      return costMatrix;
    }

    const context = buildCriticalRoadLogisticsContext(room, { colonyRoomName: assignment.homeRoom });
    for (const target of findCriticalRoadMoveTargets(room)) {
      if (target.pos && isCriticalRoadLogisticsWork(target, context)) {
        costMatrix.set(target.pos.x, target.pos.y, CRITICAL_ROAD_MOVE_COST);
      }
    }

    return costMatrix;
  };
}

function isRemoteMoveRoom(roomName: string, assignment: CreepRemoteHarvesterMemory | CreepRemoteHaulerMemory): boolean {
  return roomName === assignment.homeRoom || roomName === assignment.targetRoom;
}

function findCriticalRoadMoveTargets(room: Room): Array<Structure | ConstructionSite> {
  return [
    ...findRoomObjects<Structure>(room, 'FIND_STRUCTURES'),
    ...findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES')
  ].filter((target) => matchesStructureType(target.structureType, 'STRUCTURE_ROAD', 'road'));
}

function findRoomObjects<T>(room: Room, constantName: 'FIND_STRUCTURES' | 'FIND_CONSTRUCTION_SITES'): T[] {
  const findConstant = (globalThis as unknown as Partial<Record<typeof constantName, number>>)[constantName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function matchesStructureType(
  actual: string | undefined,
  globalName: 'STRUCTURE_ROAD',
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<typeof globalName, string>>;
  return actual === (constants[globalName] ?? fallback);
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

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
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

function getCreepStableKey(creep: Creep): string {
  return creep.name ?? `${creep.memory?.role ?? 'creep'}:${creep.memory?.colony ?? ''}:${creep.ticksToLive ?? ''}`;
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

function estimateRemoteRoomDistance(homeRoom: string, targetRoom: string): number {
  const home = parseRoomCoordinates(homeRoom);
  const target = parseRoomCoordinates(targetRoom);
  if (!home || !target) {
    return DEFAULT_REMOTE_ROOM_DISTANCE;
  }

  return Math.max(DEFAULT_REMOTE_ROOM_DISTANCE, Math.max(Math.abs(home.x - target.x), Math.abs(home.y - target.y)));
}

function isVisibleRemoteThreatened(room: Room | undefined, targetRoom: string): boolean {
  if (room?.name !== targetRoom || typeof FIND_HOSTILE_CREEPS !== 'number' || typeof room.find !== 'function') {
    return false;
  }

  const hostiles = room.find(FIND_HOSTILE_CREEPS) as Creep[];
  return Array.isArray(hostiles) && hostiles.length > 0;
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
