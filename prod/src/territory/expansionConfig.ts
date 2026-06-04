import { getRuntimeCurrentRoomName } from '../config/runtimeRooms';
import { isSeasonalRuntimeWorld } from '../runtime/seasonalPolicy';
import {
  ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION,
  TERRITORY_EXPANSION_ROOM_SELECTION
} from '../config/roomSelection';
import { isAutonomousTerritoryControlAllowedForColonyName } from './controlGate';

export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
  scoutOnly?: boolean;
  allowLongRange?: boolean;
}

export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] = [];

export function getTerritoryExpansionScoutTargets(
  colonyName = getRuntimeCurrentRoomName()
): TerritoryExpansionScoutTargetConfig[] {
  return dedupeTerritoryExpansionScoutTargets([
    ...getMemoryConfiguredExpansionScoutTargets(colonyName),
    ...getEnabledRuntimeCurrentRoomScoutOnlyTargets(colonyName),
    ...getStaticExpansionScoutTargets(colonyName)
  ]);
}

export function getRuntimeCurrentRoomScoutOnlyTargets(
  colonyName = getRuntimeCurrentRoomName()
): TerritoryExpansionScoutTargetConfig[] {
  const currentRoomName = getRuntimeCurrentRoomName();
  if (!currentRoomName || colonyName !== currentRoomName) {
    return [];
  }

  if (currentRoomName === ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION.colony) {
    const officialTarget = { ...ACTIVE_OFFICIAL_PASSIVE_SCOUT_TARGET_SELECTION };
    return [
      officialTarget,
      ...getCurrentRoomScoutOnlyAdjacentRoomNames(currentRoomName)
        .filter((roomName) => roomName !== officialTarget.roomName)
        .map((roomName) => buildRuntimeCurrentRoomScoutOnlyTarget(currentRoomName, roomName))
    ];
  }

  return getCurrentRoomScoutOnlyAdjacentRoomNames(currentRoomName).map((roomName) =>
    buildRuntimeCurrentRoomScoutOnlyTarget(currentRoomName, roomName)
  );
}

export function getCurrentRoomScoutOnlyAdjacentRoomNames(roomName: string): string[] {
  const parsed = parseRoomName(roomName);
  if (!parsed) {
    return [];
  }

  return [
    formatRoomName(parsed.x, parsed.y - 1),
    formatRoomName(parsed.x, parsed.y + 1),
    formatRoomName(parsed.x - 1, parsed.y),
    formatRoomName(parsed.x + 1, parsed.y)
  ].filter(isNonEmptyString);
}

export function isConfiguredExpansionScoutOnlyTarget(colony: string, roomName: string): boolean {
  return getTerritoryExpansionScoutTargets(colony).some(
    (target) => target.colony === colony && target.roomName === roomName && target.scoutOnly === true
  );
}

export function isConfiguredExpansionScoutOnlyTargetExcludedFromTerritoryControl(
  colony: string,
  roomName: string
): boolean {
  return (
    isConfiguredExpansionScoutOnlyTarget(colony, roomName) &&
    !isSeasonalRuntimeCurrentRoomAdjacentScoutOnlyTargetTerritoryControlEligible(colony, roomName)
  );
}

export function isSeasonalRuntimeCurrentRoomAdjacentScoutOnlyTargetTerritoryControlEligible(
  colony: string,
  roomName: string
): boolean {
  const currentRoomName = getRuntimeCurrentRoomName();
  return (
    isSeasonalRuntimeWorld() &&
    currentRoomName === colony &&
    isRuntimeCurrentRoomScoutTargetsEnabled(colony) &&
    getCurrentRoomScoutOnlyAdjacentRoomNames(currentRoomName).includes(roomName) &&
    isAutonomousTerritoryControlAllowedForColonyName(colony)
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

function getStaticExpansionScoutTargets(
  colonyName: string | undefined
): TerritoryExpansionScoutTargetConfig[] {
  return TERRITORY_EXPANSION_ROOM_SELECTION.scoutTargets.flatMap((target) => {
    if (colonyName && target.colony !== colonyName) {
      return [];
    }

    return [{ ...target }];
  });
}

function dedupeTerritoryExpansionScoutTargets(
  targets: TerritoryExpansionScoutTargetConfig[]
): TerritoryExpansionScoutTargetConfig[] {
  const targetsByKey = new Map<string, TerritoryExpansionScoutTargetConfig>();
  for (const target of targets) {
    const key = getScoutTargetKey(target);
    const existingTarget = targetsByKey.get(key);
    if (!existingTarget) {
      targetsByKey.set(key, target);
      continue;
    }

    targetsByKey.set(key, {
      ...existingTarget,
      ...target,
      ...(existingTarget.scoutOnly === true || target.scoutOnly === true ? { scoutOnly: true } : {}),
      ...(existingTarget.allowLongRange === true || target.allowLongRange === true ? { allowLongRange: true } : {})
    });
  }

  return Array.from(targetsByKey.values());
}

function getScoutTargetKey(target: Pick<TerritoryExpansionScoutTargetConfig, 'colony' | 'roomName'>): string {
  return `${target.colony}>${target.roomName}`;
}

function buildRuntimeCurrentRoomScoutOnlyTarget(
  currentRoomName: string,
  roomName: string
): TerritoryExpansionScoutTargetConfig {
  return {
    colony: currentRoomName,
    roomName,
    nearestOwnedRoom: currentRoomName,
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true,
    scoutOnly: true
  };
}

function isRuntimeCurrentRoomScoutTargetsEnabled(colonyName: string): boolean {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  return (
    memory?.territory?.runtimeCurrentRoomScoutTargetsEnabled === true ||
    memory?.runtime?.currentRoomName === colonyName
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
    ...(target.scoutOnly === true ? { scoutOnly: true } : {}),
    ...(target.allowLongRange === true ? { allowLongRange: true } : {})
  };
}

function parseRoomName(roomName: string):
  | {
      x: number;
      y: number;
    }
  | null {
  const match = /^(E|W)(\d+)(N|S)(\d+)$/.exec(roomName);
  if (!match) {
    return null;
  }

  return {
    x: parseAxisCoordinate(match[1] as 'E' | 'W', Number.parseInt(match[2], 10)),
    y: parseAxisCoordinate(match[3] as 'N' | 'S', Number.parseInt(match[4], 10))
  };
}

function parseAxisCoordinate(direction: 'E' | 'W' | 'N' | 'S', coordinate: number): number {
  return direction === 'E' || direction === 'S'
    ? coordinate
    : -coordinate - 1;
}

function formatRoomName(x: number, y: number): string | null {
  const horizontal = formatAxisCoordinate('E', 'W', x);
  const vertical = formatAxisCoordinate('S', 'N', y);
  if (!horizontal || !vertical) {
    return null;
  }

  return `${horizontal.direction}${horizontal.coordinate}${vertical.direction}${vertical.coordinate}`;
}

function formatAxisCoordinate<PositiveDirection extends 'E' | 'S', NegativeDirection extends 'W' | 'N'>(
  positiveDirection: PositiveDirection,
  negativeDirection: NegativeDirection,
  coordinate: number
): { direction: PositiveDirection | NegativeDirection; coordinate: number } | null {
  if (!Number.isFinite(coordinate)) {
    return null;
  }

  if (coordinate >= 0) {
    return { direction: positiveDirection, coordinate };
  }
  return { direction: negativeDirection, coordinate: -coordinate - 1 };
}

function normalizePositiveDistance(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
