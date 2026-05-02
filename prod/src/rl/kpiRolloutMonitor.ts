export interface KpiWindow {
  timestamp: number;
  metrics: {
    reliability: number;
    territory: number;
    resources: number;
    kills: number;
  };
}

export interface KpiWindowHistory {
  [family: string]: KpiWindow[];
}

export interface KpiRolloutMonitorConfig {
  reliabilityDropThreshold: number;
  territoryDropThreshold: number;
  minWindowSize: number;
}

export interface KpiRegressionResult {
  regression: boolean;
  regressedFamilies: string[];
  details: string;
  metrics: Record<string, { current: number; baseline: number; delta: number }>;
}

export interface KpiRegressionEntry {
  family: string;
  metric: keyof KpiWindow['metrics'];
  current: number;
  baseline: number;
  dropRatio: number;
  threshold: number;
}

export const DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG: KpiRolloutMonitorConfig = {
  reliabilityDropThreshold: 0.1,
  territoryDropThreshold: 0.05,
  minWindowSize: 20
};

type KpiMetric = keyof KpiWindow['metrics'];
type ThresholdSelector = (config: KpiRolloutMonitorConfig) => number;

const KPI_PRIORITY_ORDER: Array<{ metric: KpiMetric; getThreshold: ThresholdSelector }> = [
  { metric: 'reliability', getThreshold: (config) => config.reliabilityDropThreshold },
  { metric: 'territory', getThreshold: (config) => config.territoryDropThreshold },
  { metric: 'resources', getThreshold: () => Number.POSITIVE_INFINITY },
  { metric: 'kills', getThreshold: () => Number.POSITIVE_INFINITY }
];

const KPI_METRIC_DEFAULTS = {
  reliability: 0,
  territory: 0,
  resources: 0,
  kills: 0
};

export function checkKpiRegression(
  recentKpiWindows: KpiWindowHistory,
  baselineKpiWindows: KpiWindowHistory,
  config: Partial<KpiRolloutMonitorConfig> = {}
): KpiRegressionResult {
  const normalizedConfig: KpiRolloutMonitorConfig = {
    ...DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG,
    ...config
  };

  const regressedFamilies: string[] = [];
  const metrics: Record<string, { current: number; baseline: number; delta: number }> = {};
  const details: string[] = [];
  const minWindowSize = Math.max(1, Math.floor(normalizedConfig.minWindowSize));

  for (const family of Object.keys({ ...baselineKpiWindows, ...recentKpiWindows })) {
    const recentWindows = recentKpiWindows[family] ?? [];
    const baselineWindows = baselineKpiWindows[family] ?? [];

    if (
      recentWindows.length < minWindowSize ||
      baselineWindows.length < minWindowSize
    ) {
      continue;
    }

    const currentAverage = averageKpiWindowMetrics(recentWindows);
    const baselineAverage = averageKpiWindowMetrics(baselineWindows);
    if (!currentAverage || !baselineAverage) {
      continue;
    }

    const regression = detectRegressionForFamily(family, currentAverage, baselineAverage, normalizedConfig);
    if (!regression) {
      continue;
    }

    regressedFamilies.push(family);
    metrics[family] = {
      current: regression.current,
      baseline: regression.baseline,
      delta: regression.current - regression.baseline
    };
    details.push(
      `${family}:${regression.metric} dropped ${(regression.dropRatio * 100).toFixed(1)}% from ` +
        `${regression.baseline.toFixed(2)} to ${regression.current.toFixed(2)} (threshold ${(
          regression.threshold * 100
        ).toFixed(1)}%)`
    );
  }

  return {
    regression: regressedFamilies.length > 0,
    regressedFamilies,
    details: details.join(' | '),
    metrics
  };
}

function detectRegressionForFamily(
  family: string,
  current: { reliability: number; territory: number; resources: number; kills: number },
  baseline: { reliability: number; territory: number; resources: number; kills: number },
  config: KpiRolloutMonitorConfig
): KpiRegressionEntry | null {
  for (const { metric, getThreshold } of KPI_PRIORITY_ORDER) {
    const currentValue = current[metric];
    const baselineValue = baseline[metric];
    if (!isFiniteNumber(currentValue) || !isFiniteNumber(baselineValue)) {
      continue;
    }

    const threshold = getThreshold(config);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      continue;
    }

    const dropRatio = baselineValue <= 0 ? 0 : (baselineValue - currentValue) / baselineValue;
    if (dropRatio >= threshold) {
      return {
        family,
        metric,
        current: currentValue,
        baseline: baselineValue,
        dropRatio,
        threshold
      };
    }
  }

  return null;
}

export function averageKpiWindowMetrics(
  windows: KpiWindow[]
): { reliability: number; territory: number; resources: number; kills: number } | null {
  if (!windows.length) {
    return null;
  }

  const totals = { ...KPI_METRIC_DEFAULTS };
  let count = 0;

  for (const window of windows) {
    if (
      !isFiniteNumber(window.metrics.reliability) ||
      !isFiniteNumber(window.metrics.territory) ||
      !isFiniteNumber(window.metrics.resources) ||
      !isFiniteNumber(window.metrics.kills)
    ) {
      continue;
    }

    totals.reliability += window.metrics.reliability;
    totals.territory += window.metrics.territory;
    totals.resources += window.metrics.resources;
    totals.kills += window.metrics.kills;
    count += 1;
  }

  if (!count) {
    return null;
  }

  return {
    reliability: totals.reliability / count,
    territory: totals.territory / count,
    resources: totals.resources / count,
    kills: totals.kills / count
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
