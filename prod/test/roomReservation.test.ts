import {
  reserveRoomForPlannedClaim,
  runPlannedClaimReservation
} from '../src/territory/roomReservation';

describe('room reservation', () => {
  beforeEach(() => {
    (globalThis as unknown as { CLAIM: BodyPartConstant }).CLAIM = 'claim';
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    delete (globalThis as { CLAIM?: BodyPartConstant }).CLAIM;
    delete (globalThis as { Game?: Partial<Game> }).Game;
    delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  });

  it('reserves a planned claim room when GCL room capacity is full', () => {
    const homeRoom = makeOwnedRoom('W1N1');
    const controller = makeNeutralController('W2N1');
    const targetRoom = makeTargetRoom('W2N1', controller);
    installGame({ W1N1: homeRoom, W2N1: targetRoom }, 1, 200);
    Memory.territory = {
      targets: [
        {
          colony: 'W1N1',
          roomName: 'W2N1',
          action: 'claim',
          createdBy: 'nextExpansionScoring',
          controllerId: controller.id
        }
      ],
      intents: [
        {
          colony: 'W1N1',
          targetRoom: 'W2N1',
          action: 'claim',
          status: 'active',
          updatedAt: 199,
          createdBy: 'nextExpansionScoring',
          controllerId: controller.id
        }
      ]
    };
    const creep = makeClaimCreep(targetRoom, controller, {
      reserveResult: 0 as ScreepsReturnCode
    });

    const result = reserveRoomForPlannedClaim(creep);

    expect(result).toEqual({
      status: 'reserved',
      result: 0,
      targetRoom: 'W2N1',
      controllerId: controller.id
    });
    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: controller.id
    });
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: controller.id
      },
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'reserve',
        controllerId: controller.id
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 200,
        createdBy: 'nextExpansionScoring',
        controllerId: controller.id
      },
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'reserve',
        status: 'active',
        updatedAt: 200,
        controllerId: controller.id
      }
    ]);
  });

  it('moves toward the controller when the reserve attempt is out of range', () => {
    const homeRoom = makeOwnedRoom('W1N1');
    const controller = makeNeutralController('W2N1');
    const targetRoom = makeTargetRoom('W2N1', controller);
    installGame({ W1N1: homeRoom, W2N1: targetRoom }, 1, 201);
    const creep = makeClaimCreep(targetRoom, controller, {
      reserveResult: -9 as ScreepsReturnCode
    });

    expect(runPlannedClaimReservation(creep)).toBe(true);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: controller.id
    });
  });

  it('leaves planned claim execution alone while GCL can still claim another room', () => {
    const homeRoom = makeOwnedRoom('W1N1');
    const controller = makeNeutralController('W2N1');
    const targetRoom = makeTargetRoom('W2N1', controller);
    installGame({ W1N1: homeRoom, W2N1: targetRoom }, 2, 202);
    const creep = makeClaimCreep(targetRoom, controller, {
      reserveResult: 0 as ScreepsReturnCode
    });

    expect(reserveRoomForPlannedClaim(creep)).toEqual({
      status: 'skipped',
      reason: 'gclAvailable',
      targetRoom: 'W2N1',
      controllerId: controller.id
    });
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({
      targetRoom: 'W2N1',
      action: 'claim',
      controllerId: controller.id
    });
  });
});

function installGame(
  rooms: Record<string, Room>,
  gclLevel: number,
  gameTime: number
): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: gameTime,
    rooms,
    gcl: { level: gclLevel } as GlobalControlLevel,
    getObjectById: jest.fn().mockReturnValue(null)
  };
}

function makeOwnedRoom(roomName: string): Room {
  return {
    name: roomName,
    controller: {
      id: `controller-${roomName}` as Id<StructureController>,
      my: true,
      owner: { username: 'me' },
      level: 3
    } as StructureController
  } as unknown as Room;
}

function makeTargetRoom(roomName: string, controller: StructureController): Room {
  return {
    name: roomName,
    controller
  } as unknown as Room;
}

function makeNeutralController(roomName: string): StructureController {
  return {
    id: `controller-${roomName}` as Id<StructureController>,
    my: false
  } as StructureController;
}

function makeClaimCreep(
  room: Room,
  controller: StructureController,
  {
    reserveResult
  }: {
    reserveResult: ScreepsReturnCode;
  }
): Creep & {
  reserveController: jest.Mock<ScreepsReturnCode, [StructureController]>;
  moveTo: jest.Mock;
} {
  return {
    owner: { username: 'me' },
    memory: {
      role: 'claimer',
      colony: 'W1N1',
      territory: {
        targetRoom: room.name,
        action: 'claim',
        controllerId: controller.id
      }
    },
    room,
    getActiveBodyparts: jest.fn().mockReturnValue(1),
    reserveController: jest.fn().mockReturnValue(reserveResult),
    moveTo: jest.fn()
  } as unknown as Creep & {
    reserveController: jest.Mock<ScreepsReturnCode, [StructureController]>;
    moveTo: jest.Mock;
  };
}
