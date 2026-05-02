export interface HistoricalReplay {
  replayId: string;
  room: string;
  startTick: number;
  endTick: number;
  finalScore: number;
  kpiHistory: Record<string, number[]>;
}

export interface ValidationResult {
  pass: boolean;
  correlation: number;
  details: string;
}

declare global {
  interface Memory {
    strategyHistoricalReplays?: Record<string, HistoricalReplay[]>;
  }
}

const MIN_HISTORICAL_REPLAY_COUNT = 3;
const MIN_HISTORICAL_REPLAY_CORRELATION = 0.5;

export class HistoricalReplayValidator {
  validateStrategy(strategyId: string, historicalReplays: HistoricalReplay[]): ValidationResult {
    const scorePairs = historicalReplays.flatMap((replay) => {
      const shadowScore = getLatestFiniteScore(replay.kpiHistory[strategyId]);
      if (shadowScore === undefined || !Number.isFinite(replay.finalScore)) {
        return [];
      }

      return [{ shadowScore, finalScore: replay.finalScore }];
    });
    const correlation =
      scorePairs.length >= 2
        ? calculatePearsonCorrelation(
            scorePairs.map((pair) => pair.shadowScore),
            scorePairs.map((pair) => pair.finalScore)
          )
        : 0;
    const pass =
      scorePairs.length >= MIN_HISTORICAL_REPLAY_COUNT && correlation >= MIN_HISTORICAL_REPLAY_CORRELATION;

    return {
      pass,
      correlation,
      details: buildValidationDetails(strategyId, historicalReplays.length, scorePairs.length, correlation, pass)
    };
  }
}

export function loadHistoricalReplays(room: string): HistoricalReplay[] {
  const memory = globalThis as typeof globalThis & { Memory?: Partial<Memory> };
  const storedReplays = memory.Memory?.strategyHistoricalReplays?.[room];

  if (!Array.isArray(storedReplays)) {
    return [];
  }

  return storedReplays.flatMap((replay) => {
    const normalizedReplay = normalizeHistoricalReplay(replay);
    return normalizedReplay ? [normalizedReplay] : [];
  });
}

function buildValidationDetails(
  strategyId: string,
  availableReplayCount: number,
  usableReplayCount: number,
  correlation: number,
  pass: boolean
): string {
  const formattedCorrelation = formatCorrelation(correlation);
  if (usableReplayCount < MIN_HISTORICAL_REPLAY_COUNT) {
    return `historical replay validation failed for ${strategyId}: ${usableReplayCount}/${availableReplayCount} usable replays, requires at least ${MIN_HISTORICAL_REPLAY_COUNT}; correlation=${formattedCorrelation}`;
  }

  if (!pass) {
    return `historical replay validation failed for ${strategyId}: correlation=${formattedCorrelation} below ${MIN_HISTORICAL_REPLAY_CORRELATION.toFixed(
      3
    )} across ${usableReplayCount}/${availableReplayCount} usable replays`;
  }

  return `historical replay validation passed for ${strategyId}: correlation=${formattedCorrelation} across ${usableReplayCount}/${availableReplayCount} usable replays`;
}

function calculatePearsonCorrelation(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  const leftMean = average(left);
  const rightMean = average(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }

  if (leftVariance === 0 || rightVariance === 0) {
    return 0;
  }

  return clampCorrelation(covariance / Math.sqrt(leftVariance * rightVariance));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampCorrelation(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(-1, Math.min(1, value));
}

function getLatestFiniteScore(scores: number[] | undefined): number | undefined {
  if (!Array.isArray(scores)) {
    return undefined;
  }

  for (let index = scores.length - 1; index >= 0; index -= 1) {
    const score = scores[index];
    if (Number.isFinite(score)) {
      return score;
    }
  }

  return undefined;
}

function normalizeHistoricalReplay(rawReplay: unknown): HistoricalReplay | null {
  if (!isRecord(rawReplay)) {
    return null;
  }

  if (
    !isNonEmptyString(rawReplay.replayId) ||
    !isNonEmptyString(rawReplay.room) ||
    !isFiniteNumber(rawReplay.startTick) ||
    !isFiniteNumber(rawReplay.endTick) ||
    !isFiniteNumber(rawReplay.finalScore) ||
    !isRecord(rawReplay.kpiHistory)
  ) {
    return null;
  }

  const kpiHistory = Object.entries(rawReplay.kpiHistory).reduce<Record<string, number[]>>(
    (history, [kpiName, rawScores]) => {
      if (!Array.isArray(rawScores)) {
        return history;
      }

      history[kpiName] = rawScores.filter((score): score is number => Number.isFinite(score));
      return history;
    },
    {}
  );

  return {
    replayId: rawReplay.replayId,
    room: rawReplay.room,
    startTick: rawReplay.startTick,
    endTick: rawReplay.endTick,
    finalScore: rawReplay.finalScore,
    kpiHistory
  };
}

function formatCorrelation(correlation: number): string {
  return correlation.toFixed(3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
