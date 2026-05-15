import { refreshRuntimeRoomMemory } from '../config/runtimeRooms';

export const MEMORY_SCHEMA_VERSION = 1;

export function initializeMemory(): void {
  if (!Memory.meta) {
    Memory.meta = { version: MEMORY_SCHEMA_VERSION };
  }

  if (!Memory.creeps) {
    Memory.creeps = {};
  }

  refreshRuntimeRoomMemory();
}

export function cleanupDeadCreepMemory(): void {
  for (const creepName of Object.keys(Memory.creeps || {})) {
    if (!Game.creeps[creepName]) {
      delete Memory.creeps[creepName];
    }
  }
}
