import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readChartPackage, readValueFile, scenarioFromUploads } from "./chartImport";

function tar(files: Record<string, string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = typeof content === "string" ? encoder.encode(content) : content;
    const header = new Uint8Array(512);
    header.set(encoder.encode(name), 0);
    header.set(encoder.encode(bytes.length.toString(8).padStart(11, "0") + "\0"), 124);
    header[156] = 48;
    chunks.push(header, bytes, new Uint8Array((512 - bytes.length % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function chartFile(name: string, files: Record<string, string | Uint8Array>): File {
  const bytes = gzipSync(tar(files));
  return new File([Uint8Array.from(bytes)], `${name}.tgz`, { type: "application/gzip" });
}

describe("local chart import", () => {
  it("reads a packaged wrapper and its embedded dependency", async () => {
    const child = chartFile("private-runtime-4.20.4", {
      "private-runtime/Chart.yaml": "apiVersion: v2\nname: private-runtime\nversion: 4.20.4\n",
      "private-runtime/values.yaml": "workerDefaults:\n  autoscaling:\n    maxReplicas: 10\n",
    });
    const wrapper = chartFile("private-wrapper-4.14.0", {
      "private-wrapper/Chart.yaml": "apiVersion: v2\nname: private-wrapper\nversion: 4.14.0\ndependencies:\n  - name: private-runtime\n    alias: private-wrapper\n    version: 4.20.4\n",
      "private-wrapper/charts/private-runtime-4.20.4.tgz": new Uint8Array(await child.arrayBuffer()),
    });

    const imported = await readChartPackage(wrapper);
    const scenario = scenarioFromUploads([imported], [], 123);
    expect(imported.embedded[0].name).toBe("private-runtime");
    expect(scenario.chart.version).toBe("4.14.0");
    expect(scenario.chart.dependencyVersion).toBe("4.20.4");
    expect(scenario.mode).toBe("uploaded");
    expect(JSON.stringify(scenario)).not.toContain("private-");
  });

  it("resolves file-scoped YAML merge anchors in uploaded values", async () => {
    const file = new File(["private-wrapper:\n  x-spot: &spot\n    nodeSelector:\n      pool: spot-arm\n  deployment:\n    workers:\n      example-worker:\n        <<: *spot\n        queues: [example-queue]\n"], "values.yaml");
    const layer = await readValueFile(file);
    const scoped = layer.values["private-wrapper"] as Record<string, unknown>;
    const deployment = scoped.deployment as Record<string, unknown>;
    const worker = (deployment.workers as Record<string, unknown>)["example-worker"] as Record<string, unknown>;
    expect(worker.nodeSelector).toEqual({ pool: "spot-arm" });
  });

  it("rejects a dependency package that differs from the wrapper pin", async () => {
    const wrapper = await readChartPackage(chartFile("private-wrapper-4.14.0", {
      "private-wrapper/Chart.yaml": "apiVersion: v2\nname: private-wrapper\nversion: 4.14.0\ndependencies:\n  - name: private-runtime\n    alias: private-wrapper\n    version: 4.20.4\n",
    }));
    const wrongDependency = await readChartPackage(chartFile("private-runtime-4.21.1", {
      "private-runtime/Chart.yaml": "apiVersion: v2\nname: private-runtime\nversion: 4.21.1\n",
    }));

    expect(() => scenarioFromUploads([wrapper, wrongDependency], [], 123)).toThrow("The selected dependency version does not match");
  });

  it("replaces uploaded identifiers in layers, traces, and manifest previews", async () => {
    const wrapper = await readChartPackage(chartFile("private-wrapper", {
      "private-wrapper/Chart.yaml": "apiVersion: v2\nname: private-wrapper\nversion: private-build\ndependencies:\n  - name: private-runtime\n    alias: private-wrapper\n    version: 1.2.3\n",
    }));
    const local = await readValueFile(new File(["private-wrapper:\n  image:\n    repository: private-registry/private-service\n    tag: private-release\n  deployment:\n    workers:\n      private-worker:\n        queues: [private-queue-a, private-queue-b, private-queue-c, private-queue-d]\n"], "private-values.yaml"));
    const scenario = scenarioFromUploads([wrapper], [{ ...local, label: "private-layer", path: "private-path.yaml", note: "private-note" }], 4821);
    expect(JSON.stringify(scenario)).not.toContain("private-");
    expect(scenario.chart.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(scenario.layers.at(-1)?.path).toBe("local/layer-01.yaml");
    expect(scenario.queues).toHaveLength(4);
    expect(scenario.queues.every((queue) => /^[a-z]+-[a-z0-9]{8}$/.test(queue))).toBe(true);
  });

  it("does not quote uploaded names in parse errors", async () => {
    const malformed = new File(["private-resource: [not-closed"], "private-values.yaml");
    await expect(readValueFile(malformed)).rejects.toThrow("Values layer 1 is not valid YAML.");

    const wrapper = chartFile("private-wrapper", {
      "private-wrapper/Chart.yaml": "apiVersion: v2\nname: private-wrapper\nversion: 1.0.0\n",
      "private-wrapper/charts/private-embedded.tgz": "not gzip data",
    });
    await expect(readChartPackage(wrapper)).rejects.toThrow("Embedded chart package is not a valid gzip chart package.");
  });
});
