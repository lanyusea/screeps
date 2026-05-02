import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { planSourceContainerConstruction } from '../src/construction/sourceContainerPlanner';

const OK_CODE = 0 as ScreepsReturnCode;

describe('source container planner', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 2;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 3;
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { OK: ScreepsReturnCode }).OK = OK_CODE;
  });

  afterEach(() => {
    delete (globalThis as unknown as { Game?: Partial<Game> }).Game;
  });

  it('places a container construction site on an open source-adjacent tile at RCL2', () => {
    const source = makeSource('source1', 10, 10);
    const { room, colony } = makeColony({
      sources: [source],
      wallPositions: new Set(['9,9', '9,11', '10,9', '10,11', '11,9', '11,10', '11,11'])
    });

    expect(planSourceContainerConstruction(colony)).toBe(OK_CODE);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(9, 10, STRUCTURE_CONTAINER);
  });

  it('skips sources that already have a source-adjacent container or pending site', () => {
    const source1 = makeSource('source1', 10, 10);
    const source2 = makeSource('source2', 20, 20);
    const existingContainer = makeStructure('container1', 'container', 10, 11);
    const pendingContainer = makeConstructionSite('pending-container', 'container', 19, 20);
    const { room, colony } = makeColony({
      sources: [source1, source2],
      structures: [existingContainer],
      constructionSites: [pendingContainer]
    });

    expect(planSourceContainerConstruction(colony)).toBeNull();

    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });
});

interface MockRoom extends Room {
  createConstructionSite: jest.Mock;
}

function makeColony({
  sources,
  structures = [],
  constructionSites = [],
  wallPositions = new Set<string>()
}: {
  sources: Source[];
  structures?: AnyStructure[];
  constructionSites?: ConstructionSite[];
  wallPositions?: Set<string>;
}): { room: MockRoom; colony: ColonySnapshot } {
  const room = {
    name: 'W1N1',
    controller: { my: true, level: 2 } as StructureController,
    find: jest.fn((type: number) => {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_STRUCTURES) {
        return structures;
      }

      return type === FIND_CONSTRUCTION_SITES ? constructionSites : [];
    }),
    createConstructionSite: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as MockRoom;
  const spawn = {
    name: 'Spawn1',
    room,
    pos: { x: 5, y: 10, roomName: 'W1N1' } as RoomPosition
  } as unknown as StructureSpawn;

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: jest.fn((x: number, y: number) => (wallPositions.has(`${x},${y}`) ? TERRAIN_MASK_WALL : 0))
      })
    } as unknown as Game['map']
  };

  return {
    room,
    colony: {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: 550
    }
  };
}

function makeSource(id: string, x: number, y: number): Source {
  return {
    id,
    pos: { x, y, roomName: 'W1N1' } as RoomPosition
  } as unknown as Source;
}

function makeStructure(id: string, structureType: StructureConstant, x: number, y: number): AnyStructure {
  return {
    id,
    structureType,
    pos: { x, y, roomName: 'W1N1' } as RoomPosition
  } as unknown as AnyStructure;
}

function makeConstructionSite(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number
): ConstructionSite {
  return {
    id,
    structureType,
    pos: { x, y, roomName: 'W1N1' } as RoomPosition
  } as ConstructionSite;
}
