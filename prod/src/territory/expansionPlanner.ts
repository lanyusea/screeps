import type { ColonySnapshot } from '../colony/colonyRegistry';
import { maxRoomsForRcl } from './expansionScoring';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export const EXPANSION_PLANNER_MIN_SOURCE_COUNT = 2;
export const EXPANSION_PLANNER_MAX_ROUTE_DISTANCE = 2;

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'];
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const SOURCE_SCORE_WEIGHT = 1_000;
const DISTANCE_SCORE_WEIGHT = 100;

export type ExpansionRoomUnsuitableReason =
  | 'sourceCountBelowMinimum'
  | 'hostilePresence'
  | 'controllerMissing'
  | 'controllerOwned'
  | 'controllerReserved';

export type ExpansionPlannerSkipReason = 'existingTerritoryPlan' | 'memoryUnavailable' | 'noCandidate';

export interface ExpansionRoomSuitability {
  suitable: boolean;
  sourceCount: number;
  hostileCreepCount: number;
  hostileStructureCount: number;
  reasons: ExpansionRoomUnsuitableReason[];
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
}

export interface ExpansionPlannerCandidateInput {
  colony: string;
  roomName: string;
  distance: number;
  sourceCount: number;
  order?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
}

export interface ExpansionPlannerCandidate extends ExpansionRoomSuitability {
  colony: string;
  roomName: string;
  distance: number;
  order: number;
  score: number;
}

export interface ExpansionPlannerIntent {
  colony: string;
  targetRoom: string;
  action: TerritoryControlAction;
  score: number;
  controllerId?: Id<StructureController>;
}

export interface ExpansionPlannerEvaluation {
  status: 'planned' | 'skipped';
  colony: string;
  candidates: ExpansionPlannerCandidate[];
  reason?: ExpansionPlannerSkipReason;
  targetRoom?: string;
  action?: TerritoryControlAction;
  score?: number;
  controllerId?: Id<StructureController>;
}

export function evaluateExpansionRoomSuitability(room: Room): ExpansionRoomSuitability {
  const ownerUsername = getControllerOwnerUsername(room.controller);
  const reservationUsername = getControllerReservationUsername(room.controller);
  return evaluateExpansionSuitability({
    sourceCount: findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES')).length,
    hostileCreepCount: findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length,
    hostileStructureCount: findRoomObjects<AnyStructure>(
      room,
      getFindConstant('FIND_HOSTILE_STRUCTURES')
    ).length,
    ...(room.controller?.id ? { controllerId: room.controller.id } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    hasController: room.controller !== undefined
  });
}

export function evaluateExpansionCandidate(
  candidate: ExpansionPlannerCandidateInput
): ExpansionPlannerCandidate {
  const suitability = evaluateExpansionSuitability({
    sourceCount: candidate.sourceCount,
    hostileCreepCount: candidate.hostileCreepCount ?? 0,
    hostileStructureCount: candidate.hostileStructureCount ?? 0,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {}),
    ...(candidate.ownerUsername ? { ownerUsername: candidate.ownerUsername } : {}),
    ...(candidate.reservationUsername ? { reservationUsername: candidate.reservationUsername } : {}),
    hasController:
      candidate.controllerId !== undefined ||
      candidate.ownerUsername !== undefined ||
      candidate.reservationUsername !== undefined
  });
  const order = normalizeNonNegativeInteger(candidate.order ?? 0);
  const distance = Math.max(1, normalizeNonNegativeInteger(candidate.distance));

  return {
    colony: candidate.colony,
    roomName: candidate.roomName,
    distance,
    order,
    score: scoreExpansionPlannerCandidate(suitability.sourceCount, distance),
    ...suitability
  };
}

export function prioritizeExpansionCandidates(
  candidates: ExpansionPlannerCandidateInput[]
): ExpansionPlannerCandidate[] {
  return candidates
    .map(evaluateExpansionCandidate)
    .filter((candidate) => candidate.suitable)
    .sort(compareExpansionPlannerCandidates);
}

export function buildRuntimeExpansionPlannerCandidates(
  colony: ColonySnapshot
): ExpansionPlannerCandidate[] {
  const colonyName = colony.room.name;
  const rooms = getGameRooms();
  if (!rooms) {
    return [];
  }

  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomNames = getVisibleOwnedRoomNames(colonyName, ownerUsername);
  const candidates: ExpansionPlannerCandidate[] = [];
  const seenRooms = new Set<string>();
  let order = 0;

  for (const ownedRoomName of ownedRoomNames) {
    for (const adjacentRoomName of getAdjacentRoomNames(ownedRoomName)) {
      if (seenRooms.has(adjacentRoomName) || ownedRoomNames.has(adjacentRoomName)) {
        continue;
      }

      seenRooms.add(adjacentRoomName);
      const room = rooms[adjacentRoomName];
      if (!room) {
        continue;
      }

      candidates.push(toRuntimeExpansionPlannerCandidate(colonyName, room, 1, order));
      order += 1;
    }
  }

  for (const room of Object.values(rooms)) {
    if (
      !room ||
      !isNonEmptyString(room.name) ||
      room.name === colonyName ||
      ownedRoomNames.has(room.name) ||
      seenRooms.has(room.name)
    ) {
      continue;
    }

    const distance = getNearestOwnedRoomDistance(ownedRoomNames, room.name);
    if (distance === null || distance > EXPANSION_PLANNER_MAX_ROUTE_DISTANCE) {
      continue;
    }

    seenRooms.add(room.name);
    candidates.push(toRuntimeExpansionPlannerCandidate(colonyName, room, distance, order));
    order += 1;
  }

  return candidates
    .filter((candidate) => candidate.suitable)
    .sort(compareExpansionPlannerCandidates);
}

export function refreshExpansionPlannerIntent(
  colony: ColonySnapshot,
  gameTime = getGameTime()
): ExpansionPlannerEvaluation {
  const colonyName = colony.room.name;
  if (!getMemoryRecord()) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'memoryUnavailable',
      candidates: []
    };
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (territoryMemory && hasBlockingTerritoryPlan(territoryMemory, colonyName)) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'existingTerritoryPlan',
      candidates: []
    };
  }

  const candidates = buildRuntimeExpansionPlannerCandidates(colony);
  const candidate = candidates[0];
  if (!candidate) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'noCandidate',
      candidates
    };
  }

  const action = selectExpansionIntentAction(colony);
  const intent = createExpansionIntent(candidate, action, gameTime);
  if (!intent) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'memoryUnavailable',
      candidates
    };
  }

  return {
    status: 'planned',
    colony: colonyName,
    candidates,
    targetRoom: intent.targetRoom,
    action: intent.action,
    score: intent.score,
    ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
  };
}

export function createExpansionIntent(
  candidate: ExpansionPlannerCandidate,
  action: TerritoryControlAction,
  gameTime = getGameTime()
): ExpansionPlannerIntent | null {
  if (!candidate.suitable) {
    return null;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const target: TerritoryTargetMemory = {
    colony: candidate.colony,
    roomName: candidate.roomName,
    action,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
  upsertTerritoryTarget(territoryMemory, target);

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find(
    (intent) =>
      intent.colony === candidate.colony &&
      intent.targetRoom === candidate.roomName &&
      intent.action === action
  );
  upsertTerritoryIntent(intents, {
    colony: candidate.colony,
    targetRoom: candidate.roomName,
    action,
    status: existingIntent?.status === 'active' ? 'active' : 'planned',
    updatedAt: gameTime,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  });

  return {
    colony: candidate.colony,
    targetRoom: candidate.roomName,
    action,
    score: candidate.score,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
}

function evaluateExpansionSuitability({
  sourceCount,
  hostileCreepCount,
  hostileStructureCount,
  controllerId,
  ownerUsername,
  reservationUsername,
  hasController
}: {
  sourceCount: number;
  hostileCreepCount: number;
  hostileStructureCount: number;
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
  hasController: boolean;
}): ExpansionRoomSuitability {
  const normalizedSourceCount = normalizeNonNegativeInteger(sourceCount);
  const normalizedHostileCreepCount = normalizeNonNegativeInteger(hostileCreepCount);
  const normalizedHostileStructureCount = normalizeNonNegativeInteger(hostileStructureCount);
  const reasons: ExpansionRoomUnsuitableReason[] = [];

  if (normalizedSourceCount < EXPANSION_PLANNER_MIN_SOURCE_COUNT) {
    reasons.push('sourceCountBelowMinimum');
  }

  if (normalizedHostileCreepCount > 0 || normalizedHostileStructureCount > 0) {
    reasons.push('hostilePresence');
  }

  if (!hasController) {
    reasons.push('controllerMissing');
  } else if (isNonEmptyString(ownerUsername)) {
    reasons.push('controllerOwned');
  } else if (isNonEmptyString(reservationUsername)) {
    reasons.push('controllerReserved');
  }

  return {
    suitable: reasons.length === 0,
    sourceCount: normalizedSourceCount,
    hostileCreepCount: normalizedHostileCreepCount,
    hostileStructureCount: normalizedHostileStructureCount,
    reasons,
    ...(controllerId ? { controllerId } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {})
  };
}

function toRuntimeExpansionPlannerCandidate(
  colony: string,
  room: Room,
  distance: number,
  order: number
): ExpansionPlannerCandidate {
  const suitability = evaluateExpansionRoomSuitability(room);
  const normalizedDistance = Math.max(1, normalizeNonNegativeInteger(distance));
  return {
    colony,
    roomName: room.name,
    distance: normalizedDistance,
    order,
    score: scoreExpansionPlannerCandidate(suitability.sourceCount, normalizedDistance),
    ...suitability
  };
}

function compareExpansionPlannerCandidates(
  left: ExpansionPlannerCandidate,
  right: ExpansionPlannerCandidate
): number {
  return (
    right.sourceCount - left.sourceCount ||
    left.distance - right.distance ||
    right.score - left.score ||
    left.order - right.order ||
    left.roomName.localeCompare(right.roomName)
  );
}

function scoreExpansionPlannerCandidate(sourceCount: number, distance: number): number {
  return sourceCount * SOURCE_SCORE_WEIGHT - distance * DISTANCE_SCORE_WEIGHT;
}

function selectExpansionIntentAction(colony: ColonySnapshot): TerritoryControlAction {
  const gclLevel = getGclLevel();
  if (gclLevel === null) {
    return 'reserve';
  }

  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomCount = getVisibleOwnedRoomNames(colony.room.name, ownerUsername).size;
  if (ownedRoomCount >= gclLevel) {
    return 'reserve';
  }

  if (ownedRoomCount >= maxRoomsForRcl(colony.room.controller?.level)) {
    return 'reserve';
  }

  return 'claim';
}

function hasBlockingTerritoryPlan(territoryMemory: TerritoryMemory, colony: string): boolean {
  if (
    normalizeTerritoryIntents(territoryMemory.intents).some(
      (intent) =>
        intent.colony === colony &&
        intent.targetRoom !== colony &&
        (intent.action === 'claim' || intent.action === 'reserve' || intent.action === 'scout') &&
        (intent.status === 'planned' || intent.status === 'active')
    )
  ) {
    return true;
  }

  return Array.isArray(territoryMemory.targets)
    ? territoryMemory.targets.some(
        (target) =>
          isRecord(target) &&
          target.colony === colony &&
          target.roomName !== colony &&
          target.enabled !== false &&
          (target.action === 'claim' || target.action === 'reserve')
      )
    : false;
}

function upsertTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingTarget = territoryMemory.targets.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.colony === target.colony &&
      candidate.roomName === target.roomName &&
      candidate.action === target.action
  );
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }

  existingTarget.enabled = target.enabled;
  if (target.controllerId) {
    existingTarget.controllerId = target.controllerId;
  } else {
    delete existingTarget.controllerId;
  }
}

function upsertTerritoryIntent(
  intents: TerritoryIntentMemory[],
  nextIntent: TerritoryIntentMemory
): void {
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === nextIntent.colony &&
      intent.targetRoom === nextIntent.targetRoom &&
      intent.action === nextIntent.action
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
}

function getNearestOwnedRoomDistance(ownedRoomNames: Set<string>, roomName: string): number | null {
  let nearestDistance: number | null = null;
  for (const ownedRoomName of ownedRoomNames) {
    const distance = getRouteDistance(ownedRoomName, roomName);
    if (distance === null) {
      continue;
    }

    if (nearestDistance === null || distance < nearestDistance) {
      nearestDistance = distance;
    }
  }

  return nearestDistance;
}

function getRouteDistance(fromRoom: string, targetRoom: string): number | null {
  if (fromRoom === targetRoom) {
    return 0;
  }

  if (getAdjacentRoomNames(fromRoom).includes(targetRoom)) {
    return 1;
  }

  const route = (globalThis as { Game?: Partial<Game> }).Game?.map?.findRoute?.(fromRoom, targetRoom);
  if (Array.isArray(route)) {
    return route.length;
  }

  return route === ERR_NO_PATH_CODE ? null : null;
}

function getAdjacentRoomNames(roomName: string): string[] {
  const describeExits = (globalThis as { Game?: Partial<Game> }).Game?.map?.describeExits;
  if (typeof describeExits !== 'function') {
    return [];
  }

  const exits = describeExits(roomName) as Record<string, string> | null;
  if (!isRecord(exits)) {
    return [];
  }

  const orderedRooms = EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const adjacentRoom = exits[direction];
    return isNonEmptyString(adjacentRoom) ? [adjacentRoom] : [];
  });
  const remainingRooms = Object.entries(exits)
    .filter(([direction, adjacentRoom]) => !EXIT_DIRECTION_ORDER.includes(direction) && isNonEmptyString(adjacentRoom))
    .map(([, adjacentRoom]) => adjacentRoom)
    .sort();

  return [...orderedRooms, ...remainingRooms];
}

function getVisibleOwnedRoomNames(colonyName: string, ownerUsername: string | undefined): Set<string> {
  const rooms = getGameRooms();
  const roomNames = new Set<string>([colonyName]);
  if (!rooms) {
    return roomNames;
  }

  for (const room of Object.values(rooms)) {
    if (!room || !isNonEmptyString(room.name) || room.controller?.my !== true) {
      continue;
    }

    const roomOwnerUsername = getControllerOwnerUsername(room.controller);
    if (!ownerUsername || !roomOwnerUsername || ownerUsername === roomOwnerUsername) {
      roomNames.add(room.name);
    }
  }

  return roomNames;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  if (isNonEmptyString(username)) {
    return username;
  }

  return controller?.my === true ? 'me' : undefined;
}

function getControllerReservationUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { reservation?: { username?: string } }) | undefined)
    ?.reservation?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function findRoomObjects<T>(room: Room, findConstant: number | undefined): T[] {
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getFindConstant(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getGclLevel(): number | null {
  const level = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game?.gcl?.level;
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
}

function getGameTime(): number {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : 0;
}

function getGameRooms(): Record<string, Room> | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms as Record<string, Room> | undefined;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = getMemoryRecord();
  if (!memory) {
    return null;
  }

  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }

  return memory.territory as TerritoryMemory;
}

function getTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = getMemoryRecord();
  if (!memory || !isRecord(memory.territory)) {
    return null;
  }

  return memory.territory as TerritoryMemory;
}

function getMemoryRecord(): Partial<Memory> | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
