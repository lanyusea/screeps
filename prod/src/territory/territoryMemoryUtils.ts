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
    !isFiniteNumber(rawIntent.updatedAt)
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
    ...(isTerritoryAutomationSource(rawIntent.createdBy) ? { createdBy: rawIntent.createdBy } : {}),
    ...(isTerritoryIntentSuppressionReason(rawIntent.reason) ? { reason: rawIntent.reason } : {}),
    ...(isFiniteNumber(rawIntent.lastAttemptAt) ? { lastAttemptAt: rawIntent.lastAttemptAt } : {}),
    ...(typeof rawIntent.controllerId === 'string'
      ? { controllerId: rawIntent.controllerId as Id<StructureController> }
      : {}),
    ...(rawIntent.requiresControllerPressure === true ? { requiresControllerPressure: true } : {}),
    ...(followUp ? { followUp } : {}),
    ...(isPositiveFiniteNumber(rawIntent.postClaimBootstrapReserveEnergy)
      ? { postClaimBootstrapReserveEnergy: Math.floor(rawIntent.postClaimBootstrapReserveEnergy) }
      : {}),
    ...(suspended ? { suspended } : {}),
    ...(isTerritoryExpansionCandidateBlockReason(rawIntent.blockReason)
      ? { blockReason: rawIntent.blockReason }
      : {})
  };
}

export function normalizeTerritoryIntentSuspension(
  rawSuspension: unknown
): TerritoryIntentSuspensionMemory | null {
  if (!isRecord(rawSuspension)) {
    return null;
  }

  if (!isFiniteNumber(rawSuspension.updatedAt)) {
    return null;
  }

  if (rawSuspension.reason === 'owner_reserve_only') {
    return {
      reason: rawSuspension.reason,
      updatedAt: rawSuspension.updatedAt
    };
  }

  if (
    rawSuspension.reason === 'hostile_presence' &&
    isFiniteNumber(rawSuspension.hostileCount) &&
    rawSuspension.hostileCount > 0
  ) {
    return {
      reason: rawSuspension.reason,
      hostileCount: Math.floor(rawSuspension.hostileCount),
      updatedAt: rawSuspension.updatedAt
    };
  }

  return null;
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
  return (
    status === 'planned' ||
    status === 'active' ||
    status === 'suppressed' ||
    status === 'inactive' ||
    status === 'completed'
  );
}

function isTerritoryIntentSuppressionReason(reason: unknown): reason is TerritoryIntentSuppressionReason {
  return (
    reason === 'deadZoneTarget' ||
    reason === 'deadZoneRoute' ||
    reason === 'controllerLevel' ||
    reason === 'owner_reserve_only'
  );
}

function isTerritoryExpansionCandidateBlockReason(
  reason: unknown
): reason is TerritoryExpansionCandidateBlockReason {
  return (
    reason === 'insufficientEvidence' ||
    reason === 'targetUnavailable' ||
    reason === 'targetHostile' ||
    reason === 'controllerMissing' ||
    reason === 'controllerOwned' ||
    reason === 'controllerReserved' ||
    reason === 'sourcesMissing' ||
    reason === 'controllerRangeMissing' ||
    reason === 'terrainMissing' ||
    reason === 'energyCapacityLow' ||
    reason === 'energyBufferLow' ||
    reason === 'cpuBucketLow' ||
    reason === 'homeAlertActive' ||
    reason === 'controllerLevelLow' ||
    reason === 'homeDowngradeGuard' ||
    reason === 'postClaimBootstrapActive' ||
    reason === 'gclInsufficient' ||
    reason === 'roomLimitReached' ||
    reason === 'routeUnavailable'
  );
}

function isTerritoryFollowUpSource(source: unknown): source is TerritoryFollowUpSource {
  return (
    source === 'satisfiedClaimAdjacent' ||
    source === 'satisfiedReserveAdjacent' ||
    source === 'activeReserveAdjacent'
  );
}

function isTerritoryAutomationSource(source: unknown): source is TerritoryAutomationSource {
  return (
    source === 'occupationRecommendation' ||
    source === 'autonomousExpansionClaim' ||
    source === 'colonyExpansion' ||
    source === 'expansionPlanner' ||
    source === 'nextExpansionScoring' ||
    source === 'adjacentRoomReservation'
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
