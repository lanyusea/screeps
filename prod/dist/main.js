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
  DEFAULT_STRATEGY_REGISTRY: () => DEFAULT_STRATEGY_REGISTRY,
  DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG: () => DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG,
  DEFAULT_VARIANCE_CONFIG: () => DEFAULT_VARIANCE_CONFIG,
  HistoricalReplayValidator: () => HistoricalReplayValidator,
  RlRolloutGate: () => RlRolloutGate,
  STRATEGY_REGISTRY_SCHEMA_VERSION: () => STRATEGY_REGISTRY_SCHEMA_VERSION,
  evaluateStrategyShadowReplay: () => evaluateStrategyShadowReplay,
  injectStrategyVariance: () => injectStrategyVariance,
  loadHistoricalReplays: () => loadHistoricalReplays,
  loop: () => loop,
  validateRlStrategyRollout: () => validateRlStrategyRollout,
  validateStrategyRegistry: () => validateStrategyRegistry,
  validateStrategyRegistryEntry: () => validateStrategyRegistryEntry
});
module.exports = __toCommonJS(main_exports);

// src/strategy/kpiEvaluator.ts
var STRATEGY_RUNTIME_SUMMARY_PREFIX = "#runtime-summary ";
var DEFAULT_STRATEGY_RELIABILITY_THRESHOLDS = {
  minArtifactCount: 1,
  maxLoopExceptionCount: 0,
  maxTelemetrySilenceTicks: 0,
  controllerDowngradeRiskTicks: 5e3,
  maxControllerDowngradeRiskRooms: 0,
  maxSpawnCollapseRooms: 0
};
function parseStrategyEvaluationArtifacts(input) {
  if (typeof input !== "string") {
    const rawArtifacts = Array.isArray(input) ? input : [input];
    return rawArtifacts.flatMap((rawArtifact) => {
      const artifact = normalizeStrategyEvaluationArtifact(rawArtifact);
      return artifact ? [artifact] : [];
    });
  }
  const trimmedInput = input.trim();
  if (trimmedInput.length === 0) {
    return [];
  }
  const wholeJson = parseJson(trimmedInput);
  if (wholeJson !== null) {
    return parseStrategyEvaluationArtifacts(wholeJson);
  }
  return trimmedInput.split(/\r?\n/).flatMap((line) => {
    const parsedLine = parseArtifactLine(line);
    const artifact = parsedLine === null ? null : normalizeStrategyEvaluationArtifact(parsedLine);
    return artifact ? [artifact] : [];
  });
}
function normalizeStrategyEvaluationArtifact(rawArtifact) {
  if (!isRecord(rawArtifact)) {
    return null;
  }
  if (rawArtifact.type === "runtime-summary" || Array.isArray(rawArtifact.rooms)) {
    return normalizeRuntimeSummaryArtifact(rawArtifact);
  }
  if (rawArtifact.artifactType === "runtime-summary") {
    return normalizeRuntimeSummaryArtifact(rawArtifact);
  }
  if (rawArtifact.artifactType === "room-snapshot" || Array.isArray(rawArtifact.objects) || isRecord(rawArtifact.objects)) {
    return normalizeRoomSnapshotArtifact(rawArtifact);
  }
  return null;
}
function reduceStrategyKpis(artifacts, thresholds = DEFAULT_STRATEGY_RELIABILITY_THRESHOLDS) {
  const reliabilityMetrics = buildInitialReliabilityMetrics(artifacts);
  const territoryComponents = {
    ownedRooms: 0,
    reservedOrRemoteRooms: 0,
    roomGain: 0,
    controllerLevels: 0,
    controllerProgress: 0,
    territoryRecommendation: 0
  };
  const resourceComponents = {
    storedEnergy: 0,
    workerCarriedEnergy: 0,
    droppedEnergy: 0,
    harvestedEnergy: 0,
    transferredEnergy: 0,
    visibleSources: 0
  };
  const killComponents = {
    creepKills: 0,
    objectKills: 0,
    attackDamage: 0,
    hostilePressureObserved: 0
  };
  let firstOwnedRoomCount;
  let lastOwnedRoomCount = 0;
  for (const artifact of artifacts) {
    if (artifact.artifactType === "runtime-summary") {
      const ownedRoomCount = reduceRuntimeSummaryArtifact(
        artifact,
        reliabilityMetrics,
        territoryComponents,
        resourceComponents,
        killComponents,
        thresholds
      );
      if (firstOwnedRoomCount === void 0) {
        firstOwnedRoomCount = ownedRoomCount;
      }
      lastOwnedRoomCount = ownedRoomCount;
    } else {
      const ownedRoomCount = reduceRoomSnapshotArtifact(
        artifact,
        territoryComponents,
        resourceComponents,
        killComponents
      );
      if (firstOwnedRoomCount === void 0) {
        firstOwnedRoomCount = ownedRoomCount;
      }
      lastOwnedRoomCount = ownedRoomCount;
    }
  }
  territoryComponents.roomGain = lastOwnedRoomCount - (firstOwnedRoomCount != null ? firstOwnedRoomCount : lastOwnedRoomCount);
  return {
    reliability: evaluateReliabilityFloor(reliabilityMetrics, thresholds),
    territory: {
      score: territoryComponents.ownedRooms * 1e4 + territoryComponents.reservedOrRemoteRooms * 3e3 + territoryComponents.roomGain * 5e3 + territoryComponents.controllerLevels * 800 + territoryComponents.controllerProgress / 100 + territoryComponents.territoryRecommendation,
      components: territoryComponents
    },
    resources: {
      score: resourceComponents.storedEnergy + resourceComponents.workerCarriedEnergy + resourceComponents.droppedEnergy / 2 + resourceComponents.harvestedEnergy * 3 + resourceComponents.transferredEnergy + resourceComponents.visibleSources * 500,
      components: resourceComponents
    },
    kills: {
      score: killComponents.creepKills * 1e3 + killComponents.objectKills * 250 + killComponents.attackDamage + killComponents.hostilePressureObserved * 25,
      components: killComponents
    }
  };
}
function normalizeRuntimeSummaryArtifact(rawArtifact) {
  const rooms = Array.isArray(rawArtifact.rooms) ? rawArtifact.rooms.flatMap((rawRoom) => {
    const room = normalizeRuntimeSummaryRoom(rawRoom);
    return room ? [room] : [];
  }) : [];
  return {
    artifactType: "runtime-summary",
    ...isFiniteNumber(rawArtifact.tick) ? { tick: rawArtifact.tick } : {},
    rooms,
    ...isRecord(rawArtifact.cpu) ? { cpu: normalizeCpuSummary(rawArtifact.cpu) } : {},
    ...isRecord(rawArtifact.reliability) ? { reliability: normalizeReliabilitySignals(rawArtifact.reliability) } : {}
  };
}
function normalizeRuntimeSummaryRoom(rawRoom) {
  if (!isRecord(rawRoom) || !isNonEmptyString(rawRoom.roomName)) {
    return null;
  }
  return {
    roomName: rawRoom.roomName,
    ...isFiniteNumber(rawRoom.energyAvailable) ? { energyAvailable: rawRoom.energyAvailable } : {},
    ...isFiniteNumber(rawRoom.energyCapacity) ? { energyCapacity: rawRoom.energyCapacity } : {},
    ...isFiniteNumber(rawRoom.workerCount) ? { workerCount: rawRoom.workerCount } : {},
    ...Array.isArray(rawRoom.spawnStatus) ? { spawnStatus: rawRoom.spawnStatus.map(normalizeSpawnStatus) } : {},
    ...isRecord(rawRoom.controller) ? { controller: normalizeControllerSummary(rawRoom.controller) } : {},
    ...isRecord(rawRoom.resources) ? { resources: normalizeResourceSummary(rawRoom.resources) } : {},
    ...isRecord(rawRoom.combat) ? { combat: normalizeCombatSummary(rawRoom.combat) } : {},
    ...isRecord(rawRoom.constructionPriority) ? { constructionPriority: normalizeConstructionPrioritySummary(rawRoom.constructionPriority) } : {},
    ...isRecord(rawRoom.territoryRecommendation) ? { territoryRecommendation: normalizeTerritoryRecommendationSummary(rawRoom.territoryRecommendation) } : {}
  };
}
function normalizeRoomSnapshotArtifact(rawArtifact) {
  if (!Array.isArray(rawArtifact.objects) && !isRecord(rawArtifact.objects)) {
    return null;
  }
  const objects = Array.isArray(rawArtifact.objects) ? rawArtifact.objects.flatMap((rawObject) => isRecord(rawObject) ? [rawObject] : []) : Object.entries(rawArtifact.objects).flatMap(([id, rawObject]) => {
    if (!isRecord(rawObject)) {
      return [];
    }
    return [{ ...rawObject, id }];
  });
  return {
    artifactType: "room-snapshot",
    ...isFiniteNumber(rawArtifact.tick) ? { tick: rawArtifact.tick } : {},
    ...isNonEmptyString(rawArtifact.roomName) ? { roomName: rawArtifact.roomName } : {},
    ...isNonEmptyString(rawArtifact.room) ? { roomName: rawArtifact.room } : {},
    ...isNonEmptyString(rawArtifact.owner) ? { owner: rawArtifact.owner } : {},
    objects
  };
}
function parseArtifactLine(line) {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return null;
  }
  const jsonText = trimmedLine.startsWith(STRATEGY_RUNTIME_SUMMARY_PREFIX) ? trimmedLine.slice(STRATEGY_RUNTIME_SUMMARY_PREFIX.length) : trimmedLine;
  return parseJson(jsonText);
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function normalizeSpawnStatus(rawStatus) {
  if (!isRecord(rawStatus)) {
    return {};
  }
  return {
    ...isNonEmptyString(rawStatus.name) ? { name: rawStatus.name } : {},
    ...isNonEmptyString(rawStatus.status) ? { status: rawStatus.status } : {},
    ...isNonEmptyString(rawStatus.creepName) ? { creepName: rawStatus.creepName } : {},
    ...isFiniteNumber(rawStatus.remainingTime) ? { remainingTime: rawStatus.remainingTime } : {}
  };
}
function normalizeControllerSummary(rawController) {
  return {
    level: isFiniteNumber(rawController.level) ? rawController.level : 0,
    ...isFiniteNumber(rawController.progress) ? { progress: rawController.progress } : {},
    ...isFiniteNumber(rawController.progressTotal) ? { progressTotal: rawController.progressTotal } : {},
    ...isFiniteNumber(rawController.ticksToDowngrade) ? { ticksToDowngrade: rawController.ticksToDowngrade } : {}
  };
}
function normalizeResourceSummary(rawResources) {
  return {
    ...isFiniteNumber(rawResources.storedEnergy) ? { storedEnergy: rawResources.storedEnergy } : {},
    ...isFiniteNumber(rawResources.workerCarriedEnergy) ? { workerCarriedEnergy: rawResources.workerCarriedEnergy } : {},
    ...isFiniteNumber(rawResources.droppedEnergy) ? { droppedEnergy: rawResources.droppedEnergy } : {},
    ...isFiniteNumber(rawResources.sourceCount) ? { sourceCount: rawResources.sourceCount } : {},
    ...isRecord(rawResources.events) ? { events: normalizeResourceEvents(rawResources.events) } : {}
  };
}
function normalizeResourceEvents(rawEvents) {
  return {
    ...isFiniteNumber(rawEvents.harvestedEnergy) ? { harvestedEnergy: rawEvents.harvestedEnergy } : {},
    ...isFiniteNumber(rawEvents.transferredEnergy) ? { transferredEnergy: rawEvents.transferredEnergy } : {}
  };
}
function normalizeCombatSummary(rawCombat) {
  return {
    ...isFiniteNumber(rawCombat.hostileCreepCount) ? { hostileCreepCount: rawCombat.hostileCreepCount } : {},
    ...isFiniteNumber(rawCombat.hostileStructureCount) ? { hostileStructureCount: rawCombat.hostileStructureCount } : {},
    ...isRecord(rawCombat.events) ? { events: normalizeCombatEvents(rawCombat.events) } : {}
  };
}
function normalizeCombatEvents(rawEvents) {
  return {
    ...isFiniteNumber(rawEvents.attackCount) ? { attackCount: rawEvents.attackCount } : {},
    ...isFiniteNumber(rawEvents.attackDamage) ? { attackDamage: rawEvents.attackDamage } : {},
    ...isFiniteNumber(rawEvents.objectDestroyedCount) ? { objectDestroyedCount: rawEvents.objectDestroyedCount } : {},
    ...isFiniteNumber(rawEvents.creepDestroyedCount) ? { creepDestroyedCount: rawEvents.creepDestroyedCount } : {}
  };
}
function normalizeConstructionPrioritySummary(rawSummary) {
  var _a;
  return {
    ...Array.isArray(rawSummary.candidates) ? { candidates: rawSummary.candidates.flatMap(normalizeConstructionCandidate) } : {},
    ...rawSummary.nextPrimary === null ? { nextPrimary: null } : isRecord(rawSummary.nextPrimary) ? { nextPrimary: (_a = normalizeConstructionCandidate(rawSummary.nextPrimary)[0]) != null ? _a : null } : {}
  };
}
function normalizeConstructionCandidate(rawCandidate) {
  if (!isRecord(rawCandidate) || !isNonEmptyString(rawCandidate.buildItem)) {
    return [];
  }
  return [
    {
      buildItem: rawCandidate.buildItem,
      ...isNonEmptyString(rawCandidate.room) ? { room: rawCandidate.room } : {},
      ...isFiniteNumber(rawCandidate.score) ? { score: rawCandidate.score } : {},
      ...isNonEmptyString(rawCandidate.urgency) ? { urgency: rawCandidate.urgency } : {},
      ...Array.isArray(rawCandidate.preconditions) ? { preconditions: rawCandidate.preconditions.filter(isNonEmptyString) } : {},
      ...Array.isArray(rawCandidate.expectedKpiMovement) ? { expectedKpiMovement: rawCandidate.expectedKpiMovement.filter(isNonEmptyString) } : {},
      ...Array.isArray(rawCandidate.risk) ? { risk: rawCandidate.risk.filter(isNonEmptyString) } : {}
    }
  ];
}
function normalizeTerritoryRecommendationSummary(rawSummary) {
  var _a;
  return {
    ...Array.isArray(rawSummary.candidates) ? { candidates: rawSummary.candidates.flatMap(normalizeTerritoryCandidate) } : {},
    ...rawSummary.next === null ? { next: null } : isRecord(rawSummary.next) ? { next: (_a = normalizeTerritoryCandidate(rawSummary.next)[0]) != null ? _a : null } : {},
    ...rawSummary.followUpIntent !== void 0 ? { followUpIntent: rawSummary.followUpIntent } : {}
  };
}
function normalizeTerritoryCandidate(rawCandidate) {
  if (!isRecord(rawCandidate) || !isNonEmptyString(rawCandidate.roomName)) {
    return [];
  }
  return [
    {
      roomName: rawCandidate.roomName,
      ...isNonEmptyString(rawCandidate.action) ? { action: rawCandidate.action } : {},
      ...isFiniteNumber(rawCandidate.score) ? { score: rawCandidate.score } : {},
      ...isNonEmptyString(rawCandidate.evidenceStatus) ? { evidenceStatus: rawCandidate.evidenceStatus } : {},
      ...isNonEmptyString(rawCandidate.source) ? { source: rawCandidate.source } : {},
      ...Array.isArray(rawCandidate.evidence) ? { evidence: rawCandidate.evidence.filter(isNonEmptyString) } : {},
      ...Array.isArray(rawCandidate.preconditions) ? { preconditions: rawCandidate.preconditions.filter(isNonEmptyString) } : {},
      ...Array.isArray(rawCandidate.risks) ? { risks: rawCandidate.risks.filter(isNonEmptyString) } : {},
      ...isFiniteNumber(rawCandidate.routeDistance) ? { routeDistance: rawCandidate.routeDistance } : {},
      ...isFiniteNumber(rawCandidate.roadDistance) ? { roadDistance: rawCandidate.roadDistance } : {},
      ...isFiniteNumber(rawCandidate.sourceCount) ? { sourceCount: rawCandidate.sourceCount } : {},
      ...isFiniteNumber(rawCandidate.hostileCreepCount) ? { hostileCreepCount: rawCandidate.hostileCreepCount } : {},
      ...isFiniteNumber(rawCandidate.hostileStructureCount) ? { hostileStructureCount: rawCandidate.hostileStructureCount } : {}
    }
  ];
}
function normalizeCpuSummary(rawCpu) {
  return {
    ...isFiniteNumber(rawCpu.used) ? { used: rawCpu.used } : {},
    ...isFiniteNumber(rawCpu.bucket) ? { bucket: rawCpu.bucket } : {}
  };
}
function normalizeReliabilitySignals(rawReliability) {
  return {
    ...isFiniteNumber(rawReliability.loopExceptionCount) ? { loopExceptionCount: rawReliability.loopExceptionCount } : {},
    ...isFiniteNumber(rawReliability.telemetrySilenceTicks) ? { telemetrySilenceTicks: rawReliability.telemetrySilenceTicks } : {},
    ...isFiniteNumber(rawReliability.globalResetCount) ? { globalResetCount: rawReliability.globalResetCount } : {}
  };
}
function reduceRuntimeSummaryArtifact(artifact, reliabilityMetrics, territoryComponents, resourceComponents, killComponents, thresholds) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A, _B, _C, _D, _E, _F, _G, _H, _I, _J, _K, _L, _M, _N;
  reliabilityMetrics.loopExceptionCount += (_b = (_a = artifact.reliability) == null ? void 0 : _a.loopExceptionCount) != null ? _b : 0;
  reliabilityMetrics.telemetrySilenceTicks += (_d = (_c = artifact.reliability) == null ? void 0 : _c.telemetrySilenceTicks) != null ? _d : 0;
  reliabilityMetrics.globalResetCount += (_f = (_e = artifact.reliability) == null ? void 0 : _e.globalResetCount) != null ? _f : 0;
  if (typeof ((_g = artifact.cpu) == null ? void 0 : _g.bucket) === "number") {
    reliabilityMetrics.minCpuBucket = reliabilityMetrics.minCpuBucket === void 0 ? artifact.cpu.bucket : Math.min(reliabilityMetrics.minCpuBucket, artifact.cpu.bucket);
  }
  let ownedRoomCount = 0;
  for (const room of artifact.rooms) {
    if (room.controller) {
      ownedRoomCount += 1;
      territoryComponents.controllerLevels += room.controller.level;
      territoryComponents.controllerProgress += (_h = room.controller.progress) != null ? _h : 0;
      if (typeof room.controller.ticksToDowngrade === "number" && room.controller.ticksToDowngrade <= thresholds.controllerDowngradeRiskTicks) {
        reliabilityMetrics.controllerDowngradeRiskRooms += 1;
      }
    }
    if (((_i = room.workerCount) != null ? _i : 1) <= 0 && ((_k = (_j = room.spawnStatus) == null ? void 0 : _j.length) != null ? _k : 0) <= 0) {
      reliabilityMetrics.spawnCollapseRooms += 1;
    }
    resourceComponents.storedEnergy += (_m = (_l = room.resources) == null ? void 0 : _l.storedEnergy) != null ? _m : 0;
    resourceComponents.workerCarriedEnergy += (_o = (_n = room.resources) == null ? void 0 : _n.workerCarriedEnergy) != null ? _o : 0;
    resourceComponents.droppedEnergy += (_q = (_p = room.resources) == null ? void 0 : _p.droppedEnergy) != null ? _q : 0;
    resourceComponents.visibleSources += (_s = (_r = room.resources) == null ? void 0 : _r.sourceCount) != null ? _s : 0;
    resourceComponents.harvestedEnergy += (_v = (_u = (_t = room.resources) == null ? void 0 : _t.events) == null ? void 0 : _u.harvestedEnergy) != null ? _v : 0;
    resourceComponents.transferredEnergy += (_y = (_x = (_w = room.resources) == null ? void 0 : _w.events) == null ? void 0 : _x.transferredEnergy) != null ? _y : 0;
    killComponents.creepKills += (_B = (_A = (_z = room.combat) == null ? void 0 : _z.events) == null ? void 0 : _A.creepDestroyedCount) != null ? _B : 0;
    killComponents.objectKills += (_E = (_D = (_C = room.combat) == null ? void 0 : _C.events) == null ? void 0 : _D.objectDestroyedCount) != null ? _E : 0;
    killComponents.attackDamage += (_H = (_G = (_F = room.combat) == null ? void 0 : _F.events) == null ? void 0 : _G.attackDamage) != null ? _H : 0;
    killComponents.hostilePressureObserved += ((_J = (_I = room.combat) == null ? void 0 : _I.hostileCreepCount) != null ? _J : 0) + ((_L = (_K = room.combat) == null ? void 0 : _K.hostileStructureCount) != null ? _L : 0);
    const territoryCandidates = (_N = (_M = room.territoryRecommendation) == null ? void 0 : _M.candidates) != null ? _N : [];
    territoryComponents.reservedOrRemoteRooms += territoryCandidates.filter(
      (candidate) => candidate.action === "occupy" || candidate.action === "reserve"
    ).length;
    territoryComponents.territoryRecommendation += Math.max(
      0,
      ...territoryCandidates.map((candidate) => {
        var _a2;
        return (_a2 = candidate.score) != null ? _a2 : 0;
      })
    );
  }
  territoryComponents.ownedRooms = Math.max(territoryComponents.ownedRooms, ownedRoomCount);
  return ownedRoomCount;
}
function reduceRoomSnapshotArtifact(artifact, territoryComponents, resourceComponents, killComponents) {
  var _a, _b, _c;
  const controller = artifact.objects.find((object) => object.type === "controller");
  const snapshotOwner = (_a = artifact.owner) != null ? _a : getSnapshotObjectOwner(controller);
  const ownedController = controller && isOwnedSnapshotObject(controller, snapshotOwner);
  const ownedRoomCount = ownedController ? 1 : 0;
  if (ownedController) {
    territoryComponents.ownedRooms = Math.max(territoryComponents.ownedRooms, 1);
    territoryComponents.controllerLevels += (_b = controller.level) != null ? _b : 0;
  }
  for (const object of artifact.objects) {
    if (object.type === "source") {
      resourceComponents.visibleSources += 1;
    }
    if (object.type === "resource" && (object.resourceType === void 0 || object.resourceType === "energy")) {
      resourceComponents.droppedEnergy += (_c = object.amount) != null ? _c : 0;
    }
    resourceComponents.storedEnergy += getSnapshotObjectEnergy(object);
    if (object.type === "creep" && !isOwnedSnapshotObject(object, snapshotOwner)) {
      killComponents.hostilePressureObserved += 1;
    }
  }
  return ownedRoomCount;
}
function evaluateReliabilityFloor(metrics, thresholds) {
  var _a, _b;
  const reasons = [];
  if (metrics.artifactCount < thresholds.minArtifactCount) {
    reasons.push(`artifact count ${metrics.artifactCount} below floor ${thresholds.minArtifactCount}`);
  }
  if (metrics.loopExceptionCount > thresholds.maxLoopExceptionCount) {
    reasons.push(`loop exceptions ${metrics.loopExceptionCount} exceed ${thresholds.maxLoopExceptionCount}`);
  }
  if (metrics.telemetrySilenceTicks > thresholds.maxTelemetrySilenceTicks) {
    reasons.push(`telemetry silence ${metrics.telemetrySilenceTicks} ticks exceeds ${thresholds.maxTelemetrySilenceTicks}`);
  }
  if (thresholds.minCpuBucket !== void 0 && ((_a = metrics.minCpuBucket) != null ? _a : thresholds.minCpuBucket) < thresholds.minCpuBucket) {
    reasons.push(`minimum CPU bucket ${(_b = metrics.minCpuBucket) != null ? _b : "unknown"} below ${thresholds.minCpuBucket}`);
  }
  if (metrics.controllerDowngradeRiskRooms > thresholds.maxControllerDowngradeRiskRooms) {
    reasons.push(
      `controller downgrade risk rooms ${metrics.controllerDowngradeRiskRooms} exceed ${thresholds.maxControllerDowngradeRiskRooms}`
    );
  }
  if (metrics.spawnCollapseRooms > thresholds.maxSpawnCollapseRooms) {
    reasons.push(`spawn collapse rooms ${metrics.spawnCollapseRooms} exceed ${thresholds.maxSpawnCollapseRooms}`);
  }
  return {
    passed: reasons.length === 0,
    reasons,
    metrics
  };
}
function buildInitialReliabilityMetrics(artifacts) {
  return {
    artifactCount: artifacts.length,
    runtimeSummaryCount: artifacts.filter((artifact) => artifact.artifactType === "runtime-summary").length,
    roomSnapshotCount: artifacts.filter((artifact) => artifact.artifactType === "room-snapshot").length,
    loopExceptionCount: 0,
    telemetrySilenceTicks: 0,
    globalResetCount: 0,
    controllerDowngradeRiskRooms: 0,
    spawnCollapseRooms: 0
  };
}
function getSnapshotObjectEnergy(object) {
  var _a;
  if (typeof object.energy === "number") {
    return object.energy;
  }
  const storeEnergy = (_a = object.store) == null ? void 0 : _a.energy;
  return typeof storeEnergy === "number" ? storeEnergy : 0;
}
function getSnapshotObjectOwner(object) {
  var _a;
  const objectUser = object == null ? void 0 : object.user;
  if (isNonEmptyString(objectUser)) {
    return objectUser;
  }
  const ownerUsername = (_a = object == null ? void 0 : object.owner) == null ? void 0 : _a.username;
  return isNonEmptyString(ownerUsername) ? ownerUsername : void 0;
}
function isOwnedSnapshotObject(object, owner) {
  var _a;
  if (object.my === true) {
    return true;
  }
  if (!owner) {
    return false;
  }
  return object.user === owner || ((_a = object.owner) == null ? void 0 : _a.username) === owner;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// src/rl/kpiRolloutMonitor.ts
var DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG = {
  reliabilityDropThreshold: 0.1,
  territoryDropThreshold: 0.05,
  minWindowSize: 20
};
var KPI_PRIORITY_ORDER = [
  { metric: "reliability", getThreshold: (config) => config.reliabilityDropThreshold },
  { metric: "territory", getThreshold: (config) => config.territoryDropThreshold },
  { metric: "resources", getThreshold: () => Number.POSITIVE_INFINITY },
  { metric: "kills", getThreshold: () => Number.POSITIVE_INFINITY }
];
var KPI_METRIC_DEFAULTS = {
  reliability: 0,
  territory: 0,
  resources: 0,
  kills: 0
};
function checkKpiRegression(recentKpiWindows2, baselineKpiWindows2, config = {}) {
  var _a, _b;
  const normalizedConfig = {
    ...DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG,
    ...config
  };
  const regressedFamilies = [];
  const metrics = {};
  const details = [];
  const minWindowSize = Math.max(1, Math.floor(normalizedConfig.minWindowSize));
  for (const family of Object.keys({ ...baselineKpiWindows2, ...recentKpiWindows2 })) {
    const recentWindows = (_a = recentKpiWindows2[family]) != null ? _a : [];
    const baselineWindows = (_b = baselineKpiWindows2[family]) != null ? _b : [];
    if (recentWindows.length < minWindowSize || baselineWindows.length < minWindowSize) {
      continue;
    }
    const currentAverage = averageKpiWindowMetrics(recentWindows);
    const baselineAverage = averageKpiWindowMetrics(baselineWindows);
    if (!currentAverage || !baselineAverage) {
      continue;
    }
    const regression = detectRegressionForFamily(family, currentAverage, baselineAverage, normalizedConfig);
    if (!regression) {
      continue;
    }
    regressedFamilies.push(family);
    metrics[family] = {
      current: regression.current,
      baseline: regression.baseline,
      delta: regression.current - regression.baseline
    };
    details.push(
      `${family}:${regression.metric} dropped ${(regression.dropRatio * 100).toFixed(1)}% from ${regression.baseline.toFixed(2)} to ${regression.current.toFixed(2)} (threshold ${(regression.threshold * 100).toFixed(1)}%)`
    );
  }
  return {
    regression: regressedFamilies.length > 0,
    regressedFamilies,
    details: details.join(" | "),
    metrics
  };
}
function detectRegressionForFamily(family, current, baseline, config) {
  for (const { metric, getThreshold } of KPI_PRIORITY_ORDER) {
    const currentValue = current[metric];
    const baselineValue = baseline[metric];
    if (!isFiniteNumber2(currentValue) || !isFiniteNumber2(baselineValue)) {
      continue;
    }
    const threshold = getThreshold(config);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      continue;
    }
    const dropRatio = baselineValue <= 0 ? 0 : (baselineValue - currentValue) / baselineValue;
    if (dropRatio >= threshold) {
      return {
        family,
        metric,
        current: currentValue,
        baseline: baselineValue,
        dropRatio,
        threshold
      };
    }
  }
  return null;
}
function averageKpiWindowMetrics(windows) {
  if (!windows.length) {
    return null;
  }
  const totals = { ...KPI_METRIC_DEFAULTS };
  let count = 0;
  for (const window of windows) {
    if (!isFiniteNumber2(window.metrics.reliability) || !isFiniteNumber2(window.metrics.territory) || !isFiniteNumber2(window.metrics.resources) || !isFiniteNumber2(window.metrics.kills)) {
      continue;
    }
    totals.reliability += window.metrics.reliability;
    totals.territory += window.metrics.territory;
    totals.resources += window.metrics.resources;
    totals.kills += window.metrics.kills;
    count += 1;
  }
  if (!count) {
    return null;
  }
  return {
    reliability: totals.reliability / count,
    territory: totals.territory / count,
    resources: totals.resources / count,
    kills: totals.kills / count
  };
}
function isFiniteNumber2(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// src/rl/strategyRollback.ts
var ROLLBACK_HISTORY_LIMIT = 20;
var pendingRollbacksByFamily = /* @__PURE__ */ new Map();
function executeRollback(family, registry, reason) {
  const now = getGameTime();
  const candidate = findCandidateStrategyByFamily(registry, family);
  if (!candidate) {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: "",
      rollbackToId: "",
      reason
    };
  }
  const rollbackToId = candidate.rollback.rollbackToStrategyId;
  const rollbackTarget = rollbackToId ? getStrategyById(registry, rollbackToId) : void 0;
  if (!rollbackToId || !rollbackTarget || candidate.rolloutStatus !== "shadow" || rollbackTarget.rolloutStatus === "shadow") {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: "",
      rollbackToId: rollbackToId != null ? rollbackToId : "",
      reason
    };
  }
  if (candidate.family !== rollbackTarget.family || candidate.family !== family) {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: "",
      rollbackToId,
      reason
    };
  }
  if (candidate.id === rollbackToId) {
    clearPendingRollbackState(family);
    return {
      executed: false,
      disabledId: candidate.id,
      rollbackToId,
      reason
    };
  }
  const previousState = pendingRollbacksByFamily.get(family);
  const shouldRollback = previousState !== void 0 && previousState.lastSeenTick === now - 1 && previousState.disabledId === candidate.id && previousState.rollbackToId === rollbackToId;
  const currentState = {
    lastSeenTick: now,
    shouldRollback,
    disabledId: candidate.id,
    rollbackToId
  };
  pendingRollbacksByFamily.set(family, currentState);
  const memoryState = {
    disabledId: candidate.id,
    rollbackToId,
    timestamp: now,
    reason
  };
  const memory = getOrCreateMemory();
  const pendingRollbacks = getOrCreateMemoryRollbackMap(memory);
  pendingRollbacks[family] = memoryState;
  return {
    executed: shouldRollback,
    disabledId: candidate.id,
    rollbackToId,
    reason
  };
}
function applyPendingRollbacks(registry) {
  const now = getGameTime();
  const pendingRollbacks = getOrCreateMemoryRollbackMap(getOrCreateMemory());
  const entriesById = indexRegistryById(registry);
  let updated = false;
  let updatedRegistry = null;
  for (const [family, memoryState] of Object.entries(pendingRollbacks)) {
    const state = pendingRollbacksByFamily.get(family);
    if (!state) {
      if (memoryState.timestamp < now - 1) {
        delete pendingRollbacks[family];
      }
      continue;
    }
    if (state.lastSeenTick < now - 1) {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }
    if (!state.shouldRollback) {
      continue;
    }
    if (state.disabledId !== memoryState.disabledId || state.rollbackToId !== memoryState.rollbackToId) {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }
    const disabledStrategy = entriesById[state.disabledId];
    const rollbackStrategy = entriesById[state.rollbackToId];
    if (!disabledStrategy || !rollbackStrategy || disabledStrategy.family !== rollbackStrategy.family || rollbackStrategy.rolloutStatus === "shadow") {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }
    updatedRegistry = updatedRegistry != null ? updatedRegistry : cloneRegistry(registry);
    const updatedEntry = indexRegistryById(updatedRegistry);
    const disabledUpdated = updatedEntry[state.disabledId];
    const rollbackUpdated = updatedEntry[state.rollbackToId];
    if (!disabledUpdated || !rollbackUpdated) {
      delete pendingRollbacks[family];
      pendingRollbacksByFamily.delete(family);
      continue;
    }
    disabledUpdated.rolloutStatus = "disabled";
    rollbackUpdated.rolloutStatus = "incumbent";
    appendRollbackHistory({
      family,
      disabledId: state.disabledId,
      rollbackToId: state.rollbackToId,
      timestamp: now,
      reason: memoryState.reason
    });
    delete pendingRollbacks[family];
    pendingRollbacksByFamily.delete(family);
    updated = true;
  }
  return updated ? updatedRegistry != null ? updatedRegistry : registry : registry;
}
function appendRollbackHistory(historyEntry) {
  var _a;
  const memory = getOrCreateMemory();
  const history = (_a = memory.strategyRollbackHistory) != null ? _a : [];
  memory.strategyRollbackHistory = history;
  history.push(historyEntry);
  if (history.length > ROLLBACK_HISTORY_LIMIT) {
    history.splice(0, history.length - ROLLBACK_HISTORY_LIMIT);
  }
}
function clearPendingRollbackState(family) {
  pendingRollbacksByFamily.delete(family);
  const memory = getOrCreateMemory();
  if (!memory.strategyRollback) {
    return;
  }
  delete memory.strategyRollback[family];
}
function cloneRegistry(registry) {
  return registry.map((entry) => ({ ...entry }));
}
function getOrCreateMemory() {
  if (!globalThis.Memory) {
    globalThis.Memory = {};
  }
  return globalThis.Memory;
}
function getOrCreateMemoryRollbackMap(memory) {
  if (!memory.strategyRollback) {
    memory.strategyRollback = {};
  }
  return memory.strategyRollback;
}
function indexRegistryById(registry) {
  const result = {};
  for (const entry of registry) {
    result[entry.id] = entry;
  }
  return result;
}
function findCandidateStrategyByFamily(registry, family) {
  return registry.find((entry) => entry.family === family && entry.rolloutStatus === "shadow");
}
function getStrategyById(registry, strategyId) {
  return registry.find((entry) => entry.id === strategyId);
}
function getGameTime() {
  var _a;
  const game = globalThis.Game;
  return (_a = game == null ? void 0 : game.time) != null ? _a : 0;
}

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
    memory: room.memory,
    spawns: Object.values(Game.spawns).filter((spawn) => spawn.room.name === room.name),
    energyAvailable: room.energyAvailable,
    energyCapacityAvailable: room.energyCapacityAvailable
  }));
}

// src/defense/deadZone.ts
var DEAD_ZONE_MEMORY_TTL = 250;
var ERR_NO_PATH_CODE = -2;
function refreshVisibleDeadZoneMemory(gameTime = getGameTime2()) {
  var _a;
  clearExpiredDeadZoneRooms(gameTime);
  const rooms = (_a = globalThis.Game) == null ? void 0 : _a.rooms;
  if (!rooms) {
    return;
  }
  for (const room of Object.values(rooms)) {
    refreshVisibleRoomDeadZoneMemory(room, gameTime);
  }
}
function refreshVisibleRoomDeadZoneMemory(room, gameTime = getGameTime2()) {
  var _a;
  const assessment = assessVisibleRoomDeadZone(room);
  if (!assessment.unsafe || !assessment.reason) {
    clearKnownDeadZoneRoom(room.name);
    return false;
  }
  const defenseMemory = getWritableDefenseMemory();
  if (!defenseMemory) {
    return true;
  }
  const unsafeRooms = (_a = defenseMemory.unsafeRooms) != null ? _a : {};
  unsafeRooms[room.name] = {
    roomName: room.name,
    unsafe: true,
    reason: assessment.reason,
    updatedAt: gameTime,
    hostileCreepCount: assessment.hostileCreepCount,
    hostileStructureCount: assessment.hostileStructureCount,
    hostileTowerCount: assessment.hostileTowerCount
  };
  defenseMemory.unsafeRooms = unsafeRooms;
  return true;
}
function isKnownDeadZoneRoom(roomName) {
  var _a, _b;
  const visibleRoom = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[roomName];
  if (visibleRoom) {
    return assessVisibleRoomDeadZone(visibleRoom).unsafe;
  }
  return readKnownDeadZoneRoom(roomName, false) !== null;
}
function getKnownDeadZoneRoom(roomName) {
  return readKnownDeadZoneRoom(roomName, true);
}
function readKnownDeadZoneRoom(roomName, clearExpired) {
  var _a, _b, _c;
  const roomMemory = (_c = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.defense) == null ? void 0 : _b.unsafeRooms) == null ? void 0 : _c[roomName];
  if (!isDefenseUnsafeRoomMemory(roomMemory)) {
    return null;
  }
  if (isDeadZoneMemoryExpired(roomMemory)) {
    if (clearExpired) {
      clearKnownDeadZoneRoom(roomName);
    }
    return null;
  }
  return roomMemory;
}
function clearKnownDeadZoneRoom(roomName) {
  var _a;
  const defenseMemory = (_a = globalThis.Memory) == null ? void 0 : _a.defense;
  const unsafeRooms = defenseMemory == null ? void 0 : defenseMemory.unsafeRooms;
  if (!unsafeRooms || unsafeRooms[roomName] === void 0) {
    return;
  }
  delete unsafeRooms[roomName];
  if (Object.keys(unsafeRooms).length === 0) {
    delete defenseMemory.unsafeRooms;
  }
}
function hasSafeRouteAvoidingDeadZones(fromRoom, targetRoom) {
  if (fromRoom === targetRoom) {
    return true;
  }
  const gameMap = getGameMapWithFindRoute();
  if (!gameMap) {
    return null;
  }
  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName) => isKnownDeadZoneRoom(roomName) ? Infinity : 1
  });
  if (route === getNoPathResultCode()) {
    return false;
  }
  return Array.isArray(route) ? true : null;
}
function isRouteBlockedByKnownDeadZone(fromRoom, targetRoom) {
  if (fromRoom === targetRoom || !hasAnyKnownDeadZoneRoom()) {
    return false;
  }
  const gameMap = getGameMapWithFindRoute();
  if (!gameMap) {
    return false;
  }
  let touchedDeadZone = false;
  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName) => {
      const deadZone = isKnownDeadZoneRoom(roomName);
      touchedDeadZone || (touchedDeadZone = deadZone);
      return deadZone ? Infinity : 1;
    }
  });
  return touchedDeadZone && route === getNoPathResultCode();
}
function assessVisibleRoomDeadZone(room) {
  const hostileCreeps = findRoomObjects(room, "FIND_HOSTILE_CREEPS");
  const hostileStructures = findRoomObjects(room, "FIND_HOSTILE_STRUCTURES");
  const hostileTowerCount = hostileStructures.filter(isTowerStructure).length;
  const hostileStructureCount = hostileStructures.length;
  const hostileCreepCount = hostileCreeps.length;
  if (hostileTowerCount > 0) {
    return {
      unsafe: true,
      reason: "enemyTower",
      hostileCreepCount,
      hostileStructureCount,
      hostileTowerCount
    };
  }
  if (hostileCreepCount > 0 || hostileStructureCount > 0) {
    return {
      unsafe: true,
      reason: "hostilePresence",
      hostileCreepCount,
      hostileStructureCount,
      hostileTowerCount
    };
  }
  return {
    unsafe: false,
    hostileCreepCount,
    hostileStructureCount,
    hostileTowerCount
  };
}
function findRoomObjects(room, constantName) {
  const findConstant = globalThis[constantName];
  const find = room.find;
  if (typeof findConstant !== "number" || typeof find !== "function") {
    return [];
  }
  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
function isTowerStructure(structure) {
  var _a;
  const towerType = (_a = globalThis.STRUCTURE_TOWER) != null ? _a : "tower";
  return structure.structureType === towerType;
}
function hasAnyKnownDeadZoneRoom() {
  var _a, _b, _c;
  const unsafeRooms = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.defense) == null ? void 0 : _b.unsafeRooms;
  if (unsafeRooms && Object.keys(unsafeRooms).some((roomName) => readKnownDeadZoneRoom(roomName, false) !== null)) {
    return true;
  }
  const visibleRooms = (_c = globalThis.Game) == null ? void 0 : _c.rooms;
  return visibleRooms ? Object.values(visibleRooms).some((room) => assessVisibleRoomDeadZone(room).unsafe) : false;
}
function isDefenseUnsafeRoomMemory(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value;
  return typeof candidate.roomName === "string" && candidate.unsafe === true && (candidate.reason === "enemyTower" || candidate.reason === "hostilePresence") && typeof candidate.updatedAt === "number";
}
function isDeadZoneMemoryExpired(roomMemory, gameTime = getGameTime2()) {
  return gameTime >= roomMemory.updatedAt && gameTime - roomMemory.updatedAt > DEAD_ZONE_MEMORY_TTL;
}
function clearExpiredDeadZoneRooms(gameTime) {
  var _a, _b;
  const unsafeRooms = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.defense) == null ? void 0 : _b.unsafeRooms;
  if (!unsafeRooms) {
    return;
  }
  for (const [roomName, roomMemory] of Object.entries(unsafeRooms)) {
    if (isDefenseUnsafeRoomMemory(roomMemory) && isDeadZoneMemoryExpired(roomMemory, gameTime)) {
      clearKnownDeadZoneRoom(roomName);
    }
  }
}
function getWritableDefenseMemory() {
  var _a;
  const memory = globalThis.Memory;
  if (!memory) {
    return null;
  }
  const defenseMemory = (_a = memory.defense) != null ? _a : {};
  memory.defense = defenseMemory;
  return defenseMemory;
}
function getGameMapWithFindRoute() {
  var _a;
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  return typeof (gameMap == null ? void 0 : gameMap.findRoute) === "function" ? gameMap : null;
}
function getNoPathResultCode() {
  const noPathCode = globalThis.ERR_NO_PATH;
  return typeof noPathCode === "number" ? noPathCode : ERR_NO_PATH_CODE;
}
function getGameTime2() {
  var _a, _b;
  return typeof ((_a = globalThis.Game) == null ? void 0 : _a.time) === "number" ? (_b = globalThis.Game.time) != null ? _b : 0 : 0;
}

// src/defense/defenseLoop.ts
var DEFENDER_ROLE = "defender";
var MAX_RECORDED_DEFENSE_ACTIONS = 20;
var CRITICAL_STRUCTURE_DAMAGE_RATIO = 0.85;
var SAFE_MODE_CRITICAL_DAMAGE_RATIO = 0.75;
var EARLY_ROOM_SAFE_MODE_RCL = 3;
var OK_CODE = 0;
var ERR_NOT_IN_RANGE_CODE = -9;
function runDefense() {
  const telemetryEvents = [];
  refreshVisibleDeadZoneMemory();
  const colonies = getOwnedColonies();
  for (const colony of colonies) {
    runColonyDefense(createDefenseContext(colony), telemetryEvents);
  }
  runDefenders(Object.values(Game.creeps), telemetryEvents);
  return telemetryEvents;
}
function runColonyDefense(context, telemetryEvents) {
  const towerDefenseResult = runTowerDefense(context, telemetryEvents);
  const safeModeActivated = activateSafeModeWhenNeeded(
    context,
    towerDefenseResult.attackSucceeded,
    telemetryEvents
  );
  if (safeModeActivated) {
    return;
  }
  if (runTowerRecovery(context, telemetryEvents, towerDefenseResult.attackingTowerIds)) {
    return;
  }
  if (towerDefenseResult.attackSucceeded) {
    return;
  }
  recordWorkerFallbackIfNeeded(context, telemetryEvents);
}
function runTowerDefense(context, telemetryEvents) {
  const defenseResult = {
    attackSucceeded: false,
    attackingTowerIds: /* @__PURE__ */ new Set()
  };
  if (context.hostileCreeps.length === 0 && context.hostileStructures.length === 0) {
    return defenseResult;
  }
  for (const tower of getUsableTowers(context.towers)) {
    if (typeof tower.attack !== "function") {
      continue;
    }
    const target = selectTowerAttackTarget(tower, context);
    if (!target) {
      continue;
    }
    const attackResult = tower.attack(target);
    recordDefenseAction(
      {
        action: "towerAttack",
        context,
        reason: "hostileVisible",
        result: attackResult,
        structureId: getObjectId(tower),
        targetId: getObjectId(target)
      },
      telemetryEvents
    );
    if (attackResult === OK_CODE) {
      defenseResult.attackSucceeded = true;
      defenseResult.attackingTowerIds.add(getObjectId(tower));
    }
  }
  return defenseResult;
}
function activateSafeModeWhenNeeded(context, towerAttackSucceeded, telemetryEvents) {
  var _a, _b;
  if (!shouldActivateSafeMode(context, towerAttackSucceeded)) {
    return false;
  }
  const result = (_b = (_a = context.colony.room.controller) == null ? void 0 : _a.activateSafeMode) == null ? void 0 : _b.call(_a);
  if (typeof result !== "number") {
    return false;
  }
  recordDefenseAction(
    {
      action: "safeMode",
      context,
      reason: "safeModeEarlyRoomThreat",
      result,
      targetId: getObjectId(context.colony.room.controller)
    },
    telemetryEvents
  );
  return result === OK_CODE;
}
function runTowerRecovery(context, telemetryEvents, attackingTowerIds) {
  let acted = false;
  for (const tower of getUsableTowers(context.towers)) {
    if (attackingTowerIds.has(getObjectId(tower))) {
      continue;
    }
    const woundedCreep = selectWoundedFriendlyCreep(context.colony.room, tower);
    if (woundedCreep && typeof tower.heal === "function") {
      const result = tower.heal(woundedCreep);
      recordDefenseAction(
        {
          action: "towerHeal",
          context,
          reason: "criticalStructureDamaged",
          result,
          structureId: getObjectId(tower),
          targetId: getObjectId(woundedCreep)
        },
        telemetryEvents
      );
      acted = true;
      continue;
    }
    const repairTarget = selectClosestTarget(tower, context.damagedCriticalStructures);
    if (repairTarget && typeof tower.repair === "function") {
      const result = tower.repair(repairTarget);
      recordDefenseAction(
        {
          action: "towerRepair",
          context,
          reason: "criticalStructureDamaged",
          result,
          structureId: getObjectId(tower),
          targetId: getObjectId(repairTarget)
        },
        telemetryEvents
      );
      acted = true;
    }
  }
  return acted;
}
function recordWorkerFallbackIfNeeded(context, telemetryEvents) {
  if (!hasDefensePressure(context) || !hasColonyWorker(context.colony.room.name)) {
    return;
  }
  recordDefenseAction(
    {
      action: "workerFallback",
      context,
      reason: "workerEmergencyFallback"
    },
    telemetryEvents
  );
}
function runDefenders(creeps, telemetryEvents) {
  for (const creep of creeps) {
    if (creep.memory.role !== DEFENDER_ROLE) {
      continue;
    }
    runDefender(creep, telemetryEvents);
  }
}
function runDefender(creep, telemetryEvents) {
  var _a, _b;
  const colonyName = (_b = creep.memory.colony) != null ? _b : (_a = creep.memory.defense) == null ? void 0 : _a.homeRoom;
  if (!colonyName) {
    return;
  }
  const target = selectDefenderTarget(creep);
  if (target && typeof creep.attack === "function") {
    const attackResult = creep.attack(target);
    if (attackResult === ERR_NOT_IN_RANGE_CODE) {
      if (shouldSuppressDefenderMove(creep, target)) {
        return;
      }
      if (typeof creep.moveTo === "function") {
        const moveResult = creep.moveTo(target);
        recordDefenderAction(creep, "defenderMove", target, moveResult, telemetryEvents);
        return;
      }
    }
    recordDefenderAction(creep, "defenderAttack", target, attackResult, telemetryEvents);
  }
}
function shouldSuppressDefenderMove(creep, target) {
  var _a;
  const targetRoom = (_a = target.pos) == null ? void 0 : _a.roomName;
  if (!targetRoom || targetRoom === creep.room.name || !isKnownDeadZoneRoom(targetRoom)) {
    return false;
  }
  return hasSafeRouteAvoidingDeadZones(creep.room.name, targetRoom) === false;
}
function recordDefenderAction(creep, action, target, result, telemetryEvents) {
  const roomName = creep.room.name;
  const context = createDefenseContext({
    room: creep.room,
    spawns: Object.values(Game.spawns).filter((spawn) => spawn.room.name === roomName),
    energyAvailable: creep.room.energyAvailable,
    energyCapacityAvailable: creep.room.energyCapacityAvailable
  });
  recordDefenseAction(
    {
      action,
      context,
      reason: "hostileVisible",
      result,
      structureId: getCreepName(creep),
      targetId: getObjectId(target)
    },
    telemetryEvents
  );
}
function shouldActivateSafeMode(context, towerAttackSucceeded) {
  const controller = context.colony.room.controller;
  if (context.hostileCreeps.length === 0 || (controller == null ? void 0 : controller.my) !== true || typeof controller.activateSafeMode !== "function" || !isEarlyRoomController(controller) || !isSafeModeAvailable(controller)) {
    return false;
  }
  return context.colony.spawns.length === 0 || !towerAttackSucceeded || context.damagedCriticalStructures.some(isSeverelyDamagedCriticalStructure);
}
function isEarlyRoomController(controller) {
  return typeof controller.level !== "number" || controller.level <= EARLY_ROOM_SAFE_MODE_RCL;
}
function isSafeModeAvailable(controller) {
  const available = controller.safeModeAvailable;
  const cooldown = controller.safeModeCooldown;
  const active = controller.safeMode;
  return typeof available === "number" && available > 0 && (typeof cooldown !== "number" || cooldown <= 0) && (typeof active !== "number" || active <= 0);
}
function createDefenseContext(colony) {
  const criticalStructures = getCriticalStructures(colony);
  return {
    colony,
    criticalStructures,
    damagedCriticalStructures: criticalStructures.filter(isDamagedCriticalStructure),
    hostileCreeps: findHostileCreeps(colony.room),
    hostileStructures: findHostileStructures(colony.room),
    towers: getOwnedTowers(colony.room)
  };
}
function hasDefensePressure(context) {
  return context.hostileCreeps.length > 0 || context.hostileStructures.length > 0 || context.damagedCriticalStructures.length > 0;
}
function getCriticalStructures(colony) {
  const structuresById = /* @__PURE__ */ new Map();
  for (const spawn of colony.spawns) {
    structuresById.set(getObjectId(spawn), spawn);
  }
  for (const tower of getOwnedTowers(colony.room)) {
    structuresById.set(getObjectId(tower), tower);
  }
  return [...structuresById.values()].sort(compareObjectIds);
}
function getOwnedTowers(room) {
  return findOwnedStructures(room).filter(
    (structure) => matchesStructureType(structure.structureType, "STRUCTURE_TOWER", "tower")
  );
}
function getUsableTowers(towers) {
  return towers.filter(hasStoredEnergy).sort(compareObjectIds);
}
function hasStoredEnergy(structure) {
  const store = structure.store;
  if (!store || typeof store.getUsedCapacity !== "function") {
    return true;
  }
  const usedCapacity = store.getUsedCapacity(getEnergyResource());
  return typeof usedCapacity !== "number" || usedCapacity > 0;
}
function selectWoundedFriendlyCreep(room, tower) {
  const woundedCreeps = findMyCreeps(room).filter(isWoundedCreep);
  return selectClosestTarget(tower, woundedCreeps);
}
function selectTowerAttackTarget(tower, context) {
  const hostileCreep = selectClosestTarget(tower, context.hostileCreeps);
  if (hostileCreep) {
    return hostileCreep;
  }
  return selectClosestTarget(tower, context.hostileStructures);
}
function selectDefenderTarget(creep) {
  const hostileCreep = selectClosestTarget(creep, findHostileCreeps(creep.room));
  if (hostileCreep) {
    return hostileCreep;
  }
  return selectClosestTarget(creep, findHostileStructures(creep.room));
}
function selectClosestTarget(origin, targets) {
  if (targets.length === 0) {
    return null;
  }
  return [...targets].sort((left, right) => compareRange(origin, left, right) || compareObjectIds(left, right))[0];
}
function compareRange(origin, left, right) {
  var _a;
  const getRangeTo = (_a = origin.pos) == null ? void 0 : _a.getRangeTo;
  if (typeof getRangeTo !== "function") {
    return 0;
  }
  const leftRange = left.pos ? getRangeTo.call(origin.pos, left.pos) : Infinity;
  const rightRange = right.pos ? getRangeTo.call(origin.pos, right.pos) : Infinity;
  return leftRange - rightRange;
}
function isDamagedCriticalStructure(structure) {
  return isStructureBelowHitsRatio(structure, CRITICAL_STRUCTURE_DAMAGE_RATIO);
}
function isSeverelyDamagedCriticalStructure(structure) {
  return isStructureBelowHitsRatio(structure, SAFE_MODE_CRITICAL_DAMAGE_RATIO);
}
function isStructureBelowHitsRatio(structure, ratio) {
  return typeof structure.hits === "number" && typeof structure.hitsMax === "number" && structure.hitsMax > 0 && structure.hits < structure.hitsMax * ratio;
}
function isWoundedCreep(creep) {
  return typeof creep.hits === "number" && typeof creep.hitsMax === "number" && creep.hits < creep.hitsMax;
}
function hasColonyWorker(roomName) {
  return Object.values(Game.creeps).some(
    (creep) => creep.memory.role === "worker" && creep.memory.colony === roomName
  );
}
function recordDefenseAction(input, telemetryEvents) {
  const actionMemory = {
    type: input.action,
    roomName: input.context.colony.room.name,
    tick: getGameTime3(),
    reason: input.reason,
    hostileCreepCount: input.context.hostileCreeps.length,
    hostileStructureCount: input.context.hostileStructures.length,
    damagedCriticalStructureCount: input.context.damagedCriticalStructures.length,
    ...input.structureId ? { structureId: input.structureId } : {},
    ...input.targetId ? { targetId: input.targetId } : {},
    ...typeof input.result === "number" ? { result: input.result } : {}
  };
  recordDefenseActionMemory(actionMemory);
  telemetryEvents.push({
    type: "defense",
    action: actionMemory.type,
    roomName: actionMemory.roomName,
    reason: actionMemory.reason,
    hostileCreepCount: actionMemory.hostileCreepCount,
    hostileStructureCount: actionMemory.hostileStructureCount,
    damagedCriticalStructureCount: actionMemory.damagedCriticalStructureCount,
    ...actionMemory.structureId ? { structureId: actionMemory.structureId } : {},
    ...actionMemory.targetId ? { targetId: actionMemory.targetId } : {},
    ...typeof actionMemory.result === "number" ? { result: actionMemory.result } : {},
    tick: actionMemory.tick
  });
}
function recordDefenseActionMemory(action) {
  var _a, _b, _c;
  const globalMemory = globalThis.Memory;
  if (!globalMemory) {
    return;
  }
  const defenseMemory = (_a = globalMemory.defense) != null ? _a : {};
  const rooms = (_b = defenseMemory.rooms) != null ? _b : {};
  rooms[action.roomName] = action;
  defenseMemory.rooms = rooms;
  defenseMemory.actions = [action, ...(_c = defenseMemory.actions) != null ? _c : []].slice(0, MAX_RECORDED_DEFENSE_ACTIONS);
  globalMemory.defense = defenseMemory;
}
function findHostileCreeps(room) {
  return findRoomObjects2(room, "FIND_HOSTILE_CREEPS");
}
function findHostileStructures(room) {
  return findRoomObjects2(room, "FIND_HOSTILE_STRUCTURES");
}
function findOwnedStructures(room) {
  return findRoomObjects2(room, "FIND_MY_STRUCTURES");
}
function findMyCreeps(room) {
  return findRoomObjects2(room, "FIND_MY_CREEPS");
}
function findRoomObjects2(room, constantName) {
  const findConstant = getGlobalNumber(constantName);
  const find = room.find;
  if (typeof findConstant !== "number" || typeof find !== "function") {
    return [];
  }
  try {
    const result = find.call(room, findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
function matchesStructureType(value, globalName, fallback) {
  var _a;
  const expectedValue = (_a = globalThis[globalName]) != null ? _a : fallback;
  return value === expectedValue;
}
function compareObjectIds(left, right) {
  return getObjectId(left).localeCompare(getObjectId(right));
}
function getObjectId(object) {
  if (typeof object !== "object" || object === null) {
    return "";
  }
  const candidate = object;
  if (typeof candidate.id === "string") {
    return candidate.id;
  }
  if (typeof candidate.name === "string") {
    return candidate.name;
  }
  return "";
}
function getCreepName(creep) {
  return typeof creep.name === "string" ? creep.name : getObjectId(creep);
}
function getGlobalNumber(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getEnergyResource() {
  const value = globalThis.RESOURCE_ENERGY;
  return typeof value === "string" ? value : "energy";
}
function getGameTime3() {
  return typeof Game.time === "number" ? Game.time : 0;
}

// src/creeps/roleCounts.ts
var WORKER_REPLACEMENT_TICKS_TO_LIVE = 100;
function countCreepsByRole(creeps, colonyName) {
  const counts = creeps.reduce(
    (counts2, creep) => {
      var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
      if (isColonyWorker(creep, colonyName)) {
        counts2.worker += 1;
        if (canSatisfyRoleCapacity(creep)) {
          counts2.workerCapacity = ((_a = counts2.workerCapacity) != null ? _a : 0) + 1;
        }
      }
      if (canSatisfyDefenderCapacity(creep, colonyName)) {
        counts2.defender = ((_b = counts2.defender) != null ? _b : 0) + 1;
      }
      if (isColonyClaimer(creep, colonyName) && canSatisfyTerritoryControllerCapacity(creep)) {
        counts2.claimer = ((_c = counts2.claimer) != null ? _c : 0) + 1;
        const targetRoom = (_d = creep.memory.territory) == null ? void 0 : _d.targetRoom;
        if (targetRoom) {
          const claimersByTargetRoom = (_e = counts2.claimersByTargetRoom) != null ? _e : {};
          claimersByTargetRoom[targetRoom] = ((_f = claimersByTargetRoom[targetRoom]) != null ? _f : 0) + 1;
          counts2.claimersByTargetRoom = claimersByTargetRoom;
          incrementTargetRoomActionCount(counts2, (_g = creep.memory.territory) == null ? void 0 : _g.action, targetRoom);
        }
      }
      if (isColonyScout(creep, colonyName) && canSatisfyRoleCapacity(creep)) {
        counts2.scout = ((_h = counts2.scout) != null ? _h : 0) + 1;
        const targetRoom = (_i = creep.memory.territory) == null ? void 0 : _i.targetRoom;
        if (targetRoom) {
          const scoutsByTargetRoom = (_j = counts2.scoutsByTargetRoom) != null ? _j : {};
          scoutsByTargetRoom[targetRoom] = ((_k = scoutsByTargetRoom[targetRoom]) != null ? _k : 0) + 1;
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
function canSatisfyTerritoryControllerCapacity(creep) {
  return canSatisfyRoleCapacity(creep) && hasActiveClaimPart(creep);
}
function canSatisfyDefenderCapacity(creep, colonyName) {
  return isColonyDefender(creep, colonyName) && isDefenderInColonyRoom(creep, colonyName) && canSatisfyRoleCapacity(creep) && hasActiveAttackPart(creep);
}
function isColonyDefender(creep, colonyName) {
  var _a;
  return creep.memory.role === "defender" && ((_a = creep.memory.defense) == null ? void 0 : _a.homeRoom) === colonyName;
}
function isDefenderInColonyRoom(creep, colonyName) {
  var _a;
  return ((_a = creep.room) == null ? void 0 : _a.name) === colonyName;
}
function hasActiveAttackPart(creep) {
  return hasActiveBodyPartType(creep, getBodyPartConstant("ATTACK", "attack"));
}
function hasActiveClaimPart(creep) {
  return hasActiveBodyPartType(creep, getBodyPartConstant("CLAIM", "claim"));
}
function hasActiveBodyPartType(creep, bodyPartType) {
  var _a;
  const activeParts = (_a = creep.getActiveBodyparts) == null ? void 0 : _a.call(creep, bodyPartType);
  if (typeof activeParts === "number") {
    return activeParts > 0;
  }
  if (!Array.isArray(creep.body)) {
    return false;
  }
  return creep.body.some((part) => isActiveBodyPart(part, bodyPartType));
}
function isActiveBodyPart(part, bodyPartType) {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const bodyPart = part;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === "number" && bodyPart.hits > 0;
}
function getBodyPartConstant(globalName, fallback) {
  var _a;
  const constants = globalThis;
  return (_a = constants[globalName]) != null ? _a : fallback;
}

// src/spawn/creepBodies.ts
var TERRITORY_CONTROLLER_BODY = ["claim", "move"];
var TERRITORY_CONTROLLER_BODY_COST = 650;

// src/spawn/bodyTemplates.ts
var TERRITORY_CLAIMER_UPGRADE_PARTS = ["work", "carry", "move"];
var TERRITORY_CLAIMER_UPGRADE_PART_COST = 250;
var MAX_CREEP_PARTS = 50;
var TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS = 5;
var TERRITORY_CONTROLLER_PRESSURE_BODY = Array.from(
  { length: TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS },
  () => TERRITORY_CONTROLLER_BODY
).flat();
var TERRITORY_CONTROLLER_PRESSURE_BODY_COST = TERRITORY_CONTROLLER_BODY_COST * TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS;
function buildTerritoryClaimerBody(energyAvailable) {
  if (energyAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return [];
  }
  const upgradeEnergy = energyAvailable - TERRITORY_CONTROLLER_BODY_COST;
  const maxUpgradePairsByEnergy = Math.floor(upgradeEnergy / TERRITORY_CLAIMER_UPGRADE_PART_COST);
  const maxUpgradePairsByCapacity = Math.floor(
    (MAX_CREEP_PARTS - TERRITORY_CONTROLLER_BODY.length) / TERRITORY_CLAIMER_UPGRADE_PARTS.length
  );
  const upgradePairs = Math.min(maxUpgradePairsByEnergy, maxUpgradePairsByCapacity);
  if (upgradePairs <= 0) {
    return [...TERRITORY_CONTROLLER_BODY];
  }
  return [
    ...TERRITORY_CONTROLLER_BODY,
    ...Array.from({ length: upgradePairs }).flatMap(() => TERRITORY_CLAIMER_UPGRADE_PARTS)
  ];
}

// src/spawn/bodyBuilder.ts
var WORKER_PATTERN = ["work", "carry", "move"];
var WORKER_PATTERN_COST = 200;
var WORKER_LOGISTICS_PAIR = ["carry", "move"];
var WORKER_LOGISTICS_PAIR_COST = 100;
var WORKER_WORK_MOVE_PAIR = ["work", "move"];
var WORKER_WORK_MOVE_PAIR_COST = 150;
var WORKER_SURPLUS_MOVE = ["move"];
var WORKER_SURPLUS_MOVE_COST = 50;
var MID_RCL_WORKER_PATTERN = ["work", "work", "carry", "move", "move"];
var MID_RCL_WORKER_PATTERN_COST = 350;
var HIGH_RCL_WORKER_PATTERN = ["work", "work", "work", "carry", "move", "move"];
var HIGH_RCL_WORKER_PATTERN_COST = 450;
var EMERGENCY_DEFENDER_BODY = ["tough", "attack", "move"];
var EMERGENCY_DEFENDER_BODY_COST = 140;
var MAX_CREEP_PARTS2 = 50;
var MAX_WORKER_PATTERN_COUNT = 4;
var MIN_MID_RCL = 4;
var MIN_HIGH_RCL = 7;
var MAX_MID_RCL_WORKER_PATTERN_COUNT = 5;
var MAX_HIGH_RCL_WORKER_PATTERN_COUNT = 8;
var MID_RCL_WORKER_MAX_COST = 1800;
var HIGH_RCL_WORKER_MAX_COST = 3750;
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
var MID_RCL_WORKER_PROFILE = {
  pattern: MID_RCL_WORKER_PATTERN,
  patternCost: MID_RCL_WORKER_PATTERN_COST,
  maxCost: MID_RCL_WORKER_MAX_COST,
  maxPatternCount: MAX_MID_RCL_WORKER_PATTERN_COUNT
};
var HIGH_RCL_WORKER_PROFILE = {
  pattern: HIGH_RCL_WORKER_PATTERN,
  patternCost: HIGH_RCL_WORKER_PATTERN_COST,
  maxCost: HIGH_RCL_WORKER_MAX_COST,
  maxPatternCount: MAX_HIGH_RCL_WORKER_PATTERN_COUNT
};
function buildWorkerBody(energyAvailable, controllerLevel) {
  if (isHighRcl(controllerLevel)) {
    return buildProfileWorkerBody(energyAvailable, HIGH_RCL_WORKER_PROFILE);
  }
  if (isMidRcl(controllerLevel)) {
    return buildProfileWorkerBody(energyAvailable, MID_RCL_WORKER_PROFILE);
  }
  return buildLowRclWorkerBody(energyAvailable);
}
function buildLowRclWorkerBody(energyAvailable) {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }
  const maxPatternCountByEnergy = Math.floor(energyAvailable / WORKER_PATTERN_COST);
  const maxPatternCountBySize = Math.floor(MAX_CREEP_PARTS2 / WORKER_PATTERN.length);
  const patternCount = Math.min(maxPatternCountByEnergy, maxPatternCountBySize, MAX_WORKER_PATTERN_COUNT);
  const body = Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
  if (shouldAddWorkerLogisticsPair(energyAvailable, patternCount, body.length)) {
    return [...body, ...WORKER_LOGISTICS_PAIR];
  }
  if (shouldAddWorkerSurplusMove(energyAvailable, patternCount, body.length)) {
    return [...body, ...WORKER_SURPLUS_MOVE];
  }
  return body;
}
function buildProfileWorkerBody(energyAvailable, profile) {
  if (energyAvailable < profile.patternCost) {
    return buildLowRclWorkerBody(energyAvailable);
  }
  const energyBudget = Math.min(energyAvailable, profile.maxCost);
  const maxPatternCountByEnergy = Math.floor(energyBudget / profile.patternCost);
  const maxPatternCountBySize = Math.floor(MAX_CREEP_PARTS2 / profile.pattern.length);
  const patternCount = Math.min(
    maxPatternCountByEnergy,
    maxPatternCountBySize,
    profile.maxPatternCount
  );
  const body = Array.from({ length: patternCount }).flatMap(() => profile.pattern);
  return addProfileWorkerRemainderParts(body, energyBudget, patternCount * profile.patternCost);
}
function addProfileWorkerRemainderParts(body, energyBudget, bodyCost) {
  const additions = [
    { parts: WORKER_WORK_MOVE_PAIR, cost: WORKER_WORK_MOVE_PAIR_COST },
    { parts: WORKER_LOGISTICS_PAIR, cost: WORKER_LOGISTICS_PAIR_COST },
    { parts: WORKER_SURPLUS_MOVE, cost: WORKER_SURPLUS_MOVE_COST }
  ];
  let nextBody = [...body];
  let nextCost = bodyCost;
  for (const addition of additions) {
    if (nextCost + addition.cost <= energyBudget && nextBody.length + addition.parts.length <= MAX_CREEP_PARTS2) {
      nextBody = [...nextBody, ...addition.parts];
      nextCost += addition.cost;
    }
  }
  return nextBody;
}
function isMidRcl(controllerLevel) {
  return typeof controllerLevel === "number" && controllerLevel >= MIN_MID_RCL;
}
function isHighRcl(controllerLevel) {
  return typeof controllerLevel === "number" && controllerLevel >= MIN_HIGH_RCL;
}
function shouldAddWorkerLogisticsPair(energyAvailable, patternCount, bodyPartCount) {
  const remainingEnergy = energyAvailable - patternCount * WORKER_PATTERN_COST;
  return patternCount >= 2 && patternCount < MAX_WORKER_PATTERN_COUNT && remainingEnergy >= WORKER_LOGISTICS_PAIR_COST && bodyPartCount + WORKER_LOGISTICS_PAIR.length <= MAX_CREEP_PARTS2;
}
function shouldAddWorkerSurplusMove(energyAvailable, patternCount, bodyPartCount) {
  const remainingEnergy = energyAvailable - patternCount * WORKER_PATTERN_COST;
  return patternCount >= 2 && patternCount < MAX_WORKER_PATTERN_COUNT && remainingEnergy >= WORKER_SURPLUS_MOVE_COST && bodyPartCount + WORKER_SURPLUS_MOVE.length <= MAX_CREEP_PARTS2;
}
function buildEmergencyWorkerBody(energyAvailable) {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }
  return [...WORKER_PATTERN];
}
function buildEmergencyDefenderBody(energyAvailable) {
  if (energyAvailable < EMERGENCY_DEFENDER_BODY_COST) {
    return [];
  }
  return [...EMERGENCY_DEFENDER_BODY];
}
function buildTerritoryControllerBody(energyAvailable) {
  return buildTerritoryClaimerBody(energyAvailable);
}
function buildTerritoryControllerPressureBody(energyAvailable) {
  if (energyAvailable < TERRITORY_CONTROLLER_PRESSURE_BODY_COST) {
    return [];
  }
  return [...TERRITORY_CONTROLLER_PRESSURE_BODY];
}
function getBodyCost(body) {
  return body.reduce((cost, part) => cost + BODY_PART_COSTS[part], 0);
}

// src/colony/survivalMode.ts
var MIN_WORKER_TARGET = 3;
var WORKERS_PER_SOURCE = 2;
var CONSTRUCTION_BACKLOG_WORKER_BONUS = 1;
var SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT = 5;
var SPAWN_EXTENSION_REFILL_WORKER_BONUS = 1;
var MIN_PRODUCTIVE_WORKER_BODY_ENERGY = 200;
var SPAWN_EXTENSION_REFILL_PRESSURE_RATIO = 0.75;
var MAX_WORKER_TARGET = 6;
var BOOTSTRAP_WORKER_FLOOR = 3;
var CONTROLLER_DOWNGRADE_GUARD_TICKS = 5e3;
var sourceCountByRoomName = /* @__PURE__ */ new Map();
var survivalAssessmentByColony = /* @__PURE__ */ new Map();
function assessColonySurvival(input) {
  var _a, _b;
  const workerCapacity = normalizeNonNegativeInteger(input.workerCapacity);
  const workerTarget = normalizeNonNegativeInteger(input.workerTarget);
  const survivalWorkerFloor = Math.max(1, Math.min(BOOTSTRAP_WORKER_FLOOR, Math.max(workerTarget, 1)));
  const hostilePresence = ((_a = input.hostileCreepCount) != null ? _a : 0) > 0 || ((_b = input.hostileStructureCount) != null ? _b : 0) > 0;
  const controllerDowngradeGuard = isControllerDowngradeGuardActive(input.controller);
  const bootstrap = workerCapacity < survivalWorkerFloor;
  const territoryReady = !bootstrap && !hostilePresence && workerCapacity >= workerTarget && input.energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST && isControllerTerritoryReady(input.controller) && !controllerDowngradeGuard;
  return {
    mode: selectColonyMode({ bootstrap, hostilePresence, territoryReady }),
    roomName: input.roomName,
    workerCapacity,
    workerTarget,
    survivalWorkerFloor,
    controllerDowngradeGuard,
    hostilePresence,
    territoryReady,
    suppressionReasons: getSuppressionReasons({
      bootstrap,
      controller: input.controller,
      controllerDowngradeGuard,
      energyCapacityAvailable: input.energyCapacityAvailable,
      hostilePresence,
      workerCapacity,
      workerTarget
    })
  };
}
function assessColonySnapshotSurvival(colony, roleCounts) {
  var _a;
  return assessColonySurvival({
    roomName: (_a = getRoomName(colony.room)) != null ? _a : "",
    workerCapacity: getWorkerCapacity(roleCounts),
    workerTarget: getWorkerTarget(colony, roleCounts),
    energyCapacityAvailable: colony.energyCapacityAvailable,
    controller: getControllerSurvivalState(colony.room.controller),
    hostileCreepCount: countRoomFind(colony.room, "FIND_HOSTILE_CREEPS"),
    hostileStructureCount: countRoomFind(colony.room, "FIND_HOSTILE_STRUCTURES")
  });
}
function getWorkerTarget(colony, roleCounts) {
  const sourceCount = getSourceCount(colony.room);
  const sourceAwareTarget = sourceCount * WORKERS_PER_SOURCE;
  const baseTarget = Math.min(MAX_WORKER_TARGET, Math.max(MIN_WORKER_TARGET, sourceAwareTarget));
  const workerCapacity = getWorkerCapacity(roleCounts);
  if (workerCapacity < baseTarget || !isConstructionBonusHomeSafe(colony.room.controller)) {
    return baseTarget;
  }
  const refillPressureTarget = shouldAddSpawnExtensionRefillWorker(colony) ? Math.min(MAX_WORKER_TARGET, baseTarget + SPAWN_EXTENSION_REFILL_WORKER_BONUS) : baseTarget;
  if (workerCapacity < refillPressureTarget) {
    return refillPressureTarget;
  }
  const constructionBacklogSiteCount = getConstructionBacklogSiteCount(colony.room);
  if (constructionBacklogSiteCount === 0) {
    return refillPressureTarget;
  }
  const firstBonusTarget = Math.min(
    MAX_WORKER_TARGET,
    refillPressureTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS
  );
  if (workerCapacity < firstBonusTarget || constructionBacklogSiteCount < SUBSTANTIAL_CONSTRUCTION_BACKLOG_SITE_COUNT) {
    return firstBonusTarget;
  }
  return Math.min(MAX_WORKER_TARGET, firstBonusTarget + CONSTRUCTION_BACKLOG_WORKER_BONUS);
}
function recordColonySurvivalAssessment(colonyName, assessment, tick = getGameTime4()) {
  if (!isNonEmptyString2(colonyName) || tick === null) {
    return;
  }
  survivalAssessmentByColony.set(colonyName, { assessment, tick });
}
function getRecordedColonySurvivalAssessment(colonyName, tick = getGameTime4()) {
  if (!isNonEmptyString2(colonyName) || tick === null) {
    return null;
  }
  const cached = survivalAssessmentByColony.get(colonyName);
  return (cached == null ? void 0 : cached.tick) === tick ? cached.assessment : null;
}
function clearColonySurvivalAssessmentCache() {
  survivalAssessmentByColony.clear();
}
function suppressesTerritoryWork(assessment) {
  return assessment !== null && (assessment.mode === "BOOTSTRAP" || assessment.mode === "LOCAL_STABLE" || assessment.mode === "DEFENSE");
}
function suppressesBootstrapNonCriticalWork(assessment) {
  return (assessment == null ? void 0 : assessment.mode) === "BOOTSTRAP";
}
function selectColonyMode(input) {
  if (input.bootstrap) {
    return "BOOTSTRAP";
  }
  if (input.hostilePresence) {
    return "DEFENSE";
  }
  return input.territoryReady ? "TERRITORY_READY" : "LOCAL_STABLE";
}
function getSuppressionReasons(input) {
  if (input.bootstrap) {
    return ["bootstrapWorkerFloor"];
  }
  const reasons = [];
  if (input.workerCapacity < input.workerTarget) {
    reasons.push("localWorkerRecovery");
  }
  if (input.controllerDowngradeGuard) {
    reasons.push("controllerDowngradeGuard");
  }
  if (input.hostilePresence) {
    reasons.push("defense");
  }
  if (input.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    reasons.push("territoryEnergyCapacity");
  }
  if (!isControllerTerritoryReady(input.controller)) {
    reasons.push("controllerLevel");
  }
  return reasons;
}
function isControllerTerritoryReady(controller) {
  return (controller == null ? void 0 : controller.my) === true && typeof controller.level === "number" && controller.level >= 2;
}
function isControllerDowngradeGuardActive(controller) {
  return (controller == null ? void 0 : controller.my) === true && typeof controller.ticksToDowngrade === "number" && controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS;
}
function getControllerSurvivalState(controller) {
  if (!controller) {
    return void 0;
  }
  return {
    my: controller.my,
    level: controller.level,
    ticksToDowngrade: controller.ticksToDowngrade
  };
}
function isConstructionBonusHomeSafe(controller) {
  return (controller == null ? void 0 : controller.my) === true && (typeof controller.ticksToDowngrade !== "number" || controller.ticksToDowngrade > CONTROLLER_DOWNGRADE_GUARD_TICKS);
}
function shouldAddSpawnExtensionRefillWorker(colony) {
  return colony.spawns.length > 0 && colony.energyAvailable >= MIN_PRODUCTIVE_WORKER_BODY_ENERGY && colony.energyAvailable < TERRITORY_CONTROLLER_BODY_COST && colony.energyCapacityAvailable > 0 && colony.energyAvailable < colony.energyCapacityAvailable * SPAWN_EXTENSION_REFILL_PRESSURE_RATIO;
}
function getConstructionBacklogSiteCount(room) {
  return countRoomFind(room, "FIND_MY_CONSTRUCTION_SITES");
}
function getSourceCount(room) {
  const roomName = getRoomName(room);
  if (roomName) {
    const cachedSourceCount = sourceCountByRoomName.get(roomName);
    if ((cachedSourceCount == null ? void 0 : cachedSourceCount.room) === room) {
      return cachedSourceCount.count;
    }
  }
  const sourceCount = findSourceCount(room);
  if (roomName) {
    sourceCountByRoomName.set(roomName, { count: sourceCount, room });
  }
  return sourceCount;
}
function findSourceCount(room) {
  if (typeof room.find !== "function") {
    return 1;
  }
  const sourceFindConstant = getGlobalNumber2("FIND_SOURCES");
  if (sourceFindConstant === void 0) {
    return 1;
  }
  return room.find(sourceFindConstant).length;
}
function countRoomFind(room, constantName) {
  if (typeof room.find !== "function") {
    return 0;
  }
  const findConstant = getGlobalNumber2(constantName);
  if (findConstant === void 0) {
    return 0;
  }
  return room.find(findConstant).length;
}
function getGlobalNumber2(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getRoomName(room) {
  return typeof room.name === "string" && room.name.length > 0 ? room.name : null;
}
function getGameTime4() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" && Number.isFinite(gameTime) ? gameTime : null;
}
function normalizeNonNegativeInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function isNonEmptyString2(value) {
  return typeof value === "string" && value.length > 0;
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
var DEFAULT_MAX_ROAD_TARGETS_PER_TICK = 4;
var DEFAULT_MAX_PATH_OPS_PER_TARGET = 1e3;
var MIN_CONTROLLER_LEVEL_FOR_ROADS = 2;
var SOURCE_CONTROLLER_ROAD_MAX_RANGE = 6;
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
  const routes = selectRoadRoutes(colony.room, anchor.pos, limits.maxTargetsPerTick);
  if (routes.length === 0) {
    return [];
  }
  const lookups = createRoadPlannerLookups(colony.room);
  if (!lookups) {
    return [];
  }
  const candidates = selectRoadCandidates(colony.room.name, routes, lookups, limits);
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
function selectRoadRoutes(room, anchor, maxRoutes) {
  if (maxRoutes <= 0) {
    return [];
  }
  const routes = selectRoadTargets(room).map(
    (target) => createRoadRoute(anchor, target, 1)
  );
  routes.push(...selectSourceControllerRoadRoutes(room));
  return routes.slice(0, maxRoutes);
}
function selectRoadTargets(room) {
  var _a;
  const targets = getSortedSources(room).map((source) => ({ pos: source.pos }));
  const controllerPosition = (_a = room.controller) == null ? void 0 : _a.pos;
  if (controllerPosition && isSameRoomPosition(controllerPosition, room.name)) {
    targets.push({ pos: controllerPosition });
  }
  return targets.filter((target) => isSameRoomPosition(target.pos, room.name));
}
function selectSourceControllerRoadRoutes(room) {
  var _a;
  const controllerPosition = (_a = room.controller) == null ? void 0 : _a.pos;
  if (!controllerPosition || !isSameRoomPosition(controllerPosition, room.name)) {
    return [];
  }
  return getSortedSources(room).filter((source) => getRangeBetweenPositions(source.pos, controllerPosition) <= SOURCE_CONTROLLER_ROAD_MAX_RANGE).map((source) => createRoadRoute(source.pos, { pos: controllerPosition }, 0));
}
function createRoadRoute(origin, target, priority) {
  return { origin, priority, target };
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
function selectRoadCandidates(roomName, routes, lookups, limits) {
  const candidates = /* @__PURE__ */ new Map();
  routes.forEach((route, targetIndex) => {
    const path = findRoadPath(roomName, route.origin, route.target, lookups, limits);
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
        existingCandidate.minRoutePriority = Math.min(existingCandidate.minRoutePriority, route.priority);
        existingCandidate.minPathIndex = Math.min(existingCandidate.minPathIndex, pathIndex);
        existingCandidate.minTargetIndex = Math.min(existingCandidate.minTargetIndex, targetIndex);
        return;
      }
      candidates.set(key, {
        x: position.x,
        y: position.y,
        key,
        minRoutePriority: route.priority,
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
  return right.routeCount - left.routeCount || left.minRoutePriority - right.minRoutePriority || left.minPathIndex - right.minPathIndex || left.minTargetIndex - right.minTargetIndex || left.y - right.y || left.x - right.x;
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
function getRangeBetweenPositions(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function isTerrainWall2(terrain, position) {
  return (terrain.get(position.x, position.y) & getTerrainWallMask2()) !== 0;
}
function isRoadStructure(structure) {
  return matchesStructureType2(structure.structureType, "STRUCTURE_ROAD", "road");
}
function isRoadConstructionSite(site) {
  return matchesStructureType2(site.structureType, "STRUCTURE_ROAD", "road");
}
function matchesStructureType2(actual, globalName, fallback) {
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

// src/economy/sourceContainers.ts
function findSourceContainer(room, source) {
  var _a;
  if (typeof FIND_STRUCTURES !== "number" || typeof room.find !== "function") {
    return null;
  }
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition || !isSameRoomPosition2(sourcePosition, room.name)) {
    return null;
  }
  const containers = room.find(FIND_STRUCTURES).filter((structure) => isContainerStructure(structure)).filter((container) => {
    const containerPosition = getRoomObjectPosition(container);
    return containerPosition !== null && isSameRoomPosition2(containerPosition, room.name) && getRangeBetweenPositions2(sourcePosition, containerPosition) <= 1;
  });
  return (_a = containers.sort((left, right) => compareSourceContainers(sourcePosition, left, right))[0]) != null ? _a : null;
}
function isContainerStructure(structure) {
  return matchesStructureType3(structure.structureType, "STRUCTURE_CONTAINER", "container");
}
function getRangeBetweenPositions2(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function getRoomObjectPosition(object) {
  const position = object.pos;
  return isRoomPosition(position) ? position : null;
}
function isSameRoomPosition2(position, roomName) {
  return typeof position.roomName !== "string" || position.roomName === roomName;
}
function getPositionKey3(position) {
  return `${position.x},${position.y}`;
}
function compareSourceContainers(sourcePosition, left, right) {
  const leftPosition = getRoomObjectPosition(left);
  const rightPosition = getRoomObjectPosition(right);
  return compareNumbers(
    leftPosition ? getRangeBetweenPositions2(sourcePosition, leftPosition) : Number.POSITIVE_INFINITY,
    rightPosition ? getRangeBetweenPositions2(sourcePosition, rightPosition) : Number.POSITIVE_INFINITY
  ) || String(left.id).localeCompare(String(right.id));
}
function compareNumbers(left, right) {
  return left - right;
}
function isRoomPosition(value) {
  return typeof value === "object" && value !== null && typeof value.x === "number" && typeof value.y === "number" && Number.isFinite(value.x) && Number.isFinite(value.y);
}
function matchesStructureType3(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}

// src/construction/sourceContainerPlanner.ts
var MIN_CONTROLLER_LEVEL_FOR_SOURCE_CONTAINERS = 2;
var ROOM_EDGE_MIN3 = 1;
var ROOM_EDGE_MAX3 = 48;
var DEFAULT_TERRAIN_WALL_MASK3 = 1;
function planSourceContainerConstruction(colony) {
  var _a, _b;
  const room = colony.room;
  if (((_b = (_a = room.controller) == null ? void 0 : _a.level) != null ? _b : 0) < MIN_CONTROLLER_LEVEL_FOR_SOURCE_CONTAINERS || !hasRequiredRoomApis2(room) || typeof FIND_SOURCES !== "number") {
    return null;
  }
  const lookups = createSourceContainerPlannerLookups(room);
  if (!lookups) {
    return null;
  }
  const anchor = selectContainerAnchor(colony);
  for (const source of getSortedSources2(room)) {
    if (findSourceContainer(room, source) || hasPendingSourceContainerSite(source, lookups)) {
      continue;
    }
    const position = selectSourceContainerPosition(source, lookups, anchor);
    if (!position) {
      continue;
    }
    const result = room.createConstructionSite(position.x, position.y, getContainerStructureType());
    if (result === getOkCode2()) {
      lookups.blockedPositions.add(getPositionKey3(position));
      lookups.pendingContainerPositions.add(getPositionKey3(position));
    }
    return result;
  }
  return null;
}
function hasRequiredRoomApis2(room) {
  const partialRoom = room;
  return typeof partialRoom.find === "function" && typeof partialRoom.createConstructionSite === "function";
}
function createSourceContainerPlannerLookups(room) {
  if (typeof FIND_STRUCTURES !== "number" || typeof FIND_CONSTRUCTION_SITES !== "number") {
    return null;
  }
  const terrain = getRoomTerrain2(room);
  if (!terrain) {
    return null;
  }
  const lookups = {
    terrain,
    blockedPositions: /* @__PURE__ */ new Set(),
    pendingContainerPositions: /* @__PURE__ */ new Set()
  };
  for (const structure of room.find(FIND_STRUCTURES)) {
    const position = getRoomObjectPosition(structure);
    if (position && isSameRoomPosition2(position, room.name)) {
      lookups.blockedPositions.add(getPositionKey3(position));
    }
  }
  for (const site of room.find(FIND_CONSTRUCTION_SITES)) {
    const position = getRoomObjectPosition(site);
    if (!position || !isSameRoomPosition2(position, room.name)) {
      continue;
    }
    const key = getPositionKey3(position);
    lookups.blockedPositions.add(key);
    if (isContainerConstructionSite(site)) {
      lookups.pendingContainerPositions.add(key);
    }
  }
  return lookups;
}
function getSortedSources2(room) {
  return room.find(FIND_SOURCES).filter((source) => {
    const position = getRoomObjectPosition(source);
    return position !== null && isSameRoomPosition2(position, room.name);
  }).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}
function selectContainerAnchor(colony) {
  const [primarySpawn] = colony.spawns.filter((spawn) => getRoomObjectPosition(spawn) !== null).sort((left, right) => left.name.localeCompare(right.name));
  const anchorObject = primarySpawn != null ? primarySpawn : colony.room.controller;
  return anchorObject ? getRoomObjectPosition(anchorObject) : null;
}
function hasPendingSourceContainerSite(source, lookups) {
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition) {
    return false;
  }
  return getAdjacentSourceContainerPositions(sourcePosition).some(
    (position) => lookups.pendingContainerPositions.has(getPositionKey3(position))
  );
}
function selectSourceContainerPosition(source, lookups, anchor) {
  const sourcePosition = getRoomObjectPosition(source);
  if (!sourcePosition || typeof sourcePosition.roomName !== "string") {
    return null;
  }
  const candidates = getAdjacentSourceContainerPositions(sourcePosition).filter(
    (position) => canPlaceSourceContainer(lookups, position)
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort((left, right) => compareSourceContainerPositions(left, right, anchor))[0];
}
function getAdjacentSourceContainerPositions(sourcePosition) {
  const positions = [];
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
function canPlaceSourceContainer(lookups, position) {
  if (position.x < ROOM_EDGE_MIN3 || position.x > ROOM_EDGE_MAX3 || position.y < ROOM_EDGE_MIN3 || position.y > ROOM_EDGE_MAX3) {
    return false;
  }
  if ((lookups.terrain.get(position.x, position.y) & getTerrainWallMask3()) !== 0) {
    return false;
  }
  return !lookups.blockedPositions.has(getPositionKey3(position));
}
function compareSourceContainerPositions(left, right, anchor) {
  if (anchor) {
    const leftRange = getRangeBetweenPositions2(left, anchor);
    const rightRange = getRangeBetweenPositions2(right, anchor);
    if (leftRange !== rightRange) {
      return leftRange - rightRange;
    }
  }
  return left.y - right.y || left.x - right.x;
}
function getRoomTerrain2(room) {
  var _a;
  const game = globalThis.Game;
  return typeof ((_a = game == null ? void 0 : game.map) == null ? void 0 : _a.getRoomTerrain) === "function" ? game.map.getRoomTerrain(room.name) : null;
}
function getTerrainWallMask3() {
  const terrainWallMask = globalThis.TERRAIN_MASK_WALL;
  return typeof terrainWallMask === "number" ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK3;
}
function isContainerConstructionSite(site) {
  return site.structureType === getContainerStructureType();
}
function getContainerStructureType() {
  var _a;
  return (_a = globalThis.STRUCTURE_CONTAINER) != null ? _a : "container";
}
function getOkCode2() {
  var _a;
  return (_a = globalThis.OK) != null ? _a : 0;
}

// src/territory/territoryMemoryUtils.ts
function normalizeTerritoryIntents(rawIntents) {
  return Array.isArray(rawIntents) ? rawIntents.flatMap((intent) => {
    const normalizedIntent = normalizeTerritoryIntent(intent);
    return normalizedIntent ? [normalizedIntent] : [];
  }) : [];
}
function normalizeTerritoryIntent(rawIntent) {
  if (!isRecord2(rawIntent)) {
    return null;
  }
  if (!isNonEmptyString3(rawIntent.colony) || !isNonEmptyString3(rawIntent.targetRoom) || !isTerritoryIntentAction(rawIntent.action) || !isTerritoryIntentStatus(rawIntent.status) || !isFiniteNumber3(rawIntent.updatedAt)) {
    return null;
  }
  const followUp = normalizeTerritoryFollowUp(rawIntent.followUp);
  const suspended = normalizeTerritoryIntentSuspension(rawIntent.suspended);
  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...isTerritoryAutomationSource(rawIntent.createdBy) ? { createdBy: rawIntent.createdBy } : {},
    ...isTerritoryIntentSuppressionReason(rawIntent.reason) ? { reason: rawIntent.reason } : {},
    ...isFiniteNumber3(rawIntent.lastAttemptAt) ? { lastAttemptAt: rawIntent.lastAttemptAt } : {},
    ...typeof rawIntent.controllerId === "string" ? { controllerId: rawIntent.controllerId } : {},
    ...rawIntent.requiresControllerPressure === true ? { requiresControllerPressure: true } : {},
    ...followUp ? { followUp } : {},
    ...suspended ? { suspended } : {}
  };
}
function normalizeTerritoryIntentSuspension(rawSuspension) {
  if (!isRecord2(rawSuspension)) {
    return null;
  }
  if (rawSuspension.reason !== "hostile_presence" || !isFiniteNumber3(rawSuspension.hostileCount) || rawSuspension.hostileCount <= 0 || !isFiniteNumber3(rawSuspension.updatedAt)) {
    return null;
  }
  return {
    reason: rawSuspension.reason,
    hostileCount: Math.floor(rawSuspension.hostileCount),
    updatedAt: rawSuspension.updatedAt
  };
}
function normalizeTerritoryFollowUp(rawFollowUp) {
  if (!isRecord2(rawFollowUp) || !isTerritoryFollowUpSource(rawFollowUp.source)) {
    return null;
  }
  const originAction = getTerritoryFollowUpOriginAction(rawFollowUp.source);
  if (!isNonEmptyString3(rawFollowUp.originRoom) || rawFollowUp.originAction !== originAction) {
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
function isTerritoryIntentAction(action) {
  return action === "claim" || action === "reserve" || action === "scout";
}
function isTerritoryIntentStatus(status) {
  return status === "planned" || status === "active" || status === "suppressed";
}
function isTerritoryIntentSuppressionReason(reason) {
  return reason === "deadZoneTarget" || reason === "deadZoneRoute";
}
function isTerritoryFollowUpSource(source) {
  return source === "satisfiedClaimAdjacent" || source === "satisfiedReserveAdjacent" || source === "activeReserveAdjacent";
}
function isTerritoryAutomationSource(source) {
  return source === "occupationRecommendation" || source === "autonomousExpansionClaim" || source === "nextExpansionScoring";
}
function isFiniteNumber3(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isNonEmptyString3(value) {
  return typeof value === "string" && value.length > 0;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}

// src/territory/occupationRecommendation.ts
var EXIT_DIRECTION_ORDER = ["1", "3", "5", "7"];
var TERRITORY_BODY_ENERGY_CAPACITY = 650;
var MIN_READY_WORKERS = 3;
var DOWNGRADE_GUARD_TICKS = 5e3;
var RESERVATION_RENEWAL_TICKS = 1e3;
var TERRITORY_SUPPRESSION_RETRY_TICKS = 1500;
var TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS = 50;
var TERRITORY_ROUTE_DISTANCE_SEPARATOR = ">";
var ERR_NO_PATH_CODE2 = -2;
var OCCUPATION_RECOMMENDATION_TARGET_CREATOR = "occupationRecommendation";
var ROAD_DISTANCE_BASE_SCORE = 100;
var ROAD_DISTANCE_ROOM_COST_SCORE = 20;
var ACTION_SCORE = {
  occupy: 1e3,
  reserve: 800,
  scout: 420
};
function buildRuntimeOccupationRecommendationReport(colony, colonyWorkers) {
  return scoreOccupationRecommendations(buildRuntimeOccupationRecommendationInput(colony, colonyWorkers));
}
function clearOccupationRecommendationFollowUpIntent(report) {
  report.followUpIntent = null;
  return report;
}
function suppressOccupationClaimRecommendation(report) {
  var _a, _b, _c;
  if (((_a = report.next) == null ? void 0 : _a.action) !== "occupy" && ((_b = report.followUpIntent) == null ? void 0 : _b.action) !== "claim") {
    return report;
  }
  const next = (_c = report.candidates.find(
    (candidate) => candidate.action !== "occupy" && candidate.evidenceStatus !== "unavailable"
  )) != null ? _c : null;
  report.next = next;
  report.followUpIntent = isNonEmptyString4(report.colonyName) ? buildOccupationRecommendationFollowUpIntent(report.colonyName, next) : null;
  return report;
}
function clearOccupationRecommendationClaimIntent(colony) {
  if (!isNonEmptyString4(colony)) {
    return;
  }
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }
  const removedTargetKeys = /* @__PURE__ */ new Set();
  if (Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = territoryMemory.targets.filter((rawTarget) => {
      const target = normalizeTerritoryTarget(rawTarget);
      if ((target == null ? void 0 : target.colony) !== colony || target.action !== "claim" || target.createdBy !== OCCUPATION_RECOMMENDATION_TARGET_CREATOR) {
        return true;
      }
      removedTargetKeys.add(getOccupationRecommendationTargetKey(target.roomName, target.action));
      return false;
    });
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const nextIntents = intents.filter(
    (intent) => !(intent.colony === colony && intent.action === "claim" && (intent.createdBy === OCCUPATION_RECOMMENDATION_TARGET_CREATOR || removedTargetKeys.has(getOccupationRecommendationTargetKey(intent.targetRoom, intent.action))))
  );
  if (nextIntents.length === intents.length) {
    return;
  }
  if (nextIntents.length > 0) {
    territoryMemory.intents = nextIntents;
  } else {
    delete territoryMemory.intents;
  }
}
function scoreOccupationRecommendations(input) {
  var _a;
  const candidates = input.candidates.filter((candidate) => candidate.roomName !== input.colonyName).map((candidate) => scoreOccupationCandidate(input, candidate)).sort(compareOccupationRecommendationScores);
  const next = (_a = candidates.find((candidate) => candidate.evidenceStatus !== "unavailable")) != null ? _a : null;
  return attachOccupationRecommendationReportColony(
    { candidates, next, followUpIntent: buildOccupationRecommendationFollowUpIntent(input.colonyName, next) },
    input.colonyName
  );
}
function persistOccupationRecommendationFollowUpIntent(report, gameTime = getGameTime5()) {
  var _a, _b;
  const followUpIntent = report.followUpIntent;
  if (!followUpIntent) {
    revokeStaleOccupationRecommendationTargetsWithoutFollowUp(report);
    return null;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return null;
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find((intent) => isSameTerritoryIntent(intent, followUpIntent));
  if (existingIntent && (isTerritorySuppressionFresh(existingIntent, gameTime) || isRecoveredTerritoryFollowUpAttemptCoolingDown(existingIntent, gameTime) || isRecoveredTerritoryFollowUpRetryPending(existingIntent))) {
    refreshDeferredTerritoryIntentPressure(existingIntent, followUpIntent);
    return null;
  }
  const controllerId = (_a = followUpIntent.controllerId) != null ? _a : existingIntent == null ? void 0 : existingIntent.controllerId;
  const requiresControllerPressure = followUpIntent.requiresControllerPressure === true || (existingIntent ? shouldPreservePersistedTerritoryIntentPressureRequirement(existingIntent, controllerId) : false);
  const followUp = (_b = normalizeTerritoryFollowUp(followUpIntent.followUp)) != null ? _b : existingIntent == null ? void 0 : existingIntent.followUp;
  const nextIntent = {
    colony: followUpIntent.colony,
    targetRoom: followUpIntent.targetRoom,
    action: followUpIntent.action,
    status: (existingIntent == null ? void 0 : existingIntent.status) === "active" ? "active" : "planned",
    updatedAt: gameTime,
    createdBy: OCCUPATION_RECOMMENDATION_TARGET_CREATOR,
    ...controllerId ? { controllerId } : {},
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...followUp ? { followUp } : {},
    ...(existingIntent == null ? void 0 : existingIntent.suspended) ? { suspended: existingIntent.suspended } : {}
  };
  upsertTerritoryIntent(intents, nextIntent);
  persistOccupationRecommendationTarget(report, nextIntent);
  return nextIntent;
}
function persistOccupationRecommendationTarget(report, intent) {
  const target = buildPersistableOccupationRecommendationTarget(report, intent);
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }
  if (!target) {
    revokeOccupationRecommendationTarget(territoryMemory, intent);
    removeStaleOccupationRecommendationTargets(
      territoryMemory,
      intent.colony,
      buildActiveOccupationRecommendationControlTarget(report)
    );
    return;
  }
  removeStaleOccupationRecommendationTargets(territoryMemory, target.colony, target);
  upsertTerritoryTarget(territoryMemory, target);
}
function revokeStaleOccupationRecommendationTargetsWithoutFollowUp(report) {
  const colony = report.colonyName;
  if (!isNonEmptyString4(colony)) {
    return;
  }
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }
  removeStaleOccupationRecommendationTargets(territoryMemory, colony, null);
}
function buildPersistableOccupationRecommendationTarget(report, intent) {
  const recommendation = report.next;
  if (!recommendation || recommendation.roomName !== intent.targetRoom || getTerritoryIntentAction(recommendation.action) !== intent.action || recommendation.evidenceStatus !== "sufficient" || recommendation.preconditions.length > 0 || !isTerritoryControlAction(intent.action)) {
    return null;
  }
  return {
    colony: intent.colony,
    roomName: intent.targetRoom,
    action: intent.action,
    createdBy: OCCUPATION_RECOMMENDATION_TARGET_CREATOR,
    ...intent.controllerId ? { controllerId: intent.controllerId } : {}
  };
}
function removeStaleOccupationRecommendationTargets(territoryMemory, colony, activeTarget) {
  if (!Array.isArray(territoryMemory.targets)) {
    return;
  }
  territoryMemory.targets = territoryMemory.targets.filter((rawTarget) => {
    const target = normalizeTerritoryTarget(rawTarget);
    return !((target == null ? void 0 : target.colony) === colony && target.enabled !== false && target.createdBy === OCCUPATION_RECOMMENDATION_TARGET_CREATOR && (!activeTarget || target.roomName !== activeTarget.roomName || target.action !== activeTarget.action));
  });
}
function buildActiveOccupationRecommendationControlTarget(report) {
  const recommendation = report.next;
  if (!recommendation) {
    return null;
  }
  const action = getTerritoryIntentAction(recommendation.action);
  if (!isTerritoryControlAction(action)) {
    return null;
  }
  return { roomName: recommendation.roomName, action };
}
function getOccupationRecommendationTargetKey(roomName, action) {
  return `${roomName}:${action}`;
}
function revokeOccupationRecommendationTarget(territoryMemory, intent) {
  if (!isTerritoryControlAction(intent.action) || !Array.isArray(territoryMemory.targets)) {
    return;
  }
  territoryMemory.targets = territoryMemory.targets.filter((rawTarget) => {
    const target = normalizeTerritoryTarget(rawTarget);
    return !((target == null ? void 0 : target.colony) === intent.colony && target.roomName === intent.targetRoom && target.action === intent.action && target.enabled !== false && target.createdBy === OCCUPATION_RECOMMENDATION_TARGET_CREATOR);
  });
}
function upsertTerritoryTarget(territoryMemory, target) {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }
  const existingTarget = territoryMemory.targets.find((rawTarget) => {
    const normalizedTarget = normalizeTerritoryTarget(rawTarget);
    return (normalizedTarget == null ? void 0 : normalizedTarget.colony) === target.colony && normalizedTarget.roomName === target.roomName && normalizedTarget.action === target.action;
  });
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }
  if (isRecord3(existingTarget) && existingTarget.enabled !== false && !existingTarget.controllerId && target.controllerId) {
    existingTarget.controllerId = target.controllerId;
  }
}
function attachOccupationRecommendationReportColony(report, colonyName) {
  Object.defineProperty(report, "colonyName", {
    value: colonyName,
    enumerable: false
  });
  return report;
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
        routeDistance: getCachedRouteDistance(colonyName, target.roomName),
        roadDistance: getCachedNearestOwnedRoomRouteDistance(colonyName, target.roomName)
      });
      order += 1;
    }
  }
  for (const roomName of getAdjacentRoomNames(colonyName)) {
    const cachedRouteDistance = getCachedRouteDistance(colonyName, roomName);
    const routeDistance = cachedRouteDistance === void 0 ? 1 : cachedRouteDistance;
    upsertOccupationCandidate(candidatesByRoom, {
      roomName,
      source: "adjacent",
      order,
      adjacent: true,
      visible: false,
      routeDistance,
      ...typeof routeDistance === "number" ? { roadDistance: routeDistance } : {}
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
  if (existing.roadDistance === void 0 && candidate.roadDistance !== void 0) {
    existing.roadDistance = candidate.roadDistance;
  }
}
function enrichVisibleOccupationCandidate(candidate) {
  var _a, _b;
  const room = (_a = getGameRooms()) == null ? void 0 : _a[candidate.roomName];
  if (!room) {
    return candidate;
  }
  const hostileCreeps = findRoomObjects3(room, "FIND_HOSTILE_CREEPS");
  const hostileStructures = findRoomObjects3(room, "FIND_HOSTILE_STRUCTURES");
  const sources = findRoomObjects3(room, "FIND_SOURCES");
  const constructionSites = findRoomObjects3(room, "FIND_MY_CONSTRUCTION_SITES");
  const ownedStructures = findRoomObjects3(room, "FIND_MY_STRUCTURES");
  const controllerId = (_b = room.controller) == null ? void 0 : _b.id;
  return {
    ...candidate,
    visible: true,
    ...room.controller ? { controller: summarizeController(room.controller) } : {},
    ...typeof controllerId === "string" ? { controllerId } : {},
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
  let requiresControllerPressure = false;
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
    const controllerPressureEvidence = getControllerPressureEvidence(input, candidate);
    const unavailableReason = getControllerUnavailableReason(input, candidate);
    if (controllerPressureEvidence) {
      evidence.push(controllerPressureEvidence);
      action = candidate.actionHint === "claim" ? "occupy" : "reserve";
      requiresControllerPressure = true;
      if (candidate.sourceCount === void 0) {
        risks.push("source count evidence missing");
        evidenceStatus = "insufficient-evidence";
      } else {
        evidence.push(`${candidate.sourceCount} sources visible`);
      }
    } else if (unavailableReason) {
      risks.push(unavailableReason);
      evidenceStatus = "unavailable";
      action = candidate.actionHint === "claim" ? "occupy" : "reserve";
    } else if (candidate.actionHint !== "claim" && isOwnReservationDueForRenewal(input, candidate.controller)) {
      evidence.push("own reservation needs renewal");
      action = "reserve";
    } else if (candidate.ignoreOwnHealthyReservation !== true && isOwnHealthyReservation(input, candidate.controller)) {
      evidence.push("own reservation is healthy");
      evidenceStatus = "unavailable";
      action = candidate.actionHint === "claim" ? "occupy" : "reserve";
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
    ...candidate.roadDistance !== void 0 ? { roadDistance: candidate.roadDistance } : {},
    ...candidate.controllerId ? { controllerId: candidate.controllerId } : {},
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...candidate.sourceCount !== void 0 ? { sourceCount: candidate.sourceCount } : {},
    ...candidate.hostileCreepCount !== void 0 ? { hostileCreepCount: candidate.hostileCreepCount } : {},
    ...candidate.hostileStructureCount !== void 0 ? { hostileStructureCount: candidate.hostileStructureCount } : {}
  };
}
function buildOccupationRecommendationFollowUpIntent(colonyName, next) {
  if (!next) {
    return null;
  }
  return {
    colony: colonyName,
    targetRoom: next.roomName,
    action: getTerritoryIntentAction(next.action),
    ...next.controllerId ? { controllerId: next.controllerId } : {},
    ...next.requiresControllerPressure ? { requiresControllerPressure: true } : {}
  };
}
function getTerritoryIntentAction(action) {
  return action === "occupy" ? "claim" : action;
}
function calculateOccupationScore(input, candidate, action, evidenceStatus) {
  var _a, _b, _c, _d, _e;
  const roadDistance = getCandidateRoadDistance(candidate);
  const roadDistanceScore = typeof roadDistance === "number" ? ROAD_DISTANCE_BASE_SCORE - roadDistance * ROAD_DISTANCE_ROOM_COST_SCORE : 0;
  const sourceScore = typeof candidate.sourceCount === "number" ? Math.min(candidate.sourceCount, 2) * 70 : 0;
  const supportScore = Math.min((_a = candidate.ownedStructureCount) != null ? _a : 0, 3) * 8 + Math.min((_b = candidate.constructionSiteCount) != null ? _b : 0, 3) * 5;
  const sourcePriorityScore = candidate.source === "configured" ? 50 : 25;
  const adjacencyScore = candidate.adjacent ? 25 : 0;
  const readinessScore = Math.min(input.workerCount, MIN_READY_WORKERS) * 12 + (input.energyCapacityAvailable >= TERRITORY_BODY_ENERGY_CAPACITY ? 30 : 0) + (((_c = input.controllerLevel) != null ? _c : 0) >= 2 ? 30 : 0) + (input.ticksToDowngrade === void 0 || input.ticksToDowngrade > DOWNGRADE_GUARD_TICKS ? 20 : 0);
  const riskPenalty = ((_d = candidate.hostileCreepCount) != null ? _d : 0) * 160 + ((_e = candidate.hostileStructureCount) != null ? _e : 0) * 120;
  const controllerPressurePenalty = candidate.controller && isForeignReservation(input, candidate.controller) ? 180 : 0;
  const evidencePenalty = evidenceStatus === "insufficient-evidence" ? 260 : 0;
  const unavailablePenalty = evidenceStatus === "unavailable" ? 2e3 : 0;
  return ACTION_SCORE[action] + sourcePriorityScore + adjacencyScore + roadDistanceScore + sourceScore + supportScore + readinessScore - riskPenalty - controllerPressurePenalty - evidencePenalty - unavailablePenalty;
}
function getCandidateRoadDistance(candidate) {
  var _a;
  return (_a = candidate.roadDistance) != null ? _a : typeof candidate.routeDistance === "number" ? candidate.routeDistance : void 0;
}
function getControllerPressureEvidence(input, candidate) {
  if (candidate.source !== "configured" || !isTerritoryControlAction(candidate.actionHint) || !candidate.controller || !isForeignReservation(input, candidate.controller)) {
    return null;
  }
  return "foreign reservation can be pressured";
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
function getControllerUnavailableReason(input, candidate) {
  const controller = candidate.controller;
  if (!controller) {
    return null;
  }
  if (isControllerOwnedByColony(input, controller)) {
    return "controller already owned by colony account";
  }
  if (controller.ownerUsername) {
    return "controller owned by another account";
  }
  if (candidate.actionHint !== "claim" && controller.reservationUsername && controller.reservationUsername !== input.colonyOwnerUsername) {
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
function isForeignReservation(input, controller) {
  return input.colonyOwnerUsername !== void 0 && controller.my !== true && controller.ownerUsername === void 0 && controller.reservationUsername !== void 0 && controller.reservationUsername !== input.colonyOwnerUsername;
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
  if (!isRecord3(exits)) {
    return [];
  }
  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const exitRoom = exits[direction];
    return typeof exitRoom === "string" && exitRoom.length > 0 ? [exitRoom] : [];
  });
}
function normalizeTerritoryTarget(rawTarget) {
  if (!isRecord3(rawTarget)) {
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
    ...rawTarget.enabled === false ? { enabled: false } : {},
    ...rawTarget.createdBy === OCCUPATION_RECOMMENDATION_TARGET_CREATOR ? { createdBy: OCCUPATION_RECOMMENDATION_TARGET_CREATOR } : {}
  };
}
function getCachedRouteDistance(fromRoom, targetRoom) {
  var _a;
  const routeDistances = (_a = getTerritoryMemoryRecord()) == null ? void 0 : _a.routeDistances;
  if (!isRecord3(routeDistances)) {
    return void 0;
  }
  const distance = routeDistances[`${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`];
  return typeof distance === "number" || distance === null ? distance : void 0;
}
function getCachedNearestOwnedRoomRouteDistance(fromRoom, targetRoom) {
  const ownedRoomNames = getVisibleOwnedRoomNames(fromRoom);
  let nearestDistance;
  for (const ownedRoomName of ownedRoomNames) {
    const cachedDistance = ownedRoomName === fromRoom ? getCachedRouteDistance(fromRoom, targetRoom) : getCachedRouteDistance(ownedRoomName, targetRoom);
    const distance = cachedDistance === void 0 ? findUncachedRouteDistance(ownedRoomName, targetRoom) : cachedDistance;
    if (typeof distance !== "number") {
      continue;
    }
    nearestDistance = nearestDistance === void 0 ? distance : Math.min(nearestDistance, distance);
  }
  return nearestDistance;
}
function findUncachedRouteDistance(fromRoom, targetRoom) {
  var _a;
  if (fromRoom === targetRoom) {
    return 0;
  }
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (typeof (gameMap == null ? void 0 : gameMap.findRoute) !== "function") {
    return void 0;
  }
  try {
    const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom);
    if (route === getNoPathResultCode2()) {
      return void 0;
    }
    return Array.isArray(route) ? route.length : void 0;
  } catch {
    return void 0;
  }
}
function getNoPathResultCode2() {
  const noPathCode = globalThis.ERR_NO_PATH;
  return typeof noPathCode === "number" ? noPathCode : ERR_NO_PATH_CODE2;
}
function getVisibleOwnedRoomNames(fallbackRoomName) {
  var _a;
  const roomNames = /* @__PURE__ */ new Set([fallbackRoomName]);
  const rooms = getGameRooms();
  if (!rooms) {
    return Array.from(roomNames);
  }
  for (const room of Object.values(rooms)) {
    if (((_a = room == null ? void 0 : room.controller) == null ? void 0 : _a.my) === true && typeof room.name === "string" && room.name.length > 0) {
      roomNames.add(room.name);
    }
  }
  return Array.from(roomNames);
}
function findRoomObjects3(room, constantName) {
  const findConstant = getGlobalNumber3(constantName);
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
function getGlobalNumber3(name) {
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
function getGameTime5() {
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
  if (!isRecord3(memory.territory)) {
    memory.territory = {};
  }
  return memory.territory;
}
function upsertTerritoryIntent(intents, nextIntent) {
  var _a;
  const existingIndex = intents.findIndex((intent) => isSameTerritoryIntent(intent, nextIntent));
  if (existingIndex >= 0) {
    const existingIntent = intents[existingIndex];
    const controllerId = (_a = nextIntent.controllerId) != null ? _a : existingIntent.controllerId;
    const preserveControllerPressure = !nextIntent.requiresControllerPressure && shouldPreservePersistedTerritoryIntentPressureRequirement(existingIntent, controllerId);
    intents[existingIndex] = {
      ...nextIntent,
      ...preserveControllerPressure ? { requiresControllerPressure: true } : {}
    };
    return;
  }
  intents.push(nextIntent);
}
function refreshDeferredTerritoryIntentPressure(existingIntent, followUpIntent) {
  if (followUpIntent.requiresControllerPressure !== true) {
    return;
  }
  existingIntent.requiresControllerPressure = true;
  if (!existingIntent.controllerId && followUpIntent.controllerId) {
    existingIntent.controllerId = followUpIntent.controllerId;
  }
}
function shouldPreservePersistedTerritoryIntentPressureRequirement(intent, controllerId = intent.controllerId) {
  return intent.requiresControllerPressure === true && (isTerritoryControllerPressureVisibilityMissing(intent.targetRoom, intent.action, controllerId) || isVisibleTerritoryControllerPressureAvailable(intent.targetRoom, intent.action, controllerId, intent.colony));
}
function isTerritoryControllerPressureVisibilityMissing(targetRoom, action, controllerId) {
  return isTerritoryControlAction(action) && getVisibleController(targetRoom, controllerId) === null;
}
function isVisibleTerritoryControllerPressureAvailable(targetRoom, action, controllerId, colonyName) {
  if (!isTerritoryControlAction(action)) {
    return false;
  }
  const controller = getVisibleController(targetRoom, controllerId);
  return controller !== null && isForeignVisibleReservation(controller, getVisibleColonyOwnerUsername(colonyName));
}
function isTerritoryControlAction(action) {
  return action === "claim" || action === "reserve";
}
function getVisibleController(targetRoom, controllerId) {
  var _a, _b;
  const game = globalThis.Game;
  const roomController = (_b = (_a = game == null ? void 0 : game.rooms) == null ? void 0 : _a[targetRoom]) == null ? void 0 : _b.controller;
  if (roomController) {
    return roomController;
  }
  const getObjectById3 = game == null ? void 0 : game.getObjectById;
  if (controllerId && typeof getObjectById3 === "function") {
    return getObjectById3.call(game, controllerId);
  }
  return null;
}
function getVisibleColonyOwnerUsername(colonyName) {
  var _a, _b;
  return getControllerOwnerUsername((_b = (_a = getGameRooms()) == null ? void 0 : _a[colonyName]) == null ? void 0 : _b.controller);
}
function isForeignVisibleReservation(controller, colonyOwnerUsername) {
  const reservationUsername = getReservationUsername(controller);
  return colonyOwnerUsername !== void 0 && controller.my !== true && getControllerOwnerUsername(controller) === void 0 && reservationUsername !== void 0 && reservationUsername !== colonyOwnerUsername;
}
function isSameTerritoryIntent(intent, followUpIntent) {
  return intent.colony === followUpIntent.colony && intent.targetRoom === followUpIntent.targetRoom && intent.action === followUpIntent.action;
}
function isTerritorySuppressionFresh(intent, gameTime) {
  return intent.status === "suppressed" && gameTime - intent.updatedAt <= TERRITORY_SUPPRESSION_RETRY_TICKS;
}
function isRecoveredTerritoryFollowUpAttemptCoolingDown(intent, gameTime) {
  return intent.followUp !== void 0 && isFiniteNumber4(intent.lastAttemptAt) && gameTime >= intent.lastAttemptAt && gameTime - intent.lastAttemptAt <= TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS;
}
function isRecoveredTerritoryFollowUpRetryPending(intent) {
  return intent.followUp !== void 0 && intent.status === "suppressed" && isFiniteNumber4(intent.lastAttemptAt);
}
function isRecord3(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString4(value) {
  return typeof value === "string" && value.length > 0;
}
function isFiniteNumber4(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// src/territory/controllerSigning.ts
var OCCUPIED_CONTROLLER_SIGN_TEXT = "by Hermes Screeps Project";
var ERR_NOT_IN_RANGE_CODE2 = -9;
var ERR_TIRED_CODE = -11;
var OK_CODE2 = 0;
function shouldSignOccupiedController(controller) {
  var _a;
  return (controller == null ? void 0 : controller.my) === true && ((_a = controller.sign) == null ? void 0 : _a.text) !== OCCUPIED_CONTROLLER_SIGN_TEXT;
}
function signOccupiedControllerIfNeeded(creep, controller) {
  if (!controller || !shouldSignOccupiedController(controller) || typeof creep.signController !== "function") {
    return "skipped";
  }
  const result = creep.signController(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
  if (result === ERR_NOT_IN_RANGE_CODE2) {
    if (typeof creep.moveTo !== "function") {
      return "blocked";
    }
    const moveResult = creep.moveTo(controller);
    return moveResult === OK_CODE2 || moveResult === ERR_TIRED_CODE ? "moving" : "blocked";
  }
  return result === OK_CODE2 ? "signed" : "skipped";
}

// src/territory/territoryPlanner.ts
var TERRITORY_CLAIMER_ROLE = "claimer";
var TERRITORY_SCOUT_ROLE = "scout";
var TERRITORY_DOWNGRADE_GUARD_TICKS = 5e3;
var GLOBAL_TERRITORY_RESERVATION_TICKS = globalThis.CONTROLLER_RESERVE_MAX;
var GLOBAL_TERRITORY_CLAIM_READY_TICKS = globalThis.TERRITORY_CLAIM_READY_TICKS;
var TERRITORY_RESERVATION_TICKS = typeof GLOBAL_TERRITORY_RESERVATION_TICKS === "number" && GLOBAL_TERRITORY_RESERVATION_TICKS > 0 && Number.isFinite(GLOBAL_TERRITORY_RESERVATION_TICKS) ? Math.floor(GLOBAL_TERRITORY_RESERVATION_TICKS) : 5e3;
var TERRITORY_DEFAULT_CLAIM_READY_TICKS = 10;
var TERRITORY_CLAIM_READY_TICKS = typeof GLOBAL_TERRITORY_CLAIM_READY_TICKS === "number" && Number.isFinite(GLOBAL_TERRITORY_CLAIM_READY_TICKS) && GLOBAL_TERRITORY_CLAIM_READY_TICKS > 0 ? Math.min(Math.floor(GLOBAL_TERRITORY_CLAIM_READY_TICKS), TERRITORY_RESERVATION_TICKS) : TERRITORY_DEFAULT_CLAIM_READY_TICKS;
var TERRITORY_RESERVATION_RENEWAL_TICKS = TERRITORY_RESERVATION_TICKS / 5;
var TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS = Math.min(500, TERRITORY_RESERVATION_RENEWAL_TICKS);
var TERRITORY_RESERVATION_COMFORT_TICKS = TERRITORY_RESERVATION_RENEWAL_TICKS * 2;
var TERRITORY_RESERVATION_PRE_RENEW_SCOUT_ROUTE_TICKS = 50;
var TERRITORY_SUPPRESSION_RETRY_TICKS2 = 1500;
var TERRITORY_HOSTILE_INTENT_SUSPENSION_TICKS = 1500;
var TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS2 = 50;
var TERRITORY_RECOVERED_INTENT_SPAWN_PRIORITY = 1e3;
var TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND = 1;
var TERRITORY_ADJACENT_CONTROLLER_PROGRESS_WORKER_SURPLUS = 0;
var EXIT_DIRECTION_ORDER2 = ["1", "3", "5", "7"];
var MIN_CLAIM_PARTS_FOR_RESERVATION_PROGRESS = 2;
var ERR_NO_PATH_CODE3 = -2;
var TERRITORY_CANDIDATE_PRIORITY_URGENT_RENEWAL = 0;
var TERRITORY_CANDIDATE_PRIORITY_VISIBLE_CLAIM = 1;
var TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE = 2;
var TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_CLAIM = 3;
var TERRITORY_CANDIDATE_PRIORITY_UNKNOWN_RESERVE = 4;
var TERRITORY_CANDIDATE_PRIORITY_SCOUT = 5;
var MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY = TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE;
var TERRITORY_ROUTE_DISTANCE_SEPARATOR2 = ">";
var TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET = 2;
var TERRITORY_SCOUT_BODY_COST = 50;
var OCCUPATION_RECOMMENDATION_TARGET_CREATOR2 = "occupationRecommendation";
var recoveredTerritoryFollowUpRetryMetadata = /* @__PURE__ */ new WeakMap();
function planTerritoryIntent(colony, roleCounts, workerTarget, gameTime, options = {}) {
  if (!isTerritoryHomeSafe(colony, roleCounts, workerTarget)) {
    return null;
  }
  const selection = selectTerritoryTarget(colony, roleCounts, workerTarget, gameTime, options);
  if (!selection) {
    return null;
  }
  const target = selection.target;
  const plan = {
    colony: colony.room.name,
    targetRoom: target.roomName,
    action: selection.intentAction,
    ...target.controllerId ? { controllerId: target.controllerId } : {},
    ...target.createdBy ? { createdBy: target.createdBy } : {},
    ...selection.requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...selection.followUp ? { followUp: selection.followUp } : {}
  };
  if (selection.recoveredFollowUp === true && typeof selection.recoveredFollowUpSuppressedAt === "number") {
    recoveredTerritoryFollowUpRetryMetadata.set(plan, { suppressedAt: selection.recoveredFollowUpSuppressedAt });
  }
  const status = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) > 0 ? "active" : "planned";
  recordTerritoryIntent(
    plan,
    status,
    gameTime,
    selection.commitTarget ? target : null,
    selection.routeDistanceLookupContext
  );
  return plan;
}
function recordRecoveredTerritoryFollowUpRetryCooldown(plan, gameTime = getGameTime6()) {
  if (!plan || !plan.followUp || !isTerritoryControlAction2(plan.action)) {
    return;
  }
  const recoveredFollowUpMetadata = recoveredTerritoryFollowUpRetryMetadata.get(plan);
  if (!recoveredFollowUpMetadata) {
    return;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return;
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIndex = intents.findIndex(
    (intent) => intent.colony === plan.colony && intent.targetRoom === plan.targetRoom && intent.action === plan.action
  );
  if (existingIndex < 0) {
    return;
  }
  const existingIntent = intents[existingIndex];
  intents[existingIndex] = {
    ...existingIntent,
    status: "suppressed",
    updatedAt: recoveredFollowUpMetadata.suppressedAt,
    followUp: plan.followUp,
    lastAttemptAt: gameTime,
    ...plan.requiresControllerPressure ? { requiresControllerPressure: true } : {}
  };
  removeTerritoryFollowUpDemand(territoryMemory, plan.colony, plan.targetRoom, plan.action);
  removeTerritoryFollowUpExecutionHint(territoryMemory, plan.colony, plan.targetRoom, plan.action);
}
function shouldSpawnTerritoryControllerCreep(plan, roleCounts, gameTime = getGameTime6()) {
  if (isKnownDeadZoneRoom(plan.targetRoom)) {
    return false;
  }
  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return false;
  }
  if (isTerritoryIntentSuspended(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return false;
  }
  if (plan.action === "scout" && isVisibleRoomKnown(plan.targetRoom)) {
    return false;
  }
  if (!isVisibleTerritoryIntentActionable(
    plan.targetRoom,
    plan.action,
    plan.controllerId,
    getVisibleColonyOwnerUsername2(plan.colony)
  )) {
    return false;
  }
  if (!isTerritoryIntentPlanSpawnCapable(plan)) {
    return false;
  }
  const activeCoverageCount = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action);
  return activeCoverageCount === 0 || shouldSpawnEmergencyReservationRenewal(plan, activeCoverageCount);
}
function requiresTerritoryControllerPressure(plan) {
  return isTerritoryControlAction2(plan.action) && (plan.requiresControllerPressure === true || isVisibleTerritoryReservePressureAvailable(
    plan.targetRoom,
    plan.action,
    plan.controllerId,
    getVisibleColonyOwnerUsername2(plan.colony)
  ));
}
function isTerritoryIntentPlanSpawnCapable(plan) {
  var _a;
  if (!requiresTerritoryControllerPressure(plan)) {
    return true;
  }
  const energyCapacityAvailable = (_a = getVisibleRoom(plan.colony)) == null ? void 0 : _a.energyCapacityAvailable;
  return typeof energyCapacityAvailable !== "number" || energyCapacityAvailable >= TERRITORY_CONTROLLER_PRESSURE_BODY_COST;
}
function getTerritoryFollowUpPreparationWorkerDemand(plan, gameTime = getGameTime6()) {
  var _a;
  if (!plan || !isTerritoryControlAction2(plan.action)) {
    return 0;
  }
  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return 0;
  }
  if (isTerritoryIntentSuspended(plan.colony, plan.targetRoom, plan.action, gameTime)) {
    return 0;
  }
  if (!isVisibleTerritoryIntentActionable(
    plan.targetRoom,
    plan.action,
    plan.controllerId,
    getVisibleColonyOwnerUsername2(plan.colony)
  )) {
    return 0;
  }
  const demand = getCurrentTerritoryFollowUpDemand(plan, gameTime);
  return (_a = demand == null ? void 0 : demand.workerCount) != null ? _a : 0;
}
function hasActiveTerritoryFollowUpPreparationDemand(colony, gameTime = getGameTime6()) {
  if (!isNonEmptyString5(colony)) {
    return false;
  }
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return false;
  }
  return normalizeTerritoryFollowUpDemands(territoryMemory.demands).some(
    (demand) => demand.updatedAt === gameTime && demand.colony === colony && demand.workerCount > 0
  );
}
function hasPendingTerritoryFollowUpIntent(colony, roleCounts, gameTime = getGameTime6()) {
  if (!isNonEmptyString5(colony)) {
    return false;
  }
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return false;
  }
  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) => intent.colony === colony && intent.followUp !== void 0 && isTerritoryControlAction2(intent.action) && !isTerritoryIntentSuspensionActive(intent, gameTime) && isVisibleTerritoryIntentActionable(
      intent.targetRoom,
      intent.action,
      intent.controllerId,
      getVisibleColonyOwnerUsername2(intent.colony)
    ) && (intent.status === "planned" || isRecoveredTerritoryFollowUpIntent(intent, gameTime) || intent.status === "active" && getTerritoryCreepCountForTarget(roleCounts, intent.targetRoom, intent.action) === 0)
  );
}
function getActiveTerritoryFollowUpExecutionHints(colony = void 0) {
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return [];
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  return getBoundedActiveTerritoryFollowUpExecutionHints(
    normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints),
    intents
  ).filter((hint) => !isNonEmptyString5(colony) || hint.colony === colony);
}
function getTerritoryIntentProgressSummaries(colony, roleCounts) {
  if (!isNonEmptyString5(colony)) {
    return [];
  }
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return [];
  }
  const gameTime = getGameTime6();
  return normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) => isTerritoryIntentProgressVisibleForColony(intent, colony, gameTime)
  ).map((intent) => {
    const activeCreepCount = getTerritoryCreepCountForTarget(roleCounts, intent.targetRoom, intent.action);
    return {
      colony: intent.colony,
      targetRoom: intent.targetRoom,
      action: intent.action,
      status: intent.status,
      updatedAt: intent.updatedAt,
      activeCreepCount,
      adjacentToColony: isRoomAdjacentToColony(intent.colony, intent.targetRoom),
      ...intent.controllerId ? { controllerId: intent.controllerId } : {},
      ...intent.requiresControllerPressure ? { requiresControllerPressure: true } : {},
      ...intent.followUp ? { followUp: intent.followUp } : {}
    };
  }).sort(compareTerritoryIntentProgressSummaries);
}
function getSuspendedTerritoryIntentCountsByRoom(colony, gameTime = getGameTime6()) {
  var _a;
  if (!isNonEmptyString5(colony)) {
    return {};
  }
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return {};
  }
  const countsByRoom = {};
  for (const intent of normalizeTerritoryIntents(territoryMemory.intents)) {
    if (intent.colony !== colony || !isTerritoryIntentSuspensionActive(intent, gameTime)) {
      continue;
    }
    countsByRoom[intent.targetRoom] = ((_a = countsByRoom[intent.targetRoom]) != null ? _a : 0) + 1;
  }
  return countsByRoom;
}
function isTerritoryIntentProgressVisibleForColony(intent, colony, gameTime) {
  return intent.colony === colony && (intent.status === "planned" || intent.status === "active") && !isTerritoryIntentSuspensionActive(intent, gameTime);
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
    return canCreepActOnVisibleReserveController(creep, controller, intent.colony) ? { type: "reserve", targetId: controller.id } : null;
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
  if (!isNonEmptyString5(actorUsername) || !isNonEmptyString5(reservation.username) || reservation.username !== actorUsername || typeof reservation.ticksToEnd !== "number") {
    return false;
  }
  const reservationTicksToEnd = reservation.ticksToEnd;
  return reservationTicksToEnd <= TERRITORY_RESERVATION_COMFORT_TICKS && canRenewReservation(activeClaimParts, reservationTicksToEnd);
}
function canCreepPressureTerritoryController(creep, controller, colony) {
  return getActiveControllerClaimPartCount(creep) >= TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS && isForeignReservedController(controller, getTerritoryActorUsername(creep, colony));
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
  if (!isNonEmptyString5(assignment.targetRoom)) {
    return false;
  }
  if (isVisibleRoomUnsafeForTerritoryControllerWork(assignment.targetRoom)) {
    return false;
  }
  if (assignment.action === "scout") {
    return true;
  }
  if (!isTerritoryControlAction2(assignment.action)) {
    return false;
  }
  if (isNonEmptyString5(colony) && isTerritoryIntentSuppressed(colony, assignment.targetRoom, assignment.action)) {
    return false;
  }
  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  if (!controller) {
    return !isVisibleRoomMissingController(assignment.targetRoom);
  }
  if (assignment.action === "claim" && controller.my === true) {
    return shouldSignOccupiedController(controller);
  }
  const actorUsername = getTerritoryActorUsername(creep, colony);
  const targetState = getTerritoryControllerTargetState(controller, assignment.action, actorUsername);
  const isPressureTarget = isForeignReservedController(controller, actorUsername);
  if (isPressureTarget) {
    return creep === void 0 || canCreepPressureTerritoryController(creep, controller, colony);
  }
  return targetState === "available" || assignment.action === "reserve" && targetState === "satisfied";
}
function isVisibleTerritoryAssignmentComplete(assignment, creep) {
  if (assignment.action !== "claim" || !isNonEmptyString5(assignment.targetRoom)) {
    return false;
  }
  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  return (controller == null ? void 0 : controller.my) === true && !shouldSignOccupiedController(controller);
}
function isVisibleTerritoryAssignmentAwaitingUnsafeSigningRetry(assignment, creep) {
  if (assignment.action !== "claim" || !isNonEmptyString5(assignment.targetRoom)) {
    return false;
  }
  if (!isVisibleRoomUnsafeForTerritoryControllerWork(assignment.targetRoom)) {
    return false;
  }
  const controller = selectVisibleTerritoryAssignmentController(assignment, creep);
  return (controller == null ? void 0 : controller.my) === true && shouldSignOccupiedController(controller);
}
function suppressTerritoryIntent(colony, assignment, gameTime) {
  if (!isNonEmptyString5(colony) || !isNonEmptyString5(assignment.targetRoom) || !isTerritoryIntentAction2(assignment.action)) {
    return;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return;
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const followUp = normalizeTerritoryFollowUp(assignment.followUp);
  const requiresControllerPressure = getPersistedTerritoryIntentPressureRequirement(
    intents,
    colony,
    assignment.targetRoom,
    assignment.action,
    assignment.controllerId
  );
  const suppressedIntent = {
    colony,
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: "suppressed",
    updatedAt: gameTime,
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {},
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...followUp ? { followUp } : {}
  };
  upsertTerritoryIntent2(intents, suppressedIntent);
  removeTerritoryFollowUpDemand(territoryMemory, colony, assignment.targetRoom, assignment.action);
  removeTerritoryFollowUpExecutionHint(territoryMemory, colony, assignment.targetRoom, assignment.action);
}
function suppressSameRoomClaimTerritoryIntents(territoryMemory, intents, colony, targetRoom, gameTime) {
  let hasSuppressedClaimIntent = false;
  for (let i = 0; i < intents.length; i += 1) {
    const intent = intents[i];
    if (intent.colony !== colony || intent.targetRoom !== targetRoom || intent.action !== "claim") {
      continue;
    }
    intents[i] = {
      ...intent,
      status: "suppressed",
      updatedAt: gameTime
    };
    removeTerritoryFollowUpDemand(territoryMemory, colony, targetRoom, "claim");
    removeTerritoryFollowUpExecutionHint(territoryMemory, colony, targetRoom, "claim");
    hasSuppressedClaimIntent = true;
  }
  if (!hasSuppressedClaimIntent) {
    return;
  }
  setTerritoryIntents(territoryMemory, intents);
}
function recordTerritoryReserveFallbackIntent(colony, assignment, gameTime) {
  if (!isNonEmptyString5(colony) || !isNonEmptyString5(assignment.targetRoom) || assignment.action !== "reserve" || isTerritoryIntentSuppressed(colony, assignment.targetRoom, "reserve", gameTime)) {
    return null;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return null;
  }
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  suppressSameRoomClaimTerritoryIntents(territoryMemory, intents, colony, assignment.targetRoom, gameTime);
  const followUp = getTerritoryReserveFallbackFollowUp(assignment, intents, colony, gameTime);
  const requiresControllerPressure = getPersistedTerritoryIntentPressureRequirement(
    intents,
    colony,
    assignment.targetRoom,
    "reserve",
    assignment.controllerId
  );
  const reserveAssignment = {
    targetRoom: assignment.targetRoom,
    action: "reserve",
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {},
    ...followUp ? { followUp } : {}
  };
  const plan = {
    colony,
    targetRoom: assignment.targetRoom,
    action: "reserve",
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {},
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...followUp ? { followUp } : {}
  };
  appendTerritoryTargetIfMissing(territoryMemory, {
    colony,
    roomName: assignment.targetRoom,
    action: "reserve",
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {}
  });
  upsertTerritoryIntent2(intents, {
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    status: "active",
    updatedAt: gameTime,
    ...plan.controllerId ? { controllerId: plan.controllerId } : {},
    ...plan.createdBy ? { createdBy: plan.createdBy } : {},
    ...plan.requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...plan.followUp ? { followUp: plan.followUp } : {}
  });
  recordTerritoryFollowUpDemand(territoryMemory, plan, gameTime);
  recordTerritoryFollowUpExecutionHint(territoryMemory, plan, gameTime);
  return reserveAssignment;
}
function recordAutonomousExpansionClaimReserveFallbackIntent(colony, evaluation, gameTime) {
  if (evaluation.status !== "skipped" || evaluation.reason !== "gclInsufficient" && evaluation.reason !== "controllerCooldown" || !isNonEmptyString5(colony) || !isNonEmptyString5(evaluation.targetRoom) || isTerritoryIntentSuppressed(colony, evaluation.targetRoom, "reserve", gameTime)) {
    return null;
  }
  const targetRoom = evaluation.targetRoom;
  if (!isNonEmptyString5(targetRoom)) {
    return null;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return null;
  }
  const colonyOwnerUsername = getVisibleColonyOwnerUsername2(colony);
  if (!isNonEmptyString5(colonyOwnerUsername)) {
    return null;
  }
  const controller = getVisibleController2(targetRoom, evaluation.controllerId);
  if (!controller || isControllerOwned(controller) || isForeignReservedController(controller, colonyOwnerUsername)) {
    return null;
  }
  if (isOwnReservedController(controller, colonyOwnerUsername)) {
    const reservationTicksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
    if (reservationTicksToEnd === null || reservationTicksToEnd >= TERRITORY_RESERVATION_TICKS) {
      return null;
    }
  }
  updateTerritoryReservationMemory(
    territoryMemory,
    colony,
    targetRoom,
    evaluation.controllerId,
    gameTime,
    getOwnReservationTicksToEnd(controller, colonyOwnerUsername)
  );
  return recordTerritoryReserveFallbackIntent(
    colony,
    {
      targetRoom,
      action: "reserve",
      ...evaluation.controllerId ? { controllerId: evaluation.controllerId } : {}
    },
    gameTime
  );
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
function selectTerritoryTarget(colony, roleCounts, workerTarget, gameTime, options = {}) {
  var _a, _b, _c;
  const colonyName = colony.room.name;
  const colonyOwnerUsername = getControllerOwnerUsername2(colony.room.controller);
  const territoryMemory = getTerritoryMemoryRecord2();
  let intents = normalizeTerritoryIntents(territoryMemory == null ? void 0 : territoryMemory.intents);
  const refreshedHostileSuspensions = refreshHostileTerritoryIntentSuspensions(
    territoryMemory,
    intents,
    colonyName,
    gameTime
  );
  if (refreshedHostileSuspensions.changed) {
    intents = refreshedHostileSuspensions.intents;
  }
  const sanitizedClaimReserveHandoffs = sanitizeSatisfiedClaimReserveHandoffs(
    territoryMemory,
    intents,
    colonyName,
    colonyOwnerUsername
  );
  if (sanitizedClaimReserveHandoffs.changed) {
    intents = sanitizedClaimReserveHandoffs.intents;
  }
  const sanitizedStaleProgress = sanitizeStaleTerritoryProgressIntents(
    territoryMemory,
    intents,
    colonyName,
    colonyOwnerUsername,
    roleCounts,
    gameTime
  );
  if (sanitizedStaleProgress.changed) {
    intents = sanitizedStaleProgress.intents;
  }
  const routeDistanceLookupContext = createRouteDistanceLookupContext();
  refreshTerritoryReservationMemory(territoryMemory, colonyName, colonyOwnerUsername, gameTime);
  const deadZoneSuppression = suppressDeadZoneTerritoryTargets(
    territoryMemory,
    intents,
    colonyName,
    gameTime,
    routeDistanceLookupContext
  );
  if (deadZoneSuppression.changed) {
    intents = deadZoneSuppression.intents;
  }
  refreshTerritoryFollowUpExecutionHints(territoryMemory, intents, routeDistanceLookupContext);
  const hasBlockingConfiguredTarget = hasBlockingConfiguredTerritoryTargetForColony(
    colony,
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
    workerTarget,
    getConfiguredTerritoryCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      roleCounts,
      routeDistanceLookupContext
    )
  );
  const persistedIntentCandidates = applyOccupationRecommendationScores(
    colony,
    roleCounts,
    workerTarget,
    getPersistedTerritoryIntentCandidates(
      colonyName,
      colonyOwnerUsername,
      territoryMemory,
      intents,
      gameTime,
      routeDistanceLookupContext
    )
  );
  const primaryCandidates = getSpawnCapableTerritoryCandidates(
    filterTerritoryCandidatesForPlanningOptions(
      [...persistedIntentCandidates, ...configuredCandidates],
      options
    ),
    colony
  );
  const bestReadyPrimaryCandidate = selectBestScoredTerritoryCandidate(
    getReadyTerritoryCandidates(primaryCandidates, roleCounts, colony)
  );
  if (bestReadyPrimaryCandidate && bestReadyPrimaryCandidate.priority <= MAX_VISIBLE_TERRITORY_CANDIDATE_PRIORITY) {
    const shouldEvaluateAdjacentControllerProgress = shouldEvaluateVisibleAdjacentControllerProgressPreference(
      bestReadyPrimaryCandidate,
      colony,
      roleCounts,
      workerTarget
    );
    const shouldEvaluateAdjacentFollowUp = shouldEvaluateVisibleAdjacentFollowUpPreference(bestReadyPrimaryCandidate);
    if (!shouldEvaluateAdjacentControllerProgress && !shouldEvaluateAdjacentFollowUp) {
      return toSelectedTerritoryTarget(bestReadyPrimaryCandidate, routeDistanceLookupContext);
    }
    const visibleAdjacentControllerProgressCandidates = filterTerritoryCandidatesForPlanningOptions(
      applyOccupationRecommendationScores(
        colony,
        roleCounts,
        workerTarget,
        [
          ...shouldEvaluateAdjacentControllerProgress ? getVisibleAdjacentReserveCandidates(
            colonyName,
            colonyOwnerUsername,
            territoryMemory,
            intents,
            gameTime,
            routeDistanceLookupContext
          ) : [],
          ...shouldEvaluateAdjacentFollowUp ? getVisibleAdjacentFollowUpReserveCandidates(
            colonyName,
            colonyOwnerUsername,
            territoryMemory,
            intents,
            gameTime,
            roleCounts,
            routeDistanceLookupContext
          ) : []
        ]
      ),
      options
    );
    if (visibleAdjacentControllerProgressCandidates.length === 0) {
      return toSelectedTerritoryTarget(bestReadyPrimaryCandidate, routeDistanceLookupContext);
    }
    return toSelectedTerritoryTarget(
      (_a = selectBestScoredTerritoryCandidate(
        getReadyTerritoryCandidates(
          [...primaryCandidates, ...visibleAdjacentControllerProgressCandidates],
          roleCounts,
          colony
        )
      )) != null ? _a : bestReadyPrimaryCandidate,
      routeDistanceLookupContext
    );
  }
  const adjacentCandidates = filterTerritoryCandidatesForPlanningOptions(
    applyOccupationRecommendationScores(colony, roleCounts, workerTarget, [
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
    ]),
    options
  );
  const candidates = getSpawnCapableTerritoryCandidates([...primaryCandidates, ...adjacentCandidates], colony);
  return toSelectedTerritoryTarget(
    (_c = (_b = selectBestScoredTerritoryCandidate(getReadyTerritoryCandidates(candidates, roleCounts, colony))) != null ? _b : selectBestScoredTerritoryCandidate(getActionableTerritoryCandidates(candidates, roleCounts, colony))) != null ? _c : selectBestScoredTerritoryCandidate(candidates),
    routeDistanceLookupContext
  );
}
function filterTerritoryCandidatesForPlanningOptions(candidates, options) {
  if (options.controllerPressureOnly === true) {
    const pressureCandidates = candidates.filter(isControllerPressureCandidate);
    if (pressureCandidates.length > 0 || options.followUpOnly !== true) {
      return pressureCandidates;
    }
  }
  if (options.followUpOnly === true) {
    return candidates.filter(isTerritoryFollowUpControlCandidate);
  }
  return candidates;
}
function isControllerPressureCandidate(candidate) {
  return isTerritoryControlAction2(candidate.intentAction) && candidate.requiresControllerPressure === true;
}
function isTerritoryFollowUpControlCandidate(candidate) {
  return candidate.followUp !== void 0 && isTerritoryControlAction2(candidate.intentAction);
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
function toSelectedTerritoryTarget(candidate, routeDistanceLookupContext) {
  return candidate ? {
    target: candidate.target,
    intentAction: candidate.intentAction,
    commitTarget: candidate.commitTarget,
    ...candidate.requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...candidate.followUp ? { followUp: candidate.followUp } : {},
    ...candidate.recoveredFollowUp ? { recoveredFollowUp: true } : {},
    ...typeof candidate.recoveredFollowUpSuppressedAt === "number" ? { recoveredFollowUpSuppressedAt: candidate.recoveredFollowUpSuppressedAt } : {},
    ...routeDistanceLookupContext ? { routeDistanceLookupContext } : {}
  } : null;
}
function shouldEvaluateVisibleAdjacentControllerProgressPreference(candidate, colony, roleCounts, workerTarget) {
  return candidate.priority === TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE && candidate.target.action === "reserve" && isPrimaryTerritoryCandidateSource(candidate.source) && typeof candidate.routeDistance === "number" && candidate.routeDistance > 1 && isTerritoryHomeReadyForAdjacentControllerProgress(colony, roleCounts, workerTarget);
}
function shouldEvaluateVisibleAdjacentFollowUpPreference(candidate) {
  return candidate.priority === TERRITORY_CANDIDATE_PRIORITY_VISIBLE_RESERVE && candidate.target.action === "reserve";
}
function isTerritoryHomeReadyForAdjacentControllerProgress(colony, roleCounts, workerTarget) {
  return getWorkerCapacity(roleCounts) >= workerTarget + TERRITORY_ADJACENT_CONTROLLER_PROGRESS_WORKER_SURPLUS && colony.energyAvailable >= TERRITORY_CONTROLLER_BODY_COST && colony.energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST && colony.spawns.some((spawn) => spawn.spawning == null);
}
function getReadyTerritoryCandidates(candidates, roleCounts, colony) {
  return withImmediateControllerFollowUpState(candidates, roleCounts).filter(
    (candidate) => candidate.immediateControllerFollowUp === true || isTerritoryCandidateSpawnRequired(candidate, roleCounts) && isTerritoryCandidateSpawnReady(candidate, colony)
  );
}
function getActionableTerritoryCandidates(candidates, roleCounts, colony) {
  return withImmediateControllerFollowUpState(candidates, roleCounts).filter(
    (candidate) => !isTerritoryCandidateSpawnRequired(candidate, roleCounts) || isTerritoryCandidateSpawnReady(candidate, colony)
  );
}
function getSpawnCapableTerritoryCandidates(candidates, colony) {
  return candidates.filter((candidate) => isTerritoryCandidateSpawnCapable(candidate, colony));
}
function withImmediateControllerFollowUpState(candidates, roleCounts) {
  return candidates.map((candidate) => {
    if (!isImmediateControllerFollowUpCandidate(candidate, roleCounts)) {
      return candidate;
    }
    return {
      ...candidate,
      immediateControllerFollowUp: true
    };
  });
}
function isImmediateControllerFollowUpCandidate(candidate, roleCounts) {
  return candidate.followUp !== void 0 && isTerritoryControlAction2(candidate.intentAction) && getTerritoryCreepCountForTarget(roleCounts, candidate.target.roomName, candidate.intentAction) > 0;
}
function isTerritoryCandidateSpawnRequired(candidate, roleCounts) {
  const activeCoverageCount = getTerritoryCreepCountForTarget(
    roleCounts,
    candidate.target.roomName,
    candidate.intentAction
  );
  return activeCoverageCount === 0 || shouldSpawnEmergencyReservationRenewalCandidate(candidate, activeCoverageCount);
}
function isTerritoryCandidateSpawnReady(candidate, colony) {
  const bodyCost = getTerritoryCandidateBodyCost(candidate);
  return colony.energyCapacityAvailable >= bodyCost && colony.energyAvailable >= bodyCost;
}
function isTerritoryIntentActionSpawnReady(colony, action, requiresControllerPressure = false) {
  const bodyCost = getTerritoryIntentActionBodyCost(action, requiresControllerPressure);
  return colony.energyCapacityAvailable >= bodyCost && colony.energyAvailable >= bodyCost;
}
function isTerritoryCandidateSpawnCapable(candidate, colony) {
  return colony.energyCapacityAvailable >= getTerritoryCandidateBodyCost(candidate);
}
function getTerritoryCandidateBodyCost(candidate) {
  return getTerritoryIntentActionBodyCost(
    candidate.intentAction,
    candidate.requiresControllerPressure === true
  );
}
function getTerritoryIntentActionBodyCost(action, requiresControllerPressure = false) {
  if (isTerritoryControlAction2(action) && requiresControllerPressure) {
    return TERRITORY_CONTROLLER_PRESSURE_BODY_COST;
  }
  return action === "scout" ? TERRITORY_SCOUT_BODY_COST : TERRITORY_CONTROLLER_BODY_COST;
}
function shouldSpawnEmergencyReservationRenewalCandidate(candidate, activeCoverageCount) {
  return activeCoverageCount < TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET && candidate.intentAction === "reserve" && typeof candidate.renewalTicksToEnd === "number" && candidate.renewalTicksToEnd <= TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS;
}
function getConfiguredTerritoryCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, roleCounts, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return [];
  }
  return territoryMemory.targets.flatMap((rawTarget, order) => {
    const target = normalizeTerritoryTarget2(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.roomName === colonyName) {
      return [];
    }
    const actionForTarget = getConfiguredTerritoryCandidateAction(target, colonyOwnerUsername, territoryMemory, gameTime);
    const actionableTarget = actionForTarget === target.action ? target : { ...target, action: actionForTarget };
    const ignoreOwnHealthyReservation = actionableTarget.action === "claim";
    const isConfiguredTerritoryTargetActionable = isVisibleTerritoryIntentActionable(
      actionableTarget.roomName,
      actionableTarget.action,
      actionableTarget.controllerId,
      colonyOwnerUsername
    );
    if (isTerritoryTargetSuppressed(actionableTarget, intents, gameTime) || isTerritoryIntentSuspendedForAction(
      intents,
      actionableTarget.colony,
      actionableTarget.roomName,
      actionableTarget.action,
      gameTime
    ) || isClaimTargetDeferredBySameRoomReserveLane(
      actionableTarget,
      intents,
      roleCounts,
      colonyOwnerUsername,
      gameTime
    ) || isKnownDeadZoneRoom(actionableTarget.roomName) || isConfiguredReserveScoutDeferredByReservationDecay(
      actionableTarget,
      territoryMemory,
      gameTime,
      routeDistanceLookupContext
    ) || !isConfiguredTerritoryTargetActionable) {
      return [];
    }
    const persistedFollowUp = getPersistedTerritoryIntentFollowUp(
      intents,
      actionableTarget.colony,
      actionableTarget.roomName,
      actionableTarget.action,
      gameTime,
      actionableTarget.controllerId
    );
    if (persistedFollowUp == null ? void 0 : persistedFollowUp.coolingDown) {
      return [];
    }
    const requiresControllerPressure = (persistedFollowUp == null ? void 0 : persistedFollowUp.requiresControllerPressure) === true || getPersistedTerritoryIntentPressureRequirement(
      intents,
      actionableTarget.colony,
      actionableTarget.roomName,
      actionableTarget.action,
      actionableTarget.controllerId
    );
    const candidate = scoreTerritoryCandidate(
      {
        target: actionableTarget,
        intentAction: actionableTarget.action,
        commitTarget: false,
        ...ignoreOwnHealthyReservation ? { ignoreOwnHealthyReservation: true } : {},
        ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
        ...persistedFollowUp ? { followUp: persistedFollowUp.followUp } : {},
        ...persistedFollowUp ? { persistedFollowUp: true } : {},
        ...(persistedFollowUp == null ? void 0 : persistedFollowUp.recovered) ? { recoveredFollowUp: true } : {},
        ...typeof (persistedFollowUp == null ? void 0 : persistedFollowUp.suppressedAt) === "number" ? { recoveredFollowUpSuppressedAt: persistedFollowUp.suppressedAt } : {}
      },
      "configured",
      order,
      colonyName,
      colonyOwnerUsername,
      routeDistanceLookupContext
    );
    return candidate ? [candidate] : [];
  });
}
function getConfiguredTerritoryCandidateAction(target, colonyOwnerUsername, territoryMemory, gameTime) {
  if (target.action !== "reserve" || !isNonEmptyString5(colonyOwnerUsername)) {
    return target.action;
  }
  const controller = getVisibleController2(target.roomName, target.controllerId);
  const visibleTicksToEnd = controller ? getOwnReservationTicksToEnd(controller, colonyOwnerUsername) : null;
  if (visibleTicksToEnd !== null && visibleTicksToEnd <= TERRITORY_CLAIM_READY_TICKS) {
    return "claim";
  }
  const storedReservation = getStoredTerritoryReservation(territoryMemory, target);
  if (storedReservation === null) {
    return target.action;
  }
  return getEstimatedTerritoryReservationTicksToEnd(storedReservation, gameTime) <= TERRITORY_CLAIM_READY_TICKS ? "claim" : target.action;
}
function getPersistedTerritoryIntentCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, routeDistanceLookupContext) {
  const seenIntentKeys = /* @__PURE__ */ new Set();
  const configuredTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  return intents.flatMap((intent, order) => {
    const recoveredFollowUp = isRecoveredTerritoryFollowUpIntent(intent, gameTime);
    if (intent.colony !== colonyName || intent.targetRoom === colonyName || configuredTargetRooms.has(intent.targetRoom) || isKnownDeadZoneRoom(intent.targetRoom) || isRecoveredTerritoryFollowUpAttemptCoolingDown2(intent, gameTime) || intent.status !== "planned" && intent.status !== "active" && !recoveredFollowUp || !isTerritoryControlAction2(intent.action) || isTerritoryIntentSuspensionActive(intent, gameTime) || isSuppressedTerritoryIntentForAction(intents, colonyName, intent.targetRoom, intent.action, gameTime) || !isVisibleTerritoryIntentActionable(intent.targetRoom, intent.action, intent.controllerId, colonyOwnerUsername)) {
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
    const requiresControllerPressure = shouldPreservePersistedTerritoryIntentPressureRequirement2(intent);
    const candidate = scoreTerritoryCandidate(
      {
        target,
        intentAction: intent.action,
        commitTarget: false,
        ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
        ...intent.followUp ? { followUp: intent.followUp } : {},
        ...intent.followUp ? { persistedFollowUp: true } : {},
        ...recoveredFollowUp ? { recoveredFollowUp: true, recoveredFollowUpSuppressedAt: intent.updatedAt } : {}
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
function hasBlockingConfiguredTerritoryTargetForColony(colony, territoryMemory, colonyName, colonyOwnerUsername, intents, gameTime, roleCounts, routeDistanceLookupContext) {
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
    if (target.enabled === false || target.roomName === colonyName) {
      return true;
    }
    if (isKnownDeadZoneRoom(target.roomName)) {
      return false;
    }
    if (isClaimTargetDeferredBySameRoomReserveLane(target, intents, roleCounts, colonyOwnerUsername, gameTime)) {
      return false;
    }
    if (isTerritoryTargetSuppressed(target, intents, gameTime)) {
      return true;
    }
    if (isRecoveredTerritoryFollowUpAttemptCoolingDownForAction(
      intents,
      colonyName,
      target.roomName,
      target.action,
      gameTime
    )) {
      return false;
    }
    if (getTerritoryCreepCountForTarget(roleCounts, target.roomName, target.action) > 0) {
      return false;
    }
    if (isConfiguredFollowUpTargetBlockedBySpawnReadiness(target, intents, gameTime, colony)) {
      return false;
    }
    if (isVisibleTerritoryReservePressureAvailable(target.roomName, target.action, target.controllerId, colonyOwnerUsername) && colony.energyCapacityAvailable < TERRITORY_CONTROLLER_PRESSURE_BODY_COST) {
      return false;
    }
    return getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "satisfied";
  });
}
function refreshTerritoryReservationMemory(territoryMemory, colonyName, colonyOwnerUsername, gameTime) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return;
  }
  const reservations = normalizeTerritoryReservations(territoryMemory.reservations);
  const activeConfiguredReserveKeys = /* @__PURE__ */ new Set();
  let changed = hasMalformedTerritoryReservationMemory(territoryMemory.reservations, reservations);
  for (const rawTarget of territoryMemory.targets) {
    const target = normalizeTerritoryTarget2(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.action !== "reserve" || target.roomName === colonyName) {
      continue;
    }
    const reservationKey = getTerritoryReservationMemoryKey(target.colony, target.roomName);
    activeConfiguredReserveKeys.add(reservationKey);
    const controller = getVisibleController2(target.roomName, target.controllerId);
    if (!controller) {
      continue;
    }
    const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
    if (ticksToEnd === null) {
      if (reservations[reservationKey]) {
        delete reservations[reservationKey];
        changed = true;
      }
      continue;
    }
    const nextReservation = {
      colony: target.colony,
      roomName: target.roomName,
      ticksToEnd,
      updatedAt: gameTime,
      ...target.controllerId ? { controllerId: target.controllerId } : {}
    };
    if (!isSameTerritoryReservation(reservations[reservationKey], nextReservation)) {
      reservations[reservationKey] = nextReservation;
      changed = true;
    }
  }
  for (const [reservationKey, reservation] of Object.entries(reservations)) {
    if (reservation.colony === colonyName && (!activeConfiguredReserveKeys.has(reservationKey) || getEstimatedTerritoryReservationTicksToEnd(reservation, gameTime) <= 0)) {
      delete reservations[reservationKey];
      changed = true;
    }
  }
  if (changed) {
    setTerritoryReservations(territoryMemory, reservations);
  }
}
function isConfiguredReserveScoutDeferredByReservationDecay(target, territoryMemory, gameTime, routeDistanceLookupContext) {
  if (target.action !== "reserve" || isVisibleRoomKnown(target.roomName)) {
    return false;
  }
  const reservation = getStoredTerritoryReservation(territoryMemory, target);
  if (!reservation) {
    return false;
  }
  return getEstimatedTerritoryReservationTicksToEnd(reservation, gameTime) > getTerritoryReservationPreRenewScoutLeadTicks(
    target.colony,
    target.roomName,
    routeDistanceLookupContext
  );
}
function getStoredTerritoryReservation(territoryMemory, target) {
  if (!territoryMemory) {
    return null;
  }
  const reservation = normalizeTerritoryReservation(
    isRecord4(territoryMemory.reservations) ? territoryMemory.reservations[getTerritoryReservationMemoryKey(target.colony, target.roomName)] : void 0
  );
  if (!reservation || reservation.colony !== target.colony || reservation.roomName !== target.roomName || target.controllerId !== void 0 && reservation.controllerId !== void 0 && reservation.controllerId !== target.controllerId) {
    return null;
  }
  return reservation;
}
function getTerritoryReservationPreRenewScoutLeadTicks(colonyName, targetRoom, routeDistanceLookupContext) {
  const routeDistance = getKnownRouteLength(colonyName, targetRoom, routeDistanceLookupContext);
  return TERRITORY_RESERVATION_RENEWAL_TICKS + (typeof routeDistance === "number" ? routeDistance * TERRITORY_RESERVATION_PRE_RENEW_SCOUT_ROUTE_TICKS * 2 : 0);
}
function normalizeTerritoryReservations(rawReservations) {
  if (!isRecord4(rawReservations)) {
    return {};
  }
  const reservations = {};
  for (const [key, rawReservation] of Object.entries(rawReservations)) {
    const reservation = normalizeTerritoryReservation(rawReservation);
    if (reservation) {
      reservations[key] = reservation;
    }
  }
  return reservations;
}
function normalizeTerritoryReservation(rawReservation) {
  if (!isRecord4(rawReservation)) {
    return null;
  }
  if (!isNonEmptyString5(rawReservation.colony) || !isNonEmptyString5(rawReservation.roomName) || !isFiniteNumber5(rawReservation.ticksToEnd) || !isFiniteNumber5(rawReservation.updatedAt)) {
    return null;
  }
  return {
    colony: rawReservation.colony,
    roomName: rawReservation.roomName,
    ticksToEnd: Math.floor(Math.max(0, rawReservation.ticksToEnd)),
    updatedAt: Math.floor(rawReservation.updatedAt),
    ...typeof rawReservation.controllerId === "string" ? { controllerId: rawReservation.controllerId } : {}
  };
}
function hasMalformedTerritoryReservationMemory(rawReservations, reservations) {
  return isRecord4(rawReservations) && Object.keys(rawReservations).length !== Object.keys(reservations).length;
}
function getTerritoryReservationMemoryKey(colonyName, roomName) {
  return `${colonyName}${TERRITORY_ROUTE_DISTANCE_SEPARATOR2}${roomName}`;
}
function getEstimatedTerritoryReservationTicksToEnd(reservation, gameTime) {
  return Math.max(0, reservation.ticksToEnd - Math.max(0, gameTime - reservation.updatedAt));
}
function isSameTerritoryReservation(left, right) {
  return left !== void 0 && left.colony === right.colony && left.roomName === right.roomName && left.ticksToEnd === right.ticksToEnd && left.updatedAt === right.updatedAt && left.controllerId === right.controllerId;
}
function setTerritoryReservations(territoryMemory, reservations) {
  if (Object.keys(reservations).length > 0) {
    territoryMemory.reservations = reservations;
  } else {
    delete territoryMemory.reservations;
  }
}
function suppressDeadZoneTerritoryTargets(territoryMemory, intents, colonyName, gameTime, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return { intents, changed: false };
  }
  let nextIntents = intents;
  let changed = false;
  for (const rawTarget of territoryMemory.targets) {
    const target = normalizeTerritoryTarget2(rawTarget);
    if (!target || target.enabled === false || target.colony !== colonyName || target.roomName === colonyName) {
      continue;
    }
    const reason = getTerritoryDeadZoneSuppressionReason(
      colonyName,
      target.roomName,
      routeDistanceLookupContext
    );
    if (!reason) {
      const filteredIntents = removeDeadZoneSuppression(nextIntents, target);
      if (filteredIntents.length !== nextIntents.length) {
        nextIntents = filteredIntents;
        territoryMemory.intents = nextIntents;
        changed = true;
      }
      continue;
    }
    territoryMemory.intents = nextIntents;
    upsertTerritoryIntent2(nextIntents, {
      colony: target.colony,
      targetRoom: target.roomName,
      action: target.action,
      status: "suppressed",
      updatedAt: gameTime,
      reason,
      ...target.controllerId ? { controllerId: target.controllerId } : {}
    });
    removeTerritoryFollowUpDemand(territoryMemory, target.colony, target.roomName, target.action);
    removeTerritoryFollowUpExecutionHint(
      territoryMemory,
      target.colony,
      target.roomName,
      target.action
    );
    changed = true;
  }
  return { intents: nextIntents, changed };
}
function getTerritoryDeadZoneSuppressionReason(colonyName, targetRoom, routeDistanceLookupContext) {
  var _a, _b, _c;
  const visibleTargetRoom = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[targetRoom];
  if (visibleTargetRoom) {
    refreshVisibleRoomDeadZoneMemory(visibleTargetRoom);
  }
  if (((_c = getKnownDeadZoneRoom(targetRoom)) == null ? void 0 : _c.reason) === "enemyTower") {
    return "deadZoneTarget";
  }
  return isRouteBlockedByKnownDeadZone(colonyName, targetRoom) && getKnownRouteLength(colonyName, targetRoom, routeDistanceLookupContext) !== null ? "deadZoneRoute" : null;
}
function removeDeadZoneSuppression(intents, target) {
  return intents.filter(
    (intent) => !(intent.colony === target.colony && intent.targetRoom === target.roomName && intent.action === target.action && intent.status === "suppressed" && isDeadZoneTerritorySuppressionReason(intent.reason))
  );
}
function isDeadZoneTerritorySuppressionReason(reason) {
  return reason === "deadZoneTarget" || reason === "deadZoneRoute";
}
function isConfiguredFollowUpTargetBlockedBySpawnReadiness(target, intents, gameTime, colony) {
  const persistedFollowUp = getPersistedTerritoryIntentFollowUp(
    intents,
    target.colony,
    target.roomName,
    target.action,
    gameTime,
    target.controllerId
  );
  return persistedFollowUp !== null && !isTerritoryIntentActionSpawnReady(
    colony,
    target.action,
    persistedFollowUp.requiresControllerPressure === true
  );
}
function isClaimTargetDeferredBySameRoomReserveLane(target, intents, roleCounts, colonyOwnerUsername, gameTime) {
  if (target.action !== "claim") {
    return false;
  }
  const reserveIntent = intents.find(
    (intent) => intent.colony === target.colony && intent.targetRoom === target.roomName && intent.action === "reserve" && (intent.status === "active" || intent.status === "planned") && !isTerritoryIntentSuspensionActive(intent, gameTime)
  );
  if (!reserveIntent) {
    return false;
  }
  if (reserveIntent.followUp === void 0 && getTerritoryCreepCountForTarget(roleCounts, reserveIntent.targetRoom, "reserve") <= 0) {
    return false;
  }
  return getVisibleTerritoryTargetState(target.roomName, "reserve", reserveIntent.controllerId, colonyOwnerUsername) !== "unavailable";
}
function getAdjacentReserveCandidates(colonyName, originRoomName, colonyOwnerUsername, territoryMemory, intents, gameTime, includeScoutCandidates, source, orderOffset, routeDistanceLookupContext) {
  const adjacentRooms = getAdjacentRoomNames2(originRoomName);
  if (adjacentRooms.length === 0) {
    return [];
  }
  const existingTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  return adjacentRooms.flatMap((roomName, order) => {
    const target = { colony: colonyName, roomName, action: "reserve" };
    if (roomName === colonyName || existingTargetRooms.has(roomName) || isKnownDeadZoneRoom(roomName) || isTerritoryTargetSuppressed(target, intents, gameTime) || isTerritoryRoomSuspendedForColony(intents, colonyName, roomName, gameTime) || isRecoveredTerritoryFollowUpAttemptCoolingDownForAction(intents, colonyName, roomName, "reserve", gameTime)) {
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
function getVisibleAdjacentReserveCandidates(colonyName, colonyOwnerUsername, territoryMemory, intents, gameTime, routeDistanceLookupContext) {
  return getAdjacentReserveCandidates(
    colonyName,
    colonyName,
    colonyOwnerUsername,
    territoryMemory,
    intents,
    gameTime,
    false,
    "adjacent",
    0,
    routeDistanceLookupContext
  );
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
    if (!target || target.enabled === false || target.colony !== colonyName || target.action !== "reserve" || target.roomName === colonyName || isKnownDeadZoneRoom(target.roomName) || isTerritoryTargetSuppressed(target, intents, gameTime) || isTerritoryIntentSuspendedForAction(intents, target.colony, target.roomName, target.action, gameTime) || hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext) || !isVisibleRoomKnown(target.roomName) || getTerritoryCreepCountForTarget(roleCounts, target.roomName, target.action) <= 0 || getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "available") {
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
    if (!target || target.enabled === false || target.colony !== colonyName || target.action !== action || target.roomName === colonyName || isKnownDeadZoneRoom(target.roomName) || isTerritoryTargetSuppressed(target, intents, gameTime) || isTerritoryIntentSuspendedForAction(intents, target.colony, target.roomName, target.action, gameTime) || hasKnownNoRoute(colonyName, target.roomName, routeDistanceLookupContext) || getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) !== "satisfied") {
      return [];
    }
    return [{ target, order }];
  });
}
function scoreTerritoryCandidate(selection, source, order, colonyName, colonyOwnerUsername, routeDistanceLookupContext) {
  const knownRouteDistance = getKnownRouteLength(colonyName, selection.target.roomName, routeDistanceLookupContext);
  if (knownRouteDistance === null) {
    return null;
  }
  const routeDistance = knownRouteDistance != null ? knownRouteDistance : getInferredTerritoryRouteDistance(source);
  const roadDistance = getNearestOwnedRoomRouteDistance(
    colonyName,
    selection.target.roomName,
    routeDistance,
    routeDistanceLookupContext
  );
  const renewalTicksToEnd = getConfiguredReserveRenewalTicksToEnd(selection.target, colonyOwnerUsername);
  const occupationActionableTicks = source === "occupationIntent" ? getOccupationIntentActionableTicks(selection, colonyOwnerUsername) : void 0;
  const requiresControllerPressure = selection.requiresControllerPressure === true || isVisibleTerritoryReservePressureAvailable(
    selection.target.roomName,
    selection.intentAction,
    selection.target.controllerId,
    colonyOwnerUsername
  );
  return {
    ...selection,
    source,
    order,
    priority: getTerritoryCandidatePriority(selection, renewalTicksToEnd),
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...routeDistance !== void 0 ? { routeDistance } : {},
    ...roadDistance !== void 0 ? { roadDistance } : {},
    ...renewalTicksToEnd !== null ? { renewalTicksToEnd } : {},
    ...occupationActionableTicks !== void 0 ? { occupationActionableTicks } : {}
  };
}
function getInferredTerritoryRouteDistance(source) {
  return source === "adjacent" ? 1 : void 0;
}
function applyOccupationRecommendationScores(colony, roleCounts, workerTarget, candidates) {
  var _a;
  const colonyOwnerUsername = (_a = getControllerOwnerUsername2(colony.room.controller)) != null ? _a : void 0;
  const adjacentControllerProgressReady = isTerritoryHomeReadyForAdjacentControllerProgress(
    colony,
    roleCounts,
    workerTarget
  );
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
    return [
      applyOccupationRecommendationScore(
        candidate,
        recommendation,
        roleCounts,
        adjacentControllerProgressReady
      )
    ];
  });
}
function applyOccupationRecommendationScore(candidate, recommendation, roleCounts, adjacentControllerProgressReady) {
  var _a;
  const intentAction = getRecommendedTerritoryIntentAction(candidate, recommendation, roleCounts);
  const requiresControllerPressure = isTerritoryControlAction2(intentAction) && candidate.requiresControllerPressure === true;
  const nextSelection = {
    target: candidate.target,
    intentAction,
    commitTarget: recommendation.evidenceStatus === "sufficient" && intentAction !== "scout" && candidate.commitTarget,
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...candidate.followUp ? { followUp: candidate.followUp } : {}
  };
  const renewalTicksToEnd = intentAction === "reserve" ? (_a = candidate.renewalTicksToEnd) != null ? _a : null : null;
  const { requiresControllerPressure: _requiresControllerPressure, ...candidateWithoutPressure } = candidate;
  const safeAdjacentControllerProgress = isSafeAdjacentControllerProgressCandidate(
    candidate,
    recommendation,
    intentAction,
    adjacentControllerProgressReady
  );
  return {
    ...candidateWithoutPressure,
    intentAction,
    commitTarget: nextSelection.commitTarget,
    priority: getTerritoryCandidatePriority(nextSelection, renewalTicksToEnd),
    recommendationScore: getTerritoryCandidateRecommendationScore(candidate, recommendation),
    recommendationEvidenceStatus: recommendation.evidenceStatus,
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...safeAdjacentControllerProgress ? { safeAdjacentControllerProgress: true } : {},
    ...renewalTicksToEnd !== null ? { renewalTicksToEnd } : {}
  };
}
function getTerritoryCandidateRecommendationScore(candidate, recommendation) {
  return recommendation.score + (candidate.recoveredFollowUp === true ? TERRITORY_RECOVERED_INTENT_SPAWN_PRIORITY : 0);
}
function isSafeAdjacentControllerProgressCandidate(candidate, recommendation, intentAction, adjacentControllerProgressReady) {
  return adjacentControllerProgressReady && candidate.source === "adjacent" && candidate.target.action === "reserve" && intentAction === "reserve" && candidate.commitTarget === true && candidate.routeDistance === 1 && recommendation.evidenceStatus === "sufficient" && isTerritoryTargetVisible(candidate.target);
}
function getRecommendedTerritoryIntentAction(candidate, recommendation, roleCounts) {
  if (candidate.source === "occupationIntent" && isPersistedControllerFollowUpCandidate(candidate)) {
    return candidate.intentAction;
  }
  if (recommendation.evidenceStatus === "insufficient-evidence") {
    if (isRecoveredTerritoryFollowUpControlCandidate(candidate)) {
      return candidate.intentAction;
    }
    if (isTerritoryControlAction2(candidate.intentAction) && candidate.requiresControllerPressure === true) {
      return candidate.intentAction;
    }
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
function isRecoveredTerritoryFollowUpControlCandidate(candidate) {
  return candidate.recoveredFollowUp === true && candidate.followUp !== void 0 && isTerritoryControlAction2(candidate.intentAction);
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
    ...candidate.roadDistance !== void 0 ? { roadDistance: candidate.roadDistance } : {},
    ...candidate.ignoreOwnHealthyReservation === true ? { ignoreOwnHealthyReservation: true } : {},
    ...room ? buildVisibleOccupationRecommendationEvidence(room, candidate.target.controllerId) : {}
  };
}
function buildVisibleOccupationRecommendationEvidence(room, controllerId) {
  const controller = getVisibleController2(room.name, controllerId);
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
  return isNonEmptyString5(username) ? username : void 0;
}
function getControllerReservationTicksToEnd(controller) {
  var _a;
  const ticksToEnd = (_a = controller.reservation) == null ? void 0 : _a.ticksToEnd;
  return typeof ticksToEnd === "number" ? ticksToEnd : void 0;
}
function getOccupationIntentActionableTicks(selection, colonyOwnerUsername) {
  var _a, _b;
  if (!isTerritoryControlAction2(selection.intentAction)) {
    return void 0;
  }
  const controller = getVisibleController2(selection.target.roomName, selection.target.controllerId);
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
  return left.priority - right.priority || compareOptionalNumbers2(left.renewalTicksToEnd, right.renewalTicksToEnd) || compareVisibleAdjacentFollowUpPreference(left, right) || compareSafeAdjacentControllerProgressPreference(left, right) || compareImmediateControllerFollowUpPreference(left, right) || comparePersistedControllerFollowUpPreference(left, right) || getTerritoryCandidateSourcePriority(left.source) - getTerritoryCandidateSourcePriority(right.source) || compareOptionalNumbersDescending(left.recommendationScore, right.recommendationScore) || compareOptionalNumbers2(left.occupationActionableTicks, right.occupationActionableTicks) || compareRecoveredFollowUpPreference(left, right) || left.order - right.order || left.target.roomName.localeCompare(right.target.roomName) || left.intentAction.localeCompare(right.intentAction);
}
function compareImmediateControllerFollowUpPreference(left, right) {
  const leftImmediate = left.immediateControllerFollowUp === true;
  const rightImmediate = right.immediateControllerFollowUp === true;
  if (leftImmediate === rightImmediate) {
    return 0;
  }
  return leftImmediate ? -1 : 1;
}
function comparePersistedControllerFollowUpPreference(left, right) {
  const leftPersisted = isPersistedControllerFollowUpCandidate(left);
  const rightPersisted = isPersistedControllerFollowUpCandidate(right);
  if (leftPersisted === rightPersisted) {
    return 0;
  }
  return leftPersisted ? -1 : 1;
}
function isPersistedControllerFollowUpCandidate(candidate) {
  return candidate.persistedFollowUp === true && candidate.followUp !== void 0 && isTerritoryControlAction2(candidate.intentAction);
}
function compareRecoveredFollowUpPreference(left, right) {
  if (left.recoveredFollowUp === right.recoveredFollowUp) {
    return 0;
  }
  return left.recoveredFollowUp ? -1 : 1;
}
function compareVisibleAdjacentFollowUpPreference(left, right) {
  if (shouldPreferVisibleAdjacentFollowUp(left, right)) {
    return -1;
  }
  return shouldPreferVisibleAdjacentFollowUp(right, left) ? 1 : 0;
}
function compareSafeAdjacentControllerProgressPreference(left, right) {
  if (shouldPreferSafeAdjacentControllerProgress(left, right)) {
    return -1;
  }
  return shouldPreferSafeAdjacentControllerProgress(right, left) ? 1 : 0;
}
function shouldPreferSafeAdjacentControllerProgress(candidate, other) {
  return candidate.safeAdjacentControllerProgress === true && isLowerConfidenceDistantSameActionCandidate(other, candidate);
}
function shouldPreferVisibleAdjacentFollowUp(candidate, other) {
  return isVisibleAdjacentControllerFollowUpCandidate(candidate) && isLowerConfidenceDistantSameActionCandidate(other, candidate);
}
function isVisibleAdjacentControllerFollowUpCandidate(candidate) {
  return isTerritoryFollowUpSource2(candidate.source) && candidate.intentAction === candidate.target.action && isTerritoryControlAction2(candidate.intentAction) && candidate.recommendationEvidenceStatus === "sufficient" && isTerritoryTargetVisible(candidate.target);
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
  if (originAction === null || !isTerritoryFollowUpSource2(source) || !isNonEmptyString5(originRoom)) {
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
  return isVisibleRoomKnown(target.roomName) || getVisibleController2(target.roomName, target.controllerId) !== null;
}
function createRouteDistanceLookupContext() {
  return { revalidatedNoRouteCacheKeys: /* @__PURE__ */ new Set() };
}
function hasKnownNoRoute(fromRoom, targetRoom, routeDistanceLookupContext) {
  return getKnownRouteLength(fromRoom, targetRoom, routeDistanceLookupContext) === null;
}
function getNearestOwnedRoomRouteDistance(colonyName, targetRoom, fallbackRouteDistance, routeDistanceLookupContext) {
  let nearestDistance = fallbackRouteDistance;
  for (const ownedRoomName of getVisibleOwnedRoomNames2(colonyName)) {
    const routeDistance = ownedRoomName === colonyName ? fallbackRouteDistance : getKnownRouteLength(ownedRoomName, targetRoom, routeDistanceLookupContext);
    if (typeof routeDistance !== "number") {
      continue;
    }
    nearestDistance = nearestDistance === void 0 ? routeDistance : Math.min(nearestDistance, routeDistance);
  }
  return nearestDistance;
}
function getVisibleOwnedRoomNames2(fallbackRoomName) {
  var _a, _b;
  const roomNames = /* @__PURE__ */ new Set([fallbackRoomName]);
  const rooms = (_a = globalThis.Game) == null ? void 0 : _a.rooms;
  if (!rooms) {
    return Array.from(roomNames);
  }
  for (const room of Object.values(rooms)) {
    if (((_b = room == null ? void 0 : room.controller) == null ? void 0 : _b.my) === true && isNonEmptyString5(room.name)) {
      roomNames.add(room.name);
    }
  }
  return Array.from(roomNames);
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
  if (route === getNoPathResultCode3()) {
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
  if (!isRecord4(territoryMemory.routeDistances)) {
    territoryMemory.routeDistances = {};
  }
  return territoryMemory.routeDistances;
}
function getTerritoryRouteDistanceCacheKey(fromRoom, targetRoom) {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR2}${targetRoom}`;
}
function getNoPathResultCode3() {
  const noPathCode = globalThis.ERR_NO_PATH;
  return typeof noPathCode === "number" ? noPathCode : ERR_NO_PATH_CODE3;
}
function getAdjacentReserveCandidateState(targetRoom, colonyOwnerUsername) {
  if (isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom)) {
    return "unavailable";
  }
  if (isVisibleRoomMissingController(targetRoom)) {
    return "unavailable";
  }
  const controller = getVisibleController2(targetRoom);
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
function appendTerritoryTargetIfMissing(territoryMemory, target) {
  if (Array.isArray(territoryMemory.targets) && territoryMemory.targets.some((rawTarget) => {
    const existingTarget = normalizeTerritoryTarget2(rawTarget);
    return (existingTarget == null ? void 0 : existingTarget.colony) === target.colony && existingTarget.roomName === target.roomName && existingTarget.action === target.action;
  })) {
    return;
  }
  appendTerritoryTarget(territoryMemory, target);
}
function getAdjacentRoomNames2(roomName) {
  const game = globalThis.Game;
  const gameMap = game == null ? void 0 : game.map;
  if (!gameMap || typeof gameMap.describeExits !== "function") {
    return [];
  }
  const exits = gameMap.describeExits(roomName);
  if (!isRecord4(exits)) {
    return [];
  }
  return EXIT_DIRECTION_ORDER2.flatMap((direction) => {
    const exitRoom = exits[direction];
    return isNonEmptyString5(exitRoom) ? [exitRoom] : [];
  });
}
function isRoomAdjacentToColony(colonyName, targetRoom) {
  return getAdjacentRoomNames2(colonyName).includes(targetRoom);
}
function normalizeTerritoryTarget2(rawTarget) {
  if (!isRecord4(rawTarget)) {
    return null;
  }
  if (!isNonEmptyString5(rawTarget.colony) || !isNonEmptyString5(rawTarget.roomName) || !isTerritoryControlAction2(rawTarget.action)) {
    return null;
  }
  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action: rawTarget.action,
    ...typeof rawTarget.controllerId === "string" ? { controllerId: rawTarget.controllerId } : {},
    ...rawTarget.enabled === false ? { enabled: false } : {},
    ...isTerritoryAutomationSource2(rawTarget.createdBy) ? { createdBy: rawTarget.createdBy } : {}
  };
}
function isTerritoryAutomationSource2(source) {
  return source === OCCUPATION_RECOMMENDATION_TARGET_CREATOR2 || source === "autonomousExpansionClaim" || source === "nextExpansionScoring";
}
function recordTerritoryIntent(plan, status, gameTime, seededTarget = null, routeDistanceLookupContext = createRouteDistanceLookupContext()) {
  const territoryMemory = getWritableTerritoryMemoryRecord2();
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
    ...plan.createdBy ? { createdBy: plan.createdBy } : {},
    ...plan.controllerId ? { controllerId: plan.controllerId } : {},
    ...plan.requiresControllerPressure ? { requiresControllerPressure: true } : {},
    ...plan.followUp ? { followUp: plan.followUp } : {}
  };
  upsertTerritoryIntent2(intents, nextIntent);
  recordTerritoryFollowUpDemand(territoryMemory, plan, gameTime);
  recordTerritoryFollowUpExecutionHint(territoryMemory, plan, gameTime, routeDistanceLookupContext);
}
function upsertTerritoryIntent2(intents, nextIntent) {
  var _a, _b;
  const existingIndex = findTerritoryIntentIndex(intents, nextIntent);
  if (existingIndex >= 0) {
    const existingIntent = intents[existingIndex];
    const controllerId = (_a = nextIntent.controllerId) != null ? _a : existingIntent.controllerId;
    const createdBy = (_b = nextIntent.createdBy) != null ? _b : existingIntent.createdBy;
    const requiresControllerPressure2 = shouldRecordTerritoryIntentControllerPressure(
      nextIntent,
      controllerId,
      existingIntent
    );
    intents[existingIndex] = {
      ...nextIntent,
      ...createdBy ? { createdBy } : {},
      ...requiresControllerPressure2 ? { requiresControllerPressure: true } : {},
      ...!nextIntent.followUp && existingIntent.followUp ? { followUp: existingIntent.followUp } : {}
    };
    return;
  }
  const requiresControllerPressure = shouldRecordTerritoryIntentControllerPressure(
    nextIntent,
    nextIntent.controllerId
  );
  intents.push({
    ...nextIntent,
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {}
  });
}
function findTerritoryIntentIndex(intents, nextIntent) {
  if (nextIntent.createdBy) {
    return intents.findIndex(
      (intent) => isSameTerritoryIntentRecord(intent, nextIntent) && intent.createdBy === nextIntent.createdBy
    );
  }
  const unownedIntentIndex = intents.findIndex(
    (intent) => isSameTerritoryIntentRecord(intent, nextIntent) && intent.createdBy === void 0
  );
  if (unownedIntentIndex >= 0) {
    return unownedIntentIndex;
  }
  return intents.findIndex((intent) => isSameTerritoryIntentRecord(intent, nextIntent));
}
function isSameTerritoryIntentRecord(intent, nextIntent) {
  return intent.colony === nextIntent.colony && intent.targetRoom === nextIntent.targetRoom && intent.action === nextIntent.action;
}
function shouldRecordTerritoryIntentControllerPressure(nextIntent, controllerId, existingIntent) {
  return nextIntent.requiresControllerPressure === true || isVisibleTerritoryReservePressureAvailable(
    nextIntent.targetRoom,
    nextIntent.action,
    controllerId,
    getVisibleColonyOwnerUsername2(nextIntent.colony)
  ) || existingIntent !== void 0 && shouldPreservePersistedTerritoryIntentPressureRequirement2(existingIntent, controllerId);
}
function refreshHostileTerritoryIntentSuspensions(territoryMemory, intents, colonyName, gameTime) {
  if (!territoryMemory || intents.length === 0) {
    return { intents, changed: false };
  }
  let changed = false;
  const suspendedIntents = [];
  const refreshedIntents = intents.map((intent) => {
    var _a, _b;
    if (intent.colony !== colonyName || !isTerritoryControlAction2(intent.action)) {
      return intent;
    }
    const hostileCount = getVisibleHostileCreepCount(intent.targetRoom);
    if (hostileCount !== null && hostileCount > 0) {
      if (((_a = intent.suspended) == null ? void 0 : _a.reason) === "hostile_presence") {
        if (isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime)) {
          suspendedIntents.push(intent);
          return intent;
        }
      }
      const suspended = buildHostilePresenceTerritoryIntentSuspension(hostileCount, gameTime);
      changed = true;
      const suspendedIntent = {
        ...intent,
        suspended
      };
      suspendedIntents.push(suspendedIntent);
      return suspendedIntent;
    }
    if (((_b = intent.suspended) == null ? void 0 : _b.reason) === "hostile_presence" && (hostileCount === 0 || !isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime))) {
      changed = true;
      return withoutTerritoryIntentSuspension(intent);
    }
    return intent;
  });
  if (!changed) {
    return { intents, changed: false };
  }
  setTerritoryIntents(territoryMemory, refreshedIntents);
  for (const intent of suspendedIntents) {
    removeTerritoryFollowUpDemand(territoryMemory, intent.colony, intent.targetRoom, intent.action);
    removeTerritoryFollowUpExecutionHint(
      territoryMemory,
      intent.colony,
      intent.targetRoom,
      intent.action
    );
  }
  return { intents: refreshedIntents, changed: true };
}
function sanitizeSatisfiedClaimReserveHandoffs(territoryMemory, intents, colonyName, colonyOwnerUsername) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return { intents, changed: false };
  }
  const satisfiedClaimRooms = getSatisfiedConfiguredClaimRoomNames(
    territoryMemory.targets,
    colonyName,
    colonyOwnerUsername
  );
  if (satisfiedClaimRooms.size === 0) {
    return { intents, changed: false };
  }
  const nextTargets = territoryMemory.targets.filter((rawTarget) => {
    const target = normalizeTerritoryTarget2(rawTarget);
    return !((target == null ? void 0 : target.colony) === colonyName && target.action === "reserve" && satisfiedClaimRooms.has(target.roomName));
  });
  const nextIntents = intents.filter(
    (intent) => !(intent.colony === colonyName && intent.action === "reserve" && satisfiedClaimRooms.has(intent.targetRoom))
  );
  const changed = nextTargets.length !== territoryMemory.targets.length || nextIntents.length !== intents.length;
  if (!changed) {
    return { intents, changed: false };
  }
  territoryMemory.targets = nextTargets;
  territoryMemory.intents = nextIntents;
  for (const targetRoom of satisfiedClaimRooms) {
    removeTerritoryFollowUpDemand(territoryMemory, colonyName, targetRoom, "reserve");
    removeTerritoryFollowUpExecutionHint(territoryMemory, colonyName, targetRoom, "reserve");
  }
  return { intents: nextIntents, changed: true };
}
function getSatisfiedConfiguredClaimRoomNames(rawTargets, colonyName, colonyOwnerUsername) {
  const satisfiedClaimRooms = /* @__PURE__ */ new Set();
  for (const rawTarget of rawTargets) {
    const target = normalizeTerritoryTarget2(rawTarget);
    if ((target == null ? void 0 : target.colony) === colonyName && target.action === "claim" && getVisibleTerritoryTargetState(target.roomName, target.action, target.controllerId, colonyOwnerUsername) === "satisfied") {
      satisfiedClaimRooms.add(target.roomName);
    }
  }
  return satisfiedClaimRooms;
}
function sanitizeStaleTerritoryProgressIntents(territoryMemory, intents, colonyName, colonyOwnerUsername, roleCounts, gameTime) {
  const staleIntents = [];
  const sanitizedIntents = intents.filter((intent) => {
    if (!isStaleTerritoryProgressIntent(intent, colonyName, colonyOwnerUsername, roleCounts, gameTime)) {
      return true;
    }
    staleIntents.push(intent);
    return false;
  });
  if (staleIntents.length === 0) {
    return { intents, changed: false };
  }
  if (territoryMemory) {
    setTerritoryIntents(territoryMemory, sanitizedIntents);
    for (const staleIntent of staleIntents) {
      removeStaleTerritoryProgressIntentState(territoryMemory, staleIntent);
    }
  }
  return { intents: sanitizedIntents, changed: true };
}
function isStaleTerritoryProgressIntent(intent, colonyName, colonyOwnerUsername, roleCounts, gameTime) {
  if (intent.colony !== colonyName) {
    return false;
  }
  if (isTerritoryIntentSuspensionActive(intent, gameTime)) {
    return false;
  }
  if (intent.action === "scout") {
    return isVisibleRoomKnown(intent.targetRoom);
  }
  if (intent.followUp === void 0 || !isTerritoryControlAction2(intent.action) || intent.status === "suppressed") {
    return false;
  }
  if (intent.status === "active" && getTerritoryCreepCountForTarget(roleCounts, intent.targetRoom, intent.action) > 0) {
    return false;
  }
  return !isVisibleTerritoryIntentActionable(
    intent.targetRoom,
    intent.action,
    intent.controllerId,
    colonyOwnerUsername
  );
}
function getVisibleTerritoryControllerEvidenceState(targetRoom, action, controllerId, colonyOwnerUsername) {
  if (isVisibleRoomMissingController(targetRoom)) {
    return "unavailable";
  }
  const controller = getVisibleController2(targetRoom, controllerId);
  if (!controller) {
    return null;
  }
  return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername);
}
function removeStaleTerritoryProgressIntentState(territoryMemory, intent) {
  if (isTerritoryControlAction2(intent.action)) {
    removeTerritoryFollowUpDemand(territoryMemory, intent.colony, intent.targetRoom, intent.action);
  }
  removeTerritoryFollowUpExecutionHint(territoryMemory, intent.colony, intent.targetRoom, intent.action);
}
function setTerritoryIntents(territoryMemory, intents) {
  if (intents.length > 0) {
    territoryMemory.intents = intents;
  } else {
    delete territoryMemory.intents;
  }
}
function shouldPreservePersistedTerritoryIntentPressureRequirement2(intent, controllerId = intent.controllerId) {
  return intent.requiresControllerPressure === true && isTerritoryControllerPressureVisibilityMissing2(intent.targetRoom, intent.action, controllerId);
}
function isTerritoryControllerPressureVisibilityMissing2(targetRoom, action, controllerId) {
  return isTerritoryControlAction2(action) && getVisibleController2(targetRoom, controllerId) === null;
}
function getPersistedTerritoryIntentPressureRequirement(intents, colony, targetRoom, action, controllerId) {
  if (!isTerritoryControllerPressureVisibilityMissing2(targetRoom, action, controllerId)) {
    return false;
  }
  return intents.some(
    (intent) => intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action && intent.requiresControllerPressure === true
  );
}
function getPersistedTerritoryIntentFollowUp(intents, colony, targetRoom, action, gameTime, controllerId) {
  let selectedIntent = null;
  for (const intent of intents) {
    if (intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action && intent.followUp && (!selectedIntent || intent.updatedAt > selectedIntent.updatedAt)) {
      selectedIntent = intent;
    }
  }
  if (!(selectedIntent == null ? void 0 : selectedIntent.followUp)) {
    return null;
  }
  return {
    followUp: selectedIntent.followUp,
    recovered: isRecoveredTerritoryFollowUpIntent(selectedIntent, gameTime),
    coolingDown: isRecoveredTerritoryFollowUpAttemptCoolingDown2(selectedIntent, gameTime),
    ...selectedIntent.status === "suppressed" ? { suppressedAt: selectedIntent.updatedAt } : {},
    ...shouldPreservePersistedTerritoryIntentPressureRequirement2(selectedIntent, controllerId) ? { requiresControllerPressure: true } : {}
  };
}
function getTerritoryReserveFallbackFollowUp(assignment, intents, colony, gameTime) {
  var _a, _b, _c;
  const assignmentFollowUp = normalizeTerritoryFollowUp(assignment.followUp);
  if (assignmentFollowUp) {
    return assignmentFollowUp;
  }
  const persistedReserveFollowUp = (_a = getPersistedTerritoryIntentFollowUp(
    intents,
    colony,
    assignment.targetRoom,
    "reserve",
    gameTime,
    assignment.controllerId
  )) == null ? void 0 : _a.followUp;
  if (persistedReserveFollowUp) {
    return persistedReserveFollowUp;
  }
  return (_c = (_b = getPersistedTerritoryIntentFollowUp(
    intents,
    colony,
    assignment.targetRoom,
    "claim",
    gameTime,
    assignment.controllerId
  )) == null ? void 0 : _b.followUp) != null ? _c : null;
}
function recordTerritoryFollowUpDemand(territoryMemory, plan, gameTime) {
  const demands = pruneCurrentTerritoryFollowUpDemands(territoryMemory, gameTime);
  if (!plan.followUp || !isTerritoryControlAction2(plan.action)) {
    return;
  }
  upsertTerritoryFollowUpDemand(demands, {
    type: "followUpPreparation",
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    workerCount: TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND,
    updatedAt: gameTime,
    followUp: plan.followUp
  });
  territoryMemory.demands = demands;
}
function pruneCurrentTerritoryFollowUpDemands(territoryMemory, gameTime) {
  const currentDemands = normalizeTerritoryFollowUpDemands(territoryMemory.demands).filter(
    (demand) => demand.updatedAt === gameTime
  );
  if (currentDemands.length > 0) {
    territoryMemory.demands = currentDemands;
  } else {
    delete territoryMemory.demands;
  }
  return currentDemands;
}
function upsertTerritoryFollowUpDemand(demands, nextDemand) {
  const existingIndex = demands.findIndex(
    (demand) => demand.type === nextDemand.type && demand.colony === nextDemand.colony && demand.targetRoom === nextDemand.targetRoom && demand.action === nextDemand.action
  );
  if (existingIndex >= 0) {
    demands[existingIndex] = nextDemand;
    return;
  }
  demands.push(nextDemand);
}
function removeTerritoryFollowUpDemand(territoryMemory, colony, targetRoom, action) {
  if (!isTerritoryControlAction2(action)) {
    return;
  }
  const demands = normalizeTerritoryFollowUpDemands(territoryMemory.demands).filter(
    (demand) => !(demand.colony === colony && demand.targetRoom === targetRoom && demand.action === action)
  );
  if (demands.length > 0) {
    territoryMemory.demands = demands;
  } else {
    delete territoryMemory.demands;
  }
}
function getCurrentTerritoryFollowUpDemand(plan, gameTime) {
  var _a;
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return null;
  }
  return (_a = normalizeTerritoryFollowUpDemands(territoryMemory.demands).find(
    (demand) => demand.updatedAt === gameTime && demand.colony === plan.colony && demand.targetRoom === plan.targetRoom && demand.action === plan.action
  )) != null ? _a : null;
}
function recordTerritoryFollowUpExecutionHint(territoryMemory, plan, gameTime, routeDistanceLookupContext = createRouteDistanceLookupContext()) {
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  const currentHints = getBoundedActiveTerritoryFollowUpExecutionHints(
    normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints),
    intents,
    routeDistanceLookupContext
  );
  const nextHint = buildTerritoryFollowUpExecutionHint(plan, gameTime);
  if (!nextHint) {
    setTerritoryFollowUpExecutionHints(
      territoryMemory,
      hasActiveTerritoryFollowUpIntentForColony(intents, plan.colony) ? currentHints : currentHints.filter((hint) => hint.colony !== plan.colony)
    );
    return;
  }
  upsertTerritoryFollowUpExecutionHint(currentHints, nextHint);
  setTerritoryFollowUpExecutionHints(territoryMemory, currentHints);
}
function refreshTerritoryFollowUpExecutionHints(territoryMemory, intents, routeDistanceLookupContext) {
  if (!territoryMemory || !Array.isArray(territoryMemory.executionHints)) {
    return;
  }
  setTerritoryFollowUpExecutionHints(
    territoryMemory,
    getBoundedActiveTerritoryFollowUpExecutionHints(
      normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints),
      intents,
      routeDistanceLookupContext
    )
  );
}
function getBoundedActiveTerritoryFollowUpExecutionHints(hints, intents, routeDistanceLookupContext = createRouteDistanceLookupContext()) {
  const latestHintByColony = /* @__PURE__ */ new Map();
  for (const hint of hints) {
    if (!isTerritoryFollowUpExecutionHintStillActive(hint, intents, routeDistanceLookupContext)) {
      continue;
    }
    const existingHint = latestHintByColony.get(hint.colony);
    if (!existingHint || hint.updatedAt > existingHint.updatedAt || hint.updatedAt === existingHint.updatedAt && hint.targetRoom.localeCompare(existingHint.targetRoom) < 0) {
      latestHintByColony.set(hint.colony, hint);
    }
  }
  return Array.from(latestHintByColony.values()).sort((left, right) => left.colony.localeCompare(right.colony));
}
function isTerritoryFollowUpExecutionHintStillActive(hint, intents, routeDistanceLookupContext) {
  if (isTerritoryFollowUpExecutionHintKnownUnreachable(hint, routeDistanceLookupContext)) {
    return false;
  }
  const matchingIntent = findMatchingActiveTerritoryFollowUpIntent(hint, intents);
  if (!(matchingIntent == null ? void 0 : matchingIntent.followUp) || !isSameTerritoryFollowUp(hint.followUp, matchingIntent.followUp)) {
    return false;
  }
  const currentReason = getTerritoryFollowUpExecutionHintReason(
    matchingIntent.targetRoom,
    matchingIntent.action,
    matchingIntent.controllerId,
    getVisibleColonyOwnerUsername2(matchingIntent.colony)
  );
  return currentReason === hint.reason;
}
function isTerritoryFollowUpExecutionHintKnownUnreachable(hint, routeDistanceLookupContext) {
  return hasKnownNoRoute(hint.colony, hint.targetRoom, routeDistanceLookupContext);
}
function findMatchingActiveTerritoryFollowUpIntent(hint, intents) {
  var _a;
  return (_a = intents.find(
    (intent) => intent.colony === hint.colony && intent.targetRoom === hint.targetRoom && intent.action === hint.action && isActiveTerritoryFollowUpIntent(intent)
  )) != null ? _a : null;
}
function hasActiveTerritoryFollowUpIntentForColony(intents, colony) {
  return intents.some((intent) => intent.colony === colony && isActiveTerritoryFollowUpIntent(intent));
}
function isActiveTerritoryFollowUpIntent(intent) {
  return (intent.status === "planned" || intent.status === "active") && intent.followUp !== void 0 && !isTerritoryIntentSuspensionActive(intent, getGameTime6());
}
function buildTerritoryFollowUpExecutionHint(plan, gameTime) {
  if (!plan.followUp) {
    return null;
  }
  const reason = getTerritoryFollowUpExecutionHintReason(
    plan.targetRoom,
    plan.action,
    plan.controllerId,
    getVisibleColonyOwnerUsername2(plan.colony)
  );
  if (reason === null) {
    return null;
  }
  return {
    type: "activeFollowUpExecution",
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    reason,
    updatedAt: gameTime,
    ...plan.controllerId ? { controllerId: plan.controllerId } : {},
    followUp: plan.followUp
  };
}
function getTerritoryFollowUpExecutionHintReason(targetRoom, action, controllerId, colonyOwnerUsername) {
  if (!isVisibleTerritoryIntentActionable(targetRoom, action, controllerId, colonyOwnerUsername)) {
    return null;
  }
  if (action === "scout") {
    return "followUpTargetStillUnseen";
  }
  const controllerEvidenceState = getVisibleTerritoryControllerEvidenceState(
    targetRoom,
    action,
    controllerId,
    colonyOwnerUsername
  );
  return controllerEvidenceState === null ? "controlEvidenceStillMissing" : "visibleControlEvidenceStillActionable";
}
function upsertTerritoryFollowUpExecutionHint(hints, nextHint) {
  const existingIndex = hints.findIndex((hint) => hint.colony === nextHint.colony);
  if (existingIndex >= 0) {
    hints[existingIndex] = nextHint;
    return;
  }
  hints.push(nextHint);
}
function removeTerritoryFollowUpExecutionHint(territoryMemory, colony, targetRoom, action) {
  const hints = normalizeTerritoryFollowUpExecutionHints(territoryMemory.executionHints).filter(
    (hint) => !(hint.colony === colony && hint.targetRoom === targetRoom && hint.action === action)
  );
  setTerritoryFollowUpExecutionHints(territoryMemory, hints);
}
function setTerritoryFollowUpExecutionHints(territoryMemory, hints) {
  if (hints.length > 0) {
    territoryMemory.executionHints = hints;
  } else {
    delete territoryMemory.executionHints;
  }
}
function normalizeTerritoryFollowUpExecutionHints(rawHints) {
  return Array.isArray(rawHints) ? rawHints.flatMap((hint) => {
    const normalizedHint = normalizeTerritoryFollowUpExecutionHint(hint);
    return normalizedHint ? [normalizedHint] : [];
  }) : [];
}
function normalizeTerritoryFollowUpExecutionHint(rawHint) {
  if (!isRecord4(rawHint)) {
    return null;
  }
  if (rawHint.type !== "activeFollowUpExecution" || !isNonEmptyString5(rawHint.colony) || !isNonEmptyString5(rawHint.targetRoom) || !isTerritoryIntentAction2(rawHint.action) || !isTerritoryExecutionHintReason(rawHint.reason) || typeof rawHint.updatedAt !== "number") {
    return null;
  }
  const followUp = normalizeTerritoryFollowUp(rawHint.followUp);
  if (!followUp) {
    return null;
  }
  return {
    type: "activeFollowUpExecution",
    colony: rawHint.colony,
    targetRoom: rawHint.targetRoom,
    action: rawHint.action,
    reason: rawHint.reason,
    updatedAt: rawHint.updatedAt,
    ...typeof rawHint.controllerId === "string" ? { controllerId: rawHint.controllerId } : {},
    followUp
  };
}
function isSameTerritoryFollowUp(left, right) {
  return left.source === right.source && left.originRoom === right.originRoom && left.originAction === right.originAction;
}
function normalizeTerritoryFollowUpDemands(rawDemands) {
  return Array.isArray(rawDemands) ? rawDemands.flatMap((demand) => {
    const normalizedDemand = normalizeTerritoryFollowUpDemand(demand);
    return normalizedDemand ? [normalizedDemand] : [];
  }) : [];
}
function normalizeTerritoryFollowUpDemand(rawDemand) {
  if (!isRecord4(rawDemand)) {
    return null;
  }
  if (rawDemand.type !== "followUpPreparation" || !isNonEmptyString5(rawDemand.colony) || !isNonEmptyString5(rawDemand.targetRoom) || !isTerritoryControlAction2(rawDemand.action) || typeof rawDemand.updatedAt !== "number") {
    return null;
  }
  const followUp = normalizeTerritoryFollowUp(rawDemand.followUp);
  const workerCount = getBoundedTerritoryFollowUpWorkerDemand(rawDemand.workerCount);
  if (!followUp || workerCount <= 0) {
    return null;
  }
  return {
    type: "followUpPreparation",
    colony: rawDemand.colony,
    targetRoom: rawDemand.targetRoom,
    action: rawDemand.action,
    workerCount,
    updatedAt: rawDemand.updatedAt,
    followUp
  };
}
function getBoundedTerritoryFollowUpWorkerDemand(rawWorkerCount) {
  if (typeof rawWorkerCount !== "number") {
    return TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND;
  }
  if (!Number.isFinite(rawWorkerCount)) {
    return 0;
  }
  return Math.max(0, Math.min(TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND, Math.floor(rawWorkerCount)));
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
function buildHostilePresenceTerritoryIntentSuspension(hostileCount, gameTime) {
  return {
    reason: "hostile_presence",
    hostileCount,
    updatedAt: gameTime
  };
}
function withoutTerritoryIntentSuspension(intent) {
  const { suspended: _suspended, ...unsuspendedIntent } = intent;
  return unsuspendedIntent;
}
function isHostileTerritoryIntentSuspensionCoolingDown(suspension, gameTime) {
  return gameTime - suspension.updatedAt <= TERRITORY_HOSTILE_INTENT_SUSPENSION_TICKS;
}
function isTerritoryIntentSuspended(colony, targetRoom, action, gameTime = getGameTime6()) {
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return false;
  }
  return isTerritoryIntentSuspendedForAction(
    normalizeTerritoryIntents(territoryMemory.intents),
    colony,
    targetRoom,
    action,
    gameTime
  );
}
function isTerritoryIntentSuspendedForAction(intents, colony, targetRoom, action, gameTime) {
  return intents.some(
    (intent) => intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action && isTerritoryIntentSuspensionActive(intent, gameTime)
  );
}
function isTerritoryRoomSuspendedForColony(intents, colony, targetRoom, gameTime) {
  return intents.some(
    (intent) => intent.colony === colony && intent.targetRoom === targetRoom && isTerritoryIntentSuspensionActive(intent, gameTime)
  );
}
function isTerritoryIntentSuspensionActive(intent, gameTime) {
  if (!intent.suspended) {
    return false;
  }
  if (intent.suspended.reason === "hostile_presence") {
    const hostileCount = getVisibleHostileCreepCount(intent.targetRoom);
    if (hostileCount !== null) {
      return hostileCount > 0 && isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime);
    }
  }
  return isHostileTerritoryIntentSuspensionCoolingDown(intent.suspended, gameTime);
}
function isTerritoryTargetSuppressed(target, intents, gameTime) {
  return isSuppressedTerritoryIntentForAction(intents, target.colony, target.roomName, target.action, gameTime);
}
function isSuppressedTerritoryIntentForAction(intents, colony, targetRoom, action, gameTime) {
  return intents.some(
    (intent) => isTerritorySuppressionFresh2(intent, gameTime) && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isTerritoryIntentSuppressed(colony, targetRoom, action, gameTime = getGameTime6()) {
  const territoryMemory = getTerritoryMemoryRecord2();
  if (!territoryMemory) {
    return false;
  }
  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) => isTerritorySuppressionFresh2(intent, gameTime) && intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action
  );
}
function isTerritorySuppressionFresh2(intent, gameTime) {
  return intent.status === "suppressed" && gameTime - intent.updatedAt <= TERRITORY_SUPPRESSION_RETRY_TICKS2;
}
function isRecoveredTerritoryFollowUpIntent(intent, gameTime) {
  if (intent.followUp === void 0 || isTerritoryIntentSuspensionActive(intent, gameTime) || isRecoveredTerritoryFollowUpAttemptCoolingDown2(intent, gameTime)) {
    return false;
  }
  return intent.status === "suppressed" && gameTime - intent.updatedAt > TERRITORY_SUPPRESSION_RETRY_TICKS2;
}
function isRecoveredTerritoryFollowUpAttemptCoolingDown2(intent, gameTime) {
  return intent.followUp !== void 0 && isFiniteNumber5(intent.lastAttemptAt) && gameTime >= intent.lastAttemptAt && gameTime - intent.lastAttemptAt <= TERRITORY_RECOVERED_FOLLOW_UP_RETRY_COOLDOWN_TICKS2;
}
function isRecoveredTerritoryFollowUpAttemptCoolingDownForAction(intents, colony, targetRoom, action, gameTime) {
  return intents.some(
    (intent) => intent.colony === colony && intent.targetRoom === targetRoom && intent.action === action && isRecoveredTerritoryFollowUpAttemptCoolingDown2(intent, gameTime)
  );
}
function selectVisibleTerritoryControllerIntent(creep) {
  var _a, _b, _c;
  const roomName = (_a = creep.room) == null ? void 0 : _a.name;
  if (!isNonEmptyString5(roomName) || isVisibleRoomUnsafe(creep.room)) {
    return null;
  }
  const assignmentIntent = normalizeCreepTerritoryIntent(creep, roomName);
  if (assignmentIntent && isCreepVisibleTerritoryIntentActionable(creep, assignmentIntent)) {
    return assignmentIntent;
  }
  const territoryMemory = getTerritoryMemoryRecord2();
  const colony = (_b = creep.memory) == null ? void 0 : _b.colony;
  const intents = normalizeTerritoryIntents(territoryMemory == null ? void 0 : territoryMemory.intents).filter((intent) => isActiveVisibleControllerIntentForCreep(intent, roomName, colony)).sort(compareVisibleControllerIntents);
  return (_c = intents.find((intent) => isCreepVisibleTerritoryIntentActionable(creep, intent))) != null ? _c : null;
}
function normalizeCreepTerritoryIntent(creep, roomName) {
  var _a, _b, _c, _d;
  const assignment = (_a = creep.memory) == null ? void 0 : _a.territory;
  if (!assignment || assignment.targetRoom !== roomName || !isTerritoryControlAction2(assignment.action) || isNonEmptyString5((_b = creep.memory) == null ? void 0 : _b.colony) && isTerritoryIntentSuppressed(creep.memory.colony, assignment.targetRoom, assignment.action)) {
    return null;
  }
  const followUp = normalizeTerritoryFollowUp(assignment.followUp);
  return {
    colony: (_d = (_c = creep.memory) == null ? void 0 : _c.colony) != null ? _d : "",
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: "active",
    updatedAt: getGameTime6(),
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {},
    ...followUp ? { followUp } : {}
  };
}
function isActiveVisibleControllerIntentForCreep(intent, roomName, creepColony) {
  return intent.targetRoom === roomName && intent.targetRoom !== intent.colony && isTerritoryControlAction2(intent.action) && (intent.status === "planned" || intent.status === "active") && (!isNonEmptyString5(creepColony) || intent.colony === creepColony);
}
function compareVisibleControllerIntents(left, right) {
  return getIntentStatusPriority(left.status) - getIntentStatusPriority(right.status) || getIntentActionPriority(left.action) - getIntentActionPriority(right.action) || right.updatedAt - left.updatedAt || left.colony.localeCompare(right.colony);
}
function compareTerritoryIntentProgressSummaries(left, right) {
  return getIntentStatusPriority(left.status) - getIntentStatusPriority(right.status) || right.activeCreepCount - left.activeCreepCount || getIntentActionPriority(left.action) - getIntentActionPriority(right.action) || right.updatedAt - left.updatedAt || left.targetRoom.localeCompare(right.targetRoom);
}
function getIntentStatusPriority(status) {
  return status === "active" ? 0 : 1;
}
function getIntentActionPriority(action) {
  return action === "claim" ? 0 : 1;
}
function isCreepVisibleTerritoryIntentActionable(creep, intent) {
  if (!isTerritoryControlAction2(intent.action)) {
    return false;
  }
  const controller = selectCreepRoomController(creep, intent.controllerId);
  if (!controller) {
    return false;
  }
  if (!isVisibleRoomSafe(creep.room)) {
    return false;
  }
  if (intent.action === "reserve") {
    return canCreepActOnVisibleReserveController(creep, controller, intent.colony);
  }
  const actorUsername = getTerritoryActorUsername(creep, intent.colony);
  if (controller.my === true) {
    return true;
  }
  if (isForeignReservedController(controller, actorUsername)) {
    return canCreepPressureTerritoryController(creep, controller, intent.colony);
  }
  return getTerritoryControllerTargetState(controller, intent.action, actorUsername) === "available" && canUseControllerClaimPart(creep);
}
function canCreepActOnVisibleReserveController(creep, controller, colony) {
  return canCreepReserveTerritoryController(creep, controller, colony) || canCreepPressureTerritoryController(creep, controller, colony);
}
function selectVisibleTerritoryAssignmentController(assignment, creep) {
  var _a;
  return ((_a = creep == null ? void 0 : creep.room) == null ? void 0 : _a.name) === assignment.targetRoom ? selectCreepRoomController(creep, assignment.controllerId) : getVisibleController2(assignment.targetRoom, assignment.controllerId);
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
  const getObjectById3 = game == null ? void 0 : game.getObjectById;
  if (typeof getObjectById3 !== "function") {
    return null;
  }
  return getObjectById3.call(game, controllerId);
}
function getTerritoryControllerTargetState(controller, action, colonyOwnerUsername) {
  if (action === "reserve") {
    return getReserveControllerTargetState(controller, colonyOwnerUsername);
  }
  if (isControllerOwnedByColony2(controller, colonyOwnerUsername)) {
    return "satisfied";
  }
  return getClaimControllerTargetState(controller);
}
function getClaimControllerTargetState(controller) {
  return isControllerOwned(controller) ? "unavailable" : "available";
}
function getTerritoryActorUsername(creep, colony) {
  var _a;
  return (_a = getCreepOwnerUsername(creep)) != null ? _a : isNonEmptyString5(colony) ? getVisibleColonyOwnerUsername2(colony) : null;
}
function getCreepOwnerUsername(creep) {
  var _a;
  const username = (_a = creep == null ? void 0 : creep.owner) == null ? void 0 : _a.username;
  return isNonEmptyString5(username) ? username : null;
}
function canUseControllerClaimPart(creep) {
  return getActiveControllerClaimPartCount(creep) > 0;
}
function canRenewReservation(activeClaimParts, reservationTicksToEnd) {
  return reservationTicksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS || reservationTicksToEnd <= TERRITORY_RESERVATION_COMFORT_TICKS && activeClaimParts >= MIN_CLAIM_PARTS_FOR_RESERVATION_PROGRESS;
}
function getActiveControllerClaimPartCount(creep) {
  var _a;
  const claimPart = getBodyPartConstant2("CLAIM", "claim");
  const activeClaimParts = (_a = creep.getActiveBodyparts) == null ? void 0 : _a.call(creep, claimPart);
  if (typeof activeClaimParts === "number") {
    return activeClaimParts > 0 ? activeClaimParts : 0;
  }
  return Array.isArray(creep.body) ? creep.body.filter((part) => isActiveBodyPart2(part, claimPart)).length : 0;
}
function isActiveBodyPart2(part, bodyPartType) {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const bodyPart = part;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === "number" && bodyPart.hits > 0;
}
function getBodyPartConstant2(globalName, fallback) {
  var _a;
  const constants = globalThis;
  return (_a = constants[globalName]) != null ? _a : fallback;
}
function getStoredEnergy(object) {
  var _a;
  const store = object == null ? void 0 : object.store;
  const energyResource = getEnergyResource2();
  const usedCapacity = (_a = store == null ? void 0 : store.getUsedCapacity) == null ? void 0 : _a.call(store, energyResource);
  if (typeof usedCapacity === "number") {
    return usedCapacity;
  }
  const storedEnergy = store == null ? void 0 : store[energyResource];
  return typeof storedEnergy === "number" ? storedEnergy : 0;
}
function getEnergyResource2() {
  const resource = globalThis.RESOURCE_ENERGY;
  return typeof resource === "string" ? resource : "energy";
}
function isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom) {
  var _a, _b;
  if (isKnownDeadZoneRoom(targetRoom)) {
    return true;
  }
  const room = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[targetRoom];
  return room ? isVisibleRoomUnsafe(room) : false;
}
function isVisibleRoomSafe(room) {
  return !isVisibleRoomUnsafe(room);
}
function isVisibleRoomUnsafe(room) {
  return findVisibleHostileCreeps(room).length > 0 || findVisibleHostileStructures(room).length > 0;
}
function getVisibleHostileCreepCount(targetRoom) {
  var _a, _b;
  const room = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[targetRoom];
  return room ? findVisibleHostileCreeps(room).length : null;
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
  const controller = getVisibleController2(targetRoom, controllerId);
  if (!controller) {
    return "available";
  }
  if (action === "reserve") {
    return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername != null ? colonyOwnerUsername : null);
  }
  return getTerritoryControllerTargetState(controller, action, colonyOwnerUsername != null ? colonyOwnerUsername : null);
}
function isVisibleTerritoryIntentActionable(targetRoom, action, controllerId, colonyOwnerUsername) {
  return getVisibleTerritoryTargetState(targetRoom, action, controllerId, colonyOwnerUsername) === "available" || isVisibleTerritoryReservePressureAvailable(targetRoom, action, controllerId, colonyOwnerUsername);
}
function isVisibleTerritoryReservePressureAvailable(targetRoom, action, controllerId, colonyOwnerUsername) {
  if (!isTerritoryControlAction2(action) || isVisibleRoomUnsafeForTerritoryControllerWork(targetRoom)) {
    return false;
  }
  const controller = getVisibleController2(targetRoom, controllerId);
  return controller !== null && isForeignReservedController(controller, colonyOwnerUsername);
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
  return controller.my === true || isNonEmptyString5(ownerUsername) && ownerUsername === colonyOwnerUsername;
}
function getReserveControllerTargetState(controller, colonyOwnerUsername) {
  if (isControllerOwned(controller)) {
    return "unavailable";
  }
  const reservation = controller.reservation;
  if (!reservation) {
    return "available";
  }
  if (!isNonEmptyString5(reservation.username) || reservation.username !== colonyOwnerUsername) {
    return "unavailable";
  }
  return getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername) === null ? "satisfied" : "available";
}
function isForeignReservedController(controller, actorUsername) {
  if (isControllerOwned(controller) || !isNonEmptyString5(actorUsername)) {
    return false;
  }
  const reservation = controller.reservation;
  return isNonEmptyString5(reservation == null ? void 0 : reservation.username) && reservation.username !== actorUsername;
}
function isOwnReservedController(controller, actorUsername) {
  const reservation = controller.reservation;
  return isNonEmptyString5(actorUsername) && isNonEmptyString5(reservation == null ? void 0 : reservation.username) && reservation.username === actorUsername;
}
function updateTerritoryReservationMemory(territoryMemory, colony, roomName, controllerId, gameTime, reservationTicksToEnd) {
  if (reservationTicksToEnd === null) {
    return;
  }
  const reservations = normalizeTerritoryReservations(territoryMemory.reservations);
  const reservationKey = getTerritoryReservationMemoryKey(colony, roomName);
  const nextReservation = {
    colony,
    roomName,
    ticksToEnd: reservationTicksToEnd,
    updatedAt: gameTime,
    ...controllerId ? { controllerId } : {}
  };
  if (!isSameTerritoryReservation(reservations[reservationKey], nextReservation)) {
    reservations[reservationKey] = nextReservation;
    setTerritoryReservations(territoryMemory, reservations);
  }
}
function getConfiguredReserveRenewalTicksToEnd(target, colonyOwnerUsername) {
  if (target.action !== "reserve" || colonyOwnerUsername === null) {
    return null;
  }
  const controller = getVisibleController2(target.roomName, target.controllerId);
  if (!controller || isControllerOwned(controller)) {
    return null;
  }
  return getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername);
}
function shouldSpawnEmergencyReservationRenewal(plan, activeCoverageCount) {
  if (activeCoverageCount >= TERRITORY_EMERGENCY_RESERVATION_COVERAGE_TARGET || plan.action !== "reserve") {
    return false;
  }
  const controller = getVisibleController2(plan.targetRoom, plan.controllerId);
  if (!controller || isControllerOwned(controller)) {
    return false;
  }
  const colonyOwnerUsername = getVisibleColonyOwnerUsername2(plan.colony);
  const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
  return ticksToEnd !== null && ticksToEnd <= TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS;
}
function getUrgentOwnReservationTicksToEnd(controller, colonyOwnerUsername) {
  const ticksToEnd = getOwnReservationTicksToEnd(controller, colonyOwnerUsername);
  return ticksToEnd !== null && ticksToEnd <= TERRITORY_RESERVATION_RENEWAL_TICKS ? ticksToEnd : null;
}
function getOwnReservationTicksToEnd(controller, colonyOwnerUsername) {
  if (isControllerOwned(controller) || !isNonEmptyString5(colonyOwnerUsername)) {
    return null;
  }
  const reservation = controller.reservation;
  if (!reservation || reservation.username !== colonyOwnerUsername || typeof reservation.ticksToEnd !== "number") {
    return null;
  }
  return reservation.ticksToEnd;
}
function getVisibleColonyOwnerUsername2(colonyName) {
  const controller = getVisibleController2(colonyName);
  return getControllerOwnerUsername2(controller != null ? controller : void 0);
}
function getControllerOwnerUsername2(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return isNonEmptyString5(username) ? username : null;
}
function getVisibleController2(targetRoom, controllerId) {
  var _a, _b;
  const game = globalThis.Game;
  const roomController = (_b = (_a = game == null ? void 0 : game.rooms) == null ? void 0 : _a[targetRoom]) == null ? void 0 : _b.controller;
  if (roomController) {
    return roomController;
  }
  const getObjectById3 = game == null ? void 0 : game.getObjectById;
  if (controllerId && typeof getObjectById3 === "function") {
    return getObjectById3.call(game, controllerId);
  }
  return null;
}
function getGameTime6() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function getWritableTerritoryMemoryRecord2() {
  const memory = getMemoryRecord();
  if (!memory) {
    return null;
  }
  if (!isRecord4(memory.territory)) {
    memory.territory = {};
  }
  return memory.territory;
}
function getTerritoryMemoryRecord2() {
  const memory = getMemoryRecord();
  if (!memory || !isRecord4(memory.territory)) {
    return null;
  }
  return memory.territory;
}
function getMemoryRecord() {
  const memory = globalThis.Memory;
  return memory != null ? memory : null;
}
function isTerritoryControlAction2(action) {
  return action === "claim" || action === "reserve";
}
function isTerritoryIntentAction2(action) {
  return isTerritoryControlAction2(action) || action === "scout";
}
function isTerritoryFollowUpSource2(source) {
  return source === "satisfiedClaimAdjacent" || source === "satisfiedReserveAdjacent" || source === "activeReserveAdjacent";
}
function isTerritoryExecutionHintReason(reason) {
  return reason === "controlEvidenceStillMissing" || reason === "followUpTargetStillUnseen" || reason === "visibleControlEvidenceStillActionable";
}
function isNonEmptyString5(value) {
  return typeof value === "string" && value.length > 0;
}
function isFiniteNumber5(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null;
}

// src/construction/criticalRoads.ts
var CRITICAL_ROAD_ROUTE_RANGE = 2;
var ROOM_EDGE_MIN4 = 1;
var ROOM_EDGE_MAX4 = 48;
var ROOM_CENTER = 25;
function buildCriticalRoadLogisticsContext(room, options = {}) {
  const anchorPositions = findOwnedSpawnPositions(room);
  const targetPositions = findLogisticsTargetPositions(room);
  const colonyAnchorPositions = anchorPositions.length === 0 ? findColonyRoomLogisticsAnchorPositions(room, options.colonyRoomName, targetPositions) : [];
  return {
    anchorPositions: anchorPositions.length > 0 ? anchorPositions : colonyAnchorPositions.length > 0 ? colonyAnchorPositions : findRemoteTerritoryLogisticsAnchorPositions(room, targetPositions),
    targetPositions
  };
}
function isCriticalRoadLogisticsWork(target, context) {
  if (!isRoadWorkTarget(target) || !target.pos || context.anchorPositions.length === 0 || context.targetPositions.length === 0) {
    return false;
  }
  const position = target.pos;
  return context.anchorPositions.some(
    (anchor) => context.targetPositions.some((destination) => isNearLogisticsRoute(position, anchor, destination))
  );
}
function findOwnedSpawnPositions(room) {
  return findRoomObjects4(room, "FIND_MY_STRUCTURES").filter(
    (structure) => matchesStructureType4(structure.structureType, "STRUCTURE_SPAWN", "spawn")
  ).map((spawn) => spawn.pos).filter((position) => isSameRoomPosition3(position, room.name));
}
function findLogisticsTargetPositions(room) {
  var _a;
  const sourcePositions = findRoomObjects4(room, "FIND_SOURCES").map((source) => source.pos).filter((position) => isSameRoomPosition3(position, room.name));
  const controllerPosition = isSameRoomPosition3((_a = room.controller) == null ? void 0 : _a.pos, room.name) ? [room.controller.pos] : [];
  return [...sourcePositions, ...controllerPosition];
}
function findColonyRoomLogisticsAnchorPositions(room, colonyRoomName, targetPositions) {
  if (targetPositions.length === 0 || !isNonEmptyString6(room.name) || !isNonEmptyString6(colonyRoomName) || colonyRoomName === room.name) {
    return [];
  }
  return uniqueRoomPositions(
    findColonyRoomSpawnPositions(colonyRoomName).map((position) => projectHomeAnchorIntoRoom(position, room.name)).filter((position) => position !== null)
  );
}
function findColonyRoomSpawnPositions(colonyRoomName) {
  var _a, _b;
  const game = globalThis.Game;
  const homeRoom = (_a = game == null ? void 0 : game.rooms) == null ? void 0 : _a[colonyRoomName];
  const roomSpawnPositions = homeRoom ? findOwnedSpawnPositions(homeRoom) : [];
  const globalSpawnPositions = Object.values((_b = game == null ? void 0 : game.spawns) != null ? _b : {}).map((spawn) => spawn.pos).filter((position) => isSameRoomPosition3(position, colonyRoomName));
  return uniqueRoomPositions([...roomSpawnPositions, ...globalSpawnPositions]);
}
function projectHomeAnchorIntoRoom(anchor, roomName) {
  if (!isNonEmptyString6(anchor.roomName) || anchor.roomName === roomName) {
    return null;
  }
  const anchorCoordinates = parseRoomCoordinates(anchor.roomName);
  const roomCoordinates = parseRoomCoordinates(roomName);
  if (!anchorCoordinates || !roomCoordinates) {
    return null;
  }
  const deltaX = roomCoordinates.x - anchorCoordinates.x;
  const deltaY = roomCoordinates.y - anchorCoordinates.y;
  if (deltaX === 0 && deltaY === 0) {
    return null;
  }
  return {
    x: deltaX > 0 ? ROOM_EDGE_MIN4 : deltaX < 0 ? ROOM_EDGE_MAX4 : clampRoomCoordinate(anchor.x),
    y: deltaY > 0 ? ROOM_EDGE_MIN4 : deltaY < 0 ? ROOM_EDGE_MAX4 : clampRoomCoordinate(anchor.y),
    roomName
  };
}
function parseRoomCoordinates(roomName) {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) {
    return null;
  }
  const horizontalValue = Number(match[2]);
  const verticalValue = Number(match[4]);
  if (!Number.isFinite(horizontalValue) || !Number.isFinite(verticalValue)) {
    return null;
  }
  return {
    x: match[1] === "E" ? horizontalValue : -horizontalValue - 1,
    y: match[3] === "S" ? verticalValue : -verticalValue - 1
  };
}
function clampRoomCoordinate(value) {
  if (!Number.isFinite(value)) {
    return ROOM_CENTER;
  }
  return Math.max(ROOM_EDGE_MIN4, Math.min(ROOM_EDGE_MAX4, Math.round(value)));
}
function uniqueRoomPositions(positions) {
  const seen = /* @__PURE__ */ new Set();
  return positions.filter((position) => {
    const key = `${position.roomName}:${position.x}:${position.y}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
function findRemoteTerritoryLogisticsAnchorPositions(room, targetPositions) {
  var _a;
  if (targetPositions.length === 0 || !isRemoteTerritoryLogisticsRoom(room)) {
    return [];
  }
  if (isSameRoomPosition3((_a = room.controller) == null ? void 0 : _a.pos, room.name)) {
    return [room.controller.pos];
  }
  return targetPositions.slice(0, 1);
}
function findRoomObjects4(room, constantName) {
  const findConstant = globalThis[constantName];
  if (typeof findConstant !== "number" || typeof room.find !== "function") {
    return [];
  }
  try {
    const result = room.find(findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
function isRoadWorkTarget(target) {
  return matchesStructureType4(target.structureType, "STRUCTURE_ROAD", "road");
}
function isRemoteTerritoryLogisticsRoom(room) {
  var _a;
  return isReferencedRemoteTerritoryRoom(room.name) || ((_a = room.controller) == null ? void 0 : _a.my) !== true && isSelfReservedRoom(room);
}
function isReferencedRemoteTerritoryRoom(roomName) {
  const territoryMemory = getTerritoryMemoryRecord3();
  if (!territoryMemory) {
    return false;
  }
  return hasRemoteTerritoryReference(territoryMemory.targets, roomName, "roomName") || hasRemoteTerritoryReference(territoryMemory.intents, roomName, "targetRoom") || hasRemoteTerritoryReference(territoryMemory.demands, roomName, "targetRoom") || hasRemoteTerritoryReference(territoryMemory.executionHints, roomName, "targetRoom");
}
function hasRemoteTerritoryReference(value, roomName, roomKey) {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((entry) => {
    if (!isRecord5(entry)) {
      return false;
    }
    return entry[roomKey] === roomName && isNonEmptyString6(entry.colony) && entry.colony !== roomName && isTerritoryControlAction3(entry.action) && entry.status !== "suppressed" && entry.enabled !== false;
  });
}
function isSelfReservedRoom(room) {
  var _a, _b;
  const reservationUsername = (_b = (_a = room.controller) == null ? void 0 : _a.reservation) == null ? void 0 : _b.username;
  return isNonEmptyString6(reservationUsername) && getOwnedUsernames().has(reservationUsername);
}
function getTerritoryMemoryRecord3() {
  const memory = globalThis.Memory;
  return memory && isRecord5(memory.territory) ? memory.territory : null;
}
function getOwnedUsernames() {
  var _a, _b, _c, _d;
  const usernames = /* @__PURE__ */ new Set();
  const game = globalThis.Game;
  for (const spawn of Object.values((_a = game == null ? void 0 : game.spawns) != null ? _a : {})) {
    addOwnedUsername(usernames, spawn);
  }
  for (const creep of Object.values((_b = game == null ? void 0 : game.creeps) != null ? _b : {})) {
    addOwnedUsername(usernames, creep);
  }
  for (const visibleRoom of Object.values((_c = game == null ? void 0 : game.rooms) != null ? _c : {})) {
    if (((_d = visibleRoom.controller) == null ? void 0 : _d.my) === true) {
      addOwnedUsername(usernames, visibleRoom.controller);
    }
  }
  return usernames;
}
function addOwnedUsername(usernames, object) {
  var _a;
  const username = (_a = object == null ? void 0 : object.owner) == null ? void 0 : _a.username;
  if (isNonEmptyString6(username)) {
    usernames.add(username);
  }
}
function isTerritoryControlAction3(action) {
  return action === "claim" || action === "reserve";
}
function isNearLogisticsRoute(position, anchor, destination) {
  if (!isSameRoomPosition3(position, anchor.roomName) || !isSameRoomPosition3(position, destination.roomName)) {
    return false;
  }
  return getSquaredDistanceToSegment(position, anchor, destination) <= CRITICAL_ROAD_ROUTE_RANGE ** 2;
}
function getSquaredDistanceToSegment(position, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) {
    return getSquaredDistance(position, start);
  }
  const projection = ((position.x - start.x) * deltaX + (position.y - start.y) * deltaY) / lengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));
  const closestX = start.x + clampedProjection * deltaX;
  const closestY = start.y + clampedProjection * deltaY;
  const distanceX = position.x - closestX;
  const distanceY = position.y - closestY;
  return distanceX * distanceX + distanceY * distanceY;
}
function getSquaredDistance(left, right) {
  const distanceX = left.x - right.x;
  const distanceY = left.y - right.y;
  return distanceX * distanceX + distanceY * distanceY;
}
function isSameRoomPosition3(position, roomName) {
  return !!position && (!position.roomName || !roomName || position.roomName === roomName);
}
function isRecord5(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString6(value) {
  return typeof value === "string" && value.length > 0;
}
function matchesStructureType4(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}

// src/construction/constructionPriority.ts
var CONTROLLER_DOWNGRADE_CRITICAL_TICKS = 5e3;
var CONTROLLER_DOWNGRADE_WARNING_TICKS = 1e4;
var EARLY_ENERGY_CAPACITY_TARGET = 550;
var MIN_SAFE_WORKERS_FOR_EXPANSION = 3;
var MIN_RCL_FOR_AUTOMATED_ROADS = 4;
var TOWER_LIMITS_BY_RCL = {
  3: 1,
  4: 1,
  5: 2,
  6: 2,
  7: 3,
  8: 6
};
var DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE = 20;
var MAX_SCORE = 100;
var MAX_URGENCY_POINTS = 35;
var MAX_ROOM_STATE_POINTS = 20;
var MAX_EXPANSION_POINTS = 20;
var MAX_ECONOMIC_POINTS = 20;
var MAX_VISION_POINTS = 15;
var MAX_RISK_COST = 25;
var CRITICAL_REPAIR_HITS_RATIO = 0.5;
var DECAYING_REPAIR_HITS_RATIO = 0.8;
var IDLE_RAMPART_REPAIR_HITS_CEILING = 1e5;
var CONSTRUCTION_SITE_IMPACT_PRIORITY = {
  extension: 100,
  spawn: 95,
  tower: 90,
  protectedRampart: 90,
  rampart: 85,
  sourceContainer: 70,
  criticalRoad: 80,
  road: 55,
  container: 45,
  other: 35,
  wall: 5
};
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
function getConstructionSiteImpactPriority(site, context = {}) {
  if (matchesStructureType5(site.structureType, "STRUCTURE_EXTENSION", "extension")) {
    return CONSTRUCTION_SITE_IMPACT_PRIORITY.extension;
  }
  if (matchesStructureType5(site.structureType, "STRUCTURE_SPAWN", "spawn")) {
    return CONSTRUCTION_SITE_IMPACT_PRIORITY.spawn;
  }
  if (matchesStructureType5(site.structureType, "STRUCTURE_CONTAINER", "container")) {
    return isSourceContainerConstructionSite(site, context) ? CONSTRUCTION_SITE_IMPACT_PRIORITY.sourceContainer : CONSTRUCTION_SITE_IMPACT_PRIORITY.container;
  }
  if (matchesStructureType5(site.structureType, "STRUCTURE_ROAD", "road")) {
    return context.criticalRoadContext && isCriticalRoadLogisticsWork(site, context.criticalRoadContext) ? CONSTRUCTION_SITE_IMPACT_PRIORITY.criticalRoad : CONSTRUCTION_SITE_IMPACT_PRIORITY.road;
  }
  if (matchesStructureType5(site.structureType, "STRUCTURE_TOWER", "tower")) {
    return CONSTRUCTION_SITE_IMPACT_PRIORITY.tower;
  }
  if (matchesStructureType5(site.structureType, "STRUCTURE_RAMPART", "rampart")) {
    return isProtectedRampartConstructionSite(site, context) ? CONSTRUCTION_SITE_IMPACT_PRIORITY.protectedRampart : CONSTRUCTION_SITE_IMPACT_PRIORITY.rampart;
  }
  if (isWallConstructionSite(site)) {
    return CONSTRUCTION_SITE_IMPACT_PRIORITY.wall;
  }
  return CONSTRUCTION_SITE_IMPACT_PRIORITY.other;
}
function buildRuntimeConstructionPriorityReport(colony, creeps) {
  const state = buildRuntimeConstructionPriorityState(colony, creeps);
  return scoreConstructionPriorities(state, buildRuntimeConstructionCandidates(state));
}
function isNearRoomObject(object, position) {
  const objectPosition = getRoomObjectPosition2(object);
  const range = getRangeBetweenPositions3(objectPosition, position);
  return isSameRoomPosition4(objectPosition, position.roomName) && range !== null && range <= 1;
}
function isSourceContainerConstructionSite(site, context) {
  const sitePosition = getRoomObjectPosition2(site);
  if (!sitePosition || !context.sources || context.sources.length === 0) {
    return false;
  }
  return context.sources.some((source) => isNearRoomObject(source, sitePosition));
}
function isProtectedRampartConstructionSite(site, context) {
  const sitePosition = getRoomObjectPosition2(site);
  if (!sitePosition || !context.protectedRampartAnchors || context.protectedRampartAnchors.length === 0) {
    return false;
  }
  return context.protectedRampartAnchors.some((anchor) => {
    const range = getRangeBetweenPositions3(sitePosition, anchor);
    return range !== null && range <= 2;
  });
}
function isWallConstructionSite(site) {
  return matchesStructureType5(site.structureType, "STRUCTURE_WALL", "constructedWall") || String(site.structureType) === "wall";
}
function getRoomObjectPosition2(object) {
  const position = object == null ? void 0 : object.pos;
  if (!position || typeof position.x !== "number" || typeof position.y !== "number" || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return null;
  }
  return {
    x: position.x,
    y: position.y,
    ...typeof position.roomName === "string" ? { roomName: position.roomName } : {}
  };
}
function isSameRoomPosition4(position, roomName) {
  return position !== null && (!position.roomName || !roomName || position.roomName === roomName);
}
function getRangeBetweenPositions3(left, right) {
  if (!left || !right) {
    return null;
  }
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
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
  const ownedConstructionSites = findRoomObjects5(room, "FIND_MY_CONSTRUCTION_SITES");
  const ownedStructures = findRoomObjects5(room, "FIND_MY_STRUCTURES");
  const visibleStructures = findRoomObjects5(room, "FIND_STRUCTURES");
  const hostileCreeps = findRoomObjects5(room, "FIND_HOSTILE_CREEPS");
  const hostileStructures = findRoomObjects5(room, "FIND_HOSTILE_STRUCTURES");
  const sources = findRoomObjects5(room, "FIND_SOURCES");
  const colonyWorkers = creeps.filter((creep) => {
    var _a2, _b2;
    return ((_a2 = creep.memory) == null ? void 0 : _a2.role) === "worker" && ((_b2 = creep.memory) == null ? void 0 : _b2.colony) === room.name;
  });
  const repairSignals = summarizeRepairSignals(visibleStructures, buildCriticalRoadLogisticsContext(room));
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
  const towerLimit = getTowerLimitForRcl(state.rcl);
  if (extensionLimit > 0 && ((_b = state.extensionCount) != null ? _b : 0) < extensionLimit) {
    candidates.push(createCandidateForBuildType("extension", state));
  }
  if (towerLimit > 0 && getExistingAndPendingBuildCount(state, "STRUCTURE_TOWER", "tower") < towerLimit) {
    candidates.push(createCandidateForBuildType("tower", state));
  }
  if (rcl >= 2) {
    candidates.push(createCandidateForBuildType("rampart", state));
  }
  if (rcl >= MIN_RCL_FOR_AUTOMATED_ROADS && ((_c = state.sourceCount) != null ? _c : 0) > 0) {
    candidates.push(createCandidateForBuildType("road", state));
  }
  if (rcl >= 2 && ((_d = state.sourceCount) != null ? _d : 0) > 0) {
    candidates.push(createCandidateForBuildType("container", state));
  }
  if (((_e = state.spawnCount) != null ? _e : 1) === 0) {
    candidates.push(createCandidateForBuildType("spawn", state));
  }
  return candidates;
}
function getTowerLimitForRcl(level) {
  var _a;
  return level ? (_a = TOWER_LIMITS_BY_RCL[level]) != null ? _a : 0 : 0;
}
function getExistingAndPendingBuildCount(state, globalName, fallback) {
  var _a, _b;
  const existingStructures = countStructuresByType(state.ownedStructures, globalName, fallback);
  const existingCount = existingStructures != null ? existingStructures : globalName === "STRUCTURE_TOWER" && fallback === "tower" ? (_a = state.towerCount) != null ? _a : 0 : 0;
  const pendingCount = ((_b = state.ownedConstructionSites) != null ? _b : []).filter(
    (site) => matchesStructureType5(String(site.structureType), globalName, fallback)
  ).length;
  return existingCount + pendingCount;
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
        requiredObservations: ["room-controller", "energy-capacity", "worker-count"],
        expectedKpiMovement: ["improves room hold safety", "adds hostile damage and repair response capacity"],
        risk: ["requires steady energy income to keep tower effective"],
        estimatedEnergyCost: STRUCTURE_BUILD_COSTS.tower,
        hostileExposure: "medium",
        signals: { defense: getDefensePressure(state), enemyKillPotential: 0.7 },
        vision: { survival: getDefensePressure(state), territory: 0.9, enemyKills: 0.5 }
      };
    case "rampart":
      return {
        buildItem: "build rampart defense",
        buildType,
        minimumRcl: 2,
        requiredObservations: ["room-controller", "repair-decay", "worker-count"],
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
  if (matchesStructureType5(structureType, "STRUCTURE_SPAWN", "spawn")) {
    return "spawn";
  }
  if (matchesStructureType5(structureType, "STRUCTURE_EXTENSION", "extension")) {
    return "extension";
  }
  if (matchesStructureType5(structureType, "STRUCTURE_TOWER", "tower")) {
    return "tower";
  }
  if (matchesStructureType5(structureType, "STRUCTURE_RAMPART", "rampart")) {
    return "rampart";
  }
  if (matchesStructureType5(structureType, "STRUCTURE_ROAD", "road")) {
    return "road";
  }
  if (matchesStructureType5(structureType, "STRUCTURE_CONTAINER", "container")) {
    return "container";
  }
  if (matchesStructureType5(structureType, "STRUCTURE_STORAGE", "storage")) {
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
function findRoomObjects5(room, constantName) {
  const findConstant = getFindConstant2(constantName);
  if (findConstant === null || typeof room.find !== "function") {
    return null;
  }
  try {
    const result = room.find(findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return null;
  }
}
function getFindConstant2(constantName) {
  const findConstant = globalThis[constantName];
  return typeof findConstant === "number" ? findConstant : null;
}
function countStructuresByType(structures, globalName, fallback) {
  return structures == null ? void 0 : structures.filter((structure) => matchesStructureType5(structure.structureType, globalName, fallback)).length;
}
function summarizeRepairSignals(structures, criticalRoadContext) {
  if (structures === null) {
    return null;
  }
  return structures.reduce(
    (summary, structure) => {
      if (!isRepairSignalStructure(structure) || !hasHits(structure)) {
        return summary;
      }
      if (matchesStructureType5(structure.structureType, "STRUCTURE_ROAD", "road") && !isCriticalRoadLogisticsWork(structure, criticalRoadContext)) {
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
  if (matchesStructureType5(structure.structureType, "STRUCTURE_ROAD", "road") || matchesStructureType5(structure.structureType, "STRUCTURE_CONTAINER", "container")) {
    return true;
  }
  return matchesStructureType5(structure.structureType, "STRUCTURE_RAMPART", "rampart") && structure.my === true && structure.hits <= IDLE_RAMPART_REPAIR_HITS_CEILING;
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
      if (!isRecord6(intent)) {
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
function isRecord6(value) {
  return typeof value === "object" && value !== null;
}
function matchesStructureType5(actual, globalName, fallback) {
  var _a;
  const constants = globalThis;
  return actual === ((_a = constants[globalName]) != null ? _a : fallback);
}

// src/rl/workerTaskBehavior.ts
var WORKER_TASK_BEHAVIOR_SCHEMA_VERSION = 1;
var HEURISTIC_WORKER_TASK_POLICY_ID = "heuristic.worker-task.v1";
var WORKER_TASK_BC_ACTION_TYPES = ["harvest", "transfer", "build", "repair", "upgrade"];
var NEARBY_STRUCTURE_RANGE = 3;
var NEARBY_TILE_COUNT = 49;
var CURRENT_TASK_CODE = {
  none: 0,
  harvest: 1,
  pickup: 2,
  withdraw: 3,
  transfer: 4,
  build: 5,
  repair: 6,
  claim: 7,
  reserve: 8,
  upgrade: 9
};
function isWorkerTaskBehaviorActionType(value) {
  return WORKER_TASK_BC_ACTION_TYPES.includes(value);
}
function recordWorkerTaskBehaviorTrace(creep, selectedTask) {
  const memory = creep.memory;
  if (!memory) {
    return null;
  }
  if (!selectedTask || !isWorkerTaskBehaviorActionType(selectedTask.type)) {
    delete memory.workerBehavior;
    return null;
  }
  const sample = {
    type: "workerTaskBehavior",
    schemaVersion: WORKER_TASK_BEHAVIOR_SCHEMA_VERSION,
    tick: getGameTick(),
    policyId: HEURISTIC_WORKER_TASK_POLICY_ID,
    liveEffect: false,
    state: buildWorkerTaskBehaviorState(creep),
    action: {
      type: selectedTask.type,
      targetId: String(selectedTask.targetId)
    }
  };
  memory.workerBehavior = sample;
  return sample;
}
function buildWorkerTaskBehaviorState(creep) {
  var _a, _b, _c, _d, _e;
  const room = creep.room;
  const structures = findRoomObjects6(room, getFindConstant3("FIND_STRUCTURES"));
  const myStructures = findRoomObjects6(room, getFindConstant3("FIND_MY_STRUCTURES"));
  const constructionSites = findRoomObjects6(room, getFindConstant3("FIND_CONSTRUCTION_SITES"));
  const droppedResources = findRoomObjects6(room, getFindConstant3("FIND_DROPPED_RESOURCES"));
  const sources = findRoomObjects6(room, getFindConstant3("FIND_SOURCES"));
  const hostileCreeps = findRoomObjects6(room, getFindConstant3("FIND_HOSTILE_CREEPS"));
  const currentTask = (_c = (_b = (_a = creep.memory) == null ? void 0 : _a.task) == null ? void 0 : _b.type) != null ? _c : "none";
  const carriedEnergy = getUsedEnergy(creep);
  const freeCapacity = getFreeEnergyCapacity(creep);
  const energyCapacity = Math.max(0, carriedEnergy + freeCapacity);
  const controller = room == null ? void 0 : room.controller;
  const nearbyStructures = structures.filter((structure) => getRangeBetweenRoomObjects(creep, structure) <= NEARBY_STRUCTURE_RANGE);
  const nearbyRoadCount = nearbyStructures.filter((structure) => isStructureType(structure, "STRUCTURE_ROAD", "road")).length;
  const nearbyContainerCount = nearbyStructures.filter(
    (structure) => isStructureType(structure, "STRUCTURE_CONTAINER", "container")
  ).length;
  const containerCount = structures.filter(
    (structure) => isStructureType(structure, "STRUCTURE_CONTAINER", "container")
  ).length;
  const droppedEnergyAvailable = sumDroppedEnergy(droppedResources);
  const spawnExtensionNeedCount = myStructures.filter(
    (structure) => isStructureType(structure, "STRUCTURE_SPAWN", "spawn") || isStructureType(structure, "STRUCTURE_EXTENSION", "extension")
  ).length;
  const towerNeedCount = myStructures.filter(
    (structure) => isStructureType(structure, "STRUCTURE_TOWER", "tower")
  ).length;
  return {
    roomName: (_d = room == null ? void 0 : room.name) != null ? _d : "unknown",
    ...buildPositionState(creep.pos),
    carriedEnergy,
    freeCapacity,
    energyCapacity,
    energyLoadRatio: roundRatio(carriedEnergy, energyCapacity),
    currentTask,
    currentTaskCode: (_e = CURRENT_TASK_CODE[currentTask]) != null ? _e : CURRENT_TASK_CODE.none,
    ...numberField("roomEnergyAvailable", room == null ? void 0 : room.energyAvailable),
    ...numberField("roomEnergyCapacity", room == null ? void 0 : room.energyCapacityAvailable),
    workerCount: 0,
    spawnExtensionNeedCount,
    towerNeedCount,
    constructionSiteCount: constructionSites.length,
    repairTargetCount: countRepairTargets(structures),
    sourceCount: sources.length,
    hasContainerEnergy: containerCount > 0,
    containerEnergyAvailable: 0,
    droppedEnergyAvailable,
    nearbyRoadCount,
    nearbyContainerCount,
    roadCoverage: roundRatio(nearbyRoadCount, NEARBY_TILE_COUNT),
    hostileCreepCount: hostileCreeps.length,
    ...buildControllerState(controller)
  };
}
function buildPositionState(position) {
  if (!position) {
    return {};
  }
  return {
    x: finiteNumber(position.x),
    y: finiteNumber(position.y)
  };
}
function buildControllerState(controller) {
  if (!(controller == null ? void 0 : controller.my)) {
    return {};
  }
  const progress = finiteNumber(controller.progress);
  const progressTotal = finiteNumber(controller.progressTotal);
  return {
    ...numberField("controllerLevel", controller.level),
    ...numberField("controllerTicksToDowngrade", controller.ticksToDowngrade),
    ...progress !== void 0 && progressTotal !== void 0 && progressTotal > 0 ? { controllerProgressRatio: roundRatio(progress, progressTotal) } : {}
  };
}
function countRepairTargets(structures) {
  return structures.filter((structure) => {
    const hits = finiteNumber(structure.hits);
    const hitsMax = finiteNumber(structure.hitsMax);
    if (hits === void 0 || hitsMax === void 0 || hits >= hitsMax) {
      return false;
    }
    return isStructureType(structure, "STRUCTURE_ROAD", "road") || isStructureType(structure, "STRUCTURE_CONTAINER", "container") || isStructureType(structure, "STRUCTURE_RAMPART", "rampart") && structure.my !== false;
  }).length;
}
function findRoomObjects6(room, findConstant) {
  if (!room || typeof room.find !== "function" || typeof findConstant !== "number") {
    return [];
  }
  try {
    const objects = room.find(findConstant);
    return Array.isArray(objects) ? objects : [];
  } catch (_error) {
    return [];
  }
}
function getFindConstant3(name) {
  const value = globalThis[name];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function getUsedEnergy(target) {
  var _a, _b, _c;
  const value = (_b = (_a = target.store) == null ? void 0 : _a.getUsedCapacity) == null ? void 0 : _b.call(_a, getEnergyResourceConstant());
  return Math.max(0, (_c = finiteNumber(value)) != null ? _c : 0);
}
function getFreeEnergyCapacity(target) {
  var _a, _b, _c;
  const value = (_b = (_a = target.store) == null ? void 0 : _a.getFreeCapacity) == null ? void 0 : _b.call(_a, getEnergyResourceConstant());
  return Math.max(0, (_c = finiteNumber(value)) != null ? _c : 0);
}
function getEnergyResourceConstant() {
  var _a;
  return (_a = globalThis.RESOURCE_ENERGY) != null ? _a : "energy";
}
function sumDroppedEnergy(resources) {
  return resources.reduce((total, resource) => {
    var _a;
    if (resource.resourceType !== getEnergyResourceConstant()) {
      return total;
    }
    return total + Math.max(0, (_a = finiteNumber(resource.amount)) != null ? _a : 0);
  }, 0);
}
function isStructureType(structure, globalName, fallback) {
  const globalValue = globalThis[globalName];
  return structure.structureType === globalValue || structure.structureType === fallback;
}
function getRangeBetweenRoomObjects(left, right) {
  var _a, _b;
  const range = (_b = (_a = left.pos) == null ? void 0 : _a.getRangeTo) == null ? void 0 : _b.call(_a, right);
  if (typeof range === "number" && Number.isFinite(range)) {
    return range;
  }
  const leftPosition = left.pos;
  const rightPosition = right.pos;
  if (leftPosition && rightPosition && leftPosition.roomName === rightPosition.roomName && typeof leftPosition.x === "number" && typeof leftPosition.y === "number" && typeof rightPosition.x === "number" && typeof rightPosition.y === "number") {
    return Math.max(Math.abs(leftPosition.x - rightPosition.x), Math.abs(leftPosition.y - rightPosition.y));
  }
  return Number.MAX_SAFE_INTEGER;
}
function getGameTick() {
  var _a;
  const tick = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof tick === "number" && Number.isFinite(tick) ? tick : 0;
}
function numberField(key, value) {
  const number = finiteNumber(value);
  if (number === void 0) {
    return {};
  }
  return { [key]: number };
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function roundRatio(numerator, denominator) {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round(numerator / denominator * 1e3) / 1e3;
}

// src/rl/workerTaskBcModel.ts
var WORKER_TASK_BC_MODEL = {
  type: "worker-task-bc-decision-tree",
  schemaVersion: 1,
  policyId: "worker-task-bc.untrained.v1",
  source: "placeholder",
  liveEffect: false,
  minConfidence: 0.9,
  actionTypes: ["harvest", "transfer", "build", "repair", "upgrade"],
  features: [],
  root: null,
  metadata: {
    trainingSampleCount: 0,
    evaluationSampleCount: 0,
    evaluationMatchRate: null,
    notes: "No trained artifact is bundled yet; runtime remains heuristic-only."
  }
};

// src/rl/workerTaskPolicy.ts
var testingModelOverride = null;
function selectWorkerTaskWithBcFallback(creep, heuristicTask) {
  var _a;
  const memory = creep.memory;
  const model = getActiveWorkerTaskBcModel();
  const state = (_a = memory == null ? void 0 : memory.workerBehavior) == null ? void 0 : _a.state;
  if (memory && !state) {
    delete memory.workerTaskPolicyShadow;
    return heuristicTask;
  }
  const prediction = state ? predictWorkerTaskAction(model, state) : null;
  const heuristicAction = isWorkerTaskBehaviorActionType(heuristicTask == null ? void 0 : heuristicTask.type) ? heuristicTask.type : void 0;
  if (memory) {
    memory.workerTaskPolicyShadow = {
      type: "workerTaskPolicyShadow",
      schemaVersion: WORKER_TASK_BEHAVIOR_SCHEMA_VERSION,
      tick: getGameTick2(),
      policyId: model.policyId,
      liveEffect: false,
      ...prediction ? { predictedAction: prediction.action, confidence: prediction.confidence } : {},
      ...heuristicAction ? { heuristicAction } : {},
      matched: Boolean(prediction && heuristicAction && prediction.action === heuristicAction),
      ...buildFallbackReason(model, prediction, heuristicAction)
    };
  }
  return heuristicTask;
}
function predictWorkerTaskAction(model, state) {
  if (!isUsableModel(model)) {
    return null;
  }
  const leaf = evaluateNode(model.root, state);
  if (!leaf || leaf.confidence < model.minConfidence) {
    return null;
  }
  return {
    policyId: model.policyId,
    action: leaf.action,
    confidence: leaf.confidence
  };
}
function getActiveWorkerTaskBcModel() {
  return testingModelOverride != null ? testingModelOverride : WORKER_TASK_BC_MODEL;
}
function isUsableModel(model) {
  return model.type === "worker-task-bc-decision-tree" && model.schemaVersion === 1 && model.liveEffect === false && model.root !== null && model.actionTypes.every((action) => WORKER_TASK_BC_ACTION_TYPES.includes(action));
}
function evaluateNode(node, state) {
  if (!node) {
    return null;
  }
  if (node.type === "leaf") {
    return node;
  }
  const featureValue = getFeatureValue(state, node.feature);
  if (featureValue === null) {
    return evaluateNode(node.missing === "left" ? node.left : node.right, state);
  }
  return evaluateNode(featureValue <= node.threshold ? node.left : node.right, state);
}
function getFeatureValue(state, feature) {
  const value = state[feature];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return null;
}
function buildFallbackReason(model, prediction, heuristicAction) {
  if (!isUsableModel(model)) {
    return { fallbackReason: "untrainedModel" };
  }
  if (!prediction) {
    return { fallbackReason: "lowConfidence" };
  }
  if (!heuristicAction) {
    return { fallbackReason: "unsupportedHeuristicAction" };
  }
  if (prediction.action !== heuristicAction) {
    return { fallbackReason: "actionMismatch" };
  }
  return {};
}
function getGameTick2() {
  var _a;
  const tick = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof tick === "number" && Number.isFinite(tick) ? tick : 0;
}

// src/tasks/workerTasks.ts
var CONTROLLER_DOWNGRADE_GUARD_TICKS2 = 5e3;
var CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO = 0.5;
var IDLE_RAMPART_REPAIR_HITS_CEILING2 = 1e5;
var TOWER_REFILL_ENERGY_FLOOR = 500;
var CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD = 200;
var URGENT_SPAWN_REFILL_ENERGY_THRESHOLD = CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD;
var NEAR_TERM_SPAWN_EXTENSION_REFILL_RESERVE_TICKS = 50;
var MINIMUM_USEFUL_LOAD_RATIO = 0.4;
var LOW_LOAD_NEARBY_ENERGY_RANGE = 3;
var LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE = 6;
var BUILDER_STORAGE_WITHDRAW_MIN = 100;
var BUILDER_DROPPED_PICKUP_RANGE = 5;
var DEFAULT_SPAWN_ENERGY_CAPACITY = 300;
var MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS = 2;
var MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE = 1;
var MIN_DROPPED_ENERGY_PICKUP_AMOUNT = 25;
var MIN_SPAWN_RECOVERY_DROPPED_ENERGY_PICKUP_AMOUNT = 10;
var MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT = 2;
var ENERGY_ACQUISITION_RANGE_COST = 50;
var ENERGY_ACQUISITION_ACTION_TICKS = 1;
var WORKER_ENERGY_SURPLUS_SCORE_RATIO = 0.4;
var HARVEST_ENERGY_PER_WORK_PART = 2;
var SPAWN_EXTENSION_THROUGHPUT_STORAGE_REFILL_EMPTY_CAPACITY_RATIO = 0.2;
var SPAWN_EXTENSION_THROUGHPUT_STORAGE_REFILL_RESERVE_FLOOR = 1e3;
var DEFAULT_BUILD_POWER = 5;
var NEARLY_COMPLETE_CONSTRUCTION_SITE_REMAINING_RATIO = 0.2;
var NEARLY_COMPLETE_CONSTRUCTION_SITE_FINISH_PRIORITY_MULTIPLIER = 2;
var FINISHABLE_CONSTRUCTION_SITE_PRIORITY_MULTIPLIER = 2;
var MAX_DROPPED_ENERGY_REACHABILITY_CHECKS = 5;
var DEFAULT_SOURCE_ENERGY_CAPACITY = 3e3;
var DEFAULT_SOURCE_ENERGY_REGEN_TICKS = 300;
var MAX_CONTROLLER_LEVEL = 8;
var UPGRADER_BOOST_CONTROLLER_PROGRESS_RATIO = 0.9;
var UPGRADER_BOOST_LOW_ENERGY_RATIO = 0.5;
var SOURCE2_CONTROLLER_LANE_SOURCE_INDEX = 1;
var SOURCE2_CONTROLLER_LANE_MAX_RANGE = 6;
var MIN_LOADED_WORKERS_FOR_SECOND_SUSTAINED_CONTROLLER_PROGRESS = 4;
var MIN_LOADED_WORKERS_FOR_SURPLUS_CONTROLLER_PROGRESS = 5;
var MAX_SUSTAINED_CONTROLLER_PROGRESS_WORKERS = 2;
var MAX_SURPLUS_CONTROLLER_PROGRESS_WORKERS = 3;
var BASELINE_WORKER_THROUGHPUT_ENERGY_CAPACITY = 550;
var BUILDER_STORAGE_ACQUISITION_SITE_RANGE = BUILDER_DROPPED_PICKUP_RANGE;
var nearTermSpawnExtensionRefillReserveCache = null;
function selectWorkerTask(creep) {
  clearWorkerEfficiencyTelemetry(creep);
  const heuristicTask = selectHeuristicWorkerTask(creep);
  recordWorkerTaskBehaviorTrace(creep, heuristicTask);
  return selectWorkerTaskWithBcFallback(creep, heuristicTask);
}
function selectHeuristicWorkerTask(creep) {
  var _a;
  const survivalAssessment = getWorkerColonySurvivalAssessment(creep);
  const territoryWorkSuppressed = suppressesTerritoryWork(survivalAssessment);
  const bootstrapNonCriticalWorkSuppressed = suppressesBootstrapNonCriticalWork(survivalAssessment);
  const recoveryOnlyWorkSuppressed = bootstrapNonCriticalWorkSuppressed || territoryWorkSuppressed;
  const remoteProductiveSpendingSuppressed = recoveryOnlyWorkSuppressed && !isWorkerInColonyRoom(creep);
  const carriedEnergy = getUsedEnergy2(creep);
  const urgentReservationRenewalTask = territoryWorkSuppressed ? null : selectUrgentVisibleReservationRenewalTask(creep);
  const territoryControllerTask = territoryWorkSuppressed ? null : selectVisibleTerritoryControllerTask(creep);
  if (carriedEnergy === 0) {
    if (urgentReservationRenewalTask) {
      return urgentReservationRenewalTask;
    }
    if (isTerritoryControlTask(territoryControllerTask)) {
      return territoryControllerTask;
    }
    let hasPriorityEnergySink = false;
    if (getFreeEnergyCapacity2(creep) > 0) {
      const spawnRecoveryEnergySink = selectFillableEnergySink(creep);
      if (spawnRecoveryEnergySink) {
        hasPriorityEnergySink = true;
        const spawnRecoveryHarvestCandidate = selectSpawnRecoveryHarvestCandidate(creep, spawnRecoveryEnergySink);
        const spawnRecoveryTask = selectSpawnRecoveryEnergyAcquisitionTask(
          creep,
          spawnRecoveryEnergySink,
          (_a = spawnRecoveryHarvestCandidate == null ? void 0 : spawnRecoveryHarvestCandidate.deliveryEta) != null ? _a : null
        );
        if (spawnRecoveryTask) {
          return spawnRecoveryTask;
        }
        if (spawnRecoveryHarvestCandidate) {
          return { type: "harvest", targetId: spawnRecoveryHarvestCandidate.source.id };
        }
      }
      if (shouldStandbySurplusWorkerInsteadOfAcquiring(creep, creep.room.controller)) {
        return null;
      }
      const upgraderBoostEnergyAcquisitionTask = selectUpgraderBoostEnergyAcquisitionTask(creep, creep.room.controller);
      if (upgraderBoostEnergyAcquisitionTask) {
        return upgraderBoostEnergyAcquisitionTask;
      }
      const builderEnergyAcquisitionTask = selectBuilderEnergyAcquisitionTask(creep);
      if (builderEnergyAcquisitionTask) {
        return builderEnergyAcquisitionTask;
      }
      const nearbyContainerEnergyAcquisitionTask = selectNearbyContainerWorkerEnergyAcquisitionTask(creep);
      if (nearbyContainerEnergyAcquisitionTask) {
        return nearbyContainerEnergyAcquisitionTask;
      }
      const storageRefillAcquisitionTask = selectStorageToSpawnExtensionRefillAcquisitionTask(creep);
      if (storageRefillAcquisitionTask) {
        return storageRefillAcquisitionTask;
      }
      const source2ControllerLaneHarvestTask = selectSource2ControllerLaneHarvestTask(creep);
      if (source2ControllerLaneHarvestTask) {
        return source2ControllerLaneHarvestTask;
      }
      const sourceContainerHarvestTask = selectSourceContainerHarvestTask(creep);
      if (sourceContainerHarvestTask) {
        return sourceContainerHarvestTask;
      }
      if (!hasPriorityEnergySink) {
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
  const controller = creep.room.controller;
  if (controller && shouldGuardControllerDowngrade(controller) && canUpgradeController(controller) && !remoteProductiveSpendingSuppressed) {
    const downgradeGuardTask = {
      type: "upgrade",
      targetId: controller.id
    };
    recordLowLoadReturnTelemetry(creep, downgradeGuardTask, "controllerDowngradeGuard");
    return downgradeGuardTask;
  }
  const spawnOrExtensionEnergySink = selectSpawnOrExtensionEnergySink(creep);
  if (spawnOrExtensionEnergySink) {
    const spawnOrExtensionRefillTask = {
      type: "transfer",
      targetId: spawnOrExtensionEnergySink.id
    };
    if (isCriticalSpawnEnergySink(spawnOrExtensionEnergySink)) {
      recordSpawnCriticalRefillTelemetry(creep, spawnOrExtensionEnergySink);
    }
    if (hasEmergencySpawnExtensionRefillDemand(creep)) {
      recordLowLoadReturnTelemetry(creep, spawnOrExtensionRefillTask, "emergencySpawnExtensionRefill");
      return spawnOrExtensionRefillTask;
    }
    return applyMinimumUsefulLoadPolicy(creep, spawnOrExtensionRefillTask);
  }
  if (remoteProductiveSpendingSuppressed) {
    const suppressedRemoteEnergyHandlingTask = selectSuppressedRemoteEnergyHandlingTask(creep);
    if (suppressedRemoteEnergyHandlingTask) {
      return suppressedRemoteEnergyHandlingTask;
    }
    return null;
  }
  const upgraderBoostUpgradeTask = selectUpgraderBoostUpgradeTask(creep, controller, carriedEnergy);
  if (upgraderBoostUpgradeTask) {
    return upgraderBoostUpgradeTask;
  }
  const controllerSustainUpgradeTask = selectControllerSustainUpgradeTask(creep, controller);
  if (controllerSustainUpgradeTask) {
    return applyMinimumUsefulLoadPolicy(creep, controllerSustainUpgradeTask);
  }
  const constructionSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  const constructionReservationContext = constructionSites.length > 0 ? createConstructionReservationContext(creep.room) : createEmptyConstructionReservationContext();
  const capacityConstructionSite = selectCapacityEnablingConstructionSite(
    creep,
    constructionSites,
    controller,
    constructionReservationContext
  );
  if (territoryControllerTask && capacityConstructionSite && isSpawnConstructionSite(capacityConstructionSite)) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "build", targetId: capacityConstructionSite.id });
  }
  if (!territoryControllerTask) {
    const baselineLogisticsConstructionSite = selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(
      creep,
      capacityConstructionSite,
      constructionSites,
      constructionReservationContext
    );
    if (baselineLogisticsConstructionSite) {
      return applyMinimumUsefulLoadPolicy(creep, {
        type: "build",
        targetId: baselineLogisticsConstructionSite.id
      });
    }
    if (capacityConstructionSite) {
      return applyMinimumUsefulLoadPolicy(creep, { type: "build", targetId: capacityConstructionSite.id });
    }
  }
  const priorityTowerEnergySink = selectPriorityTowerEnergySink(creep);
  if (priorityTowerEnergySink) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: "transfer",
      targetId: priorityTowerEnergySink.id
    });
  }
  if (!remoteProductiveSpendingSuppressed) {
    const lowLoadEnergyAcquisitionCandidate = selectLowLoadWorkerEnergyAcquisitionCandidate(creep);
    if (lowLoadEnergyAcquisitionCandidate) {
      recordNearbyEnergyChoiceTelemetry(creep, lowLoadEnergyAcquisitionCandidate);
      return lowLoadEnergyAcquisitionCandidate.task;
    }
  }
  if (bootstrapNonCriticalWorkSuppressed) {
    return selectBootstrapSurvivalSpendingTask(
      creep,
      controller,
      constructionSites,
      constructionReservationContext,
      recoveryOnlyWorkSuppressed
    );
  }
  const readyFollowUpProductiveEnergySinkTask = selectReadyFollowUpProductiveEnergySinkTask(
    creep,
    capacityConstructionSite,
    controller,
    constructionSites,
    constructionReservationContext
  );
  if (readyFollowUpProductiveEnergySinkTask) {
    return applyMinimumUsefulLoadPolicy(creep, readyFollowUpProductiveEnergySinkTask);
  }
  if (territoryControllerTask) {
    return territoryControllerTask;
  }
  const source2ControllerLaneLoadedTask = controller ? selectSource2ControllerLaneLoadedTask(creep, controller, constructionSites, constructionReservationContext) : null;
  if (source2ControllerLaneLoadedTask) {
    return applyMinimumUsefulLoadPolicy(creep, source2ControllerLaneLoadedTask);
  }
  if (capacityConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "build", targetId: capacityConstructionSite.id });
  }
  if (controller && shouldRushRcl1Controller(controller)) {
    return canLevelUpController(controller) ? applyMinimumUsefulLoadPolicy(creep, { type: "upgrade", targetId: controller.id }) : null;
  }
  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: "repair",
      targetId: criticalRepairTarget.id
    });
  }
  if (shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)) {
    return null;
  }
  const constructionPriorityContext = buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites);
  const highImpactConstructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    (site) => isHighImpactConstructionSite(site, constructionPriorityContext),
    {
      priorityContext: constructionPriorityContext,
      requireReasonableRange: true
    }
  );
  if (highImpactConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "build", targetId: highImpactConstructionSite.id });
  }
  if (controller && shouldUseSurplusForControllerProgress(creep, controller)) {
    const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(
      creep,
      constructionSites,
      controller,
      constructionReservationContext
    );
    if (productiveEnergySinkTask) {
      return applyMinimumUsefulLoadPolicy(creep, productiveEnergySinkTask);
    }
    return canLevelUpController(controller) ? applyMinimumUsefulLoadPolicy(creep, { type: "upgrade", targetId: controller.id }) : null;
  }
  const constructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    () => true,
    { priorityContext: constructionPriorityContext }
  );
  if (constructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "build", targetId: constructionSite.id });
  }
  const repairTarget = selectRepairTarget(creep);
  if (repairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "repair", targetId: repairTarget.id });
  }
  if ((controller == null ? void 0 : controller.my) && canUpgradeController(controller)) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "upgrade", targetId: controller.id });
  }
  if (shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)) {
    return null;
  }
  return null;
}
function getWorkerColonySurvivalAssessment(creep) {
  return getRecordedColonySurvivalAssessment(getCreepColonyName(creep));
}
function isWorkerInColonyRoom(creep) {
  const colonyName = getCreepColonyName(creep);
  return colonyName !== null && getRoomName2(creep.room) === colonyName;
}
function selectSuppressedRemoteEnergyHandlingTask(creep) {
  const priorityTowerEnergySink = selectPriorityTowerEnergySink(creep);
  if (priorityTowerEnergySink) {
    return { type: "transfer", targetId: priorityTowerEnergySink.id };
  }
  return selectColonyRecallEnergySpendingTask(creep);
}
function selectColonyRecallEnergySpendingTask(creep) {
  const colonyRoom = getCreepColonyRoom(creep);
  if (!colonyRoom || isInRoom(creep, colonyRoom)) {
    return null;
  }
  const energySink = selectColonyRecallEnergySink(colonyRoom);
  if (energySink) {
    return { type: "transfer", targetId: energySink.id };
  }
  const controller = colonyRoom.controller;
  if (!controller) {
    return null;
  }
  return canUpgradeController(controller) ? { type: "upgrade", targetId: controller.id } : null;
}
function selectColonyRecallEnergySink(room) {
  var _a;
  const energySinks = findFillableEnergySinksInRoom(room);
  return (_a = selectFirstEnergySinkByStableId(energySinks.filter(isSpawnOrExtensionEnergySink))) != null ? _a : selectFirstEnergySinkByStableId(energySinks.filter(isTowerEnergySink));
}
function selectControllerSustainUpgradeTask(creep, controller) {
  var _a, _b;
  const sustain = (_a = creep.memory) == null ? void 0 : _a.controllerSustain;
  if ((sustain == null ? void 0 : sustain.role) !== "upgrader" || sustain.targetRoom !== ((_b = creep.room) == null ? void 0 : _b.name) || (controller == null ? void 0 : controller.my) !== true || !canUpgradeController(controller)) {
    return null;
  }
  return { type: "upgrade", targetId: controller.id };
}
function selectUpgraderBoostUpgradeTask(creep, controller, carriedEnergy) {
  if (carriedEnergy <= 0 || !isUpgraderBoostActive(creep, controller)) {
    return null;
  }
  return { type: "upgrade", targetId: controller.id };
}
function selectUpgraderBoostEnergyAcquisitionTask(creep, controller) {
  if (!isUpgraderBoostActive(creep, controller) || !hasLowEnergyForUpgraderBoost(creep) || getFreeEnergyCapacity2(creep) <= 0) {
    return null;
  }
  const context = {
    creepOwnerUsername: getCreepOwnerUsername2(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const candidates = findVisibleRoomStructures(creep.room).filter(
    (structure) => isSafeStoredEnergySource(structure, context) && isUpgraderBoostStoredEnergySource(structure)
  ).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getStoredEnergy2(source),
      {
        type: "withdraw",
        targetId: source.id
      },
      reservationContext
    );
    return candidate ? [candidate] : [];
  });
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}
function isUpgraderBoostActive(creep, controller) {
  return isUpgraderCreep(creep) && !hasVisibleHostilePresence(creep.room) && isControllerNearLevelUp(controller);
}
function isUpgraderCreep(creep) {
  var _a, _b, _c;
  return ((_a = creep.memory) == null ? void 0 : _a.role) === "upgrader" || ((_c = (_b = creep.memory) == null ? void 0 : _b.controllerSustain) == null ? void 0 : _c.role) === "upgrader";
}
function isControllerNearLevelUp(controller) {
  if (!controller || !canLevelUpController(controller)) {
    return false;
  }
  const progress = controller.progress;
  const progressTotal = controller.progressTotal;
  return typeof progress === "number" && Number.isFinite(progress) && typeof progressTotal === "number" && Number.isFinite(progressTotal) && progressTotal > 0 && Math.max(0, progress) / progressTotal >= UPGRADER_BOOST_CONTROLLER_PROGRESS_RATIO;
}
function hasLowEnergyForUpgraderBoost(creep) {
  const carriedEnergy = getUsedEnergy2(creep);
  const freeCapacity = getFreeEnergyCapacity2(creep);
  const capacity = getEnergyCapacity(creep, carriedEnergy, freeCapacity);
  return capacity > 0 && carriedEnergy < capacity * UPGRADER_BOOST_LOW_ENERGY_RATIO;
}
function isUpgraderBoostStoredEnergySource(source) {
  return matchesStructureType6(source.structureType, "STRUCTURE_CONTAINER", "container") || matchesStructureType6(source.structureType, "STRUCTURE_STORAGE", "storage");
}
function selectFirstEnergySinkByStableId(energySinks) {
  var _a;
  return (_a = [...energySinks].sort(compareEnergySinkId)[0]) != null ? _a : null;
}
function selectBootstrapSurvivalSpendingTask(creep, controller, constructionSites, constructionReservationContext, recoveryOnlyWorkSuppressed) {
  if (controller && shouldRushRcl1Controller(controller) && canLevelUpController(controller) && !shouldSuppressBootstrapControllerSpending(creep, recoveryOnlyWorkSuppressed)) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "upgrade", targetId: controller.id });
  }
  if (recoveryOnlyWorkSuppressed && !isWorkerInColonyRoom(creep)) {
    return null;
  }
  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return applyMinimumUsefulLoadPolicy(creep, {
      type: "repair",
      targetId: criticalRepairTarget.id
    });
  }
  if (shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep)) {
    return null;
  }
  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext
  );
  if (criticalRoadConstructionSite) {
    return applyMinimumUsefulLoadPolicy(creep, { type: "build", targetId: criticalRoadConstructionSite.id });
  }
  return null;
}
function shouldSuppressBootstrapControllerSpending(creep, recoveryOnlyWorkSuppressed) {
  return recoveryOnlyWorkSuppressed && !isWorkerInColonyRoom(creep);
}
function selectRemoteHaulerDeliveryTask(room) {
  const sink = selectRemoteHaulerDeliverySink(room);
  return sink ? { type: "transfer", targetId: sink.id } : null;
}
function estimateNearTermSpawnExtensionRefillReserveFromStructures(room, spawnExtensionEnergyStructures) {
  if (spawnExtensionEnergyStructures.length === 0) {
    return 0;
  }
  const roomRefillShortfall = estimateRoomEnergyRefillShortfall(room);
  const immediateRefillCapacity = spawnExtensionEnergyStructures.reduce(
    (total, structure) => total + getFreeStoredEnergyCapacity(structure),
    0
  );
  const immediateRefillReserve = roomRefillShortfall === null ? immediateRefillCapacity : Math.min(immediateRefillCapacity, roomRefillShortfall);
  return Math.max(
    immediateRefillReserve,
    estimateNearTermSpawnCompletionRefillReserve(room, spawnExtensionEnergyStructures)
  );
}
function estimateNearTermSpawnCompletionRefillReserve(room, spawnExtensionEnergyStructures) {
  var _a;
  if (!spawnExtensionEnergyStructures.some(isNearTermSpawningSpawn)) {
    return 0;
  }
  return Math.max(0, (_a = getRoomEnergyCapacityAvailable(room)) != null ? _a : 0);
}
function isTerritoryControlTask(task) {
  return (task == null ? void 0 : task.type) === "claim" || (task == null ? void 0 : task.type) === "reserve";
}
function hasEmergencySpawnExtensionRefillDemand(creep) {
  const energyAvailable = getRoomEnergyAvailable(creep.room);
  return energyAvailable === null || energyAvailable < URGENT_SPAWN_REFILL_ENERGY_THRESHOLD;
}
function getLowLoadWorkerEnergyContext(creep) {
  const carriedEnergy = getUsedEnergy2(creep);
  const freeCapacity = getFreeEnergyCapacity2(creep);
  if (carriedEnergy <= 0 || freeCapacity <= 0) {
    return null;
  }
  const capacity = getEnergyCapacity(creep, carriedEnergy, freeCapacity);
  return capacity > 0 && carriedEnergy < capacity * MINIMUM_USEFUL_LOAD_RATIO ? { carriedEnergy, capacity, freeCapacity } : null;
}
function applyMinimumUsefulLoadPolicy(creep, task) {
  if (!getLowLoadWorkerEnergyContext(creep)) {
    return task;
  }
  if (hasVisibleHostilePresence(creep.room)) {
    recordLowLoadReturnTelemetry(creep, task, "hostileSafety");
    return task;
  }
  const lowLoadEnergyContinuationTask = selectLowLoadWorkerEnergyContinuationTask(creep);
  if (lowLoadEnergyContinuationTask) {
    return lowLoadEnergyContinuationTask;
  }
  recordLowLoadReturnTelemetry(creep, task, "noReachableEnergy");
  return task;
}
function clearWorkerEfficiencyTelemetry(creep) {
  const memory = creep.memory;
  if (memory) {
    delete memory.workerEfficiency;
  }
}
function recordSpawnCriticalRefillTelemetry(creep, spawn) {
  var _a, _b;
  const memory = creep.memory;
  if (!memory) {
    return;
  }
  memory.spawnCriticalRefill = {
    type: "spawnCriticalRefill",
    tick: (_a = getGameTick3()) != null ? _a : 0,
    targetId: String(spawn.id),
    carriedEnergy: getUsedEnergy2(creep),
    spawnEnergy: (_b = getKnownStoredEnergy(spawn)) != null ? _b : 0,
    freeCapacity: getFreeStoredEnergyCapacity(spawn),
    threshold: CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD
  };
}
function recordNearbyEnergyChoiceTelemetry(creep, candidate) {
  var _a;
  const context = getLowLoadWorkerEnergyContext(creep);
  const memory = creep.memory;
  if (!context || !memory) {
    return;
  }
  memory.workerEfficiency = {
    type: "nearbyEnergyChoice",
    tick: (_a = getGameTick3()) != null ? _a : 0,
    carriedEnergy: context.carriedEnergy,
    freeCapacity: context.freeCapacity,
    selectedTask: candidate.task.type,
    targetId: String(candidate.task.targetId),
    energy: Math.max(0, Math.floor(candidate.energy)),
    ...candidate.range === null ? {} : { range: candidate.range }
  };
}
function recordLowLoadReturnTelemetry(creep, task, reason) {
  var _a;
  const context = getLowLoadWorkerEnergyContext(creep);
  const memory = creep.memory;
  if (!context || !memory) {
    return;
  }
  memory.workerEfficiency = {
    type: "lowLoadReturn",
    tick: (_a = getGameTick3()) != null ? _a : 0,
    carriedEnergy: context.carriedEnergy,
    freeCapacity: context.freeCapacity,
    selectedTask: task.type,
    targetId: String(task.targetId),
    reason
  };
}
function isFillableEnergySink(structure) {
  return (matchesStructureType6(structure.structureType, "STRUCTURE_SPAWN", "spawn") || matchesStructureType6(structure.structureType, "STRUCTURE_EXTENSION", "extension") || matchesStructureType6(structure.structureType, "STRUCTURE_TOWER", "tower")) && "store" in structure && getFreeStoredEnergyCapacity(structure) > 0;
}
function selectFillableEnergySink(creep) {
  var _a;
  return (_a = selectSpawnOrExtensionEnergySink(creep)) != null ? _a : selectPriorityTowerEnergySink(creep);
}
function selectSpawnOrExtensionEnergySink(creep) {
  const energySinks = findFillableEnergySinks(creep).filter(isSpawnOrExtensionEnergySink);
  if (energySinks.length === 0) {
    return null;
  }
  const loadedWorkers = getSameRoomLoadedWorkersForRefillReservations(creep);
  const reservedEnergyDeliveries = getReservedEnergyDeliveriesBySinkId(creep, loadedWorkers);
  const assignedTransferTargetId = getAssignedTransferTargetId(creep);
  const unreservedEnergySink = selectSpawnExtensionRecoveryEnergySink(
    energySinks.filter((energySink) => hasUnreservedEnergySinkCapacity(energySink, reservedEnergyDeliveries)),
    creep,
    reservedEnergyDeliveries,
    assignedTransferTargetId
  );
  return unreservedEnergySink != null ? unreservedEnergySink : selectCloserReservedEnergySinkFallback(energySinks, creep, loadedWorkers, reservedEnergyDeliveries);
}
function selectStorageToSpawnExtensionRefillAcquisitionTask(creep) {
  if (!isSpawnExtensionThroughputBottlenecked(creep.room) || getFreeEnergyCapacity2(creep) <= 0) {
    return null;
  }
  const storage = selectStorageForSpawnExtensionRefill(creep);
  if (!storage) {
    return null;
  }
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const storageEnergy = getStoredEnergy2(storage);
  const availableStorageEnergy = getUnreservedWorkerEnergyAcquisitionAmount(storage, storageEnergy, reservationContext);
  const plannedWithdrawal = Math.min(
    storageEnergy,
    creep.store.getFreeCapacity(RESOURCE_ENERGY),
    availableStorageEnergy
  );
  if (plannedWithdrawal <= 0) {
    return null;
  }
  const projectedStorageEnergy = availableStorageEnergy - plannedWithdrawal;
  return projectedStorageEnergy > SPAWN_EXTENSION_THROUGHPUT_STORAGE_REFILL_RESERVE_FLOOR ? { type: "withdraw", targetId: storage.id } : null;
}
function isSpawnExtensionThroughputBottlenecked(room) {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyAvailable === null || energyCapacityAvailable === null || energyCapacityAvailable <= 0) {
    return false;
  }
  const freeEnergyCapacity = Math.max(0, energyCapacityAvailable - energyAvailable);
  return freeEnergyCapacity > energyCapacityAvailable * SPAWN_EXTENSION_THROUGHPUT_STORAGE_REFILL_EMPTY_CAPACITY_RATIO;
}
function selectStorageForSpawnExtensionRefill(creep) {
  const context = {
    creepOwnerUsername: getCreepOwnerUsername2(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const storageSources = findVisibleRoomStructures(creep.room).filter(
    (structure) => isSafeStoredEnergySource(structure, context) && structure.structureType === "storage" && getStoredEnergy2(structure) > SPAWN_EXTENSION_THROUGHPUT_STORAGE_REFILL_RESERVE_FLOOR
  );
  if (storageSources.length === 0) {
    return null;
  }
  const scoredStorageSources = scoreStoredEnergySources(creep, storageSources);
  if (scoredStorageSources.length > 0) {
    return scoredStorageSources.sort(compareStoredEnergySourceScores)[0].source;
  }
  const closestStorageEnergy = findClosestByRange(creep, storageSources);
  return closestStorageEnergy ? closestStorageEnergy : storageSources[0];
}
function selectSpawnExtensionRecoveryEnergySink(energySinks, creep, reservedEnergyDeliveries, assignedTransferTargetId) {
  if (energySinks.length === 0) {
    return null;
  }
  return [...energySinks].sort(
    (left, right) => compareSpawnExtensionRecoveryEnergySinks(
      left,
      right,
      creep,
      reservedEnergyDeliveries,
      assignedTransferTargetId
    )
  )[0];
}
function compareSpawnExtensionRecoveryEnergySinks(left, right, creep, reservedEnergyDeliveries, assignedTransferTargetId) {
  const carriedEnergy = getUsedEnergy2(creep);
  const leftDeliveryCapacity = getUnreservedEnergySinkDeliveryCapacity(left, reservedEnergyDeliveries);
  const rightDeliveryCapacity = getUnreservedEnergySinkDeliveryCapacity(right, reservedEnergyDeliveries);
  return compareCriticalSpawnPriority(left, right) || compareLowEnergySpawnPriority(left, right) || compareAcceptedDeliveryEnergy(leftDeliveryCapacity, rightDeliveryCapacity, carriedEnergy) || compareAssignedTransferTarget(left, right, assignedTransferTargetId) || compareOptionalRanges(getRangeBetweenRoomObjects2(creep, left), getRangeBetweenRoomObjects2(creep, right)) || compareEnergySinkId(left, right);
}
function compareCriticalSpawnPriority(left, right) {
  if (isSpawnEnergySink(left) && isSpawnEnergySink(right)) {
    return 0;
  }
  const leftCriticalSpawn = isCriticalSpawnEnergySink(left);
  const rightCriticalSpawn = isCriticalSpawnEnergySink(right);
  if (leftCriticalSpawn === rightCriticalSpawn) {
    return 0;
  }
  return leftCriticalSpawn ? -1 : 1;
}
function compareLowEnergySpawnPriority(left, right) {
  const leftLowEnergySpawn = isLowEnergySpawn(left);
  const rightLowEnergySpawn = isLowEnergySpawn(right);
  if (leftLowEnergySpawn === rightLowEnergySpawn) {
    return 0;
  }
  return leftLowEnergySpawn ? -1 : 1;
}
function isLowEnergySpawn(structure) {
  return isSpawnEnergySink(structure) && getStoredEnergy2(structure) < getSpawnEnergyCapacity();
}
function isCriticalSpawnEnergySink(structure) {
  const storedEnergy = getKnownStoredEnergy(structure);
  return isSpawnEnergySink(structure) && storedEnergy !== null && storedEnergy < CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD;
}
function getSpawnEnergyCapacity() {
  const spawnEnergyCapacity = globalThis.SPAWN_ENERGY_CAPACITY;
  return typeof spawnEnergyCapacity === "number" && Number.isFinite(spawnEnergyCapacity) && spawnEnergyCapacity > 0 ? spawnEnergyCapacity : DEFAULT_SPAWN_ENERGY_CAPACITY;
}
function compareAcceptedDeliveryEnergy(leftCapacity, rightCapacity, carriedEnergy) {
  if (carriedEnergy <= 0) {
    return 0;
  }
  const leftAcceptedEnergy = Math.min(leftCapacity, carriedEnergy);
  const rightAcceptedEnergy = Math.min(rightCapacity, carriedEnergy);
  return rightAcceptedEnergy - leftAcceptedEnergy;
}
function getUnreservedEnergySinkDeliveryCapacity(energySink, reservedEnergyDeliveries) {
  return Math.max(
    0,
    getFreeStoredEnergyCapacity(energySink) - getReservedEnergyDelivery(energySink, reservedEnergyDeliveries)
  );
}
function compareAssignedTransferTarget(left, right, assignedTransferTargetId) {
  const leftAssigned = isAssignedTransferTarget(left, assignedTransferTargetId);
  const rightAssigned = isAssignedTransferTarget(right, assignedTransferTargetId);
  if (leftAssigned === rightAssigned) {
    return 0;
  }
  return leftAssigned ? -1 : 1;
}
function selectPriorityTowerEnergySink(creep) {
  const priorityTowerEnergySinks = findFillableEnergySinks(creep).filter(isPriorityTowerEnergySink);
  if (priorityTowerEnergySinks.length === 0) {
    return null;
  }
  const loadedWorkers = getSameRoomLoadedWorkersForRefillReservations(creep);
  const reservedEnergyDeliveries = getReservedEnergyDeliveriesBySinkId(creep, loadedWorkers);
  return selectClosestEnergySink(
    priorityTowerEnergySinks.filter(
      (energySink) => hasUnreservedEnergySinkCapacity(energySink, reservedEnergyDeliveries)
    ),
    creep
  );
}
function hasUnreservedEnergySinkCapacity(energySink, reservedEnergyDeliveries) {
  return getReservedEnergyDelivery(energySink, reservedEnergyDeliveries) < getFreeStoredEnergyCapacity(energySink);
}
function selectCloserReservedEnergySinkFallback(energySinks, creep, loadedWorkers, reservedEnergyDeliveries) {
  return selectClosestEnergySink(
    energySinks.filter(
      (energySink) => getReservedEnergyDelivery(energySink, reservedEnergyDeliveries) >= getFreeStoredEnergyCapacity(energySink) && isCloserThanReservedEnergyDelivery(creep, energySink, loadedWorkers)
    ),
    creep
  );
}
function isCloserThanReservedEnergyDelivery(creep, energySink, loadedWorkers) {
  const creepRange = getRangeBetweenRoomObjects2(creep, energySink);
  if (creepRange === null) {
    return false;
  }
  let closestReservedDeliveryRange = null;
  let hasReservedDelivery = false;
  for (const worker of loadedWorkers) {
    if (isSameCreep(worker, creep) || !isWorkerAssignedToEnergySink(worker, energySink)) {
      continue;
    }
    hasReservedDelivery = true;
    const workerRange = getRangeBetweenRoomObjects2(worker, energySink);
    if (workerRange === null) {
      continue;
    }
    closestReservedDeliveryRange = closestReservedDeliveryRange === null ? workerRange : Math.min(closestReservedDeliveryRange, workerRange);
  }
  if (!hasReservedDelivery) {
    return false;
  }
  return closestReservedDeliveryRange === null ? creepRange <= 1 : creepRange < closestReservedDeliveryRange;
}
function isWorkerAssignedToEnergySink(worker, energySink) {
  var _a;
  const task = (_a = worker.memory) == null ? void 0 : _a.task;
  return (task == null ? void 0 : task.type) === "transfer" && String(task.targetId) === String(energySink.id);
}
function getReservedEnergyDeliveriesBySinkId(creep, loadedWorkers) {
  var _a, _b;
  const reservedEnergyDeliveries = /* @__PURE__ */ new Map();
  for (const worker of loadedWorkers) {
    if (isSameCreep(worker, creep)) {
      continue;
    }
    const task = (_a = worker.memory) == null ? void 0 : _a.task;
    if ((task == null ? void 0 : task.type) !== "transfer" || typeof task.targetId !== "string") {
      continue;
    }
    const energySinkId = String(task.targetId);
    reservedEnergyDeliveries.set(energySinkId, ((_b = reservedEnergyDeliveries.get(energySinkId)) != null ? _b : 0) + getUsedEnergy2(worker));
  }
  return reservedEnergyDeliveries;
}
function getReservedEnergyDelivery(energySink, reservedEnergyDeliveries) {
  var _a;
  return (_a = reservedEnergyDeliveries.get(String(energySink.id))) != null ? _a : 0;
}
function getAssignedTransferTargetId(creep) {
  var _a;
  const task = (_a = creep.memory) == null ? void 0 : _a.task;
  return (task == null ? void 0 : task.type) === "transfer" && typeof task.targetId === "string" ? String(task.targetId) : null;
}
function isAssignedTransferTarget(energySink, assignedTransferTargetId) {
  return assignedTransferTargetId !== null && String(energySink.id) === assignedTransferTargetId;
}
function findFillableEnergySinks(creep) {
  return findFillableEnergySinksInRoom(creep.room);
}
function findFillableEnergySinksInRoom(room) {
  if (typeof FIND_MY_STRUCTURES !== "number" || typeof room.find !== "function") {
    return [];
  }
  const energySinks = room.find(FIND_MY_STRUCTURES, {
    filter: isFillableEnergySink
  });
  return energySinks;
}
function findSpawnExtensionEnergyStructures(room) {
  if (typeof FIND_MY_STRUCTURES !== "number" || typeof room.find !== "function") {
    return [];
  }
  return room.find(FIND_MY_STRUCTURES).filter((structure) => isSpawnExtensionEnergyStructure(structure));
}
function selectRemoteHaulerDeliverySink(room) {
  var _a;
  const fillableSinks = findFillableEnergySinksInRoom(room);
  return (_a = selectFirstEnergySinkByStableId(fillableSinks.filter(isSpawnOrExtensionEnergySink))) != null ? _a : selectFirstStorageSinkByStableId(findRemoteHaulerStorageSinks(room));
}
function findRemoteHaulerStorageSinks(room) {
  if (typeof FIND_MY_STRUCTURES !== "number" || typeof room.find !== "function") {
    return [];
  }
  return room.find(FIND_MY_STRUCTURES).filter(
    (structure) => isRemoteHaulerStorageSink(structure)
  );
}
function isRemoteHaulerStorageSink(structure) {
  return matchesStructureType6(structure.structureType, "STRUCTURE_STORAGE", "storage") && "store" in structure && getFreeStoredEnergyCapacity(structure) > 0;
}
function selectFirstStorageSinkByStableId(storageSinks) {
  var _a;
  return (_a = [...storageSinks].sort((left, right) => String(left.id).localeCompare(String(right.id)))[0]) != null ? _a : null;
}
function isSpawnExtensionEnergyStructure(structure) {
  return (matchesStructureType6(structure.structureType, "STRUCTURE_SPAWN", "spawn") || matchesStructureType6(structure.structureType, "STRUCTURE_EXTENSION", "extension")) && "store" in structure;
}
function isSpawnEnergySink(structure) {
  return matchesStructureType6(structure.structureType, "STRUCTURE_SPAWN", "spawn");
}
function isNearTermSpawningSpawn(structure) {
  var _a;
  if (!matchesStructureType6(structure.structureType, "STRUCTURE_SPAWN", "spawn")) {
    return false;
  }
  const remainingTime = (_a = structure.spawning) == null ? void 0 : _a.remainingTime;
  return typeof remainingTime === "number" && remainingTime > 0 && remainingTime <= NEAR_TERM_SPAWN_EXTENSION_REFILL_RESERVE_TICKS;
}
function isSpawnOrExtensionEnergySink(structure) {
  return isSpawnEnergySink(structure) || isExtensionEnergySink(structure);
}
function isExtensionEnergySink(structure) {
  return matchesStructureType6(structure.structureType, "STRUCTURE_EXTENSION", "extension");
}
function isTowerEnergySink(structure) {
  return matchesStructureType6(structure.structureType, "STRUCTURE_TOWER", "tower");
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
function selectConstructionSite(creep, constructionSites, predicate = () => true, constructionReservationContext = createEmptyConstructionReservationContext(), options = {}) {
  var _a, _b;
  const candidates = constructionSites.filter(
    (site) => predicate(site) && (!options.requireReasonableRange || isConstructionSiteWithinReasonableRange(creep, site, DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE))
  );
  if (candidates.length === 0) {
    return null;
  }
  const priorityContext = (_a = options.priorityContext) != null ? _a : buildWorkerConstructionSiteImpactPriorityContext(creep, candidates);
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) === "function") {
    return [...candidates].sort(
      (left, right) => compareConstructionSiteCandidates(creep, left, right, constructionReservationContext, priorityContext)
    )[0];
  }
  const topImpactCandidates = selectTopImpactConstructionSiteCandidates(candidates, priorityContext);
  const finishPriorityConstructionSite = selectFinishPriorityConstructionSite(
    creep,
    topImpactCandidates,
    constructionReservationContext
  );
  if (finishPriorityConstructionSite) {
    return finishPriorityConstructionSite;
  }
  if (typeof (position == null ? void 0 : position.findClosestByRange) === "function") {
    const candidatesByStableId = [...topImpactCandidates].sort(compareConstructionSiteId);
    return (_b = position.findClosestByRange(candidatesByStableId)) != null ? _b : candidatesByStableId[0];
  }
  return topImpactCandidates.sort(compareConstructionSiteId)[0];
}
function selectUnreservedConstructionSite(creep, constructionSites, constructionReservationContext, predicate = () => true, options = {}) {
  return selectConstructionSite(
    creep,
    constructionSites,
    (site) => predicate(site) && hasUnreservedConstructionProgress(creep, site, constructionReservationContext),
    constructionReservationContext,
    options
  );
}
function buildWorkerConstructionSiteImpactPriorityContext(creep, constructionSites) {
  const context = {};
  if (constructionSites.some(isRoadConstructionSite2)) {
    context.criticalRoadContext = buildWorkerCriticalRoadLogisticsContext(creep);
  }
  if (constructionSites.some(isContainerConstructionSite2)) {
    context.sources = findConstructionPrioritySources(creep.room);
  }
  if (constructionSites.some(isRampartConstructionSite)) {
    context.protectedRampartAnchors = findConstructionPriorityProtectedRampartAnchors(creep.room);
  }
  return context;
}
function findConstructionPrioritySources(room) {
  if (typeof FIND_SOURCES !== "number" || typeof room.find !== "function") {
    return [];
  }
  try {
    const sources = room.find(FIND_SOURCES);
    return Array.isArray(sources) ? sources : [];
  } catch {
    return [];
  }
}
function findConstructionPriorityProtectedRampartAnchors(room) {
  var _a;
  const anchors = [];
  if (((_a = room.controller) == null ? void 0 : _a.pos) && isPositionInRoom(room.controller.pos, room.name)) {
    anchors.push(room.controller.pos);
  }
  for (const structure of findConstructionPriorityOwnedStructures(room)) {
    if (matchesStructureType6(structure.structureType, "STRUCTURE_SPAWN", "spawn") && structure.pos && isPositionInRoom(structure.pos, room.name)) {
      anchors.push(structure.pos);
    }
  }
  return anchors;
}
function findConstructionPriorityOwnedStructures(room) {
  if (typeof FIND_MY_STRUCTURES !== "number" || typeof room.find !== "function") {
    return [];
  }
  try {
    const structures = room.find(FIND_MY_STRUCTURES);
    return Array.isArray(structures) ? structures : [];
  } catch {
    return [];
  }
}
function isPositionInRoom(position, roomName) {
  return typeof position.roomName !== "string" || position.roomName === roomName;
}
function hasUnreservedConstructionProgress(creep, site, constructionReservationContext) {
  if (isWorkerAssignedToConstructionSite(creep, site)) {
    return true;
  }
  const remainingProgress = getConstructionSiteRemainingProgress2(site);
  if (!Number.isFinite(remainingProgress)) {
    return true;
  }
  return remainingProgress > getReservedConstructionProgress(site, constructionReservationContext);
}
function getReservedConstructionProgress(site, constructionReservationContext) {
  var _a;
  return (_a = constructionReservationContext.reservedProgressBySiteId.get(String(site.id))) != null ? _a : 0;
}
function createEmptyConstructionReservationContext() {
  return { reservedProgressBySiteId: /* @__PURE__ */ new Map() };
}
function createConstructionReservationContext(room) {
  var _a, _b;
  const reservedProgressBySiteId = /* @__PURE__ */ new Map();
  for (const worker of getRoomOwnedCreeps(room)) {
    if (!isSameRoomWorker(worker, room)) {
      continue;
    }
    const task = (_a = worker.memory) == null ? void 0 : _a.task;
    if ((task == null ? void 0 : task.type) !== "build" || task.targetId === void 0) {
      continue;
    }
    const siteId = String(task.targetId);
    reservedProgressBySiteId.set(
      siteId,
      ((_b = reservedProgressBySiteId.get(siteId)) != null ? _b : 0) + getUsedEnergy2(worker) * getBuildPower()
    );
  }
  return { reservedProgressBySiteId };
}
function getRoomOwnedCreeps(room) {
  var _a;
  const findMyCreeps2 = globalThis.FIND_MY_CREEPS;
  if (typeof findMyCreeps2 === "number") {
    const roomCreeps = (_a = room.find) == null ? void 0 : _a.call(room, findMyCreeps2);
    if (Array.isArray(roomCreeps)) {
      return roomCreeps;
    }
  }
  return getGameCreeps().filter((worker) => isSameRoomWorker(worker, room));
}
function isWorkerAssignedToConstructionSite(worker, site) {
  var _a;
  const task = (_a = worker.memory) == null ? void 0 : _a.task;
  return (task == null ? void 0 : task.type) === "build" && String(task.targetId) === String(site.id);
}
function selectFinishPriorityConstructionSite(creep, constructionSites, constructionReservationContext) {
  const candidates = constructionSites.filter(
    (site) => getConstructionSiteFinishPriorityScore(creep, site, constructionReservationContext) !== null
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(
    (left, right) => compareConstructionSiteFinishPriority(creep, left, right, constructionReservationContext) || compareConstructionSiteId(left, right)
  )[0];
}
function compareConstructionSiteCandidates(creep, left, right, constructionReservationContext, priorityContext) {
  return getConstructionSiteImpactPriority(right, priorityContext) - getConstructionSiteImpactPriority(left, priorityContext) || compareConstructionSiteFinishPriority(creep, left, right, constructionReservationContext) || compareConstructionSiteReasonableRange(creep, left, right) || compareOptionalRanges(getRangeBetweenRoomObjects2(creep, left), getRangeBetweenRoomObjects2(creep, right)) || compareConstructionSiteId(left, right);
}
function compareConstructionSiteReasonableRange(creep, left, right) {
  const leftInRange = isConstructionSiteWithinReasonableRange(
    creep,
    left,
    DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE
  );
  const rightInRange = isConstructionSiteWithinReasonableRange(
    creep,
    right,
    DEFAULT_REASONABLE_CONSTRUCTION_SITE_RANGE
  );
  if (leftInRange === rightInRange) {
    return 0;
  }
  return leftInRange ? -1 : 1;
}
function isConstructionSiteWithinReasonableRange(creep, site, rangeLimit) {
  const range = getRangeBetweenRoomObjects2(creep, site);
  return range === null || range <= rangeLimit;
}
function selectTopImpactConstructionSiteCandidates(candidates, priorityContext) {
  const highestPriority = Math.max(
    ...candidates.map((site) => getConstructionSiteImpactPriority(site, priorityContext))
  );
  return candidates.filter((site) => getConstructionSiteImpactPriority(site, priorityContext) === highestPriority);
}
function compareConstructionSiteFinishPriority(creep, left, right, constructionReservationContext) {
  const leftFinishPriority = getConstructionSiteFinishPriorityScore(
    creep,
    left,
    constructionReservationContext
  );
  const rightFinishPriority = getConstructionSiteFinishPriorityScore(
    creep,
    right,
    constructionReservationContext
  );
  if (leftFinishPriority === null && rightFinishPriority === null) {
    return 0;
  }
  if (leftFinishPriority === null) {
    return 1;
  }
  if (rightFinishPriority === null) {
    return -1;
  }
  return rightFinishPriority.score - leftFinishPriority.score || leftFinishPriority.remainingProgress - rightFinishPriority.remainingProgress;
}
function getConstructionSiteFinishPriorityScore(creep, site, constructionReservationContext) {
  const remainingProgress = getUnreservedConstructionProgressForWorker(
    creep,
    site,
    constructionReservationContext
  );
  const progressTotal = getConstructionSiteProgressTotal(site);
  if (remainingProgress <= 0 || !Number.isFinite(remainingProgress) || progressTotal <= 0 || !Number.isFinite(progressTotal)) {
    return null;
  }
  const canComplete = remainingProgress <= getUsedEnergy2(creep) * getBuildPower();
  const nearlyComplete = remainingProgress / progressTotal < NEARLY_COMPLETE_CONSTRUCTION_SITE_REMAINING_RATIO;
  if (!canComplete && !nearlyComplete) {
    return null;
  }
  const finishableMultiplier = canComplete ? FINISHABLE_CONSTRUCTION_SITE_PRIORITY_MULTIPLIER : 1;
  const nearlyCompleteMultiplier = nearlyComplete ? NEARLY_COMPLETE_CONSTRUCTION_SITE_FINISH_PRIORITY_MULTIPLIER : 1;
  return {
    remainingProgress,
    score: finishableMultiplier * nearlyCompleteMultiplier / Math.max(1, remainingProgress)
  };
}
function canCompleteConstructionSiteWithCarriedEnergy(creep, site, constructionReservationContext = createEmptyConstructionReservationContext()) {
  const remainingProgress = getUnreservedConstructionProgressForWorker(
    creep,
    site,
    constructionReservationContext
  );
  return remainingProgress > 0 && remainingProgress <= getUsedEnergy2(creep) * getBuildPower();
}
function getUnreservedConstructionProgressForWorker(creep, site, constructionReservationContext) {
  const remainingProgress = getConstructionSiteRemainingProgress2(site);
  if (!Number.isFinite(remainingProgress)) {
    return remainingProgress;
  }
  const reservedProgress = getReservedConstructionProgress(site, constructionReservationContext);
  const workerReservedProgress = isWorkerAssignedToConstructionSite(creep, site) ? getUsedEnergy2(creep) * getBuildPower() : 0;
  return Math.max(0, remainingProgress - Math.max(0, reservedProgress - workerReservedProgress));
}
function getConstructionSiteRemainingProgress2(site) {
  const progress = site.progress;
  const progressTotal = site.progressTotal;
  if (typeof progress !== "number" || typeof progressTotal !== "number" || !Number.isFinite(progress) || !Number.isFinite(progressTotal)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.ceil(progressTotal - progress));
}
function getConstructionSiteProgressTotal(site) {
  const progressTotal = site.progressTotal;
  return typeof progressTotal === "number" && Number.isFinite(progressTotal) ? Math.max(0, progressTotal) : Number.POSITIVE_INFINITY;
}
function getBuildPower() {
  return typeof BUILD_POWER === "number" && Number.isFinite(BUILD_POWER) && BUILD_POWER > 0 ? BUILD_POWER : DEFAULT_BUILD_POWER;
}
function compareConstructionSiteId(left, right) {
  return String(left.id).localeCompare(String(right.id));
}
function selectCriticalRoadConstructionSite(creep, constructionSites, constructionReservationContext = createEmptyConstructionReservationContext(), priorityContext) {
  if (!constructionSites.some(isRoadConstructionSite2)) {
    return null;
  }
  const criticalRoadContext = buildWorkerCriticalRoadLogisticsContext(creep);
  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    (site) => isCriticalRoadLogisticsWork(site, criticalRoadContext),
    { priorityContext: priorityContext != null ? priorityContext : { criticalRoadContext }, requireReasonableRange: true }
  );
}
function selectNearbyProductiveEnergySinkTask(creep, constructionSites, controller, constructionReservationContext) {
  const controllerRange = getRangeBetweenRoomObjects2(creep, controller);
  if (controllerRange === null) {
    return null;
  }
  const candidates = [
    ...constructionSites.filter((site) => hasUnreservedConstructionProgress(creep, site, constructionReservationContext)).map(
      (site) => createProductiveEnergySinkCandidate(
        creep,
        site,
        { type: "build", targetId: site.id },
        0,
        canCompleteConstructionSiteWithCarriedEnergy(creep, site, constructionReservationContext)
      )
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
function createProductiveEnergySinkCandidate(creep, target, task, taskPriority, canCompleteConstruction = false) {
  const range = getRangeBetweenRoomObjects2(creep, target);
  if (range === null) {
    return null;
  }
  return { canCompleteConstruction, range, task, taskPriority };
}
function compareProductiveEnergySinkCandidates(left, right) {
  return compareProductiveEnergySinkCompletion(left, right) || left.range - right.range || left.taskPriority - right.taskPriority || String(left.task.targetId).localeCompare(String(right.task.targetId));
}
function compareProductiveEnergySinkCompletion(left, right) {
  if (left.canCompleteConstruction === right.canCompleteConstruction) {
    return 0;
  }
  return left.canCompleteConstruction ? -1 : 1;
}
function selectCapacityEnablingConstructionSite(creep, constructionSites, controller, constructionReservationContext, priorityContext) {
  const spawnConstructionSite = selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isSpawnConstructionSite,
    { priorityContext: priorityContext != null ? priorityContext : {}, requireReasonableRange: true }
  );
  if (spawnConstructionSite) {
    return spawnConstructionSite;
  }
  if (controller && shouldRushRcl1Controller(controller)) {
    return null;
  }
  return selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isExtensionConstructionSite,
    { priorityContext: priorityContext != null ? priorityContext : {}, requireReasonableRange: true }
  );
}
function selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(creep, capacityConstructionSite, constructionSites, constructionReservationContext, priorityContext) {
  var _a;
  if (!capacityConstructionSite || !isExtensionConstructionSite(capacityConstructionSite) || shouldPrioritizeExtensionCapacity(creep.room)) {
    return null;
  }
  return (_a = selectCriticalRoadConstructionSite(creep, constructionSites, constructionReservationContext, priorityContext)) != null ? _a : selectUnreservedConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    isContainerConstructionSite2,
    { priorityContext: priorityContext != null ? priorityContext : {}, requireReasonableRange: true }
  );
}
function shouldPrioritizeExtensionCapacity(room) {
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  return energyCapacityAvailable === null || energyCapacityAvailable < BASELINE_WORKER_THROUGHPUT_ENERGY_CAPACITY;
}
function selectReadyFollowUpProductiveEnergySinkTask(creep, capacityConstructionSite, controller, constructionSites, constructionReservationContext, priorityContext) {
  if (!hasReadyTerritoryFollowUpEnergy(creep)) {
    return null;
  }
  const baselineLogisticsConstructionSite = selectBaselineLogisticsConstructionSiteBeforeAdditionalExtension(
    creep,
    capacityConstructionSite,
    constructionSites,
    constructionReservationContext,
    priorityContext
  );
  if (baselineLogisticsConstructionSite) {
    return { type: "build", targetId: baselineLogisticsConstructionSite.id };
  }
  if (capacityConstructionSite) {
    return { type: "build", targetId: capacityConstructionSite.id };
  }
  if (controller && shouldRushRcl1Controller(controller)) {
    return null;
  }
  const criticalRepairTarget = selectCriticalInfrastructureRepairTarget(creep);
  if (criticalRepairTarget) {
    return { type: "repair", targetId: criticalRepairTarget.id };
  }
  const criticalRoadConstructionSite = selectCriticalRoadConstructionSite(
    creep,
    constructionSites,
    constructionReservationContext,
    priorityContext
  );
  return criticalRoadConstructionSite ? { type: "build", targetId: criticalRoadConstructionSite.id } : null;
}
function isSpawnConstructionSite(site) {
  return matchesStructureType6(site.structureType, "STRUCTURE_SPAWN", "spawn");
}
function isExtensionConstructionSite(site) {
  return matchesStructureType6(site.structureType, "STRUCTURE_EXTENSION", "extension");
}
function isContainerConstructionSite2(site) {
  return matchesStructureType6(site.structureType, "STRUCTURE_CONTAINER", "container");
}
function isRoadConstructionSite2(site) {
  return matchesStructureType6(site.structureType, "STRUCTURE_ROAD", "road");
}
function isRampartConstructionSite(site) {
  return matchesStructureType6(site.structureType, "STRUCTURE_RAMPART", "rampart");
}
function isHighImpactConstructionSite(site, priorityContext) {
  return isContainerConstructionSite2(site) || getConstructionSiteImpactPriority(site, priorityContext != null ? priorityContext : {}) >= CONSTRUCTION_SITE_IMPACT_PRIORITY.criticalRoad;
}
function matchesStructureType6(actual, globalName, fallback) {
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
  return isStoredWorkerEnergySource(structure) && hasStoredEnergy2(structure) && isFriendlyStoredEnergySource(structure, context);
}
function isStoredWorkerEnergySource(structure) {
  return matchesStructureType6(structure.structureType, "STRUCTURE_CONTAINER", "container") || matchesStructureType6(structure.structureType, "STRUCTURE_STORAGE", "storage") || matchesStructureType6(structure.structureType, "STRUCTURE_TERMINAL", "terminal");
}
function hasStoredEnergy2(structure) {
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
  return matchesStructureType6(structure.structureType, "STRUCTURE_CONTAINER", "container") && isRoomSafeForUnownedContainerWithdrawal(context);
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
function selectBuilderEnergyAcquisitionTask(creep) {
  var _a;
  const buildTask = (_a = creep.memory) == null ? void 0 : _a.task;
  if ((buildTask == null ? void 0 : buildTask.type) !== "build" || buildTask.targetId == null) {
    return null;
  }
  const constructionSite = getGameObjectById(buildTask.targetId);
  if (!constructionSite) {
    return null;
  }
  const candidates = findBuilderEnergyAcquisitionCandidates(creep, constructionSite);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareBuilderEnergyAcquisitionCandidates)[0].task;
}
function findBuilderEnergyAcquisitionCandidates(creep, constructionSite) {
  const context = {
    creepOwnerUsername: getCreepOwnerUsername2(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const storedEnergyCandidates = findVisibleRoomStructures(creep.room).filter((structure) => isSafeStoredEnergySource(structure, context)).filter((source) => isConstructionSiteNearSource(constructionSite, source, BUILDER_STORAGE_ACQUISITION_SITE_RANGE)).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getStoredEnergy2(source),
      {
        type: "withdraw",
        targetId: source.id
      },
      reservationContext,
      BUILDER_STORAGE_WITHDRAW_MIN
    );
    return candidate ? [toBuilderEnergyAcquisitionCandidate(candidate, 0)] : [];
  });
  const droppedEnergyCandidates = findDroppedResources(creep.room).filter(
    (resource) => isDroppedEnergy(resource, MIN_DROPPED_ENERGY_PICKUP_AMOUNT)
  ).filter((source) => isConstructionSiteNearSource(constructionSite, source, BUILDER_DROPPED_PICKUP_RANGE)).flatMap((resource) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      resource,
      resource.amount,
      {
        type: "pickup",
        targetId: resource.id
      },
      reservationContext,
      MIN_DROPPED_ENERGY_PICKUP_AMOUNT
    );
    return candidate ? [toBuilderEnergyAcquisitionCandidate(candidate, 1)] : [];
  }).sort(compareBuilderEnergyAcquisitionCandidates).slice(0, MAX_DROPPED_ENERGY_REACHABILITY_CHECKS).filter((candidate) => isReachable(creep, candidate.source));
  return [...storedEnergyCandidates, ...droppedEnergyCandidates].sort(compareBuilderEnergyAcquisitionCandidates);
}
function toBuilderEnergyAcquisitionCandidate(candidate, priority) {
  return {
    ...candidate,
    source: candidate.source,
    task: candidate.task,
    priority
  };
}
function isConstructionSiteNearSource(constructionSite, source, rangeLimit) {
  const rangeToSite = getRangeBetweenRoomObjects2(constructionSite, source);
  return rangeToSite !== null && rangeToSite <= rangeLimit;
}
function compareBuilderEnergyAcquisitionCandidates(left, right) {
  const priorityComparison = left.priority - right.priority;
  if (priorityComparison !== 0) {
    return priorityComparison;
  }
  return compareOptionalRanges(left.range, right.range) || right.score - left.score || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
}
function getGameObjectById(objectId) {
  const game = globalThis.Game;
  if (!(game == null ? void 0 : game.getObjectById)) {
    return null;
  }
  const object = game.getObjectById(objectId);
  return object ? object : null;
}
function selectWorkerPreHarvestTask(creep) {
  const source = selectHarvestSource(creep);
  return source ? { type: "harvest", targetId: source.id } : null;
}
function selectNearbyContainerWorkerEnergyAcquisitionTask(creep) {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep, {
    maximumRange: LOW_LOAD_NEARBY_ENERGY_RANGE
  }).filter((candidate) => isContainerEnergySource(candidate.source));
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareWorkerEnergyAcquisitionCandidates)[0].task;
}
function selectLowLoadWorkerEnergyAcquisitionCandidate(creep) {
  if (!shouldKeepLowLoadWorkerAcquiringEnergy(creep)) {
    return null;
  }
  const nearbyCandidates = findLowLoadWorkerEnergyAcquisitionCandidates(creep).filter(
    (candidate) => candidate.range !== null && candidate.range <= LOW_LOAD_NEARBY_ENERGY_RANGE
  );
  if (nearbyCandidates.length === 0) {
    return null;
  }
  return nearbyCandidates.sort(compareLowLoadWorkerEnergyAcquisitionCandidates)[0];
}
function selectLowLoadWorkerEnergyContinuationTask(creep) {
  const candidate = selectLowLoadWorkerEnergyContinuationCandidate(creep);
  if (!candidate) {
    return null;
  }
  recordNearbyEnergyChoiceTelemetry(creep, candidate);
  return candidate.task;
}
function selectLowLoadWorkerEnergyContinuationCandidate(creep) {
  if (!shouldKeepLowLoadWorkerAcquiringEnergy(creep)) {
    return null;
  }
  const candidates = findLowLoadWorkerEnergyContinuationCandidates(creep).filter(
    isLowLoadWorkerEnergyContinuationCandidateInRange
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareLowLoadWorkerEnergyAcquisitionCandidates)[0];
}
function shouldKeepLowLoadWorkerAcquiringEnergy(creep) {
  return getLowLoadWorkerEnergyContext(creep) !== null && !hasVisibleHostilePresence(creep.room);
}
function findLowLoadWorkerEnergyContinuationCandidates(creep) {
  return [
    ...findWorkerEnergyAcquisitionCandidates(creep, {
      maximumRange: LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE
    }).map(toLowLoadWorkerEnergyAcquisitionCandidate),
    ...findLowLoadHarvestEnergyAcquisitionCandidates(creep)
  ];
}
function findLowLoadWorkerEnergyAcquisitionCandidates(creep) {
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  return [
    ...findNearbyLowLoadStoredEnergyAcquisitionCandidates(creep, reservationContext),
    ...findNearbyLowLoadSalvageEnergyAcquisitionCandidates(creep, reservationContext),
    ...findNearbyLowLoadDroppedEnergyAcquisitionCandidates(creep, reservationContext),
    ...findLowLoadHarvestEnergyAcquisitionCandidates(creep)
  ];
}
function findNearbyLowLoadStoredEnergyAcquisitionCandidates(creep, reservationContext) {
  const context = {
    creepOwnerUsername: getCreepOwnerUsername2(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  return findVisibleRoomStructures(creep.room).filter((structure) => isSafeStoredEnergySource(structure, context)).filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source)).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getStoredEnergy2(source),
      {
        type: "withdraw",
        targetId: source.id
      },
      reservationContext
    );
    return candidate ? [toLowLoadWorkerEnergyAcquisitionCandidate(candidate)] : [];
  });
}
function findNearbyLowLoadSalvageEnergyAcquisitionCandidates(creep, reservationContext) {
  return [...findTombstones(creep.room), ...findRuins(creep.room)].filter(hasSalvageableEnergy).filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source)).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getStoredEnergy2(source),
      {
        type: "withdraw",
        targetId: source.id
      },
      reservationContext,
      MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT
    );
    return candidate ? [toLowLoadWorkerEnergyAcquisitionCandidate(candidate)] : [];
  });
}
function findNearbyLowLoadDroppedEnergyAcquisitionCandidates(creep, reservationContext) {
  return findDroppedResources(creep.room).filter(isUsefulDroppedEnergy).filter((source) => isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source)).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      source.amount,
      {
        type: "pickup",
        targetId: source.id
      },
      reservationContext,
      MIN_DROPPED_ENERGY_PICKUP_AMOUNT
    );
    return candidate ? [toLowLoadWorkerEnergyAcquisitionCandidate(candidate)] : [];
  }).filter((candidate) => isReachable(creep, candidate.source));
}
function isNearbyLowLoadWorkerEnergyAcquisitionSource(creep, source) {
  const range = getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source);
  return range !== null && range <= LOW_LOAD_NEARBY_ENERGY_RANGE;
}
function isLowLoadWorkerEnergyContinuationCandidateInRange(candidate) {
  return candidate.range !== null && candidate.range <= LOW_LOAD_WORKER_ENERGY_CONTINUATION_MAX_RANGE;
}
function toLowLoadWorkerEnergyAcquisitionCandidate(candidate) {
  return candidate;
}
function findLowLoadHarvestEnergyAcquisitionCandidates(creep) {
  if (getActiveWorkParts(creep) <= 0) {
    return [];
  }
  const source = selectHarvestSource(creep);
  if (!source || isSourceDepleted(source)) {
    return [];
  }
  return [
    createLowLoadWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getHarvestCandidateEnergy(creep, source),
      { type: "harvest", targetId: source.id }
    )
  ];
}
function getHarvestCandidateEnergy(creep, source) {
  return typeof source.energy === "number" && Number.isFinite(source.energy) ? source.energy : getFreeEnergyCapacity2(creep);
}
function createLowLoadWorkerEnergyAcquisitionCandidate(creep, source, energy, task) {
  const range = getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source);
  return {
    energy,
    priority: getWorkerEnergyAcquisitionPriority(creep, source, energy, range),
    range,
    score: range === null ? energy : energy - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task
  };
}
function compareLowLoadWorkerEnergyAcquisitionCandidates(left, right) {
  return left.priority - right.priority || compareOptionalRanges(left.range, right.range) || right.score - left.score || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
}
function selectSpawnRecoveryEnergyAcquisitionTask(creep, energySink, harvestEta = estimateHarvestDeliveryEta(creep, energySink)) {
  const candidates = findWorkerEnergyAcquisitionCandidates(creep, {
    minimumDroppedEnergy: MIN_SPAWN_RECOVERY_DROPPED_ENERGY_PICKUP_AMOUNT
  }).map((candidate) => createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink)).filter((candidate) => candidate !== null).filter((candidate) => harvestEta === null || candidate.deliveryEta <= harvestEta);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareSpawnRecoveryEnergyAcquisitionCandidates)[0].task;
}
function selectSpawnRecoveryHarvestCandidate(creep, energySink) {
  const sources = creep.room.find(FIND_SOURCES);
  if (sources.length === 0) {
    return null;
  }
  const viableSources = selectViableHarvestSources(
    sources,
    getSpawnRecoveryHarvestEnergyTarget(creep, energySink)
  );
  const assignmentLoads = getSameRoomWorkerHarvestLoads(creep.room.name, viableSources);
  const assignableSources = selectAssignableHarvestSources(creep, viableSources, assignmentLoads);
  const candidates = assignableSources.map(
    (source) => createSpawnRecoveryHarvestCandidate(
      creep,
      source,
      energySink,
      getHarvestSourceAssignmentLoad(assignmentLoads, source)
    )
  ).filter((candidate) => candidate !== null);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.sort(compareSpawnRecoveryHarvestCandidates)[0];
}
function createSpawnRecoveryHarvestCandidate(creep, source, energySink, assignmentLoad) {
  const deliveryEta = estimateHarvestDeliveryEtaFromSource(creep, source, energySink);
  if (deliveryEta === null || !Number.isFinite(deliveryEta)) {
    return null;
  }
  return {
    deliveryEta,
    load: createHarvestSourceLoad(source, assignmentLoad),
    source
  };
}
function findWorkerEnergyAcquisitionCandidates(creep, options = {}) {
  const context = {
    creepOwnerUsername: getCreepOwnerUsername2(creep),
    hasHostilePresence: hasVisibleHostilePresence(creep.room),
    room: creep.room
  };
  const reservationContext = createWorkerEnergyAcquisitionReservationContext(creep);
  const storedEnergyCandidates = findVisibleRoomStructures(creep.room).filter((structure) => isSafeStoredEnergySource(structure, context)).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getStoredEnergy2(source),
      {
        type: "withdraw",
        targetId: source.id
      },
      reservationContext
    );
    return candidate ? [candidate] : [];
  }).filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options));
  const salvageEnergyCandidates = [...findTombstones(creep.room), ...findRuins(creep.room)].filter(hasSalvageableEnergy).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      getStoredEnergy2(source),
      {
        type: "withdraw",
        targetId: source.id
      },
      reservationContext,
      MIN_SALVAGE_ENERGY_WITHDRAW_AMOUNT
    );
    return candidate ? [candidate] : [];
  }).filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options));
  const droppedEnergyCandidates = findDroppedEnergyAcquisitionCandidates(creep, reservationContext, options);
  return [...storedEnergyCandidates, ...salvageEnergyCandidates, ...droppedEnergyCandidates];
}
function findDroppedEnergyAcquisitionCandidates(creep, reservationContext, options = {}) {
  var _a;
  const minimumEnergy = (_a = options.minimumDroppedEnergy) != null ? _a : MIN_DROPPED_ENERGY_PICKUP_AMOUNT;
  return findDroppedResources(creep.room).filter((resource) => isDroppedEnergy(resource, minimumEnergy)).flatMap((source) => {
    const candidate = createUnreservedWorkerEnergyAcquisitionCandidate(
      creep,
      source,
      source.amount,
      {
        type: "pickup",
        targetId: source.id
      },
      reservationContext,
      minimumEnergy
    );
    return candidate ? [candidate] : [];
  }).filter((candidate) => isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options)).sort(compareDroppedEnergyReachabilityPriority).slice(0, MAX_DROPPED_ENERGY_REACHABILITY_CHECKS).filter((candidate) => isReachable(creep, candidate.source));
}
function isWorkerEnergyAcquisitionCandidateWithinSearchRange(candidate, options) {
  return options.maximumRange === void 0 || candidate.range !== null && candidate.range <= options.maximumRange;
}
function createUnreservedWorkerEnergyAcquisitionCandidate(creep, source, energy, task, reservationContext, minimumEnergy = 1) {
  const unreservedEnergy = getUnreservedWorkerEnergyAcquisitionAmount(source, energy, reservationContext);
  if (unreservedEnergy < minimumEnergy) {
    return null;
  }
  return createWorkerEnergyAcquisitionCandidate(creep, source, unreservedEnergy, task);
}
function createWorkerEnergyAcquisitionCandidate(creep, source, energy, task) {
  const range = getRangeToWorkerEnergyAcquisitionSource(creep, source);
  const energyScore = scoreWorkerEnergyAcquisitionAmount(energy, getFreeEnergyCapacity2(creep));
  return {
    energy,
    priority: getWorkerEnergyAcquisitionPriority(creep, source, energy, range),
    range,
    score: range === null ? energyScore : energyScore - range * ENERGY_ACQUISITION_RANGE_COST,
    source,
    task
  };
}
function getWorkerEnergyAcquisitionPriority(creep, source, energy, range) {
  if (isContainerEnergySource(source) && range !== null && range <= LOW_LOAD_NEARBY_ENERGY_RANGE && energy >= Math.max(1, getFreeEnergyCapacity2(creep))) {
    return 0;
  }
  return isDurableStoredEnergySource(source) ? 2 : 1;
}
function isContainerEnergySource(source) {
  return isStructureEnergySourceType(source, "STRUCTURE_CONTAINER", "container");
}
function isDurableStoredEnergySource(source) {
  return isStructureEnergySourceType(source, "STRUCTURE_STORAGE", "storage") || isStructureEnergySourceType(source, "STRUCTURE_TERMINAL", "terminal");
}
function isStructureEnergySourceType(source, globalName, fallback) {
  const structureType = source.structureType;
  return matchesStructureType6(typeof structureType === "string" ? structureType : void 0, globalName, fallback);
}
function scoreWorkerEnergyAcquisitionAmount(energy, freeCapacity) {
  if (freeCapacity <= 0) {
    return energy;
  }
  const immediateTripEnergy = Math.min(energy, freeCapacity);
  const surplusEnergy = Math.max(0, energy - immediateTripEnergy);
  return immediateTripEnergy + surplusEnergy * WORKER_ENERGY_SURPLUS_SCORE_RATIO;
}
function createWorkerEnergyAcquisitionReservationContext(creep) {
  return {
    reservedEnergyBySourceId: getReservedWorkerEnergyAcquisitionsBySourceId(creep)
  };
}
function getReservedWorkerEnergyAcquisitionsBySourceId(creep) {
  var _a, _b;
  const reservedEnergyBySourceId = /* @__PURE__ */ new Map();
  for (const worker of getGameCreeps()) {
    if (isSameCreep(worker, creep) || !isSameRoomWorker(worker, creep.room)) {
      continue;
    }
    const task = (_a = worker.memory) == null ? void 0 : _a.task;
    if (!isWorkerEnergyAcquisitionReservationTask(task)) {
      continue;
    }
    const freeCapacity = getFreeEnergyCapacity2(worker);
    if (freeCapacity <= 0) {
      continue;
    }
    const sourceId = String(task.targetId);
    reservedEnergyBySourceId.set(sourceId, ((_b = reservedEnergyBySourceId.get(sourceId)) != null ? _b : 0) + freeCapacity);
  }
  return reservedEnergyBySourceId;
}
function isWorkerEnergyAcquisitionReservationTask(task) {
  return ((task == null ? void 0 : task.type) === "pickup" || (task == null ? void 0 : task.type) === "withdraw") && typeof task.targetId === "string" && task.targetId.length > 0;
}
function getUnreservedWorkerEnergyAcquisitionAmount(source, energy, reservationContext) {
  var _a;
  return Math.max(0, energy - ((_a = reservationContext.reservedEnergyBySourceId.get(String(source.id))) != null ? _a : 0));
}
function createSpawnRecoveryEnergyAcquisitionCandidate(candidate, energySink) {
  if (candidate.range === null) {
    return null;
  }
  const sourceToSinkRange = getRangeBetweenRoomObjects2(candidate.source, energySink);
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
  return estimateHarvestDeliveryEtaFromSource(creep, source, energySink);
}
function estimateHarvestDeliveryEtaFromSource(creep, source, energySink) {
  const sourceAvailabilityDelay = estimateHarvestSourceAvailabilityDelay(source);
  if (sourceAvailabilityDelay === null) {
    return null;
  }
  const creepToSourceRange = getRangeBetweenRoomObjects2(creep, source);
  const sourceToSinkRange = getRangeBetweenRoomObjects2(source, energySink);
  if (creepToSourceRange === null || sourceToSinkRange === null) {
    return null;
  }
  return creepToSourceRange + sourceAvailabilityDelay + estimateHarvestTicks(creep, energySink) + sourceToSinkRange;
}
function estimateHarvestTicks(creep, energySink) {
  const energyNeeded = getSpawnRecoveryHarvestEnergyTarget(creep, energySink);
  const workParts = getActiveWorkParts(creep);
  if (workParts === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(energyNeeded / Math.max(HARVEST_ENERGY_PER_WORK_PART, workParts * HARVEST_ENERGY_PER_WORK_PART));
}
function getSpawnRecoveryHarvestEnergyTarget(creep, energySink) {
  return Math.max(1, Math.min(getFreeEnergyCapacity2(creep), getFreeStoredEnergyCapacity(energySink)));
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
  var _a;
  const workPart = getBodyPartConstant3("WORK", "work");
  const activeWorkParts = (_a = creep.getActiveBodyparts) == null ? void 0 : _a.call(creep, workPart);
  if (typeof activeWorkParts === "number" && Number.isFinite(activeWorkParts)) {
    return Math.max(0, Math.floor(activeWorkParts));
  }
  const bodyWorkParts = countActiveBodyParts(creep.body, workPart);
  return bodyWorkParts != null ? bodyWorkParts : 1;
}
function countActiveBodyParts(body, bodyPartType) {
  if (!Array.isArray(body)) {
    return null;
  }
  return body.filter((part) => isActiveBodyPart3(part, bodyPartType)).length;
}
function isActiveBodyPart3(part, bodyPartType) {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const bodyPart = part;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === "number" && bodyPart.hits > 0;
}
function getBodyPartConstant3(globalName, fallback) {
  var _a;
  const constants = globalThis;
  return (_a = constants[globalName]) != null ? _a : fallback;
}
function getRangeBetweenRoomObjects2(left, right) {
  const position = left.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) !== "function") {
    return null;
  }
  const range = position.getRangeTo(right);
  return Number.isFinite(range) ? Math.max(0, range) : null;
}
function getRangeToWorkerEnergyAcquisitionSource(creep, source) {
  return getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source);
}
function getRangeToLowLoadWorkerEnergyAcquisitionSource(creep, source) {
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
  const range = getRangeBetweenRoomObjects2(creep, target);
  if (range !== null && range <= 1) {
    return true;
  }
  const path = position.findPathTo(target, { ignoreCreeps: true });
  return Array.isArray(path) && path.length > 0;
}
function compareWorkerEnergyAcquisitionCandidates(left, right) {
  const priorityComparison = left.priority - right.priority;
  if (priorityComparison !== 0) {
    return priorityComparison;
  }
  if (left.priority === 0) {
    return compareOptionalRanges(left.range, right.range) || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
  }
  if (left.priority === 1) {
    return right.energy - left.energy || compareOptionalRanges(left.range, right.range) || right.score - left.score || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
  }
  return right.score - left.score || compareOptionalRanges(left.range, right.range) || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
}
function compareDroppedEnergyReachabilityPriority(left, right) {
  return compareOptionalRanges(left.range, right.range) || right.energy - left.energy || right.score - left.score || String(left.source.id).localeCompare(String(right.source.id));
}
function compareSpawnRecoveryEnergyAcquisitionCandidates(left, right) {
  return left.deliveryEta - right.deliveryEta || compareOptionalRanges(left.range, right.range) || right.energy - left.energy || String(left.source.id).localeCompare(String(right.source.id)) || left.task.type.localeCompare(right.task.type);
}
function compareSpawnRecoveryHarvestCandidates(left, right) {
  return compareHarvestSourceLoadRatio(left.load, right.load) || left.load.assignmentCount - right.load.assignmentCount || left.deliveryEta - right.deliveryEta || String(left.source.id).localeCompare(String(right.source.id));
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
  return findHostileCreeps2(room).length > 0 || findHostileStructures2(room).length > 0;
}
function findHostileCreeps2(room) {
  return typeof FIND_HOSTILE_CREEPS === "number" ? room.find(FIND_HOSTILE_CREEPS) : [];
}
function findHostileStructures2(room) {
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
  const visibleStructures = findVisibleRoomStructures(creep.room);
  const criticalRoadContext = visibleStructures.some(isCriticalRoadRepairCandidate) ? buildWorkerCriticalRoadLogisticsContext(creep) : null;
  const canRepairOwnedInfrastructure = ((_a = creep.room.controller) == null ? void 0 : _a.my) === true;
  const canRepairRemoteCriticalRoads = !canRepairOwnedInfrastructure && criticalRoadContext !== null && canRepairRemoteCriticalRoadInfrastructure(creep);
  if (!canRepairOwnedInfrastructure && !canRepairRemoteCriticalRoads) {
    return null;
  }
  const repairTargets = visibleStructures.filter(
    (structure) => isCriticalInfrastructureRepairTarget(structure, criticalRoadContext, {
      repairContainers: canRepairOwnedInfrastructure,
      repairCriticalRoads: canRepairOwnedInfrastructure || canRepairRemoteCriticalRoads
    })
  );
  if (repairTargets.length === 0) {
    return null;
  }
  return repairTargets.sort(compareRepairTargets)[0];
}
function canRepairRemoteCriticalRoadInfrastructure(creep) {
  var _a;
  if (!isRemoteTerritoryLogisticsRoom(creep.room) || hasVisibleHostilePresence(creep.room)) {
    return false;
  }
  const controller = creep.room.controller;
  if (!controller) {
    return true;
  }
  if (controller.owner != null) {
    return false;
  }
  const reservationUsername = (_a = controller.reservation) == null ? void 0 : _a.username;
  return reservationUsername == null || reservationUsername === getCreepOwnerUsername2(creep) || isSelfReservedRoom(creep.room);
}
function buildWorkerCriticalRoadLogisticsContext(creep) {
  return buildCriticalRoadLogisticsContext(creep.room, { colonyRoomName: getCreepColonyName(creep) });
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
  return matchesStructureType6(structure.structureType, "STRUCTURE_RAMPART", "rampart") && isOwnedRampart(structure);
}
function isCriticalInfrastructureRepairTarget(structure, criticalRoadContext, options) {
  if (!isSafeRepairTarget(structure) || !isRoadOrContainerRepairTarget(structure) || getHitsRatio(structure) > CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO) {
    return false;
  }
  return options.repairContainers && isContainerRepairTarget(structure) || options.repairCriticalRoads && !!criticalRoadContext && isCriticalRoadLogisticsWork(structure, criticalRoadContext);
}
function isCriticalRoadRepairCandidate(structure) {
  return isSafeRepairTarget(structure) && isRoadRepairTarget(structure) && getHitsRatio(structure) <= CRITICAL_ROAD_CONTAINER_REPAIR_HITS_RATIO;
}
function isRoadOrContainerRepairTarget(structure) {
  return isRoadRepairTarget(structure) || isContainerRepairTarget(structure);
}
function isRoadRepairTarget(structure) {
  return matchesStructureType6(structure.structureType, "STRUCTURE_ROAD", "road");
}
function isContainerRepairTarget(structure) {
  return matchesStructureType6(structure.structureType, "STRUCTURE_CONTAINER", "container");
}
function isWorkerRepairTargetComplete(structure) {
  return structure.hits >= getWorkerRepairHitsCeiling(structure);
}
function getWorkerRepairHitsCeiling(structure) {
  if (matchesStructureType6(structure.structureType, "STRUCTURE_RAMPART", "rampart") && isOwnedRampart(structure)) {
    return Math.min(structure.hitsMax, IDLE_RAMPART_REPAIR_HITS_CEILING2);
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
  if (matchesStructureType6(structure.structureType, "STRUCTURE_ROAD", "road")) {
    return 0;
  }
  if (matchesStructureType6(structure.structureType, "STRUCTURE_CONTAINER", "container")) {
    return 1;
  }
  return 2;
}
function getHitsRatio(structure) {
  return structure.hitsMax > 0 ? structure.hits / structure.hitsMax : 1;
}
function shouldGuardControllerDowngrade(controller) {
  return (controller == null ? void 0 : controller.my) === true && typeof controller.ticksToDowngrade === "number" && controller.ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS2;
}
function shouldRushRcl1Controller(controller) {
  return controller.my === true && controller.level === 1;
}
function shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep) {
  const carriedEnergy = getUsedEnergy2(creep);
  if (carriedEnergy <= 0) {
    return false;
  }
  const reserveContext = getNearTermSpawnExtensionRefillReserveContext(creep.room);
  return reserveContext.refillReserve > 0 && isWorkerEnergyNeededForNearTermSpawnExtensionRefillReserve(creep, reserveContext);
}
function getNearTermSpawnExtensionRefillReserveContext(room) {
  const gameTick = getGameTick3();
  const roomName = getRoomName2(room);
  if (gameTick === null || roomName === null) {
    return createNearTermSpawnExtensionRefillReserveContext(room);
  }
  if (!nearTermSpawnExtensionRefillReserveCache || nearTermSpawnExtensionRefillReserveCache.tick !== gameTick) {
    nearTermSpawnExtensionRefillReserveCache = {
      roomsByName: /* @__PURE__ */ new Map(),
      tick: gameTick
    };
  }
  const cachedContext = nearTermSpawnExtensionRefillReserveCache.roomsByName.get(roomName);
  if ((cachedContext == null ? void 0 : cachedContext.room) === room) {
    return cachedContext;
  }
  const context = createNearTermSpawnExtensionRefillReserveContext(room);
  nearTermSpawnExtensionRefillReserveCache.roomsByName.set(roomName, context);
  return context;
}
function createNearTermSpawnExtensionRefillReserveContext(room) {
  const spawnExtensionEnergyStructures = findSpawnExtensionEnergyStructures(room);
  const refillReserve = estimateNearTermSpawnExtensionRefillReserveFromStructures(
    room,
    spawnExtensionEnergyStructures
  );
  const sortedLoadedWorkers = refillReserve > 0 ? dedupeCreepsByStableKey(getGameCreeps().filter((candidate) => isSameRoomWorkerWithEnergy(candidate, room))).sort(
    (left, right) => compareNearTermRefillReserveWorkers(left, right, spawnExtensionEnergyStructures)
  ) : [];
  return {
    refillReserve,
    room,
    sortedLoadedWorkers,
    spawnExtensionEnergyStructures
  };
}
function getGameTick3() {
  var _a;
  const time = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof time === "number" && Number.isFinite(time) ? time : null;
}
function getRoomName2(room) {
  return typeof room.name === "string" && room.name.length > 0 ? room.name : null;
}
function isWorkerEnergyNeededForNearTermSpawnExtensionRefillReserve(creep, reserveContext) {
  const loadedWorkers = getNearTermRefillReserveLoadedWorkers(creep, reserveContext);
  let reservedEnergy = 0;
  for (const worker of loadedWorkers) {
    if (isSameCreep(worker, creep)) {
      return reservedEnergy < reserveContext.refillReserve;
    }
    reservedEnergy += getUsedEnergy2(worker);
  }
  return true;
}
function getNearTermRefillReserveLoadedWorkers(creep, reserveContext) {
  if (reserveContext.sortedLoadedWorkers.some((worker) => isSameCreep(worker, creep))) {
    return reserveContext.sortedLoadedWorkers;
  }
  return dedupeCreepsByStableKey([...reserveContext.sortedLoadedWorkers, creep]).sort(
    (left, right) => compareNearTermRefillReserveWorkers(left, right, reserveContext.spawnExtensionEnergyStructures)
  );
}
function compareNearTermRefillReserveWorkers(left, right, spawnExtensionEnergyStructures) {
  return getUsedEnergy2(right) - getUsedEnergy2(left) || compareOptionalRanges(
    getClosestNearTermRefillRange(left, spawnExtensionEnergyStructures),
    getClosestNearTermRefillRange(right, spawnExtensionEnergyStructures)
  ) || getCreepStableSortKey(left).localeCompare(getCreepStableSortKey(right));
}
function dedupeCreepsByStableKey(creeps) {
  const seenStableKeys = /* @__PURE__ */ new Set();
  const seenCreeps = /* @__PURE__ */ new Set();
  const uniqueCreeps = [];
  for (const creep of creeps) {
    if (seenCreeps.has(creep)) {
      continue;
    }
    seenCreeps.add(creep);
    const stableKey = getCreepStableSortKey(creep);
    if (stableKey.length > 0) {
      if (seenStableKeys.has(stableKey)) {
        continue;
      }
      seenStableKeys.add(stableKey);
    }
    uniqueCreeps.push(creep);
  }
  return uniqueCreeps;
}
function getClosestNearTermRefillRange(creep, spawnExtensionEnergyStructures) {
  let closestRange = null;
  for (const structure of spawnExtensionEnergyStructures) {
    const range = getRangeBetweenRoomObjects2(creep, structure);
    if (range === null) {
      continue;
    }
    closestRange = closestRange === null ? range : Math.min(closestRange, range);
  }
  return closestRange;
}
function isSameCreep(left, right) {
  if (left === right) {
    return true;
  }
  const leftKey = getCreepStableSortKey(left);
  return leftKey.length > 0 && leftKey === getCreepStableSortKey(right);
}
function getCreepStableSortKey(creep) {
  const name = creep.name;
  if (typeof name === "string" && name.length > 0) {
    return name;
  }
  const id = creep.id;
  return typeof id === "string" && id.length > 0 ? id : "";
}
function shouldApplyControllerPressureLane(creep, controller) {
  if (controller.my !== true || controller.level < 2) {
    return false;
  }
  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  const hasControllerProgressPressure = hasActiveControllerProgressPressure(creep);
  const hasTerritoryExpansionPressure = hasActiveTerritoryExpansionPressure(creep);
  if (loadedWorkers.length < MIN_LOADED_WORKERS_FOR_SUSTAINED_CONTROLLER_PROGRESS && !(loadedWorkers.length >= MIN_LOADED_WORKERS_FOR_TERRITORY_PRESSURE && hasControllerProgressPressure)) {
    return false;
  }
  const controllerProgressWorkers = getControllerProgressWorkerLimit(
    creep,
    loadedWorkers.length,
    hasTerritoryExpansionPressure
  );
  const otherControllerUpgraders = loadedWorkers.filter(
    (worker) => !isSameCreep(worker, creep) && isUpgradingController(worker, controller)
  ).length;
  return otherControllerUpgraders < controllerProgressWorkers;
}
function getControllerProgressWorkerLimit(creep, loadedWorkerCount, hasTerritoryExpansionPressure) {
  if (hasTerritoryExpansionPressure) {
    return 1;
  }
  if (loadedWorkerCount >= MIN_LOADED_WORKERS_FOR_SURPLUS_CONTROLLER_PROGRESS && hasControllerUpgradeEnergySurplus(creep)) {
    return MAX_SURPLUS_CONTROLLER_PROGRESS_WORKERS;
  }
  return loadedWorkerCount >= MIN_LOADED_WORKERS_FOR_SECOND_SUSTAINED_CONTROLLER_PROGRESS ? MAX_SUSTAINED_CONTROLLER_PROGRESS_WORKERS : 1;
}
function shouldUseSurplusForControllerProgress(creep, controller) {
  if (isControllerUpgradeSaturated(creep, controller)) {
    return false;
  }
  if (shouldApplyControllerPressureLane(creep, controller)) {
    return true;
  }
  if (controller.my === true && controller.level >= 2 && hasRecoverableSurplusEnergy(creep)) {
    return true;
  }
  return false;
}
function shouldStandbySurplusWorkerInsteadOfAcquiring(creep, controller) {
  return (controller == null ? void 0 : controller.my) === true && isControllerUpgradeSaturated(creep, controller) && !hasNonControllerWorkerEnergyDemand(creep);
}
function hasNonControllerWorkerEnergyDemand(creep) {
  var _a;
  if (selectFillableEnergySink(creep)) {
    return true;
  }
  const constructionSites = typeof FIND_CONSTRUCTION_SITES === "number" && typeof ((_a = creep.room) == null ? void 0 : _a.find) === "function" ? creep.room.find(FIND_CONSTRUCTION_SITES) : [];
  if (constructionSites.length > 0) {
    return true;
  }
  return selectCriticalInfrastructureRepairTarget(creep) !== null || selectRepairTarget(creep) !== null;
}
function isControllerUpgradeSaturated(creep, controller) {
  if (controller.my !== true || shouldGuardControllerDowngrade(controller)) {
    return false;
  }
  const loadedWorkers = getSameRoomLoadedWorkers(creep);
  const otherControllerUpgraders = loadedWorkers.filter(
    (worker) => !isSameCreep(worker, creep) && isUpgradingController(worker, controller)
  ).length;
  if (otherControllerUpgraders === 0) {
    return false;
  }
  const controllerProgressWorkerLimit = Math.max(
    1,
    getControllerProgressWorkerLimit(
      creep,
      loadedWorkers.length,
      hasActiveTerritoryExpansionPressure(creep)
    )
  );
  return otherControllerUpgraders >= controllerProgressWorkerLimit;
}
function shouldApplySource2ControllerLane(creep, controller) {
  const topology = getSource2ControllerLaneTopology(creep.room, controller);
  if (!topology) {
    return false;
  }
  return !hasOtherSource2ControllerLaneWorker(creep, topology);
}
function selectSource2ControllerLaneLoadedTask(creep, controller, constructionSites, constructionReservationContext) {
  if (!shouldApplySource2ControllerLane(creep, controller)) {
    return null;
  }
  const productiveEnergySinkTask = selectNearbyProductiveEnergySinkTask(
    creep,
    constructionSites,
    controller,
    constructionReservationContext
  );
  return productiveEnergySinkTask != null ? productiveEnergySinkTask : canUpgradeController(controller) ? { type: "upgrade", targetId: controller.id } : null;
}
function canUpgradeController(controller) {
  return (controller == null ? void 0 : controller.my) === true;
}
function canLevelUpController(controller) {
  return (controller == null ? void 0 : controller.my) === true && typeof controller.level === "number" && Number.isFinite(controller.level) && controller.level < MAX_CONTROLLER_LEVEL;
}
function selectSource2ControllerLaneHarvestTask(creep) {
  const controller = creep.room.controller;
  if (!controller) {
    return null;
  }
  const topology = getSource2ControllerLaneTopology(creep.room, controller);
  if (!topology || isSourceDepleted(topology.source) || hasOtherSource2ControllerLaneWorker(creep, topology)) {
    return null;
  }
  return { type: "harvest", targetId: topology.source.id };
}
function getSource2ControllerLaneTopology(room, controller) {
  if (controller.my !== true || typeof controller.level !== "number" || controller.level < 2 || getRoomObjectPosition3(controller) === null || !isHomeRoomName(room, controller) || hasVisibleHostilePresence(room)) {
    return null;
  }
  const source = getSource2(room);
  if (!source) {
    return null;
  }
  const range = getRangeBetweenRoomObjectPositions(source, controller);
  if (range === null || range > SOURCE2_CONTROLLER_LANE_MAX_RANGE) {
    return null;
  }
  return { controller, source };
}
function getSource2(room) {
  var _a;
  if (typeof FIND_SOURCES !== "number" || typeof room.find !== "function") {
    return null;
  }
  return (_a = room.find(FIND_SOURCES)[SOURCE2_CONTROLLER_LANE_SOURCE_INDEX]) != null ? _a : null;
}
function isHomeRoomName(room, controller) {
  const roomName = getRoomName2(room);
  const controllerRoomName = getPositionRoomName(controller);
  return roomName === null || controllerRoomName === null || roomName === controllerRoomName;
}
function isSourceDepleted(source) {
  return typeof source.energy === "number" && source.energy <= 0;
}
function hasOtherSource2ControllerLaneWorker(creep, topology) {
  return getGameCreeps().some(
    (candidate) => !isSameCreep(candidate, creep) && isSameRoomWorker(candidate, creep.room) && isSource2ControllerLaneTask(candidate, topology)
  );
}
function isSameRoomWorker(creep, room) {
  var _a;
  return ((_a = creep.memory) == null ? void 0 : _a.role) === "worker" && isInRoom(creep, room);
}
function isSource2ControllerLaneTask(creep, topology) {
  var _a;
  const task = (_a = creep.memory) == null ? void 0 : _a.task;
  return (task == null ? void 0 : task.type) === "harvest" && task.targetId === topology.source.id || (task == null ? void 0 : task.type) === "upgrade" && task.targetId === topology.controller.id;
}
function getRangeBetweenRoomObjectPositions(left, right) {
  const leftPosition = getRoomObjectPosition3(left);
  const rightPosition = getRoomObjectPosition3(right);
  if (!leftPosition || !rightPosition || !isSameRoomPosition5(leftPosition, rightPosition)) {
    return null;
  }
  const rangeFromApi = getRangeBetweenRoomObjects2(left, right);
  if (rangeFromApi !== null) {
    return rangeFromApi;
  }
  return Math.max(Math.abs(leftPosition.x - rightPosition.x), Math.abs(leftPosition.y - rightPosition.y));
}
function getRoomObjectPosition3(object) {
  const position = object.pos;
  return isRoomPosition2(position) ? position : null;
}
function getPositionRoomName(object) {
  var _a, _b;
  return (_b = (_a = getRoomObjectPosition3(object)) == null ? void 0 : _a.roomName) != null ? _b : null;
}
function isSameRoomPosition5(left, right) {
  if (typeof left.roomName === "string" && typeof right.roomName === "string") {
    return left.roomName === right.roomName;
  }
  return true;
}
function isRoomPosition2(value) {
  return isWorkerTaskRecord(value) && typeof value.x === "number" && typeof value.y === "number" && typeof value.roomName === "string" && Number.isFinite(value.x) && Number.isFinite(value.y) && value.roomName.length > 0;
}
function hasRecoverableSurplusEnergy(creep) {
  return selectStoredEnergySource(creep) !== null || selectSalvageEnergySource(creep) !== null || findDroppedResources(creep.room).some(isUsefulDroppedEnergy);
}
function hasActiveControllerProgressPressure(creep) {
  var _a;
  const colonyName = getCreepColonyName(creep);
  if (!colonyName) {
    return false;
  }
  if (((_a = getRecordedColonySurvivalAssessment(colonyName)) == null ? void 0 : _a.mode) === "TERRITORY_READY") {
    return true;
  }
  return hasActiveTerritoryExpansionPressure(creep);
}
function hasActiveTerritoryExpansionPressure(creep) {
  var _a;
  const colonyName = getCreepColonyName(creep);
  if (!colonyName) {
    return false;
  }
  if (hasReadyTerritoryFollowUpEnergy(creep)) {
    return true;
  }
  const territoryMemory = (_a = globalThis.Memory) == null ? void 0 : _a.territory;
  if (!territoryMemory || !Array.isArray(territoryMemory.intents)) {
    return false;
  }
  return territoryMemory.intents.some((intent) => isActiveTerritoryPressureIntent(intent, colonyName));
}
function hasControllerUpgradeEnergySurplus(creep) {
  return hasRecoverableSurplusEnergy(creep) || hasFullRoomEnergyForControllerProgress(creep.room);
}
function hasFullRoomEnergyForControllerProgress(room) {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  return energyAvailable !== null && energyCapacityAvailable !== null && energyCapacityAvailable >= TERRITORY_CONTROLLER_BODY_COST && energyAvailable >= energyCapacityAvailable;
}
function hasReservedTerritoryFollowUpRefillCapacity(creep) {
  return hasActiveTerritoryFollowUpPreparationDemand(getCreepColonyName(creep));
}
function hasReadyTerritoryFollowUpEnergy(creep) {
  if (!hasReservedTerritoryFollowUpRefillCapacity(creep)) {
    return false;
  }
  const energyAvailable = getRoomEnergyAvailable(creep.room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(creep.room);
  if (energyAvailable === null || energyCapacityAvailable === null) {
    return false;
  }
  const followUpEnergyTarget = Math.min(TERRITORY_CONTROLLER_BODY_COST, energyCapacityAvailable);
  return energyAvailable >= followUpEnergyTarget;
}
function getRoomEnergyAvailable(room) {
  const energyAvailable = room.energyAvailable;
  return typeof energyAvailable === "number" && Number.isFinite(energyAvailable) ? energyAvailable : null;
}
function getRoomEnergyCapacityAvailable(room) {
  const energyCapacityAvailable = room.energyCapacityAvailable;
  return typeof energyCapacityAvailable === "number" && Number.isFinite(energyCapacityAvailable) ? energyCapacityAvailable : null;
}
function estimateRoomEnergyRefillShortfall(room) {
  const energyAvailable = getRoomEnergyAvailable(room);
  const energyCapacityAvailable = getRoomEnergyCapacityAvailable(room);
  if (energyAvailable === null || energyCapacityAvailable === null) {
    return null;
  }
  return Math.max(0, Math.ceil(Math.max(0, energyCapacityAvailable) - Math.max(0, energyAvailable)));
}
function getCreepColonyName(creep) {
  var _a;
  const colony = (_a = creep.memory) == null ? void 0 : _a.colony;
  if (typeof colony === "string" && colony.length > 0) {
    return colony;
  }
  return null;
}
function getCreepColonyRoom(creep) {
  var _a, _b, _c;
  const colonyName = getCreepColonyName(creep);
  if (!colonyName) {
    return null;
  }
  return (_c = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[colonyName]) != null ? _c : null;
}
function isActiveTerritoryPressureIntent(intent, colonyName) {
  if (!isWorkerTaskRecord(intent)) {
    return false;
  }
  return intent.colony === colonyName && intent.targetRoom !== colonyName && (intent.status === "planned" || intent.status === "active") && (intent.action === "claim" || intent.action === "reserve" || intent.action === "scout");
}
function getSameRoomLoadedWorkers(creep) {
  return getSameRoomLoadedWorkersFromCandidates(creep, getGameCreeps());
}
function getSameRoomLoadedWorkersForRefillReservations(creep) {
  return getSameRoomLoadedWorkersFromCandidates(creep, getRoomOwnedCreeps(creep.room));
}
function getSameRoomLoadedWorkersFromCandidates(creep, candidates) {
  const loadedWorkers = candidates.filter((candidate) => isSameRoomWorkerWithEnergy(candidate, creep.room));
  if (!loadedWorkers.includes(creep) && getUsedEnergy2(creep) > 0) {
    loadedWorkers.push(creep);
  }
  return loadedWorkers;
}
function isSameRoomWorkerWithEnergy(creep, room) {
  var _a;
  return ((_a = creep.memory) == null ? void 0 : _a.role) === "worker" && isInRoom(creep, room) && getUsedEnergy2(creep) > 0;
}
function isInRoom(creep, room) {
  var _a;
  if (typeof room.name === "string" && room.name.length > 0) {
    return ((_a = creep.room) == null ? void 0 : _a.name) === room.name;
  }
  return creep.room === room;
}
function getUsedEnergy2(creep) {
  return getStoredEnergy2(creep);
}
function getFreeEnergyCapacity2(creep) {
  return getFreeStoredEnergyCapacity(creep);
}
function getStoredEnergy2(object) {
  var _a;
  return (_a = getKnownStoredEnergy(object)) != null ? _a : 0;
}
function getKnownStoredEnergy(object) {
  var _a;
  const store = getStore(object);
  if (store) {
    const usedCapacity = (_a = store.getUsedCapacity) == null ? void 0 : _a.call(store, getWorkerEnergyResource());
    if (typeof usedCapacity === "number" && Number.isFinite(usedCapacity)) {
      return usedCapacity;
    }
    const storedEnergy = store[getWorkerEnergyResource()];
    if (typeof storedEnergy === "number" && Number.isFinite(storedEnergy)) {
      return storedEnergy;
    }
  }
  const legacyEnergy = object == null ? void 0 : object.energy;
  return typeof legacyEnergy === "number" && Number.isFinite(legacyEnergy) ? legacyEnergy : null;
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
function getEnergyCapacity(creep, carriedEnergy = getUsedEnergy2(creep), freeCapacity = getFreeEnergyCapacity2(creep)) {
  var _a;
  const store = getStore(creep);
  const capacity = (_a = store == null ? void 0 : store.getCapacity) == null ? void 0 : _a.call(store, getWorkerEnergyResource());
  if (typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0) {
    return capacity;
  }
  return Math.max(0, carriedEnergy + freeCapacity);
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
  return isDroppedEnergy(resource, MIN_DROPPED_ENERGY_PICKUP_AMOUNT);
}
function isDroppedEnergy(resource, minimumEnergy) {
  return resource.resourceType === getWorkerEnergyResource() && resource.amount >= minimumEnergy;
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
function selectSourceContainerHarvestTask(creep) {
  if (getActiveWorkParts(creep) <= 0 || typeof FIND_SOURCES !== "number" || !hasVisiblePositionedContainer(creep.room)) {
    return null;
  }
  const source = selectBestHarvestSource(
    creep,
    creep.room.find(FIND_SOURCES).filter((candidate) => hasNonEmptySourceContainer(creep.room, candidate))
  );
  return source ? { type: "harvest", targetId: source.id } : null;
}
function hasNonEmptySourceContainer(room, source) {
  const sourceContainer = findSourceContainer(room, source);
  return sourceContainer !== null && getStoredEnergy2(sourceContainer) > 0;
}
function hasVisiblePositionedContainer(room) {
  if (typeof FIND_STRUCTURES !== "number" || typeof room.find !== "function") {
    return false;
  }
  return room.find(FIND_STRUCTURES).some((structure) => {
    const position = getRoomObjectPosition3(structure);
    return position !== null && matchesStructureType6(structure.structureType, "STRUCTURE_CONTAINER", "container");
  });
}
function selectHarvestSource(creep) {
  const sources = creep.room.find(FIND_SOURCES);
  if (sources.length === 0) {
    return null;
  }
  return selectBestHarvestSource(creep, sources);
}
function selectBestHarvestSource(creep, sources) {
  if (sources.length === 0) {
    return null;
  }
  const viableSources = selectViableHarvestSources(sources, getHarvestEnergyTarget(creep));
  const assignmentLoads = getSameRoomWorkerHarvestLoads(creep.room.name, viableSources);
  const assignableSources = selectAssignableHarvestSources(creep, viableSources, assignmentLoads);
  if (assignableSources.length === 0) {
    return null;
  }
  const sourceLoads = assignableSources.map(
    (source) => createHarvestSourceLoad(source, getHarvestSourceAssignmentLoad(assignmentLoads, source))
  );
  let selectedLoad = sourceLoads[0];
  for (const sourceLoad of sourceLoads.slice(1)) {
    if (compareHarvestSourceLoads(creep, sourceLoad, selectedLoad) < 0) {
      selectedLoad = sourceLoad;
    }
  }
  return selectedLoad.source;
}
function selectAssignableHarvestSources(creep, sources, assignmentLoads) {
  return sources.filter(
    (source) => isAssignableHarvestSource(creep, source, getHarvestSourceAssignmentLoad(assignmentLoads, source))
  );
}
function isAssignableHarvestSource(creep, source, assignmentLoad) {
  if (!findSourceContainer(creep.room, source)) {
    return true;
  }
  if (isWorkerAssignedToHarvestSource(creep, source)) {
    return true;
  }
  return assignmentLoad.assignmentCount === 0;
}
function isWorkerAssignedToHarvestSource(creep, source) {
  var _a;
  const task = (_a = creep.memory) == null ? void 0 : _a.task;
  return (task == null ? void 0 : task.type) === "harvest" && String(task.targetId) === String(source.id);
}
function compareHarvestSourceLoads(creep, left, right) {
  const workLoadRatioComparison = compareHarvestSourceWorkLoadRatio(left, right);
  if (workLoadRatioComparison !== 0) {
    return workLoadRatioComparison;
  }
  const accessLoadRatioComparison = compareHarvestSourceAccessLoadRatio(left, right);
  if (accessLoadRatioComparison !== 0) {
    return accessLoadRatioComparison;
  }
  const assignmentComparison = left.assignmentCount - right.assignmentCount;
  if (assignmentComparison !== 0) {
    return assignmentComparison;
  }
  const assignedWorkComparison = left.assignedWorkParts - right.assignedWorkParts;
  if (assignedWorkComparison !== 0) {
    return assignedWorkComparison;
  }
  if (isCloserHarvestSource(creep, left.source, right.source)) {
    return -1;
  }
  if (isCloserHarvestSource(creep, right.source, left.source)) {
    return 1;
  }
  return 0;
}
function compareHarvestSourceLoadRatio(left, right) {
  return compareHarvestSourceWorkLoadRatio(left, right) || compareHarvestSourceAccessLoadRatio(left, right);
}
function compareHarvestSourceWorkLoadRatio(left, right) {
  return left.assignedWorkParts * right.workCapacity - right.assignedWorkParts * left.workCapacity;
}
function compareHarvestSourceAccessLoadRatio(left, right) {
  return left.assignmentCount * right.accessCapacity - right.assignmentCount * left.accessCapacity;
}
function createHarvestSourceLoad(source, assignmentLoad) {
  return {
    ...assignmentLoad,
    accessCapacity: getHarvestSourceAccessCapacity(source),
    workCapacity: getHarvestSourceWorkCapacity(source),
    source
  };
}
function getHarvestSourceAssignmentLoad(assignmentLoads, source) {
  var _a;
  return (_a = assignmentLoads.get(source.id)) != null ? _a : createEmptyHarvestSourceAssignmentLoad();
}
function createEmptyHarvestSourceAssignmentLoad() {
  return { assignedWorkParts: 0, assignmentCount: 0 };
}
function getHarvestSourceAccessCapacity(source) {
  const position = getRoomObjectPosition3(source);
  if (!position) {
    return 1;
  }
  const terrain = getRoomTerrain3(position.roomName);
  if (!terrain) {
    return 1;
  }
  const wallMask = getTerrainWallMask4();
  let capacity = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const x = position.x + dx;
      const y = position.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) {
        continue;
      }
      if ((terrain.get(x, y) & wallMask) === 0) {
        capacity += 1;
      }
    }
  }
  return Math.max(1, capacity);
}
function getHarvestSourceWorkCapacity(source) {
  const energyCapacity = getHarvestSourceEnergyCapacity(source);
  const regenTicks = getSourceEnergyRegenTicks();
  return Math.max(1, Math.ceil(energyCapacity / regenTicks / HARVEST_ENERGY_PER_WORK_PART));
}
function getHarvestSourceEnergyCapacity(source) {
  const sourceEnergyCapacity = source.energyCapacity;
  if (typeof sourceEnergyCapacity === "number" && Number.isFinite(sourceEnergyCapacity) && sourceEnergyCapacity > 0) {
    return sourceEnergyCapacity;
  }
  const defaultSourceEnergyCapacity = globalThis.SOURCE_ENERGY_CAPACITY;
  return typeof defaultSourceEnergyCapacity === "number" && Number.isFinite(defaultSourceEnergyCapacity) && defaultSourceEnergyCapacity > 0 ? defaultSourceEnergyCapacity : DEFAULT_SOURCE_ENERGY_CAPACITY;
}
function getSourceEnergyRegenTicks() {
  const regenTicks = globalThis.ENERGY_REGEN_TIME;
  return typeof regenTicks === "number" && Number.isFinite(regenTicks) && regenTicks > 0 ? regenTicks : DEFAULT_SOURCE_ENERGY_REGEN_TICKS;
}
function getRoomTerrain3(roomName) {
  var _a;
  const map = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (typeof (map == null ? void 0 : map.getRoomTerrain) !== "function") {
    return null;
  }
  return map.getRoomTerrain(roomName);
}
function getTerrainWallMask4() {
  const terrainWallMask = globalThis.TERRAIN_MASK_WALL;
  return typeof terrainWallMask === "number" ? terrainWallMask : 1;
}
function isCloserHarvestSource(creep, candidate, selected) {
  const candidateRange = getRangeBetweenRoomObjects2(creep, candidate);
  const selectedRange = getRangeBetweenRoomObjects2(creep, selected);
  return candidateRange !== null && selectedRange !== null && candidateRange < selectedRange;
}
function selectViableHarvestSources(sources, harvestEnergyTarget) {
  const sourcesWithEnergy = sources.filter(hasHarvestableEnergy);
  if (sourcesWithEnergy.length === 0) {
    return [];
  }
  const targetEnergy = Math.max(1, Math.ceil(harvestEnergyTarget));
  const loadReadySources = sourcesWithEnergy.filter(
    (source) => getHarvestSourceAvailableEnergy(source) >= targetEnergy
  );
  return loadReadySources.length > 0 ? loadReadySources : sourcesWithEnergy;
}
function hasHarvestableEnergy(source) {
  return getHarvestSourceAvailableEnergy(source) > 0;
}
function getHarvestSourceAvailableEnergy(source) {
  const energy = source.energy;
  if (typeof energy === "number" && Number.isFinite(energy)) {
    return Math.max(0, energy);
  }
  return getHarvestSourceEnergyCapacity(source);
}
function getHarvestEnergyTarget(creep) {
  return Math.max(1, getFreeEnergyCapacity2(creep));
}
function getSameRoomWorkerHarvestLoads(roomName, sources) {
  var _a, _b, _c, _d;
  const assignmentLoads = /* @__PURE__ */ new Map();
  for (const source of sources) {
    assignmentLoads.set(source.id, createEmptyHarvestSourceAssignmentLoad());
  }
  if (!roomName) {
    return assignmentLoads;
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  for (const assignedCreep of getGameCreeps()) {
    const task = (_a = assignedCreep.memory) == null ? void 0 : _a.task;
    const targetId = typeof (task == null ? void 0 : task.targetId) === "string" ? task.targetId : void 0;
    if (((_b = assignedCreep.memory) == null ? void 0 : _b.role) !== "worker" || ((_c = assignedCreep.room) == null ? void 0 : _c.name) !== roomName || (task == null ? void 0 : task.type) !== "harvest" || !targetId || !sourceIds.has(targetId)) {
      continue;
    }
    const sourceId = targetId;
    const currentLoad = (_d = assignmentLoads.get(sourceId)) != null ? _d : createEmptyHarvestSourceAssignmentLoad();
    assignmentLoads.set(sourceId, {
      assignedWorkParts: currentLoad.assignedWorkParts + getActiveWorkParts(assignedCreep),
      assignmentCount: currentLoad.assignmentCount + 1
    });
  }
  return assignmentLoads;
}
function getGameCreeps() {
  var _a;
  const creeps = (_a = globalThis.Game) == null ? void 0 : _a.creeps;
  return creeps ? Object.values(creeps) : [];
}

// src/telemetry/behaviorTelemetry.ts
var BEHAVIOR_COUNTER_KEYS = [
  { key: "idleTicks" },
  { key: "moveTicks" },
  { key: "workTicks" },
  { key: "stuckTicks" },
  { key: "containerTransfers" },
  { key: "pathLength" }
];
function observeCreepBehaviorTick(creep, tick = getGameTime7()) {
  var _a, _b;
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastObservedTick === tick) {
    return;
  }
  const currentPosition = getCreepPositionMemory(creep);
  if (currentPosition && telemetry.lastPosition && telemetry.lastMoveTick === tick - 1) {
    const stepDistance = getStepDistance(telemetry.lastPosition, currentPosition);
    if (stepDistance > 0) {
      telemetry.pathLength = ((_a = telemetry.pathLength) != null ? _a : 0) + stepDistance;
    } else {
      telemetry.stuckTicks = ((_b = telemetry.stuckTicks) != null ? _b : 0) + 1;
    }
  }
  if (currentPosition) {
    telemetry.lastPosition = currentPosition;
  }
  telemetry.lastObservedTick = tick;
}
function recordCreepBehaviorIdle(creep, tick = getGameTime7()) {
  var _a;
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastIdleTick === tick) {
    return;
  }
  telemetry.idleTicks = ((_a = telemetry.idleTicks) != null ? _a : 0) + 1;
  telemetry.lastIdleTick = tick;
}
function recordCreepBehaviorMove(creep, tick = getGameTime7()) {
  var _a;
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastMoveTick === tick) {
    return;
  }
  telemetry.moveTicks = ((_a = telemetry.moveTicks) != null ? _a : 0) + 1;
  telemetry.lastMoveTick = tick;
}
function recordCreepBehaviorWork(creep, tick = getGameTime7()) {
  var _a;
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  if (telemetry.lastWorkTick === tick) {
    return;
  }
  telemetry.workTicks = ((_a = telemetry.workTicks) != null ? _a : 0) + 1;
  telemetry.lastWorkTick = tick;
}
function recordCreepBehaviorRepairTarget(creep, targetId) {
  ensureCreepBehaviorTelemetry(creep).repairTargetId = targetId;
}
function recordCreepBehaviorContainerTransfer(creep) {
  var _a;
  const telemetry = ensureCreepBehaviorTelemetry(creep);
  telemetry.containerTransfers = ((_a = telemetry.containerTransfers) != null ? _a : 0) + 1;
}
function summarizeAndResetCreepBehaviorTelemetry(workers) {
  const creepSummaries = workers.map(toRuntimeCreepBehaviorSummary).filter((summary) => summary !== null).sort(compareRuntimeCreepBehaviorSummaries);
  if (creepSummaries.length === 0) {
    return {};
  }
  for (const worker of workers) {
    resetCreepBehaviorCounters(worker);
  }
  return {
    behavior: {
      creeps: creepSummaries,
      totals: summarizeBehaviorTotals(creepSummaries)
    }
  };
}
function ensureCreepBehaviorTelemetry(creep) {
  if (!creep.memory.behaviorTelemetry) {
    creep.memory.behaviorTelemetry = {};
  }
  return creep.memory.behaviorTelemetry;
}
function toRuntimeCreepBehaviorSummary(creep) {
  const telemetry = creep.memory.behaviorTelemetry;
  if (!telemetry || !hasReportableBehaviorTelemetry(telemetry)) {
    return null;
  }
  return {
    ...buildCreepNameSummary(creep),
    idleTicks: getNonNegativeCounter(telemetry.idleTicks),
    moveTicks: getNonNegativeCounter(telemetry.moveTicks),
    workTicks: getNonNegativeCounter(telemetry.workTicks),
    stuckTicks: getNonNegativeCounter(telemetry.stuckTicks),
    containerTransfers: getNonNegativeCounter(telemetry.containerTransfers),
    pathLength: getNonNegativeCounter(telemetry.pathLength),
    ...typeof telemetry.repairTargetId === "string" && telemetry.repairTargetId.length > 0 ? { repairTargetId: telemetry.repairTargetId } : {}
  };
}
function hasReportableBehaviorTelemetry(telemetry) {
  return BEHAVIOR_COUNTER_KEYS.some(({ key }) => getNonNegativeCounter(telemetry[key]) > 0) || typeof telemetry.repairTargetId === "string" && telemetry.repairTargetId.length > 0;
}
function resetCreepBehaviorCounters(creep) {
  const telemetry = creep.memory.behaviorTelemetry;
  if (!telemetry) {
    return;
  }
  for (const { key } of BEHAVIOR_COUNTER_KEYS) {
    delete telemetry[key];
  }
  delete telemetry.repairTargetId;
  delete telemetry.lastIdleTick;
  delete telemetry.lastWorkTick;
  if (!telemetry.lastPosition && telemetry.lastMoveTick === void 0 && telemetry.lastObservedTick === void 0) {
    delete creep.memory.behaviorTelemetry;
  }
}
function summarizeBehaviorTotals(creeps) {
  return creeps.reduce(
    (totals, creep) => ({
      idleTicks: totals.idleTicks + creep.idleTicks,
      moveTicks: totals.moveTicks + creep.moveTicks,
      workTicks: totals.workTicks + creep.workTicks,
      stuckTicks: totals.stuckTicks + creep.stuckTicks,
      containerTransfers: totals.containerTransfers + creep.containerTransfers,
      pathLength: totals.pathLength + creep.pathLength
    }),
    {
      idleTicks: 0,
      moveTicks: 0,
      workTicks: 0,
      stuckTicks: 0,
      containerTransfers: 0,
      pathLength: 0
    }
  );
}
function compareRuntimeCreepBehaviorSummaries(left, right) {
  var _a, _b;
  return ((_a = left.creepName) != null ? _a : "").localeCompare((_b = right.creepName) != null ? _b : "");
}
function buildCreepNameSummary(creep) {
  const name = creep.name;
  return typeof name === "string" && name.length > 0 ? { creepName: name } : {};
}
function getNonNegativeCounter(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function getCreepPositionMemory(creep) {
  const pos = creep.pos;
  if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number" || typeof pos.roomName !== "string") {
    return null;
  }
  return {
    x: pos.x,
    y: pos.y,
    roomName: pos.roomName
  };
}
function getStepDistance(previous, current) {
  if (previous.roomName !== current.roomName) {
    return 1;
  }
  return Math.max(Math.abs(current.x - previous.x), Math.abs(current.y - previous.y));
}
function getGameTime7() {
  const game = globalThis.Game;
  return typeof (game == null ? void 0 : game.time) === "number" ? game.time : 0;
}

// src/creeps/workerRunner.ts
var MAX_IMMEDIATE_RESELECT_EXECUTIONS = 1;
var WORKER_NULL_LOOP_TICK_WINDOW = 10;
var WORKER_STANDBY_IDLE_TIMEOUT_TICKS = 8;
var WORKER_NULL_LOOP_FALLBACK_ATTEMPTS = 2;
var OK_CODE3 = 0;
var MIN_HAULER_DROPPED_ENERGY = 25;
function runWorker(creep) {
  if (runControllerSustainMovement(creep)) {
    return;
  }
  observeCreepBehaviorTick(creep);
  const selectedTask = selectWorkerTaskForRunner(creep);
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
  } else if (shouldPreemptTaskForUpgraderBoost(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptEnergyAcquisitionTaskForNearbyEnergyChoice(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptLowLoadReturnTaskForEnergyAcquisition(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptTransferTaskForControllerDowngradeGuard(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptTransferTaskForBetterEnergySink(creep, currentTask, selectedTask)) {
    assignSelectedTask(creep, selectedTask, currentTask);
  } else if (shouldPreemptSpendingTaskForNearTermSpawnExtensionRefill(creep, currentTask, selectedTask)) {
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
function selectWorkerTaskForRunner(creep) {
  const selectedTask = selectWorkerTask(creep);
  return fallbackToEnergyOnNullSelectionLoop(creep, selectedTask);
}
function fallbackToEnergyOnNullSelectionLoop(creep, selectedTask) {
  var _a;
  if (selectedTask) {
    delete creep.memory.workerTaskSelectionNullLoop;
    return selectedTask;
  }
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  if (typeof gameTime !== "number") {
    return null;
  }
  const guardState = getWorkerTaskSelectionNullLoopState(creep, gameTime);
  const idleTicks = gameTime - guardState.idleStartTick + 1;
  if (idleTicks <= WORKER_STANDBY_IDLE_TIMEOUT_TICKS || guardState.fallbackAttempts >= WORKER_NULL_LOOP_FALLBACK_ATTEMPTS) {
    return null;
  }
  guardState.fallbackAttempts += 1;
  return selectWorkerPreHarvestTask(creep);
}
function getWorkerTaskSelectionNullLoopState(creep, gameTime) {
  const existing = creep.memory.workerTaskSelectionNullLoop;
  const isValidExistingState = Boolean(
    existing && typeof existing.lastNullSelectionTick === "number" && Number.isFinite(existing.lastNullSelectionTick) && typeof existing.nullSelectionCount === "number" && Number.isFinite(existing.nullSelectionCount) && typeof existing.fallbackAttempts === "number" && Number.isFinite(existing.fallbackAttempts) && typeof existing.idleStartTick === "number" && Number.isFinite(existing.idleStartTick)
  );
  const isInWindow = isValidExistingState && gameTime - existing.lastNullSelectionTick <= WORKER_NULL_LOOP_TICK_WINDOW;
  if (!isInWindow) {
    const state2 = {
      lastNullSelectionTick: gameTime,
      nullSelectionCount: 1,
      fallbackAttempts: 0,
      idleStartTick: gameTime
    };
    creep.memory.workerTaskSelectionNullLoop = state2;
    return state2;
  }
  const typedExisting = existing;
  const state = {
    ...typedExisting,
    nullSelectionCount: typedExisting.nullSelectionCount + 1
  };
  creep.memory.workerTaskSelectionNullLoop = state;
  return state;
}
function runControllerSustainMovement(creep) {
  var _a;
  const sustain = creep.memory.controllerSustain;
  if (!isControllerSustainMemory(sustain)) {
    return false;
  }
  const roomName = (_a = creep.room) == null ? void 0 : _a.name;
  if (roomName === sustain.targetRoom) {
    if (sustain.role === "hauler" && getCarriedEnergy(creep) <= 0) {
      clearAssignedTask(creep);
      moveTowardRoom(creep, sustain.homeRoom);
      return true;
    }
    return false;
  }
  if (sustain.role === "hauler" && shouldControllerSustainHaulerLoadAtHome(creep, sustain, roomName)) {
    const energyTask = selectControllerSustainHaulerEnergyTask(creep);
    if (energyTask) {
      creep.memory.task = energyTask;
      executeAssignedTask(creep, energyTask);
      return true;
    }
  }
  clearAssignedTask(creep);
  moveTowardRoom(creep, selectControllerSustainDestinationRoom(creep, sustain, roomName));
  return true;
}
function shouldControllerSustainHaulerLoadAtHome(creep, sustain, roomName) {
  return roomName === sustain.homeRoom && getFreeTransferEnergyCapacity(creep) > 0;
}
function selectControllerSustainDestinationRoom(creep, sustain, roomName) {
  if (sustain.role !== "hauler") {
    return sustain.targetRoom;
  }
  if (getCarriedEnergy(creep) > 0) {
    return sustain.targetRoom;
  }
  return roomName === sustain.homeRoom ? sustain.targetRoom : sustain.homeRoom;
}
function clearAssignedTask(creep) {
  delete creep.memory.task;
}
function moveTowardRoom(creep, roomName) {
  if (typeof creep.moveTo !== "function") {
    return;
  }
  const visibleController = getVisibleRoomController(roomName);
  if (visibleController) {
    creep.moveTo(visibleController);
    return;
  }
  const RoomPositionCtor = globalThis.RoomPosition;
  if (typeof RoomPositionCtor === "function") {
    creep.moveTo(new RoomPositionCtor(25, 25, roomName));
  }
}
function getVisibleRoomController(roomName) {
  var _a, _b, _c, _d;
  return (_d = (_c = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[roomName]) == null ? void 0 : _c.controller) != null ? _d : null;
}
function selectControllerSustainHaulerEnergyTask(creep) {
  var _a, _b;
  return (_b = (_a = selectControllerSustainStoredEnergyTask(creep)) != null ? _a : selectControllerSustainDroppedEnergyTask(creep)) != null ? _b : selectControllerSustainHarvestTask(creep);
}
function selectControllerSustainStoredEnergyTask(creep) {
  var _a;
  if (typeof ((_a = creep.room) == null ? void 0 : _a.find) !== "function") {
    return null;
  }
  const structures = creep.room.find(FIND_STRUCTURES);
  const source = structures.filter(isControllerSustainStoredEnergySource).sort((left, right) => compareRoomObjectsByRangeAndId(creep, left, right))[0];
  return source ? { type: "withdraw", targetId: source.id } : null;
}
function selectControllerSustainDroppedEnergyTask(creep) {
  var _a;
  if (typeof ((_a = creep.room) == null ? void 0 : _a.find) !== "function") {
    return null;
  }
  const droppedEnergy = creep.room.find(FIND_DROPPED_RESOURCES).filter((resource) => resource.resourceType === RESOURCE_ENERGY && resource.amount >= MIN_HAULER_DROPPED_ENERGY).sort((left, right) => compareRoomObjectsByRangeAndId(creep, left, right))[0];
  return droppedEnergy ? { type: "pickup", targetId: droppedEnergy.id } : null;
}
function selectControllerSustainHarvestTask(creep) {
  var _a;
  if (typeof ((_a = creep.room) == null ? void 0 : _a.find) !== "function") {
    return null;
  }
  const source = creep.room.find(FIND_SOURCES).filter((candidate) => candidate.energy === void 0 || candidate.energy > 0).sort((left, right) => compareRoomObjectsByRangeAndId(creep, left, right))[0];
  return source ? { type: "harvest", targetId: source.id } : null;
}
function isControllerSustainStoredEnergySource(structure) {
  const structureType = structure.structureType;
  const ownedState = structure.my;
  return (structureType === STRUCTURE_CONTAINER || ownedState !== false) && (structureType === STRUCTURE_CONTAINER || structureType === STRUCTURE_STORAGE || structureType === STRUCTURE_TERMINAL) && getStoredEnergy3(structure) > 0;
}
function compareRoomObjectsByRangeAndId(creep, left, right) {
  return getRangeToRoomObject(creep, left) - getRangeToRoomObject(creep, right) || getStableId(left).localeCompare(getStableId(right));
}
function getRangeToRoomObject(creep, target) {
  var _a, _b;
  const range = (_b = (_a = creep.pos) == null ? void 0 : _a.getRangeTo) == null ? void 0 : _b.call(_a, target);
  return typeof range === "number" ? range : Number.MAX_SAFE_INTEGER;
}
function getStableId(object) {
  const id = object.id;
  return typeof id === "string" ? id : "";
}
function getStoredEnergy3(target) {
  var _a, _b;
  const storedEnergy = (_b = (_a = target.store) == null ? void 0 : _a.getUsedCapacity) == null ? void 0 : _b.call(_a, RESOURCE_ENERGY);
  return typeof storedEnergy === "number" && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}
function getCarriedEnergy(creep) {
  return getStoredEnergy3(creep);
}
function isControllerSustainMemory(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const memory = value;
  return typeof memory.homeRoom === "string" && memory.homeRoom.length > 0 && typeof memory.targetRoom === "string" && memory.targetRoom.length > 0 && (memory.role === "upgrader" || memory.role === "hauler");
}
function executeAssignedTask(creep, selectedTask, immediateReselectExecutions = 0) {
  let task = creep.memory.task;
  if (!task || !canExecuteTask(creep, task)) {
    recordCreepBehaviorIdle(creep);
    return;
  }
  let target = Game.getObjectById(task.targetId);
  if (!target) {
    if (selectedTask && isSameTask(task, selectedTask)) {
      recordCreepBehaviorIdle(creep);
      return;
    }
    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      recordCreepBehaviorIdle(creep);
      return;
    }
    target = Game.getObjectById(task.targetId);
    if (!target) {
      recordCreepBehaviorIdle(creep);
      return;
    }
  }
  if (shouldReplaceTarget(creep, task, target)) {
    task = assignSelectedTask(creep, selectedTask, task);
    if (!task || !canExecuteTask(creep, task)) {
      recordCreepBehaviorIdle(creep);
      return;
    }
    target = Game.getObjectById(task.targetId);
    if (!target || shouldReplaceTarget(creep, task, target)) {
      recordCreepBehaviorIdle(creep);
      return;
    }
  }
  const execution = executeTask(creep, task, target);
  recordTaskBehavior(creep, task, execution);
  if (shouldImmediatelyReselectAfterTaskResult(task, execution.result)) {
    delete creep.memory.task;
    const nextTask = assignNextTask(creep);
    if (nextTask && !isSameTask(task, nextTask) && immediateReselectExecutions < MAX_IMMEDIATE_RESELECT_EXECUTIONS) {
      executeAssignedTask(creep, nextTask, immediateReselectExecutions + 1);
    }
    return;
  }
  if (execution.result === ERR_NOT_IN_RANGE) {
    creep.moveTo(target);
    recordCreepBehaviorMove(creep);
  }
}
function shouldImmediatelyReselectAfterTaskResult(task, result) {
  if (task.type === "transfer") {
    return result === ERR_FULL;
  }
  return isEnergyAcquisitionTask(task) && isUnavailableEnergyAcquisitionResult(result);
}
function isUnavailableEnergyAcquisitionResult(result) {
  return result === ERR_NOT_ENOUGH_RESOURCES || result === ERR_INVALID_TARGET;
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
  const task = selectWorkerTaskForRunner(creep);
  if (task) {
    creep.memory.task = task;
  }
  return task;
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
    if (task.type === "harvest") {
      const sourceContainer = findHarvestTaskSourceContainer(creep, task);
      if (sourceContainer) {
        return freeEnergyCapacity === 0 || getFreeTransferEnergyCapacity(sourceContainer) <= 0;
      }
    }
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
function shouldPreemptSpendingTaskForNearTermSpawnExtensionRefill(creep, task, selectedTask) {
  return selectedTask === null && isEnergySpendingTask(task) && shouldReserveCarriedEnergyForNearTermSpawnExtensionRefill(creep);
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
  if (isDedicatedSourceContainerHarvestTask(creep, task)) {
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
  return isUrgentEnergySpendingTask(selectedTask) || isDowngradeGuardUpgradeTask(creep, selectedTask);
}
function shouldPreemptTaskForUpgraderBoost(creep, task, selectedTask) {
  var _a;
  if (!isOwnedControllerUpgradeTask(creep, selectedTask) || isSameTask(task, selectedTask)) {
    return false;
  }
  if (!isUpgraderBoostActive(creep, (_a = creep.room) == null ? void 0 : _a.controller)) {
    return false;
  }
  return getCarriedEnergy(creep) > 0;
}
function shouldPreemptEnergyAcquisitionTaskForNearbyEnergyChoice(creep, task, selectedTask) {
  var _a;
  if (!isEnergyAcquisitionTask(task) || !selectedTask || !isEnergyAcquisitionTask(selectedTask)) {
    return false;
  }
  if (isSameTask(task, selectedTask)) {
    return false;
  }
  const sample = (_a = creep.memory) == null ? void 0 : _a.workerEfficiency;
  return (sample == null ? void 0 : sample.type) === "nearbyEnergyChoice" && sample.selectedTask === selectedTask.type && sample.targetId === String(selectedTask.targetId) && isCurrentWorkerEfficiencySample(sample);
}
function shouldPreemptLowLoadReturnTaskForEnergyAcquisition(creep, task, selectedTask) {
  var _a;
  if (!isLowLoadReturnTask(task) || !selectedTask || !isEnergyAcquisitionTask(selectedTask)) {
    return false;
  }
  if (isSameTask(task, selectedTask)) {
    return false;
  }
  const sample = (_a = creep.memory) == null ? void 0 : _a.workerEfficiency;
  return (sample == null ? void 0 : sample.type) === "nearbyEnergyChoice" && sample.selectedTask === selectedTask.type && sample.targetId === String(selectedTask.targetId) && isCurrentWorkerEfficiencySample(sample);
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
  const selectedPriority = getTransferSinkPriority(selectedTarget);
  const currentPriority = getTransferSinkPriority(currentTarget);
  if (selectedPriority > currentPriority) {
    return true;
  }
  return isPrimaryTransferSink(currentTarget) && selectedPriority > 0 && isValidTransferTarget(selectedTarget) && isCurrentTransferTargetCoveredByOtherLoadedWorkers(creep, task, currentTarget);
}
function shouldPreemptTransferTaskForControllerDowngradeGuard(creep, task, selectedTask) {
  if (task.type !== "transfer") {
    return false;
  }
  return isDowngradeGuardUpgradeTask(creep, selectedTask);
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
function isDowngradeGuardUpgradeTask(creep, task) {
  var _a;
  if (!isOwnedControllerUpgradeTask(creep, task)) {
    return false;
  }
  const ticksToDowngrade = (_a = creep.room.controller) == null ? void 0 : _a.ticksToDowngrade;
  return typeof ticksToDowngrade === "number" && ticksToDowngrade <= CONTROLLER_DOWNGRADE_GUARD_TICKS2;
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
function isLowLoadReturnTask(task) {
  return task.type === "transfer" || task.type === "build" || task.type === "repair" || task.type === "upgrade";
}
function isRecoverableEnergyTask(task) {
  return (task == null ? void 0 : task.type) === "pickup" || (task == null ? void 0 : task.type) === "withdraw";
}
function isCurrentWorkerEfficiencySample(sample) {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime !== "number" || sample.tick === gameTime;
}
function isTerritoryControlTask2(task) {
  return (task == null ? void 0 : task.type) === "claim" || (task == null ? void 0 : task.type) === "reserve";
}
function isValidTransferTarget(target) {
  return getFreeTransferEnergyCapacity(target) > 0;
}
function isPrimaryTransferSink(target) {
  return getTransferSinkPriority(target) >= 2;
}
function isCurrentTransferTargetCoveredByOtherLoadedWorkers(creep, task, target) {
  var _a;
  const targetId = String(task.targetId);
  const freeCapacity = getFreeTransferEnergyCapacity(target);
  if (freeCapacity <= 0) {
    return false;
  }
  let reservedEnergy = 0;
  for (const worker of creep.room.find(FIND_MY_CREEPS)) {
    if (isSameCreep2(worker, creep) || !isSameRoomWorkerWithEnergy2(worker, creep.room)) {
      continue;
    }
    const workerTask = (_a = worker.memory) == null ? void 0 : _a.task;
    if ((workerTask == null ? void 0 : workerTask.type) !== "transfer" || String(workerTask.targetId) !== targetId) {
      continue;
    }
    reservedEnergy += getUsedTransferEnergy(worker);
    if (reservedEnergy >= freeCapacity) {
      return true;
    }
  }
  return false;
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
  const getObjectById3 = game == null ? void 0 : game.getObjectById;
  return typeof getObjectById3 === "function" ? getObjectById3(String(task.targetId)) : null;
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
function getUsedTransferEnergy(creep) {
  var _a, _b;
  const usedCapacity = (_b = (_a = creep.store) == null ? void 0 : _a.getUsedCapacity) == null ? void 0 : _b.call(_a, RESOURCE_ENERGY);
  return typeof usedCapacity === "number" && Number.isFinite(usedCapacity) ? Math.max(0, usedCapacity) : 0;
}
function isSameRoomWorkerWithEnergy2(creep, room) {
  var _a;
  return ((_a = creep.memory) == null ? void 0 : _a.role) === "worker" && isInRoom2(creep, room) && getUsedTransferEnergy(creep) > 0;
}
function isInRoom2(creep, room) {
  var _a;
  if (typeof room.name === "string" && room.name.length > 0) {
    return ((_a = creep.room) == null ? void 0 : _a.name) === room.name;
  }
  return creep.room === room;
}
function isSameCreep2(left, right) {
  if (left === right) {
    return true;
  }
  const leftKey = getCreepStableKey(left);
  return leftKey.length > 0 && leftKey === getCreepStableKey(right);
}
function getCreepStableKey(creep) {
  const name = creep.name;
  if (typeof name === "string" && name.length > 0) {
    return name;
  }
  const id = creep.id;
  return typeof id === "string" && id.length > 0 ? id : "";
}
function getTransferSinkPriority(target) {
  const structureType = target == null ? void 0 : target.structureType;
  if (typeof structureType !== "string") {
    return 0;
  }
  if (matchesTransferSinkStructureType(structureType, "STRUCTURE_SPAWN", "spawn")) {
    return isCriticalSpawnRefillTarget(target) ? 3 : 2;
  }
  if (matchesTransferSinkStructureType(structureType, "STRUCTURE_EXTENSION", "extension")) {
    return 2;
  }
  return matchesTransferSinkStructureType(structureType, "STRUCTURE_TOWER", "tower") ? 1 : 0;
}
function isCriticalSpawnRefillTarget(target) {
  const structureType = target == null ? void 0 : target.structureType;
  const storedEnergy = getKnownStoredTransferEnergy(target);
  return typeof structureType === "string" && matchesTransferSinkStructureType(structureType, "STRUCTURE_SPAWN", "spawn") && storedEnergy !== null && storedEnergy < CRITICAL_SPAWN_REFILL_ENERGY_THRESHOLD;
}
function getKnownStoredTransferEnergy(target) {
  var _a;
  const store = target == null ? void 0 : target.store;
  const usedCapacity = (_a = store == null ? void 0 : store.getUsedCapacity) == null ? void 0 : _a.call(store, RESOURCE_ENERGY);
  if (typeof usedCapacity === "number" && Number.isFinite(usedCapacity)) {
    return usedCapacity;
  }
  const storedEnergy = store == null ? void 0 : store[RESOURCE_ENERGY];
  if (typeof storedEnergy === "number" && Number.isFinite(storedEnergy)) {
    return storedEnergy;
  }
  const legacyEnergy = target == null ? void 0 : target.energy;
  return typeof legacyEnergy === "number" && Number.isFinite(legacyEnergy) ? legacyEnergy : null;
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
function shouldReplaceTarget(creep, task, target) {
  var _a;
  if (task.type === "harvest" && isDepletedHarvestSource(target)) {
    return !findSourceContainer(creep.room, target);
  }
  if (task.type === "transfer" && "store" in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    return true;
  }
  if (task.type === "withdraw" && "store" in target && ((_a = target.store.getUsedCapacity(RESOURCE_ENERGY)) != null ? _a : 0) === 0) {
    return true;
  }
  if (task.type === "pickup" && "amount" in target && typeof target.amount === "number" && target.amount <= 0) {
    return true;
  }
  return task.type === "repair" && "hits" in target && isWorkerRepairTargetComplete(target);
}
function isDepletedHarvestSource(target) {
  const energy = target == null ? void 0 : target.energy;
  return typeof energy === "number" && energy <= 0;
}
function executeTask(creep, task, target) {
  switch (task.type) {
    case "harvest":
      return executeHarvestTask(creep, target);
    case "pickup":
      return toTaskExecutionResult(creep.pickup(target), "work");
    case "withdraw":
      return toTaskExecutionResult(creep.withdraw(target, RESOURCE_ENERGY), "work");
    case "transfer":
      return toTaskExecutionResult(creep.transfer(target, RESOURCE_ENERGY), "work", {
        containerTransfer: isContainerStructure2(target)
      });
    case "build":
      return toTaskExecutionResult(creep.build(target), "work");
    case "repair":
      return toTaskExecutionResult(creep.repair(target), "work");
    case "claim":
      if (typeof creep.attackController === "function" && canCreepPressureTerritoryController(creep, target, creep.memory.colony)) {
        return toTaskExecutionResult(creep.attackController(target), "work");
      }
      return toTaskExecutionResult(creep.claimController(target), "work");
    case "reserve":
      if (typeof creep.attackController === "function" && canCreepPressureTerritoryController(creep, target, creep.memory.colony)) {
        return toTaskExecutionResult(creep.attackController(target), "work");
      }
      return toTaskExecutionResult(creep.reserveController(target), "work");
    case "upgrade":
      signOccupiedControllerIfNeeded(creep, target);
      return toTaskExecutionResult(creep.upgradeController(target), "work");
  }
}
function executeHarvestTask(creep, source) {
  const sourceContainer = findSourceContainer(creep.room, source);
  if (!sourceContainer) {
    return toTaskExecutionResult(creep.harvest(source), "work");
  }
  if (!isInRangeToRoomObject(creep, source, 1)) {
    creep.moveTo(sourceContainer);
    return { result: OK_CODE3, action: "move" };
  }
  if (isDepletedHarvestSource(source)) {
    return getUsedTransferEnergy(creep) > 0 ? transferDedicatedHarvestEnergy(creep, sourceContainer) : { result: OK_CODE3 };
  }
  if (getFreeTransferEnergyCapacity(creep) <= 0 && getUsedTransferEnergy(creep) > 0) {
    return transferDedicatedHarvestEnergy(creep, sourceContainer);
  }
  const result = creep.harvest(source);
  if ((result === ERR_FULL || result === ERR_NOT_ENOUGH_RESOURCES) && getUsedTransferEnergy(creep) > 0) {
    return transferDedicatedHarvestEnergy(creep, sourceContainer);
  }
  return toTaskExecutionResult(result === ERR_NOT_ENOUGH_RESOURCES ? OK_CODE3 : result, "work");
}
function transferDedicatedHarvestEnergy(creep, sourceContainer) {
  if (typeof creep.transfer !== "function") {
    return { result: OK_CODE3 };
  }
  const result = creep.transfer(sourceContainer, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) {
    creep.moveTo(sourceContainer);
    return { result: OK_CODE3, action: "move" };
  }
  return toTaskExecutionResult(result, "work", { containerTransfer: true });
}
function toTaskExecutionResult(result, successAction, options = {}) {
  return {
    result,
    ...result === OK_CODE3 ? { action: successAction } : {},
    ...result === OK_CODE3 && options.containerTransfer ? { containerTransfer: true } : {}
  };
}
function recordTaskBehavior(creep, task, execution) {
  if (task.type === "repair") {
    recordCreepBehaviorRepairTarget(creep, String(task.targetId));
  }
  if (execution.action === "move") {
    recordCreepBehaviorMove(creep);
  } else if (execution.action === "work") {
    recordCreepBehaviorWork(creep);
  } else if (execution.result !== ERR_NOT_IN_RANGE) {
    recordCreepBehaviorIdle(creep);
  }
  if (execution.containerTransfer) {
    recordCreepBehaviorContainerTransfer(creep);
  }
}
function isContainerStructure2(target) {
  const structureType = target == null ? void 0 : target.structureType;
  return typeof structureType === "string" && matchesContainerStructureType(structureType);
}
function matchesContainerStructureType(actual) {
  var _a;
  const containerType = (_a = globalThis.STRUCTURE_CONTAINER) != null ? _a : "container";
  return actual === containerType;
}
function isDedicatedSourceContainerHarvestTask(creep, task) {
  return task.type === "harvest" && findHarvestTaskSourceContainer(creep, task) !== null;
}
function findHarvestTaskSourceContainer(creep, task) {
  const source = findHarvestTaskSource(creep, task);
  return source === null ? null : findSourceContainer(creep.room, source);
}
function findHarvestTaskSource(creep, task) {
  var _a;
  if (typeof FIND_SOURCES === "number" && typeof ((_a = creep.room) == null ? void 0 : _a.find) === "function") {
    const visibleSource = creep.room.find(FIND_SOURCES).find((source) => String(source.id) === String(task.targetId));
    if (visibleSource) {
      return visibleSource;
    }
  }
  const target = getTaskTarget(task);
  return target && String(target.id) === String(task.targetId) ? target : null;
}
function isInRangeToRoomObject(creep, target, range) {
  const position = creep.pos;
  if (typeof (position == null ? void 0 : position.getRangeTo) !== "function") {
    return true;
  }
  const actualRange = position.getRangeTo(target);
  return Number.isFinite(actualRange) && actualRange <= range;
}

// src/creeps/remoteHarvester.ts
var REMOTE_HARVESTER_ROLE = "remoteHarvester";
var REMOTE_CREEP_REPLACEMENT_TICKS = 100;
var MAX_REMOTE_HARVESTERS_PER_SOURCE = 1;
var MAX_REMOTE_HARVESTER_WORK_PARTS = 5;
var REMOTE_MOVE_OPTS = { reusePath: 20, ignoreRoads: false };
var ERR_FULL_CODE = -8;
var ERR_NOT_ENOUGH_RESOURCES_CODE = -6;
var ERR_NOT_IN_RANGE_CODE3 = -9;
function buildRemoteHarvesterBody(energyAvailable) {
  const workParts = Math.min(
    MAX_REMOTE_HARVESTER_WORK_PARTS,
    Math.floor((Math.max(0, energyAvailable) - 100) / 100)
  );
  if (workParts <= 0) {
    return [];
  }
  return [...Array.from({ length: workParts }, () => "work"), "carry", "move"];
}
function selectRemoteHarvesterAssignment(homeRoom) {
  var _a;
  return (_a = getRemoteSourceAssignments(homeRoom).find(
    (assignment) => countRemoteHarvestersForSource(assignment) < MAX_REMOTE_HARVESTERS_PER_SOURCE
  )) != null ? _a : null;
}
function getRemoteSourceAssignments(homeRoom) {
  if (!isNonEmptyString7(homeRoom)) {
    return [];
  }
  const records = getRemoteBootstrapRecords(homeRoom);
  const assignments = [];
  for (const record of records) {
    if (record.roomName === homeRoom || !isAdjacentRoomOrUnknown(homeRoom, record.roomName) || isRemoteOperationSuspended(homeRoom, record.roomName)) {
      continue;
    }
    const room = getVisibleRoom2(record.roomName);
    if (!isUsableRemoteRoom(room)) {
      continue;
    }
    assignments.push(...getRemoteSourceAssignmentsInRoom(homeRoom, room));
  }
  return assignments.sort(compareRemoteSourceAssignments);
}
function isRemoteOperationSuspended(homeRoom, targetRoom) {
  if (isKnownDeadZoneRoom(targetRoom)) {
    return true;
  }
  if (hasHostileSuspendedTerritoryIntent(homeRoom, targetRoom)) {
    return true;
  }
  return hasSafeRouteAvoidingDeadZones(homeRoom, targetRoom) === false;
}
function runRemoteHarvester(creep) {
  var _a, _b, _c, _d, _e;
  const assignment = normalizeRemoteHarvesterMemory((_a = creep.memory) == null ? void 0 : _a.remoteHarvester);
  if (!assignment) {
    return;
  }
  if (isRemoteOperationSuspended(assignment.homeRoom, assignment.targetRoom)) {
    delete creep.memory.task;
    moveTowardRoom2(creep, assignment.homeRoom);
    return;
  }
  if (((_b = creep.room) == null ? void 0 : _b.name) !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom2(creep, assignment.targetRoom, (_c = getAssignedContainer(assignment)) != null ? _c : getAssignedSource(assignment));
    return;
  }
  const source = getAssignedSource(assignment);
  const container = getAssignedContainer(assignment);
  if (!container) {
    delete creep.memory.task;
    if (getCarriedEnergy2(creep) > 0) {
      (_d = creep.drop) == null ? void 0 : _d.call(creep, getEnergyResource3());
      return;
    }
  }
  if (!source) {
    if (container) {
      moveTo(creep, container);
    }
    return;
  }
  if (!isInRangeTo(creep, source, 1)) {
    moveTo(creep, container != null ? container : source);
    return;
  }
  if (isSourceDepleted2(source)) {
    if (container && getCarriedEnergy2(creep) > 0) {
      transferToContainer(creep, container);
    }
    return;
  }
  if (container && getFreeEnergyCapacity3(creep) <= 0 && getCarriedEnergy2(creep) > 0) {
    transferToContainer(creep, container);
    return;
  }
  const result = (_e = creep.harvest) == null ? void 0 : _e.call(creep, source);
  if (container && (result === getErrFullCode() || result === getErrNotEnoughResourcesCode()) && getCarriedEnergy2(creep) > 0) {
    transferToContainer(creep, container);
  }
}
function moveTowardRoom2(creep, roomName, target) {
  var _a;
  if (target) {
    moveTo(creep, target);
    return;
  }
  const visibleController = (_a = getVisibleRoom2(roomName)) == null ? void 0 : _a.controller;
  if (visibleController) {
    moveTo(creep, visibleController);
    return;
  }
  const RoomPositionCtor = globalThis.RoomPosition;
  if (typeof RoomPositionCtor === "function") {
    moveTo(creep, new RoomPositionCtor(25, 25, roomName));
  }
}
function getRemoteSourceAssignmentsInRoom(homeRoom, room) {
  if (typeof FIND_SOURCES !== "number" || typeof room.find !== "function") {
    return [];
  }
  return room.find(FIND_SOURCES).map((source) => {
    const container = findSourceContainer(room, source);
    return container ? {
      homeRoom,
      targetRoom: room.name,
      sourceId: source.id,
      containerId: container.id,
      containerEnergy: getStoredEnergy4(container)
    } : null;
  }).filter((assignment) => assignment !== null);
}
function getRemoteBootstrapRecords(homeRoom) {
  var _a, _b;
  const records = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.postClaimBootstraps;
  if (!isRecord7(records)) {
    return [];
  }
  return Object.values(records).filter((record) => isRemoteBootstrapRecord(record, homeRoom)).sort(compareRemoteBootstrapRecords);
}
function isRemoteBootstrapRecord(record, homeRoom) {
  return isRecord7(record) && record.colony === homeRoom && isNonEmptyString7(record.roomName) && record.roomName !== homeRoom && (record.status === "detected" || record.status === "spawnSitePending" || record.status === "spawnSiteBlocked" || record.status === "spawningWorkers" || record.status === "ready");
}
function compareRemoteBootstrapRecords(left, right) {
  return left.claimedAt - right.claimedAt || left.roomName.localeCompare(right.roomName);
}
function compareRemoteSourceAssignments(left, right) {
  return left.targetRoom.localeCompare(right.targetRoom) || String(left.sourceId).localeCompare(String(right.sourceId));
}
function isUsableRemoteRoom(room) {
  var _a;
  return ((_a = room == null ? void 0 : room.controller) == null ? void 0 : _a.my) === true && typeof room.find === "function";
}
function countRemoteHarvestersForSource(assignment) {
  return getGameCreeps2().filter(
    (creep) => {
      var _a, _b, _c, _d;
      return ((_a = creep.memory) == null ? void 0 : _a.role) === REMOTE_HARVESTER_ROLE && canSatisfyRemoteCreepCapacity(creep) && ((_b = creep.memory.remoteHarvester) == null ? void 0 : _b.homeRoom) === assignment.homeRoom && ((_c = creep.memory.remoteHarvester) == null ? void 0 : _c.targetRoom) === assignment.targetRoom && String((_d = creep.memory.remoteHarvester) == null ? void 0 : _d.sourceId) === String(assignment.sourceId);
    }
  ).length;
}
function canSatisfyRemoteCreepCapacity(creep) {
  return creep.ticksToLive === void 0 || creep.ticksToLive > REMOTE_CREEP_REPLACEMENT_TICKS;
}
function hasHostileSuspendedTerritoryIntent(homeRoom, targetRoom) {
  var _a, _b;
  const intents = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.intents;
  if (!Array.isArray(intents)) {
    return false;
  }
  return intents.some(
    (intent) => isRecord7(intent) && intent.colony === homeRoom && intent.targetRoom === targetRoom && intent.suspended !== void 0 && isRecord7(intent.suspended) && intent.suspended.reason === "hostile_presence"
  );
}
function normalizeRemoteHarvesterMemory(value) {
  if (!isRecord7(value)) {
    return null;
  }
  return isNonEmptyString7(value.homeRoom) && isNonEmptyString7(value.targetRoom) && isNonEmptyString7(value.sourceId) && isNonEmptyString7(value.containerId) ? {
    homeRoom: value.homeRoom,
    targetRoom: value.targetRoom,
    sourceId: value.sourceId,
    containerId: value.containerId
  } : null;
}
function getAssignedSource(assignment) {
  var _a;
  const source = getObjectById(assignment.sourceId);
  if (source) {
    return source;
  }
  const room = getVisibleRoom2(assignment.targetRoom);
  if (!room || typeof FIND_SOURCES !== "number" || typeof room.find !== "function") {
    return null;
  }
  return (_a = room.find(FIND_SOURCES).find((candidate) => String(candidate.id) === String(assignment.sourceId))) != null ? _a : null;
}
function getAssignedContainer(assignment) {
  return getObjectById(assignment.containerId);
}
function transferToContainer(creep, container) {
  var _a;
  const result = (_a = creep.transfer) == null ? void 0 : _a.call(creep, container, getEnergyResource3());
  if (result === getErrNotInRangeCode()) {
    moveTo(creep, container);
  }
}
function moveTo(creep, target) {
  var _a;
  (_a = creep.moveTo) == null ? void 0 : _a.call(creep, target, REMOTE_MOVE_OPTS);
}
function isInRangeTo(creep, target, range) {
  var _a, _b;
  const actualRange = (_b = (_a = creep.pos) == null ? void 0 : _a.getRangeTo) == null ? void 0 : _b.call(_a, target);
  return typeof actualRange !== "number" || actualRange <= range;
}
function isSourceDepleted2(source) {
  return typeof source.energy === "number" && source.energy <= 0;
}
function getCarriedEnergy2(creep) {
  return getStoredEnergy4(creep);
}
function getFreeEnergyCapacity3(creep) {
  var _a, _b;
  const freeCapacity = (_b = (_a = creep.store) == null ? void 0 : _a.getFreeCapacity) == null ? void 0 : _b.call(_a, getEnergyResource3());
  return typeof freeCapacity === "number" && Number.isFinite(freeCapacity) ? Math.max(0, freeCapacity) : 0;
}
function getStoredEnergy4(target) {
  var _a;
  const store = target == null ? void 0 : target.store;
  const usedCapacity = (_a = store == null ? void 0 : store.getUsedCapacity) == null ? void 0 : _a.call(store, getEnergyResource3());
  if (typeof usedCapacity === "number" && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }
  const storedEnergy = store == null ? void 0 : store[getEnergyResource3()];
  return typeof storedEnergy === "number" && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}
function getEnergyResource3() {
  var _a;
  return (_a = globalThis.RESOURCE_ENERGY) != null ? _a : "energy";
}
function getObjectById(id) {
  var _a;
  const getObjectById3 = (_a = globalThis.Game) == null ? void 0 : _a.getObjectById;
  return typeof getObjectById3 === "function" ? getObjectById3(String(id)) : null;
}
function getVisibleRoom2(roomName) {
  var _a, _b;
  return (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[roomName];
}
function getGameCreeps2() {
  var _a;
  const creeps = (_a = globalThis.Game) == null ? void 0 : _a.creeps;
  return creeps ? Object.values(creeps) : [];
}
function isAdjacentRoomOrUnknown(homeRoom, targetRoom) {
  const home = parseRoomCoordinates2(homeRoom);
  const target = parseRoomCoordinates2(targetRoom);
  if (!home || !target) {
    return true;
  }
  const distance = Math.max(Math.abs(home.x - target.x), Math.abs(home.y - target.y));
  return distance === 1;
}
function parseRoomCoordinates2(roomName) {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) {
    return null;
  }
  const horizontalValue = Number(match[2]);
  const verticalValue = Number(match[4]);
  if (!Number.isFinite(horizontalValue) || !Number.isFinite(verticalValue)) {
    return null;
  }
  return {
    x: match[1] === "E" ? horizontalValue : -horizontalValue - 1,
    y: match[3] === "S" ? verticalValue : -verticalValue - 1
  };
}
function getErrFullCode() {
  var _a;
  return (_a = globalThis.ERR_FULL) != null ? _a : ERR_FULL_CODE;
}
function getErrNotEnoughResourcesCode() {
  var _a;
  return (_a = globalThis.ERR_NOT_ENOUGH_RESOURCES) != null ? _a : ERR_NOT_ENOUGH_RESOURCES_CODE;
}
function getErrNotInRangeCode() {
  var _a;
  return (_a = globalThis.ERR_NOT_IN_RANGE) != null ? _a : ERR_NOT_IN_RANGE_CODE3;
}
function isRecord7(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString7(value) {
  return typeof value === "string" && value.length > 0;
}

// src/creeps/hauler.ts
var HAULER_ROLE = "hauler";
var REMOTE_HAULER_DISPATCH_ENERGY_THRESHOLD = 500;
var MAX_REMOTE_HAULERS_PER_CONTAINER = 1;
var MAX_REMOTE_HAULER_CARRY_MOVE_PAIRS = 10;
var HAULER_MOVE_OPTS = { reusePath: 20, ignoreRoads: false };
var ERR_NOT_IN_RANGE_CODE4 = -9;
function buildRemoteHaulerBody(energyAvailable) {
  const pairCount = Math.min(MAX_REMOTE_HAULER_CARRY_MOVE_PAIRS, Math.floor(Math.max(0, energyAvailable) / 100));
  if (pairCount <= 0) {
    return [];
  }
  return Array.from({ length: pairCount }).flatMap(() => ["carry", "move"]);
}
function selectRemoteHaulerAssignment(homeRoom) {
  var _a;
  return (_a = getRemoteSourceAssignments(homeRoom).filter((assignment) => assignment.containerEnergy > REMOTE_HAULER_DISPATCH_ENERGY_THRESHOLD).filter((assignment) => countRemoteHaulersForContainer(assignment) < MAX_REMOTE_HAULERS_PER_CONTAINER).sort(compareRemoteHaulerAssignments)[0]) != null ? _a : null;
}
function runHauler(creep) {
  var _a, _b;
  const assignment = normalizeRemoteHaulerMemory((_a = creep.memory) == null ? void 0 : _a.remoteHauler);
  if (!assignment) {
    return;
  }
  if (isRemoteOperationSuspended(assignment.homeRoom, assignment.targetRoom)) {
    delete creep.memory.task;
    if (((_b = creep.room) == null ? void 0 : _b.name) !== assignment.homeRoom || getCarriedEnergy3(creep) > 0) {
      moveTowardRoom2(creep, assignment.homeRoom);
    }
    return;
  }
  if (getCarriedEnergy3(creep) > 0) {
    deliverEnergy(creep, assignment);
    return;
  }
  collectRemoteEnergy(creep, assignment);
}
function collectRemoteEnergy(creep, assignment) {
  var _a, _b;
  const container = getAssignedContainer2(assignment);
  if (((_a = creep.room) == null ? void 0 : _a.name) !== assignment.targetRoom) {
    delete creep.memory.task;
    moveTowardRoom2(creep, assignment.targetRoom, container);
    return;
  }
  if (!container) {
    delete creep.memory.task;
    return;
  }
  if (getStoredEnergy5(container) <= 0) {
    delete creep.memory.task;
    moveTo2(creep, container);
    return;
  }
  const task = {
    type: "withdraw",
    targetId: assignment.containerId
  };
  creep.memory.task = task;
  const result = (_b = creep.withdraw) == null ? void 0 : _b.call(creep, container, getEnergyResource4());
  if (result === getErrNotInRangeCode2()) {
    moveTo2(creep, container);
  }
}
function deliverEnergy(creep, assignment) {
  var _a, _b;
  if (((_a = creep.room) == null ? void 0 : _a.name) !== assignment.homeRoom) {
    delete creep.memory.task;
    moveTowardRoom2(creep, assignment.homeRoom);
    return;
  }
  const task = selectRemoteHaulerDeliveryTask(creep.room);
  if (!task) {
    delete creep.memory.task;
    return;
  }
  creep.memory.task = task;
  const target = getObjectById2(task.targetId);
  if (!target) {
    delete creep.memory.task;
    return;
  }
  const result = (_b = creep.transfer) == null ? void 0 : _b.call(creep, target, getEnergyResource4());
  if (result === getErrNotInRangeCode2()) {
    moveTo2(creep, target);
  }
}
function compareRemoteHaulerAssignments(left, right) {
  return right.containerEnergy - left.containerEnergy || left.targetRoom.localeCompare(right.targetRoom) || String(left.sourceId).localeCompare(String(right.sourceId));
}
function countRemoteHaulersForContainer(assignment) {
  return getGameCreeps3().filter(
    (creep) => {
      var _a, _b, _c, _d;
      return ((_a = creep.memory) == null ? void 0 : _a.role) === HAULER_ROLE && canSatisfyRemoteCreepCapacity2(creep) && ((_b = creep.memory.remoteHauler) == null ? void 0 : _b.homeRoom) === assignment.homeRoom && ((_c = creep.memory.remoteHauler) == null ? void 0 : _c.targetRoom) === assignment.targetRoom && String((_d = creep.memory.remoteHauler) == null ? void 0 : _d.containerId) === String(assignment.containerId);
    }
  ).length;
}
function canSatisfyRemoteCreepCapacity2(creep) {
  return creep.ticksToLive === void 0 || creep.ticksToLive > REMOTE_CREEP_REPLACEMENT_TICKS;
}
function normalizeRemoteHaulerMemory(value) {
  if (!isRecord8(value)) {
    return null;
  }
  return isNonEmptyString8(value.homeRoom) && isNonEmptyString8(value.targetRoom) && isNonEmptyString8(value.sourceId) && isNonEmptyString8(value.containerId) ? {
    homeRoom: value.homeRoom,
    targetRoom: value.targetRoom,
    sourceId: value.sourceId,
    containerId: value.containerId
  } : null;
}
function getAssignedContainer2(assignment) {
  return getObjectById2(assignment.containerId);
}
function moveTo2(creep, target) {
  var _a;
  (_a = creep.moveTo) == null ? void 0 : _a.call(creep, target, HAULER_MOVE_OPTS);
}
function getCarriedEnergy3(creep) {
  return getStoredEnergy5(creep);
}
function getStoredEnergy5(target) {
  var _a;
  const store = target == null ? void 0 : target.store;
  const usedCapacity = (_a = store == null ? void 0 : store.getUsedCapacity) == null ? void 0 : _a.call(store, getEnergyResource4());
  if (typeof usedCapacity === "number" && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }
  const storedEnergy = store == null ? void 0 : store[getEnergyResource4()];
  return typeof storedEnergy === "number" && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}
function getEnergyResource4() {
  var _a;
  return (_a = globalThis.RESOURCE_ENERGY) != null ? _a : "energy";
}
function getObjectById2(id) {
  var _a;
  const getObjectById3 = (_a = globalThis.Game) == null ? void 0 : _a.getObjectById;
  return typeof getObjectById3 === "function" ? getObjectById3(String(id)) : null;
}
function getGameCreeps3() {
  var _a;
  const creeps = (_a = globalThis.Game) == null ? void 0 : _a.creeps;
  return creeps ? Object.values(creeps) : [];
}
function getErrNotInRangeCode2() {
  var _a;
  return (_a = globalThis.ERR_NOT_IN_RANGE) != null ? _a : ERR_NOT_IN_RANGE_CODE4;
}
function isRecord8(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString8(value) {
  return typeof value === "string" && value.length > 0;
}

// src/territory/multiRoomUpgrader.ts
var MULTI_ROOM_UPGRADER_DEFAULT_STORAGE_THRESHOLD_RATIO = 0.8;
var MULTI_ROOM_UPGRADER_DEFAULT_PER_ROOM_CAP = 1;
var REMOTE_UPGRADER_PATTERN = ["work", "carry", "move"];
var REMOTE_UPGRADER_TRAVEL_PATTERN = ["work", "carry", "move", "move"];
var RESERVED_CONTROLLER_BASE_BODY = ["claim", "move"];
var REMOTE_UPGRADER_PATTERN_COST = 200;
var MOVE_PART_COST = 50;
var MAX_CREEP_PARTS3 = 50;
var MAX_REMOTE_UPGRADER_PATTERN_COUNT = 4;
var DEFAULT_RESERVED_CONTROLLER_LEVEL = 0;
var ERR_NO_PATH_CODE4 = -2;
var TERRITORY_ROUTE_DISTANCE_SEPARATOR3 = ">";
var ROUTE_DISTANCE_CACHE_TTL_TICKS = 300;
function recordPlannedMultiRoomUpgraderSpawn(memory) {
  var _a, _b;
  const sustain = memory.controllerSustain;
  if (memory.role !== "worker" || (sustain == null ? void 0 : sustain.role) !== "upgrader" || !isNonEmptyString9(sustain.homeRoom) || !isNonEmptyString9(sustain.targetRoom)) {
    return;
  }
  const cache = getActiveMultiRoomUpgraderCountCache();
  const pendingByHome = (_a = cache.plannedByHomeRoom[sustain.homeRoom]) != null ? _a : {};
  pendingByHome[sustain.targetRoom] = ((_b = pendingByHome[sustain.targetRoom]) != null ? _b : 0) + 1;
  cache.plannedByHomeRoom[sustain.homeRoom] = pendingByHome;
}
function selectMultiRoomUpgradePlans(colony, options = {}) {
  const config = normalizeMultiRoomUpgraderOptions(options);
  if (config.perRoomUpgraderCap <= 0 || !hasPrimaryRoomStorageSurplus(colony, config.storageEnergyThresholdRatio)) {
    return [];
  }
  const candidates = getVisibleMultiRoomUpgradeCandidates(colony, config);
  if (candidates.length === 0) {
    return [];
  }
  return candidates.sort(compareMultiRoomUpgradeCandidates).map(({ order: _order, ...plan }) => plan);
}
function buildMultiRoomUpgraderBody(energyAvailable, plan) {
  const baseBody = plan.controllerState === "reserved" ? RESERVED_CONTROLLER_BASE_BODY : [];
  const remainingEnergy = energyAvailable - getBodyCost2(baseBody);
  if (remainingEnergy < REMOTE_UPGRADER_PATTERN_COST) {
    return [];
  }
  const pattern = getRemoteUpgraderPattern(plan.routeDistance);
  const patternCost = getBodyCost2(pattern);
  const maxPatternCountByEnergy = Math.floor(remainingEnergy / patternCost);
  const maxPatternCountBySize = Math.floor((MAX_CREEP_PARTS3 - baseBody.length) / pattern.length);
  const patternCount = Math.min(
    maxPatternCountByEnergy,
    maxPatternCountBySize,
    MAX_REMOTE_UPGRADER_PATTERN_COUNT
  );
  if (patternCount <= 0) {
    return [];
  }
  const body = [
    ...baseBody,
    ...Array.from({ length: patternCount }).flatMap(() => pattern)
  ];
  const unusedEnergy = energyAvailable - getBodyCost2(body);
  if (unusedEnergy >= MOVE_PART_COST && body.length < MAX_CREEP_PARTS3) {
    return [...body, "move"];
  }
  return body;
}
function buildMultiRoomUpgraderMemory(plan) {
  return {
    role: "worker",
    colony: plan.homeRoom,
    territory: {
      targetRoom: plan.targetRoom,
      action: plan.controllerState === "reserved" ? "reserve" : "claim",
      controllerId: plan.controllerId
    },
    controllerSustain: {
      homeRoom: plan.homeRoom,
      targetRoom: plan.targetRoom,
      role: "upgrader"
    }
  };
}
function getVisibleMultiRoomUpgradeCandidates(colony, config) {
  var _a;
  const rooms = (_a = globalThis.Game) == null ? void 0 : _a.rooms;
  if (!rooms) {
    return [];
  }
  const homeRoom = colony.room.name;
  const ownerUsername = getControllerOwnerUsername3(colony.room.controller);
  const activeUpgraderCounts = getActiveMultiRoomUpgraderCountsByTarget(homeRoom);
  const candidates = [];
  let order = 0;
  for (const room of Object.values(rooms)) {
    const candidate = getVisibleMultiRoomUpgradeCandidate(
      homeRoom,
      ownerUsername,
      room,
      config.perRoomUpgraderCap,
      activeUpgraderCounts,
      order
    );
    order += 1;
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}
function getVisibleMultiRoomUpgradeCandidate(homeRoom, ownerUsername, room, perRoomUpgraderCap, activeUpgraderCounts, order) {
  var _a;
  if (!isNonEmptyString9(room.name) || room.name === homeRoom || isKnownDeadZoneRoom(room.name)) {
    return null;
  }
  const controller = room.controller;
  if (!controller || !isNonEmptyString9(controller.id)) {
    return null;
  }
  const controllerState = getEligibleControllerState(controller, ownerUsername);
  if (!controllerState) {
    return null;
  }
  if (hasVisibleHostiles(room)) {
    return null;
  }
  const routeDistance = getRouteDistance(homeRoom, room.name);
  if (routeDistance === null) {
    return null;
  }
  const activeUpgraderCount = (_a = activeUpgraderCounts[room.name]) != null ? _a : 0;
  if (activeUpgraderCount >= perRoomUpgraderCap) {
    return null;
  }
  return {
    homeRoom,
    targetRoom: room.name,
    controllerId: controller.id,
    controllerLevel: getControllerLevel(controller),
    controllerState,
    ...typeof routeDistance === "number" ? { routeDistance } : {},
    activeUpgraderCount,
    order
  };
}
function getEligibleControllerState(controller, ownerUsername) {
  if (controller.my === true) {
    return controller.level < 8 ? "owned" : null;
  }
  const reservationUsername = getControllerReservationUsername2(controller);
  if (ownerUsername && reservationUsername === ownerUsername) {
    return "reserved";
  }
  return null;
}
function hasPrimaryRoomStorageSurplus(colony, storageEnergyThresholdRatio) {
  const storage = colony.room.storage;
  if (!storage) {
    return false;
  }
  const storedEnergy = getStoredEnergy6(storage);
  const storageCapacity = getStorageEnergyCapacity(storage);
  return storageCapacity > 0 && storedEnergy > storageCapacity * storageEnergyThresholdRatio;
}
function normalizeMultiRoomUpgraderOptions(options) {
  return {
    storageEnergyThresholdRatio: normalizeRatio(
      options.storageEnergyThresholdRatio,
      MULTI_ROOM_UPGRADER_DEFAULT_STORAGE_THRESHOLD_RATIO
    ),
    perRoomUpgraderCap: normalizePerRoomCap(options.perRoomUpgraderCap)
  };
}
function normalizeRatio(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function normalizePerRoomCap(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : MULTI_ROOM_UPGRADER_DEFAULT_PER_ROOM_CAP;
}
function getRemoteUpgraderPattern(routeDistance) {
  return typeof routeDistance === "number" && routeDistance > 1 ? REMOTE_UPGRADER_TRAVEL_PATTERN : REMOTE_UPGRADER_PATTERN;
}
function getBodyCost2(body) {
  return body.reduce((total, part) => total + getBodyPartCost(part), 0);
}
function getBodyPartCost(part) {
  switch (part) {
    case "work":
      return 100;
    case "carry":
    case "move":
      return 50;
    case "claim":
      return 600;
    case "attack":
      return 80;
    case "ranged_attack":
      return 150;
    case "heal":
      return 250;
    case "tough":
      return 10;
  }
}
function compareMultiRoomUpgradeCandidates(left, right) {
  return left.controllerLevel - right.controllerLevel || compareOptionalNumbers3(left.routeDistance, right.routeDistance) || left.targetRoom.localeCompare(right.targetRoom) || left.order - right.order;
}
function compareOptionalNumbers3(left, right) {
  return (left != null ? left : Number.POSITIVE_INFINITY) - (right != null ? right : Number.POSITIVE_INFINITY);
}
var activeMultiRoomUpgraderCountCache = null;
function getActiveMultiRoomUpgraderCountsByTarget(homeRoom) {
  var _a, _b;
  const cache = getActiveMultiRoomUpgraderCountCache();
  const activeByTarget = (_a = cache.countsByHomeRoom[homeRoom]) != null ? _a : {};
  const plannedByTarget = (_b = cache.plannedByHomeRoom[homeRoom]) != null ? _b : {};
  return combineCountMaps(activeByTarget, plannedByTarget);
}
function countActiveMultiRoomUpgradersByHomeRoom(creeps) {
  var _a, _b, _c;
  const countsByHomeRoom = {};
  for (const creep of Object.values(creeps)) {
    const sustain = (_a = creep.memory) == null ? void 0 : _a.controllerSustain;
    if ((sustain == null ? void 0 : sustain.role) !== "upgrader" || !isNonEmptyString9(sustain.homeRoom) || !isNonEmptyString9(sustain.targetRoom) || !isActiveMultiRoomUpgrader(creep)) {
      continue;
    }
    const countsByTarget = (_b = countsByHomeRoom[sustain.homeRoom]) != null ? _b : {};
    countsByTarget[sustain.targetRoom] = ((_c = countsByTarget[sustain.targetRoom]) != null ? _c : 0) + 1;
    countsByHomeRoom[sustain.homeRoom] = countsByTarget;
  }
  return countsByHomeRoom;
}
function combineCountMaps(baseCounts, overlayCounts) {
  var _a;
  const combined = { ...baseCounts };
  for (const [targetRoom, plannedCount] of Object.entries(overlayCounts)) {
    combined[targetRoom] = ((_a = combined[targetRoom]) != null ? _a : 0) + plannedCount;
  }
  return combined;
}
function getActiveMultiRoomUpgraderCountCache() {
  var _a;
  const creeps = (_a = globalThis.Game) == null ? void 0 : _a.creeps;
  const gameTime = getGameTime8();
  if ((activeMultiRoomUpgraderCountCache == null ? void 0 : activeMultiRoomUpgraderCountCache.gameTime) !== gameTime || activeMultiRoomUpgraderCountCache.creeps !== creeps) {
    activeMultiRoomUpgraderCountCache = {
      gameTime,
      creeps,
      countsByHomeRoom: creeps ? countActiveMultiRoomUpgradersByHomeRoom(creeps) : {},
      plannedByHomeRoom: {}
    };
  }
  return activeMultiRoomUpgraderCountCache;
}
function isActiveMultiRoomUpgrader(creep) {
  return creep.ticksToLive === void 0 || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}
function getControllerLevel(controller) {
  return typeof controller.level === "number" ? controller.level : DEFAULT_RESERVED_CONTROLLER_LEVEL;
}
function getControllerOwnerUsername3(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return isNonEmptyString9(username) ? username : null;
}
function getControllerReservationUsername2(controller) {
  var _a;
  const username = (_a = controller.reservation) == null ? void 0 : _a.username;
  return isNonEmptyString9(username) ? username : null;
}
function getStoredEnergy6(storage) {
  const storedEnergy = storage.store.getUsedCapacity(RESOURCE_ENERGY);
  return typeof storedEnergy === "number" && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}
function getStorageEnergyCapacity(storage) {
  const capacity = storage.store.getCapacity(RESOURCE_ENERGY);
  return typeof capacity === "number" && Number.isFinite(capacity) ? Math.max(0, capacity) : 0;
}
function hasVisibleHostiles(room) {
  const hostileCreepsFind = globalThis.FIND_HOSTILE_CREEPS;
  const hostileStructuresFind = globalThis.FIND_HOSTILE_STRUCTURES;
  return typeof hostileCreepsFind === "number" && room.find(hostileCreepsFind).length > 0 || typeof hostileStructuresFind === "number" && room.find(hostileStructuresFind).length > 0;
}
function getRouteDistance(fromRoom, targetRoom) {
  var _a, _b;
  if (fromRoom === targetRoom) {
    return 0;
  }
  const gameTime = getGameTime8();
  const cache = getTerritoryRouteDistanceCache2(gameTime);
  const cacheKey = getTerritoryRouteDistanceCacheKey2(fromRoom, targetRoom);
  const cachedRouteDistance = (_a = cache == null ? void 0 : cache.distances) == null ? void 0 : _a[cacheKey];
  const cacheUpdatedAt = (_b = cache == null ? void 0 : cache.updatedAt) == null ? void 0 : _b[cacheKey];
  if (typeof cacheUpdatedAt === "number" && !isRouteDistanceCacheStale(cacheUpdatedAt, gameTime)) {
    if (cachedRouteDistance === null || typeof cachedRouteDistance === "number") {
      return cachedRouteDistance;
    }
  } else if (cacheUpdatedAt !== void 0 && cache) {
    delete cache.distances[cacheKey];
    delete cache.updatedAt[cacheKey];
  }
  const routeDistance = getRouteDistanceFromGameMap(fromRoom, targetRoom);
  if (routeDistance !== void 0) {
    if (cache) {
      cache.distances[cacheKey] = routeDistance;
      cache.updatedAt[cacheKey] = gameTime;
    }
    return routeDistance;
  }
  return isAdjacentRoom(fromRoom, targetRoom) ? 1 : void 0;
}
function isRouteDistanceCacheStale(lastUpdatedAt, now) {
  return lastUpdatedAt + ROUTE_DISTANCE_CACHE_TTL_TICKS < now;
}
function getTerritoryRouteDistanceCache2(gameTime) {
  const memory = globalThis.Memory;
  if (!memory) {
    return void 0;
  }
  if (!isRecord9(memory.territory)) {
    memory.territory = {};
  }
  if (!isRecord9(memory.territory.routeDistances)) {
    memory.territory.routeDistances = {};
  }
  if (!isRecord9(memory.territory.routeDistancesUpdatedAt)) {
    memory.territory.routeDistancesUpdatedAt = {};
  }
  const distances = memory.territory.routeDistances;
  const updatedAt = memory.territory.routeDistancesUpdatedAt;
  pruneStaleRouteDistanceEntries(updatedAt, distances, gameTime);
  return {
    distances,
    updatedAt
  };
}
function pruneStaleRouteDistanceEntries(updatedAt, distances, gameTime) {
  for (const [cacheKey, lastUpdatedAt] of Object.entries(updatedAt)) {
    if (typeof lastUpdatedAt !== "number") {
      delete updatedAt[cacheKey];
      delete distances[cacheKey];
      continue;
    }
    if (isRouteDistanceCacheStale(lastUpdatedAt, gameTime)) {
      delete updatedAt[cacheKey];
      delete distances[cacheKey];
    }
  }
}
function getTerritoryRouteDistanceCacheKey2(fromRoom, targetRoom) {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR3}${targetRoom}`;
}
function getRouteDistanceFromGameMap(fromRoom, targetRoom) {
  var _a;
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (typeof (gameMap == null ? void 0 : gameMap.findRoute) !== "function") {
    return void 0;
  }
  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName) => isKnownDeadZoneRoom(roomName) ? Infinity : 1
  });
  if (route === getNoPathResultCode4()) {
    return null;
  }
  return Array.isArray(route) ? route.length : void 0;
}
function isAdjacentRoom(fromRoom, targetRoom) {
  var _a;
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (!gameMap || typeof gameMap.describeExits !== "function") {
    return false;
  }
  const exits = gameMap.describeExits(fromRoom);
  if (!isRecord9(exits)) {
    return false;
  }
  return Object.values(exits).some((roomName) => roomName === targetRoom);
}
function getNoPathResultCode4() {
  const noPathCode = globalThis.ERR_NO_PATH;
  return typeof noPathCode === "number" ? noPathCode : ERR_NO_PATH_CODE4;
}
function getGameTime8() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function isRecord9(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString9(value) {
  return typeof value === "string" && value.length > 0;
}

// src/spawn/spawnPlanner.ts
var TERRITORY_SCOUT_BODY = ["move"];
var TERRITORY_SCOUT_BODY_COST2 = 50;
var CONTROLLER_UPGRADE_SURPLUS_WORKER_BONUS = 1;
var CONTROLLER_UPGRADE_SURPLUS_MIN_ENERGY_CAPACITY = 650;
var CONTROLLER_UPGRADE_SURPLUS_MAX_WORKER_TARGET = 6;
var MAX_CONTROLLER_LEVEL2 = 8;
var POST_CLAIM_SUSTAIN_UPGRADER_TARGET = 1;
var POST_CLAIM_SUSTAIN_HAULER_TARGET = 1;
var POST_CLAIM_SUSTAIN_DEFAULT_WORKER_TARGET = 2;
var POST_CLAIM_SUSTAIN_WORKER_REPLACEMENT_TICKS = 100;
var POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY = 200;
var SPAWN_PRIORITY_TIERS = [
  "emergencyBootstrap",
  // Keep defense above local refill so hostiles cannot starve the first defender.
  "defense",
  "localRefillSurvival",
  "controllerDowngradeGuard",
  "postClaimControllerSustain",
  "remoteEconomy",
  "territoryRemote",
  "multiRoomControllerUpgrade",
  "controllerUpgradeSurplus"
];
function planSpawn(colony, roleCounts, gameTime, options = {}) {
  const workerTarget = getWorkerTarget(colony, roleCounts);
  const workerCapacity = getWorkerCapacity(roleCounts);
  const context = {
    colony,
    gameTime,
    options,
    roleCounts,
    survival: assessColonySnapshotSurvival(colony, roleCounts),
    territoryIntentPending: false,
    workerCapacity,
    workerTarget
  };
  for (const tier of SPAWN_PRIORITY_TIERS) {
    const request = planSpawnForPriorityTier(tier, context);
    if (request) {
      return request;
    }
  }
  return null;
}
function planSpawnForPriorityTier(tier, context) {
  switch (tier) {
    case "emergencyBootstrap":
      return planEmergencyBootstrapSpawn(context);
    case "localRefillSurvival":
      return planLocalSurvivalSpawn(context);
    case "controllerDowngradeGuard":
      return planControllerDowngradeGuardSpawn(context);
    case "postClaimControllerSustain":
      return planPostClaimControllerSustainSpawn(context);
    case "remoteEconomy":
      return planRemoteEconomySpawn(context);
    case "defense":
      return planDefenseSpawn(context);
    case "territoryRemote":
      return planTerritoryRemoteSpawn(context);
    case "multiRoomControllerUpgrade":
      return planMultiRoomControllerUpgradeSpawn(context);
    case "controllerUpgradeSurplus":
      return planControllerUpgradeSurplusSpawn(context);
  }
}
function planEmergencyBootstrapSpawn(context) {
  if (context.survival.mode !== "BOOTSTRAP" || context.workerCapacity >= context.survival.survivalWorkerFloor) {
    return null;
  }
  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}
function planLocalSurvivalSpawn(context) {
  if (context.workerCapacity >= context.workerTarget) {
    return null;
  }
  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}
function planControllerDowngradeGuardSpawn(context) {
  if (!context.survival.controllerDowngradeGuard || context.workerCapacity > context.workerTarget || !hasControllerDowngradeGuardSpawnCapacity(context)) {
    return null;
  }
  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}
function hasControllerDowngradeGuardSpawnCapacity(context) {
  if (!context.survival.hostilePresence) {
    return true;
  }
  return context.colony.spawns.filter((spawn) => !spawn.spawning).length > 1;
}
function planPostClaimControllerSustainSpawn(context) {
  if (context.survival.mode !== "TERRITORY_READY" || !hasPostClaimSustainSpawnEnergy(context.colony)) {
    return null;
  }
  const sustainPlan = selectPostClaimControllerSustainPlan(context.colony);
  if (!sustainPlan) {
    return null;
  }
  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  const body = selectWorkerBody(context.colony, context.roleCounts);
  if (body.length === 0) {
    return null;
  }
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(
      `worker-${context.colony.room.name}-${sustainPlan.targetRoom}-${sustainPlan.role}-${context.gameTime}`,
      context.options
    ),
    memory: {
      role: "worker",
      colony: sustainPlan.targetRoom,
      territory: {
        targetRoom: sustainPlan.targetRoom,
        action: "claim",
        ...sustainPlan.controllerId ? { controllerId: sustainPlan.controllerId } : {}
      },
      controllerSustain: {
        homeRoom: context.colony.room.name,
        targetRoom: sustainPlan.targetRoom,
        role: sustainPlan.role
      }
    }
  };
}
function hasPostClaimSustainSpawnEnergy(colony) {
  return colony.energyAvailable >= POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY && colony.energyAvailable >= colony.energyCapacityAvailable;
}
function selectPostClaimControllerSustainPlan(colony) {
  var _a;
  const records = getPostClaimControllerSustainRecords(colony.room.name);
  for (const record of records) {
    const targetRoom = getVisibleRoom3(record.roomName);
    if (((_a = targetRoom == null ? void 0 : targetRoom.controller) == null ? void 0 : _a.my) !== true) {
      continue;
    }
    const hasOperationalSpawn = hasOperationalSpawnInRoom(record.roomName);
    const counts = countPostClaimControllerSustainCreeps(record.roomName);
    const workerTarget = getPostClaimControllerSustainWorkerTarget(record);
    const controllerId = getPostClaimControllerSustainControllerId(record, targetRoom);
    if (!hasOperationalSpawn) {
      if (counts.upgraders < POST_CLAIM_SUSTAIN_UPGRADER_TARGET) {
        return { targetRoom: record.roomName, role: "upgrader", ...controllerId ? { controllerId } : {} };
      }
      if (shouldSpawnPostClaimEnergyHauler(targetRoom, counts, workerTarget)) {
        return { targetRoom: record.roomName, role: "hauler", ...controllerId ? { controllerId } : {} };
      }
      if (counts.workers < workerTarget) {
        return { targetRoom: record.roomName, role: "upgrader", ...controllerId ? { controllerId } : {} };
      }
    } else if (shouldSpawnPostClaimEnergyHauler(targetRoom, counts, workerTarget) && isClaimedRoomEnergyInsufficient(targetRoom)) {
      return { targetRoom: record.roomName, role: "hauler", ...controllerId ? { controllerId } : {} };
    }
  }
  return null;
}
function getPostClaimControllerSustainRecords(colonyName) {
  var _a, _b;
  const records = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.postClaimBootstraps;
  if (!isRecord10(records)) {
    return [];
  }
  return Object.values(records).filter(
    (record) => isPostClaimControllerSustainRecord(record, colonyName)
  ).sort(comparePostClaimControllerSustainRecords);
}
function isPostClaimControllerSustainRecord(record, colonyName) {
  return isRecord10(record) && record.colony === colonyName && record.roomName !== colonyName && isNonEmptyString10(record.roomName) && (record.status === "detected" || record.status === "spawnSitePending" || record.status === "spawnSiteBlocked" || record.status === "spawningWorkers" || record.status === "ready");
}
function comparePostClaimControllerSustainRecords(left, right) {
  const leftHasSpawn = hasOperationalSpawnInRoom(left.roomName);
  const rightHasSpawn = hasOperationalSpawnInRoom(right.roomName);
  if (leftHasSpawn !== rightHasSpawn) {
    return leftHasSpawn ? 1 : -1;
  }
  return getVisibleControllerLevel(left.roomName) - getVisibleControllerLevel(right.roomName) || left.claimedAt - right.claimedAt || left.roomName.localeCompare(right.roomName);
}
function getVisibleControllerLevel(roomName) {
  var _a, _b;
  const level = (_b = (_a = getVisibleRoom3(roomName)) == null ? void 0 : _a.controller) == null ? void 0 : _b.level;
  return typeof level === "number" ? level : MAX_CONTROLLER_LEVEL2 + 1;
}
function hasOperationalSpawnInRoom(roomName) {
  var _a;
  const spawns = (_a = globalThis.Game) == null ? void 0 : _a.spawns;
  if (!spawns) {
    return false;
  }
  return Object.values(spawns).some((spawn) => {
    var _a2;
    return ((_a2 = spawn.room) == null ? void 0 : _a2.name) === roomName;
  });
}
function countPostClaimControllerSustainCreeps(targetRoom) {
  var _a, _b, _c;
  const creeps = (_a = globalThis.Game) == null ? void 0 : _a.creeps;
  const counts = { haulers: 0, upgraders: 0, workers: 0 };
  if (!creeps) {
    return counts;
  }
  for (const creep of Object.values(creeps)) {
    if (!canCountPostClaimSustainCreep(creep, targetRoom)) {
      continue;
    }
    counts.workers += 1;
    if (((_b = creep.memory.controllerSustain) == null ? void 0 : _b.role) === "upgrader") {
      counts.upgraders += 1;
    } else if (((_c = creep.memory.controllerSustain) == null ? void 0 : _c.role) === "hauler") {
      counts.haulers += 1;
    }
  }
  return counts;
}
function canCountPostClaimSustainCreep(creep, targetRoom) {
  var _a;
  if (((_a = creep.memory) == null ? void 0 : _a.role) !== "worker" || creep.memory.colony !== targetRoom) {
    return false;
  }
  return creep.ticksToLive === void 0 || creep.ticksToLive > POST_CLAIM_SUSTAIN_WORKER_REPLACEMENT_TICKS;
}
function getPostClaimControllerSustainWorkerTarget(record) {
  return typeof record.workerTarget === "number" && record.workerTarget > 0 ? record.workerTarget : POST_CLAIM_SUSTAIN_DEFAULT_WORKER_TARGET;
}
function getPostClaimControllerSustainControllerId(record, room) {
  var _a, _b;
  const controllerId = (_b = record.controllerId) != null ? _b : (_a = room == null ? void 0 : room.controller) == null ? void 0 : _a.id;
  return typeof controllerId === "string" && controllerId.length > 0 ? controllerId : void 0;
}
function shouldSpawnPostClaimEnergyHauler(room, counts, workerTarget) {
  return counts.haulers < POST_CLAIM_SUSTAIN_HAULER_TARGET && counts.workers < workerTarget && (room === void 0 || isClaimedRoomEnergyInsufficient(room));
}
function isClaimedRoomEnergyInsufficient(room) {
  if (!room) {
    return true;
  }
  const energyAvailable = room.energyAvailable;
  return typeof energyAvailable !== "number" || energyAvailable < POST_CLAIM_SUSTAIN_MIN_HAULER_ENERGY;
}
function planDefenseSpawn(context) {
  var _a;
  if (!context.survival.hostilePresence || ((_a = context.roleCounts.defender) != null ? _a : 0) > 0) {
    return null;
  }
  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  const body = buildEmergencyDefenderBody(context.colony.energyAvailable);
  if (body.length === 0) {
    return null;
  }
  const roomName = context.colony.room.name;
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(`${DEFENDER_ROLE}-${roomName}-${context.gameTime}`, context.options),
    memory: {
      role: DEFENDER_ROLE,
      colony: roomName,
      defense: { homeRoom: roomName }
    }
  };
}
function planRemoteEconomySpawn(context) {
  if (context.options.workersOnly || context.survival.mode !== "TERRITORY_READY" || context.workerCapacity < context.workerTarget || context.colony.energyAvailable < context.colony.energyCapacityAvailable) {
    return null;
  }
  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  const remoteHarvesterAssignment = selectRemoteHarvesterAssignment(context.colony.room.name);
  if (remoteHarvesterAssignment) {
    const body2 = buildRemoteHarvesterBody(context.colony.energyAvailable);
    if (body2.length > 0) {
      return {
        spawn,
        body: body2,
        name: appendSpawnNameSuffix(
          `${REMOTE_HARVESTER_ROLE}-${context.colony.room.name}-${remoteHarvesterAssignment.targetRoom}-${remoteHarvesterAssignment.sourceId}-${context.gameTime}`,
          context.options
        ),
        memory: {
          role: REMOTE_HARVESTER_ROLE,
          colony: context.colony.room.name,
          remoteHarvester: {
            homeRoom: remoteHarvesterAssignment.homeRoom,
            targetRoom: remoteHarvesterAssignment.targetRoom,
            sourceId: remoteHarvesterAssignment.sourceId,
            containerId: remoteHarvesterAssignment.containerId
          }
        }
      };
    }
  }
  const remoteHaulerAssignment = selectRemoteHaulerAssignment(context.colony.room.name);
  if (!remoteHaulerAssignment) {
    return null;
  }
  const body = buildRemoteHaulerBody(context.colony.energyAvailable);
  if (body.length === 0) {
    return null;
  }
  return {
    spawn,
    body,
    name: appendSpawnNameSuffix(
      `${HAULER_ROLE}-${context.colony.room.name}-${remoteHaulerAssignment.targetRoom}-${remoteHaulerAssignment.containerId}-${context.gameTime}`,
      context.options
    ),
    memory: {
      role: HAULER_ROLE,
      colony: context.colony.room.name,
      remoteHauler: {
        homeRoom: remoteHaulerAssignment.homeRoom,
        targetRoom: remoteHaulerAssignment.targetRoom,
        sourceId: remoteHaulerAssignment.sourceId,
        containerId: remoteHaulerAssignment.containerId
      }
    }
  };
}
function planTerritoryRemoteSpawn(context) {
  if (context.survival.mode !== "TERRITORY_READY" || context.options.workersOnly && context.options.allowTerritoryControllerPressure !== true && context.options.allowTerritoryFollowUp !== true) {
    return null;
  }
  const controllerPressureOnly = context.options.workersOnly === true && context.options.allowTerritoryControllerPressure === true;
  const followUpOnlyFallback = context.options.workersOnly === true && context.options.allowTerritoryFollowUp === true;
  const territoryIntent = planTerritoryIntent(
    context.colony,
    context.roleCounts,
    context.workerTarget,
    context.gameTime,
    { controllerPressureOnly, followUpOnly: followUpOnlyFallback }
  );
  if (!territoryIntent) {
    return null;
  }
  context.territoryIntentPending = true;
  const demandedWorkerTarget = getWorkerTargetWithTerritoryDemand(
    context.workerTarget,
    territoryIntent,
    context.gameTime
  );
  if (context.workerCapacity < demandedWorkerTarget) {
    const workerSpawn = planWorkerSpawn(
      context.colony,
      context.roleCounts,
      context.gameTime,
      context.options
    );
    if (workerSpawn) {
      return workerSpawn;
    }
    recordRecoveredFollowUpCooldownIfControllerCreepNeeded(
      territoryIntent,
      context.roleCounts,
      context.gameTime
    );
    return null;
  }
  const territorySpawn = planTerritorySpawn(
    context.colony,
    context.roleCounts,
    territoryIntent,
    context.gameTime,
    context.options
  );
  if (territorySpawn) {
    return territorySpawn;
  }
  recordRecoveredFollowUpCooldownIfControllerCreepNeeded(
    territoryIntent,
    context.roleCounts,
    context.gameTime
  );
  return null;
}
function planControllerUpgradeSurplusSpawn(context) {
  if (!shouldSpawnControllerUpgradeSurplusWorker(context)) {
    return null;
  }
  return planWorkerSpawn(context.colony, context.roleCounts, context.gameTime, context.options);
}
function planMultiRoomControllerUpgradeSpawn(context) {
  if (context.options.workersOnly || context.territoryIntentPending || context.survival.mode !== "TERRITORY_READY" || hasControllerUpgradeBlockingTerritoryWork(context.colony) || context.workerCapacity < context.workerTarget || context.colony.energyAvailable < context.colony.energyCapacityAvailable) {
    return null;
  }
  const upgradePlans = selectMultiRoomUpgradePlans(context.colony);
  if (upgradePlans.length === 0) {
    return null;
  }
  const spawn = context.colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  for (const upgradePlan of upgradePlans) {
    const body = buildMultiRoomUpgraderBody(context.colony.energyAvailable, upgradePlan);
    if (body.length === 0) {
      continue;
    }
    return {
      spawn,
      body,
      name: appendSpawnNameSuffix(
        `worker-${context.colony.room.name}-${upgradePlan.targetRoom}-multiroom-upgrader-${context.gameTime}`,
        context.options
      ),
      memory: buildMultiRoomUpgraderMemory(upgradePlan)
    };
  }
  return null;
}
function shouldSpawnControllerUpgradeSurplusWorker(context) {
  if (context.options.workersOnly || context.territoryIntentPending || context.survival.mode !== "TERRITORY_READY" || hasControllerUpgradeBlockingTerritoryWork(context.colony) || !hasControllerUpgradeSurplusEnergy(context.colony) || !isControllerUpgradeableForSurplus(context.colony.room.controller)) {
    return false;
  }
  const surplusWorkerTarget = Math.min(
    CONTROLLER_UPGRADE_SURPLUS_MAX_WORKER_TARGET,
    context.workerTarget + CONTROLLER_UPGRADE_SURPLUS_WORKER_BONUS
  );
  return context.workerCapacity < surplusWorkerTarget;
}
function hasControllerUpgradeSurplusEnergy(colony) {
  return colony.energyCapacityAvailable >= CONTROLLER_UPGRADE_SURPLUS_MIN_ENERGY_CAPACITY && colony.energyAvailable >= colony.energyCapacityAvailable;
}
function isControllerUpgradeableForSurplus(controller) {
  return (controller == null ? void 0 : controller.my) === true && typeof controller.level === "number" && controller.level >= 2 && controller.level < MAX_CONTROLLER_LEVEL2;
}
function hasControllerUpgradeBlockingTerritoryWork(colony) {
  return hasActiveTerritoryIntentBacklog(colony.room.name) || hasVisibleForeignReservedTerritoryTarget(colony);
}
function hasActiveTerritoryIntentBacklog(colonyName) {
  var _a, _b;
  const intents = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.intents;
  if (!Array.isArray(intents)) {
    return false;
  }
  return intents.some((intent) => {
    if (typeof intent !== "object" || intent === null) {
      return false;
    }
    if (intent.colony !== colonyName || intent.targetRoom === colonyName || intent.action !== "claim" && intent.action !== "reserve" && intent.action !== "scout") {
      return false;
    }
    return intent.status === "planned" || intent.status === "active" || intent.followUp !== void 0;
  });
}
function hasVisibleForeignReservedTerritoryTarget(colony) {
  var _a, _b;
  const targets = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.targets;
  if (!Array.isArray(targets)) {
    return false;
  }
  const colonyOwnerUsername = getControllerOwnerUsername4(colony.room.controller);
  return targets.some((target) => {
    if (typeof target !== "object" || target === null) {
      return false;
    }
    if (target.colony !== colony.room.name || target.enabled === false || target.action !== "claim" && target.action !== "reserve") {
      return false;
    }
    if (typeof target.roomName !== "string" || target.roomName.length === 0) {
      return false;
    }
    const controller = getVisibleRoomController2(target.roomName);
    return isForeignReservedController2(controller, colonyOwnerUsername);
  });
}
function getVisibleRoomController2(roomName) {
  var _a, _b, _c;
  return (_c = (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[roomName]) == null ? void 0 : _c.controller;
}
function isForeignReservedController2(controller, colonyOwnerUsername) {
  var _a;
  const reservationUsername = (_a = controller == null ? void 0 : controller.reservation) == null ? void 0 : _a.username;
  return (controller == null ? void 0 : controller.my) !== true && typeof reservationUsername === "string" && reservationUsername.length > 0 && reservationUsername !== colonyOwnerUsername;
}
function getControllerOwnerUsername4(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return typeof username === "string" && username.length > 0 ? username : void 0;
}
function recordRecoveredFollowUpCooldownIfControllerCreepNeeded(territoryIntent, roleCounts, gameTime) {
  if (!territoryIntent || !shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts, gameTime)) {
    return;
  }
  recordRecoveredTerritoryFollowUpRetryCooldown(territoryIntent, gameTime);
}
function planTerritorySpawn(colony, roleCounts, territoryIntent, gameTime, options) {
  if (!shouldSpawnTerritoryControllerCreep(territoryIntent, roleCounts, gameTime)) {
    return null;
  }
  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  const body = buildTerritorySpawnBody(colony.energyAvailable, territoryIntent);
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
function getWorkerTargetWithTerritoryDemand(workerTarget, territoryIntent, gameTime) {
  const demandWorkerCount = getTerritoryFollowUpPreparationWorkerDemand(territoryIntent, gameTime);
  return workerTarget + Math.min(TERRITORY_FOLLOW_UP_PREPARATION_WORKER_DEMAND, demandWorkerCount);
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
  var _a;
  const controllerLevel = (_a = colony.room.controller) == null ? void 0 : _a.level;
  const normalBody = buildWorkerBody(colony.energyCapacityAvailable, controllerLevel);
  if (canAffordBody(normalBody, colony.energyAvailable)) {
    return normalBody;
  }
  if (roleCounts.worker === 0) {
    return buildEmergencyWorkerBody(colony.energyAvailable);
  }
  return buildWorkerBody(colony.energyAvailable, controllerLevel);
}
function canAffordBody(body, energyAvailable) {
  return body.length > 0 && getBodyCost(body) <= energyAvailable;
}
function buildTerritorySpawnBody(energyAvailable, intent) {
  if (intent.action === "scout") {
    return energyAvailable >= TERRITORY_SCOUT_BODY_COST2 ? [...TERRITORY_SCOUT_BODY] : [];
  }
  if (requiresTerritoryControllerPressure(intent)) {
    return buildTerritoryControllerPressureBody(energyAvailable);
  }
  return buildTerritoryControllerBody(energyAvailable);
}
function getVisibleRoom3(roomName) {
  var _a, _b;
  return (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[roomName];
}
function isRecord10(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString10(value) {
  return typeof value === "string" && value.length > 0;
}

// src/territory/expansionScoring.ts
var NEXT_EXPANSION_TARGET_CREATOR = "nextExpansionScoring";
var EXIT_DIRECTION_ORDER3 = ["1", "3", "5", "7"];
var TERRITORY_ROUTE_DISTANCE_SEPARATOR4 = ">";
var ERR_NO_PATH_CODE5 = -2;
var MAX_NEARBY_EXPANSION_ROUTE_DISTANCE = 2;
var TERRAIN_SCAN_MIN = 2;
var TERRAIN_SCAN_MAX = 47;
var DEFAULT_TERRAIN_WALL_MASK4 = 1;
var DEFAULT_TERRAIN_SWAMP_MASK = 2;
var DUAL_SOURCE_BONUS = 180;
var FOREIGN_CONTROLLER_PENALTY = 300;
var DOWNGRADE_GUARD_TICKS2 = 5e3;
var MIN_CONTROLLER_LEVEL = 2;
var FOREIGN_RESERVATION_CONTROLLER_PRESSURE_RISK = "foreign reservation requires controller pressure";
var ROOM_LIMIT_PRECONDITION_PREFIX = "limit expansion to ";
var MAX_ROOM_COUNT_BY_RCL = {
  1: 1,
  2: 1,
  3: 2,
  4: 3,
  5: 5,
  6: 8,
  7: 15,
  8: 99
};
function buildRuntimeExpansionCandidateReport(colony) {
  return scoreExpansionCandidates(buildRuntimeExpansionScoringInput(colony));
}
function scoreExpansionCandidates(input) {
  var _a;
  const candidates = input.candidates.filter((candidate) => candidate.roomName !== input.colonyName).map((candidate) => scoreExpansionCandidate(input, candidate)).sort(compareExpansionCandidates);
  const next = (_a = candidates.find((candidate) => candidate.evidenceStatus !== "unavailable")) != null ? _a : null;
  return attachExpansionCandidateReportColony({ candidates, next }, input.colonyName);
}
function refreshNextExpansionTargetSelection(colony, report, gameTime) {
  const colonyName = colony.room.name;
  const candidate = selectPersistableExpansionCandidate(report);
  if (!candidate) {
    pruneNextExpansionTargets(colonyName);
    return {
      status: "skipped",
      colony: colonyName,
      reason: getSelectionSkipReason(report)
    };
  }
  persistNextExpansionTarget(colonyName, candidate, gameTime);
  return {
    status: "planned",
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...candidate.controllerId ? { controllerId: candidate.controllerId } : {}
  };
}
function clearNextExpansionTargetIntent(colony) {
  pruneNextExpansionTargets(colony);
}
function buildRuntimeExpansionScoringInput(colony) {
  var _a, _b;
  return {
    colonyName: colony.room.name,
    ...getControllerOwnerUsername5(colony.room.controller) ? { colonyOwnerUsername: getControllerOwnerUsername5(colony.room.controller) } : {},
    energyCapacityAvailable: colony.energyCapacityAvailable,
    ...typeof ((_a = colony.room.controller) == null ? void 0 : _a.level) === "number" ? { controllerLevel: colony.room.controller.level } : {},
    ownedRoomCount: countVisibleOwnedRooms(colony.room.name, getControllerOwnerUsername5(colony.room.controller)),
    ...typeof ((_b = colony.room.controller) == null ? void 0 : _b.ticksToDowngrade) === "number" ? { ticksToDowngrade: colony.room.controller.ticksToDowngrade } : {},
    activePostClaimBootstrapCount: countActivePostClaimBootstraps(),
    candidates: buildRuntimeExpansionCandidates(colony)
  };
}
function maxRoomsForRcl(controllerLevel) {
  if (typeof controllerLevel !== "number" || !Number.isFinite(controllerLevel)) {
    return MAX_ROOM_COUNT_BY_RCL[1];
  }
  const rcl = Math.min(8, Math.max(1, Math.floor(controllerLevel)));
  return MAX_ROOM_COUNT_BY_RCL[rcl];
}
function buildRuntimeExpansionCandidates(colony) {
  const rooms = getGameRooms2();
  if (!rooms) {
    return [];
  }
  const colonyName = colony.room.name;
  const ownerUsername = getControllerOwnerUsername5(colony.room.controller);
  const ownedRoomNames = getVisibleOwnedRoomNames3(colonyName, ownerUsername);
  const adjacentRoomNames = getAdjacentRoomNamesByOwnedRoom(ownedRoomNames);
  const candidates = [];
  let order = 0;
  for (const room of Object.values(rooms)) {
    if (!room || !isNonEmptyString11(room.name) || room.name === colonyName || ownedRoomNames.has(room.name)) {
      continue;
    }
    const routeDistance = getKnownRouteLength2(colonyName, room.name);
    const nearestOwnedDistance = getNearestOwnedRoomDistance(ownedRoomNames, room.name, adjacentRoomNames);
    const adjacentToOwnedRoom = isAdjacentToOwnedRoom(room.name, adjacentRoomNames);
    if (!isNearbyExpansionCandidate(routeDistance, nearestOwnedDistance, adjacentToOwnedRoom)) {
      continue;
    }
    candidates.push({
      roomName: room.name,
      order,
      adjacentToOwnedRoom,
      ...routeDistance !== void 0 ? { routeDistance } : {},
      ...nearestOwnedDistance.roomName ? { nearestOwnedRoom: nearestOwnedDistance.roomName } : {},
      ...nearestOwnedDistance.distance !== void 0 ? { nearestOwnedRoomDistance: nearestOwnedDistance.distance } : {},
      ...buildVisibleExpansionCandidateEvidence(room)
    });
    order += 1;
  }
  return candidates;
}
function buildVisibleExpansionCandidateEvidence(room) {
  const controller = room.controller;
  const sources = findRoomObjects7(room, getFindConstant4("FIND_SOURCES"));
  const controllerSourceRange = calculateAverageControllerSourceRange(controller, sources);
  const terrain = summarizeRoomTerrain(room);
  const hostileCreepCount = findRoomObjects7(room, getFindConstant4("FIND_HOSTILE_CREEPS")).length;
  const hostileStructureCount = findRoomObjects7(
    room,
    getFindConstant4("FIND_HOSTILE_STRUCTURES")
  ).length;
  return {
    ...controller ? { controller: summarizeExpansionController(controller) } : {},
    ...typeof (controller == null ? void 0 : controller.id) === "string" ? { controllerId: controller.id } : {},
    sourceCount: sources.length,
    ...typeof controllerSourceRange === "number" ? { controllerSourceRange } : {},
    ...terrain ? { terrain } : {},
    hostileCreepCount,
    hostileStructureCount
  };
}
function scoreExpansionCandidate(input, candidate) {
  var _a, _b;
  const rationale = [];
  const risks = [];
  const preconditions = getExpansionPreconditions(input);
  let evidenceStatus = "sufficient";
  const routeDistance = candidate.routeDistance === null ? void 0 : candidate.routeDistance;
  const nearestOwnedRoomDistance = candidate.nearestOwnedRoomDistance === null ? void 0 : candidate.nearestOwnedRoomDistance;
  if (candidate.routeDistance === null || candidate.nearestOwnedRoomDistance === null) {
    risks.push("no known route from owned territory");
    evidenceStatus = "unavailable";
  }
  if (!candidate.controller) {
    risks.push("visible room has no controller");
    evidenceStatus = "unavailable";
  } else {
    const controllerStatus = getControllerStatus(input, candidate.controller);
    rationale.push(controllerStatus.rationale);
    if (controllerStatus.risk) {
      risks.push(controllerStatus.risk);
    }
    if (controllerStatus.unavailable) {
      evidenceStatus = "unavailable";
    }
  }
  if (typeof candidate.sourceCount === "number") {
    rationale.push(`${candidate.sourceCount} sources visible`);
  } else {
    risks.push("source count evidence missing");
    evidenceStatus = downgradeEvidenceStatus(evidenceStatus, "insufficient-evidence");
  }
  if (typeof candidate.controllerSourceRange === "number") {
    rationale.push(`controller-source range ${candidate.controllerSourceRange}`);
  } else {
    risks.push("controller proximity evidence missing");
    evidenceStatus = downgradeEvidenceStatus(evidenceStatus, "insufficient-evidence");
  }
  if (candidate.terrain) {
    rationale.push(`terrain walkable ${toPercent(candidate.terrain.walkableRatio)}`);
  } else {
    risks.push("terrain quality evidence missing");
    evidenceStatus = downgradeEvidenceStatus(evidenceStatus, "insufficient-evidence");
  }
  const hostileCreepCount = (_a = candidate.hostileCreepCount) != null ? _a : 0;
  const hostileStructureCount = (_b = candidate.hostileStructureCount) != null ? _b : 0;
  if (hostileCreepCount > 0 || hostileStructureCount > 0) {
    risks.push("hostile presence visible");
    evidenceStatus = "unavailable";
  }
  if (typeof routeDistance === "number") {
    rationale.push(`home route distance ${routeDistance}`);
  }
  if (typeof nearestOwnedRoomDistance === "number") {
    rationale.push(`nearest owned distance ${nearestOwnedRoomDistance}`);
  }
  if (candidate.adjacentToOwnedRoom) {
    rationale.push("adjacent to owned territory");
  }
  const score = calculateExpansionScore(input, candidate, evidenceStatus);
  const reservation = getReservationEvidence(input, candidate.controller);
  const requiresControllerPressure = (reservation == null ? void 0 : reservation.relation) === "foreign";
  return {
    roomName: candidate.roomName,
    score,
    evidenceStatus,
    rationale,
    preconditions,
    risks,
    adjacentToOwnedRoom: candidate.adjacentToOwnedRoom,
    ...routeDistance !== void 0 ? { routeDistance } : {},
    ...candidate.nearestOwnedRoom ? { nearestOwnedRoom: candidate.nearestOwnedRoom } : {},
    ...nearestOwnedRoomDistance !== void 0 ? { nearestOwnedRoomDistance } : {},
    ...candidate.controllerId ? { controllerId: candidate.controllerId } : {},
    ...candidate.sourceCount !== void 0 ? { sourceCount: candidate.sourceCount } : {},
    ...candidate.controllerSourceRange !== void 0 ? { controllerSourceRange: candidate.controllerSourceRange } : {},
    ...candidate.terrain ? { terrain: candidate.terrain } : {},
    ...candidate.hostileCreepCount !== void 0 ? { hostileCreepCount: candidate.hostileCreepCount } : {},
    ...candidate.hostileStructureCount !== void 0 ? { hostileStructureCount: candidate.hostileStructureCount } : {},
    ...reservation ? { reservation } : {},
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {}
  };
}
function calculateExpansionScore(input, candidate, evidenceStatus) {
  var _a, _b, _c;
  const sourceScore = typeof candidate.sourceCount === "number" ? Math.min(candidate.sourceCount, 2) * 120 + Math.max(0, candidate.sourceCount - 2) * 20 : 0;
  const dualSourceBonus = ((_a = candidate.sourceCount) != null ? _a : 0) >= 2 ? DUAL_SOURCE_BONUS : 0;
  const proximityScore = typeof candidate.controllerSourceRange === "number" ? Math.max(-80, 100 - candidate.controllerSourceRange * 6) : 0;
  const terrainScore = candidate.terrain ? Math.round(candidate.terrain.walkableRatio * 140 - candidate.terrain.swampRatio * 70) : 0;
  const reservationScore = getReservationScore(input, candidate.controller);
  const distanceScore = getDistanceScore(candidate);
  const adjacencyScore = candidate.adjacentToOwnedRoom ? 40 : 0;
  const foreignControllerPenalty = hasForeignControllerPresence(input, candidate.controller) ? FOREIGN_CONTROLLER_PENALTY : 0;
  const hostilePenalty = ((_b = candidate.hostileCreepCount) != null ? _b : 0) * 240 + ((_c = candidate.hostileStructureCount) != null ? _c : 0) * 140;
  const unavailablePenalty = evidenceStatus === "unavailable" ? 2e3 : 0;
  const insufficientEvidencePenalty = evidenceStatus === "insufficient-evidence" ? 260 : 0;
  const preconditionPenalty = getExpansionPreconditions(input).length * 120;
  return Math.round(
    500 + sourceScore + dualSourceBonus + proximityScore + terrainScore + reservationScore + distanceScore + adjacencyScore - foreignControllerPenalty - hostilePenalty - unavailablePenalty - insufficientEvidencePenalty - preconditionPenalty
  );
}
function hasForeignControllerPresence(input, controller) {
  if (!controller) {
    return false;
  }
  return isNonEmptyString11(controller.ownerUsername) && controller.ownerUsername !== input.colonyOwnerUsername || isNonEmptyString11(controller.reservationUsername) && controller.reservationUsername !== input.colonyOwnerUsername;
}
function getDistanceScore(candidate) {
  const nearestOwnedDistance = candidate.nearestOwnedRoomDistance;
  const routeDistance = candidate.routeDistance;
  if (nearestOwnedDistance === null || routeDistance === null) {
    return -500;
  }
  const supportDistance = typeof nearestOwnedDistance === "number" ? nearestOwnedDistance : routeDistance;
  const supportScore = typeof supportDistance === "number" ? 140 - supportDistance * 35 : 0;
  const homePenalty = typeof routeDistance === "number" ? routeDistance * 10 : 0;
  return Math.max(-160, supportScore - homePenalty);
}
function getReservationScore(input, controller) {
  var _a;
  if (!(controller == null ? void 0 : controller.reservationUsername)) {
    return 45;
  }
  if (controller.reservationUsername === input.colonyOwnerUsername) {
    return 90;
  }
  const ticksToEnd = (_a = controller.reservationTicksToEnd) != null ? _a : 5e3;
  return ticksToEnd <= 1e3 ? -80 : -180;
}
function getControllerStatus(input, controller) {
  if (controller.my === true || controller.ownerUsername !== void 0 && controller.ownerUsername === input.colonyOwnerUsername) {
    return {
      rationale: "controller already owned by colony account",
      unavailable: true
    };
  }
  if (controller.ownerUsername) {
    return {
      rationale: "controller owned by another account",
      risk: "enemy-owned controller cannot be claimed safely",
      unavailable: true
    };
  }
  if (!controller.reservationUsername) {
    return { rationale: "controller unreserved" };
  }
  if (controller.reservationUsername === input.colonyOwnerUsername) {
    return {
      rationale: "controller already reserved by colony account"
    };
  }
  return {
    rationale: "controller reserved by another account",
    risk: FOREIGN_RESERVATION_CONTROLLER_PRESSURE_RISK
  };
}
function getReservationEvidence(input, controller) {
  if (!(controller == null ? void 0 : controller.reservationUsername)) {
    return null;
  }
  return {
    username: controller.reservationUsername,
    relation: controller.reservationUsername === input.colonyOwnerUsername ? "own" : "foreign",
    ...typeof controller.reservationTicksToEnd === "number" ? { ticksToEnd: controller.reservationTicksToEnd } : {}
  };
}
function getExpansionPreconditions(input) {
  var _a, _b;
  const preconditions = [];
  if (input.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    preconditions.push("reach 650 energy capacity for claim body");
  }
  if (((_a = input.controllerLevel) != null ? _a : 0) < MIN_CONTROLLER_LEVEL) {
    preconditions.push("reach controller level 2 before expansion");
  }
  const ownedRoomCount = getOwnedRoomCount(input);
  const maxRoomCount = maxRoomsForRcl(input.controllerLevel);
  if (ownedRoomCount >= maxRoomCount) {
    preconditions.push(`limit expansion to ${maxRoomCount} owned rooms for current controller level`);
  }
  if (typeof input.ticksToDowngrade === "number" && input.ticksToDowngrade <= DOWNGRADE_GUARD_TICKS2) {
    preconditions.push("stabilize home controller downgrade timer");
  }
  if (((_b = input.activePostClaimBootstrapCount) != null ? _b : 0) > 0) {
    preconditions.push("finish active post-claim bootstrap before next expansion");
  }
  return preconditions;
}
function getOwnedRoomCount(input) {
  if (typeof input.ownedRoomCount !== "number" || !Number.isFinite(input.ownedRoomCount)) {
    return 1;
  }
  return Math.max(0, Math.floor(input.ownedRoomCount));
}
function selectPersistableExpansionCandidate(report) {
  var _a;
  return (_a = report.candidates.find(
    (candidate) => candidate.evidenceStatus === "sufficient" && candidate.preconditions.length === 0
  )) != null ? _a : null;
}
function getSelectionSkipReason(report) {
  if (report.candidates.length === 0) {
    return "noCandidate";
  }
  if (report.candidates.some(hasRoomLimitPrecondition)) {
    return "roomLimitReached";
  }
  if (report.candidates.some((candidate) => candidate.preconditions.length > 0)) {
    return "unmetPreconditions";
  }
  if (report.candidates.some((candidate) => candidate.evidenceStatus === "insufficient-evidence")) {
    return "insufficientEvidence";
  }
  return "unavailable";
}
function hasRoomLimitPrecondition(candidate) {
  return candidate.preconditions.some(
    (precondition) => precondition.startsWith(ROOM_LIMIT_PRECONDITION_PREFIX)
  );
}
function persistNextExpansionTarget(colony, candidate, gameTime) {
  const territoryMemory = getWritableTerritoryMemoryRecord3();
  if (!territoryMemory) {
    return;
  }
  const target = {
    colony,
    roomName: candidate.roomName,
    action: "claim",
    createdBy: NEXT_EXPANSION_TARGET_CREATOR,
    ...candidate.controllerId ? { controllerId: candidate.controllerId } : {}
  };
  pruneNextExpansionTargets(colony, target, territoryMemory);
  upsertNextExpansionTarget(territoryMemory, target);
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find(
    (intent) => intent.colony === colony && intent.targetRoom === target.roomName && intent.action === "claim"
  );
  const createdBy = existingIntent ? existingIntent.createdBy : NEXT_EXPANSION_TARGET_CREATOR;
  const requiresControllerPressure = shouldPersistExpansionCandidateControllerPressure(candidate);
  upsertTerritoryIntent3(intents, {
    colony,
    targetRoom: target.roomName,
    action: "claim",
    status: (existingIntent == null ? void 0 : existingIntent.status) === "active" ? "active" : "planned",
    updatedAt: gameTime,
    ...createdBy ? { createdBy } : {},
    ...target.controllerId ? { controllerId: target.controllerId } : {},
    ...requiresControllerPressure ? { requiresControllerPressure: true } : {}
  });
}
function shouldPersistExpansionCandidateControllerPressure(candidate) {
  return candidate.requiresControllerPressure === true || candidate.risks.includes(FOREIGN_RESERVATION_CONTROLLER_PRESSURE_RISK);
}
function upsertNextExpansionTarget(territoryMemory, target) {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }
  const existingTarget = territoryMemory.targets.find((rawTarget) => isSameTarget(rawTarget, target));
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }
  if (isRecord11(existingTarget) && existingTarget.createdBy === NEXT_EXPANSION_TARGET_CREATOR) {
    existingTarget.createdBy = NEXT_EXPANSION_TARGET_CREATOR;
    existingTarget.enabled = target.enabled;
    if (target.controllerId) {
      existingTarget.controllerId = target.controllerId;
    }
  }
}
function upsertTerritoryIntent3(intents, nextIntent) {
  const existingIndex = intents.findIndex(
    (intent) => intent.colony === nextIntent.colony && intent.targetRoom === nextIntent.targetRoom && intent.action === nextIntent.action && intent.createdBy === nextIntent.createdBy
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }
  intents.push(nextIntent);
}
function pruneNextExpansionTargets(colony, activeTarget, territoryMemory = getTerritoryMemoryRecord4()) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return;
  }
  const removedTargetKeys = /* @__PURE__ */ new Set();
  territoryMemory.targets = territoryMemory.targets.filter((target) => {
    if (!isNextExpansionTarget(target, colony)) {
      return true;
    }
    if (activeTarget && isSameTarget(target, activeTarget)) {
      return true;
    }
    if (isRecord11(target) && isNonEmptyString11(target.roomName) && target.action === "claim") {
      removedTargetKeys.add(getTargetKey(target.roomName, "claim"));
    }
    return false;
  });
  if (removedTargetKeys.size === 0) {
    return;
  }
  territoryMemory.intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) => intent.colony !== colony || intent.createdBy !== NEXT_EXPANSION_TARGET_CREATOR || !removedTargetKeys.has(getTargetKey(intent.targetRoom, intent.action))
  );
}
function isNextExpansionTarget(target, colony) {
  return isRecord11(target) && target.colony === colony && target.action === "claim" && target.createdBy === NEXT_EXPANSION_TARGET_CREATOR;
}
function isSameTarget(left, right) {
  return isRecord11(left) && left.colony === right.colony && left.roomName === right.roomName && left.action === right.action;
}
function getTargetKey(roomName, action) {
  return `${roomName}:${action}`;
}
function compareExpansionCandidates(left, right) {
  return getEvidenceStatusPriority2(left.evidenceStatus) - getEvidenceStatusPriority2(right.evidenceStatus) || right.score - left.score || compareOptionalNumbers4(left.nearestOwnedRoomDistance, right.nearestOwnedRoomDistance) || compareOptionalNumbers4(left.routeDistance, right.routeDistance) || left.roomName.localeCompare(right.roomName);
}
function getEvidenceStatusPriority2(status) {
  if (status === "sufficient") {
    return 0;
  }
  return status === "insufficient-evidence" ? 1 : 2;
}
function compareOptionalNumbers4(left, right) {
  return (left != null ? left : Number.POSITIVE_INFINITY) - (right != null ? right : Number.POSITIVE_INFINITY);
}
function downgradeEvidenceStatus(current, downgrade) {
  if (current === "unavailable" || downgrade === "unavailable") {
    return "unavailable";
  }
  return current === "insufficient-evidence" || downgrade === "insufficient-evidence" ? "insufficient-evidence" : "sufficient";
}
function attachExpansionCandidateReportColony(report, colonyName) {
  Object.defineProperty(report, "colonyName", {
    value: colonyName,
    enumerable: false
  });
  return report;
}
function getVisibleOwnedRoomNames3(colonyName, ownerUsername) {
  var _a;
  const ownedRoomNames = /* @__PURE__ */ new Set([colonyName]);
  const rooms = getGameRooms2();
  if (!rooms) {
    return ownedRoomNames;
  }
  for (const room of Object.values(rooms)) {
    if (((_a = room == null ? void 0 : room.controller) == null ? void 0 : _a.my) === true && isNonEmptyString11(room.name) && (!ownerUsername || getControllerOwnerUsername5(room.controller) === ownerUsername)) {
      ownedRoomNames.add(room.name);
    }
  }
  return ownedRoomNames;
}
function countVisibleOwnedRooms(colonyName, ownerUsername) {
  return getVisibleOwnedRoomNames3(colonyName, ownerUsername).size;
}
function getAdjacentRoomNamesByOwnedRoom(ownedRoomNames) {
  const adjacentRoomNames = /* @__PURE__ */ new Map();
  for (const roomName of ownedRoomNames) {
    adjacentRoomNames.set(roomName, new Set(getAdjacentRoomNames3(roomName)));
  }
  return adjacentRoomNames;
}
function isAdjacentToOwnedRoom(roomName, adjacentRoomNames) {
  for (const exits of adjacentRoomNames.values()) {
    if (exits.has(roomName)) {
      return true;
    }
  }
  return false;
}
function getNearestOwnedRoomDistance(ownedRoomNames, targetRoom, adjacentRoomNames) {
  var _a;
  let nearestRoomName;
  let nearestDistance;
  for (const ownedRoomName of ownedRoomNames) {
    const adjacentDistance = ((_a = adjacentRoomNames.get(ownedRoomName)) == null ? void 0 : _a.has(targetRoom)) ? 1 : void 0;
    const routeDistance = getKnownRouteLength2(ownedRoomName, targetRoom);
    const distance = routeDistance != null ? routeDistance : adjacentDistance;
    if (distance === void 0) {
      continue;
    }
    if (distance === null) {
      if (nearestDistance === void 0) {
        nearestRoomName = ownedRoomName;
        nearestDistance = null;
      }
      continue;
    }
    if (nearestDistance === void 0 || nearestDistance === null || distance < nearestDistance) {
      nearestRoomName = ownedRoomName;
      nearestDistance = distance;
    }
  }
  return {
    ...nearestRoomName ? { roomName: nearestRoomName } : {},
    ...nearestDistance !== void 0 ? { distance: nearestDistance } : {}
  };
}
function isNearbyExpansionCandidate(routeDistance, nearestOwnedDistance, adjacentToOwnedRoom) {
  if (routeDistance === null || nearestOwnedDistance.distance === null) {
    return true;
  }
  return adjacentToOwnedRoom || typeof routeDistance === "number" && routeDistance <= MAX_NEARBY_EXPANSION_ROUTE_DISTANCE || typeof nearestOwnedDistance.distance === "number" && nearestOwnedDistance.distance <= MAX_NEARBY_EXPANSION_ROUTE_DISTANCE;
}
function getAdjacentRoomNames3(roomName) {
  var _a;
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (!gameMap || typeof gameMap.describeExits !== "function") {
    return [];
  }
  const exits = gameMap.describeExits(roomName);
  if (!isRecord11(exits)) {
    return [];
  }
  return EXIT_DIRECTION_ORDER3.flatMap((direction) => {
    const exitRoom = exits[direction];
    return isNonEmptyString11(exitRoom) ? [exitRoom] : [];
  });
}
function getKnownRouteLength2(fromRoom, targetRoom) {
  var _a;
  if (fromRoom === targetRoom) {
    return 0;
  }
  const cache = getTerritoryRouteDistanceCache3();
  const cacheKey = getTerritoryRouteDistanceCacheKey3(fromRoom, targetRoom);
  const cachedRouteLength = cache == null ? void 0 : cache[cacheKey];
  if (cachedRouteLength === null || typeof cachedRouteLength === "number") {
    return cachedRouteLength;
  }
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  if (typeof (gameMap == null ? void 0 : gameMap.findRoute) !== "function") {
    return void 0;
  }
  const route = gameMap.findRoute(fromRoom, targetRoom);
  if (route === getNoPathResultCode5()) {
    if (cache) {
      cache[cacheKey] = null;
    }
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
function getTerritoryRouteDistanceCache3() {
  const territoryMemory = getWritableTerritoryMemoryRecord3();
  if (!territoryMemory) {
    return void 0;
  }
  if (!isRecord11(territoryMemory.routeDistances)) {
    territoryMemory.routeDistances = {};
  }
  return territoryMemory.routeDistances;
}
function getTerritoryRouteDistanceCacheKey3(fromRoom, targetRoom) {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR4}${targetRoom}`;
}
function getNoPathResultCode5() {
  const noPathCode = globalThis.ERR_NO_PATH;
  return typeof noPathCode === "number" ? noPathCode : ERR_NO_PATH_CODE5;
}
function summarizeExpansionController(controller) {
  const ownerUsername = getControllerOwnerUsername5(controller);
  const reservationUsername = getControllerReservationUsername3(controller);
  const reservationTicksToEnd = getControllerReservationTicksToEnd2(controller);
  return {
    ...controller.my === true ? { my: true } : {},
    ...ownerUsername ? { ownerUsername } : {},
    ...reservationUsername ? { reservationUsername } : {},
    ...typeof reservationTicksToEnd === "number" ? { reservationTicksToEnd } : {}
  };
}
function calculateAverageControllerSourceRange(controller, sources) {
  if (!(controller == null ? void 0 : controller.pos) || sources.length === 0) {
    return void 0;
  }
  const ranges = sources.flatMap(
    (source) => source.pos ? [getRoomPositionRange(controller.pos, source.pos)] : []
  );
  if (ranges.length === 0) {
    return void 0;
  }
  return Math.round(ranges.reduce((total, range) => total + range, 0) / ranges.length);
}
function getRoomPositionRange(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function summarizeRoomTerrain(room) {
  const terrain = getRoomTerrain4(room);
  if (!terrain || typeof terrain.get !== "function") {
    return null;
  }
  let plainCount = 0;
  let swampCount = 0;
  let wallCount = 0;
  const wallMask = getTerrainMask("TERRAIN_MASK_WALL", DEFAULT_TERRAIN_WALL_MASK4);
  const swampMask = getTerrainMask("TERRAIN_MASK_SWAMP", DEFAULT_TERRAIN_SWAMP_MASK);
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
    walkableRatio: roundRatio2(plainCount + swampCount, total),
    swampRatio: roundRatio2(swampCount, total),
    wallRatio: roundRatio2(wallCount, total)
  };
}
function getRoomTerrain4(room) {
  var _a;
  const roomWithTerrain = room;
  if (typeof roomWithTerrain.getTerrain === "function") {
    return roomWithTerrain.getTerrain();
  }
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  return typeof (gameMap == null ? void 0 : gameMap.getRoomTerrain) === "function" ? gameMap.getRoomTerrain(room.name) : null;
}
function getTerrainMask(name, fallback) {
  const value = globalThis[name];
  return typeof value === "number" ? value : fallback;
}
function findRoomObjects7(room, findConstant) {
  if (typeof findConstant !== "number" || typeof room.find !== "function") {
    return [];
  }
  try {
    const result = room.find(findConstant);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
function getFindConstant4(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function getControllerOwnerUsername5(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return isNonEmptyString11(username) ? username : void 0;
}
function getControllerReservationUsername3(controller) {
  var _a;
  const username = (_a = controller.reservation) == null ? void 0 : _a.username;
  return isNonEmptyString11(username) ? username : void 0;
}
function getControllerReservationTicksToEnd2(controller) {
  var _a;
  const ticksToEnd = (_a = controller.reservation) == null ? void 0 : _a.ticksToEnd;
  return typeof ticksToEnd === "number" ? ticksToEnd : void 0;
}
function countActivePostClaimBootstraps() {
  var _a, _b;
  const records = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.postClaimBootstraps;
  if (!isRecord11(records)) {
    return 0;
  }
  return Object.values(records).filter(
    (record) => isRecord11(record) && record.status !== "ready"
  ).length;
}
function getGameRooms2() {
  var _a;
  return (_a = globalThis.Game) == null ? void 0 : _a.rooms;
}
function getTerritoryMemoryRecord4() {
  var _a;
  return (_a = globalThis.Memory) == null ? void 0 : _a.territory;
}
function getWritableTerritoryMemoryRecord3() {
  const memory = globalThis.Memory;
  if (!memory) {
    return null;
  }
  if (!memory.territory) {
    memory.territory = {};
  }
  return memory.territory;
}
function roundRatio2(numerator, denominator) {
  return denominator > 0 ? Math.round(numerator / denominator * 1e3) / 1e3 : 0;
}
function toPercent(value) {
  return `${Math.round(value * 100)}%`;
}
function isRecord11(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString11(value) {
  return typeof value === "string" && value.length > 0;
}

// src/territory/postClaimBootstrap.ts
var POST_CLAIM_BOOTSTRAP_WORKER_TARGET = 2;
var OK_CODE4 = 0;
var ERR_INVALID_TARGET_CODE = -7;
var ROOM_EDGE_MIN5 = 2;
var ROOM_EDGE_MAX5 = 47;
var DEFAULT_TERRAIN_WALL_MASK5 = 1;
function recordPostClaimBootstrapClaimSuccess(input, telemetryEvents = []) {
  var _a, _b;
  if (!isNonEmptyString12(input.colony) || !isNonEmptyString12(input.roomName)) {
    return;
  }
  const bootstraps = getWritablePostClaimBootstrapRecords();
  if (!bootstraps) {
    return;
  }
  const gameTime = getGameTime9();
  const existing = getPostClaimBootstrapRecord(input.roomName);
  const claimedAt = (existing == null ? void 0 : existing.status) === "ready" ? gameTime : (_a = existing == null ? void 0 : existing.claimedAt) != null ? _a : gameTime;
  bootstraps[input.roomName] = {
    colony: input.colony,
    roomName: input.roomName,
    status: "detected",
    claimedAt,
    updatedAt: gameTime,
    workerTarget: (_b = existing == null ? void 0 : existing.workerTarget) != null ? _b : POST_CLAIM_BOOTSTRAP_WORKER_TARGET,
    ...input.controllerId ? { controllerId: input.controllerId } : {}
  };
  telemetryEvents.push({
    type: "postClaimBootstrap",
    roomName: input.roomName,
    colony: input.colony,
    phase: "detected",
    ...input.controllerId ? { controllerId: input.controllerId } : {},
    workerTarget: POST_CLAIM_BOOTSTRAP_WORKER_TARGET
  });
}
function refreshPostClaimBootstrap(colony, roleCounts, gameTime, telemetryEvents = []) {
  var _a, _b;
  const roomName = colony.room.name;
  const record = getPostClaimBootstrapRecord(roomName);
  if (!record || record.status === "ready" || ((_a = colony.room.controller) == null ? void 0 : _a.my) !== true) {
    return { active: false, spawnConstructionPending: false };
  }
  const workerTarget = getPostClaimBootstrapWorkerTarget(record);
  const workerCount = (_b = roleCounts.worker) != null ? _b : 0;
  const spawnCount = colony.spawns.length;
  if (spawnCount > 0 && workerCount >= workerTarget) {
    updatePostClaimBootstrapRecord(roomName, {
      status: "ready",
      updatedAt: gameTime,
      workerTarget
    });
    telemetryEvents.push({
      type: "postClaimBootstrap",
      roomName,
      colony: record.colony,
      phase: "ready",
      ...record.controllerId ? { controllerId: record.controllerId } : {},
      workerCount,
      workerTarget,
      spawnCount
    });
    return { active: false, spawnConstructionPending: false };
  }
  if (spawnCount > 0) {
    updatePostClaimBootstrapRecord(roomName, {
      status: "spawningWorkers",
      updatedAt: gameTime,
      workerTarget
    });
    return { active: true, spawnConstructionPending: false };
  }
  const existingSpawnSite = findExistingSpawnConstructionSite(colony.room);
  if (existingSpawnSite) {
    const spawnSite = toSpawnSiteMemory(existingSpawnSite);
    const shouldReportExistingSite = record.status !== "spawnSitePending" || !isSameSpawnSite(record.spawnSite, spawnSite);
    updatePostClaimBootstrapRecord(roomName, {
      status: "spawnSitePending",
      updatedAt: gameTime,
      workerTarget,
      spawnSite,
      lastResult: OK_CODE4
    });
    if (shouldReportExistingSite) {
      telemetryEvents.push({
        type: "postClaimBootstrap",
        roomName,
        colony: record.colony,
        phase: "spawnSite",
        ...record.controllerId ? { controllerId: record.controllerId } : {},
        result: OK_CODE4,
        spawnSite,
        workerCount,
        workerTarget,
        spawnCount
      });
    }
    return { active: true, spawnConstructionPending: true };
  }
  const sitePlan = planInitialSpawnConstructionSite(colony.room);
  const nextStatus = sitePlan.result === OK_CODE4 ? "spawnSitePending" : "spawnSiteBlocked";
  const shouldReportSitePlan = record.status !== nextStatus || record.lastResult !== sitePlan.result || sitePlan.position !== void 0 && !isSameSpawnSite(record.spawnSite, sitePlan.position);
  updatePostClaimBootstrapRecord(roomName, {
    status: nextStatus,
    updatedAt: gameTime,
    workerTarget,
    ...sitePlan.position ? { spawnSite: sitePlan.position } : {},
    lastResult: sitePlan.result
  });
  if (shouldReportSitePlan) {
    telemetryEvents.push({
      type: "postClaimBootstrap",
      roomName,
      colony: record.colony,
      phase: "spawnSite",
      ...record.controllerId ? { controllerId: record.controllerId } : {},
      result: sitePlan.result,
      ...sitePlan.position ? { spawnSite: sitePlan.position } : {},
      workerCount,
      workerTarget,
      spawnCount
    });
  }
  return { active: true, spawnConstructionPending: true };
}
function recordPostClaimBootstrapWorkerSpawn(roomName, spawnName, creepName, result, telemetryEvents = []) {
  if (!isNonEmptyString12(roomName)) {
    return;
  }
  const record = getPostClaimBootstrapRecord(roomName);
  if (!record || record.status === "ready") {
    return;
  }
  updatePostClaimBootstrapRecord(roomName, {
    status: "spawningWorkers",
    updatedAt: getGameTime9()
  });
  telemetryEvents.push({
    type: "postClaimBootstrap",
    roomName,
    colony: record.colony,
    phase: "workerSpawn",
    ...record.controllerId ? { controllerId: record.controllerId } : {},
    spawnName,
    creepName,
    result,
    workerTarget: getPostClaimBootstrapWorkerTarget(record)
  });
}
function getPostClaimBootstrapSummary(roomName) {
  const record = getPostClaimBootstrapRecord(roomName);
  if (!record || record.status === "ready") {
    return null;
  }
  return {
    colony: record.colony,
    status: record.status,
    claimedAt: record.claimedAt,
    updatedAt: record.updatedAt,
    workerTarget: getPostClaimBootstrapWorkerTarget(record),
    ...record.controllerId ? { controllerId: record.controllerId } : {},
    ...record.spawnSite ? { spawnSite: record.spawnSite } : {},
    ...record.lastResult !== void 0 ? { lastResult: record.lastResult } : {}
  };
}
function planInitialSpawnConstructionSite(room) {
  if (typeof room.createConstructionSite !== "function") {
    return { result: ERR_INVALID_TARGET_CODE };
  }
  const positions = findInitialSpawnConstructionPositions(room);
  if (positions.length === 0) {
    return { result: ERR_INVALID_TARGET_CODE };
  }
  let lastResult = ERR_INVALID_TARGET_CODE;
  for (const position of positions) {
    lastResult = room.createConstructionSite(position.x, position.y, getStructureConstant("STRUCTURE_SPAWN", "spawn"));
    if (lastResult === OK_CODE4) {
      return {
        result: lastResult,
        position: { ...position, roomName: room.name }
      };
    }
  }
  return { result: lastResult };
}
function findInitialSpawnConstructionPositions(room) {
  const anchor = selectInitialSpawnAnchor(room);
  if (!anchor) {
    return [];
  }
  const maximumScanRadius = getMaximumSpawnSiteScanRadius(anchor);
  const lookups = buildSpawnPlacementLookups(room, anchor, maximumScanRadius);
  const positions = [];
  for (let radius = 0; radius <= maximumScanRadius; radius += 1) {
    for (let y = anchor.y - radius; y <= anchor.y + radius; y += 1) {
      for (let x = anchor.x - radius; x <= anchor.x + radius; x += 1) {
        if (Math.max(Math.abs(x - anchor.x), Math.abs(y - anchor.y)) !== radius) {
          continue;
        }
        const position = { x, y };
        if (canPlaceInitialSpawn(lookups, position)) {
          positions.push(position);
        }
      }
    }
  }
  return positions;
}
function selectInitialSpawnAnchor(room) {
  const controllerPosition = getRoomObjectPosition4(room.controller);
  if (!controllerPosition) {
    return null;
  }
  const sources = findSources(room).map(getRoomObjectPosition4).filter((position) => position !== null).sort((left, right) => getRange(controllerPosition, left) - getRange(controllerPosition, right));
  const nearestSourcePosition = sources[0];
  if (!nearestSourcePosition) {
    return clampPosition(controllerPosition);
  }
  return clampPosition({
    x: Math.round((controllerPosition.x + nearestSourcePosition.x) / 2),
    y: Math.round((controllerPosition.y + nearestSourcePosition.y) / 2)
  });
}
function buildSpawnPlacementLookups(room, anchor, maximumScanRadius) {
  const blockingPositions = /* @__PURE__ */ new Set();
  for (const object of [
    room.controller,
    ...findSources(room),
    ...lookForArea(room, "LOOK_STRUCTURES", anchor, maximumScanRadius),
    ...lookForArea(room, "LOOK_CONSTRUCTION_SITES", anchor, maximumScanRadius)
  ]) {
    const position = getRoomObjectPosition4(object);
    if (position) {
      blockingPositions.add(getPositionKey4(position));
    }
  }
  const mineralPositions = /* @__PURE__ */ new Set();
  for (const object of lookForArea(room, "LOOK_MINERALS", anchor, maximumScanRadius)) {
    const position = getRoomObjectPosition4(object);
    if (position) {
      mineralPositions.add(getPositionKey4(position));
    }
  }
  return {
    blockingPositions,
    mineralPositions,
    terrain: getRoomTerrain5(room.name)
  };
}
function lookForArea(room, lookConstantName, anchor, maximumScanRadius) {
  const lookConstant = getGlobalString(lookConstantName);
  if (!lookConstant || typeof room.lookForAtArea !== "function") {
    return [];
  }
  const bounds = getScanBounds2(anchor, maximumScanRadius);
  return room.lookForAtArea(
    lookConstant,
    bounds.top,
    bounds.left,
    bounds.bottom,
    bounds.right,
    true
  );
}
function getScanBounds2(anchor, maximumScanRadius) {
  return {
    top: Math.max(ROOM_EDGE_MIN5, anchor.y - maximumScanRadius),
    left: Math.max(ROOM_EDGE_MIN5, anchor.x - maximumScanRadius),
    bottom: Math.min(ROOM_EDGE_MAX5, anchor.y + maximumScanRadius),
    right: Math.min(ROOM_EDGE_MAX5, anchor.x + maximumScanRadius)
  };
}
function canPlaceInitialSpawn(lookups, position) {
  return isWithinRoomBuildBounds(position) && !lookups.blockingPositions.has(getPositionKey4(position)) && !lookups.mineralPositions.has(getPositionKey4(position)) && !isTerrainWall3(lookups.terrain, position);
}
function isWithinRoomBuildBounds(position) {
  return position.x >= ROOM_EDGE_MIN5 && position.x <= ROOM_EDGE_MAX5 && position.y >= ROOM_EDGE_MIN5 && position.y <= ROOM_EDGE_MAX5;
}
function isTerrainWall3(terrain, position) {
  return terrain !== null && (terrain.get(position.x, position.y) & getTerrainWallMask5()) !== 0;
}
function findExistingSpawnConstructionSite(room) {
  var _a;
  const findConstant = getGlobalNumber4("FIND_MY_CONSTRUCTION_SITES");
  if (typeof room.find !== "function" || findConstant === null) {
    return null;
  }
  const sites = room.find(findConstant, {
    filter: (site) => matchesStructureType7(site.structureType, "STRUCTURE_SPAWN", "spawn")
  });
  return (_a = sites[0]) != null ? _a : null;
}
function findSources(room) {
  const findConstant = getGlobalNumber4("FIND_SOURCES");
  if (typeof room.find !== "function" || findConstant === null) {
    return [];
  }
  return room.find(findConstant);
}
function getRoomObjectPosition4(object) {
  if (!isRecord12(object)) {
    return null;
  }
  if (isFiniteNumber6(object.x) && isFiniteNumber6(object.y)) {
    return { x: object.x, y: object.y };
  }
  const pos = object.pos;
  if (isRecord12(pos) && isFiniteNumber6(pos.x) && isFiniteNumber6(pos.y)) {
    return { x: pos.x, y: pos.y };
  }
  return null;
}
function toSpawnSiteMemory(site) {
  var _a, _b, _c, _d, _e, _f;
  const position = getRoomObjectPosition4(site);
  return {
    roomName: (_d = (_c = (_a = site.pos) == null ? void 0 : _a.roomName) != null ? _c : (_b = site.room) == null ? void 0 : _b.name) != null ? _d : "",
    x: (_e = position == null ? void 0 : position.x) != null ? _e : site.pos.x,
    y: (_f = position == null ? void 0 : position.y) != null ? _f : site.pos.y
  };
}
function isSameSpawnSite(left, right) {
  return (left == null ? void 0 : left.roomName) === right.roomName && left.x === right.x && left.y === right.y;
}
function updatePostClaimBootstrapRecord(roomName, updates) {
  const bootstraps = getWritablePostClaimBootstrapRecords();
  const record = bootstraps == null ? void 0 : bootstraps[roomName];
  if (!bootstraps || !record) {
    return;
  }
  bootstraps[roomName] = {
    ...record,
    ...updates
  };
}
function getPostClaimBootstrapRecord(roomName) {
  var _a, _b, _c;
  const record = (_c = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.postClaimBootstraps) == null ? void 0 : _c[roomName];
  return isPostClaimBootstrapRecord(record, roomName) ? record : null;
}
function getWritablePostClaimBootstrapRecords() {
  const memory = globalThis.Memory;
  if (!memory) {
    return null;
  }
  if (!memory.territory) {
    memory.territory = {};
  }
  if (!memory.territory.postClaimBootstraps) {
    memory.territory.postClaimBootstraps = {};
  }
  return memory.territory.postClaimBootstraps;
}
function isPostClaimBootstrapRecord(value, expectedRoomName) {
  return isRecord12(value) && value.roomName === expectedRoomName && isNonEmptyString12(value.colony) && isPostClaimBootstrapStatus(value.status) && isFiniteNumber6(value.claimedAt) && isFiniteNumber6(value.updatedAt);
}
function isPostClaimBootstrapStatus(value) {
  return value === "detected" || value === "spawnSitePending" || value === "spawnSiteBlocked" || value === "spawningWorkers" || value === "ready";
}
function getPostClaimBootstrapWorkerTarget(record) {
  return isFiniteNumber6(record.workerTarget) && record.workerTarget > 0 ? Math.floor(record.workerTarget) : POST_CLAIM_BOOTSTRAP_WORKER_TARGET;
}
function clampPosition(position) {
  return {
    x: clamp(position.x, ROOM_EDGE_MIN5, ROOM_EDGE_MAX5),
    y: clamp(position.y, ROOM_EDGE_MIN5, ROOM_EDGE_MAX5)
  };
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function getMaximumSpawnSiteScanRadius(anchor) {
  return Math.max(
    anchor.x - ROOM_EDGE_MIN5,
    ROOM_EDGE_MAX5 - anchor.x,
    anchor.y - ROOM_EDGE_MIN5,
    ROOM_EDGE_MAX5 - anchor.y
  );
}
function getRange(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}
function getPositionKey4(position) {
  return `${position.x},${position.y}`;
}
function getRoomTerrain5(roomName) {
  var _a;
  const gameMap = (_a = globalThis.Game) == null ? void 0 : _a.map;
  return typeof (gameMap == null ? void 0 : gameMap.getRoomTerrain) === "function" ? gameMap.getRoomTerrain(roomName) : null;
}
function getTerrainWallMask5() {
  return typeof TERRAIN_MASK_WALL === "number" ? TERRAIN_MASK_WALL : DEFAULT_TERRAIN_WALL_MASK5;
}
function matchesStructureType7(actual, globalName, fallback) {
  return actual === getStructureConstant(globalName, fallback);
}
function getStructureConstant(globalName, fallback) {
  var _a;
  const constants = globalThis;
  return (_a = constants[globalName]) != null ? _a : fallback;
}
function getGlobalNumber4(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : null;
}
function getGlobalString(name) {
  const value = globalThis[name];
  return typeof value === "string" ? value : null;
}
function getGameTime9() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" && Number.isFinite(gameTime) ? gameTime : 0;
}
function isRecord12(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString12(value) {
  return typeof value === "string" && value.length > 0;
}
function isFiniteNumber6(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// src/telemetry/runtimeSummary.ts
var RUNTIME_SUMMARY_PREFIX = "#runtime-summary ";
var RUNTIME_SUMMARY_INTERVAL = 20;
var MAX_REPORTED_EVENTS = 10;
var MAX_WORKER_EFFICIENCY_SAMPLES = 5;
var MAX_WORKER_BEHAVIOR_SAMPLES = 10;
var MAX_WORKER_EFFICIENCY_REASON_SAMPLES = 5;
var MAX_REFILL_DELIVERY_SAMPLES = 5;
var MAX_SPAWN_CRITICAL_REFILL_SAMPLES = 5;
var MAX_TERRITORY_INTENT_SUMMARIES = 5;
var WORKER_EFFICIENCY_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
var WORKER_BEHAVIOR_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
var REFILL_DELIVERY_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
var SPAWN_CRITICAL_REFILL_SAMPLE_TTL = RUNTIME_SUMMARY_INTERVAL;
var OBSERVED_RAMPART_REPAIR_HITS_CEILING = 1e5;
var WORKER_TASK_TYPES = ["harvest", "transfer", "build", "repair", "upgrade"];
var PRODUCTIVE_WORKER_TASK_TYPES = ["build", "repair", "upgrade"];
var cachedRefillTargetIdsByRoom = /* @__PURE__ */ new Map();
var cachedEventMetricsByRoom = /* @__PURE__ */ new Map();
var cachedEventMetricsTick;
function emitRuntimeSummary(colonies, creeps, events = [], options = {}) {
  if (colonies.length === 0 && events.length === 0) {
    return void 0;
  }
  const tick = getGameTime10();
  resetCachedRefillTelemetryIfTickRewound(tick);
  const emitsSummary = shouldEmitRuntimeSummary(tick, events);
  const creepsByColony = groupCreepsByColony(creeps);
  let refillTargetIdsByRoom = cachedRefillTargetIdsByRoom;
  let eventMetricsByRoom = cachedEventMetricsByRoom;
  if (emitsSummary) {
    refillTargetIdsByRoom = buildRefillTargetIdsByRoom(colonies);
    eventMetricsByRoom = buildRoomEventMetricsByRoom(colonies, refillTargetIdsByRoom);
    cachedRefillTargetIdsByRoom = refillTargetIdsByRoom;
    cachedEventMetricsByRoom = eventMetricsByRoom;
    cachedEventMetricsTick = tick;
  }
  refreshRefillTelemetry(
    colonies,
    creepsByColony,
    refillTargetIdsByRoom,
    eventMetricsByRoom,
    tick,
    cachedEventMetricsTick
  );
  if (!emitsSummary) {
    return void 0;
  }
  const reportedEvents = events.slice(0, MAX_REPORTED_EVENTS);
  const persistOccupationRecommendations = options.persistOccupationRecommendations !== false;
  const summary = {
    type: "runtime-summary",
    tick,
    rooms: colonies.map(
      (colony) => {
        var _a, _b;
        return summarizeRoom(
          colony,
          (_a = creepsByColony.get(colony.room.name)) != null ? _a : [],
          persistOccupationRecommendations,
          (_b = eventMetricsByRoom.get(colony.room.name)) != null ? _b : {},
          shouldBuildStructureSnapshot(tick)
        );
      }
    ),
    ...reportedEvents.length > 0 ? { events: reportedEvents } : {},
    ...events.length > MAX_REPORTED_EVENTS ? { omittedEventCount: events.length - MAX_REPORTED_EVENTS } : {},
    ...buildCpuSummary()
  };
  console.log(`${RUNTIME_SUMMARY_PREFIX}${JSON.stringify(summary)}`);
  return summary;
}
function shouldEmitRuntimeSummary(tick, events) {
  return events.length > 0 || tick > 0 && tick % RUNTIME_SUMMARY_INTERVAL === 0;
}
function resetCachedRefillTelemetryIfTickRewound(tick) {
  if (cachedEventMetricsTick === void 0 || tick >= cachedEventMetricsTick) {
    return;
  }
  cachedRefillTargetIdsByRoom = /* @__PURE__ */ new Map();
  cachedEventMetricsByRoom = /* @__PURE__ */ new Map();
  cachedEventMetricsTick = void 0;
}
function groupCreepsByColony(creeps) {
  var _a;
  const creepsByColony = /* @__PURE__ */ new Map();
  for (const creep of creeps) {
    const colonyName = creep.memory.colony;
    if (!colonyName) {
      continue;
    }
    const colonyCreeps = (_a = creepsByColony.get(colonyName)) != null ? _a : [];
    colonyCreeps.push(creep);
    creepsByColony.set(colonyName, colonyCreeps);
  }
  return creepsByColony;
}
function buildRefillTargetIdsByRoom(colonies) {
  const refillTargetIdsByRoom = /* @__PURE__ */ new Map();
  for (const colony of colonies) {
    refillTargetIdsByRoom.set(colony.room.name, getSpawnExtensionEnergyStructureIds(colony.room));
  }
  return refillTargetIdsByRoom;
}
function buildRoomEventMetricsByRoom(colonies, refillTargetIdsByRoom) {
  var _a;
  const eventMetricsByRoom = /* @__PURE__ */ new Map();
  for (const colony of colonies) {
    eventMetricsByRoom.set(
      colony.room.name,
      summarizeRoomEventMetrics(colony.room, (_a = refillTargetIdsByRoom.get(colony.room.name)) != null ? _a : /* @__PURE__ */ new Set())
    );
  }
  return eventMetricsByRoom;
}
function summarizeRoom(colony, colonyCreeps, persistOccupationRecommendations, eventMetrics, includeStructureSnapshot) {
  const colonyWorkers = colonyCreeps.filter((creep) => creep.memory.role === "worker");
  const roleCounts = countCreepsByRole(colonyCreeps, colony.room.name);
  const territoryRecommendation = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
  const territoryExpansion = buildRuntimeExpansionCandidateReport(colony);
  if (persistOccupationRecommendations) {
    persistOccupationRecommendationFollowUpIntent(territoryRecommendation, getGameTime10());
  }
  return {
    roomName: colony.room.name,
    energyAvailable: colony.energyAvailable,
    energyCapacity: colony.energyCapacityAvailable,
    workerCount: colonyWorkers.length,
    spawnStatus: colony.spawns.map(summarizeSpawn),
    taskCounts: countWorkerTasks(colonyWorkers),
    ...summarizeRuntimeBehavior(colonyWorkers, getGameTime10()),
    ...includeStructureSnapshot ? { structures: summarizeStructures(colony, colonyWorkers) } : {},
    ...summarizeWorkerEfficiency(colonyWorkers, getGameTime10()),
    ...summarizeRefillTelemetry(colonyWorkers, getGameTime10()),
    ...summarizeSpawnCriticalRefill(colonyWorkers, getGameTime10()),
    ...buildControllerSummary(colony.room),
    resources: summarizeResources(colony, colonyWorkers, eventMetrics.resources),
    combat: summarizeCombat(colony.room, eventMetrics.combat),
    constructionPriority: summarizeConstructionPriority(colony, colonyWorkers),
    survival: summarizeSurvival(colony, roleCounts),
    territoryRecommendation,
    ...territoryExpansion.candidates.length > 0 ? { territoryExpansion } : {},
    ...buildTerritoryIntentSummary(colony.room.name, roleCounts),
    ...buildTerritoryExecutionHintSummary(colony.room.name),
    ...buildPostClaimBootstrapSummary(colony.room.name)
  };
}
function buildPostClaimBootstrapSummary(roomName) {
  const postClaimBootstrap = getPostClaimBootstrapSummary(roomName);
  return postClaimBootstrap ? { postClaimBootstrap } : {};
}
function buildTerritoryIntentSummary(colonyName, roleCounts) {
  const territoryIntents = getTerritoryIntentProgressSummaries(colonyName, roleCounts);
  const suspendedTerritoryIntentCounts = getSuspendedTerritoryIntentCountsByRoom(colonyName, getGameTime10());
  const hasSuspendedTerritoryIntents = Object.keys(suspendedTerritoryIntentCounts).length > 0;
  if (territoryIntents.length === 0 && !hasSuspendedTerritoryIntents) {
    return {};
  }
  const reportedIntents = territoryIntents.slice(0, MAX_TERRITORY_INTENT_SUMMARIES);
  return {
    ...reportedIntents.length > 0 ? { territoryIntents: reportedIntents } : {},
    ...territoryIntents.length > MAX_TERRITORY_INTENT_SUMMARIES ? { omittedTerritoryIntentCount: territoryIntents.length - MAX_TERRITORY_INTENT_SUMMARIES } : {},
    ...hasSuspendedTerritoryIntents ? { suspendedTerritoryIntentCounts } : {}
  };
}
function buildTerritoryExecutionHintSummary(colonyName) {
  const territoryExecutionHints = getActiveTerritoryFollowUpExecutionHints(colonyName);
  return territoryExecutionHints.length > 0 ? { territoryExecutionHints } : {};
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
    repair: 0,
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
function summarizeBehavior(workers, tick) {
  const samples = workers.map((worker) => ({ creepName: getCreepName2(worker), sample: worker.memory.workerBehavior })).filter(
    (entry) => isWorkerTaskBehaviorSample(entry.sample) && isRecentWorkerTaskBehaviorSample(entry.sample, tick)
  ).sort(compareWorkerTaskBehaviorSampleEntries);
  if (samples.length === 0) {
    return {};
  }
  const reportedSamples = samples.slice(0, MAX_WORKER_BEHAVIOR_SAMPLES).map(toRuntimeWorkerTaskBehaviorSample);
  return {
    behavior: {
      workerTaskPolicy: {
        schemaVersion: 1,
        sourcePolicyId: HEURISTIC_WORKER_TASK_POLICY_ID,
        liveEffect: false,
        sampleCount: samples.length,
        actionCounts: countWorkerBehaviorActions(samples),
        samples: reportedSamples,
        ...samples.length > MAX_WORKER_BEHAVIOR_SAMPLES ? { omittedSampleCount: samples.length - MAX_WORKER_BEHAVIOR_SAMPLES } : {},
        ...summarizeWorkerTaskPolicyShadow(workers, tick)
      }
    }
  };
}
function summarizeRuntimeBehavior(workers, tick) {
  const workerTaskPolicySummary = summarizeBehavior(workers, tick);
  const legacySummary = summarizeAndResetCreepBehaviorTelemetry(workers);
  if (!workerTaskPolicySummary.behavior && !legacySummary.behavior) {
    return {};
  }
  return {
    behavior: {
      ...legacySummary.behavior,
      ...workerTaskPolicySummary.behavior
    }
  };
}
function countWorkerBehaviorActions(samples) {
  const counts = Object.fromEntries(WORKER_TASK_BC_ACTION_TYPES.map((action) => [action, 0]));
  for (const entry of samples) {
    counts[entry.sample.action.type] += 1;
  }
  return counts;
}
function summarizeWorkerTaskPolicyShadow(workers, tick) {
  const shadows = workers.map((worker) => worker.memory.workerTaskPolicyShadow).filter((shadow) => isRecentWorkerTaskPolicyShadow(shadow, tick));
  if (shadows.length === 0) {
    return {};
  }
  const matchedCount = shadows.filter((shadow) => shadow.matched).length;
  const mismatchCount = shadows.filter((shadow) => shadow.fallbackReason === "actionMismatch").length;
  const noPredictionCount = shadows.filter(
    (shadow) => shadow.fallbackReason === "untrainedModel" || shadow.fallbackReason === "lowConfidence"
  ).length;
  return {
    shadow: {
      policyId: shadows[0].policyId,
      liveEffect: false,
      sampleCount: shadows.length,
      matchedCount,
      mismatchCount,
      noPredictionCount,
      matchRate: roundRatio3(matchedCount, shadows.length)
    }
  };
}
function compareWorkerTaskBehaviorSampleEntries(left, right) {
  var _a, _b;
  return right.sample.tick - left.sample.tick || ((_a = left.creepName) != null ? _a : "").localeCompare((_b = right.creepName) != null ? _b : "") || left.sample.action.type.localeCompare(right.sample.action.type) || left.sample.action.targetId.localeCompare(right.sample.action.targetId);
}
function toRuntimeWorkerTaskBehaviorSample(entry) {
  return {
    ...entry.creepName ? { creepName: entry.creepName } : {},
    ...entry.sample
  };
}
function isRecentWorkerTaskBehaviorSample(sample, tick) {
  if (tick <= 0) {
    return true;
  }
  return sample.tick <= tick && sample.tick > tick - WORKER_BEHAVIOR_SAMPLE_TTL;
}
function isWorkerTaskBehaviorSample(value) {
  return isRecord13(value) && value.type === "workerTaskBehavior" && value.schemaVersion === 1 && typeof value.tick === "number" && Number.isFinite(value.tick) && typeof value.policyId === "string" && value.liveEffect === false && isRecord13(value.state) && isRecord13(value.action) && isWorkerTaskBehaviorActionType(value.action.type) && typeof value.action.targetId === "string";
}
function isRecentWorkerTaskPolicyShadow(value, tick) {
  if (!isWorkerTaskPolicyShadow(value)) {
    return false;
  }
  return tick <= 0 || value.tick <= tick && value.tick > tick - WORKER_BEHAVIOR_SAMPLE_TTL;
}
function isWorkerTaskPolicyShadow(value) {
  return isRecord13(value) && value.type === "workerTaskPolicyShadow" && value.schemaVersion === 1 && typeof value.tick === "number" && Number.isFinite(value.tick) && typeof value.policyId === "string" && value.liveEffect === false && typeof value.matched === "boolean";
}
function shouldBuildStructureSnapshot(tick) {
  return tick > 0 && tick % RUNTIME_SUMMARY_INTERVAL === 0;
}
function summarizeStructures(colony, colonyWorkers) {
  var _a, _b;
  const roomStructures = (_a = findRoomObjects8(colony.room, "FIND_STRUCTURES")) != null ? _a : colony.spawns;
  const constructionSites = (_b = findRoomObjects8(colony.room, "FIND_MY_CONSTRUCTION_SITES")) != null ? _b : [];
  const roadCount = countStructuresByType2(roomStructures, "STRUCTURE_ROAD", "road");
  const pendingRoadSiteCount = countConstructionSitesByType(constructionSites, "STRUCTURE_ROAD", "road");
  return {
    towerCount: countStructuresByType2(roomStructures, "STRUCTURE_TOWER", "tower"),
    rampartCount: countOwnedRamparts(roomStructures),
    containers: summarizeContainers(roomStructures),
    repairTargets: summarizeRepairTargetDistribution(colonyWorkers, roomStructures),
    roadCount,
    pendingRoadSiteCount,
    roadCoverageRatio: calculateRoadCoverageRatio(roadCount, pendingRoadSiteCount)
  };
}
function countStructuresByType2(structures, globalName, fallback) {
  return structures.filter((structure) => isStructureOfType(structure, globalName, fallback)).length;
}
function countConstructionSitesByType(constructionSites, globalName, fallback) {
  return constructionSites.filter((site) => isStructureOfType(site, globalName, fallback)).length;
}
function countOwnedRamparts(structures) {
  return structures.filter((structure) => isRecord13(structure) && isObservedOwnedRampart(structure)).length;
}
function summarizeContainers(structures) {
  return structures.filter((structure) => isStructureOfType(structure, "STRUCTURE_CONTAINER", "container")).map(toRuntimeContainerSnapshot).filter((summary) => summary !== null).sort((left, right) => left.id.localeCompare(right.id));
}
function toRuntimeContainerSnapshot(structure) {
  const id = getObjectId2(structure);
  if (!id) {
    return null;
  }
  return {
    id,
    energy: getEnergyInStore(structure),
    capacity: getEnergyCapacityInStore(structure)
  };
}
function summarizeRepairTargetDistribution(colonyWorkers, roomStructures) {
  var _a;
  const repairCounts = /* @__PURE__ */ new Map();
  for (const worker of colonyWorkers) {
    const task = worker.memory.task;
    if ((task == null ? void 0 : task.type) !== "repair") {
      continue;
    }
    const targetId = String(task.targetId);
    repairCounts.set(targetId, ((_a = repairCounts.get(targetId)) != null ? _a : 0) + 1);
  }
  const structuresById = /* @__PURE__ */ new Map();
  for (const structure of roomStructures) {
    const id = getObjectId2(structure);
    if (id) {
      structuresById.set(id, structure);
    }
  }
  return [...repairCounts.entries()].sort(([leftTargetId], [rightTargetId]) => leftTargetId.localeCompare(rightTargetId)).map(([targetId, repairCount]) => toRuntimeRepairTargetSnapshot(targetId, repairCount, structuresById.get(targetId)));
}
function toRuntimeRepairTargetSnapshot(targetId, repairCount, structure) {
  const structureRecord = isRecord13(structure) ? structure : {};
  const structureType = typeof structureRecord.structureType === "string" ? structureRecord.structureType : void 0;
  const hits = getFiniteNumber(structureRecord.hits);
  const hitsMax = getFiniteNumber(structureRecord.hitsMax);
  return {
    targetId,
    repairCount,
    ...structureType ? { structureType } : {},
    ...hits !== null ? { hits } : {},
    ...hitsMax !== null ? { hitsMax } : {}
  };
}
function isStructureOfType(structure, globalName, fallback) {
  return isRecord13(structure) && matchesStructureType8(structure.structureType, globalName, fallback);
}
function calculateRoadCoverageRatio(roadCount, pendingRoadSiteCount) {
  const totalKnownRoadWork = roadCount + pendingRoadSiteCount;
  if (totalKnownRoadWork <= 0) {
    return 0;
  }
  return roundRatio3(roadCount, totalKnownRoadWork);
}
function summarizeWorkerEfficiency(workers, tick) {
  const samples = workers.map((worker) => ({ creepName: getCreepName2(worker), sample: worker.memory.workerEfficiency })).filter(
    (entry) => isWorkerEfficiencySample(entry.sample) && isRecentWorkerEfficiencySample(entry.sample, tick)
  ).sort(compareWorkerEfficiencySampleEntries);
  if (samples.length === 0) {
    return {};
  }
  const reportedSamples = samples.slice(0, MAX_WORKER_EFFICIENCY_SAMPLES).map(toRuntimeWorkerEfficiencySample);
  const lowLoadReturnSamples = samples.filter((entry) => entry.sample.type === "lowLoadReturn");
  const emergencyLowLoadReturnCount = lowLoadReturnSamples.filter(
    (entry) => isEmergencyLowLoadReturnReason(getLowLoadReturnReason(entry.sample))
  ).length;
  const lowLoadReturnReasons = summarizeLowLoadReturnReasons(lowLoadReturnSamples);
  return {
    workerEfficiency: {
      lowLoadReturnCount: lowLoadReturnSamples.length,
      emergencyLowLoadReturnCount,
      avoidableLowLoadReturnCount: lowLoadReturnSamples.length - emergencyLowLoadReturnCount,
      nearbyEnergyChoiceCount: samples.filter((entry) => entry.sample.type === "nearbyEnergyChoice").length,
      ...lowLoadReturnReasons.length > 0 ? { lowLoadReturnReasons } : {},
      samples: reportedSamples,
      ...samples.length > MAX_WORKER_EFFICIENCY_SAMPLES ? { omittedSampleCount: samples.length - MAX_WORKER_EFFICIENCY_SAMPLES } : {}
    }
  };
}
function summarizeLowLoadReturnReasons(samples) {
  var _a;
  const countsByReason = /* @__PURE__ */ new Map();
  for (const entry of samples) {
    const reason = getLowLoadReturnReason(entry.sample);
    countsByReason.set(reason, ((_a = countsByReason.get(reason)) != null ? _a : 0) + 1);
  }
  return [...countsByReason.entries()].map(([reason, count]) => ({
    reason,
    category: getLowLoadReturnReasonCategory(reason),
    count
  })).sort(compareLowLoadReturnReasonSummaries).slice(0, MAX_WORKER_EFFICIENCY_REASON_SAMPLES);
}
function compareLowLoadReturnReasonSummaries(left, right) {
  return right.count - left.count || left.reason.localeCompare(right.reason);
}
function getLowLoadReturnReason(sample) {
  return isLowLoadReturnReason(sample.reason) ? sample.reason : "unknown";
}
function getLowLoadReturnReasonCategory(reason) {
  return isEmergencyLowLoadReturnReason(reason) ? "emergency" : "avoidable";
}
function isEmergencyLowLoadReturnReason(reason) {
  return reason === "emergencySpawnExtensionRefill" || reason === "controllerDowngradeGuard" || reason === "hostileSafety" || reason === "urgentSpawnExtensionRefill";
}
function isLowLoadReturnReason(value) {
  return value === "emergencySpawnExtensionRefill" || value === "controllerDowngradeGuard" || value === "hostileSafety" || value === "noReachableEnergy" || value === "urgentSpawnExtensionRefill" || value === "noNearbyEnergy";
}
function compareWorkerEfficiencySampleEntries(left, right) {
  var _a, _b;
  return right.sample.tick - left.sample.tick || ((_a = left.creepName) != null ? _a : "").localeCompare((_b = right.creepName) != null ? _b : "") || left.sample.targetId.localeCompare(right.sample.targetId);
}
function toRuntimeWorkerEfficiencySample(entry) {
  return {
    ...entry.creepName ? { creepName: entry.creepName } : {},
    ...entry.sample
  };
}
function summarizeRefillTelemetry(workers, tick) {
  return {
    ...summarizeRefillDeliveryTicks(workers, tick),
    ...summarizeRefillWorkerUtilization(workers)
  };
}
function summarizeRefillDeliveryTicks(workers, tick) {
  const samples = workers.flatMap(
    (worker) => {
      var _a, _b;
      return ((_b = (_a = worker.memory.refillTelemetry) == null ? void 0 : _a.recentDeliveries) != null ? _b : []).map((sample) => ({
        creepName: getCreepName2(worker),
        sample
      }));
    }
  ).filter(
    (entry) => isRecentRefillDeliverySample(entry.sample, tick)
  ).sort(compareRefillDeliverySampleEntries);
  if (samples.length === 0) {
    return {};
  }
  const reportedSamples = samples.slice(0, MAX_REFILL_DELIVERY_SAMPLES).map(toRuntimeRefillDeliverySample);
  const deliveryTicks = samples.map((entry) => entry.sample.deliveryTicks);
  const completedCount = deliveryTicks.length;
  return {
    refillDeliveryTicks: {
      completedCount,
      averageTicks: roundRatio3(deliveryTicks.reduce((total, value) => total + value, 0), completedCount),
      maxTicks: Math.max(...deliveryTicks),
      samples: reportedSamples,
      ...samples.length > MAX_REFILL_DELIVERY_SAMPLES ? { omittedSampleCount: samples.length - MAX_REFILL_DELIVERY_SAMPLES } : {}
    }
  };
}
function summarizeRefillWorkerUtilization(workers) {
  const workerSummaries = workers.map((worker) => {
    var _a, _b;
    const telemetry = worker.memory.refillTelemetry;
    if (!telemetry) {
      return null;
    }
    const refillActiveTicks2 = Math.max(0, Math.floor((_a = telemetry.refillActiveTicks) != null ? _a : 0));
    const idleOrOtherTaskTicks2 = Math.max(0, Math.floor((_b = telemetry.idleOrOtherTaskTicks) != null ? _b : 0));
    const totalTicks2 = refillActiveTicks2 + idleOrOtherTaskTicks2;
    if (totalTicks2 <= 0) {
      return null;
    }
    return {
      ...getCreepName2(worker) ? { creepName: getCreepName2(worker) } : {},
      refillActiveTicks: refillActiveTicks2,
      idleOrOtherTaskTicks: idleOrOtherTaskTicks2,
      ratio: roundRatio3(refillActiveTicks2, totalTicks2)
    };
  }).filter((summary) => summary !== null).sort(compareRefillWorkerUtilizationSummaries);
  if (workerSummaries.length === 0) {
    return {};
  }
  const refillActiveTicks = workerSummaries.reduce((total, worker) => total + worker.refillActiveTicks, 0);
  const idleOrOtherTaskTicks = workerSummaries.reduce((total, worker) => total + worker.idleOrOtherTaskTicks, 0);
  const totalTicks = refillActiveTicks + idleOrOtherTaskTicks;
  return {
    refillWorkerUtilization: {
      assignedWorkerCount: workerSummaries.length,
      refillActiveTicks,
      idleOrOtherTaskTicks,
      ratio: roundRatio3(refillActiveTicks, totalTicks),
      workers: workerSummaries
    }
  };
}
function compareRefillDeliverySampleEntries(left, right) {
  var _a, _b;
  return right.sample.tick - left.sample.tick || ((_a = left.creepName) != null ? _a : "").localeCompare((_b = right.creepName) != null ? _b : "") || left.sample.targetId.localeCompare(right.sample.targetId);
}
function toRuntimeRefillDeliverySample(entry) {
  return {
    ...entry.creepName ? { creepName: entry.creepName } : {},
    ...entry.sample
  };
}
function compareRefillWorkerUtilizationSummaries(left, right) {
  var _a, _b;
  return right.refillActiveTicks + right.idleOrOtherTaskTicks - (left.refillActiveTicks + left.idleOrOtherTaskTicks) || ((_a = left.creepName) != null ? _a : "").localeCompare((_b = right.creepName) != null ? _b : "");
}
function isRecentRefillDeliverySample(sample, tick) {
  return isRefillDeliverySample(sample) && (tick <= 0 || sample.tick <= tick && sample.tick > tick - REFILL_DELIVERY_SAMPLE_TTL);
}
function isRefillDeliverySample(value) {
  return isRecord13(value) && typeof value.tick === "number" && Number.isFinite(value.tick) && typeof value.targetId === "string" && typeof value.deliveryTicks === "number" && Number.isFinite(value.deliveryTicks) && typeof value.activeTicks === "number" && Number.isFinite(value.activeTicks) && typeof value.idleOrOtherTaskTicks === "number" && Number.isFinite(value.idleOrOtherTaskTicks) && typeof value.energyDelivered === "number" && Number.isFinite(value.energyDelivered);
}
function roundRatio3(numerator, denominator) {
  if (denominator <= 0) {
    return 0;
  }
  return Math.round(numerator / denominator * 1e3) / 1e3;
}
function isRecentWorkerEfficiencySample(sample, tick) {
  if (tick <= 0) {
    return true;
  }
  return sample.tick <= tick && sample.tick > tick - WORKER_EFFICIENCY_SAMPLE_TTL;
}
function isWorkerEfficiencySample(value) {
  if (!isRecord13(value)) {
    return false;
  }
  return (value.type === "lowLoadReturn" || value.type === "nearbyEnergyChoice") && typeof value.tick === "number" && Number.isFinite(value.tick) && typeof value.carriedEnergy === "number" && Number.isFinite(value.carriedEnergy) && typeof value.freeCapacity === "number" && Number.isFinite(value.freeCapacity) && isWorkerEfficiencyTaskType(value.selectedTask) && typeof value.targetId === "string";
}
function isWorkerEfficiencyTaskType(value) {
  return value === "harvest" || value === "pickup" || value === "withdraw" || value === "transfer" || value === "build" || value === "repair" || value === "claim" || value === "reserve" || value === "upgrade";
}
function summarizeSpawnCriticalRefill(workers, tick) {
  const samples = workers.map((worker) => ({ creepName: getCreepName2(worker), sample: worker.memory.spawnCriticalRefill })).filter(
    (entry) => isRecentSpawnCriticalRefillSample(entry.sample, tick)
  ).sort(compareSpawnCriticalRefillSampleEntries);
  if (samples.length === 0) {
    return {};
  }
  const reportedSamples = samples.slice(0, MAX_SPAWN_CRITICAL_REFILL_SAMPLES).map(toRuntimeSpawnCriticalRefillSample);
  const assignedCarriedEnergy = samples.reduce((total, entry) => total + Math.max(0, entry.sample.carriedEnergy), 0);
  return {
    spawnCriticalRefill: {
      assignedWorkerCount: samples.length,
      assignedCarriedEnergy,
      threshold: samples[0].sample.threshold,
      samples: reportedSamples,
      ...samples.length > MAX_SPAWN_CRITICAL_REFILL_SAMPLES ? { omittedSampleCount: samples.length - MAX_SPAWN_CRITICAL_REFILL_SAMPLES } : {}
    }
  };
}
function compareSpawnCriticalRefillSampleEntries(left, right) {
  var _a, _b;
  return right.sample.tick - left.sample.tick || ((_a = left.creepName) != null ? _a : "").localeCompare((_b = right.creepName) != null ? _b : "") || left.sample.targetId.localeCompare(right.sample.targetId);
}
function toRuntimeSpawnCriticalRefillSample(entry) {
  return {
    ...entry.creepName ? { creepName: entry.creepName } : {},
    ...entry.sample
  };
}
function isRecentSpawnCriticalRefillSample(sample, tick) {
  return isSpawnCriticalRefillSample(sample) && (tick <= 0 || sample.tick <= tick && sample.tick > tick - SPAWN_CRITICAL_REFILL_SAMPLE_TTL);
}
function isSpawnCriticalRefillSample(value) {
  return isRecord13(value) && value.type === "spawnCriticalRefill" && typeof value.tick === "number" && Number.isFinite(value.tick) && typeof value.targetId === "string" && typeof value.carriedEnergy === "number" && Number.isFinite(value.carriedEnergy) && typeof value.spawnEnergy === "number" && Number.isFinite(value.spawnEnergy) && typeof value.freeCapacity === "number" && Number.isFinite(value.freeCapacity) && typeof value.threshold === "number" && Number.isFinite(value.threshold);
}
function getCreepName2(creep) {
  const name = creep.name;
  return typeof name === "string" && name.length > 0 ? name : void 0;
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
  var _a, _b, _c, _d;
  const roomStructures = (_a = findRoomObjects8(colony.room, "FIND_STRUCTURES")) != null ? _a : colony.spawns;
  const constructionSites = (_b = findRoomObjects8(colony.room, "FIND_MY_CONSTRUCTION_SITES")) != null ? _b : [];
  const droppedResources = (_c = findRoomObjects8(colony.room, "FIND_DROPPED_RESOURCES")) != null ? _c : [];
  const sources = (_d = findRoomObjects8(colony.room, "FIND_SOURCES")) != null ? _d : [];
  return {
    storedEnergy: sumEnergyInStores(roomStructures),
    workerCarriedEnergy: sumEnergyInStores(colonyWorkers),
    droppedEnergy: sumDroppedEnergy2(droppedResources),
    sourceCount: sources.length,
    productiveEnergy: summarizeProductiveEnergy(colony.room, colonyWorkers, constructionSites, roomStructures),
    ...events ? { events } : {}
  };
}
function summarizeProductiveEnergy(room, colonyWorkers, constructionSites, roomStructures) {
  const productiveAssignments = summarizeProductiveWorkerAssignments(colonyWorkers);
  return {
    ...productiveAssignments,
    pendingBuildProgress: sumPendingBuildProgress(constructionSites),
    repairBacklogHits: sumRepairBacklogHits(roomStructures),
    ...buildControllerProgressRemaining(room)
  };
}
function summarizeProductiveWorkerAssignments(colonyWorkers) {
  var _a;
  const summary = {
    assignedWorkerCount: 0,
    assignedCarriedEnergy: 0,
    buildCarriedEnergy: 0,
    repairCarriedEnergy: 0,
    upgradeCarriedEnergy: 0
  };
  for (const worker of colonyWorkers) {
    const taskType = (_a = worker.memory.task) == null ? void 0 : _a.type;
    if (!isProductiveWorkerTaskType(taskType)) {
      continue;
    }
    const carriedEnergy = getEnergyInStore(worker);
    summary.assignedWorkerCount += 1;
    summary.assignedCarriedEnergy += carriedEnergy;
    if (taskType === "build") {
      summary.buildCarriedEnergy += carriedEnergy;
    } else if (taskType === "repair") {
      summary.repairCarriedEnergy += carriedEnergy;
    } else {
      summary.upgradeCarriedEnergy += carriedEnergy;
    }
  }
  return summary;
}
function isProductiveWorkerTaskType(taskType) {
  return PRODUCTIVE_WORKER_TASK_TYPES.includes(taskType);
}
function sumPendingBuildProgress(constructionSites) {
  return constructionSites.reduce((total, constructionSite) => total + getPendingBuildProgress(constructionSite), 0);
}
function getPendingBuildProgress(constructionSite) {
  if (!isRecord13(constructionSite)) {
    return 0;
  }
  const progress = getFiniteNumber(constructionSite.progress);
  const progressTotal = getFiniteNumber(constructionSite.progressTotal);
  if (progress === null || progressTotal === null) {
    return 0;
  }
  return Math.max(0, Math.ceil(progressTotal - progress));
}
function sumRepairBacklogHits(roomStructures) {
  return roomStructures.reduce((total, structure) => total + getRepairBacklogHits(structure), 0);
}
function getRepairBacklogHits(structure) {
  if (!isRecord13(structure) || !isObservableRepairBacklogStructure(structure)) {
    return 0;
  }
  const hits = getFiniteNumber(structure.hits);
  const hitsMax = getFiniteNumber(structure.hitsMax);
  if (hits === null || hitsMax === null || hitsMax <= 0) {
    return 0;
  }
  const repairCeiling = isObservedOwnedRampart(structure) ? Math.min(hitsMax, OBSERVED_RAMPART_REPAIR_HITS_CEILING) : hitsMax;
  return Math.max(0, Math.ceil(repairCeiling - hits));
}
function isObservableRepairBacklogStructure(structure) {
  return matchesStructureType8(structure.structureType, "STRUCTURE_ROAD", "road") || matchesStructureType8(structure.structureType, "STRUCTURE_CONTAINER", "container") || isObservedOwnedRampart(structure);
}
function isObservedOwnedRampart(structure) {
  return matchesStructureType8(structure.structureType, "STRUCTURE_RAMPART", "rampart") && structure.my === true;
}
function buildControllerProgressRemaining(room) {
  const controller = room.controller;
  if ((controller == null ? void 0 : controller.my) !== true) {
    return {};
  }
  const progress = getFiniteNumber(controller.progress);
  const progressTotal = getFiniteNumber(controller.progressTotal);
  if (progress === null || progressTotal === null) {
    return {};
  }
  return { controllerProgressRemaining: Math.max(0, Math.ceil(progressTotal - progress)) };
}
function summarizeCombat(room, events) {
  var _a, _b;
  const hostileCreeps = (_a = findRoomObjects8(room, "FIND_HOSTILE_CREEPS")) != null ? _a : [];
  const hostileStructures = (_b = findRoomObjects8(room, "FIND_HOSTILE_STRUCTURES")) != null ? _b : [];
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
function summarizeSurvival(colony, roleCounts) {
  const assessment = assessColonySnapshotSurvival(colony, roleCounts);
  return {
    mode: assessment.mode,
    workerCapacity: assessment.workerCapacity,
    workerTarget: assessment.workerTarget,
    survivalWorkerFloor: assessment.survivalWorkerFloor,
    ...assessment.suppressionReasons.length > 0 ? { suppressionReasons: assessment.suppressionReasons } : {}
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
function refreshRefillTelemetry(colonies, creepsByColony, refillTargetIdsByRoom, eventMetricsByRoom, tick, eventMetricsTick) {
  var _a, _b, _c, _d;
  for (const colony of colonies) {
    const roomName = colony.room.name;
    const refillTargetIds = (_a = refillTargetIdsByRoom.get(roomName)) != null ? _a : /* @__PURE__ */ new Set();
    const refillTransfers = eventMetricsTick === tick ? (_c = (_b = eventMetricsByRoom.get(roomName)) == null ? void 0 : _b.refillTransfers) != null ? _c : [] : [];
    const workers = ((_d = creepsByColony.get(roomName)) != null ? _d : []).filter((creep) => creep.memory.role === "worker");
    for (const worker of workers) {
      refreshWorkerRefillTelemetry(worker, refillTargetIds, refillTransfers, tick);
    }
  }
}
function refreshWorkerRefillTelemetry(worker, refillTargetIds, refillTransfers, tick) {
  var _a;
  const refillTargetId = getAssignedRefillTargetId(worker, refillTargetIds);
  let telemetry = worker.memory.refillTelemetry;
  if (refillTargetId) {
    telemetry = ensureWorkerRefillTelemetry(worker);
    if (!telemetry.current || telemetry.current.targetId !== refillTargetId) {
      telemetry.current = {
        targetId: refillTargetId,
        startedAt: tick,
        activeTicks: 0,
        idleOrOtherTaskTicks: 0
      };
    }
    recordWorkerRefillTelemetryTick(telemetry, true, tick);
  } else if (telemetry && (telemetry.current || hasRecentWorkerRefillDelivery(telemetry, tick))) {
    recordWorkerRefillTelemetryTick(telemetry, false, tick);
  }
  if (!(telemetry == null ? void 0 : telemetry.current)) {
    pruneWorkerRefillTelemetry(worker, tick);
    return;
  }
  const current = telemetry.current;
  const deliveryEvents = refillTransfers.filter(
    (event) => isWorkerRefillTransferEvent(worker, current.targetId, event)
  );
  if (deliveryEvents.length === 0) {
    pruneWorkerRefillTelemetry(worker, tick);
    return;
  }
  const energyDelivered = deliveryEvents.reduce((total, event) => total + event.amount, 0);
  const sample = {
    tick,
    targetId: current.targetId,
    deliveryTicks: Math.max(1, tick - current.startedAt + 1),
    activeTicks: current.activeTicks,
    idleOrOtherTaskTicks: current.idleOrOtherTaskTicks,
    energyDelivered
  };
  telemetry.recentDeliveries = [sample, ...(_a = telemetry.recentDeliveries) != null ? _a : []].filter(
    (recentSample) => isRecentRefillDeliverySample(recentSample, tick)
  );
  delete telemetry.current;
  pruneWorkerRefillTelemetry(worker, tick);
}
function ensureWorkerRefillTelemetry(worker) {
  if (!worker.memory.refillTelemetry) {
    worker.memory.refillTelemetry = {};
  }
  return worker.memory.refillTelemetry;
}
function recordWorkerRefillTelemetryTick(telemetry, isRefillActive, tick) {
  var _a, _b;
  if (telemetry.lastUpdatedAt === tick) {
    return;
  }
  if (isRefillActive) {
    telemetry.refillActiveTicks = ((_a = telemetry.refillActiveTicks) != null ? _a : 0) + 1;
    if (telemetry.current) {
      telemetry.current.activeTicks += 1;
    }
  } else {
    telemetry.idleOrOtherTaskTicks = ((_b = telemetry.idleOrOtherTaskTicks) != null ? _b : 0) + 1;
    if (telemetry.current) {
      telemetry.current.idleOrOtherTaskTicks += 1;
    }
  }
  telemetry.lastUpdatedAt = tick;
}
function pruneWorkerRefillTelemetry(worker, tick) {
  const telemetry = worker.memory.refillTelemetry;
  if (!telemetry) {
    return;
  }
  if (telemetry.recentDeliveries) {
    telemetry.recentDeliveries = telemetry.recentDeliveries.filter(
      (sample) => isRecentRefillDeliverySample(sample, tick)
    );
    if (telemetry.recentDeliveries.length === 0) {
      delete telemetry.recentDeliveries;
    }
  }
  if (!telemetry.current && !telemetry.recentDeliveries && (telemetry.lastUpdatedAt === void 0 || telemetry.lastUpdatedAt <= tick - REFILL_DELIVERY_SAMPLE_TTL)) {
    delete worker.memory.refillTelemetry;
  }
}
function hasRecentWorkerRefillDelivery(telemetry, tick) {
  var _a;
  return ((_a = telemetry.recentDeliveries) != null ? _a : []).some((sample) => isRecentRefillDeliverySample(sample, tick));
}
function getAssignedRefillTargetId(worker, refillTargetIds) {
  const task = worker.memory.task;
  if ((task == null ? void 0 : task.type) !== "transfer") {
    return null;
  }
  const targetId = String(task.targetId);
  return refillTargetIds.has(targetId) ? targetId : null;
}
function isWorkerRefillTransferEvent(worker, targetId, event) {
  return event.targetId === targetId && getWorkerEventIds(worker).some((workerId) => workerId === event.objectId);
}
function getWorkerEventIds(worker) {
  const ids = [];
  const id = worker.id;
  const name = worker.name;
  if (typeof id === "string" && id.length > 0) {
    ids.push(id);
  }
  if (typeof name === "string" && name.length > 0) {
    ids.push(name);
  }
  return ids;
}
function summarizeRoomEventMetrics(room, refillTargetIds = getSpawnExtensionEnergyStructureIds(room)) {
  var _a;
  const eventLog = getRoomEventLog(room);
  if (!eventLog) {
    return {};
  }
  const harvestEvent = getGlobalNumber5("EVENT_HARVEST");
  const transferEvent = getGlobalNumber5("EVENT_TRANSFER");
  const buildEvent = getGlobalNumber5("EVENT_BUILD");
  const repairEvent = getGlobalNumber5("EVENT_REPAIR");
  const upgradeControllerEvent = getGlobalNumber5("EVENT_UPGRADE_CONTROLLER");
  const attackEvent = getGlobalNumber5("EVENT_ATTACK");
  const objectDestroyedEvent = getGlobalNumber5("EVENT_OBJECT_DESTROYED");
  const resourceEvents = {
    harvestedEnergy: 0,
    transferredEnergy: 0,
    builtProgress: 0,
    repairedHits: 0,
    upgradedControllerProgress: 0
  };
  const combatEvents = {
    attackCount: 0,
    attackDamage: 0,
    objectDestroyedCount: 0,
    creepDestroyedCount: 0
  };
  const refillTransfers = [];
  let hasResourceEvents = false;
  let hasCombatEvents = false;
  for (const entry of eventLog) {
    if (!isRecord13(entry) || typeof entry.event !== "number") {
      continue;
    }
    const data = isRecord13(entry.data) ? entry.data : {};
    if (entry.event === harvestEvent && isEnergyEventData(data)) {
      resourceEvents.harvestedEnergy += getNumericEventData(data, "amount");
      hasResourceEvents = true;
    }
    if (entry.event === transferEvent && isEnergyEventData(data)) {
      const amount = getNumericEventData(data, "amount");
      resourceEvents.transferredEnergy += amount;
      const targetId = getEventTargetId(data);
      if (targetId && refillTargetIds.has(targetId)) {
        resourceEvents.refillEnergyDelivered = ((_a = resourceEvents.refillEnergyDelivered) != null ? _a : 0) + amount;
        refillTransfers.push({
          ...buildEventObjectId(entry),
          targetId,
          amount
        });
      }
      hasResourceEvents = true;
    }
    if (entry.event === buildEvent) {
      resourceEvents.builtProgress += getNumericEventData(data, "amount");
      hasResourceEvents = true;
    }
    if (entry.event === repairEvent) {
      resourceEvents.repairedHits += getNumericEventData(data, "amount");
      hasResourceEvents = true;
    }
    if (entry.event === upgradeControllerEvent) {
      resourceEvents.upgradedControllerProgress += getNumericEventData(data, "amount");
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
    ...hasCombatEvents ? { combat: combatEvents } : {},
    ...refillTransfers.length > 0 ? { refillTransfers } : {}
  };
}
function getSpawnExtensionEnergyStructureIds(room) {
  var _a, _b;
  const structures = (_b = (_a = findRoomObjects8(room, "FIND_MY_STRUCTURES")) != null ? _a : findRoomObjects8(room, "FIND_STRUCTURES")) != null ? _b : [];
  const ids = /* @__PURE__ */ new Set();
  for (const structure of structures) {
    if (!isSpawnExtensionEnergyStructure2(structure)) {
      continue;
    }
    const id = getObjectId2(structure);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}
function isSpawnExtensionEnergyStructure2(structure) {
  return isRecord13(structure) && (matchesStructureType8(structure.structureType, "STRUCTURE_SPAWN", "spawn") || matchesStructureType8(structure.structureType, "STRUCTURE_EXTENSION", "extension"));
}
function getEventTargetId(data) {
  return typeof data.targetId === "string" && data.targetId.length > 0 ? data.targetId : null;
}
function buildEventObjectId(entry) {
  return typeof entry.objectId === "string" && entry.objectId.length > 0 ? { objectId: entry.objectId } : {};
}
function getObjectId2(value) {
  return isRecord13(value) && typeof value.id === "string" && value.id.length > 0 ? value.id : null;
}
function findRoomObjects8(room, constantName) {
  const findConstant = getGlobalNumber5(constantName);
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
  if (!isRecord13(object) || !isRecord13(object.store)) {
    return 0;
  }
  const getUsedCapacity = object.store.getUsedCapacity;
  if (typeof getUsedCapacity === "function") {
    const usedCapacity = getUsedCapacity.call(object.store, getEnergyResource5());
    return typeof usedCapacity === "number" ? usedCapacity : 0;
  }
  const storedEnergy = object.store[getEnergyResource5()];
  return typeof storedEnergy === "number" ? storedEnergy : 0;
}
function getEnergyCapacityInStore(object) {
  if (!isRecord13(object) || !isRecord13(object.store)) {
    return 0;
  }
  const getCapacity = object.store.getCapacity;
  if (typeof getCapacity === "function") {
    const capacity2 = getCapacity.call(object.store, getEnergyResource5());
    return typeof capacity2 === "number" && Number.isFinite(capacity2) ? Math.max(0, capacity2) : 0;
  }
  const getFreeCapacity = object.store.getFreeCapacity;
  if (typeof getFreeCapacity === "function") {
    const freeCapacity = getFreeCapacity.call(object.store, getEnergyResource5());
    if (typeof freeCapacity === "number" && Number.isFinite(freeCapacity)) {
      return Math.max(0, getEnergyInStore(object) + freeCapacity);
    }
  }
  const capacity = object.store.capacity;
  return typeof capacity === "number" && Number.isFinite(capacity) ? Math.max(0, capacity) : 0;
}
function sumDroppedEnergy2(droppedResources) {
  const energyResource = getEnergyResource5();
  return droppedResources.reduce((total, droppedResource) => {
    if (!isRecord13(droppedResource) || droppedResource.resourceType !== energyResource) {
      return total;
    }
    return total + (typeof droppedResource.amount === "number" ? droppedResource.amount : 0);
  }, 0);
}
function isEnergyEventData(data) {
  return data.resourceType === void 0 || data.resourceType === getEnergyResource5();
}
function getNumericEventData(data, key) {
  const value = data[key];
  return typeof value === "number" ? value : 0;
}
function getGlobalNumber5(name) {
  const value = globalThis[name];
  return typeof value === "number" ? value : void 0;
}
function matchesStructureType8(value, globalName, fallback) {
  var _a;
  const expectedValue = (_a = globalThis[globalName]) != null ? _a : fallback;
  return value === expectedValue;
}
function getFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function getEnergyResource5() {
  const value = globalThis.RESOURCE_ENERGY;
  return typeof value === "string" ? value : "energy";
}
function isRecord13(value) {
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
function getGameTime10() {
  return typeof Game.time === "number" ? Game.time : 0;
}

// src/economy/sourceWorkload.ts
var HARVEST_ENERGY_PER_WORK_PART2 = 2;
var DEFAULT_SOURCE_ENERGY_CAPACITY2 = 3e3;
var DEFAULT_SOURCE_ENERGY_REGEN_TICKS2 = 300;
var DEFAULT_TERRAIN_WALL_MASK6 = 1;
function recordSourceWorkloads(room, creeps, tick) {
  var _a, _b, _c;
  const memory = globalThis.Memory;
  const roomName = getRoomName3(room);
  if (!memory || !roomName) {
    return;
  }
  const sources = findSources2(room);
  if (sources.length === 0) {
    return;
  }
  (_a = memory.economy) != null ? _a : memory.economy = {};
  (_c = (_b = memory.economy).sourceWorkloads) != null ? _c : _b.sourceWorkloads = {};
  memory.economy.sourceWorkloads[roomName] = {
    updatedAt: tick,
    sources: Object.fromEntries(
      buildSourceWorkloadRecords(room, sources, creeps).map((record) => [record.sourceId, record])
    )
  };
}
function buildSourceWorkloadRecords(room, sources = findSources2(room), creeps = getGameCreeps4()) {
  const roomName = getRoomName3(room);
  const assignmentLoads = getSourceAssignmentLoads(roomName, sources, creeps);
  return sources.filter((source) => hasSourcePositionInRoom(source, room)).sort((left, right) => String(left.id).localeCompare(String(right.id))).map((source) => {
    var _a;
    const sourceEnergyCapacity = getSourceEnergyCapacity(source);
    const sourceEnergyRegenTicks = getSourceEnergyRegenTicks2();
    const assignmentLoad = (_a = assignmentLoads.get(String(source.id))) != null ? _a : createEmptySourceAssignmentLoad();
    const sourceContainer = findSourceContainer(room, source);
    return {
      sourceId: String(source.id),
      assignedHarvesters: assignmentLoad.assignedHarvesters,
      assignedWorkParts: assignmentLoad.assignedWorkParts,
      openPositions: getSourceOpenPositionCount(source),
      harvestWorkCapacity: Math.max(
        1,
        Math.ceil(sourceEnergyCapacity / sourceEnergyRegenTicks / HARVEST_ENERGY_PER_WORK_PART2)
      ),
      harvestEnergyPerTick: assignmentLoad.assignedWorkParts * HARVEST_ENERGY_PER_WORK_PART2,
      regenEnergyPerTick: sourceEnergyCapacity / sourceEnergyRegenTicks,
      sourceEnergyCapacity,
      sourceEnergyRegenTicks,
      hasContainer: sourceContainer !== null,
      ...sourceContainer ? { containerId: String(sourceContainer.id) } : {}
    };
  });
}
function getSourceAssignmentLoads(roomName, sources, creeps) {
  var _a, _b, _c, _d;
  const assignmentLoads = /* @__PURE__ */ new Map();
  for (const source of sources) {
    assignmentLoads.set(String(source.id), createEmptySourceAssignmentLoad());
  }
  if (!roomName) {
    return assignmentLoads;
  }
  const sourceIds = new Set(sources.map((source) => String(source.id)));
  for (const creep of creeps) {
    const task = (_a = creep.memory) == null ? void 0 : _a.task;
    const targetId = typeof (task == null ? void 0 : task.targetId) === "string" ? task.targetId : void 0;
    if (((_b = creep.memory) == null ? void 0 : _b.role) !== "worker" || ((_c = creep.room) == null ? void 0 : _c.name) !== roomName || (task == null ? void 0 : task.type) !== "harvest" || !targetId || !sourceIds.has(targetId)) {
      continue;
    }
    const currentLoad = (_d = assignmentLoads.get(targetId)) != null ? _d : createEmptySourceAssignmentLoad();
    assignmentLoads.set(targetId, {
      assignedHarvesters: currentLoad.assignedHarvesters + 1,
      assignedWorkParts: currentLoad.assignedWorkParts + getActiveWorkParts2(creep)
    });
  }
  return assignmentLoads;
}
function createEmptySourceAssignmentLoad() {
  return { assignedHarvesters: 0, assignedWorkParts: 0 };
}
function findSources2(room) {
  if (typeof FIND_SOURCES !== "number" || typeof room.find !== "function") {
    return [];
  }
  return room.find(FIND_SOURCES);
}
function hasSourcePositionInRoom(source, room) {
  const position = getRoomObjectPosition(source);
  return position === null || isSameRoomPosition2(position, room.name);
}
function getSourceOpenPositionCount(source) {
  const position = getRoomObjectPosition(source);
  if (!position) {
    return 1;
  }
  const terrain = getRoomTerrain6(position.roomName);
  if (!terrain) {
    return 1;
  }
  let openPositions = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const x = position.x + dx;
      const y = position.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) {
        continue;
      }
      if ((terrain.get(x, y) & getTerrainWallMask6()) === 0) {
        openPositions += 1;
      }
    }
  }
  return Math.max(1, openPositions);
}
function getRoomTerrain6(roomName) {
  var _a;
  if (!roomName) {
    return null;
  }
  const map = (_a = globalThis.Game) == null ? void 0 : _a.map;
  return typeof (map == null ? void 0 : map.getRoomTerrain) === "function" ? map.getRoomTerrain(roomName) : null;
}
function getTerrainWallMask6() {
  const terrainWallMask = globalThis.TERRAIN_MASK_WALL;
  return typeof terrainWallMask === "number" ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK6;
}
function getSourceEnergyCapacity(source) {
  const sourceEnergyCapacity = source.energyCapacity;
  if (typeof sourceEnergyCapacity === "number" && Number.isFinite(sourceEnergyCapacity) && sourceEnergyCapacity > 0) {
    return sourceEnergyCapacity;
  }
  const defaultSourceEnergyCapacity = globalThis.SOURCE_ENERGY_CAPACITY;
  return typeof defaultSourceEnergyCapacity === "number" && Number.isFinite(defaultSourceEnergyCapacity) && defaultSourceEnergyCapacity > 0 ? defaultSourceEnergyCapacity : DEFAULT_SOURCE_ENERGY_CAPACITY2;
}
function getSourceEnergyRegenTicks2() {
  const regenTicks = globalThis.ENERGY_REGEN_TIME;
  return typeof regenTicks === "number" && Number.isFinite(regenTicks) && regenTicks > 0 ? regenTicks : DEFAULT_SOURCE_ENERGY_REGEN_TICKS2;
}
function getActiveWorkParts2(creep) {
  var _a;
  const workPart = getBodyPartConstant4("WORK", "work");
  const activeWorkParts = (_a = creep.getActiveBodyparts) == null ? void 0 : _a.call(creep, workPart);
  if (typeof activeWorkParts === "number" && Number.isFinite(activeWorkParts)) {
    return Math.max(0, Math.floor(activeWorkParts));
  }
  const bodyWorkParts = Array.isArray(creep.body) ? creep.body.filter((part) => isActiveBodyPart4(part, workPart)).length : 0;
  return bodyWorkParts > 0 ? bodyWorkParts : 1;
}
function isActiveBodyPart4(part, bodyPartType) {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const bodyPart = part;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === "number" && bodyPart.hits > 0;
}
function getBodyPartConstant4(globalName, fallback) {
  var _a;
  const constants = globalThis;
  return (_a = constants[globalName]) != null ? _a : fallback;
}
function getGameCreeps4() {
  var _a;
  const creeps = (_a = globalThis.Game) == null ? void 0 : _a.creeps;
  return creeps ? Object.values(creeps) : [];
}
function getRoomName3(room) {
  return typeof room.name === "string" && room.name.length > 0 ? room.name : null;
}

// src/territory/claimExecutor.ts
var AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR = "autonomousExpansionClaim";
var OK_CODE5 = 0;
var ERR_NOT_IN_RANGE_CODE5 = -9;
var ERR_INVALID_TARGET_CODE2 = -7;
var ERR_NO_BODYPART_CODE = -12;
var ERR_GCL_NOT_ENOUGH_CODE = -15;
function refreshAutonomousExpansionClaimIntent(colony, report, gameTime, telemetryEvents = []) {
  const evaluation = evaluateAutonomousExpansionClaim(colony, report, gameTime);
  if (evaluation.status === "planned" && evaluation.targetRoom) {
    persistAutonomousExpansionClaimIntent(colony.room.name, evaluation, gameTime);
    recordTerritoryClaimTelemetry(telemetryEvents, {
      ...evaluation,
      phase: "intent"
    });
    return evaluation;
  }
  if (shouldPruneAutonomousExpansionClaimTargets(evaluation.reason)) {
    pruneAutonomousExpansionClaimTargets(colony.room.name);
  }
  if (evaluation.targetRoom) {
    recordTerritoryClaimTelemetry(telemetryEvents, {
      ...evaluation,
      phase: "skip"
    });
  }
  return evaluation;
}
function shouldDeferOccupationRecommendationForExpansionClaim(evaluation) {
  return evaluation.status === "planned" || evaluation.reason === "controllerCooldown";
}
function clearAutonomousExpansionClaimIntent(colony) {
  pruneAutonomousExpansionClaimTargets(colony);
}
function shouldPruneAutonomousExpansionClaimTargets(reason) {
  return reason === "noAdjacentCandidate" || reason === "hostilePresence" || reason === "controllerMissing" || reason === "controllerOwned" || reason === "controllerReserved";
}
function getVisibleOwnedRoomCount() {
  var _a;
  const rooms = (_a = globalThis.Game) == null ? void 0 : _a.rooms;
  if (!rooms) {
    return 0;
  }
  return Object.values(rooms).filter((room) => {
    var _a2;
    return ((_a2 = room == null ? void 0 : room.controller) == null ? void 0 : _a2.my) === true;
  }).length;
}
function isAutonomousExpansionClaimGclInsufficient() {
  var _a;
  const gcl = (_a = globalThis.Game) == null ? void 0 : _a.gcl;
  if (!gcl || typeof gcl.level !== "number" || gcl.level <= 0) {
    return false;
  }
  const maxClaimableRooms = gcl.level;
  if (!Number.isFinite(maxClaimableRooms)) {
    return false;
  }
  return getVisibleOwnedRoomCount() >= maxClaimableRooms;
}
function executeExpansionClaim(creep, controller, telemetryEvents = []) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  const result = typeof creep.claimController === "function" ? creep.claimController(controller) : OK_CODE5;
  const reason = getClaimResultReason(result);
  recordTerritoryClaimTelemetry(telemetryEvents, {
    colony: (_e = (_d = (_b = creep.memory.colony) != null ? _b : (_a = creep.room) == null ? void 0 : _a.name) != null ? _d : (_c = controller.room) == null ? void 0 : _c.name) != null ? _e : "unknown",
    targetRoom: (_h = (_f = creep.memory.territory) == null ? void 0 : _f.targetRoom) != null ? _h : (_g = creep.room) == null ? void 0 : _g.name,
    controllerId: controller.id,
    creepName: creep.name,
    phase: "claim",
    result,
    ...reason ? { reason } : {}
  });
  return result;
}
function isExpansionClaimControllerOnCooldown(controller) {
  return getControllerClaimCooldown(controller) > 0;
}
function recordExpansionClaimSkipTelemetry(creep, controller, reason, telemetryEvents = []) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  recordTerritoryClaimTelemetry(telemetryEvents, {
    colony: (_e = (_d = (_b = creep.memory.colony) != null ? _b : (_a = creep.room) == null ? void 0 : _a.name) != null ? _d : (_c = controller.room) == null ? void 0 : _c.name) != null ? _e : "unknown",
    targetRoom: (_h = (_f = creep.memory.territory) == null ? void 0 : _f.targetRoom) != null ? _h : (_g = creep.room) == null ? void 0 : _g.name,
    controllerId: controller.id,
    creepName: creep.name,
    phase: "skip",
    reason
  });
}
function evaluateAutonomousExpansionClaim(colony, report, gameTime) {
  const colonyName = colony.room.name;
  const candidate = selectTopScoredAdjacentCandidate(report, colonyName);
  if (!candidate) {
    return { status: "skipped", colony: colonyName, reason: "noAdjacentCandidate" };
  }
  const baseEvaluation = {
    status: "skipped",
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...candidate.controllerId ? { controllerId: candidate.controllerId } : {}
  };
  if (colony.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return { ...baseEvaluation, reason: "energyCapacityLow" };
  }
  const room = getVisibleRoom4(candidate.roomName);
  if (!room) {
    return { ...baseEvaluation, reason: "roomNotVisible" };
  }
  if (isVisibleRoomHostile(room)) {
    return { ...baseEvaluation, reason: "hostilePresence" };
  }
  const controller = room.controller;
  if (!controller) {
    return { ...baseEvaluation, reason: "controllerMissing" };
  }
  const controllerId = controller.id;
  const controllerEvaluation = {
    ...baseEvaluation,
    ...typeof controllerId === "string" ? { controllerId } : {}
  };
  if (isControllerOwned2(controller)) {
    return { ...controllerEvaluation, reason: "controllerOwned" };
  }
  if (isControllerReserved(controller, getControllerOwnerUsername6(colony.room.controller))) {
    return { ...controllerEvaluation, reason: "controllerReserved" };
  }
  if (isAutonomousExpansionClaimGclInsufficient()) {
    return { ...controllerEvaluation, reason: "gclInsufficient" };
  }
  if (isExpansionClaimControllerOnCooldown(controller)) {
    return { ...controllerEvaluation, reason: "controllerCooldown" };
  }
  if (isAutonomousClaimSuppressed(colonyName, candidate.roomName, gameTime)) {
    return { ...controllerEvaluation, reason: "suppressed" };
  }
  return {
    status: "planned",
    colony: colonyName,
    targetRoom: candidate.roomName,
    score: candidate.score,
    ...typeof controllerId === "string" ? { controllerId } : {}
  };
}
function selectTopScoredAdjacentCandidate(report, colony) {
  var _a;
  return (_a = report.candidates.find(
    (candidate) => candidate.source === "adjacent" || isExistingAutonomousExpansionClaimTarget(colony, candidate.roomName)
  )) != null ? _a : null;
}
function persistAutonomousExpansionClaimIntent(colony, evaluation, gameTime) {
  if (!evaluation.targetRoom) {
    return;
  }
  const territoryMemory = getWritableTerritoryMemoryRecord4();
  if (!territoryMemory) {
    return;
  }
  const target = {
    colony,
    roomName: evaluation.targetRoom,
    action: "claim",
    createdBy: AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR,
    ...evaluation.controllerId ? { controllerId: evaluation.controllerId } : {}
  };
  pruneOccupationRecommendationTargets(territoryMemory, colony);
  pruneAutonomousExpansionClaimTargets(colony, territoryMemory, target);
  upsertTerritoryTarget2(territoryMemory, target);
  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const existingIntent = intents.find(
    (intent) => intent.colony === colony && intent.targetRoom === target.roomName && intent.action === "claim" && intent.createdBy === AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR
  );
  upsertTerritoryIntent4(intents, {
    colony,
    targetRoom: target.roomName,
    action: "claim",
    status: (existingIntent == null ? void 0 : existingIntent.status) === "active" ? "active" : "planned",
    updatedAt: gameTime,
    createdBy: AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR,
    ...target.controllerId ? { controllerId: target.controllerId } : {}
  });
}
function upsertTerritoryTarget2(territoryMemory, target) {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }
  const existingTarget = territoryMemory.targets.find(
    (rawTarget) => isSameTarget2(rawTarget, target) && isRecord14(rawTarget) && rawTarget.createdBy === target.createdBy
  );
  if (!existingTarget) {
    territoryMemory.targets.push(target);
    return;
  }
  if (isRecord14(existingTarget)) {
    existingTarget.action = target.action;
    existingTarget.createdBy = target.createdBy;
    existingTarget.enabled = target.enabled;
    if (target.controllerId) {
      existingTarget.controllerId = target.controllerId;
    }
  }
}
function upsertTerritoryIntent4(intents, nextIntent) {
  const existingIndex = intents.findIndex(
    (intent) => intent.colony === nextIntent.colony && intent.targetRoom === nextIntent.targetRoom && intent.action === nextIntent.action && intent.createdBy === nextIntent.createdBy
  );
  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }
  intents.push(nextIntent);
}
function pruneAutonomousExpansionClaimTargets(colony, territoryMemory = getTerritoryMemoryRecord5(), activeTarget) {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return;
  }
  const removedTargetKeys = /* @__PURE__ */ new Set();
  territoryMemory.targets = territoryMemory.targets.filter((target) => {
    if (!isAutonomousExpansionClaimTarget(target, colony)) {
      return true;
    }
    if (activeTarget && isSameTarget2(target, activeTarget)) {
      return true;
    }
    if (isRecord14(target) && isNonEmptyString13(target.roomName) && target.action === "claim") {
      removedTargetKeys.add(getTargetKey2(target.roomName, "claim"));
    }
    return false;
  });
  if (removedTargetKeys.size === 0) {
    return;
  }
  territoryMemory.intents = normalizeTerritoryIntents(territoryMemory.intents).filter(
    (intent) => intent.colony !== colony || intent.createdBy !== AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR || !removedTargetKeys.has(getTargetKey2(intent.targetRoom, intent.action))
  );
}
function pruneOccupationRecommendationTargets(territoryMemory, colony) {
  if (!Array.isArray(territoryMemory.targets)) {
    return;
  }
  territoryMemory.targets = territoryMemory.targets.filter(
    (target) => !(isRecord14(target) && target.colony === colony && target.createdBy === "occupationRecommendation")
  );
}
function isAutonomousClaimSuppressed(colony, targetRoom, gameTime) {
  var _a;
  const intents = normalizeTerritoryIntents((_a = getTerritoryMemoryRecord5()) == null ? void 0 : _a.intents);
  return intents.some(
    (intent) => intent.colony === colony && intent.targetRoom === targetRoom && intent.action === "claim" && intent.status === "suppressed" && gameTime >= intent.updatedAt && gameTime - intent.updatedAt < TERRITORY_SUPPRESSION_RETRY_TICKS2
  );
}
function recordTerritoryClaimTelemetry(telemetryEvents, event) {
  telemetryEvents.push({
    type: "territoryClaim",
    roomName: event.colony,
    colony: event.colony,
    phase: event.phase,
    ...event.targetRoom ? { targetRoom: event.targetRoom } : {},
    ...event.controllerId ? { controllerId: event.controllerId } : {},
    ...event.creepName ? { creepName: event.creepName } : {},
    ...event.result !== void 0 ? { result: event.result } : {},
    ...event.reason ? { reason: event.reason } : {},
    ...event.score !== void 0 ? { score: event.score } : {}
  });
}
function getClaimResultReason(result) {
  switch (result) {
    case OK_CODE5:
      return null;
    case ERR_NOT_IN_RANGE_CODE5:
      return "notInRange";
    case ERR_INVALID_TARGET_CODE2:
      return "invalidTarget";
    case ERR_NO_BODYPART_CODE:
      return "missingClaimPart";
    case ERR_GCL_NOT_ENOUGH_CODE:
      return "gclUnavailable";
    default:
      return "claimFailed";
  }
}
function getControllerClaimCooldown(controller) {
  const upgradeBlocked = controller.upgradeBlocked;
  return typeof upgradeBlocked === "number" && upgradeBlocked > 0 ? upgradeBlocked : 0;
}
function isAutonomousExpansionClaimTarget(target, colony) {
  return isRecord14(target) && target.colony === colony && target.action === "claim" && target.createdBy === AUTONOMOUS_EXPANSION_CLAIM_TARGET_CREATOR;
}
function isExistingAutonomousExpansionClaimTarget(colony, roomName) {
  var _a;
  const targets = (_a = getTerritoryMemoryRecord5()) == null ? void 0 : _a.targets;
  return Array.isArray(targets) ? targets.some(
    (target) => isAutonomousExpansionClaimTarget(target, colony) && isRecord14(target) && target.roomName === roomName
  ) : false;
}
function isSameTarget2(left, right) {
  return isRecord14(left) && left.colony === right.colony && left.roomName === right.roomName && left.action === right.action;
}
function getTargetKey2(roomName, action) {
  return `${roomName}:${action}`;
}
function getVisibleRoom4(roomName) {
  var _a, _b;
  return (_b = (_a = globalThis.Game) == null ? void 0 : _a.rooms) == null ? void 0 : _b[roomName];
}
function getTerritoryMemoryRecord5() {
  var _a;
  return (_a = globalThis.Memory) == null ? void 0 : _a.territory;
}
function getWritableTerritoryMemoryRecord4() {
  const memory = globalThis.Memory;
  if (!memory) {
    return null;
  }
  if (!memory.territory) {
    memory.territory = {};
  }
  return memory.territory;
}
function isVisibleRoomHostile(room) {
  return findVisibleHostileCreeps2(room).length > 0 || findVisibleHostileStructures2(room).length > 0;
}
function findVisibleHostileCreeps2(room) {
  return typeof FIND_HOSTILE_CREEPS === "number" && typeof room.find === "function" ? room.find(FIND_HOSTILE_CREEPS) : [];
}
function findVisibleHostileStructures2(room) {
  return typeof FIND_HOSTILE_STRUCTURES === "number" && typeof room.find === "function" ? room.find(FIND_HOSTILE_STRUCTURES) : [];
}
function isControllerOwned2(controller) {
  return controller.my === true || controller.owner != null;
}
function isControllerReserved(controller, colonyOwnerUsername) {
  var _a;
  const reservationUsername = (_a = controller.reservation) == null ? void 0 : _a.username;
  return isNonEmptyString13(reservationUsername) && reservationUsername !== colonyOwnerUsername;
}
function getControllerOwnerUsername6(controller) {
  var _a;
  const username = (_a = controller == null ? void 0 : controller.owner) == null ? void 0 : _a.username;
  return isNonEmptyString13(username) ? username : void 0;
}
function isRecord14(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString13(value) {
  return typeof value === "string" && value.length > 0;
}

// src/territory/territoryRunner.ts
var ERR_NOT_IN_RANGE_CODE6 = -9;
var ERR_INVALID_TARGET_CODE3 = -7;
var ERR_NO_BODYPART_CODE2 = -12;
var ERR_GCL_NOT_ENOUGH_CODE2 = -15;
var OK_CODE6 = 0;
var CLAIM_FATAL_RESULT_CODES = /* @__PURE__ */ new Set([
  ERR_INVALID_TARGET_CODE3,
  ERR_NO_BODYPART_CODE2,
  ERR_GCL_NOT_ENOUGH_CODE2
]);
var RESERVE_FATAL_RESULT_CODES = /* @__PURE__ */ new Set([ERR_INVALID_TARGET_CODE3, ERR_NO_BODYPART_CODE2]);
var PRESSURE_FATAL_RESULT_CODES = /* @__PURE__ */ new Set([ERR_NO_BODYPART_CODE2]);
function runTerritoryControllerCreep(creep, telemetryEvents = []) {
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
    if (isVisibleTerritoryAssignmentAwaitingUnsafeSigningRetry(assignment, creep)) {
      return;
    }
    suppressTerritoryAssignment(creep, assignment);
    return;
  }
  if (((_a = creep.room) == null ? void 0 : _a.name) !== assignment.targetRoom) {
    moveTowardTargetRoom(creep, assignment);
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
      const signingResult = signOccupiedControllerIfNeeded(creep, controller);
      if (signingResult === "moving" || signingResult === "blocked") {
        return;
      }
      completeTerritoryAssignment(creep);
    }
    return;
  }
  if (isTerritoryControlAction4(assignment.action) && isCreepKnownToHaveNoActiveClaimParts(creep)) {
    suppressTerritoryAssignment(creep, assignment);
    return;
  }
  if (isTerritoryControlAction4(assignment.action) && typeof creep.attackController === "function" && canCreepPressureTerritoryController(creep, controller, creep.memory.colony)) {
    const pressureResult = executeControllerAction(creep, controller, "attackController");
    if (pressureResult === ERR_NOT_IN_RANGE_CODE6 && typeof creep.moveTo === "function") {
      creep.moveTo(controller);
      return;
    }
    if (PRESSURE_FATAL_RESULT_CODES.has(pressureResult)) {
      suppressTerritoryAssignment(creep, assignment);
      return;
    }
    if (pressureResult !== ERR_INVALID_TARGET_CODE3) {
      return;
    }
  }
  if (assignment.action === "reserve" && !canCreepReserveTerritoryController(creep, controller, creep.memory.colony)) {
    return;
  }
  if (assignment.action === "claim" && isExpansionClaimControllerOnCooldown(controller)) {
    recordExpansionClaimSkipTelemetry(creep, controller, "controllerCooldown", telemetryEvents);
    if (typeof creep.moveTo === "function") {
      creep.moveTo(controller);
    }
    return;
  }
  const result = assignment.action === "claim" ? executeExpansionClaim(creep, controller, telemetryEvents) : executeControllerAction(creep, controller, "reserveController");
  if (assignment.action === "claim" && result === OK_CODE6) {
    recordPostClaimBootstrapIfOwned(creep, assignment, controller, telemetryEvents);
  }
  if (result === ERR_NOT_IN_RANGE_CODE6 && typeof creep.moveTo === "function") {
    creep.moveTo(controller);
    return;
  }
  if (assignment.action === "claim" && result === ERR_GCL_NOT_ENOUGH_CODE2 && tryFallbackClaimAssignmentToReserve(creep, assignment, controller)) {
    return;
  }
  if (assignment.action === "claim" && CLAIM_FATAL_RESULT_CODES.has(result) || assignment.action === "reserve" && RESERVE_FATAL_RESULT_CODES.has(result)) {
    suppressTerritoryAssignment(creep, assignment);
  }
}
function tryFallbackClaimAssignmentToReserve(creep, assignment, controller) {
  var _a;
  if (typeof creep.reserveController !== "function" || !canCreepReserveTerritoryController(creep, controller, creep.memory.colony)) {
    return false;
  }
  const gameTime = getGameTime11();
  const reserveAssignment = {
    targetRoom: assignment.targetRoom,
    action: "reserve",
    ...assignment.controllerId ? { controllerId: assignment.controllerId } : {},
    ...assignment.followUp ? { followUp: assignment.followUp } : {}
  };
  suppressTerritoryIntent(creep.memory.colony, assignment, gameTime);
  creep.memory.territory = (_a = recordTerritoryReserveFallbackIntent(creep.memory.colony, reserveAssignment, gameTime)) != null ? _a : reserveAssignment;
  const reserveResult = executeControllerAction(creep, controller, "reserveController");
  if (reserveResult === ERR_NOT_IN_RANGE_CODE6 && typeof creep.moveTo === "function") {
    creep.moveTo(controller);
    return true;
  }
  if (RESERVE_FATAL_RESULT_CODES.has(reserveResult)) {
    suppressTerritoryAssignment(creep, reserveAssignment);
  }
  return true;
}
function suppressTerritoryAssignment(creep, assignment) {
  suppressTerritoryIntent(creep.memory.colony, assignment, getGameTime11());
  completeTerritoryAssignment(creep);
}
function completeTerritoryAssignment(creep) {
  delete creep.memory.territory;
}
function recordPostClaimBootstrapIfOwned(creep, assignment, controller, telemetryEvents) {
  var _a, _b;
  const room = getVisibleClaimedRoom(assignment.targetRoom, controller);
  if (!((_a = room == null ? void 0 : room.controller) == null ? void 0 : _a.my)) {
    return;
  }
  recordPostClaimBootstrapClaimSuccess(
    {
      colony: (_b = creep.memory.colony) != null ? _b : room.name,
      roomName: room.name,
      controllerId: controller.id
    },
    telemetryEvents
  );
}
function getVisibleClaimedRoom(targetRoom, controller) {
  var _a, _b, _c, _d;
  const controllerRoom = controller.room;
  if (((_a = controllerRoom == null ? void 0 : controllerRoom.controller) == null ? void 0 : _a.my) === true) {
    return controllerRoom;
  }
  const gameRoom = (_c = (_b = globalThis.Game) == null ? void 0 : _b.rooms) == null ? void 0 : _c[targetRoom];
  return ((_d = gameRoom == null ? void 0 : gameRoom.controller) == null ? void 0 : _d.my) === true ? gameRoom : null;
}
function selectTargetController(creep, assignment) {
  var _a, _b;
  if (assignment.controllerId) {
    const game = globalThis.Game;
    const getObjectById3 = game == null ? void 0 : game.getObjectById;
    if (typeof getObjectById3 === "function") {
      const controller = getObjectById3.call(game, assignment.controllerId);
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
    return OK_CODE6;
  }
  return controllerAction.call(creep, controller);
}
function moveTowardTargetRoom(creep, assignment) {
  if (typeof creep.moveTo !== "function") {
    return;
  }
  const visibleController = selectVisibleTargetRoomController(assignment);
  if (visibleController) {
    creep.moveTo(visibleController);
    return;
  }
  const RoomPositionCtor = globalThis.RoomPosition;
  if (typeof RoomPositionCtor !== "function") {
    return;
  }
  creep.moveTo(new RoomPositionCtor(25, 25, assignment.targetRoom));
}
function selectVisibleTargetRoomController(assignment) {
  var _a, _b, _c;
  if (!isTerritoryControlAction4(assignment.action)) {
    return null;
  }
  const game = globalThis.Game;
  if (assignment.controllerId && typeof (game == null ? void 0 : game.getObjectById) === "function") {
    const controller = game.getObjectById.call(game, assignment.controllerId);
    if (controller) {
      return controller;
    }
  }
  return (_c = (_b = (_a = game == null ? void 0 : game.rooms) == null ? void 0 : _a[assignment.targetRoom]) == null ? void 0 : _b.controller) != null ? _c : null;
}
function getGameTime11() {
  var _a;
  const gameTime = (_a = globalThis.Game) == null ? void 0 : _a.time;
  return typeof gameTime === "number" ? gameTime : 0;
}
function isCreepKnownToHaveNoActiveClaimParts(creep) {
  var _a;
  const claimPart = getBodyPartConstant5("CLAIM", "claim");
  const activeClaimParts = (_a = creep.getActiveBodyparts) == null ? void 0 : _a.call(creep, claimPart);
  if (typeof activeClaimParts === "number") {
    return activeClaimParts <= 0;
  }
  if (!Array.isArray(creep.body)) {
    return false;
  }
  return !creep.body.some((part) => isActiveBodyPart5(part, claimPart));
}
function isActiveBodyPart5(part, bodyPartType) {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const bodyPart = part;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === "number" && bodyPart.hits > 0;
}
function getBodyPartConstant5(globalName, fallback) {
  var _a;
  const constants = globalThis;
  return (_a = constants[globalName]) != null ? _a : fallback;
}
function isTerritoryControlAction4(action) {
  return action === "claim" || action === "reserve";
}
function isTerritoryAssignment(assignment) {
  return typeof (assignment == null ? void 0 : assignment.targetRoom) === "string" && assignment.targetRoom.length > 0 && (assignment.action === "claim" || assignment.action === "reserve" || assignment.action === "scout");
}

// src/creeps/claimerRunner.ts
function runClaimer(creep, telemetryEvents = []) {
  runTerritoryControllerCreep(creep, telemetryEvents);
}

// src/economy/economyLoop.ts
var ERR_BUSY_CODE = -4;
var OK_CODE7 = 0;
var NEXT_EXPANSION_SCORING_REFRESH_INTERVAL = 50;
var NEXT_EXPANSION_SCORING_DOWNGRADE_GUARD_TICKS = 5e3;
function runEconomy(preludeTelemetryEvents = []) {
  const creeps = Object.values(Game.creeps);
  const colonies = getOwnedColonies();
  const telemetryEvents = [...preludeTelemetryEvents];
  clearColonySurvivalAssessmentCache();
  for (const colony of colonies) {
    recordSourceWorkloads(colony.room, creeps, Game.time);
    let roleCounts = countCreepsByRole(creeps, colony.room.name);
    const bootstrapResult = refreshPostClaimBootstrap(colony, roleCounts, Game.time, telemetryEvents);
    const extensionResult = bootstrapResult.spawnConstructionPending ? null : planExtensionConstruction(colony);
    if (extensionResult === null && !bootstrapResult.spawnConstructionPending) {
      const sourceContainerResult = planSourceContainerConstruction(colony);
      if (sourceContainerResult === null) {
        planEarlyRoadConstruction(colony);
      }
    }
    const survivalAssessment = assessColonySnapshotSurvival(colony, roleCounts);
    recordColonySurvivalAssessment(colony.room.name, survivalAssessment, Game.time);
    refreshExecutableTerritoryRecommendation(colony, creeps, survivalAssessment.territoryReady, telemetryEvents);
    const hasPendingTerritoryFollowUp = hasPendingTerritoryFollowUpIntent(
      colony.room.name,
      roleCounts,
      Game.time
    );
    let availableEnergy = colony.energyAvailable;
    let successfulSpawnCount = 0;
    const usedSpawns = /* @__PURE__ */ new Set();
    while (true) {
      const planningColony = createSpawnPlanningColony(colony, availableEnergy, usedSpawns);
      const spawnRequest = planSpawn(
        planningColony,
        roleCounts,
        Game.time,
        getSpawnPlanningOptions(successfulSpawnCount, hasPendingTerritoryFollowUp)
      );
      if (!spawnRequest) {
        break;
      }
      if (successfulSpawnCount > 0 && !isAllowedPostSpawnRequest(spawnRequest)) {
        break;
      }
      const outcome = attemptSpawnRequest(
        spawnRequest,
        colony.room.name,
        telemetryEvents,
        planningColony.spawns
      );
      if (!outcome || outcome.result !== OK_CODE7) {
        break;
      }
      usedSpawns.add(outcome.spawn);
      availableEnergy = Math.max(0, availableEnergy - getBodyCost(spawnRequest.body));
      successfulSpawnCount += 1;
      recordPlannedMultiRoomUpgraderSpawn(spawnRequest.memory);
      if (spawnRequest.memory.role !== "worker") {
        break;
      }
      if (spawnRequest.memory.colony !== colony.room.name) {
        continue;
      }
      roleCounts = addPlannedWorker(roleCounts);
    }
  }
  for (const creep of creeps) {
    if (creep.memory.role === "worker") {
      runWorker(creep);
    } else if (creep.memory.role === REMOTE_HARVESTER_ROLE) {
      runRemoteHarvester(creep);
    } else if (creep.memory.role === HAULER_ROLE) {
      runHauler(creep);
    } else if (creep.memory.role === TERRITORY_CLAIMER_ROLE) {
      runClaimer(creep, telemetryEvents);
    } else if (creep.memory.role === TERRITORY_SCOUT_ROLE) {
      runTerritoryControllerCreep(creep, telemetryEvents);
    }
  }
  return emitRuntimeSummary(colonies, creeps, telemetryEvents, { persistOccupationRecommendations: false });
}
function refreshExecutableTerritoryRecommendation(colony, creeps, territoryReady, telemetryEvents) {
  const colonyWorkers = creeps.filter(
    (creep) => creep.memory.role === "worker" && creep.memory.colony === colony.room.name
  );
  let report = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
  if (territoryReady) {
    const expansionSelection = refreshNextExpansionTargetSelectionIfDue(colony, Game.time);
    if (expansionSelection.status === "planned") {
      persistOccupationRecommendationFollowUpIntent(clearOccupationRecommendationFollowUpIntent(report), Game.time);
      return;
    }
    if (expansionSelection.reason === "roomLimitReached") {
      const colonyName = colony.room.name;
      clearNextExpansionTargetIntent(colonyName);
      clearAutonomousExpansionClaimIntent(colonyName);
      clearOccupationRecommendationClaimIntent(colonyName);
      report = buildRuntimeOccupationRecommendationReport(colony, colonyWorkers);
      persistOccupationRecommendationFollowUpIntent(suppressOccupationClaimRecommendation(report), Game.time);
      return;
    }
    if (expansionSelection.reason === "unmetPreconditions") {
      persistOccupationRecommendationFollowUpIntent(clearOccupationRecommendationFollowUpIntent(report), Game.time);
      return;
    }
    const claimEvaluation = refreshAutonomousExpansionClaimIntent(colony, report, Game.time, telemetryEvents);
    recordAutonomousExpansionClaimReserveFallbackIntent(colony.room.name, claimEvaluation, Game.time);
    if (shouldDeferOccupationRecommendationForExpansionClaim(claimEvaluation)) {
      return;
    }
  }
  persistOccupationRecommendationFollowUpIntent(
    territoryReady ? report : clearOccupationRecommendationFollowUpIntent(report),
    Game.time
  );
}
function refreshNextExpansionTargetSelectionIfDue(colony, gameTime) {
  const colonyName = colony.room.name;
  const colonyMemory = getWritableColonyMemory(colony);
  const stateKey = getNextExpansionSelectionCacheStateKey(colony);
  const cachedSelection = getCachedNextExpansionTargetSelection(colonyMemory, colonyName);
  if (cachedSelection && isNextExpansionTargetSelectionCacheReusable(cachedSelection, colonyName, gameTime, stateKey)) {
    return cachedSelection.selection;
  }
  const selection = refreshNextExpansionTargetSelection(
    colony,
    buildRuntimeExpansionCandidateReport(colony),
    gameTime
  );
  colonyMemory.lastExpansionScoreTime = gameTime;
  colonyMemory.cachedExpansionSelection = { ...selection, stateKey };
  return selection;
}
function getWritableColonyMemory(colony) {
  var _a, _b;
  const roomWithMemory = colony.room;
  const memory = (_b = (_a = colony.memory) != null ? _a : roomWithMemory.memory) != null ? _b : {};
  if (!colony.memory) {
    colony.memory = memory;
  }
  if (!roomWithMemory.memory) {
    roomWithMemory.memory = memory;
  }
  return memory;
}
function getCachedNextExpansionTargetSelection(colonyMemory, colonyName) {
  const refreshedAt = colonyMemory.lastExpansionScoreTime;
  const rawSelection = colonyMemory.cachedExpansionSelection;
  const selection = normalizeNextExpansionTargetSelection(rawSelection, colonyName);
  if (!isFiniteNumber7(refreshedAt) || !isRecord15(rawSelection) || !isNonEmptyString14(rawSelection.stateKey) || !selection) {
    return null;
  }
  return { refreshedAt, stateKey: rawSelection.stateKey, selection };
}
function normalizeNextExpansionTargetSelection(rawSelection, colonyName) {
  if (!isRecord15(rawSelection) || rawSelection.colony !== colonyName || rawSelection.status !== "planned" && rawSelection.status !== "skipped") {
    return null;
  }
  if (rawSelection.status === "planned") {
    if (!isNonEmptyString14(rawSelection.targetRoom)) {
      return null;
    }
    return {
      status: "planned",
      colony: colonyName,
      targetRoom: rawSelection.targetRoom,
      ...typeof rawSelection.controllerId === "string" ? { controllerId: rawSelection.controllerId } : {},
      ...isFiniteNumber7(rawSelection.score) ? { score: rawSelection.score } : {}
    };
  }
  const reason = normalizeNextExpansionTargetSelectionReason(rawSelection.reason);
  if (!reason) {
    return null;
  }
  return {
    status: "skipped",
    colony: colonyName,
    reason
  };
}
function normalizeNextExpansionTargetSelectionReason(reason) {
  return reason === "noCandidate" || reason === "roomLimitReached" || reason === "unmetPreconditions" || reason === "insufficientEvidence" || reason === "unavailable" ? reason : void 0;
}
function isNextExpansionTargetSelectionCacheReusable(cachedSelection, colony, gameTime, stateKey) {
  if (cachedSelection.stateKey !== stateKey || gameTime < cachedSelection.refreshedAt || gameTime - cachedSelection.refreshedAt >= NEXT_EXPANSION_SCORING_REFRESH_INTERVAL) {
    return false;
  }
  return cachedSelection.selection.status !== "planned" || hasNextExpansionTarget(colony, cachedSelection.selection.targetRoom);
}
function hasNextExpansionTarget(colony, targetRoom) {
  var _a, _b;
  if (!targetRoom) {
    return false;
  }
  const targets = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.targets;
  return Array.isArray(targets) ? targets.some(
    (target) => isRecord15(target) && target.colony === colony && target.roomName === targetRoom && target.action === "claim" && target.createdBy === NEXT_EXPANSION_TARGET_CREATOR
  ) : false;
}
function getNextExpansionSelectionCacheStateKey(colony) {
  const controller = colony.room.controller;
  const controllerLevel = isFiniteNumber7(controller == null ? void 0 : controller.level) ? controller.level : "unknown";
  const downgradeState = isFiniteNumber7(controller == null ? void 0 : controller.ticksToDowngrade) && controller.ticksToDowngrade < NEXT_EXPANSION_SCORING_DOWNGRADE_GUARD_TICKS ? "guarded" : "stable";
  return [
    colony.room.name,
    colony.energyCapacityAvailable,
    controllerLevel,
    countVisibleOwnedRooms2(),
    downgradeState,
    countActivePostClaimBootstraps2()
  ].join("|");
}
function countVisibleOwnedRooms2() {
  var _a;
  const rooms = (_a = globalThis.Game) == null ? void 0 : _a.rooms;
  if (!rooms) {
    return 0;
  }
  return Object.values(rooms).filter((room) => {
    var _a2;
    return ((_a2 = room == null ? void 0 : room.controller) == null ? void 0 : _a2.my) === true;
  }).length;
}
function countActivePostClaimBootstraps2() {
  var _a, _b;
  const records = (_b = (_a = globalThis.Memory) == null ? void 0 : _a.territory) == null ? void 0 : _b.postClaimBootstraps;
  if (!isRecord15(records)) {
    return 0;
  }
  return Object.values(records).filter(
    (record) => isRecord15(record) && record.status !== "ready"
  ).length;
}
function isRecord15(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString14(value) {
  return typeof value === "string" && value.length > 0;
}
function isFiniteNumber7(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function createSpawnPlanningColony(colony, energyAvailable, usedSpawns) {
  return {
    ...colony,
    energyAvailable,
    spawns: colony.spawns.filter((spawn) => !spawn.spawning && !usedSpawns.has(spawn))
  };
}
function getSpawnPlanningOptions(successfulSpawnCount, hasPendingTerritoryFollowUp) {
  const allowTerritoryFollowUp = successfulSpawnCount > 0 || hasPendingTerritoryFollowUp;
  if (successfulSpawnCount === 0) {
    return allowTerritoryFollowUp ? { allowTerritoryFollowUp } : {};
  }
  return {
    nameSuffix: String(successfulSpawnCount + 1),
    workersOnly: true,
    allowTerritoryControllerPressure: true,
    allowTerritoryFollowUp
  };
}
function isAllowedPostSpawnRequest(spawnRequest) {
  return spawnRequest.memory.role === "worker" || isTerritoryControllerPressureSpawnRequest(spawnRequest) || isTerritoryControllerFollowUpSpawnRequest(spawnRequest);
}
function isTerritoryControllerPressureSpawnRequest(spawnRequest) {
  const territory = spawnRequest.memory.territory;
  return spawnRequest.memory.role === TERRITORY_CLAIMER_ROLE && ((territory == null ? void 0 : territory.action) === "claim" || (territory == null ? void 0 : territory.action) === "reserve") && countBodyParts(spawnRequest.body, "claim") >= TERRITORY_CONTROLLER_PRESSURE_CLAIM_PARTS;
}
function isTerritoryControllerFollowUpSpawnRequest(spawnRequest) {
  const territory = spawnRequest.memory.territory;
  return spawnRequest.memory.role === TERRITORY_CLAIMER_ROLE && ((territory == null ? void 0 : territory.action) === "claim" || (territory == null ? void 0 : territory.action) === "reserve") && (territory == null ? void 0 : territory.followUp) !== void 0;
}
function countBodyParts(body, bodyPart) {
  return body.filter((part) => part === bodyPart).length;
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
  if (spawnRequest.memory.role === "worker") {
    recordPostClaimBootstrapWorkerSpawn(
      spawnRequest.memory.colony,
      spawnRequest.spawn.name,
      spawnRequest.name,
      result,
      telemetryEvents
    );
  }
  return result;
}

// src/kernel/Kernel.ts
var MAX_FORWARDED_DEFENSE_EVENTS_PER_TICK = 5;
var DEFENSE_EVENT_FORWARDING_TTL_TICKS = RUNTIME_SUMMARY_INTERVAL;
var Kernel = class {
  constructor(dependencies = {
    initializeMemory,
    cleanupDeadCreepMemory,
    runDefense,
    runEconomy
  }) {
    this.dependencies = dependencies;
    this.lastForwardedDefenseEventTick = /* @__PURE__ */ new Map();
  }
  run() {
    this.dependencies.initializeMemory();
    this.dependencies.cleanupDeadCreepMemory();
    const defenseEvents = this.dependencies.runDefense();
    return this.dependencies.runEconomy(
      selectForwardedDefenseEvents(defenseEvents, this.lastForwardedDefenseEventTick, getGameTime12())
    );
  }
};
function selectForwardedDefenseEvents(events, lastForwardedDefenseEventTick, tick) {
  const forwardedEvents = [];
  pruneStaleForwardedDefenseEvents(lastForwardedDefenseEventTick, tick);
  const prioritizedEvents = events.map((event, index) => ({ event, index })).sort(
    (left, right) => getDefenseEventPriority(left.event) - getDefenseEventPriority(right.event) || left.index - right.index
  );
  for (const { event } of prioritizedEvents) {
    if (event.type !== "defense") {
      forwardedEvents.push(event);
    } else if (shouldForwardDefenseEvent(event, lastForwardedDefenseEventTick, tick)) {
      forwardedEvents.push(event);
    }
    if (forwardedEvents.length >= MAX_FORWARDED_DEFENSE_EVENTS_PER_TICK) {
      return forwardedEvents;
    }
  }
  return forwardedEvents;
}
function shouldForwardDefenseEvent(event, lastForwardedDefenseEventTick, tick) {
  if (event.action === "safeMode") {
    return true;
  }
  const key = getDefenseEventForwardingKey(event);
  const lastForwardedTick = lastForwardedDefenseEventTick.get(key);
  if (typeof lastForwardedTick === "number" && tick >= lastForwardedTick && tick - lastForwardedTick < RUNTIME_SUMMARY_INTERVAL) {
    return false;
  }
  lastForwardedDefenseEventTick.set(key, tick);
  return true;
}
function pruneStaleForwardedDefenseEvents(lastForwardedDefenseEventTick, tick) {
  for (const [key, lastForwardedTick] of lastForwardedDefenseEventTick) {
    if (lastForwardedTick > tick || tick - lastForwardedTick >= DEFENSE_EVENT_FORWARDING_TTL_TICKS) {
      lastForwardedDefenseEventTick.delete(key);
    }
  }
}
function getDefenseEventForwardingKey(event) {
  var _a, _b;
  return [
    event.roomName,
    event.action,
    event.reason,
    (_a = event.targetId) != null ? _a : "",
    (_b = event.result) != null ? _b : "",
    event.hostileCreepCount,
    event.hostileStructureCount,
    event.damagedCriticalStructureCount
  ].join("|");
}
function getDefenseEventPriority(event) {
  if (event.type !== "defense") {
    return 0;
  }
  switch (event.action) {
    case "safeMode":
      return 0;
    case "workerFallback":
      return 1;
    case "towerAttack":
    case "towerHeal":
    case "towerRepair":
    case "defenderAttack":
      return 2;
    case "defenderMove":
      return 3;
  }
}
function getGameTime12() {
  return typeof Game !== "undefined" && typeof Game.time === "number" ? Game.time : 0;
}

// src/strategy/strategyRegistry.ts
var STRATEGY_REGISTRY_SCHEMA_VERSION = 1;
var ISSUE_265_URL = "https://github.com/lanyusea/screeps/issues/265";
var RL_RESEARCH_PATH = "docs/research/2026-04-29-screeps-rl-self-evolving-strategy-paper.md";
var DEFAULT_STRATEGY_REGISTRY = [
  {
    id: "construction-priority.incumbent.v1",
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: "1.0.0",
    family: "construction-priority",
    title: "Current construction priority scoring shadow baseline",
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ["runtime-summary"],
      shards: ["shardX"],
      rooms: ["E26S49"],
      minRcl: 1,
      maxRcl: 4,
      notes: "Reads emitted constructionPriority candidate summaries; does not alter construction selection."
    },
    knobBounds: [
      numberKnob("baseScoreWeight", "Weight applied to the already-emitted incumbent score.", 0, 3, 0.1),
      numberKnob("territorySignalWeight", "Weight for territory-first expected KPI signals.", 0, 30, 1),
      numberKnob("resourceSignalWeight", "Weight for resource-scaling expected KPI signals.", 0, 30, 1),
      numberKnob("killSignalWeight", "Weight for enemy-kill or defense-posture signals.", 0, 30, 1),
      numberKnob("riskPenalty", "Penalty per visible risk or blocking precondition.", 0, 30, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 6,
      resourceSignalWeight: 4,
      killSignalWeight: 6,
      riskPenalty: 4
    },
    rolloutStatus: "incumbent",
    evidenceLinks: [
      { label: "Issue #265", source: "issue", url: ISSUE_265_URL },
      { label: "RL/self-evolving strategy paper", source: "docs", path: RL_RESEARCH_PATH }
    ],
    rollback: passiveRollback("construction-priority.incumbent.v1")
  },
  {
    id: "construction-priority.territory-shadow.v1",
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: "1.0.0",
    family: "construction-priority",
    title: "Territory-first construction priority shadow candidate",
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ["runtime-summary"],
      shards: ["shardX"],
      rooms: ["E26S49"],
      minRcl: 1,
      maxRcl: 4,
      notes: "Replays only saved constructionPriority candidates with a higher territory signal weight."
    },
    knobBounds: [
      numberKnob("baseScoreWeight", "Weight applied to the already-emitted incumbent score.", 0, 3, 0.1),
      numberKnob("territorySignalWeight", "Weight for territory-first expected KPI signals.", 0, 30, 1),
      numberKnob("resourceSignalWeight", "Weight for resource-scaling expected KPI signals.", 0, 30, 1),
      numberKnob("killSignalWeight", "Weight for enemy-kill or defense-posture signals.", 0, 30, 1),
      numberKnob("riskPenalty", "Penalty per visible risk or blocking precondition.", 0, 30, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 22,
      resourceSignalWeight: 3,
      killSignalWeight: 5,
      riskPenalty: 4
    },
    rolloutStatus: "shadow",
    evidenceLinks: [
      { label: "Issue #265", source: "issue", url: ISSUE_265_URL },
      { label: "Fixture replay coverage", source: "test", path: "prod/test/strategyShadowEvaluator.test.ts" }
    ],
    rollback: passiveRollback("construction-priority.incumbent.v1")
  },
  {
    id: "expansion-remote.incumbent.v1",
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: "1.0.0",
    family: "expansion-remote-candidate",
    title: "Current expansion and remote candidate scoring shadow baseline",
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ["runtime-summary", "room-snapshot"],
      shards: ["shardX"],
      rooms: ["E26S49"],
      minRcl: 1,
      notes: "Reads territoryRecommendation candidates from saved summaries; it never writes Memory intents."
    },
    knobBounds: [
      numberKnob("baseScoreWeight", "Weight applied to the emitted occupation score.", 0, 3, 0.1),
      numberKnob("territorySignalWeight", "Weight for occupy/reserve/scout territory ordering.", 0, 40, 1),
      numberKnob("resourceSignalWeight", "Weight for visible source and support evidence.", 0, 30, 1),
      numberKnob("killSignalWeight", "Weight for hostile suppression opportunity.", 0, 30, 1),
      numberKnob("riskPenalty", "Penalty for hostile, route, or evidence risk.", 0, 40, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 8,
      resourceSignalWeight: 5,
      killSignalWeight: 2,
      riskPenalty: 10
    },
    rolloutStatus: "incumbent",
    evidenceLinks: [
      { label: "Issue #265", source: "issue", url: ISSUE_265_URL },
      { label: "Gameplay evolution roadmap", source: "docs", path: "docs/ops/gameplay-evolution-roadmap.md" }
    ],
    rollback: passiveRollback("expansion-remote.incumbent.v1")
  },
  {
    id: "expansion-remote.territory-shadow.v1",
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: "1.0.0",
    family: "expansion-remote-candidate",
    title: "Territory-first expansion and remote candidate shadow model",
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ["runtime-summary", "room-snapshot"],
      shards: ["shardX"],
      rooms: ["E26S49"],
      minRcl: 1,
      notes: "Emphasizes occupy/reserve candidates in offline ranking reports only."
    },
    knobBounds: [
      numberKnob("baseScoreWeight", "Weight applied to the emitted occupation score.", 0, 3, 0.1),
      numberKnob("territorySignalWeight", "Weight for occupy/reserve/scout territory ordering.", 0, 40, 1),
      numberKnob("resourceSignalWeight", "Weight for visible source and support evidence.", 0, 30, 1),
      numberKnob("killSignalWeight", "Weight for hostile suppression opportunity.", 0, 30, 1),
      numberKnob("riskPenalty", "Penalty for hostile, route, or evidence risk.", 0, 40, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 26,
      resourceSignalWeight: 4,
      killSignalWeight: 2,
      riskPenalty: 10
    },
    rolloutStatus: "shadow",
    evidenceLinks: [
      { label: "Issue #265", source: "issue", url: ISSUE_265_URL },
      { label: "Fixture replay coverage", source: "test", path: "prod/test/strategyShadowEvaluator.test.ts" }
    ],
    rollback: passiveRollback("expansion-remote.incumbent.v1")
  },
  {
    id: "defense-repair.incumbent.v1",
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: "1.0.0",
    family: "defense-posture-repair-threshold",
    title: "Current defense posture and repair threshold shadow baseline",
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ["runtime-summary", "room-snapshot"],
      shards: ["shardX"],
      rooms: ["E26S49"],
      minRcl: 1,
      notes: "Ranks observed rooms by hostile and repair pressure from saved artifacts only."
    },
    knobBounds: [
      numberKnob("baseScoreWeight", "Weight applied to observed hostile and damage pressure.", 0, 3, 0.1),
      numberKnob("territorySignalWeight", "Weight for controller survival and held-room protection.", 0, 30, 1),
      numberKnob("resourceSignalWeight", "Weight for storage and productive-structure protection.", 0, 30, 1),
      numberKnob("killSignalWeight", "Weight for hostile presence and tower/rampart readiness.", 0, 40, 1),
      numberKnob("riskPenalty", "Penalty for unavailable or insufficient observations.", 0, 30, 1),
      numberKnob("repairCriticalHitsRatio", "Critical repair hit ratio threshold.", 0.01, 1, 0.01)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 12,
      resourceSignalWeight: 6,
      killSignalWeight: 18,
      riskPenalty: 4,
      repairCriticalHitsRatio: 0.5
    },
    rolloutStatus: "incumbent",
    evidenceLinks: [
      { label: "Issue #265", source: "issue", url: ISSUE_265_URL },
      { label: "Runtime room monitor runbook", source: "docs", path: "docs/ops/runtime-room-monitor.md" }
    ],
    rollback: passiveRollback("defense-repair.incumbent.v1")
  }
];
function validateStrategyRegistryEntry(entry) {
  const issues = [];
  if (entry.schemaVersion !== STRATEGY_REGISTRY_SCHEMA_VERSION) {
    issues.push(`unsupported schemaVersion ${entry.schemaVersion}`);
  }
  if (!entry.id) {
    issues.push("missing strategy id");
  }
  if (!entry.version) {
    issues.push("missing strategy version");
  }
  if (!entry.owner.issue || entry.owner.issue <= 0) {
    issues.push("missing owning issue");
  }
  if (entry.supportedContext.artifactTypes.length === 0) {
    issues.push("supported context must name at least one artifact type");
  }
  if (entry.knobBounds.length === 0) {
    issues.push("strategy must declare bounded knobs");
  }
  const declaredKnobs = /* @__PURE__ */ new Set();
  for (const knob of entry.knobBounds) {
    if (declaredKnobs.has(knob.name)) {
      issues.push(`duplicate knob ${knob.name}`);
    }
    declaredKnobs.add(knob.name);
    if (!(knob.name in entry.defaultValues)) {
      issues.push(`missing default for knob ${knob.name}`);
      continue;
    }
    const defaultValue = entry.defaultValues[knob.name];
    if (!isKnobDefaultWithinBounds(defaultValue, knob.bounds)) {
      issues.push(`default for knob ${knob.name} is outside declared bounds`);
    }
  }
  for (const defaultName of Object.keys(entry.defaultValues)) {
    if (!declaredKnobs.has(defaultName)) {
      issues.push(`default declared without knob bounds: ${defaultName}`);
    }
  }
  if (entry.evidenceLinks.length === 0) {
    issues.push("missing evidence links");
  }
  if (!entry.rollback.disableFlag) {
    issues.push("missing rollback disable flag");
  }
  if (entry.rollback.stopConditions.length === 0) {
    issues.push("missing rollback stop conditions");
  }
  return { valid: issues.length === 0, issues };
}
function validateStrategyRegistry(entries) {
  const issues = [];
  const ids = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      issues.push(`duplicate strategy id ${entry.id}`);
    }
    ids.add(entry.id);
    const entryResult = validateStrategyRegistryEntry(entry);
    issues.push(...entryResult.issues.map((issue) => `${entry.id}: ${issue}`));
  }
  return { valid: issues.length === 0, issues };
}
function getStrategyNumberDefault(entry, knobName, fallback = 0) {
  const value = entry.defaultValues[knobName];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function numberKnob(name, description, min, max, step) {
  return {
    name,
    description,
    bounds: {
      kind: "number",
      min,
      max,
      ...step !== void 0 ? { step } : {}
    }
  };
}
function passiveRollback(rollbackToStrategyId) {
  return {
    disabledByDefault: true,
    disableFlag: "strategyShadowEvaluator.enabled=false",
    rollbackToStrategyId,
    stopConditions: [
      "shadow report is noisy or expensive",
      "artifact parsing cannot be proven deterministic",
      "any candidate output is accidentally wired into live Screeps actions"
    ],
    notes: "The first slice is pure offline/shadow evaluation; disabling the evaluator leaves live behavior unchanged."
  };
}
function isKnobDefaultWithinBounds(value, bounds) {
  switch (bounds.kind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && bounds.values.includes(value);
    default:
      return false;
  }
}

// src/strategy/shadowEvaluator.ts
var DEFAULT_VARIANCE_CONFIG = {
  enabled: true,
  defaultNoiseScale: 0.1
};
var DEFAULT_INCUMBENT_STRATEGY_IDS = {
  "construction-priority": "construction-priority.incumbent.v1",
  "expansion-remote-candidate": "expansion-remote.incumbent.v1",
  "defense-posture-repair-threshold": "defense-repair.incumbent.v1"
};
var DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG = {
  enabled: false,
  incumbentStrategyIds: DEFAULT_INCUMBENT_STRATEGY_IDS,
  candidateStrategyIds: []
};
function evaluateStrategyShadowReplay(input = {}, varianceConfig = {}) {
  var _a, _b, _c;
  const registry = (_a = input.registry) != null ? _a : DEFAULT_STRATEGY_REGISTRY;
  const artifacts = parseStrategyEvaluationArtifacts((_b = input.artifacts) != null ? _b : []);
  const kpi = reduceStrategyKpis(artifacts);
  const config = normalizeShadowConfig(input.config);
  const resolvedVarianceConfig = normalizeVarianceConfig(varianceConfig);
  const evaluationTimestamp = (_c = resolvedVarianceConfig.evaluationTimestamp) != null ? _c : Date.now();
  if (!config.enabled) {
    return {
      enabled: false,
      artifactCount: artifacts.length,
      kpi,
      modelReports: [],
      disabledReason: "strategy shadow evaluator disabled",
      warnings: []
    };
  }
  const registryById = new Map(registry.map((entry) => [entry.id, entry]));
  const candidateStrategyIds = config.candidateStrategyIds.length > 0 ? config.candidateStrategyIds : registry.filter((entry) => entry.rolloutStatus === "shadow").map((entry) => entry.id);
  const warnings = [];
  const modelReports = [];
  for (const candidateStrategyId of candidateStrategyIds) {
    const candidate = registryById.get(candidateStrategyId);
    if (!candidate) {
      warnings.push(`candidate strategy not found: ${candidateStrategyId}`);
      continue;
    }
    const incumbentStrategyId = config.incumbentStrategyIds[candidate.family];
    const incumbent = incumbentStrategyId ? registryById.get(incumbentStrategyId) : void 0;
    if (!incumbentStrategyId || !incumbent) {
      warnings.push(`incumbent strategy not found for ${candidate.id}`);
      continue;
    }
    if (incumbent.family !== candidate.family) {
      warnings.push(`incumbent ${incumbent.id} does not match candidate family ${candidate.family}`);
      continue;
    }
    const evaluatedCandidate = candidate.rolloutStatus === "incumbent" ? candidate : injectStrategyVariance(candidate, { ...resolvedVarianceConfig, strategyOverrides: void 0 }, evaluationTimestamp);
    modelReports.push(evaluateModelPair(artifacts, incumbent, evaluatedCandidate));
  }
  return {
    enabled: true,
    artifactCount: artifacts.length,
    kpi,
    modelReports,
    warnings
  };
}
function injectStrategyVariance(entry, varianceConfig = {}, evaluationTimestamp) {
  var _a;
  const resolvedConfig = normalizeVarianceConfig(varianceConfig);
  const strategyConfig = resolveStrategyVarianceConfig(resolvedConfig, entry.id);
  if (entry.rolloutStatus === "incumbent" || !strategyConfig.enabled) {
    return {
      ...entry,
      defaultValues: { ...entry.defaultValues }
    };
  }
  const seedTimestamp = (_a = evaluationTimestamp != null ? evaluationTimestamp : resolvedConfig.evaluationTimestamp) != null ? _a : Date.now();
  const rng = createSeededRandom(`${entry.id}:${seedTimestamp}`);
  const defaultValues = { ...entry.defaultValues };
  const resolvedNoiseScale = clamp2(strategyConfig.defaultNoiseScale, 0, 1);
  for (const knob of entry.knobBounds) {
    if (knob.bounds.kind !== "number" && knob.bounds.kind !== "integer") {
      continue;
    }
    const defaultValue = entry.defaultValues[knob.name];
    if (typeof defaultValue !== "number" || !Number.isFinite(defaultValue)) {
      continue;
    }
    const range = knob.bounds.max - knob.bounds.min;
    const noise = (rng() * 2 - 1) * resolvedNoiseScale * range;
    let perturbed = defaultValue + noise;
    if (knob.bounds.kind === "integer") {
      perturbed = Math.round(perturbed);
    }
    defaultValues[knob.name] = clamp2(perturbed, knob.bounds.min, knob.bounds.max);
  }
  return {
    ...entry,
    defaultValues
  };
}
function normalizeShadowConfig(config) {
  var _a, _b, _c;
  return {
    enabled: (_a = config == null ? void 0 : config.enabled) != null ? _a : DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG.enabled,
    incumbentStrategyIds: {
      ...DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG.incumbentStrategyIds,
      ...(_b = config == null ? void 0 : config.incumbentStrategyIds) != null ? _b : {}
    },
    candidateStrategyIds: (_c = config == null ? void 0 : config.candidateStrategyIds) != null ? _c : DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG.candidateStrategyIds
  };
}
function normalizeVarianceConfig(config) {
  var _a, _b;
  return {
    enabled: (_a = config == null ? void 0 : config.enabled) != null ? _a : DEFAULT_VARIANCE_CONFIG.enabled,
    defaultNoiseScale: (_b = config == null ? void 0 : config.defaultNoiseScale) != null ? _b : DEFAULT_VARIANCE_CONFIG.defaultNoiseScale,
    strategyOverrides: config == null ? void 0 : config.strategyOverrides,
    evaluationTimestamp: config == null ? void 0 : config.evaluationTimestamp
  };
}
function resolveStrategyVarianceConfig(config, strategyId) {
  var _a, _b, _c;
  const override = (_a = config.strategyOverrides) == null ? void 0 : _a[strategyId];
  return {
    enabled: (_b = override == null ? void 0 : override.enabled) != null ? _b : config.enabled,
    defaultNoiseScale: clamp2((_c = override == null ? void 0 : override.defaultNoiseScale) != null ? _c : config.defaultNoiseScale, 0, 1)
  };
}
function createSeededRandom(seed) {
  const seedHash = hashString(seed);
  let state = seedHash;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 4294967296;
  };
}
function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function evaluateModelPair(artifacts, incumbent, candidate) {
  const rankingDiffs = [];
  artifacts.forEach((artifact, artifactIndex) => {
    const rankingGroups = buildRankingGroups(artifact, artifactIndex, candidate.family);
    for (const group of rankingGroups) {
      const incumbentRanking = scoreRankingItems(group.items, incumbent);
      const candidateRanking = scoreRankingItems(group.items, candidate);
      const rankingDiff = buildRankingDiff(group, incumbentRanking, candidateRanking);
      if (rankingDiff.changedTop || rankingDiff.rankChanges.length > 0) {
        rankingDiffs.push(rankingDiff);
      }
    }
  });
  return {
    incumbentStrategyId: incumbent.id,
    candidateStrategyId: candidate.id,
    family: candidate.family,
    rankingDiffs
  };
}
function buildRankingGroups(artifact, artifactIndex, family) {
  if (artifact.artifactType === "runtime-summary") {
    return buildRuntimeSummaryRankingGroups(artifact, artifactIndex, family);
  }
  return buildRoomSnapshotRankingGroups(artifact, artifactIndex, family);
}
function buildRuntimeSummaryRankingGroups(artifact, artifactIndex, family) {
  const groups = [];
  for (const room of artifact.rooms) {
    const items = buildRuntimeRoomRankingItems(room, artifactIndex, artifact.tick, family);
    if (items.length > 0) {
      groups.push({
        context: family,
        ...artifact.tick !== void 0 ? { tick: artifact.tick } : {},
        roomName: room.roomName,
        items
      });
    }
  }
  return groups;
}
function buildRoomSnapshotRankingGroups(artifact, artifactIndex, family) {
  if (family !== "defense-posture-repair-threshold") {
    return [];
  }
  const repairItems = artifact.objects.flatMap(
    (object) => buildRepairRankingItem(artifact, object, artifactIndex, artifact.tick)
  );
  if (repairItems.length === 0) {
    return [];
  }
  return [
    {
      context: family,
      ...artifact.tick !== void 0 ? { tick: artifact.tick } : {},
      ...artifact.roomName ? { roomName: artifact.roomName } : {},
      items: repairItems
    }
  ];
}
function buildRuntimeRoomRankingItems(room, artifactIndex, tick, family) {
  var _a, _b, _c, _d;
  switch (family) {
    case "construction-priority":
      return ((_b = (_a = room.constructionPriority) == null ? void 0 : _a.candidates) != null ? _b : []).map(
        (candidate) => buildConstructionRankingItem(room, candidate, artifactIndex, tick)
      );
    case "expansion-remote-candidate":
      return ((_d = (_c = room.territoryRecommendation) == null ? void 0 : _c.candidates) != null ? _d : []).map(
        (candidate) => buildTerritoryRankingItem(room, candidate, artifactIndex, tick)
      );
    case "defense-posture-repair-threshold":
      return [buildRuntimeDefenseRankingItem(room, artifactIndex, tick)];
    default:
      return [];
  }
}
function buildConstructionRankingItem(room, candidate, artifactIndex, tick) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  const text = [
    candidate.buildItem,
    ...(_a = candidate.expectedKpiMovement) != null ? _a : [],
    ...(_b = candidate.preconditions) != null ? _b : [],
    ...(_c = candidate.risk) != null ? _c : []
  ].join(" ");
  const signals = classifyStrategyText(text);
  return {
    itemId: `${room.roomName}:construction:${candidate.buildItem}`,
    label: candidate.buildItem,
    context: "construction-priority",
    artifactIndex,
    ...tick !== void 0 ? { tick } : {},
    roomName: room.roomName,
    baseScore: (_d = candidate.score) != null ? _d : 0,
    signals: {
      territory: signals.territory,
      resources: signals.resources,
      kills: signals.kills,
      reliability: signals.reliability + urgencyReliabilitySignal(candidate.urgency),
      risk: ((_f = (_e = candidate.risk) == null ? void 0 : _e.length) != null ? _f : 0) + ((_h = (_g = candidate.preconditions) == null ? void 0 : _g.length) != null ? _h : 0) * 2
    }
  };
}
function buildTerritoryRankingItem(room, candidate, artifactIndex, tick) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
  const actionTerritorySignal = candidate.action === "occupy" ? 8 : candidate.action === "reserve" ? 6 : 2;
  const hostileRisk = ((_a = candidate.hostileCreepCount) != null ? _a : 0) * 5 + ((_b = candidate.hostileStructureCount) != null ? _b : 0) * 4;
  const evidenceRisk = candidate.evidenceStatus === "unavailable" ? 12 : candidate.evidenceStatus === "insufficient-evidence" ? 5 : 0;
  return {
    itemId: `${room.roomName}:territory:${candidate.roomName}:${(_c = candidate.action) != null ? _c : "unknown"}`,
    label: `${(_d = candidate.action) != null ? _d : "score"} ${candidate.roomName}`,
    context: "expansion-remote-candidate",
    artifactIndex,
    ...tick !== void 0 ? { tick } : {},
    roomName: room.roomName,
    baseScore: (_e = candidate.score) != null ? _e : 0,
    signals: {
      territory: actionTerritorySignal + (candidate.source === "configured" ? 2 : 0),
      resources: Math.min((_f = candidate.sourceCount) != null ? _f : 0, 3) * 2,
      kills: hostileRisk > 0 ? 1 : 0,
      reliability: candidate.evidenceStatus === "sufficient" ? 1 : 0,
      risk: hostileRisk + evidenceRisk + ((_h = (_g = candidate.risks) == null ? void 0 : _g.length) != null ? _h : 0) + Math.max(0, ((_j = (_i = candidate.roadDistance) != null ? _i : candidate.routeDistance) != null ? _j : 1) - 1)
    }
  };
}
function buildRuntimeDefenseRankingItem(room, artifactIndex, tick) {
  var _a, _b, _c, _d, _e, _f, _g;
  const hostilePressure = ((_b = (_a = room.combat) == null ? void 0 : _a.hostileCreepCount) != null ? _b : 0) * 15 + ((_d = (_c = room.combat) == null ? void 0 : _c.hostileStructureCount) != null ? _d : 0) * 8;
  const downgradePressure = typeof ((_e = room.controller) == null ? void 0 : _e.ticksToDowngrade) === "number" ? Math.max(0, 5e3 - room.controller.ticksToDowngrade) / 500 : 0;
  const baseScore = hostilePressure + downgradePressure;
  return {
    itemId: `${room.roomName}:defense-posture`,
    label: `defense posture ${room.roomName}`,
    context: "defense-posture-repair-threshold",
    artifactIndex,
    ...tick !== void 0 ? { tick } : {},
    roomName: room.roomName,
    baseScore,
    signals: {
      territory: downgradePressure > 0 ? 3 : 1,
      resources: ((_g = (_f = room.resources) == null ? void 0 : _f.storedEnergy) != null ? _g : 0) > 0 ? 1 : 0,
      kills: hostilePressure > 0 ? 4 : 0,
      reliability: downgradePressure > 0 || hostilePressure > 0 ? 3 : 1,
      risk: baseScore === 0 ? 1 : 0
    }
  };
}
function buildRepairRankingItem(artifact, object, artifactIndex, tick) {
  var _a, _b, _c, _d;
  if (!isDamageableSnapshotStructure(object) || typeof object.hits !== "number" || typeof object.hitsMax !== "number") {
    return [];
  }
  const damageRatio = object.hitsMax > 0 ? Math.max(0, 1 - object.hits / object.hitsMax) : 0;
  if (damageRatio <= 0) {
    return [];
  }
  const roomName = (_a = artifact.roomName) != null ? _a : object.room;
  const criticalStructureSignal = object.type === "spawn" || object.type === "tower" || object.type === "storage" ? 3 : 1;
  return [
    {
      itemId: `${roomName != null ? roomName : "unknown"}:repair:${(_b = object.type) != null ? _b : "structure"}:${(_c = object.id) != null ? _c : "unknown"}`,
      label: `repair ${(_d = object.type) != null ? _d : "structure"}`,
      context: "defense-posture-repair-threshold",
      artifactIndex,
      ...tick !== void 0 ? { tick } : {},
      ...roomName ? { roomName } : {},
      baseScore: damageRatio * 100,
      signals: {
        territory: object.type === "spawn" || object.type === "tower" ? criticalStructureSignal : 1,
        resources: object.type === "storage" || object.type === "container" ? criticalStructureSignal : 1,
        kills: object.type === "rampart" || object.type === "tower" ? criticalStructureSignal : 0,
        reliability: criticalStructureSignal,
        risk: damageRatio >= 0.5 ? 0 : 1
      }
    }
  ];
}
function scoreRankingItems(items, entry) {
  return items.map((item) => ({
    ...item,
    strategyScore: calculateStrategyScore(item, entry),
    rank: 0
  })).sort(compareScoredRankingItems).map((item, index) => ({
    ...item,
    rank: index + 1
  }));
}
function calculateStrategyScore(item, entry) {
  const baseScoreWeight = getStrategyNumberDefault(entry, "baseScoreWeight", 1);
  const territorySignalWeight = getStrategyNumberDefault(entry, "territorySignalWeight", 0);
  const resourceSignalWeight = getStrategyNumberDefault(entry, "resourceSignalWeight", 0);
  const killSignalWeight = getStrategyNumberDefault(entry, "killSignalWeight", 0);
  const riskPenalty = getStrategyNumberDefault(entry, "riskPenalty", 0);
  return item.baseScore * baseScoreWeight + item.signals.territory * territorySignalWeight + item.signals.resources * resourceSignalWeight + item.signals.kills * killSignalWeight + item.signals.reliability * Math.max(territorySignalWeight, killSignalWeight) - item.signals.risk * riskPenalty;
}
function compareScoredRankingItems(left, right) {
  return right.strategyScore - left.strategyScore || right.baseScore - left.baseScore || left.label.localeCompare(right.label) || left.itemId.localeCompare(right.itemId);
}
function buildRankingDiff(group, incumbentRanking, candidateRanking) {
  var _a, _b;
  const incumbentTop = incumbentRanking[0] ? summarizeRankedItem(incumbentRanking[0]) : null;
  const candidateTop = candidateRanking[0] ? summarizeRankedItem(candidateRanking[0]) : null;
  const incumbentRanks = new Map(incumbentRanking.map((item) => [item.itemId, item]));
  const candidateRanks = new Map(candidateRanking.map((item) => [item.itemId, item]));
  const itemIds = Array.from(/* @__PURE__ */ new Set([...incumbentRanks.keys(), ...candidateRanks.keys()])).sort();
  const rankChanges = itemIds.flatMap((itemId) => {
    var _a2, _b2;
    const incumbentItem = incumbentRanks.get(itemId);
    const candidateItem = candidateRanks.get(itemId);
    if ((incumbentItem == null ? void 0 : incumbentItem.rank) === (candidateItem == null ? void 0 : candidateItem.rank)) {
      return [];
    }
    const label = (_b2 = (_a2 = incumbentItem == null ? void 0 : incumbentItem.label) != null ? _a2 : candidateItem == null ? void 0 : candidateItem.label) != null ? _b2 : itemId;
    const incumbentRank = incumbentItem == null ? void 0 : incumbentItem.rank;
    const candidateRank = candidateItem == null ? void 0 : candidateItem.rank;
    return [
      {
        itemId,
        label,
        ...incumbentRank !== void 0 ? { incumbentRank } : {},
        ...candidateRank !== void 0 ? { candidateRank } : {},
        ...incumbentRank !== void 0 && candidateRank !== void 0 ? { delta: incumbentRank - candidateRank } : {}
      }
    ];
  });
  return {
    artifactIndex: (_b = (_a = group.items[0]) == null ? void 0 : _a.artifactIndex) != null ? _b : 0,
    ...group.tick !== void 0 ? { tick: group.tick } : {},
    ...group.roomName ? { roomName: group.roomName } : {},
    context: group.context,
    incumbentTop,
    candidateTop,
    changedTop: (incumbentTop == null ? void 0 : incumbentTop.itemId) !== (candidateTop == null ? void 0 : candidateTop.itemId),
    rankChanges
  };
}
function summarizeRankedItem(item) {
  return {
    itemId: item.itemId,
    label: item.label,
    rank: item.rank,
    score: roundScore(item.strategyScore),
    baseScore: roundScore(item.baseScore)
  };
}
function classifyStrategyText(text) {
  const normalizedText = text.toLowerCase();
  return {
    territory: countSignalWords(normalizedText, [
      "territory",
      "remote",
      "controller",
      "rcl",
      "expansion",
      "claim",
      "reserve",
      "room"
    ]),
    resources: countSignalWords(normalizedText, [
      "energy",
      "resource",
      "resources",
      "harvest",
      "storage",
      "source",
      "throughput",
      "capacity",
      "worker"
    ]),
    kills: countSignalWords(normalizedText, ["kill", "enemy", "hostile", "tower", "rampart", "defense", "survivability"]),
    reliability: countSignalWords(normalizedText, ["spawn", "recovery", "downgrade", "repair", "safe", "survival"]),
    risk: countSignalWords(normalizedText, ["risk", "blocked", "decay", "hostile", "unavailable", "missing"])
  };
}
function urgencyReliabilitySignal(urgency) {
  switch (urgency) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "medium":
      return 1;
    default:
      return 0;
  }
}
function clamp2(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function countSignalWords(text, words) {
  return words.reduce((count, word) => count + (text.includes(word) ? 1 : 0), 0);
}
function roundScore(score) {
  return Math.round(score * 1e3) / 1e3;
}
function isDamageableSnapshotStructure(object) {
  return object.type === "constructedWall" || object.type === "container" || object.type === "extension" || object.type === "rampart" || object.type === "road" || object.type === "spawn" || object.type === "storage" || object.type === "tower";
}

// src/strategy/historicalReplayValidator.ts
var MIN_HISTORICAL_REPLAY_COUNT = 3;
var MIN_HISTORICAL_REPLAY_CORRELATION = 0.5;
var HistoricalReplayValidator = class {
  validateStrategy(strategyId, historicalReplays) {
    const scorePairs = historicalReplays.flatMap((replay) => {
      const shadowScore = getLatestFiniteScore(replay.kpiHistory[strategyId]);
      if (shadowScore === void 0 || !Number.isFinite(replay.finalScore)) {
        return [];
      }
      return [{ shadowScore, finalScore: replay.finalScore }];
    });
    const correlation = scorePairs.length >= 2 ? calculatePearsonCorrelation(
      scorePairs.map((pair) => pair.shadowScore),
      scorePairs.map((pair) => pair.finalScore)
    ) : 0;
    const pass = scorePairs.length >= MIN_HISTORICAL_REPLAY_COUNT && correlation >= MIN_HISTORICAL_REPLAY_CORRELATION;
    return {
      pass,
      correlation,
      details: buildValidationDetails(strategyId, historicalReplays.length, scorePairs.length, correlation, pass)
    };
  }
};
function loadHistoricalReplays(room) {
  var _a, _b;
  const memory = globalThis;
  const storedReplays = (_b = (_a = memory.Memory) == null ? void 0 : _a.strategyHistoricalReplays) == null ? void 0 : _b[room];
  if (!Array.isArray(storedReplays)) {
    return [];
  }
  return storedReplays.flatMap((replay) => {
    const normalizedReplay = normalizeHistoricalReplay(replay);
    return normalizedReplay ? [normalizedReplay] : [];
  });
}
function buildValidationDetails(strategyId, availableReplayCount, usableReplayCount, correlation, pass) {
  const formattedCorrelation = formatCorrelation(correlation);
  if (usableReplayCount < MIN_HISTORICAL_REPLAY_COUNT) {
    return `historical replay validation failed for ${strategyId}: ${usableReplayCount}/${availableReplayCount} usable replays, requires at least ${MIN_HISTORICAL_REPLAY_COUNT}; correlation=${formattedCorrelation}`;
  }
  if (!pass) {
    return `historical replay validation failed for ${strategyId}: correlation=${formattedCorrelation} below ${MIN_HISTORICAL_REPLAY_CORRELATION.toFixed(
      3
    )} across ${usableReplayCount}/${availableReplayCount} usable replays`;
  }
  return `historical replay validation passed for ${strategyId}: correlation=${formattedCorrelation} across ${usableReplayCount}/${availableReplayCount} usable replays`;
}
function calculatePearsonCorrelation(left, right) {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }
  const leftMean = average(left);
  const rightMean = average(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  if (leftVariance === 0 || rightVariance === 0) {
    return 0;
  }
  return clampCorrelation(covariance / Math.sqrt(leftVariance * rightVariance));
}
function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function clampCorrelation(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}
function getLatestFiniteScore(scores) {
  if (!Array.isArray(scores)) {
    return void 0;
  }
  for (let index = scores.length - 1; index >= 0; index -= 1) {
    const score = scores[index];
    if (Number.isFinite(score)) {
      return score;
    }
  }
  return void 0;
}
function normalizeHistoricalReplay(rawReplay) {
  if (!isRecord16(rawReplay)) {
    return null;
  }
  if (!isNonEmptyString15(rawReplay.replayId) || !isNonEmptyString15(rawReplay.room) || !isFiniteNumber8(rawReplay.startTick) || !isFiniteNumber8(rawReplay.endTick) || !isFiniteNumber8(rawReplay.finalScore) || !isRecord16(rawReplay.kpiHistory)) {
    return null;
  }
  const kpiHistory = Object.entries(rawReplay.kpiHistory).reduce(
    (history, [kpiName, rawScores]) => {
      if (!Array.isArray(rawScores)) {
        return history;
      }
      history[kpiName] = rawScores.filter((score) => Number.isFinite(score));
      return history;
    },
    {}
  );
  return {
    replayId: rawReplay.replayId,
    room: rawReplay.room,
    startTick: rawReplay.startTick,
    endTick: rawReplay.endTick,
    finalScore: rawReplay.finalScore,
    kpiHistory
  };
}
function formatCorrelation(correlation) {
  return correlation.toFixed(3);
}
function isRecord16(value) {
  return typeof value === "object" && value !== null;
}
function isNonEmptyString15(value) {
  return typeof value === "string" && value.length > 0;
}
function isFiniteNumber8(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// src/strategy/rlRolloutGate.ts
var RlRolloutGate = class {
  constructor(historicalReplayValidator = new HistoricalReplayValidator()) {
    this.historicalReplayValidator = historicalReplayValidator;
  }
  validateStrategyRollout(request) {
    var _a, _b;
    const prerequisiteResults = (_a = request.prerequisiteResults) != null ? _a : [];
    const historicalReplays = (_b = request.historicalReplays) != null ? _b : loadHistoricalReplays(request.room);
    const historicalReplay = this.historicalReplayValidator.validateStrategy(request.strategyId, historicalReplays);
    const failedPrerequisites = prerequisiteResults.filter((result) => !result.pass);
    const pass = failedPrerequisites.length === 0 && historicalReplay.pass;
    return {
      pass,
      correlation: historicalReplay.correlation,
      details: buildRolloutDetails(request.strategyId, historicalReplay, failedPrerequisites),
      historicalReplay,
      prerequisiteResults
    };
  }
};
function validateRlStrategyRollout(request) {
  return new RlRolloutGate().validateStrategyRollout(request);
}
function buildRolloutDetails(strategyId, historicalReplay, failedPrerequisites) {
  if (failedPrerequisites.length > 0) {
    return `RL rollout blocked for ${strategyId}: ${failedPrerequisites.length} prerequisite gate(s) failed; ${historicalReplay.details}`;
  }
  if (!historicalReplay.pass) {
    return `RL rollout blocked for ${strategyId}: ${historicalReplay.details}`;
  }
  return `RL rollout allowed for ${strategyId}: ${historicalReplay.details}`;
}

// src/main.ts
var kernel = new Kernel();
var strategyRolloutConfig = DEFAULT_KPI_ROLLOUT_MONITOR_CONFIG;
var kpiWindowMaxLength = 120;
var strategyRegistryState = {
  entries: DEFAULT_STRATEGY_REGISTRY.map((entry) => ({ ...entry }))
};
var recentKpiWindows = {};
var baselineKpiWindows = {};
function loop() {
  const summary = kernel.run();
  strategyRegistryState.entries = runStrategyRolloutMonitoring(summary, strategyRegistryState.entries);
}
function runStrategyRolloutMonitoring(summary, registry) {
  let workingRegistry = applyPendingRollbacks(registry);
  if (!summary) {
    return workingRegistry;
  }
  const families = getMonitoredFamilies(workingRegistry);
  const kpiWindow = buildKpiWindow(summary);
  for (const family of families) {
    appendWindow(recentKpiWindows, family, kpiWindow);
    ensureBaselineWindowForFamily(family);
  }
  const regressionResult = checkKpiRegression(recentKpiWindows, baselineKpiWindows, strategyRolloutConfig);
  if (regressionResult.regression) {
    for (const family of regressionResult.regressedFamilies) {
      const rollbackResult = executeRollback(family, workingRegistry, regressionResult.details);
      if (rollbackResult.disabledId && rollbackResult.rollbackToId) {
        console.log(
          `${RUNTIME_SUMMARY_PREFIX}${JSON.stringify({
            type: "rl-rollback",
            family,
            disabledId: rollbackResult.disabledId,
            rollbackToId: rollbackResult.rollbackToId,
            reason: rollbackResult.reason,
            timestamp: runtimeTick()
          })}`
        );
      }
    }
  }
  workingRegistry = applyPendingRollbacks(workingRegistry);
  return workingRegistry;
}
function getMonitoredFamilies(registry) {
  return [...new Set(registry.map((entry) => entry.family))];
}
function buildKpiWindow(summary) {
  const artifacts = parseStrategyEvaluationArtifacts(summary);
  const kpi = reduceStrategyKpis(artifacts);
  return {
    timestamp: summary.tick,
    metrics: {
      reliability: kpi.reliability.passed ? 1 : 0,
      territory: kpi.territory.score,
      resources: kpi.resources.score,
      kills: kpi.kills.score
    }
  };
}
function ensureBaselineWindowForFamily(family) {
  var _a, _b;
  const minWindowSize = Math.max(1, Math.floor(strategyRolloutConfig.minWindowSize));
  const memory = getOrCreateMemory2();
  let baselines = baselineKpiWindows[family];
  if (!baselines || baselines.length === 0) {
    const memoryBaseline = (_a = memory.kpiBaseline) == null ? void 0 : _a[family];
    if (memoryBaseline) {
      const seededWindow = buildKpiWindowFromBaseline(memoryBaseline);
      baselines = Array.from({ length: minWindowSize }, () => seededWindow);
      baselineKpiWindows[family] = baselines;
    }
  }
  const recentWindows = (_b = recentKpiWindows[family]) != null ? _b : [];
  if (!baselines || baselines.length < minWindowSize) {
    if (recentWindows.length >= minWindowSize) {
      baselines = recentWindows.slice(-minWindowSize);
      baselineKpiWindows[family] = baselines;
      persistBaseline(family, baselines);
    }
  }
  baselines = baselineKpiWindows[family];
  if (!baselines) {
    return;
  }
  baselineKpiWindows[family] = trimWindowLength(baselines, minWindowSize);
}
function buildKpiWindowFromBaseline(memoryBaseline) {
  var _a, _b, _c, _d;
  const metrics = {
    reliability: Number((_a = memoryBaseline.metrics.reliability) != null ? _a : 0),
    territory: Number((_b = memoryBaseline.metrics.territory) != null ? _b : 0),
    resources: Number((_c = memoryBaseline.metrics.resources) != null ? _c : 0),
    kills: Number((_d = memoryBaseline.metrics.kills) != null ? _d : 0)
  };
  return {
    timestamp: memoryBaseline.timestamp,
    metrics: {
      reliability: Number.isFinite(metrics.reliability) ? metrics.reliability : 0,
      territory: Number.isFinite(metrics.territory) ? metrics.territory : 0,
      resources: Number.isFinite(metrics.resources) ? metrics.resources : 0,
      kills: Number.isFinite(metrics.kills) ? metrics.kills : 0
    }
  };
}
function persistBaseline(family, windows) {
  var _a, _b, _c;
  const memory = getOrCreateMemory2();
  const averages = averageKpiWindowMetrics(windows);
  if (!averages) {
    return;
  }
  memory.kpiBaseline = {
    ...(_a = memory.kpiBaseline) != null ? _a : {},
    [family]: {
      timestamp: (_c = (_b = windows[windows.length - 1]) == null ? void 0 : _b.timestamp) != null ? _c : runtimeTick(),
      metrics: averages
    }
  };
}
function trimWindowLength(windows, maxLength) {
  const trimmed = [...windows];
  while (trimmed.length > maxLength) {
    trimmed.shift();
  }
  return trimmed;
}
function appendWindow(windows, family, window) {
  var _a;
  const familyWindows = (_a = windows[family]) != null ? _a : [];
  familyWindows.push(window);
  windows[family] = trimWindowLength(familyWindows, kpiWindowMaxLength);
}
function getOrCreateMemory2() {
  if (!globalThis.Memory) {
    globalThis.Memory = {};
  }
  return globalThis.Memory;
}
function runtimeTick() {
  var _a, _b;
  return (_b = (_a = globalThis.Game) == null ? void 0 : _a.time) != null ? _b : 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_STRATEGY_REGISTRY,
  DEFAULT_STRATEGY_SHADOW_EVALUATOR_CONFIG,
  DEFAULT_VARIANCE_CONFIG,
  HistoricalReplayValidator,
  RlRolloutGate,
  STRATEGY_REGISTRY_SCHEMA_VERSION,
  evaluateStrategyShadowReplay,
  injectStrategyVariance,
  loadHistoricalReplays,
  loop,
  validateRlStrategyRollout,
  validateStrategyRegistry,
  validateStrategyRegistryEntry
});
