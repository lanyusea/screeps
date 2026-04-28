import { isVisibleTerritoryAssignmentSafe, suppressTerritoryIntent } from './territoryPlanner';

const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_INVALID_TARGET_CODE = -7 as ScreepsReturnCode;
const ERR_GCL_NOT_ENOUGH_CODE = -15 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;
const CLAIM_FATAL_RESULT_CODES = new Set<ScreepsReturnCode>([
  ERR_INVALID_TARGET_CODE,
  ERR_GCL_NOT_ENOUGH_CODE
]);
const RESERVE_FATAL_RESULT_CODES = new Set<ScreepsReturnCode>([ERR_INVALID_TARGET_CODE]);

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;

export function runTerritoryControllerCreep(creep: Creep): void {
  const assignment = creep.memory.territory;
  if (!isTerritoryAssignment(assignment)) {
    return;
  }

  if (!isVisibleTerritoryAssignmentSafe(assignment, creep.memory.colony, creep)) {
    suppressTerritoryAssignment(creep, assignment);
    return;
  }

  if (creep.room?.name !== assignment.targetRoom) {
    moveTowardTargetRoom(creep, assignment.targetRoom);
    return;
  }

  if (assignment.action === 'scout') {
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
    }
    return;
  }

  const result =
    assignment.action === 'claim'
      ? executeControllerAction(creep, controller, 'claimController')
      : executeControllerAction(creep, controller, 'reserveController');

  if (result === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === 'function') {
    creep.moveTo(controller);
    return;
  }

  if (
    (assignment.action === 'claim' && CLAIM_FATAL_RESULT_CODES.has(result)) ||
    (assignment.action === 'reserve' && RESERVE_FATAL_RESULT_CODES.has(result))
  ) {
    suppressTerritoryAssignment(creep, assignment);
  }
}

function suppressTerritoryAssignment(creep: Creep, assignment: CreepTerritoryMemory): void {
  suppressTerritoryIntent(creep.memory.colony, assignment, getGameTime());
  delete creep.memory.territory;
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
  action: 'claimController' | 'reserveController'
): ScreepsReturnCode {
  const controllerAction = creep[action];
  if (typeof controllerAction !== 'function') {
    return OK_CODE;
  }

  return controllerAction.call(creep, controller);
}

function moveTowardTargetRoom(creep: Creep, targetRoom: string): void {
  const RoomPositionCtor = (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
  if (typeof RoomPositionCtor !== 'function' || typeof creep.moveTo !== 'function') {
    return;
  }

  creep.moveTo(new RoomPositionCtor(25, 25, targetRoom));
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function isTerritoryAssignment(assignment: CreepTerritoryMemory | undefined): assignment is CreepTerritoryMemory {
  return (
    typeof assignment?.targetRoom === 'string' &&
    assignment.targetRoom.length > 0 &&
    (assignment.action === 'claim' || assignment.action === 'reserve' || assignment.action === 'scout')
  );
}
