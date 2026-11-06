

const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = "https://tikgrow-platform1.onrender.com";

if (
  !process.env.DATABASE_URL ||
  !process.env.ADMIN_SETUP_TOKEN ||
  !process.env.PAYSTACK_SECRET_KEY
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const services = [
  "TikTok Likes",
  "Video Views",
  "Followers",
  "LIVE Promotion",
  "Shares",
  "Comments"
];

app.use(express.json({
  limit: "20kb",
  verify: (req, res, buffer) => {
    req.rawBody = buffer;
  }
}));

app.use(express.static(__dirname));

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL DEFAULT 'Customer',
      contact TEXT NOT NULL,
      service TEXT NOT NULL,
      tiktok_link TEXT NOT NULL,
      details TEXT DEFAULT '',
      status TEXT DEFAULT 'New',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS price_ghs NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS payment_reference TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ
  `);
}

function adminOnly(req, res, next) {
  const token = req.get("x-admin-token") || "";
  const expected = process.env.ADMIN_SETUP_TOKEN;

  const a = Buffer.from(token);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      success: false,
      message: "Access denied"
    });
  }

  next();
}

async function verifyPaystack(reference) {
  const response = await fetch(
    "https://api.paystack.co/transaction/verify/" +
    encodeURIComponent(reference),
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    }
  );

  const result = await response.json();

  if (!response.ok || !result.status) {
    throw new Error("Paystack verification failed");
  }

  return result.data;
}

async function confirmPayment(reference) {
  const orderResult = await pool.query(
    "SELECT * FROM orders WHERE payment_reference=$1",
    [reference]
  );

  if (!orderResult.rowCount) return null;

  const order = orderResult.rows[0];
  const payment = await verifyPaystack(reference);

  const expectedAmount = Math.round(Number(order.price_ghs) * 100);

  if (
    payment.status !== "success" ||
    payment.currency !== "GHS" ||
    Number(payment.amount) !== expectedAmount
  ) {
    return order;
  }

  await pool.query(
    `UPDATE orders
     SET status='Paid', paid_at=COALESCE(paid_at,NOW())
     WHERE id=$1`,
    [order.id]
  );

  const updated = await pool.query(
    "SELECT * FROM orders WHERE id=$1",
    [order.id]
  );

  return updated.rows[0];
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      success: true,
      message: "TIKGROW is online"
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Database error"
    });
  }
});

// CUSTOMER: CREATE ORDER
app.post("/api/orders", async (req, res) => {
  try {
    const { contact, service, link, details = "" } = req.body || {};

    if (!contact || !service || !link) {
      return res.status(400).json({
        success: false,
        message: "Enter your phone number, service and TikTok link."
      });
    }

    if (!services.includes(service)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service."
      });
    }

    const phone = String(contact).trim();

    if (!/^\+?[0-9\s-]{7,20}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid phone number."
      });
    }

    let url;

    try {
      url = new URL(link);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid TikTok link."
      });
    }

    if (
      url.hostname !== "tiktok.com" &&
      !url.hostname.endsWith(".tiktok.com")
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a TikTok link."
      });
    }

    const code =
      "TG-" + crypto.randomBytes(5).toString("hex").toUpperCase();

    const result = await pool.query(
      `INSERT INTO orders
       (order_code, customer_name, contact, service, tiktok_link, details)
       VALUES ($1,'Customer',$2,$3,$4,$5)
       RETURNING order_code, service, status, created_at`,
      [
        code,
        phone.slice(0, 40),
        service,
        url.toString().slice(0, 500),
        String(details).slice(0, 1000)
      ]
    );

    res.status(201).json({
      success: true,
      message: "Order received.",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Order error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to save order."
    });
  }
});

// CUSTOMER: TRACK ORDER
app.get("/api/orders/:code", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT order_code, service, details, status,
              price_ghs, created_at, paid_at
       FROM orders WHERE order_code=$1`,
      [req.params.code.toUpperCase()]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    res.json({
      success: true,
      order: result.rows[0]
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not track order."
    });
  }
});

// CUSTOMER: START PAYSTACK CHECKOUT
app.post("/api/orders/:code/pay", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE order_code=$1",
      [req.params.code.toUpperCase()]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    const order = result.rows[0];

    if (order.status === "Paid" || order.paid_at) {
      return res.status(400).json({
        success: false,
        message: "This order has already been paid."
      });
    }

    if (!order.price_ghs || Number(order.price_ghs) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Your order is waiting for a price."
      });
    }

    const reference =
      "TG" + crypto.randomBytes(12).toString("hex");

    await pool.query(
      "UPDATE orders SET payment_reference=$1 WHERE id=$2",
      [reference, order.id]
    );

    const phoneDigits = order.contact.replace(/\D/g, "");

    const generatedEmail =
      phoneDigits + "@tikgrow-platform1.onrender.com";

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: generatedEmail,
          amount: String(Math.round(Number(order.price_ghs) * 100)),
          currency: "GHS",
          reference,
          channels: ["card", "mobile_money"],
          callback_url: BASE_URL + "/api/paystack/callback",
          metadata: {
            order_code: order.order_code,
            phone: order.contact,
            service: order.service
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      throw new Error(data.message || "Could not start payment.");
    }

    res.json({
      success: true,
      checkout_url: data.data.authorization_url
    });
  } catch (error) {
    console.error("Payment error:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not start payment. Please try again."
    });
  }
});

// PAYSTACK: CUSTOMER RETURN
app.get("/api/paystack/callback", async (req, res) => {
  try {
    const reference = String(req.query.reference || "");

    if (!reference) {
      return res.redirect("/track.html?payment=unknown");
    }

    const orderResult = await pool.query(
      "SELECT order_code FROM orders WHERE payment_reference=$1",
      [reference]
    );

    if (!orderResult.rowCount) {
      return res.redirect("/track.html?payment=unknown");
    }

    const orderCode = orderResult.rows[0].order_code;

    await confirmPayment(reference);

    res.redirect(
      "/track.html?order=" +
      encodeURIComponent(orderCode) +
      "&payment=checked"
    );
  } catch (error) {
    console.error("Callback error:", error.message);
    res.redirect("/track.html?payment=checking");
  }
});

// PAYSTACK: WEBHOOK (IMPORTANT FOR MOBILE MONEY)
app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const signature = req.get("x-paystack-signature") || "";

    const expected = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.rawBody || Buffer.from(""))
      .digest("hex");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.sendStatus(401);
    }

    if (req.body.event === "charge.success") {
      const reference = req.body.data.reference;
      await confirmPayment(reference);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.sendStatus(500);
  }
});

// ADMIN: VIEW ORDERS
app.get("/api/admin/orders", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 200"
    );

    res.json({
      success: true,
      orders: result.rows
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load orders."
    });
  }
});

// ADMIN: SET ORDER PRICE
app.patch("/api/admin/orders/:id/price", adminOnly, async (req, res) => {
  const price = Number(req.body.price_ghs);

  if (!Number.isFinite(price) || price <= 0 || price > 1000000) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid price in GHS."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE orders SET price_ghs=$1
       WHERE id=$2 AND status <> 'Paid'
       RETURNING id, order_code, price_ghs, status`,
      [price.toFixed(2), req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found or already paid."
      });
    }

    res.json({
      success: true,
      order: result.rows[0]
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not set price."
    });
  }
});

// ADMIN: UPDATE PROMOTION STATUS
app.patch("/api/admin/orders/:id", adminOnly, async (req, res) => {
  const statuses = [
    "New",
    "Awaiting Payment",
    "In Progress",
    "Completed",
    "Cancelled"
  ];

  if (!statuses.includes(req.body.status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid status. Payment status is verified automatically."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE orders SET status=$1
       WHERE id=$2 AND status <> 'Paid'
       RETURNING id, order_code, status`,
      [req.body.status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found or already paid."
      });
    }

    res.json({
      success: true,
      order: result.rows[0]
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Update failed."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

setupDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log("TIKGROW running on " + PORT);
    });
  })
  .catch(error => {
    console.error("Database setup failed:", error.message);
    process.exit(1);
  });
