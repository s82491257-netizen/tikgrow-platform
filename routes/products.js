
const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// GET ALL ACTIVE PRODUCTS
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(40, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const offset = (page - 1) * limit;

    const search = String(req.query.search || "").trim().slice(0, 100);
    const category = String(req.query.category || "").trim().slice(0, 80);

    const conditions = ["p.is_active = TRUE"];
    const values = [];

    if (search) {
      values.push(`%${search}%`);
      conditions.push(
        `(p.name ILIKE $${values.length} OR p.description ILIKE $${values.length})`
      );
    }

    if (category) {
      values.push(category);
      conditions.push(`c.slug = $${values.length}`);
    }

    const where = conditions.join(" AND ");

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where}`,
      values
    );

    const productsResult = await pool.query(
      `SELECT
         p.id,
         p.name,
         p.slug,
         p.description,
         p.price,
         p.stock,
         p.currency,
         p.created_at,
         c.name AS category_name,
         c.slug AS category_slug,
         (
           SELECT pi.image_url
           FROM product_images pi
           WHERE pi.product_id = p.id
           ORDER BY pi.id ASC
           LIMIT 1
         ) AS image_url
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${values.length + 1}
       OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    return res.json({
      success: true,
      page,
      limit,
      total: countResult.rows[0].total,
      totalPages: Math.ceil(countResult.rows[0].total / limit),
      products: productsResult.rows
    });

  } catch (error) {
    console.error("Products error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load products."
    });
  }
});

// GET SINGLE PRODUCT
router.get("/:id", async (req, res) => {
  try {
    const productId = Number(req.params.id);

    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    const result = await pool.query(
      `SELECT
         p.id,
         p.name,
         p.slug,
         p.description,
         p.price,
         p.stock,
         p.currency,
         c.name AS category_name,
         c.slug AS category_slug
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1 AND p.is_active = TRUE
       LIMIT 1`,
      [productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    const images = await pool.query(
      `SELECT image_url, alt_text
       FROM product_images
       WHERE product_id = $1
       ORDER BY id ASC`,
      [productId]
    );

    return res.json({
      success: true,
      product: {
        ...result.rows[0],
        images: images.rows
      }
    });

  } catch (error) {
    console.error("Product detail error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load product."
    });
  }
});

// GET PRODUCT CATEGORIES
router.get("/categories/list", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, description
       FROM categories
       WHERE is_active = TRUE
       ORDER BY name ASC`
    );

    return res.json({
      success: true,
      categories: result.rows
    });

  } catch (error) {
    console.error("Categories error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load categories."
    });
  }
});

module.exports = router;
