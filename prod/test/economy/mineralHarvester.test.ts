import type { ColonySnapshot } from '../../src/colony/colonyRegistry';
import {
  buildMineralHarvesterBody,
  MINERAL_HARVESTER_ROLE,
  planMineralHarvesterSpawn,
  runMineralHarvester,
  selectMineralHarvestAssignment,
  shouldAllowMineralHarvesting
} from '../../src/economy/mineralHarvester';

const OK_CODE = 0 as ScreepsReturnCode;

describe('mineral harvesting', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 3;
    (globalThis as unknown as { STRUCTURE_EXTRACTOR: StructureConstant }).STRUCTURE_EXTRACTOR = 'extractor';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('detects an owned extractor room with a non-exhausted mineral and delivery target', () => {
    const { room } = makeMineralRoom();

    expect(selectMineralHarvestAssignment(room, [])).toEqual({
      homeRoom: 'W1N1',
      mineralId: 'mineral1',
      mineralAmount: 5_000,
      mineralType: 'H',
      targetId: 'storage1'
    });
  });

  it('skips rooms without extractor, available mineral, owned controller, storage capacity, or extractor placement', () => {
    expect(selectMineralHarvestAssignment(makeMineralRoom({ hasExtractor: false }).room, [])).toBeNull();
    expect(selectMineralHarvestAssignment(makeMineralRoom({ mineralAmount: 0 }).room, [])).toBeNull();
    expect(selectMineralHarvestAssignment(makeMineralRoom({ storageFreeCapacity: 0 }).room, [])).toBeNull();
    expect(selectMineralHarvestAssignment(makeMineralRoom({ controllerOwned: false }).room, [])).toBeNull();
    expect(selectMineralHarvestAssignment(makeMineralRoom({ extractorOnMineral: false }).room, [])).toBeNull();
  });

  it('does not assign another harvester to a mineral with an active harvester', () => {
    const { room } = makeMineralRoom();
    const activeHarvester = {
      memory: {
        role: MINERAL_HARVESTER_ROLE,
        mineralHarvester: {
          homeRoom: 'W1N1',
          mineralId: 'mineral1' as Id<Mineral>,
          targetId: 'storage1' as Id<AnyStoreStructure>
        }
      },
      ticksToLive: 500
    } as Creep;

    expect(selectMineralHarvestAssignment(room, [activeHarvester])).toBeNull();
  });

  it('scales mineral harvester WORK parts to available mineral amount with a 10 WORK cap', () => {
    expect(buildMineralHarvesterBody(199, { mineralAmount: 5_000 })).toEqual([]);
    expect(buildMineralHarvesterBody(200, { mineralAmount: 5_000 })).toEqual(['work', 'carry', 'move']);
    expect(buildMineralHarvesterBody(450, { mineralAmount: 15_000 })).toEqual([
      'work',
      'work',
      'work',
      'carry',
      'move',
      'move'
    ]);
    expect(buildMineralHarvesterBody(900, { mineralAmount: 30_000 })).toEqual([
      'work',
      'work',
      'work',
      'work',
      'work',
      'work',
      'carry',
      'carry',
      'move',
      'move',
      'move',
      'move'
    ]);
    expect(buildMineralHarvesterBody(1_400, { mineralAmount: 80_000 }).filter((part) => part === 'work')).toHaveLength(10);
    expect(
      buildMineralHarvesterBody(1_400, { mineralAmount: 80_000, maxWorkParts: 5 }).filter((part) => part === 'work')
    ).toHaveLength(5);
  });

  it('enforces the mineral harvesting room-energy gate at 50 percent capacity', () => {
    expect(shouldAllowMineralHarvesting(499, 1_000)).toBe(false);
    expect(shouldAllowMineralHarvesting(500, 1_000)).toBe(true);
    expect(shouldAllowMineralHarvesting(0, 0)).toBe(false);
  });

  it('plans a mineral harvester only when the energy gate and body budget allow it', () => {
    const { room, spawn } = makeMineralRoom({
      energyAvailable: 500,
      energyCapacityAvailable: 1_000,
      mineralAmount: 30_000
    });
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 500,
      energyCapacityAvailable: 1_000
    };

    expect(planMineralHarvesterSpawn(colony, [], 99, { energyAvailable: 499, bodyEnergyBudget: 1_400 })).toBeNull();
    expect(planMineralHarvesterSpawn(colony, [], 99, { energyAvailable: 500, bodyEnergyBudget: 900 })).toMatchObject({
      body: [
        'work',
        'work',
        'work',
        'work',
        'work',
        'work',
        'carry',
        'carry',
        'move',
        'move',
        'move',
        'move'
      ],
      name: 'mineralHarvester-W1N1-99',
      memory: {
        role: MINERAL_HARVESTER_ROLE,
        colony: 'W1N1',
        mineralHarvester: {
          homeRoom: 'W1N1',
          mineralId: 'mineral1',
          mineralAmount: 30_000,
          mineralType: 'H',
          targetId: 'storage1'
        }
      }
    });
  });

  it('delivers carried minerals to storage', () => {
    const { room, storage, terminal } = makeMineralRoom();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: room },
      creeps: {},
      getObjectById: jest.fn((id: string) => (id === 'terminal1' ? terminal : null))
    };
    const creep = {
      memory: {
        role: MINERAL_HARVESTER_ROLE,
        mineralHarvester: {
          homeRoom: 'W1N1',
          mineralId: 'mineral1' as Id<Mineral>,
          mineralType: 'H' as ResourceConstant,
          targetId: 'terminal1' as Id<AnyStoreStructure>
        }
      },
      room,
      store: makeStore({ H: 50 }, 0),
      transfer: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as Creep;

    runMineralHarvester(creep);

    expect(creep.transfer).toHaveBeenCalledWith(storage, 'H');
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'storage1' });
  });
});

function makeMineralRoom({
  controllerOwned = true,
  hasExtractor = true,
  mineralAmount = 5_000,
  terminalFreeCapacity = 5_000,
  storageFreeCapacity = 5_000,
  extractorOnMineral = true,
  energyAvailable = 1_000,
  energyCapacityAvailable = 1_000
}: {
  controllerOwned?: boolean;
  hasExtractor?: boolean;
  mineralAmount?: number;
  terminalFreeCapacity?: number;
  storageFreeCapacity?: number;
  extractorOnMineral?: boolean;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
} = {}): {
  room: Room;
  spawn: StructureSpawn;
  terminal: StructureTerminal;
  storage: StructureStorage;
} {
  const extractor = {
    id: 'extractor1',
    structureType: 'extractor',
    pos: makeRoomPosition(extractorOnMineral ? 10 : 11, 20, 'W1N1')
  } as StructureExtractor;
  const mineral = {
    id: 'mineral1',
    mineralAmount,
    mineralType: 'H',
    pos: makeRoomPosition(10, 20, 'W1N1')
  } as Mineral;
  const terminal = {
    id: 'terminal1',
    structureType: 'terminal',
    store: makeStore({}, terminalFreeCapacity)
  } as unknown as StructureTerminal;
  const storage = {
    id: 'storage1',
    structureType: 'storage',
    store: makeStore({}, storageFreeCapacity)
  } as unknown as StructureStorage;
  const room = {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: { my: controllerOwned, level: 6 } as StructureController,
    terminal,
    storage,
    find: jest.fn((type: number) => {
      if (type === FIND_MY_STRUCTURES) {
        return hasExtractor ? [extractor] : [];
      }
      if (type === FIND_STRUCTURES) {
        return hasExtractor ? [extractor] : [];
      }
      if (type === FIND_MINERALS) {
        return [mineral];
      }

      return [];
    })
  } as unknown as Room;
  const spawn = {
    name: 'Spawn1',
    room,
    spawning: null,
    spawnCreep: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as StructureSpawn;

  return { room, spawn, terminal, storage };
}

function makeRoomPosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function makeStore(resources: Partial<Record<ResourceConstant, number>>, freeCapacity: number): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => {
      if (!resource) {
        return Object.values(resources).reduce((total, amount) => total + (amount ?? 0), 0);
      }

      return resources[resource] ?? 0;
    }),
    getFreeCapacity: jest.fn(() => freeCapacity)
  } as unknown as StoreDefinition;
}
