import { getOwnedColonies, type ColonySnapshot } from '../colony/colonyRegistry';
import {
  assessColonySnapshotSurvival,
  clearColonySurvivalAssessmentCache,
  recordColonySurvivalAssessment
} from '../colony/survivalMode';
import { planExtensionConstruction } from '../construction/extensionPlanner';
import { planEarlyRoadConstruction } from '../construction/roadPlanner';
import { countCreepsByRole, getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import { runWorker } from '../creeps/workerRunner';
import { getBodyCost, TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS } from '../spawn/bodyBuilder';
import { planSpawn, type SpawnPlanningOptions, type SpawnRequest } from '../spawn/spawnPlanner';
import { emitRuntimeSummary, type RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  buildRuntimeOccupationRecommendationReport,
  clearOccupationRecommendationFollowUpIntent,
  persistOccupationRecommendationFollowUpIntent
} from '../territory/occupationRecommendation';
import {
  refreshAutonomousExpansionClaimIntent,
  shouldDeferOccupationRecommendationForExpansionClaim
} from '../territory/claimExecutor';
import {
  hasPendingTerritoryFollowUpIntent,
  TERRITORY_CLAIMER_ROLE,
  TERRITORY_SCOUT_ROLE
} from '../territory/territoryPlanner';
import { runTerritoryControllerCreep } from '../territory/territoryRunner';

const ERR_BUSY_CODE = -4 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;

interface SpawnAttemptOutcome {
  spawn: StructureSpawn;
  result: ScreepsReturnCode;
}

export function runEconomy(preludeTelemetryEvents: RuntimeTelemetryEvent[] = []): void {
  const creeps = Object.values(Game.creeps);
  const colonies = getOwnedColonies();
  const telemetryEvents: RuntimeTelemetryEvent[] = [...preludeTelemetryEvents];
  clearColonySurvivalAssessmentCache();

  for (const colony of colonies) {
    const extensionResult = planExtensionConstruction(colony);
    if (extensionResult === null) {
      planEarlyRoadConstruction(colony);
    }

    let roleCounts = countCreepsByRole(creeps, colony.room.name);
    const survivalAssessment = assessColonySnapshotSurvival(colony, roleCounts);
    recordColonySurvivalAssessment(colony.room.name, survivalAssessment, Game.time);
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

      if (spawnRequest.memory.role !== 'worker') {
        break;
      }

      roleCounts = addPlannedWorker(roleCounts);
    }
  }

  for (const creep of creeps) {
    if (creep.memory.role === 'worker') {
      runWorker(creep);
    } else if (creep.memory.role === TERRITORY_CLAIMER_ROLE || creep.memory.role === TERRITORY_SCOUT_ROLE) {
      runTerritoryControllerCreep(creep, telemetryEvents);
    }
  }

  emitRuntimeSummary(colonies, creeps, telemetryEvents, { persistOccupationRecommendations: false });
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
  const report = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
  if (territoryReady) {
    const claimEvaluation = refreshAutonomousExpansionClaimIntent(colony, report, Game.time, telemetryEvents);
    if (shouldDeferOccupationRecommendationForExpansionClaim(claimEvaluation)) {
      return;
    }
  }

  persistOccupationRecommendationFollowUpIntent(
    territoryReady ? report : clearOccupationRecommendationFollowUpIntent(report),
    Game.time
  );
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

  return result;
}
