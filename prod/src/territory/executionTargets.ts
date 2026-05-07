import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export interface TerritoryExecutionRefreshOptions {
  colony?: string;
  gameTime?: number;
}

export interface TerritoryExecutionRefreshResult {
  action: TerritoryControlAction;
  targetCount: number;
  intentCount: number;
}

interface RawTerritoryExecutionTarget extends Record<string, unknown> {
  action?: unknown;
  actionHint?: unknown;
  colony?: unknown;
  controllerId?: unknown;
  createdBy?: unknown;
  enabled?: unknown;
  postClaimBootstrapReserveEnergy?: unknown;
  roomName?: unknown;
}

const TERRITORY_AUTOMATION_SOURCES = new Set<TerritoryAutomationSource>([
  'occupationRecommendation',
  'autonomousExpansionClaim',
  'colonyExpansion',
  'expansionPlanner',
  'nextExpansionScoring',
  'adjacentRoomReservation'
]);

export function refreshTerritoryExecutionTargets(
  action: TerritoryControlAction,
  options: TerritoryExecutionRefreshOptions = {}
): TerritoryExecutionRefreshResult {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return { action, targetCount: 0, intentCount: 0 };
  }

  const gameTime = options.gameTime ?? getGameTime();
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;

  let targetCount = 0;
  let intentCount = 0;
  for (const rawTarget of territoryMemory.targets) {
    const target = normalizeExecutionTarget(rawTarget, action, options.colony);
    if (!target) {
      continue;
    }

    canonicalizeExecutionTarget(rawTarget, target);
    targetCount += 1;
    if (refreshExecutionIntent(intents, target, gameTime)) {
      intentCount += 1;
    }
  }

  return { action, targetCount, intentCount };
}

function normalizeExecutionTarget(
  rawTarget: unknown,
  action: TerritoryControlAction,
  colonyFilter: string | undefined
): TerritoryTargetMemory | null {
  if (!isRecord(rawTarget)) {
    return null;
  }

  const targetAction = getExecutionTargetAction(rawTarget);
  if (
    targetAction !== action ||
    !isNonEmptyString(rawTarget.colony) ||
    !isNonEmptyString(rawTarget.roomName) ||
    rawTarget.enabled === false ||
    rawTarget.roomName === rawTarget.colony ||
    (isNonEmptyString(colonyFilter) && rawTarget.colony !== colonyFilter)
  ) {
    return null;
  }

  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action: targetAction,
    ...(typeof rawTarget.controllerId === 'string'
      ? { controllerId: rawTarget.controllerId as Id<StructureController> }
      : {}),
    ...(isTerritoryAutomationSource(rawTarget.createdBy) ? { createdBy: rawTarget.createdBy } : {}),
    ...(isPositiveFiniteNumber(rawTarget.postClaimBootstrapReserveEnergy)
      ? { postClaimBootstrapReserveEnergy: Math.floor(rawTarget.postClaimBootstrapReserveEnergy) }
      : {})
  };
}

function getExecutionTargetAction(rawTarget: RawTerritoryExecutionTarget): TerritoryControlAction | null {
  if (isTerritoryControlAction(rawTarget.action)) {
    return rawTarget.action;
  }

  return isTerritoryControlAction(rawTarget.actionHint) ? rawTarget.actionHint : null;
}

function canonicalizeExecutionTarget(rawTarget: unknown, target: TerritoryTargetMemory): void {
  if (!isRecord(rawTarget)) {
    return;
  }

  rawTarget.action = target.action;
  if (target.controllerId) {
    rawTarget.controllerId = target.controllerId;
  }
}

function refreshExecutionIntent(
  intents: TerritoryIntentMemory[],
  target: TerritoryTargetMemory,
  gameTime: number
): boolean {
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === target.colony &&
      intent.targetRoom === target.roomName &&
      intent.action === target.action
  );

  if (existingIndex >= 0) {
    const existing = intents[existingIndex];
    if (existing.status !== 'planned' && existing.status !== 'active') {
      return false;
    }

    const createdBy = existing.createdBy ?? target.createdBy;
    intents[existingIndex] = {
      ...existing,
      updatedAt: gameTime,
      ...(target.controllerId ? { controllerId: target.controllerId } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(target.postClaimBootstrapReserveEnergy
        ? { postClaimBootstrapReserveEnergy: target.postClaimBootstrapReserveEnergy }
        : {})
    };
    return true;
  }

  intents.push({
    colony: target.colony,
    targetRoom: target.roomName,
    action: target.action,
    status: 'planned',
    updatedAt: gameTime,
    ...(target.controllerId ? { controllerId: target.controllerId } : {}),
    ...(target.createdBy ? { createdBy: target.createdBy } : {}),
    ...(target.postClaimBootstrapReserveEnergy
      ? { postClaimBootstrapReserveEnergy: target.postClaimBootstrapReserveEnergy }
      : {})
  });
  return true;
}

function getTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory?.territory || typeof memory.territory !== 'object' || Array.isArray(memory.territory)) {
    return null;
  }

  return memory.territory as TerritoryMemory;
}

function isTerritoryAutomationSource(source: unknown): source is TerritoryAutomationSource {
  return typeof source === 'string' && TERRITORY_AUTOMATION_SOURCES.has(source as TerritoryAutomationSource);
}

function isTerritoryControlAction(action: unknown): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is RawTerritoryExecutionTarget {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}
