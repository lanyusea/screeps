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
    if (room && room.controller?.my && !ownedRoomsByName.has(room.name)) {
      ownedRoomsByName.set(room.name, room);
    }
  }

  return [...ownedRoomsByName.values()]
    .map((room) => ({
      room,
      memory: room.memory,
      spawns: Object.values(Game.spawns).filter((spawn) => spawn.room.name === room.name),
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    }));
}
