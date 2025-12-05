import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const CORS_ORIGIN = process.env.CORS_ORIGIN;
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const binPath = path.join(__dirname, "tun-proxy");

const IPV6 = "2001:db8::10/64";
const PORT_LOCAL = 5000;
const PORT_RECV = 5001;

let proc = null;
let logs = [];
let logsBuffer = [];
let lastLog;
let metrics = {
  packets_in: 0,
  packets_out: 0,
  bytes_in: 0,
  bytes_out: 0,
};

let tunnelState = {
  running: false,
  pid: null,
  startTime: null,
  uptime: 0,
  ipv6: null,
  portSend: 5000,
  portRecv: 5001,
  interface: null,
};


function pushLog(type, message, meta) {
  const entry = {
    type,
    message,
    ts: Date.now(),
    meta
  };
  logsBuffer.push(entry);
  if (logsBuffer.length > 300) {
    logsBuffer.shift();
  }
  logs.push(entry);
  lastLog = entry;
}

function extractPacketMeta(text){
    const lines = text.toString().split("\n");
    let meta;
    for (let line of lines) {
        line = line.trim();
        if (!line) 
          continue;
        if (line.includes("packet-meta")) {
            try {
                const jsonText = line.substring(line.indexOf("{"), line.lastIndexOf("}") + 1);
                meta = JSON.parse(jsonText);
            } catch (err) {
                console.error("Erro ao parsear packet-meta:", err);
            }
            continue;
        }
    }
    return meta;
}

function removePacketMetaLines(text) {
    return text
        .split("\n")
        .filter(line => !line.includes("packet-meta"))
        .join("\n");
}


// SSE: Logs Stream
app.get("/logs", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  let lastTs = 0;
  const interval = setInterval(() => {
    const latest = logsBuffer[logsBuffer.length - 1];
    if (latest && latest.ts !== lastTs) {
      res.write(`data: ${JSON.stringify(latest)}\n\n`);
      lastTs = latest.ts;
    }
  }, 200);
  req.on("close", () => {
    clearInterval(interval);
  });
});

// SSE: Métricas (para o gráfico)
app.get("/metrics", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify(metrics)}\n\n`);
  }, 1000);
  req.on("close", () => clearInterval(timer));
});


app.get("/status", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (!proc) 
    return res.json({ running: false });
  res.json({ 
    ok: true,
    running: tunnelState.running,
    pid: tunnelState.pid,
    iface: tunnelState.interface,
    ipv6: tunnelState.ipv6,
    sendPort: tunnelState.portSend,
    recvPort: tunnelState.portRecv,
    uptime: tunnelState.uptime,
  });
});

app.post("/start", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (proc) 
    return res.json({ ok: false, error: "Already running" });
  pushLog("info", "Starting tunnel...");
  proc = spawn(binPath, [IPV6, PORT_LOCAL, PORT_RECV], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let child = spawn('ls', ['-lh', '/usr']);
  tunnelState.running = true;
  tunnelState.pid = child.pid;
  tunnelState.startTime = Date.now();
  tunnelState.ipv6 = IPV6;
  tunnelState.interface = "tun0";
  setInterval(() => {
    if (tunnelState.running && tunnelState.startTime) {
      tunnelState.uptime = Math.floor((Date.now() - tunnelState.startTime) / 1000);
    }
  }, 1000);
  proc.stdout.on("data", (buf) => {
    let text = buf.toString();
    let type = "stdout";
    let meta;
    // Detecta pacotes da TUN
    if (text.includes("→ Packet da TUN")) {
      metrics.packets_in++;
      const bytes = parseInt(text.match(/\((\d+) bytes\)/)?.[1] || 0);
      metrics.bytes_in += bytes;
      type = "packet"
      meta = extractPacketMeta(text);
      text = removePacketMetaLines(text);
    }
    // Detecta pacotes vindo do UDP
    if (text.includes("← Packet from UDP")) {
      metrics.packets_out++;
      const bytes = parseInt(text.match(/\((\d+) bytes\)/)?.[1] || 0);
      metrics.bytes_out += bytes;
      type = "packet"
      meta = extractPacketMeta(text);
      text = removePacketMetaLines(text);
    }
    console.log(text.trim())
    pushLog(type, text.trim(), meta);
  });
  proc.stderr.on("data", (buf) => {
    pushLog("stderr", buf.toString().trim())
  });
  proc.on("exit", (code) => {
    pushLog("error", `Process exited with code ${code}`);
    console.log(`Process exited with code ${code}`)
    proc = null;
  });
  res.json({ ok: true });
});

app.post("/stop", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (!proc) 
    return res.status(400).json({ error: "Not running" });
  pushLog("info", "Stopping tunnel...");
  proc.kill("SIGTERM");
  proc = null;
  tunnelState.running = false;
  tunnelState.pid = null;
  tunnelState.startTime = null;
  tunnelState.uptime = 0;
  res.json({ ok: true });
});

//start server
app.listen(4000, () => {
  console.log(`Backend running at http://localhost:4000`);
});
