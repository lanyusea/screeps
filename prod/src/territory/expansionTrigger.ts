import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY,
  getTerritoryAutoClaimRequiredEnergy
} from './autoClaim';
import {
  NEXT_EXPANSION_TARGET_CREATOR,
  maxRoomsForRcl,
  type ExpansionCandidateReport,
  type ExpansionCandidateScore,
  type NextExpansionTargetSelection
} from './expansionScoring';
import {
  isClaimPlanBlockedByHigherPriorityColony,
  pruneLowerPriorityDuplicateClaimPlans
} from './multiRoomTerritory';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  ensureTerritoryScoutAttempt,
  recordTerritoryScoutValidation,
  recordVisibleRoomScoutIntel,
  validateTerritoryScoutIntelForClaim,
  type TerritoryScoutValidationResult
} from './scoutIntel';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';
import {
  getActivePostClaimBootstrapBlockers,
  recordPostClaimBootstrapClaimSuccess
} from './postClaimBootstrap';
import {
  getTerritoryExpansionScoutTargets,
  isConfiguredExpansionScoutOnlyTarget
} from './expansionConfig';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyTemplates';
import {
  AUTONOMOUS_TERRITORY_CONTROL_ABORT_REASON,
  getAutonomousTerritoryControlMinRcl,
  isAutonomousTerritoryControlAllowedForColony
} from './controlGate';

const DEFAULT_EXPANSION_TRIGGER_SCORE_THRESHOLD = 700;
const DEFAULT_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY = 0;
const EXPANSION_TRIGGER_THREAT_MEMORY_STALE_TICKS = 5;
const EXPANSION_TRIGGER_DOWNGRADE_GUARD_TICKS = 5_000;
const EXPANSION_PIPELINE_REEVALUATION_SEPARATOR = '>';
const GCL_LIMIT_PRECONDITION = 'wait for GCL capacity to claim another room';
const ROOM_LIMIT_PRECONDITION_PREFIX = 'limit expansion to ';

interface ExpansionTriggerConfig {
  scoreThreshold: number;
  minStorageEnergy: number;
  minRcl: number;
}

interface ExpansionTriggerCandidate {
  candidate: ExpansionCandidateScore;
  config: ExpansionTriggerConfig;
}

export function refreshAutonomousExpansionPipeline(
  colony: ColonySnapshot,
  report: ExpansionCandidateReport,
  gameTime = getGameTime(),
  telemetryEvents: RuntimeTelemetryEvent[] = []
): NextExpansionTargetSelection {
  const colonyName = colony.room.name;
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'unavailable'
    };
  }

  const activePipeline = getActiveExpansionPipeline(territoryMemory, colonyName);
  if (!isAutonomousTerritoryControlAllowedForColony(colony)) {
    if (activePipeline) {
      return abortExpansionPipeline(
        territoryMemory,
        activePipeline,
        AUTONOMOUS_TERRITORY_CONTROL_ABORT_REASON,
        gameTime,
        'unmetPreconditions'
      );
    }

    prunePipelinePlans(territoryMemory, colonyName);
    return {
      status: 'skipped',
      colony: colonyName,
      reason: getPreControlGateSkipReason(report)
    };
  }

  if (activePipeline) {
    return refreshExpansionPipelineStage(colony, activePipeline, gameTime, telemetryEvents, territoryMemory);
  }

  const trigger = selectExpansionTriggerCandidate(colony, report, territoryMemory, gameTime);
  if (!trigger) {
    prunePipelinePlans(territoryMemory, colonyName);
    return {
      status: 'skipped',
      colony: colonyName,
      reason: getTriggerSkipReason(colony, report, territoryMemory, gameTime)
    };
  }

  const pipeline = createExpansionPipeline(colonyName, trigger.candidate, trigger.config, gameTime);
  setExpansionPipeline(territoryMemory, pipeline);
  return refreshExpansionPipelineStage(colony, pipeline, gameTime, telemetryEvents, territoryMemory);
}

export function hasActiveAutonomousExpansionPipeline(colony: string): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  return territoryMemory ? getActiveExpansionPipeline(territoryMemory, colony) !== null : false;
}

export function getAutonomousExpansionPipelineStateKey(colony: string): string {
  const territoryMemory = getTerritoryMemoryRecord();
  const pipeline = territoryMemory ? getActiveExpansionPipeline(territoryMemory, colony) : null;
  if (!pipeline) {
    return 'pipeline:none';
  }

  return [
    'pipeline',
    pipeline.status,
    pipeline.stage,
    pipeline.targetRoom,
    pipeline.controllerId ?? 'unknown',
    pipeline.reservationConfirmedAt ?? 0,
    pipeline.claimedAt ?? 0,
    pipeline.claimState ?? 'none',
    pipeline.updatedAt
  ].join(':');
}

export function recordExpansionPipelineClaimState({
  colony,
  targetRoom,
  claimState,
  gameTime = getGameTime(),
  controllerId
}: {
  colony: string;
  targetRoom: string;
  claimState: TerritoryExpansionClaimState;
  gameTime?: number;
  controllerId?: Id<StructureController>;
}): void {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const activePipeline = getActiveExpansionPipeline(territoryMemory, colony);
  if (!activePipeline || activePipeline.targetRoom !== targetRoom) {
    return;
  }

  const nextPipeline =
    claimState === 'claimed' && controllerId
      ? markPipelineClaimed(activePipeline, controllerId, gameTime)
      : {
          ...activePipeline,
          stage: 'claiming' as const,
          claimState,
          updatedAt: gameTime,
          ...(controllerId ?? activePipeline.controllerId
            ? { controllerId: (controllerId ?? activePipeline.controllerId) as Id<StructureController> }
            : {})
        };
  setExpansionPipeline(territoryMemory, nextPipeline);
}

function refreshExpansionPipelineStage(
  colony: ColonySnapshot,
  pipeline: TerritoryExpansionPipelineMemory,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[],
  territoryMemory: TerritoryMemory
): NextExpansionTargetSelection {
  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller);
  const capacityReason = getExpansionCapacitySkipReason(colony);
  if (capacityReason && !isExpansionPipelineTargetOwned(pipeline, colonyOwnerUsername)) {
    return abortExpansionPipeline(territoryMemory, pipeline, 'homeUnstable', gameTime, capacityReason);
  }

  if (!isExpansionHomeStable(colony, gameTime, getPipelineConfig(pipeline))) {
    return abortExpansionPipeline(territoryMemory, pipeline, 'homeUnstable', gameTime);
  }

  switch (pipeline.stage) {
    case 'scouting':
      return refreshScoutingStage(colony, pipeline, gameTime, telemetryEvents, territoryMemory, colonyOwnerUsername);
    case 'reserving':
      return refreshReservingStage(colony, pipeline, gameTime, telemetryEvents, territoryMemory, colonyOwnerUsername);
    case 'claiming':
      return refreshClaimingStage(colony, pipeline, gameTime, telemetryEvents, territoryMemory, colonyOwnerUsername);
    case 'bootstrapping':
      return refreshBootstrappingStage(pipeline, gameTime, telemetryEvents, territoryMemory);
    default:
      return abortExpansionPipeline(territoryMemory, pipeline, 'homeUnstable', gameTime);
  }
}

function refreshScoutingStage(
  colony: ColonySnapshot,
  pipeline: TerritoryExpansionPipelineMemory,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[],
  territoryMemory: TerritoryMemory,
  colonyOwnerUsername: string | undefined
): NextExpansionTargetSelection {
  const visibleRoom = getVisibleRoom(pipeline.targetRoom);
  if (visibleRoom) {
    recordVisibleRoomScoutIntel(colony.room.name, visibleRoom, gameTime, undefined, telemetryEvents);
  }

  const validation = validateTerritoryScoutIntelForClaim({
    colony: pipeline.colony,
    targetRoom: pipeline.targetRoom,
    ...(colonyOwnerUsername ? { colonyOwnerUsername } : {}),
    gameTime
  });
  const controllerId = pipeline.controllerId ?? validation.intel?.controller?.id;
  recordTerritoryScoutValidation(
    pipeline.colony,
    pipeline.targetRoom,
    validation,
    gameTime,
    telemetryEvents,
    controllerId,
    pipeline.score
  );

  if (validation.status === 'blocked' || validation.status === 'fallback') {
    return abortExpansionPipeline(
      territoryMemory,
      withPipelineControllerId(pipeline, controllerId),
      getScoutValidationAbortReason(validation),
      gameTime
    );
  }

  if (validation.status === 'pending') {
    prunePipelinePlans(territoryMemory, pipeline.colony, pipeline.targetRoom);
    ensureTerritoryScoutAttempt(pipeline.colony, pipeline.targetRoom, gameTime, telemetryEvents, controllerId);
    setExpansionPipeline(territoryMemory, {
      ...pipeline,
      updatedAt: gameTime,
      ...(controllerId ? { controllerId } : {})
    });
    return toPlannedSelection(pipeline, controllerId);
  }

  const nextPipeline = shouldDirectClaimScoutedPipeline(pipeline)
    ? {
        ...pipeline,
        stage: 'claiming' as const,
        claimState: 'scouted' as const,
        updatedAt: gameTime,
        ...(controllerId ? { controllerId } : {})
      }
    : {
        ...pipeline,
        stage: 'reserving' as const,
        updatedAt: gameTime,
        ...(controllerId ? { controllerId } : {})
      };
  setExpansionPipeline(territoryMemory, nextPipeline);
  return nextPipeline.stage === 'claiming'
    ? refreshClaimingStage(colony, nextPipeline, gameTime, telemetryEvents, territoryMemory, colonyOwnerUsername)
    : refreshReservingStage(colony, nextPipeline, gameTime, telemetryEvents, territoryMemory, colonyOwnerUsername);
}

function refreshReservingStage(
  colony: ColonySnapshot,
  pipeline: TerritoryExpansionPipelineMemory,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[],
  territoryMemory: TerritoryMemory,
  colonyOwnerUsername: string | undefined
): NextExpansionTargetSelection {
  const visibleRoom = getVisibleRoom(pipeline.targetRoom);
  const visibleAbort = visibleRoom ? getVisibleTargetAbortReason(visibleRoom, colonyOwnerUsername) : null;
  if (visibleAbort) {
    return abortExpansionPipeline(territoryMemory, pipeline, visibleAbort, gameTime);
  }

  const controller = visibleRoom?.controller;
  if (controller?.my === true) {
    const nextPipeline = markPipelineClaimed(pipeline, controller.id, gameTime);
    setExpansionPipeline(territoryMemory, nextPipeline);
    recordPostClaimBootstrapClaimSuccess(
      { colony: pipeline.colony, roomName: pipeline.targetRoom, controllerId: controller.id },
      telemetryEvents
    );
    return refreshBootstrappingStage(nextPipeline, gameTime, telemetryEvents, territoryMemory);
  }

  const ownReservation = controller ? getOwnReservationTicksToEnd(controller, colonyOwnerUsername) : null;
  if (controller && ownReservation !== null) {
    const nextPipeline = {
      ...pipeline,
      stage: 'claiming' as const,
      updatedAt: gameTime,
      reservationConfirmedAt: gameTime,
      ...(controller.id ? { controllerId: controller.id } : {})
    };
    setExpansionPipeline(territoryMemory, nextPipeline);
    persistPipelineControlPlan(territoryMemory, nextPipeline, 'claim', gameTime);
    return toPlannedSelection(nextPipeline);
  }

  setExpansionPipeline(territoryMemory, { ...pipeline, updatedAt: gameTime });
  persistPipelineControlPlan(territoryMemory, pipeline, 'reserve', gameTime);
  return toPlannedSelection(pipeline);
}

function refreshClaimingStage(
  colony: ColonySnapshot,
  pipeline: TerritoryExpansionPipelineMemory,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[],
  territoryMemory: TerritoryMemory,
  colonyOwnerUsername: string | undefined
): NextExpansionTargetSelection {
  const visibleRoom = getVisibleRoom(pipeline.targetRoom);
  const visibleAbort = visibleRoom ? getVisibleTargetAbortReason(visibleRoom, colonyOwnerUsername) : null;
  if (visibleAbort) {
    return abortExpansionPipeline(territoryMemory, pipeline, visibleAbort, gameTime);
  }

  const controller = visibleRoom?.controller;
  if (controller?.my === true) {
    const nextPipeline = markPipelineClaimed(pipeline, controller.id, gameTime);
    setExpansionPipeline(territoryMemory, nextPipeline);
    recordPostClaimBootstrapClaimSuccess(
      { colony: pipeline.colony, roomName: pipeline.targetRoom, controllerId: controller.id },
      telemetryEvents
    );
    return refreshBootstrappingStage(nextPipeline, gameTime, telemetryEvents, territoryMemory);
  }

  if (
    controller &&
    pipeline.reservationConfirmedAt !== undefined &&
    getOwnReservationTicksToEnd(controller, colonyOwnerUsername) === null
  ) {
    return abortExpansionPipeline(territoryMemory, pipeline, 'reservationLost', gameTime);
  }

  setExpansionPipeline(territoryMemory, {
    ...pipeline,
    claimState: pipeline.claimState === 'claiming' ? 'claiming' : 'scouted',
    updatedAt: gameTime
  });
  persistPipelineControlPlan(territoryMemory, pipeline, 'claim', gameTime);
  return toPlannedSelection(pipeline);
}

function refreshBootstrappingStage(
  pipeline: TerritoryExpansionPipelineMemory,
  gameTime: number,
  telemetryEvents: RuntimeTelemetryEvent[],
  territoryMemory: TerritoryMemory
): NextExpansionTargetSelection {
  const visibleRoom = getVisibleRoom(pipeline.targetRoom);
  const controller = visibleRoom?.controller;
  const bootstrapRecord = territoryMemory.postClaimBootstraps?.[pipeline.targetRoom];
  if (bootstrapRecord?.status === 'ready') {
    prunePipelinePlans(territoryMemory, pipeline.colony, pipeline.targetRoom);
    const completedPipeline: TerritoryExpansionPipelineMemory = {
      ...pipeline,
      status: 'completed',
      updatedAt: gameTime,
      completedAt: gameTime
    };
    setExpansionPipeline(territoryMemory, completedPipeline);
    return {
      status: 'skipped',
      colony: pipeline.colony,
      reason: 'noCandidate'
    };
  }

  if (controller?.my === true) {
    recordPostClaimBootstrapClaimSuccess(
      { colony: pipeline.colony, roomName: pipeline.targetRoom, controllerId: controller.id },
      telemetryEvents
    );
  } else if (visibleRoom && controller) {
    return abortExpansionPipeline(territoryMemory, pipeline, 'controllerOwned', gameTime);
  }

  prunePipelinePlans(territoryMemory, pipeline.colony, pipeline.targetRoom);
  setExpansionPipeline(territoryMemory, {
    ...pipeline,
    stage: 'bootstrapping',
    updatedAt: gameTime,
    ...(controller?.id ? { controllerId: controller.id } : {})
  });
  return toPlannedSelection(pipeline, controller?.id);
}

function selectExpansionTriggerCandidate(
  colony: ColonySnapshot,
  report: ExpansionCandidateReport,
  territoryMemory: TerritoryMemory,
  gameTime: number
): ExpansionTriggerCandidate | null {
  const config = getExpansionTriggerConfig();
  if (!isExpansionTriggerReady(colony, gameTime, config)) {
    return null;
  }

  if (hasBlockingExpansionInProgress(territoryMemory, colony.room.name)) {
    return null;
  }

  const candidate = findExpansionTriggerCandidate(colony, report, territoryMemory, config);
  return candidate ? { candidate, config } : null;
}

function findExpansionTriggerCandidate(
  colony: ColonySnapshot,
  report: ExpansionCandidateReport,
  territoryMemory: TerritoryMemory,
  config: ExpansionTriggerConfig
): ExpansionCandidateScore | null {
  return report.candidates.find(
    (scoredCandidate) =>
      scoredCandidate.evidenceStatus !== 'unavailable' &&
      !isConfiguredExpansionScoutOnlyTarget(colony.room.name, scoredCandidate.roomName) &&
      scoredCandidate.score >= config.scoreThreshold &&
      scoredCandidate.preconditions.length === 0 &&
      !isClaimPlanBlockedByHigherPriorityColony({
        colony,
        targetRoom: scoredCandidate.roomName,
        ...(scoredCandidate.routeDistance !== undefined ? { routeDistance: scoredCandidate.routeDistance } : {}),
        ...(scoredCandidate.nearestOwnedRoom ? { nearestOwnedRoom: scoredCandidate.nearestOwnedRoom } : {}),
        ...(scoredCandidate.nearestOwnedRoomDistance !== undefined
          ? { nearestOwnedRoomDistance: scoredCandidate.nearestOwnedRoomDistance }
          : {}),
        territoryMemory
      })
  ) ?? null;
}

function getTriggerSkipReason(
  colony: ColonySnapshot,
  report: ExpansionCandidateReport,
  territoryMemory: TerritoryMemory,
  gameTime: number
): NextExpansionTargetSelection['reason'] {
  if (report.candidates.length === 0) {
    return 'noCandidate';
  }

  if (report.candidates.some((candidate) => candidate.preconditions.includes(GCL_LIMIT_PRECONDITION))) {
    return 'gclInsufficient';
  }

  if (
    report.candidates.some((candidate) =>
      candidate.preconditions.some((precondition) => precondition.startsWith(ROOM_LIMIT_PRECONDITION_PREFIX))
    )
  ) {
    return 'roomLimitReached';
  }

  const config = getExpansionTriggerConfig();
  if (!isExpansionHomeStable(colony, gameTime, config)) {
    return 'unmetPreconditions';
  }

  if (hasBlockingExpansionInProgress(territoryMemory, colony.room.name)) {
    return 'unmetPreconditions';
  }

  if (
    !isExpansionTriggerReady(colony, gameTime, config) &&
    findExpansionTriggerCandidate(colony, report, territoryMemory, config)
  ) {
    return 'unmetPreconditions';
  }

  if (report.candidates.some((candidate) => candidate.evidenceStatus === 'insufficient-evidence')) {
    return 'insufficientEvidence';
  }

  if (report.candidates.some((candidate) => candidate.preconditions.length > 0)) {
    return 'unmetPreconditions';
  }

  if (!isExpansionTriggerReady(colony, gameTime, config)) {
    return 'unmetPreconditions';
  }

  return 'unavailable';
}

function getPreControlGateSkipReason(report: ExpansionCandidateReport): NextExpansionTargetSelection['reason'] {
  if (report.candidates.length === 0) {
    return 'noCandidate';
  }

  if (report.candidates.some((candidate) => candidate.evidenceStatus === 'insufficient-evidence')) {
    return 'insufficientEvidence';
  }

  return 'unmetPreconditions';
}

function createExpansionPipeline(
  colony: string,
  candidate: ExpansionCandidateScore,
  config: ExpansionTriggerConfig,
  gameTime: number
): TerritoryExpansionPipelineMemory {
  const directClaim = shouldDirectClaimScoutedCandidate(colony, candidate);
  return {
    colony,
    targetRoom: candidate.roomName,
    status: 'active',
    stage: directClaim ? 'claiming' : candidate.evidenceStatus === 'sufficient' ? 'reserving' : 'scouting',
    ...(directClaim ? { claimState: 'scouted' as const } : {}),
    score: candidate.score,
    threshold: config.scoreThreshold,
    startedAt: gameTime,
    updatedAt: gameTime,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
}

function shouldDirectClaimScoutedCandidate(colony: string, candidate: ExpansionCandidateScore): boolean {
  return (
    candidate.evidenceStatus === 'sufficient' &&
    candidate.visible === false &&
    isConfiguredAdjacentClaimTarget(colony, candidate.roomName)
  );
}

function shouldDirectClaimScoutedPipeline(pipeline: TerritoryExpansionPipelineMemory): boolean {
  return isConfiguredAdjacentClaimTarget(pipeline.colony, pipeline.targetRoom);
}

function isConfiguredAdjacentClaimTarget(colony: string, targetRoom: string): boolean {
  return getTerritoryExpansionScoutTargets(colony).some(
    (target) =>
      target.colony === colony &&
      target.roomName === targetRoom &&
      target.scoutOnly !== true &&
      target.adjacentToOwnedRoom === true &&
      target.nearestOwnedRoomDistance <= 1
  );
}

function markPipelineClaimed(
  pipeline: TerritoryExpansionPipelineMemory,
  controllerId: Id<StructureController>,
  gameTime: number
): TerritoryExpansionPipelineMemory {
  return {
    ...pipeline,
    stage: 'bootstrapping',
    claimState: 'claimed',
    updatedAt: gameTime,
    claimedAt: pipeline.claimedAt ?? gameTime,
    controllerId
  };
}

function abortExpansionPipeline(
  territoryMemory: TerritoryMemory,
  pipeline: TerritoryExpansionPipelineMemory,
  reason: TerritoryExpansionAbortReason,
  gameTime: number,
  selectionReason?: NextExpansionTargetSelection['reason']
): NextExpansionTargetSelection {
  const abortedPipeline: TerritoryExpansionPipelineMemory = {
    ...pipeline,
    status: 'aborted',
    abortReason: reason,
    abortedAt: gameTime,
    updatedAt: gameTime
  };
  setExpansionPipeline(territoryMemory, abortedPipeline);
  recordExpansionReevaluation(territoryMemory, abortedPipeline, reason, gameTime);
  prunePipelinePlans(territoryMemory, pipeline.colony, pipeline.targetRoom);
  return {
    status: 'skipped',
    colony: pipeline.colony,
    reason:
      selectionReason ??
      (reason === 'homeUnstable' || reason === 'existingExpansion' ? 'unmetPreconditions' : 'unavailable'),
    targetRoom: pipeline.targetRoom,
    ...(pipeline.controllerId ? { controllerId: pipeline.controllerId } : {}),
    score: pipeline.score
  };
}

function recordExpansionReevaluation(
  territoryMemory: TerritoryMemory,
  pipeline: TerritoryExpansionPipelineMemory,
  reason: TerritoryExpansionAbortReason,
  gameTime: number
): void {
  if (!isRecord(territoryMemory.expansionReevaluations) || Array.isArray(territoryMemory.expansionReevaluations)) {
    territoryMemory.expansionReevaluations = {};
  }

  territoryMemory.expansionReevaluations[getExpansionReevaluationKey(pipeline.colony, pipeline.targetRoom)] = {
    colony: pipeline.colony,
    roomName: pipeline.targetRoom,
    reason,
    updatedAt: gameTime,
    score: pipeline.score
  };
}

function getScoutValidationAbortReason(
  validation: TerritoryScoutValidationResult
): TerritoryExpansionAbortReason {
  switch (validation.reason) {
    case 'controllerMissing':
      return 'controllerMissing';
    case 'controllerOwned':
      return 'controllerOwned';
    case 'controllerReserved':
      return 'controllerReserved';
    case 'hostilePresence':
    case 'hostileSpawn':
      return 'targetHostile';
    case 'sourcesMissing':
      return 'sourcesMissing';
    case 'scoutTimeout':
      return 'scoutTimedOut';
    case 'intelMissing':
    case 'scoutPending':
    default:
      return 'scoutTimedOut';
  }
}

function getVisibleTargetAbortReason(
  room: Room,
  colonyOwnerUsername: string | undefined
): TerritoryExpansionAbortReason | null {
  if (hasVisibleHostiles(room)) {
    return 'targetHostile';
  }

  const controller = room.controller;
  if (!controller) {
    return 'controllerMissing';
  }

  if (controller.my === true) {
    return null;
  }

  const ownerUsername = getControllerOwnerUsername(controller);
  if (ownerUsername && ownerUsername !== colonyOwnerUsername) {
    return 'controllerOwned';
  }

  const reservationUsername = getControllerReservationUsername(controller);
  if (reservationUsername && reservationUsername !== colonyOwnerUsername) {
    return 'controllerReserved';
  }

  return null;
}

function persistPipelineControlPlan(
  territoryMemory: TerritoryMemory,
  pipeline: TerritoryExpansionPipelineMemory,
  action: TerritoryControlAction,
  gameTime: number
): void {
  prunePipelinePlans(territoryMemory, pipeline.colony, pipeline.targetRoom);
  if (action === 'claim') {
    pruneLowerPriorityDuplicateClaimPlans(territoryMemory, pipeline.colony, pipeline.targetRoom);
  }
  const postClaimBootstrapReserveEnergy = getPipelinePostClaimBootstrapReserveEnergy(pipeline, action);
  const target: TerritoryTargetMemory = {
    colony: pipeline.colony,
    roomName: pipeline.targetRoom,
    action,
    createdBy: NEXT_EXPANSION_TARGET_CREATOR,
    ...(pipeline.controllerId ? { controllerId: pipeline.controllerId } : {}),
    ...(postClaimBootstrapReserveEnergy !== undefined ? { postClaimBootstrapReserveEnergy } : {})
  };
  upsertTerritoryTarget(territoryMemory, target);

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  upsertTerritoryIntent(intents, {
    colony: pipeline.colony,
    targetRoom: pipeline.targetRoom,
    action,
    status: 'planned',
    updatedAt: gameTime,
    createdBy: NEXT_EXPANSION_TARGET_CREATOR,
    ...(pipeline.controllerId ? { controllerId: pipeline.controllerId } : {}),
    ...(postClaimBootstrapReserveEnergy !== undefined ? { postClaimBootstrapReserveEnergy } : {})
  });
}

function getPipelinePostClaimBootstrapReserveEnergy(
  pipeline: TerritoryExpansionPipelineMemory,
  action: TerritoryControlAction
): number | undefined {
  if (action !== 'claim' || TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY <= 0) {
    return undefined;
  }

  const energyCapacityAvailable = getVisibleRoom(pipeline.colony)?.energyCapacityAvailable;
  if (typeof energyCapacityAvailable !== 'number' || !Number.isFinite(energyCapacityAvailable)) {
    return TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY;
  }

  const spawnableReserveEnergy = Math.max(0, Math.floor(energyCapacityAvailable) - TERRITORY_CONTROLLER_BODY_COST);
  const reserveEnergy = Math.min(TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY, spawnableReserveEnergy);
  return reserveEnergy > 0 ? reserveEnergy : undefined;
}

function prunePipelinePlans(
  territoryMemory: TerritoryMemory,
  colony: string,
  targetRoom?: string
): void {
  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter((target) => {
      if (!isPipelineTarget(target, colony, targetRoom)) {
        return true;
      }

      return false;
    });
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) => !isPipelineIntent(intent, colony, targetRoom)
  );
  if (intents.length > 0) {
    territoryMemory.intents = intents;
  } else {
    delete territoryMemory.intents;
  }
}

function isPipelineTarget(target: unknown, colony: string, targetRoom: string | undefined): boolean {
  return (
    isRecord(target) &&
    target.colony === colony &&
    target.createdBy === NEXT_EXPANSION_TARGET_CREATOR &&
    (targetRoom === undefined || target.roomName === targetRoom)
  );
}

function isPipelineIntent(intent: TerritoryIntentMemory, colony: string, targetRoom: string | undefined): boolean {
  return (
    intent.colony === colony &&
    (targetRoom === undefined || intent.targetRoom === targetRoom) &&
    (intent.createdBy === NEXT_EXPANSION_TARGET_CREATOR ||
      (targetRoom !== undefined && intent.action === 'scout' && intent.createdBy === undefined))
  );
}

function upsertTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingIndex = territoryMemory.targets.findIndex(
    (rawTarget) =>
      isRecord(rawTarget) &&
      rawTarget.colony === target.colony &&
      rawTarget.roomName === target.roomName &&
      rawTarget.action === target.action
  );
  if (existingIndex < 0) {
    territoryMemory.targets.push(target);
    return;
  }

  territoryMemory.targets[existingIndex] = target;
}

function upsertTerritoryIntent(intents: TerritoryIntentMemory[], nextIntent: TerritoryIntentMemory): void {
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === nextIntent.colony &&
      intent.targetRoom === nextIntent.targetRoom &&
      intent.action === nextIntent.action
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = {
      ...nextIntent,
      status: intents[existingIndex].status === 'active' ? 'active' : nextIntent.status
    };
    return;
  }

  intents.push(nextIntent);
}

function getActiveExpansionPipeline(
  territoryMemory: TerritoryMemory,
  colony: string
): TerritoryExpansionPipelineMemory | null {
  const rawPipeline = getExpansionPipelinesRecord(territoryMemory)[colony];
  const pipeline = normalizeExpansionPipeline(rawPipeline, colony);
  return pipeline?.status === 'active' ? pipeline : null;
}

function setExpansionPipeline(
  territoryMemory: TerritoryMemory,
  pipeline: TerritoryExpansionPipelineMemory
): void {
  const pipelines = getExpansionPipelinesRecord(territoryMemory);
  pipelines[pipeline.colony] = pipeline;
}

function getExpansionPipelinesRecord(
  territoryMemory: TerritoryMemory
): Record<string, TerritoryExpansionPipelineMemory> {
  if (!isRecord(territoryMemory.expansionPipelines) || Array.isArray(territoryMemory.expansionPipelines)) {
    territoryMemory.expansionPipelines = {};
  }

  return territoryMemory.expansionPipelines;
}

function normalizeExpansionPipeline(
  rawPipeline: unknown,
  colony: string
): TerritoryExpansionPipelineMemory | null {
  if (
    !isRecord(rawPipeline) ||
    rawPipeline.colony !== colony ||
    !isNonEmptyString(rawPipeline.targetRoom) ||
    !isExpansionPipelineStatus(rawPipeline.status) ||
    !isExpansionPipelineStage(rawPipeline.stage) ||
    !isFiniteNumber(rawPipeline.score) ||
    !isFiniteNumber(rawPipeline.threshold) ||
    !isFiniteNumber(rawPipeline.startedAt) ||
    !isFiniteNumber(rawPipeline.updatedAt)
  ) {
    return null;
  }

  return {
    colony,
    targetRoom: rawPipeline.targetRoom,
    status: rawPipeline.status,
    stage: rawPipeline.stage,
    ...(isExpansionClaimState(rawPipeline.claimState) ? { claimState: rawPipeline.claimState } : {}),
    score: rawPipeline.score,
    threshold: rawPipeline.threshold,
    startedAt: rawPipeline.startedAt,
    updatedAt: rawPipeline.updatedAt,
    ...(typeof rawPipeline.controllerId === 'string'
      ? { controllerId: rawPipeline.controllerId as Id<StructureController> }
      : {}),
    ...(isFiniteNumber(rawPipeline.reservationConfirmedAt)
      ? { reservationConfirmedAt: rawPipeline.reservationConfirmedAt }
      : {}),
    ...(isFiniteNumber(rawPipeline.claimedAt) ? { claimedAt: rawPipeline.claimedAt } : {}),
    ...(isFiniteNumber(rawPipeline.completedAt) ? { completedAt: rawPipeline.completedAt } : {}),
    ...(isExpansionAbortReason(rawPipeline.abortReason) ? { abortReason: rawPipeline.abortReason } : {}),
    ...(isFiniteNumber(rawPipeline.abortedAt) ? { abortedAt: rawPipeline.abortedAt } : {})
  };
}

function getPipelineConfig(pipeline: TerritoryExpansionPipelineMemory): ExpansionTriggerConfig {
  return {
    scoreThreshold: pipeline.threshold,
    minStorageEnergy: getConfiguredNonNegativeInteger(
      'TERRITORY_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY',
      DEFAULT_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY
    ),
    minRcl: getConfiguredPositiveInteger(
      'TERRITORY_EXPANSION_TRIGGER_MIN_RCL',
      getAutonomousTerritoryControlMinRcl()
    )
  };
}

function getExpansionTriggerConfig(): ExpansionTriggerConfig {
  return {
    scoreThreshold: getConfiguredNonNegativeInteger(
      'TERRITORY_EXPANSION_TRIGGER_SCORE_THRESHOLD',
      DEFAULT_EXPANSION_TRIGGER_SCORE_THRESHOLD
    ),
    minStorageEnergy: getConfiguredNonNegativeInteger(
      'TERRITORY_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY',
      DEFAULT_EXPANSION_TRIGGER_MIN_STORAGE_ENERGY
    ),
    minRcl: getConfiguredPositiveInteger(
      'TERRITORY_EXPANSION_TRIGGER_MIN_RCL',
      getAutonomousTerritoryControlMinRcl()
    )
  };
}

function isExpansionHomeStable(
  colony: ColonySnapshot,
  gameTime: number,
  config: ExpansionTriggerConfig
): boolean {
  const controller = colony.room.controller;
  const requiredEnergy = getExpansionTriggerRequiredEnergy(controller?.level);
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    controller.level >= config.minRcl &&
    !isControllerDowngradeGuardBreached(controller) &&
    colony.energyCapacityAvailable >= requiredEnergy &&
    getRoomStorageEnergy(colony.room) >= config.minStorageEnergy &&
    !hasVisibleHostiles(colony.room) &&
    getHomeThreatLevel(colony.room.name, gameTime) === 'none'
  );
}

function isExpansionTriggerReady(
  colony: ColonySnapshot,
  gameTime: number,
  config: ExpansionTriggerConfig
): boolean {
  const requiredEnergy = getExpansionTriggerRequiredEnergy(colony.room.controller?.level);
  return (
    isExpansionHomeStable(colony, gameTime, config) &&
    colony.energyAvailable >= requiredEnergy
  );
}

export function getExpansionTriggerRequiredEnergy(controllerLevel: number | undefined): number {
  return getTerritoryAutoClaimRequiredEnergy(controllerLevel);
}

function hasBlockingExpansionInProgress(territoryMemory: TerritoryMemory, colony: string): boolean {
  const pipelines = getExpansionPipelinesRecord(territoryMemory);
  if (Object.values(pipelines).some((pipeline) => pipeline.colony === colony && pipeline.status === 'active')) {
    return true;
  }

  if (getActivePostClaimBootstrapBlockers(colony).length > 0) {
    return true;
  }

  const targets = Array.isArray(territoryMemory.targets) ? territoryMemory.targets : [];
  if (targets.some((target) => isBlockingExpansionTarget(target, colony))) {
    return true;
  }

  return normalizeTerritoryIntents(territoryMemory.intents).some((intent) =>
    isBlockingExpansionIntent(intent, colony)
  );
}

function isBlockingExpansionTarget(target: unknown, colony: string): boolean {
  return (
    isRecord(target) &&
    target.colony === colony &&
    target.enabled !== false &&
    target.action === 'claim'
  );
}

function isBlockingExpansionIntent(intent: TerritoryIntentMemory, colony: string): boolean {
  return (
    intent.colony === colony &&
    intent.action === 'claim' &&
    (intent.status === 'planned' || intent.status === 'active')
  );
}

function getExpansionCapacitySkipReason(colony: ColonySnapshot): NextExpansionTargetSelection['reason'] | null {
  const ownedRoomCount = countVisibleOwnedRooms(colony.room.name, getControllerOwnerUsername(colony.room.controller));
  const gclLevel = getGclLevel();
  if (gclLevel !== null && ownedRoomCount >= gclLevel) {
    return 'gclInsufficient';
  }

  if (ownedRoomCount >= maxRoomsForRcl(colony.room.controller?.level)) {
    return 'roomLimitReached';
  }

  return null;
}

function isExpansionPipelineTargetOwned(
  pipeline: TerritoryExpansionPipelineMemory,
  colonyOwnerUsername: string | undefined
): boolean {
  const controller = getVisibleRoom(pipeline.targetRoom)?.controller;
  return (
    controller?.my === true ||
    (isNonEmptyString(colonyOwnerUsername) && getControllerOwnerUsername(controller) === colonyOwnerUsername)
  );
}

function countVisibleOwnedRooms(colonyName: string, ownerUsername: string | undefined): number {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return 1;
  }

  let count = 0;
  for (const room of Object.values(rooms)) {
    if (
      room?.controller?.my === true &&
      (!ownerUsername || getControllerOwnerUsername(room.controller) === ownerUsername)
    ) {
      count += 1;
    }
  }

  return Math.max(1, count || (rooms[colonyName]?.controller?.my === true ? 1 : 0));
}

function getGclLevel(): number | null {
  const level = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game?.gcl?.level;
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
}

function toPlannedSelection(
  pipeline: TerritoryExpansionPipelineMemory,
  controllerId = pipeline.controllerId
): NextExpansionTargetSelection {
  return {
    status: 'planned',
    colony: pipeline.colony,
    targetRoom: pipeline.targetRoom,
    score: pipeline.score,
    ...(controllerId ? { controllerId } : {})
  };
}

function withPipelineControllerId(
  pipeline: TerritoryExpansionPipelineMemory,
  controllerId: Id<StructureController> | undefined
): TerritoryExpansionPipelineMemory {
  return controllerId ? { ...pipeline, controllerId } : pipeline;
}

function getOwnReservationTicksToEnd(
  controller: StructureController,
  colonyOwnerUsername: string | undefined
): number | null {
  const reservationUsername = getControllerReservationUsername(controller);
  if (!reservationUsername || reservationUsername !== colonyOwnerUsername) {
    return null;
  }

  const ticksToEnd = controller.reservation?.ticksToEnd;
  return typeof ticksToEnd === 'number' && Number.isFinite(ticksToEnd) ? ticksToEnd : 0;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = controller?.owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationUsername(controller: StructureController | undefined): string | undefined {
  const username = controller?.reservation?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getRoomStorageEnergy(room: Room): number {
  const storage = room.storage;
  if (!storage?.store) {
    return 0;
  }

  const storedEnergy = storage.store.getUsedCapacity?.(getEnergyResource());
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getHomeThreatLevel(roomName: string, gameTime: number): DefenseThreatLevel | 'unknown' {
  const threatMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense?.colonyThreats;
  if (!threatMemory) {
    return 'unknown';
  }

  if (!isRecentThreatMemory(threatMemory.updatedAt, gameTime)) {
    return 'unknown';
  }

  const roomThreat = threatMemory.rooms?.[roomName];
  if (!roomThreat) {
    return 'unknown';
  }

  return isRecentThreatMemory(roomThreat.updatedAt, gameTime) ? roomThreat.level : 'unknown';
}

function isControllerDowngradeGuardBreached(controller: StructureController): boolean {
  return (
    typeof controller.ticksToDowngrade === 'number' &&
    controller.ticksToDowngrade <= EXPANSION_TRIGGER_DOWNGRADE_GUARD_TICKS
  );
}

function isRecentThreatMemory(updatedAt: unknown, gameTime: number): boolean {
  return isFiniteNumber(updatedAt) && updatedAt <= gameTime && gameTime - updatedAt <= EXPANSION_TRIGGER_THREAT_MEMORY_STALE_TICKS;
}

function hasVisibleHostiles(room: Room): boolean {
  return (
    findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length > 0 ||
    findRoomObjects<AnyStructure>(room, getFindConstant('FIND_HOSTILE_STRUCTURES')).length > 0
  );
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

function getEnergyResource(): ResourceConstant {
  return (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? ('energy' as ResourceConstant);
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
}

function getExpansionReevaluationKey(colony: string, roomName: string): string {
  return `${colony}${EXPANSION_PIPELINE_REEVALUATION_SEPARATOR}${roomName}`;
}

function getConfiguredNonNegativeInteger(name: string, fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function getConfiguredPositiveInteger(name: string, fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isExpansionPipelineStatus(status: unknown): status is TerritoryExpansionPipelineStatus {
  return status === 'active' || status === 'aborted' || status === 'completed';
}

function isExpansionPipelineStage(stage: unknown): stage is TerritoryExpansionPipelineStage {
  return stage === 'scouting' || stage === 'reserving' || stage === 'claiming' || stage === 'bootstrapping';
}

function isExpansionClaimState(state: unknown): state is TerritoryExpansionClaimState {
  return state === 'scouted' || state === 'claiming' || state === 'claimed';
}

function isExpansionAbortReason(reason: unknown): reason is TerritoryExpansionAbortReason {
  return (
    reason === 'homeUnstable' ||
    reason === 'existingExpansion' ||
    reason === 'scoreBelowThreshold' ||
    reason === 'scoutTimedOut' ||
    reason === 'controllerMissing' ||
    reason === 'controllerOwned' ||
    reason === 'controllerReserved' ||
    reason === 'reservationLost' ||
    reason === 'targetHostile' ||
    reason === 'sourcesMissing' ||
    reason === 'rcl6Gate' ||
    reason === 'controllerLevelGate'
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTerritoryMemoryRecord(): TerritoryMemory | null {
  const territory = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory;
  return isRecord(territory) ? (territory as TerritoryMemory) : null;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (memory.territory === undefined) {
    memory.territory = {};
  } else if (!isRecord(memory.territory)) {
    return null;
  }

  return memory.territory as TerritoryMemory;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}
