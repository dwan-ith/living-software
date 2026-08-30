export type SurfaceGeneration = {
  mode: 'model-composed' | 'adaptive-policy';
  provider: string;
  model: string | null;
  contextDigest: string;
  latencyMs: number;
  warnings: string[];
};

export type SurfaceNode = {
  id: string;
  type: string;
  region: 'lead' | 'main' | 'context';
  width: 'full' | 'half' | 'third';
  title: string;
  description: string;
  binding: string;
  limit: number;
  actions: string[];
  props: Record<string, string | number | boolean>;
};

export type SurfaceDocument = {
  protocol: 'living-surface/v1';
  id: string;
  sessionId: string;
  revision: number;
  title: string;
  rationale: string;
  focus: string;
  layout: 'focus' | 'split' | 'canvas';
  components: SurfaceNode[];
  data: Record<string, unknown>;
  generation: SurfaceGeneration;
  generatedAt: string;
};

export type SurfaceActionRequest = {
  surfaceId: string;
  revision: number;
  componentId: string;
  action: string;
  targetId?: string;
};

export type SurfaceRendererProps = {
  node: SurfaceNode;
  value: unknown;
  surface: SurfaceDocument;
  busyAction: string | null;
  onAction: (node: SurfaceNode, action: string, targetId?: string) => void;
};
