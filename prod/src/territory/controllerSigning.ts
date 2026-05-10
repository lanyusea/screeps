export const OCCUPIED_CONTROLLER_SIGN_TEXT = 'by Hermes Screeps Project';

const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_TIRED_CODE = -11 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;

export type ControllerSigningResult = 'skipped' | 'signed' | 'moving' | 'blocked';

export function shouldSignOccupiedController(controller: StructureController | null | undefined): boolean {
  return controller?.my === true && hasMissingControllerSignature(controller);
}

export function shouldSignReservedController(
  controller: StructureController | null | undefined,
  actorUsername: string | undefined
): boolean {
  return Boolean(
    controller &&
      isControllerReservedByActor(controller, actorUsername) &&
      hasMissingControllerSignature(controller)
  );
}

export function shouldSignControllerForCreep(
  creep: Creep,
  controller: StructureController | null | undefined
): boolean {
  return (
    shouldSignOccupiedController(controller) ||
    shouldSignReservedController(controller, getControllerSigningActorUsername(creep))
  );
}

export function signOccupiedControllerIfNeeded(
  creep: Creep,
  controller: StructureController | null | undefined
): ControllerSigningResult {
  return signControllerWithPredicate(creep, controller, shouldSignOccupiedController);
}

export function signReservedControllerIfNeeded(
  creep: Creep,
  controller: StructureController | null | undefined,
  actorUsername: string | undefined = getControllerSigningActorUsername(creep)
): ControllerSigningResult {
  return signControllerWithPredicate(creep, controller, (candidate) =>
    shouldSignReservedController(candidate, actorUsername)
  );
}

export function getControllerSigningActorUsername(
  creep: Creep,
  colony: string | undefined = creep.memory?.colony
): string | undefined {
  const creepOwner = (creep as Creep & { owner?: { username?: string } }).owner?.username;
  if (isNonEmptyString(creepOwner)) {
    return creepOwner;
  }

  const roomController = isNonEmptyString(colony)
    ? (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[colony]?.controller
    : undefined;
  const controllerOwner = roomController?.owner?.username;
  return isNonEmptyString(controllerOwner) ? controllerOwner : undefined;
}

function signControllerWithPredicate(
  creep: Creep,
  controller: StructureController | null | undefined,
  shouldSign: (controller: StructureController | null | undefined) => boolean
): ControllerSigningResult {
  if (!controller || !shouldSign(controller) || typeof creep.signController !== 'function') {
    return 'skipped';
  }

  const result = creep.signController(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    if (typeof creep.moveTo !== 'function') {
      return 'blocked';
    }

    const moveResult = creep.moveTo(controller);
    return moveResult === OK_CODE || moveResult === ERR_TIRED_CODE ? 'moving' : 'blocked';
  }

  return result === OK_CODE ? 'signed' : 'skipped';
}

function hasMissingControllerSignature(controller: StructureController): boolean {
  return controller.sign?.text !== OCCUPIED_CONTROLLER_SIGN_TEXT;
}

function isControllerReservedByActor(
  controller: StructureController | null | undefined,
  actorUsername: string | undefined
): boolean {
  const reservation = controller?.reservation;
  return (
    isNonEmptyString(actorUsername) &&
    isNonEmptyString(reservation?.username) &&
    reservation.username === actorUsername
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
