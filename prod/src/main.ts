import { Kernel } from './kernel/Kernel';
export {
  DEFAULT_STRATEGY_REGISTRY,
  STRATEGY_REGISTRY_SCHEMA_VERSION,
  validateStrategyRegistry,
  validateStrategyRegistryEntry
} from './strategy/strategyRegistry';
export { DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG, evaluateStrategyShadowReplay } from './strategy/shadowEvaluator';

const kernel = new Kernel();

export function loop(): void {
  kernel.run();
}
