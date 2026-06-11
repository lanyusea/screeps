import {
  buildRuntimeCpuBudget,
  buildRuntimeCpuTelemetrySummary,
  getRuntimeCpuBudget,
  isRuntimeCpuBucketCritical,
  isRuntimeCpuBucketLow,
  resetRuntimeCpuTelemetryForTesting,
  shouldRunConstructionCpuWork,
  shouldRunOptionalCpuWork,
  shouldRunOptionalCpuRoomWork,
  shouldShedNonessentialCpuWork,
  shouldThrottleRuntimeSummaryCadence
} from '../src/runtime/cpuBudget';

describe('runtime CPU budget policy', () => {
  beforeEach(() => {
    resetRuntimeCpuTelemetryForTesting();
  });

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
    expect(shouldShedNonessentialCpuWork(budget)).toBe(false);
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

  it('throttles runtime-summary cadence for low bucket pressure on otherwise healthy CPU accounts', () => {
    const budget = buildRuntimeCpuBudget({
      tick: 42,
      used: 21,
      limit: 70,
      bucket: 43,
      tickLimit: 500
    });

    expect(budget).toMatchObject({
      pressure: 'critical',
      degraded: true,
      critical: true,
      lowCpuLimit: false,
      reasons: ['criticalBucket']
    });
    expect(shouldThrottleRuntimeSummaryCadence(budget)).toBe(true);
    expect(shouldRunConstructionCpuWork(budget)).toBe(false);
  });

  it('keeps optional work paused throughout low-bucket recovery on otherwise healthy CPU accounts', () => {
    const decisions = [1, 2, 3, 4, 5, 6].map((tick) => {
      const budget = buildRuntimeCpuBudget({
        tick,
        used: 18,
        limit: 70,
        bucket: 500,
        tickLimit: 500
      });

      return {
        global: shouldRunOptionalCpuWork(budget, 'economy-global-optional'),
        room: shouldRunOptionalCpuRoomWork(budget, 'E29N55')
      };
    });

    const lowBucketBudget = buildRuntimeCpuBudget({
      tick: 1,
      used: 18,
      limit: 70,
      bucket: 500,
      tickLimit: 500
    });

    expect(lowBucketBudget).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      lowCpuLimit: false,
      reasons: ['lowBucket']
    });
    expect(decisions).toEqual(
      expect.arrayContaining([
        { global: false, room: false }
      ])
    );
    expect(decisions.every((decision) => decision.global === false && decision.room === false)).toBe(true);
    expect(shouldRunConstructionCpuWork(lowBucketBudget)).toBe(false);
    expect(
      shouldShedNonessentialCpuWork(
        buildRuntimeCpuBudget({
          tick: 7,
          used: 19,
          limit: 70,
          bucket: 101,
          tickLimit: 121
        })
      )
    ).toBe(true);
  });

  it('sheds optional work but keeps construction enabled during safe low-bucket recovery', () => {
    const budget = buildRuntimeCpuBudget({
      tick: 1749171,
      used: 10,
      limit: 70,
      bucket: 1_007,
      tickLimit: 500
    });

    expect(budget).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      lowCpuLimit: false,
      reasons: ['lowBucketRecovery']
    });
    expect(shouldRunOptionalCpuWork(budget, 'economy-global-optional')).toBe(false);
    expect(shouldRunOptionalCpuRoomWork(budget, 'E29N55')).toBe(false);
    expect(shouldShedNonessentialCpuWork(budget)).toBe(true);
    expect(shouldRunConstructionCpuWork(budget)).toBe(true);
  });

  it('keeps optional work paused but allows construction through the observed postdeploy recovery buckets', () => {
    const budgets = [
      { tick: 1774071, used: 10.419663700000456, bucket: 1_149 },
      { tick: 1774072, used: 10.012628700000278, bucket: 1_212 },
      { tick: 1774073, used: 11.4234292000001, bucket: 1_155 },
      { tick: 1778500, used: 11.56589829999939, bucket: 1_322 },
      { tick: 1778505, used: 14.938247999998566, bucket: 1_299 },
      { tick: 1778516, used: 12.664124599999923, bucket: 1_305 },
      { tick: 1778516, used: 58.535224199997174, bucket: 1_356 },
      { tick: 1781934, used: 15.34289709999939, bucket: 1_646 },
      { tick: 1781938, used: 48.868957800001226, bucket: 1_710 },
      { tick: 1786644, used: 9.990546399989398, bucket: 1_725 },
      { tick: 1786646, used: 11.366261400005897, bucket: 1_708 },
      { tick: 1786648, used: 12.4872194999989, bucket: 1_719 },
      { tick: 1786650, used: 12.57724629999575, bucket: 1_713 }
    ].map((sample) =>
      buildRuntimeCpuBudget({
        ...sample,
        limit: 70,
        tickLimit: 500
      })
    );

    for (const budget of budgets) {
      expect(budget).toMatchObject({
        pressure: 'degraded',
        degraded: true,
        critical: false,
        lowCpuLimit: false,
        reasons: ['lowBucketRecovery']
      });
      expect(shouldRunOptionalCpuWork(budget, 'economy-global-optional')).toBe(false);
      expect(shouldRunOptionalCpuRoomWork(budget, 'E29N55')).toBe(false);
      expect(shouldShedNonessentialCpuWork(budget)).toBe(true);
      expect(shouldRunConstructionCpuWork(budget)).toBe(true);
    }
  });

  it('keeps construction enabled during postdeploy over-limit recovery buckets', () => {
    const budgets = [
      buildRuntimeCpuBudget({
        tick: 1781934,
        used: 74.24123780000082,
        limit: 70,
        bucket: 1_702,
        tickLimit: 500
      }),
      buildRuntimeCpuBudget({
        tick: 1781936,
        used: 77.13447970000198,
        limit: 70,
        bucket: 1_707,
        tickLimit: 500
      }),
      buildRuntimeCpuBudget({
        tick: 1786643,
        used: 70.01923810000153,
        limit: 70,
        bucket: 1_776,
        tickLimit: 500
      }),
      buildRuntimeCpuBudget({
        tick: 1786645,
        used: 85.61095520000526,
        limit: 70,
        bucket: 1_775,
        tickLimit: 500
      }),
      buildRuntimeCpuBudget({
        tick: 1786647,
        used: 73.64354370000365,
        limit: 70,
        bucket: 1_774,
        tickLimit: 500
      }),
      buildRuntimeCpuBudget({
        tick: 1786649,
        used: 76.34141639999143,
        limit: 70,
        bucket: 1_771,
        tickLimit: 500
      })
    ];

    for (const budget of budgets) {
      expect(budget).toMatchObject({
        pressure: 'degraded',
        degraded: true,
        critical: false,
        lowCpuLimit: false,
        reasons: ['lowBucketRecovery', 'usedOverLimit']
      });
      expect(shouldRunOptionalCpuWork(budget, 'economy-global-optional')).toBe(false);
      expect(shouldRunOptionalCpuRoomWork(budget, 'E29N55')).toBe(false);
      expect(shouldShedNonessentialCpuWork(budget)).toBe(true);
      expect(shouldRunConstructionCpuWork(budget)).toBe(true);
    }
  });

  it('keeps construction enabled when over-limit CPU projects into the recovery corridor', () => {
    const budget = buildRuntimeCpuBudget({
      tick: 2039860,
      used: 78.23037710000062,
      limit: 70,
      bucket: 1_842,
      tickLimit: 500
    });

    expect(budget).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      lowCpuLimit: false,
      reasons: ['usedOverLimit']
    });
    expect(shouldRunOptionalCpuWork(budget, 'economy-global-optional')).toBe(false);
    expect(shouldRunOptionalCpuRoomWork(budget, 'E29N55')).toBe(false);
    expect(shouldShedNonessentialCpuWork(budget)).toBe(true);
    expect(shouldRunConstructionCpuWork(budget)).toBe(true);
  });

  it('keeps construction guarded when over-limit CPU would drain below the low-bucket floor', () => {
    const budget = buildRuntimeCpuBudget({
      tick: 2039861,
      used: 90,
      limit: 70,
      bucket: 1_010,
      tickLimit: 500
    });

    expect(budget).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      lowCpuLimit: false,
      reasons: ['lowBucketRecovery', 'usedOverLimit']
    });
    expect(shouldRunConstructionCpuWork(budget)).toBe(false);
  });

  it('resumes optional work only after the widened low-bucket recovery boundary', () => {
    const boundaryBudget = buildRuntimeCpuBudget({
      tick: 1760016,
      used: 12,
      limit: 70,
      bucket: 1_840,
      tickLimit: 500
    });
    const recoveredBudget = buildRuntimeCpuBudget({
      tick: 1760017,
      used: 12,
      limit: 70,
      bucket: 1_841,
      tickLimit: 500
    });

    expect(boundaryBudget).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      lowCpuLimit: false,
      reasons: ['lowBucketRecovery']
    });
    expect(shouldRunOptionalCpuWork(boundaryBudget, 'economy-global-optional')).toBe(false);
    expect(shouldRunOptionalCpuRoomWork(boundaryBudget, 'E29N55')).toBe(false);
    expect(shouldShedNonessentialCpuWork(boundaryBudget)).toBe(true);
    expect(shouldRunConstructionCpuWork(boundaryBudget)).toBe(true);
    expect(recoveredBudget).toMatchObject({
      pressure: 'normal',
      degraded: false,
      reasons: []
    });
  });

  it('sheds optional and construction work once the current tick exceeds its CPU limit', () => {
    const budget = buildRuntimeCpuBudget({
      tick: 222,
      used: 71,
      limit: 70,
      bucket: 9_000,
      tickLimit: 500
    });

    expect(budget).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      lowCpuLimit: false,
      reasons: ['usedOverLimit']
    });
    expect(shouldRunOptionalCpuWork(budget, 'economy-global-optional')).toBe(false);
    expect(shouldRunOptionalCpuRoomWork(budget, 'E29N55')).toBe(false);
    expect(shouldShedNonessentialCpuWork(budget)).toBe(true);
    expect(shouldRunConstructionCpuWork(budget)).toBe(false);
  });

  it('refreshes CPU used samples during the same game tick', () => {
    const getUsed = jest.fn().mockReturnValueOnce(21).mockReturnValueOnce(71);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 123,
      cpu: {
        getUsed,
        limit: 70,
        bucket: 9_000,
        tickLimit: 500
      } as unknown as CPU
    };

    const first = getRuntimeCpuBudget();
    const second = getRuntimeCpuBudget();

    expect(first).toMatchObject({
      tick: 123,
      pressure: 'normal',
      reasons: []
    });
    expect(second).toMatchObject({
      tick: 123,
      pressure: 'degraded',
      reasons: ['usedOverLimit'],
      sample: expect.objectContaining({ used: 71 })
    });
    expect(getUsed).toHaveBeenCalledTimes(2);
  });

  it('detects critical bucket pressure without sampling CPU used', () => {
    const getUsed = jest.fn().mockReturnValue(21);

    expect(
      isRuntimeCpuBucketCritical({
        time: 124,
        cpu: {
          getUsed,
          limit: 70,
          bucket: 1,
          tickLimit: 500
        }
      })
    ).toBe(true);
    expect(getUsed).not.toHaveBeenCalled();
  });

  it('detects low bucket pressure without sampling CPU used', () => {
    const getUsed = jest.fn().mockReturnValue(21);

    expect(
      isRuntimeCpuBucketLow({
        time: 125,
        cpu: {
          getUsed,
          limit: 70,
          bucket: 999,
          tickLimit: 500
        }
      })
    ).toBe(true);
    expect(
      isRuntimeCpuBucketLow({
        time: 126,
        cpu: {
          getUsed,
          limit: 70,
          bucket: 1_000,
          tickLimit: 500
        }
      })
    ).toBe(false);
    expect(getUsed).not.toHaveBeenCalled();
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

  it('clears sustained alert streaks when a tick has no CPU sample fields', () => {
    buildRuntimeCpuTelemetrySummary({
      tick: 30,
      used: 24,
      limit: 20,
      bucket: 0,
      tickLimit: 500
    });

    expect(buildRuntimeCpuTelemetrySummary({ tick: 31 })).toBeNull();
    const summary = buildRuntimeCpuTelemetrySummary({
      tick: 32,
      used: 25,
      limit: 20,
      bucket: 0,
      tickLimit: 500
    });

    expect(summary).toMatchObject({
      lowBucketTicks: 1,
      bucketEmptyTicks: 1,
      overLimitTicks: 1,
      alerts: ['lowBucket']
    });
  });
});
