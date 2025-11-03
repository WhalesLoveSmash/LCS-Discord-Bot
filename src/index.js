// src/index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require("discord.js");

// Import logging helpers (spreadsheet logging)
const { logCashOut, logVoid } = require("./logging.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// --- Configuration (fixed names per your instructions) ---
const INPUT_CHANNEL_NAME = "bet-tracking";
const OUTPUT_CHANNEL_NAME = "bet-discusion";

// Emojis
const YELLOW_FLAG = "🟡"; // react to original bet on cash out
const BLACK_CIRCLE = "⚫"; // react to original bet on void
// A small set of "resolved" checks; if any exist on the original message we ignore cash-out
const RESOLVED_EMOJIS = new Set(["✅", "✔️", "☑️", "❌", "✖️", "🟥", "🟩"]);

// Utility: is a message content exactly a $ amount like `$5`, `$6.5`, `$0`
function parseDollarOnlyMessage(content) {
  const trimmed = content.trim();
  const m = trimmed.match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return null;
  return Number(m[1]);
}

// Utility: try to extract the stake from original bet text
// Heuristics:
// 1) If there's "Returns $X", we prefer the last $Y that appears BEFORE "Returns"
// 2) Otherwise choose the smallest $ amount in the message (typical stake < returns)
function extractStakeFromText(text) {
  const dollarRegex = /\$([0-9]+(?:\.[0-9]+)?)/g;
  const allMatches = [];
  let m;
  while ((m = dollarRegex.exec(text)) !== null) {
    allMatches.push({ value: Number(m[1]), index: m.index });
  }
  if (allMatches.length === 0) return null;

  const returnsIndex = text.indexOf("Returns");
  if (returnsIndex !== -1) {
    const beforeReturns = allMatches.filter((x) => x.index < returnsIndex);
    if (beforeReturns.length > 0) {
      // choose the last $ before "Returns" (often the stake listed right before Returns)
      return beforeReturns[beforeReturns.length - 1].value;
    }
  }
  // Fallback: choose the smallest amount as stake
  return allMatches.reduce((min, x) => (x.value < min ? x.value : min), allMatches[0].value);
}

// Always show exactly two decimals
function fmtMoney(n) {
  return n.toFixed(2);
}

// Build the “link style” message like your example
function buildOriginalBetLink(originalMessage) {
  const authorTag = originalMessage.author?.tag ?? "Unknown";
  const messageLink = originalMessage.url;
  const content = originalMessage.content || "(no text)";

  // Return simple formatted text block (mimics your "Bet Failed" format)
  return `**${authorTag}**\n${content}\n<#${originalMessage.channel.id}>`;
}

// Determine if a message is already resolved (has any of the "resolved" style reactions)
async function messageAppearsResolved(msg) {
  try {
    await msg.fetch();
    for (const [, reaction] of msg.reactions.cache) {
      const emojiName = reaction.emoji?.name;
      if (emojiName && RESOLVED_EMOJIS.has(emojiName)) {
        return true;
      }
    }
  } catch (_) {
    // If fetch fails, treat as not resolved
  }
  return false;
}

// Main listener for cash-out / void replies
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.reference || !message.reference.messageId) return;

    const channel = await message.channel.fetch();
    if (channel?.name !== INPUT_CHANNEL_NAME) return;

    const cashoutAmount = parseDollarOnlyMessage(message.content);
    if (cashoutAmount === null) return;

    const originalMessage = await channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (!originalMessage) return;

    if (await messageAppearsResolved(originalMessage)) return;

    const outputChannel = message.guild.channels.cache.find(
      (c) => c.name === OUTPUT_CHANNEL_NAME && c.isTextBased?.()
    );
    if (!outputChannel) return;

    const betLink = buildOriginalBetLink(originalMessage);

    if (cashoutAmount === 0) {
      await originalMessage.react(BLACK_CIRCLE).catch(() => {});
      const sent = await outputChannel.send(`Bet Voided\n${betLink}`);

      // --- minimal addition: log to spreadsheet ---
      if (typeof logVoid === "function") {
        await logVoid({ message: sent, originalMessage });
      }
      // --------------------------------------------
      return;
    }

    await originalMessage.react(YELLOW_FLAG).catch(() => {});

    const stake = extractStakeFromText(originalMessage.content || "");
    let cashoutLine = `Cashed out at $${fmtMoney(cashoutAmount)}`;

    let gainLossForLog = null;
    if (stake !== null && isFinite(stake)) {
      const diff = cashoutAmount - stake;
      const abs = Math.abs(diff);

      if (abs >= 0.005) {
        if (diff > 0) {
          cashoutLine = `Cashed out for a $${fmtMoney(abs)} gain for $${fmtMoney(cashoutAmount)}`;
        } else {
          cashoutLine = `Cashed out at a $${fmtMoney(abs)} loss for $${fmtMoney(cashoutAmount)}`;
        }
      }
      gainLossForLog = diff;
    }

    const sent = await outputChannel.send(`${cashoutLine}\n${betLink}`);

    // --- minimal addition: log to spreadsheet ---
    if (typeof logCashOut === "function") {
      await logCashOut({
        message: sent,
        originalMessage,
        cashoutAmount,
        gainLoss: gainLossForLog,
      });
    }
    // --------------------------------------------
  } catch (err) {
    // console.error("Cash-out handler error:", err);
  }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
