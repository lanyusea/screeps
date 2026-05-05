import { classifyLinks, transferEnergy } from '../src/economy/linkManager';

const OK_CODE = 0 as ScreepsReturnCode;
type TestStructureLink = StructureLink & { transferEnergy: jest.Mock };

describe('linkManager', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      FIND_SOURCES: 2,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_LINK: 'link',
      STRUCTURE_STORAGE: 'storage'
    });
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

  it('transfers source link energy to the controller link first', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)]
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

  it('tracks projected destination capacity across multiple source links', () => {
    const sourceLinkA = makeLink('source-a', 11, 10, 400, 400);
    const sourceLinkB = makeLink('source-b', 13, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 500);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLinkB, controllerLink, sourceLinkA],
      sources: [makeSource('source1', 10, 10), makeSource('source2', 14, 10)]
    });

    expect(transferEnergy(room)).toMatchObject([
      { amount: 400, sourceId: 'source-a', destinationId: 'controller-link' },
      { amount: 100, sourceId: 'source-b', destinationId: 'controller-link' }
    ]);
    expect(sourceLinkA.transferEnergy).toHaveBeenCalledWith(controllerLink, 400);
    expect(sourceLinkB.transferEnergy).toHaveBeenCalledWith(controllerLink, 100);
  });
});

function makeRoom({
  controller = makeController(25, 25),
  links = [],
  sources = [],
  storage
}: {
  controller?: StructureController;
  links?: TestStructureLink[];
  sources?: Source[];
  storage?: StructureStorage;
}): Room {
  const structures = storage ? [...links, storage] : links;
  return {
    name: 'W1N1',
    controller,
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
  cooldown = 0
): TestStructureLink {
  return {
    id,
    cooldown,
    structureType: 'link',
    pos: makeRoomPosition(x, y),
    store: {
      getFreeCapacity: jest.fn().mockReturnValue(freeCapacity),
      getUsedCapacity: jest.fn().mockReturnValue(energy)
    },
    transferEnergy: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as TestStructureLink;
}

function makeStorage(id: string, x: number, y: number, energy: number): StructureStorage {
  return {
    id,
    structureType: 'storage',
    pos: makeRoomPosition(x, y),
    store: { getUsedCapacity: jest.fn().mockReturnValue(energy) }
  } as unknown as StructureStorage;
}

function makeSource(id: string, x: number, y: number): Source {
  return { id, pos: makeRoomPosition(x, y) } as unknown as Source;
}

function makeController(x: number, y: number): StructureController {
  return { id: 'controller1', my: true, pos: makeRoomPosition(x, y) } as unknown as StructureController;
}

function makeRoomPosition(x: number, y: number): RoomPosition {
  return { x, y, roomName: 'W1N1' } as RoomPosition;
}
