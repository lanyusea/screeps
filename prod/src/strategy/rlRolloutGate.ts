import {
  HistoricalReplayValidator,
  loadHistoricalReplays,
  type HistoricalReplay,
  type ValidationResult
} from './historicalReplayValidator';

export interface RlRolloutGateRequest {
  strategyId: string;
  room: string;
  historicalReplays?: HistoricalReplay[];
  prerequisiteResults?: ValidationResult[];
}

export interface RlRolloutGateDecision extends ValidationResult {
  historicalReplay: ValidationResult;
  prerequisiteResults: ValidationResult[];
}

export class RlRolloutGate {
  constructor(private readonly historicalReplayValidator = new HistoricalReplayValidator()) {}

  validateStrategyRollout(request: RlRolloutGateRequest): RlRolloutGateDecision {
    const prerequisiteResults = request.prerequisiteResults ?? [];
    const historicalReplays = request.historicalReplays ?? loadHistoricalReplays(request.room);
    const historicalReplay = this.historicalReplayValidator.validateStrategy(request.strategyId, historicalReplays);
    const failedPrerequisites = prerequisiteResults.filter((result) => !result.pass);
    const pass = failedPrerequisites.length === 0 && historicalReplay.pass;

    return {
      pass,
      correlation: historicalReplay.correlation,
      details: buildRolloutDetails(request.strategyId, historicalReplay, failedPrerequisites),
      historicalReplay,
      prerequisiteResults
    };
  }
}

export function validateRlStrategyRollout(request: RlRolloutGateRequest): RlRolloutGateDecision {
  return new RlRolloutGate().validateStrategyRollout(request);
}

function buildRolloutDetails(
  strategyId: string,
  historicalReplay: ValidationResult,
  failedPrerequisites: ValidationResult[]
): string {
  if (failedPrerequisites.length > 0) {
    return `RL rollout blocked for ${strategyId}: ${failedPrerequisites.length} prerequisite gate(s) failed; ${historicalReplay.details}`;
  }

  if (!historicalReplay.pass) {
    return `RL rollout blocked for ${strategyId}: ${historicalReplay.details}`;
  }

  return `RL rollout allowed for ${strategyId}: ${historicalReplay.details}`;
}

