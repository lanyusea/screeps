import { getOwnedColonies, type ColonySnapshot } from '../colony/colonyRegistry';
import { checkEnergyBufferForSpending } from '../economy/energyBuffer';
import { planExpansionDefenseBarrierPlacements } from '../territory/expansionPlanner';
import { planSourceContainerConstruction, planStorageConstruction, planTowerConstruction } from './constructionPriority';
import { planExtensionConstruction } from './extensionPlanner';
import { planEarlyRoadConstruction, type EarlyRoadPlannerOptions } from './roadPlanner';

export type ConstructionPlannerPriority =
  | 'spawn'
  | 'extension'
  | 'road'
  | 'container'
  | 'rampart'
  | 'wall'
  | 'tower'
  | 'storage';

export const POST_CLAIM_CONSTRUCTION_PRIORITY_ORDER: readonly ConstructionPlannerPriority[] = [
  'spawn',
  'extension',
  'container',
  'road',
  'tower',
  'rampart',
  'storage'
];

export interface ConstructionPlannerOptions {
  colonies?: ColonySnapshot[];
  energyBudgetRatio?: number;
  siteEnergyReservation?: number;
  respectRoomEnergyBuffer?: boolean;
  roadOptions?: EarlyRoadPlannerOptions;
  maxContainerSitesPerTick?: number;
  maxPendingContainerSites?: number;
  includePostClaimRamparts?: boolean;
  includeStorage?: boolean;
  postClaimPriorityOrder?: boolean;
}

export interface ConstructionPlannerPlacement {
  priority: ConstructionPlannerPriority;
  roomName: string;
  structureType: BuildableStructureConstant;
  result: ScreepsReturnCode;
  energyReserved: number;
  x?: number;
  y?: number;
}

export interface RoomConstructionPlannerResult {
  roomName: string;
  rcl: number;
  energyAvailable: number;
  energyBudget: number;
  energyReserved: number;
  placements: ConstructionPlannerPlacement[];
}

export interface ConstructionPlannerResult {
  rooms: RoomConstructionPlannerResult[];
  placements: ConstructionPlannerPlacement[];
  energyBudget: number;
  energyReserved: number;
}

type FindConstantGlobal =
  | 'FIND_SOURCES'
  | 'FIND_STRUCTURES'
  | 'FIND_CONSTRUCTION_SITES'
  | 'FIND_MY_STRUCTURES'
  | 'FIND_MY_CONSTRUCTION_SITES';
type LookConstantGlobal = 'LOOK_STRUCTURES' | 'LOOK_CONSTRUCTION_SITES' | 'LOOK_MINERALS';
type StructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_ROAD'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_RAMPART'
  | 'STRUCTURE_WALL'
  | 'STRUCTURE_TOWER'
  | 'STRUCTURE_STORAGE';
type ReturnCodeGlobal = 'ERR_FULL' | 'ERR_RCL_NOT_ENOUGH';

interface CandidatePosition {
  x: number;
  y: number;
  roomName?: string;
}

interface SpawnPlacementLookups {
  blockingPositions: Set<string>;
  mineralPositions: Set<string>;
  rangeReservedPositions: CandidatePosition[];
  terrain: RoomTerrain | null;
}

interface SpawnPlacementResult {
  result: ScreepsReturnCode;
  position?: CandidatePosition;
}

interface ConstructionBudgetState {
  energyBudget: number;
  energyReserved: number;
}

const DEFAULT_ENERGY_BUDGET_RATIO = 0.5;
const DEFAULT_SITE_ENERGY_RESERVATION = 50;
const SPAWN_SITE_ENERGY_RESERVATION = 0;
const DEFAULT_MAX_ROAD_SITES_PER_TICK = 1;
const DEFAULT_MAX_CONTAINER_SITES_PER_TICK = 1;
const MIN_RCL_FOR_SOURCE_LOGISTICS_STARVATION_PRIORITY = 4;
const SOURCE_LOGISTICS_STARVATION_ENERGY_RATIO = 0.5;
const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const SPAWN_EDGE_MIN = 2;
const SPAWN_EDGE_MAX = 47;
const MAX_SPAWN_SITE_SCAN_RADIUS = 8;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_RCL_NOT_ENOUGH_CODE = -14 as ScreepsReturnCode;

const FALLBACK_CONTROLLER_STRUCTURES: Record<StructureConstantGlobal, number[]> = {
  STRUCTURE_SPAWN: [0, 1, 1, 1, 1, 1, 1, 2, 3],
  STRUCTURE_EXTENSION: [0, 0, 5, 10, 20, 30, 40, 50, 60],
  STRUCTURE_ROAD: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
  STRUCTURE_CONTAINER: [0, 0, 5, 5, 5, 5, 5, 5, 5],
  STRUCTURE_RAMPART: [0, 0, 300, 300, 300, 300, 300, 300, 300],
  STRUCTURE_WALL: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
  STRUCTURE_TOWER: [0, 0, 0, 1, 1, 2, 2, 3, 6],
  STRUCTURE_STORAGE: [0, 0, 0, 0, 1, 1, 1, 1, 1]
};

const PRIORITY_STRUCTURE_TYPES: Record<ConstructionPlannerPriority, StructureConstantGlobal> = {
  spawn: 'STRUCTURE_SPAWN',
  extension: 'STRUCTURE_EXTENSION',
  road: 'STRUCTURE_ROAD',
  container: 'STRUCTURE_CONTAINER',
  rampart: 'STRUCTURE_RAMPART',
  wall: 'STRUCTURE_WALL',
  tower: 'STRUCTURE_TOWER',
  storage: 'STRUCTURE_STORAGE'
};

const STRUCTURE_TYPE_FALLBACKS: Record<StructureConstantGlobal, string> = {
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_WALL: 'constructedWall',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_STORAGE: 'storage'
};

export function runConstructionPlanner(options: ConstructionPlannerOptions = {}): ConstructionPlannerResult {
  const colonies = options.colonies ?? getOwnedColonies();
  const rooms = colonies.map((colony) => planConstructionForColony(colony, options));
  return {
    rooms,
    placements: rooms.flatMap((room) => room.placements),
    energyBudget: rooms.reduce((total, room) => total + room.energyBudget, 0),
    energyReserved: rooms.reduce((total, room) => total + room.energyReserved, 0)
  };
}

export function planConstructionForColony(
  colony: ColonySnapshot,
  options: ConstructionPlannerOptions = {}
): RoomConstructionPlannerResult {
  const room = colony.room;
  const rcl = getOwnedRoomRcl(room);
  const energyAvailable = getRoomEnergyAvailable(colony);
  const budgetState: ConstructionBudgetState = {
    energyBudget: Math.floor(energyAvailable * resolveEnergyBudgetRatio(options.energyBudgetRatio)),
    energyReserved: 0
  };
  const result: RoomConstructionPlannerResult = {
    roomName: room.name,
    rcl,
    energyAvailable,
    energyBudget: budgetState.energyBudget,
    energyReserved: 0,
    placements: []
  };

  if (rcl <= 0 || typeof room.createConstructionSite !== 'function') {
    return result;
  }
  const sourceLogisticsStarved = shouldPrioritizeSourceLogisticsBeforeCapacity(
    rcl,
    energyAvailable,
    getRoomEnergyCapacityAvailable(colony)
  );

  const spawnPlacement = planSpawnIfMissing(colony);
  if (spawnPlacement) {
    recordPlacement(result, budgetState, 'spawn', spawnPlacement.result, options, spawnPlacement.position);
    if (spawnPlacement.result !== getOkCode()) {
      return result;
    }
  }

  if (options.postClaimPriorityOrder === true) {
    planExtensions(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }

    planContainers(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }

    planRoads(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }

    planTowers(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }

    if (options.includePostClaimRamparts === true) {
      planRamparts(colony, result, budgetState, options);
      if (hasBlockingPlacementFailure(result)) {
        return result;
      }
    }

    planStorage(colony, result, budgetState, options);
    return result;
  }

  if (sourceLogisticsStarved) {
    planContainers(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }

    planRoads(colony, result, budgetState, buildSourceLogisticsStarvationRoadOptions(colony, options));
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }
  }

  planExtensions(colony, result, budgetState, options);
  if (hasBlockingPlacementFailure(result)) {
    return result;
  }

  if (!sourceLogisticsStarved) {
    planRoads(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }

    planContainers(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }
  }

  if (options.includePostClaimRamparts === true) {
    planRamparts(colony, result, budgetState, options);
    if (hasBlockingPlacementFailure(result)) {
      return result;
    }
  }

  planTowers(colony, result, budgetState, options);
  planStorage(colony, result, budgetState, options);

  return result;
}

function planExtensions(
  colony: ColonySnapshot,
  result: RoomConstructionPlannerResult,
  budgetState: ConstructionBudgetState,
  options: ConstructionPlannerOptions
): void {
  if (
    !hasRemainingStructureCapacity(colony.room, 'extension') ||
    !canReserveConstructionEnergy(colony.room, budgetState, 'extension', options)
  ) {
    return;
  }

  const extensionResult = planExtensionConstruction(colony);
  if (extensionResult !== null) {
    recordPlacement(result, budgetState, 'extension', extensionResult, options);
  }
}

function planTowers(
  colony: ColonySnapshot,
  result: RoomConstructionPlannerResult,
  budgetState: ConstructionBudgetState,
  options: ConstructionPlannerOptions
): void {
  if (
    !hasRemainingStructureCapacity(colony.room, 'tower') ||
    !canReserveConstructionEnergy(colony.room, budgetState, 'tower', options)
  ) {
    return;
  }

  const towerResult = planTowerConstruction(colony);
  if (towerResult !== null) {
    recordPlacement(result, budgetState, 'tower', towerResult, options);
  }
}

function planStorage(
  colony: ColonySnapshot,
  result: RoomConstructionPlannerResult,
  budgetState: ConstructionBudgetState,
  options: ConstructionPlannerOptions
): void {
  if (
    options.includeStorage !== true ||
    !hasRemainingStructureCapacity(colony.room, 'storage') ||
    !canReserveConstructionEnergy(colony.room, budgetState, 'storage', options)
  ) {
    return;
  }

  const storageResult = planStorageConstruction(colony);
  if (storageResult !== null) {
    recordPlacement(result, budgetState, 'storage', storageResult, options);
  }
}

function buildSourceLogisticsStarvationRoadOptions(
  colony: ColonySnapshot,
  options: ConstructionPlannerOptions
): ConstructionPlannerOptions {
  const sourceCount = getSortedSources(colony.room).length;
  const configuredMaxTargets = options.roadOptions?.maxTargetsPerTick;

  return {
    ...options,
    roadOptions: {
      ...options.roadOptions,
      countOnlyRouteRoadSitesForPendingLimit: true,
      maxTargetsPerTick: Math.max(sourceCount, resolvePositiveInteger(configuredMaxTargets, sourceCount))
    }
  };
}

function planSpawnIfMissing(colony: ColonySnapshot): SpawnPlacementResult | null {
  const room = colony.room;
  if (!hasRemainingStructureCapacity(room, 'spawn') || hasSpawnCoverage(colony)) {
    return null;
  }

  for (const position of findSpawnConstructionPositions(room)) {
    const result = room.createConstructionSite(position.x, position.y, getStructureConstant('STRUCTURE_SPAWN'));
    if (result === getOkCode() || isFatalConstructionSiteResult(result)) {
      return { result, position };
    }
  }

  return null;
}

function planRoads(
  colony: ColonySnapshot,
  result: RoomConstructionPlannerResult,
  budgetState: ConstructionBudgetState,
  options: ConstructionPlannerOptions
): void {
  const remainingStructureCapacity = getRemainingStructureCapacity(colony.room, 'road');
  const remainingEnergySlots = getRemainingEnergySlots(colony.room, budgetState, 'road', options);
  const maxSitesPerTick = Math.min(
    resolvePositiveInteger(options.roadOptions?.maxSitesPerTick, DEFAULT_MAX_ROAD_SITES_PER_TICK),
    remainingStructureCapacity,
    remainingEnergySlots
  );
  if (maxSitesPerTick <= 0) {
    return;
  }

  const roadResults = planEarlyRoadConstruction(colony, {
    ...options.roadOptions,
    maxSitesPerTick
  });
  for (const roadResult of roadResults) {
    recordPlacement(result, budgetState, 'road', roadResult, options);
    if (roadResult !== getOkCode()) {
      return;
    }
  }
}

function planContainers(
  colony: ColonySnapshot,
  result: RoomConstructionPlannerResult,
  budgetState: ConstructionBudgetState,
  options: ConstructionPlannerOptions
): void {
  const remainingStructureCapacity = getRemainingStructureCapacity(colony.room, 'container');
  const remainingEnergySlots = getRemainingEnergySlots(colony.room, budgetState, 'container', options);
  const maxContainerSitesPerTick = Math.min(
    resolvePositiveInteger(options.maxContainerSitesPerTick, DEFAULT_MAX_CONTAINER_SITES_PER_TICK),
    remainingStructureCapacity,
    remainingEnergySlots
  );
  if (maxContainerSitesPerTick <= 0) {
    return;
  }

  const containerResults = planSourceContainerConstruction(colony, {
    maxContainerSitesPerTick,
    maxPendingContainerSites: options.maxPendingContainerSites
  });
  for (const containerResult of containerResults) {
    recordPlacement(result, budgetState, 'container', containerResult, options);
    if (containerResult !== getOkCode()) {
      return;
    }
  }
}

function planRamparts(
  colony: ColonySnapshot,
  result: RoomConstructionPlannerResult,
  budgetState: ConstructionBudgetState,
  options: ConstructionPlannerOptions
): void {
  const barrierPlacement = planPostClaimBarrierConstruction(colony, budgetState, options);
  if (barrierPlacement) {
    recordPlacement(
      result,
      budgetState,
      barrierPlacement.priority,
      barrierPlacement.result,
      options,
      barrierPlacement.position
    );
  }
}

interface BarrierPlacementResult extends SpawnPlacementResult {
  priority: Extract<ConstructionPlannerPriority, 'rampart' | 'wall'>;
}

function planPostClaimBarrierConstruction(
  colony: ColonySnapshot,
  budgetState: ConstructionBudgetState,
  options: ConstructionPlannerOptions
): BarrierPlacementResult | null {
  const room = colony.room;
  if (typeof room.find !== 'function' || typeof room.createConstructionSite !== 'function') {
    return null;
  }

  const rampartStructureType = getStructureConstant('STRUCTURE_RAMPART');
  const wallStructureType = getStructureConstant('STRUCTURE_WALL');
  const placements = planExpansionDefenseBarrierPlacements(room, { maxPlacements: 4 })
    .filter((placement) => placement.stage !== 'entranceWall')
    .filter((placement) => placement.roomName === room.name)
    .filter(
      (placement) => placement.structureType === rampartStructureType || placement.structureType === wallStructureType
    );
  for (const placement of placements) {
    const priority = getBarrierPlacementPriority(placement.structureType, rampartStructureType, wallStructureType);
    if (
      priority === null ||
      !hasRemainingStructureCapacity(room, priority) ||
      !canReserveConstructionEnergy(room, budgetState, priority, options)
    ) {
      continue;
    }

    const result = room.createConstructionSite(placement.x, placement.y, placement.structureType);
    if (result === getOkCode() || isFatalConstructionSiteResult(result)) {
      return {
        priority,
        result,
        position: {
          x: placement.x,
          y: placement.y,
          roomName: placement.roomName
        }
      };
    }
  }

  return null;
}

function getBarrierPlacementPriority(
  structureType: BuildableStructureConstant,
  rampartStructureType: BuildableStructureConstant,
  wallStructureType: BuildableStructureConstant
): BarrierPlacementResult['priority'] | null {
  if (structureType === rampartStructureType) {
    return 'rampart';
  }
  if (structureType === wallStructureType) {
    return 'wall';
  }

  return null;
}

function recordPlacement(
  result: RoomConstructionPlannerResult,
  budgetState: ConstructionBudgetState,
  priority: ConstructionPlannerPriority,
  placementResult: ScreepsReturnCode,
  options: ConstructionPlannerOptions,
  position?: CandidatePosition
): void {
  const energyReserved = placementResult === getOkCode() ? getConstructionEnergyReservation(priority, options) : 0;
  budgetState.energyReserved += energyReserved;
  result.energyReserved = budgetState.energyReserved;
  result.placements.push({
    priority,
    roomName: result.roomName,
    structureType: getStructureConstant(PRIORITY_STRUCTURE_TYPES[priority]),
    result: placementResult,
    energyReserved,
    ...(position ? { x: position.x, y: position.y } : {})
  });
}

function hasBlockingPlacementFailure(result: RoomConstructionPlannerResult): boolean {
  const lastPlacement = result.placements[result.placements.length - 1];
  return lastPlacement !== undefined && lastPlacement.result !== getOkCode();
}

function hasSpawnCoverage(colony: ColonySnapshot): boolean {
  return (
    colony.spawns.some((spawn) => spawn.room?.name === colony.room.name) ||
    countExistingStructures(colony.room, 'spawn') > 0 ||
    countPendingConstructionSites(colony.room, 'spawn') > 0
  );
}

function hasRemainingStructureCapacity(room: Room, priority: ConstructionPlannerPriority): boolean {
  return getRemainingStructureCapacity(room, priority) > 0;
}

function getRemainingStructureCapacity(room: Room, priority: ConstructionPlannerPriority): number {
  if (priority === 'spawn' && countExistingStructures(room, priority) > 0) {
    return 0;
  }

  const limit = getControllerStructureLimit(room, PRIORITY_STRUCTURE_TYPES[priority]);
  const plannedCount = countExistingAndPendingStructures(room, priority);
  return Math.max(0, limit - plannedCount);
}

function countExistingAndPendingStructures(room: Room, priority: ConstructionPlannerPriority): number {
  return countExistingStructures(room, priority) + countPendingConstructionSites(room, priority);
}

function countExistingStructures(room: Room, priority: ConstructionPlannerPriority): number {
  const structureType = getStructureConstant(PRIORITY_STRUCTURE_TYPES[priority]);
  const objects = [
    ...findRoomObjects<Structure>(room, 'FIND_STRUCTURES'),
    ...findRoomObjects<Structure>(room, 'FIND_MY_STRUCTURES')
  ];
  return countUniqueObjectsByStructureType(objects, structureType);
}

function countPendingConstructionSites(room: Room, priority: ConstructionPlannerPriority): number {
  const structureType = getStructureConstant(PRIORITY_STRUCTURE_TYPES[priority]);
  const objects = [
    ...findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES'),
    ...findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES')
  ];
  return countUniqueObjectsByStructureType(objects, structureType);
}

function countUniqueObjectsByStructureType(
  objects: Array<Structure | ConstructionSite>,
  structureType: BuildableStructureConstant
): number {
  const seen = new Set<string>();
  let count = 0;
  objects.forEach((object, index) => {
    if (object.structureType !== structureType) {
      return;
    }

    const key = getObjectStableKey(object, index);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    count += 1;
  });
  return count;
}

function getObjectStableKey(object: Structure | ConstructionSite, index: number): string {
  const id = (object as { id?: unknown }).id;
  if (typeof id === 'string') {
    return id;
  }

  const position = getAnyObjectPosition(object);
  return position ? `${object.structureType}:${getPositionKey(position)}` : `${object.structureType}:${index}`;
}

function canReserveConstructionEnergy(
  room: Room,
  budgetState: ConstructionBudgetState,
  priority: ConstructionPlannerPriority,
  options: ConstructionPlannerOptions
): boolean {
  return getRemainingEnergySlots(room, budgetState, priority, options) > 0;
}

function getRemainingEnergySlots(
  room: Room,
  budgetState: ConstructionBudgetState,
  priority: ConstructionPlannerPriority,
  options: ConstructionPlannerOptions
): number {
  const reservation = getConstructionEnergyReservation(priority, options);
  if (reservation <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  const budgetSlots = Math.floor(Math.max(0, budgetState.energyBudget - budgetState.energyReserved) / reservation);
  if (
    options.respectRoomEnergyBuffer !== true ||
    shouldBypassEnergyBufferForSourceLogisticsConstruction(room, priority)
  ) {
    return budgetSlots;
  }

  let energyBufferSlots = 0;
  while (
    energyBufferSlots < budgetSlots &&
    checkEnergyBufferForSpending(room, budgetState.energyReserved + reservation * (energyBufferSlots + 1))
  ) {
    energyBufferSlots += 1;
  }

  return energyBufferSlots;
}

function getConstructionEnergyReservation(
  priority: ConstructionPlannerPriority,
  options: ConstructionPlannerOptions = {}
): number {
  if (priority === 'spawn') {
    return SPAWN_SITE_ENERGY_RESERVATION;
  }

  return resolvePositiveInteger(options.siteEnergyReservation, DEFAULT_SITE_ENERGY_RESERVATION);
}

function shouldBypassEnergyBufferForSourceLogisticsConstruction(
  room: Room,
  priority: ConstructionPlannerPriority
): boolean {
  return (
    (priority === 'container' || priority === 'road') &&
    shouldPrioritizeSourceLogisticsBeforeCapacity(
      getOwnedRoomRcl(room),
      getRoomEnergyAvailableFromRoom(room),
      getRoomEnergyCapacityAvailableFromRoom(room)
    )
  );
}

function resolveEnergyBudgetRatio(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_ENERGY_BUDGET_RATIO;
  }

  return Math.max(0, Math.min(1, value));
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function getRoomEnergyAvailable(colony: ColonySnapshot): number {
  const roomEnergy = getOptionalRoomEnergyAvailable(colony.room);
  if (roomEnergy !== null) {
    return roomEnergy;
  }

  return typeof colony.energyAvailable === 'number' && Number.isFinite(colony.energyAvailable)
    ? Math.max(0, colony.energyAvailable)
    : 0;
}

function getRoomEnergyCapacityAvailable(colony: ColonySnapshot): number {
  const roomEnergyCapacity = getOptionalRoomEnergyCapacityAvailable(colony.room);
  if (roomEnergyCapacity !== null) {
    return roomEnergyCapacity;
  }

  return typeof colony.energyCapacityAvailable === 'number' && Number.isFinite(colony.energyCapacityAvailable)
    ? Math.max(0, colony.energyCapacityAvailable)
    : 0;
}

function getRoomEnergyAvailableFromRoom(room: Room): number {
  return getOptionalRoomEnergyAvailable(room) ?? 0;
}

function getRoomEnergyCapacityAvailableFromRoom(room: Room): number {
  return getOptionalRoomEnergyCapacityAvailable(room) ?? 0;
}

function getOptionalRoomEnergyAvailable(room: Room): number | null {
  const roomEnergy = (room as Partial<Room>).energyAvailable;
  return typeof roomEnergy === 'number' && Number.isFinite(roomEnergy)
    ? Math.max(0, roomEnergy)
    : null;
}

function getOptionalRoomEnergyCapacityAvailable(room: Room): number | null {
  const roomEnergyCapacity = (room as Partial<Room>).energyCapacityAvailable;
  return typeof roomEnergyCapacity === 'number' && Number.isFinite(roomEnergyCapacity)
    ? Math.max(0, roomEnergyCapacity)
    : null;
}

function shouldPrioritizeSourceLogisticsBeforeCapacity(
  rcl: number,
  energyAvailable: number,
  energyCapacityAvailable: number
): boolean {
  return (
    rcl >= MIN_RCL_FOR_SOURCE_LOGISTICS_STARVATION_PRIORITY &&
    energyCapacityAvailable > 0 &&
    energyAvailable < energyCapacityAvailable * SOURCE_LOGISTICS_STARVATION_ENERGY_RATIO
  );
}

function getOwnedRoomRcl(room: Room): number {
  const level = room.controller?.my === true ? room.controller.level : 0;
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.min(8, Math.floor(level))) : 0;
}

function getControllerStructureLimit(room: Room, globalName: StructureConstantGlobal): number {
  const rcl = getOwnedRoomRcl(room);
  const controllerStructures = (globalThis as unknown as { CONTROLLER_STRUCTURES?: Partial<Record<string, number[]>> })
    .CONTROLLER_STRUCTURES;
  const structureType = getStructureConstant(globalName);
  const configuredLimit = controllerStructures?.[structureType]?.[rcl];
  if (typeof configuredLimit === 'number' && Number.isFinite(configuredLimit)) {
    return Math.max(0, Math.floor(configuredLimit));
  }

  return FALLBACK_CONTROLLER_STRUCTURES[globalName][rcl] ?? 0;
}

function findSpawnConstructionPositions(room: Room): CandidatePosition[] {
  const anchor = selectInitialSpawnAnchor(room);
  if (!anchor) {
    return [];
  }

  const maximumScanRadius = getMaximumSpawnSiteScanRadius(anchor);
  const lookups = buildSpawnPlacementLookups(room, anchor, maximumScanRadius);
  const positions: CandidatePosition[] = [];
  for (let radius = 0; radius <= maximumScanRadius; radius += 1) {
    for (let y = anchor.y - radius; y <= anchor.y + radius; y += 1) {
      for (let x = anchor.x - radius; x <= anchor.x + radius; x += 1) {
        if (Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) !== radius) {
          continue;
        }

        const position = { x, y, roomName: room.name };
        if (canPlaceSpawn(lookups, position)) {
          positions.push(position);
        }
      }
    }
  }

  return positions;
}

function selectInitialSpawnAnchor(room: Room): CandidatePosition | null {
  const controllerPosition = getAnyObjectPosition(room.controller as RoomObject | undefined);
  if (!controllerPosition) {
    return null;
  }

  const nearestSourcePosition = getSortedSources(room)
    .map((source) => getAnyObjectPosition(source))
    .filter((position): position is CandidatePosition => position !== null)
    .sort((left, right) => getRangeBetweenPositions(controllerPosition, left) - getRangeBetweenPositions(controllerPosition, right))[0];

  if (!nearestSourcePosition) {
    return clampSpawnPosition({ x: controllerPosition.x, y: controllerPosition.y, roomName: room.name });
  }

  return clampSpawnPosition({
    x: Math.round((controllerPosition.x + nearestSourcePosition.x) / 2),
    y: Math.round((controllerPosition.y + nearestSourcePosition.y) / 2),
    roomName: room.name
  });
}

function buildSpawnPlacementLookups(
  room: Room,
  anchor: CandidatePosition,
  maximumScanRadius: number
): SpawnPlacementLookups {
  const blockingPositions = new Set<string>();
  const rangeReservedPositions: CandidatePosition[] = [];
  for (const object of [room.controller, ...getSortedSources(room)]) {
    const position = getAnyObjectPosition(object);
    if (position) {
      blockingPositions.add(getPositionKey(position));
      rangeReservedPositions.push(position);
    }
  }

  for (const object of [
    ...lookForArea(room, 'LOOK_STRUCTURES', anchor, maximumScanRadius),
    ...lookForArea(room, 'LOOK_CONSTRUCTION_SITES', anchor, maximumScanRadius)
  ]) {
    const position = getAnyObjectPosition(object);
    if (position) {
      blockingPositions.add(getPositionKey(position));
    }
  }

  const mineralPositions = new Set<string>();
  for (const object of lookForArea(room, 'LOOK_MINERALS', anchor, maximumScanRadius)) {
    const position = getAnyObjectPosition(object);
    if (position) {
      mineralPositions.add(getPositionKey(position));
    }
  }

  return {
    blockingPositions,
    mineralPositions,
    rangeReservedPositions,
    terrain: getRoomTerrain(room)
  };
}

function lookForArea(
  room: Room,
  lookConstantName: LookConstantGlobal,
  anchor: CandidatePosition,
  maximumScanRadius: number
): unknown[] {
  const lookConstant = getGlobalString(lookConstantName);
  if (!lookConstant || typeof room.lookForAtArea !== 'function') {
    return [];
  }

  const bounds = {
    top: Math.max(SPAWN_EDGE_MIN, anchor.y - maximumScanRadius),
    left: Math.max(SPAWN_EDGE_MIN, anchor.x - maximumScanRadius),
    bottom: Math.min(SPAWN_EDGE_MAX, anchor.y + maximumScanRadius),
    right: Math.min(SPAWN_EDGE_MAX, anchor.x + maximumScanRadius)
  };

  try {
    const found = room.lookForAtArea(lookConstant as LookConstant, bounds.top, bounds.left, bounds.bottom, bounds.right, true);
    return Array.isArray(found) ? found : [];
  } catch {
    return [];
  }
}

function canPlaceSpawn(lookups: SpawnPlacementLookups, position: CandidatePosition): boolean {
  return (
    position.x >= SPAWN_EDGE_MIN &&
    position.x <= SPAWN_EDGE_MAX &&
    position.y >= SPAWN_EDGE_MIN &&
    position.y <= SPAWN_EDGE_MAX &&
    !lookups.blockingPositions.has(getPositionKey(position)) &&
    !lookups.mineralPositions.has(getPositionKey(position)) &&
    hasMinimumSpawnRange(lookups, position) &&
    !isTerrainWall(lookups.terrain, position)
  );
}

function hasMinimumSpawnRange(lookups: SpawnPlacementLookups, position: CandidatePosition): boolean {
  return lookups.rangeReservedPositions.every(
    (reservedPosition) => getRangeBetweenPositions(position, reservedPosition) >= 2
  );
}

function getSortedSources(room: Room): Source[] {
  return findRoomObjects<Source>(room, 'FIND_SOURCES')
    .filter((source) => {
      const position = getAnyObjectPosition(source);
      return position !== null && isSameRoomPosition(position, room.name);
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function findRoomObjects<T>(room: Room, globalName: FindConstantGlobal): T[] {
  const findConstant = getGlobalNumber(globalName);
  if (findConstant === null || typeof room.find !== 'function') {
    return [];
  }

  try {
    const found = room.find(findConstant as FindConstant);
    return Array.isArray(found) ? (found as T[]) : [];
  } catch {
    return [];
  }
}

function getAnyObjectPosition(object: unknown): CandidatePosition | null {
  if (!isRecord(object)) {
    return null;
  }

  if (isFiniteNumber(object.x) && isFiniteNumber(object.y)) {
    return {
      x: object.x,
      y: object.y,
      ...(typeof object.roomName === 'string' ? { roomName: object.roomName } : {})
    };
  }

  const position = object.pos;
  if (isRecord(position) && isFiniteNumber(position.x) && isFiniteNumber(position.y)) {
    return {
      x: position.x,
      y: position.y,
      ...(typeof position.roomName === 'string' ? { roomName: position.roomName } : {})
    };
  }

  for (const value of Object.values(object)) {
    const nestedPosition = getAnyObjectPosition(value);
    if (nestedPosition) {
      return nestedPosition;
    }
  }

  return null;
}

function isSameRoomPosition(position: CandidatePosition | null, roomName: string): boolean {
  return position !== null && (!position.roomName || position.roomName === roomName);
}

function getRangeBetweenPositions(left: CandidatePosition, right: CandidatePosition): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function isTerrainWall(terrain: RoomTerrain | null, position: CandidatePosition): boolean {
  return terrain !== null && (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  return typeof gameMap?.getRoomTerrain === 'function' ? gameMap.getRoomTerrain(room.name) : null;
}

function getMaximumSpawnSiteScanRadius(anchor: CandidatePosition): number {
  return Math.min(
    MAX_SPAWN_SITE_SCAN_RADIUS,
    Math.max(
      anchor.x - SPAWN_EDGE_MIN,
      SPAWN_EDGE_MAX - anchor.x,
      anchor.y - SPAWN_EDGE_MIN,
      SPAWN_EDGE_MAX - anchor.y
    )
  );
}

function clampSpawnPosition(position: CandidatePosition): CandidatePosition {
  return {
    x: Math.max(SPAWN_EDGE_MIN, Math.min(SPAWN_EDGE_MAX, position.x)),
    y: Math.max(SPAWN_EDGE_MIN, Math.min(SPAWN_EDGE_MAX, position.y)),
    roomName: position.roomName
  };
}

function isFatalConstructionSiteResult(result: ScreepsReturnCode): boolean {
  return (
    result === getGlobalReturnCode('ERR_FULL', ERR_FULL_CODE) ||
    result === getGlobalReturnCode('ERR_RCL_NOT_ENOUGH', ERR_RCL_NOT_ENOUGH_CODE)
  );
}

function getStructureConstant(globalName: StructureConstantGlobal): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, BuildableStructureConstant>>;
  return constants[globalName] ?? (STRUCTURE_TYPE_FALLBACKS[globalName] as BuildableStructureConstant);
}

function getGlobalNumber(name: FindConstantGlobal): number | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : null;
}

function getGlobalString(name: LookConstantGlobal): string | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

function getGlobalReturnCode(name: ReturnCodeGlobal, fallback: ScreepsReturnCode): ScreepsReturnCode {
  const value = (globalThis as Partial<Record<ReturnCodeGlobal, ScreepsReturnCode>>)[name];
  return typeof value === 'number' ? value : fallback;
}

function getTerrainWallMask(): number {
  const terrainWallMask = (globalThis as unknown as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof terrainWallMask === 'number' ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK;
}

function getOkCode(): ScreepsReturnCode {
  const ok = (globalThis as unknown as { OK?: ScreepsReturnCode }).OK;
  return typeof ok === 'number' ? ok : OK_CODE;
}

function getPositionKey(position: CandidatePosition): string {
  return `${position.x},${position.y}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
