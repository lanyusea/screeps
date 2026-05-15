export function installRuntimeCurrentRoom(roomName: string): void {
  Memory.runtime = {
    ...(Memory.runtime ?? {}),
    currentRoomName: roomName
  };
}

export function enableRuntimeCurrentRoomScoutTargets(roomName?: string): void {
  if (roomName) {
    installRuntimeCurrentRoom(roomName);
  }

  Memory.territory = {
    ...(Memory.territory ?? {}),
    runtimeCurrentRoomScoutTargetsEnabled: true
  };
}

export function installExpansionScoutTargets(
  targets: readonly TerritoryExpansionScoutTargetMemory[]
): void {
  Memory.territory = {
    ...(Memory.territory ?? {}),
    expansionScoutTargets: [...targets]
  };
}

export function installE18S59ExpansionScoutTarget(): void {
  installExpansionScoutTargets([makeE18S59ExpansionScoutTarget()]);
}

export function installE17S60ExpansionScoutTarget(): void {
  installExpansionScoutTargets([makeE17S60ExpansionScoutTarget()]);
}

export function installLegacyE17S59ExpansionScoutTargets(): void {
  installExpansionScoutTargets([
    makeE18S59ExpansionScoutTarget(),
    makeE17S60ExpansionScoutTarget()
  ]);
}

export function makeE18S59ExpansionScoutTarget(): TerritoryExpansionScoutTargetMemory {
  return {
    colony: 'E17S59',
    roomName: 'E18S59',
    nearestOwnedRoom: 'E17S59',
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true
  };
}

export function makeE17S60ExpansionScoutTarget(): TerritoryExpansionScoutTargetMemory {
  return {
    colony: 'E17S59',
    roomName: 'E17S60',
    nearestOwnedRoom: 'E17S58',
    nearestOwnedRoomDistance: 1,
    routeDistance: 2,
    adjacentToOwnedRoom: true
  };
}
