import type { ColonySnapshot } from '../colony/colonyRegistry';
import type { RoleCounts } from '../creeps/roleCounts';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';

export const TERRITORY_CLAIMER_ROLE = 'claimer';
export const TERRITORY_DOWNGRADE_GUARD_TICKS = 5_000;

export interface TerritoryIntentPlan {
  colony: string;
  targetRoom: string;
  action: TerritoryControlAction;
  controllerId?: Id<StructureController>;
}

interface MemoryRecord {
  territory?: unknown;
}

export function planTerritoryIntent(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number
): TerritoryIntentPlan | null {
  const target = selectTerritoryTarget(colony.room.name);
  if (!target || !isTerritoryHomeSafe(colony, roleCounts, workerTarget)) {
    return null;
  }

  const plan: TerritoryIntentPlan = {
    colony: colony.room.name,
    targetRoom: target.roomName,
    action: target.action,
    ...(target.controllerId ? { controllerId: target.controllerId } : {})
  };
  const status = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom) > 0 ? 'active' : 'planned';
  recordTerritoryIntent(plan, status, gameTime);

  return plan;
}

export function shouldSpawnTerritoryControllerCreep(plan: TerritoryIntentPlan, roleCounts: RoleCounts): boolean {
  if (isClaimTargetAlreadyOwned(plan.targetRoom, plan.action, plan.controllerId)) {
    return false;
  }

  return getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom) === 0;
}

export function buildTerritoryCreepMemory(plan: TerritoryIntentPlan): CreepMemory {
  return {
    role: TERRITORY_CLAIMER_ROLE,
    colony: plan.colony,
    territory: {
      targetRoom: plan.targetRoom,
      action: plan.action,
      ...(plan.controllerId ? { controllerId: plan.controllerId } : {})
    }
  };
}

export function isTerritoryHomeSafe(colony: ColonySnapshot, roleCounts: RoleCounts, workerTarget: number): boolean {
  if (roleCounts.worker < workerTarget) {
    return false;
  }

  if (colony.energyCapacityAvailable < TERRITORY_CONTROLLER_BODY_COST) {
    return false;
  }

  const controller = colony.room.controller;
  if (controller?.my !== true || typeof controller.level !== 'number' || controller.level < 2) {
    return false;
  }

  return (
    typeof controller.ticksToDowngrade !== 'number' ||
    controller.ticksToDowngrade > TERRITORY_DOWNGRADE_GUARD_TICKS
  );
}

function selectTerritoryTarget(colonyName: string): TerritoryTargetMemory | null {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return null;
  }

  for (const rawTarget of territoryMemory.targets) {
    const target = normalizeTerritoryTarget(rawTarget);
    if (
      target &&
      target.enabled !== false &&
      target.colony === colonyName &&
      target.roomName !== colonyName &&
      !isClaimTargetAlreadyOwned(target.roomName, target.action, target.controllerId)
    ) {
      return target;
    }
  }

  return null;
}

function normalizeTerritoryTarget(rawTarget: unknown): TerritoryTargetMemory | null {
  if (!isRecord(rawTarget)) {
    return null;
  }

  if (
    !isNonEmptyString(rawTarget.colony) ||
    !isNonEmptyString(rawTarget.roomName) ||
    !isTerritoryAction(rawTarget.action)
  ) {
    return null;
  }

  return {
    colony: rawTarget.colony,
    roomName: rawTarget.roomName,
    action: rawTarget.action,
    ...(typeof rawTarget.controllerId === 'string'
      ? { controllerId: rawTarget.controllerId as Id<StructureController> }
      : {}),
    ...(rawTarget.enabled === false ? { enabled: false } : {})
  };
}

function recordTerritoryIntent(plan: TerritoryIntentPlan, status: TerritoryIntentMemory['status'], gameTime: number): void {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const intents = Array.isArray(territoryMemory.intents)
    ? territoryMemory.intents.flatMap((intent) => {
        const normalizedIntent = normalizeTerritoryIntent(intent);
        return normalizedIntent ? [normalizedIntent] : [];
      })
    : [];
  territoryMemory.intents = intents;
  const nextIntent: TerritoryIntentMemory = {
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    status,
    updatedAt: gameTime,
    ...(plan.controllerId ? { controllerId: plan.controllerId } : {})
  };
  const existingIndex = intents.findIndex(
    (intent) =>
      intent.colony === nextIntent.colony &&
      intent.targetRoom === nextIntent.targetRoom &&
      intent.action === nextIntent.action
  );

  if (existingIndex >= 0) {
    intents[existingIndex] = nextIntent;
    return;
  }

  intents.push(nextIntent);
}

function normalizeTerritoryIntent(rawIntent: unknown): TerritoryIntentMemory | null {
  if (!isRecord(rawIntent)) {
    return null;
  }

  if (
    !isNonEmptyString(rawIntent.colony) ||
    !isNonEmptyString(rawIntent.targetRoom) ||
    !isTerritoryAction(rawIntent.action) ||
    !isTerritoryIntentStatus(rawIntent.status) ||
    typeof rawIntent.updatedAt !== 'number'
  ) {
    return null;
  }

  return {
    colony: rawIntent.colony,
    targetRoom: rawIntent.targetRoom,
    action: rawIntent.action,
    status: rawIntent.status,
    updatedAt: rawIntent.updatedAt,
    ...(typeof rawIntent.controllerId === 'string'
      ? { controllerId: rawIntent.controllerId as Id<StructureController> }
      : {})
  };
}

function getTerritoryCreepCountForTarget(roleCounts: RoleCounts, targetRoom: string): number {
  return roleCounts.claimersByTargetRoom?.[targetRoom] ?? 0;
}

function isClaimTargetAlreadyOwned(
  targetRoom: string,
  action: TerritoryControlAction,
  controllerId?: Id<StructureController>
): boolean {
  if (action !== 'claim') {
    return false;
  }

  return getVisibleController(targetRoom, controllerId)?.my === true;
}

function getVisibleController(targetRoom: string, controllerId?: Id<StructureController>): StructureController | null {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const roomController = game?.rooms?.[targetRoom]?.controller;
  if (roomController) {
    return roomController;
  }

  const getObjectById = game?.getObjectById;
  if (controllerId && typeof getObjectById === 'function') {
    return getObjectById.call(game, controllerId) as StructureController | null;
  }

  return null;
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

function getTerritoryMemoryRecord(): Record<string, unknown> | null {
  const memory = getMemoryRecord();
  if (!memory || !isRecord(memory.territory)) {
    return null;
  }

  return memory.territory;
}

function getMemoryRecord(): MemoryRecord | null {
  const memory = (globalThis as { Memory?: MemoryRecord }).Memory;
  return memory ?? null;
}

function isTerritoryAction(action: unknown): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
}

function isTerritoryIntentStatus(status: unknown): status is TerritoryIntentMemory['status'] {
  return status === 'planned' || status === 'active';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
