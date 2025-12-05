import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer, 
  Legend 
} from 'recharts';
import { PlayIcon, StopIcon } from './icons';
import { 
  prettyBytes, 
  timeAgo, 
  formatLog, 
  calculatePerSecond 
} from "./utils";

function LogLine({ text, meta }){
  return (
    <div className="py-1 text-sm font-mono whitespace-pre-wrap">
      {formatLog(text)}
    </div>
  );
}

export default function App(){
  const [status, setStatus] = useState({ 
    running: false, 
    iface: null, 
    ipv6: null, 
    sendPort: null, 
    recvPort: null, 
    uptime: 0 
  });
  const [logs, setLogs] = useState([]);
  const [metrics, setMetrics] = useState({ 
    rxPackets:0, 
    txPackets:0, 
    rxBytes:0, 
    txBytes:0, 
    perSecond: [] 
  });
  const [lastMetrics, setLastMetrics] = useState(null);
  const [perSecond, setPerSecond] = useState([]);
  const [connected, setConnected] = useState(false);
  const logsRef = useRef(logs);
  const esRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(()=>{ 
    logsRef.current = logs; 
  }, [logs]);

  useEffect(()=>{
    async function load(){
      try{
        const s = await axios.get('http://localhost:4000/status');
        setStatus(s.data);
      }catch(e){
        console.error('status fetch failed', e);
      }
    }
    load();
    const t = setInterval(load, 5000);
    return ()=> clearInterval(t);
  }, []);

  useEffect(() => {
    const m = new EventSource("http://localhost:4000/metrics");
    m.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const newMetrics = {
        rxPackets: data.packets_in,
        txPackets: data.packets_out,
        rxBytes: data.bytes_in,
        txBytes: data.bytes_out,
      };
      const delta = calculatePerSecond(newMetrics, lastMetrics);
      if (delta) {
        setPerSecond(prev => {
          const updated = [...prev, delta];
          return updated.slice(-30);
        });
      }
      setMetrics({
        ...newMetrics,
        perSecond: perSecond
      });
      setLastMetrics(newMetrics);
    };
    return () => m.close();
  }, []);

  useEffect(()=>{
    const es = new EventSource('http://localhost:4000/logs');
    esRef.current = es;
    es.onopen = () => { 
      setConnected(true); 
      console.info('SSE connected'); 
    };
    es.onerror = (e) => { 
      setConnected(false);
    };

    es.onmessage = (ev) => {
      let payload = null;
      try { 
        payload = JSON.parse(ev.data); 
      } catch(e) { 
        payload = { 
          type: ev.data.type, 
          msg: ev.data.message, 
          ts: ev.data.ts 
        }; 
      }
      const newest = logsRef.current[0];
      const incomingText = payload.message || String(ev.data.message);
      if (newest && newest.raw === incomingText) 
        return;
      const entry = { 
        raw: incomingText, 
        pretty: incomingText, 
        type: payload.type || 'info', 
        ts: payload.ts || Date.now(), 
        meta: payload.meta || null 
      };
      setLogs(prev => {
        const next = [entry, ...prev];
        if (next.length > 1000) 
          next.length = 1000;
        return next;
      });
    };
    return ()=>{ es.close(); };
  }, []);

  async function startTunnel(form){
    try{
      await axios.post('http://localhost:4000/start');
      setStatus(s => ({ ...s, running: true }));
    }catch(e){ 
      console.error('start failed', e); 
    }
  }

  async function stopTunnel(){
    try{ 
      await axios.post('http://localhost:4000/stop'); 
      setStatus(s => ({ ...s, running: false })); 
    }
    catch(e){ 
      console.error('stop failed', e); 
    }
  }

  function handleActionButton(){
    if(!status.running){
      startTunnel({ 
        ipv6: status.ipv6 || '2001:db8::10/64', 
        sendPort: 5000, 
        recvPort: 5001 
      });
    }else{
      stopTunnel();
    }
  }

  function FlowWidget(){
    const activity = (metrics.rxPackets + metrics.txPackets) > 0;
    return (
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded bg-slate-700 flex items-center justify-center">T</div>
          <div className={`w-24 h-1 rounded ${activity ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`}></div>
          <div className="w-10 h-10 rounded bg-slate-700 flex items-center justify-center">U</div>
        </div>
        <div className="text-xs text-slate-400">Flow: {activity ? 'active' : 'idle'}</div>
      </div>
    );
  }

  function TrafficChart({ metrics }) {
    const data = metrics?.perSecond?.length
      ? metrics.perSecond.slice(-30).map(d => ({
          name: new Date(d.time).toLocaleTimeString(),
          rx: d.rxBytes,
          tx: d.txBytes,
        }))
      : [];
    return (
      <div className="w-full h-48 bg-slate-800 p-2 rounded">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="name" tick={{fontSize:10, fill:'#9ca3af'}} />
            <YAxis tick={{fontSize:10, fill:'#9ca3af'}} />
            <Tooltip wrapperStyle={{ backgroundColor:'#111827', color:'#fff' }} />
            <Legend />
            <Line type="monotone" dataKey="rx" stroke="#34d399" dot={false} name="RX bytes/s" />
            <Line type="monotone" dataKey="tx" stroke="#60a5fa" dot={false} name="TX bytes/s" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  function PacketInspector(){
    const p = logs.find(l => l.type === 'packet');
    if (!p) return (
      <div className="p-3 text-sm text-slate-400">
        Nenhum pacote decodificado ainda
      </div>
    );
    const meta = p.meta || {};
    return (
      <div className="p-3 text-sm">
        <div className="font-semibold">Último pacote</div>
        <div className="text-xs text-slate-400">{new Date(p.ts).toLocaleString()}</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="bg-slate-800 p-2 rounded">From: <div className="font-mono">{meta.src || '-'}</div></div>
          <div className="bg-slate-800 p-2 rounded">To: <div className="font-mono">{meta.dst || '-'}</div></div>
          <div className="bg-slate-800 p-2 rounded">Proto: <div className="font-mono">{meta.proto || '-'}</div></div>
          <div className="bg-slate-800 p-2 rounded">Size: <div className="font-mono">{meta.size || '-'}</div></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 text-white p-6">
      <div className="max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Tun-Proxy Dashboard</h1>
            <div className="text-md text-slate-400">Monitor em tempo real para TUN ↔ UDP proxy</div>
          </div>
          <div className="flex items-center gap-4">
            <div className={`px-3 py-1 rounded ${status.running ? 'bg-emerald-600' : 'bg-rose-600'}`}>{status.running ? 'Online' : 'Offline'}</div>
            <div className="text-sm text-slate-400">SSE: {connected ? 'conectado' : 'desconectado'}</div>
          </div>
        </header>

        <main className="grid grid-cols-12 gap-6">
          <section className="col-span-4 space-y-4">
            <div className="bg-slate-800 p-4 rounded">
              <h2 className="font-semibold">Status</h2>
              <div className="mt-3 text-sm text-slate-300">
                <div className='text-lg'><span className="text-slate-400">Interface:</span> <span className="font-mono">{status.iface || '-'}</span></div>
                <div className='text-lg'><span className="text-slate-400">IPv6:</span> <span className="font-mono">{status.ipv6 || '-'}</span></div>
                <div className='text-lg'><span className="text-slate-400">Send port:</span> {status.sendPort || '-'}</div>
                <div className='text-lg'><span className="text-slate-400">Recv port:</span> {status.recvPort || '-'}</div>
                <div className='text-lg'><span className="text-slate-400">Tempo de atividade:</span> {status.uptime ? `${Math.floor(status.uptime)}s` : '-'}</div>
              </div>
              <div className="mt-4 flex gap-2">
                <button 
                  onClick={handleActionButton} 
                  className={`flex flex-row gap-1 px-3 py-2 bg-emerald-500 rounded-lg cursor-pointer text-black ${status.running ? 'bg-rose-500' : 'bg-esmerald-500'}`}
                >
                  {!status.running ? <><PlayIcon/> Iniciar</>  : <><StopIcon/> Parar</>}
                </button>
              </div>
            </div>

            <div className="bg-slate-800 p-4 rounded">
              <h3 className="font-semibold">Flow</h3>
              <div className="mt-3"><FlowWidget/></div>
            </div>

            <div className="bg-slate-800 p-4 rounded">
              <h3 className="font-semibold">Contadores</h3>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-300">
                <div className="bg-slate-700 p-2 rounded">RX pkts<div className="font-mono">{metrics.rxPackets}</div></div>
                <div className="bg-slate-700 p-2 rounded">TX pkts<div className="font-mono">{metrics.txPackets}</div></div>
                <div className="bg-slate-700 p-2 rounded">RX bytes<div className="font-mono">{prettyBytes(metrics.rxBytes)}</div></div>
                <div className="bg-slate-700 p-2 rounded">TX bytes<div className="font-mono">{prettyBytes(metrics.txBytes)}</div></div>
              </div>
            </div>
          </section>

          <section className="col-span-5 space-y-4">
            <div className="bg-slate-800 p-4 rounded flex flex-col h-[38rem]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">Logs</h3>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-slate-400">Auto-top</label>
                  <input type="checkbox" checked={autoScroll} onChange={(e)=> setAutoScroll(e.target.checked)} />
                </div>
              </div>
              <div id="logs-scroll" className="overflow-auto flex-1 bg-black/60 p-2 rounded">
                {logs.length === 0 ? (
                  <div className="text-slate-400 text-sm">Nenhum log ainda</div>
                ) : (
                  logs.map((l, i) => (
                    <div key={i} className={`mb-1 p-2 rounded ${l.type === 'error' ? 'bg-rose-900/50' : 'bg-slate-900/60'}`}>
                      <div className="text-xs text-slate-400">{new Date(l.ts).toLocaleTimeString()}</div>
                      <LogLine text={l.pretty} meta={l.meta} />
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="bg-slate-800 p-4 rounded">
              <h3 className="font-semibold mb-2">Tráfego (último 30s)</h3>
              <TrafficChart />
            </div>
          </section>
          <section className="col-span-3 space-y-4">
            <div className="bg-slate-800 p-4 rounded">
              <h3 className="font-semibold">Inspetor de pacotes</h3>
              <PacketInspector />
            </div>

            <div className="bg-slate-800 p-4 rounded">
              <h3 className="font-semibold">Atividade recente</h3>
              <div className="mt-2 text-sm text-slate-400">
                <div>Último log: {logs[0] ? timeAgo(logs[0].ts) : '-'}</div>
                <div>Logs registrados: {logs.length}</div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}