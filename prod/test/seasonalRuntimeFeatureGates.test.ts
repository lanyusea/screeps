import { runEconomy } from '../src/economy/economyLoop';
import { MARKET_TRADING_INTERVAL } from '../src/economy/marketTrading';
import { getRuntimeFeatureGates } from '../src/runtime/featureGates';

const OK_CODE = 0 as ScreepsReturnCode;
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;

type TestTerminal = StructureTerminal & { send: jest.Mock };

describe('runtime world feature gates', () => {
  afterEach(() => {
    cleanupRuntimeGlobals();
  });

  it('defaults missing and partial Game globals to persistent feature availability', () => {
    delete (globalThis as { Game?: Partial<Game> }).Game;

    expect(getRuntimeFeatureGates()).toMatchObject({
      isSeasonal: false,
      world: 'persistent',
      marketTrading: true,
      terminalEnergyTransfers: true,
      labManagement: true
    });

    (globalThis as unknown as { Game: Partial<Game> }).Game = {};

    expect(getRuntimeFeatureGates()).toMatchObject({
      isSeasonal: false,
      world: 'persistent',
      marketTrading: true,
      terminalEnergyTransfers: true,
      labManagement: true
    });
  });

  it('detects Seasonal World by shard name and disables smoke-risky logistics', () => {
    installFeatureGateGame({ shard: { name: 'shardSeason', type: 'normal' } });

    expect(getRuntimeFeatureGates()).toMatchObject({
      isSeasonal: true,
      world: 'seasonal',
      marketTrading: false,
      terminalEnergyTransfers: false,
      labManagement: false
    });
  });

  it('detects Seasonal World by shard type case-insensitively and preserves CPU metadata', () => {
    installFeatureGateGame({
      shard: { name: 'shard3', type: 'Seasonal-event' },
      cpu: { limit: 20, bucket: 9_000, tickLimit: 500 }
    });

    expect(getRuntimeFeatureGates()).toMatchObject({
      isSeasonal: true,
      world: 'seasonal',
      shardName: 'shard3',
      shardType: 'Seasonal-event',
      cpu: {
        limit: 20,
        bucket: 9_000,
        tickLimit: 500
      }
    });
  });
});

describe('runEconomy Seasonal feature gates', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    installEconomyGlobals();
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};
  });

  afterEach(() => {
    logSpy.mockRestore();
    cleanupRuntimeGlobals();
  });

  it('skips market API calls on Seasonal World even when trading is enabled on cadence', () => {
    const deal = jest.fn().mockReturnValue(OK_CODE);
    const getAllOrders = makeMarketOrderGetter([
      makeOrder({ id: 'buy-H', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1' }),
      makeOrder({ id: 'sell-H', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1' })
    ]);
    installMarketEconomyGame({
      time: MARKET_TRADING_INTERVAL * 8,
      shard: { name: 'shardSeason', type: 'normal' },
      deal,
      getAllOrders
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { enableMarketTrading: true };

    runEconomy();

    expect(getAllOrders).not.toHaveBeenCalled();
    expect(deal).not.toHaveBeenCalled();
  });

  it('skips market API calls when the persistent world CPU bucket is empty', () => {
    const deal = jest.fn().mockReturnValue(OK_CODE);
    const getAllOrders = makeMarketOrderGetter([
      makeOrder({ id: 'buy-H', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1' }),
      makeOrder({ id: 'sell-H', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1' })
    ]);
    installMarketEconomyGame({
      time: MARKET_TRADING_INTERVAL * 8,
      shard: { name: 'shard3', type: 'normal' },
      deal,
      getAllOrders
    });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(19),
      limit: 20,
      bucket: 0,
      tickLimit: 500
    } as unknown as CPU;
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { enableMarketTrading: true };

    runEconomy();

    expect(getAllOrders).not.toHaveBeenCalled();
    expect(deal).not.toHaveBeenCalled();
  });

  it('skips terminal sends on Seasonal World in an imbalance that persistent worlds send', () => {
    const persistentSource = makeTerminalBalanceRoom({
      roomName: 'W1N1',
      storageEnergy: 100_000,
      terminalEnergy: 80_000
    });
    const persistentTarget = makeTerminalBalanceRoom({
      roomName: 'W2N1',
      storageEnergy: 10_000,
      terminalEnergy: 20_000
    });
    installTerminalEconomyGame({
      rooms: [persistentSource, persistentTarget],
      shard: { name: 'shard3', type: 'normal' }
    });

    runEconomy();

    expect(persistentSource.terminal?.send).toHaveBeenCalledWith(
      RESOURCE_ENERGY,
      10_000,
      'W2N1',
      'energy-balance W1N1->W2N1'
    );

    const seasonalSource = makeTerminalBalanceRoom({
      roomName: 'W1N1',
      storageEnergy: 100_000,
      terminalEnergy: 80_000
    });
    const seasonalTarget = makeTerminalBalanceRoom({
      roomName: 'W2N1',
      storageEnergy: 10_000,
      terminalEnergy: 20_000
    });
    installTerminalEconomyGame({
      rooms: [seasonalSource, seasonalTarget],
      shard: { name: 'shardSeason', type: 'normal' }
    });
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {};

    runEconomy();

    expect(seasonalSource.terminal?.send).not.toHaveBeenCalled();
  });

  it('skips terminal sends when the persistent world CPU bucket is empty', () => {
    const source = makeTerminalBalanceRoom({
      roomName: 'W1N1',
      storageEnergy: 100_000,
      terminalEnergy: 80_000
    });
    const target = makeTerminalBalanceRoom({
      roomName: 'W2N1',
      storageEnergy: 10_000,
      terminalEnergy: 20_000
    });
    installTerminalEconomyGame({
      rooms: [source, target],
      shard: { name: 'shard3', type: 'normal' }
    });
    (Game as Partial<Game>).cpu = {
      getUsed: jest.fn().mockReturnValue(19),
      limit: 20,
      bucket: 0,
      tickLimit: 500
    } as unknown as CPU;

    runEconomy();

    expect(source.terminal?.send).not.toHaveBeenCalled();
  });

  it('keeps an empty-world Seasonal smoke path away from disabled APIs', () => {
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { enableMarketTrading: true };
    const game = {
      time: MARKET_TRADING_INTERVAL * 12,
      rooms: {},
      spawns: {},
      creeps: {},
      shard: { name: 'shardSeason', type: 'normal' }
    } as Partial<Game>;
    Object.defineProperty(game, 'market', {
      get: () => {
        throw new Error('Seasonal smoke must not access Game.market');
      }
    });
    (globalThis as unknown as { Game: Partial<Game> }).Game = game;

    expect(() => runEconomy()).not.toThrow();
  });
});

function installFeatureGateGame(game: {
  shard?: { name?: string; type?: string };
  cpu?: { limit?: number; bucket?: number; tickLimit?: number };
}): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = game as Partial<Game>;
}

function installEconomyGlobals(): void {
  Object.assign(globalThis, {
    ERR_NO_PATH: ERR_NO_PATH_CODE,
    FIND_HOSTILE_CREEPS: 1,
    FIND_HOSTILE_STRUCTURES: 2,
    FIND_MY_STRUCTURES: 3,
    FIND_SOURCES: 4,
    RESOURCE_ENERGY: 'energy',
    ORDER_BUY: 'buy',
    ORDER_SELL: 'sell',
    STRUCTURE_EXTENSION: 'extension',
    STRUCTURE_LAB: 'lab',
    STRUCTURE_SPAWN: 'spawn',
    STRUCTURE_STORAGE: 'storage',
    STRUCTURE_TERMINAL: 'terminal'
  });
}

function installMarketEconomyGame({
  time,
  shard,
  deal,
  getAllOrders
}: {
  time: number;
  shard: { name: string; type: string };
  deal: jest.Mock;
  getAllOrders: jest.Mock;
}): void {
  const room = makeMarketRoom();
  const spawn = {
    name: 'Spawn1',
    room,
    spawning: null,
    spawnCreep: jest.fn().mockReturnValue(OK_CODE)
  } as unknown as StructureSpawn;

  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    rooms: { W1N1: room },
    spawns: { Spawn1: spawn },
    creeps: {},
    shard: shard as Shard,
    market: {
      credits: 20_000,
      deal,
      getAllOrders,
      calcTransactionCost: jest.fn().mockReturnValue(0)
    } as unknown as Market
  };
}

function installTerminalEconomyGame({
  rooms,
  shard
}: {
  rooms: Room[];
  shard: { name: string; type: string };
}): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time: 100,
    creeps: {},
    rooms: Object.fromEntries(rooms.map((room) => [room.name, room])),
    spawns: {},
    shard: shard as Shard,
    map: {
      getRoomLinearDistance: jest.fn().mockReturnValue(2),
      findRoute: jest.fn((_fromRoom: string, targetRoom: string) => [{ exit: 1, room: targetRoom }])
    } as unknown as GameMap
  };
}

function makeMarketRoom(): Room {
  return {
    name: 'W1N1',
    controller: { my: true, level: 6 } as StructureController,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    storage: {
      id: 'storage1',
      structureType: 'storage',
      store: makeResourceStore({ energy: 50_000 }, 500_000)
    } as unknown as StructureStorage,
    terminal: {
      id: 'terminal1',
      cooldown: 0,
      structureType: 'terminal',
      store: makeResourceStore({ energy: 80_000, H: 30_000 }, 200_000)
    } as unknown as StructureTerminal,
    find: jest.fn(() => [])
  } as unknown as Room;
}

function makeTerminalBalanceRoom({
  roomName,
  storageEnergy,
  terminalEnergy
}: {
  roomName: string;
  storageEnergy: number;
  terminalEnergy: number;
}): Room {
  return {
    name: roomName,
    controller: { my: true, level: 4 } as StructureController,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    storage: {
      id: `${roomName}-storage`,
      structureType: 'storage',
      store: makeResourceStore({ energy: storageEnergy }, 100_000)
    } as unknown as StructureStorage,
    terminal: {
      id: `${roomName}-terminal`,
      cooldown: 0,
      structureType: 'terminal',
      store: makeResourceStore({ energy: terminalEnergy }, 100_000),
      send: jest.fn().mockReturnValue(OK_CODE)
    } as unknown as TestTerminal,
    find: jest.fn((type: number) => {
      if (type === FIND_HOSTILE_CREEPS || type === FIND_HOSTILE_STRUCTURES || type === FIND_MY_STRUCTURES) {
        return [];
      }

      if (type === FIND_SOURCES) {
        return [{ id: `${roomName}-source` } as Source];
      }

      return [];
    })
  } as unknown as Room;
}

function makeResourceStore(resources: Record<string, number>, capacity: number): StoreDefinition {
  return {
    ...resources,
    getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
      resource ? resources[resource] ?? 0 : sumResources(resources)
    ),
    getCapacity: jest.fn(() => capacity),
    getFreeCapacity: jest.fn(() => Math.max(0, capacity - sumResources(resources)))
  } as unknown as StoreDefinition;
}

function makeOrder({
  id,
  type,
  resourceType,
  price,
  roomName,
  remainingAmount = 5_000
}: {
  id: string;
  type: 'buy' | 'sell';
  resourceType: string;
  price: number;
  roomName: string;
  remainingAmount?: number;
}): Order {
  return {
    id,
    created: 1,
    active: true,
    type,
    resourceType: resourceType as MarketResourceConstant,
    roomName,
    amount: remainingAmount,
    remainingAmount,
    price
  } as Order;
}

function makeMarketOrderGetter(orders: Order[]): jest.Mock {
  return jest.fn((filter?: OrderFilter | ((order: Order) => boolean)) => {
    if (typeof filter === 'function') {
      return orders.filter(filter);
    }

    if (!filter) {
      return orders;
    }

    return orders.filter((order) => (
      (filter.type === undefined || order.type === filter.type) &&
      (filter.resourceType === undefined || order.resourceType === filter.resourceType)
    ));
  });
}

function sumResources(resources: Record<string, number>): number {
  return Object.values(resources).reduce((total, amount) => total + amount, 0);
}

function cleanupRuntimeGlobals(): void {
  delete (globalThis as { Game?: Partial<Game> }).Game;
  delete (globalThis as { Memory?: Partial<Memory> }).Memory;
  delete (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  delete (globalThis as { FIND_HOSTILE_CREEPS?: number }).FIND_HOSTILE_CREEPS;
  delete (globalThis as { FIND_HOSTILE_STRUCTURES?: number }).FIND_HOSTILE_STRUCTURES;
  delete (globalThis as { FIND_MY_STRUCTURES?: number }).FIND_MY_STRUCTURES;
  delete (globalThis as { FIND_SOURCES?: number }).FIND_SOURCES;
  delete (globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY;
  delete (globalThis as { ORDER_BUY?: string }).ORDER_BUY;
  delete (globalThis as { ORDER_SELL?: string }).ORDER_SELL;
  delete (globalThis as { STRUCTURE_EXTENSION?: StructureConstant }).STRUCTURE_EXTENSION;
  delete (globalThis as { STRUCTURE_LAB?: StructureConstant }).STRUCTURE_LAB;
  delete (globalThis as { STRUCTURE_SPAWN?: StructureConstant }).STRUCTURE_SPAWN;
  delete (globalThis as { STRUCTURE_STORAGE?: StructureConstant }).STRUCTURE_STORAGE;
  delete (globalThis as { STRUCTURE_TERMINAL?: StructureConstant }).STRUCTURE_TERMINAL;
}
