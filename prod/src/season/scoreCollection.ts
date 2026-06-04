import { getRuntimeFeatureGates } from '../runtime/featureGates';

type ScoreFindConstantGlobal =
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

const SCORE_FIND_CONSTANT_GLOBALS: ScoreFindConstantGlobal[] = [
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

function isEligibleSeasonScoreCollector(creep: Creep): boolean {
  return creep.memory?.role === 'worker' || creep.memory?.role === 'hauler';
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
