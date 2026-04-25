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

// src/creeps/roleCounts.ts
function countCreepsByRole(creeps, colonyName) {
  return creeps.reduce(
    (counts, creep) => {
      if (creep.memory.colony === colonyName && creep.memory.role === "worker") {
        counts.worker += 1;
      }
      return counts;
    },
    { worker: 0 }
  );
}

// src/tasks/workerTasks.ts
function selectWorkerTask(creep) {
  var _a;
  const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
  if (carriedEnergy === 0) {
    const [source] = creep.room.find(FIND_SOURCES);
    return source ? { type: "harvest", targetId: source.id } : null;
  }
  const [energySink] = creep.room.find(FIND_MY_STRUCTURES, {
    filter: (structure) => (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) && "store" in structure && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
  });
  if (energySink) {
    return { type: "transfer", targetId: energySink.id };
  }
  const [constructionSite] = creep.room.find(FIND_CONSTRUCTION_SITES);
  if (constructionSite) {
    return { type: "build", targetId: constructionSite.id };
  }
  if ((_a = creep.room.controller) == null ? void 0 : _a.my) {
    return { type: "upgrade", targetId: creep.room.controller.id };
  }
  return null;
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
  if (task.type === "harvest") {
    return freeEnergyCapacity === 0;
  }
  return usedEnergy === 0;
}
function shouldReplaceTarget(task, target) {
  return task.type === "transfer" && "store" in target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
}
function executeTask(creep, task, target) {
  switch (task.type) {
    case "harvest":
      return creep.harvest(target);
    case "transfer":
      return creep.transfer(target, RESOURCE_ENERGY);
    case "build":
      return creep.build(target);
    case "upgrade":
      return creep.upgradeController(target);
  }
}

// src/spawn/bodyBuilder.ts
var WORKER_PATTERN = ["work", "carry", "move"];
var WORKER_PATTERN_COST = 200;
var MAX_CREEP_PARTS = 50;
function buildWorkerBody(energyAvailable) {
  if (energyAvailable < WORKER_PATTERN_COST) {
    return [];
  }
  const maxPatternCountByEnergy = Math.floor(energyAvailable / WORKER_PATTERN_COST);
  const maxPatternCountBySize = Math.floor(MAX_CREEP_PARTS / WORKER_PATTERN.length);
  const patternCount = Math.min(maxPatternCountByEnergy, maxPatternCountBySize);
  return Array.from({ length: patternCount }).flatMap(() => WORKER_PATTERN);
}

// src/spawn/spawnPlanner.ts
var TARGET_WORKERS = 3;
function planSpawn(colony, roleCounts, gameTime) {
  if (roleCounts.worker >= TARGET_WORKERS) {
    return null;
  }
  const spawn = colony.spawns.find((candidate) => !candidate.spawning);
  if (!spawn) {
    return null;
  }
  const body = buildWorkerBody(colony.energyAvailable);
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

// src/economy/economyLoop.ts
function runEconomy() {
  const creeps = Object.values(Game.creeps);
  for (const colony of getOwnedColonies()) {
    const roleCounts = countCreepsByRole(creeps, colony.room.name);
    const spawnRequest = planSpawn(colony, roleCounts, Game.time);
    if (spawnRequest) {
      spawnRequest.spawn.spawnCreep(spawnRequest.body, spawnRequest.name, {
        memory: spawnRequest.memory
      });
    }
  }
  for (const creep of creeps) {
    if (creep.memory.role === "worker") {
      runWorker(creep);
    }
  }
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
