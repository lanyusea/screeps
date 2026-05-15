import { getRuntimeCurrentRoomName } from '../config/runtimeRooms';

export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
  scoutOnly?: boolean;
}

export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] = [];

export function getTerritoryExpansionScoutTargets(
  colonyName = getRuntimeCurrentRoomName()
): TerritoryExpansionScoutTargetConfig[] {
  return [
    ...getMemoryConfiguredExpansionScoutTargets(colonyName),
    ...getEnabledRuntimeCurrentRoomScoutOnlyTargets(colonyName)
  ];
}

export function getRuntimeCurrentRoomScoutOnlyTargets(
  colonyName = getRuntimeCurrentRoomName()
): TerritoryExpansionScoutTargetConfig[] {
  const currentRoomName = getRuntimeCurrentRoomName();
  if (!currentRoomName || colonyName !== currentRoomName) {
    return [];
  }

  return getCurrentRoomScoutOnlyAdjacentRoomNames(currentRoomName).map((roomName) => ({
    colony: currentRoomName,
    roomName,
    nearestOwnedRoom: currentRoomName,
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true,
    scoutOnly: true
  }));
}

export function getCurrentRoomScoutOnlyAdjacentRoomNames(roomName: string): string[] {
  const parsed = parseRoomName(roomName);
  if (!parsed) {
    return [];
  }

  return [
    formatRoomName(parsed.horizontalDirection, parsed.horizontalCoordinate, parsed.verticalDirection, parsed.verticalCoordinate - 1),
    formatRoomName(parsed.horizontalDirection, parsed.horizontalCoordinate - 1, parsed.verticalDirection, parsed.verticalCoordinate)
  ].filter(isNonEmptyString);
}

export function isConfiguredExpansionScoutOnlyTarget(colony: string, roomName: string): boolean {
  return getTerritoryExpansionScoutTargets(colony).some(
    (target) => target.colony === colony && target.roomName === roomName && target.scoutOnly === true
  );
}

function getMemoryConfiguredExpansionScoutTargets(
  colonyName: string | undefined
): TerritoryExpansionScoutTargetConfig[] {
  const targets = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.expansionScoutTargets;
  if (!Array.isArray(targets)) {
    return [];
  }

  return targets.flatMap((target) => {
    const normalized = normalizeExpansionScoutTarget(target);
    if (!normalized || (colonyName && normalized.colony !== colonyName)) {
      return [];
    }

    return [normalized];
  });
}

function getEnabledRuntimeCurrentRoomScoutOnlyTargets(
  colonyName: string | undefined
): TerritoryExpansionScoutTargetConfig[] {
  if (!colonyName || !isRuntimeCurrentRoomScoutTargetsEnabled(colonyName)) {
    return [];
  }

  return getRuntimeCurrentRoomScoutOnlyTargets(colonyName);
}

function isRuntimeCurrentRoomScoutTargetsEnabled(colonyName: string): boolean {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  return (
    memory?.territory?.runtimeCurrentRoomScoutTargetsEnabled === true ||
    getRuntimeCurrentRoomName() === colonyName
  );
}

function normalizeExpansionScoutTarget(
  target: Partial<TerritoryExpansionScoutTargetMemory> | undefined
): TerritoryExpansionScoutTargetConfig | null {
  if (
    !target ||
    !isNonEmptyString(target.colony) ||
    !isNonEmptyString(target.roomName) ||
    !isNonEmptyString(target.nearestOwnedRoom)
  ) {
    return null;
  }

  return {
    colony: target.colony,
    roomName: target.roomName,
    nearestOwnedRoom: target.nearestOwnedRoom,
    nearestOwnedRoomDistance: normalizePositiveDistance(target.nearestOwnedRoomDistance),
    routeDistance: normalizePositiveDistance(target.routeDistance),
    adjacentToOwnedRoom: target.adjacentToOwnedRoom === true,
    ...(target.scoutOnly === true ? { scoutOnly: true } : {})
  };
}

function parseRoomName(roomName: string):
  | {
      horizontalDirection: 'E' | 'W';
      horizontalCoordinate: number;
      verticalDirection: 'N' | 'S';
      verticalCoordinate: number;
    }
  | null {
  const match = /^(E|W)(\d+)(N|S)(\d+)$/.exec(roomName);
  if (!match) {
    return null;
  }

  return {
    horizontalDirection: match[1] as 'E' | 'W',
    horizontalCoordinate: Number.parseInt(match[2], 10),
    verticalDirection: match[3] as 'N' | 'S',
    verticalCoordinate: Number.parseInt(match[4], 10)
  };
}

function formatRoomName(
  horizontalDirection: 'E' | 'W',
  horizontalCoordinate: number,
  verticalDirection: 'N' | 'S',
  verticalCoordinate: number
): string | null {
  const normalizedHorizontal = normalizeAxisCoordinate(horizontalDirection, horizontalCoordinate);
  const normalizedVertical = normalizeAxisCoordinate(verticalDirection, verticalCoordinate);
  if (!normalizedHorizontal || !normalizedVertical) {
    return null;
  }

  return `${normalizedHorizontal.direction}${normalizedHorizontal.coordinate}${normalizedVertical.direction}${normalizedVertical.coordinate}`;
}

function normalizeAxisCoordinate<T extends 'E' | 'W' | 'N' | 'S'>(
  direction: T,
  coordinate: number
): { direction: T; coordinate: number } | { direction: OppositeDirection<T>; coordinate: 0 } | null {
  if (!Number.isFinite(coordinate)) {
    return null;
  }

  if (coordinate >= 0) {
    return { direction, coordinate };
  }

  return { direction: getOppositeDirection(direction), coordinate: 0 };
}

function getOppositeDirection<T extends 'E' | 'W' | 'N' | 'S'>(direction: T): OppositeDirection<T> {
  switch (direction) {
    case 'E':
      return 'W' as OppositeDirection<T>;
    case 'W':
      return 'E' as OppositeDirection<T>;
    case 'N':
      return 'S' as OppositeDirection<T>;
    case 'S':
      return 'N' as OppositeDirection<T>;
  }
}

type OppositeDirection<T extends 'E' | 'W' | 'N' | 'S'> =
  T extends 'E' ? 'W' :
  T extends 'W' ? 'E' :
  T extends 'N' ? 'S' :
  'N';

function normalizePositiveDistance(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
