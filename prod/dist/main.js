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
  return creeps.reduce(
    (counts, creep) => {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      if (isColonyWorker(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts.worker += 1;
      }
      if (isColonyClaimer(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts.claimer = ((_a = counts.claimer) != null ? _a : 0) + 1;
        const targetRoom = (_b = creep.memory.territory) == null ? void 0 : _b.targetRoom;
        if (targetRoom) {
          const claimersByTargetRoom = (_c = counts.claimersByTargetRoom) != null ? _c : {};
          claimersByTargetRoom[targetRoom] = ((_d = claimersByTargetRoom[targetRoom]) != null ? _d : 0) + 1;
          counts.claimersByTargetRoom = claimersByTargetRoom;
        }
      }
      if (isColonyScout(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts.scout = ((_e = counts.scout) != null ? _e : 0) + 1;
        const targetRoom = (_f = creep.memory.territory) == null ? void 0 : _f.targetRoom;
        if (targetRoom) {
          const scoutsByTargetRoom = (_g = counts.scoutsByTargetRoom) != null ? _g : {};
          scoutsByTargetRoom[targetRoom] = ((_h = scoutsByTargetRoom[targetRoom]) != null ? _h : 0) + 1;
          counts.scoutsByTargetRoom = scoutsByTargetRoom;
        }
      }
      return counts;
    },
    { worker: 0, claimer: 0, claimersByTargetRoom: {} }
  );
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

// src/tasks/workerTasks.ts
var CONTROLLER_DOWNGRADE_GUARD_TICKS = 5e3;
var IDLE_RAMPART_REPAIR_HITS_CEILING = 1e5;
var MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
var MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 2;
function selectWorkerTask(creep) {
  const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  if (carriedEnergy === 0) {
    if (getFreeEnergyCapacity(creep) > 0) {
      const droppedEnergy = selectDroppedEnergy(creep);
      if (droppedEnergy) {
        return { type: "pickup", targetId: droppedEnergy.id };
      }
      const storedEnergy = selectStoredEnergySource(creep);
      if (storedEnergy) {
        return { type: "withdraw", targetId: storedEnergy.id };
      }
    }
    const source = selectHarvestSource(creep);
    return source ? { type: "harvest", targetId: source.id } : null;
  }
  const energySink = selectFillableEnergySink(creep);
  if (energySink) {
    return { type: "transfer", targetId: energySink.id };
  }
  const controller = creep.room.controller;
  if (controller && shouldGuardControllerDowngrade(controller)) {
    return { type: "upgrade", targetId: controller.id };
  }
  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const spawnConstructionSite = constructionSites.find(isSpawnConstructionSite);
  if (spawnConstructionSite) {
    return { type: "build", targetId: spawnConstructionSite.id };
  }
  if (controller && shouldRushRcl1Controller(controller)) {
    return { type: "upgrade", targetId: controller.id };
  }
  const extensionConstructionSite = constructionSites.find(isExtensionConstructionSite);
  if (extensionConstructionSite) {
    return { type: "build", targetId: extensionConstructionSite.id };
  }
  if (controller && shouldSustainControllerProgress(creep, controller)) {
    return { type: "upgrade", targetId: controller.id };
  }
  if (constructionSites[0]) {
    return { type: "build", targetId: constructionSites[0].id };
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
function isFillableEnergySink(structure) {
  return (matchesStructureType2(structure.structureType, "STRUCTURE_SPAWN", "spawn") || matchesStructureType2(structure.structureType, "STRUCTURE_EXTENSION", "extension")) && "store" in structure && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
}
function selectFillableEnergySink(creep) {
  const energySinks = creep.room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });
  if (energySinks.length === 0) {
    return null;
  }
  const closestEnergySink = findClosestByRange(creep, energySinks);
  return closestEnergySink != null ? closestEnergySink : energySinks[0];
}
function isSpawnConstructionSite(site) {
  return matchesStructureType2(site.structureType, "STRUCTURE_SPAWN", "spawn");
}
function isExtensionConstructionSite(site) {
  return matchesStructureType2(site.structureType, "STRUCTURE_EXTENSION", "extension");
}
function matchesStructureType2(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}
function selectStoredEnergySource(creep) {
  const context = {
    creepOwnerUsername: getCreepOwnerUsername(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const storedEnergySources = findVisibleRoomStructures(creep.room).filter(
    (structure) => isSafeStoredEnergySource(structure, context)
  );
  if (storedEnergySources.length === 0) {
    return null;
  }
  const closestStoredEnergy = findClosestByRange(creep, storedEnergySources);
  return closestStoredEnergy != null ? closestStoredEnergy : storedEnergySources[0];
}
function isSafeStoredEnergySource(structure, context) {
  return isStoredWorkerEnergySource(structure) && hasStoredEnergy(structure) && isFriendlyStoredEnergySource(structure, context);
}
function isStoredWorkerEnergySource(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_CONTAINER", "container") || matchesStructureType2(structure.structureType, "STRUCTURE_STORAGE", "storage") || matchesStructureType2(structure.structureType, "STRUCTURE_TERMINAL", "terminal");
}
function hasStoredEnergy(structure) {
  var _a;
  return ((_a = structure.store.getUsedCapacity(RESOURCE_ENERGY)) != null ? _a : 0) > 0;
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
function getCreepOwnerUsername(creep) {
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
  if (matchesStructureType2(structure.structureType, "STRUCTURE_ROAD", "road") || matchesStructureType2(structure.structureType, "STRUCTURE_CONTAINER", "container")) {
    return true;
  }
  return matchesStructureType2(structure.structureType, "STRUCTURE_RAMPART", "rampart") && isOwnedRampart(structure);
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
function shouldSustainControllerProgress(creep, controller) {
  if (controller.my !== true || controller.level < 2) {
    return false;
  }
  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  return loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS && !loadedWorkers.some((worker) => worker !== creep && isUpgradingController(worker, controller));
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
  var _a, _b, _c;
  return (_c = (_b = (_a = creep.store) == null ? void 0 : _a.getUsedCapacity) == null ? void 0 : _b.call(_a, RESOURCE_ENERGY)) != null ? _c : 0;
}
function getFreeEnergyCapacity(creep) {
  var _a, _b, _c;
  return (_c = (_b = (_a = creep.store) == null ? void 0 : _a.getFreeCapacity) == null ? void 0 : _b.call(_a, RESOURCE_ENERGY)) != null ? _c : 0;
}
function isUpgradingController(creep, controller) {
  var _a;
  const task = (_a = creep.memory) == null ? void 0 : _a.task;
  return (task == null ? void 0 : task.type) === "upgrade" && task.targetId === controller.id;
}
function selectDroppedEnergy(creep) {
  const droppedEnergy = findDroppedResources(creep.room).filter(isUsefulDroppedEnergy);
  if (droppedEnergy.length === 0) {
    return null;
  }
  const closestDroppedEnergy = findClosestByRange(creep, droppedEnergy);
  return closestDroppedEnergy != null ? closestDroppedEnergy : droppedEnergy[0];
}
function findDroppedResources(room) {
  if (typeof FIND_DROPPED_RESOURCES !== "number") {
    return [];
  }
  return room.find(FIND_DROPPED_RESOURCES);
}
function isUsefulDroppedEnergy(resource) {
  return resource.resourceType === RESOURCE_ENERGY && resource.amount >= MIN_DROPPED_ENERGY_PICKUP_AMOUNT;
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
    case "upgrade":
      return creep.upgradeController(target);
  }
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
var EXIT_DIRECTION_ORDER = ["1", "3", "5", "7"];
function planTerritoryIntent(colony, roleCounts, workerTarget, gameTime) {
  if (!isTerritoryHomeSafe(colony, roleCounts, workerTarget)) {
    return null;
  }
  const selection = selectTerritoryTarget(colony.room.name);
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
function shouldSpawnTerritoryControllerCreep(plan, roleCounts) {
  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action)) {
    return false;
  }
  if (plan.action === "scout" && isVisibleRoomKnown(plan.targetRoom)) {
    return false;
  }
  if (isVisibleTerritoryTargetUnavailable(plan.targetRoom, plan.controllerId)) {
    return false;
  }
  return getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) === 0;
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
  if (roleCounts.worker < workerTarget) {
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
function selectTerritoryTarget(colonyName) {
  const territoryMemory = getTerritoryMemoryRecord();
  const intents = normalizeTerritoryIntents(territoryMemory == null ? void 0 : territoryMemory.intents);
  const configuredTarget = selectConfiguredTerritoryTarget(colonyName, territoryMemory, intents);
  if (configuredTarget) {
    return { target: configuredTarget, intentAction: configuredTarget.action, commitTarget: false };
  }
  if (hasConfiguredTerritoryTargetForColony(territoryMemory, colonyName)) {
    return null;
  }
  return selectAdjacentReserveTarget(colonyName, territoryMemory, intents);
}
function selectConfiguredTerritoryTarget(colonyName, territoryMemory, intents) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return null;
  }
  for (const rawTarget of territoryMemory.targets) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (target && target.enabled !== false && target.colony === colonyName && target.roomName !== colonyName && !isTerritoryTargetSuppressed(target, intents) && !isVisibleTerritoryTargetUnavailable(target.roomName, target.controllerId)) {
      return target;
    }
  }
  return null;
}
function hasConfiguredTerritoryTargetForColony(territoryMemory, colonyName) {
  return getConfiguredTargetRoomsForColony(territoryMemory, colonyName).size > 0;
}
function selectAdjacentReserveTarget(colonyName, territoryMemory, intents) {
  const adjacentRooms = getAdjacentRoomNames(colonyName);
  if (adjacentRooms.length === 0) {
    return null;
  }
  const existingTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  for (const roomName of adjacentRooms) {
    const target = { colony: colonyName, roomName, action: "reserve" };
    if (roomName !== colonyName && !existingTargetRooms.has(roomName) && !isTerritoryTargetSuppressed(target, intents) && !isTerritoryIntentForActionSuppressed(colonyName, roomName, "scout")) {
      const candidateState = getAdjacentReserveCandidateState(roomName);
      if (candidateState === "safe") {
        return { target, intentAction: "reserve", commitTarget: true };
      }
      if (candidateState === "unknown") {
        return { target, intentAction: "scout", commitTarget: false };
      }
    }
  }
  return null;
}
function getAdjacentReserveCandidateState(targetRoom) {
  if (isVisibleRoomMissingController(targetRoom)) {
    return "unavailable";
  }
  const controller = getVisibleController(targetRoom);
  if (!controller) {
    return "unknown";
  }
  return !isControllerOwned(controller) && controller.reservation == null ? "safe" : "unavailable";
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
  var _a, _b, _c, _d;
  if (action === "scout") {
    return (_b = (_a = roleCounts.scoutsByTargetRoom) == null ? void 0 : _a[targetRoom]) != null ? _b : 0;
  }
  return (_d = (_c = roleCounts.claimersByTargetRoom) == null ? void 0 : _c[targetRoom]) != null ? _d : 0;
}
function isTerritoryTargetSuppressed(target, intents) {
  return intents.some(
    (intent) => intent.status === "suppressed" && intent.colony === target.colony && intent.targetRoom === target.roomName && intent.action === target.action
  );
}
function isTerritoryIntentSuppressed(colony, targetRoom, action) {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }
  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) => intent.status === "suppressed" && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isTerritoryIntentForActionSuppressed(colony, targetRoom, action) {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }
  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) => intent.status === "suppressed" && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isVisibleTerritoryTargetUnavailable(targetRoom, controllerId) {
  if (isVisibleRoomMissingController(targetRoom)) {
    return true;
  }
  const controller = getVisibleController(targetRoom, controllerId);
  if (!controller) {
    return false;
  }
  return isControllerOwned(controller);
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

// src/spawn/spawnPlanner.ts
var MIN_WORKER_TARGET = 3;
var WORKERS_PER_SOURCE = 2;
var TERRITORY_SCOUT_BODY = ["move"];
var TERRITORY_SCOUT_BODY_COST = 50;
var MAX_WORKER_TARGET = 6;
var sourceCountByRoomName = /* @__PURE__ */ new Map();
function planSpawn(colony, roleCounts, gameTime) {
  const workerTarget = getWorkerTarget(colony);
  if (roleCounts.worker < workerTarget) {
    return planWorkerSpawn(colony, roleCounts, gameTime);
  }
  const territoryIntent = planTerritoryIntent(colony, roleCounts, workerTarget, gameTime);
  if (!territoryIntent || !shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts)) {
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
    name: `${roleName}-${colony.room.name}-${territoryIntent.targetRoom}-${gameTime}`,
    memory: buildTerritoryCreepMemory(territoryIntent)
  };
}
function planWorkerSpawn(colony, roleCounts, gameTime) {
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
    name: `worker-${colony.room.name}-${gameTime}`,
    memory: { role: "worker", colony: colony.room.name }
  };
}
function selectWorkerBody(colony, roleCounts) {
  const normalBody = buildWorkerBody(colony.energyCapacityAvailable);
  if (canAffordBody(normalBody, colony.energyAvailable)) {
    return normalBody;
  }
  if (roleCounts.worker === 0) {
    return buildEmergencyWorkerBody(colony.energyAvailable);
  }
  return roleCounts.worker < MIN_WORKER_TARGET ? buildWorkerBody(colony.energyAvailable) : [];
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
function getWorkerTarget(colony) {
  const sourceCount = getSourceCount(colony.room);
  const sourceAwareTarget = sourceCount * WORKERS_PER_SOURCE;
  return Math.min(MAX_WORKER_TARGET, Math.max(MIN_WORKER_TARGET, sourceAwareTarget));
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
  const tick = getGameTime();
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
    const usedCapacity = getUsedCapacity.call(object.store, getEnergyResource());
    return typeof usedCapacity === "number" ? usedCapacity : 0;
  }
  const storedEnergy = object.store[getEnergyResource()];
  return typeof storedEnergy === "number" ? storedEnergy : 0;
}
function sumDroppedEnergy(droppedResources) {
  const energyResource = getEnergyResource();
  return droppedResources.reduce((total, droppedResource) => {
    if (!isRecord2(droppedResource) || droppedResource.resourceType !== energyResource) {
      return total;
    }
    return total + (typeof droppedResource.amount === "number" ? droppedResource.amount : 0);
  }, 0);
}
function isEnergyEventData(data) {
  return data.resourceType === void 0 || data.resourceType === getEnergyResource();
}
function getNumericEventData(data, key) {
  const value = data[key];
  return typeof value === "number" ? value : 0;
}
function getGlobalNumber(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getEnergyResource() {
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
function getGameTime() {
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
    }
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
  suppressTerritoryIntent(creep.memory.colony, assignment, getGameTime2());
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
function getGameTime2() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function isTerritoryAssignment(assignment) {
  return typeof (assignment == null ? void 0 : assignment.targetRoom) === "string" && assignment.targetRoom.length > 0 && (assignment.action === "claim" || assignment.action === "reserve" || assignment.action === "scout");
}

// src/economy/economyLoop.ts
var ERR_BUSY_CODE = -4;
function runEconomy() {
  const creeps = Object.values(Game.creeps);
  const colonies = getOwnedColonies();
  const telemetryEvents = [];
  for (const colony of colonies) {
    const extensionResult = planExtensionConstruction(colony);
    if (extensionResult === null) {
      planEarlyRoadConstruction(colony);
    }
    const roleCounts = countCreepsByRole(creeps, colony.room.name);
    const spawnRequest = planSpawn(colony, roleCounts, Game.time);
    if (spawnRequest) {
      for (const spawn of getSpawnAttemptOrder(spawnRequest, colony.spawns)) {
        const result = attemptSpawn({ ...spawnRequest, spawn }, colony.room.name, telemetryEvents);
        if (result !== ERR_BUSY_CODE) {
          break;
        }
      }
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
