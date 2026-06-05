import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import {
  canCreepReserveTerritoryController,
  isVisibleTerritoryAssignmentSafe,
  suppressTerritoryIntent,
  TERRITORY_HOSTILE_INTENT_SUSPENSION_TICKS,
  TERRITORY_RESERVATION_RENEWAL_TICKS
} from './territoryPlanner';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';
import {
  EXPANSION_PLANNER_TARGET_CREATOR,
  getExpansionPlannerReservationRecommendations,
  type ExpansionPlannerReservationRecommendation
} from './expansionPlanner';
import {
  shouldSignReservedController,
  signReservedControllerIfNeeded
} from './controllerSigning';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_NO_BODYPART_CODE = -12 as ScreepsReturnCode;
const TERRITORY_ROUTE_DISTANCE_SEPARATOR = '>';

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;

interface ReservationExecutionAssignment extends CreepTerritoryMemory {
  action: 'reserve';
}

interface ReservationExecutionGate {
  intent: TerritoryIntentMemory | null;
  targetOnly: boolean;
}

interface ReservationSelection {
  assignment: ReservationExecutionAssignment;
  intent: TerritoryIntentMemory | null;
}

interface ScoredReservationSelection extends ReservationSelection {
  order: number;
  updatedAt?: number;
  routeDistance?: number;
  expansionRank?: number;
  expansionScore?: number;
  renewalTicksToEnd?: number;
}

interface ReservationTargetState {
  actionable: boolean;
  controllerId?: Id<StructureController>;
  renewalTicksToEnd?: number;
}

export function runReservationExecutor(creep: Creep): boolean {
  const assignment = creep.memory.territory;
  if (isReservationExecutionAssignment(assignment)) {
    const gate = getReservationExecutionGate(creep.memory.colony, assignment);
    if (!gate) {
      return false;
    }

    return runAssignedReservation(creep, assignment, gate);
  }

  if (assignment !== undefined) {
    return false;
  }

  const selection = selectReservationAssignment(creep);
  if (!selection) {
    return false;
  }

  creep.memory.territory = selection.assignment;
  return runAssignedReservation(creep, selection.assignment, {
    intent: selection.intent,
    targetOnly: selection.intent === null
  });
}

function runAssignedReservation(
  creep: Creep,
  assignment: ReservationExecutionAssignment,
  gate: ReservationExecutionGate
): boolean {
  const colony = creep.memory.colony;
  const gameTime = getGameTime();
  if (!isNonEmptyString(colony) || !isReservationExecutionGateRunnable(gate, gameTime)) {
    completeReservationAssignment(creep);
    return true;
  }

  const visibleController = selectCurrentOrVisibleReservationController(creep, assignment);
  const actorUsername = getReservationActorUsername(creep, colony);
  if (visibleController) {
    refreshVisibleReservationMemory(colony, assignment, visibleController, actorUsername, gameTime);
    if (isControllerOwnedByActor(visibleController, actorUsername)) {
      recordReservationIntentStatus(colony, assignment, 'completed', gameTime, visibleController.id);
      completeReservationAssignment(creep);
      return true;
    }

    const reservationTicksToEnd = getOwnReservationTicksToEnd(visibleController, actorUsername);
    if (
      reservationTicksToEnd !== null &&
      reservationTicksToEnd > TERRITORY_RESERVATION_RENEWAL_TICKS &&
      !shouldSignReservedController(visibleController, actorUsername)
    ) {
      recordReservationIntentStatus(colony, assignment, 'planned', gameTime, visibleController.id);
      completeReservationAssignment(creep);
      return true;
    }
  }

  if (!isVisibleTerritoryAssignmentSafe(assignment, colony, creep)) {
    suppressTerritoryIntent(colony, assignment, gameTime);
    completeReservationAssignment(creep);
    return true;
  }

  if (creep.room?.name !== assignment.targetRoom) {
    recordReservationIntentStatus(colony, assignment, 'active', gameTime, assignment.controllerId);
    moveTowardReservationTarget(creep, assignment);
    return true;
  }

  const controller = selectReservationController(creep, assignment);
  if (!controller) {
    suppressTerritoryIntent(colony, assignment, gameTime);
    completeReservationAssignment(creep);
    return true;
  }

  const reservationTicksToEnd = getOwnReservationTicksToEnd(controller, actorUsername);
  if (
    reservationTicksToEnd !== null &&
    reservationTicksToEnd > TERRITORY_RESERVATION_RENEWAL_TICKS &&
    shouldSignReservedController(controller, actorUsername)
  ) {
    const signingResult = signReservedControllerIfNeeded(creep, controller, actorUsername);
    if (signingResult === 'moving') {
      recordReservationIntentStatus(colony, assignment, 'active', gameTime, controller.id);
      return true;
    }

    recordReservationIntentStatus(colony, assignment, 'planned', gameTime, controller.id);
    completeReservationAssignment(creep);
    return true;
  }

  if (isControllerOwnedByActor(controller, actorUsername)) {
    recordReservationIntentStatus(colony, assignment, 'completed', gameTime, controller.id);
    completeReservationAssignment(creep);
    return true;
  }

  if (!canCreepReserveTerritoryController(creep, controller, colony)) {
    if (isControllerOwned(controller) || isForeignReservedController(controller, actorUsername)) {
      suppressTerritoryIntent(colony, assignment, gameTime);
    } else {
      recordReservationIntentStatus(colony, assignment, 'planned', gameTime, controller.id);
    }
    completeReservationAssignment(creep);
    return true;
  }

  if (typeof creep.reserveController !== 'function') {
    recordReservationIntentStatus(colony, assignment, 'planned', gameTime, controller.id);
    completeReservationAssignment(creep);
    return true;
  }

  recordReservationIntentStatus(colony, assignment, 'active', gameTime, controller.id);
  const result = creep.reserveController(controller);
  refreshVisibleReservationMemory(colony, assignment, controller, actorUsername, gameTime);

  if (result === ERR_NOT_IN_RANGE_CODE) {
    moveTowardController(creep, controller);
    return true;
  }

  if (result === OK_CODE) {
    return true;
  }

  if (result === ERR_NO_BODYPART_CODE) {
    recordReservationIntentStatus(colony, assignment, 'planned', gameTime, controller.id);
    completeReservationAssignment(creep);
    return true;
  }

  if (result === ERR_INVALID_TARGET_CODE) {
    suppressTerritoryIntent(colony, assignment, gameTime);
    completeReservationAssignment(creep);
  }

  return true;
}

function selectReservationAssignment(creep: Creep): ReservationSelection | null {
  if (!canAssignReservationCreep(creep)) {
    return null;
  }

  const colony = creep.memory.colony;
  if (!isNonEmptyString(colony) || !hasReservationEnergyBudget(colony)) {
    return null;
  }

  const territoryMemory = getTerritoryMemoryRecord();
  const recommendations = getExpansionPlannerReservationRecommendations(colony);
  if (!territoryMemory || recommendations.length === 0) {
    return null;
  }

  const activeReservationCounts = countActiveReservationAssignments(colony, creep.name);
  const selections = recommendations.flatMap((recommendation, order) => {
    const selection = buildReservationSelection(
      creep,
      territoryMemory,
      recommendation,
      order,
      activeReservationCounts
    );
    return selection ? [selection] : [];
  });

  return selections.sort(compareReservationSelections)[0] ?? null;
}

function buildReservationSelection(
  creep: Creep,
  territoryMemory: TerritoryMemory,
  recommendation: ExpansionPlannerReservationRecommendation,
  order: number,
  activeReservationCounts: Map<string, number>
): ScoredReservationSelection | null {
  const gameTime = getGameTime();
  const intent = getMatchingReservationIntent(
    recommendation.colony,
    recommendation.targetRoom,
    recommendation.controllerId
  );
  if (intent && isTerritoryIntentSuspensionActive(intent, gameTime)) {
    return null;
  }

  if ((activeReservationCounts.get(recommendation.targetRoom) ?? 0) >= 1) {
    return null;
  }

  const state = getReservationTargetState(creep, territoryMemory, recommendation, gameTime);
  if (!state.actionable) {
    return null;
  }

  const routeDistance = getReservationRouteDistance(territoryMemory, recommendation.colony, recommendation.targetRoom);
  if (routeDistance === null) {
    return null;
  }

  const priority = getExpansionCandidatePriority(
    territoryMemory,
    recommendation.colony,
    recommendation.targetRoom
  );
  const assignment: ReservationExecutionAssignment = {
    targetRoom: recommendation.targetRoom,
    action: 'reserve',
    ...(state.controllerId ?? recommendation.controllerId
      ? { controllerId: (state.controllerId ?? recommendation.controllerId) as Id<StructureController> }
      : {})
  };

  return {
    assignment,
    intent,
    order,
    updatedAt: recommendation.updatedAt,
    ...(routeDistance !== undefined ? { routeDistance } : {}),
    ...(priority.rank !== undefined ? { expansionRank: priority.rank } : {}),
    ...(priority.score !== undefined ? { expansionScore: priority.score } : {}),
    ...(state.renewalTicksToEnd !== undefined ? { renewalTicksToEnd: state.renewalTicksToEnd } : {})
  };
}

function getReservationTargetState(
  creep: Creep,
  territoryMemory: TerritoryMemory,
  recommendation: ExpansionPlannerReservationRecommendation,
  gameTime: number
): ReservationTargetState {
  const actorUsername = getReservationActorUsername(creep, recommendation.colony);
  const controller = selectVisibleReservationController(recommendation.targetRoom, recommendation.controllerId);
  if (controller) {
    refreshVisibleReservationMemory(
      recommendation.colony,
      {
        targetRoom: recommendation.targetRoom,
        action: 'reserve',
        ...(recommendation.controllerId ? { controllerId: recommendation.controllerId } : {})
      },
      controller,
      actorUsername,
      gameTime
    );

    if (isControllerOwned(controller) || isForeignReservedController(controller, actorUsername)) {
      return { actionable: false, controllerId: controller.id };
    }

    const reservationTicksToEnd = getOwnReservationTicksToEnd(controller, actorUsername);
    if (reservationTicksToEnd !== null) {
      return {
        actionable:
          reservationTicksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS ||
          shouldSignReservedController(controller, actorUsername),
        controllerId: controller.id,
        renewalTicksToEnd: reservationTicksToEnd
      };
    }

    return { actionable: true, controllerId: controller.id };
  }

  const storedReservation = getStoredTerritoryReservation(
    territoryMemory,
    recommendation.colony,
    recommendation.targetRoom,
    recommendation.controllerId
  );
  if (!storedReservation) {
    return { actionable: true };
  }

  const estimatedTicksToEnd = getEstimatedTerritoryReservationTicksToEnd(storedReservation, gameTime);
  return {
    actionable: estimatedTicksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS,
    renewalTicksToEnd: estimatedTicksToEnd,
    ...(storedReservation.controllerId ? { controllerId: storedReservation.controllerId } : {})
  };
}

function compareReservationSelections(
  left: ScoredReservationSelection,
  right: ScoredReservationSelection
): number {
  return (
    getReservationRenewalPriority(left) - getReservationRenewalPriority(right) ||
    compareOptionalNumbers(left.renewalTicksToEnd, right.renewalTicksToEnd) ||
    compareOptionalNumbers(left.expansionRank, right.expansionRank) ||
    compareOptionalNumbers(left.routeDistance, right.routeDistance) ||
    compareOptionalNumbersDescending(left.expansionScore, right.expansionScore) ||
    compareOptionalNumbers(left.updatedAt, right.updatedAt) ||
    left.order - right.order ||
    left.assignment.targetRoom.localeCompare(right.assignment.targetRoom)
  );
}

function getReservationRenewalPriority(selection: ScoredReservationSelection): number {
  return selection.renewalTicksToEnd !== undefined ? 0 : 1;
}

function getReservationExecutionGate(
  colony: string | undefined,
  assignment: ReservationExecutionAssignment
): ReservationExecutionGate | null {
  if (!isNonEmptyString(colony)) {
    return null;
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const targetOnly = hasMatchingExpansionPlannerReservationTarget(
    territoryMemory,
    colony,
    assignment.targetRoom,
    assignment.controllerId
  );
  const intent = getMatchingReservationIntent(
    colony,
    assignment.targetRoom,
    assignment.controllerId,
    targetOnly
  );
  if (intent) {
    return { intent, targetOnly: false };
  }

  return targetOnly ? { intent: null, targetOnly: true } : null;
}

function isReservationExecutionGateRunnable(gate: ReservationExecutionGate, gameTime: number): boolean {
  if (!gate.intent) {
    return gate.targetOnly;
  }

  if (gate.intent.status !== 'planned' && gate.intent.status !== 'active') {
    return false;
  }

  return !isTerritoryIntentSuspensionActive(gate.intent, gameTime);
}

function getMatchingReservationIntent(
  colony: string,
  targetRoom: string,
  controllerId?: Id<StructureController>,
  allowUnscopedIntent = false
): TerritoryIntentMemory | null {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  return (
    normalizeTerritoryIntents(territoryMemory.intents).find((intent) =>
      isMatchingExpansionPlannerReservationIntent(intent, colony, targetRoom, controllerId, allowUnscopedIntent)
    ) ?? null
  );
}

function recordReservationIntentStatus(
  colony: string,
  assignment: ReservationExecutionAssignment,
  status: Extract<TerritoryIntentMemory['status'], 'planned' | 'active' | 'completed'>,
  gameTime: number,
  controllerId?: Id<StructureController>
): void {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const allowUnscopedIntent = hasMatchingExpansionPlannerReservationTarget(
    territoryMemory,
    colony,
    assignment.targetRoom,
    assignment.controllerId
  );
  let matchedIntent = false;
  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];
    if (
      !isMatchingExpansionPlannerReservationIntent(
        intent,
        colony,
        assignment.targetRoom,
        assignment.controllerId,
        allowUnscopedIntent
      )
    ) {
      continue;
    }

    matchedIntent = true;
    intents[index] = {
      ...intent,
      status,
      updatedAt: gameTime,
      ...(controllerId ?? assignment.controllerId
        ? { controllerId: (controllerId ?? assignment.controllerId) as Id<StructureController> }
        : {})
    };
  }

  if (!matchedIntent && (allowUnscopedIntent || status === 'active')) {
    intents.push({
      colony,
      targetRoom: assignment.targetRoom,
      action: 'reserve',
      status,
      updatedAt: gameTime,
      createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
      ...(controllerId ?? assignment.controllerId
        ? { controllerId: (controllerId ?? assignment.controllerId) as Id<StructureController> }
        : {})
    });
  }
}

function refreshVisibleReservationMemory(
  colony: string,
  assignment: Pick<ReservationExecutionAssignment, 'targetRoom' | 'action' | 'controllerId'>,
  controller: StructureController,
  actorUsername: string | undefined,
  gameTime: number
): void {
  const reservationTicksToEnd = getOwnReservationTicksToEnd(controller, actorUsername);
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const reservationKey = getTerritoryReservationMemoryKey(colony, assignment.targetRoom);
  const reservations = normalizeTerritoryReservations(territoryMemory.reservations);
  if (reservationTicksToEnd === null) {
    if (reservations[reservationKey]) {
      delete reservations[reservationKey];
      setTerritoryReservations(territoryMemory, reservations);
    }
    return;
  }

  reservations[reservationKey] = {
    colony,
    roomName: assignment.targetRoom,
    ticksToEnd: reservationTicksToEnd,
    updatedAt: gameTime,
    ...(controller.id
      ? { controllerId: controller.id }
      : assignment.controllerId
        ? { controllerId: assignment.controllerId }
        : {})
  };
  setTerritoryReservations(territoryMemory, reservations);
}

function getStoredTerritoryReservation(
  territoryMemory: TerritoryMemory,
  colony: string,
  targetRoom: string,
  controllerId?: Id<StructureController>
): TerritoryReservationMemory | null {
  const reservation = normalizeTerritoryReservation(
    isRecord(territoryMemory.reservations)
      ? territoryMemory.reservations[getTerritoryReservationMemoryKey(colony, targetRoom)]
      : undefined
  );
  if (
    !reservation ||
    reservation.colony !== colony ||
    reservation.roomName !== targetRoom ||
    (controllerId !== undefined &&
      reservation.controllerId !== undefined &&
      reservation.controllerId !== controllerId)
  ) {
    return null;
  }

  return reservation;
}

function normalizeTerritoryReservations(rawReservations: unknown): Record<string, TerritoryReservationMemory> {
  if (!isRecord(rawReservations)) {
    return {};
  }

  const reservations: Record<string, TerritoryReservationMemory> = {};
  for (const [key, rawReservation] of Object.entries(rawReservations)) {
    const reservation = normalizeTerritoryReservation(rawReservation);
    if (reservation) {
      reservations[key] = reservation;
    }
  }

  return reservations;
}

function normalizeTerritoryReservation(rawReservation: unknown): TerritoryReservationMemory | null {
  if (!isRecord(rawReservation)) {
    return null;
  }

  if (
    !isNonEmptyString(rawReservation.colony) ||
    !isNonEmptyString(rawReservation.roomName) ||
    !isFiniteNumber(rawReservation.ticksToEnd) ||
    !isFiniteNumber(rawReservation.updatedAt)
  ) {
    return null;
  }

  return {
    colony: rawReservation.colony,
    roomName: rawReservation.roomName,
    ticksToEnd: Math.floor(Math.max(0, rawReservation.ticksToEnd)),
    updatedAt: Math.floor(rawReservation.updatedAt),
    ...(typeof rawReservation.controllerId === 'string'
      ? { controllerId: rawReservation.controllerId as Id<StructureController> }
      : {})
  };
}

function setTerritoryReservations(
  territoryMemory: TerritoryMemory,
  reservations: Record<string, TerritoryReservationMemory>
): void {
  if (Object.keys(reservations).length > 0) {
    territoryMemory.reservations = reservations;
  } else {
    delete territoryMemory.reservations;
  }
}

function getExpansionCandidatePriority(
  territoryMemory: TerritoryMemory,
  colony: string,
  targetRoom: string
): { rank?: number; score?: number } {
  if (!Array.isArray(territoryMemory.expansionCandidates)) {
    return {};
  }

  const candidate = territoryMemory.expansionCandidates.find(
    (rawCandidate) =>
      rawCandidate.colony === colony &&
      rawCandidate.roomName === targetRoom &&
      rawCandidate.evidenceStatus !== 'unavailable'
  );
  if (!candidate) {
    return {};
  }

  return {
    ...(isPositiveFiniteNumber(candidate.rank) ? { rank: Math.floor(candidate.rank) } : {}),
    ...(isFiniteNumber(candidate.score) ? { score: candidate.score } : {})
  };
}

function getReservationRouteDistance(
  territoryMemory: TerritoryMemory,
  colony: string,
  targetRoom: string
): number | null | undefined {
  if (colony === targetRoom) {
    return 0;
  }

  const routeKey = `${colony}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`;
  const cachedDistance = isRecord(territoryMemory.routeDistances)
    ? territoryMemory.routeDistances[routeKey]
    : undefined;
  if (typeof cachedDistance === 'number' || cachedDistance === null) {
    return cachedDistance;
  }

  const route = (globalThis as { Game?: Partial<Game> }).Game?.map?.findRoute?.(colony, targetRoom);
  if (Array.isArray(route)) {
    return route.length;
  }

  return undefined;
}

function countActiveReservationAssignments(
  colony: string,
  excludedCreepName: string | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  const creeps = (globalThis as { Game?: Partial<Game> }).Game?.creeps;
  if (!creeps) {
    return counts;
  }

  for (const creep of Object.values(creeps)) {
    if (
      creep.name === excludedCreepName ||
      creep.memory?.colony !== colony ||
      creep.memory.role !== 'claimer' ||
      !isReservationExecutionAssignment(creep.memory.territory) ||
      !canAssignReservationCreep(creep)
    ) {
      continue;
    }

    const targetRoom = creep.memory.territory.targetRoom;
    counts.set(targetRoom, (counts.get(targetRoom) ?? 0) + 1);
  }

  return counts;
}

function canAssignReservationCreep(creep: Creep): boolean {
  return (
    creep.memory?.role === 'claimer' &&
    getActiveClaimPartCount(creep) > 0 &&
    (creep.ticksToLive === undefined || creep.ticksToLive > 100)
  );
}

function hasReservationEnergyBudget(colony: string): boolean {
  const room = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[colony];
  if (!room) {
    return true;
  }

  const energyAvailable = normalizeNonNegativeInteger(room.energyAvailable);
  const energyCapacityAvailable = normalizeNonNegativeInteger(room.energyCapacityAvailable);
  return (
    energyAvailable >= TERRITORY_CONTROLLER_BODY_COST &&
    energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST
  );
}

function selectCurrentOrVisibleReservationController(
  creep: Creep,
  assignment: ReservationExecutionAssignment
): StructureController | null {
  if (creep.room?.name === assignment.targetRoom && creep.room.controller) {
    return creep.room.controller;
  }

  return selectVisibleReservationController(assignment.targetRoom, assignment.controllerId);
}

function selectReservationController(
  creep: Creep,
  assignment: ReservationExecutionAssignment
): StructureController | null {
  if (assignment.controllerId) {
    const game = (globalThis as { Game?: Partial<Game> }).Game;
    if (typeof game?.getObjectById === 'function') {
      const controller = game.getObjectById.call(game, assignment.controllerId) as StructureController | null;
      if (controller) {
        return controller;
      }
    }
  }

  return creep.room?.controller ?? selectVisibleReservationController(assignment.targetRoom, assignment.controllerId);
}

function selectVisibleReservationController(
  targetRoom: string,
  controllerId?: Id<StructureController>
): StructureController | null {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  if (controllerId && typeof game?.getObjectById === 'function') {
    const controller = game.getObjectById.call(game, controllerId) as StructureController | null;
    if (controller) {
      return controller;
    }
  }

  return game?.rooms?.[targetRoom]?.controller ?? null;
}

function moveTowardReservationTarget(creep: Creep, assignment: ReservationExecutionAssignment): void {
  const visibleController = selectVisibleReservationController(assignment.targetRoom, assignment.controllerId);
  if (visibleController) {
    moveTowardController(creep, visibleController);
    return;
  }

  if (typeof creep.moveTo !== 'function') {
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
  if (typeof RoomPositionCtor === 'function') {
    creep.moveTo(new RoomPositionCtor(25, 25, assignment.targetRoom));
  }
}

function moveTowardController(creep: Creep, controller: StructureController): void {
  if (typeof creep.moveTo === 'function') {
    creep.moveTo(controller);
  }
}

function isMatchingExpansionPlannerReservationIntent(
  intent: TerritoryIntentMemory,
  colony: string,
  targetRoom: string,
  controllerId?: Id<StructureController>,
  allowUnscopedIntent = false
): boolean {
  return (
    intent.colony === colony &&
    intent.targetRoom === targetRoom &&
    intent.action === 'reserve' &&
    (intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR ||
      (allowUnscopedIntent && intent.createdBy === undefined)) &&
    (!controllerId || !intent.controllerId || intent.controllerId === controllerId)
  );
}

function hasMatchingExpansionPlannerReservationTarget(
  territoryMemory: TerritoryMemory,
  colony: string,
  targetRoom: string,
  controllerId?: Id<StructureController>
): boolean {
  return Array.isArray(territoryMemory.targets)
    ? territoryMemory.targets.some(
        (target) =>
          isRecord(target) &&
          target.colony === colony &&
          target.roomName === targetRoom &&
          target.action === 'reserve' &&
          target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
          target.enabled !== false &&
          (!controllerId || !isNonEmptyString(target.controllerId) || target.controllerId === controllerId)
      )
    : false;
}

function isReservationExecutionAssignment(
  assignment: CreepTerritoryMemory | undefined
): assignment is ReservationExecutionAssignment {
  return isNonEmptyString(assignment?.targetRoom) && assignment.action === 'reserve';
}

function isTerritoryIntentSuspensionActive(intent: TerritoryIntentMemory, gameTime: number): boolean {
  if (!intent.suspended) {
    return false;
  }

  if (intent.suspended.reason === 'owner_reserve_only') {
    return intent.action === 'claim';
  }

  return gameTime - intent.suspended.updatedAt <= TERRITORY_HOSTILE_INTENT_SUSPENSION_TICKS;
}

function isControllerOwned(controller: StructureController): boolean {
  return controller.my === true || isNonEmptyString(getControllerOwnerUsername(controller));
}

function isControllerOwnedByActor(controller: StructureController, actorUsername: string | undefined): boolean {
  return (
    controller.my === true ||
    (isNonEmptyString(actorUsername) && getControllerOwnerUsername(controller) === actorUsername)
  );
}

function isForeignReservedController(
  controller: StructureController,
  actorUsername: string | undefined
): boolean {
  const reservationUsername = controller.reservation?.username;
  return isNonEmptyString(reservationUsername) && reservationUsername !== actorUsername;
}

function getOwnReservationTicksToEnd(
  controller: StructureController,
  actorUsername: string | undefined
): number | null {
  const reservation = controller.reservation;
  if (
    !isNonEmptyString(actorUsername) ||
    !isNonEmptyString(reservation?.username) ||
    reservation.username !== actorUsername ||
    !isFiniteNumber(reservation.ticksToEnd)
  ) {
    return null;
  }

  return Math.floor(Math.max(0, reservation.ticksToEnd));
}

function getReservationActorUsername(creep: Creep, colony: string): string | undefined {
  const creepOwner = (creep as Creep & { owner?: { username?: string } }).owner?.username;
  if (isNonEmptyString(creepOwner)) {
    return creepOwner;
  }

  return getControllerOwnerUsername((globalThis as { Game?: Partial<Game> }).Game?.rooms?.[colony]?.controller);
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = controller?.owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getActiveClaimPartCount(creep: Creep): number {
  const claimPart = getBodyPartConstant('CLAIM', 'claim');
  const activeClaimParts = creep.getActiveBodyparts?.(claimPart);
  if (typeof activeClaimParts === 'number') {
    return Math.max(0, Math.floor(activeClaimParts));
  }

  return Array.isArray(creep.body) ? creep.body.filter((part) => isActiveBodyPart(part, claimPart)).length : 0;
}

function isActiveBodyPart(part: unknown, bodyPartType: BodyPartConstant): boolean {
  if (!isRecord(part)) {
    return false;
  }

  return part.type === bodyPartType && typeof part.hits === 'number' && part.hits > 0;
}

function getBodyPartConstant(globalName: 'CLAIM', fallback: BodyPartConstant): BodyPartConstant {
  const constants = globalThis as unknown as Partial<Record<'CLAIM', BodyPartConstant>>;
  return constants[globalName] ?? fallback;
}

function getTerritoryReservationMemoryKey(colony: string, targetRoom: string): string {
  return `${colony}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`;
}

function getEstimatedTerritoryReservationTicksToEnd(
  reservation: TerritoryReservationMemory,
  gameTime: number
): number {
  return Math.max(0, reservation.ticksToEnd - Math.max(0, gameTime - reservation.updatedAt));
}

function completeReservationAssignment(creep: Creep): void {
  delete creep.memory.territory;
}

function getTerritoryMemoryRecord(): TerritoryMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!memory.territory) {
    memory.territory = {};
  }

  return memory.territory;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function compareOptionalNumbersDescending(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) {
    return 0;
  }

  if (left === undefined) {
    return 1;
  }

  if (right === undefined) {
    return -1;
  }

  return right - left;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
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
