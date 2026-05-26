import type { StrategyKnobValue, StrategyRegistryEntry } from './strategyRegistry';

export const RUNTIME_POLICY_PARAMETERS_GLOBAL = '__SCREEPS_RL_RUNTIME_POLICY_PARAMETERS__';
export const RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL = '__SCREEPS_RL_RUNTIME_POLICY_PARAMETER_CONSUMPTION__';
export const RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER = 'screeps-rl-runtime-policy-parameters-consumer-v1';
export const RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION = 'v1';
export const RUNTIME_POLICY_PARAMETER_CONSUMPTION_LOG_PREFIX = '#runtime-parameter-consumption ';

declare const __SCREEPS_RL_RUNTIME_POLICY_PARAMETERS__: unknown;

export interface RuntimePolicyParameterConsumptionEvidence {
  type: 'screeps-rl-runtime-policy-parameter-consumption';
  consumerMarker: typeof RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER;
  consumerVersion: typeof RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION;
  runtimeParameterInjection: boolean;
  consumed: boolean;
  strategyVariantId?: string;
  candidatePolicyId?: string;
  family?: string;
  parameters?: Record<string, StrategyKnobValue>;
  parametersSha256?: string;
  consumedStrategyVariantId?: string;
  consumedParametersSha256?: string;
  appliedStrategyIds: string[];
  tick?: number;
  reason?: string;
  liveEffect: false;
  officialMmoWrites: false;
  officialMmoWritesAllowed: false;
}

export interface RuntimePolicyParameterRegistryResult {
  registry: StrategyRegistryEntry[];
  evidence: RuntimePolicyParameterConsumptionEvidence;
}

export interface RuntimePolicyParameterConsumptionRecorder {
  recordStrategyRuntimeUse: (entry: StrategyRegistryEntry) => void;
  buildEvidence: () => RuntimePolicyParameterConsumptionEvidence;
}

export interface RuntimePolicyObjectiveActivationTarget {
  colony: string;
  targetRoom: string;
  hostileCreepCount: number;
  hostileStructureCount: number;
  activationScore: number;
}

interface RuntimePolicyParameterPayload {
  runtimeParameterInjection?: unknown;
  candidateParameterScope?: unknown;
  strategyVariantId?: unknown;
  candidatePolicyId?: unknown;
  sourceStrategyId?: unknown;
  family?: unknown;
  parameters?: unknown;
  parametersSha256?: unknown;
}

type RuntimeMemory = Partial<Memory> & {
  rlRuntimePolicyParameters?: RuntimePolicyParameterConsumptionEvidence & { tick: number };
};

const MULTI_TIER_EXPANSION_ACTIVATION_MIN_SCORE = 12;

export function applyRuntimePolicyParametersToRegistry(
  registry: StrategyRegistryEntry[]
): RuntimePolicyParameterRegistryResult {
  const clonedRegistry = registry.map(cloneStrategyRegistryEntry);
  const payload = readRuntimePolicyParameterPayload();
  if (!payload) {
    const evidence = buildConsumptionEvidence({ consumed: false, appliedStrategyIds: [] });
    publishRuntimePolicyParameterConsumptionEvidence(evidence);
    return { registry: clonedRegistry, evidence };
  }

  const parameters = normalizeRuntimePolicyParameters(payload.parameters);
  if (!parameters) {
    const evidence = buildConsumptionEvidence({
      payload,
      consumed: false,
      appliedStrategyIds: [],
      reason: 'runtime policy parameter payload did not include a non-empty parameters object'
    });
    publishRuntimePolicyParameterConsumptionEvidence(evidence);
    return { registry: clonedRegistry, evidence };
  }

  const appliedStrategyIds: string[] = [];
  const targetedStrategyIds = new Set(
    clonedRegistry.filter((entry) => runtimePolicyPayloadTargetsEntry(payload, entry)).map((entry) => entry.id)
  );
  const activatesSingleExplicitTarget =
    targetedStrategyIds.size === 1 && runtimePolicyPayloadExplicitIds(payload).length > 0;
  const activatedFamily = activatesSingleExplicitTarget
    ? clonedRegistry.find((entry) => targetedStrategyIds.has(entry.id))?.family
    : undefined;
  const patchedRegistry = clonedRegistry.map((entry) => {
    if (!targetedStrategyIds.has(entry.id)) {
      if (activatedFamily !== undefined && entry.family === activatedFamily && entry.rolloutStatus === 'incumbent') {
        return {
          ...entry,
          rolloutStatus: 'shadow' as const
        };
      }
      return entry;
    }

    appliedStrategyIds.push(entry.id);
    return {
      ...entry,
      ...(activatesSingleExplicitTarget ? { rolloutStatus: 'incumbent' as const } : {}),
      defaultValues: {
        ...entry.defaultValues,
        ...parameters
      }
    };
  });

  const matched = appliedStrategyIds.length > 0;
  const evidence = buildConsumptionEvidence({
    payload,
    consumed: false,
    parameters,
    appliedStrategyIds,
    reason: matched
      ? 'runtime policy parameter payload matched registry entries; awaiting tick runtime strategy evaluation'
      : 'runtime policy parameter payload did not match any strategy registry entry'
  });
  publishRuntimePolicyParameterConsumptionEvidence(evidence);
  return { registry: patchedRegistry, evidence };
}

export function createRuntimePolicyParameterConsumptionRecorder(): RuntimePolicyParameterConsumptionRecorder {
  const payload = readRuntimePolicyParameterPayload();
  const parameters = payload ? normalizeRuntimePolicyParameters(payload.parameters) : null;
  const appliedStrategyIds = new Set<string>();

  return {
    recordStrategyRuntimeUse(entry: StrategyRegistryEntry): void {
      if (!payload || !parameters) {
        return;
      }
      if (!runtimePolicyPayloadTargetsEntry(payload, entry)) {
        return;
      }
      if (!strategyEntryUsesRuntimeParameters(entry, parameters)) {
        return;
      }

      appliedStrategyIds.add(entry.id);
    },

    buildEvidence(): RuntimePolicyParameterConsumptionEvidence {
      if (!payload) {
        return buildConsumptionEvidence({ consumed: false, appliedStrategyIds: [] });
      }
      if (!parameters) {
        return buildConsumptionEvidence({
          payload,
          consumed: false,
          appliedStrategyIds: [],
          reason: 'runtime policy parameter payload did not include a non-empty parameters object'
        });
      }

      const observedStrategyIds = [...appliedStrategyIds].sort();
      const consumed = observedStrategyIds.length > 0;
      return buildConsumptionEvidence({
        payload,
        consumed,
        parameters,
        appliedStrategyIds: observedStrategyIds,
        reason: consumed
          ? 'runtime policy parameter payload was used by tick runtime strategy evaluation'
          : 'runtime policy parameter payload was not used by tick runtime strategy evaluation'
      });
    }
  };
}

export function persistRuntimePolicyParameterConsumptionEvidence(
  evidence: RuntimePolicyParameterConsumptionEvidence
): void {
  const memory = runtimeMemoryRoot();

  const persistedEvidence = stickyRuntimePolicyParameterConsumptionEvidence(
    evidence,
    memory.rlRuntimePolicyParameters
  );
  const tick = runtimeTick();
  const tickedEvidence = {
    ...persistedEvidence,
    tick
  };
  memory.rlRuntimePolicyParameters = tickedEvidence;
  publishRuntimePolicyParameterConsumptionEvidence(tickedEvidence);
  emitRuntimePolicyParameterConsumptionEvidence(tickedEvidence);
}

export function selectRuntimePolicyObjectiveActivationTarget(
  colonyRoomName: string
): RuntimePolicyObjectiveActivationTarget | null {
  const payload = readRuntimePolicyParameterPayload();
  if (!payload || !runtimePolicyPayloadTargetsConstructionPriority(payload)) {
    return null;
  }

  const parameters = normalizeRuntimePolicyParameters(payload.parameters);
  if (!parameters) {
    return null;
  }

  const activationScore = scoreRuntimePolicyObjectiveActivation(parameters);
  if (activationScore === null || activationScore < MULTI_TIER_EXPANSION_ACTIVATION_MIN_SCORE) {
    return null;
  }

  return selectVisibleAdjacentHostileObjectiveTarget(colonyRoomName, activationScore);
}

function readRuntimePolicyParameterPayload(): RuntimePolicyParameterPayload | null {
  const lexicalPayload = runtimePolicyParameterPayloadFromValue(readLexicalRuntimePolicyParameterPayload());
  if (lexicalPayload) {
    return lexicalPayload;
  }

  for (const root of runtimeGlobalRoots()) {
    const payload = runtimePolicyParameterPayloadFromValue(root[RUNTIME_POLICY_PARAMETERS_GLOBAL]);
    if (payload) {
      return payload;
    }
  }

  return null;
}

function readLexicalRuntimePolicyParameterPayload(): unknown {
  try {
    if (typeof __SCREEPS_RL_RUNTIME_POLICY_PARAMETERS__ !== 'undefined') {
      return __SCREEPS_RL_RUNTIME_POLICY_PARAMETERS__;
    }
  } catch (_error) {
    return undefined;
  }
  return undefined;
}

function runtimePolicyParameterPayloadFromValue(value: unknown): RuntimePolicyParameterPayload | null {
  if (
    isRecord(value) &&
    value.runtimeParameterInjection === true &&
    value.candidateParameterScope === 'runtime_injected'
  ) {
    return value;
  }
  return null;
}

function normalizeRuntimePolicyParameters(raw: unknown): Record<string, StrategyKnobValue> | null {
  if (!isRecord(raw)) {
    return null;
  }

  const parameters: Record<string, StrategyKnobValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        parameters[key] = value;
      }
    } else if (typeof value === 'string' || typeof value === 'boolean') {
      parameters[key] = value;
    }
  }

  return Object.keys(parameters).length > 0 ? parameters : null;
}

function runtimePolicyPayloadTargetsEntry(
  payload: RuntimePolicyParameterPayload,
  entry: StrategyRegistryEntry
): boolean {
  const explicitIds = runtimePolicyPayloadExplicitIds(payload);
  const family = textOrUndefined(payload.family);

  if (explicitIds.length > 0) {
    return explicitIds.includes(entry.id);
  }

  return family !== undefined && entry.family === family;
}

function runtimePolicyPayloadExplicitIds(payload: RuntimePolicyParameterPayload): string[] {
  return [
    textOrUndefined(payload.strategyVariantId),
    textOrUndefined(payload.candidatePolicyId),
    textOrUndefined(payload.sourceStrategyId)
  ].filter((id): id is string => id !== undefined);
}

function runtimePolicyPayloadTargetsConstructionPriority(payload: RuntimePolicyParameterPayload): boolean {
  const family = textOrUndefined(payload.family);
  if (family === 'construction-priority') {
    return true;
  }

  return runtimePolicyPayloadExplicitIds(payload).some((id) => id.startsWith('construction-priority.'));
}

function scoreRuntimePolicyObjectiveActivation(parameters: Record<string, StrategyKnobValue>): number | null {
  const territorySignalWeight = strategyNumber(parameters.territorySignalWeight);
  if (territorySignalWeight === null) {
    return null;
  }

  const baseScoreWeight = strategyNumber(parameters.baseScoreWeight) ?? 1;
  const killSignalWeight = strategyNumber(parameters.killSignalWeight) ?? 0;
  const riskPenalty = strategyNumber(parameters.riskPenalty) ?? 0;
  return territorySignalWeight * baseScoreWeight + Math.min(killSignalWeight, 8) * 0.25 - riskPenalty * 0.25;
}

function selectVisibleAdjacentHostileObjectiveTarget(
  colonyRoomName: string,
  activationScore: number
): RuntimePolicyObjectiveActivationTarget | null {
  if (!isNonEmptyString(colonyRoomName)) {
    return null;
  }

  const rooms = (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms;
  if (!rooms) {
    return null;
  }

  const candidates: RuntimePolicyObjectiveActivationTarget[] = [];
  for (const [roomName, room] of Object.entries(rooms)) {
    if (!room || roomName === colonyRoomName || !areRoomsAdjacent(colonyRoomName, roomName)) {
      continue;
    }

    const hostileCreepCount = countRoomFind(room, 'FIND_HOSTILE_CREEPS');
    const hostileStructureCount = countRoomFind(room, 'FIND_HOSTILE_STRUCTURES');
    if (hostileCreepCount + hostileStructureCount <= 0) {
      continue;
    }

    candidates.push({
      colony: colonyRoomName,
      targetRoom: roomName,
      hostileCreepCount,
      hostileStructureCount,
      activationScore
    });
  }

  return candidates.sort(compareRuntimePolicyObjectiveActivationTargets)[0] ?? null;
}

function compareRuntimePolicyObjectiveActivationTargets(
  left: RuntimePolicyObjectiveActivationTarget,
  right: RuntimePolicyObjectiveActivationTarget
): number {
  return (
    right.hostileCreepCount - left.hostileCreepCount ||
    right.hostileStructureCount - left.hostileStructureCount ||
    left.targetRoom.localeCompare(right.targetRoom)
  );
}

function countRoomFind(room: Room, globalName: 'FIND_HOSTILE_CREEPS' | 'FIND_HOSTILE_STRUCTURES'): number {
  const findConstant = (globalThis as Record<string, unknown>)[globalName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return 0;
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? result.length : 0;
  } catch (_error) {
    return 0;
  }
}

function areRoomsAdjacent(left: string, right: string): boolean {
  const gameMap = (globalThis as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map;
  if (gameMap && typeof gameMap.describeExits === 'function') {
    const exits = gameMap.describeExits(left);
    if (exits && Object.values(exits).includes(right)) {
      return true;
    }
  }

  const leftCoordinates = parseRoomCoordinates(left);
  const rightCoordinates = parseRoomCoordinates(right);
  if (!leftCoordinates || !rightCoordinates) {
    return false;
  }

  const dx = Math.abs(leftCoordinates.x - rightCoordinates.x);
  const dy = Math.abs(leftCoordinates.y - rightCoordinates.y);
  return dx <= 1 && dy <= 1 && dx + dy > 0;
}

function parseRoomCoordinates(roomName: string): { x: number; y: number } | null {
  const match = /^(E|W)(\d+)(N|S)(\d+)$/.exec(roomName);
  if (!match) {
    return null;
  }

  const horizontal = match[1] === 'E' ? Number(match[2]) : -Number(match[2]) - 1;
  const vertical = match[3] === 'S' ? Number(match[4]) : -Number(match[4]) - 1;
  return Number.isFinite(horizontal) && Number.isFinite(vertical)
    ? { x: horizontal, y: vertical }
    : null;
}

function strategyNumber(value: StrategyKnobValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strategyEntryUsesRuntimeParameters(
  entry: StrategyRegistryEntry,
  parameters: Record<string, StrategyKnobValue>
): boolean {
  for (const [key, value] of Object.entries(parameters)) {
    if (entry.defaultValues[key] !== value) {
      return false;
    }
  }

  return true;
}

function buildConsumptionEvidence(options: {
  payload?: RuntimePolicyParameterPayload;
  consumed: boolean;
  parameters?: Record<string, StrategyKnobValue>;
  appliedStrategyIds: string[];
  reason?: string;
}): RuntimePolicyParameterConsumptionEvidence {
  const runtimeParameterInjection =
    options.payload?.runtimeParameterInjection === true &&
    options.payload?.candidateParameterScope === 'runtime_injected';
  return {
    type: 'screeps-rl-runtime-policy-parameter-consumption',
    consumerMarker: RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER,
    consumerVersion: RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION,
    runtimeParameterInjection,
    consumed: options.consumed,
    ...(textOrUndefined(options.payload?.strategyVariantId)
      ? { strategyVariantId: textOrUndefined(options.payload?.strategyVariantId) }
      : {}),
    ...(textOrUndefined(options.payload?.candidatePolicyId)
      ? { candidatePolicyId: textOrUndefined(options.payload?.candidatePolicyId) }
      : {}),
    ...(textOrUndefined(options.payload?.family) ? { family: textOrUndefined(options.payload?.family) } : {}),
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(textOrUndefined(options.payload?.parametersSha256)
      ? { parametersSha256: textOrUndefined(options.payload?.parametersSha256) }
      : {}),
    ...(options.consumed && textOrUndefined(options.payload?.strategyVariantId)
      ? { consumedStrategyVariantId: textOrUndefined(options.payload?.strategyVariantId) }
      : {}),
    ...(options.consumed && textOrUndefined(options.payload?.parametersSha256)
      ? { consumedParametersSha256: textOrUndefined(options.payload?.parametersSha256) }
      : {}),
    appliedStrategyIds: [...options.appliedStrategyIds].sort(),
    ...(options.reason ? { reason: options.reason } : {}),
    liveEffect: false,
    officialMmoWrites: false,
    officialMmoWritesAllowed: false
  };
}

function publishRuntimePolicyParameterConsumptionEvidence(
  evidence: RuntimePolicyParameterConsumptionEvidence
): void {
  for (const root of runtimeGlobalRoots()) {
    root[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL] = evidence;
  }
}

function isRuntimePolicyParameterConsumptionEvidence(
  value: unknown
): value is RuntimePolicyParameterConsumptionEvidence {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.type === 'screeps-rl-runtime-policy-parameter-consumption' &&
    value.consumerMarker === RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER &&
    value.consumerVersion === RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION &&
    typeof value.runtimeParameterInjection === 'boolean' &&
    typeof value.consumed === 'boolean' &&
    Array.isArray(value.appliedStrategyIds)
  );
}

function emitRuntimePolicyParameterConsumptionEvidence(evidence: RuntimePolicyParameterConsumptionEvidence): void {
  if (evidence.runtimeParameterInjection !== true) {
    return;
  }

  try {
    console.log(`${RUNTIME_POLICY_PARAMETER_CONSUMPTION_LOG_PREFIX}${JSON.stringify(evidence)}`);
  } catch (_error) {
    // Runtime evidence is also persisted to Memory/global; logging must never affect the tick.
  }
}

function stickyRuntimePolicyParameterConsumptionEvidence(
  evidence: RuntimePolicyParameterConsumptionEvidence,
  previous: (RuntimePolicyParameterConsumptionEvidence & { tick: number }) | undefined
): RuntimePolicyParameterConsumptionEvidence {
  if (evidence.consumed || !shouldCarryRuntimePolicyParameterConsumptionEvidence(evidence, previous)) {
    return cloneRuntimePolicyParameterConsumptionEvidence(evidence);
  }

  return cloneRuntimePolicyParameterConsumptionEvidence(previous);
}

function shouldCarryRuntimePolicyParameterConsumptionEvidence(
  evidence: RuntimePolicyParameterConsumptionEvidence,
  previous: (RuntimePolicyParameterConsumptionEvidence & { tick: number }) | undefined
): previous is RuntimePolicyParameterConsumptionEvidence & { tick: number } {
  if (!previous || previous.consumed !== true) {
    return false;
  }
  if (evidence.runtimeParameterInjection !== true || previous.runtimeParameterInjection !== true) {
    return false;
  }
  if (!evidence.parameters || !previous.parameters) {
    return false;
  }
  if (
    evidence.consumerMarker !== RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER ||
    previous.consumerMarker !== RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER ||
    evidence.consumerVersion !== RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION ||
    previous.consumerVersion !== RUNTIME_POLICY_PARAMETERS_CONSUMER_VERSION
  ) {
    return false;
  }

  const currentHash = textOrUndefined(evidence.parametersSha256);
  const previousHash = textOrUndefined(previous.parametersSha256);
  if (!currentHash || currentHash !== previousHash) {
    return false;
  }

  return (
    sameOptionalText(evidence.strategyVariantId, previous.strategyVariantId) &&
    sameOptionalText(evidence.candidatePolicyId, previous.candidatePolicyId) &&
    sameOptionalText(evidence.family, previous.family)
  );
}

function cloneRuntimePolicyParameterConsumptionEvidence(
  evidence: RuntimePolicyParameterConsumptionEvidence
): RuntimePolicyParameterConsumptionEvidence {
  const cloned = { ...evidence } as RuntimePolicyParameterConsumptionEvidence & { tick?: number };
  delete cloned.tick;
  return {
    ...cloned,
    ...(evidence.parameters ? { parameters: { ...evidence.parameters } } : {}),
    appliedStrategyIds: [...evidence.appliedStrategyIds]
  };
}

function sameOptionalText(left: unknown, right: unknown): boolean {
  return textOrUndefined(left) === textOrUndefined(right);
}

function cloneStrategyRegistryEntry(entry: StrategyRegistryEntry): StrategyRegistryEntry {
  return {
    ...entry,
    defaultValues: { ...entry.defaultValues },
    evidenceLinks: entry.evidenceLinks.map((link) => ({ ...link })),
    rollback: {
      ...entry.rollback,
      stopConditions: [...entry.rollback.stopConditions]
    },
    supportedContext: {
      ...entry.supportedContext,
      artifactTypes: [...entry.supportedContext.artifactTypes],
      ...(entry.supportedContext.shards ? { shards: [...entry.supportedContext.shards] } : {}),
      ...(entry.supportedContext.rooms ? { rooms: [...entry.supportedContext.rooms] } : {})
    },
    knobBounds: entry.knobBounds.map((knob) => ({ ...knob, bounds: { ...knob.bounds } }))
  };
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function runtimeMemoryRoot(): RuntimeMemory {
  if (typeof Memory !== 'undefined') {
    return Memory as RuntimeMemory;
  }

  const root = globalThis as typeof globalThis & { Memory?: RuntimeMemory };
  if (!root.Memory) {
    root.Memory = {};
  }
  return root.Memory;
}

function runtimeGlobalRoots(): Array<Record<string, unknown>> {
  const roots: Array<Record<string, unknown>> = [];
  const root = globalThis as typeof globalThis & { global?: unknown; self?: unknown };
  addRuntimeGlobalRoot(roots, globalThis);
  addRuntimeGlobalRoot(roots, root.global);
  addRuntimeGlobalRoot(roots, root.self);

  return roots;
}

function addRuntimeGlobalRoot(roots: Array<Record<string, unknown>>, value: unknown): void {
  if (!isRecord(value) || roots.includes(value)) {
    return;
  }

  roots.push(value);
}

function runtimeTick(): number {
  if (typeof Game !== 'undefined' && typeof Game.time === 'number') {
    return Game.time;
  }
  return (globalThis as { Game?: Partial<Game> }).Game?.time ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
