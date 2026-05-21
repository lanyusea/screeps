import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  buildRuntimeExpansionCandidateReport,
  maxRoomsForRcl,
  persistExpansionCandidateScores,
  refreshNextExpansionTargetSelection,
  scoreExpansionCandidates,
  selectExpansionScoutTargets,
  type ExpansionCandidateInput,
  type ExpansionScoringInput
} from '../src/territory/expansionScoring';
import { planTerritoryIntent } from '../src/territory/territoryPlanner';

describe('next expansion scoring', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 10;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 8;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 9;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { TERRAIN_MASK_SWAMP: number }).TERRAIN_MASK_SWAMP = 2;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { FIND_MINERALS?: number }).FIND_MINERALS;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
    delete (globalThis as { FIND_MY_CONSTRUCTION_SITES?: number }).FIND_MY_CONSTRUCTION_SITES;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
  });

  it('adds a material score bonus for dual-source rooms', () => {
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({ roomName: 'W2N1', order: 0, sourceCount: 1 }),
        makeCandidate({ roomName: 'W3N1', order: 1, sourceCount: 2 })
      ])
    );
    const singleSource = report.candidates.find((candidate) => candidate.roomName === 'W2N1');
    const dualSource = report.candidates.find((candidate) => candidate.roomName === 'W3N1');

    expect(report.next).toMatchObject({ roomName: 'W3N1', sourceCount: 2 });
    expect(singleSource).toBeDefined();
    expect(dualSource).toBeDefined();
    expect((dualSource?.score ?? 0) - (singleSource?.score ?? 0)).toBeGreaterThanOrEqual(250);
  });

  it('de-prioritizes duplicate-resource rooms through synergy scoring', () => {
    const report = scoreExpansionCandidates(
      makeInput(
        [
          makeCandidate({ roomName: 'W2N1', order: 0, mineral: { mineralType: 'H' } }),
          makeCandidate({ roomName: 'W3N1', order: 1, mineral: { mineralType: 'O' } })
        ],
        {
          energyCapacityAvailable: 1_000,
          claimedRooms: [{ roomName: 'W1N1', sourceCount: 2, mineralType: 'H' }]
        }
      )
    );
    const duplicate = getCandidate(report, 'W2N1');
    const complementary = getCandidate(report, 'W3N1');

    expect(report.next).toMatchObject({ roomName: 'W3N1', mineral: { mineralType: 'O' } });
    expect(complementary.score).toBeGreaterThan(duplicate.score);
    expect(duplicate.rationale).toContain('synergy duplicates H mineral coverage');
    expect(complementary.rationale).toContain('synergy adds O mineral coverage');
  });

  it('promotes complementary mineral rooms over higher-base duplicate energy rooms', () => {
    const report = scoreExpansionCandidates(
      makeInput(
        [
          makeCandidate({ roomName: 'W2N1', order: 0, sourceCount: 2, mineral: { mineralType: 'H' } }),
          makeCandidate({ roomName: 'W3N1', order: 1, sourceCount: 1, mineral: { mineralType: 'O' } })
        ],
        {
          energyCapacityAvailable: 1_000,
          claimedRooms: [{ roomName: 'W1N1', sourceCount: 2, mineralType: 'H' }]
        }
      )
    );

    expect(report.next).toMatchObject({ roomName: 'W3N1', sourceCount: 1, mineral: { mineralType: 'O' } });
    expect(getCandidate(report, 'W3N1').score).toBeGreaterThan(getCandidate(report, 'W2N1').score);
  });

  it('keeps synergy scoring additive to existing expansion factors', () => {
    const baseInput = makeInput(
      [
        makeCandidate({
          roomName: 'W2N1',
          order: 0,
          routeDistance: 1,
          nearestOwnedRoomDistance: 1,
          terrain: { walkableRatio: 0.9, swampRatio: 0.02, wallRatio: 0.1 }
        }),
        makeCandidate({
          roomName: 'W3N1',
          order: 1,
          routeDistance: 2,
          nearestOwnedRoomDistance: 2,
          terrain: { walkableRatio: 0.75, swampRatio: 0.18, wallRatio: 0.25 }
        })
      ],
      { energyCapacityAvailable: 1_000 }
    );
    const baseline = scoreExpansionCandidates(baseInput);
    const synergized = scoreExpansionCandidates({
      ...baseInput,
      claimedRooms: [{ roomName: 'W1N1', sourceCount: 2, mineralType: 'H' }],
      candidates: baseInput.candidates.map((candidate) => ({
        ...candidate,
        mineral: { mineralType: 'O' }
      }))
    });

    expect(synergized.candidates.map((candidate) => candidate.roomName)).toEqual(
      baseline.candidates.map((candidate) => candidate.roomName)
    );
    expect(getScore(synergized, 'W2N1') - getScore(synergized, 'W3N1')).toBe(
      getScore(baseline, 'W2N1') - getScore(baseline, 'W3N1')
    );
    expect(getScore(synergized, 'W2N1') - getScore(baseline, 'W2N1')).toBe(
      getScore(synergized, 'W3N1') - getScore(baseline, 'W3N1')
    );
    expect(getScore(synergized, 'W2N1')).toBeGreaterThan(getScore(baseline, 'W2N1'));
  });

  it('penalizes foreign-owned and foreign-reserved controller presence', () => {
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({ roomName: 'W2N1', order: 0 }),
        makeCandidate({
          roomName: 'W3N1',
          order: 1,
          controller: { ownerUsername: 'enemy' }
        }),
        makeCandidate({
          roomName: 'W4N1',
          order: 2,
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 4_000 }
        })
      ])
    );
    const neutral = report.candidates.find((candidate) => candidate.roomName === 'W2N1');
    const foreignOwned = report.candidates.find((candidate) => candidate.roomName === 'W3N1');
    const foreignReserved = report.candidates.find((candidate) => candidate.roomName === 'W4N1');

    expect(neutral).toBeDefined();
    expect(foreignOwned).toMatchObject({
      evidenceStatus: 'unavailable',
      risks: ['enemy-owned controller cannot be claimed safely']
    });
    expect(foreignReserved).toMatchObject({
      evidenceStatus: 'sufficient',
      reservation: { username: 'enemy', relation: 'foreign', ticksToEnd: 4_000 },
      requiresControllerPressure: true,
      risks: ['foreign reservation requires controller pressure']
    });
    expect((neutral?.score ?? 0) - (foreignOwned?.score ?? 0)).toBeGreaterThanOrEqual(2_250);
    expect((neutral?.score ?? 0) - (foreignReserved?.score ?? 0)).toBeGreaterThanOrEqual(400);
  });

  it('preserves ranking by proximity, terrain, and distance when resource and controller status match', () => {
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          order: 0,
          sourceCount: 2,
          controllerSourceRange: 6,
          terrain: { walkableRatio: 0.92, swampRatio: 0.05, wallRatio: 0.08 },
          routeDistance: 1,
          nearestOwnedRoomDistance: 1
        }),
        makeCandidate({
          roomName: 'W3N1',
          order: 1,
          sourceCount: 2,
          controllerSourceRange: 18,
          terrain: { walkableRatio: 0.72, swampRatio: 0.22, wallRatio: 0.28 },
          routeDistance: 2,
          nearestOwnedRoomDistance: 2
        })
      ])
    );

    expect(report.candidates.map((candidate) => candidate.roomName)).toEqual(['W2N1', 'W3N1']);
    expect(report.candidates[0].score).toBeGreaterThan(report.candidates[1].score);
    expect(report.candidates[0].rationale).toEqual(
      expect.arrayContaining([
        'controller-source range 6',
        'terrain walkable 92%',
        'home route distance 1',
        'nearest owned distance 1'
      ])
    );
  });

  it('ranks claim candidates by sources, controller proximity, terrain, reserves, and distance', () => {
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          sourceCount: 2,
          controllerSourceRange: 6,
          terrain: { walkableRatio: 0.92, swampRatio: 0.05, wallRatio: 0.08 },
          routeDistance: 1,
          nearestOwnedRoomDistance: 1
        }),
        makeCandidate({
          roomName: 'W3N1',
          sourceCount: 1,
          controllerSourceRange: 18,
          terrain: { walkableRatio: 0.72, swampRatio: 0.22, wallRatio: 0.28 },
          routeDistance: 2,
          nearestOwnedRoomDistance: 2,
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 4_000 }
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      evidenceStatus: 'sufficient',
      sourceCount: 2,
      controllerSourceRange: 6,
      adjacentToOwnedRoom: true
    });
    expect(report.candidates.map((candidate) => candidate.roomName)).toEqual(['W2N1', 'W3N1']);
    expect(report.candidates[0].score).toBeGreaterThan(report.candidates[1].score);
    expect(report.candidates[0].rationale).toEqual(
      expect.arrayContaining([
        'controller unreserved',
        '2 sources visible',
        'controller-source range 6',
        'terrain walkable 92%',
        'home route distance 1',
        'nearest owned distance 1',
        'adjacent to owned territory'
      ])
    );
    expect(report.candidates[1]).toMatchObject({
      reservation: { username: 'enemy', relation: 'foreign', ticksToEnd: 4000 },
      risks: ['foreign reservation requires controller pressure']
    });
  });

  it('keeps hostile and enemy-owned rooms in telemetry as unavailable while ranking safe reserves', () => {
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          hostileCreepCount: 1,
          sourceCount: 2
        }),
        makeCandidate({
          roomName: 'W3N1',
          controller: { ownerUsername: 'enemy' },
          sourceCount: 2
        }),
        makeCandidate({
          roomName: 'W4N1',
          controller: { reservationUsername: 'me', reservationTicksToEnd: 2_500 },
          sourceCount: 1
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W4N1',
      evidenceStatus: 'sufficient',
      reservation: { username: 'me', relation: 'own', ticksToEnd: 2500 }
    });
    expect(report.candidates.find((candidate) => candidate.roomName === 'W2N1')).toMatchObject({
      evidenceStatus: 'unavailable',
      risks: ['hostile presence visible']
    });
    expect(report.candidates.find((candidate) => candidate.roomName === 'W3N1')).toMatchObject({
      evidenceStatus: 'unavailable',
      risks: ['enemy-owned controller cannot be claimed safely']
    });
  });

  it('promotes sufficient safe E29N56 scout-only evidence to reserve at RCL5', () => {
    const report = scoreExpansionCandidates(
      makeInput(
        [
          makeCandidate({
            roomName: 'E29N56',
            scoutOnly: true,
            controllerId: 'controller-E29N56' as Id<StructureController>,
            sourceCount: 1,
            sourceAccessPoints: 1,
            mineral: { mineralType: 'H' }
          })
        ],
        {
          colonyName: 'E29N55',
          controllerLevel: 5,
          energyCapacityAvailable: 1_800
        }
      )
    );

    expect(report.next).toMatchObject({
      roomName: 'E29N56',
      evidenceStatus: 'sufficient',
      scoutOnly: true,
      sourceCount: 1,
      sourceAccessPoints: 1
    });

    persistExpansionCandidateScores('E29N55', report, 1_281);

    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'E29N55',
      roomName: 'E29N56',
      evidenceStatus: 'sufficient',
      scoutOnly: true,
      recommendedAction: 'reserve',
      visible: true,
      updatedAt: 1_281
    });
    expect(getExpansionCandidateMemory()[0]).not.toHaveProperty('blockReason');
    expect(Memory.territory?.targets).toBeUndefined();
  });

  it('holds sufficient E29N56 scout-only evidence below RCL5 with a controller-level block reason', () => {
    const report = scoreExpansionCandidates(
      makeInput(
        [
          makeCandidate({
            roomName: 'E29N56',
            scoutOnly: true,
            controllerId: 'controller-E29N56' as Id<StructureController>,
            sourceCount: 1,
            sourceAccessPoints: 1,
            mineral: { mineralType: 'H' }
          })
        ],
        {
          colonyName: 'E29N55',
          controllerLevel: 4,
          energyCapacityAvailable: 1_800
        }
      )
    );

    persistExpansionCandidateScores('E29N55', report, 1_282);

    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'E29N55',
      roomName: 'E29N56',
      scoutOnly: true,
      recommendedAction: 'scout',
      blockReason: 'controllerLevelLow'
    });
  });

  it.each([
    [
      'hostiles',
      makeCandidate({
        roomName: 'E29N56',
        scoutOnly: true,
        hostileCreepCount: 1,
        sourceCount: 1,
        sourceAccessPoints: 1
      }),
      undefined,
      'targetHostile'
    ],
    [
      'foreign reservation',
      makeCandidate({
        roomName: 'E29N56',
        scoutOnly: true,
        controller: { reservationUsername: 'enemy', reservationTicksToEnd: 4_000 },
        sourceCount: 1,
        sourceAccessPoints: 1
      }),
      'scout',
      'controllerReserved'
    ],
    [
      'foreign ownership',
      makeCandidate({
        roomName: 'E29N56',
        scoutOnly: true,
        controller: { ownerUsername: 'enemy' },
        sourceCount: 1,
        sourceAccessPoints: 1
      }),
      undefined,
      'controllerOwned'
    ]
  ] as const)(
    'holds E29N56 scout-only evidence when %s is present',
    (_label, candidate, recommendedAction, blockReason) => {
      const report = scoreExpansionCandidates(
        makeInput([candidate], {
          colonyName: 'E29N55',
          controllerLevel: 5,
          energyCapacityAvailable: 1_800
        })
      );

      persistExpansionCandidateScores('E29N55', report, 1_283);

      expect(getExpansionCandidateMemory()[0]).toMatchObject({
        colony: 'E29N55',
        roomName: 'E29N56',
        scoutOnly: true,
        blockReason
      });
      if (recommendedAction) {
        expect(getExpansionCandidateMemory()[0]).toHaveProperty('recommendedAction', recommendedAction);
      } else {
        expect(getExpansionCandidateMemory()[0]).not.toHaveProperty('recommendedAction');
      }
    }
  );

  it.each([
    ['low energy capacity', { energyCapacityAvailable: 300 }, 'energyCapacityLow'],
    ['downgrade guard', { ticksToDowngrade: 100 }, 'homeDowngradeGuard'],
    ['active post-claim bootstrap', { activePostClaimBootstrapCount: 1 }, 'postClaimBootstrapActive']
  ] as const)('holds E29N56 scout-only evidence on %s', (_label, inputOverrides, blockReason) => {
    const report = scoreExpansionCandidates(
      makeInput(
        [
          makeCandidate({
            roomName: 'E29N56',
            scoutOnly: true,
            controllerId: 'controller-E29N56' as Id<StructureController>,
            sourceCount: 1,
            sourceAccessPoints: 1
          })
        ],
        {
          colonyName: 'E29N55',
          controllerLevel: 5,
          energyCapacityAvailable: 1_800,
          ...inputOverrides
        }
      )
    );

    persistExpansionCandidateScores('E29N55', report, 1_284);

    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'E29N55',
      roomName: 'E29N56',
      scoutOnly: true,
      recommendedAction: 'scout',
      blockReason
    });
  });

  it.each([
    [
      'home energy buffer',
      { energyAvailable: 1_300, energyBufferThreshold: 800 },
      'energyBufferLow'
    ],
    ['low CPU bucket', { energyAvailable: 1_800, energyBufferThreshold: 800, cpuBucket: 499 }, 'cpuBucketLow'],
    ['home alert', { energyAvailable: 1_800, energyBufferThreshold: 800, homeAlertActive: true }, 'homeAlertActive']
  ] as const)('holds E29N56 scout-only evidence on %s', (_label, inputOverrides, blockReason) => {
    const report = scoreExpansionCandidates(
      makeInput(
        [
          makeCandidate({
            roomName: 'E29N56',
            scoutOnly: true,
            controllerId: 'controller-E29N56' as Id<StructureController>,
            sourceCount: 1,
            sourceAccessPoints: 1
          })
        ],
        {
          colonyName: 'E29N55',
          controllerLevel: 5,
          energyCapacityAvailable: 1_800,
          ...inputOverrides
        }
      )
    );

    persistExpansionCandidateScores('E29N55', report, 1_285);

    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'E29N55',
      roomName: 'E29N56',
      scoutOnly: true,
      recommendedAction: 'scout',
      blockReason
    });
  });

  it('discovers visible candidates adjacent to any owned room and reports terrain quality', () => {
    const colony = makeSafeColony();
    const findRoute = jest.fn((fromRoom: string, toRoom: string) =>
      Array.from(
        {
          length:
            fromRoom === 'W2N1' && toRoom === 'W3N1'
              ? 1
              : fromRoom === 'W1N1' && toRoom === 'W3N1'
                ? 2
                : 8
        },
        (_value, index) => ({ exit: 3, room: `${toRoom}-${index}` })
      )
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits: jest.fn((roomName: string) =>
          roomName === 'W2N1' ? { '3': 'W3N1' } : { '3': 'W2N1' }
        ),
        findRoute,
        getRoomLinearDistance: jest.fn((fromRoom: string, toRoom: string) =>
          fromRoom === 'W2N1' && toRoom === 'W3N1' ? 1 : 8
        ),
        getRoomTerrain: jest.fn((roomName: string) => makeTerrain(roomName === 'W3N1' ? 0.1 : 0.4))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W2N1: makeOwnedRoom('W2N1'),
        W3N1: makeVisibleExpansionRoom('W3N1', { sourceCount: 2 }),
        W9N9: makeVisibleExpansionRoom('W9N9', { sourceCount: 2 })
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.candidates.map((candidate) => candidate.roomName)).toEqual(['W3N1']);
    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      routeDistance: 2,
      nearestOwnedRoom: 'W2N1',
      nearestOwnedRoomDistance: 1,
      adjacentToOwnedRoom: true,
      sourceCount: 2,
      sourceAccessPoints: 8,
      controllerSourceRange: 10,
      terrain: {
        walkableRatio: 0.9,
        swampRatio: 0,
        wallRatio: 0.1
      }
    });
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W3N1');
    expect(findRoute).not.toHaveBeenCalledWith('W2N1', 'W3N1');
  });

  it('filters distant owned rooms by linear distance before route lookup', () => {
    const colony = makeSafeColony();
    const findRoute = jest.fn((fromRoom: string, toRoom: string) =>
      Array.from(
        { length: fromRoom === 'W2N1' && toRoom === 'W4N1' ? 2 : 3 },
        (_value, index) => ({ exit: 3, room: `${toRoom}-${index}` })
      )
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits: jest.fn(() => ({})),
        findRoute,
        getRoomLinearDistance: jest.fn((fromRoom: string, toRoom: string) =>
          fromRoom === 'W2N1' && toRoom === 'W4N1' ? 2 : 10
        ),
        getRoomTerrain: jest.fn(() => makeTerrain(0.1))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W2N1: makeOwnedRoom('W2N1'),
        W20N20: makeOwnedRoom('W20N20'),
        W4N1: makeVisibleExpansionRoom('W4N1', { sourceCount: 2 })
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.next).toMatchObject({
      roomName: 'W4N1',
      routeDistance: 3,
      nearestOwnedRoom: 'W2N1',
      nearestOwnedRoomDistance: 2
    });
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W4N1');
    expect(findRoute).toHaveBeenCalledWith('W2N1', 'W4N1');
    expect(findRoute).not.toHaveBeenCalledWith('W20N20', 'W4N1');
  });

  it('scores unseen adjacent rooms as scout-needed expansion candidates and the planner follows the persisted ranking', () => {
    const colony = makeSafeColony();
    const describeExits = jest.fn((roomName: string) =>
      roomName === 'W1N1' ? { '1': 'W1N2', '3': 'W2N1' } : {}
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits,
        findRoute: jest.fn(() => [{ exit: 3, room: 'next' }]),
        getRoomTerrain: jest.fn((roomName: string) => makeTerrain(roomName === 'W2N1' ? 0.02 : 0.45))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.candidates.map((candidate) => candidate.roomName)).toEqual(['W2N1', 'W1N2']);
    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      evidenceStatus: 'insufficient-evidence',
      visible: false,
      terrain: {
        walkableRatio: 0.98,
        swampRatio: 0,
        wallRatio: 0.02
      },
      risks: expect.arrayContaining([
        'controller evidence missing until scout',
        'source count evidence missing until scout',
        'hostile evidence missing until scout'
      ])
    });

    expect(refreshNextExpansionTargetSelection(colony, report, 400)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'insufficientEvidence'
    });
    expect(getExpansionCandidateMemory()).toEqual([
      expect.objectContaining({
        colony: 'W1N1',
        roomName: 'W2N1',
        evidenceStatus: 'insufficient-evidence',
        recommendedAction: 'scout',
        visible: false,
        updatedAt: 400
      }),
      expect.objectContaining({
        colony: 'W1N1',
        roomName: 'W1N2',
        evidenceStatus: 'insufficient-evidence',
        recommendedAction: 'scout',
        visible: false,
        updatedAt: 400
      })
    ]);
    expect(Memory.territory?.targets).toBeUndefined();

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 401)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'scout'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 401
      }
    ]);
  });

  it('discovers and scores unseen second-ring rooms as scoutable expansion candidates', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 500,
      map: {
        describeExits: jest.fn((roomName: string) => {
          switch (roomName) {
            case 'W1N1':
              return { '1': 'W1N2', '3': 'W2N1' };
            case 'W2N1':
              return { '3': 'W3N1', '7': 'W1N1' };
            case 'W1N2':
              return { '5': 'W1N1' };
            default:
              return {};
          }
        }),
        findRoute: jest.fn((_fromRoom: string, toRoom: string) =>
          Array.from({ length: toRoom === 'W3N1' ? 2 : 1 }, (_value, index) => ({
            exit: 3,
            room: `route-${index}`
          }))
        ),
        getRoomTerrain: jest.fn((roomName: string) => makeTerrain(roomName === 'W3N1' ? 0.01 : 0.9))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      evidenceStatus: 'insufficient-evidence',
      visible: false,
      adjacentToOwnedRoom: false,
      nearestOwnedRoom: 'W1N1',
      nearestOwnedRoomDistance: 2,
      routeDistance: 2,
      terrain: {
        walkableRatio: 0.99,
        swampRatio: 0,
        wallRatio: 0.01
      }
    });
    expect(selectExpansionScoutTargets(report, 1, 500)).toEqual([{ roomName: 'W3N1', distance: 2 }]);

    expect(refreshNextExpansionTargetSelection(colony, report, 500)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'insufficientEvidence'
    });
    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W3N1',
      evidenceStatus: 'insufficient-evidence',
      recommendedAction: 'scout',
      adjacentToOwnedRoom: false,
      nearestOwnedRoomDistance: 2,
      updatedAt: 500
    });
  });

  it('uses fresh second-ring scout intel to persist a claim target for the territory pipeline', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W3N1': makeScoutIntel('W3N1', { sourceCount: 2, updatedAt: 700 })
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 701,
      map: {
        describeExits: jest.fn((roomName: string) => {
          switch (roomName) {
            case 'W1N1':
              return { '3': 'W2N1' };
            case 'W2N1':
              return { '3': 'W3N1', '7': 'W1N1' };
            default:
              return {};
          }
        }),
        findRoute: jest.fn(() => [
          { exit: 3, room: 'W2N1' },
          { exit: 3, room: 'W3N1' }
        ]),
        getRoomTerrain: jest.fn(() => makeTerrain(0.05))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      evidenceStatus: 'sufficient',
      visible: false,
      sourceCount: 2,
      nearestOwnedRoomDistance: 2
    });
    expect(refreshNextExpansionTargetSelection(colony, report, 701)).toEqual({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      controllerId: 'controller-W3N1',
      score: report.candidates[0].score
    });
    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 702)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      createdBy: 'nextExpansionScoring',
      controllerId: 'controller-W3N1'
    });
  });

  it('requests a scout refresh instead of claiming from stale second-ring intel', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W3N1': makeScoutIntel('W3N1', { sourceCount: 2, updatedAt: 100 })
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_701,
      map: {
        describeExits: jest.fn((roomName: string) => {
          switch (roomName) {
            case 'W1N1':
              return { '3': 'W2N1' };
            case 'W2N1':
              return { '3': 'W3N1', '7': 'W1N1' };
            default:
              return {};
          }
        }),
        findRoute: jest.fn(() => [
          { exit: 3, room: 'W2N1' },
          { exit: 3, room: 'W3N1' }
        ]),
        getRoomTerrain: jest.fn(() => makeTerrain(0.05))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      evidenceStatus: 'sufficient',
      sourceCount: 2
    });
    expect(selectExpansionScoutTargets(report, 1, 1_701)).toEqual([
      { roomName: 'W3N1', distance: 2, controllerId: 'controller-W3N1' }
    ]);
    expect(refreshNextExpansionTargetSelection(colony, report, 1_701)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'insufficientEvidence',
      targetRoom: 'W3N1',
      controllerId: 'controller-W3N1',
      score: report.candidates[0].score
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 1_701,
        controllerId: 'controller-W3N1'
      }
    ]);
    expect(Memory.territory?.scoutAttempts?.['W1N1>W3N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W3N1',
      status: 'requested',
      requestedAt: 1_701,
      updatedAt: 1_701,
      attemptCount: 1,
      controllerId: 'controller-W3N1',
      lastValidation: {
        status: 'pending',
        updatedAt: 1_701,
        reason: 'scoutPending'
      }
    });
  });

  it('scores no-longer-visible adjacent rooms from persisted scout intel and persists rank', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: 450,
            controller: { id: 'controller2' as Id<StructureController>, my: false },
            sourceIds: ['source1', 'source2'],
            sourceCount: 2,
            sourceAccessPoints: 7,
            controllerSourceRange: 8,
            terrain: {
              walkableRatio: 0.94,
              swampRatio: 0.01,
              wallRatio: 0.05
            },
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 451,
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0.2))
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      evidenceStatus: 'sufficient',
      visible: false,
      sourceCount: 2,
      sourceAccessPoints: 7,
      controllerSourceRange: 8,
      terrain: {
        walkableRatio: 0.94,
        swampRatio: 0.01,
        wallRatio: 0.05
      },
      hostileCreepCount: 0,
      hostileStructureCount: 0
    });
    expect(report.next?.rationale).toEqual(expect.arrayContaining(['2 sources scouted']));

    expect(refreshNextExpansionTargetSelection(colony, report, 451)).toEqual({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'controller2',
      score: report.candidates[0].score
    });
    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      rank: 1,
      evidenceStatus: 'sufficient',
      recommendedAction: 'claim',
      visible: false,
      updatedAt: 451
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller2'
      }
    ]);
  });

  it('uses persisted scout intel to rank two-source neutral rooms above one-source owned rooms', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': makeScoutIntel('W2N1', { sourceCount: 2 }),
          'W1N1>W3N1': makeScoutIntel('W3N1', {
            sourceCount: 1,
            controller: {
              id: 'controller-W3N1' as Id<StructureController>,
              ownerUsername: 'enemy'
            }
          })
        }
      }
    };

    const report = scoreExpansionCandidates(
      makeInput([
        makeUnscoredCandidate('W2N1', 0),
        makeUnscoredCandidate('W3N1', 1)
      ])
    );
    const neutral = getCandidate(report, 'W2N1');
    const owned = getCandidate(report, 'W3N1');

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      visible: false,
      evidenceStatus: 'sufficient',
      sourceCount: 2
    });
    expect(neutral.rationale).toEqual(expect.arrayContaining(['controller unreserved', '2 sources scouted']));
    expect(owned).toMatchObject({
      visible: false,
      evidenceStatus: 'unavailable',
      sourceCount: 1,
      risks: ['enemy-owned controller cannot be claimed safely']
    });
    expect(neutral.score).toBeGreaterThan(owned.score);
  });

  it('uses fresh adjacent-room scout reports as expansion scoring evidence', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      intel: {
        scoutReports: {
          W2N1: makeRoomScoutReport('W2N1', {
            sourceCount: 2,
            mineralType: 'O',
            owner: null,
            controller: {
              present: true,
              state: 'unreserved',
              id: 'controller-W2N1' as Id<StructureController>
            }
          }),
          W3N1: makeRoomScoutReport('W3N1', {
            sourceCount: 2,
            owner: 'enemy',
            controller: {
              present: true,
              state: 'owned',
              id: 'controller-W3N1' as Id<StructureController>,
              ownerUsername: 'enemy'
            }
          })
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = { time: 101 };

    const report = scoreExpansionCandidates(
      makeInput([makeUnscoredCandidate('W2N1', 0), makeUnscoredCandidate('W3N1', 1)])
    );
    const neutral = getCandidate(report, 'W2N1');
    const owned = getCandidate(report, 'W3N1');

    expect(neutral).toMatchObject({
      visible: false,
      sourceCount: 2,
      terrain: {
        walkableRatio: 0.945,
        swampRatio: 0.047,
        wallRatio: 0.055
      },
      mineral: { mineralType: 'O' },
      controllerId: 'controller-W2N1'
    });
    expect(neutral.rationale).toEqual(
      expect.arrayContaining(['controller unreserved', '2 sources scouted', 'O mineral scouted'])
    );
    expect(owned).toMatchObject({
      evidenceStatus: 'unavailable',
      sourceCount: 2,
      risks: expect.arrayContaining(['enemy-owned controller cannot be claimed safely'])
    });
    expect(neutral.score).toBeGreaterThan(owned.score);
  });

  it('uses scout intel when candidate source count is zero and controller evidence is empty', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': makeScoutIntel('W2N1', {
            sourceCount: 2,
            controller: {
              id: 'controller-W2N1' as Id<StructureController>,
              ownerUsername: 'enemy'
            }
          })
        }
      }
    };

    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W2N1',
          controller: {},
          sourceCount: 0
        })
      ])
    );
    const candidate = getCandidate(report, 'W2N1');

    expect(candidate).toMatchObject({
      controllerId: 'controller-W2N1',
      evidenceStatus: 'unavailable',
      sourceCount: 2,
      risks: ['enemy-owned controller cannot be claimed safely']
    });
    expect(candidate.rationale).toEqual(
      expect.arrayContaining(['controller owned by another account', '2 sources scouted'])
    );
  });

  it('downgrades persisted scout-intel candidates when hostiles are present', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutIntel: {
          'W1N1>W2N1': makeScoutIntel('W2N1', { sourceCount: 2 }),
          'W1N1>W3N1': makeScoutIntel('W3N1', {
            sourceCount: 2,
            hostileCreepCount: 1
          })
        }
      }
    };

    const report = scoreExpansionCandidates(
      makeInput([
        makeUnscoredCandidate('W2N1', 0),
        makeUnscoredCandidate('W3N1', 1)
      ])
    );
    const safe = getCandidate(report, 'W2N1');
    const hostile = getCandidate(report, 'W3N1');

    expect(report.next).toMatchObject({ roomName: 'W2N1', evidenceStatus: 'sufficient' });
    expect(hostile).toMatchObject({
      evidenceStatus: 'unavailable',
      hostileCreepCount: 1,
      risks: ['hostile presence scouted']
    });
    expect(safe.score).toBeGreaterThan(hostile.score);
  });

  it('falls back gracefully when persisted scout intel is missing', () => {
    const report = scoreExpansionCandidates(
      makeInput([
        {
          ...makeUnscoredCandidate('W2N1', 0),
          visible: false
        }
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      visible: false,
      evidenceStatus: 'insufficient-evidence',
      risks: expect.arrayContaining([
        'controller evidence missing until scout',
        'source count evidence missing until scout',
        'hostile evidence missing until scout'
      ])
    });
    expect(Number.isFinite(report.next?.score)).toBe(true);
  });

  it('records terrain-based source accessibility for visible expansion candidates', () => {
    const colony = makeSafeColony();
    const terrain = {
      get: jest.fn((x: number, y: number) =>
        x >= 14 && x <= 16 && y >= 24 && y <= 26 && !(x === 15 && y === 25) && y !== 24
          ? TERRAIN_MASK_WALL
          : 0
      )
    } as unknown as RoomTerrain;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        describeExits: jest.fn(() => ({ '3': 'W2N1' })),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => terrain)
      } as unknown as GameMap,
      rooms: {
        W1N1: colony.room,
        W2N1: makeVisibleExpansionRoom('W2N1')
      }
    };

    const report = buildRuntimeExpansionCandidateReport(colony);

    expect(report.next).toMatchObject({
      roomName: 'W2N1',
      sourceAccessPoints: 3
    });
    expect(report.next?.rationale).toContain('source access 3 open tiles');
  });

  it('persists the selected claim target and the planner consumes it', () => {
    const colony = makeSafeColony();
    const staleTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W2N1',
      action: 'claim',
      createdBy: 'nextExpansionScoring'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [staleTarget],
        routeDistances: { 'W1N1>W3N1': 1 }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W3N1: makeVisibleExpansionRoom('W3N1', {
          controller: { id: 'controller3' as Id<StructureController>, my: false } as StructureController,
          sourceCount: 2
        })
      }
    };
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2,
          routeDistance: 1,
          nearestOwnedRoomDistance: 1
        })
      ])
    );

    expect(refreshNextExpansionTargetSelection(colony, report, 100)).toEqual({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      controllerId: 'controller3',
      score: report.candidates[0].score
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 100,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);

    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 101)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      createdBy: 'nextExpansionScoring',
      controllerId: 'controller3'
    });
  });

  it('persists own-reserved rooms as next expansion claim targets immediately', () => {
    const colony = makeSafeColony();
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2,
          controller: { reservationUsername: 'me', reservationTicksToEnd: 4_500 }
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      evidenceStatus: 'sufficient',
      reservation: { relation: 'own', ticksToEnd: 4_500 }
    });
    expect(report.next?.requiresControllerPressure).toBeUndefined();
    expect(report.next?.risks).not.toContain('foreign reservation requires controller pressure');
    expect(refreshNextExpansionTargetSelection(colony, report, 103)).toEqual({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      controllerId: 'controller3',
      score: report.candidates[0].score
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 103,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W3N1',
      evidenceStatus: 'sufficient',
      recommendedAction: 'claim',
      visible: true,
      updatedAt: 103
    });
  });

  it('persists own-reserved rooms when the reservation will expire before arrival', () => {
    const colony = makeSafeColony();
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2,
          controller: { reservationUsername: 'me', reservationTicksToEnd: 55 }
        })
      ])
    );

    expect(refreshNextExpansionTargetSelection(colony, report, 104)).toEqual({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      controllerId: 'controller3',
      score: report.candidates[0].score
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W3N1',
      evidenceStatus: 'sufficient',
      recommendedAction: 'claim',
      visible: true,
      updatedAt: 104
    });
  });

  it('persists one-source rooms as next expansion claim targets when they are the best available candidate', () => {
    const colony = makeSafeColony();
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 1
        })
      ])
    );

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      evidenceStatus: 'sufficient',
      sourceCount: 1
    });
    expect(refreshNextExpansionTargetSelection(colony, report, 102)).toEqual({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      controllerId: 'controller3',
      score: report.candidates[0].score
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 102,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(getExpansionCandidateMemory()[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W3N1',
      evidenceStatus: 'sufficient',
      sourceCount: 1,
      visible: true,
      updatedAt: 102,
      recommendedAction: 'claim'
    });
  });

  it('preserves unrelated claim intents while pruning stale next expansion intents', () => {
    const colony = makeSafeColony();
    const manualIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'active',
      updatedAt: 90
    };
    const staleNextIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 91,
      createdBy: 'nextExpansionScoring'
    };
    const unrelatedClaimIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W4N1',
      action: 'claim',
      status: 'active',
      updatedAt: 92,
      createdBy: 'occupationRecommendation'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'claim',
            createdBy: 'nextExpansionScoring'
          }
        ],
        intents: [manualIntent, staleNextIntent, unrelatedClaimIntent]
      }
    };
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2
        })
      ])
    );

    refreshNextExpansionTargetSelection(colony, report, 100);

    expect(Memory.territory?.intents).toEqual([
      manualIntent,
      unrelatedClaimIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 100,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
  });

  it('preserves an existing claim intent creator when refreshing the same expansion room', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'claim',
            status: 'active',
            updatedAt: 92,
            createdBy: 'occupationRecommendation'
          }
        ]
      }
    };
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2
        })
      ])
    );

    refreshNextExpansionTargetSelection(colony, report, 100);

    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'active',
        updatedAt: 100,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller3'
      }
    ]);
  });

  it('persists controller pressure on next expansion claim intents for foreign reservations', () => {
    const colony = makeSafeColony();
    const report = scoreExpansionCandidates(
      makeInput([
        makeCandidate({
          roomName: 'W3N1',
          controllerId: 'controller3' as Id<StructureController>,
          sourceCount: 2,
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 }
        })
      ])
    );

    refreshNextExpansionTargetSelection(colony, report, 101);

    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 101,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3',
        requiresControllerPressure: true
      }
    ]);
  });

  it.each([
    [1, 1],
    [2, 1],
    [3, 3],
    [4, 3],
    [5, 5],
    [6, 8],
    [7, 15],
    [8, 99]
  ])('blocks next expansion claims at the RCL %i max room boundary', (controllerLevel, maxRoomCount) => {
    expect(maxRoomsForRcl(controllerLevel)).toBe(maxRoomCount);

    const atLimit = scoreExpansionCandidates(
      makeInput([makeCandidate({ roomName: `W${controllerLevel + 1}N1` })], {
        controllerLevel,
        ownedRoomCount: maxRoomCount
      })
    );
    const belowLimit = scoreExpansionCandidates(
      makeInput([makeCandidate({ roomName: `W${controllerLevel + 2}N1` })], {
        controllerLevel,
        ownedRoomCount: maxRoomCount - 1
      })
    );
    const roomLimitPrecondition = `limit expansion to ${maxRoomCount} owned rooms for current controller level`;

    expect(atLimit.next?.preconditions).toContain(roomLimitPrecondition);
    expect(belowLimit.next?.preconditions).not.toContain(roomLimitPrecondition);
  });

  it('does not persist next expansion claim intents when the RCL room limit is reached', () => {
    const colony = makeSafeColony({ controllerLevel: 3 });
    const report = scoreExpansionCandidates(
      makeInput([makeCandidate({ roomName: 'W3N1', sourceCount: 2 })], {
        controllerLevel: 3,
        ownedRoomCount: 3
      })
    );

    expect(refreshNextExpansionTargetSelection(colony, report, 210)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'roomLimitReached'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('does not persist next expansion claim intents when GCL capacity is already full', () => {
    const colony = makeSafeColony({ controllerLevel: 3 });
    const report = scoreExpansionCandidates(
      makeInput([makeCandidate({ roomName: 'W3N1', sourceCount: 2 })], {
        controllerLevel: 3,
        ownedRoomCount: 1,
        gclLevel: 1
      })
    );

    expect(report.next?.preconditions).toContain('wait for GCL capacity to claim another room');
    expect(refreshNextExpansionTargetSelection(colony, report, 214)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'gclInsufficient'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
    expect(getExpansionCandidateMemory()[0]).not.toHaveProperty('recommendedAction');
  });

  it('reports the RCL room limit even when another expansion precondition is also unmet', () => {
    const colony = makeSafeColony({ controllerLevel: 3 });
    const report = scoreExpansionCandidates(
      makeInput([makeCandidate({ roomName: 'W3N1', sourceCount: 2 })], {
        controllerLevel: 3,
        ownedRoomCount: 3,
        ticksToDowngrade: 100
      })
    );

    expect(report.next?.preconditions).toEqual(
      expect.arrayContaining([
        'limit expansion to 3 owned rooms for current controller level',
        'stabilize home controller downgrade timer'
      ])
    );
    expect(refreshNextExpansionTargetSelection(colony, report, 213)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'roomLimitReached'
    });
  });

  it('leaves reserve intent planning available when the next expansion claim gate is at its room limit', () => {
    const colony = makeSafeColony({ controllerLevel: 6 });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeVisibleExpansionRoom('W2N1', { sourceCount: 2 })
      }
    };

    const report = scoreExpansionCandidates(
      makeInput([makeCandidate({ roomName: 'W3N1', sourceCount: 2 })], {
        controllerLevel: 6,
        ownedRoomCount: 8
      })
    );

    expect(report.next?.preconditions).toContain(
      'limit expansion to 8 owned rooms for current controller level'
    );
    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 211)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'W2N1-controller'
    });
  });

  it('preserves non-next-expansion claim intents when the RCL room limit prunes generated targets', () => {
    const colony = makeSafeColony({ controllerLevel: 3 });
    const activeClaimIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'active',
      updatedAt: 205,
      createdBy: 'occupationRecommendation'
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W4N1',
            action: 'claim',
            createdBy: 'nextExpansionScoring'
          }
        ],
        intents: [
          activeClaimIntent,
          {
            colony: 'W1N1',
            targetRoom: 'W4N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 206,
            createdBy: 'nextExpansionScoring'
          }
        ]
      }
    };
    const report = scoreExpansionCandidates(
      makeInput([makeCandidate({ roomName: 'W3N1', sourceCount: 2 })], {
        controllerLevel: 3,
        ownedRoomCount: 3
      })
    );

    expect(refreshNextExpansionTargetSelection(colony, report, 212)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'roomLimitReached'
    });
    expect(Memory.territory?.targets).toEqual([]);
    expect(Memory.territory?.intents).toEqual([activeClaimIntent]);
  });

  it('does not persist a next expansion target while post-claim bootstrap is active', () => {
    const colony = makeSafeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          {
            colony: 'W1N1',
            roomName: 'W2N1',
            action: 'claim',
            createdBy: 'nextExpansionScoring'
          }
        ]
      }
    };
    const report = scoreExpansionCandidates(
      makeInput(
        [
          makeCandidate({
            roomName: 'W3N1',
            sourceCount: 2
          })
        ],
        { activePostClaimBootstrapCount: 1 }
      )
    );

    expect(report.next).toMatchObject({
      roomName: 'W3N1',
      preconditions: ['finish active post-claim bootstrap before next expansion']
    });
    expect(refreshNextExpansionTargetSelection(colony, report, 200)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets).toEqual([]);
  });
});

function makeInput(
  candidates: ExpansionCandidateInput[],
  overrides: Partial<ExpansionScoringInput> = {}
): ExpansionScoringInput {
  return {
    colonyName: 'W1N1',
    colonyOwnerUsername: 'me',
    energyCapacityAvailable: 650,
    controllerLevel: 6,
    ownedRoomCount: 1,
    ticksToDowngrade: 10_000,
    candidates,
    ...overrides
  };
}

function makeCandidate(overrides: Partial<ExpansionCandidateInput> = {}): ExpansionCandidateInput {
  return {
    roomName: 'W2N1',
    order: 0,
    adjacentToOwnedRoom: true,
    routeDistance: 1,
    nearestOwnedRoom: 'W1N1',
    nearestOwnedRoomDistance: 1,
    controller: { },
    sourceCount: 1,
    sourceAccessPoints: 6,
    controllerSourceRange: 8,
    terrain: { walkableRatio: 0.85, swampRatio: 0.1, wallRatio: 0.15 },
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    ...overrides
  };
}

function makeUnscoredCandidate(roomName: string, order: number): ExpansionCandidateInput {
  return {
    roomName,
    order,
    adjacentToOwnedRoom: true,
    routeDistance: 1,
    nearestOwnedRoom: 'W1N1',
    nearestOwnedRoomDistance: 1
  };
}

function makeScoutIntel(
  roomName: string,
  overrides: Partial<TerritoryScoutIntelMemory> = {}
): TerritoryScoutIntelMemory {
  const sourceCount = overrides.sourceCount ?? 1;
  return {
    colony: 'W1N1',
    roomName,
    updatedAt: 100,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false
    },
    sourceIds: Array.from({ length: sourceCount }, (_value, index) => `${roomName}-source${index}`),
    sourceCount,
    sourceAccessPoints: 6,
    controllerSourceRange: 8,
    terrain: { walkableRatio: 0.85, swampRatio: 0.1, wallRatio: 0.15 },
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    hostileSpawnCount: 0,
    ...overrides
  };
}

function makeRoomScoutReport(
  roomName: string,
  overrides: Partial<RoomScoutReportMemory> = {}
): RoomScoutReportMemory {
  return {
    roomName,
    timestamp: 100,
    visible: true,
    terrain: { plains: 1900, swamp: 100, wall: 116 },
    ...overrides
  };
}

function makeSafeColony({
  roomName = 'W1N1',
  controllerLevel = 6,
  energyAvailable = 650,
  energyCapacityAvailable = 650
}: {
  roomName?: string;
  controllerLevel?: number;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): ColonySnapshot {
  const room = {
    name: roomName,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: controllerLevel,
      ticksToDowngrade: 10_000
    } as StructureController,
    energyAvailable,
    energyCapacityAvailable
  } as unknown as Room;

  return {
    room,
    spawns: [],
    energyAvailable,
    energyCapacityAvailable
  };
}

function makeOwnedRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn().mockReturnValue([])
  } as unknown as Room;
}

function makeVisibleExpansionRoom(
  roomName: string,
  {
    controller = {
      id: `${roomName}-controller` as Id<StructureController>,
      my: false,
      pos: { x: 25, y: 25, roomName }
    } as StructureController,
    sourceCount = 1,
    mineralType,
    hostileCreepCount = 0,
    hostileStructureCount = 0
  }: {
    controller?: StructureController;
    sourceCount?: number;
    mineralType?: string;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
  } = {}
): Room {
  return {
    name: roomName,
    controller,
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case FIND_SOURCES:
          return Array.from({ length: sourceCount }, (_value, index) => ({
            id: `${roomName}-source${index}`,
            pos: { x: 15 + index * 20, y: 25, roomName }
          }));
        case FIND_MINERALS:
          return mineralType
            ? [
                {
                  id: `${roomName}-mineral`,
                  mineralType,
                  density: 1,
                  pos: { x: 10, y: 10, roomName }
                }
              ]
            : [];
        case FIND_HOSTILE_CREEPS:
          return Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile${index}` }));
        case FIND_HOSTILE_STRUCTURES:
          return Array.from({ length: hostileStructureCount }, (_value, index) => ({
            id: `hostileStructure${index}`
          }));
        case FIND_MY_STRUCTURES:
        case FIND_MY_CONSTRUCTION_SITES:
          return [];
        default:
          return [];
      }
    })
  } as unknown as Room;
}

function makeTerrain(wallRatio: number): RoomTerrain {
  return {
    get: jest.fn((x: number, y: number) => {
      const normalized = ((x - 2) * 46 + (y - 2)) / (46 * 46);
      return normalized < wallRatio ? TERRAIN_MASK_WALL : 0;
    })
  } as unknown as RoomTerrain;
}

function getExpansionCandidateMemory(): Array<Record<string, unknown>> {
  return (
    ((Memory.territory ?? {}) as unknown as { expansionCandidates?: Array<Record<string, unknown>> })
      .expansionCandidates ?? []
  );
}

function getCandidate(
  report: ReturnType<typeof scoreExpansionCandidates>,
  roomName: string
): ReturnType<typeof scoreExpansionCandidates>['candidates'][number] {
  const candidate = report.candidates.find((entry) => entry.roomName === roomName);
  if (!candidate) {
    throw new Error(`Missing expansion candidate ${roomName}`);
  }

  return candidate;
}

function getScore(report: ReturnType<typeof scoreExpansionCandidates>, roomName: string): number {
  return getCandidate(report, roomName).score;
}
