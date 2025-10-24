require('dotenv').config();
const { Client, IntentsBitField } = require('discord.js');

const client = new Client({
    intents: [
       IntentsBitField.Flags.Guilds,
       IntentsBitField.Flags.GuildMembers,
       IntentsBitField.Flags.GuildMessages,
       IntentsBitField.Flags.GuildMessageReactions,
       IntentsBitField.Flags.MessageContent, 
    ]
});

client.login(process.env.DISCORD_TOKEN);