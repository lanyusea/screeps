import {
  WORKER_REPLACEMENT_TICKS_TO_LIVE,
  type RoleCounts
} from '../creeps/roleCounts';
import { isTerritoryScoutAttemptTimedOut } from './scoutIntel';

const GLOBAL_TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS = (globalThis as {
  TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS?: number;
}).TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS;

export const TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS =
  typeof GLOBAL_TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS === 'number' &&
  Number.isFinite(GLOBAL_TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS) &&
  GLOBAL_TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS > 0
    ? Math.floor(GLOBAL_TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS)
    : 2;

export interface TerritoryScoutConcurrencySummary {
  activeScoutCount: number;
  cap: number;
  assignedTargetCount: number;
  scoutsByTargetRoom: Record<string, number>;
  duplicateTargetScoutCount: number;
  surplusScoutCount: number;
}

interface ActiveScoutAssignment {
  name: string;
  targetRoom: string;
}

interface ScoutCreepCache {
  gameTime: number;
  creeps: Game['creeps'];
  scouts: Creep[];
}

let scoutCreepCache: ScoutCreepCache | null = null;

export function shouldSpawnTerritoryScoutForTarget(
  colony: string,
  targetRoom: string,
  roleCounts: RoleCounts,
  gameTime = getGameTime()
): boolean {
  const targetTimedOut = isTerritoryScoutAttemptTimedOut(colony, targetRoom, gameTime);
  const targetScoutCount = getTerritoryScoutCountForTarget(roleCounts, targetRoom);
  if (targetScoutCount > 0) {
    return targetTimedOut && targetScoutCount < 2;
  }

  return targetTimedOut || getActiveTerritoryScoutCount(roleCounts) < TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS;
}

export function isTerritoryScoutAssignmentAvailableForCreep(
  colony: string,
  targetRoom: string,
  currentCreepName: string | undefined,
  gameTime = getGameTime()
): boolean {
  const targetTimedOut = isTerritoryScoutAttemptTimedOut(colony, targetRoom, gameTime);
  const assignments = getActiveScoutAssignments(colony, currentCreepName, gameTime, targetTimedOut);
  const targetAssignmentCount = assignments.filter((assignment) => assignment.targetRoom === targetRoom).length;
  if (targetAssignmentCount > 0) {
    return targetTimedOut && targetAssignmentCount < 2;
  }

  return targetTimedOut || getAssignedScoutTargetRooms(assignments).size < TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS;
}

export function shouldRecycleSurplusTerritoryScout(creep: Creep, gameTime = getGameTime()): boolean {
  const colony = creep.memory.colony;
  const assignment = creep.memory.territory;
  if (
    !isNonEmptyString(colony) ||
    !isNonEmptyString(creep.name) ||
    assignment?.action !== 'scout' ||
    !isNonEmptyString(assignment.targetRoom) ||
    isTerritoryScoutAttemptTimedOut(colony, assignment.targetRoom, gameTime)
  ) {
    return false;
  }

  const assignments = getActiveScoutAssignments(colony, undefined, gameTime);
  const targetAssignments = assignments
    .filter((candidate) => candidate.targetRoom === assignment.targetRoom)
    .sort(compareActiveScoutAssignments);
  if (targetAssignments.length > 1 && targetAssignments[0]?.name !== creep.name) {
    return true;
  }

  const preferredTargetRooms = getPreferredAssignedScoutTargetRooms(assignments);
  return preferredTargetRooms.length >= TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS &&
    !preferredTargetRooms.includes(assignment.targetRoom);
}

export function summarizeTerritoryScoutConcurrency(
  roleCounts: RoleCounts,
  desiredTargetCount = 0
): TerritoryScoutConcurrencySummary | null {
  const activeScoutCount = getActiveTerritoryScoutCount(roleCounts);
  const scoutsByTargetRoom = getTerritoryScoutCountsByTarget(roleCounts);
  const assignedTargetCount = Object.keys(scoutsByTargetRoom).length;
  const duplicateTargetScoutCount = Object.values(scoutsByTargetRoom).reduce(
    (total, count) => total + Math.max(0, count - 1),
    0
  );
  const effectiveTargetSlots = Math.min(
    TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS,
    Math.max(assignedTargetCount, normalizeNonNegativeInteger(desiredTargetCount))
  );
  const surplusScoutCount = Math.max(0, activeScoutCount - effectiveTargetSlots);

  if (
    activeScoutCount <= 0 &&
    assignedTargetCount <= 0 &&
    duplicateTargetScoutCount <= 0 &&
    surplusScoutCount <= 0
  ) {
    return null;
  }

  return {
    activeScoutCount,
    cap: TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS,
    assignedTargetCount,
    scoutsByTargetRoom,
    duplicateTargetScoutCount,
    surplusScoutCount
  };
}

export function getActiveTerritoryScoutCount(roleCounts: RoleCounts): number {
  const explicitScoutCount = normalizeNonNegativeInteger(roleCounts.scout);
  const targetScoutCount = Object.values(getTerritoryScoutCountsByTarget(roleCounts)).reduce(
    (total, count) => total + count,
    0
  );
  return Math.max(explicitScoutCount, targetScoutCount);
}

function getTerritoryScoutCountForTarget(roleCounts: RoleCounts, targetRoom: string): number {
  return getTerritoryScoutCountsByTarget(roleCounts)[targetRoom] ?? 0;
}

function getTerritoryScoutCountsByTarget(roleCounts: RoleCounts): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [targetRoom, count] of Object.entries(roleCounts.scoutsByTargetRoom ?? {})) {
    if (!isNonEmptyString(targetRoom)) {
      continue;
    }

    const normalizedCount = normalizeNonNegativeInteger(count);
    if (normalizedCount > 0) {
      counts[targetRoom] = normalizedCount;
    }
  }

  return counts;
}

function getActiveScoutAssignments(
  colony: string,
  excludedCreepName: string | undefined,
  gameTime: number,
  includeTimedOutAssignments = false
): ActiveScoutAssignment[] {
  return getCachedScoutCreeps(gameTime).flatMap((creep) => {
    const assignment = creep.memory.territory;
    if (
      creep.name === excludedCreepName ||
      creep.memory.role !== 'scout' ||
      creep.memory.colony !== colony ||
      assignment?.action !== 'scout' ||
      !isNonEmptyString(assignment.targetRoom) ||
      !isHealthyScout(creep) ||
      (!includeTimedOutAssignments && isTerritoryScoutAttemptTimedOut(colony, assignment.targetRoom, gameTime))
    ) {
      return [];
    }

    return [{ name: creep.name, targetRoom: assignment.targetRoom }];
  });
}

function getCachedScoutCreeps(gameTime: number): Creep[] {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return [];
  }

  if (scoutCreepCache?.gameTime === gameTime && scoutCreepCache.creeps === creeps) {
    return scoutCreepCache.scouts;
  }

  const scouts = Object.values(creeps).filter(isScoutCreep);
  scoutCreepCache = { gameTime, creeps, scouts };
  return scouts;
}

function getAssignedScoutTargetRooms(assignments: ActiveScoutAssignment[]): Set<string> {
  return new Set(assignments.map((assignment) => assignment.targetRoom));
}

function getPreferredAssignedScoutTargetRooms(assignments: ActiveScoutAssignment[]): string[] {
  const firstAssignmentByTargetRoom = new Map<string, ActiveScoutAssignment>();
  for (const assignment of [...assignments].sort(compareActiveScoutAssignments)) {
    if (!firstAssignmentByTargetRoom.has(assignment.targetRoom)) {
      firstAssignmentByTargetRoom.set(assignment.targetRoom, assignment);
    }
  }

  return [...firstAssignmentByTargetRoom.values()]
    .sort(compareActiveScoutAssignments)
    .slice(0, TERRITORY_SCOUT_MAX_ACTIVE_ASSIGNMENTS)
    .map((assignment) => assignment.targetRoom);
}

function compareActiveScoutAssignments(left: ActiveScoutAssignment, right: ActiveScoutAssignment): number {
  return left.name.localeCompare(right.name) || left.targetRoom.localeCompare(right.targetRoom);
}

function isHealthyScout(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}

function isScoutCreep(creep: Creep): boolean {
  return creep.memory.role === 'scout';
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
