
const express = require("express");
const { pool } = require("../db");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

// PUBLIC: VIEW AVAILABLE DATA BUNDLES
router.get("/bundles", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         network,
         name,
         data_size,
         validity,
         price,
         currency,
         reseller_price
       FROM data_bundles
       WHERE is_active = TRUE
       ORDER BY network ASC, price ASC`
    );

    return res.json({
      success: true,
      bundles: result.rows
    });

  } catch (error) {
    console.error("Data bundles error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load data bundles."
    });
  }
});

// CUSTOMER: ORDER A DATA BUNDLE
router.post("/order", requireLogin, async (req, res) => {
  const bundleId = Number(req.body?.bundleId);
  const phone = String(req.body?.phone || "").trim();

  if (
    !Number.isSafeInteger(bundleId) ||
    bundleId < 1 ||
    !/^(0\d{9}|\+233\d{9})$/.test(phone)
  ) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid bundle and Ghana phone number."
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, network, name, data_size, price, currency
       FROM data_bundles
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [bundleId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Data bundle is unavailable."
      });
    }

    // This creates a pending request only.
    // It does not claim that data has been delivered.
    const bundle = result.rows[0];

    const order = await pool.query(
      `INSERT INTO data_orders
       (user_id, bundle_id, network, bundle_name, phone, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id, network, bundle_name, phone, amount, currency, status, created_at`,
      [
        req.session.user.id,
        bundle.id,
        bundle.network,
        bundle.name,
        phone,
        bundle.price,
        bundle.currency
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Data order request created. Payment and delivery are not yet confirmed.",
      order: order.rows[0]
    });

  } catch (error) {
    console.error("Data order error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create data order."
    });
  }
});

// CUSTOMER: VIEW DATA ORDER HISTORY
router.get("/my-orders", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         network,
         bundle_name,
         phone,
         amount,
         currency,
         status,
         created_at
       FROM data_orders
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.session.user.id]
    );

    return res.json({
      success: true,
      orders: result.rows
    });

  } catch (error) {
    console.error("Data order history error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load data order history."
    });
  }
});

module.exports = router;
