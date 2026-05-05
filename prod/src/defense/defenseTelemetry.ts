import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';

export const MAX_RECORDED_DEFENSE_ACTIONS = 20;

export type DefenseActionReason =
  | 'hostileVisible'
  | 'criticalStructureDamaged'
  | 'safeModeEarlyRoomThreat'
  | 'workerEmergencyFallback';

export interface DefenseTelemetryContext {
  room: Room;
  hostileCreeps: Creep[];
  hostileStructures: Structure[];
  damagedCriticalStructures: Structure[];
}

export interface DefenseActionInput {
  action: DefenseActionType;
  context: DefenseTelemetryContext;
  reason: DefenseActionReason;
  result?: ScreepsReturnCode;
  structureId?: string;
  targetId?: string;
}

export function recordDefenseAction(
  input: DefenseActionInput,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  const actionMemory: DefenseActionMemory = {
    type: input.action,
    roomName: input.context.room.name,
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

export function buildDefenseTelemetryContext(room: Room): DefenseTelemetryContext {
  const criticalStructures = getCriticalStructures(room);
  return {
    room,
    hostileCreeps: findHostileCreeps(room),
    hostileStructures: findHostileStructures(room),
    damagedCriticalStructures: criticalStructures.filter(isDamagedStructure)
  };
}

export function findHostileCreeps(room: Room): Creep[] {
  return findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS');
}

export function findHostileStructures(room: Room): Structure[] {
  return findRoomObjects<Structure>(room, 'FIND_HOSTILE_STRUCTURES');
}

export function findOwnedStructures(room: Room): AnyOwnedStructure[] {
  return findRoomObjects<AnyOwnedStructure>(room, 'FIND_MY_STRUCTURES');
}

export function findMyCreeps(room: Room): Creep[] {
  return findRoomObjects<Creep>(room, 'FIND_MY_CREEPS');
}

export function getOwnedTowers(room: Room): StructureTower[] {
  return findOwnedStructures(room).filter((structure): structure is StructureTower =>
    matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower')
  );
}

export function getObjectId(object: unknown): string {
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

export function getCreepName(creep: Creep): string {
  return typeof creep.name === 'string' ? creep.name : getObjectId(creep);
}

export function compareObjectIds(left: unknown, right: unknown): number {
  return getObjectId(left).localeCompare(getObjectId(right));
}

export function getEnergyResource(): ResourceConstant {
  const value = (globalThis as Record<string, unknown>).RESOURCE_ENERGY;
  return (typeof value === 'string' ? value : 'energy') as ResourceConstant;
}

export function getGameTime(): number {
  return typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
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

function getCriticalStructures(room: Room): Structure[] {
  const structuresById = new Map<string, Structure>();
  for (const structure of findOwnedStructures(room)) {
    if (isCriticalStructure(structure)) {
      structuresById.set(getObjectId(structure), structure);
    }
  }

  if (room.controller?.my === true) {
    structuresById.set(getObjectId(room.controller), room.controller);
  }

  return [...structuresById.values()].sort(compareObjectIds);
}

function isCriticalStructure(structure: Structure): boolean {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_CONTROLLER', 'controller') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_RAMPART', 'rampart')
  );
}

function isDamagedStructure(structure: Structure): boolean {
  return (
    typeof structure.hits === 'number' &&
    typeof structure.hitsMax === 'number' &&
    structure.hitsMax > 0 &&
    structure.hits < structure.hitsMax
  );
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

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}
