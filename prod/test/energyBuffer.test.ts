import {
  checkEnergyBufferForCapacityEnablingConstruction,
  checkEnergyBufferForSpending,
  CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY,
  getEffectiveRoomEnergyBufferThreshold,
  getRoomEnergyBufferHealth,
  getRoomEnergyBufferThreshold,
  getStorageEnergyAvailableForWithdrawal,
  getStorageEnergyReserveThreshold,
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

  it('caps the RCL 4 buffer threshold at spawn-only room capacity', () => {
    const room = makeRoom({ level: 4, energyAvailable: 300, energyCapacityAvailable: 300 });

    expect(getRoomEnergyBufferThreshold(room)).toBe(300);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(300);
    expect(getRoomEnergyBufferHealth(room)).toEqual({
      currentEnergy: 300,
      threshold: 300,
      room: 'W1N1',
      healthy: true
    });
  });

  it('caps the RCL 5 buffer threshold at limited extension capacity', () => {
    const room = makeRoom({ level: 5, energyAvailable: 650, energyCapacityAvailable: 650 });

    expect(getRoomEnergyBufferThreshold(room)).toBe(650);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(650);
    expect(getRoomEnergyBufferHealth(room).healthy).toBe(true);
  });

  it('applies the survival multiplier after capping the threshold to room capacity', () => {
    const room = makeRoom({ level: 4, energyAvailable: 300, energyCapacityAvailable: 300 });
    recordSurvivalMode('DEFENSE');

    expect(getRoomEnergyBufferThreshold(room)).toBe(300);
    expect(getEffectiveRoomEnergyBufferThreshold(room)).toBe(450);
  });

  it('normalizes edge-case room capacity values before capping thresholds', () => {
    expect(getRoomEnergyBufferThreshold(makeRoom({ level: 4, energyCapacityAvailable: 0 }))).toBe(0);
    expect(getRoomEnergyBufferThreshold(makeRoom({ level: 4, energyCapacityAvailable: -1 }))).toBe(0);
    expect(
      getRoomEnergyBufferThreshold(makeRoom({ level: 4, energyCapacityAvailable: Number.POSITIVE_INFINITY }))
    ).toBe(500);
  });

  it('keeps storage reserves based on the configured threshold when room capacity is capped', () => {
    const storage = makeStorage(520);
    const room = makeRoom({ level: 3, energyAvailable: 300, energyCapacityAvailable: 300, storage });

    expect(getRoomEnergyBufferThreshold(room)).toBe(300);
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

  it('allows capacity-enabling construction when spending would consume a full-capacity buffer', () => {
    const room = makeRoom({
      level: 3,
      energyAvailable: CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY,
      energyCapacityAvailable: 300
    });

    expect(checkEnergyBufferForSpending(room, 50)).toBe(false);
    expect(checkEnergyBufferForCapacityEnablingConstruction(room, 50)).toBe(true);
  });

  it('blocks capacity-enabling construction below worker spawn energy', () => {
    const room = makeRoom({
      level: 3,
      energyAvailable: CONSTRUCTION_SPENDING_MINIMUM_SPAWN_ENERGY - 1,
      energyCapacityAvailable: 300
    });

    expect(checkEnergyBufferForCapacityEnablingConstruction(room, 50)).toBe(false);
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

function recordSurvivalMode(mode: 'LOCAL_STABLE' | 'DEFENSE'): void {
  const inputByMode = {
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
  storage
}: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  level?: number;
  storage?: StructureStorage;
}): Room {
  return {
    name: 'W1N1',
    energyAvailable,
    ...(energyCapacityAvailable === undefined ? {} : { energyCapacityAvailable }),
    controller: { level, my: true } as StructureController,
    ...(storage ? { storage } : {}),
    find: jest.fn((type: number) => {
      if (type === FIND_MY_STRUCTURES || type === FIND_STRUCTURES) {
        return storage ? [storage] : [];
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
