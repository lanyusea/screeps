import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  findSourceContainer,
  getPositionKey,
  getRangeBetweenPositions,
  getRoomObjectPosition,
  isSameRoomPosition
} from '../economy/sourceContainers';

const MIN_CONTROLLER_LEVEL_FOR_SOURCE_CONTAINERS = 2;
const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const DEFAULT_TERRAIN_WALL_MASK = 1;

interface CandidatePosition {
  x: number;
  y: number;
  roomName: string;
}

interface SourceContainerPlannerLookups {
  terrain: RoomTerrain;
  blockedPositions: Set<string>;
  pendingContainerPositions: Set<string>;
}

export function planSourceContainerConstruction(colony: ColonySnapshot): ScreepsReturnCode | null {
  const room = colony.room;
  if (
    (room.controller?.level ?? 0) < MIN_CONTROLLER_LEVEL_FOR_SOURCE_CONTAINERS ||
    !hasRequiredRoomApis(room) ||
    typeof FIND_SOURCES !== 'number'
  ) {
    return null;
  }

  const lookups = createSourceContainerPlannerLookups(room);
  if (!lookups) {
    return null;
  }

  const anchor = selectContainerAnchor(colony);
  for (const source of getSortedSources(room)) {
    if (findSourceContainer(room, source) || hasPendingSourceContainerSite(source, lookups)) {
      continue;
    }

    const position = selectSourceContainerPosition(source, lookups, anchor);
    if (!position) {
      continue;
    }

    const result = room.createConstructionSite(position.x, position.y, getContainerStructureType());
    if (result === getOkCode()) {
      lookups.blockedPositions.add(getPositionKey(position));
      lookups.pendingContainerPositions.add(getPositionKey(position));
    }

    return result;
  }

  return null;
}

function hasRequiredRoomApis(room: Room): boolean {
  const partialRoom = room as Partial<Room>;
  return typeof partialRoom.find === 'function' && typeof partialRoom.createConstructionSite === 'function';
}

function createSourceContainerPlannerLookups(room: Room): SourceContainerPlannerLookups | null {
  if (typeof FIND_STRUCTURES !== 'number' || typeof FIND_CONSTRUCTION_SITES !== 'number') {
    return null;
  }

  const terrain = getRoomTerrain(room);
  if (!terrain) {
    return null;
  }

  const lookups: SourceContainerPlannerLookups = {
    terrain,
    blockedPositions: new Set<string>(),
    pendingContainerPositions: new Set<string>()
  };

  for (const structure of room.find(FIND_STRUCTURES)) {
    const position = getRoomObjectPosition(structure);
    if (position && isSameRoomPosition(position, room.name)) {
      lookups.blockedPositions.add(getPositionKey(position));
    }
  }

  for (const site of room.find(FIND_CONSTRUCTION_SITES)) {
    const position = getRoomObjectPosition(site);
    if (!position || !isSameRoomPosition(position, room.name)) {
      continue;
    }

    const key = getPositionKey(position);
    lookups.blockedPositions.add(key);
    if (isContainerConstructionSite(site)) {
      lookups.pendingContainerPositions.add(key);
    }
  }

  return lookups;
}

function getSortedSources(room: Room): Source[] {
  return room
    .find(FIND_SOURCES)
    .filter((source) => {
      const position = getRoomObjectPosition(source);
      return position !== null && isSameRoomPosition(position, room.name);
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function selectContainerAnchor(colony: ColonySnapshot): RoomPosition | null {
  const [primarySpawn] = colony.spawns
    .filter((spawn) => getRoomObjectPosition(spawn) !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  const anchorObject = primarySpawn ?? colony.room.controller;
  return anchorObject ? getRoomObjectPosition(anchorObject) : null;
}

function hasPendingSourceContainerSite(source: Source, lookups: SourceContainerPlannerLookups): boolean {
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition) {
    return false;
  }

  return getAdjacentSourceContainerPositions(sourcePosition).some((position) =>
    lookups.pendingContainerPositions.has(getPositionKey(position))
  );
}

function selectSourceContainerPosition(
  source: Source,
  lookups: SourceContainerPlannerLookups,
  anchor: RoomPosition | null
): CandidatePosition | null {
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition || typeof sourcePosition.roomName !== 'string') {
    return null;
  }

  const candidates = getAdjacentSourceContainerPositions(sourcePosition).filter((position) =>
    canPlaceSourceContainer(lookups, position)
  );
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((left, right) => compareSourceContainerPositions(left, right, anchor))[0];
}

function getAdjacentSourceContainerPositions(sourcePosition: RoomPosition): CandidatePosition[] {
  const positions: CandidatePosition[] = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      positions.push({
        x: sourcePosition.x + dx,
        y: sourcePosition.y + dy,
        roomName: sourcePosition.roomName
      });
    }
  }

  return positions;
}

function canPlaceSourceContainer(
  lookups: SourceContainerPlannerLookups,
  position: CandidatePosition
): boolean {
  if (
    position.x < ROOM_EDGE_MIN ||
    position.x > ROOM_EDGE_MAX ||
    position.y < ROOM_EDGE_MIN ||
    position.y > ROOM_EDGE_MAX
  ) {
    return false;
  }

  if ((lookups.terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0) {
    return false;
  }

  return !lookups.blockedPositions.has(getPositionKey(position));
}

function compareSourceContainerPositions(
  left: CandidatePosition,
  right: CandidatePosition,
  anchor: RoomPosition | null
): number {
  if (anchor) {
    const leftRange = getRangeBetweenPositions(left, anchor);
    const rightRange = getRangeBetweenPositions(right, anchor);
    if (leftRange !== rightRange) {
      return leftRange - rightRange;
    }
  }

  return left.y - right.y || left.x - right.x;
}

function getRoomTerrain(room: Room): RoomTerrain | null {
  const game = (globalThis as unknown as { Game?: Partial<Game> }).Game;
  return typeof game?.map?.getRoomTerrain === 'function' ? game.map.getRoomTerrain(room.name) : null;
}

function getTerrainWallMask(): number {
  const terrainWallMask = (globalThis as unknown as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof terrainWallMask === 'number' ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK;
}

function isContainerConstructionSite(site: ConstructionSite): boolean {
  return site.structureType === getContainerStructureType();
}

function getContainerStructureType(): BuildableStructureConstant {
  return ((globalThis as unknown as { STRUCTURE_CONTAINER?: StructureConstant }).STRUCTURE_CONTAINER ??
    'container') as BuildableStructureConstant;
}

function getOkCode(): ScreepsReturnCode {
  return ((globalThis as unknown as { OK?: ScreepsReturnCode }).OK ?? 0) as ScreepsReturnCode;
}
