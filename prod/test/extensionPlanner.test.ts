import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { getExtensionLimitForRcl, planExtensionConstruction } from '../src/construction/extensionPlanner';

const TEST_GLOBALS = {
  FIND_MY_STRUCTURES: 1,
  FIND_MY_CONSTRUCTION_SITES: 2,
  STRUCTURE_EXTENSION: 'extension',
  TERRAIN_MASK_WALL: 1,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite'
} as const;

describe('extension construction planner', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(TEST_GLOBALS)) {
      globals[key] = value;
    }
  });

  afterEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }
    delete globals.Game;
  });

  it('maps extension limits by RCL and no-ops below RCL2', () => {
    expect(getExtensionLimitForRcl(1)).toBe(0);
    expect(getExtensionLimitForRcl(undefined)).toBe(0);
    expect(getExtensionLimitForRcl(2)).toBe(5);
    expect(getExtensionLimitForRcl(3)).toBe(10);
    expect(getExtensionLimitForRcl(4)).toBe(20);
    expect(getExtensionLimitForRcl(5)).toBe(30);
    expect(getExtensionLimitForRcl(6)).toBe(40);
    expect(getExtensionLimitForRcl(7)).toBe(50);
    expect(getExtensionLimitForRcl(8)).toBe(60);
    expect(getExtensionLimitForRcl(9)).toBe(0);

    const { room, colony } = makeColony({ controllerLevel: 1 });

    expect(planExtensionConstruction(colony)).toBeNull();
    expect(room.find).not.toHaveBeenCalled();
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('creates the first deterministic extension site at RCL2', () => {
    const { room, colony } = makeColony({ controllerLevel: 2 });

    expect(planExtensionConstruction(colony)).toBe(0);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 24, STRUCTURE_EXTENSION);
  });

  it('does not create when current and pending extensions already meet the allowed count', () => {
    const existingExtensions = Array.from({ length: 3 }, (_, index) => makeExtension(`extension-${index}`));
    const pendingExtensions = Array.from({ length: 2 }, (_, index) => makeExtensionSite(`site-${index}`));
    const { room, colony } = makeColony({
      controllerLevel: 2,
      structures: existingExtensions,
      constructionSites: pendingExtensions
    });

    expect(planExtensionConstruction(colony)).toBeNull();

    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('avoids occupied, wall, and duplicate positions before choosing the next candidate', () => {
    const { room, colony } = makeColony({
      controllerLevel: 2,
      wallPositions: new Set(['24,26']),
      structures: [makeExtension('existing-at-first-candidate', { x: 24, y: 24 })],
      constructionSites: [makeExtensionSite('pending-at-second-candidate', { x: 26, y: 24 })]
    });

    expect(planExtensionConstruction(colony)).toBe(0);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(26, 26, STRUCTURE_EXTENSION);
    expect(room.lookForAt).not.toHaveBeenCalled();
    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_STRUCTURES, 19, 19, 31, 31, true);
    expect(room.lookForAtArea).toHaveBeenCalledWith(LOOK_CONSTRUCTION_SITES, 19, 19, 31, 31, true);
    expect(room.lookForAtArea).toHaveBeenCalledTimes(2);
    expect((Game.map.getRoomTerrain as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('continues scanning when the nearby extension ring is blocked', () => {
    const { room, colony } = makeColony({
      controllerLevel: 2,
      wallPositions: new Set(['26,26']),
      structures: [
        makeExtension('existing-at-first-candidate', { x: 24, y: 24 }),
        makeExtension('existing-at-second-candidate', { x: 26, y: 24 })
      ],
      constructionSites: [makeExtensionSite('pending-at-third-candidate', { x: 24, y: 26 })]
    });

    expect(planExtensionConstruction(colony)).toBe(0);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, STRUCTURE_EXTENSION);
  });

  it('keeps adjacent cardinal paths open while filling RCL2 extension sites', () => {
    const { room, colony } = makeColony({ controllerLevel: 2 });

    for (let site = 0; site < 5; site += 1) {
      expect(planExtensionConstruction(colony)).toBe(0);
    }

    const placedPositions = new Set(room.createConstructionSite.mock.calls.map(([x, y]) => `${x},${y}`));

    expect(placedPositions).toEqual(new Set(['24,24', '26,24', '24,26', '26,26', '23,23']));
    expect(placedPositions.has('25,24')).toBe(false);
    expect(placedPositions.has('24,25')).toBe(false);
    expect(placedPositions.has('26,25')).toBe(false);
    expect(placedPositions.has('25,26')).toBe(false);
  });
});

interface MockRoom extends Room {
  find: jest.Mock;
  createConstructionSite: jest.Mock;
  lookForAt: jest.Mock;
  lookForAtArea: jest.Mock;
}

interface TestPosition {
  x: number;
  y: number;
}

function makeColony(options: {
  controllerLevel: number;
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
  wallPositions?: Set<string>;
}): { room: MockRoom; colony: ColonySnapshot } {
  const structures = options.structures ?? [];
  const constructionSites = [...(options.constructionSites ?? [])];
  const wallPositions = options.wallPositions ?? new Set<string>();
  const roomName = 'W1N1';
  const controller = {
    my: true,
    level: options.controllerLevel,
    pos: { x: 20, y: 20, roomName }
  } as unknown as StructureController;
  const room = {
    name: roomName,
    controller,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    find: jest.fn((findType: number, findOptions?: { filter?: (target: Structure | ConstructionSite) => boolean }) => {
      const targets =
        findType === TEST_GLOBALS.FIND_MY_STRUCTURES
          ? structures
          : findType === TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES
            ? constructionSites
            : [];

      return findOptions?.filter ? targets.filter(findOptions.filter) : targets;
    }),
    lookForAt: jest.fn(() => {
      throw new Error('extension planner should use cached occupancy instead of per-candidate lookups');
    }),
    lookForAtArea: jest.fn((lookType: string, top: number, left: number, bottom: number, right: number) => {
      if (lookType === TEST_GLOBALS.LOOK_STRUCTURES) {
        return getStructureLookResults(structures, top, left, bottom, right);
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return getConstructionSiteLookResults(constructionSites, top, left, bottom, right);
      }

      return [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
      constructionSites.push({
        id: `site-${x}-${y}`,
        structureType,
        pos: { x, y, roomName } as RoomPosition
      } as ConstructionSite);

      return 0;
    })
  } as unknown as MockRoom;
  const spawn = {
    name: 'Spawn1',
    room,
    pos: { x: 25, y: 25, roomName }
  } as unknown as StructureSpawn;

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: (x: number, y: number) => (wallPositions.has(`${x},${y}`) ? TEST_GLOBALS.TERRAIN_MASK_WALL : 0)
      })
    } as unknown as Game['map']
  };

  return {
    room,
    colony: {
      room,
      spawns: [spawn],
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    }
  };
}

function makeExtension(id: string, position: TestPosition = { x: 40, y: 40 }): Structure {
  return {
    id,
    structureType: TEST_GLOBALS.STRUCTURE_EXTENSION,
    pos: makeRoomPosition(position)
  } as unknown as Structure;
}

function makeExtensionSite(id: string, position: TestPosition = { x: 41, y: 41 }): ConstructionSite {
  return {
    id,
    structureType: TEST_GLOBALS.STRUCTURE_EXTENSION,
    pos: makeRoomPosition(position)
  } as unknown as ConstructionSite;
}

function makeRoomPosition(position: TestPosition): RoomPosition {
  return { ...position, roomName: 'W1N1' } as RoomPosition;
}

function getStructureLookResults(structures: Structure[], top: number, left: number, bottom: number, right: number): LookAtResultWithPos[] {
  return structures.flatMap((structure) => {
    const position = (structure as { pos?: RoomPosition }).pos;
    return position && isWithinBounds(position, top, left, bottom, right)
      ? [{ x: position.x, y: position.y, structure } as LookAtResultWithPos]
      : [];
  });
}

function getConstructionSiteLookResults(
  constructionSites: ConstructionSite[],
  top: number,
  left: number,
  bottom: number,
  right: number
): LookAtResultWithPos[] {
  return constructionSites.flatMap((constructionSite) => {
    const position = (constructionSite as { pos?: RoomPosition }).pos;
    return position && isWithinBounds(position, top, left, bottom, right)
      ? [{ x: position.x, y: position.y, constructionSite } as LookAtResultWithPos]
      : [];
  });
}

function isWithinBounds(position: TestPosition, top: number, left: number, bottom: number, right: number): boolean {
  return position.x >= left && position.x <= right && position.y >= top && position.y <= bottom;
}
