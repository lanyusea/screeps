import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  emitRuntimeSummary,
  RUNTIME_CPU_SUMMARY_PREFIX,
  RUNTIME_SUMMARY_INTERVAL,
  RUNTIME_SUMMARY_PREFIX,
  resetRuntimeCpuSummaryEmissionForTesting,
  shouldEmitRuntimeSummary,
  type RuntimeTelemetryEvent
} from '../src/telemetry/runtimeSummary';
import { buildRuntimeCpuBudget, resetRuntimeCpuTelemetryForTesting } from '../src/runtime/cpuBudget';
import { recordCreepBehaviorIdle } from '../src/telemetry/behaviorTelemetry';
import { CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD } from '../src/tasks/workerTasks';
import { OCCUPIED_CONTROLLER_SIGN_TEXT } from '../src/territory/controllerSigning';
import { DEFAULT_STRATEGY_REGISTRY } from '../src/strategy/strategyRegistry';
import {
  RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL,
  RUNTIME_POLICY_PARAMETERS_GLOBAL,
  applyRuntimePolicyParametersToRegistry,
  createRuntimePolicyParameterConsumptionRecorder,
  persistRuntimePolicyParameterConsumptionEvidence
} from '../src/strategy/runtimePolicyParameters';

const TEST_GLOBALS = {
  FIND_STRUCTURES: 101,
  FIND_DROPPED_RESOURCES: 102,
  FIND_SOURCES: 103,
  FIND_HOSTILE_CREEPS: 104,
  FIND_HOSTILE_STRUCTURES: 105,
  FIND_MY_STRUCTURES: 106,
  FIND_MY_CONSTRUCTION_SITES: 107,
  FIND_MY_CREEPS: 108,
  FIND_CONSTRUCTION_SITES: 109,
  EVENT_HARVEST: 201,
  EVENT_TRANSFER: 202,
  EVENT_BUILD: 203,
  EVENT_REPAIR: 204,
  EVENT_UPGRADE_CONTROLLER: 205,
  EVENT_ATTACK: 206,
  EVENT_OBJECT_DESTROYED: 207,
  RESOURCE_ENERGY: 'energy',
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_EXTENSION: 'extension',
  STRUCTURE_TOWER: 'tower',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_ROAD: 'road',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_STORAGE: 'storage',
  STRUCTURE_TERMINAL: 'terminal',
  STRUCTURE_LINK: 'link'
} as const;

const RUNTIME_GLOBAL_KEYS = Object.keys(TEST_GLOBALS);
const DEFAULT_TEST_CONTROLLER_PROGRESS = 1234;
const DEFAULT_TEST_CONTROLLER_PROGRESS_TOTAL = 45_000;

describe('runtime telemetry summaries', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    clearRuntimeTelemetryGlobals();
    resetRuntimeCpuTelemetryForTesting();
    resetRuntimeCpuSummaryEmissionForTesting();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    resetRuntimeCpuTelemetryForTesting();
    resetRuntimeCpuSummaryEmissionForTesting();
    clearRuntimeTelemetryGlobals();
  });

  it('emits cadence-limited runtime summaries with room, spawn, task, CPU, and KPI fields', () => {
    const creeps = [
      makeWorker({ role: 'worker', colony: 'W1N1', task: { type: 'harvest', targetId: 'source1' as Id<Source> } }, 40),
      makeWorker({ role: 'worker', colony: 'W1N1' }, 20),
      makeWorker({ role: 'worker', colony: 'W2N2', task: { type: 'transfer', targetId: 'spawn2' as Id<AnyStoreStructure> } }, 80)
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      spawn: {
        name: 'Spawn1',
        spawning: { name: 'worker-W1N1-20', remainingTime: 3 }
      },
      creeps: creeps.filter((creep) => creep.memory.colony === 'W1N1')
    });

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
          cpuUsed: 4.2,
          cpuBucket: 9000,
          energyBufferHealth: {
            currentEnergy: 250,
            threshold: 200,
            room: 'W1N1',
            healthy: true
          },
          workerCount: 2,
          workerCarriedEnergy: 60,
          workerAssignmentEvidenceAvailable: true,
          workerAssignmentEvidence: {
            source: 'runtime-summary',
            available: true,
            tick: RUNTIME_SUMMARY_INTERVAL,
            workerCount: 2,
            assignedTaskCount: 1,
            productiveAssignmentCount: 1,
            unassignedWorkerCount: 1,
            idleReasonCounts: {
              controller_upgrade_saturated_standby: 0,
              cpu_shed_assignment_skipped: 0,
              no_task_available: 0,
              role_body_unavailable: 0,
              room_snapshot_missing_creep_memory: 0,
              task_assignment_not_observed: 1
            },
            idleWorkers: [
              {
                reason: 'task_assignment_not_observed',
                carriedEnergy: 20,
                freeCapacity: 0
              }
            ]
          },
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
            pickup: 0,
            withdraw: 0,
            transfer: 0,
            build: 0,
            repair: 0,
            upgrade: 0
          },
          constructionSiteCount: 0,
          constructionDeadlockTicks: 0,
          constructionActivity: {
            source: 'runtime-summary',
            state: 'active',
            accepted: true,
            reason: 'build_progress_observed',
            constructionSiteCount: 0,
            pendingBuildProgress: 0,
            buildCarriedEnergy: 0,
            buildProgress: 25,
            workerAssignmentEvidenceAvailable: true,
            buildBlockedReason: 'no_construction_sites',
            candidate: {
              buildItem: 'build rampart defense',
              room: 'W1N1',
              score: 49,
              urgency: 'critical'
            }
          },
          constructionScoring: {
            source: 'runtime-summary',
            loopRan: true,
            skipped: false,
            rawCandidateCount: 4,
            viableCandidateCount: 4,
            suppressedCandidateCount: 3,
            dominantSuppressionReason: 'lower_ranked_candidate',
            acceptedCandidateCount: 1,
            sitePlacementAttempted: false
          },
          structures: {
            towerCount: 0,
            rampartCount: 0,
            extensionCount: 0,
            extensionCapacityContribution: 0,
            containers: [],
            repairTargets: [],
            roadCount: 0,
            pendingRoadSiteCount: 0,
            roadCoverageRatio: 0
          },
          controller: {
            level: 2,
            progress: DEFAULT_TEST_CONTROLLER_PROGRESS,
            progressTotal: DEFAULT_TEST_CONTROLLER_PROGRESS_TOTAL,
            progressRatio: roundTestRatio(DEFAULT_TEST_CONTROLLER_PROGRESS, DEFAULT_TEST_CONTROLLER_PROGRESS_TOTAL),
            ticksToDowngrade: 15000,
            sign: null
          },
          resources: {
            storedEnergy: 250,
            workerCarriedEnergy: 60,
            harvestedThisTick: 10,
            droppedEnergy: 25,
            sourceCount: 2,
            sourceContainers: {
              sourceCount: 2,
              sourcesWithContainers: 0,
              sourcesWithContainerSites: 0,
              sourcesMissingContainers: 2
            },
            productiveEnergy: {
              workerAssignmentEvidenceAvailable: true,
              assignedWorkerCount: 0,
              assignedCarriedEnergy: 0,
              buildCarriedEnergy: 0,
              repairCarriedEnergy: 0,
              upgradeCarriedEnergy: 0,
              constructionSiteCount: 0,
              constructionDeadlockTicks: 0,
              pendingBuildProgress: 0,
              constructionActivity: {
                source: 'runtime-summary',
                state: 'active',
                accepted: true,
                reason: 'build_progress_observed',
                constructionSiteCount: 0,
                pendingBuildProgress: 0,
                buildCarriedEnergy: 0,
                buildProgress: 25,
                workerAssignmentEvidenceAvailable: true,
                buildBlockedReason: 'no_construction_sites',
                candidate: {
                  buildItem: 'build rampart defense',
                  room: 'W1N1',
                  score: 49,
                  urgency: 'critical'
                }
              },
              repairBacklogHits: 0,
              buildBlockedReason: 'no_construction_sites',
              controllerProgressRemaining: 43766
            },
            energySurplus: {
              surplus: false,
              spawnExtensionsFull: false,
              containersFull: true,
              reservedSpawnEnergy: 0,
              unmetSpawnEnergyReservation: 0,
              spawnExtensionFreeCapacity: 50,
              containerFreeCapacity: 0,
              durableFreeCapacity: 0,
              storageEnergy: 125,
              storageFreeCapacity: 0,
              terminalEnergy: 0,
              terminalFreeCapacity: 0,
              terminalTargetEnergy: 0,
              terminalEnergyDeficit: 0,
              terminalEnergySurplus: 0,
              routedWorkerCount: 0,
              routedCarriedEnergy: 0
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
          workerLoadEfficiency: {
            sampleCount: 0,
            tripEnergyMean: null,
            tripEnergyMin: null,
            unavailableReason: 'recent_worker_efficiency_sample_missing'
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
              },
              {
                buildItem: 'build source/controller roads',
                room: 'W1N1',
                score: 21,
                urgency: 'low',
                preconditions: [],
                expectedKpiMovement: [
                  'reduces worker travel time',
                  'improves harvest-to-spawn throughput'
                ],
                risk: ['road decay creates recurring repair load']
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
            suppressionReasons: ['bootstrapWorkerFloor', 'spawnEnergyCritical'],
            defenseFloor: {
              ready: true,
              assessable: true,
              rcl: 2,
              anchorReady: true,
              towerReady: true,
              towerCount: 0,
              pendingTowerCount: 0,
              spawnRampartReady: false,
              wallAnchorCount: 0,
              requiredWallAnchorCount: 0,
              missingAnchorCount: 0,
              repairHitsCeiling: 25_000
            }
          },
          territoryExpansionProgress: {
            colony: 'W1N1',
            source: 'runtime-summary',
            updatedAt: RUNTIME_SUMMARY_INTERVAL,
            territoryCapable: false,
            blocker: 'roomLimitReached',
            blockerSource: 'capacity',
            ownedRoomCount: 1,
            roomCapacityStatus: 'roomLimitReached',
            roomLimitCapacity: 1,
            rclRoomLimitCapacity: 1,
            roomLimitBasis: 'rclPolicy',
            activePipelineStateKey: 'pipeline:none',
            controlCounts: {
              active: { claim: 0, reserve: 0, scout: 0 },
              planned: { claim: 0, reserve: 0, scout: 0 },
              targets: { claim: 0, reserve: 0 }
            }
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

  it('reports assessable bootstrap defense floor telemetry before anchors exist', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N55',
      structures: [
        {
          id: 'spawn1',
          structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
          my: true,
          pos: { x: 17, y: 24, roomName: 'E29N55' },
          store: makeEnergyStore(50)
        }
      ]
    });

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<{ survival: { defenseFloor: { missingAnchorCount: number } } }>;
    expect(room.survival.defenseFloor).toMatchObject({
      ready: false,
      assessable: true,
      rcl: 2,
      anchorReady: false,
      towerReady: true,
      towerCount: 0,
      pendingTowerCount: 0
    });
    expect(room.survival.defenseFloor.missingAnchorCount).toBeGreaterThan(0);
  });

  it('does not emit on non-cadence ticks without events', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL + 1 });

    emitRuntimeSummary([colony], []);

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('emits compact healthy CPU evidence on the short CPU cadence without a full room summary', () => {
    const colony = makeColony({ time: 5 });

    emitRuntimeSummary([colony], []);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(typeof message).toBe('string');
    expect((message as string).startsWith(RUNTIME_CPU_SUMMARY_PREFIX)).toBe(true);
    const payload = JSON.parse((message as string).slice(RUNTIME_CPU_SUMMARY_PREFIX.length)) as Record<string, unknown>;
    expect(payload).toEqual({
      used: 4.2,
      bucket: 9000
    });
  });

  it('emits low-bucket runtime evidence when compact CPU evidence is emitted on the short CPU cadence', () => {
    const worker = makeWorker(
      { role: 'worker', colony: 'W1N1', task: { type: 'build', targetId: 'site1' as Id<ConstructionSite> } },
      40,
      'Builder1'
    );
    const colony = makeColony({
      time: 5,
      constructionSites: [{ id: 'site1', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION }],
      creeps: [worker]
    });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(18),
      limit: 70,
      bucket: 998,
      tickLimit: 500
    } as unknown as CPU;

    emitRuntimeSummary([colony], [worker]);

    const messages = logSpy.mock.calls.map(([message]) => message).filter((message): message is string =>
      typeof message === 'string'
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].startsWith(RUNTIME_CPU_SUMMARY_PREFIX)).toBe(true);
    expect(messages[1].startsWith(RUNTIME_SUMMARY_PREFIX)).toBe(true);
    const payload = JSON.parse(messages[1].slice(RUNTIME_SUMMARY_PREFIX.length)) as Record<string, unknown>;
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const resources = room.resources as Record<string, unknown>;
    const productiveEnergy = resources.productiveEnergy as Record<string, unknown>;

    expect(payload.cpu).toMatchObject({
      used: 18,
      limit: 70,
      tickLimit: 500,
      bucket: 998,
      pressure: 'degraded',
      reasons: ['lowBucket']
    });
    expect(room.taskCounts).toMatchObject({ build: 1 });
    expect(room.constructionActivity).toMatchObject({
      source: 'runtime-summary',
      constructionSiteCount: 1
    });
    expect(typeof resources.storedEnergy).toBe('number');
    expect(resources).toMatchObject({
      workerCarriedEnergy: 40,
      harvestedThisTick: 10
    });
    expect(productiveEnergy).toMatchObject({
      buildCarriedEnergy: 40,
      constructionSiteCount: 1,
      constructionActivity: expect.objectContaining({ source: 'runtime-summary' })
    });
  });

  it('emits low-bucket recovery deltas in compact CPU evidence', () => {
    const firstColony = makeColony({ time: 4 });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(13.3),
      limit: 70,
      bucket: 1_007,
      tickLimit: 500
    } as unknown as CPU;
    emitRuntimeSummary([firstColony], []);
    logSpy.mockClear();

    const secondColony = makeColony({ time: 5 });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(17.558327400009148),
      limit: 70,
      bucket: 1_004,
      tickLimit: 500
    } as unknown as CPU;

    emitRuntimeSummary([secondColony], []);

    const cpuSummaryMessages = logSpy.mock.calls
      .map(([message]) => message)
      .filter(
        (message): message is string =>
          typeof message === 'string' && message.startsWith(RUNTIME_CPU_SUMMARY_PREFIX)
      );
    expect(cpuSummaryMessages).toHaveLength(1);
    const payload = JSON.parse(cpuSummaryMessages[0].slice(RUNTIME_CPU_SUMMARY_PREFIX.length)) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      tick: 5,
      used: 17.558327400009148,
      limit: 70,
      tickLimit: 500,
      bucket: 1_004,
      pressure: 'degraded',
      reasons: ['lowBucketRecovery'],
      bucketDelta: -3,
      bucketDeltaTicks: 1,
      bucketDeltaPerTick: -3,
      projectedBucket: 1_056.442
    });
  });

  it('emits compact CPU alerts without a full room summary under degraded cadence', () => {
    const colony = makeColony({ time: 1 });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(24),
      limit: 20,
      bucket: 0,
      tickLimit: 500
    } as unknown as CPU;

    emitRuntimeSummary([colony], []);
    logSpy.mockClear();
    (Game as Partial<Game>).time = 2;

    emitRuntimeSummary([colony], []);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(typeof message).toBe('string');
    expect((message as string).startsWith(RUNTIME_CPU_SUMMARY_PREFIX)).toBe(true);
    const payload = JSON.parse((message as string).slice(RUNTIME_CPU_SUMMARY_PREFIX.length)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      used: 24,
      limit: 20,
      tickLimit: 500,
      bucket: 0,
      pressure: 'critical',
      lowBucketTicks: 2,
      bucketEmptyTicks: 2,
      overLimitTicks: 2,
      alerts: expect.arrayContaining(['bucketEmptyRepeated', 'lowBucket', 'sustainedUsedOverLimit'])
    });
  });

  it('does not repeat unchanged compact CPU alerts every tick', () => {
    const colony = makeColony({ time: 1 });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(24),
      limit: 20,
      bucket: 0,
      tickLimit: 500
    } as unknown as CPU;

    emitRuntimeSummary([colony], []);
    (Game as Partial<Game>).time = 2;
    emitRuntimeSummary([colony], []);
    logSpy.mockClear();
    (Game as Partial<Game>).time = 3;

    emitRuntimeSummary([colony], []);

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('suppresses full cadence summaries while the CPU bucket is critical', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL * 5 });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(24),
      limit: 70,
      bucket: 43,
      tickLimit: 63
    } as unknown as CPU;

    emitRuntimeSummary([colony], []);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [message] = logSpy.mock.calls[0];
    expect(typeof message).toBe('string');
    expect((message as string).startsWith(RUNTIME_CPU_SUMMARY_PREFIX)).toBe(true);
  });

  it('emits damage-only critical defense summaries while the CPU bucket is critical', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const damageOnlyDefenseEvent: RuntimeTelemetryEvent = {
      type: 'defense',
      action: 'workerFallback',
      roomName: 'W1N1',
      reason: 'workerEmergencyFallback',
      hostileCreepCount: 0,
      hostileStructureCount: 0,
      damagedCriticalStructureCount: 1,
      tick: RUNTIME_SUMMARY_INTERVAL
    };
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(24),
      limit: 70,
      bucket: 43,
      tickLimit: 63
    } as unknown as CPU;

    emitRuntimeSummary([colony], [], [damageOnlyDefenseEvent]);

    const payload = parseLoggedSummary();
    expect(payload.events).toEqual([damageOnlyDefenseEvent]);
  });

  it('omits optional room telemetry from degraded-cadence summaries during low-bucket recovery', () => {
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> },
        behaviorTelemetry: {
          idleTicks: 1,
          moveTicks: 0,
          workTicks: 0,
          stuckTicks: 0,
          containerTransfers: 0,
          sourceContainerWithdrawals: 0,
          pathLength: 0,
          lastObservedTick: RUNTIME_SUMMARY_INTERVAL * 5
        },
        workerEfficiency: {
          type: 'nearbyEnergyChoice',
          tick: RUNTIME_SUMMARY_INTERVAL * 5,
          carriedEnergy: 5,
          freeCapacity: 45,
          selectedTask: 'pickup',
          targetId: 'drop-1',
          energy: 50,
          range: 1
        },
        refillTelemetry: {
          recentDeliveries: [
            {
              tick: RUNTIME_SUMMARY_INTERVAL * 5,
              targetId: 'spawn1',
              deliveryTicks: 4,
              activeTicks: 3,
              idleOrOtherTaskTicks: 1,
              energyDelivered: 20
            }
          ],
          refillActiveTicks: 3,
          idleOrOtherTaskTicks: 1,
          lastUpdatedAt: RUNTIME_SUMMARY_INTERVAL * 5
        }
      },
      5,
      'Worker1'
    );
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL * 5,
      creeps: [worker]
    });
    const onStrategyRegistryRuntimeUse = jest.fn();
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(18),
      limit: 70,
      bucket: 500,
      tickLimit: 500
    } as unknown as CPU;

    emitRuntimeSummary([colony], [worker], [], {
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      onStrategyRegistryRuntimeUse
    });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionPriority).toEqual({ candidates: [], nextPrimary: null });
    expect(room.constructionScoring).toEqual({
      source: 'runtime-summary',
      loopRan: false,
      skipped: true,
      skipReason: 'lowBucket',
      rawCandidateCount: 0,
      viableCandidateCount: 0,
      suppressedCandidateCount: 0,
      acceptedCandidateCount: 0,
      sitePlacementAttempted: false
    });
    expect(room.territoryExpansion).toBeUndefined();
    expect(room.behavior).toBeUndefined();
    expect(room.workerEfficiency).toBeUndefined();
    expect(room.workerLoadEfficiency).toEqual({
      sampleCount: 0,
      tripEnergyMean: null,
      tripEnergyMin: null,
      unavailableReason: 'optional_summary_suppressed_by_cpu'
    });
    expect(room.refillDeliveryTicks).toBeUndefined();
    expect(room.refillWorkerUtilization).toBeUndefined();
    expect(room.workerEnergyThroughput).toBeUndefined();
    expect(onStrategyRegistryRuntimeUse).not.toHaveBeenCalled();
  });

  it('reports construction scoring during safe low-bucket CPU recovery', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL * 5,
      includeEventLog: false
    });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(18),
      limit: 70,
      bucket: 1_100,
      tickLimit: 500
    } as unknown as CPU;

    emitRuntimeSummary([colony], [], [], {
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY
    });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionPriority).toMatchObject({
      nextPrimary: {
        buildItem: 'build rampart defense',
        room: 'W1N1',
        urgency: 'critical'
      }
    });
    expect(room.constructionScoring).toEqual({
      source: 'runtime-summary',
      loopRan: true,
      skipped: false,
      rawCandidateCount: 4,
      viableCandidateCount: 4,
      suppressedCandidateCount: 3,
      dominantSuppressionReason: 'lower_ranked_candidate',
      acceptedCandidateCount: 1,
      sitePlacementAttempted: false
    });
  });

  it('omits optional room telemetry after the current tick exceeds its CPU limit', () => {
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'harvest', targetId: 'source1' as Id<Source> },
        behaviorTelemetry: {
          idleTicks: 1,
          moveTicks: 0,
          workTicks: 0,
          stuckTicks: 0,
          containerTransfers: 0,
          sourceContainerWithdrawals: 0,
          pathLength: 0,
          lastObservedTick: RUNTIME_SUMMARY_INTERVAL * 5
        },
        workerEfficiency: {
          type: 'nearbyEnergyChoice',
          tick: RUNTIME_SUMMARY_INTERVAL * 5,
          carriedEnergy: 5,
          freeCapacity: 45,
          selectedTask: 'pickup',
          targetId: 'drop-1',
          energy: 50,
          range: 1
        }
      },
      5,
      'Worker1'
    );
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL * 5,
      creeps: [worker]
    });
    const onStrategyRegistryRuntimeUse = jest.fn();
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(71),
      limit: 70,
      bucket: 9_000,
      tickLimit: 500
    } as unknown as CPU;

    emitRuntimeSummary([colony], [worker], [], {
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      onStrategyRegistryRuntimeUse
    });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionPriority).toEqual({ candidates: [], nextPrimary: null });
    expect(room.constructionScoring).toEqual({
      source: 'runtime-summary',
      loopRan: false,
      skipped: true,
      skipReason: 'usedOverLimit',
      rawCandidateCount: 0,
      viableCandidateCount: 0,
      suppressedCandidateCount: 0,
      acceptedCandidateCount: 0,
      sitePlacementAttempted: false
    });
    expect(room.territoryExpansion).toBeUndefined();
    expect(room.behavior).toBeUndefined();
    expect(room.workerEfficiency).toBeUndefined();
    expect(onStrategyRegistryRuntimeUse).not.toHaveBeenCalled();
  });

  it('reports per-creep behavior counters and resets emitted counters', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'repair', targetId: 'road-damaged' as Id<Structure> },
        behaviorTelemetry: {
          idleTicks: 1,
          moveTicks: 3,
          workTicks: 2,
          stuckTicks: 1,
          containerTransfers: 1,
          sourceContainerWithdrawals: 2,
          pathLength: 2,
          repairTargetId: 'road-damaged',
          lastPosition: { x: 10, y: 12, roomName: 'W1N1' },
          lastMoveTick: RUNTIME_SUMMARY_INTERVAL,
          lastObservedTick: RUNTIME_SUMMARY_INTERVAL
        }
      },
      20,
      'RepairWorker'
    );

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.behavior).toEqual({
      creeps: [
        {
          creepName: 'RepairWorker',
          idleTicks: 1,
          moveTicks: 3,
          workTicks: 2,
          stuckTicks: 1,
          pathFindingFailures: 0,
          destinationBlocked: 0,
          containerTransfers: 1,
          sourceContainerWithdrawals: 2,
          pathLength: 2,
          repairTargetId: 'road-damaged'
        }
      ],
      totals: {
        idleTicks: 1,
        moveTicks: 3,
        workTicks: 2,
        stuckTicks: 1,
        pathFindingFailures: 0,
        destinationBlocked: 0,
        containerTransfers: 1,
        sourceContainerWithdrawals: 2,
        pathLength: 2
      },
      topIdleWorkers: [
        {
          creepName: 'RepairWorker',
          idleTicks: 1,
          moveTicks: 3,
          workTicks: 2,
          stuckTicks: 1,
          pathFindingFailures: 0,
          destinationBlocked: 0,
          containerTransfers: 1,
          sourceContainerWithdrawals: 2,
          pathLength: 2,
          repairTargetId: 'road-damaged'
        }
      ]
    });
    expect(worker.memory.behaviorTelemetry).toEqual({
      lastPosition: { x: 10, y: 12, roomName: 'W1N1' },
      lastMoveTick: RUNTIME_SUMMARY_INTERVAL,
      lastObservedTick: RUNTIME_SUMMARY_INTERVAL
    });
  });

  it('populates behavior summary after simulateWorkerIdle and reports the top idle workers', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const workers = [
      makeWorker({ role: 'worker', colony: 'W1N1' }, 0, 'IdleA'),
      makeWorker({ role: 'worker', colony: 'W1N1' }, 0, 'IdleB'),
      makeWorker({ role: 'worker', colony: 'W1N1' }, 0, 'IdleC'),
      makeWorker({ role: 'worker', colony: 'W1N1' }, 0, 'IdleD')
    ];

    simulateWorkerIdle(workers[0], 4);
    simulateWorkerIdle(workers[1], 2);
    simulateWorkerIdle(workers[2], 3);
    simulateWorkerIdle(workers[3], 1);

    emitRuntimeSummary([colony], workers);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.behavior).toEqual({
      creeps: [
        makeIdleBehaviorSummary('IdleA', 4),
        makeIdleBehaviorSummary('IdleB', 2),
        makeIdleBehaviorSummary('IdleC', 3),
        makeIdleBehaviorSummary('IdleD', 1)
      ],
      totals: {
        idleTicks: 10,
        moveTicks: 0,
        workTicks: 0,
        stuckTicks: 0,
        pathFindingFailures: 0,
        destinationBlocked: 0,
        containerTransfers: 0,
        sourceContainerWithdrawals: 0,
        pathLength: 0
      },
      topIdleWorkers: [
        makeIdleBehaviorSummary('IdleA', 4),
        makeIdleBehaviorSummary('IdleC', 3),
        makeIdleBehaviorSummary('IdleB', 2)
      ]
    });
    expect(workers.map((worker) => worker.memory.behaviorTelemetry)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('infers path finding failures and blocked destinations from stuck no-work behavior', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        behaviorTelemetry: {
          moveTicks: 3,
          workTicks: 0,
          stuckTicks: 3
        }
      },
      0,
      'BlockedWorker'
    );

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const behavior = room.behavior as Record<string, unknown>;
    const totals = behavior.totals as Record<string, unknown>;
    expect(totals.pathFindingFailures).toBe(3);
    expect(totals.destinationBlocked).toBe(1);
    expect((behavior.creeps as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
      creepName: 'BlockedWorker',
      pathFindingFailures: 3,
      destinationBlocked: 1
    });
  });

  it('separates one-source RCL3 congestion from actual moveTo ERR_NO_PATH and transient dropped energy', () => {
    const roomName = 'E29N56';
    const source = {
      id: 'source-e29n56',
      pos: { x: 12, y: 20, roomName } as RoomPosition
    } as Source;
    const sourceContainer = {
      id: 'container-e29n56',
      structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
      pos: { x: 12, y: 21, roomName } as RoomPosition,
      store: makeEnergyStore(400, 2000)
    } as unknown as StructureContainer;
    const droppedEnergy = {
      id: 'drop-e29n56',
      resourceType: TEST_GLOBALS.RESOURCE_ENERGY,
      amount: 141
    };
    const harvester = makeWorker(
      {
        role: 'worker',
        colony: roomName,
        task: { type: 'harvest', targetId: source.id as Id<Source> },
        behaviorTelemetry: {
          workTicks: 1,
          energyAcquisitionHarvested: 1
        }
      },
      0,
      'E29N56-Harvester'
    );
    const upgrader = makeWorker(
      {
        role: 'worker',
        colony: roomName,
        task: { type: 'upgrade', targetId: 'controller-e29n56' as Id<StructureController> },
        behaviorTelemetry: {
          moveTicks: 2,
          workTicks: 0,
          stuckTicks: 2,
          moveToAttempts: 2,
          moveToFailures: 0,
          moveToErrNoPath: 0,
          lastMoveToResult: 0,
          lastMoveToTask: 'upgrade',
          lastMoveToTargetId: 'controller-e29n56',
          lastMoveToRange: 3
        }
      },
      50,
      'E29N56-Upgrader'
    );
    const workers = [harvester, upgrader];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName,
      controllerLevel: 3,
      sources: [source],
      structures: [sourceContainer],
      creeps: workers,
      droppedResources: [droppedEnergy],
      includeEventLog: false
    });

    emitRuntimeSummary([colony], workers);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const behavior = room.behavior as Record<string, unknown>;
    const totals = behavior.totals as Record<string, unknown>;
    const resources = room.resources as Record<string, unknown>;
    expect(room.controller).toMatchObject({ level: 3 });
    expect(resources).toMatchObject({
      droppedEnergy: 141,
      sourceCount: 1,
      sourceContainers: {
        sourceCount: 1,
        sourcesWithContainers: 1,
        sourcesWithContainerSites: 0,
        sourcesMissingContainers: 0
      }
    });
    expect(totals).toMatchObject({
      moveTicks: 2,
      workTicks: 1,
      stuckTicks: 2,
      pathFindingFailures: 2,
      destinationBlocked: 1,
      moveTo: {
        attempts: 2,
        failures: 0,
        errNoPath: 0
      }
    });
    const creeps = behavior.creeps as Array<Record<string, unknown>>;
    expect(creeps.find((creep) => creep.creepName === 'E29N56-Upgrader')).toMatchObject({
      pathFindingFailures: 2,
      destinationBlocked: 1,
      moveTo: {
        attempts: 2,
        failures: 0,
        errNoPath: 0,
        lastResult: 0,
        lastTask: 'upgrade',
        lastTargetId: 'controller-e29n56',
        lastRange: 3
      }
    });

    logSpy.mockClear();
    const recoveredColony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL * 2,
      roomName,
      controllerLevel: 3,
      sources: [source],
      structures: [sourceContainer],
      creeps: workers,
      droppedResources: [],
      includeEventLog: false
    });

    emitRuntimeSummary([recoveredColony], workers);

    const recoveredPayload = parseLoggedSummary();
    const [recoveredRoom] = recoveredPayload.rooms as Array<Record<string, unknown>>;
    expect((recoveredRoom.resources as Record<string, unknown>).droppedEnergy).toBe(0);
  });

  it('reports actual moveTo ERR_NO_PATH context separately from inferred stuck counters', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        behaviorTelemetry: {
          moveTicks: 1,
          workTicks: 0,
          stuckTicks: 1,
          moveToAttempts: 1,
          moveToFailures: 1,
          moveToErrNoPath: 1,
          lastMoveToResult: -2,
          lastMoveToTask: 'harvest',
          lastMoveToTargetId: 'source1',
          lastMoveToRange: 1
        }
      },
      0,
      'NoPathWorker'
    );

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const behavior = room.behavior as Record<string, unknown>;
    const totals = behavior.totals as Record<string, unknown>;
    expect(totals).toMatchObject({
      pathFindingFailures: 1,
      destinationBlocked: 1,
      moveTo: {
        attempts: 1,
        failures: 1,
        errNoPath: 1
      }
    });
    expect((behavior.creeps as Array<Record<string, unknown>>)[0]).toMatchObject({
      creepName: 'NoPathWorker',
      moveTo: {
        attempts: 1,
        failures: 1,
        errNoPath: 1,
        lastResult: -2,
        lastTask: 'harvest',
        lastTargetId: 'source1',
        lastRange: 1
      }
    });
  });

  it('keeps moveTo counters when persistent memory lacks a last moveTo result', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        behaviorTelemetry: {
          moveToAttempts: 2,
          moveToFailures: 1,
          moveToErrNoPath: 1
        }
      },
      0,
      'StaleMoveToWorker'
    );

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const behavior = room.behavior as Record<string, unknown>;
    const totals = behavior.totals as Record<string, unknown>;
    expect(totals).toMatchObject({
      moveTo: {
        attempts: 2,
        failures: 1,
        errNoPath: 1
      }
    });
    expect((behavior.creeps as Array<Record<string, unknown>>)[0]).toMatchObject({
      creepName: 'StaleMoveToWorker',
      moveTo: {
        attempts: 2,
        failures: 1,
        errNoPath: 1
      }
    });
    expect(((behavior.creeps as Array<Record<string, unknown>>)[0].moveTo as Record<string, unknown>).lastResult)
      .toBeUndefined();
  });

  it('reports energy acquisition method distribution across workers and haulers', () => {
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        behaviorTelemetry: {
          energyAcquisitionHarvested: 1,
          energyAcquisitionPickedUp: 2
        }
      },
      0,
      'AcquireWorker'
    );
    const hauler = makeWorker(
      {
        role: 'hauler',
        colony: 'W1N1',
        behaviorTelemetry: {
          energyAcquisitionWithdrawn: 3
        }
      },
      0,
      'AcquireHauler'
    );
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      creeps: [worker, hauler]
    });

    emitRuntimeSummary([colony], [worker, hauler]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const behavior = room.behavior as Record<string, unknown>;
    const totals = behavior.totals as Record<string, unknown>;
    expect(totals.energyAcquisition).toEqual({ harvested: 1, pickedUp: 2, withdrawn: 3 });
    expect((behavior.creeps as Array<Record<string, unknown>>).map((creep) => creep.creepName)).toEqual([
      'AcquireHauler',
      'AcquireWorker'
    ]);
    expect(worker.memory.behaviorTelemetry).toBeUndefined();
    expect(hauler.memory.behaviorTelemetry).toBeUndefined();
  });

  it('reports cadence structure snapshots with defenses, containers, repairs, and road coverage', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      structures: [
        { id: 'tower1', structureType: TEST_GLOBALS.STRUCTURE_TOWER },
        { id: 'rampart1', structureType: TEST_GLOBALS.STRUCTURE_RAMPART, my: true },
        { id: 'enemy-rampart', structureType: TEST_GLOBALS.STRUCTURE_RAMPART, my: false },
        { id: 'extension1', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, store: makeEnergyStore(50, 50) },
        { id: 'container-b', structureType: TEST_GLOBALS.STRUCTURE_CONTAINER, store: makeEnergyStore(400, 2000) },
        { id: 'container-a', structureType: TEST_GLOBALS.STRUCTURE_CONTAINER, store: makeEnergyStore(50, 2000) },
        { id: 'road-damaged', structureType: TEST_GLOBALS.STRUCTURE_ROAD, hits: 1000, hitsMax: 5000 },
        { id: 'road-full', structureType: TEST_GLOBALS.STRUCTURE_ROAD, hits: 5000, hitsMax: 5000 }
      ],
      constructionSites: [
        { id: 'road-site', structureType: TEST_GLOBALS.STRUCTURE_ROAD },
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION }
      ]
    });
    const workers = [
      makeWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'repair', targetId: 'road-damaged' as Id<Structure> } },
        10,
        'RepairerA'
      ),
      makeWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'repair', targetId: 'road-damaged' as Id<Structure> } },
        10,
        'RepairerB'
      )
    ];

    emitRuntimeSummary([colony], workers, [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.structures).toEqual({
      towerCount: 1,
      rampartCount: 1,
      extensionCount: 1,
      extensionCapacityContribution: 50,
      containers: [
        { id: 'container-a', energy: 50, capacity: 2000 },
        { id: 'container-b', energy: 400, capacity: 2000 }
      ],
      repairTargets: [
        {
          targetId: 'road-damaged',
          repairCount: 2,
          structureType: TEST_GLOBALS.STRUCTURE_ROAD,
          hits: 1000,
          hitsMax: 5000
        }
      ],
      roadCount: 2,
      pendingRoadSiteCount: 1,
      roadCoverageRatio: 0.667
    });
  });

  it('reports source container coverage in room resource telemetry', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      sources: [
        { id: 'source-with-container', pos: { x: 10, y: 10, roomName: 'W1N1' } },
        { id: 'source-with-site', pos: { x: 20, y: 20, roomName: 'W1N1' } },
        { id: 'source-missing', pos: { x: 30, y: 30, roomName: 'W1N1' } }
      ],
      structures: [
        {
          id: 'container1',
          structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
          pos: { x: 10, y: 11, roomName: 'W1N1' },
          store: makeEnergyStore(100, 2000)
        }
      ],
      constructionSites: [
        {
          id: 'container-site1',
          structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
          pos: { x: 21, y: 20, roomName: 'W1N1' }
        }
      ]
    });

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect((room.resources as Record<string, unknown>).sourceContainers).toEqual({
      sourceCount: 3,
      sourcesWithContainers: 1,
      sourcesWithContainerSites: 1,
      sourcesMissingContainers: 1
    });
  });

  it('reports E18S59 post-claim construction, energy, and defense progress after worker readiness', () => {
    const remoteHarvester = makeWorker({
      role: 'remoteHarvester',
      colony: 'E17S59',
      remoteHarvester: {
        homeRoom: 'E17S59',
        targetRoom: 'E18S59',
        sourceId: 'e18s59-source-a' as Id<Source>
      }
    });
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E18S59',
      includeEventLog: false,
      sources: [
        {
          id: 'e18s59-source-a',
          pos: { x: 10, y: 10, roomName: 'E18S59' }
        }
      ],
      structures: [
        {
          id: 'spawn-e18s59',
          structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
          store: makeEnergyStore(50, 300)
        },
        {
          id: 'container-e18s59-a',
          structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
          pos: { x: 10, y: 11, roomName: 'E18S59' },
          store: makeEnergyStore(400, 2000)
        }
      ],
      constructionSites: [
        {
          id: 'tower-site-e18s59',
          structureType: TEST_GLOBALS.STRUCTURE_TOWER,
          pos: { x: 24, y: 24, roomName: 'E18S59' }
        },
        {
          id: 'rampart-site-e18s59',
          structureType: TEST_GLOBALS.STRUCTURE_RAMPART,
          pos: { x: 25, y: 1, roomName: 'E18S59' }
        }
      ],
      creeps: [remoteHarvester]
    });
    (colony.room.controller as StructureController).level = 3;
    (colony.room.controller as StructureController).pos = { x: 25, y: 25, roomName: 'E18S59' } as RoomPosition;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        postClaimBootstraps: {
          E18S59: {
            colony: 'E17S59',
            roomName: 'E18S59',
            status: 'ready',
            claimedAt: 837,
            updatedAt: 838,
            workerTarget: 2,
            controllerId: 'controller-e18s59' as Id<StructureController>
          }
        },
        claimedRoomBootstrapper: {
          rooms: {
            E18S59: {
              roomName: 'E18S59',
              owned: true,
              claimedAt: 837,
              updatedAt: 838
            }
          }
        }
      }
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game.map = {
      describeExits: jest.fn(() => ({ '5': 'E17S59' }))
    } as unknown as GameMap;
    (globalThis as unknown as { Game: Partial<Game> }).Game.creeps = {
      RemoteHarvester: remoteHarvester
    };

    emitRuntimeSummary([colony], [remoteHarvester], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.postClaimBootstrap).toMatchObject({
      colony: 'E17S59',
      status: 'ready',
      controllerId: 'controller-e18s59',
      progress: {
        construction: {
          priorityOrder: ['spawn', 'extension', 'container', 'road', 'tower', 'rampart', 'storage'],
          sourceContainers: {
            existing: 1,
            pending: 0,
            coveredSources: 1,
            complete: true
          },
          towers: {
            existing: 0,
            pending: 1,
            target: 1,
            complete: true
          },
          ramparts: {
            existing: 0,
            pending: 1
          }
        },
        energy: {
          sourceCount: 1,
          coveredSourceCount: 1,
          sourceContainerCount: 1,
          pendingSourceContainerCount: 0,
          assignedHarvesterCount: 1,
          localStoredEnergy: 450
        },
        defense: {
          towerCount: 0,
          pendingTowerCount: 1,
          towerTarget: 1,
          rampartCount: 0,
          pendingRampartCount: 1,
          nextBarrierStage: 'entranceRampart'
        }
      }
    });
  });

  it('omits structure snapshots from event-only non-cadence summaries', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL + 1,
      structures: [{ id: 'tower1', structureType: TEST_GLOBALS.STRUCTURE_TOWER }]
    });

    emitRuntimeSummary(
      [colony],
      [],
      [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-event',
          role: 'worker',
          result: 0 as ScreepsReturnCode
        }
      ],
      { persistOccupationRecommendations: false }
    );

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.structures).toBeUndefined();
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

    expect(
      logSpy.mock.calls.every(([message]) =>
        typeof message === 'string' && message.startsWith(RUNTIME_CPU_SUMMARY_PREFIX)
      )
    ).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(roomFind).toHaveBeenCalledTimes(RUNTIME_SUMMARY_INTERVAL - 1);
    expect(roomFind.mock.calls.every(([findType]) => findType === TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES)).toBe(true);
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
          hits: 121_001,
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
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(productiveEnergy).toMatchObject({
      workerAssignmentEvidenceAvailable: true,
      assignedWorkerCount: 3,
      assignedCarriedEnergy: 70,
      buildCarriedEnergy: 40,
      repairCarriedEnergy: 20,
      upgradeCarriedEnergy: 10,
      constructionSiteCount: 2,
      constructionDeadlockTicks: 0,
      pendingBuildProgress: 95,
      repairBacklogHits: 33099,
      controllerProgressRemaining: 43766
    });
    expect(productiveEnergy.constructionActivity).toMatchObject({
      source: 'runtime-summary',
      state: 'active',
      accepted: true,
      reason: 'build_energy_carried',
      constructionSiteCount: 2,
      pendingBuildProgress: 95,
      buildCarriedEnergy: 40,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true
    });
  });

  it('emits build action result telemetry with room counts and worker classifications', () => {
    const workers = [
      makeWorker(
        {
          role: 'worker',
          colony: 'W1N1',
          buildActionTelemetry: {
            resultCounts: { succeeded: 1 },
            lastResult: 'succeeded',
            lastTargetId: 'site-success',
            lastTick: RUNTIME_SUMMARY_INTERVAL - 1
          }
        },
        0,
        'BuilderSuccess'
      ),
      makeWorker(
        {
          role: 'worker',
          colony: 'W1N1',
          buildActionTelemetry: {
            resultCounts: { failed_no_path: 2, suppressed_by_policy: 1 },
            lastResult: 'suppressed_by_policy',
            lastTargetId: 'site-blocked',
            lastTick: RUNTIME_SUMMARY_INTERVAL
          }
        },
        50,
        'BuilderBlocked'
      )
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      creeps: workers
    });

    emitRuntimeSummary([colony], workers);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.buildActionResult).toBe('failed_no_path');
    expect(room.buildFailCount).toBe(3);
    expect(room.buildSuppressedCount).toBe(1);
    expect(room.buildActionResultCounts).toEqual({
      succeeded: 1,
      failed_no_energy: 0,
      failed_no_work: 0,
      failed_no_path: 2,
      failed_site_invalid: 0,
      suppressed_by_policy: 1
    });
    expect(room.buildActionResults).toEqual({
      source: 'runtime-summary',
      buildActionResult: 'failed_no_path',
      actionCount: 4,
      buildFailCount: 3,
      suppressedCount: 1,
      resultCounts: {
        succeeded: 1,
        failed_no_energy: 0,
        failed_no_work: 0,
        failed_no_path: 2,
        failed_site_invalid: 0,
        suppressed_by_policy: 1
      },
      workers: [
        {
          name: 'BuilderBlocked',
          buildActionResult: 'suppressed_by_policy',
          actionCount: 3,
          buildFailCount: 3,
          suppressedCount: 1,
          resultCounts: {
            succeeded: 0,
            failed_no_energy: 0,
            failed_no_work: 0,
            failed_no_path: 2,
            failed_site_invalid: 0,
            suppressed_by_policy: 1
          },
          lastTargetId: 'site-blocked',
          lastTick: RUNTIME_SUMMARY_INTERVAL
        },
        {
          name: 'BuilderSuccess',
          buildActionResult: 'succeeded',
          actionCount: 1,
          buildFailCount: 0,
          suppressedCount: 0,
          resultCounts: {
            succeeded: 1,
            failed_no_energy: 0,
            failed_no_work: 0,
            failed_no_path: 0,
            failed_site_invalid: 0,
            suppressed_by_policy: 0
          },
          lastTargetId: 'site-success',
          lastTick: RUNTIME_SUMMARY_INTERVAL - 1
        }
      ]
    });
    expect(JSON.stringify(room.buildActionResults)).not.toMatch(/token|secret/i);
    expect(workers.map((worker) => worker.memory.buildActionTelemetry)).toEqual([undefined, undefined]);
  });

  it('tracks construction deadlock ticks and resets on build assignment or cleared sites', () => {
    const constructionSites = [
      { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      constructionSites
    });
    const idleWorker = makeWorker({ role: 'worker', colony: 'W1N1' }, 50, 'IdleWorker');

    emitRuntimeSummary([colony], [idleWorker], [], { persistOccupationRecommendations: false });

    let payload = parseLoggedSummary();
    let [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionSiteCount).toBe(1);
    expect(room.constructionDeadlockTicks).toBe(1);
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy).toMatchObject({
      constructionSiteCount: 1,
      constructionDeadlockTicks: 1,
      pendingBuildProgress: 50,
      buildCarriedEnergy: 0
    });

    logSpy.mockClear();
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = RUNTIME_SUMMARY_INTERVAL + 1;
    emitRuntimeSummary(
      [colony],
      [idleWorker],
      [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-event',
          role: 'worker',
          result: 0 as ScreepsReturnCode
        }
      ],
      { persistOccupationRecommendations: false }
    );

    payload = parseLoggedSummary();
    [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionDeadlockTicks).toBe(2);
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy.constructionDeadlockTicks).toBe(2);

    logSpy.mockClear();
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = RUNTIME_SUMMARY_INTERVAL + 2;
    emitRuntimeSummary(
      [colony],
      [
        makeWorker(
          { role: 'worker', colony: 'W1N1', task: { type: 'build', targetId: 'extension-site' as Id<ConstructionSite> } },
          50,
          'Builder'
        )
      ],
      [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-event',
          role: 'worker',
          result: 0 as ScreepsReturnCode
        }
      ],
      { persistOccupationRecommendations: false }
    );

    payload = parseLoggedSummary();
    [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.taskCounts).toMatchObject({ build: 1 });
    expect(room.constructionDeadlockTicks).toBe(0);
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy.constructionDeadlockTicks).toBe(0);

    logSpy.mockClear();
    constructionSites.length = 0;
    (globalThis as unknown as { Game: Partial<Game> }).Game.time = RUNTIME_SUMMARY_INTERVAL + 3;
    emitRuntimeSummary(
      [colony],
      [idleWorker],
      [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-event',
          role: 'worker',
          result: 0 as ScreepsReturnCode
        }
      ],
      { persistOccupationRecommendations: false }
    );

    payload = parseLoggedSummary();
    [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionSiteCount).toBe(0);
    expect(room.constructionDeadlockTicks).toBe(0);
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy).toMatchObject({
      constructionSiteCount: 0,
      constructionDeadlockTicks: 0
    });
  });

  it('initializes construction deadlock memory through Memory.rooms when room memory is getter-only', () => {
    const constructionSites = [
      { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      constructionSites
    });
    const roomName = colony.room.name;
    delete (Memory.rooms as Record<string, RoomMemory | undefined>)[roomName];
    Object.defineProperty(colony.room, 'memory', {
      configurable: true,
      get: () => Memory.rooms[roomName]
    });

    expect(() =>
      emitRuntimeSummary(
        [colony],
        [makeWorker({ role: 'worker', colony: roomName }, 50, 'IdleWorker')],
        [],
        { persistOccupationRecommendations: false }
      )
    ).not.toThrow();

    expect(Memory.rooms[roomName]?.runtime).toEqual({
      constructionDeadlockTicks: 1,
      constructionDeadlockUpdatedAt: RUNTIME_SUMMARY_INTERVAL
    });
    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionDeadlockTicks).toBe(1);
  });

  it('reports build block reasons when construction backlog has no build work', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      constructionSites: [
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
      ]
    });

    emitRuntimeSummary([colony], [makeWorker({ role: 'worker', colony: 'W1N1' }, 50, 'UnassignedWorker')]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(productiveEnergy.buildBlockedReason).toBe('worker_assignment_gap');
    expect(productiveEnergy.constructionActivity).toMatchObject({
      state: 'candidate_suppressed',
      accepted: true,
      reason: 'worker_assignment_gap',
      constructionSiteCount: 1,
      pendingBuildProgress: 50,
      buildCarriedEnergy: 0,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true,
      buildBlockedReason: 'worker_assignment_gap'
    });
  });

  it('treats successful build actions as active construction evidence even after builders spend their energy', () => {
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'build', targetId: 'rampart-site' as Id<ConstructionSite> },
        buildActionTelemetry: {
          resultCounts: { succeeded: 15 },
          lastResult: 'succeeded',
          lastTargetId: 'rampart-site',
          lastTick: RUNTIME_SUMMARY_INTERVAL
        }
      },
      0,
      'SpentBuilder'
    );
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N55',
      includeEventLog: false,
      creeps: [worker],
      constructionSites: [
        { id: 'rampart-site', structureType: TEST_GLOBALS.STRUCTURE_RAMPART, progress: 265, progressTotal: 1_000 }
      ]
    });

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(room.taskCounts).toMatchObject({ build: 1 });
    expect(room.buildActionResultCounts).toMatchObject({ succeeded: 15 });
    expect(productiveEnergy).toMatchObject({
      constructionSiteCount: 1,
      pendingBuildProgress: 735,
      buildCarriedEnergy: 0
    });
    expect(productiveEnergy).not.toHaveProperty('buildBlockedReason');
    expect(productiveEnergy.constructionActivity).toMatchObject({
      state: 'active',
      accepted: true,
      reason: 'site_backlog_visible',
      constructionSiteCount: 1,
      pendingBuildProgress: 735,
      buildCarriedEnergy: 0,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true
    });
    expect(worker.memory.buildActionTelemetry).toBeUndefined();
  });

  it('marks construction activity as no viable candidate when no site or scored build candidate exists', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    (colony.room.controller as StructureController).level = 1;

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(room.constructionPriority).toMatchObject({
      nextPrimary: {
        buildItem: 'observe construction backlog',
        score: 0
      }
    });
    expect(room.constructionScoring).toEqual({
      source: 'runtime-summary',
      loopRan: true,
      skipped: false,
      rawCandidateCount: 0,
      viableCandidateCount: 0,
      suppressedCandidateCount: 0,
      acceptedCandidateCount: 0,
      sitePlacementAttempted: false
    });
    expect(room.constructionActivity).toEqual({
      source: 'runtime-summary',
      state: 'no_viable_candidate',
      accepted: false,
      reason: 'no_viable_candidate',
      constructionSiteCount: 0,
      pendingBuildProgress: 0,
      buildCarriedEnergy: 0,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true,
      buildBlockedReason: 'no_construction_sites'
    });
    expect(productiveEnergy.constructionActivity).toEqual(room.constructionActivity);
  });

  it('reports a construction planner blocker instead of a generic no viable candidate state', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    (colony.room.controller as StructureController).level = 1;

    emitRuntimeSummary(
      [colony],
      [],
      [
        {
          type: 'constructionPlacement',
          roomName: 'W1N1',
          priority: 'road',
          structureType: TEST_GLOBALS.STRUCTURE_ROAD,
          mode: 'normal',
          blockedReason: 'residual_road_seed_worker_coverage_missing',
          details: {
            workerCoverageCount: 0,
            workerCoverageMinimum: 1
          }
        }
      ]
    );

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(room.constructionActivity).toMatchObject({
      source: 'runtime-summary',
      state: 'planner_blocked',
      accepted: false,
      reason: 'planner_blocked',
      constructionSiteCount: 0,
      pendingBuildProgress: 0,
      buildCarriedEnergy: 0,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true,
      buildBlockedReason: 'no_construction_sites',
      planner: {
        mode: 'normal',
        priority: 'road',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        blockedReason: 'residual_road_seed_worker_coverage_missing',
        details: {
          workerCoverageCount: 0,
          workerCoverageMinimum: 1
        }
      }
    });
    expect(productiveEnergy.constructionActivity).toEqual(room.constructionActivity);
  });

  it('does not emit an immediate runtime summary for a normal construction planner blocker', () => {
    const colony = makeColony({
      time: 1,
      includeEventLog: false
    });

    const summary = emitRuntimeSummary(
      [colony],
      [],
      [
        {
          type: 'constructionPlacement',
          roomName: 'W1N1',
          priority: 'road',
          structureType: TEST_GLOBALS.STRUCTURE_ROAD,
          mode: 'normal',
          blockedReason: 'residual_road_seed_existing_site',
          details: { pendingConstructionSiteCount: 1 }
        }
      ]
    );

    expect(summary).toBeUndefined();
    expect(
      logSpy.mock.calls.some(
        ([message]) => typeof message === 'string' && message.startsWith(RUNTIME_SUMMARY_PREFIX)
      )
    ).toBe(false);
  });

  it('reports a successful construction placement as active while the new site is not yet visible', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });

    emitRuntimeSummary(
      [colony],
      [],
      [
        {
          type: 'constructionPlacement',
          roomName: 'W1N1',
          priority: 'road',
          structureType: TEST_GLOBALS.STRUCTURE_ROAD,
          mode: 'normal',
          result: 0 as ScreepsReturnCode,
          x: 18,
          y: 23
        }
      ]
    );

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(room.constructionActivity).toMatchObject({
      source: 'runtime-summary',
      state: 'active',
      accepted: true,
      reason: 'site_placement_observed',
      constructionSiteCount: 0,
      pendingBuildProgress: 0,
      buildCarriedEnergy: 0,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true,
      buildBlockedReason: 'no_construction_sites',
      planner: {
        mode: 'normal',
        priority: 'road',
        structureType: TEST_GLOBALS.STRUCTURE_ROAD,
        result: 0,
        x: 18,
        y: 23
      }
    });
    expect(productiveEnergy.constructionActivity).toEqual(room.constructionActivity);
  });

  it('distinguishes visible construction sites without pending progress from absent construction sites', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      constructionSites: [
        {
          id: 'opaque-extension-site',
          structureType: TEST_GLOBALS.STRUCTURE_EXTENSION
        }
      ]
    });

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(productiveEnergy.buildBlockedReason).toBe('construction_site_progress_unavailable');
    expect(room.constructionActivity).toMatchObject({
      source: 'runtime-summary',
      state: 'no_viable_candidate',
      accepted: false,
      reason: 'construction_site_progress_unavailable',
      constructionSiteCount: 1,
      pendingBuildProgress: 0,
      buildCarriedEnergy: 0,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true,
      buildBlockedReason: 'construction_site_progress_unavailable'
    });
    expect(productiveEnergy.constructionActivity).toEqual(room.constructionActivity);
  });

  it('marks construction activity as candidate suppressed when a scored candidate has no site yet', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const constructionActivity = room.constructionActivity as Record<string, unknown>;
    expect(constructionActivity).toMatchObject({
      source: 'runtime-summary',
      state: 'candidate_suppressed',
      accepted: true,
      reason: 'scored_candidate_available',
      constructionSiteCount: 0,
      pendingBuildProgress: 0,
      buildCarriedEnergy: 0,
      buildProgress: 0,
      workerAssignmentEvidenceAvailable: true,
      buildBlockedReason: 'no_construction_sites',
      candidate: {
        buildItem: 'build rampart defense',
        room: 'W1N1',
        score: 49,
        urgency: 'critical'
      }
    });
    expect(room.constructionScoring).toEqual({
      source: 'runtime-summary',
      loopRan: true,
      skipped: false,
      rawCandidateCount: 4,
      viableCandidateCount: 4,
      suppressedCandidateCount: 3,
      dominantSuppressionReason: 'lower_ranked_candidate',
      acceptedCandidateCount: 1,
      sitePlacementAttempted: false
    });
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy.constructionActivity).toEqual(
      room.constructionActivity
    );
  });

  it('reports an accepted construction scoring candidate when a viable primary build candidate exists', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.constructionScoring).toMatchObject({
      source: 'runtime-summary',
      loopRan: true,
      skipped: false,
      rawCandidateCount: 4,
      viableCandidateCount: 4,
      acceptedCandidateCount: 1,
      sitePlacementAttempted: false
    });
    expect(room.constructionActivity).toMatchObject({
      candidate: {
        buildItem: 'build rampart defense',
        room: 'W1N1',
        score: 49,
        urgency: 'critical'
      }
    });
  });

  it('does not report an energy-buffer or spawn-reservation construction block when E29N57 has stored energy for build work', () => {
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
      store: makeEnergyStore(300, 300)
    };
    const extensions = Array.from({ length: 30 }, (_, index) => ({
      id: `extension${index + 1}`,
      structureType: TEST_GLOBALS.STRUCTURE_EXTENSION,
      store: makeEnergyStore(index < 11 ? 50 : 0, 50)
    }));
    const storedContainer = {
      id: 'stored-container1',
      structureType: TEST_GLOBALS.STRUCTURE_CONTAINER,
      store: makeEnergyStore(2_000, 2_000)
    };
    const storage = {
      id: 'storage1',
      structureType: TEST_GLOBALS.STRUCTURE_STORAGE,
      store: makeEnergyStore(69, 10_000)
    };
    const worker = {
      name: 'StoredEnergyBuilder',
      memory: { role: 'worker', colony: 'E29N57' },
      store: makeEnergyStore(30, 50),
      getActiveBodyparts: jest.fn().mockReturnValue(1)
    } as unknown as Creep;
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N57',
      includeEventLog: false,
      structures: [spawn, ...extensions, storedContainer, storage],
      creeps: [worker],
      constructionSites: [
        { id: 'container-site', structureType: TEST_GLOBALS.STRUCTURE_CONTAINER, progress: 500, progressTotal: 5_000 }
      ]
    });
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 850;
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyCapacityAvailable = 1_800;
    (colony.room.controller as StructureController).level = 5;
    colony.energyAvailable = 850;
    colony.energyCapacityAvailable = 1_800;

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(productiveEnergy.buildBlockedReason).toBe('worker_assignment_gap');
    expect(productiveEnergy.workerAssignmentBlockedDetail).toBe('unknown');
    const [blockedWorker] = productiveEnergy.workerAssignmentBlockedWorkers as Array<Record<string, unknown>>;
    expect(blockedWorker).toMatchObject({
      name: 'StoredEnergyBuilder',
      buildBlockedReason: 'build_blocked_unknown'
    });
    expect(blockedWorker).not.toHaveProperty('constructionEnergyGate');
  });

  it('marks zero assigned worker tasks as authoritative runtime evidence', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N55',
      includeEventLog: false,
      constructionSites: [
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
      ]
    });
    const idleWorker = makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'worker-E29N55-idle');

    emitRuntimeSummary([colony], [idleWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(room.taskCounts).toMatchObject({
      build: 0,
      harvest: 0,
      none: 1,
      repair: 0,
      transfer: 0,
      upgrade: 0
    });
    expect(room.workerAssignmentEvidenceAvailable).toBe(true);
    expect(room.workerAssignmentEvidence).toEqual({
      source: 'runtime-summary',
      available: true,
      tick: RUNTIME_SUMMARY_INTERVAL,
      workerCount: 1,
      assignedTaskCount: 0,
      productiveAssignmentCount: 0,
      unassignedWorkerCount: 1,
      idleReasonCounts: {
        controller_upgrade_saturated_standby: 0,
        cpu_shed_assignment_skipped: 0,
        no_task_available: 0,
        role_body_unavailable: 0,
        room_snapshot_missing_creep_memory: 0,
        task_assignment_not_observed: 1
      },
      idleWorkers: [
        {
          name: 'worker-E29N55-idle',
          reason: 'task_assignment_not_observed',
          carriedEnergy: 0,
          freeCapacity: 0
        }
      ]
    });
    expect(productiveEnergy.workerAssignmentEvidenceAvailable).toBe(true);
    expect(productiveEnergy.buildBlockedReason).toBe('worker_assignment_gap');
  });

  it('counts malformed stale worker task memory as unassigned idle evidence', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N55',
      includeEventLog: false,
      constructionSites: [
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
      ]
    });
    const malformedTaskWorker = makeWorker(
      {
        role: 'worker',
        colony: 'E29N55',
        task: { targetId: 'stale-construction-site' } as unknown as CreepMemory['task']
      },
      0,
      'worker-E29N55-malformed-task'
    );

    emitRuntimeSummary([colony], [malformedTaskWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.taskCounts).toMatchObject({
      build: 0,
      harvest: 0,
      none: 1,
      repair: 0,
      transfer: 0,
      upgrade: 0
    });
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 1,
      assignedTaskCount: 0,
      productiveAssignmentCount: 0,
      unassignedWorkerCount: 1,
      idleReasonCounts: {
        cpu_shed_assignment_skipped: 0,
        no_task_available: 0,
        role_body_unavailable: 0,
        room_snapshot_missing_creep_memory: 0,
        task_assignment_not_observed: 1
      },
      idleWorkers: [
        {
          name: 'worker-E29N55-malformed-task',
          reason: 'task_assignment_not_observed',
          carriedEnergy: 0,
          freeCapacity: 0
        }
      ]
    });
  });

  it('reports no-task idle reasons from current worker dispatch diagnostics', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    const idleWorker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        workerDispatchDiagnostic: {
          tick: RUNTIME_SUMMARY_INTERVAL,
          reason: 'no_selected_task_idle',
          carriedEnergy: 50,
          freeCapacity: 0
        }
      },
      50,
      'NoTaskWorker'
    );

    emitRuntimeSummary([colony], [idleWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 1,
      assignedTaskCount: 0,
      unassignedWorkerCount: 1,
      idleReasonCounts: {
        cpu_shed_assignment_skipped: 0,
        no_task_available: 1,
        role_body_unavailable: 0,
        room_snapshot_missing_creep_memory: 0,
        task_assignment_not_observed: 0
      },
      idleWorkers: [
        {
          name: 'NoTaskWorker',
          reason: 'no_task_available',
          carriedEnergy: 50,
          freeCapacity: 0,
          dispatchReason: 'no_selected_task_idle',
          dispatchTick: RUNTIME_SUMMARY_INTERVAL
        }
      ]
    });
  });

  it('reports controller-upgrade saturation standby as a guarded idle reason', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    const idleWorker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        workerDispatchDiagnostic: {
          tick: RUNTIME_SUMMARY_INTERVAL,
          reason: 'controller_upgrade_saturated_standby',
          carriedEnergy: 0,
          freeCapacity: 100
        }
      },
      0,
      'StandbyWorker'
    );

    emitRuntimeSummary([colony], [idleWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 1,
      assignedTaskCount: 0,
      unassignedWorkerCount: 1,
      idleReasonCounts: {
        controller_upgrade_saturated_standby: 1,
        no_task_available: 0,
        task_assignment_not_observed: 0
      },
      idleWorkers: [
        {
          name: 'StandbyWorker',
          reason: 'controller_upgrade_saturated_standby',
          carriedEnergy: 0,
          freeCapacity: 0,
          dispatchReason: 'controller_upgrade_saturated_standby',
          dispatchTick: RUNTIME_SUMMARY_INTERVAL
        }
      ]
    });
  });

  it('reports role or body unavailable when an unassigned worker has no active body parts', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    const bodylessWorker = {
      name: 'BodylessWorker',
      memory: { role: 'worker', colony: 'W1N1' },
      body: [],
      store: makeEnergyStore(0, 50)
    } as unknown as Creep;

    emitRuntimeSummary([colony], [bodylessWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 1,
      assignedTaskCount: 0,
      unassignedWorkerCount: 1,
      idleReasonCounts: {
        cpu_shed_assignment_skipped: 0,
        no_task_available: 0,
        role_body_unavailable: 1,
        room_snapshot_missing_creep_memory: 0,
        task_assignment_not_observed: 0
      },
      idleWorkers: [
        {
          name: 'BodylessWorker',
          reason: 'role_body_unavailable',
          carriedEnergy: 0,
          freeCapacity: 50
        }
      ]
    });
  });

  it('reports CPU-shed idle workers when assignment was skipped without current dispatch evidence', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL * 5,
      includeEventLog: false
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game.cpu = {
      getUsed: jest.fn().mockReturnValue(1),
      limit: 100,
      bucket: 500,
      tickLimit: 500
    } as unknown as CPU;
    const idleWorker = makeWorker({ role: 'worker', colony: 'W1N1' }, 0, 'CpuSkippedWorker');

    emitRuntimeSummary([colony], [idleWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 1,
      assignedTaskCount: 0,
      unassignedWorkerCount: 1,
      idleReasonCounts: {
        cpu_shed_assignment_skipped: 1,
        no_task_available: 0,
        role_body_unavailable: 0,
        room_snapshot_missing_creep_memory: 0,
        task_assignment_not_observed: 0
      },
      idleWorkers: [
        {
          name: 'CpuSkippedWorker',
          reason: 'cpu_shed_assignment_skipped',
          carriedEnergy: 0,
          freeCapacity: 0
        }
      ]
    });
    expect(room.constructionActivity).toMatchObject({
      state: 'candidate_suppressed',
      accepted: true,
      reason: 'cpu_shed',
      cpuPressure: 'degraded',
      cpuReasons: ['lowBucket']
    });
    expect(room.constructionScoring).toMatchObject({
      skipped: true,
      skipReason: 'lowBucket'
    });
  });

  it('counts non-display energy acquisition assignments as productive runtime evidence', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    const workers = [
      makeWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'withdraw', targetId: 'storage1' as Id<AnyStoreStructure> } },
        0,
        'Withdrawer'
      ),
      makeWorker(
        {
          role: 'worker',
          colony: 'W1N1',
          task: { type: 'pickup', targetId: 'dropped-energy' as Id<Resource<ResourceConstant>> }
        },
        0,
        'Picker'
      ),
      makeWorker(
        {
          role: 'worker',
          colony: 'W1N1',
          task: { type: 'signController', targetId: 'controller1' as Id<StructureController> }
        },
        0,
        'Signer'
      )
    ];

    emitRuntimeSummary([colony], workers);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.taskCounts).toMatchObject({
      build: 0,
      harvest: 0,
      none: 1,
      pickup: 1,
      repair: 0,
      transfer: 0,
      upgrade: 0,
      withdraw: 1
    });
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 3,
      assignedTaskCount: 3,
      productiveAssignmentCount: 2
    });
  });

  it('counts visible same-room workers when colony memory is missing', () => {
    const constructionSite = {
      id: 'extension-site',
      structureType: TEST_GLOBALS.STRUCTURE_EXTENSION,
      progress: 0,
      progressTotal: 50
    };
    const builder = makeWorker(
      { role: 'worker', task: { type: 'build', targetId: 'extension-site' as Id<ConstructionSite> } },
      30,
      'worker-E29N55-994364'
    );
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N55',
      includeEventLog: false,
      creeps: [builder],
      constructionSites: [constructionSite]
    });
    (builder as Creep & { room: Room }).room = colony.room;

    emitRuntimeSummary([colony], [builder]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerCount).toBe(1);
    expect(room.taskCounts).toMatchObject({
      build: 1,
      harvest: 0,
      none: 0,
      repair: 0,
      transfer: 0,
      upgrade: 0
    });
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy).toMatchObject({
      assignedWorkerCount: 1,
      buildCarriedEnergy: 30
    });
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy).not.toHaveProperty(
      'buildBlockedReason'
    );
  });

  it('counts visible secondary-room builders even when colony memory points elsewhere', () => {
    const constructionSite = {
      id: 'road-site',
      structureType: TEST_GLOBALS.STRUCTURE_ROAD,
      progress: 240,
      progressTotal: 500
    };
    const builder = makeWorker(
      {
        role: 'worker',
        colony: 'E29N55',
        task: { type: 'build', targetId: 'road-site' as Id<ConstructionSite> }
      },
      61,
      'worker-E29N55-support-2131872'
    );
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N56',
      includeEventLog: false,
      creeps: [builder],
      constructionSites: [constructionSite]
    });
    (Memory.rooms as Record<string, RoomMemory>)[colony.room.name] = {
      runtime: {
        constructionDeadlockTicks: 42,
        constructionDeadlockUpdatedAt: RUNTIME_SUMMARY_INTERVAL - 1
      }
    } as RoomMemory;
    (builder as Creep & { room: Room }).room = colony.room;

    emitRuntimeSummary([colony], [builder]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(room.taskCounts).toMatchObject({ build: 1 });
    expect(room.constructionDeadlockTicks).toBe(0);
    expect(productiveEnergy).toMatchObject({
      assignedWorkerCount: 1,
      buildCarriedEnergy: 61,
      constructionSiteCount: 1,
      constructionDeadlockTicks: 0,
      pendingBuildProgress: 260
    });
    expect(productiveEnergy).not.toHaveProperty('buildBlockedReason');
    expect(room.constructionActivity).toMatchObject({
      state: 'active',
      accepted: true,
      reason: 'build_energy_carried',
      buildCarriedEnergy: 61
    });
  });

  it('reports spawn reservation detail for a construction assignment gap with room buffer energy', () => {
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
      store: makeEnergyStore(300, 300)
    };
    const worker = {
      name: 'IdleBuilder',
      memory: { role: 'worker', colony: 'W1N1' },
      store: makeEnergyStore(0, 50),
      getActiveBodyparts: jest.fn().mockReturnValue(1)
    } as unknown as Creep;
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      structures: [spawn],
      creeps: [worker],
      constructionSites: [
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
      ]
    });
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 300;
    colony.energyAvailable = 300;

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerAssignmentBlockedDetail).toBe('spawn_reserving_energy');
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy).toMatchObject({
      buildBlockedReason: 'worker_assignment_gap',
      workerAssignmentBlockedDetail: 'spawn_reserving_energy',
      constructionActivity: {
        state: 'candidate_suppressed',
        accepted: true,
        reason: 'spawn_reserving_energy',
        constructionSiteCount: 1,
        pendingBuildProgress: 50,
        buildCarriedEnergy: 0,
        workerAssignmentEvidenceAvailable: true,
        buildBlockedReason: 'worker_assignment_gap',
        workerAssignmentBlockedDetail: 'spawn_reserving_energy'
      }
    });
    expect(room.constructionActivity).toEqual(
      (room.resources as Record<string, Record<string, unknown>>).productiveEnergy.constructionActivity
    );
  });

  it('counts recovery assignments as productive while preserving the spawn reservation construction blocker', () => {
    const spawn = {
      id: 'spawn1',
      name: 'Spawn1',
      structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
      store: makeEnergyStore(300, 300)
    };
    const makeCapableWorker = (memory: CreepMemory, energy: number, name: string): Creep =>
      ({
        name,
        memory,
        store: makeEnergyStore(energy, 50),
        getActiveBodyparts: jest.fn().mockReturnValue(1)
      }) as unknown as Creep;
    const workers = [
      makeCapableWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'transfer', targetId: 'spawn1' as Id<AnyStoreStructure> } },
        50,
        'Refiller'
      ),
      makeCapableWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'withdraw', targetId: 'container1' as Id<AnyStoreStructure> } },
        0,
        'Withdrawer'
      ),
      makeCapableWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'pickup', targetId: 'drop1' as Id<Resource<ResourceConstant>> } },
        0,
        'Picker'
      ),
      makeCapableWorker(
        { role: 'worker', colony: 'W1N1', task: { type: 'harvest', targetId: 'source1' as Id<Source> } },
        0,
        'Harvester'
      )
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      structures: [spawn],
      creeps: workers,
      constructionSites: [
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
      ]
    });
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 300;
    colony.energyAvailable = 300;

    emitRuntimeSummary([colony], workers);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.taskCounts).toMatchObject({
      build: 0,
      harvest: 1,
      none: 0,
      pickup: 1,
      repair: 0,
      transfer: 1,
      upgrade: 0,
      withdraw: 1
    });
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 4,
      assignedTaskCount: 4,
      productiveAssignmentCount: 4,
      unassignedWorkerCount: 0
    });
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy).toMatchObject({
      assignedWorkerCount: 0,
      assignedCarriedEnergy: 0,
      buildBlockedReason: 'worker_assignment_gap',
      workerAssignmentBlockedDetail: 'spawn_reserving_energy',
      constructionActivity: {
        state: 'candidate_suppressed',
        accepted: true,
        reason: 'spawn_reserving_energy'
      }
    });
  });

  it('reports per-worker build and repair rejection reasons for construction assignment gaps', () => {
    const idleWorker = {
      name: 'IdleBuilder',
      memory: { role: 'worker', colony: 'W1N1' },
      store: makeEnergyStore(0, 50),
      getActiveBodyparts: jest.fn().mockReturnValue(1)
    } as unknown as Creep;
    const upgrader = {
      name: 'Upgrader',
      memory: {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'upgrade', targetId: 'controller1' as Id<StructureController> },
        workerDispatchDiagnostic: {
          tick: RUNTIME_SUMMARY_INTERVAL,
          reason: 'retained_upgrade_task',
          carriedEnergy: 50,
          freeCapacity: 0,
          currentTask: 'upgrade',
          currentTargetId: 'controller1',
          selectedTask: 'build',
          selectedTargetId: 'extension-site',
          assignedTask: 'upgrade',
          assignedTargetId: 'controller1'
        }
      },
      store: makeEnergyStore(50, 50),
      getActiveBodyparts: jest.fn().mockReturnValue(1)
    } as unknown as Creep;
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      creeps: [idleWorker, upgrader],
      constructionSites: [
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
      ]
    });
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 317;
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyCapacityAvailable = 400;
    colony.energyAvailable = 317;
    colony.energyCapacityAvailable = 400;

    emitRuntimeSummary([colony], [idleWorker, upgrader]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(room.workerAssignmentBlockedDetail).toEqual(productiveEnergy.workerAssignmentBlockedDetail);
    expect(room.workerAssignmentBlockedWorkers).toEqual(productiveEnergy.workerAssignmentBlockedWorkers);
    expect(productiveEnergy.workerAssignmentBlockedWorkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'IdleBuilder',
          buildBlockedReason: 'build_blocked_no_carried_energy',
          repairBlockedReason: 'repair_blocked_no_repair_targets'
        }),
        expect.objectContaining({
          name: 'Upgrader',
          buildBlockedReason: 'build_blocked_controller_progress_preferred',
          repairBlockedReason: 'repair_blocked_no_repair_targets',
          dispatchReason: 'retained_upgrade_task',
          dispatchSelectedTask: 'build',
          dispatchSelectedTargetId: 'extension-site',
          dispatchAssignedTask: 'upgrade',
          dispatchAssignedTargetId: 'controller1'
        })
      ])
    );
  });

  it('does not report a spend-margin block for carried construction energy above the construction floor', () => {
    const loadedWorker = {
      name: 'LoadedBuilder',
      memory: { role: 'worker', colony: 'W1N1' },
      store: makeEnergyStore(50, 50),
      getActiveBodyparts: jest.fn().mockReturnValue(1)
    } as unknown as Creep;
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      creeps: [loadedWorker],
      constructionSites: [
        { id: 'road-site', structureType: TEST_GLOBALS.STRUCTURE_ROAD, progress: 0, progressTotal: 300 }
      ]
    });
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 310;
    (colony.room as Room & { energyAvailable: number; energyCapacityAvailable: number }).energyCapacityAvailable = 450;
    colony.energyAvailable = 310;
    colony.energyCapacityAvailable = 450;

    emitRuntimeSummary([colony], [loadedWorker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const productiveEnergy = (room.resources as Record<string, Record<string, unknown>>).productiveEnergy;
    expect(productiveEnergy.workerAssignmentBlockedDetail).toBe('room_capacity_full');
    expect(productiveEnergy.workerAssignmentBlockedWorkers).toEqual([
      expect.objectContaining({
        name: 'LoadedBuilder',
        buildBlockedReason: 'build_blocked_unknown'
      })
    ]);
  });

  it('does not report a construction gap while a worker is acquiring energy for a construction site', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      constructionSites: [
        { id: 'extension-site', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, progress: 0, progressTotal: 50 }
      ]
    });
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        task: {
          type: 'withdraw',
          targetId: 'spawn1' as Id<AnyStoreStructure>,
          constructionSiteId: 'extension-site' as Id<ConstructionSite>
        }
      },
      0,
      'ConstructionLoader'
    );

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.taskCounts).toMatchObject({
      build: 0,
      harvest: 0,
      none: 0,
      repair: 0,
      transfer: 0,
      upgrade: 0,
      withdraw: 1
    });
    expect(room.workerAssignmentEvidence).toMatchObject({
      workerCount: 1,
      assignedTaskCount: 1,
      productiveAssignmentCount: 1
    });
    expect((room.resources as Record<string, Record<string, unknown>>).productiveEnergy.buildBlockedReason).toBeUndefined();
  });

  it('reports storedEnergy from owned spawn, extension, container, and terminal stores', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      structures: [
        { id: 'spawn1', structureType: TEST_GLOBALS.STRUCTURE_SPAWN, store: makeEnergyStore(40, 300) },
        { id: 'extension1', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION, store: makeEnergyStore(20, 50) },
        { id: 'container1', structureType: TEST_GLOBALS.STRUCTURE_CONTAINER, store: makeEnergyStore(125, 2000) },
        { id: 'terminal1', structureType: TEST_GLOBALS.STRUCTURE_TERMINAL, store: makeEnergyStore(70, 1000) },
        { id: 'tower1', structureType: TEST_GLOBALS.STRUCTURE_TOWER, store: makeEnergyStore(900, 1000) },
        { id: 'unknown-store', store: makeEnergyStore(500, 500) }
      ]
    });

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect((room.resources as Record<string, unknown>).storedEnergy).toBe(255);
  });

  it('reports storedEnergy from direct room storage and terminal when room.find misses them', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeRoomFind: false,
      includeEventLog: false
    });
    (colony.spawns[0] as unknown as { store: unknown }).store = makeEnergyStore(0, 300);
    (colony.room as unknown as { energyAvailable: number; storage: unknown; terminal: unknown }).energyAvailable = 0;
    colony.energyAvailable = 0;
    (colony.room as unknown as { storage: unknown }).storage = {
      id: 'storage1',
      structureType: TEST_GLOBALS.STRUCTURE_STORAGE,
      store: makeEnergyStore(200, 1000)
    };
    (colony.room as unknown as { terminal: unknown }).terminal = {
      id: 'terminal1',
      structureType: TEST_GLOBALS.STRUCTURE_TERMINAL,
      store: makeEnergyStore(70, 1000)
    };

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect((room.resources as Record<string, unknown>).storedEnergy).toBe(270);
  });

  it('reports workerCarriedEnergy from owned creeps in the room', () => {
    const roomCreeps = [
      makeWorker({ role: 'worker', colony: 'W1N1' }, 15, 'WorkerA'),
      makeWorker({ role: 'worker', colony: 'W1N1' }, 25, 'WorkerB'),
      makeWorker({ role: 'claimer', colony: 'W1N1' }, 5, 'Claimer')
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      creeps: roomCreeps
    });

    emitRuntimeSummary([colony], roomCreeps);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerCarriedEnergy).toBe(45);
    expect((room.resources as Record<string, unknown>).workerCarriedEnergy).toBe(45);
  });

  it('reports workerCarriedEnergy from known colony creeps when room.find is unavailable', () => {
    const colonyCreeps = [
      makeWorker({ role: 'worker', colony: 'W1N1' }, 18, 'WorkerA'),
      makeWorker({ role: 'hauler', colony: 'W1N1' }, 22, 'HaulerA')
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeRoomFind: false,
      includeEventLog: false
    });

    emitRuntimeSummary([colony], colonyCreeps);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerCarriedEnergy).toBe(40);
    expect((room.resources as Record<string, unknown>).workerCarriedEnergy).toBe(40);
  });

  it('reports energy surplus routing KPIs in room resource telemetry', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      structures: [
        { id: 'spawn1', structureType: TEST_GLOBALS.STRUCTURE_SPAWN, store: makeEnergyStore(300, 300) },
        { id: 'container1', structureType: TEST_GLOBALS.STRUCTURE_CONTAINER, store: makeEnergyStore(2_000, 2_000) },
        { id: 'storage1', structureType: TEST_GLOBALS.STRUCTURE_STORAGE, store: makeEnergyStore(200, 1_000) }
      ]
    });
    (colony.room as { energyAvailable: number; energyCapacityAvailable: number }).energyAvailable = 300;
    (colony.room as { energyAvailable: number; energyCapacityAvailable: number }).energyCapacityAvailable = 300;
    colony.energyAvailable = 300;
    colony.energyCapacityAvailable = 300;
    const worker = makeWorker(
      { role: 'worker', colony: 'W1N1', task: { type: 'transfer', targetId: 'storage1' as Id<AnyStoreStructure> } },
      50,
      'SurplusCarrier'
    );

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect((room.resources as Record<string, unknown>).energySurplus).toEqual({
      surplus: true,
      spawnExtensionsFull: true,
      containersFull: true,
      reservedSpawnEnergy: 0,
      unmetSpawnEnergyReservation: 0,
      spawnExtensionFreeCapacity: 0,
      containerFreeCapacity: 0,
      durableFreeCapacity: 800,
      storageEnergy: 200,
      storageFreeCapacity: 800,
      terminalEnergy: 0,
      terminalFreeCapacity: 0,
      terminalTargetEnergy: 0,
      terminalEnergyDeficit: 0,
      terminalEnergySurplus: 0,
      routedWorkerCount: 1,
      routedCarriedEnergy: 50,
      selectedSinkId: 'storage1',
      selectedSinkType: 'storage'
    });
  });

  it('reports harvestedThisTick from harvest event amounts', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    const getEventLog = jest.fn(() => [
      { event: TEST_GLOBALS.EVENT_HARVEST, data: { amount: 5, resourceType: TEST_GLOBALS.RESOURCE_ENERGY } },
      { event: TEST_GLOBALS.EVENT_HARVEST, data: { amount: 7 } },
      { event: TEST_GLOBALS.EVENT_HARVEST, data: { amount: 99, resourceType: 'power' } },
      { event: TEST_GLOBALS.EVENT_TRANSFER, data: { amount: 11, resourceType: TEST_GLOBALS.RESOURCE_ENERGY } }
    ]);
    (colony.room as unknown as { getEventLog: jest.Mock }).getEventLog = getEventLog;

    emitRuntimeSummary([colony], []);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    const resources = room.resources as Record<string, unknown>;
    expect(resources.harvestedThisTick).toBe(12);
    expect((resources.events as Record<string, unknown>).harvestedEnergy).toBe(12);
    expect(getEventLog).toHaveBeenCalledWith();
  });

  it('reports zero energy fields when structures and creeps have no energy', () => {
    const roomCreeps = [
      makeWorker({ role: 'worker', colony: 'W1N1' }, 0, 'EmptyWorker'),
      { name: 'NoStoreWorker', memory: { role: 'worker', colony: 'W1N1' } }
    ];
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false,
      structures: [
        { id: 'spawn1', structureType: TEST_GLOBALS.STRUCTURE_SPAWN, store: makeEnergyStore(0, 300) },
        { id: 'extension1', structureType: TEST_GLOBALS.STRUCTURE_EXTENSION }
      ],
      creeps: roomCreeps
    });
    (colony.room as { energyAvailable: number }).energyAvailable = 0;
    colony.energyAvailable = 0;

    emitRuntimeSummary([colony], roomCreeps as Creep[]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.workerCarriedEnergy).toBe(0);
    expect(room.resources).toMatchObject({
      storedEnergy: 0,
      workerCarriedEnergy: 0,
      harvestedThisTick: 0
    });
  });

  it('reports why worker load efficiency has no recent samples', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const worker = makeWorker(
      {
        role: 'worker',
        colony: 'W1N1',
        task: { type: 'build', targetId: 'site-1' as Id<ConstructionSite> }
      },
      40,
      'BuilderWithoutEfficiencySample'
    );

    emitRuntimeSummary([colony], [worker]);

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.taskCounts).toMatchObject({ build: 1 });
    expect(room.workerAssignmentEvidenceAvailable).toBe(true);
    expect(room.workerEfficiency).toBeUndefined();
    expect(room.workerLoadEfficiency).toEqual({
      sampleCount: 0,
      tripEnergyMean: null,
      tripEnergyMin: null,
      unavailableReason: 'recent_worker_efficiency_sample_missing'
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
    expect(room.workerLoadEfficiency).toEqual({
      sampleCount: 3,
      tripEnergyMean: 8,
      tripEnergyMin: 6
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
        progress: DEFAULT_TEST_CONTROLLER_PROGRESS,
        progressTotal: DEFAULT_TEST_CONTROLLER_PROGRESS_TOTAL,
        ticksToDowngrade: 15000
      },
      resources: {
        storedEnergy: 250,
        workerCarriedEnergy: 7,
        harvestedThisTick: 0,
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

  it('reports owned controller sign evidence in room telemetry', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });
    (colony.room.controller as StructureController).sign = {
      username: 'lanyusea',
      text: OCCUPIED_CONTROLLER_SIGN_TEXT,
      time: 12345,
      datetime: new Date('2026-05-15T00:00:00.000Z')
    };

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.controller).toMatchObject({
      sign: {
        username: 'lanyusea',
        text: OCCUPIED_CONTROLLER_SIGN_TEXT,
        time: 12345,
        datetime: '2026-05-15T00:00:00.000Z'
      }
    });
  });

  it('reports null sign evidence for unsigned owned controllers and skips unowned controllers safely', () => {
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      includeEventLog: false
    });

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    let payload = parseLoggedSummary();
    let [room] = payload.rooms as Array<Record<string, unknown>>;
    expect((room.controller as Record<string, unknown>).sign).toBeNull();

    logSpy.mockClear();
    (colony.room as Room & { controller?: StructureController }).controller = {
      my: false,
      level: 2
    } as StructureController;

    emitRuntimeSummary(
      [colony],
      [],
      [
        {
          type: 'spawn',
          roomName: 'W1N1',
          spawnName: 'Spawn1',
          creepName: 'worker-W1N1-event',
          role: 'worker',
          result: 0 as ScreepsReturnCode
        }
      ],
      { persistOccupationRecommendations: false }
    );

    payload = parseLoggedSummary();
    [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.controller).toBeUndefined();
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
        createdBy: 'occupationRecommendation',
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

  it('emits compact active expansion pipeline progress for monitor alerts', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        expansionPipelines: {
          W1N1: {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            status: 'active',
            stage: 'claiming',
            claimState: 'scouted',
            score: 900,
            threshold: 700,
            startedAt: RUNTIME_SUMMARY_INTERVAL - 50,
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
            controllerId: 'controller2' as Id<StructureController>
          }
        },
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
            createdBy: 'nextExpansionScoring'
          }
        ]
      }
    };

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.territoryExpansionProgress).toMatchObject({
      colony: 'W1N1',
      blocker: 'activeExpansionPipeline',
      blockerSource: 'activePipeline',
      targetRoom: 'W2N1',
      lastProgressAt: RUNTIME_SUMMARY_INTERVAL - 1,
      activePipelineStateKey: expect.stringContaining('pipeline:active:claiming:W2N1'),
      activePipeline: {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        status: 'active',
        stage: 'claiming',
        claimState: 'scouted',
        updatedAt: RUNTIME_SUMMARY_INTERVAL - 1
      },
      controlCounts: {
        active: { claim: 0, reserve: 0, scout: 0 },
        planned: { claim: 1, reserve: 0, scout: 0 },
        targets: { claim: 0, reserve: 0 }
      }
    });
  });

  it('reports when GCL capacity raises the room limit above the internal RCL policy', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL, controllerLevel: 4 });
    const globals = globalThis as unknown as { Game: Partial<Game> };
    globals.Game.gcl = { level: 5 } as GlobalControlLevel;
    globals.Game.rooms = {
      ...globals.Game.rooms,
      W2N1: makeOwnedRuntimeSummaryRoom('W2N1', 4),
      W3N1: makeOwnedRuntimeSummaryRoom('W3N1', 3)
    };

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.territoryExpansionProgress).toMatchObject({
      colony: 'W1N1',
      ownedRoomCount: 3,
      roomCapacityStatus: 'available',
      roomLimitCapacity: 5,
      rclRoomLimitCapacity: 3,
      gclRoomCapacity: 5,
      roomLimitBasis: 'gclCapacity'
    });
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

  it('emits territory scout attempts and intel in room telemetry', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        scoutAttempts: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            status: 'observed',
            requestedAt: RUNTIME_SUMMARY_INTERVAL - 3,
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
            attemptCount: 1,
            scoutName: 'Scout1',
            lastValidation: {
              status: 'passed',
              updatedAt: RUNTIME_SUMMARY_INTERVAL - 1
            }
          }
        },
        scoutIntel: {
          'W1N1>W2N1': {
            colony: 'W1N1',
            roomName: 'W2N1',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
            controller: { id: 'controller2' as Id<StructureController>, my: false },
            sourceIds: ['source1', 'source2'],
            sourceCount: 2,
            mineral: { id: 'mineral1', mineralType: 'H' },
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0,
            scoutName: 'Scout1'
          }
        }
      }
    };

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect(room.territoryScout).toEqual({
      attempts: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          status: 'observed',
          requestedAt: RUNTIME_SUMMARY_INTERVAL - 3,
          updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
          attemptCount: 1,
          scoutName: 'Scout1',
          lastValidation: {
            status: 'passed',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1
          }
        }
      ],
      intel: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          updatedAt: RUNTIME_SUMMARY_INTERVAL - 1,
          controller: { id: 'controller2', my: false },
          sourceIds: ['source1', 'source2'],
          sourceCount: 2,
          mineral: { id: 'mineral1', mineralType: 'H' },
          hostileCreepCount: 0,
          hostileStructureCount: 0,
          hostileSpawnCount: 0,
          scoutName: 'Scout1'
        }
      ]
    });
  });

  it('emits scout concurrency evidence when active scouts exceed useful requested targets', () => {
    const scouts = ['ScoutA', 'ScoutB', 'ScoutC', 'ScoutD', 'ScoutE'].map((name) =>
      makeWorker(
        {
          role: 'scout',
          colony: 'E29N55',
          territory: { targetRoom: 'E28N54', action: 'scout' }
        },
        0,
        name
      )
    );
    const colony = makeColony({
      time: RUNTIME_SUMMARY_INTERVAL,
      roomName: 'E29N55',
      creeps: scouts
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      ...Memory,
      territory: {
        scoutAttempts: {
          'E29N55>E28N54': {
            colony: 'E29N55',
            roomName: 'E28N54',
            status: 'requested',
            requestedAt: RUNTIME_SUMMARY_INTERVAL - 3,
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 3,
            attemptCount: 1
          },
          'E29N55>E29N53': {
            colony: 'E29N55',
            roomName: 'E29N53',
            status: 'requested',
            requestedAt: RUNTIME_SUMMARY_INTERVAL - 3,
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 3,
            attemptCount: 1
          }
        },
        scoutIntel: {
          'E29N55>E28N54': {
            colony: 'E29N55',
            roomName: 'E28N54',
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 1_600,
            sourceIds: [],
            sourceCount: 0,
            hostileCreepCount: 0,
            hostileStructureCount: 0,
            hostileSpawnCount: 0
          }
        }
      }
    };

    emitRuntimeSummary([colony], scouts, [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [room] = payload.rooms as Array<Record<string, unknown>>;
    expect((room.territoryScout as Record<string, unknown>).concurrency).toEqual({
      activeScoutCount: 5,
      cap: 2,
      assignedTargetCount: 1,
      scoutsByTargetRoom: { E28N54: 5 },
      requestedTargetRooms: ['E28N54', 'E29N53'],
      staleTargetRooms: ['E28N54'],
      duplicateTargetScoutCount: 4,
      surplusScoutCount: 3
    });
  });

  it('emits healthy E29N55 E29N56 scout-only gate proof without reserve or claim targets', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL, roomName: 'E29N55' });
    const room = colony.room as Room & { find: jest.Mock; energyAvailable: number; energyCapacityAvailable: number };
    const controller = room.controller as StructureController & { level: number; ticksToDowngrade: number };
    const spawn = colony.spawns[0] as StructureSpawn & { my?: boolean; isActive?: jest.Mock };
    const tower = {
      id: 'tower1',
      my: true,
      structureType: TEST_GLOBALS.STRUCTURE_TOWER,
      store: makeEnergyStore(500)
    };

    room.energyAvailable = 800;
    room.energyCapacityAvailable = 800;
    controller.level = 3;
    controller.ticksToDowngrade = 20_000;
    colony.energyAvailable = 800;
    colony.energyCapacityAvailable = 800;
    spawn.my = true;
    spawn.spawning = null;
    spawn.isActive = jest.fn(() => true);
    room.find.mockImplementation((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_STRUCTURES:
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return [spawn, tower];
        case TEST_GLOBALS.FIND_SOURCES:
          return [{ id: 'source1' }, { id: 'source2' }];
        case TEST_GLOBALS.FIND_HOSTILE_CREEPS:
        case TEST_GLOBALS.FIND_HOSTILE_STRUCTURES:
          return [];
        default:
          return [];
      }
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      },
      territory: {
        expansionCandidates: [
          {
            colony: 'E29N55',
            roomName: 'E29N56',
            rank: 1,
            score: 120,
            evidenceStatus: 'sufficient',
            visible: false,
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 10,
            adjacentToOwnedRoom: true,
            scoutOnly: true,
            recommendedAction: 'scout',
            ignoredPostClaimBootstrapBlockers: [
              {
                colony: 'E29N55',
                roomName: 'E29N54',
                status: 'ready',
                updatedAt: RUNTIME_SUMMARY_INTERVAL - 20,
                age: 20,
                workerTarget: 2,
                spawnCount: 1,
                workerCount: 2,
                reason: 'ready'
              },
              {
                colony: 'E28N55',
                roomName: 'E28N54',
                status: 'ready',
                updatedAt: RUNTIME_SUMMARY_INTERVAL - 20,
                age: 20,
                workerTarget: 2,
                spawnCount: 1,
                workerCount: 2,
                reason: 'ready'
              }
            ]
          }
        ]
      }
    };
    (Game as Partial<Game>).map = {
      describeExits: jest.fn(() => ({
        '1': 'E29N56',
        '3': 'E30N55',
        '5': 'E29N54',
        '7': 'E28N55'
      })),
      findRoute: jest.fn(() => [{ exit: 1, room: 'E29N56' }]),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) }))
    } as unknown as GameMap;

    emitRuntimeSummary([colony], [], [], { persistOccupationRecommendations: false });

    const payload = parseLoggedSummary();
    const [summaryRoom] = payload.rooms as Array<Record<string, unknown>>;
    const territoryScout = summaryRoom.territoryScout as Record<string, unknown>;
    const scoutOnlyTargets = territoryScout.scoutOnlyTargets as Array<Record<string, unknown>>;
    expect(territoryScout.scoutOnlyTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          colony: 'E29N55',
          roomName: 'E29N56',
          recommendedAction: 'scout',
          gateOpen: true,
          status: 'pending'
        })
      ])
    );
    expect(scoutOnlyTargets.find((target) => target.roomName === 'E29N56')).toMatchObject({
      ignoredPostClaimBootstrapBlockers: [
        {
          colony: 'E29N55',
          roomName: 'E29N54',
          reason: 'ready'
        }
      ]
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(
      (Memory.territory?.intents ?? []).filter(
        (intent) => intent.action === 'claim' || intent.action === 'reserve'
      )
    ).toEqual([]);
  });

  it('promotes sufficient E29N56 scout-only evidence into reserve intent past a superseded bootstrap record', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL, roomName: 'E29N55' });
    const room = colony.room as Room & { find: jest.Mock; energyAvailable: number; energyCapacityAvailable: number };
    const controller = room.controller as StructureController & { level: number; ticksToDowngrade: number };
    const spawn = colony.spawns[0] as StructureSpawn & { my?: boolean; isActive?: jest.Mock };
    const tower = {
      id: 'tower1',
      my: true,
      structureType: TEST_GLOBALS.STRUCTURE_TOWER,
      store: makeEnergyStore(500)
    };

    room.energyAvailable = 1_800;
    room.energyCapacityAvailable = 1_800;
    controller.level = 5;
    controller.ticksToDowngrade = 20_000;
    colony.energyAvailable = 1_800;
    colony.energyCapacityAvailable = 1_800;
    spawn.my = true;
    spawn.spawning = null;
    spawn.isActive = jest.fn(() => true);
    room.find.mockImplementation((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_STRUCTURES:
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return [spawn, tower];
        case TEST_GLOBALS.FIND_SOURCES:
          return [{ id: 'source-home-a' }, { id: 'source-home-b' }];
        case TEST_GLOBALS.FIND_HOSTILE_CREEPS:
        case TEST_GLOBALS.FIND_HOSTILE_STRUCTURES:
          return [];
        default:
          return [];
      }
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      },
      territory: {
        postClaimBootstraps: {
          E29N54: {
            colony: 'E29N55',
            roomName: 'E29N54',
            status: 'spawningWorkers',
            claimedAt: RUNTIME_SUMMARY_INTERVAL - 1_000,
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 200,
            workerTarget: 2
          }
        }
      }
    };
    (Game.rooms as Record<string, Room>).E29N54 = makeRemoteRoom('E29N54', {
      controller: { my: true } as StructureController
    });
    (Game.rooms as Record<string, Room>).E29N56 = makeRemoteRoom('E29N56', {
      controller: {
        id: 'controller-E29N56' as Id<StructureController>,
        my: false,
        pos: { x: 25, y: 25, roomName: 'E29N56' }
      } as StructureController,
      sourceCount: 1
    });
    (Game as Partial<Game>).map = {
      describeExits: jest.fn(() => ({
        '1': 'E29N56',
        '3': 'E30N55',
        '5': 'E29N54',
        '7': 'E28N55'
      })),
      findRoute: jest.fn(() => [{ exit: 1, room: 'E29N56' }]),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) }))
    } as unknown as GameMap;
    (Game.spawns as Record<string, StructureSpawn>).BootstrapSpawn = {
      room: { name: 'E29N54' } as Room
    } as StructureSpawn;
    (Game as Partial<Game>).creeps = {
      BootstrapWorker1: makeWorker({ role: 'worker', colony: 'E29N54' }, 0, 'BootstrapWorker1'),
      BootstrapWorker2: makeWorker(
        {
          role: 'worker',
          colony: 'E29N55',
          spawnSupport: { originRoom: 'E29N55', targetRoom: 'E29N54' }
        },
        0,
        'BootstrapWorker2'
      )
    } as unknown as Game['creeps'];

    emitRuntimeSummary(
      [colony],
      [
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker1'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker2'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker3'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker4')
      ]
    );

    const payload = parseLoggedSummary();
    const [summaryRoom] = payload.rooms as Array<Record<string, unknown>>;
    const territoryExpansion = summaryRoom.territoryExpansion as Record<string, unknown>;
    const expansionCandidate = (territoryExpansion.candidates as Array<Record<string, unknown>>).find(
      (candidate) => candidate.roomName === 'E29N56'
    );
    const recommendation = summaryRoom.territoryRecommendation as Record<string, unknown>;

    expect(expansionCandidate).toMatchObject({
      roomName: 'E29N56',
      evidenceStatus: 'sufficient',
      scoutOnly: true,
      sourceCount: 1,
      hostileCreepCount: 0,
      ignoredPostClaimBootstrapBlockers: [
        {
          colony: 'E29N55',
          roomName: 'E29N54',
          status: 'spawningWorkers',
          reason: 'workerTargetSatisfied',
          updatedAt: RUNTIME_SUMMARY_INTERVAL - 200,
          age: 200,
          workerTarget: 2,
          spawnCount: 1,
          workerCount: 2
        }
      ]
    });
    expect(expansionCandidate).not.toHaveProperty('blockReason');
    expect(expansionCandidate).not.toHaveProperty('postClaimBootstrapBlocker');
    expect(recommendation.next).toMatchObject({
      roomName: 'E29N56',
      action: 'reserve',
      evidenceStatus: 'sufficient',
      source: 'configured',
      sourceCount: 1,
      hostileCreepCount: 0,
      routeDistance: 1
    });
    expect(recommendation.followUpIntent).toEqual({
      colony: 'E29N55',
      targetRoom: 'E29N56',
      action: 'reserve',
      controllerId: 'controller-E29N56'
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'E29N55',
        roomName: 'E29N56',
        action: 'reserve',
        createdBy: 'occupationRecommendation',
        controllerId: 'controller-E29N56'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'E29N55',
        targetRoom: 'E29N56',
        action: 'reserve',
        status: 'planned',
        updatedAt: RUNTIME_SUMMARY_INTERVAL,
        createdBy: 'occupationRecommendation',
        controllerId: 'controller-E29N56'
      }
    ]);
  });

  it('keeps an active post-claim bootstrap as an actionable E29N56 blocker in runtime telemetry', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL, roomName: 'E29N55' });
    const room = colony.room as Room & { find: jest.Mock; energyAvailable: number; energyCapacityAvailable: number };
    const controller = room.controller as StructureController & { level: number; ticksToDowngrade: number };
    const spawn = colony.spawns[0] as StructureSpawn & { my?: boolean; isActive?: jest.Mock };
    const tower = {
      id: 'tower1',
      my: true,
      structureType: TEST_GLOBALS.STRUCTURE_TOWER,
      store: makeEnergyStore(500)
    };

    room.energyAvailable = 1_800;
    room.energyCapacityAvailable = 1_800;
    controller.level = 5;
    controller.ticksToDowngrade = 20_000;
    colony.energyAvailable = 1_800;
    colony.energyCapacityAvailable = 1_800;
    spawn.my = true;
    spawn.spawning = null;
    spawn.isActive = jest.fn(() => true);
    room.find.mockImplementation((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_STRUCTURES:
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return [spawn, tower];
        case TEST_GLOBALS.FIND_SOURCES:
          return [{ id: 'source-home-a' }, { id: 'source-home-b' }];
        case TEST_GLOBALS.FIND_HOSTILE_CREEPS:
        case TEST_GLOBALS.FIND_HOSTILE_STRUCTURES:
          return [];
        default:
          return [];
      }
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      },
      territory: {
        postClaimBootstraps: {
          E29N54: {
            colony: 'E29N55',
            roomName: 'E29N54',
            status: 'spawnSitePending',
            claimedAt: RUNTIME_SUMMARY_INTERVAL - 1_000,
            updatedAt: RUNTIME_SUMMARY_INTERVAL - 50,
            workerTarget: 2
          }
        }
      }
    };
    (Game.rooms as Record<string, Room>).E29N54 = makeRemoteRoom('E29N54', {
      controller: { my: true } as StructureController
    });
    (Game.rooms as Record<string, Room>).E29N56 = makeRemoteRoom('E29N56', {
      controller: {
        id: 'controller-E29N56' as Id<StructureController>,
        my: false,
        pos: { x: 25, y: 25, roomName: 'E29N56' }
      } as StructureController,
      sourceCount: 1
    });
    (Game as Partial<Game>).map = {
      describeExits: jest.fn(() => ({
        '1': 'E29N56',
        '3': 'E30N55',
        '5': 'E29N54',
        '7': 'E28N55'
      })),
      findRoute: jest.fn(() => [{ exit: 1, room: 'E29N56' }]),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) }))
    } as unknown as GameMap;
    (Game as Partial<Game>).creeps = {
      BootstrapWorker1: makeWorker({ role: 'worker', colony: 'E29N54' }, 0, 'BootstrapWorker1')
    } as unknown as Game['creeps'];

    emitRuntimeSummary(
      [colony],
      [
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker1'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker2'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker3'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker4')
      ],
      [],
      { persistOccupationRecommendations: false }
    );

    const payload = parseLoggedSummary();
    const [summaryRoom] = payload.rooms as Array<Record<string, unknown>>;
    const territoryExpansion = summaryRoom.territoryExpansion as Record<string, unknown>;
    const expansionCandidate = (territoryExpansion.candidates as Array<Record<string, unknown>>).find(
      (candidate) => candidate.roomName === 'E29N56'
    );
    const recommendation = summaryRoom.territoryRecommendation as Record<string, unknown>;

    expect(expansionCandidate).toMatchObject({
      roomName: 'E29N56',
      evidenceStatus: 'sufficient',
      scoutOnly: true,
      blockReason: 'postClaimBootstrapActive',
      postClaimBootstrapBlocker: {
        colony: 'E29N55',
        roomName: 'E29N54',
        status: 'spawnSitePending',
        updatedAt: RUNTIME_SUMMARY_INTERVAL - 50,
        age: 50,
        workerTarget: 2,
        spawnCount: 0,
        workerCount: 1
      }
    });
    expect(expansionCandidate).not.toHaveProperty('ignoredPostClaimBootstrapBlockers');
    expect(recommendation).toMatchObject({
      candidates: [],
      next: null,
      followUpIntent: null
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
  });

  it('omits E29N56 scout-only expansion evidence while low-bucket telemetry shedding is active', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL * 5, roomName: 'E29N55' });
    const room = colony.room as Room & { find: jest.Mock; energyAvailable: number; energyCapacityAvailable: number };
    const controller = room.controller as StructureController & { level: number; ticksToDowngrade: number };
    const spawn = colony.spawns[0] as StructureSpawn & { my?: boolean; isActive?: jest.Mock };
    const tower = {
      id: 'tower1',
      my: true,
      structureType: TEST_GLOBALS.STRUCTURE_TOWER,
      store: makeEnergyStore(500)
    };

    room.energyAvailable = 1_800;
    room.energyCapacityAvailable = 1_800;
    controller.level = 5;
    controller.ticksToDowngrade = 20_000;
    colony.energyAvailable = 1_800;
    colony.energyCapacityAvailable = 1_800;
    spawn.my = true;
    spawn.spawning = null;
    spawn.isActive = jest.fn(() => true);
    room.find.mockImplementation((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_STRUCTURES:
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return [spawn, tower];
        case TEST_GLOBALS.FIND_SOURCES:
          return [{ id: 'source-home-a' }, { id: 'source-home-b' }];
        case TEST_GLOBALS.FIND_HOSTILE_CREEPS:
        case TEST_GLOBALS.FIND_HOSTILE_STRUCTURES:
          return [];
        default:
          return [];
      }
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      runtime: {
        currentRoomName: 'E29N55'
      },
      territory: {}
    };
    (Game.rooms as Record<string, Room>).E29N56 = makeRemoteRoom('E29N56', {
      controller: {
        id: 'controller-E29N56' as Id<StructureController>,
        my: false,
        pos: { x: 25, y: 25, roomName: 'E29N56' }
      } as StructureController,
      sourceCount: 1
    });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(4.2),
      bucket: 499
    } as unknown as CPU;
    (Game as Partial<Game>).map = {
      describeExits: jest.fn(() => ({
        '1': 'E29N56',
        '3': 'E30N55',
        '5': 'E29N54',
        '7': 'E28N55'
      })),
      findRoute: jest.fn(() => [{ exit: 1, room: 'E29N56' }]),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) }))
    } as unknown as GameMap;

    emitRuntimeSummary(
      [colony],
      [
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker1'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker2'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker3'),
        makeWorker({ role: 'worker', colony: 'E29N55' }, 0, 'Worker4')
      ],
      [],
      { persistOccupationRecommendations: false }
    );

    const payload = parseLoggedSummary();
    const [summaryRoom] = payload.rooms as Array<Record<string, unknown>>;
    const recommendation = summaryRoom.territoryRecommendation as Record<string, unknown>;

    expect(summaryRoom.territoryExpansion).toBeUndefined();
    expect(summaryRoom.territoryExpansionProgress).toMatchObject({
      colony: 'E29N55',
      source: 'runtime-summary',
      blocker: 'cpuBucketLow',
      blockerSource: 'cpu',
      ownedRoomCount: 1,
      roomCapacityStatus: 'available',
      activePipelineStateKey: 'pipeline:none',
      controlCounts: {
        active: { claim: 0, reserve: 0, scout: 0 },
        planned: { claim: 0, reserve: 0, scout: 0 },
        targets: { claim: 0, reserve: 0 }
      }
    });
    expect(recommendation).toMatchObject({
      candidates: [],
      next: null,
      followUpIntent: null
    });
    expect(Memory.territory?.targets).toBeUndefined();
    expect(Memory.territory?.intents).toBeUndefined();
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

  it('uses live evidence cadence for low bucket pressure and suppresses noncritical summaries at critical bucket', () => {
    const lowBucketBudget = buildRuntimeCpuBudget({
      tick: RUNTIME_SUMMARY_INTERVAL,
      used: 21,
      limit: 70,
      bucket: 500,
      tickLimit: 500
    });
    const criticalBucketBudget = buildRuntimeCpuBudget({
      tick: RUNTIME_SUMMARY_INTERVAL,
      used: 21,
      limit: 70,
      bucket: 43,
      tickLimit: 63
    });
    const overLimitBudget = buildRuntimeCpuBudget({
      tick: RUNTIME_SUMMARY_INTERVAL,
      used: 71,
      limit: 70,
      bucket: 9_000,
      tickLimit: 500
    });
    const postDeployRecoveryBudget = buildRuntimeCpuBudget({
      tick: RUNTIME_SUMMARY_INTERVAL,
      used: 48.868957800001226,
      limit: 70,
      bucket: 1_710,
      tickLimit: 500
    });
    const freshPostDeployRecoveryBudget = buildRuntimeCpuBudget({
      tick: RUNTIME_SUMMARY_INTERVAL,
      used: 70.01923810000153,
      limit: 70,
      bucket: 1_776,
      tickLimit: 500
    });
    const spawnEvent: RuntimeTelemetryEvent = {
      type: 'spawn',
      roomName: 'W1N1',
      spawnName: 'Spawn1',
      creepName: 'worker-W1N1-1',
      role: 'worker',
      result: 0 as ScreepsReturnCode
    };
    const safeModeEvent: RuntimeTelemetryEvent = {
      type: 'defense',
      action: 'safeMode',
      roomName: 'W1N1',
      reason: 'safeModeEarlyRoomThreat',
      hostileCreepCount: 2,
      hostileStructureCount: 0,
      damagedCriticalStructureCount: 0,
      tick: RUNTIME_SUMMARY_INTERVAL
    };
    const damageOnlyDefenseEvent: RuntimeTelemetryEvent = {
      type: 'defense',
      action: 'workerFallback',
      roomName: 'W1N1',
      reason: 'workerEmergencyFallback',
      hostileCreepCount: 0,
      hostileStructureCount: 0,
      damagedCriticalStructureCount: 1,
      tick: RUNTIME_SUMMARY_INTERVAL
    };
    const normalConstructionBlockerEvent: RuntimeTelemetryEvent = {
      type: 'constructionPlacement',
      roomName: 'W1N1',
      priority: 'road',
      structureType: TEST_GLOBALS.STRUCTURE_ROAD,
      mode: 'normal',
      blockedReason: 'residual_road_seed_existing_site',
      details: { pendingConstructionSiteCount: 1 }
    };
    const normalConstructionPlacementEvent: RuntimeTelemetryEvent = {
      type: 'constructionPlacement',
      roomName: 'W1N1',
      priority: 'road',
      structureType: TEST_GLOBALS.STRUCTURE_ROAD,
      mode: 'normal',
      result: 0 as ScreepsReturnCode,
      x: 12,
      y: 13
    };

    expect(shouldEmitRuntimeSummary(1, [], lowBucketBudget)).toBe(false);
    expect(shouldEmitRuntimeSummary(5, [], lowBucketBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [], lowBucketBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL * 5, [], lowBucketBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [spawnEvent], lowBucketBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL * 5, [spawnEvent], lowBucketBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [safeModeEvent], lowBucketBudget)).toBe(true);
    expect(postDeployRecoveryBudget.reasons).toEqual(['lowBucketRecovery']);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [spawnEvent], postDeployRecoveryBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL * 5, [spawnEvent], postDeployRecoveryBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [safeModeEvent], postDeployRecoveryBudget)).toBe(true);
    expect(freshPostDeployRecoveryBudget.reasons).toEqual(['lowBucketRecovery', 'usedOverLimit']);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [spawnEvent], freshPostDeployRecoveryBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL * 5, [spawnEvent], freshPostDeployRecoveryBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [safeModeEvent], freshPostDeployRecoveryBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL * 5, [], criticalBucketBudget)).toBe(false);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [spawnEvent], criticalBucketBudget)).toBe(false);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [safeModeEvent], criticalBucketBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [damageOnlyDefenseEvent], criticalBucketBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [spawnEvent], overLimitBudget)).toBe(false);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL * 5, [spawnEvent], overLimitBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [safeModeEvent], overLimitBudget)).toBe(true);
    expect(shouldEmitRuntimeSummary(1, [normalConstructionBlockerEvent])).toBe(false);
    expect(shouldEmitRuntimeSummary(RUNTIME_SUMMARY_INTERVAL, [normalConstructionBlockerEvent])).toBe(true);
    expect(shouldEmitRuntimeSummary(1, [normalConstructionPlacementEvent])).toBe(true);
  });

  it('reports construction-priority runtime use from runtime summary scoring', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
    const onStrategyRegistryRuntimeUse = jest.fn();

    emitRuntimeSummary([colony], [], [], {
      strategyRegistry: DEFAULT_STRATEGY_REGISTRY,
      onStrategyRegistryRuntimeUse
    });

    expect(onStrategyRegistryRuntimeUse).toHaveBeenCalledTimes(1);
    expect(onStrategyRegistryRuntimeUse).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'construction-priority.incumbent.v1',
        family: 'construction-priority'
      })
    );
  });

  it('persists consumed runtime parameter evidence when summary scoring uses patched parameters', () => {
    const parameters = {
      baseScoreWeight: 1,
      territorySignalWeight: 29,
      resourceSignalWeight: 3,
      killSignalWeight: 5,
      riskPenalty: 4
    };
    const parametersSha256 = '8af0d62c55553bc05b705c43d7388473ddaf8191a1d64b6937f1fb230efb7c2f';
    (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETERS_GLOBAL] = {
      runtimeParameterInjection: true,
      candidateParameterScope: 'runtime_injected',
      strategyVariantId: 'construction-priority.pg.territory-seed.v1',
      candidatePolicyId: 'construction-priority.pg.territory-seed.v1',
      sourceStrategyId: 'construction-priority.incumbent.v1',
      family: 'construction-priority',
      parameters,
      parametersSha256
    };
    const runtimePolicyParameters = applyRuntimePolicyParametersToRegistry(DEFAULT_STRATEGY_REGISTRY);
    const recorder = createRuntimePolicyParameterConsumptionRecorder();
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });

    emitRuntimeSummary([colony], [], [], {
      persistOccupationRecommendations: false,
      strategyRegistry: runtimePolicyParameters.registry,
      onStrategyRegistryRuntimeUse: recorder.recordStrategyRuntimeUse
    });
    persistRuntimePolicyParameterConsumptionEvidence(recorder.buildEvidence());

    expect(
      (globalThis as { Memory?: { rlRuntimePolicyParameters?: unknown } }).Memory?.rlRuntimePolicyParameters
    ).toMatchObject({
      runtimeParameterInjection: true,
      consumed: true,
      parameters,
      parametersSha256,
      appliedStrategyIds: ['construction-priority.incumbent.v1'],
      liveEffect: false,
      officialMmoWrites: false,
      officialMmoWritesAllowed: false,
      tick: RUNTIME_SUMMARY_INTERVAL
    });
    expect(
      (globalThis as Record<string, unknown>)[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL]
    ).toMatchObject({
      consumed: true,
      parameters,
      parametersSha256,
      appliedStrategyIds: ['construction-priority.incumbent.v1']
    });
  });

  function parseLoggedSummary(): Record<string, unknown> {
    const runtimeSummaryMessages = logSpy.mock.calls
      .map(([message]) => message)
      .filter(
        (message): message is string =>
          typeof message === 'string' && message.startsWith(RUNTIME_SUMMARY_PREFIX)
      );
    expect(runtimeSummaryMessages).toHaveLength(1);
    const message = runtimeSummaryMessages[0];
    expect(typeof message).toBe('string');
    expect(message.startsWith(RUNTIME_SUMMARY_PREFIX)).toBe(true);

    return JSON.parse(message.slice(RUNTIME_SUMMARY_PREFIX.length)) as Record<string, unknown>;
  }
});

function simulateWorkerIdle(worker: Creep, idleTicks: number): void {
  for (let tick = 1; tick <= idleTicks; tick += 1) {
    recordCreepBehaviorIdle(worker, tick);
  }
}

function makeIdleBehaviorSummary(creepName: string, idleTicks: number): Record<string, unknown> {
  return {
    creepName,
    idleTicks,
    moveTicks: 0,
    workTicks: 0,
    stuckTicks: 0,
    pathFindingFailures: 0,
    destinationBlocked: 0,
    containerTransfers: 0,
    sourceContainerWithdrawals: 0,
    pathLength: 0
  };
}

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
  delete globals[RUNTIME_POLICY_PARAMETERS_GLOBAL];
  delete globals[RUNTIME_POLICY_PARAMETER_CONSUMPTION_GLOBAL];
}

function roundTestRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 1_000 : 0;
}

function installRuntimeTelemetryMemory(): void {
  const globals = globalThis as { Memory?: Partial<Memory> };
  globals.Memory = {
    ...globals.Memory,
    rooms: globals.Memory?.rooms ?? {}
  };
}

function makeColony(options: {
  time: number;
  spawn?: {
    name: string;
    spawning: { name: string; remainingTime: number } | null;
  };
  constructionSites?: unknown[];
  sources?: unknown[];
  droppedResources?: unknown[];
  controllerLevel?: number;
  installGlobals?: boolean;
  includeRoomFind?: boolean;
  includeEventLog?: boolean;
  roomName?: string;
  structures?: unknown[];
  creeps?: unknown[];
}): ColonySnapshot {
  if (options.installGlobals !== false) {
    installRuntimeTelemetryGlobals();
  }
  installRuntimeTelemetryMemory();

  const roomName = options.roomName ?? 'W1N1';
  const room = {
    name: roomName,
    energyAvailable: 250,
    energyCapacityAvailable: 300,
    controller: {
      my: true,
      level: options.controllerLevel ?? 2,
      progress: DEFAULT_TEST_CONTROLLER_PROGRESS,
      progressTotal: DEFAULT_TEST_CONTROLLER_PROGRESS_TOTAL,
      ticksToDowngrade: 15000
    }
  } as unknown as Room;
  const spawn = {
    name: options.spawn?.name ?? (roomName === 'W1N1' ? 'Spawn1' : `Spawn-${roomName}`),
    room,
    structureType: TEST_GLOBALS.STRUCTURE_SPAWN,
    spawning: options.spawn?.spawning ?? null,
    store: makeEnergyStore(50)
  } as unknown as StructureSpawn;
  const structures = options.structures ?? [
    spawn,
    { id: 'storage1', structureType: TEST_GLOBALS.STRUCTURE_STORAGE, store: makeEnergyStore(125) }
  ];
  const constructionSites = options.constructionSites ?? [];
  const sources = options.sources ?? [{ id: 'source1' }, { id: 'source2' }];
  const droppedResources = options.droppedResources ?? [
    { resourceType: TEST_GLOBALS.RESOURCE_ENERGY, amount: 25 },
    { resourceType: 'power', amount: 100 }
  ];
  const roomCreeps = options.creeps ?? [];

  if (options.includeRoomFind !== false) {
    (room as unknown as { find?: jest.Mock }).find = jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
        case TEST_GLOBALS.FIND_CONSTRUCTION_SITES:
          return constructionSites;
        case TEST_GLOBALS.FIND_MY_CREEPS:
          return roomCreeps;
        case TEST_GLOBALS.FIND_DROPPED_RESOURCES:
          return droppedResources;
        case TEST_GLOBALS.FIND_SOURCES:
          return sources;
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

function makeOwnedRuntimeSummaryRoom(roomName: string, controllerLevel: number): Room {
  return {
    name: roomName,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
    controller: {
      my: true,
      owner: { username: 'me' },
      level: controllerLevel,
      ticksToDowngrade: 15_000
    },
    find: jest.fn().mockReturnValue([])
  } as unknown as Room;
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

function makeEnergyStore(
  energy: number,
  capacity = energy
): Record<string, unknown> & {
  getUsedCapacity: (resource?: ResourceConstant) => number;
  getCapacity: (resource?: ResourceConstant) => number;
  getFreeCapacity: (resource?: ResourceConstant) => number;
} {
  return {
    [TEST_GLOBALS.RESOURCE_ENERGY]: energy,
    getUsedCapacity: (resource?: ResourceConstant) => (resource === TEST_GLOBALS.RESOURCE_ENERGY ? energy : 0),
    getCapacity: (resource?: ResourceConstant) => (resource === TEST_GLOBALS.RESOURCE_ENERGY ? capacity : 0),
    getFreeCapacity: (resource?: ResourceConstant) =>
      resource === TEST_GLOBALS.RESOURCE_ENERGY ? Math.max(0, capacity - energy) : 0
  };
}
