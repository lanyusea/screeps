import {
  buildRuntimeCpuBudget,
  buildRuntimeCpuTelemetrySummary,
  getRuntimeCpuBudget,
  isRuntimeCpuBucketCritical,
  isRuntimeCpuBucketLow,
  resetRuntimeCpuTelemetryForTesting,
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

    expect(
      buildRuntimeCpuBudget({
        tick: 1,
        used: 18,
        limit: 70,
        bucket: 500,
        tickLimit: 500
      })
    ).toMatchObject({
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

  it('sheds optional work before the bucket reaches the low-bucket alert floor', () => {
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
  });

  it('keeps optional work paused through the observed post-alert recovery boundary', () => {
    const recoveryBudget = buildRuntimeCpuBudget({
      tick: 1760015,
      used: 12,
      limit: 70,
      bucket: 1_142,
      tickLimit: 500
    });
    const boundaryBudget = buildRuntimeCpuBudget({
      tick: 1760016,
      used: 12,
      limit: 70,
      bucket: 1_210,
      tickLimit: 500
    });
    const recoveredBudget = buildRuntimeCpuBudget({
      tick: 1760017,
      used: 12,
      limit: 70,
      bucket: 1_211,
      tickLimit: 500
    });

    expect(recoveryBudget).toMatchObject({
      pressure: 'degraded',
      degraded: true,
      critical: false,
      lowCpuLimit: false,
      reasons: ['lowBucketRecovery']
    });
    expect(shouldRunOptionalCpuWork(recoveryBudget, 'economy-global-optional')).toBe(false);
    expect(shouldRunOptionalCpuRoomWork(recoveryBudget, 'E29N55')).toBe(false);
    expect(shouldShedNonessentialCpuWork(recoveryBudget)).toBe(true);
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
    expect(recoveredBudget).toMatchObject({
      pressure: 'normal',
      degraded: false,
      reasons: []
    });
  });

  it('sheds optional work once the current tick exceeds its CPU limit', () => {
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
