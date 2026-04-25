export const MEMORY_SCHEMA_VERSION = 1;

export function initializeMemory(): void {
  if (!Memory.meta) {
    Memory.meta = { version: MEMORY_SCHEMA_VERSION };
  }

  if (!Memory.creeps) {
    Memory.creeps = {};
  }
}

export function cleanupDeadCreepMemory(): void {
  for (const creepName of Object.keys(Memory.creeps || {})) {
    if (!Game.creeps[creepName]) {
      delete Memory.creeps[creepName];
    }
  }
}
