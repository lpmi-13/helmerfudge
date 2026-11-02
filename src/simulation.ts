import YAML from "yaml";

export type Value = string | number | boolean | null | Value[] | Values;
export type Values = { [key: string]: Value };

export type ValueLayer = {
  id: string;
  label: string;
  path: string;
  note: string;
  values: Values;
  encrypted?: boolean;
};

export type ChartInfo = {
  name: string;
  version: string;
  dependencyName: string;
  dependencyVersion: string;
  alias: string;
  registry: string;
};

export type ScenarioInput = {
  seed: number;
  mode: "generated" | "uploaded";
  chart: ChartInfo;
  environment: string;
  cluster: string;
  namespace: string;
  releaseName: string;
  workerName: string;
  chartDefaults: Values;
  layers: ValueLayer[];
  uploadNote?: string;
};

export type Change = {
  path: string;
  source: string;
  operation: "added" | "overridden" | "list replaced" | "removed" | "inherited";
  previous?: Value;
  value?: Value;
};

export type Manifest = {
  id: string;
  kind: string;
  name: string;
  description: string;
  yaml: string;
};

export type Trace = {
  label: string;
  path: string;
  before: string;
  after: string;
  source: string;
  rule: string;
};

export type Scenario = ScenarioInput & {
  effectiveValues: Values;
  changes: Change[];
  manifests: Manifest[];
  traces: Trace[];
  image: string;
  queues: string[];
  maxReplicas: number;
  chartFile: string;
  dependencyValuesFile: string;
  valuesFile: string;
};

function isMap(value: Value | unknown): value is Values {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T extends Value>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isMap(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

function visitLeaves(values: Values, source: string, changes: Map<string, Change>, parent = "") {
  for (const [key, value] of Object.entries(values)) {
    const path = parent ? `${parent}.${key}` : key;
    if (isMap(value)) visitLeaves(value, source, changes, path);
    else changes.set(path, { path, source, operation: "inherited", value: clone(value) });
  }
}

function mergeInto(target: Values, overlay: Values, source: string, changes: Map<string, Change>, parent = "") {
  for (const [key, incoming] of Object.entries(overlay)) {
    const path = parent ? `${parent}.${key}` : key;
    const previous = target[key];

    if (incoming === null) {
      if (key in target) {
        delete target[key];
        changes.set(path, { path, source, operation: "removed", previous });
      }
      continue;
    }

    if (isMap(previous) && isMap(incoming)) {
      mergeInto(previous, incoming, source, changes, path);
      continue;
    }

    target[key] = clone(incoming);
    if (isMap(incoming)) {
      visitLeaves(incoming, source, changes, path);
    } else {
      changes.set(path, {
        path,
        source,
        operation: Array.isArray(previous) && Array.isArray(incoming)
          ? "list replaced"
          : previous === undefined ? "added" : "overridden",
        previous: previous === undefined ? undefined : clone(previous),
        value: clone(incoming),
      });
    }
  }
}

export function mergeValues(defaults: Values, layers: ValueLayer[], alias: string) {
  const effective = clone(defaults);
  const changes = new Map<string, Change>();
  visitLeaves(effective, "chart defaults", changes);

  for (const layer of layers) {
    if (layer.encrypted) continue;
    const scoped = layer.values[alias];
    const overlay = isMap(scoped) ? scoped : layer.values;
    mergeInto(effective, overlay, layer.path, changes);
  }

  return { effective, changes: [...changes.values()] };
}

// Models the chart's worker helper: a per-worker setting wins, while missing
// nested settings are filled from workerDefaults.
export function fillWorkerDefaults(worker: Values, defaults: Values): Values {
  const result = clone(worker);
  for (const [key, fallback] of Object.entries(defaults)) {
    const current = result[key];
    if (current === undefined || current === null) {
      result[key] = clone(fallback);
    } else if (isMap(current) && isMap(fallback)) {
      result[key] = fillWorkerDefaults(current, fallback);
    } else if (Array.isArray(fallback) && Array.isArray(current) && current.length === 0) {
      result[key] = clone(fallback);
    }
  }
  return result;
}

function at(values: Values, path: string): Value | undefined {
  return path.split(".").reduce<Value | undefined>((current, key) => isMap(current) ? current[key] : undefined, values);
}

function text(value: Value | undefined, fallback = "—"): string {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (isMap(value)) return YAML.stringify(value).trim();
  return String(value);
}

function number(value: Value | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function words(value: Value | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function makeManifest(id: string, kind: string, name: string, description: string, object: Values): Manifest {
  return { id, kind, name, description, yaml: YAML.stringify(object, { lineWidth: 0 }) };
}

const NAME_WORDS = ["amber", "birch", "cobalt", "ember", "forge", "harbor", "lumen", "moss", "orbit", "quartz", "relay", "willow"];
const NAME_SLOT = {
  chart: 1,
  dependency: 2,
  release: 3,
  environment: 4,
  cluster: 5,
  namespace: 6,
  worker: 7,
  registry: 10,
  webapp: 11,
  queueStart: 20,
} as const;

function nameFor(seed: number, slot: number): string {
  const mixed = Math.imul((seed ^ slot) >>> 0, 0x9e3779b1) >>> 0;
  const word = NAME_WORDS[(mixed >>> 8) % NAME_WORDS.length];
  // The final seven characters encode the full mixed seed, so names stay distinct across seeds.
  const hash = `${((mixed >>> 16) % 36).toString(36)}${mixed.toString(36).padStart(7, "0")}`;
  return `${word}-${hash}`;
}

export function queueNameFor(seed: number, index: number): string {
  return nameFor(seed, NAME_SLOT.queueStart + index);
}

function renderRepresentativeManifests(input: ScenarioInput, effective: Values): Manifest[] {
  const imageValues = isMap(effective.image) ? effective.image : {};
  const imageRepository = text(imageValues.repository, `${input.chart.registry}/${input.releaseName}`);
  const imageTag = text(imageValues.tag, "latest");
  const image = `${imageRepository}:${imageTag}`;
  const deployments = isMap(effective.deployment) ? effective.deployment : {};
  const workers = isMap(deployments.workers) ? deployments.workers : {};
  const selectedName = isMap(workers[input.workerName]) ? input.workerName : Object.keys(workers).find((key) => isMap(workers[key])) ?? input.workerName;
  const workerRaw = isMap(workers[selectedName]) ? workers[selectedName] : {};
  const workerDefaults = isMap(effective.workerDefaults) ? effective.workerDefaults : {};
  const worker = fillWorkerDefaults(workerRaw, workerDefaults);
  const autoscaling = isMap(worker.autoscaling) ? worker.autoscaling : {};
  const webappDefaults = isMap(effective.webappDefaults) ? effective.webappDefaults : {};
  const webappAutoscaling = isMap(webappDefaults.autoscaling) ? webappDefaults.autoscaling : {};
  const service = isMap(effective.service) ? effective.service : {};
  const queues = words(worker.queues);
  const appName = input.releaseName;
  const webappName = nameFor(input.seed, NAME_SLOT.webapp);
  const workerName = selectedName;
  const labels = { app: appName, component: webappName };
  const workerLabels = { app: appName, component: workerName };

  return [
    makeManifest("webapp", "Deployment", webappName, "Serves the web application", {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: webappName, namespace: input.namespace },
      spec: {
        replicas: number(webappAutoscaling.minReplicas, 2),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: { containers: [{ name: webappName, image, ports: [{ containerPort: number(service.port, 8000) }] }] },
        },
      },
    }),
    makeManifest("worker", "Deployment", workerName, `Consumes ${queues.join(" and ") || "configured"} queues`, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: workerName, namespace: input.namespace },
      spec: {
        replicas: number(autoscaling.minReplicas, 0),
        selector: { matchLabels: workerLabels },
        template: {
          metadata: { labels: workerLabels },
          spec: {
            containers: [{ name: workerName, image, args: [`--queues=${queues.join(",")}`] }],
          },
        },
      },
    }),
    makeManifest("scaledobject", "ScaledObject", workerName, "Scales the worker from RabbitMQ queue depth", {
      apiVersion: "keda.sh/v1alpha1",
      kind: "ScaledObject",
      metadata: { name: workerName, namespace: input.namespace },
      spec: {
        scaleTargetRef: { name: workerName },
        minReplicaCount: autoscaling.scaleToZero ? 0 : number(autoscaling.minReplicas, 2),
        maxReplicaCount: number(autoscaling.maxReplicas, 10),
        fallback: isMap(autoscaling.queueFallback) ? autoscaling.queueFallback : { failureThreshold: 3, replicas: 1 },
        triggers: queues.map((queue) => ({ type: "rabbitmq", metadata: { queueName: queue, metricType: "AverageValue" } })),
      },
    }),
    makeManifest("service", "Service", webappName, "Exposes the web application", {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: webappName, namespace: input.namespace },
      spec: { selector: labels, ports: [{ name: "http", port: number(service.port, 8000), targetPort: number(service.port, 8000) }] },
    }),
  ];
}

export function buildScenario(input: ScenarioInput): Scenario {
  const { effective, changes } = mergeValues(input.chartDefaults, input.layers, input.chart.alias);
  const manifests = renderRepresentativeManifests(input, effective);
  const deployment = isMap(effective.deployment) ? effective.deployment : {};
  const workers = isMap(deployment.workers) ? deployment.workers : {};
  const selectedName = isMap(workers[input.workerName]) ? input.workerName : Object.keys(workers).find((key) => isMap(workers[key])) ?? input.workerName;
  const worker = isMap(workers[selectedName]) ? workers[selectedName] : {};
  const workerDefaults = isMap(effective.workerDefaults) ? effective.workerDefaults : {};
  const filledWorker = fillWorkerDefaults(worker, workerDefaults);
  const autoscaling = isMap(filledWorker.autoscaling) ? filledWorker.autoscaling : {};
  const imageValues = isMap(effective.image) ? effective.image : {};
  const image = `${text(imageValues.repository, `${input.chart.registry}/${input.releaseName}`)}:${text(imageValues.tag, "latest")}`;
  const queuePath = `deployment.workers.${selectedName}.queues`;
  const queueChange = changes.find((change) => change.path === queuePath);
  const imageChange = changes.find((change) => change.path === "image.tag");
  const maxPath = `deployment.workers.${selectedName}.autoscaling.maxReplicas`;
  const maxChange = changes.find((change) => change.path === maxPath);
  const traces: Trace[] = [
    {
      label: "Worker queues",
      path: queuePath,
      before: text(queueChange?.previous, "chart default"),
      after: text(at(effective, queuePath)),
      source: queueChange?.source ?? "chart defaults",
      rule: queueChange?.operation ?? "inherited",
    },
    {
      label: "Image tag",
      path: "image.tag",
      before: text(imageChange?.previous, "chart default"),
      after: text(imageValues.tag),
      source: imageChange?.source ?? "chart defaults",
      rule: imageChange?.operation ?? "inherited",
    },
    {
      label: "Max replicas",
      path: maxPath,
      before: text(maxChange?.previous, text(isMap(workerDefaults.autoscaling) ? workerDefaults.autoscaling.maxReplicas : undefined)),
      after: text(autoscaling.maxReplicas),
      source: maxChange?.source ?? "workerDefaults",
      rule: maxChange?.operation ?? "filled from workerDefaults",
    },
  ];

  const chartFile = YAML.stringify({
    apiVersion: "v2",
    name: input.chart.name,
    version: input.chart.version,
    dependencies: [{ name: input.chart.dependencyName, alias: input.chart.alias, version: input.chart.dependencyVersion, repository: `oci://${input.chart.registry}` }],
  }, { lineWidth: 0 });
  const dependencyValuesFile = YAML.stringify(input.chartDefaults, { lineWidth: 0 });
  const valuesFile = YAML.stringify(effective, { lineWidth: 0 });

  return {
    ...input,
    workerName: selectedName,
    effectiveValues: effective,
    changes,
    manifests,
    traces,
    image,
    queues: words(worker.queues),
    maxReplicas: number(autoscaling.maxReplicas, 10),
    chartFile,
    dependencyValuesFile,
    valuesFile,
  };
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function oneOf<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

export function freshSeed(): number {
  return globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? Math.floor(Math.random() * 4294967296);
}

export function generateScenario(seed: number): Scenario {
  const rng = random(seed);
  const releaseName = nameFor(seed, NAME_SLOT.release);
  const environment = nameFor(seed, NAME_SLOT.environment);
  const cluster = nameFor(seed, NAME_SLOT.cluster);
  const namespace = nameFor(seed, NAME_SLOT.namespace);
  const workerName = nameFor(seed, NAME_SLOT.worker);
  const baseQueue = queueNameFor(seed, 0);
  const extraQueue = queueNameFor(seed, 1);
  const registry = nameFor(seed, NAME_SLOT.registry);
  const chartName = nameFor(seed, NAME_SLOT.chart);
  const chart: ChartInfo = {
    name: chartName,
    version: `1.${2 + Math.floor(rng() * 8)}.${Math.floor(rng() * 8)}`,
    dependencyName: nameFor(seed, NAME_SLOT.dependency),
    dependencyVersion: `2.${1 + Math.floor(rng() * 9)}.${Math.floor(rng() * 8)}`,
    alias: chartName,
    registry,
  };
  const imageTag = String(10000 + Math.floor(rng() * 90000));
  const maxReplicas = oneOf([12, 16, 20, 24], rng);
  const minReplicas = oneOf([2, 3], rng);
  const envPath = `config/${environment}/apps/${releaseName}`;
  const imageRepository = `${registry}/${releaseName}`;
  const chartDefaults: Values = {
    image: { repository: imageRepository, tag: "chart-default" },
    service: { port: 8000 },
    webappDefaults: { autoscaling: { minReplicas: 1, maxReplicas: 3 } },
    workerDefaults: { app: "sample.tasks", autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 10 }, resources: { requests: { cpu: "500m", memory: "768Mi" } } },
    deployment: { webapps: { webapp: { enabled: true } }, workers: {} },
  };
  const layers: ValueLayer[] = [
    {
      id: "shared-app",
      label: "Shared app values",
      path: "config/shared/application.yaml",
      note: "Shared application settings",
      values: { [chart.alias]: { environment: { REQUEST_TIMEOUT: 120, TRACING_ENABLED: true }, telemetry: { mode: "socket" } } },
    },
    {
      id: "base-workers",
      label: "Worker baseline",
      path: "config/shared/workers.yaml",
      note: "Shared worker and KEDA defaults",
      values: { [chart.alias]: {
        workerDefaults: { autoscaling: { scaleToZero: true, queueFallback: { failureThreshold: 3, replicas: 1 } } },
        deployment: { workers: { [workerName]: { enabled: true, queues: [baseQueue], extraEnv: { SERVICE_ROLE: workerName } } } },
      } },
    },
    {
      id: "environment",
      label: "Environment overrides",
      path: `${envPath}/values.yaml`,
      note: "Replaces a queue list and tunes replicas",
      values: { [chart.alias]: {
        webappDefaults: { autoscaling: { minReplicas } },
        deployment: { workers: { [workerName]: { queues: [extraQueue, baseQueue], autoscaling: { maxReplicas } } } },
      } },
    },
    {
      id: "image-tag",
      label: "Image tag",
      path: `${envPath}/image-tag-value.yaml`,
      note: "Pins the application image",
      values: { [chart.alias]: { image: { repository: imageRepository, tag: imageTag } } },
    },
    {
      id: "image-override",
      label: "Image override",
      path: `${envPath}/image-tag-value-override.yaml`,
      note: "Empty unless a release is pinned",
      values: {},
    },
    {
      id: "app-env",
      label: "App configuration",
      path: `${envPath}/runtime.yaml`,
      note: "Environment specific settings",
      values: { [chart.alias]: { environment: { ZONE: oneOf(["zone-a", "zone-b", "zone-c"], rng), LOG_LEVEL: "INFO" } } },
    },
    {
      id: "secrets",
      label: "Encrypted values",
      path: `${envPath}/secrets.yaml.encrypted`,
      note: "Locked in this browser preview",
      values: {},
      encrypted: true,
    },
  ];

  return buildScenario({ seed, mode: "generated", chart, environment, cluster, namespace, releaseName, workerName, chartDefaults, layers });
}
