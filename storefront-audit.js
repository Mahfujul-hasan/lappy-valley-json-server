/**
 * Records storefront (customer) activity in the `auditLogs` collection, next to the admin
 * entries the dashboard writes itself. Runs as Express middleware in front of the
 * json-server router: it notes the record before a write, then — once the write
 * succeeded — turns the request into one readable entry.
 *
 * Privacy: entries never contain password hashes, salts, reset tokens or one-time codes.
 * Requests sent by the dashboard (header `X-Client: dashboard`) are skipped.
 */

const AUDIT = "auditLogs";

const money = (value) => `৳${Number(value || 0).toLocaleString("en-US")}`;
const show = (value) =>
  value === undefined || value === null || value === "" ? "—" : String(value);
const fullName = (person) =>
  [person && person.firstName, person && person.lastName].filter(Boolean).join(" ");

const findById = (db, collection, id) =>
  (db.get(collection).value() || []).find((doc) => String(doc.id) === String(id));

const customerActor = (user, fallback = {}) => ({
  id: user ? `customer:${user.id}` : "customer:guest",
  name: fullName(user) || fullName(fallback) || (user && user.email) || fallback.email || "Guest",
  email: (user && user.email) || fallback.email || "",
});

const customerEntity = (user) => ({
  type: "customer",
  id: user.id,
  label: fullName(user) || user.email,
});

/** Profile fields a customer can edit, for before → after. */
const PROFILE_FIELDS = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["phone", "Phone"],
];

const formatAddress = (address) =>
  address ? [address.line, address.city, address.postCode].filter(Boolean).join(", ") : "—";

/**
 * One describer per storefront collection. Each gets the request context and returns an
 * entry (without id/at/source) or null to skip.
 */
const DESCRIBERS = {
  orders({ method, after, db }) {
    if (method !== "POST" || !after) return null;
    const user = after.userId ? findById(db, "users", after.userId) : null;
    const items = (after.items || []).reduce((sum, line) => sum + (line.quantity || 0), 0);
    const number = `#LV-${after.id}`;
    return {
      actor: customerActor(user, after.customer || {}),
      action: "created",
      entity: { type: "order", id: after.id, label: number },
      summary: `Placed order ${number} · ${money(after.totals && after.totals.total)}`,
      changes: [
        { field: "Items", from: "—", to: `${items} pcs` },
        { field: "Total", from: "—", to: money(after.totals && after.totals.total) },
        { field: "Payment", from: "—", to: show(after.payment) },
        { field: "Delivery", from: "—", to: show(after.delivery && after.delivery.method) },
        ...(after.totals && after.totals.couponCode
          ? [{ field: "Coupon", from: "—", to: after.totals.couponCode }]
          : []),
      ],
    };
  },

  users({ method, before, after, body }) {
    if (!after) return null;
    if (method === "POST") {
      return {
        actor: customerActor(after),
        action: "created",
        entity: customerEntity(after),
        summary: `Signed up as ${after.email}`,
      };
    }
    const actor = customerActor(after);
    const entity = customerEntity(after);
    if (body.verified === true && !(before && before.verified)) {
      return { actor, action: "updated", entity, summary: "Verified their email address" };
    }
    if (body.passwordHash) {
      // An unverified address being claimed again sets a password before verification.
      const summary =
        before && !before.verified ? "Set a password (sign-up not verified yet)" : "Changed their password";
      return { actor, action: "updated", entity, summary };
    }
    const changes = PROFILE_FIELDS.map(([key, label]) => ({
      field: label,
      from: show(before && before[key]),
      to: show(after[key]),
    }));
    if ("address" in body) {
      changes.push({
        field: "Address",
        from: formatAddress(before && before.address),
        to: formatAddress(after.address),
      });
    }
    const changed = changes.filter((change) => change.from !== change.to);
    if (!changed.length) return null;
    return { actor, action: "updated", entity, summary: "Updated their profile", changes: changed };
  },

  reviews({ method, after }) {
    if (method !== "POST" || !after) return null;
    const stars = "★".repeat(after.rating || 0);
    return {
      actor: { id: "customer:reviewer", name: after.name || "Anonymous", email: "" },
      action: "created",
      entity: { type: "review", id: after.id, label: after.subject || `Review #${after.id}` },
      summary: `Posted a ${after.rating}-star review${after.subject ? `: “${after.subject}”` : ""}`,
      changes: [{ field: "Rating", from: "—", to: `${stars} (${after.rating}/5)` }],
    };
  },

  passwordResets({ method, after, db }) {
    if (method !== "POST" || !after) return null;
    const user = findById(db, "users", after.userId);
    if (!user) return null;
    return {
      actor: customerActor(user),
      action: "created",
      entity: customerEntity(user),
      summary: "Requested a password reset link",
    };
  },

  otpCodes({ method, before, body, db }) {
    // Only failed attempts are worth an entry (success shows up as "Verified …").
    if (method !== "PATCH" || body.attempts === undefined || !before) return null;
    const user = findById(db, "users", before.userId);
    if (!user) return null;
    return {
      actor: customerActor(user),
      action: "updated",
      entity: customerEntity(user),
      summary: `Entered a wrong verification code (attempt ${body.attempts})`,
    };
  },

  contactMessages({ method, after }) {
    if (method !== "POST" || !after) return null;
    return {
      actor: { id: "customer:contact", name: after.name || "Visitor", email: after.email || "" },
      action: "created",
      entity: { type: "message", id: after.id, label: after.subject || `Message #${after.id}` },
      summary: "Sent a contact message",
    };
  },
};

function appendEntry(db, entry) {
  const list = db.get(AUDIT);
  if (!Array.isArray(list.value())) return;
  const ids = list.value().map((doc) => Number(doc.id)).filter(Number.isFinite);
  const id = (ids.length ? Math.max(...ids) : 0) + 1;
  list.push({ id, at: new Date().toISOString(), source: "storefront", ...entry }).write();
}

function createStorefrontAudit(router) {
  return (req, res, next) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
    if (req.get("X-Client") === "dashboard") return next();
    const [, collection, id] = req.path.split("/");
    const describe = DESCRIBERS[collection];
    if (!describe) return next();

    const db = router.db;
    const found = id ? findById(db, collection, id) : undefined;
    const before = found ? JSON.parse(JSON.stringify(found)) : undefined;

    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      try {
        const entry = describe({
          method: req.method,
          before,
          after: res.locals.data,
          body: req.body || {},
          db,
        });
        if (entry) appendEntry(db, entry);
      } catch (error) {
        console.warn("Storefront audit failed:", error.message);
      }
    });
    next();
  };
}

module.exports = { createStorefrontAudit };
