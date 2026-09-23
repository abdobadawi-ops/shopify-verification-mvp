const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;

// ==========================================
// Middleware
// ==========================================

app.use(express.json());

// ==========================================
// Serve frontend files
// ==========================================

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ==========================================
// Shopify Configuration
// ==========================================

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const SHOPIFY_API_VERSION = "2026-07";

if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing Shopify environment variables.");
  process.exit(1);
}

// ==========================================
// Neon Database
// ==========================================

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL environment variable.");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ==========================================
// Shopify Access Token
// ==========================================

let accessToken = null;
let tokenExpiresAt = 0;

async function getShopifyAccessToken() {
  // Reuse existing token if still valid
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken;
  }

  console.log("Requesting new Shopify access token...");

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },

      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Shopify token request failed: ${response.status} ${errorText}`,
    );
  }

  const data = await response.json();

  accessToken = data.access_token;

  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  console.log("Shopify access token received.");

  return accessToken;
}

// ==========================================
// Shopify GraphQL Helper
// ==========================================

async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },

      body: JSON.stringify({
        query,
        variables,
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Shopify API request failed: ${response.status} ${errorText}`,
    );
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(JSON.stringify(result.errors));
  }

  return result.data;
}

// ==========================================
// Test Shopify Connection
// ==========================================

app.get("/api/test-shopify", async (req, res) => {
  try {
    const query = `
      {
        shop {
          name
          myshopifyDomain
        }
      }
    `;

    const data = await shopifyGraphQL(query);

    res.json({
      success: true,
      shop: data.shop,
    });
  } catch (error) {
    console.error("SHOPIFY TEST ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// Test Neon Connection
// ==========================================

app.get("/api/test-database", async (req, res) => {
  try {
    const result = await sql`
      SELECT NOW() AS current_time
    `;

    res.json({
      success: true,
      database: "connected",
      time: result[0].current_time,
    });
  } catch (error) {
    console.error("DATABASE TEST ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
// ==========================================
// Get Verification State(s)
// ==========================================
//
// GET /api/verification
//      -> Returns ALL verification records
//
// GET /api/verification?orderId=gid%3A%2F%2Fshopify%2FOrder%2F123
//      -> Returns verification for ONE order
//
// ==========================================

app.get("/api/verification", async (req, res) => {
  try {
    const orderId = req.query.orderId;

    // ==========================================
    // Get ONE order
    // ==========================================

    if (orderId) {
      const normalizedOrderId = String(orderId).trim();

      console.log("GET VERIFICATION FOR ORDER:", normalizedOrderId);

      const result = await sql`
        SELECT
          order_id,
          order_number,
          verification_data,
          created_at,
          updated_at
        FROM order_verifications
        WHERE order_id = ${normalizedOrderId}
        LIMIT 1
      `;

      if (result.length === 0) {
        console.log("NO VERIFICATION FOUND FOR:", normalizedOrderId);

        return res.json({
          success: true,
          exists: false,
          found: false,
          verification: null,
        });
      }

      console.log("VERIFICATION FOUND FOR:", normalizedOrderId);

      return res.json({
        success: true,
        exists: true,
        found: true,
        verification: result[0],
      });
    }

    // ==========================================
    // Get ALL verification records
    // ==========================================

    console.log("GETTING ALL VERIFICATION RECORDS...");

    const result = await sql`
      SELECT
        order_id,
        order_number,
        verification_data,
        created_at,
        updated_at
      FROM order_verifications
      ORDER BY updated_at DESC
    `;

    console.log(`FOUND ${result.length} VERIFICATION RECORDS`);

    return res.json({
      success: true,
      count: result.length,
      verifications: result,
    });
  } catch (error) {
    console.error("GET VERIFICATION ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// Save Verification State
// ==========================================
//
// POST /api/verification
//
// Body:
//
// {
//   "orderId": "gid://shopify/Order/7293265215582",
//   "orderNumber": "#48543",
//   "verificationData": {
//      ...
//   }
// }
//
// ==========================================

app.post("/api/verification", async (req, res) => {
  try {
    const { orderId, orderNumber, verificationData } = req.body;

    // ------------------------------------------
    // Validate Order ID
    // ------------------------------------------

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: "orderId is required.",
      });
    }

    // ------------------------------------------
    // Validate Order Number
    // ------------------------------------------

    if (!orderNumber) {
      return res.status(400).json({
        success: false,
        error: "orderNumber is required.",
      });
    }

    // ------------------------------------------
    // Validate Verification Data
    // ------------------------------------------

    if (verificationData === undefined || verificationData === null) {
      return res.status(400).json({
        success: false,
        error: "verificationData is required.",
      });
    }

    console.log("SAVE VERIFICATION");
    console.log("Order ID:", orderId);
    console.log("Order Number:", orderNumber);

    // ------------------------------------------
    // Insert / Update
    // ------------------------------------------

    const result = await sql`
      INSERT INTO order_verifications (
        order_id,
        order_number,
        verification_data,
        updated_at
      )
      VALUES (
        ${orderId},
        ${orderNumber},
        ${JSON.stringify(verificationData)}::jsonb,
        NOW()
      )

      ON CONFLICT (order_id)

      DO UPDATE SET
        order_number = EXCLUDED.order_number,
        verification_data = EXCLUDED.verification_data,
        updated_at = NOW()

      RETURNING
        order_id,
        order_number,
        verification_data,
        created_at,
        updated_at
    `;

    return res.json({
      success: true,
      verification: result[0],
    });
  } catch (error) {
    console.error("SAVE VERIFICATION ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ==========================================
// Delete Verification State
// ==========================================
//
// DELETE:
// /api/verification/gid://shopify/Order/7293265215582
//
// ==========================================

app.delete("/api/verification", async (req, res) => {
  try {
    const orderId = req.query.orderId;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: "Order ID is required.",
      });
    }

    console.log("DELETE VERIFICATION FOR ORDER:", orderId);

    await sql`
      DELETE FROM order_verifications
      WHERE order_id = ${orderId}
    `;

    return res.json({
      success: true,
    });
  } catch (error) {
    console.error("DELETE VERIFICATION ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});
// ==========================================
// Get Valid Unfulfilled Orders
// ==========================================

app.get("/api/orders", async (req, res) => {
  try {
    let allOrders = [];

    let cursor = null;

    let hasNextPage = true;

    console.log("Fetching Shopify unfulfilled orders...");

    // ==========================================
    // Pagination
    // ==========================================

    while (hasNextPage) {
      const query = `
        query GetUnfulfilledOrders($cursor: String) {
          orders(
            first: 250
            after: $cursor
            query: "fulfillment_status:unfulfilled"
            sortKey: CREATED_AT
            reverse: true
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }

            edges {
              node {
                id
                name

                displayFulfillmentStatus
                displayFinancialStatus

                cancelledAt
                returnStatus

                lineItems(first: 250) {
                  edges {
                    node {
                      id
                      name
                      quantity

                      variant {
                        id
                        barcode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const data = await shopifyGraphQL(query, {
        cursor,
      });

      const ordersData = data.orders;

      // Add this page's orders
      allOrders.push(...ordersData.edges.map((edge) => edge.node));

      hasNextPage = ordersData.pageInfo.hasNextPage;

      cursor = ordersData.pageInfo.endCursor;

      console.log(
        `Fetched ${ordersData.edges.length} orders. Total so far: ${allOrders.length}`,
      );
    }

    console.log(`Total Shopify unfulfilled orders: ${allOrders.length}`);

    // ==========================================
    // Filter Invalid Orders
    // ==========================================

    const validOrders = allOrders.filter((order) => {
      // ------------------------------------------
      // 1. Cancelled Orders
      // ------------------------------------------

      if (order.cancelledAt) {
        console.log(
          `Excluded ${order.name}: cancelled at ${order.cancelledAt}`,
        );

        return false;
      }

      // ------------------------------------------
      // 2. Refunded / Voided Orders
      // ------------------------------------------

      if (
        order.displayFinancialStatus === "REFUNDED" ||
        order.displayFinancialStatus === "VOIDED"
      ) {
        console.log(
          `Excluded ${order.name}: financial status ${order.displayFinancialStatus}`,
        );

        return false;
      }

      // ------------------------------------------
      // 3. Returned Orders
      // ------------------------------------------

      if (order.returnStatus === "RETURNED") {
        console.log(
          `Excluded ${order.name}: return status ${order.returnStatus}`,
        );

        return false;
      }

      // ------------------------------------------
      // 4. Only Keep Truly Unfulfilled Orders
      // ------------------------------------------

      if (order.displayFulfillmentStatus !== "UNFULFILLED") {
        console.log(
          `Excluded ${order.name}: fulfillment status ${order.displayFulfillmentStatus}`,
        );

        return false;
      }

      return true;
    });

    console.log(`Valid orders after filtering: ${validOrders.length}`);

    // ==========================================
    // Return Clean Response
    // ==========================================

    return res.json({
      success: true,
      count: validOrders.length,
      orders: validOrders,
    });
  } catch (error) {
    console.error("ORDERS ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

// ==========================================
// Start Server
// ==========================================

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
