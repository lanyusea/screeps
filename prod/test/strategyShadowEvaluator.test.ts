import { STRATEGY_SHADOW_REPLAY_FIXTURE } from './fixtures/strategyShadowReplayFixture';
import {
  DEFAULT_VARIANCE_CONFIG,
  evaluateStrategyShadowReplay,
  injectStrategyVariance
} from '../src/strategy/shadowEvaluator';
import { DEFAULT_STRATEGY_REGISTRY } from '../src/strategy/strategyRegistry';

describe('strategy shadow evaluator', () => {
  it('is passive and disabled by default', () => {
    const report = evaluateStrategyShadowReplay({
      artifacts: STRATEGY_SHADOW_REPLAY_FIXTURE
    });

    expect(report.enabled).toBe(false);
    expect(report.disabledReason).toBe('strategy shadow evaluator disabled');
    expect(report.artifactCount).toBe(1);
    expect(report.modelReports).toEqual([]);
  });

  it('replays a fixture and reports candidate-vs-incumbent ranking diffs without live actions', () => {
    const report = evaluateStrategyShadowReplay({
      artifacts: STRATEGY_SHADOW_REPLAY_FIXTURE,
      config: {
        enabled: true,
        candidateStrategyIds: [
          'construction-priority.territory-shadow.v1',
          'expansion-remote.territory-shadow.v1'
        ]
      }
    }, { enabled: false });

    expect(report.enabled).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.kpi.reliability.passed).toBe(true);

    const constructionReport = report.modelReports.find((modelReport) => modelReport.family === 'construction-priority');
    expect(constructionReport?.rankingDiffs).toEqual([]);

    const expansionReport = report.modelReports.find(
      (modelReport) => modelReport.family === 'expansion-remote-candidate'
    );
    expect(expansionReport?.rankingDiffs).toHaveLength(1);
    expect(expansionReport?.rankingDiffs[0]).toMatchObject({
      context: 'expansion-remote-candidate',
      changedTop: true,
      incumbentTop: {
        label: 'reserve E48S27',
        rank: 1
      },
      candidateTop: {
        label: 'occupy E49S28',
        rank: 1
      }
    });
  });

  it('keeps extension scoring elevated without demoting source-container or road logistics', () => {
    const report = evaluateStrategyShadowReplay({
      artifacts: makeConstructionPriorityScoringFixture(),
      config: {
        enabled: true,
        candidateStrategyIds: ['construction-priority.territory-shadow.v1']
      }
    }, { enabled: false });

    const constructionReport = report.modelReports.find((modelReport) => modelReport.family === 'construction-priority');
    expect(constructionReport?.rankingDiffs).toHaveLength(1);

    const rankingDiff = constructionReport?.rankingDiffs[0];
    expect(rankingDiff).toMatchObject({
      artifactIndex: 0,
      tick: 739_620,
      roomName: 'E26S49',
      context: 'construction-priority',
      changedTop: false,
      incumbentTop: {
        label: 'finish extension site',
        rank: 1
      },
      candidateTop: {
        label: 'finish extension site',
        rank: 1
      }
    });
    expect(rankingDiff?.candidateTop?.score).toBeGreaterThan(rankingDiff?.incumbentTop?.score ?? 0);
    expectRankNotRegressed(rankingDiff, 'build source containers');
    expectRankNotRegressed(rankingDiff, 'build source/controller roads');
  });

  it('injects candidate variance that varies by seed', () => {
    const candidate = DEFAULT_STRATEGY_REGISTRY.find(
      (entry) => entry.id === 'construction-priority.territory-shadow.v1'
    );
    if (!candidate) {
      throw new Error('construction-priority shadow candidate missing from registry');
    }

    const first = injectStrategyVariance(candidate, { ...DEFAULT_VARIANCE_CONFIG, defaultNoiseScale: 0.5, evaluationTimestamp: 1700000100 });
    const second = injectStrategyVariance(candidate, {
      ...DEFAULT_VARIANCE_CONFIG,
      defaultNoiseScale: 0.5,
      evaluationTimestamp: 1700000200
    });

    expect(first.defaultValues).not.toEqual(second.defaultValues);
  });

  it('keeps incumbent default values even when variance is enabled', () => {
    const incumbent = DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.incumbent.v1');
    if (!incumbent) {
      throw new Error('incumbent strategy missing from registry');
    }

    const perturbed = injectStrategyVariance(incumbent, {
      ...DEFAULT_VARIANCE_CONFIG,
      defaultNoiseScale: 0.5,
      evaluationTimestamp: 1700000100
    });

    expect(perturbed.defaultValues).toEqual(incumbent.defaultValues);
  });

  it('keeps perturbed values within knob bounds', () => {
    const candidate = DEFAULT_STRATEGY_REGISTRY.find(
      (entry) => entry.id === 'expansion-remote.territory-shadow.v1'
    );
    if (!candidate) {
      throw new Error('expansion-remote shadow candidate missing from registry');
    }

    const perturbed = injectStrategyVariance(candidate, { ...DEFAULT_VARIANCE_CONFIG, defaultNoiseScale: 1, evaluationTimestamp: 1700000300 });

    for (const knob of candidate.knobBounds) {
      const value = perturbed.defaultValues[knob.name];
      if (knob.bounds.kind === 'number' || knob.bounds.kind === 'integer') {
        expect(typeof value).toBe('number');
        expect(value).toBeGreaterThanOrEqual(knob.bounds.min);
        expect(value).toBeLessThanOrEqual(knob.bounds.max);
      }
    }
  });

  it('returns exact defaults when variance is disabled', () => {
    const candidate = DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.territory-shadow.v1');
    if (!candidate) {
      throw new Error('construction-priority shadow candidate missing from registry');
    }

    const perturbed = injectStrategyVariance(candidate, {
      enabled: false,
      defaultNoiseScale: 0.5,
      evaluationTimestamp: 1700000100
    });

    expect(perturbed.defaultValues).toEqual(candidate.defaultValues);
  });

  it('uses different noise scales to produce different perturbation magnitudes', () => {
    const candidate = DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.territory-shadow.v1');
    if (!candidate) {
      throw new Error('construction-priority shadow candidate missing from registry');
    }

    const lowNoiseCandidate = injectStrategyVariance(candidate, {
      ...DEFAULT_VARIANCE_CONFIG,
      defaultNoiseScale: 0.01,
      evaluationTimestamp: 1700000400
    });
    const highNoiseCandidate = injectStrategyVariance(candidate, {
      ...DEFAULT_VARIANCE_CONFIG,
      defaultNoiseScale: 0.5,
      evaluationTimestamp: 1700000400
    });

    const lowNoiseMagnitude = calculatePerturbationMagnitude(candidate, lowNoiseCandidate);
    const highNoiseMagnitude = calculatePerturbationMagnitude(candidate, highNoiseCandidate);

    expect(highNoiseMagnitude).toBeGreaterThan(lowNoiseMagnitude);
  });

  it('is deterministic with the same seed', () => {
    const candidate = DEFAULT_STRATEGY_REGISTRY.find(
      (entry) => entry.id === 'expansion-remote.territory-shadow.v1'
    );
    if (!candidate) {
      throw new Error('expansion-remote shadow candidate missing from registry');
    }

    const first = injectStrategyVariance(candidate, {
      ...DEFAULT_VARIANCE_CONFIG,
      defaultNoiseScale: 0.3,
      evaluationTimestamp: 1700000500
    });
    const second = injectStrategyVariance(candidate, {
      ...DEFAULT_VARIANCE_CONFIG,
      defaultNoiseScale: 0.3,
      evaluationTimestamp: 1700000500
    });

    expect(first.defaultValues).toEqual(second.defaultValues);
  });
});

function calculatePerturbationMagnitude(seedCandidate: (typeof DEFAULT_STRATEGY_REGISTRY)[number], perturbedCandidate: typeof DEFAULT_STRATEGY_REGISTRY[number]): number {
  return seedCandidate.knobBounds.reduce((total, knob) => {
    const defaultValue = seedCandidate.defaultValues[knob.name];
    const perturbedValue = perturbedCandidate.defaultValues[knob.name];
    if (typeof defaultValue !== 'number' || typeof perturbedValue !== 'number') {
      return total;
    }
    return total + Math.abs(perturbedValue - defaultValue);
  }, 0);
}

function expectRankNotRegressed(
  rankingDiff: NonNullable<ReturnType<typeof evaluateStrategyShadowReplay>['modelReports'][number]['rankingDiffs'][number]> | undefined,
  label: string
): void {
  const rankChange = rankingDiff?.rankChanges.find((change) => change.label === label);
  expect(rankChange?.delta ?? 0).toBeGreaterThanOrEqual(0);
}

function makeConstructionPriorityScoringFixture(): string {
  return `#runtime-summary ${JSON.stringify({
    type: 'runtime-summary',
    tick: 739_620,
    rooms: [
      {
        roomName: 'E26S49',
        energyAvailable: 300,
        energyCapacity: 300,
        workerCount: 5,
        controller: {
          level: 4,
          progress: 95_914,
          progressTotal: 405_000
        },
        resources: {
          storedEnergy: 300,
          workerCarriedEnergy: 0,
          sourceCount: 2
        },
        constructionPriority: {
          candidates: [
            constructionCandidate(
              'finish extension site',
              55,
              'high',
              ['raises spawn energy capacity', 'unlocks larger workers and faster RCL progress']
            ),
            constructionCandidate(
              'build source containers',
              25,
              'low',
              ['improves source harvest throughput', 'stabilizes energy resource capacity for workers']
            ),
            constructionCandidate(
              'build source/controller roads',
              20,
              'low',
              ['improves source harvest throughput', 'keeps worker energy route moving to controller']
            ),
            constructionCandidate('finish generic container site', 47, 'low', ['finishes queued local storage work']),
            constructionCandidate(
              'build remote road/container logistics',
              1,
              'medium',
              ['opens remote territory route', 'supports reserve room economy', 'improves harvest throughput']
            ),
            constructionCandidate(
              'build rampart defense',
              8,
              'medium',
              ['protects controller territory', 'adds rampart defense survivability'],
              ['decays without sustained repair budget']
            )
          ]
        }
      }
    ]
  })}`;
}

function constructionCandidate(
  buildItem: string,
  score: number,
  urgency: string,
  expectedKpiMovement: string[],
  risk: string[] = []
): Record<string, unknown> {
  return {
    buildItem,
    room: 'E26S49',
    score,
    urgency,
    preconditions: [],
    expectedKpiMovement,
    risk
  };
}
