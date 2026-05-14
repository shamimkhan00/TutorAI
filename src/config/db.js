const dns = require("dns");
const { MongoClient } = require("mongodb");

const { MONGO_URI, MONGO_DB_NAME, MONGO_DNS_SERVERS } = require("./env");

let client;
let database;

async function connectDB() {
  if (database) {
    return database;
  }

  if (!MONGO_URI) {
    throw new Error("MONGODB_URI or MONGO_URI is not configured");
  }

  if (MONGO_URI.startsWith("mongodb+srv://") && MONGO_DNS_SERVERS.length > 0) {
    dns.setServers(MONGO_DNS_SERVERS);
  }

  client = new MongoClient(MONGO_URI);
  await client.connect();
  database = client.db(MONGO_DB_NAME);

  console.log(`MongoDB connected to ${MONGO_DB_NAME}`);

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
