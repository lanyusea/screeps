export function selectWorkerTask(creep: Creep): CreepTaskMemory | null {
  const carriedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY);

  if (carriedEnergy === 0) {
    const [source] = creep.room.find(FIND_SOURCES);
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
