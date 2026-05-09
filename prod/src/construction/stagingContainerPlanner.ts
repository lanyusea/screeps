import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  CONTROLLER_STAGING_CONTAINER_RANGE,
  SPAWN_STAGING_CONTAINER_RANGE
} from '../economy/stagingContainers';
import {
  getPositionKey,
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from '../economy/sourceContainers';

type FindConstantGlobal =
  | 'FIND_CONSTRUCTION_SITES'
  | 'FIND_MY_CONSTRUCTION_SITES'
  | 'FIND_SOURCES'
  | 'FIND_STRUCTURES';
type StructureConstantGlobal = 'STRUCTURE_CONTAINER';

interface PositionedRoomPosition {
  x: number;
  y: number;
  roomName?: string;
}

interface StagingContainerPlannerLookups {
  blockingPositions: Set<string>;
  existingContainerPositions: PositionedRoomPosition[];
  pendingContainerPositions: PositionedRoomPosition[];
  terrain: RoomTerrain;
}

export interface StagingContainerPlanningOptions {
  maxContainerSitesPerTick?: number;
  maxPendingContainerSites?: number;
}

const DEFAULT_MAX_CONTAINER_SITES_PER_TICK = 1;
const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const MIN_ADJACENT_WALKWAY_CLEARANCE = 2;

export function planStagingContainerConstruction(
  colony: ColonySnapshot,
  options: StagingContainerPlanningOptions = {}
): ScreepsReturnCode[] {
  const room = colony.room;
  if (!hasRequiredRoomApis(room)) {
    return [];
  }

  const maxSitesPerTick = resolveNonNegativeInteger(
    options.maxContainerSitesPerTick,
    DEFAULT_MAX_CONTAINER_SITES_PER_TICK
  );
  if (maxSitesPerTick <= 0) {
    return [];
  }

  const lookups = createStagingContainerPlannerLookups(room);
  if (!lookups) {
    return [];
  }

  const maxPendingContainerSites = resolveOptionalNonNegativeInteger(options.maxPendingContainerSites);
  if (maxPendingContainerSites !== null && lookups.pendingContainerPositions.length >= maxPendingContainerSites) {
    return [];
  }

  const placements = selectStagingContainerPlacements(colony, lookups);
  const results: ScreepsReturnCode[] = [];
  for (const placement of placements) {
    if (results.length >= maxSitesPerTick) {
      break;
    }

    if (maxPendingContainerSites !== null && lookups.pendingContainerPositions.length >= maxPendingContainerSites) {
      break;
    }

    const result = room.createConstructionSite(placement.x, placement.y, getContainerStructureType());
    results.push(result);
    if (result !== getOkCode()) {
      break;
    }

    lookups.blockingPositions.add(getPositionKey(placement));
    lookups.pendingContainerPositions.push(placement);
  }

  return results;
}

function selectStagingContainerPlacements(
  colony: ColonySnapshot,
  lookups: StagingContainerPlannerLookups
): PositionedRoomPosition[] {
  const placements: PositionedRoomPosition[] = [];
  const spawn = selectPrimarySpawn(colony);
  if (spawn && !hasSpawnStagingContainerCoverage(colony.room, spawn, lookups)) {
    const position = selectSpawnStagingContainerPosition(colony.room, spawn, lookups);
    if (position) {
      placements.push(position);
      lookups.blockingPositions.add(getPositionKey(position));
      lookups.pendingContainerPositions.push(position);
    }
  }

  const controller = colony.room.controller;
  if (controller?.my === true && !hasControllerStagingContainerCoverage(colony.room, controller, lookups)) {
    const position = selectControllerStagingContainerPosition(colony.room, controller, spawn, lookups);
    if (position) {
      placements.push(position);
      lookups.blockingPositions.add(getPositionKey(position));
      lookups.pendingContainerPositions.push(position);
    }
  }

  for (const placement of placements) {
    lookups.blockingPositions.delete(getPositionKey(placement));
    lookups.pendingContainerPositions.pop();
  }

  return placements;
}

function selectPrimarySpawn(colony: ColonySnapshot): StructureSpawn | null {
  return (
    colony.spawns
      .filter((spawn) => getRoomObjectPosition(spawn) !== null && spawn.room?.name === colony.room.name)
      .sort((left, right) => left.name.localeCompare(right.name))[0] ?? null
  );
}

function hasSpawnStagingContainerCoverage(
  room: Room,
  spawn: StructureSpawn,
  lookups: StagingContainerPlannerLookups
): boolean {
  return hasContainerCoverageNearAnchor(room, spawn, SPAWN_STAGING_CONTAINER_RANGE, lookups);
}

function hasControllerStagingContainerCoverage(
  room: Room,
  controller: StructureController,
  lookups: StagingContainerPlannerLookups
): boolean {
  return hasContainerCoverageNearAnchor(room, controller, CONTROLLER_STAGING_CONTAINER_RANGE, lookups);
}

function hasContainerCoverageNearAnchor(
  room: Room,
  anchor: RoomObject,
  range: number,
  lookups: StagingContainerPlannerLookups
): boolean {
  const anchorPosition = getRoomObjectPosition(anchor);
  if (!anchorPosition || !isSameRoomPosition(anchorPosition, room.name)) {
    return false;
  }

  return [...lookups.existingContainerPositions, ...lookups.pendingContainerPositions].some((position) => {
    const distance = getRangeBetweenPositions(anchorPosition, position);
    return isSameRoomPosition(position, room.name) && distance <= range;
  });
}

function selectSpawnStagingContainerPosition(
  room: Room,
  spawn: StructureSpawn,
  lookups: StagingContainerPlannerLookups
): PositionedRoomPosition | null {
  const spawnPosition = getRoomObjectPosition(spawn);
  if (!spawnPosition || !isSameRoomPosition(spawnPosition, room.name)) {
    return null;
  }

  const controllerPosition = room.controller ? getRoomObjectPosition(room.controller) : null;
  return getAdjacentBuildPositions(spawnPosition, room.name)
    .filter((position) => canPlaceStagingContainer(lookups, position))
    .filter((position) => preservesWalkwayClearance(lookups, spawnPosition, position))
    .sort((left, right) =>
      compareOptionalNumber(getOptionalRangeBetweenPositions(left, controllerPosition), getOptionalRangeBetweenPositions(right, controllerPosition)) ||
      left.y - right.y ||
      left.x - right.x
    )[0] ?? null;
}

function selectControllerStagingContainerPosition(
  room: Room,
  controller: StructureController,
  spawn: StructureSpawn | null,
  lookups: StagingContainerPlannerLookups
): PositionedRoomPosition | null {
  const controllerPosition = getRoomObjectPosition(controller);
  if (!controllerPosition || !isSameRoomPosition(controllerPosition, room.name)) {
    return null;
  }

  const spawnPosition = spawn ? getRoomObjectPosition(spawn) : null;
  return getAdjacentBuildPositions(controllerPosition, room.name)
    .filter((position) => canPlaceStagingContainer(lookups, position))
    .filter((position) => preservesWalkwayClearance(lookups, controllerPosition, position))
    .sort((left, right) =>
      compareOptionalNumber(getOptionalRangeBetweenPositions(left, spawnPosition), getOptionalRangeBetweenPositions(right, spawnPosition)) ||
      left.y - right.y ||
      left.x - right.x
    )[0] ?? null;
}

function createStagingContainerPlannerLookups(room: Room): StagingContainerPlannerLookups | null {
  const terrain = getRoomTerrain(room);
  const structures = findRoomObjects<Structure>(room, 'FIND_STRUCTURES');
  const constructionSites = findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES');
  if (!terrain || structures === null || constructionSites === null) {
    return null;
  }

  const lookups: StagingContainerPlannerLookups = {
    blockingPositions: new Set<string>(),
    existingContainerPositions: [],
    pendingContainerPositions: [],
    terrain
  };

  addBlockingPosition(lookups, room.controller ? getRoomObjectPosition(room.controller) : null);
  for (const source of findRoomObjects<Source>(room, 'FIND_SOURCES') ?? []) {
    addBlockingPosition(lookups, getRoomObjectPosition(source));
  }

  for (const structure of structures) {
    const position = getRoomObjectPosition(structure);
    addBlockingPosition(lookups, position);
    if (isContainerStructureType(structure.structureType)) {
      addPosition(lookups.existingContainerPositions, position);
    }
  }

  for (const site of constructionSites) {
    const position = getRoomObjectPosition(site);
    addBlockingPosition(lookups, position);
    if (isContainerStructureType(site.structureType)) {
      addPosition(lookups.pendingContainerPositions, position);
    }
  }

  return lookups;
}

function getAdjacentBuildPositions(center: PositionedRoomPosition, roomName: string): PositionedRoomPosition[] {
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

function canPlaceStagingContainer(
  lookups: StagingContainerPlannerLookups,
  position: PositionedRoomPosition
): boolean {
  return (
    isWithinBuildableRoomBounds(position) &&
    !isTerrainWall(lookups.terrain, position) &&
    !lookups.blockingPositions.has(getPositionKey(position))
  );
}

function preservesWalkwayClearance(
  lookups: StagingContainerPlannerLookups,
  anchor: PositionedRoomPosition,
  candidate: PositionedRoomPosition
): boolean {
  const clearPositions = getAdjacentBuildPositions(anchor, candidate.roomName ?? anchor.roomName ?? '')
    .filter((position) => isWithinBuildableRoomBounds(position))
    .filter((position) => !isTerrainWall(lookups.terrain, position))
    .filter((position) => {
      const key = getPositionKey(position);
      return key !== getPositionKey(candidate) && !lookups.blockingPositions.has(key);
    });

  return clearPositions.length >= MIN_ADJACENT_WALKWAY_CLEARANCE;
}

function hasRequiredRoomApis(room: Room): boolean {
  return (
    typeof room.find === 'function' &&
    typeof room.createConstructionSite === 'function' &&
    getFindConstant('FIND_STRUCTURES') !== null &&
    getFindConstant('FIND_CONSTRUCTION_SITES') !== null
  );
}

function findRoomObjects<T>(room: Room, globalName: FindConstantGlobal): T[] | null {
  const findConstant = getFindConstant(globalName);
  if (findConstant === null || typeof room.find !== 'function') {
    return null;
  }

  try {
    const found = room.find(findConstant as FindConstant);
    return Array.isArray(found) ? (found as T[]) : [];
  } catch {
    return [];
  }
}

function addBlockingPosition(
  lookups: StagingContainerPlannerLookups,
  position: PositionedRoomPosition | null
): void {
  if (position) {
    lookups.blockingPositions.add(getPositionKey(position));
  }
}

function addPosition(
  positions: PositionedRoomPosition[],
  position: PositionedRoomPosition | null
): void {
  if (position) {
    positions.push(position);
  }
}

function isContainerStructureType(structureType: string | undefined): boolean {
  return structureType === getContainerStructureType();
}

function isWithinBuildableRoomBounds(position: PositionedRoomPosition): boolean {
  return (
    position.x >= ROOM_EDGE_MIN &&
    position.x <= ROOM_EDGE_MAX &&
    position.y >= ROOM_EDGE_MIN &&
    position.y <= ROOM_EDGE_MAX
  );
}

function isTerrainWall(terrain: RoomTerrain, position: PositionedRoomPosition): boolean {
  return (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  return typeof game?.map?.getRoomTerrain === 'function' ? game.map.getRoomTerrain(room.name) : null;
}

function getFindConstant(globalName: FindConstantGlobal): number | null {
  const value = (globalThis as unknown as Record<FindConstantGlobal, unknown>)[globalName];
  return typeof value === 'number' ? value : null;
}

function getContainerStructureType(): BuildableStructureConstant {
  return ((globalThis as Partial<Record<StructureConstantGlobal, StructureConstant>>).STRUCTURE_CONTAINER ??
    'container') as BuildableStructureConstant;
}

function getTerrainWallMask(): number {
  const value = (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof value === 'number' ? value : DEFAULT_TERRAIN_WALL_MASK;
}

function getOkCode(): ScreepsReturnCode {
  return ((globalThis as { OK?: ScreepsReturnCode }).OK ?? 0) as ScreepsReturnCode;
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function resolveOptionalNonNegativeInteger(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.floor(value));
}

function compareOptionalNumber(left: number | null, right: number | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

function getOptionalRangeBetweenPositions(
  left: PositionedRoomPosition,
  right: PositionedRoomPosition | null
): number | null {
  return right === null ? null : getRangeBetweenPositions(left, right);
}
