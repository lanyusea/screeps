export function getRuntimeCurrentRoomName(): string | undefined {
  const configured = getConfiguredRuntimeCurrentRoomName();
  if (configured) {
    return configured;
  }

  return getRuntimeOwnedRoomNames()[0];
}

export function getRuntimeOwnedRoomNames(): string[] {
  const roomNames = new Set<string>(getConfiguredRuntimeOwnedRoomNames());
  const game = (globalThis as { Game?: Partial<Pick<Game, 'rooms' | 'spawns'>> }).Game;

  for (const room of Object.values(game?.rooms ?? {})) {
    if (isVisibleOwnedRoom(room)) {
      roomNames.add(room.name);
    }
  }

  for (const spawn of Object.values(game?.spawns ?? {})) {
    const roomName = spawn?.room?.name;
    if (isNonEmptyString(roomName) && isOwnedSpawn(spawn)) {
      roomNames.add(roomName);
    }
  }

  return [...roomNames].sort();
}

function getConfiguredRuntimeCurrentRoomName(): string | undefined {
  const roomName = (globalThis as { Memory?: Partial<Memory> }).Memory?.runtime?.currentRoomName;
  return isNonEmptyString(roomName) ? roomName : undefined;
}

function getConfiguredRuntimeOwnedRoomNames(): string[] {
  const roomNames = (globalThis as { Memory?: Partial<Memory> }).Memory?.runtime?.ownedRoomNames;
  return Array.isArray(roomNames)
    ? roomNames.filter(isNonEmptyString)
    : [];
}

function isVisibleOwnedRoom(room: Room | undefined): room is Room {
  return room?.controller?.my === true && isNonEmptyString(room.name);
}

function isOwnedSpawn(spawn: StructureSpawn | undefined): boolean {
  return spawn?.my === true || spawn?.room?.controller?.my === true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
