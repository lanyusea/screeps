import type { ColonySnapshot } from '../colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import { TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY } from './autoClaim';
import { runRecommendedExpansionClaimExecutor } from './claimExecutor';
import {
  buildRuntimeExpansionCandidateReport,
  clearNextExpansionTargetIntent,
  NEXT_EXPANSION_TARGET_CREATOR,
  refreshNextExpansionTargetSelection,
  selectExpansionScoutTargets,
  type NextExpansionTargetSelection
} from './expansionScoring';
import { refreshExpansionRoomScouting } from './roomScouting';
import { getTerritoryScoutIntel } from './scoutIntel';
import { logBestClaimTarget } from './territoryRunner';

const EXPANSION_EXECUTOR_REFRESH_INTERVAL = 50;
const EXPANSION_EXECUTOR_DOWNGRADE_GUARD_TICKS = 5_000;
const EXPANSION_EXECUTOR_THREAT_MEMORY_STALE_TICKS = 5;

type ExpansionExecutorThreatState = DefenseThreatLevel | 'unknown';

interface CachedExpansionExecutorSelection {
  refreshedAt: number;
  stateKey: string;
  selection: NextExpansionTargetSelection;
}

export function refreshExpansionExecutorIntent(
  colony: ColonySnapshot,
  gameTime = getGameTime(),
  telemetryEvents: RuntimeTelemetryEvent[] = []
): NextExpansionTargetSelection {
  const colonyName = colony.room.name;
  const colonyMemory = getWritableColonyMemory(colony);
  let stateKey = getExpansionExecutorCacheStateKey(colony, gameTime);
  const cachedSelection = getCachedExpansionExecutorSelection(colonyMemory, colonyName);
  if (
    cachedSelection &&
    isExpansionExecutorCacheReusable(cachedSelection, colony, gameTime, stateKey)
  ) {
    return cachedSelection.selection;
  }

  const report = buildRuntimeExpansionCandidateReport(colony);
  let selection = refreshNextExpansionTargetSelection(colony, report, gameTime);
  if (selection.status === 'planned' && !isExpansionExecutorClaimReady(colony, gameTime)) {
    clearNextExpansionTargetIntent(colonyName);
    selection = {
      status: 'skipped',
      colony: colonyName,
      reason: 'unmetPreconditions'
    };
  }
  const scoutTargetRooms: string[] = [];
  if (selection.targetRoom) {
    scoutTargetRooms.push(selection.targetRoom);
  }
  if (selection.status === 'skipped' && selection.reason === 'insufficientEvidence') {
    const scoutTargets = selectExpansionScoutTargets(report);
    scoutTargetRooms.push(...scoutTargets.map((target) => target.roomName));
    refreshExpansionRoomScouting(colony, scoutTargets, gameTime, telemetryEvents);
  }
  stateKey = refreshExpansionExecutorCacheStateKeyAfterCurrentTickScoutIntel(
    stateKey,
    colonyName,
    scoutTargetRooms,
    gameTime
  );

  logBestClaimTarget(colony.room);
  colonyMemory.lastExpansionScoreTime = gameTime;
  colonyMemory.cachedExpansionSelection = {
    ...selection,
    stateKey
  };
  return selection;
}

export function runExpansionExecutorClaimer(
  creep: Creep,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): boolean {
  return runRecommendedExpansionClaimExecutor(creep, telemetryEvents);
}

function getWritableColonyMemory(colony: ColonySnapshot): RoomMemory {
  const roomWithMemory = colony.room as Room & { memory?: RoomMemory };
  const memory = colony.memory ?? roomWithMemory.memory ?? {};
  if (!colony.memory) {
    colony.memory = memory;
  }
  if (!roomWithMemory.memory) {
    roomWithMemory.memory = memory;
  }
  return memory;
}

function getCachedExpansionExecutorSelection(
  colonyMemory: RoomMemory,
  colonyName: string
): CachedExpansionExecutorSelection | null {
  const refreshedAt = colonyMemory.lastExpansionScoreTime;
  const rawSelection = (colonyMemory as { cachedExpansionSelection?: unknown }).cachedExpansionSelection;
  const selection = normalizeExpansionExecutorSelection(rawSelection, colonyName);
  if (
    !isFiniteNumber(refreshedAt) ||
    !isRecord(rawSelection) ||
    !isNonEmptyString(rawSelection.stateKey) ||
    !selection
  ) {
    return null;
  }

  return { refreshedAt, stateKey: rawSelection.stateKey, selection };
}

function normalizeExpansionExecutorSelection(
  rawSelection: unknown,
  colonyName: string
): NextExpansionTargetSelection | null {
  if (
    !isRecord(rawSelection) ||
    rawSelection.colony !== colonyName ||
    (rawSelection.status !== 'planned' && rawSelection.status !== 'skipped')
  ) {
    return null;
  }

  if (rawSelection.status === 'planned') {
    if (!isNonEmptyString(rawSelection.targetRoom)) {
      return null;
    }

    return {
      status: 'planned',
      colony: colonyName,
      targetRoom: rawSelection.targetRoom,
      ...(typeof rawSelection.controllerId === 'string'
        ? { controllerId: rawSelection.controllerId as Id<StructureController> }
        : {}),
      ...(isFiniteNumber(rawSelection.score) ? { score: rawSelection.score } : {})
    };
  }

  const reason = normalizeExpansionExecutorSkipReason(rawSelection.reason);
  if (!reason) {
    return null;
  }

  return {
    status: 'skipped',
    colony: colonyName,
    reason
  };
}

function normalizeExpansionExecutorSkipReason(
  reason: unknown
): NextExpansionTargetSelection['reason'] | undefined {
  return reason === 'noCandidate' ||
    reason === 'gclInsufficient' ||
    reason === 'roomLimitReached' ||
    reason === 'unmetPreconditions' ||
    reason === 'insufficientEvidence' ||
    reason === 'unavailable'
    ? reason
    : undefined;
}

function isExpansionExecutorCacheReusable(
  cachedSelection: CachedExpansionExecutorSelection,
  colony: ColonySnapshot,
  gameTime: number,
  stateKey: string
): boolean {
  if (
    cachedSelection.stateKey !== stateKey ||
    gameTime < cachedSelection.refreshedAt ||
    gameTime - cachedSelection.refreshedAt >= EXPANSION_EXECUTOR_REFRESH_INTERVAL
  ) {
    return false;
  }

  if (cachedSelection.selection.status !== 'planned') {
    return true;
  }

  return (
    hasExpansionExecutorTarget(colony.room.name, cachedSelection.selection.targetRoom) &&
    isExpansionExecutorClaimReady(colony, gameTime)
  );
}

function hasExpansionExecutorTarget(colony: string, targetRoom: string | undefined): boolean {
  if (!targetRoom) {
    return false;
  }

  const targets = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.targets;
  return Array.isArray(targets)
    ? targets.some(
        (target) =>
          isRecord(target) &&
          target.colony === colony &&
          target.roomName === targetRoom &&
          target.action === 'claim' &&
          target.createdBy === NEXT_EXPANSION_TARGET_CREATOR
      )
    : false;
}

function getExpansionExecutorCacheStateKey(colony: ColonySnapshot, gameTime = getGameTime()): string {
  const controller = colony.room.controller;
  const controllerLevel = isFiniteNumber(controller?.level) ? controller.level : 'unknown';
  const downgradeState =
    isFiniteNumber(controller?.ticksToDowngrade) &&
    controller.ticksToDowngrade < EXPANSION_EXECUTOR_DOWNGRADE_GUARD_TICKS
      ? 'guarded'
      : 'stable';

  return [
    colony.room.name,
    getExpansionExecutorAvailableEnergyState(colony.energyAvailable),
    colony.energyCapacityAvailable,
    controllerLevel,
    getGclLevel() ?? 'unknown',
    countVisibleOwnedRooms(),
    downgradeState,
    countActiveExpansionExecutorSpawns(colony),
    getExpansionExecutorVisibleHostileState(colony.room),
    getExpansionExecutorThreatState(colony.room.name, gameTime),
    countActivePostClaimBootstraps(),
    getLatestTerritoryScoutIntelUpdatedAt(colony.room.name)
  ].join('|');
}

function getExpansionExecutorAvailableEnergyState(energyAvailable: number): string {
  return energyAvailable >= TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY ? 'availableReady' : 'availableWaiting';
}

function isExpansionExecutorClaimReady(colony: ColonySnapshot, gameTime: number): boolean {
  const controller = colony.room.controller;
  return (
    controller?.my === true &&
    isFiniteNumber(controller.level) &&
    controller.level >= 2 &&
    countActiveExpansionExecutorSpawns(colony) > 0 &&
    !hasExpansionExecutorActiveHostiles(colony.room) &&
    getExpansionExecutorThreatState(colony.room.name, gameTime) === 'none' &&
    colony.energyAvailable >= TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY &&
    colony.energyCapacityAvailable >= TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY
  );
}

function getExpansionExecutorVisibleHostileState(room: Room): string {
  return hasExpansionExecutorActiveHostiles(room) ? 'visibleHostile' : 'visibleSafe';
}

function countActiveExpansionExecutorSpawns(colony: ColonySnapshot): number {
  const snapshotSpawnCount = colony.spawns.filter(isActiveExpansionExecutorSpawn).length;
  if (snapshotSpawnCount > 0) {
    return snapshotSpawnCount;
  }

  const gameSpawns = (globalThis as { Game?: Partial<Game> }).Game?.spawns;
  if (!gameSpawns) {
    return 0;
  }

  return Object.values(gameSpawns).filter(
    (spawn) => spawn?.room?.name === colony.room.name && isActiveExpansionExecutorSpawn(spawn)
  ).length;
}

function isActiveExpansionExecutorSpawn(spawn: StructureSpawn): boolean {
  if (typeof spawn.isActive !== 'function') {
    return true;
  }

  try {
    return spawn.isActive() !== false;
  } catch {
    return false;
  }
}

function hasExpansionExecutorActiveHostiles(room: Room): boolean {
  return (
    findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length > 0 ||
    findRoomObjects<AnyStructure>(room, getFindConstant('FIND_HOSTILE_STRUCTURES')).length > 0
  );
}

function getExpansionExecutorThreatState(roomName: string, gameTime: number): ExpansionExecutorThreatState {
  const threatMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense?.colonyThreats;
  if (!threatMemory) {
    return 'none';
  }

  if (!isRecentExpansionExecutorThreatMemory(threatMemory.updatedAt, gameTime)) {
    return 'unknown';
  }

  const roomThreat = threatMemory.rooms?.[roomName];
  if (roomThreat === undefined || roomThreat === null) {
    return 'none';
  }

  if (!isRecentExpansionExecutorThreatMemory(roomThreat.updatedAt, gameTime)) {
    return 'unknown';
  }

  return roomThreat.level ?? 'unknown';
}

function isRecentExpansionExecutorThreatMemory(updatedAt: unknown, gameTime: number): boolean {
  return (
    isFiniteNumber(updatedAt) &&
    updatedAt <= gameTime &&
    gameTime - updatedAt <= EXPANSION_EXECUTOR_THREAT_MEMORY_STALE_TICKS
  );
}

function refreshExpansionExecutorCacheStateKeyAfterCurrentTickScoutIntel(
  stateKey: string,
  colony: string,
  roomNames: string[],
  gameTime: number
): string {
  const recordedCurrentTickScoutIntel = roomNames.some(
    (roomName) => getTerritoryScoutIntel(colony, roomName)?.updatedAt === gameTime
  );
  return recordedCurrentTickScoutIntel ? replaceExpansionExecutorCacheScoutIntelUpdatedAt(stateKey, gameTime) : stateKey;
}

function replaceExpansionExecutorCacheScoutIntelUpdatedAt(stateKey: string, updatedAt: number): string {
  const separatorIndex = stateKey.lastIndexOf('|');
  if (separatorIndex < 0) {
    return stateKey;
  }

  const currentUpdatedAt = Number(stateKey.slice(separatorIndex + 1));
  const nextUpdatedAt = Math.max(Number.isFinite(currentUpdatedAt) ? currentUpdatedAt : 0, updatedAt);
  return `${stateKey.slice(0, separatorIndex + 1)}${nextUpdatedAt}`;
}

function countVisibleOwnedRooms(): number {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return 0;
  }

  return Object.values(rooms).filter((room) => room?.controller?.my === true).length;
}

function getGclLevel(): number | null {
  const level = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game?.gcl?.level;
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
}

function countActivePostClaimBootstraps(): number {
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isRecord(records)) {
    return 0;
  }

  return Object.values(records).filter(
    (record) => isRecord(record) && record.status !== 'ready'
  ).length;
}

function getLatestTerritoryScoutIntelUpdatedAt(colony: string): number {
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.scoutIntel;
  if (!isRecord(records)) {
    return 0;
  }

  let latestUpdatedAt = 0;
  for (const record of Object.values(records)) {
    if (
      isRecord(record) &&
      record.colony === colony &&
      isFiniteNumber(record.updatedAt) &&
      record.updatedAt > latestUpdatedAt
    ) {
      latestUpdatedAt = record.updatedAt;
    }
  }

  return latestUpdatedAt;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function findRoomObjects<T>(room: Room, findConstant: number | undefined): T[] {
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getFindConstant(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
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
