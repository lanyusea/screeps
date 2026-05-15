import {
  shouldSignOwnedRoomController,
  signOccupiedControllerIfNeeded
} from '../territory/controllerSigning';
import { getStorageEnergyAvailableForWithdrawal } from '../economy/energyBuffer';
import { isControllerStagingContainer } from '../economy/stagingContainers';
import { WORKER_REPLACEMENT_TICKS_TO_LIVE } from './roleCounts';

export type ControllerUpgradePriority =
  | 'none'
  | 'downgradeGuard'
  | 'rcl1Rush'
  | 'rclProgress'
  | 'energySurplus'
  | 'steady'
  | 'fallback';

export interface ControllerUpgradePriorityContext {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  competingSpawnDemand?: boolean;
  constructionDemand?: boolean;
  defenseDemand?: boolean;
  energyBufferHealthy?: boolean;
  hasEnergySurplus?: boolean;
  enableSteadyUpgrade?: boolean;
}

export const UPGRADER_ROLE = 'upgrader';
export const CONTROLLER_UPGRADE_PROGRESS_PRESSURE_RATIO = 0.85;
export const CONTROLLER_UPGRADE_DOWNGRADE_GUARD_TICKS = 5_000;

const MAX_CONTROLLER_LEVEL = 8;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const CONTROLLER_UPGRADE_MOVE_RANGE = 3;
const MIN_DROPPED_UPGRADER_ENERGY = 25;

export function runUpgrader(creep: Creep, controller: StructureController): ScreepsReturnCode {
  if (shouldSignOwnedRoomController(getControllerSigningRoom(creep, controller), controller)) {
    signOccupiedControllerIfNeeded(creep, controller);
  }
  return creep.upgradeController(controller);
}

function getControllerSigningRoom(creep: Creep, controller: StructureController): Room | undefined {
  return controller.room ?? creep.room;
}

export function runUpgraderCreep(creep: Creep): void {
  if (moveToAssignedControllerRoom(creep)) {
    return;
  }

  const controller = getAssignedController(creep);
  if (!controller) {
    return;
  }

  if (canLevelUpController(controller) && renewExpiringUpgrader(creep)) {
    return;
  }

  const carriedEnergy = getStoredEnergy(creep);
  const upgradeAllowed = shouldSpendUpgraderEnergy(creep, controller);
  if (carriedEnergy > 0) {
    if (!upgradeAllowed) {
      runUpgraderEnergyReturn(creep);
      return;
    }

    const result = runUpgrader(creep, controller);
    if (result === ERR_NOT_IN_RANGE_CODE) {
      creep.moveTo(controller, { range: CONTROLLER_UPGRADE_MOVE_RANGE });
    }
    return;
  }

  if (!upgradeAllowed || getFreeEnergyCapacity(creep) <= 0) {
    return;
  }

  const source = selectUpgraderEnergySource(creep);
  if (!source) {
    return;
  }

  const result = executeUpgraderEnergyAcquisition(creep, source);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    creep.moveTo(source.target as RoomObject);
  }
}

export function getControllerUpgradePriority(
  controller: StructureController | undefined,
  context: ControllerUpgradePriorityContext = {}
): ControllerUpgradePriority {
  if (controller?.my !== true) {
    return 'none';
  }

  if (shouldGuardControllerDowngrade(controller)) {
    return 'downgradeGuard';
  }

  if (!canLevelUpController(controller)) {
    return 'fallback';
  }

  if (
    context.competingSpawnDemand === true ||
    context.defenseDemand === true ||
    !hasHealthyUpgradeEnergy(context)
  ) {
    return 'fallback';
  }

  if (controller.level === 1) {
    return 'rcl1Rush';
  }

  if (isControllerProgressPressure(controller)) {
    return 'rclProgress';
  }

  if (context.hasEnergySurplus === true) {
    return 'energySurplus';
  }

  return context.enableSteadyUpgrade === false ? 'fallback' : 'steady';
}

export function isControllerProgressPressure(controller: StructureController | undefined): boolean {
  if (!canLevelUpController(controller)) {
    return false;
  }

  const progress = controller.progress;
  const progressTotal = controller.progressTotal;
  return (
    typeof progress === 'number' &&
    Number.isFinite(progress) &&
    typeof progressTotal === 'number' &&
    Number.isFinite(progressTotal) &&
    progressTotal > 0 &&
    Math.max(0, progress) / progressTotal >= CONTROLLER_UPGRADE_PROGRESS_PRESSURE_RATIO
  );
}

export function canLevelUpController(controller: StructureController | undefined): controller is StructureController {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level < MAX_CONTROLLER_LEVEL
  );
}

function shouldGuardControllerDowngrade(controller: StructureController): boolean {
  return (
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade <= CONTROLLER_UPGRADE_DOWNGRADE_GUARD_TICKS
  );
}

function renewExpiringUpgrader(creep: Creep): boolean {
  if (
    typeof creep.ticksToLive !== 'number' ||
    creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE
  ) {
    return false;
  }

  const spawn = selectUpgraderRenewSpawn(creep);
  if (!spawn || typeof spawn.renewCreep !== 'function') {
    return false;
  }

  const result = spawn.renewCreep(creep);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    creep.moveTo(spawn);
    return true;
  }

  return result === 0;
}

function selectUpgraderRenewSpawn(creep: Creep): StructureSpawn | null {
  const roomName = creep.memory.controllerUpgrade?.roomName ?? creep.memory.colony ?? creep.room?.name;
  const roomSpawns = findRoomObjects<Structure>(creep.room, 'FIND_MY_STRUCTURES')
    .filter((structure): structure is StructureSpawn =>
      matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') &&
      !(structure as StructureSpawn).spawning
    );
  const gameSpawns = Object.values((globalThis as { Game?: Partial<Pick<Game, 'spawns'>> }).Game?.spawns ?? {})
    .filter((spawn) => spawn.room?.name === roomName && !spawn.spawning);
  const candidates = [...roomSpawns, ...gameSpawns].filter(
    (spawn, index, spawns) => spawns.findIndex((candidate) => getStableId(candidate) === getStableId(spawn)) === index
  );

  return candidates.sort(compareRenewSpawns(creep))[0] ?? null;
}

function compareRenewSpawns(creep: Creep): (left: StructureSpawn, right: StructureSpawn) => number {
  return (left, right) =>
    getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) ||
    getStableId(left).localeCompare(getStableId(right));
}

function moveToAssignedControllerRoom(creep: Creep): boolean {
  const roomName = creep.memory.controllerUpgrade?.roomName ?? creep.memory.colony;
  if (!roomName || creep.room?.name === roomName) {
    return false;
  }

  const visibleController = getVisibleRoomController(roomName);
  if (visibleController) {
    creep.moveTo(visibleController);
    return true;
  }

  const RoomPositionCtor = (
    globalThis as { RoomPosition?: new (x: number, y: number, roomName: string) => RoomPosition }
  ).RoomPosition;
  if (typeof RoomPositionCtor === 'function') {
    creep.moveTo(new RoomPositionCtor(25, 25, roomName));
  }
  return true;
}

function getAssignedController(creep: Creep): StructureController | null {
  const assignedControllerId = creep.memory.controllerUpgrade?.controllerId;
  if (assignedControllerId) {
    const assignedController = getGameObjectById<StructureController>(assignedControllerId);
    if (assignedController?.my === true) {
      return assignedController;
    }
  }

  const controller = creep.room?.controller;
  return controller?.my === true ? controller : null;
}

function shouldSpendUpgraderEnergy(creep: Creep, controller: StructureController): boolean {
  if (shouldGuardControllerDowngrade(controller) || creep.memory.controllerUpgrade?.priority === 'downgradeGuard') {
    return true;
  }

  return (
    canLevelUpController(controller) &&
    !hasVisibleHostileCreeps(creep.room)
  );
}

interface UpgraderEnergySource {
  action: 'harvest' | 'pickup' | 'withdraw';
  target: Source | Resource<ResourceConstant> | AnyStoreStructure;
  energy: number;
  priority: number;
}

function selectUpgraderEnergySource(creep: Creep): UpgraderEnergySource | null {
  const candidates = [
    ...selectDroppedUpgraderEnergySources(creep),
    ...selectStoredUpgraderEnergySources(creep),
    ...selectHarvestUpgraderEnergySources(creep)
  ];

  return candidates.sort(compareUpgraderEnergySources(creep))[0] ?? null;
}

function selectDroppedUpgraderEnergySources(creep: Creep): UpgraderEnergySource[] {
  return findRoomObjects<Resource<ResourceConstant>>(creep.room, 'FIND_DROPPED_RESOURCES')
    .filter(
      (resource) =>
        resource.resourceType === getEnergyResource() &&
        resource.amount >= MIN_DROPPED_UPGRADER_ENERGY
    )
    .map((resource) => ({
      action: 'pickup' as const,
      target: resource,
      energy: resource.amount,
      priority: 0
    }));
}

function selectStoredUpgraderEnergySources(creep: Creep): UpgraderEnergySource[] {
  return findRoomObjects<Structure>(creep.room, 'FIND_STRUCTURES')
    .filter(isUpgraderStoredEnergySource)
    .map((structure) => ({
      action: 'withdraw' as const,
      target: structure,
      energy: getUpgraderWithdrawableEnergy(creep.room, structure),
      priority: getStoredUpgraderEnergySourcePriority(creep.room, structure)
    }))
    .filter((candidate) => candidate.energy > 0);
}

function selectHarvestUpgraderEnergySources(creep: Creep): UpgraderEnergySource[] {
  return findRoomObjects<Source>(creep.room, 'FIND_SOURCES')
    .filter((source) => source.energy === undefined || source.energy > 0)
    .map((source) => ({
      action: 'harvest' as const,
      target: source,
      energy: source.energy ?? 0,
      priority: 4
    }));
}

function executeUpgraderEnergyAcquisition(
  creep: Creep,
  source: UpgraderEnergySource
): ScreepsReturnCode {
  if (source.action === 'pickup') {
    return creep.pickup(source.target as Resource<ResourceConstant>);
  }

  if (source.action === 'harvest') {
    return creep.harvest(source.target as Source);
  }

  return creep.withdraw(source.target as AnyStoreStructure, getEnergyResource());
}

function runUpgraderEnergyReturn(creep: Creep): void {
  const sink = selectUpgraderEnergyReturnSink(creep);
  if (!sink) {
    return;
  }

  const result = creep.transfer(sink, getEnergyResource());
  if (result === ERR_NOT_IN_RANGE_CODE) {
    creep.moveTo(sink);
  }
}

function selectUpgraderEnergyReturnSink(creep: Creep): AnyStoreStructure | null {
  return findRoomObjects<Structure>(creep.room, 'FIND_MY_STRUCTURES')
    .filter(isUpgraderEnergyReturnSink)
    .filter((structure) => getFreeEnergyCapacity(structure) > 0)
    .sort((left, right) =>
      getEnergyReturnSinkPriority(left) - getEnergyReturnSinkPriority(right) ||
      compareRoomObjectsByRangeAndId(creep, left, right)
    )[0] ?? null;
}

function compareUpgraderEnergySources(
  creep: Creep
): (left: UpgraderEnergySource, right: UpgraderEnergySource) => number {
  return (left, right) =>
    left.priority - right.priority ||
    getRangeToRoomObject(creep, left.target) - getRangeToRoomObject(creep, right.target) ||
    right.energy - left.energy ||
    getStableId(left.target).localeCompare(getStableId(right.target));
}

function isUpgraderStoredEnergySource(structure: Structure): structure is AnyStoreStructure {
  const structureType = structure.structureType;
  return (
    (matchesStructureType(structureType, 'STRUCTURE_STORAGE', 'storage') ||
      matchesStructureType(structureType, 'STRUCTURE_CONTAINER', 'container') ||
      matchesStructureType(structureType, 'STRUCTURE_LINK', 'link')) &&
    getStoredEnergy(structure) > 0
  );
}

function getStoredUpgraderEnergySourcePriority(room: Room, structure: AnyStoreStructure): number {
  if (isControllerStagingContainer(room, structure as AnyStructure)) {
    return 0;
  }

  return matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_LINK', 'link')
    ? 1
    : 2;
}

function getUpgraderWithdrawableEnergy(room: Room, structure: AnyStoreStructure): number {
  if (matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage')) {
    return getStorageEnergyAvailableForWithdrawal(room, structure as StructureStorage);
  }

  return getStoredEnergy(structure);
}

function isUpgraderEnergyReturnSink(structure: Structure): structure is AnyStoreStructure {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage')
  );
}

function getEnergyReturnSinkPriority(structure: AnyStoreStructure): number {
  if (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return 0;
  }

  if (matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return 1;
  }

  return 2;
}

function hasVisibleHostileCreeps(room: Room): boolean {
  return findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS').length > 0;
}

function findRoomObjects<T>(room: Room, globalName: string): T[] {
  const findConstant = (globalThis as Record<string, unknown>)[globalName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = (room.find as unknown as (type: number) => unknown[])(findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getVisibleRoomController(roomName: string): StructureController | null {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName]?.controller ?? null;
}

function getGameObjectById<T>(id: string): T | null {
  const getObjectById = (globalThis as { Game?: Partial<Pick<Game, 'getObjectById'>> }).Game?.getObjectById as
    | ((id: string) => T | null)
    | undefined;
  return typeof getObjectById === 'function' ? getObjectById(String(id)) : null;
}

function getStoredEnergy(target: unknown): number {
  const store = (
    target as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null } } | null
  )?.store;
  const usedCapacity = store?.getUsedCapacity?.(getEnergyResource());
  return typeof usedCapacity === 'number' && Number.isFinite(usedCapacity) ? Math.max(0, usedCapacity) : 0;
}

function getFreeEnergyCapacity(target: unknown): number {
  const store = (
    target as { store?: { getFreeCapacity?: (resource?: ResourceConstant) => number | null } } | null
  )?.store;
  const freeCapacity = store?.getFreeCapacity?.(getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getRangeToRoomObject(creep: Creep, target: RoomObject): number {
  const range = creep.pos?.getRangeTo?.(target);
  return typeof range === 'number' ? range : Number.MAX_SAFE_INTEGER;
}

function compareRoomObjectsByRangeAndId(creep: Creep, left: RoomObject, right: RoomObject): number {
  return getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) ||
    getStableId(left).localeCompare(getStableId(right));
}

function getStableId(object: RoomObject): string {
  const id = (object as { id?: unknown }).id;
  if (typeof id === 'string') {
    return id;
  }

  const name = (object as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function matchesStructureType(
  actual: string | undefined,
  globalName: string,
  fallback: string
): boolean {
  return actual === ((globalThis as Record<string, unknown>)[globalName] ?? fallback);
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function hasHealthyUpgradeEnergy(context: ControllerUpgradePriorityContext): boolean {
  return (
    context.energyBufferHealthy === true ||
    context.hasEnergySurplus === true ||
    hasFullRoomSpawnEnergy(context)
  );
}

function hasFullRoomSpawnEnergy(context: ControllerUpgradePriorityContext): boolean {
  const energyAvailable = context.energyAvailable;
  const energyCapacityAvailable = context.energyCapacityAvailable;
  return (
    typeof energyAvailable === 'number' &&
    Number.isFinite(energyAvailable) &&
    typeof energyCapacityAvailable === 'number' &&
    Number.isFinite(energyCapacityAvailable) &&
    energyCapacityAvailable > 0 &&
    energyAvailable >= energyCapacityAvailable
  );
}
