import type { ColonySnapshot } from '../colony/colonyRegistry';
import { WORKER_REPLACEMENT_TICKS_TO_LIVE } from '../creeps/roleCounts';
import { isKnownDeadZoneRoom } from '../defense/deadZone';

export const MULTI_ROOM_UPGRADER_DEFAULT_STORAGE_THRESHOLD_RATIO = 0.8;
export const MULTI_ROOM_UPGRADER_DEFAULT_PER_ROOM_CAP = 1;

const REMOTE_UPGRADER_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move'];
const REMOTE_UPGRADER_TRAVEL_PATTERN: BodyPartConstant[] = ['work', 'carry', 'move', 'move'];
const RESERVED_CONTROLLER_BASE_BODY: BodyPartConstant[] = ['claim', 'move'];
const REMOTE_UPGRADER_PATTERN_COST = 200;
const MOVE_PART_COST = 50;
const MAX_CREEP_PARTS = 50;
const MAX_REMOTE_UPGRADER_PATTERN_COUNT = 4;
const DEFAULT_RESERVED_CONTROLLER_LEVEL = 0;
const ERR_NO_PATH_CODE = -2 as ScreepsReturnCode;
const TERRITORY_ROUTE_DISTANCE_SEPARATOR = '>';
const TERRITORY_ROUTE_DISTANCE_MEMORY_TTL_TICK_KEY = 'routeDistancesUpdatedAt';

export type MultiRoomUpgradeControllerState = 'owned' | 'reserved';

export interface MultiRoomUpgraderOptions {
  storageEnergyThresholdRatio?: number;
  perRoomUpgraderCap?: number;
}

export interface MultiRoomUpgradePlan {
  homeRoom: string;
  targetRoom: string;
  controllerId: Id<StructureController>;
  controllerLevel: number;
  controllerState: MultiRoomUpgradeControllerState;
  routeDistance?: number;
  activeUpgraderCount: number;
}

interface MultiRoomUpgradeCandidate extends MultiRoomUpgradePlan {
  order: number;
}

interface MultiRoomUpgraderConfig {
  storageEnergyThresholdRatio: number;
  perRoomUpgraderCap: number;
}

export function selectMultiRoomUpgradePlan(
  colony: ColonySnapshot,
  options: MultiRoomUpgraderOptions = {}
): MultiRoomUpgradePlan | null {
  return selectMultiRoomUpgradePlans(colony, options)[0] ?? null;
}

export function selectMultiRoomUpgradePlans(
  colony: ColonySnapshot,
  options: MultiRoomUpgraderOptions = {}
): MultiRoomUpgradePlan[] {
  const config = normalizeMultiRoomUpgraderOptions(options);
  if (config.perRoomUpgraderCap <= 0 || !hasPrimaryRoomStorageSurplus(colony, config.storageEnergyThresholdRatio)) {
    return [];
  }

  const candidates = getVisibleMultiRoomUpgradeCandidates(colony, config);
  if (candidates.length === 0) {
    return [];
  }

  return candidates.sort(compareMultiRoomUpgradeCandidates).map(({ order: _order, ...plan }) => plan);
}

export function buildMultiRoomUpgraderBody(
  energyAvailable: number,
  plan: Pick<MultiRoomUpgradePlan, 'controllerState' | 'routeDistance'>
): BodyPartConstant[] {
  const baseBody = plan.controllerState === 'reserved' ? RESERVED_CONTROLLER_BASE_BODY : [];
  const remainingEnergy = energyAvailable - getBodyCost(baseBody);
  if (remainingEnergy < REMOTE_UPGRADER_PATTERN_COST) {
    return [];
  }

  const pattern = getRemoteUpgraderPattern(plan.routeDistance);
  const patternCost = getBodyCost(pattern);
  const maxPatternCountByEnergy = Math.floor(remainingEnergy / patternCost);
  const maxPatternCountBySize = Math.floor((MAX_CREEP_PARTS - baseBody.length) / pattern.length);
  const patternCount = Math.min(
    maxPatternCountByEnergy,
    maxPatternCountBySize,
    MAX_REMOTE_UPGRADER_PATTERN_COUNT
  );
  if (patternCount <= 0) {
    return [];
  }

  const body = [
    ...baseBody,
    ...Array.from({ length: patternCount }).flatMap(() => pattern)
  ];
  const unusedEnergy = energyAvailable - getBodyCost(body);
  if (unusedEnergy >= MOVE_PART_COST && body.length < MAX_CREEP_PARTS) {
    return [...body, 'move'];
  }

  return body;
}

export function buildMultiRoomUpgraderMemory(plan: MultiRoomUpgradePlan): CreepMemory {
  return {
    role: 'worker',
    colony: plan.targetRoom,
    territory: {
      targetRoom: plan.targetRoom,
      action: plan.controllerState === 'reserved' ? 'reserve' : 'claim',
      controllerId: plan.controllerId
    },
    controllerSustain: {
      homeRoom: plan.homeRoom,
      targetRoom: plan.targetRoom,
      role: 'upgrader'
    }
  };
}

function getVisibleMultiRoomUpgradeCandidates(
  colony: ColonySnapshot,
  config: MultiRoomUpgraderConfig
): MultiRoomUpgradeCandidate[] {
  const rooms = (globalThis as { Game?: Partial<Game> }).Game?.rooms;
  if (!rooms) {
    return [];
  }

  const homeRoom = colony.room.name;
  const ownerUsername = getControllerOwnerUsername(colony.room.controller);
  const activeUpgraderCounts = getActiveMultiRoomUpgraderCountsByTarget(homeRoom);
  const candidates: MultiRoomUpgradeCandidate[] = [];
  let order = 0;

  for (const room of Object.values(rooms)) {
    const candidate = getVisibleMultiRoomUpgradeCandidate(
      homeRoom,
      ownerUsername,
      room,
      config.perRoomUpgraderCap,
      activeUpgraderCounts,
      order
    );
    order += 1;
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function getVisibleMultiRoomUpgradeCandidate(
  homeRoom: string,
  ownerUsername: string | null,
  room: Room,
  perRoomUpgraderCap: number,
  activeUpgraderCounts: Record<string, number>,
  order: number
): MultiRoomUpgradeCandidate | null {
  if (!isNonEmptyString(room.name) || room.name === homeRoom || isKnownDeadZoneRoom(room.name)) {
    return null;
  }

  const controller = room.controller;
  if (!controller || !isNonEmptyString(controller.id)) {
    return null;
  }

  const controllerState = getEligibleControllerState(controller, ownerUsername);
  if (!controllerState) {
    return null;
  }

  const routeDistance = getRouteDistance(homeRoom, room.name);
  if (routeDistance === null) {
    return null;
  }

  if (hasVisibleHostiles(room)) {
    return null;
  }

  const activeUpgraderCount = activeUpgraderCounts[room.name] ?? 0;
  if (activeUpgraderCount >= perRoomUpgraderCap) {
    return null;
  }

  return {
    homeRoom,
    targetRoom: room.name,
    controllerId: controller.id,
    controllerLevel: getControllerLevel(controller),
    controllerState,
    ...(typeof routeDistance === 'number' ? { routeDistance } : {}),
    activeUpgraderCount,
    order
  };
}

function getEligibleControllerState(
  controller: StructureController,
  ownerUsername: string | null
): MultiRoomUpgradeControllerState | null {
  if (controller.my === true) {
    return controller.level < 8 ? 'owned' : null;
  }

  const reservationUsername = getControllerReservationUsername(controller);
  if (ownerUsername && reservationUsername === ownerUsername) {
    return 'reserved';
  }

  return null;
}

function hasPrimaryRoomStorageSurplus(colony: ColonySnapshot, storageEnergyThresholdRatio: number): boolean {
  const storage = colony.room.storage;
  if (!storage) {
    return false;
  }

  const storedEnergy = getStoredEnergy(storage);
  const storageCapacity = getStorageEnergyCapacity(storage);
  return storageCapacity > 0 && storedEnergy > storageCapacity * storageEnergyThresholdRatio;
}

function normalizeMultiRoomUpgraderOptions(options: MultiRoomUpgraderOptions): MultiRoomUpgraderConfig {
  return {
    storageEnergyThresholdRatio: normalizeRatio(
      options.storageEnergyThresholdRatio,
      MULTI_ROOM_UPGRADER_DEFAULT_STORAGE_THRESHOLD_RATIO
    ),
    perRoomUpgraderCap: normalizePerRoomCap(options.perRoomUpgraderCap)
  };
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizePerRoomCap(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : MULTI_ROOM_UPGRADER_DEFAULT_PER_ROOM_CAP;
}

function getRemoteUpgraderPattern(routeDistance: number | undefined): BodyPartConstant[] {
  return typeof routeDistance === 'number' && routeDistance > 1
    ? REMOTE_UPGRADER_TRAVEL_PATTERN
    : REMOTE_UPGRADER_PATTERN;
}

function getBodyCost(body: BodyPartConstant[]): number {
  return body.reduce((total, part) => total + getBodyPartCost(part), 0);
}

function getBodyPartCost(part: BodyPartConstant): number {
  switch (part) {
    case 'work':
      return 100;
    case 'carry':
    case 'move':
      return 50;
    case 'claim':
      return 600;
    case 'attack':
      return 80;
    case 'ranged_attack':
      return 150;
    case 'heal':
      return 250;
    case 'tough':
      return 10;
  }
}

function compareMultiRoomUpgradeCandidates(
  left: MultiRoomUpgradeCandidate,
  right: MultiRoomUpgradeCandidate
): number {
  return (
    left.controllerLevel - right.controllerLevel ||
    compareOptionalNumbers(left.routeDistance, right.routeDistance) ||
    left.targetRoom.localeCompare(right.targetRoom) ||
    left.order - right.order
  );
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY);
}

interface ActiveMultiRoomUpgraderCountCache {
  gameTime: number;
  creeps?: Game['creeps'];
  countsByHomeRoom: Record<string, Record<string, number>>;
}

let activeMultiRoomUpgraderCountCache: ActiveMultiRoomUpgraderCountCache | null = null;

function getActiveMultiRoomUpgraderCountsByTarget(homeRoom: string): Record<string, number> {
  const creeps = (globalThis as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  if (!creeps) {
    return {};
  }

  const gameTime = getGameTime();
  if (
    activeMultiRoomUpgraderCountCache?.gameTime !== gameTime ||
    activeMultiRoomUpgraderCountCache.creeps !== creeps
  ) {
    activeMultiRoomUpgraderCountCache = {
      gameTime,
      creeps,
      countsByHomeRoom: countActiveMultiRoomUpgradersByHomeRoom(creeps)
    };
  }

  return activeMultiRoomUpgraderCountCache.countsByHomeRoom[homeRoom] ?? {};
}

function countActiveMultiRoomUpgradersByHomeRoom(
  creeps: Game['creeps']
): Record<string, Record<string, number>> {
  const countsByHomeRoom: Record<string, Record<string, number>> = {};
  for (const creep of Object.values(creeps)) {
    const sustain = creep.memory?.controllerSustain;
    if (
      sustain?.role !== 'upgrader' ||
      !isNonEmptyString(sustain.homeRoom) ||
      !isNonEmptyString(sustain.targetRoom) ||
      !isActiveMultiRoomUpgrader(creep)
    ) {
      continue;
    }

    const countsByTarget = countsByHomeRoom[sustain.homeRoom] ?? {};
    countsByTarget[sustain.targetRoom] = (countsByTarget[sustain.targetRoom] ?? 0) + 1;
    countsByHomeRoom[sustain.homeRoom] = countsByTarget;
  }

  return countsByHomeRoom;
}

function isActiveMultiRoomUpgrader(creep: Creep): boolean {
  return creep.ticksToLive === undefined || creep.ticksToLive > WORKER_REPLACEMENT_TICKS_TO_LIVE;
}

function getControllerLevel(controller: StructureController): number {
  return typeof controller.level === 'number' ? controller.level : DEFAULT_RESERVED_CONTROLLER_LEVEL;
}

function getControllerOwnerUsername(controller: StructureController | undefined): string | null {
  const username = (controller as (StructureController & { owner?: { username?: string } }) | undefined)?.owner
    ?.username;
  return isNonEmptyString(username) ? username : null;
}

function getControllerReservationUsername(controller: StructureController): string | null {
  const username = (controller as StructureController & { reservation?: { username?: string } }).reservation?.username;
  return isNonEmptyString(username) ? username : null;
}

function getStoredEnergy(storage: StructureStorage): number {
  const storedEnergy = storage.store.getUsedCapacity(RESOURCE_ENERGY);
  return typeof storedEnergy === 'number' && Number.isFinite(storedEnergy) ? Math.max(0, storedEnergy) : 0;
}

function getStorageEnergyCapacity(storage: StructureStorage): number {
  const capacity = storage.store.getCapacity(RESOURCE_ENERGY);
  return typeof capacity === 'number' && Number.isFinite(capacity) ? Math.max(0, capacity) : 0;
}

function hasVisibleHostiles(room: Room): boolean {
  const hostileCreepsFind = (globalThis as { FIND_HOSTILE_CREEPS?: FindConstant }).FIND_HOSTILE_CREEPS;
  const hostileStructuresFind = (globalThis as { FIND_HOSTILE_STRUCTURES?: FindConstant }).FIND_HOSTILE_STRUCTURES;
  return (
    (typeof hostileCreepsFind === 'number' && room.find(hostileCreepsFind).length > 0) ||
    (typeof hostileStructuresFind === 'number' && room.find(hostileStructuresFind).length > 0)
  );
}

function getRouteDistance(fromRoom: string, targetRoom: string): number | null | undefined {
  if (fromRoom === targetRoom) {
    return 0;
  }

  const cache = getTerritoryRouteDistanceCache();
  const cacheKey = getTerritoryRouteDistanceCacheKey(fromRoom, targetRoom);
  const cachedRouteDistance = cache?.[cacheKey];
  if (cachedRouteDistance === null || typeof cachedRouteDistance === 'number') {
    return cachedRouteDistance;
  }

  const routeDistance = getRouteDistanceFromGameMap(fromRoom, targetRoom);
  if (routeDistance !== undefined) {
    if (cache) {
      cache[cacheKey] = routeDistance;
    }
    return routeDistance;
  }

  return isAdjacentRoom(fromRoom, targetRoom) ? 1 : undefined;
}

function getTerritoryRouteDistanceCache(): TerritoryMemory['routeDistances'] | undefined {
  const memory = (globalThis as { Memory?: Partial<Memory> }).Memory;
  if (!memory) {
    return undefined;
  }

  if (!isRecord(memory.territory)) {
    memory.territory = {};
  }

  const gameTime = getGameTime();
  const territoryMemory = memory.territory as Record<string, unknown>;
  if (territoryMemory[TERRITORY_ROUTE_DISTANCE_MEMORY_TTL_TICK_KEY] !== gameTime) {
    territoryMemory[TERRITORY_ROUTE_DISTANCE_MEMORY_TTL_TICK_KEY] = gameTime;
    territoryMemory.routeDistances = {};
  }

  if (!isRecord(memory.territory.routeDistances)) {
    memory.territory.routeDistances = {};
  }

  return memory.territory.routeDistances as TerritoryMemory['routeDistances'];
}

function getTerritoryRouteDistanceCacheKey(fromRoom: string, targetRoom: string): string {
  return `${fromRoom}${TERRITORY_ROUTE_DISTANCE_SEPARATOR}${targetRoom}`;
}

function getRouteDistanceFromGameMap(fromRoom: string, targetRoom: string): number | null | undefined {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map as
    | (Partial<GameMap> & {
        findRoute?: (
          fromRoom: string,
          toRoom: string,
          opts?: { routeCallback?: (roomName: string, fromRoomName: string) => number }
        ) => unknown;
      })
    | undefined;

  if (typeof gameMap?.findRoute !== 'function') {
    return undefined;
  }

  const route = gameMap.findRoute.call(gameMap, fromRoom, targetRoom, {
    routeCallback: (roomName: string) => (isKnownDeadZoneRoom(roomName) ? Infinity : 1)
  });
  if (route === getNoPathResultCode()) {
    return null;
  }

  return Array.isArray(route) ? route.length : undefined;
}

function isAdjacentRoom(fromRoom: string, targetRoom: string): boolean {
  const gameMap = (globalThis as { Game?: Partial<Game> }).Game?.map;
  if (!gameMap || typeof gameMap.describeExits !== 'function') {
    return false;
  }

  const exits = gameMap.describeExits(fromRoom) as ExitsInformation | null;
  if (!isRecord(exits)) {
    return false;
  }

  return Object.values(exits).some((roomName) => roomName === targetRoom);
}

function getNoPathResultCode(): ScreepsReturnCode {
  const noPathCode = (globalThis as { ERR_NO_PATH?: ScreepsReturnCode }).ERR_NO_PATH;
  return typeof noPathCode === 'number' ? noPathCode : ERR_NO_PATH_CODE;
}

function getGameTime(): number {
  const gameTime = (globalThis as { Game?: Partial<Game> }).Game?.time;
  return typeof gameTime === 'number' ? gameTime : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
