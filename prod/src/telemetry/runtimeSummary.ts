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
  getTerritoryIntentProgressSummaries,
  type TerritoryIntentProgressSummary
} from '../territory/territoryPlanner';

export const RUNTIME_SUMMARY_PREFIX = '#runtime-summary ';
export const RUNTIME_SUMMARY_INTERVAL = 20;
const MAX_REPORTED_EVENTS = 10;
const MAX_WORKER_EFFICIENCY_SAMPLES = 5;
const MAX_TERRITORY_INTENT_SUMMARIES = 5;
const WORKER_EFFICIENCY_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
const OBSERVED_RAMPART_REPAIR_HITS_CEILING = 100_000;

const WORKER_TASK_TYPES = ['harvest', 'transfer', 'build', 'repair', 'upgrade'] as const;
const PRODUCTIVE_WORKER_TASK_TYPES = ['build', 'repair', 'upgrade'] as const;

type WorkerTaskType = (typeof WORKER_TASK_TYPES)[number];
type ProductiveWorkerTaskType = (typeof PRODUCTIVE_WORKER_TASK_TYPES)[number];

interface WorkerTaskCounts extends Record<WorkerTaskType, number> {
  none: number;
}

export type RuntimeTelemetryEvent = RuntimeSpawnTelemetryEvent | RuntimeDefenseTelemetryEvent;

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
  controller?: RuntimeControllerSummary;
  resources: RuntimeResourceSummary;
  combat: RuntimeCombatSummary;
  constructionPriority: RuntimeConstructionPrioritySummary;
  survival: RuntimeSurvivalSummary;
  territoryRecommendation: OccupationRecommendationReport;
  territoryIntents?: TerritoryIntentProgressSummary[];
  omittedTerritoryIntentCount?: number;
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
  nearbyEnergyChoiceCount: number;
  samples: RuntimeWorkerEfficiencySampleSummary[];
  omittedSampleCount?: number;
}

interface RuntimeWorkerEfficiencySampleSummary extends WorkerEfficiencySampleMemory {
  creepName?: string;
}

interface RuntimeWorkerEfficiencySampleEntry {
  creepName: string | undefined;
  sample: WorkerEfficiencySampleMemory;
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
  if (!shouldEmitRuntimeSummary(tick, events)) {
    return;
  }

  const reportedEvents = events.slice(0, MAX_REPORTED_EVENTS);
  const creepsByColony = groupCreepsByColony(creeps);
  const persistOccupationRecommendations = options.persistOccupationRecommendations !== false;
  const summary: RuntimeSummary = {
    type: 'runtime-summary',
    tick,
    rooms: colonies.map((colony) =>
      summarizeRoom(colony, creepsByColony.get(colony.room.name) ?? [], persistOccupationRecommendations)
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

function summarizeRoom(
  colony: ColonySnapshot,
  colonyCreeps: Creep[],
  persistOccupationRecommendations: boolean
): RuntimeRoomSummary {
  const colonyWorkers = colonyCreeps.filter((creep) => creep.memory.role === 'worker');
  const roleCounts = countCreepsByRole(colonyCreeps, colony.room.name);
  const eventMetrics = summarizeRoomEventMetrics(colony.room);
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
): { territoryIntents?: TerritoryIntentProgressSummary[]; omittedTerritoryIntentCount?: number } {
  const territoryIntents = getTerritoryIntentProgressSummaries(colonyName, roleCounts);
  if (territoryIntents.length === 0) {
    return {};
  }

  const reportedIntents = territoryIntents.slice(0, MAX_TERRITORY_INTENT_SUMMARIES);
  return {
    territoryIntents: reportedIntents,
    ...(territoryIntents.length > MAX_TERRITORY_INTENT_SUMMARIES
      ? { omittedTerritoryIntentCount: territoryIntents.length - MAX_TERRITORY_INTENT_SUMMARIES }
      : {})
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

  return {
    workerEfficiency: {
      lowLoadReturnCount: samples.filter((entry) => entry.sample.type === 'lowLoadReturn').length,
      nearbyEnergyChoiceCount: samples.filter((entry) => entry.sample.type === 'nearbyEnergyChoice').length,
      samples: reportedSamples,
      ...(samples.length > MAX_WORKER_EFFICIENCY_SAMPLES
        ? { omittedSampleCount: samples.length - MAX_WORKER_EFFICIENCY_SAMPLES }
        : {})
    }
  };
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

function summarizeRoomEventMetrics(room: Room): RuntimeRoomEventMetrics {
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
      resourceEvents.transferredEnergy += getNumericEventData(data, 'amount');
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
    ...(hasCombatEvents ? { combat: combatEvents } : {})
  };
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

type StructureConstantGlobal = 'STRUCTURE_ROAD' | 'STRUCTURE_CONTAINER' | 'STRUCTURE_RAMPART';

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
