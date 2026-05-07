import type { ColonySnapshot } from '../colony/colonyRegistry';
import { maxRoomsForRcl } from './expansionScoring';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export const EXPANSION_PLANNER_MIN_SOURCE_COUNT = 2;
export const EXPANSION_PLANNER_MAX_ROUTE_DISTANCE = 2;

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'];
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const SOURCE_SCORE_WEIGHT = 1_000;
const DISTANCE_SCORE_WEIGHT = 100;
export const EXPANSION_PLANNER_TARGET_CREATOR = 'expansionPlanner';

type TerminalExpansionIntentStatus = Extract<TerritoryIntentMemory['status'], 'inactive' | 'completed'>;

export type ExpansionRoomUnsuitableReason =
  | 'sourceCountBelowMinimum'
  | 'hostilePresence'
  | 'controllerMissing'
  | 'controllerOwned'
  | 'controllerReserved';

export type ExpansionPlannerSkipReason = 'existingTerritoryPlan' | 'memoryUnavailable' | 'noCandidate';

export interface ExpansionRoomSuitability {
  suitable: boolean;
  sourceCount: number;
  hostileCreepCount: number;
  hostileStructureCount: number;
  reasons: ExpansionRoomUnsuitableReason[];
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
}

export interface ExpansionPlannerCandidateInput {
  colony: string;
  roomName: string;
  distance: number;
  sourceCount: number;
  order?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
}

export interface ExpansionPlannerCandidate extends ExpansionRoomSuitability {
  colony: string;
  roomName: string;
  distance: number;
  order: number;
  score: number;
}

export interface ExpansionPlannerIntent {
  colony: string;
  targetRoom: string;
  action: TerritoryControlAction;
  score: number;
  controllerId?: Id<StructureController>;
}

export interface ExpansionPlannerEvaluation {
  status: 'planned' | 'skipped';
  colony: string;
  candidates: ExpansionPlannerCandidate[];
  reason?: ExpansionPlannerSkipReason;
  targetRoom?: string;
  action?: TerritoryControlAction;
  score?: number;
  controllerId?: Id<StructureController>;
}

export interface ExpansionPlannerClaimRecommendation {
  colony: string;
  targetRoom: string;
  action: 'claim';
  createdBy: typeof EXPANSION_PLANNER_TARGET_CREATOR;
  status: Extract<TerritoryIntentMemory['status'], 'planned' | 'active'>;
  updatedAt?: number;
  controllerId?: Id<StructureController>;
}

interface ExpansionReservationUpgradeContext {
  colony: string;
  targetRoom: string;
  action: TerritoryControlAction;
}

export function evaluateExpansionRoomSuitability(
  room: Room,
  colonyOwnerUsername?: string
): ExpansionRoomSuitability {
  const ownerUsername = getControllerOwnerUsername(room.controller);
  const reservationUsername = getControllerReservationUsername(room.controller);
  return evaluateExpansionSuitability({
    sourceCount: findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES')).length,
    hostileCreepCount: findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length,
    hostileStructureCount: findRoomObjects<AnyStructure>(
      room,
      getFindConstant('FIND_HOSTILE_STRUCTURES')
    ).length,
    ...(room.controller?.id ? { controllerId: room.controller.id } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    ...(colonyOwnerUsername ? { colonyOwnerUsername } : {}),
    hasController: room.controller !== undefined
  });
}

export function evaluateExpansionCandidate(
  candidate: ExpansionPlannerCandidateInput
): ExpansionPlannerCandidate {
  const suitability = evaluateExpansionSuitability({
    sourceCount: candidate.sourceCount,
    hostileCreepCount: candidate.hostileCreepCount ?? 0,
    hostileStructureCount: candidate.hostileStructureCount ?? 0,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {}),
    ...(candidate.ownerUsername ? { ownerUsername: candidate.ownerUsername } : {}),
    ...(candidate.reservationUsername ? { reservationUsername: candidate.reservationUsername } : {}),
    hasController:
      candidate.controllerId !== undefined ||
      candidate.ownerUsername !== undefined ||
      candidate.reservationUsername !== undefined
  });
  const order = normalizeNonNegativeInteger(candidate.order ?? 0);
  const distance = Math.max(1, normalizeNonNegativeInteger(candidate.distance));

  return {
    colony: candidate.colony,
    roomName: candidate.roomName,
    distance,
    order,
    score: scoreExpansionPlannerCandidate(suitability.sourceCount, distance),
    ...suitability
  };
}

export function prioritizeExpansionCandidates(
  candidates: ExpansionPlannerCandidateInput[]
): ExpansionPlannerCandidate[] {
  return candidates
    .map(evaluateExpansionCandidate)
    .filter((candidate) => candidate.suitable)
    .sort(compareExpansionPlannerCandidates);
}

export function buildRuntimeExpansionPlannerCandidates(
  colony: ColonySnapshot
): ExpansionPlannerCandidate[] {
  const colonyName = colony.room.name;
  const rooms = getGameRooms();
  if (!rooms) {
    return [];
  }

  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomNames = getVisibleOwnedRoomNames(colonyName, ownerUsername);
  const candidates: ExpansionPlannerCandidate[] = [];
  const seenRooms = new Set<string>();
  let order = 0;

  for (const ownedRoomName of ownedRoomNames) {
    for (const adjacentRoomName of getAdjacentRoomNames(ownedRoomName)) {
      if (seenRooms.has(adjacentRoomName) || ownedRoomNames.has(adjacentRoomName)) {
        continue;
      }

      seenRooms.add(adjacentRoomName);
      const room = rooms[adjacentRoomName];
      if (!room) {
        continue;
      }

      candidates.push(toRuntimeExpansionPlannerCandidate(colonyName, room, 1, order, ownerUsername));
      order += 1;
    }
  }

  for (const room of Object.values(rooms)) {
    if (
      !room ||
      !isNonEmptyString(room.name) ||
      room.name === colonyName ||
      ownedRoomNames.has(room.name) ||
      seenRooms.has(room.name)
    ) {
      continue;
    }

    const distance = getNearestOwnedRoomDistance(ownedRoomNames, room.name);
    if (distance === null || distance > EXPANSION_PLANNER_MAX_ROUTE_DISTANCE) {
      continue;
    }

    seenRooms.add(room.name);
    candidates.push(toRuntimeExpansionPlannerCandidate(colonyName, room, distance, order, ownerUsername));
    order += 1;
  }

  return candidates
    .filter((candidate) => candidate.suitable)
    .sort(compareExpansionPlannerCandidates);
}

export function refreshExpansionPlannerIntent(
  colony: ColonySnapshot,
  gameTime = getGameTime()
): ExpansionPlannerEvaluation {
  const colonyName = colony.room.name;
  if (!getMemoryRecord()) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'memoryUnavailable',
      candidates: []
    };
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (territoryMemory) {
    refreshTerminalExpansionPlans(territoryMemory, colonyName, gameTime);
  }

  const potentialReservationUpgradeRooms = territoryMemory
    ? getPotentialExpansionReservationUpgradeRooms(territoryMemory, colonyName)
    : new Set<string>();
  if (potentialReservationUpgradeRooms === null) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'existingTerritoryPlan',
      candidates: []
    };
  }

  const candidates = buildRuntimeExpansionPlannerCandidates(colony);
  const selectedAction = candidates.length > 0 ? selectExpansionIntentAction(colony) : null;
  const preferredUpgradeCandidates =
    selectedAction === 'claim' && potentialReservationUpgradeRooms.size > 0
      ? candidates.filter((candidate) => potentialReservationUpgradeRooms.has(candidate.roomName))
      : [];
  const candidate =
    preferredUpgradeCandidates.length > 0 ? preferredUpgradeCandidates[0] : candidates[0];
  const action = candidate ? selectedAction : null;
  const reservationUpgrade = candidate && action ? getExpansionReservationUpgradeContext(candidate, action) : null;

  if (territoryMemory && hasBlockingTerritoryPlan(territoryMemory, colonyName, reservationUpgrade)) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'existingTerritoryPlan',
      candidates: []
    };
  }

  if (!candidate || !action) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'noCandidate',
      candidates
    };
  }

  const intent = createExpansionIntent(candidate, action, gameTime);
  if (!intent) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'memoryUnavailable',
      candidates
    };
  }

  return {
    status: 'planned',
    colony: colonyName,
    candidates,
    targetRoom: intent.targetRoom,
    action: intent.action,
    score: intent.score,
    ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
  };
}

export function getExpansionPlannerClaimRecommendations(
  colony?: string
): ExpansionPlannerClaimRecommendation[] {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return [];
  }

  const recommendations = new Map<string, ExpansionPlannerClaimRecommendation>();
  const blockedKeys = new Set<string>();
  for (const intent of normalizeTerritoryIntents(territoryMemory.intents)) {
    if (!isExpansionPlannerClaimIntentForColony(intent, colony)) {
      continue;
    }

    const key = getExpansionPlanKey(intent.colony, intent.targetRoom, 'claim');
    if (!isRunnableExpansionPlannerClaimStatus(intent.status)) {
      blockedKeys.add(key);
      recommendations.delete(key);
      continue;
    }

    recommendations.set(key, {
      colony: intent.colony,
      targetRoom: intent.targetRoom,
      action: 'claim',
      createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
      status: intent.status,
      updatedAt: intent.updatedAt,
      ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
    });
  }

  if (Array.isArray(territoryMemory.targets)) {
    for (const rawTarget of territoryMemory.targets) {
      const target = normalizeTerritoryTarget(rawTarget);
      if (!isExpansionPlannerClaimTargetForColony(target, colony)) {
        continue;
      }

      const key = getExpansionPlanKey(target.colony, target.roomName, 'claim');
      if (blockedKeys.has(key) || recommendations.has(key)) {
        continue;
      }

      recommendations.set(key, {
        colony: target.colony,
        targetRoom: target.roomName,
        action: 'claim',
        createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
        status: 'planned',
        ...(target.controllerId ? { controllerId: target.controllerId } : {})
      });
    }
  }

  return Array.from(recommendations.values()).sort(compareExpansionPlannerClaimRecommendations);
}

export function createExpansionIntent(
  candidate: ExpansionPlannerCandidate,
  action: TerritoryControlAction,
  gameTime = getGameTime()
): ExpansionPlannerIntent | null {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = findExpansionIntent(intents, candidate.colony, candidate.roomName, action);
  const existingTarget = findExpansionTarget(territoryMemory, candidate.colony, candidate.roomName, action);
  const terminalStatus = getCandidateTerminalExpansionStatus(candidate, action, existingIntent);
  if (terminalStatus && (existingIntent || existingTarget)) {
    persistTerminalExpansionPlan(
      territoryMemory,
      intents,
      {
        colony: candidate.colony,
        roomName: candidate.roomName,
        action,
        createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
        ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
      },
      terminalStatus,
      gameTime
    );
    return null;
  }

  if (!candidate.suitable) {
    return null;
  }

  if (action === 'claim') {
    removeSupersededExpansionReservationPlan(territoryMemory, intents, candidate.colony, candidate.roomName);
  }

  const target: TerritoryTargetMemory = {
    colony: candidate.colony,
    roomName: candidate.roomName,
    action,
    createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
  upsertTerritoryTarget(territoryMemory, target);

  upsertTerritoryIntent(intents, {
    colony: candidate.colony,
    targetRoom: candidate.roomName,
    action,
    status: existingIntent?.status === 'active' ? 'active' : 'planned',
    updatedAt: gameTime,
    createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  });

  return {
    colony: candidate.colony,
    targetRoom: candidate.roomName,
    action,
    score: candidate.score,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
}

function evaluateExpansionSuitability({
  sourceCount,
  hostileCreepCount,
  hostileStructureCount,
  controllerId,
  ownerUsername,
  reservationUsername,
  colonyOwnerUsername,
  hasController
}: {
  sourceCount: number;
  hostileCreepCount: number;
  hostileStructureCount: number;
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
  colonyOwnerUsername?: string;
  hasController: boolean;
}): ExpansionRoomSuitability {
  const normalizedSourceCount = normalizeNonNegativeInteger(sourceCount);
  const normalizedHostileCreepCount = normalizeNonNegativeInteger(hostileCreepCount);
  const normalizedHostileStructureCount = normalizeNonNegativeInteger(hostileStructureCount);
  const reasons: ExpansionRoomUnsuitableReason[] = [];

  if (normalizedSourceCount < EXPANSION_PLANNER_MIN_SOURCE_COUNT) {
    reasons.push('sourceCountBelowMinimum');
  }

  if (normalizedHostileCreepCount > 0 || normalizedHostileStructureCount > 0) {
    reasons.push('hostilePresence');
  }

  if (!hasController) {
    reasons.push('controllerMissing');
  } else if (isNonEmptyString(ownerUsername)) {
    reasons.push('controllerOwned');
  } else if (
    isNonEmptyString(reservationUsername) &&
    (!isNonEmptyString(colonyOwnerUsername) || reservationUsername !== colonyOwnerUsername)
  ) {
    reasons.push('controllerReserved');
  }

  return {
    suitable: reasons.length === 0,
    sourceCount: normalizedSourceCount,
    hostileCreepCount: normalizedHostileCreepCount,
    hostileStructureCount: normalizedHostileStructureCount,
    reasons,
    ...(controllerId ? { controllerId } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {})
  };
}

function toRuntimeExpansionPlannerCandidate(
  colony: string,
  room: Room,
  distance: number,
  order: number,
  colonyOwnerUsername: string | undefined
): ExpansionPlannerCandidate {
  const suitability = evaluateExpansionRoomSuitability(room, colonyOwnerUsername);
  const normalizedDistance = Math.max(1, normalizeNonNegativeInteger(distance));
  return {
    colony,
    roomName: room.name,
    distance: normalizedDistance,
    order,
    score: scoreExpansionPlannerCandidate(suitability.sourceCount, normalizedDistance),
    ...suitability
  };
}

function compareExpansionPlannerCandidates(
  left: ExpansionPlannerCandidate,
  right: ExpansionPlannerCandidate
): number {
  return (
    right.sourceCount - left.sourceCount ||
    left.distance - right.distance ||
    right.score - left.score ||
    left.order - right.order ||
    left.roomName.localeCompare(right.roomName)
  );
}

function scoreExpansionPlannerCandidate(sourceCount: number, distance: number): number {
  return sourceCount * SOURCE_SCORE_WEIGHT - distance * DISTANCE_SCORE_WEIGHT;
}

function selectExpansionIntentAction(colony: ColonySnapshot): TerritoryControlAction {
  const gclLevel = getGclLevel();
  if (gclLevel === null) {
    return 'reserve';
  }

  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomCount = getVisibleOwnedRoomNames(colony.room.name, ownerUsername).size;
  if (ownedRoomCount >= gclLevel) {
    return 'reserve';
  }

  if (ownedRoomCount >= maxRoomsForRcl(colony.room.controller?.level)) {
    return 'reserve';
  }

  return 'claim';
}

function refreshTerminalExpansionPlans(
  territoryMemory: TerritoryMemory,
  colony: string,
  gameTime: number
): void {
  const ownerUsername = getVisibleColonyOwnerUsername(colony);
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const refreshedPlans = new Set<string>();
  let changed = false;

  for (const rawTarget of Array.isArray(territoryMemory.targets) ? territoryMemory.targets : []) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.colony !== colony ||
      target.roomName === colony ||
      target.enabled === false ||
      target.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR ||
      !isExpansionControlAction(target.action)
    ) {
      continue;
    }

    const existingIntent = findExpansionIntent(intents, target.colony, target.roomName, target.action);
    const terminalStatus =
      getTerminalIntentStatus(existingIntent) ?? getVisibleExpansionTargetTerminalStatus(target, ownerUsername);
    if (!terminalStatus) {
      continue;
    }

    persistTerminalExpansionPlan(territoryMemory, intents, target, terminalStatus, gameTime);
    refreshedPlans.add(getExpansionPlanKey(target.colony, target.roomName, target.action));
    changed = true;
  }

  for (const intent of intents) {
    if (
      intent.colony !== colony ||
      intent.targetRoom === colony ||
      !isExpansionControlAction(intent.action) ||
      intent.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR
    ) {
      continue;
    }

    const planKey = getExpansionPlanKey(intent.colony, intent.targetRoom, intent.action);
    if (refreshedPlans.has(planKey)) {
      continue;
    }

    const target: TerritoryTargetMemory = {
      colony: intent.colony,
      roomName: intent.targetRoom,
      action: intent.action,
      createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
      ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
    };
    const terminalStatus =
      getTerminalIntentStatus(intent) ?? getVisibleExpansionTargetTerminalStatus(target, ownerUsername);
    if (!terminalStatus) {
      continue;
    }

    persistTerminalExpansionPlan(territoryMemory, intents, target, terminalStatus, gameTime);
    changed = true;
  }

  if (changed) {
    territoryMemory.intents = intents;
  }
}

function getPotentialExpansionReservationUpgradeRooms(
  territoryMemory: TerritoryMemory,
  colony: string
): Set<string> | null {
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const roomNames = new Set<string>();

  for (const intent of intents) {
    if (
      intent.colony !== colony ||
      intent.targetRoom === colony ||
      (intent.action !== 'claim' && intent.action !== 'reserve' && intent.action !== 'scout') ||
      (intent.status !== 'planned' && intent.status !== 'active')
    ) {
      continue;
    }

    if (isPotentialExpansionReservationUpgradeIntent(intent)) {
      roomNames.add(intent.targetRoom);
      continue;
    }

    return null;
  }

  for (const rawTarget of Array.isArray(territoryMemory.targets) ? territoryMemory.targets : []) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.colony !== colony ||
      target.roomName === colony ||
      target.enabled === false ||
      !isExpansionControlAction(target.action)
    ) {
      continue;
    }

    if (isPotentialExpansionReservationUpgradeTarget(target, intents)) {
      roomNames.add(target.roomName);
      continue;
    }

    if (isBlockingExpansionTarget(rawTarget, colony, intents, null)) {
      return null;
    }
  }

  return roomNames;
}

function hasBlockingTerritoryPlan(
  territoryMemory: TerritoryMemory,
  colony: string,
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  if (
    intents.some(
      (intent) =>
        intent.colony === colony &&
        intent.targetRoom !== colony &&
        (intent.action === 'claim' || intent.action === 'reserve' || intent.action === 'scout') &&
        (intent.status === 'planned' || intent.status === 'active') &&
        !isUpgradeableExpansionReservationIntent(intent, reservationUpgrade)
    )
  ) {
    return true;
  }

  return Array.isArray(territoryMemory.targets)
    ? territoryMemory.targets.some((target) => isBlockingExpansionTarget(target, colony, intents, reservationUpgrade))
    : false;
}

function persistTerminalExpansionPlan(
  territoryMemory: TerritoryMemory,
  intents: TerritoryIntentMemory[],
  target: TerritoryTargetMemory,
  status: TerminalExpansionIntentStatus,
  gameTime: number
): void {
  if (findExpansionTarget(territoryMemory, target.colony, target.roomName, target.action)) {
    upsertTerritoryTarget(territoryMemory, { ...target, enabled: false });
  }

  upsertTerritoryIntent(intents, {
    colony: target.colony,
    targetRoom: target.roomName,
    action: target.action,
    status,
    updatedAt: gameTime,
    createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
    ...(target.controllerId ? { controllerId: target.controllerId } : {})
  });
}

function upsertTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingTarget = territoryMemory.targets.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.colony === target.colony &&
      candidate.roomName === target.roomName &&
      candidate.action === target.action &&
      candidate.createdBy === target.createdBy
  );
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }

  existingTarget.enabled = target.enabled;
  existingTarget.createdBy = target.createdBy;
  if (target.controllerId) {
    existingTarget.controllerId = target.controllerId;
  } else {
    delete existingTarget.controllerId;
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

function findExpansionIntent(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  action: TerritoryControlAction
): TerritoryIntentMemory | undefined {
  return intents.find(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action &&
      intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR
  );
}

function findExpansionTarget(
  territoryMemory: TerritoryMemory,
  colony: string,
  roomName: string,
  action: TerritoryControlAction
): TerritoryTargetMemory | null {
  if (!Array.isArray(territoryMemory.targets)) {
    return null;
  }

  return (
    territoryMemory.targets
      .map(normalizeTerritoryTarget)
      .find(
        (target): target is TerritoryTargetMemory =>
          target !== null &&
          target.colony === colony &&
          target.roomName === roomName &&
          target.action === action &&
          target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR
      ) ?? null
  );
}

function isBlockingExpansionTarget(
  rawTarget: unknown,
  colony: string,
  intents: TerritoryIntentMemory[],
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  if (!isRecord(rawTarget)) {
    return false;
  }

  const target = normalizeTerritoryTarget(rawTarget);
  if (
    !target ||
    target.colony !== colony ||
    target.roomName === colony ||
    target.enabled === false ||
    !isExpansionControlAction(target.action)
  ) {
    return false;
  }

  if (isUpgradeableExpansionReservationTarget(target, reservationUpgrade)) {
    return false;
  }

  if (target.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR) {
    return true;
  }

  const matchingIntent = findExpansionIntent(intents, target.colony, target.roomName, target.action);
  return getTerminalIntentStatus(matchingIntent) === null;
}

function getExpansionReservationUpgradeContext(
  candidate: ExpansionPlannerCandidate,
  action: TerritoryControlAction
): ExpansionReservationUpgradeContext | null {
  return candidate.suitable && action === 'claim'
    ? { colony: candidate.colony, targetRoom: candidate.roomName, action }
    : null;
}

function isUpgradeableExpansionReservationIntent(
  intent: TerritoryIntentMemory,
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  return (
    reservationUpgrade !== null &&
    reservationUpgrade.action === 'claim' &&
    intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    intent.colony === reservationUpgrade.colony &&
    intent.targetRoom === reservationUpgrade.targetRoom &&
    intent.action === 'reserve'
  );
}

function isPotentialExpansionReservationUpgradeIntent(intent: TerritoryIntentMemory): boolean {
  return intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR && intent.action === 'reserve';
}

function isUpgradeableExpansionReservationTarget(
  target: TerritoryTargetMemory,
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  return (
    reservationUpgrade !== null &&
    reservationUpgrade.action === 'claim' &&
    target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    target.colony === reservationUpgrade.colony &&
    target.roomName === reservationUpgrade.targetRoom &&
    target.action === 'reserve'
  );
}

function isPotentialExpansionReservationUpgradeTarget(
  target: TerritoryTargetMemory,
  intents: TerritoryIntentMemory[]
): boolean {
  if (target.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR || target.action !== 'reserve') {
    return false;
  }

  const matchingIntent = findExpansionIntent(intents, target.colony, target.roomName, target.action);
  return getTerminalIntentStatus(matchingIntent) === null;
}

function removeSupersededExpansionReservationPlan(
  territoryMemory: TerritoryMemory,
  intents: TerritoryIntentMemory[],
  colony: string,
  roomName: string
): void {
  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter((rawTarget) => {
      const target = normalizeTerritoryTarget(rawTarget);
      return !(
        target?.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
        target.colony === colony &&
        target.roomName === roomName &&
        target.action === 'reserve'
      );
    });
  }

  for (let index = intents.length - 1; index >= 0; index -= 1) {
    const intent = intents[index];
    if (
      intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
      intent.colony === colony &&
      intent.targetRoom === roomName &&
      intent.action === 'reserve'
    ) {
      intents.splice(index, 1);
    }
  }
}

function getExpansionPlanKey(colony: string, targetRoom: string, action: TerritoryControlAction): string {
  return `${colony}:${targetRoom}:${action}`;
}

function isExpansionPlannerClaimIntentForColony(
  intent: TerritoryIntentMemory,
  colony: string | undefined
): boolean {
  return (
    intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    intent.action === 'claim' &&
    (!isNonEmptyString(colony) || intent.colony === colony)
  );
}

function isExpansionPlannerClaimTargetForColony(
  target: TerritoryTargetMemory | null,
  colony: string | undefined
): target is TerritoryTargetMemory & { action: 'claim'; createdBy: typeof EXPANSION_PLANNER_TARGET_CREATOR } {
  return (
    target !== null &&
    target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    target.action === 'claim' &&
    target.enabled !== false &&
    (!isNonEmptyString(colony) || target.colony === colony)
  );
}

function isRunnableExpansionPlannerClaimStatus(
  status: TerritoryIntentMemory['status']
): status is Extract<TerritoryIntentMemory['status'], 'planned' | 'active'> {
  return status === 'planned' || status === 'active';
}

function compareExpansionPlannerClaimRecommendations(
  left: ExpansionPlannerClaimRecommendation,
  right: ExpansionPlannerClaimRecommendation
): number {
  return (
    left.colony.localeCompare(right.colony) ||
    left.targetRoom.localeCompare(right.targetRoom) ||
    compareOptionalNumbers(left.updatedAt, right.updatedAt)
  );
}

function getCandidateTerminalExpansionStatus(
  candidate: ExpansionPlannerCandidate,
  action: TerritoryControlAction,
  existingIntent: TerritoryIntentMemory | undefined
): TerminalExpansionIntentStatus | null {
  if (candidate.suitable) {
    return null;
  }

  const terminalStatus = getTerminalIntentStatus(existingIntent);
  if (terminalStatus) {
    return terminalStatus;
  }

  const ownerUsername = getVisibleColonyOwnerUsername(candidate.colony);
  if (action === 'claim' && candidate.ownerUsername && candidate.ownerUsername === ownerUsername) {
    return 'completed';
  }

  if (action === 'reserve' && candidate.reservationUsername && candidate.reservationUsername === ownerUsername) {
    return 'completed';
  }

  return 'inactive';
}

function getTerminalIntentStatus(
  intent: TerritoryIntentMemory | undefined
): TerminalExpansionIntentStatus | null {
  return intent?.status === 'completed' || intent?.status === 'inactive' ? intent.status : null;
}

function getVisibleExpansionTargetTerminalStatus(
  target: TerritoryTargetMemory,
  ownerUsername: string | undefined
): TerminalExpansionIntentStatus | null {
  const room = getGameRooms()?.[target.roomName];
  if (!room) {
    return null;
  }

  if (
    findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length > 0 ||
    findRoomObjects<AnyStructure>(room, getFindConstant('FIND_HOSTILE_STRUCTURES')).length > 0
  ) {
    return 'inactive';
  }

  const controller = room.controller;
  if (!controller) {
    return 'inactive';
  }

  if (target.action === 'claim') {
    if (isControllerOwnedByUsername(controller, ownerUsername)) {
      return 'completed';
    }

    return isControllerOwned(controller) ? 'inactive' : null;
  }

  if (isControllerOwnedByUsername(controller, ownerUsername)) {
    return 'completed';
  }

  if (isControllerOwned(controller)) {
    return 'inactive';
  }

  const reservationUsername = getControllerReservationUsername(controller);
  if (!reservationUsername) {
    return null;
  }

  return reservationUsername === ownerUsername ? null : 'inactive';
}

function normalizeTerritoryTarget(rawTarget: unknown): TerritoryTargetMemory | null {
  if (!isRecord(rawTarget)) {
    return null;
  }

  const action = getTerritoryTargetAction(rawTarget);
  if (
    !isNonEmptyString(rawTarget.colony) ||
    !isNonEmptyString(rawTarget.roomName) ||
    !action
  ) {
    return null;
  }

  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action,
    ...(typeof rawTarget.controllerId === 'string'
      ? { controllerId: rawTarget.controllerId as Id<StructureController> }
      : {}),
    ...(rawTarget.enabled === false ? { enabled: false } : {}),
    ...(isTerritoryAutomationSource(rawTarget.createdBy) ? { createdBy: rawTarget.createdBy } : {})
  };
}

function getTerritoryTargetAction(rawTarget: Record<string, unknown>): TerritoryControlAction | null {
  if (isExpansionControlAction(rawTarget.action)) {
    return rawTarget.action;
  }

  return isExpansionControlAction(rawTarget.actionHint) ? rawTarget.actionHint : null;
}

function isExpansionControlAction(action: unknown): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
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

function getNearestOwnedRoomDistance(ownedRoomNames: Set<string>, roomName: string): number | null {
  let nearestDistance: number | null = null;
  for (const ownedRoomName of ownedRoomNames) {
    const distance = getRouteDistance(ownedRoomName, roomName);
    if (distance === null) {
      continue;
    }

    if (nearestDistance === null || distance < nearestDistance) {
      nearestDistance = distance;
    }
  }

  return nearestDistance;
}

function getRouteDistance(fromRoom: string, targetRoom: string): number | null {
  if (fromRoom === targetRoom) {
    return 0;
  }

  if (getAdjacentRoomNames(fromRoom).includes(targetRoom)) {
    return 1;
  }

  const route = (globalThis as { Game?: Partial<Game> }).Game?.map?.findRoute?.(fromRoom, targetRoom);
  if (Array.isArray(route)) {
    return route.length;
  }

  return route === ERR_NO_PATH_CODE ? null : null;
}

function getAdjacentRoomNames(roomName: string): string[] {
  const describeExits = (globalThis as { Game?: Partial<Game> }).Game?.map?.describeExits;
  if (typeof describeExits !== 'function') {
    return [];
  }

  const exits = describeExits(roomName) as Record<string, string> | null;
  if (!isRecord(exits)) {
    return [];
  }

  const orderedRooms = EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const adjacentRoom = exits[direction];
    return isNonEmptyString(adjacentRoom) ? [adjacentRoom] : [];
  });
  const remainingRooms = Object.entries(exits)
    .filter(([direction, adjacentRoom]) => !EXIT_DIRECTION_ORDER.includes(direction) && isNonEmptyString(adjacentRoom))
    .map(([, adjacentRoom]) => adjacentRoom)
    .sort();

  return [...orderedRooms, ...remainingRooms];
}

function getVisibleOwnedRoomNames(colonyName: string, ownerUsername: string | undefined): Set<string> {
  const rooms = getGameRooms();
  const roomNames = new Set<string>([colonyName]);
  if (!rooms) {
    return roomNames;
  }

  for (const room of Object.values(rooms)) {
    if (!room || !isNonEmptyString(room.name) || room.controller?.my !== true) {
      continue;
    }

    const roomOwnerUsername = getControllerOwnerUsername(room.controller);
    if (!ownerUsername || !roomOwnerUsername || ownerUsername === roomOwnerUsername) {
      roomNames.add(room.name);
    }
  }

  return roomNames;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  if (isNonEmptyString(username)) {
    return username;
  }

  return controller?.my === true ? 'me' : undefined;
}

function getVisibleColonyOwnerUsername(colony: string): string | undefined {
  return getControllerOwnerUsername(getGameRooms()?.[colony]?.controller);
}

function getControllerReservationUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { reservation?: { username?: string } }) | undefined)
    ?.reservation?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function isControllerOwnedByUsername(
  controller: StructureController | undefined,
  ownerUsername: string | undefined
): boolean {
  const controllerOwnerUsername = getControllerOwnerUsername(controller);
  return (
    controller?.my === true ||
    (isNonEmptyString(ownerUsername) &&
      isNonEmptyString(controllerOwnerUsername) &&
      controllerOwnerUsername === ownerUsername)
  );
}

function isControllerOwned(controller: StructureController | undefined): boolean {
  return controller?.my === true || controller?.owner != null;
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

function getGclLevel(): number | null {
  const level = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game?.gcl?.level;
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
}

function getGameTime(): number {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : 0;
}

function getGameRooms(): Record<string, Room> | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms as Record<string, Room> | undefined;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = getMemoryRecord();
  if (!memory) {
    return null;
  }

  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }

  return memory.territory as TerritoryMemory;
}

function getTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = getMemoryRecord();
  if (!memory || !isRecord(memory.territory)) {
    return null;
  }

  return memory.territory as TerritoryMemory;
}

function getMemoryRecord(): Partial<Memory> | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
