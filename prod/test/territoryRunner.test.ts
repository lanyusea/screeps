import { runTerritoryControllerCreep } from '../src/territory/territoryRunner';

describe('runTerritoryControllerCreep', () => {
  beforeEach(() => {
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

  it('finishes a scout assignment after entering the target room', () => {
    const creep = {
      memory: { role: 'scout', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'scout' } },
      room: { name: 'W1N2' },
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.moveTo).not.toHaveBeenCalled();
    expect(creep.memory.territory).toBeUndefined();
    expect(Memory.territory).toBeUndefined();
  });

  it('reserves the target room controller and moves into range when needed', () => {
    const controller = { id: 'controller1', my: false } as StructureController;
    const creep = {
      memory: { role: 'claimer', colony: 'W1N1', territory: { targetRoom: 'W1N2', action: 'reserve' } },
      room: { name: 'W1N2', controller },
      reserveController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
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
      moveTo: jest.fn()
    } as unknown as Creep;

    runTerritoryControllerCreep(creep);

    expect(getObjectById).toHaveBeenCalledWith('controller1');
    expect(creep.claimController).toHaveBeenCalledWith(controller);
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

  it('suppresses a reserve target and stops the creep assignment when reserve is impossible', () => {
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

    expect(creep.reserveController).toHaveBeenCalledWith(controller);
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
