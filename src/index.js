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

client.on('ready', (c) => {
    console.log(`${c.user.tag} is online.`);
});

client.on('messageCreate', (message) => {
    if (message.content === 'Returns') {
        message.reply('detected this as a bet');
    }
});

client.login(process.env.DISCORD_TOKEN);