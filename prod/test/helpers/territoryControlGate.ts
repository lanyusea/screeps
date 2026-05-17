export function makeVisibleOwnedRcl6ColonyRoom(roomName = 'W1N1'): Room {
  return {
    name: roomName,
    controller: {
      my: true,
      level: 6,
      owner: { username: 'me' },
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn().mockReturnValue([])
  } as unknown as Room;
}

export function ensureVisibleOwnedRcl6ColonyRoom(
  colonyName = 'W1N1',
  room: Room = makeVisibleOwnedRcl6ColonyRoom(colonyName)
): Room {
  const globalScope = globalThis as unknown as { Game?: Partial<Game> };
  const currentGame = globalScope.Game ?? {};
  const currentRooms = currentGame.rooms ?? {};
  const colonyRoom = currentRooms[colonyName] ?? room;

  globalScope.Game = {
    ...currentGame,
    rooms: {
      ...currentRooms,
      [colonyName]: colonyRoom
    }
  };

  return colonyRoom;
}

export function installVisibleOwnedRcl6ColonyRoomDefault(colonyName = 'W1N1'): Room {
  const globalScope = globalThis as unknown as { Game?: Partial<Game> };
  const defaultRoom = makeVisibleOwnedRcl6ColonyRoom(colonyName);
  let gameValue = withVisibleOwnedRcl6ColonyRoom(globalScope.Game ?? {}, colonyName, defaultRoom);

  Object.defineProperty(globalThis, 'Game', {
    configurable: true,
    get: () => gameValue,
    set: (nextGame: Partial<Game> | undefined) => {
      gameValue = withVisibleOwnedRcl6ColonyRoom(nextGame ?? {}, colonyName, defaultRoom);
    }
  });

  globalScope.Game = gameValue;
  return defaultRoom;
}

function withVisibleOwnedRcl6ColonyRoom(
  game: Partial<Game>,
  colonyName: string,
  defaultRoom: Room
): Partial<Game> {
  const rooms = game.rooms ?? {};
  return {
    ...game,
    rooms: {
      ...rooms,
      [colonyName]: rooms[colonyName] ?? defaultRoom
    }
  };
}
