import { runWorker } from '../src/creeps/workerRunner';
import * as workerTaskPolicy from '../src/creeps/workerTaskPolicy';
import {
  WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD,
  WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN
} from '../src/creeps/workerTaskPolicy';
import * as workerTasks from '../src/tasks/workerTasks';
import {
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  CRITICAL_OWNED_RAMPART_REPAIR_HITS_CEILING,
  CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
  IDLE_RAMPART_REPAIR_HITS_CEILING,
  TOWER_REFILL_ENERGY_FLOOR,
  URGENT_SPAWN_REFILL_ENERGY_THRESHOLD
} from '../src/tasks/workerTasks';
import { BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING } from '../src/defense/defensePlanner';
import {
  assessColonySurvival,
  clearColonySurvivalAssessmentCache,
  recordColonySurvivalAssessment
} from '../src/colony/survivalMode';
import { OCCUPIED_CONTROLLER_SIGN_TEXT } from '../src/territory/controllerSigning';
import { TERRITORY_RESERVATION_RENEWAL_TICKS } from '../src/territory/territoryPlanner';
import { LOW_CPU_BUCKET_THRESHOLD } from '../src/runtime/cpuBudget';
import { installVisibleOwnedRcl6ColonyRoomDefault } from './helpers/territoryControlGate';
import { selectSpawnEnergyReservationRefillTarget } from '../src/economy/spawnEnergyReservation';
import { MINIMUM_WORKER_SPAWN_ENERGY } from '../src/economy/energyBuffer';

function withRangeTo<T extends { id: string }>(object: T, rangesByTargetId: Record<string, number>): T {
  return {
    ...object,
    pos: {
      getRangeTo: jest.fn((target: RoomObject) => rangesByTargetId[String((target as { id?: string }).id)] ?? 99)
    }
  };
}

function makeScoreTarget(id: string): RoomObject & { id: string; score: number; scoreType: string } {
  return {
    id,
    pos: { x: 12, y: 10, roomName: 'W1N1' } as RoomPosition,
    score: 100,
    scoreType: 'score'
  } as unknown as RoomObject & { id: string; score: number; scoreType: string };
}

function makeControllerSigningMemory(
  roomName: string,
  controllerId: Id<StructureController>,
  signNeeded = true
): Partial<Memory> {
  return {
    territory: {
      controllers: {
        [roomName]: {
          roomName,
          controllerId,
          signNeeded,
          upgradePriority: 'none',
          desiredUpgraderCount: 0,
          activeUpgraderCount: 0,
          updatedAt: 100
        }
      }
    }
  };
}

describe('runWorker', () => {
  beforeEach(() => {
    (globalThis as unknown as { ERR_NOT_IN_RANGE: number; ERR_FULL: number; ERR_NOT_ENOUGH_RESOURCES: number; ERR_INVALID_TARGET: number; RESOURCE_ENERGY: ResourceConstant; FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; FIND_MY_STRUCTURES: number; FIND_DROPPED_RESOURCES: number; FIND_STRUCTURES: number; STRUCTURE_SPAWN: StructureConstant; STRUCTURE_EXTENSION: StructureConstant; STRUCTURE_LINK: StructureConstant; STRUCTURE_ROAD: StructureConstant; STRUCTURE_CONTAINER: StructureConstant; STRUCTURE_STORAGE: StructureConstant; STRUCTURE_TERMINAL: StructureConstant; STRUCTURE_RAMPART: StructureConstant }).ERR_NOT_IN_RANGE = -9;
    (globalThis as unknown as { ERR_FULL: number }).ERR_FULL = -8;
    (globalThis as unknown as { ERR_NOT_ENOUGH_RESOURCES: number }).ERR_NOT_ENOUGH_RESOURCES = -6;
    (globalThis as unknown as { ERR_INVALID_TARGET: number }).ERR_INVALID_TARGET = -7;
    (globalThis as unknown as { ERR_NO_PATH: number }).ERR_NO_PATH = -2;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    delete (globalThis as unknown as { FIND_SCORE?: number }).FIND_SCORE;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_LINK: StructureConstant }).STRUCTURE_LINK = 'link';
    (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_RAMPART: StructureConstant }).STRUCTURE_RAMPART = 'rampart';
    (globalThis as unknown as { CLAIM: BodyPartConstant }).CLAIM = 'claim';
    delete (globalThis as unknown as { PathFinder?: Partial<PathFinder> }).PathFinder;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {} };
    installVisibleOwnedRcl6ColonyRoomDefault();
    clearColonySurvivalAssessmentCache();
  });

  it('assigns a task when the creep has none', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      memory: {},
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([source]) }
    } as unknown as Creep;

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('keeps an executable assigned harvest under critical CPU bucket without full task reselection', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([{ id: 'source2' }])
    } as unknown as Room;
    const harvest = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(room.find).not.toHaveBeenCalled();
    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(harvest).toHaveBeenCalledWith(source);
  });

  it('suppresses worker dispatch diagnostics during low-bucket recovery', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([source])
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 124,
      creeps: { Worker1: creep },
      cpu: {
        getUsed: jest.fn().mockReturnValue(18),
        limit: 70,
        bucket: 500,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.workerDispatchDiagnostic).toBeUndefined();
  });

  it('keeps an executable assigned repair under critical CPU bucket without full task reselection', () => {
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 100,
      controller: {
        my: true,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 100
      } as StructureController,
      find: jest.fn().mockReturnValue([{ id: 'extension-site1' }])
    } as unknown as Room;
    const repair = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'road1' ? road : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect((room.find as jest.Mock).mock.calls.some(([type]) => type === FIND_CONSTRUCTION_SITES)).toBe(false);
    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'road1' });
    expect(repair).toHaveBeenCalledWith(road);
  });

  it('preempts retained critical CPU routine repair when a near-floor owned rampart repair appears', () => {
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const rampart = {
      id: 'rampart1',
      structureType: 'rampart',
      my: true,
      hits: 10_001,
      hitsMax: 100_000
    } as StructureRampart;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 100,
      energyCapacityAvailable: 550,
      controller: {
        my: true,
        level: 3,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 100
      } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_STRUCTURES) {
          return [road, rampart];
        }

        return [];
      })
    } as unknown as Room;
    const repair = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      time: 126,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) =>
        id === 'rampart1' ? rampart : id === 'road1' ? road : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'rampart1' });
    expect(repair).toHaveBeenCalledWith(rampart);
    expect(repair).not.toHaveBeenCalledWith(road);
  });

  it('preempts retained critical CPU rampart repair for missing spawn construction', () => {
    const spawnSite = {
      id: 'spawn-site1',
      structureType: 'spawn',
      progress: 0,
      progressTotal: 15_000
    } as ConstructionSite;
    const rampart = {
      id: 'rampart1',
      structureType: 'rampart',
      my: true,
      hits: 10_001,
      hitsMax: 100_000
    } as StructureRampart;
    const room = {
      name: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: {
        my: true,
        level: 3,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 100
      } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return [];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [spawnSite];
        }

        if (type === FIND_STRUCTURES) {
          return [rampart];
        }

        return [];
      })
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const repair = jest.fn();
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'rampart1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      time: 127,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) =>
        id === 'rampart1' ? rampart : id === 'spawn-site1' ? spawnSite : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'spawn-site1' });
    expect(build).toHaveBeenCalledWith(spawnSite);
    expect(repair).not.toHaveBeenCalled();
  });

  it('pauses retained critical CPU repair when this worker must reserve energy for near-term spawn refill', () => {
    const busyFullSpawn = {
      id: 'spawn-busy',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller: {
        my: true,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 100
      } as StructureController,
      find: jest.fn((type: number) => (type === FIND_MY_STRUCTURES ? [busyFullSpawn] : []))
    } as unknown as Room;
    const repair = jest.fn().mockReturnValue(0);
    const getObjectById = jest.fn().mockReturnValue(road);
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      time: 125,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(getObjectById).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it('does not retain critical CPU repair work when the controller downgrade guard is active', () => {
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 100,
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const repair = jest.fn();
    const upgradeController = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) =>
        id === 'controller1' ? controller : id === 'road1' ? road : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(upgradeController).toHaveBeenCalledWith(controller);
    expect(repair).not.toHaveBeenCalled();
  });

  it('preempts retained critical CPU repair while spawn-critical hysteresis is active', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const room = {
      name: 'W1N1',
      energyAvailable: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD - 1,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const harvest = jest.fn().mockReturnValue(0);
    const repair = jest.fn();
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road1' as Id<Structure> },
        workerEnergyCriticalPolicy: {
          type: 'workerEnergyCriticalPolicy',
          schemaVersion: 1,
          active: true,
          reason: 'spawn',
          enteredAt: 700,
          updatedAt: 700,
          spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
          spawnEnterThreshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
          spawnExitThreshold: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(25),
        getFreeCapacity: jest.fn().mockReturnValue(25)
      },
      room,
      harvest,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      time: 701,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : road)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerEnergyCriticalPolicy).toMatchObject({
      active: true,
      reason: 'spawn',
      spawnEnergy: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD - 1
    });
    expect(harvest).toHaveBeenCalledWith(source);
    expect(repair).not.toHaveBeenCalled();
  });

  it('preempts retained critical CPU repair while storage-critical hysteresis is active', () => {
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN - 1),
        getFreeCapacity: jest.fn().mockReturnValue(1_000)
      }
    } as unknown as StructureStorage;
    const room = {
      name: 'W1N1',
      energyAvailable: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD,
      controller: {
        my: true,
        level: 3,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 100
      } as StructureController,
      storage,
      find: jest.fn((type: number) => (type === FIND_STRUCTURES ? [storage] : []))
    } as unknown as Room;
    const repair = jest.fn();
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road1' as Id<Structure> },
        workerEnergyCriticalPolicy: {
          type: 'workerEnergyCriticalPolicy',
          schemaVersion: 1,
          active: true,
          reason: 'storage',
          enteredAt: 700,
          updatedAt: 700,
          storageEnergy: 499,
          storageEnterThreshold: 500,
          storageExitThreshold: 500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      time: 701,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) =>
        id === 'storage1' ? storage : road
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'storage1' });
    expect(creep.memory.workerEnergyCriticalPolicy).toMatchObject({
      active: true,
      reason: 'storage',
      storageEnergy: 500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN - 1
    });
    expect(transfer).toHaveBeenCalledWith(storage, RESOURCE_ENERGY);
    expect(repair).not.toHaveBeenCalled();
  });

  it('keeps near-floor rampart repair during storage-critical hysteresis when carrying repair energy', () => {
    const rampart = {
      id: 'rampart-alert',
      structureType: 'rampart',
      my: true,
      hits: BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING - 1,
      hitsMax: 30_000_000
    } as StructureRampart;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN - 1),
        getFreeCapacity: jest.fn().mockReturnValue(100_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 100
    } as StructureController;
    const room = {
      name: 'E29N55',
      controller,
      energyAvailable: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD,
      energyCapacityAvailable: 2_300,
      storage,
      find: jest.fn((type: number) => (type === FIND_STRUCTURES ? [rampart, storage] : []))
    } as unknown as Room;
    const repair = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'RampartRepairer',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'repair', targetId: 'rampart-alert' as Id<Structure> },
        workerEnergyCriticalPolicy: {
          type: 'workerEnergyCriticalPolicy',
          schemaVersion: 1,
          active: true,
          reason: 'storage',
          enteredAt: 700,
          updatedAt: 700,
          storageEnergy: 499,
          storageEnterThreshold: 500,
          storageExitThreshold: 500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(100),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RampartRepairer: creep },
      time: 701,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 62,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) =>
        id === 'rampart-alert' ? rampart : id === 'storage1' ? storage : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'rampart-alert' });
    expect(creep.memory.workerEnergyCriticalPolicy).toMatchObject({
      active: true,
      reason: 'storage',
      storageEnergy: 500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN - 1
    });
    expect(repair).toHaveBeenCalledWith(rampart);
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each(['claim', 'reserve'] as const)(
    'drops a retained visible %s task under critical CPU when the home room fails the territory gate',
    (action) => {
      const controller = { id: 'controller2', my: false } as StructureController;
      const homeRoom = {
        name: 'W1N1',
        controller: { id: 'controller1', my: true, level: 4, owner: { username: 'me' } },
        find: jest.fn().mockReturnValue([])
      } as unknown as Room;
      const targetRoom = {
        name: 'W2N1',
        controller,
        find: jest.fn().mockReturnValue([])
      } as unknown as Room;
      const claimController = jest.fn().mockReturnValue(0);
      const reserveController = jest.fn().mockReturnValue(0);
      const attackController = jest.fn().mockReturnValue(0);
      const creep = {
        name: 'Worker1',
        owner: { username: 'me' },
        memory: {
          role: 'worker',
          colony: 'W1N1',
          territory: { targetRoom: 'W2N1', action },
          task: { type: action, targetId: 'controller2' as Id<StructureController> }
        },
        getActiveBodyparts: jest.fn().mockReturnValue(1),
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(0),
          getFreeCapacity: jest.fn().mockReturnValue(0)
        },
        room: targetRoom,
        claimController,
        reserveController,
        attackController,
        moveTo: jest.fn()
      } as unknown as Creep;
      (globalThis as unknown as { Game: Partial<Game> }).Game = {
        creeps: { Worker1: creep },
        rooms: { W1N1: homeRoom, W2N1: targetRoom },
        time: 127,
        cpu: {
          getUsed: jest.fn().mockReturnValue(21),
          limit: 70,
          bucket: 43,
          tickLimit: 500
        } as unknown as CPU,
        getObjectById: jest.fn((id: string) =>
          id === 'controller2' ? controller : null
        ) as unknown as Game['getObjectById']
      };

      runWorker(creep);

      expect(creep.memory.task).toBeUndefined();
      expect(creep.memory.territory).toBeUndefined();
      expect(claimController).not.toHaveBeenCalled();
      expect(reserveController).not.toHaveBeenCalled();
      expect(attackController).not.toHaveBeenCalled();
      expect(creep.moveTo).not.toHaveBeenCalled();
      expect(Memory.territory?.intents).toEqual([
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action,
          status: 'suppressed',
          updatedAt: 127,
          reason: 'controllerLevel'
        }
      ]);
    }
  );

  it.each(['claim', 'reserve'] as const)(
    'preserves a retained %s task under critical CPU when target lookup is temporarily unavailable',
    (action) => {
      const controller = { id: 'controller2', my: false } as StructureController;
      const room = {
        name: 'W2N1',
        controller,
        find: jest.fn().mockReturnValue([])
      } as unknown as Room;
      const claimController = jest.fn();
      const reserveController = jest.fn();
      const attackController = jest.fn();
      const moveTo = jest.fn();
      const creep = {
        name: 'Worker1',
        owner: { username: 'me' },
        memory: {
          role: 'worker',
          colony: 'W1N1',
          territory: { targetRoom: 'W2N1', action },
          task: { type: action, targetId: 'controller2' as Id<StructureController> }
        },
        getActiveBodyparts: jest.fn().mockReturnValue(1),
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(0),
          getFreeCapacity: jest.fn().mockReturnValue(0)
        },
        room,
        claimController,
        reserveController,
        attackController,
        moveTo
      } as unknown as Creep;
      const getObjectById = jest.fn().mockReturnValue(null);
      (globalThis as unknown as { Game: Partial<Game> }).Game = {
        creeps: { Worker1: creep },
        rooms: { W2N1: room },
        time: 128,
        cpu: {
          getUsed: jest.fn().mockReturnValue(21),
          limit: 70,
          bucket: 43,
          tickLimit: 500
        } as unknown as CPU,
        getObjectById
      };

      runWorker(creep);

      expect(getObjectById).toHaveBeenCalledWith('controller2');
      expect(creep.memory.task).toEqual({ type: action, targetId: 'controller2' });
      expect(claimController).not.toHaveBeenCalled();
      expect(reserveController).not.toHaveBeenCalled();
      expect(attackController).not.toHaveBeenCalled();
      expect(moveTo).not.toHaveBeenCalled();
    }
  );

  it('preempts loaded critical CPU harvest for emergency spawn refill', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      find: jest.fn(
        (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === FIND_SOURCES ? [source] : [];
        }
      )
    } as unknown as Room;
    const harvest = jest.fn();
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(30),
        getFreeCapacity: jest.fn().mockReturnValue(20)
      },
      room,
      harvest,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 124,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'spawn1' ? spawn : source)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
    expect(harvest).not.toHaveBeenCalled();
  });

  it.each([
    {
      taskName: 'build',
      task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> },
      target: { id: 'site1', structureType: 'road' } as ConstructionSite,
      action: 'build'
    },
    {
      taskName: 'repair',
      task: { type: 'repair', targetId: 'road1' as Id<Structure> },
      target: { id: 'road1', structureType: 'road', hits: 100, hitsMax: 5_000 } as StructureRoad,
      action: 'repair'
    },
    {
      taskName: 'upgrade',
      task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> },
      target: {
        id: 'controller1',
        my: true,
        level: 2,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
      } as StructureController,
      action: 'upgradeController'
    }
  ])('preempts loaded critical CPU $taskName for emergency spawn refill', ({ task, target, action }) => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1),
        getFreeCapacity: jest.fn().mockReturnValue(101)
      }
    } as unknown as StructureSpawn;
    const taskAction = jest.fn().mockReturnValue(0);
    const transfer = jest.fn().mockReturnValue(0);
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      energyCapacityAvailable: 550,
      controller: task.type === 'upgrade' ? target : undefined,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }
        if (type === FIND_CONSTRUCTION_SITES) {
          return task.type === 'build' ? [target] : [];
        }
        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      transfer,
      [action]: taskAction,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 126,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'spawn1' ? spawn : target)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
    expect(taskAction).not.toHaveBeenCalled();
  });

  it('pauses optional controller upgrading under critical CPU bucket pressure', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const room = {
      name: 'W1N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 800,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 25
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it('keeps downgrade guard upgrading under critical CPU bucket pressure', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const room = {
      name: 'W1N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const upgradeController = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 801,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 25
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(upgradeController).toHaveBeenCalledWith(controller);
  });

  it('keeps critical spawn refill assignment under critical CPU bucket pressure', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1),
        getFreeCapacity: jest.fn().mockReturnValue(101)
      }
    } as unknown as StructureSpawn;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      energyCapacityAvailable: 550,
      controller: {
        my: true,
        level: 3,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
      } as StructureController,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 802,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 25
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'spawn1' ? spawn : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
  });

  it('does not use the idle fallback to start noncritical harvest under critical CPU bucket pressure', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const room = {
      name: 'W1N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller: {
        my: true,
        level: 4,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
      } as StructureController,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const harvest = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        workerTaskSelectionNullLoop: {
          lastNullSelectionTick: 899,
          nullSelectionCount: 10,
          fallbackAttempts: 0,
          idleStartTick: 890
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 900,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 25
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(harvest).not.toHaveBeenCalled();
  });

  it('does not use the idle fallback to start noncritical harvest during low-bucket recovery', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const room = {
      name: 'W1N1',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller: {
        my: true,
        level: 4,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
      } as StructureController,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const harvest = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        workerTaskSelectionNullLoop: {
          lastNullSelectionTick: 899,
          nullSelectionCount: 10,
          fallbackAttempts: 0,
          idleStartTick: 890
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 900,
      cpu: {
        getUsed: jest.fn().mockReturnValue(18),
        limit: 70,
        bucket: 961,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(harvest).not.toHaveBeenCalled();
  });

  it('moves to collect a score target at exact range without pickup', () => {
    const score = makeScoreTarget('score1');
    const pickup = jest.fn();
    const moveTo = jest.fn();
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const creep = {
      name: 'ScoreWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'collectScore', targetId: 'score1' } as unknown as CreepTaskMemory
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'score1' ? 1 : 99)) },
      room,
      moveTo,
      pickup
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { ScoreWorker: creep },
      shard: { name: 'shardSeason' } as Game['shard'],
      getObjectById: jest.fn((id: string) => (id === 'score1' ? score : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(moveTo).toHaveBeenCalledWith(score, { range: 0 });
    expect(pickup).not.toHaveBeenCalled();
  });

  it('preempts assigned routine repair for visible season score collection', () => {
    (globalThis as unknown as { FIND_SCORE: number }).FIND_SCORE = 42;
    const score = makeScoreTarget('score1');
    const road = { id: 'road1', structureType: 'road', hits: 4_000, hitsMax: 5_000 } as StructureRoad;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 100,
      controller: {
        id: 'controller1',
        my: true,
        level: 3,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1_000
      } as StructureController,
      find: jest.fn((type: number) => {
        const findScore = (globalThis as unknown as { FIND_SCORE?: number }).FIND_SCORE;
        if (typeof findScore === 'number' && type === findScore) {
          return [score];
        }

        if (type === FIND_STRUCTURES) {
          return [road];
        }

        return [];
      })
    } as unknown as Room;
    const repair = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      name: 'RepairWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'score1' ? 4 : 1)) },
      room,
      repair,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RepairWorker: creep },
      shard: { name: 'shardSeason' } as Game['shard'],
      getObjectById: jest.fn((id: string) =>
        id === 'score1' ? score : id === 'road1' ? road : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'collectScore', targetId: 'score1' });
    expect(moveTo).toHaveBeenCalledWith(score, { range: 0 });
    expect(repair).not.toHaveBeenCalled();
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      reason: 'preempted_for_season_score',
      selectedTask: 'collectScore',
      assignedTask: 'collectScore'
    });
  });

  it('reselects when an assigned score target vanished before collection', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const harvest = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'ScoreWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'collectScore', targetId: 'score1' } as unknown as CreepTaskMemory
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room,
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { ScoreWorker: creep },
      shard: { name: 'shardSeason' } as Game['shard'],
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(harvest).toHaveBeenCalledWith(source);
  });

  it('preempts assigned score collection for emergency spawn refill', () => {
    (globalThis as unknown as { FIND_SCORE: number }).FIND_SCORE = 42;
    const score = makeScoreTarget('score1');
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(300)
      }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      energyAvailable: 0,
      energyCapacityAvailable: 300,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure | Creep) => boolean }) => {
        const findScore = (globalThis as unknown as { FIND_SCORE?: number }).FIND_SCORE;
        if (typeof findScore === 'number' && type === findScore) {
          return [score];
        }

        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as unknown as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_MY_CREEPS) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const transfer = jest.fn().mockReturnValue(0);
    const moveTo = jest.fn();
    const creep = {
      name: 'RefillWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'collectScore', targetId: 'score1' } as unknown as CreepTaskMemory
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) =>
          target.id === 'score1' ? 5 : target.id === 'spawn1' ? 1 : 99
        )
      },
      room,
      transfer,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RefillWorker: creep },
      shard: { name: 'shardSeason' } as Game['shard'],
      getObjectById: jest.fn((id: string) =>
        id === 'score1' ? score : id === 'spawn1' ? spawn : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
    expect(moveTo).not.toHaveBeenCalledWith(score, { range: 0 });
  });

  it('withdraws construction-buffer spawn energy for an idle builder', () => {
    const site = withRangeTo(
      { id: 'extension-site1', structureType: 'extension' } as ConstructionSite,
      { spawn1: 1 }
    );
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(300),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const withdraw = jest.fn().mockReturnValue(0);
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return type === FIND_STRUCTURES ? [spawn] : [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'spawn1',
      constructionSiteId: 'extension-site1'
    });
    expect(withdraw).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY, 50);
  });

  it('withdraws local storage energy for an empty retained secondary-room builder', () => {
    const site = withRangeTo(
      {
        id: 'extension-site1',
        my: true,
        structureType: 'extension',
        progress: 0,
        progressTotal: 3_000
      } as ConstructionSite,
      { storage1: 1 }
    );
    const storage = {
      id: 'storage1',
      my: true,
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_000 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const workers: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn((type: number, options?: { filter?: (object: AnyStructure | Creep) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_STRUCTURES) {
          return [storage];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? workers.filter(options.filter) : workers;
        }

        return [];
      })
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'worker-E29N57-builder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'build', targetId: 'extension-site1' as Id<ConstructionSite> }
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'storage1' ? 2 : 99)) },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(100)
      },
      room,
      build: jest.fn(),
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    workers.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { [creep.name]: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'extension-site1' ? site : id === 'storage1' ? storage : null
      )
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'storage1',
      constructionSiteId: 'extension-site1'
    });
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
    expect(creep.build).not.toHaveBeenCalled();
  });

  it('builds a retained secondary-room construction withdrawal after filling', () => {
    const site = withRangeTo(
      {
        id: 'extension-site1',
        my: true,
        structureType: 'extension',
        progress: 784,
        progressTotal: 1_000
      } as ConstructionSite,
      { storage1: 1 }
    );
    const storage = {
      id: 'storage1',
      my: true,
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_000 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const workers: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn((type: number, options?: { filter?: (object: AnyStructure | Creep) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_STRUCTURES) {
          return [storage];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? workers.filter(options.filter) : workers;
        }

        return [];
      })
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const withdraw = jest.fn();
    const creep = {
      name: 'worker-E29N57-builder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: {
          type: 'withdraw',
          targetId: 'storage1' as Id<AnyStoreStructure>,
          constructionSiteId: 'extension-site1' as Id<ConstructionSite>
        }
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'extension-site1' ? 2 : 99)) },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(100),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      withdraw,
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const coveringBuilder = {
      name: 'worker-E29N57-covering-builder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'build', targetId: 'extension-site1' as Id<ConstructionSite> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(55),
        getFreeCapacity: jest.fn().mockReturnValue(45)
      },
      room,
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    workers.push(creep, coveringBuilder);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 2126831,
      creeps: {
        [creep.name]: creep,
        [coveringBuilder.name]: coveringBuilder
      },
      getObjectById: jest.fn((id: string) =>
        id === 'extension-site1'
          ? site
          : id === 'storage1'
            ? storage
            : id === 'controller1'
              ? controller
              : null
      )
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(build).toHaveBeenCalledWith(site);
    expect(withdraw).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it('withdraws only construction-safe spawn energy below the E29N55 bootstrap buffer margin', () => {
    const site = withRangeTo(
      { id: 'extension-site1', structureType: 'extension' } as ConstructionSite,
      { spawn1: 1 }
    );
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(323),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const withdraw = jest.fn().mockReturnValue(0);
    const room = {
      name: 'E29N55',
      energyAvailable: 323,
      energyCapacityAvailable: 550,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return type === FIND_STRUCTURES ? [spawn] : [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    const assessment = assessColonySurvival({
      roomName: 'E29N55',
      workerCapacity: 1,
      workerTarget: 3,
      hostileCreepCount: 0,
      energyCapacityAvailable: 550,
      controller: { my: true, level: 2, ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1 }
    });
    expect(assessment.mode).toBe('BOOTSTRAP');
    recordColonySurvivalAssessment('E29N55', assessment, 966752);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'spawn1',
      constructionSiteId: 'extension-site1'
    });
    expect(withdraw).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY, 23);
  });

  it.each([
    ['E29N55', 2_300],
    ['E29N57', 1_800]
  ])('does not withdraw fully reserved high-cost spawn energy for construction in full %s', (roomName, energyCapacity) => {
    const site = withRangeTo(
      {
        id: `${roomName}-road-site`,
        my: true,
        structureType: 'road',
        progress: 0,
        progressTotal: 5_000
      } as ConstructionSite,
      { spawn1: 1 }
    );
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const roomCreeps: Creep[] = [];
    const room = {
      name: roomName,
      energyAvailable: energyCapacity,
      energyCapacityAvailable: energyCapacity,
      controller,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [spawn] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return [];
      })
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Builder',
      memory: {
        role: 'worker',
        colony: roomName,
        task: {
          type: 'withdraw',
          targetId: 'spawn1' as Id<AnyStoreStructure>,
          constructionSiteId: `${roomName}-road-site` as Id<ConstructionSite>
        }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      room,
      withdraw,
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      moveTo: jest.fn(),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'spawn1' ? 1 : 10))
      }
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: roomName, task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_838_649,
          rooms: {
            [roomName]: {
              bodyCost: energyCapacity,
              creepName: `worker-${roomName}-next`,
              reservedAt: 1_838_649,
              reservedEnergy: energyCapacity,
              role: 'worker',
              roomName,
              updatedAt: 1_838_649
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, RecoveryWorker: recoveryWorker },
      rooms: { [roomName]: room },
      time: 1_838_650,
      getObjectById: jest.fn((id: string) => {
        if (id === 'spawn1') {
          return spawn;
        }

        return id === `${roomName}-road-site` ? site : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('withdraws only actual full-room surplus above an active spawn reservation for construction', () => {
    const site = withRangeTo(
      {
        id: 'E29N55-road-site',
        my: true,
        structureType: 'road',
        progress: 0,
        progressTotal: 5_000
      } as ConstructionSite,
      { spawn1: 1 }
    );
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 500 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(1_500)
      }
    } as unknown as StructureContainer;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [spawn, storedContainer] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return [];
      })
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      room,
      withdraw,
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      moveTo: jest.fn(),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'spawn1' ? 1 : 10))
      }
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N55', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    const storedBuilder = {
      name: 'StoredBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: {
          type: 'withdraw',
          targetId: 'stored-container1' as Id<AnyStoreStructure>,
          constructionSiteId: 'E29N55-road-site' as Id<ConstructionSite>
        }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker, storedBuilder);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_838_649,
          rooms: {
            E29N55: {
              bodyCost: 2_275,
              creepName: 'worker-E29N55-next',
              reservedAt: 1_838_649,
              reservedEnergy: 2_275,
              role: 'worker',
              roomName: 'E29N55',
              updatedAt: 1_838_649
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, RecoveryWorker: recoveryWorker, StoredBuilder: storedBuilder },
      rooms: { E29N55: room },
      time: 1_838_650,
      getObjectById: jest.fn((id: string) => {
        if (id === 'spawn1') {
          return spawn;
        }

        if (id === 'stored-container1') {
          return storedContainer;
        }

        return id === 'E29N55-road-site' ? site : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'spawn1',
      constructionSiteId: 'E29N55-road-site'
    });
    expect(withdraw).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY, 25);
  });

  it('retargets a retained generic E29N55 withdraw to construction-scoped container energy under storage critical', () => {
    const site = withRangeTo(
      {
        id: 'road-site1',
        my: true,
        structureType: 'road',
        progress: 0,
        progressTotal: 5_000
      } as ConstructionSite,
      { container1: 1 }
    );
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 499 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const container = {
      id: 'container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 755 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_000 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 3_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 300,
      energyCapacityAvailable: 2_300,
      controller,
      storage,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storage, container];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_HOSTILE_CREEPS) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Builder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'withdraw', targetId: 'container1' as Id<AnyStoreStructure> }
      },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'container1' ? 1 : 10))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      room,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      rooms: { E29N55: room },
      time: 1_875_260,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'storage1') {
          return storage;
        }

        return id === 'container1' ? container : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'container1',
      constructionSiteId: 'road-site1'
    });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      currentTask: 'withdraw',
      baseSelectedTask: 'withdraw',
      selectedTask: 'withdraw',
      assignedTask: 'withdraw'
    });
    expect(withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY, 50);
  });

  it('retargets a retained generic secondary-room storage withdraw to distant construction recovery', () => {
    const site = withRangeTo(
      {
        id: 'remote-road-site1',
        my: true,
        structureType: 'road',
        progress: 4_453,
        progressTotal: 5_000
      } as ConstructionSite,
      { storage1: 12 }
    );
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 585_250 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(200_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 3_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storage];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return [];
      })
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Builder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'withdraw', targetId: 'storage1' as Id<AnyStoreStructure> }
      },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 3 : 10))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      rooms: { E29N57: room },
      time: 2_111_243,
      getObjectById: jest.fn((id: string) => {
        if (id === 'remote-road-site1') {
          return site;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'storage1',
      constructionSiteId: 'remote-road-site1'
    });
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
  });

  it('signs an owned controller when controller management reports a missing signature', () => {
    const controller = {
      id: 'controller1',
      my: true,
      sign: { username: 'enemy', text: 'not ours', time: 10, datetime: '2026-05-08T00:00:00.000Z' }
    } as unknown as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        controllers: {
          W1N1: {
            roomName: 'W1N1',
            controllerId: 'controller1' as Id<StructureController>,
            signNeeded: true,
            upgradePriority: 'none',
            desiredUpgraderCount: 0,
            activeUpgraderCount: 0,
            updatedAt: 100
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'signController', targetId: 'controller1' });
    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('prioritizes unsigned owned controller signing before routine harvesting', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const controller = { id: 'controller1', my: true } as unknown as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory =
      makeControllerSigningMemory('W1N1', 'controller1' as Id<StructureController>);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : source))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'signController', targetId: 'controller1' });
    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('prioritizes replacing a wrong owned controller signature before routine harvesting', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const controller = {
      id: 'controller1',
      my: true,
      sign: { username: 'enemy', text: 'not ours', time: 10, datetime: '2026-05-08T00:00:00.000Z' }
    } as unknown as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory =
      makeControllerSigningMemory('W1N1', 'controller1' as Id<StructureController>);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : source))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'signController', targetId: 'controller1' });
    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('does not repeat owned controller signing when the required text is already present', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const controller = {
      id: 'controller1',
      my: true,
      sign: {
        username: 'me',
        text: OCCUPIED_CONTROLLER_SIGN_TEXT,
        time: 100,
        datetime: '2026-05-08T00:00:00.000Z'
      }
    } as unknown as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory =
      makeControllerSigningMemory('W1N1', 'controller1' as Id<StructureController>);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : source))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.signController).not.toHaveBeenCalled();
  });

  it('falls back safely when a worker cannot issue controller signs', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const controller = { id: 'controller1', my: true } as unknown as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory =
      makeControllerSigningMemory('W1N1', 'controller1' as Id<StructureController>);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : source))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.harvest).toHaveBeenCalledWith(source);
  });

  it('preempts an assigned controller sign for emergency harvest during low-energy buildout', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getUsedCapacity: jest.fn().mockReturnValue(190), getFreeCapacity: jest.fn().mockReturnValue(110) }
    } as unknown as StructureSpawn;
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      sign: { username: 'enemy', text: 'not ours', time: 10, datetime: '2026-05-08T00:00:00.000Z' }
    } as unknown as StructureController;
    const room = {
      name: 'E29N55',
      energyAvailable: 290,
      energyCapacityAvailable: 550,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_SOURCES) {
          return [source];
        }
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as unknown as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }
        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'E29N55', task: { type: 'signController', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : controller))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.signController).not.toHaveBeenCalled();
  });

  it('preempts an assigned controller sign for recovery under critical CPU bucket', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getUsedCapacity: jest.fn().mockReturnValue(190), getFreeCapacity: jest.fn().mockReturnValue(110) }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      sign: { username: 'enemy', text: 'not ours', time: 10, datetime: '2026-05-08T00:00:00.000Z' }
    } as unknown as StructureController;
    const room = {
      name: 'E29N55',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      energyCapacityAvailable: 550,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_SOURCES) {
          return [source];
        }
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as unknown as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }
        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'E29N55', task: { type: 'signController', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 125,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : controller))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.signController).not.toHaveBeenCalled();
  });

  it('does not assign owned controller signing while hostiles are visible', () => {
    const controller = {
      id: 'controller1',
      my: true,
      sign: { username: 'enemy', text: 'not ours', time: 10, datetime: '2026-05-08T00:00:00.000Z' }
    } as unknown as StructureController;
    const room = {
      name: 'E29N55',
      controller,
      find: jest.fn((type: number) => (type === FIND_HOSTILE_CREEPS ? [{ id: 'hostile1' }] : []))
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        controllers: {
          E29N55: {
            roomName: 'E29N55',
            controllerId: 'controller1' as Id<StructureController>,
            signNeeded: true,
            upgradePriority: 'none',
            desiredUpgraderCount: 0,
            activeUpgraderCount: 0,
            updatedAt: 100
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps loaded workers on construction before owned controller signing', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      sign: { username: 'enemy', text: 'not ours', time: 10, datetime: '2026-05-08T00:00:00.000Z' }
    } as unknown as StructureController;
    const site = {
      id: 'extension-site1',
      structureType: 'extension',
      progress: 0,
      progressTotal: 5_000
    } as ConstructionSite;
    const room = {
      name: 'E29N55',
      controller,
      find: jest.fn((type: number) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
    } as unknown as Room;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn().mockReturnValue(0),
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        controllers: {
          E29N55: {
            roomName: 'E29N55',
            controllerId: 'controller1' as Id<StructureController>,
            signNeeded: true,
            upgradePriority: 'none',
            desiredUpgraderCount: 0,
            activeUpgraderCount: 0,
            updatedAt: 100
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'extension-site1' ? site : controller))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(creep.build).toHaveBeenCalledWith(site);
    expect(creep.signController).not.toHaveBeenCalled();
  });

  it('routes a post-claim controller sustain upgrader to the claimed room before local work', () => {
    const targetController = { id: 'controller2', my: true } as StructureController;
    const homeRoom = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([{ id: 'source1' } as Source])
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W2N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> },
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: homeRoom,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: homeRoom,
        W2N1: { name: 'W2N1', controller: targetController } as Room
      },
      creeps: {}
    };

    runWorker(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(targetController);
    expect(creep.memory.task).toBeUndefined();
    expect(homeRoom.find).not.toHaveBeenCalled();
  });

  it('routes a cross-room spawn support worker to its colony before local work', () => {
    const targetController = { id: 'controller2', my: true } as StructureController;
    const originRoom = {
      name: 'W2N1',
      find: jest.fn().mockReturnValue([{ id: 'source1' } as Source])
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> },
        spawnSupport: { originRoom: 'W2N1', targetRoom: 'W1N1' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: originRoom,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: { name: 'W1N1', controller: targetController } as Room,
        W2N1: originRoom
      },
      creeps: {}
    };

    runWorker(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(targetController);
    expect(creep.memory.task).toBeUndefined();
    expect(originRoom.find).not.toHaveBeenCalled();
  });

  it('loads a post-claim energy hauler in the home room before sending it to the claimed room', () => {
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: { getUsedCapacity: jest.fn().mockReturnValue(500) }
    } as unknown as StructureStorage;
    const homeRoom = {
      name: 'W1N1',
      find: jest.fn((type: number) => (type === FIND_STRUCTURES ? [storage] : []))
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W2N1',
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'hauler' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room: homeRoom,
      withdraw: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(storage)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'storage1' });
    expect(creep.withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 50);
    expect(creep.moveTo).toHaveBeenCalledWith(storage, { range: 1 });
  });

  it('sends a loaded post-claim energy hauler from home to the claimed room', () => {
    const targetController = { id: 'controller2', my: true } as StructureController;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W2N1',
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'hauler' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { name: 'W1N1', find: jest.fn() } as unknown as Room,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W2N1: { name: 'W2N1', controller: targetController } as Room },
      creeps: {}
    };

    runWorker(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(targetController);
  });

  it('executes a newly assigned task in the same tick when the target is available', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      memory: {},
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([source]) },
      harvest: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).toHaveBeenCalledWith(source, { range: 1 });
  });

  it('moves a source-container harvest task onto the container before harvesting', () => {
    const source = {
      id: 'source1',
      energy: 300,
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return type === FIND_STRUCTURES ? [container] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container1' ? 1 : 1)) },
      room,
      harvest: jest.fn().mockReturnValue(0),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn().mockReturnValue(0)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null))
    };

    runWorker(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(container, { range: 0 });
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.transfer).not.toHaveBeenCalled();
  });

  it('records source-container moveTo failures without a successful move or idle tick', () => {
    const source = {
      id: 'source1',
      energy: 300,
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return type === FIND_STRUCTURES ? [container] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container1' ? 1 : 1)) },
      room,
      harvest: jest.fn().mockReturnValue(0),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn().mockReturnValue(ERR_NO_PATH)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null))
    };

    runWorker(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(container, { range: 0 });
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.memory.behaviorTelemetry).toMatchObject({
      moveToAttempts: 1,
      moveToFailures: 1,
      moveToErrNoPath: 1,
      lastMoveToResult: ERR_NO_PATH,
      lastMoveToTask: 'harvest',
      lastMoveToTargetId: 'container1',
      lastMoveToRange: 0
    });
    expect(creep.memory.behaviorTelemetry?.moveTicks).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.idleTicks).toBeUndefined();
  });

  it('flushes partial source-container harvest energy before harvesting again', () => {
    const source = {
      id: 'source1',
      energy: 300,
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return type === FIND_STRUCTURES ? [container] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container1' ? 0 : 1)) },
      room,
      harvest: jest.fn().mockReturnValue(0),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null))
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(container, RESOURCE_ENERGY);
    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect((creep.transfer as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (creep.harvest as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('does not flush partial ordinary harvest energy into a source container', () => {
    const source = {
      id: 'source1',
      energy: 300,
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return type === FIND_STRUCTURES ? [container] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container1' ? 0 : 1)) },
      room,
      harvest: jest.fn().mockReturnValue(0),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : null))
    };

    runWorker(creep);

    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts source-container harvesting to build extension capacity with partial carried energy', () => {
    const source = {
      id: 'source1',
      energy: 300,
      pos: { x: 10, y: 10, roomName: 'E29N55' } as RoomPosition
    } as Source;
    const extensionSite = {
      id: 'extension-site1',
      my: true,
      structureType: 'extension',
      progress: 0,
      progressTotal: 3_000,
      pos: { x: 18, y: 24, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'E29N55' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const room = {
      name: 'E29N55',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [extensionSite];
        }

        if (type === FIND_STRUCTURES) {
          return [container];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Builder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(46),
        getFreeCapacity: jest.fn().mockReturnValue(4),
        getCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'extension-site1' ? 1 : 0))
      },
      room,
      build: jest.fn().mockReturnValue(0),
      harvest: jest.fn().mockReturnValue(0),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'source1' ? source : id === 'extension-site1' ? extensionSite : null
      )
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(creep.build).toHaveBeenCalledWith(extensionSite);
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.transfer).not.toHaveBeenCalled();
  });

  it('assigns and executes an adjacent claimed-room harvest when it is the closer source', () => {
    const homeSource = { id: 'source-home', energy: 300, pos: { x: 40, y: 40, roomName: 'W1N1' } } as Source;
    const adjacentSource = { id: 'source-adjacent', energy: 300, pos: { x: 2, y: 25, roomName: 'W2N1' } } as Source;
    const homeRoom = {
      name: 'W1N1',
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [homeSource] : []))
    } as unknown as Room;
    const adjacentRoom = {
      name: 'W2N1',
      controller: { id: 'controller2', my: true } as StructureController,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [adjacentSource] : []))
    } as unknown as Room;
    const creep = {
      memory: {},
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'source-adjacent' ? 2 : 15))
      },
      room: homeRoom,
      harvest: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn((id: string) => (id === 'source-adjacent' ? adjacentSource : homeSource)),
      map: { describeExits: jest.fn().mockReturnValue({ '3': 'W2N1' }) } as unknown as GameMap,
      rooms: { W1N1: homeRoom, W2N1: adjacentRoom }
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source-adjacent' });
    expect(creep.harvest).toHaveBeenCalledWith(adjacentSource);
    expect(creep.moveTo).toHaveBeenCalledWith(adjacentSource, { range: 1 });
  });

  it('splits empty workers across sources as harvest assignments change', () => {
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([source1, source2])
    } as unknown as Room;
    const assigned = {
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      room
    } as unknown as Creep;
    const worker1 = {
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;
    const worker2 = {
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Assigned: assigned, Worker1: worker1, Worker2: worker2 }
    };

    runWorker(worker1);
    runWorker(worker2);

    expect(worker1.memory.task).toEqual({ type: 'harvest', targetId: 'source2' });
    expect(worker2.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('leaves worker untasked when it has no energy and no sources', () => {
    const creep = {
      memory: {},
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;

    expect(() => runWorker(creep)).not.toThrow();
    expect(creep.memory.task).toBeUndefined();
  });

  it('leaves worker untasked when it has energy and no spending targets or controller', () => {
    const creep = {
      memory: {},
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;

    expect(() => runWorker(creep)).not.toThrow();
    expect(creep.memory.task).toBeUndefined();
  });

  it('moves toward harvest target when not in range', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' } },
      room: { find: jest.fn().mockReturnValue([]) },
      harvest: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).toHaveBeenCalledWith(source, { range: 1 });
  });

  it('records actual assigned-task moveTo ERR_NO_PATH with task target range context', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' } },
      room: { find: jest.fn().mockReturnValue([]) },
      harvest: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
      moveTo: jest.fn().mockReturnValue(ERR_NO_PATH)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(source, { range: 1 });
    expect(creep.memory.behaviorTelemetry).toMatchObject({
      moveToAttempts: 1,
      moveToFailures: 1,
      moveToErrNoPath: 1,
      lastMoveToResult: ERR_NO_PATH,
      lastMoveToTask: 'harvest',
      lastMoveToTargetId: 'source1',
      lastMoveToRange: 1
    });
    expect(creep.memory.behaviorTelemetry?.moveTicks).toBeUndefined();
  });

  it('records worker behavior telemetry while moving and working across ticks', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      pos: { x: 10, y: 10, roomName: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([source]) },
      harvest: jest.fn().mockReturnValueOnce(ERR_NOT_IN_RANGE).mockReturnValueOnce(ERR_NOT_IN_RANGE).mockReturnValueOnce(0),
      moveTo: jest.fn().mockReturnValue(0)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    (Game as Partial<Game>).time = 11;
    runWorker(creep);

    (creep as unknown as { pos: { x: number; y: number; roomName: string } }).pos = {
      x: 11,
      y: 10,
      roomName: 'W1N1'
    };
    (Game as Partial<Game>).time = 12;
    runWorker(creep);

    expect(creep.memory.behaviorTelemetry).toMatchObject({
      moveTicks: 2,
      workTicks: 1,
      stuckTicks: 1,
      pathLength: 1,
      lastPosition: { x: 11, y: 10, roomName: 'W1N1' },
      lastMoveTick: 11,
      lastObservedTick: 12
    });
  });

  it('skips worker behavior telemetry writes during noncritical low-bucket recovery', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      name: 'Worker1',
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      pos: { x: 10, y: 10, roomName: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { name: 'W1N1', find: jest.fn().mockReturnValue([source]) },
      harvest: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
      moveTo: jest.fn().mockReturnValue(ERR_NO_PATH)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: LOW_CPU_BUCKET_THRESHOLD - 1,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).toHaveBeenCalledWith(source, { range: 1 });
    expect(creep.memory.behaviorTelemetry).toBeUndefined();
  });

  it('switches a full source-container harvester to controller work', () => {
    const source = {
      id: 'source1',
      energy: 300,
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const controller = { id: 'controller1', my: true, level: 1 } as StructureController;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return type === FIND_STRUCTURES ? [container] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room,
      harvest: jest.fn(),
      transfer: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Harvester: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : id === 'controller1' ? controller : null))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('switches a source-container harvester away when the container is full', () => {
    const source = {
      id: 'source1',
      energy: 300,
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const controller = { id: 'controller1', my: true, level: 1 } as StructureController;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureContainer;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return type === FIND_STRUCTURES ? [container] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(49),
        getFreeCapacity: jest.fn().mockReturnValue(1)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room,
      harvest: jest.fn(),
      transfer: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Harvester: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : id === 'controller1' ? controller : null))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts energy acquisition so boosted upgraders keep upgrading with any carried energy', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> },
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W1N1', role: 'upgrader' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(25),
        getFreeCapacity: jest.fn().mockReturnValue(75),
        getCapacity: jest.fn().mockReturnValue(100)
      },
      room,
      harvest: jest.fn(),
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { BoostUpgrader: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : id === 'controller1' ? controller : null))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('switches from a depleted harvest target to a viable source in the same tick', () => {
    const depletedSource = { id: 'source1', energy: 0 } as Source;
    const viableSource = { id: 'source2', energy: 100 } as Source;
    const harvest = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: {
        name: 'W1N1',
        find: jest.fn((type) => (type === FIND_SOURCES ? [depletedSource, viableSource] : []))
      },
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn((id: string) =>
      id === 'source1' ? depletedSource : id === 'source2' ? viableSource : null
    );
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source2' });
    expect(getObjectById).toHaveBeenCalledWith('source1');
    expect(getObjectById).toHaveBeenCalledWith('source2');
    expect(harvest).toHaveBeenCalledWith(viableSource);
    expect(harvest).not.toHaveBeenCalledWith(depletedSource);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps a depleted remote harvest target when its visible source container can receive energy', () => {
    const remoteSource = {
      id: 'remote-source',
      energy: 0,
      pos: { x: 20, y: 20, roomName: 'W2N1' } as RoomPosition
    } as Source;
    const localSource = { id: 'local-source', energy: 300 } as Source;
    const remoteContainer = {
      id: 'remote-container',
      structureType: 'container',
      pos: { x: 20, y: 21, roomName: 'W2N1' } as RoomPosition,
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const homeRoom = {
      name: 'W1N1',
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [localSource] : []))
    } as unknown as Room;
    const remoteRoom = {
      name: 'W2N1',
      find: jest.fn((type: number) => (type === FIND_STRUCTURES ? [remoteContainer] : []))
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'harvest', targetId: 'remote-source' as Id<Source>, sourceContainerAssigned: true }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(10) },
      room: homeRoom,
      harvest: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      rooms: { W1N1: homeRoom, W2N1: remoteRoom },
      getObjectById: jest.fn((id: string) =>
        id === 'remote-source' ? remoteSource : id === 'local-source' ? localSource : null
      )
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'harvest',
      targetId: 'remote-source',
      sourceContainerAssigned: true
    });
    expect(creep.moveTo).toHaveBeenCalledWith(remoteContainer, { range: 0 });
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('picks up dropped energy and moves when not in range', () => {
    const droppedEnergy = { id: 'drop1', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const creep = {
      memory: { task: { type: 'pickup', targetId: 'drop1' as Id<Resource<ResourceConstant>> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      pickup: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(droppedEnergy)
    };

    runWorker(creep);

    expect(creep.pickup).toHaveBeenCalledWith(droppedEnergy);
    expect(creep.moveTo).toHaveBeenCalledWith(droppedEnergy, { range: 1 });
  });

  it('transfers energy to a transfer target and moves when not in range', () => {
    const spawn = { id: 'spawn1' } as StructureSpawn;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'spawn1' } },
      room: { find: jest.fn().mockReturnValue([]) },
      transfer: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.moveTo).toHaveBeenCalledWith(spawn, { range: 1 });
  });

  it('withdraws energy from a withdraw target and moves when not in range', () => {
    const container = { id: 'container1' } as StructureContainer;
    const creep = {
      memory: { task: { type: 'withdraw', targetId: 'container1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      withdraw: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(container)
    };

    runWorker(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, 'energy', 50);
    expect(creep.moveTo).toHaveBeenCalledWith(container, { range: 1 });
  });

  it('caps spawn energy withdrawal to approved amount', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getUsedCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const withdraw = jest.fn().mockReturnValue(0);
    const room = {
      name: 'W1N1',
      memory: { spawnEnergyBuffer: { minimumEnergyPerSpawn: 275 } },
      controller: { level: 1 } as StructureController,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type !== FIND_MY_STRUCTURES) {
          return [];
        }

        return options?.filter?.(spawn as unknown as AnyOwnedStructure) === false
          ? []
          : [spawn as unknown as AnyOwnedStructure];
      })
    } as unknown as Room;
    const creep = {
      memory: { task: { type: 'withdraw', targetId: 'spawn1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(spawn, 'energy', 25);
    expect(creep.withdraw).toHaveBeenCalledTimes(1);
    expect(withdraw.mock.calls[0]).toEqual([spawn, 'energy', 25]);
  });

  it('records source container withdrawal telemetry on successful source-container withdraw', () => {
    const source = {
      id: 'source1',
      pos: { x: 10, y: 10, roomName: 'W1N1' } as RoomPosition
    } as Source;
    const container = {
      id: 'container1',
      structureType: 'container',
      pos: { x: 10, y: 11, roomName: 'W1N1' } as RoomPosition,
      store: { getUsedCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return type === FIND_STRUCTURES ? [container] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: { task: { type: 'withdraw', targetId: 'container1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      withdraw: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 42,
      getObjectById: jest.fn().mockReturnValue(container)
    };

    runWorker(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(container, 'energy', 50);
    expect(creep.memory.behaviorTelemetry).toMatchObject({
      workTicks: 1,
      sourceContainerWithdrawals: 1,
      lastSourceContainerWithdrawalTick: 42
    });
  });

  it('reselects and executes when a withdraw target is drained before action', () => {
    const drainedContainer = {
      id: 'container-drained',
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureContainer;
    const source = { id: 'source1', energy: 300 } as Source;
    const withdraw = jest.fn().mockReturnValue(ERR_NOT_ENOUGH_RESOURCES);
    const harvest = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'withdraw', targetId: 'container-drained' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: {
        name: 'W1N1',
        find: jest.fn((type) => (type === FIND_SOURCES ? [source] : []))
      },
      withdraw,
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : drainedContainer))
    };

    runWorker(creep);

    expect(withdraw).toHaveBeenCalledWith(drainedContainer, 'energy', 50);
    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('builds an existing build target and moves when not in range', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const build = jest.fn().mockReturnValue(-9);
    const moveTo = jest.fn().mockReturnValue(0);
    const getObjectById = jest.fn().mockReturnValue(site);
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('site1');
    expect(build).toHaveBeenCalledWith(site);
    expect(moveTo).toHaveBeenCalledWith(site, { range: 3, ignoreCreeps: true });
  });

  it('reselects acquisition instead of moving when a spending task leaves the worker empty', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const source = { id: 'source1', energy: 300 } as Source;
    let carriedEnergy = 50;
    const build = jest.fn(() => {
      carriedEnergy = 0;
      return ERR_NOT_IN_RANGE;
    });
    const harvest = jest.fn().mockReturnValue(0);
    const moveTo = jest.fn();
    const getObjectById = jest.fn((id: string) => (id === 'source1' ? source : site));
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn(() => carriedEnergy),
        getFreeCapacity: jest.fn(() => 50 - carriedEnergy)
      },
      room: { find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : [])) },
      build,
      harvest,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(build).toHaveBeenCalledWith(site);
    expect(moveTo).not.toHaveBeenCalledWith(site, { range: 3, ignoreCreeps: true });
    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(harvest).toHaveBeenCalledWith(source);
  });

  it('suppresses an existing build target when movement cannot find a path', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const build = jest.fn().mockReturnValue(-9);
    const moveTo = jest.fn().mockReturnValue(-2);
    const getObjectById = jest.fn().mockReturnValue(site);
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById,
      time: 200
    };

    runWorker(creep);

    expect(build).toHaveBeenCalledWith(site);
    expect(moveTo).toHaveBeenCalledWith(site, { range: 3, ignoreCreeps: true });
    expect(creep.memory.task).toBeUndefined();
    expect(creep.memory.blockedBuildTarget).toEqual({
      targetId: 'site1',
      blockedAt: 200,
      until: 215,
      reason: 'noPath'
    });
    expect(creep.memory.buildActionTelemetry).toEqual({
      resultCounts: {
        failed_no_path: 1
      },
      lastResult: 'failed_no_path',
      lastTargetId: 'site1',
      lastTick: 200
    });
  });

  it('clears build-target stuck telemetry after successful build work', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const build = jest.fn().mockReturnValue(0);
    const moveTo = jest.fn();
    const getObjectById = jest.fn().mockReturnValue(site);
    const creep = {
      memory: {
        task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> },
        behaviorTelemetry: {
          stuckTicks: 1,
          workTicks: 0,
          buildTargetStuckTicks: 1,
          buildTargetStuckTargetId: 'site1',
          lastMoveBuildTargetId: 'site1'
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById,
      time: 200
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('site1');
    expect(build).toHaveBeenCalledWith(site);
    expect(moveTo).not.toHaveBeenCalled();
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.blockedBuildTarget).toBeUndefined();
    expect(creep.memory.behaviorTelemetry).toMatchObject({
      stuckTicks: 1,
      workTicks: 1
    });
    expect(creep.memory.buildActionTelemetry).toEqual({
      resultCounts: {
        succeeded: 1
      },
      lastResult: 'succeeded',
      lastTargetId: 'site1',
      lastTick: 200
    });
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTicks).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTargetId).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.lastMoveBuildTargetId).toBeUndefined();
  });

  it('suppresses a no-work stuck build task before retaining it', () => {
    const build = jest.fn();
    const moveTo = jest.fn();
    const getObjectById = jest.fn();
    const creep = {
      memory: {
        task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> },
        behaviorTelemetry: {
          stuckTicks: 2,
          workTicks: 0,
          buildTargetStuckTicks: 2,
          buildTargetStuckTargetId: 'site1',
          lastMoveBuildTargetId: 'site1'
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById,
      time: 200
    };

    runWorker(creep);

    expect(getObjectById).not.toHaveBeenCalledWith('site1');
    expect(build).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
    expect(creep.memory.task).toBeUndefined();
    expect(creep.memory.blockedBuildTarget).toEqual({
      targetId: 'site1',
      blockedAt: 200,
      until: 215,
      reason: 'stuck'
    });
    expect(creep.memory.behaviorTelemetry).toMatchObject({
      stuckTicks: 2,
      workTicks: 0
    });
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTicks).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTargetId).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.lastMoveBuildTargetId).toBeUndefined();
  });

  it('does not suppress a new build target with stale stuck telemetry from a previous target', () => {
    const site = { id: 'site2' } as ConstructionSite;
    const build = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const moveTo = jest.fn().mockReturnValue(0);
    const getObjectById = jest.fn().mockReturnValue(site);
    const creep = {
      memory: {
        task: { type: 'build', targetId: 'site2' as Id<ConstructionSite> },
        behaviorTelemetry: {
          stuckTicks: 2,
          workTicks: 0,
          buildTargetStuckTicks: 2,
          buildTargetStuckTargetId: 'site1',
          lastMoveBuildTargetId: 'site1'
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById,
      time: 200
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('site2');
    expect(build).toHaveBeenCalledWith(site);
    expect(moveTo).toHaveBeenCalledWith(site, { range: 3, ignoreCreeps: true });
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site2' });
    expect(creep.memory.blockedBuildTarget).toBeUndefined();
    expect(creep.memory.behaviorTelemetry).toMatchObject({
      stuckTicks: 2,
      workTicks: 0,
      lastMoveBuildTargetId: 'site2'
    });
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTicks).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTargetId).toBeUndefined();
  });

  it('suppresses a blocked build target after earlier work on a different site', () => {
    const build = jest.fn();
    const moveTo = jest.fn();
    const getObjectById = jest.fn();
    const creep = {
      memory: {
        task: { type: 'build', targetId: 'site2' as Id<ConstructionSite> },
        behaviorTelemetry: {
          stuckTicks: 2,
          workTicks: 1,
          buildTargetStuckTicks: 2,
          buildTargetStuckTargetId: 'site2',
          lastMoveBuildTargetId: 'site2'
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById,
      time: 200
    };

    runWorker(creep);

    expect(getObjectById).not.toHaveBeenCalledWith('site2');
    expect(build).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
    expect(creep.memory.task).toBeUndefined();
    expect(creep.memory.blockedBuildTarget).toEqual({
      targetId: 'site2',
      blockedAt: 200,
      until: 215,
      reason: 'stuck'
    });
    expect(creep.memory.behaviorTelemetry).toMatchObject({
      stuckTicks: 2,
      workTicks: 1
    });
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTicks).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.buildTargetStuckTargetId).toBeUndefined();
    expect(creep.memory.behaviorTelemetry?.lastMoveBuildTargetId).toBeUndefined();
  });

  it('repairs an existing repair target and moves when not in range', () => {
    const road = { id: 'road1', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const repair = jest.fn().mockReturnValue(-9);
    const moveTo = jest.fn();
    const getObjectById = jest.fn().mockReturnValue(road);
    const creep = {
      memory: { task: { type: 'repair', targetId: 'road1' as Id<Structure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      repair,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('road1');
    expect(repair).toHaveBeenCalledWith(road);
    expect(moveTo).toHaveBeenCalledWith(road, { range: 3 });
  });

  it('assigns sequential workers to different routine rampart repairs without throwing', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const firstRampart = {
      id: 'rampart-a',
      structureType: 'rampart',
      hits: IDLE_RAMPART_REPAIR_HITS_CEILING - 1_000,
      hitsMax: 300_000,
      my: true
    } as StructureRampart;
    const secondRampart = {
      id: 'rampart-b',
      structureType: 'rampart',
      hits: IDLE_RAMPART_REPAIR_HITS_CEILING - 900,
      hitsMax: 300_000,
      my: true
    } as StructureRampart;
    const workers: Creep[] = [];
    const room = {
      name: 'W1N1',
      controller,
      energyAvailable: 550,
      energyCapacityAvailable: 550,
      find: jest.fn((type: number) => {
        if (type === FIND_STRUCTURES) {
          return [firstRampart, secondRampart];
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        return [];
      })
    } as unknown as Room;
    const firstWorker = {
      name: 'FirstWorker',
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    const secondWorker = {
      name: 'SecondWorker',
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    workers.push(firstWorker, secondWorker);
    const rampartsById = new Map<string, StructureRampart>([
      [String(firstRampart.id), firstRampart],
      [String(secondRampart.id), secondRampart]
    ]);
    const getObjectById = jest.fn((id: string) => rampartsById.get(id) ?? null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { FirstWorker: firstWorker, SecondWorker: secondWorker },
      getObjectById,
      time: 801
    };

    expect(() => runWorker(firstWorker)).not.toThrow();
    expect(() => runWorker(secondWorker)).not.toThrow();

    const firstTask = firstWorker.memory.task;
    const secondTask = secondWorker.memory.task;
    expect(firstTask?.type).toBe('repair');
    expect(secondTask?.type).toBe('repair');
    if (firstTask?.type !== 'repair' || secondTask?.type !== 'repair') {
      throw new Error('expected both workers to receive repair tasks');
    }

    expect(new Set([String(firstTask.targetId), String(secondTask.targetId)])).toEqual(
      new Set([String(firstRampart.id), String(secondRampart.id)])
    );

    const firstRepairTarget = rampartsById.get(String(firstTask.targetId));
    const secondRepairTarget = rampartsById.get(String(secondTask.targetId));
    if (!firstRepairTarget || !secondRepairTarget) {
      throw new Error('expected assigned repair targets to resolve through Game.getObjectById');
    }

    expect(getObjectById).toHaveBeenCalledWith(firstTask.targetId);
    expect(getObjectById).toHaveBeenCalledWith(secondTask.targetId);
    expect(firstWorker.repair).toHaveBeenCalledWith(firstRepairTarget);
    expect(secondWorker.repair).toHaveBeenCalledWith(secondRepairTarget);
  });

  it('upgrades an existing upgrade target and moves when not in range', () => {
    const controller = { id: 'controller1' } as StructureController;
    const upgradeController = jest.fn().mockReturnValue(-9);
    const moveTo = jest.fn();
    const getObjectById = jest.fn().mockReturnValue(controller);
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      upgradeController,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller1');
    expect(upgradeController).toHaveBeenCalledWith(controller);
    expect(moveTo).toHaveBeenCalledWith(controller, { range: 3 });
  });

  it('signs an incorrectly signed owned upgrade target while upgrading it', () => {
    const controller = {
      id: 'controller1',
      my: true,
      sign: { username: 'other', text: 'old sign', time: 123, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    const signController = jest.fn().mockReturnValue(0);
    const upgradeController = jest.fn().mockReturnValue(0);
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller, find: jest.fn().mockReturnValue([]) },
      signController,
      upgradeController,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(upgradeController).toHaveBeenCalledWith(controller);
    expect(moveTo).not.toHaveBeenCalled();
    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps upgrading when signing requires inaccessible range-1 movement', () => {
    const controller = {
      id: 'controller1',
      my: true,
      sign: { username: 'other', text: 'old sign', time: 123, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    const signController = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const upgradeController = jest.fn().mockReturnValue(0);
    const moveTo = jest.fn().mockReturnValue(-2);
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller, find: jest.fn().mockReturnValue([]) },
      signController,
      upgradeController,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(moveTo).toHaveBeenCalledWith(controller);
    expect(upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('does not repeat signing for a correctly signed owned upgrade target', () => {
    const controller = {
      id: 'controller1',
      my: true,
      sign: {
        username: 'me',
        text: OCCUPIED_CONTROLLER_SIGN_TEXT,
        time: 123,
        datetime: '2026-04-29T00:00:00.000Z'
      }
    } as unknown as StructureController;
    const signController = jest.fn();
    const upgradeController = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller, find: jest.fn().mockReturnValue([]) },
      signController,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(signController).not.toHaveBeenCalled();
    expect(upgradeController).toHaveBeenCalledWith(controller);
  });

  it('preempts an RCL2 upgrade task for extension construction when downgrade is safe', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
      },
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn()
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('dispatches loaded workers to construction before retaining controller upgrades', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const constructionSites = Array.from(
      { length: 10 },
      (_, index) =>
        ({
          id: `site-${index}`,
          structureType: 'road',
          progress: 0,
          progressTotal: 5_000
        }) as ConstructionSite
    );
    const workers: Creep[] = [];
    const room = {
      name: 'E19S57',
      controller,
      energyAvailable: 320,
      energyCapacityAvailable: 400,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        return [];
      })
    } as unknown as Room;
    const makeWorker = (index: number): Creep =>
      ({
        name: `Worker${index}`,
        memory: {
          role: 'worker',
          colony: 'E19S57',
          task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
        },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(50),
          getFreeCapacity: jest.fn().mockReturnValue(0)
        },
        room,
        build: jest.fn().mockReturnValue(0),
        upgradeController: jest.fn(),
        moveTo: jest.fn()
      }) as unknown as Creep;
    workers.push(...Array.from({ length: 6 }, (_, index) => makeWorker(index)));
    const creeps = Object.fromEntries(workers.map((worker) => [worker.name, worker]));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps,
      getObjectById: jest.fn((id: string) =>
        constructionSites.find((site) => site.id === id) ?? (id === 'controller1' ? controller : null)
      ),
      time: 917_318
    };

    workers.forEach(runWorker);

    const assignedTasks = workers.map((worker) => worker.memory.task?.type);
    expect(assignedTasks.filter((task) => task === 'build').length).toBeGreaterThanOrEqual(2);
    expect(assignedTasks).not.toContain('upgrade');
    for (const worker of workers) {
      expect(worker.upgradeController).not.toHaveBeenCalled();
    }
  });

  it('assigns E29N55 bootstrap builders when controller upgrades leave construction uncovered', () => {
    const source = {
      id: 'source1',
      pos: { x: 20, y: 10, roomName: 'E29N55' } as RoomPosition
    } as Source;
    const sourceContainerSite = {
      id: 'source-container-site1',
      structureType: 'container',
      progress: 0,
      progressTotal: 5_000,
      pos: { x: 21, y: 10, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 300
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(278),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const workers: Creep[] = [];
    const sourceHarvester = {
      name: 'SourceHarvester',
      memory: {
        role: 'sourceHarvester',
        sourceHarvester: { sourceId: 'source1' as Id<Source>, colony: 'E29N55' }
      },
      room: undefined as unknown as Room
    } as unknown as Creep;
    const room = {
      name: 'E29N55',
      energyAvailable: 278,
      energyCapacityAvailable: 300,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [sourceContainerSite];
        }

        if (type === FIND_SOURCES) {
          return [source];
        }

        if (type === FIND_MY_CREEPS) {
          return [...workers, sourceHarvester];
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    (sourceHarvester as Creep & { room: Room }).room = room;
    const makeWorker = (name: string, carriedEnergy: number, freeCapacity: number): Creep =>
      ({
        name,
        memory: {
          role: 'worker',
          colony: 'E29N55',
          task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
        },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(carriedEnergy),
          getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
          getCapacity: jest.fn().mockReturnValue(carriedEnergy + freeCapacity)
        },
        pos: { getRangeTo: jest.fn().mockReturnValue(18) },
        room,
        build: jest.fn().mockReturnValue(0),
        upgradeController: jest.fn().mockReturnValue(0),
        moveTo: jest.fn()
      }) as unknown as Creep;
    workers.push(
      makeWorker('worker-E29N55-1', 50, 0),
      makeWorker('worker-E29N55-2', 17, 33),
      makeWorker('worker-E29N55-3', 16, 34)
    );
    const assessment = assessColonySurvival({
      roomName: 'E29N55',
      totalCreeps: workers.length,
      workerCapacity: workers.length,
      workerTarget: 6,
      energyAvailable: 278,
      energyCapacityAvailable: 300,
      spawnEnergyAvailable: 278,
      controller: { my: true, level: 2, ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 300 },
      hostileCreepCount: 0,
      hostileStructureCount: 0
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 954_381,
      creeps: Object.fromEntries([
        ...workers.map((worker) => [worker.name, worker]),
        [sourceHarvester.name, sourceHarvester]
      ]),
      getObjectById: jest.fn((id: string) => {
        if (id === 'source-container-site1') {
          return sourceContainerSite;
        }

        if (id === 'controller1') {
          return controller;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'source1' ? source : null;
      })
    };
    expect(assessment.mode).toBe('BOOTSTRAP');
    recordColonySurvivalAssessment('E29N55', assessment, 954_381);

    workers.forEach(runWorker);

    expect(workers.map((worker) => worker.memory.task?.type).filter((task) => task === 'build')).toHaveLength(3);
    for (const worker of workers) {
      expect(worker.memory.task).toEqual({ type: 'build', targetId: 'source-container-site1' });
      expect(worker.build).toHaveBeenCalledWith(sourceContainerSite);
      expect(worker.upgradeController).not.toHaveBeenCalled();
    }
  });

  it('keeps one E29N55 worker building while other loaded workers sustain a non-imminent downgrade guard', () => {
    const source = {
      id: 'source1',
      pos: { x: 20, y: 10, roomName: 'E29N55' } as RoomPosition
    } as Source;
    const sourceContainerSite = {
      id: 'source-container-site1',
      my: true,
      structureType: 'container',
      progress: 2_500,
      progressTotal: 5_000,
      pos: { x: 21, y: 10, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS - 27
    } as StructureController;
    const extension = {
      id: 'extension1',
      my: true,
      structureType: 'extension',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureExtension;
    const workers: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 350,
      energyCapacityAvailable: 450,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [sourceContainerSite];
        }

        if (type === FIND_SOURCES) {
          return [source];
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [extension as unknown as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const makeWorker = (name: string): Creep =>
      ({
        name,
        memory: {
          role: 'worker',
          colony: 'E29N55',
          task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
        },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(16),
          getFreeCapacity: jest.fn().mockReturnValue(34),
          getCapacity: jest.fn().mockReturnValue(50)
        },
        pos: { getRangeTo: jest.fn().mockReturnValue(12) },
        room,
        build: jest.fn().mockReturnValue(0),
        upgradeController: jest.fn().mockReturnValue(0),
        moveTo: jest.fn()
      }) as unknown as Creep;
    workers.push(makeWorker('worker-E29N55-1'), makeWorker('worker-E29N55-2'), makeWorker('worker-E29N55-3'));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 960_880,
      creeps: Object.fromEntries(workers.map((worker) => [worker.name, worker])),
      getObjectById: jest.fn((id: string) => {
        if (id === 'source-container-site1') {
          return sourceContainerSite;
        }

        if (id === 'controller1') {
          return controller;
        }

        if (id === 'extension1') {
          return extension;
        }

        return id === 'source1' ? source : null;
      })
    };

    workers.forEach(runWorker);

    const assignedTasks = workers.map((worker) => worker.memory.task?.type);
    expect(assignedTasks.filter((task) => task === 'build')).toHaveLength(1);
    expect(assignedTasks.filter((task) => task === 'upgrade')).toHaveLength(2);
    expect(workers[0].memory.task).toEqual({ type: 'build', targetId: 'source-container-site1' });
    expect(workers[0].build).toHaveBeenCalledWith(sourceContainerSite);
    expect(workers[1].upgradeController).toHaveBeenCalledWith(controller);
    expect(workers[2].upgradeController).toHaveBeenCalledWith(controller);
  });

  it('assigns healthy E29N55 RCL2 loaded workers to uncovered construction backlog', () => {
    const sourceContainerSite = {
      id: 'source-container-site1',
      my: true,
      structureType: 'container',
      progress: 250,
      progressTotal: 5_000,
      pos: { x: 21, y: 10, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const towerSite = {
      id: 'tower-site1',
      my: true,
      structureType: 'tower',
      progress: 0,
      progressTotal: 5_000,
      pos: { x: 18, y: 23, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const roadSite = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 100,
      progressTotal: 300,
      pos: { x: 19, y: 24, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000,
      pos: { x: 25, y: 25, roomName: 'E29N55' } as RoomPosition
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      pos: { x: 17, y: 24, roomName: 'E29N55' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(550),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const constructionSites = [sourceContainerSite, towerSite, roadSite];
    const workers: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 550,
      energyCapacityAvailable: 550,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return constructionSites;
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const makeWorker = (index: number): Creep =>
      ({
        name: `worker-E29N55-${index}`,
        memory: {
          role: 'worker',
          colony: 'E29N55',
          task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
        },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(50),
          getFreeCapacity: jest.fn().mockReturnValue(0),
          getCapacity: jest.fn().mockReturnValue(50)
        },
        pos: { getRangeTo: jest.fn().mockReturnValue(5) },
        room,
        build: jest.fn().mockReturnValue(0),
        upgradeController: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
        moveTo: jest.fn()
      }) as unknown as Creep;
    workers.push(...Array.from({ length: 4 }, (_, index) => makeWorker(index + 1)));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_010_657,
      creeps: Object.fromEntries(workers.map((worker) => [worker.name, worker])),
      getObjectById: jest.fn((id: string) => {
        if (id === 'controller1') {
          return controller;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return constructionSites.find((site) => site.id === id) ?? null;
      })
    };

    workers.forEach(runWorker);

    const assignedTasks = workers.map((worker) => worker.memory.task?.type);
    expect(assignedTasks).not.toContain(undefined);
    expect(assignedTasks.filter((task) => task === 'build')).toHaveLength(4);
    expect(assignedTasks).not.toContain('upgrade');
    for (const worker of workers) {
      expect(worker.build).toHaveBeenCalled();
      expect(worker.upgradeController).not.toHaveBeenCalled();
    }
  });

  it('keeps E29N55 RCL2 controller progression active after construction clears', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      progress: 3_900,
      progressTotal: 45_000,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000,
      pos: { x: 25, y: 25, roomName: 'E29N55' } as RoomPosition
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      pos: { x: 17, y: 24, roomName: 'E29N55' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(550),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      my: true,
      structureType: 'storage',
      pos: { x: 19, y: 24, roomName: 'E29N55' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(4_760),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const workers: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 550,
      energyCapacityAvailable: 550,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [];
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const makeWorker = (index: number): Creep =>
      ({
        name: `worker-E29N55-${index}`,
        memory: { role: 'worker', colony: 'E29N55' },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(50),
          getFreeCapacity: jest.fn().mockReturnValue(0),
          getCapacity: jest.fn().mockReturnValue(50)
        },
        pos: { getRangeTo: jest.fn().mockReturnValue(5) },
        room,
        build: jest.fn(),
        transfer: jest.fn(),
        upgradeController: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
        moveTo: jest.fn()
      }) as unknown as Creep;
    workers.push(...Array.from({ length: 4 }, (_, index) => makeWorker(index + 1)));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_020_071,
      creeps: Object.fromEntries(workers.map((worker) => [worker.name, worker])),
      getObjectById: jest.fn((id: string) => {
        if (id === 'controller1') {
          return controller;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    workers.forEach(runWorker);

    const assignedTasks = workers.map((worker) => worker.memory.task?.type);
    expect(room.find).toHaveBeenCalledWith(FIND_CONSTRUCTION_SITES);
    expect(assignedTasks).toEqual(['upgrade', 'upgrade', 'upgrade', 'upgrade']);
    expect(workers.every((worker) => (worker.upgradeController as jest.Mock).mock.calls.length === 1)).toBe(true);
    for (const worker of workers) {
      expect(worker.moveTo).toHaveBeenCalledWith(controller, { range: 3 });
    }
    expect(workers.every((worker) => (worker.build as jest.Mock).mock.calls.length === 0)).toBe(true);
    expect(workers.every((worker) => (worker.transfer as jest.Mock).mock.calls.length === 0)).toBe(true);
  });

  it('reports saturated RCL4 controller upgrade standby instead of a generic no-task idle', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      progress: 58_331,
      progressTotal: 405_000,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000,
      pos: { x: 25, y: 25, roomName: 'E29N56' } as RoomPosition
    } as StructureController;
    const workers: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_000,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [];
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          return [];
        }

        if (type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const makeLoadedUpgrader = (index: number): Creep =>
      ({
        name: `worker-E29N56-upgrader-${index}`,
        memory: {
          role: 'worker',
          colony: 'E29N56',
          task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
        },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(50),
          getFreeCapacity: jest.fn().mockReturnValue(50),
          getCapacity: jest.fn().mockReturnValue(100)
        },
        room
      }) as unknown as Creep;
    const standbyWorker = {
      name: 'worker-E29N56-standby',
      memory: { role: 'worker', colony: 'E29N56' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(100),
        getCapacity: jest.fn().mockReturnValue(100)
      },
      room,
      harvest: jest.fn(),
      withdraw: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    workers.push(makeLoadedUpgrader(1), makeLoadedUpgrader(2), standbyWorker);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_912_315,
      creeps: Object.fromEntries(workers.map((worker) => [worker.name, worker])),
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : null))
    };

    runWorker(standbyWorker);

    expect(standbyWorker.memory.task).toBeUndefined();
    expect(standbyWorker.memory.workerDispatchDiagnostic).toMatchObject({
      reason: 'controller_upgrade_saturated_standby',
      carriedEnergy: 0,
      freeCapacity: 100
    });
    expect(standbyWorker.memory.workerTaskSelectionStandby).toMatchObject({
      reason: 'controller_upgrade_saturated',
      controllerId: 'controller1',
      tick: 1_912_315
    });
  });

  it('routes full-buffer E29N56 saturated surplus workers to harvest instead of standby', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      progress: 58_331,
      progressTotal: 405_000,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000,
      pos: { x: 25, y: 25, roomName: 'E29N56' } as RoomPosition
    } as StructureController;
    const source = {
      id: 'source1',
      energy: 3_000,
      pos: { x: 20, y: 20, roomName: 'E29N56' } as RoomPosition
    } as Source;
    const workers: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [];
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        if (type === FIND_SOURCES) {
          return [source];
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES || type === FIND_DROPPED_RESOURCES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const upgrader = {
      name: 'worker-E29N56-upgrader',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    const surplusWorker = {
      name: 'worker-E29N56-surplus',
      memory: { role: 'worker', colony: 'E29N56' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(100),
        getCapacity: jest.fn().mockReturnValue(100)
      },
      room,
      harvest: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
      moveTo: jest.fn()
    } as unknown as Creep;
    workers.push(upgrader, surplusWorker);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_919_363,
      creeps: Object.fromEntries(workers.map((worker) => [worker.name, worker])),
      getObjectById: jest.fn((id: string) => {
        if (id === 'source1') {
          return source;
        }

        return id === 'controller1' ? controller : null;
      })
    };

    runWorker(surplusWorker);

    expect(surplusWorker.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(surplusWorker.memory.workerTaskSelectionStandby).toBeUndefined();
    expect(surplusWorker.memory.workerDispatchDiagnostic).toMatchObject({
      reason: 'assigned_selected_task',
      selectedTask: 'harvest',
      selectedTargetId: 'source1',
      assignedTask: 'harvest',
      assignedTargetId: 'source1'
    });
    expect(surplusWorker.harvest).toHaveBeenCalledWith(source);
    expect(surplusWorker.moveTo).toHaveBeenCalledWith(source, { range: 1 });
  });

  it('bounds healthy E29N55 RCL3 routine repair saturation after construction clears', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 1_000,
      progressTotal: 135_000,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000,
      pos: { x: 25, y: 25, roomName: 'E29N55' } as RoomPosition
    } as StructureController;
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      pos: { x: 17, y: 24, roomName: 'E29N55' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(300),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const repairTargets = Array.from({ length: 4 }, (_, index) => ({
      id: `wall-routine-${index + 1}`,
      structureType: 'constructedWall',
      hits: IDLE_RAMPART_REPAIR_HITS_CEILING - 300 - index,
      hitsMax: 300_000_000,
      pos: { x: 20 + index, y: 23, roomName: 'E29N55' } as RoomPosition
    })) as unknown as StructureWall[];
    const workers: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [];
        }

        if (type === FIND_MY_CREEPS) {
          return workers;
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [spawn, ...repairTargets] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const makeWorker = (index: number): Creep =>
      ({
        name: `worker-E29N55-${index}`,
        memory: {
          role: 'worker',
          colony: 'E29N55',
          task: { type: 'repair', targetId: `wall-routine-${index}` as Id<Structure> }
        },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(50),
          getFreeCapacity: jest.fn().mockReturnValue(0),
          getCapacity: jest.fn().mockReturnValue(50)
        },
        pos: { getRangeTo: jest.fn().mockReturnValue(4) },
        room,
        repair: jest.fn().mockReturnValue(0),
        upgradeController: jest.fn().mockReturnValue(ERR_NOT_IN_RANGE),
        moveTo: jest.fn()
      }) as unknown as Creep;
    workers.push(...Array.from({ length: 4 }, (_, index) => makeWorker(index + 1)));
    const objectsById = new Map<string, StructureController | StructureSpawn | StructureWall>([
      ['controller1', controller],
      ['spawn1', spawn],
      ...repairTargets.map((target) => [String(target.id), target] as [string, StructureWall])
    ]);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_040_188,
      creeps: Object.fromEntries(workers.map((worker) => [worker.name, worker])),
      getObjectById: jest.fn((id: string) => objectsById.get(id) ?? null)
    };

    workers.forEach(runWorker);

    const assignedTasks = workers.map((worker) => worker.memory.task?.type);
    expect(assignedTasks.filter((task) => task === 'repair')).toHaveLength(1);
    expect(assignedTasks.filter((task) => task === 'upgrade')).toHaveLength(3);
    expect(workers.filter((worker) => (worker.upgradeController as jest.Mock).mock.calls.length > 0)).toHaveLength(3);
    expect(workers.filter((worker) => (worker.repair as jest.Mock).mock.calls.length > 0)).toHaveLength(1);
  });

  it('keeps emergency spawn-extension refill ahead of E29N55 construction backlog balancing', () => {
    const site = {
      id: 'tower-site1',
      my: true,
      structureType: 'tower',
      progress: 0,
      progressTotal: 5_000,
      pos: { x: 18, y: 23, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const extension = {
      id: 'extension1',
      my: true,
      structureType: 'extension',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureExtension;
    const room = {
      name: 'E29N55',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      energyCapacityAvailable: 550,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [extension as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'worker-E29N55-refill',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn(),
      transfer: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_010_658,
      creeps: { [creep.name]: creep },
      getObjectById: jest.fn((id: string) => (id === 'extension1' ? extension : id === 'controller1' ? controller : site))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'extension1' });
    expect(creep.transfer).toHaveBeenCalledWith(extension, RESOURCE_ENERGY);
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it('keeps low tower energy ahead of RCL3 construction backlog work', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 0,
      progressTotal: 300,
      pos: { x: 19, y: 24, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const tower = {
      id: 'tower1',
      my: true,
      structureType: 'tower',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(TOWER_REFILL_ENERGY_FLOOR - 1),
        getFreeCapacity: jest.fn().mockReturnValue(501)
      }
    } as unknown as StructureTower;
    const room = {
      name: 'E29N55',
      energyAvailable: 550,
      energyCapacityAvailable: 550,
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [tower as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'worker-E29N55-tower',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn(),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_010_659,
      creeps: { [creep.name]: creep },
      getObjectById: jest.fn((id: string) => (id === 'tower1' ? tower : site))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'tower1' });
    expect(creep.transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(creep.build).not.toHaveBeenCalled();
  });

  it('preempts stale E29N56 routine repair for an RCL3 construction backlog', () => {
    const extensionSite = {
      id: 'extension-site1',
      my: true,
      structureType: 'extension',
      progress: 0,
      progressTotal: 3_000
    } as ConstructionSite;
    const towerSite = {
      id: 'tower-site1',
      my: true,
      structureType: 'tower',
      progress: 546,
      progressTotal: 5_000
    } as ConstructionSite;
    const routineWall = {
      id: 'wall-routine',
      structureType: 'constructedWall',
      hits: IDLE_RAMPART_REPAIR_HITS_CEILING - 1,
      hitsMax: 300_000_000
    } as StructureWall;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const room = {
      name: 'E29N56',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [extensionSite, towerSite];
        }

        if (type === FIND_STRUCTURES) {
          return [routineWall];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'worker-E29N56-builder',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: { type: 'repair', targetId: 'wall-routine' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn().mockReturnValue(0),
      repair: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_548_721,
      creeps: { [creep.name]: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'extension-site1'
          ? extensionSite
          : id === 'tower-site1'
            ? towerSite
            : id === 'wall-routine'
              ? routineWall
              : null
      )
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(creep.build).toHaveBeenCalledWith(extensionSite);
    expect(creep.repair).not.toHaveBeenCalled();
  });

  it('keeps E29N56 defense-floor repair ahead of RCL3 construction preemption', () => {
    const extensionSite = {
      id: 'extension-site1',
      my: true,
      structureType: 'extension',
      progress: 0,
      progressTotal: 3_000
    } as ConstructionSite;
    const defenseFloorWall = {
      id: 'wall-defense-floor',
      structureType: 'constructedWall',
      hits: BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING - 1,
      hitsMax: 300_000_000
    } as StructureWall;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const room = {
      name: 'E29N56',
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [extensionSite];
        }

        if (type === FIND_STRUCTURES) {
          return [defenseFloorWall];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'worker-E29N56-repair',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: { type: 'repair', targetId: 'wall-defense-floor' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn().mockReturnValue(0),
      repair: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1_548_722,
      creeps: { [creep.name]: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'extension-site1' ? extensionSite : id === 'wall-defense-floor' ? defenseFloorWall : null
      )
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'wall-defense-floor' });
    expect(creep.repair).toHaveBeenCalledWith(defenseFloorWall);
    expect(creep.build).not.toHaveBeenCalled();
  });

  it('keeps the RCL2 downgrade guard above upgrade preemption', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
      },
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts active spawn refill for the downgrade guard', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return [];
        })
      },
      transfer: jest.fn(),
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'controller1' ? controller : spawn))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts an RCL3 upgrade task for extension construction when downgrade is safe', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
      },
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps an RCL3 upgrade task when selection still prefers the same controller', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn().mockReturnValue([])
      },
      upgradeController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts a low-value upgrade task for damaged road repair', () => {
    const road = { id: 'road1', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [road] : []))
      },
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn()
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'road1' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('records why a loaded worker keeps harvesting instead of taking a build task', () => {
    const source = { id: 'source1' } as Source;
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      energyAvailable: 600,
      energyCapacityAvailable: 600,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_SOURCES) {
          return [source];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'PartialHarvester',
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(25),
        getFreeCapacity: jest.fn().mockReturnValue(25),
        getCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 123,
      creeps: { PartialHarvester: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : id === 'road-site1' ? site : null))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      tick: 123,
      reason: 'retained_energy_acquisition_until_full',
      currentTask: 'harvest',
      currentTargetId: 'source1',
      selectedTask: 'build',
      selectedTargetId: 'road-site1',
      assignedTask: 'harvest',
      assignedTargetId: 'source1',
      carriedEnergy: 25,
      freeCapacity: 25
    });
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1']
  ])('preempts construction for fillable %s energy under spawn pressure', (structureType, id) => {
    const site = { id: 'site1' } as ConstructionSite;
    const energySink = {
      id,
      structureType,
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureSpawn | StructureExtension;
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [energySink];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_CONSTRUCTION_SITES ? [site] : [];
          }
        )
      },
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(site)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: id });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts assigned construction for near-floor owned rampart repair', () => {
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const rampart = {
      id: 'rampart-critical',
      structureType: 'rampart',
      my: true,
      hits: BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING - 1,
      hitsMax: 30_000_000
    } as StructureRampart;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const build = jest.fn();
    const repair = jest.fn().mockReturnValue(0);
    const room = {
      name: 'E29N55',
      energyAvailable: 800,
      energyCapacityAvailable: 2300,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return [spawn];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_STRUCTURES) {
          return [rampart];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Builder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'rampart-critical' ? rampart : id === 'site1' ? site : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'rampart-critical' });
    expect(repair).toHaveBeenCalledWith(rampart);
    expect(build).not.toHaveBeenCalled();
  });

  it('preempts retained transfer for issue 1879 low-hit owned rampart repair', () => {
    const rampart = {
      id: 'rampart-issue-1879',
      structureType: 'rampart',
      my: true,
      hits: CRITICAL_OWNED_RAMPART_REPAIR_HITS_CEILING - 20_199,
      hitsMax: 30_000_000
    } as StructureRampart;
    const tower = {
      id: 'tower1',
      structureType: 'tower',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(300),
        getFreeCapacity: jest.fn().mockReturnValue(700)
      }
    } as unknown as StructureTower;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const repair = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const room = {
      name: 'E29N55',
      energyAvailable: 550,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return [tower];
        }

        if (type === FIND_STRUCTURES) {
          return [rampart, tower];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'TransferWorker',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'transfer', targetId: 'tower1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(100),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      repair,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { TransferWorker: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'rampart-issue-1879' ? rampart : id === 'tower1' ? tower : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'rampart-issue-1879' });
    expect(repair).toHaveBeenCalledWith(rampart);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('preempts low-load harvesting for defense-floor owned rampart repair before construction recovery', () => {
    const source = { id: 'source1', energy: 3_000 } as Source;
    const site = {
      id: 'site1',
      my: true,
      structureType: 'constructedWall',
      progress: 0,
      progressTotal: 5_000
    } as ConstructionSite;
    const rampart = {
      id: 'rampart-defense-floor',
      structureType: 'rampart',
      my: true,
      hits: BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING - 1,
      hitsMax: 30_000_000
    } as StructureRampart;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const build = jest.fn();
    const harvest = jest.fn();
    const repair = jest.fn().mockReturnValue(0);
    const room = {
      name: 'E29N55',
      energyAvailable: 550,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return [spawn];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_STRUCTURES) {
          return [rampart];
        }

        if (type === FIND_SOURCES) {
          return [source];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'LowLoadBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(4),
        getFreeCapacity: jest.fn().mockReturnValue(96)
      },
      room,
      build,
      harvest,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LowLoadBuilder: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'rampart-defense-floor' ? rampart : id === 'site1' ? site : id === 'source1' ? source : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'rampart-defense-floor' });
    expect(repair).toHaveBeenCalledWith(rampart);
    expect(build).not.toHaveBeenCalled();
    expect(harvest).not.toHaveBeenCalled();
  });

  it('returns partial acquired energy for emergency owned rampart repair', () => {
    const source = { id: 'source1', energy: 3_000 } as Source;
    const rampart = {
      id: 'rampart-critical',
      structureType: 'rampart',
      my: true,
      hits: 3_601,
      hitsMax: 30_000_000
    } as StructureRampart;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const harvest = jest.fn();
    const repair = jest.fn().mockReturnValue(0);
    const room = {
      name: 'E29N55',
      energyAvailable: 800,
      energyCapacityAvailable: 2300,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return [spawn];
        }

        if (type === FIND_STRUCTURES) {
          return [rampart];
        }

        if (type === FIND_SOURCES) {
          return [source];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Harvester',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40),
        getCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Harvester: creep },
      getObjectById: jest.fn((id: string) =>
        id === 'rampart-critical' ? rampart : id === 'source1' ? source : null
      ) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'rampart-critical' });
    expect(repair).toHaveBeenCalledWith(rampart);
    expect(harvest).not.toHaveBeenCalled();
  });

  it('preempts construction for fillable spawn energy after urgent pressure has cleared', () => {
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureSpawn;
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [spawn];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_CONSTRUCTION_SITES ? [site] : [];
          }
        )
      },
      build: jest.fn(),
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'spawn1' ? spawn : site))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(Game.getObjectById).toHaveBeenCalledWith('spawn1');
    expect(transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps construction ahead of idle spawn refill when the energy buffer is healthy', () => {
    const site = { id: 'site1', structureType: 'road', progress: 0, progressTotal: 100 } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(200),
        getFreeCapacity: jest.fn().mockReturnValue(100)
      }
    } as unknown as StructureSpawn;
    const extension = {
      id: 'extension1',
      structureType: 'extension',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(42),
        getFreeCapacity: jest.fn().mockReturnValue(8)
      }
    } as unknown as StructureExtension;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const room = {
      name: 'W1N1',
      energyAvailable: 442,
      energyCapacityAvailable: 450,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, extension];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1', task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      getObjectById: jest.fn((id: string) => (id === 'site1' ? site : spawn))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps construction ahead of idle spawn reservation refill when the energy buffer is healthy', () => {
    const site = { id: 'site1', structureType: 'road', progress: 0, progressTotal: 100 } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(150),
        getFreeCapacity: jest.fn().mockReturnValue(150)
      }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const room = {
      name: 'W1N1',
      energyAvailable: 442,
      energyCapacityAvailable: 450,
      controller,
      memory: { spawnEnergyReservation: { transferThreshold: 250 } },
      find: jest.fn(
        (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1', task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            W1N1: {
              bodyCost: 650,
              creepName: 'worker-W1N1-124',
              reservedAt: 123,
              reservedEnergy: 650,
              role: 'worker',
              roomName: 'W1N1',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      rooms: { W1N1: room },
      time: 124,
      getObjectById: jest.fn((id: string) => (id === 'site1' ? site : spawn))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps bounded construction ahead of spawn reservation refill when storage surplus protects recovery energy', () => {
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 0,
      progressTotal: 5_000
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(1_673),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const reserveWorker = {
      name: 'ReserveWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, reserveWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            W1N1: {
              bodyCost: 800,
              creepName: 'worker-W1N1-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'W1N1',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, ReserveWorker: reserveWorker },
      rooms: { W1N1: room },
      time: 124,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('keeps bounded container construction ahead of spawn reservation refill when container surplus protects recovery energy', () => {
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 0,
      progressTotal: 4_500
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_485 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_000 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const reserveWorker = {
      name: 'ReserveWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, reserveWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            E29N57: {
              bodyCost: 800,
              creepName: 'worker-E29N57-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, ReserveWorker: reserveWorker },
      rooms: { E29N57: room },
      time: 124,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'stored-container1' ? storedContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('keeps E29N57 container construction ahead of spawn reservation refill below the general construction floor when stored energy protects recovery', () => {
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 500,
      progressTotal: 5_000
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_900 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_000 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 250,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(30),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const reserveWorker = {
      name: 'ReserveWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, reserveWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            E29N57: {
              bodyCost: 800,
              creepName: 'worker-E29N57-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, ReserveWorker: reserveWorker },
      rooms: { E29N57: room },
      time: 124,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'stored-container1' ? storedContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('does not let spawn reservation refill starve the only E29N57 source-container builder', () => {
    const source = {
      id: 'source1',
      pos: { x: 20, y: 20, roomName: 'E29N57' } as RoomPosition
    } as Source;
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 500,
      progressTotal: 5_000,
      pos: { x: 20, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      pos: { x: 20, y: 22, roomName: 'E29N57' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_333 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_000 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(30),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            E29N57: {
              bodyCost: 800,
              creepName: 'worker-E29N57-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      rooms: { E29N57: room },
      time: 124,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'stored-container1' ? storedContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('keeps construction ahead of spawn reservation refill when another worker is acquiring refill energy', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 820,
      progressTotal: 1_000,
      pos: { x: 20, y: 23, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      pos: { x: 17, y: 24, roomName: 'E29N55' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureSpawn;
    const refillContainer = {
      id: 'refill-container1',
      structureType: 'container',
      pos: { x: 18, y: 24, roomName: 'E29N55' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(1_900)
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 250,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, refillContainer] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, refillContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const builder = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N55' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'spawn1' ? 1 : 3))
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const refillAcquirer = {
      name: 'RefillAcquirer',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'withdraw', targetId: 'refill-container1' as Id<AnyStoreStructure> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(builder, refillAcquirer);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_867_899,
          rooms: {
            E29N55: {
              bodyCost: 800,
              creepName: 'worker-E29N55-next',
              reservedAt: 1_867_899,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N55',
              updatedAt: 1_867_899
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: builder, RefillAcquirer: refillAcquirer },
      rooms: { E29N55: room },
      time: 1_867_900,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'refill-container1' ? refillContainer : null;
      })
    };

    expect(selectSpawnEnergyReservationRefillTarget(builder)).toMatchObject({
      spawn: { id: 'spawn1' },
      spawnEnergy: 250,
      threshold: 300,
      unmetReservedEnergy: 550
    });

    runWorker(builder);

    expect(builder.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
    expect(builder.memory.workerDispatchDiagnostic).toMatchObject({
      baseSelectedTask: 'build',
      selectedTask: 'build',
      assignedTask: 'build'
    });
    expect(builder.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('keeps spawn reservation refill before construction when no other worker covers refill', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 820,
      progressTotal: 1_000,
      pos: { x: 20, y: 23, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      pos: { x: 17, y: 24, roomName: 'E29N55' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 250,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const transfer = jest.fn().mockReturnValue(0);
    const builder = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N55' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'spawn1' ? 1 : 3))
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const idleWorker = {
      name: 'IdleWorker',
      memory: { role: 'worker', colony: 'E29N55' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(builder, idleWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_867_900,
          rooms: {
            E29N55: {
              bodyCost: 800,
              creepName: 'worker-E29N55-next',
              reservedAt: 1_867_900,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N55',
              updatedAt: 1_867_900
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: builder, IdleWorker: idleWorker },
      rooms: { E29N55: room },
      time: 1_867_901,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        return id === 'spawn1' ? spawn : null;
      })
    };

    expect(selectSpawnEnergyReservationRefillTarget(builder)).toMatchObject({
      spawn: { id: 'spawn1' },
      spawnEnergy: 250,
      threshold: 300,
      unmetReservedEnergy: 550
    });

    runWorker(builder);

    expect(builder.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(builder.memory.workerDispatchDiagnostic).toMatchObject({
      baseSelectedTask: 'build',
      spawnReservationTask: 'transfer',
      selectedTask: 'transfer',
      assignedTask: 'transfer'
    });
    expect(transfer).toHaveBeenCalledWith(spawn, RESOURCE_ENERGY);
    expect(build).not.toHaveBeenCalled();
  });

  it('assigns a post-deploy E29N57 builder while a stale spawn reserve signal is present', () => {
    const source = {
      id: 'source1',
      pos: { x: 20, y: 20, roomName: 'E29N57' } as RoomPosition
    } as Source;
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 10,
      progressTotal: 4_500,
      pos: { x: 20, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_090 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_000 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: 4_359
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_045,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const upgradeController = jest.fn();
    const creep = {
      name: 'LoadedBuilder',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 30 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 70 : 0))
      },
      room,
      build,
      transfer,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N57', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_663_670,
          rooms: {
            E29N57: {
              bodyCost: 1_800,
              creepName: 'worker-E29N57-next',
              reservedAt: 1_663_670,
              reservedEnergy: 1_800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 1_663_670
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedBuilder: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N57: room },
      time: 1_663_671,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'controller1') {
          return controller;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'stored-container1' ? storedContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      baseSelectedTask: 'build',
      selectedTask: 'build',
      assignedTask: 'build'
    });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
    expect(upgradeController).not.toHaveBeenCalled();
  });

  it('preempts a near-full E29N55 storage-critical withdraw for container construction under a spawn reserve signal', () => {
    const site = {
      id: 'container-site1',
      my: true,
      structureType: 'container',
      progress: 3_900,
      progressTotal: 4_500,
      pos: { x: 20, y: 21, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 600 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const acquisitionContainer = {
      id: 'energy-container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_000 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(1_000)
      }
    } as unknown as StructureContainer;
    const damagedContainer = {
      id: 'damaged-container1',
      structureType: 'container',
      hits: 500,
      hitsMax: 2_000
    } as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 3_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 2_250,
      energyCapacityAvailable: 2_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage, acquisitionContainer, damagedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const withdraw = jest.fn();
    const repair = jest.fn();
    const creep = {
      name: 'NearFullBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'withdraw', targetId: 'energy-container1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 98 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2 : 0))
      },
      room,
      build,
      withdraw,
      repair,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_812_850,
          rooms: {
            E29N55: {
              bodyCost: 2_300,
              creepName: 'worker-E29N55-next',
              reservedAt: 1_812_850,
              reservedEnergy: 2_300,
              role: 'worker',
              roomName: 'E29N55',
              updatedAt: 1_812_850
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { NearFullBuilder: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N55: room },
      time: 1_812_851,
      getObjectById: jest.fn((id: string) => {
        if (id === 'container-site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        if (id === 'storage1') {
          return storage;
        }

        if (id === 'damaged-container1') {
          return damagedContainer;
        }

        return id === 'energy-container1' ? acquisitionContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'container-site1' });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      currentTask: 'withdraw',
      currentTargetId: 'energy-container1',
      baseSelectedTask: 'build',
      selectedTask: 'build',
      assignedTask: 'build'
    });
    expect(creep.memory.workerDispatchDiagnostic?.energyCriticalTask).toBeUndefined();
    expect(creep.memory.workerDispatchDiagnostic?.energyCriticalTargetId).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(withdraw).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it('preempts covered E29N56 critical container repair for safe storage construction under a spawn reserve signal', () => {
    const site = {
      id: 'storage-site1',
      my: true,
      structureType: 'storage',
      progress: 6_846,
      progressTotal: 30_000
    } as ConstructionSite;
    const damagedContainer = {
      id: 'critical-container1',
      structureType: 'container',
      hits: 900,
      hitsMax: 2_000,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_188 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_500 : 0
        )
      }
    } as unknown as StructureContainer;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 3_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: 300,
      energyCapacityAvailable: 1_300,
      controller,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [damagedContainer];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const repair = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'Builder',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: { type: 'repair', targetId: 'critical-container1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 58 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 42 : 0))
      },
      room,
      build,
      repair,
      transfer,
      moveTo: jest.fn(),
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0))
    } as unknown as Creep;
    const repairCoverage = {
      name: 'RepairCoverage',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: { type: 'repair', targetId: 'critical-container1' as Id<Structure> }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 85 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 15 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, repairCoverage);
    const assessment = assessColonySurvival({
      roomName: 'E29N56',
      totalCreeps: 10,
      workerCapacity: 3,
      workerTarget: 4,
      energyAvailable: 300,
      energyCapacityAvailable: 1_300,
      defenseFloorReady: true,
      controller: { my: true, level: 4, ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 3_000 },
      hostileCreepCount: 0
    });
    expect(assessment.mode).toBe('LOCAL_STABLE');
    recordColonySurvivalAssessment('E29N56', assessment, 1_854_806);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_854_805,
          rooms: {
            E29N56: {
              bodyCost: 1_300,
              creepName: 'worker-E29N56-next',
              reservedAt: 1_854_805,
              reservedEnergy: 1_300,
              role: 'worker',
              roomName: 'E29N56',
              updatedAt: 1_854_805
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, RepairCoverage: repairCoverage },
      rooms: { E29N56: room },
      time: 1_854_806,
      getObjectById: jest.fn((id: string) => {
        if (id === 'storage-site1') {
          return site;
        }

        if (id === 'critical-container1') {
          return damagedContainer;
        }

        return id === 'spawn1' ? spawn : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'storage-site1' });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      currentTask: 'repair',
      selectedTask: 'build',
      assignedTask: 'build'
    });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(repair).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each([
    ['zero energy', 0, 1],
    ['no active WORK parts', 85, 0]
  ])(
    'keeps critical container repair when same-target coverage has %s',
    (_label, coverageEnergy, coverageWorkParts) => {
      const site = {
        id: 'storage-site1',
        my: true,
        structureType: 'storage',
        progress: 6_846,
        progressTotal: 30_000
      } as ConstructionSite;
      const damagedContainer = {
        id: 'critical-container1',
        structureType: 'container',
        hits: 900,
        hitsMax: 2_000
      } as StructureContainer;
      const controller = {
        id: 'controller1',
        my: true,
        level: 4,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 3_000
      } as StructureController;
      const roomCreeps: Creep[] = [];
      const room = {
        name: 'E29N56',
        energyAvailable: 500,
        energyCapacityAvailable: 1_300,
        controller,
        find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
            return [];
          }

          if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES || type === FIND_CONSTRUCTION_SITES) {
            return [];
          }

          return [];
        })
      } as unknown as Room;
      const build = jest.fn().mockReturnValue(0);
      const repair = jest.fn().mockReturnValue(0);
      const selectedBuildTask = { type: 'build', targetId: 'storage-site1' as Id<ConstructionSite> } as const;
      const creep = {
        name: 'Builder',
        memory: {
          role: 'worker',
          colony: 'E29N56',
          task: { type: 'repair', targetId: 'critical-container1' as Id<Structure> }
        },
        store: {
          getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 58 : 0)),
          getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 42 : 0))
        },
        room,
        build,
        repair,
        moveTo: jest.fn()
      } as unknown as Creep;
      const staleCoverage = {
        name: 'StaleCoverage',
        memory: {
          role: 'worker',
          colony: 'E29N56',
          task: { type: 'repair', targetId: 'critical-container1' as Id<Structure> }
        },
        store: {
          getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY ? coverageEnergy : 0
          )
        },
        getActiveBodyparts: jest.fn((part?: BodyPartConstant) =>
          part === 'work' ? coverageWorkParts : 0
        ),
        room
      } as unknown as Creep;
      roomCreeps.push(creep, staleCoverage);
      const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedBuildTask);
      (globalThis as unknown as { Game: Partial<Game> }).Game = {
        creeps: { Builder: creep, StaleCoverage: staleCoverage },
        rooms: { E29N56: room },
        time: 1_854_806,
        getObjectById: jest.fn((id: string) => {
          if (id === 'storage-site1') {
            return site;
          }

          return id === 'critical-container1' ? damagedContainer : null;
        })
      };

      try {
        runWorker(creep);

        expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'critical-container1' });
        expect(repair).toHaveBeenCalledWith(damagedContainer);
        expect(build).not.toHaveBeenCalled();
      } finally {
        selectWorkerTask.mockRestore();
      }
    }
  );

  it('keeps an existing near-full build assignment when storage-critical acquisition yields', () => {
    const site = {
      id: 'container-site1',
      my: true,
      structureType: 'container',
      progress: 3_900,
      progressTotal: 4_500,
      pos: { x: 20, y: 21, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 600 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const acquisitionContainer = {
      id: 'energy-container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_000 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(1_000)
      }
    } as unknown as StructureContainer;
    const room = {
      name: 'E29N55',
      energyAvailable: 2_250,
      energyCapacityAvailable: 2_300,
      storage,
      find: jest.fn((type: number) => {
        if (type === FIND_STRUCTURES) {
          return [storage, acquisitionContainer];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return [];
      })
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const withdraw = jest.fn();
    const selectedBuildTask = { type: 'build', targetId: 'container-site1' as Id<ConstructionSite> } as const;
    const yieldedAcquisitionTask = {
      type: 'withdraw',
      targetId: 'energy-container1' as Id<AnyStoreStructure>
    } as const;
    const creep = {
      name: 'NearFullBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: selectedBuildTask,
        workerEnergyCriticalPolicy: {
          type: 'workerEnergyCriticalPolicy',
          schemaVersion: 1,
          active: true,
          reason: 'storage',
          enteredAt: 1_812_850,
          updatedAt: 1_812_851,
          storageEnergy: 600,
          storageEnterThreshold: 1_000,
          storageExitThreshold: 1_250
        }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 98 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2 : 0))
      },
      room,
      build,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedBuildTask);
    const selectWorkerEnergyCriticalTask = jest
      .spyOn(workerTaskPolicy, 'selectWorkerEnergyCriticalTask')
      .mockReturnValue(yieldedAcquisitionTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { NearFullBuilder: creep },
      rooms: { E29N55: room },
      time: 1_812_851,
      getObjectById: jest.fn((id: string) => {
        if (id === 'container-site1') {
          return site;
        }

        return id === 'energy-container1' ? acquisitionContainer : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual(selectedBuildTask);
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'build',
        currentTargetId: 'container-site1',
        baseSelectedTask: 'build',
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(creep.memory.workerDispatchDiagnostic?.energyCriticalTask).toBeUndefined();
      expect(creep.memory.workerDispatchDiagnostic?.energyCriticalTargetId).toBeUndefined();
      expect(build).toHaveBeenCalledWith(site);
      expect(withdraw).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
      selectWorkerEnergyCriticalTask.mockRestore();
    }
  });

  it('recovers construction assignment from retained routine repair under storage-critical transfer selection', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 497,
      progressTotal: 500
    } as ConstructionSite;
    const routineWall = {
      id: 'wall-routine',
      structureType: 'constructedWall',
      hits: IDLE_RAMPART_REPAIR_HITS_CEILING - 1,
      hitsMax: 300_000_000
    } as StructureWall;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 750 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      controller,
      storage,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storage, routineWall];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const repair = jest.fn();
    const transfer = jest.fn();
    const repairTask = { type: 'repair', targetId: 'wall-routine' as Id<Structure> } as const;
    const creep = {
      name: 'LoadedRepairWorker',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: repairTask
      },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      },
      room,
      build,
      repair,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const supportWorker = {
      name: 'SupportWorker',
      memory: { role: 'worker', colony: 'E29N55' },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, supportWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(repairTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedRepairWorker: creep, SupportWorker: supportWorker },
      rooms: { E29N55: room },
      time: 2_050_073,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'wall-routine') {
          return routineWall;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'repair',
        currentTargetId: 'wall-routine',
        baseSelectedTask: 'repair',
        baseSelectedTargetId: 'wall-routine',
        energyCriticalTask: 'transfer',
        energyCriticalTargetId: 'storage1',
        selectedTask: 'build',
        selectedTargetId: 'road-site1',
        assignedTask: 'build',
        assignedTargetId: 'road-site1'
      });
      expect(build).toHaveBeenCalledWith(site);
      expect(repair).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers E29N55 construction assignment when selection keeps routine repair active', () => {
    const site = {
      id: 'rampart-site1',
      my: true,
      structureType: 'rampart',
      progress: 2_894,
      progressTotal: 5_000
    } as ConstructionSite;
    const routineRampart = {
      id: 'rampart-routine',
      my: true,
      structureType: 'rampart',
      hits: CRITICAL_OWNED_RAMPART_REPAIR_HITS_CEILING + 1,
      hitsMax: 30_000_000
    } as StructureRampart;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn((type: number, options?: { filter?: (object: Creep) => boolean }) => {
        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_STRUCTURES) {
          return [routineRampart];
        }

        if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const repairTask = { type: 'repair', targetId: 'rampart-routine' as Id<Structure> } as const;
    const creep = {
      name: 'worker-E29N55-2086075',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: repairTask
      },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 97 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 3 : 0))
      },
      room,
      build: jest.fn().mockReturnValue(0),
      repair: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    const emptyWorker = {
      name: 'worker-E29N55-2085929',
      memory: { role: 'worker', colony: 'E29N55' },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, emptyWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(repairTask);
    const selectWorkerEnergyCriticalTask = jest
      .spyOn(workerTaskPolicy, 'selectWorkerEnergyCriticalTask')
      .mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        [creep.name]: creep,
        [emptyWorker.name]: emptyWorker
      },
      rooms: { E29N55: room },
      time: 2_086_489,
      getObjectById: jest.fn((id: string) => {
        if (id === 'rampart-site1') {
          return site;
        }

        return id === 'rampart-routine' ? routineRampart : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'rampart-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'repair',
        currentTargetId: 'rampart-routine',
        baseSelectedTask: 'repair',
        baseSelectedTargetId: 'rampart-routine',
        selectedTask: 'build',
        selectedTargetId: 'rampart-site1',
        assignedTask: 'build',
        assignedTargetId: 'rampart-site1'
      });
      expect(creep.build).toHaveBeenCalledWith(site);
      expect(creep.repair).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
      selectWorkerEnergyCriticalTask.mockRestore();
    }
  });

  it('preempts a stale E29N57 spawn reservation transfer when stored energy can cover construction', () => {
    const site = {
      id: 'road-site1',
      structureType: 'road',
      progress: 935,
      progressTotal: 5_000,
      pos: { x: 22, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 1_332 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'LoadedBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 68 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 32 : 0))
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_676_999,
          rooms: {
            E29N57: {
              bodyCost: 1_800,
              creepName: 'worker-E29N57-next',
              reservedAt: 1_676_999,
              reservedEnergy: 1_800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 1_676_999
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedBuilder: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N57: room },
      time: 1_677_000,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      currentTask: 'transfer',
      baseSelectedTask: 'build',
      selectedTask: 'build',
      assignedTask: 'build'
    });
    expect(creep.memory.workerDispatchDiagnostic?.spawnReservationTask).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('preempts retained harvest for construction backlog when stored energy can cover construction', () => {
    const source = {
      id: 'source1',
      energy: 3_000
    } as Source;
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 935,
      progressTotal: 5_000
    } as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_441 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 300,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const harvest = jest.fn();
    const selectedBuildTask = { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> } as const;
    const creep = {
      name: 'LoadedHarvester',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 15 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 85 : 0))
      },
      room,
      build,
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedBuildTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedHarvester: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N57: room },
      time: 1_870_030,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'source1') {
          return source;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual(selectedBuildTask);
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'harvest',
        baseSelectedTask: 'build',
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(build).toHaveBeenCalledWith(site);
      expect(harvest).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers E29N55 build assignment from spawn-critical harvest when another worker covers spawn floor', () => {
    const source = {
      id: 'source1',
      energy: 3_000
    } as Source;
    const site = {
      id: 'tower-site1',
      my: true,
      structureType: 'tower',
      progress: 1_093,
      progressTotal: 5_000,
      pos: { x: 22, y: 21, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 175 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 125 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_455 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 175,
      energyCapacityAvailable: 2_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const harvest = jest.fn();
    const selectedUpgradeTask = { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } as const;
    const creep = {
      name: 'LoadedHarvester',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 75 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 25 : 0))
      },
      room,
      build,
      harvest,
      moveTo: jest.fn()
    } as unknown as Creep;
    const spawnRefillWorker = {
      name: 'SpawnRefillWorker',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 30 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 70 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, spawnRefillWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedUpgradeTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedHarvester: creep, SpawnRefillWorker: spawnRefillWorker },
      rooms: { E29N55: room },
      time: 2_083_286,
      getObjectById: jest.fn((id: string) => {
        if (id === 'tower-site1') {
          return site;
        }

        if (id === 'source1') {
          return source;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        if (id === 'controller1') {
          return controller;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'tower-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'harvest',
        currentTargetId: 'source1',
        baseSelectedTask: 'upgrade',
        baseSelectedTargetId: 'controller1',
        energyCriticalTask: 'harvest',
        energyCriticalTargetId: 'source1',
        selectedTask: 'build',
        selectedTargetId: 'tower-site1',
        assignedTask: 'build',
        assignedTargetId: 'tower-site1'
      });
      expect(build).toHaveBeenCalledWith(site);
      expect(harvest).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('keeps a low-load postdeploy harvester acquiring before assignment-gap construction recovery', () => {
    const source = {
      id: 'source1',
      energy: 3_000
    } as Source;
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 955,
      progressTotal: 5_000,
      pos: { x: 22, y: 21, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const extension = {
      id: 'extension1',
      structureType: 'extension',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureExtension;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_233 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 2_233,
      energyCapacityAvailable: 2_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [extension, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [extension, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const harvest = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const selectedTransferTask = { type: 'transfer', targetId: 'extension1' as Id<AnyStoreStructure> } as const;
    const creep = {
      name: 'worker-E29N55-2122408',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 6 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 94 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      build,
      harvest,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const coverageWorker = {
      name: 'worker-E29N55-coverage',
      memory: { role: 'worker', colony: 'E29N55' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, coverageWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedTransferTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { [creep.name]: creep, [coverageWorker.name]: coverageWorker },
      rooms: { E29N55: room },
      time: 2_123_184,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'source1') {
          return source;
        }

        if (id === 'extension1') {
          return extension;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        tick: 2_123_184,
        reason: 'retained_low_load_energy_acquisition',
        carriedEnergy: 6,
        freeCapacity: 94,
        currentTask: 'harvest',
        currentTargetId: 'source1',
        baseSelectedTask: 'transfer',
        baseSelectedTargetId: 'extension1',
        selectedTask: 'transfer',
        selectedTargetId: 'extension1',
        assignedTask: 'harvest',
        assignedTargetId: 'source1'
      });
      expect(creep.memory.workerDispatchDiagnostic?.reason).not.toBe('preempted_for_urgent_spending');
      expect(harvest).toHaveBeenCalledWith(source);
      expect(build).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers construction assignment from retained controller progress when stored energy can cover construction', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 1_429,
      progressTotal: 5_000,
      pos: { x: 22, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_438 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const upgradeController = jest.fn();
    const selectedUpgradeTask = { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } as const;
    const creep = {
      name: 'LoadedUpgrader',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: selectedUpgradeTask
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 97 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 3 : 0))
      },
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'road-site1' ? 3 : 12))
      },
      room,
      build,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedUpgradeTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedUpgrader: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N57: room },
      time: 1_871_982,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'controller1') {
          return controller;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'upgrade',
        baseSelectedTask: 'upgrade',
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(build).toHaveBeenCalledWith(site);
      expect(upgradeController).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers a single retained upgrader to construction when stored surplus preserves spawn recovery', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 4_754,
      progressTotal: 5_000,
      pos: { x: 22, y: 24, roomName: 'E29N56' } as RoomPosition
    } as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 593_641 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: MINIMUM_WORKER_SPAWN_ENERGY,
      energyCapacityAvailable: 1_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const upgradeController = jest.fn();
    const selectedUpgradeTask = { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } as const;
    const creep = {
      name: 'LoadedUpgrader',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: selectedUpgradeTask
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 73 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 27 : 0))
      },
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'road-site1' ? 3 : 12))
      },
      room,
      build,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedUpgradeTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedUpgrader: creep },
      rooms: { E29N56: room },
      time: 1_882_759,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'controller1') {
          return controller;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'upgrade',
        baseSelectedTask: 'upgrade',
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(build).toHaveBeenCalledWith(site);
      expect(upgradeController).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('uses energy recovery instead of assignment-gap construction below the spawn energy floor', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 4_754,
      progressTotal: 5_000
    } as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 593_641 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: MINIMUM_WORKER_SPAWN_ENERGY - 1,
      energyCapacityAvailable: 1_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
            const structures = [storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const upgradeController = jest.fn().mockReturnValue(0);
    const withdraw = jest.fn().mockReturnValue(0);
    const selectedUpgradeTask = { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } as const;
    const creep = {
      name: 'LoadedUpgrader',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: selectedUpgradeTask
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 73 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 27 : 0))
      },
      room,
      build: jest.fn(),
      withdraw,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedUpgradeTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedUpgrader: creep },
      rooms: { E29N56: room },
      time: 1_882_760,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'controller1') {
          return controller;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'storage1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'upgrade',
        baseSelectedTask: 'upgrade',
        energyCriticalTask: 'withdraw',
        selectedTask: 'withdraw',
        assignedTask: 'withdraw'
      });
      expect(creep.build).not.toHaveBeenCalled();
      expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 27);
      expect(upgradeController).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers construction assignment from retained noncritical extension refill selection', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 935,
      progressTotal: 5_000
    } as ConstructionSite;
    const extension = {
      id: 'extension1',
      structureType: 'extension',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureExtension;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_287 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 300,
      energyCapacityAvailable: 2_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [extension, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [extension, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const selectedTransferTask = { type: 'transfer', targetId: 'extension1' as Id<AnyStoreStructure> } as const;
    const creep = {
      name: 'LoadedRefiller',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: selectedTransferTask
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 55 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 45 : 0))
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N55' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedTransferTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedRefiller: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N55: room },
      time: 1_870_031,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'extension1') {
          return extension;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'transfer',
        baseSelectedTask: 'transfer',
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(build).toHaveBeenCalledWith(site);
      expect(transfer).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('adds an E29N57 builder when the existing build assignment cannot cover pending progress', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 265,
      progressTotal: 500,
      pos: { x: 22, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const backlogSite = {
      id: 'container-site1',
      my: true,
      structureType: 'container',
      progress: 0,
      progressTotal: 500,
      pos: { x: 25, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const extension = {
      id: 'extension1',
      structureType: 'extension',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureExtension;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_511 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [extension, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [extension, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site, backlogSite];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const selectedTransferTask = { type: 'transfer', targetId: 'extension1' as Id<AnyStoreStructure> } as const;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'LoadedRefiller',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: selectedTransferTask
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 53 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 47 : 0))
      },
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'road-site1' ? 3 : 8))
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const existingBuilder = {
      name: 'ExistingBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 25 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 75 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, existingBuilder);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedTransferTask);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedRefiller: creep, ExistingBuilder: existingBuilder },
      rooms: { E29N57: room },
      time: 1_893_309,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'extension1') {
          return extension;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        currentTask: 'transfer',
        baseSelectedTask: 'transfer',
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(build).toHaveBeenCalledWith(site);
      expect(transfer).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers construction assignment for a full idle worker when selection returns null', () => {
    const site = {
      id: 'storage-site1',
      my: true,
      structureType: 'storage',
      progress: 334,
      progressTotal: 4_000
    } as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 3_240 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: 300,
      energyCapacityAvailable: 1_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'IdleLoadedWorker',
      memory: { role: 'worker', colony: 'E29N56' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      },
      room,
      build,
      moveTo: jest.fn()
    } as unknown as Creep;
    const existingBuilder = {
      name: 'ExistingBuilder',
      memory: { role: 'worker', colony: 'E29N56', task: { type: 'build', targetId: 'storage-site1' as Id<ConstructionSite> } },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, existingBuilder);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { IdleLoadedWorker: creep, ExistingBuilder: existingBuilder },
      rooms: { E29N56: room },
      time: 1_870_032,
      getObjectById: jest.fn((id: string) => {
        if (id === 'storage-site1') {
          return site;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'storage-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(build).toHaveBeenCalledWith(site);
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers post-deploy E29N57 construction from loaded idle workers behind nominal build coverage', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 479,
      progressTotal: 500,
      pos: { x: 22, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 608_724 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_200,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'LoadedIdleWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      room,
      build,
      moveTo: jest.fn()
    } as unknown as Creep;
    const existingBuilder = {
      name: 'ExistingBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, existingBuilder);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(null);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 2_116_688,
          rooms: {
            E29N57: {
              bodyCost: 1_800,
              creepName: 'worker-E29N57-next',
              reservedAt: 2_116_688,
              reservedEnergy: 1_800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 2_116_688
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedIdleWorker: creep, ExistingBuilder: existingBuilder },
      rooms: { E29N57: room },
      time: 2_116_693,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(build).toHaveBeenCalledWith(site);
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('recovers E29N56 storage construction while the spawn is active when stored energy covers construction', () => {
    const site = {
      id: 'storage-site1',
      my: true,
      structureType: 'storage',
      progress: 3_829,
      progressTotal: 4_000
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: { name: 'worker-E29N56-next' },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 642_284 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'LoadedIdleWorker',
      memory: { role: 'worker', colony: 'E29N56' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      },
      room,
      build,
      moveTo: jest.fn()
    } as unknown as Creep;
    const coverageWorker = {
      name: 'CoverageWorker',
      memory: { role: 'worker', colony: 'E29N56' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, coverageWorker);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedIdleWorker: creep, CoverageWorker: coverageWorker },
      rooms: { E29N56: room },
      time: 2_109_911,
      getObjectById: jest.fn((id: string) => {
        if (id === 'storage-site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({ type: 'build', targetId: 'storage-site1' });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        selectedTask: 'build',
        assignedTask: 'build'
      });
      expect(creep.memory.workerDispatchDiagnostic?.baseSelectedTask).toBeUndefined();
      expect(build).toHaveBeenCalledWith(site);
    } finally {
      selectWorkerTask.mockRestore();
    }
  });

  it('preempts a low-bucket E29N56 controller-sustain upgrade for uncovered local construction', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 0,
      progressTotal: 1_005,
      pos: { x: 20, y: 24, roomName: 'E29N56' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      my: true,
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 628_506 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller,
      storage,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [spawn, storage];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES || type === FIND_SOURCES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const upgradeController = jest.fn().mockReturnValue(0);
    const sustainUpgrader = {
      name: 'worker-E29N56-2171723',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        controllerSustain: { homeRoom: 'E29N56', targetRoom: 'E29N56', role: 'upgrader' },
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      build,
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    const loader = {
      name: 'worker-E29N56-2173146',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        task: { type: 'withdraw', targetId: 'storage1' as Id<AnyStoreStructure> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(sustainUpgrader, loader);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { [sustainUpgrader.name]: sustainUpgrader, [loader.name]: loader },
      rooms: { E29N56: room },
      time: 2_173_197,
      cpu: {
        getUsed: jest.fn().mockReturnValue(20.7),
        limit: 70,
        bucket: LOW_CPU_BUCKET_THRESHOLD - 224,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'controller1') {
          return controller;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(sustainUpgrader);

    expect(sustainUpgrader.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
    expect(build).toHaveBeenCalledWith(site);
    expect(upgradeController).not.toHaveBeenCalled();
  });

  it('keeps an empty E29N56 controller-sustain upgrader off home construction withdraws', () => {
    const site = {
      id: 'storage-site1',
      my: true,
      structureType: 'storage',
      progress: 2_785,
      progressTotal: 4_000,
      pos: { x: 23, y: 22, roomName: 'E29N56' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      my: true,
      structureType: 'spawn',
      spawning: { name: 'worker-E29N56-next', remainingTime: 8 },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      pos: { x: 24, y: 22, roomName: 'E29N56' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 617_846 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const homeController = {
      id: 'home-controller',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const homeRoom = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller: homeController,
      storage,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
          const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_MY_CREEPS || type === FIND_HOSTILE_CREEPS || type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const targetController = {
      id: 'target-controller',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const targetRoom = {
      name: 'E29N57',
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      controller: targetController,
      find: jest.fn((type: number, options?: { filter?: (object: Creep) => boolean }) => {
        if (type === FIND_MY_CREEPS) {
          const creeps = [creep] as Creep[];
          return options?.filter ? creeps.filter(options.filter) : creeps;
        }

        if (
          type === FIND_MY_STRUCTURES ||
          type === FIND_STRUCTURES ||
          type === FIND_CONSTRUCTION_SITES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_SOURCES ||
          type === FIND_DROPPED_RESOURCES
        ) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const moveTo = jest.fn();
    const creep = {
      name: 'worker-E29N56-2170225',
      memory: {
        role: 'worker',
        colony: 'E29N56',
        controllerSustain: {
          homeRoom: 'E29N56',
          targetRoom: 'E29N57',
          role: 'upgrader'
        }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      pos: {
        getRangeTo: jest.fn().mockReturnValue(50)
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room: targetRoom,
      withdraw,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { [creep.name]: creep },
      rooms: { E29N56: homeRoom, E29N57: targetRoom },
      time: 2_170_816,
      getObjectById: jest.fn((id: string) => {
        if (id === 'storage-site1') {
          return site;
        }

        if (id === 'storage1') {
          return storage;
        }

        if (id === 'home-controller') {
          return homeController;
        }

        return id === 'target-controller' ? targetController : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      reason: 'no_selected_task_idle'
    });
    expect(withdraw).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('keeps an empty E29N56 sustain upgrader home for uncovered construction withdrawal before departing', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 0,
      progressTotal: 5_000,
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 5 : 99))
      }
    } as unknown as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      my: true,
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 651_820 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(348_180)
      }
    } as unknown as StructureStorage;
    const homeController = {
      id: 'home-controller',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const targetController = {
      id: 'target-controller',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const homeRoom = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller: homeController,
      storage,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [spawn, storage];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_HOSTILE_CREEPS || type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const targetRoom = {
      name: 'E29N57',
      controller: targetController,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const moveTo = jest.fn();
    const creep = {
      name: 'worker-E29N56-E29N57-upgrader-2183356',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        controllerSustain: {
          homeRoom: 'E29N56',
          targetRoom: 'E29N57',
          role: 'upgrader'
        }
      },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 5 : 99))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room: homeRoom,
      withdraw,
      moveTo
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { [creep.name]: creep },
      rooms: { E29N56: homeRoom, E29N57: targetRoom },
      time: 2_184_337,
      cpu: {
        getUsed: jest.fn().mockReturnValue(14.38),
        limit: 70,
        bucket: 1_049,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'storage1') {
          return storage;
        }

        if (id === 'home-controller') {
          return homeController;
        }

        return id === 'target-controller' ? targetController : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'storage1',
      constructionSiteId: 'road-site1'
    });
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
    expect(moveTo).toHaveBeenCalledWith(storage, { range: 1 });
    expect(moveTo).not.toHaveBeenCalledWith(targetController);
  });

  it('retains an E29N56 sustain upgrader construction withdrawal across home ticks', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 0,
      progressTotal: 5_000,
      pos: { x: 22, y: 21, roomName: 'E29N56' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      my: true,
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 651_820 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(348_180)
      }
    } as unknown as StructureStorage;
    const homeController = {
      id: 'home-controller',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const targetController = {
      id: 'target-controller',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const homeRoom = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller: homeController,
      storage,
      find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [spawn, storage];
        }

        if (type === FIND_MY_CREEPS) {
          return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === FIND_HOSTILE_CREEPS || type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const targetRoom = {
      name: 'E29N57',
      controller: targetController,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const moveTo = jest.fn();
    const creep = {
      name: 'worker-E29N56-E29N57-upgrader-2183356',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        controllerSustain: {
          homeRoom: 'E29N56',
          targetRoom: 'E29N57',
          role: 'upgrader'
        },
        task: {
          type: 'withdraw',
          targetId: 'storage1' as Id<StructureStorage>,
          constructionSiteId: 'road-site1' as Id<ConstructionSite>
        }
      },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 5 : 99))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room: homeRoom,
      withdraw,
      moveTo
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { [creep.name]: creep },
      rooms: { E29N56: homeRoom, E29N57: targetRoom },
      time: 2_184_338,
      cpu: {
        getUsed: jest.fn().mockReturnValue(14.38),
        limit: 70,
        bucket: 1_049,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'storage1') {
          return storage;
        }

        if (id === 'home-controller') {
          return homeController;
        }

        return id === 'target-controller' ? targetController : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'storage1',
      constructionSiteId: 'road-site1'
    });
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
    expect(moveTo).toHaveBeenCalledWith(storage, { range: 1 });
    expect(moveTo).not.toHaveBeenCalledWith(targetController);
  });

  it('retains an E29N56 sustain upgrader home build assignment before departing', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 125,
      progressTotal: 5_000,
      pos: { x: 22, y: 21, roomName: 'E29N56' } as RoomPosition
    } as ConstructionSite;
    const homeController = {
      id: 'home-controller',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const targetController = {
      id: 'target-controller',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const homeRoom = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller: homeController,
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_MY_CREEPS ||
          type === FIND_MY_STRUCTURES ||
          type === FIND_STRUCTURES ||
          type === FIND_SOURCES ||
          type === FIND_DROPPED_RESOURCES
        ) {
          return [];
        }

        return [];
      })
    } as unknown as Room;
    const targetRoom = {
      name: 'E29N57',
      controller: targetController,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const moveTo = jest.fn();
    const creep = {
      name: 'worker-E29N56-E29N57-upgrader-2183357',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        controllerSustain: {
          homeRoom: 'E29N56',
          targetRoom: 'E29N57',
          role: 'upgrader'
        },
        task: { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> }
      },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'road-site1' ? 5 : 99))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0))
      },
      room: homeRoom,
      build,
      moveTo
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { [creep.name]: creep },
      rooms: { E29N56: homeRoom, E29N57: targetRoom },
      time: 2_184_339,
      cpu: {
        getUsed: jest.fn().mockReturnValue(14.38),
        limit: 70,
        bucket: 1_049,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'home-controller') {
          return homeController;
        }

        return id === 'target-controller' ? targetController : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
    expect(build).toHaveBeenCalledWith(site);
    expect(moveTo).toHaveBeenCalledWith(site, { range: 3, ignoreCreeps: true });
    expect(moveTo).not.toHaveBeenCalledWith(targetController);
  });

  it('assigns an E29N57 construction withdraw when backlog exists and stored energy is nearby', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 4_886,
      progressTotal: 5_000,
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 3 : 99))
      }
    } as unknown as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'EmptyBuilder' ? 3 : 1))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 590_234 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS || type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'EmptyBuilder',
      memory: { role: 'worker', colony: 'E29N57' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 3 : 99))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { EmptyBuilder: creep },
      rooms: { E29N57: room },
      time: 2_109_911,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'storage1',
      constructionSiteId: 'road-site1'
    });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      baseSelectedTask: 'withdraw',
      selectedTask: 'withdraw',
      assignedTask: 'withdraw'
    });
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
  });

  it('assigns an E29N56 construction withdraw under low-bucket recovery when local backlog is uncovered', () => {
    const roadSite = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 0,
      progressTotal: 5_000,
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 6 : 99))
      }
    } as unknown as ConstructionSite;
    const rampartSite = {
      id: 'rampart-site1',
      my: true,
      structureType: 'rampart',
      progress: 0,
      progressTotal: 255,
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 4 : 99))
      }
    } as unknown as ConstructionSite;
    const storage = {
      id: 'storage1',
      my: true,
      structureType: 'storage',
      pos: {
        getRangeTo: jest.fn((target: RoomObject) =>
          String((target as { id?: string }).id) === 'worker-E29N56-2183356' ? 5 : 1
        )
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 651_820 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(348_180)
      }
    } as unknown as StructureStorage;
    const spawn = {
      id: 'spawn1',
      my: true,
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N56',
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [roadSite, rampartSite];
          }

          if (type === FIND_HOSTILE_CREEPS || type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const sourceHarvester = {
      name: 'sourceHarvester-E29N56-2183547',
      memory: { role: 'sourceHarvester', colony: 'E29N56' },
      room,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as Creep;
    const withdraw = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const creep = {
      name: 'worker-E29N56-2183356',
      memory: { role: 'worker', colony: 'E29N56' },
      getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 5 : 99))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(sourceHarvester, creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        [sourceHarvester.name]: sourceHarvester,
        [creep.name]: creep
      },
      rooms: { E29N56: room },
      time: 2_184_337,
      cpu: {
        getUsed: jest.fn().mockReturnValue(14.38),
        limit: 70,
        bucket: 1_049,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return roadSite;
        }

        if (id === 'rampart-site1') {
          return rampartSite;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'storage1',
      constructionSiteId: 'rampart-site1'
    });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      baseSelectedTask: 'withdraw',
      selectedTask: 'withdraw',
      assignedTask: 'withdraw'
    });
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
  });

  it('turns an empty retained build assignment into construction energy withdrawal', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 4_886,
      progressTotal: 5_000,
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 3 : 99))
      }
    } as unknown as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'AssignedBuilder' ? 3 : 1))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 590_234 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS || type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'AssignedBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 3 : 99))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      build,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { AssignedBuilder: creep },
      rooms: { E29N57: room },
      time: 2_123_185,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'storage1',
      constructionSiteId: 'road-site1'
    });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      tick: 2_123_185,
      reason: 'preempted_for_new_task',
      currentTask: 'build',
      currentTargetId: 'road-site1',
      baseSelectedTask: 'withdraw',
      baseSelectedTargetId: 'storage1',
      selectedTask: 'withdraw',
      selectedTargetId: 'storage1',
      assignedTask: 'withdraw',
      assignedTargetId: 'storage1'
    });
    expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
    expect(build).not.toHaveBeenCalled();
  });

  it('turns a newly selected empty build assignment into construction energy withdrawal', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 4_886,
      progressTotal: 5_000,
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 3 : 99))
      }
    } as unknown as ConstructionSite;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'FreshBuilder' ? 3 : 1))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 590_234 : 0)),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 1_800,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS || type === FIND_SOURCES || type === FIND_DROPPED_RESOURCES) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const selectedBuildTask = { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> } as const;
    const build = jest.fn();
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'FreshBuilder',
      memory: { role: 'worker', colony: 'E29N57' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => (String((target as { id?: string }).id) === 'storage1' ? 3 : 99))
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      build,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedBuildTask);
    const selectWorkerEnergyCriticalTask = jest
      .spyOn(workerTaskPolicy, 'selectWorkerEnergyCriticalTask')
      .mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { FreshBuilder: creep },
      rooms: { E29N57: room },
      time: 2_123_186,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    try {
      runWorker(creep);

      expect(creep.memory.task).toEqual({
        type: 'withdraw',
        targetId: 'storage1',
        constructionSiteId: 'road-site1'
      });
      expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
        tick: 2_123_186,
        reason: 'assigned_selected_task',
        baseSelectedTask: 'build',
        baseSelectedTargetId: 'road-site1',
        selectedTask: 'withdraw',
        selectedTargetId: 'storage1',
        assignedTask: 'withdraw',
        assignedTargetId: 'storage1'
      });
      expect(withdraw).toHaveBeenCalledWith(storage, RESOURCE_ENERGY, 100);
      expect(build).not.toHaveBeenCalled();
    } finally {
      selectWorkerTask.mockRestore();
      selectWorkerEnergyCriticalTask.mockRestore();
    }
  });

  it.each([
    ['empty', 0, 100],
    ['low-load', 18, 82]
  ])(
    'tops up a retained %s construction assignment from source energy when the selector still returns build',
    (_label, carriedEnergy, freeCapacity) => {
      const source = {
        id: 'source1',
        energy: 300,
        pos: { x: 15, y: 20, roomName: 'E29N57' } as RoomPosition
      } as Source;
      const site = {
        id: 'road-site1',
        my: true,
        structureType: 'road',
        progress: 4_715,
        progressTotal: 5_000,
        pos: { x: 20, y: 21, roomName: 'E29N57' } as RoomPosition
      } as ConstructionSite;
      const controller = {
        id: 'controller1',
        my: true,
        level: 5,
        ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 5_000
      } as StructureController;
      const roomCreeps: Creep[] = [];
      const room = {
        name: 'E29N57',
        energyAvailable: 1_800,
        energyCapacityAvailable: 1_800,
        controller,
        find: jest.fn(
          (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
            if (type === FIND_CONSTRUCTION_SITES) {
              return [site];
            }

            if (type === FIND_SOURCES) {
              return [source];
            }

            if (type === FIND_MY_CREEPS) {
              return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
            }

            if (
              type === FIND_MY_STRUCTURES ||
              type === FIND_STRUCTURES ||
              type === FIND_DROPPED_RESOURCES ||
              type === FIND_HOSTILE_CREEPS
            ) {
              return [];
            }

            return [];
          }
        )
      } as unknown as Room;
      const selectedBuildTask = { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> } as const;
      const build = jest.fn();
      const harvest = jest.fn().mockReturnValue(0);
      const creep = {
        name: 'RetainedBuilder',
        memory: {
          role: 'worker',
          colony: 'E29N57',
          task: selectedBuildTask
        },
        getActiveBodyparts: jest.fn((part?: BodyPartConstant) => (part === 'work' ? 1 : 0)),
        pos: { x: 18, y: 20, roomName: 'E29N57' } as RoomPosition,
        store: {
          getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY ? carriedEnergy : 0
          ),
          getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY ? freeCapacity : 0
          ),
          getCapacity: jest.fn((resource?: ResourceConstant) =>
            resource === RESOURCE_ENERGY ? carriedEnergy + freeCapacity : 0
          )
        },
        room,
        build,
        harvest,
        moveTo: jest.fn()
      } as unknown as Creep;
      roomCreeps.push(creep);
      const selectWorkerTask = jest.spyOn(workerTasks, 'selectWorkerTask').mockReturnValue(selectedBuildTask);
      const selectWorkerEnergyCriticalTask = jest
        .spyOn(workerTaskPolicy, 'selectWorkerEnergyCriticalTask')
        .mockReturnValue(null);
      (globalThis as unknown as { Game: Partial<Game> }).Game = {
        creeps: { RetainedBuilder: creep },
        rooms: { E29N57: room },
        time: 2_124_541,
        getObjectById: jest.fn((id: string) => {
          if (id === 'road-site1') {
            return site;
          }

          return id === 'source1' ? source : null;
        })
      };

      try {
        runWorker(creep);

        expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
        expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
          currentTask: 'build',
          currentTargetId: 'road-site1',
          baseSelectedTask: 'build',
          baseSelectedTargetId: 'road-site1',
          selectedTask: 'harvest',
          selectedTargetId: 'source1',
          assignedTask: 'harvest',
          assignedTargetId: 'source1'
        });
        expect(harvest).toHaveBeenCalledWith(source);
        expect(build).not.toHaveBeenCalled();
      } finally {
        selectWorkerTask.mockRestore();
        selectWorkerEnergyCriticalTask.mockRestore();
      }
    }
  );

  it('preempts an E29N55 tower refill transfer for construction backlog while CPU shedding', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 935,
      progressTotal: 5_000,
      pos: { x: 22, y: 21, roomName: 'E29N55' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 300 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      }
    } as unknown as StructureSpawn;
    const tower = {
      id: 'tower1',
      structureType: 'tower',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 750 : 0))
      }
    } as unknown as StructureTower;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, tower] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, tower];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'LoadedBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'transfer', targetId: 'tower1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedBuilder: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N55: room },
      time: 1_815_736,
      cpu: {
        getUsed: jest.fn().mockReturnValue(101),
        limit: 70,
        bucket: 1_844,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'tower1') {
          return tower;
        }

        return id === 'spawn1' ? spawn : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'road-site1' });
    expect(creep.memory.workerDispatchDiagnostic).toMatchObject({
      currentTask: 'transfer',
      baseSelectedTask: 'build',
      selectedTask: 'build',
      assignedTask: 'build'
    });
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('keeps tower refill ahead of construction backlog while hostiles are visible', () => {
    const site = {
      id: 'road-site1',
      my: true,
      structureType: 'road',
      progress: 935,
      progressTotal: 5_000
    } as ConstructionSite;
    const tower = {
      id: 'tower1',
      structureType: 'tower',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 250 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 750 : 0))
      }
    } as unknown as StructureTower;
    const hostile = { id: 'hostile1' } as Creep;
    const controller = {
      id: 'controller1',
      my: true,
      level: 6,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1_000
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N55',
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
            const structures = [tower] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_HOSTILE_CREEPS) {
            return [hostile];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'LoadedWorker',
      memory: {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'transfer', targetId: 'tower1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0))
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const recoveryWorker = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'E29N55' },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 0 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, recoveryWorker);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LoadedWorker: creep, RecoveryWorker: recoveryWorker },
      rooms: { E29N55: room },
      time: 1_815_737,
      cpu: {
        getUsed: jest.fn().mockReturnValue(101),
        limit: 70,
        bucket: 1_844,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        return id === 'tower1' ? tower : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'tower1' });
    expect(transfer).toHaveBeenCalledWith(tower, RESOURCE_ENERGY);
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps E29N57 source-container construction ahead of spawn reservation refill during low-bucket shedding', () => {
    const source = {
      id: 'source1',
      pos: { x: 20, y: 20, roomName: 'E29N57' } as RoomPosition
    } as Source;
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 500,
      progressTotal: 5_000,
      pos: { x: 20, y: 21, roomName: 'E29N57' } as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_217 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_500 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 909,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn().mockReturnValue(0);
    const transfer = jest.fn();
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(36),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const reserveWorker = {
      name: 'ReserveWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, reserveWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            E29N57: {
              bodyCost: 800,
              creepName: 'worker-E29N57-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, ReserveWorker: reserveWorker },
      rooms: { E29N57: room },
      time: 124,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 948,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'stored-container1' ? storedContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.memory.workerDispatchDiagnostic).toBeUndefined();
    expect(build).toHaveBeenCalledWith(site);
    expect(transfer).not.toHaveBeenCalled();
  });

  it('refills an empty E29N57 source-container builder during low-bucket shedding', () => {
    const source = {
      id: 'source1',
      pos: { x: 20, y: 20, roomName: 'E29N57' } as RoomPosition
    } as Source;
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 500,
      progressTotal: 5_000,
      pos: {
        x: 20,
        y: 21,
        roomName: 'E29N57',
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'stored-container1' ? 1 : 99))
      } as unknown as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(300),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      pos: { x: 20, y: 22, roomName: 'E29N57' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_217 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_500 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 909,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const transfer = jest.fn();
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'Builder',
      memory: { role: 'worker', colony: 'E29N57' },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'stored-container1' ? 1 : 99)) },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      build,
      transfer,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    const reserveWorker = {
      name: 'ReserveWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, reserveWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            E29N57: {
              bodyCost: 800,
              creepName: 'worker-E29N57-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep, ReserveWorker: reserveWorker },
      rooms: { E29N57: room },
      time: 124,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 948,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'stored-container1' ? storedContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'stored-container1',
      constructionSiteId: 'site1'
    });
    expect(withdraw).toHaveBeenCalledWith(storedContainer, RESOURCE_ENERGY, 50);
    expect(build).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it('preempts an empty retained build assignment for construction energy acquisition', () => {
    const source = {
      id: 'source1',
      pos: { x: 20, y: 20, roomName: 'E29N57' } as RoomPosition
    } as Source;
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 500,
      progressTotal: 5_000,
      pos: {
        x: 20,
        y: 21,
        roomName: 'E29N57',
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'stored-container1' ? 1 : 99))
      } as unknown as RoomPosition
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(300),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const storedContainer = {
      id: 'stored-container1',
      structureType: 'container',
      pos: { x: 20, y: 22, roomName: 'E29N57' } as RoomPosition,
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 2_217 : 0)),
        getCapacity: jest.fn((resource?: ResourceConstant) =>
          resource === undefined || resource === RESOURCE_ENERGY ? 2_500 : 0
        )
      }
    } as unknown as StructureContainer;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 909,
      energyCapacityAvailable: 1_800,
      controller,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storedContainer];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const withdraw = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'EmptyBuilder',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> }
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'stored-container1' ? 1 : 99)) },
      store: {
        [RESOURCE_ENERGY]: 0,
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 100 : 0))
      },
      room,
      build,
      withdraw,
      moveTo: jest.fn()
    } as unknown as Creep;
    const reserveWorker = {
      name: 'ReserveWorker',
      memory: { role: 'worker', colony: 'E29N57' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, reserveWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            E29N57: {
              bodyCost: 800,
              creepName: 'worker-E29N57-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { EmptyBuilder: creep, ReserveWorker: reserveWorker },
      rooms: { E29N57: room },
      time: 125,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 948,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'stored-container1' ? storedContainer : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({
      type: 'withdraw',
      targetId: 'stored-container1',
      constructionSiteId: 'site1'
    });
    expect(withdraw).toHaveBeenCalledWith(storedContainer, RESOURCE_ENERGY, 100);
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps spawn reservation refill protected when the room has only one worker', () => {
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 0,
      progressTotal: 5_000
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(1_673),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'OnlyWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            W1N1: {
              bodyCost: 800,
              creepName: 'worker-W1N1-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'W1N1',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { OnlyWorker: creep },
      rooms: { W1N1: room },
      time: 124,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps an assigned spawn reservation transfer when E29N57 has only one productive worker', () => {
    const site = {
      id: 'road-site1',
      structureType: 'road',
      progress: 935,
      progressTotal: 5_000
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(1_332),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'E29N57',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'OnlyWorker',
      memory: {
        role: 'worker',
        colony: 'E29N57',
        task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(68),
        getFreeCapacity: jest.fn().mockReturnValue(32)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    roomCreeps.push(creep);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 1_676_999,
          rooms: {
            E29N57: {
              bodyCost: 1_800,
              creepName: 'worker-E29N57-next',
              reservedAt: 1_676_999,
              reservedEnergy: 1_800,
              role: 'worker',
              roomName: 'E29N57',
              updatedAt: 1_676_999
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { OnlyWorker: creep },
      rooms: { E29N57: room },
      time: 1_677_000,
      getObjectById: jest.fn((id: string) => {
        if (id === 'road-site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(build).not.toHaveBeenCalled();
  });

  it('does not count outbound spawn-support workers as spawn reservation recovery coverage', () => {
    const site = {
      id: 'site1',
      structureType: 'container',
      progress: 0,
      progressTotal: 5_000
    } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: null,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(250),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      }
    } as unknown as StructureSpawn;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(1_673),
        getFreeCapacity: jest.fn().mockReturnValue(10_000)
      }
    } as unknown as StructureStorage;
    const controller = {
      id: 'controller1',
      my: true,
      level: 5,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const roomCreeps: Creep[] = [];
    const room = {
      name: 'W1N1',
      energyAvailable: 650,
      energyCapacityAvailable: 1_800,
      controller,
      storage,
      find: jest.fn(
        (type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn, storage] as unknown as AnyOwnedStructure[];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_STRUCTURES) {
            return [spawn, storage];
          }

          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomCreeps.filter(options.filter) : roomCreeps;
          }

          if (type === FIND_CONSTRUCTION_SITES) {
            return [site];
          }

          return [];
        }
      )
    } as unknown as Room;
    const build = jest.fn();
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      name: 'LocalBuilder',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build,
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    const outboundSupportWorker = {
      name: 'OutboundSupport',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        spawnSupport: { originRoom: 'W1N1', targetRoom: 'W2N1' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    roomCreeps.push(creep, outboundSupportWorker);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 123,
          rooms: {
            W1N1: {
              bodyCost: 800,
              creepName: 'worker-W1N1-124',
              reservedAt: 123,
              reservedEnergy: 800,
              role: 'worker',
              roomName: 'W1N1',
              updatedAt: 123
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { LocalBuilder: creep, OutboundSupport: outboundSupportWorker },
      rooms: { W1N1: room },
      time: 124,
      getObjectById: jest.fn((id: string) => {
        if (id === 'site1') {
          return site;
        }

        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'storage1' ? storage : null;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(build).not.toHaveBeenCalled();
  });

  it('preempts construction for an assigned visible reserve target before spawn refill pressure', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const controller = { id: 'controller2', my: false } as StructureController;
    const site = { id: 'site1' } as ConstructionSite;
    const creep = {
      owner: { username: 'me' },
      memory: {
        role: 'worker',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' },
        task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        name: 'W2N1',
        controller,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [spawn];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            if (type === FIND_CONSTRUCTION_SITES) {
              return [site];
            }

            return [];
          }
        )
      },
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(site)
    };

    runWorker(creep);

    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.memory.task).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps construction work when spawn and extension energy is full', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const fullExtension = {
      id: 'extension1',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureExtension;
    const build = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [fullSpawn, fullExtension];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_CONSTRUCTION_SITES ? [site] : [];
          }
        )
      },
      build,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(site)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(Game.getObjectById).toHaveBeenCalledWith('site1');
    expect(build).toHaveBeenCalledWith(site);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('executes capacity-enabling construction when the room buffer threshold exceeds capacity', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 4,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const build = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'build', targetId: 'extension-site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        energyAvailable: 300,
        energyCapacityAvailable: 300,
        find: jest.fn((type: number) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
      },
      build,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(site)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(build).toHaveBeenCalledWith(site);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('pauses active construction when this worker must reserve energy for near-term spawn refill', () => {
    const busyFullSpawn = {
      id: 'spawn-busy',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const build = jest.fn();
    const moveTo = jest.fn();
    const room = {
      name: 'W1N1',
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [busyFullSpawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === FIND_CONSTRUCTION_SITES ? [site] : [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Builder',
      memory: {
        role: 'worker',
        task: { type: 'build', targetId: 'road-site1' as Id<ConstructionSite> }
      },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room,
      build,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(site);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Builder: creep },
      getObjectById,
      time: 123
    };

    runWorker(creep);

    const spawnExtensionLookups = (room.find as jest.Mock).mock.calls.filter(
      ([type]) => type === FIND_MY_STRUCTURES
    );
    expect(creep.memory.task).toBeUndefined();
    expect(spawnExtensionLookups.some(([, options]) => typeof options?.filter === 'function')).toBe(true);
    expect(getObjectById).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('keeps controller upgrade work when spawn and extension energy is full', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const fullExtension = {
      id: 'extension1',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureExtension;
    const upgradeController = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [fullSpawn, fullExtension];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return [];
          }
        )
      },
      upgradeController,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(Game.getObjectById).toHaveBeenCalledWith('controller1');
    expect(upgradeController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('clears missing build targets and reassigns without building the stale target', () => {
    const site = { id: 'site2' } as ConstructionSite;
    const build = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'build', targetId: 'missing' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn((type) => (type === 2 ? [site] : [])) },
      build,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('missing');
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site2' });
    expect(build).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('reassigns stale upgrade tasks when selection chooses a different controller', () => {
    const controller = { id: 'controller2', my: true } as StructureController;
    const upgradeController = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'upgrade', targetId: 'missing' as Id<StructureController> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller, find: jest.fn().mockReturnValue([]) },
      upgradeController,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(null);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller2');
    expect(creep.memory.task).toEqual({ type: 'upgrade', targetId: 'controller2' });
    expect(upgradeController).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('keeps local construction before claimed territory upgrade support', () => {
    const controller = { id: 'controller2', my: true, level: 1 } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 200 }]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1', task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(site);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('site1');
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.build).toHaveBeenCalledWith(site);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps non-critical construction before controller pressure once spawn recovery is safe', () => {
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const controller = { id: 'controller1', my: true, level: 3 } as StructureController;
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [fullSpawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === FIND_CONSTRUCTION_SITES ? [site] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'build', targetId: 'wall-site1' as Id<ConstructionSite> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(site);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('wall-site1');
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'wall-site1' });
    expect(creep.build).toHaveBeenCalledWith(site);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts controller upgrade for nearby non-critical construction under controller pressure', () => {
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const controller = { id: 'controller1', my: true, level: 3 } as StructureController;
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'wall-site1': 2,
        controller1: 7
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [fullSpawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === FIND_CONSTRUCTION_SITES ? [site] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      pos: { getRangeTo },
      room,
      build: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'wall-site1' ? site : controller))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'wall-site1' });
    expect(creep.build).toHaveBeenCalledWith(site);
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps spawn recovery transfer ahead of controller pressure preemption', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const controller = { id: 'controller1', my: true, level: 3 } as StructureController;
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === FIND_CONSTRUCTION_SITES ? [site] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'build', targetId: 'tower-site1' as Id<ConstructionSite> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      build: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(site);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).not.toHaveBeenCalled();
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.build).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps active tower refill ahead of normal controller pressure upgrades', () => {
    const tower = {
      id: 'tower1',
      structureType: 'tower',
      store: {
        getFreeCapacity: jest.fn().mockReturnValue(200),
        getUsedCapacity: jest.fn().mockReturnValue(600)
      }
    } as unknown as StructureTower;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureTower) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [tower];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'transfer', targetId: 'tower1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      transfer: jest.fn().mockReturnValue(0),
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      getObjectById: jest.fn((id: string) => (id === 'tower1' ? tower : controller))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'tower1' });
    expect(creep.transfer).toHaveBeenCalledWith(tower, 'energy');
    expect(creep.upgradeController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('executes a normal-threshold reservation task for a one-CLAIM worker', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 201 }]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn((type: number) => (type === FIND_CONSTRUCTION_SITES ? [site] : []))
    } as unknown as Room;
    const creep = {
      owner: { username: 'me' },
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'reserve', targetId: 'controller2' as Id<StructureController> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      reserveController: jest.fn(),
      signController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller2');
    expect(creep.memory.task).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('executes pressure reservation tasks with attackController against foreign reservations', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'active',
            updatedAt: 202,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const creep = {
      owner: { username: 'me' },
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'reserve', targetId: 'controller2' as Id<StructureController> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(5),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      attackController: jest.fn().mockReturnValue(0),
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller2');
    expect(creep.memory.task).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(creep.attackController).toHaveBeenCalledWith(controller);
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('executes pressure claim tasks with attackController against foreign reservations', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 203 }]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    const creep = {
      owner: { username: 'me' },
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'claim', targetId: 'controller2' as Id<StructureController> }
      },
      getActiveBodyparts: jest.fn().mockReturnValue(5),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      attackController: jest.fn().mockReturnValue(0),
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller2');
    expect(creep.memory.task).toEqual({ type: 'claim', targetId: 'controller2' });
    expect(creep.attackController).toHaveBeenCalledWith(controller);
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('clears completed repair targets and reassigns without repairing the stale target', () => {
    const fullRoad = { id: 'road-full', structureType: 'road', hits: 5_000, hitsMax: 5_000 } as StructureRoad;
    const damagedRoad = { id: 'road-damaged', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const repair = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'repair', targetId: 'road-full' as Id<Structure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller: { id: 'controller1', my: true } as StructureController,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [fullRoad, damagedRoad] : []))
      },
      repair,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(fullRoad);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('road-full');
    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'road-damaged' });
    expect(repair).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('clears owned rampart repair targets at the idle ceiling and reassigns without repairing them', () => {
    const rampart = {
      id: 'rampart-ceiling',
      structureType: 'rampart',
      hits: IDLE_RAMPART_REPAIR_HITS_CEILING,
      hitsMax: 300_000_000,
      my: true
    } as StructureRampart;
    const damagedRoad = { id: 'road-damaged', structureType: 'road', hits: 1_000, hitsMax: 5_000 } as StructureRoad;
    const repair = jest.fn();
    const moveTo = jest.fn();
    const creep = {
      memory: { task: { type: 'repair', targetId: 'rampart-ceiling' as Id<Structure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        controller: { id: 'controller1', my: true } as StructureController,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart, damagedRoad] : []))
      },
      repair,
      moveTo
    } as unknown as Creep;
    const getObjectById = jest.fn().mockReturnValue(rampart);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById
    };

    runWorker(creep);

    expect(getObjectById).toHaveBeenCalledWith('rampart-ceiling');
    expect(creep.memory.task).toEqual({ type: 'repair', targetId: 'road-damaged' });
    expect(repair).not.toHaveBeenCalled();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('clears invalid task targets', () => {
    const creep = {
      memory: { task: { type: 'build', targetId: 'missing' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn().mockReturnValue([]) },
      build: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(null)
    };

    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
  });

  it.each([
    { type: 'harvest', targetId: 'missing-source' as Id<Source> },
    { type: 'pickup', targetId: 'missing-drop' as Id<Resource<ResourceConstant>> },
    { type: 'transfer', targetId: 'missing-transfer' as Id<AnyStoreStructure> },
    { type: 'build', targetId: 'missing-site' as Id<ConstructionSite> },
    { type: 'repair', targetId: 'missing-repair' as Id<Structure> },
    { type: 'upgrade', targetId: 'missing-controller' as Id<StructureController> }
  ] satisfies CreepTaskMemory[])(
    'clears stale $type task in a controllerless room without executing it',
    (task) => {
      const creep = {
        memory: { task },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(task.type === 'harvest' ? 0 : 50),
          getFreeCapacity: jest.fn().mockReturnValue(50)
        },
        room: { find: jest.fn().mockReturnValue([]) },
        harvest: jest.fn(),
        pickup: jest.fn(),
        build: jest.fn(),
        repair: jest.fn(),
        transfer: jest.fn(),
        upgradeController: jest.fn(),
        moveTo: jest.fn()
      } as unknown as Creep;
      const getObjectById = jest.fn().mockReturnValue(null);
      (globalThis as unknown as { Game: Partial<Game> }).Game = { getObjectById };

      expect(() => runWorker(creep)).not.toThrow();

      expect(getObjectById).toHaveBeenCalledWith(task.targetId);
      expect(creep.memory.task).toBeUndefined();
      expect(creep.harvest).not.toHaveBeenCalled();
      expect(creep.pickup).not.toHaveBeenCalled();
      expect(creep.build).not.toHaveBeenCalled();
      expect(creep.repair).not.toHaveBeenCalled();
      expect(creep.transfer).not.toHaveBeenCalled();
      expect(creep.upgradeController).not.toHaveBeenCalled();
      expect(creep.moveTo).not.toHaveBeenCalled();
    }
  );

  it('switches from harvest when creep is full', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn((type) => (type === 3 ? [spawn] : [])) }
    } as unknown as Creep;

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('preempts an empty harvest trip for faster local spawn recovery energy', () => {
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 5 });
    const droppedEnergy = withRangeTo(
      { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-near': 1,
        source1: 2,
        spawn1: 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [spawn];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            if (type === FIND_DROPPED_RESOURCES) {
              return [droppedEnergy];
            }

            if (type === FIND_STRUCTURES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
              return [];
            }

            return type === FIND_SOURCES ? [source] : [];
          }
        )
      },
      harvest: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(source)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(Game.getObjectById).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('spends partially harvested energy on primary refill before continuing harvest', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const creep = {
      memory: { task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [spawn];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_SOURCES ? [source] : [];
          }
        )
      },
      harvest: jest.fn(),
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'spawn1' ? spawn : source))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts a low-load harvest return for nearby energy when refill is not urgent', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const droppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-near': 1,
        source1: 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [spawn];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            if (type === FIND_DROPPED_RESOURCES) {
              return [droppedEnergy];
            }

            if (type === FIND_SOURCES) {
              return [source];
            }

            return [];
          }
        )
      },
      harvest: jest.fn(),
      pickup: jest.fn().mockReturnValue(0),
      transfer: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      time: 777,
      getObjectById: jest.fn((id: string) => (id === 'drop-near' ? droppedEnergy : source))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 777,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'pickup',
      targetId: 'drop-near',
      energy: 50,
      range: 1
    });
    expect(creep.pickup).toHaveBeenCalledWith(droppedEnergy);
    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('uses carried energy on a nearby spawn reservation refill before low-load acquisition', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const droppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 51 : 0)),
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 249 : 0))
      }
    } as unknown as StructureSpawn;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-near': 1,
        source1: 3,
        spawn1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const room = {
      name: 'W1N1',
      energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
      energyCapacityAvailable: 300,
      memory: { spawnEnergyReservation: { transferThreshold: 250 } },
      find: jest.fn(
        (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_DROPPED_RESOURCES) {
            return [droppedEnergy];
          }

          if (type === FIND_SOURCES) {
            return [source];
          }

          return [];
        }
      )
    } as unknown as Room;
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      store: {
        getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 10 : 0)),
        getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 40 : 0))
      },
      pos: { getRangeTo },
      room,
      harvest: jest.fn(),
      pickup: jest.fn(),
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyReservation: {
          updatedAt: 776,
          rooms: {
            W1N1: {
              bodyCost: 650,
              creepName: 'worker-W1N1-778',
              reservedAt: 776,
              reservedEnergy: 650,
              role: 'worker',
              roomName: 'W1N1',
              updatedAt: 776
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      rooms: { W1N1: room },
      time: 778,
      getObjectById: jest.fn((id: string) => {
        if (id === 'spawn1') {
          return spawn;
        }

        return id === 'drop-near' ? droppedEnergy : source;
      })
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.pickup).not.toHaveBeenCalled();
    expect(creep.harvest).not.toHaveBeenCalled();
  });

  it('preempts a low-yield active pickup for a higher-yield stored source when spawn energy is stable', () => {
    const currentDrop = { id: 'drop-low', resourceType: 'energy', amount: 5 } as Resource<ResourceConstant>;
    const container = {
      id: 'container-rich',
      structureType: 'container',
      store: { getUsedCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-rich': 3,
        'drop-low': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'pickup', targetId: 'drop-low' as Id<Resource<ResourceConstant>> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(5),
        getFreeCapacity: jest.fn().mockReturnValue(45)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: jest.fn((type: number) => {
          if (type === FIND_DROPPED_RESOURCES) {
            return [currentDrop];
          }

          if (type === FIND_STRUCTURES) {
            return [container];
          }

          return [];
        })
      },
      pickup: jest.fn(),
      withdraw: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      time: 779,
      getObjectById: jest.fn((id: string) => (id === 'container-rich' ? container : currentDrop))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'withdraw', targetId: 'container-rich' });
    expect(creep.withdraw).toHaveBeenCalledWith(container, RESOURCE_ENERGY, 45);
    expect(creep.pickup).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps a low-yield active pickup when spawn energy is scarce', () => {
    const currentDrop = { id: 'drop-low', resourceType: 'energy', amount: 5 } as Resource<ResourceConstant>;
    const container = {
      id: 'container-rich',
      structureType: 'container',
      store: { getUsedCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureContainer;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-rich': 3,
        'drop-low': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'pickup', targetId: 'drop-low' as Id<Resource<ResourceConstant>> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(5),
        getFreeCapacity: jest.fn().mockReturnValue(45)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        find: jest.fn((type: number) => {
          if (type === FIND_DROPPED_RESOURCES) {
            return [currentDrop];
          }

          if (type === FIND_STRUCTURES) {
            return [container];
          }

          return [];
        })
      },
      pickup: jest.fn().mockReturnValue(0),
      withdraw: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      time: 780,
      getObjectById: jest.fn((id: string) => (id === 'container-rich' ? container : currentDrop))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'pickup', targetId: 'drop-low' });
    expect(creep.pickup).toHaveBeenCalledWith(currentDrop);
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts a stale non-urgent refill task when a low-load worker can keep harvesting', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: 6,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [spawn];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            if (
              type === FIND_DROPPED_RESOURCES ||
              type === FIND_STRUCTURES ||
              type === FIND_HOSTILE_CREEPS ||
              type === FIND_HOSTILE_STRUCTURES
            ) {
              return [];
            }

            return type === FIND_SOURCES ? [source] : [];
          }
        )
      },
      harvest: jest.fn().mockReturnValue(0),
      transfer: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      time: 778,
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : spawn))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 778,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'harvest',
      targetId: 'source1',
      energy: 300,
      range: 6
    });
    expect(creep.harvest).toHaveBeenCalledWith(source);
    expect(creep.transfer).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('spends partially picked-up energy on extension construction before lower-value tower refill', () => {
    const droppedEnergy = { id: 'drop1', resourceType: 'energy', amount: 100 } as Resource<ResourceConstant>;
    const extensionSite = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const lowTower = {
      id: 'tower-low',
      structureType: 'tower',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(100),
        getFreeCapacity: jest.fn().mockReturnValue(500)
      }
    } as unknown as StructureTower;
    const creep = {
      memory: { task: { type: 'pickup', targetId: 'drop1' as Id<Resource<ResourceConstant>> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(25),
        getFreeCapacity: jest.fn().mockReturnValue(25)
      },
      room: {
        controller: {
          id: 'controller1',
          my: true,
          level: 2,
          ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
        } as StructureController,
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureTower) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              const structures = [lowTower];
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            if (type === FIND_CONSTRUCTION_SITES) {
              return [extensionSite];
            }

            return type === FIND_DROPPED_RESOURCES ? [droppedEnergy] : [];
          }
        )
      },
      pickup: jest.fn(),
      build: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'extension-site1' ? extensionSite : droppedEnergy))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'extension-site1' });
    expect(creep.build).toHaveBeenCalledWith(extensionSite);
    expect(creep.pickup).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: 'transfer',
      task: { type: 'transfer', targetId: 'stale-transfer' as Id<AnyStoreStructure> },
      staleTarget: { id: 'stale-transfer', store: { getFreeCapacity: jest.fn().mockReturnValue(50) } },
      actionMockName: 'transfer'
    },
    {
      action: 'build',
      task: { type: 'build', targetId: 'stale-site' as Id<ConstructionSite> },
      staleTarget: { id: 'stale-site' },
      actionMockName: 'build'
    },
    {
      action: 'repair',
      task: { type: 'repair', targetId: 'stale-road' as Id<Structure> },
      staleTarget: { id: 'stale-road', hits: 1_000, hitsMax: 5_000 },
      actionMockName: 'repair'
    },
    {
      action: 'upgrade',
      task: { type: 'upgrade', targetId: 'stale-controller' as Id<StructureController> },
      staleTarget: { id: 'stale-controller', my: true },
      actionMockName: 'upgradeController'
    }
  ] satisfies Array<{
    action: string;
    task: CreepTaskMemory;
    staleTarget: unknown;
    actionMockName: 'transfer' | 'build' | 'repair' | 'upgradeController';
  }>)('switches from stale $action when creep is empty', ({ task, staleTarget, actionMockName }) => {
    const source = { id: 'source1' } as Source;
    const harvest = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { task },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : [])) },
      harvest,
      transfer: jest.fn(),
      build: jest.fn(),
      repair: jest.fn(),
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : staleTarget)) as unknown as Game['getObjectById']
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(harvest).toHaveBeenCalledWith(source);
    expect((creep[actionMockName] as jest.Mock)).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalledWith(staleTarget, expect.anything());
  });

  it('transfers energy to transfer targets', () => {
    const spawn = { id: 'spawn1' } as StructureSpawn;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('keeps primary transfer work stable instead of chasing a closer fillable sink', () => {
    const farExtension = {
      id: 'extension-far',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureExtension;
    const nearSpawn = {
      id: 'spawn-near',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureSpawn;
    const getRangeTo = jest.fn((target: StructureExtension | StructureSpawn) => {
      const ranges: Record<string, number> = {
        'extension-far': 8,
        'spawn-near': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'extension-far' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureExtension | StructureSpawn) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            const structures = [farExtension, nearSpawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      },
      transfer: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'spawn-near' ? nearSpawn : farExtension))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'extension-far' });
    expect(creep.transfer).toHaveBeenCalledWith(farExtension, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts active extension refill for a critical spawn refill', () => {
    const extension = {
      id: 'extension-current',
      structureType: 'extension',
      store: {
        getFreeCapacity: jest.fn().mockReturnValue(50),
        getUsedCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as StructureExtension;
    const criticalSpawn = {
      id: 'spawn-critical',
      structureType: 'spawn',
      store: {
        getFreeCapacity: jest.fn().mockReturnValue(101),
        getUsedCapacity: jest.fn().mockReturnValue(CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1)
      }
    } as unknown as StructureSpawn;
    const getRangeTo = jest.fn((target: StructureExtension | StructureSpawn) => {
      const ranges: Record<string, number> = {
        'extension-current': 1,
        'spawn-critical': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'extension-current' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureExtension | StructureSpawn) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            const structures = [extension, criticalSpawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      },
      transfer,
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker: creep },
      time: 779,
      getObjectById: jest.fn((id: string) => (id === 'spawn-critical' ? criticalSpawn : extension))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn-critical' });
    expect(creep.memory.spawnCriticalRefill).toEqual({
      type: 'spawnCriticalRefill',
      tick: 779,
      targetId: 'spawn-critical',
      carriedEnergy: 50,
      spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      freeCapacity: 101,
      threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
    });
    expect(transfer).toHaveBeenCalledWith(criticalSpawn, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts active upgrading for harvest while spawn-critical hysteresis is active', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 50,
      controller,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
    } as unknown as Room;
    const harvest = jest.fn().mockReturnValue(ERR_NOT_IN_RANGE);
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> },
        workerEnergyCriticalPolicy: {
          type: 'workerEnergyCriticalPolicy',
          schemaVersion: 1,
          active: true,
          reason: 'spawn',
          enteredAt: 700,
          updatedAt: 700,
          spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
          spawnEnterThreshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
          spawnExitThreshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 100
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(25),
        getFreeCapacity: jest.fn().mockReturnValue(25)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room,
      harvest,
      moveTo: jest.fn(),
      upgradeController: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 701,
      creeps: { Worker: creep },
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : controller))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerEnergyCriticalPolicy).toMatchObject({
      active: true,
      reason: 'spawn',
      spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 50
    });
    expect(harvest).toHaveBeenCalledWith(source);
    expect(creep.moveTo).toHaveBeenCalledWith(source, { range: 1 });
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it('routes a full worker to storage instead of upgrading when storage energy is critical', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const storage = {
      id: 'storage1',
      structureType: 'storage',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(499),
        getFreeCapacity: jest.fn().mockReturnValue(1_000)
      }
    } as unknown as StructureStorage;
    const room = {
      name: 'W1N1',
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD + 100,
      controller,
      storage,
      find: jest.fn((type: number) => (type === FIND_STRUCTURES ? [storage] : []))
    } as unknown as Room;
    const transfer = jest.fn().mockReturnValue(0);
    const creep = {
      memory: {
        role: 'worker',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      transfer,
      upgradeController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 702,
      creeps: { Worker: creep },
      getObjectById: jest.fn((id: string) => (id === 'storage1' ? storage : controller))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'storage1' });
    expect(creep.memory.workerEnergyCriticalPolicy).toMatchObject({
      active: true,
      reason: 'storage',
      storageEnergy: 499,
      storageEnterThreshold: 500,
      storageExitThreshold: 750
    });
    expect(transfer).toHaveBeenCalledWith(storage, 'energy');
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it('preempts an over-reserved primary refill target for uncovered spawn-extension demand', () => {
    const coveredSpawn = {
      id: 'spawn-covered',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(20) }
    } as unknown as StructureSpawn;
    const openExtension = {
      id: 'extension-open',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureExtension;
    const roomLocalCreeps: Creep[] = [];
    const room = {
      name: 'W1N1',
      find: jest.fn(
        (
          type: number,
          options?: { filter?: (object: StructureSpawn | StructureExtension | Creep) => boolean }
        ) => {
          if (type === FIND_MY_CREEPS) {
            return options?.filter ? roomLocalCreeps.filter(options.filter) : roomLocalCreeps;
          }

          if (type === FIND_MY_STRUCTURES) {
            const structures = [coveredSpawn, openExtension];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return [];
        }
      )
    } as unknown as Room;
    const assignedCarrier = {
      name: 'AssignedCarrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-covered' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Carrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-covered' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    roomLocalCreeps.push(assignedCarrier, creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn((id: string) => (id === 'extension-open' ? openExtension : coveredSpawn))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'extension-open' });
    expect(room.find).toHaveBeenCalledWith(FIND_MY_CREEPS);
    expect(creep.transfer).toHaveBeenCalledWith(openExtension, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts tower transfer work for a primary fillable energy sink and executes it immediately', () => {
    const extension = {
      id: 'extension1',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureExtension;
    const tower = {
      id: 'tower1',
      structureType: 'tower',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureTower;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'tower1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureExtension | StructureTower) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            const structures = [extension, tower];
            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      },
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'tower1' ? tower : extension))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'extension1' });
    expect(creep.transfer).toHaveBeenCalledWith(extension, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('preempts retained tower transfer work for emergency spawn refill under critical CPU', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const tower = {
      id: 'tower1',
      structureType: 'tower',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureTower;
    const creep = {
      name: 'Worker1',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'transfer', targetId: 'tower1' as Id<AnyStoreStructure> }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        name: 'W1N1',
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureSpawn | StructureTower) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            const structures = [spawn, tower];
            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      },
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 780,
      cpu: {
        getUsed: jest.fn().mockReturnValue(21),
        limit: 70,
        bucket: 43,
        tickLimit: 500
      } as unknown as CPU,
      getObjectById: jest.fn((id: string) => (id === 'tower1' ? tower : spawn))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.transfer).not.toHaveBeenCalledWith(tower, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('reselects and executes a same-priority transfer when the current sink is full', () => {
    const fullExtension = {
      id: 'extension-full',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureExtension;
    const fillableExtension = {
      id: 'extension-fillable',
      structureType: 'extension',
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) }
    } as unknown as StructureExtension;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'extension-full' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: StructureExtension) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            const structures = [fullExtension, fillableExtension];
            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      },
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'extension-fillable' ? fillableExtension : fullExtension))
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'extension-fillable' });
    expect(creep.transfer).toHaveBeenCalledWith(fillableExtension, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('reselects and executes a productive worker task when transfer returns ERR_FULL', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getFreeCapacity: jest
          .fn()
          .mockReturnValueOnce(1)
          .mockReturnValueOnce(1)
          .mockReturnValueOnce(1)
          .mockReturnValue(0)
      }
    } as unknown as StructureSpawn;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === 3) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      },
      transfer: jest.fn().mockReturnValue(ERR_FULL),
      moveTo: jest.fn(),
      build: jest.fn().mockReturnValue(0)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn((id: string) => (id === 'site1' ? site : spawn))
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
    expect(creep.memory.task).toEqual({ type: 'build', targetId: 'site1' });
    expect(creep.build).toHaveBeenCalledWith(site);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('continues normal task execution when a real task is available', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureSpawn;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_MY_STRUCTURES) {
          return [spawn];
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room,
      transfer: jest.fn().mockReturnValue(0)
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      rooms: { W1N1: room },
      getObjectById: jest.fn().mockReturnValue(spawn)
    };

    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
  });

  it('withdraws from a link when assigned a link energy task', () => {
    const link = {
      id: 'link1',
      structureType: 'link',
      store: { getUsedCapacity: jest.fn().mockReturnValue(200) }
    } as unknown as StructureLink;
    const creep = {
      memory: { task: { type: 'withdraw', targetId: 'link1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      withdraw: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(link)
    };

    runWorker(creep);

    expect(creep.withdraw).toHaveBeenCalledWith(link, 'energy', 50);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('transfers into a link when assigned a link energy task', () => {
    const link = {
      id: 'link1',
      structureType: 'link',
      store: { getFreeCapacity: jest.fn().mockReturnValue(400) }
    } as unknown as StructureLink;
    const creep = {
      memory: { task: { type: 'transfer', targetId: 'link1' as Id<AnyStoreStructure> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: { find: jest.fn().mockReturnValue([]) },
      transfer: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(link)
    };

    runWorker(creep);

    expect(creep.transfer).toHaveBeenCalledWith(link, 'energy');
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('falls back to pre-harvest when standby idle exceeds timeout', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const siblingWorker = {
      memory: { role: 'worker', task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { name: 'W1N1' }
    } as unknown as Creep;
    const room = {
      name: 'W1N1',
      controller: { id: 'controller1', my: true, level: 3 } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        return [];
      })
    } as unknown as Room;
    (siblingWorker as Creep).room = room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(ERR_FULL)
    } as unknown as Creep;
    const getObjectById = jest.fn((id: string) => (id === 'source1' ? source : null));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      rooms: { W1N1: room },
      creeps: { siblingWorker },
      getObjectById
    };

    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 11;
    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 12;
    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 13;
    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 14;
    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 15;
    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 16;
    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 17;
    runWorker(creep);
    expect(creep.memory.task).toBeUndefined();

    (Game as Partial<Game>).time = 18;
    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.harvest).toHaveBeenCalledWith(source);
  });

  it('reverts to real work when it becomes available during idle pre-harvest', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) }
    } as unknown as StructureSpawn;
    const siblingWorker = {
      memory: { role: 'worker', task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { name: 'W1N1' }
    } as unknown as Creep;
    let hasSpawn = false;
    let usedEnergy = 0;
    let freeEnergy = 50;
    const room = {
      name: 'W1N1',
      controller: { id: 'controller1', my: true, level: 3 } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        if (type === FIND_MY_STRUCTURES) {
          return hasSpawn ? [spawn] : [];
        }

        return [];
      })
    } as unknown as Room;
    (siblingWorker as Creep).room = room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn(() => usedEnergy),
        getFreeCapacity: jest.fn(() => freeEnergy)
      },
      room,
      harvest: jest.fn().mockReturnValue(ERR_FULL),
      transfer: jest.fn().mockReturnValue(0)
    } as unknown as Creep;
    const getObjectById = jest.fn((id: string) => {
      if (id === 'source1') {
        return source;
      }

      if (id === 'spawn1') {
        return spawn;
      }

      return null;
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 20,
      rooms: { W1N1: room },
      creeps: { siblingWorker },
      getObjectById
    };

    (Game as Partial<Game>).time = 20;
    runWorker(creep);
    (Game as Partial<Game>).time = 21;
    runWorker(creep);
    (Game as Partial<Game>).time = 22;
    runWorker(creep);
    (Game as Partial<Game>).time = 24;
    runWorker(creep);
    (Game as Partial<Game>).time = 25;
    runWorker(creep);
    (Game as Partial<Game>).time = 26;
    runWorker(creep);
    (Game as Partial<Game>).time = 27;
    runWorker(creep);
    (Game as Partial<Game>).time = 28;
    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source1' });

    hasSpawn = true;
    usedEnergy = 50;
    freeEnergy = 0;
    (Game as Partial<Game>).time = 29;
    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.transfer).toHaveBeenCalledWith(spawn, 'energy');
  });

  it('respects source assignment pressure while selecting fallback pre-harvest', () => {
    const source1 = { id: 'source1', energy: 300, pos: { x: 10, y: 10, roomName: 'W1N1' } } as Source;
    const source2 = { id: 'source2', energy: 300, pos: { x: 30, y: 30, roomName: 'W1N1' } } as Source;
    const container = { id: 'container1', pos: { x: 11, y: 10, roomName: 'W1N1' } } as StructureContainer;
    const assignedWorker = {
      memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
      room: { name: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      }
    } as unknown as Creep;
    const siblingWorker = {
      memory: { role: 'worker', task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { name: 'W1N1' }
    } as unknown as Creep;
    const room = {
      name: 'W1N1',
      controller: { id: 'controller1', my: true, level: 3 } as StructureController,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source1, source2];
        }

        if (type === FIND_STRUCTURES) {
          return [container];
        }

        return [];
      })
    } as unknown as Room;
    (siblingWorker as Creep).room = room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room,
      harvest: jest.fn().mockReturnValue(ERR_FULL)
    } as unknown as Creep;
    const getObjectById = jest.fn((id: string) => {
      if (id === 'source1') {
        return source1;
      }

      if (id === 'source2') {
        return source2;
      }

      return null;
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 1,
      rooms: { W1N1: room },
      creeps: { assignedWorker, siblingWorker },
      getObjectById
    };
    (assignedWorker as Creep).room = room;

    runWorker(creep);
    (Game as Partial<Game>).time = 2;
    runWorker(creep);
    (Game as Partial<Game>).time = 3;
    runWorker(creep);
    (Game as Partial<Game>).time = 4;
    runWorker(creep);
    (Game as Partial<Game>).time = 5;
    runWorker(creep);
    (Game as Partial<Game>).time = 6;
    runWorker(creep);
    (Game as Partial<Game>).time = 7;
    runWorker(creep);
    (Game as Partial<Game>).time = 8;
    runWorker(creep);
    (Game as Partial<Game>).time = 9;
    runWorker(creep);
    (Game as Partial<Game>).time = 10;
    runWorker(creep);

    expect(creep.memory.task).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('limits fallback attempts when task selection remains null', () => {
    const siblingWorker = {
      memory: { role: 'worker', task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { name: 'W1N1' }
    } as unknown as Creep;
    const room = {
      name: 'W1N1',
      controller: { id: 'controller1', my: true, level: 3 } as StructureController,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;
    (siblingWorker as Creep).room = room as Room;

    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 10,
      rooms: { W1N1: room },
      creeps: { siblingWorker }
    };

    runWorker(creep);
    (Game as Partial<Game>).time = 11;
    runWorker(creep);
    (Game as Partial<Game>).time = 12;
    runWorker(creep);
    (Game as Partial<Game>).time = 13;
    runWorker(creep);
    (Game as Partial<Game>).time = 14;
    runWorker(creep);
    (Game as Partial<Game>).time = 15;
    runWorker(creep);
    (Game as Partial<Game>).time = 16;
    runWorker(creep);
    (Game as Partial<Game>).time = 17;
    runWorker(creep);
    (Game as Partial<Game>).time = 18;
    runWorker(creep);
    (Game as Partial<Game>).time = 19;
    runWorker(creep);

    expect(creep.memory.task).toBeUndefined();
    expect(creep.memory.workerTaskSelectionNullLoop).toEqual({
      lastNullSelectionTick: 10,
      nullSelectionCount: 10,
      fallbackAttempts: 2,
      idleStartTick: 10
    });
  });
});
