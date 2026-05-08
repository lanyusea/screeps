import {
  calculateTerminalEnergyCost,
  getTerminalSendCooldown,
  manageTerminalEnergy,
  selectTerminalEnergyExport,
  selectTerminalEnergyImport,
  TERMINAL_ENERGY_MIN_RESERVE
} from '../src/economy/terminalManager';

const OK_CODE = 0 as ScreepsReturnCode;

type TestStructureTerminal = StructureTerminal & { send: jest.Mock };

describe('terminalManager', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      RESOURCE_ENERGY: 'energy',
      Memory: {}
    });
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('calculates terminal send energy cost and projected cooldown', () => {
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      map: {
        getRoomLinearDistance: jest.fn().mockReturnValue(3)
      } as unknown as GameMap
    };

    expect(calculateTerminalEnergyCost('W1N1', 'W4N1', 333)).toBe(32);
    expect(getTerminalSendCooldown(0)).toBe(0);
    expect(getTerminalSendCooldown(1)).toBe(1);
    expect(getTerminalSendCooldown(100)).toBe(1);
    expect(getTerminalSendCooldown(101)).toBe(2);
  });

  it('sends energy from an exporting room terminal to an importing room terminal', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 100_000,
      terminalEnergy: 80_000
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 10_000,
      terminalEnergy: 20_000
    });
    installGame([sourceRoom, targetRoom], 2);

    const results = manageTerminalEnergy();

    expect(results).toEqual([
      {
        amount: 10_000,
        availableAt: 200,
        cooldown: 100,
        description: 'energy-balance W1N1->W2N1',
        distance: 2,
        energyCost: 645,
        result: OK_CODE,
        sourceRoom: 'W1N1',
        targetRoom: 'W2N1'
      }
    ]);
    expect(sourceRoom.terminal?.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      10_000,
      'W2N1',
      'energy-balance W1N1->W2N1'
    );
    expect(Memory.economy?.terminalLogistics?.rooms.W1N1).toMatchObject({
      cooldown: 100,
      projectedCooldown: 100,
      availableAt: 200
    });
    expect(Memory.economy?.terminalLogistics?.transfers).toMatchObject([
      {
        sourceRoom: 'W1N1',
        targetRoom: 'W2N1',
        amount: 10_000,
        energyCost: 645,
        cooldown: 100
      }
    ]);
    expect(Memory.economy?.storageBalance?.transfers).toEqual([
      { sourceRoom: 'W1N1', targetRoom: 'W2N1', amount: 10_000, updatedAt: 100 }
    ]);
  });

  it('selects terminal transfers from both export and import viewpoints', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 100_000,
      terminalEnergy: 80_000
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 10_000,
      terminalEnergy: 20_000
    });
    installGame([sourceRoom, targetRoom], 2);

    expect(selectTerminalEnergyExport(sourceRoom)).toMatchObject({
      sourceRoom: 'W1N1',
      targetRoom: 'W2N1',
      amount: 10_000
    });
    expect(selectTerminalEnergyImport(targetRoom)).toMatchObject({
      sourceRoom: 'W1N1',
      targetRoom: 'W2N1',
      amount: 10_000
    });
  });

  it('does not send while the exporting terminal is cooling down', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 100_000,
      terminalEnergy: 80_000,
      cooldown: 5
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 10_000,
      terminalEnergy: 20_000
    });
    installGame([sourceRoom, targetRoom], 2);

    expect(manageTerminalEnergy()).toEqual([]);
    expect(sourceRoom.terminal?.send).not.toHaveBeenCalled();
    expect(Memory.economy?.terminalLogistics?.rooms.W1N1).toMatchObject({ cooldown: 5 });
  });

  it('keeps source terminals above the reserve threshold', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageCapacity: 25_000,
      storageEnergy: 25_000,
      terminalCapacity: 30_000,
      terminalEnergy: TERMINAL_ENERGY_MIN_RESERVE + 99
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageEnergy: 10_000,
      terminalEnergy: 20_000
    });
    installGame([sourceRoom, targetRoom], 1);

    expect(manageTerminalEnergy()).toEqual([]);
    expect(sourceRoom.terminal?.send).not.toHaveBeenCalled();
  });

  it('does not import energy into a terminal that is already at its target threshold', () => {
    const sourceRoom = makeOwnedRoom({
      roomName: 'W1N1',
      storageEnergy: 100_000,
      terminalEnergy: 80_000
    });
    const targetRoom = makeOwnedRoom({
      roomName: 'W2N1',
      storageCapacity: 500_000,
      storageEnergy: 10_000,
      terminalEnergy: 50_000
    });
    installGame([sourceRoom, targetRoom], 2);

    expect(manageTerminalEnergy()).toEqual([]);
    expect(sourceRoom.terminal?.send).not.toHaveBeenCalled();
  });
});

function makeOwnedRoom({
  roomName,
  storageEnergy,
  storageCapacity = 100_000,
  terminalEnergy,
  terminalCapacity = 100_000,
  cooldown = 0
}: {
  roomName: string;
  storageEnergy: number;
  storageCapacity?: number;
  terminalEnergy: number;
  terminalCapacity?: number;
  cooldown?: number;
}): Room {
  return {
    name: roomName,
    controller: { my: true } as StructureController,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    storage: makeStorage(`${roomName}-storage`, storageEnergy, storageCapacity),
    terminal: makeTerminal(`${roomName}-terminal`, terminalEnergy, terminalCapacity, cooldown)
  } as unknown as Room;
}

function makeStorage(id: string, energy: number, capacity: number): StructureStorage {
  return {
    id,
    structureType: 'storage',
    store: makeStore(energy, capacity)
  } as unknown as StructureStorage;
}

function makeTerminal(
  id: string,
  energy: number,
  capacity: number,
  cooldown: number
): TestStructureTerminal {
  return {
    id,
    cooldown,
    structureType: 'terminal',
    store: makeStore(energy, capacity),
    send: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as TestStructureTerminal;
}

function makeStore(energy: number, capacity: number): StoreDefinition {
  return {
    getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0)),
    getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? capacity : 0)),
    getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
      resource === RESOURCE_ENERGY ? Math.max(0, capacity - energy) : 0
    )
  } as unknown as StoreDefinition;
}

function installGame(rooms: Room[], linearDistance: number): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 100,
    rooms: Object.fromEntries(rooms.map((room) => [room.name, room])),
    map: {
      getRoomLinearDistance: jest.fn().mockReturnValue(linearDistance)
    } as unknown as GameMap
  };
}
