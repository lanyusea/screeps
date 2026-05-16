import { ACTIVE_OFFICIAL_ROOM_SELECTION } from '../config/roomSelection';

export const DEFENDER_ROLE = 'defender';

const DEFENDER_BODY_PATTERN: BodyPartConstant[] = ['tough', 'attack', 'move'];
const DEFENDER_BODY_PATTERN_COST = 140;
const MAX_DEFENDER_BODY_PATTERN_COUNT = 5;
const HOSTILES_PER_DEFENDER = 3;
const MAX_CREEP_PARTS = 50;
export const SAFE_MODE_HOSTILE_COUNT_THRESHOLD = 2;
export const CRITICAL_SPAWN_LOSS_HITS_RATIO = 0.25;
export const TOWER_CONTROLLER_THREAT_RANGE = 3;
export const TOWER_STRUCTURE_THREAT_RANGE = 3;
export const BOOTSTRAP_DEFENSE_FLOOR_MIN_RCL = 2;
export const BOOTSTRAP_DEFENSE_FLOOR_MAX_TERRITORY_GATE_RCL = 3;
export const BOOTSTRAP_DEFENSE_FLOOR_MAX_SITES_PER_TICK = 2;
export const BOOTSTRAP_DEFENSE_FLOOR_REQUIRED_WALL_ANCHORS = 1;
export const BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING = 25_000;

export type DefenseTarget = Creep | Structure;
export type BootstrapDefenseFloorAnchorKind =
  | 'spawnRampart'
  | 'spawnWall'
  | 'controllerRampart'
  | 'towerRampart'
  | 'containerRampart';

export interface DefensePressureSummary {
  hostileCreepCount: number;
  hostileStructureCount: number;
  damagedCriticalStructureCount: number;
}

export interface DefenderSpawnPlanInput {
  roomName: string;
  hostileCreepCount: number;
  controllerUnderAttack?: boolean;
  activeDefenderCount: number;
  energyAvailable: number;
  gameTime: number;
  nameSuffix?: string;
}

export interface DefenderSpawnPlan {
  body: BodyPartConstant[];
  name: string;
  memory: CreepMemory;
}

export interface SafeModePlanInput {
  controller?: StructureController;
  hostileCreeps: Creep[];
  ownedSpawns: StructureSpawn[];
}

export interface TowerAttackTargetOptions {
  controller?: StructureController;
  protectedStructures?: Structure[];
}

export interface BootstrapDefenseFloorAnchor {
  kind: BootstrapDefenseFloorAnchorKind;
  priority: number;
  roomName: string;
  structureType: BuildableStructureConstant;
  x: number;
  y: number;
}

export interface BootstrapDefenseFloorAssessment {
  anchors: BootstrapDefenseFloorAnchor[];
  missingAnchors: BootstrapDefenseFloorAnchor[];
  ready: boolean;
  spawnRampartReady: boolean;
  requiredWallAnchorCount: number;
  wallAnchorCount: number;
}

export interface BootstrapDefenseFloorOptions {
  maxPlacements?: number;
}

export interface BootstrapDefenseFloorReadiness extends BootstrapDefenseFloorAssessment {
  assessable: boolean;
  anchorReady: boolean;
  pendingTowerCount: number;
  repairHitsCeiling: number;
  rcl: number;
  towerCount: number;
  towerReady: boolean;
}

interface CandidatePosition {
  x: number;
  y: number;
  roomName?: string;
}

interface BootstrapDefenseFloorLookups {
  structures: Structure[];
  constructionSites: ConstructionSite[];
  structuresByPosition: Map<string, Structure[]>;
  constructionSitesByPosition: Map<string, ConstructionSite[]>;
}

type FindConstantGlobal =
  | 'FIND_STRUCTURES'
  | 'FIND_CONSTRUCTION_SITES'
  | 'FIND_HOSTILE_CREEPS'
  | 'FIND_HOSTILE_STRUCTURES';
type StructureConstantGlobal =
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_RAMPART'
  | 'STRUCTURE_WALL'
  | 'STRUCTURE_TOWER';

const ROOM_EDGE_MIN = 1;
const ROOM_EDGE_MAX = 48;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const SPAWN_WALL_ANCHOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1]
];
const CONTROLLER_RAMPART_ANCHOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
];
const STRUCTURE_TYPE_FALLBACKS: Record<StructureConstantGlobal, string> = {
  STRUCTURE_SPAWN: 'spawn',
  STRUCTURE_CONTAINER: 'container',
  STRUCTURE_RAMPART: 'rampart',
  STRUCTURE_WALL: 'constructedWall',
  STRUCTURE_TOWER: 'tower'
};
let bootstrapDefenseFloorLookupCacheTick: number | null = null;
let bootstrapDefenseFloorLookupCache: WeakMap<Room, BootstrapDefenseFloorLookups> = new WeakMap();

export function hasDefensePressure(summary: DefensePressureSummary): boolean {
  return (
    normalizeNonNegativeInteger(summary.hostileCreepCount) > 0 ||
    normalizeNonNegativeInteger(summary.hostileStructureCount) > 0 ||
    normalizeNonNegativeInteger(summary.damagedCriticalStructureCount) > 0
  );
}

export function assessBootstrapDefenseFloor(room: Room): BootstrapDefenseFloorAssessment {
  const lookups = getBootstrapDefenseFloorLookups(room);
  const anchors = getBootstrapDefenseFloorAnchors(room, lookups);
  const coveredAnchorKeys = new Set<string>();
  const missingAnchors: BootstrapDefenseFloorAnchor[] = [];
  for (const anchor of anchors) {
    if (isDefenseAnchorCovered(anchor, lookups)) {
      coveredAnchorKeys.add(getDefenseAnchorKey(anchor));
    } else {
      missingAnchors.push(anchor);
    }
  }

  const spawnRampartReady = anchors.some(
    (anchor) => anchor.kind === 'spawnRampart' && coveredAnchorKeys.has(getDefenseAnchorKey(anchor))
  );
  const availableWallAnchors = anchors.filter((anchor) => anchor.kind === 'spawnWall').length;
  const requiredWallAnchors =
    availableWallAnchors === 0 ? 0 : BOOTSTRAP_DEFENSE_FLOOR_REQUIRED_WALL_ANCHORS;
  const wallAnchorCount = anchors.filter(
    (anchor) => anchor.kind === 'spawnWall' && coveredAnchorKeys.has(getDefenseAnchorKey(anchor))
  ).length;

  return {
    anchors,
    missingAnchors,
    ready:
      spawnRampartReady &&
      wallAnchorCount >= requiredWallAnchors,
    spawnRampartReady,
    requiredWallAnchorCount: requiredWallAnchors,
    wallAnchorCount
  };
}

export function assessBootstrapDefenseFloorReadiness(room: Room): BootstrapDefenseFloorReadiness {
  const rcl = getOwnedRoomRcl(room);
  const assessable = canAssessBootstrapDefenseFloor(room);
  if (!assessable || rcl < BOOTSTRAP_DEFENSE_FLOOR_MIN_RCL) {
    return {
      anchors: [],
      missingAnchors: [],
      ready: true,
      spawnRampartReady: true,
      requiredWallAnchorCount: 0,
      wallAnchorCount: 0,
      assessable,
      anchorReady: true,
      pendingTowerCount: 0,
      repairHitsCeiling: BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING,
      rcl,
      towerCount: 0,
      towerReady: true
    };
  }

  const anchorAssessment = assessBootstrapDefenseFloor(room);
  const lookups = getBootstrapDefenseFloorLookups(room);
  const towerCount = getOwnedStructuresByType<StructureTower>(room, lookups, 'STRUCTURE_TOWER').length;
  const pendingTowerCount = getConstructionSitesByType(room, lookups, 'STRUCTURE_TOWER').length;
  const towerReady = rcl !== 3 || towerCount > 0;
  const anchorReady = anchorAssessment.anchors.length === 0 || anchorAssessment.ready;

  return {
    ...anchorAssessment,
    ready: anchorReady && towerReady,
    assessable,
    anchorReady,
    pendingTowerCount,
    repairHitsCeiling: BOOTSTRAP_DEFENSE_FLOOR_REPAIR_HITS_CEILING,
    rcl,
    towerCount,
    towerReady
  };
}

export function planBootstrapDefenseFloorPlacements(
  room: Room,
  options: BootstrapDefenseFloorOptions = {}
): BootstrapDefenseFloorAnchor[] {
  if (getOwnedRoomRcl(room) < BOOTSTRAP_DEFENSE_FLOOR_MIN_RCL) {
    return [];
  }

  const maxPlacements = resolveNonNegativeInteger(
    options.maxPlacements,
    BOOTSTRAP_DEFENSE_FLOOR_MAX_SITES_PER_TICK
  );
  if (maxPlacements <= 0) {
    return [];
  }

  return assessBootstrapDefenseFloor(room).missingAnchors.slice(0, maxPlacements);
}

export function isBootstrapDefenseFloorReady(room: Room): boolean {
  return assessBootstrapDefenseFloor(room).ready;
}

export function isBootstrapDefenseFloorSatisfiedForTerritory(room: Room): boolean {
  if (!shouldGateTerritoryOnBootstrapDefenseFloor(room)) {
    return true;
  }

  return assessBootstrapDefenseFloorReadiness(room).ready;
}

export function shouldUseBootstrapDefenseFloorRepairCap(room: Room): boolean {
  return shouldGateTerritoryOnBootstrapDefenseFloor(room) && !hasVisibleHostilePresence(room);
}

export function buildDefenderBody(energyAvailable: number, hostileCount: number): BodyPartConstant[] {
  const desiredPatternCount = Math.max(
    1,
    Math.min(normalizeNonNegativeInteger(hostileCount), MAX_DEFENDER_BODY_PATTERN_COUNT)
  );
  const affordablePatternCount = Math.floor(
    normalizeNonNegativeInteger(energyAvailable) / DEFENDER_BODY_PATTERN_COST
  );
  const patternCount = Math.min(
    desiredPatternCount,
    affordablePatternCount,
    Math.floor(MAX_CREEP_PARTS / DEFENDER_BODY_PATTERN.length)
  );

  if (patternCount <= 0) {
    return [];
  }

  return Array.from({ length: patternCount }).flatMap(() => DEFENDER_BODY_PATTERN);
}

export function getDesiredDefenderCount(hostileCount: number): number {
  return Math.max(1, Math.ceil(normalizeNonNegativeInteger(hostileCount) / HOSTILES_PER_DEFENDER));
}

export function planDefenderSpawn(input: DefenderSpawnPlanInput): DefenderSpawnPlan | null {
  const hostileCreepCount = normalizeNonNegativeInteger(input.hostileCreepCount);
  const pressureCount = Math.max(hostileCreepCount, input.controllerUnderAttack === true ? 1 : 0);
  const activeDefenderCount = normalizeNonNegativeInteger(input.activeDefenderCount);

  if (pressureCount <= 0 || activeDefenderCount >= getDesiredDefenderCount(pressureCount)) {
    return null;
  }

  const body = buildDefenderBody(input.energyAvailable, pressureCount);
  if (body.length === 0) {
    return null;
  }

  const roomName = input.roomName;
  return {
    body,
    name: appendNameSuffix(`${DEFENDER_ROLE}-${roomName}-${input.gameTime}`, input.nameSuffix),
    memory: {
      role: DEFENDER_ROLE,
      colony: roomName,
      defense: { homeRoom: roomName }
    }
  };
}

export function selectTowerAttackTarget(
  origin: { pos?: RoomPosition },
  hostileCreeps: Creep[],
  hostileStructures: Structure[],
  options: TowerAttackTargetOptions = {}
): DefenseTarget | null {
  const controller = options.controller ?? (origin as { room?: Room }).room?.controller;
  const protectedStructures = options.protectedStructures ?? [];
  const sameRoomHostileCreeps = hostileCreeps.filter((hostile) => isTargetInOriginRoom(origin, hostile));

  return (
    selectClosestTarget(
      origin,
      sameRoomHostileCreeps.filter((hostile) => isHostileNearController(hostile, controller))
    ) ??
    selectClosestTarget(
      origin,
      sameRoomHostileCreeps.filter((hostile) => isHostileNearProtectedStructure(hostile, protectedStructures))
    ) ??
    selectClosestTarget(origin, sameRoomHostileCreeps) ??
    selectClosestTarget(origin, hostileStructures, { sameRoomOnly: true })
  );
}

export function selectDefenderAttackTarget(
  origin: { pos?: RoomPosition },
  hostileCreeps: Creep[],
  hostileStructures: Structure[]
): DefenseTarget | null {
  return selectClosestTarget(origin, hostileCreeps) ?? selectClosestTarget(origin, hostileStructures);
}

export function shouldActivateSafeMode(input: SafeModePlanInput): boolean {
  const controller = input.controller;
  if (
    input.hostileCreeps.length === 0 ||
    controller?.my !== true ||
    typeof controller.activateSafeMode !== 'function' ||
    !isSafeModeAvailable(controller)
  ) {
    return false;
  }

  if (isCriticalSpawnLossThreat(input.ownedSpawns, input.hostileCreeps)) {
    return true;
  }

  return (
    input.hostileCreeps.length > SAFE_MODE_HOSTILE_COUNT_THRESHOLD &&
    isControllerUnderAttack(controller, input.hostileCreeps)
  );
}

export function hasControllerAttackPressure(controller: StructureController | undefined): boolean {
  return (
    controller?.my === true &&
    typeof controller.upgradeBlocked === 'number' &&
    controller.upgradeBlocked > 0
  );
}

function selectClosestTarget<T extends { pos?: RoomPosition }>(
  origin: { pos?: RoomPosition },
  targets: T[],
  options: { sameRoomOnly?: boolean } = {}
): T | null {
  const eligibleTargets = options.sameRoomOnly
    ? targets.filter((target) => isTargetInOriginRoom(origin, target))
    : targets;
  if (eligibleTargets.length === 0) {
    return null;
  }

  return [...eligibleTargets].sort(
    (left, right) => compareRange(origin, left, right) || compareObjectIds(left, right)
  )[0];
}

function isTargetInOriginRoom(origin: { pos?: RoomPosition }, target: { pos?: RoomPosition }): boolean {
  if (!origin.pos || !target.pos) {
    return true;
  }

  return origin.pos.roomName === target.pos.roomName;
}

function isHostileNearController(
  hostile: { pos?: RoomPosition },
  controller: StructureController | undefined
): boolean {
  if (!controller?.pos || !hostile.pos || hostile.pos.roomName !== controller.pos.roomName) {
    return false;
  }

  return getRangeBetweenPositions(hostile.pos, controller.pos) <= TOWER_CONTROLLER_THREAT_RANGE;
}

function isHostileNearProtectedStructure(
  hostile: { pos?: RoomPosition },
  structures: Structure[]
): boolean {
  if (!hostile.pos) {
    return false;
  }

  return structures.some(
    (structure) =>
      structure.pos?.roomName === hostile.pos?.roomName &&
      getRangeBetweenPositions(hostile.pos as RoomPosition, structure.pos) <= TOWER_STRUCTURE_THREAT_RANGE
  );
}

function compareRange(
  origin: { pos?: RoomPosition },
  left: { pos?: RoomPosition },
  right: { pos?: RoomPosition }
): number {
  const getRangeTo = origin.pos?.getRangeTo;
  if (typeof getRangeTo !== 'function') {
    return 0;
  }

  const leftRange = left.pos ? getRangeTo.call(origin.pos, left.pos) : Infinity;
  const rightRange = right.pos ? getRangeTo.call(origin.pos, right.pos) : Infinity;
  return leftRange - rightRange;
}

function getRangeBetweenPositions(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function compareObjectIds(left: unknown, right: unknown): number {
  return getObjectId(left).localeCompare(getObjectId(right));
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  if (typeof candidate.name === 'string') {
    return candidate.name;
  }

  return '';
}

function appendNameSuffix(baseName: string, suffix: string | undefined): string {
  return suffix ? `${baseName}-${suffix}` : baseName;
}

function getBootstrapDefenseFloorAnchors(
  room: Room,
  lookups: BootstrapDefenseFloorLookups
): BootstrapDefenseFloorAnchor[] {
  if (getOwnedRoomRcl(room) < BOOTSTRAP_DEFENSE_FLOOR_MIN_RCL) {
    return [];
  }

  const anchors: BootstrapDefenseFloorAnchor[] = [];
  const spawn = selectPrimaryOwnedSpawn(room, lookups);
  if (!spawn?.pos) {
    return anchors;
  }

  const rampartStructureType = getStructureConstant('STRUCTURE_RAMPART');
  const wallStructureType = getStructureConstant('STRUCTURE_WALL');
  anchors.push({
    kind: 'spawnRampart',
    priority: 0,
    roomName: room.name,
    structureType: rampartStructureType,
    x: spawn.pos.x,
    y: spawn.pos.y
  });

  for (const position of selectSpawnWallAnchorPositions(room, spawn.pos, lookups)) {
    anchors.push({
      kind: 'spawnWall',
      priority: 1,
      roomName: room.name,
      structureType: wallStructureType,
      x: position.x,
      y: position.y
    });
  }

  for (const tower of getOwnedStructuresByType<StructureTower>(room, lookups, 'STRUCTURE_TOWER')) {
    anchors.push({
      kind: 'towerRampart',
      priority: 2,
      roomName: room.name,
      structureType: rampartStructureType,
      x: tower.pos.x,
      y: tower.pos.y
    });
  }

  const controllerAnchor = selectControllerRampartAnchorPosition(room, spawn.pos, lookups);
  if (controllerAnchor) {
    anchors.push({
      kind: 'controllerRampart',
      priority: 3,
      roomName: room.name,
      structureType: rampartStructureType,
      x: controllerAnchor.x,
      y: controllerAnchor.y
    });
  }

  for (const container of getOwnedOrNeutralStructuresByType<StructureContainer>(
    room,
    lookups,
    'STRUCTURE_CONTAINER'
  )) {
    anchors.push({
      kind: 'containerRampart',
      priority: 4,
      roomName: room.name,
      structureType: rampartStructureType,
      x: container.pos.x,
      y: container.pos.y
    });
  }

  return dedupeDefenseAnchors(anchors).sort(
    (left, right) =>
      left.priority - right.priority ||
      getRangeBetweenPositions(spawn.pos, left) - getRangeBetweenPositions(spawn.pos, right) ||
      getPositionKey(left).localeCompare(getPositionKey(right))
  );
}

function selectPrimaryOwnedSpawn(room: Room, lookups: BootstrapDefenseFloorLookups): StructureSpawn | null {
  const spawns = getOwnedStructuresByType<StructureSpawn>(room, lookups, 'STRUCTURE_SPAWN')
    .filter((spawn) => spawn.pos?.roomName === room.name)
    .sort((left, right) => getObjectId(left).localeCompare(getObjectId(right)));

  return spawns[0] ?? null;
}

export function shouldGateTerritoryOnBootstrapDefenseFloor(room: Room): boolean {
  const rcl = getOwnedRoomRcl(room);
  if (
    rcl < BOOTSTRAP_DEFENSE_FLOOR_MIN_RCL ||
    rcl > BOOTSTRAP_DEFENSE_FLOOR_MAX_TERRITORY_GATE_RCL ||
    !canAssessBootstrapDefenseFloor(room) ||
    room.name !== ACTIVE_OFFICIAL_ROOM_SELECTION.roomName
  ) {
    return false;
  }

  return hasActiveOfficialSpawn(room, getBootstrapDefenseFloorLookups(room));
}

function hasActiveOfficialSpawn(room: Room, lookups: BootstrapDefenseFloorLookups): boolean {
  const expectedSpawn = ACTIVE_OFFICIAL_ROOM_SELECTION.spawn;
  return getOwnedStructuresByType<StructureSpawn>(room, lookups, 'STRUCTURE_SPAWN')
    .some((spawn) => (
      spawn.pos?.roomName === room.name &&
      spawn.pos.x === expectedSpawn.x &&
      spawn.pos.y === expectedSpawn.y
    ));
}

function selectSpawnWallAnchorPositions(
  room: Room,
  spawnPosition: RoomPosition,
  lookups: BootstrapDefenseFloorLookups
): CandidatePosition[] {
  const positions: CandidatePosition[] = [];
  for (const [dx, dy] of SPAWN_WALL_ANCHOR_OFFSETS) {
    const position = {
      x: spawnPosition.x + dx,
      y: spawnPosition.y + dy,
      roomName: room.name
    };
    if (canPlaceWallAnchor(room, position, lookups)) {
      positions.push(position);
    }
  }

  return positions.slice(0, BOOTSTRAP_DEFENSE_FLOOR_REQUIRED_WALL_ANCHORS + 1);
}

function selectControllerRampartAnchorPosition(
  room: Room,
  spawnPosition: RoomPosition,
  lookups: BootstrapDefenseFloorLookups
): CandidatePosition | null {
  const controllerPosition = room.controller?.pos;
  if (!controllerPosition || controllerPosition.roomName !== room.name) {
    return null;
  }

  return CONTROLLER_RAMPART_ANCHOR_OFFSETS
    .map(([dx, dy]) => ({
      x: controllerPosition.x + dx,
      y: controllerPosition.y + dy,
      roomName: room.name
    }))
    .filter((position) => canPlaceRampartAnchor(room, position, lookups))
    .sort(
      (left, right) =>
        getRangeBetweenPositions(spawnPosition, left) - getRangeBetweenPositions(spawnPosition, right) ||
        getPositionKey(left).localeCompare(getPositionKey(right))
    )[0] ?? null;
}

function canPlaceWallAnchor(
  room: Room,
  position: CandidatePosition,
  lookups: BootstrapDefenseFloorLookups
): boolean {
  return isBuildableAnchorPosition(room, position) && !hasWallAnchorBlockerAtPosition(lookups, position);
}

function canPlaceRampartAnchor(
  room: Room,
  position: CandidatePosition,
  lookups: BootstrapDefenseFloorLookups
): boolean {
  return (
    isBuildableAnchorPosition(room, position) &&
    !hasRampartAnchorBlockerAtPosition(lookups, position)
  );
}

function isBuildableAnchorPosition(room: Room, position: CandidatePosition): boolean {
  return (
    position.x >= ROOM_EDGE_MIN &&
    position.x <= ROOM_EDGE_MAX &&
    position.y >= ROOM_EDGE_MIN &&
    position.y <= ROOM_EDGE_MAX &&
    !isTerrainWall(room, position)
  );
}

function hasWallAnchorBlockerAtPosition(
  lookups: BootstrapDefenseFloorLookups,
  position: CandidatePosition
): boolean {
  return (
    getStructuresAtPosition(lookups, position).length > 0 ||
    getConstructionSitesAtPosition(lookups, position).length > 0
  );
}

function hasRampartAnchorBlockerAtPosition(
  lookups: BootstrapDefenseFloorLookups,
  position: CandidatePosition
): boolean {
  return (
    getStructuresAtPosition(lookups, position).some(isRampartBlockingStructure) ||
    getConstructionSitesAtPosition(lookups, position).some((site) => !isRampartConstructionSite(site))
  );
}

function isRampartBlockingStructure(structure: Structure): boolean {
  return isStructureType(structure.structureType, 'STRUCTURE_WALL');
}

function isRampartConstructionSite(site: ConstructionSite): boolean {
  return isStructureType(site.structureType, 'STRUCTURE_RAMPART');
}

function isDefenseAnchorCovered(
  anchor: BootstrapDefenseFloorAnchor,
  lookups: BootstrapDefenseFloorLookups
): boolean {
  return [
    ...getStructuresAtPosition(lookups, anchor),
    ...getConstructionSitesAtPosition(lookups, anchor)
  ].some(
    (object) =>
      object.structureType === anchor.structureType &&
      isSamePosition(object.pos, anchor)
  );
}

function getOwnedStructuresByType<T extends Structure>(
  room: Room,
  lookups: BootstrapDefenseFloorLookups,
  structureGlobal: StructureConstantGlobal
): T[] {
  const structureType = getStructureConstant(structureGlobal);
  return lookups.structures
    .filter(
      (structure) =>
        structure.structureType === structureType &&
        isPositionInRoom(structure.pos, room.name) &&
        isOwnedStructure(structure)
    ) as T[];
}

function getOwnedOrNeutralStructuresByType<T extends Structure>(
  room: Room,
  lookups: BootstrapDefenseFloorLookups,
  structureGlobal: StructureConstantGlobal
): T[] {
  const structureType = getStructureConstant(structureGlobal);
  return lookups.structures
    .filter((structure) => structure.structureType === structureType && isPositionInRoom(structure.pos, room.name)) as T[];
}

function getBootstrapDefenseFloorLookups(room: Room): BootstrapDefenseFloorLookups {
  const gameTime = getGameTime();
  if (gameTime === null) {
    return createBootstrapDefenseFloorLookups(room);
  }

  if (bootstrapDefenseFloorLookupCacheTick !== gameTime) {
    bootstrapDefenseFloorLookupCacheTick = gameTime;
    bootstrapDefenseFloorLookupCache = new WeakMap();
  }

  const cached = bootstrapDefenseFloorLookupCache.get(room);
  if (cached) {
    return cached;
  }

  const lookups = createBootstrapDefenseFloorLookups(room);
  bootstrapDefenseFloorLookupCache.set(room, lookups);
  return lookups;
}

function canAssessBootstrapDefenseFloor(room: Room): boolean {
  return (
    typeof room.find === 'function' &&
    getGlobalNumber('FIND_STRUCTURES') !== null &&
    getGlobalNumber('FIND_CONSTRUCTION_SITES') !== null
  );
}

function hasVisibleHostilePresence(room: Room): boolean {
  return (
    findRoomObjects<Creep>(room, 'FIND_HOSTILE_CREEPS').length > 0 ||
    findRoomObjects<Structure>(room, 'FIND_HOSTILE_STRUCTURES').length > 0
  );
}

function createBootstrapDefenseFloorLookups(room: Room): BootstrapDefenseFloorLookups {
  const structures = findRoomObjects<Structure>(room, 'FIND_STRUCTURES')
    .filter((structure) => isPositionInRoom(structure.pos, room.name));
  const constructionSites = findRoomObjects<ConstructionSite>(room, 'FIND_CONSTRUCTION_SITES')
    .filter((site) => isPositionInRoom(site.pos, room.name));

  return {
    structures,
    constructionSites,
    structuresByPosition: groupObjectsByPosition(structures),
    constructionSitesByPosition: groupObjectsByPosition(constructionSites)
  };
}

function groupObjectsByPosition<T extends { pos?: CandidatePosition }>(objects: T[]): Map<string, T[]> {
  const objectsByPosition = new Map<string, T[]>();
  for (const object of objects) {
    if (!object.pos) {
      continue;
    }

    const key = getPositionKey(object.pos);
    const existing = objectsByPosition.get(key);
    if (existing) {
      existing.push(object);
    } else {
      objectsByPosition.set(key, [object]);
    }
  }

  return objectsByPosition;
}

function getStructuresAtPosition(
  lookups: BootstrapDefenseFloorLookups,
  position: CandidatePosition
): Structure[] {
  return lookups.structuresByPosition.get(getPositionKey(position)) ?? [];
}

function getConstructionSitesAtPosition(
  lookups: BootstrapDefenseFloorLookups,
  position: CandidatePosition
): ConstructionSite[] {
  return lookups.constructionSitesByPosition.get(getPositionKey(position)) ?? [];
}

function getConstructionSitesByType<T extends ConstructionSite>(
  room: Room,
  lookups: BootstrapDefenseFloorLookups,
  structureGlobal: StructureConstantGlobal
): T[] {
  const structureType = getStructureConstant(structureGlobal);
  return lookups.constructionSites
    .filter((site) => site.structureType === structureType && isPositionInRoom(site.pos, room.name)) as T[];
}

function isStructureType(
  structureType: StructureConstant | BuildableStructureConstant | undefined,
  structureGlobal: StructureConstantGlobal
): boolean {
  return structureType === getStructureConstant(structureGlobal);
}

function isOwnedStructure(structure: Structure): boolean {
  const ownership = structure as Structure & { my?: unknown; owner?: unknown };
  if (ownership.my === true) {
    return true;
  }
  if (ownership.my === false) {
    return false;
  }

  return ownership.owner === undefined;
}

function findRoomObjects<T>(room: Room, globalName: FindConstantGlobal): T[] {
  const findConstant = getGlobalNumber(globalName);
  if (findConstant === null || typeof room.find !== 'function') {
    return [];
  }

  try {
    const found = room.find(findConstant as FindConstant);
    return Array.isArray(found) ? (found as T[]) : [];
  } catch {
    return [];
  }
}

function dedupeDefenseAnchors(anchors: BootstrapDefenseFloorAnchor[]): BootstrapDefenseFloorAnchor[] {
  const seen = new Set<string>();
  const deduped: BootstrapDefenseFloorAnchor[] = [];
  for (const anchor of anchors) {
    const key = getDefenseAnchorKey(anchor);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(anchor);
  }

  return deduped;
}

function getOwnedRoomRcl(room: Room): number {
  const level = room.controller?.my === true ? room.controller.level : 0;
  return typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.min(8, Math.floor(level))) : 0;
}

function getGameTime(): number | null {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? Math.floor(time) : null;
}

function getStructureConstant(globalName: StructureConstantGlobal): BuildableStructureConstant {
  const value = (globalThis as unknown as Partial<Record<StructureConstantGlobal, BuildableStructureConstant>>)[globalName];
  return (value ?? STRUCTURE_TYPE_FALLBACKS[globalName]) as BuildableStructureConstant;
}

function getGlobalNumber(globalName: FindConstantGlobal): number | null {
  const value = (globalThis as Record<string, unknown>)[globalName];
  return typeof value === 'number' ? value : null;
}

function isTerrainWall(room: Room, position: CandidatePosition): boolean {
  const terrain = (globalThis as { Game?: Partial<Game> }).Game?.map?.getRoomTerrain?.(room.name);
  return terrain !== undefined && (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}

function getTerrainWallMask(): number {
  const value = (globalThis as { TERRAIN_MASK_WALL?: unknown }).TERRAIN_MASK_WALL;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : DEFAULT_TERRAIN_WALL_MASK;
}

function isSamePosition(left: CandidatePosition | undefined, right: CandidatePosition): boolean {
  return (
    left !== undefined &&
    left.x === right.x &&
    left.y === right.y &&
    (left.roomName === undefined || right.roomName === undefined || left.roomName === right.roomName)
  );
}

function isPositionInRoom(position: CandidatePosition | undefined, roomName: string): boolean {
  return position !== undefined && (position.roomName === undefined || position.roomName === roomName);
}

function getDefenseAnchorKey(anchor: BootstrapDefenseFloorAnchor): string {
  return `${anchor.structureType}:${getPositionKey(anchor)}`;
}

function getPositionKey(position: CandidatePosition): string {
  return `${position.roomName ?? ''}:${position.x},${position.y}`;
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isSafeModeAvailable(controller: StructureController): boolean {
  const available = controller.safeModeAvailable;
  const cooldown = controller.safeModeCooldown;
  const active = controller.safeMode;

  return (
    typeof available === 'number' &&
    available > 0 &&
    (typeof cooldown !== 'number' || cooldown <= 0) &&
    (typeof active !== 'number' || active <= 0)
  );
}

function isCriticalSpawnLossThreat(ownedSpawns: StructureSpawn[], hostileCreeps: Creep[]): boolean {
  if (hostileCreeps.length === 0) {
    return false;
  }

  return ownedSpawns.length === 0 || ownedSpawns.some(isCriticallyDamagedSpawn);
}

function isControllerUnderAttack(controller: StructureController, hostileCreeps: Creep[]): boolean {
  if (hasControllerAttackPressure(controller)) {
    return true;
  }

  if (!controller.pos) {
    return false;
  }

  return hostileCreeps.some((hostile) => {
    if (!hostile.pos || hostile.pos.roomName !== controller.pos.roomName) {
      return false;
    }

    const range = controller.pos.getRangeTo?.(hostile.pos);
    return typeof range !== 'number' || range <= 3;
  });
}

function isCriticallyDamagedSpawn(spawn: StructureSpawn): boolean {
  return (
    typeof spawn.hits === 'number' &&
    typeof spawn.hitsMax === 'number' &&
    spawn.hitsMax > 0 &&
    spawn.hits < spawn.hitsMax * CRITICAL_SPAWN_LOSS_HITS_RATIO
  );
}
