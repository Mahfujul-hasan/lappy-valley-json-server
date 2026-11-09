/**
 * Keeps each product's `rating` (average of its productReviews, 1 decimal, 0 = not rated)
 * and `reviewCount` in sync with the `productReviews` collection. The server owns these
 * two fields: clients never send them, and any write that could change or wipe them
 * (a review POST/PUT/PATCH/DELETE, or a product PUT/PATCH from the dashboard) is followed
 * by a recompute before the response goes out, so a refetch right after sees fresh values.
 */

const sameId = (a, b) => String(a) === String(b);

function computeRating(db, productId) {
  const ratings = (db.get("productReviews").value() || [])
    .filter((review) => sameId(review.productId, productId))
    .map((review) => Number(review.rating) || 0);
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  return {
    rating: ratings.length ? Math.round((total / ratings.length) * 10) / 10 : 0,
    reviewCount: ratings.length,
  };
}

/** Writes the fresh values onto the product; returns the updated product (or undefined). */
function syncProductRating(db, productId) {
  if (productId === undefined || productId === null) return undefined;
  const product = db.get("products").find((doc) => sameId(doc.id, productId));
  if (!product.value()) return undefined;
  return product.assign(computeRating(db, productId)).write();
}

/** Start-up pass: fixes products whose stored values drifted from their reviews. */
function syncAllRatings(db) {
  let changed = 0;
  for (const product of db.get("products").value() || []) {
    const next = computeRating(db, product.id);
    if (product.rating !== next.rating || product.reviewCount !== next.reviewCount) {
      syncProductRating(db, product.id);
      changed += 1;
    }
  }
  if (changed) console.log(`Synced ratings for ${changed} product(s)`);
}

const WRITES = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Middleware in front of the router: remembers which product a review belonged to before
 * the write (needed for DELETE, and for a PATCH that moves a review to another product).
 */
function captureRatingTargets(router) {
  return (req, _res, next) => {
    if (!WRITES.includes(req.method)) return next();
    const [, collection, id] = req.path.split("/");
    if (collection === "productReviews" && id) {
      const review = (router.db.get("productReviews").value() || []).find((doc) =>
        sameId(doc.id, id),
      );
      req.ratingProductIds = review ? [review.productId] : [];
    }
    next();
  };
}

/** Call from `router.render`, before the response is sent. */
function applyRatingSync(req, res, db) {
  if (!WRITES.includes(req.method) || res.statusCode >= 400) return;
  const [, collection, id] = req.path.split("/");
  const data = res.locals.data;

  if (collection === "productReviews") {
    const ids = new Set((req.ratingProductIds || []).map(String));
    if (data && data.productId !== undefined) ids.add(String(data.productId));
    ids.forEach((productId) => syncProductRating(db, productId));
    return;
  }

  // A product PUT replaces the whole record (the dashboard form doesn't send rating
  // fields), so restore them and return the corrected product.
  if (collection === "products" && id && (req.method === "PUT" || req.method === "PATCH")) {
    const product = syncProductRating(db, id);
    if (product) res.locals.data = product;
  }
}

module.exports = { syncAllRatings, captureRatingTargets, applyRatingSync };
