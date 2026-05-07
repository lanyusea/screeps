import {
  predictWorkerTaskAction,
  resetWorkerTaskBcModelForTesting,
  setWorkerTaskBcModelForTesting,
  type WorkerTaskBcModel
} from '../src/rl/workerTaskPolicy';
import {
  assessWorkerEnergyCriticalState,
  selectWorkerEnergyCriticalTask,
  WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD,
  WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN
} from '../src/creeps/workerTaskPolicy';
import {
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
  selectWorkerTask
} from '../src/tasks/workerTasks';

type MutableRoom = Room & { energyAvailable?: number; storage?: StructureStorage };

const TEST_MODEL: WorkerTaskBcModel = {
  type: 'worker-task-bc-decision-tree',
  schemaVersion: 1,
  policyId: 'worker-task-bc.test.v1',
  source: 'test',
  liveEffect: false,
  minConfidence: 0.8,
  actionTypes: ['harvest', 'transfer', 'build', 'repair', 'upgrade'],
  features: ['carriedEnergy'],
  root: {
    type: 'branch',
    feature: 'carriedEnergy',
    threshold: 0,
    missing: 'left',
    sampleCount: 4,
    distribution: { harvest: 2, transfer: 2 },
    left: {
      type: 'leaf',
      action: 'harvest',
      confidence: 1,
      sampleCount: 2,
      distribution: { harvest: 2 }
    },
    right: {
      type: 'leaf',
      action: 'transfer',
      confidence: 1,
      sampleCount: 2,
      distribution: { transfer: 2 }
    }
  }
};

describe('worker energy-critical policy', () => {
  beforeEach(() => {
    installWorkerTaskGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = { time: 200, creeps: {} };
  });

  it('enters below the spawn threshold and reassigns non-critical upgrading to acquisition', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const controller = makeController();
    const room = makeEnergyCriticalRoom({
      controller,
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      sources: [source]
    });
    const creep = makeEnergyCriticalWorker(room, {
      carriedEnergy: 25,
      freeCapacity: 25,
      task: { type: 'upgrade', targetId: controller.id }
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 201,
      creeps: {},
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : controller))
    };

    expect(selectWorkerEnergyCriticalTask(creep, creep.memory.task, creep.memory.task ?? null)).toEqual({
      type: 'harvest',
      targetId: 'source1'
    });
    expect(creep.memory.workerEnergyCriticalPolicy).toMatchObject({
      type: 'workerEnergyCriticalPolicy',
      active: true,
      reason: 'spawn',
      spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      spawnEnterThreshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
      spawnExitThreshold: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD
    });
  });

  it('preempts repair tasks during an energy crisis', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    const repairTarget = { id: 'road1', structureType: 'road' } as StructureRoad;
    const controller = makeController();
    const room = makeEnergyCriticalRoom({
      controller,
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      sources: [source],
      structures: [repairTarget as unknown as AnyStructure]
    });
    const creep = makeEnergyCriticalWorker(room, {
      carriedEnergy: 25,
      freeCapacity: 25,
      task: { type: 'repair', targetId: repairTarget.id as Id<Structure> }
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 201,
      creeps: {},
      getObjectById: jest.fn((id: string) => (id === 'source1' ? source : repairTarget))
    };

    expect(selectWorkerEnergyCriticalTask(creep, creep.memory.task, creep.memory.task ?? null)).toEqual({
      type: 'harvest',
      targetId: 'source1'
    });
  });

  it('keeps spawn-critical mode active until the hysteresis exit threshold is reached', () => {
    const room = makeEnergyCriticalRoom({
      controller: makeController(),
      energyAvailable: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1
    });
    const creep = makeEnergyCriticalWorker(room, {
      carriedEnergy: 25,
      freeCapacity: 25
    });

    expect(assessWorkerEnergyCriticalState(creep).active).toBe(true);

    room.energyAvailable = WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD - 1;
    expect(assessWorkerEnergyCriticalState(creep)).toMatchObject({
      active: true,
      reason: 'spawn',
      spawnEnergy: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD - 1
    });

    room.energyAvailable = WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD;
    expect(assessWorkerEnergyCriticalState(creep).active).toBe(false);
    expect(creep.memory.workerEnergyCriticalPolicy).toBeUndefined();
  });

  it('keeps storage-critical mode active through its hysteresis band without withdrawing from storage', () => {
    const source = { id: 'source1', energy: 300 } as Source;
    let storageEnergy = 499;
    const storage = makeStorage('storage1', () => storageEnergy);
    const controller = makeController();
    const room = makeEnergyCriticalRoom({
      controller,
      energyAvailable: WORKER_ENERGY_CRITICAL_SPAWN_EXIT_THRESHOLD,
      sources: [source],
      structures: [storage as unknown as AnyStructure],
      storage
    });
    const creep = makeEnergyCriticalWorker(room, {
      carriedEnergy: 25,
      freeCapacity: 25,
      task: { type: 'upgrade', targetId: controller.id }
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 202,
      creeps: {},
      getObjectById: jest.fn((id: string) => {
        if (id === 'storage1') {
          return storage;
        }

        return id === 'source1' ? source : controller;
      })
    };

    const entered = assessWorkerEnergyCriticalState(creep);
    expect(entered).toMatchObject({
      active: true,
      reason: 'storage',
      storageEnergy: 499,
      storageEnterThreshold: 500,
      storageExitThreshold: 500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN
    });

    storageEnergy = 600;
    expect(selectWorkerEnergyCriticalTask(creep, creep.memory.task, creep.memory.task ?? null)).toEqual({
      type: 'harvest',
      targetId: 'source1'
    });
    expect(creep.memory.workerEnergyCriticalPolicy).toMatchObject({
      active: true,
      reason: 'storage',
      storageEnergy: 600
    });

    storageEnergy = 500 + WORKER_ENERGY_CRITICAL_STORAGE_EXIT_MARGIN;
    expect(assessWorkerEnergyCriticalState(creep).active).toBe(false);
  });
});

describe('worker task BC policy', () => {
  afterEach(() => {
    resetWorkerTaskBcModelForTesting();
  });

  it('predicts trained worker task actions from numeric state features', () => {
    expect(
      predictWorkerTaskAction(TEST_MODEL, {
        ...baseState(),
        carriedEnergy: 0
      })
    ).toEqual({
      policyId: 'worker-task-bc.test.v1',
      action: 'harvest',
      confidence: 1
    });

    expect(
      predictWorkerTaskAction(TEST_MODEL, {
        ...baseState(),
        carriedEnergy: 50
      })
    ).toMatchObject({
      action: 'transfer',
      confidence: 1
    });
  });

  it('keeps heuristic transfer task while recording matching BC shadow metadata', () => {
    setWorkerTaskBcModelForTesting(TEST_MODEL);
    installWorkerTaskGlobals();
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(300)
      }
    } as unknown as StructureSpawn;
    const creep = {
      name: 'Carrier',
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: {
        name: 'W1N1',
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          if (type === FIND_MY_CREEPS) {
            return [creep];
          }

          return [];
        })
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 123,
      creeps: { Carrier: creep }
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerBehavior).toMatchObject({
      type: 'workerTaskBehavior',
      tick: 123,
      liveEffect: false,
      action: { type: 'transfer', targetId: 'spawn1' },
      state: {
        roomName: 'W1N1',
        carriedEnergy: 50,
        workerCount: 0,
        spawnExtensionNeedCount: 1
      }
    });
    expect(creep.memory.workerTaskPolicyShadow).toEqual({
      type: 'workerTaskPolicyShadow',
      schemaVersion: 1,
      tick: 123,
      policyId: 'worker-task-bc.test.v1',
      liveEffect: false,
      predictedAction: 'transfer',
      confidence: 1,
      heuristicAction: 'transfer',
      matched: true
    });
  });

  it('falls back to the heuristic when BC action disagrees', () => {
    setWorkerTaskBcModelForTesting({
      ...TEST_MODEL,
      root: {
        type: 'leaf',
        action: 'upgrade',
        confidence: 1,
        sampleCount: 1,
        distribution: { upgrade: 1 }
      }
    });
    installWorkerTaskGlobals();
    const source = { id: 'source1', energy: 300 } as Source;
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: {
        name: 'W1N1',
        find: jest.fn((type: number) => (type === FIND_SOURCES ? [source] : []))
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { time: 124, creeps: {} };

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerTaskPolicyShadow).toMatchObject({
      policyId: 'worker-task-bc.test.v1',
      liveEffect: false,
      predictedAction: 'upgrade',
      heuristicAction: 'harvest',
      matched: false,
      fallbackReason: 'actionMismatch'
    });
  });
});

function baseState(): WorkerTaskBehaviorStateMemory {
  return {
    roomName: 'W1N1',
    carriedEnergy: 0,
    freeCapacity: 50,
    energyCapacity: 50,
    energyLoadRatio: 0,
    currentTask: 'none',
    currentTaskCode: 0,
    workerCount: 1,
    spawnExtensionNeedCount: 0,
    towerNeedCount: 0,
    constructionSiteCount: 0,
    repairTargetCount: 0,
    sourceCount: 1,
    hasContainerEnergy: false,
    containerEnergyAvailable: 0,
    droppedEnergyAvailable: 0,
    nearbyRoadCount: 0,
    nearbyContainerCount: 0,
    roadCoverage: 0,
    hostileCreepCount: 0
  };
}

function installWorkerTaskGlobals(): void {
  (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
  (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
  (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
  (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
  (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
  (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
  (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
  (globalThis as unknown as { FIND_TOMBSTONES: number }).FIND_TOMBSTONES = 8;
  (globalThis as unknown as { FIND_RUINS: number }).FIND_RUINS = 9;
  (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
  (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
  (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
  (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
  (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
  (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
  (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
  (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
  (globalThis as unknown as { STRUCTURE_WALL: StructureConstant }).STRUCTURE_WALL = 'constructedWall';
  (globalThis as unknown as { STRUCTURE_RAMPART: StructureConstant }).STRUCTURE_RAMPART = 'rampart';
}

function makeController(): StructureController {
  return {
    id: 'controller1',
    my: true,
    level: 3,
    ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
  } as StructureController;
}

function makeStorage(id: string, getEnergy: () => number): StructureStorage {
  return {
    id,
    structureType: 'storage',
    store: {
      getUsedCapacity: jest.fn(() => getEnergy()),
      getFreeCapacity: jest.fn().mockReturnValue(10_000)
    }
  } as unknown as StructureStorage;
}

function makeEnergyCriticalRoom({
  controller,
  energyAvailable,
  sources = [],
  storage,
  structures = []
}: {
  controller: StructureController;
  energyAvailable: number;
  sources?: Source[];
  storage?: StructureStorage;
  structures?: AnyStructure[];
}): MutableRoom {
  return {
    name: 'W1N1',
    controller,
    energyAvailable,
    storage,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) {
        return structures;
      }

      return [];
    })
  } as unknown as MutableRoom;
}

function makeEnergyCriticalWorker(
  room: Room,
  options: {
    carriedEnergy: number;
    freeCapacity: number;
    task?: CreepTaskMemory;
  }
): Creep {
  return {
    memory: {
      role: 'worker',
      ...(options.task ? { task: options.task } : {})
    },
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(options.carriedEnergy),
      getFreeCapacity: jest.fn().mockReturnValue(options.freeCapacity)
    },
    pos: { getRangeTo: jest.fn().mockReturnValue(1) },
    room
  } as unknown as Creep;
}
