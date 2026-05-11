import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import { planSpawn } from '../../src/spawn/spawnPlanner';
import { refreshControllerManagement } from '../../src/territory/controllerManager';

const FIND_SOURCES_CODE = 1;
const FIND_HOSTILE_CREEPS_CODE = 2;
const FIND_HOSTILE_STRUCTURES_CODE = 3;
const FIND_MY_CONSTRUCTION_SITES_CODE = 4;
const FIND_CONSTRUCTION_SITES_CODE = 5;

describe('E26S47 controller upgrade progression', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = FIND_SOURCES_CODE;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = FIND_HOSTILE_CREEPS_CODE;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = FIND_HOSTILE_STRUCTURES_CODE;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES =
      FIND_MY_CONSTRUCTION_SITES_CODE;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES =
      FIND_CONSTRUCTION_SITES_CODE;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('dispatches a multi-room upgrader for claimed E26S47 below the post-claim desired RCL without waiting for storage surplus', () => {
    const home = makeColony('E24S49', { controllerLevel: 4, energyAvailable: 650, energyCapacityAvailable: 650 });
    const targetRoom = makeRoom('E26S47', { controllerLevel: 2, energyAvailable: 300, energyCapacityAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn-E26S47', targetRoom);
    installGame(home, targetRoom, targetSpawn, 1_000);
    installPostClaimMemory('E24S49', 'E26S47', 995, 'ready');

    expect(
      planSpawn(home, { worker: 3 }, 1_000, { controllerUpgradeTargetRooms: ['E26S47'] })
    ).toEqual({
      spawn: home.spawns[0],
      body: ['work', 'carry', 'move', 'work', 'carry', 'move', 'work', 'carry', 'move', 'move'],
      name: 'worker-E24S49-E26S47-multiroom-upgrader-1000',
      memory: {
        role: 'worker',
        colony: 'E24S49',
        territory: {
          targetRoom: 'E26S47',
          action: 'claim',
          controllerId: 'controller-e26s47'
        },
        controllerSustain: {
          homeRoom: 'E24S49',
          targetRoom: 'E26S47',
          role: 'upgrader'
        }
      }
    });
  });

  it('tracks E26S47 controller level and remaining progress toward the desired post-claim RCL', () => {
    const colony = makeColony('E26S47', {
      controllerLevel: 2,
      controllerProgress: 3_000,
      controllerProgressTotal: 45_000,
      energyAvailable: 650,
      energyCapacityAvailable: 650
    });

    const plan = refreshControllerManagement(colony, { worker: 3 }, 3, 1_001, {
      desiredControllerLevel: 3
    });

    expect(plan).toMatchObject({
      roomName: 'E26S47',
      controllerId: 'controller-e26s47',
      controllerLevel: 2,
      desiredControllerLevel: 3,
      progress: 3_000,
      progressTotal: 45_000,
      progressRemaining: 42_000,
      progressRatio: 3_000 / 45_000
    });
    expect(Memory.territory?.controllers?.E26S47).toMatchObject({
      controllerLevel: 2,
      desiredControllerLevel: 3,
      progress: 3_000,
      progressTotal: 45_000,
      progressRemaining: 42_000,
      progressRatio: 3_000 / 45_000
    });
  });

  it('keeps home worker recovery ahead of E26S47 post-claim RCL progression spending', () => {
    const home = makeColony('E24S49', { controllerLevel: 4, energyAvailable: 650, energyCapacityAvailable: 650 });
    const targetRoom = makeRoom('E26S47', { controllerLevel: 2, energyAvailable: 300, energyCapacityAvailable: 300 });
    const targetSpawn = makeSpawn('Spawn-E26S47', targetRoom);
    installGame(home, targetRoom, targetSpawn, 1_002);
    installPostClaimMemory('E24S49', 'E26S47', 995, 'ready');

    expect(
      planSpawn(home, { worker: 3, workerCapacity: 2 }, 1_002, { controllerUpgradeTargetRooms: ['E26S47'] })
    ).toMatchObject({
      spawn: home.spawns[0],
      name: 'worker-E24S49-1002',
      memory: { role: 'worker', colony: 'E24S49' }
    });
  });
});

function makeColony(
  roomName: string,
  options: {
    controllerLevel: number;
    controllerProgress?: number;
    controllerProgressTotal?: number;
    energyAvailable: number;
    energyCapacityAvailable: number;
  }
): ColonySnapshot {
  const room = makeRoom(roomName, options);
  const spawn = makeSpawn(`Spawn-${roomName}`, room);
  return {
    room,
    spawns: [spawn],
    energyAvailable: options.energyAvailable,
    energyCapacityAvailable: options.energyCapacityAvailable,
    spawnEnergyBudget: options.energyAvailable,
    memory: (room as Room & { memory?: RoomMemory }).memory
  };
}

function makeRoom(
  roomName: string,
  options: {
    controllerLevel: number;
    controllerProgress?: number;
    controllerProgressTotal?: number;
    energyAvailable: number;
    energyCapacityAvailable: number;
  }
): Room {
  const controller = {
    id: `controller-${roomName.toLowerCase()}` as Id<StructureController>,
    my: true,
    owner: { username: 'me' },
    level: options.controllerLevel,
    progress: options.controllerProgress ?? 0,
    progressTotal: options.controllerProgressTotal ?? 1_000,
    ticksToDowngrade: 10_000
  } as StructureController;
  const room = {
    name: roomName,
    controller,
    energyAvailable: options.energyAvailable,
    energyCapacityAvailable: options.energyCapacityAvailable,
    memory: {},
    find: jest.fn((findType: number) => {
      if (
        findType === FIND_SOURCES_CODE ||
        findType === FIND_HOSTILE_CREEPS_CODE ||
        findType === FIND_HOSTILE_STRUCTURES_CODE ||
        findType === FIND_MY_CONSTRUCTION_SITES_CODE ||
        findType === FIND_CONSTRUCTION_SITES_CODE
      ) {
        return [];
      }

      return [];
    })
  } as unknown as Room;
  (controller as StructureController & { room: Room }).room = room;
  return room;
}

function makeSpawn(name: string, room: Room): StructureSpawn {
  return {
    id: name as Id<StructureSpawn>,
    name,
    room,
    structureType: 'spawn',
    spawning: null
  } as unknown as StructureSpawn;
}

function installGame(
  home: ColonySnapshot,
  targetRoom: Room,
  targetSpawn: StructureSpawn,
  time: number
): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    rooms: {
      [home.room.name]: home.room,
      [targetRoom.name]: targetRoom
    },
    spawns: {
      [home.spawns[0].name]: home.spawns[0],
      [targetSpawn.name]: targetSpawn
    },
    creeps: {},
    map: {
      findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 3, room: toRoom }])
    } as unknown as GameMap
  };
}

function installPostClaimMemory(
  colony: string,
  roomName: string,
  claimedAt: number,
  status: TerritoryPostClaimBootstrapStatus
): void {
  Memory.territory = {
    postClaimBootstraps: {
      [roomName]: {
        colony,
        roomName,
        status,
        claimedAt,
        updatedAt: claimedAt,
        workerTarget: 2,
        controllerId: `controller-${roomName.toLowerCase()}` as Id<StructureController>
      }
    }
  };
}
