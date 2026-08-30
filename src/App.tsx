import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { GenerativeSurface } from './surfaces/GenerativeSurface';
import type { SurfaceActionRequest, SurfaceDocument, SurfaceNode } from './surfaces/types';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '');

function apiUrl(path: string) {
  return BACKEND_URL ? `${BACKEND_URL}${path}` : path;
}

function wsUrl(path: string) {
  if (BACKEND_URL) return `${BACKEND_URL.replace(/^http/, 'ws')}${path}`;
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
}

function persistentSessionId() {
  const existing = localStorage.getItem('living-surface-session');
  if (existing) return existing;
  const id = `habitat-${crypto.randomUUID()}`;
  localStorage.setItem('living-surface-session', id);
  return id;
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed with ${response.status}`);
  return data as T;
}

export default function App() {
  const sessionId = useMemo(persistentSessionId, []);
  const [surface, setSurface] = useState<SurfaceDocument | null>(null);
  const [intent, setIntent] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>('compose:');
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const requestSequence = useRef(0);
  const invalidationTimer = useRef<number | null>(null);
  const booted = useRef(false);
  const surfaceRef = useRef<SurfaceDocument | null>(null);
  const lastSelfDrivenChange = useRef(0);

  useEffect(() => { surfaceRef.current = surface; }, [surface]);

  const compose = useCallback(async (utterance = '', reason = 'user-intent') => {
    const sequence = ++requestSequence.current;
    setBusyAction('compose:');
    setError('');
    try {
      const response = await fetch(apiUrl('/api/surfaces/compose'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          utterance,
          focus: utterance || surfaceRef.current?.focus || '',
          reason,
          viewport: { width: window.innerWidth, height: window.innerHeight }
        })
      });
      const data = await responseJson<{ surface: SurfaceDocument }>(response);
      if (sequence === requestSequence.current) setSurface(data.surface);
      return data.surface;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The surface could not be composed.');
      return null;
    } finally {
      if (sequence === requestSequence.current) setBusyAction(null);
    }
  }, [sessionId]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void compose('', 'habitat-opened');
  }, [compose]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      setConnection('connecting');
      socket = new WebSocket(wsUrl('/observer-ws'));
      socket.onopen = () => {
        setConnection('live');
        socket?.send(JSON.stringify({ type: 'surface_subscribe', sessionId }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as { type?: string; sessionId?: string; surface?: SurfaceDocument };
        if (message.type === 'surface_state' && message.sessionId === sessionId && message.surface) setSurface(message.surface);
        if (message.type === 'surface_invalidated') {
          // The action response already carries the regenerated surface; a
          // broadcast caused by our own recent action is an echo, not news.
          const selfEcho = Date.now() - lastSelfDrivenChange.current < 2500;
          if (selfEcho || invalidationTimer.current) {
            if (!selfEcho && invalidationTimer.current) window.clearTimeout(invalidationTimer.current);
            if (selfEcho) return;
          }
          invalidationTimer.current = window.setTimeout(() => { void compose('', 'world-changed'); }, 700);
        }
      };
      socket.onclose = () => {
        setConnection('offline');
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1500);
      };
      socket.onerror = () => setConnection('offline');
    };
    connect();
    return () => {
      disposed = true;
      socket?.close();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (invalidationTimer.current) window.clearTimeout(invalidationTimer.current);
    };
  }, [compose, sessionId]);

  const handleAction = useCallback(async (node: SurfaceNode, action: string, targetId?: string) => {
    if (!surface) return;
    const busyKey = `${action}:${targetId || ''}`;
    lastSelfDrivenChange.current = Date.now();
    setBusyAction(busyKey);
    setError('');
    const request: SurfaceActionRequest = {
      surfaceId: surface.id,
      revision: surface.revision,
      componentId: node.id,
      action,
      ...(targetId ? { targetId } : {})
    };
    try {
      const response = await fetch(apiUrl(`/api/surfaces/${encodeURIComponent(sessionId)}/actions`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      });
      const data = await responseJson<{ surface: SurfaceDocument }>(response);
      setSurface(data.surface);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The generated action failed.');
    } finally {
      setBusyAction(null);
    }
  }, [sessionId, surface]);

  async function submitIntent(event: FormEvent) {
    event.preventDefault();
    const utterance = intent.trim();
    if (!utterance || busyAction) return;
    setIntent('');
    await compose(utterance, 'user-intent');
  }

  const generationLabel = surface?.generation.mode === 'model-composed'
    ? `${surface.generation.provider} · ${surface.generation.model || 'generative composer'}`
    : 'Adaptive boot surface · model provider dormant';

  return <main className="living-shell">
    <header className="living-chrome">
      <div className="brand-lockup"><span className="living-orb" /><div><strong>Living Software</strong><small>The interface is a temporary phenotype</small></div></div>
      <div className="runtime-meta">
        <span className={`connection ${connection}`}>{connection}</span>
        <span>{generationLabel}</span>
        {surface ? <span>revision {surface.revision}</span> : null}
      </div>
    </header>

    <section className="phenotype-stage">
      {surface ? <GenerativeSurface surface={surface} busyAction={busyAction} onAction={handleAction} /> : <div className="surface-loading"><span className="living-orb" /><strong>Composing from live context</strong><p>There are no pages to load. The runtime is deciding which interaction belongs here.</p></div>}
    </section>

    {error ? <div className="surface-error"><strong>Translation failed</strong><span>{error}</span><button onClick={() => void compose('', 'recovery')}>Recompose safely</button></div> : null}

    <form className="intent-composer" onSubmit={submitIntent}>
      <div><span>Present context</span><strong>{surface?.focus || 'What are you trying to make possible?'}</strong></div>
      <input value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="Describe what you need, what changed, or what feels missing…" aria-label="Describe your current intent" />
      <button className="compose-button" disabled={!intent.trim() || Boolean(busyAction)}>{busyAction === 'compose:' ? 'Composing…' : 'Compose interface'}</button>
    </form>
  </main>;
}
