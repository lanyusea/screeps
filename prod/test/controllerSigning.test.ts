import {
  OCCUPIED_CONTROLLER_SIGN_TEXT,
  shouldSignOccupiedController,
  signOccupiedControllerIfNeeded
} from '../src/territory/controllerSigning';

describe('controller signing', () => {
  beforeEach(() => {
    (globalThis as unknown as { ERR_NOT_IN_RANGE: number; OK: number }).ERR_NOT_IN_RANGE = -9;
    (globalThis as unknown as { OK: number }).OK = 0;
  });

  it('signs an unsigned owned controller with the occupied-area text', () => {
    const controller = { id: 'controller1', my: true } as StructureController;
    const creep = {
      signController: jest.fn().mockReturnValue(0),
      moveTo: jest.fn()
    } as unknown as Creep;

    expect(signOccupiedControllerIfNeeded(creep, controller)).toBe('signed');

    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('moves toward an incorrectly signed owned controller when signing is out of range', () => {
    const controller = {
      id: 'controller1',
      my: true,
      sign: { username: 'other', text: 'not ours', time: 123, datetime: '2026-04-29T00:00:00.000Z' }
    } as unknown as StructureController;
    const creep = {
      signController: jest.fn().mockReturnValue(-9),
      moveTo: jest.fn()
    } as unknown as Creep;

    expect(signOccupiedControllerIfNeeded(creep, controller)).toBe('moving');

    expect(creep.signController).toHaveBeenCalledWith(controller, OCCUPIED_CONTROLLER_SIGN_TEXT);
    expect(creep.moveTo).toHaveBeenCalledWith(controller);
  });

  it('does not repeat signing when the owned controller already has the required text', () => {
    const controller = {
      id: 'controller1',
      my: true,
      sign: {
        username: 'me',
        text: OCCUPIED_CONTROLLER_SIGN_TEXT,
        time: 123,
        datetime: '2026-04-29T00:00:00.000Z'
      }
    } as unknown as StructureController;
    const creep = {
      signController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    expect(shouldSignOccupiedController(controller)).toBe(false);
    expect(signOccupiedControllerIfNeeded(creep, controller)).toBe('skipped');

    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });

  it('skips missing controllers and controllers without own ownership safely', () => {
    const unownedController = { id: 'controller1', my: false } as StructureController;
    const hostileController = {
      id: 'controller2',
      my: false,
      owner: { username: 'enemy' }
    } as StructureController;
    const creep = {
      signController: jest.fn(),
      moveTo: jest.fn()
    } as unknown as Creep;

    expect(shouldSignOccupiedController(undefined)).toBe(false);
    expect(shouldSignOccupiedController(unownedController)).toBe(false);
    expect(shouldSignOccupiedController(hostileController)).toBe(false);
    expect(signOccupiedControllerIfNeeded(creep, undefined)).toBe('skipped');
    expect(signOccupiedControllerIfNeeded(creep, unownedController)).toBe('skipped');
    expect(signOccupiedControllerIfNeeded(creep, hostileController)).toBe('skipped');

    expect(creep.signController).not.toHaveBeenCalled();
    expect(creep.moveTo).not.toHaveBeenCalled();
  });
});
