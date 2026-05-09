import { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  CROSS_ROOM_HAULER_ROLE,
  buildCrossRoomHaulerBody,
  planCrossRoomHauler,
  runCrossRoomHauler
} from '../src/economy/crossRoomHauler';
import { balanceStorage } from '../src/economy/storageBalancer';
import { auditLocalEnergyImport } from '../src/economy/localEnergyStrategy';
import {
  getSpawnEnergyForecast,
  orderColoniesForSpawnPlanning,
  planSpawn
} from '../src/spawn/spawnPlanner';

describe('cross-room energy logistics', () => {
  const OK_CODE = 0 as ScreepsReturnCode;
  const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
  const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
  const SCALED_WORKER_300: BodyPartConstant[] = ['work', 'work', 'carry', 'move'];
  const objectRegistry = new Map<string, unknown>();

  beforeEach(() => {
    objectRegistry.clear();
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 5;
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 6;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
    (globalThis as unknown as { WORK: BodyPartConstant }).WORK = 'work';
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    (globalThis as unknown as { UPGRADE_CONTROLLER_POWER: number }).UPGRADE_CONTROLLER_POWER = 1;
    (globalThis as unknown as { ERR_NOT_IN_RANGE: ScreepsReturnCode }).ERR_NOT_IN_RANGE = ERR_NOT_IN_RANGE_CODE;
    (globalThis as unknown as { ERR_NO_PATH: ScreepsReturnCode }).ERR_NO_PATH = ERR_NO_PATH_CODE;
    (globalThis as unknown as { RoomPosition: new (x: number, y: number, roomName: string) => RoomPosition })
      .RoomPosition = class {
      public constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly roomName: string
      ) {}
    } as unknown as new (x: number, y: number, roomName: string) => RoomPosition;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('flags export and import rooms from storage thresholds', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 900 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 200 });
    const balancedRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 500 });
    installGame([sourceRoom, targetRoom, balancedRoom], []);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.W1N1).toMatchObject({
      mode: 'export',
      energy: 900,
      capacity: 1_000,
      exportableEnergy: 100
    });
    expect(Memory.economy?.storageBalance?.rooms.W2N1).toMatchObject({
      mode: 'import',
      importDemand: 100
    });
    expect(Memory.economy?.storageBalance?.rooms.W3N1).toMatchObject({ mode: 'balanced' });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 100, updatedAt: 100 }
    ]);
  });

  it('keeps storage exports from consuming unmet spawn energy reservations', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 900, energyAvailable: 700 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 200 });
    installGame([sourceRoom, targetRoom], []);
    Memory.economy = {
      spawnEnergyReservation: {
        updatedAt: 99,
        rooms: {
          W1N1: {
            bodyCost: 800,
            creepName: 'claimer-W1N1-W3N1-100',
            reservedAt: 99,
            reservedEnergy: 800,
            role: 'claimer',
            roomName: 'W1N1',
            updatedAt: 99
          }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.W1N1).toMatchObject({
      exportableEnergy: 0,
      reservedSpawnEnergy: 800,
      unmetSpawnEnergyReservation: 100
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
  });

  it('records terminal energy balance fields with storage balance state', () => {
    const room = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 900,
      terminalEnergy: 100,
      terminalCapacity: 1_000
    });
    installGame([room], []);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.W1N1).toMatchObject({
      energy: 1_000,
      capacity: 2_000,
      storageEnergy: 900,
      storageCapacity: 1_000,
      storageFreeCapacity: 100,
      terminalEnergy: 100,
      terminalCapacity: 1_000,
      terminalFreeCapacity: 900,
      terminalTargetEnergy: 1_000,
      terminalEnergyDeficit: 900,
      terminalEnergySurplus: 0
    });
  });

  it('audits E26S48 local energy as sufficient before importing from E26S49', () => {
    const sourceContainer = makeContainer('E26S48-source-container', 450, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      structures: [sourceContainer]
    });
    installGame([targetRoom], []);
    Memory.economy = {
      sourceWorkloads: {
        E26S48: {
          updatedAt: 100,
          sources: {
            'E26S48-source': makeSourceWorkload('E26S48-source', 10, 10)
          }
        }
      }
    };

    expect(auditLocalEnergyImport(targetRoom, { sourceRoom: 'E26S49', storedEnergy: 100 })).toMatchObject({
      enabled: true,
      sourceRoomAllowed: true,
      localEnergy: 550,
      importThreshold: 500,
      localEnergyDeficit: 0,
      localHarvestSufficient: true,
      shouldImport: false,
      reason: 'local-harvest-sufficient'
    });
  });

  it('audits E26S50 local energy as sufficient before importing from E26S49', () => {
    const sourceContainer = makeContainer('E26S50-source-container', 450, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S50',
      storageEnergy: 100,
      structures: [sourceContainer]
    });
    installGame([targetRoom], []);
    Memory.economy = {
      sourceWorkloads: {
        E26S50: {
          updatedAt: 100,
          sources: {
            'E26S50-source': makeSourceWorkload('E26S50-source', 10, 10)
          }
        }
      }
    };

    expect(auditLocalEnergyImport(targetRoom, { sourceRoom: 'E26S49', storedEnergy: 100 })).toMatchObject({
      enabled: true,
      sourceRoomAllowed: true,
      localEnergy: 550,
      importThreshold: 500,
      localEnergyDeficit: 0,
      localHarvestSufficient: true,
      shouldImport: false,
      reason: 'local-harvest-sufficient'
    });
  });

  it('suppresses routine E26S49 to E26S48 transfers when local harvesting is sufficient', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    const sourceContainer = makeContainer('E26S48-source-container', 450, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      structures: [sourceContainer]
    });
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom)]);
    Memory.economy = {
      sourceWorkloads: {
        E26S48: {
          updatedAt: 100,
          sources: {
            'E26S48-source': makeSourceWorkload('E26S48-source', 10, 10)
          }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.E26S48).toMatchObject({
      mode: 'import',
      importDemand: 200
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
    expect(planCrossRoomHauler()).toBeNull();
  });

  it('routes E26S49 surplus to E26S50 when E26S48 local-first energy is sufficient', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    const e26s48SourceContainer = makeContainer('E26S48-source-container', 450, 2_000);
    const localFirstRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      structures: [e26s48SourceContainer]
    });
    const e26s50Room = makeOwnedRoom({
      roomName: 'E26S50',
      storageEnergy: 100
    });
    installGame([sourceRoom, localFirstRoom, e26s50Room], [makeSpawn('Spawn1', sourceRoom)]);
    Memory.economy = {
      sourceWorkloads: {
        E26S48: {
          updatedAt: 100,
          sources: {
            'E26S48-source': makeSourceWorkload('E26S48-source', 10, 10)
          }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E26S49', targetRoom: 'E26S50', amount: 150, updatedAt: 100 }
    ]);
    expect(Memory.economy?.multiRoomEnergy?.rooms.E26S48).toMatchObject({
      localProductionEnergyPerTick: 10,
      localHarvestCapacityEnergyPerTick: 10,
      localHarvestCoverageRatio: 1,
      suppressedImportEnergy: 150,
      bottleneck: 'local-first-sufficient'
    });
    expect(Memory.economy?.multiRoomEnergy?.rooms.E26S49).toMatchObject({
      plannedExportEnergy: 150,
      surplusEnergy: 0
    });
    expect(Memory.economy?.multiRoomEnergy?.rooms.E26S50).toMatchObject({
      importDemand: 200,
      plannedImportEnergy: 150,
      storageDeficit: 50,
      deficitEnergy: 50
    });
    expect(Memory.economy?.multiRoomEnergy?.transfers).toEqual([
      {
        sourceRoom: 'E26S49',
        targetRoom: 'E26S48',
        amount: 150,
        status: 'suppressed',
        reason: 'local-first-sufficient',
        updatedAt: 100
      },
      {
        sourceRoom: 'E26S49',
        targetRoom: 'E26S50',
        amount: 150,
        status: 'planned',
        reason: 'storage-balance',
        updatedAt: 100
      },
      {
        targetRoom: 'E26S50',
        amount: 50,
        status: 'blocked',
        reason: 'insufficient-exportable-energy',
        updatedAt: 100
      }
    ]);
    expect(planCrossRoomHauler()?.memory.crossRoomHauler).toMatchObject({
      homeRoom: 'E26S49',
      targetRoom: 'E26S50'
    });
  });

  it('tracks local production, local consumption, and deficits in spawn forecasts', () => {
    const roomCreeps: Creep[] = [];
    const room = makeOwnedRoom({
      roomName: 'E26S50',
      storageEnergy: 100,
      myCreeps: roomCreeps
    });
    const builder = makeWorker('builder-E26S50', room, { type: 'build', targetId: 'site1' as Id<ConstructionSite> }, 2);
    roomCreeps.push(builder);
    installGame([room], [], { [builder.name]: builder });
    Memory.economy = {
      sourceWorkloads: {
        E26S50: {
          updatedAt: 100,
          sources: {
            'E26S50-source': makeSourceWorkload('E26S50-source', 8, 10)
          }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.multiRoomEnergy?.rooms.E26S50).toMatchObject({
      localProductionEnergyPerTick: 8,
      localHarvestCapacityEnergyPerTick: 10,
      localHarvestCoverageRatio: 0.8,
      localConsumptionEnergyPerTick: 10,
      netLocalEnergyPerTick: -2,
      importDemand: 200,
      storageDeficit: 200,
      deficitEnergy: 200,
      blockedImportEnergy: 200,
      bottleneck: 'no-exporter'
    });
    expect(getSpawnEnergyForecast(makeColony(room))).toMatchObject({
      roomName: 'E26S50',
      localProductionEnergyPerTick: 8,
      localConsumptionEnergyPerTick: 10,
      netLocalEnergyPerTick: -2,
      deficitEnergy: 200
    });
  });

  it('imports to E26S48 when local energy falls below the configured threshold', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    const sourceContainer = makeContainer('E26S48-source-container', 450, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      structures: [sourceContainer]
    });
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom)]);
    Memory.economy = {
      energyIndependence: {
        rooms: {
          E26S48: {
            importThreshold: 700
          }
        }
      },
      sourceWorkloads: {
        E26S48: {
          updatedAt: 100,
          sources: {
            'E26S48-source': makeSourceWorkload('E26S48-source', 10, 10)
          }
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E26S49', targetRoom: 'E26S48', amount: 150, updatedAt: 100 }
    ]);
    expect(planCrossRoomHauler()?.memory.crossRoomHauler).toMatchObject({
      homeRoom: 'E26S49',
      targetRoom: 'E26S48'
    });
  });

  it('reuses the E26S48 local energy structure scan across multiple storage exporters', () => {
    const primarySourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    const secondarySourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 800 });
    const sourceContainer = makeContainer('E26S48-source-container', 100, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      structures: [sourceContainer]
    });
    installGame([primarySourceRoom, secondarySourceRoom, targetRoom], []);
    Memory.economy = {
      energyIndependence: {
        rooms: {
          E26S48: {
            importThreshold: 700,
            sourceRooms: ['E26S49', 'W1N1']
          }
        }
      }
    };

    balanceStorage();

    const targetFind = targetRoom.find as jest.Mock;
    const structureScanCount = targetFind.mock.calls.filter(([type]) => type === FIND_STRUCTURES).length;
    expect(structureScanCount).toBe(1);
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E26S49', targetRoom: 'E26S48', amount: 150, updatedAt: 100 },
      { sourceRoom: 'W1N1', targetRoom: 'E26S48', amount: 50, updatedAt: 100 }
    ]);
  });

  it('preserves E26S48 emergency imports for spawn collapse prevention', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    const targetOwnedStructures: AnyOwnedStructure[] = [];
    const sourceContainer = makeContainer('E26S48-source-container', 600, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      energyAvailable: 100,
      energyCapacityAvailable: 800,
      myStructures: targetOwnedStructures,
      structures: [sourceContainer]
    });
    const targetSpawn = makeSpawn('Spawn2', targetRoom, 200);
    targetOwnedStructures.push(targetSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom), targetSpawn]);
    Memory.economy = {
      sourceWorkloads: {
        E26S48: {
          updatedAt: 100,
          sources: {
            'E26S48-source': makeSourceWorkload('E26S48-source', 10, 10)
          }
        }
      }
    };

    balanceStorage();

    expect(auditLocalEnergyImport(targetRoom, { sourceRoom: 'E26S49', storedEnergy: 100 })).toMatchObject({
      localEnergy: 700,
      localEnergyDeficit: 0,
      localHarvestSufficient: true,
      spawnCollapseRisk: true,
      shouldImport: true,
      reason: 'spawn-collapse-risk'
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E26S49', targetRoom: 'E26S48', amount: 150, updatedAt: 100 }
    ]);
  });

  it('treats unmet spawn queue reservations as local-first import pressure', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    const targetOwnedStructures: AnyOwnedStructure[] = [];
    const sourceContainer = makeContainer('E26S48-source-container', 450, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      energyAvailable: 300,
      energyCapacityAvailable: 650,
      myStructures: targetOwnedStructures,
      structures: [sourceContainer]
    });
    const targetSpawn = makeSpawn('Spawn2', targetRoom, 0);
    targetOwnedStructures.push(targetSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom), targetSpawn]);
    Memory.economy = {
      sourceWorkloads: {
        E26S48: {
          updatedAt: 100,
          sources: {
            'E26S48-source': makeSourceWorkload('E26S48-source', 10, 10)
          }
        }
      },
      spawnEnergyReservation: {
        updatedAt: 99,
        rooms: {
          E26S48: {
            bodyCost: 650,
            creepName: 'worker-E26S48-101',
            reservedAt: 99,
            reservedEnergy: 650,
            role: 'worker',
            roomName: 'E26S48',
            updatedAt: 99
          }
        }
      }
    };

    expect(auditLocalEnergyImport(targetRoom, { sourceRoom: 'E26S49', storedEnergy: 100 })).toMatchObject({
      localEnergy: 550,
      localEnergyDeficit: 0,
      localHarvestSufficient: true,
      spawnCollapseRisk: true,
      shouldImport: true,
      reason: 'spawn-collapse-risk'
    });
  });

  it('plans a proportional CARRY/MOVE hauler from a surplus room to a deficit room', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 800 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, targetRoom], [sourceSpawn]);
    balanceStorage();

    const plan = planCrossRoomHauler();

    expect(plan).toMatchObject({
      spawn: sourceSpawn,
      body: ['carry', 'move', 'carry', 'move', 'carry', 'move'],
      name: 'crossRoomHauler-W1N1-W2N1-100',
      memory: {
        role: CROSS_ROOM_HAULER_ROLE,
        colony: 'W1N1',
        crossRoomHauler: {
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          sourceId: 'W1N1-storage',
          state: 'collecting',
          route: ['W2N1']
        }
      }
    });
    expect(buildCrossRoomHaulerBody(800, 150)).toEqual(plan?.body);
  });

  it('selects the nearest eligible source store for an E26S49 to E26S48 hauler', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    (sourceRoom as { terminal?: StructureTerminal }).terminal = makeTerminal('E26S49-terminal', 850, 1_000, 2, 2);
    const targetRoom = makeOwnedRoom({ roomName: 'E26S48', storageEnergy: 100 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom, 0, 1, 1);
    installGame([sourceRoom, targetRoom], [sourceSpawn]);
    Memory.economy = {
      energyIndependence: {
        rooms: {
          E26S48: {
            importThreshold: 2_000
          }
        }
      }
    };
    balanceStorage();

    const plan = planCrossRoomHauler();

    expect(plan?.memory.crossRoomHauler).toMatchObject({
      homeRoom: 'E26S49',
      targetRoom: 'E26S48',
      sourceId: 'E26S49-terminal'
    });
  });

  it('plans cross-room hauling through neutral transit rooms', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 800 });
    const transitRoom = makeNeutralRoom('W2N1');
    const targetRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 100 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, transitRoom, targetRoom], [sourceSpawn], {}, (fromRoom, toRoom, options) => {
      const route = [
        { exit: 1, room: 'W2N1' },
        { exit: 1, room: toRoom }
      ];
      if (route.some((step) => options?.routeCallback?.(step.room, fromRoom) === Infinity)) {
        return ERR_NO_PATH_CODE;
      }

      return route;
    });
    balanceStorage();

    const plan = planCrossRoomHauler();

    expect(plan?.memory.crossRoomHauler?.route).toEqual(['W2N1', 'W3N1']);
  });

  it('prioritizes cross-room transfers by round-trip energy efficiency', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 1_600, energyAvailable: 800 });
    const nearTargetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 0, storageCapacity: 1_000 });
    const farTargetRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 0, storageCapacity: 2_000 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, nearTargetRoom, farTargetRoom], [sourceSpawn], {}, (_fromRoom, toRoom) => {
      const routeRooms = toRoom === 'W3N1' ? ['Transit0', 'Transit1', 'Transit2', toRoom] : [toRoom];
      return routeRooms.map((room) => ({ exit: 1, room }));
    });
    balanceStorage();

    const plan = planCrossRoomHauler();

    expect(plan?.memory.crossRoomHauler).toMatchObject({
      targetRoom: 'W2N1',
      route: ['W2N1']
    });
  });

  it('keeps home-room imports ahead of a larger distant-room deficit', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S50', storageEnergy: 950, energyAvailable: 800 });
    const homeRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 100 });
    const distantRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 0,
      storageCapacity: 2_000
    });
    installGame([sourceRoom, homeRoom, distantRoom], []);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E26S50', targetRoom: 'E26S49', amount: 150, updatedAt: 100 }
    ]);
  });

  it('prioritizes controller-progress import rooms before larger routine deficits', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 800 });
    const upgradeRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    const routineRoom = makeOwnedRoom({
      roomName: 'W3N1',
      storageEnergy: 0,
      storageCapacity: 2_000
    });
    installGame([sourceRoom, upgradeRoom, routineRoom], []);
    Memory.territory = {
      controllers: {
        W2N1: {
          roomName: 'W2N1',
          controllerId: 'W2N1-controller' as Id<StructureController>,
          signNeeded: false,
          upgradePriority: 'rclProgress',
          desiredUpgraderCount: 1,
          activeUpgraderCount: 0,
          updatedAt: 100
        }
      }
    };

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 150, updatedAt: 100 }
    ]);
  });

  it('imports for a local-first room when its visible source workload is depleted', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950, energyAvailable: 800 });
    const sourceContainer = makeContainer('E26S48-source-container', 600, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      structures: [sourceContainer]
    });
    installGame([sourceRoom, targetRoom], []);
    Memory.economy = {
      sourceWorkloads: {
        E26S48: {
          updatedAt: 100,
          sources: {
            'E26S48-source': makeSourceWorkload('E26S48-source', 0, 0)
          }
        }
      }
    };

    balanceStorage();

    expect(auditLocalEnergyImport(targetRoom, { sourceRoom: 'E26S49', storedEnergy: 100 })).toMatchObject({
      localEnergy: 700,
      localHarvestSufficient: false,
      shouldImport: true,
      reason: 'local-harvest-insufficient'
    });
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'E26S49', targetRoom: 'E26S48', amount: 150, updatedAt: 100 }
    ]);
  });

  it('skips unreachable import rooms without consuming exporter budget', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 800 });
    const unreachableRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    const reachableRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 100 });
    installGame([sourceRoom, unreachableRoom, reachableRoom], [], {}, (_fromRoom, toRoom) => {
      if (toRoom === 'W2N1') {
        return ERR_NO_PATH_CODE;
      }

      return [{ exit: 1, room: toRoom }];
    });

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W1N1', targetRoom: 'W3N1', amount: 150, updatedAt: 100 }
    ]);
    expect(Memory.economy?.multiRoomEnergy?.transfers).toEqual([
      {
        targetRoom: 'W2N1',
        amount: 200,
        status: 'blocked',
        reason: 'no-path',
        updatedAt: 100
      },
      {
        sourceRoom: 'W1N1',
        targetRoom: 'W3N1',
        amount: 150,
        status: 'planned',
        reason: 'storage-balance',
        updatedAt: 100
      },
      {
        targetRoom: 'W3N1',
        amount: 50,
        status: 'blocked',
        reason: 'insufficient-exportable-energy',
        updatedAt: 100
      }
    ]);
  });

  it('selects nearer exporter rooms before larger distant exporter stores', () => {
    const distantSourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 1_900,
      storageCapacity: 2_000,
      energyAvailable: 800
    });
    const nearSourceRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 950, energyAvailable: 800 });
    const targetRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 100 });
    installGame([distantSourceRoom, nearSourceRoom, targetRoom], [], {}, (fromRoom, toRoom) => {
      const routeRooms = fromRoom === 'W1N1' && toRoom === 'W3N1'
        ? ['W1N2', 'W1N3', 'W3N1']
        : [toRoom];
      return routeRooms.map((room) => ({ exit: 1, room }));
    });

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W2N1', targetRoom: 'W3N1', amount: 150, updatedAt: 100 },
      { sourceRoom: 'W1N1', targetRoom: 'W3N1', amount: 50, updatedAt: 100 }
    ]);
  });

  it('does not spawn a hauler for a stale transfer whose source storage is empty', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 0, energyAvailable: 800 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom)]);
    Memory.economy = {
      storageBalance: {
        updatedAt: 100,
        rooms: {},
        transfers: [{ sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 100, updatedAt: 100 }]
      }
    };

    expect(planCrossRoomHauler()).toBeNull();
  });

  it('does nothing when all owned rooms are balanced', () => {
    const roomA = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 500 });
    const roomB = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 400 });
    installGame([roomA, roomB], [makeSpawn('Spawn1', roomA), makeSpawn('Spawn2', roomB)]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
    expect(planCrossRoomHauler()).toBeNull();
  });

  it('degrades to no-op when only one room is owned', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    installGame([sourceRoom], [makeSpawn('Spawn1', sourceRoom)]);

    balanceStorage();

    expect(Memory.economy?.storageBalance?.rooms.W1N1?.mode).toBe('export');
    expect(Memory.economy?.storageBalance?.transfers).toEqual([]);
    expect(planCrossRoomHauler()).toBeNull();
  });

  it('rejects cross-room hauling through hostile owned rooms', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const hostileTransitRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 500,
      hostileCreeps: [{} as Creep]
    });
    const targetRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 100 });
    const sourceSpawn = makeSpawn('Spawn1', sourceRoom);
    installGame([sourceRoom, hostileTransitRoom, targetRoom], [sourceSpawn], {}, (fromRoom, toRoom, options) => {
      const route = [
        { exit: 1, room: 'W2N1' },
        { exit: 1, room: toRoom }
      ];
      if (route.some((step) => options?.routeCallback?.(step.room, fromRoom) === Infinity)) {
        return ERR_NO_PATH_CODE;
      }

      return route;
    });
    balanceStorage();

    expect(planCrossRoomHauler()).toBeNull();
  });

  it('suppresses routine worker spawning in an importing deficit room', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn2', targetRoom);
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom), targetSpawn]);
    balanceStorage();
    const targetColony = makeColony(targetRoom, [targetSpawn]);

    expect(planSpawn(targetColony, { worker: 3, workerCapacity: 2 }, 101)).toBeNull();
  });

  it('keeps worker recovery active in importing rooms with zero worker capacity', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn2', targetRoom);
    installGame([sourceRoom, targetRoom], [makeSpawn('Spawn1', sourceRoom), targetSpawn]);
    balanceStorage();
    const targetColony = makeColony(targetRoom, [targetSpawn]);

    expect(planSpawn(targetColony, { worker: 3, workerCapacity: 0 }, 102)).toEqual({
      spawn: targetSpawn,
      body: SCALED_WORKER_300,
      name: 'worker-W2N1-102',
      memory: { role: 'worker', colony: 'W2N1' }
    });
  });

  it('does not suppress local workers for impossible cross-room transfer lanes', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn2', targetRoom);
    installGame(
      [sourceRoom, targetRoom],
      [makeSpawn('Spawn1', sourceRoom), targetSpawn],
      {},
      () => ERR_NO_PATH_CODE
    );
    balanceStorage();
    const targetColony = makeColony(targetRoom, [targetSpawn]);

    expect(planSpawn(targetColony, { worker: 3, workerCapacity: 2 }, 103)).toEqual({
      spawn: targetSpawn,
      body: SCALED_WORKER_300,
      name: 'worker-W2N1-103',
      memory: { role: 'worker', colony: 'W2N1' }
    });
  });

  it('orders spawn planning by effective energy after planned transfers', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950, energyAvailable: 900 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100, energyAvailable: 300 });
    const balancedRoom = makeOwnedRoom({ roomName: 'W3N1', storageEnergy: 500, energyAvailable: 500 });
    installGame([sourceRoom, targetRoom, balancedRoom], []);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        storageBalance: {
          updatedAt: 100,
          rooms: {},
          transfers: [{ sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 600, updatedAt: 100 }]
        }
      }
    };
    const colonies = [
      makeColony(sourceRoom),
      makeColony(targetRoom),
      makeColony(balancedRoom)
    ];

    expect(getSpawnEnergyForecast(colonies[0])).toMatchObject({
      roomName: 'W1N1',
      effectiveEnergyAvailable: 300
    });
    expect(orderColoniesForSpawnPlanning(colonies).map((colony) => colony.room.name)).toEqual([
      'W2N1',
      'W3N1',
      'W1N1'
    ]);
  });

  it('withdraws from the source room and delivers to spawn energy demand', () => {
    let carriedEnergy = 0;
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetOwnedStructures: AnyOwnedStructure[] = [];
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 100,
      myStructures: targetOwnedStructures
    });
    const targetSpawn = makeSpawn('Spawn2', targetRoom, 300);
    targetOwnedStructures.push(targetSpawn as unknown as AnyOwnedStructure);
    installGame([sourceRoom, targetRoom], [targetSpawn]);
    const creep = makeCrossRoomHauler({
      room: sourceRoom,
      carriedEnergy: () => carriedEnergy,
      withdraw: jest.fn(() => {
        carriedEnergy = 100;
        return OK_CODE;
      }),
      transfer: jest.fn(() => {
        carriedEnergy = 0;
        return OK_CODE;
      })
    });

    runCrossRoomHauler(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(sourceRoom.storage, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'W1N1-storage' });

    creep.room = targetRoom;
    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(targetSpawn, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'Spawn2' });
  });

  it('falls back to deficit-room containers when spawn and extensions are full', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const container = makeContainer('W2N1-container', 0, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 100,
      structures: [container]
    });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'W2N1-container' });
  });

  it('delivers imported energy to the nearest same-priority target in E26S48', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950 });
    const farContainer = makeContainer('E26S48-a-container', 0, 2_000, 20, 20);
    const nearContainer = makeContainer('E26S48-z-container', 0, 2_000, 2, 2);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 1_000,
      structures: [farContainer, nearContainer]
    });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE),
      pos: makeRoomPosition(1, 1, 'E26S48')
    });
    creep.memory.colony = 'E26S49';
    creep.memory.crossRoomHauler = {
      homeRoom: 'E26S49',
      targetRoom: 'E26S48',
      sourceId: 'E26S49-storage' as Id<AnyStoreStructure>,
      state: 'delivering',
      route: ['E26S48']
    };

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(nearContainer, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'E26S48-z-container' });
  });

  it('delivers imported energy to a claimed-room tower before durable storage', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950 });
    const tower = makeTower('E26S48-tower', 100, 900);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      myStructures: [tower as unknown as AnyOwnedStructure]
    });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });
    creep.memory.colony = 'E26S49';
    creep.memory.crossRoomHauler = {
      homeRoom: 'E26S49',
      targetRoom: 'E26S48',
      sourceId: 'E26S49-storage' as Id<AnyStoreStructure>,
      state: 'delivering',
      route: ['E26S48']
    };

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'E26S48-tower' });
  });

  it('delivers imported energy to a tower before a container fallback with an earlier id', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'E26S49', storageEnergy: 950 });
    const tower = makeTower('E26S48-z-tower', 100, 900);
    const container = makeContainer('E26S48-a-container', 0, 2_000);
    const targetRoom = makeOwnedRoom({
      roomName: 'E26S48',
      storageEnergy: 100,
      myStructures: [tower as unknown as AnyOwnedStructure],
      structures: [container as unknown as Structure]
    });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });
    creep.memory.colony = 'E26S49';
    creep.memory.crossRoomHauler = {
      homeRoom: 'E26S49',
      targetRoom: 'E26S48',
      sourceId: 'E26S49-storage' as Id<AnyStoreStructure>,
      state: 'delivering',
      route: ['E26S48']
    };

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'E26S48-z-tower' });
  });

  it('delivers to deficit-room storage when transient sinks are unavailable', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(targetRoom.storage, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'W2N1-storage' });
  });

  it('delivers to deficit-room terminal when storage is full', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 1_000,
      terminalEnergy: 100,
      terminalCapacity: 1_000
    });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 100,
      transfer: jest.fn(() => OK_CODE)
    });

    runCrossRoomHauler(creep);

    expect(creep.transfer).toHaveBeenCalledWith(targetRoom.terminal, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'W2N1-terminal' });
  });

  it('returns home when empty and the source room no longer has surplus', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 700 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], []);
    const moveTo = jest.fn();
    const creep = makeCrossRoomHauler({
      room: targetRoom,
      carriedEnergy: () => 0,
      moveTo
    });

    runCrossRoomHauler(creep);

    expect(creep.memory.crossRoomHauler?.state).toBe('returning');
    expect(moveTo).toHaveBeenCalledWith(sourceRoom.controller, { reusePath: 20, ignoreRoads: false });
  });

  it('reassigns to a non-empty source when the assigned source is dry', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 950
    });
    (sourceRoom as { terminal?: StructureTerminal }).terminal = makeTerminal('W1N1-terminal', 0, 0);
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: sourceRoom,
      carriedEnergy: () => 0
    });
    creep.memory.crossRoomHauler!.sourceId = 'W1N1-terminal' as Id<AnyStoreStructure>;

    runCrossRoomHauler(creep);

    expect(creep.memory.crossRoomHauler?.state).toBe('collecting');
    expect(creep.memory.crossRoomHauler?.sourceId).toBe('W1N1-storage');
    expect(creep.withdraw).toHaveBeenCalledWith(sourceRoom.storage, RESOURCE_ENERGY);
    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'W1N1-storage' });
  });

  it('keeps a dry hauler memory valid while waiting for a source to recover', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 0 });
    (sourceRoom as { terminal?: StructureTerminal }).terminal = makeTerminal('W1N1-terminal', 0, 0);
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: sourceRoom,
      carriedEnergy: () => 0
    });
    creep.memory.crossRoomHauler!.sourceId = 'W1N1-terminal' as Id<AnyStoreStructure>;

    runCrossRoomHauler(creep);

    expect(creep.memory.crossRoomHauler).toMatchObject({
      state: 'unassigned',
      sourceId: null
    });
    expect(creep.withdraw).not.toHaveBeenCalled();
  });

  it('recovers an unassigned hauler source before collecting again', () => {
    const sourceRoom = makeOwnedRoom({ roomName: 'W1N1', storageEnergy: 950 });
    const targetRoom = makeOwnedRoom({ roomName: 'W2N1', storageEnergy: 100 });
    installGame([sourceRoom, targetRoom], []);
    const creep = makeCrossRoomHauler({
      room: sourceRoom,
      carriedEnergy: () => 0
    });
    delete (creep.memory.crossRoomHauler as Partial<CreepCrossRoomHaulerMemory>).sourceId;
    creep.memory.crossRoomHauler!.state = 'returning';

    runCrossRoomHauler(creep);

    expect(creep.memory.crossRoomHauler?.state).toBe('collecting');
    expect(creep.memory.crossRoomHauler?.sourceId).toBe('W1N1-storage');
    expect(creep.withdraw).toHaveBeenCalledWith(sourceRoom.storage, RESOURCE_ENERGY);
  });

  function makeOwnedRoom({
    roomName,
    storageEnergy,
    storageCapacity = 1_000,
    terminalEnergy = 0,
    terminalCapacity = 0,
    energyAvailable = 800,
    energyCapacityAvailable = 800,
    myStructures = [],
    structures = [],
    hostileCreeps = [],
    hostileStructures = [],
    myCreeps = []
  }: {
    roomName: string;
    storageEnergy: number;
    storageCapacity?: number;
    terminalEnergy?: number;
    terminalCapacity?: number;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    myStructures?: AnyOwnedStructure[];
    structures?: Structure[];
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
    myCreeps?: Creep[];
  }): Room {
    const controller = { id: `${roomName}-controller`, my: true, level: 4 } as StructureController;
    registerObject(controller);
    const room = {
      name: roomName,
      energyAvailable,
      energyCapacityAvailable,
      controller,
      memory: {},
      storage: makeStorage(`${roomName}-storage`, storageEnergy, storageCapacity),
      ...(terminalCapacity > 0 ? { terminal: makeTerminal(`${roomName}-terminal`, terminalEnergy, terminalCapacity) } : {}),
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return myStructures;
        }

        if (type === FIND_STRUCTURES) {
          return structures;
        }

        if (type === FIND_HOSTILE_CREEPS) {
          return hostileCreeps;
        }

        if (type === FIND_HOSTILE_STRUCTURES) {
          return hostileStructures;
        }

        if (type === FIND_SOURCES) {
          return [{ id: `${roomName}-source` } as Source];
        }

        if (type === FIND_MY_CREEPS) {
          return myCreeps;
        }

        return [];
      })
    } as unknown as Room;

    return room;
  }

  function makeNeutralRoom(roomName: string): Room {
    const controller = { id: `${roomName}-controller`, my: false } as StructureController;
    registerObject(controller);
    const room = {
      name: roomName,
      energyAvailable: 0,
      energyCapacityAvailable: 0,
      controller,
      memory: {},
      find: jest.fn(() => [])
    } as unknown as Room;

    return room;
  }

  function makeColony(room: Room, spawns: StructureSpawn[] = []): ColonySnapshot {
    return {
      room,
      spawns,
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable,
      spawnEnergyBudget: room.energyAvailable
    };
  }

  function makeSpawn(name: string, room: Room, freeCapacity = 0, x = 10, y = 10): StructureSpawn {
    const spawn = {
      id: name,
      name,
      room,
      pos: makeRoomPosition(x, y, room.name),
      structureType: 'spawn',
      spawning: null,
      store: makeStore(300 - freeCapacity, 300)
    } as unknown as StructureSpawn;
    registerObject(spawn);
    return spawn;
  }

  function makeContainer(id: string, energy: number, capacity: number, x = 10, y = 10): StructureContainer {
    const container = {
      id,
      pos: makeRoomPosition(x, y, getRoomNameFromObjectId(id)),
      structureType: 'container',
      store: makeStore(energy, capacity)
    } as unknown as StructureContainer;
    registerObject(container);
    return container;
  }

  function makeTower(id: string, energy: number, capacity: number, x = 10, y = 10): StructureTower {
    const tower = {
      id,
      pos: makeRoomPosition(x, y, getRoomNameFromObjectId(id)),
      structureType: 'tower',
      store: makeStore(energy, capacity)
    } as unknown as StructureTower;
    registerObject(tower);
    return tower;
  }

  function makeStorage(id: string, energy: number, capacity: number, x = 10, y = 10): StructureStorage {
    const storage = {
      id,
      pos: makeRoomPosition(x, y, getRoomNameFromObjectId(id)),
      structureType: 'storage',
      store: makeStore(energy, capacity)
    } as unknown as StructureStorage;
    registerObject(storage);
    return storage;
  }

  function makeTerminal(id: string, energy: number, capacity: number, x = 10, y = 10): StructureTerminal {
    const terminal = {
      id,
      pos: makeRoomPosition(x, y, getRoomNameFromObjectId(id)),
      structureType: 'terminal',
      store: makeStore(energy, capacity)
    } as unknown as StructureTerminal;
    registerObject(terminal);
    return terminal;
  }

  function makeStore(energy: number, capacity: number): StoreDefinition {
    return {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
      getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY ? Math.max(0, capacity - energy) : 0
      )
    } as unknown as StoreDefinition;
  }

  function makeCrossRoomHauler({
    room,
    carriedEnergy,
    withdraw = jest.fn(() => OK_CODE),
    transfer = jest.fn(() => OK_CODE),
    moveTo = jest.fn(),
    pos = makeRoomPosition(1, 1, room.name)
  }: {
    room: Room;
    carriedEnergy: () => number;
    withdraw?: jest.Mock;
    transfer?: jest.Mock;
    moveTo?: jest.Mock;
    pos?: RoomPosition;
  }): Creep {
    return {
      pos,
      room,
      memory: {
        role: CROSS_ROOM_HAULER_ROLE,
        colony: 'W1N1',
        crossRoomHauler: {
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          sourceId: 'W1N1-storage' as Id<AnyStoreStructure>,
          state: 'collecting',
          route: ['W2N1']
        }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? carriedEnergy() : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 200 - carriedEnergy() : 0))
      },
      withdraw,
      transfer,
      moveTo
    } as unknown as Creep;
  }

  function makeWorker(
    name: string,
    room: Room,
    task: CreepTaskMemory,
    activeWorkParts: number
  ): Creep {
    return {
      name,
      room,
      memory: {
        role: 'worker',
        colony: room.name,
        task
      },
      body: Array.from({ length: activeWorkParts }, () => ({ type: 'work', hits: 100 })),
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === WORK ? activeWorkParts : 0)),
      store: makeStore(50, 100)
    } as unknown as Creep;
  }

  function installGame(
    rooms: Room[],
    spawns: StructureSpawn[],
    creeps: Record<string, Creep> = {},
    findRoute: (
      fromRoom: string,
      toRoom: string,
      options?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
    ) => unknown = (_fromRoom, toRoom, options) => {
      if (options?.routeCallback?.(toRoom, _fromRoom) === Infinity) {
        return ERR_NO_PATH_CODE;
      }

      return [{ exit: 1, room: toRoom }];
    }
  ): void {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      rooms: Object.fromEntries(rooms.map((room) => [room.name, room])),
      spawns: Object.fromEntries(spawns.map((spawn) => [spawn.name, spawn])),
      creeps,
      getObjectById: jest.fn((id: string) => objectRegistry.get(id) ?? null) as Game['getObjectById'],
      map: { findRoute } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  }

  function registerObject(object: { id?: string }): void {
    if (typeof object.id === 'string') {
      objectRegistry.set(object.id, object);
    }
  }

  function makeSourceWorkload(sourceId: string, harvestEnergyPerTick: number, regenEnergyPerTick: number): EconomySourceWorkloadMemory {
    return {
      sourceId,
      assignedHarvesters: 1,
      assignedWorkParts: 5,
      openPositions: 3,
      harvestWorkCapacity: 5,
      harvestEnergyPerTick,
      regenEnergyPerTick,
      sourceEnergyCapacity: 3_000,
      sourceEnergyRegenTicks: 300,
      hasContainer: true,
      containerId: `${sourceId}-container`
    };
  }

  function makeRoomPosition(x: number, y: number, roomName: string): RoomPosition {
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

  function getRoomNameFromObjectId(id: string): string {
    return id.split('-')[0] || 'W1N1';
  }
});
