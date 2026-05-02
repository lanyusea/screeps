import {
  buildEmergencyDefenderBody,
  buildEmergencyWorkerBody,
  buildTerritoryControllerBody,
  buildTerritoryControllerPressureBody,
  buildWorkerBody,
  getBodyCost
} from '../src/spawn/bodyBuilder';

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

  it('uses mid-capacity remainders for movement and logistics throughput', () => {
    expect(buildWorkerBody(450)).toEqual([...repeatWorkerPattern(2), 'move']);
    expect(buildWorkerBody(500)).toEqual([...repeatWorkerPattern(2), 'carry', 'move']);
    expect(buildWorkerBody(550)).toEqual([...repeatWorkerPattern(2), 'carry', 'move']);
    expect(buildWorkerBody(650)).toEqual([...repeatWorkerPattern(3), 'move']);
    expect(buildWorkerBody(700)).toEqual([...repeatWorkerPattern(3), 'carry', 'move']);
  });

  it('caps general-purpose worker bodies at 800 energy', () => {
    expect(buildWorkerBody(800)).toEqual(repeatWorkerPattern(4));
    expect(buildWorkerBody(10000)).toEqual(repeatWorkerPattern(4));
    expect(getBodyCost(buildWorkerBody(10000))).toBe(800);
  });

  it('returns an empty body when there is not enough energy for a worker set', () => {
    expect(buildWorkerBody(199)).toEqual([]);
  });

  it('builds only affordable worker parts within the safe cap', () => {
    for (const energyAvailable of [0, 199, 200, 201, 399, 400, 500, 550, 600, 700, 1000, 10000]) {
      const body = buildWorkerBody(energyAvailable);

      expect(body.length).toBeLessThanOrEqual(repeatWorkerPattern(4).length);
      expect(getBodyCost(body)).toBeLessThanOrEqual(energyAvailable);
      expect(getBodyCost(body)).toBeLessThanOrEqual(800);

      const completePatternPartCount = body.length - (body.length % WORKER_PATTERN.length);
      for (let i = 0; i < completePatternPartCount; i += WORKER_PATTERN.length) {
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

describe('buildEmergencyDefenderBody', () => {
  it('returns an empty body below one tough/attack/move set', () => {
    expect(buildEmergencyDefenderBody(139)).toEqual([]);
  });

  it('builds the smallest active defender body when affordable', () => {
    expect(buildEmergencyDefenderBody(140)).toEqual(['tough', 'attack', 'move']);
  });
});

describe('buildTerritoryControllerBody', () => {
  it('returns an empty body below one claim and move part', () => {
    expect(buildTerritoryControllerBody(649)).toEqual([]);
  });

  it('builds one claim and move part when affordable', () => {
    expect(buildTerritoryControllerBody(650)).toEqual(['claim', 'move']);
  });

  it('adds full work/carry/move triplets when enough energy is available', () => {
    expect(buildTerritoryControllerBody(800)).toEqual(['claim', 'move']);
    expect(buildTerritoryControllerBody(900)).toEqual(['claim', 'move', 'work', 'carry', 'move']);
    expect(buildTerritoryControllerBody(2000)).toEqual([
      'claim',
      'move',
      ...Array.from({ length: 5 }).flatMap(() => ['work', 'carry', 'move'] as const)
    ]);
  });

  it('keeps move parts in proportion to non-move parts as energy scales', () => {
    const body = buildTerritoryControllerBody(2000);
    const moveParts = body.filter((part) => part === 'move').length;
    const nonMoveParts = body.filter((part) => part !== 'move').length;
    const upgradePairs = body.filter((part) => part === 'work').length;

    expect(nonMoveParts).toBeLessThanOrEqual(moveParts * 3);
    expect(moveParts).toBe(1 + upgradePairs);
  });
});

describe('buildTerritoryControllerPressureBody', () => {
  it('returns an empty body below five claim/move pairs', () => {
    expect(buildTerritoryControllerPressureBody(3249)).toEqual([]);
  });

  it('builds five claim/move pairs when affordable', () => {
    expect(buildTerritoryControllerPressureBody(3250)).toEqual([
      'claim',
      'move',
      'claim',
      'move',
      'claim',
      'move',
      'claim',
      'move',
      'claim',
      'move'
    ]);
  });
});

describe('getBodyCost', () => {
  it.each(BODY_PART_COST_CASES)('prices %s at %i energy', (part, expectedCost) => {
    expect(getBodyCost([part])).toBe(expectedCost);
  });
});
