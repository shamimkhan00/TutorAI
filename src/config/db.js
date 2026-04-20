const dns = require("dns");
const { MongoClient } = require("mongodb");

const { MONGO_URI, MONGO_DNS_SERVERS } = require("./env");

let client;
let database;

async function connectDB() {
  if (database) {
    return database;
  }

  if (!MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  if (MONGO_URI.startsWith("mongodb+srv://") && MONGO_DNS_SERVERS.length > 0) {
    dns.setServers(MONGO_DNS_SERVERS);
  }

  client = new MongoClient(MONGO_URI);
  await client.connect();
  database = client.db();

  console.log("MongoDB connected");

  return database;
}

function getDB() {
  if (!database) {
    throw new Error("Database connection has not been initialized");
  }

  return database;
}

async function closeDB() {
  if (client) {
    await client.close();
  }

  client = null;
  database = null;
}

module.exports = {
  connectDB,
  getDB,
  closeDB,
};
