
const express = require("express");
const { pool } = require("../db");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

router.use(requireLogin);

// CUSTOMER ORDER HISTORY
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         order_number,
         status,
         total_amount,
         currency,
         payment_status,
         created_at
       FROM orders
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
    console.error("Order history error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load orders."
    });
  }
});

// SINGLE ORDER DETAILS
router.get("/:id", async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID."
      });
    }

    const orderResult = await pool.query(
      `SELECT
         id,
         order_number,
         status,
         total_amount,
         currency,
         payment_status,
         delivery_name,
         delivery_phone,
         delivery_address,
         delivery_city,
         created_at,
         updated_at
       FROM orders
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [orderId, req.session.user.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    const itemsResult = await pool.query(
      `SELECT
         oi.product_id,
         oi.product_name,
         oi.quantity,
         oi.unit_price,
         oi.subtotal
       FROM order_items oi
       WHERE oi.order_id = $1`,
      [orderId]
    );

    return res.json({
      success: true,
      order: orderResult.rows[0],
      items: itemsResult.rows
    });

  } catch (error) {
    console.error("Order details error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load order details."
    });
  }
});

// TRACK ORDER USING ORDER NUMBER
router.get("/track/:orderNumber", async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || "").trim();

    if (!orderNumber || orderNumber.length > 80) {
      return res.status(400).json({
        success: false,
        message: "Invalid order number."
      });
    }

    const result = await pool.query(
      `SELECT
         order_number,
         status,
         payment_status,
         created_at,
         updated_at
       FROM orders
       WHERE order_number = $1 AND user_id = $2
       LIMIT 1`,
      [orderNumber, req.session.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    return res.json({
      success: true,
      tracking: result.rows[0]
    });

  } catch (error) {
    console.error("Order tracking error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to track order."
    });
  }
});

module.exports = router;
