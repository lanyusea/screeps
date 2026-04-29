import { countCreepsByRole, WORKER_REPLACEMENT_TICKS_TO_LIVE } from '../src/creeps/roleCounts';

describe('countCreepsByRole', () => {
  it('counts creeps by memory role and colony', () => {
    const worker = { memory: { role: 'worker', colony: 'W1N1' } } as Creep;
    const claimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } },
      body: [{ type: 'claim', hits: 100 }]
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
      claimersByTargetRoomAction: { reserve: { W2N1: 1 } },
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
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1,
      body: [{ type: 'claim', hits: 100 }]
    } as Creep;
    const expiringClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'claim' } },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE,
      body: [{ type: 'claim', hits: 100 }]
    } as Creep;
    const foreignClaimer = {
      memory: { role: 'claimer', colony: 'W2N2', territory: { targetRoom: 'W2N1', action: 'claim' } },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1,
      body: [{ type: 'claim', hits: 100 }]
    } as Creep;

    expect(countCreepsByRole([healthyClaimer, expiringClaimer, foreignClaimer], 'W1N1')).toEqual({
      worker: 0,
      claimer: 1,
      claimersByTargetRoom: { W2N1: 1 },
      claimersByTargetRoomAction: { claim: { W2N1: 1 } }
    });
  });

  it('excludes claimers with no active CLAIM parts from territory capacity', () => {
    const damagedClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } },
      getActiveBodyparts: jest.fn().mockReturnValue(0)
    } as unknown as Creep;
    const healthyClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W3N1', action: 'reserve' } },
      getActiveBodyparts: jest.fn().mockReturnValue(1)
    } as unknown as Creep;

    expect(countCreepsByRole([damagedClaimer, healthyClaimer], 'W1N1')).toEqual({
      worker: 0,
      claimer: 1,
      claimersByTargetRoom: { W3N1: 1 },
      claimersByTargetRoomAction: { reserve: { W3N1: 1 } }
    });
  });

  it('excludes claimers with missing or malformed body data from territory capacity', () => {
    const missingBodyClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } }
    } as Creep;
    const malformedBodyClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W3N1', action: 'reserve' } },
      body: [null, { type: 'claim' }, { type: 'claim', hits: 0 }, { type: 'work', hits: 100 }]
    } as unknown as Creep;
    const healthyClaimer = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W4N1', action: 'reserve' } },
      body: [{ type: 'claim', hits: 100 }]
    } as Creep;

    expect(countCreepsByRole([missingBodyClaimer, malformedBodyClaimer, healthyClaimer], 'W1N1')).toEqual({
      worker: 0,
      claimer: 1,
      claimersByTargetRoom: { W4N1: 1 },
      claimersByTargetRoomAction: { reserve: { W4N1: 1 } }
    });
  });
});
