import {
  isTerritoryScoutAssignmentAvailableForCreep,
  shouldSpawnTerritoryScoutForTarget
} from '../src/territory/scoutConcurrency';

describe('territory scout concurrency', () => {
  beforeEach(() => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1000,
      creeps: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('caches the scout creep scan for a tick while reflecting same-tick assignments', () => {
    const scoutA = makeScout('ScoutA', { targetRoom: 'E28N54', action: 'scout' });
    const scoutB = makeScout('ScoutB');
    const scoutC = makeScout('ScoutC');
    const creeps = {
      ScoutA: scoutA,
      ScoutB: scoutB,
      ScoutC: scoutC,
      Worker1: {
        name: 'Worker1',
        memory: { role: 'worker', colony: 'E29N55' }
      } as unknown as Creep
    };
    let scanCount = 0;

    (Game as Partial<Game>).creeps = new Proxy(creeps, {
      ownKeys(target) {
        scanCount += 1;
        return Reflect.ownKeys(target);
      }
    }) as Game['creeps'];

    expect(isTerritoryScoutAssignmentAvailableForCreep('E29N55', 'E29N53', 'ScoutB', 1000)).toBe(true);

    scoutB.memory.territory = { targetRoom: 'E29N53', action: 'scout' };

    expect(isTerritoryScoutAssignmentAvailableForCreep('E29N55', 'E29N53', 'ScoutC', 1000)).toBe(false);
    expect(scanCount).toBe(1);
  });

  it('blocks timed-out scout reassignment when active assignments are already at the cap', () => {
    Memory.territory = {
      scoutAttempts: {
        'E29N55>E29N53': {
          colony: 'E29N55',
          roomName: 'E29N53',
          status: 'requested',
          requestedAt: 1000,
          updatedAt: 1000,
          attemptCount: 1
        }
      }
    };
    (Game as Partial<Game>).creeps = {
      ScoutA: makeScout('ScoutA', { targetRoom: 'E28N54', action: 'scout' }),
      ScoutB: makeScout('ScoutB', { targetRoom: 'E29N54', action: 'scout' })
    };

    expect(isTerritoryScoutAssignmentAvailableForCreep('E29N55', 'E29N53', 'ScoutC', 2501)).toBe(false);
  });

  it('allows timed-out scout reassignment while active assignments remain below the cap', () => {
    Memory.territory = {
      scoutAttempts: {
        'E29N55>E29N53': {
          colony: 'E29N55',
          roomName: 'E29N53',
          status: 'requested',
          requestedAt: 1000,
          updatedAt: 1000,
          attemptCount: 1
        }
      }
    };
    (Game as Partial<Game>).creeps = {
      ScoutA: makeScout('ScoutA', { targetRoom: 'E28N54', action: 'scout' })
    };

    expect(isTerritoryScoutAssignmentAvailableForCreep('E29N55', 'E29N53', 'ScoutB', 2501)).toBe(true);
  });

  it('blocks timed-out scout retries when active scouts are already at the cap', () => {
    Memory.territory = {
      scoutAttempts: {
        'E29N55>E29N53': {
          colony: 'E29N55',
          roomName: 'E29N53',
          status: 'requested',
          requestedAt: 1000,
          updatedAt: 1000,
          attemptCount: 1
        }
      }
    };

    expect(
      shouldSpawnTerritoryScoutForTarget(
        'E29N55',
        'E29N53',
        { worker: 4, scout: 2, scoutsByTargetRoom: { E28N54: 1, E29N54: 1 } },
        2501
      )
    ).toBe(false);
  });

  it('allows a timed-out scout retry while active scouts remain below the cap', () => {
    Memory.territory = {
      scoutAttempts: {
        'E29N55>E29N53': {
          colony: 'E29N55',
          roomName: 'E29N53',
          status: 'requested',
          requestedAt: 1000,
          updatedAt: 1000,
          attemptCount: 1
        }
      }
    };

    expect(
      shouldSpawnTerritoryScoutForTarget(
        'E29N55',
        'E29N53',
        { worker: 4, scout: 1, scoutsByTargetRoom: { E29N53: 1 } },
        2501
      )
    ).toBe(true);
  });
});

function makeScout(name: string, territory?: CreepTerritoryMemory): Creep {
  return {
    name,
    ticksToLive: 1000,
    memory: {
      role: 'scout',
      colony: 'E29N55',
      ...(territory ? { territory } : {})
    }
  } as unknown as Creep;
}
