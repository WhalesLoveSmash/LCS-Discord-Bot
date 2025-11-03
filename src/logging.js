// src/logging.js
// November-only spreadsheet with two tabs: "Individual" (first) and "Group" (second).
// Ready to serve as a clean backend for your site.
// ----------------------------------------------------
// Env vars (set later on Railway):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY           (supports literal newlines or \n-escaped)
//   GOOGLE_SHEETS_SPREADSHEET_ID
// Optional:
//   LOGGING_START_ISO (default "2025-11-01T00:00:00Z")
//
// Public functions you can call from index.js later:
//   - logBetPlaced({ message, channelName })
//   - logCashOut({ message, originalMessage, cashoutAmount, gainLoss })
//   - logVoid({ message, originalMessage })
//
// NOTE: Requiring this file alone does nothing destructive; it just prepares helpers.

const { google } = require("googleapis");

// ---------- Config ----------
const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const RAW_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "";
const LOGGING_START_ISO = process.env.LOGGING_START_ISO || "2025-11-01T00:00:00Z";

const TAB_INDIVIDUAL = "Individual";
const TAB_GROUP = "Group";

// Normalize \n in private key if necessary
const PRIVATE_KEY = RAW_PRIVATE_KEY.includes("\\n")
  ? RAW_PRIVATE_KEY.replace(/\\n/g, "\n")
  : RAW_PRIVATE_KEY;

// ---------- State ----------
let sheets = null;

// ---------- Helpers ----------
function haveCreds() {
  if (!SERVICE_EMAIL || !PRIVATE_KEY || !SPREADSHEET_ID) {
    console.warn(
      "[logging] Missing Google Sheets env vars; logging disabled until set."
    );
    return false;
  }
  return true;
}

async function getSheets() {
  if (sheets) return sheets;
  if (!haveCreds()) return null;
  const auth = new google.auth.JWT({
    email: SERVICE_EMAIL,
    key: PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
  return sheets;
}

// Only log events on/after cutoff (no retroactive backfill)
function sameOrAfterCutoff(dateLike) {
  const t = new Date(dateLike).getTime();
  const cutoff = new Date(LOGGING_START_ISO).getTime();
  return isFinite(t) && isFinite(cutoff) && t >= cutoff;
}

// Format a Discord jump URL for a message
function messageLink(msg) {
  try {
    return msg.url || "";
  } catch {
    return "";
  }
}

// Parse your bet format:
// "DH Danny Live Nuggests ML -210 $2.42 Returns $3.57"
// Also accepts "... To Return $3.57"
function parseBetText(text) {
  if (!text) return null;

  // Core regex capturing all 6 main parts
  const re =
    /^(\w{2})\s+(\S+)\s+(.+?)\s+([+-]?\d+(?:\.\d+)?)\s+\$([0-9]+(?:\.[0-9]+)?)\s+(?:Returns|To\s+Return)\s+\$([0-9]+(?:\.[0-9]+)?)/i;

  const m = text.match(re);
  if (!m) {
    return null;
  }

  const initials = m[1].toUpperCase();
  const bettor = m[2];
  const market = m[3].trim();
  const odds = Number(m[4]);
  const stake = Number(m[5]);
  const returns = Number(m[6]);

  const kind =
    initials === "DG" ? "Group" :
    initials === "DH" ? "Individual" :
    "Unknown";

  return { initials, kind, bettor, market, odds, stake, returns };
}

// Basic currency-safe 2-decimal number (for sheet number cells we keep raw number)
function to2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Ensure exactly two tabs exist and are formatted nicely
async function ensureTabs() {
  const client = await getSheets();
  if (!client) return false;

  const meta = await client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const titles = new Set((meta.data.sheets || []).map(s => s.properties?.title));

  const requests = [];

  // Helper to add a sheet with frozen header
  function addSheetReq(title) {
    return {
      addSheet: {
        properties: {
          title,
          gridProperties: { frozenRowCount: 1 },
        },
      },
    };
  }

  // Create Individual FIRST if missing
  if (!titles.has(TAB_INDIVIDUAL)) {
    requests.push(addSheetReq(TAB_INDIVIDUAL));
  }
  // Create Group SECOND if missing
  if (!titles.has(TAB_GROUP)) {
    requests.push(addSheetReq(TAB_GROUP));
  }

  if (requests.length) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  // Write headers (idempotent via update)
  const headers = [[
    "Timestamp (ISO)", // A
    "Event",           // B - BET_PLACED | CASH_OUT | VOID
    "Kind",            // C - Individual | Group
    "Initials",        // D - DH | DG
    "Bettor Name",     // E
    "Market",          // F
    "Odds",            // G
    "Stake",           // H (currency)
    "Returns",         // I (currency)
    "Cashout",         // J (currency)
    "Gain/Loss",       // K (currency)
    "Channel",         // L
    "Bet Text",        // M (full original)
    "Author Tag",      // N
    "Author ID",       // O
    "Message Link",    // P
    "Message ID"       // Q
  ]];

  async function initTab(title) {
    // Write headers
    await client.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${title}!A1:Q1`,
      valueInputOption: "RAW",
      requestBody: { values: headers },
    });

    // Format header bold, set column widths, money formats
    await client.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          // Bold header
          {
            repeatCell: {
              range: {
                sheetId: (meta.data.sheets || []).find(s => s.properties?.title === title)?.properties?.sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                },
              },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          // Set currency formats for H..K (Stake, Returns, Cashout, Gain/Loss)
          ...["H","I","J","K"].map(col => ({
            repeatCell: {
              range: {
                sheetId: (meta.data.sheets || []).find(s => s.properties?.title === title)?.properties?.sheetId,
                startRowIndex: 1,
                startColumnIndex: col.charCodeAt(0) - 65,
                endColumnIndex: col.charCodeAt(0) - 65 + 1,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          })),
          // Column widths (nice visual)
          ...[
            ["A", 155], // timestamp
            ["B", 120],
            ["C", 110],
            ["D", 70],
            ["E", 140],
            ["F", 250], // market
            ["G", 80],
            ["H", 110],
            ["I", 110],
            ["J", 110],
            ["K", 110],
            ["L", 140],
            ["M", 400], // full text
            ["N", 160],
            ["O", 140],
            ["P", 220],
            ["Q", 160],
          ].map(([col, px]) => ({
            updateDimensionProperties: {
              range: {
                sheetId: (meta.data.sheets || []).find(s => s.properties?.title === title)?.properties?.sheetId,
                dimension: "COLUMNS",
                startIndex: col.charCodeAt(0) - 65,
                endIndex: col.charCodeAt(0) - 65 + 1,
              },
              properties: { pixelSize: px },
              fields: "pixelSize",
            },
          })),
        ],
      },
    });
  }

  await initTab(TAB_INDIVIDUAL);
  await initTab(TAB_GROUP);

  return true;
}

// Append one row to a tab (with simple retry)
async function appendRow(tab, values) {
  const client = await getSheets();
  if (!client) return;

  await ensureTabs();

  const body = { values: [values] };
  const range = `${tab}!A:Q`;

  const maxAttempts = 5;
  let delay = 400;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await client.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: body,
      });
      return;
    } catch (err) {
      if (i === maxAttempts) {
        console.warn("[logging] append failed:", err?.message || err);
        return;
      }
      await new Promise(r => setTimeout(r, delay));
      delay *= 1.6;
    }
  }
}

// Build a row according to headers, choosing correct tab by kind
function buildRow({
  when,             // Date or ISO string
  event,            // BET_PLACED | CASH_OUT | VOID
  parsed,           // result of parseBetText (or null)
  channelName,
  fullText,
  authorTag,
  authorId,
  link,
  messageId,
  cashout = null,
  gainLoss = null,
}) {
  const iso = new Date(when).toISOString();

  const kind = parsed?.kind || "Unknown";
  const initials = parsed?.initials || "";
  const bettor = parsed?.bettor || "";
  const market = parsed?.market || "";
  const odds = parsed?.odds ?? "";
  const stake = parsed?.stake != null ? to2(parsed.stake) : "";
  const returns = parsed?.returns != null ? to2(parsed.returns) : "";
  const cashoutNum = cashout != null ? to2(cashout) : "";
  const glNum = gainLoss != null ? to2(gainLoss) : "";

  const row = [
    iso,           // A
    event,         // B
    kind,          // C
    initials,      // D
    bettor,        // E
    market,        // F
    odds,          // G
    stake,         // H
    returns,       // I
    cashoutNum,    // J
    glNum,         // K
    channelName || "", // L
    fullText || "",    // M
    authorTag || "",   // N
    authorId || "",    // O
    link || "",        // P
    messageId || "",   // Q
  ];

  const tab = kind === "Group" ? TAB_GROUP : TAB_INDIVIDUAL;
  return { tab, row };
}

// ---------- Public logging functions ----------

// Log a newly placed bet (call from wherever you create/forward bets)
async function logBetPlaced({ message, channelName }) {
  try {
    if (!message || !sameOrAfterCutoff(message.createdAt)) return;
    const parsed = parseBetText(message.content || "");
    const { tab, row } = buildRow({
      when: message.createdAt,
      event: "BET_PLACED",
      parsed,
      channelName,
      fullText: message.content || "",
      authorTag: message.author?.tag,
      authorId: message.author?.id,
      link: messageLink(message),
      messageId: message.id,
    });
    await appendRow(tab, row);
  } catch (e) {
    console.warn("[logging] logBetPlaced error:", e?.message || e);
  }
}

// Log a cash out (call at the time you post to #bet-discusion)
async function logCashOut({ message, originalMessage, cashoutAmount, gainLoss }) {
  try {
    // We gate by the original bet's timestamp
    const when = originalMessage?.createdAt || new Date();
    if (!sameOrAfterCutoff(when)) return;

    const parsed = parseBetText((originalMessage && originalMessage.content) || "");
    const { tab, row } = buildRow({
      when,
      event: "CASH_OUT",
      parsed,
      channelName: message?.channel?.name || "",
      fullText: (originalMessage && originalMessage.content) || "",
      authorTag: originalMessage?.author?.tag || "",
      authorId: originalMessage?.author?.id || "",
      link: messageLink(originalMessage),
      messageId: originalMessage?.id || "",
      cashout: cashoutAmount != null ? cashoutAmount : null,
      gainLoss: gainLoss != null ? gainLoss : null,
    });
    await appendRow(tab, row);
  } catch (e) {
    console.warn("[logging] logCashOut error:", e?.message || e);
  }
}

// Log a void (call at the time you post "Bet Voided")
async function logVoid({ message, originalMessage }) {
  try {
    const when = originalMessage?.createdAt || new Date();
    if (!sameOrAfterCutoff(when)) return;

    const parsed = parseBetText((originalMessage && originalMessage.content) || "");
    const { tab, row } = buildRow({
      when,
      event: "VOID",
      parsed,
      channelName: message?.channel?.name || "",
      fullText: (originalMessage && originalMessage.content) || "",
      authorTag: originalMessage?.author?.tag || "",
      authorId: originalMessage?.author?.id || "",
      link: messageLink(originalMessage),
      messageId: originalMessage?.id || "",
      cashout: 0,
      gainLoss: 0,
    });
    await appendRow(tab, row);
  } catch (e) {
    console.warn("[logging] logVoid error:", e?.message || e);
  }
}

module.exports = {
  parseBetText,
  logBetPlaced,
  logCashOut,
  logVoid,
};
