import type { StrategyKnobValue, StrategyRegistryEntry } from './strategyRegistry';

export const RUNTIME_POLICY_PARAMETERS_GLOBAL = '__SCREEPS_RL_RUNTIME_POLICY_PARAMETERS__';
export const RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL = '__SCREEPS_RL_RUNTIME_POLICY_PARAMETER_CONSUMPTION__';
export const RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER = 'screeps-rl-runtime-policy-parameters-consumer-v1';

export interface RuntimePolicyParameterConsumptionEvidence {
  type: 'screeps-rl-runtime-policy-parameter-consumption';
  consumerMarker: typeof RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER;
  runtimeParameterInjection: boolean;
  consumed: boolean;
  strategyVariantId?: string;
  candidatePolicyId?: string;
  family?: string;
  parameters?: Record<string, StrategyKnobValue>;
  parametersSha256?: string;
  appliedStrategyIds: string[];
  reason?: string;
  liveEffect: false;
  officialMmoWrites: false;
  officialMmoWritesAllowed: false;
}

export interface RuntimePolicyParameterRegistryResult {
  registry: StrategyRegistryEntry[];
  evidence: RuntimePolicyParameterConsumptionEvidence;
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
  const patchedRegistry = clonedRegistry.map((entry) => {
    if (!runtimePolicyPayloadTargetsEntry(payload, entry)) {
      return entry;
    }

    appliedStrategyIds.push(entry.id);
    return {
      ...entry,
      defaultValues: {
        ...entry.defaultValues,
        ...parameters
      }
    };
  });

  const consumed = appliedStrategyIds.length > 0;
  const evidence = buildConsumptionEvidence({
    payload,
    consumed,
    parameters,
    appliedStrategyIds,
    reason: consumed ? undefined : 'runtime policy parameter payload did not match any strategy registry entry'
  });
  publishRuntimePolicyParameterConsumptionEvidence(evidence);
  return { registry: patchedRegistry, evidence };
}

export function persistRuntimePolicyParameterConsumptionEvidence(
  evidence: RuntimePolicyParameterConsumptionEvidence
): void {
  if (!evidence.consumed) {
    return;
  }

  const root = globalThis as typeof globalThis & { Memory?: RuntimeMemory };
  if (!root.Memory) {
    root.Memory = {};
  }

  root.Memory.rlRuntimePolicyParameters = {
    ...evidence,
    tick: runtimeTick()
  };
}

function readRuntimePolicyParameterPayload(): RuntimePolicyParameterPayload | null {
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  const raw = root[RUNTIME_POLICY_PARAMETERS_GLOBAL];
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.runtimeParameterInjection !== true || raw.candidateParameterScope !== 'runtime_injected') {
    return null;
  }
  return raw;
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
  const strategyVariantId = textOrUndefined(payload.strategyVariantId);
  const candidatePolicyId = textOrUndefined(payload.candidatePolicyId);
  const sourceStrategyId = textOrUndefined(payload.sourceStrategyId);
  const family = textOrUndefined(payload.family);

  return (
    entry.id === strategyVariantId ||
    entry.id === candidatePolicyId ||
    entry.id === sourceStrategyId ||
    (family !== undefined && entry.family === family)
  );
}

function buildConsumptionEvidence(options: {
  payload?: RuntimePolicyParameterPayload;
  consumed: boolean;
  parameters?: Record<string, StrategyKnobValue>;
  appliedStrategyIds: string[];
  reason?: string;
}): RuntimePolicyParameterConsumptionEvidence {
  return {
    type: 'screeps-rl-runtime-policy-parameter-consumption',
    consumerMarker: RUNTIME_POLICY_PARAMETERS_CONSUMER_MARKER,
    runtimeParameterInjection: options.consumed,
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
  const root = globalThis as typeof globalThis & Record<string, unknown>;
  root[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL] = evidence;
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

function runtimeTick(): number {
  return (globalThis as { Game?: Partial<Game> }).Game?.time ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
