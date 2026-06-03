import type { ColonySnapshot } from '../colony/colonyRegistry';
import {
  SEASONAL_AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL,
  isSeasonalRuntimeWorld
} from '../runtime/seasonalPolicy';

export const AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL = 5;
export const AUTONOMOUS_TERRITORY_CONTROL_SUPPRESSION_REASON: TerritoryIntentSuppressionReason =
  'controllerLevel';
export const AUTONOMOUS_TERRITORY_CONTROL_ABORT_REASON: TerritoryExpansionAbortReason = 'controllerLevelGate';

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
    controller.level >= getAutonomousTerritoryControlMinRcl()
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
    return false;
  }

  return isAutonomousTerritoryControlAllowedForController(room?.controller);
}

export function getAutonomousTerritoryControlMinRcl(): number {
  return isSeasonalRuntimeWorld()
    ? SEASONAL_AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL
    : AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL;
}
