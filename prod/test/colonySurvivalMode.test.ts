import { assessColonySurvival } from '../src/colony/survivalMode';

describe('assessColonySurvival', () => {
  it('enters bootstrap with no workers', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 0,
        workerTarget: 3,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'BOOTSTRAP',
      survivalWorkerFloor: 3,
      suppressionReasons: ['bootstrapWorkerFloor']
    });
  });

  it('keeps bootstrap while workers are below the survival floor', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 2,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      }).mode
    ).toBe('BOOTSTRAP');
  });

  it('uses local stable while the survival floor is met but territory gates are not', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 3,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'LOCAL_STABLE',
      suppressionReasons: ['localWorkerRecovery']
    });
  });

  it('marks territory ready only after home stability gates are satisfied', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 4,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'TERRITORY_READY',
      territoryReady: true,
      suppressionReasons: []
    });
  });

  it('switches to defense mode while visible hostiles are present', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 4,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 },
        hostileCreepCount: 1
      })
    ).toMatchObject({
      mode: 'DEFENSE',
      suppressionReasons: ['defense']
    });
  });
});
