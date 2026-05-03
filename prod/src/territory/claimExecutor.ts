import type { ColonySnapshot } from '../colony/colonyRegistry';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import type { RuntimeTelemetryEvent, RuntimeTerritoryClaimTelemetryReason } from '../telemetry/runtimeSummary';
import type { OccupationRecommendationReport, OccupationRecommendationScore } from './occupationRecommendation';
import { TERRITORY_SUPPRESSION_RETRY_TICKS } from './territoryPlanner';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export const AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR: TerritoryAutomationSource =
  'autonomousExpansionClaim';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_NO_BODYPART_CODE = -12 as ScreepsReturnCode;
const ERR_GCL_NOT_ENOUGH_CODE = -15 as ScreepsReturnCode;

export type AutonomousExpansionClaimStatus = 'planned' | 'skipped';

export interface AutonomousExpansionClaimEvaluation {
  status: AutonomousExpansionClaimStatus;
  colony: string;
  reason?: RuntimeTerritoryClaimTelemetryReason;
  targetRoom?: string;
  controllerId?: Id<StructureController>;
  score?: number;
}

export function refreshAutonomousExpansionClaimIntent(
  colony: ColonySnapshot,
  report: OccupationRecommendationReport,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): AutonomousExpansionClaimEvaluation {
  const evaluation = evaluateAutonomousExpansionClaim(colony, report, gameTime);
  if (evaluation.status === 'planned' && evaluation.targetRoom) {
    persistAutonomousExpansionClaimIntent(colony.room.name, evaluation, gameTime);
    recordTerritoryClaimTelemetry(telemetryEvents, {
      ...evaluation,
      phase: 'intent'
    });
    return evaluation;
  }

  if (shouldPruneAutonomousExpansionClaimTargets(evaluation.reason)) {
    pruneAutonomousExpansionClaimTargets(colony.room.name);
  }
  if (evaluation.targetRoom) {
    recordTerritoryClaimTelemetry(telemetryEvents, {
      ...evaluation,
      phase: 'skip'
    });
  }

  return evaluation;
}

export function shouldDeferOccupationRecommendationForExpansionClaim(
  evaluation: AutonomousExpansionClaimEvaluation
): boolean {
  return evaluation.status === 'planned' || evaluation.reason === 'controllerCooldown';
}

export function clearAutonomousExpansionClaimIntent(colony: string): void {
  pruneAutonomousExpansionClaimTargets(colony);
}

function shouldPruneAutonomousExpansionClaimTargets(
  reason: RuntimeTerritoryClaimTelemetryReason | undefined
): boolean {
  return (
    reason === 'noAdjacentCandidate' ||
    reason === 'hostilePresence' ||
    reason === 'controllerMissing' ||
    reason === 'controllerOwned' ||
    reason === 'controllerReserved'
  );
}

function getVisibleOwnedRoomCount(): number {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return 0;
  }

  return Object.values(rooms).filter((room) => room?.controller?.my === true).length;
}

function isAutonomousExpansionClaimGclInsufficient(): boolean {
  const gcl = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game?.gcl;
  if (!gcl || typeof gcl.level !== 'number' || gcl.level <= 0) {
    return false;
  }

  const maxClaimableRooms = gcl.level;
  if (!Number.isFinite(maxClaimableRooms)) {
    return false;
  }

  return getVisibleOwnedRoomCount() >= maxClaimableRooms;
}

export function executeExpansionClaim(
  creep: Creep,
  controller: StructureController,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): ScreepsReturnCode {
  const result =
    typeof creep.claimController === 'function'
      ? creep.claimController(controller)
      : OK_CODE;
  const reason = getClaimResultReason(result);
  recordTerritoryClaimTelemetry(telemetryEvents, {
    colony: creep.memory.colony ?? creep.room?.name ?? controller.room?.name ?? 'unknown',
    targetRoom: creep.memory.territory?.targetRoom ?? creep.room?.name,
    controllerId: controller.id,
    creepName: creep.name,
    phase: 'claim',
    result,
    ...(reason ? { reason } : {})
  });

  return result;
}

export function isExpansionClaimControllerOnCooldown(controller: StructureController): boolean {
  return getControllerClaimCooldown(controller) > 0;
}

export function recordExpansionClaimSkipTelemetry(
  creep: Creep,
  controller: StructureController,
  reason: RuntimeTerritoryClaimTelemetryReason,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): void {
  recordTerritoryClaimTelemetry(telemetryEvents, {
    colony: creep.memory.colony ?? creep.room?.name ?? controller.room?.name ?? 'unknown',
    targetRoom: creep.memory.territory?.targetRoom ?? creep.room?.name,
    controllerId: controller.id,
    creepName: creep.name,
    phase: 'skip',
    reason
  });
}

function evaluateAutonomousExpansionClaim(
  colony: ColonySnapshot,
  report: OccupationRecommendationReport,
  gameTime: number
): AutonomousExpansionClaimEvaluation {
  const colonyName = colony.room.name;
  const candidate = selectTopScoredAdjacentCandidate(report, colonyName);
  if (!candidate) {
    return { status: 'skipped', colony: colonyName, reason: 'noAdjacentCandidate' };
  }

  const baseEvaluation = {
    status: 'skipped' as const,
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };

  if (colony.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return { ...baseEvaluation, reason: 'energyCapacityLow' };
  }

  const room = getVisibleRoom(candidate.roomName);
  if (!room) {
    return { ...baseEvaluation, reason: 'roomNotVisible' };
  }

  if (isVisibleRoomHostile(room)) {
    return { ...baseEvaluation, reason: 'hostilePresence' };
  }

  const controller = room.controller;
  if (!controller) {
    return { ...baseEvaluation, reason: 'controllerMissing' };
  }

  const controllerId = controller.id;
  const controllerEvaluation = {
    ...baseEvaluation,
    ...(typeof controllerId === 'string' ? { controllerId: controllerId as Id<StructureController> } : {})
  };

  if (isControllerOwned(controller)) {
    return { ...controllerEvaluation, reason: 'controllerOwned' };
  }

  if (isControllerReserved(controller, getControllerOwnerUsername(colony.room.controller))) {
    return { ...controllerEvaluation, reason: 'controllerReserved' };
  }

  if (isAutonomousExpansionClaimGclInsufficient()) {
    return { ...controllerEvaluation, reason: 'gclInsufficient' };
  }

  if (isExpansionClaimControllerOnCooldown(controller)) {
    return { ...controllerEvaluation, reason: 'controllerCooldown' };
  }

  if (isAutonomousClaimSuppressed(colonyName, candidate.roomName, gameTime)) {
    return { ...controllerEvaluation, reason: 'suppressed' };
  }

  return {
    status: 'planned',
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...(typeof controllerId === 'string' ? { controllerId: controllerId as Id<StructureController> } : {})
  };
}

function selectTopScoredAdjacentCandidate(
  report: OccupationRecommendationReport,
  colony: string
): OccupationRecommendationScore | null {
  return (
    report.candidates.find(
      (candidate) =>
        candidate.source === 'adjacent' ||
        isExistingAutonomousExpansionClaimTarget(colony, candidate.roomName)
    ) ?? null
  );
}

function persistAutonomousExpansionClaimIntent(
  colony: string,
  evaluation: AutonomousExpansionClaimEvaluation,
  gameTime: number
): void {
  if (!evaluation.targetRoom) {
    return;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const target: TerritoryTargetMemory = {
    colony,
    roomName: evaluation.targetRoom,
    action: 'claim',
    createdBy: AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR,
    ...(evaluation.controllerId ? { controllerId: evaluation.controllerId } : {})
  };

  pruneOccupationRecommendationTargets(territoryMemory, colony);
  pruneAutonomousExpansionClaimTargets(colony, territoryMemory, target);
  upsertTerritoryTarget(territoryMemory, target);

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === target.roomName &&
      intent.action === 'claim' &&
      intent.createdBy === AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR
  );
  upsertTerritoryIntent(intents, {
    colony,
    targetRoom: target.roomName,
    action: 'claim',
    status: existingIntent?.status === 'active' ? 'active' : 'planned',
    updatedAt: gameTime,
    createdBy: AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR,
    ...(target.controllerId ? { controllerId: target.controllerId } : {})
  });
}

function upsertTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingTarget = territoryMemory.targets.find(
    (rawTarget) =>
      isSameTarget(rawTarget, target) &&
      isRecord(rawTarget) &&
      rawTarget.createdBy === target.createdBy
  );
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }

  if (isRecord(existingTarget)) {
    existingTarget.action = target.action;
    existingTarget.createdBy = target.createdBy;
    existingTarget.enabled = target.enabled;
    if (target.controllerId) {
      existingTarget.controllerId = target.controllerId;
    }
  }
}

function upsertTerritoryIntent(
  intents: TerritoryIntentMemory[],
  nextIntent: TerritoryIntentMemory
): void {
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === nextIntent.colony &&
      intent.targetRoom === nextIntent.targetRoom &&
      intent.action === nextIntent.action &&
      intent.createdBy === nextIntent.createdBy
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
}

function pruneAutonomousExpansionClaimTargets(
  colony: string,
  territoryMemory = getTerritoryMemoryRecord(),
  activeTarget?: TerritoryTargetMemory
): void {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return;
  }

  const removedTargetKeys = new Set<string>();
  territoryMemory.targets = territoryMemory.targets.filter((target) => {
    if (!isAutonomousExpansionClaimTarget(target, colony)) {
      return true;
    }

    if (activeTarget && isSameTarget(target, activeTarget)) {
      return true;
    }

    if (isRecord(target) && isNonEmptyString(target.roomName) && target.action === 'claim') {
      removedTargetKeys.add(getTargetKey(target.roomName, 'claim'));
    }
    return false;
  });

  if (removedTargetKeys.size === 0) {
    return;
  }

  territoryMemory.intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) =>
      intent.colony !== colony ||
      intent.createdBy !== AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR ||
      !removedTargetKeys.has(getTargetKey(intent.targetRoom, intent.action))
  );
}

function pruneOccupationRecommendationTargets(territoryMemory: TerritoryMemory, colony: string): void {
  if (!Array.isArray(territoryMemory.targets)) {
    return;
  }

  territoryMemory.targets = territoryMemory.targets.filter(
    (target) =>
      !(
        isRecord(target) &&
        target.colony === colony &&
        target.createdBy === 'occupationRecommendation'
      )
  );
}

function isAutonomousClaimSuppressed(colony: string, targetRoom: string, gameTime: number): boolean {
  const intents = normalizeTerritoryIntents(getTerritoryMemoryRecord()?.intents);
  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === 'claim' &&
      intent.status === 'suppressed' &&
      gameTime >= intent.updatedAt &&
      gameTime - intent.updatedAt < TERRITORY_SUPPRESSION_RETRY_TICKS
  );
}

function recordTerritoryClaimTelemetry(
  telemetryEvents: RuntimeTelemetryEvent[],
  event: {
    colony: string;
    phase: 'intent' | 'skip' | 'claim';
    targetRoom?: string;
    controllerId?: Id<StructureController>;
    creepName?: string;
    result?: ScreepsReturnCode;
    reason?: RuntimeTerritoryClaimTelemetryReason;
    score?: number;
  }
): void {
  telemetryEvents.push({
    type: 'territoryClaim',
    roomName: event.colony,
    colony: event.colony,
    phase: event.phase,
    ...(event.targetRoom ? { targetRoom: event.targetRoom } : {}),
    ...(event.controllerId ? { controllerId: event.controllerId } : {}),
    ...(event.creepName ? { creepName: event.creepName } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.score !== undefined ? { score: event.score } : {})
  });
}

function getClaimResultReason(result: ScreepsReturnCode): RuntimeTerritoryClaimTelemetryReason | null {
  switch (result) {
    case OK_CODE:
      return null;
    case ERR_NOT_IN_RANGE_CODE:
      return 'notInRange';
    case ERR_INVALID_TARGET_CODE:
      return 'invalidTarget';
    case ERR_NO_BODYPART_CODE:
      return 'missingClaimPart';
    case ERR_GCL_NOT_ENOUGH_CODE:
      return 'gclUnavailable';
    default:
      return 'claimFailed';
  }
}

function getControllerClaimCooldown(controller: StructureController): number {
  const upgradeBlocked = (controller as StructureController & { upgradeBlocked?: number }).upgradeBlocked;
  return typeof upgradeBlocked === 'number' && upgradeBlocked > 0 ? upgradeBlocked : 0;
}

function isAutonomousExpansionClaimTarget(target: unknown, colony: string): boolean {
  return (
    isRecord(target) &&
    target.colony === colony &&
    target.action === 'claim' &&
    target.createdBy === AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR
  );
}

function isExistingAutonomousExpansionClaimTarget(colony: string, roomName: string): boolean {
  const targets = getTerritoryMemoryRecord()?.targets;
  return Array.isArray(targets)
    ? targets.some(
        (target) =>
          isAutonomousExpansionClaimTarget(target, colony) &&
          isRecord(target) &&
          target.roomName === roomName
      )
    : false;
}

function isSameTarget(left: unknown, right: TerritoryTargetMemory): boolean {
  return (
    isRecord(left) &&
    left.colony === right.colony &&
    left.roomName === right.roomName &&
    left.action === right.action
  );
}

function getTargetKey(roomName: string, action: TerritoryIntentAction): string {
  return `${roomName}:${action}`;
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
}

function getTerritoryMemoryRecord(): TerritoryMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory as TerritoryMemory | undefined;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!memory.territory) {
    memory.territory = {};
  }

  return memory.territory as TerritoryMemory;
}

function isVisibleRoomHostile(room: Room): boolean {
  return findVisibleHostileCreeps(room).length > 0 || findVisibleHostileStructures(room).length > 0;
}

function findVisibleHostileCreeps(room: Room): Creep[] {
  return typeof FIND_HOSTILE_CREEPS === 'number' && typeof room.find === 'function'
    ? room.find(FIND_HOSTILE_CREEPS)
    : [];
}

function findVisibleHostileStructures(room: Room): AnyStructure[] {
  return typeof FIND_HOSTILE_STRUCTURES === 'number' && typeof room.find === 'function'
    ? room.find(FIND_HOSTILE_STRUCTURES)
    : [];
}

function isControllerOwned(controller: StructureController): boolean {
  return controller.my === true || controller.owner != null;
}

function isControllerReserved(
  controller: StructureController,
  colonyOwnerUsername: string | undefined
): boolean {
  const reservationUsername = controller.reservation?.username;
  return isNonEmptyString(reservationUsername) && reservationUsername !== colonyOwnerUsername;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = controller?.owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
