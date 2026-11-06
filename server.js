
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL || !process.env.ADMIN_SETUP_TOKEN) {
  console.error("Missing DATABASE_URL or ADMIN_SETUP_TOKEN");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: "20kb" }));
app.use(express.static(__dirname));

const services = [
  "TikTok Likes",
  "Video Views",
  "Followers",
  "LIVE Promotion",
  "Shares",
  "Comments"
];

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      contact TEXT NOT NULL,
      service TEXT NOT NULL,
      tiktok_link TEXT NOT NULL,
      details TEXT DEFAULT '',
      status TEXT DEFAULT 'New',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, message: "TIKGROW is online" });
  } catch {
    res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const { name, contact, service, link, details = "" } = req.body || {};

    if (!name || !contact || !service || !link) {
      return res.status(400).json({
        success: false,
        message: "Complete all required fields."
      });
    }

    if (!services.includes(service)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service."
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

    const code = "TG-" + crypto.randomBytes(5).toString("hex").toUpperCase();

    const result = await pool.query(
      `INSERT INTO orders
      (order_code, customer_name, contact, service, tiktok_link, details)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING order_code,status,created_at`,
      [
        String(name).trim().slice(0, 100),
        String(contact).trim().slice(0, 40),
        service,
        url.toString().slice(0, 500),
        String(details).slice(0, 1000)
      ].length === 0 ? [] : [
        code,
        String(name).trim().slice(0, 100),
        String(contact).trim().slice(0, 40),
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
    console.error(error.message);
    res.status(500).json({
      success: false,
      message: "Unable to save order."
    });
  }
});

function adminOnly(req, res, next) {
  const token = req.get("x-admin-token") || "";
  const expected = process.env.ADMIN_SETUP_TOKEN;

  if (
    token.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) {
    return res.status(401).json({ success: false, message: "Access denied" });
  }

  next();
}

app.get("/api/admin/orders", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 200"
    );
    res.json({ success: true, orders: result.rows });
  } catch {
    res.status(500).json({ success: false, message: "Could not load orders" });
  }
});

app.patch("/api/admin/orders/:id", adminOnly, async (req, res) => {
  const statuses = [
    "New",
    "Awaiting Payment",
    "Paid",
    "In Progress",
    "Completed",
    "Cancelled"
  ];

  if (!statuses.includes(req.body.status)) {
    return res.status(400).json({ success: false, message: "Invalid status" });
  }

  try {
    const result = await pool.query(
      "UPDATE orders SET status=$1 WHERE id=$2 RETURNING id,order_code,status",
      [req.body.status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    res.json({ success: true, order: result.rows[0] });
  } catch {
    res.status(500).json({ success: false, message: "Update failed" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

setupDatabase()
  .then(() => {
    app.listen(PORT, () => console.log("TIKGROW running on " + PORT));
  })
  .catch(error => {
    console.error("Database setup failed:", error.message);
    process.exit(1);
  });
