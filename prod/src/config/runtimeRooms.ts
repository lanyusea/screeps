export function getRuntimeCurrentRoomName(): string | undefined {
  const configured = getConfiguredRuntimeCurrentRoomName();
  if (configured) {
    return configured;
  }

  return getRuntimeOwnedRoomNames()[0];
}

export function getRuntimeOwnedRoomNames(): string[] {
  return getSortedUniqueRoomNames([
    ...getConfiguredRuntimeOwnedRoomNames(),
    ...getLiveOwnedRoomNames()
  ]);
}

export function refreshRuntimeRoomMemory(): void {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return;
  }

  const configuredOwnedRoomNames = getConfiguredRuntimeOwnedRoomNames();
  const liveOwnedRoomNames = getLiveOwnedRoomNames();
  const ownedRoomNames = getSortedUniqueRoomNames([
    ...configuredOwnedRoomNames,
    ...liveOwnedRoomNames
  ]);
  const configuredCurrentRoomName = getConfiguredRuntimeCurrentRoomName();
  if (!memory.runtime && !configuredCurrentRoomName && ownedRoomNames.length === 0) {
    return;
  }

  const runtime: RuntimeConfigMemory = memory.runtime ?? {};
  memory.runtime = runtime;

  if (ownedRoomNames.length > 0) {
    runtime.ownedRoomNames = ownedRoomNames;
  }

  if (
    configuredCurrentRoomName &&
    (ownedRoomNames.length === 0 || ownedRoomNames.includes(configuredCurrentRoomName))
  ) {
    runtime.currentRoomName = configuredCurrentRoomName;
    return;
  }

  const derivedCurrentRoomName = liveOwnedRoomNames[0] ?? ownedRoomNames[0];
  if (derivedCurrentRoomName) {
    runtime.currentRoomName = derivedCurrentRoomName;
  }
}

function getLiveOwnedRoomNames(): string[] {
  const roomNames = new Set<string>();
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

function getSortedUniqueRoomNames(roomNames: readonly string[]): string[] {
  return [...new Set(roomNames.filter(isNonEmptyString))].sort();
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
