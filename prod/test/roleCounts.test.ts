import { countCreepsByRole, WORKER_REPLACEMENT_TICKS_TO_LIVE } from '../src/creeps/roleCounts';

describe('countCreepsByRole', () => {
  it('counts creeps by memory role and colony', () => {
    const worker = { memory: { role: 'worker', colony: 'W1N1' } } as Creep;
    const claimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } }
    } as Creep;
    const scout = {
      memory: { role: 'scout', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'scout' } }
    } as Creep;
    const otherColonyWorker = { memory: { role: 'worker', colony: 'W2N2' } } as Creep;
    const unassigned = { memory: {} } as Creep;

    expect(countCreepsByRole([worker, claimer, scout, otherColonyWorker, unassigned], 'W1N1')).toEqual({
      worker: 1,
      claimer: 1,
      claimersByTargetRoom: { W2N1: 1 },
      scout: 1,
      scoutsByTargetRoom: { W1N2: 1 }
    });
  });

  it('tracks replacement-aware worker capacity at the deterministic TTL threshold', () => {
    const healthyWorker = {
      memory: { role: 'worker', colony: 'W1N1' },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1
    } as Creep;
    const mockWorkerWithoutLifetime = { memory: { role: 'worker', colony: 'W1N1' } } as Creep;
    const spawningWorker = {
      memory: { role: 'worker', colony: 'W1N1' },
      spawning: true
    } as Creep;
    const expiringWorker = {
      memory: { role: 'worker', colony: 'W1N1' },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE
    } as Creep;
    const otherColonyWorker = {
      memory: { role: 'worker', colony: 'W2N2' },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1
    } as Creep;
    const unassignedWorker = {
      memory: { role: 'worker' },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1
    } as Creep;

    expect(
      countCreepsByRole(
        [
          healthyWorker,
          mockWorkerWithoutLifetime,
          spawningWorker,
          expiringWorker,
          otherColonyWorker,
          unassignedWorker
        ],
        'W1N1'
      )
    ).toEqual({
      worker: 4,
      workerCapacity: 3,
      claimer: 0,
      claimersByTargetRoom: {}
    });
  });

  it('excludes colony claimers at replacement age from territory capacity', () => {
    const healthyClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'claim' } },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1
    } as Creep;
    const expiringClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'claim' } },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE
    } as Creep;
    const foreignClaimer = {
      memory: { role: 'claimer', colony: 'W2N2', territory: { targetRoom: 'W2N1', action: 'claim' } },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1
    } as Creep;

    expect(countCreepsByRole([healthyClaimer, expiringClaimer, foreignClaimer], 'W1N1')).toEqual({
      worker: 0,
      claimer: 1,
      claimersByTargetRoom: { W2N1: 1 }
    });
  });
});
