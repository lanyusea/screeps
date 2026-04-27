export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);

  if (carriedEnergy === 0) {
    const source = selectHarvestSource(creep);
    return source ? { type: 'harvest', targetId: source.id } : null;
  }

  const [energySink] = creep.room.find(FIND_MY_STRUCTURES, {
    filter: (structure) =>
      (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) &&
      'store' in structure &&
      structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
  });
  if (energySink) {
    return { type: 'transfer', targetId: energySink.id as Id<AnyStoreStructure> };
  }

  const [constructionSite] = creep.room.find(FIND_CONSTRUCTION_SITES);
  if (constructionSite) {
    return { type: 'build', targetId: constructionSite.id };
  }

  if (creep.room.controller?.my) {
    return { type: 'upgrade', targetId: creep.room.controller.id };
  }

  return null;
}

function selectHarvestSource(creep: Creep): Source | null {
  const sources = creep.room.find(FIND_SOURCES);
  if (sources.length === 0) {
    return null;
  }

  const assignmentCounts = countSameRoomWorkerHarvestAssignments(creep.room.name, sources);
  let selectedSource = sources[0];
  let selectedCount = assignmentCounts.get(selectedSource.id) ?? 0;

  // Ties intentionally keep room.find(FIND_SOURCES) order stable.
  for (const source of sources.slice(1)) {
    const count = assignmentCounts.get(source.id) ?? 0;
    if (count < selectedCount) {
      selectedSource = source;
      selectedCount = count;
    }
  }

  return selectedSource;
}

function countSameRoomWorkerHarvestAssignments(roomName: string | undefined, sources: Source[]): Map<Id<Source>, number> {
  const assignmentCounts = new Map<Id<Source>, number>();
  for (const source of sources) {
    assignmentCounts.set(source.id, 0);
  }

  if (!roomName) {
    return assignmentCounts;
  }

  const sourceIds = new Set(sources.map((source) => source.id as string));
  for (const assignedCreep of getGameCreeps()) {
    const task = assignedCreep.memory?.task as Partial<CreepTaskMemory> | undefined;
    const targetId = typeof task?.targetId === 'string' ? task.targetId : undefined;

    if (
      assignedCreep.memory?.role !== 'worker' ||
      assignedCreep.room?.name !== roomName ||
      task?.type !== 'harvest' ||
      !targetId ||
      !sourceIds.has(targetId)
    ) {
      continue;
    }

    const sourceId = targetId as Id<Source>;
    assignmentCounts.set(sourceId, (assignmentCounts.get(sourceId) ?? 0) + 1);
  }

  return assignmentCounts;
}

function getGameCreeps(): Creep[] {
  const creeps = (globalThis as unknown as { Game?: Partial<Pick<Game, 'creeps'>> }).Game?.creeps;
  return creeps ? Object.values(creeps) : [];
}
