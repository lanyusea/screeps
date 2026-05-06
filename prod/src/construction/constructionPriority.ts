import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  buildCriticalRoadLogisticsContext,
  isCriticalRoadLogisticsWork,
  type CriticalRoadLogisticsContext
} from './criticalRoads';
import { getExtensionLimitForRcl, planExtensionConstruction } from './extensionPlanner';
import { planEarlyRoadConstruction, type EarlyRoadPlannerOptions } from './roadPlanner';

export type ConstructionVisionLayer = 'survival' | 'territory' | 'resources' | 'enemyKills';

export type ConstructionPriorityObservation =
  | 'room-controller'
  | 'energy-capacity'
  | 'worker-count'
  | 'spawn-count'
  | 'construction-sites'
  | 'repair-decay'
  | 'hostile-presence'
  | 'sources'
  | 'territory-intents'
  | 'remote-paths';

export type ConstructionPriorityUrgency = 'blocked' | 'critical' | 'high' | 'medium' | 'low';

export type ConstructionPriorityBuildType =
  | 'spawn'
  | 'extension'
  | 'tower'
  | 'rampart'
  | 'road'
  | 'container'
  | 'storage'
  | 'remote-logistics'
  | 'observation';

export type ConstructionPriorityExposure = 'none' | 'low' | 'medium' | 'high';

export interface ConstructionPrioritySignals {
  survivalRecovery?: number;
  controllerDowngrade?: number;
  defense?: number;
  energyBottleneck?: number;
  repairDecay?: number;
  expansionPrerequisite?: number;
  harvestThroughput?: number;
  spawnUtilization?: number;
  rclAcceleration?: number;
  storageLogistics?: number;
  enemyKillPotential?: number;
}

export interface ConstructionPriorityRoomState {
  roomName: string;
  rcl?: number;
  energyAvailable?: number;
  energyCapacity?: number;
  workerCount?: number;
  spawnCount?: number;
  sourceCount?: number;
  extensionCount?: number;
  towerCount?: number;
  constructionSiteCount?: number;
  criticalRepairCount?: number;
  decayingStructureCount?: number;
  controllerTicksToDowngrade?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  activeTerritoryIntentCount?: number;
  plannedTerritoryIntentCount?: number;
  remoteLogisticsReady?: boolean;
  observations?: Partial<Record<ConstructionPriorityObservation, boolean>>;
}

export interface ConstructionBuildCandidate {
  buildItem: string;
  roomName?: string;
  buildType: ConstructionPriorityBuildType;
  status?: 'existing-site' | 'planned';
  minimumRcl?: number;
  minimumWorkers?: number;
  minimumEnergyCapacity?: number;
  requiresSafeHome?: boolean;
  requiredObservations?: ConstructionPriorityObservation[];
  preconditions?: string[];
  expectedKpiMovement: string[];
  risk?: string[];
  estimatedEnergyCost?: number;
  estimatedBuildTicks?: number;
  pathExposure?: ConstructionPriorityExposure;
  hostileExposure?: ConstructionPriorityExposure;
  signals?: ConstructionPrioritySignals;
  vision?: Partial<Record<ConstructionVisionLayer, number>>;
}

export interface ConstructionPriorityFactors {
  urgency: number;
  roomState: number;
  expansionPrerequisites: number;
  economicBenefit: number;
  visionWeight: number;
  riskCost: number;
}

export interface ConstructionPriorityScore {
  buildItem: string;
  room: string;
  score: number;
  urgency: ConstructionPriorityUrgency;
  preconditions: string[];
  expectedKpiMovement: string[];
  risk: string[];
  factors: ConstructionPriorityFactors;
  missingObservations: ConstructionPriorityObservation[];
  blocked: boolean;
}

export interface ConstructionPriorityReport {
  candidates: ConstructionPriorityScore[];
  nextPrimary: ConstructionPriorityScore | null;
}

export interface ConstructionPriorityPlanningOptions {
  maxContainerSitesPerTick?: number;
  maxPendingContainerSites?: number;
  roadOptions?: EarlyRoadPlannerOptions;
}

export interface ConstructionPriorityPlanningResult {
  sourceContainerResults: ScreepsReturnCode[];
  extensionResult: ScreepsReturnCode | null;
  towerResult: ScreepsReturnCode | null;
  roadResults: ScreepsReturnCode[];
  storageResult: ScreepsReturnCode | null;
}

export interface ConstructionSiteImpactPriorityContext {
  criticalRoadContext?: CriticalRoadLogisticsContext;
  claimedRoomName?: string;
  protectedRampartAnchors?: RoomPosition[];
  sources?: Source[];
}

export interface ImpactWeightedConstructionSiteSelectionOptions {
  reasonableRange?: number;
}

interface RuntimeConstructionPriorityState extends ConstructionPriorityRoomState {
  ownedConstructionSites: ConstructionSite[] | null;
  ownedStructures: AnyOwnedStructure[] | null;
  visibleStructures: AnyStructure[] | null;
}

interface SourceContainerPlannerLookups {
  blockingPositions: Set<string>;
  existingContainerPositions: PositionedRoomPosition[];
  pendingContainerPositions: PositionedRoomPosition[];
  terrain: RoomTerrain;
}

interface FixedStructurePlannerOptions {
  fallback: string;
  globalName: StructureConstantName;
  limit: number;
  maxScanRadius: number;
}

interface FixedStructurePlannerLookups {
  blockingPositions: Set<string>;
  terrain: RoomTerrain;
}

interface PositionedRoomPosition {
  x: number;
  y: number;
  roomName?: string;
}

const CONTROLLER_DOWNGRADE_CRITICAL_TICKS = 5_000;
const CONTROLLER_DOWNGRADE_WARNING_TICKS = 10_000;
const EARLY_ENERGY_CAPACITY_TARGET = 550;
const MIN_SAFE_WORKERS_FOR_EXPANSION = 3;
const MIN_RCL_FOR_AUTOMATED_CONSTRUCTION = 2;
const MIN_RCL_FOR_AUTOMATED_ROADS = 4;
const MIN_RCL_FOR_STORAGE = 4;
const STORAGE_STRUCTURE_LIMIT = 1;
const DEFAULT_MAX_CONTAINER_SITES_PER_TICK = 1;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const MAX_CRITICAL_STRUCTURE_SCAN_RADIUS = 8;
const TOWER_LIMITS_BY_RCL: Record<number, number> = {
  3: 1,
  4: 1,
  5: 2,
  6: 2,
  7: 3,
  8: 6
};
const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
export const DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE = 20;
const MAX_SCORE = 100;
const MAX_URGENCY_POINTS = 35;
const MAX_ROOM_STATE_POINTS = 20;
const MAX_EXPANSION_POINTS = 20;
const MAX_ECONOMIC_POINTS = 20;
const MAX_VISION_POINTS = 15;
const MAX_RISK_COST = 25;
const CRITICAL_REPAIR_HITS_RATIO = 0.5;
const DECAYING_REPAIR_HITS_RATIO = 0.8;
const IDLE_RAMPART_REPAIR_HITS_CEILING = 100_000;
export const CONSTRUCTION_SITE_IMPACT_PRIORITY = {
  claimedRoomSpawn: 110,
  extension: 100,
  spawn: 95,
  tower: 92,
  protectedRampart: 90,
  rampart: 85,
  sourceContainer: 70,
  criticalRoad: 80,
  road: 55,
  container: 45,
  other: 35,
  wall: 5
} as const;

const STRUCTURE_BUILD_COSTS: Partial<Record<ConstructionPriorityBuildType, number>> = {
  spawn: 15_000,
  extension: 3_000,
  tower: 5_000,
  rampart: 1,
  road: 300,
  container: 5_000,
  storage: 30_000,
  'remote-logistics': 5_000,
  observation: 0
};

const EXPOSURE_COST: Record<ConstructionPriorityExposure, number> = {
  none: 0,
  low: 2,
  medium: 5,
  high: 9
};

const OBSERVATION_LABELS: Record<ConstructionPriorityObservation, string> = {
  'room-controller': 'missing observation: room controller/RCL',
  'energy-capacity': 'missing observation: room energy capacity',
  'worker-count': 'missing observation: available worker count',
  'spawn-count': 'missing observation: spawn count',
  'construction-sites': 'missing observation: construction site backlog',
  'repair-decay': 'missing observation: repair/decay signals',
  'hostile-presence': 'missing observation: hostile pressure',
  sources: 'missing observation: source count',
  'territory-intents': 'missing observation: territory intent state',
  'remote-paths': 'missing observation: remote path/logistics exposure'
};

export function scoreConstructionPriorities(
  roomState: ConstructionPriorityRoomState,
  candidates: ConstructionBuildCandidate[]
): ConstructionPriorityReport {
  const scoredCandidates = candidates
    .map((candidate) => scoreConstructionCandidate(roomState, candidate))
    .sort(compareConstructionPriorityScores);

  return {
    candidates: scoredCandidates,
    nextPrimary: selectNextPrimaryConstruction(scoredCandidates)
  };
}

export function scoreConstructionCandidate(
  roomState: ConstructionPriorityRoomState,
  candidate: ConstructionBuildCandidate
): ConstructionPriorityScore {
  const missingObservations = getMissingObservations(roomState, candidate);
  const blockingPreconditions = getBlockingPreconditions(roomState, candidate, missingObservations);
  const preconditions = [
    ...(candidate.preconditions ?? []),
    ...missingObservations.map((observation) => OBSERVATION_LABELS[observation]),
    ...blockingPreconditions
  ];
  const blocked = missingObservations.length > 0 || blockingPreconditions.length > 0;

  if (blocked) {
    return {
      buildItem: candidate.buildItem,
      room: candidate.roomName ?? roomState.roomName,
      score: 0,
      urgency: 'blocked',
      preconditions,
      expectedKpiMovement: candidate.expectedKpiMovement,
      risk: candidate.risk ?? [],
      factors: {
        urgency: 0,
        roomState: 0,
        expansionPrerequisites: 0,
        economicBenefit: 0,
        visionWeight: 0,
        riskCost: 0
      },
      missingObservations,
      blocked
    };
  }

  const urgencyMagnitude = getUrgencyMagnitude(roomState, candidate);
  const factors: ConstructionPriorityFactors = {
    urgency: Math.round(urgencyMagnitude * MAX_URGENCY_POINTS),
    roomState: scoreRoomState(roomState, candidate),
    expansionPrerequisites: scoreExpansionPrerequisites(roomState, candidate),
    economicBenefit: scoreEconomicBenefit(roomState, candidate),
    visionWeight: scoreVisionWeight(candidate),
    riskCost: scoreRiskCost(roomState, candidate)
  };
  const rawScore =
    factors.urgency +
    factors.roomState +
    factors.expansionPrerequisites +
    factors.economicBenefit +
    factors.visionWeight -
    factors.riskCost;
  const gatedScore = applySurvivalGate(roomState, candidate, rawScore);
  const score = clampScore(Math.round(gatedScore));

  return {
    buildItem: candidate.buildItem,
    room: candidate.roomName ?? roomState.roomName,
    score,
    urgency: classifyUrgency(score, urgencyMagnitude),
    preconditions,
    expectedKpiMovement: candidate.expectedKpiMovement,
    risk: candidate.risk ?? [],
    factors,
    missingObservations,
    blocked
  };
}

export function selectNextPrimaryConstruction(
  candidates: ConstructionPriorityScore[]
): ConstructionPriorityScore | null {
  if (candidates.length === 0) {
    return null;
  }

  return candidates.find((candidate) => !candidate.blocked) ?? candidates[0];
}

export function buildConstructionSiteImpactPriorityContext(
  room: Room
): ConstructionSiteImpactPriorityContext {
  const ownedStructures = findRoomObjects(room, 'FIND_MY_STRUCTURES') as AnyOwnedStructure[] | null;
  const sources = findRoomObjects(room, 'FIND_SOURCES') as Source[] | null;

  return {
    criticalRoadContext: buildCriticalRoadLogisticsContext(room),
    ...(room.controller?.my === true ? { claimedRoomName: room.name } : {}),
    protectedRampartAnchors: getProtectedRampartAnchorPositions(room, ownedStructures),
    ...(sources === null ? {} : { sources })
  };
}

export function getConstructionSiteImpactPriority(
  site: ConstructionSite,
  context: ConstructionSiteImpactPriorityContext = {}
): number {
  if (matchesStructureType(site.structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return CONSTRUCTION_SITE_IMPACT_PRIORITY.extension;
  }

  if (matchesStructureType(site.structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return isClaimedRoomConstructionSite(site, context)
      ? CONSTRUCTION_SITE_IMPACT_PRIORITY.claimedRoomSpawn
      : CONSTRUCTION_SITE_IMPACT_PRIORITY.spawn;
  }

  if (matchesStructureType(site.structureType, 'STRUCTURE_CONTAINER', 'container')) {
    return isSourceContainerConstructionSite(site, context)
      ? CONSTRUCTION_SITE_IMPACT_PRIORITY.sourceContainer
      : CONSTRUCTION_SITE_IMPACT_PRIORITY.container;
  }

  if (matchesStructureType(site.structureType, 'STRUCTURE_ROAD', 'road')) {
    return context.criticalRoadContext && isCriticalRoadLogisticsWork(site, context.criticalRoadContext)
      ? CONSTRUCTION_SITE_IMPACT_PRIORITY.criticalRoad
      : CONSTRUCTION_SITE_IMPACT_PRIORITY.road;
  }

  if (matchesStructureType(site.structureType, 'STRUCTURE_TOWER', 'tower')) {
    return CONSTRUCTION_SITE_IMPACT_PRIORITY.tower;
  }

  if (matchesStructureType(site.structureType, 'STRUCTURE_RAMPART', 'rampart')) {
    return isProtectedRampartConstructionSite(site, context)
      ? CONSTRUCTION_SITE_IMPACT_PRIORITY.protectedRampart
      : CONSTRUCTION_SITE_IMPACT_PRIORITY.rampart;
  }

  if (isWallConstructionSite(site)) {
    return CONSTRUCTION_SITE_IMPACT_PRIORITY.wall;
  }

  return CONSTRUCTION_SITE_IMPACT_PRIORITY.other;
}

export function selectImpactWeightedConstructionSite(
  origin: RoomObject,
  constructionSites: ConstructionSite[],
  context: ConstructionSiteImpactPriorityContext = {},
  options: ImpactWeightedConstructionSiteSelectionOptions = {}
): ConstructionSite | null {
  const candidates = constructionSites.filter(hasIncompleteConstructionSiteProgress);
  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((left, right) =>
    compareImpactWeightedConstructionSites(origin, left, right, context, options)
  )[0];
}

export function buildRuntimeConstructionPriorityReport(
  colony: ColonySnapshot,
  creeps: Creep[]
): ConstructionPriorityReport {
  const state = buildRuntimeConstructionPriorityState(colony, creeps);
  return scoreConstructionPriorities(state, buildRuntimeConstructionCandidates(state));
}

export function planPriorityConstructionSites(
  colony: ColonySnapshot,
  options: ConstructionPriorityPlanningOptions = {}
): ConstructionPriorityPlanningResult {
  const rcl = getOwnedRoomRcl(colony.room);
  if (rcl < MIN_RCL_FOR_AUTOMATED_CONSTRUCTION) {
    return createEmptyConstructionPriorityPlanningResult();
  }

  const extensionResult = planExtensionConstruction(colony);
  if (extensionResult !== null) {
    return {
      ...createEmptyConstructionPriorityPlanningResult(),
      extensionResult
    };
  }

  const towerResult = planTowerConstruction(colony);
  if (towerResult !== null) {
    return {
      ...createEmptyConstructionPriorityPlanningResult(),
      towerResult
    };
  }

  const sourceContainerResults = planSourceContainerConstruction(colony, options);
  if (sourceContainerResults.length > 0) {
    return {
      ...createEmptyConstructionPriorityPlanningResult(),
      sourceContainerResults
    };
  }

  const roadResults = rcl >= MIN_RCL_FOR_AUTOMATED_ROADS ? planEarlyRoadConstruction(colony, options.roadOptions) : [];
  if (roadResults.length > 0) {
    return {
      ...createEmptyConstructionPriorityPlanningResult(),
      roadResults
    };
  }

  const storageResult = planStorageConstruction(colony);

  return {
    ...createEmptyConstructionPriorityPlanningResult(),
    storageResult
  };
}

export function planTowerConstruction(colony: ColonySnapshot): ScreepsReturnCode | null {
  const limit = getTowerLimitForRcl(getOwnedRoomRcl(colony.room));
  if (limit <= 0) {
    return null;
  }

  return planLimitedFixedStructureConstruction(colony, {
    globalName: 'STRUCTURE_TOWER',
    fallback: 'tower',
    limit,
    maxScanRadius: MAX_CRITICAL_STRUCTURE_SCAN_RADIUS
  });
}

export function planStorageConstruction(colony: ColonySnapshot): ScreepsReturnCode | null {
  if (getOwnedRoomRcl(colony.room) < MIN_RCL_FOR_STORAGE) {
    return null;
  }

  return planLimitedFixedStructureConstruction(colony, {
    globalName: 'STRUCTURE_STORAGE',
    fallback: 'storage',
    limit: STORAGE_STRUCTURE_LIMIT,
    maxScanRadius: MAX_CRITICAL_STRUCTURE_SCAN_RADIUS
  });
}

export function planSourceContainerConstruction(
  colony: ColonySnapshot,
  options: ConstructionPriorityPlanningOptions = {}
): ScreepsReturnCode[] {
  const room = colony.room;
  if (
    getOwnedRoomRcl(room) < MIN_RCL_FOR_AUTOMATED_CONSTRUCTION ||
    !hasRequiredSourceContainerPlannerApis(room)
  ) {
    return [];
  }

  const maxSitesPerTick = resolveNonNegativeInteger(
    options.maxContainerSitesPerTick,
    DEFAULT_MAX_CONTAINER_SITES_PER_TICK
  );
  if (maxSitesPerTick <= 0) {
    return [];
  }

  const sources = getSortedSources(room);
  if (sources.length === 0) {
    return [];
  }

  const lookups = createSourceContainerPlannerLookups(room, sources);
  if (!lookups) {
    return [];
  }

  const maxPendingContainerSites = resolveNonNegativeInteger(
    options.maxPendingContainerSites,
    sources.length
  );
  const pendingContainerSites = countPendingSourceContainers(sources, lookups);
  const remainingSiteBudget = Math.min(maxSitesPerTick, maxPendingContainerSites - pendingContainerSites);
  if (remainingSiteBudget <= 0) {
    return [];
  }

  const anchor = selectConstructionAnchor(colony);
  const results: ScreepsReturnCode[] = [];
  for (const source of sources) {
    if (results.length >= remainingSiteBudget) {
      break;
    }

    if (hasSourceContainerCoverage(source, lookups)) {
      continue;
    }

    const position = selectSourceContainerPosition(room.name, source, lookups, anchor);
    if (!position) {
      continue;
    }

    const result = room.createConstructionSite(position.x, position.y, getContainerStructureType());
    results.push(result);
    if (result !== getOkCode()) {
      break;
    }

    lookups.pendingContainerPositions.push(position);
    lookups.blockingPositions.add(getPositionKey(position));
  }

  return results;
}

function getOwnedRoomRcl(room: Room): number {
  const level = room.controller?.my === true ? room.controller.level : 0;
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

function createEmptyConstructionPriorityPlanningResult(): ConstructionPriorityPlanningResult {
  return {
    sourceContainerResults: [],
    extensionResult: null,
    towerResult: null,
    roadResults: [],
    storageResult: null
  };
}

function planLimitedFixedStructureConstruction(
  colony: ColonySnapshot,
  options: FixedStructurePlannerOptions
): ScreepsReturnCode | null {
  const room = colony.room;
  if (!hasRequiredFixedStructurePlannerApis(room)) {
    return null;
  }

  const plannedCount = countExistingAndPendingFixedStructures(room, options.globalName, options.fallback);
  if (plannedCount === null || plannedCount >= options.limit) {
    return null;
  }

  const anchor = selectFixedStructureAnchor(colony);
  if (!anchor) {
    return null;
  }

  const lookups = createFixedStructurePlannerLookups(room, anchor, options.maxScanRadius);
  if (!lookups) {
    return null;
  }

  const structureType = getBuildableStructureConstant(options.globalName, options.fallback);
  for (const position of getFixedStructureCandidatePositions(anchor, options.maxScanRadius)) {
    if (!canPlaceFixedStructure(lookups, position)) {
      continue;
    }

    const result = room.createConstructionSite(position.x, position.y, structureType);
    if (result === getOkCode()) {
      return result;
    }

    lookups.blockingPositions.add(getPositionKey(position));
  }

  return null;
}

function hasRequiredFixedStructurePlannerApis(room: Room): boolean {
  const partialRoom = room as Partial<Room>;
  return (
    typeof partialRoom.find === 'function' &&
    typeof partialRoom.lookForAtArea === 'function' &&
    typeof partialRoom.createConstructionSite === 'function'
  );
}

function countExistingAndPendingFixedStructures(
  room: Room,
  globalName: StructureConstantName,
  fallback: string
): number | null {
  const ownedStructures = findRoomObjects(room, 'FIND_MY_STRUCTURES') as AnyOwnedStructure[] | null;
  const ownedConstructionSites = findRoomObjects(room, 'FIND_MY_CONSTRUCTION_SITES') as ConstructionSite[] | null;
  if (ownedStructures === null || ownedConstructionSites === null) {
    return null;
  }

  return (
    ownedStructures.filter((structure) => matchesStructureType(structure.structureType, globalName, fallback)).length +
    ownedConstructionSites.filter((site) => matchesStructureType(String(site.structureType), globalName, fallback)).length
  );
}

function selectFixedStructureAnchor(colony: ColonySnapshot): PositionedRoomPosition | null {
  const [primarySpawn] = colony.spawns
    .filter((spawn) => getRoomObjectPosition(spawn) !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  return getRoomObjectPosition(primarySpawn) ?? getRoomObjectPosition(colony.room.controller);
}

function createFixedStructurePlannerLookups(
  room: Room,
  anchor: PositionedRoomPosition,
  maxScanRadius: number
): FixedStructurePlannerLookups | null {
  const terrain = getRoomTerrain(room);
  if (!terrain) {
    return null;
  }

  const blockingPositions = new Set<string>();
  for (const lookResult of [
    ...lookForAreaPositions(room, 'LOOK_STRUCTURES', anchor, maxScanRadius),
    ...lookForAreaPositions(room, 'LOOK_CONSTRUCTION_SITES', anchor, maxScanRadius)
  ]) {
    const position = getAreaLookPosition(lookResult);
    if (position) {
      blockingPositions.add(getPositionKey(position));
    }
  }

  return { blockingPositions, terrain };
}

function lookForAreaPositions(
  room: Room,
  lookConstantName: LookConstantName,
  anchor: PositionedRoomPosition,
  maxScanRadius: number
): unknown[] {
  const lookConstant = getLookConstant(lookConstantName);
  if (!lookConstant || typeof room.lookForAtArea !== 'function') {
    return [];
  }

  const bounds = {
    top: Math.max(ROOM_EDGE_MIN, anchor.y - maxScanRadius),
    left: Math.max(ROOM_EDGE_MIN, anchor.x - maxScanRadius),
    bottom: Math.min(ROOM_EDGE_MAX, anchor.y + maxScanRadius),
    right: Math.min(ROOM_EDGE_MAX, anchor.x + maxScanRadius)
  };

  try {
    const results = room.lookForAtArea(
      lookConstant as LookConstant,
      bounds.top,
      bounds.left,
      bounds.bottom,
      bounds.right,
      true
    );
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

function getAreaLookPosition(lookResult: unknown): PositionedRoomPosition | null {
  const coordinatePosition = getAreaLookCoordinatePosition(lookResult);
  if (coordinatePosition !== null) {
    return coordinatePosition;
  }

  const roomObjectPosition = getRoomObjectPosition(lookResult as RoomObject | undefined);
  if (roomObjectPosition !== null) {
    return roomObjectPosition;
  }

  if (!isRecord(lookResult)) {
    return null;
  }

  for (const value of Object.values(lookResult)) {
    const nestedPosition = getRoomObjectPosition(value as RoomObject | undefined);
    if (nestedPosition !== null) {
      return nestedPosition;
    }
  }

  return null;
}

function getAreaLookCoordinatePosition(lookResult: unknown): PositionedRoomPosition | null {
  if (!isRecord(lookResult)) {
    return null;
  }

  const { x, y, roomName } = lookResult;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }

  return {
    x,
    y,
    ...(typeof roomName === 'string' ? { roomName } : {})
  };
}

function getFixedStructureCandidatePositions(
  anchor: PositionedRoomPosition,
  maxScanRadius: number
): PositionedRoomPosition[] {
  const positions: PositionedRoomPosition[] = [];
  for (let radius = 1; radius <= maxScanRadius; radius += 1) {
    for (let y = anchor.y - radius; y <= anchor.y + radius; y += 1) {
      for (let x = anchor.x - radius; x <= anchor.x + radius; x += 1) {
        if (Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) !== radius) {
          continue;
        }

        positions.push({ x, y, roomName: anchor.roomName });
      }
    }
  }

  return positions;
}

function canPlaceFixedStructure(
  lookups: FixedStructurePlannerLookups,
  position: PositionedRoomPosition
): boolean {
  return (
    isWithinBuildableRoomBounds(position) &&
    !isTerrainWall(lookups.terrain, position) &&
    !lookups.blockingPositions.has(getPositionKey(position))
  );
}

function hasRequiredSourceContainerPlannerApis(room: Room): boolean {
  return (
    typeof room.find === 'function' &&
    typeof room.createConstructionSite === 'function' &&
    getFindConstant('FIND_SOURCES') !== null &&
    getFindConstant('FIND_STRUCTURES') !== null &&
    getFindConstant('FIND_CONSTRUCTION_SITES') !== null
  );
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function getSortedSources(room: Room): Source[] {
  const sources = findRoomObjects(room, 'FIND_SOURCES') as Source[] | null;
  return (sources ?? [])
    .filter((source) => isSameRoomPosition(getRoomObjectPosition(source), room.name))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function createSourceContainerPlannerLookups(
  room: Room,
  sources: Source[]
): SourceContainerPlannerLookups | null {
  const terrain = getRoomTerrain(room);
  const structures = findRoomObjects(room, 'FIND_STRUCTURES') as Structure[] | null;
  const constructionSites = findRoomObjects(room, 'FIND_CONSTRUCTION_SITES') as ConstructionSite[] | null;
  if (!terrain || structures === null || constructionSites === null) {
    return null;
  }

  const lookups: SourceContainerPlannerLookups = {
    blockingPositions: new Set<string>(),
    existingContainerPositions: [],
    pendingContainerPositions: [],
    terrain
  };

  for (const source of sources) {
    addBlockingPosition(lookups, getRoomObjectPosition(source));
  }

  for (const structure of structures) {
    const position = getRoomObjectPosition(structure);
    addBlockingPosition(lookups, position);
    if (matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container')) {
      addPosition(lookups.existingContainerPositions, position);
    }
  }

  for (const site of constructionSites) {
    const position = getRoomObjectPosition(site);
    addBlockingPosition(lookups, position);
    if (matchesStructureType(site.structureType, 'STRUCTURE_CONTAINER', 'container')) {
      addPosition(lookups.pendingContainerPositions, position);
    }
  }

  return lookups;
}

function addBlockingPosition(
  lookups: SourceContainerPlannerLookups,
  position: PositionedRoomPosition | null
): void {
  if (position) {
    lookups.blockingPositions.add(getPositionKey(position));
  }
}

function addPosition(positions: PositionedRoomPosition[], position: PositionedRoomPosition | null): void {
  if (position) {
    positions.push(position);
  }
}

function countPendingSourceContainers(
  sources: Source[],
  lookups: SourceContainerPlannerLookups
): number {
  return lookups.pendingContainerPositions.filter((position) =>
    sources.some((source) => isNearRoomObject(source, position))
  ).length;
}

function hasSourceContainerCoverage(source: Source, lookups: SourceContainerPlannerLookups): boolean {
  return (
    lookups.existingContainerPositions.some((position) => isNearRoomObject(source, position)) ||
    lookups.pendingContainerPositions.some((position) => isNearRoomObject(source, position))
  );
}

function selectSourceContainerPosition(
  roomName: string,
  source: Source,
  lookups: SourceContainerPlannerLookups,
  anchor: PositionedRoomPosition | null
): PositionedRoomPosition | null {
  const sourcePosition = getRoomObjectPosition(source);
  if (!isSameRoomPosition(sourcePosition, roomName)) {
    return null;
  }

  const candidates = getAdjacentBuildPositions(sourcePosition, roomName)
    .filter((position) => canPlaceSourceContainer(lookups, position))
    .sort((left, right) => compareSourceContainerPositions(left, right, anchor));

  return candidates[0] ?? null;
}

function getAdjacentBuildPositions(
  center: PositionedRoomPosition,
  roomName: string
): PositionedRoomPosition[] {
  const positions: PositionedRoomPosition[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      positions.push({ x: center.x + dx, y: center.y + dy, roomName });
    }
  }

  return positions;
}

function canPlaceSourceContainer(
  lookups: SourceContainerPlannerLookups,
  position: PositionedRoomPosition
): boolean {
  return (
    isWithinBuildableRoomBounds(position) &&
    !isTerrainWall(lookups.terrain, position) &&
    !lookups.blockingPositions.has(getPositionKey(position))
  );
}

function compareSourceContainerPositions(
  left: PositionedRoomPosition,
  right: PositionedRoomPosition,
  anchor: PositionedRoomPosition | null
): number {
  return (
    compareOptionalNumber(getRangeBetweenPositions(left, anchor), getRangeBetweenPositions(right, anchor)) ||
    left.y - right.y ||
    left.x - right.x
  );
}

function selectConstructionAnchor(colony: ColonySnapshot): PositionedRoomPosition | null {
  const [primarySpawn] = colony.spawns
    .filter((spawn) => getRoomObjectPosition(spawn) !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  return getRoomObjectPosition(primarySpawn) ?? getRoomObjectPosition(colony.room.controller);
}

function isNearRoomObject(
  object: RoomObject,
  position: PositionedRoomPosition
): boolean {
  const objectPosition = getRoomObjectPosition(object);
  const range = getRangeBetweenPositions(objectPosition, position);
  return (
    isSameRoomPosition(objectPosition, position.roomName) &&
    range !== null &&
    range <= 1
  );
}

function compareImpactWeightedConstructionSites(
  origin: RoomObject,
  left: ConstructionSite,
  right: ConstructionSite,
  context: ConstructionSiteImpactPriorityContext,
  options: ImpactWeightedConstructionSiteSelectionOptions
): number {
  return (
    getConstructionSiteImpactPriority(right, context) - getConstructionSiteImpactPriority(left, context) ||
    compareConstructionSiteReasonableRange(origin, left, right, options.reasonableRange) ||
    compareOptionalNumber(getRangeToRoomObject(origin, left), getRangeToRoomObject(origin, right)) ||
    compareConstructionSiteStableId(left, right)
  );
}

function compareConstructionSiteReasonableRange(
  origin: RoomObject,
  left: ConstructionSite,
  right: ConstructionSite,
  reasonableRange = DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE
): number {
  const leftInRange = isConstructionSiteWithinReasonableRange(origin, left, reasonableRange);
  const rightInRange = isConstructionSiteWithinReasonableRange(origin, right, reasonableRange);
  if (leftInRange === rightInRange) {
    return 0;
  }

  return leftInRange ? -1 : 1;
}

function isConstructionSiteWithinReasonableRange(
  origin: RoomObject,
  site: ConstructionSite,
  reasonableRange = DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE
): boolean {
  const range = getRangeToRoomObject(origin, site);
  return range === null || range <= reasonableRange;
}

function getRangeToRoomObject(origin: RoomObject, target: RoomObject): number | null {
  const getRangeTo = (origin as RoomObject & {
    pos?: { getRangeTo?: (target: RoomObject) => number };
  }).pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return null;
  }

  try {
    const range = getRangeTo.call((origin as RoomObject).pos, target);
    return typeof range === 'number' && Number.isFinite(range) ? range : null;
  } catch {
    return null;
  }
}

function compareConstructionSiteStableId(left: ConstructionSite, right: ConstructionSite): number {
  return String(left.id).localeCompare(String(right.id));
}

function hasIncompleteConstructionSiteProgress(site: ConstructionSite): boolean {
  const progress = (site as ConstructionSite & { progress?: number }).progress;
  const progressTotal = (site as ConstructionSite & { progressTotal?: number }).progressTotal;
  if (
    typeof progress !== 'number' ||
    typeof progressTotal !== 'number' ||
    !Number.isFinite(progress) ||
    !Number.isFinite(progressTotal)
  ) {
    return true;
  }

  return progress < progressTotal;
}

function isSourceContainerConstructionSite(
  site: ConstructionSite,
  context: ConstructionSiteImpactPriorityContext
): boolean {
  const sitePosition = getRoomObjectPosition(site);
  if (!sitePosition || !context.sources || context.sources.length === 0) {
    return false;
  }

  return context.sources.some((source) => isNearRoomObject(source, sitePosition));
}

function isClaimedRoomConstructionSite(
  site: ConstructionSite,
  context: ConstructionSiteImpactPriorityContext
): boolean {
  const siteRoom = (site as ConstructionSite & { room?: Room }).room;
  if (siteRoom?.controller?.my === true) {
    return true;
  }

  return context.claimedRoomName !== undefined && isSameRoomPosition(getRoomObjectPosition(site), context.claimedRoomName);
}

function isProtectedRampartConstructionSite(
  site: ConstructionSite,
  context: ConstructionSiteImpactPriorityContext
): boolean {
  const sitePosition = getRoomObjectPosition(site);
  if (!sitePosition || !context.protectedRampartAnchors || context.protectedRampartAnchors.length === 0) {
    return false;
  }

  return context.protectedRampartAnchors.some((anchor) => {
    const range = getRangeBetweenPositions(sitePosition, anchor);
    return range !== null && range <= 2;
  });
}

function isWallConstructionSite(site: ConstructionSite): boolean {
  return (
    matchesStructureType(site.structureType, 'STRUCTURE_WALL', 'constructedWall') ||
    String(site.structureType) === 'wall'
  );
}

function getProtectedRampartAnchorPositions(
  room: Room,
  ownedStructures: AnyOwnedStructure[] | null
): RoomPosition[] {
  const anchors: RoomPosition[] = [];
  const controllerPosition = room.controller?.pos;
  if (controllerPosition && isSameRoomPosition(controllerPosition, room.name)) {
    anchors.push(controllerPosition);
  }

  for (const structure of ownedStructures ?? []) {
    if (
      matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') &&
      isSameRoomPosition(structure.pos ?? null, room.name)
    ) {
      anchors.push(structure.pos);
    }
  }

  return anchors;
}

function getRoomObjectPosition(object: RoomObject | undefined): PositionedRoomPosition | null {
  const position = object?.pos as PositionedRoomPosition | undefined;
  if (
    !position ||
    typeof position.x !== 'number' ||
    typeof position.y !== 'number' ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y)
  ) {
    return null;
  }

  return {
    x: position.x,
    y: position.y,
    ...(typeof position.roomName === 'string' ? { roomName: position.roomName } : {})
  };
}

function isSameRoomPosition(position: PositionedRoomPosition | null, roomName: string | undefined): position is PositionedRoomPosition {
  return (
    position !== null &&
    (!position.roomName || !roomName || position.roomName === roomName)
  );
}

function isWithinBuildableRoomBounds(position: PositionedRoomPosition): boolean {
  return (
    position.x >= ROOM_EDGE_MIN &&
    position.x <= ROOM_EDGE_MAX &&
    position.y >= ROOM_EDGE_MIN &&
    position.y <= ROOM_EDGE_MAX
  );
}

function getRangeBetweenPositions(
  left: PositionedRoomPosition | null,
  right: PositionedRoomPosition | null
): number | null {
  if (!left || !right) {
    return null;
  }

  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function compareOptionalNumber(left: number | null, right: number | null): number {
  if (left !== null && right !== null) {
    return left - right;
  }

  if (left !== null) {
    return -1;
  }

  if (right !== null) {
    return 1;
  }

  return 0;
}

function isTerrainWall(terrain: RoomTerrain, position: PositionedRoomPosition): boolean {
  return (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const game = (globalThis as unknown as { Game?: Partial<Game> }).Game;
  if (!game?.map || typeof game.map.getRoomTerrain !== 'function') {
    return null;
  }

  return game.map.getRoomTerrain(room.name);
}

function getPositionKey(position: PositionedRoomPosition): string {
  return `${position.x},${position.y}`;
}

function getContainerStructureType(): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<Record<'STRUCTURE_CONTAINER', BuildableStructureConstant>>;
  return constants.STRUCTURE_CONTAINER ?? ('container' as BuildableStructureConstant);
}

function getTerrainWallMask(): number {
  return typeof TERRAIN_MASK_WALL === 'number' ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK;
}

function getOkCode(): ScreepsReturnCode {
  return (typeof OK === 'number' ? OK : 0) as ScreepsReturnCode;
}

function getMissingObservations(
  roomState: ConstructionPriorityRoomState,
  candidate: ConstructionBuildCandidate
): ConstructionPriorityObservation[] {
  return (candidate.requiredObservations ?? []).filter((observation) => !hasObservation(roomState, observation));
}

function hasObservation(
  roomState: ConstructionPriorityRoomState,
  observation: ConstructionPriorityObservation
): boolean {
  const explicitObservation = roomState.observations?.[observation];
  if (typeof explicitObservation === 'boolean') {
    return explicitObservation;
  }

  switch (observation) {
    case 'room-controller':
      return typeof roomState.rcl === 'number';
    case 'energy-capacity':
      return typeof roomState.energyCapacity === 'number';
    case 'worker-count':
      return typeof roomState.workerCount === 'number';
    case 'spawn-count':
      return typeof roomState.spawnCount === 'number';
    case 'construction-sites':
      return typeof roomState.constructionSiteCount === 'number';
    case 'repair-decay':
      return typeof roomState.criticalRepairCount === 'number' && typeof roomState.decayingStructureCount === 'number';
    case 'hostile-presence':
      return typeof roomState.hostileCreepCount === 'number' && typeof roomState.hostileStructureCount === 'number';
    case 'sources':
      return typeof roomState.sourceCount === 'number';
    case 'territory-intents':
      return typeof roomState.activeTerritoryIntentCount === 'number' && typeof roomState.plannedTerritoryIntentCount === 'number';
    case 'remote-paths':
      return roomState.remoteLogisticsReady === true;
    default:
      return false;
  }
}

function getBlockingPreconditions(
  roomState: ConstructionPriorityRoomState,
  candidate: ConstructionBuildCandidate,
  missingObservations: ConstructionPriorityObservation[]
): string[] {
  if (missingObservations.length > 0) {
    return [];
  }

  const preconditions: string[] = [];
  if (typeof candidate.minimumRcl === 'number' && (roomState.rcl ?? 0) < candidate.minimumRcl) {
    preconditions.push(`requires RCL ${candidate.minimumRcl} (current RCL ${roomState.rcl ?? 'unknown'})`);
  }

  if (typeof candidate.minimumWorkers === 'number' && (roomState.workerCount ?? 0) < candidate.minimumWorkers) {
    preconditions.push(`needs ${candidate.minimumWorkers} available workers (current ${roomState.workerCount ?? 'unknown'})`);
  }

  if (
    typeof candidate.minimumEnergyCapacity === 'number' &&
    (roomState.energyCapacity ?? 0) < candidate.minimumEnergyCapacity
  ) {
    preconditions.push(
      `needs ${candidate.minimumEnergyCapacity} energy capacity (current ${roomState.energyCapacity ?? 'unknown'})`
    );
  }

  if (candidate.requiresSafeHome && hasSurvivalPressure(roomState)) {
    preconditions.push('resolve survival/recovery pressure before expansion construction');
  }

  return preconditions;
}

function getUrgencyMagnitude(
  roomState: ConstructionPriorityRoomState,
  candidate: ConstructionBuildCandidate
): number {
  const signals = candidate.signals ?? {};
  const recoveryUrgency = Math.max(
    normalizeSignal(signals.survivalRecovery),
    isRecoveryCandidate(candidate) ? getWorkerRecoveryPressure(roomState) : 0
  );
  const downgradeUrgency = Math.max(
    normalizeSignal(signals.controllerDowngrade),
    isControllerProtectionCandidate(candidate) ? getControllerDowngradePressure(roomState) : 0
  );
  const defenseUrgency = Math.max(
    normalizeSignal(signals.defense),
    isDefenseCandidate(candidate) ? getDefensePressure(roomState) : 0
  );
  const energyUrgency = Math.max(
    normalizeSignal(signals.energyBottleneck),
    isEnergyCapacityCandidate(candidate) ? getEnergyBottleneckPressure(roomState) : 0
  );
  const repairUrgency = Math.max(
    normalizeSignal(signals.repairDecay),
    isRepairSupportCandidate(candidate) ? getRepairDecayPressure(roomState) : 0
  );

  return Math.max(recoveryUrgency, downgradeUrgency, defenseUrgency, energyUrgency, repairUrgency);
}

function scoreRoomState(roomState: ConstructionPriorityRoomState, candidate: ConstructionBuildCandidate): number {
  let score = 0;

  if (candidate.status === 'existing-site') {
    score += 4;
  }

  if (typeof roomState.rcl === 'number' && (!candidate.minimumRcl || roomState.rcl >= candidate.minimumRcl)) {
    score += Math.min(5, Math.max(1, roomState.rcl));
  }

  if (isRecoveryCandidate(candidate)) {
    score += Math.round(getWorkerRecoveryPressure(roomState) * 7);
  } else if ((roomState.workerCount ?? 0) >= MIN_SAFE_WORKERS_FOR_EXPANSION) {
    score += 4;
  }

  if (isEnergyCapacityCandidate(candidate) && (roomState.energyCapacity ?? EARLY_ENERGY_CAPACITY_TARGET) < EARLY_ENERGY_CAPACITY_TARGET) {
    score += 4;
  }

  if (isRepairSupportCandidate(candidate)) {
    score += Math.min(4, (roomState.criticalRepairCount ?? 0) * 2 + (roomState.decayingStructureCount ?? 0));
  }

  if (isDefenseCandidate(candidate)) {
    score += Math.round(getDefensePressure(roomState) * 5);
  }

  if ((roomState.constructionSiteCount ?? 0) > 0 && candidate.status === 'existing-site') {
    score += 2;
  }

  return Math.min(MAX_ROOM_STATE_POINTS, score);
}

function scoreExpansionPrerequisites(
  roomState: ConstructionPriorityRoomState,
  candidate: ConstructionBuildCandidate
): number {
  const signal = normalizeSignal(candidate.signals?.expansionPrerequisite);
  const territoryIntentPressure = Math.min(
    1,
    ((roomState.activeTerritoryIntentCount ?? 0) * 0.7) + ((roomState.plannedTerritoryIntentCount ?? 0) * 0.45)
  );
  const structureMultiplier =
    candidate.buildType === 'remote-logistics' ||
    candidate.buildType === 'road' ||
    candidate.buildType === 'container' ||
    candidate.buildType === 'tower' ||
    candidate.buildType === 'rampart'
      ? 1
      : 0.35;

  return Math.min(
    MAX_EXPANSION_POINTS,
    Math.round(signal * 14 + territoryIntentPressure * structureMultiplier * 6)
  );
}

function scoreEconomicBenefit(
  roomState: ConstructionPriorityRoomState,
  candidate: ConstructionBuildCandidate
): number {
  const signals = candidate.signals ?? {};
  const score =
    normalizeSignal(signals.harvestThroughput) * 8 +
    normalizeSignal(signals.spawnUtilization) * 5 +
    normalizeSignal(signals.rclAcceleration) * 5 +
    normalizeSignal(signals.storageLogistics) * 4 +
    normalizeSignal(signals.energyBottleneck) * 4 +
    getSourceBenefit(roomState, candidate);

  return Math.min(MAX_ECONOMIC_POINTS, Math.round(score));
}

function scoreVisionWeight(candidate: ConstructionBuildCandidate): number {
  const vision = candidate.vision ?? {};
  const score =
    normalizeSignal(vision.survival) * 15 +
    normalizeSignal(vision.territory) * 13 +
    normalizeSignal(vision.resources) * 9 +
    normalizeSignal(vision.enemyKills) * 5;

  return Math.min(MAX_VISION_POINTS, Math.round(score));
}

function scoreRiskCost(roomState: ConstructionPriorityRoomState, candidate: ConstructionBuildCandidate): number {
  const energyCost = candidate.estimatedEnergyCost ?? STRUCTURE_BUILD_COSTS[candidate.buildType] ?? 0;
  const buildTicks = candidate.estimatedBuildTicks ?? 0;
  const energyRisk = Math.min(8, energyCost / 4_000);
  const buildTimeRisk = Math.min(5, buildTicks / 1_500);
  const exposureRisk =
    EXPOSURE_COST[candidate.pathExposure ?? 'none'] + EXPOSURE_COST[candidate.hostileExposure ?? 'none'];
  const backlogRisk = Math.max(0, ((roomState.constructionSiteCount ?? 0) - 3) * 1.5);
  const hostilePressureRisk = (roomState.hostileCreepCount ?? 0) > 0 && !isDefenseCandidate(candidate) ? 4 : 0;
  const lowWorkerRisk =
    (roomState.workerCount ?? MIN_SAFE_WORKERS_FOR_EXPANSION) < MIN_SAFE_WORKERS_FOR_EXPANSION &&
    !isSurvivalCandidate(candidate)
      ? 4
      : 0;

  return Math.min(
    MAX_RISK_COST,
    Math.round(energyRisk + buildTimeRisk + exposureRisk + backlogRisk + hostilePressureRisk + lowWorkerRisk)
  );
}

function applySurvivalGate(
  roomState: ConstructionPriorityRoomState,
  candidate: ConstructionBuildCandidate,
  rawScore: number
): number {
  if (!hasSurvivalPressure(roomState) || isSurvivalCandidate(candidate)) {
    return rawScore;
  }

  const hardRecoveryPressure =
    (roomState.workerCount ?? MIN_SAFE_WORKERS_FOR_EXPANSION) === 0 ||
    (roomState.spawnCount ?? 1) === 0 ||
    getControllerDowngradePressure(roomState) >= 0.85 ||
    getDefensePressure(roomState) >= 0.9;

  return Math.min(rawScore, hardRecoveryPressure ? 45 : 60);
}

function classifyUrgency(score: number, urgencyMagnitude: number): ConstructionPriorityUrgency {
  if (score >= 85 || urgencyMagnitude >= 0.9) {
    return 'critical';
  }

  if (score >= 70 || urgencyMagnitude >= 0.7) {
    return 'high';
  }

  if (score >= 45 || urgencyMagnitude >= 0.4) {
    return 'medium';
  }

  return 'low';
}

function compareConstructionPriorityScores(
  left: ConstructionPriorityScore,
  right: ConstructionPriorityScore
): number {
  if (left.blocked !== right.blocked) {
    return left.blocked ? 1 : -1;
  }

  return (
    right.score - left.score ||
    urgencyRank(right.urgency) - urgencyRank(left.urgency) ||
    right.factors.visionWeight - left.factors.visionWeight ||
    left.buildItem.localeCompare(right.buildItem) ||
    left.room.localeCompare(right.room)
  );
}

function urgencyRank(urgency: ConstructionPriorityUrgency): number {
  switch (urgency) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    case 'blocked':
      return 0;
    default:
      return 0;
  }
}

function hasSurvivalPressure(roomState: ConstructionPriorityRoomState): boolean {
  return (
    (roomState.workerCount ?? MIN_SAFE_WORKERS_FOR_EXPANSION) === 0 ||
    (roomState.spawnCount ?? 1) === 0 ||
    getControllerDowngradePressure(roomState) >= 0.7 ||
    getDefensePressure(roomState) >= 0.7
  );
}

function isSurvivalCandidate(candidate: ConstructionBuildCandidate): boolean {
  return isRecoveryCandidate(candidate) || isDefenseCandidate(candidate) || isControllerProtectionCandidate(candidate);
}

function isRecoveryCandidate(candidate: ConstructionBuildCandidate): boolean {
  return (
    candidate.buildType === 'spawn' ||
    normalizeSignal(candidate.signals?.survivalRecovery) > 0
  );
}

function isControllerProtectionCandidate(candidate: ConstructionBuildCandidate): boolean {
  return (
    candidate.buildType === 'container' ||
    candidate.buildType === 'road' ||
    normalizeSignal(candidate.signals?.controllerDowngrade) > 0
  );
}

function isDefenseCandidate(candidate: ConstructionBuildCandidate): boolean {
  return (
    candidate.buildType === 'tower' ||
    candidate.buildType === 'rampart' ||
    normalizeSignal(candidate.signals?.defense) > 0
  );
}

function isEnergyCapacityCandidate(candidate: ConstructionBuildCandidate): boolean {
  return candidate.buildType === 'extension' || normalizeSignal(candidate.signals?.energyBottleneck) > 0;
}

function isRepairSupportCandidate(candidate: ConstructionBuildCandidate): boolean {
  return (
    candidate.buildType === 'road' ||
    candidate.buildType === 'container' ||
    candidate.buildType === 'rampart' ||
    normalizeSignal(candidate.signals?.repairDecay) > 0
  );
}

function getWorkerRecoveryPressure(roomState: ConstructionPriorityRoomState): number {
  if (roomState.spawnCount === 0) {
    return 1;
  }

  const workerCount = roomState.workerCount;
  if (typeof workerCount !== 'number') {
    return 0;
  }

  if (workerCount <= 0) {
    return 1;
  }

  if (workerCount === 1) {
    return 0.65;
  }

  if (workerCount === 2) {
    return 0.35;
  }

  return 0;
}

function getControllerDowngradePressure(roomState: ConstructionPriorityRoomState): number {
  const ticksToDowngrade = roomState.controllerTicksToDowngrade;
  if (typeof ticksToDowngrade !== 'number') {
    return 0;
  }

  if (ticksToDowngrade <= 1_000) {
    return 1;
  }

  if (ticksToDowngrade <= CONTROLLER_DOWNGRADE_CRITICAL_TICKS) {
    return 0.85;
  }

  if (ticksToDowngrade <= CONTROLLER_DOWNGRADE_WARNING_TICKS) {
    return 0.35;
  }

  return 0;
}

function getDefensePressure(roomState: ConstructionPriorityRoomState): number {
  if ((roomState.hostileCreepCount ?? 0) > 0) {
    return 0.9;
  }

  if ((roomState.hostileStructureCount ?? 0) > 0) {
    return 0.55;
  }

  return 0;
}

function getEnergyBottleneckPressure(roomState: ConstructionPriorityRoomState): number {
  const energyCapacity = roomState.energyCapacity;
  if (typeof energyCapacity !== 'number') {
    return 0;
  }

  if (energyCapacity < 350) {
    return 0.85;
  }

  if (energyCapacity < EARLY_ENERGY_CAPACITY_TARGET) {
    return 0.65;
  }

  return 0;
}

function getRepairDecayPressure(roomState: ConstructionPriorityRoomState): number {
  if ((roomState.criticalRepairCount ?? 0) > 0) {
    return 0.7;
  }

  if ((roomState.decayingStructureCount ?? 0) > 0) {
    return 0.35;
  }

  return 0;
}

function getSourceBenefit(roomState: ConstructionPriorityRoomState, candidate: ConstructionBuildCandidate): number {
  if (candidate.buildType !== 'container' && candidate.buildType !== 'road' && candidate.buildType !== 'remote-logistics') {
    return 0;
  }

  return Math.min(3, roomState.sourceCount ?? 0);
}

function normalizeSignal(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(MAX_SCORE, score));
}

function buildRuntimeConstructionPriorityState(
  colony: ColonySnapshot,
  creeps: Creep[]
): RuntimeConstructionPriorityState {
  const room = colony.room;
  const ownedConstructionSites = findRoomObjects(room, 'FIND_MY_CONSTRUCTION_SITES') as ConstructionSite[] | null;
  const ownedStructures = findRoomObjects(room, 'FIND_MY_STRUCTURES') as AnyOwnedStructure[] | null;
  const visibleStructures = findRoomObjects(room, 'FIND_STRUCTURES') as AnyStructure[] | null;
  const hostileCreeps = findRoomObjects(room, 'FIND_HOSTILE_CREEPS') as Creep[] | null;
  const hostileStructures = findRoomObjects(room, 'FIND_HOSTILE_STRUCTURES') as Structure[] | null;
  const sources = findRoomObjects(room, 'FIND_SOURCES') as Source[] | null;
  const colonyWorkers = creeps.filter((creep) => creep.memory?.role === 'worker' && creep.memory?.colony === room.name);
  const repairSignals = summarizeRepairSignals(visibleStructures, buildCriticalRoadLogisticsContext(room));
  const territoryIntentCounts = countTerritoryIntents(room.name);

  return {
    roomName: room.name,
    rcl: room.controller?.my === true ? room.controller.level : undefined,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnCount: colony.spawns.length,
    sourceCount: sources?.length,
    extensionCount: countStructuresByType(ownedStructures, 'STRUCTURE_EXTENSION', 'extension'),
    towerCount: countStructuresByType(ownedStructures, 'STRUCTURE_TOWER', 'tower'),
    constructionSiteCount: ownedConstructionSites?.length,
    criticalRepairCount: repairSignals?.criticalRepairCount,
    decayingStructureCount: repairSignals?.decayingStructureCount,
    controllerTicksToDowngrade: room.controller?.my === true ? room.controller.ticksToDowngrade : undefined,
    hostileCreepCount: hostileCreeps?.length,
    hostileStructureCount: hostileStructures?.length,
    activeTerritoryIntentCount: territoryIntentCounts.active,
    plannedTerritoryIntentCount: territoryIntentCounts.planned,
    remoteLogisticsReady: false,
    observations: {
      'room-controller': room.controller?.my === true && typeof room.controller.level === 'number',
      'energy-capacity': typeof colony.energyCapacityAvailable === 'number',
      'worker-count': true,
      'spawn-count': true,
      'construction-sites': ownedConstructionSites !== null,
      'repair-decay': visibleStructures !== null,
      'hostile-presence': hostileCreeps !== null && hostileStructures !== null,
      sources: sources !== null,
      'territory-intents': true,
      'remote-paths': false
    },
    ownedConstructionSites,
    ownedStructures,
    visibleStructures
  };
}

function buildRuntimeConstructionCandidates(state: RuntimeConstructionPriorityState): ConstructionBuildCandidate[] {
  const candidates = [
    ...buildExistingSiteCandidates(state),
    ...buildPlannedLocalCandidates(state),
    ...buildRemoteLogisticsCandidates(state)
  ];

  if (candidates.length > 0) {
    return candidates;
  }

  return [
    {
      buildItem: 'observe construction backlog',
      buildType: 'observation',
      requiredObservations: ['construction-sites'],
      expectedKpiMovement: ['construction priority table becomes evidence-backed'],
      risk: ['no build action should be selected until construction-site observations exist'],
      vision: { resources: 0.2 }
    }
  ];
}

function buildExistingSiteCandidates(state: RuntimeConstructionPriorityState): ConstructionBuildCandidate[] {
  return (state.ownedConstructionSites ?? []).map((site) => {
    const buildType = mapStructureTypeToBuildType(String(site.structureType));
    return {
      ...createCandidateForBuildType(buildType, state),
      buildItem: `finish ${site.structureType} site`,
      status: 'existing-site' as const,
      estimatedEnergyCost: getConstructionSiteRemainingProgress(site)
    };
  });
}

function buildPlannedLocalCandidates(state: RuntimeConstructionPriorityState): ConstructionBuildCandidate[] {
  const candidates: ConstructionBuildCandidate[] = [];
  const rcl = state.rcl ?? 0;
  const extensionLimit = getExtensionLimitForRcl(state.rcl);
  const towerLimit = getTowerLimitForRcl(state.rcl);
  if ((state.spawnCount ?? 1) === 0) {
    candidates.push(createCandidateForBuildType('spawn', state));
  }

  if (extensionLimit > 0 && (state.extensionCount ?? 0) < extensionLimit) {
    candidates.push(createCandidateForBuildType('extension', state));
  }

  if (towerLimit > 0 && getExistingAndPendingBuildCount(state, 'STRUCTURE_TOWER', 'tower') < towerLimit) {
    candidates.push(createCandidateForBuildType('tower', state));
  }

  if (rcl >= 2 && (state.sourceCount ?? 0) > 0) {
    candidates.push(createCandidateForBuildType('container', state));
  }

  if (rcl >= MIN_RCL_FOR_AUTOMATED_ROADS && (state.sourceCount ?? 0) > 0) {
    candidates.push(createCandidateForBuildType('road', state));
  }

  if (rcl >= MIN_RCL_FOR_STORAGE && getExistingAndPendingBuildCount(state, 'STRUCTURE_STORAGE', 'storage') < STORAGE_STRUCTURE_LIMIT) {
    candidates.push(createCandidateForBuildType('storage', state));
  }

  if (rcl >= 2) {
    candidates.push(createCandidateForBuildType('rampart', state));
  }

  return candidates;
}

function getTowerLimitForRcl(level: number | undefined): number {
  return level ? TOWER_LIMITS_BY_RCL[level] ?? 0 : 0;
}

function getExistingAndPendingBuildCount(
  state: RuntimeConstructionPriorityState,
  globalName: StructureConstantName,
  fallback: string
): number {
  const existingStructures = countStructuresByType(state.ownedStructures, globalName, fallback);
  const existingCount =
    existingStructures ??
    (globalName === 'STRUCTURE_TOWER' && fallback === 'tower' ? state.towerCount ?? 0 : 0);
  const pendingCount = (state.ownedConstructionSites ?? []).filter((site) =>
    matchesStructureType(String(site.structureType), globalName, fallback)
  ).length;

  return existingCount + pendingCount;
}

function buildRemoteLogisticsCandidates(state: RuntimeConstructionPriorityState): ConstructionBuildCandidate[] {
  const territoryIntentCount = (state.activeTerritoryIntentCount ?? 0) + (state.plannedTerritoryIntentCount ?? 0);
  if (territoryIntentCount === 0) {
    return [];
  }

  return [createCandidateForBuildType('remote-logistics', state)];
}

function createCandidateForBuildType(
  buildType: ConstructionPriorityBuildType,
  state: ConstructionPriorityRoomState
): ConstructionBuildCandidate {
  switch (buildType) {
    case 'spawn':
      return {
        buildItem: 'build spawn recovery',
        buildType,
        minimumRcl: 1,
        requiredObservations: ['spawn-count', 'worker-count', 'room-controller'],
        expectedKpiMovement: ['restores worker production and prevents room loss'],
        risk: ['high energy commitment before economy is recovered'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.spawn,
        signals: { survivalRecovery: 1, spawnUtilization: 0.8 },
        vision: { survival: 1, territory: 0.6 }
      };
    case 'extension':
      return {
        buildItem: 'build extension capacity',
        buildType,
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'energy-capacity', 'worker-count', 'construction-sites'],
        expectedKpiMovement: ['raises spawn energy capacity', 'unlocks larger workers and faster RCL progress'],
        risk: ['adds build backlog before roads/containers if worker capacity is low'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.extension,
        signals: {
          energyBottleneck: getEnergyBottleneckPressure(state),
          spawnUtilization: 0.8,
          rclAcceleration: 0.65
        },
        vision: { resources: 1, territory: 0.35 }
      };
    case 'tower':
      return {
        buildItem: 'build tower defense',
        buildType,
        minimumRcl: 3,
        requiredObservations: ['room-controller', 'energy-capacity', 'worker-count'],
        expectedKpiMovement: ['improves room hold safety', 'adds hostile damage and repair response capacity'],
        risk: ['requires steady energy income to keep tower effective'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.tower,
        hostileExposure: 'medium',
        signals: { defense: getDefensePressure(state), enemyKillPotential: 0.7 },
        vision: { survival: getDefensePressure(state), territory: 0.9, enemyKills: 0.5 }
      };
    case 'rampart':
      return {
        buildItem: 'build rampart defense',
        buildType,
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'repair-decay', 'worker-count'],
        expectedKpiMovement: ['improves spawn/controller survivability under pressure'],
        risk: ['decays without sustained repair budget'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.rampart,
        hostileExposure: 'medium',
        signals: { defense: getDefensePressure(state), repairDecay: getRepairDecayPressure(state) },
        vision: { survival: getDefensePressure(state), territory: 0.8, enemyKills: 0.15 }
      };
    case 'road':
      return {
        buildItem: 'build source/controller roads',
        buildType,
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'sources', 'repair-decay', 'worker-count'],
        expectedKpiMovement: ['reduces worker travel time', 'improves harvest-to-spawn throughput'],
        risk: ['road decay creates recurring repair load'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.road,
        pathExposure: 'low',
        signals: {
          harvestThroughput: 0.55,
          rclAcceleration: 0.45,
          expansionPrerequisite: (state.activeTerritoryIntentCount ?? 0) > 0 ? 0.45 : 0.2,
          controllerDowngrade: getControllerDowngradePressure(state) >= 0.7 ? 0.55 : 0
        },
        vision: { resources: 0.8, territory: 0.45 }
      };
    case 'container':
      return {
        buildItem: 'build source containers',
        buildType,
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'sources', 'worker-count'],
        expectedKpiMovement: ['raises harvest throughput', 'reduces dropped-energy waste'],
        risk: ['large early build cost and decay upkeep'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.container,
        pathExposure: 'low',
        signals: {
          harvestThroughput: 0.9,
          storageLogistics: 0.65,
          rclAcceleration: 0.35,
          expansionPrerequisite: (state.activeTerritoryIntentCount ?? 0) > 0 ? 0.4 : 0.15,
          controllerDowngrade: getControllerDowngradePressure(state) >= 0.7 ? 0.5 : 0
        },
        vision: { resources: 1, territory: 0.35 }
      };
    case 'storage':
      return {
        buildItem: 'build storage logistics',
        buildType,
        minimumRcl: 4,
        minimumWorkers: MIN_SAFE_WORKERS_FOR_EXPANSION,
        requiredObservations: ['room-controller', 'energy-capacity', 'worker-count'],
        expectedKpiMovement: ['improves durable resource buffering and logistics'],
        risk: ['very high energy commitment'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.storage,
        signals: { storageLogistics: 0.95 },
        vision: { resources: 1, territory: 0.25 }
      };
    case 'remote-logistics':
      return {
        buildItem: 'build remote road/container logistics',
        buildType,
        minimumRcl: 2,
        minimumWorkers: MIN_SAFE_WORKERS_FOR_EXPANSION,
        requiresSafeHome: true,
        requiredObservations: ['territory-intents', 'remote-paths', 'worker-count', 'hostile-presence'],
        expectedKpiMovement: ['turns reserved/scouted territory into sustainable income', 'improves remote room hold viability'],
        risk: ['path exposure and hostile pressure can waste builder time'],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS['remote-logistics'],
        pathExposure: 'high',
        hostileExposure: 'medium',
        signals: {
          expansionPrerequisite: 1,
          harvestThroughput: 0.75,
          storageLogistics: 0.5
        },
        vision: { territory: 1, resources: 0.6 }
      };
    case 'observation':
    default:
      return {
        buildItem: 'observe construction backlog',
        buildType: 'observation',
        requiredObservations: ['construction-sites'],
        expectedKpiMovement: ['construction priority table becomes evidence-backed'],
        risk: ['no build action should be selected until construction-site observations exist'],
        signals: {},
        vision: { resources: 0.2 }
      };
  }
}

function mapStructureTypeToBuildType(structureType: string): ConstructionPriorityBuildType {
  if (matchesStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn')) {
    return 'spawn';
  }

  if (matchesStructureType(structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return 'extension';
  }

  if (matchesStructureType(structureType, 'STRUCTURE_TOWER', 'tower')) {
    return 'tower';
  }

  if (matchesStructureType(structureType, 'STRUCTURE_RAMPART', 'rampart')) {
    return 'rampart';
  }

  if (matchesStructureType(structureType, 'STRUCTURE_ROAD', 'road')) {
    return 'road';
  }

  if (matchesStructureType(structureType, 'STRUCTURE_CONTAINER', 'container')) {
    return 'container';
  }

  if (matchesStructureType(structureType, 'STRUCTURE_STORAGE', 'storage')) {
    return 'storage';
  }

  return 'observation';
}

function getConstructionSiteRemainingProgress(site: ConstructionSite): number {
  const progressTotal = typeof site.progressTotal === 'number' ? site.progressTotal : STRUCTURE_BUILD_COSTS.observation ?? 0;
  const progress = typeof site.progress === 'number' ? site.progress : 0;
  return Math.max(0, progressTotal - progress);
}

function findRoomObjects(room: Room, constantName: FindConstantName): unknown[] | null {
  const findConstant = getFindConstant(constantName);
  if (findConstant === null || typeof room.find !== 'function') {
    return null;
  }

  try {
    const result = room.find(findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return null;
  }
}

function getFindConstant(constantName: FindConstantName): FindConstant | null {
  const findConstant = (globalThis as unknown as Partial<Record<FindConstantName, number>>)[constantName];
  return typeof findConstant === 'number' ? (findConstant as FindConstant) : null;
}

type FindConstantName =
  | 'FIND_MY_CONSTRUCTION_SITES'
  | 'FIND_CONSTRUCTION_SITES'
  | 'FIND_MY_STRUCTURES'
  | 'FIND_STRUCTURES'
  | 'FIND_HOSTILE_CREEPS'
  | 'FIND_HOSTILE_STRUCTURES'
  | 'FIND_SOURCES';

type LookConstantName = 'LOOK_STRUCTURES' | 'LOOK_CONSTRUCTION_SITES';

type StructureConstantName =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_TOWER'
  | 'STRUCTURE_RAMPART'
  | 'STRUCTURE_WALL'
  | 'STRUCTURE_ROAD'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_STORAGE';

function countStructuresByType(
  structures: AnyStructure[] | null,
  globalName: StructureConstantName,
  fallback: string
): number | undefined {
  return structures?.filter((structure) => matchesStructureType(structure.structureType, globalName, fallback)).length;
}

function summarizeRepairSignals(
  structures: AnyStructure[] | null,
  criticalRoadContext: CriticalRoadLogisticsContext
): { criticalRepairCount: number; decayingStructureCount: number } | null {
  if (structures === null) {
    return null;
  }

  return structures.reduce(
    (summary, structure) => {
      if (!isRepairSignalStructure(structure) || !hasHits(structure)) {
        return summary;
      }

      if (
        matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road') &&
        !isCriticalRoadLogisticsWork(structure, criticalRoadContext)
      ) {
        return summary;
      }

      const hitsRatio = structure.hitsMax > 0 ? structure.hits / structure.hitsMax : 1;
      if (hitsRatio <= CRITICAL_REPAIR_HITS_RATIO) {
        summary.criticalRepairCount += 1;
      } else if (hitsRatio <= DECAYING_REPAIR_HITS_RATIO) {
        summary.decayingStructureCount += 1;
      }

      return summary;
    },
    { criticalRepairCount: 0, decayingStructureCount: 0 }
  );
}

function isRepairSignalStructure(structure: AnyStructure): structure is StructureRoad | StructureContainer | StructureRampart {
  if (
    matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container')
  ) {
    return true;
  }

  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') &&
    (structure as StructureRampart).my === true &&
    (structure as StructureRampart).hits <= IDLE_RAMPART_REPAIR_HITS_CEILING
  );
}

function hasHits(structure: AnyStructure): structure is AnyStructure & { hits: number; hitsMax: number } {
  return typeof structure.hits === 'number' && typeof structure.hitsMax === 'number';
}

function countTerritoryIntents(roomName: string): { active: number; planned: number } {
  const intents = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory?.intents;
  if (!Array.isArray(intents)) {
    return { active: 0, planned: 0 };
  }

  return intents.reduce(
    (counts, intent) => {
      if (!isRecord(intent)) {
        return counts;
      }

      if (intent.colony !== roomName) {
        return counts;
      }

      if (intent.status === 'active') {
        counts.active += 1;
      } else if (intent.status === 'planned') {
        counts.planned += 1;
      }

      return counts;
    },
    { active: 0, planned: 0 }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function matchesStructureType(
  actual: string | undefined,
  globalName: StructureConstantName,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<StructureConstantName, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function getLookConstant(constantName: LookConstantName): string | null {
  const constant = (globalThis as unknown as Partial<Record<LookConstantName, string>>)[constantName];
  return typeof constant === 'string' ? constant : null;
}

function getBuildableStructureConstant(
  globalName: StructureConstantName,
  fallback: string
): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<Record<StructureConstantName, string>>;
  return (constants[globalName] ?? fallback) as BuildableStructureConstant;
}
