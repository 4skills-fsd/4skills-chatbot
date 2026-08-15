// Stand-in for the Google Apps Script endpoint, so the happy path and the exact
// row shape can be checked without deploying a real sheet.
//
//   node scripts/mock-webhook.js            -> accepts and prints each row
//   MOCK_WEBHOOK_FAIL=500 node ...          -> always fails, for the "sheet is
//                                              broken but the lead still works" test
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_WEBHOOK_PORT) || 4020;
const fail = Number(process.env.MOCK_WEBHOOK_FAIL) || 0;

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');

  if (fail) {
    console.log(`  webhook -> ${fail} (forced failure)`);
    res.writeHead(fail, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  console.log('  webhook -> 200, row received:');
  try {
    const row = JSON.parse(body);
    for (const k of Object.keys(row)) {
      console.log(`    ${k.padEnd(11)} ${JSON.stringify(row[k])}`);
    }
  } catch {
    console.log('    (unparseable) ' + body.slice(0, 200));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, () => console.log(`mock webhook  http://localhost:${port}`));
