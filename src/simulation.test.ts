import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { buildScenario, fillWorkerDefaults, generateScenario, mergeValues, type ValueLayer } from "./simulation";

describe("Helm-style values layering", () => {
  it("merges maps, replaces lists, and removes null overrides in declared order", () => {
    const layers: ValueLayer[] = [
      { id: "base", label: "base", path: "base.yaml", note: "", values: { app: { nested: { keep: "yes", replace: "before" }, queues: ["sales"], remove: "old" } } },
      { id: "env", label: "env", path: "env.yaml", note: "", values: { app: { nested: { replace: "after" }, queues: ["slack", "sales"], remove: null } } },
    ];
    const result = mergeValues({}, layers, "app");

    expect(result.effective).toEqual({ nested: { keep: "yes", replace: "after" }, queues: ["slack", "sales"] });
    expect(result.changes.find((change) => change.path === "queues")).toMatchObject({ source: "env.yaml", operation: "list replaced", previous: ["sales"], value: ["slack", "sales"] });
    expect(result.changes.find((change) => change.path === "remove")?.operation).toBe("removed");
  });

  it("fills worker defaults without replacing explicit worker values", () => {
    expect(fillWorkerDefaults(
      { queues: ["slack", "sales"], autoscaling: { maxReplicas: 20 } },
      { queues: ["default"], autoscaling: { maxReplicas: 10, queueFallback: { replicas: 1 } } },
    )).toEqual({ queues: ["slack", "sales"], autoscaling: { maxReplicas: 20, queueFallback: { replicas: 1 } } });
  });
});

describe("generated deployment story", () => {
  it("carries a replaced queue list and image tag through to the representative manifests", () => {
    const scenario = generateScenario(84012);
    const worker = scenario.manifests.find((item) => item.id === "worker");
    const scaledObject = scenario.manifests.find((item) => item.id === "scaledobject");

    expect(scenario.queues).toHaveLength(2);
    expect(scenario.traces[0].rule).toBe("list replaced");
    expect(worker?.yaml).toContain(`--queues=${scenario.queues.join(",")}`);
    expect(worker?.yaml).toContain(scenario.image);
    expect(scaledObject?.yaml).toContain("failureThreshold: 3");
    expect(scaledObject?.yaml).toContain(`maxReplicaCount: ${scenario.maxReplicas}`);
    expect(YAML.parse(scenario.dependencyValuesFile)).toEqual(scenario.chartDefaults);
    expect(YAML.parse(scenario.valuesFile)).toEqual(scenario.effectiveValues);
  });

  it("keeps the selected chart versions and alias in the package preview", () => {
    const generated = generateScenario(23);
    const scenario = buildScenario({ ...generated, chart: { ...generated.chart, version: "4.14.0", dependencyVersion: "4.20.4" } });
    expect(scenario.chartFile).toContain("version: 4.14.0");
    expect(scenario.chartFile).toContain("version: 4.20.4");
    expect(scenario.chartFile).toContain(`alias: ${generated.chart.alias}`);
  });

  it("changes cluster and resource identifiers when the seed changes", () => {
    const first = generateScenario(17);
    const second = generateScenario(18);
    const shortName = /^[a-z]+-[a-z0-9]{8}$/;
    const names = [
      first.chart.name,
      first.chart.dependencyName,
      first.chart.registry,
      first.releaseName,
      first.environment,
      first.cluster,
      first.namespace,
      first.workerName,
      ...first.queues,
      ...first.manifests.map(({ name }) => name),
    ];

    expect(names.every((name) => shortName.test(name))).toBe(true);
    expect(first.cluster).not.toBe(second.cluster);
    expect(first.namespace).not.toBe(second.namespace);
    expect(first.chart.name).not.toBe(second.chart.name);
    expect(first.chart.dependencyName).not.toBe(second.chart.dependencyName);
    expect(first.workerName).not.toBe(second.workerName);
    expect(first.queues).not.toEqual(second.queues);
    expect(first.manifests.map(({ name }) => name)).not.toEqual(second.manifests.map(({ name }) => name));
    expect(first.manifests.every(({ name, yaml }) => {
      const metadata = YAML.parse(yaml).metadata;
      return metadata.name === name && metadata.namespace === first.namespace;
    })).toBe(true);
    expect(first.manifests.filter(({ kind }) => kind === "Deployment").every(({ yaml }) =>
      YAML.parse(yaml).spec.template.spec.containers.every(({ name }: { name: string }) => shortName.test(name)),
    )).toBe(true);
    expect(YAML.parse(first.manifests.find(({ id }) => id === "scaledobject")!.yaml).spec.scaleTargetRef.name).toBe(first.workerName);
  });
});
