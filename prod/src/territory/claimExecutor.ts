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
import {
  ensureTerritoryScoutAttempt,
  recordTerritoryScoutValidation,
  recordVisibleRoomScoutIntel,
  validateTerritoryScoutIntelForClaim,
  type TerritoryScoutValidationResult
} from './scoutIntel';

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
let autonomousExpansionClaimTickContext: AutonomousExpansionClaimTickContext | null = null;

export type AutonomousExpansionClaimStatus = 'planned' | 'skipped';
type AutonomousExpansionClaimSkipReason =
  | RuntimeTerritoryClaimTelemetryReason
  | 'scoreBelowThreshold'
  | 'controllerLevelLow'
  | 'existingClaimIntent';
interface AutonomousExpansionClaimTickContext {
  gameTime: number;
  gameMap: GameMap | undefined;
  territoryMemory: TerritoryMemory | undefined;
  rawIntents: TerritoryMemory['intents'] | undefined;
  territoryIntents: TerritoryIntentMemory[];
  adjacentRoomNamesByOwnedRoom: Map<string, Set<string>>;
}

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
  const context = getAutonomousExpansionClaimTickContext(gameTime);
  const evaluation = evaluateAutonomousExpansionClaim(colony, report, gameTime, context, telemetryEvents);
  if (evaluation.status === 'planned' && evaluation.targetRoom) {
    persistAutonomousExpansionClaimIntent(colony.room.name, evaluation, gameTime, context);
    recordAutonomousExpansionClaimTelemetry(telemetryEvents, evaluation, 'intent');
    return evaluation;
  }

  if (shouldPruneAutonomousExpansionClaimTargets(evaluation.reason)) {
    pruneAutonomousExpansionClaimTargets(colony.room.name, undefined, undefined, context);
  }
  if (evaluation.targetRoom) {
    recordAutonomousExpansionClaimTelemetry(telemetryEvents, evaluation, 'skip');
  }

  return evaluation;
}

export function shouldDeferOccupationRecommendationForExpansionClaim(
  evaluation: AutonomousExpansionClaimEvaluation
): boolean {
  return (
    evaluation.status === 'planned' ||
    evaluation.reason === 'controllerCooldown' ||
    evaluation.reason === 'scoutPending'
  );
}

export function clearAutonomousExpansionClaimIntent(colony: string): void {
  pruneAutonomousExpansionClaimTargets(colony);
  autonomousExpansionClaimTickContext = null;
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
    reason === 'controllerReserved' ||
    reason === 'sourcesMissing'
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

function getAutonomousExpansionClaimTickContext(gameTime: number): AutonomousExpansionClaimTickContext {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  const territoryMemory = getTerritoryMemoryRecord();
  const rawIntents = territoryMemory?.intents;
  if (
    autonomousExpansionClaimTickContext &&
    autonomousExpansionClaimTickContext.gameTime === gameTime &&
    autonomousExpansionClaimTickContext.gameMap === gameMap
  ) {
    if (
      autonomousExpansionClaimTickContext.territoryMemory !== territoryMemory ||
      autonomousExpansionClaimTickContext.rawIntents !== rawIntents
    ) {
      autonomousExpansionClaimTickContext.territoryMemory = territoryMemory;
      autonomousExpansionClaimTickContext.rawIntents = rawIntents;
      autonomousExpansionClaimTickContext.territoryIntents = normalizeTerritoryIntents(rawIntents);
    }
    return autonomousExpansionClaimTickContext;
  }

  autonomousExpansionClaimTickContext = {
    gameTime,
    gameMap,
    territoryMemory,
    rawIntents,
    territoryIntents: normalizeTerritoryIntents(rawIntents),
    adjacentRoomNamesByOwnedRoom: new Map()
  };
  return autonomousExpansionClaimTickContext;
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
  gameTime: number,
  context: AutonomousExpansionClaimTickContext,
  telemetryEvents: RuntimeTelemetryEvent[]
): AutonomousExpansionClaimEvaluation {
  const colonyName = colony.room.name;
  const expansionReport = scoreExpansionCandidates(buildAutonomousExpansionScoringInput(colony, report, context));
  const adjacentCandidates = getRankedAdjacentExpansionCandidates(expansionReport);
  const candidate =
    adjacentCandidates.find(
      (scoredCandidate) => !hasBlockingClaimIntentForRoom(scoredCandidate.roomName, context.territoryIntents)
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
  const controller = room?.controller;
  if (room) {
    recordVisibleRoomScoutIntel(colonyName, room, gameTime, undefined, telemetryEvents);
  }

  const visibleControllerId = controller?.id;
  const visibleControllerEvaluation = {
    ...baseEvaluation,
    ...(typeof visibleControllerId === 'string'
      ? { controllerId: visibleControllerId as Id<StructureController> }
      : {})
  };

  if (room && isVisibleRoomHostile(room)) {
    return { ...visibleControllerEvaluation, reason: 'hostilePresence' };
  }

  if (room && !controller) {
    return { ...visibleControllerEvaluation, reason: 'controllerMissing' };
  }

  if (controller && isControllerOwned(controller)) {
    return { ...visibleControllerEvaluation, reason: 'controllerOwned' };
  }

  if (controller && isControllerReserved(controller, getControllerOwnerUsername(colony.room.controller))) {
    return { ...visibleControllerEvaluation, reason: 'controllerReserved' };
  }

  if (isAutonomousExpansionClaimGclInsufficient()) {
    return { ...visibleControllerEvaluation, reason: 'gclInsufficient' };
  }

  if (controller && isExpansionClaimControllerOnCooldown(controller)) {
    return { ...visibleControllerEvaluation, reason: 'controllerCooldown' };
  }

  if (isAutonomousClaimSuppressed(colonyName, candidate.roomName, gameTime, context.territoryIntents)) {
    return { ...visibleControllerEvaluation, reason: 'suppressed' };
  }

  if (candidate.score <= MIN_AUTONOMOUS_EXPANSION_CLAIM_SCORE) {
    return { ...visibleControllerEvaluation, reason: 'scoreBelowThreshold' };
  }

  const scoutValidation = validateTerritoryScoutIntelForClaim({
    colony: colonyName,
    targetRoom: candidate.roomName,
    colonyOwnerUsername: getControllerOwnerUsername(colony.room.controller),
    gameTime
  });
  const scoutControllerId = getScoutValidationControllerId(scoutValidation);
  const controllerId = controller?.id ?? scoutControllerId ?? candidate.controllerId;
  const controllerEvaluation = {
    ...baseEvaluation,
    ...(typeof controllerId === 'string' ? { controllerId: controllerId as Id<StructureController> } : {})
  };
  recordTerritoryScoutValidation(
    colonyName,
    candidate.roomName,
    scoutValidation,
    gameTime,
    telemetryEvents,
    controllerEvaluation.controllerId,
    candidate.score
  );

  if (scoutValidation.status === 'pending') {
    ensureTerritoryScoutAttempt(
      colonyName,
      candidate.roomName,
      gameTime,
      telemetryEvents,
      controllerEvaluation.controllerId
    );
    return { ...controllerEvaluation, reason: 'scoutPending' };
  }

  if (scoutValidation.status === 'blocked') {
    return {
      ...controllerEvaluation,
      reason: getScoutValidationClaimSkipReason(scoutValidation)
    };
  }

  return {
    status: 'planned',
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...(typeof controllerId === 'string' ? { controllerId: controllerId as Id<StructureController> } : {})
  };
}

function getScoutValidationControllerId(
  validation: TerritoryScoutValidationResult
): Id<StructureController> | undefined {
  return validation.intel?.controller?.id;
}

function getScoutValidationClaimSkipReason(
  validation: TerritoryScoutValidationResult
): RuntimeTerritoryClaimTelemetryReason {
  switch (validation.reason) {
    case 'controllerMissing':
      return 'controllerMissing';
    case 'controllerOwned':
      return 'controllerOwned';
    case 'controllerReserved':
      return 'controllerReserved';
    case 'hostileSpawn':
      return 'hostilePresence';
    case 'sourcesMissing':
      return 'sourcesMissing';
    case 'intelMissing':
    case 'scoutPending':
    case 'scoutTimeout':
    default:
      return 'scoutPending';
  }
}

function buildAutonomousExpansionScoringInput(
  colony: ColonySnapshot,
  report: OccupationRecommendationReport,
  context: AutonomousExpansionClaimTickContext
): ExpansionScoringInput {
  const colonyName = colony.room.name;
  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomNames = getVisibleOwnedRoomNames(colonyName, colonyOwnerUsername);
  const adjacentRoomNamesByOwnedRoom = getAdjacentRoomNamesByOwnedRoom(ownedRoomNames, context);
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

function getAdjacentRoomNamesByOwnedRoom(
  ownedRoomNames: Set<string>,
  context: AutonomousExpansionClaimTickContext
): Map<string, Set<string>> {
  const adjacentRoomNamesByOwnedRoom = new Map<string, Set<string>>();
  for (const roomName of ownedRoomNames) {
    adjacentRoomNamesByOwnedRoom.set(roomName, getCachedAdjacentRoomNames(roomName, context));
  }

  return adjacentRoomNamesByOwnedRoom;
}

function getCachedAdjacentRoomNames(
  roomName: string,
  context: AutonomousExpansionClaimTickContext
): Set<string> {
  const cachedAdjacentRoomNames = context.adjacentRoomNamesByOwnedRoom.get(roomName);
  if (cachedAdjacentRoomNames) {
    return cachedAdjacentRoomNames;
  }

  const adjacentRoomNames = new Set(getAdjacentRoomNames(roomName, context.gameMap));
  context.adjacentRoomNamesByOwnedRoom.set(roomName, adjacentRoomNames);
  return adjacentRoomNames;
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

function getAdjacentRoomNames(
  roomName: string,
  gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map
): string[] {
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

function hasBlockingClaimIntentForRoom(
  targetRoom: string,
  intents: TerritoryIntentMemory[]
): boolean {
  return intents.some(
    (intent) =>
      intent.targetRoom === targetRoom &&
      intent.action === 'claim'
  );
}

function getTerritoryIntentsForAutonomousExpansionClaim(
  territoryMemory: TerritoryMemory,
  context: AutonomousExpansionClaimTickContext | undefined
): TerritoryIntentMemory[] {
  if (
    context &&
    context.territoryMemory === territoryMemory &&
    context.rawIntents === territoryMemory.intents
  ) {
    return context.territoryIntents;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  syncAutonomousExpansionClaimIntentContext(context, territoryMemory, intents);
  return intents;
}

function syncAutonomousExpansionClaimIntentContext(
  context: AutonomousExpansionClaimTickContext | undefined,
  territoryMemory: TerritoryMemory,
  intents: TerritoryIntentMemory[]
): void {
  if (!context) {
    return;
  }

  context.territoryMemory = territoryMemory;
  context.rawIntents = territoryMemory.intents;
  context.territoryIntents = intents;
}

function persistAutonomousExpansionClaimIntent(
  colony: string,
  evaluation: AutonomousExpansionClaimEvaluation,
  gameTime: number,
  context?: AutonomousExpansionClaimTickContext
): void {
  if (!evaluation.targetRoom) {
    return;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const cachedIntents = getTerritoryIntentsForAutonomousExpansionClaim(territoryMemory, context);
  if (hasBlockingClaimIntentForRoom(evaluation.targetRoom, cachedIntents)) {
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
  pruneAutonomousExpansionClaimTargets(colony, territoryMemory, target, context);
  upsertTerritoryTarget(territoryMemory, target);

  const intents = getTerritoryIntentsForAutonomousExpansionClaim(territoryMemory, context);
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
  syncAutonomousExpansionClaimIntentContext(context, territoryMemory, intents);
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
  activeTarget?: TerritoryTargetMemory,
  context?: AutonomousExpansionClaimTickContext
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

  const intents = getTerritoryIntentsForAutonomousExpansionClaim(territoryMemory, context).filter(
    (intent) =>
      intent.colony !== colony ||
      intent.createdBy !== AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR ||
      !removedTargetKeys.has(getTargetKey(intent.targetRoom, intent.action))
  );
  territoryMemory.intents = intents;
  syncAutonomousExpansionClaimIntentContext(context, territoryMemory, intents);
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

function isAutonomousClaimSuppressed(
  colony: string,
  targetRoom: string,
  gameTime: number,
  intents: TerritoryIntentMemory[]
): boolean {
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
