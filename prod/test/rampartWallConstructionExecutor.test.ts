import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { runRampartWallConstructionExecutorForColony } from '../src/territory/rampartWallConstructionExecutor';

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_STRUCTURES: 2,
  FIND_CONSTRUCTION_SITES: 3,
  FIND_MY_STRUCTURES: 4,
  FIND_MY_CONSTRUCTION_SITES: 5,
  FIND_EXIT: 6,
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_WALL: 'constructedWall',
  TERRAIN_MASK_WALL: 1,
  OK: OK_CODE
} as const;

describe('rampart and wall construction executor', () => {
  beforeEach(() => {
    Object.assign(globalThis, TEST_GLOBALS);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim', createdBy: 'expansionPlanner' }]
      }
    };
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }
    delete globals.Game;
    delete globals.Memory;
  });

  it('creates the first tower rampart after essential claimed-room structures are covered', () => {
    const { colony, room } = makeBarrierExecutorColony();
    installGame(room);

    const result = runRampartWallConstructionExecutorForColony(colony, { requireExpansionMemory: true });

    expect(result).toEqual({
      roomName: 'W2N1',
      status: 'created',
      result: OK_CODE,
      stage: 'towerRampart',
      structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
      x: 24,
      y: 24
    });
    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 24, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('creates spawn/controller core ramparts after tower ramparts are covered', () => {
    const towerRampart = makeStructure('tower-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 24, 24);
    const { colony, room } = makeBarrierExecutorColony({ extraStructures: [towerRampart] });
    installGame(room);

    const result = runRampartWallConstructionExecutorForColony(colony, { requireExpansionMemory: true });

    expect(result).toMatchObject({
      roomName: 'W2N1',
      status: 'created',
      stage: 'coreRampart',
      structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
      x: 25,
      y: 24
    });
    expect(room.createConstructionSite).toHaveBeenCalledWith(25, 24, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('skips barrier placement until essential structures and tower coverage are placed', () => {
    const { colony, room } = makeBarrierExecutorColony({ includeTower: false });
    installGame(room);

    const result = runRampartWallConstructionExecutorForColony(colony, { requireExpansionMemory: true });

    expect(result).toEqual({
      roomName: 'W2N1',
      status: 'skipped',
      reason: 'essentialStructuresPending'
    });
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});

interface BarrierExecutorRoom extends Room {
  find: jest.Mock;
  createConstructionSite: jest.Mock;
}

interface BarrierExecutorOptions {
  includeTower?: boolean;
  extraStructures?: Structure[];
  constructionSites?: ConstructionSite[];
}

function makeBarrierExecutorColony({
  includeTower = true,
  extraStructures = [],
  constructionSites = []
}: BarrierExecutorOptions = {}): { colony: ColonySnapshot; room: BarrierExecutorRoom } {
  const roomName = 'W2N1';
  const sources = [
    makeSource('source-a', 10, 10),
    makeSource('source-b', 40, 10)
  ];
  const spawn = makeStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 25, 25);
  const containers = [
    makeStructure('container-a', TEST_GLOBALS.STRUCTURE_CONTAINER, 11, 11),
    makeStructure('container-b', TEST_GLOBALS.STRUCTURE_CONTAINER, 39, 11)
  ];
  const extensions = Array.from({ length: 10 }, (_value, index) =>
    makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
  );
  const structures = [
    spawn,
    ...containers,
    ...extensions,
    ...(includeTower ? [makeStructure('tower1', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24)] : []),
    ...extraStructures
  ];
  const sites = [...constructionSites];
  const room = {
    name: roomName,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    controller: {
      id: 'controller-W2N1' as Id<StructureController>,
      my: true,
      level: 3,
      pos: makePosition(25, 25, roomName)
    },
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_SOURCES:
          return sources;
        case TEST_GLOBALS.FIND_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_CONSTRUCTION_SITES:
          return sites;
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return structures.filter((structure) =>
            structure.structureType !== TEST_GLOBALS.STRUCTURE_CONTAINER
          );
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
          return sites;
        case TEST_GLOBALS.FIND_EXIT:
          return [
            makePosition(24, 0, roomName),
            makePosition(25, 0, roomName),
            makePosition(26, 0, roomName)
          ];
        default:
          return [];
      }
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: BuildableStructureConstant) => {
      sites.push(makeConstructionSite(`site-${x}-${y}`, structureType, x, y));
      return OK_CODE;
    })
  } as unknown as BarrierExecutorRoom;

  for (const structure of structures) {
    (structure as Structure & { room?: Room }).room = room;
  }

  return {
    room,
    colony: {
      room,
      spawns: [spawn as StructureSpawn],
      energyAvailable: 800,
      energyCapacityAvailable: 800
    }
  };
}

function makeSource(id: string, x: number, y: number): Source {
  return {
    id,
    pos: makePosition(x, y, 'W2N1')
  } as unknown as Source;
}

function makeStructure(id: string, structureType: StructureConstant, x: number, y: number): Structure {
  return {
    id,
    name: id,
    structureType,
    pos: makePosition(x, y, 'W2N1')
  } as unknown as Structure;
}

function makeConstructionSite(
  id: string,
  structureType: BuildableStructureConstant,
  x: number,
  y: number
): ConstructionSite {
  return {
    id,
    structureType,
    pos: makePosition(x, y, 'W2N1')
  } as unknown as ConstructionSite;
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function installGame(room: Room): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 123,
    rooms: { [room.name]: room },
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(0)
      })
    } as unknown as GameMap
  };
}
