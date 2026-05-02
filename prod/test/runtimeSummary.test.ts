import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  emitRuntimeSummary,
  RUNTIME_SUMMARY_INTERVAL,
  RUNTIME_SUMMARY_PREFIX,
  shouldEmitRuntimeSummary,
  type RuntimeTelemetryEvent
} from '../src/telemetry/runtimeSummary';
import { CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD } from '../src/tasks/workerTasks';

const TEST_GLOBALS = {
  FIND_STRUCTURES: 101,
  FIND_DROPPED_RESOURCES: 102,
  FIND_SOURCES: 103,
  FIND_HOSTILE_CREEPS: 104,
  FIND_HOSTILE_STRUCTURES: 105,
  FIND_MY_STRUCTURES: 106,
  FIND_MY_CONSTRUCTION_SITES: 107,
  EVENT_HARVEST: 201,
  EVENT_TRANSFER: 202,
  EVENT_BUILD: 203,
  EVENT_REPAIR: 204,
  EVENT_UPGRADE_CONTROLLER: 205,
  EVENT_ATTACK: 206,
  EVENT_OBJECT_DESTROYED: 207,
  RESOURCE_ENERGY: 'energy',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_STORAGE: 'storage'
} as const;

const RUNTIME_GLOBAL_KEYS = Object.keys(TEST_GLOBALS);

describe('runtime telemetry summaries', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    clearRuntimeTelemetryGlobals();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    clearRuntimeTelemetryGlobals();
  });

  it('emits cadence-limited runtime summaries with room, spawn, task, CPU, and KPI fields', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      spawn: {
        name: 'Spawn1',
        spawning: { name: 'worker-W1N1-20', remainingTime: 3 }
      }
    });
    const creeps = [
      makeWorker({ role: 'worker', colony: 'W1N1', task: { type: 'harvest', targetId: 'source1' as Id<Source> } }, 40),
      makeWorker({ role: 'worker', colony: 'W1N1' }, 20),
      makeWorker({ role: 'worker', colony: 'W2N2', task: { type: 'transfer', targetId: 'spawn2' as Id<AnyStoreStructure> } }, 80)
    ];

    emitRuntimeSummary([colony], creeps);

    const payload = parseLoggedSummary();
    expect(payload).toEqual({
      type: 'runtime-summary',
      tick: RUNTIME_SUMMARY_INTERVAL,
      rooms: [
        {
          roomName: 'W1N1',
          energyAvailable: 250,
          energyCapacity: 300,
          workerCount: 2,
          spawnStatus: [
            {
              name: 'Spawn1',
              status: 'spawning',
              creepName: 'worker-W1N1-20',
              remainingTime: 3
            }
          ],
          taskCounts: {
            none: 1,
            harvest: 1,
            transfer: 0,
            build: 0,
            repair: 0,
            upgrade: 0
          },
          controller: {
            level: 2,
            progress: 1234,
            progressTotal: 45000,
            ticksToDowngrade: 15000
          },
          resources: {
            storedEnergy: 175,
            workerCarriedEnergy: 60,
            droppedEnergy: 25,
            sourceCount: 2,
            productiveEnergy: {
              assignedWorkerCount: 0,
              assignedCarriedEnergy: 0,
              buildCarriedEnergy: 0,
              repairCarriedEnergy: 0,
              upgradeCarriedEnergy: 0,
              pendingBuildProgress: 0,
              repairBacklogHits: 0,
              controllerProgressRemaining: 43766
            },
            events: {
              harvestedEnergy: 10,
              transferredEnergy: 5,
              builtProgress: 25,
              repairedHits: 100,
              upgradedControllerProgress: 7
            }
          },
          combat: {
            hostileCreepCount: 1,
            hostileStructureCount: 1,
            events: {
              attackCount: 1,
              attackDamage: 30,
              objectDestroyedCount: 1,
              creepDestroyedCount: 1
            }
          },
          constructionPriority: {
            candidates: [
              {
                buildItem: 'build rampart defense',
                room: 'W1N1',
                score: 49,
                urgency: 'critical',
                preconditions: [],
                expectedKpiMovement: ['improves spawn/controller survivability under pressure'],
                risk: ['decays without sustained repair budget']
              },
              {
                buildItem: 'build extension capacity',
                room: 'W1N1',
                score: 45,
                urgency: 'high',
                preconditions: [],
                expectedKpiMovement: [
                  'raises spawn energy capacity',
                  'unlocks larger workers and faster RCL progress'
                ],
                risk: ['adds build backlog before roads/containers if worker capacity is low']
              },
              {
                buildItem: 'build source containers',
                room: 'W1N1',
                score: 25,
                urgency: 'low',
                preconditions: [],
                expectedKpiMovement: ['raises harvest throughput', 'reduces dropped-energy waste'],
                risk: ['large early build cost and decay upkeep']
              }
            ],
            nextPrimary: {
              buildItem: 'build rampart defense',
              room: 'W1N1',
              score: 49,
              urgency: 'critical',
              preconditions: [],
              expectedKpiMovement: ['improves spawn/controller survivability under pressure'],
              risk: ['decays without sustained repair budget']
            }
          },
          survival: {
            mode: 'BOOTSTRAP',
            workerCapacity: 2,
            workerTarget: 4,
            survivalWorkerFloor: 3,
            suppressionReasons: ['bootstrapWorkerFloor']
          },
          territoryRecommendation: {
            candidates: [],
            next: null,
            followUpIntent: null
          }
        }
      ],
      cpu: {
        used: 4.2,
        bucket: 9000
      }
    });
  });

  it('does not emit on non-cadence ticks without events', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL + 1 });

    emitRuntimeSummary([colony], []);

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('refreshes refill telemetry on non-cadence ticks from cached room data without rescanning', () => {
    const refillTarget = {
      id: 'extension1',
      structureType: TEST_GLOBALS.STRUCTURE_EXTENSION,
      store: makeEnergyStore(0)
    };
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      structures: [refillTarget]
    });
    const roomFind = (colony.room as unknown as { find: jest.Mock }).find;
    const getEventLog = jest.fn(() =>
      Game.time === RUNTIME_SUMMARY_INTERVAL * 2
        ? [
            {
              event: TEST_GLOBALS.EVENT_TRANSFER,
              objectId: 'worker1',
              data: {
                targetId: 'extension1',
                amount: 25,
                resourceType: TEST_GLOBALS.RESOURCE_ENERGY
              }
            }
          ]
        : []
    );
    (colony.room as unknown as { getEventLog: jest.Mock }).getEventLog = getEventLog;
    const worker = {
      id: 'worker1',
      name: 'RefillWorker',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'transfer', targetId: 'extension1' as Id<AnyStoreStructure> }
      },
      store: makeEnergyStore(25)
    } as unknown as Creep;

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });
    logSpy.mockClear();
    roomFind.mockClear();
    getEventLog.mockClear();

    for (let tick = RUNTIME_SUMMARY_INTERVAL + 1; tick < RUNTIME_SUMMARY_INTERVAL * 2; tick += 1) {
      (globalThis as unknown as { Game: Partial<Game> }).Game.time = tick;
      emitRuntimeSummary([colony], [worker], [], { persistOccupationRecommendations: false });
    }

    expect(logSpy).not.toHaveBeenCalled();
    expect(roomFind).not.toHaveBeenCalled();
    expect(getEventLog).not.toHaveBeenCalled();
    expect(worker.memory.refillTelemetry).toMatchObject({
      current: {
        targetId: 'extension1',
        startedAt: RUNTIME_SUMMARY_INTERVAL + 1,
        activeTicks: RUNTIME_SUMMARY_INTERVAL - 1,
        idleOrOtherTaskTicks: 0
      },
      refillActiveTicks: RUNTIME_SUMMARY_INTERVAL - 1,
      lastUpdatedAt: RUNTIME_SUMMARY_INTERVAL * 2 - 1
    });

    (globalThis as unknown as { Game: Partial<Game> }).Game.time = RUNTIME_SUMMARY_INTERVAL * 2;
    emitRuntimeSummary([colony], [worker], [], { persistOccupationRecommendations: false });

    expect(roomFind).toHaveBeenCalled();
    expect(getEventLog).toHaveBeenCalledTimes(1);
    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.refillDeliveryTicks).toEqual({
      completedCount: 1,
      averageTicks: RUNTIME_SUMMARY_INTERVAL,
      maxTicks: RUNTIME_SUMMARY_INTERVAL,
      samples: [
        {
          creepName: 'RefillWorker',
          tick: RUNTIME_SUMMARY_INTERVAL * 2,
          targetId: 'extension1',
          deliveryTicks: RUNTIME_SUMMARY_INTERVAL,
          activeTicks: RUNTIME_SUMMARY_INTERVAL,
          idleOrOtherTaskTicks: 0,
          energyDelivered: 25
        }
      ]
    });
    expect(room.refillWorkerUtilization).toEqual({
      assignedWorkerCount: 1,
      refillActiveTicks: RUNTIME_SUMMARY_INTERVAL,
      idleOrOtherTaskTicks: 0,
      ratio: 1,
      workers: [
        {
          creepName: 'RefillWorker',
          refillActiveTicks: RUNTIME_SUMMARY_INTERVAL,
          idleOrOtherTaskTicks: 0,
          ratio: 1
        }
      ]
    });
  });

  it('emits non-cadence summaries for spawn events and bounds event payload size', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL + 1 });
    const events = Array.from({ length: 12 }, (_, index): RuntimeTelemetryEvent => ({
      type: 'spawn',
      roomName: 'W1N1',
      spawnName: 'Spawn1',
      creepName: `worker-W1N1-${index}`,
      role: 'worker',
      result: 0 as ScreepsReturnCode
    }));

    emitRuntimeSummary([colony], [], events);

    const payload = parseLoggedSummary();
    const reportedEvents = payload.events as unknown[];
    expect(reportedEvents).toHaveLength(10);
    expect(reportedEvents[0]).toEqual({
      type: 'spawn',
      roomName: 'W1N1',
      spawnName: 'Spawn1',
      creepName: 'worker-W1N1-0',
      role: 'worker',
      result: 0
    });
    expect(payload.omittedEventCount).toBe(2);
  });

  it('reports productive worker energy and local action backlog in room telemetry', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      constructionSites: [
        { id: 'road-site', structureType: TEST_GLOBALS.STRUCTURE_ROAD, progress: 30, progressTotal: 100 },
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 25.5, progressTotal: 50 }
      ],
      structures: [
        { id: 'road-damaged', structureType: TEST_GLOBALS.STRUCTURE_ROAD, hits: 1_000, hitsMax: 5_000 },
        { id: 'container-damaged', structureType: TEST_GLOBALS.STRUCTURE_CONTAINER, hits: 900, hitsMax: 1_000 },
        {
          id: 'rampart-damaged',
          structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
          my: true,
          hits: 90_000,
          hitsMax: 300_000
        },
        {
          id: 'enemy-rampart',
          structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
          my: false,
          hits: 1,
          hitsMax: 300_000
        }
      ]
    });
    const creeps = [
      makeWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'build', targetId: 'road-site' as Id<ConstructionSite> } },
        40,
        'Builder'
      ),
      makeWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'repair', targetId: 'road-damaged' as Id<Structure> } },
        20,
        'Repairer'
      ),
      makeWorker(
        {
          role: 'worker',
          colony: 'W1N1',
          task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> }
        },
        10,
        'Upgrader'
      ),
      makeWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
        50,
        'Carrier'
      )
    ];

    emitRuntimeSummary([colony], creeps);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.taskCounts).toMatchObject({ build: 1, repair: 1, upgrade: 1, transfer: 1, none: 0 });
    expect((room.resources as Record<string, unknown>).productiveEnergy).toEqual({
      assignedWorkerCount: 3,
      assignedCarriedEnergy: 70,
      buildCarriedEnergy: 40,
      repairCarriedEnergy: 20,
      upgradeCarriedEnergy: 10,
      pendingBuildProgress: 95,
      repairBacklogHits: 14100,
      controllerProgressRemaining: 43766
    });
  });

  it('reports bounded room-level worker efficiency samples', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const lowLoadReturnReasons: WorkerEfficiencyLowLoadReturnReason[] = [
      'noReachableEnergy',
      'emergencySpawnExtensionRefill',
      'hostileSafety'
    ];
    const recentWorkers = Array.from({ length: 7 }, (_, index) =>
      makeWorker(
        {
          role: 'worker',
          colony: 'W1N1',
          workerEfficiency:
            index % 2 === 0
              ? {
                  type: 'nearbyEnergyChoice',
                  tick: RUNTIME_SUMMARY_INTERVAL,
                  carriedEnergy: 5 + index,
                  freeCapacity: 45,
                  selectedTask: 'pickup',
                  targetId: `drop-${index}`,
                  energy: 50,
                  range: 1
                }
              : {
                  type: 'lowLoadReturn',
                  tick: RUNTIME_SUMMARY_INTERVAL,
                  carriedEnergy: 5 + index,
                  freeCapacity: 45,
                  selectedTask: 'transfer',
                  targetId: `spawn-${index}`,
                  reason: lowLoadReturnReasons[Math.floor(index / 2)]
                }
        },
        5,
        `Worker${index}`
      )
    );
    const staleWorker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        workerEfficiency: {
          type: 'lowLoadReturn',
          tick: 0,
          carriedEnergy: 5,
          freeCapacity: 45,
          selectedTask: 'transfer',
          targetId: 'spawn-stale',
          reason: 'emergencySpawnExtensionRefill'
        }
      },
      5,
      'WorkerStale'
    );

    emitRuntimeSummary([colony], [...recentWorkers, staleWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerEfficiency).toEqual({
      lowLoadReturnCount: 3,
      emergencyLowLoadReturnCount: 2,
      avoidableLowLoadReturnCount: 1,
      nearbyEnergyChoiceCount: 4,
      lowLoadReturnReasons: [
        {
          reason: 'emergencySpawnExtensionRefill',
          category: 'emergency',
          count: 1
        },
        {
          reason: 'hostileSafety',
          category: 'emergency',
          count: 1
        },
        {
          reason: 'noReachableEnergy',
          category: 'avoidable',
          count: 1
        }
      ],
      samples: [
        {
          creepName: 'Worker0',
          type: 'nearbyEnergyChoice',
          tick: RUNTIME_SUMMARY_INTERVAL,
          carriedEnergy: 5,
          freeCapacity: 45,
          selectedTask: 'pickup',
          targetId: 'drop-0',
          energy: 50,
          range: 1
        },
        {
          creepName: 'Worker1',
          type: 'lowLoadReturn',
          tick: RUNTIME_SUMMARY_INTERVAL,
          carriedEnergy: 6,
          freeCapacity: 45,
          selectedTask: 'transfer',
          targetId: 'spawn-1',
          reason: 'noReachableEnergy'
        },
        {
          creepName: 'Worker2',
          type: 'nearbyEnergyChoice',
          tick: RUNTIME_SUMMARY_INTERVAL,
          carriedEnergy: 7,
          freeCapacity: 45,
          selectedTask: 'pickup',
          targetId: 'drop-2',
          energy: 50,
          range: 1
        },
        {
          creepName: 'Worker3',
          type: 'lowLoadReturn',
          tick: RUNTIME_SUMMARY_INTERVAL,
          carriedEnergy: 8,
          freeCapacity: 45,
          selectedTask: 'transfer',
          targetId: 'spawn-3',
          reason: 'emergencySpawnExtensionRefill'
        },
        {
          creepName: 'Worker4',
          type: 'nearbyEnergyChoice',
          tick: RUNTIME_SUMMARY_INTERVAL,
          carriedEnergy: 9,
          freeCapacity: 45,
          selectedTask: 'pickup',
          targetId: 'drop-4',
          energy: 50,
          range: 1
        }
      ],
      omittedSampleCount: 2
    });
  });

  it('reports worker behavior cloning traces with shadow-only policy metadata', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const recentWorker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        workerBehavior: makeWorkerBehaviorSample('transfer', 'spawn1', RUNTIME_SUMMARY_INTERVAL),
        workerTaskPolicyShadow: {
          type: 'workerTaskPolicyShadow',
          schemaVersion: 1,
          tick: RUNTIME_SUMMARY_INTERVAL,
          policyId: 'worker-task-bc.test.v1',
          liveEffect: false,
          predictedAction: 'transfer',
          confidence: 1,
          heuristicAction: 'transfer',
          matched: true
        }
      },
      50,
      'Carrier'
    );
    const mismatchWorker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        workerBehavior: makeWorkerBehaviorSample('build', 'site1', RUNTIME_SUMMARY_INTERVAL - 1),
        workerTaskPolicyShadow: {
          type: 'workerTaskPolicyShadow',
          schemaVersion: 1,
          tick: RUNTIME_SUMMARY_INTERVAL - 1,
          policyId: 'worker-task-bc.test.v1',
          liveEffect: false,
          predictedAction: 'upgrade',
          confidence: 1,
          heuristicAction: 'build',
          matched: false,
          fallbackReason: 'actionMismatch'
        }
      },
      50,
      'Builder'
    );
    const staleWorker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        workerBehavior: makeWorkerBehaviorSample('harvest', 'source1', 0)
      },
      0,
      'Stale'
    );

    emitRuntimeSummary([colony], [recentWorker, mismatchWorker, staleWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.behavior).toEqual({
      workerTaskPolicy: {
        schemaVersion: 1,
        sourcePolicyId: 'heuristic.worker-task.v1',
        liveEffect: false,
        sampleCount: 2,
        actionCounts: {
          harvest: 0,
          transfer: 1,
          build: 1,
          repair: 0,
          upgrade: 0
        },
        samples: [
          {
            creepName: 'Carrier',
            ...makeWorkerBehaviorSample('transfer', 'spawn1', RUNTIME_SUMMARY_INTERVAL)
          },
          {
            creepName: 'Builder',
            ...makeWorkerBehaviorSample('build', 'site1', RUNTIME_SUMMARY_INTERVAL - 1)
          }
        ],
        shadow: {
          policyId: 'worker-task-bc.test.v1',
          liveEffect: false,
          sampleCount: 2,
          matchedCount: 1,
          mismatchCount: 1,
          noPredictionCount: 0,
          matchRate: 0.5
        }
      }
    });
  });

  it('reports spawn-critical refill assignment telemetry', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const carrier = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> },
        spawnCriticalRefill: {
          type: 'spawnCriticalRefill',
          tick: RUNTIME_SUMMARY_INTERVAL,
          targetId: 'spawn1',
          carriedEnergy: 50,
          spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
          freeCapacity: 101,
          threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
        }
      },
      50,
      'CriticalCarrier'
    );
    const staleCarrier = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        spawnCriticalRefill: {
          type: 'spawnCriticalRefill',
          tick: 0,
          targetId: 'spawn-stale',
          carriedEnergy: 50,
          spawnEnergy: 0,
          freeCapacity: 300,
          threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
        }
      },
      50,
      'StaleCarrier'
    );

    emitRuntimeSummary([colony], [carrier, staleCarrier]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.spawnCriticalRefill).toEqual({
      assignedWorkerCount: 1,
      assignedCarriedEnergy: 50,
      threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD,
      samples: [
        {
          creepName: 'CriticalCarrier',
          type: 'spawnCriticalRefill',
          tick: RUNTIME_SUMMARY_INTERVAL,
          targetId: 'spawn1',
          carriedEnergy: 50,
          spawnEnergy: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD - 1,
          freeCapacity: 101,
          threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
        }
      ]
    });
  });

  it('keeps KPI summaries safe when optional Screeps APIs and constants are absent', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      installGlobals: false,
      includeRoomFind: false,
      includeEventLog: false
    });
    const creeps = [makeWorker({ role: 'worker', colony: 'W1N1' }, 7)];

    expect(() => emitRuntimeSummary([colony], creeps)).not.toThrow();

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room).toMatchObject({
      controller: {
        level: 2,
        progress: 1234,
        progressTotal: 45000,
        ticksToDowngrade: 15000
      },
      resources: {
        storedEnergy: 50,
        workerCarriedEnergy: 7,
        droppedEnergy: 0,
        sourceCount: 0
      },
      combat: {
        hostileCreepCount: 0,
        hostileStructureCount: 0
      }
    });
    expect((room.resources as Record<string, unknown>).events).toBeUndefined();
    expect((room.combat as Record<string, unknown>).events).toBeUndefined();
  });

  it('emits the next occupation recommendation in room telemetry', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [{ colony: 'W1N1', roomName: 'W2N1', action: 'claim' }],
        routeDistances: { 'W1N1>W2N1': 2 }
      }
    };
    (Game.rooms as Record<string, Room>).W2N1 = makeRemoteRoom('W2N1', {
      controller: {
        id: 'controller2' as Id<StructureController>,
        my: false,
        pos: { x: 25, y: 25, roomName: 'W2N1' }
      } as StructureController,
      sourceCount: 2
    });
    (Game as Partial<Game>).map = {
      describeExits: jest.fn(() => ({ '3': 'W2N1' })),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) }))
    } as unknown as GameMap;

    emitRuntimeSummary([colony], [
      makeWorker({ role: 'worker', colony: 'W1N1' }),
      makeWorker({ role: 'worker', colony: 'W1N1' }),
      makeWorker({ role: 'worker', colony: 'W1N1' })
    ]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const recommendation = room.territoryRecommendation as Record<string, unknown>;

    expect(recommendation.next).toMatchObject({
      roomName: 'W2N1',
      action: 'occupy',
      evidenceStatus: 'sufficient',
      source: 'configured',
      routeDistance: 2,
      sourceCount: 2
    });
    expect(recommendation.followUpIntent).toEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'claim',
      controllerId: 'controller2'
    });
    expect(room.territoryExpansion).toMatchObject({
      next: {
        roomName: 'W2N1',
        score: expect.any(Number),
        evidenceStatus: 'sufficient',
        sourceCount: 2,
        routeDistance: 2,
        rationale: expect.arrayContaining([
          'controller unreserved',
          '2 sources visible',
          'terrain walkable 100%',
          'home route distance 2'
        ])
      }
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: RUNTIME_SUMMARY_INTERVAL,
        controllerId: 'controller2'
      }
    ]);
  });

  it('emits active territory follow-up execution hints in room telemetry', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedReserveAdjacent',
      originRoom: 'W1N2',
      originAction: 'reserve'
    };
    const executionHint: TerritoryExecutionHintMemory = {
      type: 'activeFollowUpExecution',
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      reason: 'visibleControlEvidenceStillActionable',
      updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
      followUp
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
            followUp
          }
        ],
        executionHints: [executionHint]
      }
    };
    (Game.rooms as Record<string, Room>).W2N1 = makeRemoteRoom('W2N1', {
      controller: { my: false } as StructureController,
      sourceCount: 1
    });

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.territoryExecutionHints).toEqual([executionHint]);
  });

  it('groups creeps by colony before building per-room summaries', () => {
    const firstColony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      roomName: 'W1N1',
      spawn: { name: 'Spawn1', spawning: null }
    });
    const secondColony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      roomName: 'W2N2',
      spawn: { name: 'Spawn2', spawning: null }
    });
    const offColonyTelemetry = { memoryReadCount: 0 };

    emitRuntimeSummary(
      [firstColony, secondColony],
      [
        makeWorker({ role: 'worker', colony: 'W1N1' }, 10, 'WorkerW1N1'),
        makeWorker({ role: 'worker', colony: 'W2N2' }, 20, 'WorkerW2N2'),
        makeTrackedWorker({ role: 'worker', colony: 'W9N9' }, offColonyTelemetry, 30, 'WorkerW9N9')
      ]
    );

    const payload = parseLoggedSummary();
    const rooms = payload.rooms as Array<Record<string, unknown>>;
    expect(rooms.map((room) => [room.roomName, room.workerCount])).toEqual([
      ['W1N1', 1],
      ['W2N2', 1]
    ]);
    expect(offColonyTelemetry.memoryReadCount).toBe(1);
  });

  it('emits adjacent territory controller-progress intent coverage in room telemetry', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const describeExits = jest.fn(() => ({ '3': 'W2N1' }));
    (globalThis as unknown as { Game: Partial<Game> }).Game.map = {
      describeExits
    } as unknown as GameMap;
    (Game.rooms as Record<string, Room>).W2N1 = makeRemoteRoom('W2N1', {
      controller: { my: false } as StructureController,
      sourceCount: 2
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'active',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1
          }
        ]
      }
    };

    emitRuntimeSummary(
      [colony],
      [
        makeWorker({ role: 'worker', colony: 'W1N1' }),
        makeWorker({ role: 'worker', colony: 'W1N1' }),
        makeWorker({ role: 'worker', colony: 'W1N1' }),
        makeTerritoryClaimer({ targetRoom: 'W2N1', action: 'reserve' }, 'claimer-W1N1-W2N1')
      ]
    );

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.territoryIntents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: RUNTIME_SUMMARY_INTERVAL,
        activeCreepCount: 1,
        adjacentToColony: true
      }
    ]);
    expect(describeExits).toHaveBeenCalledWith('W1N1');
  });

  it('emits suspended territory intent counts by target room in room telemetry', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'reserve',
            status: 'planned',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 2,
            suspended: {
              reason: 'hostile_presence',
              hostileCount: 1,
              updatedAt: RUNTIME_SUMMARY_INTERVAL - 1
            }
          },
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 2,
            suspended: {
              reason: 'hostile_presence',
              hostileCount: 2,
              updatedAt: RUNTIME_SUMMARY_INTERVAL - 1
            }
          },
          {
            colony: 'W1N1',
            targetRoom: 'W3N1',
            action: 'reserve',
            status: 'active',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 2,
            suspended: {
              reason: 'hostile_presence',
              hostileCount: 1,
              updatedAt: RUNTIME_SUMMARY_INTERVAL - 1
            }
          }
        ]
      }
    };

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.suspendedTerritoryIntentCounts).toEqual({
      W2N1: 2,
      W3N1: 1
    });
    expect(room.territoryIntents).toBeUndefined();
  });

  it('keeps emission gating deterministic', () => {
    expect(shouldEmitRuntimeSummary(1, [])).toBe(false);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [])).toBe(true);
    expect(
      shouldEmitRuntimeSummary(1, [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-1',
          role: 'worker',
          result: 0 as ScreepsReturnCode
        }
      ])
    ).toBe(true);
  });

  function parseLoggedSummary(): Record<string, unknown> {
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(typeof message).toBe('string');
    expect((message as string).startsWith(RUNTIME_SUMMARY_PREFIX)).toBe(true);

    return JSON.parse((message as string).slice(RUNTIME_SUMMARY_PREFIX.length)) as Record<string, unknown>;
  }
});

function installRuntimeTelemetryGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(TEST_GLOBALS)) {
    globals[key] = value;
  }
}

function clearRuntimeTelemetryGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  for (const key of RUNTIME_GLOBAL_KEYS) {
    delete globals[key];
  }
  delete globals.Game;
  delete globals.Memory;
}

function makeColony(options: {
  time: number;
  spawn?: {
    name: string;
    spawning: { name: string; remainingTime: number } | null;
  };
  constructionSites?: unknown[];
  installGlobals?: boolean;
  includeRoomFind?: boolean;
  includeEventLog?: boolean;
  roomName?: string;
  structures?: unknown[];
}): ColonySnapshot {
  if (options.installGlobals !== false) {
    installRuntimeTelemetryGlobals();
  }

  const roomName = options.roomName ?? 'W1N1';
  const room = {
    name: roomName,
    energyAvailable: 250,
    energyCapacityAvailable: 300,
    controller: {
      my: true,
      level: 2,
      progress: 1234,
      progressTotal: 45000,
      ticksToDowngrade: 15000
    }
  } as unknown as Room;
  const spawn = {
    name: options.spawn?.name ?? (roomName === 'W1N1' ? 'Spawn1' : `Spawn-${roomName}`),
    room,
    spawning: options.spawn?.spawning ?? null,
    store: makeEnergyStore(50)
  } as unknown as StructureSpawn;
  const structures = options.structures ?? [spawn, { store: makeEnergyStore(125) }];
  const constructionSites = options.constructionSites ?? [];

  if (options.includeRoomFind !== false) {
    (room as unknown as { find?: jest.Mock }).find = jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
          return constructionSites;
        case TEST_GLOBALS.FIND_DROPPED_RESOURCES:
          return [
            { resourceType: TEST_GLOBALS.RESOURCE_ENERGY, amount: 25 },
            { resourceType: 'power', amount: 100 }
          ];
        case TEST_GLOBALS.FIND_SOURCES:
          return [{ id: 'source1' }, { id: 'source2' }];
        case TEST_GLOBALS.FIND_HOSTILE_CREEPS:
          return [{ id: 'hostile1' }];
        case TEST_GLOBALS.FIND_HOSTILE_STRUCTURES:
          return [{ id: 'hostile-structure1' }];
        default:
          return [];
      }
    });
  }

  if (options.includeEventLog !== false) {
    (room as unknown as { getEventLog?: jest.Mock }).getEventLog = jest.fn(() => [
      { event: TEST_GLOBALS.EVENT_HARVEST, data: { amount: 10, resourceType: TEST_GLOBALS.RESOURCE_ENERGY } },
      { event: TEST_GLOBALS.EVENT_TRANSFER, data: { amount: 5, resourceType: TEST_GLOBALS.RESOURCE_ENERGY } },
      { event: TEST_GLOBALS.EVENT_TRANSFER, data: { amount: 99, resourceType: 'power' } },
      { event: TEST_GLOBALS.EVENT_BUILD, data: { amount: 25 } },
      { event: TEST_GLOBALS.EVENT_REPAIR, data: { amount: 100 } },
      { event: TEST_GLOBALS.EVENT_UPGRADE_CONTROLLER, data: { amount: 7 } },
      { event: TEST_GLOBALS.EVENT_ATTACK, data: { damage: 30 } },
      { event: TEST_GLOBALS.EVENT_OBJECT_DESTROYED, data: { type: 'creep' } }
    ]);
  }

  const existingGame = (globalThis as unknown as { Game?: Partial<Game> }).Game;
  const existingRooms = existingGame?.rooms ?? {};
  const existingSpawns = existingGame?.spawns ?? {};
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: options.time,
    rooms: { ...existingRooms, [roomName]: room },
    spawns: { ...existingSpawns, [spawn.name]: spawn },
    creeps: existingGame?.creeps ?? {},
    cpu: {
      getUsed: jest.fn().mockReturnValue(4.2),
      bucket: 9000
    } as unknown as CPU
  };

  return {
    room,
    spawns: [spawn],
    energyAvailable: room.energyAvailable,
    energyCapacityAvailable: room.energyCapacityAvailable
  };
}

function makeWorker(memory: CreepMemory, energy = 0, name?: string): Creep {
  return {
    ...(name ? { name } : {}),
    memory,
    store: makeEnergyStore(energy)
  } as unknown as Creep;
}

function makeWorkerBehaviorSample(
  action: WorkerTaskBehaviorActionType,
  targetId: string,
  tick: number
): WorkerTaskBehaviorSampleMemory {
  return {
    type: 'workerTaskBehavior',
    schemaVersion: 1,
    tick,
    policyId: 'heuristic.worker-task.v1',
    liveEffect: false,
    state: {
      roomName: 'W1N1',
      carriedEnergy: action === 'harvest' ? 0 : 50,
      freeCapacity: action === 'harvest' ? 50 : 0,
      energyCapacity: 50,
      energyLoadRatio: action === 'harvest' ? 0 : 1,
      currentTask: 'none',
      currentTaskCode: 0,
      workerCount: 2,
      spawnExtensionNeedCount: action === 'transfer' ? 1 : 0,
      towerNeedCount: 0,
      constructionSiteCount: action === 'build' ? 1 : 0,
      repairTargetCount: 0,
      sourceCount: 2,
      hasContainerEnergy: false,
      containerEnergyAvailable: 0,
      droppedEnergyAvailable: 0,
      nearbyRoadCount: 0,
      nearbyContainerCount: 0,
      roadCoverage: 0,
      hostileCreepCount: 0
    },
    action: { type: action, targetId }
  };
}

function makeTrackedWorker(
  memory: CreepMemory,
  telemetry: { memoryReadCount: number },
  energy = 0,
  name?: string
): Creep {
  return {
    ...(name ? { name } : {}),
    get memory(): CreepMemory {
      telemetry.memoryReadCount += 1;
      return memory;
    },
    store: makeEnergyStore(energy)
  } as unknown as Creep;
}

function makeTerritoryClaimer(
  territory: CreepTerritoryMemory,
  name: string,
  colony = 'W1N1'
): Creep {
  return {
    name,
    memory: {
      role: 'claimer',
      colony,
      territory
    },
    body: [{ type: 'claim', hits: 100 }],
    ticksToLive: 1_200
  } as unknown as Creep;
}

function makeRemoteRoom(
  roomName: string,
  options: {
    controller?: StructureController;
    sourceCount?: number;
    hostileCreepCount?: number;
    hostileStructureCount?: number;
  }
): Room {
  return {
    name: roomName,
    controller: options.controller,
    find: jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_SOURCES:
          return Array.from({ length: options.sourceCount ?? 0 }, (_value, index) => ({
            id: `source${index}`,
            pos: { x: 15 + index * 20, y: 25, roomName }
          }));
        case TEST_GLOBALS.FIND_HOSTILE_CREEPS:
          return Array.from({ length: options.hostileCreepCount ?? 0 }, (_value, index) => ({ id: `hostile${index}` }));
        case TEST_GLOBALS.FIND_HOSTILE_STRUCTURES:
          return Array.from({ length: options.hostileStructureCount ?? 0 }, (_value, index) => ({
            id: `hostile-structure${index}`
          }));
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
          return [];
        default:
          return [];
      }
    })
  } as unknown as Room;
}

function makeEnergyStore(energy: number): { getUsedCapacity: (resource?: ResourceConstant) => number } {
  return {
    getUsedCapacity: (resource?: ResourceConstant) => (resource === TEST_GLOBALS.RESOURCE_ENERGY ? energy : 0)
  };
}
