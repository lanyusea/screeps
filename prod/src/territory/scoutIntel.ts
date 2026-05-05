import type {
  RuntimeTelemetryEvent,
  RuntimeTerritoryScoutTelemetryReason,
  RuntimeTerritoryScoutTelemetryResult
} from '../telemetry/runtimeSummary';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

const TERRITORY_SCOUT_MEMORY_KEY_SEPARATOR = '>';
export const TERRITORY_SCOUT_VALIDATION_TIMEOUT_TICKS = 1_500;
const TERRAIN_SCAN_MIN = 2;
const TERRAIN_SCAN_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const DEFAULT_TERRAIN_SWAMP_MASK = 2;

export interface TerritoryScoutValidationResult {
  status: TerritoryScoutValidationStatus;
  reason?: TerritoryScoutValidationReason;
  intel?: TerritoryScoutIntelMemory;
}

export interface TerritoryScoutSummary {
  attempts: TerritoryScoutAttemptMemory[];
  intel: TerritoryScoutIntelMemory[];
}

export function recordVisibleRoomScoutIntel(
  colony: string | undefined,
  room: Room | undefined,
  gameTime = getGameTime(),
  scoutName?: string,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): TerritoryScoutIntelMemory | null {
  if (!isNonEmptyString(colony) || !room || !isNonEmptyString(room.name)) {
    return null;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const key = getTerritoryScoutMemoryKey(colony, room.name);
  const intel = buildTerritoryScoutIntel(colony, room, gameTime, scoutName);
  const scoutIntel = getMutableScoutIntelRecords(territoryMemory);
  scoutIntel[key] = intel;

  const attempts = getMutableScoutAttemptRecords(territoryMemory);
  const existingAttempt = normalizeTerritoryScoutAttempt(attempts[key]);
  attempts[key] = {
    colony,
    roomName: room.name,
    status: 'observed',
    requestedAt: existingAttempt?.requestedAt ?? gameTime,
    updatedAt: gameTime,
    attemptCount: Math.max(1, existingAttempt?.attemptCount ?? 1),
    ...(intel.controller?.id ? { controllerId: intel.controller.id } : {}),
    ...(scoutName ? { scoutName } : {}),
    ...(existingAttempt?.lastValidation ? { lastValidation: existingAttempt.lastValidation } : {})
  };

  recordTerritoryScoutTelemetry(telemetryEvents, {
    colony,
    targetRoom: room.name,
    phase: 'intel',
    result: 'recorded',
    ...(scoutName ? { scoutName } : {}),
    ...(intel.controller?.id ? { controllerId: intel.controller.id } : {}),
    sourceCount: intel.sourceCount,
    hostileCreepCount: intel.hostileCreepCount,
    hostileStructureCount: intel.hostileStructureCount,
    hostileSpawnCount: intel.hostileSpawnCount
  });

  return intel;
}

export function ensureTerritoryScoutAttempt(
  colony: string,
  targetRoom: string,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[] = [],
  controllerId?: Id<StructureController>
): TerritoryScoutAttemptMemory | null {
  if (!isNonEmptyString(colony) || !isNonEmptyString(targetRoom)) {
    return null;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const key = getTerritoryScoutMemoryKey(colony, targetRoom);
  const attempts = getMutableScoutAttemptRecords(territoryMemory);
  const existingAttempt = normalizeTerritoryScoutAttempt(attempts[key]);
  const shouldReuseAttempt =
    existingAttempt?.status === 'requested' &&
    gameTime >= existingAttempt.requestedAt &&
    gameTime - existingAttempt.requestedAt <= TERRITORY_SCOUT_VALIDATION_TIMEOUT_TICKS;
  const attempt: TerritoryScoutAttemptMemory = shouldReuseAttempt
    ? {
        ...existingAttempt,
        updatedAt: gameTime,
        ...(controllerId ?? existingAttempt.controllerId
          ? { controllerId: controllerId ?? existingAttempt.controllerId }
          : {})
      }
    : {
        colony,
        roomName: targetRoom,
        status: 'requested',
        requestedAt: gameTime,
        updatedAt: gameTime,
        attemptCount: Math.max(1, (existingAttempt?.attemptCount ?? 0) + 1),
        ...(controllerId ? { controllerId } : {}),
        ...(existingAttempt?.lastValidation ? { lastValidation: existingAttempt.lastValidation } : {})
      };
  attempts[key] = attempt;
  upsertTerritoryScoutIntent(territoryMemory, attempt);

  recordTerritoryScoutTelemetry(telemetryEvents, {
    colony,
    targetRoom,
    phase: 'attempt',
    result: 'requested',
    ...(attempt.controllerId ? { controllerId: attempt.controllerId } : {})
  });

  return attempt;
}

export function validateTerritoryScoutIntelForClaim({
  colony,
  targetRoom,
  colonyOwnerUsername,
  gameTime
}: {
  colony: string;
  targetRoom: string;
  colonyOwnerUsername?: string;
  gameTime: number;
}): TerritoryScoutValidationResult {
  const attempt = getTerritoryScoutAttempt(colony, targetRoom);
  const intel = getTerritoryScoutIntel(colony, targetRoom);
  if (!intel) {
    return getUnavailableScoutIntelValidationResult(attempt, gameTime, 'intelMissing');
  }

  if (!isScoutIntelUsableForClaim(intel, attempt, gameTime)) {
    return getUnavailableScoutIntelValidationResult(attempt, gameTime, 'scoutPending');
  }

  const controller = intel.controller;
  if (!controller) {
    return { status: 'blocked', reason: 'controllerMissing', intel };
  }

  if (
    controller.my === true ||
    (isNonEmptyString(controller.ownerUsername) && controller.ownerUsername === colonyOwnerUsername)
  ) {
    return { status: 'blocked', reason: 'controllerOwned', intel };
  }

  if (isNonEmptyString(controller.ownerUsername)) {
    return { status: 'blocked', reason: 'controllerOwned', intel };
  }

  if (
    isNonEmptyString(controller.reservationUsername) &&
    controller.reservationUsername !== colonyOwnerUsername
  ) {
    return { status: 'blocked', reason: 'controllerReserved', intel };
  }

  if (intel.hostileSpawnCount > 0) {
    return { status: 'blocked', reason: 'hostileSpawn', intel };
  }

  if (intel.sourceCount <= 0) {
    return { status: 'blocked', reason: 'sourcesMissing', intel };
  }

  return { status: 'passed', intel };
}

export function recordTerritoryScoutValidation(
  colony: string,
  targetRoom: string,
  result: TerritoryScoutValidationResult,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[] = [],
  controllerId?: Id<StructureController>,
  score?: number
): void {
  if (!isNonEmptyString(colony) || !isNonEmptyString(targetRoom)) {
    return;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const key = getTerritoryScoutMemoryKey(colony, targetRoom);
  const attempts = getMutableScoutAttemptRecords(territoryMemory);
  const existingAttempt = normalizeTerritoryScoutAttempt(attempts[key]);
  const status =
    result.status === 'fallback'
      ? 'timedOut'
      : result.status === 'pending'
        ? existingAttempt?.status ?? 'requested'
        : existingAttempt?.status ?? 'observed';
  attempts[key] = {
    colony,
    roomName: targetRoom,
    status,
    requestedAt: existingAttempt?.requestedAt ?? gameTime,
    updatedAt: gameTime,
    attemptCount: Math.max(1, existingAttempt?.attemptCount ?? 1),
    ...(controllerId ?? existingAttempt?.controllerId ?? result.intel?.controller?.id
      ? { controllerId: controllerId ?? existingAttempt?.controllerId ?? result.intel?.controller?.id }
      : {}),
    ...(existingAttempt?.scoutName ? { scoutName: existingAttempt.scoutName } : {}),
    lastValidation: {
      status: result.status,
      updatedAt: gameTime,
      ...(result.reason ? { reason: result.reason } : {})
    }
  };

  recordTerritoryScoutTelemetry(telemetryEvents, {
    colony,
    targetRoom,
    phase: 'validation',
    result: getTelemetryValidationResult(result.status),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(controllerId ?? result.intel?.controller?.id ? { controllerId: controllerId ?? result.intel?.controller?.id } : {}),
    ...(result.intel ? { sourceCount: result.intel.sourceCount } : {}),
    ...(result.intel ? { hostileCreepCount: result.intel.hostileCreepCount } : {}),
    ...(result.intel ? { hostileStructureCount: result.intel.hostileStructureCount } : {}),
    ...(result.intel ? { hostileSpawnCount: result.intel.hostileSpawnCount } : {}),
    ...(score !== undefined ? { score } : {})
  });
}

export function getTerritoryScoutSummary(colony: string): TerritoryScoutSummary | null {
  if (!isNonEmptyString(colony)) {
    return null;
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const attempts = Object.values(territoryMemory.scoutAttempts ?? {})
    .flatMap((attempt) => {
      const normalized = normalizeTerritoryScoutAttempt(attempt);
      return normalized?.colony === colony ? [normalized] : [];
    })
    .sort(compareTerritoryScoutAttempts);
  const intel = Object.values(territoryMemory.scoutIntel ?? {})
    .flatMap((record) => {
      const normalized = normalizeTerritoryScoutIntel(record);
      return normalized?.colony === colony ? [normalized] : [];
    })
    .sort(compareTerritoryScoutIntel);

  return attempts.length > 0 || intel.length > 0 ? { attempts, intel } : null;
}

function buildTerritoryScoutIntel(
  colony: string,
  room: Room,
  gameTime: number,
  scoutName: string | undefined
): TerritoryScoutIntelMemory {
  const controller = room.controller;
  const sources = findRoomObjects<Source>(room, 'FIND_SOURCES');
  const hostileCreeps = findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS');
  const hostileStructures = findRoomObjects<AnyStructure>(room, 'FIND_HOSTILE_STRUCTURES');
  const mineral = findRoomObjects<Mineral>(room, 'FIND_MINERALS')[0];
  const roomTerrain = getRoomTerrain(room);
  const sourcePositions = summarizeScoutSources(sources, roomTerrain);
  const sourceAccessPoints = calculateAverageSourceAccessPoints(sourcePositions);
  const controllerSourceRange = calculateAverageControllerSourceRange(controller, sourcePositions);
  const terrain = summarizeRoomTerrainFromTerrain(roomTerrain);

  return {
    colony,
    roomName: room.name,
    updatedAt: gameTime,
    ...(controller ? { controller: summarizeScoutController(controller) } : {}),
    sourceIds: sources.map((source) => String(source.id)).sort(),
    sourceCount: sources.length,
    ...(sourcePositions.length > 0 ? { sourcePositions } : {}),
    ...(sourceAccessPoints !== undefined ? { sourceAccessPoints } : {}),
    ...(controllerSourceRange !== undefined ? { controllerSourceRange } : {}),
    ...(terrain ? { terrain } : {}),
    ...(mineral ? { mineral: summarizeScoutMineral(mineral) } : {}),
    hostileCreepCount: hostileCreeps.length,
    hostileStructureCount: hostileStructures.length,
    hostileSpawnCount: hostileStructures.filter(isHostileSpawnStructure).length,
    ...(scoutName ? { scoutName } : {})
  };
}

function summarizeScoutController(controller: StructureController): TerritoryScoutControllerIntelMemory {
  const ownerUsername = getControllerOwnerUsername(controller);
  const reservationUsername = getControllerReservationUsername(controller);
  const reservationTicksToEnd = getControllerReservationTicksToEnd(controller);
  return {
    ...(typeof controller.id === 'string' ? { id: controller.id as Id<StructureController> } : {}),
    ...(typeof controller.my === 'boolean' ? { my: controller.my } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    ...(typeof reservationTicksToEnd === 'number' ? { reservationTicksToEnd } : {})
  };
}

function summarizeScoutMineral(mineral: Mineral): TerritoryScoutMineralIntelMemory {
  const rawMineral = mineral as Mineral & { mineralType?: unknown; density?: unknown };
  return {
    id: String(mineral.id),
    ...(typeof rawMineral.mineralType === 'string' ? { mineralType: rawMineral.mineralType } : {}),
    ...(typeof rawMineral.density === 'number' ? { density: rawMineral.density } : {})
  };
}

function summarizeScoutSources(
  sources: Source[],
  terrain: RoomTerrain | null
): TerritoryScoutSourceIntelMemory[] {
  return sources.flatMap((source) => {
    if (!source.pos || !isFiniteNumber(source.pos.x) || !isFiniteNumber(source.pos.y)) {
      return [];
    }

    const accessPoints = calculateSourceAccessPoints(source.pos, terrain);
    return [
      {
        id: String(source.id),
        x: Math.floor(source.pos.x),
        y: Math.floor(source.pos.y),
        ...(accessPoints !== undefined ? { accessPoints } : {})
      }
    ];
  });
}

function calculateSourceAccessPoints(pos: RoomPosition, terrain: RoomTerrain | null): number | undefined {
  if (!terrain || typeof terrain.get !== 'function') {
    return undefined;
  }

  const wallMask = getTerrainMask('TERRAIN_MASK_WALL', DEFAULT_TERRAIN_WALL_MASK);
  let walkableCount = 0;
  for (let x = Math.max(0, pos.x - 1); x <= Math.min(49, pos.x + 1); x += 1) {
    for (let y = Math.max(0, pos.y - 1); y <= Math.min(49, pos.y + 1); y += 1) {
      if (x === pos.x && y === pos.y) {
        continue;
      }

      if ((terrain.get(x, y) & wallMask) === 0) {
        walkableCount += 1;
      }
    }
  }

  return walkableCount;
}

function calculateAverageSourceAccessPoints(
  sources: TerritoryScoutSourceIntelMemory[]
): number | undefined {
  const accessPoints = sources.flatMap((source) =>
    isFiniteNumber(source.accessPoints) ? [source.accessPoints] : []
  );
  if (accessPoints.length === 0) {
    return undefined;
  }

  const average = accessPoints.reduce((total, value) => total + value, 0) / accessPoints.length;
  return Math.round(average * 10) / 10;
}

function calculateAverageControllerSourceRange(
  controller: StructureController | undefined,
  sources: TerritoryScoutSourceIntelMemory[]
): number | undefined {
  if (!controller?.pos || sources.length === 0) {
    return undefined;
  }

  const ranges = sources.map((source) =>
    Math.max(Math.abs(controller.pos.x - source.x), Math.abs(controller.pos.y - source.y))
  );
  return Math.round(ranges.reduce((total, range) => total + range, 0) / ranges.length);
}

function summarizeRoomTerrainFromTerrain(terrain: RoomTerrain | null): TerritoryTerrainQualityMemory | null {
  if (!terrain || typeof terrain.get !== 'function') {
    return null;
  }

  let plainCount = 0;
  let swampCount = 0;
  let wallCount = 0;
  const wallMask = getTerrainMask('TERRAIN_MASK_WALL', DEFAULT_TERRAIN_WALL_MASK);
  const swampMask = getTerrainMask('TERRAIN_MASK_SWAMP', DEFAULT_TERRAIN_SWAMP_MASK);
  for (let x = TERRAIN_SCAN_MIN; x <= TERRAIN_SCAN_MAX; x += 1) {
    for (let y = TERRAIN_SCAN_MIN; y <= TERRAIN_SCAN_MAX; y += 1) {
      const mask = terrain.get(x, y);
      if ((mask & wallMask) !== 0) {
        wallCount += 1;
      } else if ((mask & swampMask) !== 0) {
        swampCount += 1;
      } else {
        plainCount += 1;
      }
    }
  }

  const total = plainCount + swampCount + wallCount;
  if (total <= 0) {
    return null;
  }

  return {
    walkableRatio: roundRatio(plainCount + swampCount, total),
    swampRatio: roundRatio(swampCount, total),
    wallRatio: roundRatio(wallCount, total)
  };
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const roomWithTerrain = room as Room & { getTerrain?: () => RoomTerrain };
  if (typeof roomWithTerrain.getTerrain === 'function') {
    return roomWithTerrain.getTerrain();
  }

  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & { getRoomTerrain?: (roomName: string) => RoomTerrain })
    | undefined;
  return typeof gameMap?.getRoomTerrain === 'function' ? gameMap.getRoomTerrain(room.name) : null;
}

function upsertTerritoryScoutIntent(
  territoryMemory: TerritoryMemory,
  attempt: TerritoryScoutAttemptMemory
): void {
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === attempt.colony &&
      intent.targetRoom === attempt.roomName &&
      intent.action === 'scout'
  );
  const nextIntent: TerritoryIntentMemory = {
    colony: attempt.colony,
    targetRoom: attempt.roomName,
    action: 'scout',
    status: existingIndex >= 0 && intents[existingIndex].status === 'active' ? 'active' : 'planned',
    updatedAt: attempt.updatedAt,
    ...(attempt.controllerId ? { controllerId: attempt.controllerId } : {})
  };

  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
}

function recordTerritoryScoutTelemetry(
  telemetryEvents: RuntimeTelemetryEvent[],
  event: {
    colony: string;
    targetRoom: string;
    phase: 'attempt' | 'intel' | 'validation';
    result: RuntimeTerritoryScoutTelemetryResult;
    reason?: RuntimeTerritoryScoutTelemetryReason;
    controllerId?: Id<StructureController>;
    scoutName?: string;
    sourceCount?: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
    hostileSpawnCount?: number;
    score?: number;
  }
): void {
  telemetryEvents.push({
    type: 'territoryScout',
    roomName: event.colony,
    colony: event.colony,
    targetRoom: event.targetRoom,
    phase: event.phase,
    result: event.result,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.controllerId ? { controllerId: event.controllerId } : {}),
    ...(event.scoutName ? { scoutName: event.scoutName } : {}),
    ...(event.sourceCount !== undefined ? { sourceCount: event.sourceCount } : {}),
    ...(event.hostileCreepCount !== undefined ? { hostileCreepCount: event.hostileCreepCount } : {}),
    ...(event.hostileStructureCount !== undefined ? { hostileStructureCount: event.hostileStructureCount } : {}),
    ...(event.hostileSpawnCount !== undefined ? { hostileSpawnCount: event.hostileSpawnCount } : {}),
    ...(event.score !== undefined ? { score: event.score } : {})
  });
}

function getTelemetryValidationResult(
  status: TerritoryScoutValidationStatus
): RuntimeTerritoryScoutTelemetryResult {
  if (status === 'passed') {
    return 'passed';
  }

  if (status === 'blocked') {
    return 'blocked';
  }

  return status === 'fallback' ? 'fallback' : 'pending';
}

export function getTerritoryScoutIntel(colony: string, targetRoom: string): TerritoryScoutIntelMemory | null {
  const rawIntel = getTerritoryMemoryRecord()?.scoutIntel?.[getTerritoryScoutMemoryKey(colony, targetRoom)];
  return normalizeTerritoryScoutIntel(rawIntel);
}

function getTerritoryScoutAttempt(colony: string, targetRoom: string): TerritoryScoutAttemptMemory | null {
  const rawAttempt = getTerritoryMemoryRecord()?.scoutAttempts?.[getTerritoryScoutMemoryKey(colony, targetRoom)];
  return normalizeTerritoryScoutAttempt(rawAttempt);
}

function getUnavailableScoutIntelValidationResult(
  attempt: TerritoryScoutAttemptMemory | null,
  gameTime: number,
  pendingReason: TerritoryScoutValidationReason
): TerritoryScoutValidationResult {
  if (isScoutAttemptTimedOut(attempt, gameTime)) {
    return { status: 'fallback', reason: 'scoutTimeout' };
  }

  return { status: 'pending', reason: attempt ? 'scoutPending' : pendingReason };
}

function isScoutIntelUsableForClaim(
  intel: TerritoryScoutIntelMemory,
  attempt: TerritoryScoutAttemptMemory | null,
  gameTime: number
): boolean {
  if (isScoutIntelExpired(intel, gameTime)) {
    return false;
  }

  return attempt?.status !== 'requested' || intel.updatedAt >= attempt.requestedAt;
}

function isScoutIntelExpired(intel: TerritoryScoutIntelMemory, gameTime: number): boolean {
  return gameTime >= intel.updatedAt && gameTime - intel.updatedAt > TERRITORY_SCOUT_VALIDATION_TIMEOUT_TICKS;
}

function isScoutAttemptTimedOut(attempt: TerritoryScoutAttemptMemory | null, gameTime: number): boolean {
  return (
    attempt?.status === 'requested' &&
    gameTime >= attempt.requestedAt &&
    gameTime - attempt.requestedAt > TERRITORY_SCOUT_VALIDATION_TIMEOUT_TICKS
  );
}

function getMutableScoutAttemptRecords(
  territoryMemory: TerritoryMemory
): Record<string, TerritoryScoutAttemptMemory> {
  if (!isRecord(territoryMemory.scoutAttempts) || Array.isArray(territoryMemory.scoutAttempts)) {
    territoryMemory.scoutAttempts = {};
  }

  return territoryMemory.scoutAttempts;
}

function getMutableScoutIntelRecords(
  territoryMemory: TerritoryMemory
): Record<string, TerritoryScoutIntelMemory> {
  if (!isRecord(territoryMemory.scoutIntel) || Array.isArray(territoryMemory.scoutIntel)) {
    territoryMemory.scoutIntel = {};
  }

  return territoryMemory.scoutIntel;
}

function normalizeTerritoryScoutAttempt(rawAttempt: unknown): TerritoryScoutAttemptMemory | null {
  if (!isRecord(rawAttempt)) {
    return null;
  }

  if (
    !isNonEmptyString(rawAttempt.colony) ||
    !isNonEmptyString(rawAttempt.roomName) ||
    !isTerritoryScoutAttemptStatus(rawAttempt.status) ||
    !isFiniteNumber(rawAttempt.requestedAt) ||
    !isFiniteNumber(rawAttempt.updatedAt)
  ) {
    return null;
  }

  const attemptCount = isFiniteNumber(rawAttempt.attemptCount)
    ? Math.max(1, Math.floor(rawAttempt.attemptCount))
    : 1;
  const lastValidation = normalizeTerritoryScoutValidation(rawAttempt.lastValidation);
  return {
    colony: rawAttempt.colony,
    roomName: rawAttempt.roomName,
    status: rawAttempt.status,
    requestedAt: rawAttempt.requestedAt,
    updatedAt: rawAttempt.updatedAt,
    attemptCount,
    ...(typeof rawAttempt.controllerId === 'string'
      ? { controllerId: rawAttempt.controllerId as Id<StructureController> }
      : {}),
    ...(isNonEmptyString(rawAttempt.scoutName) ? { scoutName: rawAttempt.scoutName } : {}),
    ...(lastValidation ? { lastValidation } : {})
  };
}

function normalizeTerritoryScoutIntel(rawIntel: unknown): TerritoryScoutIntelMemory | null {
  if (!isRecord(rawIntel)) {
    return null;
  }

  if (
    !isNonEmptyString(rawIntel.colony) ||
    !isNonEmptyString(rawIntel.roomName) ||
    !isFiniteNumber(rawIntel.updatedAt)
  ) {
    return null;
  }

  const sourceIds = Array.isArray(rawIntel.sourceIds)
    ? rawIntel.sourceIds.flatMap((sourceId) => (isNonEmptyString(sourceId) ? [sourceId] : []))
    : [];
  const sourceCount = isFiniteNumber(rawIntel.sourceCount)
    ? Math.max(0, Math.floor(rawIntel.sourceCount))
    : sourceIds.length;
  const controller = normalizeTerritoryScoutControllerIntel(rawIntel.controller);
  const mineral = normalizeTerritoryScoutMineralIntel(rawIntel.mineral);
  const sourcePositions = normalizeTerritoryScoutSourceIntel(rawIntel.sourcePositions);
  const terrain = normalizeTerritoryTerrainQuality(rawIntel.terrain);
  return {
    colony: rawIntel.colony,
    roomName: rawIntel.roomName,
    updatedAt: rawIntel.updatedAt,
    ...(controller ? { controller } : {}),
    sourceIds,
    sourceCount,
    ...(sourcePositions.length > 0 ? { sourcePositions } : {}),
    ...(isFiniteNumber(rawIntel.sourceAccessPoints)
      ? { sourceAccessPoints: Math.max(0, rawIntel.sourceAccessPoints) }
      : {}),
    ...(isFiniteNumber(rawIntel.controllerSourceRange)
      ? { controllerSourceRange: Math.max(0, Math.floor(rawIntel.controllerSourceRange)) }
      : {}),
    ...(terrain ? { terrain } : {}),
    ...(mineral ? { mineral } : {}),
    hostileCreepCount: getBoundedCount(rawIntel.hostileCreepCount),
    hostileStructureCount: getBoundedCount(rawIntel.hostileStructureCount),
    hostileSpawnCount: getBoundedCount(rawIntel.hostileSpawnCount),
    ...(isNonEmptyString(rawIntel.scoutName) ? { scoutName: rawIntel.scoutName } : {})
  };
}

function normalizeTerritoryScoutSourceIntel(rawSources: unknown): TerritoryScoutSourceIntelMemory[] {
  if (!Array.isArray(rawSources)) {
    return [];
  }

  return rawSources.flatMap((rawSource) => {
    if (!isRecord(rawSource) || !isNonEmptyString(rawSource.id)) {
      return [];
    }

    if (!isFiniteNumber(rawSource.x) || !isFiniteNumber(rawSource.y)) {
      return [];
    }

    return [
      {
        id: rawSource.id,
        x: Math.min(49, Math.max(0, Math.floor(rawSource.x))),
        y: Math.min(49, Math.max(0, Math.floor(rawSource.y))),
        ...(isFiniteNumber(rawSource.accessPoints)
          ? { accessPoints: Math.max(0, Math.floor(rawSource.accessPoints)) }
          : {})
      }
    ];
  });
}

function normalizeTerritoryScoutControllerIntel(rawController: unknown): TerritoryScoutControllerIntelMemory | null {
  if (!isRecord(rawController)) {
    return null;
  }

  return {
    ...(typeof rawController.id === 'string'
      ? { id: rawController.id as Id<StructureController> }
      : {}),
    ...(typeof rawController.my === 'boolean' ? { my: rawController.my } : {}),
    ...(isNonEmptyString(rawController.ownerUsername) ? { ownerUsername: rawController.ownerUsername } : {}),
    ...(isNonEmptyString(rawController.reservationUsername)
      ? { reservationUsername: rawController.reservationUsername }
      : {}),
    ...(isFiniteNumber(rawController.reservationTicksToEnd)
      ? { reservationTicksToEnd: rawController.reservationTicksToEnd }
      : {})
  };
}

function normalizeTerritoryScoutMineralIntel(rawMineral: unknown): TerritoryScoutMineralIntelMemory | null {
  if (!isRecord(rawMineral) || !isNonEmptyString(rawMineral.id)) {
    return null;
  }

  return {
    id: rawMineral.id,
    ...(isNonEmptyString(rawMineral.mineralType) ? { mineralType: rawMineral.mineralType } : {}),
    ...(isFiniteNumber(rawMineral.density) ? { density: rawMineral.density } : {})
  };
}

function normalizeTerritoryTerrainQuality(rawTerrain: unknown): TerritoryTerrainQualityMemory | null {
  if (!isRecord(rawTerrain)) {
    return null;
  }

  if (
    !isFiniteNumber(rawTerrain.walkableRatio) ||
    !isFiniteNumber(rawTerrain.swampRatio) ||
    !isFiniteNumber(rawTerrain.wallRatio)
  ) {
    return null;
  }

  return {
    walkableRatio: clampRatio(rawTerrain.walkableRatio),
    swampRatio: clampRatio(rawTerrain.swampRatio),
    wallRatio: clampRatio(rawTerrain.wallRatio)
  };
}

function normalizeTerritoryScoutValidation(rawValidation: unknown): TerritoryScoutValidationMemory | null {
  if (!isRecord(rawValidation)) {
    return null;
  }

  if (!isTerritoryScoutValidationStatus(rawValidation.status) || !isFiniteNumber(rawValidation.updatedAt)) {
    return null;
  }

  return {
    status: rawValidation.status,
    updatedAt: rawValidation.updatedAt,
    ...(isTerritoryScoutValidationReason(rawValidation.reason) ? { reason: rawValidation.reason } : {})
  };
}

function getBoundedCount(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 0;
}

function roundRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 1_000 : 0;
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function compareTerritoryScoutAttempts(
  left: TerritoryScoutAttemptMemory,
  right: TerritoryScoutAttemptMemory
): number {
  return right.updatedAt - left.updatedAt || left.roomName.localeCompare(right.roomName);
}

function compareTerritoryScoutIntel(
  left: TerritoryScoutIntelMemory,
  right: TerritoryScoutIntelMemory
): number {
  return right.updatedAt - left.updatedAt || left.roomName.localeCompare(right.roomName);
}

function findRoomObjects<T>(room: Room, constantName: string): T[] {
  const findConstant = getGlobalNumber(constantName);
  const find = (room as unknown as { find?: (type: number) => unknown }).find;
  if (typeof findConstant !== 'number' || typeof find !== 'function') {
    return [];
  }

  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function isHostileSpawnStructure(structure: AnyStructure): boolean {
  const structureType = (structure as AnyStructure & { structureType?: unknown }).structureType;
  return structureType === getStructureSpawnConstant();
}

function getStructureSpawnConstant(): StructureConstant {
  const structureSpawn = (globalThis as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN;
  return structureSpawn ?? ('spawn' as StructureConstant);
}

function getControllerOwnerUsername(controller: StructureController): string | undefined {
  const username = (controller as StructureController & { owner?: { username?: string } }).owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationUsername(controller: StructureController): string | undefined {
  const username = (controller as StructureController & { reservation?: { username?: string } }).reservation?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationTicksToEnd(controller: StructureController): number | undefined {
  const ticksToEnd = (controller as StructureController & { reservation?: { ticksToEnd?: number } }).reservation
    ?.ticksToEnd;
  return typeof ticksToEnd === 'number' ? ticksToEnd : undefined;
}

function getTerritoryScoutMemoryKey(colony: string, targetRoom: string): string {
  return `${colony}${TERRITORY_SCOUT_MEMORY_KEY_SEPARATOR}${targetRoom}`;
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getTerrainMask(name: 'TERRAIN_MASK_WALL' | 'TERRAIN_MASK_SWAMP', fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : fallback;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function getTerritoryMemoryRecord(): TerritoryMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }

  return memory.territory as TerritoryMemory;
}

function isTerritoryScoutAttemptStatus(status: unknown): status is TerritoryScoutAttemptStatus {
  return status === 'requested' || status === 'observed' || status === 'timedOut';
}

function isTerritoryScoutValidationStatus(status: unknown): status is TerritoryScoutValidationStatus {
  return status === 'pending' || status === 'passed' || status === 'blocked' || status === 'fallback';
}

function isTerritoryScoutValidationReason(reason: unknown): reason is TerritoryScoutValidationReason {
  return (
    reason === 'intelMissing' ||
    reason === 'scoutPending' ||
    reason === 'scoutTimeout' ||
    reason === 'controllerMissing' ||
    reason === 'controllerOwned' ||
    reason === 'controllerReserved' ||
    reason === 'hostileSpawn' ||
    reason === 'sourcesMissing'
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
