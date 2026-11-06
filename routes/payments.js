
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

router.use(requireLogin);

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET_KEY) {
  console.error("PAYSTACK_SECRET_KEY is missing.");
}

// INITIALIZE PAYSTACK PAYMENT
router.post("/initialize", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        success: false,
        message: "Payment service is not configured."
      });
    }

    const userId = req.session.user.id;
    const email = req.session.user.email;

    const client = await pool.connect();

    let order;

    try {
      await client.query("BEGIN");

      const cart = await client.query(
        `SELECT
           ci.product_id,
           ci.quantity,
           p.name,
           p.price,
           p.stock,
           p.is_active
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
         WHERE ci.user_id = $1
         FOR UPDATE OF ci, p`,
        [userId]
      );

      if (cart.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "Your cart is empty."
        });
      }

      for (const item of cart.rows) {
        if (!item.is_active || item.quantity > item.stock) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${item.name}.`
          });
        }
      }

      const total = cart.rows.reduce(
        (sum, item) =>
          sum + Math.round(Number(item.price) * 100) * item.quantity,
        0
      );

      if (!Number.isSafeInteger(total) || total < 1) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "Invalid order amount."
        });
      }

      const orderNumber =
        "SCH-" + crypto.randomBytes(8).toString("hex").toUpperCase();

      const orderResult = await client.query(
        `INSERT INTO orders
         (user_id, order_number, status, total_amount, currency, payment_status)
         VALUES ($1, $2, 'pending', $3, 'GHS', 'pending')
         RETURNING id, order_number, total_amount, currency`,
        [userId, orderNumber, total / 100]
      );

      order = orderResult.rows[0];

      for (const item of cart.rows) {
        await client.query(
          `INSERT INTO order_items
           (order_id, product_id, product_name, quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            order.id,
            item.product_id,
            item.name,
            item.quantity,
            item.price,
            Number(item.price) * item.quantity
          ]
        );
      }

      await client.query("COMMIT");

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const reference = "SCHPAY-" + crypto.randomBytes(16).toString("hex");

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          amount: Math.round(Number(order.total_amount) * 100),
          currency: "GHS",
          reference,
          metadata: {
            user_id: userId,
            order_id: order.id,
            order_number: order.order_number
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status || !data.data?.authorization_url) {
      await pool.query(
        `UPDATE orders
         SET status = 'payment_failed',
             payment_status = 'failed'
         WHERE id = $1 AND user_id = $2`,
        [order.id, userId]
      );

      return res.status(502).json({
        success: false,
        message: "Unable to initialize payment. Please try again."
      });
    }

    return res.json({
      success: true,
      message: "Payment initialized.",
      authorization_url: data.data.authorization_url,
      reference,
      order_number: order.order_number
    });

  } catch (error) {
    console.error("Payment initialization error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Payment initialization failed."
    });
  }
});

// VERIFY PAYMENT WITH PAYSTACK
router.get("/verify/:reference", async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        success: false,
        message: "Payment service is not configured."
      });
    }

    const reference = String(req.params.reference || "");

    if (!/^SCHPAY-[a-f0-9]{32}$/.test(reference)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment reference."
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status || !data.data) {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed."
      });
    }

    const transaction = data.data;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const paymentResult = await client.query(
        `SELECT
           p.id,
           p.order_id,
           p.amount,
           p.currency,
           p.status,
           o.user_id,
           o.total_amount,
           o.payment_status
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.reference = $1
         FOR UPDATE OF p, o`,
        [reference]
      );

      if (paymentResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Payment record not found."
        });
      }

      const payment = paymentResult.rows[0];

      if (String(payment.user_id) !== String(req.session.user.id)) {
        await client.query("ROLLBACK");

        return res.status(403).json({
          success: false,
          message: "This payment does not belong to your account."
        });
      }

      const validPayment =
        transaction.status === "success" &&
        transaction.reference === reference &&
        transaction.currency === payment.currency &&
        Number(transaction.amount) ===
          Math.round(Number(payment.amount) * 100) &&
        Number(payment.amount) === Number(payment.total_amount);

      if (!validPayment) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "Payment could not be verified."
        });
      }

      await client.query(
        `UPDATE payments
         SET status = 'success'
         WHERE id = $1`,
        [payment.id]
      );

      await client.query(
        `UPDATE orders
         SET payment_status = 'paid',
             status = 'processing',
             updated_at = NOW()
         WHERE id = $1`,
        [payment.order_id]
      );

      await client.query(
        "DELETE FROM cart_items WHERE user_id = $1",
        [req.session.user.id]
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Payment verified successfully.",
        order_id: payment.order_id
      });

    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error("Payment verification error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to verify payment."
    });
  }
});

module.exports = router;
