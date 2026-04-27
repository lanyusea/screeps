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
    roomName = 'W1N1',
    spawning = null
  }: {
    sourceCount?: number;
    energyAvailable?: number;
    energyCapacityAvailable?: number;
    roomName?: string;
    spawning?: Spawning | null;
  } = {}): { colony: ColonySnapshot; spawn: StructureSpawn; find: jest.Mock<Source[], [number]> } {
    const sources = Array.from({ length: sourceCount }, (_, index) => ({ id: `source${index}` }) as Source);
    const find = jest.fn((type: number) => (type === FIND_SOURCES ? sources : []));
    const room = {
      name: roomName,
      energyAvailable,
      energyCapacityAvailable,
      find
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

  it('plans the full capacity worker body when currently affordable', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 400, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 2 }, 134)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-134',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('does not overbuild when replacement-aware worker capacity is at target', () => {
    const { colony } = makeColony();

    expect(planSpawn(colony, { worker: 3 }, 124)).toBeNull();
  });

  it('targets a fourth worker for two-source rooms', () => {
    const { colony, spawn } = makeColony({ roomName: 'W1N2', sourceCount: 2 });

    expect(planSpawn(colony, { worker: 3 }, 126)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N2-126',
      memory: { role: 'worker', colony: 'W1N2' }
    });
    expect(planSpawn(colony, { worker: 4 }, 126)).toBeNull();
  });

  it('caps the source-aware worker target', () => {
    const { colony, spawn } = makeColony({ roomName: 'W1N3', sourceCount: 10 });

    expect(planSpawn(colony, { worker: 5 }, 127)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
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

  it('plans an emergency basic worker when zero active workers cannot afford the normal worker body', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 200, energyCapacityAvailable: 400 });

    expect(planSpawn(colony, { worker: 0 }, 125)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-125',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('keeps zero-worker recovery on the emergency basic worker body when full body is unavailable', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 400, energyCapacityAvailable: 600 });

    expect(planSpawn(colony, { worker: 0 }, 135)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-135',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('plans an affordable worker body below the minimum functional worker target', () => {
    const { colony, spawn } = makeColony({ energyAvailable: 400, energyCapacityAvailable: 600 });

    expect(planSpawn(colony, { worker: 2 }, 136)).toEqual({
      spawn,
      body: ['work', 'carry', 'move', 'work', 'carry', 'move'],
      name: 'worker-W1N1-136',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('waits for the full planned worker body when existing workers can keep harvesting', () => {
    const { colony } = makeColony({
      roomName: 'W1N7',
      sourceCount: 2,
      energyAvailable: 400,
      energyCapacityAvailable: 600
    });

    expect(planSpawn(colony, { worker: 3 }, 137)).toBeNull();
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
