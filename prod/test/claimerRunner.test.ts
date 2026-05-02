import { runClaimer } from '../src/creeps/claimerRunner';
import { buildTerritoryControllerBody } from '../src/spawn/bodyBuilder';

describe('runClaimer', () => {
  beforeEach(() => {
    (globalThis as unknown as { RoomPosition: typeof RoomPosition }).RoomPosition = jest.fn(
      (x: number, y: number, roomName: string) => ({ x, y, roomName }) as RoomPosition
    ) as unknown as typeof RoomPosition;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 500,
      getObjectById: jest.fn().mockReturnValue(null)
    } as Partial<Game>;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  it('moves to the target room before claiming', () => {
    const creep = {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W1N1' },
      moveTo: jest.fn(),
      claimController: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.moveTo).toHaveBeenCalledWith({ x: 25, y: 25, roomName: 'W2N1' });
    expect(creep.claimController).not.toHaveBeenCalled();
  });

  it('claims the target controller when in the target room', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 502,
      rooms: {
        W2N1: { name: 'W2N1', controller } as unknown as Room
      },
      getObjectById
    };

    const creep = {
      name: 'Claimer1',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      claimController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller1');
    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
  });

  it('keeps a large generated claimer body mobile enough to travel to the target', () => {
    const generatedBody = buildTerritoryControllerBody(2000);
    const movePartCount = generatedBody.filter((part) => part === 'move').length;
    const nonMovePartCount = generatedBody.filter((part) => part !== 'move').length;
    const upgradePairs = generatedBody.filter((part) => part === 'work').length;

    expect(nonMovePartCount).toBeLessThanOrEqual(movePartCount * 3);
    expect(movePartCount).toBe(1 + upgradePairs);

    const controller = { id: 'controller1', my: false } as StructureController;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 510,
      rooms: {
        W2N1: { name: 'W2N1', controller } as unknown as Room
      },
      getObjectById
    };

    const creep = {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      body: generatedBody.map((part) => ({ type: part, hits: 100 })),
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === 'claim' ? 1 : part === 'move' ? movePartCount : 0)),
      claimController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.claimController).toHaveBeenCalledWith(controller);
  });

  it('suppresses the claim assignment after a fatal claim result', () => {
    const controller = {
      id: 'controller1',
      my: false
    } as StructureController;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 510,
      rooms: {
        W2N1: {
          name: 'W2N1',
          controller
        } as Room
      },
      getObjectById
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W2N1',
            action: 'claim',
            status: 'planned',
            updatedAt: 501,
            controllerId: 'controller1' as Id<StructureController>
          }
        ]
      }
    };

    const creep = {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      claimController: jest.fn().mockReturnValue(-7),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 510,
        controllerId: 'controller1' as Id<StructureController>
      }
    ]);
  });
});
