import {
  MINER_ADJUSTED_SPAWN_ENERGY_BUFFER_FLOOR,
  MINER_OUTPUT_BUFFER_CREDIT_TICKS,
  SPAWN_ENERGY_BUFFER_THRESHOLDS_BY_RCL,
  canWithdrawFromSpawnEnergyBuffer,
  getBufferedSpawnEnergyBudget,
  getRoomSpawnEnergyBufferNeed,
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

  it.each([
    { harvestRates: [0], expectedCredit: 0, expectedThreshold: 500 },
    { harvestRates: [5], expectedCredit: 5 * MINER_OUTPUT_BUFFER_CREDIT_TICKS, expectedThreshold: 400 },
    {
      harvestRates: [10, 10],
      expectedCredit: 20 * MINER_OUTPUT_BUFFER_CREDIT_TICKS,
      expectedThreshold: MINER_ADJUSTED_SPAWN_ENERGY_BUFFER_FLOOR
    }
  ])(
    'sizes the default spawn buffer from fresh miner throughput %#',
    ({ harvestRates, expectedCredit, expectedThreshold }) => {
      const room = makeRoom({ energyAvailable: 650, level: 4 });
      const spawn = makeSpawn('spawn1', room, 300);
      installSourceWorkloadMemory(harvestRates, 100);

      expect(getSpawnEnergyBufferThreshold(room)).toBe(expectedThreshold);
      expect(getSpawnEnergyBufferSnapshot(room, [spawn])).toMatchObject({
        baseThresholdPerSpawn: 500,
        minerOutputBufferCredit: expectedCredit,
        minerOutputEnergyPerTick: harvestRates.reduce((total, rate) => total + Math.min(rate, 10), 0),
        thresholdPerSpawn: expectedThreshold
      });
    }
  );

  it('spends against the miner-adjusted spawn buffer without draining below the floor', () => {
    const room = makeRoom({ energyAvailable: 650, level: 4 });
    const spawn = makeSpawn('spawn1', room, 300);
    installSourceWorkloadMemory([10, 10], 100);

    expect(getBufferedSpawnEnergyBudget(room, [spawn], 650)).toBe(450);
    expect(isSpawnEnergyBufferViolated(room, [spawn], 650, 450)).toBe(false);
    expect(isSpawnEnergyBufferViolated(room, [spawn], 650, 451)).toBe(true);
  });

  it('uses the full next queued body cost as the room spawn buffer requirement', () => {
    Memory.economy = {
      spawnEnergyReservation: {
        updatedAt: 99,
        rooms: {
          W1N1: {
            bodyCost: 650,
            creepName: 'worker-W1N1-100',
            reservedAt: 99,
            reservedEnergy: 650,
            role: 'worker',
            roomName: 'W1N1',
            updatedAt: 99
          }
        }
      }
    };
    const room = makeRoom({ energyAvailable: 500, level: 1 });
    const spawn = makeSpawn('spawn1', room, 300);

    expect(getSpawnEnergyBufferRequirement(room, [spawn])).toBe(650);
    expect(getBufferedSpawnEnergyBudget(room, [spawn], 500)).toBe(0);
    expect(isSpawnEnergyBufferViolated(room, [spawn], 500, 1)).toBe(true);
    expect(getSpawnEnergyBufferSnapshot(room, [spawn])).toMatchObject({
      currentEnergy: 500,
      healthy: false,
      reservedEnergy: 650,
      threshold: 650,
      thresholdPerSpawn: 300,
      unmetReservedEnergy: 150
    });
    expect(getSpawnEnergyAvailableForWithdrawal(room, spawn)).toBe(0);
  });

  it('keeps active spawn energy reservations visible in rooms without spawns', () => {
    Memory.economy = {
      spawnEnergyReservation: {
        updatedAt: 99,
        rooms: {
          W1N1: {
            bodyCost: 650,
            creepName: 'worker-W1N1-100',
            reservedAt: 99,
            reservedEnergy: 650,
            role: 'worker',
            roomName: 'W1N1',
            updatedAt: 99
          }
        }
      }
    };
    const room = makeRoom({ energyAvailable: 200, level: 1 });

    expect(getRoomSpawnEnergyBufferNeed(room, [])).toMatchObject({
      currentEnergy: 200,
      deficit: 450,
      healthy: false,
      spawnCount: 0,
      threshold: 650
    });
  });

  it('applies miner throughput credit once before splitting a multi-spawn buffer', () => {
    const room = makeRoom({ energyAvailable: 1_000, level: 4 });
    const spawns = [makeSpawn('spawn1', room, 300), makeSpawn('spawn2', room, 300)];
    installSourceWorkloadMemory([10], 100);

    expect(getSpawnEnergyBufferRequirement(room, spawns)).toBe(800);
    expect(getBufferedSpawnEnergyBudget(room, spawns, 1_000)).toBe(200);
    expect(isSpawnEnergyBufferViolated(room, spawns, 1_000, 201)).toBe(true);
    expect(getSpawnEnergyBufferSnapshot(room, spawns)).toMatchObject({
      baseThresholdPerSpawn: 500,
      minerOutputBufferCredit: 10 * MINER_OUTPUT_BUFFER_CREDIT_TICKS,
      spawnCount: 2,
      threshold: 800,
      thresholdPerSpawn: 400
    });
  });

  it('ignores stale miner throughput when sizing the spawn buffer', () => {
    const room = makeRoom({ energyAvailable: 650, level: 4 });
    installSourceWorkloadMemory([10, 10], 74);

    expect(getSpawnEnergyBufferThreshold(room)).toBe(500);
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

  it('requires full requested energy to be available before allowing spawn withdrawal', () => {
    const room = makeRoom({
      level: 1,
      memory: { spawnEnergyBuffer: { minimumEnergyPerSpawn: 275 } }
    });
    const spawn = makeSpawn('spawn1', room, 300);

    expect(canWithdrawFromSpawnEnergyBuffer(room, spawn, 25)).toBe(true);
    expect(canWithdrawFromSpawnEnergyBuffer(room, spawn, 50)).toBe(false);
    expect(canWithdrawFromSpawnEnergyBuffer(room, spawn, 0)).toBe(false);
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

function installSourceWorkloadMemory(harvestRates: number[], updatedAt: number): void {
  Memory.economy = {
    sourceWorkloads: {
      W1N1: {
        updatedAt,
        sources: Object.fromEntries(
          harvestRates.map((harvestEnergyPerTick, index) => [
            `source${index}`,
            {
              sourceId: `source${index}`,
              assignedHarvesters: harvestEnergyPerTick > 0 ? 1 : 0,
              assignedWorkParts: Math.ceil(harvestEnergyPerTick / 2),
              openPositions: 1,
              harvestWorkCapacity: 5,
              harvestEnergyPerTick,
              regenEnergyPerTick: 10,
              sourceEnergyCapacity: 3_000,
              sourceEnergyRegenTicks: 300,
              hasContainer: true,
              containerId: `container${index}`
            }
          ])
        )
      }
    }
  };
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
