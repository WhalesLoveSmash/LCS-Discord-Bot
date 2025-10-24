// index.js
require('dotenv').config();
const { Client, IntentsBitField, Partials, Events } = require('discord.js');

const SOURCE_CHANNEL_ID = '1423456145191997481';
const TARGET_CHANNEL_ID = '1423455458760327261';
const SUCCESS_REACTION = '✅';
const FAIL_REACTION = '❌';

// track messages we've already forwarded so we don't process twice
const processed = new Set();

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

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    if (msg.partial) await msg.fetch();

    // Only watch the source channel
    if (msg.channelId !== SOURCE_CHANNEL_ID) return;

    // Only consider messages with the exact ' Returns ' token
    const content = msg.content ?? '';
    if (!hasExactReturns(content)) return;

    // Only handle our two reactions
    const emoji = reaction.emoji.name;
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
      statusLine = amount
        ? `Bet Succeeded Returning $${amount} Amount`
        : `Bet Succeeded`;
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
