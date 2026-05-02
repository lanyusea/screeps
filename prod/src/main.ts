import { Kernel } from './kernel/Kernel';
export {
  DEFAULT_STRATEGY_REGISTRY,
  STRATEGY_REGISTRY_SCHEMA_VERSION,
  validateStrategyRegistry,
  validateStrategyRegistryEntry
} from './strategy/strategyRegistry';
export { DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG, evaluateStrategyShadowReplay } from './strategy/shadowEvaluator';
export {
  HistoricalReplayValidator,
  loadHistoricalReplays,
  type HistoricalReplay,
  type ValidationResult
} from './strategy/historicalReplayValidator';
export { RlRolloutGate, validateRlStrategyRollout } from './strategy/rlRolloutGate';
export { DEFAULT_VARIANCE_CONFIG, VarianceConfig, injectStrategyVariance } from './strategy/shadowEvaluator';

const kernel = new Kernel();

export function loop(): void {
  kernel.run();
}
