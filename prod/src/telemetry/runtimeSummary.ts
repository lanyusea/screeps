import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  assessColonySnapshotSurvival,
  type ColonyMode,
  type ColonySuppressionReason
} from '../colony/survivalMode';
import { buildRuntimeConstructionPriorityReport, type ConstructionPriorityScore } from '../construction/constructionPriority';
import { countCreepsByRole, type RoleCounts } from '../creeps/roleCounts';
import {
  buildRuntimeOccupationRecommendationReport,
  persistOccupationRecommendationFollowUpIntent,
  type OccupationRecommendationReport
} from '../territory/occupationRecommendation';
import {
  getActiveTerritoryFollowUpExecutionHints,
  getSuspendedTerritoryIntentCountsByRoom,
  getTerritoryIntentProgressSummaries,
  type TerritoryIntentProgressSummary
} from '../territory/territoryPlanner';

export const RUNTIME_SUMMARY_PREFIX = '#runtime-summary ';
export const RUNTIME_SUMMARY_INTERVAL = 20;
const MAX_REPORTED_EVENTS = 10;
const MAX_WORKER_EFFICIENCY_SAMPLES = 5;
const MAX_WORKER_EFFICIENCY_REASON_SAMPLES = 5;
const MAX_REFILL_DELIVERY_SAMPLES = 5;
const MAX_TERRITORY_INTENT_SUMMARIES = 5;
const WORKER_EFFICIENCY_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
const REFILL_DELIVERY_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
const OBSERVED_RAMPART_REPAIR_HITS_CEILING = 100_000;

const WORKER_TASK_TYPES = ['harvest', 'transfer', 'build', 'repair', 'upgrade'] as const;
const PRODUCTIVE_WORKER_TASK_TYPES = ['build', 'repair', 'upgrade'] as const;

type WorkerTaskType = (typeof WORKER_TASK_TYPES)[number];
type ProductiveWorkerTaskType = (typeof PRODUCTIVE_WORKER_TASK_TYPES)[number];

interface WorkerTaskCounts extends Record<WorkerTaskType, number> {
  none: number;
}

export type RuntimeTelemetryEvent =
  | RuntimeSpawnTelemetryEvent
  | RuntimeDefenseTelemetryEvent
  | RuntimeTerritoryClaimTelemetryEvent;

export type RuntimeTerritoryClaimTelemetryReason =
  | 'noAdjacentCandidate'
  | 'energyCapacityLow'
  | 'roomNotVisible'
  | 'hostilePresence'
  | 'controllerMissing'
  | 'controllerOwned'
  | 'controllerReserved'
  | 'controllerCooldown'
  | 'suppressed'
  | 'notInRange'
  | 'invalidTarget'
  | 'missingClaimPart'
  | 'gclUnavailable'
  | 'claimFailed';

export interface RuntimeSpawnTelemetryEvent {
  type: 'spawn';
  roomName: string;
  spawnName: string;
  creepName: string;
  role?: string;
  result: ScreepsReturnCode;
}

export interface RuntimeDefenseTelemetryEvent extends Omit<DefenseActionMemory, 'type' | 'tick'> {
  type: 'defense';
  action: DefenseActionType;
  tick?: number;
}

export interface RuntimeTerritoryClaimTelemetryEvent {
  type: 'territoryClaim';
  roomName: string;
  colony: string;
  phase: 'intent' | 'skip' | 'claim';
  targetRoom?: string;
  controllerId?: Id<StructureController>;
  creepName?: string;
  result?: ScreepsReturnCode;
  reason?: RuntimeTerritoryClaimTelemetryReason;
  score?: number;
}

interface RuntimeSpawnStatus {
  name: string;
  status: 'idle' | 'spawning';
  creepName?: string;
  remainingTime?: number;
}

interface RuntimeRoomSummary {
  roomName: string;
  energyAvailable: number;
  energyCapacity: number;
  workerCount: number;
  spawnStatus: RuntimeSpawnStatus[];
  taskCounts: WorkerTaskCounts;
  workerEfficiency?: RuntimeWorkerEfficiencySummary;
  refillDeliveryTicks?: RuntimeRefillDeliveryTicksSummary;
  refillWorkerUtilization?: RuntimeRefillWorkerUtilizationSummary;
  controller?: RuntimeControllerSummary;
  resources: RuntimeResourceSummary;
  combat: RuntimeCombatSummary;
  constructionPriority: RuntimeConstructionPrioritySummary;
  survival: RuntimeSurvivalSummary;
  territoryRecommendation: OccupationRecommendationReport;
  territoryIntents?: TerritoryIntentProgressSummary[];
  omittedTerritoryIntentCount?: number;
  suspendedTerritoryIntentCounts?: Record<string, number>;
  territoryExecutionHints?: TerritoryExecutionHintMemory[];
}

interface RuntimeControllerSummary {
  level: number;
  progress?: number;
  progressTotal?: number;
  ticksToDowngrade?: number;
}

interface RuntimeResourceEventSummary {
  harvestedEnergy: number;
  transferredEnergy: number;
  refillEnergyDelivered?: number;
  builtProgress: number;
  repairedHits: number;
  upgradedControllerProgress: number;
}

interface RuntimeResourceSummary {
  storedEnergy: number;
  workerCarriedEnergy: number;
  droppedEnergy: number;
  sourceCount: number;
  productiveEnergy: RuntimeProductiveEnergySummary;
  events?: RuntimeResourceEventSummary;
}

interface RuntimeProductiveEnergySummary {
  assignedWorkerCount: number;
  assignedCarriedEnergy: number;
  buildCarriedEnergy: number;
  repairCarriedEnergy: number;
  upgradeCarriedEnergy: number;
  pendingBuildProgress: number;
  repairBacklogHits: number;
  controllerProgressRemaining?: number;
}

interface RuntimeWorkerEfficiencySummary {
  lowLoadReturnCount: number;
  emergencyLowLoadReturnCount: number;
  avoidableLowLoadReturnCount: number;
  nearbyEnergyChoiceCount: number;
  lowLoadReturnReasons?: RuntimeWorkerEfficiencyLowLoadReturnReasonSummary[];
  samples: RuntimeWorkerEfficiencySampleSummary[];
  omittedSampleCount?: number;
}

interface RuntimeWorkerEfficiencySampleSummary extends WorkerEfficiencySampleMemory {
  creepName?: string;
}

type RuntimeWorkerEfficiencyLowLoadReturnCategory = 'emergency' | 'avoidable';

interface RuntimeWorkerEfficiencyLowLoadReturnReasonSummary {
  reason: WorkerEfficiencyLowLoadReturnReason | 'unknown';
  category: RuntimeWorkerEfficiencyLowLoadReturnCategory;
  count: number;
}

interface RuntimeWorkerEfficiencySampleEntry {
  creepName: string | undefined;
  sample: WorkerEfficiencySampleMemory;
}

interface RuntimeRefillDeliveryTicksSummary {
  completedCount: number;
  averageTicks: number;
  maxTicks: number;
  samples: RuntimeRefillDeliverySampleSummary[];
  omittedSampleCount?: number;
}

interface RuntimeRefillDeliverySampleSummary extends WorkerRefillDeliverySampleMemory {
  creepName?: string;
}

interface RuntimeRefillDeliverySampleEntry {
  creepName: string | undefined;
  sample: WorkerRefillDeliverySampleMemory;
}

interface RuntimeRefillWorkerUtilizationSummary {
  assignedWorkerCount: number;
  refillActiveTicks: number;
  idleOrOtherTaskTicks: number;
  ratio: number;
  workers: RuntimeRefillWorkerUtilizationWorkerSummary[];
}

interface RuntimeRefillWorkerUtilizationWorkerSummary {
  creepName?: string;
  refillActiveTicks: number;
  idleOrOtherTaskTicks: number;
  ratio: number;
}

interface RuntimeCombatEventSummary {
  attackCount: number;
  attackDamage: number;
  objectDestroyedCount: number;
  creepDestroyedCount: number;
}

interface RuntimeCombatSummary {
  hostileCreepCount: number;
  hostileStructureCount: number;
  events?: RuntimeCombatEventSummary;
}

interface RuntimeConstructionPrioritySummary {
  candidates: RuntimeConstructionPriorityCandidateSummary[];
  nextPrimary: RuntimeConstructionPriorityCandidateSummary | null;
}

interface RuntimeConstructionPriorityCandidateSummary {
  buildItem: string;
  room: string;
  score: number;
  urgency: ConstructionPriorityScore['urgency'];
  preconditions: string[];
  expectedKpiMovement: string[];
  risk: string[];
}

interface RuntimeSurvivalSummary {
  mode: ColonyMode;
  workerCapacity: number;
  workerTarget: number;
  survivalWorkerFloor: number;
  suppressionReasons?: ColonySuppressionReason[];
}

interface RuntimeRoomEventMetrics {
  resources?: RuntimeResourceEventSummary;
  combat?: RuntimeCombatEventSummary;
  refillTransfers?: RuntimeRefillTransferEvent[];
}

interface RuntimeRefillTransferEvent {
  objectId?: string;
  targetId: string;
  amount: number;
}

interface RuntimeCpuSummary {
  used?: number;
  bucket?: number;
}

interface RuntimeSummary {
  type: 'runtime-summary';
  tick: number;
  rooms: RuntimeRoomSummary[];
  events?: RuntimeTelemetryEvent[];
  omittedEventCount?: number;
  cpu?: RuntimeCpuSummary;
}

interface RuntimeSummaryOptions {
  persistOccupationRecommendations?: boolean;
}

let cachedRefillTargetIdsByRoom = new Map<string, Set<string>>();
let cachedEventMetricsByRoom = new Map<string, RuntimeRoomEventMetrics>();
let cachedEventMetricsTick: number | undefined;

export function emitRuntimeSummary(
  colonies: ColonySnapshot[],
  creeps: Creep[],
  events: RuntimeTelemetryEvent[] = [],
  options: RuntimeSummaryOptions = {}
): void {
  if (colonies.length === 0 && events.length === 0) {
    return;
  }

  const tick = getGameTime();
  resetCachedRefillTelemetryIfTickRewound(tick);
  const emitsSummary = shouldEmitRuntimeSummary(tick, events);
  const creepsByColony = groupCreepsByColony(creeps);
  let refillTargetIdsByRoom = cachedRefillTargetIdsByRoom;
  let eventMetricsByRoom = cachedEventMetricsByRoom;

  if (emitsSummary) {
    refillTargetIdsByRoom = buildRefillTargetIdsByRoom(colonies);
    eventMetricsByRoom = buildRoomEventMetricsByRoom(colonies, refillTargetIdsByRoom);
    cachedRefillTargetIdsByRoom = refillTargetIdsByRoom;
    cachedEventMetricsByRoom = eventMetricsByRoom;
    cachedEventMetricsTick = tick;
  }

  refreshRefillTelemetry(
    colonies,
    creepsByColony,
    refillTargetIdsByRoom,
    eventMetricsByRoom,
    tick,
    cachedEventMetricsTick
  );
  if (!emitsSummary) {
    return;
  }

  const reportedEvents = events.slice(0, MAX_REPORTED_EVENTS);
  const persistOccupationRecommendations = options.persistOccupationRecommendations !== false;
  const summary: RuntimeSummary = {
    type: 'runtime-summary',
    tick,
    rooms: colonies.map((colony) =>
      summarizeRoom(
        colony,
        creepsByColony.get(colony.room.name) ?? [],
        persistOccupationRecommendations,
        eventMetricsByRoom.get(colony.room.name) ?? {}
      )
    ),
    ...(reportedEvents.length > 0 ? { events: reportedEvents } : {}),
    ...(events.length > MAX_REPORTED_EVENTS ? { omittedEventCount: events.length - MAX_REPORTED_EVENTS } : {}),
    ...buildCpuSummary()
  };

  console.log(`${RUNTIME_SUMMARY_PREFIX}${JSON.stringify(summary)}`);
}

export function shouldEmitRuntimeSummary(tick: number, events: RuntimeTelemetryEvent[]): boolean {
  return events.length > 0 || (tick > 0 && tick % RUNTIME_SUMMARY_INTERVAL === 0);
}

function resetCachedRefillTelemetryIfTickRewound(tick: number): void {
  if (cachedEventMetricsTick === undefined || tick >= cachedEventMetricsTick) {
    return;
  }

  cachedRefillTargetIdsByRoom = new Map<string, Set<string>>();
  cachedEventMetricsByRoom = new Map<string, RuntimeRoomEventMetrics>();
  cachedEventMetricsTick = undefined;
}

function groupCreepsByColony(creeps: Creep[]): Map<string, Creep[]> {
  const creepsByColony = new Map<string, Creep[]>();

  for (const creep of creeps) {
    const colonyName = creep.memory.colony;
    if (!colonyName) {
      continue;
    }

    const colonyCreeps = creepsByColony.get(colonyName) ?? [];
    colonyCreeps.push(creep);
    creepsByColony.set(colonyName, colonyCreeps);
  }

  return creepsByColony;
}

function buildRefillTargetIdsByRoom(colonies: ColonySnapshot[]): Map<string, Set<string>> {
  const refillTargetIdsByRoom = new Map<string, Set<string>>();
  for (const colony of colonies) {
    refillTargetIdsByRoom.set(colony.room.name, getSpawnExtensionEnergyStructureIds(colony.room));
  }

  return refillTargetIdsByRoom;
}

function buildRoomEventMetricsByRoom(
  colonies: ColonySnapshot[],
  refillTargetIdsByRoom: Map<string, Set<string>>
): Map<string, RuntimeRoomEventMetrics> {
  const eventMetricsByRoom = new Map<string, RuntimeRoomEventMetrics>();
  for (const colony of colonies) {
    eventMetricsByRoom.set(
      colony.room.name,
      summarizeRoomEventMetrics(colony.room, refillTargetIdsByRoom.get(colony.room.name) ?? new Set<string>())
    );
  }

  return eventMetricsByRoom;
}

function summarizeRoom(
  colony: ColonySnapshot,
  colonyCreeps: Creep[],
  persistOccupationRecommendations: boolean,
  eventMetrics: RuntimeRoomEventMetrics
): RuntimeRoomSummary {
  const colonyWorkers = colonyCreeps.filter((creep) => creep.memory.role === 'worker');
  const roleCounts = countCreepsByRole(colonyCreeps, colony.room.name);
  const territoryRecommendation = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
  if (persistOccupationRecommendations) {
    persistOccupationRecommendationFollowUpIntent(territoryRecommendation, getGameTime());
  }

  return {
    roomName: colony.room.name,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnStatus: colony.spawns.map(summarizeSpawn),
    taskCounts: countWorkerTasks(colonyWorkers),
    ...summarizeWorkerEfficiency(colonyWorkers, getGameTime()),
    ...summarizeRefillTelemetry(colonyWorkers, getGameTime()),
    ...buildControllerSummary(colony.room),
    resources: summarizeResources(colony, colonyWorkers, eventMetrics.resources),
    combat: summarizeCombat(colony.room, eventMetrics.combat),
    constructionPriority: summarizeConstructionPriority(colony, colonyWorkers),
    survival: summarizeSurvival(colony, roleCounts),
    territoryRecommendation,
    ...buildTerritoryIntentSummary(colony.room.name, roleCounts),
    ...buildTerritoryExecutionHintSummary(colony.room.name)
  };
}

function buildTerritoryIntentSummary(
  colonyName: string,
  roleCounts: RoleCounts
): {
  territoryIntents?: TerritoryIntentProgressSummary[];
  omittedTerritoryIntentCount?: number;
  suspendedTerritoryIntentCounts?: Record<string, number>;
} {
  const territoryIntents = getTerritoryIntentProgressSummaries(colonyName, roleCounts);
  const suspendedTerritoryIntentCounts = getSuspendedTerritoryIntentCountsByRoom(colonyName, getGameTime());
  const hasSuspendedTerritoryIntents = Object.keys(suspendedTerritoryIntentCounts).length > 0;
  if (territoryIntents.length === 0 && !hasSuspendedTerritoryIntents) {
    return {};
  }

  const reportedIntents = territoryIntents.slice(0, MAX_TERRITORY_INTENT_SUMMARIES);
  return {
    ...(reportedIntents.length > 0 ? { territoryIntents: reportedIntents } : {}),
    ...(territoryIntents.length > MAX_TERRITORY_INTENT_SUMMARIES
      ? { omittedTerritoryIntentCount: territoryIntents.length - MAX_TERRITORY_INTENT_SUMMARIES }
      : {}),
    ...(hasSuspendedTerritoryIntents ? { suspendedTerritoryIntentCounts } : {})
  };
}

function buildTerritoryExecutionHintSummary(
  colonyName: string
): { territoryExecutionHints?: TerritoryExecutionHintMemory[] } {
  const territoryExecutionHints = getActiveTerritoryFollowUpExecutionHints(colonyName);
  return territoryExecutionHints.length > 0 ? { territoryExecutionHints } : {};
}

function summarizeSpawn(spawn: StructureSpawn): RuntimeSpawnStatus {
  if (!spawn.spawning) {
    return {
      name: spawn.name,
      status: 'idle'
    };
  }

  return {
    name: spawn.name,
    status: 'spawning',
    creepName: spawn.spawning.name,
    remainingTime: spawn.spawning.remainingTime
  };
}

function countWorkerTasks(workers: Creep[]): WorkerTaskCounts {
  const counts: WorkerTaskCounts = {
    harvest: 0,
    transfer: 0,
    build: 0,
    repair: 0,
    upgrade: 0,
    none: 0
  };

  for (const worker of workers) {
    const taskType = worker.memory.task?.type as string | undefined;
    if (isWorkerTaskType(taskType)) {
      counts[taskType] += 1;
    } else {
      counts.none += 1;
    }
  }

  return counts;
}

function isWorkerTaskType(taskType: string | undefined): taskType is WorkerTaskType {
  return WORKER_TASK_TYPES.includes(taskType as WorkerTaskType);
}

function summarizeWorkerEfficiency(
  workers: Creep[],
  tick: number
): { workerEfficiency?: RuntimeWorkerEfficiencySummary } {
  const samples = workers
    .map((worker) => ({ creepName: getCreepName(worker), sample: worker.memory.workerEfficiency }))
    .filter(
      (entry): entry is RuntimeWorkerEfficiencySampleEntry =>
        isWorkerEfficiencySample(entry.sample) && isRecentWorkerEfficiencySample(entry.sample, tick)
    )
    .sort(compareWorkerEfficiencySampleEntries);

  if (samples.length === 0) {
    return {};
  }

  const reportedSamples = samples.slice(0, MAX_WORKER_EFFICIENCY_SAMPLES).map(toRuntimeWorkerEfficiencySample);
  const lowLoadReturnSamples = samples.filter((entry) => entry.sample.type === 'lowLoadReturn');
  const emergencyLowLoadReturnCount = lowLoadReturnSamples.filter((entry) =>
    isEmergencyLowLoadReturnReason(getLowLoadReturnReason(entry.sample))
  ).length;
  const lowLoadReturnReasons = summarizeLowLoadReturnReasons(lowLoadReturnSamples);

  return {
    workerEfficiency: {
      lowLoadReturnCount: lowLoadReturnSamples.length,
      emergencyLowLoadReturnCount,
      avoidableLowLoadReturnCount: lowLoadReturnSamples.length - emergencyLowLoadReturnCount,
      nearbyEnergyChoiceCount: samples.filter((entry) => entry.sample.type === 'nearbyEnergyChoice').length,
      ...(lowLoadReturnReasons.length > 0 ? { lowLoadReturnReasons } : {}),
      samples: reportedSamples,
      ...(samples.length > MAX_WORKER_EFFICIENCY_SAMPLES
        ? { omittedSampleCount: samples.length - MAX_WORKER_EFFICIENCY_SAMPLES }
        : {})
    }
  };
}

function summarizeLowLoadReturnReasons(
  samples: RuntimeWorkerEfficiencySampleEntry[]
): RuntimeWorkerEfficiencyLowLoadReturnReasonSummary[] {
  const countsByReason = new Map<WorkerEfficiencyLowLoadReturnReason | 'unknown', number>();
  for (const entry of samples) {
    const reason = getLowLoadReturnReason(entry.sample);
    countsByReason.set(reason, (countsByReason.get(reason) ?? 0) + 1);
  }

  return [...countsByReason.entries()]
    .map(([reason, count]) => ({
      reason,
      category: getLowLoadReturnReasonCategory(reason),
      count
    }))
    .sort(compareLowLoadReturnReasonSummaries)
    .slice(0, MAX_WORKER_EFFICIENCY_REASON_SAMPLES);
}

function compareLowLoadReturnReasonSummaries(
  left: RuntimeWorkerEfficiencyLowLoadReturnReasonSummary,
  right: RuntimeWorkerEfficiencyLowLoadReturnReasonSummary
): number {
  return right.count - left.count || left.reason.localeCompare(right.reason);
}

function getLowLoadReturnReason(
  sample: WorkerEfficiencySampleMemory
): WorkerEfficiencyLowLoadReturnReason | 'unknown' {
  return isLowLoadReturnReason(sample.reason) ? sample.reason : 'unknown';
}

function getLowLoadReturnReasonCategory(
  reason: WorkerEfficiencyLowLoadReturnReason | 'unknown'
): RuntimeWorkerEfficiencyLowLoadReturnCategory {
  return isEmergencyLowLoadReturnReason(reason) ? 'emergency' : 'avoidable';
}

function isEmergencyLowLoadReturnReason(reason: WorkerEfficiencyLowLoadReturnReason | 'unknown'): boolean {
  return (
    reason === 'emergencySpawnExtensionRefill' ||
    reason === 'controllerDowngradeGuard' ||
    reason === 'hostileSafety' ||
    reason === 'urgentSpawnExtensionRefill'
  );
}

function isLowLoadReturnReason(value: unknown): value is WorkerEfficiencyLowLoadReturnReason {
  return (
    value === 'emergencySpawnExtensionRefill' ||
    value === 'controllerDowngradeGuard' ||
    value === 'hostileSafety' ||
    value === 'noReachableEnergy' ||
    value === 'urgentSpawnExtensionRefill' ||
    value === 'noNearbyEnergy'
  );
}

function compareWorkerEfficiencySampleEntries(
  left: RuntimeWorkerEfficiencySampleEntry,
  right: RuntimeWorkerEfficiencySampleEntry
): number {
  return (
    right.sample.tick - left.sample.tick ||
    (left.creepName ?? '').localeCompare(right.creepName ?? '') ||
    left.sample.targetId.localeCompare(right.sample.targetId)
  );
}

function toRuntimeWorkerEfficiencySample(entry: {
  creepName: string | undefined;
  sample: WorkerEfficiencySampleMemory;
}): RuntimeWorkerEfficiencySampleSummary {
  return {
    ...(entry.creepName ? { creepName: entry.creepName } : {}),
    ...entry.sample
  };
}

function summarizeRefillTelemetry(
  workers: Creep[],
  tick: number
): {
  refillDeliveryTicks?: RuntimeRefillDeliveryTicksSummary;
  refillWorkerUtilization?: RuntimeRefillWorkerUtilizationSummary;
} {
  return {
    ...summarizeRefillDeliveryTicks(workers, tick),
    ...summarizeRefillWorkerUtilization(workers)
  };
}

function summarizeRefillDeliveryTicks(
  workers: Creep[],
  tick: number
): { refillDeliveryTicks?: RuntimeRefillDeliveryTicksSummary } {
  const samples = workers
    .flatMap((worker) =>
      (worker.memory.refillTelemetry?.recentDeliveries ?? []).map((sample) => ({
        creepName: getCreepName(worker),
        sample
      }))
    )
    .filter((entry): entry is RuntimeRefillDeliverySampleEntry =>
      isRecentRefillDeliverySample(entry.sample, tick)
    )
    .sort(compareRefillDeliverySampleEntries);

  if (samples.length === 0) {
    return {};
  }

  const reportedSamples = samples.slice(0, MAX_REFILL_DELIVERY_SAMPLES).map(toRuntimeRefillDeliverySample);
  const deliveryTicks = samples.map((entry) => entry.sample.deliveryTicks);
  const completedCount = deliveryTicks.length;

  return {
    refillDeliveryTicks: {
      completedCount,
      averageTicks: roundRatio(deliveryTicks.reduce((total, value) => total + value, 0), completedCount),
      maxTicks: Math.max(...deliveryTicks),
      samples: reportedSamples,
      ...(samples.length > MAX_REFILL_DELIVERY_SAMPLES
        ? { omittedSampleCount: samples.length - MAX_REFILL_DELIVERY_SAMPLES }
        : {})
    }
  };
}

function summarizeRefillWorkerUtilization(
  workers: Creep[]
): { refillWorkerUtilization?: RuntimeRefillWorkerUtilizationSummary } {
  const workerSummaries = workers
    .map((worker): RuntimeRefillWorkerUtilizationWorkerSummary | null => {
      const telemetry = worker.memory.refillTelemetry;
      if (!telemetry) {
        return null;
      }

      const refillActiveTicks = Math.max(0, Math.floor(telemetry.refillActiveTicks ?? 0));
      const idleOrOtherTaskTicks = Math.max(0, Math.floor(telemetry.idleOrOtherTaskTicks ?? 0));
      const totalTicks = refillActiveTicks + idleOrOtherTaskTicks;
      if (totalTicks <= 0) {
        return null;
      }

      return {
        ...(getCreepName(worker) ? { creepName: getCreepName(worker) } : {}),
        refillActiveTicks,
        idleOrOtherTaskTicks,
        ratio: roundRatio(refillActiveTicks, totalTicks)
      };
    })
    .filter((summary): summary is RuntimeRefillWorkerUtilizationWorkerSummary => summary !== null)
    .sort(compareRefillWorkerUtilizationSummaries);

  if (workerSummaries.length === 0) {
    return {};
  }

  const refillActiveTicks = workerSummaries.reduce((total, worker) => total + worker.refillActiveTicks, 0);
  const idleOrOtherTaskTicks = workerSummaries.reduce((total, worker) => total + worker.idleOrOtherTaskTicks, 0);
  const totalTicks = refillActiveTicks + idleOrOtherTaskTicks;

  return {
    refillWorkerUtilization: {
      assignedWorkerCount: workerSummaries.length,
      refillActiveTicks,
      idleOrOtherTaskTicks,
      ratio: roundRatio(refillActiveTicks, totalTicks),
      workers: workerSummaries
    }
  };
}

function compareRefillDeliverySampleEntries(
  left: RuntimeRefillDeliverySampleEntry,
  right: RuntimeRefillDeliverySampleEntry
): number {
  return (
    right.sample.tick - left.sample.tick ||
    (left.creepName ?? '').localeCompare(right.creepName ?? '') ||
    left.sample.targetId.localeCompare(right.sample.targetId)
  );
}

function toRuntimeRefillDeliverySample(
  entry: RuntimeRefillDeliverySampleEntry
): RuntimeRefillDeliverySampleSummary {
  return {
    ...(entry.creepName ? { creepName: entry.creepName } : {}),
    ...entry.sample
  };
}

function compareRefillWorkerUtilizationSummaries(
  left: RuntimeRefillWorkerUtilizationWorkerSummary,
  right: RuntimeRefillWorkerUtilizationWorkerSummary
): number {
  return (
    right.refillActiveTicks + right.idleOrOtherTaskTicks - (left.refillActiveTicks + left.idleOrOtherTaskTicks) ||
    (left.creepName ?? '').localeCompare(right.creepName ?? '')
  );
}

function isRecentRefillDeliverySample(sample: WorkerRefillDeliverySampleMemory, tick: number): boolean {
  return (
    isRefillDeliverySample(sample) &&
    (tick <= 0 || (sample.tick <= tick && sample.tick > tick - REFILL_DELIVERY_SAMPLE_TTL))
  );
}

function isRefillDeliverySample(value: unknown): value is WorkerRefillDeliverySampleMemory {
  return (
    isRecord(value) &&
    typeof value.tick === 'number' &&
    Number.isFinite(value.tick) &&
    typeof value.targetId === 'string' &&
    typeof value.deliveryTicks === 'number' &&
    Number.isFinite(value.deliveryTicks) &&
    typeof value.activeTicks === 'number' &&
    Number.isFinite(value.activeTicks) &&
    typeof value.idleOrOtherTaskTicks === 'number' &&
    Number.isFinite(value.idleOrOtherTaskTicks) &&
    typeof value.energyDelivered === 'number' &&
    Number.isFinite(value.energyDelivered)
  );
}

function roundRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 1_000) / 1_000;
}

function isRecentWorkerEfficiencySample(sample: WorkerEfficiencySampleMemory, tick: number): boolean {
  if (tick <= 0) {
    return true;
  }

  return sample.tick <= tick && sample.tick > tick - WORKER_EFFICIENCY_SAMPLE_TTL;
}

function isWorkerEfficiencySample(value: unknown): value is WorkerEfficiencySampleMemory {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.type === 'lowLoadReturn' || value.type === 'nearbyEnergyChoice') &&
    typeof value.tick === 'number' &&
    Number.isFinite(value.tick) &&
    typeof value.carriedEnergy === 'number' &&
    Number.isFinite(value.carriedEnergy) &&
    typeof value.freeCapacity === 'number' &&
    Number.isFinite(value.freeCapacity) &&
    isWorkerEfficiencyTaskType(value.selectedTask) &&
    typeof value.targetId === 'string'
  );
}

function isWorkerEfficiencyTaskType(value: unknown): value is CreepTaskMemory['type'] {
  return (
    value === 'harvest' ||
    value === 'pickup' ||
    value === 'withdraw' ||
    value === 'transfer' ||
    value === 'build' ||
    value === 'repair' ||
    value === 'claim' ||
    value === 'reserve' ||
    value === 'upgrade'
  );
}

function getCreepName(creep: Creep): string | undefined {
  const name = (creep as Creep & { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function buildControllerSummary(room: Room): { controller?: RuntimeControllerSummary } {
  const controller = room.controller;
  if (!controller?.my) {
    return {};
  }

  const summary: RuntimeControllerSummary = {
    level: controller.level
  };

  if (typeof controller.progress === 'number') {
    summary.progress = controller.progress;
  }

  if (typeof controller.progressTotal === 'number') {
    summary.progressTotal = controller.progressTotal;
  }

  if (typeof controller.ticksToDowngrade === 'number') {
    summary.ticksToDowngrade = controller.ticksToDowngrade;
  }

  return { controller: summary };
}

function summarizeResources(
  colony: ColonySnapshot,
  colonyWorkers: Creep[],
  events: RuntimeResourceEventSummary | undefined
): RuntimeResourceSummary {
  const roomStructures = findRoomObjects(colony.room, 'FIND_STRUCTURES') ?? colony.spawns;
  const constructionSites = findRoomObjects(colony.room, 'FIND_MY_CONSTRUCTION_SITES') ?? [];
  const droppedResources = findRoomObjects(colony.room, 'FIND_DROPPED_RESOURCES') ?? [];
  const sources = findRoomObjects(colony.room, 'FIND_SOURCES') ?? [];

  return {
    storedEnergy: sumEnergyInStores(roomStructures),
    workerCarriedEnergy: sumEnergyInStores(colonyWorkers),
    droppedEnergy: sumDroppedEnergy(droppedResources),
    sourceCount: sources.length,
    productiveEnergy: summarizeProductiveEnergy(colony.room, colonyWorkers, constructionSites, roomStructures),
    ...(events ? { events } : {})
  };
}

function summarizeProductiveEnergy(
  room: Room,
  colonyWorkers: Creep[],
  constructionSites: unknown[],
  roomStructures: unknown[]
): RuntimeProductiveEnergySummary {
  const productiveAssignments = summarizeProductiveWorkerAssignments(colonyWorkers);

  return {
    ...productiveAssignments,
    pendingBuildProgress: sumPendingBuildProgress(constructionSites),
    repairBacklogHits: sumRepairBacklogHits(roomStructures),
    ...buildControllerProgressRemaining(room)
  };
}

function summarizeProductiveWorkerAssignments(
  colonyWorkers: Creep[]
): Pick<
  RuntimeProductiveEnergySummary,
  | 'assignedWorkerCount'
  | 'assignedCarriedEnergy'
  | 'buildCarriedEnergy'
  | 'repairCarriedEnergy'
  | 'upgradeCarriedEnergy'
> {
  const summary = {
    assignedWorkerCount: 0,
    assignedCarriedEnergy: 0,
    buildCarriedEnergy: 0,
    repairCarriedEnergy: 0,
    upgradeCarriedEnergy: 0
  };

  for (const worker of colonyWorkers) {
    const taskType = worker.memory.task?.type;
    if (!isProductiveWorkerTaskType(taskType)) {
      continue;
    }

    const carriedEnergy = getEnergyInStore(worker);
    summary.assignedWorkerCount += 1;
    summary.assignedCarriedEnergy += carriedEnergy;
    if (taskType === 'build') {
      summary.buildCarriedEnergy += carriedEnergy;
    } else if (taskType === 'repair') {
      summary.repairCarriedEnergy += carriedEnergy;
    } else {
      summary.upgradeCarriedEnergy += carriedEnergy;
    }
  }

  return summary;
}

function isProductiveWorkerTaskType(taskType: string | undefined): taskType is ProductiveWorkerTaskType {
  return PRODUCTIVE_WORKER_TASK_TYPES.includes(taskType as ProductiveWorkerTaskType);
}

function sumPendingBuildProgress(constructionSites: unknown[]): number {
  return constructionSites.reduce<number>((total, constructionSite) => total + getPendingBuildProgress(constructionSite), 0);
}

function getPendingBuildProgress(constructionSite: unknown): number {
  if (!isRecord(constructionSite)) {
    return 0;
  }

  const progress = getFiniteNumber(constructionSite.progress);
  const progressTotal = getFiniteNumber(constructionSite.progressTotal);
  if (progress === null || progressTotal === null) {
    return 0;
  }

  return Math.max(0, Math.ceil(progressTotal - progress));
}

function sumRepairBacklogHits(roomStructures: unknown[]): number {
  return roomStructures.reduce<number>((total, structure) => total + getRepairBacklogHits(structure), 0);
}

function getRepairBacklogHits(structure: unknown): number {
  if (!isRecord(structure) || !isObservableRepairBacklogStructure(structure)) {
    return 0;
  }

  const hits = getFiniteNumber(structure.hits);
  const hitsMax = getFiniteNumber(structure.hitsMax);
  if (hits === null || hitsMax === null || hitsMax <= 0) {
    return 0;
  }

  const repairCeiling = isObservedOwnedRampart(structure)
    ? Math.min(hitsMax, OBSERVED_RAMPART_REPAIR_HITS_CEILING)
    : hitsMax;
  return Math.max(0, Math.ceil(repairCeiling - hits));
}

function isObservableRepairBacklogStructure(structure: Record<string, unknown>): boolean {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_ROAD', 'road') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') ||
    isObservedOwnedRampart(structure)
  );
}

function isObservedOwnedRampart(structure: Record<string, unknown>): boolean {
  return matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart') && structure.my === true;
}

function buildControllerProgressRemaining(room: Room): { controllerProgressRemaining?: number } {
  const controller = room.controller;
  if (controller?.my !== true) {
    return {};
  }

  const progress = getFiniteNumber((controller as StructureController & { progress?: unknown }).progress);
  const progressTotal = getFiniteNumber((controller as StructureController & { progressTotal?: unknown }).progressTotal);
  if (progress === null || progressTotal === null) {
    return {};
  }

  return { controllerProgressRemaining: Math.max(0, Math.ceil(progressTotal - progress)) };
}

function summarizeCombat(room: Room, events: RuntimeCombatEventSummary | undefined): RuntimeCombatSummary {
  const hostileCreeps = findRoomObjects(room, 'FIND_HOSTILE_CREEPS') ?? [];
  const hostileStructures = findRoomObjects(room, 'FIND_HOSTILE_STRUCTURES') ?? [];

  return {
    hostileCreepCount: hostileCreeps.length,
    hostileStructureCount: hostileStructures.length,
    ...(events ? { events } : {})
  };
}

function summarizeConstructionPriority(
  colony: ColonySnapshot,
  colonyWorkers: Creep[]
): RuntimeConstructionPrioritySummary {
  const report = buildRuntimeConstructionPriorityReport(colony, colonyWorkers);

  return {
    candidates: report.candidates.map(toRuntimeConstructionPriorityCandidateSummary),
    nextPrimary: report.nextPrimary ? toRuntimeConstructionPriorityCandidateSummary(report.nextPrimary) : null
  };
}

function summarizeSurvival(colony: ColonySnapshot, roleCounts: RoleCounts): RuntimeSurvivalSummary {
  const assessment = assessColonySnapshotSurvival(colony, roleCounts);

  return {
    mode: assessment.mode,
    workerCapacity: assessment.workerCapacity,
    workerTarget: assessment.workerTarget,
    survivalWorkerFloor: assessment.survivalWorkerFloor,
    ...(assessment.suppressionReasons.length > 0 ? { suppressionReasons: assessment.suppressionReasons } : {})
  };
}

function toRuntimeConstructionPriorityCandidateSummary(
  score: ConstructionPriorityScore
): RuntimeConstructionPriorityCandidateSummary {
  return {
    buildItem: score.buildItem,
    room: score.room,
    score: score.score,
    urgency: score.urgency,
    preconditions: score.preconditions,
    expectedKpiMovement: score.expectedKpiMovement,
    risk: score.risk
  };
}

function refreshRefillTelemetry(
  colonies: ColonySnapshot[],
  creepsByColony: Map<string, Creep[]>,
  refillTargetIdsByRoom: Map<string, Set<string>>,
  eventMetricsByRoom: Map<string, RuntimeRoomEventMetrics>,
  tick: number,
  eventMetricsTick: number | undefined
): void {
  for (const colony of colonies) {
    const roomName = colony.room.name;
    const refillTargetIds = refillTargetIdsByRoom.get(roomName) ?? new Set<string>();
    // Room event logs are tick-scoped; cached refill transfer events must not be replayed on later ticks.
    const refillTransfers = eventMetricsTick === tick ? eventMetricsByRoom.get(roomName)?.refillTransfers ?? [] : [];
    const workers = (creepsByColony.get(roomName) ?? []).filter((creep) => creep.memory.role === 'worker');
    for (const worker of workers) {
      refreshWorkerRefillTelemetry(worker, refillTargetIds, refillTransfers, tick);
    }
  }
}

function refreshWorkerRefillTelemetry(
  worker: Creep,
  refillTargetIds: Set<string>,
  refillTransfers: RuntimeRefillTransferEvent[],
  tick: number
): void {
  const refillTargetId = getAssignedRefillTargetId(worker, refillTargetIds);
  let telemetry = worker.memory.refillTelemetry;

  if (refillTargetId) {
    telemetry = ensureWorkerRefillTelemetry(worker);
    if (!telemetry.current || telemetry.current.targetId !== refillTargetId) {
      telemetry.current = {
        targetId: refillTargetId,
        startedAt: tick,
        activeTicks: 0,
        idleOrOtherTaskTicks: 0
      };
    }

    recordWorkerRefillTelemetryTick(telemetry, true, tick);
  } else if (telemetry && (telemetry.current || hasRecentWorkerRefillDelivery(telemetry, tick))) {
    recordWorkerRefillTelemetryTick(telemetry, false, tick);
  }

  if (!telemetry?.current) {
    pruneWorkerRefillTelemetry(worker, tick);
    return;
  }

  const current = telemetry.current;
  const deliveryEvents = refillTransfers.filter((event) =>
    isWorkerRefillTransferEvent(worker, current.targetId, event)
  );
  if (deliveryEvents.length === 0) {
    pruneWorkerRefillTelemetry(worker, tick);
    return;
  }

  const energyDelivered = deliveryEvents.reduce((total, event) => total + event.amount, 0);
  const sample: WorkerRefillDeliverySampleMemory = {
    tick,
    targetId: current.targetId,
    deliveryTicks: Math.max(1, tick - current.startedAt + 1),
    activeTicks: current.activeTicks,
    idleOrOtherTaskTicks: current.idleOrOtherTaskTicks,
    energyDelivered
  };
  telemetry.recentDeliveries = [sample, ...(telemetry.recentDeliveries ?? [])].filter((recentSample) =>
    isRecentRefillDeliverySample(recentSample, tick)
  );
  delete telemetry.current;
  pruneWorkerRefillTelemetry(worker, tick);
}

function ensureWorkerRefillTelemetry(worker: Creep): WorkerRefillTelemetryMemory {
  if (!worker.memory.refillTelemetry) {
    worker.memory.refillTelemetry = {};
  }

  return worker.memory.refillTelemetry;
}

function recordWorkerRefillTelemetryTick(
  telemetry: WorkerRefillTelemetryMemory,
  isRefillActive: boolean,
  tick: number
): void {
  if (telemetry.lastUpdatedAt === tick) {
    return;
  }

  if (isRefillActive) {
    telemetry.refillActiveTicks = (telemetry.refillActiveTicks ?? 0) + 1;
    if (telemetry.current) {
      telemetry.current.activeTicks += 1;
    }
  } else {
    telemetry.idleOrOtherTaskTicks = (telemetry.idleOrOtherTaskTicks ?? 0) + 1;
    if (telemetry.current) {
      telemetry.current.idleOrOtherTaskTicks += 1;
    }
  }

  telemetry.lastUpdatedAt = tick;
}

function pruneWorkerRefillTelemetry(worker: Creep, tick: number): void {
  const telemetry = worker.memory.refillTelemetry;
  if (!telemetry) {
    return;
  }

  if (telemetry.recentDeliveries) {
    telemetry.recentDeliveries = telemetry.recentDeliveries.filter((sample) =>
      isRecentRefillDeliverySample(sample, tick)
    );
    if (telemetry.recentDeliveries.length === 0) {
      delete telemetry.recentDeliveries;
    }
  }

  if (
    !telemetry.current &&
    !telemetry.recentDeliveries &&
    (telemetry.lastUpdatedAt === undefined || telemetry.lastUpdatedAt <= tick - REFILL_DELIVERY_SAMPLE_TTL)
  ) {
    delete worker.memory.refillTelemetry;
  }
}

function hasRecentWorkerRefillDelivery(telemetry: WorkerRefillTelemetryMemory, tick: number): boolean {
  return (telemetry.recentDeliveries ?? []).some((sample) => isRecentRefillDeliverySample(sample, tick));
}

function getAssignedRefillTargetId(worker: Creep, refillTargetIds: Set<string>): string | null {
  const task = worker.memory.task;
  if (task?.type !== 'transfer') {
    return null;
  }

  const targetId = String(task.targetId);
  return refillTargetIds.has(targetId) ? targetId : null;
}

function isWorkerRefillTransferEvent(
  worker: Creep,
  targetId: string,
  event: RuntimeRefillTransferEvent
): boolean {
  return event.targetId === targetId && getWorkerEventIds(worker).some((workerId) => workerId === event.objectId);
}

function getWorkerEventIds(worker: Creep): string[] {
  const ids: string[] = [];
  const id = (worker as Creep & { id?: unknown }).id;
  const name = (worker as Creep & { name?: unknown }).name;
  if (typeof id === 'string' && id.length > 0) {
    ids.push(id);
  }

  if (typeof name === 'string' && name.length > 0) {
    ids.push(name);
  }

  return ids;
}

function summarizeRoomEventMetrics(
  room: Room,
  refillTargetIds: Set<string> = getSpawnExtensionEnergyStructureIds(room)
): RuntimeRoomEventMetrics {
  const eventLog = getRoomEventLog(room);
  if (!eventLog) {
    return {};
  }

  const harvestEvent = getGlobalNumber('EVENT_HARVEST');
  const transferEvent = getGlobalNumber('EVENT_TRANSFER');
  const buildEvent = getGlobalNumber('EVENT_BUILD');
  const repairEvent = getGlobalNumber('EVENT_REPAIR');
  const upgradeControllerEvent = getGlobalNumber('EVENT_UPGRADE_CONTROLLER');
  const attackEvent = getGlobalNumber('EVENT_ATTACK');
  const objectDestroyedEvent = getGlobalNumber('EVENT_OBJECT_DESTROYED');
  const resourceEvents: RuntimeResourceEventSummary = {
    harvestedEnergy: 0,
    transferredEnergy: 0,
    builtProgress: 0,
    repairedHits: 0,
    upgradedControllerProgress: 0
  };
  const combatEvents: RuntimeCombatEventSummary = {
    attackCount: 0,
    attackDamage: 0,
    objectDestroyedCount: 0,
    creepDestroyedCount: 0
  };
  const refillTransfers: RuntimeRefillTransferEvent[] = [];
  let hasResourceEvents = false;
  let hasCombatEvents = false;

  for (const entry of eventLog) {
    if (!isRecord(entry) || typeof entry.event !== 'number') {
      continue;
    }

    const data = isRecord(entry.data) ? entry.data : {};
    if (entry.event === harvestEvent && isEnergyEventData(data)) {
      resourceEvents.harvestedEnergy += getNumericEventData(data, 'amount');
      hasResourceEvents = true;
    }

    if (entry.event === transferEvent && isEnergyEventData(data)) {
      const amount = getNumericEventData(data, 'amount');
      resourceEvents.transferredEnergy += amount;
      const targetId = getEventTargetId(data);
      if (targetId && refillTargetIds.has(targetId)) {
        resourceEvents.refillEnergyDelivered = (resourceEvents.refillEnergyDelivered ?? 0) + amount;
        refillTransfers.push({
          ...buildEventObjectId(entry),
          targetId,
          amount
        });
      }
      hasResourceEvents = true;
    }

    if (entry.event === buildEvent) {
      resourceEvents.builtProgress += getNumericEventData(data, 'amount');
      hasResourceEvents = true;
    }

    if (entry.event === repairEvent) {
      resourceEvents.repairedHits += getNumericEventData(data, 'amount');
      hasResourceEvents = true;
    }

    if (entry.event === upgradeControllerEvent) {
      resourceEvents.upgradedControllerProgress += getNumericEventData(data, 'amount');
      hasResourceEvents = true;
    }

    if (entry.event === attackEvent) {
      combatEvents.attackCount += 1;
      combatEvents.attackDamage += getNumericEventData(data, 'damage');
      hasCombatEvents = true;
    }

    if (entry.event === objectDestroyedEvent) {
      combatEvents.objectDestroyedCount += 1;
      if (data.type === 'creep') {
        combatEvents.creepDestroyedCount += 1;
      }
      hasCombatEvents = true;
    }
  }

  return {
    ...(hasResourceEvents ? { resources: resourceEvents } : {}),
    ...(hasCombatEvents ? { combat: combatEvents } : {}),
    ...(refillTransfers.length > 0 ? { refillTransfers } : {})
  };
}

function getSpawnExtensionEnergyStructureIds(room: Room): Set<string> {
  const structures = findRoomObjects(room, 'FIND_MY_STRUCTURES') ?? findRoomObjects(room, 'FIND_STRUCTURES') ?? [];
  const ids = new Set<string>();

  for (const structure of structures) {
    if (!isSpawnExtensionEnergyStructure(structure)) {
      continue;
    }

    const id = getObjectId(structure);
    if (id) {
      ids.add(id);
    }
  }

  return ids;
}

function isSpawnExtensionEnergyStructure(structure: unknown): boolean {
  return (
    isRecord(structure) &&
    (matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
      matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension'))
  );
}

function getEventTargetId(data: Record<string, unknown>): string | null {
  return typeof data.targetId === 'string' && data.targetId.length > 0 ? data.targetId : null;
}

function buildEventObjectId(entry: Record<string, unknown>): { objectId?: string } {
  return typeof entry.objectId === 'string' && entry.objectId.length > 0 ? { objectId: entry.objectId } : {};
}

function getObjectId(value: unknown): string | null {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
}

function findRoomObjects(room: Room, constantName: string): unknown[] | undefined {
  const findConstant = getGlobalNumber(constantName);
  const find = (room as unknown as { find?: unknown }).find;
  if (typeof findConstant !== 'number' || typeof find !== 'function') {
    return undefined;
  }

  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return undefined;
  }
}

function getRoomEventLog(room: Room): unknown[] | undefined {
  const getEventLog = (room as unknown as { getEventLog?: unknown }).getEventLog;
  if (typeof getEventLog !== 'function') {
    return undefined;
  }

  try {
    const eventLog = getEventLog.call(room);
    return Array.isArray(eventLog) ? eventLog : undefined;
  } catch {
    return undefined;
  }
}

function sumEnergyInStores(objects: unknown[]): number {
  return objects.reduce<number>((total, object) => total + getEnergyInStore(object), 0);
}

function getEnergyInStore(object: unknown): number {
  if (!isRecord(object) || !isRecord(object.store)) {
    return 0;
  }

  const getUsedCapacity = object.store.getUsedCapacity;
  if (typeof getUsedCapacity === 'function') {
    const usedCapacity = getUsedCapacity.call(object.store, getEnergyResource());
    return typeof usedCapacity === 'number' ? usedCapacity : 0;
  }

  const storedEnergy = object.store[getEnergyResource()];
  return typeof storedEnergy === 'number' ? storedEnergy : 0;
}

function sumDroppedEnergy(droppedResources: unknown[]): number {
  const energyResource = getEnergyResource();

  return droppedResources.reduce<number>((total, droppedResource) => {
    if (!isRecord(droppedResource) || droppedResource.resourceType !== energyResource) {
      return total;
    }

    return total + (typeof droppedResource.amount === 'number' ? droppedResource.amount : 0);
  }, 0);
}

function isEnergyEventData(data: Record<string, unknown>): boolean {
  return data.resourceType === undefined || data.resourceType === getEnergyResource();
}

function getNumericEventData(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' ? value : 0;
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

type StructureConstantGlobal =
  | 'STRUCTURE_ROAD'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_RAMPART'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION';

function matchesStructureType(value: unknown, globalName: StructureConstantGlobal, fallback: string): boolean {
  const expectedValue = (globalThis as Record<string, unknown>)[globalName] ?? fallback;
  return value === expectedValue;
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getEnergyResource(): ResourceConstant {
  const value = (globalThis as Record<string, unknown>).RESOURCE_ENERGY;
  return (typeof value === 'string' ? value : 'energy') as ResourceConstant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildCpuSummary(): { cpu?: RuntimeCpuSummary } {
  const gameWithOptionalCpu = Game as Game & {
    cpu?: {
      getUsed?: () => number;
      bucket?: number;
    };
  };
  const cpu = gameWithOptionalCpu.cpu;
  if (!cpu) {
    return {};
  }

  const summary: RuntimeCpuSummary = {};
  if (typeof cpu.getUsed === 'function') {
    summary.used = cpu.getUsed();
  }

  if (typeof cpu.bucket === 'number') {
    summary.bucket = cpu.bucket;
  }

  return Object.keys(summary).length > 0 ? { cpu: summary } : {};
}

function getGameTime(): number {
  return typeof Game.time === 'number' ? Game.time : 0;
}
