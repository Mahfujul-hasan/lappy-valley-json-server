const fs = require("fs");
const path = require("path");
const jsonServer = require("json-server");
const { createStorefrontAudit } = require("./storefront-audit");

// DB_FILE env lets you run against a copy (e.g. to try changes without touching db.json).
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "db.json");
const CONTENT_SEED_FILE = path.join(__dirname, "content.seed.json");

/**
 * Adds storefront content documents (edited in the admin dashboard) that db.json
 * doesn't have yet. Existing documents are never overwritten. Runs before the router
 * loads db.json, because json-server only reads the file once at start-up.
 */
function seedMissingContent() {
  if (!fs.existsSync(CONTENT_SEED_FILE)) return;
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const db = JSON.parse(raw);
  const seed = JSON.parse(fs.readFileSync(CONTENT_SEED_FILE, "utf8"));
  const existing = Array.isArray(db.content) ? db.content : [];
  const have = new Set(existing.map((doc) => doc.id));
  const missing = seed.filter((doc) => !have.has(doc.id));
  if (!missing.length) return;
  db.content = [...existing, ...missing];
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + "\n");
  console.log(`Seeded content: ${missing.map((doc) => doc.id).join(", ")}`);
}

/**
 * Dashboard-owned collections that start empty. json-server 0.17 answers 404 for a
 * collection missing from db.json (even for POST), so create them on start-up.
 */
const EMPTY_COLLECTIONS = ["auditLogs"];

function ensureCollections() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const missing = EMPTY_COLLECTIONS.filter((name) => !Array.isArray(db[name]));
  if (!missing.length) return;
  for (const name of missing) db[name] = [];
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + "\n");
  console.log(`Created collections: ${missing.join(", ")}`);
}

seedMissingContent();
ensureCollections();

const server = jsonServer.create();
const router = jsonServer.router(DB_FILE);
const middlewares = jsonServer.defaults();

const port = process.env.PORT || 4000;

server.use(middlewares);
server.use(jsonServer.bodyParser);
// Customer activity → auditLogs (admin actions are logged by the dashboard itself).
server.use(createStorefrontAudit(router));
server.use(router);

server.listen(port, "0.0.0.0", () => {
  console.log(`JSON Server running on port ${port}`);
});
