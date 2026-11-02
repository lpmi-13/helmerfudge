import { Box, Cloud, FileArchive, FileCode2, FileText, GitBranch, Layers3, Workflow, type LucideIcon } from "lucide-react";

export type UpdatePath = "reusable" | "wrapper" | "values";
export type NodeId = "dependencySource" | "dependencyBuild" | "dependency" | "wrapper" | "artifact" | "wrapperPublished" | "values" | "merge" | "effective" | "render" | "manifests" | "cluster";
export type Tone = "chart" | "values" | "manifest" | "sync";

export type GraphNode = {
  id: NodeId;
  label: string;
  location?: "Git" | "OCI" | "CI" | "Argo CD";
  x: number;
  y: number;
  width: number;
  height: number;
  step: number;
  tone: Tone;
  icon: LucideIcon;
};

export type GraphEdge = {
  id: string;
  d: string;
  step: number;
  tone: Tone;
  packet: string;
  delay?: number;
};

type JourneyStage = {
  id: string;
  label: string;
  title: string;
  description: string;
  focus: NodeId;
  yaml?: "merge" | "render" | "sync";
};

export type Journey = {
  optionLabel: string;
  kicker: string;
  title: string;
  summary: string;
  trigger: string;
  process: string;
  result: string;
  note: string;
  graphLabel: string;
  worldHeight: number;
  contextSteps: { place: string; action: string }[];
  zones: { x: number; title: string }[];
  rules: number[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  stages: JourneyStage[];
};

export const PATH_ORDER: UpdatePath[] = ["reusable", "wrapper", "values"];

export const JOURNEYS: Record<UpdatePath, Journey> = {
  reusable: {
    optionLabel: "1 · Reusable chart update",
    kicker: "PATH 01 / 03 · CHART RELEASE",
    title: "Publish a reusable chart",
    summary: "A change to the shared chart creates a new dependency version for wrappers to choose later.",
    trigger: "Reusable chart Git commit",
    process: "Reusable chart CI",
    result: "Versioned reusable chart in OCI",
    note: "This version is available to wrapper CI. Publishing it does not update an existing wrapper package or the cluster.",
    graphLabel: "Reusable chart release graph",
    worldHeight: 555,
    contextSteps: [
      { place: "Git", action: "chart source" },
      { place: "CI", action: "validate + package" },
      { place: "OCI", action: "publish reusable version" },
    ],
    zones: [{ x: 82, title: "Source in Git" }, { x: 620, title: "Build in CI" }, { x: 1150, title: "Reusable OCI version" }],
    rules: [450, 1020],
    nodes: [
      { id: "dependencySource", label: "Reusable chart source", location: "Git", x: 82, y: 205, width: 255, height: 142, step: 0, tone: "chart", icon: Layers3 },
      { id: "dependencyBuild", label: "Chart build", location: "CI", x: 620, y: 205, width: 260, height: 142, step: 1, tone: "chart", icon: Workflow },
      { id: "dependency", label: "Reusable chart", location: "OCI", x: 1150, y: 205, width: 260, height: 142, step: 2, tone: "chart", icon: FileArchive },
    ],
    edges: [
      { id: "source-build", d: "M337 276 C430 276 525 276 620 276", step: 1, tone: "chart", packet: "source" },
      { id: "build-dependency", d: "M880 276 C970 276 1060 276 1150 276", step: 2, tone: "chart", packet: "chart" },
    ],
    stages: [
      { id: "source", label: "Source change", title: "Change the reusable chart", description: "A Git commit changes its templates or defaults. This source chart is maintained independently of the wrapper.", focus: "dependencySource" },
      { id: "build", label: "CI package", title: "Build a chart version", description: "Reusable chart CI validates the chart and packages its templates and defaults as a new version.", focus: "dependencyBuild" },
      { id: "publish", label: "Publish to OCI", title: "Publish the dependency", description: "CI pushes the versioned reusable chart to OCI. Wrapper CI can fetch this version when its dependency pin changes.", focus: "dependency" },
    ],
  },
  wrapper: {
    optionLabel: "2 · Wrapper chart update",
    kicker: "PATH 02 / 03 · CHART RELEASE",
    title: "Package a wrapper chart",
    summary: "The wrapper selects a reusable chart version; CI packages both charts and publishes a wrapper version.",
    trigger: "Wrapper Git commit or dependency pin",
    process: "Wrapper chart CI",
    result: "Versioned wrapper chart in OCI",
    note: "The new wrapper version is available in OCI. A pinned Argo CD Application must reference it before the cluster can change.",
    graphLabel: "Wrapper chart release graph",
    worldHeight: 735,
    contextSteps: [
      { place: "Git + OCI", action: "wrapper + reusable dependency" },
      { place: "CI", action: "resolve + package" },
      { place: "OCI", action: "publish wrapper version" },
    ],
    zones: [{ x: 64, title: "Wrapper + dependency" }, { x: 462, title: "CI packaging" }, { x: 1040, title: "Published wrapper" }],
    rules: [350, 1018],
    nodes: [
      { id: "wrapper", label: "Wrapper chart source", location: "Git", x: 64, y: 134, width: 230, height: 112, step: 0, tone: "chart", icon: Box },
      { id: "dependency", label: "Reusable chart", location: "OCI", x: 64, y: 296, width: 230, height: 112, step: 0, tone: "chart", icon: FileArchive },
      { id: "artifact", label: "Packaged wrapper", location: "CI", x: 462, y: 188, width: 236, height: 120, step: 1, tone: "chart", icon: FileArchive },
      { id: "wrapperPublished", label: "Wrapper chart package", location: "OCI", x: 1040, y: 188, width: 260, height: 132, step: 2, tone: "chart", icon: FileArchive },
    ],
    edges: [
      { id: "wrapper-package", d: "M294 190 C365 190 390 248 462 248", step: 1, tone: "chart", packet: "wrapper" },
      { id: "dependency-package", d: "M294 352 C365 352 390 248 462 248", step: 1, tone: "chart", packet: "dependency" },
      { id: "package-publish", d: "M698 248 C812 248 925 254 1040 254", step: 2, tone: "chart", packet: "OCI chart" },
    ],
    stages: [
      { id: "inputs", label: "Choose inputs", title: "Pin a reusable version", description: "The Git wrapper declares the reusable chart's OCI location, version, and alias. CI fetches that exact dependency.", focus: "wrapper" },
      { id: "package", label: "Package", title: "Build the wrapper package", description: "CI places the chosen reusable chart inside the wrapper and creates one versioned chart archive.", focus: "artifact" },
      { id: "publish", label: "Publish to OCI", title: "Publish the wrapper version", description: "CI pushes the packaged wrapper to OCI. Publishing alone does not change an Application pinned to an older version.", focus: "wrapperPublished" },
    ],
  },
  values: {
    optionLabel: "3 · Git values update",
    kicker: "PATH 03 / 03 · DEPLOYMENT",
    title: "Apply a values change",
    summary: "Argo CD combines Git values with an already published wrapper chart, renders desired YAML, and syncs the cluster.",
    trigger: "Ordered Git values commit",
    process: "Argo CD reconciliation",
    result: "Updated Kubernetes resources",
    note: "This example uses the already published wrapper chart. A values commit triggers Argo CD reconciliation; CI does not repackage either chart. Manifests and cluster state are illustrative.",
    graphLabel: "Git values deployment graph",
    worldHeight: 735,
    contextSteps: [
      { place: "Git + OCI", action: "values + packaged wrapper" },
      { place: "Argo CD repo-server", action: "merge + render" },
      { place: "Argo CD controller", action: "sync cluster" },
    ],
    zones: [{ x: 64, title: "Git + OCI inputs" }, { x: 462, title: "Argo CD repo-server" }, { x: 1040, title: "Desired → live" }],
    rules: [350, 1018],
    nodes: [
      { id: "artifact", label: "Packaged wrapper", location: "OCI", x: 64, y: 134, width: 230, height: 120, step: 0, tone: "chart", icon: FileArchive },
      { id: "values", label: "Git values", location: "Git", x: 64, y: 510, width: 230, height: 146, step: 0, tone: "values", icon: GitBranch },
      { id: "merge", label: "Values merge", location: "Argo CD", x: 462, y: 506, width: 236, height: 132, step: 1, tone: "values", icon: Workflow },
      { id: "effective", label: "Final values", location: "Argo CD", x: 1040, y: 510, width: 245, height: 152, step: 1, tone: "values", icon: Layers3 },
      { id: "render", label: "Helm render", location: "Argo CD", x: 758, y: 347, width: 236, height: 130, step: 2, tone: "manifest", icon: FileCode2 },
      { id: "manifests", label: "Manifests", location: "Argo CD", x: 1040, y: 212, width: 245, height: 174, step: 2, tone: "manifest", icon: FileText },
      { id: "cluster", label: "Argo CD sync", x: 1315, y: 425, width: 165, height: 150, step: 3, tone: "sync", icon: Cloud },
    ],
    edges: [
      { id: "values-merge", d: "M294 583 C360 583 390 572 462 572", step: 1, tone: "values", packet: "file" },
      { id: "merge-effective", d: "M698 572 C825 572 920 586 1040 586", step: 1, tone: "values", packet: "merged", delay: 1280 },
      { id: "artifact-render", d: "M294 194 C470 194 640 412 758 412", step: 2, tone: "chart", packet: "chart" },
      { id: "merge-render", d: "M698 572 C740 572 718 412 758 412", step: 2, tone: "values", packet: "values" },
      { id: "render-manifests", d: "M994 412 C1022 412 1012 299 1040 299", step: 2, tone: "manifest", packet: "YAML", delay: 1120 },
      { id: "manifests-cluster", d: "M1162 386 C1220 428 1330 410 1397 425", step: 3, tone: "sync", packet: "sync" },
    ],
    stages: [
      { id: "inputs", label: "Git + OCI", title: "Start with values and a chart", description: "Argo CD sees the Git values revision and fetches the configured wrapper chart version from OCI. No chart is rebuilt here.", focus: "values" },
      { id: "merge", label: "Layer values", title: "Merge defaults and overrides", description: "Argo CD's repo-server passes the ordered Git values to Helm. Later scalars win; maps merge and lists replace.", focus: "merge", yaml: "merge" },
      { id: "render", label: "Render", title: "Render desired manifests", description: "Helm uses the packaged chart's templates and effective values to produce desired Kubernetes resources.", focus: "render", yaml: "render" },
      { id: "sync", label: "Sync", title: "Apply the desired state", description: "Argo CD's application controller compares desired manifests with the cluster and syncs the difference.", focus: "cluster", yaml: "sync" },
    ],
  },
};
