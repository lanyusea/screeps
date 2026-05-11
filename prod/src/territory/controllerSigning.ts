export const OCCUPIED_CONTROLLER_SIGN_TEXT = 'by Hermes Screeps Project';
export const CONTROLLER_SIGN_REFRESH_INTERVAL_TICKS = 5_000;

const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_TIRED_CODE = -11 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;

export type ControllerSigningResult = 'skipped' | 'signed' | 'moving' | 'blocked';

export function shouldSignOccupiedController(
  controller: StructureController | null | undefined,
  gameTime: number | null = getGameTime()
): boolean {
  return controller?.my === true && hasMissingOrStaleControllerSignature(controller, gameTime);
}

export function shouldSignReservedController(
  controller: StructureController | null | undefined,
  actorUsername: string | undefined,
  gameTime: number | null = getGameTime()
): boolean {
  return Boolean(
    controller &&
      isControllerReservedByActor(controller, actorUsername) &&
      hasMissingOrStaleControllerSignature(controller, gameTime)
  );
}

export function shouldSignControllerForCreep(
  creep: Creep,
  controller: StructureController | null | undefined,
  gameTime: number | null = getGameTime()
): boolean {
  return (
    shouldSignOccupiedController(controller, gameTime) ||
    shouldSignReservedController(controller, getControllerSigningActorUsername(creep), gameTime)
  );
}

export function signOccupiedControllerIfNeeded(
  creep: Creep,
  controller: StructureController | null | undefined,
  gameTime: number | null = getGameTime()
): ControllerSigningResult {
  return signControllerWithPredicate(creep, controller, (candidate) =>
    shouldSignOccupiedController(candidate, gameTime)
  );
}

export function signReservedControllerIfNeeded(
  creep: Creep,
  controller: StructureController | null | undefined,
  actorUsername: string | undefined = getControllerSigningActorUsername(creep),
  gameTime: number | null = getGameTime()
): ControllerSigningResult {
  return signControllerWithPredicate(creep, controller, (candidate) =>
    shouldSignReservedController(candidate, actorUsername, gameTime)
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

function hasMissingOrStaleControllerSignature(
  controller: StructureController,
  gameTime: number | null
): boolean {
  if (controller.sign?.text !== OCCUPIED_CONTROLLER_SIGN_TEXT) {
    return true;
  }

  if (!isFiniteNumber(gameTime)) {
    return false;
  }

  const signedAt = controller.sign?.time;
  return (
    !isFiniteNumber(signedAt) ||
    gameTime - signedAt >= CONTROLLER_SIGN_REFRESH_INTERVAL_TICKS
  );
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function getGameTime(): number | null {
  const gameTime = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return isFiniteNumber(gameTime) ? gameTime : null;
}
