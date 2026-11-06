
const express = require("express");
const { pool } = require("../db");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

router.use(requireLogin);

// VIEW CUSTOMER CART
router.get("/", async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(
      `SELECT
         ci.id,
         ci.product_id,
         ci.quantity,
         p.name,
         p.price,
         p.currency,
         p.stock,
         p.is_active,
         (
           SELECT pi.image_url
           FROM product_images pi
           WHERE pi.product_id = p.id
           ORDER BY pi.id ASC
           LIMIT 1
         ) AS image_url
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = $1
       ORDER BY ci.id DESC`,
      [userId]
    );

    const items = result.rows.map(item => ({
      ...item,
      subtotal: Number(item.price) * item.quantity
    }));

    const total = items.reduce(
      (sum, item) => sum + item.subtotal,
      0
    );

    return res.json({
      success: true,
      items,
      total,
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0)
    });

  } catch (error) {
    console.error("Cart error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load your cart."
    });
  }
});

// ADD PRODUCT TO CART
router.post("/add", async (req, res) => {
  const productId = Number(req.body?.productId);
  const quantity = Number(req.body?.quantity || 1);

  if (
    !Number.isSafeInteger(productId) ||
    productId < 1 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid product or quantity."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const product = await client.query(
      `SELECT id, stock, is_active
       FROM products
       WHERE id = $1
       FOR UPDATE`,
      [productId]
    );

    if (
      product.rows.length === 0 ||
      !product.rows[0].is_active
    ) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Product is unavailable."
      });
    }

    const existing = await client.query(
      `SELECT quantity
       FROM cart_items
       WHERE user_id = $1 AND product_id = $2
       FOR UPDATE`,
      [req.session.user.id, productId]
    );

    const newQuantity =
      quantity + (existing.rows[0]?.quantity || 0);

    if (newQuantity > product.rows[0].stock) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        success: false,
        message: "Requested quantity exceeds available stock."
      });
    }

    await client.query(
      `INSERT INTO cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [req.session.user.id, productId, newQuantity]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Product added to cart."
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Add cart error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to add product to cart."
    });

  } finally {
    client.release();
  }
});

// UPDATE CART QUANTITY
router.put("/:id", async (req, res) => {
  const cartItemId = Number(req.params.id);
  const quantity = Number(req.body?.quantity);

  if (
    !Number.isSafeInteger(cartItemId) ||
    cartItemId < 1 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid cart item or quantity."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE cart_items ci
       SET quantity = $1
       FROM products p
       WHERE ci.id = $2
         AND ci.user_id = $3
         AND p.id = ci.product_id
         AND p.is_active = TRUE
         AND p.stock >= $1
       RETURNING ci.id`,
      [quantity, cartItemId, req.session.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Cart item not found or stock is insufficient."
      });
    }

    return res.json({
      success: true,
      message: "Cart updated."
    });

  } catch (error) {
    console.error("Update cart error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to update cart."
    });
  }
});

// REMOVE CART ITEM
router.delete("/:id", async (req, res) => {
  try {
    const cartItemId = Number(req.params.id);

    if (!Number.isSafeInteger(cartItemId) || cartItemId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid cart item."
      });
    }

    const result = await pool.query(
      `DELETE FROM cart_items
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [cartItemId, req.session.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found."
      });
    }

    return res.json({
      success: true,
      message: "Product removed from cart."
    });

  } catch (error) {
    console.error("Remove cart error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to remove cart item."
    });
  }
});

// CLEAR CART
router.delete("/", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM cart_items WHERE user_id = $1",
      [req.session.user.id]
    );

    return res.json({
      success: true,
      message: "Cart cleared."
    });

  } catch (error) {
    console.error("Clear cart error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to clear cart."
    });
  }
});

module.exports = router;
