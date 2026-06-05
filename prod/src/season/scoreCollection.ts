import { getRuntimeFeatureGates } from '../runtime/featureGates';

type ScoreFindConstantGlobal =
  | 'FIND_SCORES'
  | 'FIND_SCORE'
  | 'FIND_SCORE_ITEMS'
  | 'FIND_SCORE_OBJECTS'
  | 'FIND_SEASON_SCORE'
  | 'FIND_SEASON_SCORE_ITEMS';

type SeasonScoreRoomKey =
  | 'score'
  | 'scores'
  | 'scoreItems'
  | 'scoreObjects'
  | 'seasonScore'
  | 'seasonScoreItems';

interface SeasonScoreItem extends RoomObject {
  id: Id<SeasonScoreItem>;
  decayTime?: number;
}

interface SeasonScoreCollectionCandidate {
  blocker?: SeasonScoreAssignedCollector;
  item: SeasonScoreItem;
}

interface SeasonScoreAssignedCollector {
  creepName?: string;
  range: number;
}

export interface SeasonScoreCollectorSpawnDemand {
  homeRoom: string;
  targetRoom: string;
  staleReason?: SeasonScoreCollectorStaleReason;
}

interface SeasonScoreCollectorAssignmentState {
  creep: Creep;
  memory: CreepSeasonScoreCollectorMemory;
  staleReason?: SeasonScoreCollectorStaleReason;
}

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;

export const SCORE_COLLECTOR_ROLE = 'scoreCollector';

const SCORE_FIND_CONSTANT_GLOBALS: ScoreFindConstantGlobal[] = [
  'FIND_SCORES',
  'FIND_SCORE',
  'FIND_SCORE_ITEMS',
  'FIND_SCORE_OBJECTS',
  'FIND_SEASON_SCORE',
  'FIND_SEASON_SCORE_ITEMS'
];
const SCORE_FALLBACK_ROOM_KEYS: SeasonScoreRoomKey[] = [
  'score',
  'scores',
  'scoreItems',
  'scoreObjects',
  'seasonScore',
  'seasonScoreItems'
];
const SCORE_COLLECTION_TRAVEL_BUFFER_TICKS = 1;
const SCORE_COLLECTOR_MAX_CANDIDATE_ROOMS = 16;
const SCORE_COLLECTOR_REPLACEMENT_TICKS_TO_LIVE = 100;
const SCORE_COLLECTOR_STALE_TICKS = 100;
const SCORE_COLLECTOR_ROOM_CENTER = 25;

export function selectSeasonScoreCollectorSpawnDemand(
  colony: { room: Pick<Room, 'name'> },
  gameTime = getGameTime()
): SeasonScoreCollectorSpawnDemand | null {
  const homeRoom = normalizeRoomName(colony.room?.name);
  if (!homeRoom) {
    return null;
  }

  const activeAssignments = selectActiveScoreCollectorAssignments(homeRoom, gameTime);
  if (!getRuntimeFeatureGates().isSeasonal) {
    recordSeasonScoreCollectorsDiagnostic({
      updatedAt: gameTime,
      activeCount: activeAssignments.filter((assignment) => assignment.staleReason === undefined).length,
      candidateRooms: [],
      targetRooms: getEffectiveScoreCollectorTargetRooms(activeAssignments),
      blocker: 'non_seasonal'
    });
    return null;
  }

  const candidateRooms = selectSeasonScoreCollectorCandidateRooms(homeRoom);
  const effectiveTargetRooms = getEffectiveScoreCollectorTargetRooms(activeAssignments);
  if (candidateRooms.length === 0) {
    recordSeasonScoreCollectorsDiagnostic({
      updatedAt: gameTime,
      activeCount: effectiveTargetRooms.length,
      candidateRooms,
      targetRooms: effectiveTargetRooms,
      blocker: 'no_candidate_rooms'
    });
    return null;
  }

  const assignmentsByTarget = groupScoreCollectorAssignmentsByTarget(activeAssignments);
  for (const targetRoom of candidateRooms) {
    const assignment = assignmentsByTarget.get(targetRoom);
    if (!assignment) {
      recordSeasonScoreCollectorsDiagnostic({
        updatedAt: gameTime,
        activeCount: effectiveTargetRooms.length,
        candidateRooms,
        targetRooms: effectiveTargetRooms,
        nextSpawnTargetRoom: targetRoom
      });
      return { homeRoom, targetRoom };
    }

    if (assignment.staleReason) {
      recordSeasonScoreCollectorsDiagnostic({
        updatedAt: gameTime,
        activeCount: effectiveTargetRooms.length,
        candidateRooms,
        targetRooms: effectiveTargetRooms,
        nextSpawnTargetRoom: targetRoom,
        staleTargetRoom: targetRoom,
        staleReason: assignment.staleReason
      });
      return { homeRoom, targetRoom, staleReason: assignment.staleReason };
    }
  }

  recordSeasonScoreCollectorsDiagnostic({
    updatedAt: gameTime,
    activeCount: effectiveTargetRooms.length,
    candidateRooms,
    targetRooms: effectiveTargetRooms,
    blocker: 'all_targets_covered'
  });
  return null;
}

export function buildSeasonScoreCollectorMemory(
  homeRoom: string,
  targetRoom: string,
  gameTime = getGameTime()
): CreepMemory {
  return {
    role: SCORE_COLLECTOR_ROLE,
    colony: homeRoom,
    seasonScoreCollector: {
      homeRoom,
      targetRoom,
      assignedAt: gameTime
    }
  };
}

export function recordSeasonScoreCollectorSpawnBlocker(
  homeRoom: string,
  blocker: SeasonScoreCollectorsDiagnosticsMemory['blocker'],
  gameTime = getGameTime()
): void {
  if (!normalizeRoomName(homeRoom) || !blocker) {
    return;
  }

  const activeAssignments = selectActiveScoreCollectorAssignments(homeRoom, gameTime);
  recordSeasonScoreCollectorsDiagnostic({
    updatedAt: gameTime,
    activeCount: activeAssignments.filter((assignment) => assignment.staleReason === undefined).length,
    candidateRooms: getRuntimeFeatureGates().isSeasonal ? selectSeasonScoreCollectorCandidateRooms(homeRoom) : [],
    targetRooms: getEffectiveScoreCollectorTargetRooms(activeAssignments),
    blocker
  });
}

export function runScoreCollector(creep: Creep): void {
  if (!getRuntimeFeatureGates().isSeasonal) {
    delete creep.memory.task;
    recordScoreCollectorCreepState(creep, {
      state: 'blocked',
      blocker: 'non_seasonal',
      visibleScoreCount: 0
    });
    return;
  }

  const assignment = normalizeScoreCollectorMemory(creep.memory?.seasonScoreCollector, creep.memory?.colony);
  if (!assignment) {
    delete creep.memory.task;
    recordScoreCollectorCreepState(creep, {
      state: 'blocked',
      blocker: 'missing_assignment',
      visibleScoreCount: 0
    });
    return;
  }

  const scoreTask = selectSeasonScoreCollectionTask(creep);
  if (scoreTask) {
    creep.memory.task = scoreTask;
    const scoreTarget = getGameObjectById(scoreTask.targetId);
    if (scoreTarget) {
      const moveResult = moveToScoreTarget(creep, scoreTarget);
      recordScoreCollectorCreepState(creep, {
        ...assignment,
        state: moveResult === getErrNoPathCode() ? 'blocked' : 'collecting',
        visibleScoreCount: getSeasonScoreCollectionVisibleCount(creep),
        assignedScoreTargetId: String(scoreTask.targetId),
        ...(moveResult === getErrNoPathCode() ? { blocker: 'target_unreachable' } : {})
      });
      return;
    }
  }

  if (creep.memory.task?.type === 'collectScore') {
    delete creep.memory.task;
  }

  const moveResult = moveTowardScoreCollectorTargetRoom(creep, assignment.targetRoom);
  const state: SeasonScoreCollectorState =
    moveResult === getErrNoPathCode()
      ? 'blocked'
      : creep.room?.name === assignment.targetRoom
        ? 'holding'
        : 'travelling';
  recordScoreCollectorCreepState(creep, {
    ...assignment,
    state,
    visibleScoreCount: getSeasonScoreCollectionVisibleCount(creep),
    ...(moveResult === getErrNoPathCode() ? { blocker: 'target_unreachable' } : {})
  });
}

export function selectSeasonScoreCollectionTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'collectScore' }> | null {
  if (!getRuntimeFeatureGates().isSeasonal || !isEligibleSeasonScoreCollector(creep)) {
    clearSeasonScoreCollectionDiagnostic(creep);
    return null;
  }

  const scoreItem = selectBestVisibleScoreItem(creep);
  return scoreItem ? { type: 'collectScore', targetId: scoreItem.id } : null;
}

function selectBestVisibleScoreItem(creep: Creep): SeasonScoreItem | null {
  const room = creep.room;
  if (!room) {
    recordSeasonScoreCollectionDiagnostic(creep, {
      tick: getGameTime(),
      state: 'blocked',
      visibleCount: 0,
      blockedReason: 'no_visible_score'
    });
    return null;
  }

  const visibleItems = findVisibleScoreItems(room);
  if (visibleItems.length === 0) {
    recordSeasonScoreCollectionDiagnostic(creep, {
      tick: getGameTime(),
      state: 'blocked',
      visibleCount: 0,
      blockedReason: 'no_visible_score'
    });
    return null;
  }

  const candidates = visibleItems
    .map((item): SeasonScoreCollectionCandidate => ({
      item,
      blocker: findViableAssignedScoreCollector(creep, item) ?? undefined
    }))
    .sort((left, right) => compareScoreCollectionCandidates(creep, left, right));

  let blockedAssignment: SeasonScoreCollectionCandidate | null = null;
  let blockedCollection: { candidate: SeasonScoreCollectionCandidate; reason: SeasonScoreCollectionBlockReason } | null = null;
  for (const candidate of candidates) {
    const collectorBlockReason = getCreepScoreCollectionBlockReason(creep, candidate.item);
    if (collectorBlockReason) {
      blockedCollection ??= { candidate, reason: collectorBlockReason };
      continue;
    }

    if (candidate.blocker) {
      blockedAssignment ??= candidate;
      continue;
    }

    recordSeasonScoreCollectionDiagnostic(creep, {
      tick: getGameTime(),
      state: 'assigned',
      visibleCount: visibleItems.length,
      targetId: String(candidate.item.id)
    });
    return candidate.item;
  }

  if (blockedCollection) {
    recordSeasonScoreCollectionDiagnostic(creep, {
      tick: getGameTime(),
      state: 'blocked',
      visibleCount: visibleItems.length,
      targetId: String(blockedCollection.candidate.item.id),
      blockedReason: blockedCollection.reason
    });
    return null;
  }

  const assignedCollector = blockedAssignment?.blocker;
  recordSeasonScoreCollectionDiagnostic(creep, {
    tick: getGameTime(),
    state: 'blocked',
    visibleCount: visibleItems.length,
    ...(blockedAssignment ? { targetId: String(blockedAssignment.item.id) } : {}),
    blockedReason: 'collector_already_assigned',
    ...(assignedCollector?.creepName ? { assignedCreepName: assignedCollector.creepName } : {}),
    ...(assignedCollector ? { assignedCollectorRange: assignedCollector.range } : {})
  });
  return null;
}

function findVisibleScoreItems(room: Room): SeasonScoreItem[] {
  const candidates = [
    ...findScoreItemsByFindConstants(room),
    ...findScoreItemsByFallbackRoomKeys(room)
  ];
  const unique = new Map<string, SeasonScoreItem>();

  for (const candidate of candidates) {
    unique.set(String(candidate.id), candidate);
  }

  return [...unique.values()];
}

function findScoreItemsByFindConstants(room: Room): SeasonScoreItem[] {
  const roomFind = (room as Room & { find?: (type: number) => unknown }).find;
  if (typeof roomFind !== 'function') {
    return [];
  }

  return getScoreFindConstants()
    .flatMap((findConstant) => safeRoomFind(room, roomFind, findConstant))
    .filter(isVisibleScoreItem);
}

function getScoreFindConstants(): number[] {
  const globals = globalThis as unknown as Partial<Record<ScoreFindConstantGlobal, unknown>>;
  const constants = SCORE_FIND_CONSTANT_GLOBALS
    .map((name) => globals[name])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  return [...new Set(constants)];
}

function safeRoomFind(room: Room, roomFind: (type: number) => unknown, findConstant: number): unknown[] {
  try {
    const result = roomFind.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function findScoreItemsByFallbackRoomKeys(room: Room): SeasonScoreItem[] {
  const roomRecord = room as unknown as Partial<Record<SeasonScoreRoomKey, unknown>>;
  return SCORE_FALLBACK_ROOM_KEYS.flatMap((key) => toScoreItemCandidates(roomRecord[key])).filter(isVisibleScoreItem);
}

function toScoreItemCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    return Object.values(value);
  }

  return [];
}

function isVisibleScoreItem(value: unknown): value is SeasonScoreItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<SeasonScoreItem> & Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    isRoomPositionLike(candidate.pos) &&
    (hasScoreMarker(candidate) || !hasKnownNonScoreRoomObjectMarker(candidate))
  );
}

function isRoomPositionLike(value: unknown): value is RoomPosition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const position = value as Partial<RoomPosition>;
  return typeof position.x === 'number' && typeof position.y === 'number' && typeof position.roomName === 'string';
}

function hasScoreMarker(candidate: Record<string, unknown>): boolean {
  return (
    candidate.type === 'score' ||
    candidate.type === 'scoreItem' ||
    candidate.objectType === 'score' ||
    candidate.objectType === 'scoreItem' ||
    candidate.scoreType === 'score' ||
    candidate.scoreType === 'scoreItem' ||
    typeof candidate.score === 'number' ||
    typeof candidate.points === 'number'
  );
}

function hasKnownNonScoreRoomObjectMarker(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.resourceType === 'string' ||
    typeof candidate.structureType === 'string' ||
    Array.isArray(candidate.body) ||
    typeof candidate.energyCapacity === 'number' ||
    typeof candidate.mineralType === 'string' ||
    typeof candidate.progressTotal === 'number'
  );
}

function compareScoreItems(creep: Creep, left: SeasonScoreItem, right: SeasonScoreItem): number {
  return getRangeTo(creep, left) - getRangeTo(creep, right) || String(left.id).localeCompare(String(right.id));
}

function compareScoreCollectionCandidates(
  creep: Creep,
  left: SeasonScoreCollectionCandidate,
  right: SeasonScoreCollectionCandidate
): number {
  return (
    Number(left.blocker !== undefined) - Number(right.blocker !== undefined) ||
    compareScoreItems(creep, left.item, right.item)
  );
}

function selectSeasonScoreCollectorCandidateRooms(homeRoom: string): string[] {
  const rooms: string[] = [];
  const seen = new Set<string>();
  const addRoom = (roomName: unknown): void => {
    const normalized = normalizeRoomName(roomName);
    if (!normalized || seen.has(normalized) || !isScoreCollectorCandidateReachable(homeRoom, normalized)) {
      return;
    }

    seen.add(normalized);
    rooms.push(normalized);
  };

  addRoom(homeRoom);
  for (const adjacentRoom of getAdjacentRoomNames(homeRoom)) {
    addRoom(adjacentRoom);
  }
  for (const targetRoom of getTerritoryTargetRooms(homeRoom)) {
    addRoom(targetRoom);
  }
  for (const targetRoom of getTerritoryIntentRooms(homeRoom)) {
    addRoom(targetRoom);
  }
  for (const targetRoom of getTerritoryExpansionScoutRooms(homeRoom)) {
    addRoom(targetRoom);
  }
  for (const targetRoom of getKnownScoutIntelRooms(homeRoom)) {
    addRoom(targetRoom);
  }

  return rooms.slice(0, SCORE_COLLECTOR_MAX_CANDIDATE_ROOMS);
}

function selectActiveScoreCollectorAssignments(
  homeRoom: string,
  gameTime: number
): SeasonScoreCollectorAssignmentState[] {
  return getGameCreeps()
    .filter((creep) => creep.memory?.role === SCORE_COLLECTOR_ROLE && creep.memory.colony === homeRoom)
    .map((creep): SeasonScoreCollectorAssignmentState | null => {
      const memory = normalizeScoreCollectorMemory(creep.memory?.seasonScoreCollector, creep.memory?.colony);
      if (!memory) {
        return null;
      }

      return {
        creep,
        memory,
        ...getScoreCollectorAssignmentStaleReason(creep, memory, gameTime)
      };
    })
    .filter((assignment): assignment is SeasonScoreCollectorAssignmentState => assignment !== null);
}

function getScoreCollectorAssignmentStaleReason(
  creep: Creep,
  memory: CreepSeasonScoreCollectorMemory,
  gameTime: number
): Pick<SeasonScoreCollectorAssignmentState, 'staleReason'> | Record<string, never> {
  const ticksToLive = creep.ticksToLive;
  if (
    typeof ticksToLive === 'number' &&
    Number.isFinite(ticksToLive) &&
    ticksToLive <= SCORE_COLLECTOR_REPLACEMENT_TICKS_TO_LIVE
  ) {
    return { staleReason: 'collector_ttl_insufficient' };
  }

  if (
    typeof memory.updatedAt === 'number' &&
    Number.isFinite(memory.updatedAt) &&
    gameTime >= memory.updatedAt &&
    gameTime - memory.updatedAt > SCORE_COLLECTOR_STALE_TICKS
  ) {
    return { staleReason: 'collector_stale' };
  }

  return {};
}

function groupScoreCollectorAssignmentsByTarget(
  assignments: SeasonScoreCollectorAssignmentState[]
): Map<string, SeasonScoreCollectorAssignmentState> {
  const byTarget = new Map<string, SeasonScoreCollectorAssignmentState>();
  for (const assignment of assignments) {
    const targetRoom = assignment.memory.targetRoom;
    const existing = byTarget.get(targetRoom);
    if (!existing || compareScoreCollectorAssignmentState(assignment, existing) < 0) {
      byTarget.set(targetRoom, assignment);
    }
  }

  return byTarget;
}

function compareScoreCollectorAssignmentState(
  left: SeasonScoreCollectorAssignmentState,
  right: SeasonScoreCollectorAssignmentState
): number {
  return (
    Number(left.staleReason !== undefined) - Number(right.staleReason !== undefined) ||
    String(left.creep.name ?? '').localeCompare(String(right.creep.name ?? ''))
  );
}

function getEffectiveScoreCollectorTargetRooms(assignments: SeasonScoreCollectorAssignmentState[]): string[] {
  return [
    ...new Set(
      assignments
        .filter((assignment) => assignment.staleReason === undefined)
        .map((assignment) => assignment.memory.targetRoom)
    )
  ].sort();
}

function getAdjacentRoomNames(homeRoom: string): string[] {
  const describeExits = (globalThis as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map?.describeExits;
  if (typeof describeExits !== 'function') {
    return [];
  }

  const exits = describeExits.call((globalThis as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map, homeRoom);
  if (!exits || typeof exits !== 'object') {
    return [];
  }

  return Object.values(exits).filter((roomName): roomName is string => isNonEmptyString(roomName)).sort();
}

function getTerritoryTargetRooms(homeRoom: string): string[] {
  const targets = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.targets;
  if (!Array.isArray(targets)) {
    return [];
  }

  return targets
    .filter((target) => target.colony === homeRoom && target.enabled !== false)
    .map((target) => target.roomName)
    .filter(isNonEmptyString);
}

function getTerritoryIntentRooms(homeRoom: string): string[] {
  const intents = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.intents;
  if (!Array.isArray(intents)) {
    return [];
  }

  return intents
    .filter((intent) => intent.colony === homeRoom && intent.status !== 'completed' && intent.status !== 'inactive')
    .map((intent) => intent.targetRoom)
    .filter(isNonEmptyString);
}

function getTerritoryExpansionScoutRooms(homeRoom: string): string[] {
  const targets = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.expansionScoutTargets;
  if (!Array.isArray(targets)) {
    return [];
  }

  return targets
    .filter((target) => target.colony === homeRoom || target.nearestOwnedRoom === homeRoom)
    .sort((left, right) =>
      normalizeNonNegativeInteger(left.routeDistance) - normalizeNonNegativeInteger(right.routeDistance) ||
      left.roomName.localeCompare(right.roomName)
    )
    .map((target) => target.roomName)
    .filter(isNonEmptyString);
}

function getKnownScoutIntelRooms(homeRoom: string): string[] {
  const scoutIntel = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.scoutIntel;
  if (!scoutIntel) {
    return [];
  }

  return Object.values(scoutIntel)
    .filter((intel) => intel.colony === homeRoom || isKnownRouteDistanceReachable(homeRoom, intel.roomName))
    .sort((left, right) =>
      normalizeNonNegativeInteger(left.updatedAt) - normalizeNonNegativeInteger(right.updatedAt) ||
      left.roomName.localeCompare(right.roomName)
    )
    .map((intel) => intel.roomName)
    .filter(isNonEmptyString);
}

function isScoreCollectorCandidateReachable(homeRoom: string, targetRoom: string): boolean {
  if (homeRoom === targetRoom) {
    return true;
  }

  const routeDistance = getKnownRouteDistance(homeRoom, targetRoom);
  return routeDistance !== null;
}

function isKnownRouteDistanceReachable(homeRoom: string, targetRoom: string): boolean {
  return getKnownRouteDistance(homeRoom, targetRoom) !== null;
}

function getKnownRouteDistance(homeRoom: string, targetRoom: string): number | null | undefined {
  const routeDistances = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.routeDistances;
  if (!routeDistances) {
    return undefined;
  }

  return routeDistances[`${homeRoom}>${targetRoom}`];
}

function normalizeScoreCollectorMemory(
  memory: CreepSeasonScoreCollectorMemory | undefined,
  fallbackHomeRoom: string | undefined
): CreepSeasonScoreCollectorMemory | null {
  if (!memory || !isNonEmptyString(memory.targetRoom)) {
    return null;
  }

  const homeRoom = normalizeRoomName(memory.homeRoom) ?? normalizeRoomName(fallbackHomeRoom);
  if (!homeRoom) {
    return null;
  }

  return {
    ...memory,
    homeRoom,
    targetRoom: memory.targetRoom,
    assignedAt: normalizeNonNegativeInteger(memory.assignedAt)
  };
}

function moveToScoreTarget(creep: Creep, target: RoomObject): ScreepsReturnCode {
  if (typeof creep.moveTo !== 'function') {
    return getErrNoPathCode();
  }

  return creep.moveTo(target, { range: 0 }) as ScreepsReturnCode;
}

function moveTowardScoreCollectorTargetRoom(creep: Creep, targetRoom: string): ScreepsReturnCode {
  if (typeof creep.moveTo !== 'function') {
    return getErrNoPathCode();
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
  if (typeof RoomPositionCtor !== 'function') {
    return getErrNoPathCode();
  }

  return creep.moveTo(
    new RoomPositionCtor(SCORE_COLLECTOR_ROOM_CENTER, SCORE_COLLECTOR_ROOM_CENTER, targetRoom)
  ) as ScreepsReturnCode;
}

function recordScoreCollectorCreepState(
  creep: Creep,
  nextState: Partial<CreepSeasonScoreCollectorMemory> & {
    state: SeasonScoreCollectorState;
    visibleScoreCount: number;
  }
): void {
  const current = normalizeScoreCollectorMemory(creep.memory?.seasonScoreCollector, creep.memory?.colony);
  const homeRoom = normalizeRoomName(nextState.homeRoom) ?? current?.homeRoom ?? normalizeRoomName(creep.memory?.colony);
  const targetRoom = normalizeRoomName(nextState.targetRoom) ?? current?.targetRoom;
  if (!homeRoom || !targetRoom) {
    return;
  }

  creep.memory.seasonScoreCollector = {
    homeRoom,
    targetRoom,
    assignedAt: normalizeNonNegativeInteger(nextState.assignedAt ?? current?.assignedAt ?? getGameTime()),
    updatedAt: getGameTime(),
    state: nextState.state,
    visibleScoreCount: nextState.visibleScoreCount,
    ...(nextState.assignedScoreTargetId ? { assignedScoreTargetId: nextState.assignedScoreTargetId } : {}),
    ...(nextState.blocker ? { blocker: nextState.blocker } : {}),
    ...(nextState.staleReason ? { staleReason: nextState.staleReason } : {})
  };
}

function getSeasonScoreCollectionVisibleCount(creep: Creep): number {
  return normalizeNonNegativeInteger(creep.memory?.seasonScoreCollection?.visibleCount ?? 0);
}

function getGameObjectById(id: Id<_HasId>): RoomObject | null {
  const getObjectById = (globalThis as { Game?: Partial<Game> }).Game?.getObjectById;
  if (typeof getObjectById !== 'function') {
    return null;
  }

  return getObjectById.call((globalThis as { Game?: Partial<Game> }).Game, id) as RoomObject | null;
}

function recordSeasonScoreCollectorsDiagnostic(diagnostic: SeasonScoreCollectorsDiagnosticsMemory): void {
  const memory = getWritableMemory();
  if (!memory) {
    return;
  }

  memory.seasonScoreCollectors = diagnostic;
}

function getWritableMemory(): Partial<Memory> | null {
  const globalScope = globalThis as { Memory?: Partial<Memory> };
  if (!globalScope.Memory) {
    return null;
  }

  return globalScope.Memory;
}

function isEligibleSeasonScoreCollector(creep: Creep): boolean {
  return creep.memory?.role === 'worker' ||
    creep.memory?.role === 'hauler' ||
    creep.memory?.role === SCORE_COLLECTOR_ROLE;
}

function findViableAssignedScoreCollector(
  requestingCreep: Creep,
  target: SeasonScoreItem
): SeasonScoreAssignedCollector | null {
  for (const assignedCreep of getGameCreeps()) {
    if (isSameCreep(assignedCreep, requestingCreep)) {
      continue;
    }

    const task = assignedCreep.memory?.task;
    if (task?.type !== 'collectScore' || String(task.targetId) !== String(target.id)) {
      continue;
    }

    if (getCreepScoreCollectionBlockReason(assignedCreep, target)) {
      continue;
    }

    return {
      ...optionalCreepName(assignedCreep),
      range: getRangeTo(assignedCreep, target)
    };
  }

  return null;
}

function getCreepScoreCollectionBlockReason(
  creep: Creep,
  target: SeasonScoreItem
): SeasonScoreCollectionBlockReason | null {
  if (typeof creep.moveTo !== 'function') {
    return 'move_unavailable';
  }

  const travelTicks = getRangeTo(creep, target);
  if (!Number.isFinite(travelTicks) || travelTicks === Number.MAX_SAFE_INTEGER) {
    return 'move_unavailable';
  }

  const ticksToLive = creep.ticksToLive;
  if (
    typeof ticksToLive === 'number' &&
    Number.isFinite(ticksToLive) &&
    ticksToLive <= travelTicks + SCORE_COLLECTION_TRAVEL_BUFFER_TICKS
  ) {
    return 'collector_ttl_insufficient';
  }

  const decayTime = target.decayTime;
  const gameTime = getGameTime();
  if (
    typeof decayTime === 'number' &&
    Number.isFinite(decayTime) &&
    decayTime <= gameTime + travelTicks + SCORE_COLLECTION_TRAVEL_BUFFER_TICKS
  ) {
    return 'score_decay_impossible';
  }

  return null;
}

function getRangeTo(creep: Creep, target: RoomObject): number {
  const range = creep.pos?.getRangeTo?.(target);
  return typeof range === 'number' && Number.isFinite(range) ? range : Number.MAX_SAFE_INTEGER;
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as unknown as { Game?: Partial<Game> }).Game?.creeps;
  return creeps ? Object.values(creeps) : [];
}

function getGameTime(): number {
  const time = (globalThis as unknown as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
}

function isSameCreep(left: Creep, right: Creep): boolean {
  return left === right || (left.name !== undefined && left.name === right.name);
}

function optionalCreepName(creep: Creep): Pick<SeasonScoreAssignedCollector, 'creepName'> | Record<string, never> {
  return typeof creep.name === 'string' && creep.name.length > 0 ? { creepName: creep.name } : {};
}

function recordSeasonScoreCollectionDiagnostic(
  creep: Creep,
  diagnostic: SeasonScoreCollectionDiagnosticMemory
): void {
  if (!creep.memory) {
    return;
  }

  creep.memory.seasonScoreCollection = diagnostic;
}

function clearSeasonScoreCollectionDiagnostic(creep: Creep): void {
  if (creep.memory) {
    delete creep.memory.seasonScoreCollection;
  }
}

function normalizeRoomName(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function getErrNoPathCode(): ScreepsReturnCode {
  const errNoPath = (globalThis as { ERR_NO_PATH?: number }).ERR_NO_PATH;
  return (typeof errNoPath === 'number' ? errNoPath : -2) as ScreepsReturnCode;
}
