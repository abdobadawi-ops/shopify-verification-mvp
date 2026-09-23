/* ==========================================
   Application State
========================================== */

let orders = [];
let currentOrder = null;
let currentTab = "needs-verification";
let searchTerm = "";

const VERIFICATION_API_BASE = "/api/verification";

/* ==========================================
   DOM Elements
========================================== */

const ordersScreen = document.getElementById("orders-screen");
const verificationScreen = document.getElementById("verification-screen");
const ordersList = document.getElementById("orders-list");
const ordersCount = document.getElementById("orders-count");

const productsList = document.getElementById("products-list");

const verificationOrderNumber = document.getElementById(
  "verification-order-number",
);

const orderStatus = document.getElementById("order-status");

const barcodeInput = document.getElementById("barcode-input");
const scanButton = document.getElementById("scan-button");
const scanMessage = document.getElementById("scan-message");

const manualProduct = document.getElementById("manual-product");
const manualQuantity = document.getElementById("manual-quantity");
const manualButton = document.getElementById("manual-button");
const manualMessage = document.getElementById("manual-message");

const readyMessage = document.getElementById("ready-message");

const backButton = document.getElementById("back-button");

const orderSearch = document.getElementById("order-search");

const needsVerificationTab = document.getElementById("needs-verification-tab");

const readyToFulfillTab = document.getElementById("ready-to-fulfill-tab");

/* ==========================================
   Quantity Functions
========================================== */

function getVerifiedQuantity(item) {
  return (
    (Number(item.barcodeVerifiedQuantity) || 0) +
    (Number(item.manualVerifiedQuantity) || 0)
  );
}

function getRemainingQuantity(item) {
  return Math.max(
    (Number(item.orderedQuantity) || 0) - getVerifiedQuantity(item),
    0,
  );
}

function isItemComplete(item) {
  return getVerifiedQuantity(item) >= (Number(item.orderedQuantity) || 0);
}

function isOrderComplete(order) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    return false;
  }

  return order.items.every(isItemComplete);
}

/* ==========================================
   Neon Verification API
========================================== */

/*
  IMPORTANT:

  Backend routes:

  GET:
    /api/verification?orderId=:orderId

  POST:
    /api/verification

  DELETE:
    /api/verification?orderId=:orderId

  Shopify IDs look like:

    gid://shopify/Order/123456789

  Therefore URLSearchParams / encodeURIComponent
  is used for the query parameter.

  IMPORTANT:
  We DO NOT use:

    /api/verification/:orderId

  because the backend does not expose that route.
*/

/* ==========================================
   Get Server Verification
========================================== */

async function getServerVerification(orderId) {
  if (!orderId) {
    throw new Error("Order ID is required.");
  }

  const url = `${VERIFICATION_API_BASE}?orderId=${encodeURIComponent(orderId)}`;

  console.log("==========================================");
  console.log("GET VERIFICATION");
  console.log("Order ID:", orderId);
  console.log("URL:", url);
  console.log("==========================================");

  const response = await fetch(url, {
    method: "GET",

    headers: {
      Accept: "application/json",
    },

    cache: "no-store",
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Verification API returned ${response.status}: ${responseText}`,
    );
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Verification API returned invalid JSON: ${responseText}`);
  }

  console.log("Verification API response:", result);

  if (!result.success) {
    throw new Error(result.error || "Failed to load verification state.");
  }

  /*
    Backend should return:

    {
      success: true,
      found: true,
      verification: {...}
    }

    OR:

    {
      success: true,
      found: false,
      verification: null
    }
  */

  return result.verification || null;
}

/* ==========================================
   Apply Server Verification State
========================================== */

function applyServerVerification(order, verification) {
  if (!order || !Array.isArray(order.items)) {
    return order;
  }

  /*
    No Neon record.

    Start verification from zero.
  */

  if (!verification) {
    order.items.forEach((item) => {
      item.barcodeVerifiedQuantity = 0;
      item.manualVerifiedQuantity = 0;
    });

    return order;
  }

  /*
    verification_data normally arrives
    as an object from PostgreSQL JSONB.

    Support string JSON as well.
  */

  let verificationData = verification.verification_data;

  if (typeof verificationData === "string") {
    try {
      verificationData = JSON.parse(verificationData);
    } catch (error) {
      console.error("Could not parse verification_data:", error);

      verificationData = null;
    }
  }

  /*
    Support:

    {
      items: [...]
    }
  */

  const savedItems = Array.isArray(verificationData?.items)
    ? verificationData.items
    : [];

  console.log(
    `Applying ${savedItems.length} saved items from Neon to ${order.orderNumber}`,
  );

  /*
    Map saved items by Shopify line item ID.
  */

  const savedItemsMap = new Map();

  savedItems.forEach((savedItem) => {
    if (!savedItem || !savedItem.id) {
      return;
    }

    savedItemsMap.set(String(savedItem.id), savedItem);
  });

  /*
    Apply Neon state to Shopify items.
  */

  order.items.forEach((item) => {
    const savedItem = savedItemsMap.get(String(item.id));

    if (!savedItem) {
      item.barcodeVerifiedQuantity = 0;
      item.manualVerifiedQuantity = 0;

      return;
    }

    item.barcodeVerifiedQuantity =
      Number(savedItem.barcodeVerifiedQuantity) || 0;

    item.manualVerifiedQuantity = Number(savedItem.manualVerifiedQuantity) || 0;

    /*
      Never allow verified quantity
      to exceed Shopify quantity.

      Remove manual verification first.
    */

    const orderedQuantity = Number(item.orderedQuantity) || 0;

    const totalVerified = getVerifiedQuantity(item);

    if (totalVerified > orderedQuantity) {
      const excess = totalVerified - orderedQuantity;

      if (item.manualVerifiedQuantity >= excess) {
        item.manualVerifiedQuantity -= excess;
      } else {
        const remainingExcess = excess - item.manualVerifiedQuantity;

        item.manualVerifiedQuantity = 0;

        item.barcodeVerifiedQuantity = Math.max(
          item.barcodeVerifiedQuantity - remainingExcess,
          0,
        );
      }
    }
  });

  return order;
}

/* ==========================================
   Save Verification State To Neon
========================================== */

async function saveServerVerification(order) {
  if (!order || !order.id) {
    throw new Error("Cannot save verification without an order ID.");
  }

  const verificationData = {
    items: order.items.map((item) => ({
      id: item.id,

      barcodeVerifiedQuantity: Number(item.barcodeVerifiedQuantity) || 0,

      manualVerifiedQuantity: Number(item.manualVerifiedQuantity) || 0,
    })),
  };

  console.log("==========================================");
  console.log("SAVE VERIFICATION");
  console.log("Order ID:", order.id);
  console.log("Order Number:", order.orderNumber);
  console.log("Verification Data:", verificationData);
  console.log("==========================================");

  const response = await fetch(VERIFICATION_API_BASE, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },

    body: JSON.stringify({
      orderId: order.id,
      orderNumber: order.orderNumber,
      verificationData,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Verification API returned ${response.status}: ${responseText}`,
    );
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Save API returned invalid JSON: ${responseText}`);
  }

  console.log("SAVE VERIFICATION RESPONSE:", result);

  if (!result.success) {
    throw new Error(result.error || "Failed to save verification state.");
  }

  console.log(`Verification state saved to Neon for ${order.orderNumber}.`);

  return result.verification;
}

/* ==========================================
   Delete Verification State
========================================== */

async function deleteServerVerification(orderId) {
  if (!orderId) {
    throw new Error("Order ID is required.");
  }

  /*
    IMPORTANT:

    Use query parameter.

    Correct:
      /api/verification?orderId=...

    NOT:
      /api/verification/...
  */

  const url = `${VERIFICATION_API_BASE}?orderId=${encodeURIComponent(orderId)}`;

  console.log("==========================================");
  console.log("DELETE VERIFICATION");
  console.log("Order ID:", orderId);
  console.log("URL:", url);
  console.log("==========================================");

  const response = await fetch(url, {
    method: "DELETE",

    headers: {
      Accept: "application/json",
    },

    cache: "no-store",
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Verification API returned ${response.status}: ${responseText}`,
    );
  }

  let result;

  try {
    result = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Delete API returned invalid JSON: ${responseText}`);
  }

  if (!result.success) {
    throw new Error(result.error || "Failed to delete verification state.");
  }

  console.log(`Verification state deleted for ${orderId}.`);

  return result;
}

/* ==========================================
   Convert Shopify Order
========================================== */

function convertShopifyOrder(shopifyOrder) {
  return {
    id: shopifyOrder.id,

    orderNumber: shopifyOrder.name,

    verificationStatus: "needs-verification",

    items: (shopifyOrder.lineItems?.edges || []).map((itemEdge) => {
      const lineItem = itemEdge.node;

      return {
        id: lineItem.id,

        name: lineItem.name,

        barcode: lineItem.variant ? lineItem.variant.barcode : null,

        orderedQuantity: Number(lineItem.quantity) || 0,

        barcodeVerifiedQuantity: 0,

        manualVerifiedQuantity: 0,
      };
    }),
  };
}

/* ==========================================
   Load Verification State For Orders
========================================== */

async function loadVerificationStates(shopifyOrders) {
  const ordersWithVerification = await Promise.all(
    shopifyOrders.map(async (order) => {
      try {
        const verification = await getServerVerification(order.id);

        console.log("------------------------------------------");

        console.log("ORDER:", order.orderNumber);

        console.log("SHOPIFY ORDER ID:", order.id);

        console.log("NEON VERIFICATION:", verification);

        /*
            Apply database state.
          */

        applyServerVerification(order, verification);

        /*
            Calculate status from
            actual quantities.
          */

        const complete = isOrderComplete(order);

        order.verificationStatus = complete
          ? "ready-to-fulfill"
          : "needs-verification";

        console.log("CALCULATED STATUS:", order.verificationStatus);

        console.log(
          "ITEMS:",
          order.items.map((item) => ({
            id: item.id,
            name: item.name,
            ordered: item.orderedQuantity,
            barcodeVerified: item.barcodeVerifiedQuantity,
            manualVerified: item.manualVerifiedQuantity,
            totalVerified: getVerifiedQuantity(item),
          })),
        );

        console.log("------------------------------------------");

        return order;
      } catch (error) {
        console.error(
          `Could not load verification for ${order.orderNumber}:`,
          error,
        );

        /*
            If Neon cannot be read,
            NEVER assume verified.
          */

        order.items.forEach((item) => {
          item.barcodeVerifiedQuantity = 0;
          item.manualVerifiedQuantity = 0;
        });

        order.verificationStatus = "needs-verification";

        return order;
      }
    }),
  );

  return ordersWithVerification;
}

/* ==========================================
   Load Orders From Shopify
========================================== */

async function loadOrders() {
  ordersList.innerHTML = `
    <div class="order-card">
      <div class="order-info">
        <h3>Loading orders...</h3>

        <p>
          Loading Shopify orders and
          verification progress from Neon.
        </p>
      </div>
    </div>
  `;

  ordersCount.textContent = "Loading...";

  try {
    /*
      Get current Shopify orders.
    */

    const response = await fetch("/api/orders", {
      method: "GET",

      headers: {
        Accept: "application/json",
      },

      cache: "no-store",
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Orders API returned ${response.status}: ${responseText}`,
      );
    }

    let result;

    try {
      result = JSON.parse(responseText);
    } catch (error) {
      throw new Error(`Orders API returned invalid JSON: ${responseText}`);
    }

    console.log("SHOPIFY ORDERS RESPONSE:", result);

    if (!result.success) {
      throw new Error(result.error || "Failed to load orders.");
    }

    const shopifyOrders = Array.isArray(result.orders) ? result.orders : [];

    console.log("Shopify orders count:", shopifyOrders.length);

    /*
      Convert Shopify data.
    */

    const convertedOrders = shopifyOrders.map(convertShopifyOrder);

    /*
      Load Neon state for EVERY order.
    */

    const ordersWithVerification =
      await loadVerificationStates(convertedOrders);

    /*
      Replace in-memory state completely.

      Nothing is read from localStorage.
    */

    orders = ordersWithVerification;

    /*
      Calculate counts.
    */

    const needsVerificationCount = orders.filter(
      (order) => order.verificationStatus === "needs-verification",
    ).length;

    const readyCount = orders.filter(
      (order) => order.verificationStatus === "ready-to-fulfill",
    ).length;

    console.log("==========================================");

    console.log("FINAL APPLICATION STATE");

    console.log("Total orders:", orders.length);

    console.log("Needs Verification:", needsVerificationCount);

    console.log("Ready To Fulfill:", readyCount);

    console.log("==========================================");

    renderOrders();
  } catch (error) {
    console.error("LOAD ORDERS ERROR:", error);

    orders = [];

    ordersList.innerHTML = `
      <div class="order-card">
        <div class="order-info">
          <h3>Could not load orders</h3>

          <p>
            ${escapeHtml(error.message)}
          </p>
        </div>
      </div>
    `;

    ordersCount.textContent = "Error";
  }
}

/* ==========================================
   Get Orders For Current Tab
========================================== */

function getCurrentTabOrders() {
  let filteredOrders = orders.filter((order) => {
    if (currentTab === "needs-verification") {
      return order.verificationStatus === "needs-verification";
    }

    if (currentTab === "ready-to-fulfill") {
      return order.verificationStatus === "ready-to-fulfill";
    }

    return false;
  });

  const normalizedSearch = searchTerm.trim().toLowerCase();

  if (normalizedSearch) {
    filteredOrders = filteredOrders.filter((order) =>
      String(order.orderNumber).toLowerCase().includes(normalizedSearch),
    );
  }

  return filteredOrders;
}

/* ==========================================
   Render Orders
========================================== */

function renderOrders() {
  ordersList.innerHTML = "";

  const visibleOrders = getCurrentTabOrders();

  ordersCount.textContent = `${visibleOrders.length} orders`;

  if (visibleOrders.length === 0) {
    let title = "No orders";

    let description = "There are no orders in this section.";

    if (currentTab === "needs-verification") {
      title = "No orders need verification";

      description = "All current unfulfilled orders have been verified.";
    }

    if (currentTab === "ready-to-fulfill") {
      title = "No orders ready to fulfill";

      description = "There are no verified orders waiting for fulfillment.";
    }

    if (searchTerm.trim()) {
      title = "No matching orders";

      description = "No orders match your search.";
    }

    ordersList.innerHTML = `
      <div class="order-card">
        <div class="order-info">

          <h3>
            ${escapeHtml(title)}
          </h3>

          <p>
            ${escapeHtml(description)}
          </p>

        </div>
      </div>
    `;

    return;
  }

  visibleOrders.forEach((order) => {
    const totalProducts = order.items.length;

    const verifiedProducts = order.items.filter(isItemComplete).length;

    const complete = isOrderComplete(order);

    const card = document.createElement("div");

    card.className = "order-card";

    card.innerHTML = `
      <div class="order-info">

        <h3>
          ${escapeHtml(order.orderNumber)}
        </h3>

        <p>
          ${totalProducts} products
          ·
          ${verifiedProducts}/${totalProducts} complete
        </p>

      </div>

      <button
        class="verify-order-button"
        data-order-id="${escapeHtml(order.id)}"
      >
        ${complete ? "Ready to Fulfill" : "Verify"}
      </button>
    `;

    const button = card.querySelector(".verify-order-button");

    button.addEventListener("click", () => {
      openOrder(order.id);
    });

    ordersList.appendChild(card);
  });
}

/* ==========================================
   Tab Switching
========================================== */

function switchTab(tab) {
  if (tab !== "needs-verification" && tab !== "ready-to-fulfill") {
    return;
  }

  currentTab = tab;

  needsVerificationTab.classList.toggle(
    "active",
    currentTab === "needs-verification",
  );

  readyToFulfillTab.classList.toggle(
    "active",
    currentTab === "ready-to-fulfill",
  );

  renderOrders();
}

/* ==========================================
   Open Order
========================================== */

async function openOrder(orderId) {
  const selectedOrder = orders.find((order) => order.id === orderId);

  if (!selectedOrder) {
    return;
  }

  currentOrder = selectedOrder;

  ordersScreen.classList.add("hidden");

  verificationScreen.classList.remove("hidden");

  verificationOrderNumber.textContent = currentOrder.orderNumber;

  scanMessage.textContent = "Loading verification progress...";

  try {
    /*
      Always retrieve the latest
      state from Neon.
    */

    const verification = await getServerVerification(currentOrder.id);

    applyServerVerification(currentOrder, verification);

    currentOrder.verificationStatus = isOrderComplete(currentOrder)
      ? "ready-to-fulfill"
      : "needs-verification";

    renderProducts();

    renderManualProducts();

    updateOrderStatus();

    if (isOrderComplete(currentOrder)) {
      readyMessage.classList.remove("hidden");

      scanMessage.textContent = "Order verification complete.";
    } else {
      readyMessage.classList.add("hidden");

      scanMessage.textContent = "Ready to scan.";
    }

    renderOrders();

    barcodeInput.focus();
  } catch (error) {
    console.error("OPEN ORDER ERROR:", error);

    scanMessage.textContent = "Could not load verification progress.";

    renderProducts();

    renderManualProducts();

    updateOrderStatus();
  }
}

/* ==========================================
   Render Products
========================================== */

function renderProducts() {
  productsList.innerHTML = "";

  if (!currentOrder) {
    return;
  }

  currentOrder.items.forEach((item) => {
    const verified = getVerifiedQuantity(item);

    const row = document.createElement("div");

    row.className = "product-row";

    row.innerHTML = `
        <div>

          <div class="product-name">
            ${escapeHtml(item.name)}
          </div>

          <div class="product-barcode">
            ${
              item.barcode
                ? `Barcode: ${escapeHtml(item.barcode)}`
                : "No barcode"
            }
          </div>

        </div>

        <div class="product-quantity">
          ${verified}/${item.orderedQuantity}
        </div>
      `;

    productsList.appendChild(row);
  });
}

/* ==========================================
   Manual Products
========================================== */

function renderManualProducts() {
  manualProduct.innerHTML = `
    <option value="">
      Select product
    </option>
  `;

  if (!currentOrder) {
    return;
  }

  currentOrder.items
    .filter((item) => getRemainingQuantity(item) > 0)
    .forEach((item) => {
      const option = document.createElement("option");

      option.value = item.id;

      const remaining = getRemainingQuantity(item);

      option.textContent = `${item.name} (${remaining} remaining)`;

      manualProduct.appendChild(option);
    });
}

/* ==========================================
   Barcode Verification
========================================== */

function scanBarcode(order, barcode) {
  if (!order) {
    return {
      success: false,

      error: {
        code: "NO_ORDER",

        message: "No order is currently selected.",
      },
    };
  }

  if (isOrderComplete(order)) {
    return {
      success: false,

      error: {
        code: "ORDER_ALREADY_COMPLETE",

        message: "This order has already been completely verified.",
      },
    };
  }

  const normalizedBarcode = String(barcode).trim();

  const matchingItems = order.items.filter(
    (item) => String(item.barcode || "").trim() === normalizedBarcode,
  );

  if (matchingItems.length === 0) {
    return {
      success: false,

      error: {
        code: "WRONG_PRODUCT",

        message: "This barcode does not belong to any item in the order.",
      },
    };
  }

  if (matchingItems.length > 1) {
    return {
      success: false,

      error: {
        code: "AMBIGUOUS_BARCODE",

        message: "This barcode matches more than one item in the order.",
      },
    };
  }

  const item = matchingItems[0];

  if (!item) {
    return {
      success: false,

      error: {
        code: "ITEM_NOT_FOUND",

        message: "The scanned product was not found.",
      },
    };
  }

  if (getRemainingQuantity(item) <= 0) {
    return {
      success: false,

      error: {
        code: "QUANTITY_EXCEEDED",

        message:
          "The ordered quantity for this item has already been verified.",
      },
    };
  }

  item.barcodeVerifiedQuantity =
    (Number(item.barcodeVerifiedQuantity) || 0) + 1;

  return {
    success: true,
  };
}

/* ==========================================
   Handle Scan
========================================== */

async function handleScan() {
  if (!currentOrder) {
    scanMessage.textContent = "No order is currently selected.";

    return;
  }

  const barcode = barcodeInput.value.trim();

  if (!barcode) {
    scanMessage.textContent = "Please scan or enter a barcode.";

    return;
  }

  const result = scanBarcode(currentOrder, barcode);

  if (!result.success) {
    scanMessage.textContent = `✗ ${result.error.message}`;

    barcodeInput.select();

    return;
  }

  scanMessage.textContent = "Saving verification...";

  try {
    /*
      Database save happens first.
    */

    await saveServerVerification(currentOrder);

    barcodeInput.value = "";

    renderProducts();

    renderManualProducts();

    updateOrderStatus();

    scanMessage.textContent = "✓ Product verified and saved.";

    await checkOrderCompletion();

    renderOrders();

    barcodeInput.focus();
  } catch (error) {
    console.error("SCAN SAVE ERROR:", error);

    /*
      Neon is the source of truth.

      Reload state from Neon.
    */

    try {
      const verification = await getServerVerification(currentOrder.id);

      applyServerVerification(currentOrder, verification);

      currentOrder.verificationStatus = isOrderComplete(currentOrder)
        ? "ready-to-fulfill"
        : "needs-verification";

      renderProducts();

      renderManualProducts();

      updateOrderStatus();

      renderOrders();

      scanMessage.textContent =
        "✗ Could not save verification. The order was restored from the server.";
    } catch (reloadError) {
      console.error("SCAN ROLLBACK ERROR:", reloadError);

      scanMessage.textContent =
        "✗ Could not save verification or reload the server state.";
    }

    barcodeInput.select();
  }
}

/* ==========================================
   Manual Verification
========================================== */

function manualVerify(order, itemId, quantity) {
  if (!order) {
    return {
      success: false,

      error: {
        code: "NO_ORDER",

        message: "No order is currently selected.",
      },
    };
  }

  if (isOrderComplete(order)) {
    return {
      success: false,

      error: {
        code: "ORDER_ALREADY_COMPLETE",

        message: "This order has already been completely verified.",
      },
    };
  }

  const item = order.items.find((item) => item.id === itemId);

  if (!item) {
    return {
      success: false,

      error: {
        code: "ITEM_NOT_FOUND",

        message: "The selected item was not found.",
      },
    };
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      success: false,

      error: {
        code: "INVALID_MANUAL_QUANTITY",

        message: "Manual quantity must be a positive whole number.",
      },
    };
  }

  const remaining = getRemainingQuantity(item);

  if (quantity > remaining) {
    return {
      success: false,

      error: {
        code: "INVALID_MANUAL_QUANTITY",

        message: "The manual quantity is greater than the remaining quantity.",
      },
    };
  }

  item.manualVerifiedQuantity =
    (Number(item.manualVerifiedQuantity) || 0) + quantity;

  return {
    success: true,
  };
}

/* ==========================================
   Handle Manual Verification
========================================== */

async function handleManualVerification() {
  if (!currentOrder) {
    manualMessage.textContent = "No order is currently selected.";

    return;
  }

  const itemId = manualProduct.value;

  const quantity = Number(manualQuantity.value);

  if (!itemId) {
    manualMessage.textContent = "Please select a product.";

    return;
  }

  const result = manualVerify(currentOrder, itemId, quantity);

  if (!result.success) {
    manualMessage.textContent = `✗ ${result.error.message}`;

    return;
  }

  manualMessage.textContent = "Saving verification...";

  try {
    await saveServerVerification(currentOrder);

    manualMessage.textContent = "✓ Product verified and saved.";

    manualQuantity.value = "";

    manualProduct.value = "";

    renderProducts();

    renderManualProducts();

    updateOrderStatus();

    await checkOrderCompletion();

    renderOrders();
  } catch (error) {
    console.error("MANUAL SAVE ERROR:", error);

    try {
      const verification = await getServerVerification(currentOrder.id);

      applyServerVerification(currentOrder, verification);

      currentOrder.verificationStatus = isOrderComplete(currentOrder)
        ? "ready-to-fulfill"
        : "needs-verification";

      renderProducts();

      renderManualProducts();

      updateOrderStatus();

      renderOrders();

      manualMessage.textContent =
        "✗ Could not save verification. The order was restored from the server.";
    } catch (reloadError) {
      console.error("MANUAL ROLLBACK ERROR:", reloadError);

      manualMessage.textContent =
        "✗ Could not save verification or reload the server state.";
    }
  }
}

/* ==========================================
   Order Status
========================================== */

function updateOrderStatus() {
  if (!currentOrder) {
    return;
  }

  if (isOrderComplete(currentOrder)) {
    orderStatus.textContent = "Ready to Fulfill";

    orderStatus.style.background = "#ecfdf5";

    orderStatus.style.color = "#047857";
  } else {
    orderStatus.textContent = "Not Complete";

    orderStatus.style.background = "#fef3c7";

    orderStatus.style.color = "#92400e";
  }
}

/* ==========================================
   Check Completion
========================================== */

async function checkOrderCompletion() {
  if (!currentOrder) {
    return false;
  }

  /*
    Not complete.
  */

  if (!isOrderComplete(currentOrder)) {
    currentOrder.verificationStatus = "needs-verification";

    readyMessage.classList.add("hidden");

    return false;
  }

  /*
    Complete.
  */

  currentOrder.verificationStatus = "ready-to-fulfill";

  /*
    Persist the complete state.

    NOTE:
    saveServerVerification() already
    persists all item quantities.
  */

  try {
    await saveServerVerification(currentOrder);
  } catch (error) {
    console.error("FINAL VERIFICATION SAVE ERROR:", error);

    currentOrder.verificationStatus = "needs-verification";

    readyMessage.classList.add("hidden");

    scanMessage.textContent =
      "✗ Order is complete, but the final state could not be saved.";

    return false;
  }

  readyMessage.classList.remove("hidden");

  scanMessage.textContent = "Order verification complete.";

  renderOrders();

  return true;
}

/* ==========================================
   Back To Orders
========================================== */

function goBackToOrders() {
  currentOrder = null;

  verificationScreen.classList.add("hidden");

  ordersScreen.classList.remove("hidden");

  readyMessage.classList.add("hidden");

  scanMessage.textContent = "Ready to scan.";

  manualMessage.textContent = "Ready.";

  barcodeInput.value = "";

  manualQuantity.value = "";

  manualProduct.value = "";

  renderOrders();
}

/* ==========================================
   Refresh Orders
========================================== */

async function refreshOrders() {
  /*
    Completely reload Shopify + Neon.
  */

  await loadOrders();
}

/* ==========================================
   Search
========================================== */

function handleOrderSearch(event) {
  searchTerm = event.target.value || "";

  renderOrders();
}

/* ==========================================
   HTML Escape Helper
========================================== */

function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ==========================================
   Event Listeners
========================================== */

if (scanButton) {
  scanButton.addEventListener("click", handleScan);
}

if (barcodeInput) {
  barcodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();

      handleScan();
    }
  });
}

if (manualButton) {
  manualButton.addEventListener("click", handleManualVerification);
}

if (backButton) {
  backButton.addEventListener("click", goBackToOrders);
}

/* ==========================================
   Tabs
========================================== */

if (needsVerificationTab) {
  needsVerificationTab.addEventListener("click", () => {
    switchTab("needs-verification");
  });
}

if (readyToFulfillTab) {
  readyToFulfillTab.addEventListener("click", () => {
    switchTab("ready-to-fulfill");
  });
}

/* ==========================================
   Search
========================================== */

if (orderSearch) {
  orderSearch.addEventListener("input", handleOrderSearch);
}

/* ==========================================
   Start Application
========================================== */

/*
  Always start on Needs Verification.
*/

switchTab("needs-verification");

/*
  Load fresh data.

  Shopify -> current orders
  Neon    -> verification state

  No localStorage.
*/

loadOrders();
