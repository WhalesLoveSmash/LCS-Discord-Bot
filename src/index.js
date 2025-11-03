// src/index.js
require('dotenv').config();
const { Client, IntentsBitField, Partials, Events } = require('discord.js');

// === Your original ID-based config ===
const SOURCE_CHANNEL_ID = '1423456145191997481';   // input
const TARGET_CHANNEL_ID = '1423455458760327261';   // output
const SUCCESS_REACTION = '✅';
const FAIL_REACTION = '❌';

// === Name-based config (from this session) — used as fallback ===
const INPUT_CHANNEL_NAME = 'bet-tracking';
const OUTPUT_CHANNEL_NAME = 'bet-discusion';

// Emojis (new cash-out / void flow)
const YELLOW_FLAG = '🟡';
const BLACK_CIRCLE = '⚫';
// Considered "resolved" so we ignore cash-out on bets already closed
const RESOLVED_EMOJIS = new Set(['✅', '✔️', '☑️', '❌', '✖️', '🟥', '🟩']);

// NEW: Voting emojis (from your original file)
const UPVOTE = '👍';
const DOWNVOTE = '👎';

// track messages we've already forwarded so we don't process twice (for ✅/❌ flow)
const processed = new Set();

// Track group bet proposals and votes
// key = source message id
// value = { proposerId: string, upvoters: Set<string>, downvoters: Set<string>, proposalForwarded: boolean }
const groupBets = new Map();

// Import logging helpers (spreadsheet logging)
const { logCashOut, logVoid, logSuccess, logFailure } = require('./logging.js');

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildMessageReactions,
    IntentsBitField.Flags.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, (c) => {
  console.log(`${c.user.tag} is online.`);
});

// --------------------
// Helpers (original)
// --------------------
function hasExactReturns(text) {
  return text.includes(' Returns ');
}

function extractReturnsAmount(text) {
  const m = text.match(/ Returns \$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? m[1] : null;
}

function hasGB(text) {
  return /\bgb\b/i.test(text);
}

function isGroupBetMessage(msg) {
  const content = msg.content ?? '';
  return (
    (msg.channelId === SOURCE_CHANNEL_ID || msg.channel?.name === INPUT_CHANNEL_NAME) &&
    hasExactReturns(content) &&
    hasGB(content)
  );
}

async function idsToUsernames(client, ids) {
  const arr = Array.from(ids);
  const names = await Promise.all(
    arr.map(async (id) => {
      try {
        const u = await client.users.fetch(id);
        return u.username;
      } catch {
        return 'Unknown';
      }
    })
  );
  return names;
}

// --------------------
// Helpers (cash-out)
// --------------------

// A reply content that is exactly a $ amount: `$5`, `$6.5`, `$0`, with optional spaces after $
function parseDollarOnlyMessage(content) {
  const trimmed = content.trim();
  const m = trimmed.match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return null;
  return Number(m[1]);
}

// Extract stake from original bet message:
// Prefer the last $ before the literal word "Returns", else smallest $ amount in the text
function extractStakeFromText(text) {
  const dollarRegex = /\$([0-9]+(?:\.[0-9]+)?)/g;
  const allMatches = [];
  let m;
  while ((m = dollarRegex.exec(text)) !== null) {
    allMatches.push({ value: Number(m[1]), index: m.index });
  }
  if (allMatches.length === 0) return null;

  const returnsIndex = text.indexOf('Returns');
  if (returnsIndex !== -1) {
    const beforeReturns = allMatches.filter((x) => x.index < returnsIndex);
    if (beforeReturns.length > 0) {
      return beforeReturns[beforeReturns.length - 1].value;
    }
  }
  return allMatches.reduce((min, x) => (x.value < min ? x.value : min), allMatches[0].value);
}

// Always two decimals
function fmtMoney(n) {
  return Number(n).toFixed(2);
}

// Build your "link style" original bet block
function buildOriginalBetLink(originalMessage) {
  const authorTag = originalMessage.author?.tag ?? 'Unknown';
  const content = originalMessage.content || '(no text)';
  return `**${authorTag}**\n${content}\n<#${originalMessage.channel.id}>`;
}

async function messageAppearsResolved(msg) {
  try {
    await msg.fetch();
    for (const [, reaction] of msg.reactions.cache) {
      const emojiName = reaction.emoji?.name;
      if (emojiName && RESOLVED_EMOJIS.has(emojiName)) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

// Fetch output channel by ID first, then by name (fallback)
async function getOutputChannel(guild) {
  try {
    const byId = await guild.channels.fetch(TARGET_CHANNEL_ID).catch(() => null);
    if (byId && byId.isTextBased?.()) return byId;
  } catch {}
  const byName = guild.channels.cache.find(
    (c) => c.name === OUTPUT_CHANNEL_NAME && c.isTextBased?.()
  );
  return byName || null;
}

// --------------------
// (1) GROUP BET: proposal forward on message create (original behavior)
// --------------------
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!isGroupBetMessage(msg)) return;

    // Initialize tracking if needed
    if (!groupBets.has(msg.id)) {
      groupBets.set(msg.id, {
        proposerId: msg.author.id,
        upvoters: new Set(),     // other voters (excludes proposer)
        downvoters: new Set(),   // other voters (excludes proposer)
        proposalForwarded: false,
      });
    }

    const state = groupBets.get(msg.id);

    // Visually show the auto upvote (author's implicit vote)
    try {
      await msg.react(UPVOTE);
    } catch {}

    // Forward proposal to the output channel once
    if (!state.proposalForwarded) {
      const target = await getOutputChannel(msg.guild);
      if (!target) return;

      const files = [...msg.attachments.values()].map((a) => a.url);
      const proposerName = msg.author.username;

      await target.send({
        content:
          `**${proposerName}** proposed a group bet\n` +
          `Requires **1 more** vote to pass\n` +
          `${msg.content}\n${msg.url}`,
        files,
      });

      state.proposalForwarded = true;
      groupBets.set(msg.id, state);
    }
  } catch (err) {
    console.error('Group bet forward error:', err);
  }
});

// --------------------
// (2) GROUP BET: voting + original ✅/❌ forwarding (original behavior)
// --------------------
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    if (msg.partial) await msg.fetch();

    const emoji = reaction.emoji.name;

    // Guard: If someone reacts in the OUTPUT channel with 👍/👎, tell them to vote in tracking channel
    if (
      (msg.channelId === TARGET_CHANNEL_ID || msg.channel?.name === OUTPUT_CHANNEL_NAME) &&
      (emoji === UPVOTE || emoji === DOWNVOTE)
    ) {
      const target = await getOutputChannel(msg.guild);
      if (target) await target.send(`Vote in <#${SOURCE_CHANNEL_ID}> not here.`);
      return;
    }

    // === GROUP BET VOTING PATH (👍/👎 on qualifying messages in SOURCE/INPUT channel) ===
    const inInput =
      msg.channelId === SOURCE_CHANNEL_ID || msg.channel?.name === INPUT_CHANNEL_NAME;

    if (
      inInput &&
      hasExactReturns(msg.content ?? '') &&
      hasGB(msg.content ?? '') &&
      (emoji === UPVOTE || emoji === DOWNVOTE)
    ) {
      // Ensure state initialized (covers the edge case where bot restarted)
      if (!groupBets.has(msg.id)) {
        groupBets.set(msg.id, {
          proposerId: msg.author?.id ?? '',
          upvoters: new Set(),
          downvoters: new Set(),
          proposalForwarded: false,
        });
      }

      const state = groupBets.get(msg.id);
      const voterId = user.id;

      // Author can't vote beyond implicit upvote
      if (voterId === state.proposerId) return;

      // Ignore duplicate votes
      if (state.upvoters.has(voterId) || state.downvoters.has(voterId)) return;

      const target = await getOutputChannel(msg.guild);
      if (!target) return;

      if (emoji === UPVOTE) {
        state.upvoters.add(voterId);

        // Pass requires 2 total upvotes (author implicit + 1 other). Since author is implicit, we just need 1 here.
        const passed = state.upvoters.size >= 1;

        if (passed) {
          const proposerName = (await client.users.fetch(state.proposerId)).username;
          const upNames = await idsToUsernames(client, state.upvoters);
          const forList = [proposerName, ...upNames].join(', ');
          const againstNames = await idsToUsernames(client, state.downvoters);
          const againstList = againstNames.length ? againstNames.join(', ') : '—';

          await target.send(
            `**Group bet passed**\n` +
              `${msg.content}\n${msg.url}\n\n` +
              `**For:** ${forList}\n` +
              `**Against:** ${againstList}`
          );
        } else {
          const remaining = Math.max(0, 1 - state.upvoters.size);
          await target.send(
            `**${user.username}** voted for it — requires **${remaining}** more vote to pass.`
          );
        }

        groupBets.set(msg.id, state);
        return;
      }

      if (emoji === DOWNVOTE) {
        state.downvoters.add(voterId);

        // With 3 people, failure requires 2 downvotes from the two other members.
        const failed = state.downvoters.size >= 2;

        if (failed) {
          const proposer = await client.users.fetch(state.proposerId);
          const proposerName = proposer.username;

          const downNames = await idsToUsernames(client, state.downvoters);
          const downList = downNames.join(', ');

          const upNames = await idsToUsernames(client, state.upvoters);
          const forList = [proposerName, ...upNames].join(', ');

          await target.send(
            `**Group bet proposal from ${proposerName} was rejected by ${downList}**\n` +
              `${msg.content}\n${msg.url}\n\n` +
              `**For:** ${forList}\n` +
              `**Against:** ${downList}`
          );
        } else {
          await target.send(`**${user.username}** voted against it.`);
        }

        groupBets.set(msg.id, state);
        return;
      }
    }

    // === ORIGINAL ✅/❌ RESOLUTION PATH ===
    if (!inInput) return;

    const content = msg.content ?? '';
    if (!hasExactReturns(content)) return;

    if (emoji !== SUCCESS_REACTION && emoji !== FAIL_REACTION) return;

    if (processed.has(msg.id)) return;
    processed.add(msg.id);

    const amount = extractReturnsAmount(content);
    const rewrittenSuccess = content.replace(' Returns ', ' Returned ');
    const rewrittenFail = content.replace(' Returns ', ' To Return ');

    let statusLine;
    let rewritten;

    if (emoji === SUCCESS_REACTION) {
      rewritten = rewrittenSuccess;
      statusLine = `Bet Succeeded`;
    } else {
      rewritten = rewrittenFail;
      statusLine = `Bet Failed`;
    }

    const target = await getOutputChannel(msg.guild);
    if (!target) return;

    const files = [...msg.attachments.values()].map((a) => a.url);

    const sent = await target.send({
      content: `${statusLine}\n${rewritten}\n${msg.url}`,
      files,
    });

    // NEW: log success/failure to the sheet (leave cashout fields blank)
    if (emoji === SUCCESS_REACTION && typeof logSuccess === 'function') {
      await logSuccess({ message: sent, originalMessage: msg });
    }
    if (emoji === FAIL_REACTION && typeof logFailure === 'function') {
      await logFailure({ message: sent, originalMessage: msg });
    }
  } catch (err) {
    console.error('Forward error:', err);
  }
});

// --------------------
// (3) CASH-OUT / VOID by replying with $amount (new behavior)
// --------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.guild) return;

    // Must be a reply
    if (!message.reference || !message.reference.messageId) return;

    // Only in input channel (by ID or by name)
    const inInput =
      message.channelId === SOURCE_CHANNEL_ID ||
      message.channel?.name === INPUT_CHANNEL_NAME;
    if (!inInput) return;

    // Content must be exactly a dollar amount like `$5`, `$0`, `$6.5`
    const cashoutAmount = parseDollarOnlyMessage(message.content);
    if (cashoutAmount === null) return;

    const channel = message.channel;
    const originalMessage = await channel.messages
      .fetch(message.reference.messageId)
      .catch(() => null);
    if (!originalMessage) return;

    // If already resolved, ignore
    if (await messageAppearsResolved(originalMessage)) return;

    const outputChannel = await getOutputChannel(message.guild);
    if (!outputChannel) return;

    const betLink = buildOriginalBetLink(originalMessage);

    // $0 => void
    if (cashoutAmount === 0) {
      await originalMessage.react(BLACK_CIRCLE).catch(() => {});
      const sent = await outputChannel.send(`Bet Voided\n${betLink}`);

      if (typeof logVoid === 'function') {
        await logVoid({ message: sent, originalMessage });
      }
      return;
    }

    // Cash out
    await originalMessage.react(YELLOW_FLAG).catch(() => {});

    const stake = extractStakeFromText(originalMessage.content || '');
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

    if (typeof logCashOut === 'function') {
      await logCashOut({
        message: sent,
        originalMessage,
        cashoutAmount,
        gainLoss: gainLossForLog,
      });
    }
  } catch (err) {
    // silent by design
  }
});

// Optional: ignore bot messages globally
client.on(Events.MessageCreate, (m) => {
  if (m.author?.bot) return;
});

client.login(process.env.DISCORD_TOKEN);
