import { ColonySnapshot } from '../colony/colonyRegistry';
import {
  assessColonySnapshotSurvival,
  BOOTSTRAP_MIN_SPAWN_ENERGY,
  EMERGENCY_BOOTSTRAP_WORKER_BODY,
  getRoomSources,
  getSourceCount,
  getWorkerTarget,
  hasEmergencyBootstrapCreepShortfall,
  type ColonySurvivalAssessment
} from '../colony/colonyStage';
import { getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import {
  REMOTE_HARVESTER_ROLE,
  selectRemoteHarvesterAssignment
} from '../creeps/remoteHarvester';
import {
  HAULER_ROLE,
  selectRemoteHaulerAssignment
} from '../creeps/hauler';
import { DEFENDER_ROLE } from '../defense/defenseLoop';
import {
  buildEmergencyDefenderBody,
  buildEmergencyWorkerBody,
  buildRemoteHarvesterBody,
  buildRemoteHaulerBody,
  buildTerritoryControllerBody,
  buildTerritoryControllerPressureBody,
  buildWorkerBody,
  getBodyCost,
  TERRITORY_SCOUT_BODY,
  TERRITORY_SCOUT_BODY_COST
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
import {
  buildMultiRoomUpgraderBody,
  buildMultiRoomUpgraderMemory,
  selectMultiRoomUpgradePlans
} from '../territory/multiRoomUpgrader';

type SpawnPriorityTier =
  | 'emergencyBootstrap'
  | 'defense'
  | 'localRefillSurvival'
  | 'controllerDowngradeGuard'
  | 'postClaimControllerSustain'
  | 'remoteEconomy'
  | 'territoryRemote'
  | 'multiRoomControllerUpgrade'
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

const CONTROLLER_UPGRADE_SURPLUS_WORKER_BONUS = 1;
const CONTROLLER_UPGRADE_SURPLUS_MIN_ENERGY_CAPACITY = 650;
const CONTROLLER_UPGRADE_SURPLUS_MAX_WORKER_TARGET = 6;
const MAX_CONTROLLER_LEVEL = 8;
const SOURCE_ENERGY_CAPACITY = 3_000;
const SOURCE_REGEN_TICKS = 300;
const SOURCE_ENERGY_PER_TICK = SOURCE_ENERGY_CAPACITY / SOURCE_REGEN_TICKS;
const HARVEST_POWER_PER_WORK_PART = 2;
const HARVESTER_FULL_EXTRACTION_WORK_PARTS = Math.ceil(
  SOURCE_ENERGY_PER_TICK / HARVEST_POWER_PER_WORK_PART
);
const CARRY_CAPACITY_PER_PART = 50;
const MAX_CREEP_PARTS = 50;
// Local workers still cover hauling, building, and upgrading, so keep the first
// three bodies general-purpose before specializing source-aware extras.
const LOCAL_SUPPORT_WORKER_FLOOR = 3;
const POST_CLAIM_SUSTAIN_UPGRADER_TARGET = 1;
const POST_CLAIM_SUSTAIN_HAULER_TARGET = 1;
const POST_CLAIM_SUSTAIN_DEFAULT_WORKER_TARGET = 2;
const POST_CLAIM_SUSTAIN_WORKER_REPLACEMENT_TICKS = 100;
const POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY = 200;
const MINIMUM_EMERGENCY_WORKER_BODY_COST = getBodyCost(EMERGENCY_BOOTSTRAP_WORKER_BODY);
const SPAWN_PRIORITY_TIERS: SpawnPriorityTier[] = [
  'emergencyBootstrap',
  'localRefillSurvival',
  'controllerDowngradeGuard',
  'defense',
  'postClaimControllerSustain',
  'remoteEconomy',
  'territoryRemote',
  'multiRoomControllerUpgrade',
  'controllerUpgradeSurplus'
];
const DEFENSE_TOWER_REFILL_ENERGY_FLOOR = 500;

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
    case 'postClaimControllerSustain':
      return planPostClaimControllerSustainSpawn(context);
    case 'remoteEconomy':
      return planRemoteEconomySpawn(context);
    case 'defense':
      return planDefenseSpawn(context);
    case 'territoryRemote':
      return planTerritoryRemoteSpawn(context);
    case 'multiRoomControllerUpgrade':
      return planMultiRoomControllerUpgradeSpawn(context);
    case 'controllerUpgradeSurplus':
      return planControllerUpgradeSurplusSpawn(context);
  }
}

function planEmergencyBootstrapSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.survival.mode !== 'BOOTSTRAP' ||
    !hasEmergencyBootstrapCreepShortfall(context.survival) ||
    !hasRecoveryWorkerSpawnEnergy(context.colony)
  ) {
    return null;
  }

  return planWorkerSpawnWithBody(
    context.colony,
    [...EMERGENCY_BOOTSTRAP_WORKER_BODY],
    context.gameTime,
    context.options
  );
}

function planLocalSurvivalSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.workerCapacity >= context.workerTarget ||
    !hasRecoveryWorkerSpawnEnergy(context.colony)
  ) {
    return null;
  }

  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}

function planControllerDowngradeGuardSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    !context.survival.controllerDowngradeGuard ||
    context.workerCapacity > context.workerTarget ||
    context.colony.energyAvailable < BOOTSTRAP_MIN_SPAWN_ENERGY ||
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

function hasRecoveryWorkerSpawnEnergy(colony: ColonySnapshot): boolean {
  return colony.energyAvailable >= MINIMUM_EMERGENCY_WORKER_BODY_COST;
}

interface PostClaimControllerSustainPlan {
  targetRoom: string;
  role: CreepControllerSustainRole;
  controllerId?: Id<StructureController>;
}

interface PostClaimControllerSustainCounts {
  haulers: number;
  upgraders: number;
  workers: number;
}

function planPostClaimControllerSustainSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (context.survival.mode !== 'TERRITORY_READY' || !hasPostClaimSustainSpawnEnergy(context.colony)) {
    return null;
  }

  const sustainPlan = selectPostClaimControllerSustainPlan(context.colony);
  if (!sustainPlan) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = selectWorkerBody(context.colony, context.roleCounts);
  if (body.length === 0) {
    return null;
  }

  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(
      `worker-${context.colony.room.name}-${sustainPlan.targetRoom}-${sustainPlan.role}-${context.gameTime}`,
      context.options
    ),
    memory: {
      role: 'worker',
      colony: sustainPlan.targetRoom,
      territory: {
        targetRoom: sustainPlan.targetRoom,
        action: 'claim',
        ...(sustainPlan.controllerId ? { controllerId: sustainPlan.controllerId } : {})
      },
      controllerSustain: {
        homeRoom: context.colony.room.name,
        targetRoom: sustainPlan.targetRoom,
        role: sustainPlan.role
      }
    }
  };
}

function hasPostClaimSustainSpawnEnergy(colony: ColonySnapshot): boolean {
  return (
    colony.energyAvailable >= POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY &&
    colony.energyAvailable >= colony.energyCapacityAvailable
  );
}

function selectPostClaimControllerSustainPlan(
  colony: ColonySnapshot
): PostClaimControllerSustainPlan | null {
  const records = getPostClaimControllerSustainRecords(colony.room.name);
  for (const record of records) {
    const targetRoom = getVisibleRoom(record.roomName);
    if (targetRoom?.controller?.my !== true) {
      continue;
    }

    const hasOperationalSpawn = hasOperationalSpawnInRoom(record.roomName);
    const counts = countPostClaimControllerSustainCreeps(record.roomName);
    const workerTarget = getPostClaimControllerSustainWorkerTarget(record);
    const controllerId = getPostClaimControllerSustainControllerId(record, targetRoom);

    if (!hasOperationalSpawn) {
      if (counts.upgraders < POST_CLAIM_SUSTAIN_UPGRADER_TARGET) {
        return { targetRoom: record.roomName, role: 'upgrader', ...(controllerId ? { controllerId } : {}) };
      }

      if (shouldSpawnPostClaimEnergyHauler(targetRoom, counts, workerTarget)) {
        return { targetRoom: record.roomName, role: 'hauler', ...(controllerId ? { controllerId } : {}) };
      }

      if (counts.workers < workerTarget) {
        return { targetRoom: record.roomName, role: 'upgrader', ...(controllerId ? { controllerId } : {}) };
      }
    } else if (
      shouldSpawnPostClaimEnergyHauler(targetRoom, counts, workerTarget) &&
      isClaimedRoomEnergyInsufficient(targetRoom)
    ) {
      return { targetRoom: record.roomName, role: 'hauler', ...(controllerId ? { controllerId } : {}) };
    }
  }

  return null;
}

function getPostClaimControllerSustainRecords(colonyName: string): TerritoryPostClaimBootstrapMemory[] {
  const records = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isRecord(records)) {
    return [];
  }

  return Object.values(records)
    .filter((record): record is TerritoryPostClaimBootstrapMemory =>
      isPostClaimControllerSustainRecord(record, colonyName)
    )
    .sort(comparePostClaimControllerSustainRecords);
}

function isPostClaimControllerSustainRecord(
  record: unknown,
  colonyName: string
): record is TerritoryPostClaimBootstrapMemory {
  return (
    isRecord(record) &&
    record.colony === colonyName &&
    record.roomName !== colonyName &&
    isNonEmptyString(record.roomName) &&
    (record.status === 'detected' ||
      record.status === 'spawnSitePending' ||
      record.status === 'spawnSiteBlocked' ||
      record.status === 'spawningWorkers' ||
      record.status === 'ready')
  );
}

function comparePostClaimControllerSustainRecords(
  left: TerritoryPostClaimBootstrapMemory,
  right: TerritoryPostClaimBootstrapMemory
): number {
  const leftHasSpawn = hasOperationalSpawnInRoom(left.roomName);
  const rightHasSpawn = hasOperationalSpawnInRoom(right.roomName);
  if (leftHasSpawn !== rightHasSpawn) {
    return leftHasSpawn ? 1 : -1;
  }

  return (
    getVisibleControllerLevel(left.roomName) - getVisibleControllerLevel(right.roomName) ||
    left.claimedAt - right.claimedAt ||
    left.roomName.localeCompare(right.roomName)
  );
}

function getVisibleControllerLevel(roomName: string): number {
  const level = getVisibleRoom(roomName)?.controller?.level;
  return typeof level === 'number' ? level : MAX_CONTROLLER_LEVEL + 1;
}

function hasOperationalSpawnInRoom(roomName: string): boolean {
  const spawns = (globalThis as unknown as { Game?: Partial<Pick<Game, 'spawns'>> }).Game?.spawns;
  if (!spawns) {
    return false;
  }

  return Object.values(spawns).some((spawn) => spawn.room?.name === roomName);
}

function countPostClaimControllerSustainCreeps(targetRoom: string): PostClaimControllerSustainCounts {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  const counts: PostClaimControllerSustainCounts = { haulers: 0, upgraders: 0, workers: 0 };
  if (!creeps) {
    return counts;
  }

  for (const creep of Object.values(creeps)) {
    if (!canCountPostClaimSustainCreep(creep, targetRoom)) {
      continue;
    }

    counts.workers += 1;
    if (creep.memory.controllerSustain?.role === 'upgrader') {
      counts.upgraders += 1;
    } else if (creep.memory.controllerSustain?.role === 'hauler') {
      counts.haulers += 1;
    }
  }

  return counts;
}

function canCountPostClaimSustainCreep(creep: Creep, targetRoom: string): boolean {
  if (creep.memory?.role !== 'worker' || creep.memory.colony !== targetRoom) {
    return false;
  }

  return (
    creep.ticksToLive === undefined ||
    creep.ticksToLive > POST_CLAIM_SUSTAIN_WORKER_REPLACEMENT_TICKS
  );
}

function getPostClaimControllerSustainWorkerTarget(record: TerritoryPostClaimBootstrapMemory): number {
  return typeof record.workerTarget === 'number' && record.workerTarget > 0
    ? record.workerTarget
    : POST_CLAIM_SUSTAIN_DEFAULT_WORKER_TARGET;
}

function getPostClaimControllerSustainControllerId(
  record: TerritoryPostClaimBootstrapMemory,
  room: Room | undefined
): Id<StructureController> | undefined {
  const controllerId = record.controllerId ?? room?.controller?.id;
  return typeof controllerId === 'string' && controllerId.length > 0
    ? (controllerId as Id<StructureController>)
    : undefined;
}

function shouldSpawnPostClaimEnergyHauler(
  room: Room | undefined,
  counts: PostClaimControllerSustainCounts,
  workerTarget: number
): boolean {
  return (
    counts.haulers < POST_CLAIM_SUSTAIN_HAULER_TARGET &&
    counts.workers < workerTarget &&
    (room === undefined || isClaimedRoomEnergyInsufficient(room))
  );
}

function isClaimedRoomEnergyInsufficient(room: Room | undefined): boolean {
  if (!room) {
    return true;
  }

  const energyAvailable = room.energyAvailable;
  return typeof energyAvailable !== 'number' || energyAvailable < POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY;
}

function planDefenseSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    !context.survival.hostilePresence ||
    (context.roleCounts.defender ?? 0) > 0 ||
    hasDefenseTowerRefillDemand(context.colony.room)
  ) {
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

function hasDefenseTowerRefillDemand(room: Room): boolean {
  const findMyStructures = getGlobalNumber('FIND_MY_STRUCTURES');
  if (findMyStructures === undefined || typeof room.find !== 'function') {
    return false;
  }

  const structures = room.find(findMyStructures as FindConstant) as AnyOwnedStructure[];
  return structures.some((structure) => isTowerStructure(structure) && isTowerBelowDefenseRefillFloor(structure));
}

function isTowerStructure(structure: AnyOwnedStructure): structure is StructureTower {
  const towerType = (globalThis as { STRUCTURE_TOWER?: StructureConstant }).STRUCTURE_TOWER ?? 'tower';
  return structure.structureType === towerType || structure.structureType === 'tower';
}

function isTowerBelowDefenseRefillFloor(tower: StructureTower): boolean {
  const usedEnergy = getStoredEnergy(tower);
  if (usedEnergy !== null) {
    return usedEnergy < DEFENSE_TOWER_REFILL_ENERGY_FLOOR;
  }

  return getFreeEnergyCapacity(tower) > 0;
}

function planRemoteEconomySpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.options.workersOnly ||
    context.survival.mode !== 'TERRITORY_READY' ||
    context.workerCapacity < context.workerTarget ||
    context.colony.energyAvailable < context.colony.energyCapacityAvailable
  ) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const remoteHarvesterAssignment = selectRemoteHarvesterAssignment(context.colony.room.name);
  if (remoteHarvesterAssignment) {
    const body = buildRemoteHarvesterBody(context.colony.energyAvailable);
    if (body.length > 0) {
      return {
        spawn,
        body,
        name: appendSpawnNameSuffix(
          `${REMOTE_HARVESTER_ROLE}-${context.colony.room.name}-${remoteHarvesterAssignment.targetRoom}-${remoteHarvesterAssignment.sourceId}-${context.gameTime}`,
          context.options
        ),
        memory: {
          role: REMOTE_HARVESTER_ROLE,
          colony: context.colony.room.name,
          remoteHarvester: {
            homeRoom: remoteHarvesterAssignment.homeRoom,
            targetRoom: remoteHarvesterAssignment.targetRoom,
            sourceId: remoteHarvesterAssignment.sourceId,
            containerId: remoteHarvesterAssignment.containerId
          }
        }
      };
    }
  }

  const remoteHaulerAssignment = selectRemoteHaulerAssignment(context.colony.room.name);
  if (!remoteHaulerAssignment) {
    return null;
  }

  const body = buildRemoteHaulerBody(context.colony.energyAvailable, remoteHaulerAssignment.routeDistance);
  if (body.length === 0) {
    return null;
  }

  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(
      `${HAULER_ROLE}-${context.colony.room.name}-${remoteHaulerAssignment.targetRoom}-${remoteHaulerAssignment.containerId}-${context.gameTime}`,
      context.options
    ),
    memory: {
      role: HAULER_ROLE,
      colony: context.colony.room.name,
      remoteHauler: {
        homeRoom: remoteHaulerAssignment.homeRoom,
        targetRoom: remoteHaulerAssignment.targetRoom,
        sourceId: remoteHaulerAssignment.sourceId,
        containerId: remoteHaulerAssignment.containerId
      }
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

function planMultiRoomControllerUpgradeSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.options.workersOnly ||
    context.territoryIntentPending ||
    context.survival.mode !== 'TERRITORY_READY' ||
    hasControllerUpgradeBlockingTerritoryWork(context.colony) ||
    context.workerCapacity < context.workerTarget ||
    context.colony.energyAvailable < context.colony.energyCapacityAvailable
  ) {
    return null;
  }

  const upgradePlans = selectMultiRoomUpgradePlans(context.colony);
  if (upgradePlans.length === 0) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  for (const upgradePlan of upgradePlans) {
    const body = buildMultiRoomUpgraderBody(context.colony.energyAvailable, upgradePlan);
    if (body.length === 0) {
      continue;
    }

    return {
      spawn,
      body,
      name: appendSpawnNameSuffix(
        `worker-${context.colony.room.name}-${upgradePlan.targetRoom}-multiroom-upgrader-${context.gameTime}`,
        context.options
      ),
      memory: buildMultiRoomUpgraderMemory(upgradePlan)
    };
  }

  return null;
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
    if (typeof intent !== 'object' || intent === null) {
      return false;
    }

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
    if (typeof target !== 'object' || target === null) {
      return false;
    }

    if (
      target.colony !== colony.room.name ||
      target.enabled === false ||
      (target.action !== 'claim' && target.action !== 'reserve')
    ) {
      return false;
    }

    if (typeof target.roomName !== 'string' || target.roomName.length === 0) {
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
  return planWorkerSpawnWithBody(colony, selectWorkerBody(colony, roleCounts), gameTime, options);
}

function planWorkerSpawnWithBody(
  colony: ColonySnapshot,
  body: BodyPartConstant[],
  gameTime: number,
  options: SpawnPlanningOptions
): SpawnRequest | null {
  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

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
  if (shouldUseSourceHarvesterBody(colony, roleCounts)) {
    const sourceDistance = estimateLocalSourceDistance(colony);
    const fullCapacityBody = generateHarvesterBody(colony.energyCapacityAvailable, sourceDistance);
    if (canAffordBody(fullCapacityBody, colony.energyAvailable)) {
      return fullCapacityBody;
    }

    return generateHarvesterBody(colony.energyAvailable, sourceDistance);
  }

  const controllerLevel = colony.room.controller?.level;
  const normalBody = buildWorkerBody(colony.energyCapacityAvailable, controllerLevel);
  if (canAffordBody(normalBody, colony.energyAvailable)) {
    return normalBody;
  }

  if (roleCounts.worker === 0) {
    return buildEmergencyWorkerBody(colony.energyAvailable);
  }

  return buildWorkerBody(colony.energyAvailable, controllerLevel);
}

export function generateHarvesterBody(
  availableEnergy: number,
  sourceDistance: number
): BodyPartConstant[] {
  const energyBudget = normalizeNonNegativeInteger(availableEnergy);
  const workParts = selectHarvesterWorkParts(energyBudget);
  if (workParts <= 0) {
    return [];
  }

  const carryTarget = getHarvesterCarryTarget(workParts, sourceDistance);
  const carryParts = selectHarvesterCarryParts(energyBudget, workParts, carryTarget);
  return buildHarvesterBody(workParts, carryParts);
}

function selectHarvesterWorkParts(availableEnergy: number): number {
  for (let workParts = HARVESTER_FULL_EXTRACTION_WORK_PARTS; workParts >= 1; workParts -= 1) {
    if (getHarvesterBodyCost(workParts, 1) <= availableEnergy) {
      return workParts;
    }
  }

  return 0;
}

function selectHarvesterCarryParts(
  availableEnergy: number,
  workParts: number,
  carryTarget: number
): number {
  let carryParts = 1;
  while (
    carryParts < carryTarget &&
    getHarvesterBodyPartCount(workParts, carryParts + 1) <= MAX_CREEP_PARTS &&
    getHarvesterBodyCost(workParts, carryParts + 1) <= availableEnergy
  ) {
    carryParts += 1;
  }

  return carryParts;
}

function buildHarvesterBody(workParts: number, carryParts: number): BodyPartConstant[] {
  const moveParts = workParts + carryParts;
  return [
    ...Array.from({ length: workParts }, () => 'work' as BodyPartConstant),
    ...Array.from({ length: carryParts }, () => 'carry' as BodyPartConstant),
    ...Array.from({ length: moveParts }, () => 'move' as BodyPartConstant)
  ];
}

function getHarvesterCarryTarget(workParts: number, sourceDistance: number): number {
  const roundTripTicks = Math.max(1, normalizeNonNegativeInteger(sourceDistance) * 2);
  const harvestedEnergyBetweenTrips = workParts * HARVEST_POWER_PER_WORK_PART * roundTripTicks;
  return Math.max(1, Math.ceil(harvestedEnergyBetweenTrips / CARRY_CAPACITY_PER_PART));
}

function getHarvesterBodyCost(workParts: number, carryParts: number): number {
  return getBodyCost(buildHarvesterBody(workParts, carryParts));
}

function getHarvesterBodyPartCount(workParts: number, carryParts: number): number {
  return workParts + carryParts + workParts + carryParts;
}

function shouldUseSourceHarvesterBody(colony: ColonySnapshot, roleCounts: RoleCounts): boolean {
  const sourceAwareWorkerTarget = getSourceAwareWorkerTarget(colony.room);
  const workerCapacity = getWorkerCapacity(roleCounts);
  return (
    sourceAwareWorkerTarget > LOCAL_SUPPORT_WORKER_FLOOR &&
    workerCapacity >= LOCAL_SUPPORT_WORKER_FLOOR &&
    workerCapacity < sourceAwareWorkerTarget
  );
}

function getSourceAwareWorkerTarget(room: Room): number {
  return getSourceCount(room) * 2;
}

function estimateLocalSourceDistance(colony: ColonySnapshot): number {
  const spawnPositions = colony.spawns
    .map((spawn) => spawn.pos)
    .filter((pos): pos is RoomPosition => pos !== undefined);
  const sourcePositions = getRoomSources(colony.room)
    .map((source) => source.pos)
    .filter((pos): pos is RoomPosition => pos !== undefined);
  if (spawnPositions.length === 0 || sourcePositions.length === 0) {
    return 1;
  }

  const distances = sourcePositions.flatMap((sourcePos) =>
    spawnPositions.map((spawnPos) => getApproximateRange(sourcePos, spawnPos))
  );
  if (distances.length === 0) {
    return 1;
  }

  return Math.ceil(distances.reduce((total, distance) => total + distance, 0) / distances.length);
}

function getApproximateRange(left: RoomPosition, right: RoomPosition): number {
  if (left.roomName !== right.roomName) {
    return 50;
  }

  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
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

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function getStoredEnergy(structure: { store?: StoreDefinition }): number | null {
  const resourceEnergy = (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy';
  const getUsedCapacity = structure.store?.getUsedCapacity;
  if (typeof getUsedCapacity !== 'function') {
    return null;
  }

  const usedCapacity = getUsedCapacity.call(structure.store, resourceEnergy);
  return typeof usedCapacity === 'number' && Number.isFinite(usedCapacity) ? Math.max(0, usedCapacity) : null;
}

function getFreeEnergyCapacity(structure: { store?: StoreDefinition }): number {
  const resourceEnergy = (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy';
  const getFreeCapacity = structure.store?.getFreeCapacity;
  if (typeof getFreeCapacity !== 'function') {
    return 0;
  }

  const freeCapacity = getFreeCapacity.call(structure.store, resourceEnergy);
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}
