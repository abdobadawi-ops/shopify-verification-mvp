/* ==========================================
   Application State
========================================== */

let orders = [];

let currentOrder = null;

let currentTab = "needs-verification";

let searchTerm = "";

const READY_ORDERS_STORAGE_KEY = "readyToFulfillOrders";

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
    (item.barcodeVerifiedQuantity || 0) + (item.manualVerifiedQuantity || 0)
  );
}

function getRemainingQuantity(item) {
  return Math.max(item.orderedQuantity - getVerifiedQuantity(item), 0);
}

function isItemComplete(item) {
  return getVerifiedQuantity(item) >= item.orderedQuantity;
}

function isOrderComplete(order) {
  if (!order || !order.items || !order.items.length) {
    return false;
  }

  return order.items.every(isItemComplete);
}

/* ==========================================
   Local Storage
========================================== */

function getSavedReadyOrders() {
  try {
    const saved = localStorage.getItem(READY_ORDERS_STORAGE_KEY);

    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed;
  } catch (error) {
    console.error("LOCAL STORAGE READ ERROR:", error);

    return [];
  }
}

function saveReadyOrders(readyOrders) {
  try {
    localStorage.setItem(READY_ORDERS_STORAGE_KEY, JSON.stringify(readyOrders));

    console.log(`Saved ${readyOrders.length} ready orders to localStorage.`);
  } catch (error) {
    console.error("LOCAL STORAGE SAVE ERROR:", error);
  }
}

function addReadyOrder(order) {
  if (!order || !order.id) {
    return;
  }

  const readyOrders = getSavedReadyOrders();

  const existingIndex = readyOrders.findIndex(
    (savedOrder) => savedOrder.id === order.id,
  );

  if (existingIndex !== -1) {
    readyOrders[existingIndex] = order;
  } else {
    readyOrders.push(order);
  }

  saveReadyOrders(readyOrders);
}

function removeReadyOrder(orderId) {
  const readyOrders = getSavedReadyOrders();

  const updatedOrders = readyOrders.filter((order) => order.id !== orderId);

  saveReadyOrders(updatedOrders);
}

/* ==========================================
   Convert Shopify Order
========================================== */

function convertShopifyOrder(shopifyOrder) {
  return {
    id: shopifyOrder.id,

    orderNumber: shopifyOrder.name,

    items: (shopifyOrder.lineItems?.edges || []).map((itemEdge) => {
      const lineItem = itemEdge.node;

      return {
        id: lineItem.id,

        name: lineItem.name,

        barcode: lineItem.variant ? lineItem.variant.barcode : null,

        orderedQuantity: lineItem.quantity,

        barcodeVerifiedQuantity: 0,

        manualVerifiedQuantity: 0,
      };
    }),
  };
}

/* ==========================================
   Refresh Ready Orders From Shopify
========================================== */

/*
  Important logic:

  Shopify is the source of truth for whether
  the order is still unfulfilled.

  localStorage is only responsible for remembering
  our local verification progress.

  If a locally saved Ready order is still returned
  by Shopify -> keep it.

  If Shopify no longer returns it -> remove it
  from localStorage.
*/

function mergeShopifyOrdersWithLocalReady(shopifyOrders) {
  const savedReadyOrders = getSavedReadyOrders();

  const shopifyOrdersMap = new Map();

  shopifyOrders.forEach((order) => {
    shopifyOrdersMap.set(order.id, order);
  });

  const validReadyOrders = [];

  /*
    Check every locally saved Ready order.
  */

  savedReadyOrders.forEach((savedOrder) => {
    const freshShopifyOrder = shopifyOrdersMap.get(savedOrder.id);

    /*
      Shopify no longer considers this order
      a valid unfulfilled order.

      This usually means it was fulfilled,
      cancelled, refunded, returned, etc.

      Therefore remove it from localStorage.
    */

    if (!freshShopifyOrder) {
      console.log(
        `Removing ${savedOrder.orderNumber} from localStorage because it is no longer a valid unfulfilled Shopify order.`,
      );

      return;
    }

    /*
      The order still exists and is still unfulfilled.

      Keep the LOCAL verification quantities.
    */

    validReadyOrders.push({
      ...savedOrder,

      orderNumber: freshShopifyOrder.orderNumber,
    });
  });

  /*
    Save cleaned Ready orders.
  */

  saveReadyOrders(validReadyOrders);

  /*
    Create a Set of locally Ready orders.
  */

  const readyIds = new Set(validReadyOrders.map((order) => order.id));

  /*
    Shopify orders that are NOT already Ready
    belong in Needs Verification.

    This prevents Ready orders from appearing
    in Needs Verification.
  */

  const needsVerificationOrders = shopifyOrders
    .filter((order) => !readyIds.has(order.id))
    .map((order) => {
      return order;
    });

  /*
    Return both groups.
  */

  return {
    needsVerificationOrders,

    readyOrders: validReadyOrders,
  };
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
          Getting orders from Shopify.
        </p>
      </div>
    </div>
  `;

  ordersCount.textContent = "Loading...";

  try {
    /*
      Read local Ready orders BEFORE Shopify request.

      This is important because localStorage contains
      our verification progress.
    */

    const localReadyOrders = getSavedReadyOrders();

    console.log(
      `Found ${localReadyOrders.length} saved Ready orders in localStorage.`,
    );

    /*
      Request fresh Shopify data.
    */

    const response = await fetch("/api/orders");

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const result = await response.json();

    console.log("Filtered Shopify orders:", result);

    if (!result.success) {
      throw new Error(result.error || "Failed to load orders.");
    }

    const shopifyOrders = result.orders || [];

    /*
      Convert Shopify orders.
    */

    const convertedShopifyOrders = shopifyOrders.map(convertShopifyOrder);

    /*
      Merge Shopify data with local verification state.
    */

    const merged = mergeShopifyOrdersWithLocalReady(convertedShopifyOrders);

    /*
      Store the two groups together.

      Every order has a local status.
    */

    orders = [
      ...merged.needsVerificationOrders.map((order) => ({
        ...order,

        verificationStatus: "needs-verification",
      })),

      ...merged.readyOrders.map((order) => ({
        ...order,

        verificationStatus: "ready-to-fulfill",
      })),
    ];

    console.log(`Needs Verification: ${merged.needsVerificationOrders.length}`);

    console.log(`Ready to Fulfill: ${merged.readyOrders.length}`);

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

  /*
    Search by order number.

    Example:
    #1054
    1054
  */

  const normalizedSearch = searchTerm.trim().toLowerCase();

  if (normalizedSearch) {
    filteredOrders = filteredOrders.filter((order) => {
      return order.orderNumber.toLowerCase().includes(normalizedSearch);
    });
  }

  return filteredOrders;
}

/* ==========================================
   Render Orders
========================================== */

function renderOrders() {
  ordersList.innerHTML = "";

  const visibleOrders = getCurrentTabOrders();

  /*
    Count only the orders in the active tab.
  */

  ordersCount.textContent = `${visibleOrders.length} orders`;

  /*
    Empty state.
  */

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

  /*
    Render visible orders.
  */

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

  /*
    Update active tab UI.
  */

  needsVerificationTab.classList.toggle(
    "active",
    currentTab === "needs-verification",
  );

  readyToFulfillTab.classList.toggle(
    "active",
    currentTab === "ready-to-fulfill",
  );

  /*
    Render only orders belonging
    to the selected tab.
  */

  renderOrders();
}

/* ==========================================
   Open Order
========================================== */

function openOrder(orderId) {
  currentOrder = orders.find((order) => order.id === orderId);

  if (!currentOrder) {
    return;
  }

  ordersScreen.classList.add("hidden");

  verificationScreen.classList.remove("hidden");

  verificationOrderNumber.textContent = currentOrder.orderNumber;

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

  barcodeInput.focus();
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

    const remaining = getRemainingQuantity(item);

    const row = document.createElement("div");

    row.className = "product-row";

    row.innerHTML = `
      <div>

        <div class="product-name">
          ${escapeHtml(item.name)}
        </div>

        <div class="product-barcode">
          ${
            item.barcode ? `Barcode: ${escapeHtml(item.barcode)}` : "No barcode"
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

  /*
    IMPORTANT:

    Show ALL products that still have
    remaining quantity.

    Previously this was:

      .filter((item) => !item.barcode ...)

    That meant products with barcodes were
    completely excluded from the manual selector.

    Now any incomplete product can be manually
    verified.
  */

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

  const matchingItems = order.items.filter((item) => item.barcode === barcode);

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

  item.barcodeVerifiedQuantity += 1;

  return {
    success: true,
  };
}

/* ==========================================
   Handle Scan
========================================== */

function handleScan() {
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

  if (result.success) {
    scanMessage.textContent = "✓ Product verified successfully.";

    barcodeInput.value = "";

    renderProducts();

    renderManualProducts();

    updateOrderStatus();

    checkOrderCompletion();

    renderOrders();

    barcodeInput.focus();
  } else {
    scanMessage.textContent = `✗ ${result.error.message}`;

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

  item.manualVerifiedQuantity += quantity;

  return {
    success: true,
  };
}

/* ==========================================
   Handle Manual Verification
========================================== */

function handleManualVerification() {
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

  if (result.success) {
    manualMessage.textContent = "✓ Product verified successfully.";

    manualQuantity.value = "";

    manualProduct.value = "";

    renderProducts();

    renderManualProducts();

    updateOrderStatus();

    checkOrderCompletion();

    renderOrders();
  } else {
    manualMessage.textContent = `✗ ${result.error.message}`;
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

function checkOrderCompletion() {
  if (!currentOrder) {
    return;
  }

  /*
    Not complete yet.
  */

  if (!isOrderComplete(currentOrder)) {
    readyMessage.classList.add("hidden");

    return;
  }

  /*
    Order is now completely verified.

    Change its state to Ready.
  */

  currentOrder.verificationStatus = "ready-to-fulfill";

  /*
    Save it immediately.

    This is the important part that makes
    Ready survive refresh/browser close.
  */

  addReadyOrder(currentOrder);

  /*
    Remove it from Needs Verification
    immediately.
  */

  readyMessage.classList.remove("hidden");

  scanMessage.textContent = "Order verification complete.";

  /*
    Render the active tab.

    If we are currently on Needs Verification,
    the order disappears immediately.

    If we are on Ready to Fulfill,
    it appears there.
  */

  renderOrders();
}

/* ==========================================
   Back to Orders
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
   Refresh Shopify Orders
========================================== */

async function refreshOrders() {
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

scanButton.addEventListener("click", handleScan);

barcodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();

    handleScan();
  }
});

manualButton.addEventListener("click", handleManualVerification);

backButton.addEventListener("click", goBackToOrders);

/*
  Tabs
*/

needsVerificationTab.addEventListener("click", () => {
  switchTab("needs-verification");
});

readyToFulfillTab.addEventListener("click", () => {
  switchTab("ready-to-fulfill");
});

/*
  Search
*/

orderSearch.addEventListener("input", handleOrderSearch);

/* ==========================================
   Start Application
========================================== */

/*
  Always start on Needs Verification.
*/

switchTab("needs-verification");

/*
  Load fresh Shopify data and merge it
  with local Ready orders.
*/

loadOrders();
