import type { ColonySnapshot } from '../colony/colonyRegistry';
import { getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import {
  TERRITORY_CONTROLLER_BODY_COST,
  TERRITORY_CONTROLLER_PRESSURE_BODY_COST,
  TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS
} from '../spawn/bodyBuilder';
import type { AutonomousExpansionClaimEvaluation } from './claimExecutor';
import {
  scoreOccupationRecommendations,
  type OccupationControllerEvidence,
  type OccupationRecommendationCandidateInput,
  type OccupationRecommendationEvidenceStatus,
  type OccupationRecommendationScore
} from './occupationRecommendation';
import { shouldSignOccupiedController } from './controllerSigning';
import { normalizeTerritoryFollowUp, normalizeTerritoryIntents } from './territoryMemoryUtils';
import {
  getKnownDeadZoneRoom,
  isKnownDeadZoneRoom,
  isRouteBlockedByKnownDeadZone,
  refreshVisibleRoomDeadZoneMemory
} from '../defense/deadZone';
import { planSourceContainerConstruction } from '../construction/sourceContainerPlanner';
import {
  findSourceContainer,
  findSourceContainerConstructionSite
} from '../economy/sourceContainers';

export const TERRITORY_CLAIMER_ROLE = 'claimer';
export const TERRITORY_SCOUT_ROLE = 'scout';
export const TERRITORY_DOWNGRADE_GUARD_TICKS = 5_000;
const GLOBAL_TERRITORY_RESERVATION_TICKS = (globalThis as { CONTROLLER_RESERVE_MAX?: number }).CONTROLLER_RESERVE_MAX;
const GLOBAL_TERRITORY_CLAIM_READY_TICKS = (globalThis as { TERRITORY_CLAIM_READY_TICKS?: number })
  .TERRITORY_CLAIM_READY_TICKS;
export const TERRITORY_RESERVATION_TICKS =
  typeof GLOBAL_TERRITORY_RESERVATION_TICKS === 'number' &&
  GLOBAL_TERRITORY_RESERVATION_TICKS > 0 &&
  Number.isFinite(GLOBAL_TERRITORY_RESERVATION_TICKS)
    ? Math.floor(GLOBAL_TERRITORY_RESERVATION_TICKS)
    : 5_000;
const TERRITORY_DEFAULT_CLAIM_READY_TICKS = 10;
export const TERRITORY_CLAIM_READY_TICKS =
  typeof GLOBAL_TERRITORY_CLAIM_READY_TICKS === 'number' &&
  Number.isFinite(GLOBAL_TERRITORY_CLAIM_READY_TICKS) &&
  GLOBAL_TERRITORY_CLAIM_READY_TICKS > 0
    ? Math.min(Math.floor(GLOBAL_TERRITORY_CLAIM_READY_TICKS), TERRITORY_RESERVATION_TICKS)
    : TERRITORY_DEFAULT_CLAIM_READY_TICKS;
export const TERRITORY_RESERVATION_RENEWAL_TICKS = TERRITORY_RESERVATION_TICKS / 5;
export const TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS = Math.min(500, TERRITORY_RESERVATION_RENEWAL_TICKS);
export const TERRITORY_RESERVATION_COMFORT_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS * 2;
export const TERRITORY_RESERVATION_PRE_RENEW_SCOUT_ROUTE_TICKS = 50;
export const TERRITORY_SUPPRESSION_RETRY_TICKS = 1_500;
export const TERRITORY_HOSTILE_INTENT_SUSPENSION_TICKS = 1_500;
export const TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS = 50;
export const TERRITORY_RECOVERED_INTENT_SPAWN_PRIORITY = 1_000;
export const TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND = 1;
// TERRITORY_READY already proves local worker recovery; use that floor for adjacent visible controller progress.
export const TERRITORY_ADJACENT_CONTROLLER_PROGRESS_WORKER_SURPLUS = 0;

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
const TERRITORY_ROUTE_DISTANCE_SEPARATOR = '>';
const TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET = 2;
const TERRITORY_SCOUT_BODY_COST = 50;
const OCCUPATION_RECOMMENDATION_TARGET_CREATOR: TerritoryTargetMemory['createdBy'] = 'occupationRecommendation';
const REMOTE_MINING_SOURCE_CONTAINER_MIN_RCL = 0;

export interface TerritoryIntentPlan {
  colony: string;
  targetRoom: string;
  action: TerritoryIntentAction;
  controllerId?: Id<StructureController>;
  createdBy?: TerritoryAutomationSource;
  requiresControllerPressure?: boolean;
  followUp?: TerritoryFollowUpMemory;
}

export interface TerritoryIntentProgressSummary {
  colony: string;
  targetRoom: string;
  action: TerritoryIntentAction;
  status: 'planned' | 'active';
  updatedAt: number;
  activeCreepCount: number;
  adjacentToColony: boolean;
  controllerId?: Id<StructureController>;
  requiresControllerPressure?: boolean;
  followUp?: TerritoryFollowUpMemory;
}

export interface TerritoryIntentPlanningOptions {
  controllerPressureOnly?: boolean;
  followUpOnly?: boolean;
}

interface TerritoryTargetSelectionOptions {
  controllerPressureOnly?: boolean;
  followUpOnly?: boolean;
}

interface MemoryRecord {
  territory?: unknown;
}

interface SelectedTerritoryTarget {
  target: TerritoryTargetMemory;
  intentAction: TerritoryIntentAction;
  commitTarget: boolean;
  requiresControllerPressure?: boolean;
  followUp?: TerritoryFollowUpMemory;
  persistedFollowUp?: boolean;
  recoveredFollowUp?: boolean;
  recoveredFollowUpSuppressedAt?: number;
  routeDistanceLookupContext?: RouteDistanceLookupContext;
}

type TerritoryCandidateSource =
  | 'configured'
  | 'occupationIntent'
  | 'satisfiedClaimAdjacent'
  | 'satisfiedReserveAdjacent'
  | 'activeReserveAdjacent'
  | 'adjacent';

interface ScoredTerritoryTarget extends SelectedTerritoryTarget {
  order: number;
  priority: number;
  source: TerritoryCandidateSource;
  ignoreOwnHealthyReservation?: boolean;
  recommendationScore?: number;
  recommendationEvidenceStatus?: OccupationRecommendationEvidenceStatus;
  routeDistance?: number;
  roadDistance?: number;
  renewalTicksToEnd?: number;
  immediateControllerFollowUp?: boolean;
  occupationActionableTicks?: number;
  safeAdjacentControllerProgress?: boolean;
}

type TerritoryTargetVisibilityState = 'available' | 'satisfied' | 'unavailable';

interface RouteDistanceLookupContext {
  revalidatedNoRouteCacheKeys: Set<string>;
}

interface PersistedTerritoryIntentFollowUp {
  followUp: TerritoryFollowUpMemory;
  recovered: boolean;
  coolingDown: boolean;
  suppressedAt?: number;
  requiresControllerPressure?: boolean;
}

interface RecoveredTerritoryFollowUpRetryMetadata {
  suppressedAt: number;
}

type RemoteMiningRoomState = Omit<TerritoryRemoteMiningRoomMemory, 'updatedAt'>;

const recoveredTerritoryFollowUpRetryMetadata = new WeakMap<
  TerritoryIntentPlan,
  RecoveredTerritoryFollowUpRetryMetadata
>();

export function planTerritoryIntent(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number,
  options: TerritoryIntentPlanningOptions = {}
): TerritoryIntentPlan | null {
  if (!isTerritoryHomeSafe(colony, roleCounts, workerTarget)) {
    return null;
  }

  const selection = selectTerritoryTarget(colony, roleCounts, workerTarget, gameTime, options);
  if (!selection) {
    return null;
  }

  const target = selection.target;
  const plan: TerritoryIntentPlan = {
    colony: colony.room.name,
    targetRoom: target.roomName,
    action: selection.intentAction,
    ...(target.controllerId ? { controllerId: target.controllerId } : {}),
    ...(target.createdBy ? { createdBy: target.createdBy } : {}),
    ...(selection.requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(selection.followUp ? { followUp: selection.followUp } : {})
  };

  if (selection.recoveredFollowUp === true && typeof selection.recoveredFollowUpSuppressedAt === 'number') {
    recoveredTerritoryFollowUpRetryMetadata.set(plan, { suppressedAt: selection.recoveredFollowUpSuppressedAt });
  }
  const status = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) > 0 ? 'active' : 'planned';
  recordTerritoryIntent(
    plan,
    status,
    gameTime,
    selection.commitTarget ? target : null,
    selection.routeDistanceLookupContext
  );

  return plan;
}

export function recordRecoveredTerritoryFollowUpRetryCooldown(
  plan: TerritoryIntentPlan | null,
  gameTime = getGameTime()
): void {
  if (!plan || !plan.followUp || !isTerritoryControlAction(plan.action)) {
    return;
  }

  const recoveredFollowUpMetadata = recoveredTerritoryFollowUpRetryMetadata.get(plan);
  if (!recoveredFollowUpMetadata) {
    return;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === plan.colony && intent.targetRoom === plan.targetRoom && intent.action === plan.action
  );
  if (existingIndex < 0) {
    return;
  }

  const existingIntent = intents[existingIndex];
  intents[existingIndex] = {
    ...existingIntent,
    status: 'suppressed',
    updatedAt: recoveredFollowUpMetadata.suppressedAt,
    followUp: plan.followUp,
    lastAttemptAt: gameTime,
    ...(plan.requiresControllerPressure ? { requiresControllerPressure: true } : {})
  };
  removeTerritoryFollowUpDemand(territoryMemory, plan.colony, plan.targetRoom, plan.action);
  removeTerritoryFollowUpExecutionHint(territoryMemory, plan.colony, plan.targetRoom, plan.action);
}

export function shouldSpawnTerritoryControllerCreep(
  plan: TerritoryIntentPlan,
  roleCounts: RoleCounts,
  gameTime = getGameTime()
): boolean {
  if (isKnownDeadZoneRoom(plan.targetRoom)) {
    return false;
  }

  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return false;
  }

  if (isTerritoryIntentSuspended(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return false;
  }

  if (plan.action === 'scout' && isVisibleRoomKnown(plan.targetRoom)) {
    return false;
  }

  if (
    !isVisibleTerritoryIntentActionable(
      plan.targetRoom,
      plan.action,
      plan.controllerId,
      getVisibleColonyOwnerUsername(plan.colony)
    )
  ) {
    return false;
  }

  if (!isTerritoryIntentPlanSpawnCapable(plan)) {
    return false;
  }

  const activeCoverageCount = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action);
  return (
    activeCoverageCount === 0 || shouldSpawnEmergencyReservationRenewal(plan, activeCoverageCount)
  );
}

export function requiresTerritoryControllerPressure(plan: TerritoryIntentPlan): boolean {
  return (
    isTerritoryControlAction(plan.action) &&
    (plan.requiresControllerPressure === true ||
      isVisibleTerritoryReservePressureAvailable(
        plan.targetRoom,
        plan.action,
        plan.controllerId,
        getVisibleColonyOwnerUsername(plan.colony)
      ))
  );
}

function isTerritoryIntentPlanSpawnCapable(plan: TerritoryIntentPlan): boolean {
  if (!requiresTerritoryControllerPressure(plan)) {
    return true;
  }

  const energyCapacityAvailable = getVisibleRoom(plan.colony)?.energyCapacityAvailable;
  return typeof energyCapacityAvailable !== 'number' || energyCapacityAvailable >= TERRITORY_CONTROLLER_PRESSURE_BODY_COST;
}

export function getTerritoryFollowUpPreparationWorkerDemand(
  plan: TerritoryIntentPlan | null,
  gameTime = getGameTime()
): number {
  if (!plan || !isTerritoryControlAction(plan.action)) {
    return 0;
  }

  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return 0;
  }

  if (isTerritoryIntentSuspended(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return 0;
  }

  if (
    !isVisibleTerritoryIntentActionable(
      plan.targetRoom,
      plan.action,
      plan.controllerId,
      getVisibleColonyOwnerUsername(plan.colony)
    )
  ) {
    return 0;
  }

  const demand = getCurrentTerritoryFollowUpDemand(plan, gameTime);
  return demand?.workerCount ?? 0;
}

export function hasActiveTerritoryFollowUpPreparationDemand(
  colony: string | null | undefined,
  gameTime = getGameTime()
): boolean {
  if (!isNonEmptyString(colony)) {
    return false;
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  return normalizeTerritoryFollowUpDemands(territoryMemory.demands).some(
    (demand) => demand.updatedAt === gameTime && demand.colony === colony && demand.workerCount > 0
  );
}

export function hasPendingTerritoryFollowUpIntent(
  colony: string | null | undefined,
  roleCounts: RoleCounts,
  gameTime = getGameTime()
): boolean {
  if (!isNonEmptyString(colony)) {
    return false;
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) =>
      intent.colony === colony &&
      intent.followUp !== undefined &&
      isTerritoryControlAction(intent.action) &&
      !isTerritoryIntentSuspensionActive(intent, gameTime) &&
      isVisibleTerritoryIntentActionable(
        intent.targetRoom,
        intent.action,
        intent.controllerId,
        getVisibleColonyOwnerUsername(intent.colony)
      ) &&
      (intent.status === 'planned' ||
        isRecoveredTerritoryFollowUpIntent(intent, gameTime) ||
        (intent.status === 'active' &&
          getTerritoryCreepCountForTarget(roleCounts, intent.targetRoom, intent.action) === 0))
  );
}

export function getActiveTerritoryFollowUpExecutionHints(
  colony: string | null | undefined = undefined
): TerritoryExecutionHintMemory[] {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return [];
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  return getBoundedActiveTerritoryFollowUpExecutionHints(
    normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints),
    intents
  ).filter((hint) => !isNonEmptyString(colony) || hint.colony === colony);
}

export function getTerritoryIntentProgressSummaries(
  colony: string | null | undefined,
  roleCounts: RoleCounts
): TerritoryIntentProgressSummary[] {
  if (!isNonEmptyString(colony)) {
    return [];
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return [];
  }

  const gameTime = getGameTime();
  return normalizeTerritoryIntents(territoryMemory.intents)
    .filter((intent): intent is TerritoryIntentMemory & { status: 'planned' | 'active' } =>
      isTerritoryIntentProgressVisibleForColony(intent, colony, gameTime)
    )
    .map((intent): TerritoryIntentProgressSummary => {
      const activeCreepCount = getTerritoryCreepCountForTarget(roleCounts, intent.targetRoom, intent.action);
      return {
        colony: intent.colony,
        targetRoom: intent.targetRoom,
        action: intent.action,
        status: intent.status,
        updatedAt: intent.updatedAt,
        activeCreepCount,
        adjacentToColony: isRoomAdjacentToColony(intent.colony, intent.targetRoom),
        ...(intent.controllerId ? { controllerId: intent.controllerId } : {}),
        ...(intent.requiresControllerPressure ? { requiresControllerPressure: true } : {}),
        ...(intent.followUp ? { followUp: intent.followUp } : {})
      };
    })
    .sort(compareTerritoryIntentProgressSummaries);
}

export function getSuspendedTerritoryIntentCountsByRoom(
  colony: string | null | undefined,
  gameTime = getGameTime()
): Record<string, number> {
  if (!isNonEmptyString(colony)) {
    return {};
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return {};
  }

  const countsByRoom: Record<string, number> = {};
  for (const intent of normalizeTerritoryIntents(territoryMemory.intents)) {
    if (intent.colony !== colony || !isTerritoryIntentSuspensionActive(intent, gameTime)) {
      continue;
    }

    countsByRoom[intent.targetRoom] = (countsByRoom[intent.targetRoom] ?? 0) + 1;
  }

  return countsByRoom;
}

function isTerritoryIntentProgressVisibleForColony(
  intent: TerritoryIntentMemory,
  colony: string,
  gameTime: number
): intent is TerritoryIntentMemory & { status: 'planned' | 'active' } {
  return (
    intent.colony === colony &&
    (intent.status === 'planned' || intent.status === 'active') &&
    !isTerritoryIntentSuspensionActive(intent, gameTime)
  );
}

export function buildTerritoryCreepMemory(plan: TerritoryIntentPlan): CreepMemory {
  return {
    role: plan.action === 'scout' ? TERRITORY_SCOUT_ROLE : TERRITORY_CLAIMER_ROLE,
    colony: plan.colony,
    territory: {
      targetRoom: plan.targetRoom,
      action: plan.action,
      ...(plan.controllerId ? { controllerId: plan.controllerId } : {}),
      ...(plan.followUp ? { followUp: plan.followUp } : {})
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
    return canCreepActOnVisibleReserveController(creep, controller, intent.colony)
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

export function canCreepPressureTerritoryController(
  creep: Creep,
  controller: StructureController,
  colony: string | undefined
): boolean {
  return (
    getActiveControllerClaimPartCount(creep) >= TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS &&
    isForeignReservedController(controller, getTerritoryActorUsername(creep, colony))
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
    return shouldSignOccupiedController(controller);
  }

  const actorUsername = getTerritoryActorUsername(creep, colony);
  const targetState = getTerritoryControllerTargetState(controller, assignment.action, actorUsername);
  const isPressureTarget = isForeignReservedController(controller, actorUsername);
  if (isPressureTarget) {
    return creep === undefined || canCreepPressureTerritoryController(creep, controller, colony);
  }

  return (
    targetState === 'available' ||
    (assignment.action === 'reserve' && targetState === 'satisfied')
  );
}

export function isVisibleTerritoryAssignmentComplete(
  assignment: CreepTerritoryMemory,
  creep?: Creep
): boolean {
  if (assignment.action !== 'claim' || !isNonEmptyString(assignment.targetRoom)) {
    return false;
  }

  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  return controller?.my === true && !shouldSignOccupiedController(controller);
}

export function isVisibleTerritoryAssignmentAwaitingUnsafeSigningRetry(
  assignment: CreepTerritoryMemory,
  creep?: Creep
): boolean {
  if (assignment.action !== 'claim' || !isNonEmptyString(assignment.targetRoom)) {
    return false;
  }

  if (!isVisibleRoomUnsafeForTerritoryControllerWork(assignment.targetRoom)) {
    return false;
  }

  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  return controller?.my === true && shouldSignOccupiedController(controller);
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
  const followUp = normalizeTerritoryFollowUp(assignment.followUp);
  const requiresControllerPressure = getPersistedTerritoryIntentPressureRequirement(
    intents,
    colony,
    assignment.targetRoom,
    assignment.action,
    assignment.controllerId
  );
  const suppressedIntent: TerritoryIntentMemory = {
    colony,
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: 'suppressed',
    updatedAt: gameTime,
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {}),
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(followUp ? { followUp } : {})
  };

  upsertTerritoryIntent(intents, suppressedIntent);
  removeTerritoryFollowUpDemand(territoryMemory, colony, assignment.targetRoom, assignment.action);
  removeTerritoryFollowUpExecutionHint(territoryMemory, colony, assignment.targetRoom, assignment.action);
}

function suppressSameRoomClaimTerritoryIntents(
  territoryMemory: TerritoryMemory,
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  gameTime: number
): void {
  let hasSuppressedClaimIntent = false;
  for (let i = 0; i < intents.length; i += 1) {
    const intent = intents[i];
    if (intent.colony !== colony || intent.targetRoom !== targetRoom || intent.action !== 'claim') {
      continue;
    }

    intents[i] = {
      ...intent,
      status: 'suppressed',
      updatedAt: gameTime
    };
    removeTerritoryFollowUpDemand(territoryMemory, colony, targetRoom, 'claim');
    removeTerritoryFollowUpExecutionHint(territoryMemory, colony, targetRoom, 'claim');
    hasSuppressedClaimIntent = true;
  }

  if (!hasSuppressedClaimIntent) {
    return;
  }

  setTerritoryIntents(territoryMemory, intents);
}

export function recordTerritoryReserveFallbackIntent(
  colony: string | undefined,
  assignment: CreepTerritoryMemory,
  gameTime: number
): CreepTerritoryMemory | null {
  if (
    !isNonEmptyString(colony) ||
    !isNonEmptyString(assignment.targetRoom) ||
    assignment.action !== 'reserve' ||
    isTerritoryIntentSuppressed(colony, assignment.targetRoom, 'reserve', gameTime)
  ) {
    return null;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  suppressSameRoomClaimTerritoryIntents(territoryMemory, intents, colony, assignment.targetRoom, gameTime);
  const followUp = getTerritoryReserveFallbackFollowUp(assignment, intents, colony, gameTime);
  const requiresControllerPressure = getPersistedTerritoryIntentPressureRequirement(
    intents,
    colony,
    assignment.targetRoom,
    'reserve',
    assignment.controllerId
  );
  const reserveAssignment: CreepTerritoryMemory = {
    targetRoom: assignment.targetRoom,
    action: 'reserve',
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {}),
    ...(followUp ? { followUp } : {})
  };
  const plan: TerritoryIntentPlan = {
    colony,
    targetRoom: assignment.targetRoom,
    action: 'reserve',
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {}),
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(followUp ? { followUp } : {})
  };
  appendTerritoryTargetIfMissing(territoryMemory, {
    colony,
    roomName: assignment.targetRoom,
    action: 'reserve',
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {})
  });

  upsertTerritoryIntent(intents, {
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    status: 'active',
    updatedAt: gameTime,
    ...(plan.controllerId ? { controllerId: plan.controllerId } : {}),
    ...(plan.createdBy ? { createdBy: plan.createdBy } : {}),
    ...(plan.requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(plan.followUp ? { followUp: plan.followUp } : {})
  });
  recordTerritoryFollowUpDemand(territoryMemory, plan, gameTime);
  recordTerritoryFollowUpExecutionHint(territoryMemory, plan, gameTime);
  return reserveAssignment;
}

export function recordAutonomousExpansionClaimReserveFallbackIntent(
  colony: string | undefined,
  evaluation: AutonomousExpansionClaimEvaluation,
  gameTime: number
): CreepTerritoryMemory | null {
  if (
    evaluation.status !== 'skipped' ||
    (evaluation.reason !== 'gclInsufficient' && evaluation.reason !== 'controllerCooldown') ||
    !isNonEmptyString(colony) ||
    !isNonEmptyString(evaluation.targetRoom) ||
    isTerritoryIntentSuppressed(colony, evaluation.targetRoom, 'reserve', gameTime)
  ) {
    return null;
  }

  const targetRoom = evaluation.targetRoom;
  if (!isNonEmptyString(targetRoom)) {
    return null;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const colonyOwnerUsername = getVisibleColonyOwnerUsername(colony);
  if (!isNonEmptyString(colonyOwnerUsername)) {
    return null;
  }

  const controller = getVisibleController(targetRoom, evaluation.controllerId);
  if (!controller || isControllerOwned(controller) || isForeignReservedController(controller, colonyOwnerUsername)) {
    return null;
  }

  if (isOwnReservedController(controller, colonyOwnerUsername)) {
    const reservationTicksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
    if (reservationTicksToEnd === null || reservationTicksToEnd >= TERRITORY_RESERVATION_TICKS) {
      return null;
    }
  }

  updateTerritoryReservationMemory(
    territoryMemory,
    colony,
    targetRoom,
    evaluation.controllerId,
    gameTime,
    getOwnReservationTicksToEnd(controller, colonyOwnerUsername)
  );
  return recordTerritoryReserveFallbackIntent(
    colony,
    {
      targetRoom,
      action: 'reserve',
      ...(evaluation.controllerId ? { controllerId: evaluation.controllerId } : {})
    },
    gameTime
  );
}

export function refreshRemoteMiningSetup(colony: ColonySnapshot, gameTime = getGameTime()): void {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const colonyName = colony.room.name;
  const records = getRemoteMiningBootstrapRecords(territoryMemory, colonyName);
  const storedRemoteMining = territoryMemory.remoteMining;
  if (storedRemoteMining === undefined && records.length === 0) {
    return;
  }

  let remoteMining: Record<string, TerritoryRemoteMiningRoomMemory>;
  if (isRecord(storedRemoteMining) && !Array.isArray(storedRemoteMining)) {
    remoteMining = storedRemoteMining as Record<string, TerritoryRemoteMiningRoomMemory>;
  } else {
    remoteMining = {};
    territoryMemory.remoteMining = remoteMining;
  }
  const activeKeys = new Set<string>();

  for (const record of records) {
    const key = getRemoteMiningMemoryKey(record.colony, record.roomName);
    activeKeys.add(key);

    const room = getVisibleRoom(record.roomName);
    if (!room) {
      const previous = remoteMining[key];
      updateRemoteMiningRoomMemoryIfChanged(
        remoteMining,
        key,
        {
          colony: record.colony,
          roomName: record.roomName,
          status: previous?.status ?? 'containerPending',
          sources: previous?.sources ?? {}
        },
        gameTime
      );
      continue;
    }

    if (isHostileOwnedController(room.controller)) {
      updateRemoteMiningRoomMemoryIfChanged(
        remoteMining,
        key,
        {
          colony: record.colony,
          roomName: record.roomName,
          status: 'unclaimed',
          sources: {}
        },
        gameTime
      );
      continue;
    }

    const suspended = isRemoteMiningSuspended(territoryMemory, record.colony, record.roomName, gameTime);
    if (!suspended) {
      planSourceContainerConstruction(
        {
          room,
          spawns: [],
          energyAvailable: room.energyAvailable,
          energyCapacityAvailable: room.energyCapacityAvailable
        },
        {
          anchor: room.controller?.pos ?? null,
          minimumControllerLevel: REMOTE_MINING_SOURCE_CONTAINER_MIN_RCL
        }
      );
    }

    const sources = getRemoteMiningSources(room);
    const assignedCreeps = getRemoteMiningAssignedCreeps(record.colony, record.roomName);
    const sourceStates = Object.fromEntries(
      sources.map((source) => {
        const container = findSourceContainer(room, source);
        const pendingSite = findSourceContainerConstructionSite(room, source);
        const sourceId = String(source.id);
        const state: TerritoryRemoteMiningSourceMemory = {
          sourceId,
          ...(container ? { containerId: String(container.id) } : {}),
          containerBuilt: container !== null,
          containerSitePending: pendingSite !== null,
          harvesterAssigned: hasAssignedRemoteHarvester(assignedCreeps, record.colony, record.roomName, sourceId),
          haulerAssigned: hasAssignedRemoteHauler(assignedCreeps, record.colony, record.roomName, sourceId, container),
          energyAvailable: container ? getStoredEnergy(container) : 0,
          energyFlowing: container !== null && hasRemoteEnergyFlow(container, assignedCreeps, record, sourceId)
        };
        return [sourceId, state];
      })
    );

    updateRemoteMiningRoomMemoryIfChanged(
      remoteMining,
      key,
      {
        colony: record.colony,
        roomName: record.roomName,
        status: suspended ? 'suspended' : getRemoteMiningStatus(Object.values(sourceStates)),
        sources: sourceStates
      },
      gameTime
    );
  }

  for (const key of Object.keys(remoteMining)) {
    if (key.startsWith(`${colonyName}:`) && !activeKeys.has(key)) {
      delete remoteMining[key];
    }
  }
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

function selectTerritoryTarget(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number,
  options: TerritoryTargetSelectionOptions = {}
): SelectedTerritoryTarget | null {
  const colonyName = colony.room.name;
  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller);
  const territoryMemory = getTerritoryMemoryRecord();
  let intents = normalizeTerritoryIntents(territoryMemory?.intents);
  const refreshedHostileSuspensions = refreshHostileTerritoryIntentSuspensions(
    territoryMemory,
    intents,
    colonyName,
    gameTime
  );
  if (refreshedHostileSuspensions.changed) {
    intents = refreshedHostileSuspensions.intents;
  }
  const sanitizedClaimReserveHandoffs = sanitizeSatisfiedClaimReserveHandoffs(
    territoryMemory,
    intents,
    colonyName,
    colonyOwnerUsername
  );
  if (sanitizedClaimReserveHandoffs.changed) {
    intents = sanitizedClaimReserveHandoffs.intents;
  }
  const sanitizedStaleProgress = sanitizeStaleTerritoryProgressIntents(
    territoryMemory,
    intents,
    colonyName,
    colonyOwnerUsername,
    roleCounts,
    gameTime
  );
  if (sanitizedStaleProgress.changed) {
    intents = sanitizedStaleProgress.intents;
  }
  const routeDistanceLookupContext = createRouteDistanceLookupContext();
  refreshTerritoryReservationMemory(territoryMemory, colonyName, colonyOwnerUsername, gameTime);
  const deadZoneSuppression = suppressDeadZoneTerritoryTargets(
    territoryMemory,
    intents,
    colonyName,
    gameTime,
    routeDistanceLookupContext
  );
  if (deadZoneSuppression.changed) {
    intents = deadZoneSuppression.intents;
  }
  refreshTerritoryFollowUpExecutionHints(territoryMemory, intents, routeDistanceLookupContext);
  const hasBlockingConfiguredTarget = hasBlockingConfiguredTerritoryTargetForColony(
    colony,
    territoryMemory,
    colonyName,
    colonyOwnerUsername,
    intents,
    gameTime,
    roleCounts,
    routeDistanceLookupContext
  );
  const configuredCandidates = applyOccupationRecommendationScores(
    colony,
    roleCounts,
    workerTarget,
    getConfiguredTerritoryCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      roleCounts,
      routeDistanceLookupContext
    )
  );
  const persistedIntentCandidates = applyOccupationRecommendationScores(
    colony,
    roleCounts,
    workerTarget,
    getPersistedTerritoryIntentCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      routeDistanceLookupContext
    )
  );
  const primaryCandidates = getSpawnCapableTerritoryCandidates(
    filterTerritoryCandidatesForPlanningOptions(
      [...persistedIntentCandidates, ...configuredCandidates],
      options
    ),
    colony
  );
  const bestReadyPrimaryCandidate = selectBestScoredTerritoryCandidate(
    getReadyTerritoryCandidates(primaryCandidates, roleCounts, colony)
  );
  if (
    bestReadyPrimaryCandidate &&
    bestReadyPrimaryCandidate.priority <= MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY
  ) {
    const shouldEvaluateAdjacentControllerProgress = shouldEvaluateVisibleAdjacentControllerProgressPreference(
      bestReadyPrimaryCandidate,
      colony,
      roleCounts,
      workerTarget
    );
    const shouldEvaluateAdjacentFollowUp = shouldEvaluateVisibleAdjacentFollowUpPreference(bestReadyPrimaryCandidate);
    if (!shouldEvaluateAdjacentControllerProgress && !shouldEvaluateAdjacentFollowUp) {
      return toSelectedTerritoryTarget(bestReadyPrimaryCandidate, routeDistanceLookupContext);
    }

    const visibleAdjacentControllerProgressCandidates = filterTerritoryCandidatesForPlanningOptions(
      applyOccupationRecommendationScores(
        colony,
        roleCounts,
        workerTarget,
        [
          ...(shouldEvaluateAdjacentControllerProgress
            ? getVisibleAdjacentReserveCandidates(
                colonyName,
                colonyOwnerUsername,
                territoryMemory,
                intents,
                gameTime,
                routeDistanceLookupContext
              )
            : []),
          ...(shouldEvaluateAdjacentFollowUp
            ? getVisibleAdjacentFollowUpReserveCandidates(
                colonyName,
                colonyOwnerUsername,
                territoryMemory,
                intents,
                gameTime,
                roleCounts,
                routeDistanceLookupContext
              )
            : [])
        ]
      ),
      options
    );
    if (visibleAdjacentControllerProgressCandidates.length === 0) {
      return toSelectedTerritoryTarget(bestReadyPrimaryCandidate, routeDistanceLookupContext);
    }

    return toSelectedTerritoryTarget(
      selectBestScoredTerritoryCandidate(
        getReadyTerritoryCandidates(
          [...primaryCandidates, ...visibleAdjacentControllerProgressCandidates],
          roleCounts,
          colony
        )
      ) ?? bestReadyPrimaryCandidate,
      routeDistanceLookupContext
    );
  }

  const adjacentCandidates = filterTerritoryCandidatesForPlanningOptions(
    applyOccupationRecommendationScores(colony, roleCounts, workerTarget, [
      ...getAdjacentReserveCandidates(
        colonyName,
        colonyName,
        colonyOwnerUsername,
        territoryMemory,
        intents,
        gameTime,
        !hasBlockingConfiguredTarget,
        'adjacent',
        0,
        routeDistanceLookupContext
      ),
      ...getAdjacentFollowUpReserveCandidates(
        colonyName,
        colonyOwnerUsername,
        territoryMemory,
        intents,
        gameTime,
        roleCounts,
        !hasBlockingConfiguredTarget,
        routeDistanceLookupContext
      )
    ]),
    options
  );
  const candidates = getSpawnCapableTerritoryCandidates([...primaryCandidates, ...adjacentCandidates], colony);

  return toSelectedTerritoryTarget(
    selectBestScoredTerritoryCandidate(getReadyTerritoryCandidates(candidates, roleCounts, colony)) ??
      selectBestScoredTerritoryCandidate(getActionableTerritoryCandidates(candidates, roleCounts, colony)) ??
      selectBestScoredTerritoryCandidate(candidates),
    routeDistanceLookupContext
  );
}

function filterTerritoryCandidatesForPlanningOptions(
  candidates: ScoredTerritoryTarget[],
  options: TerritoryTargetSelectionOptions
): ScoredTerritoryTarget[] {
  if (options.controllerPressureOnly === true) {
    const pressureCandidates = candidates.filter(isControllerPressureCandidate);
    if (pressureCandidates.length > 0 || options.followUpOnly !== true) {
      return pressureCandidates;
    }
  }

  if (options.followUpOnly === true) {
    return candidates.filter(isTerritoryFollowUpControlCandidate);
  }

  return candidates;
}

function isControllerPressureCandidate(candidate: ScoredTerritoryTarget): boolean {
  return isTerritoryControlAction(candidate.intentAction) && candidate.requiresControllerPressure === true;
}

function isTerritoryFollowUpControlCandidate(candidate: ScoredTerritoryTarget): boolean {
  return candidate.followUp !== undefined && isTerritoryControlAction(candidate.intentAction);
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

function toSelectedTerritoryTarget(
  candidate: ScoredTerritoryTarget | null,
  routeDistanceLookupContext?: RouteDistanceLookupContext
): SelectedTerritoryTarget | null {
  return candidate
    ? {
        target: candidate.target,
        intentAction: candidate.intentAction,
        commitTarget: candidate.commitTarget,
        ...(candidate.requiresControllerPressure ? { requiresControllerPressure: true } : {}),
        ...(candidate.followUp ? { followUp: candidate.followUp } : {}),
        ...(candidate.recoveredFollowUp ? { recoveredFollowUp: true } : {}),
        ...(typeof candidate.recoveredFollowUpSuppressedAt === 'number'
          ? { recoveredFollowUpSuppressedAt: candidate.recoveredFollowUpSuppressedAt }
          : {}),
        ...(routeDistanceLookupContext ? { routeDistanceLookupContext } : {})
      }
    : null;
}

function shouldEvaluateVisibleAdjacentControllerProgressPreference(
  candidate: ScoredTerritoryTarget,
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number
): boolean {
  return (
    candidate.priority === TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE &&
    candidate.target.action === 'reserve' &&
    isPrimaryTerritoryCandidateSource(candidate.source) &&
    typeof candidate.routeDistance === 'number' &&
    candidate.routeDistance > 1 &&
    isTerritoryHomeReadyForAdjacentControllerProgress(colony, roleCounts, workerTarget)
  );
}

function shouldEvaluateVisibleAdjacentFollowUpPreference(candidate: ScoredTerritoryTarget): boolean {
  return candidate.priority === TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE && candidate.target.action === 'reserve';
}

function isTerritoryHomeReadyForAdjacentControllerProgress(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number
): boolean {
  return (
    getWorkerCapacity(roleCounts) >= workerTarget + TERRITORY_ADJACENT_CONTROLLER_PROGRESS_WORKER_SURPLUS &&
    colony.energyAvailable >= TERRITORY_CONTROLLER_BODY_COST &&
    colony.energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST &&
    colony.spawns.some((spawn) => spawn.spawning == null)
  );
}

function getReadyTerritoryCandidates(
  candidates: ScoredTerritoryTarget[],
  roleCounts: RoleCounts,
  colony: ColonySnapshot
): ScoredTerritoryTarget[] {
  return withImmediateControllerFollowUpState(candidates, roleCounts).filter(
    (candidate) =>
      candidate.immediateControllerFollowUp === true ||
      (isTerritoryCandidateSpawnRequired(candidate, roleCounts) &&
        isTerritoryCandidateSpawnReady(candidate, colony))
  );
}

function getActionableTerritoryCandidates(
  candidates: ScoredTerritoryTarget[],
  roleCounts: RoleCounts,
  colony: ColonySnapshot
): ScoredTerritoryTarget[] {
  return withImmediateControllerFollowUpState(candidates, roleCounts).filter(
    (candidate) =>
      !isTerritoryCandidateSpawnRequired(candidate, roleCounts) || isTerritoryCandidateSpawnReady(candidate, colony)
  );
}

function getSpawnCapableTerritoryCandidates(
  candidates: ScoredTerritoryTarget[],
  colony: ColonySnapshot
): ScoredTerritoryTarget[] {
  return candidates.filter((candidate) => isTerritoryCandidateSpawnCapable(candidate, colony));
}

function withImmediateControllerFollowUpState(
  candidates: ScoredTerritoryTarget[],
  roleCounts: RoleCounts
): ScoredTerritoryTarget[] {
  return candidates.map((candidate) => {
    if (!isImmediateControllerFollowUpCandidate(candidate, roleCounts)) {
      return candidate;
    }

    return {
      ...candidate,
      immediateControllerFollowUp: true
    };
  });
}

function isImmediateControllerFollowUpCandidate(
  candidate: ScoredTerritoryTarget,
  roleCounts: RoleCounts
): boolean {
  return (
    candidate.followUp !== undefined &&
    isTerritoryControlAction(candidate.intentAction) &&
    getTerritoryCreepCountForTarget(roleCounts, candidate.target.roomName, candidate.intentAction) > 0
  );
}

function isTerritoryCandidateSpawnRequired(candidate: ScoredTerritoryTarget, roleCounts: RoleCounts): boolean {
  const activeCoverageCount = getTerritoryCreepCountForTarget(
    roleCounts,
    candidate.target.roomName,
    candidate.intentAction
  );
  return activeCoverageCount === 0 || shouldSpawnEmergencyReservationRenewalCandidate(candidate, activeCoverageCount);
}

function isTerritoryCandidateSpawnReady(candidate: ScoredTerritoryTarget, colony: ColonySnapshot): boolean {
  const bodyCost = getTerritoryCandidateBodyCost(candidate);
  return colony.energyCapacityAvailable >= bodyCost && colony.energyAvailable >= bodyCost;
}

function isTerritoryIntentActionSpawnReady(
  colony: ColonySnapshot,
  action: TerritoryIntentAction,
  requiresControllerPressure = false
): boolean {
  const bodyCost = getTerritoryIntentActionBodyCost(action, requiresControllerPressure);
  return colony.energyCapacityAvailable >= bodyCost && colony.energyAvailable >= bodyCost;
}

function isTerritoryCandidateSpawnCapable(candidate: ScoredTerritoryTarget, colony: ColonySnapshot): boolean {
  return colony.energyCapacityAvailable >= getTerritoryCandidateBodyCost(candidate);
}

function getTerritoryCandidateBodyCost(candidate: ScoredTerritoryTarget): number {
  return getTerritoryIntentActionBodyCost(
    candidate.intentAction,
    candidate.requiresControllerPressure === true
  );
}

function getTerritoryIntentActionBodyCost(
  action: TerritoryIntentAction,
  requiresControllerPressure = false
): number {
  if (isTerritoryControlAction(action) && requiresControllerPressure) {
    return TERRITORY_CONTROLLER_PRESSURE_BODY_COST;
  }

  return action === 'scout' ? TERRITORY_SCOUT_BODY_COST : TERRITORY_CONTROLLER_BODY_COST;
}

function shouldSpawnEmergencyReservationRenewalCandidate(
  candidate: ScoredTerritoryTarget,
  activeCoverageCount: number
): boolean {
  return (
    activeCoverageCount < TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET &&
    candidate.intentAction === 'reserve' &&
    typeof candidate.renewalTicksToEnd === 'number' &&
    candidate.renewalTicksToEnd <= TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS
  );
}

function getConfiguredTerritoryCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  roleCounts: RoleCounts,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }

  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.roomName === colonyName) {
      return [];
    }

    const actionForTarget = getConfiguredTerritoryCandidateAction(target, colonyOwnerUsername, territoryMemory, gameTime);
    const actionableTarget = actionForTarget === target.action ? target : { ...target, action: actionForTarget };
    const ignoreOwnHealthyReservation = actionableTarget.action === 'claim';
    const isConfiguredTerritoryTargetActionable = isVisibleTerritoryIntentActionable(
      actionableTarget.roomName,
      actionableTarget.action,
      actionableTarget.controllerId,
      colonyOwnerUsername
    );
    if (
      isTerritoryTargetSuppressed(actionableTarget, intents, gameTime) ||
      isTerritoryIntentSuspendedForAction(
        intents,
        actionableTarget.colony,
        actionableTarget.roomName,
        actionableTarget.action,
        gameTime
      ) ||
      isClaimTargetDeferredBySameRoomReserveLane(
        actionableTarget,
        intents,
        roleCounts,
        colonyOwnerUsername,
        gameTime
      ) ||
      isKnownDeadZoneRoom(actionableTarget.roomName) ||
      isConfiguredReserveScoutDeferredByReservationDecay(
        actionableTarget,
        territoryMemory,
        gameTime,
        routeDistanceLookupContext
      ) ||
      !isConfiguredTerritoryTargetActionable
    ) {
      return [];
    }

    const persistedFollowUp = getPersistedTerritoryIntentFollowUp(
      intents,
      actionableTarget.colony,
      actionableTarget.roomName,
      actionableTarget.action,
      gameTime,
      actionableTarget.controllerId
    );
    if (persistedFollowUp?.coolingDown) {
      return [];
    }
    const requiresControllerPressure =
      persistedFollowUp?.requiresControllerPressure === true ||
      getPersistedTerritoryIntentPressureRequirement(
        intents,
        actionableTarget.colony,
        actionableTarget.roomName,
        actionableTarget.action,
        actionableTarget.controllerId
      );

    const candidate = scoreTerritoryCandidate(
      {
        target: actionableTarget,
        intentAction: actionableTarget.action,
        commitTarget: false,
        ...(ignoreOwnHealthyReservation ? { ignoreOwnHealthyReservation: true } : {}),
        ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
        ...(persistedFollowUp ? { followUp: persistedFollowUp.followUp } : {}),
        ...(persistedFollowUp ? { persistedFollowUp: true } : {}),
        ...(persistedFollowUp?.recovered ? { recoveredFollowUp: true } : {}),
        ...(typeof persistedFollowUp?.suppressedAt === 'number'
          ? { recoveredFollowUpSuppressedAt: persistedFollowUp.suppressedAt }
          : {})
      },
      'configured',
      order,
      colonyName,
      colonyOwnerUsername,
      routeDistanceLookupContext
    );
    return candidate ? [candidate] : [];
  });
}

function getConfiguredTerritoryCandidateAction(
  target: TerritoryTargetMemory,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  gameTime: number
): TerritoryControlAction {
  if (target.action !== 'reserve' || !isNonEmptyString(colonyOwnerUsername)) {
    return target.action;
  }

  const controller = getVisibleController(target.roomName, target.controllerId);
  const visibleTicksToEnd = controller ? getOwnReservationTicksToEnd(controller, colonyOwnerUsername) : null;
  if (visibleTicksToEnd !== null && visibleTicksToEnd <= TERRITORY_CLAIM_READY_TICKS) {
    return 'claim';
  }

  const storedReservation = getStoredTerritoryReservation(territoryMemory, target);
  if (storedReservation === null) {
    return target.action;
  }

  return getEstimatedTerritoryReservationTicksToEnd(storedReservation, gameTime) <= TERRITORY_CLAIM_READY_TICKS
    ? 'claim'
    : target.action;
}

function getPersistedTerritoryIntentCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  const seenIntentKeys = new Set<string>();
  const configuredTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  return intents.flatMap((intent, order) => {
    const recoveredFollowUp = isRecoveredTerritoryFollowUpIntent(intent, gameTime);
    if (
      intent.colony !== colonyName ||
      intent.targetRoom === colonyName ||
      configuredTargetRooms.has(intent.targetRoom) ||
      isKnownDeadZoneRoom(intent.targetRoom) ||
      isRecoveredTerritoryFollowUpAttemptCoolingDown(intent, gameTime) ||
      (intent.status !== 'planned' && intent.status !== 'active' && !recoveredFollowUp) ||
      !isTerritoryControlAction(intent.action) ||
      isTerritoryIntentSuspensionActive(intent, gameTime) ||
      isSuppressedTerritoryIntentForAction(intents, colonyName, intent.targetRoom, intent.action, gameTime) ||
      !isVisibleTerritoryIntentActionable(intent.targetRoom, intent.action, intent.controllerId, colonyOwnerUsername)
    ) {
      return [];
    }

    const intentKey = `${intent.targetRoom}:${intent.action}`;
    if (seenIntentKeys.has(intentKey)) {
      return [];
    }
    seenIntentKeys.add(intentKey);

    const target: TerritoryTargetMemory = {
      colony: intent.colony,
      roomName: intent.targetRoom,
      action: intent.action,
      ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
    };
    const requiresControllerPressure = shouldPreservePersistedTerritoryIntentPressureRequirement(intent);
    const candidate = scoreTerritoryCandidate(
      {
        target,
        intentAction: intent.action,
        commitTarget: false,
        ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
        ...(intent.followUp ? { followUp: intent.followUp } : {}),
        ...(intent.followUp ? { persistedFollowUp: true } : {}),
        ...(recoveredFollowUp ? { recoveredFollowUp: true, recoveredFollowUpSuppressedAt: intent.updatedAt } : {})
      },
      'occupationIntent',
      order,
      colonyName,
      colonyOwnerUsername,
      routeDistanceLookupContext
    );

    return candidate ? [candidate] : [];
  });
}

function hasBlockingConfiguredTerritoryTargetForColony(
  colony: ColonySnapshot,
  territoryMemory: Record<string, unknown> | null,
  colonyName: string,
  colonyOwnerUsername: string | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  roleCounts: RoleCounts,
  routeDistanceLookupContext: RouteDistanceLookupContext
): boolean {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return false;
  }

  return territoryMemory.targets.some((rawTarget) => {
    const target = normalizeTerritoryTarget(rawTarget);
    if (!target || target.colony !== colonyName) {
      return false;
    }

    if (hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext)) {
      return false;
    }

    if (target.enabled === false || target.roomName === colonyName) {
      return true;
    }

    if (isKnownDeadZoneRoom(target.roomName)) {
      return false;
    }

    if (isClaimTargetDeferredBySameRoomReserveLane(target, intents, roleCounts, colonyOwnerUsername, gameTime)) {
      return false;
    }

    if (isTerritoryTargetSuppressed(target, intents, gameTime)) {
      return true;
    }

    if (
      isRecoveredTerritoryFollowUpAttemptCoolingDownForAction(
        intents,
        colonyName,
        target.roomName,
        target.action,
        gameTime
      )
    ) {
      return false;
    }

    if (getTerritoryCreepCountForTarget(roleCounts, target.roomName, target.action) > 0) {
      return false;
    }

    if (isConfiguredFollowUpTargetBlockedBySpawnReadiness(target, intents, gameTime, colony)) {
      return false;
    }

    if (
      isVisibleTerritoryReservePressureAvailable(target.roomName, target.action, target.controllerId, colonyOwnerUsername) &&
      colony.energyCapacityAvailable < TERRITORY_CONTROLLER_PRESSURE_BODY_COST
    ) {
      return false;
    }

    return (
      getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !==
      'satisfied'
    );
  });
}

function refreshTerritoryReservationMemory(
  territoryMemory: Record<string, unknown> | null,
  colonyName: string,
  colonyOwnerUsername: string | null,
  gameTime: number
): void {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return;
  }

  const reservations = normalizeTerritoryReservations(territoryMemory.reservations);
  const activeConfiguredReserveKeys = new Set<string>();
  let changed = hasMalformedTerritoryReservationMemory(territoryMemory.reservations, reservations);

  for (const rawTarget of territoryMemory.targets) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.enabled === false ||
      target.colony !== colonyName ||
      target.action !== 'reserve' ||
      target.roomName === colonyName
    ) {
      continue;
    }

    const reservationKey = getTerritoryReservationMemoryKey(target.colony, target.roomName);
    activeConfiguredReserveKeys.add(reservationKey);
    const controller = getVisibleController(target.roomName, target.controllerId);
    if (!controller) {
      continue;
    }

    const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
    if (ticksToEnd === null) {
      if (reservations[reservationKey]) {
        delete reservations[reservationKey];
        changed = true;
      }
      continue;
    }

    const nextReservation: TerritoryReservationMemory = {
      colony: target.colony,
      roomName: target.roomName,
      ticksToEnd,
      updatedAt: gameTime,
      ...(target.controllerId ? { controllerId: target.controllerId } : {})
    };
    if (!isSameTerritoryReservation(reservations[reservationKey], nextReservation)) {
      reservations[reservationKey] = nextReservation;
      changed = true;
    }
  }

  for (const [reservationKey, reservation] of Object.entries(reservations)) {
    if (
      reservation.colony === colonyName &&
      (!activeConfiguredReserveKeys.has(reservationKey) ||
        getEstimatedTerritoryReservationTicksToEnd(reservation, gameTime) <= 0)
    ) {
      delete reservations[reservationKey];
      changed = true;
    }
  }

  if (changed) {
    setTerritoryReservations(territoryMemory, reservations);
  }
}

function isConfiguredReserveScoutDeferredByReservationDecay(
  target: TerritoryTargetMemory,
  territoryMemory: Record<string, unknown> | null,
  gameTime: number,
  routeDistanceLookupContext: RouteDistanceLookupContext
): boolean {
  if (target.action !== 'reserve' || isVisibleRoomKnown(target.roomName)) {
    return false;
  }

  const reservation = getStoredTerritoryReservation(territoryMemory, target);
  if (!reservation) {
    return false;
  }

  return (
    getEstimatedTerritoryReservationTicksToEnd(reservation, gameTime) >
    getTerritoryReservationPreRenewScoutLeadTicks(
      target.colony,
      target.roomName,
      routeDistanceLookupContext
    )
  );
}

function getStoredTerritoryReservation(
  territoryMemory: Record<string, unknown> | null,
  target: TerritoryTargetMemory
): TerritoryReservationMemory | null {
  if (!territoryMemory) {
    return null;
  }

  const reservation = normalizeTerritoryReservation(
    isRecord(territoryMemory.reservations)
      ? territoryMemory.reservations[getTerritoryReservationMemoryKey(target.colony, target.roomName)]
      : undefined
  );
  if (
    !reservation ||
    reservation.colony !== target.colony ||
    reservation.roomName !== target.roomName ||
    (target.controllerId !== undefined &&
      reservation.controllerId !== undefined &&
      reservation.controllerId !== target.controllerId)
  ) {
    return null;
  }

  return reservation;
}

function getTerritoryReservationPreRenewScoutLeadTicks(
  colonyName: string,
  targetRoom: string,
  routeDistanceLookupContext: RouteDistanceLookupContext
): number {
  const routeDistance = getKnownRouteLength(colonyName, targetRoom, routeDistanceLookupContext);
  return (
    TERRITORY_RESERVATION_RENEWAL_TICKS +
    (typeof routeDistance === 'number'
      ? routeDistance * TERRITORY_RESERVATION_PRE_RENEW_SCOUT_ROUTE_TICKS * 2
      : 0)
  );
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

function hasMalformedTerritoryReservationMemory(
  rawReservations: unknown,
  reservations: Record<string, TerritoryReservationMemory>
): boolean {
  return isRecord(rawReservations) && Object.keys(rawReservations).length !== Object.keys(reservations).length;
}

function getTerritoryReservationMemoryKey(colonyName: string, roomName: string): string {
  return `${colonyName}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${roomName}`;
}

function getEstimatedTerritoryReservationTicksToEnd(
  reservation: TerritoryReservationMemory,
  gameTime: number
): number {
  return Math.max(0, reservation.ticksToEnd - Math.max(0, gameTime - reservation.updatedAt));
}

function isSameTerritoryReservation(
  left: TerritoryReservationMemory | undefined,
  right: TerritoryReservationMemory
): boolean {
  return (
    left !== undefined &&
    left.colony === right.colony &&
    left.roomName === right.roomName &&
    left.ticksToEnd === right.ticksToEnd &&
    left.updatedAt === right.updatedAt &&
    left.controllerId === right.controllerId
  );
}

function setTerritoryReservations(
  territoryMemory: TerritoryMemory | Record<string, unknown>,
  reservations: Record<string, TerritoryReservationMemory>
): void {
  if (Object.keys(reservations).length > 0) {
    territoryMemory.reservations = reservations;
  } else {
    delete territoryMemory.reservations;
  }
}

function suppressDeadZoneTerritoryTargets(
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  colonyName: string,
  gameTime: number,
  routeDistanceLookupContext: RouteDistanceLookupContext
): { intents: TerritoryIntentMemory[]; changed: boolean } {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return { intents, changed: false };
  }

  let nextIntents = intents;
  let changed = false;
  for (const rawTarget of territoryMemory.targets) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.roomName === colonyName) {
      continue;
    }

    const reason = getTerritoryDeadZoneSuppressionReason(
      colonyName,
      target.roomName,
      routeDistanceLookupContext
    );
    if (!reason) {
      const filteredIntents = removeDeadZoneSuppression(nextIntents, target);
      if (filteredIntents.length !== nextIntents.length) {
        nextIntents = filteredIntents;
        territoryMemory.intents = nextIntents;
        changed = true;
      }
      continue;
    }

    territoryMemory.intents = nextIntents;
    upsertTerritoryIntent(nextIntents, {
      colony: target.colony,
      targetRoom: target.roomName,
      action: target.action,
      status: 'suppressed',
      updatedAt: gameTime,
      reason,
      ...(target.controllerId ? { controllerId: target.controllerId } : {})
    });
    removeTerritoryFollowUpDemand(territoryMemory as TerritoryMemory, target.colony, target.roomName, target.action);
    removeTerritoryFollowUpExecutionHint(
      territoryMemory as TerritoryMemory,
      target.colony,
      target.roomName,
      target.action
    );
    changed = true;
  }

  return { intents: nextIntents, changed };
}

function getTerritoryDeadZoneSuppressionReason(
  colonyName: string,
  targetRoom: string,
  routeDistanceLookupContext: RouteDistanceLookupContext
): TerritoryIntentSuppressionReason | null {
  const visibleTargetRoom = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[targetRoom];
  if (visibleTargetRoom) {
    refreshVisibleRoomDeadZoneMemory(visibleTargetRoom);
  }

  if (getKnownDeadZoneRoom(targetRoom)?.reason === 'enemyTower') {
    return 'deadZoneTarget';
  }

  return isRouteBlockedByKnownDeadZone(colonyName, targetRoom) &&
    getKnownRouteLength(colonyName, targetRoom, routeDistanceLookupContext) !== null
    ? 'deadZoneRoute'
    : null;
}

function removeDeadZoneSuppression(
  intents: TerritoryIntentMemory[],
  target: TerritoryTargetMemory
): TerritoryIntentMemory[] {
  return intents.filter(
    (intent) =>
      !(
        intent.colony === target.colony &&
        intent.targetRoom === target.roomName &&
        intent.action === target.action &&
        intent.status === 'suppressed' &&
        isDeadZoneTerritorySuppressionReason(intent.reason)
      )
  );
}

function isDeadZoneTerritorySuppressionReason(reason: unknown): reason is TerritoryIntentSuppressionReason {
  return reason === 'deadZoneTarget' || reason === 'deadZoneRoute';
}

function isConfiguredFollowUpTargetBlockedBySpawnReadiness(
  target: TerritoryTargetMemory,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  colony: ColonySnapshot
): boolean {
  const persistedFollowUp = getPersistedTerritoryIntentFollowUp(
    intents,
    target.colony,
    target.roomName,
    target.action,
    gameTime,
    target.controllerId
  );
  return (
    persistedFollowUp !== null &&
    !isTerritoryIntentActionSpawnReady(
      colony,
      target.action,
      persistedFollowUp.requiresControllerPressure === true
    )
  );
}

function isClaimTargetDeferredBySameRoomReserveLane(
  target: TerritoryTargetMemory,
  intents: TerritoryIntentMemory[],
  roleCounts: RoleCounts,
  colonyOwnerUsername: string | null,
  gameTime: number
): boolean {
  if (target.action !== 'claim') {
    return false;
  }

  const reserveIntent = intents.find(
    (intent) =>
      intent.colony === target.colony &&
      intent.targetRoom === target.roomName &&
      intent.action === 'reserve' &&
      (intent.status === 'active' || intent.status === 'planned') &&
      !isTerritoryIntentSuspensionActive(intent, gameTime)
  );
  if (!reserveIntent) {
    return false;
  }

  if (
    reserveIntent.followUp === undefined &&
    getTerritoryCreepCountForTarget(roleCounts, reserveIntent.targetRoom, 'reserve') <= 0
  ) {
    return false;
  }

  return (
    getVisibleTerritoryTargetState(target.roomName, 'reserve', reserveIntent.controllerId, colonyOwnerUsername) !==
    'unavailable'
  );
}

function getAdjacentReserveCandidates(
  colonyName: string,
  originRoomName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  includeScoutCandidates: boolean,
  source: TerritoryCandidateSource,
  orderOffset: number,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  const adjacentRooms = sortAdjacentRoomsByPersistedExpansionScore(
    getAdjacentRoomNames(originRoomName),
    colonyName,
    territoryMemory
  );
  if (adjacentRooms.length === 0) {
    return [];
  }

  const existingTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  return adjacentRooms.flatMap((roomName, order) => {
    const target: TerritoryTargetMemory = { colony: colonyName, roomName, action: 'reserve' };
    if (
      roomName === colonyName ||
      existingTargetRooms.has(roomName) ||
      isKnownDeadZoneRoom(roomName) ||
      isTerritoryTargetSuppressed(target, intents, gameTime) ||
      isTerritoryRoomSuspendedForColony(intents, colonyName, roomName, gameTime) ||
      isRecoveredTerritoryFollowUpAttemptCoolingDownForAction(intents, colonyName, roomName, 'reserve', gameTime)
    ) {
      return [];
    }

    const candidateState = getAdjacentReserveCandidateState(roomName, colonyOwnerUsername);
    if (candidateState === 'safe') {
      const candidate = scoreTerritoryCandidate(
        {
          target,
          intentAction: 'reserve',
          commitTarget: true,
          ...buildTerritoryFollowUp(source, originRoomName)
        },
        source,
        orderOffset + order,
        colonyName,
        colonyOwnerUsername,
        routeDistanceLookupContext
      );
      return candidate ? [candidate] : [];
    }

    if (
      candidateState === 'unknown' &&
      includeScoutCandidates &&
      !isSuppressedTerritoryIntentForAction(intents, colonyName, roomName, 'scout', gameTime)
    ) {
      const candidate = scoreTerritoryCandidate(
        {
          target,
          intentAction: 'scout',
          commitTarget: false,
          ...buildTerritoryFollowUp(source, originRoomName)
        },
        source,
        orderOffset + order,
        colonyName,
        colonyOwnerUsername,
        routeDistanceLookupContext
      );
      return candidate ? [candidate] : [];
    }

    return [];
  });
}

function sortAdjacentRoomsByPersistedExpansionScore(
  roomNames: string[],
  colonyName: string,
  territoryMemory: Record<string, unknown> | null
): string[] {
  if (roomNames.length <= 1) {
    return roomNames;
  }

  const scoredRoomRanks = getPersistedExpansionCandidateRanks(colonyName, territoryMemory);
  if (scoredRoomRanks.size === 0) {
    return roomNames;
  }

  return roomNames
    .map((roomName, index) => ({ roomName, index }))
    .sort(
      (left, right) =>
        (scoredRoomRanks.get(left.roomName) ?? Number.POSITIVE_INFINITY) -
          (scoredRoomRanks.get(right.roomName) ?? Number.POSITIVE_INFINITY) ||
        left.index - right.index
    )
    .map(({ roomName }) => roomName);
}

function getPersistedExpansionCandidateRanks(
  colonyName: string,
  territoryMemory: Record<string, unknown> | null
): Map<string, number> {
  if (!territoryMemory || !Array.isArray(territoryMemory.expansionCandidates)) {
    return new Map();
  }

  const ranks = new Map<string, number>();
  for (const [index, rawCandidate] of territoryMemory.expansionCandidates.entries()) {
    if (!isRecord(rawCandidate)) {
      continue;
    }

    if (
      rawCandidate.colony !== colonyName ||
      !isNonEmptyString(rawCandidate.roomName) ||
      rawCandidate.evidenceStatus === 'unavailable' ||
      (rawCandidate.recommendedAction !== 'scout' && rawCandidate.recommendedAction !== 'claim') ||
      ranks.has(rawCandidate.roomName)
    ) {
      continue;
    }

    ranks.set(rawCandidate.roomName, index);
  }

  return ranks;
}

function getVisibleAdjacentReserveCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  return getAdjacentReserveCandidates(
    colonyName,
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    false,
    'adjacent',
    0,
    routeDistanceLookupContext
  );
}

function getVisibleAdjacentFollowUpReserveCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  roleCounts: RoleCounts,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  return getAdjacentFollowUpReserveCandidates(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    roleCounts,
    false,
    routeDistanceLookupContext
  );
}

function getAdjacentFollowUpReserveCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  roleCounts: RoleCounts,
  includeScoutCandidates: boolean,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  return [
    ...getSatisfiedClaimAdjacentReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      routeDistanceLookupContext
    ),
    ...getSatisfiedReserveAdjacentReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      routeDistanceLookupContext
    ),
    ...getActiveReserveAdjacentReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      roleCounts,
      includeScoutCandidates,
      routeDistanceLookupContext
    )
  ];
}

function getSatisfiedClaimAdjacentReserveCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  includeScoutCandidates: boolean,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  return getSatisfiedConfiguredClaimTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    routeDistanceLookupContext
  ).flatMap(({ target, order }) =>
    getAdjacentReserveCandidates(
      colonyName,
      target.roomName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      'satisfiedClaimAdjacent',
      (order + 1) * EXIT_DIRECTION_ORDER.length,
      routeDistanceLookupContext
    )
  );
}

function getSatisfiedReserveAdjacentReserveCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  includeScoutCandidates: boolean,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  return getSatisfiedConfiguredTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    'reserve',
    routeDistanceLookupContext
  ).flatMap(({ target, order }) =>
    getAdjacentReserveCandidates(
      colonyName,
      target.roomName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      'satisfiedReserveAdjacent',
      (order + 1) * EXIT_DIRECTION_ORDER.length,
      routeDistanceLookupContext
    )
  );
}

function getActiveReserveAdjacentReserveCandidates(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  roleCounts: RoleCounts,
  includeScoutCandidates: boolean,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget[] {
  return getActiveCoveredConfiguredReserveTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    roleCounts,
    routeDistanceLookupContext
  ).flatMap(({ target, order }) =>
    getAdjacentReserveCandidates(
      colonyName,
      target.roomName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      'activeReserveAdjacent',
      (order + 1) * EXIT_DIRECTION_ORDER.length,
      routeDistanceLookupContext
    )
  );
}

function getActiveCoveredConfiguredReserveTargets(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  roleCounts: RoleCounts,
  routeDistanceLookupContext: RouteDistanceLookupContext
): Array<{ target: TerritoryTargetMemory; order: number }> {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }

  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.enabled === false ||
      target.colony !== colonyName ||
      target.action !== 'reserve' ||
      target.roomName === colonyName ||
      isKnownDeadZoneRoom(target.roomName) ||
      isTerritoryTargetSuppressed(target, intents, gameTime) ||
      isTerritoryIntentSuspendedForAction(intents, target.colony, target.roomName, target.action, gameTime) ||
      hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext) ||
      !isVisibleRoomKnown(target.roomName) ||
      getTerritoryCreepCountForTarget(roleCounts, target.roomName, target.action) <= 0 ||
      getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !==
        'available'
    ) {
      return [];
    }

    return [{ target, order }];
  });
}

function getSatisfiedConfiguredClaimTargets(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  routeDistanceLookupContext: RouteDistanceLookupContext
): Array<{ target: TerritoryTargetMemory; order: number }> {
  return getSatisfiedConfiguredTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    'claim',
    routeDistanceLookupContext
  );
}

function getSatisfiedConfiguredTargets(
  colonyName: string,
  colonyOwnerUsername: string | null,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  gameTime: number,
  action: TerritoryControlAction,
  routeDistanceLookupContext: RouteDistanceLookupContext
): Array<{ target: TerritoryTargetMemory; order: number }> {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }

  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.enabled === false ||
      target.colony !== colonyName ||
      target.action !== action ||
      target.roomName === colonyName ||
      isKnownDeadZoneRoom(target.roomName) ||
      isTerritoryTargetSuppressed(target, intents, gameTime) ||
      isTerritoryIntentSuspendedForAction(intents, target.colony, target.roomName, target.action, gameTime) ||
      hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext) ||
      getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !==
        'satisfied'
    ) {
      return [];
    }

    return [{ target, order }];
  });
}

function scoreTerritoryCandidate(
  selection: SelectedTerritoryTarget,
  source: TerritoryCandidateSource,
  order: number,
  colonyName: string,
  colonyOwnerUsername: string | null,
  routeDistanceLookupContext: RouteDistanceLookupContext
): ScoredTerritoryTarget | null {
  const knownRouteDistance = getKnownRouteLength(colonyName, selection.target.roomName, routeDistanceLookupContext);
  if (knownRouteDistance === null) {
    return null;
  }
  const routeDistance = knownRouteDistance ?? getInferredTerritoryRouteDistance(source);
  const roadDistance = getNearestOwnedRoomRouteDistance(
    colonyName,
    selection.target.roomName,
    routeDistance,
    routeDistanceLookupContext
  );

  const renewalTicksToEnd = getConfiguredReserveRenewalTicksToEnd(selection.target, colonyOwnerUsername);
  const occupationActionableTicks =
    source === 'occupationIntent'
      ? getOccupationIntentActionableTicks(selection, colonyOwnerUsername)
      : undefined;
  const requiresControllerPressure =
    selection.requiresControllerPressure === true ||
    isVisibleTerritoryReservePressureAvailable(
      selection.target.roomName,
      selection.intentAction,
      selection.target.controllerId,
      colonyOwnerUsername
    );
  return {
    ...selection,
    source,
    order,
    priority: getTerritoryCandidatePriority(selection, renewalTicksToEnd),
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(routeDistance !== undefined ? { routeDistance } : {}),
    ...(roadDistance !== undefined ? { roadDistance } : {}),
    ...(renewalTicksToEnd !== null ? { renewalTicksToEnd } : {}),
    ...(occupationActionableTicks !== undefined ? { occupationActionableTicks } : {})
  };
}

function getInferredTerritoryRouteDistance(source: TerritoryCandidateSource): number | undefined {
  return source === 'adjacent' ? 1 : undefined;
}

function applyOccupationRecommendationScores(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  candidates: ScoredTerritoryTarget[]
): ScoredTerritoryTarget[] {
  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller) ?? undefined;
  const adjacentControllerProgressReady = isTerritoryHomeReadyForAdjacentControllerProgress(
    colony,
    roleCounts,
    workerTarget
  );
  return candidates.flatMap((candidate) => {
    const recommendation = scoreOccupationRecommendations({
      colonyName: colony.room.name,
      ...(colonyOwnerUsername ? { colonyOwnerUsername } : {}),
      energyCapacityAvailable: colony.energyCapacityAvailable,
      workerCount: getWorkerCapacity(roleCounts),
      ...(typeof colony.room.controller?.level === 'number' ? { controllerLevel: colony.room.controller.level } : {}),
      ...(typeof colony.room.controller?.ticksToDowngrade === 'number'
        ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade }
        : {}),
      candidates: [buildOccupationRecommendationCandidate(candidate)]
    }).candidates[0];

    if (!recommendation || recommendation.evidenceStatus === 'unavailable') {
      return [];
    }

    return [
      applyOccupationRecommendationScore(
        candidate,
        recommendation,
        roleCounts,
        adjacentControllerProgressReady
      )
    ];
  });
}

function applyOccupationRecommendationScore(
  candidate: ScoredTerritoryTarget,
  recommendation: OccupationRecommendationScore,
  roleCounts: RoleCounts,
  adjacentControllerProgressReady: boolean
): ScoredTerritoryTarget {
  const intentAction = getRecommendedTerritoryIntentAction(candidate, recommendation, roleCounts);
  const requiresControllerPressure =
    isTerritoryControlAction(intentAction) && candidate.requiresControllerPressure === true;
  const nextSelection: SelectedTerritoryTarget = {
    target: candidate.target,
    intentAction,
    commitTarget: recommendation.evidenceStatus === 'sufficient' && intentAction !== 'scout' && candidate.commitTarget,
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(candidate.followUp ? { followUp: candidate.followUp } : {})
  };
  const renewalTicksToEnd = intentAction === 'reserve' ? candidate.renewalTicksToEnd ?? null : null;
  const { requiresControllerPressure: _requiresControllerPressure, ...candidateWithoutPressure } = candidate;
  const safeAdjacentControllerProgress = isSafeAdjacentControllerProgressCandidate(
    candidate,
    recommendation,
    intentAction,
    adjacentControllerProgressReady
  );

  return {
    ...candidateWithoutPressure,
    intentAction,
    commitTarget: nextSelection.commitTarget,
    priority: getTerritoryCandidatePriority(nextSelection, renewalTicksToEnd),
    recommendationScore: getTerritoryCandidateRecommendationScore(candidate, recommendation),
    recommendationEvidenceStatus: recommendation.evidenceStatus,
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(safeAdjacentControllerProgress ? { safeAdjacentControllerProgress: true } : {}),
    ...(renewalTicksToEnd !== null ? { renewalTicksToEnd } : {})
  };
}

function getTerritoryCandidateRecommendationScore(
  candidate: ScoredTerritoryTarget,
  recommendation: OccupationRecommendationScore
): number {
  return (
    recommendation.score +
    (candidate.recoveredFollowUp === true ? TERRITORY_RECOVERED_INTENT_SPAWN_PRIORITY : 0)
  );
}

function isSafeAdjacentControllerProgressCandidate(
  candidate: ScoredTerritoryTarget,
  recommendation: OccupationRecommendationScore,
  intentAction: TerritoryIntentAction,
  adjacentControllerProgressReady: boolean
): boolean {
  return (
    adjacentControllerProgressReady &&
    candidate.source === 'adjacent' &&
    candidate.target.action === 'reserve' &&
    intentAction === 'reserve' &&
    candidate.commitTarget === true &&
    candidate.routeDistance === 1 &&
    recommendation.evidenceStatus === 'sufficient' &&
    isTerritoryTargetVisible(candidate.target)
  );
}

function getRecommendedTerritoryIntentAction(
  candidate: ScoredTerritoryTarget,
  recommendation: OccupationRecommendationScore,
  roleCounts: RoleCounts
): TerritoryIntentAction {
  if (candidate.source === 'occupationIntent' && isPersistedControllerFollowUpCandidate(candidate)) {
    return candidate.intentAction;
  }

  if (recommendation.evidenceStatus === 'insufficient-evidence') {
    if (isRecoveredTerritoryFollowUpControlCandidate(candidate)) {
      return candidate.intentAction;
    }

    if (isTerritoryControlAction(candidate.intentAction) && candidate.requiresControllerPressure === true) {
      return candidate.intentAction;
    }

    if (
      candidate.source === 'configured' &&
      getTerritoryCreepCountForTarget(roleCounts, candidate.target.roomName, candidate.target.action) > 0
    ) {
      return candidate.intentAction;
    }

    return 'scout';
  }

  if (recommendation.action === 'occupy') {
    return 'claim';
  }

  return recommendation.action === 'reserve' ? 'reserve' : candidate.intentAction;
}

function isRecoveredTerritoryFollowUpControlCandidate(candidate: ScoredTerritoryTarget): boolean {
  return (
    candidate.recoveredFollowUp === true &&
    candidate.followUp !== undefined &&
    isTerritoryControlAction(candidate.intentAction)
  );
}

function buildOccupationRecommendationCandidate(
  candidate: ScoredTerritoryTarget
): OccupationRecommendationCandidateInput {
  const room = getVisibleRoom(candidate.target.roomName);
  return {
    roomName: candidate.target.roomName,
    source: candidate.source === 'configured' ? 'configured' : 'adjacent',
    order: candidate.order,
    adjacent: candidate.source !== 'configured',
    visible: room != null,
    actionHint: candidate.target.action,
    ...(candidate.routeDistance !== undefined ? { routeDistance: candidate.routeDistance } : {}),
    ...(candidate.roadDistance !== undefined ? { roadDistance: candidate.roadDistance } : {}),
    ...(candidate.ignoreOwnHealthyReservation === true ? { ignoreOwnHealthyReservation: true } : {}),
    ...(room ? buildVisibleOccupationRecommendationEvidence(room, candidate.target.controllerId) : {})
  };
}

function buildVisibleOccupationRecommendationEvidence(
  room: Room,
  controllerId?: Id<StructureController>
): Pick<
  OccupationRecommendationCandidateInput,
  | 'controller'
  | 'sourceCount'
  | 'hostileCreepCount'
  | 'hostileStructureCount'
  | 'constructionSiteCount'
  | 'ownedStructureCount'
> {
  const controller = getVisibleController(room.name, controllerId);
  return {
    ...(controller ? { controller: summarizeOccupationController(controller) } : {}),
    sourceCount: countVisibleRoomObjects(room, getFindConstant('FIND_SOURCES')),
    hostileCreepCount: findVisibleHostileCreeps(room).length,
    hostileStructureCount: findVisibleHostileStructures(room).length,
    constructionSiteCount: countVisibleRoomObjects(room, getFindConstant('FIND_MY_CONSTRUCTION_SITES')),
    ownedStructureCount: countVisibleRoomObjects(room, getFindConstant('FIND_MY_STRUCTURES'))
  };
}

function summarizeOccupationController(controller: StructureController): OccupationControllerEvidence {
  const ownerUsername = getControllerOwnerUsername(controller);
  const reservationUsername = getControllerReservationUsername(controller);
  const reservationTicksToEnd = getControllerReservationTicksToEnd(controller);

  return {
    ...(controller.my === true ? { my: true } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    ...(typeof reservationTicksToEnd === 'number' ? { reservationTicksToEnd } : {})
  };
}

function getControllerReservationUsername(controller: StructureController): string | undefined {
  const username = (controller as StructureController & { reservation?: { username?: string } }).reservation?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationTicksToEnd(controller: StructureController): number | undefined {
  const ticksToEnd = (controller as StructureController & { reservation?: { ticksToEnd?: number } }).reservation
    ?.ticksToEnd;
  return typeof ticksToEnd === 'number' ? ticksToEnd : undefined;
}

function getOccupationIntentActionableTicks(
  selection: SelectedTerritoryTarget,
  colonyOwnerUsername: string | null
): number | undefined {
  if (!isTerritoryControlAction(selection.intentAction)) {
    return undefined;
  }

  const controller = getVisibleController(selection.target.roomName, selection.target.controllerId);
  if (!controller) {
    return undefined;
  }

  if (selection.intentAction === 'reserve') {
    if (isControllerOwned(controller)) {
      return undefined;
    }

    const ownReservationTicksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
    return ownReservationTicksToEnd ?? getControllerReservationTicksToEnd(controller) ?? 0;
  }

  if (isControllerOwned(controller)) {
    return typeof controller.ticksToDowngrade === 'number' ? controller.ticksToDowngrade : undefined;
  }

  return getControllerReservationTicksToEnd(controller) ?? 0;
}

function getVisibleRoom(roomName: string): Room | null {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName] ?? null;
}

function countVisibleRoomObjects(room: Room, findConstant: number | undefined): number {
  if (typeof findConstant !== 'number') {
    return 0;
  }

  const find = (room as unknown as { find?: (type: number) => unknown }).find;
  if (typeof find !== 'function') {
    return 0;
  }

  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result.length : 0;
  } catch {
    return 0;
  }
}

function getFindConstant(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
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
    compareVisibleAdjacentFollowUpPreference(left, right) ||
    compareSafeAdjacentControllerProgressPreference(left, right) ||
    compareImmediateControllerFollowUpPreference(left, right) ||
    comparePersistedControllerFollowUpPreference(left, right) ||
    getTerritoryCandidateSourcePriority(left.source) - getTerritoryCandidateSourcePriority(right.source) ||
    compareOptionalNumbersDescending(left.recommendationScore, right.recommendationScore) ||
    compareOptionalNumbers(left.occupationActionableTicks, right.occupationActionableTicks) ||
    compareRecoveredFollowUpPreference(left, right) ||
    left.order - right.order ||
    left.target.roomName.localeCompare(right.target.roomName) ||
    left.intentAction.localeCompare(right.intentAction)
  );
}

function compareImmediateControllerFollowUpPreference(
  left: ScoredTerritoryTarget,
  right: ScoredTerritoryTarget
): number {
  const leftImmediate = left.immediateControllerFollowUp === true;
  const rightImmediate = right.immediateControllerFollowUp === true;
  if (leftImmediate === rightImmediate) {
    return 0;
  }

  return leftImmediate ? -1 : 1;
}

function comparePersistedControllerFollowUpPreference(
  left: ScoredTerritoryTarget,
  right: ScoredTerritoryTarget
): number {
  const leftPersisted = isPersistedControllerFollowUpCandidate(left);
  const rightPersisted = isPersistedControllerFollowUpCandidate(right);
  if (leftPersisted === rightPersisted) {
    return 0;
  }

  return leftPersisted ? -1 : 1;
}

function isPersistedControllerFollowUpCandidate(candidate: ScoredTerritoryTarget): boolean {
  return (
    candidate.persistedFollowUp === true &&
    candidate.followUp !== undefined &&
    isTerritoryControlAction(candidate.intentAction)
  );
}

function compareRecoveredFollowUpPreference(left: ScoredTerritoryTarget, right: ScoredTerritoryTarget): number {
  if (left.recoveredFollowUp === right.recoveredFollowUp) {
    return 0;
  }

  return left.recoveredFollowUp ? -1 : 1;
}

function compareVisibleAdjacentFollowUpPreference(
  left: ScoredTerritoryTarget,
  right: ScoredTerritoryTarget
): number {
  if (shouldPreferVisibleAdjacentFollowUp(left, right)) {
    return -1;
  }

  return shouldPreferVisibleAdjacentFollowUp(right, left) ? 1 : 0;
}

function compareSafeAdjacentControllerProgressPreference(
  left: ScoredTerritoryTarget,
  right: ScoredTerritoryTarget
): number {
  if (shouldPreferSafeAdjacentControllerProgress(left, right)) {
    return -1;
  }

  return shouldPreferSafeAdjacentControllerProgress(right, left) ? 1 : 0;
}

function shouldPreferSafeAdjacentControllerProgress(
  candidate: ScoredTerritoryTarget,
  other: ScoredTerritoryTarget
): boolean {
  return (
    candidate.safeAdjacentControllerProgress === true &&
    isLowerConfidenceDistantSameActionCandidate(other, candidate)
  );
}

function shouldPreferVisibleAdjacentFollowUp(
  candidate: ScoredTerritoryTarget,
  other: ScoredTerritoryTarget
): boolean {
  return (
    isVisibleAdjacentControllerFollowUpCandidate(candidate) &&
    isLowerConfidenceDistantSameActionCandidate(other, candidate)
  );
}

function isVisibleAdjacentControllerFollowUpCandidate(candidate: ScoredTerritoryTarget): boolean {
  return (
    isTerritoryFollowUpSource(candidate.source) &&
    candidate.intentAction === candidate.target.action &&
    isTerritoryControlAction(candidate.intentAction) &&
    candidate.recommendationEvidenceStatus === 'sufficient' &&
    isTerritoryTargetVisible(candidate.target)
  );
}

function isLowerConfidenceDistantSameActionCandidate(
  candidate: ScoredTerritoryTarget,
  followUpCandidate: ScoredTerritoryTarget
): boolean {
  if (
    candidate.target.action !== followUpCandidate.target.action ||
    !isPrimaryTerritoryCandidateSource(candidate.source) ||
    !isFartherTerritoryCandidate(candidate, followUpCandidate)
  ) {
    return false;
  }

  if (candidate.recommendationEvidenceStatus !== 'sufficient' || !isTerritoryTargetVisible(candidate.target)) {
    return true;
  }

  return (
    typeof candidate.recommendationScore === 'number' &&
    typeof followUpCandidate.recommendationScore === 'number' &&
    followUpCandidate.recommendationScore > candidate.recommendationScore
  );
}

function isPrimaryTerritoryCandidateSource(source: TerritoryCandidateSource): boolean {
  return source === 'configured' || source === 'occupationIntent';
}

function isFartherTerritoryCandidate(candidate: ScoredTerritoryTarget, other: ScoredTerritoryTarget): boolean {
  const candidateDistance = candidate.routeDistance ?? Number.POSITIVE_INFINITY;
  const otherDistance = other.routeDistance ?? Number.POSITIVE_INFINITY;
  return candidateDistance > otherDistance;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function compareOptionalNumbersDescending(left: number | undefined, right: number | undefined): number {
  return (right ?? Number.NEGATIVE_INFINITY) - (left ?? Number.NEGATIVE_INFINITY);
}

function getTerritoryCandidateSourcePriority(source: TerritoryCandidateSource): number {
  if (source === 'configured' || source === 'occupationIntent') {
    return 0;
  }

  if (source === 'satisfiedClaimAdjacent') {
    return 1;
  }

  if (source === 'satisfiedReserveAdjacent') {
    return 2;
  }

  return source === 'activeReserveAdjacent' ? 3 : 4;
}

function buildTerritoryFollowUp(
  source: TerritoryCandidateSource,
  originRoom: string
): Pick<SelectedTerritoryTarget, 'followUp'> {
  const originAction = getTerritoryFollowUpOriginAction(source);
  if (originAction === null || !isTerritoryFollowUpSource(source) || !isNonEmptyString(originRoom)) {
    return {};
  }

  return {
    followUp: {
      source,
      originRoom,
      originAction
    }
  };
}

function getTerritoryFollowUpOriginAction(source: TerritoryCandidateSource): TerritoryControlAction | null {
  if (source === 'satisfiedClaimAdjacent') {
    return 'claim';
  }

  return source === 'satisfiedReserveAdjacent' || source === 'activeReserveAdjacent' ? 'reserve' : null;
}

function isTerritoryTargetVisible(target: TerritoryTargetMemory): boolean {
  return isVisibleRoomKnown(target.roomName) || getVisibleController(target.roomName, target.controllerId) !== null;
}

function createRouteDistanceLookupContext(): RouteDistanceLookupContext {
  return { revalidatedNoRouteCacheKeys: new Set() };
}

function hasKnownNoRoute(
  fromRoom: string,
  targetRoom: string,
  routeDistanceLookupContext: RouteDistanceLookupContext
): boolean {
  return getKnownRouteLength(fromRoom, targetRoom, routeDistanceLookupContext) === null;
}

function getNearestOwnedRoomRouteDistance(
  colonyName: string,
  targetRoom: string,
  fallbackRouteDistance: number | undefined,
  routeDistanceLookupContext: RouteDistanceLookupContext
): number | undefined {
  let nearestDistance = fallbackRouteDistance;
  for (const ownedRoomName of getVisibleOwnedRoomNames(colonyName)) {
    const routeDistance =
      ownedRoomName === colonyName
        ? fallbackRouteDistance
        : getKnownRouteLength(ownedRoomName, targetRoom, routeDistanceLookupContext);
    if (typeof routeDistance !== 'number') {
      continue;
    }

    nearestDistance = nearestDistance === undefined ? routeDistance : Math.min(nearestDistance, routeDistance);
  }

  return nearestDistance;
}

function getVisibleOwnedRoomNames(fallbackRoomName: string): string[] {
  const roomNames = new Set<string>([fallbackRoomName]);
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return Array.from(roomNames);
  }

  for (const room of Object.values(rooms)) {
    if (room?.controller?.my === true && isNonEmptyString(room.name)) {
      roomNames.add(room.name);
    }
  }

  return Array.from(roomNames);
}

function getKnownRouteLength(
  fromRoom: string,
  targetRoom: string,
  routeDistanceLookupContext: RouteDistanceLookupContext
): number | null | undefined {
  if (fromRoom === targetRoom) {
    return 0;
  }

  const cache = getTerritoryRouteDistanceCache();
  const cacheKey = getTerritoryRouteDistanceCacheKey(fromRoom, targetRoom);
  const cachedRouteLength = cache?.[cacheKey];
  if (typeof cachedRouteLength === 'number') {
    return cachedRouteLength;
  }

  if (cachedRouteLength === null && routeDistanceLookupContext.revalidatedNoRouteCacheKeys.has(cacheKey)) {
    return null;
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
    if (cache) {
      cache[cacheKey] = null;
    }
    routeDistanceLookupContext.revalidatedNoRouteCacheKeys.add(cacheKey);
    return null;
  }

  if (!Array.isArray(route)) {
    return undefined;
  }

  if (cache) {
    cache[cacheKey] = route.length;
  }
  return route.length;
}

function getTerritoryRouteDistanceCache(): TerritoryMemory['routeDistances'] | undefined {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return undefined;
  }

  if (!isRecord(territoryMemory.routeDistances)) {
    territoryMemory.routeDistances = {};
  }

  return territoryMemory.routeDistances as TerritoryMemory['routeDistances'];
}

function getTerritoryRouteDistanceCacheKey(fromRoom: string, targetRoom: string): string {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`;
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

function appendTerritoryTargetIfMissing(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (
    Array.isArray(territoryMemory.targets) &&
    territoryMemory.targets.some((rawTarget) => {
      const existingTarget = normalizeTerritoryTarget(rawTarget);
      return (
        existingTarget?.colony === target.colony &&
        existingTarget.roomName === target.roomName &&
        existingTarget.action === target.action
      );
    })
  ) {
    return;
  }

  appendTerritoryTarget(territoryMemory, target);
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

function isRoomAdjacentToColony(colonyName: string, targetRoom: string): boolean {
  return getAdjacentRoomNames(colonyName).includes(targetRoom);
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
    ...(rawTarget.enabled === false ? { enabled: false } : {}),
    ...(isTerritoryAutomationSource(rawTarget.createdBy) ? { createdBy: rawTarget.createdBy } : {})
  };
}

function isTerritoryAutomationSource(source: unknown): source is TerritoryAutomationSource {
  return (
    source === OCCUPATION_RECOMMENDATION_TARGET_CREATOR ||
    source === 'autonomousExpansionClaim' ||
    source === 'colonyExpansion' ||
    source === 'nextExpansionScoring' ||
    source === 'adjacentRoomReservation'
  );
}

function recordTerritoryIntent(
  plan: TerritoryIntentPlan,
  status: TerritoryIntentMemory['status'],
  gameTime: number,
  seededTarget: TerritoryTargetMemory | null = null,
  routeDistanceLookupContext: RouteDistanceLookupContext = createRouteDistanceLookupContext()
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
    ...(plan.createdBy ? { createdBy: plan.createdBy } : {}),
    ...(plan.controllerId ? { controllerId: plan.controllerId } : {}),
    ...(plan.requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(plan.followUp ? { followUp: plan.followUp } : {})
  };

  upsertTerritoryIntent(intents, nextIntent);
  recordTerritoryFollowUpDemand(territoryMemory, plan, gameTime);
  recordTerritoryFollowUpExecutionHint(territoryMemory, plan, gameTime, routeDistanceLookupContext);
}

function upsertTerritoryIntent(intents: TerritoryIntentMemory[], nextIntent: TerritoryIntentMemory): void {
  const existingIndex = findTerritoryIntentIndex(intents, nextIntent);

  if (existingIndex >= 0) {
    const existingIntent = intents[existingIndex];
    const controllerId = nextIntent.controllerId ?? existingIntent.controllerId;
    const createdBy = nextIntent.createdBy ?? existingIntent.createdBy;
    const requiresControllerPressure = shouldRecordTerritoryIntentControllerPressure(
      nextIntent,
      controllerId,
      existingIntent
    );
    intents[existingIndex] = {
      ...nextIntent,
      ...(createdBy ? { createdBy } : {}),
      ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
      ...(!nextIntent.followUp && existingIntent.followUp ? { followUp: existingIntent.followUp } : {})
    };
    return;
  }

  const requiresControllerPressure = shouldRecordTerritoryIntentControllerPressure(
    nextIntent,
    nextIntent.controllerId
  );
  intents.push({
    ...nextIntent,
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {})
  });
}

function findTerritoryIntentIndex(
  intents: TerritoryIntentMemory[],
  nextIntent: TerritoryIntentMemory
): number {
  if (nextIntent.createdBy) {
    return intents.findIndex(
      (intent) => isSameTerritoryIntentRecord(intent, nextIntent) && intent.createdBy === nextIntent.createdBy
    );
  }

  const unownedIntentIndex = intents.findIndex(
    (intent) => isSameTerritoryIntentRecord(intent, nextIntent) && intent.createdBy === undefined
  );
  if (unownedIntentIndex >= 0) {
    return unownedIntentIndex;
  }

  return intents.findIndex((intent) => isSameTerritoryIntentRecord(intent, nextIntent));
}

function isSameTerritoryIntentRecord(
  intent: TerritoryIntentMemory,
  nextIntent: TerritoryIntentMemory
): boolean {
  return (
    intent.colony === nextIntent.colony &&
    intent.targetRoom === nextIntent.targetRoom &&
    intent.action === nextIntent.action
  );
}

function shouldRecordTerritoryIntentControllerPressure(
  nextIntent: TerritoryIntentMemory,
  controllerId: Id<StructureController> | undefined,
  existingIntent?: TerritoryIntentMemory
): boolean {
  return (
    nextIntent.requiresControllerPressure === true ||
    isVisibleTerritoryReservePressureAvailable(
      nextIntent.targetRoom,
      nextIntent.action,
      controllerId,
      getVisibleColonyOwnerUsername(nextIntent.colony)
    ) ||
    (existingIntent !== undefined &&
      shouldPreservePersistedTerritoryIntentPressureRequirement(existingIntent, controllerId))
  );
}

function refreshHostileTerritoryIntentSuspensions(
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  colonyName: string,
  gameTime: number
): { intents: TerritoryIntentMemory[]; changed: boolean } {
  if (!territoryMemory || intents.length === 0) {
    return { intents, changed: false };
  }

  let changed = false;
  const suspendedIntents: TerritoryIntentMemory[] = [];
  const refreshedIntents = intents.map((intent) => {
    if (intent.colony !== colonyName || !isTerritoryControlAction(intent.action)) {
      return intent;
    }

    const hostileCount = getVisibleHostileCreepCount(intent.targetRoom);
    if (hostileCount !== null && hostileCount > 0) {
      if (intent.suspended?.reason === 'hostile_presence') {
        if (isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime)) {
          suspendedIntents.push(intent);
          return intent;
        }
      }

      const suspended = buildHostilePresenceTerritoryIntentSuspension(hostileCount, gameTime);
      changed = true;
      const suspendedIntent = {
        ...intent,
        suspended
      };
      suspendedIntents.push(suspendedIntent);
      return suspendedIntent;
    }

    if (
      intent.suspended?.reason === 'hostile_presence' &&
      (hostileCount === 0 || !isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime))
    ) {
      changed = true;
      return withoutTerritoryIntentSuspension(intent);
    }

    return intent;
  });

  if (!changed) {
    return { intents, changed: false };
  }

  setTerritoryIntents(territoryMemory, refreshedIntents);
  for (const intent of suspendedIntents) {
    removeTerritoryFollowUpDemand(territoryMemory as TerritoryMemory, intent.colony, intent.targetRoom, intent.action);
    removeTerritoryFollowUpExecutionHint(
      territoryMemory as TerritoryMemory,
      intent.colony,
      intent.targetRoom,
      intent.action
    );
  }

  return { intents: refreshedIntents, changed: true };
}

function sanitizeSatisfiedClaimReserveHandoffs(
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  colonyName: string,
  colonyOwnerUsername: string | null
): { intents: TerritoryIntentMemory[]; changed: boolean } {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return { intents, changed: false };
  }

  const satisfiedClaimRooms = getSatisfiedConfiguredClaimRoomNames(
    territoryMemory.targets,
    colonyName,
    colonyOwnerUsername
  );
  if (satisfiedClaimRooms.size === 0) {
    return { intents, changed: false };
  }

  const nextTargets = territoryMemory.targets.filter((rawTarget) => {
    const target = normalizeTerritoryTarget(rawTarget);
    return !(
      target?.colony === colonyName &&
      target.action === 'reserve' &&
      satisfiedClaimRooms.has(target.roomName)
    );
  });
  const nextIntents = intents.filter(
    (intent) =>
      !(
        intent.colony === colonyName &&
        intent.action === 'reserve' &&
        satisfiedClaimRooms.has(intent.targetRoom)
      )
  );
  const changed = nextTargets.length !== territoryMemory.targets.length || nextIntents.length !== intents.length;
  if (!changed) {
    return { intents, changed: false };
  }

  territoryMemory.targets = nextTargets;
  territoryMemory.intents = nextIntents;
  for (const targetRoom of satisfiedClaimRooms) {
    removeTerritoryFollowUpDemand(territoryMemory as TerritoryMemory, colonyName, targetRoom, 'reserve');
    removeTerritoryFollowUpExecutionHint(territoryMemory as TerritoryMemory, colonyName, targetRoom, 'reserve');
  }

  return { intents: nextIntents, changed: true };
}

function getSatisfiedConfiguredClaimRoomNames(
  rawTargets: unknown[],
  colonyName: string,
  colonyOwnerUsername: string | null
): Set<string> {
  const satisfiedClaimRooms = new Set<string>();
  for (const rawTarget of rawTargets) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      target?.colony === colonyName &&
      target.action === 'claim' &&
      getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) ===
        'satisfied'
    ) {
      satisfiedClaimRooms.add(target.roomName);
    }
  }

  return satisfiedClaimRooms;
}

function sanitizeStaleTerritoryProgressIntents(
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  colonyName: string,
  colonyOwnerUsername: string | null,
  roleCounts: RoleCounts,
  gameTime: number
): { intents: TerritoryIntentMemory[]; changed: boolean } {
  const staleIntents: TerritoryIntentMemory[] = [];
  const sanitizedIntents = intents.filter((intent) => {
    if (!isStaleTerritoryProgressIntent(intent, colonyName, colonyOwnerUsername, roleCounts, gameTime)) {
      return true;
    }

    staleIntents.push(intent);
    return false;
  });

  if (staleIntents.length === 0) {
    return { intents, changed: false };
  }

  if (territoryMemory) {
    setTerritoryIntents(territoryMemory, sanitizedIntents);
    for (const staleIntent of staleIntents) {
      removeStaleTerritoryProgressIntentState(territoryMemory as TerritoryMemory, staleIntent);
    }
  }

  return { intents: sanitizedIntents, changed: true };
}

function isStaleTerritoryProgressIntent(
  intent: TerritoryIntentMemory,
  colonyName: string,
  colonyOwnerUsername: string | null,
  roleCounts: RoleCounts,
  gameTime: number
): boolean {
  if (intent.colony !== colonyName) {
    return false;
  }

  if (isTerritoryIntentSuspensionActive(intent, gameTime)) {
    return false;
  }

  if (intent.action === 'scout') {
    return isVisibleRoomKnown(intent.targetRoom);
  }

  if (
    intent.followUp === undefined ||
    !isTerritoryControlAction(intent.action) ||
    intent.status === 'suppressed'
  ) {
    return false;
  }

  if (
    intent.status === 'active' &&
    getTerritoryCreepCountForTarget(roleCounts, intent.targetRoom, intent.action) > 0
  ) {
    return false;
  }

  return !isVisibleTerritoryIntentActionable(
    intent.targetRoom,
    intent.action,
    intent.controllerId,
    colonyOwnerUsername
  );
}

function getVisibleTerritoryControllerEvidenceState(
  targetRoom: string,
  action: TerritoryControlAction,
  controllerId: Id<StructureController> | undefined,
  colonyOwnerUsername: string | null
): TerritoryTargetVisibilityState | null {
  if (isVisibleRoomMissingController(targetRoom)) {
    return 'unavailable';
  }

  const controller = getVisibleController(targetRoom, controllerId);
  if (!controller) {
    return null;
  }

  return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername);
}

function removeStaleTerritoryProgressIntentState(
  territoryMemory: TerritoryMemory,
  intent: TerritoryIntentMemory
): void {
  if (isTerritoryControlAction(intent.action)) {
    removeTerritoryFollowUpDemand(territoryMemory, intent.colony, intent.targetRoom, intent.action);
  }

  removeTerritoryFollowUpExecutionHint(territoryMemory, intent.colony, intent.targetRoom, intent.action);
}

function setTerritoryIntents(
  territoryMemory: TerritoryMemory | Record<string, unknown>,
  intents: TerritoryIntentMemory[]
): void {
  if (intents.length > 0) {
    territoryMemory.intents = intents;
  } else {
    delete territoryMemory.intents;
  }
}

function shouldPreservePersistedTerritoryIntentPressureRequirement(
  intent: TerritoryIntentMemory,
  controllerId: Id<StructureController> | undefined = intent.controllerId
): boolean {
  return (
    intent.requiresControllerPressure === true &&
    isTerritoryControllerPressureVisibilityMissing(intent.targetRoom, intent.action, controllerId)
  );
}

function isTerritoryControllerPressureVisibilityMissing(
  targetRoom: string,
  action: TerritoryIntentAction,
  controllerId?: Id<StructureController>
): boolean {
  return isTerritoryControlAction(action) && getVisibleController(targetRoom, controllerId) === null;
}

function getPersistedTerritoryIntentPressureRequirement(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction,
  controllerId?: Id<StructureController>
): boolean {
  if (!isTerritoryControllerPressureVisibilityMissing(targetRoom, action, controllerId)) {
    return false;
  }

  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action &&
      intent.requiresControllerPressure === true
  );
}

function getPersistedTerritoryIntentFollowUp(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction,
  gameTime: number,
  controllerId?: Id<StructureController>
): PersistedTerritoryIntentFollowUp | null {
  let selectedIntent: TerritoryIntentMemory | null = null;
  for (const intent of intents) {
    if (
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action &&
      intent.followUp &&
      (!selectedIntent || intent.updatedAt > selectedIntent.updatedAt)
    ) {
      selectedIntent = intent;
    }
  }

  if (!selectedIntent?.followUp) {
    return null;
  }

  return {
    followUp: selectedIntent.followUp,
    recovered: isRecoveredTerritoryFollowUpIntent(selectedIntent, gameTime),
    coolingDown: isRecoveredTerritoryFollowUpAttemptCoolingDown(selectedIntent, gameTime),
    ...(selectedIntent.status === 'suppressed' ? { suppressedAt: selectedIntent.updatedAt } : {}),
    ...(shouldPreservePersistedTerritoryIntentPressureRequirement(selectedIntent, controllerId)
      ? { requiresControllerPressure: true }
      : {})
  };
}

function getTerritoryReserveFallbackFollowUp(
  assignment: CreepTerritoryMemory,
  intents: TerritoryIntentMemory[],
  colony: string,
  gameTime: number
): TerritoryFollowUpMemory | null {
  const assignmentFollowUp = normalizeTerritoryFollowUp(assignment.followUp);
  if (assignmentFollowUp) {
    return assignmentFollowUp;
  }

  const persistedReserveFollowUp = getPersistedTerritoryIntentFollowUp(
    intents,
    colony,
    assignment.targetRoom,
    'reserve',
    gameTime,
    assignment.controllerId
  )?.followUp;
  if (persistedReserveFollowUp) {
    return persistedReserveFollowUp;
  }

  return (
    getPersistedTerritoryIntentFollowUp(
      intents,
      colony,
      assignment.targetRoom,
      'claim',
      gameTime,
      assignment.controllerId
    )?.followUp ?? null
  );
}

function recordTerritoryFollowUpDemand(
  territoryMemory: TerritoryMemory,
  plan: TerritoryIntentPlan,
  gameTime: number
): void {
  const demands = pruneCurrentTerritoryFollowUpDemands(territoryMemory, gameTime);
  if (!plan.followUp || !isTerritoryControlAction(plan.action)) {
    return;
  }

  upsertTerritoryFollowUpDemand(demands, {
    type: 'followUpPreparation',
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    workerCount: TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND,
    updatedAt: gameTime,
    followUp: plan.followUp
  });
  territoryMemory.demands = demands;
}

function pruneCurrentTerritoryFollowUpDemands(
  territoryMemory: TerritoryMemory,
  gameTime: number
): TerritoryFollowUpDemandMemory[] {
  const currentDemands = normalizeTerritoryFollowUpDemands(territoryMemory.demands).filter(
    (demand) => demand.updatedAt === gameTime
  );
  if (currentDemands.length > 0) {
    territoryMemory.demands = currentDemands;
  } else {
    delete territoryMemory.demands;
  }

  return currentDemands;
}

function upsertTerritoryFollowUpDemand(
  demands: TerritoryFollowUpDemandMemory[],
  nextDemand: TerritoryFollowUpDemandMemory
): void {
  const existingIndex = demands.findIndex(
    (demand) =>
      demand.type === nextDemand.type &&
      demand.colony === nextDemand.colony &&
      demand.targetRoom === nextDemand.targetRoom &&
      demand.action === nextDemand.action
  );

  if (existingIndex >= 0) {
    demands[existingIndex] = nextDemand;
    return;
  }

  demands.push(nextDemand);
}

function removeTerritoryFollowUpDemand(
  territoryMemory: TerritoryMemory,
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction
): void {
  if (!isTerritoryControlAction(action)) {
    return;
  }

  const demands = normalizeTerritoryFollowUpDemands(territoryMemory.demands).filter(
    (demand) => !(demand.colony === colony && demand.targetRoom === targetRoom && demand.action === action)
  );
  if (demands.length > 0) {
    territoryMemory.demands = demands;
  } else {
    delete territoryMemory.demands;
  }
}

function getCurrentTerritoryFollowUpDemand(
  plan: TerritoryIntentPlan,
  gameTime: number
): TerritoryFollowUpDemandMemory | null {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  return (
    normalizeTerritoryFollowUpDemands(territoryMemory.demands).find(
      (demand) =>
        demand.updatedAt === gameTime &&
        demand.colony === plan.colony &&
        demand.targetRoom === plan.targetRoom &&
        demand.action === plan.action
    ) ?? null
  );
}

function recordTerritoryFollowUpExecutionHint(
  territoryMemory: TerritoryMemory,
  plan: TerritoryIntentPlan,
  gameTime: number,
  routeDistanceLookupContext: RouteDistanceLookupContext = createRouteDistanceLookupContext()
): void {
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const currentHints = getBoundedActiveTerritoryFollowUpExecutionHints(
    normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints),
    intents,
    routeDistanceLookupContext
  );
  const nextHint = buildTerritoryFollowUpExecutionHint(plan, gameTime);
  if (!nextHint) {
    setTerritoryFollowUpExecutionHints(
      territoryMemory,
      hasActiveTerritoryFollowUpIntentForColony(intents, plan.colony)
        ? currentHints
        : currentHints.filter((hint) => hint.colony !== plan.colony)
    );
    return;
  }

  upsertTerritoryFollowUpExecutionHint(currentHints, nextHint);
  setTerritoryFollowUpExecutionHints(territoryMemory, currentHints);
}

function refreshTerritoryFollowUpExecutionHints(
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[],
  routeDistanceLookupContext: RouteDistanceLookupContext
): void {
  if (!territoryMemory || !Array.isArray(territoryMemory.executionHints)) {
    return;
  }

  setTerritoryFollowUpExecutionHints(
    territoryMemory,
    getBoundedActiveTerritoryFollowUpExecutionHints(
      normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints),
      intents,
      routeDistanceLookupContext
    )
  );
}

function getBoundedActiveTerritoryFollowUpExecutionHints(
  hints: TerritoryExecutionHintMemory[],
  intents: TerritoryIntentMemory[],
  routeDistanceLookupContext: RouteDistanceLookupContext = createRouteDistanceLookupContext()
): TerritoryExecutionHintMemory[] {
  const latestHintByColony = new Map<string, TerritoryExecutionHintMemory>();
  for (const hint of hints) {
    if (!isTerritoryFollowUpExecutionHintStillActive(hint, intents, routeDistanceLookupContext)) {
      continue;
    }

    const existingHint = latestHintByColony.get(hint.colony);
    if (
      !existingHint ||
      hint.updatedAt > existingHint.updatedAt ||
      (hint.updatedAt === existingHint.updatedAt && hint.targetRoom.localeCompare(existingHint.targetRoom) < 0)
    ) {
      latestHintByColony.set(hint.colony, hint);
    }
  }

  return Array.from(latestHintByColony.values()).sort((left, right) => left.colony.localeCompare(right.colony));
}

function isTerritoryFollowUpExecutionHintStillActive(
  hint: TerritoryExecutionHintMemory,
  intents: TerritoryIntentMemory[],
  routeDistanceLookupContext: RouteDistanceLookupContext
): boolean {
  if (isTerritoryFollowUpExecutionHintKnownUnreachable(hint, routeDistanceLookupContext)) {
    return false;
  }

  const matchingIntent = findMatchingActiveTerritoryFollowUpIntent(hint, intents);
  if (!matchingIntent?.followUp || !isSameTerritoryFollowUp(hint.followUp, matchingIntent.followUp)) {
    return false;
  }

  const currentReason = getTerritoryFollowUpExecutionHintReason(
    matchingIntent.targetRoom,
    matchingIntent.action,
    matchingIntent.controllerId,
    getVisibleColonyOwnerUsername(matchingIntent.colony)
  );

  return currentReason === hint.reason;
}

function isTerritoryFollowUpExecutionHintKnownUnreachable(
  hint: TerritoryExecutionHintMemory,
  routeDistanceLookupContext: RouteDistanceLookupContext
): boolean {
  return hasKnownNoRoute(hint.colony, hint.targetRoom, routeDistanceLookupContext);
}

function findMatchingActiveTerritoryFollowUpIntent(
  hint: TerritoryExecutionHintMemory,
  intents: TerritoryIntentMemory[]
): TerritoryIntentMemory | null {
  return (
    intents.find(
      (intent) =>
        intent.colony === hint.colony &&
        intent.targetRoom === hint.targetRoom &&
        intent.action === hint.action &&
        isActiveTerritoryFollowUpIntent(intent)
    ) ?? null
  );
}

function hasActiveTerritoryFollowUpIntentForColony(intents: TerritoryIntentMemory[], colony: string): boolean {
  return intents.some((intent) => intent.colony === colony && isActiveTerritoryFollowUpIntent(intent));
}

function isActiveTerritoryFollowUpIntent(intent: TerritoryIntentMemory): boolean {
  return (
    (intent.status === 'planned' || intent.status === 'active') &&
    intent.followUp !== undefined &&
    !isTerritoryIntentSuspensionActive(intent, getGameTime())
  );
}

function buildTerritoryFollowUpExecutionHint(
  plan: TerritoryIntentPlan,
  gameTime: number
): TerritoryExecutionHintMemory | null {
  if (!plan.followUp) {
    return null;
  }

  const reason = getTerritoryFollowUpExecutionHintReason(
    plan.targetRoom,
    plan.action,
    plan.controllerId,
    getVisibleColonyOwnerUsername(plan.colony)
  );
  if (reason === null) {
    return null;
  }

  return {
    type: 'activeFollowUpExecution',
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    reason,
    updatedAt: gameTime,
    ...(plan.controllerId ? { controllerId: plan.controllerId } : {}),
    followUp: plan.followUp
  };
}

function getTerritoryFollowUpExecutionHintReason(
  targetRoom: string,
  action: TerritoryIntentAction,
  controllerId: Id<StructureController> | undefined,
  colonyOwnerUsername: string | null
): TerritoryExecutionHintReason | null {
  if (!isVisibleTerritoryIntentActionable(targetRoom, action, controllerId, colonyOwnerUsername)) {
    return null;
  }

  if (action === 'scout') {
    return 'followUpTargetStillUnseen';
  }

  const controllerEvidenceState = getVisibleTerritoryControllerEvidenceState(
    targetRoom,
    action,
    controllerId,
    colonyOwnerUsername
  );
  return controllerEvidenceState === null
    ? 'controlEvidenceStillMissing'
    : 'visibleControlEvidenceStillActionable';
}

function upsertTerritoryFollowUpExecutionHint(
  hints: TerritoryExecutionHintMemory[],
  nextHint: TerritoryExecutionHintMemory
): void {
  const existingIndex = hints.findIndex((hint) => hint.colony === nextHint.colony);
  if (existingIndex >= 0) {
    hints[existingIndex] = nextHint;
    return;
  }

  hints.push(nextHint);
}

function removeTerritoryFollowUpExecutionHint(
  territoryMemory: TerritoryMemory,
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction
): void {
  const hints = normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints).filter(
    (hint) => !(hint.colony === colony && hint.targetRoom === targetRoom && hint.action === action)
  );
  setTerritoryFollowUpExecutionHints(territoryMemory, hints);
}

function setTerritoryFollowUpExecutionHints(
  territoryMemory: TerritoryMemory | Record<string, unknown>,
  hints: TerritoryExecutionHintMemory[]
): void {
  if (hints.length > 0) {
    territoryMemory.executionHints = hints;
  } else {
    delete territoryMemory.executionHints;
  }
}

function normalizeTerritoryFollowUpExecutionHints(rawHints: unknown): TerritoryExecutionHintMemory[] {
  return Array.isArray(rawHints)
    ? rawHints.flatMap((hint) => {
        const normalizedHint = normalizeTerritoryFollowUpExecutionHint(hint);
        return normalizedHint ? [normalizedHint] : [];
      })
    : [];
}

function normalizeTerritoryFollowUpExecutionHint(rawHint: unknown): TerritoryExecutionHintMemory | null {
  if (!isRecord(rawHint)) {
    return null;
  }

  if (
    rawHint.type !== 'activeFollowUpExecution' ||
    !isNonEmptyString(rawHint.colony) ||
    !isNonEmptyString(rawHint.targetRoom) ||
    !isTerritoryIntentAction(rawHint.action) ||
    !isTerritoryExecutionHintReason(rawHint.reason) ||
    typeof rawHint.updatedAt !== 'number'
  ) {
    return null;
  }

  const followUp = normalizeTerritoryFollowUp(rawHint.followUp);
  if (!followUp) {
    return null;
  }

  return {
    type: 'activeFollowUpExecution',
    colony: rawHint.colony,
    targetRoom: rawHint.targetRoom,
    action: rawHint.action,
    reason: rawHint.reason,
    updatedAt: rawHint.updatedAt,
    ...(typeof rawHint.controllerId === 'string'
      ? { controllerId: rawHint.controllerId as Id<StructureController> }
      : {}),
    followUp
  };
}

function isSameTerritoryFollowUp(left: TerritoryFollowUpMemory, right: TerritoryFollowUpMemory): boolean {
  return (
    left.source === right.source &&
    left.originRoom === right.originRoom &&
    left.originAction === right.originAction
  );
}

function normalizeTerritoryFollowUpDemands(rawDemands: unknown): TerritoryFollowUpDemandMemory[] {
  return Array.isArray(rawDemands)
    ? rawDemands.flatMap((demand) => {
        const normalizedDemand = normalizeTerritoryFollowUpDemand(demand);
        return normalizedDemand ? [normalizedDemand] : [];
      })
    : [];
}

function normalizeTerritoryFollowUpDemand(rawDemand: unknown): TerritoryFollowUpDemandMemory | null {
  if (!isRecord(rawDemand)) {
    return null;
  }

  if (
    rawDemand.type !== 'followUpPreparation' ||
    !isNonEmptyString(rawDemand.colony) ||
    !isNonEmptyString(rawDemand.targetRoom) ||
    !isTerritoryControlAction(rawDemand.action) ||
    typeof rawDemand.updatedAt !== 'number'
  ) {
    return null;
  }

  const followUp = normalizeTerritoryFollowUp(rawDemand.followUp);
  const workerCount = getBoundedTerritoryFollowUpWorkerDemand(rawDemand.workerCount);
  if (!followUp || workerCount <= 0) {
    return null;
  }

  return {
    type: 'followUpPreparation',
    colony: rawDemand.colony,
    targetRoom: rawDemand.targetRoom,
    action: rawDemand.action,
    workerCount,
    updatedAt: rawDemand.updatedAt,
    followUp
  };
}

function getBoundedTerritoryFollowUpWorkerDemand(rawWorkerCount: unknown): number {
  if (typeof rawWorkerCount !== 'number') {
    return TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND;
  }

  if (!Number.isFinite(rawWorkerCount)) {
    return 0;
  }

  return Math.max(0, Math.min(TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND, Math.floor(rawWorkerCount)));
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

function buildHostilePresenceTerritoryIntentSuspension(
  hostileCount: number,
  gameTime: number
): TerritoryIntentSuspensionMemory {
  return {
    reason: 'hostile_presence',
    hostileCount,
    updatedAt: gameTime
  };
}

function withoutTerritoryIntentSuspension(intent: TerritoryIntentMemory): TerritoryIntentMemory {
  const { suspended: _suspended, ...unsuspendedIntent } = intent;
  return unsuspendedIntent;
}

function isHostileTerritoryIntentSuspensionCoolingDown(
  suspension: TerritoryIntentSuspensionMemory,
  gameTime: number
): boolean {
  return gameTime - suspension.updatedAt <= TERRITORY_HOSTILE_INTENT_SUSPENSION_TICKS;
}

function isTerritoryIntentSuspended(
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction,
  gameTime = getGameTime()
): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  return isTerritoryIntentSuspendedForAction(
    normalizeTerritoryIntents(territoryMemory.intents),
    colony,
    targetRoom,
    action,
    gameTime
  );
}

function isTerritoryIntentSuspendedForAction(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction,
  gameTime: number
): boolean {
  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action &&
      isTerritoryIntentSuspensionActive(intent, gameTime)
  );
}

function isTerritoryRoomSuspendedForColony(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  gameTime: number
): boolean {
  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      isTerritoryIntentSuspensionActive(intent, gameTime)
  );
}

function isTerritoryIntentSuspensionActive(intent: TerritoryIntentMemory, gameTime: number): boolean {
  if (!intent.suspended) {
    return false;
  }

  if (intent.suspended.reason === 'hostile_presence') {
    const hostileCount = getVisibleHostileCreepCount(intent.targetRoom);
    if (hostileCount !== null) {
      return hostileCount > 0 && isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime);
    }
  }

  return isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime);
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

function isRecoveredTerritoryFollowUpIntent(intent: TerritoryIntentMemory, gameTime: number): boolean {
  if (
    intent.followUp === undefined ||
    isTerritoryIntentSuspensionActive(intent, gameTime) ||
    isRecoveredTerritoryFollowUpAttemptCoolingDown(intent, gameTime)
  ) {
    return false;
  }

  return intent.status === 'suppressed' && gameTime - intent.updatedAt > TERRITORY_SUPPRESSION_RETRY_TICKS;
}

function isRecoveredTerritoryFollowUpAttemptCoolingDown(intent: TerritoryIntentMemory, gameTime: number): boolean {
  return (
    intent.followUp !== undefined &&
    isFiniteNumber(intent.lastAttemptAt) &&
    gameTime >= intent.lastAttemptAt &&
    gameTime - intent.lastAttemptAt <= TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS
  );
}

function isRecoveredTerritoryFollowUpAttemptCoolingDownForAction(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction,
  gameTime: number
): boolean {
  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action &&
      isRecoveredTerritoryFollowUpAttemptCoolingDown(intent, gameTime)
  );
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

  const followUp = normalizeTerritoryFollowUp(assignment.followUp);
  return {
    colony: creep.memory?.colony ?? '',
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: 'active',
    updatedAt: getGameTime(),
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {}),
    ...(followUp ? { followUp } : {})
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

function compareTerritoryIntentProgressSummaries(
  left: TerritoryIntentProgressSummary,
  right: TerritoryIntentProgressSummary
): number {
  return (
    getIntentStatusPriority(left.status) - getIntentStatusPriority(right.status) ||
    right.activeCreepCount - left.activeCreepCount ||
    getIntentActionPriority(left.action) - getIntentActionPriority(right.action) ||
    right.updatedAt - left.updatedAt ||
    left.targetRoom.localeCompare(right.targetRoom)
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

  if (intent.action === 'reserve') {
    return canCreepActOnVisibleReserveController(creep, controller, intent.colony);
  }

  const actorUsername = getTerritoryActorUsername(creep, intent.colony);
  if (controller.my === true) {
    return true;
  }

  if (isForeignReservedController(controller, actorUsername)) {
    return canCreepPressureTerritoryController(creep, controller, intent.colony);
  }

  return (
    getTerritoryControllerTargetState(controller, intent.action, actorUsername) === 'available' &&
    canUseControllerClaimPart(creep)
  );
}

function canCreepActOnVisibleReserveController(
  creep: Creep,
  controller: StructureController,
  colony: string | undefined
): boolean {
  return (
    canCreepReserveTerritoryController(creep, controller, colony) ||
    canCreepPressureTerritoryController(creep, controller, colony)
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

  if (isControllerOwnedByColony(controller, colonyOwnerUsername)) {
    return 'satisfied';
  }

  return getClaimControllerTargetState(controller);
}

function getClaimControllerTargetState(controller: StructureController): TerritoryTargetVisibilityState {
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
    return activeClaimParts > 0 ? activeClaimParts : 0;
  }

  return Array.isArray(creep.body) ? creep.body.filter((part) => isActiveBodyPart(part, claimPart)).length : 0;
}

function isActiveBodyPart(part: unknown, bodyPartType: BodyPartConstant): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }

  const bodyPart = part as Partial<BodyPartDefinition>;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === 'number' && bodyPart.hits > 0;
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
  if (isKnownDeadZoneRoom(targetRoom)) {
    return true;
  }

  const room = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[targetRoom];
  return room ? isVisibleRoomUnsafe(room) : false;
}

function isVisibleRoomSafe(room: Room): boolean {
  return !isVisibleRoomUnsafe(room);
}

function isVisibleRoomUnsafe(room: Room): boolean {
  return findVisibleHostileCreeps(room).length > 0 || findVisibleHostileStructures(room).length > 0;
}

function getVisibleHostileCreepCount(targetRoom: string): number | null {
  const room = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[targetRoom];
  return room ? findVisibleHostileCreeps(room).length : null;
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

function isVisibleTerritoryIntentActionable(
  targetRoom: string,
  action: TerritoryIntentAction,
  controllerId: Id<StructureController> | undefined,
  colonyOwnerUsername: string | null
): boolean {
  return (
    getVisibleTerritoryTargetState(targetRoom, action, controllerId, colonyOwnerUsername) === 'available' ||
    isVisibleTerritoryReservePressureAvailable(targetRoom, action, controllerId, colonyOwnerUsername)
  );
}

function isVisibleTerritoryReservePressureAvailable(
  targetRoom: string,
  action: TerritoryIntentAction,
  controllerId: Id<StructureController> | undefined,
  colonyOwnerUsername: string | null
): boolean {
  if (!isTerritoryControlAction(action) || isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom)) {
    return false;
  }

  const controller = getVisibleController(targetRoom, controllerId);
  return controller !== null && isForeignReservedController(controller, colonyOwnerUsername);
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

function isHostileOwnedController(controller: StructureController | undefined): boolean {
  if (controller?.owner == null) {
    return false;
  }

  return controller.my !== true;
}

function isControllerOwnedByColony(controller: StructureController, colonyOwnerUsername: string | null): boolean {
  const ownerUsername = getControllerOwnerUsername(controller);
  return controller.my === true || (isNonEmptyString(ownerUsername) && ownerUsername === colonyOwnerUsername);
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

function isForeignReservedController(
  controller: StructureController,
  actorUsername: string | null
): boolean {
  if (isControllerOwned(controller) || !isNonEmptyString(actorUsername)) {
    return false;
  }

  const reservation = controller.reservation;
  return isNonEmptyString(reservation?.username) && reservation.username !== actorUsername;
}

function isOwnReservedController(
  controller: StructureController,
  actorUsername: string | null
): boolean {
  const reservation = controller.reservation;
  return isNonEmptyString(actorUsername) && isNonEmptyString(reservation?.username) && reservation.username === actorUsername;
}

function updateTerritoryReservationMemory(
  territoryMemory: TerritoryMemory,
  colony: string,
  roomName: string,
  controllerId: Id<StructureController> | undefined,
  gameTime: number,
  reservationTicksToEnd: number | null
): void {
  if (reservationTicksToEnd === null) {
    return;
  }

  const reservations = normalizeTerritoryReservations(territoryMemory.reservations);
  const reservationKey = getTerritoryReservationMemoryKey(colony, roomName);
  const nextReservation: TerritoryReservationMemory = {
    colony,
    roomName,
    ticksToEnd: reservationTicksToEnd,
    updatedAt: gameTime,
    ...(controllerId ? { controllerId } : {})
  };
  if (!isSameTerritoryReservation(reservations[reservationKey], nextReservation)) {
    reservations[reservationKey] = nextReservation;
    setTerritoryReservations(territoryMemory, reservations);
  }
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

function shouldSpawnEmergencyReservationRenewal(
  plan: TerritoryIntentPlan,
  activeCoverageCount: number
): boolean {
  if (
    activeCoverageCount >= TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET ||
    plan.action !== 'reserve'
  ) {
    return false;
  }

  const controller = getVisibleController(plan.targetRoom, plan.controllerId);
  if (!controller || isControllerOwned(controller)) {
    return false;
  }

  const colonyOwnerUsername = getVisibleColonyOwnerUsername(plan.colony);
  const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
  return ticksToEnd !== null && ticksToEnd <= TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS;
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

function getRemoteMiningBootstrapRecords(
  territoryMemory: TerritoryMemory,
  colonyName: string
): TerritoryPostClaimBootstrapMemory[] {
  const records = territoryMemory.postClaimBootstraps;
  if (!isRecord(records)) {
    return [];
  }

  return Object.values(records)
    .filter((record): record is TerritoryPostClaimBootstrapMemory => isRemoteMiningBootstrapRecord(record, colonyName))
    .sort(compareRemoteMiningBootstrapRecords);
}

function isRemoteMiningBootstrapRecord(
  record: unknown,
  colonyName: string
): record is TerritoryPostClaimBootstrapMemory {
  return (
    isRecord(record) &&
    record.colony === colonyName &&
    isNonEmptyString(record.roomName) &&
    record.roomName !== colonyName &&
    isPostClaimRemoteMiningStatus(record.status)
  );
}

function isPostClaimRemoteMiningStatus(status: unknown): status is TerritoryPostClaimBootstrapStatus {
  return (
    status === 'detected' ||
    status === 'spawnSitePending' ||
    status === 'spawnSiteBlocked' ||
    status === 'spawningWorkers' ||
    status === 'ready'
  );
}

function compareRemoteMiningBootstrapRecords(
  left: TerritoryPostClaimBootstrapMemory,
  right: TerritoryPostClaimBootstrapMemory
): number {
  return left.claimedAt - right.claimedAt || left.roomName.localeCompare(right.roomName);
}

function getRemoteMiningMemoryKey(colony: string, roomName: string): string {
  return `${colony}:${roomName}`;
}

function updateRemoteMiningRoomMemoryIfChanged(
  remoteMining: Record<string, TerritoryRemoteMiningRoomMemory>,
  key: string,
  nextState: RemoteMiningRoomState,
  gameTime: number
): void {
  const previous = remoteMining[key];
  const candidate: TerritoryRemoteMiningRoomMemory = {
    ...nextState,
    updatedAt: previous?.updatedAt ?? gameTime
  };

  if (isSameRemoteMiningRoomMemory(previous, candidate)) {
    return;
  }

  remoteMining[key] = {
    ...nextState,
    updatedAt: gameTime
  };
}

function isSameRemoteMiningRoomMemory(
  left: TerritoryRemoteMiningRoomMemory | undefined,
  right: TerritoryRemoteMiningRoomMemory
): boolean {
  return (
    left != null &&
    left.colony === right.colony &&
    left.roomName === right.roomName &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt &&
    isSameRemoteMiningSources(left.sources, right.sources)
  );
}

function isSameRemoteMiningSources(
  left: Record<string, TerritoryRemoteMiningSourceMemory> | undefined,
  right: Record<string, TerritoryRemoteMiningSourceMemory>
): boolean {
  if (!isRecord(left)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return rightKeys.every((key) => isSameRemoteMiningSource(left[key], right[key]));
}

function isSameRemoteMiningSource(
  left: TerritoryRemoteMiningSourceMemory | undefined,
  right: TerritoryRemoteMiningSourceMemory
): boolean {
  return (
    left != null &&
    left.sourceId === right.sourceId &&
    left.containerId === right.containerId &&
    left.containerBuilt === right.containerBuilt &&
    left.containerSitePending === right.containerSitePending &&
    left.harvesterAssigned === right.harvesterAssigned &&
    left.haulerAssigned === right.haulerAssigned &&
    left.energyAvailable === right.energyAvailable &&
    left.energyFlowing === right.energyFlowing
  );
}

function isRemoteMiningSuspended(
  territoryMemory: TerritoryMemory,
  colony: string,
  roomName: string,
  gameTime: number
): boolean {
  if (isKnownDeadZoneRoom(roomName)) {
    return true;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === roomName &&
      isTerritoryIntentSuspensionActive(intent, gameTime)
  );
}

function getRemoteMiningSources(room: Room): Source[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return (room.find(FIND_SOURCES) as Source[]).sort((left, right) =>
    String(left.id).localeCompare(String(right.id))
  );
}

function getRemoteMiningAssignedCreeps(homeRoom: string, targetRoom: string): Creep[] {
  const findMyCreeps = (globalThis as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
  if (typeof findMyCreeps !== 'number') {
    return [];
  }

  const seen = new Set<string>();
  const creeps: Creep[] = [];
  for (const roomName of [homeRoom, targetRoom]) {
    const room = getVisibleRoom(roomName);
    if (!room || typeof room.find !== 'function') {
      continue;
    }

    const roomCreeps = room.find(findMyCreeps as FindConstant) as Creep[];
    if (!Array.isArray(roomCreeps)) {
      continue;
    }

    for (const creep of roomCreeps) {
      const key = getRemoteMiningCreepKey(creep);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      creeps.push(creep);
    }
  }

  return creeps;
}

function getRemoteMiningCreepKey(creep: Creep): string {
  return creep.name ?? `${creep.memory?.role ?? 'creep'}:${creep.memory?.colony ?? ''}:${creep.ticksToLive ?? ''}`;
}

function hasAssignedRemoteHarvester(
  creeps: Creep[],
  homeRoom: string,
  targetRoom: string,
  sourceId: string
): boolean {
  return creeps.some(
    (creep) =>
      creep.memory?.role === 'remoteHarvester' &&
      creep.memory.remoteHarvester?.homeRoom === homeRoom &&
      creep.memory.remoteHarvester?.targetRoom === targetRoom &&
      String(creep.memory.remoteHarvester?.sourceId) === sourceId
  );
}

function hasAssignedRemoteHauler(
  creeps: Creep[],
  homeRoom: string,
  targetRoom: string,
  sourceId: string,
  container: StructureContainer | null
): boolean {
  return creeps.some(
    (creep) =>
      creep.memory?.role === 'hauler' &&
      creep.memory.remoteHauler?.homeRoom === homeRoom &&
      creep.memory.remoteHauler?.targetRoom === targetRoom &&
      String(creep.memory.remoteHauler?.sourceId) === sourceId &&
      (container === null || String(creep.memory.remoteHauler?.containerId) === String(container.id))
  );
}

function hasRemoteEnergyFlow(
  container: StructureContainer,
  creeps: Creep[],
  record: TerritoryPostClaimBootstrapMemory,
  sourceId: string
): boolean {
  return (
    getStoredEnergy(container) > 0 ||
    hasAssignedRemoteHauler(creeps, record.colony, record.roomName, sourceId, container)
  );
}

function getRemoteMiningStatus(
  sources: TerritoryRemoteMiningSourceMemory[]
): TerritoryRemoteMiningStatus {
  if (sources.length === 0 || sources.some((source) => !source.containerBuilt)) {
    return 'containerPending';
  }

  if (sources.some((source) => source.harvesterAssigned || source.energyFlowing)) {
    return 'active';
  }

  return 'containerReady';
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

function isTerritoryFollowUpSource(source: unknown): source is TerritoryFollowUpSource {
  return (
    source === 'satisfiedClaimAdjacent' ||
    source === 'satisfiedReserveAdjacent' ||
    source === 'activeReserveAdjacent'
  );
}

function isTerritoryExecutionHintReason(reason: unknown): reason is TerritoryExecutionHintReason {
  return (
    reason === 'controlEvidenceStillMissing' ||
    reason === 'followUpTargetStillUnseen' ||
    reason === 'visibleControlEvidenceStillActionable'
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
