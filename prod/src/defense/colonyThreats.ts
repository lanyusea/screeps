export type DefenseThreatObservation = {
  roomName: string;
  hostileCreepCount: number;
  hostileStructureCount: number;
  damagedCriticalStructureCount: number;
  controllerUnderAttack?: boolean;
};

const THREAT_LEVEL_PRIORITY: Record<DefenseThreatLevel, number> = {
  none: 0,
  hostile_present: 1,
  under_attack: 2
};

export function getDefenseThreatLevel(observation: DefenseThreatObservation): DefenseThreatLevel {
  const hostileCount =
    normalizeNonNegativeInteger(observation.hostileCreepCount) +
    normalizeNonNegativeInteger(observation.hostileStructureCount);

  if (
    observation.controllerUnderAttack === true ||
    normalizeNonNegativeInteger(observation.damagedCriticalStructureCount) > 0
  ) {
    return 'under_attack';
  }

  if (hostileCount <= 0) {
    return 'none';
  }

  return 'hostile_present';
}

export function getDefenseThreatPriority(level: DefenseThreatLevel): number {
  return THREAT_LEVEL_PRIORITY[level] ?? THREAT_LEVEL_PRIORITY.none;
}

export function recordColonyThreats(
  observations: DefenseThreatObservation[],
  tick = getGameTime()
): void {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return;
  }

  const defenseMemory = memory.defense && typeof memory.defense === 'object' ? memory.defense : {};
  const rooms: Record<string, DefenseColonyThreatRoomMemory> = {};
  for (const observation of observations) {
    const level = getDefenseThreatLevel(observation);
    rooms[observation.roomName] = {
      roomName: observation.roomName,
      level,
      updatedAt: tick,
      hostileCreepCount: normalizeNonNegativeInteger(observation.hostileCreepCount),
      hostileStructureCount: normalizeNonNegativeInteger(observation.hostileStructureCount),
      damagedCriticalStructureCount: normalizeNonNegativeInteger(observation.damagedCriticalStructureCount)
    };
  }

  defenseMemory.colonyThreats = { updatedAt: tick, rooms };
  memory.defense = defenseMemory;
}

export function isColonyRoomThreatened(roomName: string, tick = getGameTime()): boolean {
  const threatMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense?.colonyThreats;
  const threat = threatMemory?.rooms?.[roomName];
  return (
    threatMemory?.updatedAt === tick &&
    threat?.updatedAt === tick &&
    threat.level !== 'none'
  );
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getGameTime(): number {
  return typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
}
