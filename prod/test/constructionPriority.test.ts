import {
  DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE,
  buildConstructionSiteImpactPriorityContext,
  buildRuntimeConstructionPriorityReport,
  constructionPriorityStrategyParametersFromEntry,
  isPostClaimConstructionRoom,
  planTowerConstruction,
  selectImpactWeightedConstructionSite,
  scoreConstructionPriorities,
  type ConstructionBuildCandidate,
  type ConstructionSiteImpactPriorityContext,
  type ConstructionPriorityRoomState
} from '../src/construction/constructionPriority';
import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import { DEFAULT_STRATEGY_REGISTRY, type StrategyRegistryEntry } from '../src/strategy/strategyRegistry';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;

const TEST_GLOBALS = {
  FIND_MY_CONSTRUCTION_SITES: 101,
  FIND_MY_STRUCTURES: 102,
  FIND_STRUCTURES: 103,
  FIND_HOSTILE_CREEPS: 104,
  FIND_HOSTILE_STRUCTURES: 105,
  FIND_SOURCES: 106,
  LOOK_STRUCTURES: 'structure',
  LOOK_CONSTRUCTION_SITES: 'constructionSite',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_STORAGE: 'storage',
  STRUCTURE_WALL: 'constructedWall',
  TERRAIN_MASK_WALL: 1,
  OK: OK_CODE
} as const;

describe('construction priority scoring', () => {
  it('hard-gates survival and worker recovery above normal energy-capacity construction', () => {
    const state = makeRoomState({
      workerCount: 0,
      energyCapacity: 300
    });

    const report = scoreConstructionPriorities(state, [
      {
        buildItem: 'build extension capacity',
        buildType: 'extension',
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'energy-capacity', 'worker-count'],
        expectedKpiMovement: ['raises spawn energy capacity'],
        risk: ['adds construction backlog while recovery is unstable'],
        estimatedEnergyCost: 3_000,
        signals: { energyBottleneck: 0.9, spawnUtilization: 0.8 },
        vision: { resources: 1 }
      },
      {
        buildItem: 'build spawn recovery',
        buildType: 'spawn',
        minimumRcl: 1,
        requiredObservations: ['room-controller', 'spawn-count', 'worker-count'],
        expectedKpiMovement: ['restores worker production'],
        risk: ['large energy commitment'],
        estimatedEnergyCost: 15_000,
        signals: { survivalRecovery: 1 },
        vision: { survival: 1, territory: 0.5 }
      }
    ]);

    expect(report.nextPrimary?.buildItem).toBe('build spawn recovery');
    expect(scoreFor(report.candidates, 'build spawn recovery')).toBeGreaterThan(
      scoreFor(report.candidates, 'build extension capacity')
    );
    expect(report.nextPrimary).toMatchObject({
      room: 'W1N1',
      urgency: 'critical',
      expectedKpiMovement: ['restores worker production'],
      risk: ['large energy commitment']
    });
  });

  it('prioritizes defense construction when hostile pressure is visible', () => {
    const state = makeRoomState({
      rcl: 3,
      workerCount: 4,
      energyCapacity: 800,
      hostileCreepCount: 1
    });

    const report = scoreConstructionPriorities(state, [
      makeTowerCandidate(),
      {
        buildItem: 'build extension capacity',
        buildType: 'extension',
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'energy-capacity', 'hostile-presence'],
        expectedKpiMovement: ['raises spawn energy capacity'],
        risk: ['does not directly answer hostile pressure'],
        estimatedEnergyCost: 3_000,
        signals: { spawnUtilization: 0.75 },
        vision: { resources: 1 }
      }
    ]);

    expect(report.nextPrimary?.buildItem).toBe('build tower defense');
    expect(report.nextPrimary?.urgency).toBe('critical');
    expect(scoreFor(report.candidates, 'build tower defense')).toBeGreaterThan(
      scoreFor(report.candidates, 'build extension capacity')
    );
  });

  it('applies runtime strategy parameters to construction priority scoring', () => {
    const state = makeRoomState({
      rcl: 4,
      workerCount: 5,
      energyCapacity: 1_300,
      activeTerritoryIntentCount: 1
    });

    const report = scoreConstructionPriorities(
      state,
      [
        {
          buildItem: 'build remote logistics',
          buildType: 'remote-logistics',
          expectedKpiMovement: ['turns territory intent into sustainable income'],
          signals: { expansionPrerequisite: 0.4 },
          vision: { territory: 1, resources: 0.1 }
        },
        {
          buildItem: 'build storage logistics',
          buildType: 'storage',
          expectedKpiMovement: ['raises stored-energy capacity'],
          signals: { storageLogistics: 1 },
          vision: { resources: 1, territory: 0.1 }
        }
      ],
      {
        strategyParameters: {
          baseScoreWeight: 1,
          territorySignalWeight: 30,
          resourceSignalWeight: 0,
          killSignalWeight: 0,
          riskPenalty: 0
        }
      }
    );

    expect(report.nextPrimary?.buildItem).toBe('build remote logistics');
    expect(scoreFor(report.candidates, 'build remote logistics')).toBeGreaterThan(
      scoreFor(report.candidates, 'build storage logistics')
    );
  });

  it('preserves legacy construction scoring for registry entries without explicit parameters', () => {
    const incumbent = DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.incumbent.v1');
    expect(incumbent).toBeDefined();
    const plainEntry: StrategyRegistryEntry = {
      ...incumbent!,
      defaultValues: {}
    };

    expect(constructionPriorityStrategyParametersFromEntry(plainEntry)).toBeUndefined();
  });

  it('extracts construction priority scoring parameters when registry defaults are explicit', () => {
    const incumbent = DEFAULT_STRATEGY_REGISTRY.find((entry) => entry.id === 'construction-priority.incumbent.v1');

    expect(incumbent).toBeDefined();
    expect(constructionPriorityStrategyParametersFromEntry(incumbent)).toMatchObject({
      baseScoreWeight: 1,
      territorySignalWeight: 6,
      resourceSignalWeight: 4,
      killSignalWeight: 6,
      riskPenalty: 4
    });
  });

  it('weights expansion prerequisites ahead of lower-chain resource storage when home state is safe', () => {
    const state = makeRoomState({
      rcl: 4,
      workerCount: 5,
      energyCapacity: 1_300,
      activeTerritoryIntentCount: 1,
      remoteLogisticsReady: true
    });

    const report = scoreConstructionPriorities(state, [
      {
        buildItem: 'build remote road/container logistics',
        buildType: 'remote-logistics',
        minimumRcl: 2,
        minimumWorkers: 3,
        requiresSafeHome: true,
        requiredObservations: ['territory-intents', 'remote-paths', 'worker-count', 'hostile-presence'],
        expectedKpiMovement: ['turns territory intent into sustainable income'],
        risk: ['remote path exposure'],
        estimatedEnergyCost: 2_000,
        pathExposure: 'low',
        signals: { expansionPrerequisite: 1, harvestThroughput: 0.75, storageLogistics: 0.5 },
        vision: { territory: 1, resources: 0.6 }
      },
      {
        buildItem: 'build storage logistics',
        buildType: 'storage',
        minimumRcl: 4,
        minimumWorkers: 3,
        requiredObservations: ['room-controller', 'energy-capacity', 'worker-count'],
        expectedKpiMovement: ['improves local resource buffering'],
        risk: ['very high energy commitment'],
        estimatedEnergyCost: 30_000,
        signals: { storageLogistics: 0.95 },
        vision: { resources: 1 }
      }
    ]);

    expect(report.nextPrimary?.buildItem).toBe('build remote road/container logistics');
    expect(report.nextPrimary?.factors.expansionPrerequisites).toBeGreaterThan(
      scoreByName(report.candidates, 'build storage logistics').factors.expansionPrerequisites
    );
  });

  it('can surface an adjacent-controller claim intent when territory objective evidence is visible', () => {
    const state = makeRoomState({
      rcl: 4,
      workerCount: 5,
      energyCapacity: 1_300,
      activeTerritoryIntentCount: 1,
      remoteLogisticsReady: true
    });

    const report = scoreConstructionPriorities(state, [
      {
        buildItem: 'claim adjacent controller objective',
        roomName: 'W2N1',
        buildType: 'remote-logistics',
        policyAction: 'claim',
        minimumRcl: 2,
        minimumWorkers: 3,
        requiresSafeHome: true,
        requiredObservations: ['territory-intents', 'remote-paths', 'worker-count', 'hostile-presence'],
        expectedKpiMovement: ['activates adjacent-room territory reward tier'],
        risk: ['claim intent must be blocked or escorted if hostile defenders are present'],
        estimatedEnergyCost: 650,
        pathExposure: 'low',
        signals: { expansionPrerequisite: 1, harvestThroughput: 0.2, enemyKillPotential: 0.2 },
        vision: { territory: 1, enemyKills: 0.2 }
      },
      {
        buildItem: 'build storage logistics',
        buildType: 'storage',
        minimumRcl: 4,
        minimumWorkers: 3,
        requiredObservations: ['room-controller', 'energy-capacity', 'worker-count'],
        expectedKpiMovement: ['improves local resource buffering'],
        risk: ['very high energy commitment'],
        estimatedEnergyCost: 30_000,
        signals: { storageLogistics: 0.95 },
        vision: { resources: 1 }
      }
    ]);

    expect(report.nextPrimary).toMatchObject({
      buildItem: 'claim adjacent controller objective',
      room: 'W2N1',
      policyAction: 'claim',
      blocked: false
    });
    expect(scoreFor(report.candidates, 'claim adjacent controller objective')).toBeGreaterThan(
      scoreFor(report.candidates, 'build storage logistics')
    );
  });

  it('orders economic throughput construction above low-impact combat infrastructure without hostile pressure', () => {
    const state = makeRoomState({
      rcl: 3,
      workerCount: 4,
      energyCapacity: 800,
      sourceCount: 2
    });

    const report = scoreConstructionPriorities(state, [
      {
        buildItem: 'build source containers',
        buildType: 'container',
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'sources', 'worker-count'],
        expectedKpiMovement: ['raises harvest throughput', 'reduces dropped-energy waste'],
        risk: ['container decay upkeep'],
        estimatedEnergyCost: 5_000,
        pathExposure: 'low',
        signals: { harvestThroughput: 0.95, storageLogistics: 0.65, rclAcceleration: 0.35 },
        vision: { resources: 1, territory: 0.35 }
      },
      {
        buildItem: 'build idle rampart layer',
        buildType: 'rampart',
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'hostile-presence', 'repair-decay'],
        expectedKpiMovement: ['adds future defensive surface'],
        risk: ['creates recurring repair load before a threat exists'],
        estimatedEnergyCost: 1_000,
        signals: { defense: 0.1, enemyKillPotential: 0.15 },
        vision: { enemyKills: 0.4, territory: 0.2 }
      }
    ]);

    expect(report.nextPrimary?.buildItem).toBe('build source containers');
    expect(scoreByName(report.candidates, 'build source containers').factors.economicBenefit).toBeGreaterThan(
      scoreByName(report.candidates, 'build idle rampart layer').factors.economicBenefit
    );
  });

  it('ranks source logistics above extension capacity during RCL4 energy starvation', () => {
    const state = makeRoomState({
      rcl: 4,
      energyAvailable: 120,
      energyCapacity: 300,
      workerCount: 4,
      constructionSiteCount: 16,
      sourceCount: 2
    });

    const report = scoreConstructionPriorities(state, [
      {
        buildItem: 'build extension capacity',
        buildType: 'extension',
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'energy-capacity', 'worker-count', 'construction-sites'],
        expectedKpiMovement: ['raises spawn energy capacity'],
        risk: ['adds build backlog before roads/containers if worker capacity is low'],
        estimatedEnergyCost: 3_000,
        signals: { energyBottleneck: 0.85, spawnUtilization: 0.8, rclAcceleration: 0.65 },
        vision: { resources: 1, territory: 0.35 }
      },
      {
        buildItem: 'build source containers',
        buildType: 'container',
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'sources', 'worker-count'],
        expectedKpiMovement: ['raises harvest throughput', 'reduces dropped-energy waste'],
        risk: ['large early build cost and decay upkeep'],
        estimatedEnergyCost: 5_000,
        pathExposure: 'low',
        signals: { harvestThroughput: 0.9, storageLogistics: 0.65, rclAcceleration: 0.35 },
        vision: { resources: 1, territory: 0.35 }
      },
      {
        buildItem: 'build source/controller roads',
        buildType: 'road',
        minimumRcl: 2,
        requiredObservations: ['room-controller', 'sources', 'repair-decay', 'worker-count'],
        expectedKpiMovement: ['reduces worker travel time', 'improves harvest-to-spawn throughput'],
        risk: ['road decay creates recurring repair load'],
        estimatedEnergyCost: 300,
        pathExposure: 'low',
        signals: { harvestThroughput: 0.55, rclAcceleration: 0.45 },
        vision: { resources: 0.8, territory: 0.45 }
      }
    ]);

    expect(report.nextPrimary?.buildItem).toBe('build source containers');
    expect(scoreFor(report.candidates, 'build source containers')).toBeGreaterThan(
      scoreFor(report.candidates, 'build extension capacity')
    );
    expect(scoreFor(report.candidates, 'build source/controller roads')).toBeGreaterThan(
      scoreFor(report.candidates, 'build extension capacity')
    );
  });

  it('adds high-priority RCL2 extension bootstrap weight when stored energy is surplus and capacity is below max', () => {
    const state = makeRoomState({
      rcl: 2,
      energyCapacity: 300,
      storedEnergy: 600,
      extensionCount: 0,
      constructionSiteCount: 3
    });

    const report = scoreConstructionPriorities(state, [
      makeExtensionCandidate(),
      makeSourceContainerCandidate()
    ]);
    const extension = scoreByName(report.candidates, 'build extension capacity');

    expect(report.nextPrimary?.buildItem).toBe('build extension capacity');
    expect(extension.factors.extensionBootstrapWeight).toBeGreaterThan(0);
    expect(extension.score).toBeGreaterThan(scoreFor(report.candidates, 'build source containers'));
    expect(extension.urgency).toBe('critical');
  });

  it('does not add RCL2 extension bootstrap weight after all five RCL2 extensions are built', () => {
    const report = scoreConstructionPriorities(
      makeRoomState({
        rcl: 2,
        energyCapacity: 550,
        storedEnergy: 1_000,
        extensionCount: 5
      }),
      [makeExtensionCandidate()]
    );

    expect(scoreByName(report.candidates, 'build extension capacity').factors.extensionBootstrapWeight).toBe(0);
  });

  it('does not add RCL2 extension bootstrap weight without stored energy surplus', () => {
    const report = scoreConstructionPriorities(
      makeRoomState({
        rcl: 2,
        energyCapacity: 300,
        storedEnergy: 500,
        extensionCount: 0
      }),
      [makeExtensionCandidate()]
    );

    expect(scoreByName(report.candidates, 'build extension capacity').factors.extensionBootstrapWeight).toBe(0);
  });

  it('does not add RCL2 extension bootstrap weight at RCL3', () => {
    const report = scoreConstructionPriorities(
      makeRoomState({
        rcl: 3,
        energyCapacity: 300,
        storedEnergy: 1_000,
        extensionCount: 0
      }),
      [makeExtensionCandidate()]
    );

    expect(scoreByName(report.candidates, 'build extension capacity').factors.extensionBootstrapWeight).toBe(0);
  });

  it('returns a missing-observation precondition instead of scoring unsupported remote certainty', () => {
    const state = makeRoomState({
      activeTerritoryIntentCount: 1,
      remoteLogisticsReady: false,
      observations: {
        'remote-paths': false
      }
    });

    const report = scoreConstructionPriorities(state, [
      {
        buildItem: 'build remote road/container logistics',
        buildType: 'remote-logistics',
        minimumRcl: 2,
        minimumWorkers: 3,
        requiresSafeHome: true,
        requiredObservations: ['territory-intents', 'remote-paths', 'worker-count', 'hostile-presence'],
        expectedKpiMovement: ['turns territory intent into sustainable income'],
        risk: ['remote path exposure'],
        signals: { expansionPrerequisite: 1, harvestThroughput: 0.75 },
        vision: { territory: 1, resources: 0.6 }
      }
    ]);

    expect(report.nextPrimary).toMatchObject({
      buildItem: 'build remote road/container logistics',
      score: 0,
      urgency: 'blocked',
      blocked: true,
      missingObservations: ['remote-paths']
    });
    expect(report.nextPrimary?.preconditions).toContain('missing observation: remote path/logistics exposure');
  });
});

describe('impact-weighted construction site selection', () => {
  it('prioritizes an extension over a rampart at the same distance', () => {
    const extensionSite = makeConstructionSite('extension-site', 'extension', 20, 20);
    const rampartSite = makeConstructionSite('rampart-site', 'rampart', 21, 20);
    const origin = makeSelectionOrigin({
      'extension-site': 5,
      'rampart-site': 5
    });

    expect(selectImpactWeightedConstructionSite(origin, [rampartSite, extensionSite])?.id).toBe('extension-site');
  });

  it('prioritizes a claimed-room spawn site over extension construction', () => {
    const spawnSite = makeConstructionSite('spawn-site', 'spawn', 20, 20);
    const extensionSite = makeConstructionSite('extension-site', 'extension', 21, 20);
    const origin = makeSelectionOrigin({
      'spawn-site': 5,
      'extension-site': 5
    });

    expect(
      selectImpactWeightedConstructionSite(origin, [extensionSite, spawnSite], {
        claimedRoomName: 'W1N1'
      })?.id
    ).toBe('spawn-site');
  });

  it('uses post-claim room construction priority before distance tie-breaks', () => {
    const sites = [
      makeConstructionSite('storage-site', 'storage', 10, 10),
      makeConstructionSite('tower-site', 'tower', 11, 10),
      makeConstructionSite('rampart-site', 'rampart', 12, 10),
      makeConstructionSite('container-site', 'container', 13, 10),
      makeConstructionSite('road-site', 'road', 14, 10),
      makeConstructionSite('extension-site', 'extension', 15, 10),
      makeConstructionSite('spawn-site', 'spawn', 16, 10)
    ];
    const origin = makeSelectionOrigin(
      Object.fromEntries(sites.map((site) => [String(site.id), 1]))
    );
    const context: ConstructionSiteImpactPriorityContext = {
      postClaimRoomName: 'W1N1'
    };

    const selectedOrder: string[] = [];
    const remainingSites = [...sites];
    while (remainingSites.length > 0) {
      const selected = selectImpactWeightedConstructionSite(origin, remainingSites, context);
      expect(selected).not.toBeNull();
      selectedOrder.push(String(selected?.id));
      remainingSites.splice(remainingSites.findIndex((site) => site.id === selected?.id), 1);
    }

    expect(selectedOrder).toEqual([
      'spawn-site',
      'extension-site',
      'container-site',
      'road-site',
      'rampart-site',
      'tower-site',
      'storage-site'
    ]);
  });

  it('prioritizes a source container over a generic road', () => {
    const source = { id: 'source1', pos: makeRoomPosition(10, 10) } as Source;
    const containerSite = makeConstructionSite('source-container-site', 'container', 11, 10);
    const roadSite = makeConstructionSite('generic-road-site', 'road', 25, 25);
    const origin = makeSelectionOrigin({
      'source-container-site': 8,
      'generic-road-site': 2
    });
    const context: ConstructionSiteImpactPriorityContext = { sources: [source] };

    expect(selectImpactWeightedConstructionSite(origin, [roadSite, containerSite], context)?.id).toBe(
      'source-container-site'
    );
  });

  it('prioritizes controller-source lane roads as critical logistics construction', () => {
    installTestGlobals();
    try {
      const source = { id: 'source1', pos: makeRoomPosition(40, 10) } as Source;
      const controller = { my: true, pos: makeRoomPosition(40, 40) } as StructureController;
      const spawn = makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 10, 10);
      const criticalRoadSite = makeConstructionSite('controller-source-road-site', 'road', 40, 25);
      const sourceContainerSite = makeConstructionSite('source-container-site', 'container', 41, 10);
      const room = {
        name: 'W1N1',
        controller,
        find: jest.fn((findType: number) => {
          if (findType === TEST_GLOBALS.FIND_MY_STRUCTURES) {
            return [spawn];
          }

          return findType === TEST_GLOBALS.FIND_SOURCES ? [source] : [];
        })
      } as unknown as Room;
      const origin = makeSelectionOrigin({
        'controller-source-road-site': 8,
        'source-container-site': 2
      });
      const context = buildConstructionSiteImpactPriorityContext(room);

      expect(selectImpactWeightedConstructionSite(origin, [sourceContainerSite, criticalRoadSite], context)?.id).toBe(
        'controller-source-road-site'
      );
    } finally {
      clearTestGlobals();
    }
  });

  it('prioritizes source containers and critical roads over extensions during RCL4 energy starvation', () => {
    installTestGlobals();
    try {
      const source = { id: 'source1', pos: makeRoomPosition(40, 10) } as Source;
      const spawn = makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 10, 10);
      const extensionSite = makeConstructionSite('extension-site', 'extension', 20, 20);
      const sourceContainerSite = makeConstructionSite('source-container-site', 'container', 41, 10);
      const criticalRoadSite = makeConstructionSite('source-road-site', 'road', 25, 10);
      const room = {
        name: 'W1N1',
        energyAvailable: 120,
        energyCapacityAvailable: 300,
        controller: { my: true, level: 4, pos: makeRoomPosition(25, 25) } as StructureController,
        find: jest.fn((findType: number) => {
          if (findType === TEST_GLOBALS.FIND_MY_STRUCTURES) {
            return [spawn];
          }

          return findType === TEST_GLOBALS.FIND_SOURCES ? [source] : [];
        })
      } as unknown as Room;
      const origin = makeSelectionOrigin({
        'extension-site': 2,
        'source-container-site': 8,
        'source-road-site': 4
      });
      const context = buildConstructionSiteImpactPriorityContext(room);

      expect(
        selectImpactWeightedConstructionSite(origin, [extensionSite, criticalRoadSite, sourceContainerSite], context)?.id
      ).toBe('source-container-site');
      expect(selectImpactWeightedConstructionSite(origin, [extensionSite, criticalRoadSite], context)?.id).toBe(
        'source-road-site'
      );
    } finally {
      clearTestGlobals();
    }
  });

  it('keeps tower and protected rampart construction above road/container logistics', () => {
    const towerSite = makeConstructionSite('tower-site', 'tower', 20, 20);
    const rampartSite = makeConstructionSite('protected-rampart-site', 'rampart', 21, 20);
    const source = { id: 'source1', pos: makeRoomPosition(22, 20) } as Source;
    const containerSite = makeConstructionSite('source-container-site', 'container', 22, 20);
    const roadSite = makeConstructionSite('road-site', 'road', 23, 20);
    const origin = makeSelectionOrigin({
      'tower-site': 5,
      'protected-rampart-site': 5,
      'source-container-site': 5,
      'road-site': 5
    });
    const context: ConstructionSiteImpactPriorityContext = {
      protectedRampartAnchors: [makeRoomPosition(21, 20)],
      sources: [source]
    };

    expect(selectImpactWeightedConstructionSite(origin, [roadSite, containerSite, towerSite], context)?.id).toBe(
      'tower-site'
    );
    expect(selectImpactWeightedConstructionSite(origin, [roadSite, containerSite, rampartSite], context)?.id).toBe(
      'protected-rampart-site'
    );
  });

  it('treats rampart sites around towers as protected defense construction', () => {
    installTestGlobals();
    try {
      const tower = makeOwnedStructure('tower1', TEST_GLOBALS.STRUCTURE_TOWER, 20, 20);
      const towerRampartSite = makeConstructionSite('tower-rampart-site', 'rampart', 20, 20);
      const genericRampartSite = makeConstructionSite('generic-rampart-site', 'rampart', 35, 35);
      const room = {
        name: 'W1N1',
        controller: { my: true, pos: makeRoomPosition(40, 40) } as StructureController,
        find: jest.fn((findType: number) => {
          if (findType === TEST_GLOBALS.FIND_MY_STRUCTURES) {
            return [tower];
          }

          return [];
        })
      } as unknown as Room;
      const context = buildConstructionSiteImpactPriorityContext(room);
      const origin = makeSelectionOrigin({
        'tower-rampart-site': 5,
        'generic-rampart-site': 5
      });

      expect(
        selectImpactWeightedConstructionSite(origin, [genericRampartSite, towerRampartSite], context)?.id
      ).toBe('tower-rampart-site');
    } finally {
      clearTestGlobals();
    }
  });

  it('chooses the closest site when multiple sites have the same impact', () => {
    const farExtensionSite = makeConstructionSite('extension-far', 'extension', 20, 20);
    const nearExtensionSite = makeConstructionSite('extension-near', 'extension', 21, 20);
    const origin = makeSelectionOrigin({
      'extension-far': 9,
      'extension-near': 2
    });

    expect(selectImpactWeightedConstructionSite(origin, [farExtensionSite, nearExtensionSite])?.id).toBe(
      'extension-near'
    );
  });

  it('selects a high-priority site even when it is outside reasonable range', () => {
    const farExtensionSite = makeConstructionSite('extension-far', 'extension', 20, 20);
    const wallSite = makeConstructionSite('wall-near', 'constructedWall', 21, 20);
    const origin = makeSelectionOrigin({
      'extension-far': DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE + 5,
      'wall-near': 3
    });

    expect(selectImpactWeightedConstructionSite(origin, [farExtensionSite, wallSite])?.id).toBe('extension-far');
  });
});

describe('runtime construction priority report', () => {
  beforeEach(() => {
    installTestGlobals();
  });

  afterEach(() => {
    clearTestGlobals();
  });

  it('ignores creeps with missing memory while counting runtime workers', () => {
    const { colony } = makeRuntimeColony();
    const report = buildRuntimeConstructionPriorityReport(colony, [
      {} as unknown as Creep,
      { memory: { role: 'worker', colony: 'W1N1' } } as Creep
    ]);

    expect(scoreByName(report.candidates, 'build extension capacity').blocked).toBe(false);
  });

  it('skips malformed territory intent entries while counting runtime intent pressure', () => {
    const { colony } = makeRuntimeColony();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          null,
          undefined,
          'stale',
          7,
          { status: 'active' },
          makeTerritoryIntent('W1N1', 'W2N1', 'active'),
          makeTerritoryIntent('W1N1', 'W3N1', 'planned'),
          makeTerritoryIntent('W2N2', 'W4N1', 'active'),
          makeTerritoryIntent('W1N1', 'W5N1', 'suppressed')
        ] as unknown as TerritoryIntentMemory[]
      }
    };

    const report = buildRuntimeConstructionPriorityReport(colony, [
      { memory: { role: 'worker', colony: 'W1N1' } } as Creep,
      { memory: { role: 'worker', colony: 'W1N1' } } as Creep,
      { memory: { role: 'worker', colony: 'W1N1' } } as Creep
    ]);

    expect(scoreByName(report.candidates, 'build remote road/container logistics')).toMatchObject({
      blocked: true,
      missingObservations: ['remote-paths']
    });
  });

  it('plans tower and rampart defense without hostile-presence observation', () => {
    const { colony } = makeRuntimeColony({
      controllerLevel: 3,
      energyCapacityAvailable: 800,
      ownedStructures: [makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20)]
    });
    const globals = globalThis as Record<string, unknown>;
    delete globals.FIND_HOSTILE_CREEPS;
    delete globals.FIND_HOSTILE_STRUCTURES;

    const report = buildRuntimeConstructionPriorityReport(colony, [
      { memory: { role: 'worker', colony: 'W1N1' } } as Creep,
      { memory: { role: 'worker', colony: 'W1N1' } } as Creep,
      { memory: { role: 'worker', colony: 'W1N1' } } as Creep
    ]);

    expect(scoreByName(report.candidates, 'build tower defense')).toMatchObject({
      blocked: false,
      missingObservations: []
    });
    expect(scoreByName(report.candidates, 'build rampart defense')).toMatchObject({
      blocked: false,
      missingObservations: []
    });
    expect(scoreFor(report.candidates, 'build tower defense')).toBeGreaterThanOrEqual(
      scoreFor(report.candidates, 'build rampart defense')
    );
  });

  it('plans additional towers until the current RCL tower cap is covered', () => {
    const oneTower = buildRuntimeConstructionPriorityReport(
      makeRuntimeColony({
        controllerLevel: 5,
        energyCapacityAvailable: 800,
        ownedStructures: [
          makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20),
          makeOwnedStructure('tower1', TEST_GLOBALS.STRUCTURE_TOWER, 21, 20)
        ]
      }).colony,
      [{ memory: { role: 'worker', colony: 'W1N1' } } as Creep]
    );

    const saturated = buildRuntimeConstructionPriorityReport(
      makeRuntimeColony({
        controllerLevel: 5,
        energyCapacityAvailable: 800,
        ownedStructures: [
          makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20),
          makeOwnedStructure('tower1', TEST_GLOBALS.STRUCTURE_TOWER, 21, 20),
          makeOwnedStructure('tower2', TEST_GLOBALS.STRUCTURE_TOWER, 22, 20)
        ]
      }).colony,
      [{ memory: { role: 'worker', colony: 'W1N1' } } as Creep]
    );

    const pendingSecondTower = buildRuntimeConstructionPriorityReport(
      makeRuntimeColony({
        controllerLevel: 5,
        energyCapacityAvailable: 800,
        ownedStructures: [
          makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20),
          makeOwnedStructure('tower1', TEST_GLOBALS.STRUCTURE_TOWER, 21, 20)
        ],
        ownedConstructionSites: [makeConstructionSite('tower-site', TEST_GLOBALS.STRUCTURE_TOWER, 22, 20)]
      }).colony,
      [{ memory: { role: 'worker', colony: 'W1N1' } } as Creep]
    );

    expect(hasBuildItem(oneTower.candidates, 'build tower defense')).toBe(true);
    expect(hasBuildItem(saturated.candidates, 'build tower defense')).toBe(false);
    expect(hasBuildItem(pendingSecondTower.candidates, 'build tower defense')).toBe(false);
  });

  it('prioritizes RCL3 extension capacity after first tower readiness until the RCL3 cap', () => {
    const report = buildRuntimeConstructionPriorityReport(
      makeRuntimeColony({
        controllerLevel: 3,
        energyCapacityAvailable: 550,
        ownedStructures: [
          makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20),
          makeOwnedStructure('tower1', TEST_GLOBALS.STRUCTURE_TOWER, 21, 20),
          ...Array.from({ length: 5 }, (_, index) =>
            makeOwnedStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 22 + index, 20)
          )
        ]
      }).colony,
      [
        { memory: { role: 'worker', colony: 'W1N1' } } as Creep,
        { memory: { role: 'worker', colony: 'W1N1' } } as Creep,
        { memory: { role: 'worker', colony: 'W1N1' } } as Creep,
        { memory: { role: 'worker', colony: 'W1N1' } } as Creep
      ]
    );
    const extension = scoreByName(report.candidates, 'build extension capacity');

    expect(report.nextPrimary?.buildItem).toBe('build extension capacity');
    expect(extension.factors.urgency).toBeGreaterThan(0);
    expect(extension.score).toBeGreaterThan(scoreFor(report.candidates, 'build source containers'));
    expect(extension.score).toBeGreaterThan(scoreFor(report.candidates, 'build source/controller roads'));
  });

  it('does not plan another RCL3 extension candidate when pending extension work reaches the cap', () => {
    const report = buildRuntimeConstructionPriorityReport(
      makeRuntimeColony({
        controllerLevel: 3,
        energyCapacityAvailable: 800,
        ownedStructures: [
          makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20),
          makeOwnedStructure('tower1', TEST_GLOBALS.STRUCTURE_TOWER, 21, 20),
          ...Array.from({ length: 9 }, (_, index) =>
            makeOwnedStructure(`extension-${index}`, TEST_GLOBALS.STRUCTURE_EXTENSION, 22 + index, 20)
          )
        ],
        ownedConstructionSites: [makeConstructionSite('extension-site', TEST_GLOBALS.STRUCTURE_EXTENSION, 31, 20)]
      }).colony,
      [{ memory: { role: 'worker', colony: 'W1N1' } } as Creep]
    );

    expect(hasBuildItem(report.candidates, 'finish extension site')).toBe(true);
    expect(hasBuildItem(report.candidates, 'build extension capacity')).toBe(false);
  });
});

describe('post-claim construction room detection', () => {
  beforeEach(() => {
    installTestGlobals();
  });

  afterEach(() => {
    clearTestGlobals();
  });

  it('keeps completed claimed rooms active while storage construction is still missing', () => {
    const { room } = makeRuntimeColony({
      controllerLevel: 4,
      ownedStructures: [makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20)]
    });
    installCompletedClaimedRoomMemory(room.name);
    installVisibleRoom(room);

    expect(isPostClaimConstructionRoom(room.name)).toBe(true);
  });

  it('keeps completed claimed rooms active while rampart coverage is still missing', () => {
    const { room } = makeRuntimeColony({
      controllerLevel: 3,
      ownedStructures: [makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20)]
    });
    installCompletedClaimedRoomMemory(room.name);
    installVisibleRoom(room);

    expect(isPostClaimConstructionRoom(room.name)).toBe(true);
  });

  it('retires completed claimed rooms when visible post-claim milestones are covered', () => {
    const { room } = makeRuntimeColony({
      controllerLevel: 4,
      ownedStructures: [
        makeOwnedStructure('spawn1', TEST_GLOBALS.STRUCTURE_SPAWN, 20, 20),
        makeOwnedStructure('storage1', TEST_GLOBALS.STRUCTURE_STORAGE, 21, 20)
      ]
    });
    installCompletedClaimedRoomMemory(room.name);
    installVisibleRoom(room, TEST_GLOBALS.TERRAIN_MASK_WALL);

    expect(isPostClaimConstructionRoom(room.name)).toBe(false);
  });
});

describe('fixed structure construction planning', () => {
  beforeEach(() => {
    installTestGlobals();
  });

  afterEach(() => {
    clearTestGlobals();
  });

  it('blocks candidates using lookForAtArea wrapper and nested object positions', () => {
    const { colony, room } = makeRuntimeColony({ controllerLevel: 3 });
    installOpenTerrain();
    const fixedRoom = room as unknown as { createConstructionSite: jest.Mock; lookForAtArea: jest.Mock };
    fixedRoom.lookForAtArea = jest.fn((lookType: LookConstant) => {
      if (lookType === TEST_GLOBALS.LOOK_STRUCTURES) {
        return [
          {
            x: 19,
            y: 19,
            structure: makeOwnedStructure('occupied-road', TEST_GLOBALS.STRUCTURE_ROAD, 19, 19)
          }
        ];
      }

      if (lookType === TEST_GLOBALS.LOOK_CONSTRUCTION_SITES) {
        return [
          {
            constructionSite: makeConstructionSite('pending-road', TEST_GLOBALS.STRUCTURE_ROAD, 20, 19)
          }
        ];
      }

      return [];
    });
    fixedRoom.createConstructionSite = jest.fn().mockReturnValue(OK_CODE);

    expect(planTowerConstruction(colony)).toBe(OK_CODE);

    expect(fixedRoom.createConstructionSite).toHaveBeenCalledTimes(1);
    expect(fixedRoom.createConstructionSite).toHaveBeenCalledWith(21, 19, TEST_GLOBALS.STRUCTURE_TOWER);
  });

  it('continues to the next candidate when fixed-structure site creation fails', () => {
    const { colony, room } = makeRuntimeColony({ controllerLevel: 3 });
    installOpenTerrain();
    const fixedRoom = room as unknown as { createConstructionSite: jest.Mock; lookForAtArea: jest.Mock };
    fixedRoom.lookForAtArea = jest.fn().mockReturnValue([]);
    fixedRoom.createConstructionSite = jest
      .fn()
      .mockReturnValueOnce(ERR_INVALID_TARGET_CODE)
      .mockReturnValueOnce(OK_CODE);

    expect(planTowerConstruction(colony)).toBe(OK_CODE);

    expect(fixedRoom.createConstructionSite).toHaveBeenNthCalledWith(1, 19, 19, TEST_GLOBALS.STRUCTURE_TOWER);
    expect(fixedRoom.createConstructionSite).toHaveBeenNthCalledWith(2, 20, 19, TEST_GLOBALS.STRUCTURE_TOWER);
  });
});

function makeRoomState(overrides: Partial<ConstructionPriorityRoomState> = {}): ConstructionPriorityRoomState {
  return {
    roomName: 'W1N1',
    rcl: 2,
    energyAvailable: 300,
    energyCapacity: 550,
    storedEnergy: 300,
    workerCount: 3,
    spawnCount: 1,
    sourceCount: 2,
    extensionCount: 5,
    towerCount: 0,
    constructionSiteCount: 0,
    criticalRepairCount: 0,
    decayingStructureCount: 0,
    controllerTicksToDowngrade: 20_000,
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    activeTerritoryIntentCount: 0,
    plannedTerritoryIntentCount: 0,
    remoteLogisticsReady: true,
    observations: {
      'room-controller': true,
      'energy-capacity': true,
      'worker-count': true,
      'spawn-count': true,
      'construction-sites': true,
      'repair-decay': true,
      'hostile-presence': true,
      sources: true,
      'territory-intents': true,
      'remote-paths': true,
      ...overrides.observations
    },
    ...overrides
  };
}

function makeExtensionCandidate(): ConstructionBuildCandidate {
  return {
    buildItem: 'build extension capacity',
    buildType: 'extension',
    minimumRcl: 2,
    requiredObservations: ['room-controller', 'energy-capacity', 'worker-count', 'construction-sites'],
    expectedKpiMovement: ['raises spawn energy capacity', 'unlocks larger workers and faster RCL progress'],
    risk: ['adds build backlog before roads/containers if worker capacity is low'],
    estimatedEnergyCost: 3_000,
    signals: { energyBottleneck: 0.85, spawnUtilization: 0.8, rclAcceleration: 0.65 },
    vision: { resources: 1, territory: 0.35 }
  };
}

function makeSourceContainerCandidate(): ConstructionBuildCandidate {
  return {
    buildItem: 'build source containers',
    buildType: 'container',
    minimumRcl: 2,
    requiredObservations: ['room-controller', 'sources', 'worker-count'],
    expectedKpiMovement: ['raises harvest throughput', 'reduces dropped-energy waste'],
    risk: ['large early build cost and decay upkeep'],
    estimatedEnergyCost: 5_000,
    pathExposure: 'low',
    signals: { harvestThroughput: 0.9, storageLogistics: 0.65, rclAcceleration: 0.35 },
    vision: { resources: 1, territory: 0.35 }
  };
}

function makeTowerCandidate(): ConstructionBuildCandidate {
  return {
    buildItem: 'build tower defense',
    buildType: 'tower',
    minimumRcl: 3,
    requiredObservations: ['room-controller', 'hostile-presence', 'worker-count'],
    expectedKpiMovement: ['improves room hold safety', 'adds hostile damage capacity'],
    risk: ['requires steady energy income'],
    estimatedEnergyCost: 5_000,
    hostileExposure: 'medium',
    signals: { defense: 0.9, enemyKillPotential: 0.7 },
    vision: { survival: 0.9, territory: 0.9, enemyKills: 0.5 }
  };
}

interface RuntimeColonyOptions {
  controllerLevel?: number;
  energyCapacityAvailable?: number;
  ownedConstructionSites?: ConstructionSite[];
  ownedStructures?: AnyOwnedStructure[];
  sources?: Source[];
  visibleStructures?: AnyStructure[];
}

function makeRuntimeColony(options: RuntimeColonyOptions = {}): { colony: ColonySnapshot; room: Room } {
  const controllerPosition = makeRoomPosition(25, 25);
  let ownedStructures: AnyOwnedStructure[] = [];
  const ownedConstructionSites = options.ownedConstructionSites ?? [];
  const sources = options.sources ?? ([{ id: 'source1' }, { id: 'source2' }] as Source[]);
  const room = {
    name: 'W1N1',
    controller: {
      my: true,
      level: options.controllerLevel ?? 2,
      ticksToDowngrade: 20_000,
      pos: controllerPosition
    } as StructureController,
    find: jest.fn((findType: number) => {
      switch (findType) {
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
          return ownedConstructionSites;
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return ownedStructures;
        case TEST_GLOBALS.FIND_STRUCTURES:
          return options.visibleStructures ?? ownedStructures;
        case TEST_GLOBALS.FIND_HOSTILE_CREEPS:
        case TEST_GLOBALS.FIND_HOSTILE_STRUCTURES:
          return [];
        case TEST_GLOBALS.FIND_SOURCES:
          return sources;
        default:
          return [];
      }
    })
  } as unknown as Room;
  const spawn = {
    id: 'spawn1',
    name: 'Spawn1',
    structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
    pos: makeRoomPosition(20, 20),
    room
  } as unknown as StructureSpawn;
  ownedStructures = options.ownedStructures ?? ([spawn] as AnyOwnedStructure[]);

  return {
    room,
    colony: {
      room,
      spawns: [spawn],
      energyAvailable: 300,
      energyCapacityAvailable: options.energyCapacityAvailable ?? 550
    }
  };
}

function makeTerritoryIntent(
  colony: string,
  targetRoom: string,
  status: TerritoryIntentMemory['status']
): TerritoryIntentMemory {
  return {
    colony,
    targetRoom,
    action: 'reserve',
    status,
    updatedAt: 1
  };
}

function installCompletedClaimedRoomMemory(roomName: string): void {
  (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
    territory: {
      claimedRoomBootstrapper: {
        rooms: {
          [roomName]: {
            roomName,
            owned: true,
            claimedAt: 1,
            completedAt: 2,
            updatedAt: 2
          }
        }
      }
    }
  };
}

function installVisibleRoom(room: Room, terrainValue = 0): void {
  (globalThis as unknown as { Game: Partial<Game> & { rooms: Record<string, Room> } }).Game = {
    rooms: {
      [room.name]: room
    },
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(terrainValue) })
    } as unknown as GameMap
  };
}

function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function makeConstructionSite(
  id: string,
  structureType: string,
  x: number,
  y: number
): ConstructionSite {
  return {
    id,
    structureType,
    pos: makeRoomPosition(x, y),
    progress: 0,
    progressTotal: 100
  } as unknown as ConstructionSite;
}

function makeOwnedStructure(id: string, structureType: string, x: number, y: number): AnyOwnedStructure {
  return {
    id,
    structureType,
    pos: makeRoomPosition(x, y),
    my: true
  } as unknown as AnyOwnedStructure;
}

function makeSelectionOrigin(rangesByTargetId: Record<string, number>): RoomObject {
  return {
    pos: {
      getRangeTo: jest.fn((target: { id?: string }) => rangesByTargetId[String(target.id)] ?? 99)
    }
  } as unknown as RoomObject;
}

function scoreFor(candidates: { buildItem: string; score: number }[], buildItem: string): number {
  return scoreByName(candidates, buildItem).score;
}

function scoreByName<T extends { buildItem: string }>(candidates: T[], buildItem: string): T {
  const candidate = candidates.find((entry) => entry.buildItem === buildItem);
  if (!candidate) {
    throw new Error(`missing scored candidate ${buildItem}`);
  }

  return candidate;
}

function hasBuildItem(candidates: { buildItem: string }[], buildItem: string): boolean {
  return candidates.some((candidate) => candidate.buildItem === buildItem);
}

function installTestGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(TEST_GLOBALS)) {
    globals[key] = value;
  }
  (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
}

function clearTestGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const key of Object.keys(TEST_GLOBALS)) {
    delete globals[key];
  }
  delete globals.Memory;
  delete globals.Game;
}

function installOpenTerrain(): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    map: {
      getRoomTerrain: jest.fn().mockReturnValue({ get: jest.fn().mockReturnValue(0) })
    } as unknown as GameMap
  };
}
