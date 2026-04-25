import { buildEmergencyWorkerBody, buildWorkerBody, getBodyCost } from '../src/spawn/bodyBuilder';

const WORKER_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move'];

const BODY_PART_COST_CASES: Array<[BodyPartConstant, number]> = [
  ['move', 50],
  ['work', 100],
  ['carry', 50],
  ['attack', 80],
  ['ranged_attack', 150],
  ['heal', 250],
  ['claim', 600],
  ['tough', 10]
];

describe('buildWorkerBody', () => {
  it('builds the smallest worker body at 200 energy', () => {
    expect(buildWorkerBody(200)).toEqual(WORKER_PATTERN);
  });

  it('scales worker bodies by repeating work/carry/move sets', () => {
    expect(buildWorkerBody(400)).toEqual([...WORKER_PATTERN, ...WORKER_PATTERN]);
  });

  it('returns an empty body when there is not enough energy for a worker set', () => {
    expect(buildWorkerBody(199)).toEqual([]);
  });

  it('builds only complete affordable worker patterns within the creep part limit', () => {
    for (const energyAvailable of [0, 199, 200, 201, 399, 400, 1000, 10000]) {
      const body = buildWorkerBody(energyAvailable);

      expect(body.length).toBeLessThanOrEqual(50);
      expect(body.length % WORKER_PATTERN.length).toBe(0);
      expect(getBodyCost(body)).toBeLessThanOrEqual(energyAvailable);

      for (let i = 0; i < body.length; i += WORKER_PATTERN.length) {
        expect(body.slice(i, i + WORKER_PATTERN.length)).toEqual(WORKER_PATTERN);
      }
    }
  });
});

describe('buildEmergencyWorkerBody', () => {
  it('returns an empty body below the worker pattern energy cost', () => {
    expect(buildEmergencyWorkerBody(199)).toEqual([]);
  });

  it('returns one worker pattern at the worker pattern energy cost', () => {
    expect(buildEmergencyWorkerBody(200)).toEqual(WORKER_PATTERN);
  });
});

describe('getBodyCost', () => {
  it.each(BODY_PART_COST_CASES)('prices %s at %i energy', (part, expectedCost) => {
    expect(getBodyCost([part])).toBe(expectedCost);
  });
});
