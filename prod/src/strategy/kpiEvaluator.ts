import type { StrategyArtifactType } from './strategyRegistry';

export const STRATEGY_RUNTIME_SUMMARY_PREFIX = '#runtime-summary ';

export interface StrategyRuntimeSummaryArtifact {
  artifactType: 'runtime-summary';
  tick?: number;
  rooms: StrategyRuntimeSummaryRoom[];
  cpu?: StrategyCpuSummary;
  reliability?: StrategyArtifactReliabilitySignals;
}

export interface StrategyRuntimeSummaryRoom {
  roomName: string;
  energyAvailable?: number;
  energyCapacity?: number;
  workerCount?: number;
  spawnStatus?: StrategyRuntimeSpawnStatus[];
  controller?: StrategyRuntimeControllerSummary;
  resources?: StrategyRuntimeResourceSummary;
  combat?: StrategyRuntimeCombatSummary;
  constructionPriority?: StrategyRuntimeConstructionPrioritySummary;
  territoryRecommendation?: StrategyRuntimeTerritoryRecommendationSummary;
}

export interface StrategyRuntimeSpawnStatus {
  name?: string;
  status?: string;
  creepName?: string;
  remainingTime?: number;
}

export interface StrategyRuntimeControllerSummary {
  level: number;
  progress?: number;
  progressTotal?: number;
  ticksToDowngrade?: number;
}

export interface StrategyRuntimeResourceSummary {
  storedEnergy?: number;
  workerCarriedEnergy?: number;
  droppedEnergy?: number;
  sourceCount?: number;
  events?: StrategyRuntimeResourceEventSummary;
}

export interface StrategyRuntimeResourceEventSummary {
  harvestedEnergy?: number;
  transferredEnergy?: number;
}

export interface StrategyRuntimeCombatSummary {
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  events?: StrategyRuntimeCombatEventSummary;
}

export interface StrategyRuntimeCombatEventSummary {
  attackCount?: number;
  attackDamage?: number;
  objectDestroyedCount?: number;
  creepDestroyedCount?: number;
}

export interface StrategyRuntimeConstructionPrioritySummary {
  candidates?: StrategyRuntimeConstructionPriorityCandidate[];
  nextPrimary?: StrategyRuntimeConstructionPriorityCandidate | null;
}

export interface StrategyRuntimeConstructionPriorityCandidate {
  buildItem: string;
  room?: string;
  score?: number;
  urgency?: string;
  preconditions?: string[];
  expectedKpiMovement?: string[];
  risk?: string[];
}

export interface StrategyRuntimeTerritoryRecommendationSummary {
  candidates?: StrategyRuntimeTerritoryCandidate[];
  next?: StrategyRuntimeTerritoryCandidate | null;
  followUpIntent?: unknown;
}

export interface StrategyRuntimeTerritoryCandidate {
  roomName: string;
  action?: string;
  score?: number;
  evidenceStatus?: string;
  source?: string;
  evidence?: string[];
  preconditions?: string[];
  risks?: string[];
  routeDistance?: number;
  sourceCount?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
}

export interface StrategyCpuSummary {
  used?: number;
  bucket?: number;
}

export interface StrategyRoomSnapshotArtifact {
  artifactType: 'room-snapshot';
  tick?: number;
  roomName?: string;
  owner?: string;
  objects: StrategyRoomSnapshotObject[];
}

export interface StrategyRoomSnapshotObject {
  id?: string;
  type?: string;
  room?: string;
  user?: string;
  owner?: { username?: string };
  my?: boolean;
  level?: number;
  hits?: number;
  hitsMax?: number;
  amount?: number;
  resourceType?: string;
  energy?: number;
  store?: Record<string, unknown>;
}

export interface StrategyArtifactReliabilitySignals {
  loopExceptionCount?: number;
  telemetrySilenceTicks?: number;
  globalResetCount?: number;
}

export type StrategyEvaluationArtifact = StrategyRuntimeSummaryArtifact | StrategyRoomSnapshotArtifact;

export interface StrategyReliabilityThresholds {
  minArtifactCount: number;
  maxLoopExceptionCount: number;
  maxTelemetrySilenceTicks: number;
  minCpuBucket?: number;
  controllerDowngradeRiskTicks: number;
  maxControllerDowngradeRiskRooms: number;
  maxSpawnCollapseRooms: number;
}

export interface StrategyReliabilityMetrics {
  artifactCount: number;
  runtimeSummaryCount: number;
  roomSnapshotCount: number;
  loopExceptionCount: number;
  telemetrySilenceTicks: number;
  globalResetCount: number;
  controllerDowngradeRiskRooms: number;
  spawnCollapseRooms: number;
  minCpuBucket?: number;
}

export interface StrategyReliabilityEvaluation {
  passed: boolean;
  reasons: string[];
  metrics: StrategyReliabilityMetrics;
}

export interface StrategyKpiDimension {
  score: number;
  components: Record<string, number>;
}

export interface StrategyKpiVector {
  reliability: StrategyReliabilityEvaluation;
  territory: StrategyKpiDimension;
  resources: StrategyKpiDimension;
  kills: StrategyKpiDimension;
}

export const DEFAULT_STRATEGY_RELIABILITY_THRESHOLDS: StrategyReliabilityThresholds = {
  minArtifactCount: 1,
  maxLoopExceptionCount: 0,
  maxTelemetrySilenceTicks: 0,
  controllerDowngradeRiskTicks: 5_000,
  maxControllerDowngradeRiskRooms: 0,
  maxSpawnCollapseRooms: 0
};

export function parseStrategyEvaluationArtifacts(input: string | unknown | unknown[]): StrategyEvaluationArtifact[] {
  if (typeof input !== 'string') {
    const rawArtifacts = Array.isArray(input) ? input : [input];
    return rawArtifacts.flatMap((rawArtifact) => {
      const artifact = normalizeStrategyEvaluationArtifact(rawArtifact);
      return artifact ? [artifact] : [];
    });
  }

  const trimmedInput = input.trim();
  if (trimmedInput.length === 0) {
    return [];
  }

  const wholeJson = parseJson(trimmedInput);
  if (wholeJson !== null) {
    return parseStrategyEvaluationArtifacts(wholeJson);
  }

  return trimmedInput.split(/\r?\n/).flatMap((line) => {
    const parsedLine = parseArtifactLine(line);
    const artifact = parsedLine === null ? null : normalizeStrategyEvaluationArtifact(parsedLine);
    return artifact ? [artifact] : [];
  });
}

export function normalizeStrategyEvaluationArtifact(rawArtifact: unknown): StrategyEvaluationArtifact | null {
  if (!isRecord(rawArtifact)) {
    return null;
  }

  if (rawArtifact.type === 'runtime-summary' || Array.isArray(rawArtifact.rooms)) {
    return normalizeRuntimeSummaryArtifact(rawArtifact);
  }

  if (rawArtifact.artifactType === 'runtime-summary') {
    return normalizeRuntimeSummaryArtifact(rawArtifact);
  }

  if (rawArtifact.artifactType === 'room-snapshot' || Array.isArray(rawArtifact.objects) || isRecord(rawArtifact.objects)) {
    return normalizeRoomSnapshotArtifact(rawArtifact);
  }

  return null;
}

export function reduceStrategyKpis(
  artifacts: StrategyEvaluationArtifact[],
  thresholds: StrategyReliabilityThresholds = DEFAULT_STRATEGY_RELIABILITY_THRESHOLDS
): StrategyKpiVector {
  const reliabilityMetrics = buildInitialReliabilityMetrics(artifacts);
  const territoryComponents: Record<string, number> = {
    ownedRooms: 0,
    reservedOrRemoteRooms: 0,
    roomGain: 0,
    controllerLevels: 0,
    controllerProgress: 0,
    territoryRecommendation: 0
  };
  const resourceComponents: Record<string, number> = {
    storedEnergy: 0,
    workerCarriedEnergy: 0,
    droppedEnergy: 0,
    harvestedEnergy: 0,
    transferredEnergy: 0,
    visibleSources: 0
  };
  const killComponents: Record<string, number> = {
    creepKills: 0,
    objectKills: 0,
    attackDamage: 0,
    hostilePressureObserved: 0
  };
  let firstOwnedRoomCount: number | undefined;
  let lastOwnedRoomCount = 0;

  for (const artifact of artifacts) {
    if (artifact.artifactType === 'runtime-summary') {
      const ownedRoomCount = reduceRuntimeSummaryArtifact(
        artifact,
        reliabilityMetrics,
        territoryComponents,
        resourceComponents,
        killComponents,
        thresholds
      );
      if (firstOwnedRoomCount === undefined) {
        firstOwnedRoomCount = ownedRoomCount;
      }
      lastOwnedRoomCount = ownedRoomCount;
    } else {
      const ownedRoomCount = reduceRoomSnapshotArtifact(
        artifact,
        territoryComponents,
        resourceComponents,
        killComponents
      );
      if (firstOwnedRoomCount === undefined) {
        firstOwnedRoomCount = ownedRoomCount;
      }
      lastOwnedRoomCount = ownedRoomCount;
    }
  }

  territoryComponents.roomGain = lastOwnedRoomCount - (firstOwnedRoomCount ?? lastOwnedRoomCount);

  return {
    reliability: evaluateReliabilityFloor(reliabilityMetrics, thresholds),
    territory: {
      score:
        territoryComponents.ownedRooms * 10_000 +
        territoryComponents.reservedOrRemoteRooms * 3_000 +
        territoryComponents.roomGain * 5_000 +
        territoryComponents.controllerLevels * 800 +
        territoryComponents.controllerProgress / 100 +
        territoryComponents.territoryRecommendation,
      components: territoryComponents
    },
    resources: {
      score:
        resourceComponents.storedEnergy +
        resourceComponents.workerCarriedEnergy +
        resourceComponents.droppedEnergy / 2 +
        resourceComponents.harvestedEnergy * 3 +
        resourceComponents.transferredEnergy +
        resourceComponents.visibleSources * 500,
      components: resourceComponents
    },
    kills: {
      score:
        killComponents.creepKills * 1_000 +
        killComponents.objectKills * 250 +
        killComponents.attackDamage +
        killComponents.hostilePressureObserved * 25,
      components: killComponents
    }
  };
}

export function buildStrategyKpiVector(options: {
  reliabilityPassed?: boolean;
  reliabilityReasons?: string[];
  territory?: number;
  resources?: number;
  kills?: number;
}): StrategyKpiVector {
  const reliabilityMetrics: StrategyReliabilityMetrics = {
    artifactCount: 1,
    runtimeSummaryCount: 1,
    roomSnapshotCount: 0,
    loopExceptionCount: options.reliabilityPassed === false ? 1 : 0,
    telemetrySilenceTicks: 0,
    globalResetCount: 0,
    controllerDowngradeRiskRooms: 0,
    spawnCollapseRooms: 0
  };

  return {
    reliability: {
      passed: options.reliabilityPassed ?? true,
      reasons: options.reliabilityReasons ?? (options.reliabilityPassed === false ? ['reliability floor failed'] : []),
      metrics: reliabilityMetrics
    },
    territory: { score: options.territory ?? 0, components: {} },
    resources: { score: options.resources ?? 0, components: {} },
    kills: { score: options.kills ?? 0, components: {} }
  };
}

export function compareStrategyKpiVectors(left: StrategyKpiVector, right: StrategyKpiVector): number {
  const reliabilityComparison = compareReliability(left.reliability, right.reliability);
  if (reliabilityComparison !== 0) {
    return reliabilityComparison;
  }

  return (
    compareNumber(left.territory.score, right.territory.score) ||
    compareNumber(left.resources.score, right.resources.score) ||
    compareNumber(left.kills.score, right.kills.score)
  );
}

export function getArtifactType(artifact: StrategyEvaluationArtifact): StrategyArtifactType {
  return artifact.artifactType;
}

function normalizeRuntimeSummaryArtifact(rawArtifact: Record<string, unknown>): StrategyRuntimeSummaryArtifact | null {
  const rooms = Array.isArray(rawArtifact.rooms)
    ? rawArtifact.rooms.flatMap((rawRoom) => {
        const room = normalizeRuntimeSummaryRoom(rawRoom);
        return room ? [room] : [];
      })
    : [];

  return {
    artifactType: 'runtime-summary',
    ...(isFiniteNumber(rawArtifact.tick) ? { tick: rawArtifact.tick } : {}),
    rooms,
    ...(isRecord(rawArtifact.cpu) ? { cpu: normalizeCpuSummary(rawArtifact.cpu) } : {}),
    ...(isRecord(rawArtifact.reliability) ? { reliability: normalizeReliabilitySignals(rawArtifact.reliability) } : {})
  };
}

function normalizeRuntimeSummaryRoom(rawRoom: unknown): StrategyRuntimeSummaryRoom | null {
  if (!isRecord(rawRoom) || !isNonEmptyString(rawRoom.roomName)) {
    return null;
  }

  return {
    roomName: rawRoom.roomName,
    ...(isFiniteNumber(rawRoom.energyAvailable) ? { energyAvailable: rawRoom.energyAvailable } : {}),
    ...(isFiniteNumber(rawRoom.energyCapacity) ? { energyCapacity: rawRoom.energyCapacity } : {}),
    ...(isFiniteNumber(rawRoom.workerCount) ? { workerCount: rawRoom.workerCount } : {}),
    ...(Array.isArray(rawRoom.spawnStatus) ? { spawnStatus: rawRoom.spawnStatus.map(normalizeSpawnStatus) } : {}),
    ...(isRecord(rawRoom.controller) ? { controller: normalizeControllerSummary(rawRoom.controller) } : {}),
    ...(isRecord(rawRoom.resources) ? { resources: normalizeResourceSummary(rawRoom.resources) } : {}),
    ...(isRecord(rawRoom.combat) ? { combat: normalizeCombatSummary(rawRoom.combat) } : {}),
    ...(isRecord(rawRoom.constructionPriority)
      ? { constructionPriority: normalizeConstructionPrioritySummary(rawRoom.constructionPriority) }
      : {}),
    ...(isRecord(rawRoom.territoryRecommendation)
      ? { territoryRecommendation: normalizeTerritoryRecommendationSummary(rawRoom.territoryRecommendation) }
      : {})
  };
}

function normalizeRoomSnapshotArtifact(rawArtifact: Record<string, unknown>): StrategyRoomSnapshotArtifact | null {
  if (!Array.isArray(rawArtifact.objects) && !isRecord(rawArtifact.objects)) {
    return null;
  }

  const objects = Array.isArray(rawArtifact.objects)
    ? rawArtifact.objects.flatMap((rawObject) => (isRecord(rawObject) ? [rawObject as StrategyRoomSnapshotObject] : []))
    : Object.entries(rawArtifact.objects).flatMap(([id, rawObject]) => {
        if (!isRecord(rawObject)) {
          return [];
        }

        return [{ ...rawObject, id } as StrategyRoomSnapshotObject];
      });

  return {
    artifactType: 'room-snapshot',
    ...(isFiniteNumber(rawArtifact.tick) ? { tick: rawArtifact.tick } : {}),
    ...(isNonEmptyString(rawArtifact.roomName) ? { roomName: rawArtifact.roomName } : {}),
    ...(isNonEmptyString(rawArtifact.room) ? { roomName: rawArtifact.room } : {}),
    ...(isNonEmptyString(rawArtifact.owner) ? { owner: rawArtifact.owner } : {}),
    objects
  };
}

function parseArtifactLine(line: string): unknown | null {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return null;
  }

  const jsonText = trimmedLine.startsWith(STRATEGY_RUNTIME_SUMMARY_PREFIX)
    ? trimmedLine.slice(STRATEGY_RUNTIME_SUMMARY_PREFIX.length)
    : trimmedLine;
  return parseJson(jsonText);
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizeSpawnStatus(rawStatus: unknown): StrategyRuntimeSpawnStatus {
  if (!isRecord(rawStatus)) {
    return {};
  }

  return {
    ...(isNonEmptyString(rawStatus.name) ? { name: rawStatus.name } : {}),
    ...(isNonEmptyString(rawStatus.status) ? { status: rawStatus.status } : {}),
    ...(isNonEmptyString(rawStatus.creepName) ? { creepName: rawStatus.creepName } : {}),
    ...(isFiniteNumber(rawStatus.remainingTime) ? { remainingTime: rawStatus.remainingTime } : {})
  };
}

function normalizeControllerSummary(rawController: Record<string, unknown>): StrategyRuntimeControllerSummary {
  return {
    level: isFiniteNumber(rawController.level) ? rawController.level : 0,
    ...(isFiniteNumber(rawController.progress) ? { progress: rawController.progress } : {}),
    ...(isFiniteNumber(rawController.progressTotal) ? { progressTotal: rawController.progressTotal } : {}),
    ...(isFiniteNumber(rawController.ticksToDowngrade) ? { ticksToDowngrade: rawController.ticksToDowngrade } : {})
  };
}

function normalizeResourceSummary(rawResources: Record<string, unknown>): StrategyRuntimeResourceSummary {
  return {
    ...(isFiniteNumber(rawResources.storedEnergy) ? { storedEnergy: rawResources.storedEnergy } : {}),
    ...(isFiniteNumber(rawResources.workerCarriedEnergy)
      ? { workerCarriedEnergy: rawResources.workerCarriedEnergy }
      : {}),
    ...(isFiniteNumber(rawResources.droppedEnergy) ? { droppedEnergy: rawResources.droppedEnergy } : {}),
    ...(isFiniteNumber(rawResources.sourceCount) ? { sourceCount: rawResources.sourceCount } : {}),
    ...(isRecord(rawResources.events) ? { events: normalizeResourceEvents(rawResources.events) } : {})
  };
}

function normalizeResourceEvents(rawEvents: Record<string, unknown>): StrategyRuntimeResourceEventSummary {
  return {
    ...(isFiniteNumber(rawEvents.harvestedEnergy) ? { harvestedEnergy: rawEvents.harvestedEnergy } : {}),
    ...(isFiniteNumber(rawEvents.transferredEnergy) ? { transferredEnergy: rawEvents.transferredEnergy } : {})
  };
}

function normalizeCombatSummary(rawCombat: Record<string, unknown>): StrategyRuntimeCombatSummary {
  return {
    ...(isFiniteNumber(rawCombat.hostileCreepCount) ? { hostileCreepCount: rawCombat.hostileCreepCount } : {}),
    ...(isFiniteNumber(rawCombat.hostileStructureCount)
      ? { hostileStructureCount: rawCombat.hostileStructureCount }
      : {}),
    ...(isRecord(rawCombat.events) ? { events: normalizeCombatEvents(rawCombat.events) } : {})
  };
}

function normalizeCombatEvents(rawEvents: Record<string, unknown>): StrategyRuntimeCombatEventSummary {
  return {
    ...(isFiniteNumber(rawEvents.attackCount) ? { attackCount: rawEvents.attackCount } : {}),
    ...(isFiniteNumber(rawEvents.attackDamage) ? { attackDamage: rawEvents.attackDamage } : {}),
    ...(isFiniteNumber(rawEvents.objectDestroyedCount) ? { objectDestroyedCount: rawEvents.objectDestroyedCount } : {}),
    ...(isFiniteNumber(rawEvents.creepDestroyedCount) ? { creepDestroyedCount: rawEvents.creepDestroyedCount } : {})
  };
}

function normalizeConstructionPrioritySummary(
  rawSummary: Record<string, unknown>
): StrategyRuntimeConstructionPrioritySummary {
  return {
    ...(Array.isArray(rawSummary.candidates)
      ? { candidates: rawSummary.candidates.flatMap(normalizeConstructionCandidate) }
      : {}),
    ...(rawSummary.nextPrimary === null
      ? { nextPrimary: null }
      : isRecord(rawSummary.nextPrimary)
        ? { nextPrimary: normalizeConstructionCandidate(rawSummary.nextPrimary)[0] ?? null }
        : {})
  };
}

function normalizeConstructionCandidate(rawCandidate: unknown): StrategyRuntimeConstructionPriorityCandidate[] {
  if (!isRecord(rawCandidate) || !isNonEmptyString(rawCandidate.buildItem)) {
    return [];
  }

  return [
    {
      buildItem: rawCandidate.buildItem,
      ...(isNonEmptyString(rawCandidate.room) ? { room: rawCandidate.room } : {}),
      ...(isFiniteNumber(rawCandidate.score) ? { score: rawCandidate.score } : {}),
      ...(isNonEmptyString(rawCandidate.urgency) ? { urgency: rawCandidate.urgency } : {}),
      ...(Array.isArray(rawCandidate.preconditions)
        ? { preconditions: rawCandidate.preconditions.filter(isNonEmptyString) }
        : {}),
      ...(Array.isArray(rawCandidate.expectedKpiMovement)
        ? { expectedKpiMovement: rawCandidate.expectedKpiMovement.filter(isNonEmptyString) }
        : {}),
      ...(Array.isArray(rawCandidate.risk) ? { risk: rawCandidate.risk.filter(isNonEmptyString) } : {})
    }
  ];
}

function normalizeTerritoryRecommendationSummary(
  rawSummary: Record<string, unknown>
): StrategyRuntimeTerritoryRecommendationSummary {
  return {
    ...(Array.isArray(rawSummary.candidates) ? { candidates: rawSummary.candidates.flatMap(normalizeTerritoryCandidate) } : {}),
    ...(rawSummary.next === null
      ? { next: null }
      : isRecord(rawSummary.next)
        ? { next: normalizeTerritoryCandidate(rawSummary.next)[0] ?? null }
        : {}),
    ...(rawSummary.followUpIntent !== undefined ? { followUpIntent: rawSummary.followUpIntent } : {})
  };
}

function normalizeTerritoryCandidate(rawCandidate: unknown): StrategyRuntimeTerritoryCandidate[] {
  if (!isRecord(rawCandidate) || !isNonEmptyString(rawCandidate.roomName)) {
    return [];
  }

  return [
    {
      roomName: rawCandidate.roomName,
      ...(isNonEmptyString(rawCandidate.action) ? { action: rawCandidate.action } : {}),
      ...(isFiniteNumber(rawCandidate.score) ? { score: rawCandidate.score } : {}),
      ...(isNonEmptyString(rawCandidate.evidenceStatus) ? { evidenceStatus: rawCandidate.evidenceStatus } : {}),
      ...(isNonEmptyString(rawCandidate.source) ? { source: rawCandidate.source } : {}),
      ...(Array.isArray(rawCandidate.evidence) ? { evidence: rawCandidate.evidence.filter(isNonEmptyString) } : {}),
      ...(Array.isArray(rawCandidate.preconditions)
        ? { preconditions: rawCandidate.preconditions.filter(isNonEmptyString) }
        : {}),
      ...(Array.isArray(rawCandidate.risks) ? { risks: rawCandidate.risks.filter(isNonEmptyString) } : {}),
      ...(isFiniteNumber(rawCandidate.routeDistance) ? { routeDistance: rawCandidate.routeDistance } : {}),
      ...(isFiniteNumber(rawCandidate.sourceCount) ? { sourceCount: rawCandidate.sourceCount } : {}),
      ...(isFiniteNumber(rawCandidate.hostileCreepCount)
        ? { hostileCreepCount: rawCandidate.hostileCreepCount }
        : {}),
      ...(isFiniteNumber(rawCandidate.hostileStructureCount)
        ? { hostileStructureCount: rawCandidate.hostileStructureCount }
        : {})
    }
  ];
}

function normalizeCpuSummary(rawCpu: Record<string, unknown>): StrategyCpuSummary {
  return {
    ...(isFiniteNumber(rawCpu.used) ? { used: rawCpu.used } : {}),
    ...(isFiniteNumber(rawCpu.bucket) ? { bucket: rawCpu.bucket } : {})
  };
}

function normalizeReliabilitySignals(rawReliability: Record<string, unknown>): StrategyArtifactReliabilitySignals {
  return {
    ...(isFiniteNumber(rawReliability.loopExceptionCount)
      ? { loopExceptionCount: rawReliability.loopExceptionCount }
      : {}),
    ...(isFiniteNumber(rawReliability.telemetrySilenceTicks)
      ? { telemetrySilenceTicks: rawReliability.telemetrySilenceTicks }
      : {}),
    ...(isFiniteNumber(rawReliability.globalResetCount) ? { globalResetCount: rawReliability.globalResetCount } : {})
  };
}

function reduceRuntimeSummaryArtifact(
  artifact: StrategyRuntimeSummaryArtifact,
  reliabilityMetrics: StrategyReliabilityMetrics,
  territoryComponents: Record<string, number>,
  resourceComponents: Record<string, number>,
  killComponents: Record<string, number>,
  thresholds: StrategyReliabilityThresholds
): number {
  reliabilityMetrics.loopExceptionCount += artifact.reliability?.loopExceptionCount ?? 0;
  reliabilityMetrics.telemetrySilenceTicks += artifact.reliability?.telemetrySilenceTicks ?? 0;
  reliabilityMetrics.globalResetCount += artifact.reliability?.globalResetCount ?? 0;
  if (typeof artifact.cpu?.bucket === 'number') {
    reliabilityMetrics.minCpuBucket =
      reliabilityMetrics.minCpuBucket === undefined
        ? artifact.cpu.bucket
        : Math.min(reliabilityMetrics.minCpuBucket, artifact.cpu.bucket);
  }

  let ownedRoomCount = 0;
  for (const room of artifact.rooms) {
    if (room.controller) {
      ownedRoomCount += 1;
      territoryComponents.controllerLevels += room.controller.level;
      territoryComponents.controllerProgress += room.controller.progress ?? 0;
      if (
        typeof room.controller.ticksToDowngrade === 'number' &&
        room.controller.ticksToDowngrade <= thresholds.controllerDowngradeRiskTicks
      ) {
        reliabilityMetrics.controllerDowngradeRiskRooms += 1;
      }
    }

    if ((room.workerCount ?? 1) <= 0 && (room.spawnStatus?.length ?? 0) <= 0) {
      reliabilityMetrics.spawnCollapseRooms += 1;
    }

    resourceComponents.storedEnergy += room.resources?.storedEnergy ?? 0;
    resourceComponents.workerCarriedEnergy += room.resources?.workerCarriedEnergy ?? 0;
    resourceComponents.droppedEnergy += room.resources?.droppedEnergy ?? 0;
    resourceComponents.visibleSources += room.resources?.sourceCount ?? 0;
    resourceComponents.harvestedEnergy += room.resources?.events?.harvestedEnergy ?? 0;
    resourceComponents.transferredEnergy += room.resources?.events?.transferredEnergy ?? 0;

    killComponents.creepKills += room.combat?.events?.creepDestroyedCount ?? 0;
    killComponents.objectKills += room.combat?.events?.objectDestroyedCount ?? 0;
    killComponents.attackDamage += room.combat?.events?.attackDamage ?? 0;
    killComponents.hostilePressureObserved +=
      (room.combat?.hostileCreepCount ?? 0) + (room.combat?.hostileStructureCount ?? 0);

    const territoryCandidates = room.territoryRecommendation?.candidates ?? [];
    territoryComponents.reservedOrRemoteRooms += territoryCandidates.filter((candidate) =>
      candidate.action === 'occupy' || candidate.action === 'reserve'
    ).length;
    territoryComponents.territoryRecommendation += Math.max(
      0,
      ...territoryCandidates.map((candidate) => candidate.score ?? 0)
    );
  }

  territoryComponents.ownedRooms = Math.max(territoryComponents.ownedRooms, ownedRoomCount);
  return ownedRoomCount;
}

function reduceRoomSnapshotArtifact(
  artifact: StrategyRoomSnapshotArtifact,
  territoryComponents: Record<string, number>,
  resourceComponents: Record<string, number>,
  killComponents: Record<string, number>
): number {
  const controller = artifact.objects.find((object) => object.type === 'controller');
  const ownedController = controller && isOwnedSnapshotObject(controller, artifact.owner);
  const ownedRoomCount = ownedController ? 1 : 0;
  if (ownedController) {
    territoryComponents.ownedRooms = Math.max(territoryComponents.ownedRooms, 1);
    territoryComponents.controllerLevels += controller.level ?? 0;
  }

  for (const object of artifact.objects) {
    if (object.type === 'source') {
      resourceComponents.visibleSources += 1;
    }

    if (object.type === 'resource' && (object.resourceType === undefined || object.resourceType === 'energy')) {
      resourceComponents.droppedEnergy += object.amount ?? 0;
    }

    resourceComponents.storedEnergy += getSnapshotObjectEnergy(object);

    if (object.type === 'creep' && !isOwnedSnapshotObject(object, artifact.owner)) {
      killComponents.hostilePressureObserved += 1;
    }
  }

  return ownedRoomCount;
}

function evaluateReliabilityFloor(
  metrics: StrategyReliabilityMetrics,
  thresholds: StrategyReliabilityThresholds
): StrategyReliabilityEvaluation {
  const reasons: string[] = [];

  if (metrics.artifactCount < thresholds.minArtifactCount) {
    reasons.push(`artifact count ${metrics.artifactCount} below floor ${thresholds.minArtifactCount}`);
  }

  if (metrics.loopExceptionCount > thresholds.maxLoopExceptionCount) {
    reasons.push(`loop exceptions ${metrics.loopExceptionCount} exceed ${thresholds.maxLoopExceptionCount}`);
  }

  if (metrics.telemetrySilenceTicks > thresholds.maxTelemetrySilenceTicks) {
    reasons.push(`telemetry silence ${metrics.telemetrySilenceTicks} ticks exceeds ${thresholds.maxTelemetrySilenceTicks}`);
  }

  if (thresholds.minCpuBucket !== undefined && (metrics.minCpuBucket ?? thresholds.minCpuBucket) < thresholds.minCpuBucket) {
    reasons.push(`minimum CPU bucket ${metrics.minCpuBucket ?? 'unknown'} below ${thresholds.minCpuBucket}`);
  }

  if (metrics.controllerDowngradeRiskRooms > thresholds.maxControllerDowngradeRiskRooms) {
    reasons.push(
      `controller downgrade risk rooms ${metrics.controllerDowngradeRiskRooms} exceed ${thresholds.maxControllerDowngradeRiskRooms}`
    );
  }

  if (metrics.spawnCollapseRooms > thresholds.maxSpawnCollapseRooms) {
    reasons.push(`spawn collapse rooms ${metrics.spawnCollapseRooms} exceed ${thresholds.maxSpawnCollapseRooms}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    metrics
  };
}

function buildInitialReliabilityMetrics(artifacts: StrategyEvaluationArtifact[]): StrategyReliabilityMetrics {
  return {
    artifactCount: artifacts.length,
    runtimeSummaryCount: artifacts.filter((artifact) => artifact.artifactType === 'runtime-summary').length,
    roomSnapshotCount: artifacts.filter((artifact) => artifact.artifactType === 'room-snapshot').length,
    loopExceptionCount: 0,
    telemetrySilenceTicks: 0,
    globalResetCount: 0,
    controllerDowngradeRiskRooms: 0,
    spawnCollapseRooms: 0
  };
}

function compareReliability(left: StrategyReliabilityEvaluation, right: StrategyReliabilityEvaluation): number {
  if (left.passed !== right.passed) {
    return left.passed ? 1 : -1;
  }

  if (!left.passed && !right.passed) {
    return (
      compareNumber(right.reasons.length, left.reasons.length) ||
      compareNumber(right.metrics.loopExceptionCount, left.metrics.loopExceptionCount) ||
      compareNumber(right.metrics.telemetrySilenceTicks, left.metrics.telemetrySilenceTicks) ||
      compareNumber(right.metrics.controllerDowngradeRiskRooms, left.metrics.controllerDowngradeRiskRooms)
    );
  }

  return 0;
}

function compareNumber(left: number, right: number): number {
  if (left === right) {
    return 0;
  }

  return left > right ? 1 : -1;
}

function getSnapshotObjectEnergy(object: StrategyRoomSnapshotObject): number {
  if (typeof object.energy === 'number') {
    return object.energy;
  }

  const storeEnergy = object.store?.energy;
  return typeof storeEnergy === 'number' ? storeEnergy : 0;
}

function isOwnedSnapshotObject(object: StrategyRoomSnapshotObject, owner: string | undefined): boolean {
  if (object.my === true) {
    return true;
  }

  if (!owner) {
    return false;
  }

  return object.user === owner || object.owner?.username === owner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
