import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import YAML from "yaml";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileArchive,
  FileCode2,
  FileText,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Upload,
  Workflow,
  X,
} from "lucide-react";
import { readChartPackage, readValueFile, scenarioFromUploads } from "./chartImport";
import { JOURNEYS, PATH_ORDER, type GraphNode, type Journey, type NodeId, type Tone, type UpdatePath } from "./journeys";
import { freshSeed, generateScenario, type Scenario, type ValueLayer } from "./simulation";

const WORLD_WIDTH = 1510;
const PACKAGE_TIMELINE = {
  showWrapper: 60,
  wrapperLineStart: 1800,
  wrapperLineMove: 1860,
  wrapperLineArrive: 2760,
  clearWrapper: 3660,
  showDependency: 4160,
  dependencyLineStart: 5960,
  dependencyLineMove: 6020,
  dependencyLineArrive: 6920,
  morph: 7820,
  showSummary: 8750,
  settle: 11150,
  done: 11950,
} as const;
const PACKAGE_STAGE_DURATION = PACKAGE_TIMELINE.done + 480;
const MERGE_STAGE_DURATION = 4800;
const RENDER_ARC_DURATION = 820;
const RENDER_TIMELINE = {
  repositoryToTemplate: 700,
  repositoryToOutput: 1660,
  repositoryArrive: 2520,
  tagToTemplate: 2700,
  tagToOutput: 3660,
  tagArrive: 4520,
} as const;
const RENDER_STAGE_DURATION = RENDER_TIMELINE.tagArrive + 680;
const SYNC_STAGE_DURATION = 3400;

const EDGE_COLORS: Record<Tone, string> = {
  chart: "#ffad69",
  values: "#8cc4fb",
  manifest: "#bda8fc",
  sync: "#71dec1",
};

const ARRIVAL_DELAY: Partial<Record<NodeId, number>> = {
  dependencyBuild: 650,
  dependency: 650,
  artifact: 750,
  wrapperPublished: 700,
  merge: 760,
  effective: 1850,
  render: 700,
  manifests: 1680,
  cluster: 720,
};

function appliedLayerCount(scenario: Scenario): number {
  return scenario.layers.filter((layer) => !layer.encrypted && Object.keys(layer.values).length > 0).length;
}

function nodeName(id: NodeId, scenario: Scenario): string {
  switch (id) {
    case "dependencySource": return scenario.chart.dependencyName;
    case "dependencyBuild": return "Validate and package";
    case "wrapper": return scenario.chart.name;
    case "dependency": return scenario.chart.dependencyName;
    case "wrapperPublished": return `${scenario.chart.name}-${scenario.chart.version}.tgz`;
    case "values": return `${scenario.layers.length} ordered files`;
    case "artifact": return scenario.chart.name;
    case "merge": return "Layer in order";
    case "render": return "Templates + values";
    case "effective": return "Effective values";
    case "manifests": return `${scenario.manifests.length} YAML resources`;
    case "cluster": return scenario.cluster;
  }
}

function nodeNote(id: NodeId, scenario: Scenario): string {
  switch (id) {
    case "dependencySource": return `v${scenario.chart.dependencyVersion} · templates and defaults`;
    case "dependencyBuild": return "Lint · package · push";
    case "wrapper": return `v${scenario.chart.version} · declares the dependency`;
    case "dependency": return `v${scenario.chart.dependencyVersion} · published to OCI`;
    case "wrapperPublished": return `v${scenario.chart.version} · includes both charts`;
    case "values": return `${appliedLayerCount(scenario)} applied in sequence`;
    case "artifact": return `v${scenario.chart.version} · includes both charts`;
    case "merge": return "Maps merge. Later files win.";
    case "render": return "One chart + one final values set";
    case "effective": return `${scenario.queues.length} queues · max ${scenario.maxReplicas} replicas`;
    case "manifests": return "Desired Kubernetes resources";
    case "cluster": return `Controller → cluster · simulated`;
  }
}

function GraphNodeButton({ node, scenario, stage, stepCount, selected, onSelect }: {
  node: GraphNode;
  scenario: Scenario;
  stage: number;
  stepCount: number;
  selected: boolean;
  onSelect: (id: NodeId) => void;
}) {
  const ready = stage >= node.step;
  const arriving = ready && node.step > 0 && stage === node.step;
  const Icon = node.icon;
  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    animationDelay: arriving ? `${ARRIVAL_DELAY[node.id] ?? 0}ms` : undefined,
  };

  return <button
    type="button"
    className={`graph-node node-${node.tone} node-${node.id} ${ready ? "is-ready" : "is-waiting"} ${arriving ? "is-arriving" : ""} ${selected ? "is-selected" : ""}`}
    style={style}
    onClick={() => onSelect(node.id)}
    aria-pressed={selected}
    aria-label={`${node.label}${node.location ? `, example location ${node.location}` : ""}: ${ready ? nodeName(node.id, scenario) : `opens at step ${node.step + 1}`}`}
  >
    <span className="node-heading"><span className="node-icon"><Icon size={18} strokeWidth={1.9} /></span><span>{node.label}</span><span className="node-open"><ArrowRight size={14} /></span>{node.location && <span className="node-location">{node.location}</span>}</span>
    <strong className="node-name">{ready ? nodeName(node.id, scenario) : "Waiting for inputs"}</strong>
    <span className="node-note">{ready ? nodeNote(node.id, scenario) : `Step ${node.step + 1} of ${stepCount}`}</span>
    {ready && node.id === "values" && <span className="mini-files">{scenario.layers.slice(0, 3).map((layer, index) => <span key={layer.id}><i>{index + 1}</i>{layer.label}</span>)}</span>}
    {ready && node.id === "merge" && <span className="mini-rule"><span>maps</span><span>scalars</span><span>lists</span></span>}
    {ready && node.id === "effective" && <span className="mini-result"><span>image tag</span><b>{scenario.image.split(":").at(-1)}</b></span>}
    {ready && node.id === "manifests" && <span className="mini-resources">{scenario.manifests.slice(0, 2).map((manifest) => <span key={manifest.id}><i />{manifest.kind} <b>{manifest.name}</b></span>)}</span>}
    {ready && node.id === "cluster" && <span className="cluster-namespace">{scenario.namespace}</span>}
  </button>;
}

type PackageScene = "opening" | "wrapper" | "between" | "dependency" | "morphing" | "summary" | "settling" | "done";
type FlyingLine = { text: string; x: number; y: number; dx: number; dy: number; moving: boolean };
type ArcFlight = { field: "repository" | "tag"; leg: "template" | "output"; text: string; path: string };

function measureFlyingLine(container: HTMLElement | null, from: HTMLElement | null, to: HTMLElement | null, text: string): FlyingLine | null {
  const overlay = container?.getBoundingClientRect();
  const source = from?.getClientRects()[0];
  const target = to?.getClientRects()[0];
  if (!container || !overlay || !source || !target) return null;
  const scale = overlay.width / container.offsetWidth;
  return {
    text,
    x: (source.left - overlay.left) / scale,
    y: (source.top - overlay.top) / scale,
    dx: (target.left - source.left) / scale,
    dy: (target.top - source.top) / scale,
    moving: false,
  };
}

function measureArcPath(container: HTMLElement | null, from: HTMLElement | null, to: HTMLElement | null): string | null {
  const overlay = container?.getBoundingClientRect();
  const source = from?.getClientRects()[0];
  const target = to?.getClientRects()[0];
  if (!container || !overlay || !source || !target) return null;
  const scale = overlay.width / container.offsetWidth;
  const x1 = (source.left - overlay.left) / scale;
  const y1 = (source.top - overlay.top) / scale;
  const x2 = (target.left - overlay.left) / scale;
  const y2 = (target.top - overlay.top) / scale;
  const dx = x2 - x1;
  const lift = Math.max(55, Math.min(95, Math.abs(dx) * .16));
  const bow = Math.abs(dx) < 100 ? 70 : 0;
  return `M ${x1} ${y1} C ${x1 + dx * .35 + bow} ${y1 - lift} ${x1 + dx * .65 + bow} ${y2 - lift} ${x2} ${y2}`;
}

function revealCodeLine(line: HTMLElement | null) {
  const scroller = line?.closest("pre");
  if (!line || !scroller) return;
  const lineRect = line.getBoundingClientRect();
  const paneRect = scroller.getBoundingClientRect();
  if (lineRect.top >= paneRect.top + 12 && lineRect.bottom <= paneRect.bottom - 12) return;
  scroller.scrollTop += lineRect.top - paneRect.top - scroller.clientHeight / 2;
}

function revealCodeFragment(fragment: HTMLElement | null) {
  const scroller = fragment?.closest("pre");
  if (!fragment || !scroller) return;
  const fragmentRect = fragment.getBoundingClientRect();
  const paneRect = scroller.getBoundingClientRect();
  if (fragmentRect.right > paneRect.right - 15) scroller.scrollLeft += fragmentRect.right - paneRect.right + 30;
  else if (fragmentRect.left < paneRect.left + 15) scroller.scrollLeft += fragmentRect.left - paneRect.left - 30;
}

function FlyingYamlLine({ line, tone = "chart" }: { line: FlyingLine; tone?: Tone }) {
  return <span className={`yaml-flying-line flight-${tone}`} style={{ left: line.x, top: line.y, transform: line.moving ? `translate(${line.dx}px, ${line.dy}px)` : undefined }}>{line.text}</span>;
}

function ArcYamlFlight({ flight }: { flight: ArcFlight }) {
  return <span className="yaml-arc-flight" style={{ offsetPath: `path("${flight.path}")`, animationDuration: `${RENDER_ARC_DURATION}ms` }} aria-hidden="true">{flight.text}</span>;
}

function YamlLines({ lines, focusIndex, focusRef, tone = "chart" }: { lines: string[]; focusIndex: number; focusRef?: RefObject<HTMLSpanElement | null>; tone?: Tone }) {
  return <pre><code>{lines.map((line, index) => <Fragment key={index}><span ref={index === focusIndex ? focusRef : undefined} className={index === focusIndex ? `yaml-code-focus focus-${tone}` : undefined}>{line}</span>{"\n"}</Fragment>)}</code></pre>;
}

export function PackageSequence({ scenario }: { scenario: Scenario }) {
  const [scene, setScene] = useState<PackageScene>("opening");
  const [wrapperCopied, setWrapperCopied] = useState(false);
  const [dependencyCopied, setDependencyCopied] = useState(false);
  const [flyingLine, setFlyingLine] = useState<FlyingLine | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const wrapperSourceLine = useRef<HTMLSpanElement>(null);
  const wrapperTargetLine = useRef<HTMLSpanElement>(null);
  const dependencySourceLine = useRef<HTMLSpanElement>(null);
  const dependencyTargetLine = useRef<HTMLSpanElement>(null);
  const wrapperLines = scenario.chartFile.trimEnd().split("\n");
  const dependencyLines = scenario.dependencyValuesFile.trimEnd().split("\n");
  const versionIndex = wrapperLines.findIndex((line) => line.startsWith("version: "));
  const tagIndex = dependencyLines.findIndex((line) => /^\s+tag: /.test(line));
  const wrapperDraft = wrapperLines.map((line, index) => index === versionIndex && !wrapperCopied ? line.replace(/(: ).*$/, "$1…") : line);
  const dependencyDraft = dependencyLines.map((line, index) => index === tagIndex && !dependencyCopied ? line.replace(/(: ).*$/, "$1…") : line);

  useEffect(() => {
    function startLineTransfer(from: RefObject<HTMLSpanElement | null>, to: RefObject<HTMLSpanElement | null>, text: string) {
      setFlyingLine(measureFlyingLine(overlayRef.current, from.current, to.current, text));
    }

    const timers = [
      window.setTimeout(() => setScene("wrapper"), PACKAGE_TIMELINE.showWrapper),
      window.setTimeout(() => startLineTransfer(wrapperSourceLine, wrapperTargetLine, wrapperLines[versionIndex]), PACKAGE_TIMELINE.wrapperLineStart),
      window.setTimeout(() => setFlyingLine((line) => line ? { ...line, moving: true } : null), PACKAGE_TIMELINE.wrapperLineMove),
      window.setTimeout(() => { setWrapperCopied(true); setFlyingLine(null); }, PACKAGE_TIMELINE.wrapperLineArrive),
      window.setTimeout(() => setScene("between"), PACKAGE_TIMELINE.clearWrapper),
      window.setTimeout(() => setScene("dependency"), PACKAGE_TIMELINE.showDependency),
      window.setTimeout(() => startLineTransfer(dependencySourceLine, dependencyTargetLine, dependencyLines[tagIndex]), PACKAGE_TIMELINE.dependencyLineStart),
      window.setTimeout(() => setFlyingLine((line) => line ? { ...line, moving: true } : null), PACKAGE_TIMELINE.dependencyLineMove),
      window.setTimeout(() => { setDependencyCopied(true); setFlyingLine(null); }, PACKAGE_TIMELINE.dependencyLineArrive),
      window.setTimeout(() => setScene("morphing"), PACKAGE_TIMELINE.morph),
      window.setTimeout(() => setScene("summary"), PACKAGE_TIMELINE.showSummary),
      window.setTimeout(() => setScene("settling"), PACKAGE_TIMELINE.settle),
      window.setTimeout(() => setScene("done"), PACKAGE_TIMELINE.done),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [scenario.seed]);

  if (scene === "done") return null;

  return <div ref={overlayRef} className={`package-sequence scene-${scene}`} aria-hidden="true">
    <div className="package-preview package-transfer-card package-wrapper-card package-wrapper-source">
      <div className="package-preview-heading"><span>WRAPPER SOURCE</span><strong>{scenario.chart.name}</strong><small>Chart.yaml · the declared chart version</small></div>
      <YamlLines lines={wrapperLines} focusIndex={versionIndex} focusRef={wrapperSourceLine} />
    </div>
    <div className="package-preview package-transfer-card package-wrapper-card package-wrapper-target">
      <div className="package-preview-heading"><span>PACKAGED COPY</span><strong>Chart.yaml</strong><small>The version line is copied into the artifact.</small></div>
      <YamlLines lines={wrapperDraft} focusIndex={versionIndex} focusRef={wrapperTargetLine} />
    </div>
    <div className="package-preview package-transfer-card package-dependency-card package-dependency-source">
      <div className="package-preview-heading"><span>OCI DEPENDENCY</span><strong>{scenario.chart.dependencyName}</strong><small>values.yaml · dependency defaults</small></div>
      <YamlLines lines={dependencyLines} focusIndex={tagIndex} focusRef={dependencySourceLine} />
    </div>
    <div className="package-preview package-transfer-card package-dependency-card package-dependency-target">
      <div className="package-preview-heading"><span>PACKAGED COPY</span><strong>charts/{scenario.chart.dependencyName}/values.yaml</strong><small>The default image tag is copied into the artifact.</small></div>
      <YamlLines lines={dependencyDraft} focusIndex={tagIndex} focusRef={dependencyTargetLine} />
    </div>
    <div className="package-preview package-summary">
      <div className="package-preview-heading"><span><FileArchive size={16} /> PACKAGED WRAPPER</span><strong>{`${scenario.chart.name}-${scenario.chart.version}.tgz`}</strong><small>The archive contains both charts. Git values are applied later by Argo CD.</small></div>
      <div className="package-output-files">
        <div><span>Chart.yaml</span><pre><code>{scenario.chartFile}</code></pre></div>
        <div><span>charts/{scenario.chart.dependencyName}/values.yaml</span><pre><code>{scenario.dependencyValuesFile}</code></pre></div>
      </div>
    </div>
    {flyingLine && <FlyingYamlLine line={flyingLine} />}
  </div>;
}

function GraphCanvas({ scenario, journey, path, stage, selectedNode, onSelect, zoom, viewportRef, onPointerDown, onPointerMove, onPointerUp, dragging }: {
  scenario: Scenario;
  journey: Journey;
  path: UpdatePath;
  stage: number;
  selectedNode: NodeId | null;
  onSelect: (id: NodeId) => void;
  zoom: number;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  dragging: boolean;
}) {
  const layerCount = appliedLayerCount(scenario);

  return <><div className="flow-context" role="note" aria-label="Example workflow locations">
    <span className="flow-context-intro"><strong>EXAMPLE WORKFLOW</strong><small>Steps can run elsewhere</small></span>
    <span className="flow-context-path">
      {journey.contextSteps.map((item, index) => <span className="flow-context-step" key={`${item.place}-${index}`}>{index > 0 && <ArrowRight size={14} />}<b>{item.place}</b>{item.action}</span>)}
    </span>
  </div><div
    className={`graph-viewport path-${path} ${dragging ? "is-dragging" : ""}`}
    ref={viewportRef}
    role="region"
    aria-label={journey.graphLabel}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
  >
    <div className="graph-space" style={{ width: WORLD_WIDTH * zoom, height: journey.worldHeight * zoom }}>
      <div className="graph-world" style={{ width: WORLD_WIDTH, height: journey.worldHeight, transform: `scale(${zoom})` }}>
        {journey.zones.map((zone, index) => <div className="zone-title" key={zone.title} style={{ left: zone.x }}>{String(index + 1).padStart(2, "0")} <span>{zone.title}</span></div>)}
        {journey.rules.map((x) => <div className="zone-rule" key={x} style={{ left: x }} />)}
        <svg className="graph-lines" width={WORLD_WIDTH} height={journey.worldHeight} viewBox={`0 0 ${WORLD_WIDTH} ${journey.worldHeight}`} aria-hidden="true">
          <defs>
            <marker id="arrow-idle" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L8 4.5 L1 8" fill="none" stroke="#53647b" strokeWidth="1.8" /></marker>
            {(Object.keys(EDGE_COLORS) as Tone[]).map((tone) => <marker key={tone} id={`arrow-${tone}`} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L8 4.5 L1 8" fill="none" stroke={EDGE_COLORS[tone]} strokeWidth="1.8" /></marker>)}
          </defs>
          {journey.edges.map((edge) => <path key={edge.id} d={edge.d} className={`graph-link ${stage >= edge.step ? "is-active" : ""}`} stroke={stage >= edge.step ? EDGE_COLORS[edge.tone] : "#53647b"} markerEnd={`url(#arrow-${stage >= edge.step ? edge.tone : "idle"})`} />)}
        </svg>
        {journey.edges.filter((edge) => edge.step === stage).flatMap((edge) => {
          const count = edge.id === "values-merge" ? Math.min(layerCount, 6) : 1;
          return Array.from({ length: count }, (_, index) => <span
            key={`${scenario.seed}-${stage}-${edge.id}-${index}`}
            className={`flow-packet packet-${edge.tone} ${count > 1 ? "packet-number" : ""}`}
            style={{
              offsetPath: `path("${edge.d}")`,
              animationDelay: `${(edge.delay ?? 0) + index * 120}ms`,
              backgroundColor: EDGE_COLORS[edge.tone],
            }}
            aria-hidden="true"
          >{count > 1 ? String(index + 1).padStart(2, "0") : edge.packet}</span>);
        })}
        {journey.nodes.map((node) => <GraphNodeButton key={node.id} node={node} scenario={scenario} stage={stage} stepCount={journey.stages.length} selected={selectedNode === node.id} onSelect={onSelect} />)}
        {path === "wrapper" && stage === 1 && <PackageSequence key={scenario.seed} scenario={scenario} />}
      </div>
    </div>
  </div></>;
}

function CodeSample({ title, content }: { title: string; content: string }) {
  return <div className="detail-code"><div><FileCode2 size={14} />{title}</div><pre><code>{content.trim()}</code></pre></div>;
}

function layerYaml(layer: ValueLayer): string {
  if (layer.encrypted) return "# Encrypted values are unavailable in this browser preview.\n";
  if (!Object.keys(layer.values).length) return "# This file adds no values.\n{}\n";
  return YAML.stringify(layer.values, { lineWidth: 0 });
}

export function ValuesComparison({ scenario, animate = false }: { scenario: Scenario; animate?: boolean }) {
  const tagSource = scenario.changes.find((change) => change.path === "image.tag")?.source;
  const tagLayerIndex = scenario.layers.findIndex((layer) => layer.path === tagSource);
  const sourceLines = tagLayerIndex >= 0 ? layerYaml(scenario.layers[tagLayerIndex]).trimEnd().split("\n") : [];
  const sourceTagIndex = sourceLines.findIndex((line) => /^\s+tag: /.test(line));
  const defaultLines = scenario.dependencyValuesFile.trimEnd().split("\n");
  const defaultTagIndex = defaultLines.findIndex((line) => /^\s+tag: /.test(line));
  const resultLines = scenario.valuesFile.trimEnd().split("\n");
  const resultTagIndex = resultLines.findIndex((line) => /^\s+tag: /.test(line));
  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const canAnimate = animate && !reducedMotion && sourceTagIndex >= 0 && defaultTagIndex >= 0 && resultTagIndex >= 0;
  const [selectedLayer, setSelectedLayer] = useState(canAnimate ? tagLayerIndex : -1);
  const [tagArrived, setTagArrived] = useState(!canAnimate);
  const [interrupted, setInterrupted] = useState(false);
  const [flyingLine, setFlyingLine] = useState<FlyingLine | null>(null);
  const comparisonRef = useRef<HTMLElement>(null);
  const sourceLineRef = useRef<HTMLSpanElement>(null);
  const resultLineRef = useRef<HTMLSpanElement>(null);
  const resultDraft = resultLines.map((line, index) => index === resultTagIndex && !tagArrived ? defaultLines[defaultTagIndex] : line);
  const gitYaml = selectedLayer < 0
    ? scenario.layers.map((layer, index) => `# ${String(index + 1).padStart(2, "0")} ${layer.path}\n${layerYaml(layer)}`).join("---\n")
    : layerYaml(scenario.layers[selectedLayer]);
  const gitLines = gitYaml.trimEnd().split("\n");

  useEffect(() => {
    if (!canAnimate || interrupted) return;
    const timers = [
      window.setTimeout(() => setFlyingLine(measureFlyingLine(comparisonRef.current, sourceLineRef.current, resultLineRef.current, sourceLines[sourceTagIndex])), 1200),
      window.setTimeout(() => setFlyingLine((line) => line ? { ...line, moving: true } : null), 1260),
      window.setTimeout(() => { setTagArrived(true); setFlyingLine(null); }, 2160),
      window.setTimeout(() => setSelectedLayer(-1), 3500),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [canAnimate, interrupted, scenario.seed]);

  function chooseLayer(index: number) {
    setInterrupted(true);
    setTagArrived(true);
    setFlyingLine(null);
    setSelectedLayer(index);
  }

  return <section ref={comparisonRef} className="values-comparison" aria-label="Values YAML comparison">
    <div className="values-comparison-intro">
      <div><span className="eyebrow">THE VALUES THAT MERGE</span><h3>Source YAML → effective YAML</h3><p>{canAnimate && !tagArrived ? "Watch a later image tag replace the chart default in the effective values." : "Files under the chart alias merge with dependency defaults in order. Empty and encrypted files add nothing in this preview."}</p></div>
      {scenario.uploadNote && <p className="values-upload-note">{scenario.uploadNote}</p>}
    </div>
    <div className="values-panes">
      <article className="values-pane">
        <div className="values-pane-heading"><span>01 / CHART SOURCE</span><h4>Chart defaults</h4><small>{scenario.chart.dependencyName}/values.yaml</small></div>
        <YamlLines lines={defaultLines} focusIndex={canAnimate ? defaultTagIndex : -1} />
      </article>
      <article className="values-pane">
        <div className="values-pane-heading"><span>02 / VALUES SOURCE</span><h4>Ordered values files</h4><label className="values-file-picker"><span className="sr-only">Choose values file</span><select aria-label="Choose values file" value={selectedLayer} onChange={(event) => chooseLayer(Number(event.target.value))}><option value={-1}>All {scenario.layers.length} files, in order</option>{scenario.layers.map((layer, index) => <option key={layer.id} value={index}>{String(index + 1).padStart(2, "0")} · {layer.path}</option>)}</select></label></div>
        <YamlLines lines={gitLines} focusIndex={selectedLayer === tagLayerIndex && canAnimate ? sourceTagIndex : -1} focusRef={sourceLineRef} tone="values" />
      </article>
      <article className="values-pane values-pane-result">
        <div className="values-pane-heading"><span>03 / MERGE RESULT</span><h4>Effective values</h4><small>Complete dependency values after merge</small></div>
        <YamlLines lines={resultDraft} focusIndex={canAnimate ? resultTagIndex : -1} focusRef={resultLineRef} tone="sync" />
      </article>
    </div>
    {flyingLine && <FlyingYamlLine line={flyingLine} tone="values" />}
  </section>;
}

export function RenderSequence({ scenario }: { scenario: Scenario }) {
  const manifest = scenario.manifests.find((item) => item.id === "webapp") ?? scenario.manifests[0];
  const sourceLines = scenario.valuesFile.trimEnd().split("\n");
  const repositoryIndex = sourceLines.findIndex((line) => /^\s+repository: /.test(line));
  const tagIndex = sourceLines.findIndex((line) => /^\s+tag: /.test(line));
  const manifestLines = manifest.yaml.trimEnd().split("\n");
  const imageIndex = manifestLines.findIndex((line) => /^\s+image: /.test(line));
  const templateLines = manifestLines.map((line, index) => index === imageIndex ? line.replace(/image: .*$/, 'image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"') : line);
  const templateImageLine = templateLines[imageIndex] ?? "";
  const repositoryExpression = ".Values.image.repository";
  const tagExpression = ".Values.image.tag";
  const repositoryExpressionIndex = templateImageLine.indexOf(repositoryExpression);
  const tagExpressionIndex = templateImageLine.indexOf(tagExpression);
  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const canAnimate = !reducedMotion && repositoryIndex >= 0 && tagIndex >= 0 && imageIndex >= 0 && repositoryExpressionIndex >= 0 && tagExpressionIndex >= 0;
  const [repositoryArrived, setRepositoryArrived] = useState(!canAnimate);
  const [tagArrived, setTagArrived] = useState(!canAnimate);
  const [arcFlight, setArcFlight] = useState<ArcFlight | null>(null);
  const [activeTemplateField, setActiveTemplateField] = useState<ArcFlight["field"] | null>(null);
  const comparisonRef = useRef<HTMLElement>(null);
  const sourceRepositoryRef = useRef<HTMLSpanElement>(null);
  const sourceTagRef = useRef<HTMLSpanElement>(null);
  const templateLineRef = useRef<HTMLSpanElement>(null);
  const templateRepositoryRef = useRef<HTMLSpanElement>(null);
  const templateTagRef = useRef<HTMLSpanElement>(null);
  const resultRepositoryRef = useRef<HTMLSpanElement>(null);
  const resultTagRef = useRef<HTMLSpanElement>(null);
  const repository = scenario.image.slice(0, scenario.image.lastIndexOf(":"));
  const tag = scenario.image.slice(scenario.image.lastIndexOf(":") + 1);
  const imagePrefix = manifestLines[imageIndex]?.match(/^(\s*image:\s*)/)?.[1] ?? "";

  useEffect(() => {
    revealCodeLine(templateLineRef.current);
    revealCodeLine(resultRepositoryRef.current);
    if (!canAnimate) return;
    function launch(field: ArcFlight["field"], leg: ArcFlight["leg"], from: HTMLElement | null, to: HTMLElement | null, text: string) {
      const path = measureArcPath(comparisonRef.current, from, to);
      setArcFlight(path ? { field, leg, text, path } : null);
    }
    const timers = [
      window.setTimeout(() => {
        revealCodeFragment(templateRepositoryRef.current);
        setActiveTemplateField("repository");
        launch("repository", "template", sourceRepositoryRef.current, templateRepositoryRef.current, repository);
      }, RENDER_TIMELINE.repositoryToTemplate),
      window.setTimeout(() => {
        revealCodeFragment(resultRepositoryRef.current);
        launch("repository", "output", templateRepositoryRef.current, resultRepositoryRef.current, repository);
      }, RENDER_TIMELINE.repositoryToOutput),
      window.setTimeout(() => { setRepositoryArrived(true); setArcFlight(null); setActiveTemplateField(null); }, RENDER_TIMELINE.repositoryArrive),
      window.setTimeout(() => {
        revealCodeFragment(templateTagRef.current);
        setActiveTemplateField("tag");
        launch("tag", "template", sourceTagRef.current, templateTagRef.current, tag);
      }, RENDER_TIMELINE.tagToTemplate),
      window.setTimeout(() => {
        revealCodeFragment(resultTagRef.current);
        launch("tag", "output", templateTagRef.current, resultTagRef.current, tag);
      }, RENDER_TIMELINE.tagToOutput),
      window.setTimeout(() => { setTagArrived(true); setArcFlight(null); setActiveTemplateField(null); }, RENDER_TIMELINE.tagArrive),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [scenario.seed, canAnimate]);

  return <section ref={comparisonRef} className="values-comparison render-sequence" aria-label="Render YAML transformation">
    <div className="values-comparison-intro"><div><span className="eyebrow">TEMPLATE RENDER</span><h3>Values → template → manifest</h3><p>The illustrative template reads the merged image repository and tag and writes both into the rendered Deployment.</p></div>{scenario.uploadNote && <p className="values-upload-note">{scenario.uploadNote}</p>}</div>
    <div className="values-panes">
      <article className="values-pane"><div className="values-pane-heading"><span>01 / INPUT</span><h4>Effective values</h4><small>After all ordered files</small></div><pre><code>{sourceLines.map((line, index) => {
        if (index !== repositoryIndex && index !== tagIndex) return <Fragment key={index}>{line}{"\n"}</Fragment>;
        const valueStart = line.match(/^\s*\w+:\s*/)?.[0].length ?? line.indexOf(":") + 1;
        return <Fragment key={index}>{line.slice(0, valueStart)}<span ref={index === repositoryIndex ? sourceRepositoryRef : sourceTagRef} className="yaml-code-focus focus-values">{line.slice(valueStart)}</span>{"\n"}</Fragment>;
      })}</code></pre></article>
      <article className="values-pane"><div className="values-pane-heading"><span>02 / TEMPLATE</span><h4>Deployment template</h4><small>Illustrative Helm expression</small></div><pre><code>{templateLines.map((line, index) => {
        if (index !== imageIndex || repositoryExpressionIndex < 0 || tagExpressionIndex < 0) return <Fragment key={index}><span>{line}</span>{"\n"}</Fragment>;
        return <Fragment key={index}><span ref={templateLineRef} className="yaml-code-focus focus-manifest">{line.slice(0, repositoryExpressionIndex)}<span ref={templateRepositoryRef} className={`template-expression ${activeTemplateField === "repository" ? "is-active" : ""}`}>{repositoryExpression}</span>{line.slice(repositoryExpressionIndex + repositoryExpression.length, tagExpressionIndex)}<span ref={templateTagRef} className={`template-expression ${activeTemplateField === "tag" ? "is-active" : ""}`}>{tagExpression}</span>{line.slice(tagExpressionIndex + tagExpression.length)}</span>{"\n"}</Fragment>;
      })}</code></pre></article>
      <article className="values-pane values-pane-result"><div className="values-pane-heading"><span>03 / OUTPUT</span><h4>Rendered Deployment</h4><small>{manifest.name}</small></div><pre><code>{manifestLines.map((line, index) => index === imageIndex
        ? <Fragment key={index}><span className="yaml-code-focus focus-sync">{imagePrefix}<span ref={resultRepositoryRef}>{repositoryArrived ? repository : "…"}</span>:<span ref={resultTagRef}>{tagArrived ? tag : "…"}</span></span>{"\n"}</Fragment>
        : <Fragment key={index}>{line}{"\n"}</Fragment>)}</code></pre></article>
    </div>
    {arcFlight && <ArcYamlFlight key={`${arcFlight.field}-${arcFlight.leg}`} flight={arcFlight} />}
  </section>;
}

export function SyncSequence({ scenario }: { scenario: Scenario }) {
  const manifest = scenario.manifests.find((item) => item.id === "webapp") ?? scenario.manifests[0];
  const manifestLines = manifest.yaml.trimEnd().split("\n");
  const nameIndex = manifestLines.findIndex((line) => /^\s+name: /.test(line));
  const pendingLines = ["# Awaiting desired resource", `kind: ${manifest.kind}`, "metadata:", "  name: …"];
  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const canAnimate = !reducedMotion && nameIndex >= 0;
  const [applied, setApplied] = useState(!canAnimate);
  const [flyingLine, setFlyingLine] = useState<FlyingLine | null>(null);
  const comparisonRef = useRef<HTMLElement>(null);
  const sourceLineRef = useRef<HTMLSpanElement>(null);
  const targetLineRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!canAnimate) return;
    const timers = [
      window.setTimeout(() => setFlyingLine(measureFlyingLine(comparisonRef.current, sourceLineRef.current, targetLineRef.current, manifestLines[nameIndex])), 1300),
      window.setTimeout(() => setFlyingLine((line) => line ? { ...line, moving: true } : null), 1360),
      window.setTimeout(() => { setApplied(true); setFlyingLine(null); }, 2260),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [scenario.seed, canAnimate]);

  return <section ref={comparisonRef} className="values-comparison sync-sequence" aria-label="Argo CD sync YAML transformation">
    <div className="values-comparison-intro"><div><span className="eyebrow">ARGO CD SYNC</span><h3>Desired resource → simulated cluster</h3><p>Argo CD applies complete resources. The name line identifies this representative Deployment as its YAML appears in the simulated cluster state.</p></div></div>
    <div className="values-panes">
      <article className="values-pane"><div className="values-pane-heading"><span>01 / DESIRED</span><h4>Rendered Deployment</h4><small>{manifest.name}</small></div><YamlLines lines={manifestLines} focusIndex={nameIndex} focusRef={sourceLineRef} tone="manifest" /></article>
      <article className="values-pane values-pane-result"><div className="values-pane-heading"><span>02 / APPLIED PREVIEW</span><h4>Simulated cluster resource</h4><small>{scenario.cluster} / {scenario.namespace}</small></div><YamlLines lines={applied ? manifestLines : pendingLines} focusIndex={applied ? nameIndex : 3} focusRef={targetLineRef} tone="sync" /></article>
    </div>
    {flyingLine && <FlyingYamlLine line={flyingLine} tone="sync" />}
  </section>;
}

function NodeDetail({ id, journey, path, scenario, close, selectedManifest, setSelectedManifest, copied, onCopy, onDownload }: {
  id: NodeId;
  journey: Journey;
  path: UpdatePath;
  scenario: Scenario;
  close: () => void;
  selectedManifest: number;
  setSelectedManifest: (index: number) => void;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
}) {
  const node = journey.nodes.find((item) => item.id === id)!;
  const manifest = scenario.manifests[selectedManifest];
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => { detailRef.current?.focus(); }, [id]);

  function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const controls = Array.from(detailRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])") ?? []);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === detailRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return <section ref={detailRef} className={`node-detail ${id === "artifact" || id === "wrapperPublished" ? "is-package-detail" : ""}`} role="dialog" aria-modal="true" aria-labelledby="node-detail-title" tabIndex={-1} onKeyDown={keepFocusInside}>
    <div className="detail-heading"><div><span className="eyebrow">INSPECT NODE / {node.label.toUpperCase()}</span><h2 id="node-detail-title">{nodeName(id, scenario)}</h2></div><button type="button" onClick={close} aria-label="Close node details"><X size={18} /></button></div>
    {id === "dependencySource" && <><p>This Git chart is maintained independently. Its templates describe resources; its values.yaml supplies defaults for any wrapper that selects a published version.</p><div className="detail-facts"><span>chart <b>{scenario.chart.dependencyName}</b></span><span>version <b>{scenario.chart.dependencyVersion}</b></span></div><div className="dependency-values"><CodeSample title="values.yaml defaults" content={scenario.dependencyValuesFile} /></div></>}
    {id === "dependencyBuild" && <><p>Reusable chart CI validates the chart, packages its templates and defaults, and publishes a versioned artifact. The browser preview models the defaults but does not run this CI job.</p><div className="detail-facts"><span>chart <b>{scenario.chart.dependencyName}</b></span><span>version <b>{scenario.chart.dependencyVersion}</b></span><span>registry <b>{scenario.chart.registry}</b></span></div></>}
    {id === "wrapper" && <><p>In this example, this Git chart declares the reusable dependency under the alias used by the values files.</p><CodeSample title="Chart.yaml" content={scenario.chartFile} /></>}
    {id === "dependency" && <><p>{path === "reusable" ? "This is the reusable chart version published by its own CI. Wrapper CI can fetch it after the wrapper pins this version." : "Wrapper CI fetches this published reusable chart from OCI by version. Its templates and defaults are included in the wrapper package."}</p><div className="detail-facts"><span>chart <b>{scenario.chart.dependencyName}</b></span><span>version <b>{scenario.chart.dependencyVersion}</b></span><span>registry <b>{scenario.chart.registry}</b></span></div><div className="dependency-values"><CodeSample title="values.yaml defaults" content={scenario.dependencyValuesFile} /></div></>}
    {id === "values" && <><p>Argo CD's repo-server reads these Git files from top to bottom for Helm. Empty layers add nothing; encrypted layers stay locked in this browser preview.</p><ol className="detail-layers">{scenario.layers.map((layer) => <li key={layer.id}><span>{layer.label}</span><code>{layer.path}</code><small>{layer.encrypted ? "locked" : Object.keys(layer.values).length ? "applied" : "empty"}</small></li>)}</ol></>}
    {id === "artifact" && <><p>{path === "values" ? "Argo CD fetches this already published wrapper package from OCI. The package contains the selected reusable chart; Git values are applied when Helm renders it." : "Wrapper CI packages the wrapper and its chosen reusable dependency as one versioned chart archive. The next step publishes it to OCI."}</p><div className="detail-facts"><span>artifact <b>{scenario.chart.name}-{scenario.chart.version}.tgz</b></span><span>registry <b>{scenario.chart.registry}</b></span></div><div className="package-detail-files"><CodeSample title="Chart.yaml" content={scenario.chartFile} /><CodeSample title={`charts/${scenario.chart.dependencyName}/values.yaml`} content={scenario.dependencyValuesFile} /></div></>}
    {id === "wrapperPublished" && <><p>CI has published the packaged wrapper to OCI. It contains the chosen reusable dependency. An Argo CD Application pinned to an older chart version will continue using that older version until its reference changes.</p><div className="detail-facts"><span>artifact <b>{scenario.chart.name}-{scenario.chart.version}.tgz</b></span><span>registry <b>{scenario.chart.registry}</b></span></div><div className="package-detail-files"><CodeSample title="Chart.yaml" content={scenario.chartFile} /><CodeSample title={`charts/${scenario.chart.dependencyName}/values.yaml`} content={scenario.dependencyValuesFile} /></div></>}
    {id === "merge" && <><p>In Argo CD's repo-server, Helm layers each values file over the chart defaults in order. The highlighted fields show where the final values came from.</p><div className="detail-traces">{scenario.traces.map((trace) => <div key={trace.path}><small>{trace.path}</small><strong>{trace.before} <ArrowRight size={15} /> {trace.after}</strong><span>{trace.rule} · {trace.source}</span></div>)}</div></>}
    {id === "effective" && <><p>This is the complete values set after Helm merges the ordered files in Argo CD's repo-server. The worker helper fills any missing worker settings when templates render.</p><CodeSample title="Effective values.yaml" content={scenario.valuesFile} /></>}
    {id === "render" && <><p>In Argo CD's repo-server, Helm renders the packaged chart with the merged values. Templates produce the desired Kubernetes objects shown to the right.</p><div className="detail-facts"><span>chart <b>{scenario.chart.name}:{scenario.chart.version}</b></span><span>image <b>{scenario.image}</b></span><span>output <b>{scenario.manifests.length} YAML documents</b></span></div><p className="detail-disclaimer">Manifest generation is illustrative and runs entirely in the browser.</p></>}
    {id === "manifests" && <><p>These desired objects come from the illustrative render in Argo CD's repo-server. Pick one to inspect its YAML.</p><div className="manifest-picker">{scenario.manifests.map((item, index) => <button type="button" key={item.id} className={index === selectedManifest ? "is-current" : ""} onClick={() => setSelectedManifest(index)}>{item.kind}<small>{item.name}</small></button>)}</div><div className="manifest-actions"><span>{manifest.kind} / {manifest.name}</span><button type="button" onClick={onCopy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy YAML"}</button><button type="button" onClick={onDownload}><Download size={15} />Download all</button></div><CodeSample title={`${manifest.kind.toLowerCase()}.yaml`} content={manifest.yaml} /></>}
    {id === "cluster" && <><p>Argo CD's application controller compares the desired manifests with this fictional cluster and applies the difference. The sync shown here is a visual simulation.</p><div className="detail-facts"><span>cluster <b>{scenario.cluster}</b></span><span>namespace <b>{scenario.namespace}</b></span><span>resources <b>{scenario.manifests.length} desired</b></span></div></>}
  </section>;
}

function UploadDrawer({ open, close, onImport }: { open: boolean; close: () => void; onImport: (charts: File[], values: File[]) => Promise<void> }) {
  const [chartFiles, setChartFiles] = useState<File[]>([]);
  const [valueFiles, setValueFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const chartInput = useRef<HTMLInputElement>(null);
  const valuesInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!open) setError(""); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  function moveValue(index: number, direction: -1 | 1) {
    const other = index + direction;
    if (other < 0 || other >= valueFiles.length) return;
    const next = [...valueFiles];
    [next[index], next[other]] = [next[other], next[index]];
    setValueFiles(next);
  }

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await onImport(chartFiles, valueFiles);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read those files.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="upload-drawer" role="dialog" aria-modal="true" aria-labelledby="upload-title">
    <div className="drawer-top"><span className="eyebrow">OPTIONAL LOCAL INPUT</span><button type="button" onClick={close} aria-label="Close upload panel"><X size={19} /></button></div>
    <h2 id="upload-title">Use your own charts</h2>
    <p>Explore a wrapper chart and its dependency using the same graph. Names in the preview stay fictional; selected numeric settings inform the example.</p>
    <div className="upload-group"><strong>Helm chart packages</strong><small>Wrapper chart and optional dependency · .tgz</small><input ref={chartInput} type="file" accept=".tgz,.tar.gz,application/gzip" multiple hidden onChange={(event) => setChartFiles(Array.from(event.target.files ?? []))} /><button type="button" className="pick-button" onClick={() => chartInput.current?.click()}><FileArchive size={17} />{chartFiles.length ? `${chartFiles.length} chart package${chartFiles.length === 1 ? "" : "s"} selected` : "Choose chart packages"}<ArrowRight size={16} /></button>{chartFiles.map((file, index) => <span className="picked-file" key={`${index}-${file.size}`}>Chart package {index + 1} · {Math.ceil(file.size / 1024)} KB</span>)}</div>
    <div className="upload-group"><strong>Values files</strong><small>Optional · applied in the order below</small><input ref={valuesInput} type="file" accept=".yaml,.yml,.encrypted" multiple hidden onChange={(event) => setValueFiles(Array.from(event.target.files ?? []))} /><button type="button" className="pick-button" onClick={() => valuesInput.current?.click()}><FileText size={17} />{valueFiles.length ? `${valueFiles.length} values file${valueFiles.length === 1 ? "" : "s"} selected` : "Choose values files"}<ArrowRight size={16} /></button>{valueFiles.map((file, index) => <span className="picked-file value-picked" key={`${index}-${file.size}`}>Values layer {index + 1}<span><button type="button" disabled={index === 0} onClick={() => moveValue(index, -1)} aria-label={`Move values layer ${index + 1} up`}>↑</button><button type="button" disabled={index === valueFiles.length - 1} onClick={() => moveValue(index, 1)} aria-label={`Move values layer ${index + 1} down`}>↓</button></span></span>)}</div>
    <p className="upload-note">Files stay in this browser session. Encrypted values remain locked. Manifest output is illustrative.</p>
    {error && <p className="upload-error" role="alert">{error}</p>}
    <button type="button" className="import-button" disabled={!chartFiles.length || busy} onClick={() => void submit()}>{busy ? "Reading charts…" : "Explore local sources"}<ArrowRight size={17} /></button>
  </div></div>;
}

export default function App() {
  const [scenario, setScenario] = useState<Scenario>(() => generateScenario(freshSeed()));
  const [path, setPath] = useState<UpdatePath>("reusable");
  const [stage, setStage] = useState(0);
  const [view, setView] = useState<"flow" | "yaml">("flow");
  const [yamlReplay, setYamlReplay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedNode, setSelectedNode] = useState<NodeId | null>(null);
  const [selectedManifest, setSelectedManifest] = useState(0);
  const [copied, setCopied] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const nodeTriggerRef = useRef<HTMLElement | null>(null);
  const journey = JOURNEYS[path];
  const lastStage = journey.stages.length - 1;
  const currentStage = journey.stages[stage];

  function closeNode() {
    setSelectedNode(null);
    window.requestAnimationFrame(() => nodeTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (!playing) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const duration = reducedMotion ? (stage === 0 ? 700 : 1200)
      : path === "wrapper" && stage === 1 ? PACKAGE_STAGE_DURATION
      : path === "values" && stage === 1 ? MERGE_STAGE_DURATION
      : path === "values" && stage === 2 ? RENDER_STAGE_DURATION
      : path === "values" && stage === 3 ? SYNC_STAGE_DURATION
      : stage === 0 ? 1150 : 2200;
    if (stage >= lastStage) {
      const timer = window.setTimeout(() => setPlaying(false), duration);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      const next = Math.min(stage + 1, lastStage);
      setStage(next);
      setView(journey.stages[next].yaml ? "yaml" : "flow");
    }, duration);
    return () => window.clearTimeout(timer);
  }, [playing, stage, path]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => setZoom(viewport.clientWidth >= 1050 ? Math.min(1, (viewport.clientWidth - 24) / WORLD_WIDTH) : 1);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [view, path]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || selectedNode) return;
    const focusNode = journey.nodes.find((node) => node.id === currentStage.focus);
    if (!focusNode) return;
    viewport.scrollTo({ left: Math.max(0, (focusNode.x + focusNode.width / 2) * zoom - viewport.clientWidth / 2), behavior: "smooth" });
  }, [stage, path, scenario.seed, selectedNode, view]);

  useEffect(() => {
    if (!selectedNode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [selectedNode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (uploadOpen || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if (selectedNode) {
        if (event.key === "Escape") closeNode();
        return;
      }
      if (event.key === "ArrowRight") jump(Math.min(stage + 1, lastStage));
      if (event.key === "ArrowLeft") jump(Math.max(stage - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [uploadOpen, selectedNode, stage, path]);

  function switchPath(next: UpdatePath) {
    setPath(next);
    setStage(0);
    setView("flow");
    setPlaying(false);
    setSelectedNode(null);
    setYamlReplay(0);
  }

  function regenerate() {
    const candidate = freshSeed();
    setScenario(generateScenario(candidate === scenario.seed ? (candidate + 1) >>> 0 : candidate));
    setStage(0);
    setView("flow");
    setPlaying(false);
    setSelectedNode(null);
    setSelectedManifest(0);
  }

  function jump(next: number) {
    setPlaying(false);
    setStage(next);
    setView(journey.stages[next].yaml ? "yaml" : "flow");
    setSelectedNode(null);
  }

  function play() {
    if (playing) { setPlaying(false); return; }
    setSelectedNode(null);
    setStage(0);
    setView("flow");
    setPlaying(true);
  }

  function selectNode(id: NodeId) {
    const node = journey.nodes.find((item) => item.id === id)!;
    nodeTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPlaying(false);
    setStage((current) => Math.max(current, node.step));
    setSelectedNode(id);
    window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      viewport?.scrollTo({ left: Math.max(0, (node.x + node.width / 2) * zoom - viewport.clientWidth / 2), top: Math.max(0, (node.y + node.height / 2) * zoom - viewport.clientHeight / 2), behavior: "smooth" });
    });
  }

  function changeZoom(next: number) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const clamped = Math.max(.55, Math.min(1.3, Math.round(next * 100) / 100));
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / zoom;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / zoom;
    setZoom(clamped);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => viewport.scrollTo({ left: centerX * clamped - viewport.clientWidth / 2, top: centerY * clamped - viewport.clientHeight / 2 })));
  }

  function fitGraph() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setZoom(Math.max(.55, Math.min(1, (viewport.clientWidth - 24) / WORLD_WIDTH)));
    viewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch" || event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    const viewport = event.currentTarget;
    dragRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    event.currentTarget.scrollLeft = dragRef.current.left - (event.clientX - dragRef.current.x);
    event.currentTarget.scrollTop = dragRef.current.top - (event.clientY - dragRef.current.y);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function importSources(chartFiles: File[], valueFiles: File[]) {
    const charts = await Promise.all(chartFiles.map((file) => readChartPackage(file)));
    const layers = await Promise.all(valueFiles.map((file, index) => readValueFile(file, index)));
    setScenario(scenarioFromUploads(charts, layers, freshSeed()));
    setPath(valueFiles.length ? "values" : "wrapper");
    setStage(0);
    setView("flow");
    setPlaying(false);
    setSelectedNode(null);
    setSelectedManifest(0);
  }

  async function copyManifest() {
    try { await navigator.clipboard.writeText(scenario.manifests[selectedManifest].yaml); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  }

  function downloadManifests() {
    const content = scenario.manifests.map((manifest) => manifest.yaml.trim()).join("\n---\n") + "\n";
    const url = URL.createObjectURL(new Blob([content], { type: "application/yaml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${scenario.releaseName}.yaml`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="app-shell">
    <header className="site-header"><a className="brand" href="#top"><span className="brand-mark"><i /><i /><i /></span><span>helmerfudge</span></a><span className="header-caption">A visual Helm map</span><div className="header-actions"><button type="button" onClick={regenerate} aria-label="Regenerate" title="Regenerate"><RefreshCw size={16} />Regenerate</button><button type="button" className="header-upload" onClick={() => setUploadOpen(true)} aria-label="Use local files" title="Use local files"><Upload size={16} />Use local files</button></div></header>
    <main id="top">
      <section className="intro"><span className="eyebrow">A BROWSER-ONLY WALKTHROUGH</span><h1>Three Helm update paths.</h1><p>Follow each update from its own trigger to its result. The same fictional chart versions connect the paths, so you can see what CI publishes and what Argo CD later applies.</p></section>
      <section className="path-picker" aria-labelledby="path-title">
        <div className="path-picker-main">
          <div className="path-picker-copy" aria-live="polite"><span className="eyebrow">{journey.kicker}</span><h2 id="path-title">{journey.title}</h2><p>{journey.summary}</p></div>
          <div className="path-select-wrap"><label htmlFor="update-path">Choose an update path</label><select id="update-path" value={path} onChange={(event) => switchPath(event.target.value as UpdatePath)}>{PATH_ORDER.map((id) => <option key={id} value={id}>{JOURNEYS[id].optionLabel}</option>)}</select><small>Choose a path to see its own steps and inputs.</small></div>
        </div>
        <div className="path-facts" aria-label="Selected path overview"><div><span>STARTS WITH</span><strong>{journey.trigger}</strong></div><div><span>RUNS IN</span><strong>{journey.process}</strong></div><div><span>PRODUCES</span><strong>{journey.result}</strong></div></div>
      </section>
      <section className="graph-section" aria-label={`${journey.title} screen`}>
        <div className="story-bar"><div className="story-copy"><span className="eyebrow">STEP {String(stage + 1).padStart(2, "0")} / {String(journey.stages.length).padStart(2, "0")}</span><h2>{currentStage.title}</h2><p>{currentStage.description}</p></div><div className="graph-controls"><div className="control-group"><button type="button" onClick={() => jump(Math.max(0, stage - 1))} disabled={stage === 0} aria-label="Previous step" title="Previous step"><ArrowLeft size={17} /></button><button type="button" className="play-button" onClick={play}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}{playing ? "Pause" : "Play this path"}</button><button type="button" onClick={() => jump(Math.min(lastStage, stage + 1))} disabled={stage === lastStage} aria-label="Next step" title="Next step"><ArrowRight size={17} /></button></div>{view === "flow" && <div className="control-group zoom-group"><button type="button" onClick={() => changeZoom(zoom - .1)} aria-label="Zoom out" title="Zoom out"><Minus size={16} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => changeZoom(zoom + .1)} aria-label="Zoom in" title="Zoom in"><Plus size={16} /></button><button type="button" onClick={fitGraph} aria-label="Fit graph" title="Fit graph"><Maximize2 size={15} /></button></div>}</div></div>
        {currentStage.yaml && <div className="view-switch" aria-label="Story view"><button type="button" className={view === "yaml" ? "is-current" : ""} aria-pressed={view === "yaml"} onClick={() => { setPlaying(false); setView("yaml"); }}><FileCode2 size={15} />{currentStage.yaml === "merge" ? "Compare YAML" : currentStage.yaml === "render" ? "Render YAML" : "Sync YAML"}</button><button type="button" className={view === "flow" ? "is-current" : ""} aria-pressed={view === "flow"} onClick={() => { setPlaying(false); setView("flow"); }}><Workflow size={15} />Flow map</button>{view === "yaml" && <button type="button" className="view-replay" onClick={() => { setPlaying(false); setYamlReplay((current) => current + 1); }}><RefreshCw size={14} />Replay step</button>}</div>}
        {view === "yaml" && currentStage.yaml
          ? currentStage.yaml === "merge"
            ? <ValuesComparison key={`${scenario.seed}-${path}-${stage}-${yamlReplay}`} scenario={scenario} animate />
            : currentStage.yaml === "render"
              ? <RenderSequence key={`${scenario.seed}-${path}-${stage}-${yamlReplay}`} scenario={scenario} />
              : <SyncSequence key={`${scenario.seed}-${path}-${stage}-${yamlReplay}`} scenario={scenario} />
          : <GraphCanvas key={path} scenario={scenario} journey={journey} path={path} stage={stage} selectedNode={selectedNode} onSelect={selectNode} zoom={zoom} viewportRef={viewportRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} dragging={dragging} />}
        <div className="graph-bottom"><div className="step-trail" aria-label="Path steps">{journey.stages.map((item, index) => <button type="button" key={item.id} className={index === stage ? "is-current" : index < stage ? "is-past" : ""} aria-current={index === stage ? "step" : undefined} onClick={() => jump(index)}><span>{String(index + 1).padStart(2, "0")}</span>{item.label}</button>)}</div><span className="graph-hint">{view === "yaml" && currentStage.yaml ? "Replay this YAML step or choose another path step" : "Drag to pan · click a node to inspect"}</span></div>
      </section>
      <div className="under-note"><ChevronDown size={17} /><span>{journey.note}</span></div>
    </main>
    <footer className="site-footer"><span>helmerfudge <i>✳</i> chart → values → manifests</span><span>Fictional names · Local browser preview · No cluster connection</span></footer>
    {selectedNode && <div className="detail-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closeNode(); }}><NodeDetail id={selectedNode} journey={journey} path={path} scenario={scenario} close={closeNode} selectedManifest={selectedManifest} setSelectedManifest={setSelectedManifest} copied={copied} onCopy={() => void copyManifest()} onDownload={downloadManifests} /></div>}
    <UploadDrawer open={uploadOpen} close={() => setUploadOpen(false)} onImport={importSources} />
  </div>;
}
