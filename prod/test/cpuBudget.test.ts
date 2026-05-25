import {
  buildRuntimeCpuBudget,
  buildRuntimeCpuTelemetrySummary,
  resetRuntimeCpuTelemetryForTesting,
  shouldRunOptionalCpuRoomWork
} from '../src/runtime/cpuBudget';

describe('runtime CPU budget policy', () => {
  afterEach(() => {
    resetRuntimeCpuTelemetryForTesting();
  });

  it('keeps optional work enabled when CPU and bucket are healthy', () => {
    const budget = buildRuntimeCpuBudget({
      tick: 10,
      used: 8,
      limit: 100,
      bucket: 9_000,
      tickLimit: 500
    });

    expect(budget).toMatchObject({
      pressure: 'normal',
      degraded: false,
      critical: false,
      reasons: []
    });
    expect(shouldRunOptionalCpuRoomWork(budget, 'E29N55')).toBe(true);
  });

  it('degrades a 20 CPU account and round-robins optional room work', () => {
    const decisions = [1, 2, 3].map((tick) =>
      shouldRunOptionalCpuRoomWork(
        buildRuntimeCpuBudget({
          tick,
          used: 6,
          limit: 20,
          bucket: 9_000,
          tickLimit: 500
        }),
        'E29N55'
      )
    );

    expect(
      buildRuntimeCpuBudget({
        tick: 1,
        used: 6,
        limit: 20,
        bucket: 9_000,
        tickLimit: 500
      })
    ).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      reasons: ['lowCpuLimit']
    });
    expect(decisions.filter(Boolean)).toHaveLength(1);
  });

  it('alerts on repeated empty bucket and sustained used-over-limit samples', () => {
    buildRuntimeCpuTelemetrySummary({
      tick: 30,
      used: 24,
      limit: 20,
      bucket: 0,
      tickLimit: 500
    });

    const summary = buildRuntimeCpuTelemetrySummary({
      tick: 31,
      used: 25,
      limit: 20,
      bucket: 0,
      tickLimit: 500
    });

    expect(summary).toMatchObject({
      pressure: 'critical',
      lowBucketTicks: 2,
      bucketEmptyTicks: 2,
      overLimitTicks: 2,
      alerts: expect.arrayContaining(['bucketEmptyRepeated', 'lowBucket', 'sustainedUsedOverLimit'])
    });
  });
});
