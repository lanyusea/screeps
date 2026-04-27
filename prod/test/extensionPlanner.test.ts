import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { getExtensionLimitForRcl, planExtensionConstruction } from '../src/construction/extensionPlanner';

const TEST_GLOBALS = {
  FIND_MY_STRUCTURES: 1,
  FIND_MY_CONSTRUCTION_SITES: 2,
  STRUCTURE_EXTENSION: 'extension',
  TERRAIN_MASK_WALL: 1
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
      wallPositions: new Set(['25,24']),
      lookEntriesByPosition: {
        '24,24': [{ structure: makeExtension('existing-at-first-candidate') }],
        '26,24': [{ constructionSite: makeExtensionSite('pending-at-third-candidate') }]
      }
    });

    expect(planExtensionConstruction(colony)).toBe(0);

    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(24, 25, STRUCTURE_EXTENSION);
  });
});

interface MockRoom extends Room {
  find: jest.Mock;
  createConstructionSite: jest.Mock;
}

function makeColony(options: {
  controllerLevel: number;
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
  wallPositions?: Set<string>;
  lookEntriesByPosition?: Record<string, Array<Partial<LookAtResult>>>;
}): { room: MockRoom; colony: ColonySnapshot } {
  const structures = options.structures ?? [];
  const constructionSites = options.constructionSites ?? [];
  const wallPositions = options.wallPositions ?? new Set<string>();
  const lookEntriesByPosition = options.lookEntriesByPosition ?? {};
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
    lookAt: jest.fn((x: number, y: number) => lookEntriesByPosition[`${x},${y}`] ?? []),
    createConstructionSite: jest.fn().mockReturnValue(0)
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

function makeExtension(id: string): Structure {
  return {
    id,
    structureType: TEST_GLOBALS.STRUCTURE_EXTENSION
  } as unknown as Structure;
}

function makeExtensionSite(id: string): ConstructionSite {
  return {
    id,
    structureType: TEST_GLOBALS.STRUCTURE_EXTENSION
  } as unknown as ConstructionSite;
}
