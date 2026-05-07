import {
  SPAWN_ENERGY_BUFFER_THRESHOLDS_BY_RCL,
  getBufferedSpawnEnergyBudget,
  getSpawnEnergyAvailableForWithdrawal,
  getSpawnEnergyBufferRequirement,
  getSpawnEnergyBufferSnapshot,
  getSpawnEnergyBufferThreshold,
  getSpawnEnergyWithdrawalAmount,
  isSpawnEnergyBufferViolated,
  refreshSpawnEnergyBufferState
} from '../src/economy/spawnEnergyBuffer';
import { selectWorkerEnergyFallbackTask } from '../src/tasks/workerTasks';

describe('spawnEnergyBuffer', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_DROPPED_RESOURCES: 1,
      FIND_MY_STRUCTURES: 2,
      FIND_RUINS: 3,
      FIND_SOURCES: 4,
      FIND_STRUCTURES: 5,
      FIND_TOMBSTONES: 6,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_CONTAINER: 'container',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_LINK: 'link',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage',
      STRUCTURE_TERMINAL: 'terminal',
      STRUCTURE_TOWER: 'tower',
      Game: { creeps: {}, time: 100 },
      Memory: {}
    });
  });

  it.each([
    [1, 300],
    [2, 300],
    [3, 400],
    [4, 500],
    [5, 600],
    [6, 700],
    [7, 800],
    [8, 900]
  ])('uses the configured RCL %i per-spawn threshold', (level, threshold) => {
    expect(SPAWN_ENERGY_BUFFER_THRESHOLDS_BY_RCL[level as 1]).toBe(threshold);
    expect(getSpawnEnergyBufferThreshold(makeRoom({ level }))).toBe(threshold);
  });

  it('multiplies the reserve by spawn count when budgeting room spawn energy', () => {
    const room = makeRoom({ energyAvailable: 1_200, level: 3 });
    const spawns = [makeSpawn('spawn1', room, 300), makeSpawn('spawn2', room, 300)];

    expect(getSpawnEnergyBufferRequirement(room, spawns)).toBe(800);
    expect(getBufferedSpawnEnergyBudget(room, spawns, 1_200)).toBe(400);
    expect(isSpawnEnergyBufferViolated(room, spawns, 1_200, 401)).toBe(true);
    expect(isSpawnEnergyBufferViolated(room, spawns, 1_200, 400)).toBe(false);
    expect(getSpawnEnergyBufferSnapshot(room, spawns)).toMatchObject({
      currentEnergy: 1_200,
      healthy: true,
      spawnCount: 2,
      threshold: 800,
      thresholdPerSpawn: 400
    });
  });

  it('honors a per-room configured minimum energy threshold', () => {
    const room = makeRoom({
      energyAvailable: 500,
      level: 8,
      memory: { spawnEnergyBuffer: { minimumEnergyPerSpawn: 250 } }
    });
    const spawn = makeSpawn('spawn1', room, 300);

    expect(getSpawnEnergyBufferThreshold(room)).toBe(250);
    expect(getBufferedSpawnEnergyBudget(room, [spawn], 500)).toBe(250);
    expect(getSpawnEnergyAvailableForWithdrawal(room, spawn)).toBe(50);
    expect(getSpawnEnergyWithdrawalAmount(room, spawn, 100)).toBe(50);
  });

  it('limits spawn withdrawal by room-level spawn surplus', () => {
    const room = makeRoom({
      level: 3,
      memory: { spawnEnergyBuffer: { minimumEnergyPerSpawn: 250 } }
    });
    const spawn1 = makeSpawn('spawn1', room, 300);
    const spawn2 = makeSpawn('spawn2', room, 300);
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type !== FIND_MY_STRUCTURES) {
        return [];
      }

      const spawns = [spawn1, spawn2] as unknown as AnyOwnedStructure[];
      return options?.filter ? spawns.filter(options.filter) : spawns;
    }) as Room['find'];

    expect(getSpawnEnergyAvailableForWithdrawal(room, spawn1)).toBe(100);
    expect(getSpawnEnergyAvailableForWithdrawal(room, spawn2, 200)).toBe(0);
  });

  it('caps spawn withdrawal surplus by the target spawn energy', () => {
    const room = makeRoom({
      level: 3,
      memory: { spawnEnergyBuffer: { minimumEnergyPerSpawn: 100 } }
    });
    const spawn1 = makeSpawn('spawn1', room, 50);
    const spawn2 = makeSpawn('spawn2', room, 300);
    room.find = jest.fn((type: number, options?: { filter?: (structure: AnyOwnedStructure) => boolean }) => {
      if (type !== FIND_MY_STRUCTURES) {
        return [];
      }

      const spawns = [spawn1, spawn2] as unknown as AnyOwnedStructure[];
      return options?.filter ? spawns.filter(options.filter) : spawns;
    }) as Room['find'];

    expect(getSpawnEnergyAvailableForWithdrawal(room, spawn1)).toBe(50);
    expect(getSpawnEnergyAvailableForWithdrawal(room, spawn2)).toBe(150);
  });

  it('persists current buffer health without overwriting memory-level configuration', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        spawnEnergyBuffer: {
          updatedAt: 99,
          rooms: {
            W1N1: {
              currentEnergy: 0,
              healthy: false,
              minimumEnergyPerSpawn: 275,
              rcl: 1,
              roomName: 'W1N1',
              spawnCount: 1,
              spawns: {},
              threshold: 275,
              thresholdPerSpawn: 275,
              updatedAt: 99
            }
          }
        }
      }
    };
    const room = makeRoom({ energyAvailable: 300, level: 1 });
    const spawn = makeSpawn('spawn1', room, 300);

    expect(refreshSpawnEnergyBufferState(room, [spawn], 101)).toMatchObject({
      currentEnergy: 300,
      healthy: true,
      threshold: 275,
      thresholdPerSpawn: 275
    });
    expect(Memory.economy?.spawnEnergyBuffer?.rooms.W1N1).toMatchObject({
      currentEnergy: 300,
      healthy: true,
      minimumEnergyPerSpawn: 275,
      spawns: {
        spawn1: {
          energy: 300,
          threshold: 275,
          withdrawableEnergy: 25
        }
      },
      updatedAt: 101
    });
  });

  it('keeps worker fallback energy selection from draining spawn reserve', () => {
    const room = makeRoom({ energyAvailable: 300, level: 1 });
    const spawn = makeSpawn('spawn1', room, 300);
    room.find = jest.fn((type: number) => (type === FIND_STRUCTURES ? [spawn] : [])) as Room['find'];
    const creep = makeEmptyWorker(room);

    expect(selectWorkerEnergyFallbackTask(creep)).toBeNull();

    room.memory.spawnEnergyBuffer = { minimumEnergyPerSpawn: 250 };

    expect(selectWorkerEnergyFallbackTask(creep)).toEqual({ type: 'withdraw', targetId: 'spawn1' });
  });
});

function makeRoom({
  energyAvailable = 0,
  level,
  memory = {}
}: {
  energyAvailable?: number;
  level?: number;
  memory?: RoomMemory;
} = {}): Room & { memory: RoomMemory } {
  return {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable: 1_000,
    controller: { level, my: true } as StructureController,
    memory,
    find: jest.fn(() => [])
  } as unknown as Room & { memory: RoomMemory };
}

function makeSpawn(id: string, room: Room, energy: number): StructureSpawn {
  return {
    id,
    name: id,
    room,
    structureType: 'spawn',
    store: {
      getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? Math.max(0, 300 - energy) : 0)),
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0))
    }
  } as unknown as StructureSpawn;
}

function makeEmptyWorker(room: Room): Creep {
  return {
    memory: { role: 'worker', colony: room.name },
    room,
    store: {
      getFreeCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? 50 : 0)),
      getUsedCapacity: jest.fn(() => 0)
    }
  } as unknown as Creep;
}
