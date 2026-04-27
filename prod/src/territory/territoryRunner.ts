const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;

export function runTerritoryControllerCreep(creep: Creep): void {
  const assignment = creep.memory.territory;
  if (!isTerritoryAssignment(assignment)) {
    return;
  }

  if (creep.room?.name !== assignment.targetRoom) {
    moveTowardTargetRoom(creep, assignment.targetRoom);
    return;
  }

  const controller = selectTargetController(creep, assignment);
  if (!controller || controller.my === true) {
    return;
  }

  const result =
    assignment.action === 'claim'
      ? executeControllerAction(creep, controller, 'claimController')
      : executeControllerAction(creep, controller, 'reserveController');

  if (result === ERR_NOT_IN_RANGE_CODE && typeof creep.moveTo === 'function') {
    creep.moveTo(controller);
  }
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

function isTerritoryAssignment(assignment: CreepTerritoryMemory | undefined): assignment is CreepTerritoryMemory {
  return (
    typeof assignment?.targetRoom === 'string' &&
    assignment.targetRoom.length > 0 &&
    (assignment.action === 'claim' || assignment.action === 'reserve')
  );
}
