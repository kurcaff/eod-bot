/**
 * EOD Clipper Tracker Bot
 * ========================
 * Watches #eod-reports, auto-marks submissions, sends daily reminders,
 * and posts a nightly summary of who submitted and who didn't.
 *
 * SETUP:
 *   1. npm install discord.js node-cron
 *   2. Fill in the CONFIG section below
 *   3. node bot.js
 */

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");
const fs = require("fs");

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  token: "MTUwOTIxMDM1ODMwNzQ5MTk0MA.GDYsBw.FUfVtBkylljLD8evARdBd538_DONW3gaicMsS4",  // Bot token from Discord Developer Portal
  guildId: "1506652573707276398",        // Right-click your server → Copy Server ID
  eodChannelId: "1509203195576979456",   // #eod-reports channel ID
  logChannelId: "1509239200698859681",   // Channel where the bot posts daily summaries
  reminderChannelId: "1509203195576979456", // Usually same as eodChannelId

  // Role to ping in reminders (e.g. "Clippers"). Set to null to ping no one.
  clipperRoleName: "Clippers",

  // Daily reminder time — "minute hour * * *" (cron format, 24h, server local time)
  reminderTime: "0 22 * * *",   // 10:00 PM every day

  // Daily summary time — posted after deadline
  summaryTime: "0 23 * * *",    // 11:00 PM every day

  // Where submissions are stored (local JSON file)
  dataFile: "./eod_data.json",
};

// ─── DATA HELPERS ────────────────────────────────────────────────────────────

function loadData() {
  if (!fs.existsSync(CONFIG.dataFile)) return { members: {}, submissions: {} };
  return JSON.parse(fs.readFileSync(CONFIG.dataFile, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-05-27"
}

function fmtDate(key) {
  return new Date(key + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });
}

// ─── BOT SETUP ───────────────────────────────────────────────────────────────

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
});

// ─── AUTO-DETECT EOD SUBMISSIONS ─────────────────────────────────────────────

client.on("messageCreate", (message) => {
  // Only watch the EOD channel, ignore bots
  if (message.channelId !== CONFIG.eodChannelId) return;
  if (message.author.bot) return;

  const content = message.content.toLowerCase();

  // Must look like an EOD report (contains at least one of these keywords)
  const keywords = ["eod report", "what i completed", "clips made", "hours worked"];
  const isEOD = keywords.some((kw) => content.includes(kw));
  if (!isEOD) return;

  const data = loadData();
  const today = todayKey();
  const userId = message.author.id;
  const username = message.author.username;

  // Register member if new
  if (!data.members[userId]) {
    data.members[userId] = { username, joinedAt: today };
  }

  // Record submission
  if (!data.submissions[today]) data.submissions[today] = {};
  data.submissions[today][userId] = {
    username,
    submittedAt: new Date().toISOString(),
    messageUrl: message.url,
    preview: message.content.slice(0, 200),
  };

  saveData(data);

  // React to confirm receipt
  message.react("✅").catch(() => {});

  console.log(`📋 EOD received from ${username} on ${today}`);
});

// ─── COMMANDS ────────────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!eod")) return;

  const args = message.content.slice(4).trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  const data = loadData();
  const today = todayKey();

  // !eod status — show today's submission status
  if (cmd === "status" || !cmd) {
    const todaySubs = data.submissions[today] || {};
    const allMembers = Object.entries(data.members);
    if (allMembers.length === 0) {
      return message.reply("No clippers registered yet. They'll be auto-added when they send their first EOD.");
    }

    const sent = allMembers.filter(([id]) => todaySubs[id]);
    const missing = allMembers.filter(([id]) => !todaySubs[id]);

    const embed = new EmbedBuilder()
      .setTitle(`📋 EOD Status — ${fmtDate(today)}`)
      .setColor(missing.length === 0 ? 0x57f287 : 0xfaa61a)
      .addFields(
        {
          name: `✅ Submitted (${sent.length})`,
          value: sent.length
            ? sent.map(([, m]) => `• ${m.username}`).join("\n")
            : "—",
          inline: true,
        },
        {
          name: `❌ Missing (${missing.length})`,
          value: missing.length
            ? missing.map(([, m]) => `• ${m.username}`).join("\n")
            : "—",
          inline: true,
        }
      )
      .setFooter({ text: `${sent.length}/${allMembers.length} submitted` })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // !eod streak — show everyone's current streak
  if (cmd === "streak") {
    const allMembers = Object.entries(data.members);
    if (allMembers.length === 0) return message.reply("No clippers yet.");

    const streaks = allMembers.map(([id, m]) => {
      let streak = 0;
      const d = new Date();
      while (true) {
        const key = d.toISOString().slice(0, 10);
        if (data.submissions[key]?.[id]) {
          streak++;
          d.setDate(d.getDate() - 1);
        } else break;
      }
      return { username: m.username, streak };
    });

    streaks.sort((a, b) => b.streak - a.streak);

    const embed = new EmbedBuilder()
      .setTitle("🔥 Current Streaks")
      .setColor(0x5865f2)
      .setDescription(
        streaks
          .map((s, i) => `${i + 1}. **${s.username}** — ${s.streak} day${s.streak !== 1 ? "s" : ""}`)
          .join("\n")
      )
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // !eod history @user — show a member's last 7 days
  if (cmd === "history") {
    const mentioned = message.mentions.users.first();
    if (!mentioned) return message.reply("Usage: `!eod history @username`");

    const uid = mentioned.id;
    const rows = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const sub = data.submissions[key]?.[uid];
      rows.push(`${fmtDate(key)}: ${sub ? "✅ Sent" : "❌ Missing"}`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`📅 Last 7 days — ${mentioned.username}`)
      .setColor(0x5865f2)
      .setDescription(rows.join("\n"))
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // !eod remove @user — remove a member from tracking
  if (cmd === "remove") {
    const mentioned = message.mentions.users.first();
    if (!mentioned) return message.reply("Usage: `!eod remove @username`");
    delete data.members[mentioned.id];
    saveData(data);
    return message.reply(`✅ Removed **${mentioned.username}** from the tracker.`);
  }

  // !eod help
  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setTitle("EOD Bot — Commands")
      .setColor(0x5865f2)
      .addFields(
        { name: "`!eod status`", value: "Today's submission status", inline: false },
        { name: "`!eod streak`", value: "Everyone's current streak", inline: false },
        { name: "`!eod history @user`", value: "Last 7 days for a clipper", inline: false },
        { name: "`!eod remove @user`", value: "Remove someone from tracking", inline: false },
      )
      .setFooter({ text: "Clippers are auto-added when they post their first EOD" });
    return message.reply({ embeds: [embed] });
  }
});

// ─── SCHEDULED REMINDER ──────────────────────────────────────────────────────

function scheduleReminder() {
  cron.schedule(CONFIG.reminderTime, async () => {
    const guild = client.guilds.cache.get(CONFIG.guildId);
    const channel = guild?.channels.cache.get(CONFIG.reminderChannelId);
    if (!channel) return;

    let rolePing = "";
    if (CONFIG.clipperRoleName) {
      const role = guild.roles.cache.find((r) => r.name === CONFIG.clipperRoleName);
      if (role) rolePing = `<@&${role.id}> `;
    }

    const data = loadData();
    const today = todayKey();
    const todaySubs = data.submissions[today] || {};
    const missing = Object.entries(data.members).filter(([id]) => !todaySubs[id]);

    const embed = new EmbedBuilder()
      .setTitle("⏰ EOD Report Reminder")
      .setColor(0xfaa61a)
      .setDescription(
        `${rolePing}Don't forget to submit your EOD report before midnight!\n\nCopy the pinned template, fill it out, and post it here.`
      )
      .addFields({
        name: `Still missing (${missing.length})`,
        value: missing.length
          ? missing.map(([, m]) => `• ${m.username}`).join("\n")
          : "Everyone submitted already! 🎉",
      })
      .setTimestamp();

    channel.send({ embeds: [embed] });
  });
}

// ─── SCHEDULED NIGHTLY SUMMARY ───────────────────────────────────────────────

function scheduleSummary() {
  cron.schedule(CONFIG.summaryTime, async () => {
    const guild = client.guilds.cache.get(CONFIG.guildId);
    const channel = guild?.channels.cache.get(CONFIG.logChannelId);
    if (!channel) return;

    const data = loadData();
    const today = todayKey();
    const todaySubs = data.submissions[today] || {};
    const allMembers = Object.entries(data.members);

    const sent = allMembers.filter(([id]) => todaySubs[id]);
    const missing = allMembers.filter(([id]) => !todaySubs[id]);
    const rate = allMembers.length
      ? Math.round((sent.length / allMembers.length) * 100)
      : 0;

    const embed = new EmbedBuilder()
      .setTitle(`📊 EOD Summary — ${fmtDate(today)}`)
      .setColor(missing.length === 0 ? 0x57f287 : 0xed4245)
      .addFields(
        {
          name: `✅ Submitted (${sent.length})`,
          value: sent.length
            ? sent.map(([id, m]) => `• [${m.username}](${todaySubs[id].messageUrl})`).join("\n")
            : "—",
          inline: true,
        },
        {
          name: `❌ Didn't submit (${missing.length})`,
          value: missing.length
            ? missing.map(([, m]) => `• ${m.username}`).join("\n")
            : "—",
          inline: true,
        }
      )
      .setFooter({ text: `Submission rate: ${rate}% • ${sent.length}/${allMembers.length} clippers` })
      .setTimestamp();

    channel.send({ embeds: [embed] });
  });
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────

client.login(CONFIG.token);
