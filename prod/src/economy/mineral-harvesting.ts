import type { ColonySnapshot } from '../colony/colonyRegistry';
import type { SpawnRequest } from '../spawn/spawnPlanner';

export const MINERAL_HARVESTER_ROLE = 'mineralHarvester';

const MINERAL_HARVESTER_REPLACEMENT_TICKS = 100;
const MINERAL_HARVESTING_MIN_ENERGY_RATIO = 0.3;
const MINERAL_MOVE_OPTS: MoveToOpts = { reusePath: 20, ignoreRoads: false };
const ERR_NOT_IN_RANGE_CODE = -9 as ScreepsReturnCode;

type MineralDeliveryTarget = StructureStorage | StructureTerminal;

export interface MineralHarvestAssignment {
  homeRoom: string;
  mineralId: Id<Mineral>;
  mineralType?: ResourceConstant;
  targetId: Id<AnyStoreStructure>;
}

export interface MineralHarvesterSpawnOptions {
  energyAvailable?: number;
  bodyEnergyBudget?: number;
  usedSpawns?: ReadonlySet<StructureSpawn>;
}

export function planMineralHarvesterSpawn(
  colony: ColonySnapshot,
  creeps: Creep[],
  gameTime: number,
  options: MineralHarvesterSpawnOptions = {}
): SpawnRequest | null {
  const energyAvailable = normalizeNonNegativeInteger(
    options.energyAvailable ?? colony.energyAvailable ?? colony.room.energyAvailable
  );
  const energyCapacity = normalizeNonNegativeInteger(
    colony.energyCapacityAvailable ?? colony.room.energyCapacityAvailable
  );
  if (!shouldAllowMineralHarvesting(energyAvailable, energyCapacity)) {
    return null;
  }

  const assignment = selectMineralHarvestAssignment(colony.room, creeps);
  if (!assignment) {
    return null;
  }

  const spawn = selectAvailableSpawn(colony.spawns, options.usedSpawns);
  if (!spawn) {
    return null;
  }

  const body = buildMineralHarvesterBody(
    normalizeNonNegativeInteger(options.bodyEnergyBudget ?? energyAvailable),
    colony.room.controller?.level
  );
  if (body.length === 0) {
    return null;
  }

  return {
    spawn,
    body,
    name: `${MINERAL_HARVESTER_ROLE}-${colony.room.name}-${gameTime}`,
    memory: {
      role: MINERAL_HARVESTER_ROLE,
      colony: colony.room.name,
      mineralHarvester: assignment
    }
  };
}

export function selectMineralHarvestAssignment(
  room: Room,
  creeps: Creep[] = Object.values((globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps ?? {})
): MineralHarvestAssignment | null {
  if (room.controller?.my !== true) {
    return null;
  }

  const extractor = selectExtractor(room);
  if (!extractor) {
    return null;
  }

  const mineral = selectAvailableMineral(room);
  if (!mineral || hasActiveMineralHarvester(creeps, room.name, mineral.id)) {
    return null;
  }

  const mineralType = getMineralResourceType(mineral);
  const target = selectMineralDeliveryTarget(room, mineralType);
  if (!target) {
    return null;
  }

  return {
    homeRoom: room.name,
    mineralId: mineral.id,
    ...(mineralType ? { mineralType } : {}),
    targetId: target.id as Id<AnyStoreStructure>
  };
}

export function shouldAllowMineralHarvesting(energyAvailable: number, energyCapacity: number): boolean {
  const capacity = normalizeNonNegativeInteger(energyCapacity);
  if (capacity <= 0) {
    return false;
  }

  return normalizeNonNegativeInteger(energyAvailable) >= capacity * MINERAL_HARVESTING_MIN_ENERGY_RATIO;
}

export function buildMineralHarvesterBody(
  energyAvailable: number,
  controllerLevel?: number
): BodyPartConstant[] {
  const energyBudget = normalizeNonNegativeInteger(energyAvailable);
  const maxWorkParts = typeof controllerLevel === 'number' && controllerLevel >= 6 ? 3 : 2;

  for (let workParts = maxWorkParts; workParts >= 1; workParts -= 1) {
    const body = buildMineralHarvesterBodyWithWorkParts(workParts);
    if (getBodyCost(body) <= energyBudget) {
      return body;
    }
  }

  const minimumBody: BodyPartConstant[] = ['work', 'carry', 'move'];
  return getBodyCost(minimumBody) <= energyBudget ? minimumBody : [];
}

export function runMineralHarvester(creep: Creep): void {
  const assignment = getMutableMineralHarvesterMemory(creep);
  if (!assignment) {
    return;
  }

  if (creep.room?.name !== assignment.homeRoom) {
    delete creep.memory.task;
    moveTowardRoom(creep, assignment.homeRoom);
    return;
  }

  const carriedResourceType = selectCarriedResourceType(creep, assignment.mineralType);
  if (carriedResourceType) {
    deliverMineral(creep, assignment, carriedResourceType);
    return;
  }

  const mineral = getAssignedMineral(assignment, creep.room);
  if (!mineral || !isMineralAvailable(mineral)) {
    delete creep.memory.task;
    return;
  }

  if (getStoreFreeCapacity(creep.store, assignment.mineralType) <= 0) {
    return;
  }

  delete creep.memory.task;
  const result = creep.harvest?.(mineral);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    moveTo(creep, mineral);
  }
}

function buildMineralHarvesterBodyWithWorkParts(workParts: number): BodyPartConstant[] {
  if (workParts <= 1) {
    return ['work', 'carry', 'move', 'move'];
  }

  return [
    ...Array.from({ length: workParts }, () => 'work' as BodyPartConstant),
    'carry',
    'move',
    'move',
    'move'
  ];
}

function selectAvailableSpawn(
  spawns: StructureSpawn[],
  usedSpawns: ReadonlySet<StructureSpawn> | undefined
): StructureSpawn | null {
  return spawns.find((spawn) => !spawn.spawning && !usedSpawns?.has(spawn)) ?? null;
}

function selectExtractor(room: Room): StructureExtractor | null {
  const ownedStructures = findRoomObjects<AnyOwnedStructure>(room, 'FIND_MY_STRUCTURES');
  const extractor = ownedStructures.find(isExtractorStructure);
  if (extractor) {
    return extractor;
  }

  return findRoomObjects<Structure>(room, 'FIND_STRUCTURES').find(isExtractorStructure) ?? null;
}

function selectAvailableMineral(room: Room): Mineral | null {
  return findRoomObjects<Mineral>(room, 'FIND_MINERALS').find(isMineralAvailable) ?? null;
}

function isExtractorStructure(structure: Structure): structure is StructureExtractor {
  return matchesStructureType(structure.structureType, 'STRUCTURE_EXTRACTOR', 'extractor');
}

function isMineralAvailable(mineral: Mineral): boolean {
  return normalizeNonNegativeInteger((mineral as Mineral & { mineralAmount?: unknown }).mineralAmount) > 0;
}

function getMineralResourceType(mineral: Mineral): ResourceConstant | undefined {
  const mineralType = (mineral as Mineral & { mineralType?: unknown }).mineralType;
  return typeof mineralType === 'string' && mineralType.length > 0
    ? (mineralType as ResourceConstant)
    : undefined;
}

function hasActiveMineralHarvester(creeps: Creep[], homeRoom: string, mineralId: Id<Mineral>): boolean {
  return creeps.some((creep) => {
    const memory = normalizeMineralHarvesterMemory(creep.memory?.mineralHarvester);
    return (
      creep.memory?.role === MINERAL_HARVESTER_ROLE &&
      memory?.homeRoom === homeRoom &&
      memory.mineralId === mineralId &&
      (creep.ticksToLive === undefined || creep.ticksToLive > MINERAL_HARVESTER_REPLACEMENT_TICKS)
    );
  });
}

function selectMineralDeliveryTarget(
  room: Room,
  resourceType?: ResourceConstant
): MineralDeliveryTarget | null {
  return [room.terminal, room.storage]
    .filter(
      (structure): structure is MineralDeliveryTarget =>
        structure !== undefined && getStoreFreeCapacity(structure.store, resourceType) > 0
    )
    .sort(compareMineralDeliveryTargets)[0] ?? null;
}

function compareMineralDeliveryTargets(
  left: MineralDeliveryTarget,
  right: MineralDeliveryTarget
): number {
  return getDeliveryPriority(right) - getDeliveryPriority(left) || getObjectId(left).localeCompare(getObjectId(right));
}

function getDeliveryPriority(target: MineralDeliveryTarget): number {
  return matchesStructureType(target.structureType, 'STRUCTURE_TERMINAL', 'terminal') ? 2 : 1;
}

function getMutableMineralHarvesterMemory(creep: Creep): CreepMineralHarvesterMemory | null {
  const memory = normalizeMineralHarvesterMemory(creep.memory?.mineralHarvester);
  if (!memory) {
    return null;
  }

  creep.memory.mineralHarvester = memory;
  return memory;
}

function normalizeMineralHarvesterMemory(value: unknown): CreepMineralHarvesterMemory | null {
  if (!isRecord(value) || !isNonEmptyString(value.homeRoom) || !isNonEmptyString(value.mineralId)) {
    return null;
  }

  const targetId = isNonEmptyString(value.targetId)
    ? (value.targetId as Id<AnyStoreStructure>)
    : undefined;
  if (!targetId) {
    return null;
  }

  return {
    homeRoom: value.homeRoom,
    mineralId: value.mineralId as Id<Mineral>,
    targetId,
    ...(isNonEmptyString(value.mineralType) ? { mineralType: value.mineralType as ResourceConstant } : {})
  };
}

function getAssignedMineral(assignment: CreepMineralHarvesterMemory, room: Room): Mineral | null {
  return (
    getObjectById<Mineral>(assignment.mineralId) ??
    findRoomObjects<Mineral>(room, 'FIND_MINERALS').find((mineral) => mineral.id === assignment.mineralId) ??
    null
  );
}

function deliverMineral(
  creep: Creep,
  assignment: CreepMineralHarvesterMemory,
  resourceType: ResourceConstant
): void {
  const target = selectDeliveryTargetForAssignment(creep.room, assignment, resourceType);
  if (!target) {
    delete creep.memory.task;
    return;
  }

  assignment.targetId = target.id as Id<AnyStoreStructure>;
  creep.memory.task = { type: 'transfer', targetId: assignment.targetId };
  const result = creep.transfer?.(target, resourceType);
  if (result === ERR_NOT_IN_RANGE_CODE) {
    moveTo(creep, target);
  }
}

function selectDeliveryTargetForAssignment(
  room: Room,
  assignment: CreepMineralHarvesterMemory,
  resourceType: ResourceConstant
): MineralDeliveryTarget | null {
  const assignedTarget = getObjectById<MineralDeliveryTarget>(assignment.targetId);
  if (assignedTarget && getStoreFreeCapacity(assignedTarget.store, resourceType) > 0) {
    return assignedTarget;
  }

  return selectMineralDeliveryTarget(room, resourceType);
}

function selectCarriedResourceType(
  creep: Creep,
  preferredResourceType: ResourceConstant | undefined
): ResourceConstant | null {
  if (preferredResourceType && getStoreUsedCapacity(creep.store, preferredResourceType) > 0) {
    return preferredResourceType;
  }

  const storeRecord = creep.store as unknown as Record<string, unknown> | undefined;
  const carriedResource = Object.keys(storeRecord ?? {}).find((resourceType) => {
    const amount = storeRecord?.[resourceType];
    return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  });
  if (carriedResource) {
    return carriedResource as ResourceConstant;
  }

  const totalUsedCapacity = getStoreUsedCapacity(creep.store);
  return totalUsedCapacity > 0 && preferredResourceType ? preferredResourceType : null;
}

function moveTowardRoom(creep: Creep, roomName: string): void {
  const visibleController = getVisibleRoom(roomName)?.controller;
  if (visibleController) {
    moveTo(creep, visibleController);
    return;
  }

  const RoomPositionCtor = (globalThis as { RoomPosition?: new (x: number, y: number, roomName: string) => RoomPosition })
    .RoomPosition;
  if (typeof RoomPositionCtor === 'function') {
    moveTo(creep, new RoomPositionCtor(25, 25, roomName));
  }
}

function moveTo(creep: Creep, target: RoomObject | RoomPosition): void {
  creep.moveTo?.(target, MINERAL_MOVE_OPTS);
}

function getStoreFreeCapacity(store: StoreDefinition | undefined, resourceType?: ResourceConstant): number {
  const getFreeCapacity = store?.getFreeCapacity as
    | ((resourceType?: ResourceConstant) => number | null)
    | undefined;
  if (typeof getFreeCapacity !== 'function') {
    return Number.POSITIVE_INFINITY;
  }

  const freeCapacity = getFreeCapacity.call(store, resourceType);
  return typeof freeCapacity === 'number' && Number.isFinite(freeCapacity)
    ? Math.max(0, freeCapacity)
    : 0;
}

function getStoreUsedCapacity(store: StoreDefinition | undefined, resourceType?: ResourceConstant): number {
  const getUsedCapacity = store?.getUsedCapacity as
    | ((resourceType?: ResourceConstant) => number | null)
    | undefined;
  if (typeof getUsedCapacity !== 'function') {
    return 0;
  }

  const usedCapacity = getUsedCapacity.call(store, resourceType);
  return typeof usedCapacity === 'number' && Number.isFinite(usedCapacity)
    ? Math.max(0, usedCapacity)
    : 0;
}

function getObjectById<T>(id: string): T | null {
  const getObjectById = (globalThis as { Game?: Partial<Pick<Game, 'getObjectById'>> }).Game?.getObjectById as
    | ((id: string) => T | null)
    | undefined;
  return typeof getObjectById === 'function' ? getObjectById(String(id)) : null;
}

function getVisibleRoom(roomName: string): Room | undefined {
  return (globalThis as { Game?: Partial<Pick<Game, 'rooms'>> }).Game?.rooms?.[roomName];
}

function findRoomObjects<T>(
  room: Room,
  constantName: 'FIND_MINERALS' | 'FIND_MY_STRUCTURES' | 'FIND_STRUCTURES'
): T[] {
  const findConstant = (globalThis as unknown as Partial<Record<typeof constantName, number>>)[constantName];
  if (typeof findConstant !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  try {
    const result = room.find(findConstant as FindConstant);
    return Array.isArray(result) ? (result as T[]) : [];
  } catch {
    return [];
  }
}

function matchesStructureType(
  actual: string | undefined,
  globalName: 'STRUCTURE_EXTRACTOR' | 'STRUCTURE_TERMINAL',
  fallback: string
): boolean {
  const constants = globalThis as unknown as Partial<Record<typeof globalName, string>>;
  return actual === (constants[globalName] ?? fallback);
}

function getBodyCost(body: BodyPartConstant[]): number {
  const costs: Record<BodyPartConstant, number> = {
    move: 50,
    work: 100,
    carry: 50,
    attack: 80,
    ranged_attack: 150,
    heal: 250,
    claim: 600,
    tough: 10
  };
  return body.reduce((total, part) => total + costs[part], 0);
}

function getObjectId(object: { id?: unknown }): string {
  return typeof object.id === 'string' ? object.id : '';
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
