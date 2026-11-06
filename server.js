
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");

const app = express();
const PORT = process.env.PORT || 3000;
const scrypt = promisify(crypto.scrypt);

const required = [
  "DATABASE_URL",
  "ADMIN_SETUP_TOKEN",
  "PAYSTACK_SECRET_KEY"
];

for (const key of required) {
  if (!process.env[key]) {
    console.error("Missing environment variable:", key);
    process.exit(1);
  }
}

const PRICES = {
  "TikTok Likes": 25,
  "Comments": 35,
  "Followers": 45,
  "Video Views": 10,
  "Shares": 35,
  "LIVE Promotion": 55
};

const SERVICES = Object.keys(PRICES);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function calculatePrice(service, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) {
    throw new Error("Quantity must be between 1 and 1,000,000.");
  }

  if (!Object.prototype.hasOwnProperty.call(PRICES, service)) {
    throw new Error("Please select a valid service.");
  }

  return Math.round(PRICES[service] * quantity / 1000 * 100) / 100;
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/[\s()-]/g, "");

  if (/^0\d{9}$/.test(phone)) {
    phone = "+233" + phone.slice(1);
  } else if (/^233\d{9}$/.test(phone)) {
    phone = "+" + phone;
  }

  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error("Enter a valid phone number, including country code.");
  }

  return phone;
}

function makeOrderCode() {
  return "TG-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function validTikTokLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      [
        "tiktok.com",
        "www.tiktok.com",
        "m.tiktok.com",
        "vm.tiktok.com",
        "vt.tiktok.com"
      ].includes(url.hostname);
  } catch {
    return false;
  }
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index < 0) continue;

    if (cookie.slice(0, index).trim() === name) {
      return decodeURIComponent(cookie.slice(index + 1).trim());
    }
  }

  return null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    "tg_session=" + encodeURIComponent(token) +
    "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000"
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "tg_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
  );
}

async function createCustomerSession(userId, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  await pool.query(
    `INSERT INTO customer_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [tokenHash, userId]
  );

  setSessionCookie(res, token);
}

async function getCustomer(req) {
  const token = getCookie(req, "tg_session");
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const result = await pool.query(
    `SELECT u.id, u.phone
     FROM customer_sessions s
     JOIN customer_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function adminOnly(req, res, next) {
  const token = req.headers["x-admin-token"];

  if (!token || token !== process.env.ADMIN_SETUP_TOKEN) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }

  next();
}

// DATABASE SETUP
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL DEFAULT 'Customer',
      contact TEXT NOT NULL,
      service TEXT NOT NULL,
      tiktok_link TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS price_ghs NUMERIC(12,2) DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_reference TEXT
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1000
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_users (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_sessions (
      id SERIAL PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS user_id INTEGER
    REFERENCES customer_users(id) ON DELETE SET NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_reference_unique
    ON orders(payment_reference)
    WHERE payment_reference IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id)
  `);

  await pool.query(`
    DELETE FROM customer_sessions WHERE expires_at < NOW()
  `);

  console.log("TIKGROW database ready.");
}

// CUSTOMER REGISTRATION
app.post("/api/auth/register", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: "Password must be at least 8 characters."
      });
    }

    const existing = await pool.query(
      "SELECT id FROM customer_users WHERE phone = $1",
      [phone]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "An account already exists. Please log in."
      });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await scrypt(password, salt, 64);

    const saved = await pool.query(
      `INSERT INTO customer_users (phone, password_hash, password_salt)
       VALUES ($1, $2, $3)
       RETURNING id, phone`,
      [phone, hash.toString("hex"), salt]
    );

    const user = saved.rows[0];
    await createCustomerSession(user.id, res);

    res.status(201).json({
      success: true,
      message: "Your TIKGROW account has been created.",
      user
    });
  } catch (error) {
    console.error("Registration error:", error.message);
    res.status(400).json({ error: error.message || "Registration failed." });
  }
});

// CUSTOMER LOGIN
app.post("/api/auth/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (!password || password.length > 128) {
      return res.status(401).json({ error: "Invalid phone number or password." });
    }

    const result = await pool.query(
      `SELECT id, phone, password_hash, password_salt
       FROM customer_users WHERE phone = $1`,
      [phone]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Invalid phone number or password." });
    }

    const user = result.rows[0];
    const hash = await scrypt(password, user.password_salt, 64);
    const expected = Buffer.from(user.password_hash, "hex");

    if (
      hash.length !== expected.length ||
      !crypto.timingSafeEqual(hash, expected)
    ) {
      return res.status(401).json({ error: "Invalid phone number or password." });
    }

    await createCustomerSession(user.id, res);

    res.json({
      success: true,
      message: "Login successful.",
      user: { id: user.id, phone: user.phone }
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(400).json({ error: error.message || "Login failed." });
  }
});

// CURRENT CUSTOMER
app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await getCustomer(req);

    if (!user) {
      return res.json({ authenticated: false });
    }

    res.json({ authenticated: true, user });
  } catch (error) {
    res.status(500).json({ error: "Could not check account." });
  }
});

// CUSTOMER LOGOUT
app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = getCookie(req, "tg_session");

    if (token) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      await pool.query(
        "DELETE FROM customer_sessions WHERE token_hash = $1",
        [tokenHash]
      );
    }

    clearSessionCookie(res);
    res.json({ success: true, message: "You have logged out." });
  } catch (error) {
    res.status(500).json({ error: "Could not log out." });
  }
});

// CUSTOMER ORDER HISTORY
app.get("/api/customer/orders", async (req, res) => {
  try {
    const user = await getCustomer(req);

    if (!user) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const result = await pool.query(
      `SELECT order_code, service, quantity, price_ghs,
              status, paid_at, created_at
       FROM orders
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [user.id]
    );

    res.json(result.rows.map(order => ({
      ...order,
      payment_status: order.paid_at ? "Paid" : "Not paid"
    })));
  } catch (error) {
    console.error("History error:", error.message);
    res.status(500).json({ error: "Could not load order history." });
  }
});

// PAYSTACK VERIFICATION
async function verifyPaystack(reference) {
  const response = await fetch(
    "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
    {
      headers: {
        Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.status || !data.data) {
    throw new Error("Could not verify Paystack transaction.");
  }

  return data.data;
}

async function confirmPayment(reference) {
  const payment = await verifyPaystack(reference);

  if (payment.status !== "success" || payment.currency !== "GHS") {
    throw new Error("Payment has not been confirmed.");
  }

  const result = await pool.query(
    "SELECT * FROM orders WHERE payment_reference = $1",
    [reference]
  );

  if (!result.rows.length) {
    throw new Error("Payment order was not found.");
  }

  const order = result.rows[0];
  const expectedAmount = Math.round(Number(order.price_ghs) * 100);

  if (Number(payment.amount) !== expectedAmount) {
    throw new Error("Payment amount does not match the order.");
  }

  await pool.query(
    `UPDATE orders
     SET status = 'Paid', paid_at = COALESCE(paid_at, NOW())
     WHERE payment_reference = $1`,
    [reference]
  );

  return order.order_code;
}

// PAYSTACK WEBHOOK
app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const rawBody = req.rawBody;

    if (!signature || !rawBody || !/^[0-9a-f]{128}$/i.test(signature)) {
      return res.sendStatus(401);
    }

    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest();

    const received = Buffer.from(signature, "hex");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return res.sendStatus(401);
    }

    const event = req.body;

    if (event.event === "charge.success" && event.data?.reference) {
      await confirmPayment(event.data.reference);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Paystack webhook error:", error.message);
    return res.sendStatus(400);
  }
});

// CREATE CUSTOMER ORDER
app.post("/api/orders", async (req, res) => {
  try {
    const contact = String(req.body.contact || "").trim();
    const link = String(req.body.link || "").trim();
    const service = String(req.body.service || "");
    const quantity = Number(req.body.quantity);

    if (!contact || contact.length < 7 || contact.length > 20) {
      return res.status(400).json({ error: "Enter a valid phone number." });
    }

    if (!validTikTokLink(link)) {
      return res.status(400).json({ error: "Enter a valid TikTok link." });
    }

    if (!SERVICES.includes(service)) {
      return res.status(400).json({ error: "Select a valid campaign service." });
    }

    const price = calculatePrice(service, quantity);
    const orderCode = makeOrderCode();
    const user = await getCustomer(req);

    const saved = await pool.query(
      `INSERT INTO orders
       (order_code, customer_name, contact, service,
        tiktok_link, details, quantity, price_ghs, user_id)
       VALUES ($1, 'Customer', $2, $3, $4, $5, $6, $7, $8)
       RETURNING order_code, service, quantity,
                 price_ghs, status, created_at`,
      [
        orderCode, contact, service, link,
        "Campaign request", quantity, price, user?.id || null
      ]
    );

    res.status(201).json(saved.rows[0]);
  } catch (error) {
    console.error("Order error:", error.message);
    res.status(400).json({ error: error.message || "Could not save order." });
  }
});

// CUSTOMER ORDER TRACKING
app.get("/api/orders/:code", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_code, service, quantity, price_ghs,
              status, paid_at, created_at
       FROM orders WHERE order_code = $1`,
      [req.params.code]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Order not found." });
    }

    const order = result.rows[0];

    res.json({
      ...order,
      payment_status: order.paid_at ? "Paid" : "Not paid"
    });
  } catch (error) {
    console.error("Tracking error:", error.message);
    res.status(500).json({ error: "Could not check order." });
  }
});

// INITIALIZE PAYSTACK CHECKOUT
app.post("/api/orders/:code/pay", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE order_code = $1",
      [req.params.code]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Order not found." });
    }

    const order = result.rows[0];

    if (order.paid_at) {
      return res.status(400).json({ error: "This order has already been paid." });
    }

    if (Number(order.price_ghs) < 1) {
      return res.status(400).json({ error: "The minimum online payment is GH₵1." });
    }

    const reference = "TIKGROW-" + crypto.randomBytes(12).toString("hex");

    await pool.query(
      "UPDATE orders SET payment_reference = $1 WHERE id = $2",
      [reference, order.id]
    );

    const digits = order.contact.replace(/\D/g, "");
    const email = digits + "@tikgrow-platform1.onrender.com";

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          amount: String(Math.round(Number(order.price_ghs) * 100)),
          currency: "GHS",
          reference,
          channels: ["card", "mobile_money"],
          callback_url: "https://tikgrow-platform1.onrender.com/payment-callback"
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status || !data.data?.authorization_url) {
      console.error("Paystack response:", data);
      return res.status(502).json({
        error: data.message || "Could not start payment."
      });
    }

    res.json({
      authorization_url: data.data.authorization_url,
      reference
    });
  } catch (error) {
    console.error("Payment setup error:", error.message);
    res.status(500).json({ error: "Could not initialize payment." });
  }
});

// CUSTOMER RETURNS FROM PAYSTACK
app.get("/payment-callback", async (req, res) => {
  try {
    const reference = String(req.query.reference || req.query.trxref || "");

    if (!reference) return res.redirect("/?payment=missing");

    const orderCode = await confirmPayment(reference);

    return res.redirect(
      "/track.html?order=" + encodeURIComponent(orderCode) + "&payment=success"
    );
  } catch (error) {
    console.error("Payment callback error:", error.message);
    return res.redirect("/?payment=verify-failed");
  }
});

// ADMIN: VIEW ORDERS
app.get("/api/admin/orders", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 500"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Admin orders error:", error.message);
    res.status(500).json({ error: "Could not load orders." });
  }
});

// ADMIN: UPDATE PROMOTION STATUS
app.patch("/api/admin/orders/:id", adminOnly, async (req, res) => {
  try {
    const allowedStatuses = [
      "New", "Awaiting Payment", "In Progress", "Completed", "Cancelled"
    ];

    const status = req.body.status;

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid order status." });
    }

    const result = await pool.query(
      `UPDATE orders SET status = $1
       WHERE id = $2 AND paid_at IS NOT NULL
       RETURNING id, order_code, status`,
      [status, req.params.id]
    );

    if (!result.rows.length) {
      return res.status(400).json({
        error: "Only paid orders can be updated for promotion."
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Admin update error:", error.message);
    res.status(500).json({ error: "Could not update order." });
  }
});

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "TIKGROW is online" });
});

// HOMEPAGE
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// OTHER STATIC PAGES
app.get(/.*/, (req, res, next) => {
  const requestedFile = path.join(__dirname, req.path);

  if (
    !requestedFile.startsWith(__dirname + path.sep) ||
    req.path.startsWith("/api/")
  ) {
    return next();
  }

  res.sendFile(requestedFile, error => {
    if (error && !res.headersSent) {
      res.status(404).send("Page not found");
    }
  });
});

// START SERVER
initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("TIKGROW running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });



