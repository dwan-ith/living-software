/* oxlint-disable react/only-export-components -- this module is the intentional trusted component registry */
import type { ComponentType, ReactNode } from 'react';
import type { SurfaceDocument, SurfaceNode, SurfaceRendererProps } from './types';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function time(value: unknown): string {
  const date = new Date(text(value));
  return Number.isNaN(date.valueOf()) ? 'now' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function humanize(value: string): string {
  return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function NodeFrame({ node, children, meta }: { node: SurfaceNode; children: ReactNode; meta?: ReactNode }) {
  return <article className={`generated-node node-${node.type}`} data-component={node.type}>
    <header className="node-heading">
      <div><span>{humanize(node.type)}</span><h2>{node.title}</h2>{node.description ? <p>{node.description}</p> : null}</div>
      {meta ? <div className="node-meta">{meta}</div> : null}
    </header>
    {children}
  </article>;
}

function ActionButton({ node, action, targetId, label, tone = 'quiet', busyAction, onAction }: {
  node: SurfaceNode;
  action: string;
  targetId?: string;
  label: string;
  tone?: 'quiet' | 'primary' | 'danger';
  busyAction: string | null;
  onAction: SurfaceRendererProps['onAction'];
}) {
  if (!node.actions.includes(action)) return null;
  const busyKey = `${action}:${targetId || ''}`;
  return <button className={`surface-action ${tone}`} disabled={Boolean(busyAction)} onClick={() => onAction(node, action, targetId)}>
    {busyAction === busyKey ? 'Working…' : label}
  </button>;
}

function IntentBrief({ node, surface, busyAction, onAction }: SurfaceRendererProps) {
  return <NodeFrame node={node} meta={<span className="revision-pill">phenotype {surface.revision}</span>}>
    <div className="intent-copy">
      <strong>{surface.focus}</strong>
      <p>{surface.rationale}</p>
      <div className="inline-actions">
        <ActionButton node={node} action="living.cycle" label="Run living cycle" tone="primary" busyAction={busyAction} onAction={onAction} />
        <ActionButton node={node} action="surface.regenerate" label="Recompose" busyAction={busyAction} onAction={onAction} />
      </div>
    </div>
  </NodeFrame>;
}

function RuntimeIdentity({ node, value, busyAction, onAction }: SurfaceRendererProps) {
  const identity = record(value);
  return <NodeFrame node={node} meta={<span className="alive-pill">persistent</span>}>
    <div className="identity-block">
      <span className="living-orb" />
      <div><strong>{text(identity.name, 'Living Software')}</strong><p>{text(identity.thesis)}</p><small>{text(identity.habitat)} · boot {number(identity.bootCount)}</small></div>
    </div>
    <ActionButton node={node} action="surface.regenerate" label="Refresh context" busyAction={busyAction} onAction={onAction} />
  </NodeFrame>;
}

function MetricStrip({ node, value }: SurfaceRendererProps) {
  const metrics = record(value);
  const selected = [
    ['World entities', metrics.entities],
    ['Durable events', metrics.events],
    ['Capabilities', metrics.activeCapabilities],
    ['Pending growth', metrics.pendingProposals],
    ['Mean fitness', metrics.averageFitness],
    ['Verified work', `${number(metrics.verificationRate)}%`]
  ];
  return <NodeFrame node={node}><div className="metric-grid">{selected.map(([label, valueItem]) => <div key={text(label)}><strong>{text(valueItem, '0')}</strong><span>{text(label)}</span></div>)}</div></NodeFrame>;
}

function LoopStatus({ node, value, busyAction, onAction }: SurfaceRendererProps) {
  const loops = record(value);
  return <NodeFrame node={node} meta={<ActionButton node={node} action="living.cycle" label="Run cycle" tone="primary" busyAction={busyAction} onAction={onAction} />}>
    <div className="loop-grid">{['world', 'work', 'evolution'].map((key, index) => {
      const loop = record(loops[key]);
      return <div key={key}><span>0{index + 1}</span><strong>{humanize(key)}</strong><p>{humanize(text(loop.status, 'waiting'))}</p><small>{time(loop.lastAt)}</small></div>;
    })}</div>
  </NodeFrame>;
}

function ReflectionCard({ node, value }: SurfaceRendererProps) {
  const reflections = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{reflections.length} recent</span>}>
    <div className="reflection-stack">{reflections.length ? reflections.map((item) => <section key={text(item.id)}><span>{humanize(text(item.kind, 'reflection'))}</span><strong>{text(item.headline)}</strong><p>{text(item.summary)}</p><small>{text(item.recommendation)}</small></section>) : <Empty label="No reflection has been formed yet." />}</div>
  </NodeFrame>;
}

function CapabilityList({ node, value, busyAction, onAction }: SurfaceRendererProps) {
  const capabilities = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{capabilities.length} active</span>}>
    <div className="package-list">{capabilities.length ? capabilities.map((item) => {
      const metrics = record(item.metrics);
      const fitness = record(metrics.fitness);
      const pkg = record(item.package);
      const steps = list(item.steps).map((step) => text(record(step).primitive));
      return <section className="package-card" key={text(item.id)}>
        <header><div><span>{text(item.origin)} · fitness {number(fitness.score)}</span><strong>{text(item.name)}</strong></div><b>v{number(item.version, 1)}</b></header>
        <p>{text(item.description)}</p>
        <div className="primitive-row">{steps.map((step) => <small key={step}>{step}</small>)}</div>
        <footer><span>{text(pkg.digest).slice(0, 12) || 'unsealed'} · {text(fitness.recommendation, 'probation')}</span><div className="inline-actions">
          <ActionButton node={node} action="capability.run" targetId={text(item.id)} label="Run" tone="primary" busyAction={busyAction} onAction={onAction} />
          {text(item.origin) !== 'built-in' ? <ActionButton node={node} action="capability.rollback" targetId={text(item.id)} label="Rollback" tone="danger" busyAction={busyAction} onAction={onAction} /> : null}
        </div></footer>
      </section>;
    }) : <Empty label="No active capability is bound to this surface." />}</div>
  </NodeFrame>;
}

function ProposalList({ node, value, busyAction, onAction }: SurfaceRendererProps) {
  const proposals = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{proposals.length} awaiting judgment</span>}>
    <div className="proposal-list">{proposals.length ? proposals.map((item) => {
      const status = text(item.status);
      const validation = record(item.validation);
      const rehearsal = record(item.rehearsal);
      const pkg = record(item.package);
      const manifest = record(pkg.manifest);
      const target = text(item.id);
      return <section className="proposal-card" key={target}>
        <header><div><span>{text(item.origin)} · {status}</span><strong>{text(item.name)}</strong></div><b>v{number(manifest.version, 1)}</b></header>
        <p>{text(item.rationale)}</p>
        <div className="lifecycle-track"><span className={validation.status === 'passed' ? 'done' : ''}>Validate</span><span className={rehearsal.status === 'passed' ? 'done' : ''}>Rehearse</span><span className={status === 'installed' ? 'done' : ''}>Activate</span></div>
        <footer><small>{text(pkg.digest).slice(0, 16)}</small><div className="inline-actions">
          {['proposed', 'invalid'].includes(status) ? <ActionButton node={node} action="proposal.validate" targetId={target} label="Validate" tone="primary" busyAction={busyAction} onAction={onAction} /> : null}
          {status === 'validated' ? <ActionButton node={node} action="proposal.rehearse" targetId={target} label="Dry run" tone="primary" busyAction={busyAction} onAction={onAction} /> : null}
          {status === 'rehearsed' ? <ActionButton node={node} action="proposal.activate" targetId={target} label="Activate" tone="primary" busyAction={busyAction} onAction={onAction} /> : null}
          <ActionButton node={node} action="proposal.reject" targetId={target} label="Reject" tone="danger" busyAction={busyAction} onAction={onAction} />
        </div></footer>
      </section>;
    }) : <Empty label="Nothing is waiting for approval in this context." />}</div>
  </NodeFrame>;
}

function ReceiptList({ node, value, busyAction, onAction }: SurfaceRendererProps) {
  const receipts = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{receipts.length} visible</span>}>
    <div className="receipt-list">{receipts.length ? receipts.map((item) => {
      const transaction = record(item.transaction);
      const effects = list(transaction.externalEffects).length;
      const mutations = list(transaction.userArtifactMutations);
      const feedback = record(item.feedback);
      const target = text(item.id);
      const revertible = mutations.length > 0 && Boolean(item.reversible) && !item.compensationAppliedAt;
      return <section key={target}>
        <span className={text(item.status) === 'verified' ? 'receipt-mark verified' : 'receipt-mark failed'}>{text(item.status) === 'verified' ? '✓' : '!'}</span>
        <div><strong>{text(item.capabilityId)}</strong><p>{list(item.evidence).slice(0, 2).map((entry) => text(entry)).join(' · ')}</p><small>{time(item.createdAt)} · effects {effects} · artifact mutations {mutations.length}{item.compensationAppliedAt ? ' · reverted' : ''}</small></div>
        {feedback.verdict ? <span className="feedback-pill">{text(feedback.verdict)}</span> : <div className="inline-actions">
          {revertible ? <ActionButton node={node} action="receipt.revert" targetId={target} label="Revert effects" tone="danger" busyAction={busyAction} onAction={onAction} /> : null}
          <ActionButton node={node} action="receipt.useful" targetId={target} label="Useful" busyAction={busyAction} onAction={onAction} />
          <ActionButton node={node} action="receipt.reject" targetId={target} label="Reject" tone="danger" busyAction={busyAction} onAction={onAction} />
        </div>}
      </section>;
    }) : <Empty label="No receipt is available for this context." />}</div>
  </NodeFrame>;
}

function EventStream({ node, value }: SurfaceRendererProps) {
  const events = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{events.length} changes</span>}>
    <div className="event-list">{events.length ? events.map((item) => <section key={text(item.id)}><span>{text(item.kind).split('.').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><div><strong>{text(item.kind)}</strong><p>{text(item.summary)}</p><small>{text(item.source)} · {time(item.createdAt)}</small></div></section>) : <Empty label="The event stream is quiet." />}</div>
  </NodeFrame>;
}

function WorldEntities({ node, value }: SurfaceRendererProps) {
  const entities = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{entities.length} observed</span>}>
    <div className="entity-grid">{entities.map((item) => <section key={text(item.id)}><span>{text(item.kind)}</span><strong>{text(item.label)}</strong><p>{text(item.state)}</p><small>{text(item.authority)}</small></section>)}</div>
  </NodeFrame>;
}

function DependencyGraph({ node, value }: SurfaceRendererProps) {
  const dependency = record(value);
  const files = list(dependency.files).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{number(dependency.scanned)} artifacts scanned</span>}>
    <div className="dependency-field">{files.length ? files.map((item) => <section className={`dependency-node risk-${text(item.risk, 'low')}`} key={text(item.id) || text(item.name)}>
      <header><span>{text(item.risk)} risk</span><b>{number(item.references)} refs</b></header><strong>{text(item.name)}</strong>
      <div className="importer-row">{list(item.importers).slice(0, 5).map((entry) => <small key={text(entry)}>{text(entry)}</small>)}</div>
      <p>{list(item.signals).map((entry) => text(entry)).join(' · ') || 'No explicit risk signal.'}</p>
    </section>) : <Empty label="No dependency evidence is available." />}</div>
  </NodeFrame>;
}

function WorkspaceMap({ node, value }: SurfaceRendererProps) {
  const surfaces = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{surfaces.length} senses</span>}>
    <div className="workspace-map">{surfaces.map((item) => <section key={text(item.id)}><span>{number(item.count)}</span><div><strong>{text(item.label)}</strong><p>{text(item.authority)}</p><small>{text(item.status)}</small></div></section>)}</div>
  </NodeFrame>;
}

function MemoryStream({ node, value }: SurfaceRendererProps) {
  const memories = list(value).slice(0, node.limit).map(record);
  return <NodeFrame node={node} meta={<span>{memories.length} recalled</span>}>
    <div className="memory-stream">{memories.length ? memories.map((item) => <section key={text(item.id)}><span>{text(item.kind)}</span><div><strong>{text(item.title)}</strong><p>{text(item.text)}</p><small>{text(item.source)} · {time(item.createdAt)}</small></div></section>) : <Empty label="No persistent memory is relevant yet." />}</div>
  </NodeFrame>;
}

function ConstitutionCard({ node, value }: SurfaceRendererProps) {
  const constitution = record(value);
  return <NodeFrame node={node} meta={<span>{text(constitution.autonomy, 'bounded')}</span>}>
    <div className="constitution-list">{list(constitution.principles).map((item) => <p key={text(item)}>{text(item)}</p>)}</div>
    <small className="approval-note">Approval required: {list(constitution.approvalRequired).map((entry) => text(entry)).join(' · ')}</small>
  </NodeFrame>;
}

function GenerationTrace({ node, surface, busyAction, onAction }: SurfaceRendererProps) {
  const generation = surface.generation;
  return <NodeFrame node={node} meta={<ActionButton node={node} action="surface.regenerate" label="Regenerate" busyAction={busyAction} onAction={onAction} />}>
    <div className="generation-trace"><div><span>Composer</span><strong>{generation.mode}</strong><small>{generation.provider}{generation.model ? ` · ${generation.model}` : ''}</small></div><div><span>Context</span><strong>{generation.contextDigest.slice(0, 12)}</strong><small>{generation.latencyMs} ms · revision {surface.revision}</small></div><div><span>Warnings</span><strong>{generation.warnings.length}</strong><small>{generation.warnings[0] || 'Typed surface passed validation.'}</small></div></div>
  </NodeFrame>;
}

function Empty({ label }: { label: string }) {
  return <div className="surface-empty"><span>○</span><p>{label}</p></div>;
}

export const componentRegistry: Record<string, ComponentType<SurfaceRendererProps>> = {
  'intent-brief': IntentBrief,
  'runtime-identity': RuntimeIdentity,
  'metric-strip': MetricStrip,
  'loop-status': LoopStatus,
  'reflection-card': ReflectionCard,
  'capability-list': CapabilityList,
  'proposal-list': ProposalList,
  'receipt-list': ReceiptList,
  'event-stream': EventStream,
  'world-entities': WorldEntities,
  'dependency-graph': DependencyGraph,
  'workspace-map': WorkspaceMap,
  'memory-stream': MemoryStream,
  'constitution-card': ConstitutionCard,
  'generation-trace': GenerationTrace
};

export function resolveSurfaceBinding(surface: SurfaceDocument, binding: string): unknown {
  if (!binding || binding === 'none') return null;
  return binding.split('.').reduce<unknown>((current, part) => record(current)[part], surface.data);
}
