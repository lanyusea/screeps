import {
  generateStrategyRecommendations,
  rejectUncertain,
  type StrategyRecommendation,
  type StrategyRecommendationRoomState
} from '../src/strategy/strategyRecommender';

describe('strategy recommender', () => {
  it('filters recommendations below the default confidence threshold', () => {
    const recommendations = rejectUncertain([
      makeRecommendation({ confidence: 0.69, reasoning: 'below threshold' }),
      makeRecommendation({ confidence: 0.7, reasoning: 'at threshold' }),
      makeRecommendation({ confidence: 0.91, reasoning: 'above threshold' })
    ]);

    expect(recommendations.map((recommendation) => recommendation.reasoning)).toEqual([
      'at threshold',
      'above threshold'
    ]);
  });

  it('uses a custom confidence threshold when supplied', () => {
    const recommendations = rejectUncertain(
      [
        makeRecommendation({ confidence: 0.79, reasoning: 'below custom threshold' }),
        makeRecommendation({ confidence: 0.8, reasoning: 'at custom threshold' })
      ],
      0.8
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].reasoning).toBe('at custom threshold');
  });

  it('returns well-typed recommendation payloads', () => {
    const recommendations = generateStrategyRecommendations(makeStableHighRclRoom());

    expect(recommendations.length).toBeGreaterThan(0);
    for (const recommendation of recommendations) {
      expect(typeof recommendation.confidence).toBe('number');
      expect(recommendation.confidence).toBeGreaterThanOrEqual(0);
      expect(recommendation.confidence).toBeLessThanOrEqual(1);
      expect(typeof recommendation.reasoning).toBe('string');
      expect(recommendation.reasoning.length).toBeGreaterThan(0);
      if (recommendation.defensePosture !== undefined) {
        expect(['passive', 'alert', 'active']).toContain(recommendation.defensePosture);
      }
    }
  });

  it('keeps empty room state low confidence so shadow mode rejects it', () => {
    const recommendations = generateStrategyRecommendations({});

    expect(recommendations).toEqual([
      expect.objectContaining({
        defensePosture: 'passive',
        confidence: 0.42
      })
    ]);
    expect(rejectUncertain(recommendations)).toHaveLength(0);
  });

  it('marks hostile rooms as active defense posture', () => {
    const recommendations = generateStrategyRecommendations({
      ...makeStableLowRclRoom(),
      hostileCreepCount: 2,
      hostileStructureCount: 1
    });

    expect(recommendations[0]).toMatchObject({
      constructionPreset: 'defense-repair-and-ramparts',
      defensePosture: 'active',
      confidence: 0.94
    });
  });

  it('recommends bootstrap construction for low-RCL rooms', () => {
    const recommendations = generateStrategyRecommendations(makeStableLowRclRoom());

    expect(recommendations).toContainEqual(
      expect.objectContaining({
        constructionPreset: 'extension-container-road-bootstrap',
        defensePosture: 'passive'
      })
    );
  });

  it('recommends tower bootstrap when RCL supports towers but none are present', () => {
    const recommendations = generateStrategyRecommendations({
      ...makeStableLowRclRoom(),
      controllerLevel: 3,
      energyCapacity: 800,
      towerCount: 0
    });

    expect(recommendations).toContainEqual(
      expect.objectContaining({
        constructionPreset: 'tower-bootstrap',
        defensePosture: 'alert'
      })
    );
  });

  it('recommends safe remote targets for territory-ready rooms', () => {
    const recommendations = generateStrategyRecommendations({
      ...makeStableLowRclRoom(),
      controllerLevel: 3,
      workerCount: 4,
      territory: {
        remoteTargets: [
          { roomName: 'W1N2', action: 'reserve', score: 700, routeDistance: 2, sourceCount: 2, evidenceStatus: 'sufficient' }
        ]
      }
    });

    expect(recommendations).toContainEqual(
      expect.objectContaining({
        remoteTarget: 'W1N2',
        defensePosture: 'passive'
      })
    );
  });

  it('recommends expansion candidates for high-confidence high-RCL rooms', () => {
    const recommendations = generateStrategyRecommendations(makeStableHighRclRoom());

    expect(recommendations).toContainEqual(
      expect.objectContaining({
        expansionCandidate: 'W2N1',
        defensePosture: 'passive'
      })
    );
  });

  it('penalizes hostile territory candidates below the default rejection threshold', () => {
    const recommendations = generateStrategyRecommendations({
      ...makeStableHighRclRoom(),
      territory: {
        expansionCandidates: [
          {
            roomName: 'W3N1',
            action: 'claim',
            score: 900,
            routeDistance: 1,
            sourceCount: 2,
            hostileCreepCount: 3,
            evidenceStatus: 'sufficient'
          }
        ]
      }
    });

    const expansionRecommendation = recommendations.find(
      (recommendation) => recommendation.expansionCandidate === 'W3N1'
    );
    expect(expansionRecommendation?.confidence).toBeLessThan(0.7);
    expect(rejectUncertain(recommendations).some((recommendation) => recommendation.expansionCandidate === 'W3N1')).toBe(
      false
    );
  });
});

function makeRecommendation(overrides: Partial<StrategyRecommendation> = {}): StrategyRecommendation {
  return {
    confidence: 0.9,
    reasoning: 'test recommendation',
    ...overrides
  };
}

function makeStableLowRclRoom(): StrategyRecommendationRoomState {
  return {
    roomName: 'W1N1',
    controllerLevel: 2,
    creepCount: 4,
    workerCount: 3,
    energyAvailable: 300,
    energyCapacity: 500,
    sourceCount: 2,
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    towerCount: 0,
    rampartCount: 0
  };
}

function makeStableHighRclRoom(): StrategyRecommendationRoomState {
  return {
    roomName: 'W1N1',
    controllerLevel: 5,
    creepCount: 8,
    workerCount: 6,
    energyAvailable: 1300,
    energyCapacity: 1300,
    storedEnergy: 6000,
    sourceCount: 2,
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    towerCount: 2,
    rampartCount: 4,
    territory: {
      ownedRoomCount: 1,
      expansionCandidates: [
        { roomName: 'W2N1', action: 'claim', score: 880, routeDistance: 1, sourceCount: 2, evidenceStatus: 'sufficient' }
      ]
    }
  };
}
