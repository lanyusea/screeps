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
  return Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
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

// src/territory/territoryPlanner.ts
var TERRITORY_CLAIMER_ROLE = "claimer";
var TERRITORY_SCOUT_ROLE = "scout";
var TERRITORY_DOWNGRADE_GUARD_TICKS = 5e3;
var TERRITORY_RESERVATION_RENEWAL_TICKS = 1e3;
var TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS / 4;
var TERRITORY_RESERVATION_COMFORT_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS * 2;
var TERRITORY_SUPPRESSION_RETRY_TICKS = 1500;
var EXIT_DIRECTION_ORDER = ["1", "3", "5", "7"];
var MIN_CLAIM_PARTS_FOR_RESERVATION_PROGRESS = 2;
var ERR_NO_PATH_CODE = -2;
var TERRITORY_CANDIDATE_PRIORITY_URGENT_RENEWAL = 0;
var TERRITORY_CANDIDATE_PRIORITY_VISIBLE_CLAIM = 1;
var TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE = 2;
var TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_CLAIM = 3;
var TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_RESERVE = 4;
var TERRITORY_CANDIDATE_PRIORITY_SCOUT = 5;
var MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY = TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE;
var TERRITORY_ROUTE_DISTANCE_SEPARATOR = ">";
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
    ...target.controllerId ? { controllerId: target.controllerId } : {}
  };
  const status = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) > 0 ? "active" : "planned";
  recordTerritoryIntent(plan, status, gameTime, selection.commitTarget ? target : null);
  return plan;
}
function shouldSpawnTerritoryControllerCreep(plan, roleCounts, gameTime = getGameTime()) {
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
      ...plan.controllerId ? { controllerId: plan.controllerId } : {}
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
  if (!isNonEmptyString(actorUsername) || !isNonEmptyString(reservation.username) || reservation.username !== actorUsername || typeof reservation.ticksToEnd !== "number") {
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
  if (!isNonEmptyString(assignment.targetRoom)) {
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
  if (isNonEmptyString(colony) && isTerritoryIntentSuppressed(colony, assignment.targetRoom, assignment.action)) {
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
  if (assignment.action !== "claim" || !isNonEmptyString(assignment.targetRoom)) {
    return false;
  }
  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  return (controller == null ? void 0 : controller.my) === true;
}
function suppressTerritoryIntent(colony, assignment, gameTime) {
  if (!isNonEmptyString(colony) || !isNonEmptyString(assignment.targetRoom) || !isTerritoryIntentAction(assignment.action)) {
    return;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const suppressedIntent = {
    colony,
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: "suppressed",
    updatedAt: gameTime,
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {}
  };
  upsertTerritoryIntent(intents, suppressedIntent);
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
  var _a;
  const colonyName = colony.room.name;
  const colonyOwnerUsername = getControllerOwnerUsername(colony.room.controller);
  const territoryMemory = getTerritoryMemoryRecord();
  const intents = normalizeTerritoryIntents(territoryMemory == null ? void 0 : territoryMemory.intents);
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
  const configuredCandidates = getConfiguredTerritoryCandidates(
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    routeDistanceLookupContext
  );
  const bestSpawnableConfiguredCandidate = selectBestScoredTerritoryCandidate(
    getSpawnableTerritoryCandidates(configuredCandidates, roleCounts)
  );
  if (bestSpawnableConfiguredCandidate && bestSpawnableConfiguredCandidate.priority <= MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY) {
    return toSelectedTerritoryTarget(bestSpawnableConfiguredCandidate);
  }
  const adjacentCandidates = [
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
    ...getSatisfiedClaimAdjacentReserveCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      !hasBlockingConfiguredTarget,
      routeDistanceLookupContext
    )
  ];
  const candidates = [...configuredCandidates, ...adjacentCandidates];
  return toSelectedTerritoryTarget(
    (_a = selectBestScoredTerritoryCandidate(getSpawnableTerritoryCandidates(candidates, roleCounts))) != null ? _a : selectBestScoredTerritoryCandidate(candidates)
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
    commitTarget: candidate.commitTarget
  } : null;
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
    const target = normalizeTerritoryTarget(rawTarget);
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
function hasBlockingConfiguredTerritoryTargetForColony(territoryMemory, colonyName, colonyOwnerUsername, intents, gameTime, roleCounts, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return false;
  }
  return territoryMemory.targets.some((rawTarget) => {
    const target = normalizeTerritoryTarget(rawTarget);
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
  const adjacentRooms = getAdjacentRoomNames(originRoomName);
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
        { target, intentAction: "reserve", commitTarget: true },
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
        { target, intentAction: "scout", commitTarget: false },
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
      (order + 1) * EXIT_DIRECTION_ORDER.length,
      routeDistanceLookupContext
    )
  );
}
function getSatisfiedConfiguredClaimTargets(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }
  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.action !== "claim" || target.roomName === colonyName || isTerritoryTargetSuppressed(target, intents, gameTime) || hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext) || getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "satisfied") {
      return [];
    }
    return [{ target, order }];
  });
}
function scoreTerritoryCandidate(selection, source, order, colonyName, colonyOwnerUsername, routeDistanceLookupContext) {
  if (hasKnownNoRoute(colonyName, selection.target.roomName, routeDistanceLookupContext)) {
    return null;
  }
  const renewalTicksToEnd = getConfiguredReserveRenewalTicksToEnd(selection.target, colonyOwnerUsername);
  return {
    ...selection,
    source,
    order,
    priority: getTerritoryCandidatePriority(selection, renewalTicksToEnd),
    ...renewalTicksToEnd !== null ? { renewalTicksToEnd } : {}
  };
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
  return left.priority - right.priority || compareOptionalNumbers(left.renewalTicksToEnd, right.renewalTicksToEnd) || getTerritoryCandidateSourcePriority(left.source) - getTerritoryCandidateSourcePriority(right.source) || left.order - right.order || left.target.roomName.localeCompare(right.target.roomName) || left.intentAction.localeCompare(right.intentAction);
}
function compareOptionalNumbers(left, right) {
  return (left != null ? left : Number.POSITIVE_INFINITY) - (right != null ? right : Number.POSITIVE_INFINITY);
}
function getTerritoryCandidateSourcePriority(source) {
  if (source === "configured") {
    return 0;
  }
  return source === "satisfiedClaimAdjacent" ? 1 : 2;
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
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return void 0;
  }
  if (!isRecord(territoryMemory.routeDistances)) {
    territoryMemory.routeDistances = {};
  }
  return territoryMemory.routeDistances;
}
function getTerritoryRouteDistanceCacheKey(fromRoom, targetRoom) {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`;
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
      const target = normalizeTerritoryTarget(rawTarget);
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
function getAdjacentRoomNames(roomName) {
  const game = globalThis.Game;
  const gameMap = game == null ? void 0 : game.map;
  if (!gameMap || typeof gameMap.describeExits !== "function") {
    return [];
  }
  const exits = gameMap.describeExits(roomName);
  if (!isRecord(exits)) {
    return [];
  }
  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const exitRoom = exits[direction];
    return isNonEmptyString(exitRoom) ? [exitRoom] : [];
  });
}
function normalizeTerritoryTarget(rawTarget) {
  if (!isRecord(rawTarget)) {
    return null;
  }
  if (!isNonEmptyString(rawTarget.colony) || !isNonEmptyString(rawTarget.roomName) || !isTerritoryControlAction(rawTarget.action)) {
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
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }
  if (seededTarget) {
    appendTerritoryTarget(territoryMemory, seededTarget);
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const nextIntent = {
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    status,
    updatedAt: gameTime,
    ...plan.controllerId ? { controllerId: plan.controllerId } : {}
  };
  upsertTerritoryIntent(intents, nextIntent);
}
function normalizeTerritoryIntents(rawIntents) {
  return Array.isArray(rawIntents) ? rawIntents.flatMap((intent) => {
    const normalizedIntent = normalizeTerritoryIntent(intent);
    return normalizedIntent ? [normalizedIntent] : [];
  }) : [];
}
function upsertTerritoryIntent(intents, nextIntent) {
  const existingIndex = intents.findIndex(
    (intent) => intent.colony === nextIntent.colony && intent.targetRoom === nextIntent.targetRoom && intent.action === nextIntent.action
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }
  intents.push(nextIntent);
}
function normalizeTerritoryIntent(rawIntent) {
  if (!isRecord(rawIntent)) {
    return null;
  }
  if (!isNonEmptyString(rawIntent.colony) || !isNonEmptyString(rawIntent.targetRoom) || !isTerritoryIntentAction(rawIntent.action) || !isTerritoryIntentStatus(rawIntent.status) || typeof rawIntent.updatedAt !== "number") {
    return null;
  }
  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...typeof rawIntent.controllerId === "string" ? { controllerId: rawIntent.controllerId } : {}
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
    (intent) => isTerritorySuppressionFresh(intent, gameTime) && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isTerritoryIntentSuppressed(colony, targetRoom, action, gameTime = getGameTime()) {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }
  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) => isTerritorySuppressionFresh(intent, gameTime) && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isTerritorySuppressionFresh(intent, gameTime) {
  return intent.status === "suppressed" && gameTime - intent.updatedAt <= TERRITORY_SUPPRESSION_RETRY_TICKS;
}
function selectVisibleTerritoryControllerIntent(creep) {
  var _a, _b, _c;
  const roomName = (_a = creep.room) == null ? void 0 : _a.name;
  if (!isNonEmptyString(roomName) || isVisibleRoomUnsafe(creep.room)) {
    return null;
  }
  const assignmentIntent = normalizeCreepTerritoryIntent(creep, roomName);
  if (assignmentIntent && isCreepVisibleTerritoryIntentActionable(creep, assignmentIntent)) {
    return assignmentIntent;
  }
  const territoryMemory = getTerritoryMemoryRecord();
  const colony = (_b = creep.memory) == null ? void 0 : _b.colony;
  const intents = normalizeTerritoryIntents(territoryMemory == null ? void 0 : territoryMemory.intents).filter((intent) => isActiveVisibleControllerIntentForCreep(intent, roomName, colony)).sort(compareVisibleControllerIntents);
  return (_c = intents.find((intent) => isCreepVisibleTerritoryIntentActionable(creep, intent))) != null ? _c : null;
}
function normalizeCreepTerritoryIntent(creep, roomName) {
  var _a, _b, _c, _d;
  const assignment = (_a = creep.memory) == null ? void 0 : _a.territory;
  if (!assignment || assignment.targetRoom !== roomName || !isTerritoryControlAction(assignment.action) || isNonEmptyString((_b = creep.memory) == null ? void 0 : _b.colony) && isTerritoryIntentSuppressed(creep.memory.colony, assignment.targetRoom, assignment.action)) {
    return null;
  }
  return {
    colony: (_d = (_c = creep.memory) == null ? void 0 : _c.colony) != null ? _d : "",
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: "active",
    updatedAt: getGameTime(),
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {}
  };
}
function isActiveVisibleControllerIntentForCreep(intent, roomName, creepColony) {
  return intent.targetRoom === roomName && intent.targetRoom !== intent.colony && isTerritoryControlAction(intent.action) && (intent.status === "planned" || intent.status === "active") && (!isNonEmptyString(creepColony) || intent.colony === creepColony);
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
  if (isControllerOwnedByColony(controller, colonyOwnerUsername)) {
    return "satisfied";
  }
  return isControllerOwned(controller) ? "unavailable" : "available";
}
function getTerritoryActorUsername(creep, colony) {
  var _a;
  return (_a = getCreepOwnerUsername(creep)) != null ? _a : isNonEmptyString(colony) ? getVisibleColonyOwnerUsername(colony) : null;
}
function getCreepOwnerUsername(creep) {
  var _a;
  const username = (_a = creep == null ? void 0 : creep.owner) == null ? void 0 : _a.username;
  return isNonEmptyString(username) ? username : null;
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
function isControllerOwnedByColony(controller, colonyOwnerUsername) {
  const ownerUsername = getControllerOwnerUsername(controller);
  return controller.my === true || isNonEmptyString(ownerUsername) && ownerUsername === colonyOwnerUsername;
}
function getReserveControllerTargetState(controller, colonyOwnerUsername) {
  if (isControllerOwned(controller)) {
    return "unavailable";
  }
  const reservation = controller.reservation;
  if (!reservation) {
    return "available";
  }
  if (!isNonEmptyString(reservation.username) || reservation.username !== colonyOwnerUsername) {
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
  if (isControllerOwned(controller) || !isNonEmptyString(colonyOwnerUsername)) {
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
  return getControllerOwnerUsername(controller != null ? controller : void 0);
}
function getControllerOwnerUsername(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return isNonEmptyString(username) ? username : null;
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
function getGameTime() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function getWritableTerritoryMemoryRecord() {
  const memory = getMemoryRecord();
  if (!memory) {
    return null;
  }
  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }
  return memory.territory;
}
function getTerritoryMemoryRecord() {
  const memory = getMemoryRecord();
  if (!memory || !isRecord(memory.territory)) {
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
function isTerritoryIntentAction(action) {
  return isTerritoryControlAction(action) || action === "scout";
}
function isTerritoryIntentStatus(status) {
  return status === "planned" || status === "active" || status === "suppressed";
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isRecord(value) {
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
  const energySink = selectFillableEnergySink(creep);
  if (energySink && !isTowerEnergySink(energySink)) {
    return { type: "transfer", targetId: energySink.id };
  }
  const controller = creep.room.controller;
  if (controller && shouldGuardControllerDowngrade(controller)) {
    return { type: "upgrade", targetId: controller.id };
  }
  if (energySink) {
    return { type: "transfer", targetId: energySink.id };
  }
  if (territoryControllerTask) {
    return territoryControllerTask;
  }
  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const spawnConstructionSite = selectConstructionSite(creep, constructionSites, isSpawnConstructionSite);
  if (spawnConstructionSite) {
    return { type: "build", targetId: spawnConstructionSite.id };
  }
  if (controller && shouldRushRcl1Controller(controller)) {
    return { type: "upgrade", targetId: controller.id };
  }
  const extensionConstructionSite = selectConstructionSite(creep, constructionSites, isExtensionConstructionSite);
  if (extensionConstructionSite) {
    return { type: "build", targetId: extensionConstructionSite.id };
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
  const energySinks = creep.room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });
  const spawn = selectClosestEnergySink(creep, energySinks.filter(isSpawnEnergySink));
  if (spawn) {
    return spawn;
  }
  const extension = selectClosestEnergySink(creep, energySinks.filter(isExtensionEnergySink));
  if (extension) {
    return extension;
  }
  return selectClosestEnergySink(creep, energySinks.filter(isPriorityTowerEnergySink));
}
function isSpawnEnergySink(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_SPAWN", "spawn");
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
function selectClosestEnergySink(creep, energySinks) {
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
  const candidates = findWorkerEnergyAcquisitionCandidates(creep).map((candidate) => createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink)).filter((candidate) => candidate !== null).filter((candidate) => harvestEta === null || candidate.deliveryEta < harvestEta);
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
  );
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
function compareWorkerEnergyAcquisitionCandidates(left, right) {
  return right.score - left.score || compareOptionalRanges(left.range, right.range) || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
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

// src/creeps/workerRunner.ts
function runWorker(creep) {
  if (!creep.memory.task) {
    assignNextTask(creep);
    return;
  }
  if (shouldReplaceTask(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  if (shouldPreemptForVisibleTerritoryControllerTask(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  if (shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  if (shouldPreemptSpendingTaskForEnergySink(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  if (shouldPreemptSpendingTaskForControllerPressure(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  if (shouldPreemptUpgradeTask(creep, creep.memory.task)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  const task = creep.memory.task;
  const target = Game.getObjectById(task.targetId);
  if (!target) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
  }
  if (shouldReplaceTarget(task, target)) {
    delete creep.memory.task;
    assignNextTask(creep);
    return;
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
function shouldPreemptForVisibleTerritoryControllerTask(creep, task) {
  const controllerTask = selectVisibleTerritoryControllerTask(creep);
  if (!controllerTask) {
    return isTerritoryControlTask2(task);
  }
  const selectedTask = selectWorkerTask(creep);
  if (!selectedTask || !isSameTask(selectedTask, controllerTask)) {
    return false;
  }
  return !isSameTask(task, controllerTask);
}
function shouldPreemptSpendingTaskForEnergySink(creep, task) {
  if (!isEnergySpendingTask(task)) {
    return false;
  }
  if (!creep.room) {
    return false;
  }
  const nextTask = selectWorkerTask(creep);
  return (nextTask == null ? void 0 : nextTask.type) === "transfer" && !isSameTask(task, nextTask);
}
function shouldPreemptEnergyAcquisitionTaskForSpawnRecovery(creep, task) {
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
  const nextTask = selectWorkerTask(creep);
  return isRecoverableEnergyTask(nextTask) && !isSameTask(task, nextTask);
}
function shouldPreemptSpendingTaskForControllerPressure(creep, task) {
  var _a;
  if (!isEnergySpendingTask(task) || task.type === "upgrade") {
    return false;
  }
  if (typeof ((_a = creep.room) == null ? void 0 : _a.find) !== "function") {
    return false;
  }
  const nextTask = selectWorkerTask(creep);
  return isOwnedControllerUpgradeTask(creep, nextTask) && !isSameTask(task, nextTask);
}
function shouldPreemptUpgradeTask(creep, task) {
  var _a;
  if (task.type !== "upgrade") {
    return false;
  }
  const controller = (_a = creep.room) == null ? void 0 : _a.controller;
  if ((controller == null ? void 0 : controller.my) !== true) {
    return false;
  }
  const nextTask = selectWorkerTask(creep);
  if (nextTask === null || nextTask.type === task.type && nextTask.targetId === task.targetId) {
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
  return task.type === "claim" || task.type === "reserve";
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
      return creep.upgradeController(target);
  }
}

// src/spawn/spawnPlanner.ts
var MIN_WORKER_TARGET = 3;
var WORKERS_PER_SOURCE = 2;
var CONSTRUCTION_BACKLOG_WORKER_BONUS = 1;
var TERRITORY_SCOUT_BODY = ["move"];
var TERRITORY_SCOUT_BODY_COST = 50;
var MAX_WORKER_TARGET = 6;
var sourceCountByRoomName = /* @__PURE__ */ new Map();
function planSpawn(colony, roleCounts, gameTime, options = {}) {
  const workerTarget = getWorkerTarget(colony, roleCounts);
  if (getWorkerCapacity(roleCounts) < workerTarget) {
    return planWorkerSpawn(colony, roleCounts, gameTime, options);
  }
  if (options.workersOnly) {
    return null;
  }
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
  if (!shouldAddConstructionBacklogWorkerBonus(colony, roleCounts, baseTarget)) {
    return baseTarget;
  }
  return Math.min(MAX_WORKER_TARGET, baseTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS);
}
function shouldAddConstructionBacklogWorkerBonus(colony, roleCounts, baseWorkerTarget) {
  return getWorkerCapacity(roleCounts) >= baseWorkerTarget && isConstructionBonusHomeSafe(colony.room.controller) && hasActiveConstructionBacklog(colony.room);
}
function isConstructionBonusHomeSafe(controller) {
  return (controller == null ? void 0 : controller.my) === true && (typeof controller.ticksToDowngrade !== "number" || controller.ticksToDowngrade > TERRITORY_DOWNGRADE_GUARD_TICKS);
}
function hasActiveConstructionBacklog(room) {
  if (typeof room.find !== "function" || typeof FIND_MY_CONSTRUCTION_SITES !== "number") {
    return false;
  }
  return room.find(FIND_MY_CONSTRUCTION_SITES).length > 0;
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

// src/telemetry/runtimeSummary.ts
var RUNTIME_SUMMARY_PREFIX = "#runtime-summary ";
var RUNTIME_SUMMARY_INTERVAL = 20;
var MAX_REPORTED_EVENTS = 10;
var WORKER_TASK_TYPES = ["harvest", "transfer", "build", "upgrade"];
function emitRuntimeSummary(colonies, creeps, events = []) {
  if (colonies.length === 0 && events.length === 0) {
    return;
  }
  const tick = getGameTime2();
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
  return {
    roomName: colony.room.name,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnStatus: colony.spawns.map(summarizeSpawn),
    taskCounts: countWorkerTasks(colonyWorkers),
    ...buildControllerSummary(colony.room),
    resources: summarizeResources(colony, colonyWorkers, eventMetrics.resources),
    combat: summarizeCombat(colony.room, eventMetrics.combat)
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
  const roomStructures = (_a = findRoomObjects(colony.room, "FIND_STRUCTURES")) != null ? _a : colony.spawns;
  const droppedResources = (_b = findRoomObjects(colony.room, "FIND_DROPPED_RESOURCES")) != null ? _b : [];
  const sources = (_c = findRoomObjects(colony.room, "FIND_SOURCES")) != null ? _c : [];
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
  const hostileCreeps = (_a = findRoomObjects(room, "FIND_HOSTILE_CREEPS")) != null ? _a : [];
  const hostileStructures = (_b = findRoomObjects(room, "FIND_HOSTILE_STRUCTURES")) != null ? _b : [];
  return {
    hostileCreepCount: hostileCreeps.length,
    hostileStructureCount: hostileStructures.length,
    ...events ? { events } : {}
  };
}
function summarizeRoomEventMetrics(room) {
  const eventLog = getRoomEventLog(room);
  if (!eventLog) {
    return {};
  }
  const harvestEvent = getGlobalNumber("EVENT_HARVEST");
  const transferEvent = getGlobalNumber("EVENT_TRANSFER");
  const attackEvent = getGlobalNumber("EVENT_ATTACK");
  const objectDestroyedEvent = getGlobalNumber("EVENT_OBJECT_DESTROYED");
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
    if (!isRecord2(entry) || typeof entry.event !== "number") {
      continue;
    }
    const data = isRecord2(entry.data) ? entry.data : {};
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
  if (!isRecord2(object) || !isRecord2(object.store)) {
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
    if (!isRecord2(droppedResource) || droppedResource.resourceType !== energyResource) {
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
function getGlobalNumber(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getEnergyResource2() {
  const value = globalThis.RESOURCE_ENERGY;
  return typeof value === "string" ? value : "energy";
}
function isRecord2(value) {
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
function getGameTime2() {
  return typeof Game.time === "number" ? Game.time : 0;
}

// src/territory/territoryRunner.ts
var ERR_NOT_IN_RANGE_CODE = -9;
var ERR_INVALID_TARGET_CODE = -7;
var ERR_GCL_NOT_ENOUGH_CODE = -15;
var OK_CODE = 0;
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
  if (result === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === "function") {
    creep.moveTo(controller);
    return;
  }
  if (assignment.action === "claim" && CLAIM_FATAL_RESULT_CODES.has(result) || assignment.action === "reserve" && RESERVE_FATAL_RESULT_CODES.has(result)) {
    suppressTerritoryAssignment(creep, assignment);
  }
}
function suppressTerritoryAssignment(creep, assignment) {
  suppressTerritoryIntent(creep.memory.colony, assignment, getGameTime3());
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
    return OK_CODE;
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
function getGameTime3() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function isTerritoryAssignment(assignment) {
  return typeof (assignment == null ? void 0 : assignment.targetRoom) === "string" && assignment.targetRoom.length > 0 && (assignment.action === "claim" || assignment.action === "reserve" || assignment.action === "scout");
}

// src/economy/economyLoop.ts
var ERR_BUSY_CODE = -4;
var OK_CODE2 = 0;
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
      if (!outcome || outcome.result !== OK_CODE2) {
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
