import {
  buildStrategyKpiVector,
  compareStrategyKpiVectors,
  parseStrategyEvaluationArtifacts,
  reduceStrategyKpis
} from '../src/strategy/kpiEvaluator';

describe('strategy KPI evaluator', () => {
  it('keeps reliability as a hard floor before later rewards', () => {
    const reliableButSmall = buildStrategyKpiVector({
      reliabilityPassed: true,
      territory: 1,
      resources: 0,
      kills: 0
    });
    const unreliableButRich = buildStrategyKpiVector({
      reliabilityPassed: false,
      territory: 10_000_000,
      resources: 10_000_000,
      kills: 10_000_000
    });

    expect(compareStrategyKpiVectors(reliableButSmall, unreliableButRich)).toBeGreaterThan(0);
  });

  it('keeps territory ahead of resources and kills', () => {
    const territoryWinner = buildStrategyKpiVector({
      reliabilityPassed: true,
      territory: 2,
      resources: 0,
      kills: 0
    });
    const laterRewardWinner = buildStrategyKpiVector({
      reliabilityPassed: true,
      territory: 1,
      resources: 1_000_000,
      kills: 1_000_000
    });

    expect(compareStrategyKpiVectors(territoryWinner, laterRewardWinner)).toBeGreaterThan(0);
  });

  it('keeps resources ahead of kills after reliability and territory tie', () => {
    const resourceWinner = buildStrategyKpiVector({
      reliabilityPassed: true,
      territory: 1,
      resources: 2,
      kills: 0
    });
    const killWinner = buildStrategyKpiVector({
      reliabilityPassed: true,
      territory: 1,
      resources: 1,
      kills: 1_000_000
    });

    expect(compareStrategyKpiVectors(resourceWinner, killWinner)).toBeGreaterThan(0);
  });

  it('reduces runtime-summary reliability failures before KPI scoring', () => {
    const [artifact] = parseStrategyEvaluationArtifacts({
      type: 'runtime-summary',
      tick: 10,
      reliability: { loopExceptionCount: 1 },
      rooms: [
        {
          roomName: 'E26S49',
          controller: { level: 3, progress: 40_000, ticksToDowngrade: 8_000 },
          resources: { storedEnergy: 10_000, workerCarriedEnergy: 500, sourceCount: 2 },
          combat: { events: { creepDestroyedCount: 5 } }
        }
      ]
    });

    const kpi = reduceStrategyKpis([artifact!]);

    expect(kpi.reliability.passed).toBe(false);
    expect(kpi.reliability.reasons).toContain('loop exceptions 1 exceed 0');
    expect(kpi.territory.score).toBeGreaterThan(0);
    expect(kpi.resources.score).toBeGreaterThan(0);
    expect(kpi.kills.score).toBeGreaterThan(0);
  });

  it('can reduce a room snapshot artifact without runtime APIs', () => {
    const artifacts = parseStrategyEvaluationArtifacts({
      artifactType: 'room-snapshot',
      roomName: 'E26S49',
      tick: 11,
      owner: 'bot',
      objects: {
        controller: { type: 'controller', my: true, level: 2 },
        source1: { type: 'source' },
        source2: { type: 'source' },
        storage: { type: 'storage', store: { energy: 350 } },
        hostile: { type: 'creep', owner: { username: 'enemy' } }
      }
    });

    const kpi = reduceStrategyKpis(artifacts);

    expect(kpi.reliability.passed).toBe(true);
    expect(kpi.territory.components.ownedRooms).toBe(1);
    expect(kpi.resources.components.visibleSources).toBe(2);
    expect(kpi.resources.components.storedEnergy).toBe(350);
    expect(kpi.kills.components.hostilePressureObserved).toBe(1);
  });

  it('accepts already-normalized room snapshot artifacts', () => {
    const artifacts = parseStrategyEvaluationArtifacts([
      {
        artifactType: 'room-snapshot',
        roomName: 'E26S49',
        tick: 12,
        owner: 'bot',
        objects: [
          { id: 'controller', type: 'controller', owner: { username: 'bot' }, level: 3 },
          { id: 'source1', type: 'source' },
          { id: 'source2', type: 'source' }
        ]
      }
    ]);

    const kpi = reduceStrategyKpis(artifacts);

    expect(artifacts).toHaveLength(1);
    expect(kpi.territory.components.ownedRooms).toBe(1);
    expect(kpi.territory.components.controllerLevels).toBe(3);
    expect(kpi.resources.components.visibleSources).toBe(2);
  });

  it('infers room snapshot ownership from controller metadata when artifact owner is absent', () => {
    for (const { controller, controllerLevel } of [
      { controller: { id: 'controller', type: 'controller', owner: { username: 'bot' }, level: 4 }, controllerLevel: 4 },
      { controller: { id: 'controller', type: 'controller', user: 'bot', level: 5 }, controllerLevel: 5 }
    ]) {
      const artifacts = parseStrategyEvaluationArtifacts([
        {
          artifactType: 'room-snapshot',
          roomName: 'E26S49',
          tick: 13,
          objects: [
            controller,
            { id: 'harvester', type: 'creep', user: 'bot' },
            { id: 'invader', type: 'creep', owner: { username: 'enemy' } }
          ]
        }
      ]);

      const kpi = reduceStrategyKpis(artifacts);

      expect(kpi.territory.components.ownedRooms).toBe(1);
      expect(kpi.territory.components.controllerLevels).toBe(controllerLevel);
      expect(kpi.kills.components.hostilePressureObserved).toBe(1);
    }
  });
});
