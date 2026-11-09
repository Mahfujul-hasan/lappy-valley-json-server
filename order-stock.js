/**
 * Keeps product stock in step with orders, so the admin never has to record website sales.
 *
 * Rule: an order "holds" stock unless it is Cancelled.
 *   - Order placed (POST /orders)          → tracked products lose the ordered units.
 *   - Status → Cancelled                   → the units go back.
 *   - Cancelled → any other status         → the units are taken again.
 *   - Order deleted while holding stock    → the units go back.
 *
 * What an order took is stored on it as `stockHeld: [{ productId, quantity }]` (server-owned):
 *   array     = holding these units (quantity can be lower than ordered if stock ran out)
 *   null      = released (cancelled)
 *   undefined = placed before this feature existed → never touched.
 *
 * Only products with a numeric `stock` are tracked; others are skipped. Stock never goes
 * below 0. Every change appends to the product's `stockHistory` (same shape the dashboard
 * writes, capped like the dashboard's STOCK_HISTORY_LIMIT).
 *
 * Also: a product PUT (the dashboard's edit form replaces the whole record) keeps the
 * stored stock fields, so a form opened before an order came in can't undo the deduction.
 */

const STOCK_HISTORY_LIMIT = 20;
const INVENTORY_FIELDS = ["stock", "lowStockThreshold", "sku", "stockHistory"];

const sameId = (a, b) => String(a) === String(b);
const orderNumber = (order) => `#LV-${order.id}`;
const holds = (order) => order.status !== "Cancelled";

function findProduct(db, id) {
  return db.get("products").find((doc) => sameId(doc.id, id));
}

/** Adds `change` units (negative = take) to a tracked product. Returns the units actually moved. */
function moveStock(db, productId, change, entry) {
  const product = findProduct(db, productId);
  const current = product.value();
  if (!current || typeof current.stock !== "number" || change === 0) return 0;
  const stock = Math.max(0, current.stock + change);
  const moved = stock - current.stock;
  if (moved === 0) return 0;
  const history = Array.isArray(current.stockHistory) ? current.stockHistory : [];
  product
    .assign({
      stock,
      stockHistory: [
        ...history,
        { change: moved, stock, at: new Date().toISOString(), ...entry },
      ].slice(-STOCK_HISTORY_LIMIT),
    })
    .write();
  return moved;
}

/** Takes the order's units; returns what was taken per product. */
function take(db, order, note, by) {
  const wanted = new Map();
  for (const line of order.items || []) {
    const qty = Math.max(0, Math.floor(Number(line.quantity) || 0));
    wanted.set(String(line.productId), (wanted.get(String(line.productId)) || 0) + qty);
  }
  const held = [];
  for (const [productId, quantity] of wanted) {
    const moved = moveStock(db, productId, -quantity, { reason: "order", note, by });
    if (moved < 0) held.push({ productId: Number(productId), quantity: -moved });
  }
  return held;
}

function release(db, held, note) {
  for (const { productId, quantity } of held || []) {
    moveStock(db, productId, quantity, { reason: "cancelled", note });
  }
}

function saveHeld(db, order, stockHeld) {
  return db
    .get("orders")
    .find((doc) => sameId(doc.id, order.id))
    .assign({ stockHeld })
    .write();
}

/** Middleware in front of the router: remembers state the write would lose. */
function captureStockTargets(router) {
  return (req, _res, next) => {
    const [, collection, id] = req.path.split("/");
    if (!id || !["PUT", "DELETE"].includes(req.method)) return next();
    const db = router.db;

    if (collection === "orders") {
      const before = (db.get("orders").value() || []).find((doc) => sameId(doc.id, id));
      if (req.method === "DELETE") req.orderStockBefore = before;
      // A PUT replaces the record; keep what it holds.
      else if (before && req.body && !("stockHeld" in req.body) && "stockHeld" in before) {
        req.body.stockHeld = before.stockHeld;
      }
    }

    if (collection === "products" && req.method === "PUT" && req.body) {
      const stored = findProduct(db, id).value();
      if (stored) {
        for (const field of INVENTORY_FIELDS) {
          if (stored[field] !== undefined) req.body[field] = stored[field];
        }
      }
    }
    next();
  };
}

/** Call from `router.render`, before the response is sent. */
function applyOrderStock(req, res, db) {
  if (res.statusCode >= 400) return;
  const [, collection, id] = req.path.split("/");
  if (collection !== "orders") return;
  const order = res.locals.data;

  if (req.method === "POST" && order && order.id !== undefined) {
    const stockHeld = holds(order) ? take(db, order, `Order ${orderNumber(order)}`, "Website") : null;
    res.locals.data = saveHeld(db, order, stockHeld);
    return;
  }

  if (req.method === "DELETE") {
    const before = req.orderStockBefore;
    if (before && Array.isArray(before.stockHeld)) {
      release(db, before.stockHeld, `Order ${orderNumber(before)} deleted`);
    }
    return;
  }

  if (!id || !["PUT", "PATCH"].includes(req.method) || !order) return;
  if (order.stockHeld === undefined) return; // placed before stock syncing

  if (Array.isArray(order.stockHeld) && !holds(order)) {
    release(db, order.stockHeld, `Order ${orderNumber(order)} cancelled`);
    res.locals.data = saveHeld(db, order, null);
  } else if (order.stockHeld === null && holds(order)) {
    const stockHeld = take(db, order, `Order ${orderNumber(order)} reopened`);
    res.locals.data = saveHeld(db, order, stockHeld);
  }
}

module.exports = { captureStockTargets, applyOrderStock };
