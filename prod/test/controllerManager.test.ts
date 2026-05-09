import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  buildControllerUpgradeCreepMemory,
  buildControllerManagementPlan,
  refreshControllerManagement
} from '../src/territory/controllerManager';

describe('controller manager', () => {
  beforeEach(() => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {} };
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
  });

  it('records owned controller sign state and near-level upgrade demand', () => {
    const colony = makeColony({
      controller: makeController({
        sign: { username: 'other', text: 'legacy sign', time: 1, datetime: new Date('2026-05-07T00:00:00.000Z') }
      })
    });

    const plan = refreshControllerManagement(colony, { worker: 3 }, 3, 200);

    expect(plan).toMatchObject({
      roomName: 'W1N1',
      controllerId: 'controller1',
      controllerLevel: 3,
      desiredControllerLevel: 8,
      signNeeded: true,
      upgradePriority: 'rclProgress',
      desiredUpgraderCount: 1,
      activeUpgraderCount: 0,
      progress: 900,
      progressRatio: 0.9,
      progressRemaining: 100,
      progressTotal: 1000,
      spawnDemand: {
        roomName: 'W1N1',
        controllerId: 'controller1',
        priority: 'rclProgress',
        desiredUpgraderCount: 1,
        activeUpgraderCount: 0
      }
    });
    expect(Memory.territory?.controllers?.W1N1).toEqual({
      roomName: 'W1N1',
      controllerId: 'controller1',
      controllerLevel: 3,
      desiredControllerLevel: 8,
      signNeeded: true,
      upgradePriority: 'rclProgress',
      desiredUpgraderCount: 1,
      activeUpgraderCount: 0,
      updatedAt: 200,
      progress: 900,
      progressRatio: 0.9,
      progressRemaining: 100,
      progressTotal: 1000,
      ticksToDowngrade: 10_000,
      spawnDemand: {
        controllerId: 'controller1',
        priority: 'rclProgress',
        desiredUpgraderCount: 1,
        activeUpgraderCount: 0
      }
    });
  });

  it('suppresses progression spawn demand behind competing spawn work', () => {
    const plan = buildControllerManagementPlan(
      makeColony(),
      { worker: 3 },
      3,
      201,
      { competingSpawnDemand: true }
    );

    expect(plan.upgradePriority).toBe('fallback');
    expect(plan.spawnDemand).toBeUndefined();
  });

  it('keeps the dedicated upgrade demand while construction work is visible', () => {
    const plan = buildControllerManagementPlan(
      makeColony({ constructionSiteCount: 1 }),
      { worker: 3 },
      3,
      205
    );

    expect(plan.upgradePriority).toBe('rclProgress');
    expect(plan.desiredUpgraderCount).toBe(1);
    expect(plan.spawnDemand).toMatchObject({
      priority: 'rclProgress',
      desiredUpgraderCount: 1
    });
  });

  it('keeps steady upgrader demand to one creep regardless of room energy capacity', () => {
    const plan = buildControllerManagementPlan(
      makeColony({
        energyAvailable: 1_300,
        energyCapacityAvailable: 1_300,
        controller: makeController({ progress: 100, progressTotal: 1_000 })
      }),
      { worker: 3 },
      3,
      206
    );

    expect(plan).toMatchObject({
      upgradePriority: 'steady',
      desiredUpgraderCount: 1,
      spawnDemand: {
        priority: 'steady',
        desiredUpgraderCount: 1
      }
    });
  });

  it('does not request a dedicated upgrader for an RCL 8 controller', () => {
    const plan = buildControllerManagementPlan(
      makeColony({
        energyAvailable: 5_600,
        energyCapacityAvailable: 5_600,
        controller: makeController({ level: 8, progress: 0, progressTotal: 0 })
      }),
      { worker: 3 },
      3,
      207
    );

    expect(plan.desiredUpgraderCount).toBe(0);
    expect(plan.spawnDemand).toBeUndefined();
  });

  it('treats missing Game state as no active controller upgraders', () => {
    delete (globalThis as { Game?: Partial<Game> }).Game;

    const plan = buildControllerManagementPlan(makeColony(), { worker: 3 }, 3, 204);

    expect(plan.activeUpgraderCount).toBe(0);
    expect(plan.spawnDemand).toMatchObject({
      roomName: 'W1N1',
      controllerId: 'controller1',
      priority: 'rclProgress'
    });
  });

  it('counts active controller upgraders before requesting another dedicated worker', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        Upgrader1: {
          ticksToLive: 1_000,
          memory: {
            role: 'upgrader',
            colony: 'W1N1',
            controllerUpgrade: {
              roomName: 'W1N1',
              controllerId: 'controller1' as Id<StructureController>,
              priority: 'rclProgress'
            }
          }
        } as Creep
      }
    };

    const plan = buildControllerManagementPlan(makeColony(), { worker: 3 }, 3, 202);

    expect(plan.activeUpgraderCount).toBe(1);
    expect(plan.spawnDemand).toBeUndefined();
  });

  it('counts controller sustain upgraders assigned to the same controller before requesting local coverage', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        RemoteUpgrader1: {
          ticksToLive: 1_000,
          memory: {
            role: 'worker',
            colony: 'W2N1',
            territory: {
              targetRoom: 'W1N1',
              action: 'claim',
              controllerId: 'controller1' as Id<StructureController>
            },
            controllerSustain: {
              homeRoom: 'W2N1',
              targetRoom: 'W1N1',
              role: 'upgrader'
            }
          }
        } as Creep
      }
    };

    const plan = buildControllerManagementPlan(makeColony(), { worker: 3 }, 3, 208);

    expect(plan.activeUpgraderCount).toBe(1);
    expect(plan.spawnDemand).toBeUndefined();
  });

  it('ignores controller sustain creeps assigned to a different controller', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        RemoteUpgrader1: {
          ticksToLive: 1_000,
          memory: {
            role: 'worker',
            colony: 'W2N1',
            territory: {
              targetRoom: 'W1N1',
              action: 'claim',
              controllerId: 'controller2' as Id<StructureController>
            },
            controllerSustain: {
              homeRoom: 'W2N1',
              targetRoom: 'W1N1',
              role: 'upgrader'
            }
          }
        } as Creep
      }
    };

    const plan = buildControllerManagementPlan(makeColony(), { worker: 3 }, 3, 209);

    expect(plan.activeUpgraderCount).toBe(0);
    expect(plan.spawnDemand).toMatchObject({
      roomName: 'W1N1',
      controllerId: 'controller1',
      priority: 'rclProgress'
    });
  });

  it('builds dedicated controller-upgrade worker memory', () => {
    expect(
      buildControllerUpgradeCreepMemory(
        {
          roomName: 'W1N1',
          controllerId: 'controller1' as Id<StructureController>,
          priority: 'rclProgress',
          desiredUpgraderCount: 1,
          activeUpgraderCount: 0
        },
        203
      )
    ).toEqual({
      role: 'upgrader',
      colony: 'W1N1',
      controllerUpgrade: {
        roomName: 'W1N1',
        controllerId: 'controller1',
        priority: 'rclProgress',
        assignedAt: 203
      }
    });
  });

  function makeColony({
    controller = makeController(),
    energyAvailable = 650,
    energyCapacityAvailable = 650,
    constructionSiteCount = 0
  }: {
    controller?: StructureController;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    constructionSiteCount?: number;
  } = {}): ColonySnapshot {
    const constructionSites = Array.from(
      { length: constructionSiteCount },
      (_, index) => ({ id: `site${index}`, my: true }) as ConstructionSite
    );
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_MY_CONSTRUCTION_SITES || type === FIND_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        return [];
      })
    } as unknown as Room;
    const spawn = { name: 'Spawn1', room } as StructureSpawn;
    return {
      room,
      spawns: [spawn],
      energyAvailable,
      energyCapacityAvailable
    };
  }

  function makeController(overrides: Partial<StructureController> = {}): StructureController {
    return {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000,
      ticksToDowngrade: 10_000,
      ...overrides
    } as StructureController;
  }
});
