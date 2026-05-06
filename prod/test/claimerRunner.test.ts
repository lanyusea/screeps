import { runClaimer } from '../src/creeps/claimerRunner';
import { buildTerritoryControllerBody } from '../src/spawn/bodyBuilder';
import { EXPANSION_CLAIM_EXECUTION_TIMEOUT_TICKS } from '../src/territory/claimExecutor';
import { TERRITORY_RESERVATION_RENEWAL_TICKS } from '../src/territory/territoryPlanner';

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

  it('routes recommended expansion claimers toward the visible target controller', () => {
    const colonyRoom = makeColonyRoom();
    const controller = { id: 'controller1', my: false } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 519,
      rooms: {
        W1N1: colonyRoom,
        W2N1: { name: 'W2N1', controller } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(controller)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: makeRecommendedClaimMemory()
    };
    const creep = {
      name: 'Claimer1',
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

    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toMatchObject({
      claimStartedAt: 519,
      claimAttemptCount: 0
    });
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

  it('records successful recommended expansion claims and clears completed claim pressure', () => {
    const colonyRoom = makeColonyRoom();
    const controller = { id: 'controller1', my: false } as StructureController;
    const targetRoom = { name: 'W2N1', controller } as unknown as Room;
    const getObjectById = jest.fn().mockReturnValue(controller);
    const events: Parameters<typeof runClaimer>[1] = [];
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 520,
      rooms: {
        W1N1: colonyRoom,
        W2N1: targetRoom
      },
      getObjectById
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: makeRecommendedClaimMemory()
    };

    const creep = {
      name: 'Claimer1',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      claimController: jest.fn(() => {
        (controller as StructureController & { my: boolean }).my = true;
        return 0 as ScreepsReturnCode;
      }),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep, events);

    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.targets).toEqual([]);
    expect(Memory.territory?.intents).toEqual([]);
    expect(Memory.territory?.postClaimBootstraps?.W2N1).toMatchObject({
      colony: 'W1N1',
      roomName: 'W2N1',
      status: 'detected',
      claimedAt: 520,
      updatedAt: 520,
      controllerId: 'controller1'
    });
    expect((colonyRoom.memory.cachedExpansionSelection as unknown as Record<string, unknown>).claimExecution).toEqual({
      status: 'claimed',
      targetRoom: 'W2N1',
      updatedAt: 520,
      controllerId: 'controller1',
      creepName: 'Claimer1'
    });
  });

  it('keeps recommended expansion claims retryable after a missing CLAIM part failure', () => {
    const colonyRoom = makeColonyRoom();
    const controller = { id: 'controller1', my: false } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 521,
      rooms: {
        W1N1: colonyRoom,
        W2N1: { name: 'W2N1', controller } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(controller)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: makeRecommendedClaimMemory()
    };

    const creep = {
      name: 'Claimer1',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      body: [{ type: 'claim', hits: 0 }],
      getActiveBodyparts: jest.fn().mockReturnValue(0),
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.targets).toEqual([
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller1'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'planned',
        updatedAt: 521,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller1',
        lastAttemptAt: 521
      }
    ]);
    expect(
      (colonyRoom.memory.cachedExpansionSelection as unknown as Record<string, unknown>).claimExecution
    ).toBeUndefined();
  });

  it('suppresses and reports a recommended expansion claim after execution timeout', () => {
    const colonyRoom = makeColonyRoom();
    const controller = { id: 'controller1', my: false } as StructureController;
    const startedAt = 100;
    const timedOutAt = startedAt + EXPANSION_CLAIM_EXECUTION_TIMEOUT_TICKS;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: timedOutAt,
      rooms: {
        W1N1: colonyRoom,
        W2N1: { name: 'W2N1', controller } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(controller)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: makeRecommendedClaimMemory()
    };

    const creep = {
      name: 'Claimer1',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'claim',
          controllerId: 'controller1' as Id<StructureController>,
          claimStartedAt: startedAt
        } as CreepTerritoryMemory & { claimStartedAt: number }
      },
      room: { name: 'W2N1', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: timedOutAt,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller1',
        lastAttemptAt: timedOutAt
      }
    ]);
    expect((colonyRoom.memory.cachedExpansionSelection as unknown as Record<string, unknown>).claimExecution).toEqual({
      status: 'failed',
      targetRoom: 'W2N1',
      updatedAt: timedOutAt,
      controllerId: 'controller1',
      creepName: 'Claimer1',
      result: -7,
      reason: 'claimFailed'
    });
  });

  it('suppresses and reports a recommended expansion claim that times out before room entry', () => {
    const colonyRoom = makeColonyRoom();
    const startedAt = 100;
    const timedOutAt = startedAt + EXPANSION_CLAIM_EXECUTION_TIMEOUT_TICKS;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: timedOutAt,
      rooms: {
        W1N1: colonyRoom
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: makeRecommendedClaimMemory()
    };

    const creep = {
      name: 'Claimer1',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: {
          targetRoom: 'W2N1',
          action: 'claim',
          controllerId: 'controller1' as Id<StructureController>,
          claimStartedAt: startedAt
        } as CreepTerritoryMemory & { claimStartedAt: number }
      },
      room: { name: 'W1N1' },
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'suppressed',
        updatedAt: timedOutAt,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller1',
        lastAttemptAt: timedOutAt
      }
    ]);
    expect((colonyRoom.memory.cachedExpansionSelection as unknown as Record<string, unknown>).claimExecution).toEqual({
      status: 'failed',
      targetRoom: 'W2N1',
      updatedAt: timedOutAt,
      controllerId: 'controller1',
      creepName: 'Claimer1',
      result: -7,
      reason: 'claimFailed'
    });
  });

  it('treats an already-owned recommended expansion controller as a verified claim', () => {
    const colonyRoom = makeColonyRoom();
    const controller = { id: 'controller1', my: true } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 522,
      rooms: {
        W1N1: colonyRoom,
        W2N1: { name: 'W2N1', controller } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(controller)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: makeRecommendedClaimMemory()
    };

    const creep = {
      name: 'Claimer1',
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.targets).toEqual([]);
    expect(Memory.territory?.intents).toEqual([]);
    expect(
      (colonyRoom.memory.cachedExpansionSelection as unknown as Record<string, unknown>).claimExecution
    ).toMatchObject({
      status: 'claimed',
      targetRoom: 'W2N1',
      updatedAt: 522,
      controllerId: 'controller1'
    });
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

  it('reserves the target controller when in the target room', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 511,
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
        territory: { targetRoom: 'W2N1', action: 'reserve', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      reserveController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller1');
    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
  });

  it('renews an own reservation when it reaches the renewal window', () => {
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 512,
      rooms: {
        W2N1: { name: 'W2N1', controller } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(controller)
    };

    const creep = {
      name: 'Claimer1',
      owner: { username: 'me' },
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W2N1', action: 'reserve', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W2N1', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runClaimer(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({
      targetRoom: 'W2N1',
      action: 'reserve',
      controllerId: 'controller1'
    });
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

function makeColonyRoom(): Room & { memory: RoomMemory } {
  return {
    name: 'W1N1',
    memory: {
      cachedExpansionSelection: {
        status: 'planned',
        colony: 'W1N1',
        targetRoom: 'W2N1',
        controllerId: 'controller1' as Id<StructureController>,
        score: 1_000
      }
    }
  } as unknown as Room & { memory: RoomMemory };
}

function makeRecommendedClaimMemory(): TerritoryMemory {
  return {
    targets: [
      {
        colony: 'W1N1',
        roomName: 'W2N1',
        action: 'claim',
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller1' as Id<StructureController>
      }
    ],
    intents: [
      {
        colony: 'W1N1',
        targetRoom: 'W2N1',
        action: 'claim',
        status: 'active',
        updatedAt: 519,
        createdBy: 'nextExpansionScoring',
        controllerId: 'controller1' as Id<StructureController>
      }
    ]
  };
}
