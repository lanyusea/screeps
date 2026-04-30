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
    workerEfficiency?: WorkerEfficiencySampleMemory;
  }

  type TerritoryControlAction = 'claim' | 'reserve';
  type TerritoryIntentAction = TerritoryControlAction | 'scout';
  type TerritoryDemandType = 'followUpPreparation';
  type TerritoryFollowUpSource = 'satisfiedClaimAdjacent' | 'satisfiedReserveAdjacent' | 'activeReserveAdjacent';
  type TerritoryExecutionHintReason =
    | 'controlEvidenceStillMissing'
    | 'followUpTargetStillUnseen'
    | 'visibleControlEvidenceStillActionable';

  interface TerritoryMemory {
    targets?: TerritoryTargetMemory[];
    intents?: TerritoryIntentMemory[];
    demands?: TerritoryFollowUpDemandMemory[];
    executionHints?: TerritoryExecutionHintMemory[];
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
    lastAttemptAt?: number;
    controllerId?: Id<StructureController>;
    requiresControllerPressure?: boolean;
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

  interface TerritoryExecutionHintMemory {
    type: 'activeFollowUpExecution';
    colony: string;
    targetRoom: string;
    action: TerritoryIntentAction;
    reason: TerritoryExecutionHintReason;
    updatedAt: number;
    controllerId?: Id<StructureController>;
    followUp: TerritoryFollowUpMemory;
  }

  interface CreepTerritoryMemory {
    targetRoom: string;
    action: TerritoryIntentAction;
    controllerId?: Id<StructureController>;
    followUp?: TerritoryFollowUpMemory;
  }

  type WorkerEfficiencySampleType = 'lowLoadReturn' | 'nearbyEnergyChoice';
  type WorkerEfficiencyLowLoadReturnReason = 'urgentSpawnExtensionRefill' | 'noNearbyEnergy';

  interface WorkerEfficiencySampleMemory {
    type: WorkerEfficiencySampleType;
    tick: number;
    carriedEnergy: number;
    freeCapacity: number;
    selectedTask: CreepTaskMemory['type'];
    targetId: string;
    energy?: number;
    range?: number;
    reason?: WorkerEfficiencyLowLoadReturnReason;
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
