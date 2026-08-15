// npm run dev:kill — free port 3000.
//
// Written in Node rather than as a shell one-liner so it behaves the same from
// cmd.exe, PowerShell and Git Bash. npm picks a different shell on each and the
// netstat/lsof incantations are not portable between them.

import { execSync } from 'node:child_process';

const PORT = 3000;

function pidsWindows() {
  // netstat -ano lists "PROTO local foreign STATE pid". Match the listening
  // socket on our port only — connections *to* it have the port in the foreign
  // column and killing those would kill the browser.
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (m && Number(m[1]) === PORT) pids.add(m[2]);
  }
  return [...pids];
}

function pidsPosix() {
  try {
    return execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }
}

const isWindows = process.platform === 'win32';

let pids = [];
try {
  pids = isWindows ? pidsWindows() : pidsPosix();
} catch (err) {
  console.error(`Could not inspect port ${PORT}: ${err.message}`);
  process.exit(1);
}

if (!pids.length) {
  console.log(`Port ${PORT} is already free.`);
  process.exit(0);
}

let killed = 0;
for (const pid of pids) {
  try {
    if (isWindows) execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGKILL');
    console.log(`Killed PID ${pid} holding port ${PORT}.`);
    killed++;
  } catch (err) {
    console.error(`Could not kill PID ${pid}: ${err.message}`);
  }
}

if (!killed) process.exit(1);
console.log(`Port ${PORT} is free. Run npm run dev.`);
