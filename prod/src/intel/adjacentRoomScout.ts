const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'] as const;
const TERRAIN_SCAN_MIN = 2;
const TERRAIN_SCAN_MAX = 47;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const DEFAULT_TERRAIN_SWAMP_MASK = 2;
const OK_CODE = 0 as ScreepsReturnCode;

export const ROOM_SCOUT_REPORT_TTL = 10_000;

type FindConstantName = 'FIND_SOURCES' | 'FIND_MINERALS' | 'FIND_MY_STRUCTURES';
type TerrainMaskName = 'TERRAIN_MASK_WALL' | 'TERRAIN_MASK_SWAMP';
type ObserverStructure = Structure & {
  structureType?: StructureConstant | string;
  observeRoom?: (roomName: string) => ScreepsReturnCode;
};

export type RoomScoutReport = RoomScoutReportMemory;
export type RoomScoutTerrain = RoomScoutTerrainMemory;
export type RoomScoutController = RoomScoutControllerMemory;

export interface RoomScoutScore {
  roomName: string;
  score: number;
  report: RoomScoutReport;
  rationale: string[];
}

export function refreshAdjacentRoomScoutReports(
  originRoomName: string,
  gameTime = getGameTime()
): RoomScoutReport[] {
  const memory = getWritableIntelMemory();
  if (!memory) {
    return [];
  }

  const scoutReports = getWritableScoutReports(memory);
  pruneStaleScoutReports(scoutReports, gameTime);

  const reports: RoomScoutReport[] = [];
  let observerRequested = false;
  const originRoom = getVisibleRoom(originRoomName);
  for (const roomName of getAdjacentRoomNames(originRoomName)) {
    const cachedReport = scoutReports[roomName];
    const report = buildRoomScoutReport(
      roomName,
      gameTime,
      isReusableRoomScoutReport(roomName, cachedReport) ? cachedReport : null
    );
    if (!report) {
      continue;
    }

    if (report.visible !== true && !observerRequested && requestObserverScan(originRoom, roomName)) {
      report.observerRequested = true;
      observerRequested = true;
    }

    scoutReports[roomName] = report;
    reports.push(report);
  }

  return reports;
}

export function rankAdjacentRoomScoutReports(
  originRoomName: string,
  gameTime = getGameTime()
): RoomScoutScore[] {
  refreshAdjacentRoomScoutReports(originRoomName, gameTime);
  return getAdjacentRoomNames(originRoomName)
    .flatMap((roomName) => {
      const report = getFreshRoomScoutReport(roomName, gameTime);
      return report ? [scoreRoomScoutReport(report)] : [];
    })
    .sort(compareRoomScoutScores);
}

export function scoreRoomScoutReport(report: RoomScoutReport): RoomScoutScore {
  const rationale: string[] = [];
  const sourceCount = normalizeNonNegativeInteger(report.sourceCount);
  let score = Math.round(report.terrain.plains / 10);
  rationale.push(`${report.terrain.plains} plains`);

  if (sourceCount > 0) {
    score += sourceCount * 250;
    rationale.push(`${sourceCount} sources`);
  }

  if (report.controller?.present === true) {
    score += 150;
    rationale.push('controller present');
  } else if (report.controller?.present === false) {
    score -= 250;
    rationale.push('controller missing');
  }

  if (report.owner === null) {
    score += 200;
    rationale.push('owner absent');
  } else if (isNonEmptyString(report.owner)) {
    score -= 1_000;
    rationale.push(`owned by ${report.owner}`);
  } else {
    rationale.push('owner unknown');
  }

  return {
    roomName: report.roomName,
    score,
    report,
    rationale
  };
}

export function getFreshRoomScoutReport(
  roomName: string,
  gameTime = getGameTime()
): RoomScoutReport | null {
  const report = getScoutReports()[roomName];
  if (!isRoomScoutReport(report)) {
    return null;
  }

  return isRoomScoutReportFresh(report, gameTime) ? report : null;
}

export function isRoomScoutReportFresh(
  report: Pick<RoomScoutReport, 'timestamp'>,
  gameTime = getGameTime()
): boolean {
  return gameTime < report.timestamp || gameTime - report.timestamp <= ROOM_SCOUT_REPORT_TTL;
}

export function getAdjacentRoomNames(roomName: string): string[] {
  if (!isNonEmptyString(roomName)) {
    return [];
  }

  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  if (!gameMap || typeof gameMap.describeExits !== 'function') {
    return [];
  }

  const exits = gameMap.describeExits(roomName) as ExitsInformation | null;
  if (!isRecord(exits)) {
    return [];
  }

  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const adjacentRoomName = exits[direction];
    return isNonEmptyString(adjacentRoomName) ? [adjacentRoomName] : [];
  });
}

function buildRoomScoutReport(
  roomName: string,
  gameTime: number,
  cachedReport: RoomScoutReport | null
): RoomScoutReport | null {
  const visibleRoom = getVisibleRoom(roomName);
  if (!visibleRoom) {
    return cachedReport
      ? buildUnseenCachedRoomScoutReport(roomName, cachedReport)
      : buildTerrainOnlyRoomScoutReport(roomName, gameTime);
  }

  const terrain = cachedReport?.terrain ?? summarizeRoomTerrain(roomName);
  if (!terrain) {
    return null;
  }

  return {
    roomName,
    terrain,
    timestamp: gameTime,
    visible: true,
    ...buildVisibleRoomScoutEvidence(visibleRoom)
  };
}

function buildTerrainOnlyRoomScoutReport(roomName: string, gameTime: number): RoomScoutReport | null {
  const terrain = summarizeRoomTerrain(roomName);
  if (!terrain) {
    return null;
  }

  return {
    roomName,
    terrain,
    timestamp: gameTime,
    visible: false
  };
}

function buildUnseenCachedRoomScoutReport(
  roomName: string,
  cachedReport: RoomScoutReport
): RoomScoutReport {
  const persistentReport: RoomScoutReport = { ...cachedReport };
  delete persistentReport.observerRequested;
  return {
    ...persistentReport,
    roomName,
    visible: false
  };
}

function buildVisibleRoomScoutEvidence(
  room: Room
): Pick<RoomScoutReport, 'controller' | 'owner' | 'sourceCount' | 'mineralType'> {
  const controller = summarizeController(room.controller);
  const mineral = findRoomObjects<Mineral>(room, 'FIND_MINERALS')[0];
  const mineralType = getMineralType(mineral);

  return {
    controller,
    owner: controller.ownerUsername ?? null,
    sourceCount: findRoomObjects<Source>(room, 'FIND_SOURCES').length,
    ...(mineralType ? { mineralType } : {})
  };
}

function summarizeController(controller: StructureController | undefined): RoomScoutController {
  if (!controller) {
    return {
      present: false,
      state: 'missing'
    };
  }

  const ownerUsername = getControllerOwnerUsername(controller);
  const reservationUsername = getControllerReservationUsername(controller);
  const reservationTicksToEnd = getControllerReservationTicksToEnd(controller);
  const state = ownerUsername
    ? 'owned'
    : reservationUsername
      ? 'reserved'
      : 'unreserved';

  return {
    present: true,
    state,
    ...(typeof controller.id === 'string' ? { id: controller.id as Id<StructureController> } : {}),
    ...(controller.my === true ? { my: true } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    ...(typeof reservationTicksToEnd === 'number' ? { reservationTicksToEnd } : {}),
    ...(typeof controller.level === 'number' ? { level: controller.level } : {})
  };
}

function summarizeRoomTerrain(roomName: string): RoomScoutTerrain | null {
  const terrain = getRoomTerrain(roomName);
  if (!terrain || typeof terrain.get !== 'function') {
    return null;
  }

  const wallMask = getTerrainMask('TERRAIN_MASK_WALL', DEFAULT_TERRAIN_WALL_MASK);
  const swampMask = getTerrainMask('TERRAIN_MASK_SWAMP', DEFAULT_TERRAIN_SWAMP_MASK);
  const counts: RoomScoutTerrain = { plains: 0, swamp: 0, wall: 0 };

  for (let x = TERRAIN_SCAN_MIN; x <= TERRAIN_SCAN_MAX; x += 1) {
    for (let y = TERRAIN_SCAN_MIN; y <= TERRAIN_SCAN_MAX; y += 1) {
      const mask = terrain.get(x, y);
      if ((mask & wallMask) !== 0) {
        counts.wall += 1;
      } else if ((mask & swampMask) !== 0) {
        counts.swamp += 1;
      } else {
        counts.plains += 1;
      }
    }
  }

  return counts;
}

function requestObserverScan(originRoom: Room | undefined, roomName: string): boolean {
  const observer = selectObserver(originRoom);
  if (!observer || typeof observer.observeRoom !== 'function') {
    return false;
  }

  return observer.observeRoom(roomName) === getOkCode();
}

function selectObserver(originRoom: Room | undefined): ObserverStructure | null {
  return findRoomObjects<ObserverStructure>(originRoom, 'FIND_MY_STRUCTURES').find(isObserverStructure) ?? null;
}

function isObserverStructure(structure: ObserverStructure | undefined): structure is ObserverStructure {
  return (
    structure !== undefined &&
    structure.structureType === getObserverStructureConstant() &&
    typeof structure.observeRoom === 'function'
  );
}

function pruneStaleScoutReports(
  scoutReports: Record<string, RoomScoutReportMemory>,
  gameTime: number
): void {
  for (const [roomName, report] of Object.entries(scoutReports)) {
    if (!isRoomScoutReport(report) || !isRoomScoutReportFresh(report, gameTime)) {
      delete scoutReports[roomName];
    }
  }
}

function getWritableIntelMemory(): IntelMemory | null {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return null;
  }

  if (!isRecord(memory.intel)) {
    memory.intel = {};
  }

  return memory.intel;
}

function getWritableScoutReports(memory: IntelMemory): Record<string, RoomScoutReportMemory> {
  if (!isRecord(memory.scoutReports)) {
    memory.scoutReports = {};
  }

  return memory.scoutReports;
}

function getScoutReports(): Record<string, unknown> {
  const reports = (globalThis as { Memory?: Partial<Memory> }).Memory?.intel?.scoutReports;
  return isRecord(reports) ? reports : {};
}

function isRoomScoutReport(value: unknown): value is RoomScoutReport {
  if (!isRecord(value) || !isNonEmptyString(value.roomName) || typeof value.timestamp !== 'number') {
    return false;
  }

  const terrain = value.terrain;
  return (
    isRecord(terrain) &&
    typeof terrain.plains === 'number' &&
    typeof terrain.swamp === 'number' &&
    typeof terrain.wall === 'number'
  );
}

function isReusableRoomScoutReport(
  roomName: string,
  value: unknown
): value is RoomScoutReport {
  return isRoomScoutReport(value) && value.roomName === roomName;
}

function compareRoomScoutScores(left: RoomScoutScore, right: RoomScoutScore): number {
  return (
    right.score - left.score ||
    normalizeNonNegativeInteger(right.report.sourceCount) - normalizeNonNegativeInteger(left.report.sourceCount) ||
    right.report.terrain.plains - left.report.terrain.plains ||
    left.roomName.localeCompare(right.roomName)
  );
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName];
}

function getRoomTerrain(roomName: string): RoomTerrain | null {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & { getRoomTerrain?: (roomName: string) => RoomTerrain })
    | undefined;
  return typeof gameMap?.getRoomTerrain === 'function' ? gameMap.getRoomTerrain(roomName) : null;
}

function findRoomObjects<T>(room: Room | undefined, constantName: FindConstantName): T[] {
  const findConstant = getFindConstant(constantName);
  if (!room || typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function getFindConstant(name: FindConstantName): number | undefined {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function getTerrainMask(name: TerrainMaskName, fallback: number): number {
  const value = (globalThis as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : fallback;
}

function getObserverStructureConstant(): string {
  const structureObserver = (globalThis as { STRUCTURE_OBSERVER?: string }).STRUCTURE_OBSERVER;
  return isNonEmptyString(structureObserver) ? structureObserver : 'observer';
}

function getOkCode(): ScreepsReturnCode {
  const ok = (globalThis as { OK?: ScreepsReturnCode }).OK;
  return typeof ok === 'number' ? ok : OK_CODE;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function getMineralType(mineral: Mineral | undefined): string | undefined {
  const mineralType = (mineral as Mineral & { mineralType?: unknown } | undefined)?.mineralType;
  return isNonEmptyString(mineralType) ? mineralType : undefined;
}

function getControllerOwnerUsername(controller: StructureController): string | undefined {
  const username = controller.owner?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationUsername(controller: StructureController): string | undefined {
  const username = (controller as StructureController & { reservation?: { username?: unknown } }).reservation
    ?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function getControllerReservationTicksToEnd(controller: StructureController): number | undefined {
  const ticksToEnd = (controller as StructureController & { reservation?: { ticksToEnd?: unknown } }).reservation
    ?.ticksToEnd;
  return typeof ticksToEnd === 'number' ? ticksToEnd : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
