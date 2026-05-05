import type { SpawnRequest } from '../spawn/spawnPlanner';
import {
  getRoomStoredEnergyState,
  getStorageBalanceState
} from './storageBalancer';

export const CROSS_ROOM_HAULER_ROLE = 'crossRoomHauler';
export type SpawnPlan = SpawnRequest;

const CARRY_MOVE_PAIR_COST = 100;
const CARRY_CAPACITY_PER_PART = 50;
const MAX_CARRY_MOVE_PAIRS = 25;
const MIN_CARRY_MOVE_PAIRS = 1;
const CROSS_ROOM_HAULER_REPLACEMENT_TICKS = 100;
const CROSS_ROOM_MOVE_OPTS: MoveToOpts = { reusePath: 20, ignoreRoads: false };
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

type DeliveryTarget =
  | StructureSpawn
  | StructureExtension
  | StructureContainer
  | StructureStorage
  | StructureTerminal;
type EnergySourceStructure = StructureStorage | StructureTerminal;
type LogisticsStructureGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL';

interface LogisticsRoute {
  distance: number;
  rooms: string[];
}

export function planCrossRoomHauler(): SpawnPlan | null {
  const transfer = selectCrossRoomEnergyTransfer();
  if (!transfer) {
    return null;
  }

  const sourceRoom = getVisibleRoom(transfer.sourceRoom);
  const targetRoom = getVisibleRoom(transfer.targetRoom);
  if (!sourceRoom || !targetRoom) {
    return null;
  }

  const source = selectSourceEnergyStructure(sourceRoom);
  if (!source) {
    return null;
  }

  const spawn = selectSourceRoomSpawn(sourceRoom.name);
  if (!spawn) {
    return null;
  }

  const sourceState = getRoomStoredEnergyState(sourceRoom);
  const transferableEnergy = Math.min(transfer.amount, sourceState.exportableEnergy);
  const body = buildCrossRoomHaulerBody(sourceRoom.energyAvailable, transferableEnergy);
  if (body.length === 0) {
    return null;
  }

  const route = findOwnedLogisticsRoute(sourceRoom.name, targetRoom.name);
  if (!route) {
    return null;
  }

  return {
    spawn,
    body,
    name: `crossRoomHauler-${sourceRoom.name}-${targetRoom.name}-${getGameTime()}`,
    memory: {
      role: CROSS_ROOM_HAULER_ROLE,
      colony: sourceRoom.name,
      crossRoomHauler: {
        homeRoom: sourceRoom.name,
        targetRoom: targetRoom.name,
        sourceId: source.id as Id<AnyStoreStructure>,
        state: 'collecting',
        route: route.rooms
      }
    }
  };
}

export function buildCrossRoomHaulerBody(
  energyAvailable: number,
  transferableEnergy: number
): BodyPartConstant[] {
  const energyBudget = Math.max(0, Math.floor(energyAvailable));
  const energyScaledPairs = Math.ceil(Math.max(0, transferableEnergy) / CARRY_CAPACITY_PER_PART);
  const affordablePairs = Math.floor(energyBudget / CARRY_MOVE_PAIR_COST);
  const pairCount = Math.min(
    MAX_CARRY_MOVE_PAIRS,
    affordablePairs,
    Math.max(MIN_CARRY_MOVE_PAIRS, energyScaledPairs)
  );
  if (pairCount <= 0) {
    return [];
  }

  return Array.from({ length: pairCount }).flatMap(() => ['carry', 'move'] as BodyPartConstant[]);
}

export function runCrossRoomHauler(creep: Creep): void {
  const assignment = getMutableCrossRoomHaulerMemory(creep);
  if (!assignment) {
    return;
  }

  if (assignment.state === 'returning' && !isSourceUnassigned(assignment)) {
    returnHome(creep, assignment);
    return;
  }

  if (getCarriedEnergy(creep) > 0) {
    assignment.state = 'delivering';
    deliverEnergy(creep, assignment);
    return;
  }

  if (isSourceUnassigned(assignment) && !recoverSourceAssignment(creep, assignment)) {
    return;
  }

  if (assignment.state === 'returning') {
    returnHome(creep, assignment);
    return;
  }

  if (!hasSourceSurplusEnergy(assignment)) {
    assignment.state = 'returning';
    returnHome(creep, assignment);
    return;
  }

  assignment.state = 'collecting';
  collectEnergy(creep, assignment);
}

function selectCrossRoomEnergyTransfer(): EconomyStorageTransferMemory | null {
  const balance = getStorageBalanceState();
  return (
    balance.transfers
      .filter((transfer) => transfer.amount > 0)
      .filter((transfer) => !hasActiveCrossRoomHauler(transfer))
      .filter((transfer) => isLiveTransferCandidate(transfer))
      .sort(compareTransfers)[0] ?? null
  );
}

export function isLiveTransferCandidate(transfer: EconomyStorageTransferMemory): boolean {
  const sourceRoom = getVisibleRoom(transfer.sourceRoom);
  const targetRoom = getVisibleRoom(transfer.targetRoom);
  if (!sourceRoom || !targetRoom) {
    return false;
  }

  if (!isSafeOwnedRoom(sourceRoom.name) || !isSafeOwnedRoom(targetRoom.name)) {
    return false;
  }

  const sourceState = getRoomStoredEnergyState(sourceRoom);
  const targetState = getRoomStoredEnergyState(targetRoom);
  if (sourceState.mode !== 'export' || targetState.mode !== 'import') {
    return false;
  }

  return findOwnedLogisticsRoute(sourceRoom.name, targetRoom.name) !== null;
}

function compareTransfers(
  left: EconomyStorageTransferMemory,
  right: EconomyStorageTransferMemory
): number {
  const leftRouteDistance = findOwnedLogisticsRoute(left.sourceRoom, left.targetRoom)?.distance ?? Number.POSITIVE_INFINITY;
  const rightRouteDistance = findOwnedLogisticsRoute(right.sourceRoom, right.targetRoom)?.distance ?? Number.POSITIVE_INFINITY;
  return (
    right.amount - left.amount ||
    leftRouteDistance - rightRouteDistance ||
    left.sourceRoom.localeCompare(right.sourceRoom) ||
    left.targetRoom.localeCompare(right.targetRoom)
  );
}

function hasActiveCrossRoomHauler(transfer: EconomyStorageTransferMemory): boolean {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return false;
  }

  return Object.values(creeps).some((creep) => {
    const memory = normalizeCrossRoomHaulerMemory(creep.memory?.crossRoomHauler);
    return (
      creep.memory?.role === CROSS_ROOM_HAULER_ROLE &&
      memory?.homeRoom === transfer.sourceRoom &&
      memory.targetRoom === transfer.targetRoom &&
      (creep.ticksToLive === undefined || creep.ticksToLive > CROSS_ROOM_HAULER_REPLACEMENT_TICKS)
    );
  });
}

function collectEnergy(creep: Creep, assignment: CreepCrossRoomHaulerMemory): void {
  if (creep.room?.name !== assignment.homeRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment, assignment.homeRoom);
    return;
  }

  let source = getAssignedSource(assignment);
  if (!source || getStoredEnergy(source) <= 0) {
    source = selectReplacementSource(assignment, creep.room);
  }

  if (!source) {
    delete creep.memory.task;
    markSourceUnassigned(assignment);
    return;
  }

  const sourceId = assignment.sourceId;
  if (!sourceId) {
    markSourceUnassigned(assignment);
    return;
  }

  const task: Extract<CreepTaskMemory, { type: 'withdraw' }> = {
    type: 'withdraw',
    targetId: sourceId
  };
  creep.memory.task = task;
  const result = creep.withdraw?.(source, getEnergyResource());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, source);
  }
}

function deliverEnergy(creep: Creep, assignment: CreepCrossRoomHaulerMemory): void {
  if (creep.room?.name !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment, assignment.targetRoom);
    return;
  }

  const target = selectDeliveryTarget(creep.room);
  if (!target) {
    delete creep.memory.task;
    assignment.state = 'returning';
    returnHome(creep, assignment);
    return;
  }

  const task: Extract<CreepTaskMemory, { type: 'transfer' }> = {
    type: 'transfer',
    targetId: target.id as Id<AnyStoreStructure>
  };
  creep.memory.task = task;
  const result = creep.transfer?.(target, getEnergyResource());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, target);
  }
}

function returnHome(creep: Creep, assignment: CreepCrossRoomHaulerMemory): void {
  if (creep.room?.name !== assignment.homeRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment, assignment.homeRoom);
    return;
  }

  const carriedEnergy = getCarriedEnergy(creep);
  if (carriedEnergy > 0) {
    const homeTarget = selectHomeReturnTarget(creep.room);
    if (homeTarget) {
      const result = creep.transfer?.(homeTarget, getEnergyResource());
      if (result === getErrNotInRangeCode()) {
        moveTo(creep, homeTarget);
      }
      return;
    }
  }

  delete creep.memory.task;
  if (hasSourceSurplusEnergy(assignment)) {
    assignment.state = 'collecting';
    return;
  }

  assignment.state = isSourceUnassigned(assignment) ? 'unassigned' : 'returning';
}

function selectDeliveryTarget(room: Room): DeliveryTarget | null {
  const targets = [
    ...findOwnedStructures(room).filter(isSpawnOrExtensionWithDemand),
    ...findRoomStructures(room).filter(isContainerWithDemand),
    ...[room.storage, room.terminal].filter(isStorageOrTerminalWithDemand)
  ].sort(compareDeliveryTargets);

  return targets[0] ?? null;
}

function selectHomeReturnTarget(room: Room): EnergySourceStructure | null {
  const targets = [room.storage, room.terminal].filter(
    (structure): structure is EnergySourceStructure =>
      structure !== undefined && getFreeEnergyCapacity(structure) > 0
  );

  return targets.sort((left, right) => getObjectId(left).localeCompare(getObjectId(right)))[0] ?? null;
}

function isSpawnOrExtensionWithDemand(structure: AnyOwnedStructure): structure is StructureSpawn | StructureExtension {
  return (
    (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')) &&
    getFreeEnergyCapacity(structure) > 0
  );
}

function isContainerWithDemand(structure: Structure): structure is StructureContainer {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') &&
    getFreeEnergyCapacity(structure) > 0
  );
}

function isStorageOrTerminalWithDemand(structure: StructureStorage | StructureTerminal | undefined): structure is EnergySourceStructure {
  return structure !== undefined && getFreeEnergyCapacity(structure) > 0;
}

function compareDeliveryTargets(left: DeliveryTarget, right: DeliveryTarget): number {
  return getDeliveryPriority(right) - getDeliveryPriority(left) || getObjectId(left).localeCompare(getObjectId(right));
}

function getDeliveryPriority(target: DeliveryTarget): number {
  if (matchesStructureType(target.structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return 3;
  }

  if (matchesStructureType(target.structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return 2;
  }

  if (matchesStructureType(target.structureType, 'STRUCTURE_STORAGE', 'storage')) {
    return 0;
  }

  if (matchesStructureType(target.structureType, 'STRUCTURE_TERMINAL', 'terminal')) {
    return -1;
  }

  return 1;
}

function selectSourceEnergyStructure(room: Room): EnergySourceStructure | null {
  return [room.storage, room.terminal]
    .filter(
      (structure): structure is EnergySourceStructure =>
        structure !== undefined && getStoredEnergy(structure) > 0
    )
    .sort((left, right) => getStoredEnergy(right) - getStoredEnergy(left) || getObjectId(left).localeCompare(getObjectId(right)))[0] ?? null;
}

function hasSourceSurplusEnergy(assignment: CreepCrossRoomHaulerMemory): boolean {
  const room = getVisibleRoom(assignment.homeRoom);
  if (!room) {
    return false;
  }

  let source = getAssignedSource(assignment);
  if (!source || getStoredEnergy(source) <= 0) {
    source = selectReplacementSource(assignment, room);
  }

  return getRoomStoredEnergyState(room).mode === 'export' && source !== null && getStoredEnergy(source) > 0;
}

function recoverSourceAssignment(creep: Creep, assignment: CreepCrossRoomHaulerMemory): boolean {
  const homeRoom = getVisibleRoom(assignment.homeRoom);
  const source = homeRoom ? selectReplacementSource(assignment, homeRoom) : null;
  if (source) {
    assignment.state = 'collecting';
    return true;
  }

  delete creep.memory.task;
  markSourceUnassigned(assignment);
  if (creep.room?.name !== assignment.homeRoom) {
    moveTowardRoom(creep, assignment, assignment.homeRoom);
  }
  return false;
}

function selectReplacementSource(
  assignment: CreepCrossRoomHaulerMemory,
  room: Room
): EnergySourceStructure | null {
  const source = selectSourceEnergyStructure(room);
  if (!source) {
    markSourceUnassigned(assignment);
    return null;
  }

  assignment.sourceId = source.id as Id<AnyStoreStructure>;
  return source;
}

function getAssignedSource(assignment: CreepCrossRoomHaulerMemory): EnergySourceStructure | null {
  return assignment.sourceId ? getObjectById<EnergySourceStructure>(assignment.sourceId) : null;
}

function markSourceUnassigned(assignment: CreepCrossRoomHaulerMemory): void {
  assignment.sourceId = null;
  assignment.state = 'unassigned';
}

function isSourceUnassigned(assignment: CreepCrossRoomHaulerMemory): boolean {
  return assignment.state === 'unassigned' || !assignment.sourceId;
}

function selectSourceRoomSpawn(roomName: string): StructureSpawn | null {
  const spawns = (globalThis as { Game?: Partial<Pick<Game, 'spawns'>> }).Game?.spawns;
  if (!spawns) {
    return null;
  }

  return Object.values(spawns)
    .filter((spawn) => spawn.room?.name === roomName && !spawn.spawning)
    .sort((left, right) => getSpawnEnergyScore(right) - getSpawnEnergyScore(left) || left.name.localeCompare(right.name))[0] ?? null;
}

function getSpawnEnergyScore(spawn: StructureSpawn): number {
  const room = spawn.room;
  return typeof room?.energyAvailable === 'number' && Number.isFinite(room.energyAvailable)
    ? room.energyAvailable
    : 0;
}

function findOwnedLogisticsRoute(fromRoom: string, targetRoom: string): LogisticsRoute | null {
  if (fromRoom === targetRoom) {
    return { distance: 0, rooms: [] };
  }

  const gameMap = (globalThis as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map as
    | (Partial<GameMap> & {
        findRoute?: (
          fromRoom: string,
          toRoom: string,
          opts?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
        ) => unknown;
      })
    | undefined;

  if (typeof gameMap?.findRoute !== 'function') {
    return null;
  }

  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName: string) => (isSafeLogisticsTransitRoom(roomName) ? 1 : Infinity)
  });
  if (route === getNoPathResultCode() || !Array.isArray(route)) {
    return null;
  }

  const rooms = route
    .map((step) => (isRecord(step) && typeof step.room === 'string' ? step.room : null))
    .filter((roomName): roomName is string => typeof roomName === 'string');
  if (rooms.length !== route.length || !rooms.every(isSafeLogisticsTransitRoom)) {
    return null;
  }

  return { distance: rooms.length, rooms };
}

function moveTowardRoom(
  creep: Creep,
  assignment: CreepCrossRoomHaulerMemory,
  destinationRoom: string
): void {
  const route = getAssignmentRoute(assignment);
  const nextRoom = route ? selectNextRouteRoom(creep.room?.name, assignment, destinationRoom, route) : destinationRoom;
  const visibleController = getVisibleRoom(nextRoom)?.controller;
  if (visibleController) {
    moveTo(creep, visibleController);
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: new (x: number, y: number, roomName: string) => RoomPosition })
    .RoomPosition;
  if (typeof RoomPositionCtor === 'function') {
    moveTo(creep, new RoomPositionCtor(25, 25, nextRoom));
  }
}

function getAssignmentRoute(assignment: CreepCrossRoomHaulerMemory): string[] | null {
  const route = findOwnedLogisticsRoute(assignment.homeRoom, assignment.targetRoom);
  if (!route) {
    return Array.isArray(assignment.route) ? assignment.route.filter(isNonEmptyString) : null;
  }

  assignment.route = route.rooms;
  return route.rooms;
}

function selectNextRouteRoom(
  currentRoom: string | undefined,
  assignment: CreepCrossRoomHaulerMemory,
  destinationRoom: string,
  route: string[]
): string {
  if (!currentRoom) {
    return destinationRoom;
  }

  if (destinationRoom === assignment.targetRoom) {
    if (currentRoom === assignment.homeRoom) {
      return route[0] ?? assignment.targetRoom;
    }

    const routeIndex = route.indexOf(currentRoom);
    return routeIndex >= 0 ? route[routeIndex + 1] ?? assignment.targetRoom : destinationRoom;
  }

  const routeIndex = route.indexOf(currentRoom);
  if (routeIndex > 0) {
    return route[routeIndex - 1] ?? assignment.homeRoom;
  }

  return assignment.homeRoom;
}

function isSafeOwnedRoom(roomName: string): boolean {
  const room = getVisibleRoom(roomName);
  return room?.controller?.my === true && !hasHostilePresence(room);
}

function isSafeLogisticsTransitRoom(roomName: string): boolean {
  const room = getVisibleRoom(roomName);
  if (!room) {
    return true;
  }

  if (hasHostilePresence(room)) {
    return false;
  }

  return room.controller?.owner === undefined || room.controller.my === true;
}

function hasHostilePresence(room: Room): boolean {
  const hostileCreepFind = getGlobalNumber('FIND_HOSTILE_CREEPS');
  if (typeof hostileCreepFind === 'number' && typeof room.find === 'function') {
    const hostiles = room.find(hostileCreepFind as FindConstant);
    if (Array.isArray(hostiles) && hostiles.length > 0) {
      return true;
    }
  }

  const hostileStructureFind = getGlobalNumber('FIND_HOSTILE_STRUCTURES');
  if (typeof hostileStructureFind === 'number' && typeof room.find === 'function') {
    const hostiles = room.find(hostileStructureFind as FindConstant);
    if (Array.isArray(hostiles) && hostiles.length > 0) {
      return true;
    }
  }

  return false;
}

function findOwnedStructures(room: Room): AnyOwnedStructure[] {
  const findMyStructures = getGlobalNumber('FIND_MY_STRUCTURES');
  if (typeof findMyStructures !== 'number' || typeof room.find !== 'function') {
    return Object.values((globalThis as { Game?: Partial<Pick<Game, 'spawns'>> }).Game?.spawns ?? {}).filter(
      (spawn) => spawn.room?.name === room.name
    ) as AnyOwnedStructure[];
  }

  const structures = room.find(findMyStructures as FindConstant);
  return Array.isArray(structures) ? (structures as AnyOwnedStructure[]) : [];
}

function findRoomStructures(room: Room): Structure[] {
  const findStructures = getGlobalNumber('FIND_STRUCTURES');
  if (typeof findStructures !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const structures = room.find(findStructures as FindConstant);
  return Array.isArray(structures) ? (structures as Structure[]) : [];
}

function normalizeCrossRoomHaulerMemory(value: unknown): CreepCrossRoomHaulerMemory | null {
  if (!isRecord(value)) {
    return null;
  }

  if (!isNonEmptyString(value.homeRoom) || !isNonEmptyString(value.targetRoom)) {
    return null;
  }

  const sourceId = isNonEmptyString(value.sourceId)
    ? (value.sourceId as Id<AnyStoreStructure>)
    : null;
  const state =
    value.state === 'collecting' ||
    value.state === 'delivering' ||
    value.state === 'returning' ||
    value.state === 'unassigned'
      ? value.state
      : undefined;

  return {
    homeRoom: value.homeRoom,
    targetRoom: value.targetRoom,
    sourceId,
    ...(state
      ? { state: sourceId ? state : 'unassigned' }
      : sourceId
        ? {}
        : { state: 'unassigned' }),
    ...(Array.isArray(value.route) ? { route: value.route.filter(isNonEmptyString) } : {})
  };
}

function getMutableCrossRoomHaulerMemory(creep: Creep): CreepCrossRoomHaulerMemory | null {
  const normalized = normalizeCrossRoomHaulerMemory(creep.memory?.crossRoomHauler);
  if (!normalized) {
    return null;
  }

  creep.memory.crossRoomHauler = normalized;
  return creep.memory.crossRoomHauler;
}

function moveTo(creep: Creep, target: RoomObject | RoomPosition): void {
  creep.moveTo?.(target, CROSS_ROOM_MOVE_OPTS);
}

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null; [resource: string]: unknown } } | null)
    ?.store;
  const resource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(resource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const directEnergy = store?.[resource];
  return typeof directEnergy === 'number' && Number.isFinite(directEnergy) ? Math.max(0, directEnergy) : 0;
}

function getFreeEnergyCapacity(target: unknown): number {
  const store = (target as { store?: { getFreeCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store;
  const freeCapacity = store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
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

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function getErrNotInRangeCode(): ScreepsReturnCode {
  return (globalThis as { ERR_NOT_IN_RANGE?: ScreepsReturnCode }).ERR_NOT_IN_RANGE ?? ERR_NOT_IN_RANGE_CODE;
}

function getNoPathResultCode(): ScreepsReturnCode {
  return (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH ?? ERR_NO_PATH_CODE;
}

function getObjectId(object: unknown): string {
  if (!isRecord(object)) {
    return '';
  }

  return typeof object.id === 'string'
    ? object.id
    : typeof object.name === 'string'
      ? object.name
      : '';
}

function matchesStructureType(
  actual: string | undefined,
  globalName: LogisticsStructureGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<LogisticsStructureGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
