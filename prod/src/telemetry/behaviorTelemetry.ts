import { isRuntimeCpuBucketLow } from '../runtime/cpuBudget';

export interface RuntimeCreepBehaviorSummary {
  creepName?: string;
  idleTicks: number;
  moveTicks: number;
  workTicks: number;
  stuckTicks: number;
  pathFindingFailures: number;
  destinationBlocked: number;
  containerTransfers: number;
  sourceContainerWithdrawals: number;
  pathLength: number;
  energyAcquisition?: RuntimeEnergyAcquisitionMethodDistribution;
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
  pathFindingFailures: number;
  destinationBlocked: number;
  containerTransfers: number;
  sourceContainerWithdrawals: number;
  pathLength: number;
  energyAcquisition?: RuntimeEnergyAcquisitionMethodDistribution;
}

export type RuntimeEnergyAcquisitionMethod = 'harvested' | 'pickedUp' | 'withdrawn';

export interface RuntimeEnergyAcquisitionMethodDistribution {
  harvested: number;
  pickedUp: number;
  withdrawn: number;
}

interface CreepBehaviorCounterKey {
  key: keyof Pick<
    CreepBehaviorTelemetryMemory,
    | 'idleTicks'
    | 'moveTicks'
    | 'workTicks'
    | 'stuckTicks'
    | 'containerTransfers'
    | 'sourceContainerWithdrawals'
    | 'energyAcquisitionHarvested'
    | 'energyAcquisitionPickedUp'
    | 'energyAcquisitionWithdrawn'
    | 'pathLength'
  >;
}

const BEHAVIOR_COUNTER_KEYS: CreepBehaviorCounterKey[] = [
  { key: 'idleTicks' },
  { key: 'moveTicks' },
  { key: 'workTicks' },
  { key: 'stuckTicks' },
  { key: 'containerTransfers' },
  { key: 'sourceContainerWithdrawals' },
  { key: 'energyAcquisitionHarvested' },
  { key: 'energyAcquisitionPickedUp' },
  { key: 'energyAcquisitionWithdrawn' },
  { key: 'pathLength' }
];
const TOP_IDLE_WORKER_COUNT = 3;

export function observeCreepBehaviorTick(creep: Creep, tick: number = getGameTime()): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastObservedTick === tick) {
    return;
  }

  const currentPosition = getCreepPositionMemory(creep);
  if (currentPosition && telemetry.lastPosition && telemetry.lastMoveTick === tick - 1) {
    const stepDistance = getStepDistance(telemetry.lastPosition, currentPosition);
    if (stepDistance > 0) {
      telemetry.pathLength = (telemetry.pathLength ?? 0) + stepDistance;
      clearBuildTargetStuckObservation(telemetry);
    } else {
      telemetry.stuckTicks = (telemetry.stuckTicks ?? 0) + 1;
      recordBuildTargetStuckObservation(telemetry);
    }
  }

  if (currentPosition) {
    telemetry.lastPosition = currentPosition;
  }
  telemetry.lastObservedTick = tick;
}

export function recordCreepBehaviorIdle(creep: Creep, tick: number = getGameTime()): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastIdleTick === tick) {
    return;
  }

  telemetry.idleTicks = (telemetry.idleTicks ?? 0) + 1;
  telemetry.lastIdleTick = tick;
}

export function recordCreepBehaviorMove(creep: Creep, tick: number = getGameTime()): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastMoveTick === tick) {
    return;
  }

  telemetry.moveTicks = (telemetry.moveTicks ?? 0) + 1;
  telemetry.lastMoveTick = tick;
}

export function recordCreepBehaviorMoveTask(creep: Creep, task: CreepTaskMemory): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (task.type !== 'build') {
    delete telemetry.lastMoveBuildTargetId;
    clearBuildTargetStuckObservation(telemetry);
    return;
  }

  const targetId = String(task.targetId);
  if (telemetry.lastMoveBuildTargetId !== targetId) {
    clearBuildTargetStuckObservation(telemetry);
  }
  telemetry.lastMoveBuildTargetId = targetId;
}

export function recordCreepBehaviorWork(creep: Creep, tick: number = getGameTime()): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastWorkTick === tick) {
    return;
  }

  telemetry.workTicks = (telemetry.workTicks ?? 0) + 1;
  telemetry.lastWorkTick = tick;
}

export function recordCreepBehaviorRepairTarget(creep: Creep, targetId: string): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  ensureCreepBehaviorTelemetry(creep).repairTargetId = targetId;
}

export function recordCreepBehaviorContainerTransfer(creep: Creep): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  telemetry.containerTransfers = (telemetry.containerTransfers ?? 0) + 1;
}

export function recordCreepBehaviorSourceContainerWithdrawal(creep: Creep, tick: number = getGameTime()): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastSourceContainerWithdrawalTick === tick) {
    return;
  }

  telemetry.sourceContainerWithdrawals = (telemetry.sourceContainerWithdrawals ?? 0) + 1;
  telemetry.lastSourceContainerWithdrawalTick = tick;
}

export function recordCreepBehaviorEnergyAcquisition(
  creep: Creep,
  method: RuntimeEnergyAcquisitionMethod
): void {
  if (shouldSuppressBehaviorTelemetryForCpuRecovery()) {
    return;
  }

  const telemetry = ensureCreepBehaviorTelemetry(creep);
  const key = getEnergyAcquisitionCounterKey(method);
  telemetry[key] = (telemetry[key] ?? 0) + 1;
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

function shouldSuppressBehaviorTelemetryForCpuRecovery(): boolean {
  return isRuntimeCpuBucketLow();
}

function recordBuildTargetStuckObservation(telemetry: CreepBehaviorTelemetryMemory): void {
  const targetId = telemetry.lastMoveBuildTargetId;
  if (!targetId) {
    clearBuildTargetStuckObservation(telemetry);
    return;
  }

  telemetry.buildTargetStuckTicks =
    telemetry.buildTargetStuckTargetId === targetId ? (telemetry.buildTargetStuckTicks ?? 0) + 1 : 1;
  telemetry.buildTargetStuckTargetId = targetId;
}

function clearBuildTargetStuckObservation(telemetry: CreepBehaviorTelemetryMemory): void {
  delete telemetry.buildTargetStuckTicks;
  delete telemetry.buildTargetStuckTargetId;
}

function toRuntimeCreepBehaviorSummary(creep: Creep): RuntimeCreepBehaviorSummary | null {
  const telemetry = creep.memory.behaviorTelemetry;
  if (!telemetry || !hasReportableBehaviorTelemetry(telemetry)) {
    return null;
  }
  const workTicks = getNonNegativeCounter(telemetry.workTicks);
  const stuckTicks = getNonNegativeCounter(telemetry.stuckTicks);
  const pathFindingFailures = summarizePathFindingFailures(stuckTicks, workTicks);

  return {
    ...buildCreepNameSummary(creep),
    idleTicks: getNonNegativeCounter(telemetry.idleTicks),
    moveTicks: getNonNegativeCounter(telemetry.moveTicks),
    workTicks,
    stuckTicks,
    pathFindingFailures,
    destinationBlocked: pathFindingFailures > 0 ? 1 : 0,
    containerTransfers: getNonNegativeCounter(telemetry.containerTransfers),
    sourceContainerWithdrawals: getNonNegativeCounter(telemetry.sourceContainerWithdrawals),
    pathLength: getNonNegativeCounter(telemetry.pathLength),
    ...summarizeEnergyAcquisitionMethods(telemetry),
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
  delete telemetry.lastSourceContainerWithdrawalTick;

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
      pathFindingFailures: totals.pathFindingFailures + creep.pathFindingFailures,
      destinationBlocked: totals.destinationBlocked + creep.destinationBlocked,
      containerTransfers: totals.containerTransfers + creep.containerTransfers,
      sourceContainerWithdrawals: totals.sourceContainerWithdrawals + creep.sourceContainerWithdrawals,
      pathLength: totals.pathLength + creep.pathLength,
      ...mergeEnergyAcquisitionTotals(totals.energyAcquisition, creep.energyAcquisition)
    }),
    {
      idleTicks: 0,
      moveTicks: 0,
      workTicks: 0,
      stuckTicks: 0,
      pathFindingFailures: 0,
      destinationBlocked: 0,
      containerTransfers: 0,
      sourceContainerWithdrawals: 0,
      pathLength: 0
    }
  );
}

function summarizePathFindingFailures(stuckTicks: number, workTicks: number): number {
  return stuckTicks > 0 && workTicks === 0 ? stuckTicks : 0;
}

function summarizeEnergyAcquisitionMethods(
  telemetry: CreepBehaviorTelemetryMemory
): { energyAcquisition?: RuntimeEnergyAcquisitionMethodDistribution } {
  const distribution = {
    harvested: getNonNegativeCounter(telemetry.energyAcquisitionHarvested),
    pickedUp: getNonNegativeCounter(telemetry.energyAcquisitionPickedUp),
    withdrawn: getNonNegativeCounter(telemetry.energyAcquisitionWithdrawn)
  };

  return hasEnergyAcquisitionDistribution(distribution) ? { energyAcquisition: distribution } : {};
}

function mergeEnergyAcquisitionTotals(
  left: RuntimeEnergyAcquisitionMethodDistribution | undefined,
  right: RuntimeEnergyAcquisitionMethodDistribution | undefined
): { energyAcquisition?: RuntimeEnergyAcquisitionMethodDistribution } {
  if (!left && !right) {
    return {};
  }

  const distribution = {
    harvested: (left?.harvested ?? 0) + (right?.harvested ?? 0),
    pickedUp: (left?.pickedUp ?? 0) + (right?.pickedUp ?? 0),
    withdrawn: (left?.withdrawn ?? 0) + (right?.withdrawn ?? 0)
  };

  return hasEnergyAcquisitionDistribution(distribution) ? { energyAcquisition: distribution } : {};
}

function hasEnergyAcquisitionDistribution(distribution: RuntimeEnergyAcquisitionMethodDistribution): boolean {
  return distribution.harvested > 0 || distribution.pickedUp > 0 || distribution.withdrawn > 0;
}

function getEnergyAcquisitionCounterKey(
  method: RuntimeEnergyAcquisitionMethod
): keyof Pick<
  CreepBehaviorTelemetryMemory,
  'energyAcquisitionHarvested' | 'energyAcquisitionPickedUp' | 'energyAcquisitionWithdrawn'
> {
  switch (method) {
    case 'harvested':
      return 'energyAcquisitionHarvested';
    case 'pickedUp':
      return 'energyAcquisitionPickedUp';
    case 'withdrawn':
      return 'energyAcquisitionWithdrawn';
  }
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
