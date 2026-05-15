import {
  STATIC_EXPANSION_SCOUT_TARGETS,
  type StaticExpansionScoutTargetConfig
} from '../config/roomConfig';

export type TerritoryExpansionScoutTargetConfig = StaticExpansionScoutTargetConfig;

export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] =
  STATIC_EXPANSION_SCOUT_TARGETS;

export function isConfiguredExpansionScoutOnlyTarget(colony: string, roomName: string): boolean {
  return TERRITORY_EXPANSION_SCOUT_TARGETS.some(
    (target) => target.colony === colony && target.roomName === roomName && target.scoutOnly === true
  );
}
