import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  SCORE_COLLECTOR_ROLE,
  runScoreCollector,
  selectSeasonScoreCollectorSpawnDemand
} from '../src/season/scoreCollection';

describe('season scoreCollector swarm', () => {
  beforeEach(() => {
    (globalThis as unknown as { ERR_NO_PATH: number }).ERR_NO_PATH = -2;
    (globalThis as unknown as { FIND_SCORE: number }).FIND_SCORE = 42;
    (globalThis as unknown as { RoomPosition: new (x: number, y: number, roomName: string) => RoomPosition })
      .RoomPosition = class {
        public constructor(
          public readonly x: number,
          public readonly y: number,
          public readonly roomName: string
        ) {}
      } as unknown as new (x: number, y: number, roomName: string) => RoomPosition;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      creeps: {},
      shard: { name: 'shardSeason' } as Game['shard']
    };
  });

  it('selects bounded Seasonal candidate rooms and advances past an active room assignment', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      ...Game,
      map: {
        describeExits: jest.fn().mockReturnValue({
          1: 'W1N2',
          3: 'W2N1'
        })
      } as unknown as GameMap
    };
    Memory.territory = {
      targets: [
        { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' },
        { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }
      ],
      expansionScoutTargets: [
        {
          colony: 'W1N1',
          roomName: 'W4N1',
          nearestOwnedRoom: 'W1N1',
          nearestOwnedRoomDistance: 1,
          routeDistance: 2,
          adjacentToOwnedRoom: false,
          scoutOnly: true
        }
      ]
    };
    const activeHomeCollector = makeScoreCollector('CollectorHome', 'W1N1', 'W1N1', 500, 99);
    setGameCreeps({ CollectorHome: activeHomeCollector });

    const demand = selectSeasonScoreCollectorSpawnDemand(makeColonySnapshot('W1N1'), 100);

    expect(demand).toMatchObject({
      homeRoom: 'W1N1',
      targetRoom: 'W1N2'
    });
    expect(Memory.seasonScoreCollectors).toMatchObject({
      activeCount: 1,
      candidateRooms: ['W1N1', 'W1N2', 'W2N1', 'W3N1', 'W4N1'],
      nextSpawnTargetRoom: 'W1N2'
    });
  });

  it('does not select scoreCollector spawn demand on persistent worlds', () => {
    setRuntimeShard('shard3');

    expect(selectSeasonScoreCollectorSpawnDemand(makeColonySnapshot('W1N1'), 101)).toBeNull();
    expect(Memory.seasonScoreCollectors).toMatchObject({
      activeCount: 0,
      blocker: 'non_seasonal'
    });
  });

  it('suppresses duplicate target rooms but replaces stale or TTL-impossible collectors', () => {
    setGameCreeps({
      ActiveCollector: makeScoreCollector('ActiveCollector', 'W1N1', 'W1N1', 500, 119)
    });

    expect(selectSeasonScoreCollectorSpawnDemand(makeColonySnapshot('W1N1'), 120)).toBeNull();
    expect(Memory.seasonScoreCollectors).toMatchObject({
      blocker: 'all_targets_covered',
      targetRooms: ['W1N1']
    });

    setGameCreeps({
      ExpiringCollector: makeScoreCollector('ExpiringCollector', 'W1N1', 'W1N1', 20, 120)
    });

    expect(selectSeasonScoreCollectorSpawnDemand(makeColonySnapshot('W1N1'), 121)).toMatchObject({
      targetRoom: 'W1N1',
      staleReason: 'collector_ttl_insufficient'
    });

    setGameCreeps({
      StaleCollector: makeScoreCollector('StaleCollector', 'W1N1', 'W1N1', 500, 1)
    });

    expect(selectSeasonScoreCollectorSpawnDemand(makeColonySnapshot('W1N1'), 200)).toMatchObject({
      targetRoom: 'W1N1',
      staleReason: 'collector_stale'
    });

    const unreachableCollector = makeScoreCollector('UnreachableCollector', 'W1N1', 'W1N1', 500, 201);
    unreachableCollector.memory.seasonScoreCollector = {
      ...(unreachableCollector.memory.seasonScoreCollector as CreepSeasonScoreCollectorMemory),
      blocker: 'target_unreachable'
    };
    setGameCreeps({ UnreachableCollector: unreachableCollector });

    expect(selectSeasonScoreCollectorSpawnDemand(makeColonySnapshot('W1N1'), 202)).toBeNull();
    expect(Memory.seasonScoreCollectors).toMatchObject({
      activeCount: 1,
      blocker: 'all_targets_covered',
      targetRooms: ['W1N1']
    });
    expect(Memory.seasonScoreCollectors).not.toHaveProperty('nextSpawnTargetRoom');
    expect(Memory.seasonScoreCollectors).not.toHaveProperty('staleReason');
  });

  it('runs to visible Score at exact range 0 before continuing its room assignment', () => {
    const score = makeScoreItem('score1', 'W1N1');
    const room = makeRoom('W1N1', [score]);
    const moveTo = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'ScoreCollector1',
      memory: makeScoreCollectorMemory('W1N1', 'W2N1', 100),
      room,
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'score1' ? 3 : 50))
      },
      moveTo
    } as unknown as Creep;
    setGameCreeps({ ScoreCollector1: creep });
    setGameObjectsById([score]);

    runScoreCollector(creep);

    expect(creep.memory.task).toEqual({ type: 'collectScore', targetId: 'score1' });
    expect(moveTo).toHaveBeenCalledWith(score, { range: 0 });
    expect(creep.memory.seasonScoreCollector).toMatchObject({
      targetRoom: 'W2N1',
      state: 'collecting',
      visibleScoreCount: 1,
      assignedScoreTargetId: 'score1'
    });
  });

  it('travels toward its assigned target room and holds there when no Score is visible', () => {
    const moveTo = jest.fn().mockReturnValue(0);
    const travellingCollector = {
      name: 'TravellingCollector',
      memory: makeScoreCollectorMemory('W1N1', 'W2N1', 100),
      room: makeRoom('W1N1'),
      pos: { getRangeTo: jest.fn().mockReturnValue(20) },
      moveTo
    } as unknown as Creep;
    setGameCreeps({ TravellingCollector: travellingCollector });
    setGameObjectsById([]);

    runScoreCollector(travellingCollector);

    expect(moveTo.mock.calls[0]?.[0]).toMatchObject({ x: 25, y: 25, roomName: 'W2N1' });
    expect(travellingCollector.memory.task).toBeUndefined();
    expect(travellingCollector.memory.seasonScoreCollector).toMatchObject({
      state: 'travelling',
      targetRoom: 'W2N1',
      visibleScoreCount: 0
    });

    const holdMoveTo = jest.fn().mockReturnValue(0);
    const holdingCollector = {
      name: 'HoldingCollector',
      memory: makeScoreCollectorMemory('W1N1', 'W2N1', 100),
      room: makeRoom('W2N1'),
      pos: { getRangeTo: jest.fn().mockReturnValue(4) },
      moveTo: holdMoveTo
    } as unknown as Creep;
    setGameCreeps({ HoldingCollector: holdingCollector });

    runScoreCollector(holdingCollector);

    expect(holdMoveTo.mock.calls[0]?.[0]).toMatchObject({ x: 25, y: 25, roomName: 'W2N1' });
    expect(holdingCollector.memory.seasonScoreCollector).toMatchObject({
      state: 'holding',
      targetRoom: 'W2N1',
      visibleScoreCount: 0
    });
  });

  function makeColonySnapshot(roomName: string): ColonySnapshot {
    const room = makeRoom(roomName);
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    return {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      spawnEnergyBudget: 300
    };
  }

  function makeRoom(roomName: string, scoreItems: Array<RoomObject & { id: string }> = []): Room {
    return {
      name: roomName,
      find: jest.fn((type: number) =>
        type === (globalThis as unknown as { FIND_SCORE: number }).FIND_SCORE ? scoreItems : []
      )
    } as unknown as Room;
  }

  function makeScoreItem(id: string, roomName: string): RoomObject & { id: string; score: number; scoreType: string } {
    return {
      id,
      pos: { x: 12, y: 10, roomName } as RoomPosition,
      score: 100,
      scoreType: 'score'
    } as unknown as RoomObject & { id: string; score: number; scoreType: string };
  }

  function makeScoreCollector(
    name: string,
    homeRoom: string,
    targetRoom: string,
    ticksToLive: number,
    updatedAt: number
  ): Creep {
    return {
      name,
      ticksToLive,
      memory: makeScoreCollectorMemory(homeRoom, targetRoom, updatedAt),
      moveTo: jest.fn(),
      room: makeRoom(homeRoom)
    } as unknown as Creep;
  }

  function makeScoreCollectorMemory(homeRoom: string, targetRoom: string, updatedAt: number): CreepMemory {
    return {
      role: SCORE_COLLECTOR_ROLE,
      colony: homeRoom,
      seasonScoreCollector: {
        homeRoom,
        targetRoom,
        assignedAt: 90,
        updatedAt
      }
    } as unknown as CreepMemory;
  }

  function setRuntimeShard(name: string): void {
    const globalScope = globalThis as unknown as { Game?: Partial<Game> };
    globalScope.Game = {
      ...(globalScope.Game ?? {}),
      shard: { name } as Game['shard']
    };
  }

  function setGameCreeps(creeps: Record<string, Creep>): void {
    const globalScope = globalThis as unknown as { Game?: Partial<Game> };
    globalScope.Game = {
      ...(globalScope.Game ?? {}),
      creeps
    };
  }

  function setGameObjectsById(objects: Array<{ id: string }>): void {
    const objectsById = new Map(objects.map((object) => [String(object.id), object]));
    const globalScope = globalThis as unknown as { Game?: Partial<Game> };
    globalScope.Game = {
      ...(globalScope.Game ?? {}),
      getObjectById: jest.fn((id: string) => objectsById.get(String(id)) ?? null) as unknown as Game['getObjectById']
    };
  }
});
