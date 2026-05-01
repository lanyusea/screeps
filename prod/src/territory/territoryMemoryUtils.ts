export function normalizeTerritoryIntents(rawIntents: TerritoryMemory['intents'] | unknown): TerritoryIntentMemory[] {
  return Array.isArray(rawIntents)
    ? rawIntents.flatMap((intent) => {
        const normalizedIntent = normalizeTerritoryIntent(intent);
        return normalizedIntent ? [normalizedIntent] : [];
      })
    : [];
}

export function normalizeTerritoryIntent(rawIntent: unknown): TerritoryIntentMemory | null {
  if (!isRecord(rawIntent)) {
    return null;
  }

  if (
    !isNonEmptyString(rawIntent.colony) ||
    !isNonEmptyString(rawIntent.targetRoom) ||
    !isTerritoryIntentAction(rawIntent.action) ||
    !isTerritoryIntentStatus(rawIntent.status) ||
    typeof rawIntent.updatedAt !== 'number'
  ) {
    return null;
  }

  const followUp = normalizeTerritoryFollowUp(rawIntent.followUp);
  const suspended = normalizeTerritoryIntentSuspension(rawIntent.suspended);
  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...(followUp && isFiniteNumber(rawIntent.lastAttemptAt) ? { lastAttemptAt: rawIntent.lastAttemptAt } : {}),
    ...(typeof rawIntent.controllerId === 'string'
      ? { controllerId: rawIntent.controllerId as Id<StructureController> }
      : {}),
    ...(rawIntent.requiresControllerPressure === true ? { requiresControllerPressure: true } : {}),
    ...(followUp ? { followUp } : {}),
    ...(suspended ? { suspended } : {})
  };
}

export function normalizeTerritoryIntentSuspension(
  rawSuspension: unknown
): TerritoryIntentSuspensionMemory | null {
  if (!isRecord(rawSuspension)) {
    return null;
  }

  if (
    rawSuspension.reason !== 'hostile_presence' ||
    !isFiniteNumber(rawSuspension.hostileCount) ||
    rawSuspension.hostileCount <= 0 ||
    !isFiniteNumber(rawSuspension.updatedAt)
  ) {
    return null;
  }

  return {
    reason: rawSuspension.reason,
    hostileCount: Math.floor(rawSuspension.hostileCount),
    updatedAt: rawSuspension.updatedAt
  };
}

export function normalizeTerritoryFollowUp(rawFollowUp: unknown): TerritoryFollowUpMemory | null {
  if (!isRecord(rawFollowUp) || !isTerritoryFollowUpSource(rawFollowUp.source)) {
    return null;
  }

  const originAction = getTerritoryFollowUpOriginAction(rawFollowUp.source);
  if (!isNonEmptyString(rawFollowUp.originRoom) || rawFollowUp.originAction !== originAction) {
    return null;
  }

  return {
    source: rawFollowUp.source,
    originRoom: rawFollowUp.originRoom,
    originAction
  };
}

function getTerritoryFollowUpOriginAction(source: TerritoryFollowUpSource): TerritoryControlAction {
  return source === 'satisfiedClaimAdjacent' ? 'claim' : 'reserve';
}

function isTerritoryIntentAction(action: unknown): action is TerritoryIntentAction {
  return action === 'claim' || action === 'reserve' || action === 'scout';
}

function isTerritoryIntentStatus(status: unknown): status is TerritoryIntentMemory['status'] {
  return status === 'planned' || status === 'active' || status === 'suppressed';
}

function isTerritoryFollowUpSource(source: unknown): source is TerritoryFollowUpSource {
  return (
    source === 'satisfiedClaimAdjacent' ||
    source === 'satisfiedReserveAdjacent' ||
    source === 'activeReserveAdjacent'
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
