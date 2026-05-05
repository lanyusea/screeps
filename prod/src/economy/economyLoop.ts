import { getOwnedColonies, type ColonySnapshot } from '../colony/colonyRegistry';
import {
  assessColonySnapshotSurvival,
  clearColonySurvivalAssessmentCache,
  persistColonyStageAssessment,
  recordColonySurvivalAssessment
} from '../colony/colonyStage';
import { planExtensionConstruction } from '../construction/extensionPlanner';
import { planStorageConstruction, planTowerConstruction } from '../construction/constructionPriority';
import { planEarlyRoadConstruction } from '../construction/roadPlanner';
import { planSourceContainerConstruction } from '../construction/sourceContainerPlanner';
import { countCreepsByRole, getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import { runWorker } from '../creeps/workerRunner';
import { HAULER_ROLE, runHauler } from '../creeps/hauler';
import { REMOTE_HARVESTER_ROLE, runRemoteHarvester } from '../creeps/remoteHarvester';
import { getBodyCost, TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS } from '../spawn/bodyBuilder';
import { planSpawn, type SpawnPlanningOptions, type SpawnRequest } from '../spawn/spawnPlanner';
import { emitRuntimeSummary, type RuntimeSummary, type RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import { recordSourceWorkloads } from './sourceWorkload';
import { transferEnergy as transferLinkEnergy } from './linkManager';
import { manageStorage } from './storageManager';
import {
  buildRuntimeOccupationRecommendationReport,
  clearOccupationRecommendationClaimIntent,
  clearOccupationRecommendationFollowUpIntent,
  persistOccupationRecommendationFollowUpIntent,
  suppressOccupationClaimRecommendation
} from '../territory/occupationRecommendation';
import {
  buildRuntimeExpansionCandidateReport,
  clearNextExpansionTargetIntent,
  NEXT_EXPANSION_TARGET_CREATOR,
  type NextExpansionTargetSelection,
  refreshNextExpansionTargetSelection
} from '../territory/expansionScoring';
import {
  clearAutonomousExpansionClaimIntent,
  refreshAutonomousExpansionClaimIntent,
  shouldDeferOccupationRecommendationForExpansionClaim
} from '../territory/claimExecutor';
import { runClaimer } from '../creeps/claimerRunner';
import {
  hasPendingTerritoryFollowUpIntent,
  TERRITORY_CLAIMER_ROLE,
  TERRITORY_SCOUT_ROLE,
  recordAutonomousExpansionClaimReserveFallbackIntent,
  refreshRemoteMiningSetup
} from '../territory/territoryPlanner';
import { logBestClaimTarget, runTerritoryControllerCreep } from '../territory/territoryRunner';
import { recordPlannedMultiRoomUpgraderSpawn } from '../territory/multiRoomUpgrader';
import {
  recordPostClaimBootstrapWorkerSpawn,
  refreshPostClaimBootstrap
} from '../territory/postClaimBootstrap';

const ERR_BUSY_CODE = -4 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;
const NEXT_EXPANSION_SCORING_REFRESH_INTERVAL = 50;
const NEXT_EXPANSION_SCORING_DOWNGRADE_GUARD_TICKS = 5_000;

interface CachedNextExpansionTargetSelection {
  refreshedAt: number;
  stateKey: string;
  selection: NextExpansionTargetSelection;
}

interface SpawnAttemptOutcome {
  spawn: StructureSpawn;
  result: ScreepsReturnCode;
}

export function runEconomy(preludeTelemetryEvents: RuntimeTelemetryEvent[] = []): RuntimeSummary | undefined {
  const creeps = Object.values(Game.creeps);
  const colonies = getOwnedColonies();
  const telemetryEvents: RuntimeTelemetryEvent[] = [...preludeTelemetryEvents];
  clearColonySurvivalAssessmentCache();

  for (const colony of colonies) {
    recordSourceWorkloads(colony.room, creeps, Game.time);
    let roleCounts = countCreepsByRole(creeps, colony.room.name);
    const survivalAssessment = assessColonySnapshotSurvival(colony, roleCounts);
    recordColonySurvivalAssessment(colony.room.name, survivalAssessment, Game.time);
    persistColonyStageAssessment(colony, survivalAssessment, Game.time);
    const bootstrapResult = refreshPostClaimBootstrap(colony, roleCounts, Game.time, telemetryEvents);
    planCriticalConstructionSites(colony, bootstrapResult.spawnConstructionPending, survivalAssessment.mode === 'BOOTSTRAP');
    if (survivalAssessment.mode === 'TERRITORY_READY') {
      refreshRemoteMiningSetup(colony, Game.time);
    }
    refreshExecutableTerritoryRecommendation(colony, creeps, survivalAssessment.territoryReady, telemetryEvents);
    const hasPendingTerritoryFollowUp = hasPendingTerritoryFollowUpIntent(
      colony.room.name,
      roleCounts,
      Game.time
    );
    let availableEnergy = colony.energyAvailable;
    let successfulSpawnCount = 0;
    const usedSpawns = new Set<StructureSpawn>();

    while (true) {
      const planningColony = createSpawnPlanningColony(colony, availableEnergy, usedSpawns);
      const spawnRequest = planSpawn(
        planningColony,
        roleCounts,
        Game.time,
        getSpawnPlanningOptions(successfulSpawnCount, hasPendingTerritoryFollowUp)
      );
      if (!spawnRequest) {
        break;
      }

      if (successfulSpawnCount > 0 && !isAllowedPostSpawnRequest(spawnRequest)) {
        break;
      }

      const outcome = attemptSpawnRequest(
        spawnRequest,
        colony.room.name,
        telemetryEvents,
        planningColony.spawns
      );
      if (!outcome || outcome.result !== OK_CODE) {
        break;
      }

      usedSpawns.add(outcome.spawn);
      availableEnergy = Math.max(0, availableEnergy - getBodyCost(spawnRequest.body));
      successfulSpawnCount += 1;
      recordPlannedMultiRoomUpgraderSpawn(spawnRequest.memory);

      if (spawnRequest.memory.role !== 'worker') {
        break;
      }

      if (spawnRequest.memory.colony !== colony.room.name) {
        continue;
      }

      roleCounts = addPlannedWorker(roleCounts);
    }

    transferLinkEnergy(colony.room);
    manageStorage(colony.room);
  }

  for (const creep of creeps) {
    if (creep.memory.role === 'worker') {
      runWorker(creep);
    } else if (creep.memory.role === REMOTE_HARVESTER_ROLE) {
      runRemoteHarvester(creep);
    } else if (creep.memory.role === HAULER_ROLE) {
      runHauler(creep);
    } else if (creep.memory.role === TERRITORY_CLAIMER_ROLE) {
      runClaimer(creep, telemetryEvents);
    } else if (creep.memory.role === TERRITORY_SCOUT_ROLE) {
      runTerritoryControllerCreep(creep, telemetryEvents);
    }
  }

  return emitRuntimeSummary(colonies, creeps, telemetryEvents, { persistOccupationRecommendations: false });
}

function planCriticalConstructionSites(
  colony: ColonySnapshot,
  spawnConstructionPending: boolean,
  bootstrapNonCriticalConstructionSuppressed = false
): void {
  if (spawnConstructionPending || bootstrapNonCriticalConstructionSuppressed) {
    return;
  }

  const extensionResult = planExtensionConstruction(colony);
  if (extensionResult !== null) {
    return;
  }

  const towerResult = planTowerConstruction(colony);
  if (towerResult !== null) {
    return;
  }

  const sourceContainerResult = planSourceContainerConstruction(colony);
  if (sourceContainerResult !== null) {
    return;
  }

  const roadResults = planEarlyRoadConstruction(colony);
  if (roadResults.length > 0) {
    return;
  }

  planStorageConstruction(colony);
}

function refreshExecutableTerritoryRecommendation(
  colony: ColonySnapshot,
  creeps: Creep[],
  territoryReady: boolean,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  const colonyWorkers = creeps.filter(
    (creep) => creep.memory.role === 'worker' && creep.memory.colony === colony.room.name
  );
  let report = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
  if (territoryReady) {
    const expansionSelection = refreshNextExpansionTargetSelectionIfDue(colony, Game.time);
    if (expansionSelection.status === 'planned') {
      persistOccupationRecommendationFollowUpIntent(clearOccupationRecommendationFollowUpIntent(report), Game.time);
      return;
    }
    if (expansionSelection.reason === 'roomLimitReached') {
      const colonyName = colony.room.name;
      clearNextExpansionTargetIntent(colonyName);
      clearAutonomousExpansionClaimIntent(colonyName);
      clearOccupationRecommendationClaimIntent(colonyName);
      report = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
      persistOccupationRecommendationFollowUpIntent(suppressOccupationClaimRecommendation(report), Game.time);
      return;
    }
    if (expansionSelection.reason === 'unmetPreconditions') {
      persistOccupationRecommendationFollowUpIntent(clearOccupationRecommendationFollowUpIntent(report), Game.time);
      return;
    }

    const claimEvaluation = refreshAutonomousExpansionClaimIntent(colony, report, Game.time, telemetryEvents);
    recordAutonomousExpansionClaimReserveFallbackIntent(colony.room.name, claimEvaluation, Game.time);
    if (shouldDeferOccupationRecommendationForExpansionClaim(claimEvaluation)) {
      return;
    }
  }

  persistOccupationRecommendationFollowUpIntent(
    territoryReady ? report : clearOccupationRecommendationFollowUpIntent(report),
    Game.time
  );
}

function refreshNextExpansionTargetSelectionIfDue(
  colony: ColonySnapshot,
  gameTime: number
): NextExpansionTargetSelection {
  const colonyName = colony.room.name;
  const colonyMemory = getWritableColonyMemory(colony);
  const stateKey = getNextExpansionSelectionCacheStateKey(colony);
  const cachedSelection = getCachedNextExpansionTargetSelection(colonyMemory, colonyName);
  if (
    cachedSelection &&
    isNextExpansionTargetSelectionCacheReusable(cachedSelection, colonyName, gameTime, stateKey)
  ) {
    return cachedSelection.selection;
  }

  const selection = refreshNextExpansionTargetSelection(
    colony,
    buildRuntimeExpansionCandidateReport(colony),
    gameTime
  );
  logBestClaimTarget(colony.room);
  colonyMemory.lastExpansionScoreTime = gameTime;
  colonyMemory.cachedExpansionSelection = { ...selection, stateKey };
  return selection;
}

function getWritableColonyMemory(colony: ColonySnapshot): RoomMemory {
  const roomWithMemory = colony.room as Room & { memory?: RoomMemory };
  const memory = colony.memory ?? roomWithMemory.memory ?? {};
  if (!colony.memory) {
    colony.memory = memory;
  }
  if (!roomWithMemory.memory) {
    roomWithMemory.memory = memory;
  }
  return memory;
}

function getCachedNextExpansionTargetSelection(
  colonyMemory: RoomMemory,
  colonyName: string
): CachedNextExpansionTargetSelection | null {
  const refreshedAt = colonyMemory.lastExpansionScoreTime;
  const rawSelection = (colonyMemory as { cachedExpansionSelection?: unknown }).cachedExpansionSelection;
  const selection = normalizeNextExpansionTargetSelection(rawSelection, colonyName);
  if (
    !isFiniteNumber(refreshedAt) ||
    !isRecord(rawSelection) ||
    !isNonEmptyString(rawSelection.stateKey) ||
    !selection
  ) {
    return null;
  }

  return { refreshedAt, stateKey: rawSelection.stateKey, selection };
}

function normalizeNextExpansionTargetSelection(
  rawSelection: unknown,
  colonyName: string
): NextExpansionTargetSelection | null {
  if (
    !isRecord(rawSelection) ||
    rawSelection.colony !== colonyName ||
    (rawSelection.status !== 'planned' && rawSelection.status !== 'skipped')
  ) {
    return null;
  }

  if (rawSelection.status === 'planned') {
    if (!isNonEmptyString(rawSelection.targetRoom)) {
      return null;
    }

    return {
      status: 'planned',
      colony: colonyName,
      targetRoom: rawSelection.targetRoom,
      ...(typeof rawSelection.controllerId === 'string'
        ? { controllerId: rawSelection.controllerId as Id<StructureController> }
        : {}),
      ...(isFiniteNumber(rawSelection.score) ? { score: rawSelection.score } : {})
    };
  }

  const reason = normalizeNextExpansionTargetSelectionReason(rawSelection.reason);
  if (!reason) {
    return null;
  }

  return {
    status: 'skipped',
    colony: colonyName,
    reason
  };
}

function normalizeNextExpansionTargetSelectionReason(
  reason: unknown
): NextExpansionTargetSelection['reason'] | undefined {
  return reason === 'noCandidate' ||
    reason === 'roomLimitReached' ||
    reason === 'unmetPreconditions' ||
    reason === 'insufficientEvidence' ||
    reason === 'unavailable'
    ? reason
    : undefined;
}

function isNextExpansionTargetSelectionCacheReusable(
  cachedSelection: CachedNextExpansionTargetSelection,
  colony: string,
  gameTime: number,
  stateKey: string
): boolean {
  if (
    cachedSelection.stateKey !== stateKey ||
    gameTime < cachedSelection.refreshedAt ||
    gameTime - cachedSelection.refreshedAt >= NEXT_EXPANSION_SCORING_REFRESH_INTERVAL
  ) {
    return false;
  }

  return (
    cachedSelection.selection.status !== 'planned' ||
    hasNextExpansionTarget(colony, cachedSelection.selection.targetRoom)
  );
}

function hasNextExpansionTarget(colony: string, targetRoom: string | undefined): boolean {
  if (!targetRoom) {
    return false;
  }

  const targets = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.targets;
  return Array.isArray(targets)
    ? targets.some(
        (target) =>
          isRecord(target) &&
          target.colony === colony &&
          target.roomName === targetRoom &&
          target.action === 'claim' &&
          target.createdBy === NEXT_EXPANSION_TARGET_CREATOR
      )
    : false;
}

function getNextExpansionSelectionCacheStateKey(colony: ColonySnapshot): string {
  const controller = colony.room.controller;
  const controllerLevel = isFiniteNumber(controller?.level) ? controller.level : 'unknown';
  const downgradeState =
    isFiniteNumber(controller?.ticksToDowngrade) &&
    controller.ticksToDowngrade < NEXT_EXPANSION_SCORING_DOWNGRADE_GUARD_TICKS
      ? 'guarded'
      : 'stable';

  return [
    colony.room.name,
    colony.energyCapacityAvailable,
    controllerLevel,
    countVisibleOwnedRooms(),
    downgradeState,
    countActivePostClaimBootstraps()
  ].join('|');
}

function countVisibleOwnedRooms(): number {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return 0;
  }

  return Object.values(rooms).filter((room) => room?.controller?.my === true).length;
}

function countActivePostClaimBootstraps(): number {
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isRecord(records)) {
    return 0;
  }

  return Object.values(records).filter(
    (record) => isRecord(record) && record.status !== 'ready'
  ).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function createSpawnPlanningColony(
  colony: ColonySnapshot,
  energyAvailable: number,
  usedSpawns: Set<StructureSpawn>
): ColonySnapshot {
  return {
    ...colony,
    energyAvailable,
    spawns: colony.spawns.filter((spawn) => !spawn.spawning && !usedSpawns.has(spawn))
  };
}

function getSpawnPlanningOptions(
  successfulSpawnCount: number,
  hasPendingTerritoryFollowUp: boolean
): SpawnPlanningOptions {
  const allowTerritoryFollowUp = successfulSpawnCount > 0 || hasPendingTerritoryFollowUp;
  if (successfulSpawnCount === 0) {
    return allowTerritoryFollowUp ? { allowTerritoryFollowUp } : {};
  }

  return {
    nameSuffix: String(successfulSpawnCount + 1),
    workersOnly: true,
    allowTerritoryControllerPressure: true,
    allowTerritoryFollowUp
  };
}

function isAllowedPostSpawnRequest(spawnRequest: SpawnRequest): boolean {
  return (
    spawnRequest.memory.role === 'worker' ||
    isTerritoryControllerPressureSpawnRequest(spawnRequest) ||
    isTerritoryControllerFollowUpSpawnRequest(spawnRequest)
  );
}

function isTerritoryControllerPressureSpawnRequest(spawnRequest: SpawnRequest): boolean {
  const territory = spawnRequest.memory.territory;
  return (
    spawnRequest.memory.role === TERRITORY_CLAIMER_ROLE &&
    (territory?.action === 'claim' || territory?.action === 'reserve') &&
    countBodyParts(spawnRequest.body, 'claim') >= TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS
  );
}

function isTerritoryControllerFollowUpSpawnRequest(spawnRequest: SpawnRequest): boolean {
  const territory = spawnRequest.memory.territory;
  return (
    spawnRequest.memory.role === TERRITORY_CLAIMER_ROLE &&
    (territory?.action === 'claim' || territory?.action === 'reserve') &&
    territory?.followUp !== undefined
  );
}

function countBodyParts(body: BodyPartConstant[], bodyPart: BodyPartConstant): number {
  return body.filter((part) => part === bodyPart).length;
}

function attemptSpawnRequest(
  spawnRequest: SpawnRequest,
  roomName: string,
  telemetryEvents: RuntimeTelemetryEvent[],
  spawns: StructureSpawn[]
): SpawnAttemptOutcome | null {
  let lastOutcome: SpawnAttemptOutcome | null = null;
  for (const spawn of getSpawnAttemptOrder(spawnRequest, spawns)) {
    const result = attemptSpawn({ ...spawnRequest, spawn }, roomName, telemetryEvents);
    lastOutcome = { spawn, result };
    if (result !== ERR_BUSY_CODE) {
      return lastOutcome;
    }
  }

  return lastOutcome;
}

function addPlannedWorker(roleCounts: RoleCounts): RoleCounts {
  const nextRoleCounts: RoleCounts = {
    ...roleCounts,
    worker: roleCounts.worker + 1
  };
  const workerCapacity = getWorkerCapacity(roleCounts) + 1;

  if (workerCapacity === nextRoleCounts.worker) {
    delete nextRoleCounts.workerCapacity;
  } else {
    nextRoleCounts.workerCapacity = workerCapacity;
  }

  return nextRoleCounts;
}

function getSpawnAttemptOrder(spawnRequest: SpawnRequest, spawns: StructureSpawn[]): StructureSpawn[] {
  return [spawnRequest.spawn, ...spawns.filter((spawn) => spawn !== spawnRequest.spawn && !spawn.spawning)];
}

function attemptSpawn(spawnRequest: SpawnRequest, roomName: string, telemetryEvents: RuntimeTelemetryEvent[]): ScreepsReturnCode {
  const result = spawnRequest.spawn.spawnCreep(spawnRequest.body, spawnRequest.name, {
    memory: spawnRequest.memory
  });
  telemetryEvents.push({
    type: 'spawn',
    roomName,
    spawnName: spawnRequest.spawn.name,
    creepName: spawnRequest.name,
    role: spawnRequest.memory.role,
    result
  });
  if (spawnRequest.memory.role === 'worker') {
    recordPostClaimBootstrapWorkerSpawn(
      spawnRequest.memory.colony,
      spawnRequest.spawn.name,
      spawnRequest.name,
      result,
      telemetryEvents
    );
  }

  return result;
}
