import {
  canCreepPressureTerritoryController,
  canCreepReserveTerritoryController,
  isVisibleTerritoryAssignmentAwaitingUnsafeSigningRetry,
  isVisibleTerritoryAssignmentComplete,
  isVisibleTerritoryAssignmentSafe,
  recordTerritoryReserveFallbackIntent,
  suppressTerritoryIntent
} from './territoryPlanner';
import { signOccupiedControllerIfNeeded } from './controllerSigning';
import {
  executeExpansionClaim,
  isExpansionClaimControllerOnCooldown,
  recordExpansionClaimSkipTelemetry
} from './claimExecutor';
import { recordPostClaimBootstrapClaimSuccess } from './postClaimBootstrap';
import type { RuntimeTelemetryEvent } from '../telemetry/runtimeSummary';
import {
  isTerritoryScoutIntelFresh,
  recordVisibleRoomScoutIntel
} from './scoutIntel';
import { selectBestClaimTarget } from './claimScoring';
import { getRecordedColonyStageAssessment, suppressesTerritoryWork } from '../colony/colonyStage';
import { getConfiguredExpansionRoomScoutingTargets } from './roomScouting';
export {
  isClaimedRoomBootstrapActive,
  refreshClaimedRoomBootstrapperOwnership,
  runClaimedRoomBootstrapper,
  runClaimedRoomBootstrapperForColony,
  type ClaimedRoomBootstrapRunResult,
  type ClaimedRoomBootstrapPlanResult,
  type ClaimedRoomOwnershipRefreshResult
} from './claimedRoomBootstrapper';

const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_NO_BODYPART_CODE = -12 as ScreepsReturnCode;
const ERR_GCL_NOT_ENOUGH_CODE = -15 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;
const CLAIM_FATAL_RESULT_CODES = new Set<ScreepsReturnCode>([
  ERR_INVALID_TARGET_CODE,
  ERR_NO_BODYPART_CODE,
  ERR_GCL_NOT_ENOUGH_CODE
]);
const RESERVE_FATAL_RESULT_CODES = new Set<ScreepsReturnCode>([ERR_INVALID_TARGET_CODE, ERR_NO_BODYPART_CODE]);
const PRESSURE_FATAL_RESULT_CODES = new Set<ScreepsReturnCode>([ERR_NO_BODYPART_CODE]);

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;

export function runTerritoryControllerCreep(
  creep: Creep,
  telemetryEvents: RuntimeTelemetryEvent[] = []
): void {
  const assignment = creep.memory.territory;
  if (!isTerritoryAssignment(assignment)) {
    if (creep.memory.role === 'scout') {
      runIdleTerritoryScout(creep);
    }
    return;
  }

  const colonyStageAssessment = getRecordedColonyStageAssessment(creep.memory.colony);
  if (assignment.action === 'scout') {
    if (colonyStageAssessment?.mode === 'BOOTSTRAP' || colonyStageAssessment?.mode === 'DEFENSE') {
      return;
    }
  } else if (suppressesTerritoryWork(colonyStageAssessment)) {
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

  if (creep.room?.name !== assignment.targetRoom) {
    moveTowardTargetRoom(creep, assignment);
    return;
  }

  if (assignment.action === 'scout') {
    recordVisibleRoomScoutIntel(creep.memory.colony, creep.room, getGameTime(), creep.name, telemetryEvents);
    if (assignNextScoutTarget(creep, assignment.targetRoom)) {
      moveTowardTargetRoom(creep, creep.memory.territory as CreepTerritoryMemory);
      return;
    }

    completeTerritoryAssignment(creep);
    recycleIdleTerritoryScout(creep);
    return;
  }

  const controller = selectTargetController(creep, assignment);
  if (!controller) {
    suppressTerritoryAssignment(creep, assignment);
    return;
  }

  if (controller.my === true) {
    if (assignment.action === 'reserve') {
      suppressTerritoryAssignment(creep, assignment);
    } else {
      const signingResult = signOccupiedControllerIfNeeded(creep, controller);
      if (signingResult === 'moving' || signingResult === 'blocked') {
        return;
      }

      completeTerritoryAssignment(creep);
    }
    return;
  }

  if (isTerritoryControlAction(assignment.action) && isCreepKnownToHaveNoActiveClaimParts(creep)) {
    suppressTerritoryAssignment(creep, assignment);
    return;
  }

  if (
    isTerritoryControlAction(assignment.action) &&
    typeof creep.attackController === 'function' &&
    canCreepPressureTerritoryController(creep, controller, creep.memory.colony)
  ) {
    const pressureResult = executeControllerAction(creep, controller, 'attackController');
    if (pressureResult === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === 'function') {
      creep.moveTo(controller);
      return;
    }

    if (PRESSURE_FATAL_RESULT_CODES.has(pressureResult)) {
      suppressTerritoryAssignment(creep, assignment);
      return;
    }

    if (pressureResult !== ERR_INVALID_TARGET_CODE) {
      return;
    }
  }

  if (
    assignment.action === 'reserve' &&
    !canCreepReserveTerritoryController(creep, controller, creep.memory.colony)
  ) {
    return;
  }

  if (assignment.action === 'claim' && isExpansionClaimControllerOnCooldown(controller)) {
    recordExpansionClaimSkipTelemetry(creep, controller, 'controllerCooldown', telemetryEvents);
    if (typeof creep.moveTo === 'function') {
      creep.moveTo(controller);
    }
    return;
  }

  const result =
    assignment.action === 'claim'
      ? executeExpansionClaim(creep, controller, telemetryEvents)
      : executeControllerAction(creep, controller, 'reserveController');

  if (assignment.action === 'claim' && result === OK_CODE) {
    recordPostClaimBootstrapIfOwned(creep, assignment, controller, telemetryEvents);
  }

  if (result === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === 'function') {
    creep.moveTo(controller);
    return;
  }

  if (
    assignment.action === 'claim' &&
    result === ERR_GCL_NOT_ENOUGH_CODE &&
    tryFallbackClaimAssignmentToReserve(creep, assignment, controller)
  ) {
    return;
  }

  if (
    (assignment.action === 'claim' && CLAIM_FATAL_RESULT_CODES.has(result)) ||
    (assignment.action === 'reserve' && RESERVE_FATAL_RESULT_CODES.has(result))
  ) {
    suppressTerritoryAssignment(creep, assignment);
  }
}

export function logBestClaimTarget(homeRoom: Room): string | null {
  if (isJestRuntime()) {
    return null;
  }

  const targetRoom = selectBestClaimTarget(homeRoom);
  console.log(`[territory] best adjacent claim target from ${homeRoom.name}: ${targetRoom ?? 'none'}`);
  return targetRoom;
}

function runIdleTerritoryScout(creep: Creep): void {
  if (assignNextScoutTarget(creep)) {
    moveTowardTargetRoom(creep, creep.memory.territory as CreepTerritoryMemory);
    return;
  }

  recycleIdleTerritoryScout(creep);
}

function assignNextScoutTarget(creep: Creep, excludedTargetRoom?: string): boolean {
  const assignment = selectNextScoutAssignment(creep.memory.colony, excludedTargetRoom);
  if (!assignment) {
    return false;
  }

  creep.memory.territory = assignment;
  return true;
}

function selectNextScoutAssignment(
  colony: string | undefined,
  excludedTargetRoom?: string
): CreepTerritoryMemory | null {
  if (!isNonEmptyString(colony)) {
    return null;
  }

  const gameTime = getGameTime();
  return (
    selectNextScoutIntentAssignment(colony, excludedTargetRoom, gameTime) ??
    selectNextScoutAttemptAssignment(colony, excludedTargetRoom, gameTime) ??
    selectNextConfiguredScoutAssignment(colony, excludedTargetRoom, gameTime)
  );
}

function selectNextScoutIntentAssignment(
  colony: string,
  excludedTargetRoom: string | undefined,
  gameTime: number
): CreepTerritoryMemory | null {
  const intents = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.intents;
  if (!Array.isArray(intents)) {
    return null;
  }

  for (const intent of intents) {
    if (!isRecord(intent)) {
      continue;
    }

    if (
      intent.colony === colony &&
      intent.action === 'scout' &&
      (intent.status === 'planned' || intent.status === 'active') &&
      isPendingScoutTarget(colony, intent.targetRoom, excludedTargetRoom, gameTime)
    ) {
      return {
        targetRoom: intent.targetRoom,
        action: 'scout',
        ...(intent.controllerId ? { controllerId: intent.controllerId } : {})
      };
    }
  }

  return null;
}

function selectNextScoutAttemptAssignment(
  colony: string,
  excludedTargetRoom: string | undefined,
  gameTime: number
): CreepTerritoryMemory | null {
  const attempts = (globalThis as { Memory?: Partial<Memory> }).Memory?.territory?.scoutAttempts;
  if (!attempts || typeof attempts !== 'object') {
    return null;
  }

  for (const attempt of Object.values(attempts)) {
    if (!isRecord(attempt)) {
      continue;
    }

    if (
      attempt.colony === colony &&
      attempt.status === 'requested' &&
      isPendingScoutTarget(colony, attempt.roomName, excludedTargetRoom, gameTime)
    ) {
      return {
        targetRoom: attempt.roomName,
        action: 'scout',
        ...(attempt.controllerId ? { controllerId: attempt.controllerId } : {})
      };
    }
  }

  return null;
}

function selectNextConfiguredScoutAssignment(
  colony: string,
  excludedTargetRoom: string | undefined,
  gameTime: number
): CreepTerritoryMemory | null {
  for (const target of getConfiguredExpansionRoomScoutingTargets(colony, gameTime)) {
    if (isPendingScoutTarget(colony, target.roomName, excludedTargetRoom, gameTime)) {
      return {
        targetRoom: target.roomName,
        action: 'scout',
        ...(target.controllerId ? { controllerId: target.controllerId } : {})
      };
    }
  }

  return null;
}

function isPendingScoutTarget(
  colony: string,
  targetRoom: string | undefined,
  excludedTargetRoom: string | undefined,
  gameTime: number
): targetRoom is string {
  return (
    isNonEmptyString(targetRoom) &&
    targetRoom !== excludedTargetRoom &&
    !isVisibleRoomKnown(targetRoom) &&
    !isTerritoryScoutIntelFresh(colony, targetRoom, gameTime)
  );
}

function recycleIdleTerritoryScout(creep: Creep): void {
  const spawn = selectRecycleSpawn(creep.memory.colony);
  if (spawn) {
    if (typeof spawn.recycleCreep === 'function') {
      const result = spawn.recycleCreep(creep);
      if (result === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === 'function') {
        creep.moveTo(spawn);
      }
      return;
    }

    if (typeof creep.moveTo === 'function') {
      creep.moveTo(spawn);
    }
    return;
  }

  moveTowardHomeRoom(creep);
}

function selectRecycleSpawn(colony: string | undefined): StructureSpawn | null {
  if (!isNonEmptyString(colony)) {
    return null;
  }

  const spawns = (globalThis as { Game?: Partial<Pick<Game, 'spawns'>> }).Game?.spawns;
  if (!spawns) {
    return null;
  }

  return Object.values(spawns).find((spawn) => spawn.room?.name === colony) ?? null;
}

function moveTowardHomeRoom(creep: Creep): void {
  const homeRoom = creep.memory.colony;
  if (!isNonEmptyString(homeRoom) || creep.room?.name === homeRoom || typeof creep.moveTo !== 'function') {
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
  if (typeof RoomPositionCtor !== 'function') {
    return;
  }

  creep.moveTo(new RoomPositionCtor(25, 25, homeRoom));
}

function isVisibleRoomKnown(roomName: string): boolean {
  return (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[roomName] != null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isJestRuntime(): boolean {
  const nodeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return nodeProcess?.env?.NODE_ENV === 'test' || nodeProcess?.env?.JEST_WORKER_ID !== undefined;
}

function tryFallbackClaimAssignmentToReserve(
  creep: Creep,
  assignment: CreepTerritoryMemory,
  controller: StructureController
): boolean {
  if (
    typeof creep.reserveController !== 'function' ||
    !canCreepReserveTerritoryController(creep, controller, creep.memory.colony)
  ) {
    return false;
  }

  const gameTime = getGameTime();
  const reserveAssignment: CreepTerritoryMemory = {
    targetRoom: assignment.targetRoom,
    action: 'reserve',
    ...(assignment.controllerId ? { controllerId: assignment.controllerId } : {}),
    ...(assignment.followUp ? { followUp: assignment.followUp } : {})
  };

  suppressTerritoryIntent(creep.memory.colony, assignment, gameTime);
  creep.memory.territory =
    recordTerritoryReserveFallbackIntent(creep.memory.colony, reserveAssignment, gameTime) ?? reserveAssignment;

  const reserveResult = executeControllerAction(creep, controller, 'reserveController');
  if (reserveResult === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === 'function') {
    creep.moveTo(controller);
    return true;
  }

  if (RESERVE_FATAL_RESULT_CODES.has(reserveResult)) {
    suppressTerritoryAssignment(creep, reserveAssignment);
  }

  return true;
}

function suppressTerritoryAssignment(creep: Creep, assignment: CreepTerritoryMemory): void {
  suppressTerritoryIntent(creep.memory.colony, assignment, getGameTime());
  completeTerritoryAssignment(creep);
}

function completeTerritoryAssignment(creep: Creep): void {
  delete creep.memory.territory;
}

function recordPostClaimBootstrapIfOwned(
  creep: Creep,
  assignment: CreepTerritoryMemory,
  controller: StructureController,
  telemetryEvents: RuntimeTelemetryEvent[]
): void {
  const room = getVisibleClaimedRoom(assignment.targetRoom, controller);
  if (!room?.controller?.my) {
    return;
  }

  recordPostClaimBootstrapClaimSuccess(
    {
      colony: creep.memory.colony ?? room.name,
      roomName: room.name,
      controllerId: controller.id
    },
    telemetryEvents
  );
}

function getVisibleClaimedRoom(
  targetRoom: string,
  controller: StructureController
): Room | null {
  const controllerRoom = controller.room;
  if (controllerRoom?.controller?.my === true) {
    return controllerRoom;
  }

  const gameRoom = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[targetRoom];
  return gameRoom?.controller?.my === true ? gameRoom : null;
}

function selectTargetController(creep: Creep, assignment: CreepTerritoryMemory): StructureController | null {
  if (assignment.controllerId) {
    const game = (globalThis as { Game?: Partial<Game> }).Game;
    const getObjectById = game?.getObjectById;
    if (typeof getObjectById === 'function') {
      const controller = getObjectById.call(game, assignment.controllerId) as StructureController | null;
      if (controller) {
        return controller;
      }
    }
  }

  return creep.room?.controller ?? null;
}

function executeControllerAction(
  creep: Creep,
  controller: StructureController,
  action: 'attackController' | 'claimController' | 'reserveController'
): ScreepsReturnCode {
  const controllerAction = creep[action];
  if (typeof controllerAction !== 'function') {
    return OK_CODE;
  }

  return controllerAction.call(creep, controller);
}

function moveTowardTargetRoom(creep: Creep, assignment: CreepTerritoryMemory): void {
  if (typeof creep.moveTo !== 'function') {
    return;
  }

  const visibleController = selectVisibleTargetRoomController(assignment);
  if (visibleController) {
    creep.moveTo(visibleController);
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
  if (typeof RoomPositionCtor !== 'function') {
    return;
  }

  creep.moveTo(new RoomPositionCtor(25, 25, assignment.targetRoom));
}

function selectVisibleTargetRoomController(assignment: CreepTerritoryMemory): StructureController | null {
  if (!isTerritoryControlAction(assignment.action)) {
    return null;
  }

  const game = (globalThis as { Game?: Partial<Game> }).Game;
  if (assignment.controllerId && typeof game?.getObjectById === 'function') {
    const controller = game.getObjectById.call(game, assignment.controllerId) as StructureController | null;
    if (controller) {
      return controller;
    }
  }

  return game?.rooms?.[assignment.targetRoom]?.controller ?? null;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function isCreepKnownToHaveNoActiveClaimParts(creep: Creep): boolean {
  const claimPart = getBodyPartConstant('CLAIM', 'claim');
  const activeClaimParts = creep.getActiveBodyparts?.(claimPart);
  if (typeof activeClaimParts === 'number') {
    return activeClaimParts <= 0;
  }

  if (!Array.isArray(creep.body)) {
    return false;
  }

  return !creep.body.some((part) => isActiveBodyPart(part, claimPart));
}

function isActiveBodyPart(part: unknown, bodyPartType: BodyPartConstant): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }

  const bodyPart = part as Partial<BodyPartDefinition>;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === 'number' && bodyPart.hits > 0;
}

function getBodyPartConstant(globalName: 'CLAIM', fallback: BodyPartConstant): BodyPartConstant {
  const constants = globalThis as unknown as Partial<Record<'CLAIM', BodyPartConstant>>;
  return constants[globalName] ?? fallback;
}

function isTerritoryControlAction(action: CreepTerritoryMemory['action']): action is TerritoryControlAction {
  return action === 'claim' || action === 'reserve';
}

function isTerritoryAssignment(assignment: CreepTerritoryMemory | undefined): assignment is CreepTerritoryMemory {
  return (
    typeof assignment?.targetRoom === 'string' &&
    assignment.targetRoom.length > 0 &&
    (assignment.action === 'claim' || assignment.action === 'reserve' || assignment.action === 'scout')
  );
}
