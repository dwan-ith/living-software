import { useEffect, useMemo, useRef, useState } from 'react';

type Page = 'screen' | 'system' | 'rigor' | 'memory' | 'slides' | 'notes' | 'gallery' | 'files' | 'downloads' | 'dependencies' | 'clipboard' | 'notifications';
type Tone = 'quiet' | 'active' | 'warning';
type ModelState = { connected: boolean; model: string | null; visionCapable: boolean; provider?: string };
type ObserverState = { running: boolean; lastCaptureAt: string | null; model: ModelState; privacy?: string };
type Intervention = { severity: 'quiet' | 'notice' | 'warning' | 'critical'; application: string; title: string; reason: string; evidence?: string[]; actions?: string[]; spoken?: string };
type FileItem = { name: string; path: string; type: string; size: number; modifiedAt: string; preview?: string; risk?: 'low' | 'medium' | 'high'; references?: number; signals?: string[] };
type Notification = { id: string; source: string; project: string; text: string; createdAt: string };
type LogItem = { id: string; time: string; label: string; tone: Tone };
type SystemSurface = { id: string; label: string; authority: string; count: number; status: string };
type SystemMap = { generatedAt: string; surfaces: SystemSurface[] };
type CompanionState = { running: boolean; pid: number | null; mode: string };
type MemoryFact = { id: string; title: string; text: string; tags?: string[]; confidence?: number; source?: string; createdAt: string };
type MemoryEpisode = { id: string; title: string; summary: string; surfaces?: string[]; importance?: number; source?: string; createdAt: string };
type MemoryAssociation = { id: string; from: string; to: string; relation: string; strength: number; createdAt: string };
type MemoryState = { facts: MemoryFact[]; episodes: MemoryEpisode[]; associations: MemoryAssociation[]; stats?: { facts: number; episodes: number; associations: number; path: string } };
type RigorAgent = { id: string; label: string; mission: string; evidence: string[]; gaps: string[]; next: string; score: number; maturity: string };
type RigorState = { generatedAt: string; sourceCount: number; average: number; verdict: string; agents: RigorAgent[] };
type LocalModelState = { provider: string; host: string; targetModel: string; service: string; models: string[]; ready: boolean; pullCommand: string; error?: string; output?: string };
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '');

const initialObserver: ObserverState = { running: false, lastCaptureAt: null, model: { connected: false, model: null, visionCapable: false } };

function time(value?: string | null) {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
}

function size(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function fileMeta(file: FileItem) {
  return `${file.type} / ${size(file.size)} / ${new Date(file.modifiedAt).toLocaleDateString()}`;
}

function apiUrl(path: string) {
  return BACKEND_URL ? `${BACKEND_URL}${path}` : path;
}

function wsUrl(path: string) {
  if (BACKEND_URL) {
    const base = BACKEND_URL.replace(/^http/, 'ws');
    return `${base}${path}`;
  }
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}

export default function App() {
  const [page, setPage] = useState<Page>('screen');
  const [observer, setObserver] = useState<ObserverState>(initialObserver);
  const [frame, setFrame] = useState('');
  const [intervention, setIntervention] = useState<Intervention | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [slides, setSlides] = useState<FileItem[]>([]);
  const [notes, setNotes] = useState<FileItem[]>([]);
  const [gallery, setGallery] = useState<FileItem[]>([]);
  const [dependencies, setDependencies] = useState<FileItem[]>([]);
  const [system, setSystem] = useState<SystemMap | null>(null);
  const [rigor, setRigor] = useState<RigorState | null>(null);
  const [localModel, setLocalModel] = useState<LocalModelState | null>(null);
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [recallQuery, setRecallQuery] = useState('living software demo');
  const [recallMatches, setRecallMatches] = useState<Array<(MemoryFact | MemoryEpisode) & { kind?: string; score?: number }>>([]);
  const [clipboard, setClipboard] = useState<{ text: string; kind: string; length: number } | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [companion, setCompanion] = useState<CompanionState>({ running: false, pid: null, mode: 'browser-dom' });
  const [analysis, setAnalysis] = useState('');
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState(true);
  const socketRef = useRef<WebSocket | null>(null);
  const voiceRef = useRef(voice);

  useEffect(() => { voiceRef.current = voice; }, [voice]);

  function log(label: string, tone: Tone = 'quiet') {
    setLogs((items) => [{ id: crypto.randomUUID(), time: time(new Date().toISOString()), label, tone }, ...items].slice(0, 30));
  }

  async function loadJson<T>(url: string, apply: (value: T) => void, failure: string) {
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || failure);
      apply(data);
    } catch {
      log(failure, 'warning');
    }
  }

  useEffect(() => {
    let reconnect: number | undefined;
    let disposed = false;
    fetch(apiUrl('/api/observer/status')).then((r) => r.json()).then(setObserver).catch(() => log('Observer backend is offline.', 'warning'));
    fetch(apiUrl('/api/companion/status')).then((r) => r.json()).then(setCompanion).catch(() => { });

    const connect = () => {
      const socket = new WebSocket(wsUrl('/observer-ws'));
      socketRef.current = socket;
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'observer_status') setObserver(data.state);
        if (data.type === 'screen') { setFrame(data.image); setObserver((state) => ({ ...state, lastCaptureAt: data.capturedAt })); }
        if (data.type === 'analysis_started') { setBusy(true); log(`${data.model} is examining the screen.`, 'active'); }
        if (data.type === 'analysis') { setBusy(false); if (!data.analysis.shouldIntervene) log('Screen is coherent. No pushback needed.'); }
        if (data.type === 'intervention') {
          setBusy(false); setIntervention(data.intervention); log(data.intervention.title, 'warning');
          if (voiceRef.current && data.intervention.spoken) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(data.intervention.spoken)); }
        }
        if (data.type === 'observer_error') { setBusy(false); log(data.message, 'warning'); }
        if (data.type === 'notification') setNotifications((items) => [data.notification, ...items]);
        if (data.type === 'memory') { setMemory(null); log(`Memory stored: ${data.item.title}`, 'active'); }
      };
      socket.onclose = () => { if (!disposed) reconnect = window.setTimeout(connect, 1500); };
    };
    connect();
    return () => { disposed = true; if (reconnect) clearTimeout(reconnect); socketRef.current?.close(); };
  }, []);

  useEffect(() => {
    if (page === 'system' && !system) loadJson<{ generatedAt: string; surfaces: SystemSurface[] }>(apiUrl('/api/workspace/system'), setSystem, 'System map could not be built.');
    if (page === 'rigor' && !rigor) loadJson<RigorState>(apiUrl('/api/agents/rigor'), setRigor, 'Rigor agents could not be loaded.');
    if (page === 'rigor' && !localModel) loadJson<LocalModelState>(apiUrl('/api/local-model/status'), setLocalModel, 'Local model status could not be loaded.');
    if (page === 'memory' && !memory) loadJson<MemoryState>(apiUrl('/api/memory'), setMemory, 'Memory could not be loaded.');
    if ((page === 'files' || page === 'downloads') && !files.length) loadJson<{ files: FileItem[] }>(apiUrl('/api/workspace/files'), (data) => setFiles(data.files || []), 'Downloads could not be read.');
    if (page === 'slides' && !slides.length) loadJson<{ slides: FileItem[] }>(apiUrl('/api/workspace/slides'), (data) => setSlides(data.slides || []), 'Slides could not be read.');
    if (page === 'notes' && !notes.length) loadJson<{ notes: FileItem[] }>(apiUrl('/api/workspace/notes'), (data) => setNotes(data.notes || []), 'Notes could not be read.');
    if (page === 'gallery' && !gallery.length) loadJson<{ media: FileItem[] }>(apiUrl('/api/workspace/gallery'), (data) => setGallery(data.media || []), 'Gallery could not be read.');
    if (page === 'dependencies' && !dependencies.length) loadJson<{ files: FileItem[] }>(apiUrl('/api/workspace/dependencies'), (data) => setDependencies(data.files || []), 'Dependency graph could not be read.');
    if (page === 'notifications' && !notifications.length) loadJson<{ notifications: Notification[] }>(apiUrl('/api/workspace/notifications'), (data) => setNotifications(data.notifications || []), 'Notification inbox could not be read.');
  }, [page, files.length, slides.length, notes.length, gallery.length, dependencies.length, notifications.length, system, rigor, localModel, memory]);

  const modelLabel = useMemo(() => observer.model.connected ? `${observer.model.model} / Interactions` : 'Gemini not configured', [observer.model]);

  async function observerCommand(command: 'start' | 'pause' | 'analyze') {
    setBusy(command === 'analyze');
    try {
      const response = await fetch(apiUrl(`/api/observer/${command}`), { method: 'POST' });
      setObserver(await response.json());
      log(command === 'pause' ? 'Continuous observation paused.' : command === 'start' ? 'Continuous observation resumed.' : 'Manual screen analysis requested.', 'active');
    } catch { setBusy(false); log('Observer command failed.', 'warning'); }
  }

  async function startNativeCompanion() {
    try {
      const response = await fetch(apiUrl('/api/companion/start'), { method: 'POST' });
      const data = await response.json();
      setCompanion(data);
      log(data.running ? `Native desktop companion running as PID ${data.pid}.` : 'Native desktop companion requested.', 'active');
    } catch {
      log('Native desktop companion could not be launched.', 'warning');
    }
  }

  async function readClipboardNow() {
    setBusy(true);
    try {
      const response = await fetch(apiUrl('/api/workspace/clipboard'));
      const data = await response.json();
      setClipboard(data);
      log(`Clipboard read as ${data.kind}.`, 'active');
    } catch { log('Clipboard could not be read.', 'warning'); }
    finally { setBusy(false); }
  }

  async function askGemini(input: string, instruction: string) {
    setBusy(true); setAnalysis('');
    try {
      const response = await fetch(apiUrl('/api/interactions/ask'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, systemInstruction: instruction, withMemory: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAnalysis(data.output || 'Gemini returned no text.');
      log('Gemini interaction completed.', 'active');
    } catch (error) {
      setAnalysis(error instanceof Error ? error.message : 'Gemini interaction failed.');
      log('Gemini interaction failed.', 'warning');
    } finally { setBusy(false); }
  }

  function refreshCurrent() {
    setAnalysis('');
    if (page === 'system') setSystem(null);
    if (page === 'rigor') { setRigor(null); setLocalModel(null); }
    if (page === 'memory') { setMemory(null); setRecallMatches([]); }
    if (page === 'slides') setSlides([]);
    if (page === 'notes') setNotes([]);
    if (page === 'gallery') setGallery([]);
    if (page === 'dependencies') setDependencies([]);
    if (page === 'files' || page === 'downloads') setFiles([]);
    if (page === 'notifications') setNotifications([]);
  }

  async function testLocalModel() {
    setBusy(true);
    try {
      const response = await fetch(apiUrl('/api/local-model/test'), { method: 'POST' });
      const data = await response.json();
      setLocalModel(data);
      if (!response.ok) throw new Error(data.error);
      log(`Local Gemma replied: ${data.output}`, 'active');
    } catch {
      log('Local Gemma is not ready yet.', 'warning');
    } finally {
      setBusy(false);
    }
  }

  async function seedSystemMemory() {
    setBusy(true);
    try {
      const response = await fetch(apiUrl('/api/memory/seed-system'), { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMemory(null);
      log(`Remembered: ${data.episode.title}`, 'active');
    } catch {
      log('System memory could not be seeded.', 'warning');
    } finally {
      setBusy(false);
    }
  }

  async function recallNow() {
    setBusy(true);
    try {
      const response = await fetch(apiUrl('/api/memory/recall'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: recallQuery, limit: 8 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setRecallMatches(data.matches || []);
      log(`Memory recalled ${data.matches?.length || 0} item${data.matches?.length === 1 ? '' : 's'}.`, 'active');
    } catch {
      log('Memory recall failed.', 'warning');
    } finally {
      setBusy(false);
    }
  }

  const pages: Array<{ id: Page; label: string; note: string; glyph: string }> = [
    { id: 'screen', label: 'Screen', note: 'Whole-desktop perception', glyph: 'S' },
    { id: 'notes', label: 'Notes', note: 'Concept linking', glyph: 'N' },
    { id: 'gallery', label: 'Gallery', note: 'Media meaning', glyph: 'G' },
    { id: 'files', label: 'Files', note: 'Reference risk', glyph: 'F' },
    { id: 'downloads', label: 'Downloads', note: 'Why do I exist?', glyph: 'D' },
    { id: 'dependencies', label: 'Graph', note: 'Downstream impact', glyph: 'R' },
    { id: 'clipboard', label: 'Clipboard', note: 'Intent buffer', glyph: 'C' },
    { id: 'notifications', label: 'Notifications', note: 'Project clusters', glyph: 'B' }
  ];

  return <main className="shell">
    <header className="topbar glass">
      <div className="identity"><span className={`pulse ${observer.running ? 'live' : ''}`} /><div><strong>Persistent Computer</strong><small>Persistent computer layer</small></div></div>
      <div className="top-actions">
        <span className={`model-state ${observer.model.connected ? 'ready' : ''}`}>{modelLabel}</span>
        <button className="icon-button" title={voice ? 'Mute voice' : 'Enable voice'} onClick={() => setVoice((value) => !value)}>{voice ? 'Voice on' : 'Voice off'}</button>
        <button className="icon-button" title="Launch native desktop companion" onClick={startNativeCompanion}>{companion.running ? 'Companion live' : 'Desktop cursor'}</button>
        <button className="quiet-button" onClick={() => observerCommand(observer.running ? 'pause' : 'start')}>{observer.running ? 'Pause' : 'Resume'}</button>
      </div>
    </header>

    <section className="workspace">
      <aside className="rail glass">
        <div className="rail-title"><span>Living agents</span><strong>{observer.running ? 'Watching' : 'Paused'}</strong></div>
        <nav>{pages.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => { setPage(item.id); setAnalysis(''); }}><span className="nav-icon">{item.glyph}</span><div><strong>{item.label}</strong><small>{item.note}</small></div></button>)}</nav>
        <div className="privacy-note"><span>Visible authority</span><p>Screen frames are the global context. Files and media use metadata first. Clipboard requires a click. Fix actions stay reversible.</p></div>
      </aside>

      <section className="stage">
        {page === 'screen' && <ScreenPage frame={frame} observer={observer} busy={busy} onAnalyze={() => observerCommand('analyze')} />}
        {page === 'notes' && <AgentPage title="Living Notes" subtitle="Concept linker" description="Recent notes with previews. The agent looks for old concepts that connect to the new one." items={notes} busy={busy} analysis={analysis} onRefresh={refreshCurrent} actionLabel="Find links" onAnalyze={(file) => askGemini(`Note metadata and preview:\n${JSON.stringify(file)}`, 'You are the notes agent. Identify likely concept links, unknown invented terms, and one question to ask the user if meaning is ambiguous.')} />}
        {page === 'gallery' && <AgentPage title="Living Gallery" subtitle="Media memory" description="Recent pictures, screenshots, and videos. Useful for one-of-a-kind deletion warnings and confusing screenshot triage." items={gallery} busy={busy} analysis={analysis} onRefresh={refreshCurrent} actionLabel="Explain asset" onAnalyze={(file) => askGemini(`Media file metadata:\n${JSON.stringify(file)}`, 'You are the gallery agent. Infer likely purpose from filename, folder, and timestamp only. Flag whether deletion should be cautious.')} />}
        {page === 'files' && <AgentPage title="Living Files" subtitle="Workspace references" description="Files become objects with dependency, memory, and downstream context." items={dependencies.length ? dependencies : files} busy={busy} analysis={analysis} onRefresh={refreshCurrent} actionLabel="Assess risk" onAnalyze={(file) => askGemini(`File candidate:\n${JSON.stringify(file)}`, 'You are the file guardian. Explain what could break if this file is deleted, what evidence exists, and offer archive, fork, or remove-reference options.')} />}
        {page === 'downloads' && <AgentPage title="Living Downloads" subtitle="Autosorting queue" description="Real recent Downloads. Every item asks why it exists before becoming clutter." items={files} busy={busy} analysis={analysis} onRefresh={refreshCurrent} actionLabel="Why exist?" onAnalyze={(file) => askGemini(`A user downloaded this file:\n${JSON.stringify(file)}\nInfer likely purpose from filename and metadata only.`, 'You are Living Downloads. Suggest destination, retention policy, and uncertainty. Never claim to read contents.')} />}
        {page === 'dependencies' && <DependencyPage items={dependencies} busy={busy} analysis={analysis} onRefresh={refreshCurrent} onAnalyze={(file) => askGemini(`Dependency risk object:\n${JSON.stringify(file)}`, 'You are the dependency graph agent. Describe likely imports, downstream documents, and a safe deletion protocol from the available evidence.')} />}
        {page === 'clipboard' && <ClipboardPage clipboard={clipboard} busy={busy} analysis={analysis} onRead={readClipboardNow} onUnderstand={() => clipboard && askGemini(`Clipboard content:\n${clipboard.text}`, 'Infer immediate user intent and offer paste transformations such as citation, Markdown, BibTeX, LaTeX figure, or plain text. Do not retain secrets.')} />}
        {page === 'notifications' && <NotificationsPage items={notifications} busy={busy} analysis={analysis} onCluster={() => askGemini(`Notifications:\n${notifications.map((item) => `${item.source} | ${item.project} | ${item.text}`).join('\n')}`, 'Cluster these notifications by project, summarize what matters, and suggest one next action.')} />}
      </section>

      <aside className="inspector glass">
        <div className="inspector-heading"><span>Pushback</span><small>{intervention?.application || 'No active intervention'}</small></div>
        {intervention ? <article className={`intervention ${intervention.severity}`}><div className="severity">{intervention.severity}</div><h2>{intervention.title}</h2><p>{intervention.reason}</p>{intervention.evidence?.length ? <div className="evidence"><strong>Grounded evidence</strong>{intervention.evidence.map((item) => <span key={item}>{item}</span>)}</div> : null}<div className="decision-actions"><button className="primary-action" onClick={() => setPage('screen')}>Investigate</button><button onClick={() => setIntervention(null)}>Dismiss</button></div></article> : <div className="quiet-state"><span>OK</span><strong>Nothing needs your attention</strong><p>The companion stays quiet until it has grounded evidence from screen or workspace agents.</p></div>}
        <div className="activity-heading"><strong>Runtime log</strong><small>{logs.length} events</small></div>
        <div className="event-list">{logs.length ? logs.map((item) => <div className={`event ${item.tone}`} key={item.id}><time>{item.time}</time><p>{item.label}</p></div>) : <div className="event"><time>Now</time><p>Persistent computer is connected.</p></div>}</div>
      </aside>
    </section>
  </main>;
}

function ScreenPage({ frame, observer, busy, onAnalyze }: { frame: string; observer: ObserverState; busy: boolean; onAnalyze: () => void }) {
  return <div className="surface screen-surface"><div className="screen-frame">{frame ? <img src={frame} alt="Live desktop observation" /> : <div className="empty-screen"><span className="pulse live" /><strong>Waiting for the desktop</strong><small>The Windows capture service is starting.</small></div>}<div className="screen-shade" /><div className="capture-status glass"><span className={observer.running ? 'live-dot' : ''} />{observer.running ? 'Live screen' : 'Screen paused'}<small>{time(observer.lastCaptureAt)}</small></div>{busy && <div className="scan-line" />}</div><div className="surface-footer glass"><button className="primary" onClick={onAnalyze} disabled={busy}>{busy ? 'Analyzing...' : 'Analyze now'}</button><div><strong>Continuous perception</strong><small>Screen understanding is the top-level context for every other agent.</small></div></div></div>;
}

function SystemPage({ system, frame, busy, onRefresh, onSynthesize }: { system: SystemMap | null; frame: string; busy: boolean; onRefresh: () => void; onSynthesize: () => void }) {
  return <div className="surface data-surface"><div className="surface-heading"><div><span>Whole System</span><h2>Computer world model</h2><p>One map of screens, files, notes, media, clipboard, downloads, and interruptions.</p></div><div className="format-actions"><button onClick={onRefresh}>Refresh</button><button className="primary" onClick={onSynthesize} disabled={busy || !system}>Synthesize</button></div></div><div className="system-grid"><section className="world-frame">{frame ? <img src={frame} alt="Current desktop frame" /> : <div className="empty-data"><strong>No frame yet</strong><p>Start observation to build the screen layer.</p></div>}</section><section className="surface-list">{(system?.surfaces || []).map((surface) => <article className="system-row" key={surface.id}><span>{surface.count}</span><div><strong>{surface.label}</strong><p>{surface.authority}</p></div><small>{surface.status}</small></article>)}</section></div></div>;
}

function RigorPage({ rigor, localModel, busy, onRefresh, onTestLocal }: { rigor: RigorState | null; localModel: LocalModelState | null; busy: boolean; onRefresh: () => void; onTestLocal: () => void }) {
  return <div className="surface data-surface"><div className="surface-heading"><div><span>Development Rigor</span><h2>Agent readiness</h2><p>Evidence, gaps, and next executable loops. This is where the idea gets held to account.</p></div><button onClick={onRefresh}>Refresh</button></div><section className="rigor-summary"><article><span>{rigor?.average || 0}</span><strong>System score</strong><p>{rigor?.verdict || 'Loading project rigor.'}</p></article><article><span>{rigor?.sourceCount || 0}</span><strong>Source files</strong><p>Implementation surface currently scanned.</p></article><article className={localModel?.ready ? 'ready' : 'warning'}><span>{localModel?.ready ? 'On' : 'Off'}</span><strong>Local model</strong><p>{localModel?.service === 'online' ? `${localModel.models.length} Ollama models visible` : localModel?.pullCommand || 'Waiting for backend status'}</p></article></section><section className="local-model-panel"><div><strong>Local model lane</strong><p>{localModel?.ready ? `${localModel.targetModel} is ready for private local reasoning.` : localModel ? `Target ${localModel.targetModel} is waiting for Ollama at ${localModel.host}.` : 'Loading local model configuration.'}</p>{localModel?.error ? <small>{localModel.error}</small> : null}</div><button className="primary" onClick={onTestLocal} disabled={busy}>Test Local</button></section><div className="rigor-grid">{(rigor?.agents || []).map((agent) => <article className="rigor-card" key={agent.id}><header><div><strong>{agent.label}</strong><span>{agent.maturity}</span></div><b>{agent.score}</b></header><p>{agent.mission}</p><section><strong>Evidence</strong>{agent.evidence.map((item) => <small key={item}>{item}</small>)}</section><section><strong>Gaps</strong>{agent.gaps.map((item) => <small key={item}>{item}</small>)}</section><footer>{agent.next}</footer></article>)}</div></div>;
}

function MemoryPage({ memory, busy, query, matches, onQuery, onRecall, onSeed, onRefresh }: { memory: MemoryState | null; busy: boolean; query: string; matches: Array<(MemoryFact | MemoryEpisode) & { kind?: string; score?: number }>; onQuery: (value: string) => void; onRecall: () => void; onSeed: () => void; onRefresh: () => void }) {
  const facts = memory?.facts || [];
  const episodes = memory?.episodes || [];
  const associations = memory?.associations || [];
  return <div className="surface data-surface"><div className="surface-heading"><div><span>Living Memory</span><h2>Recall layer</h2><p>Persistent facts, episodes, and cross-surface associations used by every Gemini interaction.</p></div><div className="format-actions"><button onClick={onRefresh}>Refresh</button><button className="primary" onClick={onSeed} disabled={busy}>Remember system</button></div></div><section className="memory-search"><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search memory..." /><button onClick={onRecall} disabled={busy}>Recall</button></section><section className="memory-stats"><article><span>{memory?.stats?.facts || 0}</span><strong>Facts</strong></article><article><span>{memory?.stats?.episodes || 0}</span><strong>Episodes</strong></article><article><span>{memory?.stats?.associations || 0}</span><strong>Links</strong></article></section>{matches.length ? <section className="memory-block"><header><strong>Recall results</strong><span>{matches.length}</span></header>{matches.map((item) => <article className="memory-item" key={`${item.kind}-${item.id}`}><span>{item.kind || 'memory'}</span><div><strong>{item.title}</strong><p>{'text' in item ? item.text : item.summary}</p></div><small>{Math.round((item.score || 0) * 100)}%</small></article>)}</section> : null}<section className="memory-columns"><div className="memory-block"><header><strong>Facts</strong><span>{facts.length}</span></header>{facts.map((fact) => <article className="memory-card" key={fact.id}><strong>{fact.title}</strong><p>{fact.text}</p><small>{fact.tags?.join(', ') || fact.source}</small></article>)}</div><div className="memory-block"><header><strong>Episodes</strong><span>{episodes.length}</span></header>{episodes.map((episode) => <article className="memory-card" key={episode.id}><strong>{episode.title}</strong><p>{episode.summary}</p><small>{episode.surfaces?.join(', ') || episode.source}</small></article>)}</div></section><section className="memory-block"><header><strong>Associations</strong><span>{associations.length}</span></header>{associations.map((association) => <article className="association-row" key={association.id}><span>{association.from}</span><strong>{association.to}</strong><p>{association.relation}</p></article>)}</section></div>;
}

function AgentPage({ title, subtitle, description, items, busy, analysis, onRefresh, actionLabel, onAnalyze }: { title: string; subtitle: string; description: string; items: FileItem[]; busy: boolean; analysis: string; onRefresh: () => void; actionLabel: string; onAnalyze: (file: FileItem) => void }) {
  return <div className="surface data-surface"><div className="surface-heading"><div><span>{title}</span><h2>{subtitle}</h2><p>{description}</p></div><button onClick={onRefresh}>Refresh</button></div><div className="file-list">{items.length ? items.map((file) => <article className="file-row" key={file.path}><span className="file-kind">{file.type.slice(0, 1)}</span><div><strong title={file.path}>{file.name}</strong><small>{fileMeta(file)}</small>{file.preview ? <p className="row-preview">{file.preview}</p> : null}</div><button onClick={() => onAnalyze(file)} disabled={busy}>{actionLabel}</button></article>) : <div className="empty-data"><strong>No objects found</strong><p>This agent is ready; it needs matching local files.</p></div>}</div>{analysis && <div className="ai-result"><span>Gemini Interaction</span><p>{analysis}</p></div>}</div>;
}

function DependencyPage({ items, busy, analysis, onRefresh, onAnalyze }: { items: FileItem[]; busy: boolean; analysis: string; onRefresh: () => void; onAnalyze: (file: FileItem) => void }) {
  return <div className="surface data-surface"><div className="surface-heading"><div><span>Dependency Graph</span><h2>Deletion pushback</h2><p>Heuristic scan of this workspace. This is the seed of the train.py warning behavior.</p></div><button onClick={onRefresh}>Refresh</button></div><div className="file-list">{items.map((file) => <article className={`file-row risk-${file.risk || 'low'}`} key={file.path}><span className="file-kind">{(file.risk || 'L').slice(0, 1).toUpperCase()}</span><div><strong title={file.path}>{file.name}</strong><small>{file.references || 0} references / {file.signals?.join(', ') || 'metadata only'}</small></div><button onClick={() => onAnalyze(file)} disabled={busy}>Safe delete?</button></article>)}</div>{analysis && <div className="ai-result"><span>Risk briefing</span><p>{analysis}</p></div>}</div>;
}

function ClipboardPage({ clipboard, busy, analysis, onRead, onUnderstand }: { clipboard: { text: string; kind: string; length: number } | null; busy: boolean; analysis: string; onRead: () => void; onUnderstand: () => void }) {
  return <div className="surface data-surface"><div className="surface-heading"><div><span>Living Clipboard</span><h2>Intent buffer</h2><p>Nothing is read until you press the button.</p></div><button className="primary" onClick={onRead} disabled={busy}>Read clipboard</button></div>{clipboard ? <article className="clipboard-card"><div className="clipboard-meta"><span>{clipboard.kind}</span><small>{clipboard.length} characters</small></div><pre>{clipboard.text || 'Clipboard contains no text.'}</pre><div className="format-actions"><button onClick={onUnderstand} disabled={busy}>Understand intent</button><button onClick={() => navigator.clipboard.writeText(clipboard.text)}>Plain text</button></div></article> : <div className="empty-data"><strong>Your clipboard remains private</strong><p>Read it once to generate contextual paste options.</p></div>}{analysis && <div className="ai-result"><span>Suggested transformations</span><p>{analysis}</p></div>}</div>;
}

function NotificationsPage({ items, busy, analysis, onCluster }: { items: Notification[]; busy: boolean; analysis: string; onCluster: () => void }) {
  const groups = items.reduce<Record<string, Notification[]>>((result, item) => { (result[item.project] ||= []).push(item); return result; }, {});
  return <div className="surface data-surface"><div className="surface-heading"><div><span>Living Notifications</span><h2>Context, not interruption</h2><p>Local inbox items grouped by project instead of application.</p></div><button className="primary" onClick={onCluster} disabled={busy || !items.length}>Ask Gemini to merge</button></div><div className="notification-groups">{Object.entries(groups).map(([project, entries]) => <section className="notification-group" key={project}><header><strong>{project}</strong><span>{entries.length} related</span></header>{entries.map((item) => <div className="notification-row" key={item.id}><span>{item.source}</span><p>{item.text}</p><time>{time(item.createdAt)}</time></div>)}</section>)}</div>{analysis && <div className="ai-result"><span>Merged briefing</span><p>{analysis}</p></div>}</div>;
}
