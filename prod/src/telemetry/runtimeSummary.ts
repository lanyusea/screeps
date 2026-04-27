import type { ColonySnapshot } from '../colony/colonyRegistry';

export const RUNTIME_SUMMARY_PREFIX = '#runtime-summary ';
export const RUNTIME_SUMMARY_INTERVAL = 20;
const MAX_REPORTED_EVENTS = 10;

const WORKER_TASK_TYPES = ['harvest', 'transfer', 'build', 'upgrade'] as const;

type WorkerTaskType = (typeof WORKER_TASK_TYPES)[number];

interface WorkerTaskCounts extends Record<WorkerTaskType, number> {
  none: number;
}

export interface RuntimeTelemetryEvent {
  type: 'spawn';
  roomName: string;
  spawnName: string;
  creepName: string;
  role?: string;
  result: ScreepsReturnCode;
}

interface RuntimeSpawnStatus {
  name: string;
  status: 'idle' | 'spawning';
  creepName?: string;
  remainingTime?: number;
}

interface RuntimeRoomSummary {
  roomName: string;
  energyAvailable: number;
  energyCapacity: number;
  workerCount: number;
  spawnStatus: RuntimeSpawnStatus[];
  taskCounts: WorkerTaskCounts;
  controller?: RuntimeControllerSummary;
  resources: RuntimeResourceSummary;
  combat: RuntimeCombatSummary;
}

interface RuntimeControllerSummary {
  level: number;
  progress?: number;
  progressTotal?: number;
  ticksToDowngrade?: number;
}

interface RuntimeResourceEventSummary {
  harvestedEnergy: number;
  transferredEnergy: number;
}

interface RuntimeResourceSummary {
  storedEnergy: number;
  workerCarriedEnergy: number;
  droppedEnergy: number;
  sourceCount: number;
  events?: RuntimeResourceEventSummary;
}

interface RuntimeCombatEventSummary {
  attackCount: number;
  attackDamage: number;
  objectDestroyedCount: number;
  creepDestroyedCount: number;
}

interface RuntimeCombatSummary {
  hostileCreepCount: number;
  hostileStructureCount: number;
  events?: RuntimeCombatEventSummary;
}

interface RuntimeRoomEventMetrics {
  resources?: RuntimeResourceEventSummary;
  combat?: RuntimeCombatEventSummary;
}

interface RuntimeCpuSummary {
  used?: number;
  bucket?: number;
}

interface RuntimeSummary {
  type: 'runtime-summary';
  tick: number;
  rooms: RuntimeRoomSummary[];
  events?: RuntimeTelemetryEvent[];
  omittedEventCount?: number;
  cpu?: RuntimeCpuSummary;
}

export function emitRuntimeSummary(colonies: ColonySnapshot[], creeps: Creep[], events: RuntimeTelemetryEvent[] = []): void {
  if (colonies.length === 0 && events.length === 0) {
    return;
  }

  const tick = getGameTime();
  if (!shouldEmitRuntimeSummary(tick, events)) {
    return;
  }

  const reportedEvents = events.slice(0, MAX_REPORTED_EVENTS);
  const summary: RuntimeSummary = {
    type: 'runtime-summary',
    tick,
    rooms: colonies.map((colony) => summarizeRoom(colony, creeps)),
    ...(reportedEvents.length > 0 ? { events: reportedEvents } : {}),
    ...(events.length > MAX_REPORTED_EVENTS ? { omittedEventCount: events.length - MAX_REPORTED_EVENTS } : {}),
    ...buildCpuSummary()
  };

  console.log(`${RUNTIME_SUMMARY_PREFIX}${JSON.stringify(summary)}`);
}

export function shouldEmitRuntimeSummary(tick: number, events: RuntimeTelemetryEvent[]): boolean {
  return events.length > 0 || (tick > 0 && tick % RUNTIME_SUMMARY_INTERVAL === 0);
}

function summarizeRoom(colony: ColonySnapshot, creeps: Creep[]): RuntimeRoomSummary {
  const colonyWorkers = creeps.filter((creep) => creep.memory.role === 'worker' && creep.memory.colony === colony.room.name);
  const eventMetrics = summarizeRoomEventMetrics(colony.room);

  return {
    roomName: colony.room.name,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnStatus: colony.spawns.map(summarizeSpawn),
    taskCounts: countWorkerTasks(colonyWorkers),
    ...buildControllerSummary(colony.room),
    resources: summarizeResources(colony, colonyWorkers, eventMetrics.resources),
    combat: summarizeCombat(colony.room, eventMetrics.combat)
  };
}

function summarizeSpawn(spawn: StructureSpawn): RuntimeSpawnStatus {
  if (!spawn.spawning) {
    return {
      name: spawn.name,
      status: 'idle'
    };
  }

  return {
    name: spawn.name,
    status: 'spawning',
    creepName: spawn.spawning.name,
    remainingTime: spawn.spawning.remainingTime
  };
}

function countWorkerTasks(workers: Creep[]): WorkerTaskCounts {
  const counts: WorkerTaskCounts = {
    harvest: 0,
    transfer: 0,
    build: 0,
    upgrade: 0,
    none: 0
  };

  for (const worker of workers) {
    const taskType = worker.memory.task?.type as string | undefined;
    if (isWorkerTaskType(taskType)) {
      counts[taskType] += 1;
    } else {
      counts.none += 1;
    }
  }

  return counts;
}

function isWorkerTaskType(taskType: string | undefined): taskType is WorkerTaskType {
  return WORKER_TASK_TYPES.includes(taskType as WorkerTaskType);
}

function buildControllerSummary(room: Room): { controller?: RuntimeControllerSummary } {
  const controller = room.controller;
  if (!controller?.my) {
    return {};
  }

  const summary: RuntimeControllerSummary = {
    level: controller.level
  };

  if (typeof controller.progress === 'number') {
    summary.progress = controller.progress;
  }

  if (typeof controller.progressTotal === 'number') {
    summary.progressTotal = controller.progressTotal;
  }

  if (typeof controller.ticksToDowngrade === 'number') {
    summary.ticksToDowngrade = controller.ticksToDowngrade;
  }

  return { controller: summary };
}

function summarizeResources(
  colony: ColonySnapshot,
  colonyWorkers: Creep[],
  events: RuntimeResourceEventSummary | undefined
): RuntimeResourceSummary {
  const roomStructures = findRoomObjects(colony.room, 'FIND_STRUCTURES') ?? colony.spawns;
  const droppedResources = findRoomObjects(colony.room, 'FIND_DROPPED_RESOURCES') ?? [];
  const sources = findRoomObjects(colony.room, 'FIND_SOURCES') ?? [];

  return {
    storedEnergy: sumEnergyInStores(roomStructures),
    workerCarriedEnergy: sumEnergyInStores(colonyWorkers),
    droppedEnergy: sumDroppedEnergy(droppedResources),
    sourceCount: sources.length,
    ...(events ? { events } : {})
  };
}

function summarizeCombat(room: Room, events: RuntimeCombatEventSummary | undefined): RuntimeCombatSummary {
  const hostileCreeps = findRoomObjects(room, 'FIND_HOSTILE_CREEPS') ?? [];
  const hostileStructures = findRoomObjects(room, 'FIND_HOSTILE_STRUCTURES') ?? [];

  return {
    hostileCreepCount: hostileCreeps.length,
    hostileStructureCount: hostileStructures.length,
    ...(events ? { events } : {})
  };
}

function summarizeRoomEventMetrics(room: Room): RuntimeRoomEventMetrics {
  const eventLog = getRoomEventLog(room);
  if (!eventLog) {
    return {};
  }

  const harvestEvent = getGlobalNumber('EVENT_HARVEST');
  const transferEvent = getGlobalNumber('EVENT_TRANSFER');
  const attackEvent = getGlobalNumber('EVENT_ATTACK');
  const objectDestroyedEvent = getGlobalNumber('EVENT_OBJECT_DESTROYED');
  const resourceEvents: RuntimeResourceEventSummary = {
    harvestedEnergy: 0,
    transferredEnergy: 0
  };
  const combatEvents: RuntimeCombatEventSummary = {
    attackCount: 0,
    attackDamage: 0,
    objectDestroyedCount: 0,
    creepDestroyedCount: 0
  };
  let hasResourceEvents = false;
  let hasCombatEvents = false;

  for (const entry of eventLog) {
    if (!isRecord(entry) || typeof entry.event !== 'number') {
      continue;
    }

    const data = isRecord(entry.data) ? entry.data : {};
    if (entry.event === harvestEvent && isEnergyEventData(data)) {
      resourceEvents.harvestedEnergy += getNumericEventData(data, 'amount');
      hasResourceEvents = true;
    }

    if (entry.event === transferEvent && isEnergyEventData(data)) {
      resourceEvents.transferredEnergy += getNumericEventData(data, 'amount');
      hasResourceEvents = true;
    }

    if (entry.event === attackEvent) {
      combatEvents.attackCount += 1;
      combatEvents.attackDamage += getNumericEventData(data, 'damage');
      hasCombatEvents = true;
    }

    if (entry.event === objectDestroyedEvent) {
      combatEvents.objectDestroyedCount += 1;
      if (data.type === 'creep') {
        combatEvents.creepDestroyedCount += 1;
      }
      hasCombatEvents = true;
    }
  }

  return {
    ...(hasResourceEvents ? { resources: resourceEvents } : {}),
    ...(hasCombatEvents ? { combat: combatEvents } : {})
  };
}

function findRoomObjects(room: Room, constantName: string): unknown[] | undefined {
  const findConstant = getGlobalNumber(constantName);
  const find = (room as unknown as { find?: unknown }).find;
  if (typeof findConstant !== 'number' || typeof find !== 'function') {
    return undefined;
  }

  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return undefined;
  }
}

function getRoomEventLog(room: Room): unknown[] | undefined {
  const getEventLog = (room as unknown as { getEventLog?: unknown }).getEventLog;
  if (typeof getEventLog !== 'function') {
    return undefined;
  }

  try {
    const eventLog = getEventLog.call(room);
    return Array.isArray(eventLog) ? eventLog : undefined;
  } catch {
    return undefined;
  }
}

function sumEnergyInStores(objects: unknown[]): number {
  return objects.reduce<number>((total, object) => total + getEnergyInStore(object), 0);
}

function getEnergyInStore(object: unknown): number {
  if (!isRecord(object) || !isRecord(object.store)) {
    return 0;
  }

  const getUsedCapacity = object.store.getUsedCapacity;
  if (typeof getUsedCapacity === 'function') {
    const usedCapacity = getUsedCapacity.call(object.store, getEnergyResource());
    return typeof usedCapacity === 'number' ? usedCapacity : 0;
  }

  const storedEnergy = object.store[getEnergyResource()];
  return typeof storedEnergy === 'number' ? storedEnergy : 0;
}

function sumDroppedEnergy(droppedResources: unknown[]): number {
  const energyResource = getEnergyResource();

  return droppedResources.reduce<number>((total, droppedResource) => {
    if (!isRecord(droppedResource) || droppedResource.resourceType !== energyResource) {
      return total;
    }

    return total + (typeof droppedResource.amount === 'number' ? droppedResource.amount : 0);
  }, 0);
}

function isEnergyEventData(data: Record<string, unknown>): boolean {
  return data.resourceType === undefined || data.resourceType === getEnergyResource();
}

function getNumericEventData(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === 'number' ? value : 0;
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getEnergyResource(): ResourceConstant {
  const value = (globalThis as Record<string, unknown>).RESOURCE_ENERGY;
  return (typeof value === 'string' ? value : 'energy') as ResourceConstant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildCpuSummary(): { cpu?: RuntimeCpuSummary } {
  const gameWithOptionalCpu = Game as Game & {
    cpu?: {
      getUsed?: () => number;
      bucket?: number;
    };
  };
  const cpu = gameWithOptionalCpu.cpu;
  if (!cpu) {
    return {};
  }

  const summary: RuntimeCpuSummary = {};
  if (typeof cpu.getUsed === 'function') {
    summary.used = cpu.getUsed();
  }

  if (typeof cpu.bucket === 'number') {
    summary.bucket = cpu.bucket;
  }

  return Object.keys(summary).length > 0 ? { cpu: summary } : {};
}

function getGameTime(): number {
  return typeof Game.time === 'number' ? Game.time : 0;
}
