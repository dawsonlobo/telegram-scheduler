import dotenv from "dotenv";
dotenv.config();
import constants from "./constants.json" with { type: "json" };
export const CONSTANTS = {
  TELEGRAM_APP_ID: addEnv("TELEGRAM_APP_ID"),
  TELEGRAM_APP_HASH: addEnv("TELEGRAM_APP_HASH"),
  TELEGRAM_SESSION_ID: addEnv("TELEGRAM_SESSION_ID"),
  TELEGRAM_GROUP_ID: addEnv("TELEGRAM_GROUP_ID"),
  TELEGRAM_TOPIC_ID: addEnv("TELEGRAM_TOPIC_ID"),
  MESSAGE: addEnv("MESSAGE"),
};

//todo: make constant json for non sensitive constants

function addEnv(name) {
  try {
    if (name in constants) {
      return JSON.parse(JSON.stringify(constants))?.[name];
    } else if (process?.env?.[name]) {
      return process?.env?.[name];
    } else {
      throw Error(`${name} variable not found.`);
    }
  } catch (error) {
    const err = new Error(`Unable to fetch ${name} variable.`);

    err.cause = error;
    throw err;
  }
}
