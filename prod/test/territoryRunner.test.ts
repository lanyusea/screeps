import { runTerritoryControllerCreep } from '../src/territory/territoryRunner';

describe('runTerritoryControllerCreep', () => {
  beforeEach(() => {
    (globalThis as unknown as { RoomPosition: typeof RoomPosition }).RoomPosition = jest.fn(
      (x: number, y: number, roomName: string) => ({ x, y, roomName }) as RoomPosition
    ) as unknown as typeof RoomPosition;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      getObjectById: jest.fn().mockReturnValue(null)
    };
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
    (globalThis as unknown as { Game: Partial<Game> }).Game = { getObjectById };
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
