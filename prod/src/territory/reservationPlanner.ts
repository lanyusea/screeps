import type { ColonySnapshot } from '../colony/colonyRegistry';
import { buildTerritoryReserverBody } from '../spawn/bodyBuilder';
import {
  CLAIM_SCORE_RESERVED_PENALTY,
  scoreClaimTarget,
  type ClaimScore
} from './claimScoring';
import { maxRoomsForRcl } from './expansionScoring';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export const ADJACENT_ROOM_RESERVATION_TARGET_CREATOR: TerritoryAutomationSource =
  'adjacentRoomReservation';
export const MIN_ADJACENT_ROOM_RESERVATION_SCORE = 500;
export const ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART = 600;
const MAX_ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS = 1_000;
const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;

export type AdjacentRoomReservationClaimBlocker =
  | 'controllerLevelLow'
  | 'gclInsufficient'
  | 'rclRoomLimitReached';

export type AdjacentRoomReservationSkipReason =
  | 'claimAllowed'
  | 'energyCapacityLow'
  | 'existingTerritoryPlan'
  | 'noCandidate'
  | 'reservationHealthy';

export interface AdjacentRoomReservationEvaluation {
  status: 'planned' | 'skipped';
  colony: string;
  reason?: AdjacentRoomReservationSkipReason;
  claimBlocker?: AdjacentRoomReservationClaimBlocker;
  targetRoom?: string;
  controllerId?: Id<StructureController>;
  score?: number;
  reservationTicksToEnd?: number;
  renewalThresholdTicks?: number;
}

interface AdjacentRoomReservationCandidate {
  roomName: string;
  order: number;
  score: ClaimScore;
  effectiveScore: number;
  controllerState: ReservationControllerState;
  renewalThresholdTicks: number;
  actionable: boolean;
}

interface ReservationControllerState {
  kind: 'neutral' | 'ownReserved' | 'hostileReserved' | 'owned' | 'missing' | 'unknown';
  controllerId?: Id<StructureController>;
  ticksToEnd?: number;
}

export function refreshAdjacentRoomReservationIntent(
  colony: ColonySnapshot,
  gameTime = getGameTime()
): AdjacentRoomReservationEvaluation {
  const evaluation = selectAdjacentRoomReservationPlan(colony);
  if (evaluation.status === 'planned' && evaluation.targetRoom) {
    persistAdjacentRoomReservationIntent(colony.room.name, evaluation, gameTime);
    return evaluation;
  }

  clearAdjacentRoomReservationIntent(colony.room.name);
  return evaluation;
}

export function selectAdjacentRoomReservationPlan(
  colony: ColonySnapshot
): AdjacentRoomReservationEvaluation {
  const colonyName = colony.room.name;
  const claimBlocker = getAdjacentRoomClaimBlocker(colony);
  if (!claimBlocker) {
    return { status: 'skipped', colony: colonyName, reason: 'claimAllowed' };
  }

  if (hasBlockingTerritoryPlan(colonyName)) {
    return { status: 'skipped', colony: colonyName, reason: 'existingTerritoryPlan', claimBlocker };
  }

  const claimPartCount = getReservationClaimPartCount(colony.energyCapacityAvailable);
  if (claimPartCount <= 0) {
    return { status: 'skipped', colony: colonyName, reason: 'energyCapacityLow', claimBlocker };
  }

  const renewalThresholdTicks = getAdjacentRoomReservationRenewalThreshold(claimPartCount);
  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const candidates = getAdjacentRoomNames(colonyName).flatMap((roomName, order) =>
    buildReservationCandidate(colony.room, roomName, order, ownerUsername, renewalThresholdTicks)
  );
  const actionableCandidate = selectBestReservationCandidate(
    candidates.filter((candidate) => candidate.actionable)
  );
  if (actionableCandidate) {
    return toPlannedEvaluation(colonyName, claimBlocker, actionableCandidate);
  }

  const healthyReservation = selectBestReservationCandidate(
    candidates.filter((candidate) => candidate.controllerState.kind === 'ownReserved')
  );
  if (healthyReservation) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'reservationHealthy',
      claimBlocker,
      targetRoom: healthyReservation.roomName,
      score: healthyReservation.effectiveScore,
      renewalThresholdTicks,
      ...(healthyReservation.controllerState.controllerId
        ? { controllerId: healthyReservation.controllerState.controllerId }
        : {}),
      ...(typeof healthyReservation.controllerState.ticksToEnd === 'number'
        ? { reservationTicksToEnd: healthyReservation.controllerState.ticksToEnd }
        : {})
    };
  }

  return { status: 'skipped', colony: colonyName, reason: 'noCandidate', claimBlocker };
}

export function clearAdjacentRoomReservationIntent(colony: string): void {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  pruneAdjacentRoomReservationTargets(colony, territoryMemory);
}

export function getAdjacentRoomReservationRenewalThreshold(claimPartCount: number): number {
  const claimParts = Math.max(0, Math.floor(claimPartCount));
  if (claimParts <= 0) {
    return 0;
  }

  return Math.min(
    claimParts * ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS_PER_CLAIM_PART,
    MAX_ADJACENT_ROOM_RESERVATION_RENEWAL_TICKS
  );
}

function buildReservationCandidate(
  homeRoom: Room,
  roomName: string,
  order: number,
  ownerUsername: string | undefined,
  renewalThresholdTicks: number
): AdjacentRoomReservationCandidate[] {
  const score = scoreClaimTarget(roomName, homeRoom);
  if (score.sources <= 0) {
    return [];
  }

  const controllerState = getReservationControllerState(homeRoom.name, roomName, ownerUsername);
  if (controllerState.kind !== 'neutral' && controllerState.kind !== 'ownReserved') {
    return [];
  }

  if (hasHostilePresence(homeRoom.name, roomName)) {
    return [];
  }

  const effectiveScore =
    controllerState.kind === 'ownReserved'
      ? score.score + CLAIM_SCORE_RESERVED_PENALTY
      : score.score;
  if (effectiveScore < MIN_ADJACENT_ROOM_RESERVATION_SCORE) {
    return [];
  }

  const actionable =
    controllerState.kind === 'neutral' ||
    typeof controllerState.ticksToEnd !== 'number' ||
    controllerState.ticksToEnd <= renewalThresholdTicks;

  return [
    {
      roomName,
      order,
      score,
      effectiveScore,
      controllerState,
      renewalThresholdTicks,
      actionable
    }
  ];
}

function toPlannedEvaluation(
  colony: string,
  claimBlocker: AdjacentRoomReservationClaimBlocker,
  candidate: AdjacentRoomReservationCandidate
): AdjacentRoomReservationEvaluation {
  return {
    status: 'planned',
    colony,
    claimBlocker,
    targetRoom: candidate.roomName,
    score: candidate.effectiveScore,
    renewalThresholdTicks: candidate.renewalThresholdTicks,
    ...(candidate.controllerState.controllerId ? { controllerId: candidate.controllerState.controllerId } : {}),
    ...(candidate.controllerState.kind === 'ownReserved' &&
    typeof candidate.controllerState.ticksToEnd === 'number'
      ? { reservationTicksToEnd: candidate.controllerState.ticksToEnd }
      : {})
  };
}

function selectBestReservationCandidate(
  candidates: AdjacentRoomReservationCandidate[]
): AdjacentRoomReservationCandidate | null {
  let bestCandidate: AdjacentRoomReservationCandidate | null = null;
  for (const candidate of candidates) {
    if (!bestCandidate || compareReservationCandidates(candidate, bestCandidate) < 0) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function compareReservationCandidates(
  left: AdjacentRoomReservationCandidate,
  right: AdjacentRoomReservationCandidate
): number {
  return (
    right.effectiveScore - left.effectiveScore ||
    right.score.sources - left.score.sources ||
    left.score.distance - right.score.distance ||
    left.order - right.order ||
    left.roomName.localeCompare(right.roomName)
  );
}

function getAdjacentRoomClaimBlocker(
  colony: ColonySnapshot
): AdjacentRoomReservationClaimBlocker | null {
  const controller = colony.room.controller;
  const controllerLevel = controller?.level;
  if (typeof controllerLevel !== 'number' || controllerLevel < 2) {
    return 'controllerLevelLow';
  }

  const ownerUsername = getControllerOwnerUsername(controller);
  const ownedRoomCount = countVisibleOwnedRooms(colony.room.name, ownerUsername);
  const gclLevel = getGclLevel();
  if (typeof gclLevel === 'number' && ownedRoomCount >= gclLevel) {
    return 'gclInsufficient';
  }

  if (ownedRoomCount >= maxRoomsForRcl(controllerLevel)) {
    return 'rclRoomLimitReached';
  }

  return null;
}

function getReservationClaimPartCount(energyCapacityAvailable: number): number {
  return buildTerritoryReserverBody(energyCapacityAvailable).filter((part) => part === 'claim').length;
}

function getReservationControllerState(
  colonyName: string,
  roomName: string,
  ownerUsername: string | undefined
): ReservationControllerState {
  const room = getVisibleRoom(roomName);
  if (room) {
    const controller = room.controller;
    if (!controller) {
      return { kind: 'missing' };
    }

    return getVisibleControllerReservationState(controller, ownerUsername);
  }

  const scoutIntel = getScoutIntel(colonyName, roomName);
  if (!scoutIntel) {
    return { kind: 'unknown' };
  }

  const controller = scoutIntel.controller;
  if (!controller) {
    return { kind: 'missing' };
  }

  if (controller.my === true || isNonEmptyString(controller.ownerUsername)) {
    return { kind: 'owned', ...(controller.id ? { controllerId: controller.id } : {}) };
  }

  if (isNonEmptyString(controller.reservationUsername)) {
    if (isNonEmptyString(ownerUsername) && controller.reservationUsername === ownerUsername) {
      return {
        kind: 'ownReserved',
        ...(controller.id ? { controllerId: controller.id } : {}),
        ...(typeof controller.reservationTicksToEnd === 'number'
          ? { ticksToEnd: controller.reservationTicksToEnd }
          : {})
      };
    }

    return { kind: 'hostileReserved', ...(controller.id ? { controllerId: controller.id } : {}) };
  }

  return { kind: 'neutral', ...(controller.id ? { controllerId: controller.id } : {}) };
}

function getVisibleControllerReservationState(
  controller: StructureController,
  ownerUsername: string | undefined
): ReservationControllerState {
  const controllerId = controller.id;
  if (controller.my === true || isNonEmptyString(controller.owner?.username)) {
    return { kind: 'owned', controllerId };
  }

  const reservation = controller.reservation;
  if (isNonEmptyString(reservation?.username)) {
    if (isNonEmptyString(ownerUsername) && reservation.username === ownerUsername) {
      return {
        kind: 'ownReserved',
        controllerId,
        ...(typeof reservation.ticksToEnd === 'number' ? { ticksToEnd: reservation.ticksToEnd } : {})
      };
    }

    return { kind: 'hostileReserved', controllerId };
  }

  return { kind: 'neutral', controllerId };
}

function hasHostilePresence(colonyName: string, roomName: string): boolean {
  const room = getVisibleRoom(roomName);
  if (room) {
    return countVisibleHostiles(room) > 0;
  }

  const scoutIntel = getScoutIntel(colonyName, roomName);
  return (
    (scoutIntel?.hostileCreepCount ?? 0) +
      (scoutIntel?.hostileStructureCount ?? 0) +
      (scoutIntel?.hostileSpawnCount ?? 0) >
    0
  );
}

function countVisibleHostiles(room: Room): number {
  return (
    countVisibleRoomObjects(room, getFindConstant('FIND_HOSTILE_CREEPS')) +
    countVisibleRoomObjects(room, getFindConstant('FIND_HOSTILE_STRUCTURES'))
  );
}

function persistAdjacentRoomReservationIntent(
  colony: string,
  evaluation: AdjacentRoomReservationEvaluation,
  gameTime: number
): void {
  if (!evaluation.targetRoom) {
    return;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const target: TerritoryTargetMemory = {
    colony,
    roomName: evaluation.targetRoom,
    action: 'reserve',
    createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR,
    ...(evaluation.controllerId ? { controllerId: evaluation.controllerId } : {})
  };
  pruneAdjacentRoomReservationTargets(colony, territoryMemory, target);
  upsertAdjacentRoomReservationTarget(territoryMemory, target);

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const existingIntent = intents.find(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === target.roomName &&
      intent.action === 'reserve' &&
      intent.createdBy === ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
  );
  territoryMemory.intents = intents;
  upsertAdjacentRoomReservationIntent(intents, {
    colony,
    targetRoom: target.roomName,
    action: 'reserve',
    status: existingIntent?.status === 'active' ? 'active' : 'planned',
    updatedAt: gameTime,
    createdBy: ADJACENT_ROOM_RESERVATION_TARGET_CREATOR,
    ...(target.controllerId ? { controllerId: target.controllerId } : {})
  });
}

function pruneAdjacentRoomReservationTargets(
  colony: string,
  territoryMemory: TerritoryMemory,
  activeTarget?: TerritoryTargetMemory
): void {
  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter((rawTarget) => {
      if (!isAdjacentRoomReservationTarget(rawTarget, colony)) {
        return true;
      }

      return activeTarget !== undefined && isSameTarget(rawTarget, activeTarget);
    });
    if (territoryMemory.targets.length === 0) {
      delete territoryMemory.targets;
    }
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents).filter((intent) => {
    if (
      intent.colony !== colony ||
      intent.createdBy !== ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
    ) {
      return true;
    }

    return (
      activeTarget !== undefined &&
      intent.targetRoom === activeTarget.roomName &&
      intent.action === activeTarget.action
    );
  });

  if (intents.length > 0) {
    territoryMemory.intents = intents;
  } else {
    delete territoryMemory.intents;
  }
}

function upsertAdjacentRoomReservationTarget(
  territoryMemory: TerritoryMemory,
  target: TerritoryTargetMemory
): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingTarget = territoryMemory.targets.find((rawTarget) =>
    isSameTarget(rawTarget, target)
  );
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }

  if (isRecord(existingTarget)) {
    existingTarget.createdBy = ADJACENT_ROOM_RESERVATION_TARGET_CREATOR;
    existingTarget.enabled = target.enabled;
    if (target.controllerId) {
      existingTarget.controllerId = target.controllerId;
    } else {
      delete existingTarget.controllerId;
    }
  }
}

function upsertAdjacentRoomReservationIntent(
  intents: TerritoryIntentMemory[],
  nextIntent: TerritoryIntentMemory
): void {
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === nextIntent.colony &&
      intent.targetRoom === nextIntent.targetRoom &&
      intent.action === nextIntent.action &&
      intent.createdBy === nextIntent.createdBy
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
}

function hasBlockingTerritoryPlan(colony: string): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  if (
    Array.isArray(territoryMemory.targets) &&
    territoryMemory.targets.some((target) => isBlockingTerritoryTarget(target, colony))
  ) {
    return true;
  }

  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) =>
      intent.colony === colony &&
      intent.createdBy !== ADJACENT_ROOM_RESERVATION_TARGET_CREATOR &&
      (intent.status === 'planned' || intent.status === 'active') &&
      (intent.action === 'claim' || intent.action === 'reserve' || intent.action === 'scout')
  );
}

function isBlockingTerritoryTarget(target: unknown, colony: string): boolean {
  return (
    isRecord(target) &&
    target.colony === colony &&
    target.enabled !== false &&
    target.createdBy !== ADJACENT_ROOM_RESERVATION_TARGET_CREATOR &&
    (target.action === 'claim' || target.action === 'reserve')
  );
}

function isAdjacentRoomReservationTarget(target: unknown, colony: string): boolean {
  return (
    isRecord(target) &&
    target.colony === colony &&
    target.action === 'reserve' &&
    target.createdBy === ADJACENT_ROOM_RESERVATION_TARGET_CREATOR
  );
}

function isSameTarget(left: unknown, right: TerritoryTargetMemory): boolean {
  return (
    isRecord(left) &&
    left.colony === right.colony &&
    left.roomName === right.roomName &&
    left.action === right.action
  );
}

function getAdjacentRoomNames(roomName: string): string[] {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  if (!gameMap || typeof gameMap.describeExits !== 'function') {
    return [];
  }

  const exits = gameMap.describeExits(roomName) as ExitsInformation | null;
  if (!isRecord(exits)) {
    return [];
  }

  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const exitRoom = exits[direction];
    return isNonEmptyString(exitRoom) ? [exitRoom] : [];
  });
}

function countVisibleOwnedRooms(colonyName: string, ownerUsername: string | undefined): number {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return 1;
  }

  let ownedRoomCount = 0;
  for (const room of Object.values(rooms)) {
    if (
      room?.controller?.my === true &&
      isNonEmptyString(room.name) &&
      (!ownerUsername || getControllerOwnerUsername(room.controller) === ownerUsername)
    ) {
      ownedRoomCount += 1;
    }
  }

  return Math.max(1, ownedRoomCount || (rooms[colonyName]?.controller?.my === true ? 1 : 0));
}

function getGclLevel(): number | null {
  const level = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game?.gcl?.level;
  if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0) {
    return null;
  }

  return Math.floor(level);
}

function getScoutIntel(colonyName: string, roomName: string): TerritoryScoutIntelMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.scoutIntel?.[
    `${colonyName}>${roomName}`
  ];
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
}

function countVisibleRoomObjects(room: Room, findConstant: number | undefined): number {
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return 0;
  }

  const result = room.find(findConstant as FindConstant);
  return Array.isArray(result) ? result.length : 0;
}

function getFindConstant(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getTerritoryMemoryRecord(): TerritoryMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const root = globalThis as { Memory?: Partial<Memory> };
  if (!root.Memory) {
    root.Memory = {};
  }

  if (!root.Memory.territory) {
    root.Memory.territory = {};
  }

  return root.Memory.territory;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
