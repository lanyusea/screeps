export {};

declare global {
  interface Memory {
    meta: {
      version: number;
    };
    territory?: TerritoryMemory;
  }

  interface CreepMemory {
    role?: string;
    colony?: string;
    task?: CreepTaskMemory;
    territory?: CreepTerritoryMemory;
  }

  type TerritoryControlAction = 'claim' | 'reserve';

  interface TerritoryMemory {
    targets?: TerritoryTargetMemory[];
    intents?: TerritoryIntentMemory[];
  }

  interface TerritoryTargetMemory {
    colony: string;
    roomName: string;
    action: TerritoryControlAction;
    controllerId?: Id<StructureController>;
    enabled?: boolean;
  }

  interface TerritoryIntentMemory {
    colony: string;
    targetRoom: string;
    action: TerritoryControlAction;
    status: 'planned' | 'active' | 'suppressed';
    updatedAt: number;
    controllerId?: Id<StructureController>;
  }

  interface CreepTerritoryMemory {
    targetRoom: string;
    action: TerritoryControlAction;
    controllerId?: Id<StructureController>;
  }

  type CreepTaskMemory =
    | { type: 'harvest'; targetId: Id<Source> }
    | { type: 'pickup'; targetId: Id<Resource<ResourceConstant>> }
    | { type: 'transfer'; targetId: Id<AnyStoreStructure> }
    | { type: 'build'; targetId: Id<ConstructionSite> }
    | { type: 'upgrade'; targetId: Id<StructureController> };
}
