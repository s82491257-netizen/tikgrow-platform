
const express = require("express");
const { pool } = require("../db");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

// ADMIN ACCESS ONLY
router.use(requireRole("admin"));

// ADMIN OVERVIEW
router.get("/dashboard", async (req, res) => {
  try {
    const [users, products, orders, sales, applications] =
      await Promise.all([
        pool.query("SELECT COUNT(*)::int AS total FROM users"),
        pool.query("SELECT COUNT(*)::int AS total FROM products"),
        pool.query("SELECT COUNT(*)::int AS total FROM orders"),
        pool.query(
          `SELECT COALESCE(SUM(total_amount), 0) AS total
           FROM orders WHERE payment_status = 'paid'`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total
           FROM reseller_applications WHERE status = 'pending'`
        )
      ]);

    return res.json({
      success: true,
      dashboard: {
        totalUsers: users.rows[0].total,
        totalProducts: products.rows[0].total,
        totalOrders: orders.rows[0].total,
        paidSalesGHS: sales.rows[0].total,
        pendingResellerApplications: applications.rows[0].total
      }
    });

  } catch (error) {
    console.error("Admin dashboard error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load admin dashboard."
    });
  }
});

// LIST PRODUCTS
router.get("/products", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY p.created_at DESC
       LIMIT 200`
    );

    return res.json({
      success: true,
      products: result.rows
    });

  } catch (error) {
    console.error("Admin products error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load products."
    });
  }
});

// ADD PRODUCT
router.post("/products", async (req, res) => {
  try {
    const {
      name,
      description,
      categoryId,
      price,
      stock,
      currency
    } = req.body || {};

    const amount = Number(price);
    const quantity = Number(stock);

    if (
      !name ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0 ||
      !Number.isSafeInteger(Number(categoryId)) ||
      Number(categoryId) < 1
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter valid product information."
      });
    }

    const result = await pool.query(
      `INSERT INTO products
       (name, slug, description, category_id, price, stock, currency, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING *`,
      [
        String(name).trim().slice(0, 150),
        `${Date.now()}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`,
        String(description || "").trim().slice(0, 5000),
        Number(categoryId),
        amount,
        quantity,
        currency === "USD" ? "USD" : "GHS"
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Product created.",
      product: result.rows[0]
    });

  } catch (error) {
    console.error("Add product error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create product."
    });
  }
});

// UPDATE PRODUCT
router.put("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    const { name, description, price, stock, isActive } = req.body || {};

    if (
      (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) ||
      (stock !== undefined && (!Number.isSafeInteger(Number(stock)) || Number(stock) < 0)) ||
      (isActive !== undefined && typeof isActive !== "boolean")
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid product values."
      });
    }

    const result = await pool.query(
      `UPDATE products
       SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         price = COALESCE($3, price),
         stock = COALESCE($4, stock),
         is_active = COALESCE($5, is_active)
       WHERE id = $6
       RETURNING *`,
      [
        name === undefined ? null : String(name).trim().slice(0, 150),
        description === undefined ? null : String(description).trim().slice(0, 5000),
        price === undefined ? null : Number(price),
        stock === undefined ? null : Number(stock),
        isActive === undefined ? null : isActive,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    return res.json({
      success: true,
      product: result.rows[0]
    });

  } catch (error) {
    console.error("Update product error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to update product."
    });
  }
});

// DELETE PRODUCT
router.delete("/products/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    const result = await pool.query(
      `UPDATE products
       SET is_active = FALSE
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    return res.json({
      success: true,
      message: "Product hidden from storefront."
    });

  } catch (error) {
    console.error("Delete product error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to remove product."
    });
  }
});

// VIEW RESELLER APPLICATIONS
router.get("/resellers/applications", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         a.id,
         a.user_id,
         a.phone,
         a.business_name,
         a.reason,
         a.status,
         a.created_at,
         u.name,
         u.email
       FROM reseller_applications a
       JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT 200`
    );

    return res.json({
      success: true,
      applications: result.rows
    });

  } catch (error) {
    console.error("Reseller applications error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load applications."
    });
  }
});

// APPROVE OR REJECT RESELLER
router.patch("/resellers/applications/:id", async (req, res) => {
  const applicationId = Number(req.params.id);
  const status = req.body?.status;

  if (
    !Number.isSafeInteger(applicationId) ||
    applicationId < 1 ||
    !["approved", "rejected"].includes(status)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid application or decision."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT user_id, status
       FROM reseller_applications
       WHERE id = $1
       FOR UPDATE`,
      [applicationId]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Application not found."
      });
    }

    const application = result.rows[0];

    if (application.status !== "pending") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "This application has already been reviewed."
      });
    }

    await client.query(
      `UPDATE reseller_applications
       SET status = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [status, applicationId]
    );

    if (status === "approved") {
      await client.query(
        "UPDATE users SET role = 'reseller' WHERE id = $1",
        [application.user_id]
      );

      await client.query(
        `INSERT INTO reseller_wallets (user_id, balance, currency)
         VALUES ($1, 0, 'GHS')
         ON CONFLICT (user_id) DO NOTHING`,
        [application.user_id]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: `Reseller application ${status}.`
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Reseller approval error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to review application."
    });

  } finally {
    client.release();
  }
});

// VIEW ALL ORDERS
router.get("/orders", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         o.*,
         u.name AS customer_name,
         u.email AS customer_email
       FROM orders o
       JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC
       LIMIT 200`
    );

    return res.json({
      success: true,
      orders: result.rows
    });

  } catch (error) {
    console.error("Admin orders error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load orders."
    });
  }
});

// UPDATE ORDER STATUS
router.patch("/orders/:id/status", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = req.body?.status;

    const allowedStatuses = [
      "pending",
      "processing",
      "shipped",
      "delivered",
      "cancelled"
    ];

    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !allowedStatuses.includes(status)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid order or status."
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND payment_status = 'paid'
       RETURNING id, order_number, status`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Paid order not found."
      });
    }

    return res.json({
      success: true,
      order: result.rows[0]
    });

  } catch (error) {
    console.error("Order status error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to update order."
    });
  }
});

module.exports = router;
