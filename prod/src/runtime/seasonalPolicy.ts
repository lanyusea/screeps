import { getRuntimeFeatureGates } from './featureGates';

export const SEASONAL_AUTONOMOUS_TERRITORY_CONTROL_MIN_RCL = 3;
export const SEASONAL_ROOM_INDEPENDENCE_MIN_RCL = 3;
export const SEASONAL_IMMATURE_EXPANSION_PRECONDITION =
  'raise owned Seasonal expansion rooms to RCL3 before next claim';

interface ControllerLike {
  my?: boolean;
  level?: number;
  owner?: { username?: unknown };
}

interface RoomLike {
  name?: string;
  controller?: ControllerLike;
}

export function isSeasonalRuntimeWorld(): boolean {
  return getRuntimeFeatureGates().isSeasonal;
}

export function isOwnedControllerAtOrAboveSeasonalIndependenceRcl(
  controller: ControllerLike | undefined
): boolean {
  return controller?.my === true && getControllerLevel(controller) >= SEASONAL_ROOM_INDEPENDENCE_MIN_RCL;
}

export function isOwnedRoomBelowSeasonalIndependenceRcl(room: RoomLike | undefined): boolean {
  return room?.controller?.my === true && !isOwnedControllerAtOrAboveSeasonalIndependenceRcl(room.controller);
}

export function hasSeasonalImmatureOwnedExpansionRoom(
  homeRoomName: string,
  ownerUsername?: string
): boolean {
  if (!isSeasonalRuntimeWorld()) {
    return false;
  }

  const rooms = getGameRooms();
  if (!rooms) {
    return false;
  }

  return Object.values(rooms).some((room) => {
    if (!isOwnedRoom(room) || room.name === homeRoomName) {
      return false;
    }

    const roomOwnerUsername = getControllerOwnerUsername(room.controller);
    if (ownerUsername && roomOwnerUsername && roomOwnerUsername !== ownerUsername) {
      return false;
    }

    return !isOwnedControllerAtOrAboveSeasonalIndependenceRcl(room.controller);
  });
}

export function isInterRoomSupportAllowedForTargetRoom(targetRoomName: string): boolean {
  if (!isSeasonalRuntimeWorld()) {
    return true;
  }

  return isOwnedRoomBelowSeasonalIndependenceRcl(getGameRooms()?.[targetRoomName]);
}

export function isInterRoomSupportAllowed(sourceRoomName: string, targetRoomName: string): boolean {
  return sourceRoomName === targetRoomName || isInterRoomSupportAllowedForTargetRoom(targetRoomName);
}

function getGameRooms(): Game['rooms'] | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms;
}

function isOwnedRoom(room: RoomLike | undefined): room is RoomLike & { name: string; controller: ControllerLike } {
  return typeof room?.name === 'string' && room.name.length > 0 && room.controller?.my === true;
}

function getControllerLevel(controller: ControllerLike | undefined): number {
  const level = controller?.level;
  return typeof level === 'number' && Number.isFinite(level) ? Math.floor(level) : 0;
}

function getControllerOwnerUsername(controller: ControllerLike | undefined): string | undefined {
  const username = controller?.owner?.username;
  return typeof username === 'string' && username.length > 0 ? username : undefined;
}
