export interface ColonySnapshot {
  room: Room;
  memory?: RoomMemory;
  spawns: StructureSpawn[];
  energyAvailable: number;
  energyCapacityAvailable: number;
}

export function getOwnedColonies(): ColonySnapshot[] {
  return Object.values(Game.rooms)
    .filter((room) => room.controller?.my)
    .map((room) => ({
      room,
      memory: room.memory,
      spawns: Object.values(Game.spawns).filter((spawn) => spawn.room.name === room.name),
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable
    }));
}
