export const STRATEGY_REGISTRY_SCHEMA_VERSION = 1;

export type StrategyModelFamily =
  | 'construction-priority'
  | 'expansion-remote-candidate'
  | 'defense-posture-repair-threshold';

export type StrategyArtifactType = 'runtime-summary' | 'room-snapshot';
export type StrategyRolloutStatus = 'incumbent' | 'shadow' | 'disabled' | 'retired';
export type StrategyKnobValue = number | string | boolean;

export interface StrategySupportedContext {
  artifactTypes: StrategyArtifactType[];
  shards?: string[];
  rooms?: string[];
  minRcl?: number;
  maxRcl?: number;
  notes: string;
}

export interface StrategyNumberKnobBounds {
  kind: 'number';
  min: number;
  max: number;
  step?: number;
}

export interface StrategyIntegerKnobBounds {
  kind: 'integer';
  min: number;
  max: number;
  step?: number;
}

export interface StrategyBooleanKnobBounds {
  kind: 'boolean';
}

export interface StrategyEnumKnobBounds {
  kind: 'enum';
  values: string[];
}

export type StrategyKnobBounds =
  | StrategyNumberKnobBounds
  | StrategyIntegerKnobBounds
  | StrategyBooleanKnobBounds
  | StrategyEnumKnobBounds;

export interface StrategyKnobDefinition {
  name: string;
  description: string;
  bounds: StrategyKnobBounds;
}

export interface StrategyEvidenceLink {
  label: string;
  source: 'issue' | 'pr' | 'docs' | 'artifact' | 'test';
  url?: string;
  path?: string;
}

export interface StrategyRollbackFields {
  disabledByDefault: boolean;
  disableFlag: string;
  rollbackToStrategyId?: string;
  stopConditions: string[];
  notes: string;
}

export interface StrategyOwnerReference {
  issue: number;
  pr?: number;
}

export interface StrategyRegistryEntry {
  id: string;
  schemaVersion: number;
  version: string;
  family: StrategyModelFamily;
  title: string;
  owner: StrategyOwnerReference;
  supportedContext: StrategySupportedContext;
  knobBounds: StrategyKnobDefinition[];
  defaultValues: Record<string, StrategyKnobValue>;
  rolloutStatus: StrategyRolloutStatus;
  evidenceLinks: StrategyEvidenceLink[];
  rollback: StrategyRollbackFields;
}

export interface StrategyRegistryValidationResult {
  valid: boolean;
  issues: string[];
}

const ISSUE_265_URL = 'https://github.com/lanyusea/screeps/issues/265';
const RL_RESEARCH_PATH = 'docs/research/2026-04-29-screeps-rl-self-evolving-strategy-paper.md';

export const DEFAULT_STRATEGY_REGISTRY: StrategyRegistryEntry[] = [
  {
    id: 'construction-priority.incumbent.v1',
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: '1.0.0',
    family: 'construction-priority',
    title: 'Current construction priority scoring shadow baseline',
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ['runtime-summary'],
      shards: ['shardX'],
      rooms: ['E48S28'],
      minRcl: 1,
      maxRcl: 4,
      notes: 'Reads emitted constructionPriority candidate summaries; does not alter construction selection.'
    },
    knobBounds: [
      numberKnob('baseScoreWeight', 'Weight applied to the already-emitted incumbent score.', 0, 3, 0.1),
      numberKnob('territorySignalWeight', 'Weight for territory-first expected KPI signals.', 0, 30, 1),
      numberKnob('resourceSignalWeight', 'Weight for resource-scaling expected KPI signals.', 0, 30, 1),
      numberKnob('killSignalWeight', 'Weight for enemy-kill or defense-posture signals.', 0, 30, 1),
      numberKnob('riskPenalty', 'Penalty per visible risk or blocking precondition.', 0, 30, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 6,
      resourceSignalWeight: 4,
      killSignalWeight: 6,
      riskPenalty: 4
    },
    rolloutStatus: 'incumbent',
    evidenceLinks: [
      { label: 'Issue #265', source: 'issue', url: ISSUE_265_URL },
      { label: 'RL/self-evolving strategy paper', source: 'docs', path: RL_RESEARCH_PATH }
    ],
    rollback: passiveRollback('construction-priority.incumbent.v1')
  },
  {
    id: 'construction-priority.territory-shadow.v1',
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: '1.0.0',
    family: 'construction-priority',
    title: 'Territory-first construction priority shadow candidate',
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ['runtime-summary'],
      shards: ['shardX'],
      rooms: ['E48S28'],
      minRcl: 1,
      maxRcl: 4,
      notes: 'Replays only saved constructionPriority candidates with a higher territory signal weight.'
    },
    knobBounds: [
      numberKnob('baseScoreWeight', 'Weight applied to the already-emitted incumbent score.', 0, 3, 0.1),
      numberKnob('territorySignalWeight', 'Weight for territory-first expected KPI signals.', 0, 30, 1),
      numberKnob('resourceSignalWeight', 'Weight for resource-scaling expected KPI signals.', 0, 30, 1),
      numberKnob('killSignalWeight', 'Weight for enemy-kill or defense-posture signals.', 0, 30, 1),
      numberKnob('riskPenalty', 'Penalty per visible risk or blocking precondition.', 0, 30, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 22,
      resourceSignalWeight: 3,
      killSignalWeight: 5,
      riskPenalty: 4
    },
    rolloutStatus: 'shadow',
    evidenceLinks: [
      { label: 'Issue #265', source: 'issue', url: ISSUE_265_URL },
      { label: 'Fixture replay coverage', source: 'test', path: 'prod/test/strategyShadowEvaluator.test.ts' }
    ],
    rollback: passiveRollback('construction-priority.incumbent.v1')
  },
  {
    id: 'expansion-remote.incumbent.v1',
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: '1.0.0',
    family: 'expansion-remote-candidate',
    title: 'Current expansion and remote candidate scoring shadow baseline',
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ['runtime-summary', 'room-snapshot'],
      shards: ['shardX'],
      rooms: ['E48S28'],
      minRcl: 1,
      notes: 'Reads territoryRecommendation candidates from saved summaries; it never writes Memory intents.'
    },
    knobBounds: [
      numberKnob('baseScoreWeight', 'Weight applied to the emitted occupation score.', 0, 3, 0.1),
      numberKnob('territorySignalWeight', 'Weight for occupy/reserve/scout territory ordering.', 0, 40, 1),
      numberKnob('resourceSignalWeight', 'Weight for visible source and support evidence.', 0, 30, 1),
      numberKnob('killSignalWeight', 'Weight for hostile suppression opportunity.', 0, 30, 1),
      numberKnob('riskPenalty', 'Penalty for hostile, route, or evidence risk.', 0, 40, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 8,
      resourceSignalWeight: 5,
      killSignalWeight: 2,
      riskPenalty: 10
    },
    rolloutStatus: 'incumbent',
    evidenceLinks: [
      { label: 'Issue #265', source: 'issue', url: ISSUE_265_URL },
      { label: 'Gameplay evolution roadmap', source: 'docs', path: 'docs/ops/gameplay-evolution-roadmap.md' }
    ],
    rollback: passiveRollback('expansion-remote.incumbent.v1')
  },
  {
    id: 'expansion-remote.territory-shadow.v1',
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: '1.0.0',
    family: 'expansion-remote-candidate',
    title: 'Territory-first expansion and remote candidate shadow model',
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ['runtime-summary', 'room-snapshot'],
      shards: ['shardX'],
      rooms: ['E48S28'],
      minRcl: 1,
      notes: 'Emphasizes occupy/reserve candidates in offline ranking reports only.'
    },
    knobBounds: [
      numberKnob('baseScoreWeight', 'Weight applied to the emitted occupation score.', 0, 3, 0.1),
      numberKnob('territorySignalWeight', 'Weight for occupy/reserve/scout territory ordering.', 0, 40, 1),
      numberKnob('resourceSignalWeight', 'Weight for visible source and support evidence.', 0, 30, 1),
      numberKnob('killSignalWeight', 'Weight for hostile suppression opportunity.', 0, 30, 1),
      numberKnob('riskPenalty', 'Penalty for hostile, route, or evidence risk.', 0, 40, 1)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 26,
      resourceSignalWeight: 4,
      killSignalWeight: 2,
      riskPenalty: 10
    },
    rolloutStatus: 'shadow',
    evidenceLinks: [
      { label: 'Issue #265', source: 'issue', url: ISSUE_265_URL },
      { label: 'Fixture replay coverage', source: 'test', path: 'prod/test/strategyShadowEvaluator.test.ts' }
    ],
    rollback: passiveRollback('expansion-remote.incumbent.v1')
  },
  {
    id: 'defense-repair.incumbent.v1',
    schemaVersion: STRATEGY_REGISTRY_SCHEMA_VERSION,
    version: '1.0.0',
    family: 'defense-posture-repair-threshold',
    title: 'Current defense posture and repair threshold shadow baseline',
    owner: { issue: 265 },
    supportedContext: {
      artifactTypes: ['runtime-summary', 'room-snapshot'],
      shards: ['shardX'],
      rooms: ['E48S28'],
      minRcl: 1,
      notes: 'Ranks observed rooms by hostile and repair pressure from saved artifacts only.'
    },
    knobBounds: [
      numberKnob('baseScoreWeight', 'Weight applied to observed hostile and damage pressure.', 0, 3, 0.1),
      numberKnob('territorySignalWeight', 'Weight for controller survival and held-room protection.', 0, 30, 1),
      numberKnob('resourceSignalWeight', 'Weight for storage and productive-structure protection.', 0, 30, 1),
      numberKnob('killSignalWeight', 'Weight for hostile presence and tower/rampart readiness.', 0, 40, 1),
      numberKnob('riskPenalty', 'Penalty for unavailable or insufficient observations.', 0, 30, 1),
      numberKnob('repairCriticalHitsRatio', 'Critical repair hit ratio threshold.', 0.01, 1, 0.01)
    ],
    defaultValues: {
      baseScoreWeight: 1,
      territorySignalWeight: 12,
      resourceSignalWeight: 6,
      killSignalWeight: 18,
      riskPenalty: 4,
      repairCriticalHitsRatio: 0.5
    },
    rolloutStatus: 'incumbent',
    evidenceLinks: [
      { label: 'Issue #265', source: 'issue', url: ISSUE_265_URL },
      { label: 'Runtime room monitor runbook', source: 'docs', path: 'docs/ops/runtime-room-monitor.md' }
    ],
    rollback: passiveRollback('defense-repair.incumbent.v1')
  }
];

export function validateStrategyRegistryEntry(entry: StrategyRegistryEntry): StrategyRegistryValidationResult {
  const issues: string[] = [];

  if (entry.schemaVersion !== STRATEGY_REGISTRY_SCHEMA_VERSION) {
    issues.push(`unsupported schemaVersion ${entry.schemaVersion}`);
  }

  if (!entry.id) {
    issues.push('missing strategy id');
  }

  if (!entry.version) {
    issues.push('missing strategy version');
  }

  if (!entry.owner.issue || entry.owner.issue <= 0) {
    issues.push('missing owning issue');
  }

  if (entry.supportedContext.artifactTypes.length === 0) {
    issues.push('supported context must name at least one artifact type');
  }

  if (entry.knobBounds.length === 0) {
    issues.push('strategy must declare bounded knobs');
  }

  const declaredKnobs = new Set<string>();
  for (const knob of entry.knobBounds) {
    if (declaredKnobs.has(knob.name)) {
      issues.push(`duplicate knob ${knob.name}`);
    }
    declaredKnobs.add(knob.name);

    if (!(knob.name in entry.defaultValues)) {
      issues.push(`missing default for knob ${knob.name}`);
      continue;
    }

    const defaultValue = entry.defaultValues[knob.name];
    if (!isKnobDefaultWithinBounds(defaultValue, knob.bounds)) {
      issues.push(`default for knob ${knob.name} is outside declared bounds`);
    }
  }

  for (const defaultName of Object.keys(entry.defaultValues)) {
    if (!declaredKnobs.has(defaultName)) {
      issues.push(`default declared without knob bounds: ${defaultName}`);
    }
  }

  if (entry.evidenceLinks.length === 0) {
    issues.push('missing evidence links');
  }

  if (!entry.rollback.disableFlag) {
    issues.push('missing rollback disable flag');
  }

  if (entry.rollback.stopConditions.length === 0) {
    issues.push('missing rollback stop conditions');
  }

  return { valid: issues.length === 0, issues };
}

export function validateStrategyRegistry(entries: StrategyRegistryEntry[]): StrategyRegistryValidationResult {
  const issues: string[] = [];
  const ids = new Set<string>();

  for (const entry of entries) {
    if (ids.has(entry.id)) {
      issues.push(`duplicate strategy id ${entry.id}`);
    }
    ids.add(entry.id);

    const entryResult = validateStrategyRegistryEntry(entry);
    issues.push(...entryResult.issues.map((issue) => `${entry.id}: ${issue}`));
  }

  return { valid: issues.length === 0, issues };
}

export function getStrategyNumberDefault(entry: StrategyRegistryEntry, knobName: string, fallback = 0): number {
  const value = entry.defaultValues[knobName];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberKnob(
  name: string,
  description: string,
  min: number,
  max: number,
  step?: number
): StrategyKnobDefinition {
  return {
    name,
    description,
    bounds: {
      kind: 'number',
      min,
      max,
      ...(step !== undefined ? { step } : {})
    }
  };
}

function passiveRollback(rollbackToStrategyId: string): StrategyRollbackFields {
  return {
    disabledByDefault: true,
    disableFlag: 'strategyShadowEvaluator.enabled=false',
    rollbackToStrategyId,
    stopConditions: [
      'shadow report is noisy or expensive',
      'artifact parsing cannot be proven deterministic',
      'any candidate output is accidentally wired into live Screeps actions'
    ],
    notes: 'The first slice is pure offline/shadow evaluation; disabling the evaluator leaves live behavior unchanged.'
  };
}

function isKnobDefaultWithinBounds(value: StrategyKnobValue, bounds: StrategyKnobBounds): boolean {
  switch (bounds.kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && bounds.values.includes(value);
    default:
      return false;
  }
}
