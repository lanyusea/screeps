import {
  buildRuntimeOccupationRecommendationReport,
  persistOccupationRecommendationFollowUpIntent,
  scoreOccupationRecommendations,
  type OccupationRecommendationCandidateInput,
  type OccupationRecommendationInput,
  type OccupationRecommendationReport
} from '../src/territory/occupationRecommendation';
import { TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS } from '../src/territory/territoryPlanner';

describe('occupation recommendation scoring', () => {
  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

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
          controllerId: 'controller3' as Id<StructureController>,
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
    expect(report.followUpIntent).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      controllerId: 'controller3'
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
    expect(report.followUpIntent).toEqual({ colony: 'W1N1', targetRoom: 'W2N1', action: 'scout' });
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

  it('treats a configured foreign reservation as reserve controller pressure', () => {
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      action: 'reserve',
      evidenceStatus: 'sufficient',
      requiresControllerPressure: true,
      evidence: ['room visible', 'controller visible', 'foreign reservation can be pressured', '2 sources visible']
    });
    expect(report.followUpIntent).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      requiresControllerPressure: true
    });
  });

  it('treats a configured foreign-reserved claim as claim controller pressure', () => {
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          actionHint: 'claim',
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      action: 'occupy',
      evidenceStatus: 'sufficient',
      requiresControllerPressure: true,
      evidence: ['room visible', 'controller visible', 'foreign reservation can be pressured', '2 sources visible']
    });
    expect(report.followUpIntent).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      requiresControllerPressure: true
    });
  });

  it('keeps unreserved reserve candidates ahead of foreign reservation pressure', () => {
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2
        }),
        makeCandidate({
          roomName: 'W3N1',
          sourceCount: 1
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      action: 'reserve',
      evidenceStatus: 'sufficient'
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

  it('preserves cached no-route distances for adjacent runtime candidates', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits: jest.fn(() => ({ '1': 'W1N2', '3': 'W2N1' }))
      } as unknown as GameMap,
      rooms: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        routeDistances: { 'W1N1>W1N2': null }
      }
    };

    const report = buildRuntimeOccupationRecommendationReport(makeRuntimeColony(), [
      {} as Creep,
      {} as Creep,
      {} as Creep
    ]);

    const unreachable = report.candidates.find((candidate) => candidate.roomName === 'W1N2');
    const uncachedAdjacent = report.candidates.find((candidate) => candidate.roomName === 'W2N1');

    expect(unreachable).toMatchObject({
      roomName: 'W1N2',
      source: 'adjacent',
      evidenceStatus: 'unavailable',
      risks: ['no known route from colony']
    });
    expect(unreachable).not.toHaveProperty('routeDistance');
    expect(uncachedAdjacent).toMatchObject({
      roomName: 'W2N1',
      source: 'adjacent',
      evidenceStatus: 'insufficient-evidence',
      routeDistance: 1
    });
    expect(report.next?.roomName).toBe('W2N1');
  });

  it('persists the selected recommendation as a territory follow-up intent', () => {
    const unrelatedIntent: TerritoryIntentMemory = {
      colony: 'W9N9',
      targetRoom: 'W9N8',
      action: 'reserve',
      status: 'active',
      updatedAt: 600
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          null,
          unrelatedIntent,
          { colony: 'W1N1', targetRoom: 'W3N1', action: 'claim', updatedAt: 601 }
        ] as unknown as TerritoryIntentMemory[]
      }
    };
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          actionHint: 'claim',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2
        })
      ])
    );

    expect(persistOccupationRecommendationFollowUpIntent(report, 700)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 700,
      controllerId: 'controller3'
    });
    expect(Memory.territory?.intents).toEqual([
      unrelatedIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 700,
        controllerId: 'controller3'
      }
    ]);
  });

  it('preserves existing follow-up metadata while persisting a matching recommendation', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W2N1',
      originAction: 'claim'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'claim',
            status: 'active',
            updatedAt: 650,
            controllerId: 'oldController' as Id<StructureController>,
            followUp
          }
        ]
      }
    };
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          actionHint: 'claim',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2
        })
      ])
    );

    expect(persistOccupationRecommendationFollowUpIntent(report, 700)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      status: 'active',
      updatedAt: 700,
      controllerId: 'controller3',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'active',
        updatedAt: 700,
        controllerId: 'controller3',
        followUp
      }
    ]);
  });

  it('persists follow-up metadata on newly upserted recommendation intents', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { territory: { intents: [] } };
    const report: OccupationRecommendationReport = {
      candidates: [],
      next: null,
      followUpIntent: {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        controllerId: 'controller2' as Id<StructureController>,
        followUp
      }
    };

    expect(persistOccupationRecommendationFollowUpIntent(report, 720)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N2',
      action: 'reserve',
      status: 'planned',
      updatedAt: 720,
      controllerId: 'controller2',
      followUp
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 720,
        controllerId: 'controller2',
        followUp
      }
    ]);
  });

  it('persists pressure-marked recommendation follow-ups before target vision is lost', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { territory: { intents: [] } };
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2
        })
      ])
    );

    expect(persistOccupationRecommendationFollowUpIntent(report, 730)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 730,
      requiresControllerPressure: true
    });

    delete (globalThis as { Game?: Partial<Game> }).Game;
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 730,
        requiresControllerPressure: true
      }
    ]);
  });

  it('clears stale pressure requirements when the target controller is visible again', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: {
          controller: { my: false } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 730,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const report: OccupationRecommendationReport = {
      candidates: [],
      next: null,
      followUpIntent: { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' }
    };

    expect(persistOccupationRecommendationFollowUpIntent(report, 731)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 731
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 731
      }
    ]);
  });

  it('preserves stale pressure requirements while target controller visibility is missing', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 730,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const report: OccupationRecommendationReport = {
      candidates: [],
      next: null,
      followUpIntent: { colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve' }
    };

    expect(persistOccupationRecommendationFollowUpIntent(report, 731)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 731,
      requiresControllerPressure: true
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 731,
        requiresControllerPressure: true
      }
    ]);
  });

  it('preserves stale claim pressure requirements while target controller visibility is missing', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 730,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const report: OccupationRecommendationReport = {
      candidates: [],
      next: null,
      followUpIntent: { colony: 'W1N1', targetRoom: 'W2N1', action: 'claim' }
    };

    expect(persistOccupationRecommendationFollowUpIntent(report, 731)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 731,
      requiresControllerPressure: true
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 731,
        requiresControllerPressure: true
      }
    ]);
  });

  it('clears stale pressure follow-ups when the visible target no longer needs pressure', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 730,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const report = scoreOccupationRecommendations(makeInput([makeCandidate({ roomName: 'W2N1' })]));

    expect(persistOccupationRecommendationFollowUpIntent(report, 731)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 731
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 731
      }
    ]);
  });

  it('preserves fresh suppressed territory intents from recommendation persistence', () => {
    const suppressedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: 900
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [suppressedIntent]
      }
    };
    const report = scoreOccupationRecommendations(makeInput([makeCandidate({ roomName: 'W2N1' })]));

    expect(persistOccupationRecommendationFollowUpIntent(report, 1_000)).toBeNull();
    expect(Memory.territory?.intents).toEqual([suppressedIntent]);
  });

  it('marks fresh suppressed claim follow-ups as pressure without resetting suppression', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'suppressed',
            updatedAt: 900
          }
        ]
      }
    };
    const report: OccupationRecommendationReport = {
      candidates: [],
      next: null,
      followUpIntent: {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        controllerId: 'controller2' as Id<StructureController>,
        requiresControllerPressure: true
      }
    };

    expect(persistOccupationRecommendationFollowUpIntent(report, 1_000)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 900,
        controllerId: 'controller2',
        requiresControllerPressure: true
      }
    ]);
  });

  it('preserves recovered follow-up cooldown markers from recommendation persistence', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const retryTime = 1_000;
    const suppressedIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'suppressed',
      updatedAt: 900,
      lastAttemptAt: retryTime,
      followUp
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [suppressedIntent]
      }
    };
    const report = scoreOccupationRecommendations(makeInput([makeCandidate({ roomName: 'W2N1' })]));

    expect(
      persistOccupationRecommendationFollowUpIntent(
        report,
        retryTime + TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS + 1
      )
    ).toBeNull();
    expect(Memory.territory?.intents).toEqual([suppressedIntent]);
  });

  it('does not write territory memory when no recommendation exists', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    const report = scoreOccupationRecommendations(
      makeInput([
        makeCandidate({
          roomName: 'W1N1'
        })
      ])
    );

    expect(report.next).toBeNull();
    expect(report.followUpIntent).toBeNull();
    expect(persistOccupationRecommendationFollowUpIntent(report, 710)).toBeNull();
    expect(Memory.territory).toBeUndefined();
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

function makeRuntimeColony(): { room: Room; spawns: StructureSpawn[]; energyAvailable: number; energyCapacityAvailable: number } {
  return {
    room: {
      name: 'W1N1',
      controller: {
        my: true,
        level: 3,
        owner: { username: 'me' },
        ticksToDowngrade: 10_000
      } as StructureController
    } as Room,
    spawns: [],
    energyAvailable: 650,
    energyCapacityAvailable: 650
  };
}
