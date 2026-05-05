import { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  buildMultiRoomUpgraderBody,
  recordPlannedMultiRoomUpgraderSpawn,
  buildMultiRoomUpgraderMemory,
  selectMultiRoomUpgradePlan,
  selectMultiRoomUpgradePlans
} from '../src/territory/multiRoomUpgrader';

describe('multi-room upgrader planner', () => {
  beforeEach(() => {
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 5;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = -2 as ScreepsReturnCode;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  function makeColony({
    roomName = 'W1N1',
    storageEnergy = 850,
    storageCapacity = 1_000
  }: {
    roomName?: string;
    storageEnergy?: number;
    storageCapacity?: number;
  } = {}): ColonySnapshot {
    const room = makeRoom({
      roomName,
      controller: {
        id: `${roomName}-controller`,
        my: true,
        level: 4,
        owner: { username: 'player' }
      } as StructureController,
      storage: makeStorage(storageEnergy, storageCapacity)
    });
    const spawn = { name: 'Spawn1', room } as StructureSpawn;
    return {
      room,
      spawns: [spawn],
      energyAvailable: 800,
      energyCapacityAvailable: 800
    };
  }

  function makeRoom({
    roomName,
    controller,
    storage,
    hostileCreeps = [],
    hostileStructures = [],
    constructionSites = []
  }: {
    roomName: string;
    controller?: StructureController;
    storage?: StructureStorage;
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
    constructionSites?: ConstructionSite[];
  }): Room {
    const find = jest.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      if (type === FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      if (type === FIND_MY_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      return [];
    });
    return {
      name: roomName,
      find,
      ...(controller ? { controller } : {}),
      ...(storage ? { storage } : {})
    } as unknown as Room;
  }

  function makeStorage(energy: number, capacity: number): StructureStorage {
    return {
      store: {
        getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
        getCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0))
      }
    } as unknown as StructureStorage;
  }

  function makeOwnedController(
    roomName: string,
    level: number,
    ticksToDowngrade?: number
  ): StructureController {
    return {
      id: `${roomName}-controller`,
      my: true,
      level,
      ...(typeof ticksToDowngrade === 'number' ? { ticksToDowngrade } : {}),
      owner: { username: 'player' }
    } as StructureController;
  }

  function makeReservedController(roomName: string): StructureController {
    return {
      id: `${roomName}-controller`,
      my: false,
      level: 0,
      reservation: { username: 'player', ticksToEnd: 4_000 }
    } as StructureController;
  }

  function makeRemoteUpgrader(targetRoom: string, ticksToLive = 1_000, homeRoom = 'W1N1'): Creep {
    return {
      ticksToLive,
      memory: {
        role: 'worker',
        colony: targetRoom,
        controllerSustain: { homeRoom, targetRoom, role: 'upgrader' }
      }
    } as Creep;
  }

  function makeSpawnConstructionSite(id = 'spawn-site', progress = 0, progressTotal = 15_000): ConstructionSite {
    return {
      id,
      structureType: 'spawn',
      progress,
      progressTotal
    } as ConstructionSite;
  }

  function installGame({
    colony,
    rooms,
    creeps = {},
    routeLengths = {},
    time = 0
  }: {
    colony: ColonySnapshot;
    rooms: Room[];
    creeps?: Record<string, Creep>;
    routeLengths?: Record<string, number | null>;
    time?: number;
  }): jest.Mock {
    const findRoute = jest.fn((_fromRoom: string, toRoom: string) => {
      const configuredDistance = Object.prototype.hasOwnProperty.call(routeLengths, toRoom)
        ? routeLengths[toRoom]
        : undefined;
      if (configuredDistance === null) {
        return ERR_NO_PATH;
      }

      const distance = configuredDistance ?? 1;
      return Array.from({ length: distance }, (_value, index) => ({ exit: 3, room: `${toRoom}-${index}` }));
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: Object.fromEntries([[colony.room.name, colony.room], ...rooms.map((room) => [room.name, room])]),
      creeps,
      time,
      map: { findRoute } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    return findRoute;
  }

  it('does not select a remote controller when primary storage is below threshold', () => {
    const colony = makeColony({ storageEnergy: 799, storageCapacity: 1_000 });
    installGame({
      colony,
      rooms: [makeRoom({ roomName: 'W2N1', controller: makeOwnedController('W2N1', 1) })]
    });

    expect(selectMultiRoomUpgradePlan(colony)).toBeNull();
  });

  it('selects one adjacent owned controller when storage is above the surplus threshold', () => {
    const colony = makeColony({ storageEnergy: 850, storageCapacity: 1_000 });
    installGame({
      colony,
      rooms: [makeRoom({ roomName: 'W2N1', controller: makeOwnedController('W2N1', 1) })],
      routeLengths: { W2N1: 1 }
    });

    const plan = selectMultiRoomUpgradePlan(colony);

    expect(plan).toEqual({
      homeRoom: 'W1N1',
      targetRoom: 'W2N1',
      controllerId: 'W2N1-controller',
      controllerLevel: 1,
      controllerState: 'owned',
      routeDistance: 1,
      activeUpgraderCount: 0
    });
    expect(buildMultiRoomUpgraderMemory(plan!)).toEqual({
      role: 'worker',
      colony: 'W1N1',
      territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'W2N1-controller' },
      controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
    });
  });

  it('prioritizes controllers closest to downgrade before level or proximity', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [
        makeRoom({ roomName: 'W2N1', controller: makeOwnedController('W2N1', 1, 20_000) }),
        makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 4, 2_000) })
      ],
      routeLengths: { W2N1: 1, W3N1: 3 }
    });

    expect(selectMultiRoomUpgradePlan(colony)).toMatchObject({
      targetRoom: 'W3N1',
      controllerTicksToDowngrade: 2_000
    });
  });

  it('returns all eligible plans in ranked order', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [
        makeRoom({ roomName: 'W2N1', controller: makeOwnedController('W2N1', 3, 5_000) }),
        makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2, 2_000) })
      ],
      routeLengths: { W2N1: 1, W3N1: 3 }
    });

    expect(selectMultiRoomUpgradePlans(colony).map((plan) => plan.targetRoom)).toEqual(['W3N1', 'W2N1']);
  });

  it('caches computed route distances in memory', () => {
    const colony = makeColony();
    const findRoute = installGame({
      colony,
      rooms: [makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2) })],
      routeLengths: { W3N1: 3 }
    });

    expect(selectMultiRoomUpgradePlan(colony)?.routeDistance).toBe(3);
    expect(selectMultiRoomUpgradePlan(colony)?.routeDistance).toBe(3);
    expect(findRoute).toHaveBeenCalledTimes(1);
    expect(Memory.territory?.routeDistances).toEqual({ 'W1N1>W3N1': 3 });
    expect(Memory.territory?.routeDistancesUpdatedAt).toEqual({ 'W1N1>W3N1': 0 });
  });

  it('reuses cached route distances within the cache TTL', () => {
    const colony = makeColony();
    const findRoute = installGame({
      colony,
      rooms: [makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2) })],
      routeLengths: { W3N1: 3 },
      time: 1_000
    });

    expect(selectMultiRoomUpgradePlan(colony)?.routeDistance).toBe(3);
    expect(selectMultiRoomUpgradePlan(colony)?.routeDistance).toBe(3);
    expect(findRoute).toHaveBeenCalledTimes(1);
    expect(selectMultiRoomUpgradePlan(colony)?.routeDistance).toBe(3);
    expect(findRoute).toHaveBeenCalledTimes(1);
  });

  it('recomputes stale cached routes when the cache TTL expires', () => {
    const colony = makeColony();
    const findRoute = installGame({
      colony,
      rooms: [makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2) })],
      routeLengths: { W3N1: 3 },
      time: 1
    });

    expect(selectMultiRoomUpgradePlan(colony)?.routeDistance).toBe(3);
    expect(findRoute).toHaveBeenCalledTimes(1);

    if (Memory.territory) {
      Memory.territory.routeDistancesUpdatedAt = { 'W1N1>W3N1': 0 };
    }
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = 1_000;

    expect(selectMultiRoomUpgradePlan(colony)?.routeDistance).toBe(3);
    expect(findRoute).toHaveBeenCalledTimes(2);
  });

  it('uses extra move parts for longer remote upgrade routes', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2) })],
      routeLengths: { W3N1: 3 }
    });

    const plan = selectMultiRoomUpgradePlan(colony);

    expect(buildMultiRoomUpgraderBody(800, plan!)).toEqual([
      'work',
      'carry',
      'move',
      'move',
      'work',
      'carry',
      'move',
      'move',
      'work',
      'carry',
      'move',
      'move',
      'move'
    ]);
  });

  it('handles multiple rooms while respecting the per-room upgrader cap', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [
        makeRoom({ roomName: 'W2N1', controller: makeOwnedController('W2N1', 1) }),
        makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2) })
      ],
      creeps: { Existing: makeRemoteUpgrader('W2N1') },
      routeLengths: { W2N1: 1, W3N1: 1 }
    });

    expect(selectMultiRoomUpgradePlan(colony)?.targetRoom).toBe('W3N1');
    expect(selectMultiRoomUpgradePlan(colony, { perRoomUpgraderCap: 2 })?.targetRoom).toBe('W2N1');
  });

  it('counts planned and active multi-room upgrader creeps toward the per-room cap', () => {
    const colony = makeColony();
    const cacheTick = 1;
    installGame({
      colony,
      rooms: [
        makeRoom({ roomName: 'W2N1', controller: makeOwnedController('W2N1', 1) }),
        makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2) })
      ],
      creeps: { Existing: makeRemoteUpgrader('W2N1') },
      routeLengths: { W2N1: 1, W3N1: 1 },
      time: cacheTick
    });

    recordPlannedMultiRoomUpgraderSpawn({
      role: 'worker',
      controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' },
      colony: 'W1N1'
    } as CreepMemory);

    const planWithCap1 = selectMultiRoomUpgradePlan(colony, { perRoomUpgraderCap: 1 });
    const planWithCap2 = selectMultiRoomUpgradePlan(colony, { perRoomUpgraderCap: 2 });
    const planWithCap3 = selectMultiRoomUpgradePlan(colony, { perRoomUpgraderCap: 3 });

    expect(planWithCap1?.targetRoom).toBe('W3N1');
    expect(planWithCap2?.targetRoom).toBe('W3N1');
    expect(planWithCap3?.targetRoom).toBe('W2N1');
  });

  it('counts active upgraders from every home room toward the target cap', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [
        makeRoom({ roomName: 'W2N1', controller: makeOwnedController('W2N1', 1, 1_000) }),
        makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 2, 2_000) })
      ],
      creeps: { Existing: makeRemoteUpgrader('W2N1', 1_000, 'W9N9') },
      routeLengths: { W2N1: 1, W3N1: 1 }
    });

    expect(selectMultiRoomUpgradePlan(colony)?.targetRoom).toBe('W3N1');
  });

  it('temporarily allows an extra upgrader for claimed rooms with active spawn construction', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [
        makeRoom({
          roomName: 'W2N1',
          controller: makeOwnedController('W2N1', 1),
          constructionSites: [makeSpawnConstructionSite()]
        })
      ],
      creeps: { Existing: makeRemoteUpgrader('W2N1') },
      routeLengths: { W2N1: 1 }
    });

    expect(selectMultiRoomUpgradePlan(colony)).toMatchObject({
      targetRoom: 'W2N1',
      activeUpgraderCount: 1
    });
  });

  it('keeps the normal cap when the claimed-room spawn site is complete', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [
        makeRoom({
          roomName: 'W2N1',
          controller: makeOwnedController('W2N1', 1),
          constructionSites: [makeSpawnConstructionSite('spawn-site-complete', 15_000, 15_000)]
        })
      ],
      creeps: { Existing: makeRemoteUpgrader('W2N1') },
      routeLengths: { W2N1: 1 }
    });

    expect(selectMultiRoomUpgradePlan(colony)).toBeNull();
  });

  it('skips maxed and unowned controllers instead of building claimer sustain bodies', () => {
    const colony = makeColony({ storageEnergy: 900, storageCapacity: 1_000 });
    installGame({
      colony,
      rooms: [
        makeRoom({ roomName: 'W2N1', controller: makeReservedController('W2N1') }),
        makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 8, 1_000) }),
        makeRoom({ roomName: 'W4N1', controller: makeOwnedController('W4N1', 7, 3_000) })
      ],
      routeLengths: { W2N1: 1, W3N1: 1, W4N1: 1 }
    });

    const plan = selectMultiRoomUpgradePlan(colony);

    expect(plan).toEqual({
      homeRoom: 'W1N1',
      targetRoom: 'W4N1',
      controllerId: 'W4N1-controller',
      controllerLevel: 7,
      controllerState: 'owned',
      controllerTicksToDowngrade: 3_000,
      routeDistance: 1,
      activeUpgraderCount: 0
    });
    expect(buildMultiRoomUpgraderBody(1_000, plan!)).toEqual([
      'work',
      'carry',
      'move',
      'work',
      'carry',
      'move',
      'work',
      'carry',
      'move',
      'work',
      'carry',
      'move',
      'move'
    ]);
  });

  it('skips hostile and inaccessible rooms', () => {
    const colony = makeColony();
    installGame({
      colony,
      rooms: [
        makeRoom({
          roomName: 'W2N1',
          controller: makeOwnedController('W2N1', 1),
          hostileCreeps: [{ id: 'hostile1' } as Creep]
        }),
        makeRoom({ roomName: 'W3N1', controller: makeOwnedController('W3N1', 1) })
      ],
      routeLengths: { W2N1: 1, W3N1: null }
    });

    expect(selectMultiRoomUpgradePlan(colony)).toBeNull();
  });
});
