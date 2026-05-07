import { getRoomSpawnEnergyReservationState } from './spawnEnergyReservation';

export const TERMINAL_ENERGY_TARGET = 50_000;
export const TERMINAL_SURPLUS_ROUTING_STORAGE_FLOOR = 5_000;

type EnergySurplusSink = StructureStorage | StructureTerminal;
type EnergySurplusStructureGlobal =
  | 'STRUCTURE_CONTAINER'
  | 'STRUCTURE_EXTENSION'
  | 'STRUCTURE_SPAWN'
  | 'STRUCTURE_STORAGE'
  | 'STRUCTURE_TERMINAL';

export interface RoomEnergySurplusState {
  roomName: string;
  surplus: boolean;
  spawnExtensionsFull: boolean;
  containersFull: boolean;
  reservedSpawnEnergy: number;
  unmetSpawnEnergyReservation: number;
  spawnExtensionFreeCapacity: number;
  containerFreeCapacity: number;
  durableFreeCapacity: number;
  storageEnergy: number;
  storageFreeCapacity: number;
  terminalEnergy: number;
  terminalFreeCapacity: number;
  terminalTargetEnergy: number;
  terminalEnergyDeficit: number;
  terminalEnergySurplus: number;
  selectedSinkId?: string;
  selectedSinkType?: 'storage' | 'terminal';
}

export interface EnergySurplusRoutingResult {
  assignedTasks: number;
  routedEnergy: number;
  state: RoomEnergySurplusState;
}

export function getRoomEnergySurplusState(room: Room): RoomEnergySurplusState {
  const ownedStructures = findOwnedStructures(room);
  const roomStructures = findRoomStructures(room, ownedStructures);
  const spawnExtensionState = getSpawnExtensionEnergyState(room, ownedStructures);
  const containerState = getContainerEnergyState(roomStructures);
  const storage = getRoomStorage(room, ownedStructures);
  const terminal = getRoomTerminal(room, ownedStructures);
  const storageEnergy = storage ? getStoredEnergy(storage) : 0;
  const storageFreeCapacity = storage ? getFreeEnergyCapacity(storage) : 0;
  const terminalEnergy = terminal ? getStoredEnergy(terminal) : 0;
  const terminalFreeCapacity = terminal ? getFreeEnergyCapacity(terminal) : 0;
  const terminalTargetEnergy = getTerminalEnergyTarget(terminal);
  const terminalEnergyDeficit = Math.max(0, terminalTargetEnergy - terminalEnergy);
  const terminalEnergySurplus = Math.max(0, terminalEnergy - terminalTargetEnergy);
  const durableFreeCapacity = storageFreeCapacity + terminalFreeCapacity;
  const spawnEnergyReservation = getRoomSpawnEnergyReservationState(room);
  const surplus =
    spawnExtensionState.full &&
    containerState.full &&
    durableFreeCapacity > 0 &&
    room.controller?.my === true &&
    spawnEnergyReservation.unmetReservedEnergy <= 0;
  const selectedSink = surplus ? selectEnergySurplusSinkFromStores(storage, terminal, 1) : null;

  return {
    roomName: room.name,
    surplus,
    spawnExtensionsFull: spawnExtensionState.full,
    containersFull: containerState.full,
    reservedSpawnEnergy: spawnEnergyReservation.reservedEnergy,
    unmetSpawnEnergyReservation: spawnEnergyReservation.unmetReservedEnergy,
    spawnExtensionFreeCapacity: spawnExtensionState.freeCapacity,
    containerFreeCapacity: containerState.freeCapacity,
    durableFreeCapacity,
    storageEnergy,
    storageFreeCapacity,
    terminalEnergy,
    terminalFreeCapacity,
    terminalTargetEnergy,
    terminalEnergyDeficit,
    terminalEnergySurplus,
    ...(selectedSink ? {
      selectedSinkId: getObjectId(selectedSink),
      selectedSinkType: isTerminal(selectedSink) ? 'terminal' : 'storage'
    } : {})
  };
}

export function refreshRoomEnergySurplusState(room: Room): RoomEnergySurplusState {
  const state = getRoomEnergySurplusState(room);
  const memory = getEconomyMemory();
  const updatedAt = getGameTime();
  if (!isPlainObject(memory.energySurplus) || !isPlainObject(memory.energySurplus.rooms)) {
    memory.energySurplus = { updatedAt, rooms: {} };
  }

  memory.energySurplus.updatedAt = updatedAt;
  memory.energySurplus.rooms[room.name] = {
    ...state,
    updatedAt
  };
  return state;
}

export function selectEnergySurplusDeliverySink(
  room: Room,
  minimumFreeCapacity = 1
): EnergySurplusSink | null {
  const state = getRoomEnergySurplusState(room);
  if (!state.surplus) {
    return null;
  }

  const ownedStructures = findOwnedStructures(room);
  return selectEnergySurplusSinkFromStores(
    getRoomStorage(room, ownedStructures),
    getRoomTerminal(room, ownedStructures),
    minimumFreeCapacity
  );
}

export function routeEnergySurplus(room: Room): EnergySurplusRoutingResult {
  const state = refreshRoomEnergySurplusState(room);
  const ownedStructures = findOwnedStructures(room);
  const sink = state.surplus
    ? selectEnergySurplusSinkFromStores(
      getRoomStorage(room, ownedStructures),
      getRoomTerminal(room, ownedStructures),
      1
    )
    : null;
  if (!sink) {
    return { assignedTasks: 0, routedEnergy: 0, state };
  }

  let remainingSinkCapacity = getFreeEnergyCapacity(sink);
  let assignedTasks = 0;
  let routedEnergy = 0;
  const sinkId = getObjectId(sink);

  for (const worker of findMyCreeps(room)
    .filter((creep) => isEligibleSurplusWorker(creep, room.name))
    .sort(compareCreepsByStableId)) {
    const carriedEnergy = getStoredEnergy(worker);
    if (carriedEnergy <= 0) {
      continue;
    }

    if (isTransferTaskTo(worker.memory.task, sinkId)) {
      remainingSinkCapacity = Math.max(0, remainingSinkCapacity - carriedEnergy);
      routedEnergy += carriedEnergy;
      continue;
    }

    if (!isAssignableSurplusWorker(worker) || carriedEnergy > remainingSinkCapacity) {
      continue;
    }

    worker.memory.task = { type: 'transfer', targetId: sink.id as Id<AnyStoreStructure> };
    assignedTasks += 1;
    routedEnergy += carriedEnergy;
    remainingSinkCapacity = Math.max(0, remainingSinkCapacity - carriedEnergy);
  }

  return { assignedTasks, routedEnergy, state };
}

export function getTerminalEnergyTarget(terminal: StructureTerminal | null | undefined): number {
  if (!terminal) {
    return 0;
  }

  const capacity = getEnergyCapacity(terminal);
  return capacity > 0 ? Math.min(TERMINAL_ENERGY_TARGET, capacity) : TERMINAL_ENERGY_TARGET;
}

function selectEnergySurplusSinkFromStores(
  storage: StructureStorage | null,
  terminal: StructureTerminal | null,
  minimumFreeCapacity: number
): EnergySurplusSink | null {
  if (
    terminal &&
    getFreeEnergyCapacity(terminal) >= minimumFreeCapacity &&
    shouldRouteSurplusToTerminal(storage, terminal)
  ) {
    return terminal;
  }

  if (storage && getFreeEnergyCapacity(storage) >= minimumFreeCapacity) {
    return storage;
  }

  if (terminal && getFreeEnergyCapacity(terminal) >= minimumFreeCapacity) {
    return terminal;
  }

  return null;
}

function shouldRouteSurplusToTerminal(
  storage: StructureStorage | null,
  terminal: StructureTerminal
): boolean {
  if (getTerminalEnergyTarget(terminal) <= getStoredEnergy(terminal)) {
    return false;
  }

  if (!storage) {
    return true;
  }

  return getFreeEnergyCapacity(storage) <= 0 || getStoredEnergy(storage) >= TERMINAL_SURPLUS_ROUTING_STORAGE_FLOOR;
}

function getSpawnExtensionEnergyState(
  room: Room,
  ownedStructures: AnyOwnedStructure[]
): { full: boolean; freeCapacity: number } {
  const knownEnergy = getKnownRoomSpawnExtensionFreeCapacity(room);
  if (knownEnergy) {
    return {
      full: knownEnergy.capacity > 0 && knownEnergy.freeCapacity <= 0,
      freeCapacity: knownEnergy.freeCapacity
    };
  }

  const spawnExtensions = ownedStructures.filter(isSpawnOrExtension);
  const freeCapacity = spawnExtensions.reduce((total, structure) => total + getFreeEnergyCapacity(structure), 0);
  return {
    full: spawnExtensions.length > 0 && freeCapacity <= 0,
    freeCapacity
  };
}

function getKnownRoomSpawnExtensionFreeCapacity(
  room: Room
): { capacity: number; freeCapacity: number } | null {
  const energyAvailable = (room as Partial<Room>).energyAvailable;
  const energyCapacityAvailable = (room as Partial<Room>).energyCapacityAvailable;
  if (
    typeof energyAvailable !== 'number' ||
    !Number.isFinite(energyAvailable) ||
    typeof energyCapacityAvailable !== 'number' ||
    !Number.isFinite(energyCapacityAvailable)
  ) {
    return null;
  }

  const capacity = Math.max(0, energyCapacityAvailable);
  return {
    capacity,
    freeCapacity: Math.max(0, capacity - Math.max(0, energyAvailable))
  };
}

function getContainerEnergyState(structures: AnyStructure[]): { full: boolean; freeCapacity: number } {
  const containers = structures.filter(isContainer);
  const freeCapacity = containers.reduce((total, structure) => total + getFreeEnergyCapacity(structure), 0);
  return {
    full: containers.length === 0 || freeCapacity <= 0,
    freeCapacity
  };
}

function findOwnedStructures(room: Room): AnyOwnedStructure[] {
  if (typeof FIND_MY_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = room.find(FIND_MY_STRUCTURES);
  return Array.isArray(result) ? result : [];
}

function findRoomStructures(room: Room, ownedStructures: AnyOwnedStructure[]): AnyStructure[] {
  if (typeof FIND_STRUCTURES !== 'number' || typeof room.find !== 'function') {
    return ownedStructures;
  }

  const result = room.find(FIND_STRUCTURES);
  return Array.isArray(result) ? result : ownedStructures;
}

function findMyCreeps(room: Room): Creep[] {
  if (typeof FIND_MY_CREEPS !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  const result = room.find(FIND_MY_CREEPS);
  return Array.isArray(result) ? result : [];
}

function getRoomStorage(room: Room, ownedStructures: AnyOwnedStructure[]): StructureStorage | null {
  return room.storage ?? ownedStructures.find(isStorage) ?? null;
}

function getRoomTerminal(room: Room, ownedStructures: AnyOwnedStructure[]): StructureTerminal | null {
  return room.terminal ?? ownedStructures.find(isTerminal) ?? null;
}

function isEligibleSurplusWorker(creep: Creep, colonyName: string): boolean {
  return (
    creep.memory?.role === 'worker' &&
    creep.memory?.colony === colonyName &&
    !creep.memory?.controllerSustain &&
    !creep.memory?.territory
  );
}

function isAssignableSurplusWorker(creep: Creep): boolean {
  const task = creep.memory.task;
  return !task || task.type === 'build' || task.type === 'repair' || task.type === 'upgrade';
}

function isTransferTaskTo(task: CreepTaskMemory | undefined, targetId: string): boolean {
  return task?.type === 'transfer' && String(task.targetId) === targetId;
}

function compareCreepsByStableId(left: Creep, right: Creep): number {
  return getCreepStableId(left).localeCompare(getCreepStableId(right));
}

function getCreepStableId(creep: Creep): string {
  const name = (creep as { name?: unknown }).name;
  if (typeof name === 'string') {
    return name;
  }

  const id = (creep as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function isSpawnOrExtension(structure: AnyOwnedStructure): structure is StructureSpawn | StructureExtension {
  return (
    matchesStructureType(structure.structureType, 'STRUCTURE_SPAWN', 'spawn') ||
    matchesStructureType(structure.structureType, 'STRUCTURE_EXTENSION', 'extension')
  );
}

function isContainer(structure: AnyStructure): structure is StructureContainer {
  return matchesStructureType(structure.structureType, 'STRUCTURE_CONTAINER', 'container');
}

function isStorage(structure: AnyOwnedStructure): structure is StructureStorage {
  return matchesStructureType(structure.structureType, 'STRUCTURE_STORAGE', 'storage');
}

function isTerminal(structure: AnyOwnedStructure | StructureTerminal): structure is StructureTerminal {
  return matchesStructureType(structure.structureType, 'STRUCTURE_TERMINAL', 'terminal');
}

function getStoredEnergy(target: unknown): number {
  const store = (target as { store?: StoreLike } | null)?.store;
  const resource = getEnergyResource();
  const usedCapacity = store?.getUsedCapacity?.(resource);
  if (typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)) {
    return Math.max(0, usedCapacity);
  }

  const directEnergy = store?.[resource];
  return typeof directEnergy === 'number' && Number.isFinite(directEnergy) ? Math.max(0, directEnergy) : 0;
}

function getFreeEnergyCapacity(target: unknown): number {
  const store = (target as { store?: StoreLike } | null)?.store;
  const resource = getEnergyResource();
  const freeCapacity = store?.getFreeCapacity?.(resource);
  if (typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)) {
    return Math.max(0, freeCapacity);
  }

  const capacity = getEnergyCapacity(target);
  return capacity > 0 ? Math.max(0, capacity - getStoredEnergy(target)) : 0;
}

function getEnergyCapacity(target: unknown): number {
  const store = (target as { store?: StoreLike } | null)?.store;
  const resource = getEnergyResource();
  const capacity = store?.getCapacity?.(resource);
  if (typeof capacity === 'number' && Number.isFinite(capacity)) {
    return Math.max(0, capacity);
  }

  const genericCapacity = store?.getCapacity?.();
  return typeof genericCapacity === 'number' && Number.isFinite(genericCapacity)
    ? Math.max(0, genericCapacity)
    : 0;
}

function getObjectId(object: unknown): string {
  if (typeof object !== 'object' || object === null) {
    return '';
  }

  const id = (object as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getEconomyMemory(): EconomyMemory {
  const memory = getMemory();
  if (!memory.economy) {
    memory.economy = {};
  }

  return memory.economy;
}

function getMemory(): Partial<Memory> {
  const global = globalThis as { Memory?: Partial<Memory> };
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

function matchesStructureType(
  actual: string | undefined,
  globalName: EnergySurplusStructureGlobal,
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<EnergySurplusStructureGlobal, string>>;
  return actual === (constants[globalName] ?? fallback);
}

interface StoreLike {
  getCapacity?: (resource?: ResourceConstant) => number | null;
  getFreeCapacity?: (resource?: ResourceConstant) => number | null;
  getUsedCapacity?: (resource?: ResourceConstant) => number | null;
  [resource: string]: unknown;
}
