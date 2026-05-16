import type { ColonySnapshot } from '../colony/colonyRegistry';
import { CONTROLLER_DOWNGRADE_GUARD_SPAWN_TICKS } from '../colony/colonyStage';
import { ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION } from '../config/roomSelection';
import { getSpawnEnergyBufferRequirement } from '../economy/spawnEnergyBuffer';
import { TERRITORY_SCOUT_BODY_COST } from '../spawn/bodyBuilder';

const THREAT_MEMORY_STALE_TICKS = 5;

type FindConstantName = 'FIND_HOSTILE_CREEPS' | 'FIND_HOSTILE_STRUCTURES' | 'FIND_MY_STRUCTURES' | 'FIND_STRUCTURES';

export function getPassiveScoutOnlyTargetRooms(colonyName: string): readonly string[] {
  return colonyName === ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION.colony
    ? [ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION.roomName]
    : [];
}

export function isPassiveScoutOnlyTarget(colonyName: string, targetRoom: string): boolean {
  return (
    colonyName === ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION.colony &&
    targetRoom === ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION.roomName
  );
}

export function isPassiveScoutGateOpen(
  colony: ColonySnapshot | string,
  targetRoom: string,
  gameTime = getGameTime()
): boolean {
  const colonyName = getColonyName(colony);
  if (!isPassiveScoutOnlyTarget(colonyName, targetRoom)) {
    return true;
  }

  const room = getColonyRoom(colony, colonyName);
  if (!room || !isOwnedRcl3Room(room) || hasControllerDowngradeRisk(room)) {
    return false;
  }

  const spawns = getColonySpawns(colony, colonyName);
  return (
    hasOwnedTower(room) &&
    !hasVisibleLocalThreat(room) &&
    !hasRecentLocalThreatMemory(colonyName, gameTime) &&
    spawns.some(isActiveIdleSpawn) &&
    hasHealthyScoutEnergyBuffer(colony, room, spawns)
  );
}

function getColonyName(colony: ColonySnapshot | string): string {
  return typeof colony === 'string' ? colony : colony.room.name;
}

function getColonyRoom(colony: ColonySnapshot | string, colonyName: string): Room | undefined {
  if (typeof colony !== 'string') {
    return colony.room;
  }

  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[colonyName];
}

function getColonySpawns(colony: ColonySnapshot | string, colonyName: string): StructureSpawn[] {
  if (typeof colony !== 'string') {
    return colony.spawns;
  }

  const spawns = (globalThis as { Game?: Partial<Game> }).Game?.spawns;
  if (!spawns) {
    return [];
  }

  return Object.values(spawns).filter((spawn) => spawn.room?.name === colonyName);
}

function isOwnedRcl3Room(room: Room): boolean {
  return room.controller?.my === true && typeof room.controller.level === 'number' && room.controller.level >= 3;
}

function hasControllerDowngradeRisk(room: Room): boolean {
  const ticksToDowngrade = room.controller?.ticksToDowngrade;
  return typeof ticksToDowngrade === 'number' && ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_SPAWN_TICKS;
}

function hasOwnedTower(room: Room): boolean {
  return findRoomObjects<Structure>(room, 'FIND_MY_STRUCTURES')
    .concat(findRoomObjects<Structure>(room, 'FIND_STRUCTURES'))
    .some((structure) => structure.structureType === getStructureTowerConstant() && isOwnedStructure(structure));
}

function isOwnedStructure(structure: Structure): boolean {
  return (structure as Structure & { my?: boolean }).my !== false;
}

function hasVisibleLocalThreat(room: Room): boolean {
  return (
    findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS').length > 0 ||
    findRoomObjects<AnyStructure>(room, 'FIND_HOSTILE_STRUCTURES').length > 0
  );
}

function hasRecentLocalThreatMemory(roomName: string, gameTime: number): boolean {
  const threatMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense?.colonyThreats;
  if (!threatMemory || !isRecentTick(threatMemory.updatedAt, gameTime)) {
    return false;
  }

  const roomThreat = threatMemory.rooms?.[roomName];
  return Boolean(
    roomThreat &&
      isRecentTick(roomThreat.updatedAt, gameTime) &&
      roomThreat.level !== 'none'
  );
}

function hasHealthyScoutEnergyBuffer(
  colony: ColonySnapshot | string,
  room: Room,
  spawns: StructureSpawn[]
): boolean {
  if (spawns.length === 0) {
    return false;
  }

  const energyAvailable = typeof colony === 'string' ? getRoomEnergyAvailable(room) : colony.energyAvailable;
  return (
    energyAvailable >= TERRITORY_SCOUT_BODY_COST &&
    energyAvailable - TERRITORY_SCOUT_BODY_COST >= getSpawnEnergyBufferRequirement(room, spawns)
  );
}

function isActiveIdleSpawn(spawn: StructureSpawn): boolean {
  if (spawn.spawning != null) {
    return false;
  }

  if (typeof spawn.isActive !== 'function') {
    return true;
  }

  try {
    return spawn.isActive() !== false;
  } catch {
    return false;
  }
}

function findRoomObjects<T>(room: Room, constantName: FindConstantName): T[] {
  const findConstant = (globalThis as Record<string, unknown>)[constantName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getStructureTowerConstant(): StructureConstant {
  return ((globalThis as { STRUCTURE_TOWER?: StructureConstant }).STRUCTURE_TOWER ?? 'tower') as StructureConstant;
}

function getRoomEnergyAvailable(room: Room): number {
  const energyAvailable = (room as Partial<Room>).energyAvailable;
  return typeof energyAvailable === 'number' && Number.isFinite(energyAvailable)
    ? Math.max(0, Math.floor(energyAvailable))
    : 0;
}

function isRecentTick(updatedAt: unknown, gameTime: number): boolean {
  return (
    typeof updatedAt === 'number' &&
    Number.isFinite(updatedAt) &&
    updatedAt <= gameTime &&
    gameTime - updatedAt <= THREAT_MEMORY_STALE_TICKS
  );
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}
