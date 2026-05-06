import {
  getControllerUpgradePriority,
  runUpgrader
} from '../src/creeps/upgraderRunner';
import { OCCUPIED_CONTROLLER_SIGN_TEXT } from '../src/territory/controllerSigning';

describe('upgrader runner', () => {
  it('prioritizes near-level controller progress only when spawn energy is ready', () => {
    const controller = makeController({ progress: 900, progressTotal: 1_000 });

    expect(
      getControllerUpgradePriority(controller, {
        energyAvailable: 650,
        energyCapacityAvailable: 650
      })
    ).toBe('rclProgress');
    expect(
      getControllerUpgradePriority(controller, {
        energyAvailable: 400,
        energyCapacityAvailable: 650
      })
    ).toBe('fallback');
  });

  it('suppresses progression priority behind competing spawn demand', () => {
    expect(
      getControllerUpgradePriority(makeController({ progress: 900, progressTotal: 1_000 }), {
        energyAvailable: 650,
        energyCapacityAvailable: 650,
        competingSpawnDemand: true
      })
    ).toBe('fallback');
  });

  it('keeps downgrade guard above normal progression scoring', () => {
    expect(
      getControllerUpgradePriority(makeController({ ticksToDowngrade: 1_000 }), {
        energyAvailable: 650,
        energyCapacityAvailable: 650
      })
    ).toBe('downgradeGuard');
  });

  it('signs owned controllers before upgrading', () => {
    const controller = makeController({
      sign: { username: 'other', text: 'old', time: 1, datetime: new Date('2026-05-07T00:00:00.000Z') }
    });
    const creep = {
      signController: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn().mockReturnValue(0)
    } as unknown as Creep;

    expect(runUpgrader(creep, controller)).toBe(0);

    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
  });

  function makeController(overrides: Partial<StructureController> = {}): StructureController {
    return {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 100,
      progressTotal: 1_000,
      ticksToDowngrade: 10_000,
      ...overrides
    } as StructureController;
  }
});
