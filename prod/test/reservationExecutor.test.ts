import {
  createExpansionIntent,
  type ExpansionPlannerCandidate
} from '../src/territory/expansionPlanner';
import { runReservationExecutor } from '../src/territory/reservationExecutor';
import { OCCUPIED_CONTROLLER_SIGN_TEXT } from '../src/territory/controllerSigning';
import { TERRITORY_RESERVATION_RENEWAL_TICKS } from '../src/territory/territoryPlanner';

describe('reservation executor', () => {
  beforeEach(() => {
    (globalThis as unknown as { CLAIM: BodyPartConstant }).CLAIM = 'claim';
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 1;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 2;
    (globalThis as unknown as { RoomPosition: RoomPositionConstructor }).RoomPosition = class {
      constructor(
        public readonly x: number,
        public readonly y: number,
        public readonly roomName: string
      ) {}
    } as RoomPositionConstructor;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 300,
      rooms: {},
      creeps: {},
      getObjectById: jest.fn().mockReturnValue(null),
      map: {
        findRoute: jest.fn(() => [{ exit: 3, room: 'W2N1' }])
      } as unknown as GameMap
    };
  });

  afterEach(() => {
    delete (globalThis as { CLAIM?: BodyPartConstant }).CLAIM;
    delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
    delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
    delete (globalThis as { RoomPosition?: RoomPositionConstructor }).RoomPosition;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('assigns an available claimer to the highest-priority expansion reservation by rank and distance', () => {
    const colonyRoom = makeOwnedRoom('W1N1');
    const nearController = makeController('controller-near' as Id<StructureController>);
    const priorityController = makeController('controller-priority' as Id<StructureController>);
    const nearRoom = makeTargetRoom('W2N1', nearController);
    const priorityRoom = makeTargetRoom('W3N1', priorityController);
    (Game.rooms as Record<string, Room>) = {
      W1N1: colonyRoom,
      W2N1: nearRoom,
      W3N1: priorityRoom
    };
    (Game.getObjectById as jest.Mock).mockImplementation((id: Id<StructureController>) => {
      if (id === nearController.id) {
        return nearController;
      }

      return id === priorityController.id ? priorityController : null;
    });
    createExpansionIntent(makeExpansionCandidate('W2N1', nearController.id), 'reserve', 290);
    createExpansionIntent(makeExpansionCandidate('W3N1', priorityController.id), 'reserve', 291);
    Memory.territory = {
      ...Memory.territory,
      expansionCandidates: [
        makeExpansionCandidateMemory('W3N1', 1, 1_900, priorityController.id),
        makeExpansionCandidateMemory('W2N1', 2, 1_900, nearController.id)
      ],
      routeDistances: {
        'W1N1>W2N1': 1,
        'W1N1>W3N1': 3
      }
    };
    const creep = makeClaimer(colonyRoom);

    expect(runReservationExecutor(creep)).toBe(true);

    expect(creep.memory.territory).toEqual({
      targetRoom: 'W3N1',
      action: 'reserve',
      controllerId: priorityController.id
    });
    expect(creep.moveTo).toHaveBeenCalledWith(priorityController);
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(Memory.territory?.intents).toContainEqual({
      colony: 'W1N1',
      targetRoom: 'W3N1',
      action: 'reserve',
      status: 'active',
      updatedAt: 300,
      createdBy: 'expansionPlanner',
      controllerId: priorityController.id
    });
  });

  it('waits on healthy reservations and renews once ticks fall under the renewal threshold', () => {
    const colonyRoom = makeOwnedRoom('W1N1');
    const controller = makeController('controller-renew' as Id<StructureController>, {
      reservationUsername: 'me',
      reservationTicksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 100,
      signText: OCCUPIED_CONTROLLER_SIGN_TEXT
    });
    const targetRoom = makeTargetRoom('W2N1', controller);
    (Game.rooms as Record<string, Room>) = {
      W1N1: colonyRoom,
      W2N1: targetRoom
    };
    (Game.getObjectById as jest.Mock).mockReturnValue(controller);
    createExpansionIntent(makeExpansionCandidate('W2N1', controller.id), 'reserve', 390);
    const creep = makeClaimer(colonyRoom);

    expect(runReservationExecutor(creep)).toBe(false);
    expect(creep.memory.territory).toBeUndefined();
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(Memory.territory?.reservations?.['W1N1>W2N1']).toEqual({
      colony: 'W1N1',
      roomName: 'W2N1',
      ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 100,
      updatedAt: 300,
      controllerId: controller.id
    });

    (Game as { time: number }).time = 301;
    controller.reservation = {
      username: 'me',
      ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS - 1
    };
    creep.room = targetRoom;

    expect(runReservationExecutor(creep)).toBe(true);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(Memory.territory?.intents).toContainEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'active',
      updatedAt: 301,
      createdBy: 'expansionPlanner',
      controllerId: controller.id
    });
  });

  it('assigns a healthy own reservation when the visible controller needs signing', () => {
    const colonyRoom = makeOwnedRoom('W1N1');
    const controller = makeController('controller-sign' as Id<StructureController>, {
      reservationUsername: 'me',
      reservationTicksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 100,
      signText: 'not ours'
    });
    const targetRoom = makeTargetRoom('W2N1', controller);
    (Game.rooms as Record<string, Room>) = {
      W1N1: colonyRoom,
      W2N1: targetRoom
    };
    (Game.getObjectById as jest.Mock).mockReturnValue(controller);
    createExpansionIntent(makeExpansionCandidate('W2N1', controller.id), 'reserve', 390);
    const creep = makeClaimer(targetRoom);

    expect(runReservationExecutor(creep)).toBe(true);

    expect(creep.memory.territory).toBeUndefined();
    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(Memory.territory?.intents).toContainEqual({
      colony: 'W1N1',
      targetRoom: 'W2N1',
      action: 'reserve',
      status: 'planned',
      updatedAt: 300,
      createdBy: 'expansionPlanner',
      controllerId: controller.id
    });
  });

  it('does not assign reservation execution when the colony cannot afford a claimer body', () => {
    const colonyRoom = makeOwnedRoom('W1N1', { energyAvailable: 300, energyCapacityAvailable: 650 });
    const controller = makeController('controller-low-energy' as Id<StructureController>);
    const targetRoom = makeTargetRoom('W2N1', controller);
    (Game.rooms as Record<string, Room>) = {
      W1N1: colonyRoom,
      W2N1: targetRoom
    };
    (Game.getObjectById as jest.Mock).mockReturnValue(controller);
    createExpansionIntent(makeExpansionCandidate('W2N1', controller.id), 'reserve', 295);
    const creep = makeClaimer(colonyRoom);

    expect(runReservationExecutor(creep)).toBe(false);

    expect(creep.memory.territory).toBeUndefined();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'planned',
        updatedAt: 295,
        createdBy: 'expansionPlanner',
        controllerId: controller.id
      }
    ]);
  });
});

type RoomPositionConstructor = new (x: number, y: number, roomName: string) => RoomPosition;

type MockReservationCreep = Creep & {
  moveTo: jest.Mock;
  reserveController: jest.Mock<ScreepsReturnCode, [StructureController]>;
  signController: jest.Mock<ScreepsReturnCode, [StructureController, string]>;
};

function makeOwnedRoom(
  roomName: string,
  {
    energyAvailable = 650,
    energyCapacityAvailable = 650
  }: { energyAvailable?: number; energyCapacityAvailable?: number } = {}
): Room {
  return {
    name: roomName,
    energyAvailable,
    energyCapacityAvailable,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 3,
      ticksToDowngrade: 10_000
    } as StructureController,
    find: jest.fn(() => [])
  } as unknown as Room;
}

function makeTargetRoom(roomName: string, controller: StructureController): Room {
  return {
    name: roomName,
    controller,
    find: jest.fn(() => [])
  } as unknown as Room;
}

function makeController(
  id: Id<StructureController>,
  {
    reservationUsername,
    reservationTicksToEnd,
    signText
  }: { reservationUsername?: string; reservationTicksToEnd?: number; signText?: string } = {}
): StructureController {
  return {
    id,
    my: false,
    ...(reservationUsername
      ? { reservation: { username: reservationUsername, ticksToEnd: reservationTicksToEnd ?? 0 } }
      : {}),
    ...(signText
      ? { sign: { username: 'other', text: signText, time: 299, datetime: '2026-05-08T00:00:00.000Z' } }
      : {})
  } as StructureController;
}

function makeClaimer(room: Room): MockReservationCreep {
  return {
    name: 'Claimer1',
    owner: { username: 'me' },
    memory: {
      role: 'claimer',
      colony: 'W1N1'
    },
    room,
    body: [{ type: 'claim', hits: 100 }],
    getActiveBodyparts: jest.fn().mockReturnValue(1),
    moveTo: jest.fn(),
    reserveController: jest.fn().mockReturnValue(0 as ScreepsReturnCode),
    signController: jest.fn().mockReturnValue(0 as ScreepsReturnCode)
  } as unknown as MockReservationCreep;
}

function makeExpansionCandidate(
  roomName: string,
  controllerId: Id<StructureController>
): ExpansionPlannerCandidate {
  return {
    colony: 'W1N1',
    roomName,
    distance: 1,
    order: 0,
    score: 1_900,
    suitable: true,
    sourceCount: 2,
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    reasons: [],
    controllerId
  };
}

function makeExpansionCandidateMemory(
  roomName: string,
  rank: number,
  score: number,
  controllerId: Id<StructureController>
): TerritoryExpansionCandidateMemory {
  return {
    colony: 'W1N1',
    roomName,
    rank,
    score,
    evidenceStatus: 'sufficient',
    visible: true,
    updatedAt: 250,
    adjacentToOwnedRoom: true,
    recommendedAction: 'reserve',
    controllerId,
    sourceCount: 2
  };
}
