const STRATEGY_SHADOW_REPLAY_RUNTIME_SUMMARY = {
  type: 'runtime-summary',
  tick: 200,
  rooms: [
    {
      roomName: 'E48S29',
      energyAvailable: 350,
      energyCapacity: 550,
      workerCount: 4,
      spawnStatus: [{ name: 'Spawn1', status: 'idle' }],
      controller: {
        level: 3,
        progress: 12_000,
        progressTotal: 135_000,
        ticksToDowngrade: 8_000
      },
      resources: {
        storedEnergy: 420,
        workerCarriedEnergy: 120,
        droppedEnergy: 30,
        sourceCount: 2,
        events: {
          harvestedEnergy: 80,
          transferredEnergy: 65
        }
      },
      combat: {
        hostileCreepCount: 0,
        hostileStructureCount: 0,
        events: {
          attackCount: 0,
          attackDamage: 0,
          objectDestroyedCount: 0,
          creepDestroyedCount: 0
        }
      },
      constructionPriority: {
        candidates: [
          {
            buildItem: 'build extension capacity',
            room: 'E48S29',
            score: 70,
            urgency: 'high',
            preconditions: [],
            expectedKpiMovement: ['raises spawn energy capacity', 'unlocks larger workers and faster RCL progress'],
            risk: ['adds build backlog before roads/containers if worker capacity is low']
          },
          {
            buildItem: 'build remote road/container logistics',
            room: 'E48S29',
            score: 62,
            urgency: 'medium',
            preconditions: [],
            expectedKpiMovement: [
              'opens remote territory route',
              'supports reserve room economy',
              'improves harvest throughput'
            ],
            risk: []
          },
          {
            buildItem: 'build rampart defense',
            room: 'E48S29',
            score: 45,
            urgency: 'medium',
            preconditions: [],
            expectedKpiMovement: ['improves spawn/controller survivability under pressure'],
            risk: ['decays without sustained repair budget']
          }
        ],
        nextPrimary: {
          buildItem: 'build extension capacity',
          room: 'E48S29',
          score: 70,
          urgency: 'high',
          preconditions: [],
          expectedKpiMovement: ['raises spawn energy capacity', 'unlocks larger workers and faster RCL progress'],
          risk: ['adds build backlog before roads/containers if worker capacity is low']
        }
      },
      territoryRecommendation: {
        candidates: [
          {
            roomName: 'E48S27',
            action: 'reserve',
            score: 850,
            evidenceStatus: 'sufficient',
            source: 'configured',
            evidence: ['room visible', 'controller is available', '2 sources visible'],
            preconditions: [],
            risks: [],
            routeDistance: 2,
            sourceCount: 2
          },
          {
            roomName: 'E49S28',
            action: 'occupy',
            score: 820,
            evidenceStatus: 'sufficient',
            source: 'configured',
            evidence: ['room visible', 'controller is available', '1 source visible'],
            preconditions: [],
            risks: [],
            routeDistance: 1,
            sourceCount: 1
          },
          {
            roomName: 'E47S28',
            action: 'scout',
            score: 420,
            evidenceStatus: 'insufficient-evidence',
            source: 'adjacent',
            evidence: ['room visibility missing'],
            preconditions: [],
            risks: ['controller, source, and hostile evidence unavailable'],
            routeDistance: 1
          }
        ],
        next: {
          roomName: 'E48S27',
          action: 'reserve',
          score: 850,
          evidenceStatus: 'sufficient',
          source: 'configured',
          evidence: ['room visible', 'controller is available', '2 sources visible'],
          preconditions: [],
          risks: [],
          routeDistance: 2,
          sourceCount: 2
        },
        followUpIntent: {
          colony: 'E48S29',
          targetRoom: 'E48S27',
          action: 'reserve'
        }
      }
    }
  ],
  cpu: {
    used: 5.2,
    bucket: 9_000
  }
};

export const STRATEGY_SHADOW_REPLAY_FIXTURE = `#runtime-summary ${JSON.stringify(
  STRATEGY_SHADOW_REPLAY_RUNTIME_SUMMARY
)}`;
