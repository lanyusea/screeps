export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
}

// Official deployment is retargeted to E17S59, so configured targets keep E17S59 as the colony key.
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
