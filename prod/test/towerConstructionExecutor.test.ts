import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { runTowerConstructionExecutorForColony } from '../src/territory/towerConstructionExecutor';

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_STRUCTURES: 2,
  FIND_CONSTRUCTION_SITES: 3,
  FIND_MY_STRUCTURES: 4,
  FIND_MY_CONSTRUCTION_SITES: 5,
  FIND_EXIT: 6,
  STRUCTURE_TOWER: 'tower',
  TERRAIN_MASK_WALL: 1,
  OK: OK_CODE
} as const;

describe('tower construction executor', () => {
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

  it('creates a tower construction site in claimed expansion rooms with open tower capacity', () => {
    const { colony, room } = makeTowerExecutorColony();
    installGame(room);

    const result = runTowerConstructionExecutorForColony(colony, { requireExpansionMemory: true });

    expect(result).toMatchObject({
      roomName: 'W2N1',
      status: 'created',
      result: OK_CODE,
      x: expect.any(Number),
      y: expect.any(Number)
    });
    expect(room.createConstructionSite).toHaveBeenCalledWith(
      result.x,
      result.y,
      TEST_GLOBALS.STRUCTURE_TOWER
    );
  });

  it('does not create duplicate tower sites when capacity is already covered', () => {
    const towerSite = makeConstructionSite('tower-site', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24);
    const { colony, room } = makeTowerExecutorColony({ constructionSites: [towerSite] });
    installGame(room);

    const result = runTowerConstructionExecutorForColony(colony, { requireExpansionMemory: true });

    expect(result).toEqual({
      roomName: 'W2N1',
      status: 'skipped',
      reason: 'towerCapacityCovered'
    });
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});

interface TowerExecutorRoom extends Room {
  find: jest.Mock;
  createConstructionSite: jest.Mock;
}

function makeTowerExecutorColony({
  constructionSites = []
}: {
  constructionSites?: ConstructionSite[];
} = {}): { colony: ColonySnapshot; room: TowerExecutorRoom } {
  const roomName = 'W2N1';
  const structures: Structure[] = [];
  const sites = [...constructionSites];
  const sources = [
    makeSource('source-a', 20, 25, roomName),
    makeSource('source-b', 30, 25, roomName)
  ];
  const room = {
    name: roomName,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
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
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_CONSTRUCTION_SITES:
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
          return sites;
        case TEST_GLOBALS.FIND_EXIT:
          return [makePosition(25, 0, roomName)];
        default:
          return [];
      }
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: BuildableStructureConstant) => {
      sites.push(makeConstructionSite(`site-${x}-${y}`, structureType, x, y));
      return OK_CODE;
    })
  } as unknown as TowerExecutorRoom;

  return {
    room,
    colony: {
      room,
      spawns: [],
      energyAvailable: 300,
      energyCapacityAvailable: 300
    }
  };
}

function makeSource(id: string, x: number, y: number, roomName: string): Source {
  return {
    id,
    pos: makePosition(x, y, roomName)
  } as unknown as Source;
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
