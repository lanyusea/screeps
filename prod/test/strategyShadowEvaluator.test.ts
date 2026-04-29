import { STRATEGY_SHADOW_REPLAY_FIXTURE } from './fixtures/strategyShadowReplayFixture';
import { evaluateStrategyShadowReplay } from '../src/strategy/shadowEvaluator';

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
    });

    expect(report.enabled).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.kpi.reliability.passed).toBe(true);

    const constructionReport = report.modelReports.find((modelReport) => modelReport.family === 'construction-priority');
    expect(constructionReport?.rankingDiffs).toHaveLength(1);
    expect(constructionReport?.rankingDiffs[0]).toMatchObject({
      artifactIndex: 0,
      tick: 200,
      roomName: 'E48S28',
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
});
