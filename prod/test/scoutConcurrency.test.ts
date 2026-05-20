import { isTerritoryScoutAssignmentAvailableForCreep } from '../src/territory/scoutConcurrency';

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
