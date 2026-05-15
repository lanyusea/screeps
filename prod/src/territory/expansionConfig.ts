import { TERRITORY_EXPANSION_ROOM_SELECTION } from '../config/roomSelection';

export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
  scoutOnly?: boolean;
}

export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] =
  TERRITORY_EXPANSION_ROOM_SELECTION.scoutTargets.map((target) => ({ ...target }));

export function isConfiguredExpansionScoutOnlyTarget(colony: string, roomName: string): boolean {
  return TERRITORY_EXPANSION_SCOUT_TARGETS.some(
    (target) => target.colony === colony && target.roomName === roomName && target.scoutOnly === true
  );
}
