import { Component, type ReactNode } from 'react';
import type { SurfaceNode } from './types';

type Props = { node: SurfaceNode; children: ReactNode };
type State = { failed: boolean };

/**
 * A phenotype must degrade cell-by-cell. If one trusted renderer throws on
 * unexpected data, only that node collapses into an inspectable stub; the rest
 * of the composed surface stays alive.
 */
export class NodeBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[surface] renderer failed for component "${this.props.node.id}" (${this.props.node.type})`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <article className="generated-node unknown-node">
      <header className="node-heading"><div><span>Degenerate node</span><h2>{this.props.node.title}</h2></div></header>
      <p>The renderer for <code>{this.props.node.type}</code> failed on this data. The node is quarantined; recompose to regenerate it.</p>
    </article>;
  }
}
