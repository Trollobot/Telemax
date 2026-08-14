import { useEffect, useRef, useState } from 'react';
import { Activity, KeyRound, MessageSquare, Server, Settings, Shield } from 'lucide-react';
import { apiFetch, clearStoredApiKey, getStoredApiKey, openStatusSocket, setStoredApiKey } from './api';

interface LogEntry {
  time: string;
  opcode: string;
  dir: string;
  size: string;
  payload: string;
}

interface StatusData {
  max: boolean;
  tg: boolean;
  deviceId: string;
  phone: string;
  latencyMs: number | null;
}

interface Metrics {
  packetsSent: number;
  packetsReceived: number;
  uptimeSeconds: number;
}

interface ChatMapping {
  maxChatId: number;
  telegramTopicId: number;
  title?: string;
  createdAt: string;
}

interface MaxChat {
  id: number;
  type: string;
  displayName: string;
  newMessages?: number;
  lastMessage?: { text?: string; sender?: number };
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function ApiKeyGate({ onSubmit, error }: { onSubmit: (key: string) => void; error: string }) {
  const [value, setValue] = useState('');
  return (
    <div className="min-h-screen bg-[#0c0d0f] text-slate-300 flex items-center justify-center">
      <div className="w-full max-w-sm bg-[#141518] p-6 rounded-lg border border-white/10 shadow-xl">
        <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
          <KeyRound className="text-blue-500" size={20} /> API Key
        </h2>
        <p className="text-xs text-slate-500 mb-4">Требуется для доступа к бриджу (см. API_KEY на сервере).</p>
        {error && <div className="mb-3 p-2 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-xs">{error}</div>}
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit(value)}
          className="w-full bg-[#0c0d0f] border border-white/10 rounded px-4 py-3 text-sm text-white mb-4 focus:outline-none focus:border-blue-500"
          placeholder="x-api-key"
        />
        <button
          onClick={() => onSubmit(value)}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded text-sm transition-colors"
        >
          Connect
        </button>
      </div>
    </div>
  );
}

export default function App() {
  // Lets the bot's /apikey link (http://host:port/?key=...) log you straight
  // in instead of just pointing at the login form — store it like a normal
  // login and strip it from the URL bar right away so it doesn't linger in
  // history/bookmarks.
  const [apiKey, setApiKey] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('key');
    if (fromUrl) {
      setStoredApiKey(fromUrl);
      window.history.replaceState({}, '', window.location.pathname);
      return fromUrl;
    }
    return getStoredApiKey();
  });
  const [gateError, setGateError] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<StatusData>({ max: false, tg: false, deviceId: '', phone: '', latencyMs: null });
  const [metrics, setMetrics] = useState<Metrics>({ packetsSent: 0, packetsReceived: 0, uptimeSeconds: 0 });
  const [chatMappings, setChatMappings] = useState<ChatMapping[]>([]);
  const [maxChats, setMaxChats] = useState<MaxChat[]>([]);
  const [sendChatId, setSendChatId] = useState('');
  const [sendText, setSendText] = useState('');
  const [sendStatus, setSendStatus] = useState('');
  const [activeTab, setActiveTab] = useState('logs');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [passwordHint, setPasswordHint] = useState('');
  const [authStep, setAuthStep] = useState<'phone' | 'code' | 'password' | 'done'>('phone');
  const [authError, setAuthError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const isSubmitting = useRef(false);

  function handleUnauthorized() {
    clearStoredApiKey();
    setApiKey(null);
    setGateError('Неверный или отозванный API key.');
  }

  function handleGateSubmit(key: string) {
    if (!key.trim()) return;
    setStoredApiKey(key.trim());
    setApiKey(key.trim());
    setGateError('');
  }

  const handleForceStop = async () => {
    await apiFetch('/api/system/stop', { method: 'POST' }).catch(console.error);
  };
  const handleForceStart = async () => {
    await apiFetch('/api/system/start', { method: 'POST' }).catch(console.error);
  };

  const refreshChats = () => {
    apiFetch('/api/chats')
      .then((r: Response) => (r.ok ? r.json() : { data: { chats: [] } }))
      .then((body: { data?: { chats?: MaxChat[] } }) => setMaxChats(body.data?.chats ?? []))
      .catch(() => {});
  };

  const handleSendMessage = async () => {
    if (!sendChatId || !sendText) return;
    setSendStatus('Sending...');
    try {
      const res = await apiFetch(`/api/chats/${sendChatId}/messages`, { method: 'POST', body: JSON.stringify({ text: sendText }) });
      if (res.status === 401) return handleUnauthorized();
      const data = await res.json().catch(() => ({}));
      setSendStatus(res.ok ? `Sent (cid ${data.cid})` : data.error || 'Failed');
      if (res.ok) {
        setSendText('');
        // the server only learns the send succeeded once MAX echoes a confirmation frame back,
        // which lands shortly after this request returns — give it a beat before refetching
        setTimeout(refreshChats, 700);
      }
    } catch {
      setSendStatus('Failed');
    }
  };

  const handleRequestSms = async () => {
    if (isLoading || isSubmitting.current) return;
    isSubmitting.current = true;
    setIsLoading(true);
    setAuthError('');
    try {
      const res = await apiFetch('/api/auth/phone', { method: 'POST', body: JSON.stringify({ phone }) });
      if (res.status === 401) return handleUnauthorized();
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) setAuthError(data.error || 'Failed to request SMS');
      else setAuthStep('code');
    } finally {
      setIsLoading(false);
      isSubmitting.current = false;
    }
  };

  const handleVerifyCode = async () => {
    if (isLoading || isSubmitting.current) return;
    isSubmitting.current = true;
    setIsLoading(true);
    setAuthError('');
    try {
      const res = await apiFetch('/api/auth/verify', { method: 'POST', body: JSON.stringify({ code }) });
      if (res.status === 401) return handleUnauthorized();
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) setAuthError(data.error || 'Failed to verify code');
      else if (data.passwordRequired) {
        setPasswordHint(data.hint || '');
        setAuthStep('password');
      } else setAuthStep('done');
    } finally {
      setIsLoading(false);
      isSubmitting.current = false;
    }
  };

  // Only reached for password-protected MAX accounts — verifyCode above
  // returned passwordRequired instead of completing the login directly. A
  // wrong password can be retried freely (the server keeps the same
  // trackId), so this deliberately doesn't fall back to the code step.
  const handleVerifyPassword = async () => {
    if (isLoading || isSubmitting.current) return;
    isSubmitting.current = true;
    setIsLoading(true);
    setAuthError('');
    try {
      const res = await apiFetch('/api/auth/password', { method: 'POST', body: JSON.stringify({ password }) });
      if (res.status === 401) return handleUnauthorized();
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) setAuthError(data.error || 'Failed to verify password');
      else setAuthStep('done');
    } finally {
      setIsLoading(false);
      isSubmitting.current = false;
    }
  };

  useEffect(() => {
    if (!apiKey) return;

    let cancelled = false;

    apiFetch('/api/status')
      .then((r: Response) => {
        if (r.status === 401) throw new Error('unauthorized');
        return r.json();
      })
      .then((data: { packetsSent: number; packetsReceived: number; uptimeSeconds: number; maxOnline: boolean; tgActive: boolean; deviceId: string; phone: string; latencyMs: number | null }) => {
        if (cancelled) return;
        setMetrics({ packetsSent: data.packetsSent, packetsReceived: data.packetsReceived, uptimeSeconds: data.uptimeSeconds });
        setStatus({ max: data.maxOnline, tg: data.tgActive, deviceId: data.deviceId, phone: data.phone, latencyMs: data.latencyMs });
        if (data.phone) setAuthStep('done');
      })
      .catch((err: Error) => {
        if (!cancelled && err.message === 'unauthorized') handleUnauthorized();
      });

    apiFetch('/api/chat-mappings')
      .then((r: Response) => (r.ok ? r.json() : { data: [] }))
      .then((body: { data?: ChatMapping[] }) => !cancelled && setChatMappings(body.data ?? []))
      .catch(() => {});

    apiFetch('/api/chats')
      .then((r: Response) => (r.ok ? r.json() : { data: { chats: [] } }))
      .then((body: { data?: { chats?: MaxChat[] } }) => !cancelled && setMaxChats(body.data?.chats ?? []))
      .catch(() => {});

    const ws = openStatusSocket();
    ws.onmessage = (event: MessageEvent<string>) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'init_logs') setLogs(msg.data);
      else if (msg.type === 'log') setLogs((prev) => [...prev, msg.data].slice(-50));
      else if (msg.type === 'status') setStatus(msg.data);
    };

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [apiKey]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  if (!apiKey) return <ApiKeyGate onSubmit={handleGateSubmit} error={gateError} />;

  return (
    <div className="min-h-screen bg-[#0c0d0f] text-slate-300 font-sans flex flex-col overflow-hidden select-none">
      <header className="h-16 border-b border-white/10 bg-[#141518] flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center">
            <span className="text-white font-bold">M</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white tracking-tight">MAX Bridge</h1>
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Real-time Protocol Proxy & Sync</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${status.max ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
            <span className="text-xs font-medium uppercase">MAX TCP: {status.max ? 'Online' : 'Offline'}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${status.tg ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
            <span className="text-xs font-medium uppercase">TG Bot: {status.tg ? 'Active' : 'Offline'}</span>
          </div>
          {status.max ? (
            <button onClick={handleForceStop} className="px-4 py-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-500/50 rounded text-red-400 text-xs font-bold">
              FORCE STOP
            </button>
          ) : (
            <button onClick={handleForceStart} className="px-4 py-1.5 bg-green-600/20 hover:bg-green-600/40 border border-green-500/50 rounded text-green-400 text-xs font-bold">
              RECONNECT
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <aside className="w-72 border-r border-white/5 bg-[#0f1012] p-6 flex flex-col gap-8">
          <section>
            <h3 className="text-[10px] text-slate-500 uppercase font-bold mb-4 tracking-wider flex items-center gap-2">
              <Server size={14} /> Connection
            </h3>
            <div className="space-y-4">
              <div className="p-3 bg-white/5 rounded border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase mb-1">Latency</div>
                <div className="font-mono text-sm text-blue-300">{status.latencyMs != null ? `${status.latencyMs} ms` : '—'}</div>
              </div>
              <div className="p-3 bg-white/5 rounded border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase mb-1">Uptime</div>
                <div className="text-xs text-white">{formatUptime(metrics.uptimeSeconds)}</div>
              </div>
            </div>
          </section>

          <section className="flex-1">
            <h3 className="text-[10px] text-slate-500 uppercase font-bold mb-4 tracking-wider flex items-center gap-2">
              <Shield size={14} /> Active Session
            </h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Phone</span>
                <span className="text-white">{status.phone || 'Not authenticated'}</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Device ID</span>
                <span className="text-white font-mono truncate max-w-[120px]">{status.deviceId || '—'}</span>
              </div>
            </div>
          </section>
        </aside>

        <div className="flex-1 flex flex-col bg-[#0c0d0f]">
          <div className="h-14 border-b border-white/5 flex items-center px-6 gap-8">
            <button onClick={() => setActiveTab('logs')} className={`text-xs font-bold h-full flex items-center gap-2 ${activeTab === 'logs' ? 'text-white border-b-2 border-blue-500' : 'text-slate-500'}`}>
              <Activity size={16} /> Live Protocol Logs
            </button>
            <button onClick={() => setActiveTab('chats')} className={`text-xs font-bold h-full flex items-center gap-2 ${activeTab === 'chats' ? 'text-white border-b-2 border-blue-500' : 'text-slate-500'}`}>
              <MessageSquare size={16} /> MAX Chats
            </button>
            <button onClick={() => setActiveTab('mapping')} className={`text-xs font-bold h-full flex items-center gap-2 ${activeTab === 'mapping' ? 'text-white border-b-2 border-blue-500' : 'text-slate-500'}`}>
              <MessageSquare size={16} /> Chat Mapping
            </button>
            <button onClick={() => setActiveTab('config')} className={`text-xs font-bold h-full flex items-center gap-2 ${activeTab === 'config' ? 'text-white border-b-2 border-blue-500' : 'text-slate-500'}`}>
              <Settings size={16} /> Configuration
            </button>
          </div>

          <div className="flex-1 p-6 flex flex-col gap-6 overflow-hidden">
            {activeTab === 'logs' && (
              <div className="flex-1 border border-white/5 bg-[#0f1012] rounded-lg overflow-hidden flex flex-col">
                <div className="grid grid-cols-6 gap-4 p-4 bg-white/5 text-[10px] uppercase font-bold text-slate-500 border-b border-white/5">
                  <div>Timestamp</div>
                  <div>OpCode</div>
                  <div className="text-center">Dir</div>
                  <div>Length</div>
                  <div className="col-span-2">Payload (masked)</div>
                </div>
                <div className="flex-1 overflow-auto font-mono text-[11px] divide-y divide-white/[0.03]">
                  {logs.length === 0 && <div className="p-4 text-center text-slate-500 italic">Waiting for traffic...</div>}
                  {logs.map((log, i) => (
                    <div key={i} className="grid grid-cols-6 gap-4 p-4 items-center">
                      <div className="text-slate-500">{log.time}</div>
                      <div className="font-bold text-blue-300">{log.opcode}</div>
                      <div className="text-center">
                        <span className="bg-white/10 px-2 py-0.5 rounded font-bold">{log.dir}</span>
                      </div>
                      <div className="text-slate-400">{log.size}</div>
                      <div className="col-span-2 text-slate-300 truncate opacity-80">{log.payload}</div>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </div>
            )}

            {activeTab === 'config' && (
              <div className="flex-1 bg-[#0f1012] rounded-lg border border-white/5 p-8 flex flex-col items-center justify-center">
                <div className="max-w-md w-full bg-[#141518] p-6 rounded-lg border border-white/10 shadow-xl">
                  <h2 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
                    <Shield className="text-blue-500" /> MAX Authentication
                  </h2>
                  {authError && <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded text-red-400 text-sm">{authError}</div>}
                  {authStep === 'phone' && (
                    <div className="space-y-4">
                      <input
                        type="text"
                        placeholder="+7 999 123 45 67"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="w-full bg-[#0c0d0f] border border-white/10 rounded px-4 py-3 text-sm text-white"
                      />
                      <button onClick={handleRequestSms} disabled={isLoading} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 rounded text-sm">
                        {isLoading ? 'Requesting...' : 'Request SMS Code'}
                      </button>
                    </div>
                  )}
                  {authStep === 'code' && (
                    <div className="space-y-4">
                      <input
                        type="text"
                        placeholder="123456"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        className="w-full bg-[#0c0d0f] border border-white/10 rounded px-4 py-3 text-sm text-white font-mono tracking-widest"
                      />
                      <div className="flex gap-2">
                        <button onClick={() => setAuthStep('phone')} className="w-1/3 bg-white/10 hover:bg-white/20 text-white font-bold py-3 rounded text-sm">
                          Back
                        </button>
                        <button onClick={handleVerifyCode} disabled={isLoading} className="w-2/3 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-bold py-3 rounded text-sm">
                          {isLoading ? 'Verifying...' : 'Verify & Login'}
                        </button>
                      </div>
                    </div>
                  )}
                  {authStep === 'password' && (
                    <div className="space-y-4">
                      <p className="text-sm text-white/60">Этот MAX-аккаунт защищён паролем (второй фактор поверх SMS).</p>
                      {passwordHint && <p className="text-sm text-white/60">Подсказка: {passwordHint}</p>}
                      <input
                        type="password"
                        placeholder="Пароль"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full bg-[#0c0d0f] border border-white/10 rounded px-4 py-3 text-sm text-white"
                      />
                      <button onClick={handleVerifyPassword} disabled={isLoading} className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-bold py-3 rounded text-sm">
                        {isLoading ? 'Verifying...' : 'Verify & Login'}
                      </button>
                    </div>
                  )}
                  {authStep === 'done' && (
                    <div className="text-center space-y-4 py-8">
                      <div className="w-16 h-16 bg-green-500/20 text-green-500 rounded-full flex items-center justify-center mx-auto">
                        <Shield size={32} />
                      </div>
                      <h3 className="text-white font-bold text-lg">Authenticated as {status.phone}</h3>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'chats' && (
              <div className="flex-1 flex flex-col gap-4 overflow-hidden">
                <div className="bg-[#141518] p-4 rounded-lg border border-white/10 flex gap-3 items-center shrink-0">
                  <input
                    type="text"
                    placeholder="chatId"
                    value={sendChatId}
                    onChange={(e) => setSendChatId(e.target.value)}
                    className="w-32 bg-[#0c0d0f] border border-white/10 rounded px-3 py-2 text-sm text-white font-mono"
                  />
                  <input
                    type="text"
                    placeholder="Текст сообщения"
                    value={sendText}
                    onChange={(e) => setSendText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    className="flex-1 bg-[#0c0d0f] border border-white/10 rounded px-3 py-2 text-sm text-white"
                  />
                  <button onClick={handleSendMessage} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded text-sm">
                    Send
                  </button>
                  {sendStatus && <span className="text-xs text-slate-400">{sendStatus}</span>}
                </div>
                <div className="flex-1 bg-[#0f1012] rounded-lg border border-white/5 overflow-hidden flex flex-col">
                  <div className="grid grid-cols-5 gap-4 p-4 bg-white/5 text-[10px] uppercase font-bold text-slate-500 border-b border-white/5">
                    <div>Name</div>
                    <div>chatId</div>
                    <div>Type</div>
                    <div className="col-span-2">Last message</div>
                  </div>
                  <div className="flex-1 overflow-auto font-mono text-[11px] divide-y divide-white/[0.03]">
                    {maxChats.length === 0 && <div className="p-4 text-center text-slate-500 italic">No chats (or not authenticated yet).</div>}
                    {maxChats.map((c) => (
                      <div key={c.id} className="grid grid-cols-5 gap-4 p-4 items-center cursor-pointer hover:bg-white/[0.02]" onClick={() => setSendChatId(String(c.id))}>
                        <div className="text-white font-sans font-semibold truncate">{c.displayName}</div>
                        <div className="text-slate-500">{c.id}</div>
                        <div className="text-slate-400">{c.type}</div>
                        <div className="col-span-2 text-slate-300 truncate">{c.lastMessage?.text ?? '—'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'mapping' && (
              <div className="flex-1 bg-[#0f1012] rounded-lg border border-white/5 overflow-hidden flex flex-col">
                <div className="grid grid-cols-4 gap-4 p-4 bg-white/5 text-[10px] uppercase font-bold text-slate-500 border-b border-white/5">
                  <div>MAX chatId</div>
                  <div>TG topicId</div>
                  <div>Title</div>
                  <div>Created</div>
                </div>
                <div className="flex-1 overflow-auto font-mono text-[11px] divide-y divide-white/[0.03]">
                  {chatMappings.length === 0 && <div className="p-4 text-center text-slate-500 italic">No chat mappings yet — created automatically on first message.</div>}
                  {chatMappings.map((m) => (
                    <div key={m.maxChatId} className="grid grid-cols-4 gap-4 p-4 items-center">
                      <div className="text-white">{m.maxChatId}</div>
                      <div className="text-white">{m.telegramTopicId}</div>
                      <div className="text-slate-300 truncate">{m.title ?? '—'}</div>
                      <div className="text-slate-500">{m.createdAt}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-[#141518] p-5 rounded-lg border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase font-bold mb-2">Packets S/R</div>
                <div className="text-2xl font-light text-white">{metrics.packetsSent} / {metrics.packetsReceived}</div>
              </div>
              <div className="bg-[#141518] p-5 rounded-lg border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase font-bold mb-2">Uptime</div>
                <div className="text-2xl font-light text-white">{formatUptime(metrics.uptimeSeconds)}</div>
              </div>
              <div className="bg-[#141518] p-5 rounded-lg border border-white/5">
                <div className="text-[10px] text-slate-500 uppercase font-bold mb-2">Latency</div>
                <div className="text-2xl font-light text-blue-400 font-mono">{status.latencyMs != null ? `${status.latencyMs}ms` : '—'}</div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
