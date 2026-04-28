import type { ColonySnapshot } from '../colony/colonyRegistry';
import { getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';

export const TERRITORY_CLAIMER_ROLE = 'claimer';
export const TERRITORY_SCOUT_ROLE = 'scout';
export const TERRITORY_DOWNGRADE_GUARD_TICKS = 5_000;
export const TERRITORY_RESERVATION_RENEWAL_TICKS = 1_000;
export const TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS / 4;
export const TERRITORY_RESERVATION_COMFORT_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS * 2;
export const TERRITORY_SUPPRESSION_RETRY_TICKS = 1_500;

const EXIT_DIRECTION_ORDER: ExitKey[] = ['1', '3', '5', '7'];
const MIN_CLAIM_PARTS_FOR_RESERVATION_PROGRESS = 2;
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const TERRITORY_CANDIDATE_PRIORITY_URGENT_RENEWAL = 0;
const TERRITORY_CANDIDATE_PRIORITY_VISIBLE_CLAIM = 1;
const TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE = 2;
const TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_CLAIM = 3;
const TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_RESERVE = 4;
const TERRITORY_CANDIDATE_PRIORITY_SCOUT = 5;
const MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY = TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE;

export interface TerritoryIntentPlan {
  colony: string;
  targetRoom: string;
  action: TerritoryIntentAction;
  controllerId?: Id<StructureController>;
}

interface MemoryRecord {
  territory?: unknown;
}

interface SelectedTerritoryTarget {
  target: TerritoryTargetMemory;
  intentAction: TerritoryIntentAction;
  commitTarget: boolean;
}

type TerritoryCandidateSource = 'configured' | 'adjacent';

interface ScoredTerritoryTarget extends SelectedTerritoryTarget {
  order: number;
  priority: number;
  source: TerritoryCandidateSource;
  renewalTicksToEnd?: number;
}

type TerritoryTargetVisibilityState = 'available' | 'satisfied' | 'unavailable';

export function planTerritoryIntent(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number
): TerritoryIntentPlan | null {
  if (!isTerritoryHomeSafe(colony, roleCounts, workerTarget)) {
    return null;
  }

  const selection = selectTerritoryTarget(colony, gameTime);
  if (!selection) {
    return null;
  }

  const target = selection.target;
  const plan: TerritoryIntentPlan = {
    colony: colony.room.name,
    targetRoom: target.roomName,
    action: selection.intentAction,
    ...(target.controllerId ? { controllerId: target.controllerId } : {})
  };
  const status = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) > 0 ? 'active' : 'planned';
  recordTerritoryIntent(plan, status, gameTime, selection.commitTarget ? target : null);

  return plan;
}

export function shouldSpawnTerritoryControllerCreep(
  plan: TerritoryIntentPlan,
  roleCounts: RoleCounts,
  gameTime = getGameTime()
): boolean {
  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return false;
  }

  if (plan.action === 'scout' && isVisibleRoomKnown(plan.targetRoom)) {
    return false;
  }

  if (
    getVisibleTerritoryTargetState(
      plan.targetRoom,
      plan.action,
      plan.controllerId,
      getVisibleColonyOwnerUsername(plan.colony)
    ) !== 'available'
  ) {
    return false;
  }

  return getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) === 0;
}

export function buildTerritoryCreepMemory(plan: TerritoryIntentPlan): CreepMemory {
  return {
    role: plan.action === 'scout' ? TERRITORY_SCOUT_ROLE : TERRITORY_CLAIMER_ROLE,
    colony: plan.colony,
    territory: {
      targetRoom: plan.targetRoom,
      action: plan.action,
      ...(plan.controllerId ? { controllerId: plan.controllerId } : {})
    }
  };
}

export function selectVisibleTerritoryControllerTask(creep: Creep): CreepTaskMemory | null {
  const intent = selectVisibleTerritoryControllerIntent(creep);
  if (!intent) {
    return null;
  }

  const controller = selectCreepRoomController(creep, intent.controllerId);
  if (!controller) {
    return null;
  }

  if (intent.action === 'reserve') {
    return canCreepReserveTerritoryController(creep, controller, intent.colony)
      ? { type: 'reserve', targetId: controller.id }
      : null;
  }

  if (controller.my === true) {
    return getStoredEnergy(creep) > 0 ? { type: 'upgrade', targetId: controller.id } : null;
  }

  return canUseControllerClaimPart(creep) ? { type: 'claim', targetId: controller.id } : null;
}

export function canCreepReserveTerritoryController(
  creep: Creep,
  controller: StructureController,
  colony: string | undefined
): boolean {
  const activeClaimParts = getActiveControllerClaimPartCount(creep);
  if (activeClaimParts <= 0) {
    return false;
  }

  if (isControllerOwned(controller)) {
    return false;
  }

  const reservation = controller.reservation;
  if (!reservation) {
    return true;
  }

  const actorUsername = getTerritoryActorUsername(creep, colony);
  if (
    !isNonEmptyString(actorUsername) ||
    !isNonEmptyString(reservation.username) ||
    reservation.username !== actorUsername ||
    typeof reservation.ticksToEnd !== 'number'
  ) {
    return false;
  }

  const reservationTicksToEnd = reservation.ticksToEnd;
  return (
    reservationTicksToEnd <= TERRITORY_RESERVATION_COMFORT_TICKS &&
    canRenewReservation(activeClaimParts, reservationTicksToEnd)
  );
}

export function selectUrgentVisibleReservationRenewalTask(creep: Creep): CreepTaskMemory | null {
  const intent = selectVisibleTerritoryControllerIntent(creep);
  if (!intent || intent.action !== 'reserve') {
    return null;
  }

  const activeClaimParts = getActiveControllerClaimPartCount(creep);
  if (activeClaimParts <= 0) {
    return null;
  }

  const controller = selectCreepRoomController(creep, intent.controllerId);
  if (!controller) {
    return null;
  }

  const reservationTicksToEnd = getUrgentOwnReservationTicksToEnd(
    controller,
    getTerritoryActorUsername(creep, intent.colony)
  );
  if (reservationTicksToEnd === null || !canRenewReservation(activeClaimParts, reservationTicksToEnd)) {
    return null;
  }

  return { type: 'reserve', targetId: controller.id };
}

export function isVisibleTerritoryAssignmentSafe(
  assignment: CreepTerritoryMemory,
  colony: string | undefined,
  creep?: Creep
): boolean {
  if (!isNonEmptyString(assignment.targetRoom)) {
    return false;
  }

  if (isVisibleRoomUnsafeForTerritoryControllerWork(assignment.targetRoom)) {
    return false;
  }

  if (assignment.action === 'scout') {
    return true;
  }

  if (!isTerritoryControlAction(assignment.action)) {
    return false;
  }

  if (isNonEmptyString(colony) && isTerritoryIntentSuppressed(colony, assignment.targetRoom, assignment.action)) {
    return false;
  }

  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  if (!controller) {
    return !isVisibleRoomMissingController(assignment.targetRoom);
  }

  if (assignment.action === 'claim' && controller.my === true) {
    return false;
  }

  const actorUsername = getTerritoryActorUsername(creep, colony);
  const targetState = getTerritoryControllerTargetState(controller, assignment.action, actorUsername);
  return targetState === 'available' || (assignment.action === 'reserve' && targetState === 'satisfied');
}

export function isVisibleTerritoryAssignmentComplete(
  assignment: CreepTerritoryMemory,
  creep?: Creep
): boolean {
  if (assignment.action !== 'claim' || !isNonEmptyString(assignment.targetRoom)) {
    return false;
  }

  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  return controller?.my === true;
}

export function suppressTerritoryIntent(
  colony: string | undefined,
  assignment: CreepTerritoryMemory,
  gameTime: number
): void {
  if (
    !isNonEmptyString(colony) ||
    !isNonEmptyString(assignment.targetRoom) ||
    !isTerritoryIntentAction(assignment.action)
  ) {
    return;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const suppressedIntent: TerritoryIntentMemory = {
    colony,
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: 'suppressed',
    updatedAt: gameTime,
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {})
  };

  upsertTerritoryIntent(intents, suppressedIntent);
}

export function isTerritoryHomeSafe(colony: ColonySnapshot, roleCounts: RoleCounts, workerTarget: number): boolean {
  if (getWorkerCapacity(roleCounts) < workerTarget) {
    return false;
  }

  if (colony.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return false;
  }

  const controller = colony.room.controller;
  if (controller?.my !== true || typeof controller.level !== 'number' || controller.level < 2) {
    return false;
  }

  return (
    typeof controller.ticksToDowngrade !== 'number' ||
    controller.ticksToDowngrade > TERRITORY_DOWNGRADE_GUARD_TICKS
  );
}

function selectTerritoryTarget(colony: ColonySnapshot, gameTime: number): SelectedTerritoryTarget | null {
  const colonyName = colony.room.name;
  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller);
  const territoryMemory = getTerritoryMemoryRecord();
  const intents = normalizeTerritoryIntents(territoryMemory?.intents);
  const hasBlockingConfiguredTarget = hasBlockingConfiguredTerritoryTargetForColony(
    territoryMemory,
    colonyName,
    colonyOwnerUsername,
    intents,
    gameTime
  );
  const configuredCandidates = getConfiguredTerritoryCandidates(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime
  );
  const bestConfiguredCandidate = selectBestScoredTerritoryCandidate(configuredCandidates);
  if (bestConfiguredCandidate && bestConfiguredCandidate.priority <= MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY) {
    return toSelectedTerritoryTarget(bestConfiguredCandidate);
  }

  return toSelectedTerritoryTarget(
    selectBestScoredTerritoryCandidate([
      ...configuredCandidates,
      ...getAdjacentReserveCandidates(
        colonyName,
        colonyOwnerUsername,
        territoryMemory,
        intents,
        gameTime,
        !hasBlockingConfiguredTarget
      )
    ])
  );
}

function selectBestScoredTerritoryCandidate(candidates: ScoredTerritoryTarget[]): ScoredTerritoryTarget | null {
  let bestCandidate: ScoredTerritoryTarget | null = null;
  for (const candidate of candidates) {
    if (!bestCandidate || compareTerritoryCandidates(candidate, bestCandidate) < 0) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function toSelectedTerritoryTarget(candidate: ScoredTerritoryTarget | null): SelectedTerritoryTarget | null {
  return candidate
    ? {
        target: candidate.target,
        intentAction: candidate.intentAction,
        commitTarget: candidate.commitTarget
      }
    : null;
}

function getConfiguredTerritoryCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number
): ScoredTerritoryTarget[] {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }

  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.enabled === false ||
      target.colony !== colonyName ||
      target.roomName === colonyName ||
      isTerritoryTargetSuppressed(target, intents, gameTime) ||
      getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !==
        'available'
    ) {
      return [];
    }

    const candidate = scoreTerritoryCandidate(
      { target, intentAction: target.action, commitTarget: false },
      'configured',
      order,
      colonyName,
      colonyOwnerUsername
    );
    return candidate ? [candidate] : [];
  });
}

function hasBlockingConfiguredTerritoryTargetForColony(
  territoryMemory: Record<string, unknown> | null,
  colonyName: string,
  colonyOwnerUsername: string | null,
  intents: TerritoryIntentMemory[],
  gameTime: number
): boolean {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return false;
  }

  return territoryMemory.targets.some((rawTarget) => {
    const target = normalizeTerritoryTarget(rawTarget);
    if (!target || target.colony !== colonyName) {
      return false;
    }

    if (
      target.enabled === false ||
      target.roomName === colonyName ||
      isTerritoryTargetSuppressed(target, intents, gameTime)
    ) {
      return true;
    }

    return (
      getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !==
      'satisfied'
    );
  });
}

function getAdjacentReserveCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  includeScoutCandidates: boolean
): ScoredTerritoryTarget[] {
  const adjacentRooms = getAdjacentRoomNames(colonyName);
  if (adjacentRooms.length === 0) {
    return [];
  }

  const existingTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  return adjacentRooms.flatMap((roomName, order) => {
    const target: TerritoryTargetMemory = { colony: colonyName, roomName, action: 'reserve' };
    if (
      roomName === colonyName ||
      existingTargetRooms.has(roomName) ||
      isTerritoryTargetSuppressed(target, intents, gameTime)
    ) {
      return [];
    }

    const candidateState = getAdjacentReserveCandidateState(roomName, colonyOwnerUsername);
    if (candidateState === 'safe') {
      const candidate = scoreTerritoryCandidate(
        { target, intentAction: 'reserve', commitTarget: true },
        'adjacent',
        order,
        colonyName,
        colonyOwnerUsername
      );
      return candidate ? [candidate] : [];
    }

    if (
      candidateState === 'unknown' &&
      includeScoutCandidates &&
      !isSuppressedTerritoryIntentForAction(intents, colonyName, roomName, 'scout', gameTime)
    ) {
      const candidate = scoreTerritoryCandidate(
        { target, intentAction: 'scout', commitTarget: false },
        'adjacent',
        order,
        colonyName,
        colonyOwnerUsername
      );
      return candidate ? [candidate] : [];
    }

    return [];
  });
}

function scoreTerritoryCandidate(
  selection: SelectedTerritoryTarget,
  source: TerritoryCandidateSource,
  order: number,
  colonyName: string,
  colonyOwnerUsername: string | null
): ScoredTerritoryTarget | null {
  if (getKnownRouteLength(colonyName, selection.target.roomName) === null) {
    return null;
  }

  const renewalTicksToEnd = getConfiguredReserveRenewalTicksToEnd(selection.target, colonyOwnerUsername);
  return {
    ...selection,
    source,
    order,
    priority: getTerritoryCandidatePriority(selection, renewalTicksToEnd),
    ...(renewalTicksToEnd !== null ? { renewalTicksToEnd } : {})
  };
}

function getTerritoryCandidatePriority(
  selection: SelectedTerritoryTarget,
  renewalTicksToEnd: number | null
): number {
  if (renewalTicksToEnd !== null) {
    return TERRITORY_CANDIDATE_PRIORITY_URGENT_RENEWAL;
  }

  if (selection.intentAction === 'scout') {
    return TERRITORY_CANDIDATE_PRIORITY_SCOUT;
  }

  if (isTerritoryTargetVisible(selection.target)) {
    return selection.target.action === 'claim'
      ? TERRITORY_CANDIDATE_PRIORITY_VISIBLE_CLAIM
      : TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE;
  }

  return selection.target.action === 'claim'
    ? TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_CLAIM
    : TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_RESERVE;
}

function compareTerritoryCandidates(left: ScoredTerritoryTarget, right: ScoredTerritoryTarget): number {
  return (
    left.priority - right.priority ||
    compareOptionalNumbers(left.renewalTicksToEnd, right.renewalTicksToEnd) ||
    getTerritoryCandidateSourcePriority(left.source) - getTerritoryCandidateSourcePriority(right.source) ||
    left.order - right.order ||
    left.target.roomName.localeCompare(right.target.roomName) ||
    left.intentAction.localeCompare(right.intentAction)
  );
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function getTerritoryCandidateSourcePriority(source: TerritoryCandidateSource): number {
  return source === 'configured' ? 0 : 1;
}

function isTerritoryTargetVisible(target: TerritoryTargetMemory): boolean {
  return isVisibleRoomKnown(target.roomName) || getVisibleController(target.roomName, target.controllerId) !== null;
}

function getKnownRouteLength(fromRoom: string, targetRoom: string): number | null | undefined {
  if (fromRoom === targetRoom) {
    return 0;
  }

  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & {
        findRoute?: (fromRoom: string, toRoom: string) => unknown;
      })
    | undefined;
  if (typeof gameMap?.findRoute !== 'function') {
    return undefined;
  }

  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom);
  if (route === getNoPathResultCode()) {
    return null;
  }

  return Array.isArray(route) ? route.length : undefined;
}

function getNoPathResultCode(): ScreepsReturnCode {
  const noPathCode = (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  return typeof noPathCode === 'number' ? noPathCode : ERR_NO_PATH_CODE;
}

function getAdjacentReserveCandidateState(
  targetRoom: string,
  colonyOwnerUsername: string | null
): 'safe' | 'unknown' | 'unavailable' {
  if (isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom)) {
    return 'unavailable';
  }

  if (isVisibleRoomMissingController(targetRoom)) {
    return 'unavailable';
  }

  const controller = getVisibleController(targetRoom);
  if (!controller) {
    return 'unknown';
  }

  const targetState = getReserveControllerTargetState(controller, colonyOwnerUsername);
  return targetState === 'available' ? 'safe' : 'unavailable';
}

function getConfiguredTargetRoomsForColony(
  territoryMemory: Record<string, unknown> | null,
  colonyName: string
): Set<string> {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return new Set();
  }

  return new Set(
    territoryMemory.targets.flatMap((rawTarget) => {
      const target = normalizeTerritoryTarget(rawTarget);
      return target?.colony === colonyName ? [target.roomName] : [];
    })
  );
}

function appendTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  territoryMemory.targets.push(target);
}

function getAdjacentRoomNames(roomName: string): string[] {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const gameMap = game?.map;
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

function normalizeTerritoryTarget(rawTarget: unknown): TerritoryTargetMemory | null {
  if (!isRecord(rawTarget)) {
    return null;
  }

  if (
    !isNonEmptyString(rawTarget.colony) ||
    !isNonEmptyString(rawTarget.roomName) ||
    !isTerritoryControlAction(rawTarget.action)
  ) {
    return null;
  }

  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action: rawTarget.action,
    ...(typeof rawTarget.controllerId === 'string'
      ? { controllerId: rawTarget.controllerId as Id<StructureController> }
      : {}),
    ...(rawTarget.enabled === false ? { enabled: false } : {})
  };
}

function recordTerritoryIntent(
  plan: TerritoryIntentPlan,
  status: TerritoryIntentMemory['status'],
  gameTime: number,
  seededTarget: TerritoryTargetMemory | null = null
): void {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  if (seededTarget) {
    appendTerritoryTarget(territoryMemory, seededTarget);
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const nextIntent: TerritoryIntentMemory = {
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    status,
    updatedAt: gameTime,
    ...(plan.controllerId ? { controllerId: plan.controllerId } : {})
  };

  upsertTerritoryIntent(intents, nextIntent);
}

function normalizeTerritoryIntents(rawIntents: TerritoryMemory['intents'] | unknown): TerritoryIntentMemory[] {
  return Array.isArray(rawIntents)
    ? rawIntents.flatMap((intent) => {
        const normalizedIntent = normalizeTerritoryIntent(intent);
        return normalizedIntent ? [normalizedIntent] : [];
      })
    : [];
}

function upsertTerritoryIntent(intents: TerritoryIntentMemory[], nextIntent: TerritoryIntentMemory): void {
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === nextIntent.colony &&
      intent.targetRoom === nextIntent.targetRoom &&
      intent.action === nextIntent.action
  );

  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
}

function normalizeTerritoryIntent(rawIntent: unknown): TerritoryIntentMemory | null {
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

  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...(typeof rawIntent.controllerId === 'string'
      ? { controllerId: rawIntent.controllerId as Id<StructureController> }
      : {})
  };
}

function getTerritoryCreepCountForTarget(
  roleCounts: RoleCounts,
  targetRoom: string,
  action: TerritoryIntentAction
): number {
  if (action === 'scout') {
    return roleCounts.scoutsByTargetRoom?.[targetRoom] ?? 0;
  }

  if (roleCounts.claimersByTargetRoomAction) {
    return roleCounts.claimersByTargetRoomAction[action]?.[targetRoom] ?? 0;
  }

  return roleCounts.claimersByTargetRoom?.[targetRoom] ?? 0;
}

function isTerritoryTargetSuppressed(
  target: TerritoryTargetMemory,
  intents: TerritoryIntentMemory[],
  gameTime: number
): boolean {
  return isSuppressedTerritoryIntentForAction(intents, target.colony, target.roomName, target.action, gameTime);
}

function isSuppressedTerritoryIntentForAction(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction,
  gameTime: number
): boolean {
  return intents.some(
    (intent) =>
      isTerritorySuppressionFresh(intent, gameTime) &&
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action
  );
}

function isTerritoryIntentSuppressed(
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction,
  gameTime = getGameTime()
): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) =>
      isTerritorySuppressionFresh(intent, gameTime) &&
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action
  );
}

function isTerritorySuppressionFresh(intent: TerritoryIntentMemory, gameTime: number): boolean {
  return intent.status === 'suppressed' && gameTime - intent.updatedAt <= TERRITORY_SUPPRESSION_RETRY_TICKS;
}

function selectVisibleTerritoryControllerIntent(creep: Creep): TerritoryIntentMemory | null {
  const roomName = creep.room?.name;
  if (!isNonEmptyString(roomName) || isVisibleRoomUnsafe(creep.room)) {
    return null;
  }

  const assignmentIntent = normalizeCreepTerritoryIntent(creep, roomName);
  if (assignmentIntent && isCreepVisibleTerritoryIntentActionable(creep, assignmentIntent)) {
    return assignmentIntent;
  }

  const territoryMemory = getTerritoryMemoryRecord();
  const colony = creep.memory?.colony;
  const intents = normalizeTerritoryIntents(territoryMemory?.intents)
    .filter((intent) => isActiveVisibleControllerIntentForCreep(intent, roomName, colony))
    .sort(compareVisibleControllerIntents);

  return intents.find((intent) => isCreepVisibleTerritoryIntentActionable(creep, intent)) ?? null;
}

function normalizeCreepTerritoryIntent(creep: Creep, roomName: string): TerritoryIntentMemory | null {
  const assignment = creep.memory?.territory;
  if (
    !assignment ||
    assignment.targetRoom !== roomName ||
    !isTerritoryControlAction(assignment.action) ||
    (isNonEmptyString(creep.memory?.colony) &&
      isTerritoryIntentSuppressed(creep.memory.colony, assignment.targetRoom, assignment.action))
  ) {
    return null;
  }

  return {
    colony: creep.memory?.colony ?? '',
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: 'active',
    updatedAt: getGameTime(),
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {})
  };
}

function isActiveVisibleControllerIntentForCreep(
  intent: TerritoryIntentMemory,
  roomName: string,
  creepColony: string | undefined
): boolean {
  return (
    intent.targetRoom === roomName &&
    intent.targetRoom !== intent.colony &&
    isTerritoryControlAction(intent.action) &&
    (intent.status === 'planned' || intent.status === 'active') &&
    (!isNonEmptyString(creepColony) || intent.colony === creepColony)
  );
}

function compareVisibleControllerIntents(left: TerritoryIntentMemory, right: TerritoryIntentMemory): number {
  return (
    getIntentStatusPriority(left.status) - getIntentStatusPriority(right.status) ||
    getIntentActionPriority(left.action) - getIntentActionPriority(right.action) ||
    right.updatedAt - left.updatedAt ||
    left.colony.localeCompare(right.colony)
  );
}

function getIntentStatusPriority(status: TerritoryIntentMemory['status']): number {
  return status === 'active' ? 0 : 1;
}

function getIntentActionPriority(action: TerritoryIntentAction): number {
  return action === 'claim' ? 0 : 1;
}

function isCreepVisibleTerritoryIntentActionable(creep: Creep, intent: TerritoryIntentMemory): boolean {
  if (!isTerritoryControlAction(intent.action)) {
    return false;
  }

  const controller = selectCreepRoomController(creep, intent.controllerId);
  if (!controller) {
    return false;
  }

  if (!isVisibleRoomSafe(creep.room)) {
    return false;
  }

  if (intent.action === 'claim' && controller.my === true) {
    return true;
  }

  if (intent.action === 'reserve') {
    return canCreepReserveTerritoryController(creep, controller, intent.colony);
  }

  return (
    getTerritoryControllerTargetState(controller, intent.action, getTerritoryActorUsername(creep, intent.colony)) ===
    'available'
  );
}

function selectVisibleTerritoryAssignmentController(
  assignment: CreepTerritoryMemory,
  creep?: Creep
): StructureController | null {
  return creep?.room?.name === assignment.targetRoom
    ? selectCreepRoomController(creep, assignment.controllerId)
    : getVisibleController(assignment.targetRoom, assignment.controllerId);
}

function selectCreepRoomController(creep: Creep, controllerId?: Id<StructureController>): StructureController | null {
  const roomController = creep.room?.controller;
  if (!controllerId) {
    return roomController ?? null;
  }

  if (roomController?.id === controllerId) {
    return roomController;
  }

  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const getObjectById = game?.getObjectById;
  if (typeof getObjectById !== 'function') {
    return null;
  }

  return getObjectById.call(game, controllerId) as StructureController | null;
}

function getTerritoryControllerTargetState(
  controller: StructureController,
  action: TerritoryControlAction,
  colonyOwnerUsername: string | null
): TerritoryTargetVisibilityState {
  if (action === 'reserve') {
    return getReserveControllerTargetState(controller, colonyOwnerUsername);
  }

  return isControllerOwned(controller) ? 'unavailable' : 'available';
}

function getTerritoryActorUsername(creep: Creep | undefined, colony: string | undefined): string | null {
  return getCreepOwnerUsername(creep) ?? (isNonEmptyString(colony) ? getVisibleColonyOwnerUsername(colony) : null);
}

function getCreepOwnerUsername(creep: Creep | undefined): string | null {
  const username = (creep as (Creep & { owner?: { username?: string } }) | undefined)?.owner?.username;
  return isNonEmptyString(username) ? username : null;
}

function canUseControllerClaimPart(creep: Creep): boolean {
  return getActiveControllerClaimPartCount(creep) > 0;
}

function canRenewReservation(activeClaimParts: number, reservationTicksToEnd: number): boolean {
  return (
    reservationTicksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS ||
    (reservationTicksToEnd <= TERRITORY_RESERVATION_COMFORT_TICKS &&
      activeClaimParts >= MIN_CLAIM_PARTS_FOR_RESERVATION_PROGRESS)
  );
}

function getActiveControllerClaimPartCount(creep: Creep): number {
  const claimPart = getBodyPartConstant('CLAIM', 'claim');
  const activeClaimParts = creep.getActiveBodyparts?.(claimPart);
  if (typeof activeClaimParts === 'number') {
    return activeClaimParts;
  }

  return Array.isArray(creep.body) ? creep.body.filter((part) => part.type === claimPart && part.hits > 0).length : 0;
}

function getBodyPartConstant(globalName: 'CLAIM', fallback: BodyPartConstant): BodyPartConstant {
  const constants = globalThis as unknown as Partial<Record<'CLAIM', BodyPartConstant>>;
  return constants[globalName] ?? fallback;
}

function getStoredEnergy(object: unknown): number {
  const store = (object as { store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null } } | null)
    ?.store;
  const energyResource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(energyResource);
  if (typeof usedCapacity === 'number') {
    return usedCapacity;
  }

  const storedEnergy = (store as Record<string, unknown> | undefined)?.[energyResource];
  return typeof storedEnergy === 'number' ? storedEnergy : 0;
}

function getEnergyResource(): ResourceConstant {
  const resource = (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
  return (typeof resource === 'string' ? resource : 'energy') as ResourceConstant;
}

function isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom: string): boolean {
  const room = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[targetRoom];
  return room ? isVisibleRoomUnsafe(room) : false;
}

function isVisibleRoomSafe(room: Room): boolean {
  return !isVisibleRoomUnsafe(room);
}

function isVisibleRoomUnsafe(room: Room): boolean {
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

function getVisibleTerritoryTargetState(
  targetRoom: string,
  action: TerritoryIntentAction,
  controllerId?: Id<StructureController>,
  colonyOwnerUsername?: string | null
): TerritoryTargetVisibilityState {
  if (isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom)) {
    return 'unavailable';
  }

  if (isVisibleRoomMissingController(targetRoom)) {
    return 'unavailable';
  }

  if (action === 'scout') {
    return isVisibleRoomKnown(targetRoom) ? 'unavailable' : 'available';
  }

  const controller = getVisibleController(targetRoom, controllerId);
  if (!controller) {
    return 'available';
  }

  if (action === 'reserve') {
    return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername ?? null);
  }

  return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername ?? null);
}

function isVisibleRoomKnown(targetRoom: string): boolean {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  return game?.rooms?.[targetRoom] != null;
}

function isVisibleRoomMissingController(targetRoom: string): boolean {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const room = game?.rooms?.[targetRoom];
  return room != null && room.controller == null;
}

function isControllerOwned(controller: StructureController): boolean {
  return controller.owner != null || controller.my === true;
}

function getReserveControllerTargetState(
  controller: StructureController,
  colonyOwnerUsername: string | null
): TerritoryTargetVisibilityState {
  if (isControllerOwned(controller)) {
    return 'unavailable';
  }

  const reservation = controller.reservation;
  if (!reservation) {
    return 'available';
  }

  if (!isNonEmptyString(reservation.username) || reservation.username !== colonyOwnerUsername) {
    return 'unavailable';
  }

  return getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername) === null ? 'satisfied' : 'available';
}

function getConfiguredReserveRenewalTicksToEnd(
  target: TerritoryTargetMemory,
  colonyOwnerUsername: string | null
): number | null {
  if (target.action !== 'reserve' || colonyOwnerUsername === null) {
    return null;
  }

  const controller = getVisibleController(target.roomName, target.controllerId);
  if (!controller || isControllerOwned(controller)) {
    return null;
  }

  return getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername);
}

function getUrgentOwnReservationTicksToEnd(
  controller: StructureController,
  colonyOwnerUsername: string | null
): number | null {
  const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
  return ticksToEnd !== null && ticksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS ? ticksToEnd : null;
}

function getOwnReservationTicksToEnd(
  controller: StructureController,
  colonyOwnerUsername: string | null
): number | null {
  if (isControllerOwned(controller) || !isNonEmptyString(colonyOwnerUsername)) {
    return null;
  }

  const reservation = controller.reservation;
  if (
    !reservation ||
    reservation.username !== colonyOwnerUsername ||
    typeof reservation.ticksToEnd !== 'number'
  ) {
    return null;
  }

  return reservation.ticksToEnd;
}

function getVisibleColonyOwnerUsername(colonyName: string): string | null {
  const controller = getVisibleController(colonyName);
  return getControllerOwnerUsername(controller ?? undefined);
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | null {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  return isNonEmptyString(username) ? username : null;
}

function getVisibleController(targetRoom: string, controllerId?: Id<StructureController>): StructureController | null {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const roomController = game?.rooms?.[targetRoom]?.controller;
  if (roomController) {
    return roomController;
  }

  const getObjectById = game?.getObjectById;
  if (controllerId && typeof getObjectById === 'function') {
    return getObjectById.call(game, controllerId) as StructureController | null;
  }

  return null;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
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

function getTerritoryMemoryRecord(): Record<string, unknown> | null {
  const memory = getMemoryRecord();
  if (!memory || !isRecord(memory.territory)) {
    return null;
  }

  return memory.territory;
}

function getMemoryRecord(): MemoryRecord | null {
  const memory = (globalThis as { Memory?: MemoryRecord }).Memory;
  return memory ?? null;
}

function isTerritoryControlAction(action: unknown): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
}

function isTerritoryIntentAction(action: unknown): action is TerritoryIntentAction {
  return isTerritoryControlAction(action) || action === 'scout';
}

function isTerritoryIntentStatus(status: unknown): status is TerritoryIntentMemory['status'] {
  return status === 'planned' || status === 'active' || status === 'suppressed';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
