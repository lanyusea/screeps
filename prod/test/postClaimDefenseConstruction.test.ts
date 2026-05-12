import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { refreshPostClaimDefenseConstruction } from '../src/territory/postClaimBootstrap';

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

describe('post-claim defense construction refresh', () => {
  beforeEach(() => {
    Object.assign(globalThis, TEST_GLOBALS);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          E17S58: {
            colony: 'E17S59',
            roomName: 'E17S58',
            status: 'ready',
            claimedAt: 817,
            updatedAt: 818,
            workerTarget: 2,
            controllerId: 'controller-e17s58' as Id<StructureController>
          }
        },
        claimedRoomBootstrapper: {
          rooms: {
            E17S58: {
              roomName: 'E17S58',
              owned: true,
              claimedAt: 817,
              updatedAt: 818
            }
          }
        }
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

  it('queues a tower and an exit rampart for claimed E17S58 defense bootstrap', () => {
    const { colony, room } = makePostClaimDefenseColony();
    installGame(room);

    const result = refreshPostClaimDefenseConstruction(colony);

    expect(result.tower).toMatchObject({
      roomName: 'E17S58',
      status: 'created',
      result: OK_CODE
    });
    expect(result.barrier).toEqual({
      roomName: 'E17S58',
      status: 'created',
      result: OK_CODE,
      stage: 'entranceRampart',
      structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
      x: 25,
      y: 1
    });
    expect(room.createConstructionSite).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      TEST_GLOBALS.STRUCTURE_TOWER
    );
    expect(room.createConstructionSite).toHaveBeenCalledWith(25, 1, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('queues a tower and an exit rampart for claimed E18S59 defense bootstrap', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          E18S59: {
            colony: 'E17S59',
            roomName: 'E18S59',
            status: 'ready',
            claimedAt: 837,
            updatedAt: 838,
            workerTarget: 2,
            controllerId: 'controller-e18s59' as Id<StructureController>
          }
        },
        claimedRoomBootstrapper: {
          rooms: {
            E18S59: {
              roomName: 'E18S59',
              owned: true,
              claimedAt: 837,
              updatedAt: 838
            }
          }
        }
      }
    };
    const { colony, room } = makePostClaimDefenseColony('E18S59');
    installGame(room);

    const result = refreshPostClaimDefenseConstruction(colony);

    expect(result.tower).toMatchObject({
      roomName: 'E18S59',
      status: 'created',
      result: OK_CODE
    });
    expect(result.barrier).toEqual({
      roomName: 'E18S59',
      status: 'created',
      result: OK_CODE,
      stage: 'entranceRampart',
      structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
      x: 25,
      y: 1
    });
    expect(room.createConstructionSite).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      TEST_GLOBALS.STRUCTURE_TOWER
    );
    expect(room.createConstructionSite).toHaveBeenCalledWith(25, 1, TEST_GLOBALS.STRUCTURE_RAMPART);
  });


  it('does not run defense planning when the post-claim bootstrap record is missing', () => {
    const territory = (globalThis as unknown as { Memory: Partial<Memory> }).Memory.territory;
    if (territory?.postClaimBootstraps) {
      delete territory.postClaimBootstraps.E17S58;
    }
    const { colony, room } = makePostClaimDefenseColony();
    installGame(room);

    const result = refreshPostClaimDefenseConstruction(colony);

    expect(result).toEqual({ active: false, tower: null, barrier: null });
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('does not run defense planning after the claimed room bootstrap is established', () => {
    const claimedRoomRecord = (globalThis as unknown as { Memory: Partial<Memory> }).Memory.territory
      ?.claimedRoomBootstrapper?.rooms.E17S58;
    if (claimedRoomRecord) {
      claimedRoomRecord.completedAt = 900;
    }
    const { colony, room } = makePostClaimDefenseColony();
    installGame(room);

    const result = refreshPostClaimDefenseConstruction(colony);

    expect(result).toEqual({ active: false, tower: null, barrier: null });
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});

interface PostClaimDefenseRoom extends Room {
  createConstructionSite: jest.Mock;
  find: jest.Mock;
}

function makePostClaimDefenseColony(roomName = 'E17S58'): { colony: ColonySnapshot; room: PostClaimDefenseRoom } {
  const constructionSites: ConstructionSite[] = [];
  const sources = [
    makeSource('source-a', 10, 10, roomName),
    makeSource('source-b', 40, 10, roomName)
  ];
  const spawn = makeStructure('spawn-e17s58', TEST_GLOBALS.STRUCTURE_SPAWN, 25, 25, roomName);
  const containers = [
    makeStructure('container-a', TEST_GLOBALS.STRUCTURE_CONTAINER, 11, 11, roomName),
    makeStructure('container-b', TEST_GLOBALS.STRUCTURE_CONTAINER, 39, 11, roomName)
  ];
  const extensions = Array.from({ length: 10 }, (_value, index) =>
    makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30, roomName)
  );
  const structures = [spawn, ...containers, ...extensions];
  const room = {
    name: roomName,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    controller: {
      id: 'controller-e17s58' as Id<StructureController>,
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
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return structures.filter((structure) => structure.structureType !== TEST_GLOBALS.STRUCTURE_CONTAINER);
        case TEST_GLOBALS.FIND_CONSTRUCTION_SITES:
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
          return constructionSites;
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
      constructionSites.push(makeConstructionSite(`site-${x}-${y}-${structureType}`, structureType, x, y, roomName));
      return OK_CODE;
    })
  } as unknown as PostClaimDefenseRoom;

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

function makeSource(id: string, x: number, y: number, roomName: string): Source {
  return {
    id,
    pos: makePosition(x, y, roomName)
  } as unknown as Source;
}

function makeStructure(id: string, structureType: StructureConstant, x: number, y: number, roomName: string): Structure {
  return {
    id,
    name: id,
    structureType,
    pos: makePosition(x, y, roomName)
  } as unknown as Structure;
}

function makeConstructionSite(
  id: string,
  structureType: BuildableStructureConstant,
  x: number,
  y: number,
  roomName: string
): ConstructionSite {
  return {
    id,
    structureType,
    pos: makePosition(x, y, roomName)
  } as unknown as ConstructionSite;
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function installGame(room: Room): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 819,
    rooms: { [room.name]: room },
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(0)
      })
    } as unknown as GameMap
  };
}
