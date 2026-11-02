import { Gunzip } from "fflate";
import YAML from "yaml";
import {
  buildScenario,
  generateScenario,
  mergeValues,
  queueNameFor,
  type ChartInfo,
  type Scenario,
  type Value,
  type ValueLayer,
  type Values,
} from "./simulation";

type Dependency = { name: string; version?: string; alias?: string; repository?: string };

export type ImportedChart = {
  name: string;
  version: string;
  values: Values;
  dependencies: Dependency[];
  embedded: ImportedChart[];
  fileName: string;
};

const MAX_COMPRESSED_SIZE = 16 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 48 * 1024 * 1024;
const MAX_ENTRIES = 5000;

function isMap(value: unknown): value is Values {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function readTarString(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return text(end < 0 ? field : field.subarray(0, end));
}

function unpackTar(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.length > MAX_EXPANDED_SIZE) throw new Error("The unpacked chart is larger than 48 MB.");
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  let count = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (++count > MAX_ENTRIES) throw new Error("The chart contains too many files.");

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = `${prefix ? `${prefix}/` : ""}${name}`.replace(/^\.\//, "");
    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText, 8);
    const type = header[156];
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length) {
      throw new Error("The chart archive has an invalid tar entry.");
    }
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("The chart archive contains an unsafe path.");
    }
    if (type === 0 || type === 48) entries.set(path, bytes.slice(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function gunzipLimited(bytes: Uint8Array, fileName: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let expandedSize = 0;
  let finished = false;
  try {
    const stream = new Gunzip((chunk, final) => {
      expandedSize += chunk.length;
      if (expandedSize > MAX_EXPANDED_SIZE) throw new Error("The unpacked chart is larger than 48 MB.");
      chunks.push(chunk);
      finished = final;
    });
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      const end = Math.min(offset + 16 * 1024, bytes.length);
      stream.push(bytes.subarray(offset, end), end === bytes.length);
    }
    if (!finished) throw new Error("The gzip stream is incomplete.");
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("larger than 48 MB")) throw cause;
    throw new Error(`${fileName} is not a valid gzip chart package.`);
  }
  const result = new Uint8Array(expandedSize);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function parseValues(source: string, label: string): Values {
  let parsed: unknown;
  try {
    const document = YAML.parseDocument(source, { uniqueKeys: true, merge: true });
    if (document.errors.length) throw new Error();
    parsed = document.toJS();
  } catch {
    // YAML diagnostics can quote a user's source line, including private names.
    throw new Error(`${label} is not valid YAML.`);
  }
  if (parsed === null) return {};
  if (!isMap(parsed)) throw new Error(`${label} must contain a YAML mapping at the top level.`);
  return parsed;
}

function archiveToChart(bytes: Uint8Array, fileName: string, depth = 0): ImportedChart {
  if (depth > 2) throw new Error("The chart has too many nested chart levels.");
  if (bytes.length > MAX_COMPRESSED_SIZE) throw new Error("The chart package is larger than 16 MB.");
  const tar = gunzipLimited(bytes, fileName);
  const files = unpackTar(tar);
  const chartPath = [...files.keys()]
    .filter((path) => path === "Chart.yaml" || path.endsWith("/Chart.yaml"))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!chartPath) throw new Error(`${fileName} has no Chart.yaml.`);
  const chartYaml = parseValues(text(files.get(chartPath)!), `${fileName}/Chart.yaml`);
  const name = chartYaml.name;
  const version = chartYaml.version;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`${fileName}/Chart.yaml needs a name and version.`);
  }

  const root = chartPath.slice(0, -"Chart.yaml".length);
  const valuesBytes = files.get(`${root}values.yaml`);
  const values = valuesBytes ? parseValues(text(valuesBytes), `${fileName}/values.yaml`) : {};
  const dependencies: Dependency[] = Array.isArray(chartYaml.dependencies)
    ? chartYaml.dependencies.filter(isMap).filter((item) => typeof item.name === "string").map((item) => ({
      name: String(item.name),
      version: typeof item.version === "string" ? item.version : undefined,
      alias: typeof item.alias === "string" ? item.alias : undefined,
      repository: typeof item.repository === "string" ? item.repository : undefined,
    }))
    : [];
  const embedded = [...files.entries()]
    .filter(([path]) => path.startsWith(`${root}charts/`) && (path.endsWith(".tgz") || path.endsWith(".tar.gz")))
    .map(([, content]) => archiveToChart(content, "Embedded chart package", depth + 1));

  return { name, version, values, dependencies, embedded, fileName };
}

export async function readChartPackage(file: File): Promise<ImportedChart> {
  if (file.size > MAX_COMPRESSED_SIZE) throw new Error("The chart package is larger than 16 MB.");
  return archiveToChart(new Uint8Array(await file.arrayBuffer()), "Selected chart package");
}

export async function readValueFile(file: File, index = 0): Promise<ValueLayer> {
  const encrypted = file.name.endsWith(".encrypted");
  const label = `Values layer ${index + 1}`;
  const values = encrypted ? {} : parseValues(await file.text(), label);
  return {
    id: `local-${index + 1}`,
    label,
    path: `local/layer-${String(index + 1).padStart(2, "0")}.yaml${encrypted ? ".encrypted" : ""}`,
    note: encrypted ? "Encrypted; skipped in the browser preview" : "Local values file",
    values,
    encrypted,
  };
}

function safeNumbers(source: Values, keys: string[]): Values {
  const output: Values = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
  }
  return output;
}

function publicVersion(version: string | undefined, fallback: string): string {
  // Keep numeric version information while excluding arbitrary text from chart metadata.
  return version && /^\d+\.\d+\.\d+$/.test(version) ? version : fallback;
}

function sanitizedSettings(source: Values, sourceAlias: string | undefined, generated: Scenario, layerIndex: number): Values {
  const scoped = sourceAlias && isMap(source[sourceAlias]) ? source[sourceAlias] : source;
  const output: Values = {};

  if (isMap(scoped.image)) {
    output.image = {
      repository: `${generated.chart.registry}/${generated.releaseName}`,
      tag: String(10000 + ((generated.seed + (layerIndex + 1) * 7919) % 90000)),
    };
  }
  if (isMap(scoped.service)) {
    const port = safeNumbers(scoped.service, ["port"]);
    if (Object.keys(port).length) output.service = port;
  }
  if (isMap(scoped.webappDefaults) && isMap(scoped.webappDefaults.autoscaling)) {
    const autoscaling = safeNumbers(scoped.webappDefaults.autoscaling, ["minReplicas", "maxReplicas"]);
    if (Object.keys(autoscaling).length) output.webappDefaults = { autoscaling };
  }
  if (isMap(scoped.workerDefaults) && isMap(scoped.workerDefaults.autoscaling)) {
    const sourceAutoscaling = scoped.workerDefaults.autoscaling;
    const autoscaling = safeNumbers(sourceAutoscaling, ["minReplicas", "maxReplicas"]);
    if (typeof sourceAutoscaling.scaleToZero === "boolean") autoscaling.scaleToZero = sourceAutoscaling.scaleToZero;
    if (isMap(sourceAutoscaling.queueFallback)) {
      const fallback = safeNumbers(sourceAutoscaling.queueFallback, ["failureThreshold", "replicas"]);
      if (Object.keys(fallback).length) autoscaling.queueFallback = fallback;
    }
    if (Object.keys(autoscaling).length) output.workerDefaults = { autoscaling };
  }
  if (isMap(scoped.deployment) && isMap(scoped.deployment.workers)) {
    const firstWorker = Object.values(scoped.deployment.workers).find(isMap);
    if (firstWorker) {
      const worker: Values = {};
      if (typeof firstWorker.enabled === "boolean") worker.enabled = firstWorker.enabled;
      if (Array.isArray(firstWorker.queues)) {
        const count = Math.min(firstWorker.queues.length, 4);
        worker.queues = Array.from({ length: count }, (_, index) => queueNameFor(generated.seed, index));
      }
      if (isMap(firstWorker.autoscaling)) {
        const autoscaling = safeNumbers(firstWorker.autoscaling, ["minReplicas", "maxReplicas"]);
        if (Object.keys(autoscaling).length) worker.autoscaling = autoscaling;
      }
      if (Object.keys(worker).length) output.deployment = { workers: { [generated.workerName]: worker } };
    }
  }
  return output;
}

export function scenarioFromUploads(charts: ImportedChart[], localLayers: ValueLayer[], seed: number): Scenario {
  if (!charts.length) throw new Error("Choose at least one Helm chart package.");
  const generated = generateScenario(seed);
  const allCharts = charts.flatMap((chart) => [chart, ...chart.embedded]);
  const wrapper = charts.find((chart) => chart.dependencies.length > 0);
  if (!wrapper) throw new Error("Choose a wrapper chart package that declares a dependency in Chart.yaml.");
  const declared = wrapper.dependencies[0];
  const dependency = allCharts.find((chart) => chart.name === declared.name);
  if (dependency && declared.version && dependency.version !== declared.version) {
    throw new Error("The selected dependency version does not match the wrapper chart's version pin.");
  }
  const chart: ChartInfo = {
    name: generated.chart.name,
    version: publicVersion(wrapper.version, generated.chart.version),
    dependencyName: generated.chart.dependencyName,
    dependencyVersion: publicVersion(declared.version ?? dependency?.version, generated.chart.dependencyVersion),
    alias: generated.chart.alias,
    registry: generated.chart.registry,
  };
  const safeDefaults = sanitizedSettings(dependency?.values ?? {}, undefined, generated, -1);
  const defaults = mergeValues(generated.chartDefaults, [{ id: "uploaded-defaults", label: "Chart defaults", path: "chart/values.yaml", note: "", values: safeDefaults }], chart.alias).effective;
  const layers = localLayers.length
    ? [
      ...generated.layers.filter((layer) => ["shared-app", "base-workers", "image-tag"].includes(layer.id)),
      ...localLayers.map((layer, index) => ({
        id: `local-${index + 1}`,
        label: `Values layer ${index + 1}`,
        path: `local/layer-${String(index + 1).padStart(2, "0")}.yaml${layer.encrypted ? ".encrypted" : ""}`,
        note: layer.encrypted ? "Encrypted; skipped in the browser preview" : "Local values file",
        encrypted: layer.encrypted,
        values: layer.encrypted ? {} : { [chart.alias]: sanitizedSettings(layer.values, declared.alias ?? declared.name, generated, index) },
      })),
    ]
    : generated.layers;
  return buildScenario({
    seed,
    mode: "uploaded",
    chart,
    environment: generated.environment,
    cluster: generated.cluster,
    namespace: generated.namespace,
    releaseName: generated.releaseName,
    workerName: generated.workerName,
    chartDefaults: defaults,
    layers,
    uploadNote: `Uploaded files inform the dependency structure and selected numeric settings. Names, paths, and string identifiers are replaced with generated examples. Manifests remain illustrative.`,
  });
}

export function stringifyValue(value: Value): string {
  return YAML.stringify(value, { lineWidth: 0 });
}
