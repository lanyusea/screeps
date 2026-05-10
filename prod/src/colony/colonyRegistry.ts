export interface ColonySnapshot {
  room: Room;
  memory?: RoomMemory;
  spawns: StructureSpawn[];
  energyAvailable: number;
  energyCapacityAvailable: number;
  spawnEnergyBudget?: number;
}

export function getOwnedColonies(): ColonySnapshot[] {
  const ownedRoomsByName = new Map<string, Room>();
  for (const room of Object.values(Game.rooms)) {
    if (room.controller?.my) {
      ownedRoomsByName.set(room.name, room);
    }
  }

  for (const spawn of Object.values(Game.spawns)) {
    const room = spawn.room;
    if (room && isOwnedSpawn(spawn) && !ownedRoomsByName.has(room.name)) {
      ownedRoomsByName.set(room.name, room);
    }
  }

  return [...ownedRoomsByName.values()]
    .map((room) => buildColonySnapshot(room));
}

function buildColonySnapshot(room: Room): ColonySnapshot {
  const spawns = Object.values(Game.spawns).filter((spawn) => spawn.room.name === room.name);
  return {
    room,
    memory: room.memory,
    spawns,
    energyAvailable: Math.max(normalizeEnergyAmount(room.energyAvailable), getSpawnEnergyAvailable(spawns)),
    energyCapacityAvailable: Math.max(
      normalizeEnergyAmount(room.energyCapacityAvailable),
      getSpawnEnergyCapacityAvailable(spawns)
    )
  };
}

function isOwnedSpawn(spawn: StructureSpawn): boolean {
  return spawn.my === true || spawn.room?.controller?.my === true;
}

function getSpawnEnergyAvailable(spawns: StructureSpawn[]): number {
  return spawns.reduce((total, spawn) => total + getSpawnStoreAmount(spawn, 'getUsedCapacity', 'energy'), 0);
}

function getSpawnEnergyCapacityAvailable(spawns: StructureSpawn[]): number {
  return spawns.reduce((total, spawn) => total + getSpawnCapacity(spawn), 0);
}

function getSpawnCapacity(spawn: StructureSpawn): number {
  const storeCapacity = getSpawnStoreAmount(spawn, 'getCapacity', 'energyCapacity');
  if (storeCapacity > 0) {
    return storeCapacity;
  }

  return (
    getSpawnStoreAmount(spawn, 'getUsedCapacity', 'energy') +
    getSpawnStoreAmount(spawn, 'getFreeCapacity', undefined)
  );
}

function getSpawnStoreAmount(
  spawn: StructureSpawn,
  method: 'getUsedCapacity' | 'getFreeCapacity' | 'getCapacity',
  legacyField: 'energy' | 'energyCapacity' | undefined
): number {
  const storeMethod = spawn.store?.[method];
  if (typeof storeMethod === 'function') {
    return normalizeEnergyAmount(storeMethod.call(spawn.store, getEnergyResourceConstant()));
  }

  return legacyField ? normalizeEnergyAmount((spawn as unknown as Record<string, unknown>)[legacyField]) : 0;
}

function getEnergyResourceConstant(): ResourceConstant {
  return ((globalThis as unknown as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function normalizeEnergyAmount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
