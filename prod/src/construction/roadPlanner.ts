import type { ColonySnapshot } from '../colony/colonyRegistry';

const DEFAULT_MAX_ROAD_SITES_PER_TICK = 1;
const DEFAULT_MAX_PENDING_ROAD_SITES = 3;
const DEFAULT_MAX_ROAD_TARGETS_PER_TICK = 4;
const DEFAULT_MAX_PATH_OPS_PER_TARGET = 1_000;
const MIN_CONTROLLER_LEVEL_FOR_ROADS = 2;
const SOURCE_CONTROLLER_ROAD_MAX_RANGE = 6;
const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const ROOM_COORDINATE_MIN = 0;
const ROOM_COORDINATE_MAX = 49;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const PATH_BLOCKED_COST = 0xff;
const ROAD_PATH_COST = 1;
const PLAIN_PATH_COST = 2;
const SWAMP_PATH_COST = 10;

export interface EarlyRoadPlannerOptions {
  maxSitesPerTick?: number;
  maxPendingRoadSites?: number;
  maxTargetsPerTick?: number;
  maxPathOpsPerTarget?: number;
}

interface RoadPlannerLimits {
  maxSitesPerTick: number;
  maxPendingRoadSites: number;
  maxTargetsPerTick: number;
  maxPathOpsPerTarget: number;
}

interface RoadTarget {
  pos: RoomPosition;
}

interface RoadRoute {
  origin: RoomPosition;
  priority: number;
  target: RoadTarget;
}

interface RoadPlannerLookups {
  terrain: RoomTerrain;
  costMatrix: CostMatrix;
  blockingPositions: Set<string>;
  existingRoadPositions: Set<string>;
  pendingRoadSitePositions: Set<string>;
  pathBlockedPositions: Set<string>;
}

interface RoadCandidate {
  x: number;
  y: number;
  key: string;
  minRoutePriority: number;
  routeCount: number;
  minPathIndex: number;
  minTargetIndex: number;
}

interface Positioned {
  x: number;
  y: number;
  roomName?: string;
}

type StructureConstantGlobal = 'STRUCTURE_ROAD';

export function planEarlyRoadConstruction(
  colony: ColonySnapshot,
  options: EarlyRoadPlannerOptions = {}
): ScreepsReturnCode[] {
  const limits = resolveRoadPlannerLimits(options);
  if (
    limits.maxSitesPerTick <= 0 ||
    limits.maxPendingRoadSites <= 0 ||
    (colony.room.controller?.level ?? 0) < MIN_CONTROLLER_LEVEL_FOR_ROADS ||
    !isPathFinderAvailable() ||
    !hasRequiredRoomApis(colony.room)
  ) {
    return [];
  }

  const anchor = selectRoadAnchor(colony);
  if (!anchor) {
    return [];
  }

  const pendingRoadSites = countPendingRoadConstructionSites(colony.room);
  const remainingSiteBudget = Math.min(limits.maxSitesPerTick, limits.maxPendingRoadSites - pendingRoadSites);
  if (remainingSiteBudget <= 0) {
    return [];
  }

  const routes = selectRoadRoutes(colony.room, anchor.pos, limits.maxTargetsPerTick);
  if (routes.length === 0) {
    return [];
  }

  const lookups = createRoadPlannerLookups(colony.room);
  if (!lookups) {
    return [];
  }

  const candidates = selectRoadCandidates(colony.room.name, routes, lookups, limits);
  const results: ScreepsReturnCode[] = [];
  for (const candidate of candidates) {
    if (results.length >= remainingSiteBudget) {
      break;
    }

    if (!canPlaceRoad(lookups, candidate)) {
      continue;
    }

    const result = colony.room.createConstructionSite(candidate.x, candidate.y, getRoadStructureType());
    results.push(result);

    if (result !== getOkCode()) {
      break;
    }

    lookups.pendingRoadSitePositions.add(candidate.key);
    lookups.costMatrix.set(candidate.x, candidate.y, ROAD_PATH_COST);
  }

  return results;
}

function resolveRoadPlannerLimits(options: EarlyRoadPlannerOptions): RoadPlannerLimits {
  return {
    maxSitesPerTick: resolveNonNegativeInteger(options.maxSitesPerTick, DEFAULT_MAX_ROAD_SITES_PER_TICK),
    maxPendingRoadSites: resolveNonNegativeInteger(options.maxPendingRoadSites, DEFAULT_MAX_PENDING_ROAD_SITES),
    maxTargetsPerTick: resolveNonNegativeInteger(options.maxTargetsPerTick, DEFAULT_MAX_ROAD_TARGETS_PER_TICK),
    maxPathOpsPerTarget: resolveNonNegativeInteger(options.maxPathOpsPerTarget, DEFAULT_MAX_PATH_OPS_PER_TARGET)
  };
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function isPathFinderAvailable(): boolean {
  return typeof PathFinder !== 'undefined' && typeof PathFinder.search === 'function' && typeof PathFinder.CostMatrix === 'function';
}

function hasRequiredRoomApis(room: Room): boolean {
  const partialRoom = room as Partial<Room>;
  return (
    typeof partialRoom.find === 'function' &&
    typeof partialRoom.createConstructionSite === 'function'
  );
}

function selectRoadAnchor(colony: ColonySnapshot): StructureSpawn | null {
  const [primarySpawn] = colony.spawns
    .filter((spawn) => spawn.pos)
    .sort((left, right) => left.name.localeCompare(right.name));

  return primarySpawn ?? null;
}

function selectRoadRoutes(room: Room, anchor: RoomPosition, maxRoutes: number): RoadRoute[] {
  if (maxRoutes <= 0) {
    return [];
  }

  const routes: RoadRoute[] = selectRoadTargets(room).map((target) =>
    createRoadRoute(anchor, target, 1)
  );

  routes.push(...selectSourceControllerRoadRoutes(room));

  return routes.slice(0, maxRoutes);
}

function selectRoadTargets(room: Room): RoadTarget[] {
  const targets: RoadTarget[] = getSortedSources(room).map((source) => ({ pos: source.pos }));
  const controllerPosition = room.controller?.pos;
  if (controllerPosition && isSameRoomPosition(controllerPosition, room.name)) {
    targets.push({ pos: controllerPosition });
  }

  return targets.filter((target) => isSameRoomPosition(target.pos, room.name));
}

function selectSourceControllerRoadRoutes(room: Room): RoadRoute[] {
  const controllerPosition = room.controller?.pos;
  if (!controllerPosition || !isSameRoomPosition(controllerPosition, room.name)) {
    return [];
  }

  return getSortedSources(room)
    .filter((source) => getRangeBetweenPositions(source.pos, controllerPosition) <= SOURCE_CONTROLLER_ROAD_MAX_RANGE)
    .map((source) => createRoadRoute(source.pos, { pos: controllerPosition }, 0));
}

function createRoadRoute(origin: RoomPosition, target: RoadTarget, priority: number): RoadRoute {
  return { origin, priority, target };
}

function getSortedSources(room: Room): Source[] {
  if (typeof FIND_SOURCES !== 'number') {
    return [];
  }

  return room
    .find(FIND_SOURCES)
    .filter((source) => source.pos && isSameRoomPosition(source.pos, room.name))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function countPendingRoadConstructionSites(room: Room): number {
  if (typeof FIND_MY_CONSTRUCTION_SITES !== 'number') {
    return 0;
  }

  return room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: isRoadConstructionSite
  }).length;
}

function createRoadPlannerLookups(room: Room): RoadPlannerLookups | null {
  if (typeof FIND_STRUCTURES !== 'number' || typeof FIND_CONSTRUCTION_SITES !== 'number') {
    return null;
  }

  const terrain = getRoomTerrain(room);
  if (!terrain) {
    return null;
  }

  const lookups: RoadPlannerLookups = {
    terrain,
    costMatrix: new PathFinder.CostMatrix(),
    blockingPositions: new Set<string>(),
    existingRoadPositions: new Set<string>(),
    pendingRoadSitePositions: new Set<string>(),
    pathBlockedPositions: new Set<string>()
  };

  blockRoomEdges(lookups);
  cacheRoomStructures(room, lookups);
  cacheRoomConstructionSites(room, lookups);

  return lookups;
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const game = (globalThis as unknown as { Game?: Partial<Game> }).Game;
  if (!game?.map || typeof game.map.getRoomTerrain !== 'function') {
    return null;
  }

  return game.map.getRoomTerrain(room.name);
}

function blockRoomEdges(lookups: RoadPlannerLookups): void {
  for (let coordinate = ROOM_COORDINATE_MIN; coordinate <= ROOM_COORDINATE_MAX; coordinate += 1) {
    blockPathPosition(lookups, { x: ROOM_COORDINATE_MIN, y: coordinate });
    blockPathPosition(lookups, { x: ROOM_COORDINATE_MAX, y: coordinate });
    blockPathPosition(lookups, { x: coordinate, y: ROOM_COORDINATE_MIN });
    blockPathPosition(lookups, { x: coordinate, y: ROOM_COORDINATE_MAX });
  }
}

function cacheRoomStructures(room: Room, lookups: RoadPlannerLookups): void {
  for (const structure of room.find(FIND_STRUCTURES)) {
    const position = structure.pos;
    if (!position || !isSameRoomPosition(position, room.name)) {
      continue;
    }

    const key = getPositionKey(position);
    if (isRoadStructure(structure)) {
      lookups.existingRoadPositions.add(key);
      setRoadPathCostIfOpen(lookups, position);
      continue;
    }

    lookups.blockingPositions.add(key);
    blockPathPosition(lookups, position);
  }
}

function cacheRoomConstructionSites(room: Room, lookups: RoadPlannerLookups): void {
  for (const constructionSite of room.find(FIND_CONSTRUCTION_SITES)) {
    const position = constructionSite.pos;
    if (!position || !isSameRoomPosition(position, room.name)) {
      continue;
    }

    const key = getPositionKey(position);
    if (isRoadConstructionSite(constructionSite)) {
      lookups.pendingRoadSitePositions.add(key);
      setRoadPathCostIfOpen(lookups, position);
      continue;
    }

    lookups.blockingPositions.add(key);
    blockPathPosition(lookups, position);
  }
}

function selectRoadCandidates(
  roomName: string,
  routes: RoadRoute[],
  lookups: RoadPlannerLookups,
  limits: RoadPlannerLimits
): RoadCandidate[] {
  const candidates = new Map<string, RoadCandidate>();

  routes.forEach((route, targetIndex) => {
    const path = findRoadPath(roomName, route.origin, route.target, lookups, limits);
    const seenInRoute = new Set<string>();

    path.forEach((position, pathIndex) => {
      if (!isSameRoomPosition(position, roomName) || !canPlaceRoad(lookups, position)) {
        return;
      }

      const key = getPositionKey(position);
      if (seenInRoute.has(key)) {
        return;
      }

      seenInRoute.add(key);
      const existingCandidate = candidates.get(key);
      if (existingCandidate) {
        existingCandidate.routeCount += 1;
        existingCandidate.minRoutePriority = Math.min(existingCandidate.minRoutePriority, route.priority);
        existingCandidate.minPathIndex = Math.min(existingCandidate.minPathIndex, pathIndex);
        existingCandidate.minTargetIndex = Math.min(existingCandidate.minTargetIndex, targetIndex);
        return;
      }

      candidates.set(key, {
        x: position.x,
        y: position.y,
        key,
        minRoutePriority: route.priority,
        routeCount: 1,
        minPathIndex: pathIndex,
        minTargetIndex: targetIndex
      });
    });
  });

  return [...candidates.values()].sort(compareRoadCandidates);
}

function findRoadPath(
  roomName: string,
  origin: RoomPosition,
  target: RoadTarget,
  lookups: RoadPlannerLookups,
  limits: RoadPlannerLimits
): RoomPosition[] {
  const result = PathFinder.search(origin, { pos: target.pos, range: 1 }, {
    maxRooms: 1,
    maxOps: limits.maxPathOpsPerTarget,
    plainCost: PLAIN_PATH_COST,
    swampCost: SWAMP_PATH_COST,
    roomCallback: (callbackRoomName) => (callbackRoomName === roomName ? lookups.costMatrix : false)
  });

  return result.incomplete ? [] : result.path;
}

function compareRoadCandidates(left: RoadCandidate, right: RoadCandidate): number {
  return (
    right.routeCount - left.routeCount ||
    left.minRoutePriority - right.minRoutePriority ||
    left.minPathIndex - right.minPathIndex ||
    left.minTargetIndex - right.minTargetIndex ||
    left.y - right.y ||
    left.x - right.x
  );
}

function canPlaceRoad(lookups: RoadPlannerLookups, position: Positioned): boolean {
  if (!isWithinBuildableRoomBounds(position) || isTerrainWall(lookups.terrain, position)) {
    return false;
  }

  const key = getPositionKey(position);
  return (
    !lookups.blockingPositions.has(key) &&
    !lookups.existingRoadPositions.has(key) &&
    !lookups.pendingRoadSitePositions.has(key)
  );
}

function blockPathPosition(lookups: RoadPlannerLookups, position: Positioned): void {
  lookups.pathBlockedPositions.add(getPositionKey(position));
  lookups.costMatrix.set(position.x, position.y, PATH_BLOCKED_COST);
}

function setRoadPathCostIfOpen(lookups: RoadPlannerLookups, position: Positioned): void {
  if (!lookups.pathBlockedPositions.has(getPositionKey(position))) {
    lookups.costMatrix.set(position.x, position.y, ROAD_PATH_COST);
  }
}

function isWithinBuildableRoomBounds(position: Positioned): boolean {
  return position.x >= ROOM_EDGE_MIN && position.x <= ROOM_EDGE_MAX && position.y >= ROOM_EDGE_MIN && position.y <= ROOM_EDGE_MAX;
}

function isSameRoomPosition(position: Positioned, roomName: string): boolean {
  return !position.roomName || position.roomName === roomName;
}

function getRangeBetweenPositions(left: Positioned, right: Positioned): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function isTerrainWall(terrain: RoomTerrain, position: Positioned): boolean {
  return (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function isRoadStructure(structure: Structure): boolean {
  return matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road');
}

function isRoadConstructionSite(site: ConstructionSite): boolean {
  return matchesStructureType(site.structureType, 'STRUCTURE_ROAD', 'road');
}

function matchesStructureType(actual: string | undefined, globalName: StructureConstantGlobal, fallback: string): boolean {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function getRoadStructureType(): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<Record<StructureConstantGlobal, BuildableStructureConstant>>;
  return constants.STRUCTURE_ROAD ?? ('road' as BuildableStructureConstant);
}

function getPositionKey(position: Positioned): string {
  return `${position.x},${position.y}`;
}

function getTerrainWallMask(): number {
  return typeof TERRAIN_MASK_WALL === 'number' ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK;
}

function getOkCode(): ScreepsReturnCode {
  return (typeof OK === 'number' ? OK : 0) as ScreepsReturnCode;
}
