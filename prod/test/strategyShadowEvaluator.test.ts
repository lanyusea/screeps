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
    expect(constructionReport?.rankingDiffs).toHaveLength(1);
    expect(constructionReport?.rankingDiffs[0]).toMatchObject({
      artifactIndex: 0,
      tick: 200,
      roomName: 'E26S49',
      context: 'construction-priority',
      changedTop: true,
      incumbentTop: {
        label: 'build extension capacity',
        rank: 1
      },
      candidateTop: {
        label: 'build remote road/container logistics',
        rank: 1
      },
      rankChanges: [
        {
          label: 'build extension capacity',
          incumbentRank: 1,
          candidateRank: 2,
          delta: -1
        },
        {
          label: 'build remote road/container logistics',
          incumbentRank: 2,
          candidateRank: 1,
          delta: 1
        }
      ]
    });

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
