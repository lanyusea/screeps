import { classifyLinks } from '../economy/linkManager';
import { findSourceContainer, getRangeBetweenPositions, getRoomObjectPosition } from '../economy/sourceContainers';
import { WORKER_REPLACEMENT_TICKS_TO_LIVE } from './roleCounts';

export const SOURCE_HARVESTER_ROLE = 'sourceHarvester';

const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const SOURCE_LINK_DEPOSIT_RANGE = 1;
const HARVEST_ENERGY_PER_WORK_PART = 2;
const DEFAULT_SOURCE_ENERGY_CAPACITY = 3_000;
const DEFAULT_SOURCE_REGEN_TICKS = 300;
const SOURCE_HARVESTER_MIN_WORK_PARTS = 4;
const MAX_CREEP_PARTS = 50;
const BODY_PART_COSTS: Record<BodyPartConstant, number> = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10
};

type MobileFallbackEnergySink = StructureSpawn | StructureExtension | StructureTower;

interface SourceHarvesterAssignmentCountCache {
  gameTime: number;
  creeps: Game['creeps'];
  counts: Map<string, number>;
}

export interface SourceHarvesterAssignment {
  roomName: string;
  sourceId: Id<Source>;
  containerId: Id<StructureContainer>;
}

export interface SourceHarvesterAssignmentSelectionOptions {
  origin?: RoomPosition | null;
}

export interface SourceHarvesterBodyOptions {
  sourceDistance?: number;
  sourceEnergyCapacity?: number;
  sourceEnergyRegenTicks?: number;
}

interface SourceHarvesterAssignmentCandidate {
  assignment: SourceHarvesterAssignment;
  rangeFromOrigin: number;
}

let sourceHarvesterAssignmentCountCache: SourceHarvesterAssignmentCountCache | null = null;

export function buildSourceHarvesterBody(
  energyAvailable: number,
  options: SourceHarvesterBodyOptions = {}
): BodyPartConstant[] {
  const energyBudget = normalizeNonNegativeInteger(energyAvailable);
  const targetWorkParts = getSourceHarvesterTargetWorkParts(options);
  const minimumWorkParts = Math.min(targetWorkParts, SOURCE_HARVESTER_MIN_WORK_PARTS);

  for (let workParts = targetWorkParts; workParts >= minimumWorkParts; workParts -= 1) {
    const carryParts = 1;
    const minimumMoveParts = 1;
    if (getSourceHarvesterBodyCost(workParts, carryParts, minimumMoveParts) > energyBudget) {
      continue;
    }

    const moveParts = selectSourceHarvesterMoveParts(energyBudget, workParts, carryParts, options.sourceDistance);
    return buildSourceHarvesterBodyParts(workParts, carryParts, moveParts);
  }

  return [];
}

export function selectSourceHarvesterAssignment(
  room: Room,
  options: SourceHarvesterAssignmentSelectionOptions = {}
): SourceHarvesterAssignment | null {
  const assignmentCounts = getSourceHarvesterAssignmentCounts();
  return (
    getSourceHarvesterAssignments(room, options).find(
      (assignment) => countAssignedSourceHarvesters(assignment, assignmentCounts) < 1
    ) ?? null
  );
}

export function getSourceHarvesterAssignments(
  room: Room,
  options: SourceHarvesterAssignmentSelectionOptions = {}
): SourceHarvesterAssignment[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return (room.find(FIND_SOURCES) as Source[])
    .flatMap((source) => {
      const container = findSourceContainer(room, source);
      return container
        ? [
            {
              assignment: {
                roomName: room.name,
                sourceId: source.id,
                containerId: container.id
              },
              rangeFromOrigin: getSourceRangeFromOrigin(source, options.origin)
            }
          ]
        : [];
    })
    .sort(compareAssignmentCandidates)
    .map((candidate) => candidate.assignment);
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

  const carriedEnergy = getCarriedEnergy(creep);
  if (carriedEnergy > 0) {
    const transferResult = transferHarvestedEnergy(creep, source, container);
    if (transferResult === getErrNotInRangeCode()) {
      return;
    }
  }

  if (isSourceDepleted(source)) {
    return;
  }

  if (getFreeEnergyCapacity(creep) <= 0) {
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

function getSourceHarvesterTargetWorkParts(options: SourceHarvesterBodyOptions): number {
  const sourceEnergyCapacity = normalizePositiveNumber(options.sourceEnergyCapacity) ?? getDefaultSourceEnergyCapacity();
  const sourceEnergyRegenTicks = normalizePositiveNumber(options.sourceEnergyRegenTicks) ?? getDefaultSourceRegenTicks();
  const workParts = Math.ceil(sourceEnergyCapacity / sourceEnergyRegenTicks / HARVEST_ENERGY_PER_WORK_PART);
  return Math.max(1, Math.min(MAX_CREEP_PARTS - 2, workParts));
}

function selectSourceHarvesterMoveParts(
  energyBudget: number,
  workParts: number,
  carryParts: number,
  sourceDistance: number | undefined
): number {
  const desiredMoveParts = getSourceHarvesterMoveTarget(workParts, carryParts, sourceDistance);
  const nonMoveCost = workParts * BODY_PART_COSTS.work + carryParts * BODY_PART_COSTS.carry;
  const affordableMoveParts = Math.floor(Math.max(0, energyBudget - nonMoveCost) / BODY_PART_COSTS.move);
  return Math.max(
    1,
    Math.min(desiredMoveParts, affordableMoveParts, MAX_CREEP_PARTS - workParts - carryParts)
  );
}

function getSourceHarvesterMoveTarget(
  workParts: number,
  carryParts: number,
  sourceDistance: number | undefined
): number {
  const nonMoveParts = workParts + carryParts;
  const normalizedDistance = normalizeNonNegativeInteger(sourceDistance ?? 0);
  if (normalizedDistance <= 5) {
    return 1;
  }

  if (normalizedDistance <= 12) {
    return Math.ceil(nonMoveParts / 3);
  }

  return Math.ceil(nonMoveParts / 2);
}

function buildSourceHarvesterBodyParts(
  workParts: number,
  carryParts: number,
  moveParts: number
): BodyPartConstant[] {
  return [
    ...Array.from({ length: workParts }, () => 'work' as BodyPartConstant),
    ...Array.from({ length: carryParts }, () => 'carry' as BodyPartConstant),
    ...Array.from({ length: moveParts }, () => 'move' as BodyPartConstant)
  ];
}

function getSourceHarvesterBodyCost(workParts: number, carryParts: number, moveParts: number): number {
  return workParts * BODY_PART_COSTS.work + carryParts * BODY_PART_COSTS.carry + moveParts * BODY_PART_COSTS.move;
}

function getDefaultSourceEnergyCapacity(): number {
  const sourceEnergyCapacity = (globalThis as unknown as { SOURCE_ENERGY_CAPACITY?: number }).SOURCE_ENERGY_CAPACITY;
  return normalizePositiveNumber(sourceEnergyCapacity) ?? DEFAULT_SOURCE_ENERGY_CAPACITY;
}

function getDefaultSourceRegenTicks(): number {
  const regenTicks = (globalThis as unknown as { ENERGY_REGEN_TIME?: number }).ENERGY_REGEN_TIME;
  return normalizePositiveNumber(regenTicks) ?? DEFAULT_SOURCE_REGEN_TICKS;
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

function countAssignedSourceHarvesters(
  assignment: SourceHarvesterAssignment,
  assignmentCounts: ReadonlyMap<string, number>
): number {
  return assignmentCounts.get(getSourceHarvesterAssignmentKey(assignment.roomName, assignment.sourceId)) ?? 0;
}

function getSourceHarvesterAssignmentCounts(): Map<string, number> {
  const game = (globalThis as { Game?: Partial<Pick<Game, 'creeps' | 'time'>> }).Game;
  const creeps = game?.creeps;
  if (!creeps) {
    return new Map();
  }

  const gameTime = getCacheableGameTime(game);
  if (
    gameTime !== null &&
    sourceHarvesterAssignmentCountCache?.gameTime === gameTime &&
    sourceHarvesterAssignmentCountCache.creeps === creeps
  ) {
    return sourceHarvesterAssignmentCountCache.counts;
  }

  const counts = new Map<string, number>();
  for (const creep of Object.values(creeps)) {
    const assignmentKey = getAssignedSourceHarvesterSlotKey(creep);
    if (!assignmentKey) {
      continue;
    }

    counts.set(assignmentKey, (counts.get(assignmentKey) ?? 0) + 1);
  }

  if (gameTime !== null) {
    sourceHarvesterAssignmentCountCache = { gameTime, creeps, counts };
  }

  return counts;
}

function getAssignedSourceHarvesterSlotKey(creep: Creep): string | null {
  if (!canSatisfySourceHarvesterCapacity(creep)) {
    return null;
  }

  if (
    creep.memory?.role === SOURCE_HARVESTER_ROLE &&
    typeof creep.memory.sourceHarvester?.roomName === 'string' &&
    creep.memory.sourceHarvester.sourceId !== undefined
  ) {
    return getSourceHarvesterAssignmentKey(
      creep.memory.sourceHarvester.roomName,
      creep.memory.sourceHarvester.sourceId
    );
  }

  const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
  if (
    creep.memory?.role === 'worker' &&
    typeof creep.room?.name === 'string' &&
    task?.type === 'harvest' &&
    task.sourceContainerAssigned === true &&
    task.targetId !== undefined
  ) {
    return getSourceHarvesterAssignmentKey(creep.room.name, task.targetId);
  }

  return null;
}

function getSourceHarvesterAssignmentKey(roomName: string, sourceId: unknown): string {
  return `${roomName}\0${String(sourceId)}`;
}

function getCacheableGameTime(game: Partial<Pick<Game, 'time'>>): number | null {
  return typeof game.time === 'number' && Number.isFinite(game.time) ? game.time : null;
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

function getSourceRangeFromOrigin(source: Source, origin: RoomPosition | null | undefined): number {
  if (!origin) {
    return Number.POSITIVE_INFINITY;
  }

  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition) {
    return Number.POSITIVE_INFINITY;
  }

  if (
    typeof origin.roomName === 'string' &&
    typeof sourcePosition.roomName === 'string' &&
    origin.roomName !== sourcePosition.roomName
  ) {
    return 50;
  }

  return getRangeBetweenPositions(origin, sourcePosition);
}

function compareAssignmentCandidates(
  left: SourceHarvesterAssignmentCandidate,
  right: SourceHarvesterAssignmentCandidate
): number {
  return left.rangeFromOrigin - right.rangeFromOrigin || compareAssignments(left.assignment, right.assignment);
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

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
