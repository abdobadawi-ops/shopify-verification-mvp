const express = require("express");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const app = express();

app.use(express.json());

// ==========================================
// Serve Frontend Files
// ==========================================

app.use(express.static(path.join(__dirname, "..")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
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
}

// ==========================================
// Shopify Access Token
// ==========================================

let accessToken = null;
let tokenExpiresAt = 0;

async function getShopifyAccessToken() {
  // Reuse existing token if it is still valid.
  //
  // The 60-second buffer prevents us from using a token
  // that is about to expire.

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

      // Add this page's orders.
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

    res.json({
      success: true,
      count: validOrders.length,
      orders: validOrders,
    });
  } catch (error) {
    console.error("ORDERS ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

// ==========================================
// Vercel Export
// ==========================================
//
// Vercel runs this Express application as a
// serverless function.
//
// DO NOT use app.listen() here.

module.exports = app;
