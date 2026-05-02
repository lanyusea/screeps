import type { StrategyRegistryEntry } from '../strategy/strategyRegistry';

export interface RollbackResult {
  executed: boolean;
  disabledId: string;
  rollbackToId: string;
  reason: string;
}

interface InternalPendingRollbackState {
  lastSeenTick: number;
  shouldRollback: boolean;
  disabledId: string;
  rollbackToId: string;
}

interface StrategyRollbackRecord {
  disabledId: string;
  rollbackToId: string;
  timestamp: number;
  reason: string;
}

const ROLLBACK_HISTORY_LIMIT = 20;
const pendingRollbacksByFamily = new Map<string, InternalPendingRollbackState>();

export function executeRollback(
  family: string,
  registry: StrategyRegistryEntry[],
  reason: string
): RollbackResult {
  const now = getGameTime();
  const candidate = findCandidateStrategyByFamily(registry, family);
  if (!candidate) {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: '',
      rollbackToId: '',
      reason
    };
  }

  const rollbackToId = candidate.rollback.rollbackToStrategyId;
  const rollbackTarget = rollbackToId ? getStrategyById(registry, rollbackToId) : undefined;
  if (
    !rollbackToId ||
    !rollbackTarget ||
    candidate.rolloutStatus !== 'shadow' ||
    rollbackTarget.rolloutStatus === 'shadow'
  ) {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: '',
      rollbackToId: rollbackToId ?? '',
      reason
    };
  }

  if (candidate.family !== rollbackTarget.family || candidate.family !== family) {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: '',
      rollbackToId,
      reason
    };
  }

  if (candidate.id === rollbackToId) {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: candidate.id,
      rollbackToId,
      reason
    };
  }

  const previousState = pendingRollbacksByFamily.get(family);
  const shouldRollback =
    previousState !== undefined &&
    previousState.lastSeenTick === now - 1 &&
    previousState.disabledId === candidate.id &&
    previousState.rollbackToId === rollbackToId;

  const currentState: InternalPendingRollbackState = {
    lastSeenTick: now,
    shouldRollback,
    disabledId: candidate.id,
    rollbackToId
  };
  pendingRollbacksByFamily.set(family, currentState);

  const memoryState: StrategyRollbackRecord = {
    disabledId: candidate.id,
    rollbackToId,
    timestamp: now,
    reason
  };
  const memory = getOrCreateMemory();
  const pendingRollbacks = getOrCreateMemoryRollbackMap(memory);
  pendingRollbacks[family] = memoryState;

  return {
    executed: shouldRollback,
    disabledId: candidate.id,
    rollbackToId,
    reason
  };
}

export function applyPendingRollbacks(registry: StrategyRegistryEntry[]): StrategyRegistryEntry[] {
  const now = getGameTime();
  const pendingRollbacks = getOrCreateMemoryRollbackMap(getOrCreateMemory());
  const entriesById = indexRegistryById(registry);
  let updated = false;
  let updatedRegistry: StrategyRegistryEntry[] | null = null;

  for (const [family, memoryState] of Object.entries(pendingRollbacks)) {
    const state = pendingRollbacksByFamily.get(family);
    if (!state) {
      if (memoryState.timestamp < now - 1) {
        delete pendingRollbacks[family];
      }
      continue;
    }

    if (state.lastSeenTick < now - 1) {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }

    if (!state.shouldRollback) {
      continue;
    }

    if (state.disabledId !== memoryState.disabledId || state.rollbackToId !== memoryState.rollbackToId) {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }

    const disabledStrategy = entriesById[state.disabledId];
    const rollbackStrategy = entriesById[state.rollbackToId];
    if (
      !disabledStrategy ||
      !rollbackStrategy ||
      disabledStrategy.family !== rollbackStrategy.family ||
      rollbackStrategy.rolloutStatus === 'shadow'
    ) {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }

    updatedRegistry = updatedRegistry ?? cloneRegistry(registry);
    const updatedEntry = indexRegistryById(updatedRegistry);
    const disabledUpdated = updatedEntry[state.disabledId];
    const rollbackUpdated = updatedEntry[state.rollbackToId];
    if (!disabledUpdated || !rollbackUpdated) {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }

    disabledUpdated.rolloutStatus = 'disabled';
    rollbackUpdated.rolloutStatus = 'incumbent';

    appendRollbackHistory({
      family,
      disabledId: state.disabledId,
      rollbackToId: state.rollbackToId,
      timestamp: now,
      reason: memoryState.reason
    });

    delete pendingRollbacks[family];
    pendingRollbacksByFamily.delete(family);
    updated = true;
  }

  return updated ? updatedRegistry ?? registry : registry;
}

function appendRollbackHistory(historyEntry: {
  family: string;
  disabledId: string;
  rollbackToId: string;
  timestamp: number;
  reason: string;
}): void {
  const memory = getOrCreateMemory();
  const history = memory.strategyRollbackHistory ?? [];
  memory.strategyRollbackHistory = history;
  history.push(historyEntry);
  if (history.length > ROLLBACK_HISTORY_LIMIT) {
    history.splice(0, history.length - ROLLBACK_HISTORY_LIMIT);
  }
}

function clearPendingRollbackState(family: string): void {
  pendingRollbacksByFamily.delete(family);
  const memory = getOrCreateMemory();
  if (!memory.strategyRollback) {
    return;
  }

  delete memory.strategyRollback[family];
}

function cloneRegistry(registry: StrategyRegistryEntry[]): StrategyRegistryEntry[] {
  return registry.map((entry) => ({ ...entry }));
}

function getOrCreateMemory(): Partial<Memory> {
  if (!(globalThis as { Memory?: Partial<Memory> }).Memory) {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  }

  return (globalThis as unknown as { Memory: Partial<Memory> }).Memory;
}

function getOrCreateMemoryRollbackMap(memory: Partial<Memory>): Record<string, StrategyRollbackRecord> {
  if (!memory.strategyRollback) {
    memory.strategyRollback = {};
  }

  return memory.strategyRollback;
}

function indexRegistryById(registry: StrategyRegistryEntry[]): Record<string, StrategyRegistryEntry> {
  const result: Record<string, StrategyRegistryEntry> = {};
  for (const entry of registry) {
    result[entry.id] = entry;
  }

  return result;
}

function findCandidateStrategyByFamily(
  registry: StrategyRegistryEntry[],
  family: string
): StrategyRegistryEntry | undefined {
  return registry.find((entry) => entry.family === family && entry.rolloutStatus === 'shadow');
}

function getStrategyById(registry: StrategyRegistryEntry[], strategyId: string): StrategyRegistryEntry | undefined {
  return registry.find((entry) => entry.id === strategyId);
}

function getGameTime(): number {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  return game?.time ?? 0;
}
