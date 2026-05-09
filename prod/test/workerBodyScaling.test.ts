import {
  buildScaledWorkerBody,
  getScaledWorkerBodyCost,
  WORKER_BODY_SCALING_PROFILES
} from '../src/economy/worker-body-scaling';

describe('buildScaledWorkerBody', () => {
  it('selects worker bodies from the configured room-capacity profiles', () => {
    expect(buildScaledWorkerBody(199)).toEqual(['work', 'carry', 'move']);
    expect(buildScaledWorkerBody(300)).toEqual(['work', 'work', 'carry', 'move']);
    expect(buildScaledWorkerBody(549)).toEqual(['work', 'work', 'carry', 'move']);
    expect(buildScaledWorkerBody(550)).toEqual(['work', 'work', 'carry', 'carry', 'move', 'move']);
    expect(buildScaledWorkerBody(800)).toEqual([
      'work',
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move',
      'move'
    ]);
  });

  it('falls back to the largest affordable scaled body when spawn energy is still refilling', () => {
    expect(buildScaledWorkerBody(800, { energyAvailable: 250 })).toEqual(['work', 'carry', 'move']);
    expect(buildScaledWorkerBody(800, { energyAvailable: 300 })).toEqual(['work', 'work', 'carry', 'move']);
    expect(buildScaledWorkerBody(800, { energyAvailable: 500 })).toEqual([
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move'
    ]);
  });

  it('uses the emergency fallback for dangerous rooms below 300 current energy', () => {
    expect(buildScaledWorkerBody(800, { energyAvailable: 250, emergency: true })).toEqual([
      'work',
      'carry',
      'move'
    ]);
    expect(buildScaledWorkerBody(800, { energyAvailable: 199, emergency: true })).toEqual([]);
  });

  it('caps early worker recovery bodies so small colonies regain coverage before throughput', () => {
    expect(buildScaledWorkerBody(800, { currentWorkerCount: 0, energyAvailable: 800 })).toEqual([
      'work',
      'carry',
      'move'
    ]);
    expect(buildScaledWorkerBody(800, { currentWorkerCount: 1, energyAvailable: 800 })).toEqual([
      'work',
      'work',
      'carry',
      'move'
    ]);
    expect(buildScaledWorkerBody(800, { currentWorkerCount: 2, energyAvailable: 800 })).toEqual([
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move'
    ]);
    expect(buildScaledWorkerBody(800, { currentWorkerCount: 3, energyAvailable: 800 })).toEqual([
      'work',
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move',
      'move'
    ]);
  });

  it('respects controller-level gates when controller state is available', () => {
    expect(buildScaledWorkerBody(800, { controllerLevel: 2, currentWorkerCount: 3, energyAvailable: 800 })).toEqual([
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move'
    ]);
    expect(buildScaledWorkerBody(800, { controllerLevel: 3, currentWorkerCount: 3, energyAvailable: 800 })).toEqual([
      'work',
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move',
      'move'
    ]);
  });

  it('keeps profile bodies affordable and returns defensive copies', () => {
    const body = buildScaledWorkerBody(800);
    body.pop();

    expect(buildScaledWorkerBody(800)).toEqual(WORKER_BODY_SCALING_PROFILES[3].body);
    expect(getScaledWorkerBodyCost(WORKER_BODY_SCALING_PROFILES[3].body)).toBe(550);
  });
});
