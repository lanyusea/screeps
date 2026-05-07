import type { ColonySnapshot } from '../colony/colonyRegistry';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  ensureTerritoryScoutAttempt,
  getTerritoryScoutIntel,
  recordVisibleRoomScoutIntel
} from './scoutIntel';

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;
const TERRAIN_SCAN_MIN = 2;
const TERRAIN_SCAN_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const DEFAULT_TERRAIN_SWAMP_MASK = 2;

export type RoomScoutingTerrainType = 'plain' | 'swamp' | 'wall' | 'mixed' | 'unknown';
export type RoomScoutingStatus = 'observed' | 'requested';

export interface VisibleRoomScoutingSnapshot {
  roomName: string;
  controller?: StructureController;
  controllerPresent: boolean;
  controllerId?: Id<StructureController>;
  sources: Source[];
  sourceCount: number;
  terrain: RoomTerrain | null;
  terrainQuality?: TerritoryTerrainQualityMemory;
  terrainType: RoomScoutingTerrainType;
}

export interface RoomScoutingTarget {
  roomName: string;
  controllerId?: Id<StructureController>;
}

export interface RoomScoutingRecord {
  colony: string;
  roomName: string;
  status: RoomScoutingStatus;
  updatedAt: number;
  sourceCount?: number;
  controllerPresent?: boolean;
  controllerId?: Id<StructureController>;
  terrainType?: RoomScoutingTerrainType;
}

export interface RoomScoutingRefreshResult {
  colony: string;
  records: RoomScoutingRecord[];
}

export function collectVisibleRoomScoutingSnapshot(room: Room): VisibleRoomScoutingSnapshot {
  const sources = findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES'));
  const terrain = getRoomTerrain(room);
  const terrainQuality = summarizeRoomTerrainFromTerrain(terrain);
  const controllerId = typeof room.controller?.id === 'string'
    ? (room.controller.id as Id<StructureController>)
    : undefined;

  return {
    roomName: room.name,
    ...(room.controller ? { controller: room.controller } : {}),
    controllerPresent: room.controller !== undefined,
    ...(controllerId ? { controllerId } : {}),
    sources,
    sourceCount: sources.length,
    terrain,
    ...(terrainQuality ? { terrainQuality } : {}),
    terrainType: classifyRoomTerrain(terrainQuality)
  };
}

export function refreshAdjacentRoomScouting(
  colony: ColonySnapshot,
  gameTime = getGameTime(),
  telemetryEvents: RuntimeTelemetryEvent[] = []
): RoomScoutingRefreshResult {
  return refreshExpansionRoomScouting(
    colony,
    getAdjacentRoomScoutingTargets(colony.room.name),
    gameTime,
    telemetryEvents
  );
}

export function refreshExpansionRoomScouting(
  colony: ColonySnapshot,
  targets: RoomScoutingTarget[],
  gameTime = getGameTime(),
  telemetryEvents: RuntimeTelemetryEvent[] = []
): RoomScoutingRefreshResult {
  const colonyName = colony.room.name;
  const records: RoomScoutingRecord[] = [];
  const seenRooms = new Set<string>();

  for (const target of targets) {
    if (!isNonEmptyString(target.roomName) || target.roomName === colonyName || seenRooms.has(target.roomName)) {
      continue;
    }
    seenRooms.add(target.roomName);

    const visibleRoom = getVisibleRoom(target.roomName);
    if (visibleRoom) {
      const intel = hasCurrentTickScoutIntel(colonyName, target.roomName, gameTime)
        ? getTerritoryScoutIntel(colonyName, target.roomName)
        : recordVisibleRoomScoutIntel(colonyName, visibleRoom, gameTime, undefined, telemetryEvents);
      const snapshot = collectVisibleRoomScoutingSnapshot(visibleRoom);
      records.push({
        colony: colonyName,
        roomName: target.roomName,
        status: 'observed',
        updatedAt: gameTime,
        sourceCount: intel?.sourceCount ?? snapshot.sourceCount,
        controllerPresent: snapshot.controllerPresent,
        ...(intel?.controller?.id ?? snapshot.controllerId
          ? { controllerId: (intel?.controller?.id ?? snapshot.controllerId) as Id<StructureController> }
          : {}),
        terrainType: snapshot.terrainType
      });
      continue;
    }

    ensureTerritoryScoutAttempt(colonyName, target.roomName, gameTime, telemetryEvents, target.controllerId);
    records.push({
      colony: colonyName,
      roomName: target.roomName,
      status: 'requested',
      updatedAt: gameTime,
      ...(target.controllerId ? { controllerId: target.controllerId } : {})
    });
  }

  return { colony: colonyName, records };
}

export function getAdjacentRoomScoutingTargets(roomName: string): RoomScoutingTarget[] {
  return getAdjacentRoomNames(roomName).map((adjacentRoomName) => ({ roomName: adjacentRoomName }));
}

export function classifyRoomTerrain(
  terrain: TerritoryTerrainQualityMemory | null | undefined
): RoomScoutingTerrainType {
  if (!terrain) {
    return 'unknown';
  }

  if (terrain.wallRatio >= 0.5) {
    return 'wall';
  }

  if (terrain.swampRatio >= 0.35) {
    return 'swamp';
  }

  if (terrain.walkableRatio >= 0.85 && terrain.swampRatio <= 0.1) {
    return 'plain';
  }

  return 'mixed';
}

function hasCurrentTickScoutIntel(colony: string, roomName: string, gameTime: number): boolean {
  return getTerritoryScoutIntel(colony, roomName)?.updatedAt === gameTime;
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

function summarizeRoomTerrainFromTerrain(terrain: RoomTerrain | null): TerritoryTerrainQualityMemory | null {
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

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
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

function getTerrainMask(name: 'TERRAIN_MASK_WALL' | 'TERRAIN_MASK_SWAMP', fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : fallback;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function roundRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1_000) / 1_000 : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
