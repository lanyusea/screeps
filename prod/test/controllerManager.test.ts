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
      signNeeded: true,
      upgradePriority: 'rclProgress',
      desiredUpgraderCount: 1,
      activeUpgraderCount: 0,
      progressRatio: 0.9,
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
      signNeeded: true,
      upgradePriority: 'rclProgress',
      desiredUpgraderCount: 1,
      activeUpgraderCount: 0,
      updatedAt: 200,
      progressRatio: 0.9,
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

  it('counts active controller upgraders before requesting another dedicated worker', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        Upgrader1: {
          ticksToLive: 1_000,
          memory: {
            role: 'worker',
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
      role: 'worker',
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
    energyCapacityAvailable = 650
  }: {
    controller?: StructureController;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
  } = {}): ColonySnapshot {
    const room = {
      name: 'W1N1',
      controller
    } as Room;
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
