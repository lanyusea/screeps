import { parseStrategyEvaluationArtifacts, reduceStrategyKpis } from './strategy/kpiEvaluator';
import {
  DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG,
  averageKpiWindowMetrics,
  checkKpiRegression,
  type KpiWindow,
  type KpiWindowHistory
} from './rl/kpiRolloutMonitor';
import { applyPendingRollbacks, executeRollback } from './rl/strategyRollback';
import { Kernel } from './kernel/Kernel';
import {
  DEFAULT_STRATEGY_REGISTRY,
  type StrategyRegistryEntry
} from './strategy/strategyRegistry';
import { type RuntimeSummary, RUNTIME_SUMMARY_PREFIX } from './telemetry/runtimeSummary';
export {
  DEFAULT_STRATEGY_REGISTRY,
  STRATEGY_REGISTRY_SCHEMA_VERSION,
  validateStrategyRegistry,
  validateStrategyRegistryEntry
} from './strategy/strategyRegistry';
export { DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG, evaluateStrategyShadowReplay } from './strategy/shadowEvaluator';
export {
  HistoricalReplayValidator,
  loadHistoricalReplays,
  type HistoricalReplay,
  type ValidationResult
} from './strategy/historicalReplayValidator';
export { RlRolloutGate, validateRlStrategyRollout } from './strategy/rlRolloutGate';
export { DEFAULT_VARIANCE_CONFIG, VarianceConfig, injectStrategyVariance } from './strategy/shadowEvaluator';

const kernel = new Kernel();
const strategyRolloutConfig = DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG;
const kpiWindowMaxLength = 120;
const strategyRegistryState = {
  entries: DEFAULT_STRATEGY_REGISTRY.map((entry) => ({ ...entry }))
};
const recentKpiWindows: KpiWindowHistory = {};
const baselineKpiWindows: KpiWindowHistory = {};

export function loop(): void {
  const summary = kernel.run();
  strategyRegistryState.entries = runStrategyRolloutMonitoring(summary, strategyRegistryState.entries);
}

function runStrategyRolloutMonitoring(
  summary: RuntimeSummary | undefined,
  registry: StrategyRegistryEntry[]
): StrategyRegistryEntry[] {
  let workingRegistry = applyPendingRollbacks(registry);
  if (!summary) {
    return workingRegistry;
  }

  const families = getMonitoredFamilies(workingRegistry);
  const kpiWindow = buildKpiWindow(summary);
  for (const family of families) {
    appendWindow(recentKpiWindows, family, kpiWindow);
    ensureBaselineWindowForFamily(family);
  }

  const regressionResult = checkKpiRegression(recentKpiWindows, baselineKpiWindows, strategyRolloutConfig);
  if (regressionResult.regression) {
    for (const family of regressionResult.regressedFamilies) {
      const rollbackResult = executeRollback(family, workingRegistry, regressionResult.details);
      if (rollbackResult.disabledId && rollbackResult.rollbackToId) {
        console.log(
          `${RUNTIME_SUMMARY_PREFIX}${JSON.stringify({
            type: 'rl-rollback',
            family,
            disabledId: rollbackResult.disabledId,
            rollbackToId: rollbackResult.rollbackToId,
            reason: rollbackResult.reason,
            timestamp: runtimeTick()
          })}`
        );
      }
    }
  }

  workingRegistry = applyPendingRollbacks(workingRegistry);
  return workingRegistry;
}

function getMonitoredFamilies(registry: StrategyRegistryEntry[]): string[] {
  return [...new Set(registry.map((entry) => entry.family))];
}

function buildKpiWindow(summary: RuntimeSummary): KpiWindow {
  const artifacts = parseStrategyEvaluationArtifacts(summary);
  const kpi = reduceStrategyKpis(artifacts);
  return {
    timestamp: summary.tick,
    metrics: {
      reliability: kpi.reliability.passed ? 1 : 0,
      territory: kpi.territory.score,
      resources: kpi.resources.score,
      kills: kpi.kills.score
    }
  };
}

function ensureBaselineWindowForFamily(family: string): void {
  const minWindowSize = Math.max(1, Math.floor(strategyRolloutConfig.minWindowSize));
  const memory = getOrCreateMemory();
  let baselines = baselineKpiWindows[family];

  if (!baselines || baselines.length === 0) {
    const memoryBaseline = memory.kpiBaseline?.[family];
    if (memoryBaseline) {
      const seededWindow = buildKpiWindowFromBaseline(memoryBaseline);
      baselines = Array.from({ length: minWindowSize }, () => seededWindow);
      baselineKpiWindows[family] = baselines;
    }
  }

  const recentWindows = recentKpiWindows[family] ?? [];
  if (!baselines || baselines.length < minWindowSize) {
    if (recentWindows.length >= minWindowSize) {
      baselines = recentWindows.slice(-minWindowSize);
      baselineKpiWindows[family] = baselines;
      persistBaseline(family, baselines);
    }
  }

  baselines = baselineKpiWindows[family];
  if (!baselines) {
    return;
  }

  baselineKpiWindows[family] = trimWindowLength(baselines, minWindowSize);
}

function buildKpiWindowFromBaseline(memoryBaseline: { timestamp: number; metrics: Record<string, number> }): KpiWindow {
  const metrics = {
    reliability: Number(memoryBaseline.metrics.reliability ?? 0),
    territory: Number(memoryBaseline.metrics.territory ?? 0),
    resources: Number(memoryBaseline.metrics.resources ?? 0),
    kills: Number(memoryBaseline.metrics.kills ?? 0)
  };
  return {
    timestamp: memoryBaseline.timestamp,
    metrics: {
      reliability: Number.isFinite(metrics.reliability) ? metrics.reliability : 0,
      territory: Number.isFinite(metrics.territory) ? metrics.territory : 0,
      resources: Number.isFinite(metrics.resources) ? metrics.resources : 0,
      kills: Number.isFinite(metrics.kills) ? metrics.kills : 0
    }
  };
}

function persistBaseline(family: string, windows: KpiWindow[]): void {
  const memory = getOrCreateMemory();
  const averages = averageKpiWindowMetrics(windows);
  if (!averages) {
    return;
  }

  memory.kpiBaseline = {
    ...(memory.kpiBaseline ?? {}),
    [family]: {
      timestamp: windows[windows.length - 1]?.timestamp ?? runtimeTick(),
      metrics: averages
    }
  };
}

function trimWindowLength(windows: KpiWindow[], maxLength: number): KpiWindow[] {
  const trimmed = [...windows];
  while (trimmed.length > maxLength) {
    trimmed.shift();
  }
  return trimmed;
}

function appendWindow(windows: KpiWindowHistory, family: string, window: KpiWindow): void {
  const familyWindows = windows[family] ?? [];
  familyWindows.push(window);
  windows[family] = trimWindowLength(familyWindows, kpiWindowMaxLength);
}

function getOrCreateMemory(): Partial<Memory> {
  if (!(globalThis as { Memory?: Partial<Memory> }).Memory) {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  }

  return (globalThis as unknown as { Memory: Partial<Memory> }).Memory;
}

function runtimeTick(): number {
  return (globalThis as { Game?: Partial<Game> }).Game?.time ?? 0;
}
