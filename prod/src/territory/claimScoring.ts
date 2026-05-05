export interface ClaimScore {
  roomName: string;
  score: number;
  sources: number;
  distance: number;
  details: string[];
}

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;
const TERRAIN_SCAN_MIN = 2;
const TERRAIN_SCAN_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const DEFAULT_TERRAIN_SWAMP_MASK = 2;
const SOURCE_SCORE = 150;
const DUAL_SOURCE_BONUS = 260;
const HOSTILE_PENALTY = 1_200;
const CLAIMED_PENALTY = 2_000;
export const CLAIM_SCORE_RESERVED_PENALTY = 900;
const MISSING_CONTROLLER_PENALTY = 500;
const DISTANCE_PENALTY = 55;
const NO_ROUTE_DISTANCE = 99;

type FindConstantName = 'FIND_SOURCES' | 'FIND_HOSTILE_CREEPS' | 'FIND_HOSTILE_STRUCTURES';
type TerrainMaskName = 'TERRAIN_MASK_WALL' | 'TERRAIN_MASK_SWAMP';

export function scoreClaimTarget(roomName: string, homeRoom: Room): ClaimScore {
  const details: string[] = [];
  const room = getVisibleRoom(roomName);
  const scoutIntel = getScoutIntel(homeRoom.name, roomName);
  const sources = countSources(room, scoutIntel);
  const distance = getRoomDistance(homeRoom.name, roomName);
  let score = 0;

  if (sources >= 2) {
    score += sources * SOURCE_SCORE + DUAL_SOURCE_BONUS;
    details.push(`${sources} sources preferred`);
  } else if (sources === 1) {
    score += SOURCE_SCORE;
    details.push('1 source visible');
  } else {
    details.push('sources unknown or missing');
  }

  score += scoreControllerDistance(room, details);
  score += scoreTerrain(roomName, details);

  if (distance === NO_ROUTE_DISTANCE) {
    score -= DISTANCE_PENALTY * 4;
    details.push('home route unavailable');
  } else {
    score -= distance * DISTANCE_PENALTY;
    details.push(`home route distance ${distance}`);
  }

  const hostileCount = countHostiles(room, scoutIntel);
  if (hostileCount > 0) {
    score -= HOSTILE_PENALTY;
    details.push(`hostile presence ${hostileCount}`);
  }

  const controllerStatus = getControllerStatus(room, scoutIntel);
  switch (controllerStatus) {
    case 'owned':
      score -= CLAIMED_PENALTY;
      details.push('controller already claimed');
      break;
    case 'reserved':
      score -= CLAIM_SCORE_RESERVED_PENALTY;
      details.push('controller already reserved');
      break;
    case 'missing':
      score -= MISSING_CONTROLLER_PENALTY;
      details.push('controller missing');
      break;
    case 'neutral':
      details.push('controller unclaimed');
      break;
    case 'unknown':
      details.push('controller status unknown');
      break;
  }

  return {
    roomName,
    score: Math.round(score),
    sources,
    distance,
    details
  };
}

export function selectBestClaimTarget(homeRoom: Room): string | null {
  const adjacentRooms = getAdjacentRoomNames(homeRoom.name);
  const candidates = adjacentRooms
    .map((roomName) => scoreClaimTarget(roomName, homeRoom))
    .filter((candidate) => candidate.sources > 0 && candidate.score > 0 && !hasUnclaimableController(candidate));

  candidates.sort(compareClaimScores);
  return candidates[0]?.roomName ?? null;
}

function compareClaimScores(left: ClaimScore, right: ClaimScore): number {
  return (
    right.score - left.score ||
    right.sources - left.sources ||
    left.distance - right.distance ||
    left.roomName.localeCompare(right.roomName)
  );
}

function hasUnclaimableController(score: ClaimScore): boolean {
  return score.details.some(
    (detail) =>
      detail === 'controller already claimed' ||
      detail === 'controller already reserved' ||
      detail === 'controller missing'
  );
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
}

function getScoutIntel(homeRoomName: string, roomName: string): TerritoryScoutIntelMemory | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.scoutIntel?.[
    `${homeRoomName}>${roomName}`
  ];
}

function countSources(room: Room | undefined, scoutIntel: TerritoryScoutIntelMemory | undefined): number {
  if (room) {
    return findRoomObjects<Source>(room, 'FIND_SOURCES').length;
  }

  return typeof scoutIntel?.sourceCount === 'number' ? scoutIntel.sourceCount : 0;
}

function countHostiles(room: Room | undefined, scoutIntel: TerritoryScoutIntelMemory | undefined): number {
  if (room) {
    return (
      findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS').length +
      findRoomObjects<Structure>(room, 'FIND_HOSTILE_STRUCTURES').length
    );
  }

  return (
    (scoutIntel?.hostileCreepCount ?? 0) +
    (scoutIntel?.hostileStructureCount ?? 0) +
    (scoutIntel?.hostileSpawnCount ?? 0)
  );
}

function scoreControllerDistance(room: Room | undefined, details: string[]): number {
  const controller = room?.controller;
  const controllerPos = (controller as { pos?: RoomPosition } | undefined)?.pos;
  if (!controllerPos) {
    details.push('controller distance unknown');
    return 0;
  }

  const ranges = findRoomObjects<Source>(room, 'FIND_SOURCES')
    .map((source) => getRange(controllerPos, (source as { pos?: RoomPosition }).pos))
    .filter((range): range is number => typeof range === 'number' && Number.isFinite(range));
  if (ranges.length === 0) {
    details.push('controller distance unknown');
    return 0;
  }

  const closestRange = Math.min(...ranges);
  details.push(`controller-source range ${closestRange}`);
  return Math.max(0, 120 - closestRange * 6);
}

function scoreTerrain(roomName: string, details: string[]): number {
  const terrain = getRoomTerrain(roomName);
  if (!terrain) {
    details.push('terrain unknown');
    return 0;
  }

  const wallMask = getGlobalNumber('TERRAIN_MASK_WALL') ?? DEFAULT_TERRAIN_WALL_MASK;
  const swampMask = getGlobalNumber('TERRAIN_MASK_SWAMP') ?? DEFAULT_TERRAIN_SWAMP_MASK;
  let total = 0;
  let walls = 0;
  let swamps = 0;

  for (let x = TERRAIN_SCAN_MIN; x <= TERRAIN_SCAN_MAX; x += 1) {
    for (let y = TERRAIN_SCAN_MIN; y <= TERRAIN_SCAN_MAX; y += 1) {
      total += 1;
      const terrainMask = terrain.get(x, y);
      if ((terrainMask & wallMask) !== 0) {
        walls += 1;
      } else if ((terrainMask & swampMask) !== 0) {
        swamps += 1;
      }
    }
  }

  const walkableRatio = (total - walls) / total;
  const swampRatio = swamps / total;
  details.push(`terrain walkable ${Math.round(walkableRatio * 100)}%`);
  return Math.round(walkableRatio * 120 - swampRatio * 45);
}

function getControllerStatus(
  room: Room | undefined,
  scoutIntel: TerritoryScoutIntelMemory | undefined
): 'neutral' | 'owned' | 'reserved' | 'missing' | 'unknown' {
  if (room) {
    const controller = room.controller;
    if (!controller) {
      return 'missing';
    }

    if (controller.my === true || isNonEmptyString(controller.owner?.username)) {
      return 'owned';
    }

    if (isNonEmptyString(controller.reservation?.username)) {
      return 'reserved';
    }

    return 'neutral';
  }

  if (scoutIntel?.controller) {
    const controller = scoutIntel.controller;
    if (controller.my === true || isNonEmptyString(controller.ownerUsername)) {
      return 'owned';
    }

    if (isNonEmptyString(controller.reservationUsername)) {
      return 'reserved';
    }

    return 'neutral';
  }

  return scoutIntel ? 'missing' : 'unknown';
}

function getRoomDistance(homeRoomName: string, roomName: string): number {
  if (homeRoomName === roomName) {
    return 0;
  }

  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  if (!gameMap) {
    return NO_ROUTE_DISTANCE;
  }

  if (typeof gameMap.findRoute === 'function') {
    const route = gameMap.findRoute(homeRoomName, roomName);
    if (Array.isArray(route)) {
      return route.length;
    }

    return NO_ROUTE_DISTANCE;
  }

  if (typeof gameMap.getRoomLinearDistance === 'function') {
    const linearDistance = gameMap.getRoomLinearDistance(homeRoomName, roomName);
    if (typeof linearDistance === 'number' && Number.isFinite(linearDistance)) {
      return linearDistance;
    }
  }

  return NO_ROUTE_DISTANCE;
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
    const adjacentRoom = exits[direction];
    return isNonEmptyString(adjacentRoom) ? [adjacentRoom] : [];
  });
}

function getRoomTerrain(roomName: string): RoomTerrain | null {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  if (!gameMap || typeof gameMap.getRoomTerrain !== 'function') {
    return null;
  }

  return gameMap.getRoomTerrain(roomName);
}

function findRoomObjects<T>(room: Room | undefined, constantName: FindConstantName): T[] {
  const findConstant = getGlobalNumber(constantName);
  if (!room || typeof room.find !== 'function' || typeof findConstant !== 'number') {
    return [];
  }

  return room.find(findConstant as FindConstant) as T[];
}

function getRange(origin: RoomPosition | undefined, target: RoomPosition | undefined): number | null {
  if (!origin || !target) {
    return null;
  }

  if (typeof origin.getRangeTo === 'function') {
    return origin.getRangeTo(target);
  }

  if (
    typeof origin.x === 'number' &&
    typeof origin.y === 'number' &&
    typeof target.x === 'number' &&
    typeof target.y === 'number'
  ) {
    return Math.max(Math.abs(origin.x - target.x), Math.abs(origin.y - target.y));
  }

  return null;
}

function getGlobalNumber(name: FindConstantName | TerrainMaskName): number | undefined {
  const value = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
