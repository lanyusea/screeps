import type { ColonySnapshot } from '../src/colony/colonyRegistry';
import {
  emitRuntimeSummary,
  RUNTIME_SUMMARY_INTERVAL,
  RUNTIME_SUMMARY_PREFIX,
  shouldEmitRuntimeSummary,
  type RuntimeTelemetryEvent
} from '../src/telemetry/runtimeSummary';

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
  EVENT_ATTACK: 203,
  EVENT_OBJECT_DESTROYED: 204,
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
            events: {
              harvestedEnergy: 10,
              transferredEnergy: 5
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
              },
              {
                buildItem: 'build source/controller roads',
                room: 'W1N1',
                score: 21,
                urgency: 'low',
                preconditions: [],
                expectedKpiMovement: ['reduces worker travel time', 'improves harvest-to-spawn throughput'],
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

  it('reports bounded room-level worker efficiency samples', () => {
    const colony = makeColony({ time: RUNTIME_SUMMARY_INTERVAL });
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
                  reason: 'noNearbyEnergy'
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
          reason: 'urgentSpawnExtensionRefill'
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
      nearbyEnergyChoiceCount: 4,
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
          reason: 'noNearbyEnergy'
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
          reason: 'noNearbyEnergy'
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
      controller: { my: false } as StructureController,
      sourceCount: 2
    });

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
      action: 'claim'
    });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: RUNTIME_SUMMARY_INTERVAL
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
  installGlobals?: boolean;
  includeRoomFind?: boolean;
  includeEventLog?: boolean;
}): ColonySnapshot {
  if (options.installGlobals !== false) {
    installRuntimeTelemetryGlobals();
  }

  const room = {
    name: 'W1N1',
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
    name: options.spawn?.name ?? 'Spawn1',
    room,
    spawning: options.spawn?.spawning ?? null,
    store: makeEnergyStore(50)
  } as unknown as StructureSpawn;
  const structures = [spawn, { store: makeEnergyStore(125) }];

  if (options.includeRoomFind !== false) {
    (room as unknown as { find?: jest.Mock }).find = jest.fn((findType: number): unknown[] => {
      switch (findType) {
        case TEST_GLOBALS.FIND_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_MY_STRUCTURES:
          return structures;
        case TEST_GLOBALS.FIND_MY_CONSTRUCTION_SITES:
          return [];
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
      { event: TEST_GLOBALS.EVENT_ATTACK, data: { damage: 30 } },
      { event: TEST_GLOBALS.EVENT_OBJECT_DESTROYED, data: { type: 'creep' } }
    ]);
  }

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: options.time,
    rooms: { W1N1: room },
    spawns: { [spawn.name]: spawn },
    creeps: {},
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
          return Array.from({ length: options.sourceCount ?? 0 }, (_value, index) => ({ id: `source${index}` }));
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
