import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

// ======================================================
// CONFIG
// ======================================================

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;

if (!MONGO_URI) {
  throw new Error("MONGO_URI is not configured");
}

if (!DB_NAME) {
  throw new Error("DB_NAME is not configured");
}

// ======================================================
// MONGODB
// ======================================================

const mongoClient = new MongoClient(MONGO_URI);

let db;
let usersCollection;
let templatesCollection;
let schedulerConfigCollection;

// ======================================================
// CONNECTIONS
// ======================================================

const connections = new Map();

// ======================================================
// CURRENT DATA CACHE
// ======================================================

let currentScheduleConfig = null;

// ======================================================
// SCHEDULER STATE
// ======================================================

let timeout = null;
let schedulerRunning = false;

// ======================================================
// CONNECT MONGODB
// ======================================================

async function connectMongoDB() {
  await mongoClient.connect();

  db = mongoClient.db(DB_NAME);

  usersCollection = db.collection("users");
  templatesCollection = db.collection("templates");
  schedulerConfigCollection = db.collection("scheduler_config");

  console.log("MongoDB connected");
}

// ======================================================
// MONGODB ID HELPER
// Supports both ObjectId and string _id values.
// ======================================================

function buildUserIdFilter(userId) {
  if (userId instanceof ObjectId) {
    return { _id: userId };
  }

  if (typeof userId === "string" && ObjectId.isValid(userId)) {
    return {
      _id: {
        $in: [new ObjectId(userId), userId],
      },
    };
  }

  return { _id: userId };
}

// ======================================================
// VALIDATION HELPERS
// ======================================================

function isValidTime(value) {
  if (typeof value !== "string") {
    return false;
  }

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return Boolean(match);
}

function validateScheduleConfig(schedule) {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("Invalid scheduler configuration");
  }

  if (!Array.isArray(schedule.windows) || schedule.windows.length === 0) {
    throw new Error("scheduler_config/main must contain at least one window");
  }

  if (
    typeof schedule.intervalMinutes !== "number" ||
    !Number.isFinite(schedule.intervalMinutes) ||
    schedule.intervalMinutes < 0
  ) {
    throw new Error("intervalMinutes must be a non-negative number");
  }

  for (const window of schedule.windows) {
    if (!window || typeof window !== "object") {
      throw new Error("Invalid scheduler window");
    }

    if (!isValidTime(window.start) || !isValidTime(window.end)) {
      throw new Error(
        `Invalid window time. Expected HH:mm, received start=${window.start}, end=${window.end}`
      );
    }

    if (!window.userId) {
      throw new Error("Every scheduler window must contain userId");
    }

    if (!window.templateId) {
      throw new Error(
        `Window for user ${window.userId} must contain templateId`
      );
    }

    if (!window.groupId) {
      throw new Error(
        `Window for user ${window.userId} must contain groupId`
      );
    }
  }

  if (schedule.randomDelayMinutes != null) {
    const { min, max } = schedule.randomDelayMinutes;

    if (
      typeof min !== "number" ||
      typeof max !== "number" ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min < 0 ||
      max < min
    ) {
      throw new Error(
        "randomDelayMinutes must contain valid non-negative min/max values"
      );
    }
  }
}

// ======================================================
// INITIALIZE TELEGRAM CONNECTION
// sessionId is intentionally read from the user document.
// ======================================================

async function initializeConnection(user) {
  if (!user.sessionId) {
    throw new Error(`User ${user._id} has no sessionId`);
  }

  if (!user.appId) {
    throw new Error(`User ${user._id} has no appId`);
  }

  if (!user.appHash) {
    throw new Error(`User ${user._id} has no appHash`);
  }

  console.log(`Initializing Telegram connection: ${user.sessionId}`);

  const client = await loginTelegram(
    user.sessionId,
    user.appId,
    user.appHash
  );

  if (!client) {
    throw new Error(`Telegram login failed for user ${user._id}`);
  }

  // Group discovery is part of connection initialization.
  // If it fails, initialization fails instead of silently continuing.
  await assignGroups(client);

  return {
    connection: client,
    sessionId: user.sessionId,
  };
}

// ======================================================
// INITIALIZE ACTIVE USERS
// ======================================================

async function initializeActiveUsers() {
  const users = await usersCollection
    .find({ isActive: true })
    .toArray();

  const activeUserIds = new Set(
    users.map((user) => user._id.toString())
  );

  for (const user of users) {
    const userId = user._id.toString();

    try {
      if (!user.sessionId) {
        console.log(`Skipping ${user.username ?? userId}: no sessionId`);
        continue;
      }

      const existingConnection = connections.get(userId);

      // Reuse the existing connection when the manually stored
      // sessionId has not changed.
      if (
        existingConnection &&
        existingConnection.sessionId === user.sessionId
      ) {
        continue;
      }

      // If the session changed, close the old client first.
      if (existingConnection?.connection) {
        await disconnectTelegramClient(existingConnection.connection);
        connections.delete(userId);
      }

      const connection = await initializeConnection(user);

      connections.set(userId, connection);

      console.log(
        `Connection initialized: ${user.username ?? userId}`
      );
    } catch (error) {
      console.error(
        `Connection initialization failed for ${user.username ?? userId}:`,
        error
      );

      // Do not keep a broken connection in the cache.
      const existingConnection = connections.get(userId);

      if (existingConnection?.connection) {
        await disconnectTelegramClient(existingConnection.connection);
      }

      connections.delete(userId);
    }
  }

  // Remove connections for users who are no longer active.
  for (const [userId, connection] of connections.entries()) {
    if (!activeUserIds.has(userId)) {
      await disconnectTelegramClient(connection.connection);
      connections.delete(userId);

      console.log(`Removed inactive user connection: ${userId}`);
    }
  }
}

// ======================================================
// DISCONNECT TELEGRAM CLIENT
// ======================================================

async function disconnectTelegramClient(client) {
  if (!client) {
    return;
  }

  try {
    await client.disconnect();
  } catch (error) {
    console.error("Telegram disconnect failed:", error);
  }
}

// ======================================================
// FETCH SCHEDULE
// ======================================================

async function fetchScheduleConfig() {
  const schedule = await schedulerConfigCollection.findOne({
    _id: "main",
  });

  if (!schedule) {
    throw new Error("scheduler_config/main not found");
  }

  validateScheduleConfig(schedule);

  currentScheduleConfig = schedule;

  return schedule;
}

// ======================================================
// FETCH USER
// ======================================================

async function fetchUser(userId) {
  return usersCollection.findOne(buildUserIdFilter(userId));
}

// ======================================================
// FETCH TEMPLATE
// ======================================================

async function fetchTemplate(templateId) {
  return templatesCollection.findOne({
    templateId,
  });
}

// ======================================================
// TIME HELPERS
// ======================================================

function getMinutes(time) {
  if (!isValidTime(time)) {
    throw new Error(`Invalid time: ${time}`);
  }

  const [hours, minutes] = time.split(":").map(Number);

  return hours * 60 + minutes;
}

function getCurrentMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function setTimeOnDate(date, time) {
  const [hours, minutes] = time.split(":").map(Number);

  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);

  return result;
}

// ======================================================
// WINDOW HELPERS
// Supports both normal and overnight windows.
//
// Normal:
// 09:00 -> 17:00
//
// Overnight:
// 23:00 -> 02:00
// ======================================================

function isOvernightWindow(window) {
  return getMinutes(window.end) <= getMinutes(window.start);
}

function isWindowActive(window, now = new Date()) {
  const currentMinutes = getCurrentMinutes(now);
  const start = getMinutes(window.start);
  const end = getMinutes(window.end);

  if (start < end) {
    return currentMinutes >= start && currentMinutes < end;
  }

  // start === end is treated as a full-day window.
  if (start === end) {
    return true;
  }

  // Overnight window.
  return currentMinutes >= start || currentMinutes < end;
}

function getActiveWindows(scheduleConfig, now = new Date()) {
  return scheduleConfig.windows.filter((window) =>
    isWindowActive(window, now)
  );
}

// ======================================================
// GET WINDOW START FOR THE CURRENT/RELEVANT DAY
// ======================================================

function getWindowStartDate(window, reference = new Date()) {
  const now = new Date(reference);
  const start = setTimeOnDate(now, window.start);

  // For an overnight window, times after midnight but before
  // the end belong to the previous day's window.
  if (
    isOvernightWindow(window) &&
    getCurrentMinutes(now) < getMinutes(window.end)
  ) {
    start.setDate(start.getDate() - 1);
  }

  return start;
}

// ======================================================
// GET WINDOW END
// ======================================================

function getWindowEnd(window, reference = new Date()) {
  const now = new Date(reference);
  const end = setTimeOnDate(now, window.end);

  const startMinutes = getMinutes(window.start);
  const endMinutes = getMinutes(window.end);
  const currentMinutes = getCurrentMinutes(now);

  if (startMinutes === endMinutes) {
    end.setDate(end.getDate() + 1);
    return end;
  }

  if (startMinutes > endMinutes) {
    // Overnight window.
    if (currentMinutes >= startMinutes) {
      end.setDate(end.getDate() + 1);
    }
  }

  return end;
}

// ======================================================
// GET NEXT WINDOW START
// ======================================================

function getNextWindowStart(scheduleConfig, reference = new Date()) {
  if (!scheduleConfig.windows.length) {
    throw new Error("No scheduler windows configured");
  }

  const now = new Date(reference);
  const currentMinutes = getCurrentMinutes(now);

  const windows = [...scheduleConfig.windows].sort(
    (a, b) => getMinutes(a.start) - getMinutes(b.start)
  );

  // A currently active window has already started, so its next
  // occurrence is the next occurrence of any window after now.
  for (const window of windows) {
    const startMinutes = getMinutes(window.start);

    if (startMinutes > currentMinutes) {
      return setTimeOnDate(now, window.start);
    }
  }

  // No window starts later today. Use the first window tomorrow.
  const firstWindow = windows[0];

  const next = new Date(now);
  next.setDate(next.getDate() + 1);

  return setTimeOnDate(next, firstWindow.start);
}

// ======================================================
// RANDOM DELAY
//
// Random delay is optional and is applied only when the
// configuration explicitly contains randomDelayMinutes.
//
// IMPORTANT:
// We never regenerate a random value repeatedly while
// calculating the same already-due execution. The value is
// calculated as part of next-run calculation and returned
// with the scheduling result.
// ======================================================

function getRandomDelayMinutes(scheduleConfig) {
  const config = scheduleConfig.randomDelayMinutes;

  if (!config) {
    return 0;
  }

  const min = Math.max(0, Math.floor(config.min));
  const max = Math.max(min, Math.floor(config.max));

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ======================================================
// BASE INTERVAL
// ======================================================

function getIntervalMs(scheduleConfig) {
  return scheduleConfig.intervalMinutes * 60 * 1000;
}

// ======================================================
// GET NEXT ALLOWED RUN FROM LAST RUN
//
// The mandatory interval is always respected.
//
// If randomDelayMinutes is configured, it is added to the
// mandatory interval only when this calculation creates a
// new future execution time.
//
// A stored lastRunAt is never moved backwards.
// ======================================================

function getNextAllowedRun(
  lastRunAt,
  scheduleConfig,
  randomDelayMinutes = 0
) {
  if (!lastRunAt) {
    return new Date();
  }

  const lastRun = new Date(lastRunAt);

  if (Number.isNaN(lastRun.getTime())) {
    throw new Error(`Invalid lastRunAt: ${lastRunAt}`);
  }

  return new Date(
    lastRun.getTime() +
      getIntervalMs(scheduleConfig) +
      randomDelayMinutes * 60 * 1000
  );
}

// ======================================================
// UPDATE LAST RUN
// ======================================================

async function updateLastRunAt(userId) {
  const now = new Date();

  const result = await usersCollection.updateOne(
    buildUserIdFilter(userId),
    {
      $set: {
        lastRunAt: now,
      },
    }
  );

  if (result.matchedCount !== 1) {
    throw new Error(`Unable to update lastRunAt for user ${userId}`);
  }

  return now;
}

// ======================================================
// CHECK WHETHER TELEGRAM CLIENT IS USABLE
// ======================================================

async function ensureTelegramConnection(user, userId) {
  let cached = connections.get(userId);

  if (
    cached &&
    cached.sessionId === user.sessionId &&
    cached.connection
  ) {
    try {
      // GramJS exposes connected state through connected.
      if (cached.connection.connected) {
        return cached;
      }
    } catch {
      // Reinitialize below.
    }
  }

  if (cached?.connection) {
    await disconnectTelegramClient(cached.connection);
  }

  connections.delete(userId);

  if (!user.sessionId) {
    throw new Error(`User ${userId} has no sessionId`);
  }

  const newConnection = await initializeConnection(user);

  connections.set(userId, newConnection);

  return newConnection;
}

// ======================================================
// ACTUAL FUNCTION
// ======================================================

async function myFunction(window, connection, user) {
  // Fetch the template immediately before execution so the
  // latest MongoDB version is used.
  const template = await fetchTemplate(window.templateId);

  if (!template) {
    throw new Error(`Template not found: ${window.templateId}`);
  }

  if (typeof template.message !== "string") {
    throw new Error(
      `Template ${window.templateId} does not contain a valid message`
    );
  }

  console.log(
    `Executing myFunction for ${user.username ?? user._id}`
  );

  // IMPORTANT: await the actual Telegram operation.
  // If it fails, this function throws and lastRunAt is NOT updated.
  await sendTelegramMessage(
    window.groupId,
    window.topicId,
    template.message,
    connection.connection
  );

  console.log(
    `Function completed for ${user.username ?? user._id}`
  );
}

// ======================================================
// EXECUTE ONE WINDOW
// ======================================================

async function executeWindow(window) {
  const userId = window.userId;

  // ALWAYS fetch the latest user.
  const user = await fetchUser(userId);

  if (!user) {
    console.log(`User not found: ${userId}`);

    return {
      status: "SKIPPED",
      reason: "USER_NOT_FOUND",
      userId,
    };
  }

  if (!user.isActive) {
    console.log(`User ${userId} is inactive`);

    return {
      status: "SKIPPED",
      reason: "USER_INACTIVE",
      userId,
    };
  }

  // Ensure we have a live connection based on the latest user data.
  let connection;

  try {
    connection = await ensureTelegramConnection(user, userId);
  } catch (error) {
    console.error(
      `Unable to initialize Telegram connection for ${userId}:`,
      error
    );

    return {
      status: "FAILED",
      reason: "CONNECTION_FAILED",
      userId,
      error,
    };
  }

  const schedule = currentScheduleConfig;

  if (!schedule) {
    throw new Error("Schedule configuration has not been loaded");
  }

  // calculateNextRun() is the central scheduler calculation.
  const calculation = await calculateNextRun({
    schedule,
    windows: [window],
    now: new Date(),
    refreshData: false,
    randomize: false,
  });

  const candidate = calculation.runs[0];

  if (!candidate) {
    return {
      status: "NO_RUN",
      reason: "WINDOW_EXPIRED_OR_NOT_ELIGIBLE",
      userId,
    };
  }

  const now = new Date();

  if (candidate.runAt.getTime() > now.getTime()) {
    const remaining = candidate.runAt.getTime() - now.getTime();

    console.log(`User ${user.username ?? userId} is not due yet.`);
    console.log(
      `Last run: ${
        user.lastRunAt
          ? new Date(user.lastRunAt).toLocaleString()
          : "Never"
      }`
    );
    console.log(
      `Next allowed run: ${candidate.runAt.toLocaleString()}`
    );

    return {
      status: "NOT_DUE",
      nextRunAt: candidate.runAt,
      delay: remaining,
      userId,
    };
  }

  // The exact window can change while we are waiting.
  // Re-check it immediately before sending.
  if (!isWindowActive(window, new Date())) {
    return {
      status: "WINDOW_EXPIRED",
      userId,
    };
  }

  try {
    // Execute first.
    await myFunction(window, connection, user);

    // Update lastRunAt ONLY after successful execution.
    const actualRunTime = await updateLastRunAt(userId);

    console.log(
      `lastRunAt updated for ${user.username ?? userId}: ` +
        `${actualRunTime.toLocaleString()}`
    );

    // Refresh all required data after every successful execution.
    const updatedUser = await fetchUser(userId);
    const updatedTemplate = await fetchTemplate(window.templateId);
    const updatedSchedule = await fetchScheduleConfig();

    return {
      status: "EXECUTED",
      user: updatedUser,
      template: updatedTemplate,
      schedule: updatedSchedule,
      actualRunTime,
    };
  } catch (error) {
    console.error(
      `Execution failed for ${user.username ?? userId}:`,
      error
    );

    // lastRunAt is intentionally NOT updated on failure.
    return {
      status: "FAILED",
      reason: "EXECUTION_FAILED",
      userId,
      error,
    };
  }
}

// ======================================================
// CALCULATE NEXT RUN
//
// THIS IS THE SINGLE SOURCE OF TRUTH FOR SCHEDULING.
//
// Returns:
// {
//   type: "RUN" | "WINDOW",
//   date: Date,
//   runs: [
//     {
//       window,
//       user,
//       runAt,
//       windowEnd
//     }
//   ]
// }
//
// Rules:
// 1. Always uses the latest schedule when refreshData=true.
// 2. Only active users are eligible.
// 3. lastRunAt + interval must be satisfied.
// 4. The candidate must fit inside the active window.
// 5. The earliest eligible candidate wins.
// 6. If no current-window run exists, returns the next window.
// ======================================================

async function calculateNextRun(options = {}) {
  const {
    schedule: suppliedSchedule = null,
    windows: suppliedWindows = null,
    now = new Date(),
    refreshData = true,
    randomize = false,
  } = options;

  let schedule = suppliedSchedule;

  if (refreshData || !schedule) {
    schedule = await fetchScheduleConfig();
  }

  validateScheduleConfig(schedule);

  if (refreshData) {
    await initializeActiveUsers();
  }

  const activeWindows =
    suppliedWindows ??
    getActiveWindows(schedule, now);

  if (activeWindows.length === 0) {
    const nextWindow = getNextWindowStart(schedule, now);

    return {
      type: "WINDOW",
      date: nextWindow,
      runs: [],
    };
  }

  const runs = [];

  for (const window of activeWindows) {
    const user = await fetchUser(window.userId);

    if (!user || !user.isActive) {
      continue;
    }

    // Never allow a candidate outside the actual active window.
    const windowEnd = getWindowEnd(window, now);

    let randomDelayMinutes = 0;

    // For normal scheduler calculation we can add a random delay.
    // executeWindow calls calculateNextRun with randomize=false
    // because a repeated calculation must not move a due run.
    if (randomize && user.lastRunAt) {
      randomDelayMinutes = getRandomDelayMinutes(schedule);
    }

    let candidate = getNextAllowedRun(
      user.lastRunAt,
      schedule,
      randomDelayMinutes
    );

    // First execution is eligible immediately.
    if (!user.lastRunAt) {
      candidate = new Date(now);
    }

    // If the user became due before the window started, the execution
    // must happen at the window start, not before the window.
    const windowStart = getWindowStartDate(window, now);

    if (candidate < windowStart) {
      candidate = new Date(windowStart);
    }

    // If the calculated run is outside the current window, this
    // window cannot execute this cycle.
    if (candidate >= windowEnd) {
      continue;
    }

    runs.push({
      window,
      user,
      runAt: candidate,
      windowEnd,
      randomDelayMinutes,
    });
  }

  if (runs.length === 0) {
    return {
      type: "WINDOW",
      date: getNextWindowStart(schedule, now),
      runs: [],
    };
  }

  runs.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());

  return {
    type: "RUN",
    date: runs[0].runAt,
    runs,
  };
}

// ======================================================
// SCHEDULE NEXT TIMEOUT
// ======================================================

function scheduleNextRun(date) {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }

  const delay = Math.max(0, date.getTime() - Date.now());

  console.log(
    `Next scheduler run: ${date.toLocaleString()} ` +
      `(in ${Math.ceil(delay / 1000)} seconds)`
  );

  timeout = setTimeout(() => {
    void runScheduler();
  }, delay);
}

// ======================================================
// SCHEDULER
// ======================================================

async function runScheduler() {
  if (schedulerRunning) {
    console.log("Scheduler execution already in progress; skipping.");
    return;
  }

  schedulerRunning = true;

  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }

  try {
    while (true) {
      const schedule = await fetchScheduleConfig();

      await initializeActiveUsers();

      const calculation = await calculateNextRun({
        schedule,
        now: new Date(),
        refreshData: false,
        randomize: false,
      });

      // No active-window execution is possible right now.
      if (calculation.type === "WINDOW") {
        console.log(
          `No executable run in the current window. ` +
            `Next window: ${calculation.date.toLocaleString()}`
        );

        scheduleNextRun(calculation.date);
        return;
      }

      const nextRun = calculation.runs[0];

      if (!nextRun) {
        const nextWindow = getNextWindowStart(
          schedule,
          new Date()
        );

        scheduleNextRun(nextWindow);
        return;
      }

      const now = new Date();

      // We are not due yet.
      if (nextRun.runAt.getTime() > now.getTime()) {
        scheduleNextRun(nextRun.runAt);
        return;
      }

      // Candidate is due now. Execute it.
      const result = await executeWindow(nextRun.window);

      // After EVERY successful execution, refresh everything.
      if (result.status === "EXECUTED") {
        await fetchScheduleConfig();
        await initializeActiveUsers();

        // Recalculate from the freshly loaded MongoDB state.
        // This is deliberately done through calculateNextRun().
        continue;
      }

      if (result.status === "NOT_DUE") {
        scheduleNextRun(result.nextRunAt);
        return;
      }

      if (
        result.status === "SKIPPED" ||
        result.status === "NO_RUN" ||
        result.status === "WINDOW_EXPIRED"
      ) {
        // Recalculate using completely fresh state.
        continue;
      }

      if (result.status === "FAILED") {
        // Do not update lastRunAt on failure.
        // Retry through the scheduler after one minute.
        console.error(
          `Execution failed; lastRunAt was not updated. ` +
            `Retrying scheduler in one minute.`
        );

        scheduleNextRun(new Date(Date.now() + 60 * 1000));
        return;
      }
    }
  } catch (error) {
    console.error("Scheduler error:", error);

    // Do not leave the scheduler dead after an unexpected error.
    scheduleNextRun(new Date(Date.now() + 60 * 1000));
  } finally {
    schedulerRunning = false;
  }
}

// ======================================================
// APPLICATION START
// ======================================================

async function start() {
  try {
    console.log("Starting application...");

    await connectMongoDB();

    // Load initial schedule.
    await fetchScheduleConfig();

    // Initialize all active users.
    await initializeActiveUsers();

    // Calculate and start from the exact next eligible execution.
    const calculation = await calculateNextRun({
      refreshData: true,
      randomize: false,
    });

    if (calculation.type === "RUN") {
      scheduleNextRun(calculation.date);
    } else {
      scheduleNextRun(calculation.date);
    }
  } catch (error) {
    console.error("Application startup failed:", error);
    process.exit(1);
  }
}

// ======================================================
// TELEGRAM LOGIN
//
// sessionId must already exist in the user's MongoDB
// document. This function does not generate or replace it.
// ======================================================

export async function loginTelegram(sessionId, appId, appHash) {
  let client = null;

  try {
    if (!sessionId) {
      throw new Error("sessionId is required");
    }

    if (!appId) {
      throw new Error("appId is required");
    }

    if (!appHash) {
      throw new Error("appHash is required");
    }

    const stringSession = new StringSession(sessionId);

    client = new TelegramClient(
      stringSession,
      Number(appId),
      appHash,
      {
        connectionRetries: 5,
      }
    );

    await client.connect();

    const status = await client.isUserAuthorized();

    console.log("Telegram logged in?", status);

    if (!status) {
      console.error(
        "Telegram session is not authorized. " +
          "The sessionId stored in MongoDB must be a valid authorized session."
      );

      await disconnectTelegramClient(client);
      return null;
    }

    return client;
  } catch (error) {
    console.error("Telegram login error:", error);

    if (client) {
      await disconnectTelegramClient(client);
    }

    return null;
  }
}

// ======================================================
// ASSIGN / DISCOVER GROUPS
//
// This keeps the existing discovery behavior. The topics
// result is returned so callers can inspect it if needed.
// ======================================================

export async function assignGroups(client) {
  if (!client) {
    throw new Error("Telegram client is required");
  }

  const dialogs = await client.getDialogs({});
  const groups = [];

  for (const dialog of dialogs) {
    const chat = dialog.entity;

    if (
      chat?.className === "Channel" &&
      chat.megagroup &&
      chat.forum
    ) {
      try {
        const topicsResult = await client.invoke(
          new Api.channels.GetForumTopics({
            channel: chat,
            offsetDate: 0,
            offsetId: 0,
            offsetTopic: 0,
            limit: 100,
          })
        );

        groups.push({
          channel: chat,
          topics: topicsResult,
        });
      } catch (error) {
        console.error(
          `Unable to fetch forum topics for ${chat.title ?? "unknown channel"}:`,
          error
        );
      }
    }
  }

  return groups;
}

// ======================================================
// SEND TELEGRAM MESSAGE
//
// Errors are rethrown so executeWindow() knows the actual
// function failed and does NOT update lastRunAt.
// ======================================================

export async function sendTelegramMessage(
  groupId,
  topicId,
  message,
  client
) {
  if (!client) {
    throw new Error("Telegram client is required");
  }

  if (!groupId) {
    throw new Error("groupId is required");
  }

  if (typeof message !== "string") {
    throw new Error("message must be a string");
  }

  try {
    const options = {
      message,
    };

    // Preserve topic behavior when topicId is configured.
    if (
      topicId !== undefined &&
      topicId !== null &&
      topicId !== ""
    ) {
      const numericTopicId = Number(topicId);

      if (!Number.isFinite(numericTopicId)) {
        throw new Error(`Invalid topicId: ${topicId}`);
      }

      options.replyTo = numericTopicId;
    }

    await client.sendMessage(groupId, options);

    return true;
  } catch (error) {
    console.error(
      `Telegram message failed for group ${groupId}, topic ${topicId}:`,
      error
    );

    throw error;
  }
}

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }

  for (const [userId, connection] of connections.entries()) {
    await disconnectTelegramClient(connection.connection);
    connections.delete(userId);
  }

  try {
    await mongoClient.close();
  } catch (error) {
    console.error("MongoDB shutdown error:", error);
  }

  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// ======================================================
// START
// ======================================================

void start();
