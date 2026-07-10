import { useEffect, useMemo, useRef, useState } from 'react';

type ModelState = {
  connected: boolean;
  model: string | null;
  visionCapable: boolean;
};

type ObserverState = {
  running: boolean;
  lastCaptureAt: string | null;
  model: ModelState;
  privacy?: string;
};

type Intervention = {
  severity: 'quiet' | 'notice' | 'warning' | 'critical';
  application: string;
  title: string;
  reason: string;
  evidence?: string[];
  actions?: string[];
  spoken?: string;
  createdAt?: string;
};

type EventItem = { id: string; time: string; label: string; tone: 'quiet' | 'active' | 'warning' };

const emptyState: ObserverState = {
  running: false,
  lastCaptureAt: null,
  model: { connected: false, model: null, visionCapable: false }
};

function clock(value?: string | null) {
  if (!value) return '--:--';
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function App() {
  const [observer, setObserver] = useState<ObserverState>(emptyState);
  const [frame, setFrame] = useState<string>('');
  const [intervention, setIntervention] = useState<Intervention | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [voice, setVoice] = useState(true);
  const socketRef = useRef<WebSocket | null>(null);

  const addEvent = (label: string, tone: EventItem['tone'] = 'quiet') => {
    setEvents((current) => [{ id: crypto.randomUUID(), time: clock(new Date().toISOString()), label, tone }, ...current].slice(0, 18));
  };

  useEffect(() => {
    fetch('/api/observer/status')
      .then((response) => response.json())
      .then(setObserver)
      .catch(() => addEvent('Observer backend is offline.', 'warning'));

    const socketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${socketProtocol}//${window.location.host}/observer-ws`);
    socketRef.current = socket;
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      if (data.type === 'observer_status') setObserver(data.state);
      if (data.type === 'screen') {
        setFrame(data.image);
        setObserver((current) => ({ ...current, lastCaptureAt: data.capturedAt }));
      }
      if (data.type === 'analysis_started') {
        setAnalyzing(true);
        addEvent(`${data.model} is examining the current screen.`, 'active');
      }
      if (data.type === 'analysis') {
        setAnalyzing(false);
        if (!data.analysis.shouldIntervene) addEvent('No grounded intervention found.');
      }
      if (data.type === 'intervention') {
        setAnalyzing(false);
        setIntervention(data.intervention);
        addEvent(data.intervention.title, 'warning');
        if (voice && data.intervention.spoken && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(data.intervention.spoken));
        }
      }
      if (data.type === 'observer_error') addEvent(data.message, 'warning');
    };
    return () => socket.close();
  }, [voice]);

  const modelLabel = useMemo(() => {
    if (!observer.model.connected) return 'Local model offline';
    if (!observer.model.visionCapable) return `${observer.model.model} · no vision`;
    return observer.model.model || 'Local model';
  }, [observer.model]);

  async function command(name: 'start' | 'pause' | 'analyze') {
    if (name === 'analyze') setAnalyzing(true);
    try {
      const response = await fetch(`/api/observer/${name}`, { method: 'POST' });
      setObserver(await response.json());
      addEvent(name === 'pause' ? 'Observation paused.' : name === 'start' ? 'Observation resumed.' : 'Manual analysis requested.', 'active');
    } catch {
      setAnalyzing(false);
      addEvent('Could not reach the local observer.', 'warning');
    }
  }

  return (
    <main className="shell">
      <header className="topbar glass">
        <div className="identity">
          <span className={`pulse ${observer.running ? 'live' : ''}`} />
          <div><strong>Living Software</strong><small>Local semantic guardian</small></div>
        </div>
        <div className="top-actions">
          <span className={`model-state ${observer.model.connected ? 'ready' : ''}`}>{modelLabel}</span>
          <button className="icon-button" title={voice ? 'Mute voice' : 'Enable voice'} onClick={() => setVoice((current) => !current)}>{voice ? '◉' : '○'}</button>
          <button className="quiet-button" onClick={() => command(observer.running ? 'pause' : 'start')}>{observer.running ? 'Pause' : 'Resume'}</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="rail glass">
          <div className="rail-title"><span>Perception</span><strong>{observer.running ? 'Watching' : 'Paused'}</strong></div>
          <nav>
            <button className="nav-item active"><span className="nav-icon">⌾</span><div><strong>Screen</strong><small>Continuous visual context</small></div></button>
            <button className="nav-item"><span className="nav-icon">▱</span><div><strong>Files</strong><small>Dependency observer</small></div></button>
            <button className="nav-item"><span className="nav-icon">□</span><div><strong>Clipboard</strong><small>Intent buffer</small></div></button>
            <button className="nav-item"><span className="nav-icon">≡</span><div><strong>Notifications</strong><small>Project clustering</small></div></button>
          </nav>
          <div className="privacy-note"><span>Local by default</span><p>Frames stay in memory and are sent only to Ollama at 127.0.0.1.</p></div>
        </aside>

        <section className="stage">
          <div className="screen-frame">
            {frame ? <img src={frame} alt="Live desktop observation" /> : <div className="empty-screen"><span className="pulse live" /><strong>Waiting for the first frame</strong><small>Start the backend observer to connect this computer.</small></div>}
            <div className="screen-shade" />
            <div className="capture-status glass"><span className={observer.running ? 'live-dot' : ''} />{observer.running ? 'Live screen' : 'Screen paused'}<small>{clock(observer.lastCaptureAt)}</small></div>
            {analyzing && <div className="scan-line" />}

            <div className={`companion ${intervention ? 'alerting' : ''}`}>
              <span className="companion-core" />
              <div><strong>{intervention ? 'I need your attention' : analyzing ? 'Understanding this screen' : 'Watching quietly'}</strong><small>{intervention ? intervention.title : 'I will appear when context is at risk.'}</small></div>
            </div>
          </div>

          <div className="stage-controls glass">
            <button onClick={() => command('analyze')} disabled={analyzing}>{analyzing ? 'Analyzing…' : 'Analyze now'}</button>
            <div><strong>Continuous perception</strong><small>Capture every 3.5s · semantic analysis every 15s</small></div>
          </div>
        </section>

        <aside className="inspector glass">
          <div className="inspector-heading"><span>Intervention</span><small>{intervention ? intervention.application : 'No active pushback'}</small></div>
          {intervention ? (
            <article className={`intervention ${intervention.severity}`}>
              <div className="severity">{intervention.severity}</div>
              <h2>{intervention.title}</h2>
              <p>{intervention.reason}</p>
              {!!intervention.evidence?.length && <div className="evidence"><strong>Visible evidence</strong>{intervention.evidence.map((item) => <span key={item}>{item}</span>)}</div>}
              <div className="decision-actions">
                <button className="primary-action">Investigate</button>
                <button onClick={() => setIntervention(null)}>Dismiss</button>
              </div>
              {!!intervention.actions?.length && <div className="proposals">{intervention.actions.map((action) => <button key={action}>{action}</button>)}</div>}
            </article>
          ) : (
            <div className="quiet-state"><span>✓</span><strong>Your context is coherent</strong><p>The guardian has no evidence-based reason to interrupt you.</p></div>
          )}

          <div className="activity-heading"><strong>Observation log</strong><small>{events.length} events</small></div>
          <div className="event-list">
            {events.length ? events.map((event) => <div className={`event ${event.tone}`} key={event.id}><time>{event.time}</time><p>{event.label}</p></div>) : <div className="event quiet"><time>Now</time><p>Connecting to the local runtime.</p></div>}
          </div>
        </aside>
      </section>
    </main>
  );
}
