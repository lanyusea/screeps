export {};

declare global {
  interface Memory {
    meta: {
      version: number;
    };
    defense?: DefenseMemory;
    territory?: TerritoryMemory;
  }

  interface CreepMemory {
    role?: string;
    colony?: string;
    task?: CreepTaskMemory;
    defense?: CreepDefenseMemory;
    territory?: CreepTerritoryMemory;
    workerEfficiency?: WorkerEfficiencySampleMemory;
    refillTelemetry?: WorkerRefillTelemetryMemory;
  }

  type DefenseActionType =
    | 'towerAttack'
    | 'towerHeal'
    | 'towerRepair'
    | 'safeMode'
    | 'defenderAttack'
    | 'defenderMove'
    | 'workerFallback';
  type DefenseUnsafeRoomReason = 'enemyTower' | 'hostilePresence';
  type TerritoryIntentSuppressionReason = 'deadZoneTarget' | 'deadZoneRoute';

  interface DefenseMemory {
    actions?: DefenseActionMemory[];
    rooms?: Record<string, DefenseActionMemory>;
    unsafeRooms?: Record<string, DefenseUnsafeRoomMemory>;
  }

  interface DefenseActionMemory {
    type: DefenseActionType;
    roomName: string;
    tick: number;
    reason: string;
    hostileCreepCount: number;
    hostileStructureCount: number;
    damagedCriticalStructureCount: number;
    structureId?: string;
    targetId?: string;
    result?: ScreepsReturnCode;
  }

  interface DefenseUnsafeRoomMemory {
    roomName: string;
    unsafe: true;
    reason: DefenseUnsafeRoomReason;
    updatedAt: number;
    hostileCreepCount: number;
    hostileStructureCount: number;
    hostileTowerCount: number;
  }

  interface CreepDefenseMemory {
    homeRoom: string;
  }

  type TerritoryControlAction = 'claim' | 'reserve';
  type TerritoryIntentAction = TerritoryControlAction | 'scout';
  type TerritoryDemandType = 'followUpPreparation';
  type TerritoryFollowUpSource = 'satisfiedClaimAdjacent' | 'satisfiedReserveAdjacent' | 'activeReserveAdjacent';
  type TerritoryAutomationSource = 'occupationRecommendation' | 'autonomousExpansionClaim';
  type TerritoryIntentSuspensionReason = 'hostile_presence';
  type TerritoryPostClaimBootstrapStatus =
    | 'detected'
    | 'spawnSitePending'
    | 'spawnSiteBlocked'
    | 'spawningWorkers'
    | 'ready';
  type TerritoryExecutionHintReason =
    | 'controlEvidenceStillMissing'
    | 'followUpTargetStillUnseen'
    | 'visibleControlEvidenceStillActionable';

  interface TerritoryMemory {
    targets?: TerritoryTargetMemory[];
    intents?: TerritoryIntentMemory[];
    demands?: TerritoryFollowUpDemandMemory[];
    executionHints?: TerritoryExecutionHintMemory[];
    postClaimBootstraps?: Record<string, TerritoryPostClaimBootstrapMemory>;
    reservations?: Record<string, TerritoryReservationMemory>;
    routeDistances?: Record<string, number | null>;
  }

  interface TerritoryTargetMemory {
    colony: string;
    roomName: string;
    action: TerritoryControlAction;
    controllerId?: Id<StructureController>;
    enabled?: boolean;
    createdBy?: TerritoryAutomationSource;
  }

  interface TerritoryIntentMemory {
    colony: string;
    targetRoom: string;
    action: TerritoryIntentAction;
    status: 'planned' | 'active' | 'suppressed';
    updatedAt: number;
    reason?: TerritoryIntentSuppressionReason;
    lastAttemptAt?: number;
    controllerId?: Id<StructureController>;
    requiresControllerPressure?: boolean;
    followUp?: TerritoryFollowUpMemory;
    suspended?: TerritoryIntentSuspensionMemory;
  }

  interface TerritoryIntentSuspensionMemory {
    reason: TerritoryIntentSuspensionReason;
    hostileCount: number;
    updatedAt: number;
  }

  interface TerritoryReservationMemory {
    colony: string;
    roomName: string;
    ticksToEnd: number;
    updatedAt: number;
    controllerId?: Id<StructureController>;
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

  interface TerritoryPostClaimBootstrapSpawnSiteMemory {
    roomName: string;
    x: number;
    y: number;
  }

  interface TerritoryPostClaimBootstrapMemory {
    colony: string;
    roomName: string;
    status: TerritoryPostClaimBootstrapStatus;
    claimedAt: number;
    updatedAt: number;
    workerTarget: number;
    controllerId?: Id<StructureController>;
    spawnSite?: TerritoryPostClaimBootstrapSpawnSiteMemory;
    lastResult?: ScreepsReturnCode;
  }

  interface CreepTerritoryMemory {
    targetRoom: string;
    action: TerritoryIntentAction;
    controllerId?: Id<StructureController>;
    followUp?: TerritoryFollowUpMemory;
  }

  type WorkerEfficiencySampleType = 'lowLoadReturn' | 'nearbyEnergyChoice';
  type WorkerEfficiencyLowLoadReturnReason =
    | 'emergencySpawnExtensionRefill'
    | 'controllerDowngradeGuard'
    | 'hostileSafety'
    | 'noReachableEnergy'
    | 'urgentSpawnExtensionRefill'
    | 'noNearbyEnergy';

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

  interface WorkerRefillTelemetryMemory {
    current?: WorkerRefillDeliveryMemory;
    recentDeliveries?: WorkerRefillDeliverySampleMemory[];
    refillActiveTicks?: number;
    idleOrOtherTaskTicks?: number;
    lastUpdatedAt?: number;
  }

  interface WorkerRefillDeliveryMemory {
    targetId: string;
    startedAt: number;
    activeTicks: number;
    idleOrOtherTaskTicks: number;
  }

  interface WorkerRefillDeliverySampleMemory {
    tick: number;
    targetId: string;
    deliveryTicks: number;
    activeTicks: number;
    idleOrOtherTaskTicks: number;
    energyDelivered: number;
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
