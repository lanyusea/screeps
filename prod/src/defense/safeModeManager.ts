import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  buildDefenseTelemetryContext,
  findOwnedStructures,
  getObjectId,
  recordDefenseAction,
  type DefenseTelemetryContext
} from './defenseTelemetry';

export interface SafeModeRunResult {
  events: RuntimeTelemetryEvent[];
  activated: boolean;
  result?: ScreepsReturnCode;
}

export const SAFE_MODE_HOSTILE_COUNT_THRESHOLD = 2;

const OK_CODE = 0 as ScreepsReturnCode;

export function runSafeMode(room: Room): RuntimeTelemetryEvent[] {
  return runSafeModeWithResult(room).events;
}

export function runSafeModeWithResult(room: Room): SafeModeRunResult {
  const context = buildDefenseTelemetryContext(room);
  const events: RuntimeTelemetryEvent[] = [];
  const result: SafeModeRunResult = { events, activated: false };

  if (!shouldActivateSafeMode(context)) {
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

function shouldActivateSafeMode(context: DefenseTelemetryContext): boolean {
  const controller = context.room.controller;
  if (
    context.hostileCreeps.length === 0 ||
    controller?.my !== true ||
    typeof controller.activateSafeMode !== 'function' ||
    !isSafeModeAvailable(controller)
  ) {
    return false;
  }

  if (isCriticalSpawnLossThreat(context)) {
    return true;
  }

  return (
    context.hostileCreeps.length > SAFE_MODE_HOSTILE_COUNT_THRESHOLD &&
    isControllerUnderAttack(controller, context.hostileCreeps)
  );
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

function isControllerUnderAttack(controller: StructureController, hostileCreeps: Creep[]): boolean {
  if (typeof controller.upgradeBlocked === 'number' && controller.upgradeBlocked > 0) {
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

function isCriticalSpawnLossThreat(context: DefenseTelemetryContext): boolean {
  return context.hostileCreeps.length > 0 && getOwnedSpawnCount(context.room) === 0;
}

function getOwnedSpawnCount(room: Room): number {
  return findOwnedStructures(room).filter((structure) => {
    const spawnType = (globalThis as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN ?? 'spawn';
    return structure.structureType === spawnType || structure.structureType === 'spawn';
  }).length;
}
