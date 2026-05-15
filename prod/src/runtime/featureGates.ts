export type RuntimeWorldKind = 'persistent' | 'seasonal';

export interface RuntimeCpuMetadata {
  bucket?: number;
  limit?: number;
  tickLimit?: number;
}

export interface RuntimeFeatureGates {
  cpu: RuntimeCpuMetadata;
  isSeasonal: boolean;
  labManagement: boolean;
  marketTrading: boolean;
  shardName?: string;
  shardType?: string;
  terminalEnergyTransfers: boolean;
  world: RuntimeWorldKind;
}

interface RuntimeGameLike {
  cpu?: {
    bucket?: unknown;
    limit?: unknown;
    tickLimit?: unknown;
  };
  shard?: {
    name?: unknown;
    type?: unknown;
  };
}

export function getRuntimeFeatureGates(game: RuntimeGameLike | undefined = getRuntimeGame()): RuntimeFeatureGates {
  const shardName = normalizeString(game?.shard?.name);
  const shardType = normalizeString(game?.shard?.type);
  const isSeasonal = shardName === 'shardSeason' || /season/i.test(shardType ?? '');
  const enabledInPersistent = !isSeasonal;

  return {
    cpu: buildCpuMetadata(game?.cpu),
    isSeasonal,
    ...(shardName ? { shardName } : {}),
    ...(shardType ? { shardType } : {}),
    world: isSeasonal ? 'seasonal' : 'persistent',
    marketTrading: enabledInPersistent,
    terminalEnergyTransfers: enabledInPersistent,
    labManagement: enabledInPersistent
  };
}

function getRuntimeGame(): RuntimeGameLike | undefined {
  return (globalThis as { Game?: RuntimeGameLike }).Game;
}

function buildCpuMetadata(cpu: RuntimeGameLike['cpu']): RuntimeCpuMetadata {
  return {
    ...optionalFiniteNumber('limit', cpu?.limit),
    ...optionalFiniteNumber('bucket', cpu?.bucket),
    ...optionalFiniteNumber('tickLimit', cpu?.tickLimit)
  };
}

function optionalFiniteNumber<K extends keyof RuntimeCpuMetadata>(
  key: K,
  value: unknown
): Pick<RuntimeCpuMetadata, K> | Record<string, never> {
  return typeof value === 'number' && Number.isFinite(value)
    ? { [key]: value } as Pick<RuntimeCpuMetadata, K>
    : {};
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
