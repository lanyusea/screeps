import { countCreepsByRole } from '../src/creeps/roleCounts';

describe('countCreepsByRole', () => {
  it('counts creeps by memory role and colony', () => {
    const worker = { memory: { role: 'worker', colony: 'W1N1' } } as Creep;
    const otherColonyWorker = { memory: { role: 'worker', colony: 'W2N2' } } as Creep;
    const unassigned = { memory: {} } as Creep;

    expect(countCreepsByRole([worker, otherColonyWorker, unassigned], 'W1N1')).toEqual({
      worker: 1
    });
  });
});
