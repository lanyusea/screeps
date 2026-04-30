import {
  TERRITORY_RESERVATION_COMFORT_TICKS,
  TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS,
  TERRITORY_RESERVATION_RENEWAL_TICKS
} from '../src/territory/territoryPlanner';
import { OCCUPIED_CONTROLLER_SIGN_TEXT } from '../src/territory/controllerSigning';
import { runTerritoryControllerCreep } from '../src/territory/territoryRunner';

describe('runTerritoryControllerCreep', () => {
  beforeEach(() => {
    (globalThis as unknown as { FIND_HOSTILE_CREEPS: number }).FIND_HOSTILE_CREEPS = 6;
    (globalThis as unknown as { FIND_HOSTILE_STRUCTURES: number }).FIND_HOSTILE_STRUCTURES = 7;
    (globalThis as unknown as { RoomPosition: typeof RoomPosition }).RoomPosition = jest.fn(
      (x: number, y: number, roomName: string) => ({ x, y, roomName }) as RoomPosition
    ) as unknown as typeof RoomPosition;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 500,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  it('moves toward the target room before touching the controller', () => {
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N1' },
      moveTo: jest.fn(),
      reserveController: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.moveTo).toHaveBeenCalledWith({ x: 25, y: 25, roomName: 'W1N2' });
    expect(creep.reserveController).not.toHaveBeenCalled();
  });

  it('moves toward a visible target controller before entering the target room', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 500,
      rooms: {
        W1N2: { name: 'W1N2', controller, find: jest.fn().mockReturnValue([]) } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N1' },
      moveTo: jest.fn(),
      reserveController: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.reserveController).not.toHaveBeenCalled();
  });

  it('suppresses and does not move toward a visible hostile target room', () => {
    const hostile = { id: 'enemy1' } as Creep;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 501,
      rooms: {
        W1N2: {
          name: 'W1N2',
          controller: { id: 'controller1', my: false } as StructureController,
          find: jest.fn((type: number) => (type === FIND_HOSTILE_CREEPS ? [hostile] : []))
        } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [{ colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve', status: 'active', updatedAt: 500 }]
      }
    };
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N1' },
      moveTo: jest.fn(),
      reserveController: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      { colony: 'W1N1', targetRoom: 'W1N2', action: 'reserve', status: 'suppressed', updatedAt: 501 }
    ]);
  });

  it('keeps scout target attribution after entering the target room', () => {
    const creep = {
      memory: { role: 'scout', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'scout' } },
      room: { name: 'W1N2' },
      moveTo: jest.fn(),
      signController: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'scout' });
    expect(Memory.territory).toBeUndefined();
  });

  it('reserves the target room controller and moves into range when needed', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      reserveController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve' });
    expect(Memory.territory).toBeUndefined();
  });

  it('continues a visible own reservation above the normal renewal threshold with enough CLAIM parts', () => {
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS + 1 }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve' });
  });

  it('lets a one-CLAIM reserver renew at the normal renewal threshold', () => {
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_RENEWAL_TICKS }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve' });
  });

  it('lets a one-CLAIM reserver renew at the emergency threshold', () => {
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_EMERGENCY_RENEWAL_TICKS }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve' });
  });

  it('keeps a visible comfortably safe own reservation active without working it or suppressing it', () => {
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'me', ticksToEnd: TERRITORY_RESERVATION_COMFORT_TICKS + 1 }
    } as StructureController;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 500
          }
        ]
      }
    };
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(2),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve' });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 500
      }
    ]);
  });

  it('claims a configured controller id when claim action is requested', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    const getObjectById = jest.fn().mockReturnValue(controller);
    (globalThis as unknown as { Game: Partial<Game> }).Game = { time: 502, getObjectById };
    const creep = {
      memory: {
        role: 'claimer',
        colony: 'W1N1',
        territory: { targetRoom: 'W1N2', action: 'claim', controllerId: 'controller1' as Id<StructureController> }
      },
      room: { name: 'W1N2', controller: { id: 'fallback', my: false } as StructureController },
      claimController: jest.fn().mockReturnValue(0),
      signController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller1');
    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('moves a claimer into range without suppressing the target', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N2', controller },
      claimController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'claim' });
    expect(Memory.territory).toBeUndefined();
  });

  it('pressures a foreign reservation before trying to claim the controller', () => {
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(5),
      attackController: jest.fn().mockReturnValue(0),
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.attackController).toHaveBeenCalledWith(controller);
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'claim' });
    expect(Memory.territory).toBeUndefined();
  });

  it('suppresses a foreign-reserved claim assignment when the claimer lacks pressure parts', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 503,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'claim',
            status: 'active',
            updatedAt: 502
          }
        ]
      }
    };
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      attackController: jest.fn(),
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.attackController).not.toHaveBeenCalled();
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 503
      }
    ]);
  });

  it('moves a claim-pressure creep into range before claiming a foreign-reserved controller', () => {
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(5),
      attackController: jest.fn().mockReturnValue(-9),
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.attackController).toHaveBeenCalledWith(controller);
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'claim' });
    expect(Memory.territory).toBeUndefined();
  });

  it('suppresses an unworkable follow-up claim assignment so the planner stops requeueing it', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const activeIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'claim',
      status: 'active',
      updatedAt: 511,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 512,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { intents: [activeIntent] }
    };
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim', followUp } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(0),
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        ...activeIntent,
        status: 'suppressed',
        updatedAt: 512
      }
    ]);
  });

  it('suppresses an unworkable follow-up reserve assignment so the planner stops requeueing it', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedReserveAdjacent',
      originRoom: 'W1N1',
      originAction: 'reserve'
    };
    const activeIntent: TerritoryIntentMemory = {
      colony: 'W1N1',
      targetRoom: 'W1N2',
      action: 'reserve',
      status: 'active',
      updatedAt: 513,
      followUp
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 514,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { intents: [activeIntent] }
    };
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve', followUp } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(0),
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        ...activeIntent,
        status: 'suppressed',
        updatedAt: 514
      }
    ]);
  });

  it('clears completed claim assignments without suppressing shared upgrade intent', () => {
    const sharedIntents: TerritoryIntentMemory[] = [
      { colony: 'W1N1', targetRoom: 'W1N2', action: 'claim', status: 'active', updatedAt: 508 }
    ];
    const controller = {
      id: 'controller1',
      my: true,
      owner: { username: 'me' },
      sign: { username: 'me', text: OCCUPIED_CONTROLLER_SIGN_TEXT, time: 500, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 509,
      rooms: {
        W1N2: { name: 'W1N2', controller } as Room
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { intents: sharedIntents }
    };
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N1' },
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual(sharedIntents);
  });

  it('keeps a completed follow-up claim assignment active while moving to sign the claimed controller', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const controller = {
      id: 'controller1',
      my: true,
      owner: { username: 'me' },
      sign: { username: 'enemy', text: 'not ours', time: 500, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 510,
      rooms: {
        W1N2: { name: 'W1N2', controller } as Room
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim', followUp } },
      room: { name: 'W1N1' },
      claimController: jest.fn(),
      signController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'claim', followUp });
    expect(Memory.territory).toBeUndefined();
  });

  it('keeps an unsafe claimed controller assignment active when it still needs signing', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const controller = {
      id: 'controller1',
      my: true,
      owner: { username: 'me' },
      sign: { username: 'enemy', text: 'not ours', time: 500, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    const hostile = { id: 'enemy1' } as Creep;
    const intents: TerritoryIntentMemory[] = [
      { colony: 'W1N1', targetRoom: 'W1N2', action: 'claim', status: 'active', updatedAt: 510 }
    ];
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 511,
      rooms: {
        W1N2: {
          name: 'W1N2',
          controller,
          find: jest.fn((type: number) => (type === FIND_HOSTILE_CREEPS ? [hostile] : []))
        } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: { intents }
    };
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim', followUp } },
      room: { name: 'W1N1' },
      claimController: jest.fn(),
      signController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'claim', followUp });
    expect(Memory.territory?.intents).toEqual(intents);
  });

  it('signs a claimed controller before clearing the follow-up territory assignment', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const controller = {
      id: 'controller1',
      my: true,
      owner: { username: 'me' },
      sign: { username: 'enemy', text: 'not ours', time: 500, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim', followUp } },
      room: { name: 'W1N2', controller },
      claimController: jest.fn(),
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory).toBeUndefined();
  });

  it('keeps the claim assignment while moving into controller-signing range', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const controller = {
      id: 'controller1',
      my: true,
      owner: { username: 'me' },
      sign: { username: 'enemy', text: 'not ours', time: 500, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim', followUp } },
      room: { name: 'W1N2', controller },
      claimController: jest.fn(),
      signController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn().mockReturnValue(0)
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'claim', followUp });
    expect(Memory.territory).toBeUndefined();
  });

  it('keeps the claim assignment when controller signing is blocked', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const controller = {
      id: 'controller1',
      my: true,
      owner: { username: 'me' },
      sign: { username: 'enemy', text: 'not ours', time: 500, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim', followUp } },
      room: { name: 'W1N2', controller },
      claimController: jest.fn(),
      signController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn().mockReturnValue(-7)
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'claim', followUp });
    expect(Memory.territory).toBeUndefined();
  });

  it('suppresses a claim assignment when the target room has no controller', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 506,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'claim',
            status: 'active',
            updatedAt: 500
          }
        ]
      }
    };
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N2' },
      claimController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 506
      }
    ]);
  });

  it('suppresses a reserve assignment when the target room has no controller', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 507,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 500
          }
        ]
      }
    };
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2' },
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 507
      }
    ]);
  });

  it('suppresses a claim target and stops the creep assignment when claim is impossible', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 503,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          null,
          { colony: 'W9N9', targetRoom: 'W9N8', action: 'reserve', status: 'active', updatedAt: 400 },
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'claim',
            status: 'active',
            updatedAt: 499
          }
        ] as unknown as TerritoryIntentMemory[]
      }
    };
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N2', controller },
      claimController: jest.fn().mockReturnValue(-15),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      { colony: 'W9N9', targetRoom: 'W9N8', action: 'reserve', status: 'active', updatedAt: 400 },
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 503
      }
    ]);
  });

  it('falls back to reserving a follow-up claim target when GCL blocks claiming', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const claimTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W1N2',
      action: 'claim'
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 515,
      rooms: {
        W1N2: {
          name: 'W1N2',
          controller: { id: 'controller1', my: false } as StructureController,
          find: jest.fn().mockReturnValue([])
        } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [claimTarget],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'claim',
            status: 'active',
            updatedAt: 514,
            followUp
          }
        ]
      }
    };
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim', followUp } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      claimController: jest.fn().mockReturnValue(-15),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve', followUp });
    expect(Memory.territory?.targets).toEqual([
      claimTarget,
      {
        colony: 'W1N1',
        roomName: 'W1N2',
        action: 'reserve'
      }
    ]);
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 515,
        followUp
      },
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 515,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 515,
        followUp
      }
    ]);
    expect(Memory.territory?.executionHints).toEqual([
      {
        type: 'activeFollowUpExecution',
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        reason: 'visibleControlEvidenceStillActionable',
        updatedAt: 515,
        followUp
      }
    ]);
  });

  it('recovers persisted follow-up metadata when an older claim assignment falls back to reserve', () => {
    const followUp: TerritoryFollowUpMemory = {
      source: 'satisfiedClaimAdjacent',
      originRoom: 'W1N1',
      originAction: 'claim'
    };
    const claimTarget: TerritoryTargetMemory = {
      colony: 'W1N1',
      roomName: 'W1N2',
      action: 'claim'
    };
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 516,
      rooms: {
        W1N2: {
          name: 'W1N2',
          controller: { id: 'controller1', my: false } as StructureController,
          find: jest.fn().mockReturnValue([])
        } as unknown as Room
      },
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        targets: [claimTarget],
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'claim',
            status: 'active',
            updatedAt: 515,
            followUp
          }
        ]
      }
    };
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'claim' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      claimController: jest.fn().mockReturnValue(-15),
      reserveController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.claimController).toHaveBeenCalledWith(controller);
    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve', followUp });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'claim',
        status: 'suppressed',
        updatedAt: 516,
        followUp
      },
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 516,
        followUp
      }
    ]);
    expect(Memory.territory?.demands).toEqual([
      {
        type: 'followUpPreparation',
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        workerCount: 1,
        updatedAt: 516,
        followUp
      }
    ]);
  });

  it('pressures a foreign reservation before trying to reserve the controller', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 516,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 515
          }
        ]
      }
    };
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(5),
      attackController: jest.fn().mockReturnValue(0),
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.attackController).toHaveBeenCalledWith(controller);
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toEqual({ targetRoom: 'W1N2', action: 'reserve' });
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'active',
        updatedAt: 515
      }
    ]);
  });

  it('suppresses foreign reservation pressure when the claimer lacks five CLAIM parts', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 517,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 516
          }
        ]
      }
    };
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(1),
      attackController: jest.fn(),
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.attackController).not.toHaveBeenCalled();
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 517
      }
    ]);
  });

  it('suppresses foreign reservation pressure when attackController reports no CLAIM body parts', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 518,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 517
          }
        ]
      }
    };
    const controller = {
      id: 'controller1',
      my: false,
      reservation: { username: 'enemy', ticksToEnd: 3_000 }
    } as StructureController;
    const creep = {
      owner: { username: 'me' },
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      getActiveBodyparts: jest.fn().mockReturnValue(5),
      attackController: jest.fn().mockReturnValue(-12),
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.attackController).toHaveBeenCalledWith(controller);
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 518
      }
    ]);
  });

  it('suppresses an enemy-owned reserve target without issuing the impossible reserve call', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 504,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 500
          }
        ]
      }
    };
    const controller = { id: 'controller1', my: false, owner: { username: 'enemy' } } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      reserveController: jest.fn().mockReturnValue(-7),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 504
      }
    ]);
  });

  it('suppresses a reserve assignment when the target controller is already self-owned', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 505,
      getObjectById: jest.fn().mockReturnValue(null)
    };
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      territory: {
        intents: [
          {
            colony: 'W1N1',
            targetRoom: 'W1N2',
            action: 'reserve',
            status: 'active',
            updatedAt: 501
          }
        ]
      }
    };
    const controller = { id: 'controller1', my: true, owner: { username: 'me' } } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      reserveController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory?.intents).toEqual([
      {
        colony: 'W1N1',
        targetRoom: 'W1N2',
        action: 'reserve',
        status: 'suppressed',
        updatedAt: 505
      }
    ]);
  });

  it('ignores incomplete territory memory without throwing', () => {
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1' },
      room: { name: 'W1N1' },
      moveTo: jest.fn(),
      reserveController: jest.fn(),
      claimController: jest.fn()
    } as unknown as Creep;

    expect(() => runTerritoryControllerCreep(creep)).not.toThrow();
    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.reserveController).not.toHaveBeenCalled();
    expect(creep.claimController).not.toHaveBeenCalled();
  });
});
