import {
  HistoricalReplayValidator,
  loadHistoricalReplays,
  type HistoricalReplay
} from '../src/strategy/historicalReplayValidator';
import { RlRolloutGate } from '../src/strategy/rlRolloutGate';

const STRATEGY_ID = 'construction-priority.territory-shadow.v1';

describe('historical replay validator', () => {
  beforeEach(() => {
    (globalThis as unknown as { Memory: Memory }).Memory = {} as Memory;
  });

  it('passes when at least three replay shadow scores correlate with final scores', () => {
    const validator = new HistoricalReplayValidator();

    const result = validator.validateStrategy(STRATEGY_ID, [
      replay('replay-1', 100, [8, 10]),
      replay('replay-2', 200, [18, 20]),
      replay('replay-3', 300, [26, 30])
    ]);

    expect(result.pass).toBe(true);
    expect(result.correlation).toBeCloseTo(1);
    expect(result.details).toContain('historical replay validation passed');
  });

  it('fails when fewer than three usable replay scores are available', () => {
    const validator = new HistoricalReplayValidator();

    const result = validator.validateStrategy(STRATEGY_ID, [
      replay('replay-1', 100, [10]),
      replay('replay-2', 200, [20]),
      replay('replay-3', 300, [])
    ]);

    expect(result.pass).toBe(false);
    expect(result.correlation).toBeCloseTo(1);
    expect(result.details).toContain('2/3 usable replays');
  });

  it('fails when historical replay correlation is below the rollout threshold', () => {
    const validator = new HistoricalReplayValidator();

    const result = validator.validateStrategy(STRATEGY_ID, [
      replay('replay-1', 100, [30]),
      replay('replay-2', 200, [20]),
      replay('replay-3', 300, [10])
    ]);

    expect(result.pass).toBe(false);
    expect(result.correlation).toBeLessThan(0.5);
    expect(result.details).toContain('below 0.500');
  });

  it('loads historical replay skeleton data from Memory by room', () => {
    Memory.strategyHistoricalReplays = {
      E26S49: [
        replay('stored-1', 120, [12]),
        {
          replayId: 'invalid',
          room: 'E26S49',
          startTick: 1,
          endTick: 2,
          finalScore: 10,
          kpiHistory: 'not-history'
        } as unknown as HistoricalReplay
      ],
      E27S49: [replay('other-room', 900, [90], 'E27S49')]
    };

    expect(loadHistoricalReplays('E26S49')).toEqual([replay('stored-1', 120, [12])]);
    expect(loadHistoricalReplays('W1N1')).toEqual([]);
  });

  it('blocks RL rollout when historical replay validation does not pass', () => {
    const gate = new RlRolloutGate();

    const decision = gate.validateStrategyRollout({
      strategyId: STRATEGY_ID,
      room: 'E26S49',
      historicalReplays: [replay('replay-1', 100, [10]), replay('replay-2', 200, [20])]
    });

    expect(decision.pass).toBe(false);
    expect(decision.historicalReplay.pass).toBe(false);
    expect(decision.details).toContain('RL rollout blocked');
  });
});

function replay(replayId: string, finalScore: number, strategyScores: number[], room = 'E26S49'): HistoricalReplay {
  return {
    replayId,
    room,
    startTick: 1,
    endTick: 100,
    finalScore,
    kpiHistory: {
      [STRATEGY_ID]: strategyScores
    }
  };
}
