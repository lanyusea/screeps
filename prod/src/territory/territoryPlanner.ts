import type { ColonySnapshot } from '../colony/colonyRegistry';
import type { RoleCounts } from '../creeps/roleCounts';
import { TERRITORY_CONTROLLER_BODY_COST } from '../spawn/bodyBuilder';

export const TERRITORY_CLAIMER_ROLE = 'claimer';
export const TERRITORY_SCOUT_ROLE = 'scout';
export const TERRITORY_DOWNGRADE_GUARD_TICKS = 5_000;

const EXIT_DIRECTION_ORDER: ExitKey[] = ['1', '3', '5', '7'];

export interface TerritoryIntentPlan {
  colony: string;
  targetRoom: string;
  action: TerritoryIntentAction;
  controllerId?: Id<StructureController>;
}

interface MemoryRecord {
  territory?: unknown;
}

interface SelectedTerritoryTarget {
  target: TerritoryTargetMemory;
  intentAction: TerritoryIntentAction;
  commitTarget: boolean;
}

export function planTerritoryIntent(
  colony: ColonySnapshot,
  roleCounts: RoleCounts,
  workerTarget: number,
  gameTime: number
): TerritoryIntentPlan | null {
  if (!isTerritoryHomeSafe(colony, roleCounts, workerTarget)) {
    return null;
  }

  const selection = selectTerritoryTarget(colony.room.name);
  if (!selection) {
    return null;
  }

  const target = selection.target;
  const plan: TerritoryIntentPlan = {
    colony: colony.room.name,
    targetRoom: target.roomName,
    action: selection.intentAction,
    ...(target.controllerId ? { controllerId: target.controllerId } : {})
  };
  const status = getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) > 0 ? 'active' : 'planned';
  recordTerritoryIntent(plan, status, gameTime, selection.commitTarget ? target : null);

  return plan;
}

export function shouldSpawnTerritoryControllerCreep(plan: TerritoryIntentPlan, roleCounts: RoleCounts): boolean {
  if (isTerritoryIntentSuppressed(plan.colony, plan.targetRoom, plan.action)) {
    return false;
  }

  if (plan.action === 'scout' && isVisibleRoomKnown(plan.targetRoom)) {
    return false;
  }

  if (isVisibleTerritoryTargetUnavailable(plan.targetRoom, plan.controllerId)) {
    return false;
  }

  return getTerritoryCreepCountForTarget(roleCounts, plan.targetRoom, plan.action) === 0;
}

export function buildTerritoryCreepMemory(plan: TerritoryIntentPlan): CreepMemory {
  return {
    role: plan.action === 'scout' ? TERRITORY_SCOUT_ROLE : TERRITORY_CLAIMER_ROLE,
    colony: plan.colony,
    territory: {
      targetRoom: plan.targetRoom,
      action: plan.action,
      ...(plan.controllerId ? { controllerId: plan.controllerId } : {})
    }
  };
}

export function suppressTerritoryIntent(
  colony: string | undefined,
  assignment: CreepTerritoryMemory,
  gameTime: number
): void {
  if (
    !isNonEmptyString(colony) ||
    !isNonEmptyString(assignment.targetRoom) ||
    !isTerritoryIntentAction(assignment.action)
  ) {
    return;
  }

  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const suppressedIntent: TerritoryIntentMemory = {
    colony,
    targetRoom: assignment.targetRoom,
    action: assignment.action,
    status: 'suppressed',
    updatedAt: gameTime,
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {})
  };

  upsertTerritoryIntent(intents, suppressedIntent);
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

function selectTerritoryTarget(colonyName: string): SelectedTerritoryTarget | null {
  const territoryMemory = getTerritoryMemoryRecord();
  const intents = normalizeTerritoryIntents(territoryMemory?.intents);
  const configuredTarget = selectConfiguredTerritoryTarget(colonyName, territoryMemory, intents);
  if (configuredTarget) {
    return { target: configuredTarget, intentAction: configuredTarget.action, commitTarget: false };
  }

  if (hasConfiguredTerritoryTargetForColony(territoryMemory, colonyName)) {
    return null;
  }

  return selectAdjacentReserveTarget(colonyName, territoryMemory, intents);
}

function selectConfiguredTerritoryTarget(
  colonyName: string,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[]
): TerritoryTargetMemory | null {
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
      !isTerritoryTargetSuppressed(target, intents) &&
      !isVisibleTerritoryTargetUnavailable(target.roomName, target.controllerId)
    ) {
      return target;
    }
  }

  return null;
}

function hasConfiguredTerritoryTargetForColony(
  territoryMemory: Record<string, unknown> | null,
  colonyName: string
): boolean {
  return getConfiguredTargetRoomsForColony(territoryMemory, colonyName).size > 0;
}

function selectAdjacentReserveTarget(
  colonyName: string,
  territoryMemory: Record<string, unknown> | null,
  intents: TerritoryIntentMemory[]
): SelectedTerritoryTarget | null {
  const adjacentRooms = getAdjacentRoomNames(colonyName);
  if (adjacentRooms.length === 0) {
    return null;
  }

  const existingTargetRooms = getConfiguredTargetRoomsForColony(territoryMemory, colonyName);
  for (const roomName of adjacentRooms) {
    const target: TerritoryTargetMemory = { colony: colonyName, roomName, action: 'reserve' };
    if (
      roomName !== colonyName &&
      !existingTargetRooms.has(roomName) &&
      !isTerritoryTargetSuppressed(target, intents)
    ) {
      const candidateState = getAdjacentReserveCandidateState(roomName);
      if (candidateState === 'safe') {
        return { target, intentAction: 'reserve', commitTarget: true };
      }

      if (
        candidateState === 'unknown' &&
        !isTerritoryIntentForActionSuppressed(colonyName, roomName, 'scout')
      ) {
        return { target, intentAction: 'scout', commitTarget: false };
      }
    }
  }

  return null;
}

function getAdjacentReserveCandidateState(targetRoom: string): 'safe' | 'unknown' | 'unavailable' {
  if (isVisibleRoomMissingController(targetRoom)) {
    return 'unavailable';
  }

  const controller = getVisibleController(targetRoom);
  if (!controller) {
    return 'unknown';
  }

  return !isControllerOwned(controller) && controller.reservation == null ? 'safe' : 'unavailable';
}

function getConfiguredTargetRoomsForColony(
  territoryMemory: Record<string, unknown> | null,
  colonyName: string
): Set<string> {
  if (!territoryMemory || !Array.isArray(territoryMemory.targets)) {
    return new Set();
  }

  return new Set(
    territoryMemory.targets.flatMap((rawTarget) => {
      const target = normalizeTerritoryTarget(rawTarget);
      return target?.colony === colonyName ? [target.roomName] : [];
    })
  );
}

function appendTerritoryTarget(territoryMemory: TerritoryMemory, target: TerritoryTargetMemory): void {
  if (!Array.isArray(territoryMemory.targets)) {
    territoryMemory.targets = [];
  }

  territoryMemory.targets.push(target);
}

function getAdjacentRoomNames(roomName: string): string[] {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const gameMap = game?.map;
  if (!gameMap || typeof gameMap.describeExits !== 'function') {
    return [];
  }

  const exits = gameMap.describeExits(roomName) as ExitsInformation | null;
  if (!isRecord(exits)) {
    return [];
  }

  return EXIT_DIRECTION_ORDER.flatMap((direction) => {
    const exitRoom = exits[direction];
    return isNonEmptyString(exitRoom) ? [exitRoom] : [];
  });
}

function normalizeTerritoryTarget(rawTarget: unknown): TerritoryTargetMemory | null {
  if (!isRecord(rawTarget)) {
    return null;
  }

  if (
    !isNonEmptyString(rawTarget.colony) ||
    !isNonEmptyString(rawTarget.roomName) ||
    !isTerritoryControlAction(rawTarget.action)
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

function recordTerritoryIntent(
  plan: TerritoryIntentPlan,
  status: TerritoryIntentMemory['status'],
  gameTime: number,
  seededTarget: TerritoryTargetMemory | null = null
): void {
  const territoryMemory = getWritableTerritoryMemoryRecord();
  if (!territoryMemory) {
    return;
  }

  if (seededTarget) {
    appendTerritoryTarget(territoryMemory, seededTarget);
  }

  const intents = normalizeTerritoryIntents(territoryMemory.intents);
  territoryMemory.intents = intents;
  const nextIntent: TerritoryIntentMemory = {
    colony: plan.colony,
    targetRoom: plan.targetRoom,
    action: plan.action,
    status,
    updatedAt: gameTime,
    ...(plan.controllerId ? { controllerId: plan.controllerId } : {})
  };

  upsertTerritoryIntent(intents, nextIntent);
}

function normalizeTerritoryIntents(rawIntents: TerritoryMemory['intents'] | unknown): TerritoryIntentMemory[] {
  return Array.isArray(rawIntents)
    ? rawIntents.flatMap((intent) => {
        const normalizedIntent = normalizeTerritoryIntent(intent);
        return normalizedIntent ? [normalizedIntent] : [];
      })
    : [];
}

function upsertTerritoryIntent(intents: TerritoryIntentMemory[], nextIntent: TerritoryIntentMemory): void {
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
    !isTerritoryIntentAction(rawIntent.action) ||
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

function getTerritoryCreepCountForTarget(
  roleCounts: RoleCounts,
  targetRoom: string,
  action: TerritoryIntentAction
): number {
  if (action === 'scout') {
    return roleCounts.scoutsByTargetRoom?.[targetRoom] ?? 0;
  }

  return roleCounts.claimersByTargetRoom?.[targetRoom] ?? 0;
}

function isTerritoryTargetSuppressed(target: TerritoryTargetMemory, intents: TerritoryIntentMemory[]): boolean {
  return intents.some(
    (intent) =>
      intent.status === 'suppressed' &&
      intent.colony === target.colony &&
      intent.targetRoom === target.roomName &&
      intent.action === target.action
  );
}

function isTerritoryIntentSuppressed(
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction
): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) =>
      intent.status === 'suppressed' &&
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action
  );
}

function isTerritoryIntentForActionSuppressed(
  colony: string,
  targetRoom: string,
  action: TerritoryIntentAction
): boolean {
  const territoryMemory = getTerritoryMemoryRecord();
  if (!territoryMemory) {
    return false;
  }

  return normalizeTerritoryIntents(territoryMemory.intents).some(
    (intent) =>
      intent.status === 'suppressed' &&
      intent.colony === colony &&
      intent.targetRoom === targetRoom &&
      intent.action === action
  );
}

function isVisibleTerritoryTargetUnavailable(
  targetRoom: string,
  controllerId?: Id<StructureController>
): boolean {
  if (isVisibleRoomMissingController(targetRoom)) {
    return true;
  }

  const controller = getVisibleController(targetRoom, controllerId);
  if (!controller) {
    return false;
  }

  return isControllerOwned(controller);
}

function isVisibleRoomKnown(targetRoom: string): boolean {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  return game?.rooms?.[targetRoom] != null;
}

function isVisibleRoomMissingController(targetRoom: string): boolean {
  const game = (globalThis as { Game?: Partial<Game> }).Game;
  const room = game?.rooms?.[targetRoom];
  return room != null && room.controller == null;
}

function isControllerOwned(controller: StructureController): boolean {
  return controller.owner != null || controller.my === true;
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

function isTerritoryControlAction(action: unknown): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
}

function isTerritoryIntentAction(action: unknown): action is TerritoryIntentAction {
  return isTerritoryControlAction(action) || action === 'scout';
}

function isTerritoryIntentStatus(status: unknown): status is TerritoryIntentMemory['status'] {
  return status === 'planned' || status === 'active' || status === 'suppressed';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
