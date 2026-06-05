import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { assessColonySnapshotSurvival, assessColonySurvival } from '../src/colony/survivalMode';

describe('assessColonySurvival', () => {
  it('enters bootstrap with no workers', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 0,
        workerTarget: 3,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'BOOTSTRAP',
      survivalWorkerFloor: 3,
      suppressionReasons: ['bootstrapWorkerFloor']
    });
  });

  it('keeps bootstrap while workers are below the survival floor', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 2,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      }).mode
    ).toBe('BOOTSTRAP');
  });

  it('keeps scoreCollector-only rooms in bootstrap worker recovery', () => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;

    expect(
      assessColonySnapshotSurvival(makeColonySnapshot(), {
        worker: 0,
        sourceHarvester: 0,
        defender: 0,
        claimer: 0,
        scout: 0,
        scoreCollector: 3
      })
    ).toMatchObject({
      mode: 'BOOTSTRAP',
      totalCreeps: 0,
      suppressionReasons: ['bootstrapWorkerFloor']
    });
  });

  it('uses local stable while the survival floor is met but territory gates are not', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 3,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        defenseFloorReady: true,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'LOCAL_STABLE',
      suppressionReasons: ['localWorkerRecovery']
    });
  });

  it('marks territory ready only after home stability gates are satisfied', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 4,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        defenseFloorReady: true,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'TERRITORY_READY',
      territoryReady: true,
      suppressionReasons: []
    });
  });

  it('switches to defense mode while visible hostiles are present', () => {
    expect(
      assessColonySurvival({
        roomName: 'W1N1',
        workerCapacity: 4,
        workerTarget: 4,
        energyCapacityAvailable: 650,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 },
        defenseFloorReady: true,
        hostileCreepCount: 1
      })
    ).toMatchObject({
      mode: 'DEFENSE',
      suppressionReasons: ['defense']
    });
  });
});

function makeColonySnapshot(): ColonySnapshot {
  const source = { id: 'source1' } as Source;
  const room = {
    name: 'W1N1',
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return [source];
      }

      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES) {
        return [];
      }

      return [];
    })
  } as unknown as Room;
  const spawn = {
    name: 'Spawn1',
    room,
    spawning: null
  } as StructureSpawn;

  return {
    room,
    spawns: [spawn],
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    spawnEnergyBudget: 800
  };
}
