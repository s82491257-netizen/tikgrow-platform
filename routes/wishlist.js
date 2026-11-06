
const express = require("express");
const { pool } = require("../db");
const { requireLogin } = require("../middleware/auth");

const router = express.Router();

router.use(requireLogin);

// VIEW WISHLIST
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         w.id AS wishlist_id,
         p.id AS product_id,
         p.name,
         p.slug,
         p.description,
         p.price,
         p.currency,
         p.stock,
         (
           SELECT pi.image_url
           FROM product_images pi
           WHERE pi.product_id = p.id
           ORDER BY pi.id ASC
           LIMIT 1
         ) AS image_url
       FROM wishlist_items w
       JOIN products p ON p.id = w.product_id
       WHERE w.user_id = $1
         AND p.is_active = TRUE
       ORDER BY w.created_at DESC`,
      [req.session.user.id]
    );

    return res.json({
      success: true,
      wishlist: result.rows
    });

  } catch (error) {
    console.error("Wishlist error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load wishlist."
    });
  }
});

// ADD PRODUCT TO WISHLIST
router.post("/add", async (req, res) => {
  try {
    const productId = Number(req.body?.productId);

    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    const product = await pool.query(
      `SELECT id
       FROM products
       WHERE id = $1 AND is_active = TRUE`,
      [productId]
    );

    if (product.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    await pool.query(
      `INSERT INTO wishlist_items (user_id, product_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [req.session.user.id, productId]
    );

    return res.json({
      success: true,
      message: "Product saved to wishlist."
    });

  } catch (error) {
    console.error("Add wishlist error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to save product."
    });
  }
});

// REMOVE PRODUCT FROM WISHLIST
router.delete("/:productId", async (req, res) => {
  try {
    const productId = Number(req.params.productId);

    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    const result = await pool.query(
      `DELETE FROM wishlist_items
       WHERE user_id = $1 AND product_id = $2
       RETURNING id`,
      [req.session.user.id, productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found in wishlist."
      });
    }

    return res.json({
      success: true,
      message: "Product removed from wishlist."
    });

  } catch (error) {
    console.error("Remove wishlist error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to remove product."
    });
  }
});

module.exports = router;
