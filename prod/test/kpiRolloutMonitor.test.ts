import { checkKpiRegression, type KpiWindow, type KpiWindowHistory } from '../src/rl/kpiRolloutMonitor';

function makeWindow(
  timestamp: number,
  metrics: { reliability: number; territory: number; resources: number; kills: number }
): KpiWindow {
  return { timestamp, metrics };
}

describe('kpi rollout regression detector', () => {
  it('does not detect regression when all KPIs are stable', () => {
    const baseline: KpiWindowHistory = {
      construction: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index, { reliability: 1, territory: 800, resources: 500, kills: 100 })
      )
    };
    const recent: KpiWindowHistory = {
      construction: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index + 20, { reliability: 1, territory: 810, resources: 550, kills: 120 })
      )
    };

    const result = checkKpiRegression(recent, baseline);

    expect(result.regression).toBe(false);
    expect(result.regressedFamilies).toEqual([]);
    expect(result.details).toBe('');
    expect(result.metrics).toEqual({});
  });

  it('detects reliability regression when reliability drops by 15%', () => {
    const baseline: KpiWindowHistory = {
      exploration: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index, { reliability: 1, territory: 900, resources: 500, kills: 20 })
      )
    };
    const recent: KpiWindowHistory = {
      exploration: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index + 20, { reliability: 0.85, territory: 900, resources: 500, kills: 20 })
      )
    };

    const result = checkKpiRegression(recent, baseline);

    expect(result.regression).toBe(true);
    expect(result.regressedFamilies).toEqual(['exploration']);
    expect(result.metrics.exploration).toMatchObject({
      current: expect.closeTo(0.85, 12),
      baseline: 1,
      delta: expect.closeTo(-0.15, 12)
    });
    expect(result.details).toContain('exploration:reliability');
  });

  it('detects territory regression when reliability is stable and territory drops by 10%', () => {
    const baseline: KpiWindowHistory = {
      construction: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index, { reliability: 1, territory: 1000, resources: 500, kills: 20 })
      )
    };
    const recent: KpiWindowHistory = {
      construction: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index + 20, { reliability: 1, territory: 900, resources: 500, kills: 20 })
      )
    };

    const result = checkKpiRegression(recent, baseline);

    expect(result.regression).toBe(true);
    expect(result.regressedFamilies).toEqual(['construction']);
    expect(result.metrics.construction).toEqual({ current: 900, baseline: 1000, delta: -100 });
    expect(result.details).toContain('construction:territory');
  });

  it('does not detect regression when only lower-priority KPI drops', () => {
    const baseline: KpiWindowHistory = {
      construction: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index, { reliability: 1, territory: 1000, resources: 500, kills: 400 })
      )
    };
    const recent: KpiWindowHistory = {
      construction: Array.from({ length: 20 }, (_, index) =>
        makeWindow(index + 20, { reliability: 1, territory: 1000, resources: 10, kills: 10 })
      )
    };

    const result = checkKpiRegression(recent, baseline);

    expect(result.regression).toBe(false);
    expect(result.regressedFamilies).toEqual([]);
  });

  it('handles empty windows as a no-regression edge case', () => {
    const result = checkKpiRegression({}, {});
    expect(result.regression).toBe(false);
    expect(result.regressedFamilies).toEqual([]);
    expect(result.details).toBe('');
  });

  it('returns no regression when windows have only one sample with default min window', () => {
    const baseline: KpiWindowHistory = {
      exploration: [makeWindow(1, { reliability: 1, territory: 1000, resources: 500, kills: 20 })]
    };
    const recent: KpiWindowHistory = {
      exploration: [makeWindow(2, { reliability: 0, territory: 800, resources: 10, kills: 0 })]
    };

    const result = checkKpiRegression(recent, baseline);

    expect(result.regression).toBe(false);
    expect(result.regressedFamilies).toEqual([]);
  });

  it('respects configurable thresholds', () => {
    const baseline: KpiWindowHistory = {
      construction: [makeWindow(1, { reliability: 1, territory: 1000, resources: 500, kills: 20 })]
    };
    const recent: KpiWindowHistory = {
      construction: [makeWindow(2, { reliability: 0.9, territory: 900, resources: 500, kills: 20 })]
    };

    const result = checkKpiRegression(recent, baseline, {
      reliabilityDropThreshold: 0.2,
      territoryDropThreshold: 0.2,
      minWindowSize: 1
    });

    expect(result.regression).toBe(false);
    expect(result.regressedFamilies).toEqual([]);
  });
});
