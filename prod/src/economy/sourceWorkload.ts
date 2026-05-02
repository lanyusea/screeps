import {
  findSourceContainer,
  getRoomObjectPosition,
  isSameRoomPosition
} from './sourceContainers';

const HARVEST_ENERGY_PER_WORK_PART = 2;
const DEFAULT_SOURCE_ENERGY_CAPACITY = 3_000;
const DEFAULT_SOURCE_ENERGY_REGEN_TICKS = 300;
const DEFAULT_TERRAIN_WALL_MASK = 1;

export interface SourceWorkloadRecord {
  sourceId: string;
  assignedHarvesters: number;
  assignedWorkParts: number;
  openPositions: number;
  harvestWorkCapacity: number;
  harvestEnergyPerTick: number;
  regenEnergyPerTick: number;
  sourceEnergyCapacity: number;
  sourceEnergyRegenTicks: number;
  hasContainer: boolean;
  containerId?: string;
}

interface SourceAssignmentLoad {
  assignedHarvesters: number;
  assignedWorkParts: number;
}

export function recordSourceWorkloads(room: Room, creeps: Creep[], tick: number): void {
  const memory = (globalThis as unknown as { Memory?: Partial<Memory> }).Memory;
  const roomName = getRoomName(room);
  if (!memory || !roomName) {
    return;
  }

  const sources = findSources(room);
  if (sources.length === 0) {
    return;
  }

  memory.economy ??= {};
  memory.economy.sourceWorkloads ??= {};
  memory.economy.sourceWorkloads[roomName] = {
    updatedAt: tick,
    sources: Object.fromEntries(
      buildSourceWorkloadRecords(room, sources, creeps).map((record) => [record.sourceId, record])
    )
  };
}

export function buildSourceWorkloadRecords(
  room: Room,
  sources: Source[] = findSources(room),
  creeps: Creep[] = getGameCreeps()
): SourceWorkloadRecord[] {
  const roomName = getRoomName(room);
  const assignmentLoads = getSourceAssignmentLoads(roomName, sources, creeps);

  return sources
    .filter((source) => hasSourcePositionInRoom(source, room))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((source) => {
      const sourceEnergyCapacity = getSourceEnergyCapacity(source);
      const sourceEnergyRegenTicks = getSourceEnergyRegenTicks();
      const assignmentLoad = assignmentLoads.get(String(source.id)) ?? createEmptySourceAssignmentLoad();
      const sourceContainer = findSourceContainer(room, source);

      return {
        sourceId: String(source.id),
        assignedHarvesters: assignmentLoad.assignedHarvesters,
        assignedWorkParts: assignmentLoad.assignedWorkParts,
        openPositions: getSourceOpenPositionCount(source),
        harvestWorkCapacity: Math.max(
          1,
          Math.ceil(sourceEnergyCapacity / sourceEnergyRegenTicks / HARVEST_ENERGY_PER_WORK_PART)
        ),
        harvestEnergyPerTick: assignmentLoad.assignedWorkParts * HARVEST_ENERGY_PER_WORK_PART,
        regenEnergyPerTick: sourceEnergyCapacity / sourceEnergyRegenTicks,
        sourceEnergyCapacity,
        sourceEnergyRegenTicks,
        hasContainer: sourceContainer !== null,
        ...(sourceContainer ? { containerId: String(sourceContainer.id) } : {})
      };
    });
}

function getSourceAssignmentLoads(
  roomName: string | null,
  sources: Source[],
  creeps: Creep[]
): Map<string, SourceAssignmentLoad> {
  const assignmentLoads = new Map<string, SourceAssignmentLoad>();
  for (const source of sources) {
    assignmentLoads.set(String(source.id), createEmptySourceAssignmentLoad());
  }

  if (!roomName) {
    return assignmentLoads;
  }

  const sourceIds = new Set(sources.map((source) => String(source.id)));
  for (const creep of creeps) {
    const task = creep.memory?.task as Partial<CreepTaskMemory> | undefined;
    const targetId = typeof task?.targetId === 'string' ? task.targetId : undefined;
    if (
      creep.memory?.role !== 'worker' ||
      creep.room?.name !== roomName ||
      task?.type !== 'harvest' ||
      !targetId ||
      !sourceIds.has(targetId)
    ) {
      continue;
    }

    const currentLoad = assignmentLoads.get(targetId) ?? createEmptySourceAssignmentLoad();
    assignmentLoads.set(targetId, {
      assignedHarvesters: currentLoad.assignedHarvesters + 1,
      assignedWorkParts: currentLoad.assignedWorkParts + getActiveWorkParts(creep)
    });
  }

  return assignmentLoads;
}

function createEmptySourceAssignmentLoad(): SourceAssignmentLoad {
  return { assignedHarvesters: 0, assignedWorkParts: 0 };
}

function findSources(room: Room): Source[] {
  if (typeof FIND_SOURCES !== 'number' || typeof room.find !== 'function') {
    return [];
  }

  return room.find(FIND_SOURCES);
}

function hasSourcePositionInRoom(source: Source, room: Room): boolean {
  const position = getRoomObjectPosition(source);
  return position === null || isSameRoomPosition(position, room.name);
}

function getSourceOpenPositionCount(source: Source): number {
  const position = getRoomObjectPosition(source);
  if (!position) {
    return 1;
  }

  const terrain = getRoomTerrain(position.roomName);
  if (!terrain) {
    return 1;
  }

  let openPositions = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      const x = position.x + dx;
      const y = position.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) {
        continue;
      }

      if ((terrain.get(x, y) & getTerrainWallMask()) === 0) {
        openPositions += 1;
      }
    }
  }

  return Math.max(1, openPositions);
}

function getRoomTerrain(roomName: string | undefined): RoomTerrain | null {
  if (!roomName) {
    return null;
  }

  const map = (globalThis as unknown as { Game?: Partial<Pick<Game, 'map'>> }).Game?.map;
  return typeof map?.getRoomTerrain === 'function' ? map.getRoomTerrain(roomName) : null;
}

function getTerrainWallMask(): number {
  const terrainWallMask = (globalThis as unknown as { TERRAIN_MASK_WALL?: number }).TERRAIN_MASK_WALL;
  return typeof terrainWallMask === 'number' ? terrainWallMask : DEFAULT_TERRAIN_WALL_MASK;
}

function getSourceEnergyCapacity(source: Source): number {
  const sourceEnergyCapacity = source.energyCapacity;
  if (typeof sourceEnergyCapacity === 'number' && Number.isFinite(sourceEnergyCapacity) && sourceEnergyCapacity > 0) {
    return sourceEnergyCapacity;
  }

  const defaultSourceEnergyCapacity = (globalThis as unknown as { SOURCE_ENERGY_CAPACITY?: number })
    .SOURCE_ENERGY_CAPACITY;
  return typeof defaultSourceEnergyCapacity === 'number' &&
    Number.isFinite(defaultSourceEnergyCapacity) &&
    defaultSourceEnergyCapacity > 0
    ? defaultSourceEnergyCapacity
    : DEFAULT_SOURCE_ENERGY_CAPACITY;
}

function getSourceEnergyRegenTicks(): number {
  const regenTicks = (globalThis as unknown as { ENERGY_REGEN_TIME?: number }).ENERGY_REGEN_TIME;
  return typeof regenTicks === 'number' && Number.isFinite(regenTicks) && regenTicks > 0
    ? regenTicks
    : DEFAULT_SOURCE_ENERGY_REGEN_TICKS;
}

function getActiveWorkParts(creep: Creep): number {
  const workPart = getBodyPartConstant('WORK', 'work');
  const activeWorkParts = creep.getActiveBodyparts?.(workPart);
  if (typeof activeWorkParts === 'number' && Number.isFinite(activeWorkParts)) {
    return Math.max(0, Math.floor(activeWorkParts));
  }

  const bodyWorkParts = Array.isArray(creep.body)
    ? creep.body.filter((part) => isActiveBodyPart(part, workPart)).length
    : 0;
  return bodyWorkParts > 0 ? bodyWorkParts : 1;
}

function isActiveBodyPart(part: unknown, bodyPartType: BodyPartConstant): boolean {
  if (typeof part !== 'object' || part === null) {
    return false;
  }

  const bodyPart = part as Partial<BodyPartDefinition>;
  return bodyPart.type === bodyPartType && typeof bodyPart.hits === 'number' && bodyPart.hits > 0;
}

function getBodyPartConstant(globalName: 'WORK', fallback: BodyPartConstant): BodyPartConstant {
  const constants = globalThis as unknown as Partial<Record<'WORK', BodyPartConstant>>;
  return constants[globalName] ?? fallback;
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return creeps ? Object.values(creeps) : [];
}

function getRoomName(room: Room): string | null {
  return typeof room.name === 'string' && room.name.length > 0 ? room.name : null;
}
