// index.js
require('dotenv').config();
const { Client, IntentsBitField, Partials, Events } = require('discord.js');

const SOURCE_CHANNEL_ID = '1423456145191997481';
const TARGET_CHANNEL_ID = '1423455458760327261';
const SUCCESS_REACTION = '✅';
const FAIL_REACTION = '❌';

// NEW: Voting emojis
const UPVOTE = '👍';
const DOWNVOTE = '👎';

// track messages we've already forwarded so we don't process twice (for ✅/❌ flow)
const processed = new Set();

// Track group bet proposals and votes
// key = source message id
// value = { proposerId: string, upvoters: Set<string>, downvoters: Set<string>, proposalForwarded: boolean }
const groupBets = new Map();

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

// Helper: does the message qualify (exact ' Returns ')
function hasExactReturns(text) {
  return text.includes(' Returns ');
}

// Helper: pull the amount after " Returns $"
function extractReturnsAmount(text) {
  const m = text.match(/ Returns \$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? m[1] : null;
}

// Helper: contains GB (case-insensitive) as a standalone token
function hasGB(text) {
  return /\bgb\b/i.test(text);
}

// Helper: this is a group bet candidate if it's in the source channel, has ' Returns ', and has GB
function isGroupBetMessage(msg) {
  const content = msg.content ?? '';
  return (
    msg.channelId === SOURCE_CHANNEL_ID &&
    hasExactReturns(content) &&
    hasGB(content)
  );
}

// NEW: helper to map user IDs -> usernames (best-effort)
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

// When a group bet is posted, forward proposal right away and auto-react 👍 to represent author's auto-vote
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
    } catch (e) {
      // ignore react failures
    }

    // Forward proposal to the output channel once
    if (!state.proposalForwarded) {
      const target = await client.channels.fetch(TARGET_CHANNEL_ID);
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

// Reactions handler (extends your existing one)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    if (msg.partial) await msg.fetch();

    const emoji = reaction.emoji.name;

    // Guard: If someone reacts in the OUTPUT channel with 👍/👎, tell them to vote in tracking channel and bail
    if (msg.channelId === TARGET_CHANNEL_ID && (emoji === UPVOTE || emoji === DOWNVOTE)) {
      try {
        const target = await client.channels.fetch(TARGET_CHANNEL_ID);
        await target.send(`Vote in <#${SOURCE_CHANNEL_ID}> not here.`);
      } catch (e) {
        // ignore
      }
      return;
    }

    // === GROUP BET VOTING PATH (👍/👎 on qualifying messages in SOURCE channel) ===
    if (msg.channelId === SOURCE_CHANNEL_ID && hasExactReturns(msg.content ?? '') && hasGB(msg.content ?? '') && (emoji === UPVOTE || emoji === DOWNVOTE)) {
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

      // Author can't vote (beyond the automatic implicit upvote). Ignore if voter is proposer.
      if (voterId === state.proposerId) return;

      // Ignore duplicate votes
      const alreadyUp = state.upvoters.has(voterId);
      const alreadyDown = state.downvoters.has(voterId);
      if (alreadyUp || alreadyDown) return;

      const target = await client.channels.fetch(TARGET_CHANNEL_ID);

      if (emoji === UPVOTE) {
        // Count an upvote from a different user
        state.upvoters.add(voterId);

        // Pass requires 2 total upvotes (author implicit + 1 other). Since author is implicit, we just need 1 here.
        const passed = state.upvoters.size >= 1;

        if (passed) {
          // Build voter lists
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
          // keep state if you want history; or delete:
          // groupBets.delete(msg.id);
        } else {
          // (kept for future flexibility)
          const remaining = Math.max(0, 1 - state.upvoters.size);
          await target.send(
            `**${user.username}** voted for it — requires **${remaining}** more vote to pass.`
          );
        }

        groupBets.set(msg.id, state);
        return;
      }

      if (emoji === DOWNVOTE) {
        // Count a downvote from a different user
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
          // groupBets.delete(msg.id);
        } else {
          await target.send(`**${user.username}** voted against it.`);
        }

        groupBets.set(msg.id, state);
        return;
      }
    }

    // === ORIGINAL ✅/❌ RESOLUTION PATH (unchanged behavior) ===

    // Only watch the source channel
    if (msg.channelId !== SOURCE_CHANNEL_ID) return;

    // Only consider messages with the exact ' Returns ' token
    const content = msg.content ?? '';
    if (!hasExactReturns(content)) return;

    // Only handle our two reactions
    if (emoji !== SUCCESS_REACTION && emoji !== FAIL_REACTION) return;

    // Ensure we only forward once per message
    if (processed.has(msg.id)) return;
    processed.add(msg.id);

    // Build the forwarded text
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

    // Forward to target channel (include attachments + message link)
    const target = await client.channels.fetch(TARGET_CHANNEL_ID);
    const files = [...msg.attachments.values()].map((a) => a.url);

    await target.send({
      content: `${statusLine}\n${rewritten}\n${msg.url}`,
      files,
    });
  } catch (err) {
    console.error('Forward error:', err);
  }
});

// Optional: ignore bot messages globally
client.on(Events.MessageCreate, (m) => {
  if (m.author.bot) return;
});

client.login(process.env.DISCORD_TOKEN);
