import { buildSourceWorkloadRecords, recordSourceWorkloads } from '../src/economy/sourceWorkload';

describe('source workload tracking', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { WORK: BodyPartConstant }).WORK = 'work';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
      } as unknown as Game['map']
    };
  });

  it('counts assigned source harvesters and records harvest capacity versus regen rate', () => {
    const source1 = makeSource('source1', 10, 10);
    const source2 = makeSource('source2', 20, 20);
    const container = makeContainer('container1', 10, 11);
    const room = makeRoom([source1, source2], [container]);
    const creeps = [
      makeWorker(room, 'source1', 2),
      makeWorker(room, 'source1', 1),
      makeWorker(room, 'source2', 1),
      makeWorker({ name: 'W2N2' } as Room, 'source1', 5),
      { memory: { role: 'miner', task: { type: 'harvest', targetId: 'source1' } }, room } as unknown as Creep
    ];

    const records = buildSourceWorkloadRecords(room, [source1, source2], creeps);

    expect(records).toEqual([
      {
        sourceId: 'source1',
        assignedHarvesters: 2,
        assignedWorkParts: 3,
        openPositions: 8,
        harvestWorkCapacity: 5,
        harvestEnergyPerTick: 6,
        regenEnergyPerTick: 10,
        sourceEnergyCapacity: 3_000,
        sourceEnergyRegenTicks: 300,
        hasContainer: true,
        containerId: 'container1'
      },
      {
        sourceId: 'source2',
        assignedHarvesters: 1,
        assignedWorkParts: 1,
        openPositions: 8,
        harvestWorkCapacity: 5,
        harvestEnergyPerTick: 2,
        regenEnergyPerTick: 10,
        sourceEnergyCapacity: 3_000,
        sourceEnergyRegenTicks: 300,
        hasContainer: false
      }
    ]);

    recordSourceWorkloads(room, creeps, 123);

    expect(Memory.economy?.sourceWorkloads?.W1N1).toEqual({
      updatedAt: 123,
      sources: {
        source1: records[0],
        source2: records[1]
      }
    });
  });
});

function makeSource(id: string, x: number, y: number): Source {
  return {
    id,
    energyCapacity: 3_000,
    pos: { x, y, roomName: 'W1N1' } as RoomPosition
  } as unknown as Source;
}

function makeContainer(id: string, x: number, y: number): StructureContainer {
  return {
    id,
    structureType: 'container',
    pos: { x, y, roomName: 'W1N1' } as RoomPosition
  } as unknown as StructureContainer;
}

function makeRoom(sources: Source[], structures: AnyStructure[]): Room {
  return {
    name: 'W1N1',
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      return type === FIND_STRUCTURES ? structures : [];
    })
  } as unknown as Room;
}

function makeWorker(room: Room, sourceId: string, workParts: number): Creep {
  return {
    memory: { role: 'worker', task: { type: 'harvest', targetId: sourceId as Id<Source> } },
    room,
    getActiveBodyparts: jest.fn().mockReturnValue(workParts)
  } as unknown as Creep;
}
