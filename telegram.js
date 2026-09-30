import bigInt from "big-integer";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { CONSTANTS } from "./constants.js";

const apiId = CONSTANTS.TELEGRAM_APP_ID;
const apiHash = CONSTANTS.TELEGRAM_APP_HASH;
const stringSession = new StringSession(CONSTANTS.TELEGRAM_SESSION_ID); // or empty to login again
export let client;

export async function loginTelegram() {
  try {
    client = new TelegramClient(stringSession, Number(apiId), apiHash, {
      connectionRetries: 5,
    });
    await client.connect();

    let status = await client.isUserAuthorized();

    console.log("logged in? ", status);

    if (!client.isUserAuthorized) {
      console.log("Not logged in !");
      process.exit(0);
    }
  } catch (error) {
    console.log(error);
  }
}

export async function assignGroups() {
  try {
    const dialogs = await client.getDialogs({});
    for (const dialog of dialogs) {
      const chat = dialog.entity;

      if (chat.className === "Channel" && chat.megagroup && chat.forum) {
        const topicsResult = await client.invoke(
          new Api.channels.GetForumTopics({
            channel: chat,
            offsetDate: 0,
            offsetId: 0,
            offsetTopic: 0,
            limit: 100,
          }),
        );
      }
    }
  } catch (error) {
    console.log(error);
  }
}

export async function sendTelegramMessage(groupId, topicId, message) {
  try {
    // todo: check if client is alive

    console.log({
      name: "Dawson",
      chatId: bigInt(groupId),
      id: Number(topicId),
    });

    await client.sendMessage(groupId, {
      message,
      replyTo: Number(topicId),
    });
  } catch (error) {
    console.log(error);
  }
}
