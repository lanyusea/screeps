import {
  MARKET_TRADING_MIN_CREDITS_RESERVE,
  runMarketTrading,
  selectMarketTradePlan
} from '../src/economy/marketTrading';

const OK_CODE = 0 as ScreepsReturnCode;

describe('marketTrading', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      Memory: {},
      RESOURCE_ENERGY: 'energy',
      ORDER_BUY: 'buy',
      ORDER_SELL: 'sell'
    });
  });

  afterEach(() => {
    delete (globalThis as { Game?: Partial<Game> }).Game;
  });

  it('selects profitable excess-resource sales after transaction energy cost', () => {
    const room = makeRoomState({
      roomName: 'W1N1',
      terminalResources: { energy: 80_000, H: 30_000 },
      resources: { energy: 80_000, H: 30_000 }
    });
    const orders = [
      makeOrder({ id: 'buy-profitable', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1' }),
      makeOrder({ id: 'buy-too-far', type: 'buy', resourceType: 'H', price: 2.5, roomName: 'W50N50' }),
      makeOrder({ id: 'sell-reference', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1' })
    ];

    const plan = selectMarketTradePlan({
      rooms: [room],
      orders,
      credits: 20_000,
      maxDealAmount: 1_000,
      calcTransactionCost: (amount, _from, to) => (to === 'W50N50' ? amount * 20 : 50)
    });

    expect(plan).toMatchObject({
      action: 'sell',
      amount: 1_000,
      energyCost: 50,
      orderId: 'buy-profitable',
      reason: 'sellExcess',
      referenceOrderId: 'sell-reference',
      resourceType: 'H',
      roomName: 'W1N1'
    });
    expect(plan?.expectedProfit).toBe(995);
  });

  it('enforces credit budget when buying needed resources', () => {
    const room = makeRoomState({
      roomName: 'W1N1',
      terminalFreeCapacity: 10_000,
      terminalResources: { energy: 80_000 },
      resources: { energy: 80_000 }
    });
    const orders = [
      makeOrder({ id: 'sell-needed', type: 'sell', resourceType: 'O', price: 2, roomName: 'W2N1', remainingAmount: 5_000 }),
      makeOrder({ id: 'buy-reference', type: 'buy', resourceType: 'O', price: 4, roomName: 'W3N1', remainingAmount: 5_000 })
    ];

    const plan = selectMarketTradePlan({
      rooms: [room],
      orders,
      credits: 10_000,
      minCreditsReserve: 1_000,
      creditSpendRatio: 0.2,
      calcTransactionCost: () => 0
    });

    expect(plan).toMatchObject({
      action: 'buy',
      amount: 1_000,
      creditsDelta: -2_000,
      orderId: 'sell-needed',
      reason: 'buyNeeded',
      resourceType: 'O'
    });

    expect(
      selectMarketTradePlan({
        rooms: [room],
        orders,
        credits: MARKET_TRADING_MIN_CREDITS_RESERVE,
        calcTransactionCost: () => 0
      })
    ).toBeNull();
  });

  it('rejects trades that do not fit the terminal energy budget', () => {
    const room = makeRoomState({
      roomName: 'W1N1',
      terminalResources: { energy: 20_050, H: 30_000 },
      resources: { energy: 20_050, H: 30_000 }
    });
    const orders = [
      makeOrder({ id: 'buy-H', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1' }),
      makeOrder({ id: 'sell-H', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1' })
    ];

    expect(
      selectMarketTradePlan({
        rooms: [room],
        orders,
        credits: 20_000,
        calcTransactionCost: () => 100
      })
    ).toBeNull();
  });

  it('prefers buying needed resources over selling excess resources when both are profitable', () => {
    const room = makeRoomState({
      roomName: 'W1N1',
      terminalFreeCapacity: 20_000,
      terminalResources: { energy: 80_000, H: 30_000 },
      resources: { energy: 80_000, H: 30_000 }
    });
    const orders = [
      makeOrder({ id: 'buy-H', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1' }),
      makeOrder({ id: 'sell-H', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1' }),
      makeOrder({ id: 'sell-needed-O', type: 'sell', resourceType: 'O', price: 2, roomName: 'W4N1' }),
      makeOrder({ id: 'buy-reference-O', type: 'buy', resourceType: 'O', price: 4, roomName: 'W5N1' })
    ];

    expect(
      selectMarketTradePlan({
        rooms: [room],
        orders,
        credits: 20_000,
        calcTransactionCost: () => 0
      })
    ).toMatchObject({
      action: 'buy',
      orderId: 'sell-needed-O',
      reason: 'buyNeeded',
      resourceType: 'O'
    });
  });

  it('tracks projected cooldown after a successful market deal', () => {
    const deal = jest.fn().mockReturnValue(OK_CODE);
    const getAllOrders = makeMarketOrderGetter([
      makeOrder({ id: 'buy-H', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1', remainingAmount: 5_000 }),
      makeOrder({ id: 'sell-H', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1', remainingAmount: 5_000 })
    ]);
    installGame({
      time: 100,
      market: {
        credits: 20_000,
        deal,
        getAllOrders,
        calcTransactionCost: jest.fn().mockReturnValue(0)
      },
      room: makeOwnedRoom({ terminalResources: { energy: 80_000, H: 30_000 } })
    });

    const result = runMarketTrading();

    expect(getAllOrders).toHaveBeenCalledTimes(2);
    expect(getAllOrders).toHaveBeenNthCalledWith(1, { type: 'buy', resourceType: 'H' });
    expect(getAllOrders).toHaveBeenNthCalledWith(2, { type: 'sell', resourceType: 'H' });
    expect(deal).toHaveBeenCalledWith('buy-H', 5_000, 'W1N1');
    expect(result).toMatchObject({
      availableAt: 150,
      cooldown: 50,
      orderId: 'buy-H',
      result: OK_CODE
    });
    expect(Memory.economy?.marketTrading?.rooms.W1N1.availableAt).toBe(150);
    expect(Memory.economy?.marketTrading?.lastDeal).toMatchObject({
      availableAt: 150,
      cooldown: 50,
      orderId: 'buy-H'
    });
  });

  it('queries orders for resources known by rooms that are not ready to trade', () => {
    const deal = jest.fn().mockReturnValue(OK_CODE);
    const getAllOrders = makeMarketOrderGetter([
      makeOrder({ id: 'sell-needed-O', type: 'sell', resourceType: 'O', price: 2, roomName: 'W3N1', remainingAmount: 5_000 }),
      makeOrder({ id: 'buy-reference-O', type: 'buy', resourceType: 'O', price: 4, roomName: 'W4N1', remainingAmount: 5_000 })
    ]);
    const readyRoom = makeOwnedRoom({ roomName: 'W1N1', terminalResources: { energy: 80_000 } });
    const coolingRoom = makeOwnedRoom({ roomName: 'W2N1', terminalResources: { energy: 80_000, O: 1_000 } });
    (coolingRoom.terminal as unknown as { cooldown: number }).cooldown = 10;
    (globalThis as unknown as { Game: Partial<Game> }).Game = {
      time: 100,
      rooms: {
        W1N1: readyRoom,
        W2N1: coolingRoom
      },
      market: {
        credits: 20_000,
        deal,
        getAllOrders,
        calcTransactionCost: jest.fn().mockReturnValue(0)
      } as unknown as Market
    };

    const result = runMarketTrading();

    expect(getAllOrders).toHaveBeenCalledWith({ type: 'buy', resourceType: 'O' });
    expect(getAllOrders).toHaveBeenCalledWith({ type: 'sell', resourceType: 'O' });
    expect(deal).toHaveBeenCalledWith('sell-needed-O', 2_500, 'W1N1');
    expect(result).toMatchObject({
      action: 'buy',
      orderId: 'sell-needed-O',
      reason: 'buyNeeded',
      resourceType: 'O',
      roomName: 'W1N1'
    });
  });

  it('does not trade while memory says the terminal is cooling down', () => {
    const deal = jest.fn().mockReturnValue(OK_CODE);
    const getAllOrders = makeMarketOrderGetter([
      makeOrder({ id: 'buy-H', type: 'buy', resourceType: 'H', price: 2, roomName: 'W2N1' }),
      makeOrder({ id: 'sell-H', type: 'sell', resourceType: 'H', price: 1, roomName: 'W3N1' })
    ]);
    (globalThis as unknown as { Memory: Partial<Memory> }).Memory = {
      economy: {
        marketTrading: {
          updatedAt: 90,
          nextRunAt: 115,
          rooms: {
            W1N1: {
              roomName: 'W1N1',
              credits: 20_000,
              cooldown: 10,
              energyBudget: 60_000,
              terminalEnergy: 80_000,
              terminalFreeCapacity: 10_000,
              neededResources: {},
              excessResources: { H: 10_000 },
              availableAt: 115,
              updatedAt: 90
            }
          }
        }
      }
    };
    installGame({
      time: 100,
      market: {
        credits: 20_000,
        deal,
        getAllOrders,
        calcTransactionCost: jest.fn().mockReturnValue(0)
      },
      room: makeOwnedRoom({ terminalResources: { energy: 80_000, H: 30_000 } })
    });

    expect(runMarketTrading()).toBeNull();
    expect(getAllOrders).not.toHaveBeenCalled();
    expect(deal).not.toHaveBeenCalled();
    expect(Memory.economy?.marketTrading?.rooms.W1N1.availableAt).toBe(115);
  });
});

function makeRoomState({
  roomName,
  terminalResources,
  resources,
  terminalFreeCapacity = 50_000,
  terminalCooldown = 0
}: {
  roomName: string;
  terminalResources: Record<string, number>;
  resources: Record<string, number>;
  terminalFreeCapacity?: number;
  terminalCooldown?: number;
}) {
  return {
    roomName,
    terminal: { id: `${roomName}-terminal` } as StructureTerminal,
    terminalId: `${roomName}-terminal`,
    terminalCooldown,
    terminalEnergy: terminalResources.energy ?? 0,
    terminalFreeCapacity,
    terminalResources,
    resources
  };
}

function makeOwnedRoom({
  roomName = 'W1N1',
  terminalResources,
  storageResources = { energy: 0 }
}: {
  roomName?: string;
  terminalResources: Record<string, number>;
  storageResources?: Record<string, number>;
}): Room {
  return {
    name: roomName,
    controller: { my: true } as StructureController,
    energyAvailable: 800,
    energyCapacityAvailable: 800,
    storage: {
      id: `${roomName}-storage`,
      structureType: 'storage',
      store: makeStore(storageResources, 100_000)
    } as unknown as StructureStorage,
    terminal: {
      id: `${roomName}-terminal`,
      cooldown: 0,
      structureType: 'terminal',
      store: makeStore(terminalResources, 100_000)
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
  remainingAmount = 1_000
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

function installGame({
  time,
  room,
  market
}: {
  time: number;
  room: Room;
  market: Pick<Market, 'credits' | 'deal' | 'getAllOrders' | 'calcTransactionCost'>;
}): void {
  (globalThis as unknown as { Game: Partial<Game> }).Game = {
    time,
    rooms: { [room.name]: room },
    market: market as Market
  };
}

function sumResources(resources: Record<string, number>): number {
  return Object.values(resources).reduce((total, amount) => total + amount, 0);
}
