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

interface LookEntry {
  [key: string]: unknown;
  terrain?: string;
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
  for (let radius = 1; radius <= MAX_EXTENSION_PLANNER_RADIUS; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) {
          continue;
        }

        const position = { x: anchor.x + dx, y: anchor.y + dy };
        if (canPlaceExtension(room, position)) {
          return position;
        }
      }
    }
  }

  return null;
}

function canPlaceExtension(room: Room, position: CandidatePosition): boolean {
  if (position.x < ROOM_EDGE_MIN || position.x > ROOM_EDGE_MAX || position.y < ROOM_EDGE_MIN || position.y > ROOM_EDGE_MAX) {
    return false;
  }

  if (isTerrainWall(room, position)) {
    return false;
  }

  return !hasBlockingObject(room, position);
}

function isTerrainWall(room: Room, position: CandidatePosition): boolean {
  const terrain = Game.map?.getRoomTerrain(room.name).get(position.x, position.y);
  return terrain === getTerrainWallMask();
}

function hasBlockingObject(room: Room, position: CandidatePosition): boolean {
  const lookAt = (room as unknown as { lookAt?: (x: number, y: number) => LookEntry[] }).lookAt;
  const lookEntries = lookAt?.call(room, position.x, position.y) ?? [];

  return lookEntries.some((entry) => entry.terrain === 'wall' || hasNonTerrainLookResult(entry));
}

function hasNonTerrainLookResult(entry: LookEntry): boolean {
  return Object.entries(entry).some(([key, value]) => key !== 'type' && key !== 'terrain' && value !== undefined);
}

function getTerrainWallMask(): number {
  return typeof TERRAIN_MASK_WALL === 'number' ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK;
}
