import type { ColonySnapshot } from '../colony/colonyRegistry';
import { getExtensionLimitForRcl, planExtensionConstruction } from '../construction/extensionPlanner';
import { planEarlyRoadConstruction } from '../construction/roadPlanner';
import { planTowerConstruction } from '../construction/constructionPriority';
import {
  findSourceContainer,
  findSourceContainerConstructionSite,
  getPositionKey,
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from '../economy/sourceContainers';

const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const SPAWN_EDGE_MIN = 2;
const SPAWN_EDGE_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const OK_CODE = 0 as ScreepsReturnCode;

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
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_ROAD'
  | 'STRUCTURE_TOWER';

interface CandidatePosition {
  x: number;
  y: number;
  roomName?: string;
}

interface SpawnPlacementLookups {
  blockingPositions: Set<string>;
  mineralPositions: Set<string>;
  terrain: RoomTerrain | null;
}

interface SourceContainerLookups {
  terrain: RoomTerrain;
  blockedPositions: Set<string>;
}

export type ClaimedRoomBootstrapPhase =
  | 'spawn'
  | 'extension'
  | 'sourceContainer'
  | 'road'
  | 'tower'
  | 'complete';

export interface ClaimedRoomBootstrapPlanResult {
  roomName: string;
  phase: ClaimedRoomBootstrapPhase;
  result?: ScreepsReturnCode;
  results?: ScreepsReturnCode[];
}

export interface ClaimedRoomOwnershipRefreshResult {
  detectedRoomNames: string[];
}

export interface ClaimedRoomBootstrapRunResult extends ClaimedRoomOwnershipRefreshResult {
  activeRoomNames: string[];
  planned: ClaimedRoomBootstrapPlanResult[];
}

export function refreshClaimedRoomBootstrapperOwnership(): ClaimedRoomOwnershipRefreshResult {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const rooms = game?.rooms;
  const memory = getWritableBootstrapperMemory();
  if (!rooms || !memory) {
    return { detectedRoomNames: [] };
  }

  const detectedRoomNames: string[] = [];
  for (const room of Object.values(rooms)) {
    if (!room?.name || !room.controller) {
      continue;
    }

    const owned = room.controller.my === true;
    const previous = memory.rooms[room.name];
    const activePostClaimRecord = getActivePostClaimBootstrapRecord(room.name);
    const newlyClaimed = owned && previous?.owned === false;
    if (newlyClaimed) {
      detectedRoomNames.push(room.name);
    }

    const claimedAt = newlyClaimed
      ? getGameTime()
      : previous?.claimedAt ?? activePostClaimRecord?.claimedAt;
    memory.rooms[room.name] = {
      roomName: room.name,
      owned,
      updatedAt: getGameTime(),
      ...(claimedAt !== undefined ? { claimedAt } : {}),
      ...(newlyClaimed ? {} : previous?.completedAt !== undefined ? { completedAt: previous.completedAt } : {})
    };
  }

  return { detectedRoomNames };
}

export function runClaimedRoomBootstrapper(colonies: ColonySnapshot[]): ClaimedRoomBootstrapRunResult {
  const refreshResult = refreshClaimedRoomBootstrapperOwnership();
  const activeRoomNames: string[] = [];
  const planned: ClaimedRoomBootstrapPlanResult[] = [];

  for (const colony of colonies) {
    const result = runClaimedRoomBootstrapperForColony(colony);
    if (!result) {
      continue;
    }

    activeRoomNames.push(colony.room.name);
    if (result.phase !== 'complete' && (result.phase !== 'spawn' || result.result !== undefined || result.results !== undefined)) {
      planned.push(result);
    }
  }

  return {
    ...refreshResult,
    activeRoomNames,
    planned
  };
}

export function runClaimedRoomBootstrapperForColony(
  colony: ColonySnapshot
): ClaimedRoomBootstrapPlanResult | null {
  const room = colony.room;
  if (room.controller?.my !== true || !isClaimedRoomBootstrapActive(room.name)) {
    return null;
  }

  const spawnStatus = getSpawnBootstrapStatus(colony);
  if (!spawnStatus.hasSpawn) {
    if (!spawnStatus.hasSpawnSite) {
      const result = placeSpawnConstructionSite(room);
      return result === null ? { roomName: room.name, phase: 'spawn' } : { roomName: room.name, phase: 'spawn', result };
    }

    return { roomName: room.name, phase: 'spawn' };
  }

  if (countExistingAndPendingStructures(room, 'STRUCTURE_EXTENSION', 'extension') < getExtensionLimitForRcl(room.controller.level)) {
    const result = planExtensionConstruction(colony);
    if (result !== null) {
      return { roomName: room.name, phase: 'extension', result };
    }
  }

  const sourceContainerResults = planMissingSourceContainerConstructionSites(colony);
  if (sourceContainerResults.length > 0) {
    return { roomName: room.name, phase: 'sourceContainer', results: sourceContainerResults };
  }

  const roadResults = planEarlyRoadConstruction(colony, {
    maxSitesPerTick: 1,
    maxPendingRoadSites: 100,
    maxTargetsPerTick: 3
  });
  if (roadResults.length > 0) {
    return { roomName: room.name, phase: 'road', results: roadResults };
  }

  if ((room.controller.level ?? 0) >= 3 && countExistingAndPendingStructures(room, 'STRUCTURE_TOWER', 'tower') <= 0) {
    const result = planTowerConstruction(colony);
    if (result !== null) {
      return { roomName: room.name, phase: 'tower', result };
    }
  }

  if (isClaimedRoomBootstrapComplete(colony)) {
    markClaimedRoomBootstrapComplete(room.name);
    return { roomName: room.name, phase: 'complete' };
  }

  return { roomName: room.name, phase: 'complete' };
}

export function isClaimedRoomBootstrapActive(roomName: string): boolean {
  const record = getBootstrapperRoomRecord(roomName);
  if (record?.owned !== true) {
    return false;
  }

  if (record.claimedAt === undefined && !getActivePostClaimBootstrapRecord(roomName)) {
    return false;
  }

  return record.completedAt === undefined;
}

function getSpawnBootstrapStatus(colony: ColonySnapshot): { hasSpawn: boolean; hasSpawnSite: boolean } {
  const room = colony.room;
  return {
    hasSpawn:
      colony.spawns.some((spawn) => spawn.room?.name === room.name) ||
      countExistingStructures(room, 'STRUCTURE_SPAWN', 'spawn') > 0,
    hasSpawnSite: countPendingConstructionSites(room, 'STRUCTURE_SPAWN', 'spawn') > 0
  };
}

function placeSpawnConstructionSite(room: Room): ScreepsReturnCode | null {
  if (typeof room.createConstructionSite !== 'function') {
    return null;
  }

  const positions = findSpawnConstructionPositions(room);
  for (const position of positions) {
    const result = room.createConstructionSite(position.x, position.y, getStructureConstant('STRUCTURE_SPAWN', 'spawn'));
    if (result === OK_CODE) {
      return result;
    }
  }

  return null;
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
  const controllerPosition = getRoomObjectPosition(room.controller as RoomObject);
  if (!controllerPosition) {
    return null;
  }

  const nearestSourcePosition = getSortedSources(room)
    .map((source) => getRoomObjectPosition(source))
    .filter((position): position is RoomPosition => position !== null)
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
  for (const object of [
    room.controller,
    ...getSortedSources(room),
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
    const result = room.lookForAtArea(
      lookConstant as LookConstant,
      bounds.top,
      bounds.left,
      bounds.bottom,
      bounds.right,
      true
    );
    return Array.isArray(result) ? result : [];
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
    !isTerrainWall(lookups.terrain, position)
  );
}

function planMissingSourceContainerConstructionSites(colony: ColonySnapshot): ScreepsReturnCode[] {
  const room = colony.room;
  if (
    typeof room.createConstructionSite !== 'function' ||
    (room.controller?.level ?? 0) < 2 ||
    typeof FIND_SOURCES !== 'number'
  ) {
    return [];
  }

  const sources = getSortedSources(room);
  if (sources.length === 0 || sources.every((source) => hasSourceContainerCoverage(room, source))) {
    return [];
  }

  const lookups = createSourceContainerLookups(room);
  if (!lookups) {
    return [];
  }

  const anchor = selectSourceContainerAnchor(colony);
  const results: ScreepsReturnCode[] = [];
  for (const source of sources) {
    if (hasSourceContainerCoverage(room, source)) {
      continue;
    }

    const position = selectSourceContainerPosition(source, lookups, anchor);
    if (!position) {
      continue;
    }

    const result = room.createConstructionSite(position.x, position.y, getStructureConstant('STRUCTURE_CONTAINER', 'container'));
    results.push(result);
    if (result !== OK_CODE) {
      break;
    }

    lookups.blockedPositions.add(getPositionKey(position));
  }

  return results;
}

function hasSourceContainerCoverage(room: Room, source: Source): boolean {
  return findSourceContainer(room, source) !== null || findSourceContainerConstructionSite(room, source) !== null;
}

function createSourceContainerLookups(room: Room): SourceContainerLookups | null {
  if (typeof FIND_STRUCTURES !== 'number' || typeof FIND_CONSTRUCTION_SITES !== 'number') {
    return null;
  }

  const terrain = getRoomTerrain(room);
  if (!terrain) {
    return null;
  }

  const blockedPositions = new Set<string>();
  for (const object of [
    ...findRoomObjects(room, 'FIND_STRUCTURES'),
    ...findRoomObjects(room, 'FIND_CONSTRUCTION_SITES')
  ]) {
    const position = getAnyObjectPosition(object);
    if (position && isSameRoomPosition(position, room.name)) {
      blockedPositions.add(getPositionKey(position));
    }
  }

  return { terrain, blockedPositions };
}

function selectSourceContainerAnchor(colony: ColonySnapshot): RoomPosition | null {
  const [primarySpawn] = colony.spawns
    .filter((spawn) => getRoomObjectPosition(spawn) !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  return getRoomObjectPosition(primarySpawn ?? (colony.room.controller as RoomObject | undefined));
}

function selectSourceContainerPosition(
  source: Source,
  lookups: SourceContainerLookups,
  anchor: RoomPosition | null
): CandidatePosition | null {
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition || typeof sourcePosition.roomName !== 'string') {
    return null;
  }

  const positions: CandidatePosition[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      positions.push({
        x: sourcePosition.x + dx,
        y: sourcePosition.y + dy,
        roomName: sourcePosition.roomName
      });
    }
  }

  return positions
    .filter((position) => canPlaceSourceContainer(lookups, position))
    .sort((left, right) => compareSourceContainerPositions(left, right, anchor))[0] ?? null;
}

function canPlaceSourceContainer(lookups: SourceContainerLookups, position: CandidatePosition): boolean {
  if (
    position.x < ROOM_EDGE_MIN ||
    position.x > ROOM_EDGE_MAX ||
    position.y < ROOM_EDGE_MIN ||
    position.y > ROOM_EDGE_MAX ||
    isTerrainWall(lookups.terrain, position)
  ) {
    return false;
  }

  return !lookups.blockedPositions.has(getPositionKey(position));
}

function compareSourceContainerPositions(
  left: CandidatePosition,
  right: CandidatePosition,
  anchor: RoomPosition | null
): number {
  if (anchor) {
    const leftRange = getRangeBetweenPositions(left, anchor);
    const rightRange = getRangeBetweenPositions(right, anchor);
    if (leftRange !== rightRange) {
      return leftRange - rightRange;
    }
  }

  return left.y - right.y || left.x - right.x;
}

function isClaimedRoomBootstrapComplete(colony: ColonySnapshot): boolean {
  const room = colony.room;
  if (!getSpawnBootstrapStatus(colony).hasSpawn) {
    return false;
  }

  if (countExistingAndPendingStructures(room, 'STRUCTURE_EXTENSION', 'extension') < getExtensionLimitForRcl(room.controller?.level)) {
    return false;
  }

  if (getSortedSources(room).some((source) => !hasSourceContainerCoverage(room, source))) {
    return false;
  }

  if ((room.controller?.level ?? 0) >= 3 && countExistingAndPendingStructures(room, 'STRUCTURE_TOWER', 'tower') <= 0) {
    return false;
  }

  return true;
}

function markClaimedRoomBootstrapComplete(roomName: string): void {
  const memory = getWritableBootstrapperMemory();
  const record = memory?.rooms[roomName];
  if (!memory || !record || record.completedAt !== undefined) {
    return;
  }

  memory.rooms[roomName] = {
    ...record,
    completedAt: getGameTime(),
    updatedAt: getGameTime()
  };
}

function countExistingAndPendingStructures(
  room: Room,
  globalName: StructureConstantGlobal,
  fallback: string
): number {
  return countExistingStructures(room, globalName, fallback) + countPendingConstructionSites(room, globalName, fallback);
}

function countExistingStructures(room: Room, globalName: StructureConstantGlobal, fallback: string): number {
  return findRoomObjects(room, 'FIND_MY_STRUCTURES').filter((object) =>
    matchesStructureType((object as { structureType?: string }).structureType, globalName, fallback)
  ).length;
}

function countPendingConstructionSites(room: Room, globalName: StructureConstantGlobal, fallback: string): number {
  return findRoomObjects(room, 'FIND_MY_CONSTRUCTION_SITES').filter((object) =>
    matchesStructureType((object as { structureType?: string }).structureType, globalName, fallback)
  ).length;
}

function getSortedSources(room: Room): Source[] {
  return findRoomObjects(room, 'FIND_SOURCES')
    .filter((source): source is Source => {
      const position = getAnyObjectPosition(source);
      return position !== null && isSameRoomPosition(position, room.name);
    })
    .sort((left, right) => String((left as { id?: string }).id).localeCompare(String((right as { id?: string }).id)));
}

function findRoomObjects(room: Room, globalName: FindConstantGlobal): unknown[] {
  const findConstant = getGlobalNumber(globalName);
  if (findConstant === null || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? result : [];
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

function getRoomTerrain(room: Room): RoomTerrain | null {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  return typeof gameMap?.getRoomTerrain === 'function' ? gameMap.getRoomTerrain(room.name) : null;
}

function isTerrainWall(terrain: RoomTerrain | null, position: CandidatePosition): boolean {
  return terrain !== null && (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function getMaximumSpawnSiteScanRadius(anchor: CandidatePosition): number {
  return Math.max(
    anchor.x - SPAWN_EDGE_MIN,
    SPAWN_EDGE_MAX - anchor.x,
    anchor.y - SPAWN_EDGE_MIN,
    SPAWN_EDGE_MAX - anchor.y
  );
}

function clampSpawnPosition(position: CandidatePosition): CandidatePosition {
  return {
    x: Math.max(SPAWN_EDGE_MIN, Math.min(SPAWN_EDGE_MAX, position.x)),
    y: Math.max(SPAWN_EDGE_MIN, Math.min(SPAWN_EDGE_MAX, position.y)),
    roomName: position.roomName
  };
}

function getBootstrapperRoomRecord(roomName: string): TerritoryClaimedRoomBootstrapMemory | null {
  const record = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.claimedRoomBootstrapper?.rooms?.[roomName];
  return isBootstrapperRoomRecord(record, roomName) ? record : null;
}

function getWritableBootstrapperMemory(): TerritoryClaimedRoomBootstrapperMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!memory.territory) {
    memory.territory = {};
  }

  if (!memory.territory.claimedRoomBootstrapper) {
    memory.territory.claimedRoomBootstrapper = { rooms: {} };
  }

  return memory.territory.claimedRoomBootstrapper;
}

function getActivePostClaimBootstrapRecord(roomName: string): TerritoryPostClaimBootstrapMemory | null {
  const record = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps?.[roomName];
  return isRecord(record) && record.roomName === roomName && record.status !== 'ready'
    ? (record as TerritoryPostClaimBootstrapMemory)
    : null;
}

function isBootstrapperRoomRecord(
  value: unknown,
  expectedRoomName: string
): value is TerritoryClaimedRoomBootstrapMemory {
  return (
    isRecord(value) &&
    value.roomName === expectedRoomName &&
    typeof value.owned === 'boolean' &&
    isFiniteNumber(value.updatedAt)
  );
}

function matchesStructureType(
  actual: string | undefined,
  globalName: StructureConstantGlobal,
  fallback: string
): boolean {
  return actual === getStructureConstant(globalName, fallback);
}

function getStructureConstant(
  globalName: StructureConstantGlobal,
  fallback: string
): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, BuildableStructureConstant>>;
  return constants[globalName] ?? (fallback as BuildableStructureConstant);
}

function getGlobalNumber(name: FindConstantGlobal): number | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : null;
}

function getGlobalString(name: LookConstantGlobal): string | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

function getTerrainWallMask(): number {
  const terrainWallMask = (globalThis as unknown as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof terrainWallMask === 'number' ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
