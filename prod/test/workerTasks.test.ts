import {
  CONTROLLER_DOWNGRADE_GUARD_TICKS,
  CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
  CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO,
  IDLE_RAMPART_REPAIR_HITS_CEILING,
  BUILDER_DROPPED_PICKUP_RANGE,
  BUILDER_STORAGE_WITHDRAW_MIN,
  LOW_LOAD_NEARBY_ENERGY_RANGE,
  LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE,
  MINIMUM_USEFUL_LOAD_RATIO,
  TOWER_REFILL_ENERGY_FLOOR,
  URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
  estimateNearTermSpawnExtensionRefillReserve,
  canLevelUpController,
  canUpgradeController,
  isUpgraderBoostActive,
  selectWorkerTask
} from '../src/tasks/workerTasks';
import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  emitRuntimeSummary,
  RUNTIME_SUMMARY_INTERVAL,
  RUNTIME_SUMMARY_PREFIX
} from '../src/telemetry/runtimeSummary';
import {
  assessColonySurvival,
  clearColonySurvivalAssessmentCache,
  recordColonySurvivalAssessment
} from '../src/colony/survivalMode';
import { TERRITORY_CONTROLLER_BODY_COST } from '../src/spawn/bodyBuilder';
import {
  TERRITORY_RESERVATION_COMFORT_TICKS,
  TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS,
  TERRITORY_RESERVATION_RENEWAL_TICKS
} from '../src/territory/territoryPlanner';

type TestEnergySink = StructureSpawn | StructureExtension | StructureTower;

function makeLoadedWorker(room: Room, task?: CreepTaskMemory): Creep {
  return {
    memory: { role: 'worker', ...(task ? { task } : {}) },
    store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
    room
  } as unknown as Creep;
}

function makeRefillReserveWorker(room: Room, name: string, energy: number, rangeToRefill: number): Creep {
  return {
    name,
    memory: { role: 'worker' },
    store: { getUsedCapacity: jest.fn().mockReturnValue(energy) },
    pos: { getRangeTo: jest.fn().mockReturnValue(rangeToRefill) },
    room
  } as unknown as Creep;
}

function setGameCreeps(creeps: Record<string, Creep>): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps };
}

function setGameSpawns(spawns: Record<string, StructureSpawn>): void {
  const globalScope = globalThis as unknown as { Game?: Partial<Game> };
  globalScope.Game = { ...(globalScope.Game ?? {}), spawns };
}

function makeStructure(
  id: string,
  structureType: StructureConstant,
  hits: number,
  hitsMax: number,
  extra: Record<string, unknown> = {}
): AnyStructure {
  return { id, structureType, hits, hitsMax, ...extra } as unknown as AnyStructure;
}

function makeEnergySink(
  id: string,
  structureType: StructureConstant,
  freeCapacity: number,
  extra: Record<string, unknown> = {}
): TestEnergySink {
  return {
    id,
    structureType,
    store: { getFreeCapacity: jest.fn().mockReturnValue(freeCapacity) },
    ...extra
  } as unknown as TestEnergySink;
}

function makeEnergySinkWithEnergy(
  id: string,
  structureType: StructureConstant,
  energy: number,
  freeCapacity: number,
  extra: Record<string, unknown> = {}
): TestEnergySink {
  return makeEnergySink(id, structureType, freeCapacity, {
    ...extra,
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(energy),
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity)
    }
  });
}

function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function makeSpawn(id: string, x: number, y: number, roomName = 'W1N1'): StructureSpawn {
  return {
    id,
    name: id,
    structureType: 'spawn',
    owner: { username: 'Self' },
    pos: makeRoomPosition(x, y, roomName),
    store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
  } as unknown as StructureSpawn;
}

function makeTowerEnergySink(id: string, usedEnergy: number, freeCapacity: number): StructureTower {
  return {
    id,
    structureType: 'tower',
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(usedEnergy),
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity)
    }
  } as unknown as StructureTower;
}

function withRangeTo<T extends { id: string }>(object: T, rangesByTargetId: Record<string, number>): T {
  return {
    ...object,
    pos: {
      getRangeTo: jest.fn((target: RoomObject) => rangesByTargetId[String((target as { id?: string }).id)] ?? 99)
    }
  };
}

function makeStoredEnergyStructure(
  id: string,
  structureType: StructureConstant,
  energy: number,
  extra: Record<string, unknown> = {}
): StructureContainer | StructureStorage | StructureTerminal {
  return {
    id,
    structureType,
    store: { getUsedCapacity: jest.fn().mockReturnValue(energy) },
    ...extra
  } as unknown as StructureContainer | StructureStorage | StructureTerminal;
}

function makeStoredEnergyLink(id: string, x: number, y: number, energy: number): StructureLink {
  return {
    id,
    my: true,
    structureType: 'link',
    pos: makeRoomPosition(x, y),
    store: { getUsedCapacity: jest.fn().mockReturnValue(energy) }
  } as unknown as StructureLink;
}

function makeSalvageEnergySource(
  id: string,
  energy: number,
  extraResourceAmount = 0
): Tombstone | Ruin {
  return {
    id,
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : extraResourceAmount))
    }
  } as unknown as Tombstone | Ruin;
}

function makeSource(id: string, x: number, y: number, energyOrRoomName: number | string = 300): Source {
  const energy = typeof energyOrRoomName === 'number' ? energyOrRoomName : 300;
  const roomName = typeof energyOrRoomName === 'string' ? energyOrRoomName : 'W1N1';

  return {
    id,
    energy,
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as Source;
}

function makeWorkerTaskRoom({
  constructionSites = [],
  controller = { id: 'controller1', my: true, level: 3 } as StructureController,
  energyAvailable,
  energyCapacityAvailable,
  hostileCreeps = [],
  hostileStructures = [],
  myCreeps = [],
  myStructures = [],
  name = 'W1N1',
  sources = [],
  structures = []
}: {
  constructionSites?: ConstructionSite[];
  controller?: StructureController;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  hostileCreeps?: Creep[];
  hostileStructures?: AnyStructure[];
  myCreeps?: Creep[];
  myStructures?: AnyOwnedStructure[];
  name?: string;
  sources?: Source[];
  structures?: AnyStructure[];
} = {}): Room {
  return {
    name,
    controller,
    ...(energyAvailable === undefined ? {} : { energyAvailable }),
    ...(energyCapacityAvailable === undefined ? {} : { energyCapacityAvailable }),
    find: jest.fn((type: number, options?: { filter?: (object: AnyOwnedStructure | Creep) => boolean }) => {
      if (type === FIND_MY_STRUCTURES) {
        return options?.filter ? myStructures.filter(options.filter) : myStructures;
      }

      const findMyCreeps = (globalThis as unknown as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
      if (typeof findMyCreeps === 'number' && type === findMyCreeps) {
        return options?.filter ? myCreeps.filter(options.filter) : myCreeps;
      }

      if (type === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
      }

      if (type === FIND_HOSTILE_STRUCTURES) {
        return hostileStructures;
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      if (type === FIND_SOURCES) {
        return sources;
      }

      return [];
    })
  } as unknown as Room;
}

function makeFollowUpDemand(
  updatedAt: number,
  colony = 'W1N1',
  targetRoom = 'W2N2'
): TerritoryFollowUpDemandMemory {
  return {
    type: 'followUpPreparation',
    colony,
    targetRoom,
    action: 'reserve',
    workerCount: 1,
    updatedAt,
    followUp: {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    }
  };
}

function recordSurvivalMode(
  mode: 'BOOTSTRAP' | 'LOCAL_STABLE' | 'TERRITORY_READY' | 'DEFENSE',
  tick = 900
): void {
  const inputByMode = {
    BOOTSTRAP: {
      workerCapacity: 1,
      workerTarget: 3,
      hostileCreepCount: 0
    },
    LOCAL_STABLE: {
      workerCapacity: 3,
      workerTarget: 4,
      hostileCreepCount: 0
    },
    TERRITORY_READY: {
      workerCapacity: 4,
      workerTarget: 4,
      hostileCreepCount: 0
    },
    DEFENSE: {
      workerCapacity: 4,
      workerTarget: 4,
      hostileCreepCount: 1
    }
  }[mode];

  const globalScope = globalThis as unknown as { Game?: Partial<Game> };
  globalScope.Game = {
    ...(globalScope.Game ?? {}),
    time: tick
  };
  const assessment = assessColonySurvival({
    roomName: 'W1N1',
    energyCapacityAvailable: 650,
    controller: { my: true, level: 3, ticksToDowngrade: 10_000 },
    ...inputByMode
  });
  expect(assessment.mode).toBe(mode);
  recordColonySurvivalAssessment('W1N1', assessment, tick);
}

describe('selectWorkerTask', () => {
  beforeEach(() => {
    clearColonySurvivalAssessmentCache();
    (globalThis as unknown as { FIND_SOURCES: number; FIND_CONSTRUCTION_SITES: number; FIND_MY_STRUCTURES: number; FIND_DROPPED_RESOURCES: number; FIND_STRUCTURES: number; FIND_HOSTILE_CREEPS: number; FIND_HOSTILE_STRUCTURES: number; RESOURCE_ENERGY: ResourceConstant; STRUCTURE_SPAWN: StructureConstant; STRUCTURE_EXTENSION: StructureConstant; STRUCTURE_TOWER: StructureConstant; STRUCTURE_ROAD: StructureConstant; STRUCTURE_CONTAINER: StructureConstant; STRUCTURE_LINK: StructureConstant; STRUCTURE_STORAGE: StructureConstant; STRUCTURE_TERMINAL: StructureConstant; STRUCTURE_RAMPART: StructureConstant }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 3;
    (globalThis as unknown as { FIND_DROPPED_RESOURCES: number }).FIND_DROPPED_RESOURCES = 4;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { FIND_TOMBSTONES: number }).FIND_TOMBSTONES = 8;
    (globalThis as unknown as { FIND_RUINS: number }).FIND_RUINS = 9;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
    (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_LINK: StructureConstant }).STRUCTURE_LINK = 'link';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_RAMPART: StructureConstant }).STRUCTURE_RAMPART = 'rampart';
    (globalThis as unknown as { CLAIM: BodyPartConstant }).CLAIM = 'claim';
    (globalThis as unknown as { WORK: BodyPartConstant }).WORK = 'work';
    delete (globalThis as unknown as { FIND_MY_CREEPS?: number }).FIND_MY_CREEPS;
    delete (globalThis as unknown as { BUILD_POWER?: number }).BUILD_POWER;
    delete (globalThis as unknown as { PathFinder?: Partial<PathFinder> }).PathFinder;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game?: Partial<Game> }).Game = { creeps: {} };
  });

  it('selects harvest when worker has no energy', () => {
    const source = { id: 'source1' } as Source;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([source]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('prefers a source that can fill the worker over a closer low-energy source', () => {
    const lowEnergySource = makeSource('source-low', 8, 8, 10);
    const loadReadySource = makeSource('source-ready', 20, 20, 300);
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'source-low' ? 1 : 8))
      },
      room: makeWorkerTaskRoom({ sources: [lowEnergySource, loadReadySource] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-ready' });
  });

  it('harvests the closer source when same-tier sources can both fill the worker', () => {
    const distantSource = makeSource('source-distant', 25, 25, 300);
    const closeSource = makeSource('source-close', 8, 8, 300);
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => (type === FIND_SOURCES ? [distantSource, closeSource] : []))
    } as unknown as Room;
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'source-close' ? 2 : 12))
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-close' });
  });

  it('boosting upgraders withdraw stored energy before source2 lane harvesting near controller level-up', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 25);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 650, {
      my: true,
      pos: makeRoomPosition(10, 10)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const creep = {
      name: 'BoostUpgrader',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W1N1', role: 'upgrader' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(100),
        getCapacity: jest.fn().mockReturnValue(100)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'storage1' ? 8 : 1)) },
      room: makeWorkerTaskRoom({ controller, sources: [source1, source2], structures: [storage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage1' });
  });

  it('reports upgrader boost active near controller level-up when no hostiles are visible', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000
    } as StructureController;
    const creep = {
      memory: { role: 'upgrader' },
      room: makeWorkerTaskRoom({ controller })
    } as unknown as Creep;

    expect(isUpgraderBoostActive(creep, controller)).toBe(true);
  });

  it('reports upgrader boost inactive when hostiles are visible', () => {
    const hostile = { id: 'hostile1' } as Creep;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000
    } as StructureController;
    const creep = {
      memory: { role: 'upgrader' },
      room: makeWorkerTaskRoom({ controller, hostileCreeps: [hostile] })
    } as unknown as Creep;

    expect(isUpgraderBoostActive(creep, controller)).toBe(false);
  });

  it('lets emergency spawn refill preempt boosted upgrader controller work', () => {
    const spawn = makeEnergySinkWithEnergy('spawn1', 'spawn' as StructureConstant, 0, 300);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      name: 'BoostUpgrader',
      memory: { role: 'upgrader', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        energyCapacityAvailable: 300,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('recalls boosted remote upgraders before controller work while survival suppresses remote spending', () => {
    recordSurvivalMode('BOOTSTRAP');
    const homeSpawn = makeEnergySink('home-spawn', 'spawn' as StructureConstant, 300);
    const homeRoom = makeWorkerTaskRoom({ myStructures: [homeSpawn as AnyOwnedStructure] });
    const remoteController = {
      id: 'remote-controller',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const remoteRoom = makeWorkerTaskRoom({ controller: remoteController });
    (remoteRoom as Room & { name: string }).name = 'W2N1';
    const globalScope = globalThis as unknown as { Game?: Partial<Game> };
    globalScope.Game = {
      ...(globalScope.Game ?? {}),
      creeps: {},
      rooms: { W1N1: homeRoom, W2N1: remoteRoom }
    };
    const creep = {
      name: 'RemoteBoostUpgrader',
      memory: { role: 'upgrader', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: remoteRoom
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'home-spawn' });
  });

  it('lets visible hostiles preempt boosted upgrader controller work for tower refill', () => {
    const hostile = { id: 'hostile1' } as Creep;
    const tower = makeTowerEnergySink('tower-low', TOWER_REFILL_ENERGY_FLOOR - 1, 501);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      progress: 900,
      progressTotal: 1_000,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      name: 'BoostUpgrader',
      memory: { role: 'upgrader', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        hostileCreeps: [hostile],
        myStructures: [tower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'tower-low' });
  });

  it('does not activate upgrader boost at RCL8', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 25);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 500, {
      my: true,
      pos: makeRoomPosition(10, 10)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 8,
      progress: 1_000,
      progressTotal: 1_000,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const creep = {
      name: 'MaxRclUpgrader',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W1N1', role: 'upgrader' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(100),
        getCapacity: jest.fn().mockReturnValue(100)
      },
      pos: { getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'storage1' ? 8 : 1)) },
      room: makeWorkerTaskRoom({ controller, sources: [source1, source2], structures: [storage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('selects nearby dropped energy before farther dropped energy or harvesting', () => {
    const lowValueDroppedEnergy = { id: 'drop-low', resourceType: 'energy', amount: 24 } as Resource<ResourceConstant>;
    const farDroppedEnergy = { id: 'drop-far', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const nearDroppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: Resource<ResourceConstant>) => {
      const ranges: Record<string, number> = {
        'drop-far': 10,
        'drop-near': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [lowValueDroppedEnergy, farDroppedEnergy, nearDroppedEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(getRangeTo).not.toHaveBeenCalledWith(lowValueDroppedEnergy);
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('builder uses nearby stored energy near the construction site before harvesting', () => {
    const source = { id: 'source1' } as Source;
    const constructionSite = withRangeTo(
      {
      id: 'build-site1',
        structureType: 'extension',
        pos: makeRoomPosition(10, 10)
      } as ConstructionSite,
      {
        'container-near': 2
      }
    );
    const container = withRangeTo(
      makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 500),
      { 'build-site1': 2 }
    );
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'container-near': 2,
        source1: 4
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_CONSTRUCTION_SITES) {
        return [constructionSite];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'build', targetId: 'build-site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: {
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(constructionSite)
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near' });
  });

  it('builder uses nearby storage when it is the only viable stored-energy source near the site', () => {
    const source = { id: 'source1' } as Source;
    const constructionSite = withRangeTo(
      {
        id: 'build-site1',
        structureType: 'extension',
        pos: makeRoomPosition(10, 10)
      } as ConstructionSite,
      {
        'storage-eligible': 4,
        'container-empty': 2
      }
    );
    const emptyContainer = withRangeTo(
      makeStoredEnergyStructure('container-empty', 'container' as StructureConstant, 0),
      { 'build-site1': 2 }
    );
    const storage = withRangeTo(
      makeStoredEnergyStructure('storage-eligible', 'storage' as StructureConstant, 450, { my: true }),
      { 'build-site1': 4 }
    );
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'container-empty': 2,
        'storage-eligible': 4,
        source1: 6
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_CONSTRUCTION_SITES) {
        return [constructionSite];
      }

      if (type === FIND_STRUCTURES) {
        return [emptyContainer, storage];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'build', targetId: 'build-site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(constructionSite)
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-eligible' });
  });

  it('builder falls through to nearby container acquisition when no site-local energy is available', () => {
    const source = makeSource('source1', 10, 10, 300);
    const constructionSite = withRangeTo(
      {
        id: 'build-site1',
        structureType: 'extension',
        pos: makeRoomPosition(20, 20)
      } as ConstructionSite,
      {
        'container-near-creep': BUILDER_DROPPED_PICKUP_RANGE + 1
      }
    );
    const nearbyContainer = withRangeTo(
      makeStoredEnergyStructure('container-near-creep', 'container' as StructureConstant, 500),
      { 'build-site1': BUILDER_DROPPED_PICKUP_RANGE + 1 }
    );
    const room = makeWorkerTaskRoom({
      constructionSites: [constructionSite],
      sources: [source],
      structures: [nearbyContainer]
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'build', targetId: 'build-site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container-near-creep' ? 2 : 1))
      },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(constructionSite)
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near-creep' });
    expect(room.find).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('builder falls through to nearby container energy when site-local candidates do not meet builder thresholds', () => {
    const source = makeSource('source1', 10, 10, 300);
    const constructionSite = withRangeTo(
      {
        id: 'build-site1',
        structureType: 'extension',
        pos: makeRoomPosition(10, 10)
      } as ConstructionSite,
      {
        'container-small': 2,
        'drop-near': 2
      }
    );
    const lowContainer = withRangeTo(
      makeStoredEnergyStructure('container-small', 'container' as StructureConstant, BUILDER_STORAGE_WITHDRAW_MIN - 1),
      { 'build-site1': 2 }
    );
    const nearDrop = {
      id: 'drop-near',
      resourceType: 'energy',
      amount: 10
    } as Resource<ResourceConstant>;
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'container-small': 2,
        'drop-near': 2,
        source1: 4
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [nearDrop];
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return [constructionSite];
      }

      if (type === FIND_STRUCTURES) {
        return [lowContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'build', targetId: 'build-site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(constructionSite)
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-small' });
  });

  it('builder falls through to general stored-energy acquisition when site-local storage is below builder threshold', () => {
    const source = makeSource('source1', 10, 10, 300);
    const constructionSite = withRangeTo(
      {
        id: 'build-site1',
        structureType: 'extension',
        pos: makeRoomPosition(10, 10)
      } as ConstructionSite,
      {
        'storage-small': 2
      }
    );
    const storage = withRangeTo(
      makeStoredEnergyStructure(
        'storage-small',
        'storage' as StructureConstant,
        300 + BUILDER_STORAGE_WITHDRAW_MIN - 1,
        {
          my: true
        }
      ),
      { 'build-site1': 2 }
    );
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'storage-small': 2,
        source1: 4
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_CONSTRUCTION_SITES) {
        return [constructionSite];
      }

      if (type === FIND_STRUCTURES) {
        return [storage];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      memory: { role: 'worker', task: { type: 'build', targetId: 'build-site1' as Id<ConstructionSite> } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(constructionSite)
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-small' });
  });

  it('falls back to harvesting when visible dropped energy is not reachable', () => {
    const blockedDroppedEnergy = { id: 'drop-blocked', resourceType: 'energy', amount: 200 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [blockedDroppedEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id: string }) => (target.id === 'drop-blocked' ? 5 : 1)),
        findPathTo: jest.fn().mockReturnValue([])
      },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.pos.findPathTo).toHaveBeenCalledWith(blockedDroppedEnergy, { ignoreCreeps: true });
  });

  it('bounds dropped energy path checks while preserving nearby pickup preference', () => {
    const farDroppedEnergy = Array.from(
      { length: 8 },
      (_, index) =>
        ({
          id: `drop-far-${index}`,
          resourceType: 'energy',
          amount: 1_000 + index
        }) as Resource<ResourceConstant>
    );
    const nearDroppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const droppedResources = [...farDroppedEnergy, nearDroppedEnergy];
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      if (target.id === 'drop-near') {
        return 2;
      }

      const index = Number(target.id.replace('drop-far-', ''));
      return Number.isFinite(index) ? 10 + index : 99;
    });
    const findPathTo = jest.fn((target: { id: string }) => (target.id === 'drop-near' ? [{}] : []));
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return droppedResources;
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo, findPathTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(findPathTo.mock.calls.length).toBeLessThan(droppedResources.length);
    expect(findPathTo).not.toHaveBeenCalledWith(farDroppedEnergy[7], { ignoreCreeps: true });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('keeps dropped energy fallback deterministic when energy globals or stores are partially mocked', () => {
    delete (globalThis as unknown as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    const partialContainer = { id: 'container1', structureType: 'container' } as AnyStructure;
    const droppedEnergy = { id: 'drop1', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_STRUCTURES) {
        return [partialContainer];
      }

      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop1' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('uses the fastest local recoverable energy path under spawn pressure', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const richStorage = withRangeTo(
      makeStoredEnergyStructure('storage-rich', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 8 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 5 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-near': 1,
        source1: 2,
        'storage-rich': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return type === FIND_DROPPED_RESOURCES ? [droppedEnergy] : [];
        }

        if (type === FIND_STRUCTURES) {
          return [richStorage];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
  });

  it('uses small dropped energy under spawn pressure when it beats harvesting', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-small', resourceType: 'energy', amount: 10 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 5 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-small': 1,
        source1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
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
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-small' });
  });

  it('keeps trivial dropped energy ignored under spawn pressure', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-trivial', resourceType: 'energy', amount: 9 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 5 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-trivial': 1,
        source1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
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
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('uses dropped energy when it ties harvest delivery under spawn pressure', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 50);
    const droppedEnergy = withRangeTo(
      { id: 'drop-equal', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-equal': 1,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts: jest.fn().mockReturnValue(50),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-equal' });
  });

  it('uses stored energy when it ties harvest delivery under extension pressure', () => {
    const extension = makeEnergySink('extension1', 'extension' as StructureConstant, 50);
    const storedEnergy = withRangeTo(
      makeStoredEnergyStructure('storage-equal', 'storage' as StructureConstant, 350, { my: true }),
      { extension1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { extension1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'storage-equal': 1,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [extension as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storedEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts: jest.fn().mockReturnValue(50),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-equal' });
  });

  it('uses salvage energy when it ties harvest delivery under extension pressure', () => {
    const extension = makeEnergySink('extension1', 'extension' as StructureConstant, 50);
    const salvageEnergy = withRangeTo(makeSalvageEnergySource('tombstone-equal', 50), { extension1: 1 });
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { extension1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'tombstone-equal': 1,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [extension as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_TOMBSTONES) {
          return [salvageEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts: jest.fn().mockReturnValue(50),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'tombstone-equal' });
  });

  it('uses recoverable dropped energy under spawn pressure when the creep has no active work parts', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-recoverable', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-recoverable': 30,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const getActiveBodyparts = jest.fn().mockReturnValue(0);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-recoverable' });
    expect(getActiveBodyparts).toHaveBeenCalledWith('work');
  });

  it('uses recoverable stored energy under spawn pressure when the creep has no active work parts', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storedEnergy = withRangeTo(
      makeStoredEnergyStructure('storage-recoverable', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 1 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'storage-recoverable': 30,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const getActiveBodyparts = jest.fn().mockReturnValue(0);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storedEnergy];
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts,
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-recoverable' });
    expect(getActiveBodyparts).toHaveBeenCalledWith('work');
  });

  it('keeps dropped energy recoverable under spawn pressure when harvest sources are empty', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = withRangeTo(
      { id: 'drop-recoverable', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>,
      { spawn1: 15 }
    );
    const emptySource = withRangeTo(
      { id: 'source-empty', energy: 0, ticksToRegeneration: 100 } as Source,
      { spawn1: 1 }
    );
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-recoverable': 15,
        'source-empty': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        if (type === FIND_STRUCTURES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        return type === FIND_SOURCES ? [emptySource] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-recoverable' });
  });

  it('keeps stored energy recoverable under spawn pressure when harvest sources are empty', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storedEnergy = withRangeTo(
      makeStoredEnergyStructure('storage-recoverable', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 15 }
    );
    const emptySource = withRangeTo(
      { id: 'source-empty', energy: 0, ticksToRegeneration: 100 } as Source,
      { spawn1: 1 }
    );
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'source-empty': 1,
        'storage-recoverable': 15
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [storedEnergy];
        }

        return type === FIND_SOURCES ? [emptySource] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-recoverable' });
  });

  it('falls back to harvesting under spawn pressure when recoverable energy cannot beat a harvest trip', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const farStorage = withRangeTo(
      makeStoredEnergyStructure('storage-far', 'storage' as StructureConstant, 1_000, { my: true }),
      { spawn1: 100 }
    );
    const source = withRangeTo({ id: 'source1', energy: 300 } as Source, { spawn1: 1 });
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: 1,
        'storage-far': 100
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [farStorage];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('stands by under spawn pressure when empty sources have no recoverable energy', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const emptySource = withRangeTo(
      { id: 'source-empty', energy: 0, ticksToRegeneration: 100 } as Source,
      { spawn1: 1 }
    );
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'source-empty': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
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

        return type === FIND_SOURCES ? [emptySource] : [];
      }
    );
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('prefers safe container energy before durable storage', () => {
    const container = makeStoredEnergyStructure('container1', 'container' as StructureConstant, 100);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 200, { my: true });
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container, storage];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container1' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('prefers nearby container energy over much richer durable storage', () => {
    const nearbyTinyContainer = makeStoredEnergyStructure('container-tiny', 'container' as StructureConstant, 25);
    const richStorage = makeStoredEnergyStructure('storage-rich', 'storage' as StructureConstant, 1_000, { my: true });
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: StructureContainer | StructureStorage) => {
      const ranges: Record<string, number> = {
        'container-tiny': 1,
        'storage-rich': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [nearbyTinyContainer, richStorage];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-tiny' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('harvests active sources before falling back to link energy', () => {
    const source = makeSource('source1', 10, 10);
    const link = makeStoredEnergyLink('link-full', 11, 10, 800);
    const room = makeWorkerTaskRoom({
      myStructures: [link],
      sources: [source]
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('withdraws from containers before falling back to link energy', () => {
    const emptySource = makeSource('source-empty', 10, 10, 0);
    const container = makeStoredEnergyStructure('container1', 'container' as StructureConstant, 50);
    const link = makeStoredEnergyLink('link-full', 11, 10, 800);
    const room = makeWorkerTaskRoom({
      myStructures: [link],
      sources: [emptySource],
      structures: [container]
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container1' });
  });

  it('withdraws from the closest owned link when containers and sources are empty', () => {
    const emptySource = makeSource('source-empty', 10, 10, 0);
    const closeLink = makeStoredEnergyLink('link-close', 11, 10, 100);
    const emptyLink = makeStoredEnergyLink('link-empty', 12, 10, 0);
    const richDistantLink = makeStoredEnergyLink('link-rich-distant', 25, 23, 800);
    const room = makeWorkerTaskRoom({
      myStructures: [closeLink, emptyLink, richDistantLink],
      sources: [emptySource]
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'link-rich-distant' ? 20 : 1))
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'link-close' });
  });

  it('withdraws from the closer container when same-tier containers both have energy', () => {
    const closeContainer = makeStoredEnergyStructure('container-close', 'container' as StructureConstant, 100);
    const distantContainer = makeStoredEnergyStructure('container-distant', 'container' as StructureConstant, 1_000);
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'container-close': 4,
        'container-distant': 12
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [distantContainer, closeContainer];
      }

      return [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-close' });
  });

  it('picks up the closer dropped energy when same-tier drops both have energy', () => {
    const closeDroppedEnergy = { id: 'drop-close', resourceType: 'energy', amount: 25 } as Resource<ResourceConstant>;
    const distantDroppedEnergy = { id: 'drop-distant', resourceType: 'energy', amount: 500 } as Resource<ResourceConstant>;
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'drop-close': 4,
        'drop-distant': 12
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [distantDroppedEnergy, closeDroppedEnergy];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES || type === FIND_STRUCTURES) {
        return [];
      }

      return [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-close' });
  });

  it('withdraws from the closer ruin when same-tier ruins both have energy', () => {
    const closeRuin = makeSalvageEnergySource('ruin-close', 25);
    const distantRuin = makeSalvageEnergySource('ruin-distant', 500);
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'ruin-close': 4,
        'ruin-distant': 12
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_RUINS) {
        return [distantRuin, closeRuin];
      }

      if (
        type === FIND_DROPPED_RESOURCES ||
        type === FIND_HOSTILE_CREEPS ||
        type === FIND_HOSTILE_STRUCTURES ||
        type === FIND_STRUCTURES ||
        type === FIND_TOMBSTONES
      ) {
        return [];
      }

      return [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'ruin-close' });
  });

  it('prefers a nearby full-load pickup over distant surplus stored energy', () => {
    const nearbyDroppedEnergy = { id: 'drop-full-load', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const farStorage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: StructureStorage | Resource<ResourceConstant>) => {
      const ranges: Record<string, number> = {
        'drop-full-load': 1,
        'storage-surplus': 10
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [nearbyDroppedEnergy];
      }

      if (type === FIND_STRUCTURES) {
        return [farStorage];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-full-load' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('keeps closest safe stored energy when stored amounts are comparable', () => {
    const nearbyContainer = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 100);
    const fartherStorage = makeStoredEnergyStructure('storage-far', 'storage' as StructureConstant, 150, { my: true });
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: StructureContainer | StructureStorage) => {
      const ranges: Record<string, number> = {
        'container-near': 1,
        'storage-far': 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [fartherStorage, nearbyContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('breaks equal stored energy score ties by id', () => {
    const secondContainer = makeStoredEnergyStructure('container-b', 'container' as StructureConstant, 100);
    const firstContainer = makeStoredEnergyStructure('container-a', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn().mockReturnValue(2);
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [secondContainer, firstContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-a' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('ignores hostile-owned stored energy even when it would score higher', () => {
    const safeContainer = makeStoredEnergyStructure('container-safe', 'container' as StructureConstant, 50);
    const hostileStorage = makeStoredEnergyStructure('storage-hostile', 'storage' as StructureConstant, 10_000, {
      my: false
    });
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: StructureContainer | StructureStorage) => {
      const ranges: Record<string, number> = {
        'container-safe': 6,
        'storage-hostile': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [hostileStorage, safeContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-safe' });
    expect(getRangeTo).not.toHaveBeenCalledWith(hostileStorage);
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('selects withdraw from a reserved remote container before harvesting', () => {
    const container = makeStoredEnergyStructure('remote-container', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      owner: { username: 'me' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: {
        controller: { my: false, reservation: { username: 'me' } },
        find: roomFind
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'remote-container' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('selects withdraw from a neutral non-hostile container before harvesting', () => {
    const container = makeStoredEnergyStructure('neutral-container', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: false }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'neutral-container' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it.each(['tombstone', 'ruin'] as const)('selects withdraw from %s energy before harvesting', (sourceKind) => {
    const salvageEnergy = makeSalvageEnergySource(`${sourceKind}1`, 25);
    const source = { id: 'source1' } as Source;
    const salvageFindType = sourceKind === 'tombstone' ? FIND_TOMBSTONES : FIND_RUINS;
    const otherSalvageFindType = sourceKind === 'tombstone' ? FIND_RUINS : FIND_TOMBSTONES;
    const roomFind = jest.fn((type: number) => {
      if (
        type === FIND_DROPPED_RESOURCES ||
        type === FIND_STRUCTURES ||
        type === FIND_HOSTILE_CREEPS ||
        type === FIND_HOSTILE_STRUCTURES ||
        type === otherSalvageFindType
      ) {
        return [];
      }

      if (type === salvageFindType) {
        return [salvageEnergy];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: `${sourceKind}1` });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('ignores empty, non-energy, and trivial tombstone or ruin stores before balanced harvesting', () => {
    const emptyTombstone = makeSalvageEnergySource('tombstone-empty', 0);
    const trivialTombstone = makeSalvageEnergySource('tombstone-trivial', 1);
    const mineralOnlyRuin = makeSalvageEnergySource('ruin-mineral', 0, 100);
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES
        ) {
          return [];
        }

        if (type === FIND_TOMBSTONES) {
          return [emptyTombstone, trivialTombstone];
        }

        if (type === FIND_RUINS) {
          return [mineralOnlyRuin];
        }

        return type === FIND_SOURCES ? [source1, source2] : [];
      })
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('keeps nearby full containers ahead of other recoverable energy', () => {
    const droppedEnergy = { id: 'drop-best', resourceType: 'energy', amount: 300 } as Resource<ResourceConstant>;
    const container = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 75);
    const tombstone = makeSalvageEnergySource('tombstone-mid', 350);
    const ruin = makeSalvageEnergySource('ruin-far', 500);
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-near': 1,
        'drop-best': 2,
        'ruin-far': 8,
        'tombstone-mid': 4
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_RUINS) {
        return [ruin];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      if (type === FIND_TOMBSTONES) {
        return [tombstone];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('prefers nearby recoverable energy before farther dropped energy or durable storage', () => {
    const droppedEnergy = { id: 'drop-far', resourceType: 'energy', amount: 500 } as Resource<ResourceConstant>;
    const container = makeStoredEnergyStructure('container-far', 'container' as StructureConstant, 400);
    const tombstone = makeSalvageEnergySource('tombstone-near', 260);
    const ruin = makeSalvageEnergySource('ruin-near', 100);
    const source = { id: 'source1' } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-far': 8,
        'drop-far': 10,
        'ruin-near': 1,
        'tombstone-near': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      if (type === FIND_TOMBSTONES) {
        return [tombstone];
      }

      if (type === FIND_RUINS) {
        return [ruin];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'tombstone-near' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('skips dropped energy already covered by another worker once refill delivery is reserved', () => {
    const spawn = makeEnergySink('spawn-covered', 'spawn' as StructureConstant, 50);
    const coveredDroppedEnergy = {
      id: 'drop-covered',
      resourceType: 'energy',
      amount: 25
    } as Resource<ResourceConstant>;
    const openDroppedEnergy = {
      id: 'drop-open',
      resourceType: 'energy',
      amount: 25
    } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [coveredDroppedEnergy, openDroppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const room = { name: 'W1N1', find: roomFind } as unknown as Room;
    const refillCarrier = makeLoadedWorker(room, {
      type: 'transfer',
      targetId: 'spawn-covered' as Id<AnyStoreStructure>
    });
    const assignedPickupWorker = {
      name: 'AssignedPickupWorker',
      memory: { role: 'worker', task: { type: 'pickup', targetId: 'drop-covered' as Id<Resource> } },
      store: { getFreeCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-covered': 1,
        'drop-open': 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      name: 'Worker',
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ AssignedPickupWorker: assignedPickupWorker, RefillCarrier: refillCarrier, Worker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-open' });
  });

  it('scores stored energy by unreserved amount when another worker is already withdrawing', () => {
    const reservedContainer = makeStoredEnergyStructure('container-reserved', 'container' as StructureConstant, 120);
    const openContainer = makeStoredEnergyStructure('container-open', 'container' as StructureConstant, 75);
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [reservedContainer, openContainer];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const room = { name: 'W1N1', controller: { my: true }, find: roomFind } as unknown as Room;
    const assignedWithdrawWorker = {
      name: 'AssignedWithdrawWorker',
      memory: {
        role: 'worker',
        task: { type: 'withdraw', targetId: 'container-reserved' as Id<AnyStoreStructure> }
      },
      store: { getFreeCapacity: jest.fn().mockReturnValue(100) },
      room
    } as unknown as Creep;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-open': 1,
        'container-reserved': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      name: 'Worker',
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ AssignedWithdrawWorker: assignedWithdrawWorker, Worker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-open' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('uses stable amount and id fallback when range helpers are unavailable', () => {
    const droppedEnergy = { id: 'm-drop', resourceType: 'energy', amount: 100 } as Resource<ResourceConstant>;
    const container = makeStoredEnergyStructure('z-container', 'container' as StructureConstant, 100);
    const tombstone = makeSalvageEnergySource('a-tombstone', 100);
    const ruin = makeSalvageEnergySource('r-ruin', 100);
    const source = { id: 'source1' } as Source;
    const roomFind = jest.fn((type: number) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      if (type === FIND_STRUCTURES) {
        return [container];
      }

      if (type === FIND_TOMBSTONES) {
        return [tombstone];
      }

      if (type === FIND_RUINS) {
        return [ruin];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: { controller: { my: true }, find: roomFind }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'a-tombstone' });
    expect(roomFind).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('does not drain spawn, extension, hostile, or enemy-room structures for energy', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(200),
        getFreeCapacity: jest.fn().mockReturnValue(100)
      }
    } as unknown as StructureSpawn;
    const extension = {
      id: 'extension1',
      structureType: 'extension',
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(25),
        getFreeCapacity: jest.fn().mockReturnValue(25)
      }
    } as unknown as StructureExtension;
    const hostileStorage = makeStoredEnergyStructure('hostile-storage', 'storage' as StructureConstant, 1_000, {
      my: false
    });
    const unownedContainer = makeStoredEnergyStructure('unowned-container', 'container' as StructureConstant, 100);
    const source = { id: 'source1' } as Source;
    const room = {
      controller: { my: false, owner: { username: 'enemy' } },
      find: jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [spawn, extension, hostileStorage, unownedContainer];
        }

        return type === FIND_SOURCES ? [source] : [];
      })
    } as unknown as Room;
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('does not withdraw from containers in foreign-reserved or hostile rooms', () => {
    const source = { id: 'source1' } as Source;
    const hostileCreep = { id: 'hostile1' } as Creep;

    for (const room of [
      {
        controller: { my: false, reservation: { username: 'enemy' } },
        hostiles: []
      },
      {
        controller: { my: false },
        hostiles: [hostileCreep]
      }
    ]) {
      const container = makeStoredEnergyStructure('remote-container', 'container' as StructureConstant, 100);
      const roomFind = jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES || type === FIND_HOSTILE_STRUCTURES) {
          return [];
        }

        if (type === FIND_HOSTILE_CREEPS) {
          return room.hostiles;
        }

        if (type === FIND_STRUCTURES) {
          return [container];
        }

        return type === FIND_SOURCES ? [source] : [];
      });
      const creep = {
        owner: { username: 'me' },
        store: {
          getUsedCapacity: jest.fn().mockReturnValue(0),
          getFreeCapacity: jest.fn().mockReturnValue(50)
        },
        room: { controller: room.controller, find: roomFind }
      } as unknown as Creep;

      expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    }
  });

  it('falls back to balanced harvesting when stored energy is unavailable', () => {
    const emptyContainer = makeStoredEnergyStructure('container-empty', 'container' as StructureConstant, 0);
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      controller: { my: true },
      find: jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES) {
          return [];
        }

        if (type === FIND_STRUCTURES) {
          return [emptyContainer];
        }

        return type === FIND_SOURCES ? [source1, source2] : [];
      })
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('ignores non-energy and below-threshold dropped resources before falling back to balanced harvesting', () => {
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const droppedMineral = { id: 'drop-mineral', resourceType: 'H' as ResourceConstant, amount: 100 } as Resource<ResourceConstant>;
    const zeroEnergy = { id: 'drop-zero', resourceType: 'energy', amount: 0 } as Resource<ResourceConstant>;
    const trivialEnergy = { id: 'drop-trivial', resourceType: 'energy', amount: 24 } as Resource<ResourceConstant>;
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedMineral, zeroEnergy, trivialEnergy];
        }

        return type === FIND_SOURCES ? [source1, source2] : [];
      })
    } as unknown as Room;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        Assigned: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
          room
        } as unknown as Creep
      }
    };
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('selects the least-assigned harvest source while counting in-transit workers', () => {
    const source1 = { id: 'source1' } as Source;
    const source2 = { id: 'source2' } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([source1, source2])
    } as unknown as Room;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        Assigned: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
          room
        } as unknown as Creep,
        InTransit1: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source2' as Id<Source> } },
          room: { name: 'W2N2' } as Room
        } as unknown as Creep,
        InTransit2: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source2' as Id<Source> } },
          room: { name: 'W3N3' } as Room
        } as unknown as Creep,
        Miner: {
          memory: { role: 'miner', task: { type: 'harvest', targetId: 'source2' as Id<Source> } },
          room
        } as unknown as Creep,
        Partial: {
          memory: { role: 'worker', task: { type: 'harvest' } as CreepTaskMemory },
          room
        } as unknown as Creep
      }
    };
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('uses source access capacity before closeness when harvest assignments tie', () => {
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    const tightSource = makeSource('source-tight', 10, 10);
    const openSource = makeSource('source-open', 20, 20);
    const openHarvestTiles = new Set(['10,9', '19,20', '20,19', '21,20']);
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([tightSource, openSource])
    } as unknown as Room;
    const getRangeTo = jest.fn((target: Source) => (target.id === 'source-tight' ? 1 : 8));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        TightHarvester: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source-tight' as Id<Source> } },
          room
        } as unknown as Creep,
        OpenHarvester: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source-open' as Id<Source> } },
          room
        } as unknown as Creep
      },
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({
          get: jest.fn((x: number, y: number) => (openHarvestTiles.has(`${x},${y}`) ? 0 : TERRAIN_MASK_WALL))
        })
      } as unknown as GameMap
    };
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      pos: { getRangeTo },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-open' });
  });

  it('assigns a dedicated harvester to the nearest available source container despite a closer open source', () => {
    const openSource = makeSource('source-open', 5, 5);
    const nearSource = makeSource('source-near', 10, 10);
    const farSource = makeSource('source-far', 30, 30);
    const nearContainer = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(10, 11)
    });
    const farContainer = makeStoredEnergyStructure('container-far', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(30, 31)
    });
    const room = makeWorkerTaskRoom({
      controller: { id: 'controller1', my: true, level: 1 } as StructureController,
      sources: [openSource, nearSource, farSource],
      structures: [nearContainer, farContainer]
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) =>
          target.id === 'source-open' ? 1 : target.id === 'source-near' ? 5 : 12
        )
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({
      type: 'harvest',
      targetId: 'source-near',
      sourceContainerAssigned: true
    });
  });

  it('withdraws from a stocked source container before assigning a distant dedicated harvester', () => {
    const openSource = makeSource('source-open', 5, 5);
    const bufferedSource = makeSource('source-buffered', 30, 30);
    const bufferedContainer = makeStoredEnergyStructure('container-buffered', 'container' as StructureConstant, 200, {
      pos: makeRoomPosition(30, 31)
    });
    const room = makeWorkerTaskRoom({
      controller: { id: 'controller1', my: true, level: 1 } as StructureController,
      sources: [openSource, bufferedSource],
      structures: [bufferedContainer]
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => {
          const ranges: Record<string, number> = {
            'container-buffered': 5,
            'source-buffered': 12,
            'source-open': 1
          };
          return ranges[String(target.id)] ?? 99;
        })
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-buffered' });
  });

  it('skips depleted source containers when assigning dedicated harvesters', () => {
    const emptyContainerSource = makeSource('source-empty-container', 10, 10);
    const chargedContainerSource = makeSource('source-charged-container', 30, 30);
    const openSource = makeSource('source-open', 20, 20);
    const emptyContainer = makeStoredEnergyStructure('container-empty', 'container' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 11)
    });
    const chargedContainer = makeStoredEnergyStructure('container-charged', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(30, 31)
    });
    const room = makeWorkerTaskRoom({
      controller: { id: 'controller1', my: true, level: 1 } as StructureController,
      sources: [emptyContainerSource, chargedContainerSource, openSource],
      structures: [emptyContainer, chargedContainer]
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) =>
          target.id === 'source-empty-container' ? 1 : target.id === 'source-open' ? 2 : 12
        )
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({
      type: 'harvest',
      targetId: 'source-charged-container',
      sourceContainerAssigned: true
    });
  });

  it('does not assign a second harvester to a source container with a dedicated worker', () => {
    const assignedContainerSource = makeSource('source-assigned-container', 10, 10);
    const availableContainerSource = makeSource('source-available-container', 30, 30);
    const openSource = makeSource('source-open', 20, 20);
    const assignedContainer = makeStoredEnergyStructure('container-assigned', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(10, 11)
    });
    const availableContainer = makeStoredEnergyStructure('container-available', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(30, 31)
    });
    const room = makeWorkerTaskRoom({
      controller: { id: 'controller1', my: true, level: 1 } as StructureController,
      sources: [assignedContainerSource, availableContainerSource, openSource],
      structures: [assignedContainer, availableContainer]
    });
    setGameCreeps({
      DedicatedHarvester: {
        memory: {
          role: 'worker',
          task: {
            type: 'harvest',
            targetId: 'source-assigned-container' as Id<Source>,
            sourceContainerAssigned: true
          }
        },
        room
      } as unknown as Creep
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) =>
          target.id === 'source-assigned-container' ? 1 : target.id === 'source-open' ? 2 : 12
        )
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({
      type: 'harvest',
      targetId: 'source-available-container',
      sourceContainerAssigned: true
    });
  });

  it('waits for source-container hauling when every source already has a dedicated harvester', () => {
    const source1 = makeSource('source1', 10, 10);
    const source2 = makeSource('source2', 30, 30);
    const container1 = makeStoredEnergyStructure('container1', 'container' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 11)
    });
    const container2 = makeStoredEnergyStructure('container2', 'container' as StructureConstant, 0, {
      pos: makeRoomPosition(30, 31)
    });
    const room = makeWorkerTaskRoom({
      controller: { id: 'controller1', my: true, level: 1 } as StructureController,
      sources: [source1, source2],
      structures: [container1, container2]
    });
    setGameCreeps({
      Harvester1: {
        memory: {
          role: 'worker',
          task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
        },
        room
      } as unknown as Creep,
      Harvester2: {
        memory: {
          role: 'worker',
          task: { type: 'harvest', targetId: 'source2' as Id<Source>, sourceContainerAssigned: true }
        },
        room
      } as unknown as Creep
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('withdraws from source containers when every source container harvest slot is occupied', () => {
    const source1 = makeSource('source1', 10, 10);
    const source2 = makeSource('source2', 30, 30);
    const container1 = makeStoredEnergyStructure('container1', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(10, 11)
    });
    const container2 = makeStoredEnergyStructure('container2', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(30, 31)
    });
    const room = makeWorkerTaskRoom({
      controller: { id: 'controller1', my: true, level: 1 } as StructureController,
      sources: [source1, source2],
      structures: [container1, container2]
    });
    setGameCreeps({
      Harvester1: {
        memory: {
          role: 'worker',
          task: { type: 'harvest', targetId: 'source1' as Id<Source>, sourceContainerAssigned: true }
        },
        room
      } as unknown as Creep,
      Harvester2: {
        memory: {
          role: 'worker',
          task: { type: 'harvest', targetId: 'source2' as Id<Source>, sourceContainerAssigned: true }
        },
        room
      } as unknown as Creep
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container1' });
  });

  it('withdraws from a saturated local source container before traveling to an adjacent assignable source', () => {
    const localSource = makeSource('source-local', 10, 10, 'W1N1');
    const adjacentSource = makeSource('source-adjacent', 20, 20, 'W2N1');
    const localContainer = makeStoredEnergyStructure('container-local', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(10, 11, 'W1N1')
    });
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const homeRoom = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [localSource],
      structures: [localContainer]
    });
    const adjacentRoom = makeWorkerTaskRoom({
      controller: { id: 'controller2', my: true, level: 2 } as StructureController,
      name: 'W2N1',
      sources: [adjacentSource]
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        LocalHarvester: {
          memory: {
            role: 'worker',
            task: { type: 'harvest', targetId: 'source-local' as Id<Source>, sourceContainerAssigned: true }
          },
          room: homeRoom
        } as unknown as Creep
      },
      map: { describeExits: jest.fn().mockReturnValue({ '3': 'W2N1' }) } as unknown as GameMap,
      rooms: { W1N1: homeRoom, W2N1: adjacentRoom }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room: homeRoom
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-local' });
  });

  it('does not treat an ordinary source assignment as an occupied source-container harvest slot', () => {
    const source = makeSource('source1', 10, 10);
    const container = makeStoredEnergyStructure('container1', 'container' as StructureConstant, 100, {
      pos: makeRoomPosition(10, 11)
    });
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const room = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [source],
      structures: [container]
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        OpenTileHarvester: {
          memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
          room
        } as unknown as Creep
      },
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({
          get: jest.fn().mockReturnValue(0)
        })
      } as unknown as GameMap,
      rooms: { W1N1: room }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('avoids depleted harvest sources when another source has energy', () => {
    const depletedSource = { id: 'source-empty', energy: 0 } as Source;
    const viableSource = { id: 'source-full', energy: 300 } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([depletedSource, viableSource])
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source-full' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-full' });
  });

  it('selects the closer harvest source when viable source assignments tie', () => {
    const source2 = { id: 'source2', energy: 100 } as Source;
    const source1 = { id: 'source1', energy: 100 } as Source;
    const getRangeTo = jest.fn((target: Source) => (target.id === 'source1' ? 2 : 9));
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      pos: { getRangeTo },
      room: { name: 'W1N1', find: jest.fn().mockReturnValue([source2, source1]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('selects an adjacent claimed-room source when it is closer than home sources', () => {
    const homeSource = makeSource('source-home', 40, 40, 'W1N1');
    const adjacentSource = makeSource('source-adjacent', 2, 25, 'W2N1');
    const homeRoom = makeWorkerTaskRoom({ sources: [homeSource] });
    const adjacentRoom = makeWorkerTaskRoom({
      controller: { id: 'controller2', my: true, level: 2 } as StructureController,
      name: 'W2N1',
      sources: [adjacentSource]
    });
    const getRangeTo = jest.fn((target: Source) => (target.id === 'source-adjacent' ? 2 : 15));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      map: { describeExits: jest.fn().mockReturnValue({ '3': 'W2N1' }) } as unknown as GameMap,
      rooms: { W1N1: homeRoom, W2N1: adjacentRoom }
    };
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      pos: { getRangeTo },
      room: homeRoom
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-adjacent' });
  });

  it('keeps harvest source selection road-cost-aware when range favors a slower source', () => {
    const nearPlainSource = makeSource('source-near-plain', 12, 10);
    const farRoadSource = makeSource('source-far-road', 30, 10);
    const road = makeStructure('road1', 'road' as StructureConstant, 5_000, 5_000, {
      pos: makeRoomPosition(20, 10)
    });
    const spawn = makeStructure('spawn1', 'spawn' as StructureConstant, 5_000, 5_000, {
      pos: makeRoomPosition(21, 10)
    });
    const hostileRampart = makeStructure('rampart-hostile', 'rampart' as StructureConstant, 5_000, 5_000, {
      my: false,
      pos: makeRoomPosition(22, 10)
    });
    const tower = makeStructure('tower1', 'tower' as StructureConstant, 3_000, 3_000, {
      pos: makeRoomPosition(23, 10)
    });
    const container = makeStructure('container1', 'container' as StructureConstant, 250_000, 250_000, {
      pos: makeRoomPosition(24, 10)
    });
    const ownedRampart = makeStructure('rampart-owned', 'rampart' as StructureConstant, 5_000, 5_000, {
      my: true,
      pos: makeRoomPosition(25, 10)
    });
    const room = makeWorkerTaskRoom({
      sources: [nearPlainSource, farRoadSource],
      structures: [road, spawn, hostileRampart, tower, container, ownedRampart]
    });
    const matrixSets: Array<[number, number, number]> = [];
    const pathFinderSearch = jest.fn((_origin: RoomPosition, goal: { pos: RoomPosition }, options?: PathFinderOpts) => {
      options?.roomCallback?.('W1N1');
      return {
      cost: goal.pos.x === 30 ? 4 : 20,
      incomplete: false,
      path: []
      };
    });
    class TestCostMatrix {
      set(x: number, y: number, cost: number): void {
        matrixSets.push([x, y, cost]);
      }
    }
    (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
      CostMatrix: TestCostMatrix as unknown as CostMatrix,
      search: pathFinderSearch as unknown as PathFinder['search']
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      rooms: { W1N1: room }
    };
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      pos: makeRoomPosition(10, 10),
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-far-road' });
    expect(pathFinderSearch).toHaveBeenCalled();
    expect(matrixSets).toEqual(expect.arrayContaining([[20, 10, 1], [21, 10, 255], [22, 10, 255], [23, 10, 255]]));
    expect(matrixSets).not.toContainEqual([24, 10, 255]);
    expect(matrixSets).not.toContainEqual([25, 10, 255]);
  });

  it('does not use range fallback for unreachable road-aware harvest paths', () => {
    const blockedSource = makeSource('source-blocked', 11, 10);
    const reachableSource = makeSource('source-reachable', 30, 10);
    const spawn = makeEnergySinkWithEnergy('spawn1', 'spawn' as StructureConstant, 0, 300, {
      pos: makeRoomPosition(10, 10)
    });
    const room = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [blockedSource, reachableSource]
    });
    const pathFinderSearch = jest.fn((_origin: RoomPosition, goal: { pos: RoomPosition }) => ({
      cost: goal.pos.x === 30 ? 20 : 5,
      incomplete: goal.pos.x === 11,
      path: []
    }));
    class TestCostMatrix {
      set(_x: number, _y: number, _cost: number): void {}
    }
    (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
      CostMatrix: TestCostMatrix as unknown as CostMatrix,
      search: pathFinderSearch as unknown as PathFinder['search']
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      rooms: { W1N1: room }
    };
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: makeRoomPosition(10, 10),
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-reachable' });
  });

  it('excludes unreachable road-aware harvest sources from ordinary selection', () => {
    const blockedSource = makeSource('source-blocked', 11, 10);
    const reachableSource = makeSource('source-reachable', 30, 10);
    const room = makeWorkerTaskRoom({
      sources: [blockedSource, reachableSource]
    });
    const pathFinderSearch = jest.fn((_origin: RoomPosition, goal: { pos: RoomPosition }) => ({
      cost: goal.pos.x === 30 ? 20 : 5,
      incomplete: goal.pos.x === 11,
      path: []
    }));
    class TestCostMatrix {
      set(_x: number, _y: number, _cost: number): void {}
    }
    (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
      CostMatrix: TestCostMatrix as unknown as CostMatrix,
      search: pathFinderSearch as unknown as PathFinder['search']
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      rooms: { W1N1: room }
    };
    const creep = {
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: makeRoomPosition(10, 10),
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-reachable' });
  });

  it('ignores adjacent sources in rooms that are not claimed', () => {
    const homeSource = makeSource('source-home', 40, 40, 'W1N1');
    const neutralSource = makeSource('source-neutral', 2, 25, 'W2N1');
    const homeRoom = makeWorkerTaskRoom({ sources: [homeSource] });
    const neutralRoom = makeWorkerTaskRoom({
      controller: { id: 'controller2', my: false, level: 0 } as StructureController,
      name: 'W2N1',
      sources: [neutralSource]
    });
    const getRangeTo = jest.fn((target: Source) => (target.id === 'source-neutral' ? 2 : 15));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      map: { describeExits: jest.fn().mockReturnValue({ '3': 'W2N1' }) } as unknown as GameMap,
      rooms: { W1N1: homeRoom, W2N1: neutralRoom }
    };
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      pos: { getRangeTo },
      room: homeRoom
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-home' });
  });

  it('stands by deterministically when all sources are empty', () => {
    const source1 = { id: 'source1', energy: 0 } as Source;
    const source2 = { id: 'source2', energy: 0 } as Source;
    const room = {
      name: 'W1N1',
      find: jest.fn().mockReturnValue([source1, source2])
    } as unknown as Room;
    setGameCreeps({
      Assigned: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
        room
      } as unknown as Creep
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('keeps room.find source order as the stable fallback when source energy is unknown', () => {
    const source2 = { id: 'source2' } as Source;
    const source1 = { id: 'source1' } as Source;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { name: 'W1N1', find: jest.fn().mockReturnValue([source2, source1]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('selects no task when worker has no energy and no sources', () => {
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(0) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toBeNull();
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1'],
    ['tower', 'tower1']
  ])('selects transfer when worker has energy and %s needs energy', (structureType, id) => {
    const energySink = {
      id,
      structureType,
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as TestEnergySink;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn((type) => (type === 3 ? [energySink] : [])) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: id });
  });

  it('clears stale worker efficiency telemetry when selecting a normal refill task', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const creep = {
      memory: {
        role: 'worker',
        workerEfficiency: {
          type: 'nearbyEnergyChoice',
          tick: 300,
          carriedEnergy: 10,
          freeCapacity: 40,
          selectedTask: 'pickup',
          targetId: 'drop-stale',
          energy: 50,
          range: 1
        }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(100),
        getFreeCapacity: jest.fn().mockReturnValue(100)
      },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: jest.fn((type) => (type === FIND_MY_STRUCTURES ? [spawn] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toBeUndefined();
  });

  it('keeps a low-load worker on nearby dropped energy without pathing to distant drops', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const farDroppedEnergy = { id: 'drop-far', resourceType: 'energy', amount: 500 } as Resource<ResourceConstant>;
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-far': 10,
        'drop-near': 1,
        source1: 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const findPathTo = jest.fn().mockReturnValue([]);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [farDroppedEnergy, droppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo, findPathTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 321 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 321,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'pickup',
      targetId: 'drop-near',
      energy: 50,
      range: 1
    });
    expect(findPathTo).not.toHaveBeenCalled();
  });

  it('keeps a low-load worker harvesting instead of making a non-urgent primary refill trip', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const source = { id: 'source1', energy: 300 } as Source;
    const capacity = 50;
    const carriedEnergy = Math.ceil(capacity * MINIMUM_USEFUL_LOAD_RATIO) - 1;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: 6,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getCapacity: jest.fn().mockReturnValue(capacity),
        getUsedCapacity: jest.fn().mockReturnValue(carriedEnergy),
        getFreeCapacity: jest.fn().mockReturnValue(capacity - carriedEnergy)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 327 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 327,
      carriedEnergy,
      freeCapacity: capacity - carriedEnergy,
      selectedTask: 'harvest',
      targetId: 'source1',
      energy: 300,
      range: 6
    });
  });

  it('lets a worker at the minimum useful load proceed with normal refill', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const source = { id: 'source1', energy: 300 } as Source;
    const capacity = 50;
    const carriedEnergy = Math.ceil(capacity * MINIMUM_USEFUL_LOAD_RATIO);
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: 1,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getCapacity: jest.fn().mockReturnValue(capacity),
        getUsedCapacity: jest.fn().mockReturnValue(carriedEnergy),
        getFreeCapacity: jest.fn().mockReturnValue(capacity - carriedEnergy)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toBeUndefined();
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1']
  ])('keeps %s refill worker acquiring energy until the minimum useful load during spawn recovery', (structureType, id) => {
    const energySink = makeEnergySink(id, structureType as StructureConstant, 300);
    const lowEnergySource = makeSource('source-low', 8, 8, 10);
    const loadReadySource = makeSource('source-ready', 20, 20, 300);
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        [id]: 2,
        'source-low': 1,
        'source-ready': LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
      };
      return ranges[String(target.id)] ?? 99;
    });
    const room = makeWorkerTaskRoom({
      energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
      energyCapacityAvailable: 400,
      myStructures: [energySink as AnyOwnedStructure],
      sources: [lowEnergySource, loadReadySource]
    });
    const creep = {
      name: 'RecoveryCarrier',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ RecoveryCarrier: creep });
    recordSurvivalMode('LOCAL_STABLE', 333);

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-ready' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 333,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'harvest',
      targetId: 'source-ready',
      energy: 300,
      range: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
    });
  });

  it('returns early for urgent refill when the only visible source is depleted', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const depletedSource = makeSource('source-empty', 8, 8, 0);
    const carriedEnergy = 2;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'source-empty': 1,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const room = makeWorkerTaskRoom({
      energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      energyCapacityAvailable: 400,
      myStructures: [spawn as AnyOwnedStructure],
      sources: [depletedSource]
    });
    const creep = {
      name: 'RecoveryCarrier',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(carriedEnergy),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ RecoveryCarrier: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'lowLoadReturn',
      tick: 0,
      carriedEnergy,
      freeCapacity: 48,
      selectedTask: 'transfer',
      targetId: 'spawn1',
      reason: 'emergencySpawnExtensionRefill'
    });
  });

  it('records refill delivery ticks and delivered energy in runtime summary telemetry', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300, {
      name: 'Spawn1'
    }) as StructureSpawn;
    const room = makeWorkerTaskRoom({
      energyAvailable: 100,
      energyCapacityAvailable: 300,
      myStructures: [spawn as AnyOwnedStructure],
      structures: [spawn]
    });
    const worker = {
      id: 'worker1',
      name: 'RefillWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> },
        refillTelemetry: {
          current: {
            targetId: 'spawn1',
            startedAt: RUNTIME_SUMMARY_INTERVAL - 2,
            activeTicks: 2,
            idleOrOtherTaskTicks: 1
          },
          refillActiveTicks: 2,
          idleOrOtherTaskTicks: 1,
          lastUpdatedAt: RUNTIME_SUMMARY_INTERVAL - 1
        }
      },
      store: { getUsedCapacity: jest.fn().mockReturnValue(15) }
    } as unknown as Creep;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 100,
      energyCapacityAvailable: 300
    };
    (room as unknown as { getEventLog: jest.Mock }).getEventLog = jest.fn(() => [
      {
        event: 10,
        objectId: 'worker1',
        data: { targetId: 'spawn1', amount: 15, resourceType: RESOURCE_ENERGY }
      }
    ]);
    (globalThis as unknown as { EVENT_TRANSFER: number }).EVENT_TRANSFER = 10;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { RefillWorker: worker },
      rooms: { W1N1: room },
      spawns: { Spawn1: spawn },
      time: RUNTIME_SUMMARY_INTERVAL
    };
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    try {
      emitRuntimeSummary([colony], [worker], [], { persistOccupationRecommendations: false });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const [message] = logSpy.mock.calls[0];
      expect(typeof message).toBe('string');
      const payload = JSON.parse((message as string).slice(RUNTIME_SUMMARY_PREFIX.length)) as {
        rooms: Array<Record<string, unknown>>;
      };
      const [roomSummary] = payload.rooms;
      expect((roomSummary.resources as Record<string, Record<string, number>>).events.refillEnergyDelivered).toBe(15);
      expect(roomSummary.refillDeliveryTicks).toEqual({
        completedCount: 1,
        averageTicks: 3,
        maxTicks: 3,
        samples: [
          {
            creepName: 'RefillWorker',
            tick: RUNTIME_SUMMARY_INTERVAL,
            targetId: 'spawn1',
            deliveryTicks: 3,
            activeTicks: 3,
            idleOrOtherTaskTicks: 1,
            energyDelivered: 15
          }
        ]
      });
      expect(roomSummary.refillWorkerUtilization).toEqual({
        assignedWorkerCount: 1,
        refillActiveTicks: 3,
        idleOrOtherTaskTicks: 1,
        ratio: 0.75,
        workers: [
          {
            creepName: 'RefillWorker',
            refillActiveTicks: 3,
            idleOrOtherTaskTicks: 1,
            ratio: 0.75
          }
        ]
      });
    } finally {
      logSpy.mockRestore();
      delete (globalThis as unknown as { EVENT_TRANSFER?: number }).EVENT_TRANSFER;
    }
  });

  it('keeps the load-ready harvest preference during spawn recovery when no refill target exists', () => {
    const lowEnergySource = makeSource('source-low', 8, 8, 10);
    const loadReadySource = makeSource('source-ready', 20, 20, 300);
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'source-low': 1,
        'source-ready': LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
      };
      return ranges[String(target.id)] ?? 99;
    });
    const room = makeWorkerTaskRoom({
      energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
      energyCapacityAvailable: 400,
      sources: [lowEnergySource, loadReadySource]
    });
    const creep = {
      name: 'RecoveryCarrier',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ RecoveryCarrier: creep });
    recordSurvivalMode('LOCAL_STABLE', 334);

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-ready' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 334,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'harvest',
      targetId: 'source-ready',
      energy: 300,
      range: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
    });
  });

  it('withdraws energy from storage when spawn throughput is bottlenecked and storage is above reserve', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 1_500, { my: true });
    const room = makeWorkerTaskRoom({
      controller: {
        id: 'controller1' as Id<StructureController>,
        my: false
      } as StructureController,
      energyAvailable: 250,
      energyCapacityAvailable: 500,
      myStructures: [spawn as AnyOwnedStructure],
      structures: [storage]
    });
    const creep = {
      name: 'TestStorageWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(30)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage1' });
  });

  it('withdraws below the storage reserve when spawn throughput refill needs energy', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 320, { my: true });
    const room = makeWorkerTaskRoom({
      controller: {
        id: 'controller1' as Id<StructureController>,
        my: false
      } as StructureController,
      energyAvailable: 100,
      energyCapacityAvailable: 500,
      myStructures: [spawn as AnyOwnedStructure],
      structures: [storage]
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(30)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage1' });
  });

  it('uses unreserved storage energy for spawn throughput refill even below the reserve floor', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 620, { my: true });
    const room = makeWorkerTaskRoom({
      controller: {
        id: 'controller1' as Id<StructureController>,
        my: false
      } as StructureController,
      energyAvailable: 250,
      energyCapacityAvailable: 500,
      myStructures: [spawn as AnyOwnedStructure],
      structures: [storage]
    });
    const reservedWorker = {
      name: 'ReservedWorker',
      memory: { role: 'worker', task: { type: 'withdraw', targetId: 'storage1' } },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(30),
        getFreeCapacity: jest.fn().mockReturnValue(300)
      },
      room
    } as unknown as Creep;
    const creep = {
      name: 'TestStorageWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(30)
      },
      room
    } as unknown as Creep;

    setGameCreeps({
      ReservedWorker: reservedWorker,
      TestStorageWorker: creep
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage1' });
  });

  it('skips storage-to-spawn refill when spawn and extensions are full', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 0);
    const extension = makeEnergySink('extension1', 'extension' as StructureConstant, 0);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 2_000, { my: true });
    const room = makeWorkerTaskRoom({
      controller: {
        id: 'controller1' as Id<StructureController>,
        my: false
      } as StructureController,
      energyAvailable: 500,
      energyCapacityAvailable: 500,
      myStructures: [spawn as AnyOwnedStructure, extension as AnyOwnedStructure, storage as AnyOwnedStructure],
      structures: [storage]
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(30)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage1' });
  });

  it('returns storage withdrawal before direct harvest when spawn recovery requires storage fill', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storage = makeStoredEnergyStructure('storage1', 'storage' as StructureConstant, 2_000, { my: true });
    const source = makeSource('source1', 20, 20, 300);
    const room = makeWorkerTaskRoom({
      controller: {
        id: 'controller1' as Id<StructureController>,
        my: false
      } as StructureController,
      energyAvailable: 320,
      energyCapacityAvailable: 500,
      myStructures: [spawn as AnyOwnedStructure],
      structures: [storage],
      sources: [source]
    });
    const creep = {
      name: 'TestStorageWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(20),
        getFreeCapacity: jest.fn().mockReturnValue(30)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('reserves carried energy for near-term spawn refill instead of harvesting when no free sink exists', () => {
    const spawningSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const source = makeSource('source1', 20, 20, 300);
    const room = makeWorkerTaskRoom({
      controller: {
        id: 'controller1' as Id<StructureController>,
        my: false
      } as StructureController,
      energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD + 100,
      energyCapacityAvailable: 500,
      myStructures: [spawningSpawn as AnyOwnedStructure],
      sources: [source]
    });
    const creep = {
      name: 'TestStorageWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(20),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      body: [{ type: 'work', hits: 100 }],
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('returns to refill instead of taking a far low-load harvest detour', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE + 1,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 329 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'lowLoadReturn',
      tick: 329,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'transfer',
      targetId: 'spawn1',
      reason: 'noReachableEnergy'
    });
  });

  it('continues with close dropped energy outside the nearby-only range before farther harvest', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = { id: 'drop-mid', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-mid': LOW_LOAD_NEARBY_ENERGY_RANGE + 1,
        source1: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const findPathTo = jest.fn((target: { id: string }) => (target.id === 'drop-mid' ? [{ x: 1, y: 1 }] : []));
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo, findPathTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 330 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-mid' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 330,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'pickup',
      targetId: 'drop-mid',
      energy: 50,
      range: LOW_LOAD_NEARBY_ENERGY_RANGE + 1
    });
    expect(findPathTo).toHaveBeenCalledWith(droppedEnergy, { ignoreCreeps: true });
  });

  it('continues harvesting before durable stored energy outside the nearby-only range', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const storedEnergy = makeStoredEnergyStructure('storage-mid', 'storage' as StructureConstant, 50, { my: true });
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'storage-mid': LOW_LOAD_NEARBY_ENERGY_RANGE + 1,
        source1: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [storedEnergy];
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 331 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 331,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'harvest',
      targetId: 'source1',
      energy: 300,
      range: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
    });
  });

  it('continues with close salvage energy outside the nearby-only range before farther harvest', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const salvageEnergy = makeSalvageEnergySource('tombstone-mid', 50);
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE,
        'tombstone-mid': LOW_LOAD_NEARBY_ENERGY_RANGE + 1,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_TOMBSTONES) {
          return [salvageEnergy];
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 332 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'tombstone-mid' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 332,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'withdraw',
      targetId: 'tombstone-mid',
      energy: 50,
      range: LOW_LOAD_NEARBY_ENERGY_RANGE + 1
    });
  });

  it('ignores unreachable nearby dropped energy for low-load workers', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const blockedDroppedEnergy = {
      id: 'drop-blocked',
      resourceType: 'energy',
      amount: 500
    } as Resource<ResourceConstant>;
    const getRangeTo = jest.fn((target: { id: string }) => (target.id === 'drop-blocked' ? 2 : 99));
    const findPathTo = jest.fn().mockReturnValue([]);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [blockedDroppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo, findPathTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 324 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'lowLoadReturn',
      tick: 324,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'transfer',
      targetId: 'spawn1',
      reason: 'noReachableEnergy'
    });
    expect(findPathTo).toHaveBeenCalledWith(blockedDroppedEnergy, { ignoreCreeps: true });
  });

  it('returns to refill instead of low-load harvesting without active work parts', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => (target.id === 'source1' ? 1 : 99));
    const getActiveBodyparts = jest.fn().mockReturnValue(0);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      getActiveBodyparts,
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 326 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'lowLoadReturn',
      tick: 326,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'transfer',
      targetId: 'spawn1',
      reason: 'noReachableEnergy'
    });
    expect(getActiveBodyparts).toHaveBeenCalledWith('work');
  });

  it('keeps reachable nearby dropped energy selectable for low-load workers', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const farDroppedEnergy = { id: 'drop-far', resourceType: 'energy', amount: 500 } as Resource<ResourceConstant>;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'drop-far': 10,
        'drop-near': 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const findPathTo = jest.fn((target: { id: string }) => (target.id === 'drop-near' ? [{ x: 1, y: 1 }] : []));
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [farDroppedEnergy, droppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo, findPathTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 325 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 325,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'pickup',
      targetId: 'drop-near',
      energy: 50,
      range: 2
    });
    expect(findPathTo).toHaveBeenCalledTimes(1);
    expect(findPathTo).toHaveBeenCalledWith(droppedEnergy, { ignoreCreeps: true });
    expect(findPathTo).not.toHaveBeenCalledWith(farDroppedEnergy, { ignoreCreeps: true });
  });

  it('keeps a low-load worker on nearby container energy', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const container = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 80);
    const farDroppedEnergy = { id: 'drop-far', resourceType: 'energy', amount: 500 } as Resource<ResourceConstant>;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        'container-near': 2,
        'drop-far': 10
      };
      return ranges[String(target.id)] ?? 99;
    });
    const findPathTo = jest.fn().mockReturnValue([]);
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_STRUCTURES) {
          return [container];
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [farDroppedEnergy];
        }

        if (
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo, findPathTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 323 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 323,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'withdraw',
      targetId: 'container-near',
      energy: 80,
      range: 2
    });
    expect(findPathTo).not.toHaveBeenCalled();
  });

  it('lets emergency spawn refill preempt the minimum useful load requirement', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const getRangeTo = jest.fn((target: { id: string }) => (target.id === 'drop-near' ? 1 : 99));
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        if (
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo },
      room: {
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 322 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'lowLoadReturn',
      tick: 322,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'transfer',
      targetId: 'spawn1',
      reason: 'emergencySpawnExtensionRefill'
    });
  });

  it('lets controller downgrade guard preempt the minimum useful load requirement', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 8,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        controller1: 2,
        source1: 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const room = makeWorkerTaskRoom({
      controller,
      sources: [source]
    });
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 335 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'lowLoadReturn',
      tick: 335,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'upgrade',
      targetId: 'controller1',
      reason: 'controllerDowngradeGuard'
    });
  });

  it('lets hostile safety conditions preempt the minimum useful load requirement', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const source = { id: 'source1', energy: 300 } as Source;
    const hostile = { id: 'hostile1' } as Creep;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: 1,
        spawn1: 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const room = makeWorkerTaskRoom({
      energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
      hostileCreeps: [hostile],
      myStructures: [spawn as AnyOwnedStructure],
      sources: [source]
    });
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(10),
        getFreeCapacity: jest.fn().mockReturnValue(40)
      },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 336 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'lowLoadReturn',
      tick: 336,
      carriedEnergy: 10,
      freeCapacity: 40,
      selectedTask: 'transfer',
      targetId: 'spawn1',
      reason: 'hostileSafety'
    });
  });

  it('keeps low-load workers acquiring before non-emergency tower refill', () => {
    const lowTower = makeTowerEnergySink('tower-low', TOWER_REFILL_ENERGY_FLOOR - 1, 501);
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        source1: 1,
        'tower-low': 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn(
      (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [lowTower];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (
          type === FIND_DROPPED_RESOURCES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_TOMBSTONES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        return type === FIND_SOURCES ? [source] : [];
      }
    );
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        myStructures: [lowTower as AnyOwnedStructure],
        sources: [source]
      })
    } as unknown as Creep;
    creep.room.find = roomFind as unknown as Room['find'];

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('keeps a low-load worker harvesting instead of making a normal controller upgrade trip', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const source = { id: 'source1', energy: 300 } as Source;
    const getRangeTo = jest.fn((target: { id: string }) => {
      const ranges: Record<string, number> = {
        controller1: 2,
        source1: 6
      };
      return ranges[String(target.id)] ?? 99;
    });
    const roomFind = jest.fn((type: number) => {
      if (
        type === FIND_DROPPED_RESOURCES ||
        type === FIND_STRUCTURES ||
        type === FIND_MY_STRUCTURES ||
        type === FIND_CONSTRUCTION_SITES ||
        type === FIND_HOSTILE_CREEPS ||
        type === FIND_HOSTILE_STRUCTURES ||
        type === FIND_TOMBSTONES ||
        type === FIND_RUINS
      ) {
        return [];
      }

      return type === FIND_SOURCES ? [source] : [];
    });
    const creep = {
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(2),
        getFreeCapacity: jest.fn().mockReturnValue(48)
      },
      pos: { getRangeTo },
      room: {
        controller,
        find: roomFind
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 328 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
    expect(creep.memory.workerEfficiency).toEqual({
      type: 'nearbyEnergyChoice',
      tick: 328,
      carriedEnergy: 2,
      freeCapacity: 48,
      selectedTask: 'harvest',
      targetId: 'source1',
      energy: 300,
      range: 6
    });
  });

  it('selects a low-energy spawn before closer extension and tower refills', () => {
    const farSpawn = makeEnergySinkWithEnergy('spawn-far', 'spawn' as StructureConstant, 0, 300);
    const fullExtension = makeEnergySink('extension-full', 'extension' as StructureConstant, 0);
    const nearExtension = makeEnergySink('extension-near', 'extension' as StructureConstant, 50);
    const nearTower = makeEnergySink('tower-near', 'tower' as StructureConstant, 500);
    const structures = [farSpawn, fullExtension, nearTower, nearExtension];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-full': 1,
        'extension-near': 2,
        'tower-near': 1,
        'spawn-far': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-far' });
    expect(getRangeTo).not.toHaveBeenCalledWith(fullExtension);
    expect(getRangeTo).not.toHaveBeenCalledWith(nearTower);
  });

  it('records critical spawn refill telemetry when a critical spawn beats a closer extension', () => {
    const criticalSpawn = makeEnergySinkWithEnergy(
      'spawn-critical',
      'spawn' as StructureConstant,
      CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      101
    );
    const closerExtension = makeEnergySink('extension-closer', 'extension' as StructureConstant, 200);
    const structures = [closerExtension, criticalSpawn];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-closer': 1,
        'spawn-critical': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 346 };

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-critical' });
    expect(creep.memory.spawnCriticalRefill).toEqual({
      type: 'spawnCriticalRefill',
      tick: 346,
      targetId: 'spawn-critical',
      carriedEnergy: 50,
      spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      freeCapacity: 101,
      threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
    });
  });

  it('preserves non-critical spawn refill behavior without critical telemetry', () => {
    const nonCriticalSpawn = makeEnergySinkWithEnergy(
      'spawn-non-critical',
      'spawn' as StructureConstant,
      CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
      100
    );
    const closerExtension = makeEnergySink('extension-closer', 'extension' as StructureConstant, 200);
    const structures = [closerExtension, nonCriticalSpawn];
    const creep = {
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'extension-closer' ? 1 : 8))
      },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-non-critical' });
    expect(creep.memory.spawnCriticalRefill).toBeUndefined();
  });

  it('selects the closest low-energy spawn before extensions', () => {
    const farSpawn = makeEnergySinkWithEnergy('spawn-far', 'spawn' as StructureConstant, 0, 300);
    const nearSpawn = makeEnergySinkWithEnergy('spawn-near', 'spawn' as StructureConstant, 200, 100);
    const closerExtension = makeEnergySink('extension-closer', 'extension' as StructureConstant, 50);
    const structures = [farSpawn, closerExtension, nearSpawn];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-closer': 1,
        'spawn-far': 8,
        'spawn-near': 3
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-near' });
  });

  it('resumes extension refill once the spawn has full spawn energy stored', () => {
    const fullSpawn = makeEnergySinkWithEnergy('spawn-full', 'spawn' as StructureConstant, 300, 0);
    const extension = makeEnergySink('extension-open', 'extension' as StructureConstant, 50);
    const structures = [fullSpawn, extension];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-open': 1,
        'spawn-full': 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-open' });
  });

  it('prefers a recovery sink that can accept the full carried load over a closer partial top-off', () => {
    const recoverySpawn = makeEnergySink('spawn-recovery', 'spawn' as StructureConstant, 300);
    const partialExtension = makeEnergySink('extension-partial', 'extension' as StructureConstant, 10);
    const structures = [partialExtension, recoverySpawn];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-partial': 1,
        'spawn-recovery': 5
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(100) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-recovery' });
  });

  it('builds loaded worker energy sink reservations once while screening primary energy sinks', () => {
    const spawn = makeEnergySink('spawn-a', 'spawn' as StructureConstant, 300);
    const extension = makeEnergySink('extension-b', 'extension' as StructureConstant, 50);
    const structures = [spawn, extension];
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
        if (type !== FIND_MY_STRUCTURES) {
          return [];
        }

        return options?.filter ? structures.filter(options.filter) : structures;
      })
    } as unknown as Room;
    const workerEnergy = jest.fn().mockReturnValue(50);
    const assignedWorkerMemory = { role: 'worker' } as CreepMemory;
    const assignedWorkerTask = jest.fn().mockReturnValue({
      type: 'transfer',
      targetId: 'extension-b' as Id<AnyStoreStructure>
    });
    Object.defineProperty(assignedWorkerMemory, 'task', { get: assignedWorkerTask });
    const assignedWorker = {
      name: 'AssignedWorker',
      memory: assignedWorkerMemory,
      store: { getUsedCapacity: workerEnergy },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Carrier',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-a' ? 1 : 2))
      },
      room
    } as unknown as Creep;
    setGameCreeps({ AssignedWorker: assignedWorker });

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-a' });
    expect(assignedWorkerTask).toHaveBeenCalledTimes(1);
    expect(workerEnergy).toHaveBeenCalledTimes(2);
  });

  it('skips primary energy sinks already covered by other loaded workers', () => {
    const coveredSpawn = makeEnergySink('spawn-covered', 'spawn' as StructureConstant, 50);
    const openExtension = makeEnergySink('extension-open', 'extension' as StructureConstant, 50);
    const structures = [coveredSpawn, openExtension];
    const room = {
      name: 'W1N1',
      find: jest.fn(
        (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type !== FIND_MY_STRUCTURES) {
            return [];
          }

          return options?.filter ? structures.filter(options.filter) : structures;
        }
      )
    } as unknown as Room;
    const assignedCarrier = {
      name: 'Carrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-covered' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'extension-open': 8,
        'spawn-covered': 1
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      name: 'Worker',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ Carrier: assignedCarrier, Worker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-open' });
  });

  it('uses a closer worker for a covered primary refill when every primary sink is reserved', () => {
    const coveredSpawn = makeEnergySink('spawn-covered', 'spawn' as StructureConstant, 50);
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const structures = [coveredSpawn];
    const room = {
      name: 'W1N1',
      find: jest.fn(
        (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === FIND_CONSTRUCTION_SITES ? [site] : [];
        }
      )
    } as unknown as Room;
    const distantCarrier = {
      name: 'DistantCarrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-covered' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-covered' ? 8 : 99)) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'CloseCarrier',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-covered' ? 1 : 99)) },
      room
    } as unknown as Creep;
    setGameCreeps({ DistantCarrier: distantCarrier, CloseCarrier: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-covered' });
  });

  it('keeps productive fallback when a covered primary refill is already closest to its carrier', () => {
    const coveredSpawn = makeEnergySink('spawn-covered', 'spawn' as StructureConstant, 50);
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const structures = [coveredSpawn];
    const room = {
      name: 'W1N1',
      find: jest.fn(
        (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === FIND_CONSTRUCTION_SITES ? [site] : [];
        }
      )
    } as unknown as Room;
    const closeCarrier = {
      name: 'CloseCarrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-covered' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-covered' ? 1 : 99)) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-covered' ? 8 : 99)) },
      room
    } as unknown as Creep;
    setGameCreeps({ CloseCarrier: closeCarrier, Builder: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('skips an assigned primary sink when other workers cover its remaining capacity', () => {
    const spawn = makeEnergySink('spawn-covered', 'spawn' as StructureConstant, 50);
    const extension = makeEnergySink('extension-open', 'extension' as StructureConstant, 50);
    const structures = [spawn, extension];
    const room = {
      name: 'W1N1',
      find: jest.fn(
        (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type !== FIND_MY_STRUCTURES) {
            return [];
          }

          return options?.filter ? structures.filter(options.filter) : structures;
        }
      )
    } as unknown as Room;
    const otherCarrier = {
      name: 'OtherCarrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-covered' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Carrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-covered' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-covered' ? 1 : 8))
      },
      room
    } as unknown as Creep;
    setGameCreeps({ Carrier: creep, OtherCarrier: otherCarrier });

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-open' });
  });

  it('keeps low-energy spawn refill ahead of larger extension refill capacity', () => {
    const spawn = makeEnergySinkWithEnergy('spawn-assigned', 'spawn' as StructureConstant, 240, 60);
    const extension = makeEnergySink('extension-open', 'extension' as StructureConstant, 50);
    const structures = [spawn, extension];
    const room = {
      name: 'W1N1',
      find: jest.fn(
        (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type !== FIND_MY_STRUCTURES) {
            return [];
          }

          return options?.filter ? structures.filter(options.filter) : structures;
        }
      )
    } as unknown as Room;
    const otherCarrier = {
      name: 'OtherCarrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-assigned' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Carrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-assigned' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-assigned' ? 1 : 8))
      },
      room
    } as unknown as Creep;
    setGameCreeps({ Carrier: creep, OtherCarrier: otherCarrier });

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-assigned' });
  });

  it('uses assignment only as a tie-breaker among unreserved primary sinks', () => {
    const spawn = makeEnergySink('spawn-assigned', 'spawn' as StructureConstant, 100);
    const extension = makeEnergySink('extension-open', 'extension' as StructureConstant, 50);
    const structures = [spawn, extension];
    const room = {
      name: 'W1N1',
      find: jest.fn(
        (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type !== FIND_MY_STRUCTURES) {
            return [];
          }

          return options?.filter ? structures.filter(options.filter) : structures;
        }
      )
    } as unknown as Room;
    const otherCarrier = {
      name: 'OtherCarrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-assigned' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Carrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'spawn-assigned' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: TestEnergySink) => (target.id === 'spawn-assigned' ? 8 : 1))
      },
      room
    } as unknown as Creep;
    setGameCreeps({ Carrier: creep, OtherCarrier: otherCarrier });

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-assigned' });
  });

  it('selects fillable extensions before fillable towers', () => {
    const farExtension = makeEnergySink('extension-far', 'extension' as StructureConstant, 50);
    const nearTower = makeEnergySink('tower-near', 'tower' as StructureConstant, 500);
    const structures = [nearTower, farExtension];
    const getRangeTo = jest.fn((target: TestEnergySink) => {
      const ranges: Record<string, number> = {
        'tower-near': 1,
        'extension-far': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn((type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
          if (type !== FIND_MY_STRUCTURES) {
            return [];
          }

          return options?.filter ? structures.filter(options.filter) : structures;
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension-far' });
    expect(getRangeTo).not.toHaveBeenCalledWith(nearTower);
  });

  it('spends carried energy on construction instead of topping off a healthy tower after recovery', () => {
    const healthyTower = makeTowerEnergySink('tower-healthy', TOWER_REFILL_ENERGY_FLOOR, 500);
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        myStructures: [healthyTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('spends carried energy on controller progress instead of topping off a healthy tower when no construction remains', () => {
    const healthyTower = makeTowerEnergySink('tower-healthy', TOWER_REFILL_ENERGY_FLOOR + 1, 499);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [healthyTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps low tower refill before construction progress', () => {
    const lowTower = makeTowerEnergySink('tower-low', TOWER_REFILL_ENERGY_FLOOR - 1, 501);
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        myStructures: [lowTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'tower-low' });
  });

  it('spends carried energy productively when another worker covers the low tower refill', () => {
    const lowTower = makeTowerEnergySink('tower-covered', TOWER_REFILL_ENERGY_FLOOR - 1, 50);
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      myStructures: [lowTower as AnyOwnedStructure]
    });
    const assignedCarrier = {
      name: 'TowerCarrier',
      memory: { role: 'worker', task: { type: 'transfer', targetId: 'tower-covered' as Id<AnyStoreStructure> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn((target: { id: string }) => (target.id === 'site1' ? 1 : 5)) },
      room
    } as unknown as Creep;
    setGameCreeps({ TowerCarrier: assignedCarrier, Builder: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it.each([
    ['spawn', 'spawn-site1'],
    ['extension', 'extension-site1']
  ])('builds capacity-enabling %s construction before low tower refill', (structureType, id) => {
    const lowTower = makeTowerEnergySink('tower-low', TOWER_REFILL_ENERGY_FLOOR - 1, 501);
    const site = { id, structureType } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [lowTower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it('breaks same-class fillable energy sink range ties by id', () => {
    const laterSpawn = makeEnergySink('spawn-b', 'spawn' as StructureConstant, 300);
    const firstSpawn = makeEnergySink('spawn-a', 'spawn' as StructureConstant, 300);
    const structures = [laterSpawn, firstSpawn];
    const getRangeTo = jest.fn().mockReturnValue(4);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-a' });
  });

  it('keeps low-energy spawn priority before id order when position helpers are unavailable', () => {
    const extension = makeEnergySink('extension-first', 'extension' as StructureConstant, 50);
    const laterSpawn = makeEnergySink('spawn-z', 'spawn' as StructureConstant, 300);
    const firstSpawn = makeEnergySink('spawn-a', 'spawn' as StructureConstant, 300);
    const structures = [extension, laterSpawn, firstSpawn];
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type !== FIND_MY_STRUCTURES) {
              return [];
            }

            return options?.filter ? structures.filter(options.filter) : structures;
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn-a' });
  });

  it('preserves no-sink fallback behavior when all energy sinks are full', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const fullExtension = makeEnergySink('extension-full', 'extension' as StructureConstant, 0);
    const fullTower = makeEnergySink('tower-full', 'tower' as StructureConstant, 0);
    const site = { id: 'site1' } as ConstructionSite;
    const structures = [fullSpawn, fullExtension, fullTower];
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        find: jest.fn(
          (type: number, options?: { filter?: (structure: TestEnergySink) => boolean }) => {
            if (type === FIND_MY_STRUCTURES) {
              return options?.filter ? structures.filter(options.filter) : structures;
            }

            return type === FIND_CONSTRUCTION_SITES ? [site] : [];
          }
        )
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('estimates no near-term refill reserve when spawn and extensions are full', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const fullExtension = makeEnergySink('extension-full', 'extension' as StructureConstant, 0);
    const room = makeWorkerTaskRoom({
      energyAvailable: 350,
      energyCapacityAvailable: 350,
      myStructures: [fullSpawn as AnyOwnedStructure, fullExtension as AnyOwnedStructure]
    });

    expect(estimateNearTermSpawnExtensionRefillReserve(room)).toBe(0);
  });

  it('estimates partial near-term refill reserve from spawn and extension capacity', () => {
    const spawn = makeEnergySink('spawn-partial', 'spawn' as StructureConstant, 100);
    const extension = makeEnergySink('extension-partial', 'extension' as StructureConstant, 100);
    const room = makeWorkerTaskRoom({
      energyAvailable: 350,
      energyCapacityAvailable: 400,
      myStructures: [spawn as AnyOwnedStructure, extension as AnyOwnedStructure]
    });

    expect(estimateNearTermSpawnExtensionRefillReserve(room)).toBe(50);
  });

  it('defers non-urgent spending while a near-term refill reserve exists', () => {
    const busyFullSpawn = {
      id: 'spawn-busy',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite],
        controller,
        energyAvailable: 400,
        energyCapacityAvailable: 400,
        myStructures: [busyFullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(estimateNearTermSpawnExtensionRefillReserve(creep.room)).toBe(400);
    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('keeps construction gated by the room buffer when other workers cover near-term refill reserve', () => {
    const busyFullSpawn = {
      id: 'spawn-busy',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [roadSite],
      controller,
      energyAvailable: 100,
      energyCapacityAvailable: 100,
      myStructures: [busyFullSpawn as AnyOwnedStructure]
    });
    const reserveWorkerA = {
      name: 'ReserveA',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room
    } as unknown as Creep;
    const reserveWorkerB = {
      name: 'ReserveB',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn().mockReturnValue(2) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn().mockReturnValue(9) },
      room
    } as unknown as Creep;
    setGameCreeps({ ReserveA: reserveWorkerA, ReserveB: reserveWorkerB });

    expect(estimateNearTermSpawnExtensionRefillReserve(room)).toBe(100);
    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('deduplicates reserve workers by stable key before counting reserved refill energy', () => {
    const busyFullSpawn = {
      id: 'spawn-busy',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [roadSite],
      controller,
      energyAvailable: 100,
      energyCapacityAvailable: 100,
      myStructures: [busyFullSpawn as AnyOwnedStructure]
    });
    const reserveWorker = makeRefillReserveWorker(room, 'ReserveA', 50, 1);
    const duplicateReserveWorker = makeRefillReserveWorker(room, 'ReserveA', 50, 2);
    const creep = makeRefillReserveWorker(room, 'Builder', 50, 9);
    setGameCreeps({ ReserveA: reserveWorker, ReserveAAlias: duplicateReserveWorker });

    expect(estimateNearTermSpawnExtensionRefillReserve(room)).toBe(100);
    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('keeps construction buffer-gated after reserving higher-energy workers for near-term refill capacity', () => {
    const busyFullSpawn = {
      id: 'spawn-busy',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [roadSite],
      controller,
      energyAvailable: 100,
      energyCapacityAvailable: 100,
      myStructures: [busyFullSpawn as AnyOwnedStructure]
    });
    const lowEnergyReserveWorker = makeRefillReserveWorker(room, 'LowReserve', 50, 1);
    const highEnergyReserveWorker = makeRefillReserveWorker(room, 'HighReserve', 100, 9);
    const creep = makeRefillReserveWorker(room, 'ZBuilder', 50, 1);
    setGameCreeps({ LowReserve: lowEnergyReserveWorker, HighReserve: highEnergyReserveWorker });

    expect(estimateNearTermSpawnExtensionRefillReserve(room)).toBe(100);
    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps emergency spawn refill before surplus spending while a near-term reserve is active', () => {
    const spawningSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(1) }
    } as unknown as StructureSpawn;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [roadSite],
      controller,
      energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
      energyCapacityAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
      myStructures: [spawningSpawn as AnyOwnedStructure]
    });
    const reserveWorkerA = {
      name: 'ReserveA',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(100) },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room
    } as unknown as Creep;
    const reserveWorkerB = {
      name: 'ReserveB',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(100) },
      pos: { getRangeTo: jest.fn().mockReturnValue(2) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn().mockReturnValue(9) },
      room
    } as unknown as Creep;
    setGameCreeps({ ReserveA: reserveWorkerA, ReserveB: reserveWorkerB });

    expect(estimateNearTermSpawnExtensionRefillReserve(room)).toBe(URGENT_SPAWN_REFILL_ENERGY_THRESHOLD);
    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps controller downgrade guard ahead of near-term refill reserve', () => {
    const busyFullSpawn = {
      id: 'spawn-busy',
      structureType: 'spawn',
      spawning: { remainingTime: 10 },
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite],
        controller,
        energyAvailable: 400,
        energyCapacityAvailable: 400,
        myStructures: [busyFullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(estimateNearTermSpawnExtensionRefillReserve(creep.room)).toBe(400);
    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('reserves a safe visible territory target before spawn recovery resource collection', () => {
    const controller = { id: 'controller2', my: false } as StructureController;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const droppedEnergy = { id: 'drop1', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const source = { id: 'source1' } as Source;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 100 }]
      }
    };
    const room = {
      name: 'W2N1',
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
        if (type === FIND_MY_STRUCTURES) {
          const structures = [spawn as AnyOwnedStructure];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        if (type === FIND_DROPPED_RESOURCES) {
          return [droppedEnergy];
        }

        return type === FIND_SOURCES ? [source] : [];
      })
    } as unknown as Room;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(room.find).not.toHaveBeenCalledWith(FIND_MY_STRUCTURES, expect.anything());
    expect(room.find).not.toHaveBeenCalledWith(FIND_DROPPED_RESOURCES);
    expect(room.find).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('selects pressure reserve intents for five-CLAIM creeps against foreign reservations', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    (room as Room & { name: string }).name = 'W2N1';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 101,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const makeCreep = (claimParts: number): Creep =>
      ({
        owner: { username: 'me' },
        memory: { role: 'worker', colony: 'W1N1' },
        getActiveBodyparts: jest.fn().mockReturnValue(claimParts),
        store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
        room
      }) as unknown as Creep;

    expect(selectWorkerTask(makeCreep(1))).toEqual({ type: 'build', targetId: 'site1' });
    expect(selectWorkerTask(makeCreep(5))).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('keeps a visible reserve target before spawn refill under concurrent energy pressure', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = { id: 'controller2', my: false } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(spawn.store.getFreeCapacity).not.toHaveBeenCalled();
  });

  it('suppresses visible territory work during bootstrap so spawn refill wins', () => {
    recordSurvivalMode('BOOTSTRAP');
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = { id: 'controller2', my: false } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 900 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('suppresses visible territory work while local stability gates are still short', () => {
    recordSurvivalMode('LOCAL_STABLE');
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = { id: 'controller2', my: false } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 900 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it.each(['BOOTSTRAP', 'LOCAL_STABLE'] as const)(
    'recalls loaded remote workers to home refill while %s suppresses remote spending',
    (mode) => {
      recordSurvivalMode(mode);
      const homeSpawn = makeEnergySink('home-spawn', 'spawn' as StructureConstant, 300);
      const homeRoom = makeWorkerTaskRoom({ myStructures: [homeSpawn as AnyOwnedStructure] });
      const remoteRoom = makeWorkerTaskRoom({
        controller: {
          id: 'controller2',
          my: false,
          reservation: { username: 'Self', ticksToEnd: 1_000 }
        } as StructureController
      });
      (remoteRoom as Room & { name: string }).name = 'W2N1';
      const globalScope = globalThis as unknown as { Game?: Partial<Game> };
      globalScope.Game = {
        ...(globalScope.Game ?? {}),
        creeps: {},
        rooms: { W1N1: homeRoom, W2N1: remoteRoom }
      };
      const creep = {
        memory: { role: 'worker', colony: 'W1N1' },
        owner: { username: 'Self' },
        store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
        room: remoteRoom
      } as unknown as Creep;

      expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'home-spawn' });
    }
  );

  it('recalls loaded remote workers to the home controller when bootstrap refill sinks are full', () => {
    recordSurvivalMode('BOOTSTRAP');
    const homeController = {
      id: 'home-controller',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const fullHomeSpawn = makeEnergySink('home-spawn-full', 'spawn' as StructureConstant, 0);
    const homeRoom = makeWorkerTaskRoom({
      controller: homeController,
      myStructures: [fullHomeSpawn as AnyOwnedStructure]
    });
    const remoteRoom = makeWorkerTaskRoom({
      controller: {
        id: 'controller2',
        my: false,
        reservation: { username: 'Self', ticksToEnd: 1_000 }
      } as StructureController
    });
    (remoteRoom as Room & { name: string }).name = 'W2N1';
    const globalScope = globalThis as unknown as { Game?: Partial<Game> };
    globalScope.Game = {
      ...(globalScope.Game ?? {}),
      creeps: {},
      rooms: { W1N1: homeRoom, W2N1: remoteRoom }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      owner: { username: 'Self' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: remoteRoom
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'home-controller' });
  });

  it('suppresses remote critical road repair while local stability gates are still short', () => {
    recordSurvivalMode('LOCAL_STABLE');
    const road = makeStructure('remote-road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(12, 10, 'W2N1')
    });
    const source = makeSource('source1', 20, 10, 'W2N1');
    const controller = {
      id: 'controller2',
      my: false,
      pos: makeRoomPosition(10, 10, 'W2N1'),
      reservation: { username: 'Self', ticksToEnd: 1_000 }
    } as StructureController;
    setGameSpawns({ Spawn1: makeSpawn('Spawn1', 10, 10, 'W1N1') });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };
    const room = makeWorkerTaskRoom({
      controller,
      sources: [source],
      structures: [road]
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      owner: { username: 'Self' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('allows visible territory work once territory-ready gates are met', () => {
    recordSurvivalMode('TERRITORY_READY');
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = { id: 'controller2', my: false } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 900 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1', territory: { targetRoom: 'W2N1', action: 'reserve' } },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
    expect(spawn.store.getFreeCapacity).not.toHaveBeenCalled();
  });

  it('routes carried energy to controller progress when survival gates are territory-ready', () => {
    recordSurvivalMode('TERRITORY_READY');
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('suppresses non-critical construction and routine upgrading during bootstrap', () => {
    recordSurvivalMode('BOOTSTRAP');
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('allows home critical infrastructure repair during bootstrap', () => {
    recordSurvivalMode('BOOTSTRAP');
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(12, 10)
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-critical' });
  });

  it('suppresses remote critical infrastructure repair during bootstrap', () => {
    recordSurvivalMode('BOOTSTRAP');
    const road = makeStructure('remote-road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(12, 10, 'W2N1')
    });
    const source = makeSource('source1', 20, 10, 'W2N1');
    const controller = {
      id: 'controller2',
      my: false,
      pos: makeRoomPosition(10, 10, 'W2N1'),
      reservation: { username: 'Self', ticksToEnd: 1_000 }
    } as StructureController;
    setGameSpawns({ Spawn1: makeSpawn('Spawn1', 10, 10, 'W1N1') });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };
    const room = makeWorkerTaskRoom({
      controller,
      sources: [source],
      structures: [road]
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      owner: { username: 'Self' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('suppresses remote critical road construction during bootstrap', () => {
    recordSurvivalMode('BOOTSTRAP');
    const roadSite = {
      id: 'remote-road-critical-site1',
      structureType: 'road',
      pos: makeRoomPosition(12, 10, 'W2N1')
    } as ConstructionSite;
    const source = makeSource('source1', 20, 10, 'W2N1');
    const controller = {
      id: 'controller2',
      my: false,
      pos: makeRoomPosition(10, 10, 'W2N1'),
      reservation: { username: 'Self', ticksToEnd: 1_000 }
    } as StructureController;
    setGameSpawns({ Spawn1: makeSpawn('Spawn1', 10, 10, 'W1N1') });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };
    const room = makeWorkerTaskRoom({
      constructionSites: [roadSite],
      controller,
      sources: [source]
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('suppresses remote RCL1 controller upgrading during bootstrap', () => {
    recordSurvivalMode('BOOTSTRAP');
    const controller = {
      id: 'controller2',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('suppresses claimed remote controller progress during defense', () => {
    recordSurvivalMode('DEFENSE');
    const controller = {
      id: 'controller2',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 900 }]
      }
    };
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      controller
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('keeps controller downgrade guard active during bootstrap', () => {
    recordSurvivalMode('BOOTSTRAP');
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('renews an urgent own visible reservation before local construction with enough CLAIM parts', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('renews a normal-threshold own visible reservation before local construction with one CLAIM part', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('renews an emergency own visible reservation before local construction with one CLAIM part', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('keeps local construction before an above-normal own reservation renewal with one CLAIM part', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 106 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('keeps local construction before a comfortable own visible reservation', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 107 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('continues a visible own reservation above the normal renewal threshold with enough CLAIM parts', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 107 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'reserve', targetId: 'controller2' });
  });

  it('stops continuing a visible own reservation once it is comfortably safe', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_COMFORT_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 107 }]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('claims a safe visible territory target before local construction', () => {
    const controller = { id: 'controller2', my: false } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 101 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'claim', targetId: 'controller2' });
  });

  it('selects pressure claim intents only for five-CLAIM creeps against foreign reservations', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    (room as Room & { name: string }).name = 'W2N1';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 101 }]
      }
    };
    const makeCreep = (claimParts: number): Creep =>
      ({
        owner: { username: 'me' },
        memory: { role: 'worker', colony: 'W1N1' },
        getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === CLAIM ? claimParts : 0)),
        store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
        room
      }) as unknown as Creep;

    expect(selectWorkerTask(makeCreep(1))).toEqual({ type: 'build', targetId: 'site1' });
    const pressureCreep = makeCreep(5);
    expect(selectWorkerTask(pressureCreep)).toEqual({ type: 'claim', targetId: 'controller2' });
    expect(pressureCreep.getActiveBodyparts).toHaveBeenCalledWith(CLAIM);
  });

  it('upgrades a claimed territory target before unrelated construction support', () => {
    const controller = { id: 'controller2', my: true, level: 1 } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 102 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller2' });
  });

  it('builds claimed-room spawn construction before fallback territory upgrading', () => {
    const controller = { id: 'controller2', my: true, level: 1 } as StructureController;
    const site = { id: 'spawn-site1', structureType: 'spawn' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 102 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'spawn-site1' });
  });

  it('keeps a dedicated claimed-room controller sustainer on upgrading before spawn construction', () => {
    const controller = { id: 'controller2', my: true, level: 1 } as StructureController;
    const site = { id: 'spawn-site1', structureType: 'spawn' } as ConstructionSite;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W2N1',
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller2' });
  });

  it('does not spend dedicated controller sustain energy on a maxed controller', () => {
    const controller = { id: 'controller2', my: true, level: 8 } as StructureController;
    const site = { id: 'spawn-site1', structureType: 'spawn' } as ConstructionSite;
    const creep = {
      memory: {
        role: 'worker',
        colony: 'W2N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller2' },
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
      },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(50),
        getFreeCapacity: jest.fn().mockReturnValue(0)
      },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'spawn-site1' });
  });

  it('does not prioritize a freshly suppressed urgent reservation renewal', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'suppressed', updatedAt: 103 }]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 104 };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('does not continue a freshly suppressed reservation inside the comfort buffer', () => {
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'suppressed', updatedAt: 103 }]
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: {}, time: 104 };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('does not prioritize an unsafe urgent reservation renewal', () => {
    const hostile = { id: 'hostile1' } as Creep;
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 108 }]
      }
    };
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    const baseFind = room.find.bind(room) as (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => unknown[];
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return [hostile];
      }

      return baseFind(type, options);
    }) as unknown as Room['find'];
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('does not continue a reservation inside the comfort buffer in an unsafe room', () => {
    const hostile = { id: 'hostile1' } as Creep;
    const controller = {
      id: 'controller2',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const site = { id: 'site1', structureType: 'road' } as ConstructionSite;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'active', updatedAt: 108 }]
      }
    };
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    const baseFind = room.find.bind(room) as (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => unknown[];
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_HOSTILE_CREEPS) {
        return [hostile];
      }

      return baseFind(type, options);
    }) as unknown as Room['find'];
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'worker', colony: 'W1N1' },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('keeps spawn refill before claimed territory upgrade support', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = { id: 'controller2', my: true, level: 2 } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 105 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('selects build when worker has energy and construction sites exist', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn((type) => (type === 2 ? [site] : [])) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it.each([
    ['road', 5_000],
    ['container', 2_000]
  ])('repairs critical %s damage before generic construction', (structureType, hitsMax) => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const repairTarget = makeStructure(
      `${structureType}-critical`,
      structureType as StructureConstant,
      Math.floor(hitsMax * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO),
      hitsMax,
      structureType === 'road' ? { pos: makeRoomPosition(12, 10) } : {}
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        myStructures: structureType === 'road' ? [fullSpawn as AnyOwnedStructure] : [],
        sources: structureType === 'road' ? [source] : [],
        structures: [repairTarget]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: `${structureType}-critical` });
  });

  it.each([
    ['road', 5_000],
    ['container', 2_000]
  ])('repairs critical %s damage before matching construction', (structureType, hitsMax) => {
    const site = { id: `${structureType}-site1`, structureType } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const repairTarget = makeStructure(
      `${structureType}-critical`,
      structureType as StructureConstant,
      Math.floor(hitsMax * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO),
      hitsMax,
      structureType === 'road' ? { pos: makeRoomPosition(12, 10) } : {}
    );
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      controller,
      myStructures: structureType === 'road' ? [fullSpawn as AnyOwnedStructure] : [],
      sources: structureType === 'road' ? [source] : [],
      structures: [repairTarget]
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: `${structureType}-critical` });
  });

  it('keeps non-critical road and container repair behind generic construction', () => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const road = makeStructure(
      'road-non-critical',
      'road' as StructureConstant,
      Math.floor(5_000 * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO) + 1,
      5_000
    );
    const container = makeStructure(
      'container-non-critical',
      'container' as StructureConstant,
      Math.floor(2_000 * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO) + 1,
      2_000
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], structures: [road, container] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'generic-site1' });
  });

  it('uses room-local BUILD_POWER progress reservations when routine construction is already covered', () => {
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const site = {
      id: 'generic-site1',
      structureType: 'tower',
      progress: 0,
      progressTotal: 100
    } as ConstructionSite;
    const road = makeStructure('road-worn', 'road' as StructureConstant, 4_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const myCreeps: Creep[] = [];
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller, myCreeps, structures: [road] });
    const assignedBuilder = {
      name: 'AssignedBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'generic-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(20) },
      room
    } as unknown as Creep;
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        controller1: 5,
        'generic-site1': 1,
        'road-worn': 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      name: 'Repairer',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    myCreeps.push(assignedBuilder, creep);
    setGameCreeps({});

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-worn' });
  });

  it('keeps routine construction when assigned builders do not cover remaining progress', () => {
    const site = {
      id: 'generic-site1',
      structureType: 'tower',
      progress: 0,
      progressTotal: 150
    } as ConstructionSite;
    const road = makeStructure('road-worn', 'road' as StructureConstant, 4_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [road] });
    const assignedBuilder = {
      name: 'AssignedBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'generic-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(20) },
      room
    } as unknown as Creep;
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        controller1: 5,
        'generic-site1': 1,
        'road-worn': 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ AssignedBuilder: assignedBuilder, Builder: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'generic-site1' });
  });

  it('skips capacity construction when another worker already covers its remaining progress', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const extensionSite = {
      id: 'extension-site1',
      structureType: 'extension',
      progress: 0,
      progressTotal: 100
    } as ConstructionSite;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [roadSite, extensionSite], controller });
    const assignedBuilder = {
      name: 'AssignedBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'extension-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(20) },
      room
    } as unknown as Creep;
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        controller1: 5,
        'extension-site1': 1,
        'road-site1': 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    setGameCreeps({ AssignedBuilder: assignedBuilder, Builder: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('skips covered critical road construction for open container construction', () => {
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const criticalRoadSite = {
      id: 'road-critical-site1',
      structureType: 'road',
      progress: 0,
      progressTotal: 100,
      pos: makeRoomPosition(12, 10)
    } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const myCreeps: Creep[] = [];
    const room = makeWorkerTaskRoom({
      constructionSites: [criticalRoadSite, containerSite],
      controller,
      myCreeps,
      myStructures: [fullSpawn as AnyOwnedStructure],
      sources: [source]
    });
    const assignedBuilder = {
      name: 'AssignedRoadBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'road-critical-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(20) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'ContainerBuilder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    myCreeps.push(assignedBuilder, creep);
    setGameCreeps({});

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'container-site1' });
  });

  it('skips covered container construction for open road construction', () => {
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const containerSite = {
      id: 'container-site1',
      structureType: 'container',
      progress: 0,
      progressTotal: 100
    } as ConstructionSite;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const myCreeps: Creep[] = [];
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [containerSite, roadSite];
        }

        if (type === (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS) {
          return myCreeps;
        }

        return [];
      })
    } as unknown as Room;
    const assignedBuilder = {
      name: 'AssignedContainerBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'container-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(20) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'RoadBuilder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    myCreeps.push(assignedBuilder, creep);
    setGameCreeps({});

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('finishes construction whose remaining unreserved progress fits carried energy', () => {
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const nearUnfinishedSite = {
      id: 'tower-near-unfinished',
      structureType: 'tower',
      progress: 0,
      progressTotal: 1_000
    } as ConstructionSite;
    const reservedFinishableSite = {
      id: 'tower-reserved-finishable',
      structureType: 'tower',
      progress: 250,
      progressTotal: 500
    } as ConstructionSite;
    const myCreeps: Creep[] = [];
    const room = makeWorkerTaskRoom({
      constructionSites: [nearUnfinishedSite, reservedFinishableSite],
      controller: undefined,
      myCreeps
    });
    const assignedBuilder = {
      name: 'AssignedBuilder',
      memory: {
        role: 'worker',
        task: { type: 'build', targetId: 'tower-reserved-finishable' as Id<ConstructionSite> }
      },
      store: { getUsedCapacity: jest.fn().mockReturnValue(40) },
      room
    } as unknown as Creep;
    const getRangeTo = jest.fn((target: { id?: string }) => {
      const ranges: Record<string, number> = {
        'tower-near-unfinished': 1,
        'tower-reserved-finishable': 8
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(10) },
      pos: { getRangeTo },
      room
    } as unknown as Creep;
    myCreeps.push(assignedBuilder, creep);
    setGameCreeps({ AssignedBuilder: assignedBuilder, Builder: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-reserved-finishable' });
    expect(room.find).toHaveBeenCalledWith(10);
  });

  it('keeps a worker on its assigned capacity construction site', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const extensionSite = {
      id: 'extension-site1',
      structureType: 'extension',
      progress: 0,
      progressTotal: 100
    } as ConstructionSite;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [roadSite, extensionSite], controller });
    const otherBuilder = {
      name: 'OtherBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'extension-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(20) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'AssignedBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'extension-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ OtherBuilder: otherBuilder, AssignedBuilder: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('ignores off-room global builders when room-local construction reservations are available', () => {
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    const site = {
      id: 'generic-site1',
      structureType: 'tower',
      progress: 0,
      progressTotal: 100
    } as ConstructionSite;
    const myCreeps: Creep[] = [];
    const room = {
      name: 'W1N1',
      find: jest.fn((type: number) => {
        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        if (type === (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS) {
          return myCreeps;
        }

        return [];
      })
    } as unknown as Room;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    const offRoomAssignedBuilder = {
      name: 'OffRoomBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'generic-site1' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { name: 'W9N9' }
    } as unknown as Creep;
    const globalCreeps = new Proxy({ OffRoomBuilder: offRoomAssignedBuilder } as Record<string, Creep>, {
      ownKeys: () => {
        throw new Error('construction reservations should use room-local creeps');
      }
    });
    myCreeps.push(creep);
    (globalThis as unknown as { Game: Partial<Game> }).Game = { creeps: globalCreeps };

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'generic-site1' });
    expect(room.find).toHaveBeenCalledWith(10);
  });

  it('caches room construction reservations across construction candidate checks', () => {
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const coveredSite = {
      id: 'generic-site-a',
      structureType: 'tower',
      progress: 0,
      progressTotal: 100
    } as ConstructionSite;
    const openSite = {
      id: 'generic-site-b',
      structureType: 'tower',
      progress: 0,
      progressTotal: 100
    } as ConstructionSite;
    const secondOpenSite = {
      id: 'generic-site-c',
      structureType: 'tower',
      progress: 0,
      progressTotal: 150
    } as ConstructionSite;
    const myCreeps: Creep[] = [];
    const room = makeWorkerTaskRoom({
      constructionSites: [coveredSite, openSite, secondOpenSite],
      controller: undefined,
      myCreeps
    });
    const assignedBuilder = {
      name: 'AssignedBuilder',
      memory: { role: 'worker', task: { type: 'build', targetId: 'generic-site-a' as Id<ConstructionSite> } },
      store: { getUsedCapacity: jest.fn().mockReturnValue(20) },
      room
    } as unknown as Creep;
    const creep = {
      name: 'Builder',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    myCreeps.push(assignedBuilder, creep);
    setGameCreeps({});

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'generic-site-b' });
    expect(
      (room.find as jest.Mock).mock.calls.filter(
        ([type]: [number]) => type === (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS
      )
    ).toHaveLength(1);
  });

  it('keeps off-route road repair behind generic construction even at the critical hit threshold', () => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const road = makeStructure(
      'road-off-route',
      'road' as StructureConstant,
      Math.floor(5_000 * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO),
      5_000,
      { pos: makeRoomPosition(10, 20) }
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'generic-site1' });
  });

  it('keeps route road repair behind generic construction above the critical hit threshold', () => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const road = makeStructure(
      'road-worn',
      'road' as StructureConstant,
      Math.floor(5_000 * CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO) + 1,
      5_000,
      { pos: makeRoomPosition(12, 10) }
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'generic-site1' });
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1'],
    ['tower', 'tower1']
  ])('keeps %s refill before critical road repair', (structureType, id) => {
    const energySink = makeEnergySink(id, structureType as StructureConstant, 300);
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        myStructures: [energySink as AnyOwnedStructure],
        structures: [road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: id });
  });

  it('keeps controller downgrade guard before critical road repair', () => {
    const site = { id: 'generic-site1', structureType: 'road' } as ConstructionSite;
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [road] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps emergency spawn refill before controller-source critical road construction', () => {
    const roadSite = {
      id: 'road-controller-source-site1',
      structureType: 'road',
      pos: makeRoomPosition(40, 25)
    } as ConstructionSite;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 40, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      pos: makeRoomPosition(40, 40),
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        myStructures: [spawn as AnyOwnedStructure],
        sources: [source]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps controller downgrade guard before controller-source critical road construction', () => {
    const roadSite = {
      id: 'road-controller-source-site1',
      structureType: 'road',
      pos: makeRoomPosition(40, 25)
    } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 40, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      pos: makeRoomPosition(40, 40),
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps controller downgrade guard before tower refill', () => {
    const tower = makeEnergySink('tower1', 'tower' as StructureConstant, 500);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [tower as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it.each([
    ['spawn', 'spawn-site1'],
    ['extension', 'extension-site1']
  ])('keeps %s construction before critical container repair', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const container = makeStructure('container-critical', 'container' as StructureConstant, 400, 2_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [container] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it('keeps RCL1 controller rush before critical road repair', () => {
    const site = { id: 'generic-site1', structureType: 'road' } as ConstructionSite;
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [road] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps critical road repair before sustained controller progress', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(12, 10)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      controller,
      myStructures: [fullSpawn as AnyOwnedStructure],
      sources: [source],
      structures: [road]
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-critical' });
  });

  it('repairs controller-source critical route roads before generic construction', () => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 40, 10);
    const road = makeStructure('road-controller-source-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(40, 25)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      pos: makeRoomPosition(40, 40),
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-controller-source-critical' });
  });

  it('repairs colony-anchored remote critical roads before generic construction without a local spawn', () => {
    const site = { id: 'generic-site1', structureType: 'tower' } as ConstructionSite;
    const source = makeSource('source1', 40, 10, 'W2N1');
    const road = makeStructure('remote-road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(46, 10, 'W2N1')
    });
    const controller = {
      id: 'controller2',
      my: true,
      level: 3,
      pos: makeRoomPosition(10, 40, 'W2N1'),
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    setGameSpawns({ Spawn1: makeSpawn('Spawn1', 10, 10, 'W1N1') });
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      controller,
      sources: [source],
      structures: [road]
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'remote-road-critical' });
  });

  it('selects RCL1 controller upgrade before non-spawn construction when downgrade is safe', () => {
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const site = { id: 'site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === 3) {
            const structures = [fullSpawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('builds spawn construction before RCL1 controller rush', () => {
    const site = { id: 'spawn-site1', structureType: 'spawn' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'spawn-site1' });
  });

  it('builds spawn construction before RCL1 rush when STRUCTURE_SPAWN is missing from the mock globals', () => {
    delete (globalThis as unknown as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN;
    const site = { id: 'spawn-site1', structureType: 'spawn' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toEqual({ type: 'build', targetId: 'spawn-site1' });
  });

  it.each([
    ['road', 'road-site1'],
    ['container', 'container-site1']
  ])('builds %s construction before sustained controller progress when another loaded worker can build', (structureType, id) => {
    const site = {
      id,
      structureType,
      ...(structureType === 'road' ? { pos: makeRoomPosition(12, 10) } : {})
    } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      controller,
      myStructures: structureType === 'road' ? [fullSpawn as AnyOwnedStructure] : [],
      sources: structureType === 'road' ? [source] : []
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it.each([
    ['spawn', 'spawn-site1'],
    ['extension', 'extension-site1']
  ])('builds RCL2 critical %s construction before road construction and controller progress guard', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [roadSite, site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Worker2: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: id });
  });

  it.each([
    ['road', 'road-site1'],
    ['container', 'container-site1']
  ])('builds extension construction before %s construction', (structureType, id) => {
    const roadOrContainerSite = { id, structureType } as ConstructionSite;
    const extensionSite = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [roadOrContainerSite, extensionSite],
      controller
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('keeps extension construction ahead of source containers before baseline worker capacity is online', () => {
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const extensionSite = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [containerSite, extensionSite],
        controller,
        energyCapacityAvailable: 500
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('builds source containers before additional extensions once baseline worker capacity is online', () => {
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const extensionSite = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [extensionSite, containerSite],
        controller,
        energyCapacityAvailable: 550,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'container-site1' });
  });

  it('builds critical source route roads before additional extensions once baseline worker capacity is online', () => {
    const roadSite = {
      id: 'road-critical-site1',
      structureType: 'road',
      pos: makeRoomPosition(12, 10)
    } as ConstructionSite;
    const extensionSite = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [extensionSite, roadSite],
        controller,
        energyCapacityAvailable: 550,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-critical-site1' });
  });

  it('builds an extension finishable with Screeps build power before a closer unfinished extension', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const nearExtensionSite = {
      id: 'extension-near',
      structureType: 'extension',
      progress: 0,
      progressTotal: 500
    } as ConstructionSite;
    const finishableExtensionSite = {
      id: 'extension-finishable',
      structureType: 'extension',
      progress: 250,
      progressTotal: 500
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: ConstructionSite) =>
      target.id === 'extension-finishable' ? 8 : 1
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [nearExtensionSite, finishableExtensionSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-finishable' });
  });

  it('prioritizes a nearly complete same-tier site before a 10% complete site', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const earlyTowerSite = {
      id: 'tower-early',
      structureType: 'tower',
      progress: 1_000,
      progressTotal: 10_000
    } as ConstructionSite;
    const nearlyCompleteTowerSite = {
      id: 'tower-nearly-complete',
      structureType: 'tower',
      progress: 9_500,
      progressTotal: 10_000
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: ConstructionSite) =>
          target.id === 'tower-nearly-complete' ? 8 : 1
        )
      },
      room: makeWorkerTaskRoom({
        constructionSites: [earlyTowerSite, nearlyCompleteTowerSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-nearly-complete' });
  });

  it('treats 50 carried energy as enough to finish 200 construction progress', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const nearTowerSite = {
      id: 'tower-near',
      structureType: 'tower',
      progress: 0,
      progressTotal: 1_000
    } as ConstructionSite;
    const finishableTowerSite = {
      id: 'tower-finishable-200',
      structureType: 'tower',
      progress: 800,
      progressTotal: 1_000
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: ConstructionSite) =>
          target.id === 'tower-finishable-200' ? 8 : 1
        )
      },
      room: makeWorkerTaskRoom({
        constructionSites: [nearTowerSite, finishableTowerSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-finishable-200' });
  });

  it('does not treat 50 carried energy as enough to finish 300 construction progress', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const nearTowerSite = {
      id: 'tower-near',
      structureType: 'tower',
      progress: 0,
      progressTotal: 1_000
    } as ConstructionSite;
    const notFinishableTowerSite = {
      id: 'tower-not-finishable-300',
      structureType: 'tower',
      progress: 700,
      progressTotal: 1_000
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: ConstructionSite) =>
          target.id === 'tower-not-finishable-300' ? 8 : 1
        )
      },
      room: makeWorkerTaskRoom({
        constructionSites: [nearTowerSite, notFinishableTowerSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-near' });
  });

  it('chooses the smallest remaining progress among multiple nearly complete same-tier sites', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const lessRemainingTowerSite = {
      id: 'tower-remaining-500',
      structureType: 'tower',
      progress: 9_500,
      progressTotal: 10_000
    } as ConstructionSite;
    const moreRemainingTowerSite = {
      id: 'tower-remaining-700',
      structureType: 'tower',
      progress: 9_300,
      progressTotal: 10_000
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: ConstructionSite) =>
          target.id === 'tower-remaining-500' ? 8 : 1
        )
      },
      room: makeWorkerTaskRoom({
        constructionSites: [moreRemainingTowerSite, lessRemainingTowerSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-remaining-500' });
  });

  it('keeps closest extension construction when no extension can be completed with carried energy', () => {
    const nearExtensionSite = {
      id: 'extension-near',
      structureType: 'extension',
      progress: 0,
      progressTotal: 300
    } as ConstructionSite;
    const fartherExtensionSite = {
      id: 'extension-farther',
      structureType: 'extension',
      progress: 200,
      progressTotal: 500
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: ConstructionSite) =>
      target.id === 'extension-farther' ? 8 : 1
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [nearExtensionSite, fartherExtensionSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-near' });
  });

  it('keeps bootstrap spawn construction before a nearly complete extension', () => {
    const spawnSite = {
      id: 'spawn-site1',
      structureType: 'spawn',
      progress: 0,
      progressTotal: 15_000
    } as ConstructionSite;
    const nearlyCompleteExtensionSite = {
      id: 'extension-nearly-complete',
      structureType: 'extension',
      progress: 9_500,
      progressTotal: 10_000
    } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: ConstructionSite) =>
          target.id === 'extension-nearly-complete' ? 1 : 8
        )
      },
      room: makeWorkerTaskRoom({
        constructionSites: [nearlyCompleteExtensionSite, spawnSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'spawn-site1' });
  });

  it('builds container construction before road construction after spawn refill is satisfied', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 0);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'container-site1' });
  });

  it('builds critical route road construction before container construction', () => {
    const roadSite = {
      id: 'road-critical-site1',
      structureType: 'road',
      pos: makeRoomPosition(12, 10)
    } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [containerSite, roadSite],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-critical-site1' });
  });

  it('builds controller-source critical route road construction before source container construction', () => {
    const roadSite = {
      id: 'road-controller-source-site1',
      structureType: 'road',
      pos: makeRoomPosition(40, 25)
    } as ConstructionSite;
    const containerSite = {
      id: 'source-container-site1',
      structureType: 'container',
      pos: makeRoomPosition(41, 10)
    } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 40, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      pos: makeRoomPosition(40, 40),
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [containerSite, roadSite],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-controller-source-site1' });
  });

  it('repairs reserved-room critical route roads before container construction without a local spawn', () => {
    const road = makeStructure('remote-road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(12, 10, 'W2N1')
    });
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const source = makeSource('source1', 20, 10, 'W2N1');
    const controller = {
      id: 'controller2',
      my: false,
      pos: makeRoomPosition(10, 10, 'W2N1'),
      reservation: { username: 'Self', ticksToEnd: 1_000 }
    } as StructureController;
    setGameSpawns({ Spawn1: makeSpawn('Spawn1', 10, 10, 'W1N1') });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };
    const room = makeWorkerTaskRoom({
      constructionSites: [containerSite],
      controller,
      sources: [source],
      structures: [road]
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      owner: { username: 'Self' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'remote-road-critical' });
  });

  it('builds reserved-room critical route road construction before container construction without a local spawn', () => {
    const roadSite = {
      id: 'remote-road-critical-site1',
      structureType: 'road',
      pos: makeRoomPosition(12, 10, 'W2N1')
    } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const source = makeSource('source1', 20, 10, 'W2N1');
    const controller = {
      id: 'controller2',
      my: false,
      pos: makeRoomPosition(10, 10, 'W2N1'),
      reservation: { username: 'Self', ticksToEnd: 1_000 }
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };
    const room = makeWorkerTaskRoom({
      constructionSites: [containerSite, roadSite],
      controller,
      sources: [source]
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'remote-road-critical-site1' });
  });

  it('builds colony-anchored remote critical route road construction before containers without a local spawn', () => {
    const roadSite = {
      id: 'remote-road-colony-critical-site1',
      structureType: 'road',
      pos: makeRoomPosition(46, 10, 'W2N1')
    } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const source = makeSource('source1', 40, 10, 'W2N1');
    const controller = {
      id: 'controller2',
      my: false,
      pos: makeRoomPosition(10, 40, 'W2N1'),
      reservation: { username: 'Self', ticksToEnd: 1_000 }
    } as StructureController;
    setGameSpawns({ Spawn1: makeSpawn('Spawn1', 10, 10, 'W1N1') });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };
    const room = makeWorkerTaskRoom({
      constructionSites: [containerSite, roadSite],
      controller,
      sources: [source]
    });
    (room as Room & { name: string }).name = 'W2N1';
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'remote-road-colony-critical-site1' });
  });

  it('builds the closest same-priority construction site after spawn refill is satisfied', () => {
    const farRoadSite = { id: 'road-far', structureType: 'road' } as ConstructionSite;
    const nearRoadSite = { id: 'road-near', structureType: 'road' } as ConstructionSite;
    const fullSpawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 0);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: ConstructionSite) => {
      const ranges: Record<string, number> = {
        'road-far': 9,
        'road-near': 2
      };
      return ranges[String(target.id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [farRoadSite, nearRoadSite],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-near' });
  });

  it('breaks same-priority construction site range ties by id', () => {
    const secondRoadSite = { id: 'road-b', structureType: 'road' } as ConstructionSite;
    const firstRoadSite = { id: 'road-a', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo: jest.fn().mockReturnValue(4) },
      room: makeWorkerTaskRoom({
        constructionSites: [secondRoadSite, firstRoadSite],
        controller
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-a' });
  });

  it('keeps spawn refill before container-first construction throughput', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('guards critically low spawn energy from construction spending', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 101);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps spawn refill active when urgent threshold has cleared before construction', () => {
    const roadSite = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const containerSite = { id: 'container-site1', structureType: 'container' } as ConstructionSite;
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 100);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [roadSite, containerSite],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps extension refill active when urgent threshold has cleared before controller progress', () => {
    const extension = makeEnergySink('extension1', 'extension' as StructureConstant, 100);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        myStructures: [extension as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension1' });
  });

  it('builds RCL2 extension construction before controller progress guard when STRUCTURE_EXTENSION is missing', () => {
    delete (globalThis as unknown as { STRUCTURE_EXTENSION?: StructureConstant }).STRUCTURE_EXTENSION;
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('keeps RCL3 build-before-upgrade priority when only one loaded worker is available', () => {
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('gates construction spending when the room energy buffer would be breached', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: 540,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('uses the survival buffer multiplier before selecting construction spending', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const makeCreep = (): Creep =>
      ({
        store: { getUsedCapacity: jest.fn().mockReturnValue(60) },
        room: makeWorkerTaskRoom({
          constructionSites: [site],
          controller,
          energyAvailable: 800,
          myStructures: [fullSpawn as AnyOwnedStructure]
        })
      }) as unknown as Creep;

    recordSurvivalMode('DEFENSE');
    expect(selectWorkerTask(makeCreep())).toEqual({ type: 'upgrade', targetId: 'controller1' });

    clearColonySurvivalAssessmentCache();
    recordSurvivalMode('LOCAL_STABLE');
    expect(selectWorkerTask(makeCreep())).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('routes carried energy to controller upgrade before non-critical construction once spawn recovery is safe', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
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
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('reserves urgent spawn refill for active follow-up demand before non-critical construction', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 500
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(500)]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        energyCapacityAvailable: TERRITORY_CONTROLLER_BODY_COST,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps follow-up spawn refill before construction until controller-body energy is ready', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 450);
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 510
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(510)]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD,
        energyCapacityAvailable: TERRITORY_CONTROLLER_BODY_COST,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps spawn refill before construction when follow-up energy target is ready', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const site = { id: 'road-site1', structureType: 'road' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 512
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(512)]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
        energyCapacityAvailable: 800,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps extension refill before controller upgrade when follow-up energy target is ready', () => {
    const extension = makeEnergySink('extension1', 'extension' as StructureConstant, 50);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 513
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(513)]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
        energyCapacityAvailable: 800,
        myStructures: [extension as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'extension1' });
  });

  it('keeps spawn refill before nearby non-urgent repair when follow-up energy target is ready', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const road = makeStructure('road-worn', 'road' as StructureConstant, 4_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'road-worn': 2,
        controller1: 5
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 514
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(514)]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        controller,
        energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
        energyCapacityAvailable: 800,
        myStructures: [spawn as AnyOwnedStructure],
        structures: [road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('builds follow-up-ready capacity construction before fallback territory upgrading', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller2',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 514
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(514)],
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 514 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
        energyCapacityAvailable: 800
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('repairs follow-up-ready critical infrastructure before fallback territory upgrading', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10, 'W2N1')
    });
    const source = makeSource('source1', 20, 10, 'W2N1');
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(12, 10, 'W2N1')
    });
    const controller = {
      id: 'controller2',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 515
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(515)],
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 515 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
        energyCapacityAvailable: 800,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [road]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-critical' });
  });

  it('builds follow-up-ready critical road logistics before fallback territory upgrading', () => {
    const homeSpawn = makeSpawn('Spawn1', 25, 25, 'W1N1');
    const source = makeSource('source1', 24, 25, 'W2N1');
    const site = {
      id: 'road-site1',
      structureType: 'road',
      pos: makeRoomPosition(40, 25, 'W2N1')
    } as ConstructionSite;
    const controller = {
      id: 'controller2',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25, 'W2N1')
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      spawns: { Spawn1: homeSpawn },
      time: 517
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(517, 'W1N1', 'W2N1')],
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 517 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
        energyCapacityAvailable: 800,
        sources: [source]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('keeps emergency refill before productive follow-up spending', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const controller = {
      id: 'controller2',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      time: 516
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(516)],
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'claim', status: 'active', updatedAt: 516 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: URGENT_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
        energyCapacityAvailable: 800,
        myStructures: [spawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (creep.room as Room & { name: string }).name = 'W2N1';

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('uses active follow-up demand as territory pressure once refill capacity is full', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(501)]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
        energyCapacityAvailable: 800,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 501
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('ignores stale follow-up demand when choosing non-critical construction', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        demands: [makeFollowUpDemand(502)]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: { Worker1: creep },
      time: 503
    };

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'wall-site1' });
  });

  it('uses nearby non-critical construction before controller pressure upgrade after urgent refill', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
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
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'wall-site1' });
  });

  it('keeps controller pressure upgrade when non-critical construction is farther than the controller', () => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'wall-site1': 9,
        controller1: 3
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 200 }]
      }
    };
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it.each([
    ['missing', { role: 'worker' }],
    ['empty', { role: 'worker', colony: '' }]
  ])('ignores territory pressure when worker colony memory is %s', (_caseName, memory) => {
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0);
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
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
    const creep = {
      memory,
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'wall-site1' });
  });

  it('routes carried energy to controller upgrade before non-critical construction when stored surplus exists', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [storage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('routes carried energy to controller upgrade before non-critical construction when salvage surplus exists', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const tombstone = makeSalvageEnergySource('tombstone-surplus', 100);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type: number) => {
        if (
          type === FIND_MY_STRUCTURES ||
          type === FIND_STRUCTURES ||
          type === FIND_HOSTILE_CREEPS ||
          type === FIND_HOSTILE_STRUCTURES ||
          type === FIND_RUINS
        ) {
          return [];
        }

        if (type === FIND_CONSTRUCTION_SITES) {
          return [site];
        }

        return type === FIND_TOMBSTONES ? [tombstone] : [];
      })
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(room.find).not.toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('routes carried energy to controller upgrade before non-critical construction when dropped energy surplus exists', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const droppedEnergy = { id: 'drop-surplus', resourceType: 'energy', amount: 100 } as Resource<ResourceConstant>;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    const baseFind = room.find.bind(room) as (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => unknown[];
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      return baseFind(type, options);
    }) as unknown as Room['find'];
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('routes carried energy to controller upgrade on visible dropped energy surplus without pathfinding', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const droppedEnergy = { id: 'drop-surplus', resourceType: 'energy', amount: 100 } as Resource<ResourceConstant>;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller });
    const baseFind = room.find.bind(room) as (
      type: number,
      options?: { filter?: (structure: AnyOwnedStructure) => boolean }
    ) => unknown[];
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type === FIND_DROPPED_RESOURCES) {
        return [droppedEnergy];
      }

      return baseFind(type, options);
    }) as unknown as Room['find'];
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: {
        getRangeTo: jest.fn((target: RoomObject) => {
          const ranges: Record<string, number> = {
            controller1: 5,
            'wall-site1': 8,
            'drop-surplus': 5
          };
          return ranges[String((target as { id?: string }).id)] ?? 99;
        }),
        findPathTo: jest.fn().mockReturnValue([])
      },
      room
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
    expect(creep.pos.findPathTo).not.toHaveBeenCalled();
  });

  it('uses nearby non-critical repair before stored-surplus controller upgrading', () => {
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const road = makeStructure('road-damaged', 'road' as StructureConstant, 4_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'road-damaged': 2,
        controller1: 8
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({ controller, structures: [storage, road] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-damaged' });
  });

  it('keeps controller upgrade when a nearby repair target is already complete', () => {
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const fullRoad = makeStructure('road-full', 'road' as StructureConstant, 5_000, 5_000);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'road-full': 1,
        controller1: 8
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { getRangeTo },
      room: makeWorkerTaskRoom({ controller, structures: [storage, fullRoad] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps extension construction before stored-surplus controller upgrading', () => {
    const site = { id: 'extension-site1', structureType: 'extension' } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [storage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'extension-site1' });
  });

  it('keeps critical repair before stored-surplus controller upgrading', () => {
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const road = makeStructure('road-critical', 'road' as StructureConstant, 1_000, 5_000, {
      pos: makeRoomPosition(12, 10)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [storage, road]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-critical' });
  });

  it('keeps critical road construction before stored-surplus controller upgrading', () => {
    const site = {
      id: 'road-site1',
      structureType: 'road',
      pos: makeRoomPosition(12, 10)
    } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [storage]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-site1' });
  });

  it('keeps controller-source critical road construction before stored-surplus controller upgrading', () => {
    const site = {
      id: 'road-controller-source-site1',
      structureType: 'road',
      pos: makeRoomPosition(40, 25)
    } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 40, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      pos: makeRoomPosition(40, 40),
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [storage]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'road-controller-source-site1' });
  });

  it('keeps stored-surplus controller upgrading before off-route road construction', () => {
    const site = {
      id: 'road-off-route',
      structureType: 'road',
      pos: makeRoomPosition(10, 20)
    } as ConstructionSite;
    const storage = makeStoredEnergyStructure('storage-surplus', 'storage' as StructureConstant, 1_000, {
      my: true
    });
    const fullSpawn = makeEnergySink('spawn-full', 'spawn' as StructureConstant, 0, {
      pos: makeRoomPosition(10, 10)
    });
    const source = makeSource('source1', 20, 10);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [fullSpawn as AnyOwnedStructure],
        sources: [source],
        structures: [storage]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('does not treat unsafe stored energy as controller upgrade surplus', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const hostileStorage = makeStoredEnergyStructure('hostile-storage', 'storage' as StructureConstant, 1_000, {
      my: false
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, structures: [hostileStorage] })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it('selects RCL3 controller upgrade before non-critical construction when another loaded worker can build', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({ Builder: makeLoadedWorker(room) });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps non-critical build priority when another loaded worker is already upgrading the controller', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> })
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'wall-site1' });
  });

  it('allows a second RCL3 controller pressure upgrader when several loaded workers can cover construction', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      BuilderA: makeLoadedWorker(room),
      BuilderB: makeLoadedWorker(room)
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('bounds RCL3 controller pressure once two loaded workers are already upgrading', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = {
      name: 'W1N1',
      controller,
      find: jest.fn((type) => (type === 2 ? [site] : []))
    } as unknown as Room;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({
      UpgraderA: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      UpgraderB: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      Builder: makeLoadedWorker(room)
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'wall-site1' });
  });

  it('upgrades a loaded surplus worker when controller upgrading is saturated', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller });
    const creep = {
      name: 'SurplusWorker',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      SurplusWorker: creep
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('still allows controller upgrade fallback at max RCL level', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 8,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller });
    const creep = {
      name: 'SurplusWorker',
      memory: { role: 'worker' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;

    setGameCreeps({
      SurplusWorker: creep
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('allows downgrade-prevention upgrades on max RCL controllers', () => {
    expect(
      canUpgradeController({
        my: true,
        level: 8
      } as StructureController)
    ).toBe(true);
  });

  it('blocks leveling at max RCL level', () => {
    expect(
      canLevelUpController({
        my: true,
        level: 8
      } as StructureController)
    ).toBe(false);
  });

  it('blocks leveling when controller level is invalid', () => {
    expect(canLevelUpController({ my: true, level: null as unknown as number } as StructureController)).toBe(false);
    expect(canLevelUpController({ my: true } as StructureController)).toBe(false);
    expect(canLevelUpController({ my: true, level: Number.NaN } as StructureController)).toBe(false);
    expect(canLevelUpController({ my: true, level: Infinity } as StructureController)).toBe(false);
    expect(canLevelUpController({ my: true, level: '8' as unknown as number } as StructureController)).toBe(false);
  });

  it('does not send an empty surplus worker harvesting when controller upgrading is saturated', () => {
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const source = makeSource('source1', 20, 20);
    const room = makeWorkerTaskRoom({ controller, sources: [source] });
    const creep = {
      name: 'SurplusWorker',
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    setGameCreeps({
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      SurplusWorker: creep
    });

    expect(selectWorkerTask(creep)).toBeNull();
  });

  it('keeps saturated surplus workers hauling container energy to spawn refill', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300, {
      pos: makeRoomPosition(10, 10)
    });
    const container = withRangeTo(
      makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 500, {
        pos: makeRoomPosition(10, 11)
      }),
      { spawn1: 1 }
    );
    const source = withRangeTo(makeSource('source1', 11, 10), { spawn1: 1 }) as unknown as Source;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      controller,
      myStructures: [spawn as AnyOwnedStructure],
      sources: [source],
      structures: [container]
    });
    const creep = {
      name: 'Hauler',
      memory: { role: 'worker' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container-near' ? 1 : 2))
      },
      room
    } as unknown as Creep;
    setGameCreeps({
      Hauler: creep,
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> })
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near' });
  });

  it('allows a third stable-room controller upgrader when spawn energy is full', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      controller,
      energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
      energyCapacityAvailable: TERRITORY_CONTROLLER_BODY_COST
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    recordSurvivalMode('TERRITORY_READY', 700);
    setGameCreeps({
      UpgraderA: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      UpgraderB: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      BuilderA: makeLoadedWorker(room),
      BuilderB: makeLoadedWorker(room)
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('bounds stable-room surplus controller pressure once three workers are upgrading', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      controller,
      energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
      energyCapacityAvailable: TERRITORY_CONTROLLER_BODY_COST
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    recordSurvivalMode('TERRITORY_READY', 701);
    setGameCreeps({
      UpgraderA: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      UpgraderB: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      UpgraderC: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      Builder: makeLoadedWorker(room)
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'wall-site1' });
  });

  it('keeps active territory pressure capped at one controller upgrader', () => {
    const site = { id: 'wall-site1', structureType: 'constructedWall' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [site],
      controller,
      energyAvailable: TERRITORY_CONTROLLER_BODY_COST,
      energyCapacityAvailable: TERRITORY_CONTROLLER_BODY_COST
    });
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    recordSurvivalMode('TERRITORY_READY', 702);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W2N1', action: 'reserve', status: 'planned', updatedAt: 702 }]
      }
    };
    setGameCreeps({
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }),
      BuilderA: makeLoadedWorker(room),
      BuilderB: makeLoadedWorker(room),
      BuilderC: makeLoadedWorker(room)
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'wall-site1' });
  });

  it('steers an empty worker to source2 when source2 is near the owned controller', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const controller = {
      id: 'controller1',
      my: true,
      level: 8,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, sources: [source1, source2] });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('keeps an empty source2/controller lane worker on source2 before room-wide stored energy', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const container = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 500);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, sources: [source1, source2], structures: [container] });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('withdraws from a nearby container before direct source2/controller lane harvesting', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const container = makeStoredEnergyStructure('container-near', 'container' as StructureConstant, 500, {
      pos: makeRoomPosition(8, 9)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, sources: [source1, source2], structures: [container] });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'container-near' ? 2 : 1))
      },
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-near' });
  });

  it('withdraws from a stocked container before distant source2/controller lane harvesting', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const container = makeStoredEnergyStructure('container-buffered', 'container' as StructureConstant, 200, {
      pos: makeRoomPosition(18, 18)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, sources: [source1, source2], structures: [container] });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => {
          const ranges: Record<string, number> = {
            'container-buffered': 6,
            source2: 12
          };
          return ranges[String(target.id)] ?? 99;
        })
      },
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'container-buffered' });
  });

  it('keeps close source2/controller lane harvesting before a very distant stocked container', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const container = makeStoredEnergyStructure('container-distant', 'container' as StructureConstant, 500, {
      pos: makeRoomPosition(5, 5)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, sources: [source1, source2], structures: [container] });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => {
          const ranges: Record<string, number> = {
            'container-distant': 20,
            source2: 2
          };
          return ranges[String(target.id)] ?? 99;
        })
      },
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source2' });
  });

  it('picks up nearby dropped energy before direct source2/controller lane harvesting', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const droppedEnergy = { id: 'drop-near', resourceType: 'energy', amount: 50 } as Resource<ResourceConstant>;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, sources: [source1, source2] });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'drop-near' ? 2 : 1)),
        findPathTo: jest.fn((target: { id?: string }) => (target.id === 'drop-near' ? [{}] : []))
      },
      room: {
        ...room,
        find: jest.fn((type: number) => {
          if (type === FIND_DROPPED_RESOURCES) {
            return [droppedEnergy];
          }

          return (room.find as unknown as (findType: number) => unknown[])(type);
        })
      }
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'pickup', targetId: 'drop-near' });
  });

  it('withdraws from nearby storage before direct source2/controller lane harvesting', () => {
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const storage = makeStoredEnergyStructure('storage-near', 'storage' as StructureConstant, 2_000, {
      my: true,
      pos: makeRoomPosition(8, 9)
    });
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ controller, sources: [source1, source2], structures: [storage] });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'storage-near' ? 2 : 1))
      },
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'withdraw', targetId: 'storage-near' });
  });

  it('routes an empty worker to the fastest spawn recovery harvest before the source2/controller lane', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300, {
      pos: makeRoomPosition(10, 10)
    });
    const source1 = {
      ...makeSource('source1', 11, 10),
      pos: {
        ...makeRoomPosition(11, 10),
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'spawn1' ? 1 : 99))
      }
    } as unknown as Source;
    const source2 = {
      ...makeSource('source2', 24, 23),
      pos: {
        ...makeRoomPosition(24, 23),
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'spawn1' ? 20 : 99))
      }
    } as unknown as Source;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({
      controller,
      myStructures: [spawn as AnyOwnedStructure],
      sources: [source1, source2]
    });
    const creep = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => {
          const ranges: Record<string, number> = {
            source1: 1,
            source2: 8
          };
          return ranges[String(target.id)] ?? 99;
        })
      },
      room
    } as unknown as Creep;
    setGameCreeps({ RecoveryWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source1' });
  });

  it('keeps spawn recovery direct harvest room-local when an adjacent claimed source is faster', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300, {
      pos: makeRoomPosition(10, 10, 'W1N1')
    });
    const homeSource = withRangeTo(makeSource('source-home', 40, 40, 'W1N1'), { spawn1: 20 }) as unknown as Source;
    const adjacentSource = withRangeTo(makeSource('source-adjacent', 2, 25, 'W2N1'), {
      spawn1: 1
    }) as unknown as Source;
    const homeRoom = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [homeSource]
    });
    const adjacentRoom = makeWorkerTaskRoom({
      controller: { id: 'controller2', my: true, level: 2 } as StructureController,
      name: 'W2N1',
      sources: [adjacentSource]
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {},
      map: { describeExits: jest.fn().mockReturnValue({ '3': 'W2N1' }) } as unknown as GameMap,
      rooms: { W1N1: homeRoom, W2N1: adjacentRoom }
    };
    const creep = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'source-adjacent' ? 1 : 20))
      },
      room: homeRoom
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-home' });
  });

  it('uses a load-ready source over a closer low-energy source for spawn recovery harvest', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 50);
    const lowEnergySource = withRangeTo(makeSource('source-low', 11, 10, 10), { spawn1: 1 }) as unknown as Source;
    const loadReadySource = withRangeTo(makeSource('source-ready', 12, 10, 300), {
      spawn1: 5
    }) as unknown as Source;
    const room = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [lowEnergySource, loadReadySource]
    });
    const creep = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => (target.id === 'source-low' ? 1 : 8))
      },
      room
    } as unknown as Creep;
    setGameCreeps({ RecoveryWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-ready' });
  });

  it('prefers an underloaded spawn recovery harvest over a one-tick faster saturated source', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const saturatedSource = withRangeTo(makeSource('source-saturated', 11, 10), { spawn1: 1 }) as unknown as Source;
    const underloadedSource = withRangeTo(makeSource('source-underloaded', 12, 10), {
      spawn1: 1
    }) as unknown as Source;
    const room = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [saturatedSource, underloadedSource]
    });
    const creep = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => {
          const ranges: Record<string, number> = {
            'source-saturated': 1,
            'source-underloaded': 2
          };
          return ranges[String(target.id)] ?? 99;
        })
      },
      room
    } as unknown as Creep;
    setGameCreeps({
      AssignedHarvester: {
        memory: { role: 'worker', task: { type: 'harvest', targetId: saturatedSource.id } },
        room
      } as unknown as Creep,
      RecoveryWorker: creep
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-underloaded' });
  });

  it('balances spawn recovery harvest by assigned worker work parts', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const heavySource = withRangeTo(makeSource('source-heavy', 11, 10), { spawn1: 1 }) as unknown as Source;
    const lightSource = withRangeTo(makeSource('source-light', 12, 10), { spawn1: 1 }) as unknown as Source;
    const room = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [heavySource, lightSource]
    });
    const creep = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: {
        getRangeTo: jest.fn((target: { id?: string }) => {
          const ranges: Record<string, number> = {
            'source-heavy': 1,
            'source-light': 2
          };
          return ranges[String(target.id)] ?? 99;
        })
      },
      room
    } as unknown as Creep;
    setGameCreeps({
      HeavyHarvester: {
        getActiveBodyparts: jest.fn().mockReturnValue(4),
        memory: { role: 'worker', task: { type: 'harvest', targetId: heavySource.id } },
        room
      } as unknown as Creep,
      LightHarvester: {
        getActiveBodyparts: jest.fn().mockReturnValue(1),
        memory: { role: 'worker', task: { type: 'harvest', targetId: lightSource.id } },
        room
      } as unknown as Creep,
      RecoveryWorker: creep
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-light' });
  });

  it('keeps spawn recovery harvest selection deterministic by source id when load and eta tie', () => {
    const spawn = makeEnergySink('spawn1', 'spawn' as StructureConstant, 300);
    const laterSource = withRangeTo(makeSource('source-b', 11, 10), { spawn1: 1 }) as unknown as Source;
    const firstSource = withRangeTo(makeSource('source-a', 12, 10), { spawn1: 1 }) as unknown as Source;
    const room = makeWorkerTaskRoom({
      myStructures: [spawn as AnyOwnedStructure],
      sources: [laterSource, firstSource]
    });
    const creep = {
      name: 'RecoveryWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: {
        getUsedCapacity: jest.fn().mockReturnValue(0),
        getFreeCapacity: jest.fn().mockReturnValue(50)
      },
      pos: { getRangeTo: jest.fn().mockReturnValue(1) },
      room
    } as unknown as Creep;
    setGameCreeps({ RecoveryWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'harvest', targetId: 'source-a' });
  });

  it('routes a loaded source2/controller lane worker to upgrade before far generic construction', () => {
    const site = {
      id: 'tower-site1',
      structureType: 'tower',
      pos: makeRoomPosition(34, 34)
    } as ConstructionSite;
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller, sources: [source1, source2] });
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'tower-site1': 9,
        controller1: 1
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { ...makeRoomPosition(25, 24), getRangeTo } as unknown as RoomPosition,
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('uses nearby generic construction before source2/controller lane upgrade', () => {
    const site = {
      id: 'tower-site1',
      structureType: 'tower',
      pos: makeRoomPosition(26, 24)
    } as ConstructionSite;
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller, sources: [source1, source2] });
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        'tower-site1': 1,
        controller1: 3
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { ...makeRoomPosition(25, 24), getRangeTo } as unknown as RoomPosition,
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it('finishes source2/controller lane construction before a closer unfinished build target', () => {
    (globalThis as unknown as { BUILD_POWER: number }).BUILD_POWER = 5;
    const unfinishedSite = {
      id: 'tower-unfinished',
      structureType: 'tower',
      progress: 0,
      progressTotal: 1_000,
      pos: makeRoomPosition(26, 24)
    } as ConstructionSite;
    const finishableSite = {
      id: 'tower-finishable',
      structureType: 'tower',
      progress: 250,
      progressTotal: 500,
      pos: makeRoomPosition(27, 24)
    } as ConstructionSite;
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({
      constructionSites: [unfinishedSite, finishableSite],
      controller,
      sources: [source1, source2]
    });
    const getRangeTo = jest.fn((target: RoomObject) => {
      const ranges: Record<string, number> = {
        controller1: 4,
        'tower-finishable': 3,
        'tower-unfinished': 1
      };
      return ranges[String((target as { id?: string }).id)] ?? 99;
    });
    const creep = {
      name: 'LaneWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      pos: { ...makeRoomPosition(25, 24), getRangeTo } as unknown as RoomPosition,
      room
    } as unknown as Creep;
    setGameCreeps({ LaneWorker: creep });

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-finishable' });
  });

  it.each([
    ['spawn', 'spawn1'],
    ['extension', 'extension1']
  ])('keeps %s refill ahead of the source2/controller lane', (structureType, sinkId) => {
    const energySink = makeEnergySink(sinkId, structureType as StructureConstant, 50);
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        myStructures: [energySink as AnyOwnedStructure],
        sources: [source1, source2]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: sinkId });
  });

  it('keeps controller downgrade guard above lane occupancy', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const room = makeWorkerTaskRoom({ constructionSites: [site], controller, sources: [source1, source2] });
    const creep = {
      name: 'GuardWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room
    } as unknown as Creep;
    setGameCreeps({
      Upgrader: makeLoadedWorker(room, { type: 'upgrade', targetId: 'controller1' as Id<StructureController> })
    });

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it.each([
    ['missing source position', [makeSource('source1', 8, 8), { id: 'source2', energy: 300 } as Source]],
    [
      'source position without roomName',
      [
        makeSource('source1', 8, 8),
        { id: 'source2', energy: 300, pos: { x: 24, y: 23 } as RoomPosition } as Source
      ]
    ],
    ['far source2/controller topology', [makeSource('source1', 8, 8), makeSource('source2', 40, 40)]]
  ])('falls back to existing worker behavior with %s', (_label, sources) => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const creep = {
      name: 'FallbackWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({ constructionSites: [site], controller, sources })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it('falls back to existing worker behavior when the source2/controller lane is unsafe', () => {
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
    const hostile = { id: 'hostile1' } as Creep;
    const source1 = makeSource('source1', 8, 8);
    const source2 = makeSource('source2', 24, 23);
    const controller = {
      id: 'controller1',
      my: true,
      level: 3,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1,
      pos: makeRoomPosition(25, 25)
    } as StructureController;
    const creep = {
      name: 'FallbackWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: makeWorkerTaskRoom({
        constructionSites: [site],
        controller,
        hostileCreeps: [hostile],
        sources: [source1, source2]
      })
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'tower-site1' });
  });

  it.each([
    ['road', 'road-site1'],
    ['container', 'container-site1']
  ])('keeps low-downgrade guard above %s construction at RCL2', (structureType, id) => {
    const site = { id, structureType } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 2,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps spawn refill priority over RCL1 controller rush', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const site = { id: 'site1' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      level: 1,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS + 1
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === 3) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it('keeps spawn refill priority over the controller pressure lane', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const site = { id: 'tower-site1', structureType: 'tower' } as ConstructionSite;
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
    const creep = {
      memory: { role: 'worker', colony: 'W1N1' },
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        name: 'W1N1',
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
          if (type === FIND_MY_STRUCTURES) {
            const structures = [spawn];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === FIND_CONSTRUCTION_SITES ? [site] : [];
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'transfer', targetId: 'spawn1' });
  });

  it.each([
    ['spawn', 'spawn1', CONTROLLER_DOWNGRADE_GUARD_TICKS],
    ['extension', 'extension1', CONTROLLER_DOWNGRADE_GUARD_TICKS - 1]
  ])('keeps low-downgrade guard before %s refill', (structureType, sinkId, ticksToDowngrade) => {
    const energySink = {
      id: sinkId,
      structureType,
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn | StructureExtension;
    const site = { id: 'site1' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: true,
      ticksToDowngrade
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn | StructureExtension) => boolean }) => {
          if (type === 3) {
            const structures = [energySink];
            return options?.filter ? structures.filter(options.filter) : structures;
          }

          return type === 2 ? [site] : [];
        })
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps build priority for low downgrade data on unowned controllers', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const controller = {
      id: 'controller1',
      my: false,
      ticksToDowngrade: CONTROLLER_DOWNGRADE_GUARD_TICKS
    } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('keeps build priority when owned controller downgrade data is missing', () => {
    const site = { id: 'site1' } as ConstructionSite;
    const controller = { id: 'controller1', my: true } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === 2 ? [site] : []))
      }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toEqual({ type: 'build', targetId: 'site1' });
  });

  it('selects upgrade when worker has energy and no construction sites exist', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { controller, find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('selects damaged road repair before idle controller upgrading', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const fullRoad = makeStructure('road-full', 'road' as StructureConstant, 5_000, 5_000);
    const damagedRoad = makeStructure('road-damaged', 'road' as StructureConstant, 3_000, 5_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [fullRoad, damagedRoad] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-damaged' });
  });

  it('chooses repair targets deterministically and avoids hostile structures', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const hostileRampart = makeStructure('rampart-hostile', 'rampart' as StructureConstant, 100, 1_000, {
      my: false
    });
    const damagedContainer = makeStructure('container-damaged', 'container' as StructureConstant, 1_100, 2_000);
    const roadB = makeStructure('road-b', 'road' as StructureConstant, 2_500, 5_000);
    const roadA = makeStructure('road-a', 'road' as StructureConstant, 2_500, 5_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [hostileRampart, damagedContainer, roadB, roadA] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'road-a' });
  });

  it('selects owned ramparts below the idle repair ceiling', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const rampart = makeStructure(
      'rampart-low',
      'rampart' as StructureConstant,
      IDLE_RAMPART_REPAIR_HITS_CEILING - 1,
      300_000_000,
      { my: true }
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'rampart-low' });
  });

  it('skips owned ramparts at the idle repair ceiling without blocking container repair', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const rampart = makeStructure(
      'rampart-ceiling',
      'rampart' as StructureConstant,
      IDLE_RAMPART_REPAIR_HITS_CEILING,
      300_000_000,
      { my: true }
    );
    const container = makeStructure('container-damaged', 'container' as StructureConstant, 1_000, 2_000);
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart, container] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'repair', targetId: 'container-damaged' });
  });

  it('falls back to upgrade when only owned ramparts above the idle repair ceiling are damaged', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const rampart = makeStructure(
      'rampart-high',
      'rampart' as StructureConstant,
      IDLE_RAMPART_REPAIR_HITS_CEILING + 1,
      300_000_000,
      { my: true }
    );
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [rampart] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('falls back to upgrade when no safe damaged repair targets exist', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const fullRoad = makeStructure('road-full', 'road' as StructureConstant, 5_000, 5_000);
    const hostileRampart = makeStructure('rampart-hostile', 'rampart' as StructureConstant, 100, 1_000, {
      my: false
    });
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: {
        controller,
        find: jest.fn((type) => (type === FIND_STRUCTURES ? [fullRoad, hostileRampart] : []))
      }
    } as unknown as Creep;

    expect(selectWorkerTask(creep)).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('keeps carried-energy fallback order as transfer, build, repair, then upgrade', () => {
    const spawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(300) }
    } as unknown as StructureSpawn;
    const fullSpawn = {
      id: 'spawn1',
      structureType: 'spawn',
      store: { getFreeCapacity: jest.fn().mockReturnValue(0) }
    } as unknown as StructureSpawn;
    const site = { id: 'site1' } as ConstructionSite;
    const controller = { id: 'controller1', my: true } as StructureController;
    const road = makeStructure('road-damaged', 'road' as StructureConstant, 3_000, 5_000);
    const makeCreep = (room: Room): Creep =>
      ({
        store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
        room
      }) as unknown as Creep;

    const roomWithSink = {
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === 3) {
          const structures = [spawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === 2 ? [site] : [];
      })
    } as unknown as Room;
    const roomWithSite = {
      controller,
      find: jest.fn((type: number, options?: { filter?: (structure: StructureSpawn) => boolean }) => {
        if (type === 3) {
          const structures = [fullSpawn];
          return options?.filter ? structures.filter(options.filter) : structures;
        }

        return type === 2 ? [site] : [];
      })
    } as unknown as Room;
    const roomWithRepair = {
      controller,
      find: jest.fn((type: number) => (type === FIND_STRUCTURES ? [road] : []))
    } as unknown as Room;
    const roomWithController = {
      controller,
      find: jest.fn().mockReturnValue([])
    } as unknown as Room;

    expect(selectWorkerTask(makeCreep(roomWithSink))).toEqual({ type: 'transfer', targetId: 'spawn1' });
    expect(selectWorkerTask(makeCreep(roomWithSite))).toEqual({ type: 'build', targetId: 'site1' });
    expect(selectWorkerTask(makeCreep(roomWithRepair))).toEqual({ type: 'repair', targetId: 'road-damaged' });
    expect(selectWorkerTask(makeCreep(roomWithController))).toEqual({ type: 'upgrade', targetId: 'controller1' });
  });

  it('selects no task when worker has energy and the room has no spending targets or controller', () => {
    const creep = {
      store: { getUsedCapacity: jest.fn().mockReturnValue(50) },
      room: { find: jest.fn().mockReturnValue([]) }
    } as unknown as Creep;
    let task: CreepTaskMemory | null | undefined;

    expect(() => {
      task = selectWorkerTask(creep);
    }).not.toThrow();
    expect(task).toBeNull();
  });
});
