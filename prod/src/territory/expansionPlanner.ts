import type { ColonySnapshot } from '../colony/colonyRegistry';
import { TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY } from './autoClaim';
import { maxRoomsForRcl } from './expansionScoring';
import { normalizeTerritoryIntents } from './territoryMemoryUtils';

export const EXPANSION_PLANNER_MIN_SOURCE_COUNT = 2;
export const EXPANSION_PLANNER_MAX_ROUTE_DISTANCE = 2;

const EXIT_DIRECTION_ORDER = ['1', '3', '5', '7'];
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const SOURCE_SCORE_WEIGHT = 1_000;
const DISTANCE_SCORE_WEIGHT = 100;
const DIRECT_ADJACENCY_SCORE_BONUS = 1_500;
const NEARBY_ADJACENCY_SCORE_BONUS = 500;
export const EXPANSION_PLANNER_TARGET_CREATOR = 'expansionPlanner';
export const EXPANSION_TOWER_DEFAULT_MAX_PLACEMENTS = 6;
export const EXPANSION_DEFENSE_BARRIER_DEFAULT_MAX_PLACEMENTS = 24;

const EXPANSION_TOWER_ROOM_EDGE_MIN = 1;
const EXPANSION_TOWER_ROOM_EDGE_MAX = 48;
const EXPANSION_TOWER_SPAWN_WEIGHT = 10;
const EXPANSION_TOWER_CONTROLLER_WEIGHT = 8;
const EXPANSION_TOWER_CONTAINER_WEIGHT = 4;
const EXPANSION_TOWER_SOURCE_WEIGHT = 2;
const EXPANSION_TOWER_ROAD_WEIGHT = 1;
const EXPANSION_TOWER_ENTRANCE_WEIGHT = 1;
const EXPANSION_TOWER_MAX_ROAD_ANCHORS = 12;
const EXPANSION_DEFENSE_BARRIER_MAX_CORE_RAMPARTS = 16;
const DEFAULT_TERRAIN_WALL_MASK = 1;
const EXPANSION_PLANNER_THREAT_MEMORY_STALE_TICKS = 5;

type TerminalExpansionIntentStatus = Extract<TerritoryIntentMemory['status'], 'inactive' | 'completed'>;

export type ExpansionRoomUnsuitableReason =
  | 'sourceCountBelowMinimum'
  | 'hostilePresence'
  | 'controllerMissing'
  | 'controllerOwned'
  | 'controllerReserved';

export type ExpansionPlannerSkipReason = 'existingTerritoryPlan' | 'memoryUnavailable' | 'noCandidate';

export interface ExpansionRoomSuitability {
  suitable: boolean;
  sourceCount: number;
  hostileCreepCount: number;
  hostileStructureCount: number;
  reasons: ExpansionRoomUnsuitableReason[];
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
}

export interface ExpansionPlannerCandidateInput {
  colony: string;
  roomName: string;
  distance: number;
  sourceCount: number;
  order?: number;
  adjacencyBonus?: number;
  hostileCreepCount?: number;
  hostileStructureCount?: number;
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
}

export interface ExpansionPlannerCandidate extends ExpansionRoomSuitability {
  colony: string;
  roomName: string;
  distance: number;
  order: number;
  adjacencyBonus?: number;
  score: number;
}

export interface ExpansionPlannerIntent {
  colony: string;
  targetRoom: string;
  action: TerritoryControlAction;
  score: number;
  controllerId?: Id<StructureController>;
}

export interface ExpansionPlannerEvaluation {
  status: 'planned' | 'skipped';
  colony: string;
  candidates: ExpansionPlannerCandidate[];
  reason?: ExpansionPlannerSkipReason;
  targetRoom?: string;
  action?: TerritoryControlAction;
  score?: number;
  controllerId?: Id<StructureController>;
}

export interface ExpansionPlannerClaimRecommendation {
  colony: string;
  targetRoom: string;
  action: 'claim';
  createdBy: typeof EXPANSION_PLANNER_TARGET_CREATOR;
  status: Extract<TerritoryIntentMemory['status'], 'planned' | 'active'>;
  updatedAt?: number;
  controllerId?: Id<StructureController>;
}

export interface ExpansionPlannerReservationRecommendation {
  colony: string;
  targetRoom: string;
  action: 'reserve';
  createdBy: typeof EXPANSION_PLANNER_TARGET_CREATOR;
  status: Extract<TerritoryIntentMemory['status'], 'planned' | 'active'>;
  updatedAt?: number;
  controllerId?: Id<StructureController>;
}

interface ExpansionReservationUpgradeContext {
  colony: string;
  targetRoom: string;
  action: TerritoryControlAction;
}

export type ExpansionTowerPlacementAnchorKind =
  | 'spawn'
  | 'controller'
  | 'container'
  | 'road'
  | 'source'
  | 'entrance';

export interface ExpansionTowerPlacementOptions {
  maxPlacements?: number;
}

export interface ExpansionTowerPlacement {
  roomName: string;
  x: number;
  y: number;
  score: number;
  spawnRange?: number;
  controllerRange?: number;
  nearestContainerRange?: number;
  nearestRoadRange?: number;
  nearestSourceRange?: number;
  nearestEntranceRange?: number;
}

export type ExpansionDefenseBarrierPlacementStage =
  | 'towerRampart'
  | 'coreRampart'
  | 'entranceRampart'
  | 'entranceWall';

export interface ExpansionDefenseBarrierPlacementOptions {
  maxPlacements?: number;
}

export interface ExpansionDefenseBarrierPlacement {
  roomName: string;
  x: number;
  y: number;
  structureType: BuildableStructureConstant;
  stage: ExpansionDefenseBarrierPlacementStage;
  priority: number;
}

interface ExpansionTowerAnchor {
  kind: ExpansionTowerPlacementAnchorKind;
  position: RoomPositionLike;
  weight: number;
}

interface RoomPositionLike {
  x: number;
  y: number;
  roomName?: string;
}

interface ExpansionTowerPlacementLookups {
  terrain: RoomTerrain | null;
  blockedPositions: Set<string>;
  anchors: ExpansionTowerAnchor[];
}

interface ExpansionDefenseBarrierPlacementLookups {
  terrain: RoomTerrain | null;
  reservedPositions: Set<string>;
  structuresByPosition: Map<string, AnyStructure[]>;
  constructionSitesByPosition: Map<string, ConstructionSite[]>;
}

interface ExitGroup {
  side: 'top' | 'right' | 'bottom' | 'left';
  positions: RoomPositionLike[];
}

export function evaluateExpansionRoomSuitability(
  room: Room,
  colonyOwnerUsername?: string
): ExpansionRoomSuitability {
  const ownerUsername = getControllerOwnerUsername(room.controller);
  const reservationUsername = getControllerReservationUsername(room.controller);
  return evaluateExpansionSuitability({
    sourceCount: findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES')).length,
    hostileCreepCount: findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length,
    hostileStructureCount: findRoomObjects<AnyStructure>(
      room,
      getFindConstant('FIND_HOSTILE_STRUCTURES')
    ).length,
    ...(room.controller?.id ? { controllerId: room.controller.id } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {}),
    ...(colonyOwnerUsername ? { colonyOwnerUsername } : {}),
    hasController: room.controller !== undefined
  });
}

export function evaluateExpansionCandidate(
  candidate: ExpansionPlannerCandidateInput
): ExpansionPlannerCandidate {
  const suitability = evaluateExpansionSuitability({
    sourceCount: candidate.sourceCount,
    hostileCreepCount: candidate.hostileCreepCount ?? 0,
    hostileStructureCount: candidate.hostileStructureCount ?? 0,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {}),
    ...(candidate.ownerUsername ? { ownerUsername: candidate.ownerUsername } : {}),
    ...(candidate.reservationUsername ? { reservationUsername: candidate.reservationUsername } : {}),
    hasController:
      candidate.controllerId !== undefined ||
      candidate.ownerUsername !== undefined ||
      candidate.reservationUsername !== undefined
  });
  const order = normalizeNonNegativeInteger(candidate.order ?? 0);
  const distance = Math.max(1, normalizeNonNegativeInteger(candidate.distance));
  const adjacencyBonus = normalizeExpansionPlannerAdjacencyBonus(candidate.adjacencyBonus, distance);

  return {
    colony: candidate.colony,
    roomName: candidate.roomName,
    distance,
    order,
    adjacencyBonus,
    score: scoreExpansionPlannerCandidate(suitability.sourceCount, distance, adjacencyBonus),
    ...suitability
  };
}

export function prioritizeExpansionCandidates(
  candidates: ExpansionPlannerCandidateInput[]
): ExpansionPlannerCandidate[] {
  return dedupeExpansionPlannerCandidates(
    candidates
      .map(evaluateExpansionCandidate)
      .filter((candidate) => candidate.suitable)
  ).sort(compareExpansionPlannerCandidates);
}

export function buildRuntimeExpansionPlannerCandidates(
  colony: ColonySnapshot
): ExpansionPlannerCandidate[] {
  const colonyName = colony.room.name;
  const rooms = getGameRooms();
  if (!rooms) {
    return [];
  }

  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomNames = getVisibleOwnedRoomNames(colonyName, ownerUsername);
  const candidates: ExpansionPlannerCandidate[] = [];
  let order = 0;

  for (const ownedRoomName of ownedRoomNames) {
    for (const adjacentRoomName of getAdjacentRoomNames(ownedRoomName)) {
      if (ownedRoomNames.has(adjacentRoomName)) {
        continue;
      }

      const room = rooms[adjacentRoomName];
      if (!room) {
        continue;
      }

      candidates.push(
        toRuntimeExpansionPlannerCandidate(
          colonyName,
          room,
          1,
          order,
          ownerUsername,
          getExpansionPlannerAdjacencyBonus(1)
        )
      );
      order += 1;
    }
  }

  for (const room of Object.values(rooms)) {
    if (
      !room ||
      !isNonEmptyString(room.name) ||
      room.name === colonyName ||
      ownedRoomNames.has(room.name)
    ) {
      continue;
    }

    const distance = getNearestOwnedRoomDistance(ownedRoomNames, room.name);
    if (distance === null || distance > EXPANSION_PLANNER_MAX_ROUTE_DISTANCE) {
      continue;
    }

    candidates.push(
      toRuntimeExpansionPlannerCandidate(
        colonyName,
        room,
        distance,
        order,
        ownerUsername,
        getExpansionPlannerAdjacencyBonus(distance)
      )
    );
    order += 1;
  }

  return dedupeExpansionPlannerCandidates(
    candidates.filter((candidate) => candidate.suitable)
  ).sort(compareExpansionPlannerCandidates);
}

export function refreshExpansionPlannerIntent(
  colony: ColonySnapshot,
  gameTime = getGameTime()
): ExpansionPlannerEvaluation {
  const colonyName = colony.room.name;
  if (!getMemoryRecord()) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'memoryUnavailable',
      candidates: []
    };
  }

  const territoryMemory = getTerritoryMemoryRecord();
  if (territoryMemory) {
    refreshTerminalExpansionPlans(territoryMemory, colonyName, gameTime);
  }

  const potentialReservationUpgradeRooms = territoryMemory
    ? getPotentialExpansionReservationUpgradeRooms(territoryMemory, colonyName)
    : new Set<string>();
  if (potentialReservationUpgradeRooms === null) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'existingTerritoryPlan',
      candidates: []
    };
  }

  const candidates = buildRuntimeExpansionPlannerCandidates(colony);
  const selectedAction = candidates.length > 0 ? selectExpansionIntentAction(colony) : null;
  const preferredUpgradeCandidates =
    selectedAction === 'claim' && potentialReservationUpgradeRooms.size > 0
      ? candidates.filter((candidate) => potentialReservationUpgradeRooms.has(candidate.roomName))
      : [];
  const candidate =
    preferredUpgradeCandidates.length > 0 ? preferredUpgradeCandidates[0] : candidates[0];
  const action = candidate ? selectedAction : null;
  const reservationUpgrade = candidate && action ? getExpansionReservationUpgradeContext(candidate, action) : null;

  if (territoryMemory && hasBlockingTerritoryPlan(territoryMemory, colonyName, reservationUpgrade)) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'existingTerritoryPlan',
      candidates: []
    };
  }

  if (!candidate || !action) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'noCandidate',
      candidates
    };
  }

  const intent = createExpansionIntent(candidate, action, gameTime);
  if (!intent) {
    return {
      status: 'skipped',
      colony: colonyName,
      reason: 'memoryUnavailable',
      candidates
    };
  }

  return {
    status: 'planned',
    colony: colonyName,
    candidates,
    targetRoom: intent.targetRoom,
    action: intent.action,
    score: intent.score,
    ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
  };
}

export function getExpansionPlannerClaimRecommendations(
  colony?: string
): ExpansionPlannerClaimRecommendation[] {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return [];
  }

  const recommendations = new Map<string, ExpansionPlannerClaimRecommendation>();
  const blockedKeys = new Set<string>();
  for (const intent of normalizeTerritoryIntents(territoryMemory.intents)) {
    if (!isExpansionPlannerClaimIntentForColony(intent, colony)) {
      continue;
    }

    const key = getExpansionPlanKey(intent.colony, intent.targetRoom, 'claim');
    if (!isRunnableExpansionPlannerClaimStatus(intent.status)) {
      blockedKeys.add(key);
      recommendations.delete(key);
      continue;
    }

    recommendations.set(key, {
      colony: intent.colony,
      targetRoom: intent.targetRoom,
      action: 'claim',
      createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
      status: intent.status,
      updatedAt: intent.updatedAt,
      ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
    });
  }

  if (Array.isArray(territoryMemory.targets)) {
    for (const rawTarget of territoryMemory.targets) {
      const target = normalizeTerritoryTarget(rawTarget);
      if (!isExpansionPlannerClaimTargetForColony(target, colony)) {
        continue;
      }

      const key = getExpansionPlanKey(target.colony, target.roomName, 'claim');
      if (blockedKeys.has(key) || recommendations.has(key)) {
        continue;
      }

      recommendations.set(key, {
        colony: target.colony,
        targetRoom: target.roomName,
        action: 'claim',
        createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
        status: 'planned',
        ...(target.controllerId ? { controllerId: target.controllerId } : {})
      });
    }
  }

  return Array.from(recommendations.values()).sort(compareExpansionPlannerClaimRecommendations);
}

export function getExpansionPlannerReservationRecommendations(
  colony?: string
): ExpansionPlannerReservationRecommendation[] {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return [];
  }

  const recommendations = new Map<string, ExpansionPlannerReservationRecommendation>();
  const blockedKeys = new Set<string>();
  for (const intent of normalizeTerritoryIntents(territoryMemory.intents)) {
    if (!isExpansionPlannerReservationIntentForColony(intent, colony)) {
      continue;
    }

    const key = getExpansionPlanKey(intent.colony, intent.targetRoom, 'reserve');
    if (!isRunnableExpansionPlannerControlStatus(intent.status)) {
      blockedKeys.add(key);
      recommendations.delete(key);
      continue;
    }

    recommendations.set(key, {
      colony: intent.colony,
      targetRoom: intent.targetRoom,
      action: 'reserve',
      createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
      status: intent.status,
      updatedAt: intent.updatedAt,
      ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
    });
  }

  if (Array.isArray(territoryMemory.targets)) {
    for (const rawTarget of territoryMemory.targets) {
      const target = normalizeTerritoryTarget(rawTarget);
      if (!isExpansionPlannerReservationTargetForColony(target, colony)) {
        continue;
      }

      const key = getExpansionPlanKey(target.colony, target.roomName, 'reserve');
      if (blockedKeys.has(key) || recommendations.has(key)) {
        continue;
      }

      recommendations.set(key, {
        colony: target.colony,
        targetRoom: target.roomName,
        action: 'reserve',
        createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
        status: 'planned',
        ...(target.controllerId ? { controllerId: target.controllerId } : {})
      });
    }
  }

  return Array.from(recommendations.values()).sort(compareExpansionPlannerReservationRecommendations);
}

export function createExpansionIntent(
  candidate: ExpansionPlannerCandidate,
  action: TerritoryControlAction,
  gameTime = getGameTime()
): ExpansionPlannerIntent | null {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = findExpansionIntent(intents, candidate.colony, candidate.roomName, action);
  const existingTarget = findExpansionTarget(territoryMemory, candidate.colony, candidate.roomName, action);
  const terminalStatus = getCandidateTerminalExpansionStatus(candidate, action, existingIntent);
  if (terminalStatus && (existingIntent || existingTarget)) {
    persistTerminalExpansionPlan(
      territoryMemory,
      intents,
      {
        colony: candidate.colony,
        roomName: candidate.roomName,
        action,
        createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
        ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
      },
      terminalStatus,
      gameTime
    );
    return null;
  }

  if (!candidate.suitable) {
    return null;
  }

  if (action === 'claim') {
    removeSupersededExpansionReservationPlan(territoryMemory, intents, candidate.colony, candidate.roomName);
    disableLowerPriorityExpansionClaimPlans(territoryMemory, intents, candidate, gameTime);
  }

  const target: TerritoryTargetMemory = {
    colony: candidate.colony,
    roomName: candidate.roomName,
    action,
    createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
  upsertTerritoryTarget(territoryMemory, target);

  upsertTerritoryIntent(intents, {
    colony: candidate.colony,
    targetRoom: candidate.roomName,
    action,
    status: existingIntent?.status === 'active' ? 'active' : 'planned',
    updatedAt: gameTime,
    createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  });

  return {
    colony: candidate.colony,
    targetRoom: candidate.roomName,
    action,
    score: candidate.score,
    ...(candidate.controllerId ? { controllerId: candidate.controllerId } : {})
  };
}

export function planExpansionTowerPlacements(
  room: Room,
  options: ExpansionTowerPlacementOptions = {}
): ExpansionTowerPlacement[] {
  if (!isNonEmptyString(room.name)) {
    return [];
  }

  const lookups = createExpansionTowerPlacementLookups(room);
  if (lookups.anchors.length === 0) {
    return [];
  }

  const placements: ExpansionTowerPlacement[] = [];
  for (let y = EXPANSION_TOWER_ROOM_EDGE_MIN; y <= EXPANSION_TOWER_ROOM_EDGE_MAX; y += 1) {
    for (let x = EXPANSION_TOWER_ROOM_EDGE_MIN; x <= EXPANSION_TOWER_ROOM_EDGE_MAX; x += 1) {
      const position = { x, y, roomName: room.name };
      if (!canPlaceExpansionTower(lookups, position)) {
        continue;
      }

      placements.push(scoreExpansionTowerPlacement(position, lookups.anchors, room.name));
    }
  }

  return placements
    .sort(compareExpansionTowerPlacements)
    .slice(0, getExpansionTowerMaxPlacements(options.maxPlacements));
}

export function planExpansionDefenseBarrierPlacements(
  room: Room,
  options: ExpansionDefenseBarrierPlacementOptions = {}
): ExpansionDefenseBarrierPlacement[] {
  if (!isNonEmptyString(room.name)) {
    return [];
  }

  const lookups = createExpansionDefenseBarrierPlacementLookups(room);
  const towerRampartPlacements = getExpansionDefenseTowerRampartTargets(room, lookups)
    .filter((position) => !hasExpansionDefenseRampartCoverage(lookups, position))
    .filter((position) => canPlaceExpansionDefenseTowerRampart(lookups, position))
    .map((position) => createExpansionDefenseBarrierPlacement(room.name, position, 'towerRampart'));
  if (towerRampartPlacements.length > 0) {
    return towerRampartPlacements.slice(0, getExpansionDefenseBarrierMaxPlacements(options.maxPlacements));
  }

  const coreRampartPlacements = getExpansionDefenseCoreRampartTargets(room, lookups)
    .filter((position) => !hasExpansionDefenseRampartCoverage(lookups, position))
    .filter((position) => canPlaceExpansionDefenseRampart(lookups, position))
    .map((position) => createExpansionDefenseBarrierPlacement(room.name, position, 'coreRampart'));
  if (coreRampartPlacements.length > 0) {
    return coreRampartPlacements.slice(0, getExpansionDefenseBarrierMaxPlacements(options.maxPlacements));
  }

  const entranceRampartTargets = getExpansionDefenseEntranceRampartTargets(room, lookups);
  const entranceRampartPlacements = entranceRampartTargets
    .filter((position) => !hasExpansionDefenseRampartCoverage(lookups, position))
    .filter((position) => canPlaceExpansionDefenseRampart(lookups, position))
    .map((position) => createExpansionDefenseBarrierPlacement(room.name, position, 'entranceRampart'));
  if (entranceRampartPlacements.length > 0) {
    return entranceRampartPlacements.slice(0, getExpansionDefenseBarrierMaxPlacements(options.maxPlacements));
  }

  const entranceWallPlacements = getExpansionDefenseEntranceWallTargets(entranceRampartTargets, lookups)
    .filter((position) => !hasExpansionDefenseWallCoverage(lookups, position))
    .filter((position) => canPlaceExpansionDefenseWall(lookups, position))
    .map((position) => createExpansionDefenseBarrierPlacement(room.name, position, 'entranceWall'));
  if (entranceWallPlacements.length > 0) {
    return entranceWallPlacements.slice(0, getExpansionDefenseBarrierMaxPlacements(options.maxPlacements));
  }

  return [];
}

function createExpansionTowerPlacementLookups(room: Room): ExpansionTowerPlacementLookups {
  const blockedPositions = new Set<string>();
  for (const object of [
    room.controller,
    ...findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES')),
    ...findRoomObjects<AnyStructure>(room, getFindConstant('FIND_STRUCTURES')),
    ...findRoomObjects<ConstructionSite>(room, getFindConstant('FIND_CONSTRUCTION_SITES'))
  ]) {
    addExpansionTowerBlockedPosition(blockedPositions, object, room.name);
  }

  return {
    terrain: getExpansionTowerRoomTerrain(room.name),
    blockedPositions,
    anchors: buildExpansionTowerAnchors(room)
  };
}

function buildExpansionTowerAnchors(room: Room): ExpansionTowerAnchor[] {
  const anchors: ExpansionTowerAnchor[] = [];
  addExpansionTowerAnchor(
    anchors,
    room.controller,
    'controller',
    EXPANSION_TOWER_CONTROLLER_WEIGHT,
    room.name
  );

  const structures = findRoomObjects<AnyStructure>(room, getFindConstant('FIND_STRUCTURES')).sort(
    compareExpansionTowerObjects
  );
  const constructionSites = findRoomObjects<ConstructionSite>(room, getFindConstant('FIND_CONSTRUCTION_SITES')).sort(
    compareExpansionTowerObjects
  );
  const roadAnchorCandidates: unknown[] = [];
  for (const object of [...structures, ...constructionSites]) {
    const structureType = getExpansionTowerStructureType(object);
    if (isExpansionTowerStructureType(structureType, 'STRUCTURE_SPAWN', 'spawn')) {
      addExpansionTowerAnchor(anchors, object, 'spawn', EXPANSION_TOWER_SPAWN_WEIGHT, room.name);
    } else if (isExpansionTowerStructureType(structureType, 'STRUCTURE_CONTAINER', 'container')) {
      addExpansionTowerAnchor(anchors, object, 'container', EXPANSION_TOWER_CONTAINER_WEIGHT, room.name);
    } else if (isExpansionTowerStructureType(structureType, 'STRUCTURE_ROAD', 'road')) {
      roadAnchorCandidates.push(object);
    }
  }

  for (const source of findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES')).sort(compareExpansionTowerObjectIds)) {
    addExpansionTowerAnchor(anchors, source, 'source', EXPANSION_TOWER_SOURCE_WEIGHT, room.name);
  }

  for (const road of selectExpansionTowerRoadAnchors(roadAnchorCandidates, anchors, room.name)) {
    addExpansionTowerAnchor(anchors, road, 'road', EXPANSION_TOWER_ROAD_WEIGHT, room.name);
  }

  for (const entrancePosition of getExpansionTowerEntranceAnchors(room)) {
    anchors.push({
      kind: 'entrance',
      position: entrancePosition,
      weight: EXPANSION_TOWER_ENTRANCE_WEIGHT
    });
  }

  return anchors;
}

function addExpansionTowerAnchor(
  anchors: ExpansionTowerAnchor[],
  object: unknown,
  kind: ExpansionTowerPlacementAnchorKind,
  weight: number,
  roomName: string
): void {
  const position = getExpansionTowerObjectPosition(object);
  if (!isExpansionTowerSameRoomPosition(position, roomName)) {
    return;
  }

  anchors.push({
    kind,
    position,
    weight
  });
}

function getExpansionTowerEntranceAnchors(room: Room): RoomPositionLike[] {
  const exitPositions = findRoomObjects<RoomPosition>(room, getFindConstant('FIND_EXIT'))
    .map(getExpansionTowerObjectPosition)
    .filter((position): position is RoomPositionLike =>
      isExpansionTowerSameRoomPosition(position, room.name)
    );

  if (exitPositions.length > 0) {
    return selectRepresentativeExpansionTowerExits(exitPositions);
  }

  return getExpansionTowerFallbackEntranceAnchors(room.name);
}

function selectRepresentativeExpansionTowerExits(exitPositions: RoomPositionLike[]): RoomPositionLike[] {
  const groups = groupExpansionTowerExits(exitPositions);
  return groups.map((group) => {
    const sortedPositions = [...group.positions].sort(compareExpansionTowerExitPositions);
    const middle = sortedPositions[Math.floor(sortedPositions.length / 2)];
    return {
      x: middle.x,
      y: middle.y,
      roomName: middle.roomName
    };
  });
}

function groupExpansionTowerExits(exitPositions: RoomPositionLike[]): ExitGroup[] {
  const groups: ExitGroup[] = [];
  for (const position of [...exitPositions].sort(compareExpansionTowerExitPositions)) {
    const side = getExpansionTowerExitSide(position);
    if (!side) {
      continue;
    }

    const previous = groups[groups.length - 1];
    if (
      previous &&
      previous.side === side &&
      areContiguousExpansionTowerExits(previous.positions[previous.positions.length - 1], position)
    ) {
      previous.positions.push(position);
    } else {
      groups.push({ side, positions: [position] });
    }
  }

  return groups;
}

function getExpansionTowerFallbackEntranceAnchors(roomName: string): RoomPositionLike[] {
  const exits = (globalThis as { Game?: Partial<Game> }).Game?.map?.describeExits?.(roomName) as
    | Record<string, string>
    | null
    | undefined;
  if (!isRecord(exits)) {
    return [];
  }

  const anchors: RoomPositionLike[] = [];
  if (isNonEmptyString(exits['1'])) {
    anchors.push({ x: 25, y: 0, roomName });
  }
  if (isNonEmptyString(exits['3'])) {
    anchors.push({ x: 49, y: 25, roomName });
  }
  if (isNonEmptyString(exits['5'])) {
    anchors.push({ x: 25, y: 49, roomName });
  }
  if (isNonEmptyString(exits['7'])) {
    anchors.push({ x: 0, y: 25, roomName });
  }

  return anchors;
}

function areContiguousExpansionTowerExits(
  left: RoomPositionLike | undefined,
  right: RoomPositionLike
): boolean {
  if (!left || getExpansionTowerExitSide(left) !== getExpansionTowerExitSide(right)) {
    return false;
  }

  if (left.x === right.x) {
    return Math.abs(left.y - right.y) <= 1;
  }

  if (left.y === right.y) {
    return Math.abs(left.x - right.x) <= 1;
  }

  return false;
}

function compareExpansionTowerExitPositions(left: RoomPositionLike, right: RoomPositionLike): number {
  const leftSide = getExpansionTowerExitSide(left) ?? '';
  const rightSide = getExpansionTowerExitSide(right) ?? '';
  return (
    getExpansionTowerExitSideOrder(leftSide) - getExpansionTowerExitSideOrder(rightSide) ||
    left.y - right.y ||
    left.x - right.x
  );
}

function getExpansionTowerExitSide(position: RoomPositionLike): ExitGroup['side'] | null {
  if (position.y <= 0) {
    return 'top';
  }
  if (position.x >= 49) {
    return 'right';
  }
  if (position.y >= 49) {
    return 'bottom';
  }
  if (position.x <= 0) {
    return 'left';
  }

  return null;
}

function getExpansionTowerExitSideOrder(side: string): number {
  switch (side) {
    case 'top':
      return 0;
    case 'right':
      return 1;
    case 'bottom':
      return 2;
    case 'left':
      return 3;
    default:
      return 4;
  }
}

function canPlaceExpansionTower(
  lookups: ExpansionTowerPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    position.x >= EXPANSION_TOWER_ROOM_EDGE_MIN &&
    position.x <= EXPANSION_TOWER_ROOM_EDGE_MAX &&
    position.y >= EXPANSION_TOWER_ROOM_EDGE_MIN &&
    position.y <= EXPANSION_TOWER_ROOM_EDGE_MAX &&
    !lookups.blockedPositions.has(getExpansionTowerPositionKey(position)) &&
    !isExpansionTowerTerrainWall(lookups.terrain, position)
  );
}

function scoreExpansionTowerPlacement(
  position: RoomPositionLike,
  anchors: ExpansionTowerAnchor[],
  roomName: string
): ExpansionTowerPlacement {
  const spawnRange = getNearestExpansionTowerAnchorRange(position, anchors, 'spawn');
  const controllerRange = getNearestExpansionTowerAnchorRange(position, anchors, 'controller');
  const nearestContainerRange = getNearestExpansionTowerAnchorRange(position, anchors, 'container');
  const nearestRoadRange = getNearestExpansionTowerAnchorRange(position, anchors, 'road');
  const nearestSourceRange = getNearestExpansionTowerAnchorRange(position, anchors, 'source');
  const nearestEntranceRange = getNearestExpansionTowerAnchorRange(position, anchors, 'entrance');
  return {
    roomName,
    x: position.x,
    y: position.y,
    score: anchors.reduce(
      (score, anchor) => score + getExpansionTowerRange(position, anchor.position) * anchor.weight,
      0
    ),
    ...(spawnRange !== null ? { spawnRange } : {}),
    ...(controllerRange !== null ? { controllerRange } : {}),
    ...(nearestContainerRange !== null ? { nearestContainerRange } : {}),
    ...(nearestRoadRange !== null ? { nearestRoadRange } : {}),
    ...(nearestSourceRange !== null ? { nearestSourceRange } : {}),
    ...(nearestEntranceRange !== null ? { nearestEntranceRange } : {})
  };
}

function getNearestExpansionTowerAnchorRange(
  position: RoomPositionLike,
  anchors: ExpansionTowerAnchor[],
  kind: ExpansionTowerPlacementAnchorKind
): number | null {
  let nearestRange: number | null = null;
  for (const anchor of anchors) {
    if (anchor.kind !== kind) {
      continue;
    }

    const range = getExpansionTowerRange(position, anchor.position);
    if (nearestRange === null || range < nearestRange) {
      nearestRange = range;
    }
  }

  return nearestRange;
}

function compareExpansionTowerPlacements(
  left: ExpansionTowerPlacement,
  right: ExpansionTowerPlacement
): number {
  return (
    left.score - right.score ||
    compareOptionalNumbers(left.spawnRange, right.spawnRange) ||
    compareOptionalNumbers(left.controllerRange, right.controllerRange) ||
    compareOptionalNumbers(left.nearestContainerRange, right.nearestContainerRange) ||
    compareOptionalNumbers(left.nearestRoadRange, right.nearestRoadRange) ||
    compareOptionalNumbers(left.nearestSourceRange, right.nearestSourceRange) ||
    compareOptionalNumbers(left.nearestEntranceRange, right.nearestEntranceRange) ||
    left.y - right.y ||
    left.x - right.x
  );
}

function selectExpansionTowerRoadAnchors(
  roadAnchorCandidates: unknown[],
  anchors: ExpansionTowerAnchor[],
  roomName: string
): unknown[] {
  return roadAnchorCandidates
    .map((object) => ({ object, position: getExpansionTowerObjectPosition(object) }))
    .filter((candidate): candidate is { object: unknown; position: RoomPositionLike } =>
      isExpansionTowerSameRoomPosition(candidate.position, roomName)
    )
    .sort(
      (left, right) =>
        getNearestExpansionTowerAnyAnchorRange(left.position, anchors) -
          getNearestExpansionTowerAnyAnchorRange(right.position, anchors) ||
        compareExpansionTowerPositions(left.position, right.position) ||
        compareExpansionTowerObjectIds(left.object, right.object)
    )
    .slice(0, EXPANSION_TOWER_MAX_ROAD_ANCHORS)
    .map((candidate) => candidate.object);
}

function getNearestExpansionTowerAnyAnchorRange(
  position: RoomPositionLike,
  anchors: ExpansionTowerAnchor[]
): number {
  if (anchors.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Math.min(...anchors.map((anchor) => getExpansionTowerRange(position, anchor.position)));
}

function getExpansionTowerStructureType(object: unknown): unknown {
  return isRecord(object) ? object.structureType : undefined;
}

function isExpansionTowerStructureType(
  actual: unknown,
  globalName: 'STRUCTURE_SPAWN' | 'STRUCTURE_CONTAINER' | 'STRUCTURE_ROAD',
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<
    Record<'STRUCTURE_SPAWN' | 'STRUCTURE_CONTAINER' | 'STRUCTURE_ROAD', StructureConstant>
  >;
  return actual === (constants[globalName] ?? fallback);
}

function addExpansionTowerBlockedPosition(
  blockedPositions: Set<string>,
  object: unknown,
  roomName: string
): void {
  const position = getExpansionTowerObjectPosition(object);
  if (isExpansionTowerSameRoomPosition(position, roomName)) {
    blockedPositions.add(getExpansionTowerPositionKey(position));
  }
}

function getExpansionTowerObjectPosition(object: unknown): RoomPositionLike | null {
  if (!isRecord(object)) {
    return null;
  }

  if (typeof object.x === 'number' && Number.isFinite(object.x) && typeof object.y === 'number' && Number.isFinite(object.y)) {
    return {
      x: object.x,
      y: object.y,
      ...(typeof object.roomName === 'string' ? { roomName: object.roomName } : {})
    };
  }

  const position = object.pos;
  if (
    isRecord(position) &&
    typeof position.x === 'number' &&
    Number.isFinite(position.x) &&
    typeof position.y === 'number' &&
    Number.isFinite(position.y)
  ) {
    return {
      x: position.x,
      y: position.y,
      ...(typeof position.roomName === 'string' ? { roomName: position.roomName } : {})
    };
  }

  return null;
}

function isExpansionTowerSameRoomPosition(
  position: RoomPositionLike | null,
  roomName: string
): position is RoomPositionLike {
  return position !== null && (position.roomName === undefined || position.roomName === roomName);
}

function getExpansionTowerRange(left: RoomPositionLike, right: RoomPositionLike): number {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function getExpansionTowerPositionKey(position: RoomPositionLike): string {
  return `${position.x},${position.y}`;
}

function getExpansionTowerRoomTerrain(roomName: string): RoomTerrain | null {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  return typeof gameMap?.getRoomTerrain === 'function' ? gameMap.getRoomTerrain(roomName) : null;
}

function isExpansionTowerTerrainWall(terrain: RoomTerrain | null, position: RoomPositionLike): boolean {
  return terrain !== null && (terrain.get(position.x, position.y) & getExpansionTowerTerrainWallMask()) !== 0;
}

function getExpansionTowerTerrainWallMask(): number {
  const terrainWallMask = (globalThis as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof terrainWallMask === 'number' ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK;
}

function getExpansionTowerMaxPlacements(maxPlacements: number | undefined): number {
  if (typeof maxPlacements !== 'number' || !Number.isFinite(maxPlacements)) {
    return EXPANSION_TOWER_DEFAULT_MAX_PLACEMENTS;
  }

  return Math.max(1, Math.floor(maxPlacements));
}

function createExpansionDefenseBarrierPlacementLookups(room: Room): ExpansionDefenseBarrierPlacementLookups {
  const structuresByPosition = new Map<string, AnyStructure[]>();
  const constructionSitesByPosition = new Map<string, ConstructionSite[]>();
  const reservedPositions = new Set<string>();

  addExpansionDefenseReservedPosition(reservedPositions, room.controller, room.name);
  for (const source of findRoomObjects<Source>(room, getFindConstant('FIND_SOURCES'))) {
    addExpansionDefenseReservedPosition(reservedPositions, source, room.name);
  }

  for (const mineral of findRoomObjects<Mineral>(room, getFindConstant('FIND_MINERALS'))) {
    addExpansionDefenseReservedPosition(reservedPositions, mineral, room.name);
  }

  for (const structure of findRoomObjects<AnyStructure>(room, getFindConstant('FIND_STRUCTURES'))) {
    addExpansionDefenseObjectAtPosition(structuresByPosition, structure, room.name);
  }

  for (const site of findRoomObjects<ConstructionSite>(room, getFindConstant('FIND_CONSTRUCTION_SITES'))) {
    addExpansionDefenseObjectAtPosition(constructionSitesByPosition, site, room.name);
  }

  return {
    terrain: getExpansionTowerRoomTerrain(room.name),
    reservedPositions,
    structuresByPosition,
    constructionSitesByPosition
  };
}

function getExpansionDefenseEntranceRampartTargets(
  room: Room,
  lookups: ExpansionDefenseBarrierPlacementLookups
): RoomPositionLike[] {
  return dedupeExpansionDefensePositions(
    getExpansionTowerEntranceAnchors(room)
      .map((position) => projectExpansionDefenseEntranceInsideRoom(position, room.name))
      .filter((position): position is RoomPositionLike => position !== null)
      .filter((position) => isExpansionDefenseRampartTargetAllowed(lookups, position))
  );
}

function projectExpansionDefenseEntranceInsideRoom(
  position: RoomPositionLike,
  roomName: string
): RoomPositionLike | null {
  const side = getExpansionTowerExitSide(position);
  switch (side) {
    case 'top':
      return { x: clampExpansionDefenseBuildCoordinate(position.x), y: 1, roomName };
    case 'right':
      return { x: 48, y: clampExpansionDefenseBuildCoordinate(position.y), roomName };
    case 'bottom':
      return { x: clampExpansionDefenseBuildCoordinate(position.x), y: 48, roomName };
    case 'left':
      return { x: 1, y: clampExpansionDefenseBuildCoordinate(position.y), roomName };
    default:
      return null;
  }
}

function isExpansionDefenseRampartTargetAllowed(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    isExpansionDefenseBuildablePosition(lookups, position) &&
    !lookups.reservedPositions.has(getExpansionTowerPositionKey(position)) &&
    !hasExpansionDefenseStructureTypeAt(lookups, position, 'STRUCTURE_WALL', 'constructedWall')
  );
}

function getExpansionDefenseEntranceWallTargets(
  entranceRampartTargets: RoomPositionLike[],
  lookups: ExpansionDefenseBarrierPlacementLookups
): RoomPositionLike[] {
  const positions: RoomPositionLike[] = [];
  for (const rampartPosition of entranceRampartTargets) {
    if (!hasExpansionDefenseRampartCoverage(lookups, rampartPosition)) {
      continue;
    }

    positions.push(...getExpansionDefenseAdjacentWallTargets(rampartPosition));
  }

  return dedupeExpansionDefensePositions(positions);
}

function getExpansionDefenseAdjacentWallTargets(position: RoomPositionLike): RoomPositionLike[] {
  const side = getExpansionDefenseInteriorSide(position);
  if (side === 'top' || side === 'bottom') {
    return [
      { x: position.x - 1, y: position.y, roomName: position.roomName },
      { x: position.x + 1, y: position.y, roomName: position.roomName }
    ];
  }

  if (side === 'left' || side === 'right') {
    return [
      { x: position.x, y: position.y - 1, roomName: position.roomName },
      { x: position.x, y: position.y + 1, roomName: position.roomName }
    ];
  }

  return [];
}

function getExpansionDefenseTowerRampartTargets(
  room: Room,
  lookups: ExpansionDefenseBarrierPlacementLookups
): RoomPositionLike[] {
  const targets = [
    ...findRoomObjects<AnyStructure>(room, getFindConstant('FIND_STRUCTURES')).filter((structure) =>
      isExpansionDefenseStructureType(structure.structureType, 'STRUCTURE_TOWER', 'tower')
    ),
    ...findRoomObjects<ConstructionSite>(room, getFindConstant('FIND_CONSTRUCTION_SITES')).filter((site) =>
      isExpansionDefenseStructureType(String(site.structureType), 'STRUCTURE_TOWER', 'tower')
    )
  ]
    .sort(compareExpansionTowerObjects)
    .map(getExpansionTowerObjectPosition)
    .filter((position): position is RoomPositionLike =>
      isExpansionTowerSameRoomPosition(position, room.name)
    );

  return dedupeExpansionDefensePositions(targets).filter((position) =>
    isExpansionDefenseRampartTargetAllowed(lookups, position)
  );
}

function getExpansionDefenseCoreRampartTargets(
  room: Room,
  lookups: ExpansionDefenseBarrierPlacementLookups
): RoomPositionLike[] {
  const targets: RoomPositionLike[] = [];
  const structures = findRoomObjects<AnyStructure>(room, getFindConstant('FIND_STRUCTURES'));
  for (const spawn of structures
    .filter((structure) => isExpansionDefenseStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn'))
    .sort(compareExpansionTowerObjectIds)) {
    const spawnPosition = getExpansionTowerObjectPosition(spawn);
    if (!isExpansionTowerSameRoomPosition(spawnPosition, room.name)) {
      continue;
    }

    targets.push(spawnPosition, ...getExpansionDefenseAdjacentPositions(spawnPosition, true));
  }

  const controllerPosition = getExpansionTowerObjectPosition(room.controller);
  if (isExpansionTowerSameRoomPosition(controllerPosition, room.name)) {
    targets.push(...getExpansionDefenseAdjacentPositions(controllerPosition, false));
  }

  return dedupeExpansionDefensePositions(targets)
    .filter((position) => isExpansionDefenseRampartTargetAllowed(lookups, position))
    .slice(0, EXPANSION_DEFENSE_BARRIER_MAX_CORE_RAMPARTS);
}

function getExpansionDefenseAdjacentPositions(
  center: RoomPositionLike,
  includeCenter: boolean
): RoomPositionLike[] {
  const positions: RoomPositionLike[] = includeCenter ? [{ ...center }] : [];
  const offsets = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 1, dy: -1 },
    { dx: 1, dy: 1 },
    { dx: -1, dy: 1 }
  ];

  for (const offset of offsets) {
    positions.push({
      x: center.x + offset.dx,
      y: center.y + offset.dy,
      roomName: center.roomName
    });
  }

  return positions;
}

function canPlaceExpansionDefenseRampart(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    isExpansionDefenseRampartTargetAllowed(lookups, position) &&
    !hasExpansionDefenseConstructionAt(lookups, position)
  );
}

function canPlaceExpansionDefenseTowerRampart(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    isExpansionDefenseRampartTargetAllowed(lookups, position) &&
    (
      !hasExpansionDefenseConstructionAt(lookups, position) ||
      hasExpansionDefenseConstructionTypeAt(lookups, position, 'STRUCTURE_TOWER', 'tower')
    )
  );
}

function canPlaceExpansionDefenseWall(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    isExpansionDefenseBuildablePosition(lookups, position) &&
    !lookups.reservedPositions.has(getExpansionTowerPositionKey(position)) &&
    !hasExpansionDefenseStructureAt(lookups, position) &&
    !hasExpansionDefenseConstructionAt(lookups, position)
  );
}

function isExpansionDefenseBuildablePosition(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    position.x >= EXPANSION_TOWER_ROOM_EDGE_MIN &&
    position.x <= EXPANSION_TOWER_ROOM_EDGE_MAX &&
    position.y >= EXPANSION_TOWER_ROOM_EDGE_MIN &&
    position.y <= EXPANSION_TOWER_ROOM_EDGE_MAX &&
    !isExpansionTowerTerrainWall(lookups.terrain, position)
  );
}

function hasExpansionDefenseRampartCoverage(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    hasExpansionDefenseStructureTypeAt(lookups, position, 'STRUCTURE_RAMPART', 'rampart') ||
    hasExpansionDefenseConstructionTypeAt(lookups, position, 'STRUCTURE_RAMPART', 'rampart')
  );
}

function hasExpansionDefenseWallCoverage(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (
    hasExpansionDefenseStructureTypeAt(lookups, position, 'STRUCTURE_WALL', 'constructedWall') ||
    hasExpansionDefenseConstructionTypeAt(lookups, position, 'STRUCTURE_WALL', 'constructedWall')
  );
}

function hasExpansionDefenseStructureAt(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (lookups.structuresByPosition.get(getExpansionTowerPositionKey(position)) ?? []).length > 0;
}

function hasExpansionDefenseConstructionAt(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike
): boolean {
  return (lookups.constructionSitesByPosition.get(getExpansionTowerPositionKey(position)) ?? []).length > 0;
}

function hasExpansionDefenseStructureTypeAt(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike,
  globalName: 'STRUCTURE_RAMPART' | 'STRUCTURE_WALL',
  fallback: string
): boolean {
  return (lookups.structuresByPosition.get(getExpansionTowerPositionKey(position)) ?? []).some((structure) =>
    isExpansionDefenseStructureType(structure.structureType, globalName, fallback)
  );
}

function hasExpansionDefenseConstructionTypeAt(
  lookups: ExpansionDefenseBarrierPlacementLookups,
  position: RoomPositionLike,
  globalName: 'STRUCTURE_TOWER' | 'STRUCTURE_RAMPART' | 'STRUCTURE_WALL',
  fallback: string
): boolean {
  return (lookups.constructionSitesByPosition.get(getExpansionTowerPositionKey(position)) ?? []).some((site) =>
    isExpansionDefenseStructureType(String(site.structureType), globalName, fallback)
  );
}

function createExpansionDefenseBarrierPlacement(
  roomName: string,
  position: RoomPositionLike,
  stage: ExpansionDefenseBarrierPlacementStage
): ExpansionDefenseBarrierPlacement {
  const isWall = stage === 'entranceWall';
  return {
    roomName,
    x: position.x,
    y: position.y,
    structureType: getExpansionDefenseStructureConstant(
      isWall ? 'STRUCTURE_WALL' : 'STRUCTURE_RAMPART',
      isWall ? 'constructedWall' : 'rampart'
    ),
    stage,
    priority: getExpansionDefenseBarrierStagePriority(stage)
  };
}

function getExpansionDefenseBarrierStagePriority(stage: ExpansionDefenseBarrierPlacementStage): number {
  switch (stage) {
    case 'towerRampart':
      return 0;
    case 'coreRampart':
      return 1;
    case 'entranceRampart':
      return 2;
    case 'entranceWall':
      return 3;
  }
}

function getExpansionDefenseInteriorSide(position: RoomPositionLike): ExitGroup['side'] | null {
  if (position.y <= EXPANSION_TOWER_ROOM_EDGE_MIN) {
    return 'top';
  }
  if (position.x >= EXPANSION_TOWER_ROOM_EDGE_MAX) {
    return 'right';
  }
  if (position.y >= EXPANSION_TOWER_ROOM_EDGE_MAX) {
    return 'bottom';
  }
  if (position.x <= EXPANSION_TOWER_ROOM_EDGE_MIN) {
    return 'left';
  }

  return null;
}

function addExpansionDefenseReservedPosition(
  reservedPositions: Set<string>,
  object: unknown,
  roomName: string
): void {
  const position = getExpansionTowerObjectPosition(object);
  if (isExpansionTowerSameRoomPosition(position, roomName)) {
    reservedPositions.add(getExpansionTowerPositionKey(position));
  }
}

function addExpansionDefenseObjectAtPosition<T extends { pos?: RoomPosition; structureType?: unknown }>(
  objectsByPosition: Map<string, T[]>,
  object: T,
  roomName: string
): void {
  const position = getExpansionTowerObjectPosition(object);
  if (!isExpansionTowerSameRoomPosition(position, roomName)) {
    return;
  }

  const key = getExpansionTowerPositionKey(position);
  const objects = objectsByPosition.get(key) ?? [];
  objects.push(object);
  objectsByPosition.set(key, objects);
}

function dedupeExpansionDefensePositions(positions: RoomPositionLike[]): RoomPositionLike[] {
  const seen = new Set<string>();
  const deduped: RoomPositionLike[] = [];
  for (const position of positions) {
    const key = getExpansionTowerPositionKey(position);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(position);
  }

  return deduped;
}

function clampExpansionDefenseBuildCoordinate(value: number): number {
  return Math.max(EXPANSION_TOWER_ROOM_EDGE_MIN, Math.min(EXPANSION_TOWER_ROOM_EDGE_MAX, value));
}

function getExpansionDefenseBarrierMaxPlacements(maxPlacements: number | undefined): number {
  if (typeof maxPlacements !== 'number' || !Number.isFinite(maxPlacements)) {
    return EXPANSION_DEFENSE_BARRIER_DEFAULT_MAX_PLACEMENTS;
  }

  return Math.max(1, Math.floor(maxPlacements));
}

function isExpansionDefenseStructureType(
  actual: unknown,
  globalName: 'STRUCTURE_SPAWN' | 'STRUCTURE_TOWER' | 'STRUCTURE_RAMPART' | 'STRUCTURE_WALL',
  fallback: string
): boolean {
  return actual === getExpansionDefenseStructureConstant(globalName, fallback);
}

function getExpansionDefenseStructureConstant(
  globalName: 'STRUCTURE_SPAWN' | 'STRUCTURE_TOWER' | 'STRUCTURE_RAMPART' | 'STRUCTURE_WALL',
  fallback: string
): BuildableStructureConstant {
  const constants = globalThis as unknown as Partial<
    Record<'STRUCTURE_SPAWN' | 'STRUCTURE_TOWER' | 'STRUCTURE_RAMPART' | 'STRUCTURE_WALL', BuildableStructureConstant>
  >;
  return constants[globalName] ?? (fallback as BuildableStructureConstant);
}

function compareExpansionTowerObjects(left: unknown, right: unknown): number {
  const leftPosition = getExpansionTowerObjectPosition(left);
  const rightPosition = getExpansionTowerObjectPosition(right);
  if (leftPosition && rightPosition) {
    return compareExpansionTowerPositions(leftPosition, rightPosition) || compareExpansionTowerObjectIds(left, right);
  }

  if (leftPosition) {
    return -1;
  }

  if (rightPosition) {
    return 1;
  }

  return compareExpansionTowerObjectIds(left, right);
}

function compareExpansionTowerPositions(left: RoomPositionLike, right: RoomPositionLike): number {
  return left.y - right.y || left.x - right.x || (left.roomName ?? '').localeCompare(right.roomName ?? '');
}

function compareExpansionTowerObjectIds(left: unknown, right: unknown): number {
  return getExpansionTowerObjectId(left).localeCompare(getExpansionTowerObjectId(right));
}

function getExpansionTowerObjectId(object: unknown): string {
  if (!isRecord(object)) {
    return '';
  }

  return typeof object.id === 'string' ? object.id : '';
}

function evaluateExpansionSuitability({
  sourceCount,
  hostileCreepCount,
  hostileStructureCount,
  controllerId,
  ownerUsername,
  reservationUsername,
  colonyOwnerUsername,
  hasController
}: {
  sourceCount: number;
  hostileCreepCount: number;
  hostileStructureCount: number;
  controllerId?: Id<StructureController>;
  ownerUsername?: string;
  reservationUsername?: string;
  colonyOwnerUsername?: string;
  hasController: boolean;
}): ExpansionRoomSuitability {
  const normalizedSourceCount = normalizeNonNegativeInteger(sourceCount);
  const normalizedHostileCreepCount = normalizeNonNegativeInteger(hostileCreepCount);
  const normalizedHostileStructureCount = normalizeNonNegativeInteger(hostileStructureCount);
  const reasons: ExpansionRoomUnsuitableReason[] = [];

  if (normalizedSourceCount < EXPANSION_PLANNER_MIN_SOURCE_COUNT) {
    reasons.push('sourceCountBelowMinimum');
  }

  if (normalizedHostileCreepCount > 0 || normalizedHostileStructureCount > 0) {
    reasons.push('hostilePresence');
  }

  if (!hasController) {
    reasons.push('controllerMissing');
  } else if (isNonEmptyString(ownerUsername)) {
    reasons.push('controllerOwned');
  } else if (
    isNonEmptyString(reservationUsername) &&
    (!isNonEmptyString(colonyOwnerUsername) || reservationUsername !== colonyOwnerUsername)
  ) {
    reasons.push('controllerReserved');
  }

  return {
    suitable: reasons.length === 0,
    sourceCount: normalizedSourceCount,
    hostileCreepCount: normalizedHostileCreepCount,
    hostileStructureCount: normalizedHostileStructureCount,
    reasons,
    ...(controllerId ? { controllerId } : {}),
    ...(ownerUsername ? { ownerUsername } : {}),
    ...(reservationUsername ? { reservationUsername } : {})
  };
}

function toRuntimeExpansionPlannerCandidate(
  colony: string,
  room: Room,
  distance: number,
  order: number,
  colonyOwnerUsername: string | undefined,
  adjacencyBonus?: number
): ExpansionPlannerCandidate {
  const suitability = evaluateExpansionRoomSuitability(room, colonyOwnerUsername);
  const normalizedDistance = Math.max(1, normalizeNonNegativeInteger(distance));
  const normalizedAdjacencyBonus = normalizeExpansionPlannerAdjacencyBonus(
    adjacencyBonus,
    normalizedDistance
  );
  return {
    colony,
    roomName: room.name,
    distance: normalizedDistance,
    order,
    adjacencyBonus: normalizedAdjacencyBonus,
    score: scoreExpansionPlannerCandidate(
      suitability.sourceCount,
      normalizedDistance,
      normalizedAdjacencyBonus
    ),
    ...suitability
  };
}

function compareExpansionPlannerCandidates(
  left: ExpansionPlannerCandidate,
  right: ExpansionPlannerCandidate
): number {
  return (
    right.score - left.score ||
    right.sourceCount - left.sourceCount ||
    left.distance - right.distance ||
    getExpansionPlannerCandidateAdjacencyBonus(right) - getExpansionPlannerCandidateAdjacencyBonus(left) ||
    left.order - right.order ||
    left.roomName.localeCompare(right.roomName)
  );
}

function scoreExpansionPlannerCandidate(
  sourceCount: number,
  distance: number,
  adjacencyBonus: number
): number {
  return sourceCount * SOURCE_SCORE_WEIGHT + adjacencyBonus - distance * DISTANCE_SCORE_WEIGHT;
}

function dedupeExpansionPlannerCandidates(
  candidates: ExpansionPlannerCandidate[]
): ExpansionPlannerCandidate[] {
  const candidatesByRoom = new Map<string, ExpansionPlannerCandidate>();
  for (const candidate of candidates) {
    const existingCandidate = candidatesByRoom.get(candidate.roomName);
    if (!existingCandidate || compareExpansionPlannerCandidates(candidate, existingCandidate) < 0) {
      candidatesByRoom.set(candidate.roomName, candidate);
    }
  }

  return Array.from(candidatesByRoom.values());
}

function normalizeExpansionPlannerAdjacencyBonus(
  adjacencyBonus: number | undefined,
  distance: number
): number {
  if (typeof adjacencyBonus === 'number' && Number.isFinite(adjacencyBonus)) {
    return Math.max(0, Math.floor(adjacencyBonus));
  }

  return getExpansionPlannerAdjacencyBonus(distance);
}

function getExpansionPlannerAdjacencyBonus(distance: number): number {
  return distance <= 1
    ? DIRECT_ADJACENCY_SCORE_BONUS
    : distance <= EXPANSION_PLANNER_MAX_ROUTE_DISTANCE
      ? NEARBY_ADJACENCY_SCORE_BONUS
      : 0;
}

function getExpansionPlannerCandidateAdjacencyBonus(candidate: ExpansionPlannerCandidate): number {
  return normalizeExpansionPlannerAdjacencyBonus(candidate.adjacencyBonus, candidate.distance);
}

function selectExpansionIntentAction(colony: ColonySnapshot): TerritoryControlAction {
  const gclLevel = getGclLevel();
  if (gclLevel === null) {
    return 'reserve';
  }

  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const ownedRoomCount = getVisibleOwnedRoomNames(colony.room.name, ownerUsername).size;
  if (ownedRoomCount >= gclLevel) {
    return 'reserve';
  }

  if (ownedRoomCount >= maxRoomsForRcl(colony.room.controller?.level)) {
    return 'reserve';
  }

  return isExpansionPlannerClaimReady(colony) ? 'claim' : 'reserve';
}

function isExpansionPlannerClaimReady(colony: ColonySnapshot): boolean {
  const controller = colony.room.controller;
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    controller.level >= 2 &&
    hasActiveExpansionPlannerSpawn(colony) &&
    !hasExpansionPlannerActiveHostiles(colony.room) &&
    !hasExpansionPlannerPendingThreat(colony.room.name, getGameTime()) &&
    colony.energyAvailable >= TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY &&
    colony.energyCapacityAvailable >= TERRITORY_AUTO_CLAIM_REQUIRED_ENERGY
  );
}

function hasActiveExpansionPlannerSpawn(colony: ColonySnapshot): boolean {
  if (colony.spawns.some(isActiveExpansionPlannerSpawn)) {
    return true;
  }

  const gameSpawns = (globalThis as { Game?: Partial<Game> }).Game?.spawns;
  if (!gameSpawns) {
    return false;
  }

  return Object.values(gameSpawns).some(
    (spawn) => spawn?.room?.name === colony.room.name && isActiveExpansionPlannerSpawn(spawn)
  );
}

function isActiveExpansionPlannerSpawn(spawn: StructureSpawn): boolean {
  if (typeof spawn.isActive !== 'function') {
    return true;
  }

  try {
    return spawn.isActive() !== false;
  } catch {
    return false;
  }
}

function hasExpansionPlannerActiveHostiles(room: Room): boolean {
  return (
    findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length > 0 ||
    findRoomObjects<AnyStructure>(room, getFindConstant('FIND_HOSTILE_STRUCTURES')).length > 0
  );
}

function hasExpansionPlannerPendingThreat(roomName: string, gameTime: number): boolean {
  const threatMemory = (globalThis as { Memory?: Partial<Memory> }).Memory?.defense?.colonyThreats;
  if (!threatMemory) {
    return false;
  }

  const roomThreat = threatMemory?.rooms?.[roomName];
  return (
    !isRecentExpansionPlannerThreatMemory(threatMemory.updatedAt, gameTime) ||
    !roomThreat ||
    !isRecentExpansionPlannerThreatMemory(roomThreat.updatedAt, gameTime) ||
    roomThreat.level !== 'none'
  );
}

function isRecentExpansionPlannerThreatMemory(updatedAt: unknown, gameTime: number): boolean {
  return (
    typeof updatedAt === 'number' &&
    Number.isFinite(updatedAt) &&
    updatedAt <= gameTime &&
    gameTime - updatedAt <= EXPANSION_PLANNER_THREAT_MEMORY_STALE_TICKS
  );
}

function refreshTerminalExpansionPlans(
  territoryMemory: TerritoryMemory,
  colony: string,
  gameTime: number
): void {
  const ownerUsername = getVisibleColonyOwnerUsername(colony);
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const refreshedPlans = new Set<string>();
  let changed = false;

  for (const rawTarget of Array.isArray(territoryMemory.targets) ? territoryMemory.targets : []) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.colony !== colony ||
      target.roomName === colony ||
      target.enabled === false ||
      target.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR ||
      !isExpansionControlAction(target.action)
    ) {
      continue;
    }

    const existingIntent = findExpansionIntent(intents, target.colony, target.roomName, target.action);
    const terminalStatus =
      getTerminalIntentStatus(existingIntent) ?? getVisibleExpansionTargetTerminalStatus(target, ownerUsername);
    if (!terminalStatus) {
      continue;
    }

    persistTerminalExpansionPlan(territoryMemory, intents, target, terminalStatus, gameTime);
    refreshedPlans.add(getExpansionPlanKey(target.colony, target.roomName, target.action));
    changed = true;
  }

  for (const intent of intents) {
    if (
      intent.colony !== colony ||
      intent.targetRoom === colony ||
      !isExpansionControlAction(intent.action) ||
      intent.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR
    ) {
      continue;
    }

    const planKey = getExpansionPlanKey(intent.colony, intent.targetRoom, intent.action);
    if (refreshedPlans.has(planKey)) {
      continue;
    }

    const target: TerritoryTargetMemory = {
      colony: intent.colony,
      roomName: intent.targetRoom,
      action: intent.action,
      createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
      ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
    };
    const terminalStatus =
      getTerminalIntentStatus(intent) ?? getVisibleExpansionTargetTerminalStatus(target, ownerUsername);
    if (!terminalStatus) {
      continue;
    }

    persistTerminalExpansionPlan(territoryMemory, intents, target, terminalStatus, gameTime);
    changed = true;
  }

  if (changed) {
    territoryMemory.intents = intents;
  }
}

function getPotentialExpansionReservationUpgradeRooms(
  territoryMemory: TerritoryMemory,
  colony: string
): Set<string> | null {
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const roomNames = new Set<string>();

  for (const intent of intents) {
    if (
      intent.colony !== colony ||
      intent.targetRoom === colony ||
      (intent.action !== 'claim' && intent.action !== 'reserve' && intent.action !== 'scout') ||
      (intent.status !== 'planned' && intent.status !== 'active')
    ) {
      continue;
    }

    if (isPotentialExpansionReservationUpgradeIntent(intent)) {
      roomNames.add(intent.targetRoom);
      continue;
    }

    return null;
  }

  for (const rawTarget of Array.isArray(territoryMemory.targets) ? territoryMemory.targets : []) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      !target ||
      target.colony !== colony ||
      target.roomName === colony ||
      target.enabled === false ||
      !isExpansionControlAction(target.action)
    ) {
      continue;
    }

    if (isPotentialExpansionReservationUpgradeTarget(target, intents)) {
      roomNames.add(target.roomName);
      continue;
    }

    if (isBlockingExpansionTarget(rawTarget, colony, intents, null)) {
      return null;
    }
  }

  return roomNames;
}

function hasBlockingTerritoryPlan(
  territoryMemory: TerritoryMemory,
  colony: string,
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  if (
    intents.some(
      (intent) =>
        intent.colony === colony &&
        intent.targetRoom !== colony &&
        (intent.action === 'claim' || intent.action === 'reserve' || intent.action === 'scout') &&
        (intent.status === 'planned' || intent.status === 'active') &&
        !isUpgradeableExpansionReservationIntent(intent, reservationUpgrade)
    )
  ) {
    return true;
  }

  return Array.isArray(territoryMemory.targets)
    ? territoryMemory.targets.some((target) => isBlockingExpansionTarget(target, colony, intents, reservationUpgrade))
    : false;
}

function persistTerminalExpansionPlan(
  territoryMemory: TerritoryMemory,
  intents: TerritoryIntentMemory[],
  target: TerritoryTargetMemory,
  status: TerminalExpansionIntentStatus,
  gameTime: number
): void {
  if (findExpansionTarget(territoryMemory, target.colony, target.roomName, target.action)) {
    upsertTerritoryTarget(territoryMemory, { ...target, enabled: false });
  }

  upsertTerritoryIntent(intents, {
    colony: target.colony,
    targetRoom: target.roomName,
    action: target.action,
    status,
    updatedAt: gameTime,
    createdBy: EXPANSION_PLANNER_TARGET_CREATOR,
    ...(target.controllerId ? { controllerId: target.controllerId } : {})
  });
}

function upsertTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  const existingTarget = territoryMemory.targets.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.colony === target.colony &&
      candidate.roomName === target.roomName &&
      candidate.action === target.action &&
      candidate.createdBy === target.createdBy
  );
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }

  existingTarget.enabled = target.enabled;
  existingTarget.createdBy = target.createdBy;
  if (target.controllerId) {
    existingTarget.controllerId = target.controllerId;
  } else {
    delete existingTarget.controllerId;
  }
}

function upsertTerritoryIntent(
  intents: TerritoryIntentMemory[],
  nextIntent: TerritoryIntentMemory
): void {
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === nextIntent.colony &&
      intent.targetRoom === nextIntent.targetRoom &&
      intent.action === nextIntent.action &&
      intent.createdBy === nextIntent.createdBy
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
}

function findExpansionIntent(
  intents: TerritoryIntentMemory[],
  colony: string,
  targetRoom: string,
  action: TerritoryControlAction
): TerritoryIntentMemory | undefined {
  return intents.find(
    (intent) =>
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action &&
      intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR
  );
}

function findExpansionTarget(
  territoryMemory: TerritoryMemory,
  colony: string,
  roomName: string,
  action: TerritoryControlAction
): TerritoryTargetMemory | null {
  if (!Array.isArray(territoryMemory.targets)) {
    return null;
  }

  return (
    territoryMemory.targets
      .map(normalizeTerritoryTarget)
      .find(
        (target): target is TerritoryTargetMemory =>
          target !== null &&
          target.colony === colony &&
          target.roomName === roomName &&
          target.action === action &&
          target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR
      ) ?? null
  );
}

function isBlockingExpansionTarget(
  rawTarget: unknown,
  colony: string,
  intents: TerritoryIntentMemory[],
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  if (!isRecord(rawTarget)) {
    return false;
  }

  const target = normalizeTerritoryTarget(rawTarget);
  if (
    !target ||
    target.colony !== colony ||
    target.roomName === colony ||
    target.enabled === false ||
    !isExpansionControlAction(target.action)
  ) {
    return false;
  }

  if (isUpgradeableExpansionReservationTarget(target, reservationUpgrade)) {
    return false;
  }

  if (target.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR) {
    return true;
  }

  const matchingIntent = findExpansionIntent(intents, target.colony, target.roomName, target.action);
  return getTerminalIntentStatus(matchingIntent) === null;
}

function getExpansionReservationUpgradeContext(
  candidate: ExpansionPlannerCandidate,
  action: TerritoryControlAction
): ExpansionReservationUpgradeContext | null {
  return candidate.suitable && action === 'claim'
    ? { colony: candidate.colony, targetRoom: candidate.roomName, action }
    : null;
}

function isUpgradeableExpansionReservationIntent(
  intent: TerritoryIntentMemory,
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  return (
    reservationUpgrade !== null &&
    reservationUpgrade.action === 'claim' &&
    intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    intent.colony === reservationUpgrade.colony &&
    intent.targetRoom === reservationUpgrade.targetRoom &&
    intent.action === 'reserve'
  );
}

function isPotentialExpansionReservationUpgradeIntent(intent: TerritoryIntentMemory): boolean {
  return intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR && intent.action === 'reserve';
}

function isUpgradeableExpansionReservationTarget(
  target: TerritoryTargetMemory,
  reservationUpgrade: ExpansionReservationUpgradeContext | null
): boolean {
  return (
    reservationUpgrade !== null &&
    reservationUpgrade.action === 'claim' &&
    target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    target.colony === reservationUpgrade.colony &&
    target.roomName === reservationUpgrade.targetRoom &&
    target.action === 'reserve'
  );
}

function isPotentialExpansionReservationUpgradeTarget(
  target: TerritoryTargetMemory,
  intents: TerritoryIntentMemory[]
): boolean {
  if (target.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR || target.action !== 'reserve') {
    return false;
  }

  const matchingIntent = findExpansionIntent(intents, target.colony, target.roomName, target.action);
  return getTerminalIntentStatus(matchingIntent) === null;
}

function removeSupersededExpansionReservationPlan(
  territoryMemory: TerritoryMemory,
  intents: TerritoryIntentMemory[],
  colony: string,
  roomName: string
): void {
  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter((rawTarget) => {
      const target = normalizeTerritoryTarget(rawTarget);
      return !(
        target?.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
        target.colony === colony &&
        target.roomName === roomName &&
        target.action === 'reserve'
      );
    });
  }

  for (let index = intents.length - 1; index >= 0; index -= 1) {
    const intent = intents[index];
    if (
      intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
      intent.colony === colony &&
      intent.targetRoom === roomName &&
      intent.action === 'reserve'
    ) {
      intents.splice(index, 1);
    }
  }
}

function disableLowerPriorityExpansionClaimPlans(
  territoryMemory: TerritoryMemory,
  intents: TerritoryIntentMemory[],
  selectedCandidate: ExpansionPlannerCandidate,
  gameTime: number
): void {
  if (Array.isArray(territoryMemory.targets)) {
    for (const rawTarget of territoryMemory.targets) {
      const target = normalizeTerritoryTarget(rawTarget);
      if (
        !target ||
        target.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR ||
        target.action !== 'claim' ||
        target.colony !== selectedCandidate.colony ||
        target.roomName === selectedCandidate.roomName ||
        target.enabled === false
      ) {
        continue;
      }

      rawTarget.enabled = false;
    }
  }

  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];
    if (
      intent.createdBy !== EXPANSION_PLANNER_TARGET_CREATOR ||
      intent.action !== 'claim' ||
      intent.colony !== selectedCandidate.colony ||
      intent.targetRoom === selectedCandidate.roomName ||
      (intent.status !== 'planned' && intent.status !== 'active')
    ) {
      continue;
    }

    intents[index] = {
      ...intent,
      status: 'inactive',
      updatedAt: gameTime
    };
  }
}

function getExpansionPlanKey(colony: string, targetRoom: string, action: TerritoryControlAction): string {
  return `${colony}:${targetRoom}:${action}`;
}

function isExpansionPlannerClaimIntentForColony(
  intent: TerritoryIntentMemory,
  colony: string | undefined
): boolean {
  return (
    intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    intent.action === 'claim' &&
    (!isNonEmptyString(colony) || intent.colony === colony)
  );
}

function isExpansionPlannerClaimTargetForColony(
  target: TerritoryTargetMemory | null,
  colony: string | undefined
): target is TerritoryTargetMemory & { action: 'claim'; createdBy: typeof EXPANSION_PLANNER_TARGET_CREATOR } {
  return (
    target !== null &&
    target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    target.action === 'claim' &&
    target.enabled !== false &&
    (!isNonEmptyString(colony) || target.colony === colony)
  );
}

function isRunnableExpansionPlannerClaimStatus(
  status: TerritoryIntentMemory['status']
): status is Extract<TerritoryIntentMemory['status'], 'planned' | 'active'> {
  return isRunnableExpansionPlannerControlStatus(status);
}

function isRunnableExpansionPlannerControlStatus(
  status: TerritoryIntentMemory['status']
): status is Extract<TerritoryIntentMemory['status'], 'planned' | 'active'> {
  return status === 'planned' || status === 'active';
}

function isExpansionPlannerReservationIntentForColony(
  intent: TerritoryIntentMemory,
  colony: string | undefined
): boolean {
  return (
    intent.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    intent.action === 'reserve' &&
    (!isNonEmptyString(colony) || intent.colony === colony)
  );
}

function isExpansionPlannerReservationTargetForColony(
  target: TerritoryTargetMemory | null,
  colony: string | undefined
): target is TerritoryTargetMemory & { action: 'reserve'; createdBy: typeof EXPANSION_PLANNER_TARGET_CREATOR } {
  return (
    target !== null &&
    target.createdBy === EXPANSION_PLANNER_TARGET_CREATOR &&
    target.action === 'reserve' &&
    target.enabled !== false &&
    (!isNonEmptyString(colony) || target.colony === colony)
  );
}

function compareExpansionPlannerClaimRecommendations(
  left: ExpansionPlannerClaimRecommendation,
  right: ExpansionPlannerClaimRecommendation
): number {
  return (
    left.colony.localeCompare(right.colony) ||
    left.targetRoom.localeCompare(right.targetRoom) ||
    compareOptionalNumbers(left.updatedAt, right.updatedAt)
  );
}

function compareExpansionPlannerReservationRecommendations(
  left: ExpansionPlannerReservationRecommendation,
  right: ExpansionPlannerReservationRecommendation
): number {
  return (
    left.colony.localeCompare(right.colony) ||
    left.targetRoom.localeCompare(right.targetRoom) ||
    compareOptionalNumbers(left.updatedAt, right.updatedAt)
  );
}

function getCandidateTerminalExpansionStatus(
  candidate: ExpansionPlannerCandidate,
  action: TerritoryControlAction,
  existingIntent: TerritoryIntentMemory | undefined
): TerminalExpansionIntentStatus | null {
  if (candidate.suitable) {
    return null;
  }

  const terminalStatus = getTerminalIntentStatus(existingIntent);
  if (terminalStatus) {
    return terminalStatus;
  }

  const ownerUsername = getVisibleColonyOwnerUsername(candidate.colony);
  if (action === 'claim' && candidate.ownerUsername && candidate.ownerUsername === ownerUsername) {
    return 'completed';
  }

  if (action === 'reserve' && candidate.reservationUsername && candidate.reservationUsername === ownerUsername) {
    return 'completed';
  }

  return 'inactive';
}

function getTerminalIntentStatus(
  intent: TerritoryIntentMemory | undefined
): TerminalExpansionIntentStatus | null {
  return intent?.status === 'completed' || intent?.status === 'inactive' ? intent.status : null;
}

function getVisibleExpansionTargetTerminalStatus(
  target: TerritoryTargetMemory,
  ownerUsername: string | undefined
): TerminalExpansionIntentStatus | null {
  const room = getGameRooms()?.[target.roomName];
  if (!room) {
    return null;
  }

  if (
    findRoomObjects<Creep>(room, getFindConstant('FIND_HOSTILE_CREEPS')).length > 0 ||
    findRoomObjects<AnyStructure>(room, getFindConstant('FIND_HOSTILE_STRUCTURES')).length > 0
  ) {
    return 'inactive';
  }

  const controller = room.controller;
  if (!controller) {
    return 'inactive';
  }

  if (target.action === 'claim') {
    if (isControllerOwnedByUsername(controller, ownerUsername)) {
      return 'completed';
    }

    return isControllerOwned(controller) ? 'inactive' : null;
  }

  if (isControllerOwnedByUsername(controller, ownerUsername)) {
    return 'completed';
  }

  if (isControllerOwned(controller)) {
    return 'inactive';
  }

  const reservationUsername = getControllerReservationUsername(controller);
  if (!reservationUsername) {
    return null;
  }

  return reservationUsername === ownerUsername ? null : 'inactive';
}

function normalizeTerritoryTarget(rawTarget: unknown): TerritoryTargetMemory | null {
  if (!isRecord(rawTarget)) {
    return null;
  }

  const action = getTerritoryTargetAction(rawTarget);
  if (
    !isNonEmptyString(rawTarget.colony) ||
    !isNonEmptyString(rawTarget.roomName) ||
    !action
  ) {
    return null;
  }

  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action,
    ...(typeof rawTarget.controllerId === 'string'
      ? { controllerId: rawTarget.controllerId as Id<StructureController> }
      : {}),
    ...(rawTarget.enabled === false ? { enabled: false } : {}),
    ...(isTerritoryAutomationSource(rawTarget.createdBy) ? { createdBy: rawTarget.createdBy } : {})
  };
}

function getTerritoryTargetAction(rawTarget: Record<string, unknown>): TerritoryControlAction | null {
  if (isExpansionControlAction(rawTarget.action)) {
    return rawTarget.action;
  }

  return isExpansionControlAction(rawTarget.actionHint) ? rawTarget.actionHint : null;
}

function isExpansionControlAction(action: unknown): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
}

function isTerritoryAutomationSource(source: unknown): source is TerritoryAutomationSource {
  return (
    source === 'occupationRecommendation' ||
    source === 'autonomousExpansionClaim' ||
    source === 'colonyExpansion' ||
    source === 'expansionPlanner' ||
    source === 'nextExpansionScoring' ||
    source === 'adjacentRoomReservation'
  );
}

function getNearestOwnedRoomDistance(ownedRoomNames: Set<string>, roomName: string): number | null {
  let nearestDistance: number | null = null;
  for (const ownedRoomName of ownedRoomNames) {
    const distance = getRouteDistance(ownedRoomName, roomName);
    if (distance === null) {
      continue;
    }

    if (nearestDistance === null || distance < nearestDistance) {
      nearestDistance = distance;
    }
  }

  return nearestDistance;
}

function getRouteDistance(fromRoom: string, targetRoom: string): number | null {
  if (fromRoom === targetRoom) {
    return 0;
  }

  if (getAdjacentRoomNames(fromRoom).includes(targetRoom)) {
    return 1;
  }

  const route = (globalThis as { Game?: Partial<Game> }).Game?.map?.findRoute?.(fromRoom, targetRoom);
  if (Array.isArray(route)) {
    return route.length;
  }

  return route === ERR_NO_PATH_CODE ? null : null;
}

function getAdjacentRoomNames(roomName: string): string[] {
  const describeExits = (globalThis as { Game?: Partial<Game> }).Game?.map?.describeExits;
  if (typeof describeExits !== 'function') {
    return [];
  }

  const exits = describeExits(roomName) as Record<string, string> | null;
  if (!isRecord(exits)) {
    return [];
  }

  const orderedRooms = EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const adjacentRoom = exits[direction];
    return isNonEmptyString(adjacentRoom) ? [adjacentRoom] : [];
  });
  const remainingRooms = Object.entries(exits)
    .filter(([direction, adjacentRoom]) => !EXIT_DIRECTION_ORDER.includes(direction) && isNonEmptyString(adjacentRoom))
    .map(([, adjacentRoom]) => adjacentRoom)
    .sort();

  return [...orderedRooms, ...remainingRooms];
}

function getVisibleOwnedRoomNames(colonyName: string, ownerUsername: string | undefined): Set<string> {
  const rooms = getGameRooms();
  const roomNames = new Set<string>([colonyName]);
  if (!rooms) {
    return roomNames;
  }

  for (const room of Object.values(rooms)) {
    if (!room || !isNonEmptyString(room.name) || room.controller?.my !== true) {
      continue;
    }

    const roomOwnerUsername = getControllerOwnerUsername(room.controller);
    if (!ownerUsername || !roomOwnerUsername || ownerUsername === roomOwnerUsername) {
      roomNames.add(room.name);
    }
  }

  return roomNames;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  if (isNonEmptyString(username)) {
    return username;
  }

  return controller?.my === true ? 'me' : undefined;
}

function getVisibleColonyOwnerUsername(colony: string): string | undefined {
  return getControllerOwnerUsername(getGameRooms()?.[colony]?.controller);
}

function getControllerReservationUsername(controller: StructureController | undefined): string | undefined {
  const username = (controller as (StructureController & { reservation?: { username?: string } }) | undefined)
    ?.reservation?.username;
  return isNonEmptyString(username) ? username : undefined;
}

function isControllerOwnedByUsername(
  controller: StructureController | undefined,
  ownerUsername: string | undefined
): boolean {
  const controllerOwnerUsername = getControllerOwnerUsername(controller);
  return (
    controller?.my === true ||
    (isNonEmptyString(ownerUsername) &&
      isNonEmptyString(controllerOwnerUsername) &&
      controllerOwnerUsername === ownerUsername)
  );
}

function isControllerOwned(controller: StructureController | undefined): boolean {
  return controller?.my === true || controller?.owner != null;
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

function getGclLevel(): number | null {
  const level = (globalThis as { Game?: Partial<Game> & { gcl?: { level?: number } } }).Game?.gcl?.level;
  return typeof level === 'number' && Number.isFinite(level) && level > 0 ? Math.floor(level) : null;
}

function getGameTime(): number {
  const time = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof time === 'number' && Number.isFinite(time) ? time : 0;
}

function getGameRooms(): Record<string, Room> | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms as Record<string, Room> | undefined;
}

function getWritableTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = getMemoryRecord();
  if (!memory) {
    return null;
  }

  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }

  return memory.territory as TerritoryMemory;
}

function getTerritoryMemoryRecord(): TerritoryMemory | null {
  const memory = getMemoryRecord();
  if (!memory || !isRecord(memory.territory)) {
    return null;
  }

  return memory.territory as TerritoryMemory;
}

function getMemoryRecord(): Partial<Memory> | undefined {
  return (globalThis as { Memory?: Partial<Memory> }).Memory;
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
