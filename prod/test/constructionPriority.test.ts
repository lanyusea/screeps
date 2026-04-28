import {
  scoreConstructionPriorities,
  type ConstructionBuildCandidate,
  type ConstructionPriorityRoomState
} from '../src/construction/constructionPriority';

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

function makeRoomState(overrides: Partial<ConstructionPriorityRoomState> = {}): ConstructionPriorityRoomState {
  return {
    roomName: 'W1N1',
    rcl: 2,
    energyAvailable: 300,
    energyCapacity: 550,
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
