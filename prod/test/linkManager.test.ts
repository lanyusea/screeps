import {
  classifyLinks,
  getSourceLinkWorkerEnergyAvailable,
  STORAGE_LINK_ROUTING_TARGET_RATIO,
  transferEnergy,
  transferInterRoomEnergy
} from '../src/economy/linkManager';

const OK_CODE = 0 as ScreepsReturnCode;
type TestStructureLink = StructureLink & { transferEnergy: jest.Mock };

describe('linkManager', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      FIND_SOURCES: 2,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_LINK: 'link',
      STRUCTURE_SPAWN: 'spawn',
      STRUCTURE_STORAGE: 'storage'
    });
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('handles rooms with no links', () => {
    const room = makeRoom({ sources: [makeSource('source1', 10, 10)] });

    expect(transferEnergy(room)).toEqual([]);
  });

  it('classifies source, controller, and storage links by room-local positions', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 800);
    const storageLink = makeLink('storage-link', 20, 21, 0, 800);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [storageLink, controllerLink, sourceLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 5_000)
    });

    expect(classifyLinks(room)).toMatchObject({
      sourceLinks: [{ id: 'source-link' }],
      controllerLink: { id: 'controller-link' },
      storageLink: { id: 'storage-link' }
    });
  });

  it('transfers source link energy to the controller link before storage surplus', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const storageLink = makeLink('storage-link', 20, 21, 0, 800);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 5_000)
    });

    expect(transferEnergy(room)).toEqual([
      {
        amount: 300,
        destinationId: 'controller-link',
        destinationRole: 'controller',
        result: OK_CODE,
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(controllerLink, 300);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalledWith(storageLink, expect.any(Number));
  });

  it('falls back to the storage link when the controller link is full', () => {
    const sourceLink = makeLink('source-link', 11, 10, 250, 550);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const storageLink = makeLink('storage-link', 20, 21, 0, 200);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 5_000)
    });

    expect(transferEnergy(room)).toMatchObject([
      {
        amount: 200,
        destinationId: 'storage-link',
        destinationRole: 'storage',
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(storageLink, 200);
  });

  it('routes source link energy to a spawn-side link when spawn extensions need refill', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const spawnLink = makeLink('spawn-link', 6, 5, 0, 800);
    const spawn = makeSpawn('spawn1', 5, 5);
    const room = makeRoom({
      controller: makeController(25, 25),
      energyAvailable: 300,
      energyCapacityAvailable: 800,
      links: [sourceLink, controllerLink, spawnLink],
      sources: [makeSource('source1', 10, 10)],
      spawns: [spawn]
    });

    expect(transferEnergy(room)).toEqual([
      {
        amount: 400,
        destinationId: 'spawn-link',
        destinationRole: 'spawn',
        result: OK_CODE,
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(spawnLink, 400);
  });

  it('does not route source link energy to a spawn-side link when room energy is full', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const spawnLink = makeLink('spawn-link', 6, 5, 0, 800);
    const spawn = makeSpawn('spawn1', 5, 5);
    const room = makeRoom({
      controller: makeController(25, 25),
      energyAvailable: 800,
      energyCapacityAvailable: 800,
      links: [sourceLink, controllerLink, spawnLink],
      sources: [makeSource('source1', 10, 10)],
      spawns: [spawn]
    });

    expect(transferEnergy(room)).toEqual([]);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('respects source cooldown and empty or full link edge cases', () => {
    const coolingSourceLink = makeLink('cooling-source', 11, 10, 400, 400, 3);
    const emptySourceLink = makeLink('empty-source', 11, 12, 0, 800);
    const fullControllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [coolingSourceLink, emptySourceLink, fullControllerLink],
      sources: [makeSource('source1', 10, 10)]
    });

    expect(transferEnergy(room)).toEqual([]);
    expect(coolingSourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(emptySourceLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('prioritizes the closest source links when filling controller capacity', () => {
    const sourceLinkA = makeLink('source-a', 11, 10, 400, 400);
    const sourceLinkB = makeLink('source-b', 13, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 500);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLinkB, controllerLink, sourceLinkA],
      sources: [makeSource('source1', 10, 10), makeSource('source2', 14, 10)]
    });

    expect(transferEnergy(room)).toMatchObject([
      { amount: 400, sourceId: 'source-b', destinationId: 'controller-link' },
      { amount: 100, sourceId: 'source-a', destinationId: 'controller-link' }
    ]);
    expect(sourceLinkB.transferEnergy).toHaveBeenCalledWith(controllerLink, 400);
    expect(sourceLinkA.transferEnergy).toHaveBeenCalledWith(controllerLink, 100);
  });

  it('sends surplus source link energy to storage after controller demand is covered', () => {
    const controllerSourceLink = makeLink('source-controller', 23, 22, 100, 700);
    const surplusSourceLink = makeLink('source-surplus', 11, 10, 800, 0);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 100);
    const storageLink = makeLink('storage-link', 20, 21, 0, 800);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [surplusSourceLink, storageLink, controllerSourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10), makeSource('source2', 23, 21)],
      storage: makeStorage('storage1', 20, 20, 5_000, 10_000)
    });

    expect(transferEnergy(room)).toMatchObject([
      {
        amount: 100,
        destinationId: 'controller-link',
        destinationRole: 'controller',
        sourceId: 'source-controller'
      },
      {
        amount: 800,
        destinationId: 'storage-link',
        destinationRole: 'storage',
        sourceId: 'source-surplus'
      }
    ]);
    expect(controllerSourceLink.transferEnergy).toHaveBeenCalledWith(controllerLink, 100);
    expect(surplusSourceLink.transferEnergy).toHaveBeenCalledWith(storageLink, 800);
  });

  it('does not send surplus to the storage link when storage is full', () => {
    const sourceLink = makeLink('source-link', 11, 10, 250, 550);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const storageLink = makeLink('storage-link', 20, 21, 0, 800);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 1_000_000, 0)
    });

    expect(transferEnergy(room)).toEqual([]);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('routes source energy to storage while known storage is below the link routing target', () => {
    const sourceLink = makeLink('source-link', 11, 10, 250, 550);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const storageLink = makeLink('storage-link', 20, 21, 0, 200);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 2_000, 8_000, 10_000)
    });

    expect(transferEnergy(room)).toMatchObject([
      {
        amount: 200,
        destinationId: 'storage-link',
        destinationRole: 'storage',
        sourceId: 'source-link'
      }
    ]);
    expect(sourceLink.transferEnergy).toHaveBeenCalledWith(storageLink, 200);
  });

  it('does not route source energy to storage when known storage is above the link routing target', () => {
    const sourceLink = makeLink('source-link', 11, 10, 250, 550);
    const controllerLink = makeLink('controller-link', 25, 23, 800, 0);
    const storageLink = makeLink('storage-link', 20, 21, 0, 200);
    const capacity = 10_000;
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage(
        'storage1',
        20,
        20,
        Math.ceil(capacity * STORAGE_LINK_ROUTING_TARGET_RATIO),
        7_000,
        capacity
      )
    });

    expect(transferEnergy(room)).toEqual([]);
    expect(sourceLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('does not double-reserve one source link for controller and storage routing demand', () => {
    const sourceLink = makeLink('source-link', 11, 10, 800, 0);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 100);
    const storageLink = makeLink('storage-link', 20, 21, 0, 400);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink, storageLink],
      sources: [makeSource('source1', 10, 10)],
      storage: makeStorage('storage1', 20, 20, 2_000, 8_000, 10_000)
    });

    expect(getSourceLinkWorkerEnergyAvailable(room, sourceLink)).toBe(700);
  });

  it('does not reserve worker-withdrawable energy from cooling source links', () => {
    const sourceLink = makeLink('source-link', 11, 10, 800, 0, 3);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 500);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)]
    });

    expect(getSourceLinkWorkerEnergyAvailable(room, sourceLink)).toBe(800);
  });

  it('uses a precomputed link network for worker availability without finding links again', () => {
    const sourceLink = makeLink('source-link', 11, 10, 800, 0);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 500);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)]
    });
    const network = classifyLinks(room);
    (room.find as jest.Mock).mockClear();

    expect(getSourceLinkWorkerEnergyAvailable(room, sourceLink, network)).toBe(300);
    expect(room.find).not.toHaveBeenCalled();
  });

  it('does not issue cross-room link transfers toward import rooms', () => {
    const sourceStorageLink = makeLink('source-storage-link', 20, 21, 600, 200, 0, 'W1N1');
    const highDeficitSpawnLink = makeLink('high-deficit-spawn-link', 6, 5, 0, 300, 0, 'W2N1');
    const lowDeficitStorageLink = makeLink('low-deficit-storage-link', 20, 21, 0, 800, 0, 'W3N1');
    const sourceRoom = makeRoom({
      roomName: 'W1N1',
      links: [sourceStorageLink],
      storage: makeStorage('source-storage', 20, 20, 900, 100, 1_000, 'W1N1')
    });
    const highDeficitRoom = makeRoom({
      roomName: 'W2N1',
      energyAvailable: 100,
      energyCapacityAvailable: 300,
      links: [highDeficitSpawnLink],
      spawns: [makeSpawn('Spawn2', 5, 5, 'W2N1')],
      storage: makeStorage('high-deficit-storage', 20, 20, 100, 900, 1_000, 'W2N1')
    });
    const lowDeficitRoom = makeRoom({
      roomName: 'W3N1',
      links: [lowDeficitStorageLink],
      storage: makeStorage('low-deficit-storage', 20, 20, 200, 800, 1_000, 'W3N1')
    });
    installStorageBalance({
      rooms: {
        W1N1: makeStorageBalanceRoom('W1N1', 'export', 600, 0),
        W2N1: makeStorageBalanceRoom('W2N1', 'import', 0, 700),
        W3N1: makeStorageBalanceRoom('W3N1', 'import', 0, 200)
      },
      transfers: [
        { sourceRoom: 'W1N1', targetRoom: 'W3N1', amount: 200, updatedAt: 100 },
        { sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 300, updatedAt: 100 }
      ]
    });

    expect(transferInterRoomEnergy([sourceRoom, lowDeficitRoom, highDeficitRoom])).toEqual([]);
    expect(sourceStorageLink.transferEnergy).not.toHaveBeenCalled();
    expect(sourceStorageLink.transferEnergy).not.toHaveBeenCalledWith(highDeficitSpawnLink, expect.any(Number));
    expect(sourceStorageLink.transferEnergy).not.toHaveBeenCalledWith(lowDeficitStorageLink, expect.any(Number));
  });

  it('does not waste inter-room link energy on full destination links', () => {
    const sourceStorageLink = makeLink('source-storage-link', 20, 21, 400, 400, 0, 'W1N1');
    const fullTargetStorageLink = makeLink('target-storage-link', 20, 21, 800, 0, 0, 'W2N1');
    const sourceRoom = makeRoom({
      roomName: 'W1N1',
      links: [sourceStorageLink],
      storage: makeStorage('source-storage', 20, 20, 900, 100, 1_000, 'W1N1')
    });
    const targetRoom = makeRoom({
      roomName: 'W2N1',
      links: [fullTargetStorageLink],
      storage: makeStorage('target-storage', 20, 20, 100, 900, 1_000, 'W2N1')
    });
    installStorageBalance({
      rooms: {
        W1N1: makeStorageBalanceRoom('W1N1', 'export', 400, 0),
        W2N1: makeStorageBalanceRoom('W2N1', 'import', 0, 400)
      },
      transfers: [{ sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 400, updatedAt: 100 }]
    });

    expect(transferInterRoomEnergy([sourceRoom, targetRoom])).toEqual([]);
    expect(sourceStorageLink.transferEnergy).not.toHaveBeenCalled();
  });

  it('does not fill inter-room deficit links from additional cross-room export links', () => {
    const sourceStorageLink = makeLink('source-storage-link', 20, 21, 200, 600, 0, 'W1N1');
    const sourceHarvestLink = makeLink('source-harvest-link', 11, 10, 500, 300, 0, 'W1N1');
    const targetStorageLink = makeLink('target-storage-link', 20, 21, 0, 600, 0, 'W2N1');
    const sourceRoom = makeRoom({
      roomName: 'W1N1',
      links: [sourceStorageLink, sourceHarvestLink],
      sources: [makeSource('source1', 10, 10, 'W1N1')],
      storage: makeStorage('source-storage', 20, 20, 900, 100, 1_000, 'W1N1')
    });
    const targetRoom = makeRoom({
      roomName: 'W2N1',
      links: [targetStorageLink],
      storage: makeStorage('target-storage', 20, 20, 100, 900, 1_000, 'W2N1')
    });
    installStorageBalance({
      rooms: {
        W1N1: makeStorageBalanceRoom('W1N1', 'export', 700, 0),
        W2N1: makeStorageBalanceRoom('W2N1', 'import', 0, 700)
      },
      transfers: [{ sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 700, updatedAt: 100 }]
    });

    expect(transferInterRoomEnergy([sourceRoom, targetRoom])).toEqual([]);
    expect(sourceStorageLink.transferEnergy).not.toHaveBeenCalled();
    expect(sourceHarvestLink.transferEnergy).not.toHaveBeenCalled();
  });
});

function makeRoom({
  roomName = 'W1N1',
  controller,
  energyAvailable,
  energyCapacityAvailable,
  links = [],
  sources = [],
  spawns = [],
  storage
}: {
  roomName?: string;
  controller?: StructureController;
  energyAvailable?: number;
  energyCapacityAvailable?: number;
  links?: TestStructureLink[];
  sources?: Source[];
  spawns?: StructureSpawn[];
  storage?: StructureStorage;
}): Room {
  const roomController = controller ?? makeController(25, 25, roomName);
  const structures = storage ? [...links, storage, ...spawns] : [...links, ...spawns];
  return {
    name: roomName,
    controller: roomController,
    ...(typeof energyAvailable === 'number' ? { energyAvailable } : {}),
    ...(typeof energyCapacityAvailable === 'number' ? { energyCapacityAvailable } : {}),
    ...(storage ? { storage } : {}),
    find: jest.fn((type: number) => {
      if (type === FIND_MY_STRUCTURES) {
        return structures;
      }

      if (type === FIND_SOURCES) {
        return sources;
      }

      return [];
    })
  } as unknown as Room;
}

function makeLink(
  id: string,
  x: number,
  y: number,
  energy: number,
  freeCapacity: number,
  cooldown = 0,
  roomName = 'W1N1'
): TestStructureLink {
  return {
    id,
    cooldown,
    room: { name: roomName },
    structureType: 'link',
    pos: makeRoomPosition(x, y, roomName),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    },
    transferEnergy: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as TestStructureLink;
}

function makeStorage(
  id: string,
  x: number,
  y: number,
  energy: number,
  freeCapacity = 100_000,
  capacity?: number,
  roomName = 'W1N1'
): StructureStorage {
  return {
    id,
    structureType: 'storage',
    pos: makeRoomPosition(x, y, roomName),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      ...(capacity === undefined ? {} : { getCapacity: jest.fn().mockReturnValue(capacity) }),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    }
  } as unknown as StructureStorage;
}

function makeSource(id: string, x: number, y: number, roomName = 'W1N1'): Source {
  return { id, pos: makeRoomPosition(x, y, roomName) } as unknown as Source;
}

function makeController(x: number, y: number, roomName = 'W1N1'): StructureController {
  return { id: `${roomName}-controller`, my: true, pos: makeRoomPosition(x, y, roomName) } as unknown as StructureController;
}

function makeSpawn(id: string, x: number, y: number, roomName = 'W1N1'): StructureSpawn {
  return {
    id,
    name: id,
    structureType: 'spawn',
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as StructureSpawn;
}

function installStorageBalance({
  rooms,
  transfers,
  updatedAt = 100
}: {
  rooms: Record<string, EconomyStorageBalanceRoomMemory>;
  transfers: EconomyStorageTransferMemory[];
  updatedAt?: number;
}): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = { time: updatedAt };
  (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
    economy: {
      storageBalance: {
        rooms,
        transfers,
        updatedAt
      }
    }
  };
}

function makeStorageBalanceRoom(
  roomName: string,
  mode: EconomyStorageBalanceMode,
  exportableEnergy: number,
  importDemand: number
): EconomyStorageBalanceRoomMemory {
  return {
    roomName,
    mode,
    energy: 0,
    capacity: 1_000,
    ratio: 0,
    exportableEnergy,
    importDemand,
    updatedAt: 100
  };
}

function makeRoomPosition(x: number, y: number, roomName = 'W1N1'): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}
