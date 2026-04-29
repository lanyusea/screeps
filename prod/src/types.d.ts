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
  type TerritoryIntentAction = TerritoryControlAction | 'scout';
  type TerritoryDemandType = 'followUpPreparation';
  type TerritoryFollowUpSource = 'satisfiedClaimAdjacent' | 'satisfiedReserveAdjacent' | 'activeReserveAdjacent';

  interface TerritoryMemory {
    targets?: TerritoryTargetMemory[];
    intents?: TerritoryIntentMemory[];
    demands?: TerritoryFollowUpDemandMemory[];
    routeDistances?: Record<string, number | null>;
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
    action: TerritoryIntentAction;
    status: 'planned' | 'active' | 'suppressed';
    updatedAt: number;
    controllerId?: Id<StructureController>;
    followUp?: TerritoryFollowUpMemory;
  }

  interface TerritoryFollowUpMemory {
    source: TerritoryFollowUpSource;
    originRoom: string;
    originAction: TerritoryControlAction;
  }

  interface TerritoryFollowUpDemandMemory {
    type: TerritoryDemandType;
    colony: string;
    targetRoom: string;
    action: TerritoryControlAction;
    workerCount: number;
    updatedAt: number;
    followUp: TerritoryFollowUpMemory;
  }

  interface CreepTerritoryMemory {
    targetRoom: string;
    action: TerritoryIntentAction;
    controllerId?: Id<StructureController>;
    followUp?: TerritoryFollowUpMemory;
  }

  type CreepTaskMemory =
    | { type: 'harvest'; targetId: Id<Source> }
    | { type: 'pickup'; targetId: Id<Resource<ResourceConstant>> }
    | { type: 'withdraw'; targetId: Id<AnyStoreStructure> }
    | { type: 'transfer'; targetId: Id<AnyStoreStructure> }
    | { type: 'build'; targetId: Id<ConstructionSite> }
    | { type: 'repair'; targetId: Id<Structure> }
    | { type: 'claim'; targetId: Id<StructureController> }
    | { type: 'reserve'; targetId: Id<StructureController> }
    | { type: 'upgrade'; targetId: Id<StructureController> };
}
