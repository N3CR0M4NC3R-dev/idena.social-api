#!/usr/bin/env node
/**
 * Scan contract-related tx hashes via api.idena.io (BalanceUpdates),
 * then fetch details from a local full node (bcn_txReceipt + bcn_transaction).
 * 
 * Run it (env vars)
 * export IDENA_NODE_API_KEY="$(cat /YOUR/PATH/TO/YOUR/api.key)"
 * export IDENA_NODE_URL="http://127.0.0.1:9009"
 * node scan-idena-social-contract.mjs
 *
 * Optional knobs:
 * export MAX_TX=200
 * export PAGE_SIZE=100
 *
 *
 * Contract hard-coded (for now):
 *   0x8d318630eB62A032d2f8073d74f05cbF7c6C87Ae
 *
 * Env:
 *   IDENA_NODE_API_KEY  (required)  -> export IDENA_NODE_API_KEY="$(cat /YOUR/PATH/TO/YOUR/api.key)"
 *   IDENA_NODE_URL      (optional)  -> default http://127.0.0.1:9009
 *   MAX_TX              (optional)  -> default 200 (deduped tx hashes)
 *   PAGE_SIZE           (optional)  -> default 100
 */

const CONTRACT_ADDRESS = "0x8d318630eB62A032d2f8073d74f05cbF7c6C87Ae";
const INDEXER_BASE = "https://api.idena.io/api";

const NODE_URL = process.env.IDENA_NODE_URL || "http://127.0.0.1:9009";
const NODE_KEY = process.env.IDENA_NODE_API_KEY || "";
const MAX_TX = Number.parseInt(process.env.MAX_TX || "200", 10);
const PAGE_SIZE = Number.parseInt(process.env.PAGE_SIZE || "100", 10);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!NODE_KEY) {
  die('Missing IDENA_NODE_API_KEY. Example:\nexport IDENA_NODE_API_KEY="$(cat /YOUR/PATH/TO/YOUR/api.key)"');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Rough JS equivalent of: xxd -r -p | strings -n 6
function extractAsciiStrings(buf, minLen = 6) {
  const out = [];
  let start = -1;

  const isPrintable = (b) =>
    (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09; // space..~ plus \n\r\t

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (isPrintable(b)) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) {
        const len = i - start;
        if (len >= minLen) out.push(buf.slice(start, i).toString("utf8"));
        start = -1;
      }
    }
  }

  if (start !== -1) {
    const len = buf.length - start;
    if (len >= minLen) out.push(buf.slice(start).toString("utf8"));
  }

  return out;
}

function hexToBuf(hex) {
  if (!hex) return Buffer.alloc(0);
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) return Buffer.alloc(0);
  return Buffer.from(h, "hex");
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const txt = await res.text();
  let js;
  try {
    js = JSON.parse(txt);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${txt.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${txt.slice(0, 300)}`);
  }
  return js;
}

async function nodeRpc(method, params) {
  const body = {
    method,
    params,
    id: 1,
    key: NODE_KEY, // IMPORTANT: idena-go expects the key in the JSON body as "key"
  };

  const js = await httpJson(NODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (js.error) {
    const msg = js.error?.message ? js.error.message : JSON.stringify(js.error);
    throw new Error(`${method} RPC error: ${msg}`);
  }
  return js.result;
}

async function fetchContractTxHashesDeduped() {
  const hashes = [];
  const seen = new Set();

  let token = "";
  while (hashes.length < MAX_TX) {
    let url = `${INDEXER_BASE}/Contract/${CONTRACT_ADDRESS}/BalanceUpdates?limit=${PAGE_SIZE}`;
    if (token) url += `&continuationToken=${encodeURIComponent(token)}`;

    const js = await httpJson(url);
    const arr = Array.isArray(js.result) ? js.result : [];
    for (const item of arr) {
      const h = item?.hash;
      if (typeof h === "string" && h.startsWith("0x") && !seen.has(h)) {
        seen.add(h);
        hashes.push(h);
        if (hashes.length >= MAX_TX) break;
      }
    }

    token = typeof js.continuationToken === "string" ? js.continuationToken : "";
    if (!token) break;

    // be nice to api.idena.io
    await sleep(120);
  }

  return hashes;
}

function tryExtractJsonLike(strings) {
  // best-effort: look for a JSON object in any extracted ascii chunk
  for (const s of strings) {
    const i = s.indexOf("{");
    const j = s.lastIndexOf("}");
    if (i !== -1 && j !== -1 && j > i) {
      const candidate = s.slice(i, j + 1);
      // don’t hard-fail if it’s not valid JSON; just return the candidate
      return candidate;
    }
  }
  return "";
}

async function main() {
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Indexer:  ${INDEXER_BASE}`);
  console.log(`Node RPC: ${NODE_URL}`);
  console.log(`MAX_TX=${MAX_TX} PAGE_SIZE=${PAGE_SIZE}`);
  console.log("");

  const txs = await fetchContractTxHashesDeduped();
  console.log(`Fetched ${txs.length} unique tx hashes (deduped).`);
  console.log("");

  for (let idx = 0; idx < txs.length; idx++) {
    const tx = txs[idx];

    try {
      const receipt = await nodeRpc("bcn_txReceipt", [tx]);
      const txx = await nodeRpc("bcn_transaction", [tx]);

      const method = receipt?.method || "";
      const success = receipt?.success === true;
      const gasUsed = receipt?.gasUsed;
      const from = txx?.from || "";
      const to = txx?.to || "";
      const amount = txx?.amount || "";
      const epoch = txx?.epoch;
      const ts = txx?.timestamp ? new Date(txx.timestamp * 1000).toISOString() : "";

      // pull “content” primarily from tx.payload, also from receipt.actionResult.inputAction.args
      const payloadBuf = hexToBuf(txx?.payload || "");
      const argsBuf = hexToBuf(receipt?.actionResult?.inputAction?.args || "");

      const payloadStrings = extractAsciiStrings(payloadBuf, 6);
      const argsStrings = extractAsciiStrings(argsBuf, 6);

      const jsonCandidate = tryExtractJsonLike([...payloadStrings, ...argsStrings]);

      console.log(`== ${idx + 1}/${txs.length} ${tx} ==`);
      console.log(`time=${ts} epoch=${epoch}`);
      console.log(`method=${method} success=${success} gasUsed=${gasUsed}`);
      console.log(`from=${from}`);
      console.log(`to=${to}`);
      console.log(`amount=${amount}`);

      if (jsonCandidate) {
        console.log("");
        console.log("---- extracted JSON-like content ----");
        console.log(jsonCandidate);
      } else {
        const preview = [...payloadStrings, ...argsStrings].slice(0, 6).join(" | ");
        if (preview) {
          console.log("");
          console.log("---- strings preview ----");
          console.log(preview);
        }
      }

      console.log("");

      // be nice to your node
      await sleep(80);
    } catch (e) {
      console.error(`!! Failed tx ${tx}: ${e?.message || e}`);
      console.log("");
      await sleep(80);
    }
  }
}

main().catch((e) => die(String(e?.stack || e)));
