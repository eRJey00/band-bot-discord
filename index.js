const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require("discord.js");
const { google } = require("googleapis");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const questCommandChannelId = "1374304268072386664";
const resultsChannelId = "1222642947908960266";

const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// // Підключає Express — міні вебсервер
// const express = require("express");
// const app = express();

// // Створює маршрут: при заході на головну сторінку ("GET /") відповідає текстом
// app.get("/", (req, res) => res.send("Bot is alive!"));

// // Запускає сервер на вказаному порту
// app.listen(process.env.PORT || 3000);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const selectedQuests = new Map();
const questOptions = [
  { label: "Товарний вибух", value: "Товарний вибух" },
  { label: "Допомога громадянам", value: "Допомога громадянам" },
  { label: "Суботник", value: "Суботник" },
  { label: "Крадіжний вибух", value: "Крадіжний вибух" },
  { label: "Інше", value: "Інше" },
];

(async () => {
  const commands = [
    new SlashCommandBuilder().setName("quest").setDescription("Показати список квестів для відмітки участі"),
    new SlashCommandBuilder()
      .setName("finish")
      .setDescription("Завершити квест і вказати статуси учасників")
      .addStringOption((option) => option.setName("pres").setDescription("Присутні учасники").setRequired(true))
      .addStringOption((option) => option.setName("afk").setDescription("АФК учасники").setRequired(true))
      .addStringOption((option) => option.setName("abs").setDescription("Відсутні учасники").setRequired(true)),
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  // 🔴 Очистка старих команд
  // Глобальні
  const globalCommands = await rest.get(Routes.applicationCommands(CLIENT_ID));
  for (const command of globalCommands) {
    await rest.delete(Routes.applicationCommand(CLIENT_ID, command.id));
    console.log(`🗑 Видалено глобальну команду: ${command.name}`);
  }

  // Гільдійні
  const guildCommands = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID));
  for (const command of guildCommands) {
    await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, GUILD_ID, command.id));
    console.log(`🗑 Видалено гільдійну команду: ${command.name}`);
  }

  // основа коду
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands.map((command) => command.toJSON()),
    });
    console.log("✅ Команди зареєстровані.");
  } catch (error) {
    console.error("❌ Помилка реєстрації команд:", error);
  }
})();

client.once("ready", () => {
  console.log(`✅ Бот активний як ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.channelId !== questCommandChannelId) {
    return interaction.reply({
      content: `⚠️ Взаємодія доступна лише у <#${questCommandChannelId}>.`,
      ephemeral: true,
    });
  }

  if (interaction.isCommand()) {
    try {
      if (interaction.commandName === "quest") {
        const selectMenu = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId("select_quest").setPlaceholder("🧩 Обери квест").addOptions(questOptions)
        );

        return await interaction.reply({
          content: "📌 Спершу обери квест із переліку нижче:",
          components: [selectMenu],
          ephemeral: true,
        });
      }

      if (interaction.commandName === "finish") {
        const pres = (interaction.options.getString("pres") || "")
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean);
        const afk = (interaction.options.getString("afk") || "")
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean);
        const abs = (interaction.options.getString("abs") || "")
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean);

        const questName = selectedQuests.get(interaction.guildId || interaction.channelId) || "Невідомий квест";
        const baseDate = getCurrentDateKey();

        const summary = generateSummary(pres, afk, abs, questName, baseDate);
        await interaction.reply({ content: summary, ephemeral: true });

        await saveToGoogleSheet(pres, afk, abs, baseDate, questName);
        await postSummaryToResultsChannel(summary);
      }
    } catch (error) {
      console.error("❌ Помилка обробки взаємодії:", error);
      await interaction.reply({
        content: "❌ Сталася помилка при обробці вашої команди.",
        ephemeral: true,
      });
    }
  } else if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "select_quest") {
      const selectedQuest = interaction.values[0];
      selectedQuests.set(interaction.guildId || interaction.channelId, selectedQuest);
      await interaction.update({
        content: `Ви обрали квест: **${selectedQuest}**. Тепер використайте команду /finish для відмітки учасників.`,
        components: [],
      });
    }
  }
});

function normalize(name) {
  return name.trim().toLowerCase();
}

function generateSummary(pres, afk, abs, questName, baseDate) {
  return `
**Звіт про участь: ${questName} (${baseDate})**
- ✅ Присутні: ${pres.join(", ") || "Ніхто"}
- 🟨 АФК / Внесок: ${afk.join(", ") || "Ніхто"}
- ❌ Відсутні: ${abs.join(", ") || "Ніхто"}
  `;
}

async function saveToGoogleSheet(pres, afk, abs, baseDate, questName) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    const role1 = guild.roles.cache.find((r) => r.name === "Бандерівці");
    const role2 = guild.roles.cache.find((r) => r.name === "[1] Стажер");

    if (!role1 && !role2) {
      console.error("Жодної з ролей не знайдено.");
      return;
    }

    const members = new Map();

    if (role1) {
      for (const [id, member] of role1.members) {
        members.set(id, member);
      }
    }
    if (role2) {
      for (const [id, member] of role2.members) {
        members.set(id, member); // Дублікати автоматично перезаписуються
      }
    }
    const userIdToStatus = new Map();

    function extractIds(list) {
      return list
        .map((entry) => {
          const match = entry.match(/^<@!?(\d+)>$/);
          return match ? match[1] : null;
        })
        .filter(Boolean);
    }

    const presIds = extractIds(pres);
    const afkIds = extractIds(afk);
    const absIds = extractIds(abs);

    for (const id of presIds) userIdToStatus.set(id, "✅");
    for (const id of afkIds) if (!userIdToStatus.has(id)) userIdToStatus.set(id, "🟨");
    for (const id of absIds) if (!userIdToStatus.has(id)) userIdToStatus.set(id, "❌");

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1:Z1000",
    });

    const data = getRes.data.values || [];

    // Ініціалізація заголовку
    if (data.length === 0) {
      data.push(["Нікнейм", "Discord ID", "Кількість"]);
    }

    let header = data[0];
    if (!header.includes("Discord ID")) {
      header.splice(1, 0, "Discord ID");
    }
    if (!header.includes("Кількість")) {
      header.splice(2, 0, "Кількість");
    }

    const newColumnName = `${baseDate} (${questName})`;
    if (!header.includes(newColumnName)) {
      header.push(newColumnName);
    }

    data[0] = header;

    const idColIndex = header.indexOf("Discord ID");
    const countColIndex = header.indexOf("Кількість");
    const dateColIndex = header.indexOf(newColumnName);

    const idToRowIndex = {};
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const discordId = row[idColIndex];
      if (discordId) {
        idToRowIndex[discordId] = i;
      }
    }

    for (const member of members.values()) {
      const name = member.displayName;
      const discordId = member.id;
      const status = userIdToStatus.get(discordId) || "⚪";

      if (idToRowIndex.hasOwnProperty(discordId)) {
        const rowIndex = idToRowIndex[discordId];
        const row = data[rowIndex];

        if (row[0] !== name) row[0] = name;

        while (row.length <= dateColIndex) {
          row.push("");
        }
        row[dateColIndex] = status;

        // Після всіх оновлень рядків — перерахуємо "✅" у рядку для кожного учасника
        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          let count = 0;
          for (let j = countColIndex + 1; j < row.length; j++) {
            if (row[j] === "✅") {
              count++;
            }
          }
          row[countColIndex] = count.toString();
        }
      } else {
        const newRow = new Array(header.length).fill("");
        newRow[0] = name;
        newRow[idColIndex] = discordId;
        newRow[dateColIndex] = status;
        newRow[countColIndex] = status === "✅" || status === "🟨" ? "1" : "0";
        data.push(newRow);
      }
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1:Z1000",
      valueInputOption: "RAW",
      requestBody: { values: data },
    });
  } catch (err) {
    console.error("❌ Помилка при збереженні в Google Sheets:", err);
  }
}

async function postSummaryToResultsChannel(summary) {
  const resultChannel = await client.channels.fetch(resultsChannelId);
  if (resultChannel?.isTextBased()) {
    resultChannel.send({ content: summary });
  }
}

function getCurrentDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

client.login(TOKEN);
