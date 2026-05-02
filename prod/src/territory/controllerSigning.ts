export const OCCUPIED_CONTROLLER_SIGN_TEXT = 'by Hermes Screeps Project';

const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;
const ERR_TIRED_CODE = -11 as ScreepsReturnCode;
const OK_CODE = 0 as ScreepsReturnCode;

export type ControllerSigningResult = 'skipped' | 'signed' | 'moving' | 'blocked';

export function shouldSignOccupiedController(controller: StructureController | null | undefined): boolean {
  return controller?.my === true && controller.sign?.text !== OCCUPIED_CONTROLLER_SIGN_TEXT;
}

export function signOccupiedControllerIfNeeded(
  creep: Creep,
  controller: StructureController | null | undefined
): ControllerSigningResult {
  if (!controller || !shouldSignOccupiedController(controller) || typeof creep.signController !== 'function') {
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
