import {
  getControllerUpgradePriority,
  runUpgrader,
  runUpgraderCreep
} from '../src/creeps/upgraderRunner';
import {
  CONTROLLER_SIGN_REFRESH_INTERVAL_TICKS,
  OCCUPIED_CONTROLLER_SIGN_TEXT
} from '../src/territory/controllerSigning';

describe('upgrader runner', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_CONSTRUCTION_SITES: 1,
      FIND_DROPPED_RESOURCES: 2,
      FIND_HOSTILE_CREEPS: 3,
      FIND_HOSTILE_STRUCTURES: 8,
      FIND_MY_CONSTRUCTION_SITES: 4,
      FIND_MY_STRUCTURES: 5,
      FIND_SOURCES: 6,
      FIND_STRUCTURES: 7,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_CONTAINER: 'container',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_LINK: 'link',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage'
    });
  });

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

  it('keeps steady upgrade priority when construction pressure exists', () => {
    const controller = makeController({ progress: 100, progressTotal: 1_000 });

    expect(
      getControllerUpgradePriority(controller, {
        energyAvailable: 650,
        energyCapacityAvailable: 650
      })
    ).toBe('steady');
    expect(
      getControllerUpgradePriority(controller, {
        energyAvailable: 650,
        energyCapacityAvailable: 650,
        constructionDemand: true
      })
    ).toBe('steady');
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
    const room = makeRoom({ controller });
    const creep = {
      room,
      signController: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn().mockReturnValue(0)
    } as unknown as Creep;

    expect(runUpgrader(creep, controller)).toBe(0);

    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
  });

  it('refreshes stale owned controller signatures before upgrading', () => {
    const signedAt = 25;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: signedAt + CONTROLLER_SIGN_REFRESH_INTERVAL_TICKS
    };
    const controller = makeController({
      sign: {
        username: 'me',
        text: OCCUPIED_CONTROLLER_SIGN_TEXT,
        time: signedAt,
        datetime: new Date('2026-05-07T00:00:00.000Z')
      }
    });
    const room = makeRoom({ controller });
    const creep = {
      room,
      signController: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn().mockReturnValue(0)
    } as unknown as Creep;

    expect(runUpgrader(creep, controller)).toBe(0);

    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
  });

  it('skips opportunistic controller signing while the owned room is hostile', () => {
    const controller = makeController({
      sign: { username: 'other', text: 'old', time: 1, datetime: new Date('2026-05-07T00:00:00.000Z') }
    });
    const room = {
      ...makeRoom({ controller }),
      find: jest.fn((type: number) => (type === FIND_HOSTILE_CREEPS ? [{ id: 'hostile1' }] : []))
    } as unknown as Room;
    const creep = {
      room,
      signController: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn().mockReturnValue(0)
    } as unknown as Creep;

    expect(runUpgrader(creep, controller)).toBe(0);

    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
  });

  it('withdraws stored energy before upgrading with a dedicated upgrader creep', () => {
    const container = makeEnergyStructure('container1', 'container', 500, 0);
    const controller = makeController();
    const room = makeRoom({ controller, structures: [container] });
    const creep = makeUpgraderCreep(room, { usedEnergy: 0, freeEnergy: 50 });

    runUpgraderCreep(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, 'energy');
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it('prefers the controller staging container for dedicated upgraders', () => {
    const controller = makeController({ pos: makeRoomPosition(25, 25) });
    const sourceContainer = makeEnergyStructure('source-container', 'container', 1_000, 0, makeRoomPosition(10, 10));
    const controllerContainer = makeEnergyStructure(
      'controller-container',
      'container',
      100,
      1_900,
      makeRoomPosition(24, 25)
    );
    const room = makeRoom({ controller, structures: [sourceContainer, controllerContainer] });
    const creep = makeUpgraderCreep(room, {
      usedEnergy: 0,
      freeEnergy: 50,
      ranges: {
        'controller-container': 10,
        'source-container': 1
      }
    });

    runUpgraderCreep(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(controllerContainer, 'energy');
  });

  it('upgrades the assigned controller when loaded and energy buffers are healthy', () => {
    const controller = makeController();
    const room = makeRoom({ controller });
    const creep = makeUpgraderCreep(room, { usedEnergy: 50, freeEnergy: 0 });

    runUpgraderCreep(creep);

    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
  });

  it('renews at an idle spawn only while assigned controller can level up', () => {
    const controller = makeController();
    const spawn = makeRenewSpawn('Spawn1');
    const room = makeRoom({ controller, ownedStructures: [spawn] });
    const creep = makeUpgraderCreep(room, { usedEnergy: 50, freeEnergy: 0, ticksToLive: 100 });

    runUpgraderCreep(creep);

    expect(spawn.renewCreep).toHaveBeenCalledWith(creep);
    expect(creep.upgradeController).not.toHaveBeenCalled();

    const maxLevelController = makeController({ level: 8 });
    const maxLevelSpawn = makeRenewSpawn('Spawn2');
    const maxLevelRoom = makeRoom({ controller: maxLevelController, ownedStructures: [maxLevelSpawn] });
    const maxLevelCreep = makeUpgraderCreep(maxLevelRoom, { usedEnergy: 50, freeEnergy: 0, ticksToLive: 100 });

    runUpgraderCreep(maxLevelCreep);

    expect(maxLevelSpawn.renewCreep).not.toHaveBeenCalled();
    expect(maxLevelCreep.upgradeController).not.toHaveBeenCalled();
  });

  it('keeps upgrading with carried energy even when spawn energy is not full', () => {
    const controller = makeController();
    const spawn = makeEnergyStructure('spawn1', 'spawn', 0, 300);
    const room = makeRoom({
      controller,
      energyAvailable: 400,
      energyCapacityAvailable: 650,
      ownedStructures: [spawn]
    });
    const creep = makeUpgraderCreep(room, { usedEnergy: 50, freeEnergy: 0 });

    runUpgraderCreep(creep);

    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.transfer).not.toHaveBeenCalled();
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

  function makeRoom({
    controller = makeController(),
    energyAvailable = 650,
    energyCapacityAvailable = 650,
    structures = [],
    ownedStructures = []
  }: {
    controller?: StructureController;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    structures?: Structure[];
    ownedStructures?: Structure[];
  } = {}): Room {
    return {
      name: 'W1N1',
      controller,
      energyAvailable,
      energyCapacityAvailable,
      find: jest.fn((type: number) => {
        if (type === FIND_STRUCTURES) {
          return structures;
        }

        if (type === FIND_MY_STRUCTURES) {
          return ownedStructures;
        }

        return [];
      })
    } as unknown as Room;
  }

  function makeUpgraderCreep(
    room: Room,
    {
      usedEnergy,
      freeEnergy,
      ticksToLive,
      ranges = {}
    }: {
      usedEnergy: number;
      freeEnergy: number;
      ticksToLive?: number;
      ranges?: Record<string, number>;
    }
  ): Creep {
    return {
      ...(ticksToLive === undefined ? {} : { ticksToLive }),
      memory: {
        role: 'upgrader',
        colony: 'W1N1',
        controllerUpgrade: {
          roomName: 'W1N1',
          controllerId: 'controller1' as Id<StructureController>,
          priority: 'steady'
        }
      },
      room,
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => ranges[String(target.id)] ?? 1)
      },
      store: {
        getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? usedEnergy : 0)),
        getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeEnergy : 0))
      },
      harvest: jest.fn().mockReturnValue(0),
      moveTo: jest.fn().mockReturnValue(0),
      pickup: jest.fn().mockReturnValue(0),
      signController: jest.fn().mockReturnValue(0),
      transfer: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn().mockReturnValue(0),
      withdraw: jest.fn().mockReturnValue(0)
    } as unknown as Creep;
  }

  function makeRenewSpawn(name: string): StructureSpawn {
    return {
      id: `${name}-id`,
      name,
      structureType: 'spawn',
      spawning: null,
      renewCreep: jest.fn().mockReturnValue(0)
    } as unknown as StructureSpawn;
  }

  function makeEnergyStructure(
    id: string,
    structureType: StructureConstant,
    energy: number,
    freeCapacity: number,
    pos?: RoomPosition
  ): AnyStoreStructure {
    return {
      id,
      structureType,
      ...(pos ? { pos } : {}),
      store: {
        getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
        getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeCapacity : 0))
      }
    } as unknown as AnyStoreStructure;
  }

  function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
    return {
      x,
      y,
      roomName,
      getRangeTo: jest.fn((target: RoomObject | RoomPosition) => {
        const position = 'pos' in target ? target.pos : target;
        return Math.max(Math.abs(x - position.x), Math.abs(y - position.y));
      })
    } as unknown as RoomPosition;
  }
});
