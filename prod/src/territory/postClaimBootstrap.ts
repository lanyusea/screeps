import type { ColonySnapshot } from '../colony/colonyRegistry';
import { recordClaimedRoomBootstrapStage } from '../colony/colonyStage';
import {
  planConstructionForColony,
  POST_CLAIM_CONSTRUCTION_PRIORITY_ORDER,
  type ConstructionPlannerPriority
} from '../construction/planner';
import type { RoleCounts } from '../creeps/roleCounts';
import {
  findSourceContainer,
  findSourceContainerConstructionSite
} from '../economy/sourceContainers';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  runRampartWallConstructionExecutorForColony,
  type RampartWallConstructionExecutorResult
} from './rampartWallConstructionExecutor';
import {
  runTowerConstructionExecutorForColony,
  type TowerConstructionExecutorResult
} from './towerConstructionExecutor';
import {
  planExpansionDefenseBarrierPlacements,
  type ExpansionDefenseBarrierPlacementStage
} from './expansionPlanner';

export const POST_CLAIM_BOOTSTRAP_WORKER_TARGET = 2;

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ROOM_EDGE_MIN = 2;
const ROOM_EDGE_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const FALLBACK_CONTROLLER_STRUCTURES: Record<PostClaimBootstrapStructureConstantGlobal, number[]> = {
  STRUCTURE_SPAWN: [0, 1, 1, 1, 1, 1, 1, 2, 3],
  STRUCTURE_EXTENSION: [0, 0, 5, 10, 20, 30, 40, 50, 60],
  STRUCTURE_ROAD: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
  STRUCTURE_CONTAINER: [0, 0, 5, 5, 5, 5, 5, 5, 5],
  STRUCTURE_RAMPART: [0, 0, 300, 300, 300, 300, 300, 300, 300],
  STRUCTURE_TOWER: [0, 0, 0, 1, 1, 2, 2, 3, 6],
  STRUCTURE_STORAGE: [0, 0, 0, 0, 1, 1, 1, 1, 1]
};
const FALLBACK_STRUCTURE_TYPES: Record<PostClaimBootstrapStructureConstantGlobal, BuildableStructureConstant> = {
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_STORAGE: 'storage'
};
const POST_CLAIM_DEFENSE_BARRIER_STAGE_ORDER: readonly ExpansionDefenseBarrierPlacementStage[] = [
  'entranceRampart',
  'towerRampart',
  'coreRampart',
  'entranceWall'
];

type PostClaimBootstrapStructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_ROAD'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_RAMPART'
  | 'STRUCTURE_TOWER'
  | 'STRUCTURE_STORAGE';
type StructureConstantGlobal = PostClaimBootstrapStructureConstantGlobal;
type FindConstantGlobal =
  | 'FIND_SOURCES'
  | 'FIND_STRUCTURES'
  | 'FIND_CONSTRUCTION_SITES'
  | 'FIND_MY_STRUCTURES'
  | 'FIND_MY_CONSTRUCTION_SITES';
type LookConstantGlobal = 'LOOK_STRUCTURES' | 'LOOK_CONSTRUCTION_SITES' | 'LOOK_MINERALS';

interface CandidatePosition {
  x: number;
  y: number;
}

interface SpawnSitePlanResult {
  result: ScreepsReturnCode;
  position?: TerritoryPostClaimBootstrapSpawnSiteMemory;
}

interface SpawnPlacementLookups {
  blockingPositions: Set<string>;
  mineralPositions: Set<string>;
  rangeReservedPositions: CandidatePosition[];
  terrain: RoomTerrain | null;
}

export interface PostClaimBootstrapRefreshResult {
  active: boolean;
  spawnConstructionPending: boolean;
  deferred?: boolean;
}

export interface PostClaimBootstrapRefreshOptions {
  focusRoomName?: string | null;
}

export interface PostClaimBootstrapSummary {
  colony: string;
  status: TerritoryPostClaimBootstrapStatus;
  claimedAt: number;
  updatedAt: number;
  workerTarget: number;
  controllerId?: Id<StructureController>;
  spawnSite?: TerritoryPostClaimBootstrapSpawnSiteMemory;
  lastResult?: ScreepsReturnCode;
  progress?: PostClaimBootstrapProgressSummary;
}

export interface PostClaimBootstrapProgressSummary {
  construction: PostClaimBootstrapConstructionProgressSummary;
  energy: PostClaimBootstrapEnergyProgressSummary;
  defense: PostClaimBootstrapDefenseProgressSummary;
}

export interface PostClaimBootstrapConstructionProgressSummary {
  priorityOrder: ConstructionPlannerPriority[];
  nextPriority: ConstructionPlannerPriority | null;
  spawn: PostClaimBootstrapStructureProgressSummary;
  extensions: PostClaimBootstrapStructureProgressSummary;
  sourceContainers: PostClaimBootstrapStructureProgressSummary & {
    coveredSources: number;
  };
  roads: PostClaimBootstrapStructureProgressSummary;
  towers: PostClaimBootstrapStructureProgressSummary;
  ramparts: PostClaimBootstrapStructureProgressSummary;
  storage: PostClaimBootstrapStructureProgressSummary;
}

export interface PostClaimBootstrapStructureProgressSummary {
  existing: number;
  pending: number;
  target: number | null;
  complete: boolean;
}

export interface PostClaimBootstrapEnergyProgressSummary {
  sourceCount: number;
  coveredSourceCount: number;
  sourceContainerCount: number;
  pendingSourceContainerCount: number;
  assignedHarvesterCount: number;
  localStoredEnergy: number;
}

export interface PostClaimBootstrapDefenseProgressSummary {
  towerCount: number;
  pendingTowerCount: number;
  towerTarget: number;
  rampartCount: number;
  pendingRampartCount: number;
  nextBarrierStage: ExpansionDefenseBarrierPlacementStage | null;
}

export interface PostClaimDefenseConstructionRefreshResult {
  active: boolean;
  deferred?: boolean;
  tower: TowerConstructionExecutorResult | null;
  barrier: RampartWallConstructionExecutorResult | null;
}

export type PostClaimBootstrapBlockerSummary = TerritoryPostClaimBootstrapBlockerMemory;

export function recordPostClaimBootstrapClaimSuccess(
  input: {
    colony: string;
    roomName: string;
    claimedAt?: number;
    controllerId?: Id<StructureController>;
  },
  telemetryEvents: RuntimeTelemetryEvent[] = []
): void {
  if (!isNonEmptyString(input.colony) || !isNonEmptyString(input.roomName)) {
    return;
  }

  const bootstraps = getWritablePostClaimBootstrapRecords();
  if (!bootstraps) {
    return;
  }

  const gameTime = getGameTime();
  const existing = getPostClaimBootstrapRecord(input.roomName);
  const claimedAt = existing?.status === 'ready' ? gameTime : existing?.claimedAt ?? input.claimedAt ?? gameTime;
  const status = getRefreshedPostClaimBootstrapStatus(existing);
  const workerTarget = existing
    ? getPostClaimBootstrapWorkerTarget(existing)
    : POST_CLAIM_BOOTSTRAP_WORKER_TARGET;
  const controllerId = input.controllerId ?? existing?.controllerId;
  const record: TerritoryPostClaimBootstrapMemory = {
    colony: input.colony,
    roomName: input.roomName,
    status,
    claimedAt,
    updatedAt: gameTime,
    workerTarget,
    ...(controllerId ? { controllerId } : {}),
    ...(existing?.spawnSite ? { spawnSite: existing.spawnSite } : {}),
    ...(existing?.lastResult !== undefined ? { lastResult: existing.lastResult } : {})
  };
  bootstraps[input.roomName] = record;
  recordClaimedRoomOccupation(input.roomName, claimedAt, gameTime);
  recordClaimedRoomBootstrapStage(input.roomName, gameTime);

  telemetryEvents.push({
    type: 'postClaimBootstrap',
    roomName: input.roomName,
    colony: input.colony,
    phase: record.status,
    ...(record.controllerId ? { controllerId: record.controllerId } : {}),
    workerTarget: record.workerTarget
  });

  placePostClaimSpawnConstructionSite(input.roomName, telemetryEvents);
}

function getRefreshedPostClaimBootstrapStatus(
  existing: TerritoryPostClaimBootstrapMemory | null
): TerritoryPostClaimBootstrapStatus {
  if (!existing || existing.status === 'ready') {
    return 'detected';
  }

  return existing.status;
}

function recordClaimedRoomOccupation(roomName: string, claimedAt: number, gameTime: number): void {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return;
  }

  if (!memory.territory) {
    memory.territory = {};
  }

  if (!memory.territory.claimedRoomBootstrapper) {
    memory.territory.claimedRoomBootstrapper = { rooms: {} };
  }

  memory.territory.claimedRoomBootstrapper.rooms[roomName] = {
    roomName,
    owned: true,
    claimedAt,
    updatedAt: gameTime,
    ...(memory.territory.claimedRoomBootstrapper.rooms[roomName]?.completedAt !== undefined
      ? { completedAt: memory.territory.claimedRoomBootstrapper.rooms[roomName].completedAt }
      : {})
  };
}

export function refreshPostClaimBootstrap(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[] = [],
  options: PostClaimBootstrapRefreshOptions = {}
): PostClaimBootstrapRefreshResult {
  const roomName = colony.room.name;
  const record = getPostClaimBootstrapRecord(roomName);
  if (!record || record.status === 'ready' || colony.room.controller?.my !== true) {
    return { active: false, spawnConstructionPending: false };
  }

  if (isPostClaimBootstrapDeferred(roomName, options.focusRoomName)) {
    return { active: true, spawnConstructionPending: false, deferred: true };
  }

  const workerTarget = getPostClaimBootstrapWorkerTarget(record);
  const workerCount = roleCounts.worker ?? 0;
  const spawnCount = colony.spawns.length;
  if (spawnCount > 0 && workerCount >= workerTarget) {
    updatePostClaimBootstrapRecord(roomName, {
      status: 'ready',
      updatedAt: gameTime,
      workerTarget
    });
    telemetryEvents.push({
      type: 'postClaimBootstrap',
      roomName,
      colony: record.colony,
      phase: 'ready',
      ...(record.controllerId ? { controllerId: record.controllerId } : {}),
      workerCount,
      workerTarget,
      spawnCount
    });
    return { active: false, spawnConstructionPending: false };
  }

  if (spawnCount > 0) {
    updatePostClaimBootstrapRecord(roomName, {
      status: 'spawningWorkers',
      updatedAt: gameTime,
      workerTarget
    });
    return { active: true, spawnConstructionPending: false };
  }

  const existingSpawnSite = findExistingSpawnConstructionSite(colony.room);
  if (existingSpawnSite) {
    const spawnSite = toSpawnSiteMemory(existingSpawnSite);
    const shouldReportExistingSite =
      record.status !== 'spawnSitePending' ||
      !isSameSpawnSite(record.spawnSite, spawnSite);
    updatePostClaimBootstrapRecord(roomName, {
      status: 'spawnSitePending',
      updatedAt: gameTime,
      workerTarget,
      spawnSite,
      lastResult: OK_CODE
    });
    if (shouldReportExistingSite) {
      telemetryEvents.push({
        type: 'postClaimBootstrap',
        roomName,
        colony: record.colony,
        phase: 'spawnSite',
        ...(record.controllerId ? { controllerId: record.controllerId } : {}),
        result: OK_CODE,
        spawnSite,
        workerCount,
        workerTarget,
        spawnCount
      });
      recordSpawnSitePlacedTelemetry(record, spawnSite, OK_CODE, telemetryEvents, true);
    }
    return { active: true, spawnConstructionPending: true };
  }

  const sitePlan = planInitialSpawnConstructionSite(colony.room);
  const nextStatus = sitePlan.result === OK_CODE ? 'spawnSitePending' : 'spawnSiteBlocked';
  const shouldReportSitePlan =
    record.status !== nextStatus ||
    record.lastResult !== sitePlan.result ||
    (sitePlan.position !== undefined && !isSameSpawnSite(record.spawnSite, sitePlan.position));
  updatePostClaimBootstrapRecord(roomName, {
    status: nextStatus,
    updatedAt: gameTime,
    workerTarget,
    ...(sitePlan.position ? { spawnSite: sitePlan.position } : {}),
    lastResult: sitePlan.result
  });
  if (shouldReportSitePlan) {
    telemetryEvents.push({
      type: 'postClaimBootstrap',
      roomName,
      colony: record.colony,
      phase: 'spawnSite',
      ...(record.controllerId ? { controllerId: record.controllerId } : {}),
      result: sitePlan.result,
      ...(sitePlan.position ? { spawnSite: sitePlan.position } : {}),
      workerCount,
      workerTarget,
      spawnCount
    });
    if (sitePlan.result === OK_CODE && sitePlan.position) {
      recordSpawnSitePlacedTelemetry(record, sitePlan.position, sitePlan.result, telemetryEvents);
    }
  }

  return { active: true, spawnConstructionPending: true };
}

export function selectPostClaimBootstrapFocusRoomName(colonies: ColonySnapshot[]): string | null {
  return getVisibleActivePostClaimBootstrapRecords(colonies)[0]?.roomName ?? null;
}

export function getActivePostClaimBootstrapBlockers(
  colonyName: string,
  gameTime = getGameTime()
): PostClaimBootstrapBlockerSummary[] {
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isNonEmptyString(colonyName) || !isRecord(records)) {
    return [];
  }

  return Object.values(records)
    .flatMap((record) => {
      const blocker = buildPostClaimBootstrapBlockerSummary(record, colonyName, gameTime);
      return blocker ? [blocker] : [];
    })
    .sort(comparePostClaimBootstrapBlockers);
}

export function refreshPostClaimDefenseConstruction(
  colony: ColonySnapshot,
  options: PostClaimBootstrapRefreshOptions = {}
): PostClaimDefenseConstructionRefreshResult {
  const roomName = colony.room.name;
  if (colony.room.controller?.my !== true || !isPostClaimDefenseConstructionRoom(roomName)) {
    return { active: false, tower: null, barrier: null };
  }

  if (isPostClaimBootstrapDeferred(roomName, options.focusRoomName)) {
    return { active: true, deferred: true, tower: null, barrier: null };
  }

  const tower = runTowerConstructionExecutorForColony(colony, {
    requireExpansionMemory: true,
    minEnergyAvailable: 0
  });
  const barrier = runRampartWallConstructionExecutorForColony(colony, {
    requireExpansionMemory: true,
    minEnergyAvailable: 0,
    stageOrder: POST_CLAIM_DEFENSE_BARRIER_STAGE_ORDER
  });

  return { active: true, tower, barrier };
}

function isPostClaimBootstrapDeferred(
  roomName: string,
  focusRoomName: string | null | undefined
): boolean {
  const record = getPostClaimBootstrapRecord(roomName);
  return isNonEmptyString(focusRoomName) && roomName !== focusRoomName && record !== null && record.status !== 'ready';
}

function isPostClaimDefenseConstructionRoom(roomName: string): boolean {
  const record = getPostClaimBootstrapRecord(roomName);
  if (!record) {
    return false;
  }

  return !isClaimedRoomEstablished(roomName, record.claimedAt);
}

function isClaimedRoomEstablished(roomName: string, claimedAt: number): boolean {
  const claimedRoomRecord = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.claimedRoomBootstrapper
    ?.rooms?.[roomName];
  return claimedRoomRecord?.completedAt !== undefined && claimedRoomRecord.completedAt >= claimedAt;
}

export function recordPostClaimBootstrapWorkerSpawn(
  roomName: string | undefined,
  spawnName: string,
  creepName: string,
  result: ScreepsReturnCode,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): void {
  if (!isNonEmptyString(roomName)) {
    return;
  }

  const record = getPostClaimBootstrapRecord(roomName);
  if (!record || record.status === 'ready') {
    return;
  }

  updatePostClaimBootstrapRecord(roomName, {
    status: 'spawningWorkers',
    updatedAt: getGameTime()
  });
  telemetryEvents.push({
    type: 'postClaimBootstrap',
    roomName,
    colony: record.colony,
    phase: 'workerSpawn',
    ...(record.controllerId ? { controllerId: record.controllerId } : {}),
    spawnName,
    creepName,
    result,
    workerTarget: getPostClaimBootstrapWorkerTarget(record)
  });
}

export function getPostClaimBootstrapSummary(roomName: string): PostClaimBootstrapSummary | null {
  const record = getPostClaimBootstrapRecord(roomName);
  if (!record || (record.status === 'ready' && isClaimedRoomEstablished(roomName, record.claimedAt))) {
    return null;
  }

  return {
    colony: record.colony,
    status: record.status,
    claimedAt: record.claimedAt,
    updatedAt: record.updatedAt,
    workerTarget: getPostClaimBootstrapWorkerTarget(record),
    ...(record.controllerId ? { controllerId: record.controllerId } : {}),
    ...(record.spawnSite ? { spawnSite: record.spawnSite } : {}),
    ...(record.lastResult !== undefined ? { lastResult: record.lastResult } : {}),
    ...buildPostClaimBootstrapProgressSummary(roomName)
  };
}

function buildPostClaimBootstrapProgressSummary(
  roomName: string
): { progress?: PostClaimBootstrapProgressSummary } {
  const room = getVisibleOwnedRoom(roomName);
  if (!room) {
    return {};
  }

  const structures = findVisibleStructures(room);
  const constructionSites = findVisibleConstructionSites(room);
  const sources = findSources(room);
  const construction = buildPostClaimBootstrapConstructionProgress(room, structures, constructionSites, sources);

  return {
    progress: {
      construction,
      energy: buildPostClaimBootstrapEnergyProgress(room, structures, sources),
      defense: buildPostClaimBootstrapDefenseProgress(room, structures, constructionSites)
    }
  };
}

function buildPostClaimBootstrapConstructionProgress(
  room: Room,
  structures: Structure[],
  constructionSites: ConstructionSite[],
  sources: Source[]
): PostClaimBootstrapConstructionProgressSummary {
  const spawn = buildStructureProgress(room, structures, constructionSites, 'STRUCTURE_SPAWN', 'spawn');
  const extensions = buildStructureProgress(room, structures, constructionSites, 'STRUCTURE_EXTENSION', 'extension');
  const sourceContainers = buildSourceContainerProgress(room, sources);
  const roads = buildRoadProgress(structures, constructionSites);
  const towers = buildStructureProgress(room, structures, constructionSites, 'STRUCTURE_TOWER', 'tower');
  const ramparts = buildStructureProgress(room, structures, constructionSites, 'STRUCTURE_RAMPART', 'rampart');
  const storage = buildStructureProgress(room, structures, constructionSites, 'STRUCTURE_STORAGE', 'storage');
  const nextPriority = selectPostClaimBootstrapNextConstructionPriority({
    spawn,
    extensions,
    sourceContainers,
    roads,
    towers,
    ramparts,
    storage
  });

  return {
    priorityOrder: [...POST_CLAIM_CONSTRUCTION_PRIORITY_ORDER],
    nextPriority,
    spawn,
    extensions,
    sourceContainers,
    roads,
    towers,
    ramparts,
    storage
  };
}

function buildPostClaimBootstrapEnergyProgress(
  room: Room,
  structures: Structure[],
  sources: Source[]
): PostClaimBootstrapEnergyProgressSummary {
  const sourceContainerCoverage = getSourceContainerCoverage(room, sources);
  return {
    sourceCount: sources.length,
    coveredSourceCount: sourceContainerCoverage.coveredSourceCount,
    sourceContainerCount: sourceContainerCoverage.sourceContainerCount,
    pendingSourceContainerCount: sourceContainerCoverage.pendingSourceContainerCount,
    assignedHarvesterCount: countAssignedPostClaimHarvesters(room.name),
    localStoredEnergy: sumLocalStoredEnergy(structures)
  };
}

function buildPostClaimBootstrapDefenseProgress(
  room: Room,
  structures: Structure[],
  constructionSites: ConstructionSite[]
): PostClaimBootstrapDefenseProgressSummary {
  const towerType = getStructureConstant('STRUCTURE_TOWER', 'tower');
  const rampartType = getStructureConstant('STRUCTURE_RAMPART', 'rampart');
  const nextBarrier = planExpansionDefenseBarrierPlacements(room, {
    maxPlacements: 1,
    stageOrder: POST_CLAIM_DEFENSE_BARRIER_STAGE_ORDER
  })[0];

  return {
    towerCount: countObjectsByStructureType(structures, towerType),
    pendingTowerCount: countObjectsByStructureType(constructionSites, towerType),
    towerTarget: getControllerStructureLimit(room, 'STRUCTURE_TOWER'),
    rampartCount: countObjectsByStructureType(structures, rampartType),
    pendingRampartCount: countObjectsByStructureType(constructionSites, rampartType),
    nextBarrierStage: nextBarrier?.stage ?? null
  };
}

function buildStructureProgress(
  room: Room,
  structures: Structure[],
  constructionSites: ConstructionSite[],
  globalName: PostClaimBootstrapStructureConstantGlobal,
  fallback: BuildableStructureConstant
): PostClaimBootstrapStructureProgressSummary {
  const structureType = getStructureConstant(globalName, fallback);
  const existing = countObjectsByStructureType(structures, structureType);
  const pending = countObjectsByStructureType(constructionSites, structureType);
  const target = getControllerStructureLimit(room, globalName);

  return {
    existing,
    pending,
    target,
    complete: target <= 0 || existing + pending >= target
  };
}

function buildSourceContainerProgress(
  room: Room,
  sources: Source[]
): PostClaimBootstrapConstructionProgressSummary['sourceContainers'] {
  const coverage = getSourceContainerCoverage(room, sources);
  const target = Math.min(sources.length, getControllerStructureLimit(room, 'STRUCTURE_CONTAINER'));

  return {
    existing: coverage.sourceContainerCount,
    pending: coverage.pendingSourceContainerCount,
    target,
    complete: target <= 0 || coverage.coveredSourceCount >= sources.length,
    coveredSources: coverage.coveredSourceCount
  };
}

function buildRoadProgress(
  structures: Structure[],
  constructionSites: ConstructionSite[]
): PostClaimBootstrapStructureProgressSummary {
  const roadType = getStructureConstant('STRUCTURE_ROAD', 'road');
  const existing = countObjectsByStructureType(structures, roadType);
  const pending = countObjectsByStructureType(constructionSites, roadType);

  return {
    existing,
    pending,
    target: null,
    complete: existing + pending > 0
  };
}

function selectPostClaimBootstrapNextConstructionPriority(
  progress: Pick<
    PostClaimBootstrapConstructionProgressSummary,
    'spawn' | 'extensions' | 'sourceContainers' | 'roads' | 'towers' | 'ramparts' | 'storage'
  >
): ConstructionPlannerPriority | null {
  if (!progress.spawn.complete) {
    return 'spawn';
  }
  if (!progress.extensions.complete) {
    return 'extension';
  }
  if (!progress.roads.complete && progress.roads.existing + progress.roads.pending <= 0) {
    return 'road';
  }
  if (!progress.sourceContainers.complete) {
    return 'container';
  }
  if (!progress.towers.complete) {
    return 'tower';
  }
  if (!progress.ramparts.complete && progress.ramparts.existing + progress.ramparts.pending <= 0) {
    return 'rampart';
  }
  if (!progress.storage.complete) {
    return 'storage';
  }

  return null;
}

function getSourceContainerCoverage(
  room: Room,
  sources: Source[]
): {
  coveredSourceCount: number;
  sourceContainerCount: number;
  pendingSourceContainerCount: number;
} {
  let coveredSourceCount = 0;
  const sourceContainerIds = new Set<string>();
  const pendingSourceContainerIds = new Set<string>();

  for (const source of sources) {
    const container = findSourceContainer(room, source);
    const site = findSourceContainerConstructionSite(room, source);
    if (container) {
      sourceContainerIds.add(getObjectSummaryId(container, `${source.id}:container`));
    }
    if (site) {
      pendingSourceContainerIds.add(getObjectSummaryId(site, `${source.id}:containerSite`));
    }
    if (container || site) {
      coveredSourceCount += 1;
    }
  }

  return {
    coveredSourceCount,
    sourceContainerCount: sourceContainerIds.size,
    pendingSourceContainerCount: pendingSourceContainerIds.size
  };
}

function countAssignedPostClaimHarvesters(roomName: string): number {
  const creeps = (globalThis as { Game?: Partial<Game> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).filter((creep) => isAssignedPostClaimHarvester(creep, roomName)).length;
}

function isAssignedPostClaimHarvester(creep: Creep, roomName: string): boolean {
  if (creep.memory?.sourceHarvester?.roomName === roomName) {
    return true;
  }

  if (creep.memory?.remoteHarvester?.targetRoom === roomName) {
    return true;
  }

  return (
    creep.memory?.role === 'worker' &&
    creep.room?.name === roomName &&
    creep.memory.task?.type === 'harvest'
  );
}

function sumLocalStoredEnergy(structures: Structure[]): number {
  return structures.reduce((total, structure) => total + getStoredEnergy(structure), 0);
}

function getStoredEnergy(object: unknown): number {
  if (!isRecord(object) || !isRecord(object.store)) {
    return 0;
  }

  const resource = getEnergyResource();
  const getUsedCapacity = object.store.getUsedCapacity;
  if (typeof getUsedCapacity === 'function') {
    const usedCapacity = getUsedCapacity.call(object.store, resource);
    return isFiniteNumber(usedCapacity) ? Math.max(0, Math.floor(usedCapacity)) : 0;
  }

  const storedEnergy = object.store[resource];
  return isFiniteNumber(storedEnergy) ? Math.max(0, Math.floor(storedEnergy)) : 0;
}

function getEnergyResource(): ResourceConstant {
  const resource = (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
  return resource ?? ('energy' as ResourceConstant);
}

function countObjectsByStructureType(
  objects: Array<Structure | ConstructionSite>,
  structureType: BuildableStructureConstant
): number {
  const seen = new Set<string>();
  for (const [index, object] of objects.entries()) {
    if (object.structureType !== structureType) {
      continue;
    }

    seen.add(getObjectSummaryId(object, `${structureType}:${index}`));
  }

  return seen.size;
}

function getObjectSummaryId(object: unknown, fallback: string): string {
  if (isRecord(object) && isNonEmptyString(object.id)) {
    return object.id;
  }

  const position = getRoomObjectPosition(object);
  return position ? `${fallback}:${getPositionKey(position)}` : fallback;
}

function findVisibleStructures(room: Room): Structure[] {
  const allStructures = findRoomObjects<Structure>(room, 'FIND_STRUCTURES');
  return allStructures.length > 0 ? allStructures : findRoomObjects<Structure>(room, 'FIND_MY_STRUCTURES');
}

function findVisibleConstructionSites(room: Room): ConstructionSite[] {
  const allConstructionSites = findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES');
  return allConstructionSites.length > 0
    ? allConstructionSites
    : findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES');
}

function findRoomObjects<T>(room: Room, globalName: FindConstantGlobal): T[] {
  const findConstant = getGlobalNumber(globalName);
  if (typeof room.find !== 'function' || findConstant === null) {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getControllerStructureLimit(room: Room, globalName: PostClaimBootstrapStructureConstantGlobal): number {
  const rcl = getOwnedRoomRcl(room);
  const structureType = getStructureConstant(globalName, FALLBACK_STRUCTURE_TYPES[globalName]);
  const controllerStructures = (globalThis as { CONTROLLER_STRUCTURES?: Partial<Record<string, number[]>> })
    .CONTROLLER_STRUCTURES;
  const configuredLimit = controllerStructures?.[structureType]?.[rcl];
  if (isFiniteNumber(configuredLimit)) {
    return Math.max(0, Math.floor(configuredLimit));
  }

  return FALLBACK_CONTROLLER_STRUCTURES[globalName][rcl] ?? 0;
}

function getOwnedRoomRcl(room: Room): number {
  const level = room.controller?.my === true ? room.controller.level : 0;
  return isFiniteNumber(level) ? Math.max(0, Math.min(8, Math.floor(level))) : 0;
}

function getVisibleActivePostClaimBootstrapRecords(colonies: ColonySnapshot[]): TerritoryPostClaimBootstrapMemory[] {
  const visibleOwnedRoomNames = new Set(
    colonies
      .filter((colony) => colony.room.controller?.my === true)
      .map((colony) => colony.room.name)
  );
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isRecord(records)) {
    return [];
  }

  return Object.values(records)
    .filter((record): record is TerritoryPostClaimBootstrapMemory =>
      isAnyPostClaimBootstrapRecord(record) &&
      record.status !== 'ready' &&
      visibleOwnedRoomNames.has(record.roomName)
    )
    .sort(comparePostClaimBootstrapRecordsForFocus);
}

function buildPostClaimBootstrapBlockerSummary(
  record: unknown,
  colonyName: string,
  gameTime: number
): PostClaimBootstrapBlockerSummary | null {
  if (
    !isAnyPostClaimBootstrapRecord(record) ||
    record.colony !== colonyName ||
    record.status === 'ready' ||
    !getVisibleOwnedRoom(record.roomName)
  ) {
    return null;
  }

  const workerTarget = getPostClaimBootstrapWorkerTarget(record);
  const spawnCount = countOwnedSpawnsInRoom(record.roomName);
  const workerCount = countRoomWorkers(record.roomName);
  if (spawnCount > 0 && workerCount >= workerTarget) {
    return null;
  }

  return {
    colony: record.colony,
    roomName: record.roomName,
    status: record.status,
    updatedAt: record.updatedAt,
    age: Math.max(0, Math.floor(gameTime - record.updatedAt)),
    workerTarget,
    spawnCount,
    workerCount
  };
}

function comparePostClaimBootstrapBlockers(
  left: PostClaimBootstrapBlockerSummary,
  right: PostClaimBootstrapBlockerSummary
): number {
  return (
    right.age - left.age ||
    left.spawnCount - right.spawnCount ||
    left.workerCount - right.workerCount ||
    left.roomName.localeCompare(right.roomName)
  );
}

function comparePostClaimBootstrapRecordsForFocus(
  left: TerritoryPostClaimBootstrapMemory,
  right: TerritoryPostClaimBootstrapMemory
): number {
  return (
    left.claimedAt - right.claimedAt ||
    left.updatedAt - right.updatedAt ||
    left.roomName.localeCompare(right.roomName)
  );
}

function placePostClaimSpawnConstructionSite(
  roomName: string,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  const record = getPostClaimBootstrapRecord(roomName);
  const room = getVisibleOwnedRoom(roomName);
  if (!record || !room || !canAttemptImmediateSpawnSitePlacement(room) || hasOwnedSpawnInRoom(roomName)) {
    return;
  }

  const workerTarget = getPostClaimBootstrapWorkerTarget(record);
  const workerCount = countRoomWorkers(roomName);
  const existingSpawnSite = findExistingSpawnConstructionSite(room);
  if (existingSpawnSite) {
    const spawnSite = toSpawnSiteMemory(existingSpawnSite);
    updatePostClaimBootstrapRecord(roomName, {
      status: 'spawnSitePending',
      updatedAt: getGameTime(),
      workerTarget,
      spawnSite,
      lastResult: OK_CODE
    });
    telemetryEvents.push({
      type: 'postClaimBootstrap',
      roomName,
      colony: record.colony,
      phase: 'spawnSite',
      ...(record.controllerId ? { controllerId: record.controllerId } : {}),
      result: OK_CODE,
      spawnSite,
      workerCount,
      workerTarget,
      spawnCount: 0
    });
    recordSpawnSitePlacedTelemetry(record, spawnSite, OK_CODE, telemetryEvents, true);
    return;
  }

  const sitePlan = planInitialSpawnConstructionSite(room);
  const nextStatus = sitePlan.result === OK_CODE ? 'spawnSitePending' : 'spawnSiteBlocked';
  updatePostClaimBootstrapRecord(roomName, {
    status: nextStatus,
    updatedAt: getGameTime(),
    workerTarget,
    ...(sitePlan.position ? { spawnSite: sitePlan.position } : {}),
    lastResult: sitePlan.result
  });
  telemetryEvents.push({
    type: 'postClaimBootstrap',
    roomName,
    colony: record.colony,
    phase: 'spawnSite',
    ...(record.controllerId ? { controllerId: record.controllerId } : {}),
    result: sitePlan.result,
    ...(sitePlan.position ? { spawnSite: sitePlan.position } : {}),
    workerCount,
    workerTarget,
    spawnCount: 0
  });
  if (sitePlan.result === OK_CODE && sitePlan.position) {
    recordSpawnSitePlacedTelemetry(record, sitePlan.position, sitePlan.result, telemetryEvents);
  }
}

function getVisibleOwnedRoom(roomName: string): Room | null {
  const room = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
  return room?.controller?.my === true ? room : null;
}

function canAttemptImmediateSpawnSitePlacement(room: Room): boolean {
  return (
    typeof room.createConstructionSite === 'function' &&
    getRoomObjectPosition(room.controller) !== null
  );
}

function hasOwnedSpawnInRoom(roomName: string): boolean {
  return countOwnedSpawnsInRoom(roomName) > 0;
}

function countOwnedSpawnsInRoom(roomName: string): number {
  const spawns = (globalThis as { Game?: Partial<Game> }).Game?.spawns;
  if (!spawns) {
    return 0;
  }

  return Object.values(spawns).filter((spawn) => spawn?.room?.name === roomName).length;
}

function countRoomWorkers(roomName: string): number {
  const creeps = (globalThis as { Game?: Partial<Game> }).Game?.creeps;
  if (!creeps) {
    return 0;
  }

  return Object.values(creeps).filter(
    (creep) => creep?.memory?.role === 'worker' && creep.memory.colony === roomName
  ).length;
}

function recordSpawnSitePlacedTelemetry(
  record: TerritoryPostClaimBootstrapMemory,
  spawnSite: TerritoryPostClaimBootstrapSpawnSiteMemory,
  result: ScreepsReturnCode,
  telemetryEvents: RuntimeTelemetryEvent[],
  existing = false
): void {
  telemetryEvents.push({
    type: 'spawnSitePlaced',
    roomName: record.roomName,
    colony: record.colony,
    ...(record.controllerId ? { controllerId: record.controllerId } : {}),
    result,
    spawnSite,
    ...(existing ? { existing } : {})
  });
}

function planInitialSpawnConstructionSite(room: Room): SpawnSitePlanResult {
  if (typeof room.createConstructionSite !== 'function') {
    return { result: ERR_INVALID_TARGET_CODE };
  }

  const plannerResult = planInitialSpawnConstructionSiteWithPlanner(room);
  if (plannerResult) {
    return plannerResult;
  }

  const positions = findInitialSpawnConstructionPositions(room);
  if (positions.length === 0) {
    return { result: ERR_INVALID_TARGET_CODE };
  }

  let lastResult = ERR_INVALID_TARGET_CODE;
  for (const position of positions) {
    lastResult = room.createConstructionSite(position.x, position.y, getStructureConstant('STRUCTURE_SPAWN', 'spawn'));
    if (lastResult === OK_CODE) {
      return {
        result: lastResult,
        position: { ...position, roomName: room.name }
      };
    }
  }

  return { result: lastResult };
}

function planInitialSpawnConstructionSiteWithPlanner(room: Room): SpawnSitePlanResult | null {
  const result = planConstructionForColony({
    room,
    spawns: getRoomSpawns(room.name),
    energyAvailable: getRoomEnergyAvailable(room),
    energyCapacityAvailable: getRoomEnergyCapacityAvailable(room)
  });
  const spawnPlacement = result.placements.find((placement) => placement.priority === 'spawn');
  if (!spawnPlacement) {
    return null;
  }

  return {
    result: spawnPlacement.result,
    ...(spawnPlacement.result === OK_CODE &&
    typeof spawnPlacement.x === 'number' &&
    typeof spawnPlacement.y === 'number'
      ? { position: { roomName: room.name, x: spawnPlacement.x, y: spawnPlacement.y } }
      : {})
  };
}

function getRoomSpawns(roomName: string): StructureSpawn[] {
  const spawns = (globalThis as { Game?: Partial<Game> }).Game?.spawns;
  if (!spawns) {
    return [];
  }

  return Object.values(spawns).filter((spawn) => spawn?.room?.name === roomName);
}

function getRoomEnergyAvailable(room: Room): number {
  return typeof room.energyAvailable === 'number' && Number.isFinite(room.energyAvailable)
    ? Math.max(0, room.energyAvailable)
    : 0;
}

function getRoomEnergyCapacityAvailable(room: Room): number {
  return typeof room.energyCapacityAvailable === 'number' && Number.isFinite(room.energyCapacityAvailable)
    ? Math.max(0, room.energyCapacityAvailable)
    : getRoomEnergyAvailable(room);
}

function findInitialSpawnConstructionPositions(room: Room): CandidatePosition[] {
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

        const position = { x, y };
        if (canPlaceInitialSpawn(lookups, position)) {
          positions.push(position);
        }
      }
    }
  }

  return positions;
}

function selectInitialSpawnAnchor(room: Room): CandidatePosition | null {
  const controllerPosition = getRoomObjectPosition(room.controller);
  if (!controllerPosition) {
    return null;
  }

  const sources = findSources(room)
    .map(getRoomObjectPosition)
    .filter((position): position is CandidatePosition => position !== null)
    .sort((left, right) => getRange(controllerPosition, left) - getRange(controllerPosition, right));
  const nearestSourcePosition = sources[0];
  if (!nearestSourcePosition) {
    return clampPosition(controllerPosition);
  }

  return clampPosition({
    x: Math.round((controllerPosition.x + nearestSourcePosition.x) / 2),
    y: Math.round((controllerPosition.y + nearestSourcePosition.y) / 2)
  });
}

function buildSpawnPlacementLookups(
  room: Room,
  anchor: CandidatePosition,
  maximumScanRadius: number
): SpawnPlacementLookups {
  const blockingPositions = new Set<string>();
  const rangeReservedPositions: CandidatePosition[] = [];
  for (const object of [room.controller, ...findSources(room)]) {
    const position = getRoomObjectPosition(object);
    if (position) {
      blockingPositions.add(getPositionKey(position));
      rangeReservedPositions.push(position);
    }
  }

  for (const object of [
    ...lookForArea(room, 'LOOK_STRUCTURES', anchor, maximumScanRadius),
    ...lookForArea(room, 'LOOK_CONSTRUCTION_SITES', anchor, maximumScanRadius)
  ]) {
    const position = getRoomObjectPosition(object);
    if (position) {
      blockingPositions.add(getPositionKey(position));
    }
  }
  const mineralPositions = new Set<string>();
  for (const object of lookForArea(room, 'LOOK_MINERALS', anchor, maximumScanRadius)) {
    const position = getRoomObjectPosition(object);
    if (position) {
      mineralPositions.add(getPositionKey(position));
    }
  }

  return {
    blockingPositions,
    mineralPositions,
    rangeReservedPositions,
    terrain: getRoomTerrain(room.name)
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

  const bounds = getScanBounds(anchor, maximumScanRadius);
  return room.lookForAtArea(
    lookConstant as LookConstant,
    bounds.top,
    bounds.left,
    bounds.bottom,
    bounds.right,
    true
  ) as unknown[];
}

function getScanBounds(
  anchor: CandidatePosition,
  maximumScanRadius: number
): {
  top: number;
  left: number;
  bottom: number;
  right: number;
} {
  return {
    top: Math.max(ROOM_EDGE_MIN, anchor.y - maximumScanRadius),
    left: Math.max(ROOM_EDGE_MIN, anchor.x - maximumScanRadius),
    bottom: Math.min(ROOM_EDGE_MAX, anchor.y + maximumScanRadius),
    right: Math.min(ROOM_EDGE_MAX, anchor.x + maximumScanRadius)
  };
}

function canPlaceInitialSpawn(lookups: SpawnPlacementLookups, position: CandidatePosition): boolean {
  return (
    isWithinRoomBuildBounds(position) &&
    !lookups.blockingPositions.has(getPositionKey(position)) &&
    !lookups.mineralPositions.has(getPositionKey(position)) &&
    hasMinimumSpawnRange(lookups, position) &&
    !isTerrainWall(lookups.terrain, position)
  );
}

function hasMinimumSpawnRange(lookups: SpawnPlacementLookups, position: CandidatePosition): boolean {
  return lookups.rangeReservedPositions.every(
    (reservedPosition) => getRange(position, reservedPosition) >= 2
  );
}

function isWithinRoomBuildBounds(position: CandidatePosition): boolean {
  return (
    position.x >= ROOM_EDGE_MIN &&
    position.x <= ROOM_EDGE_MAX &&
    position.y >= ROOM_EDGE_MIN &&
    position.y <= ROOM_EDGE_MAX
  );
}

function isTerrainWall(terrain: RoomTerrain | null, position: CandidatePosition): boolean {
  return terrain !== null && (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function findExistingSpawnConstructionSite(room: Room): ConstructionSite | null {
  const findConstant = getGlobalNumber('FIND_MY_CONSTRUCTION_SITES');
  if (typeof room.find !== 'function' || findConstant === null) {
    return null;
  }

  const sites = room.find(findConstant as FindConstant, {
    filter: (site: ConstructionSite) => matchesStructureType(site.structureType, 'STRUCTURE_SPAWN', 'spawn')
  }) as ConstructionSite[];
  return sites[0] ?? null;
}

function findSources(room: Room): Source[] {
  const findConstant = getGlobalNumber('FIND_SOURCES');
  if (typeof room.find !== 'function' || findConstant === null) {
    return [];
  }

  return room.find(findConstant as FindConstant) as Source[];
}

function getRoomObjectPosition(object: unknown): CandidatePosition | null {
  if (!isRecord(object)) {
    return null;
  }

  if (isFiniteNumber(object.x) && isFiniteNumber(object.y)) {
    return { x: object.x, y: object.y };
  }

  const pos = object.pos;
  if (isRecord(pos) && isFiniteNumber(pos.x) && isFiniteNumber(pos.y)) {
    return { x: pos.x, y: pos.y };
  }

  return null;
}

function toSpawnSiteMemory(site: ConstructionSite): TerritoryPostClaimBootstrapSpawnSiteMemory {
  const position = getRoomObjectPosition(site);
  return {
    roomName: site.pos?.roomName ?? site.room?.name ?? '',
    x: position?.x ?? site.pos.x,
    y: position?.y ?? site.pos.y
  };
}

function isSameSpawnSite(
  left: TerritoryPostClaimBootstrapSpawnSiteMemory | undefined,
  right: TerritoryPostClaimBootstrapSpawnSiteMemory
): boolean {
  return left?.roomName === right.roomName && left.x === right.x && left.y === right.y;
}

function updatePostClaimBootstrapRecord(
  roomName: string,
  updates: Partial<Omit<TerritoryPostClaimBootstrapMemory, 'colony' | 'roomName' | 'claimedAt'>>
): void {
  const bootstraps = getWritablePostClaimBootstrapRecords();
  const record = bootstraps?.[roomName];
  if (!bootstraps || !record) {
    return;
  }

  bootstraps[roomName] = {
    ...record,
    ...updates
  };
}

function getPostClaimBootstrapRecord(roomName: string): TerritoryPostClaimBootstrapMemory | null {
  const record = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps?.[roomName];
  return isPostClaimBootstrapRecord(record, roomName) ? record : null;
}

function getWritablePostClaimBootstrapRecords(): Record<string, TerritoryPostClaimBootstrapMemory> | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!memory.territory) {
    memory.territory = {};
  }

  if (!memory.territory.postClaimBootstraps) {
    memory.territory.postClaimBootstraps = {};
  }

  return memory.territory.postClaimBootstraps;
}

function isPostClaimBootstrapRecord(
  value: unknown,
  expectedRoomName: string
): value is TerritoryPostClaimBootstrapMemory {
  return (
    isRecord(value) &&
    value.roomName === expectedRoomName &&
    isNonEmptyString(value.colony) &&
    isPostClaimBootstrapStatus(value.status) &&
    isFiniteNumber(value.claimedAt) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isAnyPostClaimBootstrapRecord(value: unknown): value is TerritoryPostClaimBootstrapMemory {
  return isRecord(value) && isNonEmptyString(value.roomName) && isPostClaimBootstrapRecord(value, value.roomName);
}

function isPostClaimBootstrapStatus(value: unknown): value is TerritoryPostClaimBootstrapStatus {
  return (
    value === 'detected' ||
    value === 'spawnSitePending' ||
    value === 'spawnSiteBlocked' ||
    value === 'spawningWorkers' ||
    value === 'ready'
  );
}

function getPostClaimBootstrapWorkerTarget(record: TerritoryPostClaimBootstrapMemory): number {
  return isFiniteNumber(record.workerTarget) && record.workerTarget > 0
    ? Math.floor(record.workerTarget)
    : POST_CLAIM_BOOTSTRAP_WORKER_TARGET;
}

function clampPosition(position: CandidatePosition): CandidatePosition {
  return {
    x: clamp(position.x, ROOM_EDGE_MIN, ROOM_EDGE_MAX),
    y: clamp(position.y, ROOM_EDGE_MIN, ROOM_EDGE_MAX)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getMaximumSpawnSiteScanRadius(anchor: CandidatePosition): number {
  return Math.max(
    anchor.x - ROOM_EDGE_MIN,
    ROOM_EDGE_MAX - anchor.x,
    anchor.y - ROOM_EDGE_MIN,
    ROOM_EDGE_MAX - anchor.y
  );
}

function getRange(left: CandidatePosition, right: CandidatePosition): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function getPositionKey(position: CandidatePosition): string {
  return `${position.x},${position.y}`;
}

function getRoomTerrain(roomName: string): RoomTerrain | null {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  return typeof gameMap?.getRoomTerrain === 'function' ? gameMap.getRoomTerrain(roomName) : null;
}

function getTerrainWallMask(): number {
  return typeof TERRAIN_MASK_WALL === 'number' ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK;
}

function matchesStructureType(
  actual: string | undefined,
  globalName: StructureConstantGlobal,
  fallback: BuildableStructureConstant
): boolean {
  return actual === getStructureConstant(globalName, fallback);
}

function getStructureConstant(
  globalName: StructureConstantGlobal,
  fallback: BuildableStructureConstant
): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, BuildableStructureConstant>>;
  return constants[globalName] ?? fallback;
}

function getGlobalNumber(name: FindConstantGlobal): number | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : null;
}

function getGlobalString(name: LookConstantGlobal): string | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
