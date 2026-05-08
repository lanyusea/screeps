import { getTerminalEnergyTarget } from './energySurplus';
import {
  getRoomStoredEnergyState,
  getStorageBalanceState,
  type RoomStoredEnergyState
} from './storageBalancer';

export const TERMINAL_ENERGY_MIN_RESERVE = 20_000;
export const TERMINAL_MAX_ENERGY_SEND_AMOUNT = 10_000;
export const TERMINAL_MIN_ENERGY_SEND_AMOUNT = 100;

const OK_CODE = 0 as ScreepsReturnCode;

interface TerminalStoreLike {
  getUsedCapacity?: (resource?: ResourceConstant) => number | null;
  getCapacity?: (resource?: ResourceConstant) => number | null;
  getFreeCapacity?: (resource?: ResourceConstant) => number | null;
  [resource: string]: unknown;
}

export interface TerminalEnergyTransferPlan {
  amount: number;
  cooldown: number;
  description: string;
  distance: number;
  energyCost: number;
  sourceRoom: string;
  sourceTerminal: StructureTerminal;
  targetRoom: string;
  targetTerminal: StructureTerminal;
}

export interface TerminalEnergyTransferResult {
  amount: number;
  availableAt: number;
  cooldown: number;
  description: string;
  distance: number;
  energyCost: number;
  result: ScreepsReturnCode;
  sourceRoom: string;
  targetRoom: string;
}

interface TerminalTransferSelectionFilter {
  sourceRoom?: string;
  targetRoom?: string;
}

interface ProjectedTerminalRoomState {
  room: Room;
  state: RoomStoredEnergyState;
  terminal: StructureTerminal;
  terminalEnergy: number;
  terminalFreeCapacity: number;
  terminalTargetEnergy: number;
  cooldown: number;
  sourceBudget: number;
  targetDemand: number;
}

export function manageTerminalEnergy(): TerminalEnergyTransferResult[] {
  const plans = selectTerminalEnergyTransfers();
  const results: TerminalEnergyTransferResult[] = [];
  const gameTime = getGameTime();

  for (const plan of plans) {
    const result = plan.sourceTerminal.send(
      getEnergyResource(),
      plan.amount,
      plan.targetRoom,
      plan.description
    );
    const transferResult: TerminalEnergyTransferResult = {
      amount: plan.amount,
      availableAt: gameTime + plan.cooldown,
      cooldown: plan.cooldown,
      description: plan.description,
      distance: plan.distance,
      energyCost: plan.energyCost,
      result,
      sourceRoom: plan.sourceRoom,
      targetRoom: plan.targetRoom
    };
    results.push(transferResult);

    if (result === OK_CODE) {
      reduceStorageBalanceTransfer(plan.sourceRoom, plan.targetRoom, plan.amount, gameTime);
    }
  }

  recordTerminalLogisticsState(results, gameTime);
  return results;
}

export function selectTerminalEnergyExport(room: Room): TerminalEnergyTransferPlan | null {
  return selectTerminalEnergyTransfer({ sourceRoom: room.name });
}

export function selectTerminalEnergyImport(room: Room): TerminalEnergyTransferPlan | null {
  return selectTerminalEnergyTransfer({ targetRoom: room.name });
}

export function selectTerminalEnergyTransfer(
  filter: TerminalTransferSelectionFilter = {}
): TerminalEnergyTransferPlan | null {
  return selectTerminalEnergyTransfers(filter)[0] ?? null;
}

export function selectTerminalEnergyTransfers(
  filter: TerminalTransferSelectionFilter = {}
): TerminalEnergyTransferPlan[] {
  const balance = getStorageBalanceState();
  const roomStates = buildProjectedTerminalRoomStates();
  const selectedPlans: TerminalEnergyTransferPlan[] = [];
  const spentSourceRooms = new Set<string>();

  for (const transfer of [...balance.transfers].filter((candidate) => candidate.amount > 0).sort(compareStorageTransfers)) {
    if (filter.sourceRoom && transfer.sourceRoom !== filter.sourceRoom) {
      continue;
    }

    if (filter.targetRoom && transfer.targetRoom !== filter.targetRoom) {
      continue;
    }

    if (spentSourceRooms.has(transfer.sourceRoom)) {
      continue;
    }

    const sourceState = roomStates.get(transfer.sourceRoom);
    const targetState = roomStates.get(transfer.targetRoom);
    if (!sourceState || !targetState || sourceState.room.name === targetState.room.name) {
      continue;
    }

    const plan = buildTerminalEnergyTransferPlan(transfer, sourceState, targetState);
    if (!plan) {
      continue;
    }

    selectedPlans.push(plan);
    spentSourceRooms.add(plan.sourceRoom);
    sourceState.sourceBudget = Math.max(0, sourceState.sourceBudget - plan.amount - plan.energyCost);
    sourceState.terminalEnergy = Math.max(0, sourceState.terminalEnergy - plan.amount - plan.energyCost);
    sourceState.cooldown = plan.cooldown;
    targetState.targetDemand = Math.max(0, targetState.targetDemand - plan.amount);
    targetState.terminalEnergy += plan.amount;
    targetState.terminalFreeCapacity = Math.max(0, targetState.terminalFreeCapacity - plan.amount);
  }

  return selectedPlans;
}

export function calculateTerminalEnergyCost(
  fromRoom: string,
  targetRoom: string,
  amount: number
): number {
  return calculateTerminalEnergyCostForDistance(
    getRoomLinearDistance(fromRoom, targetRoom) ?? 0,
    amount
  );
}

export function calculateTerminalEnergyCostForDistance(distance: number, amount: number): number {
  const normalizedDistance = normalizeNonNegativeInteger(distance);
  const normalizedAmount = normalizeNonNegativeInteger(amount);
  return Math.floor(0.1 * normalizedDistance * normalizedAmount);
}

export function getTerminalSendCooldown(amount: number): number {
  const normalizedAmount = normalizeNonNegativeInteger(amount);
  return normalizedAmount > 0 ? Math.max(1, Math.ceil(normalizedAmount / 100)) : 0;
}

function buildTerminalEnergyTransferPlan(
  transfer: EconomyStorageTransferMemory,
  sourceState: ProjectedTerminalRoomState,
  targetState: ProjectedTerminalRoomState
): TerminalEnergyTransferPlan | null {
  if (
    sourceState.state.mode !== 'export' ||
    targetState.state.mode !== 'import' ||
    sourceState.cooldown > 0 ||
    sourceState.sourceBudget <= 0 ||
    targetState.targetDemand <= 0
  ) {
    return null;
  }

  const distance = getRoomLinearDistance(sourceState.room.name, targetState.room.name);
  if (distance === null || distance <= 0) {
    return null;
  }

  const requestedAmount = Math.min(
    transfer.amount,
    sourceState.sourceBudget,
    targetState.targetDemand,
    TERMINAL_MAX_ENERGY_SEND_AMOUNT
  );
  const amount = clampSendAmountForEnergyBudget(requestedAmount, distance, sourceState.sourceBudget);
  if (amount < TERMINAL_MIN_ENERGY_SEND_AMOUNT) {
    return null;
  }

  const energyCost = calculateTerminalEnergyCostForDistance(distance, amount);
  return {
    amount,
    cooldown: getTerminalSendCooldown(amount),
    description: `energy-balance ${sourceState.room.name}->${targetState.room.name}`,
    distance,
    energyCost,
    sourceRoom: sourceState.room.name,
    sourceTerminal: sourceState.terminal,
    targetRoom: targetState.room.name,
    targetTerminal: targetState.terminal
  };
}

function buildProjectedTerminalRoomStates(): Map<string, ProjectedTerminalRoomState> {
  return new Map(
    getOwnedRooms()
      .map((room) => buildProjectedTerminalRoomState(room))
      .filter((state): state is ProjectedTerminalRoomState => state !== null)
      .map((state) => [state.room.name, state])
  );
}

function buildProjectedTerminalRoomState(room: Room): ProjectedTerminalRoomState | null {
  const terminal = room.terminal;
  if (!terminal) {
    return null;
  }

  const state = getRoomStoredEnergyState(room);
  const terminalEnergy = getStoredEnergy(terminal);
  const terminalFreeCapacity = getFreeEnergyCapacity(terminal);
  const terminalTargetEnergy = getTerminalEnergyTarget(terminal);
  const sourceBudget = Math.min(
    state.exportableEnergy,
    Math.max(0, terminalEnergy - TERMINAL_ENERGY_MIN_RESERVE)
  );
  const targetDemand = Math.min(
    state.importDemand,
    terminalFreeCapacity,
    Math.max(0, terminalTargetEnergy - terminalEnergy)
  );

  return {
    room,
    state,
    terminal,
    terminalEnergy,
    terminalFreeCapacity,
    terminalTargetEnergy,
    cooldown: getTerminalCooldown(terminal),
    sourceBudget,
    targetDemand
  };
}

function clampSendAmountForEnergyBudget(
  requestedAmount: number,
  distance: number,
  energyBudget: number
): number {
  const normalizedBudget = normalizeNonNegativeInteger(energyBudget);
  if (normalizedBudget <= 0) {
    return 0;
  }

  let amount = Math.min(
    normalizeNonNegativeInteger(requestedAmount),
    Math.floor(normalizedBudget / (1 + 0.1 * Math.max(0, distance)))
  );
  while (amount > 0 && amount + calculateTerminalEnergyCostForDistance(distance, amount) > normalizedBudget) {
    amount -= 1;
  }

  return amount;
}

function compareStorageTransfers(
  left: EconomyStorageTransferMemory,
  right: EconomyStorageTransferMemory
): number {
  const leftDistance = getRoomLinearDistance(left.sourceRoom, left.targetRoom) ?? Number.POSITIVE_INFINITY;
  const rightDistance = getRoomLinearDistance(right.sourceRoom, right.targetRoom) ?? Number.POSITIVE_INFINITY;
  return (
    getTransferEfficiency(right, rightDistance) -
      getTransferEfficiency(left, leftDistance) ||
    right.amount - left.amount ||
    leftDistance - rightDistance ||
    left.sourceRoom.localeCompare(right.sourceRoom) ||
    left.targetRoom.localeCompare(right.targetRoom)
  );
}

function getTransferEfficiency(transfer: EconomyStorageTransferMemory, distance: number): number {
  if (!Number.isFinite(distance)) {
    return 0;
  }

  return transfer.amount / Math.max(1, transfer.amount + calculateTerminalEnergyCostForDistance(distance, transfer.amount));
}

function reduceStorageBalanceTransfer(
  sourceRoom: string,
  targetRoom: string,
  sentAmount: number,
  gameTime: number
): void {
  const memory = getEconomyMemory();
  const balance = memory.storageBalance;
  if (!balance || !Array.isArray(balance.transfers)) {
    return;
  }

  const updatedTransfers: EconomyStorageTransferMemory[] = [];
  let remainingSentAmount = sentAmount;
  for (const transfer of balance.transfers) {
    if (
      remainingSentAmount > 0 &&
      transfer.sourceRoom === sourceRoom &&
      transfer.targetRoom === targetRoom
    ) {
      const reduction = Math.min(transfer.amount, remainingSentAmount);
      remainingSentAmount -= reduction;
      const amount = transfer.amount - reduction;
      if (amount > 0) {
        updatedTransfers.push({ ...transfer, amount, updatedAt: gameTime });
      }
      continue;
    }

    updatedTransfers.push(transfer);
  }

  balance.transfers = updatedTransfers;
}

function recordTerminalLogisticsState(
  results: TerminalEnergyTransferResult[],
  gameTime: number
): void {
  const memory = getEconomyMemory();
  const resultBySourceRoom = new Map(results.map((result) => [result.sourceRoom, result]));
  const rooms = Object.fromEntries(
    getOwnedRooms()
      .filter((room) => room.terminal !== undefined)
      .map((room) => {
        const terminal = room.terminal as StructureTerminal;
        const result = resultBySourceRoom.get(room.name);
        const cooldown = result?.result === OK_CODE ? result.cooldown : getTerminalCooldown(terminal);
        return [
          room.name,
          {
            roomName: room.name,
            terminalId: getObjectId(terminal),
            energy: getStoredEnergy(terminal),
            freeCapacity: getFreeEnergyCapacity(terminal),
            cooldown,
            ...(result?.result === OK_CODE
              ? {
                  projectedCooldown: result.cooldown,
                  availableAt: result.availableAt
                }
              : {}),
            updatedAt: gameTime
          }
        ];
      })
  );

  memory.terminalLogistics = {
    updatedAt: gameTime,
    rooms,
    transfers: results.map((result) => ({
      sourceRoom: result.sourceRoom,
      targetRoom: result.targetRoom,
      amount: result.amount,
      energyCost: result.energyCost,
      distance: result.distance,
      cooldown: result.cooldown,
      availableAt: result.availableAt,
      result: result.result,
      description: result.description,
      updatedAt: gameTime
    }))
  };
}

function getOwnedRooms(): Room[] {
  const rooms = (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms;
  if (!rooms) {
    return [];
  }

  return Object.values(rooms).filter((room): room is Room => room?.controller?.my === true);
}

function getStoredEnergy(target: unknown): number {
  const store = getStore(target);
  const resource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(resource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const directEnergy = store?.[resource];
  return typeof directEnergy === 'number' && Number.isFinite(directEnergy)
    ? Math.max(0, directEnergy)
    : 0;
}

function getFreeEnergyCapacity(target: unknown): number {
  const store = getStore(target);
  const resource = getEnergyResource();
  const freeCapacity = store?.getFreeCapacity?.(resource);
  if (typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)) {
    return Math.max(0, freeCapacity);
  }

  const capacity = getEnergyCapacity(target);
  return capacity > 0 ? Math.max(0, capacity - getStoredEnergy(target)) : 0;
}

function getEnergyCapacity(target: unknown): number {
  const store = getStore(target);
  const resource = getEnergyResource();
  const capacity = store?.getCapacity?.(resource);
  if (typeof capacity === 'number' && Number.isFinite(capacity)) {
    return Math.max(0, capacity);
  }

  const genericCapacity = store?.getCapacity?.();
  if (typeof genericCapacity === 'number' && Number.isFinite(genericCapacity)) {
    return Math.max(0, genericCapacity);
  }

  const freeCapacity = store?.getFreeCapacity?.(resource);
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)
    ? getStoredEnergy(target) + Math.max(0, freeCapacity)
    : 0;
}

function getStore(target: unknown): TerminalStoreLike | undefined {
  return (target as { store?: TerminalStoreLike } | null)?.store;
}

function getTerminalCooldown(terminal: StructureTerminal): number {
  const cooldown = terminal.cooldown;
  return typeof cooldown === 'number' && Number.isFinite(cooldown) ? Math.max(0, Math.floor(cooldown)) : 0;
}

function getRoomLinearDistance(fromRoom: string, targetRoom: string): number | null {
  const distance = (globalThis as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map?.getRoomLinearDistance?.(
    fromRoom,
    targetRoom
  );
  return typeof distance === 'number' && Number.isFinite(distance) ? Math.max(0, Math.floor(distance)) : null;
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
  return typeof gameTime === 'number' && Number.isFinite(gameTime) ? gameTime : 0;
}

function getEnergyResource(): ResourceConstant {
  return ((globalThis as { RESOURCE_ENERGY?: ResourceConstant }).RESOURCE_ENERGY ?? 'energy') as ResourceConstant;
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const candidate = object as { id?: unknown; name?: unknown };
  if (typeof candidate.id === 'string') {
    return candidate.id;
  }

  return typeof candidate.name === 'string' ? candidate.name : '';
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
