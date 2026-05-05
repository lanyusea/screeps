import { runEconomy } from '../src/economy/economyLoop';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_BUSY_CODE = -4 as ScreepsReturnCode;
const ERR_NOT_ENOUGH_RESOURCES_CODE = -6 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

describe('spawn survival integration', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    installScreepsGlobals();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('recovers from complete energy drain without getting stuck in bootstrap starvation', () => {
    const harness = createSpawnSurvivalHarness();
    harness.install();

    harness.runTick(100, 0);
    expect(harness.spawn.spawnCreep).not.toHaveBeenCalled();
    expect(harness.room.memory.colonyStage).toEqual({
      mode: 'BOOTSTRAP',
      updatedAt: 100,
      suppressionReasons: ['bootstrapWorkerFloor', 'spawnEnergyCritical']
    });

    harness.runTick(101, 199);
    expectSpawnHasEnergyOrWorker(harness);
    expect(harness.spawn.spawnCreep).not.toHaveBeenCalled();
    expect(harness.room.memory.colonyStage).toEqual({
      mode: 'BOOTSTRAP',
      updatedAt: 101,
      suppressionReasons: ['bootstrapWorkerFloor', 'spawnEnergyCritical']
    });

    harness.runTick(102, 200);
    expectSpawnHasEnergyOrWorker(harness);
    expect(harness.spawn.spawnCreep).toHaveBeenLastCalledWith(
      ['work', 'carry', 'move'],
      'worker-W1N1-102',
      { memory: { role: 'worker', colony: 'W1N1' } }
    );
    expect(harness.spawnedBodies()).toEqual([['work', 'carry', 'move']]);
    expect(harness.workerNames()).toEqual(['worker-W1N1-102']);
    expect(harness.room.memory.colonyStage).toEqual({
      mode: 'BOOTSTRAP',
      updatedAt: 102,
      suppressionReasons: ['bootstrapWorkerFloor', 'spawnEnergyCritical']
    });

    harness.runTick(103, 200);
    expectSpawnHasEnergyOrWorker(harness);
    harness.runTick(104, 200);
    expectSpawnHasEnergyOrWorker(harness);
    expect(harness.workerNames()).toEqual(['worker-W1N1-102', 'worker-W1N1-103', 'worker-W1N1-104']);
    expect(harness.spawnedBodies().slice(0, 3)).toEqual([
      ['work', 'carry', 'move'],
      ['work', 'carry', 'move'],
      ['work', 'carry', 'move']
    ]);
    expect(harness.room.memory.colonyStage).toMatchObject({
      mode: 'BOOTSTRAP',
      updatedAt: 104
    });

    harness.runTick(105, 300);
    expectSpawnHasEnergyOrWorker(harness);
    expect(harness.spawnedBodies()[3]).toEqual(['work', 'carry', 'move', 'move']);
    expect(harness.room.memory.colonyStage).toMatchObject({
      mode: 'BOOTSTRAP',
      updatedAt: 105,
      suppressionReasons: ['bootstrapRecovery']
    });

    harness.runTick(106, 400);
    expectSpawnHasEnergyOrWorker(harness);
    expect(harness.spawnedBodies()[4]).toEqual(['work', 'carry', 'move', 'work', 'carry', 'move']);
    expect(harness.workerNames()).toHaveLength(5);
    expect(harness.room.memory.colonyStage).toMatchObject({
      mode: 'BOOTSTRAP',
      updatedAt: 106,
      suppressionReasons: ['bootstrapRecovery']
    });

    harness.runTick(107, 800);
    expectSpawnHasEnergyOrWorker(harness);
    expectTerritoryReadyKeepsWorkers(harness);
    expect(harness.workerNames()).toHaveLength(5);
    expect(harness.spawn.spawnCreep).toHaveBeenCalledTimes(5);
    expect(harness.room.memory.colonyStage).toEqual({
      mode: 'TERRITORY_READY',
      updatedAt: 107
    });

    harness.runTick(108, 800);
    expectSpawnHasEnergyOrWorker(harness);
    expectTerritoryReadyKeepsWorkers(harness);
    expect(harness.spawn.spawnCreep).toHaveBeenCalledTimes(5);
    expect(harness.workerNames()).toHaveLength(5);
    expect(harness.room.memory.colonyStage).toEqual({
      mode: 'TERRITORY_READY',
      updatedAt: 108
    });
    expect(Memory.economy?.sourceWorkloads?.W1N1?.updatedAt).toBe(108);
    expect(
      harness
        .spawnedBodies()
        .every((body) => body.length > 0 && body.reduce((total, part) => total + getBodyPartCost(part), 0) <= 400)
    ).toBe(true);

    for (let tick = 109; tick <= 300; tick += 1) {
      harness.runTick(tick, 800);
      expectSpawnHasEnergyOrWorker(harness);
      expectTerritoryReadyKeepsWorkers(harness);
    }
  });
});

interface SpawnSurvivalHarness {
  room: Room & { energyAvailable: number; memory: RoomMemory };
  spawn: LifecycleSpawn;
  install(): void;
  runTick(tick: number, energyAvailable: number): void;
  spawnedBodies(): BodyPartConstant[][];
  workerNames(): string[];
}

interface LifecycleSpawn extends StructureSpawn {
  spawnCreep: jest.Mock<ScreepsReturnCode, Parameters<StructureSpawn['spawnCreep']>>;
  completeSpawn(): void;
  spawnedBodies(): BodyPartConstant[][];
}

function createSpawnSurvivalHarness(): SpawnSurvivalHarness {
  const creeps: Record<string, Creep> = {};
  const sources = [
    makeSource('source1', 10, 10),
    makeSource('source2', 40, 10)
  ];
  const room = makeRoom(sources, creeps);
  const spawn = createLifecycleSpawn(room, creeps);
  const storage = makeStorage('storage1', 24, 24);
  const links = [
    makeLink('source-link-1', 11, 10, 400, 400),
    makeLink('source-link-2', 39, 10, 400, 400),
    makeLink('controller-link', 25, 24, 0, 200),
    makeLink('storage-link', 23, 24, 0, 800)
  ];
  const ownedStructures: AnyOwnedStructure[] = [
    spawn as unknown as AnyOwnedStructure,
    storage as unknown as AnyOwnedStructure,
    ...links.map((link) => link as unknown as AnyOwnedStructure)
  ];
  setRoomOwnedStructures(room, ownedStructures);

  return {
    room,
    spawn,
    install: () => {
      (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
        rooms: {
          W1N1: room.memory
        }
      };
      (globalThis as unknown as { Game: Partial<Game> }).Game = {
        time: 0,
        rooms: { W1N1: room },
        spawns: { Spawn1: spawn },
        creeps,
        getObjectById: jest.fn((id: string) => {
          if (id === 'controller1') {
            return room.controller;
          }

          return sources.find((source) => source.id === id) ?? null;
        }) as Game['getObjectById'],
        map: {
          describeExits: jest.fn().mockReturnValue({}),
          findRoute: jest.fn().mockReturnValue([]),
          getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
        } as unknown as GameMap
      };
    },
    runTick: (tick: number, energyAvailable: number) => {
      Game.time = tick;
      room.energyAvailable = energyAvailable;
      runEconomy();
      spawn.completeSpawn();
    },
    spawnedBodies: () => spawn.spawnedBodies(),
    workerNames: () => Object.keys(creeps).sort()
  };
}

function installScreepsGlobals(): void {
  Object.assign(globalThis, {
    ATTACK: 'attack',
    CLAIM: 'claim',
    CARRY: 'carry',
    MOVE: 'move',
    WORK: 'work',
    FIND_SOURCES: 1,
    FIND_MY_STRUCTURES: 2,
    FIND_MY_CONSTRUCTION_SITES: 3,
    FIND_STRUCTURES: 4,
    FIND_CONSTRUCTION_SITES: 5,
    FIND_HOSTILE_CREEPS: 6,
    FIND_HOSTILE_STRUCTURES: 7,
    FIND_MY_CREEPS: 8,
    FIND_DROPPED_RESOURCES: 9,
    FIND_TOMBSTONES: 10,
    FIND_RUINS: 11,
    LOOK_STRUCTURES: 'structure',
    LOOK_CONSTRUCTION_SITES: 'constructionSite',
    LOOK_MINERALS: 'mineral',
    RESOURCE_ENERGY: 'energy',
    STRUCTURE_CONTAINER: 'container',
    STRUCTURE_EXTENSION: 'extension',
    STRUCTURE_LINK: 'link',
    STRUCTURE_RAMPART: 'rampart',
    STRUCTURE_ROAD: 'road',
    STRUCTURE_SPAWN: 'spawn',
    STRUCTURE_STORAGE: 'storage',
    STRUCTURE_TERMINAL: 'terminal',
    STRUCTURE_TOWER: 'tower',
    STRUCTURE_WALL: 'constructedWall',
    TERRAIN_MASK_WALL: 1,
    OK: OK_CODE,
    ERR_BUSY: ERR_BUSY_CODE,
    ERR_NOT_ENOUGH_RESOURCES: ERR_NOT_ENOUGH_RESOURCES_CODE,
    ERR_INVALID_TARGET: ERR_INVALID_TARGET_CODE,
    ERR_FULL: ERR_FULL_CODE,
    ERR_NOT_IN_RANGE: ERR_NOT_IN_RANGE_CODE
  });
}

function makeRoom(
  sources: Source[],
  creeps: Record<string, Creep>
): Room & { energyAvailable: number; memory: RoomMemory } {
  const roomMemory: RoomMemory = {};
  let ownedStructures: AnyOwnedStructure[] = [];
  const constructionSites: ConstructionSite[] = [];
  const room = {
    name: 'W1N1',
    energyAvailable: 0,
    energyCapacityAvailable: 800,
    memory: roomMemory,
    controller: {
      id: 'controller1' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 8,
      ticksToDowngrade: 10_000,
      pos: makeRoomPosition(25, 25),
      sign: undefined
    } as StructureController,
    find: jest.fn((type: number, options?: { filter?: (value: never) => boolean }) => {
      const result = findRoomObjects(type, sources, creeps, ownedStructures, constructionSites);
      return options?.filter ? result.filter(options.filter as (value: unknown) => boolean) : result;
    }),
    lookForAtArea: jest.fn().mockReturnValue([]),
    createConstructionSite: jest.fn((x: number, y: number, structureType: BuildableStructureConstant) => {
      constructionSites.push({
        id: `site-${x}-${y}-${structureType}` as Id<ConstructionSite>,
        structureType,
        pos: makeRoomPosition(x, y),
        progress: 0,
        progressTotal: 1
      } as ConstructionSite);
      return OK_CODE;
    }),
    getOwnedStructures: () => ownedStructures,
    setOwnedStructures: (structures: AnyOwnedStructure[]) => {
      ownedStructures = structures;
    }
  };

  return room as unknown as Room & { energyAvailable: number; memory: RoomMemory };
}

function setRoomOwnedStructures(room: Room, structures: AnyOwnedStructure[]): void {
  (room as unknown as { setOwnedStructures(structures: AnyOwnedStructure[]): void }).setOwnedStructures(structures);
}

function findRoomObjects(
  type: number,
  sources: Source[],
  creeps: Record<string, Creep>,
  ownedStructures: AnyOwnedStructure[],
  constructionSites: ConstructionSite[]
): unknown[] {
  switch (type) {
    case FIND_SOURCES:
      return sources;
    case FIND_MY_CREEPS:
      return Object.values(creeps);
    case FIND_MY_STRUCTURES:
    case FIND_STRUCTURES:
      return ownedStructures;
    case FIND_MY_CONSTRUCTION_SITES:
    case FIND_CONSTRUCTION_SITES:
      return constructionSites;
    case FIND_HOSTILE_CREEPS:
    case FIND_HOSTILE_STRUCTURES:
    case FIND_DROPPED_RESOURCES:
    case FIND_TOMBSTONES:
    case FIND_RUINS:
      return [];
    default:
      return [];
  }
}

function createLifecycleSpawn(room: Room, creeps: Record<string, Creep>): LifecycleSpawn {
  let spawning: Spawning | null = null;
  let pendingMemory: CreepMemory | undefined;
  let pendingBody: BodyPartConstant[] = [];
  const spawnedBodies: BodyPartConstant[][] = [];
  const spawn = {
    id: 'spawn1' as Id<StructureSpawn>,
    name: 'Spawn1',
    structureType: 'spawn' as StructureConstant,
    room,
    pos: makeRoomPosition(24, 25),
    hits: 5_000,
    hitsMax: 5_000,
    my: true,
    store: {
      getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? Math.max(0, room.energyCapacityAvailable - room.energyAvailable) : 0
      ),
      getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? room.energyAvailable : 0
      )
    },
    get spawning(): Spawning | null {
      return spawning;
    },
    spawnCreep: jest.fn((body: BodyPartConstant[], name: string, options?: SpawnOptions) => {
      if (spawning) {
        return ERR_BUSY_CODE;
      }

      const bodyCost = body.reduce((total, part) => total + getBodyPartCost(part), 0);
      if (bodyCost > room.energyAvailable) {
        return ERR_NOT_ENOUGH_RESOURCES_CODE;
      }

      pendingBody = [...body];
      pendingMemory = options?.memory;
      spawnedBodies.push([...body]);
      spawning = { name, remainingTime: 1 } as Spawning;
      return OK_CODE;
    }),
    completeSpawn: () => {
      if (!spawning) {
        return;
      }

      creeps[spawning.name] = makeWorkerCreep(spawning.name, room, pendingMemory, pendingBody);
      spawning = null;
      pendingMemory = undefined;
      pendingBody = [];
    },
    spawnedBodies: () => spawnedBodies.map((body) => [...body])
  };

  return spawn as unknown as LifecycleSpawn;
}

function makeWorkerCreep(
  name: string,
  room: Room,
  memory: CreepMemory | undefined,
  body: BodyPartConstant[]
): Creep {
  return {
    id: name as Id<Creep>,
    name,
    memory: memory ?? { role: 'worker', colony: room.name },
    room,
    body: body.map((type) => ({ type, hits: 100 })),
    ticksToLive: 1_500,
    pos: makeRoomPosition(24, 25),
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(0),
      getFreeCapacity: jest.fn().mockReturnValue(0)
    },
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => body.filter((bodyPart) => bodyPart === part).length),
    harvest: jest.fn().mockReturnValue(OK_CODE),
    transfer: jest.fn().mockReturnValue(OK_CODE),
    pickup: jest.fn().mockReturnValue(OK_CODE),
    withdraw: jest.fn().mockReturnValue(OK_CODE),
    build: jest.fn().mockReturnValue(OK_CODE),
    repair: jest.fn().mockReturnValue(OK_CODE),
    upgradeController: jest.fn().mockReturnValue(OK_CODE),
    moveTo: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as Creep;
}

function makeSource(id: string, x: number, y: number): Source {
  return {
    id: id as Id<Source>,
    energy: 3_000,
    energyCapacity: 3_000,
    pos: makeRoomPosition(x, y)
  } as Source;
}

function makeStorage(id: string, x: number, y: number): StructureStorage {
  return {
    id: id as Id<StructureStorage>,
    structureType: 'storage',
    my: true,
    pos: makeRoomPosition(x, y),
    store: {
      getUsedCapacity: jest.fn().mockReturnValue(0),
      getFreeCapacity: jest.fn().mockReturnValue(1_000_000)
    }
  } as unknown as StructureStorage;
}

function makeLink(
  id: string,
  x: number,
  y: number,
  energy: number,
  freeCapacity: number
): StructureLink {
  return {
    id: id as Id<StructureLink>,
    cooldown: 0,
    my: true,
    structureType: 'link',
    pos: makeRoomPosition(x, y),
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? energy : 0
      ),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === undefined || resource === RESOURCE_ENERGY ? freeCapacity : 0
      )
    },
    transfer: jest.fn().mockReturnValue(OK_CODE),
    transferEnergy: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as StructureLink;
}

function makeRoomPosition(x: number, y: number): RoomPosition {
  return {
    x,
    y,
    roomName: 'W1N1',
    getRangeTo: jest.fn((target: RoomObject | RoomPosition) => {
      const targetPosition = 'pos' in target ? target.pos : target;
      return Math.max(Math.abs(x - targetPosition.x), Math.abs(y - targetPosition.y));
    })
  } as unknown as RoomPosition;
}

function getBodyPartCost(part: BodyPartConstant): number {
  const costs: Record<BodyPartConstant, number> = {
    attack: 80,
    carry: 50,
    claim: 600,
    heal: 250,
    move: 50,
    ranged_attack: 150,
    tough: 10,
    work: 100
  };
  return costs[part];
}

function expectSpawnHasEnergyOrWorker(harness: SpawnSurvivalHarness): void {
  const spawnEnergy = harness.spawn.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
  expect(spawnEnergy > 0 || harness.workerNames().length >= 1).toBe(true);
}

function expectTerritoryReadyKeepsWorkers(harness: SpawnSurvivalHarness): void {
  if (harness.room.memory.colonyStage?.mode === 'TERRITORY_READY') {
    expect(harness.workerNames().length).toBeGreaterThanOrEqual(1);
  }
}
