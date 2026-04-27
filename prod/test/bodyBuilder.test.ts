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

function repeatWorkerPattern(patternCount: number): BodyPartConstant[] {
  return Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
}

describe('buildWorkerBody', () => {
  it('builds the smallest worker body at 200 energy', () => {
    expect(buildWorkerBody(200)).toEqual(WORKER_PATTERN);
  });

  it('scales intermediate worker bodies by repeating work/carry/move sets', () => {
    expect(buildWorkerBody(600)).toEqual(repeatWorkerPattern(3));
  });

  it('caps general-purpose worker bodies at 800 energy', () => {
    expect(buildWorkerBody(800)).toEqual(repeatWorkerPattern(4));
    expect(buildWorkerBody(10000)).toEqual(repeatWorkerPattern(4));
    expect(getBodyCost(buildWorkerBody(10000))).toBe(800);
  });

  it('returns an empty body when there is not enough energy for a worker set', () => {
    expect(buildWorkerBody(199)).toEqual([]);
  });

  it('builds only complete affordable worker patterns within the safe cap', () => {
    for (const energyAvailable of [0, 199, 200, 201, 399, 400, 1000, 10000]) {
      const body = buildWorkerBody(energyAvailable);

      expect(body.length).toBeLessThanOrEqual(repeatWorkerPattern(4).length);
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
