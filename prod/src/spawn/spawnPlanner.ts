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
import { countCreepsByRole, getWorkerCapacity, type RoleCounts } from '../creeps/roleCounts';
import {
  REMOTE_HARVESTER_ROLE,
  selectRemoteHarvesterAssignment
} from '../creeps/remoteHarvester';
import {
  buildSourceHarvesterBody,
  selectSourceHarvesterAssignment,
  SOURCE_HARVESTER_ROLE
} from '../creeps/sourceHarvester';
import {
  HAULER_ROLE,
  selectRemoteHaulerAssignment
} from '../creeps/hauler';
import {
  DEFENDER_ROLE,
  getDesiredDefenderCount,
  hasControllerAttackPressure,
  planDefenderSpawn
} from '../defense/defensePlanner';
import { selectRuntimePolicyObjectiveDefenseTarget } from '../strategy/runtimePolicyParameters';
import {
  selectDynamicCreepBody,
  type DynamicCreepBodyDemand,
  type SpawnBufferBudgetPolicy
} from '../economy/creepBodyScaling';
import { buildScaledWorkerBody } from '../economy/worker-body-scaling';
import {
  buildEnergyHaulerBody,
  selectEnergyHaulerSpawnDemand
} from '../economy/energyHauling';
import { getEnergyReservationScore } from '../economy/energyReservation';
import { getMultiRoomEnergyRoomState } from '../economy/multiRoomEnergy';
import { getReservedSpawnEnergy } from '../economy/spawnEnergyReservation';
import {
  buildRemoteHarvesterBody,
  buildRemoteHaulerBody,
  buildTerritoryControllerBody,
  buildTerritoryControllerPressureBody,
  buildTerritoryReserverBody,
  buildUpgraderBody,
  getBodyCost,
  TERRITORY_SCOUT_BODY,
  TERRITORY_SCOUT_BODY_COST
} from './bodyBuilder';
import {
  buildTerritoryCreepMemory,
  getTerritoryIntentRouteDistance,
  getTerritoryFollowUpPreparationWorkerDemand,
  planTerritoryIntent,
  recordRecoveredTerritoryFollowUpRetryCooldown,
  requiresTerritoryControllerPressure,
  shouldSpawnTerritoryControllerCreep,
  TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND,
  type TerritoryIntentPlan,
  type TerritoryIntentPlanningOptions
} from '../territory/territoryPlanner';
import {
  buildMultiRoomUpgraderBody,
  buildMultiRoomUpgraderMemory,
  selectMultiRoomUpgradePlans
} from '../territory/multiRoomUpgrader';
import { NEXT_EXPANSION_TARGET_CREATOR } from '../territory/expansionScoring';
import {
  getPassiveScoutOnlyTargetRooms,
  isPassiveScoutGateOpen
} from '../territory/passiveScoutGate';
import {
  buildControllerUpgradeCreepMemory,
  selectControllerUpgradeSpawnDemand
} from '../territory/controllerManager';
import { isLiveTransferCandidate } from '../economy/crossRoomHauler';
import { UPGRADER_ROLE } from '../creeps/upgraderRunner';
import {
  buildSeasonScoreCollectorMemory,
  recordSeasonScoreCollectorSpawnBlocker,
  SCORE_COLLECTOR_ROLE,
  selectSeasonScoreCollectorSpawnDemand
} from '../season/scoreCollection';

type SpawnPriorityTier =
  | 'emergencyBootstrap'
  | 'localSourceMining'
  | 'defense'
  | 'localRefillSurvival'
  | 'localEnergyHauling'
  | 'controllerDowngradeGuard'
  | 'postClaimControllerSustain'
  | 'remoteEconomy'
  | 'territoryRemote'
  | 'controllerUpgradeDemand'
  | 'multiRoomControllerUpgrade'
  | 'seasonScoreCollector'
  | 'controllerUpgradeSurplus';

export type SpawnQueueRolePriority = 'critical' | 'high' | 'normal' | 'low';

export interface SpawnQueuePriorityCandidate {
  enqueueOrder: number;
  priority: SpawnQueueRolePriority;
}

interface SpawnQueueDefinition {
  tier: SpawnPriorityTier;
  getPriority: (context: SpawnPlanningContext) => SpawnQueueRolePriority;
}

interface SpawnQueueEntry extends SpawnQueuePriorityCandidate {
  tier: SpawnPriorityTier;
}

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

interface LocalSourceHarvesterSpawnTarget {
  spawn: StructureSpawn;
  assignment: CreepSourceHarvesterMemory;
  sourceDistance: number;
  sourceEnergyCapacity?: number;
}

export interface SpawnRequest {
  spawn: StructureSpawn;
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}
export type SpawnPlan = SpawnRequest;

export interface SpawnPlanningOptions {
  nameSuffix?: string;
  workersOnly?: boolean;
  allowTerritoryControllerPressure?: boolean;
  allowTerritoryFollowUp?: boolean;
  controllerUpgradeTargetRoom?: string | null;
  controllerUpgradeTargetRooms?: readonly string[] | null;
}

export interface SpawnEnergyForecast {
  roomName: string;
  energyAvailable: number;
  incomingEnergy: number;
  outgoingEnergy: number;
  reservedEnergy: number;
  effectiveEnergyAvailable: number;
  localProductionEnergyPerTick: number;
  localConsumptionEnergyPerTick: number;
  netLocalEnergyPerTick: number;
  deficitEnergy: number;
  surplusEnergy: number;
}

export type SpawnPlanningEnergyGate = 'critical' | 'recovery' | 'ready' | 'full';

export type SpawnPlanningRoomPriority =
  | 'emergencyBootstrap'
  | 'defense'
  | 'controllerDowngradeGuard'
  | 'localWorkerRecovery'
  | 'stableWork'
  | 'surplusWork';

export interface RoomCreepBudget {
  roomName: string;
  constructionSiteCount: number;
  controllerLevel: number;
  energyAvailable: number;
  energyCapacityAvailable: number;
  effectiveEnergyAvailable: number;
  localProductionEnergyPerTick: number;
  localConsumptionEnergyPerTick: number;
  netLocalEnergyPerTick: number;
  deficitEnergy: number;
  surplusEnergy: number;
  energyGate: SpawnPlanningEnergyGate;
  ownedSpawnCount: number;
  idleSpawnCount: number;
  workerCapacity: number;
  workerTarget: number;
  workerDeficit: number;
  priority: SpawnPlanningRoomPriority;
  reservedSpawnEnergy: number;
  sourceCount: number;
}

export interface SpawnEnergyReservationCandidate {
  bodyCost: number;
  creepName: string;
  role: string;
}

export type SpawnPlanningRoleCountsByRoom =
  | ReadonlyMap<string, RoleCounts>
  | Readonly<Record<string, RoleCounts>>;

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
const LOW_ENERGY_NON_CRITICAL_DEFER_RATIO = 0.5;
const SPAWN_QUEUE: SpawnQueueDefinition[] = [
  { tier: 'emergencyBootstrap', getPriority: () => 'critical' },
  { tier: 'defense', getPriority: getDefenseSpawnQueuePriority },
  { tier: 'localSourceMining', getPriority: getLocalSourceMiningSpawnQueuePriority },
  { tier: 'controllerDowngradeGuard', getPriority: () => 'critical' },
  { tier: 'localEnergyHauling', getPriority: getLocalEnergyHaulingSpawnQueuePriority },
  { tier: 'territoryRemote', getPriority: getTerritoryRemoteSpawnQueuePriority },
  { tier: 'remoteEconomy', getPriority: getRemoteEconomySpawnQueuePriority },
  { tier: 'localRefillSurvival', getPriority: getLocalRefillSurvivalSpawnQueuePriority },
  { tier: 'postClaimControllerSustain', getPriority: getPostClaimControllerSustainSpawnQueuePriority },
  { tier: 'controllerUpgradeDemand', getPriority: () => 'normal' },
  { tier: 'multiRoomControllerUpgrade', getPriority: () => 'normal' },
  { tier: 'seasonScoreCollector', getPriority: () => 'low' }
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

  for (const entry of buildSpawnQueue(context)) {
    const deferredForLowEnergy = shouldDeferSpawnQueueEntryForLowEnergy(entry, context);
    if (deferredForLowEnergy && entry.tier !== 'territoryRemote') {
      continue;
    }

    const request = planSpawnForPriorityTier(entry.tier, context);
    if (request) {
      return deferredForLowEnergy ? null : request;
    }
  }

  return null;
}

export function orderColoniesForSpawnPlanning(
  colonies: ColonySnapshot[],
  roleCountsByRoom?: SpawnPlanningRoleCountsByRoom
): ColonySnapshot[] {
  return [...colonies].sort((left, right) =>
    compareColoniesForSpawnPlanning(left, right, roleCountsByRoom)
  );
}

export function sortSpawnQueueByRolePriority<T extends SpawnQueuePriorityCandidate>(queue: readonly T[]): T[] {
  return [...queue].sort(compareSpawnQueuePriorityCandidates);
}

export function getSpawnEnergyForecast(colony: ColonySnapshot): SpawnEnergyForecast {
  const transferForecast = getRoomPlannedTransferEnergy(colony.room.name);
  const multiRoomEnergy = getMultiRoomEnergyRoomState(colony.room.name);
  const energyAvailable = normalizeNonNegativeInteger(colony.energyAvailable);
  const reservedEnergy = getReservedSpawnEnergy(colony.room.name);

  return {
    roomName: colony.room.name,
    energyAvailable,
    incomingEnergy: transferForecast.incomingEnergy,
    outgoingEnergy: transferForecast.outgoingEnergy,
    reservedEnergy,
    effectiveEnergyAvailable: Math.max(
      0,
      energyAvailable + transferForecast.incomingEnergy - transferForecast.outgoingEnergy - reservedEnergy
    ),
    localProductionEnergyPerTick: multiRoomEnergy?.localProductionEnergyPerTick ?? 0,
    localConsumptionEnergyPerTick: multiRoomEnergy?.localConsumptionEnergyPerTick ?? 0,
    netLocalEnergyPerTick: multiRoomEnergy?.netLocalEnergyPerTick ?? 0,
    deficitEnergy: multiRoomEnergy?.deficitEnergy ?? 0,
    surplusEnergy: multiRoomEnergy?.surplusEnergy ?? 0
  };
}

export function getRoomPlannedTransferEnergy(roomName: string): Pick<
  SpawnEnergyForecast,
  'incomingEnergy' | 'outgoingEnergy'
> {
  const balance = getStorageBalanceMemory();
  const transfers = Array.isArray(balance?.transfers) ? balance.transfers : [];
  const incomingEnergy = transfers
    .filter((transfer) => transfer.targetRoom === roomName)
    .reduce((total, transfer) => total + normalizeNonNegativeInteger(transfer.amount), 0);
  const outgoingEnergy = transfers
    .filter((transfer) => transfer.sourceRoom === roomName)
    .reduce((total, transfer) => total + normalizeNonNegativeInteger(transfer.amount), 0);

  return { incomingEnergy, outgoingEnergy };
}

export function planSpawnEnergyReservationCandidate(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  gameTime: number,
  options: SpawnPlanningOptions = {}
): SpawnEnergyReservationCandidate | null {
  const forecastColony = createSpawnEnergyReservationForecastColony(colony);
  const request = planSpawn(forecastColony, roleCounts, gameTime, options);
  if (!request) {
    return null;
  }

  const bodyCost = getBodyCost(request.body);
  if (bodyCost <= 0) {
    return null;
  }

  return {
    bodyCost,
    creepName: request.name,
    role: String(request.memory.role)
  };
}

function createSpawnEnergyReservationForecastColony(colony: ColonySnapshot): ColonySnapshot {
  const energyCapacityAvailable = normalizeNonNegativeInteger(colony.energyCapacityAvailable);
  const energyBudget = getSpawnEnergyReservationForecastBudget(colony, energyCapacityAvailable);

  return {
    ...colony,
    energyAvailable: energyBudget,
    energyCapacityAvailable,
    spawnEnergyBudget: energyBudget,
    spawns: colony.spawns.map(createIdleSpawnForReservationPlanning)
  };
}

function getSpawnEnergyReservationForecastBudget(
  colony: ColonySnapshot,
  energyCapacityAvailable: number
): number {
  return energyCapacityAvailable > 0
    ? energyCapacityAvailable
    : normalizeNonNegativeInteger(colony.energyAvailable);
}

function createIdleSpawnForReservationPlanning(spawn: StructureSpawn): StructureSpawn {
  const planningSpawn = Object.create(spawn) as StructureSpawn & { spawning: Spawning | null };
  Object.defineProperty(planningSpawn, 'spawning', {
    configurable: true,
    enumerable: true,
    value: null
  });
  return planningSpawn;
}

export function shouldSuppressWorkerSpawnForCrossRoomImport(colony: ColonySnapshot): boolean {
  const balance = getStorageBalanceMemory();
  if (!balance) {
    return false;
  }

  const roomBalance = balance?.rooms?.[colony.room.name];
  if (roomBalance?.mode !== 'import') {
    return false;
  }

  return (balance?.transfers ?? []).some(
    (transfer) =>
      transfer.targetRoom === colony.room.name &&
      transfer.amount > 0 &&
      isLiveTransferCandidate(transfer)
  );
}

export function getRoomCreepBudget(
  colony: ColonySnapshot,
  roleCounts: RoleCounts
): RoomCreepBudget {
  const forecast = getSpawnEnergyForecast(colony);
  const survival = assessColonySnapshotSurvival(colony, roleCounts);
  const workerTarget = getWorkerTarget(colony, roleCounts);
  const workerCapacity = getWorkerCapacity(roleCounts);
  const workerDeficit = Math.max(0, workerTarget - workerCapacity);

  return {
    roomName: colony.room.name,
    constructionSiteCount: getVisibleConstructionSiteCount(colony.room),
    controllerLevel: getControllerLevel(colony.room.controller),
    energyAvailable: normalizeNonNegativeInteger(colony.energyAvailable),
    energyCapacityAvailable: normalizeNonNegativeInteger(colony.energyCapacityAvailable),
    effectiveEnergyAvailable: forecast.effectiveEnergyAvailable,
    localProductionEnergyPerTick: forecast.localProductionEnergyPerTick,
    localConsumptionEnergyPerTick: forecast.localConsumptionEnergyPerTick,
    netLocalEnergyPerTick: forecast.netLocalEnergyPerTick,
    deficitEnergy: forecast.deficitEnergy,
    surplusEnergy: forecast.surplusEnergy,
    energyGate: getSpawnPlanningEnergyGate(forecast.effectiveEnergyAvailable, colony.energyCapacityAvailable),
    ownedSpawnCount: colony.spawns.length,
    idleSpawnCount: colony.spawns.filter((spawn) => !spawn.spawning).length,
    workerCapacity,
    workerTarget,
    workerDeficit,
    priority: selectRoomSpawnPriority(survival, workerDeficit),
    reservedSpawnEnergy: forecast.reservedEnergy,
    sourceCount: getSourceCount(colony.room)
  };
}

function buildSpawnQueue(context: SpawnPlanningContext): SpawnQueueEntry[] {
  return sortSpawnQueueByRolePriority(
    SPAWN_QUEUE.map((definition, enqueueOrder) => ({
      tier: definition.tier,
      priority: definition.getPriority(context),
      enqueueOrder
    }))
  );
}

function compareSpawnQueuePriorityCandidates(
  left: SpawnQueuePriorityCandidate,
  right: SpawnQueuePriorityCandidate
): number {
  return (
    getSpawnQueueRolePriorityRank(left.priority) - getSpawnQueueRolePriorityRank(right.priority) ||
    left.enqueueOrder - right.enqueueOrder
  );
}

function getSpawnQueueRolePriorityRank(priority: SpawnQueueRolePriority): number {
  switch (priority) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'normal':
      return 2;
    case 'low':
      return 3;
  }
}

function getDefenseSpawnQueuePriority(context: SpawnPlanningContext): SpawnQueueRolePriority {
  return context.survival.hostilePresence ||
    hasOwnedRoomHostilePresence() ||
    hasControllerAttackPressure(context.colony.room.controller) ||
    selectPostClaimControllerDefensePlan(context.colony) ||
    hasRuntimePolicyObjectiveDefenseSpawnDemand(context)
    ? 'critical'
    : 'normal';
}

function getLocalSourceMiningSpawnQueuePriority(context: SpawnPlanningContext): SpawnQueueRolePriority {
  return hasLocalSourceHarvesterShortfall(context) ? 'critical' : 'high';
}

function getLocalEnergyHaulingSpawnQueuePriority(context: SpawnPlanningContext): SpawnQueueRolePriority {
  const demand = selectEnergyHaulerSpawnDemand(context.colony.room);
  return demand && demand.activeHaulers <= 0 ? 'high' : 'normal';
}

function getLocalRefillSurvivalSpawnQueuePriority(context: SpawnPlanningContext): SpawnQueueRolePriority {
  return hasLocalSupportWorkerShortfall(context) ? 'critical' : 'normal';
}

function getPostClaimControllerSustainSpawnQueuePriority(context: SpawnPlanningContext): SpawnQueueRolePriority {
  return hasPostClaimSustainLocalWorkerFloor(context) &&
    context.survival.hostilePresence !== true &&
    context.survival.controllerDowngradeGuard !== true &&
    selectPostClaimControllerSustainPlan(context.colony) !== null
    ? 'critical'
    : 'normal';
}

function getTerritoryRemoteSpawnQueuePriority(context: SpawnPlanningContext): SpawnQueueRolePriority {
  return hasExpansionClaimSpawnDemand(context.colony.room.name) ? 'high' : 'low';
}

function getRemoteEconomySpawnQueuePriority(context: SpawnPlanningContext): SpawnQueueRolePriority {
  return context.options.allowTerritoryFollowUp === true ? 'low' : 'high';
}

function shouldDeferSpawnQueueEntryForLowEnergy(
  entry: SpawnQueueEntry,
  context: SpawnPlanningContext
): boolean {
  return (
    isLowSpawnEnergy(context.colony) &&
    entry.priority !== 'critical' &&
    !isEmergencyLocalRefillSurvivalEntry(entry, context)
  );
}

function isLowSpawnEnergy(colony: ColonySnapshot): boolean {
  const energyAvailable = normalizeNonNegativeInteger(colony.energyAvailable);
  const energyCapacityAvailable = normalizeNonNegativeInteger(colony.energyCapacityAvailable);
  return (
    energyCapacityAvailable > 0 &&
    energyAvailable < energyCapacityAvailable * LOW_ENERGY_NON_CRITICAL_DEFER_RATIO
  );
}

function isEmergencyLocalRefillSurvivalEntry(
  entry: SpawnQueueEntry,
  context: SpawnPlanningContext
): boolean {
  return (
    entry.tier === 'localRefillSurvival' &&
    (hasLocalSupportWorkerShortfall(context) ||
      context.workerCapacity < context.survival.survivalWorkerFloor ||
      context.survival.bootstrapRecovery)
  );
}

function hasLocalSourceHarvesterShortfall(context: SpawnPlanningContext): boolean {
  return (
    context.options.workersOnly !== true &&
    context.survival.hostilePresence !== true &&
    context.survival.controllerDowngradeGuard !== true &&
    context.colony.room.controller?.my === true &&
    (context.colony.room.controller.level ?? 0) >= 2 &&
    context.roleCounts.worker >= LOCAL_SUPPORT_WORKER_FLOOR &&
    normalizeNonNegativeInteger(context.roleCounts.sourceHarvester ?? 0) < getSourceCount(context.colony.room)
  );
}

function hasOwnedRoomHostilePresence(): boolean {
  const rooms = (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms;
  if (!rooms) {
    return false;
  }

  return Object.values(rooms).some(
    (room) => room?.controller?.my === true && getRoomHostileCreepCount(room) > 0
  );
}

function planSpawnForPriorityTier(
  tier: SpawnPriorityTier,
  context: SpawnPlanningContext
): SpawnRequest | null {
  switch (tier) {
    case 'emergencyBootstrap':
      return planEmergencyBootstrapSpawn(context);
    case 'localSourceMining':
      return planLocalSourceMiningSpawn(context);
    case 'localRefillSurvival':
      return planLocalSurvivalSpawn(context);
    case 'localEnergyHauling':
      return planLocalEnergyHaulingSpawn(context);
    case 'controllerDowngradeGuard':
      return planControllerDowngradeGuardSpawn(context);
    case 'postClaimControllerSustain':
      return planPostClaimControllerSustainSpawn(context);
    case 'remoteEconomy':
      return planRemoteEconomySpawn(context);
    case 'defense':
      return planDefenseSpawnForContext(context);
    case 'territoryRemote':
      return planTerritoryRemoteSpawn(context);
    case 'controllerUpgradeDemand':
      return planControllerUpgradeDemandSpawn(context);
    case 'multiRoomControllerUpgrade':
      return planMultiRoomControllerUpgradeSpawn(context);
    case 'seasonScoreCollector':
      return planSeasonScoreCollectorSpawn(context);
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
  const localSupportWorkerShortfall = hasLocalSupportWorkerShortfall(context);
  if (
    (!localSupportWorkerShortfall && context.workerCapacity >= context.workerTarget) ||
    !hasRecoveryWorkerSpawnEnergy(context.colony) ||
    (context.workerCapacity > 0 && shouldSuppressWorkerSpawnForCrossRoomImport(context.colony))
  ) {
    return null;
  }

  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}

function hasLocalSupportWorkerShortfall(context: SpawnPlanningContext): boolean {
  return (
    context.roleCounts.worker < getLocalSupportWorkerFloor(context) &&
    hasLocalSupportWorkerDemand(context)
  );
}

function getLocalSupportWorkerFloor(context: SpawnPlanningContext): number {
  if (context.workerTarget <= 0) {
    return 0;
  }

  return Math.min(LOCAL_SUPPORT_WORKER_FLOOR, context.workerTarget);
}

function hasLocalSupportWorkerDemand(context: SpawnPlanningContext): boolean {
  return (
    context.colony.room.controller?.my === true &&
    !context.survival.hostilePresence &&
    !context.survival.controllerDowngradeGuard &&
    (context.survival.mode === 'BOOTSTRAP' ||
      getVisibleConstructionSiteCount(context.colony.room) > 0 ||
      hasSpawnExtensionRefillDemand(context.colony))
  );
}

function hasSpawnExtensionRefillDemand(colony: ColonySnapshot): boolean {
  return (
    normalizeNonNegativeInteger(colony.energyCapacityAvailable) > 0 &&
    normalizeNonNegativeInteger(colony.energyAvailable) < normalizeNonNegativeInteger(colony.energyCapacityAvailable)
  );
}

function planLocalEnergyHaulingSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.options.workersOnly ||
    context.workerCapacity <= 0
  ) {
    return null;
  }

  const demand = selectEnergyHaulerSpawnDemand(context.colony.room);
  if (!demand) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = selectDynamicBodyForColony(
    context.colony,
    HAULER_ROLE,
    'standard',
    (energyBudget) => buildEnergyHaulerBody(Math.min(energyBudget, context.colony.energyCapacityAvailable))
  );
  if (body.length === 0) {
    return null;
  }

  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(
      `${HAULER_ROLE}-${context.colony.room.name}-energy-${context.gameTime}`,
      context.options
    ),
    memory: {
      role: HAULER_ROLE,
      colony: context.colony.room.name,
      energyHauler: {
        roomName: demand.roomName
      }
    }
  };
}

function planLocalSourceMiningSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.options.workersOnly ||
    context.survival.hostilePresence ||
    context.survival.controllerDowngradeGuard ||
    context.colony.room.controller?.my !== true ||
    (context.colony.room.controller.level ?? 0) < 2 ||
    context.roleCounts.worker < LOCAL_SUPPORT_WORKER_FLOOR
  ) {
    return null;
  }

  const target = selectLocalSourceHarvesterSpawnTarget(context.colony);
  if (!target) {
    return null;
  }

  const body = selectDynamicBodyForColony(
    context.colony,
    SOURCE_HARVESTER_ROLE,
    context.workerCapacity < context.workerTarget ? 'recovery' : 'surplus',
    (energyBudget) =>
      buildSourceHarvesterBody(energyBudget, {
        sourceDistance: target.sourceDistance,
        sourceEnergyCapacity: target.sourceEnergyCapacity
      })
  );
  if (body.length === 0) {
    return null;
  }

  return {
    spawn: target.spawn,
    body,
    name: appendSpawnNameSuffix(
      `${SOURCE_HARVESTER_ROLE}-${context.colony.room.name}-${target.assignment.sourceId}-${context.gameTime}`,
      context.options
    ),
    memory: {
      role: SOURCE_HARVESTER_ROLE,
      colony: context.colony.room.name,
      sourceHarvester: target.assignment
    }
  };
}

function selectLocalSourceHarvesterSpawnTarget(colony: ColonySnapshot): LocalSourceHarvesterSpawnTarget | null {
  const idleSpawns = colony.spawns.filter((candidate) => !candidate.spawning);
  if (idleSpawns.length === 0) {
    return null;
  }

  const sourcesById = new Map(getRoomSources(colony.room).map((source) => [String(source.id), source] as const));
  const candidates = idleSpawns.flatMap((spawn) => {
    const assignment = selectSourceHarvesterAssignment(colony.room, { origin: spawn.pos });
    if (!assignment) {
      return [];
    }

    const source = sourcesById.get(String(assignment.sourceId));
    return [
      {
        spawn,
        assignment,
        sourceDistance: estimateSpawnToSourceDistance(spawn, source),
        sourceEnergyCapacity: getSourceEnergyCapacity(source)
      }
    ];
  });

  return candidates.sort(compareLocalSourceHarvesterSpawnTargets)[0] ?? null;
}

function compareLocalSourceHarvesterSpawnTargets(
  left: LocalSourceHarvesterSpawnTarget,
  right: LocalSourceHarvesterSpawnTarget
): number {
  return (
    left.sourceDistance - right.sourceDistance ||
    String(left.spawn.name).localeCompare(String(right.spawn.name)) ||
    String(left.assignment.sourceId).localeCompare(String(right.assignment.sourceId))
  );
}

function estimateSpawnToSourceDistance(spawn: StructureSpawn, source: Source | undefined): number {
  if (!spawn.pos || !source?.pos) {
    return 1;
  }

  return getApproximateRange(spawn.pos, source.pos);
}

function getSourceEnergyCapacity(source: Source | undefined): number | undefined {
  const sourceEnergyCapacity = source?.energyCapacity;
  return typeof sourceEnergyCapacity === 'number' && Number.isFinite(sourceEnergyCapacity) && sourceEnergyCapacity > 0
    ? sourceEnergyCapacity
    : undefined;
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
  return getSpawnEnergyBudget(colony) >= MINIMUM_EMERGENCY_WORKER_BODY_COST;
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
  if (
    !hasPostClaimSustainLocalWorkerFloor(context) ||
    context.survival.hostilePresence ||
    context.survival.controllerDowngradeGuard ||
    !hasPostClaimSustainSpawnEnergy(context.colony)
  ) {
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

function getRoomHostileCreepCount(room: Room): number {
  const findHostiles = getGlobalNumber('FIND_HOSTILE_CREEPS');
  if (findHostiles === undefined || typeof room.find !== 'function') {
    return 0;
  }

  const result = room.find(findHostiles as FindConstant);
  return Array.isArray(result) ? result.length : 0;
}

function getRoomSpawns(room: Room): StructureSpawn[] {
  const game = (globalThis as unknown as { Game?: Partial<Pick<Game, 'spawns'>> }).Game;
  if (!game?.spawns) {
    return [];
  }

  return Object.values(game.spawns).filter((spawn) => spawn.room?.name === room.name);
}

function countActiveRoomDefenders(roomName: string): number {
  const game = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game;
  if (!game?.creeps) {
    return 0;
  }

  return Object.values(game.creeps).filter((creep) => isActiveRoomDefender(creep, roomName)).length;
}

function countAssignedRoomDefenders(roomName: string): number {
  const game = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game;
  if (!game?.creeps) {
    return 0;
  }

  return Object.values(game.creeps).filter((creep) => isAssignedRoomDefender(creep, roomName)).length;
}

function isActiveRoomDefender(creep: Creep, roomName: string): boolean {
  return (
    isAssignedRoomDefender(creep, roomName) &&
    creep.room?.name === roomName &&
    canSatisfyDefenderSpawnCapacity(creep)
  );
}

function hasPostClaimSustainLocalWorkerFloor(context: SpawnPlanningContext): boolean {
  return (
    context.workerCapacity >= context.survival.survivalWorkerFloor &&
    context.workerCapacity >= context.workerTarget
  );
}

function isAssignedRoomDefender(creep: Creep, roomName: string): boolean {
  const assignedRoom = creep.memory.defense?.homeRoom ?? creep.memory.colony;

  return (
    creep.memory.role === DEFENDER_ROLE &&
    assignedRoom === roomName &&
    canSatisfyDefenderSpawnCapacity(creep)
  );
}

function canSatisfyDefenderSpawnCapacity(creep: Creep): boolean {
  return (
    (creep.ticksToLive === undefined || creep.ticksToLive > 100) &&
    hasActiveAttackPart(creep)
  );
}

function hasActiveAttackPart(creep: Creep): boolean {
  const attackPart = getBodyPartConstant('ATTACK', 'attack');
  const activeParts = creep.getActiveBodyparts?.(attackPart);
  if (typeof activeParts === 'number') {
    return activeParts > 0;
  }

  if (!Array.isArray(creep.body)) {
    return false;
  }

  return creep.body.some((part) => part.type === attackPart && part.hits > 0);
}

function getBodyPartConstant(globalName: 'ATTACK', fallback: BodyPartConstant): BodyPartConstant {
  const value = (globalThis as unknown as Partial<Record<'ATTACK', BodyPartConstant>>)[globalName];
  return value ?? fallback;
}

function hasPostClaimSustainSpawnEnergy(colony: ColonySnapshot): boolean {
  return getSpawnEnergyBudget(colony) >= POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY;
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
  const spawnConstructionPending =
    room !== undefined && hasPostClaimSpawnConstructionPending(room.name);
  return (
    counts.haulers < POST_CLAIM_SUSTAIN_HAULER_TARGET &&
    (counts.workers < workerTarget || spawnConstructionPending) &&
    (room === undefined || isClaimedRoomEnergyInsufficient(room) || spawnConstructionPending)
  );
}

function isClaimedRoomEnergyInsufficient(room: Room | undefined): boolean {
  if (!room) {
    return true;
  }

  const energyAvailable = room.energyAvailable;
  return typeof energyAvailable !== 'number' || energyAvailable < POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY;
}

function hasPostClaimSpawnConstructionPending(roomName: string): boolean {
  const record = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps?.[roomName];
  return Boolean(
    record &&
      record.status === 'spawnSitePending' &&
      record.spawnSite?.roomName === roomName &&
      !hasOperationalSpawnInRoom(roomName)
  );
}

export function planDefenseSpawn(room: Room): SpawnPlan | null {
  if (room.controller?.my !== true) {
    return null;
  }

  return planDefenseSpawnForRoom(
    {
      room,
      spawns: getRoomSpawns(room),
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    },
    countActiveRoomDefenders(room.name),
    getGameTime(),
    {}
  );
}

function planDefenseSpawnForContext(context: SpawnPlanningContext): SpawnRequest | null {
  if (context.options.workersOnly) {
    return null;
  }

  if (context.survival.hostilePresence || hasControllerAttackPressure(context.colony.room.controller)) {
    const localDefenseSpawn = planDefenseSpawnForRoom(
      context.colony,
      countActiveRoomDefenders(context.colony.room.name),
      context.gameTime,
      context.options
    );
    if (localDefenseSpawn) {
      return localDefenseSpawn;
    }
  }

  const postClaimDefenseSpawn = planPostClaimControllerDefenseSpawn(context);
  if (postClaimDefenseSpawn) {
    return postClaimDefenseSpawn;
  }

  return planRuntimePolicyObjectiveDefenseSpawn(context);
}

function planRuntimePolicyObjectiveDefenseSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.survival.hostilePresence ||
    context.survival.controllerDowngradeGuard ||
    context.workerCapacity < Math.min(context.workerTarget, LOCAL_SUPPORT_WORKER_FLOOR)
  ) {
    return null;
  }

  const objectiveTarget = selectRuntimePolicyObjectiveDefenseTarget(context.colony.room.name);
  if (!objectiveTarget || objectiveTarget.hostileCreepCount <= 0) {
    return null;
  }

  const assignedDefenders = countAssignedRoomDefenders(objectiveTarget.targetRoom);
  if (assignedDefenders >= getDesiredDefenderCount(objectiveTarget.hostileCreepCount)) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const defenderPlan = planDefenderSpawn({
    roomName: objectiveTarget.targetRoom,
    hostileCreepCount: objectiveTarget.hostileCreepCount,
    activeDefenderCount: assignedDefenders,
    energyAvailable: getSpawnEnergyBudget(context.colony),
    gameTime: context.gameTime,
    nameSuffix: context.options.nameSuffix
  });
  if (!defenderPlan) {
    return null;
  }

  return {
    spawn,
    ...defenderPlan
  };
}

function hasRuntimePolicyObjectiveDefenseSpawnDemand(context: SpawnPlanningContext): boolean {
  if (
    context.survival.hostilePresence ||
    context.survival.controllerDowngradeGuard ||
    context.workerCapacity < Math.min(context.workerTarget, LOCAL_SUPPORT_WORKER_FLOOR)
  ) {
    return false;
  }

  const objectiveTarget = selectRuntimePolicyObjectiveDefenseTarget(context.colony.room.name);
  return (
    objectiveTarget !== null &&
    objectiveTarget.hostileCreepCount > 0 &&
    countAssignedRoomDefenders(objectiveTarget.targetRoom) < getDesiredDefenderCount(objectiveTarget.hostileCreepCount)
  );
}

function planDefenseSpawnForRoom(
  colony: ColonySnapshot,
  activeDefenderCount: number,
  gameTime: number,
  options: SpawnPlanningOptions
): SpawnRequest | null {
  const hostileCount = getRoomHostileCreepCount(colony.room);
  const controllerUnderAttack = hasControllerAttackPressure(colony.room.controller);
  const pressureCount = Math.max(hostileCount, controllerUnderAttack ? 1 : 0);
  if (pressureCount === 0 || activeDefenderCount >= getDesiredDefenderCount(pressureCount)) {
    return null;
  }

  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const defenderPlan = planDefenderSpawn({
    roomName: colony.room.name,
    hostileCreepCount: hostileCount,
    controllerUnderAttack,
    activeDefenderCount,
    energyAvailable: getSpawnEnergyBudget(colony),
    gameTime,
    nameSuffix: options.nameSuffix
  });
  if (!defenderPlan) {
    return null;
  }

  return {
    spawn,
    ...defenderPlan
  };
}

interface PostClaimControllerDefensePlan {
  targetRoom: string;
  hostileCreepCount: number;
  controllerUnderAttack: boolean;
}

function planPostClaimControllerDefenseSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (context.survival.mode === 'BOOTSTRAP') {
    return null;
  }

  const defensePlan = selectPostClaimControllerDefensePlan(context.colony);
  if (!defensePlan) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const defenderPlan = planDefenderSpawn({
    roomName: defensePlan.targetRoom,
    hostileCreepCount: defensePlan.hostileCreepCount,
    controllerUnderAttack: defensePlan.controllerUnderAttack,
    activeDefenderCount: countAssignedRoomDefenders(defensePlan.targetRoom),
    energyAvailable: getSpawnEnergyBudget(context.colony),
    gameTime: context.gameTime,
    nameSuffix: context.options.nameSuffix
  });
  if (!defenderPlan) {
    return null;
  }

  return {
    spawn,
    ...defenderPlan
  };
}

function selectPostClaimControllerDefensePlan(colony: ColonySnapshot): PostClaimControllerDefensePlan | null {
  for (const record of getPostClaimControllerSustainRecords(colony.room.name)) {
    const targetRoom = getVisibleRoom(record.roomName);
    const controllerUnderAttack = hasControllerAttackPressure(targetRoom?.controller);
    if (targetRoom?.controller?.my !== true || !controllerUnderAttack) {
      continue;
    }

    return {
      targetRoom: record.roomName,
      hostileCreepCount: getRoomHostileCreepCount(targetRoom),
      controllerUnderAttack
    };
  }

  return null;
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
    const body = selectDynamicBodyForColony(
      context.colony,
      REMOTE_HARVESTER_ROLE,
      'standard',
      buildRemoteHarvesterBody
    );
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

  const body = selectDynamicBodyForColony(
    context.colony,
    HAULER_ROLE,
    'standard',
    (energyBudget) => buildRemoteHaulerBody(energyBudget, remoteHaulerAssignment.routeDistance)
  );
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
  const planningOptions = getTerritoryIntentPlanningOptions(context);
  if (!planningOptions) {
    return null;
  }

  const territoryIntent = planTerritoryIntent(
    context.colony,
    context.roleCounts,
    context.workerTarget,
    context.gameTime,
    planningOptions
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

function getTerritoryIntentPlanningOptions(
  context: SpawnPlanningContext
): TerritoryIntentPlanningOptions | null {
  if (context.survival.mode === 'TERRITORY_READY') {
    if (
      context.options.workersOnly &&
      context.options.allowTerritoryControllerPressure !== true &&
      context.options.allowTerritoryFollowUp !== true
    ) {
      return null;
    }

    return {
      controllerPressureOnly:
        context.options.workersOnly === true &&
        context.options.allowTerritoryControllerPressure === true,
      followUpOnly:
        context.options.workersOnly === true &&
        context.options.allowTerritoryFollowUp === true
    };
  }

  if (!shouldPlanLocalStableTerritoryScout(context)) {
    return null;
  }

  const blockedScoutTargetRooms = getClosedPassiveScoutOnlyTargetRooms(context);
  return {
    scoutOnly: true,
    ...(blockedScoutTargetRooms.length > 0 ? { blockedScoutTargetRooms } : {})
  };
}

function shouldPlanLocalStableTerritoryScout(context: SpawnPlanningContext): boolean {
  return (
    context.survival.mode === 'LOCAL_STABLE' &&
    !context.survival.suppressionReasons.includes('defenseFloor') &&
    context.options.workersOnly !== true &&
    context.workerCapacity >= context.workerTarget &&
    context.colony.energyCapacityAvailable >= TERRITORY_SCOUT_BODY_COST &&
    context.colony.energyAvailable >= TERRITORY_SCOUT_BODY_COST
  );
}

function getClosedPassiveScoutOnlyTargetRooms(context: SpawnPlanningContext): readonly string[] {
  return getPassiveScoutOnlyTargetRooms(context.colony.room.name).filter(
    (targetRoom) => !isPassiveScoutGateOpen(context.colony, targetRoom, context.gameTime)
  );
}

function planSeasonScoreCollectorSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  const blocker = getSeasonScoreCollectorSpawnSafetyBlocker(context);
  if (blocker) {
    if (blocker !== 'non_seasonal') {
      recordSeasonScoreCollectorSpawnBlocker(context.colony.room.name, blocker, context.gameTime);
    }
    return null;
  }

  const demand = selectSeasonScoreCollectorSpawnDemand(context.colony, context.gameTime);
  if (!demand) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    recordSeasonScoreCollectorSpawnBlocker(context.colony.room.name, 'spawn_unavailable', context.gameTime);
    return null;
  }

  if (getSpawnEnergyBudget(context.colony) < TERRITORY_SCOUT_BODY_COST) {
    recordSeasonScoreCollectorSpawnBlocker(context.colony.room.name, 'safety_priority', context.gameTime);
    return null;
  }

  return {
    spawn,
    body: [...TERRITORY_SCOUT_BODY],
    name: appendSpawnNameSuffix(
      `${SCORE_COLLECTOR_ROLE}-${context.colony.room.name}-${demand.targetRoom}-${context.gameTime}`,
      context.options
    ),
    memory: buildSeasonScoreCollectorMemory(context.colony.room.name, demand.targetRoom, context.gameTime)
  };
}

function getSeasonScoreCollectorSpawnSafetyBlocker(
  context: SpawnPlanningContext
): SeasonScoreCollectorsDiagnosticsMemory['blocker'] | null {
  if (context.options.workersOnly === true) {
    return 'safety_priority';
  }

  if (
    context.survival.mode === 'BOOTSTRAP' ||
    context.survival.hostilePresence ||
    context.survival.controllerDowngradeGuard ||
    context.workerCapacity < context.workerTarget ||
    context.workerCapacity < context.survival.survivalWorkerFloor
  ) {
    return 'safety_priority';
  }

  if (
    context.colony.energyCapacityAvailable < TERRITORY_SCOUT_BODY_COST ||
    context.colony.energyAvailable < TERRITORY_SCOUT_BODY_COST
  ) {
    return 'safety_priority';
  }

  return null;
}

function planControllerUpgradeSurplusSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (!shouldSpawnControllerUpgradeSurplusWorker(context)) {
    return null;
  }

  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}

function planControllerUpgradeDemandSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.territoryIntentPending ||
    !isSelectedControllerUpgradeTarget(context) ||
    context.survival.mode === 'BOOTSTRAP' ||
    context.survival.hostilePresence ||
    hasControllerUpgradeBlockingTerritoryWork(context.colony) ||
    (context.workerCapacity > 0 && shouldSuppressWorkerSpawnForCrossRoomImport(context.colony))
  ) {
    return null;
  }

  const demand = selectControllerUpgradeSpawnDemand(
    context.colony,
    context.roleCounts,
    context.workerTarget,
    context.gameTime,
    {
      competingSpawnDemand: context.workerCapacity < context.workerTarget,
      constructionDemand: hasVisibleControllerUpgradeConstructionDemand(context.colony.room),
      defenseDemand: context.survival.hostilePresence
    }
  );
  if (!demand) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  const body = selectUpgraderBody(context.colony);
  if (body.length === 0) {
    return null;
  }

  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(
      `${UPGRADER_ROLE}-${context.colony.room.name}-controller-${context.gameTime}`,
      context.options
    ),
    memory: buildControllerUpgradeCreepMemory(demand, context.gameTime)
  };
}

function hasVisibleControllerUpgradeConstructionDemand(room: Room): boolean {
  return (
    findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES').length > 0 ||
    findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES').filter((site) => site.my !== false).length > 0
  );
}

function planMultiRoomControllerUpgradeSpawn(context: SpawnPlanningContext): SpawnRequest | null {
  if (
    context.options.workersOnly ||
    context.territoryIntentPending ||
    hasNoControllerUpgradeTargets(context.options) ||
    context.survival.mode !== 'TERRITORY_READY' ||
    hasControllerUpgradeBlockingTerritoryWork(context.colony) ||
    context.workerCapacity < context.workerTarget ||
    context.colony.energyAvailable < context.colony.energyCapacityAvailable
  ) {
    return null;
  }

  const upgradePlans = selectMultiRoomUpgradePlans(context.colony).filter((plan) =>
    isAllowedControllerUpgradeTarget(context.options, plan.targetRoom)
  );
  if (upgradePlans.length === 0) {
    return null;
  }

  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }

  for (const upgradePlan of upgradePlans) {
    const body = buildMultiRoomUpgraderBody(getSpawnEnergyBudget(context.colony), upgradePlan);
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
    (context.workerCapacity > 0 && shouldSuppressWorkerSpawnForCrossRoomImport(context.colony)) ||
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

function isSelectedControllerUpgradeTarget(context: SpawnPlanningContext): boolean {
  return isAllowedControllerUpgradeTarget(context.options, context.colony.room.name);
}

function hasNoControllerUpgradeTargets(options: SpawnPlanningOptions): boolean {
  const targetRooms = getControllerUpgradeTargetRooms(options);
  return targetRooms === null || targetRooms?.length === 0;
}

function isAllowedControllerUpgradeTarget(options: SpawnPlanningOptions, roomName: string): boolean {
  const targetRooms = getControllerUpgradeTargetRooms(options);
  if (targetRooms === undefined) {
    return true;
  }

  if (targetRooms === null) {
    return false;
  }

  return targetRooms.includes(roomName);
}

function getControllerUpgradeTargetRooms(
  options: SpawnPlanningOptions
): readonly string[] | null | undefined {
  if (options.controllerUpgradeTargetRooms !== undefined) {
    return options.controllerUpgradeTargetRooms;
  }

  if (options.controllerUpgradeTargetRoom !== undefined) {
    return options.controllerUpgradeTargetRoom === null
      ? null
      : [options.controllerUpgradeTargetRoom];
  }

  return undefined;
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

function hasExpansionClaimSpawnDemand(colonyName: string): boolean {
  const territory = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.territory;
  if (!territory) {
    return false;
  }

  return (
    hasActiveExpansionClaimPipeline(territory, colonyName) ||
    hasRunnableExpansionClaimIntent(territory, colonyName) ||
    hasRunnableExpansionClaimTarget(territory, colonyName)
  );
}

function hasActiveExpansionClaimPipeline(territory: TerritoryMemory, colonyName: string): boolean {
  const pipeline = territory.expansionPipelines?.[colonyName];
  return (
    isRecord(pipeline) &&
    pipeline.status === 'active' &&
    pipeline.stage === 'claiming' &&
    pipeline.targetRoom !== colonyName
  );
}

function hasRunnableExpansionClaimIntent(territory: TerritoryMemory, colonyName: string): boolean {
  return Array.isArray(territory.intents)
    ? territory.intents.some(
        (intent) =>
          isRecord(intent) &&
          intent.colony === colonyName &&
          intent.targetRoom !== colonyName &&
          intent.action === 'claim' &&
          (intent.status === 'planned' || intent.status === 'active') &&
          isExpansionClaimSource(intent.createdBy)
      )
    : false;
}

function hasRunnableExpansionClaimTarget(territory: TerritoryMemory, colonyName: string): boolean {
  return Array.isArray(territory.targets)
    ? territory.targets.some(
        (target) =>
          isRecord(target) &&
          target.colony === colonyName &&
          target.roomName !== colonyName &&
          target.enabled !== false &&
          target.action === 'claim' &&
          isExpansionClaimSource(target.createdBy)
      )
    : false;
}

function isExpansionClaimSource(source: unknown): boolean {
  return (
    source === NEXT_EXPANSION_TARGET_CREATOR ||
    source === 'expansionPlanner' ||
    source === 'autonomousExpansionClaim'
  );
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

  const body = buildTerritorySpawnBody(getSpawnEnergyBudget(colony), territoryIntent);
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

function isWorkerOnlyFollowUpPass(options: SpawnPlanningOptions): boolean {
  return options.workersOnly === true && isNonEmptyString(options.nameSuffix);
}

function selectWorkerBody(colony: ColonySnapshot, roleCounts: RoleCounts): BodyPartConstant[] {
  return selectDynamicBodyForColony(
    colony,
    'worker',
    getWorkerDynamicBodyDemand(colony, roleCounts),
    (energyBudget) => buildWorkerBodyForDemandBudget(colony, roleCounts, energyBudget)
  );
}

function buildWorkerBodyForDemandBudget(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  energyBudget: number
): BodyPartConstant[] {
  return buildScaledWorkerBody(colony.energyCapacityAvailable, {
    controllerLevel: colony.room.controller?.level,
    currentWorkerCount: roleCounts.worker,
    energyAvailable: energyBudget,
    emergency: roleCounts.worker === 0
  });
}

function selectDynamicBodyForColony(
  colony: ColonySnapshot,
  role: string,
  demand: DynamicCreepBodyDemand,
  buildBody: (energyBudget: number) => BodyPartConstant[]
): BodyPartConstant[] {
  const spawnEnergyBudget = getSpawnPlanningBodyEnergyBudget(colony, demand);
  const selection = selectDynamicCreepBody({
    room: colony.room,
    spawns: colony.spawns,
    energyAvailable: spawnEnergyBudget ?? colony.energyAvailable,
    energyCapacityAvailable: colony.energyCapacityAvailable,
    spawnEnergyBudget,
    spawnBufferPolicy: getSpawnBufferBudgetPolicy(spawnEnergyBudget),
    candidates: [
      {
        role,
        demand,
        needed: true,
        buildBody
      }
    ]
  });

  return selection?.body ?? [];
}

function selectUpgraderBody(colony: ColonySnapshot): BodyPartConstant[] {
  const spawnEnergyBudget = getSpawnPlanningBodyEnergyBudget(colony, 'surplus');
  const selection = selectDynamicCreepBody({
    room: colony.room,
    spawns: colony.spawns,
    energyAvailable: spawnEnergyBudget ?? colony.energyAvailable,
    energyCapacityAvailable: colony.energyCapacityAvailable,
    spawnEnergyBudget,
    spawnBufferPolicy: getSpawnBufferBudgetPolicy(spawnEnergyBudget),
    candidates: [
      {
        role: UPGRADER_ROLE,
        demand: 'surplus',
        needed: true,
        buildBody: (energyBudget) => buildUpgraderBody(energyBudget, colony.room.controller?.level)
      }
    ]
  });

  return selection?.body ?? [];
}

function getSpawnPlanningBodyEnergyBudget(
  colony: ColonySnapshot,
  demand: DynamicCreepBodyDemand
): number | undefined {
  const explicitBudget = normalizeOptionalNonNegativeInteger(colony.spawnEnergyBudget);
  const currentEnergy = normalizeNonNegativeInteger(colony.energyAvailable);
  if (explicitBudget !== undefined) {
    return Math.min(explicitBudget, currentEnergy);
  }

  if (isCriticalRecoveryDemand(demand)) {
    return undefined;
  }

  const reservationScore = getEnergyReservationScore(colony.room, {
    energyAvailable: currentEnergy,
    energyCapacityAvailable: colony.energyCapacityAvailable
  }).reservationScore;

  return reservationScore > currentEnergy ? reservationScore : undefined;
}

function isCriticalRecoveryDemand(demand: DynamicCreepBodyDemand): boolean {
  return demand === 'critical' || demand === 'recovery';
}

function getSpawnBufferBudgetPolicy(spawnEnergyBudget: number | undefined): SpawnBufferBudgetPolicy {
  return spawnEnergyBudget === undefined ? 'respect' : 'alreadyReserved';
}

function getWorkerDynamicBodyDemand(
  colony: ColonySnapshot,
  roleCounts: RoleCounts
): DynamicCreepBodyDemand {
  if (roleCounts.worker === 0) {
    return 'critical';
  }

  if (getWorkerCapacity(roleCounts) < getWorkerTarget(colony, roleCounts)) {
    return 'recovery';
  }

  return 'surplus';
}

function getSpawnEnergyBudget(colony: ColonySnapshot): number {
  const currentEnergy = normalizeNonNegativeInteger(colony.energyAvailable);
  const explicitBudget = normalizeOptionalNonNegativeInteger(colony.spawnEnergyBudget);
  return explicitBudget !== undefined ? Math.min(explicitBudget, currentEnergy) : currentEnergy;
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

function getApproximateRange(left: RoomPosition, right: RoomPosition): number {
  if (left.roomName !== right.roomName) {
    return 50;
  }

  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}

export function buildTerritorySpawnBody(energyAvailable: number, intent: TerritoryIntentPlan): BodyPartConstant[] {
  if (intent.action === 'scout') {
    return energyAvailable >= TERRITORY_SCOUT_BODY_COST ? [...TERRITORY_SCOUT_BODY] : [];
  }

  if (requiresTerritoryControllerPressure(intent)) {
    return buildTerritoryControllerPressureBody(energyAvailable);
  }

  if (intent.action === 'reserve') {
    return buildTerritoryReserverBody(energyAvailable);
  }

  const routeDistance = getTerritoryIntentRouteDistance(intent);
  if (hasPostClaimBootstrapReserve(intent)) {
    return buildTerritoryControllerBody(
      Math.max(0, energyAvailable - Math.floor(intent.postClaimBootstrapReserveEnergy ?? 0)),
      routeDistance
    );
  }

  return buildTerritoryControllerBody(energyAvailable, routeDistance);
}

function hasPostClaimBootstrapReserve(intent: TerritoryIntentPlan): boolean {
  return (
    intent.action === 'claim' &&
    typeof intent.postClaimBootstrapReserveEnergy === 'number' &&
    intent.postClaimBootstrapReserveEnergy > 0
  );
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as unknown as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function compareColoniesForSpawnPlanning(
  left: ColonySnapshot,
  right: ColonySnapshot,
  roleCountsByRoom?: SpawnPlanningRoleCountsByRoom
): number {
  const leftBudget = getRoomCreepBudget(left, getRoleCountsForSpawnPlanning(left, roleCountsByRoom));
  const rightBudget = getRoomCreepBudget(right, getRoleCountsForSpawnPlanning(right, roleCountsByRoom));

  return (
    getRoomSpawnPriorityRank(leftBudget.priority) - getRoomSpawnPriorityRank(rightBudget.priority) ||
    rightBudget.workerDeficit - leftBudget.workerDeficit ||
    getSpawnlessWorkerRecoveryRank(rightBudget) - getSpawnlessWorkerRecoveryRank(leftBudget) ||
    rightBudget.constructionSiteCount - leftBudget.constructionSiteCount ||
    rightBudget.sourceCount - leftBudget.sourceCount ||
    getOperationalSpawnRank(rightBudget) - getOperationalSpawnRank(leftBudget) ||
    getNoSpawnRoomOrdering(leftBudget, rightBudget) ||
    leftBudget.controllerLevel - rightBudget.controllerLevel ||
    rightBudget.deficitEnergy - leftBudget.deficitEnergy ||
    getEnergyGateRank(rightBudget.energyGate) - getEnergyGateRank(leftBudget.energyGate) ||
    rightBudget.effectiveEnergyAvailable - leftBudget.effectiveEnergyAvailable ||
    leftBudget.netLocalEnergyPerTick - rightBudget.netLocalEnergyPerTick ||
    right.energyAvailable - left.energyAvailable ||
    left.room.name.localeCompare(right.room.name)
  );
}

function getSpawnlessWorkerRecoveryRank(budget: RoomCreepBudget): number {
  return budget.ownedSpawnCount === 0 && budget.workerDeficit > 0 ? 1 : 0;
}

function getOperationalSpawnRank(budget: RoomCreepBudget): number {
  return budget.ownedSpawnCount > 0 ? 1 : 0;
}

function getNoSpawnRoomOrdering(left: RoomCreepBudget, right: RoomCreepBudget): number {
  if (left.ownedSpawnCount > 0 || right.ownedSpawnCount > 0) {
    return 0;
  }

  return (
    right.effectiveEnergyAvailable - left.effectiveEnergyAvailable ||
    right.energyAvailable - left.energyAvailable
  );
}

function getRoleCountsForSpawnPlanning(
  colony: ColonySnapshot,
  roleCountsByRoom: SpawnPlanningRoleCountsByRoom | undefined
): RoleCounts {
  const roomName = colony.room.name;
  const mappedCounts = getMappedRoleCounts(roleCountsByRoom, roomName);
  if (mappedCounts) {
    return mappedCounts;
  }

  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return countCreepsByRole(creeps ? Object.values(creeps) : [], roomName);
}

function getMappedRoleCounts(
  roleCountsByRoom: SpawnPlanningRoleCountsByRoom | undefined,
  roomName: string
): RoleCounts | undefined {
  if (!roleCountsByRoom) {
    return undefined;
  }

  if (isRoleCountsMap(roleCountsByRoom)) {
    return roleCountsByRoom.get(roomName);
  }

  return roleCountsByRoom[roomName];
}

function isRoleCountsMap(value: SpawnPlanningRoleCountsByRoom): value is ReadonlyMap<string, RoleCounts> {
  return typeof (value as ReadonlyMap<string, RoleCounts>).get === 'function';
}

function selectRoomSpawnPriority(
  survival: ColonySurvivalAssessment,
  workerDeficit: number
): SpawnPlanningRoomPriority {
  if (survival.hostilePresence) {
    return 'defense';
  }

  if (survival.mode === 'BOOTSTRAP' && hasEmergencyBootstrapCreepShortfall(survival)) {
    return 'emergencyBootstrap';
  }

  if (survival.controllerDowngradeGuard) {
    return 'controllerDowngradeGuard';
  }

  if (workerDeficit > 0) {
    return 'localWorkerRecovery';
  }

  return survival.mode === 'TERRITORY_READY' ? 'stableWork' : 'surplusWork';
}

function getRoomSpawnPriorityRank(priority: SpawnPlanningRoomPriority): number {
  switch (priority) {
    case 'defense':
      return 0;
    case 'emergencyBootstrap':
      return 1;
    case 'controllerDowngradeGuard':
      return 2;
    case 'localWorkerRecovery':
      return 3;
    case 'stableWork':
      return 4;
    case 'surplusWork':
      return 5;
  }
}

function getSpawnPlanningEnergyGate(
  energyAvailable: number,
  energyCapacityAvailable: number
): SpawnPlanningEnergyGate {
  const energy = normalizeNonNegativeInteger(energyAvailable);
  const capacity = normalizeNonNegativeInteger(energyCapacityAvailable);
  if (energy < MINIMUM_EMERGENCY_WORKER_BODY_COST) {
    return 'critical';
  }

  if (energy < BOOTSTRAP_MIN_SPAWN_ENERGY) {
    return 'recovery';
  }

  if (capacity > 0 && energy >= capacity) {
    return 'full';
  }

  return 'ready';
}

function getEnergyGateRank(gate: SpawnPlanningEnergyGate): number {
  switch (gate) {
    case 'critical':
      return 0;
    case 'recovery':
      return 1;
    case 'ready':
      return 2;
    case 'full':
      return 3;
  }
}

function getControllerLevel(controller: StructureController | undefined): number {
  return typeof controller?.level === 'number' ? controller.level : MAX_CONTROLLER_LEVEL;
}

function getStorageBalanceMemory(): EconomyStorageBalanceMemory | undefined {
  return (globalThis as unknown as { Memory?: Partial<Memory> }).Memory?.economy?.storageBalance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function findRoomObjects<T>(room: Room, globalName: string): T[] {
  const findConstant = (globalThis as Record<string, unknown>)[globalName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = (room.find as unknown as (type: number) => unknown[])(findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getVisibleConstructionSiteCount(room: Room): number {
  const constructionSites = [
    ...findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES'),
    ...findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES').filter((site) => site.my !== false)
  ];
  const seenIds = new Set<string>();
  let anonymousSiteCount = 0;

  for (const site of constructionSites) {
    if (typeof site.id !== 'string' || site.id.length === 0) {
      anonymousSiteCount += 1;
      continue;
    }

    seenIds.add(site.id);
  }

  return seenIds.size + anonymousSiteCount;
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getGameTime(): number {
  return typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
}
