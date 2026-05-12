import {
  checkEnergyBufferForExtensionConstruction,
  checkEnergyBufferForCapacityEnablingConstruction,
  checkEnergyBufferForSpending,
  CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY,
  getEffectiveRoomEnergyBufferThreshold,
  getRoomEnergyBufferHealth,
  getRoomEnergyBufferThreshold,
  getStorageEnergyAvailableForWithdrawal,
  getStorageEnergyReserveThreshold,
  MINIMUM_WORKER_SPAWN_ENERGY,
  NON_CRISIS_ENERGY_BUFFER_CAPACITY_RATIO,
  STORAGE_EMERGENCY_RESERVE,
  withdrawFromStorage
} from '../src/economy/energyBuffer';
import {
  assessColonySurvival,
  clearColonySurvivalAssessmentCache,
  recordColonySurvivalAssessment
} from '../src/colony/survivalMode';

describe('energyBuffer', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      FIND_STRUCTURES: 2,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_EXTENSION: 'extension',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage',
      Game: { time: 100 }
    });
    clearColonySurvivalAssessmentCache();
  });

  afterEach(() => {
    clearColonySurvivalAssessmentCache();
  });

  it.each([
    [1, 300],
    [2, 300],
    [3, 500],
    [4, 500],
    [5, 800],
    [6, 800],
    [7, 1_000],
    [8, 1_000]
  ])('returns the configured RCL %i buffer threshold when room capacity is unknown', (level, threshold) => {
    expect(getRoomEnergyBufferThreshold(makeRoom({ level }))).toBe(threshold);
  });

  it.each([
    [1, 300],
    [2, 300],
    [3, 500],
    [4, 500],
    [5, 800],
    [6, 800],
    [7, 1_000],
    [8, 1_000]
  ])('keeps the configured RCL %i threshold when room capacity is sufficient', (level, threshold) => {
    expect(getRoomEnergyBufferThreshold(makeRoom({ level, energyCapacityAvailable: threshold }))).toBe(threshold);
    expect(getRoomEnergyBufferThreshold(makeRoom({ level, energyCapacityAvailable: threshold + 50 }))).toBe(
      threshold
    );
  });

  it('floors the non-crisis RCL 4 buffer threshold at basic worker spawn energy', () => {
    const room = makeRoom({ level: 4, energyAvailable: 300, energyCapacityAvailable: 300 });

    expect(getRoomEnergyBufferThreshold(room)).toBe(500);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(200);
    expect(getRoomEnergyBufferHealth(room)).toEqual({
      currentEnergy: 300,
      threshold: 200,
      room: 'W1N1',
      healthy: true
    });
  });

  it('caps the non-crisis RCL 5 buffer threshold at a capacity ratio', () => {
    const room = makeRoom({ level: 5, energyAvailable: 650, energyCapacityAvailable: 650 });

    expect(getRoomEnergyBufferThreshold(room)).toBe(800);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(
      Math.floor(650 * NON_CRISIS_ENERGY_BUFFER_CAPACITY_RATIO)
    );
    expect(getRoomEnergyBufferHealth(room).healthy).toBe(true);
  });

  it('keeps partial RCL 5 rooms from reserving 82 percent of spawn energy outside crisis mode', () => {
    const room = makeRoom({ level: 5, energyAvailable: 975, energyCapacityAvailable: 975 });

    expect(getRoomEnergyBufferThreshold(room)).toBe(800);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(
      Math.floor(975 * NON_CRISIS_ENERGY_BUFFER_CAPACITY_RATIO)
    );
    expect(checkEnergyBufferForSpending(room, 342)).toBe(true);
    expect(checkEnergyBufferForSpending(room, 343)).toBe(false);
  });

  it('caps an RCL 2 bootstrap threshold after applying the survival multiplier', () => {
    const room = makeRoom({ level: 2, energyAvailable: 300, energyCapacityAvailable: 300 });
    recordSurvivalMode('BOOTSTRAP');

    expect(getRoomEnergyBufferThreshold(room)).toBe(300);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(300);
  });

  it('caps an RCL 3 bootstrap threshold after applying the survival multiplier', () => {
    const room = makeRoom({ level: 3, energyAvailable: 550, energyCapacityAvailable: 550 });
    recordSurvivalMode('BOOTSTRAP');

    expect(getRoomEnergyBufferThreshold(room)).toBe(500);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(550);
  });

  it('keeps non-survival effective thresholds above basic worker spawn energy', () => {
    const room = makeRoom({ level: 3, energyAvailable: 300, energyCapacityAvailable: 300 });
    recordSurvivalMode('LOCAL_STABLE');

    expect(getRoomEnergyBufferThreshold(room)).toBe(500);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(200);
  });

  it('normalizes edge-case room capacity values before capping effective thresholds', () => {
    expect(getEffectiveRoomEnergyBufferThreshold(makeRoom({ level: 4, energyCapacityAvailable: 0 }))).toBe(0);
    expect(getEffectiveRoomEnergyBufferThreshold(makeRoom({ level: 4, energyCapacityAvailable: -1 }))).toBe(0);
    expect(
      getEffectiveRoomEnergyBufferThreshold(
        makeRoom({ level: 4, energyCapacityAvailable: Number.POSITIVE_INFINITY })
      )
    ).toBe(500);
  });

  it('keeps storage reserves based on the configured threshold when room capacity is capped', () => {
    const storage = makeStorage(520);
    const room = makeRoom({ level: 3, energyAvailable: 300, energyCapacityAvailable: 300, storage });

    expect(getRoomEnergyBufferThreshold(room)).toBe(500);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(200);
    expect(getStorageEnergyReserveThreshold(room)).toBe(500);
    expect(getStorageEnergyAvailableForWithdrawal(room, storage)).toBe(20);
    expect(withdrawFromStorage(room, 20)).toBe(true);
    expect(withdrawFromStorage(room, 21)).toBe(false);
  });

  it('gates construction spending against spawn and extension energy', () => {
    const room = makeRoom({ level: 3, energyAvailable: 560 });

    expect(checkEnergyBufferForSpending(room, 60)).toBe(true);
    expect(checkEnergyBufferForSpending(room, 61)).toBe(false);
  });

  it('allows capacity-enabling construction when it preserves basic worker spawn energy', () => {
    const room = makeRoom({
      level: 3,
      energyAvailable: MINIMUM_WORKER_SPAWN_ENERGY + 50,
      energyCapacityAvailable: 300
    });
    recordSurvivalMode('BOOTSTRAP');

    expect(checkEnergyBufferForSpending(room, 50)).toBe(false);
    expect(checkEnergyBufferForCapacityEnablingConstruction(room, 50)).toBe(true);
  });

  it('blocks capacity-enabling construction below the worker spawn energy reserve', () => {
    const room = makeRoom({
      level: 3,
      energyAvailable: MINIMUM_WORKER_SPAWN_ENERGY + 49,
      energyCapacityAvailable: 300
    });
    recordSurvivalMode('BOOTSTRAP');

    expect(checkEnergyBufferForCapacityEnablingConstruction(room, 50)).toBe(false);
  });

  it('keeps bootstrap extension construction above the worker spawn recovery floor', () => {
    const room = makeRoom({
      level: 2,
      energyAvailable: 400,
      energyCapacityAvailable: 400,
      myStructures: [makeExtension('extension1'), makeExtension('extension2')]
    });
    recordSurvivalMode('BOOTSTRAP');

    expect(checkEnergyBufferForSpending(room, 50)).toBe(false);
    expect(checkEnergyBufferForCapacityEnablingConstruction(room, 50)).toBe(true);
    expect(checkEnergyBufferForExtensionConstruction(room, 50)).toBe(true);

    expect(checkEnergyBufferForSpending(room, 250)).toBe(false);
    expect(checkEnergyBufferForCapacityEnablingConstruction(room, 250)).toBe(false);
    expect(checkEnergyBufferForExtensionConstruction(room, 250)).toBe(false);
  });

  it('allows RCL2 bootstrap extension construction at 350 capacity while preserving worker spawn energy', () => {
    const room = makeRoom({
      level: 2,
      energyAvailable: 250,
      energyCapacityAvailable: 350,
      myStructures: [makeExtension('extension1')]
    });
    recordSurvivalMode('BOOTSTRAP');

    expect(checkEnergyBufferForSpending(room, 50)).toBe(false);
    expect(checkEnergyBufferForExtensionConstruction(room, 50)).toBe(true);
    expect(checkEnergyBufferForExtensionConstruction(room, 51)).toBe(false);
  });

  it('does not use the bootstrap extension reserve after extension capacity is complete', () => {
    const room = makeRoom({
      level: 2,
      energyAvailable: 400,
      energyCapacityAvailable: 400,
      myStructures: Array.from({ length: 5 }, (_, index) => makeExtension(`extension${index}`))
    });
    recordSurvivalMode('BOOTSTRAP');

    expect(checkEnergyBufferForExtensionConstruction(room, 250)).toBe(false);
  });

  it('keeps the construction import pressure threshold at spawn capacity', () => {
    expect(CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY).toBe(300);
  });

  it('gates routine storage withdrawals against the storage reserve', () => {
    const storage = makeStorage(900);
    const room = makeRoom({ level: 5, energyAvailable: 900, storage });

    expect(getStorageEnergyAvailableForWithdrawal(room, storage)).toBe(100);
    expect(withdrawFromStorage(room, 100)).toBe(true);
    expect(withdrawFromStorage(room, 101)).toBe(false);
  });

  it('caps the storage reserve below the survival room energy buffer', () => {
    const storage = makeStorage(STORAGE_EMERGENCY_RESERVE + 100);
    const room = makeRoom({ level: 8, energyAvailable: 1_200, storage });
    recordSurvivalMode('DEFENSE');

    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(1_500);
    expect(getStorageEnergyAvailableForWithdrawal(room, storage)).toBe(100);
    expect(withdrawFromStorage(room, 100)).toBe(true);
    expect(withdrawFromStorage(room, 101)).toBe(false);
  });

  it('allows storage withdrawals below the reserve while spawn and extension energy is critical', () => {
    const storage = makeStorage(500);
    const room = makeRoom({ level: 3, energyAvailable: 0, storage });

    expect(getStorageEnergyAvailableForWithdrawal(room, storage)).toBe(500);
    expect(withdrawFromStorage(room, 500)).toBe(true);
    expect(withdrawFromStorage(room, 501)).toBe(false);
  });

  it('raises the active threshold during survival buffer mode', () => {
    const room = makeRoom({ level: 3, energyAvailable: 800 });
    recordSurvivalMode('DEFENSE');

    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(750);
    expect(checkEnergyBufferForSpending(room, 50)).toBe(true);
    expect(checkEnergyBufferForSpending(room, 51)).toBe(false);
    expect(getRoomEnergyBufferHealth(room)).toEqual({
      currentEnergy: 800,
      threshold: 750,
      room: 'W1N1',
      healthy: true
    });
  });

  it('uses the standard threshold during economy mode', () => {
    const room = makeRoom({ level: 3, energyAvailable: 800 });
    recordSurvivalMode('LOCAL_STABLE');

    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(500);
    expect(checkEnergyBufferForSpending(room, 300)).toBe(true);
    expect(checkEnergyBufferForSpending(room, 301)).toBe(false);
  });
});

function recordSurvivalMode(mode: 'BOOTSTRAP' | 'LOCAL_STABLE' | 'DEFENSE'): void {
  const inputByMode = {
    BOOTSTRAP: { workerCapacity: 1, workerTarget: 3, hostileCreepCount: 0 },
    LOCAL_STABLE: { workerCapacity: 3, workerTarget: 4, hostileCreepCount: 0 },
    DEFENSE: { workerCapacity: 4, workerTarget: 4, hostileCreepCount: 1 }
  }[mode];
  const assessment = assessColonySurvival({
    roomName: 'W1N1',
    energyCapacityAvailable: 650,
    controller: { my: true, level: 3, ticksToDowngrade: 10_000 },
    ...inputByMode
  });
  expect(assessment.mode).toBe(mode);
  recordColonySurvivalAssessment('W1N1', assessment, 100);
}

function makeRoom({
  energyAvailable = 0,
  energyCapacityAvailable,
  level,
  myStructures = [],
  storage
}: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  level?: number;
  myStructures?: AnyOwnedStructure[];
  storage?: StructureStorage;
}): Room {
  const visibleStructures = storage ? [storage as unknown as AnyOwnedStructure, ...myStructures] : myStructures;
  return {
    name: 'W1N1',
    energyAvailable,
    ...(energyCapacityAvailable === undefined ? {} : { energyCapacityAvailable }),
    controller: { level, my: true } as StructureController,
    ...(storage ? { storage } : {}),
    find: jest.fn((type: number) => {
      if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
        return visibleStructures;
      }

      return [];
    })
  } as unknown as Room;
}

function makeStorage(energy: number): StructureStorage {
  return {
    id: 'storage1',
    structureType: 'storage',
    store: {
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0))
    }
  } as unknown as StructureStorage;
}

function makeExtension(id: string): StructureExtension {
  return {
    id,
    structureType: 'extension'
  } as unknown as StructureExtension;
}
