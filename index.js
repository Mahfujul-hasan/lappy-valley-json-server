const fs = require("fs");
const path = require("path");
const jsonServer = require("json-server");
const { createStorefrontAudit } = require("./storefront-audit");
const { syncAllRatings, captureRatingTargets, applyRatingSync } = require("./product-ratings");
const { captureStockTargets, applyOrderStock } = require("./order-stock");

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
 * Collections that start empty. json-server 0.17 answers 404 for a collection missing
 * from db.json (even for POST), so create them on start-up.
 *
 * productReviews: one doc per product review, separate from `reviews` (store-wide
 * testimonials). Shape: { id, productId, userId, rating, subject?, comment, createdAt,
 * updatedAt? }. `productId` → products.id and `userId` → users.id are reference keys, so
 * json-server answers `/products/:id/productReviews`, `/users/:id/productReviews` and
 * `?_expand=product`. Never `_expand=user` from a client: it returns the user's
 * passwordHash and salt — copy the display name onto the review instead.
 */
const EMPTY_COLLECTIONS = ["auditLogs", "productReviews"];

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

// Product rating/reviewCount are derived from productReviews (see product-ratings.js).
syncAllRatings(router.db);
router.render = (req, res) => {
  // Orders take/return product stock (see order-stock.js).
  applyOrderStock(req, res, router.db);
  applyRatingSync(req, res, router.db);
  res.jsonp(res.locals.data);
};

const port = process.env.PORT || 4000;

server.use(middlewares);
server.use(jsonServer.bodyParser);
// Customer activity → auditLogs (admin actions are logged by the dashboard itself).
server.use(createStorefrontAudit(router));
server.use(captureRatingTargets(router));
server.use(captureStockTargets(router));
server.use(router);

server.listen(port, "0.0.0.0", () => {
  console.log(`JSON Server running on port ${port}`);
});
