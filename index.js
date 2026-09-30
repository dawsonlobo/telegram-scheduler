import { CONSTANTS } from "./constants.js";
import {
  assignGroups,
  loginTelegram,
  sendTelegramMessage,
} from "./telegram.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(__filename);

const LAST_RUN_FILE = path.join(dirname, "lastrun.txt");
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const START_HOUR = 8; // 8 AM IST
const END_HOUR = 23; // 10 PM IST

/**
 * Updates (or creates) lastrun.txt with the current epoch time in milliseconds.
 */
function updateLastRun() {
  const currentEpoch = Date.now();

  fs.writeFileSync(LAST_RUN_FILE, String(currentEpoch), "utf8");

  return currentEpoch;
}

/**
 * Checks the last run time.
 *
 * Returns:
 * - false if lastrun.txt does not exist
 * - false if the last run was more than 1 hour ago
 * - difference in milliseconds if the last run was within 1 hour
 */
function checkLastRun() {
  if (!fs.existsSync(LAST_RUN_FILE)) {
    return false;
  }

  const lastRun = Number(fs.readFileSync(LAST_RUN_FILE, "utf8").trim());

  if (!Number.isFinite(lastRun)) {
    return false;
  }

  const difference = Date.now() - lastRun;

  if (difference > 60 * 60 * 1000) {
    return false;
  }

  return difference;
}

/**
 * Get current IST date/time.
 */
function getISTDate() {
  const now = new Date();

  return new Date(now.getTime() + IST_OFFSET_MS);
}

/**
 * Returns a NEW random number every time this function is called.
 * Random number between 10 and 15 inclusive.
 */
function getRandomMinutes() {
  return Math.floor(1 + Math.random() * 5);
}

/**
 * Check whether current IST time is between
 * 8:00 AM and 10:00 PM.
 */
function isWithinAllowedTime() {
  const istNow = getISTDate();

  const hours = istNow.getUTCHours();

  return hours >= START_HOUR && hours < END_HOUR;
}

/**
 * Your actual function.
 */
async function myFunction() {
  console.log("Hello!");
  console.log("Executed UTC:", new Date().toISOString());
  const message = CONSTANTS.MESSAGE.replace(/\\n/g, "\n");
  await sendTelegramMessage(
    CONSTANTS.TELEGRAM_GROUP_ID,
    CONSTANTS.TELEGRAM_TOPIC_ID,
    message,
  );
  updateLastRun();
  console.log("Executed IST:", getISTDate().toUTCString());
}

/**
 * Schedule at 8 AM IST + NEW random 10-15 minutes.
 *
 * If current time is before 8 AM:
 * → Schedule TODAY
 *
 * If current time is after allowed hours:
 * → Schedule TOMORROW
 */
function scheduleAt8AM() {
  // Generate NEW random value every time this is scheduled
  const randomMinutes = getRandomMinutes();

  const now = new Date();
  const istNow = getISTDate();

  const currentHour = istNow.getUTCHours();

  // Determine whether to schedule today or tomorrow
  let daysToAdd = 0;

  // If 8 AM or later, schedule next day
  if (currentHour >= START_HOUR) {
    daysToAdd = 1;
  }

  // Target IST time
  const targetIST = new Date(
    Date.UTC(
      istNow.getUTCFullYear(),
      istNow.getUTCMonth(),
      istNow.getUTCDate() + daysToAdd,
      8, // 8 AM
      randomMinutes, // Random 10-15 minutes
      0,
    ),
  );

  // Convert IST target back to UTC
  const targetUTC = new Date(targetIST.getTime() - IST_OFFSET_MS);

  const delay = targetUTC.getTime() - now.getTime();

  console.log("\nOutside allowed time.");
  console.log(`Scheduling at 8:${randomMinutes} AM IST`);
  console.log(`Scheduled UTC: ${targetUTC.toISOString()}`);

  setTimeout(runJob, delay);
}

/**
 * Schedule next execution after:
 * 1 hour + NEW random 10-15 minutes.
 */
function scheduleNextRun(delayTime = 0) {
  // Generate NEW random value EVERY scheduling cycle
  const randomMinutes = getRandomMinutes();

  const delay = 60 * 60 * 1000 + randomMinutes * 60 * 1000;

  console.log(`\nNext run scheduled after 1 hour + ${randomMinutes} minutes`);

  setTimeout(runJob, delayTime > 0 ? delayTime : delay);
}

/**
 * Main job runner.
 */
async function runJob(delayTime = 0) {
  console.log("\n=================================");
  console.log("Scheduler triggered");

  const istNow = getISTDate();

  console.log(
    `Current IST: ${istNow.getUTCHours()}:${String(
      istNow.getUTCMinutes(),
    ).padStart(2, "0")}`,
  );

  /**
   * FIRST TIME CHECK
   */
  if (!isWithinAllowedTime()) {
    console.log("Current time is outside allowed range.");

    scheduleAt8AM();

    return;
  }

  /**
   * RUN YOUR FUNCTION
   */

  if (delayTime === 0) {
    myFunction();
  }

  /**
   * SECOND TIME CHECK
   * Check again after function execution.
   */
  if (isWithinAllowedTime()) {
    scheduleNextRun(delayTime);
  } else {
    scheduleAt8AM();
  }
}

/**
 * Start application.
 */
console.log("Starting scheduler...");
(async () => {
  // login
  await loginTelegram();
  await assignGroups();
  const lastRun = checkLastRun();
  runJob(lastRun === false ? 0 : lastRun);
})();
