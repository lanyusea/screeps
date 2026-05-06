import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  buildDefenseTelemetryContext,
  findOwnedStructures,
  getObjectId,
  recordDefenseAction
} from './defenseTelemetry';
import { shouldActivateSafeMode } from './defensePlanner';

export interface SafeModeRunResult {
  events: RuntimeTelemetryEvent[];
  activated: boolean;
  result?: ScreepsReturnCode;
}

export {
  CRITICAL_SPAWN_LOSS_HITS_RATIO,
  SAFE_MODE_HOSTILE_COUNT_THRESHOLD
} from './defensePlanner';

const OK_CODE = 0 as ScreepsReturnCode;

export function runSafeMode(room: Room): RuntimeTelemetryEvent[] {
  return runSafeModeWithResult(room).events;
}

export function runSafeModeWithResult(room: Room): SafeModeRunResult {
  const context = buildDefenseTelemetryContext(room);
  const events: RuntimeTelemetryEvent[] = [];
  const result: SafeModeRunResult = { events, activated: false };

  if (
    !shouldActivateSafeMode({
      controller: context.room.controller,
      hostileCreeps: context.hostileCreeps,
      ownedSpawns: getOwnedSpawns(context.room)
    })
  ) {
    return result;
  }

  const controller = context.room.controller;
  const activationResult = controller?.activateSafeMode?.();
  if (typeof activationResult !== 'number') {
    return result;
  }

  recordDefenseAction(
    {
      action: 'safeMode',
      context,
      reason: 'safeModeEarlyRoomThreat',
      result: activationResult,
      targetId: getObjectId(controller)
    },
    events
  );

  return {
    events,
    activated: activationResult === OK_CODE,
    result: activationResult
  };
}

function getOwnedSpawns(room: Room): StructureSpawn[] {
  return findOwnedStructures(room).filter(isOwnedSpawn);
}

function isOwnedSpawn(structure: AnyOwnedStructure): structure is StructureSpawn {
  const spawnType = (globalThis as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN ?? 'spawn';
  return structure.structureType === spawnType || structure.structureType === 'spawn';
}
