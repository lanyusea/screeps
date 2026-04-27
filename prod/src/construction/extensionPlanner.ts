import type { ColonySnapshot } from '../colony/colonyRegistry';

const EXTENSION_LIMITS_BY_RCL: Record<number, number> = {
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60
};

const MAX_EXTENSION_PLANNER_RADIUS = 6;
const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const DEFAULT_TERRAIN_WALL_MASK = 1;

interface CandidatePosition {
  x: number;
  y: number;
}

interface ScanBounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface PlannerLookups {
  terrain: RoomTerrain;
  blockingPositions: Set<string>;
  reservedWalkwayPositions: Set<string>;
}

export function planExtensionConstruction(colony: ColonySnapshot): ScreepsReturnCode | null {
  const allowedExtensions = getExtensionLimitForRcl(colony.room.controller?.level);
  if (allowedExtensions <= 0) {
    return null;
  }

  const plannedExtensions = countExistingAndPendingExtensions(colony.room);
  if (plannedExtensions >= allowedExtensions) {
    return null;
  }

  const anchor = selectExtensionAnchor(colony);
  if (!anchor) {
    return null;
  }

  const position = findNextExtensionPosition(colony.room, anchor);
  if (!position) {
    return null;
  }

  return colony.room.createConstructionSite(position.x, position.y, STRUCTURE_EXTENSION);
}

export function getExtensionLimitForRcl(level: number | undefined): number {
  return level ? EXTENSION_LIMITS_BY_RCL[level] ?? 0 : 0;
}

function countExistingAndPendingExtensions(room: Room): number {
  const existingExtensions = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_EXTENSION
  });
  const pendingExtensions = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (site) => site.structureType === STRUCTURE_EXTENSION
  });

  return existingExtensions.length + pendingExtensions.length;
}

function selectExtensionAnchor(colony: ColonySnapshot): RoomPosition | null {
  const [primarySpawn] = colony.spawns
    .filter((spawn) => spawn.pos)
    .sort((left, right) => left.name.localeCompare(right.name));

  return primarySpawn?.pos ?? colony.room.controller?.pos ?? null;
}

function findNextExtensionPosition(room: Room, anchor: RoomPosition): CandidatePosition | null {
  const lookups = createPlannerLookups(room, anchor);
  const anchorParity = getPositionParity(anchor);

  for (let radius = 1; radius <= MAX_EXTENSION_PLANNER_RADIUS; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
          continue;
        }

        const position = { x: anchor.x + dx, y: anchor.y + dy };
        if (canPlaceExtension(lookups, anchorParity, position)) {
          return position;
        }
      }
    }
  }

  return null;
}

function createPlannerLookups(room: Room, anchor: RoomPosition): PlannerLookups {
  const bounds = getScanBounds(anchor);

  return {
    terrain: Game.map.getRoomTerrain(room.name),
    blockingPositions: getBlockingPositions(room, bounds),
    reservedWalkwayPositions: getReservedWalkwayPositions(anchor)
  };
}

function getScanBounds(anchor: RoomPosition): ScanBounds {
  return {
    top: Math.max(ROOM_EDGE_MIN, anchor.y - MAX_EXTENSION_PLANNER_RADIUS),
    left: Math.max(ROOM_EDGE_MIN, anchor.x - MAX_EXTENSION_PLANNER_RADIUS),
    bottom: Math.min(ROOM_EDGE_MAX, anchor.y + MAX_EXTENSION_PLANNER_RADIUS),
    right: Math.min(ROOM_EDGE_MAX, anchor.x + MAX_EXTENSION_PLANNER_RADIUS)
  };
}

function getBlockingPositions(room: Room, bounds: ScanBounds): Set<string> {
  const blockingPositions = new Set<string>();
  const structures = room.lookForAtArea(LOOK_STRUCTURES, bounds.top, bounds.left, bounds.bottom, bounds.right, true);
  const constructionSites = room.lookForAtArea(LOOK_CONSTRUCTION_SITES, bounds.top, bounds.left, bounds.bottom, bounds.right, true);

  for (const structure of structures) {
    blockingPositions.add(getPositionKey(structure));
  }

  for (const constructionSite of constructionSites) {
    blockingPositions.add(getPositionKey(constructionSite));
  }

  return blockingPositions;
}

function canPlaceExtension(lookups: PlannerLookups, anchorParity: number, position: CandidatePosition): boolean {
  if (position.x < ROOM_EDGE_MIN || position.x > ROOM_EDGE_MAX || position.y < ROOM_EDGE_MIN || position.y > ROOM_EDGE_MAX) {
    return false;
  }

  if (lookups.reservedWalkwayPositions.has(getPositionKey(position))) {
    return false;
  }

  if (getPositionParity(position) !== anchorParity) {
    return false;
  }

  if (isTerrainWall(lookups.terrain, position)) {
    return false;
  }

  return !lookups.blockingPositions.has(getPositionKey(position));
}

function getReservedWalkwayPositions(anchor: RoomPosition): Set<string> {
  return new Set(
    [
      { x: anchor.x, y: anchor.y - 1 },
      { x: anchor.x + 1, y: anchor.y },
      { x: anchor.x, y: anchor.y + 1 },
      { x: anchor.x - 1, y: anchor.y }
    ]
      .filter((position) => isWithinRoomBounds(position))
      .map(getPositionKey)
  );
}

function isWithinRoomBounds(position: CandidatePosition): boolean {
  return (
    position.x >= ROOM_EDGE_MIN &&
    position.x <= ROOM_EDGE_MAX &&
    position.y >= ROOM_EDGE_MIN &&
    position.y <= ROOM_EDGE_MAX
  );
}

function getPositionParity(position: CandidatePosition): number {
  return (position.x + position.y) % 2;
}

function isTerrainWall(terrain: RoomTerrain, position: CandidatePosition): boolean {
  return (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function getPositionKey(position: CandidatePosition): string {
  return `${position.x},${position.y}`;
}

function getTerrainWallMask(): number {
  return typeof TERRAIN_MASK_WALL === 'number' ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK;
}
