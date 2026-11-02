import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { PackageSequence, RenderSequence, SyncSequence, ValuesComparison } from "./App";
import { generateScenario } from "./simulation";

describe("application shell", () => {
  it("opens the reusable release screen with a selector for all three update paths", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Choose an update path");
    expect(html).toContain("Reusable chart update");
    expect(html).toContain("Wrapper chart update");
    expect(html).toContain("Git values update");
    expect(html).toContain("Publish a reusable chart");
    expect(html).toContain("Reusable chart release graph");
    expect(html).toContain("EXAMPLE WORKFLOW");
    expect(html).toContain("Reusable chart Git commit");
    expect(html).toContain("Play this path");
    expect(html).toContain("Regenerate");
    expect(html).toContain("Use local files");
    expect(html).not.toContain("Values merge");
  });

  it("shows both YAML sources and the complete merge result in the comparison view", () => {
    const scenario = generateScenario(84012);
    const html = renderToString(<ValuesComparison scenario={scenario} />);

    expect(html).toContain("Chart defaults");
    expect(html).toContain(scenario.chart.dependencyName);
    expect(html).toContain("/values.yaml");
    expect(html).toContain("tag: chart-default");
    expect(html).toContain("files, in order");
    for (const layer of scenario.layers) expect(html).toContain(layer.path);
    expect(html).toContain("REQUEST_TIMEOUT: 120");
    expect(html).toContain("Encrypted values are unavailable");
    expect(html).toContain("Effective values");
    expect(html).toContain(`maxReplicas: ${scenario.maxReplicas}`);
  });

  it("uses the same source YAML in the packaging animation and its result", () => {
    const scenario = generateScenario(84012);
    const html = renderToString(<PackageSequence scenario={scenario} />);

    expect(html).toContain("WRAPPER SOURCE");
    expect(html).toContain("OCI DEPENDENCY");
    expect(html).toContain("PACKAGED WRAPPER");
    expect(html).toContain(`${scenario.chart.name}-${scenario.chart.version}.tgz`);
    expect(html).toContain("version: …");
    expect(html).toContain("tag: …");
    expect(html.match(/apiVersion: v2/g)).toHaveLength(3);
    expect(html.match(/tag: chart-default/g)).toHaveLength(2);
  });

  it("starts the values animation with the chart default before the later file arrives", () => {
    const scenario = generateScenario(84012);
    const html = renderToString(<ValuesComparison scenario={scenario} animate />);

    expect(html).toContain("Watch a later image tag replace the chart default");
    expect(html).toContain("image-tag-value.yaml");
    expect(html.match(/tag: chart-default/g)).toHaveLength(2);
    expect(html).toContain(`tag: &quot;${scenario.image.split(":").at(-1)}&quot;`);
  });

  it("shows separate repository and tag destinations in the rendered image", () => {
    const scenario = generateScenario(84012);
    const html = renderToString(<RenderSequence scenario={scenario} />);

    expect(html).toContain("Illustrative Helm expression");
    expect(html).toContain(".Values.image.tag");
    expect(html).toContain("Rendered Deployment");
    expect(html).toContain("image: ");
    const visibleText = html.replace(/<[^>]+>/g, "");
    expect(visibleText).toContain("image: …:…");
    expect(visibleText).toContain(scenario.image.slice(0, scenario.image.lastIndexOf(":")));
  });

  it("shows the desired manifest and a pending simulated cluster resource", () => {
    const scenario = generateScenario(84012);
    const html = renderToString(<SyncSequence scenario={scenario} />);

    expect(html).toContain("Rendered Deployment");
    expect(html).toContain("Simulated cluster resource");
    expect(html).toContain("# Awaiting desired resource");
    expect(html).toContain("name: …");
    expect(html).toContain(scenario.manifests[0].name);
  });
});
