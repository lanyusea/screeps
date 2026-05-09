import type { SpawnRequest } from '../spawn/spawnPlanner';
import { recordCreepBehaviorEnergyAcquisition } from '../telemetry/behaviorTelemetry';
import {
  getRoomEnergyTransferExportLimit,
  getRoomStoredEnergyState,
  getRoomStorageImportPriorityRank,
  getStorageBalanceState
} from './storageBalancer';
import { shouldAllowLocalFirstEnergyImport } from './localEnergyStrategy';
import { findOwnedLogisticsRoute, isSafeOwnedRoom } from './roomLogistics';

export const CROSS_ROOM_HAULER_ROLE = 'crossRoomHauler';
export type SpawnPlan = SpawnRequest;
export type CrossRoomHaulerEnergyBudgetProvider = (sourceRoomName: string) => number;

const CARRY_MOVE_PAIR_COST = 100;
const CARRY_CAPACITY_PER_PART = 50;
const MAX_CARRY_MOVE_PAIRS = 25;
const MIN_CARRY_MOVE_PAIRS = 1;
const CROSS_ROOM_HAULER_REPLACEMENT_TICKS = 100;
const CROSS_ROOM_MOVE_OPTS: MoveToOpts = { reusePath: 20, ignoreRoads: false };
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const DELIVERY_PRIORITY_SPAWN = 4;
const DELIVERY_PRIORITY_EXTENSION = 3;
const DELIVERY_PRIORITY_TOWER = 2;
const DELIVERY_PRIORITY_CONTAINER = 1;
const DELIVERY_PRIORITY_STORAGE = 0;
const DELIVERY_PRIORITY_TERMINAL = -1;

type DeliveryTarget =
  | StructureSpawn
  | StructureExtension
  | StructureTower
  | StructureContainer
  | StructureStorage
  | StructureTerminal;
type EnergySourceStructure = StructureStorage | StructureTerminal;
type LogisticsStructureGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_TOWER'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL';

export function planCrossRoomHauler(
  getEnergyBudget: CrossRoomHaulerEnergyBudgetProvider = getDefaultCrossRoomHaulerEnergyBudget
): SpawnPlan | null {
  const transfer = selectCrossRoomEnergyTransfer();
  if (!transfer) {
    return null;
  }

  const sourceRoom = getVisibleRoom(transfer.sourceRoom);
  const targetRoom = getVisibleRoom(transfer.targetRoom);
  if (!sourceRoom || !targetRoom) {
    return null;
  }

  const spawn = selectSourceRoomSpawn(sourceRoom.name);
  if (!spawn) {
    return null;
  }

  const source = selectSourceEnergyStructure(sourceRoom, spawn);
  if (!source) {
    return null;
  }

  const sourceState = getRoomStoredEnergyState(sourceRoom);
  const targetState = getRoomStoredEnergyState(targetRoom);
  const remainingTransferEnergy = getRemainingCrossRoomTransferEnergy(transfer);
  const transferableEnergy = Math.min(
    remainingTransferEnergy,
    getRoomEnergyTransferExportLimit(sourceState, targetState)
  );
  const body = buildCrossRoomHaulerBody(getEnergyBudget(sourceRoom.name), transferableEnergy);
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

function getDefaultCrossRoomHaulerEnergyBudget(sourceRoomName: string): number {
  return getVisibleRoom(sourceRoomName)?.energyAvailable ?? 0;
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

export function selectCrossRoomEnergyTransfer(): EconomyStorageTransferMemory | null {
  const balance = getStorageBalanceState();
  return (
    balance.transfers
      .filter((transfer) => transfer.amount > 0)
      .filter((transfer) => getRemainingCrossRoomTransferEnergy(transfer) > 0)
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
  if (
    targetState.mode !== 'import' ||
    getRoomEnergyTransferExportLimit(sourceState, targetState) <= 0
  ) {
    return false;
  }

  if (
    !shouldAllowLocalFirstEnergyImport(targetRoom, {
      sourceRoom: sourceRoom.name,
      storedEnergy: targetState.energy
    })
  ) {
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
  const leftRemainingEnergy = getRemainingCrossRoomTransferEnergy(left);
  const rightRemainingEnergy = getRemainingCrossRoomTransferEnergy(right);
  return (
    getRoomStorageImportPriorityRank(left.targetRoom) -
      getRoomStorageImportPriorityRank(right.targetRoom) ||
    getTransferRoundTripEfficiency(rightRemainingEnergy, rightRouteDistance) -
      getTransferRoundTripEfficiency(leftRemainingEnergy, leftRouteDistance) ||
    rightRemainingEnergy - leftRemainingEnergy ||
    leftRouteDistance - rightRouteDistance ||
    left.sourceRoom.localeCompare(right.sourceRoom) ||
    left.targetRoom.localeCompare(right.targetRoom)
  );
}

function getTransferRoundTripEfficiency(remainingEnergy: number, routeDistance: number): number {
  if (!Number.isFinite(routeDistance)) {
    return 0;
  }

  return remainingEnergy / Math.max(1, routeDistance * 2);
}

function getRemainingCrossRoomTransferEnergy(transfer: EconomyStorageTransferMemory): number {
  return Math.max(0, transfer.amount - getReservedCrossRoomTransferEnergy(transfer));
}

function getReservedCrossRoomTransferEnergy(transfer: EconomyStorageTransferMemory): number {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).reduce(
    (total, creep) => total + getCreepCrossRoomTransferReservation(creep, transfer),
    0
  );
}

function getCreepCrossRoomTransferReservation(
  creep: Creep,
  transfer: EconomyStorageTransferMemory
): number {
  if (creep.ticksToLive !== undefined && creep.ticksToLive <= CROSS_ROOM_HAULER_REPLACEMENT_TICKS) {
    return 0;
  }

  return (
    getDedicatedCrossRoomHaulerTransferReservation(creep, transfer) ??
    getWorkerInterRoomTransferReservation(creep, transfer) ??
    0
  );
}

function getDedicatedCrossRoomHaulerTransferReservation(
  creep: Creep,
  transfer: EconomyStorageTransferMemory
): number | null {
  if (creep.memory?.role !== CROSS_ROOM_HAULER_ROLE) {
    return null;
  }

  const memory = normalizeCrossRoomHaulerMemory(creep.memory.crossRoomHauler);
  if (memory?.homeRoom !== transfer.sourceRoom || memory.targetRoom !== transfer.targetRoom) {
    return null;
  }

  if (memory.state === 'returning' || memory.state === 'unassigned') {
    return 0;
  }

  if (memory.state === 'delivering') {
    return getCarriedEnergy(creep);
  }

  return getEnergyCapacity(creep);
}

function getWorkerInterRoomTransferReservation(
  creep: Creep,
  transfer: EconomyStorageTransferMemory
): number | null {
  if (creep.memory?.role !== 'worker') {
    return null;
  }

  const assignment = creep.memory.interRoomEnergyHaul;
  if (
    assignment?.sourceRoom !== transfer.sourceRoom ||
    assignment.targetRoom !== transfer.targetRoom
  ) {
    return null;
  }

  return isWorkerOnInterRoomHaulLeg(creep, assignment)
    ? getEnergyCapacity(creep)
    : getCarriedEnergy(creep);
}

function isWorkerOnInterRoomHaulLeg(
  creep: Creep,
  assignment: CreepInterRoomEnergyHaulMemory
): boolean {
  const task = creep.memory?.task;
  if (task?.type === 'withdraw' && assignment.sourceId) {
    return String(task.targetId) === String(assignment.sourceId);
  }

  if (task?.type === 'transfer' && assignment.targetId) {
    return String(task.targetId) === String(assignment.targetId);
  }

  return false;
}

function collectEnergy(creep: Creep, assignment: CreepCrossRoomHaulerMemory): void {
  if (creep.room?.name !== assignment.homeRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment, assignment.homeRoom);
    return;
  }

  let source = getAssignedSource(assignment);
  if (!source || getStoredEnergy(source) <= 0) {
    source = selectReplacementSource(assignment, creep.room, creep);
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
  if (result === OK_CODE) {
    recordCreepBehaviorEnergyAcquisition(creep, 'withdrawn');
  }
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

  const target = selectDeliveryTarget(creep.room, creep);
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

function selectDeliveryTarget(room: Room, origin?: RoomObject): DeliveryTarget | null {
  const targets = [
    ...findOwnedStructures(room).filter(isSpawnOrExtensionWithDemand),
    ...findOwnedStructures(room).filter(isTowerWithDemand),
    ...findRoomStructures(room).filter(isContainerWithDemand),
    ...[room.storage, room.terminal].filter(isStorageOrTerminalWithDemand)
  ].sort((left, right) => compareDeliveryTargets(left, right, origin));

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

function isTowerWithDemand(structure: AnyOwnedStructure): structure is StructureTower {
  return matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower') && getFreeEnergyCapacity(structure) > 0;
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

function compareDeliveryTargets(left: DeliveryTarget, right: DeliveryTarget, origin?: RoomObject): number {
  return (
    getDeliveryPriority(right) - getDeliveryPriority(left) ||
    getRangeToRoomObject(origin, left) - getRangeToRoomObject(origin, right) ||
    getObjectId(left).localeCompare(getObjectId(right))
  );
}

function getDeliveryPriority(target: DeliveryTarget): number {
  if (matchesStructureType(target.structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return DELIVERY_PRIORITY_SPAWN;
  }

  if (matchesStructureType(target.structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return DELIVERY_PRIORITY_EXTENSION;
  }

  if (matchesStructureType(target.structureType, 'STRUCTURE_TOWER', 'tower')) {
    return DELIVERY_PRIORITY_TOWER;
  }

  if (matchesStructureType(target.structureType, 'STRUCTURE_STORAGE', 'storage')) {
    return DELIVERY_PRIORITY_STORAGE;
  }

  if (matchesStructureType(target.structureType, 'STRUCTURE_TERMINAL', 'terminal')) {
    return DELIVERY_PRIORITY_TERMINAL;
  }

  return DELIVERY_PRIORITY_CONTAINER;
}

function selectSourceEnergyStructure(room: Room, origin?: RoomObject): EnergySourceStructure | null {
  return [room.storage, room.terminal]
    .filter(
      (structure): structure is EnergySourceStructure =>
        structure !== undefined && getStoredEnergy(structure) > 0
    )
    .sort(
      (left, right) =>
        getRangeToRoomObject(origin, left) - getRangeToRoomObject(origin, right) ||
        getStoredEnergy(right) - getStoredEnergy(left) ||
        getObjectId(left).localeCompare(getObjectId(right))
    )[0] ?? null;
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

  const targetRoom = getVisibleRoom(assignment.targetRoom);
  const sourceState = getRoomStoredEnergyState(room);
  const targetState = targetRoom ? getRoomStoredEnergyState(targetRoom) : null;
  const exportLimit = targetState
    ? getRoomEnergyTransferExportLimit(sourceState, targetState)
    : sourceState.exportableEnergy;

  return exportLimit > 0 && source !== null && getStoredEnergy(source) > 0;
}

function recoverSourceAssignment(creep: Creep, assignment: CreepCrossRoomHaulerMemory): boolean {
  const homeRoom = getVisibleRoom(assignment.homeRoom);
  const source = homeRoom ? selectReplacementSource(assignment, homeRoom, creep) : null;
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
  room: Room,
  origin?: RoomObject
): EnergySourceStructure | null {
  const source = selectSourceEnergyStructure(room, origin);
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

function getEnergyCapacity(target: unknown): number {
  return getStoredEnergy(target) + getFreeEnergyCapacity(target);
}

function getRangeToRoomObject(origin: RoomObject | undefined, target: RoomObject): number {
  const originPosition = origin?.pos;
  const rangeTo = originPosition?.getRangeTo;
  if (typeof rangeTo === 'function') {
    const range = rangeTo.call(originPosition, target);
    if (typeof range === 'number' && Number.isFinite(range)) {
      return Math.max(0, range);
    }
  }

  const targetPosition = target.pos;
  if (!originPosition || !targetPosition || originPosition.roomName !== targetPosition.roomName) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Math.max(
    Math.abs(originPosition.x - targetPosition.x),
    Math.abs(originPosition.y - targetPosition.y)
  );
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
