import { cleanupDeadCreepMemory, initializeMemory } from '../memory/schema';
import { runDefense } from '../defense/defenseLoop';
import { runEconomy } from '../economy/economyLoop';
import { RUNTIME_SUMMARY_INTERVAL, type RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

const MAX_FORWARDED_DEFENSE_EVENTS_PER_TICK = 5;
const DEFENSE_EVENT_FORWARDING_TTL_TICKS = RUNTIME_SUMMARY_INTERVAL;

export interface KernelDependencies {
  initializeMemory: () => void;
  cleanupDeadCreepMemory: () => void;
  runDefense: () => RuntimeTelemetryEvent[];
  runEconomy: (telemetryEvents?: RuntimeTelemetryEvent[]) => void;
}

export class Kernel {
  private readonly lastForwardedDefenseEventTick = new Map<string, number>();

  public constructor(
    private readonly dependencies: KernelDependencies = {
      initializeMemory,
      cleanupDeadCreepMemory,
      runDefense,
      runEconomy
    }
  ) {}

  public run(): void {
    this.dependencies.initializeMemory();
    this.dependencies.cleanupDeadCreepMemory();
    const defenseEvents = this.dependencies.runDefense();
    this.dependencies.runEconomy(
      selectForwardedDefenseEvents(defenseEvents, this.lastForwardedDefenseEventTick, getGameTime())
    );
  }
}

function selectForwardedDefenseEvents(
  events: RuntimeTelemetryEvent[],
  lastForwardedDefenseEventTick: Map<string, number>,
  tick: number
): RuntimeTelemetryEvent[] {
  const forwardedEvents: RuntimeTelemetryEvent[] = [];
  pruneStaleForwardedDefenseEvents(lastForwardedDefenseEventTick, tick);
  const prioritizedEvents = events
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        getDefenseEventPriority(left.event) - getDefenseEventPriority(right.event) || left.index - right.index
    );

  for (const { event } of prioritizedEvents) {
    if (event.type !== 'defense') {
      forwardedEvents.push(event);
    } else if (shouldForwardDefenseEvent(event, lastForwardedDefenseEventTick, tick)) {
      forwardedEvents.push(event);
    }

    if (forwardedEvents.length >= MAX_FORWARDED_DEFENSE_EVENTS_PER_TICK) {
      return forwardedEvents;
    }
  }

  return forwardedEvents;
}

function shouldForwardDefenseEvent(
  event: Extract<RuntimeTelemetryEvent, { type: 'defense' }>,
  lastForwardedDefenseEventTick: Map<string, number>,
  tick: number
): boolean {
  if (event.action === 'safeMode') {
    return true;
  }

  const key = getDefenseEventForwardingKey(event);
  const lastForwardedTick = lastForwardedDefenseEventTick.get(key);
  if (
    typeof lastForwardedTick === 'number' &&
    tick >= lastForwardedTick &&
    tick - lastForwardedTick < RUNTIME_SUMMARY_INTERVAL
  ) {
    return false;
  }

  lastForwardedDefenseEventTick.set(key, tick);
  return true;
}

function pruneStaleForwardedDefenseEvents(
  lastForwardedDefenseEventTick: Map<string, number>,
  tick: number
): void {
  for (const [key, lastForwardedTick] of lastForwardedDefenseEventTick) {
    if (lastForwardedTick > tick || tick - lastForwardedTick >= DEFENSE_EVENT_FORWARDING_TTL_TICKS) {
      lastForwardedDefenseEventTick.delete(key);
    }
  }
}

function getDefenseEventForwardingKey(event: Extract<RuntimeTelemetryEvent, { type: 'defense' }>): string {
  return [
    event.roomName,
    event.action,
    event.reason,
    event.targetId ?? '',
    event.result ?? '',
    event.hostileCreepCount,
    event.hostileStructureCount,
    event.damagedCriticalStructureCount
  ].join('|');
}

function getDefenseEventPriority(event: RuntimeTelemetryEvent): number {
  if (event.type !== 'defense') {
    return 0;
  }

  switch (event.action) {
    case 'safeMode':
      return 0;
    case 'workerFallback':
      return 1;
    case 'towerAttack':
    case 'towerHeal':
    case 'towerRepair':
    case 'defenderAttack':
      return 2;
    case 'defenderMove':
      return 3;
  }
}

function getGameTime(): number {
  return typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
}
