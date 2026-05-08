import {
  getTerminalSendCooldown,
  TERMINAL_ENERGY_MIN_RESERVE
} from './terminalManager';

export const MARKET_TRADING_INTERVAL = 25;
export const MARKET_TRADING_MIN_ORDER_AMOUNT = 100;
export const MARKET_TRADING_MAX_DEAL_AMOUNT = 5_000;
export const MARKET_TRADING_MIN_CREDITS_RESERVE = 5_000;
export const MARKET_TRADING_CREDIT_SPEND_RATIO = 0.25;
export const MARKET_TRADING_ENERGY_CREDIT_VALUE = 0.1;

const OK_CODE = 0 as ScreepsReturnCode;
const DEFAULT_RESOURCE_RESERVE = 3_000;
const DEFAULT_RESOURCE_TARGET = 5_000;
const DEFAULT_RESOURCE_EXCESS = 20_000;
const ENERGY_RESOURCE_TARGET = 75_000;
const ENERGY_RESOURCE_EXCESS = 150_000;
const MAX_ORDERS_PER_RESOURCE_SIDE = 5;

type MarketTradeAction = 'buy' | 'sell';
type MarketTradeReason = 'buyNeeded' | 'sellExcess';

interface StoreLike {
  getUsedCapacity?: (resource?: ResourceConstant) => number | null;
  getCapacity?: (resource?: ResourceConstant) => number | null;
  getFreeCapacity?: (resource?: ResourceConstant) => number | null;
  [resource: string]: unknown;
}

interface ResourcePolicy {
  reserve: number;
  target: number;
  excess: number;
}

interface ResourcePosture {
  excessAmount: number;
  neededAmount: number;
}

export interface MarketTradingRoomState {
  roomName: string;
  terminal: StructureTerminal;
  terminalId?: string;
  terminalCooldown: number;
  terminalEnergy: number;
  terminalFreeCapacity: number;
  terminalResources: Record<string, number>;
  resources: Record<string, number>;
  availableAt?: number;
}

export interface MarketTradingSelectionInput {
  rooms: MarketTradingRoomState[];
  orders: Order[];
  credits: number;
  gameTime?: number;
  minOrderAmount?: number;
  maxDealAmount?: number;
  minCreditsReserve?: number;
  creditSpendRatio?: number;
  energyCreditValue?: number;
  calcTransactionCost?: (amount: number, roomName1: string, roomName2: string) => number;
}

export interface MarketTradePlan {
  action: MarketTradeAction;
  amount: number;
  creditsDelta: number;
  energyCost: number;
  expectedProfit: number;
  orderId: string;
  price: number;
  reason: MarketTradeReason;
  referenceOrderId?: string;
  referencePrice: number;
  resourceType: MarketResourceConstant;
  roomName: string;
  score: number;
  spread: number;
  terminal: StructureTerminal;
}

export interface MarketTradeResult extends Omit<MarketTradePlan, 'score' | 'terminal'> {
  availableAt: number;
  cooldown: number;
  result: ScreepsReturnCode;
  updatedAt: number;
}

interface MarketTradeCandidate extends MarketTradePlan {
  priority: number;
}

interface MarketOrderBook {
  buyOrdersByResource: Map<MarketResourceConstant, Order[]>;
  sellOrdersByResource: Map<MarketResourceConstant, Order[]>;
}

export function shouldRunMarketTrading(
  gameTime: number = getGameTime(),
  interval: number = MARKET_TRADING_INTERVAL
): boolean {
  const normalizedInterval = normalizePositiveInteger(interval);
  return gameTime > 0 && gameTime % normalizedInterval === 0;
}

export function runMarketTrading(): MarketTradeResult | null {
  const gameTime = getGameTime();
  const market = getMarket();
  if (!market) {
    recordMarketTradingState([], gameTime, { skippedReason: 'missingMarket' });
    return null;
  }

  const rooms = buildMarketTradingRoomStates(gameTime);
  const orderResourceTypes = collectMarketOrderResourceTypes(rooms, gameTime);
  const orders = getMarketOrdersSafely(market, orderResourceTypes);
  const plan = selectMarketTradePlan({
    rooms,
    orders,
    credits: normalizeNonNegativeNumber(market.credits),
    gameTime,
    calcTransactionCost: (amount, roomName1, roomName2) =>
      calculateMarketTransactionCost(amount, roomName1, roomName2)
  });

  if (!plan) {
    recordMarketTradingState(rooms, gameTime, { skippedReason: rooms.length === 0 ? 'missingTerminal' : 'noTrade' });
    return null;
  }

  const result = market.deal(plan.orderId, plan.amount, plan.roomName);
  const cooldown = result === OK_CODE ? getTerminalSendCooldown(plan.amount) : 0;
  const tradeResult: MarketTradeResult = {
    action: plan.action,
    amount: plan.amount,
    availableAt: gameTime + cooldown,
    cooldown,
    creditsDelta: plan.creditsDelta,
    energyCost: plan.energyCost,
    expectedProfit: plan.expectedProfit,
    orderId: plan.orderId,
    price: plan.price,
    reason: plan.reason,
    ...(plan.referenceOrderId ? { referenceOrderId: plan.referenceOrderId } : {}),
    referencePrice: plan.referencePrice,
    resourceType: plan.resourceType,
    result,
    roomName: plan.roomName,
    spread: plan.spread,
    updatedAt: gameTime
  };
  recordMarketTradingState(rooms, gameTime, { result: tradeResult });
  return tradeResult;
}

export function selectMarketTradePlan(input: MarketTradingSelectionInput): MarketTradePlan | null {
  const gameTime = normalizeNonNegativeInteger(input.gameTime ?? 0);
  const minOrderAmount = normalizePositiveInteger(input.minOrderAmount ?? MARKET_TRADING_MIN_ORDER_AMOUNT);
  const maxDealAmount = normalizePositiveInteger(input.maxDealAmount ?? MARKET_TRADING_MAX_DEAL_AMOUNT);
  const minCreditsReserve = normalizeNonNegativeNumber(
    input.minCreditsReserve ?? MARKET_TRADING_MIN_CREDITS_RESERVE
  );
  const creditSpendRatio = normalizeRatio(input.creditSpendRatio ?? MARKET_TRADING_CREDIT_SPEND_RATIO);
  const energyCreditValue = normalizeNonNegativeNumber(
    input.energyCreditValue ?? MARKET_TRADING_ENERGY_CREDIT_VALUE
  );
  const orders = normalizeOrders(input.orders, minOrderAmount);
  const orderBook = buildMarketOrderBook(orders);
  const resources = collectAnalyzedResources(input.rooms, orders);
  const candidates: MarketTradeCandidate[] = [];

  for (const room of input.rooms) {
    if (!isRoomReadyForMarketTrade(room, gameTime)) {
      continue;
    }

    const resourcePostures = buildResourcePostureByResource(room, resources);
    const hasNeededResource = Array.from(resourcePostures.values()).some((posture) => posture.neededAmount > 0);

    for (const resourceType of resources) {
      const posture = resourcePostures.get(resourceType);
      if (!posture) {
        continue;
      }

      if (posture.excessAmount >= minOrderAmount) {
        candidates.push(
          ...buildSellCandidates({
            room,
            resourceType,
            excessAmount: posture.excessAmount,
            buyOrders: orderBook.buyOrdersByResource.get(resourceType) ?? [],
            sellOrders: orderBook.sellOrdersByResource.get(resourceType) ?? [],
            minOrderAmount,
            maxDealAmount,
            energyCreditValue,
            calcTransactionCost: input.calcTransactionCost,
            hasNeededResource
          })
        );
      }

      if (posture.neededAmount >= minOrderAmount) {
        candidates.push(
          ...buildBuyCandidates({
            room,
            resourceType,
            neededAmount: posture.neededAmount,
            sellOrders: orderBook.sellOrdersByResource.get(resourceType) ?? [],
            buyOrders: orderBook.buyOrdersByResource.get(resourceType) ?? [],
            credits: normalizeNonNegativeNumber(input.credits),
            minCreditsReserve,
            creditSpendRatio,
            minOrderAmount,
            maxDealAmount,
            energyCreditValue,
            calcTransactionCost: input.calcTransactionCost
          })
        );
      }
    }
  }

  candidates.sort(compareMarketTradeCandidates);
  const selected = candidates[0];
  if (!selected) {
    return null;
  }

  const { priority: _priority, ...plan } = selected;
  return plan;
}

function buildSellCandidates({
  room,
  resourceType,
  excessAmount,
  buyOrders,
  sellOrders,
  minOrderAmount,
  maxDealAmount,
  energyCreditValue,
  calcTransactionCost,
  hasNeededResource
}: {
  room: MarketTradingRoomState;
  resourceType: MarketResourceConstant;
  excessAmount: number;
  buyOrders: Order[];
  sellOrders: Order[];
  minOrderAmount: number;
  maxDealAmount: number;
  energyCreditValue: number;
  calcTransactionCost?: (amount: number, roomName1: string, roomName2: string) => number;
  hasNeededResource: boolean;
}): MarketTradeCandidate[] {
  const terminalResourceAmount = getRecordAmount(room.terminalResources, resourceType);
  const reserve = getResourcePolicy(resourceType).reserve;
  const resourceBudget = Math.max(0, terminalResourceAmount - reserve);
  const maxResourceAmount = Math.min(resourceBudget, excessAmount, maxDealAmount);
  if (maxResourceAmount < minOrderAmount) {
    return [];
  }

  const referenceSellOrder = sellOrders[0];
  const referencePrice = normalizeNonNegativeNumber(referenceSellOrder?.price ?? 0);
  const candidates: MarketTradeCandidate[] = [];

  for (const order of buyOrders.slice(0, MAX_ORDERS_PER_RESOURCE_SIDE)) {
    const amount = clampAmountForOrderAndEnergyBudget({
      action: 'sell',
      resourceType,
      requestedAmount: Math.min(maxResourceAmount, getOrderRemainingAmount(order)),
      room,
      order,
      minOrderAmount,
      calcTransactionCost
    });
    if (amount < minOrderAmount) {
      continue;
    }

    const energyCost = calculateOrderEnergyCost(order, room.roomName, amount, calcTransactionCost);
    const spread = normalizeNonNegativeNumber(order.price) - referencePrice;
    const expectedProfit =
      (referenceSellOrder ? spread : normalizeNonNegativeNumber(order.price)) * amount -
      energyCost * energyCreditValue;
    if (expectedProfit <= 0) {
      continue;
    }

    const priority = hasNeededResource ? 2 : 1;
    candidates.push({
      action: 'sell',
      amount,
      creditsDelta: normalizeNonNegativeNumber(order.price) * amount,
      energyCost,
      expectedProfit,
      orderId: order.id,
      price: normalizeNonNegativeNumber(order.price),
      priority,
      reason: 'sellExcess',
      ...(referenceSellOrder ? { referenceOrderId: referenceSellOrder.id } : {}),
      referencePrice,
      resourceType,
      roomName: room.roomName,
      score: priority * 1_000_000_000 + expectedProfit,
      spread,
      terminal: room.terminal
    });
  }

  return candidates;
}

function buildBuyCandidates({
  room,
  resourceType,
  neededAmount,
  sellOrders,
  buyOrders,
  credits,
  minCreditsReserve,
  creditSpendRatio,
  minOrderAmount,
  maxDealAmount,
  energyCreditValue,
  calcTransactionCost
}: {
  room: MarketTradingRoomState;
  resourceType: MarketResourceConstant;
  neededAmount: number;
  sellOrders: Order[];
  buyOrders: Order[];
  credits: number;
  minCreditsReserve: number;
  creditSpendRatio: number;
  minOrderAmount: number;
  maxDealAmount: number;
  energyCreditValue: number;
  calcTransactionCost?: (amount: number, roomName1: string, roomName2: string) => number;
}): MarketTradeCandidate[] {
  const referenceBuyOrder = buyOrders[0];
  if (!referenceBuyOrder || room.terminalFreeCapacity < minOrderAmount) {
    return [];
  }

  const spendBudget = Math.min(
    Math.max(0, credits - minCreditsReserve),
    Math.floor(Math.max(0, credits) * creditSpendRatio)
  );
  if (spendBudget <= 0) {
    return [];
  }

  const referencePrice = normalizeNonNegativeNumber(referenceBuyOrder.price);
  const candidates: MarketTradeCandidate[] = [];

  for (const order of sellOrders.slice(0, MAX_ORDERS_PER_RESOURCE_SIDE)) {
    const price = normalizeNonNegativeNumber(order.price);
    if (price <= 0) {
      continue;
    }

    const amountByCredits = Math.floor(spendBudget / price);
    const requestedAmount = Math.min(
      neededAmount,
      room.terminalFreeCapacity,
      maxDealAmount,
      amountByCredits,
      getOrderRemainingAmount(order)
    );
    const amount = clampAmountForOrderAndEnergyBudget({
      action: 'buy',
      resourceType,
      requestedAmount,
      room,
      order,
      minOrderAmount,
      calcTransactionCost
    });
    if (amount < minOrderAmount) {
      continue;
    }

    const energyCost = calculateOrderEnergyCost(order, room.roomName, amount, calcTransactionCost);
    const spread = referencePrice - price;
    const expectedProfit = spread * amount - energyCost * energyCreditValue;
    if (expectedProfit <= 0) {
      continue;
    }

    const priority = 3;
    candidates.push({
      action: 'buy',
      amount,
      creditsDelta: -price * amount,
      energyCost,
      expectedProfit,
      orderId: order.id,
      price,
      priority,
      reason: 'buyNeeded',
      referenceOrderId: referenceBuyOrder.id,
      referencePrice,
      resourceType,
      roomName: room.roomName,
      score: priority * 1_000_000_000 + expectedProfit,
      spread,
      terminal: room.terminal
    });
  }

  return candidates;
}

function clampAmountForOrderAndEnergyBudget({
  action,
  resourceType,
  requestedAmount,
  room,
  order,
  minOrderAmount,
  calcTransactionCost
}: {
  action: MarketTradeAction;
  resourceType: MarketResourceConstant;
  requestedAmount: number;
  room: MarketTradingRoomState;
  order: Order;
  minOrderAmount: number;
  calcTransactionCost?: (amount: number, roomName1: string, roomName2: string) => number;
}): number {
  const maxAmount = normalizeNonNegativeInteger(requestedAmount);
  if (maxAmount < minOrderAmount || !order.roomName) {
    return 0;
  }

  const energyResource = getEnergyResource();
  const terminalEnergy = getRecordAmount(room.terminalResources, energyResource);
  const energyBudget = Math.max(0, terminalEnergy - TERMINAL_ENERGY_MIN_RESERVE);
  if (energyBudget <= 0) {
    return 0;
  }

  let low = 0;
  let high = maxAmount;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const energyCost = calculateOrderEnergyCost(order, room.roomName, mid, calcTransactionCost);
    const totalEnergySpend = action === 'sell' && resourceType === energyResource
      ? mid + energyCost
      : energyCost;

    if (totalEnergySpend <= energyBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low >= minOrderAmount ? low : 0;
}

function buildMarketTradingRoomStates(gameTime: number): MarketTradingRoomState[] {
  return getOwnedRooms()
    .map((room) => buildMarketTradingRoomState(room, gameTime))
    .filter((state): state is MarketTradingRoomState => state !== null);
}

function buildMarketTradingRoomState(room: Room, gameTime: number): MarketTradingRoomState | null {
  const terminal = room.terminal;
  if (!terminal) {
    return null;
  }

  const terminalResources = collectStoredResources([terminal]);
  const storageResources = collectStoredResources([room.storage]);
  const resources = mergeResourceRecords(storageResources, terminalResources);
  const energyResource = getEnergyResource();
  const terminalEnergy = getRecordAmount(terminalResources, energyResource);
  const terminalFreeCapacity = getStoreFreeCapacity(terminal);
  const memoryAvailableAt = getProjectedMarketAvailableAt(room.name, gameTime);
  const terminalLogisticsAvailableAt = getProjectedTerminalLogisticsAvailableAt(room.name, gameTime);
  const availableAt = Math.max(memoryAvailableAt, terminalLogisticsAvailableAt);

  return {
    roomName: room.name,
    terminal,
    terminalId: getObjectId(terminal),
    terminalCooldown: getTerminalCooldown(terminal),
    terminalEnergy,
    terminalFreeCapacity,
    terminalResources,
    resources,
    ...(availableAt > gameTime ? { availableAt } : {})
  };
}

function buildMarketOrderBook(orders: Order[]): MarketOrderBook {
  const buyOrdersByResource = new Map<MarketResourceConstant, Order[]>();
  const sellOrdersByResource = new Map<MarketResourceConstant, Order[]>();
  const buyType = getOrderBuyConstant();
  const sellType = getOrderSellConstant();

  for (const order of orders) {
    if (order.type === buyType) {
      appendOrder(buyOrdersByResource, order.resourceType, order);
    } else if (order.type === sellType) {
      appendOrder(sellOrdersByResource, order.resourceType, order);
    }
  }

  for (const ordersForResource of buyOrdersByResource.values()) {
    ordersForResource.sort(compareBuyOrders);
  }

  for (const ordersForResource of sellOrdersByResource.values()) {
    ordersForResource.sort(compareSellOrders);
  }

  return { buyOrdersByResource, sellOrdersByResource };
}

function appendOrder(
  ordersByResource: Map<MarketResourceConstant, Order[]>,
  resourceType: MarketResourceConstant,
  order: Order
): void {
  const orders = ordersByResource.get(resourceType) ?? [];
  orders.push(order);
  ordersByResource.set(resourceType, orders);
}

function normalizeOrders(orders: Order[], minOrderAmount: number): Order[] {
  return orders.filter((order) => (
    order.active !== false &&
    typeof order.id === 'string' &&
    order.id.length > 0 &&
    typeof order.roomName === 'string' &&
    order.roomName.length > 0 &&
    getOrderRemainingAmount(order) >= minOrderAmount &&
    normalizeNonNegativeNumber(order.price) > 0
  ));
}

function collectAnalyzedResources(
  rooms: MarketTradingRoomState[],
  orders: Order[]
): MarketResourceConstant[] {
  const resources = new Set<MarketResourceConstant>();
  for (const order of orders) {
    resources.add(order.resourceType);
  }

  for (const room of rooms) {
    for (const resourceType of Object.keys(room.resources)) {
      resources.add(resourceType as MarketResourceConstant);
    }
  }

  return Array.from(resources).sort();
}

function buildResourcePostureByResource(
  room: MarketTradingRoomState,
  resources: MarketResourceConstant[]
): Map<MarketResourceConstant, ResourcePosture> {
  const postures = new Map<MarketResourceConstant, ResourcePosture>();
  for (const resourceType of resources) {
    const totalAmount = getRecordAmount(room.resources, resourceType);
    const terminalAmount = getRecordAmount(room.terminalResources, resourceType);
    const policy = getResourcePolicy(resourceType);
    postures.set(resourceType, {
      excessAmount: Math.min(
        Math.max(0, totalAmount - policy.excess),
        Math.max(0, terminalAmount - policy.reserve)
      ),
      neededAmount: Math.max(0, policy.target - totalAmount)
    });
  }

  return postures;
}

function getResourcePolicy(resourceType: MarketResourceConstant): ResourcePolicy {
  if (resourceType === getEnergyResource()) {
    return {
      reserve: TERMINAL_ENERGY_MIN_RESERVE,
      target: ENERGY_RESOURCE_TARGET,
      excess: ENERGY_RESOURCE_EXCESS
    };
  }

  return {
    reserve: DEFAULT_RESOURCE_RESERVE,
    target: DEFAULT_RESOURCE_TARGET,
    excess: DEFAULT_RESOURCE_EXCESS
  };
}

function isRoomReadyForMarketTrade(room: MarketTradingRoomState, gameTime: number): boolean {
  if (room.terminalCooldown > 0 || room.terminalEnergy <= TERMINAL_ENERGY_MIN_RESERVE) {
    return false;
  }

  return normalizeNonNegativeInteger(room.availableAt ?? 0) <= gameTime;
}

function compareMarketTradeCandidates(left: MarketTradeCandidate, right: MarketTradeCandidate): number {
  return (
    right.priority - left.priority ||
    right.expectedProfit - left.expectedProfit ||
    right.amount - left.amount ||
    left.roomName.localeCompare(right.roomName) ||
    left.resourceType.localeCompare(right.resourceType) ||
    left.orderId.localeCompare(right.orderId)
  );
}

function compareBuyOrders(left: Order, right: Order): number {
  return (
    normalizeNonNegativeNumber(right.price) - normalizeNonNegativeNumber(left.price) ||
    getOrderRemainingAmount(right) - getOrderRemainingAmount(left) ||
    left.id.localeCompare(right.id)
  );
}

function compareSellOrders(left: Order, right: Order): number {
  return (
    normalizeNonNegativeNumber(left.price) - normalizeNonNegativeNumber(right.price) ||
    getOrderRemainingAmount(right) - getOrderRemainingAmount(left) ||
    left.id.localeCompare(right.id)
  );
}

function collectMarketOrderResourceTypes(
  rooms: MarketTradingRoomState[],
  gameTime: number
): MarketResourceConstant[] {
  const resources = new Set<MarketResourceConstant>();
  const minOrderAmount = normalizePositiveInteger(MARKET_TRADING_MIN_ORDER_AMOUNT);

  for (const room of rooms) {
    if (!isRoomReadyForMarketTrade(room, gameTime)) {
      continue;
    }

    const roomResourceTypes = Object.keys(room.resources).sort() as MarketResourceConstant[];
    const postures = buildResourcePostureByResource(room, roomResourceTypes);
    for (const [resourceType, posture] of postures) {
      if (posture.excessAmount >= minOrderAmount || posture.neededAmount >= minOrderAmount) {
        resources.add(resourceType);
      }
    }
  }

  return Array.from(resources).sort();
}

function getMarketOrdersSafely(market: Market, resourceTypes: MarketResourceConstant[]): Order[] {
  const orders: Order[] = [];
  const buyType = getOrderBuyConstant();
  const sellType = getOrderSellConstant();

  for (const resourceType of resourceTypes) {
    orders.push(...getMarketOrdersForFilterSafely(market, { type: buyType, resourceType }));
    orders.push(...getMarketOrdersForFilterSafely(market, { type: sellType, resourceType }));
  }

  return orders;
}

function getMarketOrdersForFilterSafely(market: Market, filter: OrderFilter): Order[] {
  try {
    return market.getAllOrders(filter);
  } catch {
    return [];
  }
}

function calculateMarketTransactionCost(amount: number, roomName1: string, roomName2: string): number {
  const calcTransactionCost = getMarket()?.calcTransactionCost;
  if (typeof calcTransactionCost === 'function') {
    return normalizeNonNegativeInteger(calcTransactionCost(amount, roomName1, roomName2));
  }

  return 0;
}

function calculateOrderEnergyCost(
  order: Order,
  roomName: string,
  amount: number,
  calcTransactionCost?: (amount: number, roomName1: string, roomName2: string) => number
): number {
  if (!order.roomName) {
    return Number.POSITIVE_INFINITY;
  }

  const cost = calcTransactionCost
    ? calcTransactionCost(amount, roomName, order.roomName)
    : calculateMarketTransactionCost(amount, roomName, order.roomName);
  return normalizeNonNegativeInteger(cost);
}

function recordMarketTradingState(
  rooms: MarketTradingRoomState[],
  gameTime: number,
  options: { result?: MarketTradeResult; skippedReason?: string } = {}
): void {
  const memory = getEconomyMemory();
  const existingMarketTrading = memory.marketTrading;
  const existingRooms = existingMarketTrading?.rooms ?? {};
  const roomsMemory: Record<string, EconomyMarketTradingRoomMemory> = {};

  for (const room of rooms) {
    const resourcePostures = buildResourcePostureByResource(
      room,
      Object.keys(room.resources).sort() as MarketResourceConstant[]
    );
    const existingRoom = existingRooms[room.roomName];
    const resultForRoom = options.result?.roomName === room.roomName ? options.result : undefined;
    const availableAt = resultForRoom?.result === OK_CODE
      ? resultForRoom.availableAt
      : normalizeNonNegativeInteger(existingRoom?.availableAt ?? room.availableAt ?? 0);

    roomsMemory[room.roomName] = {
      roomName: room.roomName,
      terminalId: room.terminalId,
      credits: normalizeNonNegativeNumber(getMarket()?.credits ?? 0),
      cooldown: resultForRoom?.result === OK_CODE ? resultForRoom.cooldown : room.terminalCooldown,
      energyBudget: Math.max(0, room.terminalEnergy - TERMINAL_ENERGY_MIN_RESERVE),
      terminalEnergy: room.terminalEnergy,
      terminalFreeCapacity: room.terminalFreeCapacity,
      neededResources: recordResourcePosture(resourcePostures, 'neededAmount'),
      excessResources: recordResourcePosture(resourcePostures, 'excessAmount'),
      ...(availableAt > gameTime ? { availableAt } : {}),
      updatedAt: gameTime
    };
  }

  memory.marketTrading = {
    updatedAt: gameTime,
    nextRunAt: gameTime + MARKET_TRADING_INTERVAL,
    rooms: roomsMemory,
    ...(options.result
      ? { lastDeal: toMarketDealMemory(options.result) }
      : existingMarketTrading?.lastDeal
        ? { lastDeal: existingMarketTrading.lastDeal }
        : {}),
    ...(options.skippedReason ? { skippedReason: options.skippedReason } : {})
  };
}

function recordResourcePosture(
  resourcePostures: Map<MarketResourceConstant, ResourcePosture>,
  field: keyof ResourcePosture
): Record<string, number> {
  return Object.fromEntries(
    Array.from(resourcePostures.entries())
      .map(([resourceType, posture]) => [resourceType, normalizeNonNegativeInteger(posture[field])] as const)
      .filter(([, amount]) => amount > 0)
  );
}

function toMarketDealMemory(result: MarketTradeResult): EconomyMarketDealMemory {
  return {
    action: result.action,
    amount: result.amount,
    availableAt: result.availableAt,
    cooldown: result.cooldown,
    creditsDelta: result.creditsDelta,
    energyCost: result.energyCost,
    expectedProfit: result.expectedProfit,
    orderId: result.orderId,
    price: result.price,
    reason: result.reason,
    ...(result.referenceOrderId ? { referenceOrderId: result.referenceOrderId } : {}),
    referencePrice: result.referencePrice,
    resourceType: result.resourceType,
    result: result.result,
    roomName: result.roomName,
    spread: result.spread,
    updatedAt: result.updatedAt
  };
}

function collectStoredResources(targets: unknown[]): Record<string, number> {
  const resources: Record<string, number> = {};
  for (const target of targets) {
    const store = getStore(target);
    if (!store) {
      continue;
    }

    for (const [key, value] of Object.entries(store)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        resources[key] = (resources[key] ?? 0) + Math.floor(value);
      }
    }

    for (const resourceType of Object.keys(resources)) {
      const amount = getStoreUsedCapacity(store, resourceType as ResourceConstant);
      if (amount > resources[resourceType]) {
        resources[resourceType] = amount;
      }
    }

    const energyResource = getEnergyResource();
    const energyAmount = getStoreUsedCapacity(store, energyResource);
    if (energyAmount > 0) {
      resources[energyResource] = Math.max(resources[energyResource] ?? 0, energyAmount);
    }
  }

  return resources;
}

function mergeResourceRecords(...records: Array<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const record of records) {
    for (const [resourceType, amount] of Object.entries(record)) {
      merged[resourceType] = (merged[resourceType] ?? 0) + normalizeNonNegativeInteger(amount);
    }
  }

  return merged;
}

function getStoreFreeCapacity(target: unknown): number {
  const store = getStore(target);
  if (!store) {
    return 0;
  }

  const genericFreeCapacity = store.getFreeCapacity?.();
  if (typeof genericFreeCapacity === 'number' && Number.isFinite(genericFreeCapacity)) {
    return Math.max(0, Math.floor(genericFreeCapacity));
  }

  const energyFreeCapacity = store.getFreeCapacity?.(getEnergyResource());
  if (typeof energyFreeCapacity === 'number' && Number.isFinite(energyFreeCapacity)) {
    return Math.max(0, Math.floor(energyFreeCapacity));
  }

  return 0;
}

function getStoreUsedCapacity(store: StoreLike, resourceType: ResourceConstant): number {
  const usedCapacity = store.getUsedCapacity?.(resourceType);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, Math.floor(usedCapacity));
  }

  const directAmount = store[resourceType];
  return typeof directAmount === 'number' && Number.isFinite(directAmount)
    ? Math.max(0, Math.floor(directAmount))
    : 0;
}

function getStore(target: unknown): StoreLike | undefined {
  return (target as { store?: StoreLike } | null)?.store;
}

function getRecordAmount(record: Record<string, number>, resourceType: MarketResourceConstant): number {
  return normalizeNonNegativeInteger(record[resourceType]);
}

function getOrderRemainingAmount(order: Order): number {
  return normalizeNonNegativeInteger(order.remainingAmount ?? order.amount);
}

function getProjectedMarketAvailableAt(roomName: string, gameTime: number): number {
  const availableAt = getEconomyMemory().marketTrading?.rooms?.[roomName]?.availableAt;
  return normalizeNonNegativeInteger(availableAt) > gameTime ? normalizeNonNegativeInteger(availableAt) : 0;
}

function getProjectedTerminalLogisticsAvailableAt(roomName: string, gameTime: number): number {
  const availableAt = getEconomyMemory().terminalLogistics?.rooms?.[roomName]?.availableAt;
  return normalizeNonNegativeInteger(availableAt) > gameTime ? normalizeNonNegativeInteger(availableAt) : 0;
}

function getOwnedRooms(): Room[] {
  const rooms = (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms;
  if (!rooms) {
    return [];
  }

  return Object.values(rooms).filter((room): room is Room => room?.controller?.my === true);
}

function getMarket(): Market | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'market'>> }).Game?.market;
}

function getEconomyMemory(): EconomyMemory {
  const memory = getMemory();
  if (!memory.economy) {
    memory.economy = {};
  }

  return memory.economy;
}

function getMemory(): Partial<Memory> {
  const global = globalThis as unknown as { Memory?: Partial<Memory> };
  if (!global.Memory) {
    global.Memory = {};
  }

  return global.Memory;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Pick<Game, 'time'>> }).Game?.time;
  return normalizeNonNegativeInteger(gameTime);
}

function getTerminalCooldown(terminal: StructureTerminal): number {
  const cooldown = terminal.cooldown;
  return normalizeNonNegativeInteger(cooldown);
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function getOrderBuyConstant(): ORDER_BUY {
  return ((globalThis as { ORDER_BUY?: ORDER_BUY }).ORDER_BUY ?? 'buy') as ORDER_BUY;
}

function getOrderSellConstant(): ORDER_SELL {
  return ((globalThis as { ORDER_SELL?: ORDER_SELL }).ORDER_SELL ?? 'sell') as ORDER_SELL;
}

function getObjectId(object: unknown): string | undefined {
  if (typeof object !== 'object' || object === null) {
    return undefined;
  }

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  return typeof candidate.name === 'string' ? candidate.name : undefined;
}

function normalizePositiveInteger(value: unknown): number {
  const normalized = normalizeNonNegativeInteger(value);
  return normalized > 0 ? normalized : 1;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeRatio(value: unknown): number {
  const normalized = normalizeNonNegativeNumber(value);
  return Math.max(0, Math.min(1, normalized));
}
