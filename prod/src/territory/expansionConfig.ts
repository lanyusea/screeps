export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
  scoutOnly?: boolean;
}

// Static scout targets are room-scoped so official W3N9 intel refreshes do not retarget old recovery rooms.
export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] = [
  {
    colony: 'W3N9',
    roomName: 'W3N8',
    nearestOwnedRoom: 'W3N9',
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true,
    scoutOnly: true
  },
  {
    colony: 'W3N9',
    roomName: 'W2N9',
    nearestOwnedRoom: 'W3N9',
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true,
    scoutOnly: true
  },
  {
    colony: 'E17S59',
    roomName: 'E18S59',
    nearestOwnedRoom: 'E17S59',
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true
  },
  {
    colony: 'E17S59',
    roomName: 'E17S60',
    nearestOwnedRoom: 'E17S58',
    nearestOwnedRoomDistance: 1,
    routeDistance: 2,
    adjacentToOwnedRoom: true
  }
];

export function isConfiguredExpansionScoutOnlyTarget(colony: string, roomName: string): boolean {
  return TERRITORY_EXPANSION_SCOUT_TARGETS.some(
    (target) => target.colony === colony && target.roomName === roomName && target.scoutOnly === true
  );
}
