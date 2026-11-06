
const express = require("express");
const { pool } = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// GET CUSTOMER CART
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        ci.id AS cart_item_id,
        p.id AS product_id,
        p.name,
        p.description,
        p.image_url,
        p.price,
        p.stock,
        ci.quantity,
        (p.price * ci.quantity) AS subtotal
       FROM carts c
       JOIN cart_items ci ON ci.cart_id = c.id
       JOIN products p ON p.id = ci.product_id
       WHERE c.user_id = $1
       ORDER BY ci.id DESC`,
      [req.user.id]
    );

    const total = result.rows.reduce(
      (sum, item) => sum + Number(item.subtotal),
      0
    );

    res.json({
      success: true,
      items: result.rows,
      total: total.toFixed(2)
    });
  } catch (error) {
    console.error("Cart loading error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to load your cart."
    });
  }
});

// ADD PRODUCT TO CART
router.post("/items", async (req, res) => {
  const productId = Number(req.body.product_id);
  const quantity = Number(req.body.quantity ?? 1);

  if (
    !Number.isInteger(productId) ||
    productId < 1 ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid product and quantity."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const productResult = await client.query(
      `SELECT id, stock, is_active
       FROM products
       WHERE id = $1
       FOR UPDATE`,
      [productId]
    );

    if (
      !productResult.rows.length ||
      !productResult.rows[0].is_active
    ) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    let cartResult = await client.query(
      "SELECT id FROM carts WHERE user_id = $1",
      [req.user.id]
    );

    if (!cartResult.rows.length) {
      cartResult = await client.query(
        `INSERT INTO carts (user_id)
         VALUES ($1)
         RETURNING id`,
        [req.user.id]
      );
    }

    const cartId = cartResult.rows[0].id;

    const existing = await client.query(
      `SELECT quantity FROM cart_items
       WHERE cart_id = $1 AND product_id = $2`,
      [cartId, productId]
    );

    const currentQuantity = existing.rows.length
      ? Number(existing.rows[0].quantity)
      : 0;

    const newQuantity = currentQuantity + quantity;
    const stock = Number(productResult.rows[0].stock);

    if (newQuantity > stock) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Not enough stock available."
      });
    }

    await client.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cartId, productId, newQuantity]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Product added to your cart."
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Add cart item error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to add product to cart."
    });
  } finally {
    client.release();
  }
});

// UPDATE CART ITEM QUANTITY
router.patch("/items/:id", async (req, res) => {
  const itemId = Number(req.params.id);
  const quantity = Number(req.body.quantity);

  if (
    !Number.isInteger(itemId) ||
    itemId < 1 ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid item or quantity."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE cart_items ci
       SET quantity = $1
       FROM carts c, products p
       WHERE ci.id = $2
         AND ci.cart_id = c.id
         AND ci.product_id = p.id
         AND c.user_id = $3
         AND p.is_active = TRUE
         AND p.stock >= $1
       RETURNING ci.id`,
      [quantity, itemId, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(400).json({
        success: false,
        message: "Item not found or insufficient stock."
      });
    }

    res.json({
      success: true,
      message: "Cart quantity updated."
    });
  } catch (error) {
    console.error("Cart update error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to update cart."
    });
  }
});

// REMOVE CART ITEM
router.delete("/items/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM cart_items ci
       USING carts c
       WHERE ci.id = $1
         AND ci.cart_id = c.id
         AND c.user_id = $2
       RETURNING ci.id`,
      [req.params.id, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found."
      });
    }

    res.json({
      success: true,
      message: "Product removed from cart."
    });
  } catch (error) {
    console.error("Cart removal error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to remove product."
    });
  }
});

// CLEAR CART
router.delete("/", async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM cart_items
       WHERE cart_id IN (
         SELECT id FROM carts WHERE user_id = $1
       )`,
      [req.user.id]
    );

    res.json({
      success: true,
      message: "Cart cleared."
    });
  } catch (error) {
    console.error("Clear cart error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to clear cart."
    });
  }
});

module.exports = router;
