// src/index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require("discord.js");

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

// Utility: format number like 2 decimal places, but keep .0 or .00 minimal if not needed
function fmtMoney(n) {
  // keep up to 2 decimals, strip trailing zeros
  const s = n.toFixed(2);
  return s.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

// Build an embed that shows the original bet content + who/when + jump link
function buildOriginalBetEmbed(originalMessage) {
  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setAuthor({
      name: originalMessage.author?.tag ?? "Unknown",
      iconURL: originalMessage.author?.displayAvatarURL?.() ?? undefined,
    })
    .setDescription(originalMessage.content || "(no text)")
    .setTimestamp(originalMessage.createdAt)
    .setFooter({ text: "Original Bet" });

  // If there’s an attachment and it’s an image, include the first image
  const firstAttachment = originalMessage.attachments?.first();
  if (firstAttachment && firstAttachment.contentType && firstAttachment.contentType.startsWith("image/")) {
    embed.setImage(firstAttachment.url);
  }

  // Add jump link for convenience
  try {
    const jump = originalMessage.url;
    if (jump) {
      embed.addFields({
        name: "Jump",
        value: `[Open original message](${jump})`,
      });
    }
  } catch (_) {
    // ignore if can't build URL
  }

  return embed;
}

// Determine if a message is already resolved (has any of the "resolved" style reactions)
async function messageAppearsResolved(msg) {
  try {
    // Ensure reactions are cached
    await msg.fetch();
    for (const [, reaction] of msg.reactions.cache) {
      const emojiName = reaction.emoji?.name;
      if (emojiName && RESOLVED_EMOJIS.has(emojiName)) {
        return true;
      }
    }
  } catch (_) {
    // If fetch fails, be permissive and treat as not resolved
  }
  return false;
}

// Main listener for cash-out / void replies
client.on("messageCreate", async (message) => {
  try {
    // Ignore bots, DMs, and non-replies
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.reference || !message.reference.messageId) return;

    // Only process in the input channel
    const channel = await message.channel.fetch();
    if (channel?.name !== INPUT_CHANNEL_NAME) return;

    // Content must be exactly a single $ amount (e.g., "$5", "$0")
    const cashoutAmount = parseDollarOnlyMessage(message.content);
    if (cashoutAmount === null) return;

    // Fetch the original bet that was replied to
    const originalMessage = await channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (!originalMessage) return;

    // Do not process if original bet looks resolved
    if (await messageAppearsResolved(originalMessage)) return;

    // Find the output channel
    const outputChannel = message.guild.channels.cache.find(
      (c) => c.name === OUTPUT_CHANNEL_NAME && c.isTextBased?.()
    );
    if (!outputChannel) return;

    // Handle $0 => void
    if (cashoutAmount === 0) {
      // React on the ORIGINAL bet in the input channel
      await originalMessage.react(BLACK_CIRCLE).catch(() => {});

      const embed = buildOriginalBetEmbed(originalMessage);

      await outputChannel.send({
        embeds: [embed],
        content: "Bet Voided",
      });

      return;
    }

    // Otherwise, cash out
    // React on the ORIGINAL bet in the input channel with the yellow emoji
    await originalMessage.react(YELLOW_FLAG).catch(() => {});

    // Try to compute gain/loss vs stake
    const stake = extractStakeFromText(originalMessage.content || "");
    let cashoutLine = `Cashed out at $${fmtMoney(cashoutAmount)}`;

    if (stake !== null && isFinite(stake)) {
      const diff = cashoutAmount - stake;
      const abs = Math.abs(diff);

      // Treat very tiny differences as neutral (floating point / rounding)
      if (abs >= 0.005) {
        if (diff > 0) {
          // match your example wording for gain
          cashoutLine = `Cashed out for a $${fmtMoney(abs)} gain for $${fmtMoney(cashoutAmount)}`;
        } else {
          cashoutLine = `Cashed out at a $${fmtMoney(abs)} loss for $${fmtMoney(cashoutAmount)}`;
        }
      }
    }

    const embed = buildOriginalBetEmbed(originalMessage);

    await outputChannel.send({
      embeds: [embed],
      content: cashoutLine,
    });
  } catch (err) {
    // Swallow errors to avoid spam; optionally log if you have a logger
    // console.error("Cash-out handler error:", err);
  }
});

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
