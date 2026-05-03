import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  buildRuntimeExpansionCandidateReport,
  maxRoomsForRcl,
  refreshNextExpansionTargetSelection,
  scoreExpansionCandidates,
  type ExpansionCandidateInput,
  type ExpansionScoringInput
} from '../src/territory/expansionScoring';
import { planTerritoryIntent } from '../src/territory/territoryPlanner';

describe('next expansion scoring', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
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
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
    delete (globalThis as { FIND_MY_CONSTRUCTION_SITES?: number }).FIND_MY_CONSTRUCTION_SITES;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
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
      controllerSourceRange: 10,
      terrain: {
        walkableRatio: 0.9,
        swampRatio: 0,
        wallRatio: 0.1
      }
    });
    expect(findRoute).toHaveBeenCalledWith('W1N1', 'W3N1');
    expect(findRoute).toHaveBeenCalledWith('W2N1', 'W3N1');
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
    [3, 2],
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
        ownedRoomCount: 2
      })
    );

    expect(refreshNextExpansionTargetSelection(colony, report, 210)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('leaves reserve intent planning available when the next expansion claim gate is at its room limit', () => {
    const colony = makeSafeColony({ controllerLevel: 2 });
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
        controllerLevel: 2,
        ownedRoomCount: 1
      })
    );

    expect(report.next?.preconditions).toContain(
      'limit expansion to 1 owned rooms for current controller level'
    );
    expect(planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 211)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
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
        ownedRoomCount: 2
      })
    );

    expect(refreshNextExpansionTargetSelection(colony, report, 212)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
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
    controllerLevel: 3,
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
    controllerSourceRange: 8,
    terrain: { walkableRatio: 0.85, swampRatio: 0.1, wallRatio: 0.15 },
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    ...overrides
  };
}

function makeSafeColony({
  controllerLevel = 3
}: {
  controllerLevel?: number;
} = {}): ColonySnapshot {
  const room = {
    name: 'W1N1',
    controller: {
      my: true,
      owner: { username: 'me' },
      level: controllerLevel,
      ticksToDowngrade: 10_000
    } as StructureController,
    energyAvailable: 650,
    energyCapacityAvailable: 650
  } as unknown as Room;

  return {
    room,
    spawns: [],
    energyAvailable: 650,
    energyCapacityAvailable: 650
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
    hostileCreepCount = 0,
    hostileStructureCount = 0
  }: {
    controller?: StructureController;
    sourceCount?: number;
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
