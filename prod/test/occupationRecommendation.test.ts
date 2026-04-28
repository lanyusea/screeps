import {
  scoreOccupationRecommendations,
  type OccupationRecommendationCandidateInput,
  type OccupationRecommendationInput
} from '../src/territory/occupationRecommendation';

describe('occupation recommendation scoring', () => {
  it('keeps occupy recommendations ahead of richer reserve rooms', () => {
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          source: 'adjacent',
          adjacent: true,
          actionHint: 'reserve',
          sourceCount: 2,
          routeDistance: 1
        }),
        makeCandidate({
          roomName: 'W3N1',
          source: 'configured',
          actionHint: 'claim',
          sourceCount: 1,
          routeDistance: 2
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      action: 'occupy',
      evidenceStatus: 'sufficient',
      sourceCount: 1
    });
    expect(report.candidates.map((candidate) => candidate.roomName)).toEqual(['W3N1', 'W2N1']);
  });

  it('recommends scouting when visibility evidence is missing', () => {
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          visible: false,
          sourceCount: undefined,
          controller: undefined
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      action: 'scout',
      evidenceStatus: 'insufficient-evidence'
    });
    expect(report.next?.risks).toContain('controller, source, and hostile evidence unavailable');
  });

  it('filters enemy-owned and hostile rooms before selecting a safe reserve candidate', () => {
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          controller: { ownerUsername: 'enemy' },
          sourceCount: 2
        }),
        makeCandidate({
          roomName: 'W3N1',
          hostileCreepCount: 1,
          sourceCount: 2
        }),
        makeCandidate({
          roomName: 'W4N1',
          sourceCount: 1,
          routeDistance: 1
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W4N1',
      action: 'reserve',
      evidenceStatus: 'sufficient'
    });
    expect(report.candidates.find((candidate) => candidate.roomName === 'W2N1')).toMatchObject({
      evidenceStatus: 'unavailable',
      risks: ['controller owned by another account']
    });
    expect(report.candidates.find((candidate) => candidate.roomName === 'W3N1')).toMatchObject({
      evidenceStatus: 'unavailable',
      hostileCreepCount: 1
    });
  });

  it('renews own reservations only when they are near expiry', () => {
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          controller: { reservationUsername: 'me', reservationTicksToEnd: 1_500 },
          sourceCount: 2
        }),
        makeCandidate({
          roomName: 'W3N1',
          controller: { reservationUsername: 'me', reservationTicksToEnd: 500 },
          sourceCount: 1
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      action: 'reserve',
      evidenceStatus: 'sufficient'
    });
    expect(report.candidates.find((candidate) => candidate.roomName === 'W2N1')).toMatchObject({
      evidenceStatus: 'unavailable',
      evidence: ['room visible', 'controller visible', 'own reservation is healthy']
    });
  });

  it('carries colony readiness preconditions into otherwise valid recommendations', () => {
    const report = scoreOccupationRecommendations(
      makeInput(
        [
          makeCandidate({
            roomName: 'W2N1',
            sourceCount: 2
          })
        ],
        {
          energyCapacityAvailable: 300,
          workerCount: 1,
          controllerLevel: 1,
          ticksToDowngrade: 1_000
        }
      )
    );

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      action: 'reserve',
      evidenceStatus: 'sufficient',
      preconditions: [
        'raise worker count before dispatching territory creeps',
        'reach 650 energy capacity for controller work',
        'reach controller level 2 before expansion',
        'stabilize home controller downgrade timer'
      ]
    });
  });
});

function makeInput(
  candidates: OccupationRecommendationCandidateInput[],
  overrides: Partial<OccupationRecommendationInput> = {}
): OccupationRecommendationInput {
  return {
    colonyName: 'W1N1',
    colonyOwnerUsername: 'me',
    energyCapacityAvailable: 650,
    workerCount: 3,
    controllerLevel: 3,
    ticksToDowngrade: 10_000,
    candidates,
    ...overrides
  };
}

function makeCandidate(
  overrides: Partial<OccupationRecommendationCandidateInput>
): OccupationRecommendationCandidateInput {
  return {
    roomName: 'W2N1',
    source: 'configured',
    order: 0,
    adjacent: false,
    visible: true,
    actionHint: 'reserve',
    routeDistance: 1,
    controller: {},
    sourceCount: 1,
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    constructionSiteCount: 0,
    ownedStructureCount: 0,
    ...overrides
  };
}
