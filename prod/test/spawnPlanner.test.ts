import { planSpawn } from '../src/spawn/spawnPlanner';
import { ColonySnapshot } from '../src/colony/colonyRegistry';

describe('planSpawn', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
  });

  function makeColony({
    sourceCount = 1,
    energyAvailable = 300,
    energyCapacityAvailable = 300,
    spawning = null
  }: {
    sourceCount?: number;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    spawning?: Spawning | null;
  } = {}): { colony: ColonySnapshot; spawn: StructureSpawn } {
    const sources = Array.from({ length: sourceCount }, (_, index) => ({ id: `source${index}` }) as Source);
    const room = {
      name: 'W1N1',
      energyAvailable,
      energyCapacityAvailable,
      find: jest.fn((type: number) => (type === FIND_SOURCES ? sources : []))
    } as unknown as Room;
    const spawn = { name: 'Spawn1', room, spawning } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable,
      energyCapacityAvailable
    };

    return { colony, spawn };
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

  it('does not overbuild when replacement-aware worker capacity is at target', () => {
    const { colony } = makeColony();

    expect(planSpawn(colony, { worker: 3 }, 124)).toBeNull();
  });

  it('targets a fourth worker for two-source rooms', () => {
    const { colony, spawn } = makeColony({ sourceCount: 2 });

    expect(planSpawn(colony, { worker: 3 }, 126)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-126',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(planSpawn(colony, { worker: 4 }, 126)).toBeNull();
  });

  it('caps the source-aware worker target', () => {
    const { colony, spawn } = makeColony({ sourceCount: 10 });

    expect(planSpawn(colony, { worker: 5 }, 127)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-127',
      memory: { role: 'worker', colony: 'W1N1' }
    });
    expect(planSpawn(colony, { worker: 6 }, 127)).toBeNull();
  });

  it('plans an emergency basic worker when zero active workers cannot afford the normal worker body', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 200, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 0 }, 125)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-125',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('waits for normal worker energy instead of using the emergency body for replacements', () => {
    const { colony } = makeColony({ energyAvailable: 200, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 2 }, 125)).toBeNull();
  });

  it('does not plan an emergency body that costs more than available energy', () => {
    const { colony } = makeColony({ energyAvailable: 199, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 0 }, 125)).toBeNull();
  });

  it('does not plan when all spawns are busy', () => {
    const { colony } = makeColony({ spawning: {} as Spawning });

    expect(planSpawn(colony, { worker: 0 }, 123)).toBeNull();
  });
});
