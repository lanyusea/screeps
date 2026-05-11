export interface TerritoryExpansionScoutTargetConfig {
  colony: string;
  roomName: string;
  nearestOwnedRoom: string;
  nearestOwnedRoomDistance: number;
  routeDistance: number;
  adjacentToOwnedRoom: boolean;
}

export const TERRITORY_EXPANSION_SCOUT_TARGETS: readonly TerritoryExpansionScoutTargetConfig[] = [
  {
    colony: 'E24S49',
    roomName: 'E26S50',
    nearestOwnedRoom: 'E24S49',
    nearestOwnedRoomDistance: 1,
    routeDistance: 1,
    adjacentToOwnedRoom: true
  },
  {
    colony: 'E24S49',
    roomName: 'E26S47',
    nearestOwnedRoom: 'E26S48',
    nearestOwnedRoomDistance: 1,
    routeDistance: 2,
    adjacentToOwnedRoom: true
  }
];
