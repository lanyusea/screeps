import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  assessColonySurvival,
  clearColonySurvivalAssessmentCache,
  recordColonySurvivalAssessment
} from '../src/colony/survivalMode';
import { planConstructionForColony } from '../src/construction/planner';
import { TERRITORY_CONTROLLER_BODY_COST } from '../src/spawn/bodyBuilder';
import { DEFAULT_STRATEGY_REGISTRY, type StrategyRegistryEntry } from '../src/strategy/strategyRegistry';
import { planExpansionDefenseBarrierPlacements } from '../src/territory/expansionPlanner';

jest.mock('../src/territory/expansionPlanner', () => ({
  planExpansionDefenseBarrierPlacements: jest.fn()
}));

const mockPlanExpansionDefenseBarrierPlacements =
  planExpansionDefenseBarrierPlacements as jest.MockedFunction<typeof planExpansionDefenseBarrierPlacements>;

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_FULL_CODE = -8 as ScreepsReturnCode;
const FIRST_RCL3_TOWER_PRIORITY_ENERGY = Math.max(500, TERRITORY_CONTROLLER_BODY_COST - 100);

const TEST_GLOBALS = {
  FIND_SOURCES: 1,
  FIND_MY_STRUCTURES: 2,
  FIND_MY_CONSTRUCTION_SITES: 3,
  FIND_STRUCTURES: 4,
  FIND_CONSTRUCTION_SITES: 5,
  FIND_HOSTILE_CREEPS: 6,
  FIND_HOSTILE_STRUCTURES: 7,
  FIND_MY_CREEPS: 8,
  RESOURCE_ENERGY: 'energy',
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
  STRUCTURE_STORAGE: 'storage',
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

  it('uses runtime construction-priority strategy parameters to order actual planning', () => {
    installOpenTerrain();
    const onStrategyRegistryRuntimeUse = jest.fn();
    const strategyRegistry = withConstructionPriorityDefaults({
      baseScoreWeight: 0,
      territorySignalWeight: 0,
      resourceSignalWeight: 30,
      killSignalWeight: 0,
      riskPenalty: 0
    });
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_300,
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
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: false,
      strategyRegistry,
      runtimeStrategyConstructionEnabled: true,
      onStrategyRegistryRuntimeUse
    });

    expect(result.placements[0]).toMatchObject({
      priority: 'storage',
      structureType: TEST_GLOBALS.STRUCTURE_STORAGE,
      result: OK_CODE
    });
    expect(room.createConstructionSite.mock.calls[0][2]).toBe(TEST_GLOBALS.STRUCTURE_STORAGE);
    expect(onStrategyRegistryRuntimeUse).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'construction-priority.incumbent.v1',
        defaultValues: expect.objectContaining({ resourceSignalWeight: 30 })
      })
    );
  });

  it('uses runtime construction-priority strategy parameters without an audit hook', () => {
    installOpenTerrain();
    const strategyRegistry = withConstructionPriorityDefaults({
      baseScoreWeight: 0,
      territorySignalWeight: 0,
      resourceSignalWeight: 30,
      killSignalWeight: 0,
      riskPenalty: 0
    });
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_300,
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
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: false,
      strategyRegistry,
      runtimeStrategyConstructionEnabled: true
    });

    expect(result.placements[0]).toMatchObject({
      priority: 'storage',
      structureType: TEST_GLOBALS.STRUCTURE_STORAGE,
      result: OK_CODE
    });
    expect(room.createConstructionSite.mock.calls[0][2]).toBe(TEST_GLOBALS.STRUCTURE_STORAGE);
  });

  it('keeps legacy construction order when runtime strategy construction is not enabled', () => {
    installOpenTerrain();
    const onStrategyRegistryRuntimeUse = jest.fn();
    const strategyRegistry = withConstructionPriorityDefaults({
      baseScoreWeight: 0,
      territorySignalWeight: 0,
      resourceSignalWeight: 30,
      killSignalWeight: 0,
      riskPenalty: 0
    });
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_300,
      structures: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        makeStructure('tower-existing', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24)
      ],
      sources: [],
      pathsByTarget: {
        '25,25': [{ x: 10, y: 11 }]
      }
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: false,
      strategyRegistry,
      onStrategyRegistryRuntimeUse
    });

    expect(result.placements[0]).toMatchObject({
      priority: 'container',
      structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
      result: OK_CODE
    });
    expect(room.createConstructionSite.mock.calls[0][2]).toBe(TEST_GLOBALS.STRUCTURE_CONTAINER);
    expect(onStrategyRegistryRuntimeUse).not.toHaveBeenCalled();
  });

  it('continues runtime construction planning when the audit hook throws', () => {
    installOpenTerrain();
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const onStrategyRegistryRuntimeUse = jest.fn(() => {
      throw new Error('audit hook failed');
    });
    const strategyRegistry = withConstructionPriorityDefaults({
      baseScoreWeight: 0,
      territorySignalWeight: 0,
      resourceSignalWeight: 30,
      killSignalWeight: 0,
      riskPenalty: 0
    });
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_300,
      structures: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        makeStructure('tower-existing', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24)
      ],
      sources: [],
      pathsByTarget: {}
    });

    try {
      const result = planConstructionForColony(colony, {
        creeps: makeWorkerCreeps(5),
        respectRoomEnergyBuffer: false,
        strategyRegistry,
        runtimeStrategyConstructionEnabled: true,
        onStrategyRegistryRuntimeUse
      });

      expect(result.placements[0]).toMatchObject({
        priority: 'storage',
        structureType: TEST_GLOBALS.STRUCTURE_STORAGE,
        result: OK_CODE
      });
      expect(room.createConstructionSite.mock.calls[0][2]).toBe(TEST_GLOBALS.STRUCTURE_STORAGE);
      expect(onStrategyRegistryRuntimeUse).toHaveBeenCalled();
      expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('runtime-use hook failed'));
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('falls back to legacy construction order when runtime priority lacks creep evidence', () => {
    installOpenTerrain();
    const strategyRegistry = withConstructionPriorityDefaults({
      baseScoreWeight: 0,
      territorySignalWeight: 0,
      resourceSignalWeight: 30,
      killSignalWeight: 0,
      riskPenalty: 0
    });
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_300,
      structures: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        makeStructure('tower-existing', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24)
      ],
      sources: [],
      pathsByTarget: {
        '25,25': [{ x: 10, y: 11 }]
      }
    });

    const result = planConstructionForColony(colony, {
      respectRoomEnergyBuffer: false,
      strategyRegistry,
      runtimeStrategyConstructionEnabled: true
    });

    expect(result.placements[0]).toMatchObject({
      priority: 'container',
      structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
      result: OK_CODE
    });
    expect(room.createConstructionSite.mock.calls[0][2]).toBe(TEST_GLOBALS.STRUCTURE_CONTAINER);
  });

  it('does not rerun normal container planning after the starvation source-logistics pass', () => {
    installOpenTerrain();
    const onStrategyRegistryRuntimeUse = jest.fn();
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 490,
      energyCapacityAvailable: 1_000,
      structures: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        makeStructure('tower-existing', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24)
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }],
        '25,25': [{ x: 10, y: 11 }]
      }
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      maxContainerSitesPerTick: 2,
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      onStrategyRegistryRuntimeUse
    });

    const containerPlacements = result.placements.filter((placement) => placement.priority === 'container');
    const roadPlacements = result.placements.filter((placement) => placement.priority === 'road');
    expect(containerPlacements).toHaveLength(1);
    expect(roadPlacements).toHaveLength(1);
    expect(room.createConstructionSite.mock.calls.filter(([, , structureType]) => structureType === STRUCTURE_CONTAINER))
      .toHaveLength(1);
    expect(room.createConstructionSite.mock.calls.filter(([, , structureType]) => structureType === STRUCTURE_ROAD))
      .toHaveLength(1);
    expect(onStrategyRegistryRuntimeUse).toHaveBeenCalled();
  });

  it('keeps the first-tower safeguard ahead of runtime-prioritized defense-floor work', () => {
    installOpenTerrain();
    const onStrategyRegistryRuntimeUse = jest.fn();
    const strategyRegistry = withConstructionPriorityDefaults({
      baseScoreWeight: 0,
      territorySignalWeight: 1,
      resourceSignalWeight: 0,
      killSignalWeight: 0,
      riskPenalty: 100
    });
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: 1_000,
      energyCapacityAvailable: 800,
      structures: [
        ...Array.from({ length: 10 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        )
      ],
      sources: [],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: false,
      strategyRegistry,
      runtimeStrategyConstructionEnabled: true,
      onStrategyRegistryRuntimeUse
    });

    expect(result.placements[0]).toMatchObject({
      priority: 'tower',
      structureType: STRUCTURE_TOWER,
      result: OK_CODE
    });
    expect(room.createConstructionSite.mock.calls[0][2]).toBe(STRUCTURE_TOWER);
    expect(onStrategyRegistryRuntimeUse).toHaveBeenCalled();
  });

  it('stops runtime defense-floor work before post-claim ramparts after a blocking placement failure', () => {
    installOpenTerrain();
    mockPlanExpansionDefenseBarrierPlacements.mockReturnValue([
      {
        roomName: 'W1N1',
        x: 26,
        y: 24,
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        stage: 'coreRampart',
        priority: 2
      }
    ]);
    const strategyRegistry = withConstructionPriorityDefaults({
      baseScoreWeight: 0,
      territorySignalWeight: 1,
      resourceSignalWeight: 0,
      killSignalWeight: 0,
      riskPenalty: 100
    });
    const { room, colony } = makeColony({
      controllerLevel: 4,
      energyAvailable: 1_000,
      energyCapacityAvailable: 1_300,
      structures: [
        ...Array.from({ length: 20 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        makeStructure('tower-existing', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24)
      ],
      sources: [],
      pathsByTarget: {}
    });
    room.createConstructionSite.mockReturnValueOnce(ERR_FULL_CODE);

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      includePostClaimRamparts: true,
      includeStorage: false,
      respectRoomEnergyBuffer: false,
      strategyRegistry,
      runtimeStrategyConstructionEnabled: true
    });

    expect(result.placements).toEqual([
      {
        priority: 'rampart',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        result: ERR_FULL_CODE,
        energyReserved: 0,
        x: 10,
        y: 10
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(26, 24, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('seeds an accepted runtime rampart candidate when mapped planners find no site', () => {
    installOpenTerrain();
    mockPlanExpansionDefenseBarrierPlacements.mockReturnValue([]);
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source),
        makeStoredStructure('source-container', TEST_GLOBALS.STRUCTURE_CONTAINER, 34, 35, 1_000),
        makeStructure('source-container-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 34, 35, true)
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(4),
      includePostClaimRamparts: true,
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'rampart',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        result: OK_CODE,
        energyReserved: 50,
        x: 18,
        y: 24
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(18, 24, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('falls through when every accepted runtime rampart seed anchor is already covered', () => {
    installOpenTerrain();
    mockPlanExpansionDefenseBarrierPlacements.mockReturnValue([]);
    const source = makeSource('source-a', 35, 35);
    const coveredRampartAnchorKeys = new Set(['10,10', '16,24', '17,23', '18,24', '34,35']);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source),
        makeStructure('storage-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 18, 24, true),
        makeStoredStructure('source-container', TEST_GLOBALS.STRUCTURE_CONTAINER, 34, 35, 1_000),
        makeStructure('source-container-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 34, 35, true)
      ],
      sources: [source],
      pathsByTarget: {}
    });
    room.createConstructionSite.mockImplementation(
      (x: number, y: number, structureType: BuildableStructureConstant): ScreepsReturnCode => {
        if (structureType === TEST_GLOBALS.STRUCTURE_RAMPART && coveredRampartAnchorKeys.has(`${x},${y}`)) {
          return ERR_INVALID_TARGET_CODE;
        }

        return OK_CODE;
      }
    );

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(4),
      includePostClaimRamparts: true,
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'container',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
        result: OK_CODE,
        energyReserved: 50
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(10, 10, TEST_GLOBALS.STRUCTURE_RAMPART);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 10, TEST_GLOBALS.STRUCTURE_CONTAINER);
  });

  it('records a rejected accepted runtime rampart seed attempt', () => {
    installOpenTerrain();
    mockPlanExpansionDefenseBarrierPlacements.mockReturnValue([]);
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source),
        makeStoredStructure('source-container', TEST_GLOBALS.STRUCTURE_CONTAINER, 34, 35, 1_000),
        makeStructure('source-container-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 34, 35, true)
      ],
      sources: [source],
      pathsByTarget: {}
    });
    room.createConstructionSite.mockReturnValueOnce(ERR_INVALID_TARGET_CODE);

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(4),
      includePostClaimRamparts: true,
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'rampart',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        result: ERR_INVALID_TARGET_CODE,
        energyReserved: 0,
        x: 18,
        y: 24
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(18, 24, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('reports the accepted runtime rampart seed blocker when every anchor is already covered', () => {
    installOpenTerrain();
    mockPlanExpansionDefenseBarrierPlacements.mockReturnValue([]);
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source),
        makeStructure('storage-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 18, 24, true),
        makeStoredStructure('source-container', TEST_GLOBALS.STRUCTURE_CONTAINER, 34, 35, 1_000),
        makeStructure('source-container-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 34, 35, true)
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(4),
      emitConstructionBlockerDiagnostics: true,
      includePostClaimRamparts: true,
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.blockedPlacements).toEqual(
      expect.arrayContaining([
        {
          priority: 'rampart',
          roomName: 'W1N1',
          structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
          blockedReason: 'accepted_runtime_rampart_no_uncovered_anchor',
          candidate: {
            buildItem: 'build rampart defense',
            buildType: 'rampart',
            room: 'W1N1',
            score: expect.any(Number),
            urgency: expect.any(String)
          }
        }
      ])
    );
    expect(room.createConstructionSite).not.toHaveBeenCalledWith(18, 24, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('reserves the first RCL3 tower before routine extension logistics when respecting the energy buffer', () => {
    expect(FIRST_RCL3_TOWER_PRIORITY_ENERGY).toBeLessThan(TERRITORY_CONTROLLER_BODY_COST);
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: FIRST_RCL3_TOWER_PRIORITY_ENERGY,
      energyCapacityAvailable: FIRST_RCL3_TOWER_PRIORITY_ENERGY,
      structures: [
        ...Array.from({ length: 5 }, (_, index) =>
          makeStructure(`extension-rcl2-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 30 + index, 30)
        )
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements[0]).toMatchObject({
      priority: 'tower',
      structureType: STRUCTURE_TOWER,
      result: OK_CODE
    });
    expect(result.placements.some((placement) => placement.priority === 'tower')).toBe(true);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 9, 9, STRUCTURE_TOWER);
  });

  it('plans RCL3 extension capacity after first tower readiness while preserving source logistics', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 3,
      energyAvailable: 550,
      energyCapacityAvailable: 550,
      structures: [
        makeStructure('extension-1', TEST_GLOBALS.STRUCTURE_EXTENSION, 9, 9),
        makeStructure('extension-2', TEST_GLOBALS.STRUCTURE_EXTENSION, 11, 9),
        makeStructure('extension-3', TEST_GLOBALS.STRUCTURE_EXTENSION, 9, 11),
        makeStructure('extension-4', TEST_GLOBALS.STRUCTURE_EXTENSION, 11, 11),
        makeStructure('extension-5', TEST_GLOBALS.STRUCTURE_EXTENSION, 8, 8),
        makeStructure('tower-ready', TEST_GLOBALS.STRUCTURE_TOWER, 12, 10)
      ],
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 12, y: 8 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension', 'container', 'road']);
    expect(room.createConstructionSite.mock.calls.map(([, , structureType]) => structureType)).toEqual([
      STRUCTURE_EXTENSION,
      STRUCTURE_CONTAINER,
      STRUCTURE_ROAD
    ]);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 10, 8, STRUCTURE_EXTENSION);
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

  it('seeds a residual road from indexed stored energy when storage capacity APIs disagree', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const storage = makeStoredStructure(
      'storage-existing',
      TEST_GLOBALS.STRUCTURE_STORAGE,
      18,
      24,
      2_000,
      { indexedEnergy: 2_000, usedCapacityEnergy: 0 }
    );
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source).filter(
          (structure) => structure.id !== 'storage-existing'
        ),
        storage
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 18,
        y: 23
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(18, 23, STRUCTURE_ROAD);
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

  it('seeds spawn-only bootstrap extension construction below worker spawn energy without reserving it', () => {
    installOpenTerrain();
    recordBootstrapSurvivalMode();
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 244,
      energyCapacityAvailable: 300,
      sources: [makeSource('source-a', 20, 10)],
      pathsByTarget: {
        '20,10': [{ x: 11, y: 10 }]
      }
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements.map((placement) => placement.priority)).toEqual(['extension']);
    expect(result.energyReserved).toBe(0);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(9, 9, STRUCTURE_EXTENSION);
  });

  it('does not start duplicate extension sites during spawn-only bootstrap', () => {
    installOpenTerrain();
    recordBootstrapSurvivalMode();
    const { room, colony } = makeColony({
      controllerLevel: 2,
      energyAvailable: 244,
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

  it('skips foreign ramparts while placing source containers on owned rampart overlays', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 20, 10);
    const ownedRampartOffset = [0, -1] as const;
    const foreignRampartOffset = [-1, 0] as const;
    const roadOffsets = [
      [-1, -1],
      [1, -1],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1]
    ] as const;
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 1_599,
      energyCapacityAvailable: 2_300,
      structures: [
        ...Array.from({ length: 40 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        ...roadOffsets.map(([dx, dy], index) =>
          makeStructure(`source-road-${index}`, TEST_GLOBALS.STRUCTURE_ROAD, source.pos.x + dx, source.pos.y + dy)
        ),
        makeStructure(
          'foreign-source-rampart',
          TEST_GLOBALS.STRUCTURE_RAMPART,
          source.pos.x + foreignRampartOffset[0],
          source.pos.y + foreignRampartOffset[1],
          false
        ),
        makeStructure(
          'owned-source-rampart',
          TEST_GLOBALS.STRUCTURE_RAMPART,
          source.pos.x + ownedRampartOffset[0],
          source.pos.y + ownedRampartOffset[1],
          true
        )
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      respectRoomEnergyBuffer: true,
      maxPlacementsPerRoom: 1
    });

    expect(result.placements.map((placement) => placement.priority)).toEqual(['container']);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(20, 9, STRUCTURE_CONTAINER);
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
      energyAvailable: 277,
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
      energyAvailable: 277,
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

  it('seeds one stored-backed construction site when spawn energy cannot fund normal reservations', () => {
    installOpenTerrain();
    const { room, colony } = makeColony({
      controllerLevel: 5,
      energyAvailable: 0,
      energyCapacityAvailable: 1_800,
      structures: [
        ...Array.from({ length: 30 }, (_, index) =>
          makeStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 20 + index, 30)
        ),
        makeStructure('tower-existing', TEST_GLOBALS.STRUCTURE_TOWER, 24, 24),
        makeStoredStructure('storage-existing', TEST_GLOBALS.STRUCTURE_STORAGE, 25, 26, 2_000)
      ],
      sources: [],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, { respectRoomEnergyBuffer: true });

    expect(result.placements).toEqual([
      {
        priority: 'rampart',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
        result: OK_CODE,
        energyReserved: 50,
        x: 10,
        y: 10
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(10, 10, TEST_GLOBALS.STRUCTURE_RAMPART);
  });

  it('seeds a stored-energy road when runtime priority leaves a safe staffed room with no sites', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: makeRecoveredRcl6ResidualConstructionStructures(source),
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 18,
        y: 23
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(18, 23, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('seeds a residual road from a mature healthy room buffer when stored surplus is reserved', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 2_300,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source).filter(
          (structure) => structure.id !== 'storage-existing'
        ),
        makeStoredStructure('storage-existing', TEST_GLOBALS.STRUCTURE_STORAGE, 18, 24, 800)
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 18,
        y: 23
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(18, 23, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('keeps residual road seeding blocked when the road reservation would pierce the room buffer', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 849,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source).filter(
          (structure) => structure.id !== 'storage-existing'
        ),
        makeStoredStructure('storage-existing', TEST_GLOBALS.STRUCTURE_STORAGE, 18, 24, 800)
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      emitConstructionBlockerDiagnostics: true,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([]);
    expect(result.blockedPlacements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        blockedReason: 'residual_road_seed_stored_energy_unavailable',
        details: {
          storedEnergyAvailableForConstruction: 0,
          storedEnergyMinimum: 300,
          pendingConstructionSiteCount: 0,
          successfulPlacementCount: 0
        }
      }
    ]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('seeds a stored-energy road from visible workers when planner options omit creeps', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: makeRecoveredRcl6ResidualConstructionStructures(source),
      myCreeps: makeWorkerCreeps(4),
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 18,
        y: 23
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(18, 23, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('widens residual road seeding when mature safe room anchors are saturated nearby', () => {
    installOpenTerrain();
    const controllerStructures = makeControllerStructures();
    controllerStructures.container[6] = 0;
    (globalThis as unknown as { CONTROLLER_STRUCTURES: ReturnType<typeof makeControllerStructures> }).CONTROLLER_STRUCTURES =
      controllerStructures;
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source),
        ...makeResidualAnchorRoadShell('spawn-shell', 10, 10),
        ...makeResidualAnchorRoadShell('storage-shell', 18, 24),
        ...makeResidualAnchorRoadShell('controller-shell', 25, 25),
        ...makeResidualAnchorRoadShell('source-shell', source.pos.x, source.pos.y)
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(4),
      respectRoomEnergyBuffer: true,
      maxPlacementsPerRoom: 1
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 14,
        y: 20
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(14, 20, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('falls back to source-area residual roads when core room anchors are exhausted', () => {
    installOpenTerrain();
    const controllerStructures = makeControllerStructures();
    controllerStructures.container[6] = 0;
    (globalThis as unknown as { CONTROLLER_STRUCTURES: ReturnType<typeof makeControllerStructures> }).CONTROLLER_STRUCTURES =
      controllerStructures;
    const coveredSource = makeSource('source-a', 35, 35);
    const openSource = makeSource('source-b', 43, 43);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(coveredSource),
        ...makeResidualAnchorRoadShell('spawn-shell', 10, 10, 6),
        ...makeResidualAnchorRoadShell('storage-shell', 18, 24, 6),
        ...makeResidualAnchorRoadShell('controller-shell', 25, 25, 6),
        ...makeResidualAnchorRoadShell('covered-source-shell', coveredSource.pos.x, coveredSource.pos.y, 6)
      ],
      sources: [coveredSource, openSource],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(4),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 42,
        y: 42
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(42, 42, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('keeps residual seeding alive when every anchor is saturated through the nearby radius', () => {
    installOpenTerrain();
    const controllerStructures = makeControllerStructures();
    controllerStructures.container[6] = 0;
    (globalThis as unknown as { CONTROLLER_STRUCTURES: ReturnType<typeof makeControllerStructures> }).CONTROLLER_STRUCTURES =
      controllerStructures;
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: [
        ...makeRecoveredRcl6ResidualConstructionStructures(source),
        ...makeResidualAnchorRoadShell('spawn-shell', 10, 10, 6),
        ...makeResidualAnchorRoadShell('storage-shell', 18, 24, 6),
        ...makeResidualAnchorRoadShell('controller-shell', 25, 25, 6),
        ...makeResidualAnchorRoadShell('source-shell', source.pos.x, source.pos.y, 6)
      ],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(4),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 11,
        y: 17
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(room.createConstructionSite).toHaveBeenCalledWith(11, 17, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('tries the next residual road candidate after Screeps rejects the first safe tile', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 2_250,
      energyCapacityAvailable: 2_300,
      structures: makeRecoveredRcl6ResidualConstructionStructures(source),
      sources: [source],
      pathsByTarget: {}
    });
    room.createConstructionSite.mockReturnValueOnce(ERR_INVALID_TARGET_CODE);

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: OK_CODE,
        energyReserved: 50,
        x: 19,
        y: 23
      }
    ]);
    expect(room.createConstructionSite).toHaveBeenCalledTimes(2);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(1, 18, 23, TEST_GLOBALS.STRUCTURE_ROAD);
    expect(room.createConstructionSite).toHaveBeenNthCalledWith(2, 19, 23, TEST_GLOBALS.STRUCTURE_ROAD);
  });

  it('does not seed the residual stored-energy road without assigned worker coverage', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: makeRecoveredRcl6ResidualConstructionStructures(source),
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('reports the residual road worker-coverage gate with its threshold', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: makeRecoveredRcl6ResidualConstructionStructures(source),
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      emitConstructionBlockerDiagnostics: true,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

    expect(result.placements).toEqual([]);
    expect(result.blockedPlacements).toEqual([
      {
        priority: 'road',
        roomName: 'W1N1',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        blockedReason: 'residual_road_seed_worker_coverage_missing',
        details: {
          workerCoverageCount: 0,
          workerCoverageMinimum: 1
        }
      }
    ]);
    expect(room.createConstructionSite).not.toHaveBeenCalled();
  });

  it('does not seed the residual stored-energy road under visible hostile pressure', () => {
    installOpenTerrain();
    const source = makeSource('source-a', 35, 35);
    const { room, colony } = makeColony({
      controllerLevel: 6,
      energyAvailable: 0,
      energyCapacityAvailable: 2_300,
      structures: makeRecoveredRcl6ResidualConstructionStructures(source),
      hostileCreeps: [makeHostileCreep('invader-1', 20, 20)],
      sources: [source],
      pathsByTarget: {}
    });

    const result = planConstructionForColony(colony, {
      creeps: makeWorkerCreeps(5),
      respectRoomEnergyBuffer: true,
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      runtimeStrategyConstructionEnabled: true,
      runtimeStrategyConstructionFallbackPriorities: false,
      maxPlacementsPerRoom: 1,
      maxContainerSitesPerTick: 1,
      maxPendingContainerSites: 1,
      roadOptions: {
        maxSitesPerTick: 1,
        maxPendingRoadSites: 1,
        maxTargetsPerTick: 1
      }
    });

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
  myCreeps?: Creep[];
  hostileCreeps?: Creep[];
  hostileStructures?: Structure[];
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
          : findType === TEST_GLOBALS.FIND_MY_CREEPS
            ? (options.myCreeps ?? [])
          : findType === TEST_GLOBALS.FIND_HOSTILE_CREEPS
            ? (options.hostileCreeps ?? [])
            : findType === TEST_GLOBALS.FIND_HOSTILE_STRUCTURES
              ? (options.hostileStructures ?? [])
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
    tower: [0, 0, 0, 1, 1, 2, 2, 3, 6],
    storage: [0, 0, 0, 0, 1, 1, 1, 1, 1]
  };
}

function withConstructionPriorityDefaults(
  defaultValues: StrategyRegistryEntry['defaultValues']
): StrategyRegistryEntry[] {
  return DEFAULT_STRATEGY_REGISTRY.map((entry) =>
    entry.id === 'construction-priority.incumbent.v1'
      ? {
          ...entry,
          defaultValues: {
            ...entry.defaultValues,
            ...defaultValues
          }
        }
      : entry
  );
}

function makeWorkerCreeps(count: number): Creep[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        name: `worker-${index}`,
        memory: { role: 'worker', colony: 'W1N1' }
      }) as Creep
  );
}

function makeRecoveredRcl6ResidualConstructionStructures(source: Source): Structure[] {
  const sourceRoadOffsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1]
  ] as const;
  const spawnWallOffsets = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1]
  ] as const;

  return [
    ...Array.from({ length: 40 }, (_, index) =>
      makeStructure(
        `extension-${index}`,
        TEST_GLOBALS.STRUCTURE_EXTENSION,
        30 + (index % 10),
        30 + Math.floor(index / 10)
      )
    ),
    makeStructure('tower-a', TEST_GLOBALS.STRUCTURE_TOWER, 17, 23),
    makeStructure('tower-b', TEST_GLOBALS.STRUCTURE_TOWER, 16, 24),
    makeStoredStructure('storage-existing', TEST_GLOBALS.STRUCTURE_STORAGE, 18, 24, 2_000),
    makeStructure('spawn-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 10, 10, true),
    ...spawnWallOffsets.map(([dx, dy], index) =>
      makeStructure(`spawn-wall-${index}`, TEST_GLOBALS.STRUCTURE_WALL, 10 + dx, 10 + dy)
    ),
    makeStructure('tower-a-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 17, 23, true),
    makeStructure('tower-b-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 16, 24, true),
    makeStructure('controller-rampart', TEST_GLOBALS.STRUCTURE_RAMPART, 24, 24, true),
    ...sourceRoadOffsets.map(([dx, dy], index) =>
      makeStructure(`source-road-${index}`, TEST_GLOBALS.STRUCTURE_ROAD, source.pos.x + dx, source.pos.y + dy)
    )
  ];
}

function makeResidualAnchorRoadShell(prefix: string, anchorX: number, anchorY: number, maxRadius = 3): Structure[] {
  const structures: Structure[] = [];
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let y = anchorY - radius; y <= anchorY + radius; y += 1) {
      for (let x = anchorX - radius; x <= anchorX + radius; x += 1) {
        if (Math.max(Math.abs(x - anchorX), Math.abs(y - anchorY)) !== radius) {
          continue;
        }

        structures.push(makeStructure(`${prefix}-${x}-${y}`, TEST_GLOBALS.STRUCTURE_ROAD, x, y));
      }
    }
  }

  return structures;
}

function makeHostileCreep(id: string, x: number, y: number): Creep {
  return {
    id,
    owner: { username: 'Invader' },
    pos: makeRoomPosition(x, y)
  } as unknown as Creep;
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

function makeStructure(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  my?: boolean
): Structure {
  return {
    id,
    structureType,
    ...(my === undefined ? {} : { my }),
    pos: makeRoomPosition(x, y)
  } as unknown as Structure;
}

function makeStoredStructure(
  id: string,
  structureType: StructureConstant,
  x: number,
  y: number,
  energy: number,
  options: { indexedEnergy?: number; usedCapacityEnergy?: number } = {}
): Structure {
  return {
    id,
    structureType,
    pos: makeRoomPosition(x, y),
    store: {
      ...(options.indexedEnergy === undefined ? {} : { [TEST_GLOBALS.RESOURCE_ENERGY]: options.indexedEnergy }),
      getUsedCapacity: jest.fn().mockReturnValue(options.usedCapacityEnergy ?? energy)
    }
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
