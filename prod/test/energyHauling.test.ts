import {
  buildEnergyHaulerBody,
  getEnergyHaulingBacklog,
  selectEnergyHaulerSpawnDemand,
  selectEnergyHaulingDeliveryTarget,
  selectEnergyHaulingSource
} from '../src/economy/energyHauling';

describe('energy hauling priority system', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 1;
    (globalThis as unknown as { FIND_MY_STRUCTURES: number }).FIND_MY_STRUCTURES = 2;
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 3;
    (globalThis as unknown as { RESOURCE_ENERGY: ResourceConstant }).RESOURCE_ENERGY = 'energy';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_EXTENSION: StructureConstant }).STRUCTURE_EXTENSION = 'extension';
    (globalThis as unknown as { STRUCTURE_LINK: StructureConstant }).STRUCTURE_LINK = 'link';
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_STORAGE: StructureConstant }).STRUCTURE_STORAGE = 'storage';
    (globalThis as unknown as { STRUCTURE_TERMINAL: StructureConstant }).STRUCTURE_TERMINAL = 'terminal';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('selects the nearest source with energy above the configured threshold', () => {
    const nearUnderThreshold = makeStoreStructure('near-container', STRUCTURE_CONTAINER, 150, 1_850, 1, 1);
    const fartherContainer = makeStoreStructure('far-container', STRUCTURE_CONTAINER, 800, 1_200, 12, 12);
    const nearestEligibleStorage = makeStoreStructure('storage1', STRUCTURE_STORAGE, 300, 9_700, 4, 4);
    const room = makeRoom([nearUnderThreshold, fartherContainer, nearestEligibleStorage], []);

    const source = selectEnergyHaulingSource(room, makePosition(2, 2), { sourceEnergyThreshold: 200 });

    expect(source?.id).toBe('storage1');
  });

  it('ignores hostile-owned hauling sources while keeping neutral containers eligible', () => {
    const hostileLink = makeStoreStructure('hostile-link', STRUCTURE_LINK, 800, 0, 1, 1, 800, false);
    const hostileStorage = makeStoreStructure('hostile-storage', STRUCTURE_STORAGE, 5_000, 5_000, 2, 2, 10_000, false);
    const hostileTerminal = makeStoreStructure('hostile-terminal', STRUCTURE_TERMINAL, 5_000, 5_000, 3, 3, 10_000, false);
    const neutralContainer = makeStoreStructure('neutral-container', STRUCTURE_CONTAINER, 300, 1_700, 8, 8);
    const room = makeRoom([hostileLink, hostileStorage, hostileTerminal, neutralContainer], []);

    const source = selectEnergyHaulingSource(room, makePosition(1, 1), { sourceEnergyThreshold: 200 });

    expect(source?.id).toBe('neutral-container');
  });

  it('keeps delivery priority ahead of distance and then picks the closest target in the tier', () => {
    const spawn = makeStoreStructure('spawn1', STRUCTURE_SPAWN, 100, 200, 20, 20);
    const extension = makeStoreStructure('extension1', STRUCTURE_EXTENSION, 0, 50, 3, 3);
    const tower = makeStoreStructure('tower1', STRUCTURE_TOWER, 400, 600, 2, 2);
    const room = makeRoom([], [tower, extension, spawn]);

    expect(selectEnergyHaulingDeliveryTarget(room, makePosition(1, 1))?.id).toBe('spawn1');

    const fullSpawn = makeStoreStructure('spawn-full', STRUCTURE_SPAWN, 300, 0, 20, 20);
    const nearExtension = makeStoreStructure('extension-near', STRUCTURE_EXTENSION, 0, 50, 3, 3);
    const farExtension = makeStoreStructure('extension-far', STRUCTURE_EXTENSION, 0, 50, 10, 10);
    const extensionRoom = makeRoom([], [fullSpawn, farExtension, nearExtension, tower]);

    expect(selectEnergyHaulingDeliveryTarget(extensionRoom, makePosition(1, 1))?.id).toBe('extension-near');
  });

  it('reports spawn demand when container and link backlog exceeds the threshold below the hauler cap', () => {
    const container = makeStoreStructure('container1', STRUCTURE_CONTAINER, 350, 1_650, 5, 5);
    const link = makeStoreStructure('link1', STRUCTURE_LINK, 300, 500, 6, 6, 800);
    const hostileLink = makeStoreStructure('hostile-link', STRUCTURE_LINK, 900, 0, 7, 7, 800, false);
    const storage = makeStoreStructure('storage1', STRUCTURE_STORAGE, 1_000, 9_000, 10, 10);
    const room = makeRoom([container, link, hostileLink], [storage], { controller: { my: true } as StructureController });
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      creeps: {
        LocalHauler: makeHauler('W1N1', 1_400)
      }
    };

    expect(getEnergyHaulingBacklog(room, { sourceEnergyThreshold: 100 })).toBe(650);
    expect(selectEnergyHaulerSpawnDemand(room, { backlogEnergyThreshold: 500, maxHaulers: 2 })).toEqual({
      activeHaulers: 1,
      backlogEnergy: 650,
      maxHaulers: 2,
      roomName: 'W1N1'
    });

    expect(selectEnergyHaulerSpawnDemand(room, { backlogEnergyThreshold: 500, maxHaulers: 1 })).toBeNull();
    expect(selectEnergyHaulerSpawnDemand(room, { backlogEnergyThreshold: 700, maxHaulers: 2 })).toBeNull();
  });

  it('builds carry capacity in proportion to available room energy capacity', () => {
    expect(countBodyParts(buildEnergyHaulerBody(300), 'carry')).toBe(3);
    expect(countBodyParts(buildEnergyHaulerBody(800), 'carry')).toBe(8);
    expect(buildEnergyHaulerBody(99)).toEqual([]);
  });
});

function makeRoom(
  structures: Structure[],
  ownedStructures: AnyOwnedStructure[],
  overrides: Partial<Room> = {}
): Room {
  return {
    name: 'W1N1',
    find: jest.fn((type: number) => {
      if (type === FIND_STRUCTURES) {
        return structures;
      }

      if (type === FIND_MY_STRUCTURES) {
        return ownedStructures;
      }

      if (type === FIND_SOURCES) {
        return [];
      }

      return [];
    }),
    ...overrides
  } as unknown as Room;
}

function makeHauler(colony: string, ticksToLive: number): Creep {
  return {
    ticksToLive,
    memory: {
      role: 'hauler',
      colony,
      energyHauler: { roomName: colony }
    }
  } as unknown as Creep;
}

function makeStoreStructure(
  id: string,
  structureType: StructureConstant,
  usedEnergy: number,
  freeEnergy: number,
  x: number,
  y: number,
  capacity = usedEnergy + freeEnergy,
  my: boolean | undefined = structureType === STRUCTURE_CONTAINER ? undefined : true
): AnyOwnedStructure {
  return {
    id,
    structureType,
    ...(my === undefined ? {} : { my }),
    pos: makePosition(x, y),
    store: {
      getUsedCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? usedEnergy : 0)),
      getFreeCapacity: jest.fn((resource: ResourceConstant) => (resource === RESOURCE_ENERGY ? freeEnergy : 0)),
      getCapacity: jest.fn((resource?: ResourceConstant) => (resource === undefined || resource === RESOURCE_ENERGY ? capacity : 0))
    }
  } as unknown as AnyOwnedStructure;
}

function makePosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return {
    x,
    y,
    roomName,
    getRangeTo: jest.fn((target: RoomObject | RoomPosition) => {
      const position = 'pos' in target ? target.pos : target;
      return Math.max(Math.abs(x - position.x), Math.abs(y - position.y));
    })
  } as unknown as RoomPosition;
}

function countBodyParts(body: BodyPartConstant[], part: BodyPartConstant): number {
  return body.filter((candidate) => candidate === part).length;
}
