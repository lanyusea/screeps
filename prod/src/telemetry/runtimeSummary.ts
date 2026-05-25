import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  assessColonySnapshotSurvival,
  type ColonyMode,
  type ColonySuppressionReason
} from '../colony/colonyStage';
import {
  buildRuntimeConstructionPriorityReport,
  constructionPriorityStrategyParametersFromEntry,
  selectConstructionPriorityStrategyRegistryEntry,
  type ConstructionPriorityScore
} from '../construction/constructionPriority';
import { countCreepsByRole, type RoleCounts } from '../creeps/roleCounts';
import type { StrategyRegistryEntry } from '../strategy/strategyRegistry';
import {
  buildRuntimeOccupationRecommendationReport,
  persistOccupationRecommendationFollowUpIntent,
  type OccupationRecommendationReport
} from '../territory/occupationRecommendation';
import {
  buildRuntimeExpansionCandidateReport,
  type ExpansionCandidateReport
} from '../territory/expansionScoring';
import {
  HEURISTIC_WORKER_TASK_POLICY_ID,
  WORKER_TASK_BC_ACTION_TYPES,
  isWorkerTaskBehaviorActionType,
  type WorkerTaskBehaviorActionType
} from '../rl/workerTaskBehavior';
import {
  getActiveTerritoryFollowUpExecutionHints,
  getSuspendedTerritoryIntentCountsByRoom,
  getTerritoryIntentProgressSummaries,
  type TerritoryIntentProgressSummary
} from '../territory/territoryPlanner';
import { getPostClaimBootstrapSummary, type PostClaimBootstrapSummary } from '../territory/postClaimBootstrap';
import {
  TERRITORY_SCOUT_VALIDATION_TIMEOUT_TICKS,
  getTerritoryScoutSummary
} from '../territory/scoutIntel';
import { summarizeTerritoryScoutConcurrency } from '../territory/scoutConcurrency';
import { getTerritoryExpansionScoutTargets } from '../territory/expansionConfig';
import { isPassiveScoutGateOpen } from '../territory/passiveScoutGate';
import {
  checkEnergyBufferForCapacityEnablingConstruction,
  checkEnergyBufferForConstructionSpending,
  checkEnergyBufferForExtensionConstruction,
  getRoomEnergyBufferHealth,
  type EnergyBufferHealth
} from '../economy/energyBuffer';
import { getMultiRoomEnergyRoomState } from '../economy/multiRoomEnergy';
import { getRoomEnergySurplusState, type RoomEnergySurplusState } from '../economy/energySurplus';
import {
  summarizeSourceContainerCoverage,
  type SourceContainerCoverageSummary
} from '../economy/sourceContainerPlanner';
import {
  assessBootstrapDefenseFloorReadiness,
  type BootstrapDefenseFloorReadiness
} from '../defense/defensePlanner';
import {
  summarizeAndResetCreepBehaviorTelemetry,
  type RuntimeBehaviorSummary as LegacyRuntimeBehaviorSummary,
  type RuntimeEnergyAcquisitionMethodDistribution
} from './behaviorTelemetry';
import {
  buildRuntimeCpuTelemetrySummary,
  getRuntimeCpuBudget,
  shouldThrottleRuntimeSummaryCadence,
  type RuntimeCpuAlert,
  type RuntimeCpuPressure,
  type RuntimeCpuPressureReason,
  type RuntimeCpuTelemetrySummary
} from '../runtime/cpuBudget';

type BehaviorTelemetrySummary = { behavior?: LegacyRuntimeBehaviorSummary };

export const RUNTIME_SUMMARY_PREFIX = '#runtime-summary ';
export const RUNTIME_CPU_SUMMARY_PREFIX = '#cpu-summary ';
export const RUNTIME_SUMMARY_INTERVAL = 20;
const DEGRADED_RUNTIME_SUMMARY_INTERVAL = RUNTIME_SUMMARY_INTERVAL * 5;
const MAX_REPORTED_EVENTS = 10;
const MAX_WORKER_EFFICIENCY_SAMPLES = 5;
const MAX_WORKER_BEHAVIOR_SAMPLES = 10;
const MAX_WORKER_EFFICIENCY_REASON_SAMPLES = 5;
const MAX_REFILL_DELIVERY_SAMPLES = 5;
const MAX_SPAWN_CRITICAL_REFILL_SAMPLES = 5;
const MAX_WORKER_ASSIGNMENT_BLOCKED_WORKERS = 12;
const MAX_TERRITORY_INTENT_SUMMARIES = 5;
const WORKER_EFFICIENCY_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
const WORKER_BEHAVIOR_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
const REFILL_DELIVERY_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
const SPAWN_CRITICAL_REFILL_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
const OBSERVED_RAMPART_REPAIR_HITS_CEILING = 150_000;

const WORKER_TASK_TYPES = ['harvest', 'transfer', 'build', 'repair', 'upgrade'] as const;
const PRODUCTIVE_WORKER_TASK_TYPES = ['build', 'repair', 'upgrade'] as const;
const DEFAULT_EXTENSION_ENERGY_CAPACITY = 50;

type WorkerTaskType = (typeof WORKER_TASK_TYPES)[number];
type ProductiveWorkerTaskType = (typeof PRODUCTIVE_WORKER_TASK_TYPES)[number];
type RuntimeBuildBlockedReason =
  | 'energy_buffer_blocked'
  | 'no_construction_sites'
  | 'worker_assignment_gap';
type RuntimeWorkerAssignmentBlockedDetail =
  | 'energy_buffer_below_threshold'
  | 'energy_buffer_spend_margin'
  | 'spawn_reserving_energy'
  | 'no_valid_body'
  | 'room_capacity_full'
  | 'unknown';
type RuntimeWorkerBuildAssignmentBlockedReason =
  | 'build_assigned'
  | 'build_blocked_controller_progress_preferred'
  | 'build_blocked_energy_buffer'
  | 'build_blocked_no_carried_energy'
  | 'build_blocked_no_construction_sites'
  | 'build_blocked_no_valid_body'
  | 'build_blocked_other_task'
  | 'build_blocked_unknown';
type RuntimeWorkerRepairAssignmentBlockedReason =
  | 'repair_assigned'
  | 'repair_blocked_build_backlog_first'
  | 'repair_blocked_controller_progress_preferred'
  | 'repair_blocked_no_carried_energy'
  | 'repair_blocked_no_repair_targets'
  | 'repair_blocked_no_valid_body'
  | 'repair_blocked_other_task'
  | 'repair_blocked_unknown';

interface WorkerTaskCounts extends Record<WorkerTaskType, number> {
  none: number;
}

export type RuntimeTelemetryEvent =
  | RuntimeSpawnTelemetryEvent
  | RuntimeDefenseTelemetryEvent
  | RuntimeTerritoryClaimTelemetryEvent
  | RuntimeTerritoryScoutTelemetryEvent
  | RuntimePostClaimBootstrapTelemetryEvent
  | RuntimeSpawnSitePlacedTelemetryEvent
  | RuntimeStrategyRecommendationTelemetryEvent;

export type RuntimeTerritoryClaimTelemetryReason =
  | 'noAdjacentCandidate'
  | 'energyCapacityLow'
  | 'roomNotVisible'
  | 'hostilePresence'
  | 'controllerMissing'
  | 'controllerOwned'
  | 'controllerReserved'
  | 'controllerCooldown'
  | 'gclInsufficient'
  | 'suppressed'
  | 'postClaimBootstrapActive'
  | 'scoutPending'
  | 'sourcesMissing'
  | 'notInRange'
  | 'invalidTarget'
  | 'missingClaimPart'
  | 'gclUnavailable'
  | 'claimFailed';

export type RuntimeTerritoryScoutTelemetryReason = TerritoryScoutValidationReason;
export type RuntimeTerritoryScoutTelemetryResult =
  | 'requested'
  | 'recorded'
  | 'pending'
  | 'passed'
  | 'blocked'
  | 'fallback';

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

export interface RuntimeTerritoryScoutTelemetryEvent {
  type: 'territoryScout';
  roomName: string;
  colony: string;
  targetRoom: string;
  phase: 'attempt' | 'intel' | 'validation';
  result: RuntimeTerritoryScoutTelemetryResult;
  reason?: RuntimeTerritoryScoutTelemetryReason;
  controllerId?: Id<StructureController>;
  scoutName?: string;
  sourceCount?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  hostileSpawnCount?: number;
  score?: number;
}

export interface RuntimePostClaimBootstrapTelemetryEvent {
  type: 'postClaimBootstrap';
  roomName: string;
  colony: string;
  phase: TerritoryPostClaimBootstrapStatus | 'spawnSite' | 'workerSpawn';
  controllerId?: Id<StructureController>;
  spawnName?: string;
  creepName?: string;
  result?: ScreepsReturnCode;
  workerCount?: number;
  workerTarget?: number;
  spawnCount?: number;
  spawnSite?: TerritoryPostClaimBootstrapSpawnSiteMemory;
}

export interface RuntimeSpawnSitePlacedTelemetryEvent {
  type: 'spawnSitePlaced';
  roomName: string;
  colony: string;
  controllerId?: Id<StructureController>;
  result: ScreepsReturnCode;
  spawnSite: TerritoryPostClaimBootstrapSpawnSiteMemory;
  existing?: boolean;
}

export interface RuntimeStrategyRecommendationTelemetryEvent {
  type: 'strategyRecommendation';
  roomName: string;
  tick?: number;
  shadow: true;
  recommendations: RuntimeStrategyRecommendationTelemetryPayload[];
}

export interface RuntimeStrategyRecommendationTelemetryPayload {
  constructionPreset?: string;
  remoteTarget?: string;
  expansionCandidate?: string;
  defensePosture?: 'passive' | 'alert' | 'active';
  confidence: number;
  reasoning: string;
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
  cpuUsed?: number;
  cpuBucket?: number;
  energyBufferHealth: EnergyBufferHealth;
  workerCount: number;
  workerAssignmentEvidenceAvailable: true;
  workerAssignmentEvidence: RuntimeWorkerAssignmentEvidenceSummary;
  workerAssignmentBlockedDetail?: RuntimeWorkerAssignmentBlockedDetail;
  workerAssignmentBlockedWorkers?: RuntimeWorkerAssignmentBlockedWorkerDetail[];
  spawnStatus: RuntimeSpawnStatus[];
  taskCounts: WorkerTaskCounts;
  constructionSiteCount: number;
  constructionDeadlockTicks: number;
  behavior?: RuntimeBehaviorSummary;
  structures?: RuntimeStructureSnapshotSummary;
  workerEfficiency?: RuntimeWorkerEfficiencySummary;
  workerLoadEfficiency?: RuntimeWorkerLoadEfficiencySummary;
  refillDeliveryTicks?: RuntimeRefillDeliveryTicksSummary;
  refillWorkerUtilization?: RuntimeRefillWorkerUtilizationSummary;
  workerEnergyThroughput?: RuntimeWorkerEnergyThroughputSummary;
  spawnCriticalRefill?: RuntimeSpawnCriticalRefillSummary;
  controller?: RuntimeControllerSummary;
  resources: RuntimeResourceSummary;
  combat: RuntimeCombatSummary;
  constructionPriority: RuntimeConstructionPrioritySummary;
  survival: RuntimeSurvivalSummary;
  territoryRecommendation: OccupationRecommendationReport;
  territoryExpansion?: ExpansionCandidateReport;
  territoryIntents?: TerritoryIntentProgressSummary[];
  omittedTerritoryIntentCount?: number;
  suspendedTerritoryIntentCounts?: Record<string, number>;
  territoryExecutionHints?: TerritoryExecutionHintMemory[];
  territoryScout?: RuntimeTerritoryScoutSummary;
  postClaimBootstrap?: PostClaimBootstrapSummary;
}

interface RuntimeTerritoryScoutSummary {
  attempts?: TerritoryScoutAttemptMemory[];
  intel?: TerritoryScoutIntelMemory[];
  scoutOnlyTargets?: RuntimeTerritoryScoutOnlyTargetSummary[];
  concurrency?: RuntimeTerritoryScoutConcurrencySummary;
}

interface RuntimeTerritoryScoutConcurrencySummary {
  activeScoutCount: number;
  cap: number;
  assignedTargetCount?: number;
  scoutsByTargetRoom?: Record<string, number>;
  requestedTargetRooms?: string[];
  staleTargetRooms?: string[];
  duplicateTargetScoutCount?: number;
  surplusScoutCount?: number;
}

type RuntimeTerritoryScoutOnlyTargetStatus = TerritoryScoutAttemptStatus | 'pending' | 'blocked';

interface RuntimeTerritoryScoutOnlyTargetSummary {
  colony: string;
  roomName: string;
  recommendedAction: TerritoryExpansionCandidateRecommendedAction;
  blockReason?: TerritoryExpansionCandidateBlockReason;
  postClaimBootstrapBlocker?: TerritoryPostClaimBootstrapBlockerMemory;
  ignoredPostClaimBootstrapBlockers?: TerritoryPostClaimBootstrapIgnoredBlockerMemory[];
  gateOpen: boolean;
  status: RuntimeTerritoryScoutOnlyTargetStatus;
  requestedAt?: number;
  updatedAt?: number;
  attemptCount?: number;
  intelUpdatedAt?: number;
  sourceCount?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  hostileSpawnCount?: number;
}

interface RuntimeControllerSummary {
  level: number;
  progress?: number;
  progressTotal?: number;
  ticksToDowngrade?: number;
  sign: RuntimeControllerSignSummary | null;
}

interface RuntimeControllerSignSummary {
  text: string | null;
  username?: string;
  time?: number;
  datetime?: string;
}

interface RuntimeStructureSnapshotSummary {
  towerCount: number;
  rampartCount: number;
  extensionCount: number;
  extensionCapacityContribution: number;
  containers: RuntimeContainerSnapshotSummary[];
  repairTargets: RuntimeRepairTargetSnapshotSummary[];
  roadCount: number;
  pendingRoadSiteCount: number;
  roadCoverageRatio: number;
}

interface RuntimeContainerSnapshotSummary {
  id: string;
  energy: number;
  capacity: number;
}

interface RuntimeRepairTargetSnapshotSummary {
  targetId: string;
  repairCount: number;
  structureType?: string;
  hits?: number;
  hitsMax?: number;
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
  harvestedThisTick: number;
  droppedEnergy: number;
  sourceCount: number;
  sourceContainers: SourceContainerCoverageSummary;
  productiveEnergy: RuntimeProductiveEnergySummary;
  energySurplus: RuntimeEnergySurplusSummary;
  multiRoomEnergy?: RuntimeMultiRoomEnergySummary;
  events?: RuntimeResourceEventSummary;
}

interface RuntimeMultiRoomEnergySummary {
  imports: number;
  exports: number;
  localProductionEnergyPerTick: number;
  localConsumptionEnergyPerTick: number;
  netLocalEnergyPerTick: number;
  deficitEnergy: number;
  surplusEnergy: number;
  importDemand: number;
  exportableEnergy: number;
  suppressedImportEnergy: number;
  blockedImportEnergy: number;
  bottleneck?: EconomyMultiRoomEnergyBottleneck;
}

interface RuntimeEnergySurplusSummary {
  surplus: boolean;
  spawnExtensionsFull: boolean;
  containersFull: boolean;
  reservedSpawnEnergy: number;
  unmetSpawnEnergyReservation: number;
  spawnExtensionFreeCapacity: number;
  containerFreeCapacity: number;
  durableFreeCapacity: number;
  storageEnergy: number;
  storageFreeCapacity: number;
  terminalEnergy: number;
  terminalFreeCapacity: number;
  terminalTargetEnergy: number;
  terminalEnergyDeficit: number;
  terminalEnergySurplus: number;
  routedWorkerCount: number;
  routedCarriedEnergy: number;
  selectedSinkId?: string;
  selectedSinkType?: 'storage' | 'terminal';
}

interface RuntimeProductiveEnergySummary {
  workerAssignmentEvidenceAvailable: true;
  assignedWorkerCount: number;
  assignedCarriedEnergy: number;
  buildCarriedEnergy: number;
  repairCarriedEnergy: number;
  upgradeCarriedEnergy: number;
  constructionSiteCount: number;
  constructionDeadlockTicks: number;
  pendingBuildProgress: number;
  repairBacklogHits: number;
  buildBlockedReason?: RuntimeBuildBlockedReason;
  workerAssignmentBlockedDetail?: RuntimeWorkerAssignmentBlockedDetail;
  workerAssignmentBlockedWorkers?: RuntimeWorkerAssignmentBlockedWorkerDetail[];
  controllerProgressRemaining?: number;
}

interface RuntimeWorkerAssignmentEvidenceSummary {
  source: 'runtime-summary';
  available: true;
  tick: number;
  workerCount: number;
  assignedTaskCount: number;
  productiveAssignmentCount: number;
}

interface RuntimeWorkerAssignmentBlockedWorkerDetail {
  buildBlockedReason: RuntimeWorkerBuildAssignmentBlockedReason;
  carriedEnergy: number;
  constructionEnergyGate?: 'blocked_by_buffer_margin';
  dispatchAssignedTargetId?: string;
  dispatchAssignedTask?: string;
  dispatchBaseSelectedTargetId?: string;
  dispatchBaseSelectedTask?: string;
  dispatchCurrentTargetId?: string;
  dispatchEnergyCriticalTargetId?: string;
  dispatchEnergyCriticalTask?: string;
  dispatchReason?: WorkerDispatchDiagnosticReason;
  dispatchSelectedTargetId?: string;
  dispatchSelectedTask?: string;
  dispatchSpawnReservationTargetId?: string;
  dispatchSpawnReservationTask?: string;
  dispatchTick?: number;
  energyBufferAfterSpend?: number;
  energyBufferCurrent?: number;
  energyBufferSpend?: number;
  energyBufferThreshold?: number;
  freeCapacity: number;
  repairBlockedReason: RuntimeWorkerRepairAssignmentBlockedReason;
  name?: string;
  task?: string;
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

interface RuntimeWorkerLoadEfficiencySummary {
  sampleCount: number;
  tripEnergyMean: number;
  tripEnergyMin: number;
}

interface RuntimeBehaviorSummary {
  workerTaskPolicy?: RuntimeWorkerTaskBehaviorSummary;
  creeps?: RuntimeCreepBehaviorSummary[];
  totals?: RuntimeBehaviorTotals;
  topIdleWorkers?: RuntimeCreepBehaviorSummary[];
}

interface RuntimeCreepBehaviorSummary {
  creepName?: string;
  idleTicks: number;
  moveTicks: number;
  workTicks: number;
  stuckTicks: number;
  pathFindingFailures: number;
  destinationBlocked: number;
  containerTransfers: number;
  sourceContainerWithdrawals: number;
  pathLength: number;
  energyAcquisition?: RuntimeEnergyAcquisitionMethodDistribution;
  repairTargetId?: string;
}

interface RuntimeBehaviorTotals {
  idleTicks: number;
  moveTicks: number;
  workTicks: number;
  stuckTicks: number;
  pathFindingFailures: number;
  destinationBlocked: number;
  containerTransfers: number;
  sourceContainerWithdrawals: number;
  pathLength: number;
  energyAcquisition?: RuntimeEnergyAcquisitionMethodDistribution;
}

interface RuntimeWorkerTaskBehaviorSummary {
  schemaVersion: 1;
  sourcePolicyId: string;
  liveEffect: false;
  sampleCount: number;
  actionCounts: Record<WorkerTaskBehaviorActionType, number>;
  samples: RuntimeWorkerTaskBehaviorSampleSummary[];
  omittedSampleCount?: number;
  shadow?: RuntimeWorkerTaskPolicyShadowSummary;
}

interface RuntimeWorkerTaskBehaviorSampleSummary extends WorkerTaskBehaviorSampleMemory {
  creepName?: string;
}

interface RuntimeWorkerTaskBehaviorSampleEntry {
  creepName: string | undefined;
  sample: WorkerTaskBehaviorSampleMemory;
}

interface RuntimeWorkerTaskPolicyShadowSummary {
  policyId: string;
  liveEffect: false;
  sampleCount: number;
  matchedCount: number;
  mismatchCount: number;
  noPredictionCount: number;
  matchRate: number;
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

interface RuntimeWorkerEnergyThroughputSummary {
  sampleCount: number;
  energyDelivered: number;
  deliveryTicks: number;
  activeTicks: number;
  idleOrOtherTaskTicks: number;
  energyPerTick: number;
  deliveryEfficiency: number;
}

interface RuntimeSpawnCriticalRefillSummary {
  assignedWorkerCount: number;
  assignedCarriedEnergy: number;
  threshold: number;
  samples: RuntimeSpawnCriticalRefillSampleSummary[];
  omittedSampleCount?: number;
}

interface RuntimeSpawnCriticalRefillSampleSummary extends WorkerSpawnCriticalRefillMemory {
  creepName?: string;
}

interface RuntimeSpawnCriticalRefillSampleEntry {
  creepName: string | undefined;
  sample: WorkerSpawnCriticalRefillMemory;
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
  policyAction?: ConstructionPriorityScore['policyAction'];
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
  defenseFloor?: RuntimeDefenseFloorSummary;
}

interface RuntimeDefenseFloorSummary {
  ready: boolean;
  assessable: boolean;
  rcl: number;
  anchorReady: boolean;
  towerReady: boolean;
  towerCount: number;
  pendingTowerCount: number;
  spawnRampartReady: boolean;
  wallAnchorCount: number;
  requiredWallAnchorCount: number;
  missingAnchorCount: number;
  repairHitsCeiling: number;
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
  limit?: number;
  tickLimit?: number;
  bucket?: number;
  pressure?: RuntimeCpuPressure;
  alerts?: RuntimeCpuAlert[];
  reasons?: RuntimeCpuPressureReason[];
  lowBucketTicks?: number;
  bucketEmptyTicks?: number;
  overLimitTicks?: number;
}

export interface RuntimeSummary {
  type: 'runtime-summary';
  tick: number;
  rooms: RuntimeRoomSummary[];
  events?: RuntimeTelemetryEvent[];
  omittedEventCount?: number;
  cpu?: RuntimeCpuSummary;
}

interface RuntimeSummaryOptions {
  persistOccupationRecommendations?: boolean;
  strategyRegistry?: StrategyRegistryEntry[];
  onStrategyRegistryRuntimeUse?: (entry: StrategyRegistryEntry) => void;
}

let cachedRefillTargetIdsByRoom = new Map<string, Set<string>>();
let cachedEventMetricsByRoom = new Map<string, RuntimeRoomEventMetrics>();
let cachedEventMetricsTick: number | undefined;

export function emitRuntimeSummary(
  colonies: ColonySnapshot[],
  creeps: Creep[],
  events: RuntimeTelemetryEvent[] = [],
  options: RuntimeSummaryOptions = {}
): RuntimeSummary | undefined {
  if (colonies.length === 0 && events.length === 0) {
    return undefined;
  }

  const tick = getGameTime();
  resetCachedRefillTelemetryIfTickRewound(tick);
  const cpuBudget = getRuntimeCpuBudget();
  const emitsSummary = shouldEmitRuntimeSummary(tick, events, cpuBudget);
  const shouldRefreshRuntimeTelemetry = !shouldThrottleRuntimeSummaryCadence(cpuBudget) || emitsSummary;
  const creepsByColony = groupCreepsByColony(creeps, colonies);
  let refillTargetIdsByRoom = cachedRefillTargetIdsByRoom;
  let eventMetricsByRoom = cachedEventMetricsByRoom;

  if (emitsSummary) {
    refillTargetIdsByRoom = buildRefillTargetIdsByRoom(colonies);
    eventMetricsByRoom = buildRoomEventMetricsByRoom(colonies, refillTargetIdsByRoom);
    cachedRefillTargetIdsByRoom = refillTargetIdsByRoom;
    cachedEventMetricsByRoom = eventMetricsByRoom;
    cachedEventMetricsTick = tick;
  }

  if (shouldRefreshRuntimeTelemetry) {
    refreshRefillTelemetry(
      colonies,
      creepsByColony,
      refillTargetIdsByRoom,
      eventMetricsByRoom,
      tick,
      cachedEventMetricsTick
    );
    refreshConstructionDeadlockTelemetry(colonies, creepsByColony, tick);
  }

  const cpuSummary = buildCpuSummary();
  emitRuntimeCpuSummary(cpuSummary.cpu, tick);
  if (!emitsSummary) {
    return undefined;
  }

  const reportedEvents = events.slice(0, MAX_REPORTED_EVENTS);
  const persistOccupationRecommendations = options.persistOccupationRecommendations !== false;
  const includeOptionalSummary = !shouldThrottleRuntimeSummaryCadence(cpuBudget) && !cpuBudget.critical;
  const rooms = colonies.map((colony) =>
    summarizeRoom(
      colony,
      creepsByColony.get(colony.room.name) ?? [],
      persistOccupationRecommendations,
      eventMetricsByRoom.get(colony.room.name) ?? {},
      shouldBuildStructureSnapshot(tick),
      options.strategyRegistry,
      options.onStrategyRegistryRuntimeUse,
      includeOptionalSummary
    )
  );
  const summary: RuntimeSummary = {
    type: 'runtime-summary',
    tick,
    rooms: applyCpuSummaryToRooms(rooms, cpuSummary.cpu),
    ...(reportedEvents.length > 0 ? { events: reportedEvents } : {}),
    ...(events.length > MAX_REPORTED_EVENTS ? { omittedEventCount: events.length - MAX_REPORTED_EVENTS } : {}),
    ...cpuSummary
  };

  console.log(`${RUNTIME_SUMMARY_PREFIX}${JSON.stringify(summary)}`);
  return summary;
}

export function shouldEmitRuntimeSummary(
  tick: number,
  events: RuntimeTelemetryEvent[],
  cpuBudget = getRuntimeCpuBudget()
): boolean {
  if (events.length > 0) {
    return true;
  }

  const interval = shouldThrottleRuntimeSummaryCadence(cpuBudget)
    ? DEGRADED_RUNTIME_SUMMARY_INTERVAL
    : RUNTIME_SUMMARY_INTERVAL;
  return tick > 0 && tick % interval === 0;
}

function resetCachedRefillTelemetryIfTickRewound(tick: number): void {
  if (cachedEventMetricsTick === undefined || tick >= cachedEventMetricsTick) {
    return;
  }

  cachedRefillTargetIdsByRoom = new Map<string, Set<string>>();
  cachedEventMetricsByRoom = new Map<string, RuntimeRoomEventMetrics>();
  cachedEventMetricsTick = undefined;
}

function groupCreepsByColony(creeps: Creep[], colonies: ColonySnapshot[]): Map<string, Creep[]> {
  const creepsByColony = new Map<string, Creep[]>();
  const colonyNames = new Set(colonies.map((colony) => colony.room.name));

  for (const creep of creeps) {
    const colonyName = creep.memory.colony;
    if (isNonEmptyString(colonyName)) {
      addCreepToColonyGroup(creepsByColony, colonyName, creep);
      continue;
    }

    const roomName = creep.room?.name;
    if (
      creep.memory.role === 'worker' &&
      isNonEmptyString(roomName) &&
      colonyNames.has(roomName) &&
      isRoomLocalWorkerName(creep, roomName)
    ) {
      addCreepToColonyGroup(creepsByColony, roomName, creep);
    }
  }

  return creepsByColony;
}

function addCreepToColonyGroup(creepsByColony: Map<string, Creep[]>, colonyName: string, creep: Creep): void {
  const colonyCreeps = creepsByColony.get(colonyName) ?? [];
  colonyCreeps.push(creep);
  creepsByColony.set(colonyName, colonyCreeps);
}

function isRoomLocalWorkerName(creep: Creep, roomName: string): boolean {
  return typeof creep.name === 'string' && creep.name.startsWith(`worker-${roomName}-`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
  eventMetrics: RuntimeRoomEventMetrics,
  includeStructureSnapshot: boolean,
  strategyRegistry: StrategyRegistryEntry[] | undefined,
  onStrategyRegistryRuntimeUse: ((entry: StrategyRegistryEntry) => void) | undefined,
  includeOptionalSummary: boolean
): RuntimeRoomSummary {
  const tick = getGameTime();
  const colonyWorkers = colonyCreeps.filter((creep) => creep.memory.role === 'worker');
  const roleCounts = countCreepsByRole(colonyCreeps, colony.room.name);
  const territoryExpansion = buildRuntimeExpansionCandidateReport(colony);
  const territoryRecommendation = buildRuntimeOccupationRecommendationReport(
    colony,
    colonyWorkers,
    territoryExpansion
  );
  if (persistOccupationRecommendations) {
    persistOccupationRecommendationFollowUpIntent(territoryRecommendation, tick);
  }
  const resources = summarizeResources(colony, colonyWorkers, colonyCreeps, eventMetrics.resources);
  const taskCounts = countWorkerTasks(colonyWorkers);
  const assignedTaskCount = countAssignedWorkerTasks(colonyWorkers);
  const workerAssignmentEvidence = summarizeWorkerAssignmentEvidence(
    tick,
    colonyWorkers.length,
    assignedTaskCount,
    resources.productiveEnergy.assignedWorkerCount
  );
  const constructionDeadlockTicks = getRoomConstructionDeadlockTicks(colony.room);

  return {
    roomName: colony.room.name,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    energyBufferHealth: getRoomEnergyBufferHealth(colony.room),
    workerCount: colonyWorkers.length,
    workerAssignmentEvidenceAvailable: true,
    workerAssignmentEvidence,
    ...summarizeWorkerAssignmentBlockedRoomFields(resources.productiveEnergy),
    spawnStatus: colony.spawns.map(summarizeSpawn),
    taskCounts,
    constructionSiteCount: resources.productiveEnergy.constructionSiteCount,
    constructionDeadlockTicks,
    ...(includeOptionalSummary ? summarizeRuntimeBehavior(colonyWorkers, colonyCreeps, tick) : {}),
    ...(includeStructureSnapshot ? { structures: summarizeStructures(colony, colonyWorkers) } : {}),
    ...(includeOptionalSummary ? summarizeWorkerEfficiency(colonyWorkers, tick) : {}),
    ...(includeOptionalSummary ? summarizeRefillTelemetry(colonyWorkers, tick) : {}),
    ...summarizeSpawnCriticalRefill(colonyWorkers, tick),
    ...buildControllerSummary(colony.room),
    resources,
    combat: summarizeCombat(colony.room, eventMetrics.combat),
    constructionPriority: includeOptionalSummary
      ? summarizeConstructionPriority(
          colony,
          colonyWorkers,
          strategyRegistry,
          onStrategyRegistryRuntimeUse
        )
      : emptyConstructionPrioritySummary(),
    survival: summarizeSurvival(colony, roleCounts),
    territoryRecommendation: includeOptionalSummary ? territoryRecommendation : emptyTerritoryRecommendationReport(),
    ...(includeOptionalSummary && territoryExpansion.candidates.length > 0 ? { territoryExpansion } : {}),
    ...(includeOptionalSummary ? buildTerritoryIntentSummary(colony.room.name, roleCounts) : {}),
    ...(includeOptionalSummary ? buildTerritoryExecutionHintSummary(colony.room.name) : {}),
    ...(includeOptionalSummary ? buildTerritoryScoutSummary(colony, roleCounts) : {}),
    ...buildPostClaimBootstrapSummary(colony.room.name)
  };
}

function summarizeWorkerAssignmentEvidence(
  tick: number,
  workerCount: number,
  assignedTaskCount: number,
  productiveAssignmentCount: number
): RuntimeWorkerAssignmentEvidenceSummary {
  return {
    source: 'runtime-summary',
    available: true,
    tick,
    workerCount,
    assignedTaskCount,
    productiveAssignmentCount
  };
}

function emptyConstructionPrioritySummary(): RuntimeConstructionPrioritySummary {
  return {
    candidates: [],
    nextPrimary: null
  };
}

function emptyTerritoryRecommendationReport(): OccupationRecommendationReport {
  return {
    candidates: [],
    next: null,
    followUpIntent: null
  };
}

function countAssignedWorkerTasks(workers: Creep[]): number {
  return workers.reduce((assignedCount, worker) => assignedCount + (getWorkerTaskType(worker) ? 1 : 0), 0);
}

function summarizeWorkerAssignmentBlockedRoomFields(
  productiveEnergy: RuntimeProductiveEnergySummary
): Pick<RuntimeRoomSummary, 'workerAssignmentBlockedDetail' | 'workerAssignmentBlockedWorkers'> {
  return {
    ...(productiveEnergy.workerAssignmentBlockedDetail
      ? { workerAssignmentBlockedDetail: productiveEnergy.workerAssignmentBlockedDetail }
      : {}),
    ...(productiveEnergy.workerAssignmentBlockedWorkers
      ? { workerAssignmentBlockedWorkers: productiveEnergy.workerAssignmentBlockedWorkers }
      : {})
  };
}

function buildPostClaimBootstrapSummary(
  roomName: string
): { postClaimBootstrap?: PostClaimBootstrapSummary } {
  const postClaimBootstrap = getPostClaimBootstrapSummary(roomName);
  return postClaimBootstrap ? { postClaimBootstrap } : {};
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

function buildTerritoryScoutSummary(
  colony: ColonySnapshot,
  roleCounts: RoleCounts
): { territoryScout?: RuntimeTerritoryScoutSummary } {
  const colonyName = colony.room.name;
  const summary = getTerritoryScoutSummary(colonyName);
  const scoutOnlyTargets = buildScoutOnlyTargetSummaries(colony, summary);
  const concurrency = buildTerritoryScoutConcurrencySummary(summary, roleCounts, getGameTime());
  if (!summary && scoutOnlyTargets.length === 0 && !concurrency) {
    return {};
  }

  return {
    territoryScout: {
      ...(summary && summary.attempts.length > 0 ? { attempts: summary.attempts } : {}),
      ...(summary && summary.intel.length > 0 ? { intel: summary.intel } : {}),
      ...(scoutOnlyTargets.length > 0 ? { scoutOnlyTargets } : {}),
      ...(concurrency ? { concurrency } : {})
    }
  };
}

function buildTerritoryScoutConcurrencySummary(
  summary: ReturnType<typeof getTerritoryScoutSummary>,
  roleCounts: RoleCounts,
  gameTime: number
): RuntimeTerritoryScoutConcurrencySummary | undefined {
  const requestedTargetRooms = getRequestedScoutTargetRooms(summary);
  const staleTargetRooms = getStaleScoutIntelTargetRooms(summary, gameTime);
  const concurrency = summarizeTerritoryScoutConcurrency(
    roleCounts,
    new Set([...requestedTargetRooms, ...staleTargetRooms]).size
  );
  if (!concurrency) {
    return undefined;
  }

  const hasScoutsByTargetRoom = Object.keys(concurrency.scoutsByTargetRoom).length > 0;
  return {
    activeScoutCount: concurrency.activeScoutCount,
    cap: concurrency.cap,
    ...(concurrency.assignedTargetCount > 0 ? { assignedTargetCount: concurrency.assignedTargetCount } : {}),
    ...(hasScoutsByTargetRoom ? { scoutsByTargetRoom: concurrency.scoutsByTargetRoom } : {}),
    ...(requestedTargetRooms.length > 0 ? { requestedTargetRooms } : {}),
    ...(staleTargetRooms.length > 0 ? { staleTargetRooms } : {}),
    ...(concurrency.duplicateTargetScoutCount > 0
      ? { duplicateTargetScoutCount: concurrency.duplicateTargetScoutCount }
      : {}),
    ...(concurrency.surplusScoutCount > 0 ? { surplusScoutCount: concurrency.surplusScoutCount } : {})
  };
}

function getRequestedScoutTargetRooms(summary: ReturnType<typeof getTerritoryScoutSummary>): string[] {
  return getUniqueSortedRoomNames(
    (summary?.attempts ?? [])
      .filter((attempt) => attempt.status === 'requested')
      .map((attempt) => attempt.roomName)
  );
}

function getStaleScoutIntelTargetRooms(
  summary: ReturnType<typeof getTerritoryScoutSummary>,
  gameTime: number
): string[] {
  return getUniqueSortedRoomNames(
    (summary?.intel ?? [])
      .filter(
        (intel) =>
          gameTime >= intel.updatedAt &&
          gameTime - intel.updatedAt > TERRITORY_SCOUT_VALIDATION_TIMEOUT_TICKS
      )
      .map((intel) => intel.roomName)
  );
}

function getUniqueSortedRoomNames(roomNames: string[]): string[] {
  return [...new Set(roomNames.filter(isNonEmptyString))].sort();
}

function buildScoutOnlyTargetSummaries(
  colony: ColonySnapshot,
  summary: ReturnType<typeof getTerritoryScoutSummary>
): RuntimeTerritoryScoutOnlyTargetSummary[] {
  const colonyName = colony.room.name;
  const attemptsByRoom = new Map((summary?.attempts ?? []).map((attempt) => [attempt.roomName, attempt]));
  const intelByRoom = new Map((summary?.intel ?? []).map((intel) => [intel.roomName, intel]));
  const expansionCandidatesByRoom = getScoutOnlyExpansionCandidatesByRoom(colonyName);
  const seenRooms = new Set<string>();

  return getTerritoryExpansionScoutTargets(colonyName).flatMap((target) => {
    if (target.colony !== colonyName || target.scoutOnly !== true || seenRooms.has(target.roomName)) {
      return [];
    }
    seenRooms.add(target.roomName);

    const attempt = attemptsByRoom.get(target.roomName);
    const intel = intelByRoom.get(target.roomName);
    const expansionCandidate = expansionCandidatesByRoom.get(target.roomName);
    const gateOpen = isPassiveScoutGateOpen(colony, target.roomName);
    return [
      {
        colony: colonyName,
        roomName: target.roomName,
        recommendedAction: expansionCandidate?.recommendedAction ?? 'scout',
        ...(expansionCandidate?.blockReason ? { blockReason: expansionCandidate.blockReason } : {}),
        ...(expansionCandidate?.postClaimBootstrapBlocker
          ? { postClaimBootstrapBlocker: expansionCandidate.postClaimBootstrapBlocker }
          : {}),
        ...(expansionCandidate?.ignoredPostClaimBootstrapBlockers?.length
          ? { ignoredPostClaimBootstrapBlockers: expansionCandidate.ignoredPostClaimBootstrapBlockers }
          : {}),
        gateOpen,
        status: getScoutOnlyTargetStatus(gateOpen, attempt, intel),
        ...(attempt?.requestedAt !== undefined ? { requestedAt: attempt.requestedAt } : {}),
        ...(attempt?.updatedAt !== undefined ? { updatedAt: attempt.updatedAt } : {}),
        ...(attempt?.attemptCount !== undefined ? { attemptCount: attempt.attemptCount } : {}),
        ...(intel?.updatedAt !== undefined ? { intelUpdatedAt: intel.updatedAt } : {}),
        ...(intel?.sourceCount !== undefined ? { sourceCount: intel.sourceCount } : {}),
        ...(intel?.hostileCreepCount !== undefined ? { hostileCreepCount: intel.hostileCreepCount } : {}),
        ...(intel?.hostileStructureCount !== undefined ? { hostileStructureCount: intel.hostileStructureCount } : {}),
        ...(intel?.hostileSpawnCount !== undefined ? { hostileSpawnCount: intel.hostileSpawnCount } : {})
      }
    ];
  });
}

function getScoutOnlyExpansionCandidatesByRoom(
  colonyName: string
): Map<
  string,
  Pick<
    TerritoryExpansionCandidateMemory,
    | 'recommendedAction'
    | 'blockReason'
    | 'postClaimBootstrapBlocker'
    | 'ignoredPostClaimBootstrapBlockers'
  >
> {
  const candidates = Memory.territory?.expansionCandidates;
  if (!Array.isArray(candidates)) {
    return new Map();
  }

  const candidatesByRoom = new Map<
    string,
    Pick<
      TerritoryExpansionCandidateMemory,
      | 'recommendedAction'
      | 'blockReason'
      | 'postClaimBootstrapBlocker'
      | 'ignoredPostClaimBootstrapBlockers'
    >
  >();
  for (const rawCandidate of candidates) {
    if (
      !isRecord(rawCandidate) ||
      rawCandidate.colony !== colonyName ||
      rawCandidate.scoutOnly !== true ||
      !isNonEmptyString(rawCandidate.roomName)
    ) {
      continue;
    }

    candidatesByRoom.set(rawCandidate.roomName, {
      recommendedAction: isExpansionCandidateRecommendedAction(rawCandidate.recommendedAction)
        ? rawCandidate.recommendedAction
        : 'scout',
      ...(isExpansionCandidateBlockReason(rawCandidate.blockReason)
        ? { blockReason: rawCandidate.blockReason }
        : {}),
      ...(isPostClaimBootstrapBlockerMemory(rawCandidate.postClaimBootstrapBlocker)
        ? { postClaimBootstrapBlocker: rawCandidate.postClaimBootstrapBlocker }
        : {}),
      ...(Array.isArray(rawCandidate.ignoredPostClaimBootstrapBlockers)
        ? {
            ignoredPostClaimBootstrapBlockers: rawCandidate.ignoredPostClaimBootstrapBlockers.filter(
              (blocker): blocker is TerritoryPostClaimBootstrapIgnoredBlockerMemory =>
                isPostClaimBootstrapIgnoredBlockerMemory(blocker) && blocker.colony === rawCandidate.colony
            )
          }
        : {})
    });
  }

  return candidatesByRoom;
}

function isPostClaimBootstrapBlockerMemory(
  value: unknown
): value is TerritoryPostClaimBootstrapBlockerMemory {
  return (
    isRecord(value) &&
    isNonEmptyString(value.colony) &&
    isNonEmptyString(value.roomName) &&
    isPostClaimBootstrapStatus(value.status) &&
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.age) &&
    isFiniteNumber(value.workerTarget) &&
    isFiniteNumber(value.spawnCount) &&
    isFiniteNumber(value.workerCount)
  );
}

function isPostClaimBootstrapIgnoredBlockerMemory(
  value: unknown
): value is TerritoryPostClaimBootstrapIgnoredBlockerMemory {
  if (!isRecord(value)) {
    return false;
  }

  const reason = value.reason;
  return isPostClaimBootstrapBlockerMemory(value) && isPostClaimBootstrapIgnoredBlockerReason(reason);
}

function isPostClaimBootstrapIgnoredBlockerReason(
  value: unknown
): value is TerritoryPostClaimBootstrapIgnoredBlockerReason {
  return value === 'ready' || value === 'notVisibleOwnedRoom' || value === 'workerTargetSatisfied';
}

function isPostClaimBootstrapStatus(value: unknown): value is TerritoryPostClaimBootstrapStatus {
  return (
    value === 'detected' ||
    value === 'spawnSitePending' ||
    value === 'spawnSiteBlocked' ||
    value === 'spawningWorkers' ||
    value === 'ready'
  );
}

function isExpansionCandidateRecommendedAction(
  action: unknown
): action is TerritoryExpansionCandidateRecommendedAction {
  return action === 'claim' || action === 'reserve' || action === 'scout';
}

function isExpansionCandidateBlockReason(
  reason: unknown
): reason is TerritoryExpansionCandidateBlockReason {
  return (
    reason === 'insufficientEvidence' ||
    reason === 'targetUnavailable' ||
    reason === 'targetHostile' ||
    reason === 'controllerMissing' ||
    reason === 'controllerOwned' ||
    reason === 'controllerReserved' ||
    reason === 'sourcesMissing' ||
    reason === 'controllerRangeMissing' ||
    reason === 'terrainMissing' ||
    reason === 'energyCapacityLow' ||
    reason === 'energyBufferLow' ||
    reason === 'cpuBucketLow' ||
    reason === 'homeAlertActive' ||
    reason === 'controllerLevelLow' ||
    reason === 'homeDowngradeGuard' ||
    reason === 'postClaimBootstrapActive' ||
    reason === 'gclInsufficient' ||
    reason === 'roomLimitReached' ||
    reason === 'routeUnavailable'
  );
}

function getScoutOnlyTargetStatus(
  gateOpen: boolean,
  attempt: TerritoryScoutAttemptMemory | undefined,
  intel: TerritoryScoutIntelMemory | undefined
): RuntimeTerritoryScoutOnlyTargetStatus {
  if (attempt) {
    return attempt.status;
  }

  if (intel) {
    return 'observed';
  }

  return gateOpen ? 'pending' : 'blocked';
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

function refreshConstructionDeadlockTelemetry(
  colonies: ColonySnapshot[],
  creepsByColony: Map<string, Creep[]>,
  tick: number
): void {
  for (const colony of colonies) {
    const colonyWorkers = (creepsByColony.get(colony.room.name) ?? []).filter((creep) => creep.memory.role === 'worker');
    const taskCounts = countWorkerTasks(colonyWorkers);
    const constructionSiteCount = (findRoomObjects(colony.room, 'FIND_MY_CONSTRUCTION_SITES') ?? []).length;
    updateRoomConstructionDeadlockTicks(colony.room, taskCounts, constructionSiteCount, tick);
  }
}

function updateRoomConstructionDeadlockTicks(
  room: Room,
  taskCounts: WorkerTaskCounts,
  constructionSiteCount: number,
  tick: number
): number {
  const runtimeMemory = ensureRoomRuntimeMemory(room);
  const previousTicks = normalizeNonNegativeInteger(runtimeMemory.constructionDeadlockTicks);
  const previousUpdatedAt = normalizeNonNegativeInteger(runtimeMemory.constructionDeadlockUpdatedAt);

  if (previousUpdatedAt === tick) {
    return previousTicks;
  }

  const nextTicks = taskCounts.build === 0 && constructionSiteCount > 0 ? previousTicks + 1 : 0;
  runtimeMemory.constructionDeadlockTicks = nextTicks;
  runtimeMemory.constructionDeadlockUpdatedAt = tick;
  return nextTicks;
}

function getRoomConstructionDeadlockTicks(room: Room): number {
  return normalizeNonNegativeInteger(ensureRoomRuntimeMemory(room).constructionDeadlockTicks);
}

function ensureRoomRuntimeMemory(room: Room): RoomRuntimeMemory {
  const memoryWithRooms = Memory as Memory & { rooms?: Record<string, RoomMemory> };
  if (!memoryWithRooms.rooms) {
    memoryWithRooms.rooms = {};
  }

  const roomMemory = memoryWithRooms.rooms[room.name] ?? (memoryWithRooms.rooms[room.name] = {} as RoomMemory);
  if (!roomMemory.runtime) {
    roomMemory.runtime = {};
  }
  return roomMemory.runtime;
}

function normalizeNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function isWorkerTaskType(taskType: string | undefined): taskType is WorkerTaskType {
  return WORKER_TASK_TYPES.includes(taskType as WorkerTaskType);
}

function summarizeBehavior(workers: Creep[], tick: number): { behavior?: RuntimeBehaviorSummary } {
  const samples = workers
    .map((worker) => ({ creepName: getCreepName(worker), sample: worker.memory.workerBehavior }))
    .filter(
      (entry): entry is RuntimeWorkerTaskBehaviorSampleEntry =>
        isWorkerTaskBehaviorSample(entry.sample) && isRecentWorkerTaskBehaviorSample(entry.sample, tick)
    )
    .sort(compareWorkerTaskBehaviorSampleEntries);

  if (samples.length === 0) {
    return {};
  }

  const reportedSamples = samples.slice(0, MAX_WORKER_BEHAVIOR_SAMPLES).map(toRuntimeWorkerTaskBehaviorSample);

  return {
    behavior: {
      workerTaskPolicy: {
        schemaVersion: 1,
        sourcePolicyId: HEURISTIC_WORKER_TASK_POLICY_ID,
        liveEffect: false,
        sampleCount: samples.length,
        actionCounts: countWorkerBehaviorActions(samples),
        samples: reportedSamples,
        ...(samples.length > MAX_WORKER_BEHAVIOR_SAMPLES
          ? { omittedSampleCount: samples.length - MAX_WORKER_BEHAVIOR_SAMPLES }
          : {}),
        ...summarizeWorkerTaskPolicyShadow(workers, tick)
      }
    }
  };
}

function summarizeRuntimeBehavior(
  workers: Creep[],
  behaviorCreeps: Creep[],
  tick: number
): { behavior?: RuntimeBehaviorSummary } {
  const workerTaskPolicySummary = summarizeBehavior(workers, tick);
  const legacySummary: BehaviorTelemetrySummary = summarizeAndResetCreepBehaviorTelemetry(behaviorCreeps);

  if (!workerTaskPolicySummary.behavior && !legacySummary.behavior) {
    return {};
  }

  return {
    behavior: {
      ...legacySummary.behavior,
      ...workerTaskPolicySummary.behavior
    }
  };
}

function countWorkerBehaviorActions(
  samples: RuntimeWorkerTaskBehaviorSampleEntry[]
): Record<WorkerTaskBehaviorActionType, number> {
  const counts = Object.fromEntries(WORKER_TASK_BC_ACTION_TYPES.map((action) => [action, 0])) as Record<
    WorkerTaskBehaviorActionType,
    number
  >;
  for (const entry of samples) {
    counts[entry.sample.action.type] += 1;
  }

  return counts;
}

function summarizeWorkerTaskPolicyShadow(
  workers: Creep[],
  tick: number
): { shadow?: RuntimeWorkerTaskPolicyShadowSummary } {
  const shadows = workers
    .map((worker) => worker.memory.workerTaskPolicyShadow)
    .filter((shadow): shadow is WorkerTaskPolicyShadowMemory => isRecentWorkerTaskPolicyShadow(shadow, tick));

  if (shadows.length === 0) {
    return {};
  }

  const matchedCount = shadows.filter((shadow) => shadow.matched).length;
  const mismatchCount = shadows.filter((shadow) => shadow.fallbackReason === 'actionMismatch').length;
  const noPredictionCount = shadows.filter(
    (shadow) => shadow.fallbackReason === 'untrainedModel' || shadow.fallbackReason === 'lowConfidence'
  ).length;

  return {
    shadow: {
      policyId: shadows[0].policyId,
      liveEffect: false,
      sampleCount: shadows.length,
      matchedCount,
      mismatchCount,
      noPredictionCount,
      matchRate: roundRatio(matchedCount, shadows.length)
    }
  };
}

function compareWorkerTaskBehaviorSampleEntries(
  left: RuntimeWorkerTaskBehaviorSampleEntry,
  right: RuntimeWorkerTaskBehaviorSampleEntry
): number {
  return (
    right.sample.tick - left.sample.tick ||
    (left.creepName ?? '').localeCompare(right.creepName ?? '') ||
    left.sample.action.type.localeCompare(right.sample.action.type) ||
    left.sample.action.targetId.localeCompare(right.sample.action.targetId)
  );
}

function toRuntimeWorkerTaskBehaviorSample(
  entry: RuntimeWorkerTaskBehaviorSampleEntry
): RuntimeWorkerTaskBehaviorSampleSummary {
  return {
    ...(entry.creepName ? { creepName: entry.creepName } : {}),
    ...entry.sample
  };
}

function isRecentWorkerTaskBehaviorSample(sample: WorkerTaskBehaviorSampleMemory, tick: number): boolean {
  if (tick <= 0) {
    return true;
  }

  return sample.tick <= tick && sample.tick > tick - WORKER_BEHAVIOR_SAMPLE_TTL;
}

function isWorkerTaskBehaviorSample(value: unknown): value is WorkerTaskBehaviorSampleMemory {
  return (
    isRecord(value) &&
    value.type === 'workerTaskBehavior' &&
    value.schemaVersion === 1 &&
    typeof value.tick === 'number' &&
    Number.isFinite(value.tick) &&
    typeof value.policyId === 'string' &&
    value.liveEffect === false &&
    isRecord(value.state) &&
    isRecord(value.action) &&
    isWorkerTaskBehaviorActionType(value.action.type) &&
    typeof value.action.targetId === 'string'
  );
}

function isRecentWorkerTaskPolicyShadow(value: unknown, tick: number): value is WorkerTaskPolicyShadowMemory {
  if (!isWorkerTaskPolicyShadow(value)) {
    return false;
  }

  return tick <= 0 || (value.tick <= tick && value.tick > tick - WORKER_BEHAVIOR_SAMPLE_TTL);
}

function isWorkerTaskPolicyShadow(value: unknown): value is WorkerTaskPolicyShadowMemory {
  return (
    isRecord(value) &&
    value.type === 'workerTaskPolicyShadow' &&
    value.schemaVersion === 1 &&
    typeof value.tick === 'number' &&
    Number.isFinite(value.tick) &&
    typeof value.policyId === 'string' &&
    value.liveEffect === false &&
    typeof value.matched === 'boolean'
  );
}

function shouldBuildStructureSnapshot(tick: number): boolean {
  return tick > 0 && tick % RUNTIME_SUMMARY_INTERVAL === 0;
}

function summarizeStructures(colony: ColonySnapshot, colonyWorkers: Creep[]): RuntimeStructureSnapshotSummary {
  const roomStructures = findRoomObjects(colony.room, 'FIND_STRUCTURES') ?? colony.spawns;
  const constructionSites = findRoomObjects(colony.room, 'FIND_MY_CONSTRUCTION_SITES') ?? [];
  const roadCount = countStructuresByType(roomStructures, 'STRUCTURE_ROAD', 'road');
  const pendingRoadSiteCount = countConstructionSitesByType(constructionSites, 'STRUCTURE_ROAD', 'road');
  const extensions = roomStructures.filter((structure) =>
    isStructureOfType(structure, 'STRUCTURE_EXTENSION', 'extension')
  );

  return {
    towerCount: countStructuresByType(roomStructures, 'STRUCTURE_TOWER', 'tower'),
    rampartCount: countOwnedRamparts(roomStructures),
    extensionCount: extensions.length,
    extensionCapacityContribution: sumExtensionCapacityContribution(extensions),
    containers: summarizeContainers(roomStructures),
    repairTargets: summarizeRepairTargetDistribution(colonyWorkers, roomStructures),
    roadCount,
    pendingRoadSiteCount,
    roadCoverageRatio: calculateRoadCoverageRatio(roadCount, pendingRoadSiteCount)
  };
}

function sumExtensionCapacityContribution(extensions: unknown[]): number {
  return extensions.reduce<number>((total, extension) => {
    const capacity = getEnergyCapacityInStore(extension);
    return total + (capacity > 0 ? capacity : DEFAULT_EXTENSION_ENERGY_CAPACITY);
  }, 0);
}

function countStructuresByType(
  structures: unknown[],
  globalName: StructureConstantGlobal,
  fallback: string
): number {
  return structures.filter((structure) => isStructureOfType(structure, globalName, fallback)).length;
}

function countConstructionSitesByType(
  constructionSites: unknown[],
  globalName: StructureConstantGlobal,
  fallback: string
): number {
  return constructionSites.filter((site) => isStructureOfType(site, globalName, fallback)).length;
}

function countOwnedRamparts(structures: unknown[]): number {
  return structures.filter((structure) => isRecord(structure) && isObservedOwnedRampart(structure)).length;
}

function summarizeContainers(structures: unknown[]): RuntimeContainerSnapshotSummary[] {
  return structures
    .filter((structure) => isStructureOfType(structure, 'STRUCTURE_CONTAINER', 'container'))
    .map(toRuntimeContainerSnapshot)
    .filter((summary): summary is RuntimeContainerSnapshotSummary => summary !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function toRuntimeContainerSnapshot(structure: unknown): RuntimeContainerSnapshotSummary | null {
  const id = getObjectId(structure);
  if (!id) {
    return null;
  }

  return {
    id,
    energy: getEnergyInStore(structure),
    capacity: getEnergyCapacityInStore(structure)
  };
}

function summarizeRepairTargetDistribution(
  colonyWorkers: Creep[],
  roomStructures: unknown[]
): RuntimeRepairTargetSnapshotSummary[] {
  const repairCounts = new Map<string, number>();
  for (const worker of colonyWorkers) {
    const task = worker.memory.task;
    if (task?.type !== 'repair') {
      continue;
    }

    const targetId = String(task.targetId);
    repairCounts.set(targetId, (repairCounts.get(targetId) ?? 0) + 1);
  }

  const structuresById = new Map<string, unknown>();
  for (const structure of roomStructures) {
    const id = getObjectId(structure);
    if (id) {
      structuresById.set(id, structure);
    }
  }

  return [...repairCounts.entries()]
    .sort(([leftTargetId], [rightTargetId]) => leftTargetId.localeCompare(rightTargetId))
    .map(([targetId, repairCount]) => toRuntimeRepairTargetSnapshot(targetId, repairCount, structuresById.get(targetId)));
}

function toRuntimeRepairTargetSnapshot(
  targetId: string,
  repairCount: number,
  structure: unknown
): RuntimeRepairTargetSnapshotSummary {
  const structureRecord = isRecord(structure) ? structure : {};
  const structureType = typeof structureRecord.structureType === 'string' ? structureRecord.structureType : undefined;
  const hits = getFiniteNumber(structureRecord.hits);
  const hitsMax = getFiniteNumber(structureRecord.hitsMax);

  return {
    targetId,
    repairCount,
    ...(structureType ? { structureType } : {}),
    ...(hits !== null ? { hits } : {}),
    ...(hitsMax !== null ? { hitsMax } : {})
  };
}

function isStructureOfType(structure: unknown, globalName: StructureConstantGlobal, fallback: string): boolean {
  return isRecord(structure) && matchesStructureType(structure.structureType, globalName, fallback);
}

function calculateRoadCoverageRatio(roadCount: number, pendingRoadSiteCount: number): number {
  const totalKnownRoadWork = roadCount + pendingRoadSiteCount;
  if (totalKnownRoadWork <= 0) {
    return 0;
  }

  return roundRatio(roadCount, totalKnownRoadWork);
}

function summarizeWorkerEfficiency(
  workers: Creep[],
  tick: number
): {
  workerEfficiency?: RuntimeWorkerEfficiencySummary;
  workerLoadEfficiency?: RuntimeWorkerLoadEfficiencySummary;
} {
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
  const workerLoadEfficiency = summarizeWorkerLoadEfficiency(
    lowLoadReturnSamples.length > 0 ? lowLoadReturnSamples : samples
  );

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
    },
    ...(workerLoadEfficiency ? { workerLoadEfficiency } : {})
  };
}

function summarizeWorkerLoadEfficiency(
  samples: RuntimeWorkerEfficiencySampleEntry[]
): RuntimeWorkerLoadEfficiencySummary | null {
  const tripEnergies = samples
    .map((entry) => entry.sample.carriedEnergy)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (tripEnergies.length === 0) {
    return null;
  }

  return {
    sampleCount: tripEnergies.length,
    tripEnergyMean: roundRatio(tripEnergies.reduce((total, value) => total + value, 0), tripEnergies.length),
    tripEnergyMin: Math.min(...tripEnergies)
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
  workerEnergyThroughput?: RuntimeWorkerEnergyThroughputSummary;
} {
  return {
    ...summarizeRefillDeliveryTicks(workers, tick),
    ...summarizeRefillWorkerUtilization(workers),
    ...summarizeWorkerEnergyThroughput(workers, tick)
  };
}

function summarizeRefillDeliveryTicks(
  workers: Creep[],
  tick: number
): { refillDeliveryTicks?: RuntimeRefillDeliveryTicksSummary } {
  const samples = getRecentRefillDeliverySampleEntries(workers, tick);

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

function getRecentRefillDeliverySampleEntries(
  workers: Creep[],
  tick: number
): RuntimeRefillDeliverySampleEntry[] {
  return workers
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
}

function summarizeWorkerEnergyThroughput(
  workers: Creep[],
  tick: number
): { workerEnergyThroughput?: RuntimeWorkerEnergyThroughputSummary } {
  const samples = getRecentRefillDeliverySampleEntries(workers, tick);
  if (samples.length === 0) {
    return {};
  }

  const energyDelivered = samples.reduce((total, entry) => total + Math.max(0, entry.sample.energyDelivered), 0);
  const deliveryTicks = samples.reduce((total, entry) => total + Math.max(0, entry.sample.deliveryTicks), 0);
  const activeTicks = samples.reduce((total, entry) => total + Math.max(0, entry.sample.activeTicks), 0);
  const idleOrOtherTaskTicks = samples.reduce(
    (total, entry) => total + Math.max(0, entry.sample.idleOrOtherTaskTicks),
    0
  );

  return {
    workerEnergyThroughput: {
      sampleCount: samples.length,
      energyDelivered,
      deliveryTicks,
      activeTicks,
      idleOrOtherTaskTicks,
      energyPerTick: roundRatio(energyDelivered, deliveryTicks),
      deliveryEfficiency: roundRatio(activeTicks, activeTicks + idleOrOtherTaskTicks)
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

function summarizeSpawnCriticalRefill(
  workers: Creep[],
  tick: number
): { spawnCriticalRefill?: RuntimeSpawnCriticalRefillSummary } {
  const samples = workers
    .map((worker) => ({ creepName: getCreepName(worker), sample: worker.memory.spawnCriticalRefill }))
    .filter((entry): entry is RuntimeSpawnCriticalRefillSampleEntry =>
      isRecentSpawnCriticalRefillSample(entry.sample, tick)
    )
    .sort(compareSpawnCriticalRefillSampleEntries);

  if (samples.length === 0) {
    return {};
  }

  const reportedSamples = samples.slice(0, MAX_SPAWN_CRITICAL_REFILL_SAMPLES).map(toRuntimeSpawnCriticalRefillSample);
  const assignedCarriedEnergy = samples.reduce((total, entry) => total + Math.max(0, entry.sample.carriedEnergy), 0);

  return {
    spawnCriticalRefill: {
      assignedWorkerCount: samples.length,
      assignedCarriedEnergy,
      threshold: samples[0].sample.threshold,
      samples: reportedSamples,
      ...(samples.length > MAX_SPAWN_CRITICAL_REFILL_SAMPLES
        ? { omittedSampleCount: samples.length - MAX_SPAWN_CRITICAL_REFILL_SAMPLES }
        : {})
    }
  };
}

function compareSpawnCriticalRefillSampleEntries(
  left: RuntimeSpawnCriticalRefillSampleEntry,
  right: RuntimeSpawnCriticalRefillSampleEntry
): number {
  return (
    right.sample.tick - left.sample.tick ||
    (left.creepName ?? '').localeCompare(right.creepName ?? '') ||
    left.sample.targetId.localeCompare(right.sample.targetId)
  );
}

function toRuntimeSpawnCriticalRefillSample(
  entry: RuntimeSpawnCriticalRefillSampleEntry
): RuntimeSpawnCriticalRefillSampleSummary {
  return {
    ...(entry.creepName ? { creepName: entry.creepName } : {}),
    ...entry.sample
  };
}

function isRecentSpawnCriticalRefillSample(
  sample: unknown,
  tick: number
): sample is WorkerSpawnCriticalRefillMemory {
  return (
    isSpawnCriticalRefillSample(sample) &&
    (tick <= 0 || (sample.tick <= tick && sample.tick > tick - SPAWN_CRITICAL_REFILL_SAMPLE_TTL))
  );
}

function isSpawnCriticalRefillSample(value: unknown): value is WorkerSpawnCriticalRefillMemory {
  return (
    isRecord(value) &&
    value.type === 'spawnCriticalRefill' &&
    typeof value.tick === 'number' &&
    Number.isFinite(value.tick) &&
    typeof value.targetId === 'string' &&
    typeof value.carriedEnergy === 'number' &&
    Number.isFinite(value.carriedEnergy) &&
    typeof value.spawnEnergy === 'number' &&
    Number.isFinite(value.spawnEnergy) &&
    typeof value.freeCapacity === 'number' &&
    Number.isFinite(value.freeCapacity) &&
    typeof value.threshold === 'number' &&
    Number.isFinite(value.threshold)
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
    level: controller.level,
    sign: summarizeControllerSign(controller.sign)
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

function summarizeControllerSign(sign: unknown): RuntimeControllerSignSummary | null {
  if (!isRecord(sign)) {
    return null;
  }
  const datetime = summarizeControllerSignDatetime(sign.datetime);

  return {
    text: typeof sign.text === 'string' ? sign.text : null,
    ...(typeof sign.username === 'string' ? { username: sign.username } : {}),
    ...(typeof sign.time === 'number' && Number.isFinite(sign.time) ? { time: sign.time } : {}),
    ...(datetime ? { datetime } : {})
  };
}

function summarizeControllerSignDatetime(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }

  return undefined;
}

function summarizeResources(
  colony: ColonySnapshot,
  colonyWorkers: Creep[],
  colonyCreeps: Creep[],
  events: RuntimeResourceEventSummary | undefined
): RuntimeResourceSummary {
  const roomStructures = findRoomObjects(colony.room, 'FIND_STRUCTURES') ?? colony.spawns;
  const roomEnergyStructures = findRoomEnergyStoreStructures(colony.room, colony.spawns);
  const roomCreeps = findOwnedRoomCreeps(colony.room, colonyCreeps);
  const constructionSites = findRoomObjects(colony.room, 'FIND_MY_CONSTRUCTION_SITES') ?? [];
  const droppedResources = findRoomObjects(colony.room, 'FIND_DROPPED_RESOURCES') ?? [];
  const sourceContainerCoverage = summarizeSourceContainerCoverage(colony.room);

  return {
    storedEnergy: summarizeStoredEnergy(colony, roomEnergyStructures),
    workerCarriedEnergy: sumEnergyInStores(roomCreeps),
    harvestedThisTick: events?.harvestedEnergy ?? 0,
    droppedEnergy: sumDroppedEnergy(droppedResources),
    sourceCount: sourceContainerCoverage.sourceCount,
    sourceContainers: sourceContainerCoverage,
    productiveEnergy: summarizeProductiveEnergy(
      colony,
      colonyWorkers,
      constructionSites,
      roomStructures,
      roomEnergyStructures,
      events
    ),
    energySurplus: summarizeEnergySurplus(colony.room, colonyWorkers),
    ...summarizeMultiRoomEnergy(colony.room.name),
    ...(events ? { events } : {})
  };
}

function summarizeMultiRoomEnergy(roomName: string): { multiRoomEnergy?: RuntimeMultiRoomEnergySummary } {
  const state = getMultiRoomEnergyRoomState(roomName);
  if (!state) {
    return {};
  }

  return {
    multiRoomEnergy: {
      imports: state.plannedImportEnergy,
      exports: state.plannedExportEnergy,
      localProductionEnergyPerTick: state.localProductionEnergyPerTick,
      localConsumptionEnergyPerTick: state.localConsumptionEnergyPerTick,
      netLocalEnergyPerTick: state.netLocalEnergyPerTick,
      deficitEnergy: state.deficitEnergy,
      surplusEnergy: state.surplusEnergy,
      importDemand: state.importDemand,
      exportableEnergy: state.exportableEnergy,
      suppressedImportEnergy: state.suppressedImportEnergy,
      blockedImportEnergy: state.blockedImportEnergy,
      ...(state.bottleneck ? { bottleneck: state.bottleneck } : {})
    }
  };
}

function findRoomEnergyStoreStructures(room: Room, spawns: StructureSpawn[]): unknown[] {
  const allStructures = findRoomObjects(room, 'FIND_STRUCTURES');
  const myStructures = findRoomObjects(room, 'FIND_MY_STRUCTURES');
  const discoveredStructures = [...(allStructures ?? []), ...(myStructures ?? [])];

  return uniqueRoomObjects([
    ...discoveredStructures,
    ...(discoveredStructures.length === 0 ? spawns : []),
    ...getDirectRoomEnergyStructures(room)
  ]).filter(isRoomEnergyStoreStructure);
}

function getDirectRoomEnergyStructures(room: Room): unknown[] {
  const roomWithDurableStores = room as Room & {
    storage?: unknown;
    terminal?: unknown;
  };
  return [roomWithDurableStores.storage, roomWithDurableStores.terminal].filter(
    (structure) => structure !== undefined && structure !== null
  );
}

function isRoomEnergyStoreStructure(structure: unknown): boolean {
  if (!isRecord(structure)) {
    return false;
  }

  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_LINK', 'link') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_TERMINAL', 'terminal')
  );
}

function summarizeStoredEnergy(colony: ColonySnapshot, roomEnergyStructures: unknown[]): number {
  return Math.max(sumEnergyInStores(roomEnergyStructures), getRoomEnergyAvailable(colony));
}

function getRoomEnergyAvailable(colony: ColonySnapshot): number {
  return Math.max(
    normalizeEnergyAmount((colony.room as Room & { energyAvailable?: unknown }).energyAvailable),
    normalizeEnergyAmount(colony.energyAvailable)
  );
}

function findOwnedRoomCreeps(room: Room, colonyCreeps: Creep[]): unknown[] {
  return uniqueRoomObjects([
    ...(findRoomObjects(room, 'FIND_MY_CREEPS') ?? []),
    ...colonyCreeps
  ]);
}

function summarizeEnergySurplus(room: Room, colonyWorkers: Creep[]): RuntimeEnergySurplusSummary {
  const state = getRoomEnergySurplusState(room);
  const surplusSinkIds = getEnergySurplusSinkIds(state);
  const routedWorkers = colonyWorkers.filter((worker) => {
    const task = worker.memory.task;
    return task?.type === 'transfer' && surplusSinkIds.has(String(task.targetId));
  });

  return {
    surplus: state.surplus,
    spawnExtensionsFull: state.spawnExtensionsFull,
    containersFull: state.containersFull,
    reservedSpawnEnergy: state.reservedSpawnEnergy,
    unmetSpawnEnergyReservation: state.unmetSpawnEnergyReservation,
    spawnExtensionFreeCapacity: state.spawnExtensionFreeCapacity,
    containerFreeCapacity: state.containerFreeCapacity,
    durableFreeCapacity: state.durableFreeCapacity,
    storageEnergy: state.storageEnergy,
    storageFreeCapacity: state.storageFreeCapacity,
    terminalEnergy: state.terminalEnergy,
    terminalFreeCapacity: state.terminalFreeCapacity,
    terminalTargetEnergy: state.terminalTargetEnergy,
    terminalEnergyDeficit: state.terminalEnergyDeficit,
    terminalEnergySurplus: state.terminalEnergySurplus,
    routedWorkerCount: routedWorkers.length,
    routedCarriedEnergy: sumEnergyInStores(routedWorkers),
    ...(state.selectedSinkId ? { selectedSinkId: state.selectedSinkId } : {}),
    ...(state.selectedSinkType ? { selectedSinkType: state.selectedSinkType } : {})
  };
}

function getEnergySurplusSinkIds(state: RoomEnergySurplusState): Set<string> {
  const ids = new Set<string>();
  if (state.selectedSinkId) {
    ids.add(state.selectedSinkId);
  }

  return ids;
}

function summarizeProductiveEnergy(
  colony: ColonySnapshot,
  colonyWorkers: Creep[],
  constructionSites: unknown[],
  roomStructures: unknown[],
  roomEnergyStructures: unknown[],
  events: RuntimeResourceEventSummary | undefined
): RuntimeProductiveEnergySummary {
  const productiveAssignments = summarizeProductiveWorkerAssignments(colonyWorkers);
  const pendingBuildProgress = sumPendingBuildProgress(constructionSites);
  const repairBacklogHits = sumRepairBacklogHits(roomStructures);
  const buildBlockedReason = selectBuildBlockedReason(
    colony,
    colonyWorkers,
    productiveAssignments,
    pendingBuildProgress,
    constructionSites.length,
    events
  );

  return {
    workerAssignmentEvidenceAvailable: true,
    ...productiveAssignments,
    constructionSiteCount: constructionSites.length,
    constructionDeadlockTicks: getRoomConstructionDeadlockTicks(colony.room),
    pendingBuildProgress,
    repairBacklogHits,
    ...(buildBlockedReason ? { buildBlockedReason } : {}),
    ...(buildBlockedReason === 'worker_assignment_gap'
      ? {
          workerAssignmentBlockedDetail: selectWorkerAssignmentBlockedDetail(
            colony,
            colonyWorkers,
            roomEnergyStructures,
            constructionSites
          ),
          workerAssignmentBlockedWorkers: selectWorkerAssignmentBlockedWorkers(
            colony,
            colonyWorkers,
            constructionSites,
            pendingBuildProgress,
            repairBacklogHits
          )
        }
      : {}),
    ...buildControllerProgressRemaining(colony.room)
  };
}

function selectBuildBlockedReason(
  colony: ColonySnapshot,
  colonyWorkers: Creep[],
  productiveAssignments: Pick<
    RuntimeProductiveEnergySummary,
    'assignedCarriedEnergy' | 'buildCarriedEnergy'
  >,
  pendingBuildProgress: number,
  constructionSiteCount: number,
  events: RuntimeResourceEventSummary | undefined
): RuntimeBuildBlockedReason | undefined {
  if (constructionSiteCount <= 0 || pendingBuildProgress <= 0) {
    return 'no_construction_sites';
  }

  if ((events?.builtProgress ?? 0) > 0 || productiveAssignments.buildCarriedEnergy > 0) {
    return undefined;
  }

  if (hasConstructionEnergyAcquisitionAssignment(colonyWorkers)) {
    return undefined;
  }

  return isBuildBlockedByEnergyBuffer(colony, productiveAssignments.assignedCarriedEnergy)
    ? 'energy_buffer_blocked'
    : 'worker_assignment_gap';
}

function hasConstructionEnergyAcquisitionAssignment(colonyWorkers: Creep[]): boolean {
  return colonyWorkers.some(hasConstructionEnergyAcquisitionTask);
}

function selectWorkerAssignmentBlockedDetail(
  colony: ColonySnapshot,
  colonyWorkers: Creep[],
  roomEnergyStructures: unknown[],
  constructionSites: unknown[]
): RuntimeWorkerAssignmentBlockedDetail {
  if (!colonyWorkers.some(isConstructionCapableWorker)) {
    return 'no_valid_body';
  }

  const energyBuffer = getRoomEnergyBufferHealth(colony.room);
  if (!energyBuffer.healthy || energyBuffer.currentEnergy < energyBuffer.threshold) {
    return 'energy_buffer_below_threshold';
  }

  if (hasCarriedEnergyWorkerBlockedByConstructionEnergyMargin(colony.room, colonyWorkers, constructionSites)) {
    return 'energy_buffer_spend_margin';
  }

  if (colonyWorkers.every((worker) => getFreeEnergyCapacityInStore(worker) <= 0)) {
    return 'room_capacity_full';
  }

  if (hasSpawnReservedConstructionEnergy(colony, roomEnergyStructures, energyBuffer)) {
    return 'spawn_reserving_energy';
  }

  return 'unknown';
}

function selectWorkerAssignmentBlockedWorkers(
  colony: ColonySnapshot,
  colonyWorkers: Creep[],
  constructionSites: unknown[],
  pendingBuildProgress: number,
  repairBacklogHits: number
): RuntimeWorkerAssignmentBlockedWorkerDetail[] {
  return [...colonyWorkers]
    .sort(compareWorkerAssignmentBlockedDiagnosticPriority)
    .slice(0, MAX_WORKER_ASSIGNMENT_BLOCKED_WORKERS)
    .map((worker) => {
      const taskType = getWorkerTaskType(worker);
      const dispatchDiagnostic = getCurrentWorkerDispatchDiagnostic(worker);
      return {
        ...(getWorkerName(worker) ? { name: getWorkerName(worker) } : {}),
        ...(taskType ? { task: taskType } : {}),
        carriedEnergy: getEnergyInStore(worker),
        freeCapacity: getFreeEnergyCapacityInStore(worker),
        buildBlockedReason: selectWorkerBuildAssignmentBlockedReason(
          colony,
          worker,
          constructionSites,
          pendingBuildProgress
        ),
        repairBlockedReason: selectWorkerRepairAssignmentBlockedReason(
          worker,
          pendingBuildProgress,
          repairBacklogHits
        ),
        ...formatWorkerConstructionEnergyGateDiagnostic(colony.room, worker, constructionSites),
        ...formatWorkerDispatchDiagnostic(dispatchDiagnostic)
      };
    });
}

function compareWorkerAssignmentBlockedDiagnosticPriority(left: Creep, right: Creep): number {
  return (
    getWorkerAssignmentBlockedDiagnosticTaskPriority(left) -
      getWorkerAssignmentBlockedDiagnosticTaskPriority(right) ||
    getEnergyInStore(right) - getEnergyInStore(left) ||
    getWorkerStableLabel(left).localeCompare(getWorkerStableLabel(right))
  );
}

function getWorkerAssignmentBlockedDiagnosticTaskPriority(worker: Creep): number {
  const taskType = getWorkerTaskType(worker);
  if (!taskType) {
    return 0;
  }

  if (taskType === 'upgrade') {
    return 1;
  }

  if (taskType === 'build' || taskType === 'repair') {
    return 3;
  }

  return 2;
}

function selectWorkerBuildAssignmentBlockedReason(
  colony: ColonySnapshot,
  worker: Creep,
  constructionSites: unknown[],
  pendingBuildProgress: number
): RuntimeWorkerBuildAssignmentBlockedReason {
  const taskType = getWorkerTaskType(worker);
  if (taskType === 'build') {
    return 'build_assigned';
  }

  if (!isConstructionCapableWorker(worker)) {
    return 'build_blocked_no_valid_body';
  }

  if (constructionSites.length <= 0 || pendingBuildProgress <= 0) {
    return 'build_blocked_no_construction_sites';
  }

  if (getEnergyInStore(worker) <= 0) {
    return 'build_blocked_no_carried_energy';
  }

  if (
    !canSpendWorkerEnergyOnAnyConstructionSiteForTelemetry(
      colony.room,
      getEnergyInStore(worker),
      constructionSites
    )
  ) {
    return 'build_blocked_energy_buffer';
  }

  if (taskType === 'upgrade') {
    return 'build_blocked_controller_progress_preferred';
  }

  if (taskType) {
    return 'build_blocked_other_task';
  }

  return 'build_blocked_unknown';
}

function hasCarriedEnergyWorkerBlockedByConstructionEnergyMargin(
  room: Room,
  colonyWorkers: Creep[],
  constructionSites: unknown[]
): boolean {
  return colonyWorkers.some(
    (worker) =>
      isConstructionCapableWorker(worker) &&
      getEnergyInStore(worker) > 0 &&
      !canSpendWorkerEnergyOnAnyConstructionSiteForTelemetry(room, getEnergyInStore(worker), constructionSites)
  );
}

function canSpendWorkerEnergyOnAnyConstructionSiteForTelemetry(
  room: Room,
  carriedEnergy: number,
  constructionSites: unknown[]
): boolean {
  if (carriedEnergy <= 0 || constructionSites.length <= 0) {
    return false;
  }

  return constructionSites.some((site) => canSpendWorkerEnergyOnConstructionSiteForTelemetry(room, carriedEnergy, site));
}

function canSpendWorkerEnergyOnConstructionSiteForTelemetry(
  room: Room,
  carriedEnergy: number,
  constructionSite: unknown
): boolean {
  if (!isRecord(constructionSite)) {
    return checkEnergyBufferForConstructionSpending(room);
  }

  if (matchesStructureType(constructionSite.structureType, 'STRUCTURE_EXTENSION', 'extension')) {
    return checkEnergyBufferForExtensionConstruction(room, carriedEnergy);
  }

  if (matchesStructureType(constructionSite.structureType, 'STRUCTURE_CONTAINER', 'container')) {
    return checkEnergyBufferForCapacityEnablingConstruction(room, carriedEnergy);
  }

  return checkEnergyBufferForConstructionSpending(room);
}

function formatWorkerConstructionEnergyGateDiagnostic(
  room: Room,
  worker: Creep,
  constructionSites: unknown[]
): Partial<RuntimeWorkerAssignmentBlockedWorkerDetail> {
  const carriedEnergy = getEnergyInStore(worker);
  if (
    carriedEnergy <= 0 ||
    canSpendWorkerEnergyOnAnyConstructionSiteForTelemetry(room, carriedEnergy, constructionSites)
  ) {
    return {};
  }

  const energyBuffer = getRoomEnergyBufferHealth(room);
  return {
    constructionEnergyGate: 'blocked_by_buffer_margin',
    energyBufferAfterSpend: energyBuffer.currentEnergy - carriedEnergy,
    energyBufferCurrent: energyBuffer.currentEnergy,
    energyBufferSpend: carriedEnergy,
    energyBufferThreshold: energyBuffer.threshold
  };
}

function selectWorkerRepairAssignmentBlockedReason(
  worker: Creep,
  pendingBuildProgress: number,
  repairBacklogHits: number
): RuntimeWorkerRepairAssignmentBlockedReason {
  const taskType = getWorkerTaskType(worker);
  if (taskType === 'repair') {
    return 'repair_assigned';
  }

  if (!isConstructionCapableWorker(worker)) {
    return 'repair_blocked_no_valid_body';
  }

  if (repairBacklogHits <= 0) {
    return 'repair_blocked_no_repair_targets';
  }

  if (getEnergyInStore(worker) <= 0) {
    return 'repair_blocked_no_carried_energy';
  }

  if (pendingBuildProgress > 0) {
    return 'repair_blocked_build_backlog_first';
  }

  if (taskType === 'upgrade') {
    return 'repair_blocked_controller_progress_preferred';
  }

  if (taskType) {
    return 'repair_blocked_other_task';
  }

  return 'repair_blocked_unknown';
}

function getWorkerTaskType(worker: Creep): string | undefined {
  const taskType = worker.memory?.task?.type;
  return typeof taskType === 'string' && taskType.length > 0 ? taskType : undefined;
}

function getWorkerName(worker: Creep): string | undefined {
  const name = (worker as Creep & { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function getWorkerStableLabel(worker: Creep): string {
  return getWorkerName(worker) ?? String((worker as Creep & { id?: unknown }).id ?? '');
}

function getCurrentWorkerDispatchDiagnostic(worker: Creep): WorkerDispatchDiagnosticMemory | null {
  const diagnostic = worker.memory?.workerDispatchDiagnostic;
  if (!diagnostic || typeof diagnostic.tick !== 'number' || !Number.isFinite(diagnostic.tick)) {
    return null;
  }

  return diagnostic.tick === getGameTime() ? diagnostic : null;
}

function formatWorkerDispatchDiagnostic(
  diagnostic: WorkerDispatchDiagnosticMemory | null
): Partial<RuntimeWorkerAssignmentBlockedWorkerDetail> {
  if (!diagnostic) {
    return {};
  }

  return {
    dispatchReason: diagnostic.reason,
    dispatchTick: diagnostic.tick,
    ...(diagnostic.currentTargetId ? { dispatchCurrentTargetId: diagnostic.currentTargetId } : {}),
    ...(diagnostic.selectedTask ? { dispatchSelectedTask: diagnostic.selectedTask } : {}),
    ...(diagnostic.selectedTargetId ? { dispatchSelectedTargetId: diagnostic.selectedTargetId } : {}),
    ...(diagnostic.baseSelectedTask ? { dispatchBaseSelectedTask: diagnostic.baseSelectedTask } : {}),
    ...(diagnostic.baseSelectedTargetId ? { dispatchBaseSelectedTargetId: diagnostic.baseSelectedTargetId } : {}),
    ...(diagnostic.energyCriticalTask ? { dispatchEnergyCriticalTask: diagnostic.energyCriticalTask } : {}),
    ...(diagnostic.energyCriticalTargetId
      ? { dispatchEnergyCriticalTargetId: diagnostic.energyCriticalTargetId }
      : {}),
    ...(diagnostic.spawnReservationTask ? { dispatchSpawnReservationTask: diagnostic.spawnReservationTask } : {}),
    ...(diagnostic.spawnReservationTargetId
      ? { dispatchSpawnReservationTargetId: diagnostic.spawnReservationTargetId }
      : {}),
    ...(diagnostic.assignedTask ? { dispatchAssignedTask: diagnostic.assignedTask } : {}),
    ...(diagnostic.assignedTargetId ? { dispatchAssignedTargetId: diagnostic.assignedTargetId } : {})
  };
}

function hasConstructionEnergyAcquisitionTask(creep: Creep): boolean {
  const task = creep.memory?.task;
  return task?.type === 'withdraw' && typeof task.constructionSiteId === 'string';
}

function isConstructionCapableWorker(creep: Creep): boolean {
  return hasActiveBodyPart(creep, 'WORK', 'work') && getEnergyCapacityInStore(creep) > 0;
}

function hasActiveBodyPart(
  creep: Creep,
  globalName: 'WORK',
  fallback: BodyPartConstant
): boolean {
  const bodyPart = ((globalThis as Partial<Record<typeof globalName, BodyPartConstant>>)[globalName] ??
    fallback) as BodyPartConstant;
  const activeBodyParts = creep.getActiveBodyparts?.(bodyPart);
  if (typeof activeBodyParts === 'number' && Number.isFinite(activeBodyParts)) {
    return activeBodyParts > 0;
  }

  const body = (creep as Creep & { body?: Array<{ type?: BodyPartConstant; hits?: number }> }).body;
  if (!Array.isArray(body)) {
    return false;
  }

  return body.some((part) => part.type === bodyPart && (part.hits ?? 1) > 0);
}

function hasSpawnReservedConstructionEnergy(
  colony: ColonySnapshot,
  roomEnergyStructures: unknown[],
  energyBuffer: EnergyBufferHealth
): boolean {
  const roomEnergyBudget = Math.max(0, energyBuffer.currentEnergy - energyBuffer.threshold);
  if (roomEnergyBudget <= 0) {
    return false;
  }

  const spawnEnergy = roomEnergyStructures
    .filter(isSpawnEnergyStructure)
    .reduce<number>((total, structure) => total + getEnergyInStore(structure), 0);
  return spawnEnergy > 0 && getRoomEnergyAvailable(colony) > energyBuffer.threshold;
}

function isSpawnEnergyStructure(structure: unknown): boolean {
  return isRecord(structure) && matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn');
}

function isBuildBlockedByEnergyBuffer(colony: ColonySnapshot, assignedCarriedEnergy: number): boolean {
  const energyAvailable = getRoomEnergyAvailable(colony);
  if (energyAvailable <= 0) {
    return true;
  }

  const buffer = getRoomEnergyBufferHealth(colony.room);
  return buffer.healthy === false && buffer.currentEnergy < buffer.threshold && assignedCarriedEnergy <= 0;
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
  colonyWorkers: Creep[],
  strategyRegistry: StrategyRegistryEntry[] | undefined,
  onStrategyRegistryRuntimeUse: ((entry: StrategyRegistryEntry) => void) | undefined
): RuntimeConstructionPrioritySummary {
  const strategyEntry = selectConstructionPriorityStrategyRegistryEntry(strategyRegistry);
  const strategyParameters = constructionPriorityStrategyParametersFromEntry(strategyEntry);
  const report = buildRuntimeConstructionPriorityReport(colony, colonyWorkers, {
    strategyParameters
  });
  if (strategyEntry && strategyParameters) {
    recordStrategyRegistryRuntimeUse(strategyEntry, onStrategyRegistryRuntimeUse);
  }

  return {
    candidates: report.candidates.map(toRuntimeConstructionPriorityCandidateSummary),
    nextPrimary: report.nextPrimary ? toRuntimeConstructionPriorityCandidateSummary(report.nextPrimary) : null
  };
}

function recordStrategyRegistryRuntimeUse(
  strategyEntry: StrategyRegistryEntry,
  onStrategyRegistryRuntimeUse: ((entry: StrategyRegistryEntry) => void) | undefined
): void {
  if (!onStrategyRegistryRuntimeUse) {
    return;
  }

  try {
    onStrategyRegistryRuntimeUse(strategyEntry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[runtime-summary] strategy registry runtime-use hook failed: ${message}`);
  }
}

function summarizeSurvival(colony: ColonySnapshot, roleCounts: RoleCounts): RuntimeSurvivalSummary {
  const assessment = assessColonySnapshotSurvival(colony, roleCounts);
  const defenseFloor = assessBootstrapDefenseFloorReadiness(colony.room);

  return {
    mode: assessment.mode,
    workerCapacity: assessment.workerCapacity,
    workerTarget: assessment.workerTarget,
    survivalWorkerFloor: assessment.survivalWorkerFloor,
    ...(assessment.suppressionReasons.length > 0 ? { suppressionReasons: assessment.suppressionReasons } : {}),
    ...(shouldReportRuntimeDefenseFloor(defenseFloor)
      ? { defenseFloor: toRuntimeDefenseFloorSummary(defenseFloor) }
      : {})
  };
}

function shouldReportRuntimeDefenseFloor(defenseFloor: BootstrapDefenseFloorReadiness): boolean {
  return defenseFloor.assessable;
}

function toRuntimeDefenseFloorSummary(
  defenseFloor: BootstrapDefenseFloorReadiness
): RuntimeDefenseFloorSummary {
  return {
    ready: defenseFloor.ready,
    assessable: defenseFloor.assessable,
    rcl: defenseFloor.rcl,
    anchorReady: defenseFloor.anchorReady,
    towerReady: defenseFloor.towerReady,
    towerCount: defenseFloor.towerCount,
    pendingTowerCount: defenseFloor.pendingTowerCount,
    spawnRampartReady: defenseFloor.spawnRampartReady,
    wallAnchorCount: defenseFloor.wallAnchorCount,
    requiredWallAnchorCount: defenseFloor.requiredWallAnchorCount,
    missingAnchorCount: defenseFloor.missingAnchors.length,
    repairHitsCeiling: defenseFloor.repairHitsCeiling
  };
}

function toRuntimeConstructionPriorityCandidateSummary(
  score: ConstructionPriorityScore
): RuntimeConstructionPriorityCandidateSummary {
  return {
    buildItem: score.buildItem,
    room: score.room,
    ...(score.policyAction !== 'build' ? { policyAction: score.policyAction } : {}),
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

function uniqueRoomObjects(objects: unknown[]): unknown[] {
  const uniqueObjects: unknown[] = [];
  const seenReferences = new Set<unknown>();
  const seenKeys = new Set<string>();

  for (const object of objects) {
    if (object === undefined || object === null) {
      continue;
    }

    const key = getObjectIdentityKey(object);
    if (key) {
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
    } else if (seenReferences.has(object)) {
      continue;
    }

    seenReferences.add(object);
    uniqueObjects.push(object);
  }

  return uniqueObjects;
}

function getObjectIdentityKey(object: unknown): string | null {
  if (!isRecord(object)) {
    return null;
  }

  if (typeof object.id === 'string' && object.id.length > 0) {
    return `id:${object.id}`;
  }

  if (typeof object.name === 'string' && object.name.length > 0) {
    return `name:${object.name}`;
  }

  return null;
}

function sumEnergyInStores(objects: unknown[]): number {
  return objects.reduce<number>((total, object) => total + getEnergyInStore(object), 0);
}

function getEnergyInStore(object: unknown): number {
  if (!isRecord(object) || !isRecord(object.store)) {
    return 0;
  }

  const storedEnergy = object.store[getEnergyResource()];
  if (typeof storedEnergy === 'number') {
    return storedEnergy;
  }

  const getUsedCapacity = object.store.getUsedCapacity;
  if (typeof getUsedCapacity === 'function') {
    const usedCapacity = getUsedCapacity.call(object.store, getEnergyResource());
    return typeof usedCapacity === 'number' ? usedCapacity : 0;
  }

  return 0;
}

function normalizeEnergyAmount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getEnergyCapacityInStore(object: unknown): number {
  if (!isRecord(object) || !isRecord(object.store)) {
    return 0;
  }

  const getCapacity = object.store.getCapacity;
  if (typeof getCapacity === 'function') {
    const capacity = getCapacity.call(object.store, getEnergyResource());
    return typeof capacity === 'number' && Number.isFinite(capacity) ? Math.max(0, capacity) : 0;
  }

  const getFreeCapacity = object.store.getFreeCapacity;
  if (typeof getFreeCapacity === 'function') {
    const freeCapacity = getFreeCapacity.call(object.store, getEnergyResource());
    if (typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)) {
      return Math.max(0, getEnergyInStore(object) + freeCapacity);
    }
  }

  const capacity = object.store.capacity;
  return typeof capacity === 'number' && Number.isFinite(capacity) ? Math.max(0, capacity) : 0;
}

function getFreeEnergyCapacityInStore(object: unknown): number {
  if (!isRecord(object) || !isRecord(object.store)) {
    return 0;
  }

  const getFreeCapacity = object.store.getFreeCapacity;
  if (typeof getFreeCapacity !== 'function') {
    return 0;
  }

  const freeCapacity = getFreeCapacity.call(object.store, getEnergyResource());
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
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
  | 'STRUCTURE_TOWER'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL'
  | 'STRUCTURE_LINK';

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
  const summary = buildRuntimeCpuTelemetrySummary();
  if (!summary) {
    return {};
  }

  return { cpu: toRuntimeCpuSummary(summary) };
}

function toRuntimeCpuSummary(summary: RuntimeCpuTelemetrySummary): RuntimeCpuSummary {
  return {
    ...(summary.used !== undefined ? { used: summary.used } : {}),
    ...(summary.limit !== undefined ? { limit: summary.limit } : {}),
    ...(summary.tickLimit !== undefined ? { tickLimit: summary.tickLimit } : {}),
    ...(summary.bucket !== undefined ? { bucket: summary.bucket } : {}),
    ...(summary.pressure !== 'normal' ? { pressure: summary.pressure } : {}),
    ...(summary.alerts ? { alerts: summary.alerts } : {}),
    ...(summary.reasons ? { reasons: summary.reasons } : {}),
    ...(summary.lowBucketTicks !== undefined ? { lowBucketTicks: summary.lowBucketTicks } : {}),
    ...(summary.bucketEmptyTicks !== undefined ? { bucketEmptyTicks: summary.bucketEmptyTicks } : {}),
    ...(summary.overLimitTicks !== undefined ? { overLimitTicks: summary.overLimitTicks } : {})
  };
}

function emitRuntimeCpuSummary(cpu: RuntimeCpuSummary | undefined, tick: number): void {
  if (!cpu || !shouldEmitRuntimeCpuSummary(cpu, tick)) {
    return;
  }

  console.log(`${RUNTIME_CPU_SUMMARY_PREFIX}${JSON.stringify(cpu)}`);
}

function shouldEmitRuntimeCpuSummary(cpu: RuntimeCpuSummary, tick: number): boolean {
  if (cpu.alerts && cpu.alerts.length > 0) {
    return true;
  }

  return cpu.pressure !== undefined && cpu.pressure !== 'normal' && tick > 0 && tick % RUNTIME_SUMMARY_INTERVAL === 0;
}

function applyCpuSummaryToRooms(
  rooms: RuntimeRoomSummary[],
  cpu: RuntimeCpuSummary | undefined
): RuntimeRoomSummary[] {
  if (!cpu || (cpu.used === undefined && cpu.bucket === undefined)) {
    return rooms;
  }

  return rooms.map((room) => ({
    ...room,
    ...(cpu.used !== undefined ? { cpuUsed: cpu.used } : {}),
    ...(cpu.bucket !== undefined ? { cpuBucket: cpu.bucket } : {})
  }));
}

function getGameTime(): number {
  return (globalThis as any).Game?.time ?? 0;
}
