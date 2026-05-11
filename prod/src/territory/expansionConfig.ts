export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
}

// Official deployment is retargeted to E24S49, so configured targets keep E24S49 as the colony key.
export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] = [
  {
    colony: 'E24S49',
    roomName: 'E24S50',
    nearestOwnedRoom: 'E24S49',
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true
  },
  {
    colony: 'E24S49',
    roomName: 'E26S47',
    nearestOwnedRoom: 'E24S48',
    nearestOwnedRoomDistance: 1,
    routeDistance: 2,
    adjacentToOwnedRoom: true
  }
];
