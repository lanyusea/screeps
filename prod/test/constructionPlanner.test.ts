import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  assessColonySurvival,
  clearColonySurvivalAssessmentCache,
  recordColonySurvivalAssessment
} from '../src/colony/survivalMode';
import { planConstructionForColony } from '../src/construction/planner';
import { planExpansionDefenseBarrierPlacements } from '../src/territory/expansionPlanner';

jest.mock('../src/territory/expansionPlanner', () => ({
  planExpansionDefenseBarrierPlacements: jest.fn()
}));

const mockPlanExpansionDefenseBarrierPlacements =
  planExpansionDefenseBarrierPlacements as jest.MockedFunction<typeof planExpansionDefenseBarrierPlacements>;

const OK_CODE = 0 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_MY_STRUCTURES: 2,
  FIND_MY_CONSTRUCTION_SITES: 3,
  FIND_STRUCTURES: 4,
  FIND_CONSTRUCTION_SITES: 5,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  LOOK_MINERALS: 'mineral',
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_WALL: 'constructedWall',
  STRUCTURE_TOWER: 'tower',
  TERRAIN_MASK_WALL: 1,
  OK: OK_CODE
} as const;

describe('owned room construction planner', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(TEST_GLOBALS)) {
      globals[key] = value;
    }
    mockPlanExpansionDefenseBarrierPlacements.mockReset();
    clearColonySurvivalAssessmentCache();
    globals.CONTROLLER_STRUCTURES = makeControllerStructures();
  });

  afterEach(() => {
    clearColonySurvivalAssessmentCache();
    const globals = globalThis as Record<string, unknown>;
    for (const key of Object.keys(TEST_GLOBALS)) {
      delete globals[key];
    }
    delete globals.CONTROLLER_STRUCTURES;
    delete globals.Game;
    delete globals.PathFinder;
  });

  it('queues essential sites in extension, road, container, tower, defense-floor priority order', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: 1_000,
      structures: [
        ...Array.from({ length: 9 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }],
        '25,25': [{ x: 10, y: 11 }]
      }
    });

    const result = planConstructionForColony(colony);

    expect(result.placements.map((placement) => placement.priority)).toEqual([
      'extension',
      'container',
      'road',
      'tower',
      'rampart',
      'wall'
    ]);
    expect(room.createConstructionSite.mock.calls.map(([, , structureType]) => structureType)).toEqual([
      STRUCTURE_EXTENSION,
      STRUCTURE_CONTAINER,
      STRUCTURE_ROAD,
      STRUCTURE_TOWER,
      STRUCTURE_RAMPART,
      STRUCTURE_WALL
    ]);
    expect(result.energyBudget).toBe(500);
    expect(result.energyReserved).toBe(300);
  });

  it('places spawn and controller staging containers after extension work before roads', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: 1_000,
      structures: [
        ...Array.from({ length: 9 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      sources: [],
      pathsByTarget: {
        '25,25': [{ x: 10, y: 11 }]
      }
    });

    const result = planConstructionForColony(colony, { maxContainerSitesPerTick: 2 });

    expect(result.placements.map((placement) => placement.priority)).toEqual([
      'extension',
      'container',
      'container',
      'road',
      'tower',
      'rampart',
      'wall'
    ]);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 9, 9, STRUCTURE_EXTENSION);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 11, 11, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(3, 24, 24, STRUCTURE_CONTAINER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(4, 10, 11, STRUCTURE_ROAD);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(5, 10, 9, STRUCTURE_TOWER);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(6, 10, 10, STRUCTURE_RAMPART);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(7, 11, 9, STRUCTURE_WALL);
  });

  it('keeps non-spawn construction site placement within half of available room energy', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: 100,
      structures: [
        ...Array.from({ length: 9 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony);

    expect(result.energyBudget).toBe(50);
    expect(result.energyReserved).toBe(50);
    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension']);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(9, 9, STRUCTURE_EXTENSION);
  });

  it('prioritizes spawn-only bootstrap extension construction while preserving worker spawn energy', () => {
    installOpenTerrain();
    recordBootstrapSurvivalMode();
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 250,
      energyCapacityAvailable: 300,
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension']);
    expect(result.energyAvailable - result.energyReserved).toBeGreaterThanOrEqual(200);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(9, 9, STRUCTURE_EXTENSION);
  });

  it('does not reserve spawn-only bootstrap extension construction below worker spawn energy', () => {
    installOpenTerrain();
    recordBootstrapSurvivalMode();
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 249,
      energyCapacityAvailable: 300,
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements).toEqual([]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('does not start duplicate extension sites during spawn-only bootstrap', () => {
    installOpenTerrain();
    recordBootstrapSurvivalMode();
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 300,
      energyCapacityAvailable: 300,
      constructionSites: [makeConstructionSite('extension-pending', TEST_GLOBALS.STRUCTURE_EXTENSION, 9, 9, 'W1N1')],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements).toEqual([]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places source containers before extensions during RCL4 energy starvation', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 120,
      energyCapacityAvailable: 300,
      structures: [
        ...Array.from({ length: 10 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements.map((placement) => placement.priority)).toEqual(['container']);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite.mock.calls[0][2]).toBe(STRUCTURE_CONTAINER);
  });

  it('creates harvest-to-spawn road sites before extensions when off-route road backlog exists during starvation', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 120,
      energyCapacityAvailable: 300,
      structures: [
        ...Array.from({ length: 10 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      constructionSites: [
        makeConstructionSite('source-container-pending', TEST_GLOBALS.STRUCTURE_CONTAINER, 19, 10, 'W1N1'),
        makeConstructionSite('off-route-road-1', TEST_GLOBALS.STRUCTURE_ROAD, 40, 40, 'W1N1'),
        makeConstructionSite('off-route-road-2', TEST_GLOBALS.STRUCTURE_ROAD, 41, 40, 'W1N1'),
        makeConstructionSite('off-route-road-3', TEST_GLOBALS.STRUCTURE_ROAD, 42, 40, 'W1N1')
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements.map((placement) => placement.priority)).toEqual(['road']);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 10, STRUCTURE_ROAD);
  });

  it('places capacity-enabling extensions while room capacity is below the survival buffer threshold', () => {
    installOpenTerrain();
    recordBootstrapSurvivalMode();
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 300,
      energyCapacityAvailable: 350,
      structures: [makeStructure('extension-existing', TEST_GLOBALS.STRUCTURE_EXTENSION, 30, 30)],
      sources: [],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension']);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite.mock.calls[0][2]).toBe(STRUCTURE_EXTENSION);
  });

  it('keeps non-capacity construction gated while room capacity is below the survival buffer threshold', () => {
    installOpenTerrain();
    recordBootstrapSurvivalMode();
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 300,
      energyCapacityAvailable: 350,
      structures: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        )
      ],
      sources: [],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements).toEqual([]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('respects CONTROLLER_STRUCTURES counts before calling lower-level planners', () => {
    const controllerStructures = makeControllerStructures();
    controllerStructures.extension[2] = 1;
    controllerStructures.road[2] = 0;
    controllerStructures.container[2] = 0;
    controllerStructures.tower[2] = 0;
    controllerStructures.rampart[2] = 0;
    controllerStructures.constructedWall[2] = 0;
    (globalThis as unknown as { CONTROLLER_STRUCTURES: ReturnType<typeof makeControllerStructures> }).CONTROLLER_STRUCTURES =
      controllerStructures;
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 1_000,
      structures: [makeStructure('extension-existing', TEST_GLOBALS.STRUCTURE_EXTENSION, 30, 30)],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony);

    expect(result.placements).toEqual([]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('places a missing spawn site even when a newly claimed room has no stored spawn energy', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 1,
      energyAvailable: 0,
      includeSpawn: false,
      sources: [makeSource('source-a', 21, 21)],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony);

    expect(result.placements).toEqual([
      {
        priority: 'spawn',
        roomName: 'W1N1',
        structureType: STRUCTURE_SPAWN,
        result: OK_CODE,
        energyReserved: 0,
        x: 23,
        y: 23
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledWith(23, 23, STRUCTURE_SPAWN);
  });

  it('skips same-room entrance wall sites for post-claim barrier progression', () => {
    installOpenTerrain();
    mockPlanExpansionDefenseBarrierPlacements.mockReturnValue([
      {
        roomName: 'W2N1',
        x: 24,
        y: 1,
        structureType: TEST_GLOBALS.STRUCTURE_WALL,
        stage: 'entranceWall',
        priority: 3
      },
      {
        roomName: 'W1N1',
        x: 26,
        y: 1,
        structureType: TEST_GLOBALS.STRUCTURE_WALL,
        stage: 'entranceWall',
        priority: 3
      },
      {
        roomName: 'W1N1',
        x: 26,
        y: 24,
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        stage: 'coreRampart',
        priority: 2
      }
    ]);
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      structures: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        makeStructure('tower-existing', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24)
      ],
      sources: [],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      includePostClaimRamparts: true,
      includeStorage: false,
      respectRoomEnergyBuffer: false
    });

    expect(result.placements).toEqual([
      {
        priority: 'container',
        roomName: 'W1N1',
        structureType: STRUCTURE_CONTAINER,
        result: OK_CODE,
        energyReserved: 50
      },
      {
        priority: 'rampart',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        result: OK_CODE,
        energyReserved: 50,
        x: 10,
        y: 10
      },
      {
        priority: 'wall',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_WALL,
        result: OK_CODE,
        energyReserved: 50,
        x: 11,
        y: 9
      },
      {
        priority: 'rampart',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        result: OK_CODE,
        energyReserved: 50,
        x: 26,
        y: 24
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(4);
    expect(room.createConstructionSite).toHaveBeenCalledWith(10, 10, TEST_GLOBALS.STRUCTURE_RAMPART);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 9, TEST_GLOBALS.STRUCTURE_WALL);
    expect(room.createConstructionSite).toHaveBeenCalledWith(26, 24, TEST_GLOBALS.STRUCTURE_RAMPART);
  });
});

interface MockRoom extends Room {
  find: jest.Mock;
  createConstructionSite: jest.Mock;
  lookForAtArea: jest.Mock;
}

interface TestPosition {
  x: number;
  y: number;
}

interface MakeColonyOptions {
  controllerLevel: number;
  energyAvailable: number;
  energyCapacityAvailable?: number;
  includeSpawn?: boolean;
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
  sources: Source[];
  pathsByTarget: Record<string, TestPosition[]>;
}

class MockCostMatrix {
  set(): void {}
  get(): number {
    return 0;
  }
  clone(): CostMatrix {
    return new MockCostMatrix() as unknown as CostMatrix;
  }
  serialize(): number[] {
    return [];
  }
}

function makeColony(options: MakeColonyOptions): { room: MockRoom; colony: ColonySnapshot } {
  const roomName = 'W1N1';
  const constructionSites = [...(options.constructionSites ?? [])];
  const controller = {
    id: 'controller1',
    my: true,
    level: options.controllerLevel,
    pos: makeRoomPosition(25, 25, roomName)
  } as unknown as StructureController;
  const room = {
    name: roomName,
    energyAvailable: options.energyAvailable,
    energyCapacityAvailable: options.energyCapacityAvailable ?? options.energyAvailable,
    controller,
    find: jest.fn((findType: number, findOptions?: { filter?: (target: unknown) => boolean }) => {
      const targets =
        findType === TEST_GLOBALS.FIND_SOURCES
          ? options.sources
          : findType === TEST_GLOBALS.FIND_MY_STRUCTURES || findType === TEST_GLOBALS.FIND_STRUCTURES
            ? structures
            : findType === TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES ||
                findType === TEST_GLOBALS.FIND_CONSTRUCTION_SITES
              ? constructionSites
              : [];

      return findOptions?.filter ? targets.filter(findOptions.filter) : targets;
    }),
    lookForAtArea: jest.fn((lookType: LookConstant, top: number, left: number, bottom: number, right: number) => {
      if (lookType === TEST_GLOBALS.LOOK_STRUCTURES) {
        return getAreaLookResults(structures, top, left, bottom, right, 'structure');
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return getAreaLookResults(constructionSites, top, left, bottom, right, 'constructionSite');
      }

      return [];
    }),
    createConstructionSite: jest.fn((x: number, y: number, structureType: StructureConstant) => {
      constructionSites.push(makeConstructionSite(`site-${x}-${y}`, structureType, x, y, roomName));
      return OK_CODE;
    })
  } as unknown as MockRoom;
  const spawn = {
    id: 'spawn1',
    name: 'Spawn1',
    room,
    structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
    pos: makeRoomPosition(10, 10, roomName)
  } as unknown as StructureSpawn;
  const structures = [
    ...(options.includeSpawn === false ? [] : [spawn as unknown as Structure]),
    ...(options.structures ?? [])
  ];
  const pathFinderSearch = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => ({
    path: (
      options.pathsByTarget[getRouteKey(origin, goal)] ??
      options.pathsByTarget[getPositionKey(goal.pos)] ??
      []
    ).map((position) => makeRoomPosition(position.x, position.y, roomName)),
    ops: 1,
    cost: 1,
    incomplete: false
  }));

  (globalThis as unknown as { PathFinder: Partial<PathFinder> }).PathFinder = {
    CostMatrix: MockCostMatrix as unknown as typeof PathFinder.CostMatrix,
    search: pathFinderSearch as unknown as typeof PathFinder.search
  };

  return {
    room,
    colony: {
      room,
      spawns: options.includeSpawn === false ? [] : [spawn],
      energyAvailable: options.energyAvailable,
      energyCapacityAvailable: options.energyCapacityAvailable ?? options.energyAvailable
    }
  };
}

function installOpenTerrain(): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 100,
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue(0)
      })
    } as unknown as GameMap
  };
}

function recordBootstrapSurvivalMode(): void {
  const assessment = assessColonySurvival({
    roomName: 'W1N1',
    workerCapacity: 2,
    workerTarget: 4,
    energyAvailable: 300,
    energyCapacityAvailable: 350,
    controller: { my: true, level: 4, ticksToDowngrade: 10_000 }
  });
  expect(assessment.mode).toBe('BOOTSTRAP');
  recordColonySurvivalAssessment('W1N1', assessment, 100);
}

function makeControllerStructures(): Record<string, number[]> {
  return {
    spawn: [0, 1, 1, 1, 1, 1, 1, 2, 3],
    extension: [0, 0, 5, 10, 20, 30, 40, 50, 60],
    road: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
    container: [0, 0, 5, 5, 5, 5, 5, 5, 5],
    rampart: [0, 0, 300, 300, 300, 300, 300, 300, 300],
    constructedWall: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
    tower: [0, 0, 0, 1, 1, 2, 2, 3, 6]
  };
}

function getAreaLookResults(
  objects: Array<Structure | ConstructionSite>,
  top: number,
  left: number,
  bottom: number,
  right: number,
  nestedKey: 'structure' | 'constructionSite'
): unknown[] {
  return objects.flatMap((object) => {
    const position = object.pos;
    if (position.x < left || position.x > right || position.y < top || position.y > bottom) {
      return [];
    }

    return [{ x: position.x, y: position.y, [nestedKey]: object }];
  });
}

function makeSource(id: string, x: number, y: number, roomName = 'W1N1'): Source {
  return {
    id,
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as Source;
}

function makeStructure(id: string, structureType: StructureConstant, x: number, y: number): Structure {
  return {
    id,
    structureType,
    pos: makeRoomPosition(x, y)
  } as unknown as Structure;
}

function makeConstructionSite(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  roomName: string
): ConstructionSite {
  return {
    id,
    structureType,
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as ConstructionSite;
}

function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function getRouteKey(origin: RoomPosition, goal: { pos: RoomPosition }): string {
  return `${getPositionKey(origin)}->${getPositionKey(goal.pos)}`;
}

function getPositionKey(position: { x: number; y: number }): string {
  return `${position.x},${position.y}`;
}
