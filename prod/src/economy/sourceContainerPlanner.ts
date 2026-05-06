import {
  findSourceContainer,
  findSourceContainerConstructionSite,
  getPositionKey,
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from './sourceContainers';

const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const REMOTE_HARVESTER_ROLE = 'remoteHarvester';

interface PositionedRoomPosition {
  x: number;
  y: number;
  roomName?: string;
}

interface SourceContainerPlannerLookups {
  blockingPositions: Set<string>;
  pendingContainerPositions: PositionedRoomPosition[];
  terrain: RoomTerrain;
}

interface RoomSourceContainerScan {
  room: Room;
  controllerLevel: number;
  sources: Source[];
  coverage: SourceContainerCoverageSummary;
}

export interface SourceContainerCoverageSummary {
  sourceCount: number;
  sourcesWithContainers: number;
  sourcesWithContainerSites: number;
  sourcesMissingContainers: number;
}

export interface SourceContainerSitePlacement {
  roomName: string;
  sourceId: string;
  x: number;
  y: number;
  result: ScreepsReturnCode;
}

export interface SourceContainerPlannerRoomResult extends SourceContainerCoverageSummary {
  roomName: string;
  controllerLevel: number;
  placements: SourceContainerSitePlacement[];
}

export interface SourceContainerPlannerResult {
  rooms: SourceContainerPlannerRoomResult[];
  placedSiteCount: number;
  attemptedSiteCount: number;
  sourceCount: number;
  sourcesWithContainers: number;
  sourcesWithContainerSites: number;
  sourcesMissingContainers: number;
}

export function ensureSourceContainersForOwnedRooms(rooms = getVisibleOwnedRooms()): SourceContainerPlannerResult {
  const roomScans = rooms
    .filter(isOwnedRoom)
    .map(scanSourceContainerRoom)
    .sort(compareRoomSourceContainerScans);

  const roomResults = roomScans.map(planSourceContainersForRoom);

  return {
    rooms: roomResults,
    placedSiteCount: roomResults.reduce((total, room) => total + countOkPlacements(room.placements), 0),
    attemptedSiteCount: roomResults.reduce((total, room) => total + room.placements.length, 0),
    sourceCount: roomResults.reduce((total, room) => total + room.sourceCount, 0),
    sourcesWithContainers: roomResults.reduce((total, room) => total + room.sourcesWithContainers, 0),
    sourcesWithContainerSites: roomResults.reduce((total, room) => total + room.sourcesWithContainerSites, 0),
    sourcesMissingContainers: roomResults.reduce((total, room) => total + room.sourcesMissingContainers, 0)
  };
}

export function ensureRemoteSourceContainersForAssignedHarvesters(
  creeps = getGameCreeps()
): SourceContainerPlannerResult {
  const roomResults = getRemoteSourceContainerScans(creeps).map(planSourceContainersForRoom);

  return buildSourceContainerPlannerResult(roomResults);
}

export function summarizeSourceContainerCoverage(
  room: Room,
  sources = getRoomSources(room)
): SourceContainerCoverageSummary {
  const summary: SourceContainerCoverageSummary = {
    sourceCount: 0,
    sourcesWithContainers: 0,
    sourcesWithContainerSites: 0,
    sourcesMissingContainers: 0
  };

  for (const source of sources) {
    summary.sourceCount += 1;
    if (findSourceContainer(room, source)) {
      summary.sourcesWithContainers += 1;
    } else if (findSourceContainerConstructionSite(room, source)) {
      summary.sourcesWithContainerSites += 1;
    } else {
      summary.sourcesMissingContainers += 1;
    }
  }

  return summary;
}

function buildSourceContainerPlannerResult(
  roomResults: SourceContainerPlannerRoomResult[]
): SourceContainerPlannerResult {
  return {
    rooms: roomResults,
    placedSiteCount: roomResults.reduce((total, room) => total + countOkPlacements(room.placements), 0),
    attemptedSiteCount: roomResults.reduce((total, room) => total + room.placements.length, 0),
    sourceCount: roomResults.reduce((total, room) => total + room.sourceCount, 0),
    sourcesWithContainers: roomResults.reduce((total, room) => total + room.sourcesWithContainers, 0),
    sourcesWithContainerSites: roomResults.reduce((total, room) => total + room.sourcesWithContainerSites, 0),
    sourcesMissingContainers: roomResults.reduce((total, room) => total + room.sourcesMissingContainers, 0)
  };
}

function planSourceContainersForRoom(scan: RoomSourceContainerScan): SourceContainerPlannerRoomResult {
  if (scan.sources.length === 0) {
    return {
      roomName: scan.room.name,
      controllerLevel: scan.controllerLevel,
      ...scan.coverage,
      placements: []
    };
  }

  const lookups = createSourceContainerPlannerLookups(scan.room);
  if (!lookups) {
    return {
      roomName: scan.room.name,
      controllerLevel: scan.controllerLevel,
      ...scan.coverage,
      placements: []
    };
  }

  const anchor = selectSourceContainerAnchor(scan.room);
  const placements: SourceContainerSitePlacement[] = [];
  for (const source of scan.sources) {
    if (hasSourceContainerCoverage(scan.room, source, lookups)) {
      continue;
    }

    const placement = placeSourceContainerSite(scan.room, source, lookups, anchor);
    if (placement) {
      placements.push(placement);
    }
  }

  return {
    roomName: scan.room.name,
    controllerLevel: scan.controllerLevel,
    ...scan.coverage,
    placements
  };
}

function scanSourceContainerRoom(room: Room): RoomSourceContainerScan {
  const sources = getSortedRoomSources(room);
  return {
    room,
    controllerLevel: getOwnedRoomControllerLevel(room),
    sources,
    coverage: summarizeSourceContainerCoverage(room, sources)
  };
}

function getRemoteSourceContainerScans(creeps: Creep[]): RoomSourceContainerScan[] {
  const sourcesByRoom = new Map<string, Map<string, Source>>();

  for (const creep of creeps) {
    const assignment = normalizeRemoteHarvesterMemory(creep);
    if (!assignment) {
      continue;
    }

    const room = getVisibleRoom(assignment.targetRoom);
    if (!room || !isBuildableRemoteRoom(room)) {
      continue;
    }

    const source = getVisibleSourceById(room, assignment.sourceId);
    if (!source || !isAssignedRemoteHarvesterLosingEnergyToDecay(creep, room, source)) {
      continue;
    }

    const sources = sourcesByRoom.get(room.name) ?? new Map<string, Source>();
    sources.set(String(source.id), source);
    sourcesByRoom.set(room.name, sources);
  }

  return [...sourcesByRoom.entries()]
    .map(([roomName, sourcesById]): RoomSourceContainerScan | null => {
      const room = getVisibleRoom(roomName);
      if (!room) {
        return null;
      }

      const sources = [...sourcesById.values()]
        .filter((source) => {
          const position = getRoomObjectPosition(source);
          return position !== null && isSameRoomPosition(position, room.name);
        })
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));

      return {
        room,
        controllerLevel: getOwnedRoomControllerLevel(room),
        sources,
        coverage: summarizeSourceContainerCoverage(room, sources)
      };
    })
    .filter((scan): scan is RoomSourceContainerScan => scan !== null && scan.sources.length > 0)
    .sort(compareRoomSourceContainerScans);
}

function createSourceContainerPlannerLookups(room: Room): SourceContainerPlannerLookups | null {
  const terrain = getRoomTerrain(room);
  const structures = findRoomObjects<AnyStructure>(room, 'FIND_STRUCTURES');
  const constructionSites = findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES');
  if (
    !terrain ||
    structures === null ||
    constructionSites === null ||
    typeof room.createConstructionSite !== 'function'
  ) {
    return null;
  }

  const lookups: SourceContainerPlannerLookups = {
    blockingPositions: new Set<string>(),
    pendingContainerPositions: [],
    terrain
  };

  for (const source of getRoomSources(room)) {
    addBlockingPosition(lookups, getRoomObjectPosition(source));
  }

  for (const structure of structures) {
    addBlockingPosition(lookups, getRoomObjectPosition(structure));
  }

  for (const site of constructionSites) {
    const position = getRoomObjectPosition(site);
    addBlockingPosition(lookups, position);
    if (isContainerConstructionSite(site)) {
      addPendingContainerPosition(lookups, position);
    }
  }

  return lookups;
}

function placeSourceContainerSite(
  room: Room,
  source: Source,
  lookups: SourceContainerPlannerLookups,
  anchor: PositionedRoomPosition | null
): SourceContainerSitePlacement | null {
  for (const position of getSourceContainerCandidatePositions(room, source, lookups, anchor)) {
    const result = room.createConstructionSite(position.x, position.y, getContainerStructureType());
    const placement: SourceContainerSitePlacement = {
      roomName: room.name,
      sourceId: String(source.id),
      x: position.x,
      y: position.y,
      result
    };

    if (result === getOkCode()) {
      lookups.blockingPositions.add(getPositionKey(position));
      lookups.pendingContainerPositions.push(position);
      return placement;
    }

    lookups.blockingPositions.add(getPositionKey(position));
    if (result !== getErrInvalidTargetCode()) {
      return placement;
    }
  }

  return null;
}

function getSourceContainerCandidatePositions(
  room: Room,
  source: Source,
  lookups: SourceContainerPlannerLookups,
  anchor: PositionedRoomPosition | null
): PositionedRoomPosition[] {
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition || !isSameRoomPosition(sourcePosition, room.name)) {
    return [];
  }

  return getAdjacentBuildPositions(sourcePosition, room.name)
    .filter((position) => canPlaceSourceContainer(lookups, position))
    .sort((left, right) => compareSourceContainerPositions(left, right, anchor));
}

function hasSourceContainerCoverage(
  room: Room,
  source: Source,
  lookups: SourceContainerPlannerLookups
): boolean {
  return (
    findSourceContainer(room, source) !== null ||
    findSourceContainerConstructionSite(room, source) !== null ||
    lookups.pendingContainerPositions.some((position) => isNearRoomObject(source, position))
  );
}

function getAdjacentBuildPositions(sourcePosition: PositionedRoomPosition, roomName: string): PositionedRoomPosition[] {
  const positions: PositionedRoomPosition[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      positions.push({
        x: sourcePosition.x + dx,
        y: sourcePosition.y + dy,
        roomName
      });
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
  if (anchor) {
    const leftRange = getRangeBetweenPositions(left, anchor);
    const rightRange = getRangeBetweenPositions(right, anchor);
    if (leftRange !== rightRange) {
      return leftRange - rightRange;
    }
  }

  return left.y - right.y || left.x - right.x;
}

function compareRoomSourceContainerScans(left: RoomSourceContainerScan, right: RoomSourceContainerScan): number {
  return (
    right.controllerLevel - left.controllerLevel ||
    right.coverage.sourceCount - left.coverage.sourceCount ||
    left.room.name.localeCompare(right.room.name)
  );
}

function getSortedRoomSources(room: Room): Source[] {
  return getRoomSources(room)
    .filter((source) => {
      const position = getRoomObjectPosition(source);
      return position !== null && isSameRoomPosition(position, room.name);
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function getRoomSources(room: Room): Source[] {
  return findRoomObjects<Source>(room, 'FIND_SOURCES') ?? [];
}

function getVisibleSourceById(room: Room, sourceId: Id<Source>): Source | null {
  const gameSource = getGameSourceById(sourceId);
  const gameSourcePosition = gameSource ? getRoomObjectPosition(gameSource) : null;
  if (gameSource && gameSourcePosition && isSameRoomPosition(gameSourcePosition, room.name)) {
    return gameSource;
  }

  return getRoomSources(room).find((source) => String(source.id) === String(sourceId)) ?? null;
}

function findRoomObjects<T>(room: Room, constantName: string): T[] | null {
  const findConstant = getGlobalNumber(constantName);
  const find = (room as unknown as { find?: (type: number) => unknown }).find;
  if (findConstant === null || typeof find !== 'function') {
    return null;
  }

  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return null;
  }
}

function selectSourceContainerAnchor(room: Room): PositionedRoomPosition | null {
  const [primarySpawn] = getVisibleSpawns()
    .filter((spawn) => spawn.room.name === room.name && getRoomObjectPosition(spawn) !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  const primarySpawnPosition = primarySpawn ? getRoomObjectPosition(primarySpawn) : null;
  return primarySpawnPosition ?? (room.controller ? getRoomObjectPosition(room.controller) : null);
}

function isNearRoomObject(object: RoomObject, position: PositionedRoomPosition): boolean {
  const objectPosition = getRoomObjectPosition(object);
  if (!objectPosition) {
    return false;
  }

  if (
    typeof objectPosition.roomName === 'string' &&
    typeof position.roomName === 'string' &&
    objectPosition.roomName !== position.roomName
  ) {
    return false;
  }

  return getRangeBetweenPositions(objectPosition, position) <= 1;
}

function addBlockingPosition(
  lookups: SourceContainerPlannerLookups,
  position: PositionedRoomPosition | null
): void {
  if (position) {
    lookups.blockingPositions.add(getPositionKey(position));
  }
}

function addPendingContainerPosition(
  lookups: SourceContainerPlannerLookups,
  position: PositionedRoomPosition | null
): void {
  if (position) {
    lookups.pendingContainerPositions.push(position);
  }
}

function isOwnedRoom(room: Room): boolean {
  return room.controller?.my === true;
}

function getOwnedRoomControllerLevel(room: Room): number {
  const level = room.controller?.my === true ? room.controller.level : 0;
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
}

function getVisibleOwnedRooms(): Room[] {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  return rooms ? Object.values(rooms).filter((room): room is Room => room !== undefined && isOwnedRoom(room)) : [];
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
}

function getVisibleSpawns(): StructureSpawn[] {
  const spawns = (globalThis as { Game?: Partial<Game> }).Game?.spawns;
  return spawns ? Object.values(spawns).filter((spawn): spawn is StructureSpawn => spawn !== undefined) : [];
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as { Game?: Partial<Game> }).Game?.creeps;
  return creeps ? Object.values(creeps).filter((creep): creep is Creep => creep !== undefined) : [];
}

function getGameSourceById(id: Id<Source>): Source | null {
  const getObjectById = (globalThis as { Game?: Partial<Game> }).Game?.getObjectById;
  if (typeof getObjectById !== 'function') {
    return null;
  }

  try {
    return getObjectById(id) as Source | null;
  } catch {
    return null;
  }
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  return typeof game?.map?.getRoomTerrain === 'function' ? game.map.getRoomTerrain(room.name) : null;
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

function isContainerConstructionSite(site: ConstructionSite): boolean {
  return site.structureType === getContainerStructureType();
}

function getContainerStructureType(): BuildableStructureConstant {
  return ((globalThis as { STRUCTURE_CONTAINER?: StructureConstant }).STRUCTURE_CONTAINER ??
    'container') as BuildableStructureConstant;
}

function getOkCode(): ScreepsReturnCode {
  return ((globalThis as { OK?: ScreepsReturnCode }).OK ?? 0) as ScreepsReturnCode;
}

function getErrInvalidTargetCode(): ScreepsReturnCode {
  return ((globalThis as { ERR_INVALID_TARGET?: ScreepsReturnCode }).ERR_INVALID_TARGET ??
    ERR_INVALID_TARGET_CODE) as ScreepsReturnCode;
}

function getTerrainWallMask(): number {
  const terrainWallMask = (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof terrainWallMask === 'number' ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK;
}

function getGlobalNumber(name: string): number | null {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : null;
}

function countOkPlacements(placements: SourceContainerSitePlacement[]): number {
  return placements.filter((placement) => placement.result === getOkCode()).length;
}

function normalizeRemoteHarvesterMemory(creep: Creep): CreepRemoteHarvesterMemory | null {
  if (creep.memory?.role !== REMOTE_HARVESTER_ROLE) {
    return null;
  }

  const assignment = creep.memory.remoteHarvester;
  if (
    !isRecord(assignment) ||
    typeof assignment.homeRoom !== 'string' ||
    assignment.homeRoom.length === 0 ||
    typeof assignment.targetRoom !== 'string' ||
    assignment.targetRoom.length === 0 ||
    assignment.homeRoom === assignment.targetRoom ||
    typeof assignment.sourceId !== 'string' ||
    assignment.sourceId.length === 0
  ) {
    return null;
  }

  return assignment as CreepRemoteHarvesterMemory;
}

function isBuildableRemoteRoom(room: Room): boolean {
  return room.controller?.owner === undefined || room.controller.my === true;
}

function isAssignedRemoteHarvesterLosingEnergyToDecay(
  creep: Creep,
  room: Room,
  source: Source
): boolean {
  if (hasDroppedEnergyDecayingAtSource(room, source)) {
    return true;
  }

  if (creep.room?.name !== room.name) {
    return false;
  }

  return getUsedEnergy(creep) > 0 || getFreeEnergyCapacity(creep) === 0;
}

function hasDroppedEnergyDecayingAtSource(room: Room, source: Source): boolean {
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition) {
    return false;
  }

  const droppedResources = findRoomObjects<Resource<ResourceConstant>>(room, 'FIND_DROPPED_RESOURCES') ?? [];
  return droppedResources.some((resource) => {
    const resourcePosition = getRoomObjectPosition(resource);
    return (
      resourcePosition !== null &&
      isDroppedEnergy(resource) &&
      isSameRoomPosition(resourcePosition, room.name) &&
      getRangeBetweenPositions(sourcePosition, resourcePosition) <= 1
    );
  });
}

function isDroppedEnergy(resource: Resource<ResourceConstant>): boolean {
  const amount = resource.amount;
  const ticksToDecay = (resource as Resource<ResourceConstant> & { ticksToDecay?: number }).ticksToDecay;
  return (
    resource.resourceType === getEnergyResource() &&
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount > 0 &&
    (typeof ticksToDecay !== 'number' || ticksToDecay > 0)
  );
}

function getUsedEnergy(creep: Creep): number {
  const store = creep.store as Partial<StoreDefinition>;
  const used = store.getUsedCapacity?.(getEnergyResource());
  return typeof used === 'number' && Number.isFinite(used) ? Math.max(0, used) : 0;
}

function getFreeEnergyCapacity(creep: Creep): number | null {
  const store = creep.store as Partial<StoreDefinition>;
  const free = store.getFreeCapacity?.(getEnergyResource());
  return typeof free === 'number' && Number.isFinite(free) ? Math.max(0, free) : null;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
