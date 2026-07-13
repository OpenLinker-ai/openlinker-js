import { RuntimeWorker } from "../dist/runtime.js";

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const transport = String(process.env.OPENLINKER_RUNTIME_TRANSPORT ?? "auto").trim().toLowerCase();
let executions = 0;
const worker = new RuntimeWorker({
  platformURL: required("OPENLINKER_URL"),
  runtimeURL: String(process.env.OPENLINKER_RUNTIME_URL ?? "").trim() || undefined,
  nodeId: required("OPENLINKER_NODE_ID"),
  nodeVersion: "openlinker-js/runtime-worker",
  agentId: required("OPENLINKER_AGENT_ID"),
  agentToken: required("OPENLINKER_AGENT_TOKEN"),
  transport,
  capacity: 1,
  dataDir: required("OPENLINKER_RUNTIME_DATA_DIR"),
  mtls: {
    certFile: required("OPENLINKER_RUNTIME_MTLS_CERT_FILE"),
    keyFile: required("OPENLINKER_RUNTIME_MTLS_KEY_FILE"),
    caFile: required("OPENLINKER_RUNTIME_MTLS_CA_FILE"),
  },
  retryMinimumMs: positiveInteger("OPENLINKER_RUNTIME_RETRY_MIN_MS", 100),
  retryMaximumMs: positiveInteger("OPENLINKER_RUNTIME_RETRY_MAX_MS", 1_000),
  heartbeatIntervalMs: positiveInteger("OPENLINKER_RUNTIME_HEARTBEAT_MS", 2_000),
  websocketProbeIntervalMs: positiveInteger("OPENLINKER_RUNTIME_WS_PROBE_MS", 250),
  logger: {
    debug: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  },
  async handler(run) {
    executions += 1;
    await run.emit("run.progress", {
      stage: "handled",
      sdk: "typescript",
      execution: executions,
    });
    return {
      output: {
        sdk_language: "typescript",
        configured_transport: transport,
        handler_execution: executions,
        input: run.input,
      },
    };
  },
});

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

let lastState = "";
const monitor = setInterval(() => {
  if (worker.transportState !== lastState) {
    lastState = worker.transportState;
    console.log(`runtime transport state: ${lastState}`);
  }
}, 25);

console.log(`runtime worker example starting: sdk=typescript transport=${transport}`);
try {
  await worker.start(controller.signal);
} finally {
  clearInterval(monitor);
}
