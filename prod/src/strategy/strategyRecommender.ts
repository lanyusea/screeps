import type { ColonySnapshot } from '../colony/colonyRegistry';

export type StrategyDefensePosture = 'passive' | 'alert' | 'active';

export interface StrategyRecommendation {
  constructionPreset?: string;
  remoteTarget?: string;
  expansionCandidate?: string;
  defensePosture?: StrategyDefensePosture;
  confidence: number;
  reasoning: string;
}

export interface StrategyRecommendationRoomState {
  roomName?: string;
  controllerLevel?: number;
  creepCount?: number;
  workerCount?: number;
  energyAvailable?: number;
  energyCapacity?: number;
  storedEnergy?: number;
  sourceCount?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  towerCount?: number;
  rampartCount?: number;
  pendingConstructionSiteCount?: number;
  repairBacklogHits?: number;
  territory?: StrategyRecommendationTerritoryState;
}

export interface StrategyRecommendationTerritoryState {
  ownedRoomCount?: number;
  remoteTargets?: StrategyRecommendationTerritoryCandidate[];
  expansionCandidates?: StrategyRecommendationTerritoryCandidate[];
}

export interface StrategyRecommendationTerritoryCandidate {
  roomName: string;
  action?: 'claim' | 'occupy' | 'reserve' | 'scout';
  score?: number;
  routeDistance?: number;
  sourceCount?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  evidenceStatus?: string;
}

interface NormalizedStrategyRoomState {
  roomName: string;
  controllerLevel: number;
  creepCount: number;
  workerCount: number;
  energyAvailable: number;
  energyCapacity: number;
  storedEnergy: number;
  sourceCount: number;
  hostileCreepCount: number;
  hostileStructureCount: number;
  towerCount: number;
  rampartCount: number;
  pendingConstructionSiteCount: number;
  repairBacklogHits: number;
  territory: {
    ownedRoomCount: number;
    remoteTargets: StrategyRecommendationTerritoryCandidate[];
    expansionCandidates: StrategyRecommendationTerritoryCandidate[];
  };
}

export const DEFAULT_STRATEGY_RECOMMENDATION_CONFIDENCE_THRESHOLD = 0.7;

const MAX_RECOMMENDATIONS = 5;
const LOW_RCL_ENERGY_CAPACITY_TARGET = 550;
const TERRITORY_READY_RCL = 3;
const EXPANSION_READY_RCL = 4;
const HIGH_RCL = 5;
const CRITICAL_REPAIR_BACKLOG_HITS = 100_000;

export function rejectUncertain(
  recommendations: StrategyRecommendation[],
  threshold = DEFAULT_STRATEGY_RECOMMENDATION_CONFIDENCE_THRESHOLD
): StrategyRecommendation[] {
  const resolvedThreshold = clampConfidence(threshold);
  return recommendations.filter(
    (recommendation) =>
      Number.isFinite(recommendation.confidence) && recommendation.confidence >= resolvedThreshold
  );
}

export function generateStrategyRecommendations(
  roomState: StrategyRecommendationRoomState
): StrategyRecommendation[] {
  if (!hasRoomStateEvidence(roomState)) {
    return [
      makeRecommendation({
        defensePosture: 'passive',
        confidence: 0.42,
        reasoning: 'room state is empty; keep strategy recommendation in observation-only mode'
      })
    ];
  }

  const state = normalizeRoomState(roomState);
  const recommendations: StrategyRecommendation[] = [];

  const hostilePressure = state.hostileCreepCount + state.hostileStructureCount;
  if (hostilePressure > 0) {
    recommendations.push(
      makeRecommendation({
        constructionPreset: 'defense-repair-and-ramparts',
        defensePosture: 'active',
        confidence: state.hostileCreepCount > 0 ? 0.94 : 0.86,
        reasoning: `hostile pressure visible in ${state.roomName}; keep strategy shadowed on active defense posture`
      })
    );
  } else if (state.controllerLevel >= TERRITORY_READY_RCL && state.towerCount === 0) {
    recommendations.push(
      makeRecommendation({
        constructionPreset: 'tower-bootstrap',
        defensePosture: 'alert',
        confidence: 0.74,
        reasoning: `${state.roomName} has RCL ${state.controllerLevel} but no tower coverage`
      })
    );
  } else if (state.repairBacklogHits >= CRITICAL_REPAIR_BACKLOG_HITS) {
    recommendations.push(
      makeRecommendation({
        constructionPreset: 'critical-repair-stabilization',
        defensePosture: 'alert',
        confidence: 0.72,
        reasoning: `${state.roomName} has a large repair backlog before territory growth should escalate`
      })
    );
  }

  if (state.controllerLevel <= 1 || state.workerCount <= 1) {
    recommendations.push(
      makeRecommendation({
        constructionPreset: 'bootstrap-spawn-extension-sources',
        defensePosture: hostilePressure > 0 ? 'active' : 'passive',
        confidence: state.workerCount === 0 ? 0.84 : 0.8,
        reasoning: `${state.roomName} needs bootstrap worker and source throughput before higher-level strategy changes`
      })
    );
  } else if (state.controllerLevel <= 3 || state.energyCapacity < LOW_RCL_ENERGY_CAPACITY_TARGET) {
    recommendations.push(
      makeRecommendation({
        constructionPreset: 'extension-container-road-bootstrap',
        defensePosture: hostilePressure > 0 ? 'active' : 'passive',
        confidence: state.energyCapacity < LOW_RCL_ENERGY_CAPACITY_TARGET ? 0.82 : 0.76,
        reasoning: `${state.roomName} should favor energy capacity, containers, and roads at RCL ${state.controllerLevel}`
      })
    );
  } else if (state.controllerLevel >= HIGH_RCL) {
    recommendations.push(
      makeRecommendation({
        constructionPreset: 'storage-road-territory-logistics',
        defensePosture: hostilePressure > 0 ? 'active' : 'passive',
        confidence: state.energyCapacity >= 1300 || state.storedEnergy > 5000 ? 0.78 : 0.7,
        reasoning: `${state.roomName} has high-RCL infrastructure; prioritize logistics that support territory growth`
      })
    );
  }

  const remoteTarget = selectBestTerritoryCandidate(state.territory.remoteTargets);
  if (remoteTarget && state.controllerLevel >= TERRITORY_READY_RCL && state.workerCount >= 3 && hostilePressure === 0) {
    recommendations.push(
      makeRecommendation({
        remoteTarget: remoteTarget.roomName,
        defensePosture: 'passive',
        confidence: scoreTerritoryCandidate(remoteTarget, 0.72),
        reasoning: `${remoteTarget.roomName} is the strongest low-risk remote target for ${state.roomName}`
      })
    );
  }

  const expansionCandidate = selectBestTerritoryCandidate(state.territory.expansionCandidates);
  if (expansionCandidate && state.controllerLevel >= EXPANSION_READY_RCL && state.workerCount >= 4 && hostilePressure === 0) {
    recommendations.push(
      makeRecommendation({
        expansionCandidate: expansionCandidate.roomName,
        defensePosture: 'passive',
        confidence: scoreTerritoryCandidate(expansionCandidate, 0.76),
        reasoning: `${expansionCandidate.roomName} is the strongest shadow-mode expansion candidate for ${state.roomName}`
      })
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      makeRecommendation({
        defensePosture: 'passive',
        confidence: 0.42,
        reasoning: `${state.roomName} has insufficient strategy evidence for a high-confidence recommendation`
      })
    );
  }

  return recommendations
    .sort((left, right) => right.confidence - left.confidence || left.reasoning.localeCompare(right.reasoning))
    .slice(0, MAX_RECOMMENDATIONS);
}

function hasRoomStateEvidence(roomState: StrategyRecommendationRoomState): boolean {
  return (
    typeof roomState.roomName === 'string' ||
    Number.isFinite(roomState.controllerLevel) ||
    Number.isFinite(roomState.creepCount) ||
    Number.isFinite(roomState.workerCount) ||
    Number.isFinite(roomState.energyAvailable) ||
    Number.isFinite(roomState.energyCapacity) ||
    Number.isFinite(roomState.sourceCount) ||
    Number.isFinite(roomState.hostileCreepCount) ||
    Number.isFinite(roomState.hostileStructureCount)
  );
}

export function buildStrategyRecommendationRoomState(
  colony: ColonySnapshot,
  creeps: Creep[]
): StrategyRecommendationRoomState {
  const room = colony.room;
  const colonyCreeps = creeps.filter(
    (creep) => creep.memory.colony === room.name || creep.room?.name === room.name
  );
  const hostileCreeps = findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS');
  const hostileStructures = findRoomObjects<Structure>(room, 'FIND_HOSTILE_STRUCTURES');
  const ownedStructures = findRoomObjects<Structure>(room, 'FIND_MY_STRUCTURES');
  const constructionSites = findRoomObjects<ConstructionSite>(room, 'FIND_MY_CONSTRUCTION_SITES');
  const sources = findRoomObjects<Source>(room, 'FIND_SOURCES');

  return {
    roomName: room.name,
    controllerLevel: room.controller?.level,
    creepCount: colonyCreeps.length,
    workerCount: colonyCreeps.filter((creep) => creep.memory.role === 'worker').length,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    storedEnergy: getStoredEnergy(room),
    sourceCount: sources.length,
    hostileCreepCount: hostileCreeps.length,
    hostileStructureCount: hostileStructures.length,
    towerCount: countStructuresByType(ownedStructures, 'STRUCTURE_TOWER', 'tower'),
    rampartCount: countStructuresByType(ownedStructures, 'STRUCTURE_RAMPART', 'rampart'),
    pendingConstructionSiteCount: constructionSites.length,
    repairBacklogHits: estimateRepairBacklogHits(ownedStructures),
    territory: buildMemoryTerritoryState(room.name)
  };
}

function normalizeRoomState(roomState: StrategyRecommendationRoomState): NormalizedStrategyRoomState {
  const workerCount = finiteNumberOrZero(roomState.workerCount);
  const creepCount = Math.max(finiteNumberOrZero(roomState.creepCount), workerCount);
  return {
    roomName: roomState.roomName && roomState.roomName.length > 0 ? roomState.roomName : 'unknown-room',
    controllerLevel: clampInteger(roomState.controllerLevel, 0, 8),
    creepCount,
    workerCount,
    energyAvailable: finiteNumberOrZero(roomState.energyAvailable),
    energyCapacity: finiteNumberOrZero(roomState.energyCapacity),
    storedEnergy: finiteNumberOrZero(roomState.storedEnergy),
    sourceCount: finiteNumberOrZero(roomState.sourceCount),
    hostileCreepCount: finiteNumberOrZero(roomState.hostileCreepCount),
    hostileStructureCount: finiteNumberOrZero(roomState.hostileStructureCount),
    towerCount: finiteNumberOrZero(roomState.towerCount),
    rampartCount: finiteNumberOrZero(roomState.rampartCount),
    pendingConstructionSiteCount: finiteNumberOrZero(roomState.pendingConstructionSiteCount),
    repairBacklogHits: finiteNumberOrZero(roomState.repairBacklogHits),
    territory: {
      ownedRoomCount: finiteNumberOrZero(roomState.territory?.ownedRoomCount),
      remoteTargets: normalizeTerritoryCandidates(roomState.territory?.remoteTargets),
      expansionCandidates: normalizeTerritoryCandidates(roomState.territory?.expansionCandidates)
    }
  };
}

function normalizeTerritoryCandidates(
  candidates: StrategyRecommendationTerritoryCandidate[] | undefined
): StrategyRecommendationTerritoryCandidate[] {
  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates
    .filter((candidate) => candidate.roomName.length > 0)
    .map((candidate) => ({
      roomName: candidate.roomName,
      ...(candidate.action ? { action: candidate.action } : {}),
      ...(Number.isFinite(candidate.score) ? { score: candidate.score } : {}),
      ...(Number.isFinite(candidate.routeDistance) ? { routeDistance: candidate.routeDistance } : {}),
      ...(Number.isFinite(candidate.sourceCount) ? { sourceCount: candidate.sourceCount } : {}),
      ...(Number.isFinite(candidate.hostileCreepCount) ? { hostileCreepCount: candidate.hostileCreepCount } : {}),
      ...(Number.isFinite(candidate.hostileStructureCount)
        ? { hostileStructureCount: candidate.hostileStructureCount }
        : {}),
      ...(candidate.evidenceStatus ? { evidenceStatus: candidate.evidenceStatus } : {})
    }));
}

function selectBestTerritoryCandidate(
  candidates: StrategyRecommendationTerritoryCandidate[]
): StrategyRecommendationTerritoryCandidate | null {
  return [...candidates].sort(compareTerritoryCandidates)[0] ?? null;
}

function compareTerritoryCandidates(
  left: StrategyRecommendationTerritoryCandidate,
  right: StrategyRecommendationTerritoryCandidate
): number {
  return (
    scoreTerritoryCandidate(right, 0) - scoreTerritoryCandidate(left, 0) ||
    (left.routeDistance ?? Number.POSITIVE_INFINITY) - (right.routeDistance ?? Number.POSITIVE_INFINITY) ||
    left.roomName.localeCompare(right.roomName)
  );
}

function scoreTerritoryCandidate(candidate: StrategyRecommendationTerritoryCandidate, baseConfidence: number): number {
  const rawScore = Number.isFinite(candidate.score) ? Math.min(Math.max(candidate.score ?? 0, 0) / 1000, 0.12) : 0;
  const sourceBonus = Math.min(finiteNumberOrZero(candidate.sourceCount) * 0.03, 0.06);
  const routeBonus =
    Number.isFinite(candidate.routeDistance) && (candidate.routeDistance ?? Number.POSITIVE_INFINITY) <= 2 ? 0.04 : 0;
  const evidenceBonus = candidate.evidenceStatus === 'sufficient' ? 0.05 : 0;
  const hostilePenalty =
    finiteNumberOrZero(candidate.hostileCreepCount) > 0 || finiteNumberOrZero(candidate.hostileStructureCount) > 0
      ? 0.36
      : 0;
  return clampConfidence(baseConfidence + rawScore + sourceBonus + routeBonus + evidenceBonus - hostilePenalty);
}

function makeRecommendation(recommendation: StrategyRecommendation): StrategyRecommendation {
  return {
    ...recommendation,
    confidence: clampConfidence(recommendation.confidence)
  };
}

function buildMemoryTerritoryState(roomName: string): StrategyRecommendationTerritoryState {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  const targets = memory?.territory?.targets;
  const remoteTargets: StrategyRecommendationTerritoryCandidate[] = [];
  const expansionCandidates: StrategyRecommendationTerritoryCandidate[] = [];

  if (Array.isArray(targets)) {
    for (const target of targets) {
      if (!isRecord(target) || target.colony !== roomName || typeof target.roomName !== 'string') {
        continue;
      }
      const action = normalizeTerritoryAction(target.action);
      if (!action) {
        continue;
      }
      const candidate = {
        roomName: target.roomName,
        action
      };
      if (action === 'claim') {
        expansionCandidates.push(candidate);
      } else {
        remoteTargets.push(candidate);
      }
    }
  }

  const roomMemory = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName]?.memory;
  const cachedExpansionSelection = roomMemory?.cachedExpansionSelection;
  if (
    cachedExpansionSelection?.status === 'planned' &&
    cachedExpansionSelection.colony === roomName &&
    cachedExpansionSelection.targetRoom
  ) {
    expansionCandidates.push({
      roomName: cachedExpansionSelection.targetRoom,
      action: 'claim',
      ...(Number.isFinite(cachedExpansionSelection.score) ? { score: cachedExpansionSelection.score } : {})
    });
  }

  return {
    ownedRoomCount: countVisibleOwnedRooms(),
    remoteTargets: deduplicateTerritoryCandidates(remoteTargets),
    expansionCandidates: deduplicateTerritoryCandidates(expansionCandidates)
  };
}

function deduplicateTerritoryCandidates(
  candidates: StrategyRecommendationTerritoryCandidate[]
): StrategyRecommendationTerritoryCandidate[] {
  const byRoom = new Map<string, StrategyRecommendationTerritoryCandidate>();
  for (const candidate of candidates) {
    const existing = byRoom.get(candidate.roomName);
    if (!existing || scoreTerritoryCandidate(candidate, 0) > scoreTerritoryCandidate(existing, 0)) {
      byRoom.set(candidate.roomName, candidate);
    }
  }
  return [...byRoom.values()].sort(compareTerritoryCandidates);
}

function normalizeTerritoryAction(action: unknown): StrategyRecommendationTerritoryCandidate['action'] | undefined {
  if (action === 'claim' || action === 'reserve' || action === 'scout') {
    return action;
  }
  return undefined;
}

function countVisibleOwnedRooms(): number {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return 0;
  }
  return Object.values(rooms).filter((room) => room?.controller?.my === true).length;
}

function countStructuresByType(structures: unknown[], globalName: string, fallback: string): number {
  return structures.filter(
    (structure) => isRecord(structure) && matchesStructureType(structure.structureType, globalName, fallback)
  ).length;
}

function estimateRepairBacklogHits(structures: unknown[]): number {
  return structures.reduce<number>((total, structure) => {
    if (!isRecord(structure)) {
      return total;
    }
    const hits = finiteNumberOrNull(structure.hits);
    const hitsMax = finiteNumberOrNull(structure.hitsMax);
    if (hits === null || hitsMax === null || hitsMax <= hits) {
      return total;
    }
    return total + (hitsMax - hits);
  }, 0);
}

function getStoredEnergy(room: Room): number {
  const storage = (room as { storage?: unknown }).storage;
  return getEnergyInStore(storage);
}

function getEnergyInStore(object: unknown): number {
  if (!isRecord(object) || !isRecord(object.store)) {
    return 0;
  }

  const getUsedCapacity = object.store.getUsedCapacity;
  const resourceEnergy = getResourceEnergy();
  if (typeof getUsedCapacity === 'function') {
    const value = getUsedCapacity.call(object.store, resourceEnergy);
    return finiteNumberOrZero(value);
  }

  return finiteNumberOrZero(object.store[resourceEnergy]);
}

function findRoomObjects<T>(room: Room, constantName: string): T[] {
  const findConstant = getGlobalNumber(constantName);
  const find = (room as unknown as { find?: unknown }).find;
  if (typeof findConstant !== 'number' || typeof find !== 'function') {
    return [];
  }

  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function matchesStructureType(value: unknown, globalName: string, fallback: string): boolean {
  const globalValue = (globalThis as Record<string, unknown>)[globalName];
  return value === globalValue || value === fallback;
}

function getResourceEnergy(): ResourceConstant {
  const value = (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
  return value ?? ('energy' as ResourceConstant);
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function clampInteger(value: unknown, min: number, max: number): number {
  return Math.trunc(Math.min(Math.max(finiteNumberOrZero(value), min), max));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(Number(value.toFixed(3)), 0), 1);
}

function finiteNumberOrZero(value: unknown): number {
  return finiteNumberOrNull(value) ?? 0;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
