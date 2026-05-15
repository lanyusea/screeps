import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  buildControllerUpgradeCreepMemory,
  buildControllerManagementPlan,
  refreshControllerManagement
} from '../src/territory/controllerManager';
import {
  CONTROLLER_SIGN_REFRESH_INTERVAL_TICKS,
  OCCUPIED_CONTROLLER_SIGN_TEXT
} from '../src/territory/controllerSigning';

describe('controller manager', () => {
  beforeEach(() => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {} };
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 3;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 4;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_LINK: StructureConstant }).STRUCTURE_LINK = 'link';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
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

  it('records a stale owned controller signature as signing demand', () => {
    const signedAt = 300;
    const plan = buildControllerManagementPlan(
      makeColony({
        controller: makeController({
          sign: {
            username: 'me',
            text: OCCUPIED_CONTROLLER_SIGN_TEXT,
            time: signedAt,
            datetime: new Date('2026-05-07T00:00:00.000Z')
          }
        })
      }),
      { worker: 3 },
      3,
      signedAt + CONTROLLER_SIGN_REFRESH_INTERVAL_TICKS
    );

    expect(plan.signNeeded).toBe(true);
  });

  it('does not record signing demand for a fresh owned controller signature', () => {
    const signedAt = 300;
    const plan = buildControllerManagementPlan(
      makeColony({
        controller: makeController({
          sign: {
            username: 'me',
            text: OCCUPIED_CONTROLLER_SIGN_TEXT,
            time: signedAt,
            datetime: new Date('2026-05-07T00:00:00.000Z')
          }
        })
      }),
      { worker: 3 },
      3,
      signedAt + CONTROLLER_SIGN_REFRESH_INTERVAL_TICKS - 1
    );

    expect(plan.signNeeded).toBe(false);
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

  it('requests a second low-RCL upgrader when stored surplus remains after construction clears', () => {
    const plan = buildControllerManagementPlan(
      makeColony({
        energyAvailable: 550,
        energyCapacityAvailable: 550,
        controller: makeController({ level: 2, progress: 3_000, progressTotal: 45_000 }),
        myStructures: [makeEnergyStore('storage1', 'storage', 2_000)]
      }),
      { worker: 4, upgrader: 1 },
      4,
      210
    );

    expect(plan).toMatchObject({
      upgradePriority: 'energySurplus',
      desiredUpgraderCount: 2,
      activeUpgraderCount: 1,
      spawnDemand: {
        priority: 'energySurplus',
        desiredUpgraderCount: 2,
        activeUpgraderCount: 1
      }
    });
  });

  it('keeps surplus upgrade demand at the baseline while the worker floor is missing', () => {
    const plan = buildControllerManagementPlan(
      makeColony({
        energyAvailable: 550,
        energyCapacityAvailable: 550,
        controller: makeController({ level: 2, progress: 3_000, progressTotal: 45_000 }),
        myStructures: [makeEnergyStore('storage1', 'storage', 2_000)]
      }),
      { worker: 3, upgrader: 1 },
      4,
      211
    );

    expect(plan.desiredUpgraderCount).toBe(0);
    expect(plan.spawnDemand).toBeUndefined();
  });

  it('does not surge extra upgraders while visible construction still needs workers', () => {
    const plan = buildControllerManagementPlan(
      makeColony({
        constructionSiteCount: 1,
        energyAvailable: 550,
        energyCapacityAvailable: 550,
        controller: makeController({ level: 2, progress: 3_000, progressTotal: 45_000 }),
        myStructures: [makeEnergyStore('storage1', 'storage', 2_000)]
      }),
      { worker: 4, upgrader: 1 },
      4,
      212
    );

    expect(plan.upgradePriority).toBe('energySurplus');
    expect(plan.desiredUpgraderCount).toBe(1);
    expect(plan.spawnDemand).toBeUndefined();
  });

  it('does not surge extra upgraders during defense pressure', () => {
    const plan = buildControllerManagementPlan(
      makeColony({
        energyAvailable: 550,
        energyCapacityAvailable: 550,
        controller: makeController({ level: 2, progress: 3_000, progressTotal: 45_000 }),
        myStructures: [makeEnergyStore('storage1', 'storage', 2_000)]
      }),
      { worker: 4, upgrader: 1 },
      4,
      213,
      { defenseDemand: true }
    );

    expect(plan.desiredUpgraderCount).toBe(0);
    expect(plan.spawnDemand).toBeUndefined();
  });

  it('does not surge extra upgraders until spawn energy and buffer margin are ready', () => {
    const plan = buildControllerManagementPlan(
      makeColony({
        energyAvailable: 599,
        energyCapacityAvailable: 650,
        controller: makeController({ level: 3, progress: 3_000, progressTotal: 135_000 }),
        myStructures: [makeEnergyStore('storage1', 'storage', 2_000)]
      }),
      { worker: 4, upgrader: 1 },
      4,
      214,
      { hasEnergySurplus: true }
    );

    expect(plan.upgradePriority).toBe('energySurplus');
    expect(plan.desiredUpgraderCount).toBe(1);
    expect(plan.spawnDemand).toBeUndefined();
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

  it('uses owned stored-energy structures without scanning every room structure', () => {
    const colony = makeColony({
      energyAvailable: 550,
      energyCapacityAvailable: 550,
      controller: makeController({ level: 2, progress: 3_000, progressTotal: 45_000 }),
      myStructures: [makeEnergyStore('link1', 'link', 2_000)],
      structures: [makeEnergyStore('container1', 'container', 5_000)]
    });

    const plan = buildControllerManagementPlan(colony, { worker: 4, upgrader: 1 }, 4, 215);

    expect(plan).toMatchObject({
      upgradePriority: 'energySurplus',
      desiredUpgraderCount: 2,
      spawnDemand: {
        priority: 'energySurplus',
        desiredUpgraderCount: 2
      }
    });
    const find = colony.room.find as jest.Mock;
    expect(find.mock.calls.some(([type]) => type === FIND_STRUCTURES)).toBe(false);
    expect(find).toHaveBeenCalledWith(
      FIND_MY_STRUCTURES,
      expect.objectContaining({ filter: expect.any(Function) })
    );
  });

  it('counts direct room storage and terminal energy without a global structure scan', () => {
    const colony = makeColony({
      energyAvailable: 550,
      energyCapacityAvailable: 550,
      controller: makeController({ level: 2, progress: 3_000, progressTotal: 45_000 }),
      storage: makeEnergyStore('storage1', 'storage', 700) as StructureStorage,
      terminal: makeEnergyStore('terminal1', 'terminal', 500) as StructureTerminal
    });

    const plan = buildControllerManagementPlan(colony, { worker: 4, upgrader: 1 }, 4, 216);

    const find = colony.room.find as jest.Mock;
    expect(plan.desiredUpgraderCount).toBe(2);
    expect(find.mock.calls.some(([type]) => type === FIND_STRUCTURES)).toBe(false);
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
    constructionSiteCount = 0,
    structures = [],
    myStructures = [],
    storage,
    terminal
  }: {
    controller?: StructureController;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    constructionSiteCount?: number;
    structures?: Structure[];
    myStructures?: Structure[];
    storage?: StructureStorage;
    terminal?: StructureTerminal;
  } = {}): ColonySnapshot {
    const constructionSites = Array.from(
      { length: constructionSiteCount },
      (_, index) => ({ id: `site${index}`, my: true }) as ConstructionSite
    );
    const room = {
      name: 'W1N1',
      controller,
      ...(storage ? { storage } : {}),
      ...(terminal ? { terminal } : {}),
      find: jest.fn((type: number, options?: { filter?: (structure: Structure) => boolean }) => {
        if (type === FIND_MY_CONSTRUCTION_SITES || type === FIND_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        if (type === FIND_MY_STRUCTURES) {
          return typeof options?.filter === 'function' ? myStructures.filter(options.filter) : myStructures;
        }

        if (type === FIND_STRUCTURES) {
          return structures;
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

  function makeEnergyStore(
    id: string,
    structureType: StructureConstant,
    energy: number
  ): Structure {
    return {
      id,
      structureType,
      store: {
        getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0))
      }
    } as unknown as Structure;
  }
});
