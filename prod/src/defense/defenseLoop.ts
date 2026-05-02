import { getOwnedColonies, type ColonySnapshot } from '../colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  hasSafeRouteAvoidingDeadZones,
  isKnownDeadZoneRoom,
  refreshVisibleDeadZoneMemory
} from './deadZone';

export const DEFENDER_ROLE = 'defender';

const MAX_RECORDED_DEFENSE_ACTIONS = 20;
const CRITICAL_STRUCTURE_DAMAGE_RATIO = 0.85;
const SAFE_MODE_CRITICAL_DAMAGE_RATIO = 0.75;
const EARLY_ROOM_SAFE_MODE_RCL = 3;
const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

type CriticalOwnedStructure = StructureSpawn | StructureTower;
type HostileTarget = Creep | Structure;
type DefenseActionReason =
  | 'hostileVisible'
  | 'criticalStructureDamaged'
  | 'safeModeEarlyRoomThreat'
  | 'workerEmergencyFallback';

interface DefenseContext {
  colony: ColonySnapshot;
  criticalStructures: CriticalOwnedStructure[];
  damagedCriticalStructures: CriticalOwnedStructure[];
  hostileCreeps: Creep[];
  hostileStructures: Structure[];
  towers: StructureTower[];
}

interface DefenseActionInput {
  action: DefenseActionType;
  context: DefenseContext;
  reason: DefenseActionReason;
  result?: ScreepsReturnCode;
  structureId?: string;
  targetId?: string;
}

interface TowerDefenseResult {
  attackSucceeded: boolean;
  attackingTowerIds: Set<string>;
}

export function runDefense(): RuntimeTelemetryEvent[] {
  const telemetryEvents: RuntimeTelemetryEvent[] = [];
  refreshVisibleDeadZoneMemory();
  const colonies = getOwnedColonies();

  for (const colony of colonies) {
    runColonyDefense(createDefenseContext(colony), telemetryEvents);
  }

  runDefenders(Object.values(Game.creeps), telemetryEvents);

  return telemetryEvents;
}

function runColonyDefense(context: DefenseContext, telemetryEvents: RuntimeTelemetryEvent[]): void {
  const towerDefenseResult = runTowerDefense(context, telemetryEvents);
  const safeModeActivated = activateSafeModeWhenNeeded(
    context,
    towerDefenseResult.attackSucceeded,
    telemetryEvents
  );

  if (safeModeActivated) {
    return;
  }

  if (runTowerRecovery(context, telemetryEvents, towerDefenseResult.attackingTowerIds)) {
    return;
  }

  if (towerDefenseResult.attackSucceeded) {
    return;
  }

  recordWorkerFallbackIfNeeded(context, telemetryEvents);
}

function runTowerDefense(context: DefenseContext, telemetryEvents: RuntimeTelemetryEvent[]): TowerDefenseResult {
  const defenseResult: TowerDefenseResult = {
    attackSucceeded: false,
    attackingTowerIds: new Set<string>()
  };

  if (context.hostileCreeps.length === 0 && context.hostileStructures.length === 0) {
    return defenseResult;
  }

  for (const tower of getUsableTowers(context.towers)) {
    if (typeof tower.attack !== 'function') {
      continue;
    }

    const target = selectTowerAttackTarget(tower, context);
    if (!target) {
      continue;
    }

    const attackResult = tower.attack(target);
    recordDefenseAction(
      {
        action: 'towerAttack',
        context,
        reason: 'hostileVisible',
        result: attackResult,
        structureId: getObjectId(tower),
        targetId: getObjectId(target)
      },
      telemetryEvents
    );
    if (attackResult === OK_CODE) {
      defenseResult.attackSucceeded = true;
      defenseResult.attackingTowerIds.add(getObjectId(tower));
    }
  }

  return defenseResult;
}

function activateSafeModeWhenNeeded(
  context: DefenseContext,
  towerAttackSucceeded: boolean,
  telemetryEvents: RuntimeTelemetryEvent[]
): boolean {
  if (!shouldActivateSafeMode(context, towerAttackSucceeded)) {
    return false;
  }

  const result = context.colony.room.controller?.activateSafeMode?.();
  if (typeof result !== 'number') {
    return false;
  }

  recordDefenseAction(
    {
      action: 'safeMode',
      context,
      reason: 'safeModeEarlyRoomThreat',
      result,
      targetId: getObjectId(context.colony.room.controller)
    },
    telemetryEvents
  );

  return result === OK_CODE;
}

function runTowerRecovery(
  context: DefenseContext,
  telemetryEvents: RuntimeTelemetryEvent[],
  attackingTowerIds: Set<string>
): boolean {
  let acted = false;

  for (const tower of getUsableTowers(context.towers)) {
    if (attackingTowerIds.has(getObjectId(tower))) {
      continue;
    }

    const woundedCreep = selectWoundedFriendlyCreep(context.colony.room, tower);
    if (woundedCreep && typeof tower.heal === 'function') {
      const result = tower.heal(woundedCreep);
      recordDefenseAction(
        {
          action: 'towerHeal',
          context,
          reason: 'criticalStructureDamaged',
          result,
          structureId: getObjectId(tower),
          targetId: getObjectId(woundedCreep)
        },
        telemetryEvents
      );
      acted = true;
      continue;
    }

    const repairTarget = selectClosestTarget(tower, context.damagedCriticalStructures);
    if (repairTarget && typeof tower.repair === 'function') {
      const result = tower.repair(repairTarget);
      recordDefenseAction(
        {
          action: 'towerRepair',
          context,
          reason: 'criticalStructureDamaged',
          result,
          structureId: getObjectId(tower),
          targetId: getObjectId(repairTarget)
        },
        telemetryEvents
      );
      acted = true;
    }
  }

  return acted;
}

function recordWorkerFallbackIfNeeded(
  context: DefenseContext,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  if (!hasDefensePressure(context) || !hasColonyWorker(context.colony.room.name)) {
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

function shouldActivateSafeMode(context: DefenseContext, towerAttackSucceeded: boolean): boolean {
  const controller = context.colony.room.controller;
  if (
    context.hostileCreeps.length === 0 ||
    controller?.my !== true ||
    typeof controller.activateSafeMode !== 'function' ||
    !isEarlyRoomController(controller) ||
    !isSafeModeAvailable(controller)
  ) {
    return false;
  }

  return (
    context.colony.spawns.length === 0 ||
    !towerAttackSucceeded ||
    context.damagedCriticalStructures.some(isSeverelyDamagedCriticalStructure)
  );
}

function isEarlyRoomController(controller: StructureController): boolean {
  return typeof controller.level !== 'number' || controller.level <= EARLY_ROOM_SAFE_MODE_RCL;
}

function isSafeModeAvailable(controller: StructureController): boolean {
  const available = controller.safeModeAvailable;
  const cooldown = controller.safeModeCooldown;
  const active = controller.safeMode;

  return (
    typeof available === 'number' &&
    available > 0 &&
    (typeof cooldown !== 'number' || cooldown <= 0) &&
    (typeof active !== 'number' || active <= 0)
  );
}

function createDefenseContext(colony: ColonySnapshot): DefenseContext {
  const criticalStructures = getCriticalStructures(colony);
  return {
    colony,
    criticalStructures,
    damagedCriticalStructures: criticalStructures.filter(isDamagedCriticalStructure),
    hostileCreeps: findHostileCreeps(colony.room),
    hostileStructures: findHostileStructures(colony.room),
    towers: getOwnedTowers(colony.room)
  };
}

function hasDefensePressure(context: DefenseContext): boolean {
  return (
    context.hostileCreeps.length > 0 ||
    context.hostileStructures.length > 0 ||
    context.damagedCriticalStructures.length > 0
  );
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

function getUsableTowers(towers: StructureTower[]): StructureTower[] {
  return towers.filter(hasStoredEnergy).sort(compareObjectIds);
}

function hasStoredEnergy(structure: {
  store?: { getUsedCapacity?: (resource?: ResourceConstant) => number | null };
}): boolean {
  const store = structure.store;
  if (!store || typeof store.getUsedCapacity !== 'function') {
    return true;
  }

  const usedCapacity = store.getUsedCapacity(getEnergyResource());
  return typeof usedCapacity !== 'number' || usedCapacity > 0;
}

function selectWoundedFriendlyCreep(room: Room, tower: StructureTower): Creep | null {
  const woundedCreeps = findMyCreeps(room).filter(isWoundedCreep);
  return selectClosestTarget(tower, woundedCreeps);
}

function selectTowerAttackTarget(tower: StructureTower, context: DefenseContext): HostileTarget | null {
  const hostileCreep = selectClosestTarget(tower, context.hostileCreeps);
  if (hostileCreep) {
    return hostileCreep;
  }

  return selectClosestTarget(tower, context.hostileStructures);
}

function selectDefenderTarget(creep: Creep): HostileTarget | null {
  const hostileCreep = selectClosestTarget(creep, findHostileCreeps(creep.room));
  if (hostileCreep) {
    return hostileCreep;
  }

  return selectClosestTarget(creep, findHostileStructures(creep.room));
}

function selectClosestTarget<T extends { pos?: RoomPosition }>(
  origin: { pos?: RoomPosition },
  targets: T[]
): T | null {
  if (targets.length === 0) {
    return null;
  }

  return [...targets].sort((left, right) => compareRange(origin, left, right) || compareObjectIds(left, right))[0];
}

function compareRange(
  origin: { pos?: RoomPosition },
  left: { pos?: RoomPosition },
  right: { pos?: RoomPosition }
): number {
  const getRangeTo = origin.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return 0;
  }

  const leftRange = left.pos ? getRangeTo.call(origin.pos, left.pos) : Infinity;
  const rightRange = right.pos ? getRangeTo.call(origin.pos, right.pos) : Infinity;
  return leftRange - rightRange;
}

function isDamagedCriticalStructure(structure: CriticalOwnedStructure): boolean {
  return isStructureBelowHitsRatio(structure, CRITICAL_STRUCTURE_DAMAGE_RATIO);
}

function isSeverelyDamagedCriticalStructure(structure: CriticalOwnedStructure): boolean {
  return isStructureBelowHitsRatio(structure, SAFE_MODE_CRITICAL_DAMAGE_RATIO);
}

function isStructureBelowHitsRatio(structure: CriticalOwnedStructure, ratio: number): boolean {
  return (
    typeof structure.hits === 'number' &&
    typeof structure.hitsMax === 'number' &&
    structure.hitsMax > 0 &&
    structure.hits < structure.hitsMax * ratio
  );
}

function isWoundedCreep(creep: Creep): boolean {
  return typeof creep.hits === 'number' && typeof creep.hitsMax === 'number' && creep.hits < creep.hitsMax;
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

function findMyCreeps(room: Room): Creep[] {
  return findRoomObjects<Creep>(room, 'FIND_MY_CREEPS');
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

function getEnergyResource(): ResourceConstant {
  const value = (globalThis as Record<string, unknown>).RESOURCE_ENERGY;
  return (typeof value === 'string' ? value : 'energy') as ResourceConstant;
}

function getGameTime(): number {
  return typeof Game.time === 'number' ? Game.time : 0;
}
