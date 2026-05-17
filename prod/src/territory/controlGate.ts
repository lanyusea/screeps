import type { ColonySnapshot } from '../colony/colonyRegistry';

export const AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL = 6;
export const AUTONOMOUS_TERRITORY_CONTROL_SUPPRESSION_REASON: TerritoryIntentSuppressionReason =
  'controllerLevel';
export const AUTONOMOUS_TERRITORY_CONTROL_ABORT_REASON: TerritoryExpansionAbortReason = 'rcl6Gate';

export function isAutonomousTerritoryControlAllowedForColony(colony: ColonySnapshot): boolean {
  return isAutonomousTerritoryControlAllowedForController(colony.room.controller);
}

export function isAutonomousTerritoryControlAllowedForController(
  controller: { my?: boolean; level?: number } | undefined
): boolean {
  return (
    controller?.my === true &&
    typeof controller.level === 'number' &&
    Number.isFinite(controller.level) &&
    controller.level >= AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL
  );
}

export function isAutonomousTerritoryControlAllowedForColonyName(
  colonyName: string | null | undefined
): boolean {
  if (!colonyName) {
    return false;
  }

  const room = (globalThis as { Game?: Partial<Game> }).Game?.rooms?.[colonyName];
  if (!room?.controller) {
    return true;
  }

  return isAutonomousTerritoryControlAllowedForController(room?.controller);
}
