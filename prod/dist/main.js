"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  loop: () => loop
});
module.exports = __toCommonJS(main_exports);

// src/memory/schema.ts
var MEMORY_SCHEMA_VERSION = 1;
function initializeMemory() {
  if (!Memory.meta) {
    Memory.meta = { version: MEMORY_SCHEMA_VERSION };
  }
  if (!Memory.creeps) {
    Memory.creeps = {};
  }
}
function cleanupDeadCreepMemory() {
  for (const creepName of Object.keys(Memory.creeps || {})) {
    if (!Game.creeps[creepName]) {
      delete Memory.creeps[creepName];
    }
  }
}

// src/colony/colonyRegistry.ts
function getOwnedColonies() {
  return Object.values(Game.rooms).filter((room) => {
    var _a;
    return (_a = room.controller) == null ? void 0 : _a.my;
  }).map((room) => ({
    room,
    spawns: Object.values(Game.spawns).filter((spawn) => spawn.room.name === room.name),
    energyAvailable: room.energyAvailable,
    energyCapacityAvailable: room.energyCapacityAvailable
  }));
}

// src/construction/extensionPlanner.ts
var EXTENSION_LIMITS_BY_RCL = {
  2: 5,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 60
};
var MAX_EXTENSION_PLANNER_RADIUS = 6;
var ROOM_EDGE_MIN = 1;
var ROOM_EDGE_MAX = 48;
var DEFAULT_TERRAIN_WALL_MASK = 1;
function planExtensionConstruction(colony) {
  var _a;
  const allowedExtensions = getExtensionLimitForRcl((_a = colony.room.controller) == null ? void 0 : _a.level);
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
function getExtensionLimitForRcl(level) {
  var _a;
  return level ? (_a = EXTENSION_LIMITS_BY_RCL[level]) != null ? _a : 0 : 0;
}
function countExistingAndPendingExtensions(room) {
  const existingExtensions = room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => structure.structureType === STRUCTURE_EXTENSION
  });
  const pendingExtensions = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (site) => site.structureType === STRUCTURE_EXTENSION
  });
  return existingExtensions.length + pendingExtensions.length;
}
function selectExtensionAnchor(colony) {
  var _a, _b, _c;
  const [primarySpawn] = colony.spawns.filter((spawn) => spawn.pos).sort((left, right) => left.name.localeCompare(right.name));
  return (_c = (_b = primarySpawn == null ? void 0 : primarySpawn.pos) != null ? _b : (_a = colony.room.controller) == null ? void 0 : _a.pos) != null ? _c : null;
}
function findNextExtensionPosition(room, anchor) {
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
function createPlannerLookups(room, anchor) {
  const bounds = getScanBounds(anchor);
  return {
    terrain: Game.map.getRoomTerrain(room.name),
    blockingPositions: getBlockingPositions(room, bounds),
    reservedWalkwayPositions: getReservedWalkwayPositions(anchor)
  };
}
function getScanBounds(anchor) {
  return {
    top: Math.max(ROOM_EDGE_MIN, anchor.y - MAX_EXTENSION_PLANNER_RADIUS),
    left: Math.max(ROOM_EDGE_MIN, anchor.x - MAX_EXTENSION_PLANNER_RADIUS),
    bottom: Math.min(ROOM_EDGE_MAX, anchor.y + MAX_EXTENSION_PLANNER_RADIUS),
    right: Math.min(ROOM_EDGE_MAX, anchor.x + MAX_EXTENSION_PLANNER_RADIUS)
  };
}
function getBlockingPositions(room, bounds) {
  const blockingPositions = /* @__PURE__ */ new Set();
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
function canPlaceExtension(lookups, anchorParity, position) {
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
function getReservedWalkwayPositions(anchor) {
  return new Set(
    [
      { x: anchor.x, y: anchor.y - 1 },
      { x: anchor.x + 1, y: anchor.y },
      { x: anchor.x, y: anchor.y + 1 },
      { x: anchor.x - 1, y: anchor.y }
    ].filter((position) => isWithinRoomBounds(position)).map(getPositionKey)
  );
}
function isWithinRoomBounds(position) {
  return position.x >= ROOM_EDGE_MIN && position.x <= ROOM_EDGE_MAX && position.y >= ROOM_EDGE_MIN && position.y <= ROOM_EDGE_MAX;
}
function getPositionParity(position) {
  return (position.x + position.y) % 2;
}
function isTerrainWall(terrain, position) {
  return (terrain.get(position.x, position.y) & getTerrainWallMask()) !== 0;
}
function getPositionKey(position) {
  return `${position.x},${position.y}`;
}
function getTerrainWallMask() {
  return typeof TERRAIN_MASK_WALL === "number" ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK;
}

// src/construction/roadPlanner.ts
var DEFAULT_MAX_ROAD_SITES_PER_TICK = 1;
var DEFAULT_MAX_PENDING_ROAD_SITES = 3;
var DEFAULT_MAX_ROAD_TARGETS_PER_TICK = 3;
var DEFAULT_MAX_PATH_OPS_PER_TARGET = 1e3;
var MIN_CONTROLLER_LEVEL_FOR_ROADS = 2;
var ROOM_EDGE_MIN2 = 1;
var ROOM_EDGE_MAX2 = 48;
var ROOM_COORDINATE_MIN = 0;
var ROOM_COORDINATE_MAX = 49;
var DEFAULT_TERRAIN_WALL_MASK2 = 1;
var PATH_BLOCKED_COST = 255;
var ROAD_PATH_COST = 1;
var PLAIN_PATH_COST = 2;
var SWAMP_PATH_COST = 10;
function planEarlyRoadConstruction(colony, options = {}) {
  var _a, _b;
  const limits = resolveRoadPlannerLimits(options);
  if (limits.maxSitesPerTick <= 0 || limits.maxPendingRoadSites <= 0 || ((_b = (_a = colony.room.controller) == null ? void 0 : _a.level) != null ? _b : 0) < MIN_CONTROLLER_LEVEL_FOR_ROADS || !isPathFinderAvailable() || !hasRequiredRoomApis(colony.room)) {
    return [];
  }
  const anchor = selectRoadAnchor(colony);
  if (!anchor) {
    return [];
  }
  const pendingRoadSites = countPendingRoadConstructionSites(colony.room);
  const remainingSiteBudget = Math.min(limits.maxSitesPerTick, limits.maxPendingRoadSites - pendingRoadSites);
  if (remainingSiteBudget <= 0) {
    return [];
  }
  const targets = selectRoadTargets(colony.room, limits.maxTargetsPerTick);
  if (targets.length === 0) {
    return [];
  }
  const lookups = createRoadPlannerLookups(colony.room);
  if (!lookups) {
    return [];
  }
  const candidates = selectRoadCandidates(colony.room.name, anchor.pos, targets, lookups, limits);
  const results = [];
  for (const candidate of candidates) {
    if (results.length >= remainingSiteBudget) {
      break;
    }
    if (!canPlaceRoad(lookups, candidate)) {
      continue;
    }
    const result = colony.room.createConstructionSite(candidate.x, candidate.y, getRoadStructureType());
    results.push(result);
    if (result !== getOkCode()) {
      break;
    }
    lookups.pendingRoadSitePositions.add(candidate.key);
    lookups.costMatrix.set(candidate.x, candidate.y, ROAD_PATH_COST);
  }
  return results;
}
function resolveRoadPlannerLimits(options) {
  return {
    maxSitesPerTick: resolveNonNegativeInteger(options.maxSitesPerTick, DEFAULT_MAX_ROAD_SITES_PER_TICK),
    maxPendingRoadSites: resolveNonNegativeInteger(options.maxPendingRoadSites, DEFAULT_MAX_PENDING_ROAD_SITES),
    maxTargetsPerTick: resolveNonNegativeInteger(options.maxTargetsPerTick, DEFAULT_MAX_ROAD_TARGETS_PER_TICK),
    maxPathOpsPerTarget: resolveNonNegativeInteger(options.maxPathOpsPerTarget, DEFAULT_MAX_PATH_OPS_PER_TARGET)
  };
}
function resolveNonNegativeInteger(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}
function isPathFinderAvailable() {
  return typeof PathFinder !== "undefined" && typeof PathFinder.search === "function" && typeof PathFinder.CostMatrix === "function";
}
function hasRequiredRoomApis(room) {
  const partialRoom = room;
  return typeof partialRoom.find === "function" && typeof partialRoom.createConstructionSite === "function";
}
function selectRoadAnchor(colony) {
  const [primarySpawn] = colony.spawns.filter((spawn) => spawn.pos).sort((left, right) => left.name.localeCompare(right.name));
  return primarySpawn != null ? primarySpawn : null;
}
function selectRoadTargets(room, maxTargets) {
  var _a;
  if (maxTargets <= 0) {
    return [];
  }
  const targets = getSortedSources(room).map((source) => ({
    pos: source.pos
  }));
  if (((_a = room.controller) == null ? void 0 : _a.pos) && isSameRoomPosition(room.controller.pos, room.name)) {
    targets.push({ pos: room.controller.pos });
  }
  return targets.filter((target) => isSameRoomPosition(target.pos, room.name)).slice(0, maxTargets);
}
function getSortedSources(room) {
  if (typeof FIND_SOURCES !== "number") {
    return [];
  }
  return room.find(FIND_SOURCES).filter((source) => source.pos && isSameRoomPosition(source.pos, room.name)).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}
function countPendingRoadConstructionSites(room) {
  if (typeof FIND_MY_CONSTRUCTION_SITES !== "number") {
    return 0;
  }
  return room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: isRoadConstructionSite
  }).length;
}
function createRoadPlannerLookups(room) {
  if (typeof FIND_STRUCTURES !== "number" || typeof FIND_CONSTRUCTION_SITES !== "number") {
    return null;
  }
  const terrain = getRoomTerrain(room);
  if (!terrain) {
    return null;
  }
  const lookups = {
    terrain,
    costMatrix: new PathFinder.CostMatrix(),
    blockingPositions: /* @__PURE__ */ new Set(),
    existingRoadPositions: /* @__PURE__ */ new Set(),
    pendingRoadSitePositions: /* @__PURE__ */ new Set(),
    pathBlockedPositions: /* @__PURE__ */ new Set()
  };
  blockRoomEdges(lookups);
  cacheRoomStructures(room, lookups);
  cacheRoomConstructionSites(room, lookups);
  return lookups;
}
function getRoomTerrain(room) {
  const game = globalThis.Game;
  if (!(game == null ? void 0 : game.map) || typeof game.map.getRoomTerrain !== "function") {
    return null;
  }
  return game.map.getRoomTerrain(room.name);
}
function blockRoomEdges(lookups) {
  for (let coordinate = ROOM_COORDINATE_MIN; coordinate <= ROOM_COORDINATE_MAX; coordinate += 1) {
    blockPathPosition(lookups, { x: ROOM_COORDINATE_MIN, y: coordinate });
    blockPathPosition(lookups, { x: ROOM_COORDINATE_MAX, y: coordinate });
    blockPathPosition(lookups, { x: coordinate, y: ROOM_COORDINATE_MIN });
    blockPathPosition(lookups, { x: coordinate, y: ROOM_COORDINATE_MAX });
  }
}
function cacheRoomStructures(room, lookups) {
  for (const structure of room.find(FIND_STRUCTURES)) {
    const position = structure.pos;
    if (!position || !isSameRoomPosition(position, room.name)) {
      continue;
    }
    const key = getPositionKey2(position);
    if (isRoadStructure(structure)) {
      lookups.existingRoadPositions.add(key);
      setRoadPathCostIfOpen(lookups, position);
      continue;
    }
    lookups.blockingPositions.add(key);
    blockPathPosition(lookups, position);
  }
}
function cacheRoomConstructionSites(room, lookups) {
  for (const constructionSite of room.find(FIND_CONSTRUCTION_SITES)) {
    const position = constructionSite.pos;
    if (!position || !isSameRoomPosition(position, room.name)) {
      continue;
    }
    const key = getPositionKey2(position);
    if (isRoadConstructionSite(constructionSite)) {
      lookups.pendingRoadSitePositions.add(key);
      setRoadPathCostIfOpen(lookups, position);
      continue;
    }
    lookups.blockingPositions.add(key);
    blockPathPosition(lookups, position);
  }
}
function selectRoadCandidates(roomName, origin, targets, lookups, limits) {
  const candidates = /* @__PURE__ */ new Map();
  targets.forEach((target, targetIndex) => {
    const path = findRoadPath(roomName, origin, target, lookups, limits);
    const seenInRoute = /* @__PURE__ */ new Set();
    path.forEach((position, pathIndex) => {
      if (!isSameRoomPosition(position, roomName) || !canPlaceRoad(lookups, position)) {
        return;
      }
      const key = getPositionKey2(position);
      if (seenInRoute.has(key)) {
        return;
      }
      seenInRoute.add(key);
      const existingCandidate = candidates.get(key);
      if (existingCandidate) {
        existingCandidate.routeCount += 1;
        existingCandidate.minPathIndex = Math.min(existingCandidate.minPathIndex, pathIndex);
        existingCandidate.minTargetIndex = Math.min(existingCandidate.minTargetIndex, targetIndex);
        return;
      }
      candidates.set(key, {
        x: position.x,
        y: position.y,
        key,
        routeCount: 1,
        minPathIndex: pathIndex,
        minTargetIndex: targetIndex
      });
    });
  });
  return [...candidates.values()].sort(compareRoadCandidates);
}
function findRoadPath(roomName, origin, target, lookups, limits) {
  const result = PathFinder.search(origin, { pos: target.pos, range: 1 }, {
    maxRooms: 1,
    maxOps: limits.maxPathOpsPerTarget,
    plainCost: PLAIN_PATH_COST,
    swampCost: SWAMP_PATH_COST,
    roomCallback: (callbackRoomName) => callbackRoomName === roomName ? lookups.costMatrix : false
  });
  return result.incomplete ? [] : result.path;
}
function compareRoadCandidates(left, right) {
  return right.routeCount - left.routeCount || left.minPathIndex - right.minPathIndex || left.minTargetIndex - right.minTargetIndex || left.y - right.y || left.x - right.x;
}
function canPlaceRoad(lookups, position) {
  if (!isWithinBuildableRoomBounds(position) || isTerrainWall2(lookups.terrain, position)) {
    return false;
  }
  const key = getPositionKey2(position);
  return !lookups.blockingPositions.has(key) && !lookups.existingRoadPositions.has(key) && !lookups.pendingRoadSitePositions.has(key);
}
function blockPathPosition(lookups, position) {
  lookups.pathBlockedPositions.add(getPositionKey2(position));
  lookups.costMatrix.set(position.x, position.y, PATH_BLOCKED_COST);
}
function setRoadPathCostIfOpen(lookups, position) {
  if (!lookups.pathBlockedPositions.has(getPositionKey2(position))) {
    lookups.costMatrix.set(position.x, position.y, ROAD_PATH_COST);
  }
}
function isWithinBuildableRoomBounds(position) {
  return position.x >= ROOM_EDGE_MIN2 && position.x <= ROOM_EDGE_MAX2 && position.y >= ROOM_EDGE_MIN2 && position.y <= ROOM_EDGE_MAX2;
}
function isSameRoomPosition(position, roomName) {
  return !position.roomName || position.roomName === roomName;
}
function isTerrainWall2(terrain, position) {
  return (terrain.get(position.x, position.y) & getTerrainWallMask2()) !== 0;
}
function isRoadStructure(structure) {
  return matchesStructureType(structure.structureType, "STRUCTURE_ROAD", "road");
}
function isRoadConstructionSite(site) {
  return matchesStructureType(site.structureType, "STRUCTURE_ROAD", "road");
}
function matchesStructureType(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}
function getRoadStructureType() {
  var _a;
  const constants = globalThis;
  return (_a = constants.STRUCTURE_ROAD) != null ? _a : "road";
}
function getPositionKey2(position) {
  return `${position.x},${position.y}`;
}
function getTerrainWallMask2() {
  return typeof TERRAIN_MASK_WALL === "number" ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK2;
}
function getOkCode() {
  return typeof OK === "number" ? OK : 0;
}

// src/creeps/roleCounts.ts
var WORKER_REPLACEMENT_TICKS_TO_LIVE = 100;
function countCreepsByRole(creeps, colonyName) {
  const counts = creeps.reduce(
    (counts2, creep) => {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
      if (isColonyWorker(creep, colonyName)) {
        counts2.worker += 1;
        if (canSatisfyRoleCapacity(creep)) {
          counts2.workerCapacity = ((_a = counts2.workerCapacity) != null ? _a : 0) + 1;
        }
      }
      if (isColonyClaimer(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts2.claimer = ((_b = counts2.claimer) != null ? _b : 0) + 1;
        const targetRoom = (_c = creep.memory.territory) == null ? void 0 : _c.targetRoom;
        if (targetRoom) {
          const claimersByTargetRoom = (_d = counts2.claimersByTargetRoom) != null ? _d : {};
          claimersByTargetRoom[targetRoom] = ((_e = claimersByTargetRoom[targetRoom]) != null ? _e : 0) + 1;
          counts2.claimersByTargetRoom = claimersByTargetRoom;
          incrementTargetRoomActionCount(counts2, (_f = creep.memory.territory) == null ? void 0 : _f.action, targetRoom);
        }
      }
      if (isColonyScout(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts2.scout = ((_g = counts2.scout) != null ? _g : 0) + 1;
        const targetRoom = (_h = creep.memory.territory) == null ? void 0 : _h.targetRoom;
        if (targetRoom) {
          const scoutsByTargetRoom = (_i = counts2.scoutsByTargetRoom) != null ? _i : {};
          scoutsByTargetRoom[targetRoom] = ((_j = scoutsByTargetRoom[targetRoom]) != null ? _j : 0) + 1;
          counts2.scoutsByTargetRoom = scoutsByTargetRoom;
        }
      }
      return counts2;
    },
    { worker: 0, workerCapacity: 0, claimer: 0, claimersByTargetRoom: {} }
  );
  if (counts.workerCapacity === counts.worker) {
    delete counts.workerCapacity;
  }
  return counts;
}
function getWorkerCapacity(roleCounts) {
  var _a;
  return (_a = roleCounts.workerCapacity) != null ? _a : roleCounts.worker;
}
function incrementTargetRoomActionCount(counts, action, targetRoom) {
  var _a, _b, _c;
  if (action !== "claim" && action !== "reserve") {
    return;
  }
  const claimersByTargetRoomAction = (_a = counts.claimersByTargetRoomAction) != null ? _a : {};
  const claimersForAction = (_b = claimersByTargetRoomAction[action]) != null ? _b : {};
  claimersForAction[targetRoom] = ((_c = claimersForAction[targetRoom]) != null ? _c : 0) + 1;
  claimersByTargetRoomAction[action] = claimersForAction;
  counts.claimersByTargetRoomAction = claimersByTargetRoomAction;
}
function isColonyWorker(creep, colonyName) {
  return creep.memory.colony === colonyName && creep.memory.role === "worker";
}
function isColonyClaimer(creep, colonyName) {
  return creep.memory.colony === colonyName && creep.memory.role === "claimer";
}
function isColonyScout(creep, colonyName) {
  return creep.memory.colony === colonyName && creep.memory.role === "scout";
}
function canSatisfyRoleCapacity(creep) {
  return creep.ticksToLive === void 0 || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}

// src/spawn/bodyBuilder.ts
var WORKER_PATTERN = ["work", "carry", "move"];
var WORKER_PATTERN_COST = 200;
var WORKER_LOGISTICS_PAIR = ["carry", "move"];
var WORKER_LOGISTICS_PAIR_COST = 100;
var TERRITORY_CONTROLLER_BODY = ["claim", "move"];
var TERRITORY_CONTROLLER_BODY_COST = 650;
var MAX_CREEP_PARTS = 50;
var MAX_WORKER_PATTERN_COUNT = 4;
var BODY_PART_COSTS = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10
};
function buildWorkerBody(energyAvailable) {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }
  const maxPatternCountByEnergy = Math.floor(energyAvailable / WORKER_PATTERN_COST);
  const maxPatternCountBySize = Math.floor(MAX_CREEP_PARTS / WORKER_PATTERN.length);
  const patternCount = Math.min(maxPatternCountByEnergy, maxPatternCountBySize, MAX_WORKER_PATTERN_COUNT);
  const body = Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
  if (shouldAddWorkerLogisticsPair(energyAvailable, patternCount, body.length)) {
    return [...body, ...WORKER_LOGISTICS_PAIR];
  }
  return body;
}
function shouldAddWorkerLogisticsPair(energyAvailable, patternCount, bodyPartCount) {
  const remainingEnergy = energyAvailable - patternCount * WORKER_PATTERN_COST;
  return patternCount >= 2 && patternCount < MAX_WORKER_PATTERN_COUNT && remainingEnergy >= WORKER_LOGISTICS_PAIR_COST && bodyPartCount + WORKER_LOGISTICS_PAIR.length <= MAX_CREEP_PARTS;
}
function buildEmergencyWorkerBody(energyAvailable) {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }
  return [...WORKER_PATTERN];
}
function buildTerritoryControllerBody(energyAvailable) {
  if (energyAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return [];
  }
  return [...TERRITORY_CONTROLLER_BODY];
}
function getBodyCost(body) {
  return body.reduce((cost, part) => cost + BODY_PART_COSTS[part], 0);
}

// src/territory/occupationRecommendation.ts
var EXIT_DIRECTION_ORDER = ["1", "3", "5", "7"];
var TERRITORY_BODY_ENERGY_CAPACITY = 650;
var MIN_READY_WORKERS = 3;
var DOWNGRADE_GUARD_TICKS = 5e3;
var RESERVATION_RENEWAL_TICKS = 1e3;
var TERRITORY_SUPPRESSION_RETRY_TICKS = 1500;
var TERRITORY_ROUTE_DISTANCE_SEPARATOR = ">";
var ACTION_SCORE = {
  occupy: 1e3,
  reserve: 800,
  scout: 420
};
function buildRuntimeOccupationRecommendationReport(colony, colonyWorkers) {
  return scoreOccupationRecommendations(buildRuntimeOccupationRecommendationInput(colony, colonyWorkers));
}
function scoreOccupationRecommendations(input) {
  var _a;
  const candidates = input.candidates.filter((candidate) => candidate.roomName !== input.colonyName).map((candidate) => scoreOccupationCandidate(input, candidate)).sort(compareOccupationRecommendationScores);
  const next = (_a = candidates.find((candidate) => candidate.evidenceStatus !== "unavailable")) != null ? _a : null;
  return { candidates, next, followUpIntent: buildOccupationRecommendationFollowUpIntent(input, next) };
}
function persistOccupationRecommendationFollowUpIntent(report, gameTime = getGameTime()) {
  var _a, _b;
  const followUpIntent = report.followUpIntent;
  if (!followUpIntent) {
    return null;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find((intent) => isSameTerritoryIntent(intent, followUpIntent));
  if (existingIntent && isTerritorySuppressionFresh(existingIntent, gameTime)) {
    return null;
  }
  const controllerId = (_a = followUpIntent.controllerId) != null ? _a : existingIntent == null ? void 0 : existingIntent.controllerId;
  const followUp = (_b = normalizeTerritoryFollowUp(followUpIntent.followUp)) != null ? _b : existingIntent == null ? void 0 : existingIntent.followUp;
  const nextIntent = {
    colony: followUpIntent.colony,
    targetRoom: followUpIntent.targetRoom,
    action: followUpIntent.action,
    status: (existingIntent == null ? void 0 : existingIntent.status) === "active" ? "active" : "planned",
    updatedAt: gameTime,
    ...controllerId ? { controllerId } : {},
    ...followUp ? { followUp } : {}
  };
  upsertTerritoryIntent(intents, nextIntent);
  return nextIntent;
}
function buildRuntimeOccupationRecommendationInput(colony, colonyWorkers) {
  var _a, _b;
  const colonyName = colony.room.name;
  return {
    colonyName,
    colonyOwnerUsername: getControllerOwnerUsername(colony.room.controller),
    energyCapacityAvailable: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    ...typeof ((_a = colony.room.controller) == null ? void 0 : _a.level) === "number" ? { controllerLevel: colony.room.controller.level } : {},
    ...typeof ((_b = colony.room.controller) == null ? void 0 : _b.ticksToDowngrade) === "number" ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade } : {},
    candidates: buildRuntimeOccupationCandidates(colonyName)
  };
}
function buildRuntimeOccupationCandidates(colonyName) {
  const candidatesByRoom = /* @__PURE__ */ new Map();
  const territoryMemory = getTerritoryMemoryRecord();
  let order = 0;
  if (Array.isArray(territoryMemory == null ? void 0 : territoryMemory.targets)) {
    for (const rawTarget of territoryMemory.targets) {
      const target = normalizeTerritoryTarget(rawTarget);
      if (!target || target.colony !== colonyName || target.enabled === false) {
        continue;
      }
      upsertOccupationCandidate(candidatesByRoom, {
        roomName: target.roomName,
        source: "configured",
        order,
        adjacent: false,
        visible: false,
        actionHint: target.action,
        ...target.controllerId ? { controllerId: target.controllerId } : {},
        routeDistance: getCachedRouteDistance(colonyName, target.roomName)
      });
      order += 1;
    }
  }
  for (const roomName of getAdjacentRoomNames(colonyName)) {
    const cachedRouteDistance = getCachedRouteDistance(colonyName, roomName);
    upsertOccupationCandidate(candidatesByRoom, {
      roomName,
      source: "adjacent",
      order,
      adjacent: true,
      visible: false,
      routeDistance: cachedRouteDistance === void 0 ? 1 : cachedRouteDistance
    });
    order += 1;
  }
  return Array.from(candidatesByRoom.values()).map(enrichVisibleOccupationCandidate);
}
function upsertOccupationCandidate(candidatesByRoom, candidate) {
  const existing = candidatesByRoom.get(candidate.roomName);
  if (!existing) {
    candidatesByRoom.set(candidate.roomName, candidate);
    return;
  }
  if (candidate.source === "configured" && existing.source !== "configured") {
    existing.source = "configured";
    existing.actionHint = candidate.actionHint;
    if (candidate.controllerId) {
      existing.controllerId = candidate.controllerId;
    }
    existing.order = Math.min(existing.order, candidate.order);
  }
  existing.adjacent = existing.adjacent || candidate.adjacent;
  if (!existing.controllerId && candidate.controllerId) {
    existing.controllerId = candidate.controllerId;
  }
  if (existing.routeDistance === void 0 && candidate.routeDistance !== void 0) {
    existing.routeDistance = candidate.routeDistance;
  }
}
function enrichVisibleOccupationCandidate(candidate) {
  var _a;
  const room = (_a = getGameRooms()) == null ? void 0 : _a[candidate.roomName];
  if (!room) {
    return candidate;
  }
  const hostileCreeps = findRoomObjects(room, "FIND_HOSTILE_CREEPS");
  const hostileStructures = findRoomObjects(room, "FIND_HOSTILE_STRUCTURES");
  const sources = findRoomObjects(room, "FIND_SOURCES");
  const constructionSites = findRoomObjects(room, "FIND_MY_CONSTRUCTION_SITES");
  const ownedStructures = findRoomObjects(room, "FIND_MY_STRUCTURES");
  return {
    ...candidate,
    visible: true,
    ...room.controller ? { controller: summarizeController(room.controller) } : {},
    ...sources ? { sourceCount: sources.length } : {},
    ...hostileCreeps ? { hostileCreepCount: hostileCreeps.length } : {},
    ...hostileStructures ? { hostileStructureCount: hostileStructures.length } : {},
    ...constructionSites ? { constructionSiteCount: constructionSites.length } : {},
    ...ownedStructures ? { ownedStructureCount: ownedStructures.length } : {}
  };
}
function scoreOccupationCandidate(input, candidate) {
  var _a, _b;
  const evidence = [];
  const preconditions = getColonyReadinessPreconditions(input);
  const risks = [];
  const routeDistance = typeof candidate.routeDistance === "number" ? candidate.routeDistance : void 0;
  let action = "scout";
  let evidenceStatus = "sufficient";
  if (candidate.routeDistance === null) {
    risks.push("no known route from colony");
    evidenceStatus = "unavailable";
  } else if (!candidate.visible) {
    evidence.push("room visibility missing");
    risks.push("controller, source, and hostile evidence unavailable");
    evidenceStatus = "insufficient-evidence";
  } else if (!candidate.controller) {
    evidence.push("room visible");
    risks.push("visible room has no controller");
    evidenceStatus = "unavailable";
  } else {
    evidence.push("room visible", "controller visible");
    const unavailableReason = getControllerUnavailableReason(input, candidate.controller);
    if (unavailableReason) {
      risks.push(unavailableReason);
      evidenceStatus = "unavailable";
      action = candidate.actionHint === "claim" ? "occupy" : "reserve";
    } else if (isOwnHealthyReservation(input, candidate.controller)) {
      evidence.push("own reservation is healthy");
      evidenceStatus = "unavailable";
      action = "reserve";
    } else if (isOwnReservationDueForRenewal(input, candidate.controller)) {
      evidence.push("own reservation needs renewal");
      action = "reserve";
    } else if (candidate.sourceCount === void 0) {
      evidence.push("controller is available");
      risks.push("source count evidence missing");
      evidenceStatus = "insufficient-evidence";
    } else {
      evidence.push("controller is available", `${candidate.sourceCount} sources visible`);
      action = candidate.actionHint === "claim" ? "occupy" : "reserve";
    }
  }
  const hostileCreepCount = (_a = candidate.hostileCreepCount) != null ? _a : 0;
  const hostileStructureCount = (_b = candidate.hostileStructureCount) != null ? _b : 0;
  if (hostileCreepCount > 0 || hostileStructureCount > 0) {
    risks.push("hostile presence visible");
    evidenceStatus = "unavailable";
  }
  const score = calculateOccupationScore(input, candidate, action, evidenceStatus);
  return {
    roomName: candidate.roomName,
    action,
    score,
    evidenceStatus,
    source: candidate.source,
    evidence,
    preconditions,
    risks,
    ...routeDistance !== void 0 ? { routeDistance } : {},
    ...candidate.controllerId ? { controllerId: candidate.controllerId } : {},
    ...candidate.sourceCount !== void 0 ? { sourceCount: candidate.sourceCount } : {},
    ...candidate.hostileCreepCount !== void 0 ? { hostileCreepCount: candidate.hostileCreepCount } : {},
    ...candidate.hostileStructureCount !== void 0 ? { hostileStructureCount: candidate.hostileStructureCount } : {}
  };
}
function buildOccupationRecommendationFollowUpIntent(input, next) {
  if (!next) {
    return null;
  }
  return {
    colony: input.colonyName,
    targetRoom: next.roomName,
    action: getTerritoryIntentAction(next.action),
    ...next.controllerId ? { controllerId: next.controllerId } : {}
  };
}
function getTerritoryIntentAction(action) {
  return action === "occupy" ? "claim" : action;
}
function calculateOccupationScore(input, candidate, action, evidenceStatus) {
  var _a, _b, _c, _d, _e;
  const distanceScore = typeof candidate.routeDistance === "number" ? Math.max(0, 80 - candidate.routeDistance * 15) : 0;
  const sourceScore = typeof candidate.sourceCount === "number" ? Math.min(candidate.sourceCount, 2) * 70 : 0;
  const supportScore = Math.min((_a = candidate.ownedStructureCount) != null ? _a : 0, 3) * 8 + Math.min((_b = candidate.constructionSiteCount) != null ? _b : 0, 3) * 5;
  const sourcePriorityScore = candidate.source === "configured" ? 50 : 25;
  const adjacencyScore = candidate.adjacent ? 25 : 0;
  const readinessScore = Math.min(input.workerCount, MIN_READY_WORKERS) * 12 + (input.energyCapacityAvailable >= TERRITORY_BODY_ENERGY_CAPACITY ? 30 : 0) + (((_c = input.controllerLevel) != null ? _c : 0) >= 2 ? 30 : 0) + (input.ticksToDowngrade === void 0 || input.ticksToDowngrade > DOWNGRADE_GUARD_TICKS ? 20 : 0);
  const riskPenalty = ((_d = candidate.hostileCreepCount) != null ? _d : 0) * 160 + ((_e = candidate.hostileStructureCount) != null ? _e : 0) * 120;
  const evidencePenalty = evidenceStatus === "insufficient-evidence" ? 260 : 0;
  const unavailablePenalty = evidenceStatus === "unavailable" ? 2e3 : 0;
  return ACTION_SCORE[action] + sourcePriorityScore + adjacencyScore + distanceScore + sourceScore + supportScore + readinessScore - riskPenalty - evidencePenalty - unavailablePenalty;
}
function getColonyReadinessPreconditions(input) {
  var _a;
  const preconditions = [];
  if (input.workerCount < MIN_READY_WORKERS) {
    preconditions.push("raise worker count before dispatching territory creeps");
  }
  if (input.energyCapacityAvailable < TERRITORY_BODY_ENERGY_CAPACITY) {
    preconditions.push("reach 650 energy capacity for controller work");
  }
  if (((_a = input.controllerLevel) != null ? _a : 0) < 2) {
    preconditions.push("reach controller level 2 before expansion");
  }
  if (typeof input.ticksToDowngrade === "number" && input.ticksToDowngrade <= DOWNGRADE_GUARD_TICKS) {
    preconditions.push("stabilize home controller downgrade timer");
  }
  return preconditions;
}
function getControllerUnavailableReason(input, controller) {
  if (isControllerOwnedByColony(input, controller)) {
    return "controller already owned by colony account";
  }
  if (controller.ownerUsername) {
    return "controller owned by another account";
  }
  if (controller.reservationUsername && controller.reservationUsername !== input.colonyOwnerUsername) {
    return "controller reserved by another account";
  }
  return null;
}
function isOwnHealthyReservation(input, controller) {
  return isOwnReservation(input, controller) && typeof controller.reservationTicksToEnd === "number" && controller.reservationTicksToEnd > RESERVATION_RENEWAL_TICKS;
}
function isOwnReservationDueForRenewal(input, controller) {
  return isOwnReservation(input, controller) && typeof controller.reservationTicksToEnd === "number" && controller.reservationTicksToEnd <= RESERVATION_RENEWAL_TICKS;
}
function isOwnReservation(input, controller) {
  return input.colonyOwnerUsername !== void 0 && controller.reservationUsername === input.colonyOwnerUsername;
}
function isControllerOwnedByColony(input, controller) {
  return controller.my === true || !!controller.ownerUsername && controller.ownerUsername === input.colonyOwnerUsername;
}
function compareOccupationRecommendationScores(left, right) {
  return right.score - left.score || getEvidenceStatusPriority(left.evidenceStatus) - getEvidenceStatusPriority(right.evidenceStatus) || getActionPriority(left.action) - getActionPriority(right.action) || getSourcePriority(left.source) - getSourcePriority(right.source) || compareOptionalNumbers(left.routeDistance, right.routeDistance) || left.roomName.localeCompare(right.roomName);
}
function getEvidenceStatusPriority(status) {
  if (status === "sufficient") {
    return 0;
  }
  return status === "insufficient-evidence" ? 1 : 2;
}
function getActionPriority(action) {
  if (action === "occupy") {
    return 0;
  }
  return action === "reserve" ? 1 : 2;
}
function getSourcePriority(source) {
  return source === "configured" ? 0 : 1;
}
function compareOptionalNumbers(left, right) {
  return (left != null ? left : Number.POSITIVE_INFINITY) - (right != null ? right : Number.POSITIVE_INFINITY);
}
function summarizeController(controller) {
  const ownerUsername = getControllerOwnerUsername(controller);
  const reservationUsername = getReservationUsername(controller);
  const reservationTicksToEnd = getReservationTicksToEnd(controller);
  return {
    ...controller.my === true ? { my: true } : {},
    ...ownerUsername ? { ownerUsername } : {},
    ...reservationUsername ? { reservationUsername } : {},
    ...typeof reservationTicksToEnd === "number" ? { reservationTicksToEnd } : {}
  };
}
function getAdjacentRoomNames(roomName) {
  var _a;
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (!gameMap || typeof gameMap.describeExits !== "function") {
    return [];
  }
  const exits = gameMap.describeExits(roomName);
  if (!isRecord(exits)) {
    return [];
  }
  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const exitRoom = exits[direction];
    return typeof exitRoom === "string" && exitRoom.length > 0 ? [exitRoom] : [];
  });
}
function normalizeTerritoryTarget(rawTarget) {
  if (!isRecord(rawTarget)) {
    return null;
  }
  if (typeof rawTarget.colony !== "string" || rawTarget.colony.length === 0 || typeof rawTarget.roomName !== "string" || rawTarget.roomName.length === 0 || rawTarget.action !== "claim" && rawTarget.action !== "reserve") {
    return null;
  }
  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action: rawTarget.action,
    ...typeof rawTarget.controllerId === "string" ? { controllerId: rawTarget.controllerId } : {},
    ...rawTarget.enabled === false ? { enabled: false } : {}
  };
}
function getCachedRouteDistance(fromRoom, targetRoom) {
  var _a;
  const routeDistances = (_a = getTerritoryMemoryRecord()) == null ? void 0 : _a.routeDistances;
  if (!isRecord(routeDistances)) {
    return void 0;
  }
  const distance = routeDistances[`${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`];
  return typeof distance === "number" || distance === null ? distance : void 0;
}
function findRoomObjects(room, constantName) {
  const findConstant = getGlobalNumber(constantName);
  const find = room.find;
  if (typeof findConstant !== "number" || typeof find !== "function") {
    return void 0;
  }
  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return void 0;
  }
}
function getGlobalNumber(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getControllerOwnerUsername(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return typeof username === "string" && username.length > 0 ? username : void 0;
}
function getReservationUsername(controller) {
  var _a;
  const username = (_a = controller.reservation) == null ? void 0 : _a.username;
  return typeof username === "string" && username.length > 0 ? username : void 0;
}
function getReservationTicksToEnd(controller) {
  var _a;
  const ticksToEnd = (_a = controller.reservation) == null ? void 0 : _a.ticksToEnd;
  return typeof ticksToEnd === "number" ? ticksToEnd : void 0;
}
function getGameRooms() {
  var _a;
  return (_a = globalThis.Game) == null ? void 0 : _a.rooms;
}
function getGameTime() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function getTerritoryMemoryRecord() {
  var _a;
  return (_a = globalThis.Memory) == null ? void 0 : _a.territory;
}
function getWritableTerritoryMemoryRecord() {
  const memory = globalThis.Memory;
  if (!memory) {
    return null;
  }
  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }
  return memory.territory;
}
function normalizeTerritoryIntents(rawIntents) {
  return Array.isArray(rawIntents) ? rawIntents.flatMap((intent) => {
    const normalizedIntent = normalizeTerritoryIntent(intent);
    return normalizedIntent ? [normalizedIntent] : [];
  }) : [];
}
function normalizeTerritoryIntent(rawIntent) {
  if (!isRecord(rawIntent)) {
    return null;
  }
  if (!isNonEmptyString(rawIntent.colony) || !isNonEmptyString(rawIntent.targetRoom) || !isTerritoryIntentAction(rawIntent.action) || !isTerritoryIntentStatus(rawIntent.status) || typeof rawIntent.updatedAt !== "number") {
    return null;
  }
  const followUp = normalizeTerritoryFollowUp(rawIntent.followUp);
  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...typeof rawIntent.controllerId === "string" ? { controllerId: rawIntent.controllerId } : {},
    ...followUp ? { followUp } : {}
  };
}
function normalizeTerritoryFollowUp(rawFollowUp) {
  if (!isRecord(rawFollowUp) || !isTerritoryFollowUpSource(rawFollowUp.source)) {
    return null;
  }
  const originAction = getTerritoryFollowUpOriginAction(rawFollowUp.source);
  if (!isNonEmptyString(rawFollowUp.originRoom) || rawFollowUp.originAction !== originAction) {
    return null;
  }
  return {
    source: rawFollowUp.source,
    originRoom: rawFollowUp.originRoom,
    originAction
  };
}
function getTerritoryFollowUpOriginAction(source) {
  return source === "satisfiedClaimAdjacent" ? "claim" : "reserve";
}
function upsertTerritoryIntent(intents, nextIntent) {
  const existingIndex = intents.findIndex((intent) => isSameTerritoryIntent(intent, nextIntent));
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }
  intents.push(nextIntent);
}
function isSameTerritoryIntent(intent, followUpIntent) {
  return intent.colony === followUpIntent.colony && intent.targetRoom === followUpIntent.targetRoom && intent.action === followUpIntent.action;
}
function isTerritorySuppressionFresh(intent, gameTime) {
  return intent.status === "suppressed" && gameTime - intent.updatedAt <= TERRITORY_SUPPRESSION_RETRY_TICKS;
}
function isTerritoryIntentAction(action) {
  return action === "claim" || action === "reserve" || action === "scout";
}
function isTerritoryIntentStatus(status) {
  return status === "planned" || status === "active" || status === "suppressed";
}
function isTerritoryFollowUpSource(source) {
  return source === "satisfiedClaimAdjacent" || source === "satisfiedReserveAdjacent" || source === "activeReserveAdjacent";
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// src/territory/territoryPlanner.ts
var TERRITORY_CLAIMER_ROLE = "claimer";
var TERRITORY_SCOUT_ROLE = "scout";
var TERRITORY_DOWNGRADE_GUARD_TICKS = 5e3;
var TERRITORY_RESERVATION_RENEWAL_TICKS = 1e3;
var TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS / 4;
var TERRITORY_RESERVATION_COMFORT_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS * 2;
var TERRITORY_SUPPRESSION_RETRY_TICKS2 = 1500;
var EXIT_DIRECTION_ORDER2 = ["1", "3", "5", "7"];
var MIN_CLAIM_PARTS_FOR_RESERVATION_PROGRESS = 2;
var ERR_NO_PATH_CODE = -2;
var TERRITORY_CANDIDATE_PRIORITY_URGENT_RENEWAL = 0;
var TERRITORY_CANDIDATE_PRIORITY_VISIBLE_CLAIM = 1;
var TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE = 2;
var TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_CLAIM = 3;
var TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_RESERVE = 4;
var TERRITORY_CANDIDATE_PRIORITY_SCOUT = 5;
var MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY = TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE;
var TERRITORY_ROUTE_DISTANCE_SEPARATOR2 = ">";
var TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET = 2;
function planTerritoryIntent(colony, roleCounts, workerTarget, gameTime) {
  if (!isTerritoryHomeSafe(colony, roleCounts, workerTarget)) {
    return null;
  }
  const selection = selectTerritoryTarget(colony, roleCounts, gameTime);
  if (!selection) {
    return null;
  }
  const target = selection.target;
  const plan = {
    colony: colony.room.name,
    targetRoom: target.roomName,
    action: selection.intentAction,
    ...target.controllerId ? { controllerId: target.controllerId } : {},
    ...selection.followUp ? { followUp: selection.followUp } : {}
  };
  const status = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) > 0 ? "active" : "planned";
  recordTerritoryIntent(plan, status, gameTime, selection.commitTarget ? target : null);
  return plan;
}
function shouldSpawnTerritoryControllerCreep(plan, roleCounts, gameTime = getGameTime2()) {
  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return false;
  }
  if (plan.action === "scout" && isVisibleRoomKnown(plan.targetRoom)) {
    return false;
  }
  if (getVisibleTerritoryTargetState(
    plan.targetRoom,
    plan.action,
    plan.controllerId,
    getVisibleColonyOwnerUsername(plan.colony)
  ) !== "available") {
    return false;
  }
  const activeCoverageCount = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action);
  return activeCoverageCount === 0 || shouldSpawnEmergencyReservationRenewal(plan, activeCoverageCount);
}
function buildTerritoryCreepMemory(plan) {
  return {
    role: plan.action === "scout" ? TERRITORY_SCOUT_ROLE : TERRITORY_CLAIMER_ROLE,
    colony: plan.colony,
    territory: {
      targetRoom: plan.targetRoom,
      action: plan.action,
      ...plan.controllerId ? { controllerId: plan.controllerId } : {},
      ...plan.followUp ? { followUp: plan.followUp } : {}
    }
  };
}
function selectVisibleTerritoryControllerTask(creep) {
  const intent = selectVisibleTerritoryControllerIntent(creep);
  if (!intent) {
    return null;
  }
  const controller = selectCreepRoomController(creep, intent.controllerId);
  if (!controller) {
    return null;
  }
  if (intent.action === "reserve") {
    return canCreepReserveTerritoryController(creep, controller, intent.colony) ? { type: "reserve", targetId: controller.id } : null;
  }
  if (controller.my === true) {
    return getStoredEnergy(creep) > 0 ? { type: "upgrade", targetId: controller.id } : null;
  }
  return canUseControllerClaimPart(creep) ? { type: "claim", targetId: controller.id } : null;
}
function canCreepReserveTerritoryController(creep, controller, colony) {
  const activeClaimParts = getActiveControllerClaimPartCount(creep);
  if (activeClaimParts <= 0) {
    return false;
  }
  if (isControllerOwned(controller)) {
    return false;
  }
  const reservation = controller.reservation;
  if (!reservation) {
    return true;
  }
  const actorUsername = getTerritoryActorUsername(creep, colony);
  if (!isNonEmptyString2(actorUsername) || !isNonEmptyString2(reservation.username) || reservation.username !== actorUsername || typeof reservation.ticksToEnd !== "number") {
    return false;
  }
  const reservationTicksToEnd = reservation.ticksToEnd;
  return reservationTicksToEnd <= TERRITORY_RESERVATION_COMFORT_TICKS && canRenewReservation(activeClaimParts, reservationTicksToEnd);
}
function selectUrgentVisibleReservationRenewalTask(creep) {
  const intent = selectVisibleTerritoryControllerIntent(creep);
  if (!intent || intent.action !== "reserve") {
    return null;
  }
  const activeClaimParts = getActiveControllerClaimPartCount(creep);
  if (activeClaimParts <= 0) {
    return null;
  }
  const controller = selectCreepRoomController(creep, intent.controllerId);
  if (!controller) {
    return null;
  }
  const reservationTicksToEnd = getUrgentOwnReservationTicksToEnd(
    controller,
    getTerritoryActorUsername(creep, intent.colony)
  );
  if (reservationTicksToEnd === null || !canRenewReservation(activeClaimParts, reservationTicksToEnd)) {
    return null;
  }
  return { type: "reserve", targetId: controller.id };
}
function isVisibleTerritoryAssignmentSafe(assignment, colony, creep) {
  if (!isNonEmptyString2(assignment.targetRoom)) {
    return false;
  }
  if (isVisibleRoomUnsafeForTerritoryControllerWork(assignment.targetRoom)) {
    return false;
  }
  if (assignment.action === "scout") {
    return true;
  }
  if (!isTerritoryControlAction(assignment.action)) {
    return false;
  }
  if (isNonEmptyString2(colony) && isTerritoryIntentSuppressed(colony, assignment.targetRoom, assignment.action)) {
    return false;
  }
  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  if (!controller) {
    return !isVisibleRoomMissingController(assignment.targetRoom);
  }
  if (assignment.action === "claim" && controller.my === true) {
    return false;
  }
  const actorUsername = getTerritoryActorUsername(creep, colony);
  const targetState = getTerritoryControllerTargetState(controller, assignment.action, actorUsername);
  return targetState === "available" || assignment.action === "reserve" && targetState === "satisfied";
}
function isVisibleTerritoryAssignmentComplete(assignment, creep) {
  if (assignment.action !== "claim" || !isNonEmptyString2(assignment.targetRoom)) {
    return false;
  }
  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  return (controller == null ? void 0 : controller.my) === true;
}
function suppressTerritoryIntent(colony, assignment, gameTime) {
  if (!isNonEmptyString2(colony) || !isNonEmptyString2(assignment.targetRoom) || !isTerritoryIntentAction2(assignment.action)) {
    return;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return;
  }
  const intents = normalizeTerritoryIntents2(territoryMemory.intents);
  territoryMemory.intents = intents;
  const followUp = normalizeTerritoryFollowUp2(assignment.followUp);
  const suppressedIntent = {
    colony,
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: "suppressed",
    updatedAt: gameTime,
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {},
    ...followUp ? { followUp } : {}
  };
  upsertTerritoryIntent2(intents, suppressedIntent);
}
function isTerritoryHomeSafe(colony, roleCounts, workerTarget) {
  if (getWorkerCapacity(roleCounts) < workerTarget) {
    return false;
  }
  if (colony.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return false;
  }
  const controller = colony.room.controller;
  if ((controller == null ? void 0 : controller.my) !== true || typeof controller.level !== "number" || controller.level < 2) {
    return false;
  }
  return typeof controller.ticksToDowngrade !== "number" || controller.ticksToDowngrade > TERRITORY_DOWNGRADE_GUARD_TICKS;
}
function selectTerritoryTarget(colony, roleCounts, gameTime) {
  var _a, _b;
  const colonyName = colony.room.name;
  const colonyOwnerUsername = getControllerOwnerUsername2(colony.room.controller);
  const territoryMemory = getTerritoryMemoryRecord2();
  const intents = normalizeTerritoryIntents2(territoryMemory == null ? void 0 : territoryMemory.intents);
  const routeDistanceLookupContext = createRouteDistanceLookupContext();
  const hasBlockingConfiguredTarget = hasBlockingConfiguredTerritoryTargetForColony(
    territoryMemory,
    colonyName,
    colonyOwnerUsername,
    intents,
    gameTime,
    roleCounts,
    routeDistanceLookupContext
  );
  const configuredCandidates = applyOccupationRecommendationScores(
    colony,
    roleCounts,
    getConfiguredTerritoryCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      routeDistanceLookupContext
    )
  );
  const persistedIntentCandidates = getPersistedTerritoryIntentCandidates(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    routeDistanceLookupContext
  );
  const primaryCandidates = [...persistedIntentCandidates, ...configuredCandidates];
  const bestSpawnablePrimaryCandidate = selectBestScoredTerritoryCandidate(
    getSpawnableTerritoryCandidates(primaryCandidates, roleCounts)
  );
  if (bestSpawnablePrimaryCandidate && bestSpawnablePrimaryCandidate.priority <= MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY) {
    if (!shouldEvaluateVisibleAdjacentFollowUpPreference(bestSpawnablePrimaryCandidate)) {
      return toSelectedTerritoryTarget(bestSpawnablePrimaryCandidate);
    }
    const visibleAdjacentFollowUpCandidates = applyOccupationRecommendationScores(
      colony,
      roleCounts,
      getVisibleAdjacentFollowUpReserveCandidates(
        colonyName,
        colonyOwnerUsername,
        territoryMemory,
        intents,
        gameTime,
        roleCounts,
        routeDistanceLookupContext
      )
    );
    if (visibleAdjacentFollowUpCandidates.length === 0) {
      return toSelectedTerritoryTarget(bestSpawnablePrimaryCandidate);
    }
    return toSelectedTerritoryTarget(
      (_a = selectBestScoredTerritoryCandidate(
        getSpawnableTerritoryCandidates([...primaryCandidates, ...visibleAdjacentFollowUpCandidates], roleCounts)
      )) != null ? _a : bestSpawnablePrimaryCandidate
    );
  }
  const adjacentCandidates = applyOccupationRecommendationScores(colony, roleCounts, [
    ...getAdjacentReserveCandidates(
      colonyName,
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      !hasBlockingConfiguredTarget,
      "adjacent",
      0,
      routeDistanceLookupContext
    ),
    ...getAdjacentFollowUpReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      roleCounts,
      !hasBlockingConfiguredTarget,
      routeDistanceLookupContext
    )
  ]);
  const candidates = [...primaryCandidates, ...adjacentCandidates];
  return toSelectedTerritoryTarget(
    (_b = selectBestScoredTerritoryCandidate(getSpawnableTerritoryCandidates(candidates, roleCounts))) != null ? _b : selectBestScoredTerritoryCandidate(candidates)
  );
}
function selectBestScoredTerritoryCandidate(candidates) {
  let bestCandidate = null;
  for (const candidate of candidates) {
    if (!bestCandidate || compareTerritoryCandidates(candidate, bestCandidate) < 0) {
      bestCandidate = candidate;
    }
  }
  return bestCandidate;
}
function toSelectedTerritoryTarget(candidate) {
  return candidate ? {
    target: candidate.target,
    intentAction: candidate.intentAction,
    commitTarget: candidate.commitTarget,
    ...candidate.followUp ? { followUp: candidate.followUp } : {}
  } : null;
}
function shouldEvaluateVisibleAdjacentFollowUpPreference(candidate) {
  return candidate.priority === TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE && candidate.target.action === "reserve";
}
function getSpawnableTerritoryCandidates(candidates, roleCounts) {
  return candidates.filter((candidate) => {
    const activeCoverageCount = getTerritoryCreepCountForTarget(
      roleCounts,
      candidate.target.roomName,
      candidate.intentAction
    );
    return activeCoverageCount === 0 || shouldSpawnEmergencyReservationRenewalCandidate(candidate, activeCoverageCount);
  });
}
function shouldSpawnEmergencyReservationRenewalCandidate(candidate, activeCoverageCount) {
  return activeCoverageCount < TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET && candidate.intentAction === "reserve" && typeof candidate.renewalTicksToEnd === "number" && candidate.renewalTicksToEnd <= TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS;
}
function getConfiguredTerritoryCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }
  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget2(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.roomName === colonyName || isTerritoryTargetSuppressed(target, intents, gameTime) || getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "available") {
      return [];
    }
    const candidate = scoreTerritoryCandidate(
      { target, intentAction: target.action, commitTarget: false },
      "configured",
      order,
      colonyName,
      colonyOwnerUsername,
      routeDistanceLookupContext
    );
    return candidate ? [candidate] : [];
  });
}
function getPersistedTerritoryIntentCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, routeDistanceLookupContext) {
  const seenIntentKeys = /* @__PURE__ */ new Set();
  const configuredTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  return intents.flatMap((intent, order) => {
    if (intent.colony !== colonyName || intent.targetRoom === colonyName || configuredTargetRooms.has(intent.targetRoom) || intent.status !== "planned" && intent.status !== "active" || !isTerritoryControlAction(intent.action) || isSuppressedTerritoryIntentForAction(intents, colonyName, intent.targetRoom, intent.action, gameTime) || getVisibleTerritoryTargetState(intent.targetRoom, intent.action, intent.controllerId, colonyOwnerUsername) !== "available") {
      return [];
    }
    const intentKey = `${intent.targetRoom}:${intent.action}`;
    if (seenIntentKeys.has(intentKey)) {
      return [];
    }
    seenIntentKeys.add(intentKey);
    const target = {
      colony: intent.colony,
      roomName: intent.targetRoom,
      action: intent.action,
      ...intent.controllerId ? { controllerId: intent.controllerId } : {}
    };
    const candidate = scoreTerritoryCandidate(
      {
        target,
        intentAction: intent.action,
        commitTarget: false,
        ...intent.followUp ? { followUp: intent.followUp } : {}
      },
      "occupationIntent",
      order,
      colonyName,
      colonyOwnerUsername,
      routeDistanceLookupContext
    );
    return candidate ? [candidate] : [];
  });
}
function hasBlockingConfiguredTerritoryTargetForColony(territoryMemory, colonyName, colonyOwnerUsername, intents, gameTime, roleCounts, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return false;
  }
  return territoryMemory.targets.some((rawTarget) => {
    const target = normalizeTerritoryTarget2(rawTarget);
    if (!target || target.colony !== colonyName) {
      return false;
    }
    if (hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext)) {
      return false;
    }
    if (target.enabled === false || target.roomName === colonyName || isTerritoryTargetSuppressed(target, intents, gameTime)) {
      return true;
    }
    if (getTerritoryCreepCountForTarget(roleCounts, target.roomName, target.action) > 0) {
      return false;
    }
    return getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "satisfied";
  });
}
function getAdjacentReserveCandidates(colonyName, originRoomName, colonyOwnerUsername, territoryMemory, intents, gameTime, includeScoutCandidates, source, orderOffset, routeDistanceLookupContext) {
  const adjacentRooms = getAdjacentRoomNames2(originRoomName);
  if (adjacentRooms.length === 0) {
    return [];
  }
  const existingTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  return adjacentRooms.flatMap((roomName, order) => {
    const target = { colony: colonyName, roomName, action: "reserve" };
    if (roomName === colonyName || existingTargetRooms.has(roomName) || isTerritoryTargetSuppressed(target, intents, gameTime)) {
      return [];
    }
    const candidateState = getAdjacentReserveCandidateState(roomName, colonyOwnerUsername);
    if (candidateState === "safe") {
      const candidate = scoreTerritoryCandidate(
        {
          target,
          intentAction: "reserve",
          commitTarget: true,
          ...buildTerritoryFollowUp(source, originRoomName)
        },
        source,
        orderOffset + order,
        colonyName,
        colonyOwnerUsername,
        routeDistanceLookupContext
      );
      return candidate ? [candidate] : [];
    }
    if (candidateState === "unknown" && includeScoutCandidates && !isSuppressedTerritoryIntentForAction(intents, colonyName, roomName, "scout", gameTime)) {
      const candidate = scoreTerritoryCandidate(
        {
          target,
          intentAction: "scout",
          commitTarget: false,
          ...buildTerritoryFollowUp(source, originRoomName)
        },
        source,
        orderOffset + order,
        colonyName,
        colonyOwnerUsername,
        routeDistanceLookupContext
      );
      return candidate ? [candidate] : [];
    }
    return [];
  });
}
function getVisibleAdjacentFollowUpReserveCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, roleCounts, routeDistanceLookupContext) {
  return getAdjacentFollowUpReserveCandidates(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    roleCounts,
    false,
    routeDistanceLookupContext
  );
}
function getAdjacentFollowUpReserveCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, roleCounts, includeScoutCandidates, routeDistanceLookupContext) {
  return [
    ...getSatisfiedClaimAdjacentReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      routeDistanceLookupContext
    ),
    ...getSatisfiedReserveAdjacentReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      routeDistanceLookupContext
    ),
    ...getActiveReserveAdjacentReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      roleCounts,
      includeScoutCandidates,
      routeDistanceLookupContext
    )
  ];
}
function getSatisfiedClaimAdjacentReserveCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, includeScoutCandidates, routeDistanceLookupContext) {
  return getSatisfiedConfiguredClaimTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    routeDistanceLookupContext
  ).flatMap(
    ({ target, order }) => getAdjacentReserveCandidates(
      colonyName,
      target.roomName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      "satisfiedClaimAdjacent",
      (order + 1) * EXIT_DIRECTION_ORDER2.length,
      routeDistanceLookupContext
    )
  );
}
function getSatisfiedReserveAdjacentReserveCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, includeScoutCandidates, routeDistanceLookupContext) {
  return getSatisfiedConfiguredTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    "reserve",
    routeDistanceLookupContext
  ).flatMap(
    ({ target, order }) => getAdjacentReserveCandidates(
      colonyName,
      target.roomName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      "satisfiedReserveAdjacent",
      (order + 1) * EXIT_DIRECTION_ORDER2.length,
      routeDistanceLookupContext
    )
  );
}
function getActiveReserveAdjacentReserveCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, roleCounts, includeScoutCandidates, routeDistanceLookupContext) {
  return getActiveCoveredConfiguredReserveTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    roleCounts,
    routeDistanceLookupContext
  ).flatMap(
    ({ target, order }) => getAdjacentReserveCandidates(
      colonyName,
      target.roomName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      includeScoutCandidates,
      "activeReserveAdjacent",
      (order + 1) * EXIT_DIRECTION_ORDER2.length,
      routeDistanceLookupContext
    )
  );
}
function getActiveCoveredConfiguredReserveTargets(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, roleCounts, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }
  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget2(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.action !== "reserve" || target.roomName === colonyName || isTerritoryTargetSuppressed(target, intents, gameTime) || hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext) || !isVisibleRoomKnown(target.roomName) || getTerritoryCreepCountForTarget(roleCounts, target.roomName, target.action) <= 0 || getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "available") {
      return [];
    }
    return [{ target, order }];
  });
}
function getSatisfiedConfiguredClaimTargets(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, routeDistanceLookupContext) {
  return getSatisfiedConfiguredTargets(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    "claim",
    routeDistanceLookupContext
  );
}
function getSatisfiedConfiguredTargets(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, action, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }
  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget2(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.action !== action || target.roomName === colonyName || isTerritoryTargetSuppressed(target, intents, gameTime) || hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext) || getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "satisfied") {
      return [];
    }
    return [{ target, order }];
  });
}
function scoreTerritoryCandidate(selection, source, order, colonyName, colonyOwnerUsername, routeDistanceLookupContext) {
  const routeDistance = getKnownRouteLength(colonyName, selection.target.roomName, routeDistanceLookupContext);
  if (routeDistance === null) {
    return null;
  }
  const renewalTicksToEnd = getConfiguredReserveRenewalTicksToEnd(selection.target, colonyOwnerUsername);
  const occupationActionableTicks = source === "occupationIntent" ? getOccupationIntentActionableTicks(selection, colonyOwnerUsername) : void 0;
  return {
    ...selection,
    source,
    order,
    priority: getTerritoryCandidatePriority(selection, renewalTicksToEnd),
    ...routeDistance !== void 0 ? { routeDistance } : {},
    ...renewalTicksToEnd !== null ? { renewalTicksToEnd } : {},
    ...occupationActionableTicks !== void 0 ? { occupationActionableTicks } : {}
  };
}
function applyOccupationRecommendationScores(colony, roleCounts, candidates) {
  var _a;
  const colonyOwnerUsername = (_a = getControllerOwnerUsername2(colony.room.controller)) != null ? _a : void 0;
  return candidates.flatMap((candidate) => {
    var _a2, _b;
    const recommendation = scoreOccupationRecommendations({
      colonyName: colony.room.name,
      ...colonyOwnerUsername ? { colonyOwnerUsername } : {},
      energyCapacityAvailable: colony.energyCapacityAvailable,
      workerCount: getWorkerCapacity(roleCounts),
      ...typeof ((_a2 = colony.room.controller) == null ? void 0 : _a2.level) === "number" ? { controllerLevel: colony.room.controller.level } : {},
      ...typeof ((_b = colony.room.controller) == null ? void 0 : _b.ticksToDowngrade) === "number" ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade } : {},
      candidates: [buildOccupationRecommendationCandidate(candidate)]
    }).candidates[0];
    if (!recommendation || recommendation.evidenceStatus === "unavailable") {
      return [];
    }
    return [applyOccupationRecommendationScore(candidate, recommendation, roleCounts)];
  });
}
function applyOccupationRecommendationScore(candidate, recommendation, roleCounts) {
  var _a;
  const intentAction = getRecommendedTerritoryIntentAction(candidate, recommendation, roleCounts);
  const nextSelection = {
    target: candidate.target,
    intentAction,
    commitTarget: recommendation.evidenceStatus === "sufficient" && intentAction !== "scout" && candidate.commitTarget,
    ...candidate.followUp ? { followUp: candidate.followUp } : {}
  };
  const renewalTicksToEnd = intentAction === "reserve" ? (_a = candidate.renewalTicksToEnd) != null ? _a : null : null;
  return {
    ...candidate,
    intentAction,
    commitTarget: nextSelection.commitTarget,
    priority: getTerritoryCandidatePriority(nextSelection, renewalTicksToEnd),
    recommendationScore: recommendation.score,
    recommendationEvidenceStatus: recommendation.evidenceStatus,
    ...renewalTicksToEnd !== null ? { renewalTicksToEnd } : {}
  };
}
function getRecommendedTerritoryIntentAction(candidate, recommendation, roleCounts) {
  if (recommendation.evidenceStatus === "insufficient-evidence") {
    if (candidate.source === "configured" && getTerritoryCreepCountForTarget(roleCounts, candidate.target.roomName, candidate.target.action) > 0) {
      return candidate.intentAction;
    }
    return "scout";
  }
  if (recommendation.action === "occupy") {
    return "claim";
  }
  return recommendation.action === "reserve" ? "reserve" : candidate.intentAction;
}
function buildOccupationRecommendationCandidate(candidate) {
  const room = getVisibleRoom(candidate.target.roomName);
  return {
    roomName: candidate.target.roomName,
    source: candidate.source === "configured" ? "configured" : "adjacent",
    order: candidate.order,
    adjacent: candidate.source !== "configured",
    visible: room != null,
    actionHint: candidate.target.action,
    ...candidate.routeDistance !== void 0 ? { routeDistance: candidate.routeDistance } : {},
    ...room ? buildVisibleOccupationRecommendationEvidence(room, candidate.target.controllerId) : {}
  };
}
function buildVisibleOccupationRecommendationEvidence(room, controllerId) {
  const controller = getVisibleController(room.name, controllerId);
  return {
    ...controller ? { controller: summarizeOccupationController(controller) } : {},
    sourceCount: countVisibleRoomObjects(room, getFindConstant("FIND_SOURCES")),
    hostileCreepCount: findVisibleHostileCreeps(room).length,
    hostileStructureCount: findVisibleHostileStructures(room).length,
    constructionSiteCount: countVisibleRoomObjects(room, getFindConstant("FIND_MY_CONSTRUCTION_SITES")),
    ownedStructureCount: countVisibleRoomObjects(room, getFindConstant("FIND_MY_STRUCTURES"))
  };
}
function summarizeOccupationController(controller) {
  const ownerUsername = getControllerOwnerUsername2(controller);
  const reservationUsername = getControllerReservationUsername(controller);
  const reservationTicksToEnd = getControllerReservationTicksToEnd(controller);
  return {
    ...controller.my === true ? { my: true } : {},
    ...ownerUsername ? { ownerUsername } : {},
    ...reservationUsername ? { reservationUsername } : {},
    ...typeof reservationTicksToEnd === "number" ? { reservationTicksToEnd } : {}
  };
}
function getControllerReservationUsername(controller) {
  var _a;
  const username = (_a = controller.reservation) == null ? void 0 : _a.username;
  return isNonEmptyString2(username) ? username : void 0;
}
function getControllerReservationTicksToEnd(controller) {
  var _a;
  const ticksToEnd = (_a = controller.reservation) == null ? void 0 : _a.ticksToEnd;
  return typeof ticksToEnd === "number" ? ticksToEnd : void 0;
}
function getOccupationIntentActionableTicks(selection, colonyOwnerUsername) {
  var _a, _b;
  if (!isTerritoryControlAction(selection.intentAction)) {
    return void 0;
  }
  const controller = getVisibleController(selection.target.roomName, selection.target.controllerId);
  if (!controller) {
    return void 0;
  }
  if (selection.intentAction === "reserve") {
    if (isControllerOwned(controller)) {
      return void 0;
    }
    const ownReservationTicksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
    return (_a = ownReservationTicksToEnd != null ? ownReservationTicksToEnd : getControllerReservationTicksToEnd(controller)) != null ? _a : 0;
  }
  if (isControllerOwned(controller)) {
    return typeof controller.ticksToDowngrade === "number" ? controller.ticksToDowngrade : void 0;
  }
  return (_b = getControllerReservationTicksToEnd(controller)) != null ? _b : 0;
}
function getVisibleRoom(roomName) {
  var _a, _b, _c;
  return (_c = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[roomName]) != null ? _c : null;
}
function countVisibleRoomObjects(room, findConstant) {
  if (typeof findConstant !== "number") {
    return 0;
  }
  const find = room.find;
  if (typeof find !== "function") {
    return 0;
  }
  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result.length : 0;
  } catch {
    return 0;
  }
}
function getFindConstant(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getTerritoryCandidatePriority(selection, renewalTicksToEnd) {
  if (renewalTicksToEnd !== null) {
    return TERRITORY_CANDIDATE_PRIORITY_URGENT_RENEWAL;
  }
  if (selection.intentAction === "scout") {
    return TERRITORY_CANDIDATE_PRIORITY_SCOUT;
  }
  if (isTerritoryTargetVisible(selection.target)) {
    return selection.target.action === "claim" ? TERRITORY_CANDIDATE_PRIORITY_VISIBLE_CLAIM : TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE;
  }
  return selection.target.action === "claim" ? TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_CLAIM : TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_RESERVE;
}
function compareTerritoryCandidates(left, right) {
  return left.priority - right.priority || compareOptionalNumbers2(left.renewalTicksToEnd, right.renewalTicksToEnd) || compareVisibleAdjacentFollowUpPreference(left, right) || getTerritoryCandidateSourcePriority(left.source) - getTerritoryCandidateSourcePriority(right.source) || compareOptionalNumbersDescending(left.recommendationScore, right.recommendationScore) || compareOptionalNumbers2(left.occupationActionableTicks, right.occupationActionableTicks) || left.order - right.order || left.target.roomName.localeCompare(right.target.roomName) || left.intentAction.localeCompare(right.intentAction);
}
function compareVisibleAdjacentFollowUpPreference(left, right) {
  if (shouldPreferVisibleAdjacentFollowUp(left, right)) {
    return -1;
  }
  return shouldPreferVisibleAdjacentFollowUp(right, left) ? 1 : 0;
}
function shouldPreferVisibleAdjacentFollowUp(candidate, other) {
  return isVisibleAdjacentControllerFollowUpCandidate(candidate) && isLowerConfidenceDistantSameActionCandidate(other, candidate);
}
function isVisibleAdjacentControllerFollowUpCandidate(candidate) {
  return isTerritoryFollowUpSource2(candidate.source) && candidate.intentAction === candidate.target.action && isTerritoryControlAction(candidate.intentAction) && candidate.recommendationEvidenceStatus === "sufficient" && isTerritoryTargetVisible(candidate.target);
}
function isLowerConfidenceDistantSameActionCandidate(candidate, followUpCandidate) {
  if (candidate.target.action !== followUpCandidate.target.action || !isPrimaryTerritoryCandidateSource(candidate.source) || !isFartherTerritoryCandidate(candidate, followUpCandidate)) {
    return false;
  }
  if (candidate.recommendationEvidenceStatus !== "sufficient" || !isTerritoryTargetVisible(candidate.target)) {
    return true;
  }
  return typeof candidate.recommendationScore === "number" && typeof followUpCandidate.recommendationScore === "number" && followUpCandidate.recommendationScore > candidate.recommendationScore;
}
function isPrimaryTerritoryCandidateSource(source) {
  return source === "configured" || source === "occupationIntent";
}
function isFartherTerritoryCandidate(candidate, other) {
  var _a, _b;
  const candidateDistance = (_a = candidate.routeDistance) != null ? _a : Number.POSITIVE_INFINITY;
  const otherDistance = (_b = other.routeDistance) != null ? _b : Number.POSITIVE_INFINITY;
  return candidateDistance > otherDistance;
}
function compareOptionalNumbers2(left, right) {
  return (left != null ? left : Number.POSITIVE_INFINITY) - (right != null ? right : Number.POSITIVE_INFINITY);
}
function compareOptionalNumbersDescending(left, right) {
  return (right != null ? right : Number.NEGATIVE_INFINITY) - (left != null ? left : Number.NEGATIVE_INFINITY);
}
function getTerritoryCandidateSourcePriority(source) {
  if (source === "configured" || source === "occupationIntent") {
    return 0;
  }
  if (source === "satisfiedClaimAdjacent") {
    return 1;
  }
  if (source === "satisfiedReserveAdjacent") {
    return 2;
  }
  return source === "activeReserveAdjacent" ? 3 : 4;
}
function buildTerritoryFollowUp(source, originRoom) {
  const originAction = getTerritoryFollowUpOriginAction2(source);
  if (originAction === null || !isTerritoryFollowUpSource2(source) || !isNonEmptyString2(originRoom)) {
    return {};
  }
  return {
    followUp: {
      source,
      originRoom,
      originAction
    }
  };
}
function getTerritoryFollowUpOriginAction2(source) {
  if (source === "satisfiedClaimAdjacent") {
    return "claim";
  }
  return source === "satisfiedReserveAdjacent" || source === "activeReserveAdjacent" ? "reserve" : null;
}
function isTerritoryTargetVisible(target) {
  return isVisibleRoomKnown(target.roomName) || getVisibleController(target.roomName, target.controllerId) !== null;
}
function createRouteDistanceLookupContext() {
  return { revalidatedNoRouteCacheKeys: /* @__PURE__ */ new Set() };
}
function hasKnownNoRoute(fromRoom, targetRoom, routeDistanceLookupContext) {
  return getKnownRouteLength(fromRoom, targetRoom, routeDistanceLookupContext) === null;
}
function getKnownRouteLength(fromRoom, targetRoom, routeDistanceLookupContext) {
  var _a;
  if (fromRoom === targetRoom) {
    return 0;
  }
  const cache = getTerritoryRouteDistanceCache();
  const cacheKey = getTerritoryRouteDistanceCacheKey(fromRoom, targetRoom);
  const cachedRouteLength = cache == null ? void 0 : cache[cacheKey];
  if (typeof cachedRouteLength === "number") {
    return cachedRouteLength;
  }
  if (cachedRouteLength === null && routeDistanceLookupContext.revalidatedNoRouteCacheKeys.has(cacheKey)) {
    return null;
  }
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (typeof (gameMap == null ? void 0 : gameMap.findRoute) !== "function") {
    return void 0;
  }
  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom);
  if (route === getNoPathResultCode()) {
    if (cache) {
      cache[cacheKey] = null;
    }
    routeDistanceLookupContext.revalidatedNoRouteCacheKeys.add(cacheKey);
    return null;
  }
  if (!Array.isArray(route)) {
    return void 0;
  }
  if (cache) {
    cache[cacheKey] = route.length;
  }
  return route.length;
}
function getTerritoryRouteDistanceCache() {
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return void 0;
  }
  if (!isRecord2(territoryMemory.routeDistances)) {
    territoryMemory.routeDistances = {};
  }
  return territoryMemory.routeDistances;
}
function getTerritoryRouteDistanceCacheKey(fromRoom, targetRoom) {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR2}${targetRoom}`;
}
function getNoPathResultCode() {
  const noPathCode = globalThis.ERR_NO_PATH;
  return typeof noPathCode === "number" ? noPathCode : ERR_NO_PATH_CODE;
}
function getAdjacentReserveCandidateState(targetRoom, colonyOwnerUsername) {
  if (isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom)) {
    return "unavailable";
  }
  if (isVisibleRoomMissingController(targetRoom)) {
    return "unavailable";
  }
  const controller = getVisibleController(targetRoom);
  if (!controller) {
    return "unknown";
  }
  const targetState = getReserveControllerTargetState(controller, colonyOwnerUsername);
  return targetState === "available" ? "safe" : "unavailable";
}
function getConfiguredTargetRoomsForColony(territoryMemory, colonyName) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return /* @__PURE__ */ new Set();
  }
  return new Set(
    territoryMemory.targets.flatMap((rawTarget) => {
      const target = normalizeTerritoryTarget2(rawTarget);
      return (target == null ? void 0 : target.colony) === colonyName ? [target.roomName] : [];
    })
  );
}
function appendTerritoryTarget(territoryMemory, target) {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }
  territoryMemory.targets.push(target);
}
function getAdjacentRoomNames2(roomName) {
  const game = globalThis.Game;
  const gameMap = game == null ? void 0 : game.map;
  if (!gameMap || typeof gameMap.describeExits !== "function") {
    return [];
  }
  const exits = gameMap.describeExits(roomName);
  if (!isRecord2(exits)) {
    return [];
  }
  return EXIT_DIRECTION_ORDER2.flatMap((direction) => {
    const exitRoom = exits[direction];
    return isNonEmptyString2(exitRoom) ? [exitRoom] : [];
  });
}
function normalizeTerritoryTarget2(rawTarget) {
  if (!isRecord2(rawTarget)) {
    return null;
  }
  if (!isNonEmptyString2(rawTarget.colony) || !isNonEmptyString2(rawTarget.roomName) || !isTerritoryControlAction(rawTarget.action)) {
    return null;
  }
  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action: rawTarget.action,
    ...typeof rawTarget.controllerId === "string" ? { controllerId: rawTarget.controllerId } : {},
    ...rawTarget.enabled === false ? { enabled: false } : {}
  };
}
function recordTerritoryIntent(plan, status, gameTime, seededTarget = null) {
  const territoryMemory = getWritableTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return;
  }
  if (seededTarget) {
    appendTerritoryTarget(territoryMemory, seededTarget);
  }
  const intents = normalizeTerritoryIntents2(territoryMemory.intents);
  territoryMemory.intents = intents;
  const nextIntent = {
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    status,
    updatedAt: gameTime,
    ...plan.controllerId ? { controllerId: plan.controllerId } : {},
    ...plan.followUp ? { followUp: plan.followUp } : {}
  };
  upsertTerritoryIntent2(intents, nextIntent);
}
function normalizeTerritoryIntents2(rawIntents) {
  return Array.isArray(rawIntents) ? rawIntents.flatMap((intent) => {
    const normalizedIntent = normalizeTerritoryIntent2(intent);
    return normalizedIntent ? [normalizedIntent] : [];
  }) : [];
}
function upsertTerritoryIntent2(intents, nextIntent) {
  const existingIndex = intents.findIndex(
    (intent) => intent.colony === nextIntent.colony && intent.targetRoom === nextIntent.targetRoom && intent.action === nextIntent.action
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }
  intents.push(nextIntent);
}
function normalizeTerritoryIntent2(rawIntent) {
  if (!isRecord2(rawIntent)) {
    return null;
  }
  if (!isNonEmptyString2(rawIntent.colony) || !isNonEmptyString2(rawIntent.targetRoom) || !isTerritoryIntentAction2(rawIntent.action) || !isTerritoryIntentStatus2(rawIntent.status) || typeof rawIntent.updatedAt !== "number") {
    return null;
  }
  const followUp = normalizeTerritoryFollowUp2(rawIntent.followUp);
  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...typeof rawIntent.controllerId === "string" ? { controllerId: rawIntent.controllerId } : {},
    ...followUp ? { followUp } : {}
  };
}
function normalizeTerritoryFollowUp2(rawFollowUp) {
  if (!isRecord2(rawFollowUp)) {
    return null;
  }
  if (!isTerritoryFollowUpSource2(rawFollowUp.source)) {
    return null;
  }
  const source = rawFollowUp.source;
  const originAction = getTerritoryFollowUpOriginAction2(source);
  if (originAction === null || !isNonEmptyString2(rawFollowUp.originRoom) || rawFollowUp.originAction !== originAction) {
    return null;
  }
  return {
    source,
    originRoom: rawFollowUp.originRoom,
    originAction
  };
}
function getTerritoryCreepCountForTarget(roleCounts, targetRoom, action) {
  var _a, _b, _c, _d, _e, _f;
  if (action === "scout") {
    return (_b = (_a = roleCounts.scoutsByTargetRoom) == null ? void 0 : _a[targetRoom]) != null ? _b : 0;
  }
  if (roleCounts.claimersByTargetRoomAction) {
    return (_d = (_c = roleCounts.claimersByTargetRoomAction[action]) == null ? void 0 : _c[targetRoom]) != null ? _d : 0;
  }
  return (_f = (_e = roleCounts.claimersByTargetRoom) == null ? void 0 : _e[targetRoom]) != null ? _f : 0;
}
function isTerritoryTargetSuppressed(target, intents, gameTime) {
  return isSuppressedTerritoryIntentForAction(intents, target.colony, target.roomName, target.action, gameTime);
}
function isSuppressedTerritoryIntentForAction(intents, colony, targetRoom, action, gameTime) {
  return intents.some(
    (intent) => isTerritorySuppressionFresh2(intent, gameTime) && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isTerritoryIntentSuppressed(colony, targetRoom, action, gameTime = getGameTime2()) {
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return false;
  }
  return normalizeTerritoryIntents2(territoryMemory.intents).some(
    (intent) => isTerritorySuppressionFresh2(intent, gameTime) && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isTerritorySuppressionFresh2(intent, gameTime) {
  return intent.status === "suppressed" && gameTime - intent.updatedAt <= TERRITORY_SUPPRESSION_RETRY_TICKS2;
}
function selectVisibleTerritoryControllerIntent(creep) {
  var _a, _b, _c;
  const roomName = (_a = creep.room) == null ? void 0 : _a.name;
  if (!isNonEmptyString2(roomName) || isVisibleRoomUnsafe(creep.room)) {
    return null;
  }
  const assignmentIntent = normalizeCreepTerritoryIntent(creep, roomName);
  if (assignmentIntent && isCreepVisibleTerritoryIntentActionable(creep, assignmentIntent)) {
    return assignmentIntent;
  }
  const territoryMemory = getTerritoryMemoryRecord2();
  const colony = (_b = creep.memory) == null ? void 0 : _b.colony;
  const intents = normalizeTerritoryIntents2(territoryMemory == null ? void 0 : territoryMemory.intents).filter((intent) => isActiveVisibleControllerIntentForCreep(intent, roomName, colony)).sort(compareVisibleControllerIntents);
  return (_c = intents.find((intent) => isCreepVisibleTerritoryIntentActionable(creep, intent))) != null ? _c : null;
}
function normalizeCreepTerritoryIntent(creep, roomName) {
  var _a, _b, _c, _d;
  const assignment = (_a = creep.memory) == null ? void 0 : _a.territory;
  if (!assignment || assignment.targetRoom !== roomName || !isTerritoryControlAction(assignment.action) || isNonEmptyString2((_b = creep.memory) == null ? void 0 : _b.colony) && isTerritoryIntentSuppressed(creep.memory.colony, assignment.targetRoom, assignment.action)) {
    return null;
  }
  const followUp = normalizeTerritoryFollowUp2(assignment.followUp);
  return {
    colony: (_d = (_c = creep.memory) == null ? void 0 : _c.colony) != null ? _d : "",
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: "active",
    updatedAt: getGameTime2(),
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {},
    ...followUp ? { followUp } : {}
  };
}
function isActiveVisibleControllerIntentForCreep(intent, roomName, creepColony) {
  return intent.targetRoom === roomName && intent.targetRoom !== intent.colony && isTerritoryControlAction(intent.action) && (intent.status === "planned" || intent.status === "active") && (!isNonEmptyString2(creepColony) || intent.colony === creepColony);
}
function compareVisibleControllerIntents(left, right) {
  return getIntentStatusPriority(left.status) - getIntentStatusPriority(right.status) || getIntentActionPriority(left.action) - getIntentActionPriority(right.action) || right.updatedAt - left.updatedAt || left.colony.localeCompare(right.colony);
}
function getIntentStatusPriority(status) {
  return status === "active" ? 0 : 1;
}
function getIntentActionPriority(action) {
  return action === "claim" ? 0 : 1;
}
function isCreepVisibleTerritoryIntentActionable(creep, intent) {
  if (!isTerritoryControlAction(intent.action)) {
    return false;
  }
  const controller = selectCreepRoomController(creep, intent.controllerId);
  if (!controller) {
    return false;
  }
  if (!isVisibleRoomSafe(creep.room)) {
    return false;
  }
  if (intent.action === "claim" && controller.my === true) {
    return true;
  }
  if (intent.action === "reserve") {
    return canCreepReserveTerritoryController(creep, controller, intent.colony);
  }
  return getTerritoryControllerTargetState(controller, intent.action, getTerritoryActorUsername(creep, intent.colony)) === "available";
}
function selectVisibleTerritoryAssignmentController(assignment, creep) {
  var _a;
  return ((_a = creep == null ? void 0 : creep.room) == null ? void 0 : _a.name) === assignment.targetRoom ? selectCreepRoomController(creep, assignment.controllerId) : getVisibleController(assignment.targetRoom, assignment.controllerId);
}
function selectCreepRoomController(creep, controllerId) {
  var _a;
  const roomController = (_a = creep.room) == null ? void 0 : _a.controller;
  if (!controllerId) {
    return roomController != null ? roomController : null;
  }
  if ((roomController == null ? void 0 : roomController.id) === controllerId) {
    return roomController;
  }
  const game = globalThis.Game;
  const getObjectById = game == null ? void 0 : game.getObjectById;
  if (typeof getObjectById !== "function") {
    return null;
  }
  return getObjectById.call(game, controllerId);
}
function getTerritoryControllerTargetState(controller, action, colonyOwnerUsername) {
  if (action === "reserve") {
    return getReserveControllerTargetState(controller, colonyOwnerUsername);
  }
  if (isControllerOwnedByColony2(controller, colonyOwnerUsername)) {
    return "satisfied";
  }
  return isControllerOwned(controller) ? "unavailable" : "available";
}
function getTerritoryActorUsername(creep, colony) {
  var _a;
  return (_a = getCreepOwnerUsername(creep)) != null ? _a : isNonEmptyString2(colony) ? getVisibleColonyOwnerUsername(colony) : null;
}
function getCreepOwnerUsername(creep) {
  var _a;
  const username = (_a = creep == null ? void 0 : creep.owner) == null ? void 0 : _a.username;
  return isNonEmptyString2(username) ? username : null;
}
function canUseControllerClaimPart(creep) {
  return getActiveControllerClaimPartCount(creep) > 0;
}
function canRenewReservation(activeClaimParts, reservationTicksToEnd) {
  return reservationTicksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS || reservationTicksToEnd <= TERRITORY_RESERVATION_COMFORT_TICKS && activeClaimParts >= MIN_CLAIM_PARTS_FOR_RESERVATION_PROGRESS;
}
function getActiveControllerClaimPartCount(creep) {
  var _a;
  const claimPart = getBodyPartConstant("CLAIM", "claim");
  const activeClaimParts = (_a = creep.getActiveBodyparts) == null ? void 0 : _a.call(creep, claimPart);
  if (typeof activeClaimParts === "number") {
    return activeClaimParts;
  }
  return Array.isArray(creep.body) ? creep.body.filter((part) => part.type === claimPart && part.hits > 0).length : 0;
}
function getBodyPartConstant(globalName, fallback) {
  var _a;
  const constants = globalThis;
  return (_a = constants[globalName]) != null ? _a : fallback;
}
function getStoredEnergy(object) {
  var _a;
  const store = object == null ? void 0 : object.store;
  const energyResource = getEnergyResource();
  const usedCapacity = (_a = store == null ? void 0 : store.getUsedCapacity) == null ? void 0 : _a.call(store, energyResource);
  if (typeof usedCapacity === "number") {
    return usedCapacity;
  }
  const storedEnergy = store == null ? void 0 : store[energyResource];
  return typeof storedEnergy === "number" ? storedEnergy : 0;
}
function getEnergyResource() {
  const resource = globalThis.RESOURCE_ENERGY;
  return typeof resource === "string" ? resource : "energy";
}
function isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom) {
  var _a, _b;
  const room = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[targetRoom];
  return room ? isVisibleRoomUnsafe(room) : false;
}
function isVisibleRoomSafe(room) {
  return !isVisibleRoomUnsafe(room);
}
function isVisibleRoomUnsafe(room) {
  return findVisibleHostileCreeps(room).length > 0 || findVisibleHostileStructures(room).length > 0;
}
function findVisibleHostileCreeps(room) {
  return typeof FIND_HOSTILE_CREEPS === "number" && typeof room.find === "function" ? room.find(FIND_HOSTILE_CREEPS) : [];
}
function findVisibleHostileStructures(room) {
  return typeof FIND_HOSTILE_STRUCTURES === "number" && typeof room.find === "function" ? room.find(FIND_HOSTILE_STRUCTURES) : [];
}
function getVisibleTerritoryTargetState(targetRoom, action, controllerId, colonyOwnerUsername) {
  if (isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom)) {
    return "unavailable";
  }
  if (isVisibleRoomMissingController(targetRoom)) {
    return "unavailable";
  }
  if (action === "scout") {
    return isVisibleRoomKnown(targetRoom) ? "unavailable" : "available";
  }
  const controller = getVisibleController(targetRoom, controllerId);
  if (!controller) {
    return "available";
  }
  if (action === "reserve") {
    return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername != null ? colonyOwnerUsername : null);
  }
  return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername != null ? colonyOwnerUsername : null);
}
function isVisibleRoomKnown(targetRoom) {
  var _a;
  const game = globalThis.Game;
  return ((_a = game == null ? void 0 : game.rooms) == null ? void 0 : _a[targetRoom]) != null;
}
function isVisibleRoomMissingController(targetRoom) {
  var _a;
  const game = globalThis.Game;
  const room = (_a = game == null ? void 0 : game.rooms) == null ? void 0 : _a[targetRoom];
  return room != null && room.controller == null;
}
function isControllerOwned(controller) {
  return controller.owner != null || controller.my === true;
}
function isControllerOwnedByColony2(controller, colonyOwnerUsername) {
  const ownerUsername = getControllerOwnerUsername2(controller);
  return controller.my === true || isNonEmptyString2(ownerUsername) && ownerUsername === colonyOwnerUsername;
}
function getReserveControllerTargetState(controller, colonyOwnerUsername) {
  if (isControllerOwned(controller)) {
    return "unavailable";
  }
  const reservation = controller.reservation;
  if (!reservation) {
    return "available";
  }
  if (!isNonEmptyString2(reservation.username) || reservation.username !== colonyOwnerUsername) {
    return "unavailable";
  }
  return getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername) === null ? "satisfied" : "available";
}
function getConfiguredReserveRenewalTicksToEnd(target, colonyOwnerUsername) {
  if (target.action !== "reserve" || colonyOwnerUsername === null) {
    return null;
  }
  const controller = getVisibleController(target.roomName, target.controllerId);
  if (!controller || isControllerOwned(controller)) {
    return null;
  }
  return getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername);
}
function shouldSpawnEmergencyReservationRenewal(plan, activeCoverageCount) {
  if (activeCoverageCount >= TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET || plan.action !== "reserve") {
    return false;
  }
  const controller = getVisibleController(plan.targetRoom, plan.controllerId);
  if (!controller || isControllerOwned(controller)) {
    return false;
  }
  const colonyOwnerUsername = getVisibleColonyOwnerUsername(plan.colony);
  const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
  return ticksToEnd !== null && ticksToEnd <= TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS;
}
function getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername) {
  const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
  return ticksToEnd !== null && ticksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS ? ticksToEnd : null;
}
function getOwnReservationTicksToEnd(controller, colonyOwnerUsername) {
  if (isControllerOwned(controller) || !isNonEmptyString2(colonyOwnerUsername)) {
    return null;
  }
  const reservation = controller.reservation;
  if (!reservation || reservation.username !== colonyOwnerUsername || typeof reservation.ticksToEnd !== "number") {
    return null;
  }
  return reservation.ticksToEnd;
}
function getVisibleColonyOwnerUsername(colonyName) {
  const controller = getVisibleController(colonyName);
  return getControllerOwnerUsername2(controller != null ? controller : void 0);
}
function getControllerOwnerUsername2(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return isNonEmptyString2(username) ? username : null;
}
function getVisibleController(targetRoom, controllerId) {
  var _a, _b;
  const game = globalThis.Game;
  const roomController = (_b = (_a = game == null ? void 0 : game.rooms) == null ? void 0 : _a[targetRoom]) == null ? void 0 : _b.controller;
  if (roomController) {
    return roomController;
  }
  const getObjectById = game == null ? void 0 : game.getObjectById;
  if (controllerId && typeof getObjectById === "function") {
    return getObjectById.call(game, controllerId);
  }
  return null;
}
function getGameTime2() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function getWritableTerritoryMemoryRecord2() {
  const memory = getMemoryRecord();
  if (!memory) {
    return null;
  }
  if (!isRecord2(memory.territory)) {
    memory.territory = {};
  }
  return memory.territory;
}
function getTerritoryMemoryRecord2() {
  const memory = getMemoryRecord();
  if (!memory || !isRecord2(memory.territory)) {
    return null;
  }
  return memory.territory;
}
function getMemoryRecord() {
  const memory = globalThis.Memory;
  return memory != null ? memory : null;
}
function isTerritoryControlAction(action) {
  return action === "claim" || action === "reserve";
}
function isTerritoryIntentAction2(action) {
  return isTerritoryControlAction(action) || action === "scout";
}
function isTerritoryFollowUpSource2(source) {
  return source === "satisfiedClaimAdjacent" || source === "satisfiedReserveAdjacent" || source === "activeReserveAdjacent";
}
function isTerritoryIntentStatus2(status) {
  return status === "planned" || status === "active" || status === "suppressed";
}
function isNonEmptyString2(value) {
  return typeof value === "string" && value.length > 0;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}

// src/tasks/workerTasks.ts
var CONTROLLER_DOWNGRADE_GUARD_TICKS = 5e3;
var CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO = 0.5;
var IDLE_RAMPART_REPAIR_HITS_CEILING = 1e5;
var TOWER_REFILL_ENERGY_FLOOR = 500;
var MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
var MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE = 1;
var MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 25;
var MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT = 2;
var ENERGY_ACQUISITION_RANGE_COST = 50;
var ENERGY_ACQUISITION_ACTION_TICKS = 1;
var HARVEST_ENERGY_PER_WORK_PART = 2;
var MAX_DROPPED_ENERGY_REACHABILITY_CHECKS = 5;
function selectWorkerTask(creep) {
  const carriedEnergy = getUsedEnergy(creep);
  const urgentReservationRenewalTask = selectUrgentVisibleReservationRenewalTask(creep);
  const territoryControllerTask = selectVisibleTerritoryControllerTask(creep);
  if (carriedEnergy === 0) {
    if (urgentReservationRenewalTask) {
      return urgentReservationRenewalTask;
    }
    if (isTerritoryControlTask(territoryControllerTask)) {
      return territoryControllerTask;
    }
    if (getFreeEnergyCapacity(creep) > 0) {
      const spawnRecoveryEnergySink = selectFillableEnergySink(creep);
      if (spawnRecoveryEnergySink) {
        const spawnRecoveryTask = selectSpawnRecoveryEnergyAcquisitionTask(creep, spawnRecoveryEnergySink);
        if (spawnRecoveryTask) {
          return spawnRecoveryTask;
        }
      } else {
        const energyAcquisitionTask = selectWorkerEnergyAcquisitionTask(creep);
        if (energyAcquisitionTask) {
          return energyAcquisitionTask;
        }
      }
    }
    const source = selectHarvestSource(creep);
    return source ? { type: "harvest", targetId: source.id } : null;
  }
  if (urgentReservationRenewalTask) {
    return urgentReservationRenewalTask;
  }
  if (isTerritoryControlTask(territoryControllerTask)) {
    return territoryControllerTask;
  }
  const spawnOrExtensionEnergySink = selectSpawnOrExtensionEnergySink(creep);
  if (spawnOrExtensionEnergySink) {
    return { type: "transfer", targetId: spawnOrExtensionEnergySink.id };
  }
  const controller = creep.room.controller;
  if (controller && shouldGuardControllerDowngrade(controller)) {
    return { type: "upgrade", targetId: controller.id };
  }
  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const capacityConstructionSite = selectCapacityEnablingConstructionSite(creep, constructionSites, controller);
  if (capacityConstructionSite && !territoryControllerTask) {
    return { type: "build", targetId: capacityConstructionSite.id };
  }
  const priorityTowerEnergySink = selectPriorityTowerEnergySink(creep);
  if (priorityTowerEnergySink) {
    return { type: "transfer", targetId: priorityTowerEnergySink.id };
  }
  if (territoryControllerTask) {
    return territoryControllerTask;
  }
  if (capacityConstructionSite) {
    return { type: "build", targetId: capacityConstructionSite.id };
  }
  if (controller && shouldRushRcl1Controller(controller)) {
    return { type: "upgrade", targetId: controller.id };
  }
  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return { type: "repair", targetId: criticalRepairTarget.id };
  }
  const containerConstructionSite = selectConstructionSite(creep, constructionSites, isContainerConstructionSite);
  if (containerConstructionSite) {
    return { type: "build", targetId: containerConstructionSite.id };
  }
  const roadConstructionSite = selectConstructionSite(creep, constructionSites, isRoadConstructionSite2);
  if (roadConstructionSite) {
    return { type: "build", targetId: roadConstructionSite.id };
  }
  if (controller && shouldUseSurplusForControllerProgress(creep, controller)) {
    const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(creep, constructionSites, controller);
    if (productiveEnergySinkTask) {
      return productiveEnergySinkTask;
    }
    return { type: "upgrade", targetId: controller.id };
  }
  const constructionSite = selectConstructionSite(creep, constructionSites);
  if (constructionSite) {
    return { type: "build", targetId: constructionSite.id };
  }
  const repairTarget = selectRepairTarget(creep);
  if (repairTarget) {
    return { type: "repair", targetId: repairTarget.id };
  }
  if (controller == null ? void 0 : controller.my) {
    return { type: "upgrade", targetId: controller.id };
  }
  return null;
}
function isTerritoryControlTask(task) {
  return (task == null ? void 0 : task.type) === "claim" || (task == null ? void 0 : task.type) === "reserve";
}
function isFillableEnergySink(structure) {
  return (matchesStructureType2(structure.structureType, "STRUCTURE_SPAWN", "spawn") || matchesStructureType2(structure.structureType, "STRUCTURE_EXTENSION", "extension") || matchesStructureType2(structure.structureType, "STRUCTURE_TOWER", "tower")) && "store" in structure && getFreeStoredEnergyCapacity(structure) > 0;
}
function selectFillableEnergySink(creep) {
  var _a;
  return (_a = selectSpawnOrExtensionEnergySink(creep)) != null ? _a : selectPriorityTowerEnergySink(creep);
}
function selectSpawnOrExtensionEnergySink(creep) {
  return selectClosestEnergySink(findFillableEnergySinks(creep).filter(isSpawnOrExtensionEnergySink), creep);
}
function selectPriorityTowerEnergySink(creep) {
  return selectClosestEnergySink(findFillableEnergySinks(creep).filter(isPriorityTowerEnergySink), creep);
}
function findFillableEnergySinks(creep) {
  const energySinks = creep.room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });
  return energySinks;
}
function isSpawnEnergySink(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_SPAWN", "spawn");
}
function isSpawnOrExtensionEnergySink(structure) {
  return isSpawnEnergySink(structure) || isExtensionEnergySink(structure);
}
function isExtensionEnergySink(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_EXTENSION", "extension");
}
function isTowerEnergySink(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_TOWER", "tower");
}
function isPriorityTowerEnergySink(structure) {
  return isTowerEnergySink(structure) && getStoredEnergy2(structure) < TOWER_REFILL_ENERGY_FLOOR;
}
function selectClosestEnergySink(energySinks, creep) {
  var _a;
  if (energySinks.length === 0) {
    return null;
  }
  const energySinksByStableId = [...energySinks].sort(compareEnergySinkId);
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) === "function") {
    return energySinksByStableId.reduce((closest, candidate) => {
      var _a2, _b, _c, _d;
      const closestRange = (_b = (_a2 = position.getRangeTo) == null ? void 0 : _a2.call(position, closest)) != null ? _b : Infinity;
      const candidateRange = (_d = (_c = position.getRangeTo) == null ? void 0 : _c.call(position, candidate)) != null ? _d : Infinity;
      return candidateRange < closestRange || candidateRange === closestRange && compareEnergySinkId(candidate, closest) < 0 ? candidate : closest;
    });
  }
  if (typeof (position == null ? void 0 : position.findClosestByRange) === "function") {
    return (_a = position.findClosestByRange(energySinksByStableId)) != null ? _a : energySinksByStableId[0];
  }
  return energySinksByStableId[0];
}
function compareEnergySinkId(left, right) {
  return String(left.id).localeCompare(String(right.id));
}
function selectConstructionSite(creep, constructionSites, predicate = () => true) {
  var _a;
  const candidates = constructionSites.filter(predicate);
  if (candidates.length === 0) {
    return null;
  }
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) === "function") {
    return [...candidates].sort(compareConstructionSiteId).reduce((closest, candidate) => {
      var _a2, _b, _c, _d;
      const closestRange = (_b = (_a2 = position.getRangeTo) == null ? void 0 : _a2.call(position, closest)) != null ? _b : Infinity;
      const candidateRange = (_d = (_c = position.getRangeTo) == null ? void 0 : _c.call(position, candidate)) != null ? _d : Infinity;
      return candidateRange < closestRange || candidateRange === closestRange && compareConstructionSiteId(candidate, closest) < 0 ? candidate : closest;
    });
  }
  if (typeof (position == null ? void 0 : position.findClosestByRange) === "function") {
    const candidatesByStableId = [...candidates].sort(compareConstructionSiteId);
    return (_a = position.findClosestByRange(candidatesByStableId)) != null ? _a : candidatesByStableId[0];
  }
  return candidates[0];
}
function compareConstructionSiteId(left, right) {
  return String(left.id).localeCompare(String(right.id));
}
function selectNearbyProductiveEnergySinkTask(creep, constructionSites, controller) {
  const controllerRange = getRangeBetweenRoomObjects(creep, controller);
  if (controllerRange === null) {
    return null;
  }
  const candidates = [
    ...constructionSites.map(
      (site) => createProductiveEnergySinkCandidate(creep, site, { type: "build", targetId: site.id }, 0)
    ),
    ...findVisibleRoomStructures(creep.room).filter(isSafeRepairTarget).map(
      (structure) => createProductiveEnergySinkCandidate(
        creep,
        structure,
        { type: "repair", targetId: structure.id },
        1
      )
    )
  ].filter(
    (candidate) => candidate !== null && candidate.range <= controllerRange
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareProductiveEnergySinkCandidates)[0].task;
}
function createProductiveEnergySinkCandidate(creep, target, task, taskPriority) {
  const range = getRangeBetweenRoomObjects(creep, target);
  if (range === null) {
    return null;
  }
  return { range, task, taskPriority };
}
function compareProductiveEnergySinkCandidates(left, right) {
  return left.range - right.range || left.taskPriority - right.taskPriority || String(left.task.targetId).localeCompare(String(right.task.targetId));
}
function selectCapacityEnablingConstructionSite(creep, constructionSites, controller) {
  const spawnConstructionSite = selectConstructionSite(creep, constructionSites, isSpawnConstructionSite);
  if (spawnConstructionSite) {
    return spawnConstructionSite;
  }
  if (controller && shouldRushRcl1Controller(controller)) {
    return null;
  }
  return selectConstructionSite(creep, constructionSites, isExtensionConstructionSite);
}
function isSpawnConstructionSite(site) {
  return matchesStructureType2(site.structureType, "STRUCTURE_SPAWN", "spawn");
}
function isExtensionConstructionSite(site) {
  return matchesStructureType2(site.structureType, "STRUCTURE_EXTENSION", "extension");
}
function isContainerConstructionSite(site) {
  return matchesStructureType2(site.structureType, "STRUCTURE_CONTAINER", "container");
}
function isRoadConstructionSite2(site) {
  return matchesStructureType2(site.structureType, "STRUCTURE_ROAD", "road");
}
function matchesStructureType2(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}
function selectStoredEnergySource(creep) {
  const context = {
    creepOwnerUsername: getCreepOwnerUsername2(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const storedEnergySources = findVisibleRoomStructures(creep.room).filter(
    (structure) => isSafeStoredEnergySource(structure, context)
  );
  if (storedEnergySources.length === 0) {
    return null;
  }
  const scoredStoredEnergy = scoreStoredEnergySources(creep, storedEnergySources);
  if (scoredStoredEnergy.length > 0) {
    return scoredStoredEnergy.sort(compareStoredEnergySourceScores)[0].source;
  }
  const closestStoredEnergy = findClosestByRange(creep, storedEnergySources);
  return closestStoredEnergy != null ? closestStoredEnergy : storedEnergySources[0];
}
function scoreStoredEnergySources(creep, sources) {
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) !== "function") {
    return [];
  }
  return sources.map((source) => {
    var _a, _b;
    const energy = getStoredEnergy2(source);
    const range = Math.max(0, (_b = (_a = position.getRangeTo) == null ? void 0 : _a.call(position, source)) != null ? _b : 0);
    return {
      energy,
      range,
      score: energy - range * ENERGY_ACQUISITION_RANGE_COST,
      source
    };
  });
}
function compareStoredEnergySourceScores(left, right) {
  return right.score - left.score || left.range - right.range || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id));
}
function isSafeStoredEnergySource(structure, context) {
  return isStoredWorkerEnergySource(structure) && hasStoredEnergy(structure) && isFriendlyStoredEnergySource(structure, context);
}
function isStoredWorkerEnergySource(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_CONTAINER", "container") || matchesStructureType2(structure.structureType, "STRUCTURE_STORAGE", "storage") || matchesStructureType2(structure.structureType, "STRUCTURE_TERMINAL", "terminal");
}
function hasStoredEnergy(structure) {
  return getStoredEnergy2(structure) > 0;
}
function isFriendlyStoredEnergySource(structure, context) {
  var _a;
  const ownership = structure.my;
  if (typeof ownership === "boolean") {
    return ownership;
  }
  if (((_a = context.room.controller) == null ? void 0 : _a.my) === true) {
    return true;
  }
  return matchesStructureType2(structure.structureType, "STRUCTURE_CONTAINER", "container") && isRoomSafeForUnownedContainerWithdrawal(context);
}
function isRoomSafeForUnownedContainerWithdrawal(context) {
  var _a;
  if (context.hasHostilePresence) {
    return false;
  }
  const controller = context.room.controller;
  if (!controller) {
    return true;
  }
  if (controller.owner != null) {
    return false;
  }
  const reservationUsername = (_a = controller.reservation) == null ? void 0 : _a.username;
  if (reservationUsername == null) {
    return true;
  }
  return reservationUsername === context.creepOwnerUsername;
}
function selectWorkerEnergyAcquisitionTask(creep) {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}
function selectSpawnRecoveryEnergyAcquisitionTask(creep, energySink) {
  const harvestEta = estimateHarvestDeliveryEta(creep, energySink);
  const candidates = findWorkerEnergyAcquisitionCandidates(creep).map((candidate) => createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink)).filter((candidate) => candidate !== null).filter((candidate) => harvestEta === null || candidate.deliveryEta <= harvestEta);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareSpawnRecoveryEnergyAcquisitionCandidates)[0].task;
}
function findWorkerEnergyAcquisitionCandidates(creep) {
  const context = {
    creepOwnerUsername: getCreepOwnerUsername2(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const storedEnergyCandidates = findVisibleRoomStructures(creep.room).filter((structure) => isSafeStoredEnergySource(structure, context)).map(
    (source) => createWorkerEnergyAcquisitionCandidate(creep, source, getStoredEnergy2(source), {
      type: "withdraw",
      targetId: source.id
    })
  );
  const salvageEnergyCandidates = [...findTombstones(creep.room), ...findRuins(creep.room)].filter(hasSalvageableEnergy).map(
    (source) => createWorkerEnergyAcquisitionCandidate(creep, source, getStoredEnergy2(source), {
      type: "withdraw",
      targetId: source.id
    })
  );
  const droppedEnergyCandidates = findDroppedResources(creep.room).filter(isUsefulDroppedEnergy).map(
    (source) => createWorkerEnergyAcquisitionCandidate(creep, source, source.amount, {
      type: "pickup",
      targetId: source.id
    })
  ).sort(compareDroppedEnergyReachabilityPriority).slice(0, MAX_DROPPED_ENERGY_REACHABILITY_CHECKS).filter((candidate) => isReachable(creep, candidate.source));
  return [...storedEnergyCandidates, ...salvageEnergyCandidates, ...droppedEnergyCandidates];
}
function createWorkerEnergyAcquisitionCandidate(creep, source, energy, task) {
  const range = getRangeToWorkerEnergyAcquisitionSource(creep, source);
  return {
    energy,
    range,
    score: range === null ? energy : energy - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task
  };
}
function createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink) {
  if (candidate.range === null) {
    return null;
  }
  const sourceToSinkRange = getRangeBetweenRoomObjects(candidate.source, energySink);
  if (sourceToSinkRange === null) {
    return null;
  }
  return {
    ...candidate,
    deliveryEta: candidate.range + ENERGY_ACQUISITION_ACTION_TICKS + sourceToSinkRange
  };
}
function estimateHarvestDeliveryEta(creep, energySink) {
  const source = selectHarvestSource(creep);
  if (!source) {
    return null;
  }
  const sourceAvailabilityDelay = estimateHarvestSourceAvailabilityDelay(source);
  if (sourceAvailabilityDelay === null) {
    return null;
  }
  const creepToSourceRange = getRangeBetweenRoomObjects(creep, source);
  const sourceToSinkRange = getRangeBetweenRoomObjects(source, energySink);
  if (creepToSourceRange === null || sourceToSinkRange === null) {
    return null;
  }
  return creepToSourceRange + sourceAvailabilityDelay + estimateHarvestTicks(creep, energySink) + sourceToSinkRange;
}
function estimateHarvestTicks(creep, energySink) {
  const energyNeeded = Math.max(1, Math.min(getFreeEnergyCapacity(creep), getFreeStoredEnergyCapacity(energySink)));
  const workParts = getActiveWorkParts(creep);
  if (workParts === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(energyNeeded / Math.max(HARVEST_ENERGY_PER_WORK_PART, workParts * HARVEST_ENERGY_PER_WORK_PART));
}
function estimateHarvestSourceAvailabilityDelay(source) {
  if (typeof source.energy !== "number") {
    return 0;
  }
  if (source.energy > 0) {
    return 0;
  }
  const ticksToRegeneration = source.ticksToRegeneration;
  return Number.isFinite(ticksToRegeneration) && ticksToRegeneration > 0 ? Math.ceil(ticksToRegeneration) : null;
}
function getActiveWorkParts(creep) {
  const workPart = globalThis.WORK;
  if (typeof workPart !== "string" || typeof creep.getActiveBodyparts !== "function") {
    return 1;
  }
  const activeWorkParts = creep.getActiveBodyparts(workPart);
  if (activeWorkParts === 0) {
    return 0;
  }
  return Number.isFinite(activeWorkParts) && activeWorkParts > 0 ? activeWorkParts : 1;
}
function getRangeBetweenRoomObjects(left, right) {
  const position = left.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) !== "function") {
    return null;
  }
  const range = position.getRangeTo(right);
  return Number.isFinite(range) ? Math.max(0, range) : null;
}
function getRangeToWorkerEnergyAcquisitionSource(creep, source) {
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) !== "function") {
    return null;
  }
  const range = position.getRangeTo(source);
  return Number.isFinite(range) ? Math.max(0, range) : null;
}
function isReachable(creep, target) {
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.findPathTo) !== "function") {
    return true;
  }
  const range = getRangeBetweenRoomObjects(creep, target);
  if (range !== null && range <= 1) {
    return true;
  }
  const path = position.findPathTo(target, { ignoreCreeps: true });
  return Array.isArray(path) && path.length > 0;
}
function compareWorkerEnergyAcquisitionCandidates(left, right) {
  return right.score - left.score || compareOptionalRanges(left.range, right.range) || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
}
function compareDroppedEnergyReachabilityPriority(left, right) {
  return compareOptionalRanges(left.range, right.range) || right.energy - left.energy || right.score - left.score || String(left.source.id).localeCompare(String(right.source.id));
}
function compareSpawnRecoveryEnergyAcquisitionCandidates(left, right) {
  return left.deliveryEta - right.deliveryEta || compareOptionalRanges(left.range, right.range) || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
}
function compareOptionalRanges(left, right) {
  if (left !== null && right !== null) {
    return left - right;
  }
  if (left !== null) {
    return -1;
  }
  if (right !== null) {
    return 1;
  }
  return 0;
}
function selectSalvageEnergySource(creep) {
  const salvageEnergySources = [...findTombstones(creep.room), ...findRuins(creep.room)].filter(hasSalvageableEnergy);
  if (salvageEnergySources.length === 0) {
    return null;
  }
  const closestSalvageEnergy = findClosestByRange(creep, salvageEnergySources);
  return closestSalvageEnergy != null ? closestSalvageEnergy : salvageEnergySources[0];
}
function findTombstones(room) {
  if (typeof FIND_TOMBSTONES !== "number") {
    return [];
  }
  return room.find(FIND_TOMBSTONES);
}
function findRuins(room) {
  if (typeof FIND_RUINS !== "number") {
    return [];
  }
  return room.find(FIND_RUINS);
}
function hasSalvageableEnergy(source) {
  return getStoredEnergy2(source) >= MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT;
}
function getCreepOwnerUsername2(creep) {
  var _a;
  const username = (_a = creep.owner) == null ? void 0 : _a.username;
  return typeof username === "string" && username.length > 0 ? username : null;
}
function hasVisibleHostilePresence(room) {
  return findHostileCreeps(room).length > 0 || findHostileStructures(room).length > 0;
}
function findHostileCreeps(room) {
  return typeof FIND_HOSTILE_CREEPS === "number" ? room.find(FIND_HOSTILE_CREEPS) : [];
}
function findHostileStructures(room) {
  return typeof FIND_HOSTILE_STRUCTURES === "number" ? room.find(FIND_HOSTILE_STRUCTURES) : [];
}
function selectRepairTarget(creep) {
  var _a;
  if (((_a = creep.room.controller) == null ? void 0 : _a.my) !== true) {
    return null;
  }
  const repairTargets = findVisibleRoomStructures(creep.room).filter(isSafeRepairTarget);
  if (repairTargets.length === 0) {
    return null;
  }
  return repairTargets.sort(compareRepairTargets)[0];
}
function selectCriticalInfrastructureRepairTarget(creep) {
  var _a;
  if (((_a = creep.room.controller) == null ? void 0 : _a.my) !== true) {
    return null;
  }
  const repairTargets = findVisibleRoomStructures(creep.room).filter(isCriticalInfrastructureRepairTarget);
  if (repairTargets.length === 0) {
    return null;
  }
  return repairTargets.sort(compareRepairTargets)[0];
}
function findVisibleRoomStructures(room) {
  if (typeof FIND_STRUCTURES !== "number") {
    return [];
  }
  return room.find(FIND_STRUCTURES);
}
function isSafeRepairTarget(structure) {
  if (isWorkerRepairTargetComplete(structure)) {
    return false;
  }
  if (isRoadOrContainerRepairTarget(structure)) {
    return true;
  }
  return matchesStructureType2(structure.structureType, "STRUCTURE_RAMPART", "rampart") && isOwnedRampart(structure);
}
function isCriticalInfrastructureRepairTarget(structure) {
  return isSafeRepairTarget(structure) && isRoadOrContainerRepairTarget(structure) && getHitsRatio(structure) <= CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO;
}
function isRoadOrContainerRepairTarget(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_ROAD", "road") || matchesStructureType2(structure.structureType, "STRUCTURE_CONTAINER", "container");
}
function isWorkerRepairTargetComplete(structure) {
  return structure.hits >= getWorkerRepairHitsCeiling(structure);
}
function getWorkerRepairHitsCeiling(structure) {
  if (matchesStructureType2(structure.structureType, "STRUCTURE_RAMPART", "rampart") && isOwnedRampart(structure)) {
    return Math.min(structure.hitsMax, IDLE_RAMPART_REPAIR_HITS_CEILING);
  }
  return structure.hitsMax;
}
function isOwnedRampart(structure) {
  return structure.my === true;
}
function compareRepairTargets(left, right) {
  return getRepairPriority(left) - getRepairPriority(right) || getHitsRatio(left) - getHitsRatio(right) || left.hits - right.hits || String(left.id).localeCompare(String(right.id));
}
function getRepairPriority(structure) {
  if (matchesStructureType2(structure.structureType, "STRUCTURE_ROAD", "road")) {
    return 0;
  }
  if (matchesStructureType2(structure.structureType, "STRUCTURE_CONTAINER", "container")) {
    return 1;
  }
  return 2;
}
function getHitsRatio(structure) {
  return structure.hitsMax > 0 ? structure.hits / structure.hitsMax : 1;
}
function shouldGuardControllerDowngrade(controller) {
  return (controller == null ? void 0 : controller.my) === true && typeof controller.ticksToDowngrade === "number" && controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS;
}
function shouldRushRcl1Controller(controller) {
  return controller.my === true && controller.level === 1;
}
function shouldApplyControllerPressureLane(creep, controller) {
  if (controller.my !== true || controller.level < 2) {
    return false;
  }
  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  return (loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS || loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE && hasActiveTerritoryPressure(creep)) && !loadedWorkers.some((worker) => worker !== creep && isUpgradingController(worker, controller));
}
function shouldUseSurplusForControllerProgress(creep, controller) {
  if (shouldApplyControllerPressureLane(creep, controller)) {
    return true;
  }
  return controller.my === true && controller.level >= 2 && hasWithdrawableSurplusEnergy(creep);
}
function hasWithdrawableSurplusEnergy(creep) {
  return selectStoredEnergySource(creep) !== null || selectSalvageEnergySource(creep) !== null;
}
function hasActiveTerritoryPressure(creep) {
  var _a;
  const colonyName = getCreepColonyName(creep);
  if (!colonyName) {
    return false;
  }
  const territoryMemory = (_a = globalThis.Memory) == null ? void 0 : _a.territory;
  if (!territoryMemory || !Array.isArray(territoryMemory.intents)) {
    return false;
  }
  return territoryMemory.intents.some((intent) => isActiveTerritoryPressureIntent(intent, colonyName));
}
function getCreepColonyName(creep) {
  var _a;
  const colony = (_a = creep.memory) == null ? void 0 : _a.colony;
  if (typeof colony === "string" && colony.length > 0) {
    return colony;
  }
  return null;
}
function isActiveTerritoryPressureIntent(intent, colonyName) {
  if (!isWorkerTaskRecord(intent)) {
    return false;
  }
  return intent.colony === colonyName && intent.targetRoom !== colonyName && (intent.status === "planned" || intent.status === "active") && (intent.action === "claim" || intent.action === "reserve" || intent.action === "scout");
}
function getSameRoomLoadedWorkers(creep) {
  const loadedWorkers = getGameCreeps().filter((candidate) => isSameRoomWorkerWithEnergy(candidate, creep.room));
  if (!loadedWorkers.includes(creep) && getUsedEnergy(creep) > 0) {
    loadedWorkers.push(creep);
  }
  return loadedWorkers;
}
function isSameRoomWorkerWithEnergy(creep, room) {
  var _a;
  return ((_a = creep.memory) == null ? void 0 : _a.role) === "worker" && isInRoom(creep, room) && getUsedEnergy(creep) > 0;
}
function isInRoom(creep, room) {
  var _a;
  if (typeof room.name === "string" && room.name.length > 0) {
    return ((_a = creep.room) == null ? void 0 : _a.name) === room.name;
  }
  return creep.room === room;
}
function getUsedEnergy(creep) {
  return getStoredEnergy2(creep);
}
function getFreeEnergyCapacity(creep) {
  return getFreeStoredEnergyCapacity(creep);
}
function getStoredEnergy2(object) {
  var _a;
  const store = getStore(object);
  if (!store) {
    return 0;
  }
  const usedCapacity = (_a = store.getUsedCapacity) == null ? void 0 : _a.call(store, getWorkerEnergyResource());
  if (typeof usedCapacity === "number") {
    return usedCapacity;
  }
  const storedEnergy = store[getWorkerEnergyResource()];
  return typeof storedEnergy === "number" ? storedEnergy : 0;
}
function getFreeStoredEnergyCapacity(object) {
  var _a;
  const store = getStore(object);
  if (!store) {
    return 0;
  }
  const freeCapacity = (_a = store.getFreeCapacity) == null ? void 0 : _a.call(store, getWorkerEnergyResource());
  return typeof freeCapacity === "number" ? freeCapacity : 0;
}
function getStore(object) {
  if (!isWorkerTaskRecord(object) || !isWorkerTaskRecord(object.store)) {
    return null;
  }
  return object.store;
}
function getWorkerEnergyResource() {
  const value = globalThis.RESOURCE_ENERGY;
  return typeof value === "string" ? value : "energy";
}
function isWorkerTaskRecord(value) {
  return typeof value === "object" && value !== null;
}
function isUpgradingController(creep, controller) {
  var _a;
  const task = (_a = creep.memory) == null ? void 0 : _a.task;
  return (task == null ? void 0 : task.type) === "upgrade" && task.targetId === controller.id;
}
function findDroppedResources(room) {
  if (typeof FIND_DROPPED_RESOURCES !== "number") {
    return [];
  }
  return room.find(FIND_DROPPED_RESOURCES);
}
function isUsefulDroppedEnergy(resource) {
  return resource.resourceType === getWorkerEnergyResource() && resource.amount >= MIN_DROPPED_ENERGY_PICKUP_AMOUNT;
}
function findClosestByRange(creep, objects) {
  if (objects.length === 0) {
    return null;
  }
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) === "function") {
    return objects.reduce((closest, candidate) => {
      var _a, _b, _c, _d;
      const closestRange = (_b = (_a = position.getRangeTo) == null ? void 0 : _a.call(position, closest)) != null ? _b : Infinity;
      const candidateRange = (_d = (_c = position.getRangeTo) == null ? void 0 : _c.call(position, candidate)) != null ? _d : Infinity;
      return candidateRange < closestRange ? candidate : closest;
    });
  }
  return typeof (position == null ? void 0 : position.findClosestByRange) === "function" ? position.findClosestByRange(objects) : null;
}
function selectHarvestSource(creep) {
  var _a, _b;
  const sources = creep.room.find(FIND_SOURCES);
  if (sources.length === 0) {
    return null;
  }
  const viableSources = selectViableHarvestSources(sources);
  const assignmentCounts = countSameRoomWorkerHarvestAssignments(creep.room.name, viableSources);
  let selectedSource = viableSources[0];
  let selectedCount = (_a = assignmentCounts.get(selectedSource.id)) != null ? _a : 0;
  for (const source of viableSources.slice(1)) {
    const count = (_b = assignmentCounts.get(source.id)) != null ? _b : 0;
    if (count < selectedCount) {
      selectedSource = source;
      selectedCount = count;
    }
  }
  return selectedSource;
}
function selectViableHarvestSources(sources) {
  const sourcesWithEnergy = sources.filter((source) => typeof source.energy === "number" && source.energy > 0);
  return sourcesWithEnergy.length > 0 ? sourcesWithEnergy : sources;
}
function countSameRoomWorkerHarvestAssignments(roomName, sources) {
  var _a, _b, _c, _d;
  const assignmentCounts = /* @__PURE__ */ new Map();
  for (const source of sources) {
    assignmentCounts.set(source.id, 0);
  }
  if (!roomName) {
    return assignmentCounts;
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  for (const assignedCreep of getGameCreeps()) {
    const task = (_a = assignedCreep.memory) == null ? void 0 : _a.task;
    const targetId = typeof (task == null ? void 0 : task.targetId) === "string" ? task.targetId : void 0;
    if (((_b = assignedCreep.memory) == null ? void 0 : _b.role) !== "worker" || ((_c = assignedCreep.room) == null ? void 0 : _c.name) !== roomName || (task == null ? void 0 : task.type) !== "harvest" || !targetId || !sourceIds.has(targetId)) {
      continue;
    }
    const sourceId = targetId;
    assignmentCounts.set(sourceId, ((_d = assignmentCounts.get(sourceId)) != null ? _d : 0) + 1);
  }
  return assignmentCounts;
}
function getGameCreeps() {
  var _a;
  const creeps = (_a = globalThis.Game) == null ? void 0 : _a.creeps;
  return creeps ? Object.values(creeps) : [];
}

// src/territory/controllerSigning.ts
var OCCUPIED_CONTROLLER_SIGN_TEXT = "by Hermes Screeps Project";
var ERR_NOT_IN_RANGE_CODE = -9;
var ERR_TIRED_CODE = -11;
var OK_CODE = 0;
function shouldSignOccupiedController(controller) {
  var _a;
  return (controller == null ? void 0 : controller.my) === true && ((_a = controller.sign) == null ? void 0 : _a.text) !== OCCUPIED_CONTROLLER_SIGN_TEXT;
}
function signOccupiedControllerIfNeeded(creep, controller) {
  if (!controller || !shouldSignOccupiedController(controller) || typeof creep.signController !== "function") {
    return "skipped";
  }
  const result = creep.signController(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    if (typeof creep.moveTo !== "function") {
      return "blocked";
    }
    const moveResult = creep.moveTo(controller);
    return moveResult === OK_CODE || moveResult === ERR_TIRED_CODE ? "moving" : "blocked";
  }
  return result === OK_CODE ? "signed" : "skipped";
}

// src/creeps/workerRunner.ts
function runWorker(creep) {
  const selectedTask = selectWorkerTask(creep);
  const currentTask = creep.memory.task;
  if (!currentTask) {
    assignSelectedTask(creep, selectedTask);
  } else if (shouldReplaceTask(creep, currentTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptForVisibleTerritoryControllerTask(currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptEnergyAcquisitionTaskForUrgentEnergySpending(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptTransferTaskForBetterEnergySink(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptSpendingTaskForEnergySink(currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptSpendingTaskForControllerPressure(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptUpgradeTask(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  }
  executeAssignedTask(creep, selectedTask);
}
function executeAssignedTask(creep, selectedTask) {
  let task = creep.memory.task;
  if (!task || !canExecuteTask(creep, task)) {
    return;
  }
  let target = Game.getObjectById(task.targetId);
  if (!target) {
    if (selectedTask && isSameTask(task, selectedTask)) {
      return;
    }
    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      return;
    }
    target = Game.getObjectById(task.targetId);
    if (!target) {
      return;
    }
  }
  if (shouldReplaceTarget(task, target)) {
    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      return;
    }
    target = Game.getObjectById(task.targetId);
    if (!target || shouldReplaceTarget(task, target)) {
      return;
    }
  }
  const result = executeTask(creep, task, target);
  if (task.type === "transfer" && result === ERR_FULL) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(target);
  }
}
function assignSelectedTask(creep, selectedTask, previousTask) {
  if (!selectedTask || previousTask && isSameTask(previousTask, selectedTask)) {
    delete creep.memory.task;
    return null;
  }
  creep.memory.task = selectedTask;
  return selectedTask;
}
function canExecuteTask(creep, task) {
  switch (task.type) {
    case "harvest":
      return typeof creep.harvest === "function";
    case "pickup":
      return typeof creep.pickup === "function";
    case "withdraw":
      return typeof creep.withdraw === "function";
    case "transfer":
      return typeof creep.transfer === "function";
    case "build":
      return typeof creep.build === "function";
    case "repair":
      return typeof creep.repair === "function";
    case "claim":
      return typeof creep.claimController === "function";
    case "reserve":
      return typeof creep.reserveController === "function";
    case "upgrade":
      return typeof creep.upgradeController === "function";
  }
}
function assignNextTask(creep) {
  const task = selectWorkerTask(creep);
  if (task) {
    creep.memory.task = task;
  }
}
function shouldReplaceTask(creep, task) {
  var _a, _b;
  if (isTerritoryControlTask2(task)) {
    return false;
  }
  if (!((_a = creep.store) == null ? void 0 : _a.getUsedCapacity) || !((_b = creep.store) == null ? void 0 : _b.getFreeCapacity)) {
    return false;
  }
  const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const freeEnergyCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);
  if (task.type === "harvest" || task.type === "pickup" || task.type === "withdraw") {
    return freeEnergyCapacity === 0;
  }
  return usedEnergy === 0;
}
function shouldPreemptForVisibleTerritoryControllerTask(task, selectedTask) {
  if (isTerritoryControlTask2(task)) {
    return !selectedTask || !isSameTask(task, selectedTask);
  }
  return isTerritoryControlTask2(selectedTask);
}
function shouldPreemptSpendingTaskForEnergySink(task, selectedTask) {
  if (!isEnergySpendingTask(task)) {
    return false;
  }
  return (selectedTask == null ? void 0 : selectedTask.type) === "transfer" && !isSameTask(task, selectedTask);
}
function shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep, task, selectedTask) {
  var _a, _b, _c;
  if (!isEnergyAcquisitionTask(task)) {
    return false;
  }
  if (!((_a = creep.store) == null ? void 0 : _a.getUsedCapacity) || !((_b = creep.store) == null ? void 0 : _b.getFreeCapacity)) {
    return false;
  }
  if (typeof ((_c = creep.room) == null ? void 0 : _c.find) !== "function") {
    return false;
  }
  const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  const freeEnergyCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY);
  if (usedEnergy !== 0 || freeEnergyCapacity <= 0) {
    return false;
  }
  return isRecoverableEnergyTask(selectedTask) && !isSameTask(task, selectedTask);
}
function shouldPreemptEnergyAcquisitionTaskForUrgentEnergySpending(creep, task, selectedTask) {
  var _a;
  if (!isEnergyAcquisitionTask(task)) {
    return false;
  }
  if (!selectedTask || isSameTask(task, selectedTask)) {
    return false;
  }
  if (!((_a = creep.store) == null ? void 0 : _a.getUsedCapacity)) {
    return false;
  }
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
    return false;
  }
  return isUrgentEnergySpendingTask(selectedTask);
}
function shouldPreemptTransferTaskForBetterEnergySink(creep, task, selectedTask) {
  var _a, _b;
  if (task.type !== "transfer") {
    return false;
  }
  if ((selectedTask == null ? void 0 : selectedTask.type) !== "transfer" || isSameTask(task, selectedTask)) {
    return false;
  }
  if (!((_a = creep.store) == null ? void 0 : _a.getUsedCapacity)) {
    return false;
  }
  if (typeof ((_b = creep.room) == null ? void 0 : _b.find) !== "function") {
    return false;
  }
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
    return false;
  }
  const currentTarget = Game.getObjectById(task.targetId);
  if (!isValidTransferTarget(currentTarget)) {
    return true;
  }
  const selectedTarget = Game.getObjectById(selectedTask.targetId);
  return getTransferSinkPriority(selectedTarget) > getTransferSinkPriority(currentTarget);
}
function shouldPreemptSpendingTaskForControllerPressure(creep, task, selectedTask) {
  var _a;
  if (!isEnergySpendingTask(task) || task.type === "upgrade") {
    return false;
  }
  if (typeof ((_a = creep.room) == null ? void 0 : _a.find) !== "function") {
    return false;
  }
  return isOwnedControllerUpgradeTask(creep, selectedTask) && !isSameTask(task, selectedTask);
}
function shouldPreemptUpgradeTask(creep, task, selectedTask) {
  var _a;
  if (task.type !== "upgrade") {
    return false;
  }
  const controller = (_a = creep.room) == null ? void 0 : _a.controller;
  if ((controller == null ? void 0 : controller.my) !== true) {
    return false;
  }
  if (selectedTask === null || isSameTask(task, selectedTask)) {
    return false;
  }
  return true;
}
function isOwnedControllerUpgradeTask(creep, task) {
  var _a, _b;
  return (task == null ? void 0 : task.type) === "upgrade" && ((_b = (_a = creep.room) == null ? void 0 : _a.controller) == null ? void 0 : _b.my) === true && task.targetId === creep.room.controller.id;
}
function isSameTask(left, right) {
  return left.type === right.type && left.targetId === right.targetId;
}
function isEnergySpendingTask(task) {
  return task.type === "build" || task.type === "repair" || task.type === "upgrade";
}
function isEnergyAcquisitionTask(task) {
  return task.type === "harvest" || task.type === "pickup" || task.type === "withdraw";
}
function isRecoverableEnergyTask(task) {
  return (task == null ? void 0 : task.type) === "pickup" || (task == null ? void 0 : task.type) === "withdraw";
}
function isTerritoryControlTask2(task) {
  return (task == null ? void 0 : task.type) === "claim" || (task == null ? void 0 : task.type) === "reserve";
}
function isValidTransferTarget(target) {
  return getFreeTransferEnergyCapacity(target) > 0;
}
function isUrgentEnergySpendingTask(task) {
  const target = getTaskTarget(task);
  if (task.type === "transfer") {
    return getTransferSinkPriority(target) >= 2;
  }
  return task.type === "build" && isCapacityEnablingConstructionSite(target);
}
function getTaskTarget(task) {
  const game = globalThis.Game;
  const getObjectById = game == null ? void 0 : game.getObjectById;
  return typeof getObjectById === "function" ? getObjectById(String(task.targetId)) : null;
}
function isCapacityEnablingConstructionSite(target) {
  const structureType = target == null ? void 0 : target.structureType;
  if (typeof structureType !== "string") {
    return false;
  }
  return matchesCapacityConstructionStructureType(structureType, "STRUCTURE_SPAWN", "spawn") || matchesCapacityConstructionStructureType(structureType, "STRUCTURE_EXTENSION", "extension");
}
function getFreeTransferEnergyCapacity(target) {
  var _a;
  const store = target == null ? void 0 : target.store;
  const freeCapacity = (_a = store == null ? void 0 : store.getFreeCapacity) == null ? void 0 : _a.call(store, RESOURCE_ENERGY);
  return typeof freeCapacity === "number" ? freeCapacity : 0;
}
function getTransferSinkPriority(target) {
  const structureType = target == null ? void 0 : target.structureType;
  if (typeof structureType !== "string") {
    return 0;
  }
  if (matchesTransferSinkStructureType(structureType, "STRUCTURE_SPAWN", "spawn") || matchesTransferSinkStructureType(structureType, "STRUCTURE_EXTENSION", "extension")) {
    return 2;
  }
  return matchesTransferSinkStructureType(structureType, "STRUCTURE_TOWER", "tower") ? 1 : 0;
}
function matchesTransferSinkStructureType(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}
function matchesCapacityConstructionStructureType(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}
function shouldReplaceTarget(task, target) {
  var _a;
  if (task.type === "transfer" && "store" in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    return true;
  }
  if (task.type === "withdraw" && "store" in target && ((_a = target.store.getUsedCapacity(RESOURCE_ENERGY)) != null ? _a : 0) === 0) {
    return true;
  }
  return task.type === "repair" && "hits" in target && isWorkerRepairTargetComplete(target);
}
function executeTask(creep, task, target) {
  switch (task.type) {
    case "harvest":
      return creep.harvest(target);
    case "pickup":
      return creep.pickup(target);
    case "withdraw":
      return creep.withdraw(target, RESOURCE_ENERGY);
    case "transfer":
      return creep.transfer(target, RESOURCE_ENERGY);
    case "build":
      return creep.build(target);
    case "repair":
      return creep.repair(target);
    case "claim":
      return creep.claimController(target);
    case "reserve":
      return creep.reserveController(target);
    case "upgrade":
      signOccupiedControllerIfNeeded(creep, target);
      return creep.upgradeController(target);
  }
}

// src/spawn/spawnPlanner.ts
var MIN_WORKER_TARGET = 3;
var WORKERS_PER_SOURCE = 2;
var CONSTRUCTION_BACKLOG_WORKER_BONUS = 1;
var SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT = 5;
var TERRITORY_SCOUT_BODY = ["move"];
var TERRITORY_SCOUT_BODY_COST = 50;
var MAX_WORKER_TARGET = 6;
var sourceCountByRoomName = /* @__PURE__ */ new Map();
function planSpawn(colony, roleCounts, gameTime, options = {}) {
  const workerTarget = getWorkerTarget(colony, roleCounts);
  const workerCapacity = getWorkerCapacity(roleCounts);
  const shouldPlanWorkerRecovery = workerCapacity < workerTarget;
  const nearWorkerTarget = workerCapacity >= workerTarget - 1;
  if (shouldPlanWorkerRecovery && (!nearWorkerTarget || options.workersOnly)) {
    return planWorkerSpawn(colony, roleCounts, gameTime, options);
  }
  if (options.workersOnly) {
    return null;
  }
  const territoryWorkerTarget = shouldPlanWorkerRecovery ? workerTarget - 1 : workerTarget;
  const territorySpawn = planTerritorySpawn(colony, roleCounts, territoryWorkerTarget, gameTime, options);
  if (territorySpawn) {
    return territorySpawn;
  }
  if (shouldPlanWorkerRecovery) {
    return planWorkerSpawn(colony, roleCounts, gameTime, options);
  }
  return null;
}
function planTerritorySpawn(colony, roleCounts, workerTarget, gameTime, options) {
  const territoryIntent = planTerritoryIntent(colony, roleCounts, workerTarget, gameTime);
  if (!territoryIntent || !shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts, gameTime)) {
    return null;
  }
  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  const body = buildTerritorySpawnBody(colony.energyAvailable, territoryIntent.action);
  if (body.length === 0) {
    return null;
  }
  const roleName = territoryIntent.action === "scout" ? "scout" : "claimer";
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`${roleName}-${colony.room.name}-${territoryIntent.targetRoom}-${gameTime}`, options),
    memory: buildTerritoryCreepMemory(territoryIntent)
  };
}
function planWorkerSpawn(colony, roleCounts, gameTime, options) {
  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  const body = selectWorkerBody(colony, roleCounts);
  if (body.length === 0) {
    return null;
  }
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`worker-${colony.room.name}-${gameTime}`, options),
    memory: { role: "worker", colony: colony.room.name }
  };
}
function appendSpawnNameSuffix(baseName, options) {
  return options.nameSuffix ? `${baseName}-${options.nameSuffix}` : baseName;
}
function selectWorkerBody(colony, roleCounts) {
  const normalBody = buildWorkerBody(colony.energyCapacityAvailable);
  if (canAffordBody(normalBody, colony.energyAvailable)) {
    return normalBody;
  }
  if (roleCounts.worker === 0) {
    return buildEmergencyWorkerBody(colony.energyAvailable);
  }
  return buildWorkerBody(colony.energyAvailable);
}
function canAffordBody(body, energyAvailable) {
  return body.length > 0 && getBodyCost(body) <= energyAvailable;
}
function buildTerritorySpawnBody(energyAvailable, action) {
  if (action === "scout") {
    return energyAvailable >= TERRITORY_SCOUT_BODY_COST ? [...TERRITORY_SCOUT_BODY] : [];
  }
  return buildTerritoryControllerBody(energyAvailable);
}
function getWorkerTarget(colony, roleCounts) {
  const sourceCount = getSourceCount(colony.room);
  const sourceAwareTarget = sourceCount * WORKERS_PER_SOURCE;
  const baseTarget = Math.min(MAX_WORKER_TARGET, Math.max(MIN_WORKER_TARGET, sourceAwareTarget));
  const workerCapacity = getWorkerCapacity(roleCounts);
  if (workerCapacity < baseTarget || !isConstructionBonusHomeSafe(colony.room.controller)) {
    return baseTarget;
  }
  const constructionBacklogSiteCount = getConstructionBacklogSiteCount(colony.room);
  if (constructionBacklogSiteCount === 0) {
    return baseTarget;
  }
  const firstBonusTarget = Math.min(MAX_WORKER_TARGET, baseTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS);
  if (workerCapacity < firstBonusTarget || constructionBacklogSiteCount < SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT) {
    return firstBonusTarget;
  }
  return Math.min(MAX_WORKER_TARGET, firstBonusTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS);
}
function isConstructionBonusHomeSafe(controller) {
  return (controller == null ? void 0 : controller.my) === true && (typeof controller.ticksToDowngrade !== "number" || controller.ticksToDowngrade > TERRITORY_DOWNGRADE_GUARD_TICKS);
}
function getConstructionBacklogSiteCount(room) {
  if (typeof room.find !== "function" || typeof FIND_MY_CONSTRUCTION_SITES !== "number") {
    return 0;
  }
  return room.find(FIND_MY_CONSTRUCTION_SITES).length;
}
function getSourceCount(room) {
  const roomName = typeof room.name === "string" && room.name.length > 0 ? room.name : void 0;
  if (roomName) {
    const cachedSourceCount = sourceCountByRoomName.get(roomName);
    if (cachedSourceCount !== void 0) {
      return cachedSourceCount;
    }
  }
  const sourceCount = findSourceCount(room);
  if (roomName) {
    sourceCountByRoomName.set(roomName, sourceCount);
  }
  return sourceCount;
}
function findSourceCount(room) {
  if (typeof FIND_SOURCES === "undefined" || typeof room.find !== "function") {
    return 1;
  }
  return room.find(FIND_SOURCES).length;
}

// src/construction/constructionPriority.ts
var CONTROLLER_DOWNGRADE_CRITICAL_TICKS = 5e3;
var CONTROLLER_DOWNGRADE_WARNING_TICKS = 1e4;
var EARLY_ENERGY_CAPACITY_TARGET = 550;
var MIN_SAFE_WORKERS_FOR_EXPANSION = 3;
var MAX_SCORE = 100;
var MAX_URGENCY_POINTS = 35;
var MAX_ROOM_STATE_POINTS = 20;
var MAX_EXPANSION_POINTS = 20;
var MAX_ECONOMIC_POINTS = 20;
var MAX_VISION_POINTS = 15;
var MAX_RISK_COST = 25;
var CRITICAL_REPAIR_HITS_RATIO = 0.5;
var DECAYING_REPAIR_HITS_RATIO = 0.8;
var IDLE_RAMPART_REPAIR_HITS_CEILING2 = 1e5;
var STRUCTURE_BUILD_COSTS = {
  spawn: 15e3,
  extension: 3e3,
  tower: 5e3,
  rampart: 1,
  road: 300,
  container: 5e3,
  storage: 3e4,
  "remote-logistics": 5e3,
  observation: 0
};
var EXPOSURE_COST = {
  none: 0,
  low: 2,
  medium: 5,
  high: 9
};
var OBSERVATION_LABELS = {
  "room-controller": "missing observation: room controller/RCL",
  "energy-capacity": "missing observation: room energy capacity",
  "worker-count": "missing observation: available worker count",
  "spawn-count": "missing observation: spawn count",
  "construction-sites": "missing observation: construction site backlog",
  "repair-decay": "missing observation: repair/decay signals",
  "hostile-presence": "missing observation: hostile pressure",
  sources: "missing observation: source count",
  "territory-intents": "missing observation: territory intent state",
  "remote-paths": "missing observation: remote path/logistics exposure"
};
function scoreConstructionPriorities(roomState, candidates) {
  const scoredCandidates = candidates.map((candidate) => scoreConstructionCandidate(roomState, candidate)).sort(compareConstructionPriorityScores);
  return {
    candidates: scoredCandidates,
    nextPrimary: selectNextPrimaryConstruction(scoredCandidates)
  };
}
function scoreConstructionCandidate(roomState, candidate) {
  var _a, _b, _c, _d, _e;
  const missingObservations = getMissingObservations(roomState, candidate);
  const blockingPreconditions = getBlockingPreconditions(roomState, candidate, missingObservations);
  const preconditions = [
    ...(_a = candidate.preconditions) != null ? _a : [],
    ...missingObservations.map((observation) => OBSERVATION_LABELS[observation]),
    ...blockingPreconditions
  ];
  const blocked = missingObservations.length > 0 || blockingPreconditions.length > 0;
  if (blocked) {
    return {
      buildItem: candidate.buildItem,
      room: (_b = candidate.roomName) != null ? _b : roomState.roomName,
      score: 0,
      urgency: "blocked",
      preconditions,
      expectedKpiMovement: candidate.expectedKpiMovement,
      risk: (_c = candidate.risk) != null ? _c : [],
      factors: {
        urgency: 0,
        roomState: 0,
        expansionPrerequisites: 0,
        economicBenefit: 0,
        visionWeight: 0,
        riskCost: 0
      },
      missingObservations,
      blocked
    };
  }
  const urgencyMagnitude = getUrgencyMagnitude(roomState, candidate);
  const factors = {
    urgency: Math.round(urgencyMagnitude * MAX_URGENCY_POINTS),
    roomState: scoreRoomState(roomState, candidate),
    expansionPrerequisites: scoreExpansionPrerequisites(roomState, candidate),
    economicBenefit: scoreEconomicBenefit(roomState, candidate),
    visionWeight: scoreVisionWeight(candidate),
    riskCost: scoreRiskCost(roomState, candidate)
  };
  const rawScore = factors.urgency + factors.roomState + factors.expansionPrerequisites + factors.economicBenefit + factors.visionWeight - factors.riskCost;
  const gatedScore = applySurvivalGate(roomState, candidate, rawScore);
  const score = clampScore(Math.round(gatedScore));
  return {
    buildItem: candidate.buildItem,
    room: (_d = candidate.roomName) != null ? _d : roomState.roomName,
    score,
    urgency: classifyUrgency(score, urgencyMagnitude),
    preconditions,
    expectedKpiMovement: candidate.expectedKpiMovement,
    risk: (_e = candidate.risk) != null ? _e : [],
    factors,
    missingObservations,
    blocked
  };
}
function selectNextPrimaryConstruction(candidates) {
  var _a;
  if (candidates.length === 0) {
    return null;
  }
  return (_a = candidates.find((candidate) => !candidate.blocked)) != null ? _a : candidates[0];
}
function buildRuntimeConstructionPriorityReport(colony, creeps) {
  const state = buildRuntimeConstructionPriorityState(colony, creeps);
  return scoreConstructionPriorities(state, buildRuntimeConstructionCandidates(state));
}
function getMissingObservations(roomState, candidate) {
  var _a;
  return ((_a = candidate.requiredObservations) != null ? _a : []).filter((observation) => !hasObservation(roomState, observation));
}
function hasObservation(roomState, observation) {
  var _a;
  const explicitObservation = (_a = roomState.observations) == null ? void 0 : _a[observation];
  if (typeof explicitObservation === "boolean") {
    return explicitObservation;
  }
  switch (observation) {
    case "room-controller":
      return typeof roomState.rcl === "number";
    case "energy-capacity":
      return typeof roomState.energyCapacity === "number";
    case "worker-count":
      return typeof roomState.workerCount === "number";
    case "spawn-count":
      return typeof roomState.spawnCount === "number";
    case "construction-sites":
      return typeof roomState.constructionSiteCount === "number";
    case "repair-decay":
      return typeof roomState.criticalRepairCount === "number" && typeof roomState.decayingStructureCount === "number";
    case "hostile-presence":
      return typeof roomState.hostileCreepCount === "number" && typeof roomState.hostileStructureCount === "number";
    case "sources":
      return typeof roomState.sourceCount === "number";
    case "territory-intents":
      return typeof roomState.activeTerritoryIntentCount === "number" && typeof roomState.plannedTerritoryIntentCount === "number";
    case "remote-paths":
      return roomState.remoteLogisticsReady === true;
    default:
      return false;
  }
}
function getBlockingPreconditions(roomState, candidate, missingObservations) {
  var _a, _b, _c, _d, _e, _f;
  if (missingObservations.length > 0) {
    return [];
  }
  const preconditions = [];
  if (typeof candidate.minimumRcl === "number" && ((_a = roomState.rcl) != null ? _a : 0) < candidate.minimumRcl) {
    preconditions.push(`requires RCL ${candidate.minimumRcl} (current RCL ${(_b = roomState.rcl) != null ? _b : "unknown"})`);
  }
  if (typeof candidate.minimumWorkers === "number" && ((_c = roomState.workerCount) != null ? _c : 0) < candidate.minimumWorkers) {
    preconditions.push(`needs ${candidate.minimumWorkers} available workers (current ${(_d = roomState.workerCount) != null ? _d : "unknown"})`);
  }
  if (typeof candidate.minimumEnergyCapacity === "number" && ((_e = roomState.energyCapacity) != null ? _e : 0) < candidate.minimumEnergyCapacity) {
    preconditions.push(
      `needs ${candidate.minimumEnergyCapacity} energy capacity (current ${(_f = roomState.energyCapacity) != null ? _f : "unknown"})`
    );
  }
  if (candidate.requiresSafeHome && hasSurvivalPressure(roomState)) {
    preconditions.push("resolve survival/recovery pressure before expansion construction");
  }
  return preconditions;
}
function getUrgencyMagnitude(roomState, candidate) {
  var _a;
  const signals = (_a = candidate.signals) != null ? _a : {};
  const recoveryUrgency = Math.max(
    normalizeSignal(signals.survivalRecovery),
    isRecoveryCandidate(candidate) ? getWorkerRecoveryPressure(roomState) : 0
  );
  const downgradeUrgency = Math.max(
    normalizeSignal(signals.controllerDowngrade),
    isControllerProtectionCandidate(candidate) ? getControllerDowngradePressure(roomState) : 0
  );
  const defenseUrgency = Math.max(
    normalizeSignal(signals.defense),
    isDefenseCandidate(candidate) ? getDefensePressure(roomState) : 0
  );
  const energyUrgency = Math.max(
    normalizeSignal(signals.energyBottleneck),
    isEnergyCapacityCandidate(candidate) ? getEnergyBottleneckPressure(roomState) : 0
  );
  const repairUrgency = Math.max(
    normalizeSignal(signals.repairDecay),
    isRepairSupportCandidate(candidate) ? getRepairDecayPressure(roomState) : 0
  );
  return Math.max(recoveryUrgency, downgradeUrgency, defenseUrgency, energyUrgency, repairUrgency);
}
function scoreRoomState(roomState, candidate) {
  var _a, _b, _c, _d, _e;
  let score = 0;
  if (candidate.status === "existing-site") {
    score += 4;
  }
  if (typeof roomState.rcl === "number" && (!candidate.minimumRcl || roomState.rcl >= candidate.minimumRcl)) {
    score += Math.min(5, Math.max(1, roomState.rcl));
  }
  if (isRecoveryCandidate(candidate)) {
    score += Math.round(getWorkerRecoveryPressure(roomState) * 7);
  } else if (((_a = roomState.workerCount) != null ? _a : 0) >= MIN_SAFE_WORKERS_FOR_EXPANSION) {
    score += 4;
  }
  if (isEnergyCapacityCandidate(candidate) && ((_b = roomState.energyCapacity) != null ? _b : EARLY_ENERGY_CAPACITY_TARGET) < EARLY_ENERGY_CAPACITY_TARGET) {
    score += 4;
  }
  if (isRepairSupportCandidate(candidate)) {
    score += Math.min(4, ((_c = roomState.criticalRepairCount) != null ? _c : 0) * 2 + ((_d = roomState.decayingStructureCount) != null ? _d : 0));
  }
  if (isDefenseCandidate(candidate)) {
    score += Math.round(getDefensePressure(roomState) * 5);
  }
  if (((_e = roomState.constructionSiteCount) != null ? _e : 0) > 0 && candidate.status === "existing-site") {
    score += 2;
  }
  return Math.min(MAX_ROOM_STATE_POINTS, score);
}
function scoreExpansionPrerequisites(roomState, candidate) {
  var _a, _b, _c;
  const signal = normalizeSignal((_a = candidate.signals) == null ? void 0 : _a.expansionPrerequisite);
  const territoryIntentPressure = Math.min(
    1,
    ((_b = roomState.activeTerritoryIntentCount) != null ? _b : 0) * 0.7 + ((_c = roomState.plannedTerritoryIntentCount) != null ? _c : 0) * 0.45
  );
  const structureMultiplier = candidate.buildType === "remote-logistics" || candidate.buildType === "road" || candidate.buildType === "container" || candidate.buildType === "tower" || candidate.buildType === "rampart" ? 1 : 0.35;
  return Math.min(
    MAX_EXPANSION_POINTS,
    Math.round(signal * 14 + territoryIntentPressure * structureMultiplier * 6)
  );
}
function scoreEconomicBenefit(roomState, candidate) {
  var _a;
  const signals = (_a = candidate.signals) != null ? _a : {};
  const score = normalizeSignal(signals.harvestThroughput) * 8 + normalizeSignal(signals.spawnUtilization) * 5 + normalizeSignal(signals.rclAcceleration) * 5 + normalizeSignal(signals.storageLogistics) * 4 + normalizeSignal(signals.energyBottleneck) * 4 + getSourceBenefit(roomState, candidate);
  return Math.min(MAX_ECONOMIC_POINTS, Math.round(score));
}
function scoreVisionWeight(candidate) {
  var _a;
  const vision = (_a = candidate.vision) != null ? _a : {};
  const score = normalizeSignal(vision.survival) * 15 + normalizeSignal(vision.territory) * 13 + normalizeSignal(vision.resources) * 9 + normalizeSignal(vision.enemyKills) * 5;
  return Math.min(MAX_VISION_POINTS, Math.round(score));
}
function scoreRiskCost(roomState, candidate) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  const energyCost = (_b = (_a = candidate.estimatedEnergyCost) != null ? _a : STRUCTURE_BUILD_COSTS[candidate.buildType]) != null ? _b : 0;
  const buildTicks = (_c = candidate.estimatedBuildTicks) != null ? _c : 0;
  const energyRisk = Math.min(8, energyCost / 4e3);
  const buildTimeRisk = Math.min(5, buildTicks / 1500);
  const exposureRisk = EXPOSURE_COST[(_d = candidate.pathExposure) != null ? _d : "none"] + EXPOSURE_COST[(_e = candidate.hostileExposure) != null ? _e : "none"];
  const backlogRisk = Math.max(0, (((_f = roomState.constructionSiteCount) != null ? _f : 0) - 3) * 1.5);
  const hostilePressureRisk = ((_g = roomState.hostileCreepCount) != null ? _g : 0) > 0 && !isDefenseCandidate(candidate) ? 4 : 0;
  const lowWorkerRisk = ((_h = roomState.workerCount) != null ? _h : MIN_SAFE_WORKERS_FOR_EXPANSION) < MIN_SAFE_WORKERS_FOR_EXPANSION && !isSurvivalCandidate(candidate) ? 4 : 0;
  return Math.min(
    MAX_RISK_COST,
    Math.round(energyRisk + buildTimeRisk + exposureRisk + backlogRisk + hostilePressureRisk + lowWorkerRisk)
  );
}
function applySurvivalGate(roomState, candidate, rawScore) {
  var _a, _b;
  if (!hasSurvivalPressure(roomState) || isSurvivalCandidate(candidate)) {
    return rawScore;
  }
  const hardRecoveryPressure = ((_a = roomState.workerCount) != null ? _a : MIN_SAFE_WORKERS_FOR_EXPANSION) === 0 || ((_b = roomState.spawnCount) != null ? _b : 1) === 0 || getControllerDowngradePressure(roomState) >= 0.85 || getDefensePressure(roomState) >= 0.9;
  return Math.min(rawScore, hardRecoveryPressure ? 45 : 60);
}
function classifyUrgency(score, urgencyMagnitude) {
  if (score >= 85 || urgencyMagnitude >= 0.9) {
    return "critical";
  }
  if (score >= 70 || urgencyMagnitude >= 0.7) {
    return "high";
  }
  if (score >= 45 || urgencyMagnitude >= 0.4) {
    return "medium";
  }
  return "low";
}
function compareConstructionPriorityScores(left, right) {
  if (left.blocked !== right.blocked) {
    return left.blocked ? 1 : -1;
  }
  return right.score - left.score || urgencyRank(right.urgency) - urgencyRank(left.urgency) || right.factors.visionWeight - left.factors.visionWeight || left.buildItem.localeCompare(right.buildItem) || left.room.localeCompare(right.room);
}
function urgencyRank(urgency) {
  switch (urgency) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    case "blocked":
      return 0;
    default:
      return 0;
  }
}
function hasSurvivalPressure(roomState) {
  var _a, _b;
  return ((_a = roomState.workerCount) != null ? _a : MIN_SAFE_WORKERS_FOR_EXPANSION) === 0 || ((_b = roomState.spawnCount) != null ? _b : 1) === 0 || getControllerDowngradePressure(roomState) >= 0.7 || getDefensePressure(roomState) >= 0.7;
}
function isSurvivalCandidate(candidate) {
  return isRecoveryCandidate(candidate) || isDefenseCandidate(candidate) || isControllerProtectionCandidate(candidate);
}
function isRecoveryCandidate(candidate) {
  var _a;
  return candidate.buildType === "spawn" || normalizeSignal((_a = candidate.signals) == null ? void 0 : _a.survivalRecovery) > 0;
}
function isControllerProtectionCandidate(candidate) {
  var _a;
  return candidate.buildType === "container" || candidate.buildType === "road" || normalizeSignal((_a = candidate.signals) == null ? void 0 : _a.controllerDowngrade) > 0;
}
function isDefenseCandidate(candidate) {
  var _a;
  return candidate.buildType === "tower" || candidate.buildType === "rampart" || normalizeSignal((_a = candidate.signals) == null ? void 0 : _a.defense) > 0;
}
function isEnergyCapacityCandidate(candidate) {
  var _a;
  return candidate.buildType === "extension" || normalizeSignal((_a = candidate.signals) == null ? void 0 : _a.energyBottleneck) > 0;
}
function isRepairSupportCandidate(candidate) {
  var _a;
  return candidate.buildType === "road" || candidate.buildType === "container" || candidate.buildType === "rampart" || normalizeSignal((_a = candidate.signals) == null ? void 0 : _a.repairDecay) > 0;
}
function getWorkerRecoveryPressure(roomState) {
  if (roomState.spawnCount === 0) {
    return 1;
  }
  const workerCount = roomState.workerCount;
  if (typeof workerCount !== "number") {
    return 0;
  }
  if (workerCount <= 0) {
    return 1;
  }
  if (workerCount === 1) {
    return 0.65;
  }
  if (workerCount === 2) {
    return 0.35;
  }
  return 0;
}
function getControllerDowngradePressure(roomState) {
  const ticksToDowngrade = roomState.controllerTicksToDowngrade;
  if (typeof ticksToDowngrade !== "number") {
    return 0;
  }
  if (ticksToDowngrade <= 1e3) {
    return 1;
  }
  if (ticksToDowngrade <= CONTROLLER_DOWNGRADE_CRITICAL_TICKS) {
    return 0.85;
  }
  if (ticksToDowngrade <= CONTROLLER_DOWNGRADE_WARNING_TICKS) {
    return 0.35;
  }
  return 0;
}
function getDefensePressure(roomState) {
  var _a, _b;
  if (((_a = roomState.hostileCreepCount) != null ? _a : 0) > 0) {
    return 0.9;
  }
  if (((_b = roomState.hostileStructureCount) != null ? _b : 0) > 0) {
    return 0.55;
  }
  return 0;
}
function getEnergyBottleneckPressure(roomState) {
  const energyCapacity = roomState.energyCapacity;
  if (typeof energyCapacity !== "number") {
    return 0;
  }
  if (energyCapacity < 350) {
    return 0.85;
  }
  if (energyCapacity < EARLY_ENERGY_CAPACITY_TARGET) {
    return 0.65;
  }
  return 0;
}
function getRepairDecayPressure(roomState) {
  var _a, _b;
  if (((_a = roomState.criticalRepairCount) != null ? _a : 0) > 0) {
    return 0.7;
  }
  if (((_b = roomState.decayingStructureCount) != null ? _b : 0) > 0) {
    return 0.35;
  }
  return 0;
}
function getSourceBenefit(roomState, candidate) {
  var _a;
  if (candidate.buildType !== "container" && candidate.buildType !== "road" && candidate.buildType !== "remote-logistics") {
    return 0;
  }
  return Math.min(3, (_a = roomState.sourceCount) != null ? _a : 0);
}
function normalizeSignal(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
function clampScore(score) {
  return Math.max(0, Math.min(MAX_SCORE, score));
}
function buildRuntimeConstructionPriorityState(colony, creeps) {
  var _a, _b, _c;
  const room = colony.room;
  const ownedConstructionSites = findRoomObjects2(room, "FIND_MY_CONSTRUCTION_SITES");
  const ownedStructures = findRoomObjects2(room, "FIND_MY_STRUCTURES");
  const visibleStructures = findRoomObjects2(room, "FIND_STRUCTURES");
  const hostileCreeps = findRoomObjects2(room, "FIND_HOSTILE_CREEPS");
  const hostileStructures = findRoomObjects2(room, "FIND_HOSTILE_STRUCTURES");
  const sources = findRoomObjects2(room, "FIND_SOURCES");
  const colonyWorkers = creeps.filter((creep) => {
    var _a2, _b2;
    return ((_a2 = creep.memory) == null ? void 0 : _a2.role) === "worker" && ((_b2 = creep.memory) == null ? void 0 : _b2.colony) === room.name;
  });
  const repairSignals = summarizeRepairSignals(visibleStructures);
  const territoryIntentCounts = countTerritoryIntents(room.name);
  return {
    roomName: room.name,
    rcl: ((_a = room.controller) == null ? void 0 : _a.my) === true ? room.controller.level : void 0,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnCount: colony.spawns.length,
    sourceCount: sources == null ? void 0 : sources.length,
    extensionCount: countStructuresByType(ownedStructures, "STRUCTURE_EXTENSION", "extension"),
    towerCount: countStructuresByType(ownedStructures, "STRUCTURE_TOWER", "tower"),
    constructionSiteCount: ownedConstructionSites == null ? void 0 : ownedConstructionSites.length,
    criticalRepairCount: repairSignals == null ? void 0 : repairSignals.criticalRepairCount,
    decayingStructureCount: repairSignals == null ? void 0 : repairSignals.decayingStructureCount,
    controllerTicksToDowngrade: ((_b = room.controller) == null ? void 0 : _b.my) === true ? room.controller.ticksToDowngrade : void 0,
    hostileCreepCount: hostileCreeps == null ? void 0 : hostileCreeps.length,
    hostileStructureCount: hostileStructures == null ? void 0 : hostileStructures.length,
    activeTerritoryIntentCount: territoryIntentCounts.active,
    plannedTerritoryIntentCount: territoryIntentCounts.planned,
    remoteLogisticsReady: false,
    observations: {
      "room-controller": ((_c = room.controller) == null ? void 0 : _c.my) === true && typeof room.controller.level === "number",
      "energy-capacity": typeof colony.energyCapacityAvailable === "number",
      "worker-count": true,
      "spawn-count": true,
      "construction-sites": ownedConstructionSites !== null,
      "repair-decay": visibleStructures !== null,
      "hostile-presence": hostileCreeps !== null && hostileStructures !== null,
      sources: sources !== null,
      "territory-intents": true,
      "remote-paths": false
    },
    ownedConstructionSites,
    ownedStructures,
    visibleStructures
  };
}
function buildRuntimeConstructionCandidates(state) {
  const candidates = [
    ...buildExistingSiteCandidates(state),
    ...buildPlannedLocalCandidates(state),
    ...buildRemoteLogisticsCandidates(state)
  ];
  if (candidates.length > 0) {
    return candidates;
  }
  return [
    {
      buildItem: "observe construction backlog",
      buildType: "observation",
      requiredObservations: ["construction-sites"],
      expectedKpiMovement: ["construction priority table becomes evidence-backed"],
      risk: ["no build action should be selected until construction-site observations exist"],
      vision: { resources: 0.2 }
    }
  ];
}
function buildExistingSiteCandidates(state) {
  var _a;
  return ((_a = state.ownedConstructionSites) != null ? _a : []).map((site) => {
    const buildType = mapStructureTypeToBuildType(String(site.structureType));
    return {
      ...createCandidateForBuildType(buildType, state),
      buildItem: `finish ${site.structureType} site`,
      status: "existing-site",
      estimatedEnergyCost: getConstructionSiteRemainingProgress(site)
    };
  });
}
function buildPlannedLocalCandidates(state) {
  var _a, _b, _c, _d, _e;
  const candidates = [];
  const rcl = (_a = state.rcl) != null ? _a : 0;
  const extensionLimit = getExtensionLimitForRcl(state.rcl);
  if (extensionLimit > 0 && ((_b = state.extensionCount) != null ? _b : 0) < extensionLimit) {
    candidates.push(createCandidateForBuildType("extension", state));
  }
  if (rcl >= 2 && ((_c = state.sourceCount) != null ? _c : 0) > 0) {
    candidates.push(createCandidateForBuildType("road", state));
    candidates.push(createCandidateForBuildType("container", state));
  }
  if (rcl >= 2 && getDefensePressure(state) > 0) {
    candidates.push(createCandidateForBuildType("rampart", state));
  }
  if (rcl >= 3 && ((_d = state.towerCount) != null ? _d : 0) === 0) {
    candidates.push(createCandidateForBuildType("tower", state));
  }
  if (((_e = state.spawnCount) != null ? _e : 1) === 0) {
    candidates.push(createCandidateForBuildType("spawn", state));
  }
  return candidates;
}
function buildRemoteLogisticsCandidates(state) {
  var _a, _b;
  const territoryIntentCount = ((_a = state.activeTerritoryIntentCount) != null ? _a : 0) + ((_b = state.plannedTerritoryIntentCount) != null ? _b : 0);
  if (territoryIntentCount === 0) {
    return [];
  }
  return [createCandidateForBuildType("remote-logistics", state)];
}
function createCandidateForBuildType(buildType, state) {
  var _a, _b;
  switch (buildType) {
    case "spawn":
      return {
        buildItem: "build spawn recovery",
        buildType,
        minimumRcl: 1,
        requiredObservations: ["spawn-count", "worker-count", "room-controller"],
        expectedKpiMovement: ["restores worker production and prevents room loss"],
        risk: ["high energy commitment before economy is recovered"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.spawn,
        signals: { survivalRecovery: 1, spawnUtilization: 0.8 },
        vision: { survival: 1, territory: 0.6 }
      };
    case "extension":
      return {
        buildItem: "build extension capacity",
        buildType,
        minimumRcl: 2,
        requiredObservations: ["room-controller", "energy-capacity", "worker-count", "construction-sites"],
        expectedKpiMovement: ["raises spawn energy capacity", "unlocks larger workers and faster RCL progress"],
        risk: ["adds build backlog before roads/containers if worker capacity is low"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.extension,
        signals: {
          energyBottleneck: getEnergyBottleneckPressure(state),
          spawnUtilization: 0.8,
          rclAcceleration: 0.65
        },
        vision: { resources: 1, territory: 0.35 }
      };
    case "tower":
      return {
        buildItem: "build tower defense",
        buildType,
        minimumRcl: 3,
        requiredObservations: ["room-controller", "hostile-presence", "energy-capacity", "worker-count"],
        expectedKpiMovement: ["improves room hold safety", "adds hostile damage and repair response capacity"],
        risk: ["requires steady energy income to keep tower effective"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.tower,
        hostileExposure: "medium",
        signals: { defense: Math.max(0.75, getDefensePressure(state)), enemyKillPotential: 0.7 },
        vision: { survival: getDefensePressure(state), territory: 0.9, enemyKills: 0.5 }
      };
    case "rampart":
      return {
        buildItem: "build rampart defense",
        buildType,
        minimumRcl: 2,
        requiredObservations: ["room-controller", "hostile-presence", "repair-decay", "worker-count"],
        expectedKpiMovement: ["improves spawn/controller survivability under pressure"],
        risk: ["decays without sustained repair budget"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.rampart,
        hostileExposure: "medium",
        signals: { defense: getDefensePressure(state), repairDecay: getRepairDecayPressure(state) },
        vision: { survival: getDefensePressure(state), territory: 0.8, enemyKills: 0.15 }
      };
    case "road":
      return {
        buildItem: "build source/controller roads",
        buildType,
        minimumRcl: 2,
        requiredObservations: ["room-controller", "sources", "repair-decay", "worker-count"],
        expectedKpiMovement: ["reduces worker travel time", "improves harvest-to-spawn throughput"],
        risk: ["road decay creates recurring repair load"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.road,
        pathExposure: "low",
        signals: {
          harvestThroughput: 0.55,
          rclAcceleration: 0.45,
          expansionPrerequisite: ((_a = state.activeTerritoryIntentCount) != null ? _a : 0) > 0 ? 0.45 : 0.2,
          controllerDowngrade: getControllerDowngradePressure(state) >= 0.7 ? 0.55 : 0
        },
        vision: { resources: 0.8, territory: 0.45 }
      };
    case "container":
      return {
        buildItem: "build source containers",
        buildType,
        minimumRcl: 2,
        requiredObservations: ["room-controller", "sources", "worker-count"],
        expectedKpiMovement: ["raises harvest throughput", "reduces dropped-energy waste"],
        risk: ["large early build cost and decay upkeep"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.container,
        pathExposure: "low",
        signals: {
          harvestThroughput: 0.9,
          storageLogistics: 0.65,
          rclAcceleration: 0.35,
          expansionPrerequisite: ((_b = state.activeTerritoryIntentCount) != null ? _b : 0) > 0 ? 0.4 : 0.15,
          controllerDowngrade: getControllerDowngradePressure(state) >= 0.7 ? 0.5 : 0
        },
        vision: { resources: 1, territory: 0.35 }
      };
    case "storage":
      return {
        buildItem: "build storage logistics",
        buildType,
        minimumRcl: 4,
        minimumWorkers: MIN_SAFE_WORKERS_FOR_EXPANSION,
        requiredObservations: ["room-controller", "energy-capacity", "worker-count"],
        expectedKpiMovement: ["improves durable resource buffering and logistics"],
        risk: ["very high energy commitment"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.storage,
        signals: { storageLogistics: 0.95 },
        vision: { resources: 1, territory: 0.25 }
      };
    case "remote-logistics":
      return {
        buildItem: "build remote road/container logistics",
        buildType,
        minimumRcl: 2,
        minimumWorkers: MIN_SAFE_WORKERS_FOR_EXPANSION,
        requiresSafeHome: true,
        requiredObservations: ["territory-intents", "remote-paths", "worker-count", "hostile-presence"],
        expectedKpiMovement: ["turns reserved/scouted territory into sustainable income", "improves remote room hold viability"],
        risk: ["path exposure and hostile pressure can waste builder time"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS["remote-logistics"],
        pathExposure: "high",
        hostileExposure: "medium",
        signals: {
          expansionPrerequisite: 1,
          harvestThroughput: 0.75,
          storageLogistics: 0.5
        },
        vision: { territory: 1, resources: 0.6 }
      };
    case "observation":
    default:
      return {
        buildItem: "observe construction backlog",
        buildType: "observation",
        requiredObservations: ["construction-sites"],
        expectedKpiMovement: ["construction priority table becomes evidence-backed"],
        risk: ["no build action should be selected until construction-site observations exist"],
        signals: {},
        vision: { resources: 0.2 }
      };
  }
}
function mapStructureTypeToBuildType(structureType) {
  if (matchesStructureType3(structureType, "STRUCTURE_SPAWN", "spawn")) {
    return "spawn";
  }
  if (matchesStructureType3(structureType, "STRUCTURE_EXTENSION", "extension")) {
    return "extension";
  }
  if (matchesStructureType3(structureType, "STRUCTURE_TOWER", "tower")) {
    return "tower";
  }
  if (matchesStructureType3(structureType, "STRUCTURE_RAMPART", "rampart")) {
    return "rampart";
  }
  if (matchesStructureType3(structureType, "STRUCTURE_ROAD", "road")) {
    return "road";
  }
  if (matchesStructureType3(structureType, "STRUCTURE_CONTAINER", "container")) {
    return "container";
  }
  if (matchesStructureType3(structureType, "STRUCTURE_STORAGE", "storage")) {
    return "storage";
  }
  return "observation";
}
function getConstructionSiteRemainingProgress(site) {
  var _a;
  const progressTotal = typeof site.progressTotal === "number" ? site.progressTotal : (_a = STRUCTURE_BUILD_COSTS.observation) != null ? _a : 0;
  const progress = typeof site.progress === "number" ? site.progress : 0;
  return Math.max(0, progressTotal - progress);
}
function findRoomObjects2(room, constantName) {
  const findConstant = globalThis[constantName];
  if (typeof findConstant !== "number" || typeof room.find !== "function") {
    return null;
  }
  try {
    const result = room.find(findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return null;
  }
}
function countStructuresByType(structures, globalName, fallback) {
  return structures == null ? void 0 : structures.filter((structure) => matchesStructureType3(structure.structureType, globalName, fallback)).length;
}
function summarizeRepairSignals(structures) {
  if (structures === null) {
    return null;
  }
  return structures.reduce(
    (summary, structure) => {
      if (!isRepairSignalStructure(structure) || !hasHits(structure)) {
        return summary;
      }
      const hitsRatio = structure.hitsMax > 0 ? structure.hits / structure.hitsMax : 1;
      if (hitsRatio <= CRITICAL_REPAIR_HITS_RATIO) {
        summary.criticalRepairCount += 1;
      } else if (hitsRatio <= DECAYING_REPAIR_HITS_RATIO) {
        summary.decayingStructureCount += 1;
      }
      return summary;
    },
    { criticalRepairCount: 0, decayingStructureCount: 0 }
  );
}
function isRepairSignalStructure(structure) {
  if (matchesStructureType3(structure.structureType, "STRUCTURE_ROAD", "road") || matchesStructureType3(structure.structureType, "STRUCTURE_CONTAINER", "container")) {
    return true;
  }
  return matchesStructureType3(structure.structureType, "STRUCTURE_RAMPART", "rampart") && structure.my === true && structure.hits <= IDLE_RAMPART_REPAIR_HITS_CEILING2;
}
function hasHits(structure) {
  return typeof structure.hits === "number" && typeof structure.hitsMax === "number";
}
function countTerritoryIntents(roomName) {
  var _a, _b;
  const intents = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.intents;
  if (!Array.isArray(intents)) {
    return { active: 0, planned: 0 };
  }
  return intents.reduce(
    (counts, intent) => {
      if (!isRecord3(intent)) {
        return counts;
      }
      if (intent.colony !== roomName) {
        return counts;
      }
      if (intent.status === "active") {
        counts.active += 1;
      } else if (intent.status === "planned") {
        counts.planned += 1;
      }
      return counts;
    },
    { active: 0, planned: 0 }
  );
}
function isRecord3(value) {
  return typeof value === "object" && value !== null;
}
function matchesStructureType3(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}

// src/telemetry/runtimeSummary.ts
var RUNTIME_SUMMARY_PREFIX = "#runtime-summary ";
var RUNTIME_SUMMARY_INTERVAL = 20;
var MAX_REPORTED_EVENTS = 10;
var WORKER_TASK_TYPES = ["harvest", "transfer", "build", "upgrade"];
function emitRuntimeSummary(colonies, creeps, events = []) {
  if (colonies.length === 0 && events.length === 0) {
    return;
  }
  const tick = getGameTime3();
  if (!shouldEmitRuntimeSummary(tick, events)) {
    return;
  }
  const reportedEvents = events.slice(0, MAX_REPORTED_EVENTS);
  const summary = {
    type: "runtime-summary",
    tick,
    rooms: colonies.map((colony) => summarizeRoom(colony, creeps)),
    ...reportedEvents.length > 0 ? { events: reportedEvents } : {},
    ...events.length > MAX_REPORTED_EVENTS ? { omittedEventCount: events.length - MAX_REPORTED_EVENTS } : {},
    ...buildCpuSummary()
  };
  console.log(`${RUNTIME_SUMMARY_PREFIX}${JSON.stringify(summary)}`);
}
function shouldEmitRuntimeSummary(tick, events) {
  return events.length > 0 || tick > 0 && tick % RUNTIME_SUMMARY_INTERVAL === 0;
}
function summarizeRoom(colony, creeps) {
  const colonyWorkers = creeps.filter((creep) => creep.memory.role === "worker" && creep.memory.colony === colony.room.name);
  const eventMetrics = summarizeRoomEventMetrics(colony.room);
  const territoryRecommendation = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
  persistOccupationRecommendationFollowUpIntent(territoryRecommendation, getGameTime3());
  return {
    roomName: colony.room.name,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnStatus: colony.spawns.map(summarizeSpawn),
    taskCounts: countWorkerTasks(colonyWorkers),
    ...buildControllerSummary(colony.room),
    resources: summarizeResources(colony, colonyWorkers, eventMetrics.resources),
    combat: summarizeCombat(colony.room, eventMetrics.combat),
    constructionPriority: summarizeConstructionPriority(colony, colonyWorkers),
    territoryRecommendation
  };
}
function summarizeSpawn(spawn) {
  if (!spawn.spawning) {
    return {
      name: spawn.name,
      status: "idle"
    };
  }
  return {
    name: spawn.name,
    status: "spawning",
    creepName: spawn.spawning.name,
    remainingTime: spawn.spawning.remainingTime
  };
}
function countWorkerTasks(workers) {
  var _a;
  const counts = {
    harvest: 0,
    transfer: 0,
    build: 0,
    upgrade: 0,
    none: 0
  };
  for (const worker of workers) {
    const taskType = (_a = worker.memory.task) == null ? void 0 : _a.type;
    if (isWorkerTaskType(taskType)) {
      counts[taskType] += 1;
    } else {
      counts.none += 1;
    }
  }
  return counts;
}
function isWorkerTaskType(taskType) {
  return WORKER_TASK_TYPES.includes(taskType);
}
function buildControllerSummary(room) {
  const controller = room.controller;
  if (!(controller == null ? void 0 : controller.my)) {
    return {};
  }
  const summary = {
    level: controller.level
  };
  if (typeof controller.progress === "number") {
    summary.progress = controller.progress;
  }
  if (typeof controller.progressTotal === "number") {
    summary.progressTotal = controller.progressTotal;
  }
  if (typeof controller.ticksToDowngrade === "number") {
    summary.ticksToDowngrade = controller.ticksToDowngrade;
  }
  return { controller: summary };
}
function summarizeResources(colony, colonyWorkers, events) {
  var _a, _b, _c;
  const roomStructures = (_a = findRoomObjects3(colony.room, "FIND_STRUCTURES")) != null ? _a : colony.spawns;
  const droppedResources = (_b = findRoomObjects3(colony.room, "FIND_DROPPED_RESOURCES")) != null ? _b : [];
  const sources = (_c = findRoomObjects3(colony.room, "FIND_SOURCES")) != null ? _c : [];
  return {
    storedEnergy: sumEnergyInStores(roomStructures),
    workerCarriedEnergy: sumEnergyInStores(colonyWorkers),
    droppedEnergy: sumDroppedEnergy(droppedResources),
    sourceCount: sources.length,
    ...events ? { events } : {}
  };
}
function summarizeCombat(room, events) {
  var _a, _b;
  const hostileCreeps = (_a = findRoomObjects3(room, "FIND_HOSTILE_CREEPS")) != null ? _a : [];
  const hostileStructures = (_b = findRoomObjects3(room, "FIND_HOSTILE_STRUCTURES")) != null ? _b : [];
  return {
    hostileCreepCount: hostileCreeps.length,
    hostileStructureCount: hostileStructures.length,
    ...events ? { events } : {}
  };
}
function summarizeConstructionPriority(colony, colonyWorkers) {
  const report = buildRuntimeConstructionPriorityReport(colony, colonyWorkers);
  return {
    candidates: report.candidates.map(toRuntimeConstructionPriorityCandidateSummary),
    nextPrimary: report.nextPrimary ? toRuntimeConstructionPriorityCandidateSummary(report.nextPrimary) : null
  };
}
function toRuntimeConstructionPriorityCandidateSummary(score) {
  return {
    buildItem: score.buildItem,
    room: score.room,
    score: score.score,
    urgency: score.urgency,
    preconditions: score.preconditions,
    expectedKpiMovement: score.expectedKpiMovement,
    risk: score.risk
  };
}
function summarizeRoomEventMetrics(room) {
  const eventLog = getRoomEventLog(room);
  if (!eventLog) {
    return {};
  }
  const harvestEvent = getGlobalNumber2("EVENT_HARVEST");
  const transferEvent = getGlobalNumber2("EVENT_TRANSFER");
  const attackEvent = getGlobalNumber2("EVENT_ATTACK");
  const objectDestroyedEvent = getGlobalNumber2("EVENT_OBJECT_DESTROYED");
  const resourceEvents = {
    harvestedEnergy: 0,
    transferredEnergy: 0
  };
  const combatEvents = {
    attackCount: 0,
    attackDamage: 0,
    objectDestroyedCount: 0,
    creepDestroyedCount: 0
  };
  let hasResourceEvents = false;
  let hasCombatEvents = false;
  for (const entry of eventLog) {
    if (!isRecord4(entry) || typeof entry.event !== "number") {
      continue;
    }
    const data = isRecord4(entry.data) ? entry.data : {};
    if (entry.event === harvestEvent && isEnergyEventData(data)) {
      resourceEvents.harvestedEnergy += getNumericEventData(data, "amount");
      hasResourceEvents = true;
    }
    if (entry.event === transferEvent && isEnergyEventData(data)) {
      resourceEvents.transferredEnergy += getNumericEventData(data, "amount");
      hasResourceEvents = true;
    }
    if (entry.event === attackEvent) {
      combatEvents.attackCount += 1;
      combatEvents.attackDamage += getNumericEventData(data, "damage");
      hasCombatEvents = true;
    }
    if (entry.event === objectDestroyedEvent) {
      combatEvents.objectDestroyedCount += 1;
      if (data.type === "creep") {
        combatEvents.creepDestroyedCount += 1;
      }
      hasCombatEvents = true;
    }
  }
  return {
    ...hasResourceEvents ? { resources: resourceEvents } : {},
    ...hasCombatEvents ? { combat: combatEvents } : {}
  };
}
function findRoomObjects3(room, constantName) {
  const findConstant = getGlobalNumber2(constantName);
  const find = room.find;
  if (typeof findConstant !== "number" || typeof find !== "function") {
    return void 0;
  }
  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return void 0;
  }
}
function getRoomEventLog(room) {
  const getEventLog = room.getEventLog;
  if (typeof getEventLog !== "function") {
    return void 0;
  }
  try {
    const eventLog = getEventLog.call(room);
    return Array.isArray(eventLog) ? eventLog : void 0;
  } catch {
    return void 0;
  }
}
function sumEnergyInStores(objects) {
  return objects.reduce((total, object) => total + getEnergyInStore(object), 0);
}
function getEnergyInStore(object) {
  if (!isRecord4(object) || !isRecord4(object.store)) {
    return 0;
  }
  const getUsedCapacity = object.store.getUsedCapacity;
  if (typeof getUsedCapacity === "function") {
    const usedCapacity = getUsedCapacity.call(object.store, getEnergyResource2());
    return typeof usedCapacity === "number" ? usedCapacity : 0;
  }
  const storedEnergy = object.store[getEnergyResource2()];
  return typeof storedEnergy === "number" ? storedEnergy : 0;
}
function sumDroppedEnergy(droppedResources) {
  const energyResource = getEnergyResource2();
  return droppedResources.reduce((total, droppedResource) => {
    if (!isRecord4(droppedResource) || droppedResource.resourceType !== energyResource) {
      return total;
    }
    return total + (typeof droppedResource.amount === "number" ? droppedResource.amount : 0);
  }, 0);
}
function isEnergyEventData(data) {
  return data.resourceType === void 0 || data.resourceType === getEnergyResource2();
}
function getNumericEventData(data, key) {
  const value = data[key];
  return typeof value === "number" ? value : 0;
}
function getGlobalNumber2(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getEnergyResource2() {
  const value = globalThis.RESOURCE_ENERGY;
  return typeof value === "string" ? value : "energy";
}
function isRecord4(value) {
  return typeof value === "object" && value !== null;
}
function buildCpuSummary() {
  const gameWithOptionalCpu = Game;
  const cpu = gameWithOptionalCpu.cpu;
  if (!cpu) {
    return {};
  }
  const summary = {};
  if (typeof cpu.getUsed === "function") {
    summary.used = cpu.getUsed();
  }
  if (typeof cpu.bucket === "number") {
    summary.bucket = cpu.bucket;
  }
  return Object.keys(summary).length > 0 ? { cpu: summary } : {};
}
function getGameTime3() {
  return typeof Game.time === "number" ? Game.time : 0;
}

// src/territory/territoryRunner.ts
var ERR_NOT_IN_RANGE_CODE2 = -9;
var ERR_INVALID_TARGET_CODE = -7;
var ERR_GCL_NOT_ENOUGH_CODE = -15;
var OK_CODE2 = 0;
var CLAIM_FATAL_RESULT_CODES = /* @__PURE__ */ new Set([
  ERR_INVALID_TARGET_CODE,
  ERR_GCL_NOT_ENOUGH_CODE
]);
var RESERVE_FATAL_RESULT_CODES = /* @__PURE__ */ new Set([ERR_INVALID_TARGET_CODE]);
function runTerritoryControllerCreep(creep) {
  var _a;
  const assignment = creep.memory.territory;
  if (!isTerritoryAssignment(assignment)) {
    return;
  }
  if (isVisibleTerritoryAssignmentComplete(assignment, creep)) {
    completeTerritoryAssignment(creep);
    return;
  }
  if (!isVisibleTerritoryAssignmentSafe(assignment, creep.memory.colony, creep)) {
    suppressTerritoryAssignment(creep, assignment);
    return;
  }
  if (((_a = creep.room) == null ? void 0 : _a.name) !== assignment.targetRoom) {
    moveTowardTargetRoom(creep, assignment.targetRoom);
    return;
  }
  if (assignment.action === "scout") {
    return;
  }
  const controller = selectTargetController(creep, assignment);
  if (!controller) {
    suppressTerritoryAssignment(creep, assignment);
    return;
  }
  if (controller.my === true) {
    if (assignment.action === "reserve") {
      suppressTerritoryAssignment(creep, assignment);
    } else {
      completeTerritoryAssignment(creep);
    }
    return;
  }
  if (assignment.action === "reserve" && !canCreepReserveTerritoryController(creep, controller, creep.memory.colony)) {
    return;
  }
  const result = assignment.action === "claim" ? executeControllerAction(creep, controller, "claimController") : executeControllerAction(creep, controller, "reserveController");
  if (result === ERR_NOT_IN_RANGE_CODE2 && typeof creep.moveTo === "function") {
    creep.moveTo(controller);
    return;
  }
  if (assignment.action === "claim" && CLAIM_FATAL_RESULT_CODES.has(result) || assignment.action === "reserve" && RESERVE_FATAL_RESULT_CODES.has(result)) {
    suppressTerritoryAssignment(creep, assignment);
  }
}
function suppressTerritoryAssignment(creep, assignment) {
  suppressTerritoryIntent(creep.memory.colony, assignment, getGameTime4());
  completeTerritoryAssignment(creep);
}
function completeTerritoryAssignment(creep) {
  delete creep.memory.territory;
}
function selectTargetController(creep, assignment) {
  var _a, _b;
  if (assignment.controllerId) {
    const game = globalThis.Game;
    const getObjectById = game == null ? void 0 : game.getObjectById;
    if (typeof getObjectById === "function") {
      const controller = getObjectById.call(game, assignment.controllerId);
      if (controller) {
        return controller;
      }
    }
  }
  return (_b = (_a = creep.room) == null ? void 0 : _a.controller) != null ? _b : null;
}
function executeControllerAction(creep, controller, action) {
  const controllerAction = creep[action];
  if (typeof controllerAction !== "function") {
    return OK_CODE2;
  }
  return controllerAction.call(creep, controller);
}
function moveTowardTargetRoom(creep, targetRoom) {
  const RoomPositionCtor = globalThis.RoomPosition;
  if (typeof RoomPositionCtor !== "function" || typeof creep.moveTo !== "function") {
    return;
  }
  creep.moveTo(new RoomPositionCtor(25, 25, targetRoom));
}
function getGameTime4() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function isTerritoryAssignment(assignment) {
  return typeof (assignment == null ? void 0 : assignment.targetRoom) === "string" && assignment.targetRoom.length > 0 && (assignment.action === "claim" || assignment.action === "reserve" || assignment.action === "scout");
}

// src/economy/economyLoop.ts
var ERR_BUSY_CODE = -4;
var OK_CODE3 = 0;
function runEconomy() {
  const creeps = Object.values(Game.creeps);
  const colonies = getOwnedColonies();
  const telemetryEvents = [];
  for (const colony of colonies) {
    const extensionResult = planExtensionConstruction(colony);
    if (extensionResult === null) {
      planEarlyRoadConstruction(colony);
    }
    let roleCounts = countCreepsByRole(creeps, colony.room.name);
    let availableEnergy = colony.energyAvailable;
    let successfulSpawnCount = 0;
    const usedSpawns = /* @__PURE__ */ new Set();
    while (true) {
      const planningColony = createSpawnPlanningColony(colony, availableEnergy, usedSpawns);
      const spawnRequest = planSpawn(
        planningColony,
        roleCounts,
        Game.time,
        getSpawnPlanningOptions(successfulSpawnCount)
      );
      if (!spawnRequest) {
        break;
      }
      if (successfulSpawnCount > 0 && spawnRequest.memory.role !== "worker") {
        break;
      }
      const outcome = attemptSpawnRequest(
        spawnRequest,
        colony.room.name,
        telemetryEvents,
        planningColony.spawns
      );
      if (!outcome || outcome.result !== OK_CODE3) {
        break;
      }
      usedSpawns.add(outcome.spawn);
      availableEnergy = Math.max(0, availableEnergy - getBodyCost(spawnRequest.body));
      successfulSpawnCount += 1;
      if (spawnRequest.memory.role !== "worker") {
        break;
      }
      roleCounts = addPlannedWorker(roleCounts);
    }
  }
  for (const creep of creeps) {
    if (creep.memory.role === "worker") {
      runWorker(creep);
    } else if (creep.memory.role === TERRITORY_CLAIMER_ROLE || creep.memory.role === TERRITORY_SCOUT_ROLE) {
      runTerritoryControllerCreep(creep);
    }
  }
  emitRuntimeSummary(colonies, creeps, telemetryEvents);
}
function createSpawnPlanningColony(colony, energyAvailable, usedSpawns) {
  return {
    ...colony,
    energyAvailable,
    spawns: colony.spawns.filter((spawn) => !spawn.spawning && !usedSpawns.has(spawn))
  };
}
function getSpawnPlanningOptions(successfulSpawnCount) {
  return successfulSpawnCount > 0 ? { nameSuffix: String(successfulSpawnCount + 1), workersOnly: true } : {};
}
function attemptSpawnRequest(spawnRequest, roomName, telemetryEvents, spawns) {
  let lastOutcome = null;
  for (const spawn of getSpawnAttemptOrder(spawnRequest, spawns)) {
    const result = attemptSpawn({ ...spawnRequest, spawn }, roomName, telemetryEvents);
    lastOutcome = { spawn, result };
    if (result !== ERR_BUSY_CODE) {
      return lastOutcome;
    }
  }
  return lastOutcome;
}
function addPlannedWorker(roleCounts) {
  const nextRoleCounts = {
    ...roleCounts,
    worker: roleCounts.worker + 1
  };
  const workerCapacity = getWorkerCapacity(roleCounts) + 1;
  if (workerCapacity === nextRoleCounts.worker) {
    delete nextRoleCounts.workerCapacity;
  } else {
    nextRoleCounts.workerCapacity = workerCapacity;
  }
  return nextRoleCounts;
}
function getSpawnAttemptOrder(spawnRequest, spawns) {
  return [spawnRequest.spawn, ...spawns.filter((spawn) => spawn !== spawnRequest.spawn && !spawn.spawning)];
}
function attemptSpawn(spawnRequest, roomName, telemetryEvents) {
  const result = spawnRequest.spawn.spawnCreep(spawnRequest.body, spawnRequest.name, {
    memory: spawnRequest.memory
  });
  telemetryEvents.push({
    type: "spawn",
    roomName,
    spawnName: spawnRequest.spawn.name,
    creepName: spawnRequest.name,
    role: spawnRequest.memory.role,
    result
  });
  return result;
}

// src/kernel/Kernel.ts
var Kernel = class {
  constructor(dependencies = {
    initializeMemory,
    cleanupDeadCreepMemory,
    runEconomy
  }) {
    this.dependencies = dependencies;
  }
  run() {
    this.dependencies.initializeMemory();
    this.dependencies.cleanupDeadCreepMemory();
    this.dependencies.runEconomy();
  }
};

// src/main.ts
var kernel = new Kernel();
function loop() {
  kernel.run();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  loop
});
