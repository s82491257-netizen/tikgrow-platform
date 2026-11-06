
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;
const scrypt = promisify(crypto.scrypt);

const REQUIRED = [
  "DATABASE_URL",
  "ADMIN_SETUP_TOKEN",
  "PAYSTACK_SECRET_KEY",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "SESSION_SECRET"
];

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

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  }
});

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    email: user.email,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

function readToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const expected = crypto
      .createHmac("sha256", process.env.SESSION_SECRET)
      .update(parts[0])
      .digest();

    const received = Buffer.from(parts[1], "base64url");

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) return null;

    const data = JSON.parse(
      Buffer.from(parts[0], "base64url").toString()
    );

    if (data.expires < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function customerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  const user = readToken(token);

  if (!user) {
    return res.status(401).json({ error: "Please log in first" });
  }

  req.user = user;
  next();
}

function adminAuth(req, res, next) {
  const supplied = req.headers["x-admin-token"] || "";
  const expected = process.env.ADMIN_SETUP_TOKEN;

  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return res.status(401).json({ error: "Admin access denied" });
  }

  next();
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return salt + ":" + hash.toString("hex");
}

async function checkPassword(password, stored) {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;

  const hash = await scrypt(password, parts[0], 64);
  const original = Buffer.from(parts[1], "hex");

  return original.length === hash.length &&
    crypto.timingSafeEqual(original, hash);
}

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "tikgrow-products" },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    stream.end(buffer);
  });
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS store_products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'Other',
      price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      image_url TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS store_orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES store_users(id),
      reference TEXT UNIQUE NOT NULL,
      total_amount NUMERIC(12,2) NOT NULL,
      currency TEXT DEFAULT 'GHS',
      phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      payment_status TEXT DEFAULT 'Pending',
      order_status TEXT DEFAULT 'Awaiting Payment',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS store_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES store_orders(id),
      product_id INTEGER REFERENCES store_products(id),
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL
    );
  `);

  console.log("TIKGROW database ready");
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, message: "TIKGROW store server is running" });
  } catch {
    res.status(500).json({ ok: false, error: "Database connection failed" });
  }
});

// Customer registration
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password || password.length < 8) {
      return res.status(400).json({
        error: "Enter your name, email and a password of at least 8 characters"
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const passwordHash = await hashPassword(password);

    const result = await pool.query(
      `INSERT INTO store_users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email`,
      [String(name).trim(), cleanEmail, passwordHash]
    );

    const user = result.rows[0];

    res.status(201).json({
      message: "Account created",
      user,
      token: makeToken(user)
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }

    console.error("Registration error:", error);
    res.status(500).json({ error: "Could not create account" });
  }
});

// Customer login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Enter email and password" });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash
       FROM store_users WHERE email = $1`,
      [String(email).trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || !(await checkPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect email or password" });
    }

    res.json({
      message: "Login successful",
      user: { id: user.id, name: user.name, email: user.email },
      token: makeToken(user)
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Public product list
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, category, price, stock, image_url, active
       FROM store_products
       WHERE active = TRUE
       ORDER BY created_at DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Products error:", error);
    res.status(500).json({ error: "Could not load products" });
  }
});

// Single product
app.get("/api/products/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, category, price, stock, image_url
       FROM store_products
       WHERE id = $1 AND active = TRUE`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Could not load product" });
  }
});

// Admin: upload product image
app.post("/api/admin/upload", adminAuth, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Choose an image first" });
    }

    const result = await uploadToCloudinary(req.file.buffer);

    res.json({
      image_url: result.secure_url,
      public_id: result.public_id
    });
  } catch (error) {
    console.error("Image upload error:", error);
    res.status(500).json({ error: "Image upload failed" });
  }
});

// Admin: list products
app.get("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM store_products ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load admin products" });
  }
});

// Admin: add product
app.post("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const { name, description, category, price, stock, image_url } = req.body;

    if (!name || !Number.isFinite(Number(price)) ||
        Number(price) < 0 || !Number.isInteger(Number(stock)) ||
        Number(stock) < 0) {
      return res.status(400).json({ error: "Check product name, price and stock" });
    }

    const result = await pool.query(
      `INSERT INTO store_products
       (name, description, category, price, stock, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        String(name).trim(),
        description || "",
        category || "Other",
        Number(price),
        Number(stock),
        image_url || ""
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add product error:", error);
    res.status(500).json({ error: "Could not add product" });
  }
});

// Admin: edit product
app.patch("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const allowed = [
      "name", "description", "category",
      "price", "stock", "image_url", "active"
    ];

    const fields = [];
    const values = [];
    let index = 1;

    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        fields.push(`${key} = $${index++}`);
        values.push(req.body[key]);
      }
    }

    if (!fields.length) {
      return res.status(400).json({ error: "No product changes supplied" });
    }

    values.push(req.params.id);

    const result = await pool.query(
      `UPDATE store_products SET ${fields.join(", ")}
       WHERE id = $${index} RETURNING *`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Edit product error:", error);
    res.status(500).json({ error: "Could not update product" });
  }
});

// Admin: remove product (soft delete)
app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE store_products SET active = FALSE
       WHERE id = $1 RETURNING id`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ message: "Product removed" });
  } catch (error) {
    res.status(500).json({ error: "Could not remove product" });
  }
});

// Verify a payment directly with Paystack
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
    throw new Error("Paystack could not verify this payment");
  }

  return data.data;
}

// Mark an order paid and deduct stock once
async function markOrderPaid(reference) {
  const payment = await verifyPaystack(reference);

  if (payment.status !== "success" || payment.currency !== "GHS") {
    throw new Error("Payment is not successful");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      "SELECT * FROM store_orders WHERE reference = $1 FOR UPDATE",
      [reference]
    );

    if (!orderResult.rows.length) {
      throw new Error("Order not found");
    }

    const order = orderResult.rows[0];

    if (order.payment_status === "Paid") {
      await client.query("COMMIT");
      return order;
    }

    const expectedAmount = Math.round(Number(order.total_amount) * 100);

    if (Number(payment.amount) !== expectedAmount) {
      throw new Error("Payment amount does not match the order");
    }

    const items = await client.query(
      "SELECT * FROM store_order_items WHERE order_id = $1",
      [order.id]
    );

    for (const item of items.rows) {
      const updated = await client.query(
        `UPDATE store_products
         SET stock = stock - $1
         WHERE id = $2 AND stock >= $1 AND active = TRUE
         RETURNING id`,
        [item.quantity, item.product_id]
      );

      if (!updated.rows.length) {
        throw new Error("Insufficient stock for " + item.product_name);
      }
    }

    const result = await client.query(
      `UPDATE store_orders
       SET payment_status = 'Paid', order_status = 'Processing'
       WHERE id = $1 RETURNING *`,
      [order.id]
    );

    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Paystack webhook - raw body must be handled before express.json()
app.post("/api/paystack/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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

    if (event.event === "charge.success" && event.data.reference) {
      await markOrderPaid(event.data.reference);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Paystack webhook error:", error);
    res.sendStatus(400);
  }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Customer checkout
app.post("/api/checkout", customerAuth, async (req, res) => {
  const { items, phone, delivery_address } = req.body;

  if (!Array.isArray(items) || !items.length || !phone || !delivery_address) {
    return res.status(400).json({
      error: "Provide cart items, phone number and delivery address"
    });
  }

  const client = await pool.connect();
  let order;

  try {
    await client.query("BEGIN");

    const quantities = new Map();

    for (const item of items) {
      const id = Number(item.product_id);
      const quantity = Number(item.quantity);

      if (!Number.isInteger(id) || !Number.isInteger(quantity) ||
          quantity < 1 || quantity > 100) {
        throw new Error("Invalid cart item");
      }

      quantities.set(id, (quantities.get(id) || 0) + quantity);
    }

    const ids = [...quantities.keys()];

    const productResult = await client.query(
      `SELECT * FROM store_products
       WHERE id = ANY($1::int[]) AND active = TRUE
       FOR UPDATE`,
      [ids]
    );

    if (productResult.rows.length !== ids.length) {
      throw new Error("One or more products are unavailable");
    }

    let total = 0;

    for (const product of productResult.rows) {
      const quantity = quantities.get(product.id);

      if (product.stock < quantity) {
        throw new Error("Not enough stock for " + product.name);
      }

      total += Number(product.price) * quantity;
    }

    const reference = "TG-" + crypto.randomBytes(12).toString("hex");

    const orderResult = await client.query(
      `INSERT INTO store_orders
       (user_id, reference, total_amount, phone, delivery_address)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, reference, total.toFixed(2), phone, delivery_address]
    );

    order = orderResult.rows[0];

    for (const product of productResult.rows) {
      await client.query(
        `INSERT INTO store_order_items
         (order_id, product_id, product_name, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          order.id,
          product.id,
          product.name,
          quantities.get(product.id),
          product.price
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    return res.status(400).json({ error: error.message });
  }

  client.release();

  try {
    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: req.user.email,
          amount: Math.round(Number(order.total_amount) * 100),
          currency: "GHS",
          reference: order.reference,
          callback_url: process.env.APP_URL
            ? process.env.APP_URL.replace(/\/$/, "") + "/payment-callback.html"
            : undefined
        })
      }
    );

    const data = await paystackResponse.json();

    if (!paystackResponse.ok || !data.status || !data.data?.authorization_url) {
      await pool.query(
        `UPDATE store_orders
         SET payment_status = 'Initialization Failed',
             order_status = 'Payment Failed'
         WHERE id = $1`,
        [order.id]
      );

      return res.status(502).json({
        error: data.message || "Could not start Paystack payment"
      });
    }

    res.json({
      authorization_url: data.data.authorization_url,
      reference: order.reference
    });
  } catch (error) {
    console.error("Checkout payment error:", error);
    res.status(502).json({ error: "Could not connect to Paystack" });
  }
});

// Customer verifies payment after returning from Paystack
app.get("/api/payment/verify/:reference", customerAuth, async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT * FROM store_orders
       WHERE reference = $1 AND user_id = $2`,
      [req.params.reference, req.user.id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await markOrderPaid(req.params.reference);
    res.json({ message: "Payment verified", order });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Customer order history
app.get("/api/my-orders", customerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*,
        COALESCE(
          json_agg(
            json_build_object(
              'product_name', i.product_name,
              'quantity', i.quantity,
              'unit_price', i.unit_price
            )
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'
        ) AS items
       FROM store_orders o
       LEFT JOIN store_order_items i ON i.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load your orders" });
  }
});

// Admin order list
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, u.name AS customer_name, u.email AS customer_email,
        COALESCE(
          json_agg(
            json_build_object(
              'product_name', i.product_name,
              'quantity', i.quantity,
              'unit_price', i.unit_price
            )
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'
        ) AS items
       FROM store_orders o
       LEFT JOIN store_users u ON u.id = o.user_id
       LEFT JOIN store_order_items i ON i.order_id = o.id
       GROUP BY o.id, u.name, u.email
       ORDER BY o.created_at DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Admin orders error:", error);
    res.status(500).json({ error: "Could not load orders" });
  }
});

// Admin update order status
app.patch("/api/admin/orders/:id", adminAuth, async (req, res) => {
  const allowed = [
    "Processing",
    "Ready for Delivery",
    "Shipped",
    "Completed",
    "Cancelled"
  ];

  const status = req.body.order_status;

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid order status" });
  }

  try {
    const result = await pool.query(
      `UPDATE store_orders SET order_status = $1
       WHERE id = $2 AND payment_status = 'Paid'
       RETURNING *`,
      [status, req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Paid order not found"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Could not update order" });
  }
});

// Error handler
app.use((error, req, res, next) => {
  console.error("Server error:", error);
  res.status(500).json({ error: error.message || "Server error" });
});

// Start only after database setup succeeds
initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log("TIKGROW store running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });
