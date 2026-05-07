import type { ColonySnapshot } from '../colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import { runRecommendedExpansionClaimExecutor } from './claimExecutor';
import {
  buildRuntimeExpansionCandidateReport,
  NEXT_EXPANSION_TARGET_CREATOR,
  refreshNextExpansionTargetSelection,
  selectExpansionScoutTargets,
  type NextExpansionTargetSelection
} from './expansionScoring';
import { refreshExpansionRoomScouting } from './roomScouting';
import { logBestClaimTarget } from './territoryRunner';

const EXPANSION_EXECUTOR_REFRESH_INTERVAL = 50;
const EXPANSION_EXECUTOR_DOWNGRADE_GUARD_TICKS = 5_000;

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
  const stateKey = getExpansionExecutorCacheStateKey(colony);
  const cachedSelection = getCachedExpansionExecutorSelection(colonyMemory, colonyName);
  if (
    cachedSelection &&
    isExpansionExecutorCacheReusable(cachedSelection, colonyName, gameTime, stateKey)
  ) {
    return cachedSelection.selection;
  }

  const report = buildRuntimeExpansionCandidateReport(colony);
  const selection = refreshNextExpansionTargetSelection(colony, report, gameTime);
  if (selection.status === 'skipped' && selection.reason === 'insufficientEvidence') {
    refreshExpansionRoomScouting(colony, selectExpansionScoutTargets(report), gameTime, telemetryEvents);
  }

  logBestClaimTarget(colony.room);
  colonyMemory.lastExpansionScoreTime = gameTime;
  colonyMemory.cachedExpansionSelection = {
    ...selection,
    stateKey: getExpansionExecutorCacheStateKey(colony)
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
  colony: string,
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

  return (
    cachedSelection.selection.status !== 'planned' ||
    hasExpansionExecutorTarget(colony, cachedSelection.selection.targetRoom)
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

function getExpansionExecutorCacheStateKey(colony: ColonySnapshot): string {
  const controller = colony.room.controller;
  const controllerLevel = isFiniteNumber(controller?.level) ? controller.level : 'unknown';
  const downgradeState =
    isFiniteNumber(controller?.ticksToDowngrade) &&
    controller.ticksToDowngrade < EXPANSION_EXECUTOR_DOWNGRADE_GUARD_TICKS
      ? 'guarded'
      : 'stable';

  return [
    colony.room.name,
    colony.energyCapacityAvailable,
    controllerLevel,
    getGclLevel() ?? 'unknown',
    countVisibleOwnedRooms(),
    downgradeState,
    countActivePostClaimBootstraps(),
    getLatestTerritoryScoutIntelUpdatedAt(colony.room.name)
  ].join('|');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
