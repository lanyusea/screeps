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

export function selectSeasonScoreCollectionTask(
  creep: Creep
): Extract<CreepTaskMemory, { type: 'collectScore' }> | null {
  if (!getRuntimeFeatureGates().isSeasonal || creep.memory?.role !== 'worker') {
    return null;
  }

  const scoreItem = selectBestVisibleScoreItem(creep);
  return scoreItem ? { type: 'collectScore', targetId: scoreItem.id } : null;
}

function selectBestVisibleScoreItem(creep: Creep): SeasonScoreItem | null {
  const room = creep.room;
  if (!room) {
    return null;
  }

  return findVisibleScoreItems(room).sort((left, right) => compareScoreItems(creep, left, right))[0] ?? null;
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

function getRangeTo(creep: Creep, target: RoomObject): number {
  const range = creep.pos?.getRangeTo?.(target);
  return typeof range === 'number' && Number.isFinite(range) ? range : Number.MAX_SAFE_INTEGER;
}
