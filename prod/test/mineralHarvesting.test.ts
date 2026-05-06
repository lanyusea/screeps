import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  buildMineralHarvesterBody,
  MINERAL_HARVESTER_ROLE,
  planMineralHarvesterSpawn,
  runMineralHarvester,
  selectMineralHarvestAssignment,
  shouldAllowMineralHarvesting
} from '../src/economy/mineral-harvesting';

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
      mineralType: 'H',
      targetId: 'terminal1'
    });
  });

  it('skips rooms without extractor, available mineral, storage, or terminal capacity', () => {
    expect(selectMineralHarvestAssignment(makeMineralRoom({ hasExtractor: false }).room, [])).toBeNull();
    expect(selectMineralHarvestAssignment(makeMineralRoom({ mineralAmount: 0 }).room, [])).toBeNull();
    expect(selectMineralHarvestAssignment(makeMineralRoom({ terminalFreeCapacity: 0, storageFreeCapacity: 0 }).room, [])).toBeNull();
    expect(selectMineralHarvestAssignment(makeMineralRoom({ controllerOwned: false }).room, [])).toBeNull();
  });

  it('does not assign another harvester to a mineral with an active harvester', () => {
    const { room } = makeMineralRoom();
    const activeHarvester = {
      memory: {
        role: MINERAL_HARVESTER_ROLE,
        mineralHarvester: {
          homeRoom: 'W1N1',
          mineralId: 'mineral1' as Id<Mineral>,
          targetId: 'terminal1' as Id<AnyStoreStructure>
        }
      },
      ticksToLive: 500
    } as Creep;

    expect(selectMineralHarvestAssignment(room, [activeHarvester])).toBeNull();
  });

  it('builds mineral harvester bodies from the extractor template and caps work parts at RCL 6+', () => {
    expect(buildMineralHarvesterBody(199, 6)).toEqual([]);
    expect(buildMineralHarvesterBody(200, 6)).toEqual(['work', 'carry', 'move']);
    expect(buildMineralHarvesterBody(300, 6)).toEqual(['work', 'carry', 'move', 'move']);
    expect(buildMineralHarvesterBody(400, 6)).toEqual(['work', 'work', 'carry', 'move', 'move', 'move']);
    expect(buildMineralHarvesterBody(500, 6)).toEqual(['work', 'work', 'work', 'carry', 'move', 'move', 'move']);
    expect(buildMineralHarvesterBody(1_000, 6).filter((part) => part === 'work')).toHaveLength(3);
    expect(buildMineralHarvesterBody(1_000, 5).filter((part) => part === 'work')).toHaveLength(2);
  });

  it('enforces the mineral harvesting room-energy gate at 30 percent capacity', () => {
    expect(shouldAllowMineralHarvesting(299, 1_000)).toBe(false);
    expect(shouldAllowMineralHarvesting(300, 1_000)).toBe(true);
    expect(shouldAllowMineralHarvesting(0, 0)).toBe(false);
  });

  it('plans a mineral harvester only when the energy gate and body budget allow it', () => {
    const { room, spawn } = makeMineralRoom({ energyAvailable: 300, energyCapacityAvailable: 1_000 });
    const colony: ColonySnapshot = {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 1_000
    };

    expect(planMineralHarvesterSpawn(colony, [], 99, { energyAvailable: 299, bodyEnergyBudget: 1_000 })).toBeNull();
    expect(planMineralHarvesterSpawn(colony, [], 99, { energyAvailable: 300, bodyEnergyBudget: 300 })).toMatchObject({
      body: ['work', 'carry', 'move', 'move'],
      name: 'mineralHarvester-W1N1-99',
      memory: {
        role: MINERAL_HARVESTER_ROLE,
        colony: 'W1N1',
        mineralHarvester: {
          homeRoom: 'W1N1',
          mineralId: 'mineral1',
          mineralType: 'H',
          targetId: 'terminal1'
        }
      }
    });
  });

  it('delivers carried minerals to terminal or storage', () => {
    const { room, terminal } = makeMineralRoom();
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      rooms: { W1N1: room },
      creeps: {}
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

    expect(creep.transfer).toHaveBeenCalledWith(terminal, 'H');
    expect(creep.memory.task).toEqual({ type: 'transfer', targetId: 'terminal1' });
  });
});

function makeMineralRoom({
  controllerOwned = true,
  hasExtractor = true,
  mineralAmount = 5_000,
  terminalFreeCapacity = 5_000,
  storageFreeCapacity = 5_000,
  energyAvailable = 1_000,
  energyCapacityAvailable = 1_000
}: {
  controllerOwned?: boolean;
  hasExtractor?: boolean;
  mineralAmount?: number;
  terminalFreeCapacity?: number;
  storageFreeCapacity?: number;
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
    structureType: 'extractor'
  } as StructureExtractor;
  const mineral = {
    id: 'mineral1',
    mineralAmount,
    mineralType: 'H'
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
