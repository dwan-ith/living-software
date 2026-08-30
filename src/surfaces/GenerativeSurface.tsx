import { componentRegistry, resolveSurfaceBinding } from './registry';
import type { SurfaceDocument, SurfaceNode } from './types';
import { NodeBoundary } from './NodeBoundary';

type Props = {
  surface: SurfaceDocument;
  busyAction: string | null;
  onAction: (node: SurfaceNode, action: string, targetId?: string) => void;
};

function UnknownComponent({ node }: { node: SurfaceNode }) {
  return <article className="generated-node unknown-node">
    <header className="node-heading"><div><span>Registry miss</span><h2>{node.title}</h2></div></header>
    <p>The backend requested <code>{node.type}</code>, but this client has not registered a trusted renderer for it.</p>
  </article>;
}

export function GenerativeSurface({ surface, busyAction, onAction }: Props) {
  return <section className={`generative-surface layout-${surface.layout}`} aria-label={surface.title}>
    {surface.components.map((node) => {
      const Renderer = componentRegistry[node.type];
      return <div className={`surface-slot region-${node.region} width-${node.width}`} key={node.id}>
        <NodeBoundary node={node}>
          {Renderer
            ? <Renderer node={node} value={resolveSurfaceBinding(surface, node.binding)} surface={surface} busyAction={busyAction} onAction={onAction} />
            : <UnknownComponent node={node} />}
        </NodeBoundary>
      </div>;
    })}
  </section>;
}
