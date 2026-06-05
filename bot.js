const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");
const fs = require("fs");

const SERVERS = [
  {
    guildId: "1506652573707276398",
    eodChannelId: "1509203195576979456",
    logChannelId: "1509239200698859681",
    reminderChannelId: "1509203195576979456",
    clipperRoleName: "Clippers",
  },
  {
    guildId: "1505643685432524950",
    eodChannelId: "1505691916279349368",
    logChannelId: "1511069604498247740",
    reminderChannelId: "1505691916279349368",
    clipperRoleName: "Clippers",
  },
];

const CONFIG = {
  token: process.env.TOKEN,
  reminderTime:   "0 16 * * *",
  summaryTime:    "0 19 * * *",
  dmReminderTime: "0 21 * * *",
  dmMissedTime:   "5 23 * * *",
  dataFile: "./eod_data.json",
};

function loadData() {
  if (!fs.existsSync(CONFIG.dataFile)) return { members: {}, submissions: {} };
  return JSON.parse(fs.readFileSync(CONFIG.dataFile, "utf8"));
}
function saveData(data) {
  fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data, null, 2));
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function fmtDate(key) {
  return new Date(key + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });
}
function safe(str) {
  return str && str.trim().length > 0 ? str : "None";
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`✅ EOD Bot online as ${client.user.tag}`);
  scheduleReminder();
  scheduleSummary();
  scheduleDMReminder();
  scheduleDMMissed();
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  const server = SERVERS.find((s) => s.eodChannelId === message.channelId);
  if (!server) return;
  const content = message.content.toLowerCase();
  const keywords = ["eod report", "what i completed", "clips made", "hours worked"];
  if (!keywords.some((kw) => content.includes(kw))) return;
  const data = loadData();
  const today = todayKey();
  const userId = message.author.id;
  const username = message.author.username;
  const guildId = message.guildId;
  if (!data.members[guildId]) data.members[guildId] = {};
  if (!data.members[guildId][userId]) data.members[guildId][userId] = { username, joinedAt: today };
  if (!data.submissions[guildId]) data.submissions[guildId] = {};
  if (!data.submissions[guildId][today]) data.submissions[guildId][today] = {};
  data.submissions[guildId][today][userId] = {
    username,
    submittedAt: new Date().toISOString(),
    messageUrl: message.url,
    preview: message.content.slice(0, 200),
  };
  saveData(data);
  message.react("✅").catch(() => {});
  console.log(`📋 EOD from ${username} in ${guildId}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!eod")) return;
  const args = message.content.slice(4).trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const data = loadData();
  const today = todayKey();
  const guildId = message.guildId;
  const guildMembers = data.members?.[guildId] || {};
  const guildSubs = data.submissions?.[guildId] || {};

  if (cmd === "status" || !cmd) {
    const todaySubs = guildSubs[today] || {};
    const all = Object.entries(guildMembers);
    if (all.length === 0) return message.reply("No clippers registered yet. They are auto-added on their first EOD post.");
    const sent = all.filter(([id]) => todaySubs[id]);
    const missing = all.filter(([id]) => !todaySubs[id]);
    const embed = new EmbedBuilder()
      .setTitle(`📋 EOD Status — ${fmtDate(today)}`)
      .setColor(missing.length === 0 ? 0x57f287 : 0xfaa61a)
      .addFields(
        { name: `✅ Submitted (${sent.length})`, value: safe(sent.map(([, m]) => `• ${m.username}`).join("\n")), inline: true },
        { name: `❌ Missing (${missing.length})`, value: safe(missing.map(([, m]) => `• ${m.username}`).join("\n")), inline: true }
      )
      .setFooter({ text: `${sent.length}/${all.length} submitted` })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  if (cmd === "yesterday") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yKey = yesterday.toISOString().slice(0, 10);
    const ySubs = guildSubs[yKey] || {};
    const all = Object.entries(guildMembers);
    if (all.length === 0) return message.reply("No clippers registered yet.");
    const sent = all.filter(([id]) => ySubs[id]);
    const missing = all.filter(([id]) => !ySubs[id]);
    const rate = all.length ? Math.round((sent.length / all.length) * 100) : 0;
    const embed = new EmbedBuilder()
      .setTitle(`📋 EOD Status — ${fmtDate(yKey)}`)
      .setColor(missing.length === 0 ? 0x57f287 : 0xed4245)
      .addFields(
        { name: `✅ Submitted (${sent.length})`, value: safe(sent.map(([id, m]) => `• [${m.username}](${ySubs[id].messageUrl})`).join("\n")), inline: true },
        { name: `❌ Missing (${missing.length})`, value: safe(missing.map(([, m]) => `• ${m.username}`).join("\n")), inline: true }
      )
      .setFooter({ text: `Submission rate: ${rate}% • ${sent.length}/${all.length} clippers` })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  if (cmd === "streak") {
    const all = Object.entries(guildMembers);
    if (all.length === 0) return message.reply("No clippers yet.");
    const streaks = all.map(([id, m]) => {
      let streak = 0;
      const d = new Date();
      while (true) {
        const key = d.toISOString().slice(0, 10);
        if (guildSubs[key]?.[id]) { streak++; d.setDate(d.getDate() - 1); }
        else break;
      }
      return { username: m.username, streak };
    }).sort((a, b) => b.streak - a.streak);
    const embed = new EmbedBuilder()
      .setTitle("🔥 Current Streaks")
      .setColor(0x5865f2)
      .setDescription(safe(streaks.map((s, i) => `${i + 1}. **${s.username}** — ${s.streak} day${s.streak !== 1 ? "s" : ""}`).join("\n")))
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  if (cmd === "history") {
    const mentioned = message.mentions.users.first();
    if (!mentioned) return message.reply("Usage: `!eod history @username`");
    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      rows.push(`${fmtDate(key)}: ${guildSubs[key]?.[mentioned.id] ? "✅ Sent" : "❌ Missing"}`);
    }
    const embed = new EmbedBuilder()
      .setTitle(`📅 Last 7 days — ${mentioned.username}`)
      .setColor(0x5865f2)
      .setDescription(rows.join("\n"))
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  if (cmd === "remove") {
    const mentioned = message.mentions.users.first();
    if (!mentioned) return message.reply("Usage: `!eod remove @username`");
    if (data.members[guildId]) delete data.members[guildId][mentioned.id];
    saveData(data);
    return message.reply(`✅ Removed **${mentioned.username}** from the tracker.`);
  }

  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setTitle("EOD Bot — Commands")
      .setColor(0x5865f2)
      .addFields(
        { name: "`!eod status`",       value: "Today's submission status",      inline: false },
        { name: "`!eod yesterday`",    value: "Yesterday's submission status",   inline: false },
        { name: "`!eod streak`",       value: "Everyone's current streak",       inline: false },
        { name: "`!eod history @user`",value: "Last 7 days for a clipper",       inline: false },
        { name: "`!eod remove @user`", value: "Remove someone from tracking",    inline: false },
      )
      .setFooter({ text: "Clippers are auto-added on their first EOD post" });
    return message.reply({ embeds: [embed] });
  }
});

function scheduleReminder() {
  cron.schedule(CONFIG.reminderTime, async () => {
    const data = loadData();
    const today = todayKey();
    for (const server of SERVERS) {
      const guild = client.guilds.cache.get(server.guildId);
      const channel = guild?.channels.cache.get(server.reminderChannelId);
      if (!channel) continue;
      let rolePing = "";
      if (server.clipperRoleName) {
        const role = guild.roles.cache.find((r) => r.name === server.clipperRoleName);
        if (role) rolePing = `<@&${role.id}> `;
      }
      const guildMembers = data.members?.[server.guildId] || {};
      const todaySubs = data.submissions?.[server.guildId]?.[today] || {};
      const missing = Object.entries(guildMembers).filter(([id]) => !todaySubs[id]);
      const embed = new EmbedBuilder()
        .setTitle("⏰ EOD Report Reminder")
        .setColor(0xfaa61a)
        .setDescription(`${rolePing}Don't forget to submit your EOD report before midnight!`)
        .addFields({ name: `Still missing (${missing.length})`, value: safe(missing.map(([, m]) => `• ${m.username}`).join("\n")) })
        .setTimestamp();
      channel.send({ embeds: [embed] });
    }
  });
}

function scheduleSummary() {
  cron.schedule(CONFIG.summaryTime, async () => {
    const data = loadData();
    const today = todayKey();
    for (const server of SERVERS) {
      const guild = client.guilds.cache.get(server.guildId);
      const channel = guild?.channels.cache.get(server.logChannelId);
      if (!channel) continue;
      const guildMembers = data.members?.[server.guildId] || {};
      const todaySubs = data.submissions?.[server.guildId]?.[today] || {};
      const all = Object.entries(guildMembers);
      const sent = all.filter(([id]) => todaySubs[id]);
      const missing = all.filter(([id]) => !todaySubs[id]);
      const rate = all.length ? Math.round((sent.length / all.length) * 100) : 0;
      const embed = new EmbedBuilder()
        .setTitle(`📊 EOD Summary — ${fmtDate(today)}`)
        .setColor(missing.length === 0 ? 0x57f287 : 0xed4245)
        .addFields(
          { name: `✅ Submitted (${sent.length})`, value: safe(sent.map(([id, m]) => `• [${m.username}](${todaySubs[id].messageUrl})`).join("\n")), inline: true },
          { name: `❌ Missed (${missing.length})`, value: safe(missing.map(([, m]) => `• ${m.username}`).join("\n")), inline: true }
        )
        .setFooter({ text: `Submission rate: ${rate}% • ${sent.length}/${all.length} clippers` })
        .setTimestamp();
      channel.send({ embeds: [embed] });
    }
  });
}

function scheduleDMReminder() {
  cron.schedule(CONFIG.dmReminderTime, async () => {
    const data = loadData();
    const today = todayKey();
    const alreadyDMed = new Set();
    for (const server of SERVERS) {
      const guildMembers = data.members?.[server.guildId] || {};
      const todaySubs = data.submissions?.[server.guildId]?.[today] || {};
      const missing = Object.entries(guildMembers).filter(([id]) => !todaySubs[id]);
      for (const [userId, member] of missing) {
        if (alreadyDMed.has(userId)) continue;
        alreadyDMed.add(userId);
        try {
          const user = await client.users.fetch(userId);
          const embed = new EmbedBuilder()
            .setTitle("⏰ EOD Report Reminder")
            .setColor(0xfaa61a)
            .setDescription(`Hey **${member.username}**! 👋\n\nYou haven't submitted your EOD report yet today. You have until **midnight** — go post it in <#${server.eodChannelId}>!`)
            .addFields({ name: "📋 Need the template?", value: "Copy the pinned message in #eod-reports and fill it out." })
            .setTimestamp();
          await user.send({ embeds: [embed] });
          console.log(`📩 DM reminder → ${member.username}`);
        } catch {
          console.log(`⚠️ Could not DM ${member.username}`);
        }
      }
    }
  });
}

function scheduleDMMissed() {
  cron.schedule(CONFIG.dmMissedTime, async () => {
    const data = loadData();
    const today = todayKey();
    const alreadyDMed = new Set();
    for (const server of SERVERS) {
      const guildMembers = data.members?.[server.guildId] || {};
      const todaySubs = data.submissions?.[server.guildId]?.[today] || {};
      const missing = Object.entries(guildMembers).filter(([id]) => !todaySubs[id]);
      for (const [userId, member] of missing) {
        if (alreadyDMed.has(userId)) continue;
        alreadyDMed.add(userId);
        try {
          const user = await client.users.fetch(userId);
          let missStreak = 0;
          const d = new Date();
          while (true) {
            const key = d.toISOString().slice(0, 10);
            if (!data.submissions?.[server.guildId]?.[key]?.[userId]) { missStreak++; d.setDate(d.getDate() - 1); }
            else break;
          }
          const embed = new EmbedBuilder()
            .setTitle("❌ EOD Report Missed")
            .setColor(0xed4245)
            .setDescription(`Hey **${member.username}**, you missed today's EOD report. Submit tomorrow! 💪`)
            .addFields({ name: "📅 Days missed in a row", value: `${missStreak} day${missStreak !== 1 ? "s" : ""}`, inline: true })
            .setTimestamp();
          await user.send({ embeds: [embed] });
          console.log(`📩 DM missed → ${member.username}`);
        } catch {
          console.log(`⚠️ Could not DM ${member.username}`);
        }
      }
    }
  });
}

client.login(CONFIG.token);