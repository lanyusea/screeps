import { selectRemoteHaulerDeliveryTask } from '../tasks/workerTasks';
import {
  CONTAINER_OVERFLOW_RISK_FILL_RATIO,
  isContainerOverflowRisk
} from '../economy/containerEnergy';
import {
  hasPriorityEnergyHaulingDeliveryDemand,
  selectEnergyHaulingDeliveryTarget,
  selectEnergyHaulingSource
} from '../economy/energyHauling';
import { selectSeasonScoreCollectionTask } from '../season/scoreCollection';
import { recordCreepBehaviorEnergyAcquisition } from '../telemetry/behaviorTelemetry';
import {
  getRemoteSourceAssignments,
  findDroppedEnergyNearSource,
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
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

type RemoteHaulerEnergySource = StructureContainer | StructureStorage | StructureTerminal;
type RemoteHaulerEnergySourceStructureGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL';
type SeasonScoreTarget = RoomObject & _HasId & {
  amount?: number;
  objectType?: string;
  resourceType?: string;
  score?: number;
  scoreType?: string;
  store?: StoreDefinition;
  structureType?: string;
  type?: string;
};
type SeasonScoreCollectorFindConstantGlobal =
  | 'FIND_SCORE_COLLECTOR'
  | 'FIND_SCORE_COLLECTORS'
  | 'FIND_SEASON_SCORE_COLLECTOR'
  | 'FIND_SEASON_SCORE_COLLECTORS';
type SeasonScoreCollectorRoomKey =
  | 'scoreCollector'
  | 'scoreCollectors'
  | 'seasonScoreCollector'
  | 'seasonScoreCollectors';

const SCORE_COLLECTOR_FIND_CONSTANT_GLOBALS: SeasonScoreCollectorFindConstantGlobal[] = [
  'FIND_SCORE_COLLECTOR',
  'FIND_SCORE_COLLECTORS',
  'FIND_SEASON_SCORE_COLLECTOR',
  'FIND_SEASON_SCORE_COLLECTORS'
];
const SCORE_COLLECTOR_FALLBACK_ROOM_KEYS: SeasonScoreCollectorRoomKey[] = [
  'scoreCollector',
  'scoreCollectors',
  'seasonScoreCollector',
  'seasonScoreCollectors'
];

export { buildRemoteHaulerBody };

export function selectRemoteHaulerAssignment(homeRoom: string): RemoteSourceAssignment | null {
  if (!hasRemoteHaulerDeliveryDemand(homeRoom)) {
    return null;
  }

  return (
    getRemoteSourceAssignments(homeRoom)
      .filter((assignment) => assignment.containerEnergy > REMOTE_HAULER_DISPATCH_ENERGY_THRESHOLD)
      .filter((assignment) => countRemoteHaulersForAssignment(assignment) < MAX_REMOTE_HAULERS_PER_CONTAINER)
      .sort(compareRemoteHaulerAssignments)[0] ?? null
  );
}

function hasRemoteHaulerDeliveryDemand(homeRoom: string): boolean {
  const room = getVisibleRoom(homeRoom);
  return room !== undefined && selectRemoteHaulerDeliveryTask(room) !== null;
}

export function runHauler(creep: Creep): void {
  clearEmptyEnergyTransferTask(creep);

  const assignment = normalizeRemoteHaulerMemory(creep.memory?.remoteHauler);
  if (!assignment && creep.memory?.remoteHauler !== undefined) {
    return;
  }

  if (!assignment && runLocalHaulerSeasonScoreCollection(creep)) {
    return;
  }

  if (!assignment) {
    runLocalEnergyHauler(creep);
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

function runLocalEnergyHauler(creep: Creep): void {
  if (getCarriedEnergy(creep) > 0) {
    deliverLocalEnergy(creep);
    return;
  }

  collectLocalEnergy(creep);
}

function runLocalHaulerSeasonScoreCollection(creep: Creep): boolean {
  if (getCarriedScore(creep) > 0) {
    return deliverLocalHaulerSeasonScore(creep);
  }

  if (getCarriedEnergy(creep) > 0 || hasPriorityEnergyHaulingDeliveryDemand(creep.room)) {
    return false;
  }

  const task = selectSeasonScoreCollectionTask(creep);
  if (!task) {
    return false;
  }

  const target = getObjectById<RoomObject>(String(task.targetId));
  if (!target) {
    delete creep.memory.task;
    return false;
  }

  creep.memory.task = task;
  const result = collectSeasonScoreFromTarget(creep, target);
  if (result === null) {
    delete creep.memory.task;
    return false;
  }

  if (result === OK_CODE) {
    delete creep.memory.task;
    return true;
  }

  if (result === getErrNotInRangeCode()) {
    moveToScoreTarget(creep, target, getScoreCollectionMoveRange(target));
  } else if (isUnavailableSeasonScoreActionResult(result)) {
    delete creep.memory.task;
  }
  return true;
}

function deliverLocalHaulerSeasonScore(creep: Creep): boolean {
  const target = selectSeasonScoreDeliveryTarget(creep);
  if (!target || typeof creep.transfer !== 'function') {
    delete creep.memory.task;
    return false;
  }

  const task: Extract<CreepTaskMemory, { type: 'collectScore' }> = {
    type: 'collectScore',
    targetId: target.id
  };
  creep.memory.task = task;
  const result = creep.transfer(target as AnyStoreStructure, getScoreResource());
  if (result === OK_CODE) {
    delete creep.memory.task;
    return true;
  }

  if (result === getErrNotInRangeCode()) {
    moveToScoreTarget(creep, target, 1);
  } else if (isUnavailableSeasonScoreActionResult(result)) {
    delete creep.memory.task;
  }
  return true;
}

function collectSeasonScoreFromTarget(creep: Creep, target: RoomObject): ScreepsReturnCode | null {
  const scoreTarget = target as SeasonScoreTarget;
  if (isDroppedScoreResource(scoreTarget) && typeof creep.pickup === 'function') {
    return creep.pickup(scoreTarget as Resource<ResourceConstant>);
  }

  if (getStoredScore(scoreTarget) > 0 && typeof creep.withdraw === 'function') {
    return creep.withdraw(scoreTarget as AnyStoreStructure, getScoreResource());
  }

  return null;
}

function isDroppedScoreResource(target: SeasonScoreTarget): boolean {
  return (
    typeof target.amount === 'number' &&
    target.amount > 0 &&
    typeof target.resourceType === 'string' &&
    target.resourceType === getScoreResource()
  );
}

function getScoreCollectionMoveRange(target: RoomObject): number {
  return isDroppedScoreResource(target as SeasonScoreTarget) ? 0 : 1;
}

function selectSeasonScoreDeliveryTarget(creep: Creep): SeasonScoreTarget | null {
  const room = creep.room;
  if (!room) {
    return null;
  }

  return (
    findVisibleSeasonScoreCollectors(room)
      .filter(hasFreeScoreCapacity)
      .sort((left, right) => getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) || String(left.id).localeCompare(String(right.id)))[0] ?? null
  );
}

function findVisibleSeasonScoreCollectors(room: Room): SeasonScoreTarget[] {
  const candidates = [
    ...findSeasonScoreCollectorsByFindConstants(room),
    ...findSeasonScoreCollectorsByFallbackRoomKeys(room)
  ];
  const unique = new Map<string, SeasonScoreTarget>();

  for (const candidate of candidates) {
    unique.set(String(candidate.id), candidate);
  }

  return [...unique.values()];
}

function findSeasonScoreCollectorsByFindConstants(room: Room): SeasonScoreTarget[] {
  const roomFind = (room as Room & { find?: (type: number) => unknown }).find;
  if (typeof roomFind !== 'function') {
    return [];
  }

  return getSeasonScoreCollectorFindConstants()
    .flatMap((findConstant) => safeRoomFind(room, roomFind, findConstant))
    .filter(isVisibleSeasonScoreCollector);
}

function getSeasonScoreCollectorFindConstants(): number[] {
  const globals = globalThis as unknown as Partial<Record<SeasonScoreCollectorFindConstantGlobal, unknown>>;
  const constants = SCORE_COLLECTOR_FIND_CONSTANT_GLOBALS
    .map((name) => globals[name])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  return [...new Set(constants)];
}

function safeRoomFind(room: Room, roomFind: (type: number) => unknown, findConstant: number): unknown[] {
  try {
    const result = roomFind.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function findSeasonScoreCollectorsByFallbackRoomKeys(room: Room): SeasonScoreTarget[] {
  const roomRecord = room as unknown as Partial<Record<SeasonScoreCollectorRoomKey, unknown>>;
  return SCORE_COLLECTOR_FALLBACK_ROOM_KEYS
    .flatMap((key) => toRoomObjectCandidates(roomRecord[key]))
    .filter(isVisibleSeasonScoreCollector);
}

function toRoomObjectCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value);
  }

  return [];
}

function isVisibleSeasonScoreCollector(value: unknown): value is SeasonScoreTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<SeasonScoreTarget> & Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    isRoomPositionLike(candidate.pos) &&
    candidate.store !== undefined
  );
}

function isRoomPositionLike(value: unknown): value is RoomPosition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const position = value as Partial<RoomPosition>;
  return typeof position.x === 'number' && typeof position.y === 'number' && typeof position.roomName === 'string';
}

function hasFreeScoreCapacity(target: SeasonScoreTarget): boolean {
  const freeCapacity = getFreeStoredResourceCapacity(target, getScoreResource());
  return freeCapacity === null || freeCapacity > 0;
}

function isUnavailableSeasonScoreActionResult(result: ScreepsReturnCode): boolean {
  return result === ERR_NOT_ENOUGH_RESOURCES_CODE || result === ERR_INVALID_TARGET_CODE || result === ERR_FULL_CODE;
}

function collectLocalEnergy(creep: Creep): void {
  const room = creep.room;
  if (!room) {
    delete creep.memory.task;
    return;
  }

  const source = selectEnergyHaulingSource(room, creep, {
    includeDurableSources: hasPriorityEnergyHaulingDeliveryDemand(room)
  });
  if (!source) {
    delete creep.memory.task;
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

function deliverLocalEnergy(creep: Creep): void {
  const room = creep.room;
  if (!room) {
    delete creep.memory.task;
    return;
  }

  const target = selectEnergyHaulingDeliveryTarget(room, creep);
  if (!target) {
    delete creep.memory.task;
    return;
  }

  const task: Extract<CreepTaskMemory, { type: 'transfer' }> = {
    type: 'transfer',
    targetId: target.id as Id<AnyStoreStructure>
  };
  creep.memory.task = task;
  const result = creep.transfer?.(target, getEnergyResource());
  if (shouldClearEmptyEnergyTransferTaskAfterResult(creep, result)) {
    return;
  }

  if (result === getErrNotInRangeCode()) {
    moveTo(creep, target);
  }
}

function collectRemoteEnergy(creep: Creep, assignment: CreepRemoteHaulerMemory): void {
  const assignedContainer = getAssignedContainer(assignment);
  if (creep.room?.name !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.targetRoom, assignedContainer ?? getAssignedSource(assignment), assignment);
    return;
  }

  if (!assignedContainer) {
    collectRemoteDroppedEnergy(creep, assignment);
    return;
  }

  const source = selectRemoteHaulerEnergySource(creep, assignedContainer);
  if (!source) {
    delete creep.memory.task;
    moveTo(creep, assignedContainer);
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
  if (shouldClearEmptyEnergyTransferTaskAfterResult(creep, result)) {
    return;
  }

  if (result === getErrNotInRangeCode()) {
    moveTo(creep, target);
  }
}

function clearEmptyEnergyTransferTask(creep: Creep): void {
  if (creep.memory.task?.type === 'transfer' && getCarriedEnergy(creep) <= 0) {
    delete creep.memory.task;
  }
}

function shouldClearEmptyEnergyTransferTaskAfterResult(
  creep: Creep,
  result: ScreepsReturnCode | undefined
): boolean {
  if (getCarriedEnergy(creep) > 0) {
    return false;
  }

  if (
    result === OK_CODE ||
    result === ERR_NOT_ENOUGH_RESOURCES_CODE ||
    result === ERR_INVALID_TARGET_CODE ||
    result === getErrNotInRangeCode()
  ) {
    delete creep.memory.task;
    return true;
  }

  return false;
}

function compareRemoteHaulerAssignments(left: RemoteSourceAssignment, right: RemoteSourceAssignment): number {
  return (
    compareRemoteHaulerAssignmentOverflowRisk(left, right) ||
    right.containerEnergy - left.containerEnergy ||
    left.targetRoom.localeCompare(right.targetRoom) ||
    String(left.sourceId).localeCompare(String(right.sourceId))
  );
}

function compareRemoteHaulerAssignmentOverflowRisk(
  left: RemoteSourceAssignment,
  right: RemoteSourceAssignment
): number {
  return getRemoteHaulerAssignmentOverflowPriority(right) - getRemoteHaulerAssignmentOverflowPriority(left);
}

function getRemoteHaulerAssignmentOverflowPriority(assignment: RemoteSourceAssignment): number {
  const fillRatio = getRemoteHaulerAssignmentFillRatio(assignment);
  return fillRatio !== null && fillRatio > CONTAINER_OVERFLOW_RISK_FILL_RATIO ? 1 : 0;
}

function getRemoteHaulerAssignmentFillRatio(assignment: RemoteSourceAssignment): number | null {
  if (typeof assignment.containerFillRatio === 'number' && Number.isFinite(assignment.containerFillRatio)) {
    return Math.max(0, Math.min(1, assignment.containerFillRatio));
  }

  const capacity = assignment.containerCapacity;
  return typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0
    ? Math.max(0, Math.min(1, assignment.containerEnergy / capacity))
    : null;
}

function countRemoteHaulersForAssignment(assignment: RemoteSourceAssignment): number {
  return getRemoteOperationCreeps(assignment.homeRoom, assignment.targetRoom).filter(
    (creep) =>
      creep.memory?.role === HAULER_ROLE &&
      canSatisfyRemoteCreepCapacity(creep) &&
      creep.memory.remoteHauler?.homeRoom === assignment.homeRoom &&
      creep.memory.remoteHauler?.targetRoom === assignment.targetRoom &&
      (isNonEmptyString(assignment.containerId)
        ? String(creep.memory.remoteHauler?.containerId) === String(assignment.containerId)
        : String(creep.memory.remoteHauler?.sourceId) === String(assignment.sourceId))
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
    (value.containerId == null || isNonEmptyString(value.containerId))
    ? {
        homeRoom: value.homeRoom,
        targetRoom: value.targetRoom,
        sourceId: value.sourceId as Id<Source>,
        ...(isNonEmptyString(value.containerId) ? { containerId: value.containerId as Id<StructureContainer> } : {})
      }
    : null;
}

function getAssignedContainer(assignment: CreepRemoteHaulerMemory): StructureContainer | null {
  return isNonEmptyString(assignment.containerId) ? getObjectById<StructureContainer>(assignment.containerId) : null;
}

function getAssignedSource(assignment: CreepRemoteHaulerMemory): Source | null {
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

function collectRemoteDroppedEnergy(creep: Creep, assignment: CreepRemoteHaulerMemory): void {
  const source = getAssignedSource(assignment);
  if (!source) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.targetRoom, undefined, assignment);
    return;
  }

  const droppedEnergy = selectDroppedEnergyNearSource(creep.room, source, creep);
  if (!droppedEnergy) {
    delete creep.memory.task;
    moveTo(creep, source);
    return;
  }

  const task: Extract<CreepTaskMemory, { type: 'pickup' }> = {
    type: 'pickup',
    targetId: droppedEnergy.id
  };
  creep.memory.task = task;
  const result = creep.pickup?.(droppedEnergy);
  if (result === OK_CODE) {
    recordCreepBehaviorEnergyAcquisition(creep, 'pickedUp');
  }
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, droppedEnergy);
  }
}

function selectDroppedEnergyNearSource(
  room: Room | undefined,
  source: Source,
  creep: Creep
): Resource<ResourceConstant> | null {
  return (
    findDroppedEnergyNearSource(room, source).sort(
      (left, right) =>
        right.amount - left.amount ||
        getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) ||
        String(left.id).localeCompare(String(right.id))
    )[0] ?? null
  );
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
    compareRemoteHaulerEnergySourceOverflowRisk(left, right) ||
    getStoredEnergy(right) - getStoredEnergy(left) ||
    getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) ||
    getObjectId(left).localeCompare(getObjectId(right))
  );
}

function compareRemoteHaulerEnergySourceOverflowRisk(
  left: RemoteHaulerEnergySource,
  right: RemoteHaulerEnergySource
): number {
  return getRemoteHaulerEnergySourceOverflowPriority(right) - getRemoteHaulerEnergySourceOverflowPriority(left);
}

function getRemoteHaulerEnergySourceOverflowPriority(source: RemoteHaulerEnergySource): number {
  return isRemoteHaulerContainerEnergySource(source) && isContainerOverflowRisk(source, getStoredEnergy(source)) ? 1 : 0;
}

function isRemoteHaulerContainerEnergySource(source: RemoteHaulerEnergySource): source is StructureContainer {
  return matchesStructureType(source.structureType, 'STRUCTURE_CONTAINER', 'container');
}

function getRangeToRoomObject(creep: Creep, target: RoomObject): number {
  const range = creep.pos?.getRangeTo?.(target);
  return typeof range === 'number' && Number.isFinite(range) ? Math.max(0, range) : Number.MAX_SAFE_INTEGER;
}

function moveTo(creep: Creep, target: RoomObject): void {
  creep.moveTo?.(target, HAULER_MOVE_OPTS);
}

function moveToScoreTarget(creep: Creep, target: RoomObject, range: number): void {
  creep.moveTo?.(target, { ...HAULER_MOVE_OPTS, range });
}

function getCarriedEnergy(creep: Creep): number {
  return getStoredEnergy(creep);
}

function getCarriedScore(creep: Creep): number {
  return getStoredScore(creep);
}

function getStoredEnergy(target: unknown): number {
  return getStoredResource(target, getEnergyResource());
}

function getStoredScore(target: unknown): number {
  return getStoredResource(target, getScoreResource());
}

function getStoredResource(target: unknown, resource: ResourceConstant): number {
  const store = (target as any)?.store;
  const usedCapacity = store?.getUsedCapacity?.(resource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const storedResource = store?.[resource];
  return typeof storedResource === 'number' && Number.isFinite(storedResource) ? Math.max(0, storedResource) : 0;
}

function getFreeStoredResourceCapacity(target: unknown, resource: ResourceConstant): number | null {
  const store = (target as any)?.store;
  const resourceCapacity = store?.getFreeCapacity?.(resource);
  if (typeof resourceCapacity === 'number' && Number.isFinite(resourceCapacity)) {
    return Math.max(0, resourceCapacity);
  }

  const totalCapacity = store?.getFreeCapacity?.();
  return typeof totalCapacity === 'number' && Number.isFinite(totalCapacity) ? Math.max(0, totalCapacity) : null;
}

function getEnergyResource(): ResourceConstant {
  return (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy';
}

function getScoreResource(): ResourceConstant {
  return (globalThis as { RESOURCE_SCORE?: ResourceConstant }).RESOURCE_SCORE ?? ('score' as ResourceConstant);
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
