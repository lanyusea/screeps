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

  return {
    roomName: colony.room.name,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnStatus: colony.spawns.map(summarizeSpawn),
    taskCounts: countWorkerTasks(colonyWorkers)
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
