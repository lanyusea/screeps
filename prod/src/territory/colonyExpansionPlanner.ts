import type { ColonyStageAssessment } from '../colony/colonyStage';
import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  CLAIM_SCORE_RESERVED_PENALTY,
  scoreClaimTarget,
  type ClaimScore
} from './claimScoring';
import {
  MIN_ADJACENT_ROOM_RESERVATION_SCORE,
  refreshAdjacentRoomReservationIntent,
  type AdjacentRoomReservationEvaluation
} from './reservationPlanner';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';
import {
  TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY,
  TERRITORY_AUTO_CLAIM_MIN_RCL,
  TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY,
  isTerritoryAutoClaimReservationMature
} from './autoClaim';
import {
  buildRuntimeClaimedRoomSynergyEvidence,
  buildVisibleExpansionMineralEvidence,
  maxRoomsForRcl,
  scoreExpansionCandidates,
  type ExpansionClaimedRoomInput,
  type ExpansionCandidateInput
} from './expansionScoring';

export const COLONY_EXPANSION_CLAIM_TARGET_CREATOR: TerritoryAutomationSource = 'colonyExpansion';
export const MIN_COLONY_EXPANSION_CLAIM_SCORE = MIN_ADJACENT_ROOM_RESERVATION_SCORE;

export type ColonyExpansionSkipReason =
  | 'claimBlocked'
  | 'colonyUnstable'
  | 'existingClaimIntent'
  | 'noCandidate'
  | 'scoreBelowThreshold';

export interface ColonyExpansionEvaluation {
  status: 'planned' | 'skipped';
  colony: string;
  reason?: ColonyExpansionSkipReason;
  targetRoom?: string;
  controllerId?: Id<StructureController>;
  score?: number;
  reservation?: AdjacentRoomReservationEvaluation;
}

interface ColonyExpansionCandidate {
  roomName: string;
  order: number;
  claimScore: ClaimScore;
  effectiveScore: number;
  rankingScore: number;
  synergyScore: number;
  controllerState: ColonyExpansionControllerState;
  expansionCandidate: ExpansionCandidateInput;
}

interface ColonyExpansionControllerState {
  kind: 'neutral' | 'ownReserved' | 'foreignReserved' | 'owned' | 'missing' | 'unknown';
  controllerId?: Id<StructureController>;
  ticksToEnd?: number;
}

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;

export function refreshColonyExpansionIntent(
  colony: ColonySnapshot,
  assessment: Pick<ColonyStageAssessment, 'territoryReady'>,
  gameTime = getGameTime()
): ColonyExpansionEvaluation {
  const colonyName = colony.room.name;

  if (assessment.territoryReady !== true) {
    const reservation = refreshAdjacentRoomReservationIntent(colony, gameTime, {
      claimBlocker: 'colonyUnstable'
    });
    clearColonyExpansionClaimIntent(colonyName);
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'colonyUnstable',
      ...(reservation.targetRoom ? { targetRoom: reservation.targetRoom } : {}),
      ...(reservation.score !== undefined ? { score: reservation.score } : {}),
      reservation
    };
  }

  const reservation = refreshAdjacentRoomReservationIntent(colony, gameTime);
  if (reservation.status === 'planned' || reservation.claimBlocker) {
    clearColonyExpansionClaimIntent(colonyName);
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'claimBlocked',
      ...(reservation.targetRoom ? { targetRoom: reservation.targetRoom } : {}),
      ...(reservation.controllerId ? { controllerId: reservation.controllerId } : {}),
      ...(reservation.score !== undefined ? { score: reservation.score } : {}),
      reservation
    };
  }

  const candidate = selectColonyExpansionCandidate(colony);
  if (!candidate) {
    const fallbackReservation = refreshAdjacentRoomReservationIntent(colony, gameTime, {
      reserveWhenClaimAllowed: true
    });
    clearColonyExpansionClaimIntent(colonyName);
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'noCandidate',
      ...(fallbackReservation.targetRoom ? { targetRoom: fallbackReservation.targetRoom } : {}),
      ...(fallbackReservation.controllerId ? { controllerId: fallbackReservation.controllerId } : {}),
      ...(fallbackReservation.score !== undefined ? { score: fallbackReservation.score } : {}),
      reservation: fallbackReservation
    };
  }

  const baseEvaluation = {
    status: 'skipped' as const,
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.effectiveScore,
    ...(candidate.controllerState.controllerId ? { controllerId: candidate.controllerState.controllerId } : {}),
    reservation
  };

  if (candidate.effectiveScore < MIN_COLONY_EXPANSION_CLAIM_SCORE) {
    const fallbackReservation = refreshAdjacentRoomReservationIntent(colony, gameTime, {
      reserveWhenClaimAllowed: true
    });
    clearColonyExpansionClaimIntent(colonyName);
    return { ...baseEvaluation, reason: 'scoreBelowThreshold', reservation: fallbackReservation };
  }

  if (hasBlockingClaimIntent(colonyName, candidate.roomName)) {
    return { ...baseEvaluation, reason: 'existingClaimIntent' };
  }

  persistColonyExpansionClaimIntent(colonyName, candidate, gameTime);
  return {
    status: 'planned',
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.effectiveScore,
    ...(candidate.controllerState.controllerId ? { controllerId: candidate.controllerState.controllerId } : {}),
    reservation
  };
}

export function clearColonyExpansionClaimIntent(colony: string): void {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  pruneColonyExpansionClaimTargets(colony, territoryMemory);
}

function selectColonyExpansionCandidate(colony: ColonySnapshot): ColonyExpansionCandidate | null {
  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const claimedRooms = buildRuntimeClaimedRoomSynergyEvidence(colony.room, ownerUsername);
  const includeMineralSynergyEvidence = claimedRooms.some((room) => isNonEmptyString(room.mineralType));
  const candidates = getAdjacentRoomNames(colony.room.name).flatMap((roomName, order) => {
    if (!getVisibleRoom(roomName)) {
      return [];
    }

    const claimScore = scoreClaimTarget(roomName, colony.room);
    if (claimScore.sources <= 0 || hasHostileClaimScore(claimScore)) {
      return [];
    }

    const controllerState = getColonyExpansionControllerState(colony.room.name, roomName, ownerUsername);
    if (controllerState.kind !== 'neutral' && controllerState.kind !== 'ownReserved') {
      return [];
    }

    if (
      controllerState.kind === 'ownReserved' &&
      !isColonyReadyToClaimMatureReservation(colony, controllerState)
    ) {
      return [];
    }

    const effectiveScore =
      controllerState.kind === 'ownReserved'
        ? claimScore.score + CLAIM_SCORE_RESERVED_PENALTY
        : claimScore.score;
    return [
      {
        roomName,
        order,
        claimScore,
        effectiveScore,
        rankingScore: effectiveScore,
        synergyScore: 0,
        controllerState,
        expansionCandidate: toColonyExpansionCandidateInput(
          colony.room.name,
          roomName,
          order,
          claimScore,
          controllerState,
          ownerUsername,
          includeMineralSynergyEvidence
        )
      }
    ];
  });
  const claimableCandidates = candidates.filter(
    (candidate) => candidate.effectiveScore >= MIN_COLONY_EXPANSION_CLAIM_SCORE
  );
  if (claimableCandidates.length > 0) {
    applyColonyExpansionSynergyScores(colony, ownerUsername, claimedRooms, claimableCandidates);
    return selectBestColonyExpansionCandidate(claimableCandidates, compareColonyExpansionCandidates);
  }

  return selectBestColonyExpansionCandidate(candidates, compareColonyExpansionCandidatesByEffectiveScore);
}

function selectBestColonyExpansionCandidate(
  candidates: ColonyExpansionCandidate[],
  compareCandidates: (left: ColonyExpansionCandidate, right: ColonyExpansionCandidate) => number
): ColonyExpansionCandidate | null {
  let bestCandidate: ColonyExpansionCandidate | null = null;
  for (const candidate of candidates) {
    if (!bestCandidate || compareCandidates(candidate, bestCandidate) < 0) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function compareColonyExpansionCandidates(
  left: ColonyExpansionCandidate,
  right: ColonyExpansionCandidate
): number {
  return (
    right.rankingScore - left.rankingScore ||
    right.effectiveScore - left.effectiveScore ||
    right.claimScore.sources - left.claimScore.sources ||
    left.claimScore.distance - right.claimScore.distance ||
    left.order - right.order ||
    left.roomName.localeCompare(right.roomName)
  );
}

function compareColonyExpansionCandidatesByEffectiveScore(
  left: ColonyExpansionCandidate,
  right: ColonyExpansionCandidate
): number {
  return (
    right.effectiveScore - left.effectiveScore ||
    right.claimScore.sources - left.claimScore.sources ||
    left.claimScore.distance - right.claimScore.distance ||
    left.order - right.order ||
    left.roomName.localeCompare(right.roomName)
  );
}

function applyColonyExpansionSynergyScores(
  colony: ColonySnapshot,
  ownerUsername: string | undefined,
  claimedRooms: ExpansionClaimedRoomInput[],
  candidates: ColonyExpansionCandidate[]
): void {
  if (candidates.length === 0) {
    return;
  }

  const report = scoreExpansionCandidates({
    colonyName: colony.room.name,
    ...(ownerUsername ? { colonyOwnerUsername: ownerUsername } : {}),
    energyCapacityAvailable: colony.energyCapacityAvailable,
    ...(typeof colony.room.controller?.level === 'number' ? { controllerLevel: colony.room.controller.level } : {}),
    ownedRoomCount: countVisibleOwnedRooms(colony.room.name, ownerUsername),
    ...(typeof colony.room.controller?.ticksToDowngrade === 'number'
      ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade }
      : {}),
    claimedRooms,
    candidates: candidates.map((candidate) => candidate.expansionCandidate)
  });
  const synergyScoresByRoom = new Map(
    report.candidates.map((candidate) => [candidate.roomName, candidate.synergyScore])
  );

  for (const candidate of candidates) {
    candidate.synergyScore = synergyScoresByRoom.get(candidate.roomName) ?? 0;
    candidate.rankingScore = candidate.effectiveScore + candidate.synergyScore;
  }
}

function toColonyExpansionCandidateInput(
  colonyName: string,
  roomName: string,
  order: number,
  claimScore: ClaimScore,
  controllerState: ColonyExpansionControllerState,
  ownerUsername: string | undefined,
  includeMineralSynergyEvidence: boolean
): ExpansionCandidateInput {
  const room = getVisibleRoom(roomName);
  const mineral = includeMineralSynergyEvidence && room ? buildVisibleExpansionMineralEvidence(room) : undefined;
  return {
    roomName,
    order,
    adjacentToOwnedRoom: true,
    visible: room != null,
    routeDistance: claimScore.distance,
    nearestOwnedRoom: colonyName,
    nearestOwnedRoomDistance: 1,
    controller: getColonyExpansionControllerEvidence(controllerState, ownerUsername),
    ...(controllerState.controllerId ? { controllerId: controllerState.controllerId } : {}),
    sourceCount: claimScore.sources,
    ...(mineral ? { mineral } : {})
  };
}

function getColonyExpansionControllerEvidence(
  controllerState: ColonyExpansionControllerState,
  ownerUsername: string | undefined
): ExpansionCandidateInput['controller'] {
  if (controllerState.kind === 'ownReserved') {
    return {
      ...(ownerUsername ? { reservationUsername: ownerUsername } : {}),
      ...(typeof controllerState.ticksToEnd === 'number'
        ? { reservationTicksToEnd: controllerState.ticksToEnd }
        : {})
    };
  }

  return {};
}

function hasHostileClaimScore(score: ClaimScore): boolean {
  return score.details.some((detail) => detail.startsWith('hostile presence '));
}

function isColonyReadyToClaimMatureReservation(
  colony: ColonySnapshot,
  controllerState: ColonyExpansionControllerState
): boolean {
  const controller = colony.room.controller;
  const controllerLevel = controller?.level;
  if (
    typeof controllerLevel !== 'number' ||
    controllerLevel < TERRITORY_AUTO_CLAIM_MIN_RCL ||
    !isTerritoryAutoClaimReservationMature(controllerState.ticksToEnd)
  ) {
    return false;
  }

  if (colony.energyCapacityAvailable < TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY) {
    return false;
  }

  if (colony.energyAvailable < TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY) {
    return false;
  }

  if (hasActivePostClaimBootstrap(colony.room.name)) {
    return false;
  }

  const ownerUsername = getControllerOwnerUsername(controller);
  const ownedRoomCount = countVisibleOwnedRooms(colony.room.name, ownerUsername);
  if (ownedRoomCount >= maxRoomsForRcl(controllerLevel)) {
    return false;
  }

  const gclLevel = getGclLevel();
  return typeof gclLevel !== 'number' || ownedRoomCount < gclLevel;
}

function getColonyExpansionControllerState(
  colonyName: string,
  roomName: string,
  ownerUsername: string | undefined
): ColonyExpansionControllerState {
  const room = getVisibleRoom(roomName);
  if (room) {
    const controller = room.controller;
    if (!controller) {
      return { kind: 'missing' };
    }

    const controllerId = controller.id;
    if (controller.my === true || isNonEmptyString(controller.owner?.username)) {
      return { kind: 'owned', controllerId };
    }

    const reservationUsername = controller.reservation?.username;
    if (isNonEmptyString(reservationUsername)) {
      return reservationUsername === ownerUsername
        ? {
            kind: 'ownReserved',
            controllerId,
            ...(typeof controller.reservation?.ticksToEnd === 'number'
              ? { ticksToEnd: controller.reservation.ticksToEnd }
              : {})
          }
        : { kind: 'foreignReserved', controllerId };
    }

    return { kind: 'neutral', controllerId };
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
    return controller.reservationUsername === ownerUsername
      ? {
          kind: 'ownReserved',
          ...(controller.id ? { controllerId: controller.id } : {}),
          ...(typeof controller.reservationTicksToEnd === 'number'
            ? { ticksToEnd: controller.reservationTicksToEnd }
            : {})
        }
      : { kind: 'foreignReserved', ...(controller.id ? { controllerId: controller.id } : {}) };
  }

  return { kind: 'neutral', ...(controller.id ? { controllerId: controller.id } : {}) };
}

function hasBlockingClaimIntent(colony: string, targetRoom: string): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  if (
    Array.isArray(territoryMemory.targets) &&
    territoryMemory.targets.some(
      (target) =>
        isRecord(target) &&
        target.colony === colony &&
        target.action === 'claim' &&
        target.createdBy !== COLONY_EXPANSION_CLAIM_TARGET_CREATOR
    )
  ) {
    return true;
  }

  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) =>
      intent.colony === colony &&
      intent.action === 'claim' &&
      (intent.status === 'planned' || intent.status === 'active') &&
      (intent.targetRoom !== targetRoom || intent.createdBy !== COLONY_EXPANSION_CLAIM_TARGET_CREATOR)
  );
}

function persistColonyExpansionClaimIntent(
  colony: string,
  candidate: ColonyExpansionCandidate,
  gameTime: number
): void {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const target: TerritoryTargetMemory = {
    colony,
    roomName: candidate.roomName,
    action: 'claim',
    createdBy: COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
    ...(candidate.controllerState.controllerId ? { controllerId: candidate.controllerState.controllerId } : {}),
    ...(candidate.controllerState.kind === 'ownReserved'
      ? { postClaimBootstrapReserveEnergy: TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY }
      : {})
  };

  pruneAdjacentReservationForTarget(colony, candidate.roomName, territoryMemory);
  pruneColonyExpansionClaimTargets(colony, territoryMemory, target);
  upsertTerritoryTarget(territoryMemory, target);

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  upsertTerritoryIntent(intents, {
    colony,
    targetRoom: candidate.roomName,
    action: 'claim',
    status: getExistingColonyExpansionClaimIntentStatus(intents, colony, candidate.roomName),
    updatedAt: gameTime,
    createdBy: COLONY_EXPANSION_CLAIM_TARGET_CREATOR,
    ...(candidate.controllerState.controllerId ? { controllerId: candidate.controllerState.controllerId } : {}),
    ...(candidate.controllerState.kind === 'ownReserved'
      ? { postClaimBootstrapReserveEnergy: TERRITORY_AUTO_CLAIM_BOOTSTRAP_RESERVE_ENERGY }
      : {})
  });
}

function getExistingColonyExpansionClaimIntentStatus(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string
): TerritoryIntentMemory['status'] {
  return intents.some(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === 'claim' &&
      intent.createdBy === COLONY_EXPANSION_CLAIM_TARGET_CREATOR &&
      intent.status === 'active'
  )
    ? 'active'
    : 'planned';
}

function pruneColonyExpansionClaimTargets(
  colony: string,
  territoryMemory: TerritoryMemory,
  activeTarget?: TerritoryTargetMemory
): void {
  const removedRooms = new Set<string>();
  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter((target) => {
      if (
        !isRecord(target) ||
        target.colony !== colony ||
        target.action !== 'claim' ||
        target.createdBy !== COLONY_EXPANSION_CLAIM_TARGET_CREATOR
      ) {
        return true;
      }

      if (activeTarget && isSameTarget(target, activeTarget)) {
        return true;
      }

      if (isNonEmptyString(target.roomName)) {
        removedRooms.add(target.roomName);
      }
      return false;
    });
  }

  if (removedRooms.size === 0) {
    return;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) =>
      intent.colony !== colony ||
      intent.createdBy !== COLONY_EXPANSION_CLAIM_TARGET_CREATOR ||
      intent.action !== 'claim' ||
      !removedRooms.has(intent.targetRoom)
  );
  territoryMemory.intents = intents;
}

function pruneAdjacentReservationForTarget(
  colony: string,
  targetRoom: string,
  territoryMemory: TerritoryMemory
): void {
  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter(
      (target) =>
        !(
          isRecord(target) &&
          target.colony === colony &&
          target.roomName === targetRoom &&
          target.action === 'reserve' &&
          target.createdBy === 'adjacentRoomReservation'
        )
    );
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) =>
      !(
        intent.colony === colony &&
        intent.targetRoom === targetRoom &&
        intent.action === 'reserve' &&
        intent.createdBy === 'adjacentRoomReservation'
      )
  );
  territoryMemory.intents = intents;
}

function upsertTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingTarget = territoryMemory.targets.find((rawTarget) => isSameTarget(rawTarget, target));
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }

  if (isRecord(existingTarget)) {
    existingTarget.createdBy = COLONY_EXPANSION_CLAIM_TARGET_CREATOR;
    existingTarget.enabled = target.enabled;
    if (target.postClaimBootstrapReserveEnergy) {
      existingTarget.postClaimBootstrapReserveEnergy = target.postClaimBootstrapReserveEnergy;
    } else {
      delete existingTarget.postClaimBootstrapReserveEnergy;
    }
    if (target.controllerId) {
      existingTarget.controllerId = target.controllerId;
    } else {
      delete existingTarget.controllerId;
    }
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
      intent.action === nextIntent.action &&
      intent.createdBy === nextIntent.createdBy
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
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

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
}

function getScoutIntel(homeRoomName: string, roomName: string): TerritoryScoutIntelMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.scoutIntel?.[
    `${homeRoomName}>${roomName}`
  ];
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
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
}

function hasActivePostClaimBootstrap(colonyName: string): boolean {
  const records = getTerritoryMemoryRecord()?.postClaimBootstraps;
  if (!isRecord(records)) {
    return false;
  }

  return Object.values(records).some(
    (record) =>
      isRecord(record) &&
      record.colony === colonyName &&
      record.status !== 'ready'
  );
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = controller?.owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getTerritoryMemoryRecord(): TerritoryMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory as TerritoryMemory | undefined;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!memory.territory) {
    memory.territory = {};
  }

  return memory.territory as TerritoryMemory;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
