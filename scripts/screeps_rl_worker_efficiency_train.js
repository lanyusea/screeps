#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_WORKER_EFFICIENCY_RL_OUTPUT_DIR,
  DEFAULT_WORKER_EFFICIENCY_RL_SAMPLE_COUNT,
  renderWorkerEfficiencyEvaluationReport,
  runWorkerEfficiencyOfflineFineTune
} = loadWorkerEfficiencyModule();

function loadWorkerEfficiencyModule() {
  const typescript = require('../prod/node_modules/typescript');
  const sourcePath = path.join(__dirname, '..', 'prod', 'src', 'rl', 'workerEfficiency.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2019
    },
    fileName: sourcePath
  }).outputText;
  const moduleRef = { exports: {} };
  const execute = new Function('exports', 'module', 'require', compiled);
  execute(moduleRef.exports, moduleRef, require);
  return moduleRef.exports;
}

function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_WORKER_EFFICIENCY_RL_OUTPUT_DIR,
    sampleCount: DEFAULT_WORKER_EFFICIENCY_RL_SAMPLE_COUNT,
    seed: 'worker-efficiency-cql-v1'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out-dir') {
      options.outDir = argv[++index];
    } else if (arg === '--sample-count') {
      options.sampleCount = Number(argv[++index]);
    } else if (arg === '--seed') {
      options.seed = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.sampleCount) || options.sampleCount <= 0) {
    throw new Error('--sample-count must be a positive integer');
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/screeps_rl_worker_efficiency_train.js [options]

Builds the offline conservative worker-efficiency RL artifact from the compiled prod bundle.

Options:
  --out-dir <path>         Artifact root. Default: ${DEFAULT_WORKER_EFFICIENCY_RL_OUTPUT_DIR}
  --sample-count <count>   Reward-labeled samples to synthesize. Default: ${DEFAULT_WORKER_EFFICIENCY_RL_SAMPLE_COUNT}
  --seed <seed>            Deterministic training seed.
`);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runWorkerEfficiencyOfflineFineTune({
    sampleCount: options.sampleCount,
    seed: options.seed
  });
  const runDir = path.join(options.outDir, result.artifact.policyId);
  fs.mkdirSync(runDir, { recursive: true });

  writeJson(path.join(runDir, 'policy.json'), result.artifact);
  writeJson(path.join(runDir, 'evaluation_report.json'), result.evaluation);
  fs.writeFileSync(path.join(runDir, 'evaluation_report.md'), renderWorkerEfficiencyEvaluationReport(result.evaluation), 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        policyId: result.artifact.policyId,
        outputDir: runDir,
        sampleCount: result.training.sampleCount,
        liveEffect: result.artifact.liveEffect,
        pass: result.evaluation.pass,
        improvementRatio: result.evaluation.improvementRatio,
        minimumScenarioImprovementRatio: result.evaluation.minimumScenarioImprovementRatio
      },
      null,
      2
    )}\n`
  );

  if (!result.evaluation.pass) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
