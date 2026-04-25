import { planSpawn } from '../src/spawn/spawnPlanner';
import { ColonySnapshot } from '../src/colony/colonyRegistry';

describe('planSpawn', () => {
  const room = {
    name: 'W1N1',
    energyAvailable: 300,
    energyCapacityAvailable: 300
  } as Room;

  it('plans a worker when the colony has no workers and an idle spawn', () => {
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    };

    expect(planSpawn(colony, { worker: 0 }, 123)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-123',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('does not plan when target workers already exist', () => {
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    };

    expect(planSpawn(colony, { worker: 3 }, 123)).toBeNull();
  });

  it('plans one replacement when steady-state worker capacity is below target', () => {
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    };

    expect(planSpawn(colony, { worker: 2 }, 124)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-124',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('does not overbuild when replacement-aware worker capacity is at target', () => {
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    };

    expect(planSpawn(colony, { worker: 3 }, 124)).toBeNull();
  });

  it('plans an emergency basic worker when zero active workers cannot afford the normal worker body', () => {
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 200,
      energyCapacityAvailable: 400
    };

    expect(planSpawn(colony, { worker: 0 }, 125)).toEqual({
      spawn,
      body: ['work', 'carry', 'move'],
      name: 'worker-W1N1-125',
      memory: { role: 'worker', colony: 'W1N1' }
    });
  });

  it('waits for normal worker energy instead of using the emergency body for replacements', () => {
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 200,
      energyCapacityAvailable: 400
    };

    expect(planSpawn(colony, { worker: 2 }, 125)).toBeNull();
  });

  it('does not plan an emergency body that costs more than available energy', () => {
    const spawn = { name: 'Spawn1', room, spawning: null } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 199,
      energyCapacityAvailable: 400
    };

    expect(planSpawn(colony, { worker: 0 }, 125)).toBeNull();
  });

  it('does not plan when all spawns are busy', () => {
    const spawn = { name: 'Spawn1', room, spawning: {} as Spawning } as StructureSpawn;
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    };

    expect(planSpawn(colony, { worker: 0 }, 123)).toBeNull();
  });
});
