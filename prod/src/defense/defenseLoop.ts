import { getOwnedColonies, type ColonySnapshot } from '../colony/colonyRegistry';
import { isRuntimeCpuBucketLow } from '../runtime/cpuBudget';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import { isDamagedStructure } from './defenseTelemetry';
import {
  hasSafeRouteAvoidingDeadZones,
  isKnownDeadZoneRoom,
  refreshVisibleDeadZoneMemory
} from './deadZone';
import {
  DEFENDER_ROLE,
  hasControllerAttackPressure,
  hasDefensePressure,
  selectDefenderAttackTarget
} from './defensePlanner';
import { runSafeModeWithResult } from './safeModeManager';
import { runTowersWithResult, type TowerPriorityTargetGroup } from './towerManager';
import {
  getDefenseThreatLevel,
  getDefenseThreatPriority,
  recordColonyThreats,
  type DefenseThreatObservation
} from './colonyThreats';

export { DEFENDER_ROLE } from './defensePlanner';

const MAX_RECORDED_DEFENSE_ACTIONS = 20;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;
type CriticalOwnedStructure = StructureSpawn | StructureTower;
type HostileTarget = Creep | Structure;
type DefenseActionReason =
  | 'hostileVisible'
  | 'criticalStructureDamaged'
  | 'safeModeEarlyRoomThreat'
  | 'workerEmergencyFallback';

interface DefenseContext {
  colony: ColonySnapshot;
  damagedCriticalStructures: CriticalOwnedStructure[];
  hostileCreeps: Creep[];
  hostileStructures: Structure[];
}

interface DefenseActionInput {
  action: DefenseActionType;
  context: DefenseContext;
  reason: DefenseActionReason;
  result?: ScreepsReturnCode;
  structureId?: string;
  targetId?: string;
}

export function runDefense(): RuntimeTelemetryEvent[] {
  const telemetryEvents: RuntimeTelemetryEvent[] = [];
  const shedNonessentialCpuWork = isRuntimeCpuBucketLow();
  refreshVisibleDeadZoneMemory();
  const colonies = getOwnedColonies();
  const contexts = colonies.map(createDefenseContext);
  recordColonyThreats(contexts.map(buildThreatObservation));
  const towerPriorityTargetGroups = buildTowerPriorityTargetGroups(contexts);

  for (const context of contexts) {
    runColonyDefense(
      context,
      telemetryEvents,
      towerPriorityTargetGroups,
      shouldAllowPassiveTowerRecovery(context, shedNonessentialCpuWork)
    );
  }

  runDefenders(Object.values(Game.creeps), telemetryEvents);

  return telemetryEvents;
}

function runColonyDefense(
  context: DefenseContext,
  telemetryEvents: RuntimeTelemetryEvent[],
  towerPriorityTargetGroups: TowerPriorityTargetGroup[],
  allowPassiveTowerRecovery: boolean
): void {
  const towerDefenseResult = runTowersWithResult(context.colony.room, {
    priorityTargetGroups: towerPriorityTargetGroups,
    allowRecoveryActions: allowPassiveTowerRecovery
  });
  telemetryEvents.push(...towerDefenseResult.events);
  const safeModeResult = runSafeModeWithResult(context.colony.room);
  telemetryEvents.push(...safeModeResult.events);

  if (safeModeResult.activated) {
    return;
  }

  if (towerDefenseResult.attackSucceeded || towerDefenseResult.actedTowerIds.size > 0) {
    return;
  }

  recordWorkerFallbackIfNeeded(context, telemetryEvents);
}

function shouldAllowPassiveTowerRecovery(context: DefenseContext, shedNonessentialCpuWork: boolean): boolean {
  if (!shedNonessentialCpuWork) {
    return true;
  }

  return (
    context.hostileCreeps.length > 0 ||
    context.hostileStructures.length > 0 ||
    context.damagedCriticalStructures.length > 0
  );
}

function recordWorkerFallbackIfNeeded(
  context: DefenseContext,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  if (
    !hasDefensePressure({
      hostileCreepCount: context.hostileCreeps.length,
      hostileStructureCount: context.hostileStructures.length,
      damagedCriticalStructureCount: context.damagedCriticalStructures.length
    }) ||
    !hasColonyWorker(context.colony.room.name)
  ) {
    return;
  }

  recordDefenseAction(
    {
      action: 'workerFallback',
      context,
      reason: 'workerEmergencyFallback'
    },
    telemetryEvents
  );
}

function runDefenders(creeps: Creep[], telemetryEvents: RuntimeTelemetryEvent[]): void {
  for (const creep of creeps) {
    if (creep.memory.role !== DEFENDER_ROLE) {
      continue;
    }

    runDefender(creep, telemetryEvents);
  }
}

function runDefender(creep: Creep, telemetryEvents: RuntimeTelemetryEvent[]): void {
  const colonyName = creep.memory.colony ?? creep.memory.defense?.homeRoom;
  if (!colonyName) {
    return;
  }

  const target = selectDefenderTarget(creep);
  if (!target && moveTowardAssignedDefenseRoom(creep)) {
    return;
  }

  if (target && typeof creep.attack === 'function') {
    const attackResult = creep.attack(target);
    if (attackResult === ERR_NOT_IN_RANGE_CODE) {
      if (shouldSuppressDefenderMove(creep, target)) {
        return;
      }

      if (typeof creep.moveTo === 'function') {
        const moveResult = creep.moveTo(target);
        recordDefenderAction(creep, 'defenderMove', target, moveResult, telemetryEvents);
        return;
      }
    }

    recordDefenderAction(creep, 'defenderAttack', target, attackResult, telemetryEvents);
  }
}

function moveTowardAssignedDefenseRoom(creep: Creep): boolean {
  const defenseRoom = creep.memory.defense?.homeRoom;
  if (!defenseRoom || creep.room?.name === defenseRoom || typeof creep.moveTo !== 'function') {
    return false;
  }

  const visibleRoom = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[defenseRoom];
  if (visibleRoom?.controller) {
    creep.moveTo(visibleRoom.controller);
    return true;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
  if (typeof RoomPositionCtor !== 'function') {
    return false;
  }

  creep.moveTo(new RoomPositionCtor(25, 25, defenseRoom));
  return true;
}

function shouldSuppressDefenderMove(creep: Creep, target: HostileTarget): boolean {
  const targetRoom = target.pos?.roomName;
  if (!targetRoom || targetRoom === creep.room.name || !isKnownDeadZoneRoom(targetRoom)) {
    return false;
  }

  return hasSafeRouteAvoidingDeadZones(creep.room.name, targetRoom) === false;
}

function recordDefenderAction(
  creep: Creep,
  action: Extract<DefenseActionType, 'defenderAttack' | 'defenderMove'>,
  target: HostileTarget,
  result: ScreepsReturnCode,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  const roomName = creep.room.name;
  const context = createDefenseContext({
    room: creep.room,
    spawns: Object.values(Game.spawns).filter((spawn) => spawn.room.name === roomName),
    energyAvailable: creep.room.energyAvailable,
    energyCapacityAvailable: creep.room.energyCapacityAvailable
  });

  recordDefenseAction(
    {
      action,
      context,
      reason: 'hostileVisible',
      result,
      structureId: getCreepName(creep),
      targetId: getObjectId(target)
    },
    telemetryEvents
  );
}

function createDefenseContext(colony: ColonySnapshot): DefenseContext {
  const criticalStructures = getCriticalStructures(colony);
  return {
    colony,
    damagedCriticalStructures: criticalStructures.filter(isDamagedStructure),
    hostileCreeps: findHostileCreeps(colony.room),
    hostileStructures: findHostileStructures(colony.room)
  };
}

function buildThreatObservation(context: DefenseContext): DefenseThreatObservation {
  return {
    roomName: context.colony.room.name,
    hostileCreepCount: context.hostileCreeps.length,
    hostileStructureCount: context.hostileStructures.length,
    damagedCriticalStructureCount: context.damagedCriticalStructures.length,
    controllerUnderAttack: hasControllerAttackPressure(context.colony.room.controller)
  };
}

function buildTowerPriorityTargetGroups(contexts: DefenseContext[]): TowerPriorityTargetGroup[] {
  return contexts
    .map((context) => ({ context, level: getDefenseThreatLevel(buildThreatObservation(context)) }))
    .filter(({ level }) => level !== 'none')
    .sort(
      (left, right) =>
        getDefenseThreatPriority(right.level) - getDefenseThreatPriority(left.level) ||
        left.context.colony.room.name.localeCompare(right.context.colony.room.name)
    )
    .map(({ context }) => ({
      hostileCreeps: context.hostileCreeps,
      hostileStructures: context.hostileStructures
    }));
}

function getCriticalStructures(colony: ColonySnapshot): CriticalOwnedStructure[] {
  const structuresById = new Map<string, CriticalOwnedStructure>();
  for (const spawn of colony.spawns) {
    structuresById.set(getObjectId(spawn), spawn);
  }

  for (const tower of getOwnedTowers(colony.room)) {
    structuresById.set(getObjectId(tower), tower);
  }

  return [...structuresById.values()].sort(compareObjectIds);
}

function getOwnedTowers(room: Room): StructureTower[] {
  return findOwnedStructures(room).filter((structure): structure is StructureTower =>
    matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower')
  );
}

function selectDefenderTarget(creep: Creep): HostileTarget | null {
  return selectDefenderAttackTarget(creep, findHostileCreeps(creep.room), findHostileStructures(creep.room));
}

function hasColonyWorker(roomName: string): boolean {
  return Object.values(Game.creeps).some(
    (creep) => creep.memory.role === 'worker' && creep.memory.colony === roomName
  );
}

function recordDefenseAction(input: DefenseActionInput, telemetryEvents: RuntimeTelemetryEvent[]): void {
  const actionMemory: DefenseActionMemory = {
    type: input.action,
    roomName: input.context.colony.room.name,
    tick: getGameTime(),
    reason: input.reason,
    hostileCreepCount: input.context.hostileCreeps.length,
    hostileStructureCount: input.context.hostileStructures.length,
    damagedCriticalStructureCount: input.context.damagedCriticalStructures.length,
    ...(input.structureId ? { structureId: input.structureId } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(typeof input.result === 'number' ? { result: input.result } : {})
  };

  recordDefenseActionMemory(actionMemory);
  telemetryEvents.push({
    type: 'defense',
    action: actionMemory.type,
    roomName: actionMemory.roomName,
    reason: actionMemory.reason,
    hostileCreepCount: actionMemory.hostileCreepCount,
    hostileStructureCount: actionMemory.hostileStructureCount,
    damagedCriticalStructureCount: actionMemory.damagedCriticalStructureCount,
    ...(actionMemory.structureId ? { structureId: actionMemory.structureId } : {}),
    ...(actionMemory.targetId ? { targetId: actionMemory.targetId } : {}),
    ...(typeof actionMemory.result === 'number' ? { result: actionMemory.result } : {}),
    tick: actionMemory.tick
  });
}

function recordDefenseActionMemory(action: DefenseActionMemory): void {
  const globalMemory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!globalMemory) {
    return;
  }

  const defenseMemory = globalMemory.defense ?? {};
  const rooms = defenseMemory.rooms ?? {};
  rooms[action.roomName] = action;
  defenseMemory.rooms = rooms;
  defenseMemory.actions = [action, ...(defenseMemory.actions ?? [])].slice(0, MAX_RECORDED_DEFENSE_ACTIONS);
  globalMemory.defense = defenseMemory;
}

function findHostileCreeps(room: Room): Creep[] {
  return findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS');
}

function findHostileStructures(room: Room): Structure[] {
  return findRoomObjects<Structure>(room, 'FIND_HOSTILE_STRUCTURES');
}

function findOwnedStructures(room: Room): AnyOwnedStructure[] {
  return findRoomObjects<AnyOwnedStructure>(room, 'FIND_MY_STRUCTURES');
}

function findRoomObjects<T>(room: Room, constantName: string): T[] {
  const findConstant = getGlobalNumber(constantName);
  const find = (room as Room & { find?: unknown }).find;
  if (typeof findConstant !== 'number' || typeof find !== 'function') {
    return [];
  }

  try {
    const result = (find as (type: number) => unknown).call(room, findConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function matchesStructureType(value: unknown, globalName: string, fallback: string): boolean {
  const expectedValue = (globalThis as Record<string, unknown>)[globalName] ?? fallback;
  return value === expectedValue;
}

function compareObjectIds(left: unknown, right: unknown): number {
  return getObjectId(left).localeCompare(getObjectId(right));
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  if (typeof candidate.name === 'string') {
    return candidate.name;
  }

  return '';
}

function getCreepName(creep: Creep): string {
  return typeof creep.name === 'string' ? creep.name : getObjectId(creep);
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getGameTime(): number {
  return typeof Game.time === 'number' ? Game.time : 0;
}
