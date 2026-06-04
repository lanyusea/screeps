export type RuntimeCpuPressure = 'normal' | 'degraded' | 'critical';
export type RuntimeCpuPressureReason =
  | 'lowCpuLimit'
  | 'lowBucketRecovery'
  | 'lowBucket'
  | 'criticalBucket'
  | 'usedOverLimit';
export type RuntimeCpuAlert =
  | 'bucketEmptyRepeated'
  | 'lowBucket'
  | 'sustainedUsedOverLimit';

export interface RuntimeCpuSample {
  tick: number;
  used?: number;
  limit?: number;
  tickLimit?: number;
  bucket?: number;
}

export interface RuntimeCpuBudget {
  tick: number;
  sample: RuntimeCpuSample;
  pressure: RuntimeCpuPressure;
  degraded: boolean;
  critical: boolean;
  lowCpuLimit: boolean;
  reasons: RuntimeCpuPressureReason[];
}

export interface RuntimeCpuTelemetrySummary extends RuntimeCpuSample {
  pressure: RuntimeCpuPressure;
  alerts?: RuntimeCpuAlert[];
  reasons?: RuntimeCpuPressureReason[];
  lowBucketTicks?: number;
  bucketEmptyTicks?: number;
  overLimitTicks?: number;
}

interface RuntimeGameLike {
  time?: unknown;
  cpu?: {
    getUsed?: unknown;
    limit?: unknown;
    bucket?: unknown;
    tickLimit?: unknown;
  };
}

interface RuntimeCpuTelemetryState {
  lastTick?: number;
  lowBucketTicks: number;
  bucketEmptyTicks: number;
  overLimitTicks: number;
}

export const LOW_CPU_ACCOUNT_LIMIT = 20;
export const LOW_CPU_BUCKET_THRESHOLD = 1_000;
export const CRITICAL_CPU_BUCKET_THRESHOLD = 100;
export const DEGRADED_OPTIONAL_WORK_INTERVAL = 5;
export const DEGRADED_ROOM_OPTIONAL_WORK_INTERVAL = 3;
const CPU_BUCKET_RECOVERY_HEADROOM_MULTIPLIER = 10;
const REPEATED_BUCKET_EMPTY_TICKS = 2;
const SUSTAINED_OVER_LIMIT_TICKS = 2;

let cpuTelemetryState: RuntimeCpuTelemetryState = {
  lowBucketTicks: 0,
  bucketEmptyTicks: 0,
  overLimitTicks: 0
};

export function getRuntimeCpuBudget(game?: RuntimeGameLike): RuntimeCpuBudget {
  const runtimeGame = game ?? getRuntimeGame();
  return buildRuntimeCpuBudget(readRuntimeCpuSample(runtimeGame));
}

export function isRuntimeCpuBucketCritical(game?: RuntimeGameLike): boolean {
  const runtimeGame = game ?? getRuntimeGame();
  const bucket = runtimeGame?.cpu?.bucket;
  return typeof bucket === 'number' && Number.isFinite(bucket) && bucket <= CRITICAL_CPU_BUCKET_THRESHOLD;
}

export function isRuntimeCpuBucketLow(game?: RuntimeGameLike): boolean {
  const runtimeGame = game ?? getRuntimeGame();
  const bucket = runtimeGame?.cpu?.bucket;
  return typeof bucket === 'number' && Number.isFinite(bucket) && bucket < LOW_CPU_BUCKET_THRESHOLD;
}

export function buildRuntimeCpuBudget(sample: RuntimeCpuSample): RuntimeCpuBudget {
  const reasons: RuntimeCpuPressureReason[] = [];
  const lowCpuLimit = sample.limit !== undefined && sample.limit <= LOW_CPU_ACCOUNT_LIMIT;
  if (lowCpuLimit) {
    reasons.push('lowCpuLimit');
  }

  const criticalBucket = sample.bucket !== undefined && sample.bucket <= CRITICAL_CPU_BUCKET_THRESHOLD;
  if (criticalBucket) {
    reasons.push('criticalBucket');
  } else if (sample.bucket !== undefined && sample.bucket < LOW_CPU_BUCKET_THRESHOLD) {
    reasons.push('lowBucket');
  } else if (hasLowBucketRecoveryPressure(sample)) {
    reasons.push('lowBucketRecovery');
  }

  if (
    sample.used !== undefined &&
    sample.limit !== undefined &&
    sample.limit > 0 &&
    sample.used > sample.limit
  ) {
    reasons.push('usedOverLimit');
  }

  const critical = criticalBucket;
  const degraded = critical || reasons.length > 0;

  return {
    tick: sample.tick,
    sample,
    pressure: critical ? 'critical' : degraded ? 'degraded' : 'normal',
    degraded,
    critical,
    lowCpuLimit,
    reasons
  };
}

export function readRuntimeCpuSample(game: RuntimeGameLike | undefined = getRuntimeGame()): RuntimeCpuSample {
  const cpu = game?.cpu;
  return {
    tick: normalizeTick(game?.time),
    ...optionalFiniteNumber('used', readCpuUsed(cpu)),
    ...optionalFiniteNumber('limit', cpu?.limit),
    ...optionalFiniteNumber('bucket', cpu?.bucket),
    ...optionalFiniteNumber('tickLimit', cpu?.tickLimit)
  };
}

export function buildRuntimeCpuTelemetrySummary(
  sample: RuntimeCpuSample = readRuntimeCpuSample()
): RuntimeCpuTelemetrySummary | null {
  if (
    sample.used === undefined &&
    sample.limit === undefined &&
    sample.bucket === undefined &&
    sample.tickLimit === undefined
  ) {
    resetRuntimeCpuTelemetryStateForTick(sample.tick);
    clearRuntimeCpuTelemetryCounters();
    return null;
  }

  const budget = buildRuntimeCpuBudget(sample);
  const state = updateRuntimeCpuTelemetryState(sample);
  const alerts = buildRuntimeCpuAlerts(sample, state);

  return {
    tick: sample.tick,
    ...(sample.used !== undefined ? { used: sample.used } : {}),
    ...(sample.limit !== undefined ? { limit: sample.limit } : {}),
    ...(sample.tickLimit !== undefined ? { tickLimit: sample.tickLimit } : {}),
    ...(sample.bucket !== undefined ? { bucket: sample.bucket } : {}),
    pressure: budget.pressure,
    ...(budget.reasons.length > 0 ? { reasons: budget.reasons } : {}),
    ...(alerts.length > 0 ? { alerts } : {}),
    ...(state.lowBucketTicks > 0 ? { lowBucketTicks: state.lowBucketTicks } : {}),
    ...(state.bucketEmptyTicks > 0 ? { bucketEmptyTicks: state.bucketEmptyTicks } : {}),
    ...(state.overLimitTicks > 0 ? { overLimitTicks: state.overLimitTicks } : {})
  };
}

export function shouldRunOptionalCpuWork(
  budget: RuntimeCpuBudget,
  key: string,
  interval = DEGRADED_OPTIONAL_WORK_INTERVAL
): boolean {
  if (!budget.degraded) {
    return true;
  }

  if (budget.critical || hasLowBucketPressure(budget) || hasUsedOverLimitPressure(budget)) {
    return false;
  }

  return isCadenceTick(budget.tick, key, interval);
}

export function shouldRunOptionalCpuRoomWork(
  budget: RuntimeCpuBudget,
  roomName: string,
  interval = DEGRADED_ROOM_OPTIONAL_WORK_INTERVAL
): boolean {
  if (!budget.degraded) {
    return true;
  }

  if (budget.critical || hasLowBucketPressure(budget) || hasUsedOverLimitPressure(budget)) {
    return false;
  }

  return isCadenceTick(budget.tick, roomName, interval);
}

export function shouldThrottleRuntimeSummaryCadence(budget: RuntimeCpuBudget): boolean {
  return budget.degraded;
}

export function shouldShedNonessentialCpuWork(budget: RuntimeCpuBudget): boolean {
  return budget.critical || hasLowBucketPressure(budget) || hasUsedOverLimitPressure(budget);
}

export function resetRuntimeCpuTelemetryForTesting(): void {
  cpuTelemetryState = {
    lowBucketTicks: 0,
    bucketEmptyTicks: 0,
    overLimitTicks: 0
  };
}

export function hasLowBucketPressure(budget: RuntimeCpuBudget): boolean {
  return (
    budget.reasons.includes('lowBucketRecovery') ||
    budget.reasons.includes('lowBucket') ||
    budget.reasons.includes('criticalBucket')
  );
}

function hasUsedOverLimitPressure(budget: RuntimeCpuBudget): boolean {
  return budget.reasons.includes('usedOverLimit');
}

function hasLowBucketRecoveryPressure(sample: RuntimeCpuSample): boolean {
  if (sample.bucket === undefined || sample.bucket < LOW_CPU_BUCKET_THRESHOLD) {
    return false;
  }

  return sample.bucket <= LOW_CPU_BUCKET_THRESHOLD + getCpuBucketRecoveryHeadroom(sample.limit);
}

function getCpuBucketRecoveryHeadroom(limit: number | undefined): number {
  if (limit !== undefined && limit > 0) {
    return Math.ceil(limit * CPU_BUCKET_RECOVERY_HEADROOM_MULTIPLIER);
  }

  return LOW_CPU_ACCOUNT_LIMIT;
}

function updateRuntimeCpuTelemetryState(sample: RuntimeCpuSample): RuntimeCpuTelemetryState {
  resetRuntimeCpuTelemetryStateForTick(sample.tick);

  const lowBucket = sample.bucket !== undefined && sample.bucket < LOW_CPU_BUCKET_THRESHOLD;
  const bucketEmpty = sample.bucket !== undefined && sample.bucket <= 0;
  const overLimit =
    sample.used !== undefined &&
    sample.limit !== undefined &&
    sample.limit > 0 &&
    sample.used > sample.limit;

  cpuTelemetryState.lowBucketTicks = lowBucket ? cpuTelemetryState.lowBucketTicks + 1 : 0;
  cpuTelemetryState.bucketEmptyTicks = bucketEmpty ? cpuTelemetryState.bucketEmptyTicks + 1 : 0;
  cpuTelemetryState.overLimitTicks = overLimit ? cpuTelemetryState.overLimitTicks + 1 : 0;
  return cpuTelemetryState;
}

function resetRuntimeCpuTelemetryStateForTick(tick: number): void {
  const lastTick = cpuTelemetryState.lastTick;
  if (lastTick !== undefined && tick > 0 && lastTick > 0 && tick !== lastTick + 1) {
    clearRuntimeCpuTelemetryCounters();
  }

  if (lastTick !== undefined && tick > 0 && lastTick > tick) {
    clearRuntimeCpuTelemetryCounters();
  }

  cpuTelemetryState.lastTick = tick;
}

function clearRuntimeCpuTelemetryCounters(): void {
  cpuTelemetryState.lowBucketTicks = 0;
  cpuTelemetryState.bucketEmptyTicks = 0;
  cpuTelemetryState.overLimitTicks = 0;
}

function buildRuntimeCpuAlerts(
  sample: RuntimeCpuSample,
  state: RuntimeCpuTelemetryState
): RuntimeCpuAlert[] {
  const alerts: RuntimeCpuAlert[] = [];
  if (state.bucketEmptyTicks >= REPEATED_BUCKET_EMPTY_TICKS) {
    alerts.push('bucketEmptyRepeated');
  }

  if (sample.bucket !== undefined && sample.bucket < LOW_CPU_BUCKET_THRESHOLD) {
    alerts.push('lowBucket');
  }

  if (state.overLimitTicks >= SUSTAINED_OVER_LIMIT_TICKS) {
    alerts.push('sustainedUsedOverLimit');
  }

  return alerts;
}

function isCadenceTick(tick: number, key: string, interval: number): boolean {
  const normalizedInterval = Math.max(1, Math.floor(interval));
  if (tick <= 0) {
    return false;
  }

  return (tick + stableHash(key)) % normalizedInterval === 0;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function readCpuUsed(cpu: RuntimeGameLike['cpu']): number | undefined {
  const getUsed = cpu?.getUsed;
  if (typeof getUsed !== 'function') {
    return undefined;
  }

  try {
    const used = getUsed.call(cpu);
    return typeof used === 'number' && Number.isFinite(used) ? used : undefined;
  } catch {
    return undefined;
  }
}

function optionalFiniteNumber<K extends keyof RuntimeCpuSample>(
  key: K,
  value: unknown
): Pick<RuntimeCpuSample, K> | Record<string, never> {
  return typeof value === 'number' && Number.isFinite(value)
    ? ({ [key]: value } as Pick<RuntimeCpuSample, K>)
    : {};
}

function normalizeTick(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getRuntimeGame(): RuntimeGameLike | undefined {
  return (globalThis as { Game?: RuntimeGameLike }).Game;
}
