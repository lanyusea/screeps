import { runEconomy } from '../src/economy/economyLoop';
import { MARKET_TRADING_INTERVAL } from '../src/economy/marketTrading';

const OK_CODE = 0 as ScreepsReturnCode;

describe('market trading economy integration', () => {
  let logSpy: jest.SpyInstance<void, [message?: unknown, ...optionalParams: unknown[]]>;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    Object.assign(globalThis, {
      Memory: {},
      RESOURCE_ENERGY: 'energy',
      ORDER_BUY: 'buy',
      ORDER_SELL: 'sell'
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('runs terminal market trading only when explicitly enabled and on the configured cadence', () => {
    const deal = jest.fn().mockReturnValue(OK_CODE);
    const getAllOrders = makeMarketOrderGetter([
      makeOrder({ id: 'buy-H', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1' }),
      makeOrder({ id: 'sell-H', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1' })
    ]);
    installEconomyGame({
      time: MARKET_TRADING_INTERVAL * 4,
      deal,
      getAllOrders
    });

    runEconomy();

    expect(getAllOrders).not.toHaveBeenCalled();
    expect(deal).not.toHaveBeenCalled();

    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { enableMarketTrading: true };
    deal.mockClear();
    getAllOrders.mockClear();
    installEconomyGame({
      time: MARKET_TRADING_INTERVAL * 4,
      deal,
      getAllOrders
    });

    runEconomy();

    expect(getAllOrders).toHaveBeenCalledTimes(2);
    expect(getAllOrders).toHaveBeenNthCalledWith(1, { type: 'buy', resourceType: 'H' });
    expect(getAllOrders).toHaveBeenNthCalledWith(2, { type: 'sell', resourceType: 'H' });
    expect(deal).toHaveBeenCalledWith('buy-H', 5_000, 'W1N1');

    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = { enableMarketTrading: true };
    deal.mockClear();
    getAllOrders.mockClear();
    installEconomyGame({
      time: MARKET_TRADING_INTERVAL * 4 + 1,
      deal,
      getAllOrders
    });

    runEconomy();

    expect(getAllOrders).not.toHaveBeenCalled();
    expect(deal).not.toHaveBeenCalled();
  });
});

function installEconomyGame({
  time,
  deal,
  getAllOrders
}: {
  time: number;
  deal: jest.Mock;
  getAllOrders: jest.Mock;
}): void {
  const room = makeOwnedRoom();
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
    market: {
      credits: 20_000,
      deal,
      getAllOrders,
      calcTransactionCost: jest.fn().mockReturnValue(0)
    } as unknown as Market
  };
}

function makeOwnedRoom(): Room {
  return {
    name: 'W1N1',
    controller: { my: true, level: 6 } as StructureController,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    storage: {
      id: 'storage1',
      structureType: 'storage',
      store: makeStore({ energy: 50_000 }, 500_000)
    } as unknown as StructureStorage,
    terminal: {
      id: 'terminal1',
      cooldown: 0,
      structureType: 'terminal',
      store: makeStore({ energy: 80_000, H: 30_000 }, 200_000)
    } as unknown as StructureTerminal
  } as unknown as Room;
}

function makeStore(resources: Record<string, number>, capacity: number): StoreDefinition {
  const store = {
    ...resources,
    getUsedCapacity: jest.fn((resource?: ResourceConstant) =>
      resource ? resources[resource] ?? 0 : sumResources(resources)
    ),
    getCapacity: jest.fn(() => capacity),
    getFreeCapacity: jest.fn(() => Math.max(0, capacity - sumResources(resources)))
  };
  return store as unknown as StoreDefinition;
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

function makeMarketOrderGetter(orders: Order[]) {
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
