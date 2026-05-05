import { generateHarvesterBody, planSpawn } from '../src/spawn/spawnPlanner';
import { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  persistOccupationRecommendationFollowUpIntent,
  scoreOccupationRecommendations
} from '../src/territory/occupationRecommendation';
import {
  TERRITORY_CLAIM_READY_TICKS,
  TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS,
  TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS,
  TERRITORY_SUPPRESSION_RETRY_TICKS
} from '../src/territory/territoryPlanner';

describe('planSpawn', () => {
  const MID_RCL_WORKER_PATTERN: BodyPartConstant[] = ['work', 'work', 'carry', 'move', 'move'];
  const HIGH_RCL_WORKER_PATTERN: BodyPartConstant[] = ['work', 'work', 'work', 'carry', 'move', 'move'];
  const BODY_PART_COSTS: Record<BodyPartConstant, number> = {
    move: 50,
    work: 100,
    carry: 50,
    attack: 80,
    ranged_attack: 150,
    heal: 250,
    claim: 600,
    tough: 10
  };

  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 5;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 6;
    (globalThis as unknown as { FIND_MY_CREEPS: number }).FIND_MY_CREEPS = 10;
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  function makeColony({
    sourceCount = 1,
    energyAvailable = 300,
    energyCapacityAvailable = 300,
    roomName = 'W1N1',
    constructionSiteCount = 0,
    hostileCreeps = [],
    hostileStructures = [],
    spawning = null,
    controller,
    storageEnergy,
    storageCapacity,
    ownedStructures = []
  }: {
    sourceCount?: number;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    roomName?: string;
    constructionSiteCount?: number;
    hostileCreeps?: Creep[];
    hostileStructures?: Structure[];
    spawning?: Spawning | null;
    controller?: StructureController;
    storageEnergy?: number;
    storageCapacity?: number;
    ownedStructures?: AnyOwnedStructure[];
  } = {}): { colony: ColonySnapshot; spawn: StructureSpawn; find: jest.Mock<unknown[], [number]> } {
    const sources = Array.from({ length: sourceCount }, (_, index) => ({ id: `source${index}` }) as Source);
    const constructionSites = Array.from(
      { length: constructionSiteCount },
      (_, index) => ({ id: `site${index}` }) as ConstructionSite
    );
    const find = jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_MY_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_MY_CREEPS) {
        return findMockCreepsInRoom(roomName);
      }

      if (type === FIND_MY_STRUCTURES) {
        return ownedStructures;
      }

      const hostileCreepsFind = (globalThis as Record<string, unknown>).FIND_HOSTILE_CREEPS;
      if (typeof hostileCreepsFind === 'number' && type === hostileCreepsFind) {
        return hostileCreeps;
      }

      const hostileStructuresFind = (globalThis as Record<string, unknown>).FIND_HOSTILE_STRUCTURES;
      if (typeof hostileStructuresFind === 'number' && type === hostileStructuresFind) {
        return hostileStructures;
      }

      return [];
    });
    const room = {
      name: roomName,
      energyAvailable,
      energyCapacityAvailable,
      find,
      ...(controller ? { controller } : {}),
      ...(typeof storageEnergy === 'number' && typeof storageCapacity === 'number'
        ? { storage: makeStorage(storageEnergy, storageCapacity) }
        : {})
    } as unknown as Room;
    const spawn = { name: 'Spawn1', room, spawning } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable,
      energyCapacityAvailable
    };

    return { colony, spawn, find };
  }

  function makeSafeOwnedController(): StructureController {
    return { my: true, level: 3, ticksToDowngrade: 10_000, owner: { username: 'player' } } as StructureController;
  }

  function makeStorage(energy: number, capacity: number): StructureStorage {
    return {
      store: {
        getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
        getCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0))
      }
    } as unknown as StructureStorage;
  }

  function makeRemoteHaulerStorageSink(id: string): AnyOwnedStructure {
    return {
      id,
      structureType: 'storage',
      store: {
        getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? 5_000 : 0))
      }
    } as unknown as AnyOwnedStructure;
  }

  function repeatBodyPattern(pattern: BodyPartConstant[], patternCount: number): BodyPartConstant[] {
    return Array.from({ length: patternCount }).flatMap(() => pattern);
  }

  function getBodyCost(body: BodyPartConstant[]): number {
    return body.reduce((total, part) => total + BODY_PART_COSTS[part], 0);
  }

  function installHostileFindGlobals(): void {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
  }

  function makeTerritoryRoom(roomName: string, controller: StructureController, sourceCount = 0): Room {
    return {
      name: roomName,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return Array.from({ length: sourceCount }, (_, index) => ({ id: `${roomName}-source${index}` }));
        }

        return [];
      })
    } as unknown as Room;
  }

  function makeRoomPosition(x: number, y: number, roomName: string): RoomPosition {
    return { x, y, roomName } as RoomPosition;
  }

  function makeRemoteSource(id: string, x = 10, y = 10, roomName = 'W2N1'): Source {
    return {
      id,
      energy: 300,
      pos: makeRoomPosition(x, y, roomName)
    } as unknown as Source;
  }

  function makeRemoteContainer(
    id: string,
    energy: number,
    x = 10,
    y = 11,
    roomName = 'W2N1'
  ): StructureContainer {
    return {
      id,
      structureType: 'container',
      pos: makeRoomPosition(x, y, roomName),
      store: {
        getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0))
      }
    } as unknown as StructureContainer;
  }

  function makeRemoteEconomyRoom({
    roomName = 'W2N1',
    source = makeRemoteSource(`${roomName}-source0`, 10, 10, roomName),
    container = makeRemoteContainer(`${roomName}-container0`, 0, 10, 11, roomName),
    controller = { id: `${roomName}-controller`, my: true, level: 1 } as StructureController
  }: {
    roomName?: string;
    source?: Source;
    container?: StructureContainer;
    controller?: StructureController;
  } = {}): Room {
    return {
      name: roomName,
      controller,
      find: jest.fn((type: number) => {
        if (type === FIND_SOURCES) {
          return [source];
        }

        if (type === FIND_STRUCTURES) {
          return [container];
        }

        if (type === FIND_MY_CREEPS) {
          return findMockCreepsInRoom(roomName);
        }

        return [];
      })
    } as unknown as Room;
  }

  function makeSatisfiedPostClaimRemoteMemory(targetRoom = 'W2N1'): TerritoryPostClaimBootstrapMemory {
    return {
      colony: 'W1N1',
      roomName: targetRoom,
      status: 'spawnSitePending',
      claimedAt: 500,
      updatedAt: 501,
      workerTarget: 1,
      controllerId: `${targetRoom}-controller` as Id<StructureController>
    };
  }

  function makePostClaimSustainUpgrader(targetRoom = 'W2N1'): Creep {
    return {
      memory: {
        role: 'worker',
        colony: targetRoom,
        controllerSustain: { homeRoom: 'W1N1', targetRoom, role: 'upgrader' }
      }
    } as Creep;
  }

  function makeRemoteHarvester(sourceId = 'W2N1-source0', containerId = 'W2N1-container0'): Creep {
    return {
      memory: {
        role: 'remoteHarvester',
        colony: 'W1N1',
        remoteHarvester: {
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          sourceId: sourceId as Id<Source>,
          containerId: containerId as Id<StructureContainer>
        }
      },
      room: { name: 'W2N1' } as Room,
      ticksToLive: 1_000
    } as Creep;
  }

  function findMockCreepsInRoom(roomName: string): Creep[] {
    const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
    return creeps ? Object.values(creeps).filter((creep) => creep.room?.name === roomName) : [];
  }

  it('plans a worker when the colony has no workers and an idle spawn', () => {
    const { colony, spawn } = makeColony();

    expect(planSpawn(colony, { worker: 0 }, 123)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-123',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps one-source rooms at the three-worker target', () => {
    const { colony } = makeColony({ sourceCount: 1 });

    expect(planSpawn(colony, { worker: 3 }, 123)).toBeNull();
  });

  it('plans one replacement when steady-state worker capacity is below target', () => {
    const { colony, spawn } = makeColony();

    expect(planSpawn(colony, { worker: 2 }, 124)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-124',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('plans a replacement when low-TTL workers leave steady-state capacity below target', () => {
    const { colony, spawn } = makeColony();

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 125)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-125',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('plans the full capacity worker body when currently affordable', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 400, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 134)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-134',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('uses mid-capacity room energy for worker carry and move throughput', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N13',
      energyAvailable: 550,
      energyCapacityAvailable: 550
    });

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 151)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'carry', 'move'],
      name: 'worker-W1N13-151',
      memory: { role: 'worker', colony: 'W1N13' }
    });
  });

  it('uses the RCL4 medium worker profile when full capacity is affordable', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N19',
      energyAvailable: 1300,
      energyCapacityAvailable: 1300,
      controller: { my: true, level: 4, ticksToDowngrade: 10_000 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 152)).toEqual({
      spawn,
      body: [...repeatBodyPattern(MID_RCL_WORKER_PATTERN, 3), 'work', 'move', 'carry', 'move'],
      name: 'worker-W1N19-152',
      memory: { role: 'worker', colony: 'W1N19' }
    });
  });

  it('falls back to an affordable RCL4 worker profile while room energy recovers', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N20',
      energyAvailable: 600,
      energyCapacityAvailable: 1300,
      controller: { my: true, level: 4, ticksToDowngrade: 10_000 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 153)).toEqual({
      spawn,
      body: [...MID_RCL_WORKER_PATTERN, 'work', 'move', 'carry', 'move'],
      name: 'worker-W1N20-153',
      memory: { role: 'worker', colony: 'W1N20' }
    });
  });

  it('uses the high-RCL maximum-throughput worker profile', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N21',
      energyAvailable: 5600,
      energyCapacityAvailable: 5600,
      controller: { my: true, level: 7, ticksToDowngrade: 10_000 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 154)).toEqual({
      spawn,
      body: [...repeatBodyPattern(HIGH_RCL_WORKER_PATTERN, 8), 'work', 'move'],
      name: 'worker-W1N21-154',
      memory: { role: 'worker', colony: 'W1N21' }
    });
  });

  it('generates an RCL3 harvester body within a 550 energy cap', () => {
    expect(generateHarvesterBody(550, 5)).toEqual([
      'work',
      'work',
      'work',
      'carry',
      'move',
      'move',
      'move',
      'move'
    ]);
  });

  it('generates an RCL4 harvester body within an 800 energy cap', () => {
    expect(generateHarvesterBody(800, 5)).toEqual([
      'work',
      'work',
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move',
      'move',
      'move',
      'move',
      'move'
    ]);
  });

  it('generates a full-extraction harvester body at RCL5-6 energy caps', () => {
    const body = generateHarvesterBody(1300, 10);

    expect(body.filter((part) => part === 'work')).toHaveLength(5);
    expect(body).toEqual([
      'work',
      'work',
      'work',
      'work',
      'work',
      'carry',
      'carry',
      'carry',
      'carry',
      'move',
      'move',
      'move',
      'move',
      'move',
      'move',
      'move',
      'move',
      'move'
    ]);
  });

  it('keeps generated harvester body cost within available energy', () => {
    for (const availableEnergy of [250, 300, 550, 800, 1300, 1800]) {
      expect(getBodyCost(generateHarvesterBody(availableEnergy, 10))).toBeLessThanOrEqual(availableEnergy);
    }
  });

  it('always includes at least one WORK part for affordable harvester bodies', () => {
    for (const availableEnergy of [250, 300, 550, 800, 1300]) {
      expect(generateHarvesterBody(availableEnergy, 10)).toContain('work');
    }
  });

  it('does not overbuild when replacement-aware worker capacity is at target', () => {
    const { colony } = makeColony();

    expect(planSpawn(colony, { worker: 3, workerCapacity: 3 }, 124)).toBeNull();
  });

  it('plans one surplus worker for controller progress when stable room energy is full', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N17',
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 126)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-W1N17-126',
      memory: { role: 'worker', colony: 'W1N17' }
    });
    expect(planSpawn(colony, { worker: 4 }, 127)).toBeNull();
  });

  it('waits on surplus controller workers until spawn energy is full', () => {
    const { colony } = makeColony({
      roomName: 'W1N18',
      energyAvailable: 600,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 128)).toBeNull();
  });

  it('dispatches a multi-room upgrader to an adjacent owned controller when storage has surplus energy', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController(),
      storageEnergy: 850,
      storageCapacity: 1_000
    });
    const targetController = {
      id: 'controller2',
      my: true,
      level: 1
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', targetController)
      },
      spawns: { Spawn1: spawn },
      creeps: {},
      map: {
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }])
      } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    expect(planSpawn(colony, { worker: 3 }, 129)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-W2N1-multiroom-upgrader-129',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller2' },
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
      }
    });
  });

  it('tries the next ranked multi-room upgrade plan when the first body is unaffordable', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController(),
      storageEnergy: 850,
      storageCapacity: 1_000
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          id: 'reservedController',
          my: false,
          level: 0,
          reservation: { username: 'player', ticksToEnd: 4_000 }
        } as StructureController),
        W3N1: makeTerritoryRoom('W3N1', {
          id: 'ownedController',
          my: true,
          level: 1
        } as StructureController)
      },
      spawns: { Spawn1: spawn },
      creeps: {},
      map: {
        findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 3, room: toRoom }])
      } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    expect(planSpawn(colony, { worker: 3 }, 130)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-W3N1-multiroom-upgrader-130',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'claim', controllerId: 'ownedController' },
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W3N1', role: 'upgrader' }
      }
    });
  });

  it('uses the home spawn for a dedicated post-claim controller upgrader when the claimed room has no spawn', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          id: 'controller2',
          my: true,
          level: 1
        } as StructureController)
      },
      spawns: { Spawn1: spawn },
      creeps: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'spawnSitePending',
            claimedAt: 170,
            updatedAt: 171,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };

    expect(planSpawn(colony, { worker: 3 }, 172)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-W2N1-upgrader-172',
      memory: {
        role: 'worker',
        colony: 'W2N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller2' },
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
      }
    });
  });

  it('does not sustain a stale post-claim record after target room vision is lost', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: colony.room },
      spawns: { Spawn1: spawn },
      creeps: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'spawnSitePending',
            claimedAt: 172,
            updatedAt: 172,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 173)).toBeNull();
  });

  it('does not sustain a stale post-claim record after target room ownership is lost', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          id: 'controller2',
          my: false,
          level: 1
        } as StructureController)
      },
      spawns: { Spawn1: spawn },
      creeps: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'spawnSitePending',
            claimedAt: 173,
            updatedAt: 173,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 174)).toBeNull();
  });

  it('keeps home worker recovery ahead of post-claim controller sustain', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', { id: 'controller2', my: true, level: 1 } as StructureController)
      },
      spawns: { Spawn1: spawn },
      creeps: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'spawnSitePending',
            claimedAt: 173,
            updatedAt: 173,
            workerTarget: 2
          }
        }
      }
    };

    expect(planSpawn(colony, { worker: 3, workerCapacity: 2 }, 174)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-174',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('adds a post-claim energy hauler after the claimed room has an upgrader but still lacks spawn energy', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const remoteUpgrader = {
      memory: {
        role: 'worker',
        colony: 'W2N1',
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'upgrader' }
      }
    } as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: {
          ...makeTerritoryRoom('W2N1', { id: 'controller2', my: true, level: 1 } as StructureController),
          energyAvailable: 0
        } as Room
      },
      spawns: { Spawn1: spawn },
      creeps: { RemoteUpgrader: remoteUpgrader }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'spawnSitePending',
            claimedAt: 175,
            updatedAt: 175,
            workerTarget: 2,
            controllerId: 'controller2' as Id<StructureController>
          }
        }
      }
    };

    expect(planSpawn(colony, { worker: 3 }, 176)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-W2N1-hauler-176',
      memory: {
        role: 'worker',
        colony: 'W2N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller2' },
        controllerSustain: { homeRoom: 'W1N1', targetRoom: 'W2N1', role: 'hauler' }
      }
    });
  });

  it('lets an operational claimed-room spawn handle its own workers when it has usable energy', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const claimedRoom = {
      ...makeTerritoryRoom('W2N1', { id: 'controller2', my: true, level: 2 } as StructureController),
      energyAvailable: 300
    } as Room;
    const claimedSpawn = { name: 'Spawn2', room: claimedRoom, spawning: null } as StructureSpawn;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: colony.room, W2N1: claimedRoom },
      spawns: { Spawn2: claimedSpawn },
      creeps: {}
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          W2N1: {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'ready',
            claimedAt: 177,
            updatedAt: 178,
            workerTarget: 2
          }
        }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 179)).toBeNull();
  });

  it('plans a dedicated remote harvester for a claimed adjacent room source with an active container', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const source = makeRemoteSource('W2N1-source0');
    const container = makeRemoteContainer('W2N1-container0', 0);
    const remoteRoom = makeRemoteEconomyRoom({ source, container });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 502,
      rooms: { W1N1: colony.room, W2N1: remoteRoom },
      spawns: { Spawn1: spawn },
      creeps: { RemoteUpgrader: makePostClaimSustainUpgrader() },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: { W2N1: makeSatisfiedPostClaimRemoteMemory() }
      }
    };

    expect(planSpawn(colony, { worker: 3 }, 503)).toEqual({
      spawn,
      body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
      name: 'remoteHarvester-W1N1-W2N1-W2N1-source0-503',
      memory: {
        role: 'remoteHarvester',
        colony: 'W1N1',
        remoteHarvester: {
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          sourceId: 'W2N1-source0',
          containerId: 'W2N1-container0'
        }
      }
    });
  });

  it('dispatches a remote hauler only when the assigned remote container is above threshold', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController(),
      ownedStructures: [makeRemoteHaulerStorageSink('storage1')]
    });
    const source = makeRemoteSource('W2N1-source0');
    const belowThresholdRoom = makeRemoteEconomyRoom({
      source,
      container: makeRemoteContainer('W2N1-container0', 500)
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 504,
      rooms: { W1N1: colony.room, W2N1: belowThresholdRoom },
      spawns: { Spawn1: spawn },
      creeps: {
        RemoteUpgrader: makePostClaimSustainUpgrader(),
        RemoteHarvester: makeRemoteHarvester()
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: { W2N1: makeSatisfiedPostClaimRemoteMemory() }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 505)).toBeNull();

    const aboveThresholdRoom = makeRemoteEconomyRoom({
      source,
      container: makeRemoteContainer('W2N1-container0', 501)
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 505,
      rooms: { W1N1: colony.room, W2N1: aboveThresholdRoom },
      spawns: { Spawn1: spawn },
      creeps: {
        RemoteUpgrader: makePostClaimSustainUpgrader(),
        RemoteHarvester: makeRemoteHarvester()
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };

    expect(planSpawn(colony, { worker: 4 }, 506)).toEqual({
      spawn,
      body: ['carry', 'move', 'carry', 'move', 'carry', 'move', 'carry', 'move', 'carry', 'move', 'carry', 'move'],
      name: 'hauler-W1N1-W2N1-W2N1-container0-506',
      memory: {
        role: 'hauler',
        colony: 'W1N1',
        remoteHauler: {
          homeRoom: 'W1N1',
          targetRoom: 'W2N1',
          sourceId: 'W2N1-source0',
          containerId: 'W2N1-container0'
        }
      }
    });
  });

  it('waits on remote haulers when the home colony has no known delivery demand', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const remoteRoom = makeRemoteEconomyRoom({
      container: makeRemoteContainer('W2N1-container0', 700)
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 506,
      rooms: { W1N1: colony.room, W2N1: remoteRoom },
      spawns: { Spawn1: spawn },
      creeps: {
        RemoteUpgrader: makePostClaimSustainUpgrader(),
        RemoteHarvester: makeRemoteHarvester()
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: { W2N1: makeSatisfiedPostClaimRemoteMemory() }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 507)).toBeNull();
  });

  it('does not spawn remote harvesters while the target has a hostile territory suspension', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const remoteRoom = makeRemoteEconomyRoom();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 507,
      rooms: { W1N1: colony.room, W2N1: remoteRoom },
      spawns: { Spawn1: spawn },
      creeps: { RemoteUpgrader: makePostClaimSustainUpgrader() },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: { W2N1: makeSatisfiedPostClaimRemoteMemory() },
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'active',
            updatedAt: 506,
            suspended: { reason: 'hostile_presence', hostileCount: 1, updatedAt: 506 }
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 508)).toBeNull();
  });

  it('limits remote harvesters to one active creep per remote source', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const remoteRoom = makeRemoteEconomyRoom({
      container: makeRemoteContainer('W2N1-container0', 0)
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 509,
      rooms: { W1N1: colony.room, W2N1: remoteRoom },
      spawns: { Spawn1: spawn },
      creeps: {
        RemoteUpgrader: makePostClaimSustainUpgrader(),
        RemoteHarvester: makeRemoteHarvester()
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: { W2N1: makeSatisfiedPostClaimRemoteMemory() }
      }
    };

    expect(planSpawn(colony, { worker: 4 }, 510)).toBeNull();
  });

  it('keeps normal replacement body selection when only expiring workers remain', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 600, energyCapacityAvailable: 800 });

    expect(planSpawn(colony, { worker: 3, workerCapacity: 0 }, 135)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-135',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps the emergency worker body for true zero-creep recovery', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 600, energyCapacityAvailable: 800 });

    expect(planSpawn(colony, { worker: 0, workerCapacity: 0 }, 136)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-136',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('adds one worker target for active construction backlog after the baseline target is safe', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N8',
      constructionSiteCount: 1,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 145)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N8-145',
      memory: { role: 'worker', colony: 'W1N8' }
    });
    expect(planSpawn(colony, { worker: 4 }, 146)).toBeNull();
  });

  it('adds one worker target while spawn-extension refill pressure remains after baseline workers', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N16',
      energyAvailable: 400,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 146)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N16-146',
      memory: { role: 'worker', colony: 'W1N16' }
    });
    expect(planSpawn(colony, { worker: 4 }, 147)).toBeNull();
  });

  it('adds a second worker target for substantial construction backlog after the first bonus target is safe', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N14',
      constructionSiteCount: 5,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 3 }, 147)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N14-147',
      memory: { role: 'worker', colony: 'W1N14' }
    });
    expect(planSpawn(colony, { worker: 4 }, 148)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N14-148',
      memory: { role: 'worker', colony: 'W1N14' }
    });
    expect(planSpawn(colony, { worker: 5 }, 149)).toBeNull();
  });

  it('plans one downgrade-guard worker when the home controller needs recovery', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N9',
      controller: { my: true, level: 3, ticksToDowngrade: 1_500 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3 }, 150)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N9-150',
      memory: { role: 'worker', colony: 'W1N9' }
    });
  });

  it('does not spend the only spawn on a downgrade-guard worker under hostile pressure', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony } = makeColony({
      roomName: 'W1N9',
      energyAvailable: 600,
      energyCapacityAvailable: 600,
      hostileCreeps: [hostile],
      controller: { my: true, level: 3, ticksToDowngrade: 1_500 } as StructureController
    });

    expect(planSpawn(colony, { worker: 3, defender: 1 }, 151)).toBeNull();
  });

  it('allows a downgrade-guard worker under hostile pressure when another idle spawn remains available', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({
      roomName: 'W1N9',
      energyAvailable: 600,
      energyCapacityAvailable: 600,
      hostileCreeps: [hostile],
      controller: { my: true, level: 3, ticksToDowngrade: 1_500 } as StructureController
    });
    colony.spawns = [spawn, { name: 'Spawn2', room: colony.room, spawning: null } as StructureSpawn];

    expect(planSpawn(colony, { worker: 3, defender: 1 }, 152)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N9-152',
      memory: { role: 'worker', colony: 'W1N9' }
    });
  });

  it('does not spend construction backlog bonuses while the home controller needs downgrade recovery', () => {
    const { colony } = makeColony({
      roomName: 'W1N9',
      constructionSiteCount: 5,
      controller: { my: true, level: 3, ticksToDowngrade: 1_500 } as StructureController
    });

    expect(planSpawn(colony, { worker: 4 }, 150)).toBeNull();
  });

  it('plans an emergency defender when hostile creeps are visible and local worker coverage is stable', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({ hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3 }, 160)).toEqual({
      spawn,
      body: ['tough', 'attack', 'move'],
      name: 'defender-W1N1-160',
      memory: {
        role: 'defender',
        colony: 'W1N1',
        defense: { homeRoom: 'W1N1' }
      }
    });
  });

  it('plans local worker refill before an emergency defender while hostiles are visible', () => {
    installHostileFindGlobals();
    const { colony: localRefillColony, spawn: localRefillSpawn } = makeColony({ sourceCount: 2 });
    expect(planSpawn(localRefillColony, { worker: 3 }, 163)).toEqual({
      spawn: localRefillSpawn,
      body: ['work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-163',
      memory: { role: 'worker', colony: 'W1N1' }
    });

    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({ sourceCount: 2, hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3 }, 164)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-164',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps bootstrap recovery ahead of defender spawning while hostiles are visible', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony, spawn } = makeColony({ hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 0 }, 165)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-165',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('does not stack emergency defenders while one defender is already active', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony } = makeColony({ hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3, defender: 1 }, 161)).toBeNull();
  });

  it('waits instead of emitting an invalid defender body when hostile defense energy is unavailable', () => {
    installHostileFindGlobals();
    const hostile = { id: 'hostile1' } as Creep;
    const { colony } = makeColony({ energyAvailable: 139, hostileCreeps: [hostile] });

    expect(planSpawn(colony, { worker: 3 }, 162)).toBeNull();
  });

  it('plans a scout for an explicit memory target when target visibility is missing', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 139)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N1-W2N1-139',
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'scout' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 139
      }
    ]);
  });

  it('plans territory scouting once the construction-adjusted worker target is satisfied', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N10',
      constructionSiteCount: 1,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N10', roomName: 'W2N10', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 4, claimer: 0, claimersByTargetRoom: {} }, 148)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N10-W2N10-148',
      memory: {
        role: 'scout',
        colony: 'W1N10',
        territory: { targetRoom: 'W2N10', action: 'scout' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N10',
        targetRoom: 'W2N10',
        action: 'scout',
        status: 'planned',
        updatedAt: 148
      }
    ]);
  });

  it('plans a claimer-role reserver for a seeded adjacent reserve target when home survival is safe', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '3': 'W2N1' })) } as unknown as GameMap,
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 142)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-142',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 142
      }
    ]);
  });

  it('plans a claimer-role claimer for a claim-ready configured reserve target', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const controller = {
      my: false,
      reservation: { username: 'player', ticksToEnd: TERRITORY_CLAIM_READY_TICKS }
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: {
          name: 'W2N1',
          controller,
          find: jest.fn((type: number) => (type === FIND_SOURCES ? [{ id: 'source1' }, { id: 'source2' }] : [])),
          energyAvailable: 300,
          energyCapacityAvailable: 300
        } as unknown as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 142)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-142',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim' }
      }
    });
  });

  it('does not spawn a one-CLAIM reserver for foreign reservation pressure', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          my: false,
          reservation: { username: 'enemy', ticksToEnd: 3_000 }
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 143)).toBeNull();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('spawns a pressure-capable claimer for foreign reservation pressure', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          my: false,
          reservation: { username: 'enemy', ticksToEnd: 3_000 }
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 144)).toEqual({
      spawn,
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move'],
      name: 'claimer-W1N1-W2N1-144',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
  });

  it('does not spawn a one-CLAIM claimer for foreign-reserved claim pressure', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 145)).toBeNull();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('spawns a pressure-capable claimer for foreign-reserved claim pressure', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 146)).toEqual({
      spawn,
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move'],
      name: 'claimer-W1N1-W2N1-146',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 146,
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not fall back to a one-CLAIM body for persisted foreign-reserved claim pressure after vision loss', () => {
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planSpawn(visibleColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 147)).toMatchObject({
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move']
    });

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 148)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 148,
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not fall back to a one-CLAIM body after claim pressure recommendation persistence and vision loss', () => {
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 146,
            requiresControllerPressure: true
          }
        ]
      }
    };
    const recommendation = scoreOccupationRecommendations({
      colonyName: 'W1N1',
      colonyOwnerUsername: 'me',
      energyCapacityAvailable: 3250,
      workerCount: 3,
      controllerLevel: 3,
      ticksToDowngrade: 10_000,
      candidates: [
        {
          roomName: 'W2N1',
          source: 'configured',
          order: 0,
          adjacent: false,
          visible: true,
          actionHint: 'claim',
          routeDistance: 1,
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          constructionSiteCount: 0,
          ownedStructureCount: 0
        }
      ]
    });

    expect(recommendation.followUpIntent).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      requiresControllerPressure: true
    });
    expect(persistOccupationRecommendationFollowUpIntent(recommendation, 147)).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      status: 'planned',
      updatedAt: 147,
      createdBy: 'occupationRecommendation',
      requiresControllerPressure: true
    });

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 148)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 148,
        createdBy: 'occupationRecommendation',
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not retry a stale suppressed claim-pressure recommendation with a one-CLAIM body after vision loss', () => {
    const suppressionTime = 146;
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom(
          'W2N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'suppressed',
            updatedAt: suppressionTime
          }
        ]
      }
    };
    const recommendation = scoreOccupationRecommendations({
      colonyName: 'W1N1',
      colonyOwnerUsername: 'me',
      energyCapacityAvailable: 3250,
      workerCount: 3,
      controllerLevel: 3,
      ticksToDowngrade: 10_000,
      candidates: [
        {
          roomName: 'W2N1',
          source: 'configured',
          order: 0,
          adjacent: false,
          visible: true,
          actionHint: 'claim',
          routeDistance: 1,
          controller: { reservationUsername: 'enemy', reservationTicksToEnd: 3_000 },
          sourceCount: 2,
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          constructionSiteCount: 0,
          ownedStructureCount: 0
        }
      ]
    });

    expect(persistOccupationRecommendationFollowUpIntent(recommendation, suppressionTime + 1)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: suppressionTime,
        requiresControllerPressure: true
      }
    ]);

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, retryTime)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: retryTime,
        requiresControllerPressure: true
      }
    ]);
  });

  it('does not fall back to a one-CLAIM body for persisted foreign reservation pressure after vision loss', () => {
    const { colony: visibleColony } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: visibleColony.room,
        W2N1: makeTerritoryRoom('W2N1', {
          my: false,
          reservation: { username: 'enemy', ticksToEnd: 3_000 }
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(visibleColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 145)).toMatchObject({
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move']
    });

    const { colony: darkColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: darkColony.room
      }
    };

    expect(planSpawn(darkColony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 146)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 146,
        requiresControllerPressure: true
      }
    ]);
  });

  it('plans a claimer from a persisted occupation claim intent when the target is actionable', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeTerritoryRoom('W2N1', {
          id: 'controller2' as Id<StructureController>,
          my: false
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 152,
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 153)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-153',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'claim',
          controllerId: 'controller2' as Id<StructureController>
        }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 153,
        controllerId: 'controller2'
      }
    ]);
  });

  it('does not queue duplicate claimers for the same claim target while one is already active', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeTerritoryRoom('W2N1', {
          id: 'controller2' as Id<StructureController>,
          my: false
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'active',
            updatedAt: 151,
            controllerId: 'controller2' as Id<StructureController>
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { claim: { W2N1: 1 } }
        },
        152
      )
    ).toBeNull();
    expect(Memory.territory?.intents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'active',
          controllerId: 'controller2'
        })
      ])
    );
  });

  it('uses worker recovery before spawning claimers for an active claim target', () => {
    const { colony, spawn } = makeColony({
      sourceCount: 1,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeTerritoryRoom('W2N1', {
          id: 'controller2' as Id<StructureController>,
          my: false
        } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(planSpawn(colony, { worker: 2, claimer: 0, claimersByTargetRoom: {} }, 153)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-153',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('uses a selected follow-up demand to plan one support worker before a reserver', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'planned',
            updatedAt: 154,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 155)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-W1N1-155',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 155,
        followUp
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 155,
        followUp
      }
    ]);
  });

  it('plans a reserver from a persisted follow-up intent once support demand is satisfied', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'planned',
            updatedAt: 154,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 4, claimer: 0, claimersByTargetRoom: {} }, 155)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N2-155',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N2', action: 'reserve', followUp }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: 155,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 155,
        followUp
      }
    ]);
  });

  it('uses controller-pressure-only territory planning for a persisted follow-up pressure spawn', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const { colony, spawn } = makeColony({
      energyAvailable: 3250,
      energyCapacityAvailable: 3250,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', { my: false } as StructureController, 2),
        W3N1: makeTerritoryRoom(
          'W3N1',
          {
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'claim' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 154,
            requiresControllerPressure: true,
            followUp
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        { worker: 4, claimer: 0, claimersByTargetRoom: {} },
        155,
        { workersOnly: true, allowTerritoryControllerPressure: true }
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move', 'claim', 'move'],
      name: 'claimer-W1N1-W3N1-155',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'reserve', followUp }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 155,
        requiresControllerPressure: true,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 155,
        followUp
      }
    ]);
  });

  it('uses follow-up-only territory planning for a persisted non-pressure follow-up spawn', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: makeTerritoryRoom('W2N1', { my: false } as StructureController, 2),
        W3N1: makeTerritoryRoom('W3N1', { my: false } as StructureController, 2)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 154,
            followUp
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        { worker: 4, claimer: 0, claimersByTargetRoom: {} },
        155,
        { workersOnly: true, allowTerritoryFollowUp: true }
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W3N1-155',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'reserve', followUp }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 155,
        followUp
      }
    ]);
  });

  it('does not let first-pass follow-up allowance block normal territory planning', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const ownedController = {
      ...makeSafeOwnedController(),
      owner: { username: 'player' }
    } as StructureController;
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: ownedController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: makeTerritoryRoom('W2N1', { my: false } as StructureController, 2),
        W3N1: makeTerritoryRoom(
          'W3N1',
          {
            my: false,
            reservation: { username: 'player', ticksToEnd: 2_000 }
          } as StructureController,
          2
        )
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: 154,
            followUp
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        { worker: 3, claimer: 0, claimersByTargetRoom: {} },
        155,
        { allowTerritoryFollowUp: true }
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-155',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 155
      }
    ]);
  });

  it('cools down a recovered follow-up when no spawn action is available', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 160;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const eligibleTime = retryTime + TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS + 1;
    const busy = { remainingTime: 5 } as Spawning;
    const { colony: busyColony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController(),
      spawning: busy
    });
    const { colony: idleColony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const recoveringRoleCounts = { worker: 3, claimer: 0, claimersByTargetRoom: {} };
    const readyRoleCounts = { worker: 4, claimer: 0, claimersByTargetRoom: {} };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(busyColony, recoveringRoleCounts, retryTime)).toBeNull();
    expect(Memory.territory?.demands).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        lastAttemptAt: retryTime,
        followUp
      }
    ]);

    expect(planSpawn(idleColony, recoveringRoleCounts, retryTime + 1)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        lastAttemptAt: retryTime,
        followUp
      }
    ]);

    expect(planSpawn(idleColony, readyRoleCounts, eligibleTime)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: `claimer-W1N1-W2N2-${eligibleTime}`,
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N2', action: 'reserve', followUp }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'planned',
        updatedAt: eligibleTime,
        followUp
      }
    ]);
  });

  it('uses a ready alternate while a recovered follow-up lacks claim body energy', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 165;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const { colony, spawn } = makeColony({
      energyAvailable: 50,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const describeExits = jest.fn(() => ({ '1': 'W1N3' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N2', action: 'reserve' }],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, retryTime)).toBeNull();
    expect(describeExits).not.toHaveBeenCalled();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: suppressionTime,
        followUp
      }
    ]);
  });

  it('keeps a recovered follow-up active when live controller coverage already satisfies it', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 170;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const roleCounts = {
      worker: 4,
      claimer: 1,
      claimersByTargetRoom: { W2N2: 1 },
      claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, roleCounts, retryTime)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'active',
        updatedAt: retryTime,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: retryTime,
        followUp
      }
    ]);
  });

  it('does not cool down a covered recovered follow-up when support worker spawn is unavailable', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'activeReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const suppressionTime = 180;
    const retryTime = suppressionTime + TERRITORY_SUPPRESSION_RETRY_TICKS + 1;
    const busy = { remainingTime: 5 } as Spawning;
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController(),
      spawning: busy
    });
    const roleCounts = {
      worker: 3,
      claimer: 1,
      claimersByTargetRoom: { W2N2: 1 },
      claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'suppressed',
            updatedAt: suppressionTime,
            followUp
          }
        ]
      }
    };

    expect(planSpawn(colony, roleCounts, retryTime)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'active',
        updatedAt: retryTime,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: retryTime,
        followUp
      }
    ]);
  });

  it('does not plan a duplicate claimer for the same persisted target and action', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'reserve',
            status: 'planned',
            updatedAt: 156
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N2: 1 },
          claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
        },
        157
      )
    ).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 157
      }
    ]);
  });

  it('does not count a reserver as coverage for a persisted claim intent on the same target', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N2: makeTerritoryRoom('W2N2', { my: false } as StructureController)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N2',
            action: 'claim',
            status: 'planned',
            updatedAt: 158
          }
        ]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N2: 1 },
          claimersByTargetRoomAction: { reserve: { W2N2: 1 } }
        },
        159
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N2-159',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N2', action: 'claim' }
      }
    });
  });

  it('plans a cheap scout for an unseen adjacent reserve candidate before reserving it', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 50,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits: jest.fn(() => ({ '3': 'W2N1' })) } as unknown as GameMap
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 144)).toBeNull();
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('spawns a scout while waiting for claim body energy and target visibility', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 600,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim', controllerId: 'controller2' as Id<StructureController> }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 141)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N1-W2N1-141',
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'scout', controllerId: 'controller2' as Id<StructureController> }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 141,
        controllerId: 'controller2'
      }
    ]);
  });

  it('plans a scout when only reserve capacity exists for an unseen recovered claim target', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { reserve: { W2N1: 1 } }
        },
        149
      )
    ).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N1-W2N1-149',
      memory: {
        role: 'scout',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'scout' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'scout',
        status: 'planned',
        updatedAt: 149
      }
    ]);
  });

  it('keeps low worker capacity on worker recovery before territory control', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 1, claimer: 0, claimersByTargetRoom: {} }, 140)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-140',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('keeps near-target local recovery ahead of territory control', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 2, claimer: 0, claimersByTargetRoom: {} }, 141)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-141',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('does not plan another claimer while one has active target capacity', () => {
    const { colony } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 1, claimersByTargetRoom: { W2N1: 1 } }, 143)).toBeNull();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 143
      }
    ]);
  });

  it('plans a backup reserver when an active own reservation reaches emergency renewal', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, owner: { username: 'me' }, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W1N1: colony.room,
        W2N1: {
          name: 'W2N1',
          controller: {
            my: false,
            reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
          } as StructureController
        } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { reserve: { W2N1: 1 } }
        },
        151
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-151',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 151
      }
    ]);
  });

  it('plans the next territory controller target while another target has active capacity', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController
    });
    const activeReserveIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'active',
      updatedAt: 143
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: {
        W2N1: { name: 'W2N1', controller: { my: false } as StructureController } as Room,
        W3N1: { name: 'W3N1', controller: { my: false } as StructureController } as Room
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [
          { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' },
          { colony: 'W1N1', roomName: 'W3N1', action: 'reserve' }
        ],
        intents: [activeReserveIntent]
      }
    };

    expect(
      planSpawn(
        colony,
        {
          worker: 3,
          claimer: 1,
          claimersByTargetRoom: { W2N1: 1 },
          claimersByTargetRoomAction: { reserve: { W2N1: 1 } }
        },
        150
      )
    ).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W3N1-150',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W3N1', action: 'reserve' }
      }
    });
    expect(Memory.territory?.intents).toEqual([
      activeReserveIntent,
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 150
      }
    ]);
  });

  it('prefers safe visible adjacent reserve progress at the territory-ready worker floor', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W4N1: makeTerritoryRoom('W4N1', { my: false } as StructureController, 1),
        W2N1: makeTerritoryRoom('W2N1', { my: false } as StructureController, 2)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W4N1', action: 'reserve' }],
        routeDistances: { 'W1N1>W4N1': 3 }
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 160)).toEqual({
      spawn,
      body: ['claim', 'move'],
      name: 'claimer-W1N1-W2N1-160',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve' }
      }
    });
    expect(describeExits).toHaveBeenCalledWith('W1N1');
    expect(Memory.territory?.targets).toEqual([
      { colony: 'W1N1', roomName: 'W4N1', action: 'reserve' },
      { colony: 'W1N1', roomName: 'W2N1', action: 'reserve' }
    ]);
  });

  it('keeps worker recovery before adjacent reserve progress below the territory-ready worker floor', () => {
    const { colony, spawn } = makeColony({
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: { describeExits } as unknown as GameMap,
      rooms: {
        W4N1: makeTerritoryRoom('W4N1', { my: false } as StructureController, 1),
        W2N1: makeTerritoryRoom('W2N1', { my: false } as StructureController, 2)
      }
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W4N1', action: 'reserve' }],
        routeDistances: { 'W1N1>W4N1': 3 }
      }
    };

    expect(planSpawn(colony, { worker: 2, claimer: 0, claimersByTargetRoom: {} }, 161)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-161',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(describeExits).not.toHaveBeenCalled();
    expect(Memory.territory?.targets).toEqual([{ colony: 'W1N1', roomName: 'W4N1', action: 'reserve' }]);
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('targets a fourth worker for two-source rooms', () => {
    const { colony, spawn } = makeColony({ roomName: 'W1N2', sourceCount: 2 });

    expect(planSpawn(colony, { worker: 3 }, 126)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'move'],
      name: 'worker-W1N2-126',
      memory: { role: 'worker', colony: 'W1N2' }
    });
    expect(planSpawn(colony, { worker: 4 }, 126)).toBeNull();
  });

  it('waits for two-source home stability before territory spawning', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N15',
      sourceCount: 2,
      energyAvailable: 650,
      energyCapacityAvailable: 650,
      controller: makeSafeOwnedController()
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N15', roomName: 'W2N15', action: 'reserve' }]
      }
    };

    expect(planSpawn(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 152)).toEqual({
      spawn,
      body: ['work', 'work', 'work', 'carry', 'move', 'move', 'move', 'move'],
      name: 'worker-W1N15-152',
      memory: { role: 'worker', colony: 'W1N15' }
    });
    expect(Memory.territory?.intents).toBeUndefined();

    expect(planSpawn(colony, { worker: 4, claimer: 0, claimersByTargetRoom: {} }, 153)).toEqual({
      spawn,
      body: ['move'],
      name: 'scout-W1N15-W2N15-153',
      memory: {
        role: 'scout',
        colony: 'W1N15',
        territory: { targetRoom: 'W2N15', action: 'scout' }
      }
    });
  });

  it('caps the source-aware worker target even with substantial construction backlog', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N3',
      sourceCount: 10,
      constructionSiteCount: 5,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 5 }, 127)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'move'],
      name: 'worker-W1N3-127',
      memory: { role: 'worker', colony: 'W1N3' }
    });
    expect(planSpawn(colony, { worker: 6 }, 127)).toBeNull();
  });

  it('caches source counts for repeated planning in the same room', () => {
    const { colony, find } = makeColony({ roomName: 'W1N4', sourceCount: 2 });

    planSpawn(colony, { worker: 3 }, 128);
    planSpawn(colony, { worker: 3 }, 129);

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(FIND_SOURCES);
  });

  it('computes source counts once for each newly encountered room', () => {
    const first = makeColony({ roomName: 'W1N5', sourceCount: 1 });
    const second = makeColony({ roomName: 'W1N6', sourceCount: 2 });

    planSpawn(first.colony, { worker: 2 }, 130);
    planSpawn(second.colony, { worker: 3 }, 131);
    planSpawn(second.colony, { worker: 3 }, 132);

    expect(first.find).toHaveBeenCalledTimes(1);
    expect(second.find).toHaveBeenCalledTimes(1);
  });

  it('falls back safely when room name and find are absent in a mock', () => {
    const room = {
      energyAvailable: 300,
      energyCapacityAvailable: 300
    } as unknown as Room;
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    };

    expect(planSpawn(colony, { worker: 3 }, 133)).toBeNull();
  });

  it('spawns an emergency bootstrap worker at the minimum body cost', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 200, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 0 }, 125)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-125',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps zero-worker recovery on the emergency basic worker body when construction backlog exists', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N11',
      constructionSiteCount: 1,
      energyAvailable: 400,
      energyCapacityAvailable: 600,
      controller: makeSafeOwnedController()
    });

    expect(planSpawn(colony, { worker: 0 }, 135)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N11-135',
      memory: { role: 'worker', colony: 'W1N11' }
    });
  });

  it('plans an affordable worker body below the minimum functional worker target', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 400, energyCapacityAvailable: 600 });

    expect(planSpawn(colony, { worker: 2 }, 136)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-136',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('plans an affordable worker body for a source-aware shortfall before the full worker body is affordable', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N7',
      sourceCount: 2,
      energyAvailable: 400,
      energyCapacityAvailable: 600
    });

    expect(planSpawn(colony, { worker: 3 }, 137)).toEqual({
      spawn,
      body: ['work', 'work', 'carry', 'move', 'move', 'move'],
      name: 'worker-W1N7-137',
      memory: { role: 'worker', colony: 'W1N7' }
    });
  });

  it('plans an affordable worker body when replacement-aware capacity is below the source-aware target', () => {
    const { colony, spawn } = makeColony({
      roomName: 'W1N12',
      sourceCount: 2,
      energyAvailable: 400,
      energyCapacityAvailable: 600
    });

    expect(planSpawn(colony, { worker: 4, workerCapacity: 3 }, 150)).toEqual({
      spawn,
      body: ['work', 'work', 'carry', 'move', 'move', 'move'],
      name: 'worker-W1N12-150',
      memory: { role: 'worker', colony: 'W1N12' }
    });
  });

  it('does not plan an emergency body that costs more than available energy', () => {
    const { colony } = makeColony({ energyAvailable: 199, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 0 }, 125)).toBeNull();
  });

  it('does not plan a non-emergency worker body below the minimum worker energy', () => {
    const { colony } = makeColony({ energyAvailable: 199, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 2 }, 138)).toBeNull();
  });

  it('does not plan when all spawns are busy', () => {
    const { colony } = makeColony({ spawning: {} as Spawning });

    expect(planSpawn(colony, { worker: 0 }, 123)).toBeNull();
  });
});
