export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
}

// Legacy E17S59 corridor targets remain room-scoped; current E19S57 expansion targets need fresh intel before adding static config.
export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] = [
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
