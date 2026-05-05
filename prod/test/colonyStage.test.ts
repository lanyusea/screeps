import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  assessColonyStage,
  EMERGENCY_BOOTSTRAP_WORKER_BODY,
  getColonySpawnPriorityTiers,
  suppressesTerritoryWork
} from '../src/colony/colonyStage';
import { planSpawn } from '../src/spawn/spawnPlanner';

describe('colony bootstrap stage', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_MY_CONSTRUCTION_SITES: number }).FIND_MY_CONSTRUCTION_SITES = 2;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 3;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 4;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('activates BOOTSTRAP when total creeps are below three', () => {
    expect(
      assessColonyStage({
        roomName: 'W1N1',
        totalCreeps: 2,
        workerCapacity: 2,
        workerTarget: 3,
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'BOOTSTRAP',
      suppressionReasons: ['bootstrapWorkerFloor']
    });
  });

  it('activates BOOTSTRAP when spawn energy is below 300', () => {
    expect(
      assessColonyStage({
        roomName: 'W1N1',
        totalCreeps: 5,
        workerCapacity: 5,
        workerTarget: 3,
        energyAvailable: 299,
        energyCapacityAvailable: 800,
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'BOOTSTRAP',
      suppressionReasons: ['spawnEnergyCritical']
    });
  });

  it('suppresses territory tasks in BOOTSTRAP', () => {
    const assessment = assessColonyStage({
      roomName: 'W1N1',
      totalCreeps: 1,
      workerCapacity: 1,
      workerTarget: 3,
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
    });

    expect(suppressesTerritoryWork(assessment)).toBe(true);
  });

  it('keeps the controller downgrade guard active in BOOTSTRAP', () => {
    expect(
      assessColonyStage({
        roomName: 'W1N1',
        totalCreeps: 1,
        workerCapacity: 1,
        workerTarget: 3,
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        controller: { my: true, level: 3, ticksToDowngrade: 999 }
      })
    ).toMatchObject({
      mode: 'BOOTSTRAP',
      controllerDowngradeGuard: true
    });
  });

  it('transitions from BOOTSTRAP to LOCAL_STABLE after five creeps and 800 energy', () => {
    expect(
      assessColonyStage({
        roomName: 'W1N1',
        totalCreeps: 5,
        workerCapacity: 3,
        workerTarget: 4,
        energyAvailable: 800,
        energyCapacityAvailable: 800,
        previousMode: 'BOOTSTRAP',
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'LOCAL_STABLE',
      bootstrapRecovery: false,
      suppressionReasons: ['localWorkerRecovery']
    });
  });

  it('transitions from BOOTSTRAP when low-RCL spawn energy reaches capacity', () => {
    expect(
      assessColonyStage({
        roomName: 'W1N1',
        totalCreeps: 5,
        workerCapacity: 5,
        workerTarget: 4,
        energyAvailable: 400,
        energyCapacityAvailable: 400,
        previousMode: 'BOOTSTRAP',
        controller: { my: true, level: 3, ticksToDowngrade: 10_000 }
      })
    ).toMatchObject({
      mode: 'LOCAL_STABLE',
      bootstrapRecovery: false
    });
  });

  it('orders spawn tiers from emergency bootstrap through territory work', () => {
    expect(getColonySpawnPriorityTiers()).toEqual([
      'emergencyBootstrap',
      'localRefillSurvival',
      'controllerDowngradeGuard',
      'defense',
      'territoryRemote'
    ]);

    const { colony: emergencyColony, spawn: emergencySpawn } = makeColony({
      sourceCount: 2,
      energyAvailable: 800,
      energyCapacityAvailable: 800
    });
    expect(planSpawn(emergencyColony, { worker: 1 }, 100)).toEqual({
      spawn: emergencySpawn,
      body: EMERGENCY_BOOTSTRAP_WORKER_BODY,
      name: 'worker-W1N1-100',
      memory: { role: 'worker', colony: 'W1N1' }
    });

    const { colony: defenseColony, spawn: defenseSpawn } = makeColony({
      sourceCount: 2,
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      hostileCreeps: [{ id: 'hostile1' } as Creep]
    });
    expect(planSpawn(defenseColony, { worker: 3 }, 101)).toEqual({
      spawn: defenseSpawn,
      body: ['work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move', 'move', 'move'],
      name: 'worker-W1N1-101',
      memory: { role: 'worker', colony: 'W1N1' }
    });

    expect(planSpawn(defenseColony, { worker: 4 }, 102)).toEqual({
      spawn: defenseSpawn,
      body: ['tough', 'attack', 'move'],
      name: 'defender-W1N1-102',
      memory: {
        role: 'defender',
        colony: 'W1N1',
        defense: { homeRoom: 'W1N1' }
      }
    });
  });
});

function makeColony({
  sourceCount = 1,
  energyAvailable = 300,
  energyCapacityAvailable = 300,
  hostileCreeps = []
}: {
  sourceCount?: number;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  hostileCreeps?: Creep[];
} = {}): { colony: ColonySnapshot; spawn: StructureSpawn } {
  const sources = Array.from({ length: sourceCount }, (_, index) => ({ id: `source${index}` }) as Source);
  const room = {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: { my: true, level: 3, ticksToDowngrade: 10_000 } as StructureController,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_HOSTILE_CREEPS) {
        return hostileCreeps;
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
    colony: {
      room,
      spawns: [spawn],
      energyAvailable,
      energyCapacityAvailable
    },
    spawn
  };
}
