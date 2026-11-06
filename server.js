const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
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
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  }
});

app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];
      const secret = process.env.PAYSTACK_SECRET_KEY;

      if (!secret || !signature) return res.sendStatus(401);

      const expected = crypto
        .createHmac("sha512", secret)
        .update(req.body)
        .digest("hex");

      const a = Buffer.from(signature);
      const b = Buffer.from(expected);

      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString());

      if (event.event === "charge.success") {
        await markOrderPaid(event.data.reference);
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Webhook error:", error.message);
      res.sendStatus(500);
    }
  }
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

function requiredEnvironment() {
  const required = [
    "DATABASE_URL",
    "ADMIN_SETUP_TOKEN",
    "PAYSTACK_SECRET_KEY",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "SESSION_SECRET"
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length) {
    throw new Error("Missing environment variables: " + missing.join(", "));
  }
}

function makeToken(payload) {
  const data = Buffer.from(JSON.stringify({
    ...payload,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(data)
    .digest("hex");

  return data + "." + signature;
}

function verifyToken(token) {
  try {
    const [data, signature] = token.split(".");
    if (!data || !signature) return null;

    const expected = crypto
      .createHmac("sha256", process.env.SESSION_SECRET)
      .update(data)
      .digest("hex");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString()
    );

    if (payload.expires < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

function customerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  const payload = verifyToken(token);

  if (!payload || !payload.userId) {
    return res.status(401).json({ error: "Please log in again." });
  }

  req.user = payload;
  next();
}

function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || "";
  const expected = process.env.ADMIN_SETUP_TOKEN || "";

  const a = Buffer.from(String(token));
  const b = Buffer.from(String(expected));

  if (!expected || a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Admin access denied." });
  }

  next();
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
      category TEXT DEFAULT 'General',
      price_ghs NUMERIC(12,2) NOT NULL CHECK (price_ghs >= 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      image_url TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS store_orders (
      id SERIAL PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES store_users(id),
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      amount_ghs NUMERIC(12,2) NOT NULL,
      payment_reference TEXT UNIQUE NOT NULL,
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

  console.log("Store database ready.");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });

  return salt + ":" + hash;
}

async function checkPassword(password, stored) {
  const [salt, original] = stored.split(":");

  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

  const a = Buffer.from(original, "hex");

  return a.length === hash.length &&
    crypto.timingSafeEqual(a, hash);
}

// CUSTOMER REGISTRATION

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password || password.length < 8) {
      return res.status(400).json({
        error: "Enter your name, email and a password of at least 8 characters."
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const passwordHash = await hashPassword(password);

    const result = await pool.query(
      `INSERT INTO store_users (name,email,password_hash)
       VALUES ($1,$2,$3)
       RETURNING id,name,email`,
      [String(name).trim(), normalizedEmail, passwordHash]
    );

    const user = result.rows[0];

    res.json({
      token: makeToken({ userId: user.id }),
      user
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Email already registered." });
    }

    console.error(error);
    res.status(500).json({ error: "Registration failed." });
  }
});

// CUSTOMER LOGIN

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM store_users WHERE email=$1",
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await checkPassword(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    res.json({
      token: makeToken({ userId: user.id }),
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed." });
  }
});

// PUBLIC PRODUCT LIST

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id,name,description,category,price_ghs,stock,image_url
      FROM store_products
      WHERE active=TRUE
      ORDER BY created_at DESC
    `);

    res.json({ products: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load products." });
  }
});

// SINGLE PRODUCT

app.get("/api/products/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,name,description,category,price_ghs,stock,image_url
       FROM store_products
       WHERE id=$1 AND active=TRUE`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Product not found." });
    }

    res.json({ product: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Could not load product." });
  }
});

// ADMIN: LIST PRODUCTS

app.get("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM store_products ORDER BY created_at DESC"
    );

    res.json({ products: result.rows });
  } catch (error) {
    res.status(500).json({ error: "Could not load products." });
  }
});

// ADMIN: UPLOAD PRODUCT IMAGE

app.post(
  "/api/admin/upload",
  adminAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Choose an image first." });
      }

      const imageUrl = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "tikgrow-products",
            resource_type: "image"
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          }
        );

        stream.end(req.file.buffer);
      });

      res.json({ image_url: imageUrl });
    } catch (error) {
      console.error("Image upload:", error.message);
      res.status(500).json({ error: "Image upload failed." });
    }
  }
);

// ADMIN: ADD PRODUCT

app.post("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const { name, description, category, price_ghs, stock, image_url } = req.body;

    const price = Number(price_ghs);
    const quantity = Number(stock);

    if (!name || !Number.isFinite(price) || price < 0 ||
        !Number.isInteger(quantity) || quantity < 0) {
      return res.status(400).json({ error: "Check product details and stock." });
    }

    const result = await pool.query(
      `INSERT INTO store_products
       (name,description,category,price_ghs,stock,image_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        String(name).trim(),
        description || "",
        category || "General",
        price,
        quantity,
        image_url || ""
      ]
    );

    res.json({ product: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not add product." });
  }
});

// ADMIN: EDIT PRODUCT

app.patch("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const { name, description, category, price_ghs, stock, image_url, active } = req.body;

    const result = await pool.query(
      `UPDATE store_products SET
       name=COALESCE($1,name),
       description=COALESCE($2,description),
       category=COALESCE($3,category),
       price_ghs=COALESCE($4,price_ghs),
       stock=COALESCE($5,stock),
       image_url=COALESCE($6,image_url),
       active=COALESCE($7,active)
       WHERE id=$8 RETURNING *`,
      [
        name ?? null,
        description ?? null,
        category ?? null,
        price_ghs === undefined ? null : Number(price_ghs),
        stock === undefined ? null : Number(stock),
        image_url ?? null,
        active ?? null,
        req.params.id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Product not found." });
    }

    res.json({ product: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not update product." });
  }
});

// ADMIN: DELETE PRODUCT (SOFT DELETE)

app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE store_products SET active=FALSE
       WHERE id=$1 RETURNING id`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Product not found." });
    }

    res.json({ message: "Product removed from store." });
  } catch (error) {
    res.status(500).json({ error: "Could not remove product." });
  }
});

// CREATE PAYSTACK CHECKOUT

app.post("/api/checkout", customerAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { items, phone, delivery_address } = req.body;

    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return res.status(400).json({ error: "Your cart is empty or invalid." });
    }

    if (!phone || !delivery_address) {
      return res.status(400).json({
        error: "Enter your phone number and delivery address."
      });
    }

    const userResult = await pool.query(
      "SELECT id,name,email FROM store_users WHERE id=$1",
      [req.user.userId]
    );

    if (!userResult.rows.length) {
      return res.status(401).json({ error: "Customer account not found." });
    }

    const user = userResult.rows[0];

    await client.query("BEGIN");

    const cleanItems = new Map();

    for (const item of items) {
      const id = Number(item.product_id);
      const quantity = Number(item.quantity);

      if (!Number.isInteger(id) || !Number.isInteger(quantity) ||
          quantity < 1 || quantity > 1000) {
        throw new Error("Invalid cart quantity.");
      }

      cleanItems.set(id, (cleanItems.get(id) || 0) + quantity);
    }

    let total = 0;
    const selected = [];

    for (const [id, quantity] of cleanItems) {
      const result = await client.query(
        `SELECT * FROM store_products
         WHERE id=$1 AND active=TRUE FOR UPDATE`,
        [id]
      );

      const product = result.rows[0];

      if (!product) throw new Error("A product in your cart is unavailable.");
      if (product.stock < quantity) {
        throw new Error("Not enough stock for " + product.name);
      }

      const price = Number(product.price_ghs);
      total += price * quantity;

      selected.push({ product, quantity, price });
    }

    if (!Number.isFinite(total) || total <= 0) {
      throw new Error("Invalid order total.");
    }

    const reference = "TGSTORE-" + crypto.randomUUID();

    const orderResult = await client.query(
      `INSERT INTO store_orders
       (order_code,user_id,email,phone,delivery_address,
        amount_ghs,payment_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,order_code`,
      [
        reference,
        user.id,
        user.email,
        String(phone).trim(),
        String(delivery_address).trim(),
        total.toFixed(2),
        reference
      ]
    );

    const order = orderResult.rows[0];

    for (const item of selected) {
      await client.query(
        `INSERT INTO store_order_items
         (order_id,product_id,product_name,quantity,unit_price)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          order.id,
          item.product.id,
          item.product.name,
          item.quantity,
          item.price
        ]
      );
    }

    await client.query("COMMIT");

    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: user.email,
          amount: Math.round(total * 100),
          currency: "GHS",
          reference,
          callback_url:
            process.env.PAYSTACK_CALLBACK_URL ||
            (process.env.APP_URL
              ? process.env.APP_URL + "/payment-callback.html"
              : undefined),
          metadata: {
            order_code: order.order_code,
            customer_id: user.id
          }
        })
      }
    );

    const payment = await paystackResponse.json();

    if (!paystackResponse.ok || !payment.status ||
        !payment.data?.authorization_url) {
      await pool.query(
        `UPDATE store_orders SET order_status='Payment Initialization Failed'
         WHERE id=$1 AND payment_status='Pending'`,
        [order.id]
      );

      return res.status(502).json({
        error: payment.message || "Could not start Paystack checkout."
      });
    }

    res.json({
      order_code: order.order_code,
      reference,
      authorization_url: payment.data.authorization_url,
      amount_ghs: total.toFixed(2)
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Checkout:", error.message);
    res.status(400).json({ error: error.message || "Checkout failed." });
  } finally {
    client.release();
  }
});

// VERIFY PAYMENT WITH PAYSTACK

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

  if (!response.ok || !data.status) {
    throw new Error(data.message || "Payment verification failed.");
  }

  if (data.data.status !== "success" ||
      data.data.currency !== "GHS") {
    throw new Error("Payment has not been confirmed.");
  }

  return data.data;
}

async function markOrderPaid(reference) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT * FROM store_orders
       WHERE payment_reference=$1 FOR UPDATE`,
      [reference]
    );

    const order = result.rows[0];

    if (!order) throw new Error("Order not found.");

    if (order.payment_status === "Paid") {
      await client.query("COMMIT");
      return order;
    }

    const payment = await verifyPaystack(reference);

    if (Number(payment.amount) !== Math.round(Number(order.amount_ghs) * 100)) {
      throw new Error("Payment amount does not match order.");
    }

    const items = await client.query(
      "SELECT * FROM store_order_items WHERE order_id=$1",
      [order.id]
    );

    for (const item of items.rows) {
      const stockUpdate = await client.query(
        `UPDATE store_products SET stock=stock-$1
         WHERE id=$2 AND stock >= $1 RETURNING id`,
        [item.quantity, item.product_id]
      );

      if (!stockUpdate.rows.length) {
        throw new Error("Insufficient stock while confirming payment.");
      }
    }

    await client.query(
      `UPDATE store_orders
       SET payment_status='Paid',order_status='Processing'
       WHERE id=$1`,
      [order.id]
    );

    await client.query("COMMIT");
    return order;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/api/payment/verify/:reference", customerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id FROM store_orders
       WHERE payment_reference=$1 AND user_id=$2`,
      [req.params.reference, req.user.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Order not found." });
    }

    await markOrderPaid(req.params.reference);

    res.json({ success: true, payment_status: "Paid" });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// CUSTOMER ORDER HISTORY

app.get("/api/my-orders", customerAuth, async (req, res) => {
  try {
    const orders = await pool.query(
      `SELECT * FROM store_orders
       WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.user.userId]
    );

    for (const order of orders.rows) {
      const items = await pool.query(
        `SELECT product_name,quantity,unit_price
         FROM store_order_items WHERE order_id=$1`,
        [order.id]
      );

      order.items = items.rows;
    }

    res.json({ orders: orders.rows });
  } catch (error) {
    res.status(500).json({ error: "Could not load order history." });
  }
});

// ADMIN: VIEW ALL ORDERS

app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const orders = await pool.query(
      `SELECT * FROM store_orders ORDER BY created_at DESC`
    );

    for (const order of orders.rows) {
      const items = await pool.query(
        `SELECT product_name,quantity,unit_price
         FROM store_order_items WHERE order_id=$1`,
        [order.id]
      );

      order.items = items.rows;
    }

    res.json({ orders: orders.rows });
  } catch (error) {
    res.status(500).json({ error: "Could not load orders." });
  }
});

// ADMIN: UPDATE ORDER STATUS

app.patch("/api/admin/orders/:id", adminAuth, async (req, res) => {
  try {
    const allowed = [
      "Processing",
      "Ready for Delivery",
      "Shipped",
      "Completed",
      "Cancelled"
    ];

    const status = req.body.order_status;

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid order status." });
    }

    const result = await pool.query(
      `UPDATE store_orders SET order_status=$1
       WHERE id=$2 AND payment_status='Paid'
       RETURNING *`,
      [status, req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Paid order not found."
      });
    }

    res.json({ order: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Could not update order." });
  }
});

// HEALTH CHECK

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", app: "TIKGROW Online Store" });
});

// START SERVER

async function start() {
  requiredEnvironment();
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log("TIKGROW Online Store running on port " + PORT);
  });
}

app.use((error, req, res, next) => {
  console.error(error.message);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: "Image is too large or invalid." });
  }

  res.status(500).json({ error: error.message || "Server error." });
});

start().catch(error => {
  console.error("SERVER STARTUP FAILED:", error);
  process.exit(1);
});

