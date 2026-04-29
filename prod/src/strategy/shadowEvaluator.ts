import {
  DEFAULT_STRATEGY_REGISTRY,
  getStrategyNumberDefault,
  type StrategyModelFamily,
  type StrategyRegistryEntry
} from './strategyRegistry';
import {
  parseStrategyEvaluationArtifacts,
  reduceStrategyKpis,
  type StrategyEvaluationArtifact,
  type StrategyKpiVector,
  type StrategyRoomSnapshotArtifact,
  type StrategyRoomSnapshotObject,
  type StrategyRuntimeConstructionPriorityCandidate,
  type StrategyRuntimeSummaryArtifact,
  type StrategyRuntimeSummaryRoom,
  type StrategyRuntimeTerritoryCandidate
} from './kpiEvaluator';

export interface StrategyShadowEvaluatorConfig {
  enabled: boolean;
  incumbentStrategyIds: Partial<Record<StrategyModelFamily, string>>;
  candidateStrategyIds: string[];
}

export interface StrategyShadowReplayInput {
  artifacts?: string | unknown | unknown[] | StrategyEvaluationArtifact[];
  registry?: StrategyRegistryEntry[];
  config?: Partial<StrategyShadowEvaluatorConfig>;
}

export interface StrategyShadowReplayReport {
  enabled: boolean;
  artifactCount: number;
  kpi: StrategyKpiVector;
  modelReports: StrategyShadowModelReport[];
  disabledReason?: string;
  warnings: string[];
}

export interface StrategyShadowModelReport {
  incumbentStrategyId: string;
  candidateStrategyId: string;
  family: StrategyModelFamily;
  rankingDiffs: StrategyRankingDiff[];
}

export interface StrategyRankingDiff {
  artifactIndex: number;
  tick?: number;
  roomName?: string;
  context: string;
  incumbentTop: StrategyRankedItemSummary | null;
  candidateTop: StrategyRankedItemSummary | null;
  changedTop: boolean;
  rankChanges: StrategyRankChange[];
}

export interface StrategyRankChange {
  itemId: string;
  label: string;
  incumbentRank?: number;
  candidateRank?: number;
  delta?: number;
}

export interface StrategyRankedItemSummary {
  itemId: string;
  label: string;
  rank: number;
  score: number;
  baseScore: number;
}

interface StrategyRankingItem {
  itemId: string;
  label: string;
  context: string;
  artifactIndex: number;
  tick?: number;
  roomName?: string;
  baseScore: number;
  signals: StrategyRankingSignals;
}

interface StrategyScoredRankingItem extends StrategyRankingItem {
  rank: number;
  strategyScore: number;
}

interface StrategyRankingSignals {
  territory: number;
  resources: number;
  kills: number;
  reliability: number;
  risk: number;
}

const DEFAULT_INCUMBENT_STRATEGY_IDS: Record<StrategyModelFamily, string> = {
  'construction-priority': 'construction-priority.incumbent.v1',
  'expansion-remote-candidate': 'expansion-remote.incumbent.v1',
  'defense-posture-repair-threshold': 'defense-repair.incumbent.v1'
};

export const DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG: StrategyShadowEvaluatorConfig = {
  enabled: false,
  incumbentStrategyIds: DEFAULT_INCUMBENT_STRATEGY_IDS,
  candidateStrategyIds: []
};

export function evaluateStrategyShadowReplay(input: StrategyShadowReplayInput = {}): StrategyShadowReplayReport {
  const registry = input.registry ?? DEFAULT_STRATEGY_REGISTRY;
  const artifacts = parseStrategyEvaluationArtifacts(input.artifacts ?? []);
  const kpi = reduceStrategyKpis(artifacts);
  const config = normalizeShadowConfig(input.config);

  if (!config.enabled) {
    return {
      enabled: false,
      artifactCount: artifacts.length,
      kpi,
      modelReports: [],
      disabledReason: 'strategy shadow evaluator disabled',
      warnings: []
    };
  }

  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  const candidateStrategyIds =
    config.candidateStrategyIds.length > 0
      ? config.candidateStrategyIds
      : registry.filter((entry) => entry.rolloutStatus === 'shadow').map((entry) => entry.id);
  const warnings: string[] = [];
  const modelReports: StrategyShadowModelReport[] = [];

  for (const candidateStrategyId of candidateStrategyIds) {
    const candidate = registryById.get(candidateStrategyId);
    if (!candidate) {
      warnings.push(`candidate strategy not found: ${candidateStrategyId}`);
      continue;
    }

    const incumbentStrategyId = config.incumbentStrategyIds[candidate.family];
    const incumbent = incumbentStrategyId ? registryById.get(incumbentStrategyId) : undefined;
    if (!incumbentStrategyId || !incumbent) {
      warnings.push(`incumbent strategy not found for ${candidate.id}`);
      continue;
    }

    if (incumbent.family !== candidate.family) {
      warnings.push(`incumbent ${incumbent.id} does not match candidate family ${candidate.family}`);
      continue;
    }

    modelReports.push(evaluateModelPair(artifacts, incumbent, candidate));
  }

  return {
    enabled: true,
    artifactCount: artifacts.length,
    kpi,
    modelReports,
    warnings
  };
}

function normalizeShadowConfig(config: Partial<StrategyShadowEvaluatorConfig> | undefined): StrategyShadowEvaluatorConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG.enabled,
    incumbentStrategyIds: {
      ...DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG.incumbentStrategyIds,
      ...(config?.incumbentStrategyIds ?? {})
    },
    candidateStrategyIds: config?.candidateStrategyIds ?? DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG.candidateStrategyIds
  };
}

function evaluateModelPair(
  artifacts: StrategyEvaluationArtifact[],
  incumbent: StrategyRegistryEntry,
  candidate: StrategyRegistryEntry
): StrategyShadowModelReport {
  const rankingDiffs: StrategyRankingDiff[] = [];

  artifacts.forEach((artifact, artifactIndex) => {
    const rankingGroups = buildRankingGroups(artifact, artifactIndex, candidate.family);
    for (const group of rankingGroups) {
      const incumbentRanking = scoreRankingItems(group.items, incumbent);
      const candidateRanking = scoreRankingItems(group.items, candidate);
      const rankingDiff = buildRankingDiff(group, incumbentRanking, candidateRanking);
      if (rankingDiff.changedTop || rankingDiff.rankChanges.length > 0) {
        rankingDiffs.push(rankingDiff);
      }
    }
  });

  return {
    incumbentStrategyId: incumbent.id,
    candidateStrategyId: candidate.id,
    family: candidate.family,
    rankingDiffs
  };
}

function buildRankingGroups(
  artifact: StrategyEvaluationArtifact,
  artifactIndex: number,
  family: StrategyModelFamily
): Array<{ context: string; tick?: number; roomName?: string; items: StrategyRankingItem[] }> {
  if (artifact.artifactType === 'runtime-summary') {
    return buildRuntimeSummaryRankingGroups(artifact, artifactIndex, family);
  }

  return buildRoomSnapshotRankingGroups(artifact, artifactIndex, family);
}

function buildRuntimeSummaryRankingGroups(
  artifact: StrategyRuntimeSummaryArtifact,
  artifactIndex: number,
  family: StrategyModelFamily
): Array<{ context: string; tick?: number; roomName?: string; items: StrategyRankingItem[] }> {
  const groups: Array<{ context: string; tick?: number; roomName?: string; items: StrategyRankingItem[] }> = [];

  for (const room of artifact.rooms) {
    const items = buildRuntimeRoomRankingItems(room, artifactIndex, artifact.tick, family);
    if (items.length > 0) {
      groups.push({
        context: family,
        ...(artifact.tick !== undefined ? { tick: artifact.tick } : {}),
        roomName: room.roomName,
        items
      });
    }
  }

  return groups;
}

function buildRoomSnapshotRankingGroups(
  artifact: StrategyRoomSnapshotArtifact,
  artifactIndex: number,
  family: StrategyModelFamily
): Array<{ context: string; tick?: number; roomName?: string; items: StrategyRankingItem[] }> {
  if (family !== 'defense-posture-repair-threshold') {
    return [];
  }

  const repairItems = artifact.objects.flatMap((object) =>
    buildRepairRankingItem(artifact, object, artifactIndex, artifact.tick)
  );
  if (repairItems.length === 0) {
    return [];
  }

  return [
    {
      context: family,
      ...(artifact.tick !== undefined ? { tick: artifact.tick } : {}),
      ...(artifact.roomName ? { roomName: artifact.roomName } : {}),
      items: repairItems
    }
  ];
}

function buildRuntimeRoomRankingItems(
  room: StrategyRuntimeSummaryRoom,
  artifactIndex: number,
  tick: number | undefined,
  family: StrategyModelFamily
): StrategyRankingItem[] {
  switch (family) {
    case 'construction-priority':
      return (room.constructionPriority?.candidates ?? []).map((candidate) =>
        buildConstructionRankingItem(room, candidate, artifactIndex, tick)
      );
    case 'expansion-remote-candidate':
      return (room.territoryRecommendation?.candidates ?? []).map((candidate) =>
        buildTerritoryRankingItem(room, candidate, artifactIndex, tick)
      );
    case 'defense-posture-repair-threshold':
      return [buildRuntimeDefenseRankingItem(room, artifactIndex, tick)];
    default:
      return [];
  }
}

function buildConstructionRankingItem(
  room: StrategyRuntimeSummaryRoom,
  candidate: StrategyRuntimeConstructionPriorityCandidate,
  artifactIndex: number,
  tick: number | undefined
): StrategyRankingItem {
  const text = [
    candidate.buildItem,
    ...(candidate.expectedKpiMovement ?? []),
    ...(candidate.preconditions ?? []),
    ...(candidate.risk ?? [])
  ].join(' ');
  const signals = classifyStrategyText(text);

  return {
    itemId: `${room.roomName}:construction:${candidate.buildItem}`,
    label: candidate.buildItem,
    context: 'construction-priority',
    artifactIndex,
    ...(tick !== undefined ? { tick } : {}),
    roomName: room.roomName,
    baseScore: candidate.score ?? 0,
    signals: {
      territory: signals.territory,
      resources: signals.resources,
      kills: signals.kills,
      reliability: signals.reliability + urgencyReliabilitySignal(candidate.urgency),
      risk: (candidate.risk?.length ?? 0) + (candidate.preconditions?.length ?? 0) * 2
    }
  };
}

function buildTerritoryRankingItem(
  room: StrategyRuntimeSummaryRoom,
  candidate: StrategyRuntimeTerritoryCandidate,
  artifactIndex: number,
  tick: number | undefined
): StrategyRankingItem {
  const actionTerritorySignal = candidate.action === 'occupy' ? 8 : candidate.action === 'reserve' ? 6 : 2;
  const hostileRisk = (candidate.hostileCreepCount ?? 0) * 5 + (candidate.hostileStructureCount ?? 0) * 4;
  const evidenceRisk =
    candidate.evidenceStatus === 'unavailable' ? 12 : candidate.evidenceStatus === 'insufficient-evidence' ? 5 : 0;

  return {
    itemId: `${room.roomName}:territory:${candidate.roomName}:${candidate.action ?? 'unknown'}`,
    label: `${candidate.action ?? 'score'} ${candidate.roomName}`,
    context: 'expansion-remote-candidate',
    artifactIndex,
    ...(tick !== undefined ? { tick } : {}),
    roomName: room.roomName,
    baseScore: candidate.score ?? 0,
    signals: {
      territory: actionTerritorySignal + (candidate.source === 'configured' ? 2 : 0),
      resources: Math.min(candidate.sourceCount ?? 0, 3) * 2,
      kills: hostileRisk > 0 ? 1 : 0,
      reliability: candidate.evidenceStatus === 'sufficient' ? 1 : 0,
      risk: hostileRisk + evidenceRisk + (candidate.risks?.length ?? 0) + Math.max(0, (candidate.routeDistance ?? 1) - 1)
    }
  };
}

function buildRuntimeDefenseRankingItem(
  room: StrategyRuntimeSummaryRoom,
  artifactIndex: number,
  tick: number | undefined
): StrategyRankingItem {
  const hostilePressure = (room.combat?.hostileCreepCount ?? 0) * 15 + (room.combat?.hostileStructureCount ?? 0) * 8;
  const downgradePressure =
    typeof room.controller?.ticksToDowngrade === 'number'
      ? Math.max(0, 5_000 - room.controller.ticksToDowngrade) / 500
      : 0;
  const baseScore = hostilePressure + downgradePressure;

  return {
    itemId: `${room.roomName}:defense-posture`,
    label: `defense posture ${room.roomName}`,
    context: 'defense-posture-repair-threshold',
    artifactIndex,
    ...(tick !== undefined ? { tick } : {}),
    roomName: room.roomName,
    baseScore,
    signals: {
      territory: downgradePressure > 0 ? 3 : 1,
      resources: (room.resources?.storedEnergy ?? 0) > 0 ? 1 : 0,
      kills: hostilePressure > 0 ? 4 : 0,
      reliability: downgradePressure > 0 || hostilePressure > 0 ? 3 : 1,
      risk: baseScore === 0 ? 1 : 0
    }
  };
}

function buildRepairRankingItem(
  artifact: StrategyRoomSnapshotArtifact,
  object: StrategyRoomSnapshotObject,
  artifactIndex: number,
  tick: number | undefined
): StrategyRankingItem[] {
  if (!isDamageableSnapshotStructure(object) || typeof object.hits !== 'number' || typeof object.hitsMax !== 'number') {
    return [];
  }

  const damageRatio = object.hitsMax > 0 ? Math.max(0, 1 - object.hits / object.hitsMax) : 0;
  if (damageRatio <= 0) {
    return [];
  }

  const roomName = artifact.roomName ?? object.room;
  const criticalStructureSignal = object.type === 'spawn' || object.type === 'tower' || object.type === 'storage' ? 3 : 1;

  return [
    {
      itemId: `${roomName ?? 'unknown'}:repair:${object.type ?? 'structure'}:${object.id ?? 'unknown'}`,
      label: `repair ${object.type ?? 'structure'}`,
      context: 'defense-posture-repair-threshold',
      artifactIndex,
      ...(tick !== undefined ? { tick } : {}),
      ...(roomName ? { roomName } : {}),
      baseScore: damageRatio * 100,
      signals: {
        territory: object.type === 'spawn' || object.type === 'tower' ? criticalStructureSignal : 1,
        resources: object.type === 'storage' || object.type === 'container' ? criticalStructureSignal : 1,
        kills: object.type === 'rampart' || object.type === 'tower' ? criticalStructureSignal : 0,
        reliability: criticalStructureSignal,
        risk: damageRatio >= 0.5 ? 0 : 1
      }
    }
  ];
}

function scoreRankingItems(items: StrategyRankingItem[], entry: StrategyRegistryEntry): StrategyScoredRankingItem[] {
  return items
    .map((item) => ({
      ...item,
      strategyScore: calculateStrategyScore(item, entry),
      rank: 0
    }))
    .sort(compareScoredRankingItems)
    .map((item, index) => ({
      ...item,
      rank: index + 1
    }));
}

function calculateStrategyScore(item: StrategyRankingItem, entry: StrategyRegistryEntry): number {
  const baseScoreWeight = getStrategyNumberDefault(entry, 'baseScoreWeight', 1);
  const territorySignalWeight = getStrategyNumberDefault(entry, 'territorySignalWeight', 0);
  const resourceSignalWeight = getStrategyNumberDefault(entry, 'resourceSignalWeight', 0);
  const killSignalWeight = getStrategyNumberDefault(entry, 'killSignalWeight', 0);
  const riskPenalty = getStrategyNumberDefault(entry, 'riskPenalty', 0);

  return (
    item.baseScore * baseScoreWeight +
    item.signals.territory * territorySignalWeight +
    item.signals.resources * resourceSignalWeight +
    item.signals.kills * killSignalWeight +
    item.signals.reliability * Math.max(territorySignalWeight, killSignalWeight) -
    item.signals.risk * riskPenalty
  );
}

function compareScoredRankingItems(left: StrategyScoredRankingItem, right: StrategyScoredRankingItem): number {
  return (
    right.strategyScore - left.strategyScore ||
    right.baseScore - left.baseScore ||
    left.label.localeCompare(right.label) ||
    left.itemId.localeCompare(right.itemId)
  );
}

function buildRankingDiff(
  group: { context: string; tick?: number; roomName?: string; items: StrategyRankingItem[] },
  incumbentRanking: StrategyScoredRankingItem[],
  candidateRanking: StrategyScoredRankingItem[]
): StrategyRankingDiff {
  const incumbentTop = incumbentRanking[0] ? summarizeRankedItem(incumbentRanking[0]) : null;
  const candidateTop = candidateRanking[0] ? summarizeRankedItem(candidateRanking[0]) : null;
  const incumbentRanks = new Map(incumbentRanking.map((item) => [item.itemId, item]));
  const candidateRanks = new Map(candidateRanking.map((item) => [item.itemId, item]));
  const itemIds = Array.from(new Set([...incumbentRanks.keys(), ...candidateRanks.keys()])).sort();
  const rankChanges = itemIds.flatMap((itemId): StrategyRankChange[] => {
    const incumbentItem = incumbentRanks.get(itemId);
    const candidateItem = candidateRanks.get(itemId);
    if (incumbentItem?.rank === candidateItem?.rank) {
      return [];
    }

    const label = incumbentItem?.label ?? candidateItem?.label ?? itemId;
    const incumbentRank = incumbentItem?.rank;
    const candidateRank = candidateItem?.rank;
    return [
      {
        itemId,
        label,
        ...(incumbentRank !== undefined ? { incumbentRank } : {}),
        ...(candidateRank !== undefined ? { candidateRank } : {}),
        ...(incumbentRank !== undefined && candidateRank !== undefined
          ? { delta: incumbentRank - candidateRank }
          : {})
      }
    ];
  });

  return {
    artifactIndex: group.items[0]?.artifactIndex ?? 0,
    ...(group.tick !== undefined ? { tick: group.tick } : {}),
    ...(group.roomName ? { roomName: group.roomName } : {}),
    context: group.context,
    incumbentTop,
    candidateTop,
    changedTop: incumbentTop?.itemId !== candidateTop?.itemId,
    rankChanges
  };
}

function summarizeRankedItem(item: StrategyScoredRankingItem): StrategyRankedItemSummary {
  return {
    itemId: item.itemId,
    label: item.label,
    rank: item.rank,
    score: roundScore(item.strategyScore),
    baseScore: roundScore(item.baseScore)
  };
}

function classifyStrategyText(text: string): StrategyRankingSignals {
  const normalizedText = text.toLowerCase();
  return {
    territory: countSignalWords(normalizedText, [
      'territory',
      'remote',
      'controller',
      'rcl',
      'expansion',
      'claim',
      'reserve',
      'room'
    ]),
    resources: countSignalWords(normalizedText, [
      'energy',
      'resource',
      'resources',
      'harvest',
      'storage',
      'source',
      'throughput',
      'capacity',
      'worker'
    ]),
    kills: countSignalWords(normalizedText, ['kill', 'enemy', 'hostile', 'tower', 'rampart', 'defense', 'survivability']),
    reliability: countSignalWords(normalizedText, ['spawn', 'recovery', 'downgrade', 'repair', 'safe', 'survival']),
    risk: countSignalWords(normalizedText, ['risk', 'blocked', 'decay', 'hostile', 'unavailable', 'missing'])
  };
}

function urgencyReliabilitySignal(urgency: string | undefined): number {
  switch (urgency) {
    case 'critical':
      return 3;
    case 'high':
      return 2;
    case 'medium':
      return 1;
    default:
      return 0;
  }
}

function countSignalWords(text: string, words: string[]): number {
  return words.reduce((count, word) => count + (text.includes(word) ? 1 : 0), 0);
}

function roundScore(score: number): number {
  return Math.round(score * 1_000) / 1_000;
}

function isDamageableSnapshotStructure(object: StrategyRoomSnapshotObject): boolean {
  return (
    object.type === 'constructedWall' ||
    object.type === 'container' ||
    object.type === 'extension' ||
    object.type === 'rampart' ||
    object.type === 'road' ||
    object.type === 'spawn' ||
    object.type === 'storage' ||
    object.type === 'tower'
  );
}
