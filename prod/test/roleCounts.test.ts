import { countCreepsByRole, WORKER_REPLACEMENT_TICKS_TO_LIVE } from '../src/creeps/roleCounts';

describe('countCreepsByRole', () => {
  it('counts creeps by memory role and colony', () => {
    const worker = { memory: { role: 'worker', colony: 'W1N1' } } as Creep;
    const otherColonyWorker = { memory: { role: 'worker', colony: 'W2N2' } } as Creep;
    const unassigned = { memory: {} } as Creep;

    expect(countCreepsByRole([worker, otherColonyWorker, unassigned], 'W1N1')).toEqual({
      worker: 1
    });
  });

  it('excludes colony workers at replacement age from steady-state capacity', () => {
    const healthyWorker = {
      memory: { role: 'worker', colony: 'W1N1' },
      ticksToLive: WORKER_REPLACEMENT_TICKS_TO_LIVE + 1
    } as Creep;
    const mockWorkerWithoutLifetime = { memory: { role: 'worker', colony: 'W1N1' } } as Creep;
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
        [healthyWorker, mockWorkerWithoutLifetime, expiringWorker, otherColonyWorker, unassignedWorker],
        'W1N1'
      )
    ).toEqual({
      worker: 2
    });
  });
});
