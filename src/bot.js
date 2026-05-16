const { Client, Events, GatewayIntentBits } = require("discord.js");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const Graph = require("graphology");
const gexf = require("graphology-gexf");
const fs = require("fs");
const crypto = require("crypto");
const { expressMain } = require("./express");
require("dotenv").config();

// Initialize Prisma Client
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

// Global counters
let mentionsCounter = 0;
const MENTIONS_THRESHOLD = 15;
let totalMessagesProcessed = 0; // Count every non-bot message processed
let commandCount = 0; // Count every command processed
let graphGenerationCounter = 0; // Count how many times the graph is generated

// Create the Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});

// Global listener to count all non-bot messages
client.on(Events.MessageCreate, async (message) => {
  if (!message.author.bot) {
    totalMessagesProcessed++;
  }
});

// Utility: Update user info only if the user is opted in (exists in UserLookup)
async function updateUserLookup(prisma, user) {
  if (!user) return;
  // Check if user is opted in
  const existing = await prisma.userLookup.findUnique({
    where: { id: BigInt(user.id) },
  });
  if (!existing) return; // user is not opted in, do nothing

  const member = await user.client.guilds.cache
    .get(process.env.DISCORD_SERVER_ID)
    ?.members.fetch(user.id);
  const avatar = member
    ? member.user.displayAvatarURL()
    : "https://cdn.discordapp.com/embed/avatars/0.png";
  const displayname = member ? member.displayName : user.username;
  await prisma.userLookup.update({
    where: { id: BigInt(user.id) },
    data: { username: user.username, displayname, avatar },
  });
  console.log(`[UserLookup] Updated data for user ${user.username}`);
}

// Generate the GEXF graph and increment graph generation counter
async function generateGEXF() {
  console.log("Generating graph...");
  graphGenerationCounter++; // Increment the graph generation counter

  // Create a new graph
  const graph = new Graph();

  // Fetch all mentions and user lookups
  const mentions = await prisma.mention.findMany();
  const userLookups = await prisma.userLookup.findMany();

  // Create a map of users (keyed by their id as string)
  const userMap = new Map();
  userLookups.forEach((user) => {
    const key = user.id.toString();
    userMap.set(key, {
      id: user.id,
      username: user.username,
      displayname: user.displayname,
      avatar: user.avatar,
    });
  });

  // Add nodes for each opted-in user in the graph
  userMap.forEach((user) => {
    graph.addNode(user.id, {
      label: user.displayname,
      subLabel: user.username,
      type: "image",
      image: user.avatar,
    });
  });

  // Add edges for each mention
  mentions.forEach((mention) => {
    const key1 = mention.user1Id.toString();
    const key2 = mention.user2Id.toString();
    const user1 = userMap.get(key1);
    const user2 = userMap.get(key2);
    if (user1 && user2) {
      if (graph.hasEdge(user1.id, user2.id)) {
        graph.updateEdgeAttribute(
          user1.id,
          user2.id,
          "weight",
          (w) => w + mention.count,
        );
      } else {
        graph.addEdge(user1.id, user2.id, { weight: mention.count });
      }
    }
  });

  // Export the graph to a GEXF file
  try {
    fs.writeFileSync("data/graph.gexf", gexf.write(graph));
    console.log("Graph successfully exported to data/graph.gexf");
  } catch (err) {
    console.error("Error exporting graph:", err);
  }
}

// On client ready
client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  readyClient.user.setActivity(process.env.ACTIVITY);
  expressMain(prisma);
});

// Handle commands and increment command count
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith(process.env.PREFIX)) {
    commandCount++; // Increment command counter
    const args = message.content
      .slice(process.env.PREFIX.length)
      .trim()
      .split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
      case "help":
        message.channel.send(`
**stats!**
Commands:
- **help**: Show this message
- **ping**: Check bot latency
- **optin**: Opt in to the graph (you are opted out by default)
- **optout**: Opt out of the graph (all your data will be removed)
${message.author.id === process.env.BOT_OWNER ? "- **migratestats <oldUserId> <newUserId>**: (Bot Owner Only) Migrate all stats from oldUser to newUser." : ""}

When you opt out all your data will be removed from the graph.
You automatically opt out when you leave the server. Your data will also be removed when you leave.

You can view the graph at https://stats.grainware.org/
Privacy policy: https://stats-backend.grainware.org/privacy
                `);
        console.log("[Command] Help command executed.");
        break;

      case "optin":
        if (
          await prisma.userLookup.findUnique({
            where: { id: BigInt(message.author.id) },
          })
        ) {
          message.channel.send("You are already opted in!");
          console.log(
            `[OptIn] User ${message.author.username} attempted to opt in but is already opted in.`,
          );
          return;
        }
        // Add the user to the database
        const member = await message.client.guilds.cache
          .get(process.env.DISCORD_SERVER_ID)
          ?.members.fetch(message.author.id);
        const avatar = member
          ? member.user.displayAvatarURL()
          : "https://cdn.discordapp.com/embed/avatars/0.png";
        const displayname = member
          ? member.displayName
          : message.author.username;
        await prisma.userLookup.upsert({
          where: { id: BigInt(message.author.id) },
          update: { username: message.author.username, displayname, avatar },
          create: {
            id: BigInt(message.author.id),
            username: message.author.username,
            displayname,
            avatar,
          },
        });
        message.channel.send("You have successfully opted in to the graph!");
        console.log(`[OptIn] User ${message.author.username} opted in.`);
        await generateGEXF();
        break;

      case "optout":
        if (
          !(await prisma.userLookup.findUnique({
            where: { id: BigInt(message.author.id) },
          }))
        ) {
          message.channel.send("You are already opted out!");
          console.log(
            `[OptOut] User ${message.author.username} attempted to opt out but was already opted out.`,
          );
          return;
        }
        // Delete the user from the database
        await prisma.userLookup
          .delete({
            where: { id: BigInt(message.author.id) },
          })
          .catch((e) => console.error("User not opted in:", e));

        // Delete any mention data involving the user
        await prisma.mention.deleteMany({
          where: {
            OR: [
              { user1Id: BigInt(message.author.id) },
              { user2Id: BigInt(message.author.id) },
            ],
          },
        });
        message.channel.send(
          "You have successfully opted out, and your data has been removed from the graph.",
        );
        console.log(`[OptOut] User ${message.author.username} opted out.`);
        await generateGEXF();
        break;

      case "forcetoggleoptin":
        // check if user id is bot owner
        if (message.author.id !== process.env.BOT_OWNER) {
          message.channel.send("You are not authorized to use this command.");
          console.log("[ForceToggle] Unauthorized access attempt.");
          return;
        }

        if (message.mentions.users.size === 0) {
          message.channel.send(
            "You must mention a user to toggle their opt-in status.",
          );
          return;
        }

        const toggledUser = message.mentions.users.first();
        // Only allow toggling if the mentioned user is a bot
        if (!toggledUser.bot) {
          message.channel.send(
            "You can only force toggle bot statuses to prevent abuse.",
          );
          console.log(
            `[ForceToggle] Attempted to toggle non-bot user ${toggledUser.username}.`,
          );
          return;
        }

        const toggledUserRecord = await prisma.userLookup.findUnique({
          where: { id: BigInt(toggledUser.id) },
        });

        if (toggledUserRecord) {
          await prisma.userLookup.delete({
            where: { id: BigInt(toggledUser.id) },
          });
          await prisma.mention.deleteMany({
            where: {
              OR: [
                { user1Id: BigInt(toggledUser.id) },
                { user2Id: BigInt(toggledUser.id) },
              ],
            },
          });
          message.channel.send(
            `Force opt-out for ${toggledUser.username} completed.`,
          );
          console.log(
            `[ForceToggle] Force opt-out for ${toggledUser.username} completed.`,
          );
        } else {
          const member = await message.client.guilds.cache
            .get(process.env.DISCORD_SERVER_ID)
            ?.members.fetch(toggledUser.id);
          const avatar = member
            ? member.user.displayAvatarURL()
            : "https://cdn.discordapp.com/embed/avatars/0.png";
          const displayname = member
            ? member.displayName
            : toggledUser.username;
          await prisma.userLookup.upsert({
            where: { id: BigInt(toggledUser.id) },
            update: { username: toggledUser.username, displayname, avatar },
            create: {
              id: BigInt(toggledUser.id),
              username: toggledUser.username,
              displayname,
              avatar,
            },
          });
          message.channel.send(
            `Force opt-in for ${toggledUser.username} completed.`,
          );
          console.log(
            `[ForceToggle] Force opt-in for ${toggledUser.username} completed.`,
          );
        }

        await generateGEXF();
        break;

      case "forceoptout":
        // check if user id is bot owner
        if (message.author.id !== process.env.BOT_OWNER) {
          message.channel.send("You are not authorized to use this command.");
          console.log("[ForceOptOut] Unauthorized access attempt.");
          return;
        }

        if (message.mentions.users.size === 0) {
          message.channel.send("You must mention a user to force opt-out.");
          return;
        }

        const forceOptOutUser = message.mentions.users.first();

        await prisma.userLookup
          .delete({
            where: { id: BigInt(forceOptOutUser.id) },
          })
          .catch((e) => console.error("User not opted in:", e));

        await prisma.mention.deleteMany({
          where: {
            OR: [
              { user1Id: BigInt(forceOptOutUser.id) },
              { user2Id: BigInt(forceOptOutUser.id) },
            ],
          },
        });
        message.channel.send(
          `Force opt-out for ${forceOptOutUser.username} completed.`,
        );
        console.log(
          `[ForceOptOut] Force opt-out for ${forceOptOutUser.username} completed.`,
        );
        await generateGEXF();
        break;

      case "migratestats":
        if (message.author.id !== process.env.BOT_OWNER) {
          message.channel.send("You are not authorized to use this command.");
          console.log("[MigrateStats] Unauthorized access attempt.");
          return;
        }

        if (args.length !== 2) {
          message.channel.send("Usage: migratestats <oldUserId> <newUserId>");
          return;
        }

        const oldUserIdString = args[0];
        const newUserIdString = args[1];

        if (isNaN(oldUserIdString) || isNaN(newUserIdString)) {
          message.channel.send("User IDs must be numbers.");
          return;
        }

        const oldUserIdBigInt = BigInt(oldUserIdString);
        const newUserIdBigInt = BigInt(newUserIdString);

        if (oldUserIdBigInt === newUserIdBigInt) {
          message.channel.send("Old and new user IDs cannot be the same.");
          return;
        }

        try {
          const oldUserLookup = await prisma.userLookup.findUnique({
            where: { id: oldUserIdBigInt },
          });
          if (!oldUserLookup) {
            message.channel.send(
              `Old user ID ${oldUserIdString} not found among opted-in users.`,
            );
            return;
          }

          const newMember = await message.client.guilds.cache
            .get(process.env.DISCORD_SERVER_ID)
            ?.members.fetch(newUserIdString)
            .catch(() => null);
          if (!newMember) {
            message.channel.send(
              `Could not fetch new user details for ID ${newUserIdString} from Discord. Make sure the ID is correct and the user is in this server.`,
            );
            return;
          }
          const newAvatar = newMember.user.displayAvatarURL();
          const newDisplayname = newMember.displayName;
          const newUsername = newMember.user.username;

          // Upsert new user's details
          await prisma.userLookup.upsert({
            where: { id: newUserIdBigInt },
            update: {
              username: newUsername,
              displayname: newDisplayname,
              avatar: newAvatar,
            },
            create: {
              id: newUserIdBigInt,
              username: newUsername,
              displayname: newDisplayname,
              avatar: newAvatar,
            },
          });

          // Migrate mentions
          const mentionsToMigrate = await prisma.mention.findMany({
            where: {
              OR: [{ user1Id: oldUserIdBigInt }, { user2Id: oldUserIdBigInt }],
            },
          });

          for (const mention of mentionsToMigrate) {
            // Delete the old mention first
            await prisma.mention.delete({
              where: {
                user1Id_user2Id: {
                  user1Id: mention.user1Id,
                  user2Id: mention.user2Id,
                },
              },
            });

            let u1 = mention.user1Id;
            let u2 = mention.user2Id;

            if (u1 === oldUserIdBigInt) u1 = newUserIdBigInt;
            if (u2 === oldUserIdBigInt) u2 = newUserIdBigInt;

            // If migration results in a self-mention (u1 === u2), skip adding it back
            if (u1 === u2) {
              console.log(
                `[MigrateStats] Skipped self-mention for user ${newUserIdString} from original mention between ${mention.user1Id} and ${mention.user2Id} with count ${mention.count}`,
              );
              continue;
            }

            const [finalUser1Id, finalUser2Id] = [u1, u2].sort((a, b) =>
              a < b ? -1 : 1,
            );

            await prisma.mention.upsert({
              where: {
                user1Id_user2Id: {
                  user1Id: finalUser1Id,
                  user2Id: finalUser2Id,
                },
              },
              update: { count: { increment: mention.count } },
              create: {
                user1Id: finalUser1Id,
                user2Id: finalUser2Id,
                count: mention.count,
              },
            });
          }

          // Delete old user's lookup record
          await prisma.userLookup.delete({ where: { id: oldUserIdBigInt } });

          message.channel.send(
            `Successfully migrated stats from ${oldUserIdString} to ${newUserIdString}.`,
          );
          console.log(
            `[MigrateStats] Successfully migrated stats from ${oldUserIdString} to ${newUserIdString}.`,
          );
          await generateGEXF();
        } catch (error) {
          console.error("[MigrateStats] Error during migration:", error);
          message.channel.send(
            "An error occurred during migration. Check the logs.",
          );
        }
        break;

      case "ping":
        const latency = Date.now() - message.createdTimestamp;
        message.channel.send(`Pong! Latency is ${latency}ms.`);
        console.log(`[Ping] Responded with latency ${latency}ms.`);
        break;

      default:
        message.channel.send(
          `Unknown command. Type **${process.env.PREFIX}help** for help.`,
        );
        console.log(`[Command] Unknown command received: ${command}`);
    }
  }
});

// Handle mentions for graph updates (only for opted-in users)
client.on(Events.MessageCreate, async (message) => {
  if (message.guild?.id !== process.env.DISCORD_SERVER_ID) {
    console.log("Ignoring message from different server or channel");
    return;
  }

  if (message.mentions.users.size === 0) return;

  // Check if the message author is opted in
  const authorRecord = await prisma.userLookup.findUnique({
    where: { id: BigInt(message.author.id) },
  });
  if (!authorRecord) {
    console.log(
      `Author ${message.author.username} is not opted in, skipping mention processing.`,
    );
    return;
  }
  await updateUserLookup(prisma, message.author);

  for (const user of message.mentions.users.values()) {
    const mentionedRecord = await prisma.userLookup.findUnique({
      where: { id: BigInt(user.id) },
    });
    if (!mentionedRecord) {
      console.log(`Mentioned user ${user.username} is not opted in, skipping.`);
      continue;
    }
    await updateUserLookup(prisma, user);

    // Sort user IDs so that user1Id < user2Id
    const [user1Id, user2Id] = [
      BigInt(message.author.id),
      BigInt(user.id),
    ].sort((a, b) => (a < b ? -1 : 1));

    await prisma.mention.upsert({
      where: { user1Id_user2Id: { user1Id, user2Id } },
      update: { count: { increment: 1 } },
      create: { user1Id, user2Id, count: 1 },
    });
    console.log(
      `[Mentions] Processed mention from ${message.author.username} to ${user.username}`,
    );
  }

  mentionsCounter++;
  console.log(`Mentions processed counter: ${mentionsCounter}`);
  if (mentionsCounter >= MENTIONS_THRESHOLD) {
    mentionsCounter = 0;
    await generateGEXF();
  }
});

// On server leave, remove the user's data
client.on(Events.GuildMemberRemove, async (member) => {
  console.log(
    `User ${member.user.username} left the server. Removing their data...`,
  );
  await prisma.userLookup
    .delete({
      where: { id: BigInt(member.id) },
    })
    .catch((e) => console.error(e));
  await prisma.mention.deleteMany({
    where: {
      OR: [{ user1Id: BigInt(member.id) }, { user2Id: BigInt(member.id) }],
    },
  });
  console.log(`[GuildRemove] Removed data for user ${member.user.username}`);
  await generateGEXF();
});

// Start the bot
client.login(process.env.DISCORD_TOKEN);
