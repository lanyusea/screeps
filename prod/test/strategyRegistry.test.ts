import {
  DEFAULT_STRATEGY_REGISTRY,
  STRATEGY_REGISTRY_SCHEMA_VERSION,
  validateStrategyRegistry
} from '../src/strategy/strategyRegistry';

describe('strategy registry schema', () => {
  it('records bounded passive strategy metadata for the initial model families', () => {
    const result = validateStrategyRegistry(DEFAULT_STRATEGY_REGISTRY);

    expect(result).toEqual({ valid: true, issues: [] });
    expect(new Set(DEFAULT_STRATEGY_REGISTRY.map((entry) => entry.family))).toEqual(
      new Set(['construction-priority', 'expansion-remote-candidate', 'defense-posture-repair-threshold'])
    );

    for (const entry of DEFAULT_STRATEGY_REGISTRY) {
      expect(entry.schemaVersion).toBe(STRATEGY_REGISTRY_SCHEMA_VERSION);
      expect(entry.owner.issue).toBe(265);
      expect(entry.supportedContext.artifactTypes.length).toBeGreaterThan(0);
      expect(entry.knobBounds.length).toBeGreaterThan(0);
      expect(Object.keys(entry.defaultValues).sort()).toEqual(entry.knobBounds.map((knob) => knob.name).sort());
      expect(entry.evidenceLinks.length).toBeGreaterThan(0);
      expect(entry.rollback.disabledByDefault).toBe(true);
      expect(entry.rollback.disableFlag).toBe('strategyShadowEvaluator.enabled=false');
    }
  });
});
