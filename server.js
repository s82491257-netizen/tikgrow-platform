


const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

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

// TIKGROW automatic campaign prices per 1,000 units.
const PRICES = {
  "TikTok Likes": 25,
  "Comments": 35,
  "Followers": 45,
  "Video Views": 10,
  "Shares": 35,
  "LIVE Promotion": 55
};

const SERVICES = Object.keys(PRICES);

function calculatePrice(service, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) {
    throw new Error("Quantity must be between 1 and 1,000,000.");
  }

  if (!Object.prototype.hasOwnProperty.call(PRICES, service)) {
    throw new Error("Please select a valid service.");
  }

  return Math.round(PRICES[service] * quantity / 1000 * 100) / 100;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

// Keep the original request bytes for Paystack webhook verification.
app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

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
    CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_reference_unique
    ON orders(payment_reference)
    WHERE payment_reference IS NOT NULL
  `);

  console.log("TIKGROW database ready.");
}

function makeOrderCode() {
  return "TG-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function validTikTokLink(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      [
        "tiktok.com",
        "www.tiktok.com",
        "m.tiktok.com",
        "vm.tiktok.com",
        "vt.tiktok.com"
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function adminOnly(req, res, next) {
  const token = req.headers["x-admin-token"];

  if (!token || token !== process.env.ADMIN_SETUP_TOKEN) {
    return res.status(401).json({
      error: "Unauthorized admin access."
    });
  }

  next();
}

// PAYSTACK VERIFICATION
async function verifyPaystack(reference) {
  const response = await fetch(
    "https://api.paystack.co/transaction/verify/" +
      encodeURIComponent(reference),
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
    `SELECT * FROM orders
     WHERE payment_reference = $1`,
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
     SET status = 'Paid',
         paid_at = COALESCE(paid_at, NOW())
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

    if (
      !signature ||
      !rawBody ||
      !/^[0-9a-f]{128}$/i.test(signature)
    ) {
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

    if (
      event.event === "charge.success" &&
      event.data &&
      event.data.reference
    ) {
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
      return res.status(400).json({
        error: "Enter a valid phone number."
      });
    }

    if (!validTikTokLink(link)) {
      return res.status(400).json({
        error: "Enter a valid TikTok link."
      });
    }

    if (!SERVICES.includes(service)) {
      return res.status(400).json({
        error: "Select a valid campaign service."
      });
    }

    const price = calculatePrice(service, quantity);
    const orderCode = makeOrderCode();

    const saved = await pool.query(
      `INSERT INTO orders
       (order_code, customer_name, contact, service,
        tiktok_link, details, quantity, price_ghs)
       VALUES ($1, 'Customer', $2, $3, $4, $5, $6, $7)
       RETURNING order_code, service, quantity,
                 price_ghs, status, created_at`,
      [
        orderCode,
        contact,
        service,
        link,
        "Campaign request",
        quantity,
        price
      ]
    );

    res.status(201).json(saved.rows[0]);

  } catch (error) {
    console.error("Order error:", error.message);

    res.status(400).json({
      error: error.message || "Could not save order."
    });
  }
});

// CUSTOMER ORDER TRACKING
app.get("/api/orders/:code", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_code, service, quantity, price_ghs,
              status, paid_at, created_at
       FROM orders
       WHERE order_code = $1`,
      [req.params.code]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Order not found."
      });
    }

    const order = result.rows[0];

    res.json({
      ...order,
      payment_status: order.paid_at ? "Paid" : "Not paid"
    });

  } catch (error) {
    console.error("Tracking error:", error.message);

    res.status(500).json({
      error: "Could not check order."
    });
  }
});

// INITIALIZE PAYSTACK CHECKOUT
app.post("/api/orders/:code/pay", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM orders WHERE order_code = $1`,
      [req.params.code]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Order not found."
      });
    }

    const order = result.rows[0];

    if (order.paid_at) {
      return res.status(400).json({
        error: "This order has already been paid."
      });
    }

    if (Number(order.price_ghs) < 1) {
      return res.status(400).json({
        error: "The minimum online payment is GH₵1."
      });
    }

    const reference =
      "TIKGROW-" + crypto.randomBytes(12).toString("hex");

    await pool.query(
      `UPDATE orders
       SET payment_reference = $1
       WHERE id = $2`,
      [reference, order.id]
    );

    // Paystack requires an email.
    // This generated address is not a working mailbox.
    // Customer receipts will not reach this address.
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
          callback_url:
            "https://tikgrow-platform1.onrender.com/payment-callback"
        })
      }
    );

    const data = await response.json();

    if (
      !response.ok ||
      !data.status ||
      !data.data ||
      !data.data.authorization_url
    ) {
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

    res.status(500).json({
      error: "Could not initialize payment."
    });
  }
});

// CUSTOMER RETURNS FROM PAYSTACK
app.get("/payment-callback", async (req, res) => {
  try {
    const reference = String(
      req.query.reference || req.query.trxref || ""
    );

    if (!reference) {
      return res.redirect("/?payment=missing");
    }

    const orderCode = await confirmPayment(reference);

    return res.redirect(
      "/track.html?order=" +
      encodeURIComponent(orderCode) +
      "&payment=success"
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
      `SELECT * FROM orders
       ORDER BY created_at DESC
       LIMIT 500`
    );

    res.json(result.rows);

  } catch (error) {
    console.error("Admin orders error:", error.message);

    res.status(500).json({
      error: "Could not load orders."
    });
  }
});

// ADMIN: UPDATE PROMOTION STATUS
// Payment status can only be confirmed by Paystack verification.
app.patch("/api/admin/orders/:id", adminOnly, async (req, res) => {
  try {
    const allowedStatuses = [
      "New",
      "Awaiting Payment",
      "In Progress",
      "Completed",
      "Cancelled"
    ];

    const status = req.body.status;

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Invalid order status."
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET status = $1
       WHERE id = $2
         AND paid_at IS NOT NULL
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

    res.status(500).json({
      error: "Could not update order."
    });
  }
});

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "TIKGROW is online"
  });
});

// CUSTOMER HOMEPAGE
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
