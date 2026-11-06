

const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const REQUIRED = ["DATABASE_URL", "ADMIN_SETUP_TOKEN", "PAYSTACK_SECRET_KEY"];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error("Missing environment variable:", key);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const PRICES = {
  "TikTok Likes": 25,
  "Comments": 35,
  "Followers": 45,
  "Video Views": 10,
  "Shares": 35
};

const LIVE_PRICE = 55;
const SERVICES = [
  ...Object.keys(PRICES),
  "LIVE Promotion"
];

function calculatePrice(service, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1000 || quantity > 1000000) {
    throw new Error("Quantity must be between 1,000 and 1,000,000.");
  }

  if (service === "LIVE Promotion") {
    if (quantity !== 1000) {
      throw new Error("LIVE Promotion is a fixed campaign package.");
    }
    return LIVE_PRICE;
  }

  if (!PRICES[service]) {
    throw new Error("Invalid campaign service.");
  }

  return Math.round((PRICES[service] * quantity / 1000) * 100) / 100;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    ADD COLUMN IF NOT EXISTS price_ghs NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS payment_reference TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1000
  `);
}

function makeOrderCode() {
  return "TG-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function validTikTokLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function adminOnly(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_SETUP_TOKEN) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }
  next();
}

async function verifyPaystack(reference) {
  const response = await fetch(
    "https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference),
    {
      headers: {
        Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY
      }
    }
  );

  const result = await response.json();

  if (!response.ok || !result.status || !result.data) {
    throw new Error("Payment verification failed.");
  }

  return result.data;
}

async function confirmPayment(reference) {
  const result = await verifyPaystack(reference);

  if (result.status !== "success" || result.currency !== "GHS") {
    throw new Error("Payment is not successful in GHS.");
  }

  const orderResult = await pool.query(
    "SELECT * FROM orders WHERE payment_reference = $1",
    [reference]
  );

  if (!orderResult.rows.length) {
    throw new Error("Order for this payment was not found.");
  }

  const order = orderResult.rows[0];
  const expectedAmount = Math.round(Number(order.price_ghs) * 100);

  if (Number(result.amount) !== expectedAmount) {
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

// Paystack webhook must receive the raw request body.
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];
      const expected = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      if (
        !signature ||
        signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString());

      if (event.event === "charge.success" && event.data?.reference) {
        await confirmPayment(event.data.reference);
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error("Paystack webhook:", error.message);
      return res.sendStatus(400);
    }
  }
);

// Create a campaign order and calculate the price on the server.
app.post("/api/orders", async (req, res) => {
  try {
    const { contact, link, service, quantity } = req.body;

    const phone = String(contact || "").trim();
    const qty = Number(quantity);

    if (!phone || phone.length < 7 || phone.length > 20) {
      return res.status(400).json({ error: "Enter a valid phone number." });
    }

    if (!validTikTokLink(String(link || ""))) {
      return res.status(400).json({ error: "Enter a valid TikTok link." });
    }

    if (!SERVICES.includes(service)) {
      return res.status(400).json({ error: "Select a valid service." });
    }

    const price = calculatePrice(service, qty);
    const code = makeOrderCode();

    const saved = await pool.query(
      `INSERT INTO orders
       (order_code, customer_name, contact, service, tiktok_link, details, quantity, price_ghs)
       VALUES ($1, 'Customer', $2, $3, $4, $5, $6, $7)
       RETURNING order_code, status, quantity, price_ghs, created_at`,
      [
        code,
        phone,
        service,
        String(link),
        "Campaign request",
        qty,
        price
      ]
    );

    res.status(201).json(saved.rows[0]);
  } catch (error) {
    console.error("Create order:", error.message);
    res.status(400).json({ error: error.message || "Could not create order." });
  }
});

// Customer tracking. Do not expose phone number or private admin data.
app.get("/api/orders/:code", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_code, service, quantity, price_ghs, status, paid_at, created_at
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
    console.error(error.message);
    res.status(500).json({ error: "Could not retrieve order." });
  }
});

// Initialize Paystack checkout for an order.
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
      return res.status(400).json({ error: "This order is already paid." });
    }

    const reference = "TIKGROW-" + crypto.randomBytes(12).toString("hex");

    await pool.query(
      "UPDATE orders SET payment_reference = $1 WHERE id = $2",
      [reference, order.id]
    );

    // Paystack requires an email address for transaction initialization.
    // This generated address is not a customer mailbox.
    const digits = order.contact.replace(/\D/g, "");
    const email = digits + "@tikgrow-platform1.onrender.com";

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        amount: Math.round(Number(order.price_ghs) * 100),
        currency: "GHS",
        reference,
        channels: ["card", "mobile_money"],
        callback_url: "https://tikgrow-platform1.onrender.com/payment-callback"
      })
    });

    const data = await response.json();

    if (!response.ok || !data.status || !data.data?.authorization_url) {
      console.error("Paystack initialization:", data);
      return res.status(502).json({
        error: data.message || "Could not start Paystack checkout."
      });
    }

    res.json({
      authorization_url: data.data.authorization_url,
      reference
    });
  } catch (error) {
    console.error("Payment initialization:", error.message);
    res.status(500).json({ error: "Could not initialize payment." });
  }
});

// Verify payment after Paystack redirects the customer back.
app.get("/payment-callback", async (req, res) => {
  try {
    const reference = String(req.query.reference || req.query.trxref || "");
    if (!reference) {
      return res.redirect("/?payment=missing");
    }

    const code = await confirmPayment(reference);
    return res.redirect("/track.html?order=" + encodeURIComponent(code) + "&payment=success");
  } catch (error) {
    console.error("Payment callback:", error.message);
    return res.redirect("/?payment=verify-failed");
  }
});

// Admin order list.
app.get("/api/admin/orders", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 500"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load orders." });
  }
});

// Admin can update campaign status, but cannot manually mark orders as paid.
app.patch("/api/admin/orders/:id", adminOnly, async (req, res) => {
  try {
    const allowed = ["New", "Awaiting Payment", "In Progress", "Completed", "Cancelled"];
    const { status } = req.body;

    if (!allowed.includes(status)) {
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
        error: "Only successfully paid orders can be moved through promotion statuses."
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: "Could not update order." });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "TIKGROW is online" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => console.log("TIKGROW running on port " + PORT));
  })
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
