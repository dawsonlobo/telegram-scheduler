import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

// ======================================================
// SEED CONFIG
// ======================================================

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;

if (!MONGO_URI) {
  throw new Error("MONGO_URI is not configured");
}

if (!DB_NAME) {
  throw new Error("DB_NAME is not configured");
}

const mongoClient = new MongoClient(MONGO_URI);

// ======================================================
// TEST DATA
// ======================================================
//
// IMPORTANT:
// Replace the Telegram values below with the values for
// your actual Telegram user.
//
// sessionId:
//   Manually generated/stored GramJS StringSession.
//
// appId:
//   Telegram API ID.
//
// appHash:
//   Telegram API hash.
//
// groupId:
//   Telegram group/channel ID that the Telegram account
//   can access.
//
// topicId:
//   Forum topic/message ID. Set null if you do not want
//   to use a topic.
//
// ======================================================

const TEST_USER = {
  username: "test_scheduler_user",

  // MANUALLY PUT YOUR EXISTING GRAMJS SESSION STRING HERE.
  sessionId: "PASTE_YOUR_TELEGRAM_STRING_SESSION_HERE",

  // Telegram API credentials.
  appId: 12345678,
  appHash: "PASTE_YOUR_TELEGRAM_APP_HASH_HERE",

  isActive: true,

  // null means the scheduler has never successfully run
  // this user before.
  lastRunAt: null,
};

// ======================================================
// TEMPLATE DOCUMENTS
// ======================================================

const TEMPLATES = [
  {
    templateId: 10001,
    name: "Test Scheduler Message",
    message: "This is a test message from the scheduler.",
  },
  {
    templateId: 10002,
    name: "Second Test Message",
    message: "This is the second test scheduler message.",
  },
];

// ======================================================
// SCHEDULER CONFIG
// ======================================================
//
// intervalHours:
//   Minimum time between successful executions for a user.
//
// randomDelayMinutes:
//   Optional random delay added to interval calculation.
//   Set min/max to 0 for deterministic testing.
//
// windows:
//   Each window must contain:
//     userId
//     templateId
//     groupId
//     topicId
//     start
//     end
//
// ======================================================

const SCHEDULER_INTERVAL_HOURS = 6;

const RANDOM_DELAY_MINUTES = {
  min: 0,
  max: 0,
};

// Change these to your actual Telegram destination.
//
// Examples:
// groupId:
//   -1001234567890
//
// topicId:
//   - null for a normal group/channel message
//   - forum topic/message ID for a forum topic
//
const TELEGRAM_GROUP_ID = "-1001234567890";
const TELEGRAM_TOPIC_ID = null;

// Use a window that is currently active when you want to
// test immediately.
//
// Example:
// 00:00 -> 23:59 means almost the entire day.
//
// For production, change this to your actual schedule.
const WINDOW_START = "00:00";
const WINDOW_END = "23:59";

// ======================================================
// MAIN SEED
// ======================================================

async function seed() {
  try {
    console.log("Connecting to MongoDB...");

    await mongoClient.connect();

    const db = mongoClient.db(DB_NAME);

    const usersCollection = db.collection("users");
    const templatesCollection = db.collection("templates");
    const schedulerConfigCollection =
      db.collection("scheduler_config");

    console.log(`Connected to database: ${DB_NAME}`);

    // ==================================================
    // 1. CREATE / UPDATE USER
    // ==================================================

    let user = await usersCollection.findOne({
      username: TEST_USER.username,
    });

    if (!user) {
      const userDocument = {
        ...TEST_USER,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await usersCollection.insertOne(userDocument);

      user = {
        ...userDocument,
        _id: result.insertedId,
      };

      console.log(`Created user: ${user._id}`);
    } else {
      // Update scheduler-relevant fields while preserving
      // the existing MongoDB _id and lastRunAt.
      await usersCollection.updateOne(
        { _id: user._id },
        {
          $set: {
            sessionId: TEST_USER.sessionId,
            appId: TEST_USER.appId,
            appHash: TEST_USER.appHash,
            isActive: TEST_USER.isActive,
            updatedAt: new Date(),
          },
        }
      );

      user = await usersCollection.findOne({
        _id: user._id,
      });

      console.log(`Using existing user: ${user._id}`);
    }

    const userId = user._id.toString();

    // ==================================================
    // 2. VALIDATE TELEGRAM SETTINGS
    // ==================================================

    if (
      !TEST_USER.sessionId ||
      TEST_USER.sessionId ===
        "PASTE_YOUR_TELEGRAM_STRING_SESSION_HERE"
    ) {
      console.warn(
        "\nWARNING: Replace TEST_USER.sessionId with your actual " +
          "manually stored GramJS StringSession before running " +
          "the scheduler.\n"
      );
    }

    if (
      !TEST_USER.appHash ||
      TEST_USER.appHash === "PASTE_YOUR_TELEGRAM_APP_HASH_HERE"
    ) {
      console.warn(
        "\nWARNING: Replace TEST_USER.appHash with your actual " +
          "Telegram API hash before running the scheduler.\n"
      );
    }

    // ==================================================
    // 3. INSERT / UPDATE TEMPLATES
    // ==================================================

    for (const template of TEMPLATES) {
      await templatesCollection.updateOne(
        {
          templateId: template.templateId,
        },
        {
          $set: {
            name: template.name,
            message: template.message,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        {
          upsert: true,
        }
      );

      console.log(
        `Template ready: ${template.templateId}`
      );
    }

    // ==================================================
    // 4. CREATE SCHEDULER CONFIG
    // ==================================================
    //
    // The corrected scheduler reads exactly one document:
    //
    // scheduler_config:
    // {
    //   _id: "main"
    // }
    //
    // ==================================================

    const schedulerConfig = {
      _id: "main",

      intervalHours: SCHEDULER_INTERVAL_HOURS,

      randomDelayMinutes: RANDOM_DELAY_MINUTES,

      windows: [
        {
          userId,
          templateId: TEMPLATES[0].templateId,

          groupId: TELEGRAM_GROUP_ID,
          topicId: TELEGRAM_TOPIC_ID,

          start: WINDOW_START,
          end: WINDOW_END,
        },
      ],

      updatedAt: new Date(),
    };

    await schedulerConfigCollection.replaceOne(
      { _id: "main" },
      schedulerConfig,
      { upsert: true }
    );

    console.log("Scheduler configuration ready.");

    // ==================================================
    // 5. CREATE INDEXES
    // ==================================================

    await usersCollection.createIndex(
      { username: 1 },
      { unique: true }
    );

    await templatesCollection.createIndex(
      { templateId: 1 },
      { unique: true }
    );

    console.log("Indexes ready.");

    // ==================================================
    // 6. DISPLAY SEEDED DATA
    // ==================================================

    console.log("\n========================================");
    console.log("SEED COMPLETED");
    console.log("========================================");

    console.log("\nUser:");
    console.log(
      JSON.stringify(
        {
          _id: user._id,
          username: user.username,
          isActive: user.isActive,
          hasSessionId: Boolean(user.sessionId),
          appId: user.appId,
          lastRunAt: user.lastRunAt,
        },
        null,
        2
      )
    );

    console.log("\nTemplates:");
    console.log(
      JSON.stringify(TEMPLATES, null, 2)
    );

    console.log("\nScheduler config:");
    console.log(
      JSON.stringify(schedulerConfig, null, 2)
    );

    console.log("\nNext step:");
    console.log(
      "1. Put your real sessionId/appId/appHash in the seed."
    );
    console.log(
      "2. Put your real Telegram groupId/topicId in the seed."
    );
    console.log(
      "3. Run this seed."
    );
    console.log(
      "4. Start the scheduler."
    );
  } catch (error) {
    console.error("\nSeed failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoClient.close();
    console.log("\nMongoDB connection closed.");
  }
}

// ======================================================
// RUN
// ======================================================

void seed();
