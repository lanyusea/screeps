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
  | 'territoryRemote'
  | 'controllerUpgradeSurplus';

interface SpawnPlanningContext {
  colony: ColonySnapshot;
  gameTime: number;
  options: SpawnPlanningOptions;
  roleCounts: RoleCounts;
  survival: ColonySurvivalAssessment;
  territoryIntentPending: boolean;
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
  allowTerritoryControllerPressure?: boolean;
  allowTerritoryFollowUp?: boolean;
}

const TERRITORY_SCOUT_BODY: BodyPartConstant[] = ['move'];
const TERRITORY_SCOUT_BODY_COST = 50;
const CONTROLLER_UPGRADE_SURPLUS_WORKER_BONUS = 1;
const CONTROLLER_UPGRADE_SURPLUS_MIN_ENERGY_CAPACITY = 650;
const CONTROLLER_UPGRADE_SURPLUS_MAX_WORKER_TARGET = 6;
const MAX_CONTROLLER_LEVEL = 8;
const SPAWN_PRIORITY_TIERS: SpawnPriorityTier[] = [
  'emergencyBootstrap',
  // Keep defense above local refill so hostiles cannot starve the first defender.
  'defense',
  'localRefillSurvival',
  'controllerDowngradeGuard',
  'territoryRemote',
  'controllerUpgradeSurplus'
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
    territoryIntentPending: false,
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
    case 'controllerUpgradeSurplus':
      return planControllerUpgradeSurplusSpawn(context);
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
  if (
    context.survival.mode !== 'TERRITORY_READY' ||
    (context.options.workersOnly &&
      context.options.allowTerritoryControllerPressure !== true &&
      context.options.allowTerritoryFollowUp !== true)
  ) {
    return null;
  }

  const controllerPressureOnly =
    context.options.workersOnly === true && context.options.allowTerritoryControllerPressure === true;
  const followUpOnlyFallback =
    context.options.workersOnly === true && context.options.allowTerritoryFollowUp === true;
  const territoryIntent = planTerritoryIntent(
    context.colony,
    context.roleCounts,
    context.workerTarget,
    context.gameTime,
    { controllerPressureOnly, followUpOnly: followUpOnlyFallback }
  );
  if (!territoryIntent) {
    return null;
  }
  context.territoryIntentPending = true;

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

function planControllerUpgradeSurplusSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (!shouldSpawnControllerUpgradeSurplusWorker(context)) {
    return null;
  }

  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}

function shouldSpawnControllerUpgradeSurplusWorker(context: SpawnPlanningContext): boolean {
  if (
    context.options.workersOnly ||
    context.territoryIntentPending ||
    context.survival.mode !== 'TERRITORY_READY' ||
    hasControllerUpgradeBlockingTerritoryWork(context.colony) ||
    !hasControllerUpgradeSurplusEnergy(context.colony) ||
    !isControllerUpgradeableForSurplus(context.colony.room.controller)
  ) {
    return false;
  }

  const surplusWorkerTarget = Math.min(
    CONTROLLER_UPGRADE_SURPLUS_MAX_WORKER_TARGET,
    context.workerTarget + CONTROLLER_UPGRADE_SURPLUS_WORKER_BONUS
  );
  return context.workerCapacity < surplusWorkerTarget;
}

function hasControllerUpgradeSurplusEnergy(colony: ColonySnapshot): boolean {
  return (
    colony.energyCapacityAvailable >= CONTROLLER_UPGRADE_SURPLUS_MIN_ENERGY_CAPACITY &&
    colony.energyAvailable >= colony.energyCapacityAvailable
  );
}

function isControllerUpgradeableForSurplus(controller: StructureController | undefined): boolean {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    controller.level >= 2 &&
    controller.level < MAX_CONTROLLER_LEVEL
  );
}

function hasControllerUpgradeBlockingTerritoryWork(colony: ColonySnapshot): boolean {
  return (
    hasActiveTerritoryIntentBacklog(colony.room.name) ||
    hasVisibleForeignReservedTerritoryTarget(colony)
  );
}

function hasActiveTerritoryIntentBacklog(colonyName: string): boolean {
  const intents = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory?.intents;
  if (!Array.isArray(intents)) {
    return false;
  }

  return intents.some((intent) => {
    if (
      intent.colony !== colonyName ||
      intent.targetRoom === colonyName ||
      (intent.action !== 'claim' && intent.action !== 'reserve' && intent.action !== 'scout')
    ) {
      return false;
    }

    return intent.status === 'planned' || intent.status === 'active' || intent.followUp !== undefined;
  });
}

function hasVisibleForeignReservedTerritoryTarget(colony: ColonySnapshot): boolean {
  const targets = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory?.targets;
  if (!Array.isArray(targets)) {
    return false;
  }

  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller);
  return targets.some((target) => {
    if (
      target.colony !== colony.room.name ||
      target.enabled === false ||
      (target.action !== 'claim' && target.action !== 'reserve')
    ) {
      return false;
    }

    const controller = getVisibleRoomController(target.roomName);
    return isForeignReservedController(controller, colonyOwnerUsername);
  });
}

function getVisibleRoomController(roomName: string): StructureController | undefined {
  return (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName]?.controller;
}

function isForeignReservedController(
  controller: StructureController | undefined,
  colonyOwnerUsername: string | undefined
): boolean {
  const reservationUsername = (controller as (StructureController & { reservation?: { username?: string } }) | undefined)
    ?.reservation?.username;
  return (
    controller?.my !== true &&
    typeof reservationUsername === 'string' &&
    reservationUsername.length > 0 &&
    reservationUsername !== colonyOwnerUsername
  );
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  return typeof username === 'string' && username.length > 0 ? username : undefined;
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
