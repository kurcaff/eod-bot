const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");
const { MongoClient } = require("mongodb");

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
  {
    guildId: "1511396522078638281",
    eodChannelId: "1512396753310318744",
    logChannelId: "1512396831101947987",
    reminderChannelId: "1512396753310318744",
    clipperRoleName: "Clippers",
  },
];

const CONFIG = {
  token: process.env.TOKEN,
  mongoUrl: process.env.MONGODB_URL,
  reminderTime:   "0 16 * * *",
  summaryTime:    "0 19 * * *",
  dmReminderTime: "0 21 * * *",
  dmMissedTime:   "5 23 * * *",
};

let db;

async function connectDB() {
  const mongoClient = new MongoClient(CONFIG.mongoUrl);
  await mongoClient.connect();
  db = mongoClient.db("eodbot");
  console.log("Connected to MongoDB");
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
  if (!str || str.trim().length === 0) return "None";
  return str;
}

async function getMember(guildId, userId) {
  return db.collection("members").findOne({ guildId, userId });
}

async function saveMember(guildId, userId, username) {
  await db.collection("members").updateOne(
    { guildId, userId },
    { $setOnInsert: { guildId, userId, username, joinedAt: todayKey() } },
    { upsert: true }
  );
}

async function getMembers(guildId) {
  return db.collection("members").find({ guildId }).toArray();
}

async function removeMember(guildId, userId) {
  await db.collection("members").deleteOne({ guildId, userId });
}

async function saveSubmission(guildId, userId, username, messageUrl, preview) {
  const date = todayKey();
  await db.collection("submissions").updateOne(
    { guildId, userId, date },
    { $set: { guildId, userId, username, date, submittedAt: new Date().toISOString(), messageUrl, preview } },
    { upsert: true }
  );
}

async function getSubmissions(guildId, date) {
  const subs = await db.collection("submissions").find({ guildId, date }).toArray();
  const map = {};
  for (const s of subs) map[s.userId] = s;
  return map;
}

// ─── CLIENT ──────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`EOD Bot online as ${client.user.tag}`);
  scheduleReminder();
  scheduleSummary();
  scheduleDMReminder();
  scheduleDMMissed();
});

// ─── AUTO-DETECT EOD SUBMISSIONS ─────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const server = SERVERS.find((s) => s.eodChannelId === message.channelId);
  if (!server) return;
  const content = message.content.toLowerCase();
  const keywords = ["eod report", "what i completed", "clips made", "hours worked"];
  if (!keywords.some((kw) => content.includes(kw))) return;

  const userId = message.author.id;
  const username = message.author.username;
  const guildId = message.guildId;

  await saveMember(guildId, userId, username);
  await saveSubmission(guildId, userId, username, message.url, message.content.slice(0, 200));

  message.react("✅").catch(() => {});
  console.log(`EOD from ${username} in ${guildId}`);
});

// ─── COMMANDS ────────────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!eod")) return;

  const args = message.content.slice(4).trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const today = todayKey();
  const guildId = message.guildId;

  // !eod status
  if (cmd === "status" || !cmd) {
    const all = await getMembers(guildId);
    if (all.length === 0) return message.reply("No clippers registered yet. They are auto-added on their first EOD post.");
    const subs = await getSubmissions(guildId, today);
    const sent = all.filter((m) => subs[m.userId]);
    const missing = all.filter((m) => !subs[m.userId]);
    const embed = new EmbedBuilder()
      .setTitle(`EOD Status - ${fmtDate(today)}`)
      .setColor(missing.length === 0 ? 0x57f287 : 0xfaa61a)
      .addFields(
        { name: `Submitted (${sent.length})`, value: safe(sent.map((m) => `- ${m.username}`).join("\n")), inline: true },
        { name: `Missing (${missing.length})`, value: safe(missing.map((m) => `- ${m.username}`).join("\n")), inline: true }
      )
      .setFooter({ text: `${sent.length}/${all.length} submitted` })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // !eod yesterday
  if (cmd === "yesterday") {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yKey = yesterday.toISOString().slice(0, 10);
    const all = await getMembers(guildId);
    if (all.length === 0) return message.reply("No clippers registered yet.");
    const subs = await getSubmissions(guildId, yKey);
    const sent = all.filter((m) => subs[m.userId]);
    const missing = all.filter((m) => !subs[m.userId]);
    const rate = all.length ? Math.round((sent.length / all.length) * 100) : 0;
    const embed = new EmbedBuilder()
      .setTitle(`EOD Status - ${fmtDate(yKey)}`)
      .setColor(missing.length === 0 ? 0x57f287 : 0xed4245)
      .addFields(
        { name: `Submitted (${sent.length})`, value: safe(sent.map((m) => `- [${m.username}](${subs[m.userId]?.messageUrl})`).join("\n")), inline: true },
        { name: `Missing (${missing.length})`, value: safe(missing.map((m) => `- ${m.username}`).join("\n")), inline: true }
      )
      .setFooter({ text: `Submission rate: ${rate}% - ${sent.length}/${all.length} clippers` })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // !eod streak
  if (cmd === "streak") {
    const all = await getMembers(guildId);
    if (all.length === 0) return message.reply("No clippers yet.");
    const streaks = [];
    for (const member of all) {
      let streak = 0;
      const d = new Date();
      while (true) {
        const key = d.toISOString().slice(0, 10);
        const subs = await getSubmissions(guildId, key);
        if (subs[member.userId]) { streak++; d.setDate(d.getDate() - 1); }
        else break;
      }
      streaks.push({ username: member.username, streak });
    }
    streaks.sort((a, b) => b.streak - a.streak);
    const embed = new EmbedBuilder()
      .setTitle("Current Streaks")
      .setColor(0x5865f2)
      .setDescription(safe(streaks.map((s, i) => `${i + 1}. ${s.username} - ${s.streak} day${s.streak !== 1 ? "s" : ""}`).join("\n")))
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // !eod history @user
  if (cmd === "history") {
    const mentioned = message.mentions.users.first();
    if (!mentioned) return message.reply("Usage: !eod history @username");
    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const subs = await getSubmissions(guildId, key);
      rows.push(`${fmtDate(key)}: ${subs[mentioned.id] ? "Sent" : "Missing"}`);
    }
    const embed = new EmbedBuilder()
      .setTitle(`Last 7 days - ${mentioned.username}`)
      .setColor(0x5865f2)
      .setDescription(safe(rows.join("\n")))
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // !eod remove @user
  if (cmd === "remove") {
    const mentioned = message.mentions.users.first();
    if (!mentioned) return message.reply("Usage: !eod remove @username");
    await removeMember(guildId, mentioned.id);
    return message.reply(`Removed ${mentioned.username} from the tracker.`);
  }

  // !eod help
  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setTitle("EOD Bot - Commands")
      .setColor(0x5865f2)
      .addFields(
        { name: "!eod status",        value: "Today's submission status",     inline: false },
        { name: "!eod yesterday",      value: "Yesterday's submission status", inline: false },
        { name: "!eod streak",         value: "Everyone's current streak",     inline: false },
        { name: "!eod history @user",  value: "Last 7 days for a clipper",     inline: false },
        { name: "!eod remove @user",   value: "Remove someone from tracking",  inline: false },
      )
      .setFooter({ text: "Clippers are auto-added on their first EOD post" });
    return message.reply({ embeds: [embed] });
  }
});

// ─── SCHEDULED REMINDER ──────────────────────────────────────────────────────

function scheduleReminder() {
  cron.schedule(CONFIG.reminderTime, async () => {
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
      const all = await getMembers(server.guildId);
      const subs = await getSubmissions(server.guildId, today);
      const missing = all.filter((m) => !subs[m.userId]);
      const embed = new EmbedBuilder()
        .setTitle("EOD Report Reminder")
        .setColor(0xfaa61a)
        .setDescription(`${rolePing}Don't forget to submit your EOD report before midnight! Copy the pinned template, fill it out, and post it here.`)
        .addFields({ name: `Still missing (${missing.length})`, value: safe(missing.map((m) => `- ${m.username}`).join("\n")) })
        .setTimestamp();
      channel.send({ embeds: [embed] });
    }
  });
}

// ─── SCHEDULED NIGHTLY SUMMARY ───────────────────────────────────────────────

function scheduleSummary() {
  cron.schedule(CONFIG.summaryTime, async () => {
    const today = todayKey();
    for (const server of SERVERS) {
      const guild = client.guilds.cache.get(server.guildId);
      const channel = guild?.channels.cache.get(server.logChannelId);
      if (!channel) continue;
      const all = await getMembers(server.guildId);
      const subs = await getSubmissions(server.guildId, today);
      const sent = all.filter((m) => subs[m.userId]);
      const missing = all.filter((m) => !subs[m.userId]);
      const rate = all.length ? Math.round((sent.length / all.length) * 100) : 0;
      const embed = new EmbedBuilder()
        .setTitle(`EOD Summary - ${fmtDate(today)}`)
        .setColor(missing.length === 0 ? 0x57f287 : 0xed4245)
        .addFields(
          { name: `Submitted (${sent.length})`, value: safe(sent.map((m) => `- [${m.username}](${subs[m.userId]?.messageUrl})`).join("\n")), inline: true },
          { name: `Missed (${missing.length})`, value: safe(missing.map((m) => `- ${m.username}`).join("\n")), inline: true }
        )
        .setFooter({ text: `Submission rate: ${rate}% - ${sent.length}/${all.length} clippers` })
        .setTimestamp();
      channel.send({ embeds: [embed] });
    }
  });
}

// ─── DM REMINDER ─────────────────────────────────────────────────────────────

function scheduleDMReminder() {
  cron.schedule(CONFIG.dmReminderTime, async () => {
    const today = todayKey();
    const alreadyDMed = new Set();
    for (const server of SERVERS) {
      const all = await getMembers(server.guildId);
      const subs = await getSubmissions(server.guildId, today);
      const missing = all.filter((m) => !subs[m.userId]);
      for (const member of missing) {
        if (alreadyDMed.has(member.userId)) continue;
        alreadyDMed.add(member.userId);
        try {
          const user = await client.users.fetch(member.userId);
          const embed = new EmbedBuilder()
            .setTitle("EOD Report Reminder")
            .setColor(0xfaa61a)
            .setDescription(`Hey ${member.username}! You have not submitted your EOD report yet today. You have until midnight - go post it in <#${server.eodChannelId}>!`)
            .addFields({ name: "Need the template?", value: "Copy the pinned message in #eod-reports and fill it out." })
            .setTimestamp();
          await user.send({ embeds: [embed] });
          console.log(`DM reminder sent to ${member.username}`);
        } catch {
          console.log(`Could not DM ${member.username}`);
        }
      }
    }
  });
}

// ─── DM MISSED ───────────────────────────────────────────────────────────────

function scheduleDMMissed() {
  cron.schedule(CONFIG.dmMissedTime, async () => {
    const today = todayKey();
    const alreadyDMed = new Set();
    for (const server of SERVERS) {
      const all = await getMembers(server.guildId);
      const subs = await getSubmissions(server.guildId, today);
      const missing = all.filter((m) => !subs[m.userId]);
      for (const member of missing) {
        if (alreadyDMed.has(member.userId)) continue;
        alreadyDMed.add(member.userId);
        try {
          const user = await client.users.fetch(member.userId);
          let missStreak = 0;
          const d = new Date();
          while (true) {
            const key = d.toISOString().slice(0, 10);
            const daySubs = await getSubmissions(server.guildId, key);
            if (!daySubs[member.userId]) { missStreak++; d.setDate(d.getDate() - 1); }
            else break;
          }
          const embed = new EmbedBuilder()
            .setTitle("EOD Report Missed")
            .setColor(0xed4245)
            .setDescription(`Hey ${member.username}, you missed today's EOD report. Make sure you submit tomorrow!`)
            .addFields({ name: "Days missed in a row", value: `${missStreak} day${missStreak !== 1 ? "s" : ""}`, inline: true })
            .setTimestamp();
          await user.send({ embeds: [embed] });
          console.log(`DM missed sent to ${member.username}`);
        } catch {
          console.log(`Could not DM ${member.username}`);
        }
      }
    }
  });
}

// ─── START ───────────────────────────────────────────────────────────────────

connectDB().then(() => {
  client.login(CONFIG.token);
}).catch((err) => {
  console.error("Failed to connect to MongoDB:", err);
  process.exit(1);
});