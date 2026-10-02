// telegram-session-generator.txt
// Rename this file to telegram-session-generator.js before running.
//
// Install:
//   npm install telegram
//
// Run:
//   node telegram-session-generator.js
//
// You need your Telegram API ID and API hash from:
//   https://my.telegram.org/apps

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import "dotenv/config";


async function main() {
  const apiId = Number(
    process.env.TELEGRAM_API_ID ||
      (await input.text("Enter Telegram API ID: ")),
  );
  const apiHash =
    process.env.TELEGRAM_API_HASH ||
    (await input.text("Enter Telegram API Hash: "));

  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error("Invalid Telegram API ID.");
  }

  if (!apiHash) {
    throw new Error("Telegram API hash is required.");
  }

  const stringSession = new StringSession("");

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      return await input.text(
        "Enter your Telegram phone number (e.g. +919876543210): ",
      );
    },

    phoneCode: async () => {
      return await input.text("Enter the Telegram OTP: ");
    },

    password: async () => {
      return await input.text("Enter your Telegram 2FA password: ");
    },

    onError: (err) => {
      console.error("Telegram login error:", err.message || err);
    },
  });

  const session = client.session.save();

  console.log("\n========================================");
  console.log("Telegram login successful.");
  console.log("========================================\n");

  console.log("SESSION STRING:");
  console.log(session);

  console.log("\nKeep this session string SECRET.");
  console.log("Anyone who has it may be able to access your Telegram account.");
  console.log("\nSave it as an environment variable, for example:");
  console.log("TELEGRAM_SESSION=" + session);

  await client.disconnect();
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
