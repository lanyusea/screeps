import { getOwnedColonies, type ColonySnapshot } from '../colony/colonyRegistry';
import {
  assessColonySnapshotSurvival,
  clearColonySurvivalAssessmentCache,
  getWorkerTarget,
  persistColonyStageAssessment,
  recordColonySurvivalAssessment
} from '../colony/colonyStage';
import { planClaimedRoomConstruction } from '../construction/claimed-room-planner';
import { countCreepsByRole, getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import { runWorker } from '../creeps/workerRunner';
import { runUpgraderCreep, UPGRADER_ROLE } from '../creeps/upgraderRunner';
import { SOURCE_HARVESTER_ROLE, runSourceHarvester } from '../creeps/sourceHarvester';
import { HAULER_ROLE, runHauler } from '../creeps/hauler';
import { REMOTE_HARVESTER_ROLE, runRemoteHarvester } from '../creeps/remoteHarvester';
import { getBodyCost, TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS } from '../spawn/bodyBuilder';
import {
  orderColoniesForSpawnPlanning,
  planSpawn,
  planSpawnEnergyReservationCandidate,
  shouldSuppressWorkerSpawnForCrossRoomImport,
  type SpawnPlanningOptions,
  type SpawnRequest
} from '../spawn/spawnPlanner';
import {
  RUNTIME_SUMMARY_INTERVAL,
  emitRuntimeSummary,
  type RuntimeSummary,
  type RuntimeTelemetryEvent
} from '../telemetry/runtimeSummary';
import type { StrategyRegistryEntry } from '../strategy/strategyRegistry';
import { getRuntimeFeatureGates, type RuntimeFeatureGates } from '../runtime/featureGates';
import { recordSourceWorkloads } from './sourceWorkload';
import {
  ensureRemoteSourceContainersForAssignedHarvesters
} from './sourceContainerPlanner';
import { transferEnergy as transferLinkEnergy } from './linkManager';
import { manageStorage } from './storageManager';
import { balanceStorage } from './storageBalancer';
import { manageTerminalEnergy } from './terminalManager';
import { detectOwnedLabs, manageLabs, shouldYieldCreepToLabManager } from './labManager';
import { runMarketTrading, shouldRunMarketTrading } from './marketTrading';
import {
  getBufferedSpawnEnergyBudget,
  getSpawnEnergyBufferRequirement,
  isSpawnEnergyBufferViolated,
  refreshSpawnEnergyBufferState
} from './spawnEnergyBuffer';
import {
  CROSS_ROOM_HAULER_ROLE,
  planCrossRoomHauler,
  runCrossRoomHauler
} from './crossRoomHauler';
import {
  MINERAL_HARVESTER_ROLE,
  planMineralHarvesterSpawn,
  runMineralHarvester
} from './mineralHarvester';
import { refreshRoomEnergySurplusState } from './energySurplus';
import {
  clearSpawnEnergyReservation,
  refreshSpawnEnergyReservationState,
  reserveSpawnEnergyForNextRequest
} from './spawnEnergyReservation';
import {
  buildRuntimeOccupationRecommendationReport,
  clearOccupationRecommendationClaimIntent,
  clearOccupationRecommendationFollowUpIntent,
  persistOccupationRecommendationFollowUpIntent,
  suppressOccupationClaimRecommendation
} from '../territory/occupationRecommendation';
import { clearNextExpansionTargetIntent } from '../territory/expansionScoring';
import { refreshExpansionExecutorIntent } from '../territory/expansionExecutor';
import { runPlannedClaimReservation } from '../territory/roomReservation';
import {
  clearAutonomousExpansionClaimIntent,
  refreshClaimExecutionTargets,
  refreshAutonomousExpansionClaimIntent,
  shouldDeferOccupationRecommendationForExpansionClaim
} from '../territory/claimExecutor';
import { refreshColonyExpansionIntent } from '../territory/colonyExpansionPlanner';
import { runClaimer } from '../creeps/claimerRunner';
import {
  hasPendingTerritoryFollowUpIntent,
  TERRITORY_CLAIMER_ROLE,
  TERRITORY_SCOUT_ROLE,
  recordAutonomousExpansionClaimReserveFallbackIntent,
  refreshRemoteMiningSetup
} from '../territory/territoryPlanner';
import {
  clearAdjacentRoomReservationIntent,
  refreshAdjacentRoomReservationIntent
} from '../territory/reservationPlanner';
import { refreshReserveExecutionTargets } from '../territory/reserveExecutor';
import {
  refreshClaimedRoomBootstrapperOwnership,
  runTerritoryControllerCreep
} from '../territory/territoryRunner';
import { selectColonyUpgradeTargets } from '../territory/colonyUpgradePriority';
import { recordPlannedMultiRoomUpgraderSpawn } from '../territory/multiRoomUpgrader';
import { refreshControllerManagement } from '../territory/controllerManager';
import {
  refreshPostClaimDefenseConstruction,
  recordPostClaimBootstrapWorkerSpawn,
  refreshPostClaimBootstrap,
  selectPostClaimBootstrapFocusRoomName
} from '../territory/postClaimBootstrap';
import {
  buildStrategyRecommendationRoomState,
  generateStrategyRecommendations,
  rejectUncertain
} from '../strategy/strategyRecommender';

const ERR_BUSY_CODE = -4 as ScreepsReturnCode;
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;
const BOOTSTRAP_WORKER_BUFFER_BYPASS_MIN_ENERGY = 300;
const LOW_ROOM_ENERGY_TASK_PRIORITY_RATIO = 0.5;

interface SpawnAttemptOutcome {
  spawn: StructureSpawn;
  result: ScreepsReturnCode;
}

interface SpawnRequestSelection {
  spawnRequest: SpawnRequest;
  bodyCost: number;
}

interface SpawnPlanSelection extends SpawnRequestSelection {
  planningColony: ColonySnapshot;
}

interface CoordinatedSpawnPlan {
  spawnRequest: SpawnRequest;
  bodyCost: number;
  planningColony: ColonySnapshot;
  spawns: StructureSpawn[];
  sourceColony: ColonySnapshot;
  sourceRoomName: string;
  availableEnergy: number;
}

export interface EconomyRuntimeOptions {
  strategyRegistry?: StrategyRegistryEntry[];
  runtimeStrategyConstructionEnabled?: boolean;
  onStrategyRegistryRuntimeUse?: (entry: StrategyRegistryEntry) => void;
}

export function runEconomy(
  preludeTelemetryEvents: RuntimeTelemetryEvent[] = [],
  options: EconomyRuntimeOptions = {}
): RuntimeSummary | undefined {
  const featureGates = getRuntimeFeatureGates();
  const creeps = Object.values(Game.creeps);
  balanceStorage();
  if (featureGates.terminalEnergyTransfers) {
    manageTerminalEnergy();
  }
  if (featureGates.marketTrading && Memory.enableMarketTrading === true && shouldRunMarketTrading(Game.time)) {
    runMarketTrading();
  }
  const ownedColonies = getOwnedColonies();
  ensureLocalWorkerColonyMemory(ownedColonies, creeps);
  refreshSpawnEnergyReservationStates(ownedColonies);
  const initialRoleCountsByRoom = new Map(
    ownedColonies.map((colony) => [colony.room.name, countCreepsByRole(creeps, colony.room.name)] as const)
  );
  const colonies = orderColoniesForSpawnPlanning(ownedColonies, initialRoleCountsByRoom);
  const telemetryEvents: RuntimeTelemetryEvent[] = [...preludeTelemetryEvents];
  const usedSpawnsByRoom = new Map<string, Set<StructureSpawn>>();
  const reservedSpawnEnergyByRoom = new Map<string, number>();
  const plannedRoleCountsByRoom = new Map<string, RoleCounts>(initialRoleCountsByRoom);
  clearColonySurvivalAssessmentCache();
  refreshClaimedRoomBootstrapperOwnership(telemetryEvents);
  const postClaimBootstrapFocusRoomName = selectPostClaimBootstrapFocusRoomName(colonies);
  const controllerUpgradeTargetRooms = getControllerUpgradeTargetRooms(colonies);

  for (const colony of colonies) {
    recordSourceWorkloads(colony.room, creeps, Game.time);
    let roleCounts = getPlannedOrCurrentRoleCounts(creeps, colony.room.name, plannedRoleCountsByRoom);
    plannedRoleCountsByRoom.set(colony.room.name, roleCounts);
    const workerTarget = getWorkerTarget(colony, roleCounts);
    const survivalAssessment = assessColonySnapshotSurvival(colony, roleCounts);
    recordColonySurvivalAssessment(colony.room.name, survivalAssessment, Game.time);
    persistColonyStageAssessment(colony, survivalAssessment, Game.time);
    refreshControllerManagement(
      colony,
      roleCounts,
      workerTarget,
      Game.time,
      {
        competingSpawnDemand:
          survivalAssessment.mode !== 'TERRITORY_READY' ||
          survivalAssessment.hostilePresence ||
          survivalAssessment.controllerDowngradeGuard
      }
    );
    const postClaimBootstrapRefresh = refreshPostClaimBootstrap(
      colony,
      roleCounts,
      Game.time,
      telemetryEvents,
      { focusRoomName: postClaimBootstrapFocusRoomName }
    );
    refreshPostClaimDefenseConstruction(colony, { focusRoomName: postClaimBootstrapFocusRoomName });
    if (postClaimBootstrapRefresh.deferred !== true) {
      planClaimedRoomConstruction(colony, {
        respectRoomEnergyBuffer: true,
        creeps,
        strategyRegistry: options.strategyRegistry,
        runtimeStrategyConstructionEnabled: options.runtimeStrategyConstructionEnabled,
        onStrategyRegistryRuntimeUse: options.onStrategyRegistryRuntimeUse
      });
    }
    if (survivalAssessment.mode === 'TERRITORY_READY') {
      refreshRemoteMiningSetup(colony, Game.time, { focusRoomName: postClaimBootstrapFocusRoomName });
    }
    refreshExecutableTerritoryRecommendation(colony, creeps, survivalAssessment.territoryReady, telemetryEvents);
    if (survivalAssessment.territoryReady) {
      refreshClaimExecutionTargets({ colony: colony.room.name, gameTime: Game.time });
      refreshReserveExecutionTargets({ colony: colony.room.name, gameTime: Game.time });
    }
    const hasPendingTerritoryFollowUp = hasPendingTerritoryFollowUpIntent(
      colony.room.name,
      roleCounts,
      Game.time
    );
    let successfulSpawnCount = 0;

    while (true) {
      const coordinatedPlan = planCoordinatedSpawn(
        colony,
        roleCounts,
        Game.time,
        getSpawnPlanningOptions(successfulSpawnCount, hasPendingTerritoryFollowUp, controllerUpgradeTargetRooms),
        colonies,
        creeps,
        usedSpawnsByRoom,
        reservedSpawnEnergyByRoom,
        plannedRoleCountsByRoom,
        survivalAssessment
      );
      if (!coordinatedPlan) {
        break;
      }
      const { spawnRequest, bodyCost } = coordinatedPlan;
      if (successfulSpawnCount > 0 && !isAllowedPostSpawnRequest(spawnRequest)) {
        break;
      }

      const outcome = attemptSpawnRequest(
        spawnRequest,
        coordinatedPlan.sourceRoomName,
        telemetryEvents,
        coordinatedPlan.spawns
      );
      if (!outcome || outcome.result !== OK_CODE) {
        break;
      }

      const spawnRoomName = outcome.spawn.room?.name ?? 'unknown';
      const usedSpawns = usedSpawnsByRoom.get(spawnRoomName) ?? new Set<StructureSpawn>();
      usedSpawns.add(outcome.spawn);
      usedSpawnsByRoom.set(spawnRoomName, usedSpawns);
      recordReservedSpawnEnergy(reservedSpawnEnergyByRoom, spawnRoomName, bodyCost);
      successfulSpawnCount += 1;
      recordPlannedMultiRoomUpgraderSpawn(spawnRequest.memory);

      const shouldContinueAfterWorkerSpawn =
        spawnRequest.memory.role === 'worker' && !isControllerUpgradeSpawnRequest(spawnRequest);
      const spawnedLocalWorker = shouldContinueAfterWorkerSpawn && spawnRequest.memory.colony === colony.room.name;
      const spawnedLocalUpgrader =
        spawnRequest.memory.role === UPGRADER_ROLE && spawnRequest.memory.colony === colony.room.name;
      if (spawnedLocalWorker) {
        roleCounts = addPlannedWorker(roleCounts);
        plannedRoleCountsByRoom.set(colony.room.name, roleCounts);
      } else if (spawnedLocalUpgrader) {
        roleCounts = addPlannedUpgrader(roleCounts);
        plannedRoleCountsByRoom.set(colony.room.name, roleCounts);
      }

      updateNextSpawnEnergyReservation(
        colony,
        coordinatedPlan.sourceColony,
        roleCounts,
        Game.time,
        getSpawnPlanningOptions(successfulSpawnCount, hasPendingTerritoryFollowUp, controllerUpgradeTargetRooms),
        spawnRequest,
        reservedSpawnEnergyByRoom.get(spawnRoomName) ?? bodyCost
      );

      if (!shouldContinueAfterWorkerSpawn) {
        break;
      }

      if (!spawnedLocalWorker) {
        continue;
      }
    }

    transferLinkEnergy(colony.room);
    manageStorage(colony.room);
    refreshRoomEnergySurplusState(colony.room);
    const labStructures = shouldRunLabManagement(colony.room, featureGates);
    if (labStructures.length > 0) {
      manageLabs(colony.room, { creeps, labs: labStructures });
    }
    recordStrategyRecommendationTelemetry(colony, creeps, telemetryEvents);
  }

  ensureRemoteSourceContainersForAssignedHarvesters(creeps);
  attemptCrossRoomHaulerSpawn(colonies, telemetryEvents, usedSpawnsByRoom, reservedSpawnEnergyByRoom);
  attemptMineralHarvesterSpawns(colonies, creeps, telemetryEvents, usedSpawnsByRoom, reservedSpawnEnergyByRoom);
  refreshSpawnEnergyReservationStates(colonies);
  refreshSpawnEnergyBufferStates(colonies, reservedSpawnEnergyByRoom);

  for (const creep of orderCreepsForEconomyTaskPriority(creeps)) {
    if (featureGates.labManagement && shouldYieldCreepToLabManager(creep, Game.time)) {
      continue;
    }

    if (creep.memory.role === 'worker') {
      runWorker(creep);
    } else if (creep.memory.role === UPGRADER_ROLE) {
      runUpgraderCreep(creep);
    } else if (creep.memory.role === SOURCE_HARVESTER_ROLE) {
      runSourceHarvester(creep);
    } else if (creep.memory.role === REMOTE_HARVESTER_ROLE) {
      runRemoteHarvester(creep);
    } else if (creep.memory.role === HAULER_ROLE) {
      runHauler(creep);
    } else if (creep.memory.role === CROSS_ROOM_HAULER_ROLE) {
      runCrossRoomHauler(creep);
    } else if (creep.memory.role === MINERAL_HARVESTER_ROLE) {
      runMineralHarvester(creep);
    } else if (creep.memory.role === TERRITORY_CLAIMER_ROLE) {
      if (!runPlannedClaimReservation(creep)) {
        runClaimer(creep, telemetryEvents);
      }
    } else if (creep.memory.role === TERRITORY_SCOUT_ROLE) {
      runTerritoryControllerCreep(creep, telemetryEvents);
    }
  }

  return emitRuntimeSummary(colonies, creeps, telemetryEvents, {
    persistOccupationRecommendations: false,
    strategyRegistry: options.strategyRegistry,
    onStrategyRegistryRuntimeUse: options.onStrategyRegistryRuntimeUse
  });
}

function ensureLocalWorkerColonyMemory(colonies: ColonySnapshot[], creeps: Creep[]): void {
  if (colonies.length === 0 || creeps.length === 0) {
    return;
  }

  const colonyNames = new Set(colonies.map((colony) => colony.room.name));
  for (const creep of creeps) {
    if (creep.memory.role !== 'worker' || isNonEmptyString(creep.memory.colony)) {
      continue;
    }

    const roomName = creep.room?.name;
    if (isNonEmptyString(roomName) && colonyNames.has(roomName) && isRoomLocalWorkerName(creep, roomName)) {
      creep.memory.colony = roomName;
    }
  }
}

function isRoomLocalWorkerName(creep: Creep, roomName: string): boolean {
  return typeof creep.name === 'string' && creep.name.startsWith(`worker-${roomName}-`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function orderCreepsForEconomyTaskPriority(creeps: Creep[]): Creep[] {
  return creeps
    .map((creep, index) => ({
      creep,
      index,
      priority: getEconomyCreepTaskPriority(creep)
    }))
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.index - right.index
    )
    .map((entry) => entry.creep);
}

function getEconomyCreepTaskPriority(creep: Creep): number {
  if (!isLowRoomEnergyForWorkerTaskPriority(creep.room)) {
    return 100;
  }

  const role = creep.memory.role;
  if (role === SOURCE_HARVESTER_ROLE) {
    return 0;
  }

  if (role === HAULER_ROLE || role === CROSS_ROOM_HAULER_ROLE) {
    return 1;
  }

  if (role !== 'worker') {
    return 50;
  }

  return getLowEnergyWorkerTaskPriority(creep);
}

function getLowEnergyWorkerTaskPriority(creep: Creep): number {
  const task = creep.memory.task;
  const carriedEnergy = getCreepStoredEnergy(creep);
  if (carriedEnergy > 0) {
    return isTransferTask(task) ? 0 : 2;
  }

  if (isEnergyAcquisitionTask(task) || getCreepFreeEnergyCapacity(creep) > 0) {
    return 3;
  }

  return isOptionalWorkerTask(task) ? 5 : 4;
}

function isLowRoomEnergyForWorkerTaskPriority(room: Room | undefined): boolean {
  const energyAvailable = normalizeOptionalNonNegativeInteger(room?.energyAvailable);
  const energyCapacityAvailable = normalizeOptionalNonNegativeInteger(room?.energyCapacityAvailable);
  if (energyAvailable === undefined || energyCapacityAvailable === undefined || energyCapacityAvailable <= 0) {
    return false;
  }

  const threshold = Math.min(
    energyCapacityAvailable,
    Math.max(
      BOOTSTRAP_WORKER_BUFFER_BYPASS_MIN_ENERGY,
      Math.floor(energyCapacityAvailable * LOW_ROOM_ENERGY_TASK_PRIORITY_RATIO)
    )
  );
  return energyAvailable < threshold;
}

function isEnergyAcquisitionTask(
  task: CreepTaskMemory | null | undefined
): task is Extract<CreepTaskMemory, { type: 'harvest' | 'pickup' | 'withdraw' }> {
  return task?.type === 'harvest' || task?.type === 'pickup' || task?.type === 'withdraw';
}

function isTransferTask(
  task: CreepTaskMemory | null | undefined
): task is Extract<CreepTaskMemory, { type: 'transfer' }> {
  return task?.type === 'transfer';
}

function isOptionalWorkerTask(task: CreepTaskMemory | null | undefined): boolean {
  return task?.type === 'build' || task?.type === 'repair' || task?.type === 'upgrade';
}

function getCreepStoredEnergy(creep: Creep): number {
  return getCreepStoreAmount(creep, 'getUsedCapacity');
}

function getCreepFreeEnergyCapacity(creep: Creep): number {
  return getCreepStoreAmount(creep, 'getFreeCapacity');
}

function getCreepStoreAmount(
  creep: Creep,
  method: 'getUsedCapacity' | 'getFreeCapacity'
): number {
  const storeMethod = creep.store?.[method];
  if (typeof storeMethod !== 'function') {
    return 0;
  }

  const value = storeMethod.call(creep.store, getResourceEnergyConstant());
  return normalizeNonNegativeInteger(value);
}

function getResourceEnergyConstant(): ResourceConstant {
  return ((globalThis as unknown as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function shouldRunLabManagement(room: Room, featureGates: RuntimeFeatureGates): StructureLab[] {
  if (!featureGates.labManagement) {
    return [];
  }

  if (room.controller?.my !== true || (room.controller.level ?? 0) < 6) {
    return [];
  }

  return detectOwnedLabs(room);
}

function recordStrategyRecommendationTelemetry(
  colony: ColonySnapshot,
  creeps: Creep[],
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  if (!shouldRecordStrategyRecommendationTelemetry(Game.time)) {
    return;
  }

  let recommendations: import('../strategy/strategyRecommender').StrategyRecommendation[];
  try {
    recommendations = rejectUncertain(
      generateStrategyRecommendations(buildStrategyRecommendationRoomState(colony, creeps))
    );
  } catch {
    return;
  }
  if (recommendations.length === 0) {
    return;
  }

  telemetryEvents.push({
    type: 'strategyRecommendation',
    roomName: colony.room.name,
    tick: Game.time,
    shadow: true,
    recommendations
  });
}

function shouldRecordStrategyRecommendationTelemetry(gameTime: number): boolean {
  return gameTime > 0 && gameTime % RUNTIME_SUMMARY_INTERVAL === 0;
}

function attemptCrossRoomHaulerSpawn(
  colonies: ColonySnapshot[],
  telemetryEvents: RuntimeTelemetryEvent[],
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>,
  reservedSpawnEnergyByRoom: Map<string, number>
): void {
  const spawnRequest = planCrossRoomHauler();
  if (!spawnRequest) {
    return;
  }

  const sourceRoomName = spawnRequest.spawn.room.name;
  const sourceColony = colonies.find((colony) => colony.room.name === sourceRoomName);
  const usedSpawns = usedSpawnsByRoom.get(sourceRoomName) ?? new Set<StructureSpawn>();
  const candidateSpawns = (sourceColony?.spawns ?? [spawnRequest.spawn])
    .filter((spawn) => !spawn.spawning && !usedSpawns.has(spawn));
  if (candidateSpawns.length === 0) {
    return;
  }

  const availableEnergy = getAvailableSpawnEnergyAfterReservations(sourceColony, spawnRequest, reservedSpawnEnergyByRoom);
  const bufferSpawns = sourceColony?.spawns ?? [spawnRequest.spawn];
  const spawnPlan = selectCrossRoomHaulerSpawnPlanWithinEnergyBuffer(spawnRequest, availableEnergy, bufferSpawns);
  if (!spawnPlan) {
    const originalBodyCost = getBodyCost(spawnRequest.body);
    if (
      originalBodyCost <= availableEnergy &&
      isSpawnEnergyBufferViolated(spawnRequest.spawn.room, bufferSpawns, availableEnergy, originalBodyCost)
    ) {
      logSpawnEnergyBufferWarning(spawnRequest, spawnRequest.spawn.room, bufferSpawns, availableEnergy, originalBodyCost);
    }
    return;
  }

  const { spawnRequest: bufferedSpawnRequest, bodyCost } = spawnPlan;
  if (isSpawnEnergyBufferViolated(spawnRequest.spawn.room, bufferSpawns, availableEnergy, bodyCost)) {
    logSpawnEnergyBufferWarning(spawnRequest, spawnRequest.spawn.room, bufferSpawns, availableEnergy, bodyCost);
    return;
  }

  const request = candidateSpawns.includes(bufferedSpawnRequest.spawn)
    ? bufferedSpawnRequest
    : { ...bufferedSpawnRequest, spawn: candidateSpawns[0] };
  const outcome = attemptSpawnRequest(
    request,
    sourceRoomName,
    telemetryEvents,
    candidateSpawns
  );
  if (!outcome || outcome.result !== OK_CODE) {
    return;
  }

  recordUsedSpawn(usedSpawnsByRoom, sourceRoomName, outcome.spawn);
  recordReservedSpawnEnergy(reservedSpawnEnergyByRoom, sourceRoomName, bodyCost);
}

function getAvailableSpawnEnergyAfterReservations(
  sourceColony: ColonySnapshot | undefined,
  spawnRequest: SpawnRequest,
  reservedSpawnEnergyByRoom: Map<string, number>
): number {
  const sourceRoomName = spawnRequest.spawn.room.name;
  const roomEnergy = sourceColony?.energyAvailable ?? spawnRequest.spawn.room.energyAvailable;
  return Math.max(0, roomEnergy - (reservedSpawnEnergyByRoom.get(sourceRoomName) ?? 0));
}

function attemptMineralHarvesterSpawns(
  colonies: ColonySnapshot[],
  creeps: Creep[],
  telemetryEvents: RuntimeTelemetryEvent[],
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>,
  reservedSpawnEnergyByRoom: Map<string, number>
): void {
  for (const colony of colonies) {
    const roomName = colony.room.name;
    const usedSpawns = usedSpawnsByRoom.get(roomName) ?? new Set<StructureSpawn>();
    const candidateSpawns = colony.spawns.filter((spawn) => !spawn.spawning && !usedSpawns.has(spawn));
    if (candidateSpawns.length === 0) {
      continue;
    }

    const availableEnergy = getAvailableSpawnEnergy(colony, reservedSpawnEnergyByRoom);
    const spawnRequest = planMineralHarvesterSpawn(colony, creeps, Game.time, {
      energyAvailable: availableEnergy,
      bodyEnergyBudget: getBufferedSpawnEnergyBudget(colony.room, colony.spawns, availableEnergy),
      usedSpawns
    });
    if (!spawnRequest) {
      continue;
    }

    const bodyCost = getBodyCost(spawnRequest.body);
    const outcome = attemptSpawnRequest(spawnRequest, roomName, telemetryEvents, candidateSpawns);
    if (!outcome || outcome.result !== OK_CODE) {
      continue;
    }

    recordUsedSpawn(usedSpawnsByRoom, roomName, outcome.spawn);
    recordReservedSpawnEnergy(reservedSpawnEnergyByRoom, roomName, bodyCost);
  }
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
    const expansionSelection = refreshExpansionExecutorIntent(colony, Game.time, telemetryEvents);
    if (expansionSelection.status === 'planned') {
      clearAdjacentRoomReservationIntent(colony.room.name);
      persistOccupationRecommendationFollowUpIntent(clearOccupationRecommendationFollowUpIntent(report), Game.time);
      return;
    }
    if (expansionSelection.reason === 'roomLimitReached' || expansionSelection.reason === 'gclInsufficient') {
      const colonyName = colony.room.name;
      clearNextExpansionTargetIntent(colonyName);
      clearAutonomousExpansionClaimIntent(colonyName);
      clearOccupationRecommendationClaimIntent(colonyName);
      report = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
      persistOccupationRecommendationFollowUpIntent(suppressOccupationClaimRecommendation(report), Game.time);
      refreshAdjacentRoomReservationIntent(colony, Game.time);
      return;
    }
    if (expansionSelection.reason === 'unmetPreconditions') {
      persistOccupationRecommendationFollowUpIntent(clearOccupationRecommendationFollowUpIntent(report), Game.time);
      refreshAdjacentRoomReservationIntent(colony, Game.time, { claimBlocker: 'colonyUnstable' });
      return;
    }

    const colonyExpansionEvaluation = refreshColonyExpansionIntent(colony, { territoryReady }, Game.time);
    if (colonyExpansionEvaluation.status === 'planned') {
      persistOccupationRecommendationFollowUpIntent(clearOccupationRecommendationFollowUpIntent(report), Game.time);
      return;
    }

    const claimEvaluation = refreshAutonomousExpansionClaimIntent(colony, report, Game.time, telemetryEvents);
    recordAutonomousExpansionClaimReserveFallbackIntent(colony.room.name, claimEvaluation, Game.time);
    refreshAdjacentRoomReservationIntent(colony, Game.time, { reserveWhenClaimAllowed: true });
    if (shouldDeferOccupationRecommendationForExpansionClaim(claimEvaluation)) {
      return;
    }
  }

  persistOccupationRecommendationFollowUpIntent(
    territoryReady ? report : clearOccupationRecommendationFollowUpIntent(report),
    Game.time
  );
  if (territoryReady) {
    refreshAdjacentRoomReservationIntent(colony, Game.time);
  }
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

function planCoordinatedSpawn(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions,
  colonies: ColonySnapshot[],
  creeps: Creep[],
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>,
  reservedSpawnEnergyByRoom: Map<string, number>,
  plannedRoleCountsByRoom: Map<string, RoleCounts>,
  survivalAssessment: ReturnType<typeof assessColonySnapshotSurvival>
): CoordinatedSpawnPlan | null {
  for (const sourceColony of getCoordinatedSpawnSourceColonies(
    colony,
    colonies,
    creeps,
    usedSpawnsByRoom,
    reservedSpawnEnergyByRoom,
    plannedRoleCountsByRoom
  )) {
    const sourceRoomName = sourceColony.room.name;
    const availableEnergy = getAvailableSpawnEnergy(sourceColony, reservedSpawnEnergyByRoom);
    const usedSpawns = usedSpawnsByRoom.get(sourceRoomName) ?? new Set<StructureSpawn>();
    const sourceRoleCounts =
      sourceRoomName === colony.room.name
        ? roleCounts
        : getPlannedOrCurrentRoleCounts(creeps, sourceRoomName, plannedRoleCountsByRoom);
    const sourceSurvivalAssessment =
      sourceRoomName === colony.room.name
        ? survivalAssessment
        : assessColonySnapshotSurvival(sourceColony, sourceRoleCounts);
    const spawnPlan = selectSpawnPlanWithinEnergyBuffer(
      colony,
      sourceColony,
      availableEnergy,
      usedSpawns,
      roleCounts,
      gameTime,
      options,
      sourceRoleCounts,
      sourceSurvivalAssessment
    );
    if (!spawnPlan) {
      continue;
    }

    if (
      sourceRoomName !== colony.room.name &&
      !isAllowedCrossRoomSpawnRequest(spawnPlan.spawnRequest, colony.room.name)
    ) {
      continue;
    }

    return {
      ...spawnPlan,
      spawnRequest: withCrossRoomSpawnSupportMemory(spawnPlan.spawnRequest, sourceRoomName, colony.room.name),
      spawns: spawnPlan.planningColony.spawns,
      sourceColony,
      sourceRoomName,
      availableEnergy
    };
  }

  return null;
}

function createSpawnPlanningColony(
  colony: ColonySnapshot,
  sourceColony: ColonySnapshot,
  energyAvailable: number,
  usedSpawns: Set<StructureSpawn>
): ColonySnapshot {
  return {
    ...colony,
    energyAvailable,
    energyCapacityAvailable: normalizeNonNegativeInteger(sourceColony.energyCapacityAvailable),
    spawnEnergyBudget: normalizeNonNegativeInteger(energyAvailable),
    spawns: sourceColony.spawns.filter((spawn) => !spawn.spawning && !usedSpawns.has(spawn))
  };
}

function createSpawnEnergyReservationPlanningColony(
  colony: ColonySnapshot,
  sourceColony: ColonySnapshot,
  energyBudget: number
): ColonySnapshot {
  const energyCapacityAvailable = normalizeNonNegativeInteger(sourceColony.energyCapacityAvailable);
  const normalizedEnergyBudget = normalizeNonNegativeInteger(energyBudget);
  return {
    ...colony,
    energyAvailable: normalizedEnergyBudget,
    energyCapacityAvailable,
    spawnEnergyBudget: normalizedEnergyBudget,
    spawns: sourceColony.spawns
  };
}

function getCoordinatedSpawnSourceColonies(
  targetColony: ColonySnapshot,
  colonies: ColonySnapshot[],
  creeps: Creep[],
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>,
  reservedSpawnEnergyByRoom: Map<string, number>,
  plannedRoleCountsByRoom: Map<string, RoleCounts>
): ColonySnapshot[] {
  const localSource = colonies.find((colony) => colony.room.name === targetColony.room.name);
  if (localSource && hasUsedLocalSpawnThisTick(localSource, usedSpawnsByRoom)) {
    return [localSource];
  }

  const remoteSources = colonies
    .filter((colony) => colony.room.name !== targetColony.room.name)
    .filter((sourceColony) =>
      canUseCrossRoomSpawnSource(
        sourceColony,
        creeps,
        usedSpawnsByRoom,
        reservedSpawnEnergyByRoom,
        plannedRoleCountsByRoom
      )
    )
    .sort((left, right) =>
      compareCoordinatedSpawnSources(left, right, targetColony, reservedSpawnEnergyByRoom)
    );

  return localSource ? [localSource, ...remoteSources] : remoteSources;
}

function hasUsedLocalSpawnThisTick(
  colony: ColonySnapshot,
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>
): boolean {
  return (usedSpawnsByRoom.get(colony.room.name)?.size ?? 0) > 0;
}

function canUseCrossRoomSpawnSource(
  sourceColony: ColonySnapshot,
  creeps: Creep[],
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>,
  reservedSpawnEnergyByRoom: Map<string, number>,
  plannedRoleCountsByRoom: Map<string, RoleCounts>
): boolean {
  if (getUnusedSpawnCount(sourceColony, usedSpawnsByRoom) === 0) {
    return false;
  }

  if (!hasFullSpawnEnergyAfterReservations(sourceColony, reservedSpawnEnergyByRoom)) {
    return false;
  }

  const roleCounts = getPlannedOrCurrentRoleCounts(
    creeps,
    sourceColony.room.name,
    plannedRoleCountsByRoom
  );
  const workerTarget = getWorkerTarget(sourceColony, roleCounts);
  if (getWorkerCapacity(roleCounts) < workerTarget) {
    return false;
  }

  if (shouldSuppressWorkerSpawnForCrossRoomImport(sourceColony)) {
    return false;
  }

  const survival = assessColonySnapshotSurvival(sourceColony, roleCounts);
  return (
    survival.mode === 'TERRITORY_READY' &&
    !survival.controllerDowngradeGuard &&
    !survival.hostilePresence
  );
}

function compareCoordinatedSpawnSources(
  left: ColonySnapshot,
  right: ColonySnapshot,
  targetColony: ColonySnapshot,
  reservedSpawnEnergyByRoom: Map<string, number>
): number {
  return (
    compareSpawnSourceRouteDistances(
      getCrossRoomSpawnRouteDistance(left.room.name, targetColony.room.name),
      getCrossRoomSpawnRouteDistance(right.room.name, targetColony.room.name)
    ) ||
    getAvailableSpawnEnergy(right, reservedSpawnEnergyByRoom) -
      getAvailableSpawnEnergy(left, reservedSpawnEnergyByRoom) ||
    normalizeNonNegativeInteger(right.energyCapacityAvailable) -
      normalizeNonNegativeInteger(left.energyCapacityAvailable) ||
    left.room.name.localeCompare(right.room.name)
  );
}

export function compareSpawnSourceRouteDistances(leftDistance: number, rightDistance: number): number {
  if (leftDistance === rightDistance) {
    return 0;
  }

  const leftFinite = Number.isFinite(leftDistance);
  const rightFinite = Number.isFinite(rightDistance);
  if (!leftFinite || !rightFinite) {
    if (!leftFinite && !rightFinite) {
      return 0;
    }

    return leftFinite ? -1 : 1;
  }

  return leftDistance < rightDistance ? -1 : 1;
}

function getCrossRoomSpawnRouteDistance(sourceRoomName: string, targetRoomName: string): number {
  if (sourceRoomName === targetRoomName) {
    return 0;
  }

  const gameMap = (globalThis as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map as
    | (Partial<GameMap> & {
        findRoute?: (fromRoom: string, toRoom: string) => unknown;
        getRoomLinearDistance?: (roomName1: string, roomName2: string) => number;
      })
    | undefined;

  if (typeof gameMap?.findRoute === 'function') {
    const route = gameMap.findRoute.call(gameMap, sourceRoomName, targetRoomName);
    if (Array.isArray(route)) {
      return route.length;
    }

    if (route === ERR_NO_PATH_CODE) {
      return Number.POSITIVE_INFINITY;
    }
  }

  if (typeof gameMap?.getRoomLinearDistance === 'function') {
    const distance = gameMap.getRoomLinearDistance.call(gameMap, sourceRoomName, targetRoomName);
    if (typeof distance === 'number' && Number.isFinite(distance)) {
      return Math.max(0, Math.floor(distance));
    }
  }

  return Number.POSITIVE_INFINITY;
}

function getUnusedSpawnCount(
  colony: ColonySnapshot,
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>
): number {
  const usedSpawns = usedSpawnsByRoom.get(colony.room.name) ?? new Set<StructureSpawn>();
  return colony.spawns.filter((spawn) => !spawn.spawning && !usedSpawns.has(spawn)).length;
}

function hasFullSpawnEnergyAfterReservations(
  colony: ColonySnapshot,
  reservedSpawnEnergyByRoom: Map<string, number>
): boolean {
  const energyCapacity = normalizeNonNegativeInteger(colony.energyCapacityAvailable);
  return energyCapacity > 0 && getAvailableSpawnEnergy(colony, reservedSpawnEnergyByRoom) >= energyCapacity;
}

function getAvailableSpawnEnergy(
  colony: ColonySnapshot | undefined,
  reservedSpawnEnergyByRoom: Map<string, number>
): number {
  if (!colony) {
    return 0;
  }

  return Math.max(
    0,
    normalizeNonNegativeInteger(colony.energyAvailable) -
      (reservedSpawnEnergyByRoom.get(colony.room.name) ?? 0)
  );
}

function updateNextSpawnEnergyReservation(
  colony: ColonySnapshot,
  sourceColony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions,
  spawnedRequest: SpawnRequest,
  spentSpawnEnergyThisTick: number
): void {
  const sourceRoomName = sourceColony.room.name;
  const energyBudgetAfterSpawn = Math.max(
    0,
    normalizeNonNegativeInteger(sourceColony.energyAvailable) - normalizeNonNegativeInteger(spentSpawnEnergyThisTick)
  );
  const reservationPlanningColony = createSpawnEnergyReservationPlanningColony(
    colony,
    sourceColony,
    energyBudgetAfterSpawn
  );
  const candidate = planSpawnEnergyReservationCandidate(
    reservationPlanningColony,
    roleCounts,
    gameTime,
    options
  );
  if (!candidate) {
    clearSpawnEnergyReservation(sourceRoomName, gameTime);
    return;
  }

  reserveSpawnEnergyForNextRequest(
    {
      roomName: sourceRoomName,
      bodyCost: candidate.bodyCost,
      creepName: candidate.creepName,
      role: candidate.role,
      sourceCreepName: spawnedRequest.name,
      sourceRole: String(spawnedRequest.memory.role)
    },
    gameTime
  );
}

function refreshSpawnEnergyReservationStates(colonies: ColonySnapshot[]): void {
  for (const colony of colonies) {
    refreshSpawnEnergyReservationState(colony.room, colony.spawns, Game.time);
  }
}

function refreshSpawnEnergyBufferStates(
  colonies: ColonySnapshot[],
  reservedSpawnEnergyByRoom: Map<string, number>
): void {
  for (const colony of colonies) {
    refreshSpawnEnergyBufferState(colony.room, colony.spawns, Game.time, {
      currentEnergy: getAvailableSpawnEnergy(colony, reservedSpawnEnergyByRoom)
    });
  }
}

function getPlannedOrCurrentRoleCounts(
  creeps: Creep[],
  roomName: string,
  plannedRoleCountsByRoom: Map<string, RoleCounts>
): RoleCounts {
  return plannedRoleCountsByRoom.get(roomName) ?? countCreepsByRole(creeps, roomName);
}

function isAllowedCrossRoomSpawnRequest(
  spawnRequest: SpawnRequest,
  targetRoomName: string
): boolean {
  if (spawnRequest.memory.colony !== targetRoomName) {
    return false;
  }

  if (spawnRequest.memory.role === 'worker') {
    return !spawnRequest.memory.controllerSustain;
  }

  if (isControllerUpgradeSpawnRequest(spawnRequest)) {
    return spawnRequest.memory.controllerUpgrade?.roomName === targetRoomName;
  }

  return spawnRequest.memory.role === TERRITORY_CLAIMER_ROLE || spawnRequest.memory.role === TERRITORY_SCOUT_ROLE;
}

function withCrossRoomSpawnSupportMemory(
  spawnRequest: SpawnRequest,
  sourceRoomName: string,
  targetRoomName: string
): SpawnRequest {
  if (
    sourceRoomName === targetRoomName ||
    spawnRequest.memory.role !== 'worker' ||
    spawnRequest.memory.controllerSustain
  ) {
    return spawnRequest;
  }

  return {
    ...spawnRequest,
    memory: {
      ...spawnRequest.memory,
      spawnSupport: {
        originRoom: sourceRoomName,
        targetRoom: targetRoomName
      }
    }
  };
}

function selectSpawnPlanWithinEnergyBuffer(
  colony: ColonySnapshot,
  sourceColony: ColonySnapshot,
  availableEnergy: number,
  usedSpawns: Set<StructureSpawn>,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions,
  sourceRoleCounts: RoleCounts,
  sourceSurvivalAssessment: ReturnType<typeof assessColonySnapshotSurvival>
): SpawnPlanSelection | null {
  const spawnPlan = planSpawnWithEnergyBudget(
    colony,
    sourceColony,
    availableEnergy,
    usedSpawns,
    roleCounts,
    gameTime,
    options
  );
  if (!spawnPlan) {
    return null;
  }

  if (
    shouldBypassSpawnEnergyBuffer(
      spawnPlan.spawnRequest,
      sourceRoleCounts,
      availableEnergy,
      spawnPlan.bodyCost,
      sourceSurvivalAssessment
    ) ||
    !isSpawnEnergyBufferViolated(sourceColony.room, sourceColony.spawns, availableEnergy, spawnPlan.bodyCost)
  ) {
    return spawnPlan;
  }

  const fallbackSpawnPlan = planSpawnWithEnergyBudget(
    colony,
    sourceColony,
    getBufferedSpawnEnergyBudget(sourceColony.room, sourceColony.spawns, availableEnergy),
    usedSpawns,
    roleCounts,
    gameTime,
    options
  );
  if (
    fallbackSpawnPlan &&
    !isSpawnEnergyBufferViolated(sourceColony.room, sourceColony.spawns, availableEnergy, fallbackSpawnPlan.bodyCost)
  ) {
    return fallbackSpawnPlan;
  }

  logSpawnEnergyBufferWarning(
    spawnPlan.spawnRequest,
    sourceColony.room,
    sourceColony.spawns,
    availableEnergy,
    spawnPlan.bodyCost
  );
  return null;
}

function planSpawnWithEnergyBudget(
  colony: ColonySnapshot,
  sourceColony: ColonySnapshot,
  energyBudget: number,
  usedSpawns: Set<StructureSpawn>,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions
): SpawnPlanSelection | null {
  const planningColony = createSpawnPlanningColony(colony, sourceColony, energyBudget, usedSpawns);
  const spawnRequest = planSpawn(planningColony, roleCounts, gameTime, options);
  if (!spawnRequest) {
    return null;
  }

  return {
    planningColony,
    spawnRequest,
    bodyCost: getBodyCost(spawnRequest.body)
  };
}

function shouldBypassSpawnEnergyBuffer(
  spawnRequest: SpawnRequest,
  roleCounts: RoleCounts,
  availableEnergy: number,
  bodyCost: number,
  survivalAssessment: ReturnType<typeof assessColonySnapshotSurvival>
): boolean {
  return (
    roleCounts.worker === 0 ||
    isBootstrapWorkerRecoverySpawnRequest(spawnRequest, roleCounts, availableEnergy, survivalAssessment) ||
    isLocalWorkerRecoverySpawnRequest(spawnRequest, availableEnergy, bodyCost, survivalAssessment) ||
    isLocalSourceMinerRecoverySpawnRequest(spawnRequest, roleCounts, availableEnergy, bodyCost, survivalAssessment) ||
    isTerritoryControllerSpawnRequest(spawnRequest)
  );
}

function isBootstrapWorkerRecoverySpawnRequest(
  spawnRequest: SpawnRequest,
  roleCounts: RoleCounts,
  availableEnergy: number,
  survivalAssessment: ReturnType<typeof assessColonySnapshotSurvival>
): boolean {
  return (
    spawnRequest.memory.role === 'worker' &&
    survivalAssessment.mode === 'BOOTSTRAP' &&
    (roleCounts.worker < survivalAssessment.survivalWorkerFloor ||
      availableEnergy >= BOOTSTRAP_WORKER_BUFFER_BYPASS_MIN_ENERGY)
  );
}

function isLocalWorkerRecoverySpawnRequest(
  spawnRequest: SpawnRequest,
  availableEnergy: number,
  bodyCost: number,
  survivalAssessment: ReturnType<typeof assessColonySnapshotSurvival>
): boolean {
  return (
    spawnRequest.memory.role === 'worker' &&
    survivalAssessment.mode !== 'DEFENSE' &&
    !survivalAssessment.hostilePresence &&
    !survivalAssessment.controllerDowngradeGuard &&
    isEarlyRclWorkerRecoveryRoom(spawnRequest.spawn.room) &&
    survivalAssessment.workerCapacity < survivalAssessment.workerTarget &&
    isRoomCurrentlyBelowSpawnEnergyBuffer(spawnRequest.spawn) &&
    availableEnergy >= bodyCost
  );
}

function isEarlyRclWorkerRecoveryRoom(room: Room): boolean {
  const controllerLevel = normalizeOptionalNonNegativeInteger(room.controller?.level);
  return controllerLevel !== undefined && controllerLevel <= 2;
}

function isRoomCurrentlyBelowSpawnEnergyBuffer(spawn: StructureSpawn): boolean {
  const currentRoomEnergy = normalizeOptionalNonNegativeInteger(spawn.room?.energyAvailable);
  return (
    currentRoomEnergy !== undefined &&
    currentRoomEnergy < getSpawnEnergyBufferRequirement(spawn.room, [spawn])
  );
}

function isTerritoryControllerSpawnRequest(spawnRequest: SpawnRequest): boolean {
  return spawnRequest.memory.role === TERRITORY_CLAIMER_ROLE || spawnRequest.memory.role === TERRITORY_SCOUT_ROLE;
}

function isLocalSourceMinerRecoverySpawnRequest(
  spawnRequest: SpawnRequest,
  roleCounts: RoleCounts,
  availableEnergy: number,
  bodyCost: number,
  survivalAssessment: ReturnType<typeof assessColonySnapshotSurvival>
): boolean {
  return (
    spawnRequest.memory.role === SOURCE_HARVESTER_ROLE &&
    spawnRequest.memory.sourceHarvester?.roomName === spawnRequest.memory.colony &&
    survivalAssessment.mode !== 'BOOTSTRAP' &&
    !survivalAssessment.hostilePresence &&
    !survivalAssessment.controllerDowngradeGuard &&
    roleCounts.worker >= survivalAssessment.survivalWorkerFloor &&
    availableEnergy >= bodyCost
  );
}

function selectCrossRoomHaulerSpawnPlanWithinEnergyBuffer(
  spawnRequest: SpawnRequest,
  availableEnergy: number,
  spawns: StructureSpawn[]
): SpawnRequestSelection | null {
  const bodyCost = getBodyCost(spawnRequest.body);
  if (bodyCost <= getBufferedSpawnEnergyBudget(spawnRequest.spawn.room, spawns, availableEnergy)) {
    return {
      spawnRequest,
      bodyCost
    };
  }

  const fallbackBody = buildAffordableCrossRoomHaulerBody(
    spawnRequest.body,
    getBufferedSpawnEnergyBudget(spawnRequest.spawn.room, spawns, availableEnergy)
  );
  if (fallbackBody.length === 0) {
    return null;
  }

  return {
    spawnRequest: { ...spawnRequest, body: fallbackBody },
    bodyCost: getBodyCost(fallbackBody)
  };
}

function buildAffordableCrossRoomHaulerBody(
  body: BodyPartConstant[],
  energyBudget: number
): BodyPartConstant[] {
  const affordableBody: BodyPartConstant[] = [];
  let bodyCost = 0;

  for (let index = 0; index + 1 < body.length; index += 2) {
    const pair = body.slice(index, index + 2);
    if (pair[0] !== 'carry' || pair[1] !== 'move') {
      return [];
    }

    const pairCost = getBodyCost(pair);
    if (bodyCost + pairCost > energyBudget) {
      break;
    }

    affordableBody.push(...pair);
    bodyCost += pairCost;
  }

  return affordableBody;
}

function getSpawnPlanningOptions(
  successfulSpawnCount: number,
  hasPendingTerritoryFollowUp: boolean,
  controllerUpgradeTargetRooms: readonly string[] | null
): SpawnPlanningOptions {
  const allowTerritoryFollowUp = successfulSpawnCount > 0 || hasPendingTerritoryFollowUp;
  if (successfulSpawnCount === 0) {
    return allowTerritoryFollowUp
      ? { allowTerritoryFollowUp, controllerUpgradeTargetRooms }
      : { controllerUpgradeTargetRooms };
  }

  return {
    nameSuffix: String(successfulSpawnCount + 1),
    workersOnly: true,
    allowTerritoryControllerPressure: true,
    allowTerritoryFollowUp,
    controllerUpgradeTargetRooms
  };
}

function getControllerUpgradeTargetRooms(colonies: ColonySnapshot[]): readonly string[] | null {
  const targetRooms = selectColonyUpgradeTargets(colonies).map((colony) => colony.room.name);
  return targetRooms.length > 0 ? targetRooms : null;
}

function isAllowedPostSpawnRequest(spawnRequest: SpawnRequest): boolean {
  return (
    spawnRequest.memory.role === 'worker' ||
    isControllerUpgradeSpawnRequest(spawnRequest) ||
    isTerritoryControllerPressureSpawnRequest(spawnRequest) ||
    isTerritoryControllerFollowUpSpawnRequest(spawnRequest)
  );
}

function isControllerUpgradeSpawnRequest(spawnRequest: SpawnRequest): boolean {
  return (
    (spawnRequest.memory.role === UPGRADER_ROLE || spawnRequest.memory.role === 'worker') &&
    spawnRequest.memory.controllerUpgrade !== undefined
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

function logSpawnEnergyBufferWarning(
  spawnRequest: SpawnRequest,
  room: Room,
  spawns: StructureSpawn[],
  availableEnergy: number,
  bodyCost: number
): void {
  const roomName = room.name;
  const requiredBuffer = getSpawnEnergyBufferRequirement(room, spawns);
  console.log(
    `[spawn] warning: deferred ${spawnRequest.name} in ${roomName}; available energy ${availableEnergy}, body cost ${bodyCost}, required buffer ${requiredBuffer}`
  );
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

function addPlannedUpgrader(roleCounts: RoleCounts): RoleCounts {
  const upgrader = (roleCounts.upgrader ?? 0) + 1;
  const upgraderCapacity = (roleCounts.upgraderCapacity ?? roleCounts.upgrader ?? 0) + 1;
  const nextRoleCounts: RoleCounts = {
    ...roleCounts,
    upgrader
  };

  if (upgraderCapacity === upgrader) {
    delete nextRoleCounts.upgraderCapacity;
  } else {
    nextRoleCounts.upgraderCapacity = upgraderCapacity;
  }

  return nextRoleCounts;
}

function recordUsedSpawn(
  usedSpawnsByRoom: Map<string, Set<StructureSpawn>>,
  roomName: string,
  spawn: StructureSpawn
): void {
  const usedSpawns = usedSpawnsByRoom.get(roomName) ?? new Set<StructureSpawn>();
  usedSpawns.add(spawn);
  usedSpawnsByRoom.set(roomName, usedSpawns);
}

function recordReservedSpawnEnergy(
  reservedSpawnEnergyByRoom: Map<string, number>,
  roomName: string,
  bodyCost: number
): void {
  reservedSpawnEnergyByRoom.set(
    roomName,
    (reservedSpawnEnergyByRoom.get(roomName) ?? 0) + bodyCost
  );
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
