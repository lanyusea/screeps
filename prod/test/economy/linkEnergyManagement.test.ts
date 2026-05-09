import {
  classifyLinks,
  getSourceLinkWorkerEnergyAvailable,
  transferEnergy
} from '../../src/economy/linkManager';

const OK_CODE = 0 as ScreepsReturnCode;

type TestStructureLink = StructureLink & { transferEnergy: jest.Mock };

describe('economy link energy management', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      FIND_MY_STRUCTURES: 1,
      FIND_SOURCES: 2,
      RESOURCE_ENERGY: 'energy',
      STRUCTURE_LINK: 'link',
      STRUCTURE_STORAGE: 'storage'
    });
  });

  afterEach(() => {
    delete (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
    delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
    delete (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
    delete (globalThis as { STRUCTURE_LINK?: StructureConstant }).STRUCTURE_LINK;
    delete (globalThis as { STRUCTURE_STORAGE?: StructureConstant }).STRUCTURE_STORAGE;
  });

  it('detects owned source and controller links from room structures', () => {
    const sourceLink = makeLink('source-link', 11, 10, 400, 400);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 800);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [controllerLink, sourceLink],
      sources: [makeSource('source1', 10, 10)]
    });

    expect(classifyLinks(room)).toMatchObject({
      links: [{ id: 'controller-link' }, { id: 'source-link' }],
      sourceLinks: [{ id: 'source-link' }],
      controllerLink: { id: 'controller-link' }
    });
  });

  it('routes source-adjacent link energy to controller capacity while respecting cooldown', () => {
    const coolingSourceLink = makeLink('cooling-source', 11, 10, 800, 0, 3);
    const readySourceLink = makeLink('ready-source', 15, 10, 500, 300);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [coolingSourceLink, readySourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10), makeSource('source2', 14, 10)]
    });

    expect(transferEnergy(room)).toEqual([
      {
        amount: 300,
        destinationId: 'controller-link',
        destinationRole: 'controller',
        result: OK_CODE,
        sourceId: 'ready-source'
      }
    ]);
    expect(coolingSourceLink.transferEnergy).not.toHaveBeenCalled();
    expect(readySourceLink.transferEnergy).toHaveBeenCalledWith(controllerLink, 300);
  });

  it('reserves controller-link routing energy from worker withdrawals', () => {
    const sourceLink = makeLink('source-link', 11, 10, 500, 300);
    const controllerLink = makeLink('controller-link', 25, 23, 0, 300);
    const room = makeRoom({
      controller: makeController(25, 25),
      links: [sourceLink, controllerLink],
      sources: [makeSource('source1', 10, 10)]
    });

    expect(getSourceLinkWorkerEnergyAvailable(room, sourceLink)).toBe(200);
  });
});

function makeRoom({
  roomName = 'W1N1',
  controller = makeController(25, 25, roomName),
  links,
  sources
}: {
  roomName?: string;
  controller?: StructureController;
  links: TestStructureLink[];
  sources: Source[];
}): Room {
  return {
    name: roomName,
    controller,
    find: jest.fn((type: number) => {
      if (type === FIND_MY_STRUCTURES) {
        return links;
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
    pos: makeRoomPosition(x, y, roomName),
    structureType: 'link',
    store: {
      getFreeCapacity: jest.fn(() => freeCapacity),
      getUsedCapacity: jest.fn(() => energy)
    },
    transferEnergy: jest.fn(() => OK_CODE)
  } as unknown as TestStructureLink;
}

function makeSource(id: string, x: number, y: number, roomName = 'W1N1'): Source {
  return {
    id,
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as Source;
}

function makeController(x: number, y: number, roomName = 'W1N1'): StructureController {
  return {
    id: `${roomName}-controller`,
    my: true,
    pos: makeRoomPosition(x, y, roomName)
  } as unknown as StructureController;
}

function makeRoomPosition(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}
