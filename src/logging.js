// src/logging.js
// November-only spreadsheet backend.
// We now log everything into the "Group" tab so all bets (group or individual)
// show up in the same place the site reads from.
// ----------------------------------------------------
// Env vars (set later on Railway):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY           (supports literal newlines or \n-escaped)
//   GOOGLE_SHEETS_SPREADSHEET_ID
// Optional:
//   LOGGING_START_ISO (default "2025-11-01T00:00:00Z")
//
// Public functions you can call from index.js:
//   - logBetPlaced({ message, channelName })
//   - logCashOut({ message, originalMessage, cashoutAmount, gainLoss })
//   - logVoid({ message, originalMessage })
//   - logSuccess({ message, originalMessage })
//   - logFailure({ message, originalMessage })
//
// NOTE: Requiring this file alone does nothing destructive; it just prepares helpers.

const { google } = require("googleapis");

// ---------- Config ----------
const SERVICE_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const RAW_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "";
const LOGGING_START_ISO = process.env.LOGGING_START_ISO || "2025-11-01T00:00:00Z";

// We keep this constant around for compatibility, but we no longer use it
// to create / select a separate tab.
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
    console.warn("[logging] Missing Google Sheets env vars; logging disabled until set.");
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
// "GB Danny Live Nuggets ML -210 $2.42 Returns $3.57"  -> group bet
// "DH Danny Live Nuggets ML -210 $2.42 Returns $3.57"  -> individual bet
// Any first token of length 2:
//   - "GB" => Group
//   - anything else => Individual
function parseBetText(text) {
  if (!text) return null;

  // Core regex capturing all 6 main parts
  const re =
    /^(\w{2})\s+(\S+)\s+(.+?)\s+([+-]?\d+(?:\.\d+)?)\s+\$([0-9]+(?:\.[0-9]+)?)\s+(?:Returns|To\s+Return)\s+\$([0-9]+(?:\.[0-9]+)?)/i;

  const m = text.match(re);
  if (!m) return null;

  const initials = m[1].toUpperCase();
  const bettor = m[2];
  const market = m[3].trim();
  const odds = Number(m[4]);
  const stake = Number(m[5]);
  const returns = Number(m[6]);

  // IMPORTANT: GB = group bet. Any other 2-letter code = individual bet.
  const kind = initials === "GB" ? "Group" : "Individual";

  return { initials, kind, bettor, market, odds, stake, returns };
}

// Basic currency-safe 2-decimal number (for sheet number cells we keep raw number)
function to2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Ensure the Group tab exists and is formatted nicely
// (We no longer auto-create / init an "Individual" tab.)
async function ensureTabs() {
  const client = await getSheets();
  if (!client) return false;

  // 1) Get current meta
  let meta = await client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  let titles = new Set((meta.data.sheets || []).map(s => s.properties?.title));

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

  // Create Group tab if missing
  if (!titles.has(TAB_GROUP)) {
    requests.push(addSheetReq(TAB_GROUP));
  }

  // 2) If we created any, apply them
  if (requests.length) {
    await client.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    // 3) IMPORTANT: re-fetch meta so we have fresh sheetIds
    meta = await client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    titles = new Set((meta.data.sheets || []).map(s => s.properties?.title));
  }

  const getSheetIdByTitle = (title) =>
    (meta.data.sheets || []).find(s => s.properties?.title === title)?.properties?.sheetId;

  // Write headers (idempotent via update)
  const headers = [[
    "Timestamp (ISO)", // A
    "Event",           // B - BET_PLACED | CASH_OUT | VOID | SUCCESS | FAILURE
    "Kind",            // C - Individual | Group
    "Initials",        // D - DH | GB | etc.
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
    // Header row
    await client.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${title}!A1:Q1`,
      valueInputOption: "RAW",
      requestBody: { values: headers },
    });

    // Styling & widths should never block appending; make best-effort only
    try {
      const sheetId = getSheetIdByTitle(title);
      if (sheetId == null) return;

      await client.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [
            // Bold header
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: "userEnteredFormat.textFormat.bold",
              },
            },
            // Currency formats for H..K
            ...["H","I","J","K"].map((col) => ({
              repeatCell: {
                range: {
                  sheetId,
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
            // Column widths
            ...[
              ["A", 155], ["B", 120], ["C", 110], ["D", 70],  ["E", 140],
              ["F", 250], ["G", 80],  ["H", 110], ["I", 110], ["J", 110],
              ["K", 110], ["L", 140], ["M", 400], ["N", 160], ["O", 140],
              ["P", 220], ["Q", 160],
            ].map(([col, px]) => ({
              updateDimensionProperties: {
                range: {
                  sheetId,
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
    } catch (e) {
      console.warn("[logging] styling skipped:", e?.message || e);
    }
  }

  // Only initialize the Group tab; Individual (if it exists) is left untouched.
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

// Build a row according to headers, always targeting the Group tab
// (Kind/Initials still get written into the row, but routing is unified.)
function buildRow({
  when,             // Date or ISO string
  event,            // BET_PLACED | CASH_OUT | VOID | SUCCESS | FAILURE
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

  // IMPORTANT: all bets (GB / DH / DG / NM / whatever) go into the Group tab.
  const tab = TAB_GROUP;
  return { tab, row };
}

// ---------- Public logging functions ----------

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

async function logCashOut({ message, originalMessage, cashoutAmount, gainLoss }) {
  try {
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

// success / failure logging (cashout fields left blank)
async function logSuccess({ message, originalMessage }) {
  try {
    const when = originalMessage?.createdAt || new Date();
    if (!sameOrAfterCutoff(when)) return;

    const parsed = parseBetText((originalMessage && originalMessage.content) || "");
    const { tab, row } = buildRow({
      when,
      event: "SUCCESS",
      parsed,
      channelName: message?.channel?.name || "",
      fullText: (originalMessage && originalMessage.content) || "",
      authorTag: originalMessage?.author?.tag || "",
      authorId: originalMessage?.author?.id || "",
      link: messageLink(originalMessage),
      messageId: originalMessage?.id || "",
      cashout: null,
      gainLoss: null,
    });
    await appendRow(tab, row);
  } catch (e) {
    console.warn("[logging] logSuccess error:", e?.message || e);
  }
}

async function logFailure({ message, originalMessage }) {
  try {
    const when = originalMessage?.createdAt || new Date();
    if (!sameOrAfterCutoff(when)) return;

    const parsed = parseBetText((originalMessage && originalMessage.content) || "");
    const { tab, row } = buildRow({
      when,
      event: "FAILURE",
      parsed,
      channelName: message?.channel?.name || "",
      fullText: (originalMessage && originalMessage.content) || "",
      authorTag: originalMessage?.author?.tag || "",
      authorId: originalMessage?.author?.id || "",
      link: messageLink(originalMessage),
      messageId: originalMessage?.id || "",
      cashout: null,
      gainLoss: null,
    });
    await appendRow(tab, row);
  } catch (e) {
    console.warn("[logging] logFailure error:", e?.message || e);
  }
}

module.exports = {
  parseBetText,
  logBetPlaced,
  logCashOut,
  logVoid,
  logSuccess,
  logFailure,
};
