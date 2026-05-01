import { ColonySnapshot } from '../colony/colonyRegistry';
import {
  assessColonySnapshotSurvival,
  getWorkerTarget,
  type ColonySurvivalAssessment
} from '../colony/survivalMode';
import { getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import { DEFENDER_ROLE } from '../defense/defenseLoop';
import {
  buildEmergencyDefenderBody,
  buildEmergencyWorkerBody,
  buildTerritoryControllerBody,
  buildTerritoryControllerPressureBody,
  buildWorkerBody,
  getBodyCost
} from './bodyBuilder';
import {
  buildTerritoryCreepMemory,
  getTerritoryFollowUpPreparationWorkerDemand,
  planTerritoryIntent,
  recordRecoveredTerritoryFollowUpRetryCooldown,
  requiresTerritoryControllerPressure,
  shouldSpawnTerritoryControllerCreep,
  TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND,
  type TerritoryIntentPlan
} from '../territory/territoryPlanner';

type SpawnPriorityTier =
  | 'emergencyBootstrap'
  | 'defense'
  | 'localRefillSurvival'
  | 'controllerDowngradeGuard'
  | 'territoryRemote';

interface SpawnPlanningContext {
  colony: ColonySnapshot;
  gameTime: number;
  options: SpawnPlanningOptions;
  roleCounts: RoleCounts;
  survival: ColonySurvivalAssessment;
  workerCapacity: number;
  workerTarget: number;
}

export interface SpawnRequest {
  spawn: StructureSpawn;
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}

export interface SpawnPlanningOptions {
  nameSuffix?: string;
  workersOnly?: boolean;
}

const TERRITORY_SCOUT_BODY: BodyPartConstant[] = ['move'];
const TERRITORY_SCOUT_BODY_COST = 50;
const SPAWN_PRIORITY_TIERS: SpawnPriorityTier[] = [
  'emergencyBootstrap',
  // Keep defense above local refill so hostiles cannot starve the first defender.
  'defense',
  'localRefillSurvival',
  'controllerDowngradeGuard',
  'territoryRemote'
];

export function planSpawn(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions = {}
): SpawnRequest | null {
  const workerTarget = getWorkerTarget(colony, roleCounts);
  const workerCapacity = getWorkerCapacity(roleCounts);
  const context: SpawnPlanningContext = {
    colony,
    gameTime,
    options,
    roleCounts,
    survival: assessColonySnapshotSurvival(colony, roleCounts),
    workerCapacity,
    workerTarget
  };

  for (const tier of SPAWN_PRIORITY_TIERS) {
    const request = planSpawnForPriorityTier(tier, context);
    if (request) {
      return request;
    }
  }

  return null;
}

function planSpawnForPriorityTier(
  tier: SpawnPriorityTier,
  context: SpawnPlanningContext
): SpawnRequest | null {
  switch (tier) {
    case 'emergencyBootstrap':
      return planEmergencyBootstrapSpawn(context);
    case 'localRefillSurvival':
      return planLocalSurvivalSpawn(context);
    case 'controllerDowngradeGuard':
      return planControllerDowngradeGuardSpawn(context);
    case 'defense':
      return planDefenseSpawn(context);
    case 'territoryRemote':
      return planTerritoryRemoteSpawn(context);
  }
}

function planEmergencyBootstrapSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.survival.mode !== 'BOOTSTRAP' ||
    context.workerCapacity >= context.survival.survivalWorkerFloor
  ) {
    return null;
  }

  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}

function planLocalSurvivalSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (context.workerCapacity >= context.workerTarget) {
    return null;
  }

  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}

function planControllerDowngradeGuardSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    !context.survival.controllerDowngradeGuard ||
    context.workerCapacity > context.workerTarget ||
    !hasControllerDowngradeGuardSpawnCapacity(context)
  ) {
    return null;
  }

  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}

function hasControllerDowngradeGuardSpawnCapacity(context: SpawnPlanningContext): boolean {
  if (!context.survival.hostilePresence) {
    return true;
  }

  return context.colony.spawns.filter((spawn) => !spawn.spawning).length > 1;
}

function planDefenseSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (!context.survival.hostilePresence || (context.roleCounts.defender ?? 0) > 0) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = buildEmergencyDefenderBody(context.colony.energyAvailable);
  if (body.length === 0) {
    return null;
  }

  const roomName = context.colony.room.name;
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`${DEFENDER_ROLE}-${roomName}-${context.gameTime}`, context.options),
    memory: {
      role: DEFENDER_ROLE,
      colony: roomName,
      defense: { homeRoom: roomName }
    }
  };
}

function planTerritoryRemoteSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (context.options.workersOnly || context.survival.mode !== 'TERRITORY_READY') {
    return null;
  }

  const territoryIntent = planTerritoryIntent(
    context.colony,
    context.roleCounts,
    context.workerTarget,
    context.gameTime
  );
  if (!territoryIntent) {
    return null;
  }

  const demandedWorkerTarget = getWorkerTargetWithTerritoryDemand(
    context.workerTarget,
    territoryIntent,
    context.gameTime
  );
  if (context.workerCapacity < demandedWorkerTarget) {
    const workerSpawn = planWorkerSpawn(
      context.colony,
      context.roleCounts,
      context.gameTime,
      context.options
    );
    if (workerSpawn) {
      return workerSpawn;
    }

    recordRecoveredFollowUpCooldownIfControllerCreepNeeded(
      territoryIntent,
      context.roleCounts,
      context.gameTime
    );
    return null;
  }

  const territorySpawn = planTerritorySpawn(
    context.colony,
    context.roleCounts,
    territoryIntent,
    context.gameTime,
    context.options
  );
  if (territorySpawn) {
    return territorySpawn;
  }

  recordRecoveredFollowUpCooldownIfControllerCreepNeeded(
    territoryIntent,
    context.roleCounts,
    context.gameTime
  );

  return null;
}

function recordRecoveredFollowUpCooldownIfControllerCreepNeeded(
  territoryIntent: TerritoryIntentPlan | null,
  roleCounts: RoleCounts,
  gameTime: number
): void {
  if (!territoryIntent || !shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts, gameTime)) {
    return;
  }

  recordRecoveredTerritoryFollowUpRetryCooldown(territoryIntent, gameTime);
}

function planTerritorySpawn(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  territoryIntent: TerritoryIntentPlan,
  gameTime: number,
  options: SpawnPlanningOptions
): SpawnRequest | null {
  if (!shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts, gameTime)) {
    return null;
  }

  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = buildTerritorySpawnBody(colony.energyAvailable, territoryIntent);
  if (body.length === 0) {
    return null;
  }

  const roleName = territoryIntent.action === 'scout' ? 'scout' : 'claimer';
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`${roleName}-${colony.room.name}-${territoryIntent.targetRoom}-${gameTime}`, options),
    memory: buildTerritoryCreepMemory(territoryIntent)
  };
}

function getWorkerTargetWithTerritoryDemand(
  workerTarget: number,
  territoryIntent: TerritoryIntentPlan,
  gameTime: number
): number {
  const demandWorkerCount = getTerritoryFollowUpPreparationWorkerDemand(territoryIntent, gameTime);
  return workerTarget + Math.min(TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND, demandWorkerCount);
}

function planWorkerSpawn(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions
): SpawnRequest | null {
  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = selectWorkerBody(colony, roleCounts);
  if (body.length === 0) {
    return null;
  }

  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`worker-${colony.room.name}-${gameTime}`, options),
    memory: { role: 'worker', colony: colony.room.name }
  };
}

function appendSpawnNameSuffix(baseName: string, options: SpawnPlanningOptions): string {
  return options.nameSuffix ? `${baseName}-${options.nameSuffix}` : baseName;
}

function selectWorkerBody(colony: ColonySnapshot, roleCounts: RoleCounts): BodyPartConstant[] {
  const normalBody = buildWorkerBody(colony.energyCapacityAvailable);
  if (canAffordBody(normalBody, colony.energyAvailable)) {
    return normalBody;
  }

  if (roleCounts.worker === 0) {
    return buildEmergencyWorkerBody(colony.energyAvailable);
  }

  return buildWorkerBody(colony.energyAvailable);
}

function canAffordBody(body: BodyPartConstant[], energyAvailable: number): boolean {
  return body.length > 0 && getBodyCost(body) <= energyAvailable;
}

function buildTerritorySpawnBody(energyAvailable: number, intent: TerritoryIntentPlan): BodyPartConstant[] {
  if (intent.action === 'scout') {
    return energyAvailable >= TERRITORY_SCOUT_BODY_COST ? [...TERRITORY_SCOUT_BODY] : [];
  }

  if (requiresTerritoryControllerPressure(intent)) {
    return buildTerritoryControllerPressureBody(energyAvailable);
  }

  return buildTerritoryControllerBody(energyAvailable);
}
