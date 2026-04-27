export {};

declare global {
  interface Memory {
    meta: {
      version: number;
    };
  }

  interface CreepMemory {
    role?: string;
    colony?: string;
    task?: CreepTaskMemory;
  }

  type CreepTaskMemory =
    | { type: 'harvest'; targetId: Id<Source> }
    | { type: 'pickup'; targetId: Id<Resource<ResourceConstant>> }
    | { type: 'transfer'; targetId: Id<AnyStoreStructure> }
    | { type: 'build'; targetId: Id<ConstructionSite> }
    | { type: 'upgrade'; targetId: Id<StructureController> };
}
