import type { ColonySnapshot } from '../colony/colonyRegistry';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import type { RuntimeTelemetryEvent, RuntimeTerritoryClaimTelemetryReason } from '../telemetry/runtimeSummary';
import {
  scoreExpansionCandidates,
  type ExpansionCandidateInput,
  type ExpansionCandidateReport,
  type ExpansionCandidateScore,
  type ExpansionControllerEvidence,
  type ExpansionScoringInput
} from './expansionScoring';
import type { OccupationRecommendationReport, OccupationRecommendationScore } from './occupationRecommendation';
import { TERRITORY_SUPPRESSION_RETRY_TICKS } from './territoryPlanner';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export const AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR: TerritoryAutomationSource =
  'autonomousExpansionClaim';

const MIN_AUTONOMOUS_EXPANSION_CLAIM_SCORE = 500;
const MIN_AUTONOMOUS_EXPANSION_CLAIM_RCL = 2;
const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_NO_BODYPART_CODE = -12 as ScreepsReturnCode;
const ERR_GCL_NOT_ENOUGH_CODE = -15 as ScreepsReturnCode;

export type AutonomousExpansionClaimStatus = 'planned' | 'skipped';
type AutonomousExpansionClaimSkipReason =
  | RuntimeTerritoryClaimTelemetryReason
  | 'scoreBelowThreshold'
  | 'controllerLevelLow'
  | 'existingClaimIntent';

export interface AutonomousExpansionClaimEvaluation {
  status: AutonomousExpansionClaimStatus;
  colony: string;
  reason?: AutonomousExpansionClaimSkipReason;
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
    recordAutonomousExpansionClaimTelemetry(telemetryEvents, evaluation, 'intent');
    return evaluation;
  }

  if (shouldPruneAutonomousExpansionClaimTargets(evaluation.reason)) {
    pruneAutonomousExpansionClaimTargets(colony.room.name);
  }
  if (evaluation.targetRoom) {
    recordAutonomousExpansionClaimTelemetry(telemetryEvents, evaluation, 'skip');
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
  reason: AutonomousExpansionClaimSkipReason | undefined
): boolean {
  return (
    reason === 'noAdjacentCandidate' ||
    reason === 'scoreBelowThreshold' ||
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
  const expansionReport = scoreExpansionCandidates(buildAutonomousExpansionScoringInput(colony, report));
  const adjacentCandidates = getRankedAdjacentExpansionCandidates(expansionReport);
  const candidate =
    adjacentCandidates.find(
      (scoredCandidate) => !hasBlockingClaimIntentForRoom(colonyName, scoredCandidate.roomName)
    ) ?? null;
  if (!candidate) {
    const blockedCandidate = adjacentCandidates[0];
    return blockedCandidate
      ? {
          status: 'skipped',
          colony: colonyName,
          targetRoom: blockedCandidate.roomName,
          score: blockedCandidate.score,
          ...(blockedCandidate.controllerId ? { controllerId: blockedCandidate.controllerId } : {}),
          reason: 'existingClaimIntent'
        }
      : { status: 'skipped', colony: colonyName, reason: 'noAdjacentCandidate' };
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

  if (!hasSufficientAutonomousExpansionClaimRcl(colony)) {
    return { ...baseEvaluation, reason: 'controllerLevelLow' };
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

  if (candidate.score <= MIN_AUTONOMOUS_EXPANSION_CLAIM_SCORE) {
    return { ...controllerEvaluation, reason: 'scoreBelowThreshold' };
  }

  return {
    status: 'planned',
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...(typeof controllerId === 'string' ? { controllerId: controllerId as Id<StructureController> } : {})
  };
}

function buildAutonomousExpansionScoringInput(
  colony: ColonySnapshot,
  report: OccupationRecommendationReport
): ExpansionScoringInput {
  const colonyName = colony.room.name;
  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomNames = getVisibleOwnedRoomNames(colonyName, colonyOwnerUsername);
  const adjacentRoomNamesByOwnedRoom = getAdjacentRoomNamesByOwnedRoom(ownedRoomNames);
  const seenRooms = new Set<string>();
  const candidates: ExpansionCandidateInput[] = [];

  report.candidates.forEach((candidate, order) => {
    if (!isNonEmptyString(candidate.roomName) || seenRooms.has(candidate.roomName)) {
      return;
    }

    seenRooms.add(candidate.roomName);
    candidates.push(
      toExpansionCandidateInput(candidate, order, getOwnedAdjacency(candidate.roomName, adjacentRoomNamesByOwnedRoom))
    );
  });

  return {
    colonyName,
    ...(colonyOwnerUsername ? { colonyOwnerUsername } : {}),
    energyCapacityAvailable: colony.energyCapacityAvailable,
    ...(typeof colony.room.controller?.level === 'number' ? { controllerLevel: colony.room.controller.level } : {}),
    ownedRoomCount: getVisibleOwnedRoomCount(),
    ...(typeof colony.room.controller?.ticksToDowngrade === 'number'
      ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade }
      : {}),
    activePostClaimBootstrapCount: countActivePostClaimBootstraps(),
    candidates
  };
}

function toExpansionCandidateInput(
  candidate: OccupationRecommendationScore,
  order: number,
  adjacency: { adjacentToOwnedRoom: boolean; nearestOwnedRoom?: string; nearestOwnedRoomDistance?: number }
): ExpansionCandidateInput {
  const room = getVisibleRoom(candidate.roomName);
  const controller = room?.controller;
  const controllerId =
    typeof controller?.id === 'string'
      ? (controller.id as Id<StructureController>)
      : candidate.controllerId;
  const hostileCreepCount =
    typeof candidate.hostileCreepCount === 'number'
      ? candidate.hostileCreepCount
      : room
        ? findVisibleHostileCreeps(room).length
        : undefined;
  const hostileStructureCount =
    typeof candidate.hostileStructureCount === 'number'
      ? candidate.hostileStructureCount
      : room
        ? findVisibleHostileStructures(room).length
        : undefined;

  return {
    roomName: candidate.roomName,
    order,
    adjacentToOwnedRoom: adjacency.adjacentToOwnedRoom,
    visible: room != null,
    ...(typeof candidate.routeDistance === 'number' ? { routeDistance: candidate.routeDistance } : {}),
    ...(adjacency.nearestOwnedRoom ? { nearestOwnedRoom: adjacency.nearestOwnedRoom } : {}),
    ...(typeof adjacency.nearestOwnedRoomDistance === 'number'
      ? { nearestOwnedRoomDistance: adjacency.nearestOwnedRoomDistance }
      : {}),
    ...(controller ? { controller: summarizeExpansionController(controller) } : {}),
    ...(controllerId ? { controllerId } : {}),
    ...(typeof candidate.sourceCount === 'number' ? { sourceCount: candidate.sourceCount } : {}),
    ...(typeof hostileCreepCount === 'number' ? { hostileCreepCount } : {}),
    ...(typeof hostileStructureCount === 'number' ? { hostileStructureCount } : {})
  };
}

function summarizeExpansionController(controller: StructureController): ExpansionControllerEvidence {
  const ownerUsername = getControllerOwnerUsername(controller);
  const reservationUsername = controller.reservation?.username;
  return {
    ...(typeof controller.my === 'boolean' ? { my: controller.my } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(isNonEmptyString(reservationUsername) ? { reservationUsername } : {}),
    ...(typeof controller.reservation?.ticksToEnd === 'number'
      ? { reservationTicksToEnd: controller.reservation.ticksToEnd }
      : {})
  };
}

function getRankedAdjacentExpansionCandidates(report: ExpansionCandidateReport): ExpansionCandidateScore[] {
  return report.candidates
    .filter((candidate) => candidate.adjacentToOwnedRoom)
    .slice()
    .sort(compareAutonomousExpansionClaimCandidates);
}

function compareAutonomousExpansionClaimCandidates(
  left: ExpansionCandidateScore,
  right: ExpansionCandidateScore
): number {
  return (
    right.score - left.score ||
    compareOptionalNumbers(left.nearestOwnedRoomDistance, right.nearestOwnedRoomDistance) ||
    compareOptionalNumbers(left.routeDistance, right.routeDistance) ||
    left.roomName.localeCompare(right.roomName)
  );
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function getVisibleOwnedRoomNames(colonyName: string, ownerUsername: string | undefined): Set<string> {
  const ownedRoomNames = new Set<string>([colonyName]);
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return ownedRoomNames;
  }

  for (const room of Object.values(rooms)) {
    if (
      room?.controller?.my === true &&
      isNonEmptyString(room.name) &&
      (!ownerUsername || getControllerOwnerUsername(room.controller) === ownerUsername)
    ) {
      ownedRoomNames.add(room.name);
    }
  }

  return ownedRoomNames;
}

function getAdjacentRoomNamesByOwnedRoom(ownedRoomNames: Set<string>): Map<string, Set<string>> {
  const adjacentRoomNamesByOwnedRoom = new Map<string, Set<string>>();
  for (const roomName of ownedRoomNames) {
    adjacentRoomNamesByOwnedRoom.set(roomName, new Set(getAdjacentRoomNames(roomName)));
  }

  return adjacentRoomNamesByOwnedRoom;
}

function getOwnedAdjacency(
  roomName: string,
  adjacentRoomNamesByOwnedRoom: Map<string, Set<string>>
): { adjacentToOwnedRoom: boolean; nearestOwnedRoom?: string; nearestOwnedRoomDistance?: number } {
  for (const [ownedRoomName, adjacentRoomNames] of adjacentRoomNamesByOwnedRoom.entries()) {
    if (adjacentRoomNames.has(roomName)) {
      return {
        adjacentToOwnedRoom: true,
        nearestOwnedRoom: ownedRoomName,
        nearestOwnedRoomDistance: 1
      };
    }
  }

  return { adjacentToOwnedRoom: false };
}

function getAdjacentRoomNames(roomName: string): string[] {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  if (!gameMap || typeof gameMap.describeExits !== 'function') {
    return [];
  }

  const exits = gameMap.describeExits(roomName) as ExitsInformation | null;
  if (!isRecord(exits)) {
    return [];
  }

  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const exitRoom = exits[direction];
    return isNonEmptyString(exitRoom) ? [exitRoom] : [];
  });
}

function countActivePostClaimBootstraps(): number {
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isRecord(records)) {
    return 0;
  }

  return Object.values(records).filter((record) => isRecord(record) && record.status !== 'ready').length;
}

function hasSufficientAutonomousExpansionClaimRcl(colony: ColonySnapshot): boolean {
  return (colony.room.controller?.level ?? 0) >= MIN_AUTONOMOUS_EXPANSION_CLAIM_RCL;
}

function hasBlockingClaimIntentForRoom(colony: string, targetRoom: string): boolean {
  const intents = normalizeTerritoryIntents(getTerritoryMemoryRecord()?.intents);
  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === 'claim' &&
      (intent.status === 'active' || intent.createdBy !== AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR)
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

  if (hasBlockingClaimIntentForRoom(colony, evaluation.targetRoom)) {
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

function recordAutonomousExpansionClaimTelemetry(
  telemetryEvents: RuntimeTelemetryEvent[],
  evaluation: AutonomousExpansionClaimEvaluation,
  phase: 'intent' | 'skip'
): void {
  const reason = toRuntimeTerritoryClaimTelemetryReason(evaluation.reason);
  recordTerritoryClaimTelemetry(telemetryEvents, {
    colony: evaluation.colony,
    phase,
    ...(evaluation.targetRoom ? { targetRoom: evaluation.targetRoom } : {}),
    ...(evaluation.controllerId ? { controllerId: evaluation.controllerId } : {}),
    ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
    ...(reason ? { reason } : {})
  });
}

function toRuntimeTerritoryClaimTelemetryReason(
  reason: AutonomousExpansionClaimSkipReason | undefined
): RuntimeTerritoryClaimTelemetryReason | undefined {
  switch (reason) {
    case 'scoreBelowThreshold':
    case 'controllerLevelLow':
    case 'existingClaimIntent':
      return undefined;
    default:
      return reason;
  }
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
