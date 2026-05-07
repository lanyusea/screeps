import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { buildTerritorySpawnBody } from '../src/spawn/spawnPlanner';
import {
  buildRuntimeExpansionPlannerCandidates,
  createExpansionIntent,
  evaluateExpansionCandidate,
  evaluateExpansionRoomSuitability,
  planExpansionDefenseBarrierPlacements,
  planExpansionTowerPlacements,
  prioritizeExpansionCandidates,
  refreshExpansionPlannerIntent
} from '../src/territory/expansionPlanner';
import { planTerritoryIntent, type TerritoryIntentPlan } from '../src/territory/territoryPlanner';

describe('expansion planner', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_SOURCES: number }).FIND_SOURCES = 1;
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 2;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 3;
    (globalThis as unknown as { FIND_STRUCTURES: number }).FIND_STRUCTURES = 4;
    (globalThis as unknown as { FIND_CONSTRUCTION_SITES: number }).FIND_CONSTRUCTION_SITES = 5;
    (globalThis as unknown as { FIND_EXIT: number }).FIND_EXIT = 6;
    (globalThis as unknown as { FIND_MINERALS: number }).FIND_MINERALS = 7;
    (globalThis as unknown as { TERRAIN_MASK_WALL: number }).TERRAIN_MASK_WALL = 1;
    (globalThis as unknown as { STRUCTURE_SPAWN: StructureConstant }).STRUCTURE_SPAWN = 'spawn';
    (globalThis as unknown as { STRUCTURE_TOWER: StructureConstant }).STRUCTURE_TOWER = 'tower';
    (globalThis as unknown as { STRUCTURE_CONTAINER: StructureConstant }).STRUCTURE_CONTAINER = 'container';
    (globalThis as unknown as { STRUCTURE_ROAD: StructureConstant }).STRUCTURE_ROAD = 'road';
    (globalThis as unknown as { STRUCTURE_RAMPART: StructureConstant }).STRUCTURE_RAMPART = 'rampart';
    (globalThis as unknown as { STRUCTURE_WALL: StructureConstant }).STRUCTURE_WALL = 'constructedWall';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('evaluates room suitability from source count, hostiles, and controller occupancy', () => {
    expect(evaluateExpansionRoomSuitability(makeExpansionRoom('W2N1'))).toMatchObject({
      suitable: true,
      sourceCount: 2,
      hostileCreepCount: 0,
      hostileStructureCount: 0,
      reasons: []
    });

    expect(evaluateExpansionRoomSuitability(makeExpansionRoom('W2N1', { sourceCount: 1 })).reasons).toContain(
      'sourceCountBelowMinimum'
    );
    expect(
      evaluateExpansionRoomSuitability(makeExpansionRoom('W2N1', { hostileCreepCount: 1 })).reasons
    ).toContain('hostilePresence');
    expect(
      evaluateExpansionRoomSuitability(
        makeExpansionRoom('W2N1', {
          controller: {
            id: 'controller-W2N1' as Id<StructureController>,
            my: false,
            owner: { username: 'enemy' }
          } as StructureController
        })
      ).reasons
    ).toContain('controllerOwned');
    expect(
      evaluateExpansionRoomSuitability(
        makeExpansionRoom('W2N1', {
          controller: {
            id: 'controller-W2N1' as Id<StructureController>,
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController
        })
      ).reasons
    ).toContain('controllerReserved');
  });

  it('prioritizes suitable candidates by adjacency score, source count, and stable order', () => {
    const orderedCandidates = prioritizeExpansionCandidates([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 2,
        sourceCount: 2,
        controllerId: 'controller-W2N1' as Id<StructureController>,
        order: 0
      },
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        distance: 1,
        sourceCount: 2,
        controllerId: 'controller-W1N2' as Id<StructureController>,
        order: 1
      },
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        distance: 1,
        sourceCount: 1,
        controllerId: 'controller-W3N1' as Id<StructureController>,
        order: 2
      },
      {
        colony: 'W1N1',
        roomName: 'W4N1',
        distance: 2,
        sourceCount: 3,
        controllerId: 'controller-W4N1' as Id<StructureController>,
        order: 3
      }
    ]);

    expect(orderedCandidates.map((candidate) => candidate.roomName)).toEqual(['W1N2', 'W4N1', 'W2N1']);
  });

  it('deduplicates expansion candidates for the same room by keeping the highest score', () => {
    const orderedCandidates = prioritizeExpansionCandidates([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 2,
        sourceCount: 2,
        controllerId: 'controller-W2N1' as Id<StructureController>,
        order: 0
      },
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 1,
        sourceCount: 2,
        controllerId: 'controller-W2N1' as Id<StructureController>,
        order: 1
      },
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        distance: 1,
        sourceCount: 2,
        controllerId: 'controller-W3N1' as Id<StructureController>,
        order: 2
      }
    ]);

    expect(orderedCandidates).toHaveLength(2);
    expect(orderedCandidates[0]).toMatchObject({
      roomName: 'W2N1',
      distance: 1
    });
  });

  it('plans valid strategic tower placements from controller, source, and entrance anchors', () => {
    const blockedStructure = makePositionedStructure('blocking-road', 25, 24, 'W2N1');
    const wallPositions = new Set(['24,24']);
    const room = makeTowerPlanningRoom('W2N1', {
      controllerPosition: { x: 25, y: 25 },
      sourcePositions: [
        { x: 20, y: 25 },
        { x: 30, y: 25 }
      ],
      exitPositions: [
        { x: 24, y: 0 },
        { x: 25, y: 0 },
        { x: 26, y: 0 }
      ],
      structures: [blockedStructure],
      wallPositions
    });
    installTerrain(room.name, wallPositions);

    const placements = planExpansionTowerPlacements(room, { maxPlacements: 3 });

    expect(placements).toHaveLength(3);
    expect(placements[0]).toMatchObject({
      roomName: 'W2N1',
      controllerRange: expect.any(Number),
      nearestSourceRange: expect.any(Number),
      nearestEntranceRange: expect.any(Number)
    });
    expect(placements[0].score).toBeLessThanOrEqual(placements[1].score);
    for (const placement of placements) {
      expect(placement.x).toBeGreaterThanOrEqual(1);
      expect(placement.x).toBeLessThanOrEqual(48);
      expect(placement.y).toBeGreaterThanOrEqual(1);
      expect(placement.y).toBeLessThanOrEqual(48);
      expect(`${placement.x},${placement.y}`).not.toBe('25,24');
      expect(wallPositions.has(`${placement.x},${placement.y}`)).toBe(false);
    }
  });

  it('places claimed-room towers where they cover spawn, controller, roads, and containers', () => {
    const spawn = makePositionedStructure('spawn1', 10, 12, 'W2N1', STRUCTURE_SPAWN);
    const container = makePositionedStructure('container1', 12, 10, 'W2N1', STRUCTURE_CONTAINER);
    const road = makePositionedStructure('road1', 11, 11, 'W2N1', STRUCTURE_ROAD);
    const room = makeTowerPlanningRoom('W2N1', {
      controllerPosition: { x: 10, y: 10 },
      sourcePositions: [
        { x: 40, y: 40 },
        { x: 40, y: 42 }
      ],
      exitPositions: [],
      structures: [spawn, container, road]
    });
    installTerrain(room.name, new Set());

    const placements = planExpansionTowerPlacements(room, { maxPlacements: 1 });

    expect(placements).toEqual([
      {
        roomName: 'W2N1',
        x: 10,
        y: 11,
        score: expect.any(Number),
        spawnRange: 1,
        controllerRange: 1,
        nearestContainerRange: 2,
        nearestRoadRange: 1,
        nearestSourceRange: 30
      }
    ]);
  });

  it('plans tower ramparts before other claimed-room defensive barriers', () => {
    const spawn = makePositionedStructure('spawn1', 20, 20, 'W2N1', STRUCTURE_SPAWN);
    const tower = makePositionedStructure('tower1', 21, 20, 'W2N1', STRUCTURE_TOWER);
    const room = makeTowerPlanningRoom('W2N1', {
      controllerPosition: { x: 25, y: 25 },
      sourcePositions: [],
      exitPositions: [
        { x: 24, y: 0 },
        { x: 25, y: 0 },
        { x: 26, y: 0 },
        { x: 49, y: 25 }
      ],
      structures: [spawn, tower]
    });
    installTerrain(room.name, new Set());

    const placements = planExpansionDefenseBarrierPlacements(room, { maxPlacements: 4 });

    expect(placements).toEqual([
      {
        roomName: 'W2N1',
        x: 21,
        y: 20,
        structureType: STRUCTURE_RAMPART,
        stage: 'towerRampart',
        priority: 0
      }
    ]);
  });

  it('holds later defensive barrier stages while the tower is still a construction site', () => {
    const spawn = makePositionedStructure('spawn1', 20, 20, 'W2N1', STRUCTURE_SPAWN);
    const towerSite = makePositionedConstructionSite('tower-site', 21, 20, 'W2N1', STRUCTURE_TOWER);
    const room = makeTowerPlanningRoom('W2N1', {
      controllerPosition: { x: 25, y: 25 },
      sourcePositions: [],
      exitPositions: [
        { x: 24, y: 0 },
        { x: 25, y: 0 },
        { x: 26, y: 0 },
        { x: 49, y: 25 }
      ],
      structures: [spawn],
      constructionSites: [towerSite]
    });
    installTerrain(room.name, new Set());

    const placements = planExpansionDefenseBarrierPlacements(room, { maxPlacements: 4 });

    expect(placements).toEqual([
      {
        roomName: 'W2N1',
        x: 21,
        y: 20,
        structureType: STRUCTURE_RAMPART,
        stage: 'towerRampart',
        priority: 0
      }
    ]);
  });

  it('plans spawn and controller ramparts after tower ramparts are covered', () => {
    const structures = [
      makePositionedStructure('spawn1', 20, 20, 'W2N1', STRUCTURE_SPAWN),
      makePositionedStructure('tower1', 21, 20, 'W2N1', STRUCTURE_TOWER),
      makePositionedStructure('tower-rampart', 21, 20, 'W2N1', STRUCTURE_RAMPART)
    ];
    const room = makeTowerPlanningRoom('W2N1', {
      controllerPosition: { x: 25, y: 25 },
      sourcePositions: [],
      exitPositions: [
        { x: 24, y: 0 },
        { x: 25, y: 0 },
        { x: 26, y: 0 },
        { x: 49, y: 25 }
      ],
      structures
    });
    installTerrain(room.name, new Set());

    const placements = planExpansionDefenseBarrierPlacements(room, { maxPlacements: 3 });

    expect(placements[0]).toEqual({
      roomName: 'W2N1',
      x: 20,
      y: 20,
      structureType: STRUCTURE_RAMPART,
      stage: 'coreRampart',
      priority: 1
    });
    expect(placements.every((placement) => placement.stage === 'coreRampart')).toBe(true);
  });

  it('plans entrance ramparts after tower and core ramparts are covered', () => {
    const structures = [
      makePositionedStructure('spawn1', 20, 20, 'W2N1', STRUCTURE_SPAWN),
      makePositionedStructure('tower1', 21, 20, 'W2N1', STRUCTURE_TOWER),
      makePositionedStructure('tower-rampart', 21, 20, 'W2N1', STRUCTURE_RAMPART),
      ...makeCoreRampartCoverage('core', { x: 20, y: 20 }, { x: 25, y: 25 }, 'W2N1')
    ];
    const room = makeTowerPlanningRoom('W2N1', {
      controllerPosition: { x: 25, y: 25 },
      sourcePositions: [],
      exitPositions: [
        { x: 24, y: 0 },
        { x: 25, y: 0 },
        { x: 26, y: 0 },
        { x: 49, y: 25 }
      ],
      structures
    });
    installTerrain(room.name, new Set());

    const placements = planExpansionDefenseBarrierPlacements(room, { maxPlacements: 4 });

    expect(placements).toEqual([
      {
        roomName: 'W2N1',
        x: 25,
        y: 1,
        structureType: STRUCTURE_RAMPART,
        stage: 'entranceRampart',
        priority: 2
      },
      {
        roomName: 'W2N1',
        x: 48,
        y: 25,
        structureType: STRUCTURE_RAMPART,
        stage: 'entranceRampart',
        priority: 2
      }
    ]);
  });

  it('plans walls adjacent to covered entrance ramparts after core ramparts', () => {
    const structures = [
      makePositionedStructure('spawn1', 20, 20, 'W2N1', STRUCTURE_SPAWN),
      makePositionedStructure('tower1', 21, 20, 'W2N1', STRUCTURE_TOWER),
      makePositionedStructure('tower-rampart', 21, 20, 'W2N1', STRUCTURE_RAMPART),
      ...makeCoreRampartCoverage('core', { x: 20, y: 20 }, { x: 25, y: 25 }, 'W2N1'),
      makePositionedStructure('rampart-top', 25, 1, 'W2N1', STRUCTURE_RAMPART),
      makePositionedStructure('rampart-right', 48, 25, 'W2N1', STRUCTURE_RAMPART)
    ];
    const room = makeTowerPlanningRoom('W2N1', {
      controllerPosition: { x: 25, y: 25 },
      sourcePositions: [],
      exitPositions: [
        { x: 24, y: 0 },
        { x: 25, y: 0 },
        { x: 26, y: 0 },
        { x: 49, y: 25 }
      ],
      structures
    });
    installTerrain(room.name, new Set());

    const placements = planExpansionDefenseBarrierPlacements(room, { maxPlacements: 4 });

    expect(placements).toEqual([
      {
        roomName: 'W2N1',
        x: 24,
        y: 1,
        structureType: STRUCTURE_WALL,
        stage: 'entranceWall',
        priority: 3
      },
      {
        roomName: 'W2N1',
        x: 26,
        y: 1,
        structureType: STRUCTURE_WALL,
        stage: 'entranceWall',
        priority: 3
      },
      {
        roomName: 'W2N1',
        x: 48,
        y: 24,
        structureType: STRUCTURE_WALL,
        stage: 'entranceWall',
        priority: 3
      },
      {
        roomName: 'W2N1',
        x: 48,
        y: 26,
        structureType: STRUCTURE_WALL,
        stage: 'entranceWall',
        priority: 3
      }
    ]);
  });

  it('creates expansion targets and intents through territory planning', () => {
    const { colony } = makeColony({ energyAvailable: 1_300, energyCapacityAvailable: 1_300 });
    installGame(colony, {
      gclLevel: 2,
      exits: { W1N1: { '3': 'W2N1' } },
      rooms: {
        W2N1: makeExpansionRoom('W2N1')
      }
    });

    const plan = planTerritoryIntent(
      colony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      100
    );

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      createdBy: 'expansionPlanner',
      controllerId: 'controller-W2N1'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: 'controller-W2N1'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 100,
        createdBy: 'expansionPlanner',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it.each([
    [
      'low bootstrap energy',
      { energyAvailable: 650, energyCapacityAvailable: 650 },
      undefined
    ],
    [
      'no active spawn',
      { energyAvailable: 1_300, energyCapacityAvailable: 1_300, spawns: [] },
      undefined
    ],
    [
      'visible home hostiles',
      { energyAvailable: 1_300, energyCapacityAvailable: 1_300, hostileCreepCount: 1 },
      undefined
    ],
    [
      'pending colony threat',
      { energyAvailable: 1_300, energyCapacityAvailable: 1_300 },
      {
        updatedAt: 100,
        rooms: {
          W1N1: {
            roomName: 'W1N1',
            level: 'hostile_present' as DefenseThreatLevel,
            updatedAt: 100,
            hostileCreepCount: 1,
            hostileStructureCount: 0,
            damagedCriticalStructureCount: 0
          }
        }
      }
    ],
    [
      'recent colony threat not refreshed this tick',
      { energyAvailable: 1_300, energyCapacityAvailable: 1_300 },
      {
        updatedAt: 99,
        rooms: {
          W1N1: {
            roomName: 'W1N1',
            level: 'hostile_present' as DefenseThreatLevel,
            updatedAt: 99,
            hostileCreepCount: 1,
            hostileStructureCount: 0,
            damagedCriticalStructureCount: 0
          }
        }
      }
    ]
  ])('falls back to reservation when claim readiness is blocked by %s', (_label, colonyOptions, threatMemory) => {
    const { colony } = makeColony(colonyOptions);
    if (threatMemory) {
      Memory.defense = { colonyThreats: threatMemory };
    }
    installGame(colony, {
      gclLevel: 2,
      exits: { W1N1: { '3': 'W2N1' } },
      rooms: {
        W2N1: makeExpansionRoom('W2N1')
      }
    });

    const plan = refreshExpansionPlannerIntent(colony, 100);

    expect(plan).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'expansionPlanner',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('uses Game.spawns as a claim-readiness fallback when the colony snapshot has no spawns', () => {
    const { colony } = makeColony({ energyAvailable: 1_300, energyCapacityAvailable: 1_300, spawns: [] });
    installGame(colony, {
      gclLevel: 2,
      exits: { W1N1: { '3': 'W2N1' } },
      rooms: {
        W2N1: makeExpansionRoom('W2N1')
      }
    });
    ((globalThis as unknown as { Game: Partial<Game> }).Game as { spawns: Record<string, StructureSpawn> }).spawns = {
      'spawn-W1N1': {
        ...makeActiveSpawn('spawn-W1N1'),
        room: colony.room
      } as StructureSpawn
    };

    const plan = refreshExpansionPlannerIntent(colony, 100);

    expect(plan).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: 'controller-W2N1'
      }
    ]);
  });

  it('upgrades existing expansion planner reservations to claim targets when claim capacity opens', () => {
    const controllerId = 'controller-W2N1' as Id<StructureController>;
    const { colony } = makeColony({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controllerLevel: 3
    });
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'reserve',
          createdBy: 'expansionPlanner',
          controllerId
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'reserve',
          status: 'planned',
          updatedAt: 90,
          createdBy: 'expansionPlanner',
          controllerId
        }
      ]
    };
    installGame(colony, {
      gclLevel: 2,
      exits: { W1N1: { '3': 'W2N1' } },
      rooms: {
        W2N1: makeExpansionRoom('W2N1', {
          controller: {
            id: controllerId,
            my: false,
            reservation: { username: 'me', ticksToEnd: 3_000 }
          } as StructureController
        })
      }
    });

    const plan = planTerritoryIntent(
      colony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      110
    );

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      createdBy: 'expansionPlanner',
      controllerId
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 110,
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
  });

  it('prefers reserved expansion targets over higher scoring new claim candidates', () => {
    const reservedControllerId = 'controller-W2N1' as Id<StructureController>;
    const higherScoringControllerId = 'controller-W3N1' as Id<StructureController>;
    const { colony } = makeColony({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controllerLevel: 3
    });
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'reserve',
          createdBy: 'expansionPlanner',
          controllerId: reservedControllerId
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'reserve',
          status: 'planned',
          updatedAt: 90,
          createdBy: 'expansionPlanner',
          controllerId: reservedControllerId
        }
      ]
    };
    installGame(colony, {
      gclLevel: 2,
      exits: { W1N1: { '1': 'W3N1', '3': 'W2N1' } },
      rooms: {
        W2N1: makeExpansionRoom('W2N1', {
          controller: {
            id: reservedControllerId,
            my: false
          } as StructureController
        }),
        W3N1: makeExpansionRoom('W3N1', {
          sourceCount: 3,
          controller: {
            id: higherScoringControllerId,
            my: false
          } as StructureController
        })
      }
    });

    expect(buildRuntimeExpansionPlannerCandidates(colony).map((candidate) => candidate.roomName)).toEqual([
      'W3N1',
      'W2N1'
    ]);

    const plan = refreshExpansionPlannerIntent(colony, 111);

    expect(plan).toMatchObject({
      status: 'planned',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      controllerId: reservedControllerId
    });
    expect(plan.candidates.map((candidate) => candidate.roomName)).toEqual(['W3N1', 'W2N1']);
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: reservedControllerId
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 111,
        createdBy: 'expansionPlanner',
        controllerId: reservedControllerId
      }
    ]);
  });

  it('filters enemy-reserved runtime rooms from expansion candidates', () => {
    const { colony } = makeColony({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controllerLevel: 3
    });
    installGame(colony, {
      gclLevel: 2,
      exits: { W1N1: { '3': 'W2N1' } },
      rooms: {
        W2N1: makeExpansionRoom('W2N1', {
          controller: {
            id: 'controller-W2N1' as Id<StructureController>,
            my: false,
            reservation: { username: 'enemy', ticksToEnd: 3_000 }
          } as StructureController
        })
      }
    });

    expect(buildRuntimeExpansionPlannerCandidates(colony)).toEqual([]);
    expect(
      planTerritoryIntent(colony, { worker: 3, claimer: 0, claimersByTargetRoom: {} }, 3, 115)
    ).toBeNull();
    expect(Memory.territory).toBeUndefined();
  });

  it('keeps existing reserve targets active when the controller is reserved by us', () => {
    const controllerId = 'controller-W2N1' as Id<StructureController>;
    const { colony } = makeColony({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controllerLevel: 3
    });
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'reserve',
          createdBy: 'expansionPlanner',
          controllerId
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'reserve',
          status: 'active',
          updatedAt: 100,
          createdBy: 'expansionPlanner',
          controllerId
        }
      ]
    };
    installGame(colony, {
      gclLevel: 1,
      exits: { W1N1: {} },
      rooms: {
        W2N1: makeExpansionRoom('W2N1', {
          controller: {
            id: controllerId,
            my: false,
            reservation: { username: 'me', ticksToEnd: 3_000 }
          } as StructureController
        })
      }
    });
    (Game.map.findRoute as jest.Mock).mockReturnValue([
      { exit: 3, room: 'W1N2' },
      { exit: 3, room: 'W2N2' },
      { exit: 3, room: 'W2N1' }
    ]);

    const plan = refreshExpansionPlannerIntent(colony, 116);

    expect(plan).toMatchObject({
      status: 'skipped',
      colony: 'W1N1',
      reason: 'existingTerritoryPlan'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 100,
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
  });

  it('does not reactivate completed expansion intents while the candidate remains unsuitable', () => {
    const controllerId = 'controller-W2N1' as Id<StructureController>;
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'expansionPlanner',
          controllerId,
          enabled: true
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'completed',
          updatedAt: 100,
          createdBy: 'expansionPlanner',
          controllerId
        }
      ]
    };

    const intent = createExpansionIntent(
      evaluateExpansionCandidate({
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 1,
        sourceCount: 2,
        controllerId,
        ownerUsername: 'me'
      }),
      'claim',
      120
    );

    const territory = Memory.territory as TerritoryMemory;
    expect(intent).toBeNull();
    expect(territory.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId,
        enabled: false
      }
    ]);
    expect(territory.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'completed',
        updatedAt: 120,
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
  });

  it('ignores stale terminal intent status when the current candidate is suitable', () => {
    const controllerId = 'controller-W2N1' as Id<StructureController>;
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'expansionPlanner',
          controllerId,
          enabled: false
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'inactive',
          updatedAt: 100,
          createdBy: 'expansionPlanner',
          controllerId
        }
      ]
    };

    const intent = createExpansionIntent(
      evaluateExpansionCandidate({
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 1,
        sourceCount: 2,
        controllerId
      }),
      'claim',
      121
    );

    const territory = Memory.territory as TerritoryMemory;
    expect(intent).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      score: 3_400,
      controllerId
    });
    expect(territory.targets?.[0]).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      action: 'claim',
      createdBy: 'expansionPlanner',
      controllerId
    });
    expect(territory.targets?.[0]?.enabled).toBeUndefined();
    expect(territory.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 121,
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
  });

  it('does not disable another colony claim plan for the selected room without priority comparison', () => {
    const controllerId = 'controller-W2N1' as Id<StructureController>;
    Memory.territory = {
      targets: [
        {
          colony: 'W0N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'expansionPlanner',
          controllerId
        }
      ],
      intents: [
        {
          colony: 'W0N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'planned',
          updatedAt: 100,
          createdBy: 'expansionPlanner',
          controllerId
        }
      ]
    };

    const intent = createExpansionIntent(
      evaluateExpansionCandidate({
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 1,
        sourceCount: 2,
        controllerId
      }),
      'claim',
      122
    );

    const territory = Memory.territory as TerritoryMemory;
    expect(intent).toMatchObject({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim'
    });
    expect(territory.targets).toEqual([
      {
        colony: 'W0N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId
      },
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
    expect(territory.intents).toEqual([
      {
        colony: 'W0N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 100,
        createdBy: 'expansionPlanner',
        controllerId
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 122,
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
  });

  it('disables older same-colony expansion planner claim plans when a new claim is selected', () => {
    const oldControllerId = 'controller-W3N1' as Id<StructureController>;
    const nextControllerId = 'controller-W2N1' as Id<StructureController>;
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W3N1',
          action: 'claim',
          createdBy: 'expansionPlanner',
          controllerId: oldControllerId
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W3N1',
          action: 'claim',
          status: 'planned',
          updatedAt: 100,
          createdBy: 'expansionPlanner',
          controllerId: oldControllerId
        }
      ]
    };

    const intent = createExpansionIntent(
      evaluateExpansionCandidate({
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 1,
        sourceCount: 2,
        controllerId: nextControllerId
      }),
      'claim',
      123
    );

    const territory = Memory.territory as TerritoryMemory;
    expect(intent).toMatchObject({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim'
    });
    expect(territory.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: oldControllerId,
        enabled: false
      },
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: nextControllerId
      }
    ]);
    expect(territory.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'inactive',
        updatedAt: 123,
        createdBy: 'expansionPlanner',
        controllerId: oldControllerId
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 123,
        createdBy: 'expansionPlanner',
        controllerId: nextControllerId
      }
    ]);
  });

  it('marks stale expansion targets inactive instead of re-enabling them', () => {
    const controllerId = 'controller-W2N1' as Id<StructureController>;
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'expansionPlanner',
          controllerId
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'active',
          updatedAt: 100,
          createdBy: 'expansionPlanner',
          controllerId
        }
      ]
    };

    const intent = createExpansionIntent(
      evaluateExpansionCandidate({
        colony: 'W1N1',
        roomName: 'W2N1',
        distance: 1,
        sourceCount: 2,
        hostileCreepCount: 1,
        controllerId
      }),
      'claim',
      125
    );

    const territory = Memory.territory as TerritoryMemory;
    expect(intent).toBeNull();
    expect(territory.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId,
        enabled: false
      }
    ]);
    expect(territory.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'inactive',
        updatedAt: 125,
        createdBy: 'expansionPlanner',
        controllerId
      }
    ]);
  });

  it('clears completed expansion targets before planning the next room', () => {
    const completedControllerId = 'controller-W2N1' as Id<StructureController>;
    const nextControllerId = 'controller-W3N1' as Id<StructureController>;
    const { colony } = makeColony({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controllerLevel: 4
    });
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'expansionPlanner',
          controllerId: completedControllerId
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'active',
          updatedAt: 99,
          createdBy: 'expansionPlanner',
          controllerId: completedControllerId
        }
      ]
    };
    installGame(colony, {
      gclLevel: 4,
      exits: {
        W1N1: { '3': 'W2N1' },
        W2N1: { '3': 'W3N1' }
      },
      rooms: {
        W2N1: makeExpansionRoom('W2N1', {
          controller: {
            id: completedControllerId,
            my: true,
            owner: { username: 'me' },
            level: 1
          } as StructureController
        }),
        W3N1: makeExpansionRoom('W3N1')
      }
    });

    const plan = planTerritoryIntent(
      colony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      130
    );

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      createdBy: 'expansionPlanner',
      controllerId: nextControllerId
    });
    const territory = Memory.territory as TerritoryMemory;
    expect(territory.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: completedControllerId,
        enabled: false
      },
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: nextControllerId
      }
    ]);
    expect(territory.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'completed',
        updatedAt: 130,
        createdBy: 'expansionPlanner',
        controllerId: completedControllerId
      },
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 130,
        createdBy: 'expansionPlanner',
        controllerId: nextControllerId
      }
    ]);
  });

  it('clears completed expansion planner intents without targets before planning the next room', () => {
    const completedControllerId = 'controller-W2N1' as Id<StructureController>;
    const nextControllerId = 'controller-W3N1' as Id<StructureController>;
    const { colony } = makeColony({
      energyAvailable: 1_300,
      energyCapacityAvailable: 1_300,
      controllerLevel: 4
    });
    Memory.territory = {
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'active',
          updatedAt: 99,
          createdBy: 'expansionPlanner',
          controllerId: completedControllerId
        }
      ]
    };
    installGame(colony, {
      gclLevel: 4,
      exits: {
        W1N1: { '3': 'W2N1' },
        W2N1: { '3': 'W3N1' }
      },
      rooms: {
        W2N1: makeExpansionRoom('W2N1', {
          controller: {
            id: completedControllerId,
            my: true,
            owner: { username: 'me' },
            level: 1
          } as StructureController
        }),
        W3N1: makeExpansionRoom('W3N1')
      }
    });

    const plan = planTerritoryIntent(
      colony,
      { worker: 3, claimer: 0, claimersByTargetRoom: {} },
      3,
      140
    );

    expect(plan).toEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'claim',
      createdBy: 'expansionPlanner',
      controllerId: nextControllerId
    });
    const territory = Memory.territory as TerritoryMemory;
    expect(territory.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W3N1',
        action: 'claim',
        createdBy: 'expansionPlanner',
        controllerId: nextControllerId
      }
    ]);
    expect(territory.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'completed',
        updatedAt: 140,
        createdBy: 'expansionPlanner',
        controllerId: completedControllerId
      },
      {
        colony: 'W1N1',
        targetRoom: 'W3N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 140,
        createdBy: 'expansionPlanner',
        controllerId: nextControllerId
      }
    ]);
  });

  it('keeps claimer and reserver body selection distinct for expansion intents', () => {
    expect(buildTerritorySpawnBody(1_300, makeIntent('claim'))).toEqual([
      'claim',
      'move',
      'work',
      'carry',
      'move',
      'work',
      'carry',
      'move'
    ]);
    expect(buildTerritorySpawnBody(1_300, makeIntent('reserve'))).toEqual(['claim', 'claim', 'move', 'move']);
  });
});

function makeColony({
  energyAvailable = 650,
  energyCapacityAvailable = 650,
  controllerLevel = 3,
  hostileCreepCount = 0,
  hostileStructureCount = 0,
  spawns = [makeActiveSpawn('spawn-W1N1')]
}: {
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  controllerLevel?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  spawns?: StructureSpawn[];
} = {}): { colony: ColonySnapshot } {
  const room = {
    name: 'W1N1',
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: 'controller-W1N1' as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: controllerLevel,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn((findType: number): unknown[] => {
      if (findType === FIND_SOURCES) {
        return [{ id: 'source-W1N1-0' }];
      }
      if (findType === FIND_HOSTILE_CREEPS) {
        return Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `home-hostile-${index}` }));
      }
      if (findType === FIND_HOSTILE_STRUCTURES) {
        return Array.from({ length: hostileStructureCount }, (_value, index) => ({
          id: `home-hostile-structure-${index}`
        }));
      }

      return [];
    })
  } as unknown as Room;

  return {
    colony: {
      room,
      spawns,
      energyAvailable,
      energyCapacityAvailable
    }
  };
}

function makeActiveSpawn(name: string): StructureSpawn {
  return {
    id: `${name}-id` as Id<StructureSpawn>,
    name,
    spawning: null,
    isActive: jest.fn(() => true)
  } as unknown as StructureSpawn;
}

function makeExpansionRoom(
  roomName: string,
  {
    sourceCount = 2,
    hostileCreepCount = 0,
    hostileStructureCount = 0,
    controller = {
      id: `controller-${roomName}` as Id<StructureController>,
      my: false
    } as StructureController
  }: {
    sourceCount?: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
    controller?: StructureController;
  } = {}
): Room {
  return {
    name: roomName,
    controller,
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case FIND_SOURCES:
          return Array.from({ length: sourceCount }, (_value, index) => ({ id: `source-${roomName}-${index}` }));
        case FIND_HOSTILE_CREEPS:
          return Array.from({ length: hostileCreepCount }, (_value, index) => ({ id: `hostile-${index}` }));
        case FIND_HOSTILE_STRUCTURES:
          return Array.from({ length: hostileStructureCount }, (_value, index) => ({
            id: `hostile-structure-${index}`
          }));
        default:
          return [];
      }
    })
  } as unknown as Room;
}

function makeTowerPlanningRoom(
  roomName: string,
  {
    controllerPosition,
    sourcePositions,
    exitPositions,
    structures = [],
    constructionSites = [],
    wallPositions = new Set<string>()
  }: {
    controllerPosition: { x: number; y: number };
    sourcePositions: Array<{ x: number; y: number }>;
    exitPositions: Array<{ x: number; y: number }>;
    structures?: Structure[];
    constructionSites?: ConstructionSite[];
    wallPositions?: Set<string>;
  }
): Room {
  const sources = sourcePositions.map((position, index) => ({
    id: `source-${roomName}-${index}`,
    pos: makePosition(position.x, position.y, roomName)
  }));
  const room = {
    name: roomName,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: true,
      pos: makePosition(controllerPosition.x, controllerPosition.y, roomName)
    },
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case FIND_SOURCES:
          return sources;
        case FIND_STRUCTURES:
          return structures;
        case FIND_CONSTRUCTION_SITES:
          return constructionSites;
        case FIND_EXIT:
          return exitPositions.map((position) => makePosition(position.x, position.y, roomName));
        default:
          return [];
      }
    }),
    __wallPositions: wallPositions
  } as unknown as Room;

  return room;
}

function makeCoreRampartCoverage(
  idPrefix: string,
  spawn: { x: number; y: number },
  controller: { x: number; y: number },
  roomName: string
): Structure[] {
  const positions = [
    { x: spawn.x, y: spawn.y },
    ...getAdjacentPositions(spawn),
    ...getAdjacentPositions(controller)
  ];
  const seen = new Set<string>();
  return positions.flatMap((position, index) => {
    const key = `${position.x},${position.y}`;
    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [makePositionedStructure(`${idPrefix}-${index}`, position.x, position.y, roomName, STRUCTURE_RAMPART)];
  });
}

function getAdjacentPositions(center: { x: number; y: number }): Array<{ x: number; y: number }> {
  return [
    { x: center.x, y: center.y - 1 },
    { x: center.x + 1, y: center.y },
    { x: center.x, y: center.y + 1 },
    { x: center.x - 1, y: center.y },
    { x: center.x - 1, y: center.y - 1 },
    { x: center.x + 1, y: center.y - 1 },
    { x: center.x + 1, y: center.y + 1 },
    { x: center.x - 1, y: center.y + 1 }
  ];
}

function makePositionedStructure(
  id: string,
  x: number,
  y: number,
  roomName: string,
  structureType?: StructureConstant
): Structure {
  return {
    id,
    pos: makePosition(x, y, roomName),
    ...(structureType ? { structureType } : {})
  } as unknown as Structure;
}

function makePositionedConstructionSite(
  id: string,
  x: number,
  y: number,
  roomName: string,
  structureType: StructureConstant
): ConstructionSite {
  return {
    id,
    pos: makePosition(x, y, roomName),
    structureType
  } as unknown as ConstructionSite;
}

function makePosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function installTerrain(roomName: string, wallPositions: Set<string>): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({
        get: jest.fn((x: number, y: number) => (wallPositions.has(`${x},${y}`) ? 1 : 0))
      })
    } as unknown as GameMap,
    rooms: {}
  };
}

function installGame(
  colony: ColonySnapshot,
  {
    gclLevel,
    exits,
    rooms
  }: {
    gclLevel: number;
    exits: Record<string, Record<string, string>>;
    rooms: Record<string, Room>;
  }
): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 100,
    gcl: { level: gclLevel, progress: 0, progressTotal: 0 } as GlobalControlLevel,
    rooms: {
      [colony.room.name]: colony.room,
      ...rooms
    },
    map: {
      describeExits: jest.fn((roomName: string) => exits[roomName] ?? null),
      findRoute: jest.fn((_fromRoom: string, toRoom: string) => [{ exit: 3, room: toRoom }])
    } as unknown as GameMap
  };
}

function makeIntent(action: TerritoryControlAction): TerritoryIntentPlan {
  return {
    colony: 'W1N1',
    targetRoom: 'W2N1',
    action
  };
}
