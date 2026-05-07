import {
  getDynamicBodyCost,
  selectDynamicCreepBody
} from '../src/economy/creepBodyScaling';
import { isSpawnEnergyBufferViolated } from '../src/economy/spawnEnergyBuffer';
import { buildWorkerBody } from '../src/spawn/bodyBuilder';

describe('selectDynamicCreepBody', () => {
  it('selects a minimal functional body when buffered energy is low', () => {
    const room = makeRoom({
      energyAvailable: 250,
      energyCapacityAvailable: 800,
      level: 3,
      minimumEnergyPerSpawn: 50
    });
    const spawn = makeSpawn(room);

    const selection = selectDynamicCreepBody({
      room,
      spawns: [spawn],
      candidates: [
        {
          role: 'worker',
          demand: 'recovery',
          needed: true,
          buildBody: (energyBudget) => buildWorkerBody(energyBudget, 3)
        }
      ]
    });

    expect(selection).toMatchObject({
      role: 'worker',
      demand: 'recovery',
      energyBudget: 200,
      reserveEnergy: 50,
      body: ['work', 'carry', 'move'],
      bodyCost: 200,
      reserveViolated: false
    });
  });

  it('scales to the max RCL body allowed by a full room and spawn reserve', () => {
    const room = makeRoom({
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      level: 4,
      minimumEnergyPerSpawn: 500
    });
    const spawn = makeSpawn(room);

    const selection = selectDynamicCreepBody({
      room,
      spawns: [spawn],
      candidates: [
        {
          role: 'worker',
          demand: 'standard',
          needed: true,
          buildBody: (energyBudget) => buildWorkerBody(energyBudget, 4)
        }
      ]
    });

    expect(selection?.energyBudget).toBe(1_800);
    expect(selection?.body).toEqual(buildWorkerBody(1_800, 4));
    expect(selection?.bodyCost).toBe(1_800);
    expect(selection?.body).toHaveLength(26);
  });

  it('selects the highest-priority active role demand from mixed candidates', () => {
    const room = makeRoom({
      energyAvailable: 400,
      energyCapacityAvailable: 400,
      level: 2,
      minimumEnergyPerSpawn: 0
    });
    const spawn = makeSpawn(room);

    const selection = selectDynamicCreepBody({
      room,
      spawns: [spawn],
      candidates: [
        {
          role: 'worker',
          demand: 'standard',
          needed: true,
          buildBody: (energyBudget) => (energyBudget >= 200 ? ['work', 'carry', 'move'] : [])
        },
        {
          role: 'defender',
          demand: 'recovery',
          needed: true,
          buildBody: (energyBudget) => (energyBudget >= 140 ? ['tough', 'attack', 'move'] : [])
        }
      ]
    });

    expect(selection?.role).toBe('defender');
    expect(selection?.body).toEqual(['tough', 'attack', 'move']);
    expect(getDynamicBodyCost(selection?.body ?? [])).toBe(140);
  });

  it('refuses bodies that would over-draft the spawn buffer reserve', () => {
    const room = makeRoom({
      energyAvailable: 699,
      energyCapacityAvailable: 800,
      level: 4,
      minimumEnergyPerSpawn: 500
    });
    const spawn = makeSpawn(room);

    expect(
      selectDynamicCreepBody({
        room,
        spawns: [spawn],
        candidates: [
          {
            role: 'worker',
            demand: 'recovery',
            needed: true,
            buildBody: (energyBudget) => buildWorkerBody(energyBudget, 4)
          }
        ]
      })
    ).toBeNull();

    (room as { energyAvailable: number }).energyAvailable = 700;
    const selection = selectDynamicCreepBody({
      room,
      spawns: [spawn],
      candidates: [
        {
          role: 'worker',
          demand: 'recovery',
          needed: true,
          buildBody: (energyBudget) => buildWorkerBody(energyBudget, 4)
        }
      ]
    });

    expect(selection?.body).toEqual(['work', 'carry', 'move']);
    expect(selection?.reserveViolated).toBe(false);
    expect(isSpawnEnergyBufferViolated(room, [spawn], 700, selection?.bodyCost ?? 0)).toBe(false);
  });
});

function makeRoom({
  energyAvailable,
  energyCapacityAvailable,
  level,
  minimumEnergyPerSpawn
}: {
  energyAvailable: number;
  energyCapacityAvailable: number;
  level: number;
  minimumEnergyPerSpawn: number;
}): Room & { memory: RoomMemory } {
  return {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: { my: true, level } as StructureController,
    memory: {
      spawnEnergyBuffer: { minimumEnergyPerSpawn }
    }
  } as unknown as Room & { memory: RoomMemory };
}

function makeSpawn(room: Room): StructureSpawn {
  return {
    id: 'spawn1',
    name: 'Spawn1',
    room,
    structureType: 'spawn'
  } as unknown as StructureSpawn;
}
