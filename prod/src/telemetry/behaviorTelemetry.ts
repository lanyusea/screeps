export interface RuntimeCreepBehaviorSummary {
  creepName?: string;
  idleTicks: number;
  moveTicks: number;
  workTicks: number;
  stuckTicks: number;
  containerTransfers: number;
  pathLength: number;
  repairTargetId?: string;
}

export interface RuntimeBehaviorSummary {
  creeps: RuntimeCreepBehaviorSummary[];
  totals: RuntimeBehaviorTotals;
  topIdleWorkers?: RuntimeCreepBehaviorSummary[];
}

interface RuntimeBehaviorTotals {
  idleTicks: number;
  moveTicks: number;
  workTicks: number;
  stuckTicks: number;
  containerTransfers: number;
  pathLength: number;
}

interface CreepBehaviorCounterKey {
  key: keyof Pick<
    CreepBehaviorTelemetryMemory,
    'idleTicks' | 'moveTicks' | 'workTicks' | 'stuckTicks' | 'containerTransfers' | 'pathLength'
  >;
}

const BEHAVIOR_COUNTER_KEYS: CreepBehaviorCounterKey[] = [
  { key: 'idleTicks' },
  { key: 'moveTicks' },
  { key: 'workTicks' },
  { key: 'stuckTicks' },
  { key: 'containerTransfers' },
  { key: 'pathLength' }
];
const TOP_IDLE_WORKER_COUNT = 3;

export function observeCreepBehaviorTick(creep: Creep, tick: number = getGameTime()): void {
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastObservedTick === tick) {
    return;
  }

  const currentPosition = getCreepPositionMemory(creep);
  if (currentPosition && telemetry.lastPosition && telemetry.lastMoveTick === tick - 1) {
    const stepDistance = getStepDistance(telemetry.lastPosition, currentPosition);
    if (stepDistance > 0) {
      telemetry.pathLength = (telemetry.pathLength ?? 0) + stepDistance;
    } else {
      telemetry.stuckTicks = (telemetry.stuckTicks ?? 0) + 1;
    }
  }

  if (currentPosition) {
    telemetry.lastPosition = currentPosition;
  }
  telemetry.lastObservedTick = tick;
}

export function recordCreepBehaviorIdle(creep: Creep, tick: number = getGameTime()): void {
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastIdleTick === tick) {
    return;
  }

  telemetry.idleTicks = (telemetry.idleTicks ?? 0) + 1;
  telemetry.lastIdleTick = tick;
}

export function recordCreepBehaviorMove(creep: Creep, tick: number = getGameTime()): void {
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastMoveTick === tick) {
    return;
  }

  telemetry.moveTicks = (telemetry.moveTicks ?? 0) + 1;
  telemetry.lastMoveTick = tick;
}

export function recordCreepBehaviorWork(creep: Creep, tick: number = getGameTime()): void {
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastWorkTick === tick) {
    return;
  }

  telemetry.workTicks = (telemetry.workTicks ?? 0) + 1;
  telemetry.lastWorkTick = tick;
}

export function recordCreepBehaviorRepairTarget(creep: Creep, targetId: string): void {
  ensureCreepBehaviorTelemetry(creep).repairTargetId = targetId;
}

export function recordCreepBehaviorContainerTransfer(creep: Creep): void {
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  telemetry.containerTransfers = (telemetry.containerTransfers ?? 0) + 1;
}

export function summarizeAndResetCreepBehaviorTelemetry(workers: Creep[]): { behavior?: RuntimeBehaviorSummary } {
  const creepSummaries = workers
    .map(toRuntimeCreepBehaviorSummary)
    .filter((summary): summary is RuntimeCreepBehaviorSummary => summary !== null)
    .sort(compareRuntimeCreepBehaviorSummaries);

  if (creepSummaries.length === 0) {
    return {};
  }

  for (const worker of workers) {
    resetCreepBehaviorCounters(worker);
  }

  return {
    behavior: {
      creeps: creepSummaries,
      totals: summarizeBehaviorTotals(creepSummaries),
      ...summarizeTopIdleWorkers(creepSummaries)
    }
  };
}

function ensureCreepBehaviorTelemetry(creep: Creep): CreepBehaviorTelemetryMemory {
  if (!creep.memory.behaviorTelemetry) {
    creep.memory.behaviorTelemetry = {};
  }

  return creep.memory.behaviorTelemetry;
}

function toRuntimeCreepBehaviorSummary(creep: Creep): RuntimeCreepBehaviorSummary | null {
  const telemetry = creep.memory.behaviorTelemetry;
  if (!telemetry || !hasReportableBehaviorTelemetry(telemetry)) {
    return null;
  }

  return {
    ...buildCreepNameSummary(creep),
    idleTicks: getNonNegativeCounter(telemetry.idleTicks),
    moveTicks: getNonNegativeCounter(telemetry.moveTicks),
    workTicks: getNonNegativeCounter(telemetry.workTicks),
    stuckTicks: getNonNegativeCounter(telemetry.stuckTicks),
    containerTransfers: getNonNegativeCounter(telemetry.containerTransfers),
    pathLength: getNonNegativeCounter(telemetry.pathLength),
    ...(typeof telemetry.repairTargetId === 'string' && telemetry.repairTargetId.length > 0
      ? { repairTargetId: telemetry.repairTargetId }
      : {})
  };
}

function hasReportableBehaviorTelemetry(telemetry: CreepBehaviorTelemetryMemory): boolean {
  return (
    BEHAVIOR_COUNTER_KEYS.some(({ key }) => getNonNegativeCounter(telemetry[key]) > 0) ||
    (typeof telemetry.repairTargetId === 'string' && telemetry.repairTargetId.length > 0)
  );
}

function resetCreepBehaviorCounters(creep: Creep): void {
  const telemetry = creep.memory.behaviorTelemetry;
  if (!telemetry) {
    return;
  }

  for (const { key } of BEHAVIOR_COUNTER_KEYS) {
    delete telemetry[key];
  }
  delete telemetry.repairTargetId;
  delete telemetry.lastIdleTick;
  delete telemetry.lastWorkTick;

  if (!telemetry.lastPosition && telemetry.lastMoveTick === undefined && telemetry.lastObservedTick === undefined) {
    delete creep.memory.behaviorTelemetry;
  }
}

function summarizeBehaviorTotals(creeps: RuntimeCreepBehaviorSummary[]): RuntimeBehaviorTotals {
  return creeps.reduce<RuntimeBehaviorTotals>(
    (totals, creep) => ({
      idleTicks: totals.idleTicks + creep.idleTicks,
      moveTicks: totals.moveTicks + creep.moveTicks,
      workTicks: totals.workTicks + creep.workTicks,
      stuckTicks: totals.stuckTicks + creep.stuckTicks,
      containerTransfers: totals.containerTransfers + creep.containerTransfers,
      pathLength: totals.pathLength + creep.pathLength
    }),
    {
      idleTicks: 0,
      moveTicks: 0,
      workTicks: 0,
      stuckTicks: 0,
      containerTransfers: 0,
      pathLength: 0
    }
  );
}

function summarizeTopIdleWorkers(
  creeps: RuntimeCreepBehaviorSummary[]
): { topIdleWorkers?: RuntimeCreepBehaviorSummary[] } {
  const topIdleWorkers = creeps
    .filter((creep) => creep.idleTicks > 0)
    .sort(compareRuntimeIdleWorkerSummaries)
    .slice(0, TOP_IDLE_WORKER_COUNT);

  return topIdleWorkers.length > 0 ? { topIdleWorkers } : {};
}

function compareRuntimeCreepBehaviorSummaries(
  left: RuntimeCreepBehaviorSummary,
  right: RuntimeCreepBehaviorSummary
): number {
  return (left.creepName ?? '').localeCompare(right.creepName ?? '');
}

function compareRuntimeIdleWorkerSummaries(
  left: RuntimeCreepBehaviorSummary,
  right: RuntimeCreepBehaviorSummary
): number {
  return right.idleTicks - left.idleTicks || compareRuntimeCreepBehaviorSummaries(left, right);
}

function buildCreepNameSummary(creep: Creep): { creepName?: string } {
  const name = (creep as Creep & { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? { creepName: name } : {};
}

function getNonNegativeCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getCreepPositionMemory(creep: Creep): CreepBehaviorPositionMemory | null {
  const pos = (creep as Creep & { pos?: Partial<RoomPosition> }).pos;
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.roomName !== 'string') {
    return null;
  }

  return {
    x: pos.x,
    y: pos.y,
    roomName: pos.roomName
  };
}

function getStepDistance(previous: CreepBehaviorPositionMemory, current: CreepBehaviorPositionMemory): number {
  if (previous.roomName !== current.roomName) {
    return 1;
  }

  return Math.max(Math.abs(current.x - previous.x), Math.abs(current.y - previous.y));
}

function getGameTime(): number {
  const game = (globalThis as unknown as { Game?: Partial<Game> }).Game;
  return typeof game?.time === 'number' ? game.time : 0;
}
