import parse from "html-react-parser";

export function prettyBytes(n) {
  if (n === 0) 
    return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0; 
  let v = n;
  while (v >= 1024 && i < units.length-1) { 
    v /= 1024; i++; 
    }
  return `${v?.toFixed(1)} ${units[i]}`;
}

export function timeAgo(ts) {
  if (!ts) 
    return '-';
  const d = Math.floor((Date.now() - ts)/1000);
  if (d < 5) 
    return 'just now';
  if (d < 60) 
    return `${d}s ago`;
  if (d < 3600) 
    return `${Math.floor(d/60)}m ago`;
  return `${Math.floor(d/3600)}h ago`;
}

export function formatLog(log){
  let new_log = addBreakLine(log);
  return parse(new_log);
}

function addBreakLine(msg){
  msg = msg.replaceAll(`"`, "")
  msg = msg.replaceAll(`\\n`, "<br/>");
  return msg;
}

export function calculatePerSecond(current, previous) {
  if (!previous) 
    return null;
  return {
    time: Date.now(),
    rxBytes: current.rxBytes - previous.rxBytes,
    txBytes: current.txBytes - previous.txBytes,
    rxPackets: current.rxPackets - previous.rxPackets,
    txPackets: current.txPackets - previous.txPackets
  };
}