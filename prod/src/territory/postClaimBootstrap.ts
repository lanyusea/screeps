import type { ColonySnapshot } from '../colony/colonyRegistry';
import type { RoleCounts } from '../creeps/roleCounts';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export const POST_CLAIM_BOOTSTRAP_WORKER_TARGET = 2;

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ROOM_EDGE_MIN = 2;
const ROOM_EDGE_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;

type StructureConstantGlobal = 'STRUCTURE_SPAWN';
type FindConstantGlobal = 'FIND_MY_CONSTRUCTION_SITES' | 'FIND_SOURCES';
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
  terrain: RoomTerrain | null;
}

export interface PostClaimBootstrapRefreshResult {
  active: boolean;
  spawnConstructionPending: boolean;
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
}

export function recordPostClaimBootstrapClaimSuccess(
  input: {
    colony: string;
    roomName: string;
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
  const claimedAt = existing?.status === 'ready' ? gameTime : existing?.claimedAt ?? gameTime;
  bootstraps[input.roomName] = {
    colony: input.colony,
    roomName: input.roomName,
    status: 'detected',
    claimedAt,
    updatedAt: gameTime,
    workerTarget: existing?.workerTarget ?? POST_CLAIM_BOOTSTRAP_WORKER_TARGET,
    ...(input.controllerId ? { controllerId: input.controllerId } : {})
  };

  telemetryEvents.push({
    type: 'postClaimBootstrap',
    roomName: input.roomName,
    colony: input.colony,
    phase: 'detected',
    ...(input.controllerId ? { controllerId: input.controllerId } : {}),
    workerTarget: POST_CLAIM_BOOTSTRAP_WORKER_TARGET
  });
}

export function refreshPostClaimBootstrap(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): PostClaimBootstrapRefreshResult {
  const roomName = colony.room.name;
  const record = getPostClaimBootstrapRecord(roomName);
  if (!record || record.status === 'ready' || colony.room.controller?.my !== true) {
    return { active: false, spawnConstructionPending: false };
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
  }

  return { active: true, spawnConstructionPending: true };
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
  if (!record || record.status === 'ready') {
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
    ...(record.lastResult !== undefined ? { lastResult: record.lastResult } : {})
  };
}

function planInitialSpawnConstructionSite(room: Room): SpawnSitePlanResult {
  if (typeof room.createConstructionSite !== 'function') {
    return { result: ERR_INVALID_TARGET_CODE };
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
  for (const object of [
    room.controller,
    ...findSources(room),
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
    !isTerrainWall(lookups.terrain, position)
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
