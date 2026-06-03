import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { refreshExpansionExecutorIntent } from '../src/territory/expansionExecutor';

describe('expansion executor', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
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
    delete (globalThis as { FIND_STRUCTURES?: number }).FIND_STRUCTURES;
    delete (globalThis as { STRUCTURE_TOWER?: StructureConstant }).STRUCTURE_TOWER;
    delete (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
    delete (globalThis as { TERRAIN_MASK_SWAMP?: number }).TERRAIN_MASK_SWAMP;
  });

  it('persists the highest-scored scouted expansion as a reserve target and reuses the active pipeline', () => {
    const colony = makeColony({ controllerLevel: 6 });
    const getRoomTerrain = jest.fn(() => makeTerrain(0));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 1),
        W3N1: makeExpansionRoom('W3N1', 'controller3' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '1': 'W2N1', '3': 'W3N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'next' }]),
        getRoomTerrain
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 100);

    expect(refreshExpansionExecutorIntent(colony, 100)).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1',
      controllerId: 'controller3'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'reserve',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller3'
      }
    ]);
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      status: 'active',
      stage: 'reserving',
      score: expect.any(Number),
      threshold: expect.any(Number)
    });
    expect(colony.room.memory.cachedExpansionSelection).toMatchObject({
      status: 'planned',
      targetRoom: 'W3N1'
    });

    getRoomTerrain.mockImplementation(() => {
      throw new Error('active expansion pipeline should avoid rescoring');
    });
    colony.energyAvailable = 1_299;
    (colony.room as Room & { energyAvailable: number }).energyAvailable = 1_299;
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 101;

    expect(refreshExpansionExecutorIntent(colony, 101)).toMatchObject({
      status: 'planned',
      targetRoom: 'W3N1'
    });
  });

  it('revalidates claim readiness before reusing a cached planned selection', () => {
    const colony = makeColony({ controllerLevel: 6 });
    const homeSources = makeSources('W1N1', 2);
    let hostileCreepCount = 0;
    (colony.room.find as jest.Mock).mockImplementation((findType: number) => {
      if (findType === FIND_SOURCES) {
        return homeSources;
      }
      if (findType === FIND_HOSTILE_CREEPS) {
        return Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile-${index}` }));
      }

      return [];
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 150,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 150);

    expect(refreshExpansionExecutorIntent(colony, 150)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });

    hostileCreepCount = 1;
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 151;

    expect(refreshExpansionExecutorIntent(colony, 151)).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
    expect(Memory.territory?.expansionPipelines?.W1N1).toMatchObject({
      status: 'aborted',
      abortReason: 'homeUnstable'
    });

    hostileCreepCount = 0;
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 152;

    expect(refreshExpansionExecutorIntent(colony, 152)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });
  });

  it('reuses a Seasonal RCL3 cached claim selection at the 800 energy cap', () => {
    const colony = makeColony({
      controllerLevel: 3,
      energyAvailable: 800,
      energyCapacityAvailable: 800
    });
    const targetRoom = makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2);
    targetRoom.controller = {
      ...targetRoom.controller,
      reservation: { username: 'me', ticksToEnd: 4_000 }
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 170,
      shard: { name: 'shardSeason', type: 'normal' } as Game['shard'],
      gcl: { level: 2, progress: 0, progressTotal: 0 } as GlobalControlLevel,
      rooms: {
        W1N1: colony.room,
        W2N1: targetRoom
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 170);

    expect(refreshExpansionExecutorIntent(colony, 170)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });

    Memory.territory = {
      ...Memory.territory,
      expansionPipelines: {}
    };
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 171;
    setSafeHomeThreat('W1N1', 171);

    expect(refreshExpansionExecutorIntent(colony, 171)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller2',
        postClaimBootstrapReserveEnergy: 150
      }
    ]);
  });

  it('does not reuse a cached claim selection after the cached target is disabled', () => {
    const colony = makeColony({
      controllerLevel: 3,
      energyAvailable: 800,
      energyCapacityAvailable: 800
    });
    const targetRoom = makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2);
    targetRoom.controller = {
      ...targetRoom.controller,
      reservation: { username: 'me', ticksToEnd: 4_000 }
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 180,
      shard: { name: 'shardSeason', type: 'normal' } as Game['shard'],
      gcl: { level: 2, progress: 0, progressTotal: 0 } as GlobalControlLevel,
      rooms: {
        W1N1: colony.room,
        W2N1: targetRoom
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 180);

    expect(refreshExpansionExecutorIntent(colony, 180)).toMatchObject({
      status: 'planned',
      targetRoom: 'W2N1'
    });

    Memory.territory = {
      ...Memory.territory,
      expansionPipelines: {},
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          enabled: false,
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller2' as Id<StructureController>
        }
      ],
      intents: []
    };
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { time: number }).time = 181;
    const replacementRoom = makeExpansionRoom('W3N1', 'controller3' as Id<StructureController>, 2);
    replacementRoom.controller = {
      ...replacementRoom.controller,
      reservation: { username: 'me', ticksToEnd: 4_000 }
    } as StructureController;
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { rooms: Record<string, Room> }).rooms = {
      W1N1: colony.room,
      W3N1: replacementRoom
    };
    ((globalThis as unknown as { Game: Partial<Game> }).Game.map as GameMap).describeExits = jest.fn(
      (roomName: string) => (roomName === 'W1N1' ? { '3': 'W3N1' } : {})
    );
    ((globalThis as unknown as { Game: Partial<Game> }).Game.map as GameMap).findRoute = jest.fn(() => [
      { exit: 3, room: 'W3N1' }
    ]);
    setSafeHomeThreat('W1N1', 181);

    const selection = refreshExpansionExecutorIntent(colony, 181);

    expect(selection).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W3N1'
    });
    expect(Memory.territory?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          colony: 'W1N1',
          roomName: 'W3N1',
          action: 'claim',
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller3',
          postClaimBootstrapReserveEnergy: 150
        })
      ])
    );
  });

  it('blocks claiming when recent threat memory was not refreshed on the current tick', () => {
    const colony = makeColony();
    Memory.defense = {
      colonyThreats: {
        updatedAt: 199,
        rooms: {
          W1N1: {
            roomName: 'W1N1',
            level: 'hostile_present',
            updatedAt: 199,
            hostileCreepCount: 1,
            hostileStructureCount: 0,
            damagedCriticalStructureCount: 0
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    expect(refreshExpansionExecutorIntent(colony, 200)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
  });

  it('blocks claiming when recent threat memory omits the colony room', () => {
    const colony = makeColony();
    Memory.defense = {
      colonyThreats: {
        updatedAt: 200,
        rooms: {
          W9N9: {
            roomName: 'W9N9',
            level: 'hostile_present',
            updatedAt: 200,
            hostileCreepCount: 1,
            hostileStructureCount: 0,
            damagedCriticalStructureCount: 0
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    expect(refreshExpansionExecutorIntent(colony, 200)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
  });

  it('requests scouting for the highest-ranked unseen expansion candidate', () => {
    const colony = makeColony();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 200,
      rooms: {
        W1N1: colony.room
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('W1N1', 200);

    expect(refreshExpansionExecutorIntent(colony, 200)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'insufficientEvidence'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.scoutAttempts?.['W1N1>W2N1']).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'requested',
      requestedAt: 200,
      updatedAt: 200,
      attemptCount: 1
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 200
      }
    ]);
  });

  it('requests configured E17S59 expansion scout targets', () => {
    const colony = makeColony({ roomName: 'E17S59' });
    Memory.territory = {
      expansionScoutTargets: [
        {
          colony: 'E17S59',
          roomName: 'E18S59',
          nearestOwnedRoom: 'E17S59',
          nearestOwnedRoomDistance: 1,
          routeDistance: 1,
          adjacentToOwnedRoom: true
        },
        {
          colony: 'E17S59',
          roomName: 'E17S60',
          nearestOwnedRoom: 'E17S58',
          nearestOwnedRoomDistance: 1,
          routeDistance: 2,
          adjacentToOwnedRoom: true
        }
      ]
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 821,
      rooms: {
        E17S59: colony.room
      },
      map: {
        describeExits: jest.fn(() => ({})),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('E17S59', 821);

    expect(refreshExpansionExecutorIntent(colony, 821)).toEqual({
      status: 'skipped',
      colony: 'E17S59',
      reason: 'insufficientEvidence'
    });
    expect(Memory.territory?.expansionCandidates?.[0]).toMatchObject({
      colony: 'E17S59',
      roomName: 'E18S59',
      evidenceStatus: 'insufficient-evidence',
      recommendedAction: 'scout',
      visible: false,
      adjacentToOwnedRoom: true,
      nearestOwnedRoom: 'E17S59',
      nearestOwnedRoomDistance: 1,
      routeDistance: 1
    });
    expect(Memory.territory?.scoutAttempts?.['E17S59>E18S59']).toMatchObject({
      colony: 'E17S59',
      roomName: 'E18S59',
      status: 'requested',
      requestedAt: 821,
      updatedAt: 821,
      attemptCount: 1
    });
    expect(Memory.territory?.scoutAttempts?.['E17S59>E17S60']).toMatchObject({
      colony: 'E17S59',
      roomName: 'E17S60',
      status: 'requested',
      requestedAt: 821,
      updatedAt: 821,
      attemptCount: 1
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'E17S59',
        targetRoom: 'E18S59',
        action: 'scout',
        status: 'planned',
        updatedAt: 821
      },
      {
        colony: 'E17S59',
        targetRoom: 'E17S60',
        action: 'scout',
        status: 'planned',
        updatedAt: 821
      }
    ]);
  });

  it('does not convert fresh E29N55 scout-only expansion intel into claim or reserve automation', () => {
    const colony = makeColony({ roomName: 'E29N55', structures: makeE29N55ReadyStructures() });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      },
      territory: {
        scoutIntel: {
          'E29N55>E29N54': makeScoutIntel('E29N55', 'E29N54', 968_700),
          'E29N55>E30N55': makeScoutIntel('E29N55', 'E30N55', 968_700)
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 968_900,
      rooms: {
        E29N55: colony.room
      },
      map: {
        describeExits: jest.fn(() => ({})),
        findRoute: jest.fn(() => [{ exit: 1, room: 'next' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('E29N55', 968_900);

    expect(refreshExpansionExecutorIntent(colony, 968_900)).toEqual({
      status: 'skipped',
      colony: 'E29N55',
      reason: 'insufficientEvidence'
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(
      (Memory.territory?.intents ?? []).filter((intent) => intent.action === 'claim' || intent.action === 'reserve')
    ).toEqual([]);
    expect(Memory.territory?.intents).toEqual(
      expect.arrayContaining([
        {
          colony: 'E29N55',
          targetRoom: 'E29N56',
          action: 'scout',
          status: 'planned',
          updatedAt: 968_900
        },
        {
          colony: 'E29N55',
          targetRoom: 'E28N55',
          action: 'scout',
          status: 'planned',
          updatedAt: 968_900
        },
        {
          colony: 'E29N55',
          targetRoom: 'E34N49',
          action: 'scout',
          status: 'planned',
          updatedAt: 968_900
        }
      ])
    );
    expect(Memory.territory?.intents).toHaveLength(3);
    expect(Memory.territory?.expansionPipelines).toEqual({});
    expect(Memory.territory?.expansionCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          colony: 'E29N55',
          roomName: 'E29N56',
          evidenceStatus: 'insufficient-evidence',
          recommendedAction: 'scout',
          scoutOnly: true
        })
      ])
    );
    expect(
      (Memory.territory?.expansionCandidates ?? [])
        .filter((candidate) => candidate.colony === 'E29N55' && candidate.scoutOnly === true)
        .map((candidate) => candidate.roomName)
    ).toEqual(expect.arrayContaining(['E29N56', 'E29N54', 'E28N55', 'E30N55']));
  });

  it('records an E29N56 energy-buffer block when scout-only evidence is sufficient but spending would break RCL5 buffer', () => {
    const colony = makeColony({
      roomName: 'E29N55',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_800,
      controllerLevel: 5,
      structures: makeE29N55ReadyStructures()
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      },
      territory: {
        scoutIntel: {
          'E29N55>E29N56': {
            ...makeScoutIntel('E29N55', 'E29N56', 968_950),
            sourceIds: ['source-E29N56-0'],
            sourceCount: 1,
            sourcePositions: [{ id: 'source-E29N56-0', x: 10, y: 20, accessPoints: 1 }],
            sourceAccessPoints: 1,
            mineral: { id: 'mineral-E29N56', mineralType: 'H' }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 968_951,
      rooms: {
        E29N55: colony.room
      },
      map: {
        describeExits: jest.fn(() => ({ '1': 'E29N56' })),
        findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 1, room: toRoom }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };
    setSafeHomeThreat('E29N55', 968_951);

    refreshExpansionExecutorIntent(colony, 968_951);

    expect(Memory.territory?.targets).toBeUndefined();
    expect(
      (Memory.territory?.intents ?? []).filter((intent) => intent.action === 'claim' || intent.action === 'reserve')
    ).toEqual([]);
    expect(Memory.territory?.expansionCandidates?.[0]).toMatchObject({
      colony: 'E29N55',
      roomName: 'E29N56',
      evidenceStatus: 'sufficient',
      scoutOnly: true,
      recommendedAction: 'scout',
      blockReason: 'energyBufferLow'
    });
  });

  it('skips and clears claim targets when the colony is not ready to bootstrap an expansion', () => {
    const colony = makeColony({ energyAvailable: 650, energyCapacityAvailable: 650 });
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller2' as Id<StructureController>
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'planned',
          updatedAt: 190,
          createdBy: 'nextExpansionScoring',
          controllerId: 'controller2' as Id<StructureController>
        }
      ]
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 300,
      rooms: {
        W1N1: colony.room,
        W2N1: makeExpansionRoom('W2N1', 'controller2' as Id<StructureController>, 2)
      },
      map: {
        describeExits: jest.fn((roomName: string) => (roomName === 'W1N1' ? { '3': 'W2N1' } : {})),
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }]),
        getRoomTerrain: jest.fn(() => makeTerrain(0))
      } as unknown as GameMap
    };

    expect(refreshExpansionExecutorIntent(colony, 300)).toEqual({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'unmetPreconditions'
    });
    expect(Memory.territory?.targets ?? []).toEqual([]);
    expect(Memory.territory?.intents ?? []).toEqual([]);
  });
});

function makeColony({
  roomName = 'W1N1',
  energyAvailable = 1_300,
  energyCapacityAvailable = 1_300,
  controllerLevel = 3,
  spawns,
  structures = []
}: {
  roomName?: string;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  controllerLevel?: number;
  spawns?: StructureSpawn[];
  structures?: AnyStructure[];
} = {}): ColonySnapshot {
  const colonySpawns = spawns ?? [makeActiveSpawn(`spawn-${roomName}`)];
  const room = {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: controllerLevel,
      ticksToDowngrade: 10_000
    } as StructureController,
    memory: {},
    find: jest.fn((findType: number) => {
      if (findType === FIND_SOURCES) {
        return makeSources(roomName, 2);
      }

      if (findType === FIND_STRUCTURES) {
        return structures;
      }

      return [];
    })
  } as unknown as Room & { memory: RoomMemory };

  return {
    room,
    spawns: colonySpawns,
    energyAvailable,
    energyCapacityAvailable,
    memory: room.memory
  };
}

function makeE29N55ReadyStructures(): AnyStructure[] {
  return [
    makeStructure('spawn1', 'spawn', 17, 24, true),
    makeStructure('spawn-rampart', 'rampart', 17, 24, true),
    makeStructure('spawn-wall-a', 'constructedWall', 16, 23),
    makeStructure('spawn-wall-b', 'constructedWall', 18, 23),
    makeStructure('spawn-wall-c', 'constructedWall', 16, 25),
    makeStructure('spawn-wall-d', 'constructedWall', 18, 25),
    makeStructure('tower1', 'tower', 20, 20, true)
  ];
}

function makeStructure(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  my?: boolean
): AnyStructure {
  return {
    id,
    structureType,
    my,
    pos: { x, y, roomName: 'E29N55' } as RoomPosition
  } as AnyStructure;
}

function makeActiveSpawn(name: string): StructureSpawn {
  return {
    id: `${name}-id` as Id<StructureSpawn>,
    name,
    spawning: null,
    isActive: jest.fn(() => true)
  } as unknown as StructureSpawn;
}

function makeExpansionRoom(
  roomName: string,
  controllerId: Id<StructureController>,
  sourceCount: number
): Room {
  const sources = makeSources(roomName, sourceCount);
  return {
    name: roomName,
    controller: {
      id: controllerId,
      my: false,
      pos: makePosition(25, 25, roomName)
    } as StructureController,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: jest.fn((findType: number) => {
      if (findType === FIND_SOURCES) {
        return sources;
      }

      return [];
    })
  } as unknown as Room;
}

function makeScoutIntel(
  colony: string,
  roomName: string,
  updatedAt: number
): TerritoryScoutIntelMemory {
  return {
    colony,
    roomName,
    updatedAt,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false
    },
    sourceIds: [`source-${roomName}-0`, `source-${roomName}-1`],
    sourceCount: 2,
    sourcePositions: [
      { id: `source-${roomName}-0`, x: 10, y: 20, accessPoints: 8 },
      { id: `source-${roomName}-1`, x: 20, y: 30, accessPoints: 8 }
    ],
    sourceAccessPoints: 8,
    controllerSourceRange: 12,
    terrain: {
      walkableRatio: 1,
      swampRatio: 0,
      wallRatio: 0
    },
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    hostileSpawnCount: 0
  };
}

function makeSources(roomName: string, count: number): Source[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${roomName}-source${index}` as Id<Source>,
    pos: makePosition(10 + index, 10, roomName)
  })) as Source[];
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function makeTerrain(mask: number): RoomTerrain {
  return {
    get: jest.fn(() => mask)
  } as unknown as RoomTerrain;
}

function setSafeHomeThreat(roomName: string, updatedAt: number): void {
  Memory.defense = {
    ...(Memory.defense ?? {}),
    colonyThreats: {
      updatedAt,
      rooms: {
        ...(Memory.defense?.colonyThreats?.rooms ?? {}),
        [roomName]: {
          roomName,
          level: 'none',
          updatedAt,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          damagedCriticalStructureCount: 0
        }
      }
    }
  };
}
