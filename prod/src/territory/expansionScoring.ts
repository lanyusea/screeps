import type { ColonySnapshot } from '../colony/colonyRegistry';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export const NEXT_EXPANSION_TARGET_CREATOR: TerritoryAutomationSource = 'nextExpansionScoring';

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;
const TERRITORY_ROUTE_DISTANCE_SEPARATOR = '>';
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const MAX_NEARBY_EXPANSION_ROUTE_DISTANCE = 2;
const TERRAIN_SCAN_MIN = 2;
const TERRAIN_SCAN_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const DEFAULT_TERRAIN_SWAMP_MASK = 2;
const DOWNGRADE_GUARD_TICKS = 5_000;
const MIN_CONTROLLER_LEVEL = 2;
const FOREIGN_RESERVATION_CONTROLLER_PRESSURE_RISK = 'foreign reservation requires controller pressure';
const ROOM_LIMIT_PRECONDITION_PREFIX = 'limit expansion to ';
const MAX_ROOM_COUNT_BY_RCL: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 3,
  5: 5,
  6: 8,
  7: 15,
  8: 99
};

export type ExpansionCandidateEvidenceStatus = 'sufficient' | 'insufficient-evidence' | 'unavailable';

export interface ExpansionCandidateReport {
  colonyName?: string;
  candidates: ExpansionCandidateScore[];
  next: ExpansionCandidateScore | null;
}

export interface ExpansionCandidateScore {
  roomName: string;
  score: number;
  evidenceStatus: ExpansionCandidateEvidenceStatus;
  rationale: string[];
  preconditions: string[];
  risks: string[];
  routeDistance?: number;
  nearestOwnedRoom?: string;
  nearestOwnedRoomDistance?: number;
  adjacentToOwnedRoom: boolean;
  controllerId?: Id<StructureController>;
  sourceCount?: number;
  controllerSourceRange?: number;
  terrain?: ExpansionTerrainQuality;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  reservation?: ExpansionReservationEvidence;
  requiresControllerPressure?: boolean;
}

export interface ExpansionScoringInput {
  colonyName: string;
  colonyOwnerUsername?: string;
  energyCapacityAvailable: number;
  controllerLevel?: number;
  ownedRoomCount?: number;
  ticksToDowngrade?: number;
  activePostClaimBootstrapCount?: number;
  candidates: ExpansionCandidateInput[];
}

export interface ExpansionCandidateInput {
  roomName: string;
  order: number;
  adjacentToOwnedRoom: boolean;
  routeDistance?: number | null;
  nearestOwnedRoom?: string;
  nearestOwnedRoomDistance?: number | null;
  controller?: ExpansionControllerEvidence;
  controllerId?: Id<StructureController>;
  sourceCount?: number;
  controllerSourceRange?: number;
  terrain?: ExpansionTerrainQuality;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
}

export interface ExpansionControllerEvidence {
  my?: boolean;
  ownerUsername?: string;
  reservationUsername?: string;
  reservationTicksToEnd?: number;
}

export interface ExpansionTerrainQuality {
  walkableRatio: number;
  swampRatio: number;
  wallRatio: number;
}

export interface ExpansionReservationEvidence {
  username: string;
  relation: 'own' | 'foreign';
  ticksToEnd?: number;
}

export type NextExpansionTargetSelectionStatus = 'planned' | 'skipped';
export type NextExpansionTargetSelectionReason =
  | 'noCandidate'
  | 'roomLimitReached'
  | 'unmetPreconditions'
  | 'insufficientEvidence'
  | 'unavailable';

export interface NextExpansionTargetSelection {
  status: NextExpansionTargetSelectionStatus;
  colony: string;
  reason?: NextExpansionTargetSelectionReason;
  targetRoom?: string;
  controllerId?: Id<StructureController>;
  score?: number;
}

export function buildRuntimeExpansionCandidateReport(colony: ColonySnapshot): ExpansionCandidateReport {
  return scoreExpansionCandidates(buildRuntimeExpansionScoringInput(colony));
}

export function scoreExpansionCandidates(input: ExpansionScoringInput): ExpansionCandidateReport {
  const candidates = input.candidates
    .filter((candidate) => candidate.roomName !== input.colonyName)
    .map((candidate) => scoreExpansionCandidate(input, candidate))
    .sort(compareExpansionCandidates);
  const next = candidates.find((candidate) => candidate.evidenceStatus !== 'unavailable') ?? null;

  return attachExpansionCandidateReportColony({ candidates, next }, input.colonyName);
}

export function refreshNextExpansionTargetSelection(
  colony: ColonySnapshot,
  report: ExpansionCandidateReport,
  gameTime: number
): NextExpansionTargetSelection {
  const colonyName = colony.room.name;
  const candidate = selectPersistableExpansionCandidate(report);
  if (!candidate) {
    pruneNextExpansionTargets(colonyName);
    return {
      status: 'skipped',
      colony: colonyName,
      reason: getSelectionSkipReason(report)
    };
  }

  persistNextExpansionTarget(colonyName, candidate, gameTime);
  return {
    status: 'planned',
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
}

function buildRuntimeExpansionScoringInput(colony: ColonySnapshot): ExpansionScoringInput {
  return {
    colonyName: colony.room.name,
    ...(getControllerOwnerUsername(colony.room.controller)
      ? { colonyOwnerUsername: getControllerOwnerUsername(colony.room.controller) }
      : {}),
    energyCapacityAvailable: colony.energyCapacityAvailable,
    ...(typeof colony.room.controller?.level === 'number' ? { controllerLevel: colony.room.controller.level } : {}),
    ownedRoomCount: countVisibleOwnedRooms(colony.room.name, getControllerOwnerUsername(colony.room.controller)),
    ...(typeof colony.room.controller?.ticksToDowngrade === 'number'
      ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade }
      : {}),
    activePostClaimBootstrapCount: countActivePostClaimBootstraps(),
    candidates: buildRuntimeExpansionCandidates(colony)
  };
}

export function maxRoomsForRcl(controllerLevel: number | undefined): number {
  if (typeof controllerLevel !== 'number' || !Number.isFinite(controllerLevel)) {
    return MAX_ROOM_COUNT_BY_RCL[1];
  }

  const rcl = Math.min(8, Math.max(1, Math.floor(controllerLevel)));
  return MAX_ROOM_COUNT_BY_RCL[rcl];
}

function buildRuntimeExpansionCandidates(colony: ColonySnapshot): ExpansionCandidateInput[] {
  const rooms = getGameRooms();
  if (!rooms) {
    return [];
  }

  const colonyName = colony.room.name;
  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomNames = getVisibleOwnedRoomNames(colonyName, ownerUsername);
  const adjacentRoomNames = getAdjacentRoomNamesByOwnedRoom(ownedRoomNames);
  const candidates: ExpansionCandidateInput[] = [];
  let order = 0;

  for (const room of Object.values(rooms)) {
    if (!room || !isNonEmptyString(room.name) || room.name === colonyName || ownedRoomNames.has(room.name)) {
      continue;
    }

    const routeDistance = getKnownRouteLength(colonyName, room.name);
    const nearestOwnedDistance = getNearestOwnedRoomDistance(ownedRoomNames, room.name, adjacentRoomNames);
    const adjacentToOwnedRoom = isAdjacentToOwnedRoom(room.name, adjacentRoomNames);
    if (!isNearbyExpansionCandidate(routeDistance, nearestOwnedDistance, adjacentToOwnedRoom)) {
      continue;
    }

    candidates.push({
      roomName: room.name,
      order,
      adjacentToOwnedRoom,
      ...(routeDistance !== undefined ? { routeDistance } : {}),
      ...(nearestOwnedDistance.roomName ? { nearestOwnedRoom: nearestOwnedDistance.roomName } : {}),
      ...(nearestOwnedDistance.distance !== undefined
        ? { nearestOwnedRoomDistance: nearestOwnedDistance.distance }
        : {}),
      ...buildVisibleExpansionCandidateEvidence(room)
    });
    order += 1;
  }

  return candidates;
}

function buildVisibleExpansionCandidateEvidence(
  room: Room
): Omit<ExpansionCandidateInput, 'roomName' | 'order' | 'adjacentToOwnedRoom'> {
  const controller = room.controller;
  const sources = findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES'));
  const controllerSourceRange = calculateAverageControllerSourceRange(controller, sources);
  const terrain = summarizeRoomTerrain(room);
  const hostileCreepCount = findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length;
  const hostileStructureCount = findRoomObjects<AnyStructure>(
    room,
    getFindConstant('FIND_HOSTILE_STRUCTURES')
  ).length;

  return {
    ...(controller ? { controller: summarizeExpansionController(controller) } : {}),
    ...(typeof controller?.id === 'string' ? { controllerId: controller.id as Id<StructureController> } : {}),
    sourceCount: sources.length,
    ...(typeof controllerSourceRange === 'number' ? { controllerSourceRange } : {}),
    ...(terrain ? { terrain } : {}),
    hostileCreepCount,
    hostileStructureCount
  };
}

function scoreExpansionCandidate(
  input: ExpansionScoringInput,
  candidate: ExpansionCandidateInput
): ExpansionCandidateScore {
  const rationale: string[] = [];
  const risks: string[] = [];
  const preconditions = getExpansionPreconditions(input);
  let evidenceStatus: ExpansionCandidateEvidenceStatus = 'sufficient';

  const routeDistance = candidate.routeDistance === null ? undefined : candidate.routeDistance;
  const nearestOwnedRoomDistance =
    candidate.nearestOwnedRoomDistance === null ? undefined : candidate.nearestOwnedRoomDistance;
  if (candidate.routeDistance === null || candidate.nearestOwnedRoomDistance === null) {
    risks.push('no known route from owned territory');
    evidenceStatus = 'unavailable';
  }

  if (!candidate.controller) {
    risks.push('visible room has no controller');
    evidenceStatus = 'unavailable';
  } else {
    const controllerStatus = getControllerStatus(input, candidate.controller);
    rationale.push(controllerStatus.rationale);
    if (controllerStatus.risk) {
      risks.push(controllerStatus.risk);
    }
    if (controllerStatus.unavailable) {
      evidenceStatus = 'unavailable';
    }
  }

  if (typeof candidate.sourceCount === 'number') {
    rationale.push(`${candidate.sourceCount} sources visible`);
  } else {
    risks.push('source count evidence missing');
    evidenceStatus = downgradeEvidenceStatus(evidenceStatus, 'insufficient-evidence');
  }

  if (typeof candidate.controllerSourceRange === 'number') {
    rationale.push(`controller-source range ${candidate.controllerSourceRange}`);
  } else {
    risks.push('controller proximity evidence missing');
    evidenceStatus = downgradeEvidenceStatus(evidenceStatus, 'insufficient-evidence');
  }

  if (candidate.terrain) {
    rationale.push(`terrain walkable ${toPercent(candidate.terrain.walkableRatio)}`);
  } else {
    risks.push('terrain quality evidence missing');
    evidenceStatus = downgradeEvidenceStatus(evidenceStatus, 'insufficient-evidence');
  }

  const hostileCreepCount = candidate.hostileCreepCount ?? 0;
  const hostileStructureCount = candidate.hostileStructureCount ?? 0;
  if (hostileCreepCount > 0 || hostileStructureCount > 0) {
    risks.push('hostile presence visible');
    evidenceStatus = 'unavailable';
  }

  if (typeof routeDistance === 'number') {
    rationale.push(`home route distance ${routeDistance}`);
  }
  if (typeof nearestOwnedRoomDistance === 'number') {
    rationale.push(`nearest owned distance ${nearestOwnedRoomDistance}`);
  }
  if (candidate.adjacentToOwnedRoom) {
    rationale.push('adjacent to owned territory');
  }

  const score = calculateExpansionScore(input, candidate, evidenceStatus);
  const reservation = getReservationEvidence(input, candidate.controller);
  const requiresControllerPressure = reservation?.relation === 'foreign';
  return {
    roomName: candidate.roomName,
    score,
    evidenceStatus,
    rationale,
    preconditions,
    risks,
    adjacentToOwnedRoom: candidate.adjacentToOwnedRoom,
    ...(routeDistance !== undefined ? { routeDistance } : {}),
    ...(candidate.nearestOwnedRoom ? { nearestOwnedRoom: candidate.nearestOwnedRoom } : {}),
    ...(nearestOwnedRoomDistance !== undefined ? { nearestOwnedRoomDistance } : {}),
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {}),
    ...(candidate.sourceCount !== undefined ? { sourceCount: candidate.sourceCount } : {}),
    ...(candidate.controllerSourceRange !== undefined
      ? { controllerSourceRange: candidate.controllerSourceRange }
      : {}),
    ...(candidate.terrain ? { terrain: candidate.terrain } : {}),
    ...(candidate.hostileCreepCount !== undefined ? { hostileCreepCount: candidate.hostileCreepCount } : {}),
    ...(candidate.hostileStructureCount !== undefined
      ? { hostileStructureCount: candidate.hostileStructureCount }
      : {}),
    ...(reservation ? { reservation } : {}),
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {})
  };
}

function calculateExpansionScore(
  input: ExpansionScoringInput,
  candidate: ExpansionCandidateInput,
  evidenceStatus: ExpansionCandidateEvidenceStatus
): number {
  const sourceScore = typeof candidate.sourceCount === 'number'
    ? Math.min(candidate.sourceCount, 2) * 120 + Math.max(0, candidate.sourceCount - 2) * 20
    : 0;
  const proximityScore = typeof candidate.controllerSourceRange === 'number'
    ? Math.max(-80, 100 - candidate.controllerSourceRange * 6)
    : 0;
  const terrainScore = candidate.terrain
    ? Math.round(candidate.terrain.walkableRatio * 140 - candidate.terrain.swampRatio * 70)
    : 0;
  const reservationScore = getReservationScore(input, candidate.controller);
  const distanceScore = getDistanceScore(candidate);
  const adjacencyScore = candidate.adjacentToOwnedRoom ? 40 : 0;
  const hostilePenalty = (candidate.hostileCreepCount ?? 0) * 240 + (candidate.hostileStructureCount ?? 0) * 140;
  const unavailablePenalty = evidenceStatus === 'unavailable' ? 2_000 : 0;
  const insufficientEvidencePenalty = evidenceStatus === 'insufficient-evidence' ? 260 : 0;
  const preconditionPenalty = getExpansionPreconditions(input).length * 120;

  return Math.round(
    500 +
      sourceScore +
      proximityScore +
      terrainScore +
      reservationScore +
      distanceScore +
      adjacencyScore -
      hostilePenalty -
      unavailablePenalty -
      insufficientEvidencePenalty -
      preconditionPenalty
  );
}

function getDistanceScore(candidate: ExpansionCandidateInput): number {
  const nearestOwnedDistance = candidate.nearestOwnedRoomDistance;
  const routeDistance = candidate.routeDistance;
  if (nearestOwnedDistance === null || routeDistance === null) {
    return -500;
  }

  const supportDistance = typeof nearestOwnedDistance === 'number' ? nearestOwnedDistance : routeDistance;
  const supportScore = typeof supportDistance === 'number' ? 140 - supportDistance * 35 : 0;
  const homePenalty = typeof routeDistance === 'number' ? routeDistance * 10 : 0;
  return Math.max(-160, supportScore - homePenalty);
}

function getReservationScore(
  input: ExpansionScoringInput,
  controller: ExpansionControllerEvidence | undefined
): number {
  if (!controller?.reservationUsername) {
    return 45;
  }

  if (controller.reservationUsername === input.colonyOwnerUsername) {
    return 90;
  }

  const ticksToEnd = controller.reservationTicksToEnd ?? 5_000;
  return ticksToEnd <= 1_000 ? -80 : -180;
}

function getControllerStatus(
  input: ExpansionScoringInput,
  controller: ExpansionControllerEvidence
): { rationale: string; risk?: string; unavailable?: boolean } {
  if (
    controller.my === true ||
    (controller.ownerUsername !== undefined && controller.ownerUsername === input.colonyOwnerUsername)
  ) {
    return {
      rationale: 'controller already owned by colony account',
      unavailable: true
    };
  }

  if (controller.ownerUsername) {
    return {
      rationale: 'controller owned by another account',
      risk: 'enemy-owned controller cannot be claimed safely',
      unavailable: true
    };
  }

  if (!controller.reservationUsername) {
    return { rationale: 'controller unreserved' };
  }

  if (controller.reservationUsername === input.colonyOwnerUsername) {
    return {
      rationale: 'controller already reserved by colony account'
    };
  }

  return {
    rationale: 'controller reserved by another account',
    risk: FOREIGN_RESERVATION_CONTROLLER_PRESSURE_RISK
  };
}

function getReservationEvidence(
  input: ExpansionScoringInput,
  controller: ExpansionControllerEvidence | undefined
): ExpansionReservationEvidence | null {
  if (!controller?.reservationUsername) {
    return null;
  }

  return {
    username: controller.reservationUsername,
    relation: controller.reservationUsername === input.colonyOwnerUsername ? 'own' : 'foreign',
    ...(typeof controller.reservationTicksToEnd === 'number'
      ? { ticksToEnd: controller.reservationTicksToEnd }
      : {})
  };
}

function getExpansionPreconditions(input: ExpansionScoringInput): string[] {
  const preconditions: string[] = [];
  if (input.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    preconditions.push('reach 650 energy capacity for claim body');
  }

  if ((input.controllerLevel ?? 0) < MIN_CONTROLLER_LEVEL) {
    preconditions.push('reach controller level 2 before expansion');
  }

  const ownedRoomCount = getOwnedRoomCount(input);
  const maxRoomCount = maxRoomsForRcl(input.controllerLevel);
  if (ownedRoomCount >= maxRoomCount) {
    preconditions.push(`limit expansion to ${maxRoomCount} owned rooms for current controller level`);
  }

  if (typeof input.ticksToDowngrade === 'number' && input.ticksToDowngrade <= DOWNGRADE_GUARD_TICKS) {
    preconditions.push('stabilize home controller downgrade timer');
  }

  if ((input.activePostClaimBootstrapCount ?? 0) > 0) {
    preconditions.push('finish active post-claim bootstrap before next expansion');
  }

  return preconditions;
}

function getOwnedRoomCount(input: ExpansionScoringInput): number {
  if (typeof input.ownedRoomCount !== 'number' || !Number.isFinite(input.ownedRoomCount)) {
    return 1;
  }

  return Math.max(0, Math.floor(input.ownedRoomCount));
}

function selectPersistableExpansionCandidate(report: ExpansionCandidateReport): ExpansionCandidateScore | null {
  return (
    report.candidates.find(
      (candidate) => candidate.evidenceStatus === 'sufficient' && candidate.preconditions.length === 0
    ) ?? null
  );
}

function getSelectionSkipReason(report: ExpansionCandidateReport): NextExpansionTargetSelectionReason {
  if (report.candidates.length === 0) {
    return 'noCandidate';
  }

  if (report.candidates.every(isBlockedOnlyByRoomLimit)) {
    return 'roomLimitReached';
  }

  if (report.candidates.some((candidate) => candidate.preconditions.length > 0)) {
    return 'unmetPreconditions';
  }

  if (report.candidates.some((candidate) => candidate.evidenceStatus === 'insufficient-evidence')) {
    return 'insufficientEvidence';
  }

  return 'unavailable';
}

function isBlockedOnlyByRoomLimit(candidate: ExpansionCandidateScore): boolean {
  return (
    candidate.preconditions.length === 1 &&
    candidate.preconditions[0].startsWith(ROOM_LIMIT_PRECONDITION_PREFIX)
  );
}

function persistNextExpansionTarget(
  colony: string,
  candidate: ExpansionCandidateScore,
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
    createdBy: NEXT_EXPANSION_TARGET_CREATOR,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
  pruneNextExpansionTargets(colony, target, territoryMemory);
  upsertNextExpansionTarget(territoryMemory, target);

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find(
    (intent) => intent.colony === colony && intent.targetRoom === target.roomName && intent.action === 'claim'
  );
  const createdBy = existingIntent ? existingIntent.createdBy : NEXT_EXPANSION_TARGET_CREATOR;
  const requiresControllerPressure = shouldPersistExpansionCandidateControllerPressure(candidate);
  upsertTerritoryIntent(intents, {
    colony,
    targetRoom: target.roomName,
    action: 'claim',
    status: existingIntent?.status === 'active' ? 'active' : 'planned',
    updatedAt: gameTime,
    ...(createdBy ? { createdBy } : {}),
    ...(target.controllerId ? { controllerId: target.controllerId } : {}),
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {})
  });
}

function shouldPersistExpansionCandidateControllerPressure(candidate: ExpansionCandidateScore): boolean {
  return (
    candidate.requiresControllerPressure === true ||
    candidate.risks.includes(FOREIGN_RESERVATION_CONTROLLER_PRESSURE_RISK)
  );
}

function upsertNextExpansionTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingTarget = territoryMemory.targets.find((rawTarget) => isSameTarget(rawTarget, target));
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }

  if (isRecord(existingTarget) && existingTarget.createdBy === NEXT_EXPANSION_TARGET_CREATOR) {
    existingTarget.createdBy = NEXT_EXPANSION_TARGET_CREATOR;
    existingTarget.enabled = target.enabled;
    if (target.controllerId) {
      existingTarget.controllerId = target.controllerId;
    }
  }
}

function upsertTerritoryIntent(intents: TerritoryIntentMemory[], nextIntent: TerritoryIntentMemory): void {
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

function pruneNextExpansionTargets(
  colony: string,
  activeTarget?: TerritoryTargetMemory,
  territoryMemory = getTerritoryMemoryRecord()
): void {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return;
  }

  const removedTargetKeys = new Set<string>();
  territoryMemory.targets = territoryMemory.targets.filter((target) => {
    if (!isNextExpansionTarget(target, colony)) {
      return true;
    }

    if (activeTarget && isSameTarget(target, activeTarget)) {
      return true;
    }

    if (isRecord(target) && isNonEmptyString(target.roomName) && target.action === 'claim') {
      removedTargetKeys.add(getTargetKey(target.roomName, 'claim'));
    }
    return false;
  });

  if (removedTargetKeys.size === 0) {
    return;
  }

  territoryMemory.intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) =>
      intent.colony !== colony ||
      intent.createdBy !== NEXT_EXPANSION_TARGET_CREATOR ||
      !removedTargetKeys.has(getTargetKey(intent.targetRoom, intent.action))
  );
}

function isNextExpansionTarget(target: unknown, colony: string): boolean {
  return (
    isRecord(target) &&
    target.colony === colony &&
    target.action === 'claim' &&
    target.createdBy === NEXT_EXPANSION_TARGET_CREATOR
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

function getTargetKey(roomName: string, action: TerritoryIntentAction): string {
  return `${roomName}:${action}`;
}

function compareExpansionCandidates(left: ExpansionCandidateScore, right: ExpansionCandidateScore): number {
  return (
    getEvidenceStatusPriority(left.evidenceStatus) - getEvidenceStatusPriority(right.evidenceStatus) ||
    right.score - left.score ||
    compareOptionalNumbers(left.nearestOwnedRoomDistance, right.nearestOwnedRoomDistance) ||
    compareOptionalNumbers(left.routeDistance, right.routeDistance) ||
    left.roomName.localeCompare(right.roomName)
  );
}

function getEvidenceStatusPriority(status: ExpansionCandidateEvidenceStatus): number {
  if (status === 'sufficient') {
    return 0;
  }

  return status === 'insufficient-evidence' ? 1 : 2;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function downgradeEvidenceStatus(
  current: ExpansionCandidateEvidenceStatus,
  downgrade: ExpansionCandidateEvidenceStatus
): ExpansionCandidateEvidenceStatus {
  if (current === 'unavailable' || downgrade === 'unavailable') {
    return 'unavailable';
  }

  return current === 'insufficient-evidence' || downgrade === 'insufficient-evidence'
    ? 'insufficient-evidence'
    : 'sufficient';
}

function attachExpansionCandidateReportColony(
  report: ExpansionCandidateReport,
  colonyName: string
): ExpansionCandidateReport {
  Object.defineProperty(report, 'colonyName', {
    value: colonyName,
    enumerable: false
  });
  return report;
}

function getVisibleOwnedRoomNames(colonyName: string, ownerUsername: string | undefined): Set<string> {
  const ownedRoomNames = new Set<string>([colonyName]);
  const rooms = getGameRooms();
  if (!rooms) {
    return ownedRoomNames;
  }

  for (const room of Object.values(rooms)) {
    if (
      room?.controller?.my === true &&
      isNonEmptyString(room.name) &&
      (!ownerUsername || getControllerOwnerUsername(room.controller) === ownerUsername)
    ) {
      ownedRoomNames.add(room.name);
    }
  }

  return ownedRoomNames;
}

function countVisibleOwnedRooms(colonyName: string, ownerUsername: string | undefined): number {
  return getVisibleOwnedRoomNames(colonyName, ownerUsername).size;
}

function getAdjacentRoomNamesByOwnedRoom(ownedRoomNames: Set<string>): Map<string, Set<string>> {
  const adjacentRoomNames = new Map<string, Set<string>>();
  for (const roomName of ownedRoomNames) {
    adjacentRoomNames.set(roomName, new Set(getAdjacentRoomNames(roomName)));
  }

  return adjacentRoomNames;
}

function isAdjacentToOwnedRoom(roomName: string, adjacentRoomNames: Map<string, Set<string>>): boolean {
  for (const exits of adjacentRoomNames.values()) {
    if (exits.has(roomName)) {
      return true;
    }
  }

  return false;
}

function getNearestOwnedRoomDistance(
  ownedRoomNames: Set<string>,
  targetRoom: string,
  adjacentRoomNames: Map<string, Set<string>>
): { roomName?: string; distance?: number | null } {
  let nearestRoomName: string | undefined;
  let nearestDistance: number | null | undefined;
  for (const ownedRoomName of ownedRoomNames) {
    const adjacentDistance = adjacentRoomNames.get(ownedRoomName)?.has(targetRoom) ? 1 : undefined;
    const routeDistance = getKnownRouteLength(ownedRoomName, targetRoom);
    const distance = routeDistance ?? adjacentDistance;
    if (distance === undefined) {
      continue;
    }

    if (distance === null) {
      if (nearestDistance === undefined) {
        nearestRoomName = ownedRoomName;
        nearestDistance = null;
      }
      continue;
    }

    if (nearestDistance === undefined || nearestDistance === null || distance < nearestDistance) {
      nearestRoomName = ownedRoomName;
      nearestDistance = distance;
    }
  }

  return {
    ...(nearestRoomName ? { roomName: nearestRoomName } : {}),
    ...(nearestDistance !== undefined ? { distance: nearestDistance } : {})
  };
}

function isNearbyExpansionCandidate(
  routeDistance: number | null | undefined,
  nearestOwnedDistance: { distance?: number | null },
  adjacentToOwnedRoom: boolean
): boolean {
  if (routeDistance === null || nearestOwnedDistance.distance === null) {
    return true;
  }

  return (
    adjacentToOwnedRoom ||
    (typeof routeDistance === 'number' && routeDistance <= MAX_NEARBY_EXPANSION_ROUTE_DISTANCE) ||
    (typeof nearestOwnedDistance.distance === 'number' &&
      nearestOwnedDistance.distance <= MAX_NEARBY_EXPANSION_ROUTE_DISTANCE)
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

function getKnownRouteLength(fromRoom: string, targetRoom: string): number | null | undefined {
  if (fromRoom === targetRoom) {
    return 0;
  }

  const cache = getTerritoryRouteDistanceCache();
  const cacheKey = getTerritoryRouteDistanceCacheKey(fromRoom, targetRoom);
  const cachedRouteLength = cache?.[cacheKey];
  if (cachedRouteLength === null || typeof cachedRouteLength === 'number') {
    return cachedRouteLength;
  }

  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & { findRoute?: (fromRoom: string, toRoom: string) => unknown })
    | undefined;
  if (typeof gameMap?.findRoute !== 'function') {
    return undefined;
  }

  const route = gameMap.findRoute(fromRoom, targetRoom);
  if (route === getNoPathResultCode()) {
    if (cache) {
      cache[cacheKey] = null;
    }
    return null;
  }

  if (!Array.isArray(route)) {
    return undefined;
  }

  if (cache) {
    cache[cacheKey] = route.length;
  }
  return route.length;
}

function getTerritoryRouteDistanceCache(): TerritoryMemory['routeDistances'] | undefined {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return undefined;
  }

  if (!isRecord(territoryMemory.routeDistances)) {
    territoryMemory.routeDistances = {};
  }

  return territoryMemory.routeDistances;
}

function getTerritoryRouteDistanceCacheKey(fromRoom: string, targetRoom: string): string {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`;
}

function getNoPathResultCode(): ScreepsReturnCode {
  const noPathCode = (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  return typeof noPathCode === 'number' ? noPathCode : ERR_NO_PATH_CODE;
}

function summarizeExpansionController(controller: StructureController): ExpansionControllerEvidence {
  const ownerUsername = getControllerOwnerUsername(controller);
  const reservationUsername = getControllerReservationUsername(controller);
  const reservationTicksToEnd = getControllerReservationTicksToEnd(controller);

  return {
    ...(controller.my === true ? { my: true } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    ...(typeof reservationTicksToEnd === 'number' ? { reservationTicksToEnd } : {})
  };
}

function calculateAverageControllerSourceRange(
  controller: StructureController | undefined,
  sources: Source[]
): number | undefined {
  if (!controller?.pos || sources.length === 0) {
    return undefined;
  }

  const ranges = sources.flatMap((source) =>
    source.pos ? [getRoomPositionRange(controller.pos, source.pos)] : []
  );
  if (ranges.length === 0) {
    return undefined;
  }

  return Math.round(ranges.reduce((total, range) => total + range, 0) / ranges.length);
}

function getRoomPositionRange(left: RoomPosition, right: RoomPosition): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function summarizeRoomTerrain(room: Room): ExpansionTerrainQuality | null {
  const terrain = getRoomTerrain(room);
  if (!terrain || typeof terrain.get !== 'function') {
    return null;
  }

  let plainCount = 0;
  let swampCount = 0;
  let wallCount = 0;
  const wallMask = getTerrainMask('TERRAIN_MASK_WALL', DEFAULT_TERRAIN_WALL_MASK);
  const swampMask = getTerrainMask('TERRAIN_MASK_SWAMP', DEFAULT_TERRAIN_SWAMP_MASK);
  for (let x = TERRAIN_SCAN_MIN; x <= TERRAIN_SCAN_MAX; x += 1) {
    for (let y = TERRAIN_SCAN_MIN; y <= TERRAIN_SCAN_MAX; y += 1) {
      const mask = terrain.get(x, y);
      if ((mask & wallMask) !== 0) {
        wallCount += 1;
      } else if ((mask & swampMask) !== 0) {
        swampCount += 1;
      } else {
        plainCount += 1;
      }
    }
  }

  const total = plainCount + swampCount + wallCount;
  if (total <= 0) {
    return null;
  }

  return {
    walkableRatio: roundRatio(plainCount + swampCount, total),
    swampRatio: roundRatio(swampCount, total),
    wallRatio: roundRatio(wallCount, total)
  };
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const roomWithTerrain = room as Room & { getTerrain?: () => RoomTerrain };
  if (typeof roomWithTerrain.getTerrain === 'function') {
    return roomWithTerrain.getTerrain();
  }

  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & { getRoomTerrain?: (roomName: string) => RoomTerrain })
    | undefined;
  return typeof gameMap?.getRoomTerrain === 'function' ? gameMap.getRoomTerrain(room.name) : null;
}

function getTerrainMask(name: 'TERRAIN_MASK_WALL' | 'TERRAIN_MASK_SWAMP', fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : fallback;
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

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = controller?.owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationUsername(controller: StructureController): string | undefined {
  const username = (controller as StructureController & { reservation?: { username?: string } }).reservation?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationTicksToEnd(controller: StructureController): number | undefined {
  const ticksToEnd = (controller as StructureController & { reservation?: { ticksToEnd?: number } }).reservation
    ?.ticksToEnd;
  return typeof ticksToEnd === 'number' ? ticksToEnd : undefined;
}

function countActivePostClaimBootstraps(): number {
  const records = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.postClaimBootstraps;
  if (!isRecord(records)) {
    return 0;
  }

  return Object.values(records).filter(
    (record) => isRecord(record) && record.status !== 'ready'
  ).length;
}

function getGameRooms(): Game['rooms'] | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms;
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

function roundRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 1_000 : 0;
}

function toPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
