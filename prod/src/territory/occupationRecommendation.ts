import type { ColonySnapshot } from '../colony/colonyRegistry';

export type OccupationRecommendationAction = 'occupy' | 'reserve' | 'scout';
export type OccupationRecommendationEvidenceStatus = 'sufficient' | 'insufficient-evidence' | 'unavailable';
export type OccupationRecommendationCandidateSource = 'configured' | 'adjacent';

export interface OccupationRecommendationReport {
  candidates: OccupationRecommendationScore[];
  next: OccupationRecommendationScore | null;
  followUpIntent: OccupationRecommendationFollowUpIntent | null;
}

export interface OccupationRecommendationScore {
  roomName: string;
  action: OccupationRecommendationAction;
  score: number;
  evidenceStatus: OccupationRecommendationEvidenceStatus;
  source: OccupationRecommendationCandidateSource;
  evidence: string[];
  preconditions: string[];
  risks: string[];
  routeDistance?: number;
  controllerId?: Id<StructureController>;
  requiresControllerPressure?: boolean;
  sourceCount?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
}

export interface OccupationRecommendationFollowUpIntent {
  colony: string;
  targetRoom: string;
  action: TerritoryIntentAction;
  controllerId?: Id<StructureController>;
  requiresControllerPressure?: boolean;
  followUp?: TerritoryFollowUpMemory;
}

export interface OccupationRecommendationInput {
  colonyName: string;
  colonyOwnerUsername?: string;
  energyCapacityAvailable: number;
  workerCount: number;
  controllerLevel?: number;
  ticksToDowngrade?: number;
  candidates: OccupationRecommendationCandidateInput[];
}

export interface OccupationRecommendationCandidateInput {
  roomName: string;
  source: OccupationRecommendationCandidateSource;
  order: number;
  adjacent: boolean;
  visible: boolean;
  actionHint?: TerritoryControlAction;
  controllerId?: Id<StructureController>;
  routeDistance?: number | null;
  controller?: OccupationControllerEvidence;
  sourceCount?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  constructionSiteCount?: number;
  ownedStructureCount?: number;
}

export interface OccupationControllerEvidence {
  my?: boolean;
  ownerUsername?: string;
  reservationUsername?: string;
  reservationTicksToEnd?: number;
}

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;
const TERRITORY_BODY_ENERGY_CAPACITY = 650;
const MIN_READY_WORKERS = 3;
const DOWNGRADE_GUARD_TICKS = 5_000;
const RESERVATION_RENEWAL_TICKS = 1_000;
const TERRITORY_SUPPRESSION_RETRY_TICKS = 1_500;
const TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS = 50;
const TERRITORY_ROUTE_DISTANCE_SEPARATOR = '>';

// Project vision ordering: territory action dominates resource value; combat/risk only gates or deprioritizes.
const ACTION_SCORE: Record<OccupationRecommendationAction, number> = {
  occupy: 1_000,
  reserve: 800,
  scout: 420
};

export function buildRuntimeOccupationRecommendationReport(
  colony: ColonySnapshot,
  colonyWorkers: Creep[]
): OccupationRecommendationReport {
  return scoreOccupationRecommendations(buildRuntimeOccupationRecommendationInput(colony, colonyWorkers));
}

export function scoreOccupationRecommendations(
  input: OccupationRecommendationInput
): OccupationRecommendationReport {
  const candidates = input.candidates
    .filter((candidate) => candidate.roomName !== input.colonyName)
    .map((candidate) => scoreOccupationCandidate(input, candidate))
    .sort(compareOccupationRecommendationScores);
  const next = candidates.find((candidate) => candidate.evidenceStatus !== 'unavailable') ?? null;

  return { candidates, next, followUpIntent: buildOccupationRecommendationFollowUpIntent(input, next) };
}

export function persistOccupationRecommendationFollowUpIntent(
  report: OccupationRecommendationReport,
  gameTime = getGameTime()
): TerritoryIntentMemory | null {
  const followUpIntent = report.followUpIntent;
  if (!followUpIntent) {
    return null;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find((intent) => isSameTerritoryIntent(intent, followUpIntent));
  if (
    existingIntent &&
    (isTerritorySuppressionFresh(existingIntent, gameTime) ||
      isRecoveredTerritoryFollowUpAttemptCoolingDown(existingIntent, gameTime) ||
      isRecoveredTerritoryFollowUpRetryPending(existingIntent))
  ) {
    return null;
  }

  const controllerId = followUpIntent.controllerId ?? existingIntent?.controllerId;
  const requiresControllerPressure =
    followUpIntent.requiresControllerPressure === true ||
    (existingIntent
      ? shouldPreservePersistedTerritoryIntentPressureRequirement(existingIntent, controllerId)
      : false);
  const followUp = normalizeTerritoryFollowUp(followUpIntent.followUp) ?? existingIntent?.followUp;
  const nextIntent: TerritoryIntentMemory = {
    colony: followUpIntent.colony,
    targetRoom: followUpIntent.targetRoom,
    action: followUpIntent.action,
    status: existingIntent?.status === 'active' ? 'active' : 'planned',
    updatedAt: gameTime,
    ...(controllerId ? { controllerId } : {}),
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(followUp ? { followUp } : {})
  };

  upsertTerritoryIntent(intents, nextIntent);
  return nextIntent;
}

function buildRuntimeOccupationRecommendationInput(
  colony: ColonySnapshot,
  colonyWorkers: Creep[]
): OccupationRecommendationInput {
  const colonyName = colony.room.name;
  return {
    colonyName,
    colonyOwnerUsername: getControllerOwnerUsername(colony.room.controller),
    energyCapacityAvailable: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    ...(typeof colony.room.controller?.level === 'number' ? { controllerLevel: colony.room.controller.level } : {}),
    ...(typeof colony.room.controller?.ticksToDowngrade === 'number'
      ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade }
      : {}),
    candidates: buildRuntimeOccupationCandidates(colonyName)
  };
}

function buildRuntimeOccupationCandidates(colonyName: string): OccupationRecommendationCandidateInput[] {
  const candidatesByRoom = new Map<string, OccupationRecommendationCandidateInput>();
  const territoryMemory = getTerritoryMemoryRecord();
  let order = 0;

  if (Array.isArray(territoryMemory?.targets)) {
    for (const rawTarget of territoryMemory.targets) {
      const target = normalizeTerritoryTarget(rawTarget);
      if (!target || target.colony !== colonyName || target.enabled === false) {
        continue;
      }

      upsertOccupationCandidate(candidatesByRoom, {
        roomName: target.roomName,
        source: 'configured',
        order,
        adjacent: false,
        visible: false,
        actionHint: target.action,
        ...(target.controllerId ? { controllerId: target.controllerId } : {}),
        routeDistance: getCachedRouteDistance(colonyName, target.roomName)
      });
      order += 1;
    }
  }

  for (const roomName of getAdjacentRoomNames(colonyName)) {
    const cachedRouteDistance = getCachedRouteDistance(colonyName, roomName);
    upsertOccupationCandidate(candidatesByRoom, {
      roomName,
      source: 'adjacent',
      order,
      adjacent: true,
      visible: false,
      routeDistance: cachedRouteDistance === undefined ? 1 : cachedRouteDistance
    });
    order += 1;
  }

  return Array.from(candidatesByRoom.values()).map(enrichVisibleOccupationCandidate);
}

function upsertOccupationCandidate(
  candidatesByRoom: Map<string, OccupationRecommendationCandidateInput>,
  candidate: OccupationRecommendationCandidateInput
): void {
  const existing = candidatesByRoom.get(candidate.roomName);
  if (!existing) {
    candidatesByRoom.set(candidate.roomName, candidate);
    return;
  }

  if (candidate.source === 'configured' && existing.source !== 'configured') {
    existing.source = 'configured';
    existing.actionHint = candidate.actionHint;
    if (candidate.controllerId) {
      existing.controllerId = candidate.controllerId;
    }
    existing.order = Math.min(existing.order, candidate.order);
  }

  existing.adjacent = existing.adjacent || candidate.adjacent;
  if (!existing.controllerId && candidate.controllerId) {
    existing.controllerId = candidate.controllerId;
  }
  if (existing.routeDistance === undefined && candidate.routeDistance !== undefined) {
    existing.routeDistance = candidate.routeDistance;
  }
}

function enrichVisibleOccupationCandidate(
  candidate: OccupationRecommendationCandidateInput
): OccupationRecommendationCandidateInput {
  const room = getGameRooms()?.[candidate.roomName];
  if (!room) {
    return candidate;
  }

  const hostileCreeps = findRoomObjects(room, 'FIND_HOSTILE_CREEPS');
  const hostileStructures = findRoomObjects(room, 'FIND_HOSTILE_STRUCTURES');
  const sources = findRoomObjects(room, 'FIND_SOURCES');
  const constructionSites = findRoomObjects(room, 'FIND_MY_CONSTRUCTION_SITES');
  const ownedStructures = findRoomObjects(room, 'FIND_MY_STRUCTURES');

  return {
    ...candidate,
    visible: true,
    ...(room.controller ? { controller: summarizeController(room.controller) } : {}),
    ...(sources ? { sourceCount: sources.length } : {}),
    ...(hostileCreeps ? { hostileCreepCount: hostileCreeps.length } : {}),
    ...(hostileStructures ? { hostileStructureCount: hostileStructures.length } : {}),
    ...(constructionSites ? { constructionSiteCount: constructionSites.length } : {}),
    ...(ownedStructures ? { ownedStructureCount: ownedStructures.length } : {})
  };
}

function scoreOccupationCandidate(
  input: OccupationRecommendationInput,
  candidate: OccupationRecommendationCandidateInput
): OccupationRecommendationScore {
  const evidence: string[] = [];
  const preconditions = getColonyReadinessPreconditions(input);
  const risks: string[] = [];
  const routeDistance = typeof candidate.routeDistance === 'number' ? candidate.routeDistance : undefined;
  let action: OccupationRecommendationAction = 'scout';
  let evidenceStatus: OccupationRecommendationEvidenceStatus = 'sufficient';
  let requiresControllerPressure = false;

  if (candidate.routeDistance === null) {
    risks.push('no known route from colony');
    evidenceStatus = 'unavailable';
  } else if (!candidate.visible) {
    evidence.push('room visibility missing');
    risks.push('controller, source, and hostile evidence unavailable');
    evidenceStatus = 'insufficient-evidence';
  } else if (!candidate.controller) {
    evidence.push('room visible');
    risks.push('visible room has no controller');
    evidenceStatus = 'unavailable';
  } else {
    evidence.push('room visible', 'controller visible');
    const controllerPressureEvidence = getControllerPressureEvidence(input, candidate);
    const unavailableReason = getControllerUnavailableReason(input, candidate);
    if (controllerPressureEvidence) {
      evidence.push(controllerPressureEvidence);
      action = 'reserve';
      requiresControllerPressure = true;
      if (candidate.sourceCount === undefined) {
        risks.push('source count evidence missing');
        evidenceStatus = 'insufficient-evidence';
      } else {
        evidence.push(`${candidate.sourceCount} sources visible`);
      }
    } else if (unavailableReason) {
      risks.push(unavailableReason);
      evidenceStatus = 'unavailable';
      action = candidate.actionHint === 'claim' ? 'occupy' : 'reserve';
    } else if (isOwnHealthyReservation(input, candidate.controller)) {
      evidence.push('own reservation is healthy');
      evidenceStatus = 'unavailable';
      action = 'reserve';
    } else if (isOwnReservationDueForRenewal(input, candidate.controller)) {
      evidence.push('own reservation needs renewal');
      action = 'reserve';
    } else if (candidate.sourceCount === undefined) {
      evidence.push('controller is available');
      risks.push('source count evidence missing');
      evidenceStatus = 'insufficient-evidence';
    } else {
      evidence.push('controller is available', `${candidate.sourceCount} sources visible`);
      action = candidate.actionHint === 'claim' ? 'occupy' : 'reserve';
    }
  }

  const hostileCreepCount = candidate.hostileCreepCount ?? 0;
  const hostileStructureCount = candidate.hostileStructureCount ?? 0;
  if (hostileCreepCount > 0 || hostileStructureCount > 0) {
    risks.push('hostile presence visible');
    evidenceStatus = 'unavailable';
  }

  const score = calculateOccupationScore(input, candidate, action, evidenceStatus);
  return {
    roomName: candidate.roomName,
    action,
    score,
    evidenceStatus,
    source: candidate.source,
    evidence,
    preconditions,
    risks,
    ...(routeDistance !== undefined ? { routeDistance } : {}),
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {}),
    ...(requiresControllerPressure ? { requiresControllerPressure: true } : {}),
    ...(candidate.sourceCount !== undefined ? { sourceCount: candidate.sourceCount } : {}),
    ...(candidate.hostileCreepCount !== undefined ? { hostileCreepCount: candidate.hostileCreepCount } : {}),
    ...(candidate.hostileStructureCount !== undefined ? { hostileStructureCount: candidate.hostileStructureCount } : {})
  };
}

function buildOccupationRecommendationFollowUpIntent(
  input: OccupationRecommendationInput,
  next: OccupationRecommendationScore | null
): OccupationRecommendationFollowUpIntent | null {
  if (!next) {
    return null;
  }

  return {
    colony: input.colonyName,
    targetRoom: next.roomName,
    action: getTerritoryIntentAction(next.action),
    ...(next.controllerId ? { controllerId: next.controllerId } : {}),
    ...(next.requiresControllerPressure ? { requiresControllerPressure: true } : {})
  };
}

function getTerritoryIntentAction(action: OccupationRecommendationAction): TerritoryIntentAction {
  return action === 'occupy' ? 'claim' : action;
}

function calculateOccupationScore(
  input: OccupationRecommendationInput,
  candidate: OccupationRecommendationCandidateInput,
  action: OccupationRecommendationAction,
  evidenceStatus: OccupationRecommendationEvidenceStatus
): number {
  const distanceScore =
    typeof candidate.routeDistance === 'number' ? Math.max(0, 80 - candidate.routeDistance * 15) : 0;
  const sourceScore = typeof candidate.sourceCount === 'number' ? Math.min(candidate.sourceCount, 2) * 70 : 0;
  const supportScore =
    Math.min(candidate.ownedStructureCount ?? 0, 3) * 8 +
    Math.min(candidate.constructionSiteCount ?? 0, 3) * 5;
  const sourcePriorityScore = candidate.source === 'configured' ? 50 : 25;
  const adjacencyScore = candidate.adjacent ? 25 : 0;
  const readinessScore =
    Math.min(input.workerCount, MIN_READY_WORKERS) * 12 +
    (input.energyCapacityAvailable >= TERRITORY_BODY_ENERGY_CAPACITY ? 30 : 0) +
    ((input.controllerLevel ?? 0) >= 2 ? 30 : 0) +
    (input.ticksToDowngrade === undefined || input.ticksToDowngrade > DOWNGRADE_GUARD_TICKS ? 20 : 0);
  const riskPenalty = (candidate.hostileCreepCount ?? 0) * 160 + (candidate.hostileStructureCount ?? 0) * 120;
  const controllerPressurePenalty =
    candidate.controller && isForeignReservation(input, candidate.controller) ? 180 : 0;
  const evidencePenalty = evidenceStatus === 'insufficient-evidence' ? 260 : 0;
  const unavailablePenalty = evidenceStatus === 'unavailable' ? 2_000 : 0;

  return (
    ACTION_SCORE[action] +
    sourcePriorityScore +
    adjacencyScore +
    distanceScore +
    sourceScore +
    supportScore +
    readinessScore -
    riskPenalty -
    controllerPressurePenalty -
    evidencePenalty -
    unavailablePenalty
  );
}

function getControllerPressureEvidence(
  input: OccupationRecommendationInput,
  candidate: OccupationRecommendationCandidateInput
): string | null {
  if (
    candidate.source !== 'configured' ||
    candidate.actionHint !== 'reserve' ||
    !candidate.controller ||
    !isForeignReservation(input, candidate.controller)
  ) {
    return null;
  }

  return 'foreign reservation can be pressured';
}

function getColonyReadinessPreconditions(input: OccupationRecommendationInput): string[] {
  const preconditions: string[] = [];
  if (input.workerCount < MIN_READY_WORKERS) {
    preconditions.push('raise worker count before dispatching territory creeps');
  }

  if (input.energyCapacityAvailable < TERRITORY_BODY_ENERGY_CAPACITY) {
    preconditions.push('reach 650 energy capacity for controller work');
  }

  if ((input.controllerLevel ?? 0) < 2) {
    preconditions.push('reach controller level 2 before expansion');
  }

  if (typeof input.ticksToDowngrade === 'number' && input.ticksToDowngrade <= DOWNGRADE_GUARD_TICKS) {
    preconditions.push('stabilize home controller downgrade timer');
  }

  return preconditions;
}

function getControllerUnavailableReason(
  input: OccupationRecommendationInput,
  candidate: OccupationRecommendationCandidateInput
): string | null {
  const controller = candidate.controller;
  if (!controller) {
    return null;
  }

  if (isControllerOwnedByColony(input, controller)) {
    return 'controller already owned by colony account';
  }

  if (controller.ownerUsername) {
    return 'controller owned by another account';
  }

  if (
    candidate.actionHint !== 'claim' &&
    controller.reservationUsername &&
    controller.reservationUsername !== input.colonyOwnerUsername
  ) {
    return 'controller reserved by another account';
  }

  return null;
}

function isOwnHealthyReservation(
  input: OccupationRecommendationInput,
  controller: OccupationControllerEvidence
): boolean {
  return (
    isOwnReservation(input, controller) &&
    typeof controller.reservationTicksToEnd === 'number' &&
    controller.reservationTicksToEnd > RESERVATION_RENEWAL_TICKS
  );
}

function isOwnReservationDueForRenewal(
  input: OccupationRecommendationInput,
  controller: OccupationControllerEvidence
): boolean {
  return (
    isOwnReservation(input, controller) &&
    typeof controller.reservationTicksToEnd === 'number' &&
    controller.reservationTicksToEnd <= RESERVATION_RENEWAL_TICKS
  );
}

function isOwnReservation(input: OccupationRecommendationInput, controller: OccupationControllerEvidence): boolean {
  return (
    input.colonyOwnerUsername !== undefined &&
    controller.reservationUsername === input.colonyOwnerUsername
  );
}

function isForeignReservation(
  input: OccupationRecommendationInput,
  controller: OccupationControllerEvidence
): boolean {
  return (
    input.colonyOwnerUsername !== undefined &&
    controller.my !== true &&
    controller.ownerUsername === undefined &&
    controller.reservationUsername !== undefined &&
    controller.reservationUsername !== input.colonyOwnerUsername
  );
}

function isControllerOwnedByColony(
  input: OccupationRecommendationInput,
  controller: OccupationControllerEvidence
): boolean {
  return (
    controller.my === true ||
    (!!controller.ownerUsername && controller.ownerUsername === input.colonyOwnerUsername)
  );
}

function compareOccupationRecommendationScores(
  left: OccupationRecommendationScore,
  right: OccupationRecommendationScore
): number {
  return (
    right.score - left.score ||
    getEvidenceStatusPriority(left.evidenceStatus) - getEvidenceStatusPriority(right.evidenceStatus) ||
    getActionPriority(left.action) - getActionPriority(right.action) ||
    getSourcePriority(left.source) - getSourcePriority(right.source) ||
    compareOptionalNumbers(left.routeDistance, right.routeDistance) ||
    left.roomName.localeCompare(right.roomName)
  );
}

function getEvidenceStatusPriority(status: OccupationRecommendationEvidenceStatus): number {
  if (status === 'sufficient') {
    return 0;
  }

  return status === 'insufficient-evidence' ? 1 : 2;
}

function getActionPriority(action: OccupationRecommendationAction): number {
  if (action === 'occupy') {
    return 0;
  }

  return action === 'reserve' ? 1 : 2;
}

function getSourcePriority(source: OccupationRecommendationCandidateSource): number {
  return source === 'configured' ? 0 : 1;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function summarizeController(controller: StructureController): OccupationControllerEvidence {
  const ownerUsername = getControllerOwnerUsername(controller);
  const reservationUsername = getReservationUsername(controller);
  const reservationTicksToEnd = getReservationTicksToEnd(controller);

  return {
    ...(controller.my === true ? { my: true } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    ...(typeof reservationTicksToEnd === 'number' ? { reservationTicksToEnd } : {})
  };
}

function getAdjacentRoomNames(roomName: string): string[] {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  if (!gameMap || typeof gameMap.describeExits !== 'function') {
    return [];
  }

  const exits = gameMap.describeExits(roomName) as Record<string, string> | null;
  if (!isRecord(exits)) {
    return [];
  }

  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const exitRoom = exits[direction];
    return typeof exitRoom === 'string' && exitRoom.length > 0 ? [exitRoom] : [];
  });
}

function normalizeTerritoryTarget(rawTarget: unknown): TerritoryTargetMemory | null {
  if (!isRecord(rawTarget)) {
    return null;
  }

  if (
    typeof rawTarget.colony !== 'string' ||
    rawTarget.colony.length === 0 ||
    typeof rawTarget.roomName !== 'string' ||
    rawTarget.roomName.length === 0 ||
    (rawTarget.action !== 'claim' && rawTarget.action !== 'reserve')
  ) {
    return null;
  }

  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action: rawTarget.action,
    ...(typeof rawTarget.controllerId === 'string'
      ? { controllerId: rawTarget.controllerId as Id<StructureController> }
      : {}),
    ...(rawTarget.enabled === false ? { enabled: false } : {})
  };
}

function getCachedRouteDistance(fromRoom: string, targetRoom: string): number | null | undefined {
  const routeDistances = getTerritoryMemoryRecord()?.routeDistances;
  if (!isRecord(routeDistances)) {
    return undefined;
  }

  const distance = routeDistances[`${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`];
  return typeof distance === 'number' || distance === null ? distance : undefined;
}

function findRoomObjects(room: Room, constantName: string): unknown[] | undefined {
  const findConstant = getGlobalNumber(constantName);
  const find = (room as unknown as { find?: unknown }).find;
  if (typeof findConstant !== 'number' || typeof find !== 'function') {
    return undefined;
  }

  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return undefined;
  }
}

function getGlobalNumber(name: string): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  return typeof username === 'string' && username.length > 0 ? username : undefined;
}

function getReservationUsername(controller: StructureController): string | undefined {
  const username = (controller as StructureController & { reservation?: { username?: string } }).reservation?.username;
  return typeof username === 'string' && username.length > 0 ? username : undefined;
}

function getReservationTicksToEnd(controller: StructureController): number | undefined {
  const ticksToEnd = (controller as StructureController & { reservation?: { ticksToEnd?: number } }).reservation
    ?.ticksToEnd;
  return typeof ticksToEnd === 'number' ? ticksToEnd : undefined;
}

function getGameRooms(): Game['rooms'] | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function getTerritoryMemoryRecord(): TerritoryMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }

  return memory.territory as TerritoryMemory;
}

function normalizeTerritoryIntents(rawIntents: TerritoryMemory['intents'] | unknown): TerritoryIntentMemory[] {
  return Array.isArray(rawIntents)
    ? rawIntents.flatMap((intent) => {
        const normalizedIntent = normalizeTerritoryIntent(intent);
        return normalizedIntent ? [normalizedIntent] : [];
      })
    : [];
}

function normalizeTerritoryIntent(rawIntent: unknown): TerritoryIntentMemory | null {
  if (!isRecord(rawIntent)) {
    return null;
  }

  if (
    !isNonEmptyString(rawIntent.colony) ||
    !isNonEmptyString(rawIntent.targetRoom) ||
    !isTerritoryIntentAction(rawIntent.action) ||
    !isTerritoryIntentStatus(rawIntent.status) ||
    typeof rawIntent.updatedAt !== 'number'
  ) {
    return null;
  }

  const followUp = normalizeTerritoryFollowUp(rawIntent.followUp);
  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...(followUp && isFiniteNumber(rawIntent.lastAttemptAt) ? { lastAttemptAt: rawIntent.lastAttemptAt } : {}),
    ...(typeof rawIntent.controllerId === 'string'
      ? { controllerId: rawIntent.controllerId as Id<StructureController> }
      : {}),
    ...(rawIntent.requiresControllerPressure === true ? { requiresControllerPressure: true } : {}),
    ...(followUp ? { followUp } : {})
  };
}

function normalizeTerritoryFollowUp(rawFollowUp: unknown): TerritoryFollowUpMemory | null {
  if (!isRecord(rawFollowUp) || !isTerritoryFollowUpSource(rawFollowUp.source)) {
    return null;
  }

  const originAction = getTerritoryFollowUpOriginAction(rawFollowUp.source);
  if (!isNonEmptyString(rawFollowUp.originRoom) || rawFollowUp.originAction !== originAction) {
    return null;
  }

  return {
    source: rawFollowUp.source,
    originRoom: rawFollowUp.originRoom,
    originAction
  };
}

function getTerritoryFollowUpOriginAction(source: TerritoryFollowUpSource): TerritoryControlAction {
  return source === 'satisfiedClaimAdjacent' ? 'claim' : 'reserve';
}

function upsertTerritoryIntent(intents: TerritoryIntentMemory[], nextIntent: TerritoryIntentMemory): void {
  const existingIndex = intents.findIndex((intent) => isSameTerritoryIntent(intent, nextIntent));
  if (existingIndex >= 0) {
    const existingIntent = intents[existingIndex];
    const controllerId = nextIntent.controllerId ?? existingIntent.controllerId;
    const preserveControllerPressure =
      !nextIntent.requiresControllerPressure &&
      shouldPreservePersistedTerritoryIntentPressureRequirement(existingIntent, controllerId);
    intents[existingIndex] = {
      ...nextIntent,
      ...(preserveControllerPressure ? { requiresControllerPressure: true } : {})
    };
    return;
  }

  intents.push(nextIntent);
}

function shouldPreservePersistedTerritoryIntentPressureRequirement(
  intent: TerritoryIntentMemory,
  controllerId: Id<StructureController> | undefined = intent.controllerId
): boolean {
  return (
    intent.requiresControllerPressure === true &&
    isTerritoryControllerPressureVisibilityMissing(intent.targetRoom, intent.action, controllerId)
  );
}

function isTerritoryControllerPressureVisibilityMissing(
  targetRoom: string,
  action: TerritoryIntentAction,
  controllerId?: Id<StructureController>
): boolean {
  return action === 'reserve' && getVisibleController(targetRoom, controllerId) === null;
}

function getVisibleController(targetRoom: string, controllerId?: Id<StructureController>): StructureController | null {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const roomController = game?.rooms?.[targetRoom]?.controller;
  if (roomController) {
    return roomController;
  }

  const getObjectById = game?.getObjectById;
  if (controllerId && typeof getObjectById === 'function') {
    return getObjectById.call(game, controllerId) as StructureController | null;
  }

  return null;
}

function isSameTerritoryIntent(
  intent: Pick<TerritoryIntentMemory, 'colony' | 'targetRoom' | 'action'>,
  followUpIntent: Pick<TerritoryIntentMemory, 'colony' | 'targetRoom' | 'action'>
): boolean {
  return (
    intent.colony === followUpIntent.colony &&
    intent.targetRoom === followUpIntent.targetRoom &&
    intent.action === followUpIntent.action
  );
}

function isTerritorySuppressionFresh(intent: TerritoryIntentMemory, gameTime: number): boolean {
  return intent.status === 'suppressed' && gameTime - intent.updatedAt <= TERRITORY_SUPPRESSION_RETRY_TICKS;
}

function isRecoveredTerritoryFollowUpAttemptCoolingDown(intent: TerritoryIntentMemory, gameTime: number): boolean {
  return (
    intent.followUp !== undefined &&
    isFiniteNumber(intent.lastAttemptAt) &&
    gameTime >= intent.lastAttemptAt &&
    gameTime - intent.lastAttemptAt <= TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS
  );
}

function isRecoveredTerritoryFollowUpRetryPending(intent: TerritoryIntentMemory): boolean {
  return intent.followUp !== undefined && intent.status === 'suppressed' && isFiniteNumber(intent.lastAttemptAt);
}

function isTerritoryIntentAction(action: unknown): action is TerritoryIntentAction {
  return action === 'claim' || action === 'reserve' || action === 'scout';
}

function isTerritoryIntentStatus(status: unknown): status is TerritoryIntentMemory['status'] {
  return status === 'planned' || status === 'active' || status === 'suppressed';
}

function isTerritoryFollowUpSource(source: unknown): source is TerritoryFollowUpSource {
  return (
    source === 'satisfiedClaimAdjacent' ||
    source === 'satisfiedReserveAdjacent' ||
    source === 'activeReserveAdjacent'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
