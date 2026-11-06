
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

const PAYSTACK_URL = "https://api.paystack.co";

function getPaystackKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;

  if (!key || !key.startsWith("sk_")) {
    throw new Error("Paystack is not configured.");
  }

  return key;
}

// START CHECKOUT AND INITIALIZE PAYSTACK
router.post("/", async (req, res) => {
  const { delivery, payment_method } = req.body;

  if (
    !delivery ||
    !delivery.full_name ||
    !delivery.phone ||
    !delivery.address ||
    !delivery.region
  ) {
    return res.status(400).json({
      success: false,
      message: "Complete all delivery information."
    });
  }

  if (!["mobile_money", "card"].includes(payment_method)) {
    return res.status(400).json({
      success: false,
      message: "Invalid payment method."
    });
  }

  const client = await pool.connect();
  let reference;

  try {
    const secret = getPaystackKey();

    await client.query("BEGIN");

    const userResult = await client.query(
      `SELECT id, email
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [req.user.id]
    );

    if (!userResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(401).json({
        success: false,
        message: "Account not found."
      });
    }

    const user = userResult.rows[0];

    const cartResult = await client.query(
      `SELECT
         ci.product_id,
         ci.quantity,
         p.name,
         p.price,
         p.stock,
         p.is_active
       FROM carts c
       JOIN cart_items ci ON ci.cart_id = c.id
       JOIN products p ON p.id = ci.product_id
       WHERE c.user_id = $1
       FOR UPDATE OF ci, p`,
      [req.user.id]
    );

    if (!cartResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Your shopping cart is empty."
      });
    }

    let total = 0;

    for (const item of cartResult.rows) {
      if (
        !item.is_active ||
        Number(item.stock) < Number(item.quantity)
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "A product is unavailable or has insufficient stock."
        });
      }

      total += Number(item.price) * Number(item.quantity);
    }

    const amountPesewas = Math.round(total * 100);

    if (!Number.isSafeInteger(amountPesewas) || amountPesewas < 1) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid order amount."
      });
    }

    reference = "SAVCEL-" + crypto.randomUUID();

    const orderNumber = "SC-" +
      Date.now() + "-" +
      crypto.randomBytes(3).toString("hex").toUpperCase();

    const deliveryAddress =
      delivery.address.trim() + ", " +
      delivery.region.trim() + ", Ghana";

    const orderResult = await client.query(
      `INSERT INTO orders (
        user_id,
        order_number,
        total_amount,
        status,
        delivery_name,
        delivery_phone,
        delivery_address
      )
      VALUES ($1,$2,$3,'pending',$4,$5,$6)
      RETURNING id, order_number`,
      [
        req.user.id,
        orderNumber,
        total.toFixed(2),
        delivery.full_name.trim(),
        delivery.phone.trim(),
        deliveryAddress
      ]
    );

    const order = orderResult.rows[0];

    for (const item of cartResult.rows) {
      await client.query(
        `INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          quantity,
          unit_price
        )
        VALUES ($1,$2,$3,$4,$5)`,
        [
          order.id,
          item.product_id,
          item.name,
          item.quantity,
          item.price
        ]
      );
    }

    await client.query(
      `INSERT INTO payments (
        order_id,
        provider,
        reference,
        amount,
        status
      )
      VALUES ($1,'paystack',$2,$3,'pending')`,
      [order.id, reference, total.toFixed(2)]
    );

    await client.query("COMMIT");

    const callbackUrl =
      process.env.PAYSTACK_CALLBACK_URL ||
      "https://tikgrow-platform1.onrender.com/payment/verify";

    const paystackResponse = await fetch(
      PAYSTACK_URL + "/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: user.email,
          amount: amountPesewas,
          currency: "GHS",
          reference,
          callback_url: callbackUrl,
          channels: payment_method === "card"
            ? ["card"]
            : ["mobile_money"]
        })
      }
    );

    const paystackData = await paystackResponse.json();

    if (
      !paystackResponse.ok ||
      !paystackData.status ||
      !paystackData.data ||
      !paystackData.data.authorization_url
    ) {
      throw new Error(
        paystackData.message || "Paystack initialization failed."
      );
    }

    return res.status(201).json({
      success: true,
      message: "Payment initialized.",
      order_number: order.order_number,
      authorization_url: paystackData.data.authorization_url,
      reference
    });

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Checkout error:", error.message);

    if (reference) {
      await pool.query(
        `UPDATE payments
         SET status = 'failed'
         WHERE reference = $1 AND status = 'pending'`,
        [reference]
      ).catch(() => {});

      await pool.query(
        `UPDATE orders
         SET status = 'cancelled'
         WHERE id = (
           SELECT order_id FROM payments WHERE reference = $1
         )
         AND status = 'pending'`,
        [reference]
      ).catch(() => {});
    }

    return res.status(500).json({
      success: false,
      message: "Checkout could not be started. Please try again."
    });

  } finally {
    client.release();
  }
});

// VERIFY PAYMENT DIRECTLY WITH PAYSTACK
router.get("/verify", async (req, res) => {
  const reference = String(req.query.reference || "");

  if (!/^SAVCEL-[a-f0-9-]{36}$/i.test(reference)) {
    return res.status(400).json({
      success: false,
      message: "Invalid payment reference."
    });
  }

  const client = await pool.connect();

  try {
    const secret = getPaystackKey();

    const paymentResult = await client.query(
      `SELECT
         p.id AS payment_id,
         p.order_id,
         p.amount,
         p.status,
         o.user_id,
         o.order_number
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE p.reference = $1
         AND o.user_id = $2
         AND p.provider = 'paystack'`,
      [reference, req.user.id]
    );

    if (!paymentResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Payment record not found."
      });
    }

    const payment = paymentResult.rows[0];

    if (payment.status === "success") {
      return res.json({
        success: true,
        message: "Payment already verified.",
        order_number: payment.order_number
      });
    }

    const verifyResponse = await fetch(
      PAYSTACK_URL + "/transaction/verify/" +
      encodeURIComponent(reference),
      {
        headers: {
          Authorization: "Bearer " + secret
        }
      }
    );

    const verifyData = await verifyResponse.json();
    const transaction = verifyData.data;

    if (
      !verifyResponse.ok ||
      !verifyData.status ||
      !transaction ||
      transaction.status !== "success" ||
      transaction.reference !== reference ||
      transaction.currency !== "GHS" ||
      Number(transaction.amount) !==
        Math.round(Number(payment.amount) * 100)
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment has not been verified successfully."
      });
    }

    await client.query("BEGIN");

    const lockedPayment = await client.query(
      `SELECT status FROM payments
       WHERE id = $1
       FOR UPDATE`,
      [payment.payment_id]
    );

    if (lockedPayment.rows[0].status === "success") {
      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Payment already verified.",
        order_number: payment.order_number
      });
    }

    const items = await client.query(
      `SELECT product_id, quantity
       FROM order_items
       WHERE order_id = $1
       AND product_id IS NOT NULL
       FOR UPDATE`,
      [payment.order_id]
    );

    for (const item of items.rows) {
      const stockUpdate = await client.query(
        `UPDATE products
         SET stock = stock - $1
         WHERE id = $2 AND stock >= $1
         RETURNING id`,
        [item.quantity, item.product_id]
      );

      if (!stockUpdate.rows.length) {
        throw new Error("Insufficient stock to complete this order.");
      }
    }

    await client.query(
      `UPDATE payments
       SET status = 'success', verified_at = NOW()
       WHERE id = $1`,
      [payment.payment_id]
    );

    await client.query(
      `UPDATE orders
       SET status = 'paid'
       WHERE id = $1 AND status = 'pending'`,
      [payment.order_id]
    );

    await client.query(
      `DELETE FROM cart_items
       WHERE cart_id IN (
         SELECT id FROM carts WHERE user_id = $1
       )`,
      [req.user.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Payment verified successfully.",
      order_number: payment.order_number
    });

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Payment verification error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Payment verification could not be completed. Please contact support with your payment reference."
    });

  } finally {
    client.release();
  }
});

module.exports = router;
